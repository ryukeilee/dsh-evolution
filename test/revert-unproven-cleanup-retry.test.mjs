// A cleanup that cannot prove runtime recovery used to end the session.
//
// `revert()` and `trial()` correctly keep the target claim and the experiment
// record when the official disposers do not prove that the Trial is gone
// (AGENTS.md invariant 3), and `promote()` does the same. What no path did was
// accept those states again: `revert` required `trial` / `trial-awaiting-approval`
// / `measured`, `promote` required `measured`, `measure` required a Trial state and
// `trial` required `proposed`. The two states that a failed cleanup produces
// (`revert-failed`, `trial-cleanup-failed`) therefore became permanent occupants of
// the runtime:
//
//   revert #1 -> { ok: false, phase: 'revert-failed' }      (undefine threw)
//   revert #2 -> throws "experiment ... is revert-failed; Revert requires a Trial"
//   trial #2  -> E_EVOLUTION_RUNTIME_BUSY "... revert or promote it before starting
//                a new Trial"                                (both are refused)
//
// Every later Trial in the process was refused with advice no tool could carry
// out, and the `nextPreventionHint` written on that path ("fix the dispose path and
// re-establish the baseline") named a step that is itself refused.
//
// Making the retry reachable is only half of it: the official disposers are *not*
// idempotent. `DynamicCordisStopResponse` answers `not-running` once the run was
// stopped and `plugin-missing` once the plugin is gone, and
// `DynamicCordisUndefineReceipt` answers `plugin-missing` for a plugin that is
// already removed (`@deepseek-ai/dsh-cordis-host-runner` publishes both as closed
// unions). A retry after a partially successful cleanup therefore sees
// `stop -> not-running`, and reading that refusal as a plain failure made the retry
// unable to prove anything. These cases drive both halves end to end, with a runner
// that reports exactly the official receipt shapes - the first version of this file
// used an idempotent fake and hid the defect.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { EvolutionOrchestrator } from '../lib/orchestrator.js';
import {
  promotionPaths, unitPromotionRuntime, orchestratorContext, execFor, HOST_CODE,
} from './orchestrator-durability-fixtures.mjs';

const COMPOSITION = { name: 'retry', purpose: 'retry', code: { host: HOST_CODE } };
const PROPOSAL = { why: 'retry an unproven cleanup', target: 'plugin:retry', impactScope: ['test'], successMetrics: ['errors'] };
const OBSERVATION = {
  solvesProblem: true,
  errorChange: 'decreased',
  metrics: { errors: 0 },
  beforeMetrics: { errors: 1 },
  afterMetrics: { errors: 0 },
  observationWindow: '1h',
  sampleCount: 2,
  benefitEvidence: 'measured',
  repeatable: true,
  regressionPassed: true,
  reversible: true,
  cleanupEvidence: 'clean',
};

/**
 * The official dynamic runner, reduced to its documented lifecycle and receipt
 * shapes. `stop` / `undefine` answer from the closed unions in
 * `@deepseek-ai/dsh-cordis-host-runner` (`DynamicCordisStopResponse`,
 * `DynamicCordisUndefineReceipt`), which is what makes a retry's receipts
 * `not-running` / `plugin-missing` instead of `ok`.
 */
function officialRunner() {
  return {
    defined: false,
    mounted: false,
    stopFailure: null,     // null | 'throw' | { reason }
    undefineFailure: null, // null | 'throw' | { reason }
    // A defined plugin stays in the inventory until `undefine`, run or not.
    snapshot() { return this.defined ? [{ pluginId: 'retry-plugin', packages: [] }] : []; },
    define() { this.defined = true; this.mounted = true; return { pluginId: 'retry-plugin', packageId: 'retry-package' }; },
    async run() { return { ok: true, status: 'active' }; },
    async stop() {
      if (!this.defined) return { ok: false, reason: 'plugin-missing', message: 'dynamic plugin "retry-plugin" does not exist' };
      if (!this.mounted) return { ok: false, reason: 'not-running', message: 'dynamic plugin "retry-plugin" is not running' };
      if (this.stopFailure === 'throw') throw new Error('stop transport failed');
      if (this.stopFailure) return { ok: false, ...this.stopFailure, message: 'stop refused' };
      this.mounted = false;
      return { ok: true };
    },
    async undefine() {
      if (!this.defined) return { ok: false, reason: 'plugin-missing', message: 'dynamic plugin "retry-plugin" does not exist' };
      if (this.undefineFailure === 'throw') throw new Error('undefine transport failed');
      if (this.undefineFailure) return { ok: false, ...this.undefineFailure, message: 'undefine refused' };
      const wasRunning = this.mounted;
      this.defined = false;
      this.mounted = false;
      return { ok: true, wasRunning };
    },
    inspectPackage() { return { code: { host: HOST_CODE } }; },
  };
}

async function harness(t, name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `evo-revert-retry-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = promotionPaths(root);
  paths.promotionRuntime = unitPromotionRuntime();
  await fs.writeFile(paths.compositionPath, '[]\n');
  const warnings = [];
  const ctx = orchestratorContext(warnings);
  const runner = officialRunner();
  ctx.dynamicCordisRunner = runner;
  const core = new EvolutionOrchestrator(ctx, {
    ...paths,
    startupDrift: false,
    driftStatePath: path.join(root, 'drift.json'),
    memoryPath: path.join(root, 'memory.json'),
  });
  return { root, paths, core, ctx, exec: execFor('retry-owner'), runner, warnings };
}

function ownershipDir(h) {
  return h.paths.ownershipDir ?? path.join(h.paths.presetDir, '.evolution-ownership');
}

async function ownershipFiles(h) {
  return fs.readdir(ownershipDir(h)).catch(() => []);
}

async function readText(file) {
  try { return await fs.readFile(file, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

async function started(t, name) {
  const h = await harness(t, name);
  const proposal = h.core.propose(PROPOSAL, h.exec);
  const record = h.core.experiments.get(proposal.experimentId);
  await h.core.trial({ experimentId: record.id, composition: COMPOSITION }, h.exec);
  return { ...h, proposal, record, target: record.targets[0] };
}

test('a retry after a partially successful cleanup proves recovery and the session continues', async (t) => {
  const h = await started(t, 'partial');

  // The first attempt stops the run and then cannot remove the plugin: the
  // official `undefine` throws from its Host-half retraction.
  h.runner.undefineFailure = 'throw';
  const failed = await h.core.revert({ experimentId: h.record.id }, h.exec);
  assert.equal(failed.ok, false);
  assert.equal(failed.phase, 'revert-failed');
  assert.equal(failed.stop.ok, true, 'the run really was stopped');
  assert.equal(h.core.targetOwners.get(h.target), h.record.id, 'the claim is retained while recovery is unproven');
  assert.equal((await ownershipFiles(h)).length, 1, 'the claim file is still on disk');

  // The retry's `stop` cannot answer `ok` again: the official runner reports
  // `not-running`. Before the receipt vocabulary was read, that refusal made the
  // retry unable to prove anything and the record stayed an occupant forever.
  h.runner.undefineFailure = null;
  const retried = await h.core.revert({ experimentId: h.record.id }, h.exec);
  assert.deepEqual(retried.stop, { ok: false, reason: 'not-running', message: 'dynamic plugin "retry-plugin" is not running' });
  assert.equal(retried.ok, true, 'the retried cleanup proved recovery');
  assert.equal(retried.phase, 'reverted');
  assert.equal(retried.runtimeRecovered, true);
  assert.equal(h.record.cleanupProof.stopOk, true, 'not-running proves the run is gone');
  assert.equal(h.record.cleanupProof.removedOk, true);
  assert.equal(h.core.targetOwners.get(h.target), undefined, 'the claim is released by the proof');
  assert.deepEqual(await ownershipFiles(h), [], 'the claim file is gone');
  assert.equal(h.core.operationClaims.has(h.record.id), false, 'no operation claim is left behind');

  // The runtime is free again, so the same target can carry a new experiment.
  const again = h.core.propose(PROPOSAL, h.exec);
  const trialed = await h.core.trial({ experimentId: again.experimentId, composition: COMPOSITION }, h.exec);
  assert.equal(trialed.phase, 'trial');
  assert.equal(h.core.targetOwners.get(h.target), again.experimentId);
});

test('a retry proves recovery when both disposers report the plugin already gone', async (t) => {
  const h = await started(t, 'already-gone');

  // Both steps are already in their terminal state (another owner, the panel, or
  // an interrupted attempt removed the plugin): `plugin-missing` for both.
  h.runner.defined = false;
  h.runner.mounted = false;
  const reverted = await h.core.revert({ experimentId: h.record.id }, h.exec);
  assert.equal(reverted.stop.reason, 'plugin-missing');
  assert.equal(reverted.removed.reason, 'plugin-missing');
  assert.equal(reverted.ok, true);
  assert.equal(reverted.phase, 'reverted');
  assert.equal(reverted.runtimeRecovered, true);
  assert.equal(h.core.targetOwners.get(h.target), undefined);
  assert.deepEqual(await ownershipFiles(h), []);
});

test('a transient drift does not wedge the session once it is gone', async (t) => {
  const h = await started(t, 'transient-drift');

  // The Trial is disposed, but an unrelated host change is visible during the
  // comparison, so the cleanup cannot prove the runtime returned to the baseline.
  const drift = { name: 'unrelated-during-trial', fibers: [{ name: 'unrelated-during-trial', uid: 'x', state: 'active', getEffects: () => [] }] };
  h.ctx.registry.values = () => [drift];
  const first = await h.core.revert({ experimentId: h.record.id }, h.exec);
  assert.equal(first.phase, 'revert-failed');
  assert.equal(h.record.cleanupProof.signatureRecovered, false);
  assert.equal(h.record.cleanupProof.stopOk, true);
  assert.equal(h.record.cleanupProof.removedOk, true);

  // The drift disappears. The retry re-reads the same single baseline, and the
  // two `plugin-missing` receipts plus an equal signature are a proof.
  h.ctx.registry.values = () => [];
  const retried = await h.core.revert({ experimentId: h.record.id }, h.exec);
  assert.equal(retried.ok, true);
  assert.equal(retried.phase, 'reverted');
  assert.equal(h.core.targetOwners.get(h.target), undefined);
  assert.deepEqual(await ownershipFiles(h), []);
});

test('a retry whose receipts are not proof keeps every claim', async (t) => {
  const h = await started(t, 'still-broken');

  // A refusal that is not one of the documented "already in that state" reasons
  // proves nothing, and neither does a thrown receipt.
  h.runner.undefineFailure = { reason: 'rejected' };
  const first = await h.core.revert({ experimentId: h.record.id }, h.exec);
  assert.equal(first.phase, 'revert-failed');
  const second = await h.core.revert({ experimentId: h.record.id }, h.exec);
  assert.equal(second.ok, false);
  assert.equal(second.phase, 'revert-failed');
  assert.equal(h.record.cleanupProof.removedOk, false, 'an undocumented refusal is not proof');
  assert.equal(h.core.targetOwners.get(h.target), h.record.id, 'an unproven retry releases nothing');
  assert.equal((await ownershipFiles(h)).length, 1);
  assert.equal(h.core.operationClaims.has(h.record.id), false, 'the operation claim is still released');

  // A second Trial stays refused, and the advice now names a step that exists.
  const again = h.core.propose(PROPOSAL, h.exec);
  await assert.rejects(
    h.core.trial({ experimentId: again.experimentId, composition: COMPOSITION }, h.exec),
    (error) => error.code === 'E_EVOLUTION_RUNTIME_BUSY' && /retry evolution_revert/.test(error.message),
  );
});

test('an undocumented stop receipt is not proof either', async (t) => {
  const h = await started(t, 'unknown-stop-reason');

  // The run is still active, so `stop` answers with its own refusal reason
  // instead of `not-running`; nothing about that shape says the Trial is gone.
  h.runner.stopFailure = { reason: 'transition-in-flight' };
  h.runner.undefineFailure = { reason: 'rejected' };
  const reverted = await h.core.revert({ experimentId: h.record.id }, h.exec);
  assert.equal(reverted.ok, false);
  assert.equal(h.record.cleanupProof.stopOk, false);
  assert.equal(h.record.cleanupProof.removedOk, false);
  assert.equal(h.core.targetOwners.get(h.target), h.record.id, 'an unproven cleanup keeps the claim');
  assert.equal((await ownershipFiles(h)).length, 1);
});

test('a Trial whose cleanup failed is not orphaned: the record stays reachable', async (t) => {
  const h = await harness(t, 'trial-cleanup');
  const proposal = h.core.propose(PROPOSAL, h.exec);
  const record = h.core.experiments.get(proposal.experimentId);
  const target = record.targets[0];

  // `run` fails and the undo cannot prove the Trial is gone.
  h.runner.run = async () => { throw new Error('synthetic run failure'); };
  h.runner.undefineFailure = 'throw';
  await assert.rejects(
    h.core.trial({ experimentId: record.id, composition: COMPOSITION }, h.exec),
    /synthetic run failure/,
  );
  assert.equal(record.state, 'trial-cleanup-failed');
  assert.equal(h.core.targetOwners.get(target), record.id);
  assert.equal((await ownershipFiles(h)).length, 1, 'the claim is retained with the record');

  // No lifecycle entry point used to accept this state, so the record and its
  // claim could only be cleared by restarting the process.
  h.runner.undefineFailure = null;
  const retried = await h.core.revert({ experimentId: record.id }, h.exec);
  assert.equal(retried.ok, true);
  assert.equal(retried.phase, 'reverted');
  assert.equal(h.core.targetOwners.get(target), undefined);
  assert.deepEqual(await ownershipFiles(h), []);
});

test('the recovered archive reports the outcome, and the superseded failure stays durable', async (t) => {
  const h = await started(t, 'archive');

  h.runner.undefineFailure = 'throw';
  await h.core.revert({ experimentId: h.record.id }, h.exec);
  const failedArchive = await readText(path.join(h.paths.archiveDir, `${h.record.id}.md`));
  assert.match(failedArchive, /- state: revert-failed/);
  assert.match(failedArchive, /Cordis cleanup did not prove runtime recovery/);

  h.runner.undefineFailure = null;
  await h.core.revert({ experimentId: h.record.id }, h.exec);

  // A terminal archive that says `reverted` / `recovered: true` may not also carry
  // a failure block claiming the cleanup did not prove recovery.
  const recoveredArchive = await readText(path.join(h.paths.archiveDir, `${h.record.id}.md`));
  assert.match(recoveredArchive, /- state: reverted/);
  assert.match(recoveredArchive, /- recovered: true/);
  assert.doesNotMatch(recoveredArchive, /Cordis cleanup did not prove runtime recovery/);
  assert.match(recoveredArchive, /"status": "none"/);

  // Nothing is hidden: the failed attempt is still in the authenticated event log
  // and in the failure memory that the failed attempt archived.
  const bridge = await readText(h.paths.eventBridgePath);
  assert.match(bridge, /failure-learned/);
  const memory = await readText(path.join(h.root, 'memory.json'));
  assert.match(memory, /cleanup-or-rollback/);
});

test('the autonomous cleanup retries an unproven cleanup instead of reporting it as final', async (t) => {
  const h = await started(t, 'autonomous');

  h.runner.undefineFailure = 'throw';
  await h.core.revert({ experimentId: h.record.id }, h.exec);
  assert.equal(h.record.state, 'revert-failed');

  // The observer's own failure path ended here with `not-recovered`, leaving the
  // runtime occupied by a record it had already failed to dispose.
  h.runner.undefineFailure = null;
  const cleanup = await h.core.cleanupAutonomousTrial(h.record.id, h.exec);
  assert.equal(cleanup.status, 'recovered');
  assert.equal(cleanup.phase, 'reverted');
  assert.equal(h.core.targetOwners.get(h.target), undefined);
  assert.equal((await ownershipFiles(h)).length, 0);
});

test('a measured record still reverts in one call, without a retry', async (t) => {
  const h = await harness(t, 'first-try');
  const proposal = h.core.propose(PROPOSAL, h.exec);
  const record = h.core.experiments.get(proposal.experimentId);
  await h.core.trial({ experimentId: record.id, composition: COMPOSITION }, h.exec);
  h.core.measure({ experimentId: record.id, observation: OBSERVATION }, h.exec);

  const reverted = await h.core.revert({ experimentId: record.id }, h.exec);
  assert.equal(reverted.ok, true);
  assert.equal(reverted.phase, 'reverted');
  assert.equal(reverted.stop.ok, true, 'the first attempt really stops the run');
  assert.equal(record.failure, undefined, 'a first-attempt success records no failure');
});
