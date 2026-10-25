/**
 * A metric must be evidence the data actually owns.
 *
 * `sourceMetrics()` merged every nested container with `Object.assign` onto an
 * ordinary `{}`. `Object.assign` assigns through `[[Set]]`, so a container that
 * owns a `__proto__` data key - the shape `JSON.parse()` really produces, and
 * the shape `measure()` persists because `compactValue()` keeps that key - did
 * not copy the key: it reached `Object.prototype`'s `__proto__` setter and the
 * payload became the merged view's prototype. `findMetric()` then read aliases
 * the evidence never owned, so the advisory evaluator could count an
 * improvement out of nothing, hide a real regression behind an inherited
 * higher-priority alias, or report a regression the data never contained. That
 * last one matters on the production path: `promote()` evaluates
 * `domainEvaluationEvidence(record)` through `domainStorage.evaluate()` and
 * treats `decision === "rollback"` as a hard stop, so a fake regression was a
 * fake promotion veto.
 *
 * `sourceMetrics()` now merges onto `Object.create(null)`, where no `__proto__`
 * accessor exists: the key is copied as ordinary data and alias reads stay
 * own-property only. Ordinary evidence must be bit-for-bit unchanged, which the
 * frozen pin at the bottom of this file records from the pre-fix implementation.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { EvolutionEvaluator, projectEvolutionResults } from "../../lib/dockyard-domain/evaluator.js";
import { domainEvaluationEvidence } from "../../lib/orchestrator.js";

const NOW = "2026-10-24T00:00:00.000Z";
const clock = () => new Date(NOW);
const evaluator = () => new EvolutionEvaluator({ clock });

/**
 * `{ __proto__: payload }` in an object literal *sets the prototype*; only
 * `JSON.parse()` (and `Object.defineProperty`) create the own data key. Every
 * special-key input below is parsed, so it is the shape the durable path stores.
 */
const ownsProtoKey = (json) => JSON.parse(json);

test("an own __proto__ payload is never read as a before/after metric", () => {
  const evidence = domainEvaluationEvidence({
    latestObservation: {
      beforeMetrics: ownsProtoKey('{"metrics":{"__proto__":{"latency":500}}}'),
      afterMetrics: ownsProtoKey('{"metrics":{"__proto__":{"latency":50}}}'),
      regressionPassed: true,
    },
  });
  const { metrics } = evaluator().evaluate(evidence);
  assert.equal(metrics.summary.observed, 0, "a payload alias must not become an observed metric");
  assert.equal(metrics.summary.improved, 0);
  assert.equal(metrics.summary.regressed, 0);
  assert.equal(Object.hasOwn(metrics, "latencyMs"), false, "neither side owned a latency alias, so no entry exists");
  assert.equal(metrics.latencyMs, undefined);
});

test("an inherited alias cannot mask a real regression in the same container", () => {
  const masked = domainEvaluationEvidence({
    latestObservation: {
      beforeMetrics: { p95LatencyMs: 100 },
      afterMetrics: ownsProtoKey('{"p95LatencyMs":100,"metrics":{"__proto__":{"latency":1}}}'),
      regressionPassed: true,
    },
  });
  const { metrics } = evaluator().evaluate(masked);
  // `latency` outranks `p95LatencyMs` in the latencyMs alias list, so the
  // inherited value used to win over the own `p95LatencyMs: 100` that did not
  // improve at all - an "improvement" of -99ms invented by the payload.
  assert.equal(metrics.latencyMs.after, 100, "the own p95LatencyMs is the only after value");
  assert.equal(metrics.latencyMs.delta, 0);
  assert.equal(metrics.latencyMs.improved, false);
  assert.equal(metrics.summary.observed, 1);
  assert.equal(metrics.summary.improved, 0);
  assert.equal(metrics.summary.regressed, 0);
});

test("an inherited alias cannot invent a regression the data does not contain", () => {
  const reversed = domainEvaluationEvidence({
    latestObservation: {
      beforeMetrics: ownsProtoKey('{"p95LatencyMs":100,"metrics":{"__proto__":{"latency":1}}}'),
      afterMetrics: { p95LatencyMs: 100 },
      regressionPassed: true,
      solvesProblem: true,
    },
  });
  const evaluation = evaluator().evaluate(reversed);
  assert.equal(evaluation.metrics.latencyMs.before, 100);
  assert.equal(evaluation.metrics.latencyMs.delta, 0);
  assert.equal(evaluation.metrics.summary.regressed, 0);
  assert.notEqual(evaluation.decision, "rollback", "an inherited value must not produce the fake rollback veto");
});

test("the promote() evidence shape cannot be driven into a rollback by an own __proto__ payload", () => {
  // The exact wiring `promote()` reaches: `domainEvaluationEvidence()` forwards
  // `latestObservation.beforeMetrics/afterMetrics` unchanged into
  // `domainStorage.evaluate()`, which calls this evaluator. Before the fix the
  // inherited `latency: 1` outranked the own `p95LatencyMs: 100`, so this record
  // evaluated as a regression and `promote()` returned `domain-evaluator-rollback`.
  const record = {
    latestObservation: ownsProtoKey(
      '{"beforeMetrics":{"p95LatencyMs":100,"metrics":{"__proto__":{"latency":1}}},'
      + '"afterMetrics":{"p95LatencyMs":100,"qualityScore":0.9},'
      + '"regressionPassed":true,"solvesProblem":true}',
    ),
    durable: { rowId: "row-candidate" },
    previousDurable: { rowId: "row-historical" },
  };
  const evaluation = evaluator().evaluate(domainEvaluationEvidence(record));
  assert.equal(evaluation.metrics.summary.regressed, 0);
  assert.notEqual(evaluation.decision, "rollback", "promote() hard-stops on rollback, so a payload must not reach it");
  // The fix removes inheritance, not evidence: the own pair is still observed.
  assert.equal(evaluation.metrics.summary.observed, 1);
  assert.deepEqual(evaluation.metrics.latencyMs, {
    before: 100, after: 100, delta: 0, relativeChange: 0, direction: "lower", improved: false, regressed: false,
  });
  assert.equal(evaluation.metrics.qualityScore.after, 0.9);
  // `domainEvaluationEvidence()` forwards versions but no metric snapshot, so
  // the evaluator's version comparison stays absent here; the promoted record
  // is judged on its own before/after evidence only.
  assert.equal(evaluation.versionComparison, null);
});

test("special keys stored as ordinary data are not metrics and do not change the summary", () => {
  const control = evaluator().evaluate({
    beforeMetrics: { p95LatencyMs: 100 },
    afterMetrics: { p95LatencyMs: 100 },
    regressionResult: true,
  });
  const withSpecialKeys = evaluator().evaluate({
    // Same own `p95LatencyMs` pair as the control; the extra keys are data the
    // evidence owns, and the payloads are aliases it does *not* own.
    beforeMetrics: ownsProtoKey('{"p95LatencyMs":100,"metrics":{"__proto__":{"latency":1}},"constructor":3,"toString":4}'),
    afterMetrics: ownsProtoKey('{"p95LatencyMs":100,"metrics":{"__proto__":{"latency":100}},"constructor":3,"toString":4}'),
    regressionResult: true,
  });
  assert.equal(
    JSON.stringify(withSpecialKeys.metrics),
    JSON.stringify(control.metrics),
    "adding data keys must not add, drop or shift a metric",
  );
  for (const key of ["__proto__", "constructor", "toString"]) {
    assert.equal(Object.hasOwn(withSpecialKeys.metrics, key), false, `${key} is not a metric rule`);
  }
  // And the ordinary own value still decides the comparison.
  assert.equal(withSpecialKeys.metrics.latencyMs.before, 100);
  assert.equal(withSpecialKeys.metrics.latencyMs.after, 100);
});

test("a metric alias inherited on the evidence object itself is not read", () => {
  // Unchanged by this fix, and asserted so it stays that way: `sourceMetrics()`
  // copies with spread/assign, which never walks the *source's* prototype, so
  // `Object.create({ latency: 9 })` was already invisible before the fix. The
  // rule the null-prototype view enforces is the same one: an alias has to be
  // the evidence's own data, never something the prototype chain supplies.
  // (A nested *container* is still looked up normally, so an artificially
  // prototyped container can contribute - but only real code can build one;
  // `JSON.parse` cannot, and the durable path stores JSON.)
  const inherited = evaluator().evaluate({
    beforeMetrics: Object.create({ latency: 9 }),
    afterMetrics: { latency: 3 },
    regressionResult: true,
  });
  assert.equal(inherited.metrics.latencyMs.before, null);
  assert.equal(inherited.metrics.summary.observed, 0);
  const inheritedContainer = evaluator().evaluate({
    beforeMetrics: { metrics: Object.create({ latency: 9 }) },
    afterMetrics: { latency: 3 },
    regressionResult: true,
  });
  assert.equal(inheritedContainer.metrics.latencyMs.before, null);
  assert.equal(inheritedContainer.metrics.summary.observed, 0);
});

/**
 * Ordinary evidence, frozen from the pre-fix implementation: every case here is
 * built from plain own keys only, so the null-prototype merge must reproduce it
 * byte for byte. Each value is `JSON.stringify(...)` of the whole evaluator
 * result (or of `projectEvolutionResults()` output), serialized with the same
 * fixed clock, so any change in decision, reason, evidence, metrics, projection
 * or versionComparison shows up as a pin difference.
 */
const ordinaryCases = () => {
  const cases = [];
  const add = (name, produce) => cases.push([name, produce]);
  const evaluate = (input) => evaluator().evaluate(input);
  add("direct-aliases", () => evaluate({
    beforeMetrics: { latency: 100, latencyMs: 120, p95LatencyMs: 150 },
    afterMetrics: { latency: 80, latencyMs: 90, p95LatencyMs: 140 },
    goalResult: true, testResult: true, regressionResult: true,
  }));
  add("nested-metrics-container", () => evaluate({
    beforeMetrics: { metrics: { successRate: 0.5, cost: 2 } },
    afterMetrics: { metrics: { successRate: 0.75, cost: 1 } },
    goalResult: { id: "goal-1", success: true }, testResult: { passed: true }, regressionResult: { passed: true },
  }));
  add("string-and-boolean-values", () => evaluate({
    beforeMetrics: { latency: "120", cost: "1.5", successRate: true },
    afterMetrics: { latency: "100", cost: "1", successRate: false },
    regressionResult: true,
  }));
  add("empty-metrics", () => evaluate({ beforeMetrics: {}, afterMetrics: {} }));
  add("regression-failed", () => evaluate({
    beforeMetrics: { successRate: 0.9 },
    afterMetrics: { successRate: 0.95 },
    goalResult: true, testResult: true, regressionResult: false,
  }));
  add("promote-path", () => evaluate({
    beforeMetrics: { successRate: 0.5, cost: 2 },
    afterMetrics: { successRate: 0.9, cost: 1.5 },
    goalResult: { id: "goal-1", success: true }, testResult: { passed: true }, regressionResult: { passed: true },
  }));
  add("version-comparison", () => evaluate({
    beforeSnapshot: { metrics: { latency: 100 } },
    afterSnapshot: { metrics: { latency: 60 } },
    currentVersion: "row-candidate", historicalBestVersion: "row-historical",
    goalResult: true, testResult: true, regressionResult: true,
  }));
  add("explicit-current-metrics", () => evaluate({
    historicalBestMetrics: { p95LatencyMs: 200, qualityScore: 0.4 },
    currentMetrics: { p95LatencyMs: 150, qualityScore: 0.8 },
    currentVersion: "row-candidate", historicalBestVersion: "row-historical",
    goalResult: true, testResult: true, regressionResult: true,
  }));
  add("snapshot-fallback", () => evaluate({
    beforeSnapshot: { metrics: { tokenUsage: 900 } },
    afterSnapshot: { metrics: { tokenUsage: 600 } },
    regressionResult: true,
  }));
  add("user-feedback", () => evaluate({
    beforeMetrics: { qualityScore: 0.5 },
    afterMetrics: { qualityScore: 0.6 },
    goalResult: true, testResult: true, regressionResult: true, userFeedback: { score: 0.2 },
  }));
  add("project-evolution-results", () => projectEvolutionResults({
    goalResult: { id: "goal-1", success: true, latency: 120, cost: 2, metrics: { beforeMetrics: { latency: 200 }, afterMetrics: { latency: 120 } } },
    agentResult: { id: "agent-1", quality: 0.9, toolSelectionFailure: false, recordedAt: NOW },
    clock,
  }));
  add("project-evolution-results-empty", () => projectEvolutionResults({ clock }));
  add("evaluation-of-projection", () => evaluate({
    ...projectEvolutionResults({
      goalResult: { id: "goal-1", success: true, latency: 120, cost: 2, metrics: { beforeMetrics: { latency: 200 }, afterMetrics: { latency: 120 } } },
      clock,
    }),
    goalResult: true, testResult: true, regressionResult: true,
  }));
  return cases;
};

const PINNED_ORDINARY_EVIDENCE = JSON.parse(String.raw`[
  [
    "direct-aliases",
    "{\"decision\":\"promote\",\"confidence\":1,\"metrics\":{\"latencyMs\":{\"before\":120,\"after\":90,\"delta\":-30,\"relativeChange\":-0.25,\"direction\":\"lower\",\"improved\":true,\"regressed\":false},\"summary\":{\"observed\":1,\"improved\":1,\"regressed\":0,\"improvementRate\":1},\"latency\":null,\"tokenUsage\":null,\"cost\":null,\"failureRate\":null,\"userFeedback\":null},\"projection\":{\"metrics\":{},\"before\":{},\"after\":{},\"observed\":false},\"versionComparison\":null,\"reason\":\"goal, tests, regression, and measurable improvement all passed\",\"reasons\":[],\"evidence\":{\"goalPassed\":true,\"testsPassed\":true,\"regressionPassed\":true,\"feedbackProvided\":false,\"projectedResults\":false},\"evaluatedAt\":\"2026-10-24T00:00:00.000Z\"}"
  ],
  [
    "nested-metrics-container",
    "{\"decision\":\"promote\",\"confidence\":1,\"metrics\":{\"successRate\":{\"before\":0.5,\"after\":0.75,\"delta\":0.25,\"relativeChange\":0.5,\"direction\":\"higher\",\"improved\":true,\"regressed\":false},\"cost\":null,\"summary\":{\"observed\":2,\"improved\":2,\"regressed\":0,\"improvementRate\":1},\"latency\":null,\"tokenUsage\":null,\"failureRate\":null,\"userFeedback\":null},\"projection\":{\"goal\":{\"id\":\"goal-1\",\"success\":true,\"completionTimeMs\":null,\"latencyMs\":null,\"tokenUsage\":null,\"cost\":null,\"failureRate\":null,\"toolFailureRate\":null,\"retryCount\":null,\"toolFailureCount\":null,\"regression\":null,\"userCorrection\":null,\"qualityScore\":null,\"recordedAt\":\"2026-10-24T00:00:00.000Z\",\"metadata\":{},\"kind\":\"goal\",\"goalId\":\"goal-1\"},\"metrics\":{},\"before\":{},\"after\":{},\"observed\":true},\"versionComparison\":null,\"reason\":\"goal, tests, regression, and measurable improvement all passed\",\"reasons\":[],\"evidence\":{\"goalPassed\":true,\"testsPassed\":true,\"regressionPassed\":true,\"feedbackProvided\":false,\"projectedResults\":true},\"evaluatedAt\":\"2026-10-24T00:00:00.000Z\"}"
  ],
  [
    "string-and-boolean-values",
    "{\"decision\":\"rollback\",\"confidence\":0.5,\"metrics\":{\"successRate\":{\"before\":1,\"after\":0,\"delta\":-1,\"relativeChange\":-1,\"direction\":\"higher\",\"improved\":false,\"regressed\":true},\"latencyMs\":{\"before\":120,\"after\":100,\"delta\":-20,\"relativeChange\":-0.1667,\"direction\":\"lower\",\"improved\":true,\"regressed\":false},\"cost\":null,\"summary\":{\"observed\":3,\"improved\":2,\"regressed\":1,\"improvementRate\":0.6667},\"latency\":null,\"tokenUsage\":null,\"failureRate\":null,\"userFeedback\":null},\"projection\":{\"metrics\":{},\"before\":{},\"after\":{},\"observed\":false},\"versionComparison\":null,\"reason\":\"goal result did not prove completion; test result did not prove correctness; one or more observed metrics regressed\",\"reasons\":[\"goal result did not prove completion\",\"test result did not prove correctness\",\"one or more observed metrics regressed\"],\"evidence\":{\"goalPassed\":null,\"testsPassed\":null,\"regressionPassed\":true,\"feedbackProvided\":false,\"projectedResults\":false},\"evaluatedAt\":\"2026-10-24T00:00:00.000Z\"}"
  ],
  [
    "empty-metrics",
    "{\"decision\":\"reject\",\"confidence\":0,\"metrics\":{\"summary\":{\"observed\":0,\"improved\":0,\"regressed\":0,\"improvementRate\":null},\"latency\":null,\"tokenUsage\":null,\"cost\":null,\"failureRate\":null,\"userFeedback\":null},\"projection\":{\"metrics\":{},\"before\":{},\"after\":{},\"observed\":false},\"versionComparison\":null,\"reason\":\"goal result did not prove completion; test result did not prove correctness; regression evidence did not prove safety; no before/after metrics were provided\",\"reasons\":[\"goal result did not prove completion\",\"test result did not prove correctness\",\"regression evidence did not prove safety\",\"no before/after metrics were provided\"],\"evidence\":{\"goalPassed\":null,\"testsPassed\":null,\"regressionPassed\":null,\"feedbackProvided\":false,\"projectedResults\":false},\"evaluatedAt\":\"2026-10-24T00:00:00.000Z\"}"
  ],
  [
    "regression-failed",
    "{\"decision\":\"rollback\",\"confidence\":1,\"metrics\":{\"successRate\":{\"before\":0.9,\"after\":0.95,\"delta\":0.05,\"relativeChange\":0.0556,\"direction\":\"higher\",\"improved\":true,\"regressed\":false},\"summary\":{\"observed\":1,\"improved\":1,\"regressed\":0,\"improvementRate\":1},\"latency\":null,\"tokenUsage\":null,\"cost\":null,\"failureRate\":null,\"userFeedback\":null},\"projection\":{\"metrics\":{},\"before\":{},\"after\":{},\"observed\":false},\"versionComparison\":null,\"reason\":\"regression evidence failed\",\"reasons\":[\"regression evidence failed\"],\"evidence\":{\"goalPassed\":true,\"testsPassed\":true,\"regressionPassed\":false,\"feedbackProvided\":false,\"projectedResults\":false},\"evaluatedAt\":\"2026-10-24T00:00:00.000Z\"}"
  ],
  [
    "promote-path",
    "{\"decision\":\"promote\",\"confidence\":1,\"metrics\":{\"successRate\":{\"before\":0.5,\"after\":0.9,\"delta\":0.4,\"relativeChange\":0.8,\"direction\":\"higher\",\"improved\":true,\"regressed\":false},\"cost\":null,\"summary\":{\"observed\":2,\"improved\":2,\"regressed\":0,\"improvementRate\":1},\"latency\":null,\"tokenUsage\":null,\"failureRate\":null,\"userFeedback\":null},\"projection\":{\"goal\":{\"id\":\"goal-1\",\"success\":true,\"completionTimeMs\":null,\"latencyMs\":null,\"tokenUsage\":null,\"cost\":null,\"failureRate\":null,\"toolFailureRate\":null,\"retryCount\":null,\"toolFailureCount\":null,\"regression\":null,\"userCorrection\":null,\"qualityScore\":null,\"recordedAt\":\"2026-10-24T00:00:00.000Z\",\"metadata\":{},\"kind\":\"goal\",\"goalId\":\"goal-1\"},\"metrics\":{},\"before\":{},\"after\":{},\"observed\":true},\"versionComparison\":null,\"reason\":\"goal, tests, regression, and measurable improvement all passed\",\"reasons\":[],\"evidence\":{\"goalPassed\":true,\"testsPassed\":true,\"regressionPassed\":true,\"feedbackProvided\":false,\"projectedResults\":true},\"evaluatedAt\":\"2026-10-24T00:00:00.000Z\"}"
  ],
  [
    "version-comparison",
    "{\"decision\":\"promote\",\"confidence\":1,\"metrics\":{\"latencyMs\":{\"before\":100,\"after\":60,\"delta\":-40,\"relativeChange\":-0.4,\"direction\":\"lower\",\"improved\":true,\"regressed\":false},\"summary\":{\"observed\":1,\"improved\":1,\"regressed\":0,\"improvementRate\":1},\"latency\":null,\"tokenUsage\":null,\"cost\":null,\"failureRate\":null,\"userFeedback\":null},\"projection\":{\"metrics\":{},\"before\":{},\"after\":{},\"observed\":false},\"versionComparison\":null,\"reason\":\"goal, tests, regression, and measurable improvement all passed\",\"reasons\":[],\"evidence\":{\"goalPassed\":true,\"testsPassed\":true,\"regressionPassed\":true,\"feedbackProvided\":false,\"projectedResults\":false},\"evaluatedAt\":\"2026-10-24T00:00:00.000Z\"}"
  ],
  [
    "explicit-current-metrics",
    "{\"decision\":\"promote\",\"confidence\":1,\"metrics\":{\"latencyMs\":{\"before\":200,\"after\":150,\"delta\":-50,\"relativeChange\":-0.25,\"direction\":\"lower\",\"improved\":true,\"regressed\":false},\"qualityScore\":{\"before\":0.4,\"after\":0.8,\"delta\":0.4,\"relativeChange\":1,\"direction\":\"higher\",\"improved\":true,\"regressed\":false},\"summary\":{\"observed\":2,\"improved\":2,\"regressed\":0,\"improvementRate\":1},\"latency\":null,\"tokenUsage\":null,\"cost\":null,\"failureRate\":null,\"userFeedback\":null},\"projection\":{\"metrics\":{},\"before\":{},\"after\":{},\"observed\":false},\"versionComparison\":{\"currentVersion\":\"row-candidate\",\"historicalBestVersion\":\"row-historical\",\"currentMetrics\":{\"p95LatencyMs\":150,\"qualityScore\":0.8},\"historicalBestMetrics\":{\"p95LatencyMs\":200,\"qualityScore\":0.4},\"protectedHistoricalBest\":false},\"reason\":\"goal, tests, regression, and measurable improvement all passed\",\"reasons\":[],\"evidence\":{\"goalPassed\":true,\"testsPassed\":true,\"regressionPassed\":true,\"feedbackProvided\":false,\"projectedResults\":false},\"evaluatedAt\":\"2026-10-24T00:00:00.000Z\"}"
  ],
  [
    "snapshot-fallback",
    "{\"decision\":\"reject\",\"confidence\":0.5,\"metrics\":{\"tokenUsage\":null,\"summary\":{\"observed\":1,\"improved\":1,\"regressed\":0,\"improvementRate\":1},\"latency\":null,\"cost\":null,\"failureRate\":null,\"userFeedback\":null},\"projection\":{\"metrics\":{},\"before\":{},\"after\":{},\"observed\":false},\"versionComparison\":null,\"reason\":\"goal result did not prove completion; test result did not prove correctness\",\"reasons\":[\"goal result did not prove completion\",\"test result did not prove correctness\"],\"evidence\":{\"goalPassed\":null,\"testsPassed\":null,\"regressionPassed\":true,\"feedbackProvided\":false,\"projectedResults\":false},\"evaluatedAt\":\"2026-10-24T00:00:00.000Z\"}"
  ],
  [
    "user-feedback",
    "{\"decision\":\"reject\",\"confidence\":1,\"metrics\":{\"qualityScore\":{\"before\":0.5,\"after\":0.6,\"delta\":0.1,\"relativeChange\":0.2,\"direction\":\"higher\",\"improved\":true,\"regressed\":false},\"summary\":{\"observed\":1,\"improved\":1,\"regressed\":0,\"improvementRate\":1},\"latency\":null,\"tokenUsage\":null,\"cost\":null,\"failureRate\":null,\"userFeedback\":0.2},\"projection\":{\"metrics\":{},\"before\":{},\"after\":{},\"observed\":false},\"versionComparison\":null,\"reason\":\"user feedback is below the acceptance threshold\",\"reasons\":[\"user feedback is below the acceptance threshold\"],\"evidence\":{\"goalPassed\":true,\"testsPassed\":true,\"regressionPassed\":true,\"feedbackProvided\":true,\"projectedResults\":false},\"evaluatedAt\":\"2026-10-24T00:00:00.000Z\"}"
  ],
  [
    "project-evolution-results",
    "{\"agent\":{\"id\":\"agent-1\",\"success\":null,\"completionTimeMs\":null,\"latencyMs\":null,\"tokenUsage\":null,\"cost\":null,\"failureRate\":null,\"toolFailureRate\":null,\"retryCount\":null,\"toolFailureCount\":null,\"regression\":null,\"userCorrection\":null,\"qualityScore\":0.9,\"recordedAt\":\"2026-10-24T00:00:00.000Z\",\"metadata\":{},\"kind\":\"agent\",\"agentId\":\"agent-1\",\"decisionQuality\":null,\"toolSelectionFailure\":0,\"repeatedFailurePattern\":null,\"contextEfficiency\":null,\"goalId\":null,\"sessionId\":null},\"goal\":{\"id\":\"goal-1\",\"success\":true,\"completionTimeMs\":null,\"latencyMs\":120,\"tokenUsage\":null,\"cost\":2,\"failureRate\":null,\"toolFailureRate\":null,\"retryCount\":null,\"toolFailureCount\":null,\"regression\":null,\"userCorrection\":null,\"qualityScore\":null,\"recordedAt\":\"2026-10-24T00:00:00.000Z\",\"metadata\":{},\"kind\":\"goal\",\"goalId\":\"goal-1\"},\"metrics\":{\"qualityScore\":0.9,\"toolSelectionFailure\":0,\"latencyMs\":120,\"cost\":2},\"before\":{\"latency\":200},\"after\":{\"latency\":120,\"qualityScore\":0.9,\"toolSelectionFailure\":0,\"latencyMs\":120,\"cost\":2},\"observed\":true}"
  ],
  [
    "project-evolution-results-empty",
    "{\"metrics\":{},\"before\":{},\"after\":{},\"observed\":false}"
  ],
  [
    "evaluation-of-projection",
    "{\"decision\":\"reject\",\"confidence\":0.75,\"metrics\":{\"summary\":{\"observed\":0,\"improved\":0,\"regressed\":0,\"improvementRate\":null},\"latency\":null,\"tokenUsage\":null,\"cost\":null,\"failureRate\":null,\"userFeedback\":null},\"projection\":{\"metrics\":{},\"before\":{},\"after\":{},\"observed\":false},\"versionComparison\":null,\"reason\":\"no before/after metrics were provided\",\"reasons\":[\"no before/after metrics were provided\"],\"evidence\":{\"goalPassed\":true,\"testsPassed\":true,\"regressionPassed\":true,\"feedbackProvided\":false,\"projectedResults\":false},\"evaluatedAt\":\"2026-10-24T00:00:00.000Z\"}"
  ]
]`);

test("ordinary evidence is byte-for-byte unchanged by the null-prototype merge", () => {
  const actual = ordinaryCases().map(([name, produce]) => [name, JSON.stringify(produce())]);
  assert.deepEqual(actual.map(([name]) => name), PINNED_ORDINARY_EVIDENCE.map(([name]) => name));
  assert.equal(JSON.stringify(actual), JSON.stringify(PINNED_ORDINARY_EVIDENCE), "ordinary evidence output drifted from the pre-fix pin");
  for (const [name, serialized] of actual) {
    assert.equal(typeof serialized, "string", `${name} must serialize`);
    assert.ok(serialized.length > 2, `${name} must not be empty`);
  }
});

// `sourceMetrics()` merges nine optional nested containers by design, so the
// own-property view has to hold for every one of them, not only the `metrics`
// container the production evidence adapter happens to carry today. Before the
// fix each row below produced an inherited `latency` alias and `observed: 1`.
const NESTED_CONTAINER_KEYS = [
  "metrics", "projectedMetrics", "projection", "goalMetrics", "agentMetrics",
  "sessionMetrics", "taskMetrics", "result", "evaluation",
];

test("every nested container sourceMetrics merges reads the payload as data, never as a prototype", () => {
  for (const key of NESTED_CONTAINER_KEYS) {
    const evidence = domainEvaluationEvidence({
      latestObservation: {
        beforeMetrics: ownsProtoKey(`{"${key}":{"__proto__":{"latency":500}}}`),
        afterMetrics: ownsProtoKey(`{"${key}":{"__proto__":{"latency":1}}}`),
        regressionPassed: true,
      },
    });
    const { metrics } = evaluator().evaluate(evidence);
    assert.equal(metrics.summary.observed, 0, `${key}: a payload alias must not become an observed metric`);
    assert.equal(Object.hasOwn(metrics, "latencyMs"), false, `${key}: no latency entry may be created`);
    assert.equal(metrics.summary.regressed, 0, `${key}: a payload alias must not become a regression`);
  }
});
