// An unproven autonomous cleanup must not end the evolution loop.
//
// `revert` already accepts `revert-failed` / `trial-cleanup-failed` (PR #16), so an
// owner who asks again finishes a cleanup the disposers temporarily refused. The
// observer never asked again: `observeAutonomous` ran `cleanupAutonomousTrial` once,
// suppressed the hypothesis it had been answering for, and every later Trial was
// refused with `E_EVOLUTION_RUNTIME_BUSY` - the record still owned the runtime and
// its target claim, and nothing in the autonomous path retried it. Observed on this
// fixture before the fix:
//
//   A#2 -> rolled-back-no-improvement, cleanup 'not-recovered'  (undefine threw)
//   B#2 -> experiment-deferred / transient-failure, error names the occupant
//   B#n -> suppressed (its one attempt is spent)
//   env heals -> nothing retries the cleanup, so no Trial runs again in that
//               session; only a manual `evolution_revert` or a restart cleared it.
//
// What the fix must not do is retry the *strategy*: `suppressForSession` and the
// durable failure memory still answer the hypothesis, so one unproven cleanup can
// never turn into a second experiment or into a retry on every error event (the
// retry is spaced by `cleanupRecoveryCooldownMs` and released only on proof).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { EvolutionOrchestrator } from '../lib/orchestrator.js';
import { context } from './fixtures/runtime-inspect.mjs';

const improved = {
  solvesProblem: true,
  sideEffects: [],
  orphanResources: [],
  performanceChange: 'decreased',
  errorChange: 'decreased',
  metrics: { errCount: 0 },
  beforeMetrics: { errCount: 1 },
  afterMetrics: { errCount: 0 },
  observationWindow: '1h',
  sampleCount: 2,
  benefitEvidence: 'error count fell from 1 to 0 over the window',
  repeatable: true,
  regressionPassed: true,
  reversible: true,
  cleanupEvidence: 'trial stopped and undefined; runtime fingerprint restored',
};

/**
 * The official dynamic runner, reduced to its documented lifecycle and receipt
 * shapes: `stop` answers `not-running` (or `plugin-missing`) once the run is gone
 * and `undefine` answers `plugin-missing` once the plugin is removed, which is what
 * lets a retry prove recovery instead of reading a refusal as a plain failure.
 */
function runner() {
  return {
    defined: false,
    mounted: false,
    undefineFails: false,
    undefineCalls: 0,
    stopCalls: 0,
    snapshot() { return this.defined ? [{ pluginId: 'recovery-plugin', packages: [] }] : []; },
    define() { this.defined = true; this.mounted = true; return { pluginId: 'recovery-plugin', packageId: 'recovery-package' }; },
    async run() { return { ok: true, status: 'active' }; },
    async stop() {
      this.stopCalls += 1;
      if (!this.defined) return { ok: false, reason: 'plugin-missing', message: 'dynamic plugin "recovery-plugin" does not exist' };
      if (!this.mounted) return { ok: false, reason: 'not-running', message: 'dynamic plugin "recovery-plugin" is not running' };
      this.mounted = false;
      return { ok: true };
    },
    async undefine() {
      this.undefineCalls += 1;
      if (this.undefineFails) throw new Error('undefine transport failed');
      if (!this.defined) return { ok: false, reason: 'plugin-missing', message: 'dynamic plugin "recovery-plugin" does not exist' };
      const wasRunning = this.mounted;
      this.defined = false;
      this.mounted = false;
      return { ok: true, wasRunning };
    },
  };
}

function declaration(variant, measure = async () => improved) {
  return {
    risk: 'low',
    target: `plugin:fix-${variant}`,
    idPrefix: `fix${variant}`,
    composition: { name: `fix-${variant}`, purpose: 'narrow the failing path', code: { host: `return { variant: "${variant}" };` } },
    measure,
  };
}

const failing = async () => { throw new Error('measure exploded'); };

const INPUT = {
  AGENT_ERROR: { type: 'agent/error', code: 'AGENT_ERROR', message: 'provider call failed' },
  TOOL_ERROR: { type: 'tool/error', code: 'TOOL_ERROR', message: 'tool call failed', target: 'tool:x' },
  BUILD_ERROR: { type: 'build/error', code: 'BUILD_ERROR', message: 'build failed', target: 'build:x' },
};

async function session(t, { cooldown = 0, strategies } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-cleanup-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ctx = context();
  ctx.logger = { warn() {} };
  const runtime = runner();
  ctx.dynamicCordisRunner = runtime;
  const core = new EvolutionOrchestrator(ctx, {
    presetDir: root,
    startupDrift: false,
    eventBridgePath: path.join(root, 'events.jsonl'),
    eventBridgeKey: 'k'.repeat(32),
    driftStatePath: path.join(root, 'drift.json'),
    memoryPath: path.join(root, 'memory.json'),
    patternThreshold: 2,
    mode: 'autonomous',
    unattended: true,
    cleanupRecoveryCooldownMs: cooldown,
    autonomousStrategies: strategies ?? {
      AGENT_ERROR: declaration('a', failing),
      TOOL_ERROR: declaration('b'),
      BUILD_ERROR: declaration('c'),
    },
  });
  const exec = { agent: { id: 'recovery-owner' }, signal: new AbortController().signal };
  return {
    root,
    ctx,
    core,
    runtime,
    exec,
    observe: (code, owner = exec) => core.observeAutonomous(INPUT[code], owner),
  };
}

function claimFile(core, target) {
  return path.join(core.paths.ownershipDir, `${crypto.createHash('sha256').update(target).digest('hex')}.json`);
}

async function claimExists(core, target) {
  try {
    await fs.stat(claimFile(core, target));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function autonomousRecords(core) {
  return [...core.experiments.values()].filter((record) => record.autonomous && typeof record.autonomous === 'object');
}

/** The hypothesis A whose measure throws: its Trial is mounted, then cleanup fails. */
async function wedged(t, options = {}) {
  const h = await session(t, options);
  assert.equal((await h.observe('AGENT_ERROR')).phase, 'pattern-observing');
  h.runtime.undefineFails = true;
  const failed = await h.observe('AGENT_ERROR');
  assert.equal(failed.phase, 'rolled-back-no-improvement');
  assert.equal(failed.cleanup.status, 'not-recovered');
  const [record] = autonomousRecords(h.core);
  assert.equal(record.state, 'revert-failed');
  assert.equal(record.targetsAcquired, true);
  assert.equal(h.core.targetOwners.get('plugin:fix-a'), record.id);
  assert.equal(await claimExists(h.core, 'plugin:fix-a'), true);
  return { ...h, record, target: 'plugin:fix-a' };
}

// ---------------------------------------------------------------------------
// The defect: a transient cleanup failure ended the loop
// ---------------------------------------------------------------------------

test('a transient cleanup failure is retried by a later observation and the loop continues', async (t) => {
  const h = await wedged(t);

  // A healthy, unrelated hypothesis arrives while the runtime is still occupied.
  // Its Trial is refused before anything runs, and the refusal names the occupant.
  assert.equal((await h.observe('TOOL_ERROR')).phase, 'pattern-observing');
  const deferred = await h.observe('TOOL_ERROR');
  assert.equal(deferred.phase, 'experiment-deferred');
  assert.equal(deferred.reason, 'transient-failure');
  assert.match(deferred.error, /occupies the runtime/);
  assert.match(deferred.error, /retry evolution_revert/);
  assert.equal(deferred.cleanupRecovery.status, 'unproven', 'this event retried the cleanup and could not prove it');
  assert.equal(deferred.cleanupRecovery.experimentId, h.record.id);
  assert.equal(h.record.state, 'revert-failed', 'an unproven retry changes nothing about the record');
  assert.equal(h.core.targetOwners.get(h.target), h.record.id);
  assert.equal(await claimExists(h.core, h.target), true);

  // The disposer transport recovers. The next observation retries the same cleanup
  // - the same disposers and the same baseline - and that proof releases the runtime.
  h.runtime.undefineFails = false;
  const recovered = await h.observe('TOOL_ERROR');
  assert.equal(recovered.cleanupRecovery.status, 'recovered');
  assert.equal(recovered.cleanupRecovery.cleanup.phase, 'reverted');
  assert.equal(h.record.state, 'reverted');
  assert.equal(h.record.targetsAcquired, false);
  assert.equal(h.core.targetOwners.get(h.target), undefined);
  assert.equal(await claimExists(h.core, h.target), false);

  // `TOOL_ERROR` already spent its one attempt on the refusal above, which is the
  // documented session rule; a later hypothesis still runs, so the loop continues.
  assert.equal(recovered.phase, 'suppressed');
  assert.equal(recovered.reason, 'duplicate-failure');

  assert.equal((await h.observe('BUILD_ERROR')).phase, 'pattern-observing');
  const ran = await h.observe('BUILD_ERROR');
  assert.equal(ran.phase, 'candidate-awaiting-confirmation');
  assert.equal(h.core.experiments.get(ran.experimentId).state, 'measured');
  assert.equal(h.core.targetOwners.get('plugin:fix-c'), ran.experimentId);

  // The recovery never re-ran the failed strategy: its hypothesis still owns
  // exactly one record, and that record is the reverted one.
  const aRecords = autonomousRecords(h.core).filter((record) => record.autonomous.patternKey === h.record.autonomous.patternKey);
  assert.equal(aRecords.length, 1);
  assert.equal(aRecords[0].id, h.record.id);
  assert.equal(aRecords[0].state, 'reverted');
});

test('a recovered cleanup lets the same hypothesis run when it was never attempted', async (t) => {
  const h = await wedged(t);
  // Nothing has been attempted for `TOOL_ERROR` yet when the disposer transport
  // recovers, so the retry inside that observation frees the runtime and the Trial
  // proceeds in the same event.
  h.runtime.undefineFails = false;
  assert.equal((await h.observe('TOOL_ERROR')).phase, 'pattern-observing', 'the window is below the threshold, so nothing runs yet');
  const ran = await h.observe('TOOL_ERROR');
  assert.equal(ran.phase, 'candidate-awaiting-confirmation');
  // The same event reclaimed the runtime before it started its own Trial, which is
  // why that Trial could claim its target at all.
  assert.equal(h.record.state, 'reverted');
  assert.equal(await claimExists(h.core, 'plugin:fix-a'), false);
  assert.equal(h.core.targetOwners.get('plugin:fix-a'), undefined);
  assert.equal(h.core.targetOwners.get('plugin:fix-b'), ran.experimentId);
});

// ---------------------------------------------------------------------------
// Persistent failure: safe refusal, one attempt per observation, no loop
// ---------------------------------------------------------------------------

test('a cleanup that keeps failing keeps every claim and is retried once per observation', async (t) => {
  const h = await wedged(t);
  const callsAfterTrial = h.runtime.undefineCalls;

  assert.equal((await h.observe('TOOL_ERROR')).phase, 'pattern-observing');
  const second = await h.observe('TOOL_ERROR');
  assert.equal(second.phase, 'experiment-deferred');
  assert.equal(second.cleanupRecovery.status, 'unproven');
  assert.equal(second.cleanupRecovery.attempts, 1);
  assert.equal(h.runtime.undefineCalls, callsAfterTrial + 1, 'exactly one retry, not a loop');

  // A suppressed hypothesis still drives the retry: that is what returns the
  // runtime to a later one, and it is why the suppression cannot hide the defect.
  const suppressed = await h.observe('AGENT_ERROR');
  assert.equal(suppressed.phase, 'suppressed');
  assert.equal(suppressed.cleanupRecovery.status, 'unproven');
  assert.equal(suppressed.cleanupRecovery.attempts, 2);
  assert.equal(h.runtime.undefineCalls, callsAfterTrial + 2, 'one attempt per observation');

  assert.equal(h.record.state, 'revert-failed');
  assert.equal(h.core.targetOwners.get(h.target), h.record.id);
  assert.equal(await claimExists(h.core, h.target), true);
  assert.equal(h.core.experiments.size, 1, 'no second experiment was created');
});

test('the retry is spaced by the cooldown instead of running on every error event', async (t) => {
  const h = await wedged(t, { cooldown: 60_000 });
  const callsAfterTrial = h.runtime.undefineCalls;

  assert.equal((await h.observe('TOOL_ERROR')).phase, 'pattern-observing');
  const first = await h.observe('TOOL_ERROR');
  assert.equal(first.cleanupRecovery.status, 'unproven');
  assert.equal(h.runtime.undefineCalls, callsAfterTrial + 1);
  assert.equal(first.cleanupRecovery.next, 'retry evolution_revert to finish disposing it');

  // The refusal above spent this hypothesis's one attempt, and every later event
  // inside the cooldown still reports the occupant while touching nothing: the
  // cooldown is what keeps a persistent failure from being retried per error event.
  for (let event = 0; event < 2; event += 1) {
    const cooled = await h.observe('TOOL_ERROR');
    assert.equal(cooled.phase, 'suppressed');
    assert.equal(cooled.cleanupRecovery.status, 'cooling-down');
    assert.equal(cooled.cleanupRecovery.attempts, 1, 'the cooldown reports the attempt already made');
    assert.equal(h.runtime.undefineCalls, callsAfterTrial + 1, 'no retry inside the cooldown');
  }
  assert.equal(h.core.targetOwners.get(h.target), h.record.id);
  assert.equal(await claimExists(h.core, h.target), true);
});

// ---------------------------------------------------------------------------
// Drift and ownership: the retry may not release what it cannot prove
// ---------------------------------------------------------------------------

test('a persistent drift keeps the runtime and the claim, and a later retry finishes once it is gone', async (t) => {
  const drift = { name: 'unrelated-change', fibers: [{ name: 'unrelated-change', uid: 'drift', state: 'active', getEffects: () => [] }] };
  const h = await session(t, {
    strategies: {
      AGENT_ERROR: declaration('a', async () => {
        // The disposers succeed, but the runtime no longer matches the baseline
        // captured before the Trial: recovery is not proven.
        h.ctx.registry.values = () => [drift];
        throw new Error('measure exploded');
      }),
      TOOL_ERROR: declaration('b'),
      BUILD_ERROR: declaration('c'),
    },
  });
  await h.observe('AGENT_ERROR');
  const failed = await h.observe('AGENT_ERROR');
  assert.equal(failed.cleanup.status, 'not-recovered');
  const [record] = autonomousRecords(h.core);
  assert.equal(record.cleanupProof.signatureRecovered, false);
  assert.equal(record.cleanupProof.stopOk, true);
  assert.equal(record.cleanupProof.removedOk, true);

  // The disposers are healthy now, so only the drift can keep the retry unproven.
  h.runtime.undefineFails = false;
  assert.equal((await h.observe('TOOL_ERROR')).phase, 'pattern-observing');
  const retried = await h.observe('TOOL_ERROR');
  assert.equal(retried.phase, 'experiment-deferred');
  assert.equal(retried.cleanupRecovery.status, 'unproven');
  assert.equal(record.state, 'revert-failed');
  assert.equal(h.core.targetOwners.get('plugin:fix-a'), record.id, 'drift keeps the claim');
  assert.equal(await claimExists(h.core, 'plugin:fix-a'), true);

  // Once the host change is gone the same retry proves recovery against the same
  // baseline, and the next hypothesis can run.
  h.ctx.registry.values = () => [];
  const recovered = await h.observe('TOOL_ERROR');
  assert.equal(recovered.cleanupRecovery.status, 'recovered');
  assert.equal(record.state, 'reverted');
  assert.equal(await claimExists(h.core, 'plugin:fix-a'), false);
  const ran = await h.observe('BUILD_ERROR');
  assert.equal(ran.phase, 'pattern-observing');
  assert.equal((await h.observe('BUILD_ERROR')).phase, 'candidate-awaiting-confirmation');
});

test('a record this session does not own is refused, not disposed of', async (t) => {
  const h = await wedged(t);
  assert.equal((await h.observe('TOOL_ERROR')).phase, 'pattern-observing');
  h.runtime.undefineFails = false;
  const other = { agent: { id: 'another-owner' }, signal: new AbortController().signal };

  const refused = await h.observe('TOOL_ERROR', other);
  assert.equal(refused.phase, 'experiment-deferred');
  assert.equal(refused.cleanupRecovery.status, 'unproven');
  assert.equal(refused.cleanupRecovery.cleanup.status, 'failed', 'the ownership check refused the retry');
  assert.equal(h.record.state, 'revert-failed');
  assert.equal(h.core.targetOwners.get(h.target), h.record.id, 'nothing was released');
  assert.equal(await claimExists(h.core, h.target), true);

  // The owner's own later observation still finishes the cleanup.
  const recovered = await h.observe('TOOL_ERROR');
  assert.equal(recovered.cleanupRecovery.status, 'recovered');
  assert.equal(h.record.state, 'reverted');
  assert.equal(await claimExists(h.core, h.target), false);
});

test('a measured candidate awaiting its owner is not treated as an unproven cleanup', async (t) => {
  const h = await session(t, {
    strategies: { AGENT_ERROR: declaration('a'), TOOL_ERROR: declaration('b'), BUILD_ERROR: declaration('c') },
  });
  await h.observe('AGENT_ERROR');
  const pending = await h.observe('AGENT_ERROR');
  assert.equal(pending.phase, 'candidate-awaiting-confirmation');
  const record = h.core.experiments.get(pending.experimentId);

  // A `measured` record occupies the runtime on purpose: it is waiting for the
  // owner's promotion decision, so the observer may not dispose of it (that would
  // discard the only evidence for a strategy that passed every gate).
  h.runtime.undefineFails = true;
  assert.equal((await h.observe('TOOL_ERROR')).phase, 'pattern-observing');
  const blocked = await h.observe('TOOL_ERROR');
  assert.equal(blocked.phase, 'experiment-deferred');
  assert.equal(blocked.cleanupRecovery, undefined, 'no cleanup retry was attempted');
  assert.equal(h.runtime.undefineCalls, 0);
  assert.equal(record.state, 'measured');
  assert.equal(h.core.targetOwners.get('plugin:fix-a'), record.id);
});
