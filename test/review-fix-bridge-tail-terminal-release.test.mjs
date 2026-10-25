// Regressions for the review round that found the event-bridge tail glue, the
// success-path claim leaks, the cross-process experiment id collision and the
// self-asserted canary owner flag.
//
// Each case fails on the pre-fix tree for the reason named in its comment and
// passes after the root fix; the pre-fix reproductions are recorded in the
// review evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  EvolutionEventBridge, EvolutionOrchestrator, persistEvidenceSnapshot,
  writeDurablePromotion, recoverStalePromotionLock,
} from '../lib/orchestrator.js';
import {
  scratchRoot, promotionPaths, unitPromotionRuntime, promotionExperiment, HOST_CODE,
  orchestratorContext, execFor, exists,
} from './orchestrator-durability-fixtures.mjs';
import { promotionPlan, derivedPluginName, derivedPluginPath } from './promotion-plan-fixture.mjs';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// ---------------------------------------------------------------------------
// 1. event bridge: a complete tail without its newline must not swallow the
//    next record. Pre-fix both records shared one line, and the next startup
//    refused the unparseable log.
// ---------------------------------------------------------------------------
test('an unterminated but complete event-bridge tail gets its separator before the next append', async (t) => {
  const root = await scratchRoot('bridge-tail');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'events.jsonl');
  const key = 'e'.repeat(64);
  const open = () => new EvolutionEventBridge({ file, key, writer: 'harness' });

  open().emit('proposal-created', { id: 'exp-tail-a', proposal: { target: 'a' } }, { experimentId: 'exp-tail-a' });
  const complete = await fsp.readFile(file, 'utf8');
  assert.ok(complete.endsWith('\n'));
  // The crash window: every byte of the signed record reached the file, the
  // trailing newline did not.
  await fsp.writeFile(file, complete.slice(0, -1));

  open().emit('measurement-completed', { id: 'exp-tail-b', proposal: { target: 'b' } }, { experimentId: 'exp-tail-b' });

  const after = await fsp.readFile(file, 'utf8');
  const lines = after.split('\n').filter((line) => line.trim() !== '');
  assert.equal(lines.length, 2, 'two records, two lines');
  assert.equal(lines[0], complete.slice(0, -1), 'the interrupted record is preserved byte for byte');
  assert.equal(JSON.parse(lines[1]).event.eventId, 'evolution:measurement-completed:exp-tail-b');
});

test('a torn tail is refused instead of being glued or split into two invalid lines', async (t) => {
  const root = await scratchRoot('bridge-torn');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'events.jsonl');
  const key = 'e'.repeat(64);
  const bridge = new EvolutionEventBridge({ file, key, writer: 'harness' });
  bridge.emit('proposal-created', { id: 'exp-torn', proposal: { target: 'a' } }, { experimentId: 'exp-torn' });
  const complete = await fsp.readFile(file, 'utf8');
  // A record cut in the middle is not a record. Appending either glues it
  // (one invalid line, event lost) or splits it (no unterminated tail left for
  // the doctor's trim repair), so the writer fails closed and leaves the torn
  // tail exactly where the repair can still see it.
  await fsp.writeFile(file, complete.slice(0, -3));
  const torn = await fsp.readFile(file, 'utf8');
  const again = new EvolutionEventBridge({ file, key, writer: 'harness' });
  assert.throws(
    () => again.emit('proposal-created', { id: 'exp-torn', proposal: { target: 'a' } }, { experimentId: 'exp-torn' }),
    /incomplete or unverified record/,
  );
  assert.equal(await fsp.readFile(file, 'utf8'), torn, 'the torn tail is left untouched for the repair');
});

// ---------------------------------------------------------------------------
// 2. the stable canary commit releases its target even when the terminal
//    archive write fails. Pre-fix `releaseTargets` sat after the fallible
//    archive/event writes, so the claim survived a durable commit.
// ---------------------------------------------------------------------------
const CANARY_EXPERIMENT = 'exp-canary-release';
const CANARY_OWNER = 'release-owner';
const CANARY_TARGET = 'plugin:canary-release';

function canaryConfig(root) {
  return {
    presetDir: root,
    startupDrift: false,
    eventBridge: { emit: () => ({}) },
    eventBridgePath: path.join(root, 'events.jsonl'),
    eventBridgeKey: 'k'.repeat(32),
    driftStatePath: path.join(root, 'drift.json'),
    memoryPath: path.join(root, 'memory.json'),
    promotionRuntime: unitPromotionRuntime(),
  };
}

async function stableCanaryScene(t, name) {
  const root = await scratchRoot(name);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const paths = canaryConfig(root);
  const ctx = orchestratorContext();
  ctx.dynamicCordisRunner = { snapshot: () => [] };
  const core = new EvolutionOrchestrator(ctx, paths);
  const pluginPath = derivedPluginPath(core.paths, CANARY_EXPERIMENT);
  await fsp.mkdir(core.paths.promotionStateDir, { recursive: true });
  await fsp.mkdir(path.join(core.paths.promotionStateDir, 'stage'), { recursive: true });
  const durable = {
    pluginName: derivedPluginName(CANARY_EXPERIMENT), pluginPath,
    rowId: 'evolution-promoted-owner', archivePath: path.join(core.paths.archiveDir, `${CANARY_EXPERIMENT}.md`),
    presetId: 'evolution', promotionTimestamp: '2026-01-01T00:00:00.000Z',
  };
  await fsp.mkdir(core.paths.archiveDir, { recursive: true });
  await persistEvidenceSnapshot(core.paths.archiveDir, CANARY_EXPERIMENT, {
    version: 1, source: 'test-sidecar', capturedAt: '2026-01-02T00:00:00.000Z',
    observations: [{ solvesProblem: true }],
    latestObservation: { solvesProblem: true, regressionPassed: true },
    cleanupProof: { status: 'recovered' },
    recoveryProof: { status: 'recovered' },
    runtimeRecovered: true, durable,
    canary: { promotionTimestamp: '2026-01-01T00:00:00.000Z', healthObservationWindow: 1, startupVerified: true, observations: [] },
    ownerId: CANARY_OWNER,
    proposal: { owner: CANARY_OWNER, why: 'canary', target: CANARY_TARGET, impactScope: ['runtime'], successMetrics: ['m'], createdAt: '2026-01-01T00:00:00.000Z' },
  });
  await fsp.writeFile(path.join(core.paths.promotionStateDir, 'journal.json'), JSON.stringify({
    version: 1, phase: 'canary-observing', experimentId: CANARY_EXPERIMENT,
    ownerId: CANARY_OWNER, proposal: { owner: CANARY_OWNER, why: 'canary', target: CANARY_TARGET, impactScope: ['runtime'], successMetrics: ['m'], createdAt: '2026-01-01T00:00:00.000Z' },
    targets: [CANARY_TARGET], stateDir: core.paths.promotionStateDir,
    stageDir: path.join(core.paths.promotionStateDir, 'stage'),
    records: promotionPlan(core.paths, CANARY_EXPERIMENT),
    durable,
    canary: { promotionTimestamp: '2026-01-01T00:00:00.000Z', healthObservationWindow: 1, startupVerified: true, observations: [] },
  }, null, 2));
  return { root, core, pluginPath };
}

test('a stable canary commit releases its target when the archive write fails', async (t) => {
  const { core } = await stableCanaryScene(t, 'canary-release');
  const claimFile = path.join(core.paths.ownershipDir, `${sha256(CANARY_TARGET)}.json`);
  // Make only the terminal markdown write fail: the evidence sidecar and the
  // journal removal (both before it) still succeed, so the promotion is durable
  // and terminal when the archive throws.
  const archiveFile = path.join(core.paths.archiveDir, `${CANARY_EXPERIMENT}.md`);
  await fsp.mkdir(archiveFile, { recursive: true });

  const result = core.observeCanary({
    experimentId: CANARY_EXPERIMENT,
    startupVerified: true,
    componentHealth: 'healthy',
    dependenciesPresent: true,
    metricRegression: false,
    barrier: { id: 'barrier:release', reached: true },
  }, execFor(CANARY_OWNER));

  await assert.rejects(result);
  assert.equal(await exists(claimFile), false, 'the target claim of a durable commit is released');
  assert.equal(core.targetOwners.has(CANARY_TARGET), false, 'the in-process owner map is released');
});

// ---------------------------------------------------------------------------
// 3. the promote success path releases its operation claim even when the
//    success event cannot be written. Pre-fix the claim stayed behind and every
//    later operation on the record reported "busy with promote" until restart.
// ---------------------------------------------------------------------------
test('a durable promotion does not stay busy when its success event fails', async (t) => {
  const root = await scratchRoot('promote-claim');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const paths = { ...promotionPaths(root), startupDrift: false, promotionRuntime: unitPromotionRuntime() };
  await fsp.writeFile(paths.compositionPath, '[]\n');
  const ctx = orchestratorContext();
  ctx.dynamicCordisRunner = {
    snapshot: () => [],
    inspectPackage: () => ({ code: { host: HOST_CODE } }),
    stop: async () => ({ ok: true }),
    undefine: async () => ({ ok: true }),
  };
  const core = new EvolutionOrchestrator(ctx, paths);
  const exec = execFor('durability-owner');
  const proposal = core.propose({ why: 'claim release', target: 'plugin:claim', impactScope: ['runtime'], successMetrics: ['s'] }, exec);
  const record = core.experiments.get(proposal.experimentId);
  record.state = 'trial';
  record.pluginId = 'plugin-claim';
  record.packageId = 'package-claim';
  record.targets = ['plugin:claim'];
  core.acquireTargets(record);
  core.measure({
    experimentId: record.id,
    observation: {
      solvesProblem: true,
      metrics: { latencyMs: 10 },
      beforeMetrics: { latencyMs: 20 },
      afterMetrics: { latencyMs: 10 },
      observationWindow: '5m',
      sampleCount: 5,
      repeatable: true,
      regressionPassed: true,
      reversible: true,
      cleanupEvidence: 'disposed trial',
      orphanResources: [],
    },
  }, exec);
  // Only the success event fails; the durable promotion itself is complete.
  core.eventBridge = { emit() { throw new Error('EIO'); } };

  const result = await core.promote({ experimentId: record.id, confirmation: true }, exec);
  assert.equal(result.ok, true, 'the durable promotion is reported as successful');
  assert.equal(result.phase, 'canary-observing');
  assert.equal(core.operationClaims.has(record.id), false, 'the operation claim is released');
  assert.equal(record.eventBridgeWarning, 'EIO', 'the failed event is reported as a warning, not a promotion failure');
  assert.doesNotThrow(() => core.claimOperation(record, 'canary'));
  core.releaseOperation(record);
});

// ---------------------------------------------------------------------------
// 4. two instances creating their first proposal in the same millisecond must
//    not produce one experiment id. Pre-fix the id was `exp-<ms>-<sequence>`
//    with a per-process sequence, and a claim is adopted by id, so two
//    experiments could share a target and one archive file.
// ---------------------------------------------------------------------------
test('two instances in the same millisecond produce distinct experiment ids', async (t) => {
  const root = await scratchRoot('id-collision');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const make = (name) => new EvolutionOrchestrator(orchestratorContext(), {
    ...promotionPaths(path.join(root, name)), startupDrift: false,
  });
  const first = make('a');
  const second = make('b');
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    const one = first.propose({ why: 'id', target: 'plugin:id-a', impactScope: ['runtime'], successMetrics: ['s'] }, execFor('owner-a'));
    const two = second.propose({ why: 'id', target: 'plugin:id-b', impactScope: ['runtime'], successMetrics: ['s'] }, execFor('owner-b'));
    assert.notEqual(one.experimentId, two.experimentId);
    assert.match(one.experimentId, /^exp-[a-z0-9]+-[a-z0-9]+-[0-9a-f]{8}$/);
    assert.match(two.experimentId, /^exp-[a-z0-9]+-[a-z0-9]+-[0-9a-f]{8}$/);
  } finally {
    Date.now = realNow;
  }
});

// ---------------------------------------------------------------------------
// 5. the startup transition is module-private: passing it as a tool argument
//    must not take over another session's canary.
// ---------------------------------------------------------------------------
test('an undeclared startupTransition argument cannot take over the canary owner', async (t) => {
  const { core } = await stableCanaryScene(t, 'canary-owner-flag');
  const journalFile = path.join(core.paths.promotionStateDir, 'journal.json');
  const before = await fsp.readFile(journalFile, 'utf8');

  await assert.rejects(
    core.observeCanary({
      experimentId: CANARY_EXPERIMENT,
      startupVerified: true,
      componentHealth: 'healthy',
      dependenciesPresent: true,
      metricRegression: false,
      barrier: { id: 'barrier:intruder', reached: true },
      startupTransition: true,
    }, execFor('intruder-agent')),
    /owned by another Agent/,
  );
  assert.equal(await fsp.readFile(journalFile, 'utf8'), before, 'the refused caller leaves the journal untouched');
});

// ---------------------------------------------------------------------------
// 6. promotion lock residue. Pre-fix a failed metadata write left an unusable
//    lock for the full TTL, and a failed cleanup left a same-PID lock that was
//    treated as a live owner until the process exited.
// ---------------------------------------------------------------------------
test('a promotion lock whose metadata cannot be written is removed, not left to block the next run', async (t) => {
  const root = await scratchRoot('lock-metadata');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const paths = promotionPaths(root);
  await fsp.writeFile(paths.compositionPath, '[]\n');
  paths.promotionRuntime = unitPromotionRuntime();
  const originalRename = fsp.rename;
  fsp.rename = async function observed(from, to) {
    if (String(to) === path.join(paths.promotionLockPath, 'lock.json')) {
      const error = new Error('simulated metadata write failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRename.call(this, from, to);
  };
  try {
    await assert.rejects(
      writeDurablePromotion({ experiment: promotionExperiment('exp-lock-a'), paths, packageInspection: { code: { host: HOST_CODE } } }),
      /simulated metadata write failure/,
    );
  } finally {
    fsp.rename = originalRename;
  }
  assert.equal(await exists(paths.promotionLockPath), false, 'the call removed the lock it created');

  const durable = await writeDurablePromotion({ experiment: promotionExperiment('exp-lock-b'), paths, packageInspection: { code: { host: HOST_CODE } } });
  assert.ok(durable.journalPath, 'the next promotion is not blocked');
});

test('a promotion lock left behind by a failed cleanup is reclaimed by the same process', async (t) => {
  const root = await scratchRoot('lock-residue');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const paths = promotionPaths(root);
  await fsp.writeFile(paths.compositionPath, '[]\n');
  paths.promotionRuntime = unitPromotionRuntime();
  let failedOnce = false;
  const originalRm = fsp.rm;
  fsp.rm = async function observed(target, options) {
    if (!failedOnce && String(target) === paths.promotionLockPath) {
      failedOnce = true;
      const error = new Error('simulated cleanup failure');
      error.code = 'EBUSY';
      throw error;
    }
    return originalRm.call(this, target, options);
  };
  try {
    const durable = await writeDurablePromotion({ experiment: promotionExperiment('exp-lock-c'), paths, packageInspection: { code: { host: HOST_CODE } } });
    assert.ok(durable.journalPath, 'the promotion itself succeeded');
  } finally {
    fsp.rm = originalRm;
  }
  assert.equal(await exists(paths.promotionLockPath), true, 'the failed removal left the lock behind');
  const reclaimed = await recoverStalePromotionLock({ lockPath: paths.promotionLockPath });
  assert.equal(reclaimed.status, 'stale-recovered', 'own same-PID residue is not treated as a live owner');
  assert.equal(await exists(paths.promotionLockPath), false);
});

// ---------------------------------------------------------------------------
// 7. the rollback backups are durable before the journal that names them.
//    Pre-fix they were `copyFile`d with no fsync of the bytes or the directory.
// ---------------------------------------------------------------------------
test('promotion backups are fsynced before the journal is committed', async (t) => {
  const root = await scratchRoot('backup-fsync');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const paths = promotionPaths(root);
  await fsp.writeFile(paths.compositionPath, '[]\n');
  await fsp.writeFile(paths.evolutionPath, '# pointer\n');
  paths.promotionRuntime = unitPromotionRuntime();

  const fdPaths = new Map();
  const fsynced = [];
  const originalOpenSync = fs.openSync;
  const originalFsyncSync = fs.fsyncSync;
  fs.openSync = function observedOpenSync(file, flags, mode) {
    const descriptor = originalOpenSync.call(this, file, flags, mode);
    fdPaths.set(descriptor, String(file));
    return descriptor;
  };
  fs.fsyncSync = function observedFsyncSync(descriptor) {
    fsynced.push(fdPaths.get(descriptor) ?? 'unknown');
    return originalFsyncSync.call(this, descriptor);
  };
  try {
    await writeDurablePromotion({ experiment: promotionExperiment('exp-backup'), paths, packageInspection: { code: { host: HOST_CODE } } });
  } finally {
    fs.openSync = originalOpenSync;
    fs.fsyncSync = originalFsyncSync;
  }
  const backupsDir = path.join(paths.promotionStateDir, 'backups');
  assert.ok(fsynced.includes(backupsDir), `the backups directory entry is fsynced: ${JSON.stringify(fsynced)}`);
  assert.ok(
    fsynced.some((file) => file.startsWith(`${backupsDir}${path.sep}`)),
    `the backup bytes are fsynced through the durable writer: ${JSON.stringify(fsynced)}`,
  );

  const journal = JSON.parse(await fsp.readFile(path.join(paths.promotionStateDir, 'journal.json'), 'utf8'));
  const fileRecords = journal.records.filter((record) => record.type === 'file' && record.existed);
  assert.ok(fileRecords.length > 0);
  for (const record of fileRecords) {
    const backup = await fsp.readFile(path.join(backupsDir, record.backup), 'utf8');
    assert.equal(sha256(backup), record.beforeDigest, `the journal digest describes the backup bytes: ${record.target}`);
    assert.notEqual(record.expectedAfter, record.beforeDigest, 'the plan changed the file');
  }
});

test('a promotion lock being written is never mistaken for residue by a concurrent call', async (t) => {
  const root = await scratchRoot('lock-window');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const paths = promotionPaths(root);
  await fsp.writeFile(paths.compositionPath, '[]\n');
  paths.promotionRuntime = unitPromotionRuntime();

  let observedDuringWrite = null;
  const lockFile = path.join(paths.promotionLockPath, 'lock.json');
  const originalRename = fsp.rename;
  fsp.rename = async function observed(from, to) {
    const result = await originalRename.call(this, from, to);
    if (observedDuringWrite === null && String(to) === lockFile) {
      // Immediately after the metadata lands, before `writeAtomic` returns to
      // the promotion that owns it: a second call in this process must see the
      // owner as active. Pre-fix the token was registered only after the write
      // returned, so this recovery renamed the live lock away and a second
      // promotion could start.
      observedDuringWrite = await recoverStalePromotionLock({ lockPath: paths.promotionLockPath });
    }
    return result;
  };
  try {
    const durable = await writeDurablePromotion({ experiment: promotionExperiment('exp-lock-window'), paths, packageInspection: { code: { host: HOST_CODE } } });
    assert.ok(durable.journalPath);
  } finally {
    fsp.rename = originalRename;
  }
  assert.equal(observedDuringWrite?.status, 'active', 'the live lock is not reclaimable while its own call holds the token');
  assert.equal(await exists(paths.promotionLockPath), false, 'the promotion cleaned its lock');
});

test('two concurrent promotions in one process cannot both hold the commit target', async (t) => {
  const root = await scratchRoot('lock-concurrent');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const paths = promotionPaths(root);
  await fsp.writeFile(paths.compositionPath, '[]\n');
  paths.promotionRuntime = unitPromotionRuntime();
  const options = (id) => ({ experiment: promotionExperiment(id), paths, packageInspection: { code: { host: HOST_CODE } } });
  const results = await Promise.allSettled([
    writeDurablePromotion(options('exp-concurrent-a')),
    writeDurablePromotion(options('exp-concurrent-b')),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.match(String(rejected.reason?.message), /another Evolution promotion owns the composition commit target/);
});

// ---------------------------------------------------------------------------
// 8. appends are serialized across processes: the tail verification and the
//    multi-call write must not interleave with another writer.
// ---------------------------------------------------------------------------
test('an append removes its short-lived lock', async (t) => {
  const root = await scratchRoot('bridge-lock-normal');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'events.jsonl');
  const bridge = new EvolutionEventBridge({ file, key: 'e'.repeat(64), writer: 'harness' });
  bridge.emit('proposal-created', { id: 'exp-lock', proposal: { target: 'a' } }, { experimentId: 'exp-lock' });
  assert.equal(await exists(`${file}.append.lock`), false);
});

test('a fresh foreign append lock is waited on and then refused without writing', async (t) => {
  const root = await scratchRoot('bridge-lock-held');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'events.jsonl');
  const bridge = new EvolutionEventBridge({ file, key: 'e'.repeat(64), writer: 'harness' });
  bridge.emit('proposal-created', { id: 'exp-first', proposal: { target: 'a' } }, { experimentId: 'exp-first' });
  const before = await fsp.readFile(file, 'utf8');
  const lockPath = `${file}.append.lock`;
  await fsp.mkdir(lockPath, { mode: 0o700 });
  await fsp.writeFile(path.join(lockPath, 'owner'), 'other-writer');
  const startedAt = Date.now();
  assert.throws(
    () => bridge.emit('proposal-created', { id: 'exp-second', proposal: { target: 'b' } }, { experimentId: 'exp-second' }),
    /append lock is held/,
  );
  assert.ok(Date.now() - startedAt >= 400, 'the writer retried instead of failing on the first look');
  assert.equal(await fsp.readFile(file, 'utf8'), before, 'a refused append writes nothing');
});

test('a stale append lock from a crashed writer is reclaimed', async (t) => {
  const root = await scratchRoot('bridge-lock-stale');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'events.jsonl');
  const lockPath = `${file}.append.lock`;
  await fsp.mkdir(lockPath, { mode: 0o700 });
  await fsp.writeFile(path.join(lockPath, 'owner'), 'crashed-writer');
  const old = new Date(Date.now() - 60_000);
  await fsp.utimes(lockPath, old, old);
  const bridge = new EvolutionEventBridge({ file, key: 'e'.repeat(64), writer: 'harness' });
  bridge.emit('proposal-created', { id: 'exp-stale', proposal: { target: 'a' } }, { experimentId: 'exp-stale' });
  const lines = (await fsp.readFile(file, 'utf8')).split('\n').filter((line) => line.trim() !== '');
  assert.equal(lines.length, 1);
  assert.equal(await exists(lockPath), false, 'the reclaimed marker is not left behind');
});

test('two processes appending concurrently produce only parseable records', async (t) => {
  const root = await scratchRoot('bridge-lock-procs');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'events.jsonl');
  const key = 'e'.repeat(64);
  const script = path.join(root, 'writer.mjs');
  const moduleUrl = new URL('../lib/orchestrator.js', import.meta.url).href;
  await fsp.writeFile(script, [
    `import { EvolutionEventBridge } from ${JSON.stringify(moduleUrl)};`,
    'const [file, key, id] = process.argv.slice(2);',
    "const bridge = new EvolutionEventBridge({ file, key, writer: 'harness' });",
    'for (let index = 0; index < 10; index += 1) {',
    "  bridge.emit('proposal-created', { id: `${id}-${index}` }, { experimentId: `${id}-${index}` });",
    '}',
    '',
  ].join('\n'));
  const { spawn } = await import('node:child_process');
  const run = (id) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, file, key, id], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${id} exited ${code}: ${stderr}`))));
  });
  await Promise.all([run('p1'), run('p2')]);
  const lines = (await fsp.readFile(file, 'utf8')).split('\n').filter((line) => line.trim() !== '');
  assert.equal(lines.length, 20, 'every append produced one line');
  const ids = new Set();
  for (const line of lines) ids.add(JSON.parse(line).event.eventId);
  assert.equal(ids.size, 20, 'every record parses and is distinct');
});


test('a reclaimer that moves a fresh lock instead of the stale one puts it back', async (t) => {
  const root = await scratchRoot('bridge-lock-reclaim-race');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'events.jsonl');
  const lockPath = `${file}.append.lock`;
  await fsp.mkdir(lockPath, { mode: 0o700 });
  await fsp.writeFile(path.join(lockPath, 'owner'), 'crashed-writer');
  const old = new Date(Date.now() - 60_000);
  await fsp.utimes(lockPath, old, old);

  // Swap the stale marker for a fresh one in the instant between the stale
  // decision and the atomic move. Pre-fix (delete by path) the new owner's lock
  // was removed; the rename-and-verify path must put it back.
  const fsSync = (await import('node:fs')).default;
  const originalRename = fsSync.renameSync;
  let replaced = false;
  fsSync.renameSync = function observedRename(from, to) {
    if (!replaced && String(from) === lockPath && String(to).endsWith('.stale')) {
      replaced = true;
      fsSync.rmSync(lockPath, { recursive: true, force: true });
      fsSync.mkdirSync(lockPath, { mode: 0o700 });
      fsSync.writeFileSync(path.join(lockPath, 'owner'), 'fresh-owner');
    }
    return originalRename.call(this, from, to);
  };
  try {
    const bridge = new EvolutionEventBridge({ file, key: 'e'.repeat(64), writer: 'harness' });
    assert.throws(
      () => bridge.emit('proposal-created', { id: 'exp-race', proposal: { target: 'a' } }, { experimentId: 'exp-race' }),
      /append lock is held/,
    );
  } finally {
    fsSync.renameSync = originalRename;
  }
  assert.equal(replaced, true, 'the replacement happened inside the reclaim path');
  assert.equal(await exists(lockPath), true, 'the fresh owner lock is not deleted');
  assert.equal(await fsp.readFile(path.join(lockPath, 'owner'), 'utf8'), 'fresh-owner');
  assert.equal(await exists(`${lockPath}.${process.pid}-`), false);
});
