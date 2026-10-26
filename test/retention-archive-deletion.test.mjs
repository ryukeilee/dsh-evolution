/**
 * Archive-segment deletion inside the domain transaction.
 *
 * The blocker this pins: a compaction replaces the segment directory wholesale,
 * but the committed change list could only describe files that exist. A stage
 * that no longer had 30 segments therefore installed its replacements and left
 * every retired segment in the live tree, where the next load read the old
 * source rows *and* the aggregate rows that replaced them. `changedArchiveFiles`
 * now derives a deletion from the same snapshot it derives replacements from,
 * and `installArchiveFiles` removes exactly those bytes after proving them.
 *
 * The pre-fix failure is not an import error: every assertion below reads
 * `changedArchiveFiles` / `installArchiveFiles`, both of which exist on the
 * released implementation. There the change list carries no `removed` entry, the
 * installer deletes nothing, and the reopened memory reports the original rows
 * beside their aggregates (`verifyConsistency().valid === false`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { changedArchiveFiles, installArchiveFiles, mirrorArchives } from '../lib/archive-stage.js';
import { EvolutionMemory } from '../lib/dockyard-domain/memory.js';
import { JsonStateStore } from './dockyard-domain/support.js';

const NOW = '2026-10-26T00:00:00.000Z';
const OBSERVATIONS = 'state.json.observations-archive.jsonl';
const OBSERVATION_SEGMENTS = `${OBSERVATIONS}.segments`;

function scratch(t, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `retention-${name}-`));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function makeMemory(store) {
  const memory = new EvolutionMemory({
    stateStore: store,
    clock: () => new Date(NOW),
    maxEntries: 1000,
    hotEntries: 2,
    hotCycles: 2,
    archiveMaxBytes: 512,
    absoluteMaxSegmentBytes: 4096,
  });
  memory.setMutationAuthority({ assertMutation() {}, isActive: () => true });
  return memory;
}

function segmentNames(root) {
  const directory = path.join(root, OBSERVATION_SEGMENTS);
  try {
    return fs.readdirSync(directory).filter(name => /^segment-[0-9]+\.jsonl$/.test(name)).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** A live archive tree with many sealed observation segments. */
async function liveFixture(t, { rows = 40 } = {}) {
  const home = scratch(t, 'live');
  // `openDomainStorage` treats `presetDir` as the profile directory and keeps the
  // archive tree in its `dockyard/` child, so the fixture lives where a real port
  // would look for it.
  const root = path.join(home, 'dockyard');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const store = new JsonStateStore({ filePath: path.join(root, 'state.json') });
  const sourceRows = Array.from({ length: rows }, (_, index) => ({
    id: `observation-${String(index + 1).padStart(4, '0')}`,
    type: 'component/observation',
    severity: 'info',
    componentId: `component-${index % 4}`,
    recordedAt: NOW,
    metrics: { usageCount: index + 1 },
    payload: `synthetic-row-${index % 4}-${'x'.repeat(120)}`,
  }));
  fs.writeFileSync(store.filePath, JSON.stringify({ evolution: { observations: sourceRows } }), { mode: 0o600 });
  const memory = makeMemory(store);
  await memory.load();
  const segments = segmentNames(root);
  return { home, root, store, sourceRows, segments };
}

/** Mirror, compact, and return the parts the transaction would exchange. */
async function stagedCompaction(t, { rows = 40 } = {}) {
  const fixture = await liveFixture(t, { rows });
  const stage = scratch(t, 'stage');
  const snapshot = mirrorArchives(fixture.root, stage);
  fs.copyFileSync(fixture.store.filePath, path.join(stage, 'state.json'));
  const stagedStore = new JsonStateStore({ filePath: path.join(stage, 'state.json') });
  const staged = makeMemory(stagedStore);
  await staged.load();
  const before = segmentNames(stage);
  const report = await staged.compact();
  const after = segmentNames(stage);
  return { ...fixture, stage, stagedStore, staged, snapshot, before, after, report };
}

test('a compacted stage deletes the segments it replaced, and a restart reads only the aggregates', async (t) => {
  const run = await stagedCompaction(t);
  assert.ok(run.before.length >= 3, `the fixture must seal several segments, got ${run.before.length}`);
  assert.ok(run.after.length < run.before.length, 'compaction must reduce the segment count for this fixture');
  const vanished = run.before.filter(name => !run.after.includes(name));
  assert.ok(vanished.length > 0);

  const changed = changedArchiveFiles(run.stage, run.snapshot, run.root);
  const removals = changed.filter(entry => entry.removed === true);
  assert.deepEqual(removals.map(entry => entry.file).sort(),
    vanished.map(name => `${OBSERVATION_SEGMENTS}/${name}`).sort(),
    'every segment the stage dropped is named as a deletion');
  for (const removal of removals) {
    const live = path.join(run.root, ...removal.file.split('/'));
    assert.equal(removal.bytes, fs.statSync(live).size);
    assert.equal(removal.sha256, sha256(live), 'the deletion records the committed bytes it removes');
  }
  assert.deepEqual(changed.filter(entry => entry.removed !== true).map(entry => entry.file).sort(),
    [...changed.filter(entry => entry.removed !== true)].map(entry => entry.file).sort());

  // The pending protocol publishes the aggregate first, then installs the list.
  const stagedState = await run.stagedStore.load();
  await run.store.update(() => stagedState);
  installArchiveFiles(run.stage, run.root, changed);

  const remaining = segmentNames(run.root);
  assert.deepEqual(remaining, run.after, 'the live tree keeps exactly the segments the stage produced');
  const index = JSON.parse(fs.readFileSync(path.join(run.root, 'state.json.evolution-archive-index.json'), 'utf8'));
  const indexed = new Set(index.segments.filter(entry => entry.collection === 'observations'
    && /^segment-[0-9]+\.jsonl$/.test(entry.file)).map(entry => entry.file));
  assert.deepEqual(remaining.filter(name => !indexed.has(name)), [], 'no live segment is left out of the index');

  // Replaying the same list is a no-op rather than a second deletion.
  installArchiveFiles(run.stage, run.root, changed);
  assert.deepEqual(segmentNames(run.root), run.after);

  const reopened = makeMemory(new JsonStateStore({ filePath: path.join(run.root, 'state.json') }));
  await reopened.load();
  const history = reopened.history('observations');
  const ids = new Set(run.sourceRows.map(row => row.id));
  const resurrected = history.filter(entry => ids.has(String(entry?.id ?? '')));
  const aggregates = history.filter(entry => entry?.retention === 'AGGREGATED');
  assert.equal(resurrected.length, 0, 'the retired source rows are not readable beside their replacement');
  assert.ok(aggregates.length > 0, 'the aggregate rows that replaced them are readable');
  const consistency = await reopened.verifyConsistency();
  // `coldArchives` records the absolute path of the memory that wrote it, so an
  // aggregate staged under `domain-staging/` and installed into `dockyard/`
  // always leaves a projection-path difference until the next live mutation
  // rewrites it. That is the pre-existing artifact `retention-reclaim-blockers`
  // R1 measured; it is pinned here so a *new* reason (a duplicate id, an
  // unreadable archive, an inconsistent index) cannot hide behind it.
  assert.deepEqual(consistency.reasons, ['live_durable_memory_projection_mismatch'],
    `the reopened store must have no data-loss or archive reason: ${JSON.stringify(consistency.reasons)}`);
  assert.equal(consistency.archive.valid, true, 'the archive index and every live byte are consistent');
  assert.deepEqual(consistency.duplicateIds, []);
});

test('a deletion whose live bytes changed is refused before any live byte moves', async (t) => {
  const run = await stagedCompaction(t);
  const changed = changedArchiveFiles(run.stage, run.snapshot, run.root);
  const removal = changed.find(entry => entry.removed === true);
  assert.ok(removal, 'the fixture must produce a deletion');
  const live = path.join(run.root, ...removal.file.split('/'));
  const original = fs.readFileSync(live);
  fs.writeFileSync(live, Buffer.concat([original, Buffer.from('\n{"tampered":true}\n')]));

  const active = path.join(run.root, OBSERVATIONS);
  const before = fs.readFileSync(active);
  assert.throws(() => installArchiveFiles(run.stage, run.root, changed), /E_DOMAIN_PENDING_ARCHIVE_CORRUPT/);
  assert.ok(fs.existsSync(live), 'the unverified segment is preserved, so the change stays visible');
  assert.deepEqual(fs.readFileSync(active), before, 'a refused install publishes no replacement either');
});

test('a vanished file without a deletion protocol, or a live tree that moved, is refused', async (t) => {
  const run = await stagedCompaction(t);
  // The stage no longer has the active archive: that is not a deletable shape.
  const activeInStage = path.join(run.stage, OBSERVATIONS);
  const activeContent = fs.existsSync(activeInStage) ? fs.readFileSync(activeInStage) : null;
  fs.rmSync(activeInStage, { force: true });
  assert.throws(() => changedArchiveFiles(run.stage, run.snapshot, run.root), /E_DOMAIN_STAGE_DELETION_UNSUPPORTED/);
  if (activeContent !== null) fs.writeFileSync(activeInStage, activeContent);

  // A deletion without a live tree to prove the bytes against is unverifiable.
  assert.throws(() => changedArchiveFiles(run.stage, run.snapshot), /E_DOMAIN_STAGE_DELETION_UNVERIFIABLE/);

  // A live segment that changed after the snapshot cannot be described as a
  // deletion of the committed bytes. It has to be one the stage no longer has:
  // a segment the stage rewrote is a replacement, not a deletion.
  const vanished = run.before.filter(name => !run.after.includes(name))[0];
  assert.ok(vanished, 'the fixture must produce a vanished segment');
  const live = path.join(run.root, OBSERVATION_SEGMENTS, vanished);
  const original = fs.readFileSync(live);
  fs.writeFileSync(live, Buffer.concat([original, Buffer.from('\n')]));
  assert.throws(() => changedArchiveFiles(run.stage, run.snapshot, run.root), /E_DOMAIN_STAGE_DELETION_UNPROVEN/);
});

/** Publish a pending record exactly as a crash between its write and the install leaves it. */
async function seedPendingRecord(t, run, files) {
  const stagedState = await run.stagedStore.load();
  const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
  const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');
  const { evolutionDomainSpec, openDomainStorage } = await import('../lib/domain-storage.js');
  const backend = new JsonStorageBackend(path.join(run.home, 'official'));
  t.after(() => backend.close());
  const ctx = {
    emit() {}, on() { return () => {}; }, logger: { warn() {}, error() {} },
    storage: { backend: { get: () => backend } }, effect() {},
  };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const seeding = await ctx.storageDomain.open({ name: 'evolution_domain', version: 1, tables: {},
    global: { schema: evolutionDomainSpec.global.schema, initial: { schema: 1, aggregate: {}, applied: {}, pending: null } } });
  const staging = path.join(run.home, 'domain-staging');
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  const stageName = `stage-${crypto.randomUUID()}`;
  fs.renameSync(run.stage, path.join(staging, stageName));
  await seeding.global.set({
    schema: 1,
    aggregate: stagedState,
    applied: {},
    pending: { stage: stageName, aggregate: stagedState, applied: {}, files },
  });
  await seeding.close();
  return { ctx, staging, stageName, openDomainStorage,
    config: { presetDir: run.home, eventBridgePath: path.join(run.home, 'execution-events.jsonl'), eventBridgeKey: 'b'.repeat(64) } };
}

test('a committed pending record installs its deletions when a port opens, and replays as a no-op', async (t) => {
  const run = await stagedCompaction(t);
  const changed = changedArchiveFiles(run.stage, run.snapshot, run.root);
  const removal = changed.find(entry => entry.removed === true);
  assert.ok(removal);
  const live = path.join(run.root, ...removal.file.split('/'));
  // Publish exactly what a crash between the pending write and the install
  // leaves behind: the staged aggregate plus the durable file list.
  const { ctx, staging, stageName, openDomainStorage, config } = await seedPendingRecord(t, run, changed);
  const first = await openDomainStorage(ctx, config);
  const afterRecovery = ctx.storageDomain.get('evolution_domain').global.get();
  await first.close();
  assert.deepEqual(segmentNames(run.root), changed.filter(entry => entry.removed !== true)
    .filter(entry => entry.file.startsWith(`${OBSERVATION_SEGMENTS}/`))
    .map(entry => entry.file.split('/').pop()).sort(), 'the recovered install deleted the committed segments');
  assert.equal(fs.existsSync(live), false);
  assert.equal(afterRecovery.pending, null, 'the recovered transaction is closed');
  assert.equal(fs.existsSync(path.join(staging, stageName)), false, 'the recovered stage is removed after the install');
});

test('a pending deletion whose committed bytes no longer match is refused and preserves both sides', async (t) => {
  const run = await stagedCompaction(t);
  const changed = changedArchiveFiles(run.stage, run.snapshot, run.root);
  const removal = changed.find(entry => entry.removed === true);
  assert.ok(removal);
  const live = path.join(run.root, ...removal.file.split('/'));
  const original = fs.readFileSync(live);
  // The committed bytes changed after the record was written: deleting them now
  // would destroy bytes the transaction never proved replaceable.
  fs.writeFileSync(live, Buffer.concat([original, Buffer.from('\n')]));
  const { ctx, openDomainStorage, config } = await seedPendingRecord(t, run, changed);
  await assert.rejects(() => openDomainStorage(ctx, config), /E_DOMAIN_PENDING_ARCHIVE_CORRUPT/);
  assert.ok(fs.existsSync(live), 'the unproven segment is preserved so the change stays visible');
  const document = JSON.parse(fs.readFileSync(path.join(run.home, 'official', 'evolution_domain.json'), 'utf8'));
  assert.ok(document.global.pending, 'the refused recovery keeps the pending record instead of dropping it');
});

test('a seal temporary left in the segment directory neither blocks a reclaim nor gets deleted', async (t) => {
  const run = await stagedCompaction(t);
  // Reproduce the residue a crash between the seal write and its rename leaves:
  // no reader opens it, and a compaction replaces the directory it lives in.
  const residue = path.join(run.root, OBSERVATION_SEGMENTS, '.segment-11111111-2222-3333-4444-555555555555.tmp');
  fs.writeFileSync(residue, '{"torn":true}\n');
  fs.mkdirSync(path.join(run.stage, OBSERVATION_SEGMENTS), { recursive: true, mode: 0o700 });
  fs.copyFileSync(residue, path.join(run.stage, OBSERVATION_SEGMENTS, path.basename(residue)));
  // The stage as the compaction left it: the residue is gone with the directory.
  fs.rmSync(path.join(run.stage, OBSERVATION_SEGMENTS, path.basename(residue)));

  const changed = changedArchiveFiles(run.stage, run.snapshot, run.root);
  assert.equal(changed.some(entry => entry.file.endsWith('.tmp')), false, 'residue is never a change-list entry');
  assert.ok(changed.some(entry => entry.removed === true), 'the real deletions are still published');
  installArchiveFiles(run.stage, run.root, changed);
  assert.equal(fs.existsSync(residue), true, 'the residue is preserved: nothing proved its bytes replaceable');
});
