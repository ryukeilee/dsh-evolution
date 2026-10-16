// The promotion-journal phase classification is owned by the orchestrator, so
// recovery, the canary reader, and the doctor share one phase -> state table.
// This test proves that agreement and the fault it fixes: a journal whose phase
// is missing or unrecognised used to fall through recovery's catch-all
// `rollbackPromotionJournal` (deleting its state directory) and was treated as
// "no journal" by the canary reader, which then synthesized a fresh journal and
// overwrote or deleted the preserved evidence. The doctor already reported such
// a journal as blocked, with no repair offered. Now recovery and the canary
// reader refuse it with a clean Error and preserve the scene, and the doctor
// reports the same verdict.
//
// The orchestrator still writes the same legal phases as before: `prepared` /
// `committing` roll back, `canary-observing` stays pending,
// `stable-committed` / `committed` only clean up, `rollback-failed` blocks. The
// classification is consumed from the export, never re-declared here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { EvolutionOrchestrator, classifyPromotionJournal, recoverInterruptedPromotion, persistEvidenceSnapshot } from '../lib/orchestrator.js';
import { collectDiagnostics, runDiagnostics, applyRepairs, resolveEvolutionPaths } from '../lib/diagnostics.js';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function scratch(t, name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `evo-journal-phase-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function fixture(t, name) {
  const home = await scratch(t, name);
  const paths = resolveEvolutionPaths({ dshHome: home });
  await fs.mkdir(paths.promotionStateDir, { recursive: true, mode: 0o700 });
  return { home, paths };
}

async function writeRaw(paths, journal) {
  const file = path.join(paths.promotionStateDir, 'journal.json');
  await fs.writeFile(file, JSON.stringify(journal, null, 2));
  return file;
}

/** A boundary-legal journal for `phase`, written to disk. `records: []` keeps
 * every phase in this matrix outside the boundary rule so the test isolates
 * the phase classification. */
async function writePhaseJournal(paths, phase, index) {
  return writeRaw(paths, {
    version: 1,
    phase,
    experimentId: `exp-phase-${index}`,
    stateDir: paths.promotionStateDir,
    stageDir: path.join(paths.promotionStateDir, 'stage'),
    records: [],
  });
}

/** A boundary-legal journal with one real file change (target in its
 * "expectedAfter" state, a matching backup on disk) and a stage directory, so a
 * rollback would visibly destroy the scene if it ran. */
async function unknownPhaseScene(t, name, { phase = 'something-new', deletePhase = false } = {}) {
  const { home, paths } = await fixture(t, name);
  const target = path.join(paths.pluginRoot, 'promoted-plugin.txt');
  await fs.mkdir(path.dirname(target), { recursive: true });
  const before = 'before-bytes\n';
  const after = 'after-bytes\n';
  await fs.writeFile(target, after);
  const backup = `${'a'.repeat(16)}.bak`;
  await fs.mkdir(path.join(paths.promotionStateDir, 'backups'), { recursive: true, mode: 0o700 });
  const backupFile = path.join(paths.promotionStateDir, 'backups', backup);
  await fs.writeFile(backupFile, before);
  const stageDir = path.join(paths.promotionStateDir, 'stage');
  await fs.mkdir(stageDir, { recursive: true });
  const journal = {
    version: 1,
    experimentId: 'exp-unknown-phase',
    stateDir: paths.promotionStateDir,
    stageDir,
    records: [{ type: 'file', target, existed: true, backup, beforeDigest: sha256(before), expectedAfter: sha256(after) }],
  };
  if (!deletePhase) journal.phase = phase;
  const journalFile = await writeRaw(paths, journal);
  return { home, paths, journalFile, target, backupFile, stageDir, journal };
}

async function snapshot(files) {
  return Promise.all(files.map(async (file) => [file, await fs.readFile(file)]));
}

const exists = (file) => fs.access(file).then(() => true, () => false);

const DIFFERENTIAL_PHASES = ['prepared', 'committing', 'canary-observing', 'stable-committed', 'committed', 'rollback-failed', 'something-new', null, 42];

test('the shared classification agrees with the doctor for every phase; only rollback states offer a repair', async (t) => {
  for (const [index, phase] of DIFFERENTIAL_PHASES.entries()) {
    const { home, paths } = await fixture(t, `matrix-${index}`);
    const file = await writePhaseJournal(paths, phase, index);
    const journal = JSON.parse(await fs.readFile(file, 'utf8'));

    const classified = classifyPromotionJournal(journal, paths);
    assert.equal(classified.boundary, null, `phase ${JSON.stringify(phase)} must build a boundary-legal journal`);

    const report = await collectDiagnostics({ home: true, dshHome: home, probe: { skipComposition: true } });
    const check = report.checks.find((candidate) => candidate.id === 'promotion.journal');
    assert.equal(classified.state, check.evidence.state, `phase ${JSON.stringify(phase)}: the doctor must report the classifier's state`);
    assert.equal(check.evidence.phase, phase ?? null, `phase ${JSON.stringify(phase)}: the doctor must report the real phase`);
    assert.equal(check.evidence.boundary, null);

    if (phase === null || phase === 42 || phase === 'something-new') {
      assert.equal(classified.state, 'state-unknown', `phase ${JSON.stringify(phase)} must be state-unknown`);
    }

    const offersRepair = report.repairs.some((repair) => repair.id.startsWith('promotion-journal-'));
    const offersRecovery = classified.state === 'incomplete' || classified.state === 'committed-pending-cleanup';
    assert.equal(offersRepair, offersRecovery, `phase ${JSON.stringify(phase)}: a repair may only accompany a rollback-safe state`);
    assert.equal(await exists(file), true, 'the read-only doctor must never move the journal');
  }
});

test('an unknown or missing phase refuses recovery and preserves the entire scene, repeatedly', async (t) => {
  const cases = [
    { name: 'unknown', options: { phase: 'something-new' }, expect: /"something-new"/ },
    { name: 'deleted', options: { deletePhase: true }, expect: /phase null/ },
  ];
  for (const entry of cases) {
    const { paths, journalFile, target, backupFile, stageDir } = await unknownPhaseScene(t, `unknown-${entry.name}`, entry.options);
    const files = [journalFile, backupFile, target];
    const before = await snapshot(files);

    const journal = JSON.parse(await fs.readFile(journalFile, 'utf8'));
    const classified = classifyPromotionJournal(journal, paths);
    assert.equal(classified.state, 'state-unknown');
    assert.equal(classified.boundary, null);

    await assert.rejects(recoverInterruptedPromotion(paths), (error) => {
      assert.equal(error instanceof TypeError, false, 'a refusal must be a clean Error, not a crash');
      assert.match(error.message, /Evolution promotion journal recovery refused/);
      assert.match(error.message, /unrecognised promotion journal phase/);
      assert.match(error.message, entry.expect);
      assert.match(error.message, /journal preserved at/);
      return true;
    });

    assert.deepEqual(await snapshot(files), before, 'an unknown phase must leave the journal, backup and target byte-for-byte');
    assert.equal(await exists(stageDir), true, 'the stage directory must not be removed');

    // A second start must produce the same refusal and touch nothing.
    await assert.rejects(recoverInterruptedPromotion(paths), /unrecognised promotion journal phase/);
    assert.deepEqual(await snapshot(files), before);
    assert.equal(await exists(stageDir), true);
  }
});

test('the doctor repair path cannot roll back an unknown phase, even by repair id', async (t) => {
  const { home, paths, journalFile, target, backupFile } = await unknownPhaseScene(t, 'doctor-unknown', { phase: 'something-new' });
  const files = [journalFile, backupFile, target];
  const before = await snapshot(files);
  const options = { home: true, dshHome: home, probe: { skipComposition: true }, repair: true };

  const first = await runDiagnostics(options);
  assert.equal((first.repairsApplied || []).filter((applied) => applied.id.startsWith('promotion-journal-')).length, 0, 'the doctor must not apply a promotion-journal repair for an unknown phase');
  assert.deepEqual(await snapshot(files), before);

  const second = await runDiagnostics(options);
  assert.equal((second.repairsApplied || []).filter((applied) => applied.id.startsWith('promotion-journal-')).length, 0);
  assert.deepEqual(await snapshot(files), before);

  // The doctor never offers this repair for state-unknown, so drive it by id to
  // prove the entry point itself refuses instead of rolling back.
  const applied = await applyRepairs([{ id: 'promotion-journal-recover', safe: true }], { paths });
  assert.equal(applied.length, 1);
  assert.equal(applied[0].id, 'promotion-journal-recover');
  assert.equal(applied[0].status, 'failed', 'the refusal must be caught by applyRepairs, not thrown');
  assert.match(applied[0].detail, /unrecognised promotion journal phase/);
  assert.match(applied[0].detail, /"something-new"/);
  assert.deepEqual(await snapshot(files), before, 'a refused repair must leave every byte in place');
});

test('a refusal is not a poison: a legal phase after a refusal still rolls back', async (t) => {
  const { paths, journalFile, target } = await unknownPhaseScene(t, 'not-poison', { phase: 'something-new' });
  await assert.rejects(recoverInterruptedPromotion(paths), /unrecognised promotion journal phase/);

  const rewritten = JSON.parse(await fs.readFile(journalFile, 'utf8'));
  rewritten.phase = 'committing';
  await fs.writeFile(journalFile, JSON.stringify(rewritten, null, 2));

  const outcome = await recoverInterruptedPromotion(paths);
  assert.equal(outcome.status, 'rolled-back');
  assert.equal(await fs.readFile(target, 'utf8'), 'before-bytes\n', 'the target must be restored from its backup');
  assert.equal(await exists(paths.promotionStateDir), false, 'a completed rollback removes the state directory');
});

test('an unknown phase with an out-of-boundary record refuses with the shared boundary reason', async (t) => {
  const { home, paths } = await fixture(t, 'boundary-unknown');
  const journal = {
    version: 1,
    phase: 'something-new',
    experimentId: 'exp-boundary-unknown',
    stateDir: paths.promotionStateDir,
    records: [{ type: 'path', target: path.join(os.tmpdir(), 'evo-journal-phase-not-managed') }],
  };
  const journalFile = await writeRaw(paths, journal);
  const before = await fs.readFile(journalFile);

  const classified = classifyPromotionJournal(journal, paths);
  assert.equal(classified.state, 'state-unknown');
  assert.match(classified.boundary, /outside the configured roots/);

  await assert.rejects(recoverInterruptedPromotion(paths), (error) => {
    assert.equal(error instanceof TypeError, false);
    assert.equal(error.message, `Evolution promotion journal recovery refused: ${classified.boundary}`);
    return true;
  });

  const report = await collectDiagnostics({ home: true, dshHome: home, probe: { skipComposition: true } });
  const check = report.checks.find((candidate) => candidate.id === 'promotion.journal');
  assert.equal(check.evidence.state, 'state-unknown');
  assert.equal(check.evidence.boundary, classified.boundary, 'the doctor must refuse for the boundary reason, not the phase');
  assert.match(check.summary, /outside the configured roots/);
  assert.equal(check.recoverable, false);
  assert.equal(report.repairs.some((repair) => repair.id.startsWith('promotion-journal-')), false);
  assert.deepEqual(await fs.readFile(journalFile), before, 'the journal must be preserved');
});

// ---------------------------------------------------------------------------
// canary reader: a blocked journal must not be treated as "no journal"
// ---------------------------------------------------------------------------

/**
 * A real orchestrator with a real unknown/blocked journal on disk under
 * `<presetDir>/.evolution-promotion/`, a matching durable canary sidecar, and a
 * live in-memory record. The sidecar's `canary.healthObservationWindow` drives
 * the pre-fix synthesized journal (the record is seeded without `canary`, so
 * `hydrateRecordFromSnapshot` fills it from the sidecar), which lets each case
 * reach its destructive outcome.
 */
async function canaryScene(t, name, { phase = 'something-new', deletePhase = false, canaryWindow = 5 } = {}) {
  const presetDir = await scratch(t, name);
  const ctx = { registry: { values: () => [] }, logger: { warn() {} }, emit() {} };
  ctx.dynamicCordisRunner = { snapshot: () => [] };
  // eventBridgePath and driftStatePath default to the real user home, so an
  // isolated fixture must point every reader inside the scratch directory.
  const core = new EvolutionOrchestrator(ctx, {
    presetDir,
    startupDrift: false,
    eventBridge: { emit: () => ({}) },
    eventBridgePath: path.join(presetDir, 'evolution-events.jsonl'),
    driftStatePath: path.join(presetDir, 'startup-drift.json'),
  });
  const paths = core.paths;
  const experimentId = 'exp-canary-blocked';
  const owner = 'canary-owner';

  const target = path.join(paths.pluginRoot, 'promoted-plugin.txt');
  await fs.mkdir(path.dirname(target), { recursive: true });
  const before = 'before-bytes\n';
  const after = 'after-bytes\n';
  await fs.writeFile(target, after);
  const backup = `${'a'.repeat(16)}.bak`;
  await fs.mkdir(path.join(paths.promotionStateDir, 'backups'), { recursive: true, mode: 0o700 });
  const backupFile = path.join(paths.promotionStateDir, 'backups', backup);
  await fs.writeFile(backupFile, before);
  const stageDir = path.join(paths.promotionStateDir, 'stage');
  await fs.mkdir(stageDir, { recursive: true });
  const journal = {
    version: 1,
    experimentId,
    ownerId: owner,
    stateDir: paths.promotionStateDir,
    stageDir,
    records: [{ type: 'file', target, existed: true, backup, beforeDigest: sha256(before), expectedAfter: sha256(after) }],
  };
  if (!deletePhase) journal.phase = phase;
  const journalFile = path.join(paths.promotionStateDir, 'journal.json');
  await fs.writeFile(journalFile, JSON.stringify(journal, null, 2));

  core.experiments.set(experimentId, {
    id: experimentId,
    ownerId: owner,
    proposal: { owner, why: 'canary', target: 'plugin:x', impactScope: ['runtime'], successMetrics: ['m'], createdAt: new Date().toISOString() },
    targets: [],
    state: 'canary-observing',
  });
  await persistEvidenceSnapshot(paths.archiveDir, experimentId, {
    version: 1,
    source: 'test-sidecar',
    capturedAt: new Date().toISOString(),
    observations: [],
    latestObservation: null,
    canary: { promotionTimestamp: null, healthObservationWindow: canaryWindow, startupVerified: false, observations: [] },
    ownerId: owner,
  });

  const exec = { agent: { id: owner }, signal: new AbortController().signal };
  return { core, presetDir, paths, journalFile, target, backupFile, stageDir, exec, experimentId };
}

function refusal(error) {
  assert.equal(error instanceof TypeError, false, 'a refusal must be a clean Error, not a crash');
  assert.match(error.message, /unrecognised promotion journal phase|rollback is incomplete/);
  return true;
}

const CANARY_CASES = [
  { name: 'unknown phase, pending write', options: { phase: 'something-new', canaryWindow: 5 }, args: { startupVerified: true, barrier: { id: 'b1', reached: true } } },
  { name: 'unknown phase, stable complete', options: { phase: 'something-new', canaryWindow: 1 }, args: { startupVerified: true, barrier: { id: 'b1', reached: true } } },
  { name: 'unknown phase, regression', options: { phase: 'something-new', canaryWindow: 5 }, args: { metricRegression: true, barrier: { id: 'b1', reached: true } } },
  { name: 'missing phase key', options: { deletePhase: true, canaryWindow: 1 }, args: { startupVerified: true, barrier: { id: 'b1', reached: true } } },
  { name: 'rollback-failed phase', options: { phase: 'rollback-failed', canaryWindow: 1 }, args: { startupVerified: true, barrier: { id: 'b1', reached: true } } },
];

test('the canary reader refuses a blocked journal instead of synthesizing over it', async (t) => {
  for (const [index, entry] of CANARY_CASES.entries()) {
    const { core, journalFile, target, backupFile, stageDir, exec, experimentId } = await canaryScene(t, `canary-${index}`, entry.options);
    const files = [journalFile, backupFile, target];
    const before = await snapshot(files);
    const args = { experimentId, componentHealth: 'healthy', dependenciesPresent: true, ...entry.args };

    await assert.rejects(core.observeCanary(args, exec), refusal);
    assert.deepEqual(await snapshot(files), before, `${entry.name}: journal, backup and target must stay byte-for-byte`);
    assert.equal(await exists(stageDir), true, `${entry.name}: the stage directory must survive`);

    // A second observation must refuse identically and touch nothing.
    await assert.rejects(core.observeCanary(args, exec), refusal);
    assert.deepEqual(await snapshot(files), before);
    assert.equal(await exists(stageDir), true);
  }
});
