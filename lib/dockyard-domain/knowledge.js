import { createHash } from "node:crypto";

const MAX_TEXT = 240;
const MAX_RECENT = 8;
const MAX_REFS = 32;
const MAX_METRICS = 32;
const VOLATILE_KEYS = /^(?:id|uuid|eventid|timestamp|recordedat|observedat|startedat|endedat|createdat|updatedat|lastseen|firstseen|generation|generationid|runtimeversion|version|environment|metrics?|beforemetrics|aftermetrics|candidatemetrics|resourceMetrics|score|fitness|confidence|count|occurrencecount|successcount|failurecount|status|state|decision|sequence|duration|latency|cost|tokens?)$/i;
const GENERIC_TYPES = new Set(["event", "record", "unknown", "observation", "diagnosis", "cycle", "runtime"]);
const SUCCESS_STATES = new Set(["success", "succeeded", "stable", "promoted", "validated", "passed", "healthy", "ok", "canary-passed", "promotion-succeeded"]);
const FAILURE_STATES = new Set(["failure", "failed", "error", "rejected", "reverted", "rollback", "rolled-back", "rolled_back", "canary-failed", "promotion-reverted"]);
const ACTIVE_STATES = new Set(["active", "pending", "proposed", "running", "in-progress", "awaiting-confirmation", "awaiting-strategy", "trial", "measuring"]);

function boundedText(value, limit = MAX_TEXT) {
  const text = String(value ?? "").trim();
  return text.length <= limit ? text : text.slice(0, Math.max(0, limit - 1)) + "…";
}

function clone(value) {
  if (value === undefined || value === null) return value;
  try { return structuredClone(value); } catch {
    if (Array.isArray(value)) return value.map(clone);
    if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
    return value;
  }
}

function compactValue(value, depth = 0, seen = new WeakSet()) {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "function" || depth > 4) return undefined;
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => compactValue(item, depth + 1, seen)).filter((item) => item !== undefined);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (VOLATILE_KEYS.test(key)) continue;
    const next = compactValue(value[key], depth + 1, seen);
    if (next !== undefined) output[key] = next;
  }
  return output;
}

function stableStringify(value) { return JSON.stringify(compactValue(value)) ?? "null"; }
function hash(value) { return createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex").slice(0, 32); }

function first(input, keys) {
  for (const key of keys) {
    const value = input?.[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "object" && !(value instanceof Date) && (Array.isArray(value) ? value.length === 0 : Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === 0)) continue;
    return value;
  }
  return null;
}

function nested(input, paths) {
  for (const path of paths) {
    let value = input;
    for (const key of path) value = value && typeof value === "object" ? value[key] : undefined;
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function normalizeText(value, { dynamicNumbers = true } = {}) {
  if (value === undefined || value === null) return "";
  let output = typeof value === "string" ? value : JSON.stringify(compactValue(value));
  output = String(output ?? "").normalize("NFKC").toLowerCase();
  output = output.replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
  output = output.replace(/[\u0000-\u001f]+/g, " ");
  output = output.replace(/\b[0-9a-f]{8,}\b/giu, "<id>");
  output = output.replace(/\b[0-9a-f]{4,}-[0-9a-f-]{4,}\b/giu, "<id>");
  if (dynamicNumbers) output = output.replace(/\d+(?:\.\d+)?/g, "<n>");
  output = output.replace(/[_\/\\|:]+/g, " ").replace(/[^\p{L}\p{N}<>.'-]+/gu, " ");
  output = output.replace(/\b(?:timed? out|time out|timeout)\b/gu, "timeout");
  output = output.replace(/\b(?:out of memory|out-of-memory|oom)\b/gu, "out-of-memory");
  output = output.replace(/\b(?:rate limit|too many requests)\b/gu, "rate-limit");
  output = output.replace(/\b(?:network error|connection error|connection reset)\b/gu, "network-error");
  output = output.replace(/\b(?:not found|missing)\b/gu, "missing");
  output = output.replace(/\b(?:failed|failure|errors?)\b/gu, "failure");
  return boundedText(output.replace(/\s+/g, " ").trim());
}

function identity(value) { return normalizeText(value, { dynamicNumbers: false }).replace(/\s+/g, "-"); }
function dimension(value, { object = false, numbers = true } = {}) { return value === undefined || value === null || value === "" ? "" : object ? boundedText(stableStringify(value), 360) : normalizeText(value, { dynamicNumbers: numbers }); }

function normalizedStatus(input) {
  const raw = first(input, ["outcome", "result", "status", "lifecycleState", "decision", "state"]);
  if (raw && typeof raw === "object") return normalizedStatus(raw);
  return normalizeText(raw, { dynamicNumbers: false }).replace(/\s+/g, "-");
}

function outcomeOf(input, status) {
  if (input?.regression === true || status.includes("regress")) return "regression";
  if (input?.success === true || input?.passed === true || SUCCESS_STATES.has(status)) return "success";
  if (input?.success === false || input?.failed === true || input?.error || input?.severity === "error" || input?.severity === "critical" || FAILURE_STATES.has(status)) return "failure";
  return "neutral";
}

function numeric(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function metricValues(input) {
  const sources = [input?.metrics, input?.effectStats?.metrics, input?.beforeMetrics, input?.afterMetrics, input?.candidateMetrics, input?.resourceMetrics];
  const result = {};
  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const [key, value] of Object.entries(source)) {
      const n = numeric(value);
      if (n === null || /(?:count|timestamp|date|id|version|status|score|confidence)/i.test(key)) continue;
      const normalized = identity(key);
      if (normalized && Object.keys(result).length < MAX_METRICS) result[normalized] = n;
    }
  }
  const fitness = numeric(first(input, ["fitnessScore", "fitness", "qualityScore"]));
  if (fitness !== null) result.fitness = fitness;
  return result;
}

function confidenceOf(input, outcome) {
  const value = numeric(first(input, ["outcomeConfidence", "confidence", "certainty"]));
  if (value !== null) return Math.max(0, Math.min(1, value));
  if (outcome === "success") return 1;
  if (outcome === "failure" || outcome === "regression") return 0;
  return 0.5;
}

function occurredAt(input, now) {
  const value = first(input, ["occurredAt", "observedAt", "recordedAt", "diagnosedAt", "promotedAt", "finalizedAt", "startedAt", "timestamp"]);
  if (value instanceof Date) return value.toISOString();
  if (value !== null && Number.isFinite(Date.parse(String(value)))) return new Date(String(value)).toISOString();
  if (now instanceof Date) return now.toISOString();
  if (Number.isFinite(Date.parse(String(now ?? "")))) return new Date(String(now)).toISOString();
  return new Date(0).toISOString();
}

function recoveryOf(input) {
  const value = first(input, ["recoveryProof", "recovery", "rollback", "rollbackPoint", "restored"]);
  if (value === null || value === undefined || value === false) return null;
  const compact = compactValue(value);
  const digest = hash(compact);
  const pointValue = first(value, ["rollbackPoint", "previousRecordId", "recordId", "id"]);
  const statusValue = first(value, ["status", "state", "outcome"]);
  const reasonValue = first(value, ["reason", "message", "cause"]);
  if (!compact || typeof compact !== "object") return { digest, value: boundedText(compact) };
  return {
    digest,
    status: boundedText(statusValue, 80) || null,
    reason: boundedText(reasonValue, 160) || null,
    point: boundedText(pointValue, 160) || null,
    restored: compact.restored === true || compact.registryRestored === true,
  };
}

function contradictionOf(input) {
  return input?.contradicts === true || input?.contradicted === true || input?.correction === true || input?.substantiveCorrection === true || input?.supersedesKnowledgeKey != null || input?.contradictsKnowledgeKey != null;
}

function eventReference(input) {
  const value = first(input, ["eventId", "executionEventId", "bridgeEventId", "canonicalEventId", "observationId", "diagnosisId", "cycleId", "id"]);
  return value === null ? null : String(value);
}
function sourceReference(collection, input) { const value = eventReference(input); return value === null ? null : String(collection) + ":" + value; }

function relationRefs(input) {
  const refs = [];
  for (const [name, keys] of Object.entries({
    experiment: ["experimentId", "sourceExperimentId"],
    proposal: ["proposalId", "sourceProposalId"],
    promotion: ["promotionId", "sourcePromotionId"],
    dependency: ["dependencyId", "dependsOn", "dependency"],
    predecessor: ["predecessor", "parentId", "parentStrategyId"],
    generation: ["generationId", "sourceGenerationId"],
  })) {
    const value = first(input, keys);
    if (value !== null) refs.push(name + ":" + boundedText(typeof value === "object" ? stableStringify(value) : value, 160));
  }
  return refs.slice(0, MAX_REFS);
}

/** Normalize an Evolution record into stable issue/root/strategy/failure semantics. */
export function normalizeKnowledgeEvent(input = {}, { sourceCollection = "event", now = new Date() } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const explicit = first(input, ["knowledgeKey", "canonicalKnowledgeKey", "semanticKey"]);
  const explicitKey = explicit === null ? "" : normalizeText(explicit, { dynamicNumbers: false });
  const explicitIssue = first(input, ["issueType", "problemType", "failureType"]);
  const pattern = first(input, ["failureMode", "failurePattern", "patternKey", "errorCode", "signature"]);
  const typeValue = explicitIssue ?? first(input, ["type", "eventType", "kind", "domain"]);
  const problem = first(input, ["problem", "problemDescription", "issue", "gap", "capabilityGap", "problemFingerprint"]);
  const cause = first(input, ["rootCause", "rootCauseHypothesis", "suspectedCause", "cause", "diagnosisRootCause"])
    ?? nested(input, [["diagnosis", "rootCause"], ["diagnosis", "rootCauseHypothesis"], ["failure", "rootCause"], ["failure", "cause"]]);
  const strategyKeys = input.strategyKeyGenerated === true
    ? ["strategyName", "candidateStrategy", "solution", "remedy", "resolution", "fix", "change", "mutation", "definition", "manifest"]
    : ["strategyName", "strategy", "strategyKey", "candidateStrategy", "solution", "remedy", "resolution", "fix", "change", "mutation", "definition", "manifest"];
  const strategyValue = first(input, strategyKeys);
  const explicitSemantic = first(input, ["semanticFact", "semantic", "fact"]);
  const semanticValue = explicitSemantic !== null
    ? explicitSemantic
    : (problem ?? first(input, ["message", "errorMessage", "reason"]));
  const scopeValue = first(input, ["componentId", "affectedComponent", "targetComponent", "capabilityId", "moduleId", "candidateGroup", "scope", "stableScope"]);
  const issueType = dimension(typeValue ?? (problem !== null ? "problem" : null));
  const failureMode = dimension(pattern ?? ((!issueType && (input?.error || input?.severity === "error")) ? first(input, ["message", "errorMessage"]) : null));
  const rootCause = dimension(cause);
  const strategy = dimension(strategyValue, { object: typeof strategyValue === "object" });
  const semanticFact = dimension(semanticValue);
  const scope = dimension(scopeValue, { numbers: false });
  const dimensions = { issueType, rootCause, strategy, failureMode, semanticFact, scope };
  const hasUsefulType = issueType && !GENERIC_TYPES.has(issueType);
  const hasSignal = Boolean(explicitKey || rootCause || strategy || failureMode || semanticFact || (hasUsefulType && scope));
  if (!hasSignal) return null;
  const status = normalizedStatus(input);
  const outcome = outcomeOf(input, status);
  const source = String(sourceCollection || "event");
  const eventId = first(input, ["eventId", "executionEventId", "bridgeEventId", "canonicalEventId"]);
  const sourceId = eventReference(input);
  return {
    knowledgeKey: explicitKey.startsWith("knowledge:") ? explicitKey : "knowledge:" + hash(dimensions),
    dimensions,
    issueType: issueType || null,
    problemType: issueType || null,
    rootCause: rootCause || null,
    strategy: strategy || null,
    failureMode: failureMode || null,
    semanticFact: semanticFact || null,
    scope: scope || null,
    sourceCollection: source,
    sourceId: sourceId === null ? null : String(sourceId),
    sourceRef: sourceReference(source, input),
    eventId: eventId === null ? null : String(eventId),
    occurredAt: occurredAt(input, now),
    status: status || null,
    outcome,
    confidence: confidenceOf(input, outcome),
    metrics: metricValues(input),
    fitness: numeric(first(input, ["fitnessScore", "fitness", "qualityScore"])),
    recovery: recoveryOf(input),
    regression: input.regression === true || outcome === "regression",
    contradiction: contradictionOf(input),
    forceRecord: input.forceRecord === true,
    irreplaceableEvidence: input.irreplaceableEvidence === true || input.criticalEvidence === true,
    lineageId: first(input, ["lineageId", "generationId", "sourceGenerationId", "rootLineageId"]),
    relations: relationRefs(input),
    generation: numeric(input.generation),
    delta: Math.max(1, Math.floor(numeric(input.knowledgeCount ?? input.occurrenceDelta ?? 1) ?? 1)),
  };
}

export function canonicalKnowledgeKey(input = {}, options = {}) {
  if (typeof input === "string" && input.startsWith("knowledge:")) return input;
  const event = input?.knowledgeKey && input?.dimensions ? input : normalizeKnowledgeEvent(input, options);
  return event?.knowledgeKey ?? null;
}

function emptyEffectStats() { return { successCount: 0, failureCount: 0, neutralCount: 0, regressionCount: 0, fitnessCount: 0, fitnessSum: 0, fitnessMean: null, bestFitness: null, worstFitness: null, successRate: null, metrics: {} }; }

function mergeMetricStats(current, values, delta) {
  const output = { ...(current && typeof current === "object" ? current : {}) };
  for (const [key, value] of Object.entries(values ?? {})) {
    const n = numeric(value);
    if (n === null) continue;
    const previous = output[key] && typeof output[key] === "object" ? output[key] : { count: 0, sum: 0, min: n, max: n, last: n, mean: n };
    const count = Number(previous.count) || 0;
    const sum = Number(previous.sum) || 0;
    const nextCount = count + delta;
    output[key] = { count: nextCount, sum: sum + n * delta, min: Math.min(Number(previous.min ?? n), n), max: Math.max(Number(previous.max ?? n), n), last: n, mean: (sum + n * delta) / nextCount };
  }
  return Object.fromEntries(Object.keys(output).slice(0, MAX_METRICS).map((key) => [key, output[key]]));
}

function mergeEffects(previous, event, delta) {
  const old = { ...emptyEffectStats(), ...(previous && typeof previous === "object" ? previous : {}) };
  if (event.outcome === "success") old.successCount = (Number(old.successCount) || 0) + delta;
  else if (event.outcome === "failure") old.failureCount = (Number(old.failureCount) || 0) + delta;
  else old.neutralCount = (Number(old.neutralCount) || 0) + delta;
  if (event.regression) old.regressionCount = (Number(old.regressionCount) || 0) + delta;
  if (event.fitness !== null) {
    old.fitnessCount = (Number(old.fitnessCount) || 0) + delta;
    old.fitnessSum = (Number(old.fitnessSum) || 0) + event.fitness * delta;
    old.fitnessMean = old.fitnessSum / old.fitnessCount;
    old.bestFitness = old.bestFitness === null || old.bestFitness === undefined ? event.fitness : Math.max(Number(old.bestFitness), event.fitness);
    old.worstFitness = old.worstFitness === null || old.worstFitness === undefined ? event.fitness : Math.min(Number(old.worstFitness), event.fitness);
  }
  const total = old.successCount + old.failureCount;
  old.successRate = total > 0 ? old.successCount / total : null;
  old.metrics = mergeMetricStats(old.metrics, event.metrics, delta);
  return old;
}

function appendBounded(values, value, limit) {
  const list = Array.isArray(values) ? values.filter((item) => item !== undefined && item !== null).map(clone) : [];
  if (value !== undefined && value !== null && !list.some((item) => stableStringify(item) === stableStringify(value))) list.push(clone(value));
  return list.slice(-limit);
}
function timeValue(value) { const parsed = Date.parse(String(value ?? "")); return Number.isFinite(parsed) ? parsed : 0; }
function compactEvidence(event) {
  if (!event?.sourceId && !event?.eventId && !event?.sourceRef) return null;
  return { source: event.sourceCollection, id: event.sourceId ?? event.eventId ?? null, at: event.occurredAt, outcome: event.outcome, status: event.status, digest: hash({ dimensions: event.dimensions, outcome: event.outcome, metrics: event.metrics, recovery: event.recovery }) };
}
function trendFor(previous, event, effects) {
  const recent = appendBounded(previous?.recent, { at: event.occurredAt, outcome: event.outcome, confidence: event.confidence, regression: event.regression }, MAX_RECENT);
  const last = recent.at(-1);
  const total = effects.failureCount + effects.successCount;
  return { window: MAX_RECENT, recent, lastOutcome: last?.outcome ?? null, direction: event.regression ? "worsening" : total === 0 || effects.failureCount === 0 ? "stable" : "mixed", failureRate: total > 0 ? effects.failureCount / total : 0, successRate: effects.successRate, regressionCount: effects.regressionCount };
}

/** Merge one event into a bounded canonical accumulator. */
export function mergeKnowledgeEntry(previous, event, { now = new Date() } = {}) {
  if (!event?.knowledgeKey) return previous ? clone(previous) : null;
  const at = event.occurredAt || occurredAt({}, now);
  const delta = Math.max(1, Number(event.delta) || 1);
  const old = previous && typeof previous === "object" ? previous : null;
  const oldCount = Number(old?.count ?? old?.occurrenceCount ?? 0) || 0;
  const effects = mergeEffects(old?.effectStats, event, delta);
  const firstSeen = old?.firstSeen && timeValue(old.firstSeen) <= timeValue(at) ? old.firstSeen : at;
  const lastSeen = old?.lastSeen && timeValue(old.lastSeen) >= timeValue(at) ? old.lastSeen : at;
  const sourceCollection = event.sourceCollection || old?.lastSourceCollection || "event";
  const sourceCounts = { ...(old?.sourceCounts && typeof old.sourceCounts === "object" ? old.sourceCounts : {}) };
  sourceCounts[sourceCollection] = (Number(sourceCounts[sourceCollection]) || 0) + delta;
  const lineageRef = event.lineageId === null || event.lineageId === undefined ? null : String(event.lineageId);
  const evidence = compactEvidence(event);
  const previousSuccess = old?.lastOutcome === "success" || Number(old?.effectStats?.successCount) > 0;
  const regression = Boolean(event.regression || (previousSuccess && event.outcome === "failure"));
  if (regression && !event.regression) effects.regressionCount = (Number(effects.regressionCount) || 0) + delta;
  const mergedRelations = (event.relations ?? []).reduce((list, value) => appendBounded(list, value, MAX_REFS), old?.relationRefs);
  const next = {
    id: old?.id ?? event.knowledgeKey,
    knowledgeKey: event.knowledgeKey,
    schema: 1,
    canonical: true,
    retention: "CANONICAL_KNOWLEDGE",
    state: (regression || event.contradiction) ? "REGRESSED" : (event.outcome === "success" || old?.state === "KNOWN" ? "KNOWN" : (old?.state ?? "LEARNING")),
    issueType: old?.issueType || event.issueType || null,
    problemType: old?.problemType || event.problemType || null,
    rootCause: old?.rootCause || event.rootCause || null,
    strategy: old?.strategy || event.strategy || null,
    failureMode: old?.failureMode || event.failureMode || null,
    semanticFact: old?.semanticFact || event.semanticFact || null,
    scope: old?.scope || event.scope || null,
    count: oldCount + delta,
    occurrenceCount: oldCount + delta,
    firstSeen,
    lastSeen,
    lastSourceCollection: sourceCollection,
    lastStatus: event.status ?? old?.lastStatus ?? null,
    lastOutcome: event.outcome,
    sourceCounts,
    sourceRefs: appendBounded(old?.sourceRefs, event.sourceRef, MAX_REFS),
    lineageRefs: appendBounded(old?.lineageRefs, lineageRef, MAX_REFS),
    relationRefs: mergedRelations,
    eventIds: appendBounded(old?.eventIds, event.eventId, 64),
    evidenceCount: (Number(old?.evidenceCount) || 0) + delta,
    recentEvidence: appendBounded(old?.recentEvidence, evidence, MAX_RECENT),
    confidence: oldCount > 0 ? ((Number(old?.confidence) || 0.5) * oldCount + event.confidence * delta) / (oldCount + delta) : event.confidence,
    effectStats: effects,
    effects: clone(effects),
    successCount: effects.successCount,
    failureCount: effects.failureCount,
    successRate: effects.successRate,
    fitnessMean: effects.fitnessMean,
    regressionCount: effects.regressionCount,
    trend: trendFor(old?.trend, event, effects),
    recovery: event.recovery ?? old?.recovery ?? null,
    recoveryRefs: appendBounded(old?.recoveryRefs, event.recovery ? (event.sourceRef ?? event.sourceId ?? event.eventId) : null, MAX_REFS),
    contradicted: Boolean(old?.contradicted || event.contradiction),
    contradictionCount: (Number(old?.contradictionCount) || 0) + (event.contradiction ? delta : 0),
    revision: (Number(old?.revision) || 0) + (event.contradiction ? 1 : 0),
    learned: Boolean(old?.learned || event.outcome === "success" || event.sourceCollection === "learnings" || event.sourceCollection === "strategies" || event.sourceCollection === "promotions"),
    updatedAt: lastSeen,
  };
  if (event.contradiction) next.lastCorrectionAt = at;
  return next;
}

export function isDuplicateKnowledgeEvent(previous, event) {
  return Boolean(previous && event?.eventId && Array.isArray(previous.eventIds) && previous.eventIds.includes(String(event.eventId)));
}
export function isKnowledgeCritical(event = {}, { collection = event.sourceCollection } = {}) {
  return Boolean(event.forceRecord || event.irreplaceableEvidence || event.regression || event.contradiction || event.recovery || ACTIVE_STATES.has(event.status) || collection === "lineage" || collection === "tombstones");
}
export function sourceRetentionLimit(event = {}, { collection = event.sourceCollection } = {}) {
  if (collection === "lineage") return Number.POSITIVE_INFINITY;
  // Keep a small variant set so canonical winner selection can compare
  // measured strategies; identical replays are folded by the writer.
  if (collection === "strategies" || collection === "promotions") return 2;
  if (collection === "experiments" && event.outcome === "failure") return 3;
  if (collection === "observations" && event.outcome === "failure") return 3;
  if (collection === "observations" && event.recovery) return 1;
  return 1;
}
export function sourceEventReference(collection, input) { return sourceReference(collection, input); }
export function knowledgeDigest(input, options = {}) { const event = input?.knowledgeKey && input?.dimensions ? input : normalizeKnowledgeEvent(input, options); return event ? hash({ key: event.knowledgeKey, outcome: event.outcome, metrics: event.metrics }) : null; }
