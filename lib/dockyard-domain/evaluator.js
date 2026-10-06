import { projectEvolutionMetric } from "./metric-projection.js";

const METRIC_RULES = Object.freeze({
  successRate: { aliases: ["successRate", "success_rate", "goalSuccessRate"], direction: "higher" },
  completionTimeMs: { aliases: ["completionTimeMs", "completion_time_ms", "durationMs", "completionTime"], direction: "lower" },
  latencyMs: { aliases: ["latencyMs", "latency", "p95LatencyMs", "p95_latency_ms"], direction: "lower" },
  tokenUsage: { aliases: ["tokenUsage", "tokens", "tokenCount", "token_usage"], direction: "lower" },
  cost: { aliases: ["cost", "costUsd", "resourceCost", "resource_cost"], direction: "lower" },
  failureRate: { aliases: ["failureRate", "failure_rate", "errorRate", "error_rate"], direction: "lower" },
  toolFailureRate: { aliases: ["toolFailureRate", "tool_failure_rate"], direction: "lower" },
  retryCount: { aliases: ["retryCount", "retries", "retry_count"], direction: "lower" },
  toolFailureCount: { aliases: ["toolFailureCount", "toolFailures", "tool_failure_count"], direction: "lower" },
  userCorrection: { aliases: ["userCorrection", "user_correction", "correctionCount", "corrections"], direction: "lower" },
  qualityScore: { aliases: ["qualityScore", "quality", "score", "rating"], direction: "higher" },
  decisionQuality: { aliases: ["decisionQuality", "decision_quality", "decisionScore"], direction: "higher" },
  toolSelectionFailure: { aliases: ["toolSelectionFailure", "tool_selection_failure", "toolSelectionFailureRate", "tool_selection_failure_rate"], direction: "lower" },
  repeatedFailurePattern: { aliases: ["repeatedFailurePattern", "repeated_failure_pattern", "repeatedFailureRate", "repeated_failure_rate"], direction: "lower" },
  regression: { aliases: ["regression", "regressionRate", "regressionCount", "regressions"], direction: "lower" },
  contextEfficiency: { aliases: ["contextEfficiency", "context_efficiency", "contextScore"], direction: "higher" },
});

function clone(value) {
  if (value === undefined || value === null) return value;
  try { return structuredClone(value); } catch {
    if (Array.isArray(value)) return value.map(clone);
    if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
    return typeof value === "function" ? undefined : value;
  }
}
function finite(value) { if (value === undefined || value === null || value === "") return null; const result = typeof value === "number" ? value : Number(value); return Number.isFinite(result) ? result : null; }
function round(value, digits = 4) { return Number(Number(value).toFixed(digits)); }

function sourceMetrics(source) {
  if (!source || typeof source !== "object") return {};
  const result = { ...source };
  for (const key of ["metrics", "projectedMetrics", "projection", "goalMetrics", "agentMetrics", "sessionMetrics", "taskMetrics", "result", "evaluation"]) {
    const nested = source[key];
    if (!nested || typeof nested !== "object") continue;
    Object.assign(result, nested.metrics && typeof nested.metrics === "object" ? nested.metrics : {}, nested);
  }
  return result;
}
function findMetric(source, rule) { const values = sourceMetrics(source); for (const alias of rule.aliases) { const value = finite(values[alias]); if (value !== null) return value; } return null; }
function boolResult(value, fields, statuses) {
  if (typeof value === "boolean") return value;
  if (value && typeof value === "object") {
    for (const field of fields) if (typeof value[field] === "boolean") return value[field];
    if (statuses.includes(String(value.status ?? "").toLowerCase())) return true;
    if (value.status !== undefined) return false;
  }
  return null;
}

function directMetricPair(input, rule) {
  const before = input?.beforeMetrics ?? input?.before ?? {}; const after = input?.afterMetrics ?? input?.after ?? {};
  let beforeValue = findMetric(before, rule); let afterValue = findMetric(after, rule);
  for (const alias of rule.aliases) {
    const direct = input?.[alias];
    if (direct && typeof direct === "object") { beforeValue ??= finite(direct.before ?? direct.baseline); afterValue ??= finite(direct.after ?? direct.candidate ?? direct.value); }
    else if (direct !== undefined) afterValue ??= finite(direct);
  }
  return { before: beforeValue, after: afterValue };
}
function metricComparison(input, beforeSnapshot, afterSnapshot) {
  const metrics = {};
  for (const [key, rule] of Object.entries(METRIC_RULES)) {
    const pair = directMetricPair(input, rule); const before = pair.before ?? findMetric(beforeSnapshot, rule); const after = pair.after ?? findMetric(afterSnapshot, rule);
    if (before === null && after === null) continue;
    const delta = before === null || after === null ? null : round(after - before);
    const relativeChange = before === null || after === null || before === 0 ? null : round((after - before) / Math.abs(before));
    const improved = delta === null ? null : rule.direction === "higher" ? delta > 0 : delta < 0;
    const regressed = delta === null ? null : rule.direction === "higher" ? delta < 0 : delta > 0;
    metrics[key] = { before, after, delta, relativeChange, direction: rule.direction, improved, regressed };
  }
  return metrics;
}
function metricSummary(metrics) { const entries = Object.values(metrics); const observed = entries.filter((entry) => entry.before !== null && entry.after !== null); return { observed: observed.length, improved: observed.filter((entry) => entry.improved === true).length, regressed: observed.filter((entry) => entry.regressed === true).length, improvementRate: observed.length ? round(observed.filter((entry) => entry.improved === true).length / observed.length) : null }; }
function feedbackValue(feedback) { if (typeof feedback === "number") return finite(feedback); if (!feedback || typeof feedback !== "object") return null; return finite(feedback.score ?? feedback.rating ?? feedback.value); }
function now(clock) { const value = typeof clock === "function" ? clock() : new Date(); return (value instanceof Date ? value : new Date(value)).toISOString(); }

/** Convert optional Agent/Goal/Session/Task results into one stable evaluator shape. */
export function projectEvolutionResults({ agentResult = null, goalResult = null, sessionResult = null, taskResult = null, clock = () => new Date() } = {}) {
  const entries = {}; const before = {}; const after = {}; const metrics = {};
  for (const [kind, result] of [["agent", agentResult], ["goal", goalResult], ["session", sessionResult], ["task", taskResult]]) {
    if (!result || typeof result !== "object") continue;
    const projected = projectEvolutionMetric(kind, result, { clock }); entries[kind] = projected;
    for (const [key, value] of Object.entries(projected)) if (typeof value === "number" && Number.isFinite(value)) metrics[key] ??= value;
    const source = result.metrics && typeof result.metrics === "object" ? result.metrics : result;
    if (source.beforeMetrics && typeof source.beforeMetrics === "object") Object.assign(before, source.beforeMetrics);
    if (source.afterMetrics && typeof source.afterMetrics === "object") Object.assign(after, source.afterMetrics);
  }
  Object.assign(after, metrics);
  return { ...entries, metrics, before, after, observed: Object.keys(entries).length > 0 };
}

/** Pure evidence evaluator. It recommends only; it never mutates a registry or calls a guard. */
export class EvolutionEvaluator {
  constructor({ clock = () => new Date(), minConfidence = 0.6, minFeedback = 0.5 } = {}) { this.clock = clock; this.minConfidence = Math.max(0, Math.min(1, Number(minConfidence) || 0.6)); this.minFeedback = Math.max(0, Math.min(1, Number(minFeedback) || 0.5)); }
  evaluate({ beforeSnapshot = {}, afterSnapshot = {}, historicalBestSnapshot = null, currentVersion = null, historicalBestVersion = null, currentMetrics = null, historicalBestMetrics = null, goalResult = null, agentResult = null, sessionResult = null, taskResult = null, testResult = null, latency = undefined, tokenUsage = undefined, cost = undefined, failureRate = undefined, regressionResult = null, userFeedback = null, metricProjection = null, ...rest } = {}) {
    const versionComparison = Boolean(currentMetrics || historicalBestMetrics || historicalBestSnapshot);
    const resolvedBeforeSnapshot = historicalBestMetrics || historicalBestSnapshot
      ? { ...beforeSnapshot, metrics: { ...(beforeSnapshot.metrics ?? {}), ...(historicalBestSnapshot?.metrics ?? {}), ...(historicalBestMetrics ?? {}) } }
      : beforeSnapshot;
    const resolvedAfterSnapshot = currentMetrics
      ? { ...afterSnapshot, metrics: { ...(afterSnapshot.metrics ?? {}), ...(currentMetrics ?? {}) } }
      : afterSnapshot;
    const projection = metricProjection ?? projectEvolutionResults({ agentResult, goalResult, sessionResult, taskResult, clock: this.clock });
    const input = { ...rest, latency, tokenUsage, cost, failureRate, ...projection, goalMetrics: projection.goal, agentMetrics: projection.agent, sessionMetrics: projection.session };
    const projectedBefore = { ...(projection.before ?? {}) }; const projectedAfter = { ...(projection.after ?? {}) };
    const goalEvidence = boolResult(goalResult, ["success", "ok", "completed", "passed"], ["success", "succeeded", "completed", "passed"]);
    const taskEvidence = boolResult(taskResult, ["success", "ok", "completed", "passed"], ["success", "succeeded", "completed", "passed"]);
    // Metrics prove change, not correctness. Keep the three independent
    // promotion gates fail-closed instead of treating a version comparison or
    // any projected runtime result as synthetic goal/test/regression success.
    const goalPassed = goalEvidence ?? taskEvidence;
    const testsEvidence = boolResult(testResult, ["passed", "success", "ok"], ["passed", "success", "succeeded", "ok"]);
    const testsPassed = testsEvidence;
    const regressionEvidence = boolResult(regressionResult, ["passed", "success", "ok"], ["passed", "success", "succeeded", "ok"]);
    const regressionPassed = regressionEvidence;
    const metrics = metricComparison(input, { ...resolvedBeforeSnapshot, metrics: { ...(resolvedBeforeSnapshot.metrics ?? {}), ...projectedBefore } }, { ...resolvedAfterSnapshot, metrics: { ...(resolvedAfterSnapshot.metrics ?? {}), ...projectedAfter } });
    const summary = metricSummary(metrics); const feedback = feedbackValue(userFeedback);
    const evidence = [goalPassed === true, testsPassed === true, regressionPassed !== null, summary.observed > 0];
    const confidence = round(Math.min(1, evidence.filter(Boolean).length / evidence.length + (feedback === null ? 0 : 0.05)));
    const reasons = [];
    if (goalPassed !== true) reasons.push("goal result did not prove completion");
    if (testsPassed !== true) reasons.push("test result did not prove correctness");
    if (regressionPassed === false) reasons.push("regression evidence failed");
    else if (regressionPassed !== true) reasons.push("regression evidence did not prove safety");
    if (summary.observed === 0) reasons.push("no before/after metrics were provided"); else if (summary.improved === 0) reasons.push("observed metrics did not improve");
    if (summary.regressed > 0) reasons.push("one or more observed metrics regressed");
    if (feedback !== null && feedback < this.minFeedback) reasons.push("user feedback is below the acceptance threshold");
    let decision = "reject";
    if (regressionPassed === false || summary.regressed > 0) decision = "rollback";
    else if (goalPassed === true && testsPassed === true && regressionPassed === true && summary.improved > 0 && summary.regressed === 0 && confidence >= this.minConfidence && (feedback === null || feedback >= this.minFeedback)) decision = "promote";
    return { decision, confidence, metrics: { ...metrics, summary, latency: finite(latency), tokenUsage: finite(tokenUsage), cost: finite(cost), failureRate: finite(failureRate), userFeedback: feedback }, projection: clone(projection), versionComparison: versionComparison ? { currentVersion, historicalBestVersion, currentMetrics: clone(resolvedAfterSnapshot.metrics ?? {}), historicalBestMetrics: clone(resolvedBeforeSnapshot.metrics ?? {}), protectedHistoricalBest: summary.regressed > 0 } : null, reason: reasons.length ? reasons.join("; ") : "goal, tests, regression, and measurable improvement all passed", reasons, evidence: { goalPassed, testsPassed, regressionPassed, feedbackProvided: feedback !== null, projectedResults: projection.observed }, evaluatedAt: now(this.clock) };
  }
  compareVersions({ currentVersion = null, historicalBestVersion = null, currentMetrics = {}, historicalBestMetrics = {}, expected = {}, ...rest } = {}) {
    const evaluation = this.evaluate({
      ...rest,
      currentVersion,
      historicalBestVersion,
      currentMetrics,
      historicalBestMetrics,
      beforeSnapshot: { metrics: historicalBestMetrics },
      afterSnapshot: { metrics: currentMetrics },
      goalResult: rest.goalResult,
      testResult: rest.testResult,
      regressionResult: rest.regressionResult,
      expected,
    });
    const better = evaluation.decision === "promote";
    const regressed = evaluation.decision === "rollback" || evaluation.metrics.summary.regressed > 0;
    return {
      currentVersion,
      historicalBestVersion,
      currentMetrics: clone(currentMetrics),
      historicalBestMetrics: clone(historicalBestMetrics),
      better,
      improved: evaluation.metrics.summary.improved > 0 && !regressed,
      regressed,
      decision: better ? "promote" : regressed ? "rollback" : "keep_historical_best",
      recommendation: better ? "promote" : "keep_historical_best",
      evaluationDecision: evaluation.decision,
      evaluation,
    };
  }

  compareWithHistoricalBest(input = {}) { return this.compareVersions(input); }
  evaluateAgainstHistoricalBest(input = {}) { return this.compareVersions(input); }

  evaluateLegacy({ eligible = false, evidence = {} } = {}) { const accepted = eligible === true; return { decision: accepted ? "promote" : "reject", confidence: accepted ? 1 : 0, metrics: {}, reason: accepted ? "legacy structural evidence passed" : "legacy structural evidence failed", reasons: accepted ? [] : ["legacy structural evidence failed"], evidence: clone(evidence), evaluatedAt: now(this.clock) }; }

  /**
   * Evaluate a candidate against every supplied guardrail, not only the metric
   * it claims to optimize. This is the anti-gaming seam used by long-running
   * trials: a cheaper/faster candidate is still rejected when quality,
   * reliability, or regression evidence gets worse.
   */
  evaluateAntiGaming({ scenarios = [], ...defaults } = {}) {
    const inputs = Array.isArray(scenarios) ? scenarios : [];
    const results = inputs.map((scenario, index) => {
      const evaluation = this.evaluate({ ...defaults, ...scenario });
      const name = scenario.name ?? scenario.id ?? `scenario-${index + 1}`;
      return {
        name: String(name),
        decision: evaluation.decision,
        accepted: evaluation.decision === "promote",
        gamingSafe: evaluation.decision !== "promote" || evaluation.metrics.summary.regressed === 0,
        regressionDetected: evaluation.metrics.summary.regressed > 0 || evaluation.decision === "rollback",
        evaluation,
      };
    });
    return {
      scenarios: results,
      allGuardrailsPassed: results.length > 0 && results.every((entry) => entry.gamingSafe),
      expectedDecisions: {
        lowerCostLowerQuality: results.find((entry) => /token|quality|cost/i.test(entry.name))?.decision ?? null,
        fasterHigherFailure: results.find((entry) => /speed|latency|failure/i.test(entry.name))?.decision ?? null,
        comprehensiveImprovement: results.find((entry) => /综合|comprehensive|all|promote/i.test(entry.name))?.decision ?? null,
      },
      evaluatedAt: now(this.clock),
    };
  }
}

/** Named adapter for callers that want an explicit anti-gaming evaluator. */
export class AntiGamingEvaluator extends EvolutionEvaluator {}
export function evaluateAntiGamingScenarios(input = {}, options = {}) {
  return new AntiGamingEvaluator(options).evaluateAntiGaming(input);
}

export function createEvolutionEvaluator(options = {}) { return new EvolutionEvaluator(options); }
export const EVOLUTION_METRIC_RULES = METRIC_RULES;
