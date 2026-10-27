// The cold archive read cache keeps an ordered key table plus a bounded row
// window, and reads every other row back from the line it was parsed from.
//
// These tests pin the three things that representation has to be true about:
// a row outside the window is still returned exactly as a scan would return it,
// the window is bounded by both caps, and a parse an append extended is handed
// to the next instance (which is what makes the table survive a transaction)
// without giving up the content proof behind that handoff.
//
// The differentials compare against the released rc.16 package, imported as-is,
// because that is the implementation the optimisation is allowed to be
// unobservable to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as candidate from '../lib/dockyard-domain/index.js';
import { collectKnowledgeExperience } from '../lib/experience-recall.js';
import { mirrorArchives, privatizeArchiveFile } from '../lib/archive-stage.js';
import { JsonStateStore } from './dockyard-domain/support.js';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const ARTIFACT = 'dsh-evolution-0.2.0-rc.16.tgz';
const ARTIFACT_SHA256 = '1d4a40a73a5f3f7331ca66ebcc8dcf7a82f6e50b00238b7618b4c04dd80c0ad6';
const NOW = '2026-10-12T00:00:00.000Z';
const artifact = path.join(REPO, 'release', ARTIFACT);
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex'), ARTIFACT_SHA256,
  'the rc.16 differential anchor must retain its released bytes');
const baselineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'row-window-rc16-'));
test.after(() => fs.rmSync(baselineRoot, { recursive: true, force: true }));
execFileSync('tar', ['-xzf', artifact, '-C', baselineRoot, 'package/lib'], { stdio: 'pipe' });
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(baselineRoot, 'package', 'node_modules'), 'dir');
const baseline = await import(pathToFileURL(path.join(baselineRoot, 'package/lib/dockyard-domain/index.js')).href);

const authority = { assertMutation() {} };
const json = (value) => JSON.stringify(value);
const archive = (root, collection) => path.join(root, `state.json.${collection}-archive.jsonl`);

function memory(impl, root, options = {}) {
  return new impl.EvolutionMemory({
    stateStore: new JsonStateStore({ filePath: path.join(root, 'state.json') }),
    mutationAuthority: authority, clock: () => new Date(NOW), hotEntries: 8, hotCycles: 1,
    archiveMaxBytes: 1024 * 1024, ...options,
  });
}

async function withHome(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'row-window-'));
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(root, 'state.json'), json({ evolution: { schema: 4 } }));
    return await run(root);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

/** One outcome row with a payload large enough to fill the byte cap. */
function fatRow(id, payloadBytes, extra = {}) {
  return { id, status: 'failed', lifecycleState: 'FAILED', signature: `sig-${id}`,
    rootCause: 'synthetic-root', summary: 'p'.repeat(payloadBytes), recordedAt: NOW, ...extra };
}

test('rows outside the retained window are read back exactly as a scan returns them', async () => {
  await withHome(async (root) => {
    const rows = [fatRow('a', 1_500_000), fatRow('b', 1_500_000), fatRow('c', 1_500_000), fatRow('d', 1_500_000)];
    fs.writeFileSync(archive(root, 'outcomes'), rows.map(json).join('\n') + '\n');
    const current = memory(candidate, root);
    await current.load({ snapshot: false });
    const actual = current.history('outcomes').map((row) => row.id);
    assert.deepEqual(actual, ['a', 'b', 'c', 'd']);
    // The byte cap cannot hold four 1.5 MiB rows, so the oldest ones are not
    // retained as objects and have to come from their own lines.
    const cached = current.archiveReadCache.get('outcomes');
    assert.ok(cached.windowFrom > 0, `the window must drop rows by bytes, saw windowFrom=${cached.windowFrom}`);
    assert.equal(cached.window.length, 4 - cached.windowFrom);
    assert.equal(cached.keys.length, 4);
    const baselineMemory = memory(baseline, root);
    await baselineMemory.load({ snapshot: false });
    assert.deepEqual(current.historyView('outcomes'), baselineMemory.historyView('outcomes'),
      'the complete view is identical to the released implementation');
    assert.deepEqual(current.historyWindow('outcomes', 3), baselineMemory.historyWindow('outcomes', 3));
    assert.deepEqual(current.historyWindow('outcomes', 50, { metadataOnly: true }),
      baselineMemory.historyWindow('outcomes', 50, { metadataOnly: true }));
    assert.deepEqual(json(current.fullSnapshot()), json(baselineMemory.fullSnapshot()));
    // A caller mutating a detached row cannot reach the retained window.
    const detached = current.history('outcomes');
    detached[3].status = 'mutated';
    assert.equal(current.history('outcomes')[3].status, 'failed');
  });
});

test('the retained window is bounded by rows as well as bytes', async () => {
  await withHome(async (root) => {
    const rows = Array.from({ length: 3000 }, (_, index) => ({ id: `row-${index}`, status: 'observed', recordedAt: NOW }));
    fs.writeFileSync(archive(root, 'cycles'), rows.map(json).join('\n') + '\n');
    const current = memory(candidate, root);
    await current.load({ snapshot: false });
    assert.equal(current.history('cycles').length, 3000, 'complete history is materialised on demand');
    const cached = current.archiveReadCache.get('cycles');
    assert.ok(cached.window.length <= 2048, `the row cap bounds the window, saw ${cached.window.length}`);
    assert.ok(cached.windowFrom >= 3000 - 2048);
    const bytes = cached.window.reduce((sum, row) => sum + (row === undefined ? 0 : json(row).length), 0);
    assert.ok(bytes <= 4 * 1024 * 1024, 'the byte cap bounds the window');
    assert.deepEqual(current.historyWindow('cycles', 50), (await (async () => {
      const reference = memory(baseline, root);
      await reference.load({ snapshot: false });
      return reference.historyWindow('cycles', 50);
    })()));
  });
});

test('an append extends the table and the next instance inherits it', async () => {
  await withHome(async (root) => {
    const rows = [fatRow('a', 1_500_000), fatRow('b', 1_500_000), fatRow('c', 1_500_000)];
    fs.writeFileSync(archive(root, 'outcomes'), rows.map(json).join('\n') + '\n');
    // A hot window of one makes each append archive the row before it, which is
    // the shape a long-running host reaches on its own.
    const first = memory(candidate, root, { hotEntries: 1, archiveMaxBytes: 64 * 1024 * 1024 });
    await first.load({ snapshot: false });
    first.history('outcomes');
    const before = first.archiveReadCache.get('outcomes');
    // Two appends cross the window boundary: the first value is trimmed out of
    // the window and the active file the table describes grows.
    await first.recordOutcome(fatRow('d', 1_500_000));
    await first.recordOutcome(fatRow('e', 1_500_000));
    await first.recordOutcome(fatRow('f', 1_500_000));
    const extended = first.archiveReadCache.get('outcomes');
    assert.equal(before.keys.length, 3);
    assert.equal(extended.keys.length, 5, 'the table records both appends');
    assert.ok(extended.windowFrom >= 2, `the byte cap still trims the window, saw windowFrom=${extended.windowFrom}`);
    assert.ok(extended.window.length <= 3);
    assert.equal(typeof extended.digests.get('state.json.outcomes-archive.jsonl'), 'string',
      'an appended parse still carries a content digest of the bytes it now covers');
    assert.equal(extended.liveDigest.name, 'state.json.outcomes-archive.jsonl');
    assert.equal(extended.faults.length, 0);
    // The successor must adopt this parse instead of scanning the file again:
    // its table is the same object graph the predecessor extended.
    const successor = memory(candidate, root, { hotEntries: 1, archiveMaxBytes: 64 * 1024 * 1024, archiveReadCache: first.archiveReadCache });
    await successor.load({ snapshot: false });
    const adopted = successor.history('outcomes');
    const cached = successor.archiveReadCache.get('outcomes');
    assert.equal(cached.keys, extended.keys, 'the extended table itself is inherited');
    assert.equal(cached.positions, extended.positions);
    assert.deepEqual(adopted.map((row) => row.id), ['a', 'b', 'c', 'd', 'e', 'f']);
    const reference = memory(baseline, root, { hotEntries: 1, archiveMaxBytes: 64 * 1024 * 1024 });
    await reference.load({ snapshot: false });
    assert.deepEqual(successor.history('outcomes'), reference.history('outcomes'));
    assert.deepEqual(successor.historyWindow('outcomes', 50), reference.historyWindow('outcomes', 50));
  });
});

test('an inherited parse is only trusted while its bytes still match', async () => {
  await withHome(async (root) => {
    const file = archive(root, 'outcomes');
    const rows = [fatRow('a', 1_500_000), fatRow('b', 1_500_000), fatRow('c', 1_500_000)];
    fs.writeFileSync(file, rows.map(json).join('\n') + '\n');
    const first = memory(candidate, root, { archiveMaxBytes: 64 * 1024 * 1024 });
    await first.load({ snapshot: false });
    first.history('outcomes');
    await first.recordOutcome(fatRow('d', 1_500_000));
    const extended = first.archiveReadCache.get('outcomes');
    // A same-length rewrite that restores the mtime reproduces the build-time
    // identity, and only the content digest can tell the successor that these
    // are different bytes.
    const bytes = fs.readFileSync(file, 'utf8');
    const pinned = fs.statSync(file).mtime;
    const rewritten = bytes.replace('"id":"d"', '"id":"z"').replace(/p{1,2}$/m, 'pp');
    assert.equal(rewritten.length, bytes.length);
    fs.writeFileSync(file, rewritten);
    fs.utimesSync(file, pinned, pinned);
    const successor = memory(candidate, root, { hotEntries: 1, archiveMaxBytes: 64 * 1024 * 1024, archiveReadCache: first.archiveReadCache });
    await successor.load({ snapshot: false });
    const adopted = successor.history('outcomes').map((row) => row.id);
    assert.equal(adopted.includes('z'), false, 'the rewritten bytes are not served as the old ones');
    assert.equal(successor.archiveReadCache.get('outcomes') === extended, false,
      'a mismatched digest forces a fresh parse');
  });
});

test('a row whose bytes no longer reproduce it is re-read, never guessed', async () => {
  await withHome(async (root) => {
    const file = archive(root, 'outcomes');
    fs.writeFileSync(file, [fatRow('a', 1_500_000), fatRow('b', 1_500_000), fatRow('c', 1_500_000)].map(json).join('\n') + '\n');
    const current = memory(candidate, root);
    await current.load({ snapshot: false });
    current.history('outcomes');
    const cached = current.archiveReadCache.get('outcomes');
    assert.ok(cached.windowFrom > 0);
    const pinned = fs.statSync(file).mtime;
    const size = fs.statSync(file).size;
    // Same length overall, different line boundaries: every recorded locator
    // after the first line now points into a different record.
    const shifted = json(fatRow('a', 1_500_010)) + '\n' + json(fatRow('b', 1_499_990)) + '\n' + json(fatRow('c', 1_500_000)) + '\n';
    assert.equal(Buffer.byteLength(shifted), size);
    fs.writeFileSync(file, shifted);
    fs.utimesSync(file, pinned, pinned);
    const rows = current.historyWindow('outcomes', 50);
    assert.equal(rows.count, 3);
    assert.deepEqual(rows.entries.map((row) => row.id), ['a', 'b', 'c']);
    assert.deepEqual(rows.entries.map((row) => row.summary.length), [1_500_010, 1_499_990, 1_500_000],
      'the table is rebuilt from the bytes that are actually on disk');
  });
});

test('a privatized archive keeps the table only while its prefix digest still proves it', async () => {
  await withHome(async (root) => {
    const live = path.join(root, 'live');
    const stage = path.join(root, 'stage');
    fs.mkdirSync(live);
    const liveArchive = archive(live, 'outcomes');
    fs.writeFileSync(liveArchive, [fatRow('a', 1_500_000), fatRow('b', 1_500_000)].map(json).join('\n') + '\n');
    const first = memory(candidate, live);
    await first.load({ snapshot: false });
    first.history('outcomes');
    const predecessor = first.archiveReadCache.get('outcomes');
    // The staged transaction writes through a hard-link mirror, and the first
    // archive write privatizes the file: the same bytes under a new inode, which
    // is exactly the identity change a size/inode comparison cannot distinguish
    // from a rewrite.
    const guards = [];
    const staged = () => {
      fs.rmSync(stage, { recursive: true, force: true });
      const snapshot = mirrorArchives(live, stage);
      const privatized = new Set();
      guards.push(0);
      const index = guards.length - 1;
      return memory(candidate, stage, {
        hotEntries: 1, archiveMaxBytes: 64 * 1024 * 1024,
        archiveWriteGuard: (file) => { guards[index] += 1; return privatizeArchiveFile({ directory: stage, snapshot, privatized, file }); },
      });
    };
    const next = staged();
    await next.load({ snapshot: false });
    next.history('outcomes');
    await next.recordOutcome(fatRow('d', 1_500_000));
    await next.recordOutcome(fatRow('e', 1_500_000));
    const extended = next.archiveReadCache.get('outcomes');
    assert.ok(extended, 'a privatized file whose prefix digest matches keeps the table');
    assert.equal(extended.keys.length, 3);
    assert.equal(typeof extended.digests.get('state.json.outcomes-archive.jsonl'), 'string');
    assert.equal(predecessor.keys.length, 2, 'the predecessor table is untouched');
    // A guard that hands the transaction different bytes under the same name is
    // what a rewrite between the parse and the copy would look like. The size is
    // unchanged, so only the content digest can refuse the table, and it must.
    const swapped = staged();
    await swapped.load({ snapshot: false });
    swapped.history('outcomes');
    const tampered = join(stage, 'tampered.jsonl');
    fs.writeFileSync(tampered, fs.readFileSync(archive(stage, 'outcomes'), 'utf8').replace('"synthetic-root"', '"synthetic-rooT"'));
    assert.equal(fs.statSync(tampered).size, fs.statSync(archive(stage, 'outcomes')).size);
    const guarded = memory(candidate, stage, {
      hotEntries: 1, archiveMaxBytes: 64 * 1024 * 1024,
      archiveWriteGuard: (file) => { fs.rmSync(file, { force: true }); fs.copyFileSync(tampered, file); },
    });
    guarded.archiveReadCache = swapped.archiveReadCache;
    await guarded.load({ snapshot: false });
    await guarded.recordOutcome(fatRow('f', 1_500_000));
    await guarded.recordOutcome(fatRow('g', 1_500_000));
    assert.equal(guarded.archiveReadCache.has('outcomes'), false,
      'a prefix whose digest no longer matches drops the table instead of extending it');
  });
});

test('a hot window with no visible archived row keeps its own order and duplicates', async () => {
  // `#mergeArchived()` returns the hot projection unchanged when the archive
  // contributes nothing: two rows of one id stay two rows, and an older
  // anonymous row does not move behind a newer named one.
  const rows = [
    { id: 'same', knowledgeKey: 'knowledge:dup', semanticFact: 'first duplicate', scope: 'plugin:dup' },
    { semanticFact: 'older anonymous', scope: 'plugin:anon' },
    { id: 'same', knowledgeKey: 'knowledge:dup', semanticFact: 'second duplicate', scope: 'plugin:dup' },
    { id: 'newest', knowledgeKey: 'knowledge:newest', semanticFact: 'newest row', scope: 'plugin:newest' },
  ];
  const state = { evolution: { schema: 4, knowledge: rows } };
  const open = async (impl, root = null) => {
    const instance = new impl.EvolutionMemory({
      stateStore: root
        ? new JsonStateStore({ filePath: join(root, 'state.json') })
        : { async load() { return JSON.parse(json(state)); }, async update() {} },
      clock: () => new Date(NOW), mutationAuthority: { assertMutation() {} },
    });
    await instance.load({ snapshot: false });
    return instance;
  };
  const current = await open(candidate);
  const reference = await open(baseline);
  for (const limit of [1, 2, 3, 4, 50]) {
    assert.deepEqual(current.historyWindow('knowledge', limit), reference.historyWindow('knowledge', limit),
      `the trailing window at limit ${limit} must match the released implementation`);
  }
  assert.equal(current.historyWindow('knowledge', 1).entries[0].id, 'newest',
    'the newest hot row is the window, not an older anonymous one');
  const options = { maxConsidered: 1 };
  const input = { why: 'newest row', target: 'plugin:newest' };
  assert.deepEqual(
    json(collectKnowledgeExperience(current.historyScan('knowledge', { window: 1 }), input, options)),
    json(collectKnowledgeExperience(reference.historyView('knowledge'), input, options)),
  );
  // The same shortcut applies when the file exists but every cold row in it is a
  // tombstone, so the archive contributes no visible row either.
  await withHome(async (root) => {
    fs.writeFileSync(archive(root, 'knowledge'), json({ id: 'retired', __evolutionTombstone: 1 }) + '\n');
    fs.writeFileSync(join(root, 'state.json'), json(state));
    const live = await open(candidate, root);
    const empty = memory(baseline, root);
    await empty.load({ snapshot: false });
    for (const limit of [1, 2, 50]) {
      assert.deepEqual(live.historyWindow('knowledge', limit), empty.historyWindow('knowledge', limit));
    }
  });
});

test('the recall scan view answers exactly what the complete view answered', async () => {
  await withHome(async (root) => {
    const key = candidate.knowledgeKeyOf({ problem: 'recall exact key', target: 'plugin:recall', componentId: 'plugin:recall' });
    const rows = [
      { id: key, knowledgeKey: key, semanticFact: 'recall exact key', scope: 'plugin:recall', state: 'RESOLVED',
        lastOutcome: 'success', successCount: 2, failureCount: 0, occurrenceCount: 2, firstSeen: NOW, lastSeen: NOW,
        summary: 'q'.repeat(1_500_000), effectStats: { successCount: 2, failureCount: 0, successRate: 1 }, updatedAt: NOW },
      ...Array.from({ length: 3 }, (_, index) => ({
        id: `key-${index}`, knowledgeKey: `knowledge:${'a'.repeat(32)}`, semanticFact: `filler fact ${index}`,
        scope: `plugin:filler-${index}`, state: 'KNOWN', lastOutcome: 'success', successCount: 1, failureCount: 0,
        occurrenceCount: 1, firstSeen: NOW, lastSeen: NOW, summary: 'r'.repeat(1_500_000),
        effectStats: { successCount: 1, failureCount: 0, successRate: 1 }, updatedAt: NOW,
      })),
    ];
    fs.writeFileSync(archive(root, 'knowledge'), rows.map(json).join('\n') + '\n');
    const current = memory(candidate, root);
    await current.load({ snapshot: false });
    const cached = current.archiveReadCache.get('knowledge');
    assert.equal(cached, undefined);
    const input = { why: 'recall exact key', target: 'plugin:recall' };
    // The exact-key row sits outside the retained window, so this is the path
    // a scan view has to answer from the table instead of from a materialised
    // row.
    const view = current.historyView('knowledge');
    const scan = current.historyScan('knowledge', { exactKey: key, window: 2000 });
    assert.equal(scan.total, view.length);
    const fromScan = collectKnowledgeExperience(scan, input);
    const fromView = collectKnowledgeExperience(view, input);
    assert.ok(fromScan.records.some((record) => record.key === key), 'the exact replay outside the window is found');
    assert.deepEqual(json(fromScan), json(fromView),
      'the bounded scan reaches the same records, duplicates and counts');
    const reference = memory(baseline, root);
    await reference.load({ snapshot: false });
    assert.deepEqual(json(collectKnowledgeExperience(scan, input)),
      json(collectKnowledgeExperience(reference.historyView('knowledge'), input)));
    assert.ok(current.archiveReadCache.get('knowledge').windowFrom > 0,
      'the fixture must force rows out of the retained window for this to be the scan path');
  });
});
