// `hash()` is the only user of `createHash` here, and the one-shot form is the
// documented equivalent of `createHash(algorithm).update(data).digest(encoding)`
// without the intermediate Hash object. `engines` is `^22.19.0 || >=24.0.0`,
// which is well after `crypto.hash` was added (Node 20.12 / 21.7).
import { hash as oneShotDigest } from "node:crypto";

const MAX_TEXT = 240;
// The digest a truncated identity dimension carries, in hex characters.
const IDENTITY_DIGEST_CHARS = 16;
// The recent event ids one knowledge record keeps; see `appendEventIds()`.
const MAX_EVENT_IDS = 256;
// The largest value an accumulator may reach; see `accumulatorSum()`.
const MAX_ACCUMULATOR = Number.MAX_SAFE_INTEGER;
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
  return text.length <= limit ? text : codePointPrefix(text, Math.max(0, limit - 1)) + "…";
}

/** The code points in `text`, which is fewer than `text.length` for astral text. */
function codePointLength(text) {
  let length = 0;
  for (const _ of text) length += 1;
  return length;
}

/**
 * The first `count` code points of `text`. A high surrogate is taken together
 * with the unit after it, so a cut can never leave an unpaired high surrogate
 * behind: `boundedText()` slices by UTF-16 unit and can.
 */
function codePointPrefix(text, count) {
  let index = 0;
  let taken = 0;
  while (index < text.length && taken < count) {
    const unit = text.charCodeAt(index);
    index += unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length ? 2 : 1;
    taken += 1;
  }
  return text.slice(0, index);
}

/**
 * The bounded form of one identity dimension.
 *
 * `boundedText()` bounds by UTF-16 code unit: it keeps only the prefix, so two
 * facts that agree up to the bound are one identity, and a cut inside a surrogate
 * pair can leave an unpaired high surrogate behind. This keeps the same prefix -
 * cut on a code point boundary - and appends a digest of the complete text, so
 * the value that is stored and hashed still tells the two apart.
 *
 * A text whose UTF-16 length is at most `limit` is returned unchanged - the same
 * test `boundedText()` uses to skip its cut - so every dimension the old bound
 * never applied to keeps the identity it already had. Every longer text changes
 * identity: one whose code point count is still at most `limit` is kept whole
 * (the old cut is undone), and a longer one is cut to `limit` code points and
 * digested.
 */
function boundedIdentityText(value, limit = MAX_TEXT) {
  // `boundedText()` trims before it bounds, and identity has never been able to
  // distinguish a fact from the same fact with surrounding whitespace. Trimming
  // first keeps that true; without it a short fact with a leading or trailing
  // space would hash differently from the value normalized before this change.
  const text = String(value ?? "").trim();
  if (text.length <= limit) return text;
  if (codePointLength(text) <= limit) return text;
  const keep = Math.max(0, limit - 2 - IDENTITY_DIGEST_CHARS);
  return codePointPrefix(text, keep) + "…#" + hash(text).slice(0, IDENTITY_DIGEST_CHARS);
}

function clone(value) {
  if (value === undefined || value === null) return value;
  try { return structuredClone(value); } catch {
    if (Array.isArray(value)) return value.map(clone);
    if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
    return value;
  }
}

/** One accumulator operand: `±Infinity` saturates, `NaN` reads as 0, everything else is clamped. */
function clampAccumulator(value) {
  if (value === Infinity) return MAX_ACCUMULATOR;
  if (value === -Infinity) return -MAX_ACCUMULATOR;
  if (!Number.isFinite(value)) return 0;
  return Math.max(-MAX_ACCUMULATOR, Math.min(MAX_ACCUMULATOR, value));
}

/**
 * A signed accumulator sum. JSON stores a non-finite number as `null`, so a
 * count that reached `Infinity` came back as no count at all; an overflow
 * saturates at the largest safe integer instead, and every value that stays
 * inside that range is summed exactly as before.
 */
function accumulatorSum(base, delta) { return clampAccumulator(clampAccumulator(base) + clampAccumulator(delta)); }

/** A monotone counter: `accumulatorSum()` that never goes below zero. */
function accumulateCount(base, delta) { return Math.max(0, accumulatorSum(base, delta)); }

/** A positive whole number of events, saturated; `fallback` when the value is not one. */
function eventDelta(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), MAX_ACCUMULATOR);
}

function compactValue(value, depth = 0, seen = new WeakSet()) {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "function" || depth > 4) return undefined;
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => compactValue(item, depth + 1, seen)).filter((item) => item !== undefined);
  // The pairs are collected and defined by `Object.fromEntries()` instead of
  // assigned onto `{}` one at a time. An own key named `__proto__` - which
  // `JSON.parse()` really creates, so a caller's or a reloaded record's payload
  // can carry one - reaches `Object.prototype`'s `__proto__` setter on
  // assignment instead of defining a property, so the key would silently vanish:
  // two facts that differ only in that payload would serialize alike, share one
  // `knowledgeKey` below, and merge as one record. `Object.fromEntries()` defines
  // every key as an own enumerable data property, so the sorted order and the
  // volatile filter stay the only things that decide the output.
  const entries = [];
  for (const key of Object.keys(value).sort()) {
    if (VOLATILE_KEYS.test(key)) continue;
    const next = compactValue(value[key], depth + 1, seen);
    if (next !== undefined) entries.push([key, next]);
  }
  return Object.fromEntries(entries);
}

function stableStringify(value) { return JSON.stringify(compactValue(value)) ?? "null"; }
function hash(value) { return oneShotDigest("sha256", typeof value === "string" ? value : stableStringify(value), "hex").slice(0, 32); }

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

function normalizeText(value, { dynamicNumbers = true, digestOverflow = false } = {}) {
  if (value === undefined || value === null) return "";
  let output = typeof value === "string" ? value : JSON.stringify(compactValue(value));
  output = String(output ?? "").normalize("NFKC").toLowerCase();
  output = output.replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
  // The control-character collapse this line used to carry is a subset of the
  // class collapse below too: every code point in `\u0000-\u001f` is outside
  // `\p{L}`, `\p{N}` and the five kept characters. The three passes between them
  // cannot tell a control character from the space it would have become - the two
  // identifier collapses and the digit run match neither in their character
  // classes and treat both as a `\b` boundary - and a space inside a run of
  // disallowed characters does not split that run, so the class collapse sees the
  // same maximal run either way. The phrase replacements run after that collapse,
  // which is what still supplies the space `time\u0000out` needs to become
  // `timeout`.
  // The two identifier collapses spell their upper-case range out instead of
  // relying on the `i` flag: the class accepts exactly the same code points
  // (checked for every Unicode code point) and the flag pair costs ~2.9x more
  // per line here. `\b` is not identical under both spellings in general - `i`
  // with `u` also counts the two code points that case-fold to an ASCII word
  // character (U+017F, U+212A) as word characters - but the NFKC pass above
  // maps both of them to ASCII, so they can never reach this line; the whole
  // argument is verified in scripts/benchmarks/knowledge-identity-cost.mjs.
  output = output.replace(/\b[0-9a-fA-F]{8,}\b/gu, "<id>");
  output = output.replace(/\b[0-9a-fA-F]{4,}-[0-9a-fA-F-]{4,}\b/gu, "<id>");
  if (dynamicNumbers) output = output.replace(/\d+(?:\.\d+)?/g, "<n>");
  // The separator collapse this line used to carry in front of the class
  // collapse is a subset of it: `_`, `/`, `\`, `|` and `:` are not `\p{L}` or
  // `\p{N}` and are outside the five kept characters, and both passes replace a
  // maximal run with one space, so the class collapse produces the same string
  // whether or not the separator pass ran first. Nothing between them can
  // observe the difference, and the phrase replacements below run after both.
  output = output.replace(/[^\p{L}\p{N}<>.'-]+/gu, " ");
  output = output.replace(/\b(?:timed? out|time out|timeout)\b/gu, "timeout");
  output = output.replace(/\b(?:out of memory|out-of-memory|oom)\b/gu, "out-of-memory");
  output = output.replace(/\b(?:rate limit|too many requests)\b/gu, "rate-limit");
  output = output.replace(/\b(?:network error|connection error|connection reset)\b/gu, "network-error");
  output = output.replace(/\b(?:not found|missing)\b/gu, "missing");
  output = output.replace(/\b(?:failed|failure|errors?)\b/gu, "failure");
  // The class collapse above already replaced every maximal run of non-word
  // characters - whitespace included, since `\s` is neither `\p{L}` nor `\p{N}`
  // and is not one of the five kept characters - with a single space, so after
  // it no two whitespace characters are adjacent. The phrase replacements below
  // only remove spaces inside a match (none of their replacements contains
  // one), so they cannot place two side by side either, and both `boundedText()`
  // and `boundedIdentityText()` trim before they bound. Both the collapse and the
  // inner trim are therefore dead.
  //
  // `digestOverflow` is only set by `dimension()`, which hashes the result into
  // a record's identity; every other caller keeps the plain bound, so a metric
  // name or a status is truncated exactly as it was before.
  return digestOverflow ? boundedIdentityText(output) : boundedText(output);
}

function identity(value) { return normalizeText(value, { dynamicNumbers: false }).replace(/\s+/g, "-"); }
function dimension(value, { object = false, numbers = true } = {}) { return value === undefined || value === null || value === "" ? "" : object ? boundedIdentityText(stableStringify(value), 360) : normalizeText(value, { dynamicNumbers: numbers, digestOverflow: true }); }

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

/**
 * The exact string `stableStringify()` produces for the six-dimension
 * projection. `compactValue()` sorts the keys and drops the names its volatile
 * filter matches; none of `failureMode`, `issueType`, `rootCause`, `scope`,
 * `semanticFact` and `strategy` is one of them, and every value is a string
 * `dimension()` has already bounded, so walking the projection again only
 * rebuilds the shape it was just built from. The literal is written in the
 * sorted order `JSON.stringify` needs, so it escapes the same pairs in the same
 * order.
 *
 * Two checks keep that true, and each catches a different failure.
 * `test/dockyard-domain/knowledge-identity-equivalence.test.js` requires the
 * key to be the sorted projection of **this tree's own** `dimensions`, that
 * projection to expose exactly the six names, and this tree's compaction to keep
 * each of them - so a seventh dimension, a rename or a dropped name in this
 * literal, or a dimension name added to the volatile filter fails there. The
 * same file's pinned differentials (`normalizeKnowledgeEvent()` field for field,
 * `knowledgeKeyOf()` / `canonicalKnowledgeKey()` against the frozen release) pin
 * the values, so a change that alters the identity of an existing record fails
 * there.
 */
function identitySerialization(dimensions) {
  return JSON.stringify({
    failureMode: dimensions.failureMode,
    issueType: dimensions.issueType,
    rootCause: dimensions.rootCause,
    scope: dimensions.scope,
    semanticFact: dimensions.semanticFact,
    strategy: dimensions.strategy,
  });
}

/**
 * The identity a record is recorded under. The canonical key is a hash of the
 * six semantic dimensions alone, so a caller that only compares identities
 * (does this row describe the same subject?) does not need the outcome, the
 * metrics, the recovery proof or the reference projection below.
 */
function knowledgeIdentity(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const explicit = first(input, ["knowledgeKey", "canonicalKnowledgeKey", "semanticKey"]);
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
  // The record is knowledge-bearing when one of the five specific dimensions
  // carries signal, or when the issue type is specific enough to pair with a
  // scope; the canonical key is the hash of those dimensions. Only a record
  // whose dimensions carry no signal at all is decided by the explicit key —
  // which needs its own full text normalization — so that normalization is
  // skipped whenever the condition below already answers the question. Every
  // caller that only compares identities (`knowledgeKeyOf`) therefore reads one
  // less normalized text per scanned row, and the returned key is unchanged: a
  // normalized text can never keep the ":" that the canonical-prefix test
  // below looks for.
  if (rootCause || strategy || failureMode || semanticFact || (hasUsefulType && scope)) {
    return { knowledgeKey: "knowledge:" + hash(identitySerialization(dimensions)), dimensions };
  }
  const explicitKey = explicit === null ? "" : normalizeText(explicit, { dynamicNumbers: false });
  if (!explicitKey) return null;
  return { knowledgeKey: explicitKey.startsWith("knowledge:") ? explicitKey : "knowledge:" + hash(identitySerialization(dimensions)), dimensions };
}

/** Normalize an Evolution record into stable issue/root/strategy/failure semantics. */
export function normalizeKnowledgeEvent(input = {}, { sourceCollection = "event", now = new Date() } = {}) {
  const identity = knowledgeIdentity(input);
  if (!identity) return null;
  const { dimensions } = identity;
  const { issueType, rootCause, strategy, failureMode, semanticFact, scope } = dimensions;
  const status = normalizedStatus(input);
  const outcome = outcomeOf(input, status);
  const source = String(sourceCollection || "event");
  const eventId = first(input, ["eventId", "executionEventId", "bridgeEventId", "canonicalEventId"]);
  const sourceId = eventReference(input);
  return {
    knowledgeKey: identity.knowledgeKey,
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
    delta: eventDelta(input.knowledgeCount ?? input.occurrenceDelta ?? 1),
  };
}

export function canonicalKnowledgeKey(input = {}, options = {}) {
  if (typeof input === "string" && input.startsWith("knowledge:")) return input;
  if (input?.knowledgeKey && input?.dimensions) return input.knowledgeKey;
  return knowledgeKeyOf(input);
}

/**
 * The canonical key `normalizeKnowledgeEvent` computes for a record, obtained
 * without materialising the outcome, metrics, recovery and reference fields
 * that no identity comparison reads. This is the exact key
 * `normalizeKnowledgeEvent(input).knowledgeKey`, not the stored
 * `input.knowledgeKey`, so a caller that must recompute identity from the
 * record's own fields gets the recomputed value.
 */
export function knowledgeKeyOf(input = {}) {
  return knowledgeIdentity(input)?.knowledgeKey ?? null;
}

function emptyEffectStats() { return { successCount: 0, failureCount: 0, neutralCount: 0, regressionCount: 0, fitnessCount: 0, fitnessSum: 0, fitnessMean: null, bestFitness: null, worstFitness: null, successRate: null, metrics: {} }; }

/**
 * One stored metric accumulator with every field bounded. A row written before
 * the counters saturated can hold a non-finite `sum` or `count`, and JSON would
 * store it back as `null`.
 */
function metricAccumulator(stat, fallback = 0) {
  const source = stat && typeof stat === "object" ? stat : null;
  const last = clampAccumulator(source?.last ?? fallback);
  const count = accumulateCount(0, source?.count);
  const sum = accumulatorSum(0, source?.sum);
  return { count, sum, min: Math.min(clampAccumulator(source?.min ?? last), last), max: Math.max(clampAccumulator(source?.max ?? last), last), last, mean: sum / Math.max(1, count) };
}

function mergeMetricStats(current, values, delta) {
  const output = { ...(current && typeof current === "object" ? current : {}) };
  for (const [key, value] of Object.entries(values ?? {})) {
    const n = numeric(value);
    if (n === null) continue;
    const previous = output[key] && typeof output[key] === "object" ? metricAccumulator(output[key], n) : { count: 0, sum: 0, min: n, max: n, last: n };
    output[key] = metricAccumulator({ count: accumulateCount(previous.count, delta), sum: accumulatorSum(previous.sum, n * delta), min: Math.min(previous.min, n), max: Math.max(previous.max, n), last: n }, n);
  }
  // Every stored stat, including the ones this event does not measure, is
  // repaired on the way through.
  for (const [key, stat] of Object.entries(output)) if (stat && typeof stat === "object") output[key] = metricAccumulator(stat);
  return Object.fromEntries(Object.keys(output).slice(0, MAX_METRICS).map((key) => [key, output[key]]));
}

function mergeEffects(previous, event, delta) {
  const old = { ...emptyEffectStats(), ...(previous && typeof previous === "object" ? previous : {}) };
  // Repair every counter first: the ones this event does not increment would
  // otherwise carry a legacy non-finite value forward untouched.
  for (const key of ["successCount", "failureCount", "neutralCount", "regressionCount", "fitnessCount"]) old[key] = accumulateCount(old[key], 0);
  old.fitnessSum = accumulatorSum(old.fitnessSum, 0);
  for (const key of ["bestFitness", "worstFitness"]) if (old[key] !== null && old[key] !== undefined) old[key] = clampAccumulator(old[key]);
  if (event.outcome === "success") old.successCount = accumulateCount(old.successCount, delta);
  else if (event.outcome === "failure") old.failureCount = accumulateCount(old.failureCount, delta);
  else old.neutralCount = accumulateCount(old.neutralCount, delta);
  if (event.regression) old.regressionCount = accumulateCount(old.regressionCount, delta);
  if (event.fitness !== null) {
    old.fitnessCount = accumulateCount(old.fitnessCount, delta);
    old.fitnessSum = accumulatorSum(old.fitnessSum, event.fitness * delta);
    old.fitnessMean = old.fitnessSum / Math.max(1, old.fitnessCount);
    old.bestFitness = old.bestFitness === null || old.bestFitness === undefined ? event.fitness : Math.max(clampAccumulator(old.bestFitness), event.fitness);
    old.worstFitness = old.worstFitness === null || old.worstFitness === undefined ? event.fitness : Math.min(clampAccumulator(old.worstFitness), event.fitness);
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

/**
 * The recent event ids kept on a knowledge record, newest last, plus how many
 * ids the window dropped.
 *
 * This is a bounded replay guard, not the authoritative ledger. The domain
 * store keeps the exact `applied` map it consults before any mutation, and the
 * memory bridge keeps the last 4096 host event ids, so a replay older than this
 * window is recognised before it reaches this merge. If one does reach it,
 * `eventIdsDropped` on the record says the window no longer covers its history
 * instead of the record looking complete.
 */
function appendEventIds(values, value, limit = MAX_EVENT_IDS) {
  const ids = Array.isArray(values) ? values.filter((id) => id !== undefined && id !== null).map(clone) : [];
  if (value !== undefined && value !== null) {
    const id = String(value);
    if (!ids.some((existing) => String(existing) === id)) ids.push(id);
  }
  return { ids: ids.slice(-limit), dropped: Math.max(0, ids.length - limit) };
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
  const delta = eventDelta(event.delta);
  const old = previous && typeof previous === "object" ? previous : null;
  const oldCount = accumulateCount(0, old?.count ?? old?.occurrenceCount ?? 0);
  const nextCount = accumulateCount(oldCount, delta);
  const effects = mergeEffects(old?.effectStats, event, delta);
  const firstSeen = old?.firstSeen && timeValue(old.firstSeen) <= timeValue(at) ? old.firstSeen : at;
  const lastSeen = old?.lastSeen && timeValue(old.lastSeen) >= timeValue(at) ? old.lastSeen : at;
  const sourceCollection = event.sourceCollection || old?.lastSourceCollection || "event";
  const sourceCounts = { ...(old?.sourceCounts && typeof old.sourceCounts === "object" ? old.sourceCounts : {}) };
  sourceCounts[sourceCollection] = accumulateCount(sourceCounts[sourceCollection], delta);
  const lineageRef = event.lineageId === null || event.lineageId === undefined ? null : String(event.lineageId);
  const evidence = compactEvidence(event);
  const eventIdWindow = appendEventIds(old?.eventIds, event.eventId);
  const droppedEventIds = accumulateCount(old?.eventIdsDropped, eventIdWindow.dropped);
  const previousSuccess = old?.lastOutcome === "success" || Number(old?.effectStats?.successCount) > 0;
  const regression = Boolean(event.regression || (previousSuccess && event.outcome === "failure"));
  if (regression && !event.regression) effects.regressionCount = accumulateCount(effects.regressionCount, delta);
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
    count: nextCount,
    occurrenceCount: nextCount,
    firstSeen,
    lastSeen,
    lastSourceCollection: sourceCollection,
    lastStatus: event.status ?? old?.lastStatus ?? null,
    lastOutcome: event.outcome,
    sourceCounts,
    sourceRefs: appendBounded(old?.sourceRefs, event.sourceRef, MAX_REFS),
    lineageRefs: appendBounded(old?.lineageRefs, lineageRef, MAX_REFS),
    relationRefs: mergedRelations,
    eventIds: eventIdWindow.ids,
    // Only present once the window has dropped an id: a record that has never
    // rolled keeps exactly the bytes it kept before.
    ...(droppedEventIds > 0 ? { eventIdsDropped: droppedEventIds } : {}),
    evidenceCount: accumulateCount(old?.evidenceCount, delta),
    recentEvidence: appendBounded(old?.recentEvidence, evidence, MAX_RECENT),
    confidence: oldCount > 0 ? ((Number(old?.confidence) || 0.5) * oldCount + event.confidence * delta) / Math.max(1, oldCount + delta) : event.confidence,
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
    contradictionCount: accumulateCount(old?.contradictionCount, event.contradiction ? delta : 0),
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
