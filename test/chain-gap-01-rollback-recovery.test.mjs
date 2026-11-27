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
  const conclusion = findConclusion(env);
  assert.equal(conclusion.best?.decision, 'regression');
  assert.equal(conclusion.best?.lastSeen, receipt.decision.at);

  // Repeating startup recovery must not publish a second fact or rewrite the
  // rebuilt archive: the same conclusion identity stays a duplicate.
  const again = await orchestratorFor(env).reconcileRollbackConclusions();
  assert.equal(again.published, 0);
  assert.equal(again.duplicates, 1);
  assert.equal(again.archived, 0);
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
