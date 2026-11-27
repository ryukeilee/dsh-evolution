// DSH-EVOLUTION-CHAIN-GAP-01 / P2: a canary rollback can finish on disk and be
// followed by a crash before any conclusion or archive was written. The durable
// rollback receipt written before the journal is removed must let a fresh
// process rebuild the terminal state and report the rollback; `rollback-failed`
// must still keep its journal and produce no such receipt.
//
// Synthetic fixtures only (os.tmpdir()); no real DSH home is read or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  EvolutionOrchestrator,
  recoverInterruptedPromotion,
  readEvidenceSnapshot,
  snapshotEvidenceFromRecord,
} from '../lib/orchestrator.js';
import { openSharedExperience } from '../lib/shared-experience.js';
import { collectDiagnostics, resolveEvolutionPaths, summarize } from '../lib/diagnostics.js';
import { strategyFingerprint } from '../lib/experience-plan.js';
import {
  scratchRoot, promotionPaths, orchestratorContext, unitPromotionRuntime,
  execFor, writeJournal, readJournal, exists,
} from './orchestrator-durability-fixtures.mjs';
import { promotionPlan, derivedPluginName } from './promotion-plan-fixture.mjs';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'chain-gap-01-rollback-worker.mjs');
const EXPERIMENT = 'exp-chain-gap-01';
const APPLICABILITY = Object.freeze({ dsh: '0.2.23', cordis: '4.1.0', evolution: '0.2.23' });
const TARGET = 'tool:chain-gap-01';
const STRATEGY = 'prewarm the cache before the first read';
const FINGERPRINT = strategyFingerprint(TARGET, STRATEGY);

async function scene(t, { corruptBackup = false } = {}) {
  const root = await scratchRoot('chain-gap-rollback');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = promotionPaths(root);
  paths.promotionRuntime = unitPromotionRuntime();
  const pluginName = derivedPluginName(EXPERIMENT);
  const pluginPath = path.join(paths.pluginRoot, pluginName);
  await fs.mkdir(pluginPath, { recursive: true });
  await fs.mkdir(paths.archiveDir, { recursive: true });
  await fs.mkdir(path.join(paths.promotionStateDir, 'backups'), { recursive: true });
  const rowId = `evolution-promoted-${pluginName.slice(-12)}`;
  const row = `- id: ${rowId}\n  name: "file://${pluginPath}"\n`;
  await fs.writeFile(paths.compositionPath, row);
  const records = promotionPlan(paths, EXPERIMENT, {
    [paths.compositionPath]: { existed: true, before: '[]\n', after: row },
  });
  await fs.writeFile(path.join(paths.promotionStateDir, 'backups', records[0].backup), corruptBackup ? 'corrupt\n' : '[]\n');
  const proposal = {
    owner: 'durability-owner', why: 'rollback crash window', target: TARGET,
    strategy: STRATEGY, strategyFingerprint: FINGERPRINT, applicability: APPLICABILITY,
    impactScope: ['isolated-test'], successMetrics: ['regression recorded'],
    createdAt: '2026-11-27T00:00:00.000Z',
  };
  const record = {
    id: EXPERIMENT, ownerId: 'durability-owner', proposal, observations: [], latestObservation: {},
    runtimeRecovered: true,
  };
  const journal = {
    version: 1,
    phase: 'canary-observing',
    experimentId: EXPERIMENT,
    ownerId: 'durability-owner',
    proposal,
    stateDir: paths.promotionStateDir,
    records,
    evidenceSnapshot: snapshotEvidenceFromRecord(record),
    canary: { promotionTimestamp: null, healthObservationWindow: 2, startupVerified: false, observations: [] },
    durable: { pluginName, pluginPath, rowId },
  };
  await writeJournal(paths, journal);
  const store = openSharedExperience(path.join(root, 'shared-experience'));
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  return { root, paths, store, proposal };
}

function orchestratorFor(env, warnings = []) {
  return new EvolutionOrchestrator(orchestratorContext(warnings), {
    ...env.paths, startupDrift: false, sharedExperience: env.store,
    eventBridge: { emit: () => ({}) },
  });
}

function findConclusion(env) {
  return env.store.findConclusions({
    target: TARGET, strategyFingerprint: FINGERPRINT, applicability: APPLICABILITY,
  });
}

const regressionArgs = {
  experimentId: EXPERIMENT,
  metricRegression: true,
  barrier: { id: 'window:regression', reached: true },
  startupVerified: true,
  componentHealth: 'active',
  dependenciesPresent: true,
};

test('a crash after rollback and before any conclusion rebuilds the terminal rollback state', async (t) => {
  const env = await scene(t);
  const child = spawnSync(process.execPath, ['--max-old-space-size=4096', WORKER, env.root, EXPERIMENT], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', `child must die inside archive(): ${child.stdout}${child.stderr}`);
  assert.equal(await exists(path.join(env.root, 'crash-marker')), true);
  assert.equal(await exists(env.paths.promotionStateDir), false, 'rollback removed the journal before the crash');
  assert.equal(await exists(path.join(env.paths.archiveDir, `${EXPERIMENT}.md`)), false, 'archive was not written before the crash');
  // A promotion draft archive can survive the crash; mere existence must not
  // be mistaken for the terminal rollback rendering.
  await fs.writeFile(path.join(env.paths.archiveDir, `${EXPERIMENT}.md`), `# Evolution experiment ${EXPERIMENT}\n- state: promoting\n\n## Proposal\n- why: draft\n- target: ${TARGET}\n- impact: test\n- success metrics: test\n`);
  assert.equal(findConclusion(env).best?.decision ?? null, null, 'no conclusion was written before the crash');

  const receipt = await readEvidenceSnapshot(env.paths.archiveDir, EXPERIMENT);
  assert.ok(receipt, 'a durable rollback receipt survives the crash');
  assert.equal(receipt.state, 'rolled-back');
  assert.equal(receipt.decision?.kind, 'regression');
  assert.equal(receipt.proposal?.target, TARGET);

  const warnings = [];
  const recovery = await orchestratorFor(env, warnings).reconcileRollbackConclusions();
  assert.equal(recovery.published, 1, `${JSON.stringify(recovery)} warnings=${JSON.stringify(warnings)}`);
  assert.deepEqual(recovery.rollbacks, [{ experimentId: EXPERIMENT, state: 'rolled-back' }]);
  assert.equal(await exists(path.join(env.paths.archiveDir, `${EXPERIMENT}.md`)), true, 'terminal archive rebuilt');
  const archiveText = await fs.readFile(path.join(env.paths.archiveDir, `${EXPERIMENT}.md`), 'utf8');
  assert.match(archiveText, /- state: rolled-back/);
  assert.match(archiveText, /rolled-back-to-last-known-good/, 'the bounded failure detail is restored');
  const conclusion = findConclusion(env);
  assert.equal(conclusion.best?.decision, 'regression');
  assert.equal(conclusion.best?.lastSeen, receipt.decision.at);

  const report = await collectDiagnostics({
    dshHome: env.root, paths: resolveEvolutionPaths({ dshHome: env.root }),
    config: { rollbackConclusionReconciliation: recovery },
  });
  assert.deepEqual(report.rollbackRecovery.recovered, [{ experimentId: EXPERIMENT, state: 'rolled-back' }]);
  assert.match(summarize(report), new RegExp(`recovered rollback\\(s\\): ${EXPERIMENT}`));

  // Repeating startup recovery must not publish a second fact or rewrite the
  // rebuilt archive: the same conclusion identity stays a duplicate.
  const again = await orchestratorFor(env).reconcileRollbackConclusions();
  assert.equal(again.published, 0);
  assert.equal(again.duplicates, 1);
  assert.equal(again.archived, 0);
});

test('a crash between receipt write and journal cleanup finishes cleanup without rolling back twice', async (t) => {
  const env = await scene(t);
  // refresh() is the last rollback step before the receipt is written. Make
  // the following state-directory removal fail by denying writes on it.
  env.paths.promotionRuntime = {
    ...unitPromotionRuntime(),
    refresh: async () => { await fs.chmod(env.paths.promotionStateDir, 0o500); },
  };
  const core = orchestratorFor(env);
  core.experiments.set(EXPERIMENT, {
    id: EXPERIMENT, ownerId: 'durability-owner', state: 'canary-observing', targets: [],
    proposal: env.proposal, observations: [], latestObservation: {},
    canary: { healthObservationWindow: 2, observations: [], startupVerified: false },
  });
  await assert.rejects(core.observeCanary(regressionArgs, execFor()));
  const receipt = await readEvidenceSnapshot(env.paths.archiveDir, EXPERIMENT);
  assert.ok(receipt, 'the receipt landed before the interrupted cleanup');
  assert.equal(receipt.state, 'rolled-back');
  assert.equal((await readJournal(env.paths)).phase, 'canary-observing');
  await assert.rejects(core.observeCanary({
    experimentId: EXPERIMENT,
    barrier: { id: 'window:after-receipt', reached: true },
    startupVerified: true, componentHealth: 'active', dependenciesPresent: true,
  }, execFor()), /already rolled back/, 'the live canary reader must not advance a journal whose rollback completed');
  await fs.chmod(env.paths.promotionStateDir, 0o700);
  const recovered = await recoverInterruptedPromotion(env.paths);
  assert.deepEqual(recovered, { recovered: true, status: 'rolled-back-cleaned', experimentId: EXPERIMENT });
  assert.equal(await exists(env.paths.promotionStateDir), false);
  assert.equal((await readEvidenceSnapshot(env.paths.archiveDir, EXPERIMENT)).rolledBackAt, receipt.rolledBackAt,
    'cleanup did not start a second rollback');
  const result = await orchestratorFor(env).reconcileRollbackConclusions();
  assert.equal(result.published, 1);
});

test('the rollback receipt is bounded and credential-redacted before it reaches disk', async (t) => {
  const env = await scene(t);
  const sentinel = 'sk-abcdefghijklmnopqrstuvwxyz123456';
  const oversized = `${sentinel}${'x'.repeat(3 * 1024 * 1024)}`;
  const core = orchestratorFor(env);
  core.experiments.set(EXPERIMENT, {
    id: EXPERIMENT, ownerId: 'durability-owner', state: 'canary-observing', targets: [],
    proposal: env.proposal, observations: [{ barrierId: oversized }],
    latestObservation: { barrierId: oversized, componentHealth: sentinel },
    canary: { healthObservationWindow: 2, observations: [], startupVerified: false },
  });
  const result = await core.observeCanary(regressionArgs, execFor());
  assert.equal(result.phase, 'rolled-back');
  const sidecar = path.join(env.paths.archiveDir, `${EXPERIMENT}.evidence.json`);
  const stat = await fs.stat(sidecar);
  assert.ok(stat.size < 2 * 1024 * 1024, `receipt must fit the startup reader bound: ${stat.size}`);
  const text = await fs.readFile(sidecar, 'utf8');
  assert.equal(text.includes(sentinel), false, 'no raw credential shape reaches the receipt');
  // The live path already published the conclusion before this normal run;
  // startup reconciliation must recognise it as the same fact, not a second one.
  const recovery = await orchestratorFor(env).reconcileRollbackConclusions();
  assert.equal(recovery.duplicates, 1, JSON.stringify(recovery));
  assert.equal(recovery.published, 0);
});

test('a failed receipt write leaves a retryable intent, not a reopenable canary', async (t) => {
  const env = await scene(t);
  // A directory at the receipt path makes the durable write fail EISDIR after
  // the rollback already restored the targets.
  const sidecarDir = path.join(env.paths.archiveDir, `${EXPERIMENT}.evidence.json`);
  await fs.mkdir(sidecarDir, { recursive: true });
  const core = orchestratorFor(env);
  core.experiments.set(EXPERIMENT, {
    id: EXPERIMENT, ownerId: 'durability-owner', state: 'canary-observing', targets: [],
    proposal: env.proposal, observations: [], latestObservation: {},
    canary: { healthObservationWindow: 2, observations: [], startupVerified: false },
  });
  await assert.rejects(core.observeCanary(regressionArgs, execFor()));
  assert.equal(await exists(path.join(env.paths.promotionStateDir, 'rollback-intent.json')), true);
  assert.equal((await readJournal(env.paths)).phase, 'canary-observing');
  assert.equal(await fs.readFile(env.paths.compositionPath, 'utf8'), '[]\n', 'the targets were already rolled back');
  await assert.rejects(core.observeCanary({
    experimentId: EXPERIMENT,
    barrier: { id: 'window:after-failed-receipt', reached: true },
    startupVerified: true, componentHealth: 'active', dependenciesPresent: true,
  }, execFor()), /unfinished rollback/);
  const pendingReport = await collectDiagnostics({
    dshHome: env.root, paths: { ...resolveEvolutionPaths({ dshHome: env.root }), ...env.paths },
  });
  const pendingCheck = pendingReport.checks.find((row) => row.id === 'promotion.journal');
  assert.equal(pendingCheck.evidence.rollbackIntent, 'ready');
  assert.match(pendingCheck.summary, /cleanup is pending/);
  assert.match(pendingCheck.remediation, /Restart/);
  await fs.rm(sidecarDir, { recursive: true, force: true });
  const recovered = await recoverInterruptedPromotion(env.paths);
  assert.equal(recovered.status, 'rolled-back', JSON.stringify(recovered));
  assert.equal(await exists(env.paths.promotionStateDir), false);
  assert.ok(await readEvidenceSnapshot(env.paths.archiveDir, EXPERIMENT), 'receipt completed on retry');
  const result = await orchestratorFor(env).reconcileRollbackConclusions();
  assert.equal(result.published, 1);
});

test('an incomplete rollback intent is invalid, not a restartable rollback', async (t) => {
  const env = await scene(t);
  const intent = { version: 1, experimentId: EXPERIMENT, phase: 'rollback-started', terminalSnapshot: {} };
  await fs.writeFile(path.join(env.paths.promotionStateDir, 'rollback-intent.json'), `${JSON.stringify(intent, null, 2)}\n`);
  const core = orchestratorFor(env);
  core.experiments.set(EXPERIMENT, {
    id: EXPERIMENT, ownerId: 'durability-owner', state: 'canary-observing', targets: [],
    proposal: env.proposal, observations: [], latestObservation: {},
    canary: { healthObservationWindow: 2, observations: [], startupVerified: false },
  });
  await assert.rejects(recoverInterruptedPromotion(env.paths), /invalid/);
  await assert.rejects(core.observeCanary({
    experimentId: EXPERIMENT,
    barrier: { id: 'window:invalid-intent', reached: true },
    startupVerified: true, componentHealth: 'active', dependenciesPresent: true,
  }, execFor()), /invalid/);
  const report = await collectDiagnostics({
    dshHome: env.root, paths: { ...resolveEvolutionPaths({ dshHome: env.root }), ...env.paths },
  });
  const check = report.checks.find((row) => row.id === 'promotion.journal');
  assert.equal(check.level, 'blocked');
  assert.equal(check.evidence.rollbackIntent, 'invalid');
  assert.equal(await readEvidenceSnapshot(env.paths.archiveDir, EXPERIMENT), null);
});

test('an unreadable rollback intent blocks recovery, live canary advancement and the doctor', async (t) => {
  const env = await scene(t);
  const sidecarDir = path.join(env.paths.archiveDir, `${EXPERIMENT}.evidence.json`);
  await fs.mkdir(sidecarDir, { recursive: true });
  const core = orchestratorFor(env);
  core.experiments.set(EXPERIMENT, {
    id: EXPERIMENT, ownerId: 'durability-owner', state: 'canary-observing', targets: [],
    proposal: env.proposal, observations: [], latestObservation: {},
    canary: { healthObservationWindow: 2, observations: [], startupVerified: false },
  });
  await assert.rejects(core.observeCanary(regressionArgs, execFor()));
  const intentPath = path.join(env.paths.promotionStateDir, 'rollback-intent.json');
  // A directory at the intent path makes reads fail with EISDIR even for a
  // privileged test process; ENOENT is the only "no intent started" signal.
  await fs.rm(intentPath, { force: true });
  await fs.mkdir(intentPath, { recursive: true });
  t.after(async () => {
    await fs.rm(intentPath, { recursive: true, force: true }).catch(() => {});
    await fs.rm(sidecarDir, { recursive: true, force: true }).catch(() => {});
  });
  await assert.rejects(recoverInterruptedPromotion(env.paths), /intent is unreadable/);
  await assert.rejects(core.observeCanary({
    experimentId: EXPERIMENT,
    barrier: { id: 'window:unreadable-intent', reached: true },
    startupVerified: true, componentHealth: 'active', dependenciesPresent: true,
  }, execFor()), /intent is unreadable/);
  const diagPaths = { ...resolveEvolutionPaths({ dshHome: env.root }), ...env.paths };
  const report = await collectDiagnostics({ dshHome: env.root, paths: diagPaths });
  const check = report.checks.find((row) => row.id === 'promotion.journal');
  assert.equal(check.level, 'blocked');
  assert.equal(check.evidence.rollbackIntent, 'unreadable', JSON.stringify(check.evidence));
});

test('a trimmed receipt still carries the probe applicability the live publisher used', async (t) => {
  const env = await scene(t);
  const otherVersions = { dsh: '0.2.22', cordis: '4.1.0', evolution: '0.2.22' };
  const proposal = {
    ...env.proposal, applicability: otherVersions,
    successMetrics: Array.from({ length: 40 }, (_, i) => `metric-${i}-${'x'.repeat(60000)}`),
  };
  const latestObservation = { at: '2026-11-27T00:00:00.000Z', probe: { versions: APPLICABILITY, comparison: { regression: true } } };
  const core = orchestratorFor(env);
  core.experiments.set(EXPERIMENT, {
    id: EXPERIMENT, ownerId: 'durability-owner', state: 'canary-observing', targets: [],
    proposal, observations: [], latestObservation,
    canary: { healthObservationWindow: 2, observations: [], startupVerified: false },
  });
  const result = await core.observeCanary(regressionArgs, execFor());
  assert.equal(result.phase, 'rolled-back');
  const receipt = await readEvidenceSnapshot(env.paths.archiveDir, EXPERIMENT);
  assert.ok(receipt);
  assert.ok((await fs.stat(path.join(env.paths.archiveDir, `${EXPERIMENT}.evidence.json`))).size < 2 * 1024 * 1024);
  assert.deepEqual(receipt.latestObservation?.probe?.versions, APPLICABILITY, 'probe versions survive the trimming');
  const recovery = await orchestratorFor(env).reconcileRollbackConclusions();
  assert.equal(recovery.duplicates, 1, JSON.stringify(recovery));
  assert.equal(recovery.published, 0, 'no second conclusion under the proposal versions');
  assert.equal(findConclusion(env).best?.decision, 'regression');
});

test('applicability extras are projected out of the durable receipt', async (t) => {
  const env = await scene(t);
  const sentinel = 'sk-abcdefghijklmnopqrstuvwxyz123456';
  const probeVersions = { ...APPLICABILITY, token: sentinel, extra: 'x'.repeat(3 * 1024 * 1024) };
  const proposal = {
    ...env.proposal,
    applicability: { ...APPLICABILITY, token: sentinel },
    successMetrics: Array.from({ length: 40 }, (_, i) => `metric-${i}-${'x'.repeat(60000)}`),
  };
  const core = orchestratorFor(env);
  core.experiments.set(EXPERIMENT, {
    id: EXPERIMENT, ownerId: 'durability-owner', state: 'canary-observing', targets: [],
    proposal, observations: [], latestObservation: { probe: { versions: probeVersions } },
    canary: { healthObservationWindow: 2, observations: [], startupVerified: false },
  });
  const result = await core.observeCanary(regressionArgs, execFor());
  assert.equal(result.phase, 'rolled-back');
  const sidecar = path.join(env.paths.archiveDir, `${EXPERIMENT}.evidence.json`);
  const text = await fs.readFile(sidecar, 'utf8');
  assert.equal(text.includes(sentinel), false, 'credential-shaped version extras are not persisted');
  assert.ok((await fs.stat(sidecar)).size < 2 * 1024 * 1024);
  const receipt = await readEvidenceSnapshot(env.paths.archiveDir, EXPERIMENT);
  assert.deepEqual(receipt.latestObservation.probe.versions, APPLICABILITY);
  assert.deepEqual(receipt.proposal.applicability, APPLICABILITY);
  const recovery = await orchestratorFor(env).reconcileRollbackConclusions();
  assert.equal(recovery.duplicates + recovery.published, 1, JSON.stringify(recovery));
  assert.equal(findConclusion(env).best?.decision, 'regression');
});

test('an oversized proposal cannot block the rollback or overflow the receipt reader', async (t) => {
  const env = await scene(t);
  const proposal = { ...env.proposal, successMetrics: Array.from({ length: 40 }, (_, i) => `metric-${i}-${'x'.repeat(60000)}`) };
  const core = orchestratorFor(env);
  core.experiments.set(EXPERIMENT, {
    id: EXPERIMENT, ownerId: 'durability-owner', state: 'canary-observing', targets: [],
    proposal, observations: [], latestObservation: {},
    canary: { healthObservationWindow: 2, observations: [], startupVerified: false },
  });
  const result = await core.observeCanary(regressionArgs, execFor());
  assert.equal(result.phase, 'rolled-back');
  assert.equal(await exists(path.join(env.paths.pluginRoot, derivedPluginName(EXPERIMENT))), false, 'rollback was not blocked by receipt construction');
  assert.equal(await exists(env.paths.promotionStateDir), false);
  const sidecar = path.join(env.paths.archiveDir, `${EXPERIMENT}.evidence.json`);
  assert.ok((await fs.stat(sidecar)).size < 2 * 1024 * 1024);
  const recovery = await orchestratorFor(env).reconcileRollbackConclusions();
  assert.equal(recovery.duplicates, 1, JSON.stringify(recovery));
  assert.deepEqual(recovery.rollbacks, [], 'an already-published conclusion is not a new recovery');
  const report = await collectDiagnostics({
    dshHome: env.root, paths: resolveEvolutionPaths({ dshHome: env.root }),
    config: { rollbackConclusionReconciliation: recovery },
  });
  assert.equal(report.rollbackRecovery, undefined, 'a duplicate is not reported as a recovered rollback');
});

test('a duplicate archive render is not counted as a rebuilt terminal archive', async (t) => {
  const env = await scene(t);
  const receipt = {
    version: 1, state: 'rolled-back', rolledBackAt: '2026-11-27T00:00:01.000Z', experimentId: EXPERIMENT,
    decision: { version: 1, kind: 'regression', source: 'canary', at: '2026-11-27T00:00:01.000Z', reasons: [] },
    proposal: env.proposal,
  };
  await fs.mkdir(env.paths.archiveDir, { recursive: true });
  await fs.writeFile(path.join(env.paths.archiveDir, `${EXPERIMENT}.evidence.json`), `${JSON.stringify(receipt, null, 2)}\n`);
  const core = orchestratorFor(env);
  // Emulates archive()'s memory-dedup early return: no Markdown is written.
  core.archive = async () => path.join(env.paths.archiveDir, `${EXPERIMENT}.md`);
  const recovery = await core.reconcileRollbackConclusions();
  assert.equal(recovery.archived, 0, JSON.stringify(recovery));
  assert.equal(recovery.published, 0);
  assert.equal(recovery.failed.some((row) => row.reason === 'archive-failed'), true);
  assert.deepEqual(recovery.rollbacks, []);
});

test('rollback-failed keeps its journal, writes no rollback receipt and reports no rollback', async (t) => {
  const env = await scene(t, { corruptBackup: true });
  const core = orchestratorFor(env);
  const { experiments } = core;
  experiments.set(EXPERIMENT, {
    id: EXPERIMENT, ownerId: 'durability-owner', state: 'canary-observing', targets: [],
    proposal: env.proposal, observations: [], latestObservation: {},
    canary: { healthObservationWindow: 2, observations: [], startupVerified: false },
  });
  await assert.rejects(core.observeCanary(regressionArgs, execFor()), /rollback failed/);
  const preserved = await readJournal(env.paths);
  assert.equal(preserved.phase, 'rollback-failed');
  assert.equal(await exists(env.paths.promotionStateDir), true);
  assert.equal(await readEvidenceSnapshot(env.paths.archiveDir, EXPERIMENT), null);
  await assert.rejects(recoverInterruptedPromotion(env.paths), /rollback is incomplete/);
  const recovery = await orchestratorFor(env).reconcileRollbackConclusions();
  assert.equal(recovery.published, 0);
  assert.deepEqual(recovery.rollbacks, []);
  assert.equal(findConclusion(env).best?.decision ?? null, null);
});
