// Propose–Probe–Compose lifecycle regressions.
//
// These tests exercise the orchestrator's real control flow (propose → probe
// baseline → trial → probe candidate → measure → promote/revert) against a fake
// official tool pipeline and a fake Cordis runner, so the evidence gates,
// decisions, conclusions and archive persistence are exercised without a host.
// Synthetic state only: every path lives under a fresh os.tmpdir() directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  EvolutionOrchestrator,
  applicabilityFromVersions,
  applicabilityKnown,
  classifyExperimentDecision,
  compareProbeRuns,
  conclusionKindFor,
  deriveProbeObservation,
  hydrateRecordFromSnapshot,
  mergeEvidenceSources,
  normalizeProbeScenario,
  persistEvidenceSnapshot,
  probeScenarioDigest,
  probeSummary,
  renderExperimentArchive,
  snapshotEvidenceFromRecord,
} from '../lib/orchestrator.js';
import { openSharedExperience } from '../lib/shared-experience.js';
import { strategyFingerprint } from '../lib/experience-plan.js';
import {
  execFor,
  exists,
  orchestratorContext,
  promotionPaths,
  scratchRoot,
  unitPromotionRuntime,
} from './orchestrator-durability-fixtures.mjs';

// The applicability triple an injected runtime proves. `host` maps to `dsh`.
const HOST_VERSIONS = Object.freeze({ host: '1.30.0', cordis: '4.1.0', evolution: '0.3.0' });
const APPLICABILITY = Object.freeze({ dsh: '1.30.0', cordis: '4.1.0', evolution: '0.3.0' });
const TARGET = 'tool:edge-cache';
// The canonical problem identity: the store normalizes the target text.
const PROBLEM_KEY = 'tool edge-cache';
const STRATEGY = 'prewarm the cache before the first read';
const ALTERNATIVE_STRATEGY = 'serialize the cache warm-up and retry the first read';
const ROOT_CAUSE = 'the cache is populated lazily on the second read';
const DIFFERENT_VERSIONS = Object.freeze({ dsh: '9.9.9', cordis: '4.0.0', evolution: '0.2.0' });

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

/** One fixed scenario: a target step that must start failing, a control step
 *  whose returned value must stay identical. */
function probeScenario(overrides = {}) {
  return {
    id: 'edge-cache-first-read',
    repetitions: 2,
    steps: [
      { name: 'probe-target', role: 'target', arguments: { key: 'edge' } },
      { name: 'probe-control', role: 'control', arguments: {} },
    ],
    ...overrides,
  };
}

/** Minimal cordis-runner facade: define/run/stop/undefine all succeed and the
 *  snapshot stays empty, so the pre-Trial baseline and the post-dispose runtime
 *  compare equal. */
function fakeRunner() {
  let sequence = 0;
  return {
    define() {
      sequence += 1;
      return { pluginId: `plugin-${sequence}`, packageId: `package-${sequence}` };
    },
    async run() { return { ok: true, status: 'running', pluginRunId: 'run-1' }; },
    async stop() { return { ok: true }; },
    async undefine() { return { ok: true }; },
    snapshot() { return []; },
  };
}

/**
 * One orchestrator over a throw-away promotion root and a real shared store.
 * `state` drives the fake tool pipeline between phases; `calls` records every
 * call the probe made through `ctx.tools.execute`.
 */
async function createHarness(t, name, options = {}) {
  const root = await scratchRoot(`experience-evolution-${name}`);
  const paths = promotionPaths(root);
  const sharePath = path.join(root, 'shared-experience', 'experience.sqlite');
  const store = openSharedExperience(path.dirname(sharePath));
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const warnings = [];
  const calls = [];
  const state = { targetFails: true, controlFails: false, controlValue: { ok: true } };
  const execute = async ({ calls: batch }) => {
    const call = batch[0];
    calls.push({ name: call.name, arguments: call.arguments, id: call.id });
    const result = call.name === 'probe-target'
      ? state.targetFails
        ? { isError: true, error: { code: 'E_TARGET_FAILED' } }
        : { isError: false, value: { ok: true } }
      : state.controlFails
        ? { isError: true, error: { code: 'E_CONTROL_FAILED' } }
        : { isError: false, value: structuredClone(state.controlValue) };
    return { results: [{ callId: call.id, result }] };
  };
  const runner = fakeRunner();
  const ctx = orchestratorContext(warnings);
  // Probe steps must resolve to a definition that opts into the official
  // concurrency-safe contract; the default fixture tools do.
  const probeDefinitions = new Map([
    ['probe-target', { name: 'probe-target', isConcurrencySafe: () => true }],
    ['probe-control', { name: 'probe-control', isConcurrencySafe: () => true }],
  ]);
  ctx.tools = {
    schemas: () => [],
    register() {},
    execute,
    get: (name) => probeDefinitions.get(name),
  };
  ctx.dynamicCordisRunner = runner;
  const orchestrator = new EvolutionOrchestrator(ctx, {
    ...paths,
    promotionRuntime: options.promotionRuntime ?? unitPromotionRuntime(),
    sharedExperience: store,
    runtimeVersions: options.versions ?? HOST_VERSIONS,
    // A deterministic auxiliary sink: the event bridge is not what this file
    // tests, and the real bridge would only add file I/O under the temp root.
    eventBridge: { emit: () => ({ audit: { at: '2026-01-01T00:00:00.000Z' } }) },
    ...(options.config ?? {}),
  });
  return { root, paths, store, sharePath, warnings, calls, state, runner, ctx, orchestrator, exec: execFor() };
}

/** Seed `count` real failure facts for one target into the shared store. */
function seedFailures(store, target, count = 3) {
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    const id = sha256(`failure:${target}:${index}`);
    ids.push(id);
    store.recordFailure({ id, type: 'tool/error', code: 'E_TOOL_FAILED', target });
  }
  return ids;
}

let conclusionSequence = 0;
/** Record one structured conclusion the way a previous lifecycle round would. */
function recordConclusion(store, { target, strategy, decision, applicability = APPLICABILITY, at = '2026-01-05T00:00:00.000Z' }) {
  conclusionSequence += 1;
  return store.recordConclusion({
    experimentId: `exp-conclusion-${process.pid}-${conclusionSequence}`,
    target,
    strategy,
    strategyFingerprint: strategyFingerprint(target, strategy),
    decision,
    applicability,
    occurredAt: at,
    rootCause: 'recorded by the lifecycle regression test',
  }, '/tmp/evolution-lifecycle-origin.jsonl');
}

/** Propose the canonical experiment and return its id (proposal must succeed). */
async function proposeExperiment(h, overrides = {}) {
  const result = h.orchestrator.propose({
    target: TARGET,
    strategy: STRATEGY,
    rootCause: ROOT_CAUSE,
    why: 'the first cache read keeps failing across sessions',
    impactScope: ['test'],
    successMetrics: ['successRate'],
    ...overrides,
  }, h.exec);
  assert.equal(result.ok, true, `proposal failed: ${JSON.stringify(result)}`);
  return result.experimentId;
}

function runBaseline(h, experimentId, scenario = probeScenario()) {
  return h.orchestrator.probe({ experimentId, phase: 'baseline', scenario }, h.exec);
}

function startTrial(h, experimentId) {
  return h.orchestrator.trial({
    experimentId,
    composition: {
      name: 'edge-cache-prewarm',
      purpose: 'probe the first read before and after the change',
      code: { host: 'return { name: "edge-cache-prewarm", apply() {} };' },
    },
  }, h.exec);
}

function runCandidate(h, experimentId, scenario = probeScenario()) {
  return h.orchestrator.probe({ experimentId, phase: 'candidate', scenario }, h.exec);
}

/** The measurement side of an eligible experiment. The caller-authored
 *  benefit fields are deliberately not trusted by `measure()` when a probe ran. */
function measuredObservation(overrides = {}) {
  return {
    solvesProblem: true,
    sideEffects: [],
    orphanResources: [],
    reversible: true,
    cleanupEvidence: 'Cordis stop+undefine proved the Trial was disposed',
    regressionPassed: true,
    ...overrides,
  };
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code, `expected ${code}, got ${error?.code}: ${error?.message}`);
    return true;
  });
}

function throwsScenarioError(fn) {
  assert.throws(fn, (error) => {
    assert.equal(error?.code, 'E_EVOLUTION_PROBE_SCENARIO', `expected E_EVOLUTION_PROBE_SCENARIO, got ${error?.code}`);
    return true;
  });
}

/** Build one probe phase's raw sample rows from per-step outcomes. */
function probeRows(spec) {
  const rows = [];
  spec.forEach((entry, index) => {
    entry.results.forEach((outcome, repetition) => {
      const base = { repetition, index, step: entry.step, role: entry.role, durationMs: 1 };
      if (outcome && outcome.error) rows.push({ ...base, isError: true, code: outcome.error, valueDigest: null });
      else rows.push({ ...base, isError: false, code: null, valueDigest: `sha256:${sha256(JSON.stringify(outcome.value))}` });
    });
  });
  return { at: '2026-01-01T00:00:00.000Z', samples: rows, summary: probeSummary({ samples: rows }) };
}

const control = (results) => ({ step: 'probe-control', role: 'control', results });
const target = (results) => ({ step: 'probe-target', role: 'target', results });
const ok = (value) => ({ value });
const failure = (code) => ({ error: code });

// ---------------------------------------------------------------------------
// 1. The benefit loop: failure facts → plan → propose → measured benefit →
//    explicit-confirmation gate → revert records `reverted-unconfirmed`.
// ---------------------------------------------------------------------------

test('benefit loop: plan selects the seeded failure, probe derives the measurement, promote waits for the owner, revert records reverted-unconfirmed', async (t) => {
  const h = await createHarness(t, 'benefit');
  const failureIds = seedFailures(h.store, TARGET, 3);

  // --- plan ---------------------------------------------------------------
  const plan = h.orchestrator.plan({ focus: 'edge-cache' }, h.exec);
  assert.equal(plan.ok, true);
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.none, null);
  const planned = plan.selected;
  assert.equal(planned.problemKey, PROBLEM_KEY);
  assert.equal(planned.occurrences, 3);
  assert.equal(planned.evidenceRefs.length, 3);
  // The knowledge projection cites the recorded events by source-qualified id.
  assert.deepEqual([...planned.evidenceRefs].sort(), failureIds.map((id) => `observations:${id}`).sort());
  assert.equal(planned.requiresNewHypothesis, false);
  assert.equal(planned.applicabilityVerified, true);
  assert.deepEqual(planned.applicability, APPLICABILITY);
  assert.equal(plan.sources.shared, 1);
  assert.equal(plan.sources.failureMemory, 0);

  // --- propose + baseline probe ------------------------------------------
  const experimentId = await proposeExperiment(h);
  assert.equal(h.orchestrator.experiments.get(experimentId).state, 'proposed');

  const scenario = probeScenario();
  const baseline = await runBaseline(h, experimentId, scenario);
  assert.equal(baseline.ok, true);
  assert.equal(baseline.phase, 'baseline');
  assert.equal(baseline.comparison, null);
  assert.equal(baseline.samples.length, 4);
  assert.equal(baseline.baseline.executions, 4);
  assert.equal(baseline.baseline.successes, 2);
  assert.equal(baseline.baseline.errors, 2);
  assert.deepEqual(baseline.versions, APPLICABILITY);
  assert.match(baseline.scenarioDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(h.calls.length, 4);

  // --- trial + candidate probe -------------------------------------------
  const trial = await startTrial(h, experimentId);
  assert.equal(trial.ok, true);
  assert.equal(trial.phase, 'trial');
  assert.equal(h.orchestrator.experiments.get(experimentId).state, 'trial');

  h.state.targetFails = false;
  const candidate = await runCandidate(h, experimentId, scenario);
  assert.equal(candidate.phase, 'candidate');
  assert.equal(candidate.scenarioDigest, baseline.scenarioDigest);
  assert.equal(candidate.baselineSamples.length, 4);
  assert.equal(candidate.samples.length, 4);
  assert.equal(candidate.comparison.benefit, true);
  assert.equal(candidate.comparison.regression, false);
  assert.equal(candidate.comparison.controlStable, true);
  assert.equal(candidate.comparison.repeatable, true);
  assert.equal(candidate.comparison.targetImproved, 1);
  assert.deepEqual(candidate.comparison.beforeMetrics, { successRate: 0.5, errorCount: 2 });
  assert.deepEqual(candidate.comparison.afterMetrics, { successRate: 1, errorCount: 0 });

  // --- measure: the probe is authoritative, the caller is not -------------
  const measurement = h.orchestrator.measure({
    experimentId,
    observation: measuredObservation({
      // Every one of these caller claims contradicts the probe.
      solvesProblem: false,
      repeatable: false,
      beforeMetrics: { successRate: 0, errorCount: 99 },
      afterMetrics: { successRate: 0, errorCount: 99 },
      sampleCount: 1,
      observationWindow: 'caller-declared-window',
      metrics: { callerMetric: 7 },
    }),
  }, h.exec);
  assert.equal(measurement.phase, 'measured');
  const observation = measurement.observation;
  assert.equal(observation.probeDerived, true);
  assert.deepEqual(observation.beforeMetrics, { successRate: 0.5, errorCount: 2 });
  assert.deepEqual(observation.afterMetrics, { successRate: 1, errorCount: 0 });
  assert.equal(observation.sampleCount, 4);
  assert.equal(observation.observationWindow, `probe:${scenario.id}`);
  assert.equal(observation.solvesProblem, true);
  assert.equal(observation.repeatable, true);
  assert.equal(observation.regressionPassed, true);
  // The caller's metric object is unverified input: the derived branch keeps
  // only the probe's own counts, so a forged number cannot reach the gates or
  // the advisory evaluator.
  assert.deepEqual(observation.metrics, { probeBenefit: 1, probeControlStable: 1 });
  assert.equal(observation.metrics.probeBenefit, 1);
  assert.equal(measurement.gates.measuredEvidence, true);
  assert.equal(measurement.gates.realBenefit, true);
  assert.equal(measurement.gates.repeatable, true);
  assert.equal(measurement.gates.regressionTest, true);
  assert.equal(measurement.gates.eligible, true);
  assert.equal(measurement.gates.runtimeRecovered, false);
  assert.equal(measurement.decision.kind, 'benefit');
  assert.equal(measurement.decision.eligible, true);
  assert.equal(measurement.decision.source, 'measure');
  assert.equal(measurement.decision.probe.scenarioId, scenario.id);
  assert.equal(measurement.decision.probe.benefit, true);
  assert.equal(measurement.decision.probe.controlStable, true);
  assert.equal(h.orchestrator.experiments.get(experimentId).state, 'measured');

  // --- promotion without explicit confirmation writes nothing --------------
  const pending = await h.orchestrator.promote({ experimentId }, h.exec);
  assert.equal(pending.ok, false);
  assert.equal(pending.phase, 'awaiting-owner-confirmation');
  assert.equal(pending.reason, 'explicit_user_confirmation_required_for_production_promotion');
  assert.equal(pending.gates.eligible, true);
  assert.equal(await exists(h.paths.compositionPath), false);
  assert.equal(await exists(h.paths.pluginRoot), false);
  assert.equal(await exists(h.paths.promotionStateDir), false);
  assert.equal(h.orchestrator.experiments.get(experimentId).state, 'measured');

  // --- revert -------------------------------------------------------------
  const reverted = await h.orchestrator.revert({ experimentId }, h.exec);
  assert.equal(reverted.ok, true);
  assert.equal(reverted.phase, 'reverted');
  assert.equal(reverted.runtimeRecovered, true);
  assert.equal(reverted.decision.kind, 'benefit');

  const fingerprint = strategyFingerprint(TARGET, STRATEGY);
  const found = h.store.findConclusions({ target: TARGET, applicability: APPLICABILITY, strategyFingerprint: fingerprint });
  assert.equal(found.best.decision, 'reverted-unconfirmed');
  assert.equal(found.best.sameApplicability, true);
  assert.equal(found.matches.some((match) => match.decision === 'adopted'), false);

  // The probe evidence and the decision reach the durable archive verbatim.
  const archive = await fs.readFile(reverted.archive, 'utf8');
  assert.match(archive, /## Decision/);
  assert.match(archive, /"kind": "benefit"/);
  assert.match(archive, /"probeDerived": true/);
  assert.match(archive, /"scenarioId": "edge-cache-first-read"/);
});

// ---------------------------------------------------------------------------
// 2. An ineffective candidate: no benefit, gate rejection, conclusion, and the
//    same strategy is refused on the next propose while a new one is allowed.
// ---------------------------------------------------------------------------

test('ineffective candidate: no-benefit decision rejects promotion, records the conclusion, and blocks only the same strategy', async (t) => {
  const h = await createHarness(t, 'no-benefit');
  seedFailures(h.store, TARGET, 3);
  const experimentId = await proposeExperiment(h);
  await runBaseline(h, experimentId);
  await startTrial(h, experimentId);

  // The candidate leaves the target step failing.
  const candidate = await runCandidate(h, experimentId);
  assert.equal(candidate.comparison.benefit, false);
  assert.equal(candidate.comparison.regression, false);
  assert.equal(candidate.comparison.targetImproved, 0);

  const measurement = h.orchestrator.measure({
    experimentId,
    observation: measuredObservation({ solvesProblem: true }),
  }, h.exec);
  assert.equal(measurement.observation.solvesProblem, false, 'the caller claim is replaced by the probe result');
  assert.equal(measurement.gates.measuredEvidence, false);
  assert.equal(measurement.gates.realBenefit, false);
  assert.equal(measurement.gates.eligible, false);
  assert.equal(measurement.decision.kind, 'no-benefit');

  const promotion = await h.orchestrator.promote({ experimentId, confirmation: true }, h.exec);
  assert.equal(promotion.ok, false);
  assert.equal(promotion.reason, 'promotion-gate');
  assert.equal(promotion.phase, 'measured');
  assert.equal(promotion.decision.kind, 'no-benefit');
  assert.equal(h.orchestrator.experiments.get(experimentId).state, 'measured');

  const reverted = await h.orchestrator.revert({ experimentId }, h.exec);
  assert.equal(reverted.ok, true);
  assert.equal(reverted.runtimeRecovered, true);

  const found = h.store.findConclusions({ target: TARGET, applicability: APPLICABILITY, strategyFingerprint: strategyFingerprint(TARGET, STRATEGY) });
  assert.equal(found.best.decision, 'no-benefit');
  assert.equal(found.best.sameApplicability, true);

  const repeated = h.orchestrator.propose({
    target: TARGET, strategy: STRATEGY, rootCause: ROOT_CAUSE, why: 'try the same thing again',
    impactScope: ['test'], successMetrics: ['successRate'],
  }, h.exec);
  assert.equal(repeated.ok, false);
  assert.equal(repeated.phase, 'rejected');
  assert.equal(repeated.reason, 'strategy-already-proven-ineffective');
  assert.equal(repeated.prior.decision, 'no-benefit');
  assert.deepEqual(repeated.applicability, APPLICABILITY);
  assert.match(repeated.advice, /Change the hypothesis/);

  const differentHypothesis = h.orchestrator.propose({
    target: TARGET, strategy: ALTERNATIVE_STRATEGY, rootCause: 'concurrent warmers race', why: 'a different hypothesis',
    impactScope: ['test'], successMetrics: ['successRate'],
  }, h.exec);
  assert.equal(differentHypothesis.ok, true, 'a different strategy is a new hypothesis, not a repeat');
});

// ---------------------------------------------------------------------------
// 3. Regression: a correctness control that fails or returns a different value
//    is a regression even when the target step improved.
// ---------------------------------------------------------------------------

for (const [label, mutate] of [
  ['a failing correctness control', (state) => { state.controlFails = true; }],
  ['a changed control value', (state) => { state.controlValue = { ok: true, revision: 2 }; }],
]) {
  test(`regression: ${label} blocks the benefit claim and promotion`, async (t) => {
    const h = await createHarness(t, label.includes('failing') ? 'regression-fail' : 'regression-value');
    seedFailures(h.store, TARGET, 3);
    const experimentId = await proposeExperiment(h);
    await runBaseline(h, experimentId);
    await startTrial(h, experimentId);

    h.state.targetFails = false; // the target step itself improved
    mutate(h.state);
    const candidate = await runCandidate(h, experimentId);
    assert.equal(candidate.comparison.regression, true);
    assert.equal(candidate.comparison.benefit, false);
    assert.equal(candidate.comparison.targetImproved, 1);
    assert.ok(candidate.comparison.reasons.length > 0);

    const measurement = h.orchestrator.measure({ experimentId, observation: measuredObservation() }, h.exec);
    assert.equal(measurement.observation.regressionPassed, false);
    assert.equal(measurement.observation.probe.comparison.regression, true);
    assert.equal(measurement.gates.regressionTest, false);
    assert.equal(measurement.gates.eligible, false);
    assert.equal(measurement.decision.kind, 'regression');

    const promotion = await h.orchestrator.promote({ experimentId, confirmation: true }, h.exec);
    assert.equal(promotion.ok, false);
    assert.equal(promotion.reason, 'promotion-gate');
    assert.equal(promotion.phase, 'measured');

    const reverted = await h.orchestrator.revert({ experimentId }, h.exec);
    assert.equal(reverted.ok, true);
    assert.equal(reverted.runtimeRecovered, true);

    const found = h.store.findConclusions({ target: TARGET, applicability: APPLICABILITY, strategyFingerprint: strategyFingerprint(TARGET, STRATEGY) });
    assert.equal(found.best.decision, 'regression');
    assert.equal(found.best.sameApplicability, true);
  });
}

// ---------------------------------------------------------------------------
// 4. Insufficient evidence: a baseline without a candidate is explicitly
//    unproven, while the legacy no-probe path keeps its old behaviour.
// ---------------------------------------------------------------------------

test('insufficient evidence: a baseline without a candidate is recorded as incomplete and never eligible', async (t) => {
  const h = await createHarness(t, 'incomplete');
  seedFailures(h.store, TARGET, 3);
  const experimentId = await proposeExperiment(h);
  await runBaseline(h, experimentId);
  await startTrial(h, experimentId);

  const measurement = h.orchestrator.measure({
    experimentId,
    observation: measuredObservation({ beforeMetrics: { successRate: 0.1 }, afterMetrics: { successRate: 0.9 }, sampleCount: 5, observationWindow: 'forged' }),
  }, h.exec);
  assert.equal(measurement.observation.probe.incomplete, true);
  assert.equal(measurement.observation.probe.scenarioId, probeScenario().id);
  assert.equal(measurement.observation.probeDerived, undefined);
  assert.equal(measurement.observation.solvesProblem, false);
  assert.equal(measurement.observation.repeatable, false);
  assert.equal(measurement.observation.regressionPassed, false);
  // The caller's before/after metrics survive the incomplete branch, but the
  // missing correctness/repeatability evidence keeps every gate combination
  // ineligible.
  assert.equal(measurement.gates.eligible, false);
  assert.equal(measurement.decision.kind, 'insufficient-evidence');

  const reverted = await h.orchestrator.revert({ experimentId }, h.exec);
  assert.equal(reverted.ok, true);
});

test('insufficient evidence: the legacy caller-only measurement path is unchanged (not stricter)', async (t) => {
  const h = await createHarness(t, 'legacy-measure');
  const experimentId = await proposeExperiment(h, { strategy: 'legacy measurement hypothesis' });
  await startTrial(h, experimentId);

  // No probe ran at all: `measure()` must keep trusting the caller's aggregates
  // exactly as it did before the probe existed.
  const forgedBefore = { successRate: 0.25, errorCount: 4 };
  const forgedAfter = { successRate: 0.9, errorCount: 1 };
  const measurement = h.orchestrator.measure({
    experimentId,
    observation: measuredObservation({
      beforeMetrics: forgedBefore,
      afterMetrics: forgedAfter,
      sampleCount: 6,
      observationWindow: 'legacy-window',
      metrics: { successRate: 0.9 },
      repeatable: true,
    }),
  }, h.exec);
  assert.equal(measurement.observation.probe, undefined);
  assert.equal(measurement.observation.probeDerived, undefined);
  assert.deepEqual(measurement.observation.beforeMetrics, forgedBefore);
  assert.deepEqual(measurement.observation.afterMetrics, forgedAfter);
  assert.equal(measurement.observation.sampleCount, 6);
  assert.equal(measurement.observation.observationWindow, 'legacy-window');
  assert.equal(measurement.observation.solvesProblem, true);
  assert.equal(measurement.gates.measuredEvidence, true);
  assert.equal(measurement.gates.eligible, true);
  assert.equal(measurement.decision.kind, 'benefit');
});

// ---------------------------------------------------------------------------
// 5. Probe contract: phase order, scenario identity, declarative limits and
//    same-phase idempotency.
// ---------------------------------------------------------------------------

test('probe contract: wrong phase and missing baseline are rejected with the probe error codes', async (t) => {
  const h = await createHarness(t, 'probe-phase');
  const first = await proposeExperiment(h);
  await runBaseline(h, first);
  await startTrial(h, first);
  await rejectsWithCode(runBaseline(h, first), 'E_EVOLUTION_PROBE_PHASE');
  const reverted = await h.orchestrator.revert({ experimentId: first }, h.exec);
  assert.equal(reverted.ok, true);

  const second = await proposeExperiment(h, { strategy: ALTERNATIVE_STRATEGY });
  await startTrial(h, second);
  await rejectsWithCode(runCandidate(h, second), 'E_EVOLUTION_PROBE_BASELINE');
  // A candidate probe in `proposed` state is a phase violation, not a missing
  // baseline: the state machine rejects it before it can look for evidence.
  const third = await proposeExperiment(h, { strategy: 'third probe hypothesis' });
  await rejectsWithCode(runCandidate(h, third), 'E_EVOLUTION_PROBE_PHASE');
});

test('probe contract: the candidate must reproduce the baseline scenario digest', async (t) => {
  const h = await createHarness(t, 'probe-scenario');
  const experimentId = await proposeExperiment(h);
  const baseline = await runBaseline(h, experimentId);
  await startTrial(h, experimentId);
  h.state.targetFails = false;
  await rejectsWithCode(
    runCandidate(h, experimentId, probeScenario({ id: 'edge-cache-second-read' })),
    'E_EVOLUTION_PROBE_SCENARIO',
  );
  // The identical scenario is accepted and produces a comparison anchored to
  // the original digest.
  const candidate = await runCandidate(h, experimentId);
  assert.equal(candidate.scenarioDigest, baseline.scenarioDigest);
  assert.equal(candidate.comparison.benefit, true);
});

test('probe contract: declarative scenario limits reject invalid scenarios with E_EVOLUTION_PROBE_SCENARIO', () => {
  throwsScenarioError(() => normalizeProbeScenario({
    id: 'too-many-steps',
    steps: Array.from({ length: 9 }, (_, index) => ({ name: `probe-step-${index}`, role: 'target' })),
  }));
  throwsScenarioError(() => normalizeProbeScenario({
    id: 'non-object-arguments',
    steps: [{ name: 'probe-target', role: 'target', arguments: 'not-an-object' }],
  }));
  throwsScenarioError(() => normalizeProbeScenario({ id: 'zero-repetitions', repetitions: 0, steps: [{ name: 'probe-target' }] }));
  throwsScenarioError(() => normalizeProbeScenario({ id: 'too-many-repetitions', repetitions: 6, steps: [{ name: 'probe-target' }] }));
  throwsScenarioError(() => normalizeProbeScenario({ id: 'empty-steps', steps: [] }));
  throwsScenarioError(() => normalizeProbeScenario({ id: 'bad-role', steps: [{ name: 'probe-target', role: 'observer' }] }));
  throwsScenarioError(() => normalizeProbeScenario({ id: 'bad-name', steps: [{ name: 'not a tool name' }] }));
  throwsScenarioError(() => normalizeProbeScenario({ id: 'oversized-arguments', steps: [{ name: 'probe-target', arguments: { blob: 'x'.repeat(4096) } }] }));

  // The normalized shape defaults the role and stringifies arguments deterministically.
  const normalized = normalizeProbeScenario(probeScenario());
  assert.equal(normalized.repetitions, 2);
  assert.deepEqual(normalized.steps[0], { name: 'probe-target', role: 'target', arguments: '{"key":"edge"}' });
  assert.deepEqual(normalized.steps[1], { name: 'probe-control', role: 'control', arguments: '{}' });
  assert.equal(normalizeProbeScenario({ id: 'single', steps: [{ name: 'probe-target' }] }).repetitions, 2);
});

test('probe contract: repeating the same phase is idempotent and does not re-execute the pipeline', async (t) => {
  const h = await createHarness(t, 'probe-idempotent');
  const experimentId = await proposeExperiment(h);
  const firstBaseline = await runBaseline(h, experimentId);
  const callsAfterBaseline = h.calls.length;
  assert.equal(callsAfterBaseline, 4);
  const secondBaseline = await runBaseline(h, experimentId);
  assert.equal(h.calls.length, callsAfterBaseline, 'the recorded baseline is reused instead of re-executed');
  assert.deepEqual(secondBaseline.samples, firstBaseline.samples);

  await startTrial(h, experimentId);
  h.state.targetFails = false;
  const firstCandidate = await runCandidate(h, experimentId);
  const callsAfterCandidate = h.calls.length;
  assert.equal(callsAfterCandidate, callsAfterBaseline + 4);
  const secondCandidate = await runCandidate(h, experimentId);
  assert.equal(h.calls.length, callsAfterCandidate, 'the recorded candidate is reused instead of re-executed');
  assert.deepEqual(secondCandidate.samples, firstCandidate.samples);
  assert.deepEqual(secondCandidate.comparison, firstCandidate.comparison);
});

// ---------------------------------------------------------------------------
// 6. Pure functions: comparison, decision classification, conclusion mapping
//    and applicability.
// ---------------------------------------------------------------------------

test('compareProbeRuns: benefit, regression, control stability, repeatability and derived metrics', () => {
  const baseline = probeRows([
    target([failure('E_TARGET_FAILED'), failure('E_TARGET_FAILED')]),
    control([ok({ ok: true }), ok({ ok: true })]),
  ]);
  const improved = probeRows([
    target([ok({ ok: true }), ok({ ok: true })]),
    control([ok({ ok: true }), ok({ ok: true })]),
  ]);
  const benefit = compareProbeRuns(baseline, improved);
  assert.equal(benefit.benefit, true);
  assert.equal(benefit.regression, false);
  assert.equal(benefit.controlStable, true);
  assert.equal(benefit.repeatable, true);
  assert.equal(benefit.targetImproved, 1);
  assert.deepEqual(benefit.beforeMetrics, { successRate: 0.5, errorCount: 2 });
  assert.deepEqual(benefit.afterMetrics, { successRate: 1, errorCount: 0 });
  assert.match(benefit.sampleDigest.baseline, /^sha256:[a-f0-9]{64}$/);
  assert.match(benefit.sampleDigest.candidate, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(benefit.sampleDigest.baseline, benefit.sampleDigest.candidate);

  // The correctness control that now fails is a regression even though the
  // target step improved.
  const brokenControl = probeRows([
    target([ok({ ok: true }), ok({ ok: true })]),
    control([failure('E_CONTROL_FAILED'), failure('E_CONTROL_FAILED')]),
  ]);
  const controlRegression = compareProbeRuns(baseline, brokenControl);
  assert.equal(controlRegression.benefit, false);
  assert.equal(controlRegression.regression, true);
  assert.equal(controlRegression.controlStable, false);
  assert.ok(controlRegression.reasons.some((reason) => /no longer succeeds/.test(reason)));

  // A control that succeeds but returns a different value is also a regression:
  // the candidate changed unrelated behaviour to make the target "pass".
  const changedControl = probeRows([
    target([ok({ ok: true }), ok({ ok: true })]),
    control([ok({ ok: true, extra: 1 }), ok({ ok: true, extra: 1 })]),
  ]);
  const valueRegression = compareProbeRuns(baseline, changedControl);
  assert.equal(valueRegression.regression, true);
  assert.equal(valueRegression.benefit, false);
  assert.equal(valueRegression.controlStable, true, 'success counts stayed equal; the value digest is what caught it');
  assert.ok(valueRegression.reasons.some((reason) => /result changed/.test(reason)));

  // A step that is inconsistent between repetitions makes the result unproven.
  const mixedBaseline = probeRows([
    target([failure('E_TARGET_FAILED'), ok({ ok: true })]),
    control([ok({ ok: true }), ok({ ok: true })]),
  ]);
  const mixed = compareProbeRuns(mixedBaseline, improved);
  assert.equal(mixed.repeatable, false);
  assert.equal(mixed.benefit, true, 'the improvement itself is still observed; only repeatability is missing');
});

test('classifyExperimentDecision: the four kinds and the eligibility downgrade', () => {
  const noMeasurement = classifyExperimentDecision({});
  assert.equal(noMeasurement.kind, 'insufficient-evidence');
  assert.equal(noMeasurement.eligible, false);
  assert.equal(noMeasurement.gates, null);
  assert.equal(noMeasurement.probe, null);
  assert.ok(noMeasurement.reasons.some((reason) => /no measurement/.test(reason)));

  const probeComparison = {
    benefit: true,
    regression: false,
    controlStable: true,
    repeatable: true,
    targetImproved: 1,
    before: { executions: 4, successes: 2, errors: 2 },
    after: { executions: 4, successes: 4, errors: 0 },
    beforeMetrics: { successRate: 0.5, errorCount: 2 },
    afterMetrics: { successRate: 1, errorCount: 0 },
    sampleDigest: { baseline: 'sha256:a', candidate: 'sha256:b' },
    reasons: [],
    steps: [],
  };
  const benefited = {
    runtimeRecovered: false,
    latestObservation: {
      at: '2026-01-02T00:00:00.000Z',
      solvesProblem: true,
      beforeMetrics: { successRate: 0.5, errorCount: 2 },
      afterMetrics: { successRate: 1, errorCount: 0 },
      observationWindow: 'probe:edge-cache-first-read',
      sampleCount: 4,
      metrics: { probeBenefit: 1 },
      repeatable: true,
      regressionPassed: true,
      reversible: true,
      cleanupEvidence: 'stop+undefine proved disposal',
      orphanResources: [],
    },
    probe: { comparison: probeComparison, scenario: { id: 'edge-cache-first-read' }, scenarioDigest: 'sha256:scenario' },
  };
  const benefitDecision = classifyExperimentDecision(benefited);
  assert.equal(benefitDecision.kind, 'benefit');
  assert.equal(benefitDecision.eligible, true);
  assert.equal(benefitDecision.gates.measuredEvidence, true);
  assert.equal(benefitDecision.gates.runtimeRecovered, false);
  assert.equal(benefitDecision.probe.scenarioId, 'edge-cache-first-read');
  assert.equal(benefitDecision.probe.sampleDigest.baseline, 'sha256:a');

  const noBenefit = classifyExperimentDecision({
    ...benefited,
    latestObservation: {
      ...benefited.latestObservation,
      solvesProblem: false,
      afterMetrics: { successRate: 0.5, errorCount: 2 },
    },
    probe: {
      ...benefited.probe,
      comparison: { ...probeComparison, benefit: false, targetImproved: 0, reasons: ['probe-target: no improvement'] },
    },
  });
  assert.equal(noBenefit.kind, 'no-benefit');
  assert.ok(noBenefit.reasons.includes('probe-target: no improvement'));

  const regressed = classifyExperimentDecision({
    ...benefited,
    latestObservation: { ...benefited.latestObservation, regressionPassed: false },
    probe: {
      ...benefited.probe,
      comparison: { ...probeComparison, benefit: false, regression: true, reasons: ['probe-control: correctness control result changed'] },
    },
  });
  assert.equal(regressed.kind, 'regression');
  assert.ok(regressed.reasons.some((reason) => /correctness control result changed/.test(reason)));

  // Benefit evidence without a passing gate is not a proven benefit.
  const missingCleanup = classifyExperimentDecision({
    ...benefited,
    latestObservation: { ...benefited.latestObservation, cleanupEvidence: '' },
  });
  assert.equal(missingCleanup.kind, 'insufficient-evidence');
  assert.equal(missingCleanup.eligible, false);
  assert.ok(missingCleanup.reasons.some((reason) => /at least one promotion gate/.test(reason)));

  // `regressionPassed: false` keeps its pre-probe meaning whenever the
  // measurement came from the legacy caller-supplied path (no candidate
  // comparison at all), and when a real comparison paired with a failed
  // correctness claim.
  const legacyRegression = classifyExperimentDecision({
    runtimeRecovered: false,
    latestObservation: { ...benefited.latestObservation, regressionPassed: false, solvesProblem: false },
  });
  assert.equal(legacyRegression.kind, 'regression');
  const probedRegression = classifyExperimentDecision({
    ...benefited,
    latestObservation: { ...benefited.latestObservation, regressionPassed: false, solvesProblem: false },
    probe: { ...benefited.probe, comparison: { ...probeComparison, benefit: false, regression: false } },
  });
  assert.equal(probedRegression.kind, 'regression');
  // An incomplete probe writes `regressionPassed: false` to mean "correctness
  // was not proven"; it is not a regression verdict.
  const incompleteProbe = classifyExperimentDecision({
    runtimeRecovered: false,
    latestObservation: {
      at: '2026-01-02T00:00:00.000Z',
      solvesProblem: false,
      repeatable: false,
      regressionPassed: false,
      probe: { incomplete: true, scenarioId: 'edge-cache-first-read' },
    },
    probe: { scenario: { id: 'edge-cache-first-read' }, scenarioDigest: 'sha256:scenario', baseline: {}, candidate: null, comparison: null },
  });
  assert.equal(incompleteProbe.kind, 'insufficient-evidence');
});

test('conclusionKindFor maps the terminal decision onto a stored conclusion', () => {
  assert.equal(conclusionKindFor({ probe: { comparison: { regression: true } } }), 'regression');
  assert.equal(conclusionKindFor({ decision: { kind: 'regression' } }), 'regression');
  assert.equal(conclusionKindFor({ decision: { kind: 'no-benefit' } }), 'no-benefit');
  assert.equal(conclusionKindFor({ decision: { kind: 'benefit' } }), 'reverted-unconfirmed');
  assert.equal(conclusionKindFor({}), 'insufficient-evidence');
  assert.equal(conclusionKindFor({}, { fallback: 'custom-fallback' }), 'custom-fallback');
  assert.equal(conclusionKindFor({ decision: { kind: 'insufficient-evidence' } }, { fallback: 'fallback' }), 'fallback');
  // A regression in the raw comparison wins over a stale decision kind.
  assert.equal(conclusionKindFor({ probe: { comparison: { regression: true } }, decision: { kind: 'benefit' } }), 'regression');
});

test('applicability: the triple is explicit and an unknown version never counts as known', () => {
  assert.deepEqual(applicabilityFromVersions(HOST_VERSIONS), APPLICABILITY);
  const unknown = applicabilityFromVersions({});
  assert.deepEqual(unknown, { dsh: 'unknown', cordis: 'unknown', evolution: 'unknown' });
  assert.equal(applicabilityKnown(unknown), false);
  assert.equal(applicabilityKnown({ dsh: '1.0.0', cordis: 'unknown', evolution: '0.3.0' }), false);
  assert.equal(applicabilityKnown({ dsh: '1.0.0', cordis: '', evolution: '0.3.0' }), false);
  assert.equal(applicabilityKnown(APPLICABILITY), true);
  assert.deepEqual(probeScenarioDigest(normalizeProbeScenario(probeScenario()), APPLICABILITY), probeScenarioDigest(normalizeProbeScenario(probeScenario()), APPLICABILITY));
  const changed = normalizeProbeScenario(probeScenario({ steps: [{ name: 'probe-target', role: 'target', arguments: { key: 'other' } }] }));
  assert.notEqual(probeScenarioDigest(normalizeProbeScenario(probeScenario()), APPLICABILITY), probeScenarioDigest(changed, APPLICABILITY));
  assert.equal(deriveProbeObservation({ baseline: {}, candidate: null, comparison: null }), null);
});

// ---------------------------------------------------------------------------
// 7. Persistence: the decision round-trips through the evidence snapshot and
//    renders into the archive; a decision-less snapshot keeps the old bytes.
// ---------------------------------------------------------------------------

test('persistence: decision round-trips through snapshot/sidecar/merge/hydrate and renders conditionally', async (t) => {
  const root = await scratchRoot('experience-evolution-persistence');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archiveDir = path.join(root, 'archive');
  const experimentId = 'exp-persisted-decision';
  const proposal = {
    owner: 'durability-owner', why: 'first cache read fails', target: TARGET,
    impactScope: ['test'], successMetrics: ['successRate'], createdAt: '2026-01-01T00:00:00.000Z',
  };
  const observation = {
    at: '2026-01-02T00:00:00.000Z', solvesProblem: true,
    beforeMetrics: { successRate: 0.5, errorCount: 2 }, afterMetrics: { successRate: 1, errorCount: 0 },
    observationWindow: 'probe:edge-cache-first-read', sampleCount: 4,
    metrics: { probeBenefit: 1, probeControlStable: 1 },
    repeatable: true, regressionPassed: true, reversible: true,
    cleanupEvidence: 'stop+undefine proved disposal', orphanResources: [], probeDerived: true,
  };
  const decision = {
    version: 1, kind: 'benefit', source: 'measure', at: '2026-01-02T00:00:00.000Z',
    observationAt: observation.at, eligible: true, reasons: ['measured behavior improved'],
    gates: { measuredEvidence: true, realBenefit: true, repeatable: true, regressionTest: true, reversible: true, cleanupEvidence: true, noOrphans: true, runtimeRecovered: false },
    probe: { benefit: true, regression: false, controlStable: true, repeatable: true, scenarioId: 'edge-cache-first-read', scenarioDigest: 'sha256:scenario', sampleDigest: { baseline: 'sha256:a', candidate: 'sha256:b' } },
  };
  const record = {
    id: experimentId, state: 'measured', ownerId: 'durability-owner', proposal,
    observations: [observation], latestObservation: observation,
    cleanupProof: { stopOk: true, removedOk: true, signatureRecovered: true, errors: [] },
    recoveryProof: { status: 'recovered', runtimeRecovered: true },
    runtimeRecovered: true, decision,
  };

  const snapshot = snapshotEvidenceFromRecord(record);
  assert.deepEqual(snapshot.decision, decision);
  const file = await persistEvidenceSnapshot(archiveDir, experimentId, snapshot);
  assert.match(file, /\.evidence\.json$/);
  const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(persisted.decision, decision);

  const merged = mergeEvidenceSources([persisted]);
  assert.deepEqual(merged.decision, decision);
  const hydrated = hydrateRecordFromSnapshot({ id: experimentId }, merged);
  assert.deepEqual(hydrated.decision, decision);
  assert.deepEqual(hydrated.latestObservation, observation);

  // A snapshot written before decisions existed must not grow the key.
  const legacySnapshot = snapshotEvidenceFromRecord({ ...record, decision: undefined });
  assert.equal(Object.hasOwn(legacySnapshot, 'decision'), false);
  const legacyMerged = mergeEvidenceSources([legacySnapshot]);
  assert.equal(Object.hasOwn(legacyMerged, 'decision'), false);
  const legacyHydrated = hydrateRecordFromSnapshot({ id: experimentId }, legacyMerged);
  assert.equal(Object.hasOwn(legacyHydrated, 'decision'), false);

  // The renderer: with decision adds `## Decision`; without it, two renders of
  // the same arguments are byte-identical (the pre-decision output).
  const renderArgs = {
    id: experimentId, state: 'measured', reason: 'measure', proposal,
    observations: [observation], latestMeasurement: observation,
    recoveryProof: record.recoveryProof, recovered: true,
  };
  const withDecision = renderExperimentArchive({ ...renderArgs, decision });
  assert.match(withDecision, /## Decision/);
  assert.match(withDecision, /"kind": "benefit"/);
  const withoutDecisionA = renderExperimentArchive({ ...renderArgs });
  const withoutDecisionB = renderExperimentArchive({ ...renderArgs });
  assert.equal(withoutDecisionA, withoutDecisionB);
  assert.doesNotMatch(withoutDecisionA, /## Decision/);
});

// ---------------------------------------------------------------------------
// 8. Plan boundaries: no signal, focus mismatch, already resolved, and prior
//    conclusions split by applicability.
// ---------------------------------------------------------------------------

test('plan boundaries: no failure signal and a non-matching focus return no candidate', async (t) => {
  const empty = await createHarness(t, 'plan-empty');
  const noSignal = empty.orchestrator.plan({}, empty.exec);
  assert.equal(noSignal.ok, true);
  assert.deepEqual(noSignal.candidates, []);
  assert.equal(noSignal.selected, null);
  assert.equal(noSignal.none.reason, 'no-failure-signal');

  const seeded = await createHarness(t, 'plan-focus');
  seedFailures(seeded.store, TARGET, 3);
  const focused = seeded.orchestrator.plan({ focus: 'unrelated-topic' }, seeded.exec);
  assert.equal(focused.ok, true);
  assert.deepEqual(focused.candidates, []);
  assert.equal(focused.selected, null);
  assert.equal(focused.focus, 'unrelated-topic');
  assert.ok(focused.none);
});

test('plan boundaries: a resolved target is rejected instead of re-planned', async (t) => {
  const h = await createHarness(t, 'plan-resolved');
  seedFailures(h.store, TARGET, 3);
  // A newer resolution for the same target is a real success fact in the store.
  const receipt = h.store.recordEvolution({
    eventType: 'promotion-succeeded',
    target: TARGET,
    eventId: 'promotion-event-1',
  }, '/tmp/evolution-lifecycle-bridge.jsonl', { sequence: 1, writer: 'lifecycle-test' });
  assert.equal(receipt.committed, true);

  const plan = h.orchestrator.plan({}, h.exec);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.candidates, []);
  assert.equal(plan.none.reason, 'already-resolved');
  assert.ok(plan.rejected.some((entry) => entry.problemKey === PROBLEM_KEY && entry.reason === 'already-resolved'));
});

test('plan boundaries: prior conclusions only count as proven-ineffective under the same applicability', async (t) => {
  const same = await createHarness(t, 'plan-same-applicability');
  seedFailures(same.store, TARGET, 3);
  recordConclusion(same.store, { target: TARGET, strategy: STRATEGY, decision: 'no-benefit' });
  const samePlan = same.orchestrator.plan({}, same.exec);
  assert.equal(samePlan.candidates.length, 1);
  const sameCandidate = samePlan.selected;
  assert.equal(sameCandidate.requiresNewHypothesis, true);
  assert.equal(sameCandidate.provenIneffective.length, 1);
  assert.equal(sameCandidate.provenIneffective[0].strategy, STRATEGY);
  assert.equal(sameCandidate.provenIneffective[0].decision, 'no-benefit');
  assert.equal(sameCandidate.priorAttempts.length, 1);
  assert.equal(sameCandidate.priorAttempts[0].sameApplicability, true);
  assert.deepEqual(sameCandidate.priorAttempts[0].applicability, APPLICABILITY);
  assert.equal(sameCandidate.risk, 'medium');

  const different = await createHarness(t, 'plan-different-applicability');
  seedFailures(different.store, TARGET, 3);
  recordConclusion(different.store, { target: TARGET, strategy: STRATEGY, decision: 'no-benefit', applicability: DIFFERENT_VERSIONS });
  const differentPlan = different.orchestrator.plan({}, different.exec);
  assert.equal(differentPlan.candidates.length, 1);
  const differentCandidate = differentPlan.selected;
  assert.deepEqual(differentCandidate.provenIneffective, []);
  assert.equal(differentCandidate.requiresNewHypothesis, false);
  assert.equal(differentCandidate.priorAttempts.length, 1);
  assert.equal(differentCandidate.priorAttempts[0].sameApplicability, false);
  assert.deepEqual(differentCandidate.priorAttempts[0].applicability, DIFFERENT_VERSIONS);
});

// ---------------------------------------------------------------------------
// Independent-review regressions (Sol round 1)
// ---------------------------------------------------------------------------

test('baseline probe is refused while another experiment occupies the runtime', async (t) => {
  const h = await createHarness(t, 'baseline-runtime-busy');
  const first = await proposeExperiment(h, {
    target: 'plugin:busy-first',
    strategy: 'mount a first candidate listener',
  });
  await startTrial(h, first);
  const second = await proposeExperiment(h, {
    target: 'plugin:busy-second',
    strategy: 'mount a second candidate listener',
  });
  // Without the occupancy check this baseline would be captured while the first
  // Trial is mounted, and the later comparison would credit the first Trial's
  // behaviour (or its rollback) to the second experiment.
  await rejectsWithCode(runBaseline(h, second), 'E_EVOLUTION_RUNTIME_BUSY');
  assert.equal(h.orchestrator.experiments.get(second).probe, undefined, 'no baseline may be recorded under another Trial');
  const reverted = await h.orchestrator.revert({ experimentId: first }, h.exec);
  assert.equal(reverted.ok, true);
  const baseline = await runBaseline(h, second);
  assert.equal(baseline.baseline.executions, probeScenario().steps.length * probeScenario().repetitions);
});

test('a timed-out probe step aborts its official call and waits for it to settle', async (t) => {
  const h = await createHarness(t, 'probe-timeout-settles', { config: { probeStepTimeoutMs: 40 } });
  const experimentId = await proposeExperiment(h);
  const pending = [];
  h.ctx.tools.execute = ({ signal }) => {
    const call = new Promise((resolve, reject) => {
      const settle = () => reject(Object.assign(new Error('probe call aborted'), { code: 'E_ABORTED' }));
      if (signal.aborted) settle();
      else signal.addEventListener('abort', settle, { once: true });
    });
    pending.push(call);
    return call;
  };
  const baseline = await runBaseline(h, experimentId);
  const scenario = probeScenario();
  const expectedCalls = scenario.steps.length * scenario.repetitions;
  // Every timed-out step is recorded as a failed sample, and every aborted
  // official call has settled before `probe` returns.
  assert.equal(pending.length, expectedCalls);
  assert.equal(baseline.samples.length, expectedCalls);
  for (const sample of baseline.samples) {
    assert.equal(sample.isError, true);
    assert.equal(sample.code, 'E_EVOLUTION_PROBE_TIMEOUT');
  }
  // A settled rejection must not surface as an unhandled rejection later.
  await Promise.allSettled(pending);
});

test('the strategy fingerprint uses the canonical problem identity', async (t) => {
  // `tool:edge-cache` (caller spelling) and `tool edge-cache` (plan/store
  // spelling) are the same problem: a verdict recorded through one spelling
  // must block a proposal written with the other.
  assert.equal(strategyFingerprint(TARGET, STRATEGY), strategyFingerprint(PROBLEM_KEY, STRATEGY));
  const h = await createHarness(t, 'canonical-fingerprint');
  recordConclusion(h.store, { target: PROBLEM_KEY, strategy: STRATEGY, decision: 'no-benefit' });
  const refused = h.orchestrator.propose({
    target: TARGET,
    strategy: STRATEGY,
    rootCause: ROOT_CAUSE,
    why: 'the same strategy under the same conditions',
    impactScope: ['test'],
    successMetrics: ['successRate'],
  }, h.exec);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'strategy-already-proven-ineffective');
  assert.equal(refused.prior.decision, 'no-benefit');
});

test('a conclusion published from a restored record keeps the measured delta', async (t) => {
  const h = await createHarness(t, 'conclusion-restored-metrics');
  // A promotion's canary can commit in a later process: `record.probe` is gone,
  // only the persisted `latestObservation.probe` survives the snapshot.
  const restored = {
    id: 'exp-restored-canary',
    ownerId: 'durability-owner',
    state: 'stable',
    proposal: {
      target: TARGET,
      strategy: STRATEGY,
      rootCause: ROOT_CAUSE,
      applicability: APPLICABILITY,
      strategyFingerprint: strategyFingerprint(TARGET, STRATEGY),
    },
    latestObservation: {
      at: '2026-01-05T00:00:00.000Z',
      probe: {
        comparison: {
          beforeMetrics: { successRate: 0.5, errorCount: 2 },
          afterMetrics: { successRate: 1, errorCount: 0 },
        },
      },
    },
    decision: { version: 1, kind: 'benefit', source: 'canary-passed', at: '2026-01-06T00:00:00.000Z' },
  };
  h.orchestrator.publishConclusion(restored, 'adopted', 'canary-passed');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(h.sharePath);
  try {
    const row = db.prepare("SELECT body FROM knowledge WHERE body LIKE '%experiment-conclusion%' ORDER BY revision DESC LIMIT 1").get();
    assert.ok(row, 'the conclusion row must exist');
    const entry = JSON.parse(row.body);
    assert.equal(entry.scope, PROBLEM_KEY);
    assert.equal(entry.lastStatus, 'adopted');
    assert.equal(entry.effectStats.metrics.successratedelta.last, 0.5);
    assert.equal(entry.effectStats.metrics.errorsdelta.last, -2);
  } finally {
    db.close();
  }
});

test('probe input and tool error codes cross the redaction boundary', async (t) => {
  const h = await createHarness(t, 'probe-redaction');
  const experimentId = await proposeExperiment(h);
  const secret = 'api_key=synthetic-secret';
  const baseline = await h.orchestrator.probe({
    experimentId,
    phase: 'baseline',
    scenario: probeScenario({ id: `probe ${secret}` }),
  }, h.exec);
  assert.equal(JSON.stringify(baseline).includes('synthetic-secret'), false, 'the tool result must not echo the secret');
  assert.equal(String(baseline.scenarioId).includes('synthetic-secret'), false);
  assert.equal(String(h.orchestrator.experiments.get(experimentId).probe.scenario.id).includes('synthetic-secret'), false);

  // A host result whose `error.code` is arbitrary text is classified, not stored.
  const second = await proposeExperiment(h, { target: 'plugin:redaction-second', strategy: 'another candidate' });
  h.ctx.tools.execute = async ({ calls }) => ({
    results: [{ callId: calls[0].id, result: { isError: true, error: { info: { code: secret } } } }],
  });
  const coded = await h.orchestrator.probe({ experimentId: second, phase: 'baseline', scenario: probeScenario({ id: 'redaction-code' }) }, h.exec);
  for (const sample of coded.samples) {
    assert.equal(sample.isError, true);
    assert.equal(sample.code, 'TOOL_ERROR');
  }
  assert.equal(JSON.stringify(coded).includes('synthetic-secret'), false);
});

test('focus is applied before the candidate limit', async (t) => {
  const h = await createHarness(t, 'plan-focus-before-limit');
  const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
  for (const [index, name] of names.entries()) {
    // `zeta` is deliberately *not* the top-ranked target: if the plan caps
    // candidates before applying focus, limiting to one result can never reach
    // it. The test first proves the unfocused plan omits it, then focuses it.
    seedFailures(h.store, `tool:${name}`, 10 - index);
  }
  const unfocused = h.orchestrator.plan({ limit: 1 }, h.exec);
  assert.equal(unfocused.ok, true);
  assert.equal(unfocused.selected.problemKey, 'tool alpha');
  assert.equal(unfocused.candidates.some((candidate) => candidate.problemKey === 'tool zeta'), false);
  const planned = h.orchestrator.plan({ focus: 'tool:zeta', limit: 1 }, h.exec);
  assert.equal(planned.ok, true);
  assert.ok(planned.selected, 'the focused target must be reachable even with limit:1');
  assert.equal(planned.selected.problemKey, 'tool zeta');
  assert.equal(planned.candidates.length, 1);
});

test('a Trial cannot start while a baseline probe is in flight', async (t) => {
  const h = await createHarness(t, 'probe-blocks-trial');
  const first = await proposeExperiment(h);
  // Hold the first probe call open so the Trial attempt lands inside it.
  let releaseCall;
  const held = new Promise((resolve) => { releaseCall = resolve; });
  h.ctx.tools.execute = async ({ calls }) => {
    await held;
    return { results: [{ callId: calls[0].id, result: { isError: true, error: { code: 'E_HELD' } } }] };
  };
  const baselineRun = runBaseline(h, first);
  // Same experiment and another experiment must both be refused: the runtime is
  // being measured, so a Trial would change the behaviour under comparison.
  await rejectsWithCode(startTrial(h, first), 'E_EVOLUTION_RUNTIME_BUSY');
  const second = await proposeExperiment(h, { target: 'plugin:trial-during-probe', strategy: 'second hypothesis' });
  await rejectsWithCode(startTrial(h, second), 'E_EVOLUTION_RUNTIME_BUSY');
  releaseCall();
  const baseline = await baselineRun;
  assert.ok(baseline.samples.length > 0);
  // Once the probe settles, the same Trial is allowed again.
  const trial = await startTrial(h, first);
  assert.equal(trial.ok, true);
  await h.orchestrator.revert({ experimentId: first }, h.exec);
});

test('a probe call that ignores abort keeps the claim until it settles', async (t) => {
  const h = await createHarness(t, 'probe-abort-stuck', { config: { probeStepTimeoutMs: 30 } });
  const experimentId = await proposeExperiment(h);
  const pendingCalls = [];
  h.ctx.tools.execute = () => new Promise((resolve) => {
    // Deliberately ignores the abort signal; the probe must not continue next
    // to this live call, and the runtime claim must stay held.
    pendingCalls.push({ resolve, signalIgnored: true });
  });
  const stuck = await runBaseline(h, experimentId).then(() => null, (error) => error);
  assert.ok(stuck, 'the probe must fail instead of continuing next to a live call');
  assert.equal(stuck.code, 'E_EVOLUTION_PROBE_ABORT_STUCK');
  await rejectsWithCode(startTrial(h, experimentId), 'E_EVOLUTION_RUNTIME_BUSY');
  // The stuck call settles: only now is the runtime handed back.
  pendingCalls[0].resolve({ results: [{ callId: 'late', result: { isError: true, error: { code: 'E_LATE' } } }] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const trial = await startTrial(h, experimentId);
  assert.equal(trial.ok, true);
  await h.orchestrator.revert({ experimentId }, h.exec);
});

// ---------------------------------------------------------------------------
// Applicability identity and probe safety boundaries
// ---------------------------------------------------------------------------

test('plan, probe and conclusion lookups share one applicability identity', async (t) => {
  const h = await createHarness(t, 'applicability-identity');
  seedFailures(h.store, TARGET, 3);
  const planned = h.orchestrator.plan({ focus: TARGET }, h.exec);
  assert.equal(planned.ok, true);
  assert.deepEqual(planned.applicability, APPLICABILITY);
  assert.deepEqual(planned.versions, HOST_VERSIONS);
  const experimentId = await proposeExperiment(h);
  const baseline = await runBaseline(h, experimentId);
  assert.deepEqual(baseline.versions, APPLICABILITY, 'the probe records the same triple the plan used');
  assert.equal(baseline.safety?.policy, 'official-concurrency-safe');
  recordConclusion(h.store, { target: PROBLEM_KEY, strategy: STRATEGY, decision: 'no-benefit', applicability: APPLICABILITY });
  const found = h.store.findConclusions({
    target: PROBLEM_KEY,
    applicability: APPLICABILITY,
    strategyFingerprint: strategyFingerprint(TARGET, STRATEGY),
  });
  assert.ok(found.best, 'the conclusion lookup must see the recorded verdict');
  assert.equal(found.best.sameApplicability, true);
});

test('a step that does not opt into the concurrency-safe contract is refused before execution', async (t) => {
  const h = await createHarness(t, 'probe-safety-refused');
  const experimentId = await proposeExperiment(h);
  h.ctx.tools.get = (name) => ({ name, isConcurrencySafe: () => name !== 'probe-target' });
  const callsBefore = h.calls.length;
  await rejectsWithCode(runBaseline(h, experimentId), 'E_EVOLUTION_PROBE_UNSAFE_STEP');
  assert.equal(h.calls.length, callsBefore, 'an unsafe step must not reach the official tool pipeline');
  assert.equal(h.orchestrator.experiments.get(experimentId).probe, undefined);
});

test('reserved and unknown tools are refused before execution', async (t) => {
  const h = await createHarness(t, 'probe-safety-reserved');
  const experimentId = await proposeExperiment(h);
  for (const forbidden of ['run_code', 'evolution_measure']) {
    h.ctx.tools.get = (name) => ({ name, isConcurrencySafe: () => true });
    const callsBefore = h.calls.length;
    await rejectsWithCode(
      h.orchestrator.probe({ experimentId, phase: 'baseline', scenario: { id: `reserved-${forbidden}`, repetitions: 1, steps: [{ name: forbidden, arguments: {}, role: 'target' }] } }, h.exec),
      'E_EVOLUTION_PROBE_UNSAFE_STEP',
    );
    assert.equal(h.calls.length, callsBefore);
  }
  h.ctx.tools.get = () => undefined;
  await rejectsWithCode(runBaseline(h, experimentId, probeScenario({ id: 'unknown-step' })), 'E_EVOLUTION_PROBE_UNSAFE_STEP');
  assert.equal(h.orchestrator.experiments.get(experimentId).probe, undefined);
});

test('the candidate phase applies the same safety preflight as the baseline', async (t) => {
  const h = await createHarness(t, 'probe-safety-candidate');
  const experimentId = await proposeExperiment(h);
  await runBaseline(h, experimentId);
  await startTrial(h, experimentId);
  h.ctx.tools.get = (name) => ({ name, isConcurrencySafe: () => name !== 'probe-control' });
  const callsBefore = h.calls.length;
  await rejectsWithCode(runCandidate(h, experimentId), 'E_EVOLUTION_PROBE_UNSAFE_STEP');
  assert.equal(h.calls.length, callsBefore, 'the candidate phase must not execute an unsafe control step');
  assert.equal(h.orchestrator.experiments.get(experimentId).probe.candidate, null);
  await h.orchestrator.revert({ experimentId }, h.exec);
});

test('delegation and background entry points are refused even when they claim concurrency safety', async (t) => {
  const h = await createHarness(t, 'probe-safety-background');
  const experimentId = await proposeExperiment(h);
  // The real Desktop `subagent` definition declares isConcurrencySafe (it is a
  // dispatch-overlap flag, not an "all work finishes inline" promise) while the
  // delegated work keeps running in the background. These actual registered
  // names must be refused before the definition is trusted.
  const backgroundEntryPoints = [
    'subagent', 'subagent_fork', 'workflow', 'send_message', 'interrupt_agent',
    'list_agents', 'list_subagent_models', 'job_output', 'job_list', 'job_kill',
    'schedule_create', 'schedule_edit', 'web_fetch', 'web_search', 'session_trace',
    'plugin_manager', 'present', 'create_goal', 'update_goal', 'working_directory',
  ];
  for (const [index, name] of backgroundEntryPoints.entries()) {
    h.ctx.tools.get = (toolName) => ({ name: toolName, isConcurrencySafe: () => true });
    const callsBefore = h.calls.length;
    await rejectsWithCode(
      h.orchestrator.probe({
        experimentId,
        phase: 'baseline',
        scenario: { id: `background-${index}`, repetitions: 1, steps: [{ name, arguments: {}, role: 'target' }] },
      }, h.exec),
      'E_EVOLUTION_PROBE_UNSAFE_STEP',
    );
    assert.equal(h.calls.length, callsBefore, `${name} must be refused before the official pipeline`);
  }
  assert.equal(h.orchestrator.experiments.get(experimentId).probe, undefined);
});
