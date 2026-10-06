/** Discovery and metric normalization for continuous evolution. */
import { clamp01, clone, finite, hash, safeRecord, safeValue, timestamp } from "./shared.js";

const METRIC_DEFINITIONS = Object.freeze({
  successRate: { aliases: ["successRate", "success_rate", "goalSuccessRate"], direction: "higher", area: "reliability", label: "success rate" },
  latency: { aliases: ["latency", "latencyMs", "p95LatencyMs", "p95_latency_ms", "completionTimeMs", "durationMs"], direction: "lower", area: "performance", label: "latency" },
  cost: { aliases: ["cost", "costUsd", "resourceCost", "resource_cost", "avgResourceCost"], direction: "lower", area: "cost", label: "cost" },
  tokenUsage: { aliases: ["tokenUsage", "tokens", "tokenCount", "token_usage"], direction: "lower", area: "efficiency", label: "token usage" },
  retry: { aliases: ["retry", "retryCount", "retries", "retry_count"], direction: "lower", area: "reliability", label: "retry rate" },
  toolFailure: { aliases: ["toolFailure", "toolFailureRate", "toolFailureCount", "toolFailures", "tool_failure_rate", "tool_failure_count"], direction: "lower", area: "tooling", label: "tool failure" },
  qualityScore: { aliases: ["qualityScore", "quality", "score", "rating"], direction: "higher", area: "quality", label: "quality score" },
  regression: { aliases: ["regression", "regressionRate", "regressionCount", "regressions"], direction: "lower", area: "reliability", label: "regression" },
});

function sourceObjects(sample) {
  if (!sample || typeof sample !== "object") return [];
  const result = [];
  for (const value of [sample.metrics, sample.result?.metrics, sample.result, sample.evaluation?.metrics, sample]) {
    if (value && typeof value === "object" && !Array.isArray(value)) result.push(value);
  }
  return result;
}

function metricFromSample(sample, definition, canonical) {
  for (const source of sourceObjects(sample)) {
    for (const alias of definition.aliases) {
      if (!Object.hasOwn(source, alias)) continue;
      const raw = source[alias];
      if (canonical === "regression" && alias === "regressionPassed") return raw === true ? 0 : raw === false ? 1 : finite(raw);
      if (typeof raw === "boolean") return raw ? 1 : 0;
      const value = finite(raw);
      if (value !== null) return value;
    }
  }
  if (canonical === "successRate") {
    for (const source of sourceObjects(sample)) if (typeof source.success === "boolean") return source.success ? 1 : 0;
  }
  if (canonical === "regression") {
    for (const source of sourceObjects(sample)) if (typeof source.regressionPassed === "boolean") return source.regressionPassed ? 0 : 1;
  }
  return null;
}

function normalizeSample(sample = {}) {
  const result = safeRecord(sample);
  for (const [canonical, definition] of Object.entries(METRIC_DEFINITIONS)) {
    const value = metricFromSample(sample, definition, canonical);
    if (value !== null) result[canonical] = value;
  }
  if (result.toolFailure === undefined && result.toolFailureRate !== undefined) result.toolFailure = result.toolFailureRate;
  if (result.retry === undefined && result.retryCount !== undefined) result.retry = result.retryCount;
  if (result.latency === undefined && result.latencyMs !== undefined) result.latency = result.latencyMs;
  if (result.regression === undefined && typeof result.regressionPassed === "boolean") result.regression = result.regressionPassed ? 0 : 1;
  return result;
}

function stripManualDiscoveryFields(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = clone(input);
  // A target/goal supplied by a caller is a request, not evidence. Discovery
  // intentionally removes it before extracting runtime samples so an
  // operator cannot steer the open-ended target detector.
  for (const key of ["target", "targetId", "targetComponent", "componentId", "requestedTarget", "manualTarget", "goal", "objective", "requestedGoal"]) delete source[key];
  source.source = "runtime-derived";
  return source;
}

function extractSource(input) {
  let source = input;
  if (source && typeof source.snapshot === "function") {
    source = source.snapshot();
  }
  if (source?.metrics && typeof source.metrics.snapshot === "function") {
    source = { ...source, metrics: source.metrics.snapshot() };
  }
  if (source?.metrics && typeof source.metrics === "object" && !Array.isArray(source.metrics)) {
    const metricSource = source.metrics;
    if (typeof metricSource.snapshot === "function") {
      source = { ...source, metrics: metricSource.snapshot() };
    }
  }
  return source;
}

function extractSamples(input = {}) {
  const source = extractSource(input);
  if (Array.isArray(source)) return source;
  if (!source || typeof source !== "object") return [];
  for (const key of ["samples", "history", "metricSamples", "runtimeSamples"]) if (Array.isArray(source[key])) return source[key];
  if (source.beforeMetrics || source.afterMetrics || source.baselineMetrics || source.candidateMetrics) {
    return [source.beforeMetrics ?? source.baselineMetrics ?? {}, source.afterMetrics ?? source.candidateMetrics ?? {}];
  }
  const collections = [];
  for (const key of ["tasks", "goals", "agents", "sessions", "components", "observations"]) if (Array.isArray(source[key])) collections.push(...source[key]);
  if (collections.length > 0) return collections;
  if (source.metrics && typeof source.metrics === "object" && !Array.isArray(source.metrics)) {
    const nested = source.metrics;
    for (const key of ["samples", "history", "metricSamples", "runtimeSamples"]) if (Array.isArray(nested[key])) return nested[key];
    const nestedCollections = [];
    for (const key of ["tasks", "goals", "agents", "sessions", "components"]) if (Array.isArray(nested[key])) nestedCollections.push(...nested[key]);
    if (nestedCollections.length > 0) return nestedCollections;
    return [nested];
  }
  return [source];
}

function sampleCount(input, samples) {
  const explicit = finite(input?.sampleCount ?? input?.samplesCount);
  return explicit === null ? samples.length : Math.max(0, explicit);
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function trendFor(before, after, direction, threshold) {
  if (before === null || after === null) return { trend: "insufficient", relativeChange: null, worsening: false, improving: false };
  const delta = after - before;
  const relativeChange = delta / Math.max(Math.abs(before), 1);
  const meaningful = Math.abs(relativeChange) >= threshold;
  const improving = meaningful && (direction === "higher" ? delta > 0 : delta < 0);
  const worsening = meaningful && (direction === "higher" ? delta < 0 : delta > 0);
  return {
    trend: worsening ? "degrading" : improving ? "improving" : "stable",
    delta,
    relativeChange,
    worsening,
    improving,
  };
}

function areaFor(metric) {
  return METRIC_DEFINITIONS[metric]?.area ?? "runtime";
}

function priorityFor(confidence, relativeChange, impact = 0, trend = "") {
  const magnitude = Math.abs(relativeChange ?? 0);
  if (trend === "abnormal_growth" || confidence >= 0.82 || magnitude >= 0.3 || impact >= 3) return "high";
  if (confidence >= 0.64 || magnitude >= 0.1 || impact >= 1) return "medium";
  return "low";
}

function candidateConfidence(count, relativeChange, consistency = 1, impact = 0) {
  return Number(Math.min(0.98, 0.45 + Math.min(0.25, count / 20) + Math.min(0.15, Math.abs(relativeChange ?? 0)) + Math.min(0.1, consistency * 0.1) + (impact > 0.5 ? 0.05 : 0)).toFixed(4));
}

function patternValue(entry) {
  if (!entry || typeof entry !== "object") return String(entry ?? "");
  return String(entry.patternKey ?? entry.failurePattern ?? entry.failureMode ?? entry.errorCode ?? entry.type ?? entry.message ?? "failure").trim();
}

function patternEntries(input, samples) {
  const explicit = input?.failurePatterns ?? input?.repeatedFailurePatterns ?? input?.failures ?? input?.patterns ?? [];
  const entries = Array.isArray(explicit) ? explicit : Object.entries(explicit ?? {}).flatMap(([key, value]) => Array.from({ length: Math.max(0, Number(value) || 0) }, () => ({ patternKey: key })));
  for (const sample of samples) {
    const normalized = normalizeSample(sample);
    const failure = sample?.success === false || normalized.failureRate > 0 || normalized.toolFailure > 0 || normalized.retry > 0 || sample?.status === "failed" || sample?.status === "error";
    if (failure) entries.push(sample);
  }
  return entries.map((entry) => ({ entry, key: patternValue(entry).toLowerCase().replace(/\\s+/g, " ") })).filter((value) => value.key);
}

export function normalizeProposal(input = {}, { clock = () => new Date() } = {}) {
  const evidence = Array.isArray(input.evidence)
    ? input.evidence.map((entry) => safeValue(entry)).filter((entry) => entry !== undefined)
    : safeRecord(input.evidence ?? {});
  const confidence = clamp01(input.confidence, 0.5);
  const priorityValue = String(input.priority ?? "medium").toLowerCase();
  const priority = ["low", "medium", "high"].includes(priorityValue) ? priorityValue : priorityValue === "critical" ? "high" : "medium";
  const suggestedArea = input.suggested_area ?? input.suggestedArea ?? input.suggestedCapability?.area ?? input.area ?? null;
  const problem = input.problem ?? input.message ?? "Evolution target requires diagnosis";
  const idValue = input.id ?? "target:" + hash(String(problem) + ":" + String(input.patternKey ?? input.metric ?? "runtime"));
  return {
    id: String(idValue),
    problem: String(problem).slice(0, 500),
    evidence,
    confidence,
    priority,
    suggested_area: suggestedArea,
    suggestedArea,
    target: input.target ?? input.targetComponent ?? input.componentId ?? null,
    targetComponent: input.targetComponent ?? input.componentId ?? input.target ?? null,
    patternKey: input.patternKey ?? null,
    metric: input.metric ?? null,
    trend: input.trend ?? null,
    trendSignals: Array.isArray(input.trendSignals) ? [...input.trendSignals] : [],
    expectedImprovement: safeRecord(input.expectedImprovement ?? {}),
    estimatedBenefit: finite(input.estimatedBenefit ?? input.expectedBenefit ?? input.benefitScore ?? input.benefit),
    benefitScore: finite(input.benefitScore ?? input.estimatedBenefit ?? input.expectedBenefit ?? input.benefit),
    occurrences: finite(input.occurrences ?? input.frequency) ?? 0,
    sampleCount: finite(input.sampleCount) ?? evidence.length,
    impact: finite(input.impact) ?? 0,
    source: input.source ?? "runtime-metrics",
    status: input.status ?? "candidate",
    discoveredAt: input.discoveredAt ?? timestamp(clock),
  };
}

function metricProposal(metric, definition, before, after, values, trend, input, clock) {
  const first = values.slice(0, Math.max(1, Math.ceil(values.length / 2)));
  const second = values.slice(Math.max(1, Math.ceil(values.length / 2)));
  const consistency = values.length < 2 ? 0 : values.slice(1).filter((value, index) => definition.direction === "higher" ? value >= values[index] : value <= values[index]).length / (values.length - 1);
  const impact = Math.abs(trend.relativeChange ?? 0) * values.length;
  const trendName = trend.worsening && values.length >= 2 && second.length > first.length ? "abnormal_growth" : "degrading";
  const confidence = candidateConfidence(values.length, trend.relativeChange, consistency, impact);
  const problem = definition.label + " is " + (trendName === "abnormal_growth" ? "growing abnormally" : "degrading");
  return normalizeProposal({
    id: "target:" + hash(metric + ":" + problem),
    problem,
    metric,
    evidence: [{ metric, before, after, delta: trend.delta, relativeChange: trend.relativeChange, direction: definition.direction, samples: values.length, values: values.slice(-8) }],
    confidence,
    priority: priorityFor(confidence, trend.relativeChange, impact, trendName),
    suggested_area: areaFor(metric),
    trend: trendName,
    trendSignals: ["performance_degradation", ...(trendName === "abnormal_growth" ? ["abnormal_growth"] : [])],
    expectedImprovement: { [metric]: definition.direction === "higher" ? "increase" : "decrease" },
    estimatedBenefit: Math.abs(trend.relativeChange ?? 0),
    benefitScore: Math.abs(trend.relativeChange ?? 0),
    occurrences: values.length,
    sampleCount: sampleCount(input, extractSamples(input)),
    impact,
    source: input?.source ?? "runtime-metrics",
  }, { clock });
}

/**
 * Read-only target discovery over existing runtime metrics and observations.
 * It returns candidates only; it never calls EvolutionEngine or mutates a
 * ComponentRegistry.
 */
export class EvolutionDiscovery {
  constructor({ metrics = null, memory = null, clock = () => new Date(), minSamples = 3, minOccurrences = 3, degradationThreshold = 0.05, maxTargets = 20, persist = true } = {}) {
    this.metrics = metrics;
    this.memory = memory;
    this.clock = clock;
    this.minSamples = Math.max(2, Number(minSamples) || 3);
    this.minOccurrences = Math.max(2, Number(minOccurrences) || 3);
    this.degradationThreshold = Math.max(0.001, Number(degradationThreshold) || 0.05);
    this.maxTargets = Math.max(1, Number(maxTargets) || 20);
    this.persist = persist !== false;
    this.last = [];
    this.ignoredManualInput = false;
  }

  analyze(input = {}) {
    const supplied = input && typeof input === "object" ? input : {};
    this.ignoredManualInput = ["target", "targetId", "targetComponent", "componentId", "requestedTarget", "manualTarget", "goal", "objective", "requestedGoal"].some((key) => Object.hasOwn(supplied, key));
    const source = Object.keys(supplied).length ? stripManualDiscoveryFields(supplied) : this.metrics;
    const samples = extractSamples(source);
    const normalizedSamples = samples.map(normalizeSample);
    const proposals = [];
    for (const [metric, definition] of Object.entries(METRIC_DEFINITIONS)) {
      const values = normalizedSamples.map((sample) => finite(sample[metric])).filter((value) => value !== null);
      const explicitPair = Boolean(source?.beforeMetrics || source?.afterMetrics || source?.baselineMetrics || source?.candidateMetrics);
      if (values.length < this.minSamples && !(explicitPair && values.length >= 2)) continue;
      const split = Math.max(1, Math.ceil(values.length / 2));
      const before = mean(values.slice(0, split));
      const after = mean(values.slice(split)) ?? mean(values.slice(-Math.max(1, Math.floor(values.length / 2))));
      const trend = trendFor(before, after, definition.direction, this.degradationThreshold);
      if (!trend.worsening) continue;
      proposals.push(metricProposal(metric, definition, before, after, values, trend, source, this.clock));
    }
    const grouped = new Map();
    for (const value of patternEntries(source, samples)) {
      if (!grouped.has(value.key)) grouped.set(value.key, []);
      grouped.get(value.key).push(value.entry);
    }
    for (const [patternKey, entries] of grouped) {
      if (entries.length < this.minOccurrences) continue;
      const impact = entries.reduce((sum, entry) => sum + (finite(entry?.impact ?? entry?.severityScore) ?? (entry?.severity === "critical" ? 2 : entry?.severity === "warning" ? 0.5 : 1)), 0);
      const confidence = candidateConfidence(entries.length, entries.length > this.minOccurrences ? 0.1 : 0, 1, impact);
      proposals.push(normalizeProposal({
        id: "target:" + hash("failure:" + patternKey),
        problem: "repeated failure pattern: " + patternKey,
        patternKey,
        evidence: entries.slice(-8).map((entry) => safeValue(entry)).filter((entry) => entry !== undefined),
        confidence,
        priority: priorityFor(confidence, entries.length / Math.max(1, this.minOccurrences), impact, entries.length >= this.minOccurrences * 2 ? "abnormal_growth" : "repeated"),
        suggested_area: patternKey.includes("tool") ? "tooling" : patternKey.includes("latency") ? "performance" : "reliability",
        trend: entries.length >= this.minOccurrences * 2 ? "abnormal_growth" : "repeated",
        trendSignals: ["repeated_failure", ...(entries.length >= this.minOccurrences * 2 ? ["abnormal_growth"] : [])],
        expectedImprovement: { failureRate: "decrease" },
        estimatedBenefit: Math.min(1, entries.length / 10),
        benefitScore: Math.min(1, entries.length / 10),
        occurrences: entries.length,
        sampleCount: sampleCount(source, samples),
        impact,
        source: source?.source ?? "runtime-metrics",
      }, { clock: this.clock }));
    }
    const unique = new Map();
    for (const proposal of proposals) unique.set(proposal.id, proposal);
    const priorityRank = { high: 3, medium: 2, low: 1 };
    this.last = [...unique.values()]
      .sort((left, right) => (priorityRank[right.priority] ?? 0) - (priorityRank[left.priority] ?? 0) || right.confidence - left.confidence || right.impact - left.impact)
      .slice(0, this.maxTargets)
      .map((proposal) => ({ ...proposal, source: "runtime-derived", target: null, targetComponent: null }))
      .map(clone);
    return this.last.map(clone);
  }

  discover(input = {}) {
    return this.analyze(input);
  }

  async propose(input = {}) {
    const proposals = this.analyze(input);
    if (this.persist && this.memory?.recordCandidate) for (const proposal of proposals) await this.memory.recordCandidate(proposal);
    return proposals.map(clone);
  }

  async discoverAsync(input = {}) { return this.propose(input); }
  targets(input = {}) { return this.analyze(input); }
  snapshot() { return { targets: this.last.map(clone), targetCount: this.last.length, minSamples: this.minSamples, minOccurrences: this.minOccurrences, openEnded: true, ignoredManualInput: this.ignoredManualInput }; }
}

export const normalizeEvolutionTargetProposal = normalizeProposal;
export const normalizeEvolutionProposal = normalizeProposal;
export const AutonomousDiscovery = EvolutionDiscovery;
export const EvolutionTargetDiscovery = EvolutionDiscovery;
export const DiscoveryLayer = EvolutionDiscovery;

export function metricsFitness(metrics = {}) {
  const values = [];
  for (const [metric, definition] of Object.entries(METRIC_DEFINITIONS)) {
    const value = finite(metrics[metric] ?? metrics[definition.aliases[0]]);
    if (value === null) continue;
    if (definition.direction === "higher") values.push(clamp01(value));
    else values.push(clamp01(1 / (1 + Math.max(0, value))));
  }
  return values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(6)) : 0;
}
