function clone(value) {
  if (value === undefined || value === null) return value;
  try { return structuredClone(value); } catch {
    if (Array.isArray(value)) return value.map(clone);
    if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
    return typeof value === "function" ? undefined : value;
  }
}

function readonlyProjection(value) {
  const seen = new WeakMap();
  const protect = (entry) => {
    if (!entry || typeof entry !== "object") return entry;
    if (entry instanceof Date) return new Date(entry.getTime());
    if (seen.has(entry)) return seen.get(entry);
    const target = Array.isArray(entry) ? [] : {};
    const projection = new Proxy(target, {
      set() { const error = new Error("E_MUTATION_AUTHORITY_REQUIRED: evolution metrics projection is read-only"); error.code = "E_MUTATION_AUTHORITY_REQUIRED"; throw error; },
      defineProperty() { const error = new Error("E_MUTATION_AUTHORITY_REQUIRED: evolution metrics projection is read-only"); error.code = "E_MUTATION_AUTHORITY_REQUIRED"; throw error; },
      deleteProperty() { const error = new Error("E_MUTATION_AUTHORITY_REQUIRED: evolution metrics projection is read-only"); error.code = "E_MUTATION_AUTHORITY_REQUIRED"; throw error; },
    });
    seen.set(entry, projection);
    for (const key of Reflect.ownKeys(entry)) {
      if (Array.isArray(target) && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) continue;
      Object.defineProperty(target, key, {
        value: protect(descriptor.value), enumerable: descriptor.enumerable,
        configurable: true, writable: true,
      });
    }
    return projection;
  };
  return protect(value);
}

function number(value) {
  if (value === undefined || value === null || value === "") return null;
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? result : null;
}

function timestamp(clock) {
  const value = typeof clock === "function" ? clock() : new Date();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function firstValue(sample, names) {
  const sources = [sample?.metrics, sample?.result?.metrics, sample];
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const name of names) {
      const value = number(source[name]);
      if (value !== null) return value;
    }
  }
  return null;
}

function firstRaw(sample, names) {
  const sources = [sample?.metrics, sample?.result?.metrics, sample];
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const name of names) if (source[name] !== undefined && source[name] !== null) return source[name];
  }
  return null;
}

function outcome(sample = {}) {
  const explicit = firstRaw(sample, ["success", "ok", "completed", "passed"]);
  if (explicit !== null) return typeof explicit === "boolean" ? explicit : Boolean(explicit);
  const status = String(firstRaw(sample, ["status"]) ?? "").toLowerCase();
  if (["success", "succeeded", "completed", "complete", "passed", "ok"].includes(status)) return true;
  if (["failure", "failed", "error", "rejected", "cancelled", "canceled", "timeout", "timed_out"].includes(status)) return false;
  return null;
}

function indicator(sample, names) {
  const raw = firstRaw(sample, names);
  if (typeof raw === "boolean") return raw ? 1 : 0;
  return number(raw);
}

function idFor(sample, prefix, clock) {
  return String(sample.id ?? sample[`${prefix}Id`] ?? `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`);
}

function common(sample, prefix, clock) {
  const success = outcome(sample);
  return {
    id: idFor(sample, prefix, clock),
    success,
    completionTimeMs: firstValue(sample, ["completionTimeMs", "completion_time_ms", "durationMs", "duration"]),
    latencyMs: firstValue(sample, ["latencyMs", "latency", "p95LatencyMs", "p95_latency_ms"]),
    tokenUsage: firstValue(sample, ["tokenUsage", "tokens", "tokenCount", "token_usage"]),
    cost: firstValue(sample, ["cost", "costUsd", "resourceCost", "resource_cost"]),
    failureRate: firstValue(sample, ["failureRate", "failure_rate", "errorRate", "error_rate"]),
    toolFailureRate: firstValue(sample, ["toolFailureRate", "tool_failure_rate"]),
    retryCount: firstValue(sample, ["retryCount", "retries", "retry_count"]),
    toolFailureCount: firstValue(sample, ["toolFailureCount", "toolFailures", "tool_failure_count"]),
    regression: firstValue(sample, ["regression", "regressionRate", "regressionCount", "regressions"]),
    userCorrection: indicator(sample, ["userCorrection", "user_correction", "correctionCount", "corrections"]),
    qualityScore: firstValue(sample, ["qualityScore", "quality", "score", "rating"]),
    recordedAt: sample.recordedAt ?? timestamp(clock),
    metadata: clone(sample.metadata ?? {}),
  };
}

function normalizeTask(sample = {}, clock) {
  return { ...common(sample, "task", clock), kind: "task", taskId: idFor(sample, "task", clock), goalId: sample.goalId ?? null, agentId: sample.agentId ?? null, sessionId: sample.sessionId ?? null };
}

function normalizeGoal(sample = {}, clock) {
  return { ...common(sample, "goal", clock), kind: "goal", goalId: idFor(sample, "goal", clock), retryCount: firstValue(sample, ["retryCount", "retries", "retry_count"]), toolFailureCount: firstValue(sample, ["toolFailureCount", "toolFailures", "tool_failure_count"]), userCorrection: indicator(sample, ["userCorrection", "user_correction", "correctionCount", "corrections"]) };
}

function normalizeAgent(sample = {}, clock) {
  return {
    ...common(sample, "agent", clock),
    kind: "agent",
    agentId: idFor(sample, "agent", clock),
    decisionQuality: firstValue(sample, ["decisionQuality", "decision_quality", "decisionScore"]),
    toolSelectionFailure: indicator(sample, ["toolSelectionFailure", "tool_selection_failure", "toolSelectionFailureRate", "tool_selection_failure_rate"]),
    repeatedFailurePattern: indicator(sample, ["repeatedFailurePattern", "repeated_failure_pattern", "repeatedFailureRate", "repeated_failure_rate"]),
    contextEfficiency: firstValue(sample, ["contextEfficiency", "context_efficiency", "contextScore"]),
    goalId: sample.goalId ?? null,
    sessionId: sample.sessionId ?? null,
  };
}

function normalizeSession(sample = {}, clock) {
  return { ...common(sample, "session", clock), kind: "session", sessionId: idFor(sample, "session", clock), goalId: sample.goalId ?? null, agentId: sample.agentId ?? null, toolFailureCount: firstValue(sample, ["toolFailureCount", "toolFailures", "tool_failure_count"]) };
}

function normalizeComponent(sample = {}, clock) {
  const componentId = sample.componentId ?? sample.id ?? sample.name;
  if (!componentId) throw new TypeError("Evolution component metric requires componentId or id");
  const regressionPassed = sample.regressionPassed ?? sample.regression?.passed ?? null;
  const performanceChange = sample.performanceChange ?? sample.metrics?.performanceChange ?? null;
  const stability = sample.stability === undefined ? regressionPassed === null ? null : regressionPassed ? 1 : 0 : number(sample.stability);
  return {
    id: String(sample.id ?? `component:${componentId}:${Date.now()}:${Math.random().toString(36).slice(2)}`),
    kind: "component", componentId: String(componentId), version: sample.version ?? null, stability,
    regressionPassed: regressionPassed === null ? null : Boolean(regressionPassed), performanceChange: clone(performanceChange),
    latencyMs: firstValue(sample, ["latencyMs", "latency"]), failureRate: firstValue(sample, ["failureRate", "failure_rate", "errorRate"]),
    recordedAt: sample.recordedAt ?? timestamp(clock), metadata: clone(sample.metadata ?? {}),
  };
}

function normalize(kind, sample, clock) {
  const normalized = String(kind ?? "task").toLowerCase().replace(/result$/, "");
  if (["goal", "goals"].includes(normalized)) return normalizeGoal(sample, clock);
  if (["agent", "agents"].includes(normalized)) return normalizeAgent(sample, clock);
  if (["session", "sessions"].includes(normalized)) return normalizeSession(sample, clock);
  if (["component", "components"].includes(normalized)) return normalizeComponent(sample, clock);
  return normalizeTask(sample, clock);
}

function average(records, key) {
  const values = records.map((entry) => number(entry[key])).filter((value) => value !== null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function successRate(records) {
  const known = records.filter((entry) => typeof entry.success === "boolean");
  return known.length ? known.filter((entry) => entry.success).length / known.length : null;
}

function summarizeRecords(records, keys = []) {
  const result = { samples: records.length, successRate: successRate(records) };
  for (const key of keys) result[key] = average(records, key);
  return result;
}

function collectionName(kind) {
  const normalized = String(kind ?? "task").toLowerCase().replace(/result$/, "");
  if (["goal", "goals"].includes(normalized)) return "goals";
  if (["agent", "agents"].includes(normalized)) return "agents";
  if (["session", "sessions"].includes(normalized)) return "sessions";
  if (["component", "components"].includes(normalized)) return "components";
  return "tasks";
}

/** Pure canonical projection used by both producers and the evaluator adapter. */
export function projectEvolutionMetric(kind, sample = {}, { clock = () => new Date() } = {}) {
  return clone(normalize(kind, sample, clock));
}

