// An environment conflict must not retire a hypothesis for the whole session.
//
// The autonomous observer classifies failures into two kinds: a failure that says
// something about the declaration (a measurement without improvement, a rejected
// gate) and a failure that says something about the environment (`E_EVOLUTION_
// RUNTIME_BUSY`, a target claim held by another experiment, a permission or a
// resource error). The first kind is a verdict: it is written into the durable
// failure memory and suppresses the hypothesis for the session. The second kind is
// not evidence about the hypothesis at all, so it is never recorded durably.
//
// Before this fix the session half was wrong: the catch path called
// `suppressForSession(identity)` for *every* failure, so one environment conflict
// ended the hypothesis until the process exited. Observed on this fixture:
//
//   A (AGENT_ERROR) -> measured, holds the runtime and its target claim
//   B (TOOL_ERROR)  -> experiment-deferred / transient-failure (runtime busy)
//   owner reverts A -> runtime free, no claim left
//   B               -> suppressed / duplicate-failure, forever in this session
//
// A restart was the only exit, which is why the limitation was documented instead
// of fixed. The fix replaces the session suppression for transient failures with a
// timestamp: a later observation attempts the hypothesis again once
// `transientRetryCooldownMs` has passed. It stays bounded on purpose - no timer, no
// loop, one attempt per observation and at most one per cooldown, and every
// resource gate (`assertRuntimeAvailable`, the target claims, the pending measured
// candidate and the cleanup retry) still runs for the retry exactly as it does for
// a first attempt.
import test from 'node:test';
import assert from 'node:assert/strict';
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
const unimproved = {
  ...improved,
  solvesProblem: false,
  performanceChange: 'unchanged',
  errorChange: 'unchanged',
  metrics: {},
  beforeMetrics: {},
  afterMetrics: {},
  benefitEvidence: 'no measurable improvement was observed',
};

function runner() {
  return {
    defineCalls: 0,
    run: async () => ({ ok: true, status: 'active' }),
    stop: async () => ({ ok: true }),
    undefine: async () => ({ ok: true }),
    snapshot() { return this.defined ? [{ pluginId: 'transient-plugin', packages: [] }] : []; },
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

const INPUT = {
  AGENT_ERROR: { type: 'agent/error', code: 'AGENT_ERROR', message: 'provider call failed' },
  TOOL_ERROR: { type: 'tool/error', code: 'TOOL_ERROR', message: 'tool call failed', target: 'tool:x' },
  BUILD_ERROR: { type: 'build/error', code: 'BUILD_ERROR', message: 'build failed', target: 'build:x' },
};

async function session(t, { strategies, transientRetryCooldownMs = 0 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-transient-retry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ctx = context();
  ctx.logger = { warn() {} };
  const runtime = runner();
  runtime.define = () => {
    runtime.defineCalls += 1;
    runtime.defined = true;
    return { pluginId: 'transient-plugin', packageId: 'transient-package' };
  };
  const stop = runtime.stop;
  runtime.stop = async (...args) => {
    const receipt = await stop(...args);
    runtime.defined = false;
    return receipt;
  };
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
    transientRetryCooldownMs,
    autonomousStrategies: strategies ?? {
      AGENT_ERROR: declaration('a'),
      TOOL_ERROR: declaration('b'),
      BUILD_ERROR: declaration('c'),
    },
  });
  const exec = { agent: { id: 'transient-owner' }, signal: new AbortController().signal };
  return {
    root,
    core,
    runtime,
    exec,
    observe: (code, owner = exec) => core.observeAutonomous(INPUT[code], owner),
  };
}

function deferralKey(core, code, variant) {
  return `${core.patternKey(INPUT[code])}:${core.strategyFingerprint(declaration(variant))}`;
}

function autonomousRecords(core) {
  return [...core.experiments.values()].filter((record) => record.autonomous && typeof record.autonomous === 'object');
}

/** Drive one pattern over the threshold so the next observation attempts a Trial. */
async function belowThreshold(observe, code) {
  assert.equal((await observe(code)).phase, 'pattern-observing');
}

test('a hypothesis deferred by a busy runtime resumes once the occupant is gone', async (t) => {
  const h = await session(t);

  await belowThreshold(h.observe, 'AGENT_ERROR');
  const pending = await h.observe('AGENT_ERROR');
  assert.equal(pending.phase, 'candidate-awaiting-confirmation');
  assert.equal(h.core.experiments.get(pending.experimentId).state, 'measured');

  // A different, healthy hypothesis is deferred because the measured candidate
  // still occupies the process-wide runtime. Nothing durable is learned here.
  await belowThreshold(h.observe, 'TOOL_ERROR');
  const deferred = await h.observe('TOOL_ERROR');
  assert.equal(deferred.phase, 'experiment-deferred');
  assert.equal(deferred.reason, 'transient-failure');
  assert.match(deferred.error, /occupies the runtime/);
  assert.equal(deferred.attempts, 1);
  assert.deepEqual(h.core.memory.data.entries.filter((entry) => entry.result?.state === 'failed'), []);
  assert.equal(h.core.experiments.size, 1, 'the refused attempt left no record behind');

  // The environment conflict is resolved in this very session: the owner closes
  // the pending candidate and the runtime is free again.
  const reverted = await h.core.revert({ experimentId: pending.experimentId }, h.exec);
  assert.equal(reverted.runtimeRecovered, true);
  assert.equal(h.core.targetOwners.get('plugin:fix-a'), undefined);

  // The deferred hypothesis is therefore attempted again instead of staying
  // suppressed until the process exits.
  const resumed = await h.observe('TOOL_ERROR');
  assert.equal(resumed.phase, 'candidate-awaiting-confirmation');
  assert.equal(resumed.reason, undefined);
  assert.notEqual(resumed.experimentId, pending.experimentId);
  const record = h.core.experiments.get(resumed.experimentId);
  assert.equal(record.state, 'measured');
  assert.deepEqual(record.targets, ['plugin:fix-b'], 'the retry claims the targets its declaration names');
  assert.equal(h.core.experiments.get(pending.experimentId).state, 'reverted', 'the reverted record stays as evidence');
  assert.equal(h.core.deferredPatterns.size, 0, 'the deferral is gone once the hypothesis ran');
});

test('a still-occupied runtime is retried once per cooldown, not once per event', async (t) => {
  const h = await session(t, { transientRetryCooldownMs: 60_000 });

  await belowThreshold(h.observe, 'AGENT_ERROR');
  const pending = await h.observe('AGENT_ERROR');
  assert.equal(pending.phase, 'candidate-awaiting-confirmation');

  await belowThreshold(h.observe, 'TOOL_ERROR');
  const deferred = await h.observe('TOOL_ERROR');
  assert.equal(deferred.phase, 'experiment-deferred');
  assert.equal(deferred.reason, 'transient-failure');
  assert.equal(deferred.attempts, 1);
  const definesAfterFirstAttempt = h.runtime.defineCalls;
  assert.equal(h.core.experiments.size, 1);

  // Inside the cooldown the observation reports the wait and touches nothing: no
  // Trial, no proposal, no target probe. This is what keeps an error storm from
  // re-attempting the hypothesis on every event.
  const cooled = await h.observe('TOOL_ERROR');
  assert.equal(cooled.phase, 'experiment-deferred');
  assert.equal(cooled.reason, 'transient-retry-cooldown');
  assert.equal(cooled.attempts, 1);
  assert.ok(cooled.retryAfterMs > 0 && cooled.retryAfterMs <= 60_000, `retryAfterMs was ${cooled.retryAfterMs}`);
  assert.equal(h.runtime.defineCalls, definesAfterFirstAttempt, 'no Trial inside the cooldown');
  assert.equal(h.core.experiments.size, 1, 'no accumulation of refused proposals');

  // The conflict outlives the cooldown: exactly one more attempt, which the same
  // runtime gate refuses. The attempt counter moves, the records do not.
  const key = deferralKey(h.core, 'TOOL_ERROR', 'b');
  h.core.deferredPatterns.get(key).at -= 60_000;
  const retried = await h.observe('TOOL_ERROR');
  assert.equal(retried.phase, 'experiment-deferred');
  assert.equal(retried.reason, 'transient-failure');
  assert.equal(retried.attempts, 2);
  assert.match(retried.error, /occupies the runtime/);
  assert.equal(h.runtime.defineCalls, definesAfterFirstAttempt, 'the gate refused before anything was defined');
  assert.equal(h.core.experiments.size, 1, 'one occupant, no second record');

  // Once the occupant is gone the same cooldown-bounded retry succeeds.
  const reverted = await h.core.revert({ experimentId: pending.experimentId }, h.exec);
  assert.equal(reverted.runtimeRecovered, true);
  h.core.deferredPatterns.get(key).at -= 60_000;
  const resumed = await h.observe('TOOL_ERROR');
  assert.equal(resumed.phase, 'candidate-awaiting-confirmation');
  assert.equal(h.core.experiments.get(resumed.experimentId).state, 'measured');
});

test('a recorded strategy failure still ends the hypothesis for the session', async (t) => {
  const h = await session(t, {
    strategies: { AGENT_ERROR: declaration('a', async () => unimproved) },
  });
  await belowThreshold(h.observe, 'AGENT_ERROR');
  const failed = await h.observe('AGENT_ERROR');
  assert.equal(failed.phase, 'rolled-back-no-improvement');
  for (let round = 0; round < 3; round += 1) {
    assert.equal((await h.observe('AGENT_ERROR')).phase, 'suppressed');
  }
  assert.equal(h.core.suppressedPatterns.size, 1, 'a real verdict suppresses the hypothesis');
  assert.equal(h.core.deferredPatterns.size, 0, 'a verdict supersedes any transient deferral');
  assert.equal(h.core.memory.data.entries.filter((entry) => entry.result?.state === 'failed').length, 1);
});

test('the deferral is session bookkeeping: a new session attempts the hypothesis again', async (t) => {
  const h = await session(t);
  await belowThreshold(h.observe, 'AGENT_ERROR');
  const pending = await h.observe('AGENT_ERROR');
  assert.equal(pending.phase, 'candidate-awaiting-confirmation');

  await belowThreshold(h.observe, 'TOOL_ERROR');
  const deferred = await h.observe('TOOL_ERROR');
  assert.equal(deferred.reason, 'transient-failure');
  assert.equal(h.core.deferredPatterns.size, 1);

  // Nothing durable was written about the hypothesis, so the next process (no
  // measured occupant in its own memory) attempts it on its own first observation
  // over the threshold.
  const fresh = await session(t, { strategies: { TOOL_ERROR: declaration('b') } });
  await belowThreshold(fresh.observe, 'TOOL_ERROR');
  const ran = await fresh.observe('TOOL_ERROR');
  assert.equal(ran.phase, 'candidate-awaiting-confirmation');
  assert.equal(fresh.core.experiments.get(ran.experimentId).state, 'measured');
});

test('the deferral table stays bounded like the other session tables', async (t) => {
  const h = await session(t);
  // One occupant keeps every other hypothesis deferred, so each pattern below
  // leaves exactly one deferral entry behind.
  await belowThreshold(h.observe, 'AGENT_ERROR');
  const pending = await h.observe('AGENT_ERROR');
  assert.equal(pending.phase, 'candidate-awaiting-confirmation');

  for (let index = 0; index < 205; index += 1) {
    // `autonomousStrategies` is read from the live table, so one entry per pattern
    // is enough to let every one of them reach an attempt.
    h.core.strategies[`TOOL_${index}`] = declaration(`cap${index}`);
    const input = { type: 'tool/error', code: `TOOL_${index}`, target: `tool:${index}`, message: `failure ${index}` };
    await h.core.observeAutonomous(input, h.exec);
    const deferred = await h.core.observeAutonomous(input, h.exec);
    assert.equal(deferred.reason, 'transient-failure');
  }
  assert.ok(h.core.deferredPatterns.size <= 200, `deferrals bounded, got ${h.core.deferredPatterns.size}`);
  assert.equal(h.core.experiments.size, 1, 'no refused attempt left a record behind');
  assert.equal(autonomousRecords(h.core).length, 1);
});

test('a concurrent observation of a deferred hypothesis never starts a second Trial', async (t) => {
  const h = await session(t);
  await belowThreshold(h.observe, 'AGENT_ERROR');
  const pending = await h.observe('AGENT_ERROR');
  assert.equal(pending.phase, 'candidate-awaiting-confirmation');

  // B is deferred because the measured candidate occupies the runtime, then that
  // conflict is resolved before B is observed again.
  await belowThreshold(h.observe, 'TOOL_ERROR');
  assert.equal((await h.observe('TOOL_ERROR')).reason, 'transient-failure');
  const reverted = await h.core.revert({ experimentId: pending.experimentId }, h.exec);
  assert.equal(reverted.runtimeRecovered, true);

  // Two observers answer the same event concurrently. The in-process `observing`
  // claim is what keeps the retry from becoming two Trials on one hypothesis.
  const definesBefore = h.runtime.defineCalls;
  const [first, second] = await Promise.all([h.observe('TOOL_ERROR'), h.observe('TOOL_ERROR')]);
  assert.deepEqual([first.phase, second.phase].sort(), ['candidate-awaiting-confirmation', 'observing']);
  const runs = [...h.core.experiments.values()].filter((record) => record.autonomous);
  assert.equal(runs.length, 2, 'one reverted record for A and one measured record for B');
  assert.equal(h.runtime.defineCalls, definesBefore + 1, 'one Trial for the retry');
  assert.equal(runs.filter((record) => record.state === 'measured').length, 1);
});
