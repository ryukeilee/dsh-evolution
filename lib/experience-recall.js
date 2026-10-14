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
 * read side. It is called only by an explicit owner-triggered action
 * (`evolution_propose`, `evolution_history` with a query), never by a timer, a
 * poll loop, or a background model turn.
 *
 * Every limit is explicit and enforced here, not by the caller:
 *   - `maxConsidered` bounds how much durable history is scanned at all,
 *   - `maxRecords` bounds what one source contributes after matching,
 *   - `maxEntries` bounds each returned group,
 *   - `maxText` / `maxEvidenceRefs` bound each field and its provenance.
 *
 * The result is advisory. It never blocks a proposal, never grants promotion
 * authority, and never manufactures a decision the recorded evidence does not
 * support: `advice` only restates what the bounded records already show.
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
const DAY_MS = 24 * 60 * 60 * 1000;

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
  record.strategy = bounded(experiment.target ?? experiment.idPrefix ?? "", limits.maxText);
  record.failureMode = bounded(result.category ?? result.state ?? "", limits.maxText);
  record.rootCause = bounded(result.rootCauseHypothesis ?? "", limits.maxText);
  record.prevention = bounded(entry.prevention === "unknown" ? "" : entry.prevention, limits.maxText);
  record.state = resolved ? "RESOLVED" : "ACTIVE";
  record.lastOutcome = resolved ? "success" : "failure";
  record.successCount = resolved ? 1 : 0;
  record.failureCount = resolved ? 0 : Math.max(1, integer(entry.count));
  record.successRate = resolved ? 1 : 0;
  record.occurrences = Math.max(1, integer(entry.count));
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

const SCORE_WEIGHTS = Object.freeze({ coverage: 0.40, success: 0.25, fitness: 0.20, evidence: 0.10, recency: 0.05 });

function successOf(record) {
  if (record.successRate !== null) return clamp01(record.successRate);
  if (record.successCount > 0 && record.failureCount === 0) return 1;
  if (record.successCount === 0 && record.failureCount > 0) return 0;
  return 0.5;
}

function scoreOf(record, coverage, newest) {
  const evidence = clamp01(record.occurrences / 3);
  const fitness = record.fitnessMean === null ? 0.5 : clamp01(record.fitnessMean);
  const lastSeen = epoch(record.lastSeen);
  const recency = newest > 0 && lastSeen > 0 ? clamp01(1 - Math.min(1, (newest - lastSeen) / (90 * DAY_MS))) : 0.5;
  const raw = SCORE_WEIGHTS.coverage * coverage
    + SCORE_WEIGHTS.success * successOf(record)
    + SCORE_WEIGHTS.fitness * fitness
    + SCORE_WEIGHTS.evidence * evidence
    + SCORE_WEIGHTS.recency * recency;
  return Math.round(clamp01(raw) * 10_000) / 10_000;
}

function match(records, query, limits) {
  const matched = [];
  for (const record of records) {
    const result = matchOf(record, query);
    if (!result.matched) continue;
    matched.push({ record, ...result });
  }
  const newest = matched.reduce((best, item) => Math.max(best, epoch(item.record.lastSeen)), 0);
  const scored = matched.map((item) => {
    const projected = { ...item.record, coverage: Math.round(item.coverage * 10_000) / 10_000, exact: item.exact };
    projected.score = scoreOf(item.record, item.coverage, newest);
    return projected;
  });
  scored.sort((left, right) => right.score - left.score
    || epoch(right.lastSeen) - epoch(left.lastSeen)
    || String(left.key ?? "").localeCompare(String(right.key ?? "")));
  return scored.slice(0, limits.maxRecords);
}

function source(rows, name, query, limits, mapper) {
  const list = Array.isArray(rows) ? rows : [];
  const considered = list.slice(-limits.maxConsidered);
  const records = [];
  for (const row of considered) {
    const record = mapper(row, limits);
    if (record) records.push(record);
  }
  return { source: name, considered: considered.length, scanned: list.length, records: match(records, query, limits) };
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

function duplicateOf(records, query) {
  if (!query.knowledgeKey) return null;
  const exact = records.filter((record) => record.exact);
  if (exact.length === 0) return null;
  const occurrences = exact.reduce((total, record) => total + Math.max(1, record.occurrences), 0);
  const firstSeen = exact.map((record) => record.lastSeen).filter(Boolean).sort()[0] ?? null;
  const latest = [...exact].sort((left, right) => epoch(right.lastSeen) - epoch(left.lastSeen))[0];
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
 */
export function finalizeExperienceRecall(input = {}, sources = [], options = {}) {
  const limits = limitsOf(options);
  const query = buildExperienceQuery(input);
  const list = Array.isArray(sources) ? sources : [];
  const records = [];
  const seen = new Set();
  const summary = [];
  const unavailable = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.error) unavailable.push(`${entry.source ?? "source"}:${bounded(entry.error, 64)}`);
    const rows = Array.isArray(entry.records) ? entry.records : [];
    for (const record of rows) {
      const identity = `${record.source}:${record.key ?? [record.problem, record.scope, record.strategy, record.failureMode, record.rootCause].join("|")}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      records.push(record);
    }
    summary.push({
      source: entry.source ?? "unknown",
      considered: integer(entry.considered),
      scanned: Math.max(integer(entry.scanned), integer(entry.considered)),
      matched: rows.length,
      available: !entry.error,
    });
  }
  const duplicate = duplicateOf(records, query);
  const groups = { resolved: [], failures: [], candidates: [] };
  let returned = 0;
  for (const record of records) {
    const kind = kindOf(record);
    if (!kind) continue;
    const bucket = kind === "resolved" ? groups.resolved : kind === "candidate" ? groups.candidates : groups.failures;
    if (bucket.length >= limits.maxEntries) continue;
    bucket.push(record);
    returned += 1;
  }
  return {
    query: { problem: query.problem, target: query.target, tokens: query.tokens.length },
    resolved: groups.resolved,
    failures: groups.failures,
    candidates: groups.candidates,
    duplicate,
    advice: adviceFor({ duplicate, resolved: groups.resolved, failures: groups.failures, candidates: groups.candidates }),
    counts: { matched: records.length, returned },
    sources: summary,
    unavailable,
    truncated: records.length > returned,
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
