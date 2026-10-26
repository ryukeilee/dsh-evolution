// Small-data differentials against the actual rc.16 package, imported unchanged.
// Cache reuse is an optimization: retention, archive bytes and failed commits
// must still describe the same durable state as the released implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as candidateDomain from '../lib/dockyard-domain/index.js';
import { openDomainStorage } from '../lib/domain-storage.js';
import { mirrorArchives } from '../lib/archive-stage.js';
import { JsonStateStore } from './dockyard-domain/support.js';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const ARTIFACT = 'dsh-evolution-0.2.0-rc.16.tgz';
const ARTIFACT_SHA256 = '1d4a40a73a5f3f7331ca66ebcc8dcf7a82f6e50b00238b7618b4c04dd80c0ad6';
const NOW = '2026-10-12T00:00:00.000Z';
const artifact = path.join(REPO, 'release', ARTIFACT);
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex'), ARTIFACT_SHA256,
  'the rc.16 differential anchor must retain its released bytes');
const baselineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-rc16-'));
test.after(() => fs.rmSync(baselineRoot, { recursive: true, force: true }));
execFileSync('tar', [ '-xzf', artifact, '-C', baselineRoot, 'package/lib', 'package/package.json'], { stdio: 'pipe' });
// Resolve the package's external dependencies without rewriting any source.
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(baselineRoot, 'package', 'node_modules'), 'dir');
const baselineDomain = await import(pathToFileURL(path.join(baselineRoot, 'package/lib/dockyard-domain/index.js')).href);
const baselineStorage = await import(pathToFileURL(path.join(baselineRoot, 'package/lib/domain-storage.js')).href);
const baselineKnowledge = await import(pathToFileURL(path.join(baselineRoot, 'package/lib/dockyard-domain/knowledge.js')).href);
const baseline = { ...baselineDomain, openDomainStorage: baselineStorage.openDomainStorage };
const candidate = { ...candidateDomain, openDomainStorage };

const json = value => JSON.stringify(value);
const lines = rows => rows.map(json).join('\n') + '\n';
const archive = (root, collection = 'observations') => path.join(root, `state.json.${collection}-archive.jsonl`);
const authority = { assertMutation() {} };
function assertSharedParse(actual, expected, message) {
  for (const key of ['records', 'positions', 'tombstones', 'knowledgeKeys']) {
    assert.equal(actual[key], expected[key], `${message}: ${key}`);
  }
}
const signal = (component, extra = {}) => ({
  type: 'tool/result', code: 'CACHE_READY', message: 'cache warmup completed',
  problem: 'cache warmup', componentId: `plugin:${component}`, severity: 'info',
  status: 'observed', success: true, recordedAt: NOW, ...extra,
});

function reset(root) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
}

async function withHome(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-handoff-'));
  try { return await run(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function deterministic(run) {
  const RealDate = Date;
  const originalUuid = crypto.randomUUID;
  let serial = 0;
  class FrozenDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return RealDate.parse(NOW); }
  }
  globalThis.Date = FrozenDate;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
  syncBuiltinESMExports();
  try { return await run(); }
  finally { globalThis.Date = RealDate; crypto.randomUUID = originalUuid; syncBuiltinESMExports(); }
}

async function differential(run) {
  await withHome(async root => {
    const before = await deterministic(() => run(baseline, root, false));
    reset(root);
    const after = await deterministic(() => run(candidate, root, true));
    assert.deepEqual(after, before, 'candidate must preserve the unmodified rc.16 result');
  });
}

async function memory(impl, root, options = {}) {
  const instance = new impl.EvolutionMemory({
    stateStore: new JsonStateStore({ filePath: path.join(root, 'state.json') }),
    mutationAuthority: authority, clock: () => new Date(NOW), hotEntries: 8,
    hotCycles: 1, archiveMaxBytes: 1024 * 1024, ...options,
  });
  await instance.load({ snapshot: false });
  return instance;
}

function tree(root) {
  const out = {};
  function walk(dir, relative = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      const nested = relative ? `${relative}/${name}` : name;
      if (nested === 'domain-archive.lock' || nested === 'domain-commit.token') continue;
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) walk(file, nested);
      else out[nested] = fs.readFileSync(file, 'utf8');
    }
  }
  walk(root);
  return out;
}

test('rc.16 is a real pre-handoff package, not a reconstructed candidate', () => {
  const source = fs.readFileSync(path.join(baselineRoot, 'package/lib/domain-storage.js'), 'utf8');
  assert.doesNotMatch(source, /archiveReadCache/);
  assert.match(fs.readFileSync(path.join(baselineRoot, 'package/package.json'), 'utf8'), /"version": "0\.2\.0-rc\.16"/);
});

test('successors reuse missing/stale/direct-key cold rows without changing retention or durable bytes', async () => {
  await differential(async (impl, root, optimized) => {
    const directKey = baselineKnowledge.knowledgeKeyOf(signal('direct'));
    fs.writeFileSync(archive(root), lines([
      signal('missing', { id: 'cold-missing' }),
      signal('stale', { id: 'cold-stale', knowledgeKey: `knowledge:${'9'.repeat(32)}` }),
      signal('elsewhere', { id: 'cold-direct', knowledgeKey: directKey }),
    ]));
    let current = await memory(impl, root);
    current.history('observations');
    const first = current.archiveReadCache.get('observations');
    const returned = [];
    for (let round = 0; round < 3; round++) {
      const previous = current;
      current = await memory(impl, root, { archiveReadCache: previous.archiveReadCache });
      current.history('observations');
      if (optimized) {
        assert.notEqual(current.archiveReadCache, previous.archiveReadCache, 'each instance owns its cache map');
        assertSharedParse(current.archiveReadCache.get('observations'), first, 'unchanged bytes reuse the parsed cold rows');
      }
      for (const component of ['direct', 'missing', 'stale']) {
        const row = await current.recordObservation(signal(component, { id: `incoming-${component}-${round}` }));
        assert.equal(row.id, `cold-${component}`, `${component}: a cold source representative must be retained`);
        if (optimized && round === 0 && component === 'direct') {
          assert.equal(first.knowledgeKeys.has(first.records[2]), false, 'a stored-key match short circuits recomputation');
        }
        returned.push(row.id);
      }
    }
    if (optimized) {
      assert.equal(first.knowledgeKeys.get(first.records[0]), baselineKnowledge.knowledgeKeyOf(signal('missing')));
      assert.equal(first.knowledgeKeys.get(first.records[1]), baselineKnowledge.knowledgeKeyOf(signal('stale')));
      assert.equal(first.knowledgeKeys.get(first.records[2]), baselineKnowledge.knowledgeKeyOf(signal('elsewhere')),
        'fallback memoization must not replace the separate stored-key match');
    }
    assert.equal(current.snapshot().observations.length, 0);
    assert.deepEqual(current.knowledgeSnapshot().map(row => row.count), [3, 3, 3]);
    return { returned, full: json(current.fullSnapshot()), files: tree(root) };
  });
});

test('a same-id hot override is identified from its current fields on every handoff', async () => {
  await differential(async (impl, root, optimized) => {
    fs.writeFileSync(archive(root), lines([signal('old', { id: 'shared-id' })]));
    let current = await memory(impl, root);
    await current.recordObservation(signal('old', { id: 'warm-cold-identity' }));
    const returned = [];
    for (const component of ['new', 'newer', 'latest']) {
      const hot = signal(component, { id: 'shared-id', knowledgeKey: 'knowledge:stale-hot-key' });
      const snapshot = current.snapshot();
      snapshot.observations = [hot];
      fs.writeFileSync(path.join(root, 'state.json'), json({ evolution: snapshot }));
      const previous = current;
      current = await memory(impl, root, { archiveReadCache: previous.archiveReadCache });
      const result = await current.recordObservation(signal(component, { id: `probe-${component}` }));
      assert.equal(result.id, 'shared-id', 'the hot row overrides the identically named cold row');
      assert.equal(current.snapshot().observations.length, 1, 'the probe must not append a second source');
      if (optimized) {
        const hotRow = current.historyView('observations').find(row => row.id === 'shared-id');
        assert.equal(current.archiveReadCache.get('observations').knowledgeKeys.has(hotRow), false,
          'a hot override is never memoized as an immutable cold row');
      }
      returned.push(result);
    }
    return { returned, full: json(current.fullSnapshot()), files: tree(root) };
  });
});

test('handoff preserves anonymous/array ordering, latest values, tombstones and revival', async () => {
  await differential(async (impl, root, optimized) => {
    fs.mkdirSync(`${archive(root)}.segments`);
    fs.writeFileSync(path.join(`${archive(root)}.segments`, 'segment-000000000001.jsonl'), lines([
      { id: 'first', value: 'old' }, { payload: 'anonymous' }, [], { id: 'gone' },
      { id: 'revived', __evolutionTombstone: 1 },
    ]));
    fs.writeFileSync(archive(root), lines([
      { id: 'first', value: 'latest' }, { payload: 'anonymous' }, [],
      { id: 'gone', __evolutionTombstone: 1 }, { id: 'revived', value: 'back' },
    ]));
    fs.writeFileSync(path.join(root, 'state.json'), json({ evolution: { schema: 4,
      observations: [{ id: 'first', value: 'hot' }, { payload: 'hot' }, ['hot']] } }));
    const first = await memory(impl, root);
    const expected = [{ id: 'first', value: 'hot' }, { id: 'revived', value: 'back' },
      { payload: 'anonymous' }, [], { payload: 'hot' }, ['hot']];
    assert.deepEqual(first.history('observations'), expected);
    const next = await memory(impl, root, { archiveReadCache: first.archiveReadCache });
    assert.deepEqual(next.history('observations'), expected);
    if (optimized) assertSharedParse(next.archiveReadCache.get('observations'), first.archiveReadCache.get('observations'), 'successor shares only the parsed state');
    const detached = next.history('observations');
    detached[0].value = 'caller mutation';
    detached[3].push('caller mutation');
    assert.deepEqual(next.history('observations'), expected, 'public history remains detached');
    assert.deepEqual([...next.archiveTombstones.get('observations')], ['id:gone']);
    return { rows: next.history('observations'), full: json(next.fullSnapshot()), files: tree(root) };
  });
});

test('successors invalidate changed size, mtime, inode and segment file lists', async () => {
  await differential(async (impl, root, optimized) => {
    const file = archive(root);
    const pinned = 1_000_000_000;
    fs.writeFileSync(file, lines([{ id: 'a' }]));
    fs.utimesSync(file, pinned, pinned);
    let current = await memory(impl, root);
    current.history('observations');
    const observed = [];
    async function successor(expected) {
      const previous = current;
      const cached = previous.archiveReadCache.get('observations');
      current = await memory(impl, root, { archiveReadCache: previous.archiveReadCache });
      const rows = current.history('observations');
      assert.deepEqual(rows.map(row => row.id), expected);
      if (optimized) assert.notEqual(current.archiveReadCache.get('observations'), cached, 'changed file identity must force a parse');
      observed.push(rows);
    }
    // Size alone changes: restore the old mtime after appending.
    fs.appendFileSync(file, lines([{ id: 'b' }]));
    fs.utimesSync(file, pinned, pinned);
    await successor(['a', 'b']);
    // Same inode and size, new mtime.
    const inode = fs.statSync(file).ino;
    fs.writeFileSync(file, lines([{ id: 'c' }, { id: 'b' }]));
    fs.utimesSync(file, pinned + 1, pinned + 1);
    assert.equal(fs.statSync(file).ino, inode);
    await successor(['c', 'b']);
    // Same size and mtime, replaced inode.
    fs.writeFileSync(`${file}.replacement`, lines([{ id: 'd' }, { id: 'b' }]));
    fs.utimesSync(`${file}.replacement`, pinned + 1, pinned + 1);
    fs.renameSync(`${file}.replacement`, file);
    assert.notEqual(fs.statSync(file).ino, inode);
    await successor(['d', 'b']);
    const directory = `${file}.segments`;
    fs.mkdirSync(directory);
    const segment = path.join(directory, 'segment-000000000001.jsonl');
    fs.writeFileSync(segment, lines([{ id: 'sealed' }]));
    await successor(['sealed', 'd', 'b']);
    // The ordinary handoff differential includes the derived index bytes too.
    // Loss evidence is checked below after the segment is deliberately removed.
    const files = tree(root);
    fs.unlinkSync(segment);
    await successor(['d', 'b']);
    if (optimized) {
      const indexPath = path.join(root, 'state.json.evolution-archive-index.json');
      const indexBytes = fs.readFileSync(indexPath, 'utf8');
      const index = JSON.parse(indexBytes);
      assert.ok(index.integrityFaults?.some(fault => fault.collection === 'observations'
        && fault.file === 'segment-000000000001.jsonl' && fault.kind === 'missing-segment'),
      'a deleted indexed segment remains durable integrity evidence');
      assert.ok(!index.segments.some(entry => entry.file === 'segment-000000000001.jsonl'),
        'the live segment list contains only physical targets');
      const previous = current;
      const cached = previous.archiveReadCache.get('observations');
      current = await memory(impl, root, { archiveReadCache: previous.archiveReadCache });
      assert.deepEqual(current.history('observations').map(row => row.id), ['d', 'b']);
      if (optimized) assert.notEqual(current.archiveReadCache.get('observations'), cached,
        'the restart after segment loss still scans the changed file list');
      assert.equal(fs.readFileSync(indexPath, 'utf8'), indexBytes,
        'the same archive bytes and deterministic clock keep the derived index byte-identical after restart');
    }
    return { observed, files };
  });
});

test('faulted and torn-tail parses are re-observed at the successor absolute path', async () => {
  await differential(async (impl, root, optimized) => {
    const live = path.join(root, 'live');
    const stage = path.join(root, 'stage');
    fs.mkdirSync(live);
    const raw = lines([{ id: 'good' }]) + '{invalid}\n{"torn":';
    fs.writeFileSync(archive(live), raw);
    const first = await memory(impl, live);
    assert.deepEqual(first.history('observations'), [{ id: 'good' }]);
    assert.deepEqual(first.archiveIntegrity().observations.map(fault => fault.kind), ['invalid-line', 'torn-tail']);
    mirrorArchives(live, stage);
    const next = await memory(impl, stage, { archiveReadCache: first.archiveReadCache });
    if (optimized) assert.equal(next.archiveReadCache.has('observations'), false, 'faulted entries are not inherited');
    assert.deepEqual(next.history('observations'), [{ id: 'good' }]);
    const faults = next.archiveIntegrity().observations;
    assert.deepEqual(faults.map(fault => fault.kind), ['invalid-line', 'torn-tail']);
    assert.ok(faults.every(fault => fault.file === archive(stage)), 'faults must name the stage, even over shared inodes');
    assert.ok(first.archiveIntegrity().observations.every(fault => fault.file === archive(live)));
    next.history('observations');
    assert.deepEqual(next.archiveIntegrity().observations, faults, 'repeated reads preserve fault details');
    assert.equal(fs.readFileSync(archive(stage), 'utf8'), raw, 'reading does not repair or discard the tail');
    return { faults, first: first.archiveIntegrity(), files: tree(root) };
  });
});

test('append extension owns records, positions and tombstones instead of changing its predecessor cache', async () => {
  await differential(async (impl, root, optimized) => {
    fs.writeFileSync(archive(root, 'cycles'), lines([{ id: 'cold', status: 'observed', recordedAt: NOW }]));
    const first = await memory(impl, root);
    first.history('cycles');
    const prior = first.archiveReadCache.get('cycles');
    const original = { records: json(prior.records), positions: [...prior.positions], tombstones: [...prior.tombstones] };
    const next = await memory(impl, root, { archiveReadCache: first.archiveReadCache });
    await next.recordCycle({ id: 'new-one', status: 'observed', recordedAt: NOW });
    await next.recordCycle({ id: 'new-two', status: 'observed', recordedAt: NOW });
    await next.recordCycle({ id: 'cold', __evolutionTombstone: 1, status: 'observed', recordedAt: NOW });
    assert.deepEqual({ records: json(prior.records), positions: [...prior.positions], tombstones: [...prior.tombstones] }, original,
      'the predecessor parse is immutable across successor appends and tombstones');
    if (optimized) {
      const cached = next.archiveReadCache.get('cycles');
      assert.notEqual(cached.records, prior.records);
      assert.notEqual(cached.positions, prior.positions);
      assert.notEqual(cached.tombstones, prior.tombstones);
      assert.equal(cached.positions.has('id:new-one'), true);
      assert.equal(cached.tombstones.has('id:cold'), true);
    }
    return { full: json(next.fullSnapshot()), files: tree(root) };
  });
});

function officialFixture(root) {
  const backends = [];
  function context() {
    const backend = new JsonStorageBackend(path.join(root, 'official'));
    backends.push(backend);
    const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
    ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
    return ctx;
  }
  const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'),
    eventBridgeKey: 'b'.repeat(64), domainSeed: true };
  const live = path.join(root, 'dockyard');
  fs.mkdirSync(live);
  fs.writeFileSync(archive(live), lines([signal('cold', { id: 'cold' })]));
  fs.writeFileSync(archive(live, 'cycles'), lines([{ id: 'untouched-cycle', status: 'observed', recordedAt: NOW }]));
  // Exactly one default hot window. One observe forces an isolated archive
  // append without requiring dozens of real port commits to build the fixture.
  fs.writeFileSync(path.join(live, 'state.json'), json({ evolution: { schema: 4,
    observations: Array.from({ length: 50 }, (_, index) => signal(`seed-${index}`, { id: `seed-${index}` })) } }));
  return { context, config, live, close: async () => { for (const backend of backends) await backend.close(); } };
}

function capturePortMemory(impl, port) {
  const original = impl.EvolutionMemory.prototype.historyWindow;
  let captured;
  impl.EvolutionMemory.prototype.historyWindow = function (...args) { captured = this; return original.apply(this, args); };
  try { port.query('observations'); }
  finally { impl.EvolutionMemory.prototype.historyWindow = original; }
  assert.ok(captured, 'the real port must query its own memory');
  return captured;
}

for (const phase of ['before-commit', 'pending-install']) {
  test(`real port ${phase} failure preserves the old instance and matches rc.16 restart recovery`, async () => {
    await differential(async (impl, root, optimized) => {
      const f = officialFixture(root);
      const ports = [];
      const ctx = f.context();
      let restoreHook = () => {};
      try {
        const port = await impl.openDomainStorage(ctx, f.config);
        ports.push(port);
        const old = capturePortMemory(impl, port);
        const oldRows = old.history('observations');
        const oldParse = old.archiveReadCache.get('observations');
        old.history('cycles');
        const cycleParse = old.archiveReadCache.get('cycles');
        const oldBytes = fs.readFileSync(archive(f.live), 'utf8');
        const oldDocument = json(ctx.storageDomain.get('evolution_domain').global.get());
        let staged;
        const originalRecord = impl.EvolutionObservationStore.prototype.record;
        impl.EvolutionObservationStore.prototype.record = async function (...args) {
          staged = this.memory;
          if (optimized) {
            assert.notEqual(staged.archiveReadCache, old.archiveReadCache);
            assertSharedParse(staged.archiveReadCache.get('observations'), oldParse, 'stage inherits the live parsed rows');
            assertSharedParse(staged.archiveReadCache.get('cycles'), cycleParse, 'unchanged collections cross into the stage too');
          }
          assert.equal(fs.statSync(archive(path.dirname(staged.stateStore.filePath))).ino,
            fs.statSync(archive(f.live)).ino, 'the stage starts as a real hard link');
          const result = await originalRecord.apply(this, args);
          assert.notEqual(fs.statSync(archive(path.dirname(staged.stateStore.filePath))).ino,
            fs.statSync(archive(f.live)).ino, 'the first staged append must privatize the archive');
          assert.equal(fs.readFileSync(archive(f.live), 'utf8'), oldBytes);
          assert.deepEqual(old.history('observations'), oldRows, 'a stage cannot publish through the old instance cache');
          if (phase === 'before-commit') throw new Error('INJECTED_BEFORE_COMMIT');
          return result;
        };
        const originalRename = fs.renameSync;
        let installationFailed = false;
        if (phase === 'pending-install') fs.renameSync = function (from, to) {
          if (to === archive(f.live) && !installationFailed) {
            installationFailed = true;
            throw new Error('INJECTED_PENDING_INSTALL');
          }
          return originalRename(from, to);
        };
        restoreHook = () => { impl.EvolutionObservationStore.prototype.record = originalRecord; fs.renameSync = originalRename; };
        const failure = phase === 'before-commit' ? /INJECTED_BEFORE_COMMIT/ : /INJECTED_PENDING_INSTALL/;
        try { await assert.rejects(port.observe({ code: 'CACHE_HANDOFF_FAILED', target: 'tool:handoff' }), failure); }
        finally { restoreHook(); restoreHook = () => {}; }
        assert.ok(staged, 'failure injection must reach the real staged observation');
        assert.deepEqual(old.history('observations'), oldRows);
        assert.equal(fs.readFileSync(archive(f.live), 'utf8'), oldBytes);
        assert.equal(port.query('observations').count, 51);
        const document = ctx.storageDomain.get('evolution_domain').global.get();
        if (phase === 'before-commit') {
          assert.equal(json(document), oldDocument, 'pre-commit failure must publish no pending record');
        } else {
          assert.ok(document.pending, 'the failed installation must retain its committed pending document');
          assert.ok(document.pending.files.some(entry => entry.file === 'state.json.observations-archive.jsonl'));
          assert.equal(installationFailed, true);
        }
        const failedTree = tree(root);
        await assert.rejects(port.close(), failure);
        ports.pop();
        const restarted = await impl.openDomainStorage(f.context(), f.config);
        ports.push(restarted);
        const recoveredMemory = capturePortMemory(impl, restarted);
        const recovered = recoveredMemory.history('observations');
        recoveredMemory.history('cycles');
        const recoveredCycles = recoveredMemory.archiveReadCache.get('cycles');
        const committed = phase === 'pending-install';
        assert.equal(restarted.query('observations').count, committed ? 52 : 51);
        assert.equal(recovered.some(row => row.componentId === 'tool:handoff'), committed);
        assert.deepEqual(old.history('observations'), oldRows, 'old hot rows remain stable after a disk recovery');
        const durable = JSON.parse(fs.readFileSync(path.join(root, 'official', 'evolution_domain.json'), 'utf8')).global;
        assert.equal(durable.pending, null);
        if (committed) assert.equal(fs.existsSync(path.join(root, 'domain-staging', document.pending.stage)), false);
        await restarted.observe({ code: 'CACHE_AFTER_RECOVERY', target: 'tool:after-recovery' });
        assert.equal(restarted.query('observations').count, committed ? 53 : 52);
        if (optimized) {
          const hydrated = capturePortMemory(impl, restarted);
          assert.notEqual(hydrated.archiveReadCache, recoveredMemory.archiveReadCache);
          assertSharedParse(hydrated.archiveReadCache.get('cycles'), recoveredCycles,
            'a successful stage hands unchanged parsed rows through to the hydrated live instance');
        }
        const projection = restarted.query('observations', 50);
        await restarted.close();
        ports.pop();
        return { failedTree, recovered: json(recovered), projection, finalTree: tree(root) };
      } finally {
        restoreHook();
        for (const port of ports) await port.close().catch(() => {});
        await f.close();
      }
    });
  });
}
