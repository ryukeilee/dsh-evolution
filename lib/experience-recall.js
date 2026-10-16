/**
 * On-demand experience recall for the explicit evolution path.
 *
 * Daily operation already accumulates durable experience with no model in the
 * loop: `ctx.on("agent/error")` / `ctx.on("tools/result")` record failures into
 * the domain observation store, the authenticated event bridge replays every
 * proposal/trial/measure/promotion fact into `evolution memory`, and
 * `dockyard-domain/knowledge.js` folds those facts into bounded canonical
 * knowledge rows (`state`, `lastOutcome`, `effectStats`, `trend`, evidence).
 *
 * What was missing is consumption: a new proposal started from zero every time,
 * so the same target could be proposed and trialled again after it had already
 * been resolved or had already failed. This module is the bounded, model-free
 * read side. It is called only by the explicit proposal action
 * (`evolution_propose`, and `evolution_history` with a query); the autonomous
 * observer reaches the same entry point when it files a proposal, so there is
 * no timer, poll loop, or background model turn that reads history by itself.
 *
 * Every limit is explicit and enforced here, not by the caller:
 *   - `maxConsidered` bounds how much history is projected and text-matched by
 *     the ordinary scan. An exact `knowledgeKey` hit is also honoured outside
 *     that window, and such a row is still projected and matched like any
 *     other, so `maxConsidered` is not a hard bound on the work done,
 *   - `maxRecords` bounds what one source contributes after matching. An exact
 *     key replay is ordered ahead of ordinary text matches, so it is reserved a
 *     slot inside that cap; the cap itself still applies, and an exact replay
 *     beyond `maxRecords` is truncated like any other record,
 *   - `maxEntries` bounds each returned group,
 *   - `maxText` / `maxEvidenceRefs` bound each field and its provenance.
 *
 * The records a source hands to `finalizeExperienceRecall` are read back
 * through the known projection fields and clamped to the declared bounds, so a
 * third-party `domainStorage.recall()` cannot widen the six content fields,
 * `state`, `lastOutcome`, the counts, the dates or the evidence refs, cannot
 * keep an undeclared field, and cannot contribute more than `maxRecords`
 * distinct facts. `source` and a string `key` are the exception: both identity
 * fields are carried through unchanged, so their size is bounded by the source
 * that supplied them, not by this module. The two collectors here already emit
 * that exact shape, so their output is unchanged by the rebuild.
 *
 * Ranking uses one score, `scoreOf(record, coverage)`: a bounded relevance-and-
 * evidence-quality value built from the four `SCORE_WEIGHTS` terms (match
 * coverage, recorded success, measured fitness, evidence magnitude). Its
 * maximum is the sum of those weights (0.95), not 1. The score is a pure
 * function of the record and its match coverage — it reads no clock and no
 * other record — and the same value is used for the per-source `maxRecords`
 * retention and for the final ordering, so a source's retained set is exactly
 * its own top-`maxRecords` under the comparator the final answer uses. Recency
 * is not a score term: it only orders records that are otherwise equal
 * (`lastSeen` descending).
 *
 * The result is advisory. It never blocks a proposal, never grants promotion
 * authority, and never manufactures a decision the recorded evidence does not
 * support: `advice` only restates what the bounded records already show. The
 * read is read-only in the other direction too: `finalizeExperienceRecall`
 * never writes to the records a source handed over — it rebuilds copies.
 *
 * Two records collapse into one fact only when their group, their normalised
 * six-field description, and their whole recorded outcome/measurement set
 * (`lastOutcome`, `occurrences`, `regressionCount`, `successCount`,
 * `failureCount`, `successRate`, `fitnessMean`) all agree. `duplicate`
 * describes one exact `knowledgeKey` replay: `occurrences` is the highest
 * recorded count among the snapshots of that key, never their sum, while
 * `firstSeen` is the earliest and `lastSeen` / `state` / `outcome` come from
 * the newest snapshot. `truncated` covers both reasons history was withheld —
 * the returned groups being smaller than the distinct set, and any source
 * dropping a candidate (`sources[].dropped`) before it reached the final
 * stage.
 */
import { canonicalKnowledgeKey } from "./dockyard-domain/knowledge.js";

/** Frozen output contract: the whole recall must fit a bounded context window. */
export const EXPERIENCE_RECALL_LIMITS = Object.freeze({
  maxEntries: 3,
  maxRecords: 12,
  maxText: 160,
  maxEvidenceRefs: 2,
  maxConsidered: 2000,
  maxAdvice: 3,
  maxTokens: 48,
  maxRefLength: 96,
});

/**
 * A record is relevant when it is the exact recorded identity, when it carries
 * every token of the requested subject (target), or when it shares at least
 * `MIN_OVERLAP` tokens with most of the query. The subject rule is what keeps a
 * generic shared token such as `plugin` or `component` from matching an
 * unrelated target.
 */
const MIN_OVERLAP = 2;
const MIN_COVERAGE = 0.5;
const SUBJECT_COVERAGE = 0.9;

/** Chinese text is not token-separated by punctuation, so keep CJK ranges. */
const TOKEN_SPLIT = /[^a-z0-9\u3400-\u9fff]+/u;

function text(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try { return JSON.stringify(value) ?? ""; } catch { return String(value); }
}

function bounded(value, limit = EXPERIENCE_RECALL_LIMITS.maxText) {
  const normalized = text(value).trim();
  return normalized.length <= limit ? normalized : normalized.slice(0, Math.max(0, limit - 1)) + "…";
}

function tokens(value, limit = EXPERIENCE_RECALL_LIMITS.maxTokens) {
  const found = new Set();
  const visit = (entry) => {
    if (Array.isArray(entry)) { for (const item of entry) visit(item); return; }
    if (entry === undefined || entry === null) return;
    for (const token of text(entry).normalize("NFKC").toLowerCase().split(TOKEN_SPLIT)) {
      if (token.length > 1 && found.size < limit * 4) found.add(token);
    }
  };
  visit(value);
  return [...found].slice(0, limit);
}

function integer(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function finite(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp01(value) { return Math.min(1, Math.max(0, value)); }

function epoch(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoOrNull(value) {
  const parsed = epoch(value);
  return parsed > 0 ? new Date(parsed).toISOString() : null;
}

function limitsOf(options = {}) {
  const limits = options.limits && typeof options.limits === "object" ? options.limits : options;
  const pick = (key) => {
    const value = Number(limits?.[key]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : EXPERIENCE_RECALL_LIMITS[key];
  };
  return {
    maxEntries: Math.min(EXPERIENCE_RECALL_LIMITS.maxEntries, pick("maxEntries")),
    maxRecords: Math.min(EXPERIENCE_RECALL_LIMITS.maxRecords, pick("maxRecords")),
    maxText: Math.min(EXPERIENCE_RECALL_LIMITS.maxText, pick("maxText")),
    maxEvidenceRefs: Math.min(EXPERIENCE_RECALL_LIMITS.maxEvidenceRefs, pick("maxEvidenceRefs")),
    maxConsidered: Math.min(EXPERIENCE_RECALL_LIMITS.maxConsidered, pick("maxConsidered")),
    maxAdvice: EXPERIENCE_RECALL_LIMITS.maxAdvice,
  };
}

/**
 * A stable semantic query for one evolution request. `knowledgeKey` is built
 * the same way the proposal fact was folded into canonical knowledge, so an
 * exact replay of an already-recorded problem is detected by identity rather
 * than by fuzzy text overlap.
 */
export function buildExperienceQuery(input = {}) {
  const source = input && typeof input === "object" ? input : { problem: input };
  const problem = text(source.problem ?? source.why ?? source.reason ?? source.goal ?? source.message ?? source.query);
  const target = text(source.target ?? source.componentId ?? source.capabilityId ?? source.affectedComponent ?? source.scope);
  const strategy = source.strategy ?? source.candidateStrategy ?? source.solution ?? source.approach;
  const failureMode = text(source.failureMode ?? source.failurePattern ?? source.errorCode ?? source.signature);
  const rootCause = text(source.rootCause ?? source.rootCauseHypothesis ?? source.cause);
  const impactScope = Array.isArray(source.impactScope) ? source.impactScope : [];
  const successMetrics = Array.isArray(source.successMetrics) ? source.successMetrics : [];
  // The bridge records a proposal as `{ problem: target, capabilityId: target }`,
  // so the query must use the target as the problem subject to hit that key.
  const subject = target || problem;
  return {
    problem: bounded(problem),
    target: bounded(target),
    tokens: tokens([problem, target, impactScope, successMetrics, strategy, failureMode, rootCause]),
    subjectTokens: tokens(subject, 8),
    knowledgeKey: subject ? canonicalKnowledgeKey({ problem: subject, target: subject, capabilityId: subject }) : null,
  };
}

function evidenceRefs(entry, limit) {
  const collected = [];
  const push = (value) => {
    const next = bounded(value, EXPERIENCE_RECALL_LIMITS.maxRefLength);
    if (next && !collected.includes(next)) collected.push(next);
  };
  for (const ref of Array.isArray(entry?.sourceRefs) ? entry.sourceRefs : []) push(ref);
  for (const id of Array.isArray(entry?.eventIds) ? entry.eventIds : []) push(id);
  for (const item of Array.isArray(entry?.recentEvidence) ? entry.recentEvidence : []) {
    if (item && typeof item === "object") push(`${item.source ?? "event"}:${item.id ?? "?"}@${item.at ?? "?"}`);
    else push(item);
  }
  return collected.slice(0, limit);
}

function baseRecord(source) {
  return {
    source,
    key: null,
    problem: "",
    scope: "",
    strategy: "",
    failureMode: "",
    rootCause: "",
    state: "",
    lastOutcome: "",
    successCount: 0,
    failureCount: 0,
    successRate: null,
    fitnessMean: null,
    regressionCount: 0,
    occurrences: 1,
    firstSeen: null,
    lastSeen: null,
    evidenceRefs: [],
    prevention: "",
  };
}

/** Project one canonical knowledge row into a bounded experience record. */
export function knowledgeExperienceRecord(entry, limits = EXPERIENCE_RECALL_LIMITS) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const dims = entry.dimensions && typeof entry.dimensions === "object" ? entry.dimensions : {};
  const effects = entry.effectStats && typeof entry.effectStats === "object" ? entry.effectStats : {};
  const successCount = integer(effects.successCount ?? entry.successCount);
  const failureCount = integer(effects.failureCount ?? entry.failureCount);
  const record = baseRecord("knowledge");
  record.key = typeof entry.knowledgeKey === "string" && entry.knowledgeKey ? entry.knowledgeKey : null;
  record.problem = bounded(entry.semanticFact ?? dims.semanticFact ?? "", limits.maxText);
  record.scope = bounded(dims.scope ?? entry.scope ?? "", limits.maxText);
  record.strategy = bounded(dims.strategy ?? entry.strategy ?? "", limits.maxText);
  record.failureMode = bounded(dims.failureMode ?? entry.failureMode ?? "", limits.maxText);
  record.rootCause = bounded(dims.rootCause ?? entry.rootCause ?? "", limits.maxText);
  record.state = bounded(entry.state ?? "", 40);
  record.lastOutcome = bounded(entry.lastOutcome ?? "", 40);
  record.successCount = successCount;
  record.failureCount = failureCount;
  record.successRate = finite(effects.successRate ?? entry.successRate);
  record.fitnessMean = finite(entry.fitnessMean ?? effects.fitnessMean);
  record.regressionCount = integer(entry.regressionCount ?? effects.regressionCount);
  record.occurrences = Math.max(integer(entry.occurrenceCount ?? entry.count), successCount + failureCount, 1);
  record.firstSeen = isoOrNull(entry.firstSeen);
  record.lastSeen = isoOrNull(entry.lastSeen ?? entry.updatedAt);
  record.evidenceRefs = evidenceRefs(entry, limits.maxEvidenceRefs);
  const signal = record.key || record.problem || record.scope || record.strategy || record.failureMode || record.rootCause;
  return signal ? record : null;
}

/**
 * Project one durable failure-memory entry. The local memory records *why* an
 * autonomous experiment was not repeated (`problem`, `result.category`,
 * `prevention`), which is exactly the negative evidence a new proposal needs.
 */
export function failureMemoryExperienceRecord(entry, limits = EXPERIENCE_RECALL_LIMITS) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const result = entry.result && typeof entry.result === "object" ? entry.result : { state: entry.result };
  const experiment = entry.experiment && typeof entry.experiment === "object" ? entry.experiment : {};
  const resolved = entry.status === "resolved";
  const record = baseRecord("failure-memory");
  record.key = typeof entry.signature === "string" && entry.signature ? entry.signature : null;
  record.problem = bounded(entry.problem === "unknown" ? "" : entry.problem, limits.maxText);
  record.scope = bounded(experiment.patternKey ?? experiment.target ?? "", limits.maxText);
  // A failure-memory entry records why an approach must not be repeated, not a
  // reusable strategy: classifying it as a candidate would invent authority
  // the entry never carried.
  record.strategy = "";
  record.failureMode = bounded(result.category ?? result.state ?? "", limits.maxText);
  record.rootCause = bounded(result.rootCauseHypothesis ?? "", limits.maxText);
  record.prevention = bounded(entry.prevention === "unknown" ? "" : entry.prevention, limits.maxText);
  record.state = resolved ? "RESOLVED" : "ACTIVE";
  record.lastOutcome = resolved ? "success" : "failure";
  record.successCount = resolved ? 1 : 0;
  record.failureCount = resolved ? 0 : Math.max(1, integer(entry.count));
  record.successRate = resolved ? 1 : 0;
  record.occurrences = Math.max(1, integer(entry.count));
  record.firstSeen = isoOrNull(entry.firstSeenAt);
  record.lastSeen = isoOrNull(entry.lastSeenAt ?? entry.firstSeenAt);
  record.evidenceRefs = [];
  const signal = record.problem || record.scope || record.failureMode || record.prevention;
  return signal ? record : null;
}

function matchOf(record, query) {
  const exact = Boolean(query.knowledgeKey && record.key === query.knowledgeKey);
  const recordTokens = tokens([record.problem, record.scope, record.strategy, record.failureMode, record.rootCause, record.prevention]);
  const wanted = new Set(recordTokens);
  let overlap = 0;
  for (const token of query.tokens) if (wanted.has(token)) overlap += 1;
  const overlapCoverage = query.tokens.length === 0 || recordTokens.length === 0
    ? 0
    : clamp01(overlap / Math.min(query.tokens.length, recordTokens.length));
  const subjectHit = query.subjectTokens.length > 0 && query.subjectTokens.every((token) => wanted.has(token));
  const matched = exact || subjectHit || (overlap >= MIN_OVERLAP && overlapCoverage >= MIN_COVERAGE);
  const coverage = exact ? 1 : subjectHit ? Math.max(overlapCoverage, SUBJECT_COVERAGE) : overlapCoverage;
  return { matched, coverage, exact, subjectHit };
}

/** The four quality terms of the recall score; their sum (0.95) is its maximum. */
const SCORE_WEIGHTS = Object.freeze({ coverage: 0.40, success: 0.25, fitness: 0.20, evidence: 0.10 });

function successOf(record) {
  if (record.successRate !== null) return clamp01(record.successRate);
  if (record.successCount > 0 && record.failureCount === 0) return 1;
  if (record.successCount === 0 && record.failureCount > 0) return 0;
  return 0.5;
}

/**
 * Pure relevance-and-evidence score of one record and its match coverage. It
 * reads nothing outside the record, so a record scores the same whether it is
 * finalized alone or merged with newer sources; recency is a comparator
 * tie-break, never a score term.
 */
function scoreOf(record, coverage) {
  const evidence = clamp01(record.occurrences / 3);
  const fitness = record.fitnessMean === null ? 0.5 : clamp01(record.fitnessMean);
  const raw = SCORE_WEIGHTS.coverage * coverage
    + SCORE_WEIGHTS.success * successOf(record)
    + SCORE_WEIGHTS.fitness * fitness
    + SCORE_WEIGHTS.evidence * evidence;
  return Math.round(clamp01(raw) * 10_000) / 10_000;
}

/**
 * The six bounded fields that describe the fact a record carries. Two records
 * from different sources describe the same fact only when all six agree, so
 * this is what content dedupe compares.
 */
const CONTENT_FIELDS = Object.freeze(["problem", "scope", "strategy", "failureMode", "rootCause", "prevention"]);
/** NUL (`\u0000`), used only as a delimiter inside the three identities below. */
const IDENTITY_SEPARATOR = "\u0000";

/**
 * Locale-independent total order over one record. `localeCompare` orders
 * strings by the runtime's default locale, so it cannot be the tie-break of a
 * deterministic ranking; this is compared with plain `<` / `>` on code units.
 *
 * The key encodes every field the recall reports — the six content fields, the
 * key, the match `coverage`, the source name, the outcome/measurement set, both
 * dates and the bounded evidence refs — each length-prefixed in a fixed order.
 * Two records that differ anywhere in the reported output therefore never
 * compare equal, so no ordering decision can fall back to the order the sources
 * were merged in. `score` and `exact` are deliberately absent: the comparator
 * resolves both before it ever consults this key, so neither can reach it as a
 * tie. The source name is part of the key, so two otherwise identical records
 * still have a fixed order.
 */
function lengthPrefixed(value) {
  const string = text(value);
  return `${string.length}${IDENTITY_SEPARATOR}${string}`;
}

function orderingKey(record) {
  const refs = (Array.isArray(record.evidenceRefs) ? record.evidenceRefs : []).map(lengthPrefixed).join("");
  return [
    record.key ?? "",
    record.coverage ?? "",
    record.source ?? "",
    ...CONTENT_FIELDS.map((field) => record[field] ?? ""),
    record.state ?? "",
    record.lastOutcome ?? "",
    record.successCount,
    record.failureCount,
    record.successRate,
    record.fitnessMean,
    record.regressionCount,
    record.occurrences,
    record.firstSeen ?? "",
    record.lastSeen ?? "",
    refs,
  ].map(lengthPrefixed).join(IDENTITY_SEPARATOR);
}

function compareOrderingKeys(left, right) {
  const leftKey = orderingKey(left);
  const rightKey = orderingKey(right);
  return leftKey === rightKey ? 0 : leftKey < rightKey ? -1 : 1;
}

/**
 * The one deterministic candidate order, used everywhere records are ranked:
 * an exact `knowledgeKey` replay first, then the highest `scoreOf` value, then
 * the most recent record, then the full `orderingKey` above. Every term is a
 * property of the records themselves, not of the order the sources were merged
 * in.
 */
function compareCandidates(left, right) {
  const exact = (left.exact ? 1 : 0) - (right.exact ? 1 : 0);
  if (exact !== 0) return -exact;
  const score = (finite(right.score) ?? 0) - (finite(left.score) ?? 0);
  if (score !== 0) return score;
  const recency = epoch(right.lastSeen) - epoch(left.lastSeen);
  if (recency !== 0) return recency;
  return compareOrderingKeys(left, right);
}

/**
 * Normalized content identity of a record: NFKC, lowercase, trim. The join is
 * length-prefixed, so a separator inside a field can never be mistaken for a
 * field boundary.
 */
function contentIdentity(record) {
  return CONTENT_FIELDS
    .map((field) => text(record[field]).normalize("NFKC").toLowerCase().trim())
    .map((value) => `${value.length}${IDENTITY_SEPARATOR}${value}`)
    .join(IDENTITY_SEPARATOR);
}

/**
 * Identity of the *fact* a record carries: its group (`kindOf`, empty for a
 * neutral record), the normalised six-field description, and the whole
 * recorded outcome/measurement set (`lastOutcome`, `occurrences`,
 * `regressionCount`, `successCount`, `failureCount`, `successRate`,
 * `fitnessMean`). A record whose outcome or measurement differs is a different
 * observation even when its description is identical, and must never be merged
 * away. This is the one identity both the per-source retention and the
 * cross-source merge collapse by.
 */
function factIdentity(record) {
  return [
    kindOf(record) ?? "",
    contentIdentity(record),
    text(record.lastOutcome),
    String(integer(record.occurrences)),
    String(integer(record.regressionCount)),
    String(integer(record.successCount)),
    String(integer(record.failureCount)),
    text(record.successRate ?? ""),
    text(record.fitnessMean ?? ""),
  ].map((value) => `${value.length}${IDENTITY_SEPARATOR}${value}`).join(IDENTITY_SEPARATOR);
}

/**
 * Collapse records that carry the same fact, keeping the first one in
 * comparator order. The survivor carries the union of the group's evidence
 * refs (survivor first, deduplicated, still inside `maxEvidenceRefs`) and the
 * earliest non-empty `firstSeen` of the group, so a newer snapshot cannot hide
 * when the fact was first seen; when the group has none, the survivor keeps its
 * own value. Collapsing runs before `maxRecords` retention, so a duplicate can
 * never consume a slot that would otherwise hold a distinct record. `records`
 * must already be sorted by `compareCandidates`.
 */
function collapseFacts(records, maxEvidenceRefs) {
  const groups = new Map();
  for (const record of records) {
    const identity = factIdentity(record);
    const group = groups.get(identity);
    if (group) { group.push(record); continue; }
    groups.set(identity, [record]);
  }
  const kept = [];
  let duplicates = 0;
  for (const group of groups.values()) {
    if (group.length === 1) { kept.push(group[0]); continue; }
    const survivor = { ...group[0] };
    const refs = [];
    for (const record of group) {
      for (const ref of Array.isArray(record.evidenceRefs) ? record.evidenceRefs : []) {
        if (!refs.includes(ref)) refs.push(ref);
      }
    }
    survivor.evidenceRefs = refs.slice(0, maxEvidenceRefs);
    // Ordering is by parsed epoch, not by string comparison: every non-null
    // value here already passed `isoOrNull`, and an extended-year ISO string is
    // wider (`"+010000-..."` is 27 characters against the usual 24) and would
    // win a lexicographic sort with its leading `+`. The first non-empty value
    // by parsed epoch is the earliest snapshot of this fact.
    const firstSeen = group.map((record) => record.firstSeen).filter(Boolean)
      .sort((left, right) => epoch(left) - epoch(right))[0];
    if (firstSeen) survivor.firstSeen = firstSeen;
    duplicates += group.length - 1;
    kept.push(survivor);
  }
  return { records: kept, duplicates };
}

/**
 * Keep one source inside `maxRecords`, giving an exact-key replay its reserved
 * slot first and spending the remaining capacity on the best ordinary matches.
 * The cap still applies to exact replays: when more than `maxRecords` exact
 * matches exist, only the first `maxRecords` survive. The retained list is
 * re-sorted so the returned order is still the deterministic candidate order.
 */
function retainMatches(scored, maxRecords) {
  if (scored.length <= maxRecords) return scored;
  const retained = scored.filter((record) => record.exact).slice(0, maxRecords);
  for (const record of scored) {
    if (retained.length >= maxRecords) break;
    if (record.exact) continue;
    retained.push(record);
  }
  retained.sort(compareCandidates);
  return retained;
}

function match(records, query, limits) {
  const matched = [];
  for (const record of records) {
    const result = matchOf(record, query);
    if (!result.matched) continue;
    matched.push({ record, ...result });
  }
  const scored = matched.map((item) => {
    const projected = { ...item.record, coverage: Math.round(item.coverage * 10_000) / 10_000, exact: item.exact };
    projected.score = scoreOf(projected, projected.coverage);
    return projected;
  });
  scored.sort(compareCandidates);
  // Collapse identical facts before the cap, so the retained set is the top
  // `maxRecords` distinct facts under the comparator the final answer uses.
  const collapsed = collapseFacts(scored, limits.maxEvidenceRefs);
  const retained = retainMatches(collapsed.records, limits.maxRecords);
  // What this source matched but did not keep: the distinct facts its
  // `maxRecords` cap removed. `finalize` reports these as `sources[].dropped`.
  return { records: retained, duplicates: collapsed.duplicates, dropped: collapsed.records.length - retained.length };
}

/**
 * Rebuild one candidate from the known projection fields and give it the three
 * fields the comparator needs, without writing anything onto the caller's
 * record. Unknown fields of a hand-supplied record are dropped, every field is
 * clamped to the declared bounds, and a record that already carries `coverage`,
 * `exact` or `score` keeps it; a record from another `domainStorage.recall()`
 * implementation that carries none is scored from its own text match instead
 * of being treated as irrelevant. The collectors emit exactly this shape, so
 * their records pass through unchanged.
 */
function boundedEvidenceRefs(value, limit) {
  if (!Array.isArray(value)) return [];
  const collected = [];
  for (const ref of value) {
    const next = bounded(ref, EXPERIENCE_RECALL_LIMITS.maxRefLength);
    if (next && !collected.includes(next)) collected.push(next);
  }
  return collected.slice(0, limit);
}

function scoredCandidate(record, query, limits = EXPERIENCE_RECALL_LIMITS) {
  const copy = baseRecord(text(record.source));
  copy.key = typeof record.key === "string" && record.key ? record.key : null;
  for (const field of CONTENT_FIELDS) copy[field] = bounded(record[field], limits.maxText);
  copy.state = bounded(record.state, 40);
  copy.lastOutcome = bounded(record.lastOutcome, 40);
  copy.successCount = integer(record.successCount);
  copy.failureCount = integer(record.failureCount);
  copy.successRate = finite(record.successRate);
  copy.fitnessMean = finite(record.fitnessMean);
  copy.regressionCount = integer(record.regressionCount);
  copy.occurrences = Math.max(1, integer(record.occurrences));
  copy.firstSeen = isoOrNull(record.firstSeen);
  copy.lastSeen = isoOrNull(record.lastSeen);
  copy.evidenceRefs = boundedEvidenceRefs(record.evidenceRefs, limits.maxEvidenceRefs);
  copy.coverage = finite(record.coverage) ?? Math.round(matchOf(copy, query).coverage * 10_000) / 10_000;
  copy.exact = typeof record.exact === "boolean"
    ? record.exact
    : Boolean(query.knowledgeKey && copy.key === query.knowledgeKey);
  copy.score = finite(record.score) ?? scoreOf(copy, copy.coverage);
  return copy;
}

function source(rows, name, query, limits, mapper) {
  const list = Array.isArray(rows) ? rows : [];
  const start = Math.max(0, list.length - limits.maxConsidered);
  // Tokenizing every historical row would make an explicit proposal pay for
  // the whole archive, so only the newest `maxConsidered` rows are projected.
  // An exact key hit is projected and matched too, but it is retained even
  // outside that window: an old replay of the same target must not become
  // invisible just because many unrelated rows were recorded after it. That is
  // why `maxConsidered` bounds the ordinary scan, not the work done.
  const records = [];
  for (let index = 0; index < list.length; index += 1) {
    const row = list[index];
    const keyHit = Boolean(query.knowledgeKey && row && typeof row === "object" && row.knowledgeKey === query.knowledgeKey);
    if (index < start && !keyHit) continue;
    const record = mapper(row, limits);
    if (record) records.push(record);
  }
  const matched = match(records, query, limits);
  return {
    source: name,
    considered: list.length - start,
    scanned: list.length,
    duplicates: matched.duplicates,
    // Candidates this source matched but its `maxRecords` cap did not keep.
    dropped: matched.dropped,
    records: matched.records,
  };
}

/** Bounded, ranked knowledge matches from canonical domain knowledge rows. */
export function collectKnowledgeExperience(entries, input = {}, options = {}) {
  const limits = limitsOf(options);
  return source(entries, "knowledge", buildExperienceQuery(input), limits, knowledgeExperienceRecord);
}

/** Bounded, ranked matches from the durable local failure memory. */
export function collectFailureMemoryExperience(entries, input = {}, options = {}) {
  const limits = limitsOf(options);
  return source(entries, "failure-memory", buildExperienceQuery(input), limits, failureMemoryExperienceRecord);
}

function kindOf(record) {
  const success = record.successCount > 0;
  const failure = record.failureCount > 0;
  if (!success && !failure) return null;
  const rate = successOf(record);
  if (success && record.strategy && rate >= 0.5) return "candidate";
  if (success && rate >= 0.5) return "resolved";
  if (failure) return "failed";
  return null;
}

/**
 * Report one exact `knowledgeKey` replay from the retained records, before the
 * final cross-source merge (a source's own collapsing already happened inside
 * its collector). Every exact record is a snapshot of the same recorded key,
 * so `occurrences` is the highest recorded occurrence count among them — never
 * the sum, which would count the same recorded events once per snapshot.
 * `firstSeen` is the earliest snapshot by parsed epoch (never by string sort, so
 * an extended-year ISO string cannot win); `lastSeen`, `state` and `outcome`
 * come from the newest one.
 */
function duplicateOf(records, query) {
  if (!query.knowledgeKey) return null;
  const exact = records.filter((record) => record.exact);
  if (exact.length === 0) return null;
  const occurrences = exact.reduce((highest, record) => Math.max(highest, Math.max(1, record.occurrences)), 0);
  // Selected by parsed epoch, for the same reason as in `collapseFacts`.
  const firstSeen = exact.map((record) => record.firstSeen).filter(Boolean)
    .sort((left, right) => epoch(left) - epoch(right))[0] ?? null;
  const latest = [...exact].sort((left, right) => epoch(right.lastSeen) - epoch(left.lastSeen)
    || compareOrderingKeys(left, right))[0];
  return {
    key: query.knowledgeKey,
    occurrences,
    firstSeen,
    lastSeen: latest?.lastSeen ?? null,
    state: latest?.state ?? null,
    outcome: latest?.lastOutcome ?? null,
  };
}

function adviceFor({ duplicate, resolved, failures, candidates }) {
  const advice = [];
  if (duplicate) {
    advice.push(`duplicate: ${duplicate.key} is already recorded ${duplicate.occurrences}x (last outcome ${duplicate.outcome ?? "unknown"}); reuse the recorded result instead of re-running it.`);
  }
  if (resolved[0]) {
    advice.push(`resolved: "${resolved[0].problem || resolved[0].scope}" already has recorded success (successRate ${resolved[0].successRate ?? "unknown"}); prefer reusing it over a new experiment.`);
  }
  if (failures[0]) {
    const informative = failures.find((record) => record.rootCause || record.problem || record.prevention) ?? failures[0];
    advice.push(`failed: prior attempts did not succeed (${informative.failureMode || informative.rootCause || informative.problem || informative.scope}); require a new hypothesis with new evidence before repeating.`);
  }
  if (candidates[0]) {
    advice.push(`candidate: a measured strategy exists with successRate ${candidates[0].successRate ?? "unknown"}; evaluate reusing it before inventing another.`);
  }
  return advice.slice(0, EXPERIENCE_RECALL_LIMITS.maxAdvice);
}

/**
 * Merge per-source matches into one bounded recall. Sources that failed to
 * read are reported in `unavailable` instead of being silently treated as
 * "no history", so an absent store cannot be mistaken for an empty one.
 *
 * The records a source hands over are never written to: every one is rebuilt
 * from the known projection fields and clamped to the declared bounds (see
 * `scoredCandidate`), so finalizing the same collector output twice, or
 * finalizing frozen records, is safe, cannot change a result that was already
 * returned, and cannot let a third-party source widen the rebuilt fields
 * (`source` and a string `key` are carried through; see the module header).
 * Each source is sorted, collapsed and capped to `maxRecords` on its own
 * before the merge,
 * and everything it dropped is reported in `sources[].dropped` and makes
 * `truncated` true.
 */
export function finalizeExperienceRecall(input = {}, sources = [], options = {}) {
  const limits = limitsOf(options);
  const query = buildExperienceQuery(input);
  const list = Array.isArray(sources) ? sources : [];
  const records = [];
  const summary = [];
  const unavailable = [];
  let collapsedInSources = 0;
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.error) unavailable.push(`${entry.source ?? "source"}:${bounded(entry.error, 64)}`);
    const rows = Array.isArray(entry.records) ? entry.records : [];
    const scored = [];
    for (const record of rows) {
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      scored.push(scoredCandidate(record, query, limits));
    }
    scored.sort(compareCandidates);
    // The collector already collapsed and capped its own output; a third-party
    // `domainStorage.recall()` may hand over an uncollapsed, unbounded set, so
    // apply the same identity and cap here and report what that cost.
    const collapsed = collapseFacts(scored, limits.maxEvidenceRefs);
    const retained = retainMatches(collapsed.records, limits.maxRecords);
    const dropped = collapsed.records.length - retained.length;
    for (const record of retained) records.push(record);
    summary.push({
      source: entry.source ?? "unknown",
      considered: integer(entry.considered),
      scanned: Math.max(integer(entry.scanned), integer(entry.considered)),
      matched: rows.length,
      duplicates: integer(entry.duplicates) + collapsed.duplicates,
      dropped: integer(entry.dropped) + dropped,
      available: !entry.error,
    });
    collapsedInSources += integer(entry.duplicates) + collapsed.duplicates;
  }
  records.sort(compareCandidates);
  // The duplicate report reads the retained records before the final
  // cross-source merge — a source's own collapsing already happened inside its
  // collector — so an exact replay is still reported when an identical-content
  // record exists in another source.
  const duplicate = duplicateOf(records, query);
  // The same fact can reach this point from two sources (folded into canonical
  // knowledge and recorded in local durable failure memory). Collapse it with
  // the identity the collector uses, keep the first in comparator order, and
  // report every collapsed record — in-source and cross-source — additively.
  const collapsed = collapseFacts(records, limits.maxEvidenceRefs);
  const distinct = collapsed.records;
  const groups = { resolved: [], failures: [], candidates: [] };
  let returned = 0;
  for (const record of distinct) {
    const kind = kindOf(record);
    if (!kind) continue;
    const bucket = kind === "resolved" ? groups.resolved : kind === "candidate" ? groups.candidates : groups.failures;
    if (bucket.length >= limits.maxEntries) continue;
    bucket.push(record);
    returned += 1;
  }
  // History is truncated when the returned groups are smaller than the
  // distinct set, and also when any source dropped a candidate it had matched
  // (its own `maxRecords` retention, or a collector's, in `sources[].dropped`).
  const truncated = distinct.length > returned || summary.some((entry) => entry.dropped > 0);
  return {
    query: { problem: query.problem, target: query.target, tokens: query.tokens.length },
    resolved: groups.resolved,
    failures: groups.failures,
    candidates: groups.candidates,
    duplicate,
    advice: adviceFor({ duplicate, resolved: groups.resolved, failures: groups.failures, candidates: groups.candidates }),
    counts: { matched: distinct.length, returned, duplicates: collapsedInSources + collapsed.duplicates },
    sources: summary,
    unavailable,
    truncated,
    limits: {
      maxEntries: limits.maxEntries,
      maxRecords: limits.maxRecords,
      maxText: limits.maxText,
      maxEvidenceRefs: limits.maxEvidenceRefs,
      maxConsidered: limits.maxConsidered,
    },
  };
}

/** Exact-key identity a proposal/query would be recorded under. */
export function experienceKnowledgeKey(input = {}) {
  return buildExperienceQuery(input).knowledgeKey;
}
