// The autonomous loop's continuity contract.
//
// What is being pinned here is one closed loop: failure observation -> pattern ->
// strategy -> isolated Trial -> measurement -> failure learning -> next decision.
// The defects these tests describe are all cross-session or repeat-decision
// defects, so every assertion below is about *state*: which experiment exists,
// what went into the durable failure memory, and whether a later session retries
// a hypothesis that is already answered.
//
// Before the fix, all of the following were observed on this same fixture:
//   * a second observation of a pattern whose Trial was already measured started
//     a second experiment, could not claim the target it already owned, and wrote
//     `unsafe parallel experiment conflicts on plugin:fix-x` into the durable
//     failure memory as a `runtime-trial` failure - permanently suppressing the
//     strategy that had just passed every evidence gate;
//   * a *changed* declaration for the same pattern stayed suppressed in every
//     later session, although the recorded `prevention` promises release once a
//     new strategy is supplied;
//   * an environment failure (target claim held by another experiment) became a
//     durable "this strategy does not work" record;
//   * a `measure` error left the Trial mounted and its target claim on disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { EvolutionOrchestrator } from '../lib/orchestrator.js';
import { apply } from '../lib/registration.js';
import { context } from './fixtures/runtime-inspect.mjs';

const SESSION = fileURLToPath(new URL('./fixtures/autonomous-session.mjs', import.meta.url));

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

async function scratch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-autonomous-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function runner() {
  return {
    snapshot: () => [],
    define: () => ({ pluginId: 'session-plugin', packageId: 'session-package' }),
    run: async () => ({ ok: true, status: 'active' }),
    stop: async () => ({ ok: true }),
    undefine: async () => ({ ok: true }),
  };
}

function declaration(variant, overrides = {}) {
  return {
    risk: 'low',
    target: `plugin:fix-${variant}`,
    idPrefix: `fix${variant}`,
    composition: { name: `fix-${variant}`, purpose: 'narrow the failing path', code: { host: `return { variant: "${variant}" };` } },
    measure: async () => improved,
    ...overrides,
  };
}

function session(root, { strategies, overrides = {}, runner: runnerOverride } = {}) {
  const ctx = context();
  ctx.logger = { warn() {} };
  ctx.dynamicCordisRunner = runnerOverride ?? runner();
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
    autonomousStrategies: strategies ?? { AGENT_ERROR: declaration('a') },
    ...overrides,
  });
  const exec = { agent: { id: 'continuity-owner' }, signal: new AbortController().signal };
  const input = { type: 'agent/error', code: 'AGENT_ERROR', message: 'provider call failed' };
  return { core, exec, input, observe: () => core.observeAutonomous(input, exec) };
}

/** The durable "do not repeat this" records, newest last. */
function durableFailures(core) {
  return core.memory.data.entries.filter((entry) => entry.result?.state === 'failed');
}

function runSessionProcess(root, settings) {
  const child = spawnSync(process.execPath, [SESSION, JSON.stringify({ root, ...settings })], { encoding: 'utf8' });
  assert.equal(child.status, 0, `session process failed: ${child.stderr}`);
  const output = child.stdout.trim().split('\n').filter(Boolean).at(-1);
  assert.ok(output, 'the session printed a summary');
  return JSON.parse(output);
}

// ---------------------------------------------------------------------------
// One hypothesis, one live experiment
// ---------------------------------------------------------------------------

test('a measured candidate is reported by later observations instead of being re-experimented', async (t) => {
  const root = await scratch(t);
  const { core, observe } = session(root);

  assert.equal((await observe()).phase, 'pattern-observing');
  const first = await observe();
  assert.equal(first.phase, 'candidate-awaiting-confirmation');
  assert.equal(first.automatic, false, 'the observer never approves production itself');
  assert.equal(first.gates.eligible, true, 'all eight evidence gates are satisfied by the measurement');
  assert.equal(first.recommendation.confirmationRequired, true);

  const again = await observe();
  assert.equal(again.phase, 'candidate-awaiting-confirmation');
  assert.equal(again.experimentId, first.experimentId, 'the same experiment is reported, not a replacement');
  assert.equal(again.reason, 'already-measured-awaiting-owner');
  assert.deepEqual(again.gates, first.gates, 'the reported evidence is the measured evidence');

  assert.equal(core.experiments.size, 1, 'exactly one experiment exists for the hypothesis');
  assert.deepEqual(durableFailures(core), [], 'a successful measurement writes no failure record');
  assert.equal(core.suppressedPatterns.size, 0, 'nothing is suppressed');
  const ownership = await fs.readdir(core.paths.ownershipDir);
  assert.equal(ownership.length, 1, 'the target stays claimed by the pending experiment');
});

test('the pending candidate keeps its identity when its candidate view was pruned', async (t) => {
  const root = await scratch(t);
  const { core, observe, input, exec } = session(root);
  await observe();
  const first = await observe();

  // Evict the candidate view the way the bounded table does, without touching
  // the experiment: the pending check reads the experiment, not the view.
  core.candidates.clear();
  const again = await observe();
  assert.equal(again.phase, 'candidate-awaiting-confirmation');
  assert.equal(again.experimentId, first.experimentId);
  assert.equal(again.candidate.candidateId, first.candidate.candidateId);
  assert.equal(again.candidate.experimentId, first.experimentId);
  void input; void exec;
});

test('reverting the pending candidate re-opens the hypothesis for a new trial', async (t) => {
  const root = await scratch(t);
  const { core, observe, exec } = session(root);
  await observe();
  const pending = await observe();

  const reverted = await core.revert({ experimentId: pending.experimentId }, exec);
  assert.equal(reverted.runtimeRecovered, true);
  assert.equal(core.experiments.get(pending.experimentId).state, 'reverted');

  const next = await observe();
  assert.equal(next.phase, 'candidate-awaiting-confirmation');
  assert.notEqual(next.experimentId, pending.experimentId, 'a reverted candidate no longer answers for the hypothesis');
  assert.equal(core.experiments.get(pending.experimentId).state, 'reverted', 'the reverted record is left as evidence');
});

// ---------------------------------------------------------------------------
// Cross-session failure learning
// ---------------------------------------------------------------------------

test('a failing declaration is not retried by the next session, a changed one is', async (t) => {
  const root = await scratch(t);

  const first = runSessionProcess(root, { kind: 'unimproved', variant: 'a', rounds: 3 });
  assert.deepEqual(first.phases.map((entry) => entry.phase), [
    'pattern-observing',
    'rolled-back-no-improvement',
    'suppressed',
  ], 'one attempt, then the session stops repeating it');
  assert.equal(first.phases[1].cleanup, 'recovered', 'the gate path reverted the trial and proved recovery');
  assert.deepEqual(first.experiments.map((entry) => entry.state), ['reverted'], 'no trial is left mounted');
  const recorded = first.memory.filter((entry) => entry.strategy !== null);
  assert.equal(recorded.length, 1, 'the failure is recorded durably against its hypothesis');
  assert.match(recorded[0].summary, /no improvement/i);

  const second = runSessionProcess(root, { kind: 'unimproved', variant: 'a', rounds: 3 });
  assert.deepEqual(second.phases.map((entry) => [entry.phase, entry.reason]), [
    ['pattern-observing', null],
    ['suppressed', 'failure-memory'],
    ['suppressed', 'duplicate-failure'],
  ], 'the next session reads the recorded failure instead of re-running the experiment');
  assert.equal(second.experiments.length, 0, 'no experiment was started in the second session');

  const third = runSessionProcess(root, { kind: 'improved', variant: 'b', rounds: 3 });
  assert.deepEqual(third.phases.map((entry) => entry.phase), [
    'pattern-observing',
    'candidate-awaiting-confirmation',
    'candidate-awaiting-confirmation',
  ], 'a changed declaration is a new hypothesis and is actually attempted');
  assert.equal(third.phases[2].reason, 'already-measured-awaiting-owner');
  assert.equal(third.experiments.length, 1);
});

test('the durable failure identity is the declaration, not the pattern', async (t) => {
  const root = await scratch(t);
  const { core } = session(root);
  const sameDeclaration = declaration('a');
  const fromAnotherCallback = declaration('a', { measure: async () => unimproved });
  assert.equal(
    core.strategyFingerprint(sameDeclaration),
    core.strategyFingerprint(fromAnotherCallback),
    'a measurement callback alone is not a new hypothesis: it cannot outlive the process',
  );
  assert.notEqual(core.strategyFingerprint(declaration('a')), core.strategyFingerprint(declaration('b')));
  assert.notEqual(
    core.strategyFingerprint(declaration('a')),
    core.strategyFingerprint(declaration('a', { composition: { name: 'fix-a', purpose: 'p', code: { host: 'return { variant: "a2" };' } } })),
    'changed Host code is a new hypothesis',
  );
  assert.match(core.strategyFingerprint(sameDeclaration), /^[0-9a-f]{64}$/);
  // `targets` is the object form `{ components, plugins, configurations }`, not a
  // string array: reading it as one dropped it from the identity entirely.
  assert.notEqual(
    core.strategyFingerprint(declaration('a', { targets: { plugins: ['target-a'] } })),
    core.strategyFingerprint(declaration('a', { targets: { plugins: ['target-b'] } })),
    'the declared targets are part of the identity',
  );
  assert.notEqual(
    core.strategyFingerprint(declaration('a', { targets: { plugins: ['target-a'] } })),
    core.strategyFingerprint(declaration('a', { targets: { components: ['target-a'] } })),
    'the kind of the declared target is part of the identity',
  );
  assert.equal(
    core.strategyFingerprint(declaration('a', { targets: { plugins: ['target-b', 'target-a'] } })),
    core.strategyFingerprint(declaration('a', { targets: { plugins: ['target-a', 'target-b'] } })),
    'the order the targets are declared in is not part of the identity',
  );

  // Unreadable declarations cannot be compared, but they must not throw out of
  // the observer either.
  const hostile = Object.defineProperty({}, 'target', { get() { throw new Error('unreadable'); } });
  assert.match(core.strategyFingerprint(hostile), /^[0-9a-f]{64}$/);
});

test('a changed declaration is attempted in the same session, the unchanged one stays suppressed', async (t) => {
  const root = await scratch(t);
  const { core, observe } = session(root, { strategies: { AGENT_ERROR: declaration('a', { measure: async () => unimproved }) } });

  assert.equal((await observe()).phase, 'pattern-observing');
  assert.equal((await observe()).phase, 'rolled-back-no-improvement');
  assert.equal((await observe()).phase, 'suppressed');

  core.strategies.AGENT_ERROR = declaration('b', { measure: async () => unimproved });
  assert.equal((await observe()).phase, 'rolled-back-no-improvement', 'the new declaration is attempted');

  core.strategies.AGENT_ERROR = declaration('a', { measure: async () => unimproved });
  assert.equal((await observe()).phase, 'suppressed', 'the original declaration is still the failed one');
  assert.equal(durableFailures(core).length, 2, 'each hypothesis keeps its own durable failure record');
});

// ---------------------------------------------------------------------------
// Environment failures never become strategy verdicts
// ---------------------------------------------------------------------------

test('a failure that only says the target is taken is deferred, not recorded', async (t) => {
  const root = await scratch(t);
  const { core, observe, exec } = session(root);
  const target = 'plugin:fix-a';
  const claimFile = path.join(core.paths.ownershipDir, `${crypto.createHash('sha256').update(target).digest('hex')}.json`);
  await fs.mkdir(core.paths.ownershipDir, { recursive: true });
  // A claim owned by this live process stands for "another experiment is running
  // on this target"; the conflict is the same one a concurrent session produces.
  await fs.writeFile(claimFile, `${JSON.stringify({
    schema: 1, target, experimentId: 'exp-elsewhere', ownerId: 'other-agent',
    pid: process.pid, hostname: os.hostname(), acquiredAt: new Date().toISOString(),
  })}\n`);

  assert.equal((await observe()).phase, 'pattern-observing');
  const deferred = await observe();
  assert.equal(deferred.phase, 'experiment-deferred');
  assert.equal(deferred.reason, 'transient-failure');
  assert.match(deferred.error, /unsafe parallel experiment conflicts/);
  assert.deepEqual(durableFailures(core), [], 'the environment, not the strategy, failed');
  assert.equal(core.inspect(exec.agent).evolutionObservations.length >= 2, true);

  // The next session retries: nothing durable claims the strategy is wrong.
  await fs.rm(claimFile, { force: true });
  const revived = session(root);
  assert.equal((await revived.observe()).phase, 'pattern-observing');
  assert.equal((await revived.observe()).phase, 'candidate-awaiting-confirmation');
});

test('a throwing trial is recorded as a strategy failure with its cleanup outcome', async (t) => {
  const root = await scratch(t);
  const failingRunner = { ...runner(), run: async () => { throw new Error('trial activation failed'); } };
  const { core, observe } = session(root, { runner: failingRunner });
  await observe();
  const failed = await observe();
  assert.equal(failed.phase, 'rolled-back-no-improvement');
  assert.equal(failed.errorCategory, 'runtime-trial');
  const entries = durableFailures(core);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].result.cleanup, 'not-run', 'the Trial never activated, so nothing needed reverting');
  assert.equal(entries[0].experiment.strategy, failed.strategyFingerprint, 'the record names the hypothesis it refutes');
});

test('an error after the Trial is up reverts it and keeps the target claim safe', async (t) => {
  const root = await scratch(t);
  const { core, observe } = session(root, { strategies: { AGENT_ERROR: declaration('a', {
    measure: async () => { throw new Error('measurement could not be computed'); },
  }) } });
  await observe();
  const failed = await observe();
  assert.equal(failed.phase, 'rolled-back-no-improvement');
  assert.equal(failed.cleanup.status, 'recovered', 'the mounted Trial was disposed instead of being leaked');
  const [record] = [...core.experiments.values()];
  assert.equal(record.state, 'reverted');
  assert.deepEqual(await fs.readdir(core.paths.ownershipDir), [], 'the target claim is released with the runtime');
  const entries = durableFailures(core);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].result.cleanup, 'recovered');
});

// ---------------------------------------------------------------------------
// Concurrency and bounded state
// ---------------------------------------------------------------------------

test('two concurrent observations of one hypothesis run a single trial', async (t) => {
  const root = await scratch(t);
  const { core, observe } = session(root);
  await observe();
  const results = await Promise.all([observe(), observe()]);
  const phases = results.map((result) => result.phase).sort();
  assert.ok(phases.includes('observing'), `one observer is in flight: ${phases.join(',')}`);
  assert.equal(core.experiments.size, 1, 'no second experiment was proposed');
  assert.deepEqual(durableFailures(core), [], 'the loser of the race records nothing');
  assert.equal(core.observing.size, 0, 'the in-flight mark is released');
});

test('the per-pattern tables stay bounded while the failure learning is untouched', async (t) => {
  const root = await scratch(t);
  const { core, observe } = session(root, { strategies: {} });
  for (let index = 0; index < 205; index += 1) {
    const input = { type: 'tool/error', code: `TOOL_${index}`, target: `tool:${index}`, message: `failure ${index}` };
    // Two observations per pattern put the pattern over the threshold and
    // therefore create a candidate as well.
    await core.observeAutonomous(input, { agent: { id: 'continuity-owner' }, signal: new AbortController().signal });
    const result = await core.observeAutonomous(input, { agent: { id: 'continuity-owner' }, signal: new AbortController().signal });
    assert.equal(result.phase, 'candidate', 'no strategy means no Trial');
  }
  assert.ok(core.patterns.size <= 200, `patterns bounded, got ${core.patterns.size}`);
  assert.ok(core.candidates.size <= 200, `candidates bounded, got ${core.candidates.size}`);
  assert.ok(core.observations.length <= 200);
  void observe;
});

test('repeated identical events count as repeats until the pattern is answered', async (t) => {
  const root = await scratch(t);
  const { core, observe } = session(root, { strategies: { AGENT_ERROR: declaration('a', { measure: async () => unimproved }) } });
  assert.equal((await observe()).phase, 'pattern-observing');
  assert.equal((await observe()).phase, 'rolled-back-no-improvement');
  for (let round = 0; round < 5; round += 1) {
    assert.equal((await observe()).phase, 'suppressed');
  }
  assert.equal(core.experiments.size, 1, 'a proven failure is not re-run by repeated deliveries');
  assert.equal(durableFailures(core).length, 1, 'nor is it recorded again and again');
});

// ---------------------------------------------------------------------------
// End to end through the registered listener
// ---------------------------------------------------------------------------

/**
 * A session built the way the bundle builds it: `apply()` registers the tools and
 * the `agent/error` listener, and the listener calls `observeAutonomous`. The
 * listener is fire-and-forget, so this wrapper captures the promise it starts;
 * without that, a test would have to guess how many macrotasks it takes.
 */
function listenedSession(root, strategies) {
  const listeners = new Map();
  const ctx = {
    dynamicCordisRunner: runner(),
    tools: { register: () => {} },
    systemPrompt: { section: () => {} },
    on: (event, listener) => listeners.set(event, listener),
    logger: { warn() {} },
    registry: { values: () => [] },
    emit() {},
  };
  const core = apply(ctx, {
    presetDir: root,
    startupDrift: false,
    eventBridgePath: path.join(root, 'events.jsonl'),
    eventBridgeKey: 'k'.repeat(32),
    driftStatePath: path.join(root, 'drift.json'),
    memoryPath: path.join(root, 'memory.json'),
    patternThreshold: 2,
    mode: 'autonomous',
    unattended: true,
    autonomousStrategies: strategies,
  });
  const inFlight = [];
  const observe = core.observeAutonomous.bind(core);
  core.observeAutonomous = (...args) => {
    const started = observe(...args);
    inFlight.push(started);
    return started;
  };
  const emitError = async () => {
    const error = new Error('provider call failed');
    error.code = 'AGENT_ERROR';
    listeners.get('agent/error')({ agent: { id: 'continuity-owner' }, error, signal: new AbortController().signal });
    // The listener is fire-and-forget and awaits one microtask before it starts
    // the observation, so wait for the promise it actually started instead of
    // guessing how many turns that takes.
    for (let turn = 0; turn < 100; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      if (inFlight.length === 0) break;
      await Promise.all(inFlight.splice(0));
    }
    return core;
  };
  return { core, emitError };
}

test('end to end: the recorded failure stops the next session, a new declaration still runs', async (t) => {
  const root = await scratch(t);
  const first = listenedSession(root, { AGENT_ERROR: declaration('a', { measure: async () => unimproved }) });
  await first.emitError();
  assert.equal(first.core.memory.data.entries.filter((entry) => entry.experiment?.strategy).length, 0, 'one occurrence is below the threshold');
  await first.emitError();
  const recorded = first.core.memory.data.entries.filter((entry) => entry.experiment?.strategy);
  assert.equal(recorded.length, 1, 'the second occurrence ran the Trial and learned from its failure');
  assert.match(recorded[0].result.errorSummary, /no improvement/i);

  // A new session on the same data root: the same declaration is answered by the
  // recorded failure, so no experiment is proposed at all.
  const second = listenedSession(root, { AGENT_ERROR: declaration('a', { measure: async () => unimproved }) });
  await second.emitError();
  await second.emitError();
  assert.equal(second.core.experiments.size, 0, 'the recorded failure stops a pointless retry');
  assert.equal(second.core.suppressedPatterns.size, 1);

  // ... and it does not stop a legitimately different hypothesis.
  const third = listenedSession(root, { AGENT_ERROR: declaration('b') });
  await third.emitError();
  await third.emitError();
  assert.equal(third.core.experiments.size, 1, 'a new declaration is a new hypothesis');
  const [record] = [...third.core.experiments.values()];
  assert.equal(record.state, 'measured', 'and it is left waiting for its owner');
  assert.equal(record.autonomous.strategyFingerprint, third.core.strategyFingerprint(declaration('b')));
});

// ---------------------------------------------------------------------------
// Only the declared targets change
// ---------------------------------------------------------------------------

test('changing only the declared targets is a new hypothesis for the next session', async (t) => {
  const root = await scratch(t);
  const scoped = (pluginTarget) => declaration('a', {
    target: 'plugin:base',
    targets: { plugins: [pluginTarget] },
    measure: async () => unimproved,
  });

  const first = session(root, { strategies: { AGENT_ERROR: scoped('target-a') } });
  assert.equal((await first.observe()).phase, 'pattern-observing');
  assert.equal((await first.observe()).phase, 'rolled-back-no-improvement');

  const changed = session(root, { strategies: { AGENT_ERROR: scoped('target-b') } });
  assert.equal((await changed.observe()).phase, 'pattern-observing');
  assert.equal((await changed.observe()).phase, 'rolled-back-no-improvement', 'the changed targets are attempted');

  const unchanged = session(root, { strategies: { AGENT_ERROR: scoped('target-a') } });
  assert.equal((await unchanged.observe()).phase, 'pattern-observing');
  assert.equal((await unchanged.observe()).phase, 'suppressed', 'the original targets are still the failed ones');
});

test('a measured candidate is not offered for a declaration with different targets', async (t) => {
  const root = await scratch(t);
  const scoped = (pluginTarget) => declaration('a', { target: 'plugin:base', targets: { plugins: [pluginTarget] } });
  // One session, so the pending experiment is present in `this.experiments`: the
  // pending check reads the live experiment, and a declaration that only changed
  // its declared targets must not be answered with the experiment of the old one.
  const { core, observe } = session(root, { strategies: { AGENT_ERROR: scoped('target-a') } });
  await observe();
  const pending = await observe();
  assert.equal(pending.phase, 'candidate-awaiting-confirmation');
  assert.deepEqual(core.experiments.get(pending.experimentId).targets, ['plugin:target-a']);

  core.strategies.AGENT_ERROR = scoped('target-b');
  const next = await observe();
  assert.equal(next.phase, 'candidate-awaiting-confirmation');
  assert.notEqual(next.experimentId, pending.experimentId, 'the old experiment tested a different target set');
  assert.deepEqual(
    core.experiments.get(next.experimentId).targets,
    ['plugin:target-b'],
    'and the new experiment claims the targets the declaration names',
  );
});
