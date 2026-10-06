import { randomUUID } from "node:crypto";
function clone(value) {
  if (value === undefined || value === null) return value;
  try {
    return structuredClone(value);
  } catch {
    if (Array.isArray(value)) return value.map(clone);
    if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
    return typeof value === "function" ? undefined : value;
  }
}

function timestamp(clock) {
  const value = typeof clock === "function" ? clock() : new Date();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function id(prefix) {
  return `${prefix}:${Date.now().toString(36)}:${randomUUID()}`;
}

const SENSITIVE_KEY_PARTS = Object.freeze([
  "accesstoken", "refreshtoken", "token", "secret", "credential", "credentialref", "apikey", "password",
]);

function isSensitiveKey(key) {
  const normalized = String(key).toLowerCase();
  return SENSITIVE_KEY_PARTS.some((needle) => normalized.includes(needle));
}

function redact(value, key = "", seen = new WeakSet()) {
  if (isSensitiveKey(key)) return undefined;
  if (value === undefined || value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "function") return undefined;
  if (typeof value !== "object") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message, code: value.code };
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redact(entry, "", seen)).filter((entry) => entry !== undefined);
  const output = {};
  for (const [entryKey, entry] of Object.entries(value)) {
    const normalized = redact(entry, entryKey, seen);
    if (normalized !== undefined) output[entryKey] = normalized;
  }
  return output;
}

function safeRecord(value = {}) {
  const normalized = redact(value);
  if (normalized === undefined) return {};
  if (normalized && typeof normalized === "object" && !Array.isArray(normalized)) return normalized;
  return { value: normalized };
}

function normalizePatternText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<id>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<id>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

function eventDomain(source, type) {
  const value = `${source ?? ""}/${type ?? ""}`.toLowerCase();
  if (value.includes("agent") || value.includes("goal") || value.includes("ptc")) return "agent";
  if (value.includes("tool")) return "tool";
  if (value.includes("provider")) return "provider";
  if (value.includes("session")) return "session";
  if (value.includes("performance") || value.includes("latency") || value.includes("resource")) return "performance";
  if (value.includes("effect") || value.includes("component") || value.includes("module")) return "runtime";
  return "runtime";
}

function severityImpact(severity, type, input = {}) {
  const explicit = Number(input.impact ?? input.impactScore ?? input.weight);
  if (Number.isFinite(explicit)) return explicit;
  const normalized = String(severity ?? "").toLowerCase();
  if (normalized === "critical" || normalized === "fatal") return 2;
  if (normalized === "error" || normalized === "failed" || normalized === "failure") return 1;
  if (normalized === "warning" || normalized === "warn") return 0.5;
  if (String(type ?? "").includes("rollback_failed") || String(type ?? "").includes("orphan")) return 1.5;
  return 0.25;
}

function safeList(value) {
  if (Array.isArray(value)) return value.map((entry) => redact(entry)).filter((entry) => entry !== undefined);
  if (value && typeof value === "object") return safeRecord(value);
  return value === undefined ? [] : [redact(value)];
}

function redactText(value) {
  return String(value ?? "")
    .replace(/(bearer\s+|token\s*[=:]\s*|secret\s*[=:]\s*|password\s*[=:]\s*|api[-_]?key\s*[=:]\s*)[^\s,;]+/gi, "$1<redacted>")
    .slice(0, 1000);
}

function observationInput(input = {}, clock = () => new Date()) {
  const error = input.error instanceof Error ? input.error : input.error;
  const type = String(input.type ?? input.eventType ?? input.kind ?? input.source ?? "runtime");
  const source = String(input.source ?? type.split("/")[0] ?? "runtime");
  const message = input.message
    ?? input.problem
    ?? error?.message
    ?? input.errorMessage
    ?? input.diagnostic
    ?? null;
  const errorCode = input.errorCode ?? input.code ?? error?.code ?? null;
  const domain = input.domain ?? eventDomain(source, type);
  const patternSeed = input.patternKey
    ?? `${domain}:${type}:${errorCode ?? (normalizePatternText(message) || "event")}`;
  const inferredMetric = input.metric ?? input.metricName
    ?? (domain === "performance" ? String(type).split("/").at(-1) : null);
  const metrics = input.metrics && typeof input.metrics === "object" ? safeRecord(input.metrics) : {};
  if (inferredMetric && Number.isFinite(Number(input.value)) && !Object.hasOwn(metrics, inferredMetric)) {
    metrics[inferredMetric] = Number(input.value);
  }
  const observedAt = input.observedAt ?? input.timestamp ?? timestamp(clock);
  const confidenceValue = Number(input.confidence ?? input.evidenceConfidence ?? (message || errorCode ? 0.7 : 0.5));
  const confidence = Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue)) : 0.5;
  const affectedComponent = input.affectedComponent
    ?? input.affected_component
    ?? input.componentId
    ?? input.component?.id
    ?? input.ownerId
    ?? null;
  return safeRecord({
    id: input.id ?? id("observation"),
    source,
    domain,
    type,
    patternKey: normalizePatternText(patternSeed),
    issueType: input.issueType ?? input.problemType ?? null,
    rootCause: input.rootCause ?? input.rootCauseHypothesis ?? null,
    failureMode: input.failureMode ?? input.failurePattern ?? null,
    strategy: input.strategy ?? input.strategyKey ?? input.solution ?? input.change ?? null,
    semanticFact: input.semanticFact ?? input.semantic ?? input.fact ?? null,
    componentId: affectedComponent,
    affectedComponent,
    operation: input.operation ?? input.action ?? null,
    errorCode,
    message: message ? redactText(message) : null,
    severity: input.severity ?? (message || errorCode ? "error" : "info"),
    status: input.status ?? input.state ?? input.result ?? null,
    outcome: input.outcome ?? null,
    impact: severityImpact(input.severity ?? (message || errorCode ? "error" : "info"), type, input),
    value: Number.isFinite(Number(input.value)) ? Number(input.value) : undefined,
    baseline: Number.isFinite(Number(input.baseline)) ? Number(input.baseline) : undefined,
    unit: input.unit ?? null,
    metric: inferredMetric,
    metrics,
    evidence: safeRecord(input.evidence ?? input.details ?? {}),
    confidence,
    regression: input.regression === true,
    forceRecord: input.forceRecord === true,
    irreplaceableEvidence: input.irreplaceableEvidence === true || input.criticalEvidence === true,
    eventId: input.eventId ?? input.bridgeEventId ?? null,
    correction: input.correction === true || input.substantiveCorrection === true,
    contradicts: input.contradicts === true || input.contradicted === true,
    observedAt: new Date(observedAt).toString() === "Invalid Date" ? timestamp(clock) : new Date(observedAt).toISOString(),
    // Keep a stable alias for external audit/reporting contracts.  Existing
    // consumers continue to use observedAt; new records expose both without
    // retaining a second payload.
    timestamp: new Date(observedAt).toString() === "Invalid Date" ? timestamp(clock) : new Date(observedAt).toISOString(),
    tier: input.tier ?? "hot",
  });
}

function observationTime(value, fallback = Date.now()) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function latestByKey(entries, key) {
  const result = new Map();
  for (const entry of entries ?? []) {
    const current = result.get(entry?.[key]);
    if (!current || observationTime(entry.observedAt ?? entry.recordedAt) >= observationTime(current.observedAt ?? current.recordedAt)) {
      result.set(entry?.[key], entry);
    }
  }
  return result;
}

/** Durable observation facade over the existing EvolutionMemory. */
export class EvolutionObservationStore {
  constructor({ engine = null, memory = engine?.memory ?? null, stateStore = null, key = "evolution", clock = () => new Date(), maxEntries = 1000, hotEntries = 100, warmEntries = 500 } = {}) {
    if (!memory?.recordObservation || !memory?.recordKnowledgeEvent) throw new TypeError("EvolutionObservationStore requires an explicit EvolutionMemory port");
    this.engine = null;
    this.memory = memory;
    this.stateStore = stateStore ?? memory?.stateStore ?? null;
    this.key = key;
    this.clock = clock;
    this.maxEntries = Math.max(1, Number(maxEntries) || 1000);
    this.hotEntries = Math.max(1, Math.min(this.maxEntries, Number(hotEntries) || 100));
    this.warmEntries = Math.max(this.hotEntries, Math.min(this.maxEntries, Number(warmEntries) || 500));
    this.entries = [];
    this.loaded = false;
    this.loading = null;
  }

  async load() {
    if (this.loaded) return this.snapshot();
    if (this.loading) return this.loading;
    this.loading = (async () => {
      if (this.memory?.load) {
        const state = await this.memory.load();
        this.entries = (state.observations ?? []).slice(-this.maxEntries).map(clone);
      } else if (this.stateStore?.load) {
        const state = await this.stateStore.load({ resolveSnapshot: false });
        this.entries = (state[this.key]?.observations ?? []).slice(-this.maxEntries).map(clone);
      }
      this.loaded = true;
      return this.snapshot();
    })();
    try { return await this.loading; } finally { this.loading = null; }
  }

  snapshot() {
    const hot = this.entries.slice(-this.hotEntries).map(clone);
    const warm = this.entries.slice(-this.warmEntries).map(clone);
    return {
      schema: 2,
      observations: clone(this.entries),
      tiers: {
        hot: { count: hot.length, limit: this.hotEntries, entries: hot },
        warm: { count: warm.length, limit: this.warmEntries, entries: warm },
        cold: { count: Math.max(0, this.entries.length - warm.length), archived: Boolean(this.memory?.hasColdHistory) },
      },
    };
  }

  async record(input = {}, { deferStablePersistence = false } = {}) {
    await this.load();
    const normalized = observationInput(input, this.clock);
    // P1 perf: semantic dedup — a repeat of the same component signal within
    // the hot window carries no new evidence (component/observation rows are
    // generated every cycle for every healthy component). Persisting a fresh
    // observation (and a full state #save) per identical signal is pure
    // idle-write overhead. A repeat therefore refreshes the existing entry's
    // observedAt instead of appending a duplicate; first-seen evidence is
    // retained, and the cycle report still counts the observation.
    // Only healthy info-level component observations are dedupable: they are
    // generated every cycle for every healthy component and never feed the
    // failure analyzer (its `recent` filter keeps only warning/error/
    // performance signals). Error/warning signals MUST NOT be deduped — the
    // analyzer's minOccurrences counting depends on repeated observations of
    // the same pattern within the window.
    const dedupable = normalized.severity === "info"
      && (normalized.type === "component/observation" || normalized.type?.startsWith("component/"));
    const existing = dedupable
      ? this.entries.find((candidate) => candidate.id === normalized.id
        || (candidate.type === normalized.type && candidate.componentId === normalized.componentId
          && candidate.severity === normalized.severity && candidate.patternKey === normalized.patternKey))
      : undefined;
    if (existing && !input.forceRecord) {
      // P5: if the incoming observation carries materially different process
      // metrics (RSS/CPU/latency moved by >5%), treat it as new evidence —
      // otherwise the perf channel would freeze at its first sample. This
      // stays bounded: at most one write per signal per material change.
      const normPerf = normalized.metrics && (normalized.metrics.memoryUsage ?? normalized.metrics.cpuUsage ?? normalized.metrics.avgLatencyMs);
      const existPerf = existing.metrics && (existing.metrics.memoryUsage ?? existing.metrics.cpuUsage ?? existing.metrics.avgLatencyMs);
      const metricsChanged = normPerf != null && (existPerf == null
        || Math.abs(Number(normalized.metrics.memoryUsage ?? 0) - Number(existing.metrics.memoryUsage ?? 0)) / Math.max(1, Number(existing.metrics.memoryUsage ?? 1)) > 0.05
        || Math.abs(Number(normalized.metrics.cpuUsage ?? 0) - Number(existing.metrics.cpuUsage ?? 0)) / Math.max(1, Number(existing.metrics.cpuUsage ?? 1)) > 0.05
        || Math.abs(Number(normalized.metrics.avgLatencyMs ?? 0) - Number(existing.metrics.avgLatencyMs ?? 0)) / Math.max(1, Number(existing.metrics.avgLatencyMs ?? 1)) > 0.05);
      if (!metricsChanged) {
        // The source observation stays one bounded representative, while the
        // canonical row still receives this occurrence's counters and metrics.
        // A complete ComponentEvolutionCycle commits the same memory partition
        // through recordCycle(). It may defer this stable duplicate's canonical
        // counter update to that commit instead of rewriting the whole state
        // once per healthy component. Standalone store callers still persist.
        await this.memory?.recordKnowledgeEvent?.(normalized, {
          sourceCollection: "observations",
          persist: !deferStablePersistence,
        });
        // Same signal: refresh timestamp in place (no durable append).
        const refreshed = { ...existing, observedAt: normalized.observedAt ?? timestamp(this.clock) };
        const idx = this.entries.findIndex((candidate) => candidate.id === existing.id);
        if (idx >= 0) this.entries[idx] = refreshed;
        return clone(refreshed);
      }
    }
    let saved = normalized;
    if (this.engine?.observe) {
      saved = await this.engine.observe(normalized);
    } else if (this.memory?.recordObservation) {
      saved = await this.memory.recordObservation(normalized);
    }
    const entry = observationInput(saved ?? normalized, this.clock);
    const existingIndex = this.entries.findIndex((candidate) => candidate.id === entry.id);
    if (existingIndex >= 0) this.entries[existingIndex] = clone(entry);
    else this.entries.push(clone(entry));
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
    return clone(entry);
  }

  list({ since = null, patternKey = null, limit = null } = {}) {
    const cutoff = since === null || since === undefined ? null : observationTime(since, Number(since));
    let entries = this.entries.filter((entry) => !patternKey || entry.patternKey === normalizePatternText(patternKey));
    if (cutoff !== null && Number.isFinite(cutoff)) entries = entries.filter((entry) => observationTime(entry.observedAt) >= cutoff);
    if (limit !== null && Number(limit) > 0) entries = entries.slice(-Number(limit));
    return clone(entries);
  }

  latest() { return clone(this.entries.at(-1) ?? null); }

  stats() {
    const byPattern = new Map();
    for (const entry of this.entries) byPattern.set(entry.patternKey, (byPattern.get(entry.patternKey) ?? 0) + 1);
    return {
      total: this.entries.length,
      hot: Math.min(this.entries.length, this.hotEntries),
      warm: Math.min(this.entries.length, this.warmEntries),
      cold: Math.max(0, this.entries.length - this.warmEntries),
      tierLimits: { hot: this.hotEntries, warm: this.warmEntries, max: this.maxEntries },
      patterns: byPattern.size,
      latest: this.latest(),
      repeatedPatterns: [...byPattern.entries()].filter(([, count]) => count > 1).map(([patternKey, count]) => ({ patternKey, count })),
    };
  }
}
