import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDomainStorage } from '../../lib/domain-storage.js';
import { assertLiveTreeUnchanged, changedArchiveFiles, copyArchives, installArchiveFiles,
  mirrorArchives, privatizeArchiveFile, readStageManifest, syncStage, walkArchives, writeStageManifest } from '../../lib/archive-stage.js';
import { EvolutionMemory, EvolutionObservationStore } from '../../lib/dockyard-domain/index.js';
// The official storage packages are dev dependencies of this repo, so the
// domain integration is exercised against the real official implementation.
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-archive-stage-'));
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'), eventBridgeKey: 'b'.repeat(64) };
  return { root, ctx, config, backend };
}

async function teardown(f) { await f.backend.close(); fs.rmSync(f.root, { recursive: true, force: true }); }

function treeOf(root, relative = '') {
  const out = new Map();
  walkArchives(root, (nested, absolute, stat) => out.set(nested, { dev: String(stat.dev), ino: String(stat.ino), size: stat.size }), relative);
  return out;
}

/** A sealed cycles segment plus its index, exactly like a live archive. */
function writeSealedSegment(root, index = 1) {
  const directory = path.join(root, 'state.json.cycles-archive.jsonl.segments');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const raw = `${JSON.stringify({ id: `cycle-${index}`, status: 'observed', recordedAt: '2026-08-26T12:00:00.000Z' })}\n`;
  const file = `segment-${String(index).padStart(12, '0')}.jsonl`;
  fs.writeFileSync(path.join(directory, file), raw, { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'state.json.evolution-archive-index.json'), JSON.stringify({
    schemaVersion: 1, segments: [{ collection: 'cycles', file, sealed: true, checksumState: 'final',
      byteSize: Buffer.byteLength(raw), sha256: crypto.createHash('sha256').update(raw).digest('hex') }] }), { mode: 0o600 });
}

// Enough distinct observations to overflow the hot pool and force archive writes.
async function forceArchiveWrite(port, offset = 0) {
  for (let index = 0; index < 55; index++) await port.observe({ code: 'BENCH_ERROR', target: `tool:stage-${offset + index}` });
}

function domainGlobalPath(f) { return path.join(f.root, 'official', 'evolution_domain.json'); }

function writeDomainGlobal(f, global) {
  const document = JSON.parse(fs.readFileSync(domainGlobalPath(f), 'utf8'));
  fs.writeFileSync(domainGlobalPath(f), JSON.stringify({ ...document, global }));
}

test('a staged tree shares the live inodes instead of copying the archive', async () => {
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-live-'));
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-stage-'));
  const stage = path.join(staging, 'stage-1');
  try {
    writeSealedSegment(live);
    const before = treeOf(live);
    const snapshot = mirrorArchives(live, stage);
    const staged = treeOf(stage);
    assert.deepEqual([...staged.keys()].sort(), [...before.keys()].sort());
    for (const [relative, entry] of staged) assert.equal(entry.ino, before.get(relative).ino, `${relative} must share the live inode`);
    assert.deepEqual(changedArchiveFiles(stage, snapshot), []);

    // A new private file in the stage is the only change; the live tree keeps
    // its bytes and every untouched file keeps its inode.
    const active = path.join(stage, 'state.json.cycles-archive.jsonl');
    fs.writeFileSync(active, '{"id":"appended"}\n', { mode: 0o600 });
    assert.deepEqual(changedArchiveFiles(stage, snapshot).map(entry => entry.file), ['state.json.cycles-archive.jsonl']);
    assert.equal(fs.existsSync(path.join(live, 'state.json.cycles-archive.jsonl')), false);
    assertLiveTreeUnchanged(live, snapshot);

    // An external write to the live tree is a hard failure, not a silent mix.
    fs.appendFileSync(path.join(live, 'state.json.evolution-archive-index.json'), ' ');
    assert.throws(() => assertLiveTreeUnchanged(live, snapshot), /E_DOMAIN_STAGE_ISOLATION/);
  } finally {
    fs.rmSync(live, { recursive: true, force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
});

test('a stage manifest round-trips and rejects unusable entries', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-manifest-'));
  try {
    const files = [{ file: 'state.json.cycles-archive.jsonl', bytes: 3, sha256: 'a'.repeat(64) }];
    writeStageManifest(directory, files);
    assert.deepEqual(readStageManifest(directory), files);
    const write = value => fs.writeFileSync(path.join(directory, '.archive-files.json'), JSON.stringify(value));
    write({ schema: 1, files: [{ file: '../escape', bytes: 1, sha256: 'a'.repeat(64) }] });
    assert.equal(readStageManifest(directory), null);
    write({ schema: 1, files: [{ file: 'state.json.cycles-archive.jsonl', bytes: '3', sha256: 'a'.repeat(64) }] });
    assert.equal(readStageManifest(directory), null);
    write({ schema: 1, files: [{ file: 'unrelated.jsonl', bytes: 1, sha256: 'a'.repeat(64) }] });
    assert.equal(readStageManifest(directory), null);
    write({ schema: 2, files });
    assert.equal(readStageManifest(directory), null);
    fs.writeFileSync(path.join(directory, '.archive-files.json'), 'not json');
    assert.equal(readStageManifest(directory), null);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('installing a stage replaces only the changed files and verifies their bytes', async () => {
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-install-live-'));
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-install-stage-'));
  const stage = path.join(staging, 'stage-1');
  try {
    writeSealedSegment(live, 1);
    writeSealedSegment(live, 2);
    const before = treeOf(live);
    const snapshot = mirrorArchives(live, stage);
    fs.writeFileSync(path.join(stage, 'state.json.cycles-archive.jsonl'), '{"id":"appended"}\n', { mode: 0o600 });
    const files = changedArchiveFiles(stage, snapshot);
    writeStageManifest(stage, files);
    syncStage({ directory: stage, stagingRoot: staging, files });

    // A digest that does not match the committed stage must not be installed.
    writeStageManifest(stage, [{ ...files[0], sha256: 'f'.repeat(64) }]);
    assert.throws(() => installArchiveFiles(stage, live, readStageManifest(stage)), /E_DOMAIN_PENDING_ARCHIVE_CORRUPT/);
    // A file that is not staged must not be installed either.
    writeStageManifest(stage, [{ file: 'state.json.cycles-archive.jsonl', bytes: 1, sha256: 'a'.repeat(64) }]);
    assert.throws(() => installArchiveFiles(stage, live, readStageManifest(stage)), /E_DOMAIN_PENDING_ARCHIVE_CORRUPT/);

    writeStageManifest(stage, files);
    installArchiveFiles(stage, live, readStageManifest(stage));
    assert.equal(fs.readFileSync(path.join(live, 'state.json.cycles-archive.jsonl'), 'utf8'), '{"id":"appended"}\n');
    const after = treeOf(live);
    for (const [relative, entry] of before) assert.equal(after.get(relative).ino, entry.ino, `${relative} must not be rewritten`);
    // Files that are not archive entries are never walked, staged or installed.
    fs.writeFileSync(path.join(stage, 'not-allowed.jsonl'), 'x');
    assert.equal(treeOf(stage).has('not-allowed.jsonl'), false);
  } finally {
    fs.rmSync(live, { recursive: true, force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
});

test('a committed transaction leaves untouched archive files byte-identical', async () => {
  const f = await fixture();
  const archiveRoot = path.join(f.root, 'dockyard');
  fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
  writeSealedSegment(archiveRoot);
  let port = await openDomainStorage(f.ctx, f.config);
  await port.close();
  const before = treeOf(archiveRoot);
  const sealed = 'state.json.cycles-archive.jsonl.segments/segment-000000000001.jsonl';
  assert.ok(before.has(sealed));

  port = await openDomainStorage(f.ctx, f.config);
  await forceArchiveWrite(port);
  const after = treeOf(archiveRoot);
  assert.equal(after.get(sealed).ino, before.get(sealed).ino, 'an untouched sealed segment must keep its inode');
  assert.equal(fs.readFileSync(path.join(archiveRoot, ...sealed.split('/')), 'utf8').includes('cycle-1'), true);
  assert.equal(after.has('state.json.observations-archive.jsonl'), true);
  assert.equal(port.query('cycles').count, 1);
  assert.equal((await port.query('observations')).count > 0, true);
  assert.equal(fs.readdirSync(path.join(f.root, 'domain-staging')).length, 0, 'a committed stage is removed');
  await port.close();
  await teardown(f);
});

test('recovery installs a staged archive when the install is interrupted', async () => {
  const f = await fixture();
  const port = await openDomainStorage(f.ctx, f.config);
  const archiveRoot = path.join(f.root, 'dockyard');
  const liveActive = path.join(archiveRoot, 'state.json.observations-archive.jsonl');
  const originalRename = fs.renameSync;
  let interrupted = false;
  fs.renameSync = (from, to) => {
    // Fail exactly where the install publishes the staged archive into the
    // live tree: the pending record is already durable at this point.
    if (to === liveActive && !interrupted) { interrupted = true; throw new Error('INJECTED_INSTALL_FAILURE'); }
    return originalRename(from, to);
  };
  let failed = null;
  try { await forceArchiveWrite(port); } catch (error) { failed = error; }
  fs.renameSync = originalRename;
  assert.match(String(failed?.message), /INJECTED_INSTALL_FAILURE/);
  const domain = f.ctx.storageDomain.get('evolution_domain');
  const pending = domain.global.get().pending;
  assert.ok(pending, 'the archive transaction must be pending');
  const stage = path.join(f.root, 'domain-staging', pending.stage);
  const files = readStageManifest(stage);
  assert.ok(files?.length > 0, 'the staged tree must carry the changed files');
  const stagedActive = fs.readFileSync(path.join(stage, 'state.json.observations-archive.jsonl'), 'utf8');
  const published = fs.existsSync(liveActive) ? fs.readFileSync(liveActive, 'utf8') : null;
  assert.notEqual(published, stagedActive, 'the interrupted install must not have published the staged write');
  await assert.rejects(port.close(), /INJECTED_INSTALL_FAILURE/);

  // Recovery relies on the durable pending list, even if the optional on-disk
  // manifest disappears or is corrupted after the pending record commits.
  fs.writeFileSync(path.join(stage, '.archive-files.json'), 'torn manifest');
  assert.deepEqual(pending.files, files);
  // Recovery replays the recorded files, then commits the aggregate.
  const restarted = await openDomainStorage(f.ctx, f.config);
  assert.equal(f.ctx.storageDomain.get('evolution_domain').global.get().pending, null);
  assert.equal(fs.readFileSync(liveActive, 'utf8'), stagedActive);
  assert.equal(fs.existsSync(stage), false, 'a replayed stage is removed');
  for (const entry of files) assert.equal(fs.existsSync(path.join(archiveRoot, ...entry.file.split('/'))), true);
  assert.equal((await restarted.query('observations')).count > 0, true);
  await restarted.close();
  await teardown(f);
});

test('a stage without a manifest is replayed as a full copy', async () => {
  const f = await fixture();
  let port = await openDomainStorage(f.ctx, f.config);
  await port.observe({ code: 'BENCH_ERROR', target: 'tool:legacy-seed' });
  await port.close();
  const global = JSON.parse(fs.readFileSync(domainGlobalPath(f), 'utf8')).global;
  const archiveRoot = path.join(f.root, 'dockyard');
  const stage = path.join(f.root, 'domain-staging', 'stage-11111111-2222-3333-4444-555555555555');
  fs.mkdirSync(path.join(stage, 'state.json.cycles-archive.jsonl.segments'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stage, 'state.json.cycles-archive.jsonl'), '{"id":"legacy-active"}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(stage, 'state.json.cycles-archive.jsonl.segments', 'segment-000000000001.jsonl'), '{"id":"legacy-sealed"}\n', { mode: 0o600 });
  writeDomainGlobal(f, { ...global, pending: { stage: 'stage-11111111-2222-3333-4444-555555555555', aggregate: global.aggregate, applied: global.applied } });

  port = await openDomainStorage(f.ctx, f.config);
  assert.equal(fs.readFileSync(path.join(archiveRoot, 'state.json.cycles-archive.jsonl'), 'utf8'), '{"id":"legacy-active"}\n');
  assert.equal(fs.readFileSync(path.join(archiveRoot, 'state.json.cycles-archive.jsonl.segments', 'segment-000000000001.jsonl'), 'utf8'), '{"id":"legacy-sealed"}\n');
  assert.equal(f.ctx.storageDomain.get('evolution_domain').global.get().pending, null);
  assert.equal(fs.existsSync(stage), false);
  await port.close();
  await teardown(f);
});

test('a live archive write during a staged transaction fails loudly', async () => {
  const f = await fixture();
  const archiveRoot = path.join(f.root, 'dockyard');
  fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
  writeSealedSegment(archiveRoot);
  const port = await openDomainStorage(f.ctx, f.config);
  const original = EvolutionObservationStore.prototype.record;
  let wrote = false;
  EvolutionObservationStore.prototype.record = function patched(observation) {
    if (!wrote) {
      wrote = true;
      fs.appendFileSync(path.join(archiveRoot, 'state.json.evolution-archive-index.json'), ' ');
    }
    return original.call(this, observation);
  };
  try {
    await assert.rejects(forceArchiveWrite(port), /E_DOMAIN_STAGE_ISOLATION/);
    assert.equal(f.ctx.storageDomain.get('evolution_domain').global.get().pending, null,
      'a transaction that lost isolation must not be committed');
  } finally {
    EvolutionObservationStore.prototype.record = original;
    await assert.rejects(port.close(), /E_DOMAIN_STAGE_ISOLATION/);
    await teardown(f);
  }
});

test('the legacy full-copy path still copies a stage without a manifest', async () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-legacy-source-'));
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-legacy-live-'));
  try {
    writeSealedSegment(source, 1);
    writeSealedSegment(source, 2);
    copyArchives(source, live);
    assert.deepEqual([...treeOf(live).keys()].sort(), [...treeOf(source).keys()].sort());
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(live, { recursive: true, force: true });
  }
});

test('append and rotation privatize shared active files before writing', async () => {
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-rotation-live-'));
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-rotation-stage-'));
  try {
    writeSealedSegment(live);
    const active = 'state.json.cycles-archive.jsonl';
    fs.writeFileSync(path.join(live, active), '{"id":"existing-active"}\n');
    const original = fs.readFileSync(path.join(live, active));
    const stage = path.join(staging, 'stage-rotation');
    const snapshot = mirrorArchives(live, stage), privatized = new Set();
    let aggregate = { evolution: { schema: 4, cycles: Array.from({ length: 8 }, (_, i) => ({
      id: `rotation-${i}`, status: 'observed', summary: 'x'.repeat(200) })) } };
    const stateStore = { filePath: path.join(stage, 'state.json'), load: async () => aggregate,
      update: async update => { aggregate = update(aggregate); } };
    const memory = new EvolutionMemory({ stateStore, hotCycles: 1, archiveMaxBytes: 256,
      archiveWriteGuard: file => privatizeArchiveFile({ directory: stage, snapshot, privatized, file }) });
    await memory.load();
    assert.ok(privatized.has(active));
    assert.deepEqual(fs.readFileSync(path.join(live, active)), original, 'uncommitted rotations leave live bytes intact');
    assertLiveTreeUnchanged(live, snapshot);
    const files = changedArchiveFiles(stage, snapshot);
    assert.ok(files.some(entry => entry.file.includes('.segments/')));
    writeStageManifest(stage, files);
    syncStage({ directory: stage, stagingRoot: staging, files });
    installArchiveFiles(stage, live, files);
    installArchiveFiles(stage, live, files); // recovery replay is idempotent
    assert.deepEqual(fs.readFileSync(path.join(live, active)), fs.readFileSync(path.join(stage, active)));
  } finally { fs.rmSync(live, { recursive: true, force: true }); fs.rmSync(staging, { recursive: true, force: true }); }
});
