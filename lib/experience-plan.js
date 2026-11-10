/**
 * Experience-driven discovery, as pure logic.
 *
 * The shared store (`lib/shared-experience.js`) and the domain knowledge rows
 * both accumulate canonical facts, but a fact is only useful to a *new*
 * proposal when something turns the accumulated history into a bounded,
 * reviewable candidate. This module owns that decision and nothing else: it is
 * model-free, I/O-free, reads no clock (the caller passes `now`) and never
 * writes. Every limit is explicit so a candidate plan fits a fixed context
 * window:
 *
 *   - `maxCandidates` bounds the returned plan,
 *   - `maxConsidered` documents the read window a caller should pass,
 *   - `maxEvidenceRefs` / `maxAttempts` / `maxRejected` bound each list,
 *   - `minOccurrences` is only ever raised by the caller (floor 2),
 *   - `maxText` bounds every returned string.
 *
 * A score is deterministic: it is a pure function of the group's recorded
 * numbers (see `SCORE_WEIGHTS`), so the same history always produces the same
 * plan and the same plan always explains itself.
 *
 * A *conclusion* fact is the structured experiment verdict written by
 * `shared-experience.recordConclusion()`. Its `strategy` is a small JSON object
 * (`kind: "cordis-plugin"`), which is both how a conclusion is recognized among
 * the ordinary knowledge rows and where the DSH/Cordis/evolution versions live.
 * Versions are deliberately not part of the knowledge identity: the same
 * problem/strategy under two versions must be comparable in one plan, and only
 * a verdict recorded under the *same* versions counts as proven-ineffective.
 */
import { createHash } from "node:crypto";
import { normalizeKnowledgeEvent } from "./dockyard-domain/knowledge.js";

export const EXPERIENCE_PLAN_LIMITS = Object.freeze({
  maxCandidates: 5,
  maxConsidered: 500,
  maxEvidenceRefs: 3,
  maxText: 240,
  minOccurrences: 3,
  maxAttempts: 5,
  maxRejected: 10,
});

/** The stored strategy object's discriminator. */
const CONCLUSION_KIND = "cordis-plugin";
/** Verdicts that prove a strategy did not work under the recorded versions. */
const INEFFECTIVE_DECISIONS = new Set(["no-benefit", "regression"]);
/** A candidate needs at least this many occurrences even if the caller lowers it. */
const MIN_OCCURRENCES_FLOOR = 2;
const DAY_MS = 86_400_000;
const MAX_STRATEGY_JSON = 4096;

/**
 * The score is the sum of five bounded terms whose weights sum to 1:
 * frequency (.35), recency (.20), breadth (.15), regression (.15) and
 * evidence (.15). Each term is normalized to 0..1 (see `scoreOf`), and the
 * result is rounded to 4 decimals so the plan compares equal across runs.
 */
const SCORE_WEIGHTS = Object.freeze({
  frequency: 0.35,
  recency: 0.20,
  breadth: 0.15,
  regression: 0.15,
  evidence: 0.15,
});

function text(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function bounded(value, limit = EXPERIENCE_PLAN_LIMITS.maxText) {
  const string = text(value).trim();
  return string.length <= limit ? string : string.slice(0, Math.max(0, limit - 1)) + "…";
}

function integer(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.floor(number);
}

function epoch(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function isoOrNull(value) {
  const parsed = epoch(value);
  return parsed === null || parsed <= 0 ? null : new Date(parsed).toISOString();
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function normalizedStrategyText(value) {
  return text(value).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Stable identity of one (problem, strategy) attempt.
 *
 * The fingerprint is what ties a new conclusion to the strategy a plan proposed
 * earlier, so it must be computable before the experiment exists and independent
 * of how the strategy text was formatted. It is only an identity hint: the
 * verdict itself stays in the knowledge row.
 */
/**
 * The canonical problem identity. A plan returns the store's normalized scope
 * (`tool edge-cache`), while a caller may propose the same problem with its
 * original spelling (`tool:edge-cache`). Both must name one identity, or a
 * strategy recorded as ineffective through the plan could be proposed again
 * under the raw spelling with a different fingerprint.
 */
export function canonicalProblemKey(problemKey) {
  const raw = text(problemKey).trim();
  if (!raw) return "";
  try {
    const event = normalizeKnowledgeEvent({ problem: raw, capabilityId: raw }, { sourceCollection: "experience-plan" });
    return event?.scope || raw;
  } catch {
    return raw;
  }
}

export function strategyFingerprint(problemKey, strategy) {
  const approach = normalizedStrategyText(strategy);
  return createHash("sha256")
    .update(`${CONCLUSION_KIND}\0${canonicalProblemKey(problemKey)}\0${approach}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Parse the `strategy` field of a conclusion record back into its parts.
 * Anything that is not a JSON object carrying `kind: "cordis-plugin"` is an
 * ordinary knowledge strategy, not a conclusion, and returns null.
 */
export function parseConclusionStrategy(value) {
  if (typeof value !== "string" || !value || value.length > MAX_STRATEGY_JSON) return null;
  let parsed;
  try { parsed = JSON.parse(value); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.kind !== CONCLUSION_KIND) return null;
  return {
    approach: text(parsed.approach),
    fingerprint: text(parsed.fingerprint),
    dsh: text(parsed.dsh),
    cordis: text(parsed.cordis),
    evolution: text(parsed.evolution),
  };
}

/** A complete three-version environment, or null when any part is missing. */
function knownVersions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pick = (key) => {
    const version = text(value[key]).trim();
    return version && version.toLowerCase() !== "unknown" ? bounded(version) : "";
  };
  const result = { dsh: pick("dsh"), cordis: pick("cordis"), evolution: pick("evolution") };
  return result.dsh && result.cordis && result.evolution ? result : null;
}

/**
 * `sameApplicability` is true only when both sides name all three versions and
 * they are equal; `unknown` is an absent claim and never equals anything, so a
 * version-less record can never be presented as verified for today's runtime.
 */
function sameApplicabilityOf(recorded, versions) {
  if (!versions || !recorded) return false;
  const values = [recorded.dsh, recorded.cordis, recorded.evolution];
  if (!values.every((value) => typeof value === "string" && value && value.toLowerCase() !== "unknown")) return false;
  return values[0] === versions.dsh && values[1] === versions.cordis && values[2] === versions.evolution;
}

function failureSignals(decision, outcome) {
  return INEFFECTIVE_DECISIONS.has(decision) || outcome === "failure" || outcome === "regression";
}

function emptyGroup(problemKey) {
  return {
    problemKey,
    failures: [],
    resolved: [],
    conclusions: [],
    failureModes: [],
    rootCauses: [],
    evidenceRefs: [],
    seenKnowledgeKeys: new Set(),
    seenMemoryKeys: new Set(),
    knowledgeSum: 0,
    memoryMax: 0,
    regressionCount: 0,
    firstSeen: null,
    lastSeen: null,
    firstEpoch: null,
    lastEpoch: null,
  };
}

function accumulateWindow(group, firstSeen, lastSeen) {
  const firstEpoch = epoch(firstSeen);
  if (firstEpoch !== null && (group.firstEpoch === null || firstEpoch < group.firstEpoch)) {
    group.firstEpoch = firstEpoch;
    group.firstSeen = firstSeen;
  }
  const lastEpoch = epoch(lastSeen);
  if (lastEpoch !== null && (group.lastEpoch === null || lastEpoch > group.lastEpoch)) {
    group.lastEpoch = lastEpoch;
    group.lastSeen = lastSeen;
  }
}

function appendBounded(list, value, limit) {
  if (!value || list.length >= limit || list.includes(value)) return;
  list.push(value);
}

/**
 * The metric shape a candidate proposes to move, chosen from the recorded
 * failure vocabulary. A correctness control is always included: the change must
 * not trade an improvement in one metric for a regression in behaviour.
 */
function acceptanceFor(problemKey, keywords) {
  const textValue = `${keywords}`.toLowerCase();
  let improvement;
  let metrics;
  if (/timeout|latency|slow|延迟|超时/.test(textValue)) {
    improvement = `降低 ${problemKey} 的 latencyMs 并消除超时`;
    metrics = [{ name: "latencyMs", direction: "lower" }];
  } else if (/rate-limit|network|retry|limit|限流|重试/.test(textValue)) {
    improvement = `降低 ${problemKey} 的 retryCount/errorCount`;
    metrics = [{ name: "retryCount", direction: "lower" }, { name: "errorCount", direction: "lower" }];
  } else {
    improvement = `提高 ${problemKey} 的 successRate 并降低 errorCount`;
    metrics = [{ name: "successRate", direction: "higher" }, { name: "errorCount", direction: "lower" }];
  }
  metrics.push({ name: "probeControlStable", direction: "stable" });
  return { improvement, metrics };
}

function whyCordisPlugin(problemKey) {
  // The target is a canonical knowledge scope, so a `tool:` prefix may reach
  // this function normalized to a space (`tool read file`); both forms name the
  // same surface.
  if (/^tool[ :]/.test(problemKey)) {
    return "通过官方 Cordis 工具注册补齐缺失能力，再以隔离 Trial 验证。";
  }
  if (/^agent/i.test(problemKey)) {
    return "通过 agent/pre-step 事件监听或官方工具注册补足该能力。";
  }
  if (/^plugin[ :]/.test(problemKey)) {
    return "通过 Cordis 服务注册或工具扩展该插件的能力面。";
  }
  return "通过官方 Cordis 服务注册补齐该能力。";
}

function rollbackConditionsFor(problemKey) {
  return [
    `任一 acceptance metric 相比基线变差时回滚 ${problemKey} 的变更`,
    "probeControlStable 出现回归时立即回滚",
    "dispose 后运行时恢复校验未通过时回滚并保留现场",
  ].map((line) => bounded(line));
}

function scoreOf({ occurrences, lastEpoch, failureModes, regressionCount, evidenceRefs }, now, minOccurrences) {
  // Frequency: a target that recurs twice the minimum saturates the term.
  const frequency = clamp01(occurrences / (minOccurrences * 2));
  // Recency: 1 today, 0 once the last evidence is 30 days old.
  const days = lastEpoch === null ? 30 : Math.max(0, (now - lastEpoch) / DAY_MS);
  const recency = clamp01(1 - days / 30);
  // Breadth: three distinct failure modes saturate; one mode is a third.
  const breadth = clamp01(failureModes.length / 3);
  // Regression: two recorded regressions saturate.
  const regression = clamp01(regressionCount / 2);
  // Evidence: a citable reference is better than a bare counter.
  const evidence = evidenceRefs.length > 0 ? 1 : 0.5;
  const total = SCORE_WEIGHTS.frequency * frequency
    + SCORE_WEIGHTS.recency * recency
    + SCORE_WEIGHTS.breadth * breadth
    + SCORE_WEIGHTS.regression * regression
    + SCORE_WEIGHTS.evidence * evidence;
  return Math.round(clamp01(total) * 10_000) / 10_000;
}

/**
 * Turn bounded knowledge / failure-memory records into a reviewable plan.
 *
 * `sources.knowledge` and `sources.failureMemory` are the projections the store
 * reads produce (`shared-experience.discover()` / recall records). A record's
 * group target is its `scope` (falling back to `problem`). Rows are classified
 * in this order: a row whose `strategy` parses as a conclusion is an attempt; a
 * row with `failureCount > 0` is a failure; a row with `successCount > 0` is a
 * resolution. Occurrences are summed across distinct knowledge keys and, for
 * the local failure memory, taken as the maximum, because the two sources
 * describe the same execution twice (the max avoids double counting).
 *
 * A target is dropped when a resolution is at least as new as its latest
 * failure, and a target below `minOccurrences` failure evidence is reported in
 * `rejected` with the reason, never silently omitted.
 */
export function planEvolutionCandidates(sources = {}, options = {}) {
  const unavailable = (detail) => ({
    ok: true, candidates: [], selected: null,
    none: { reason: "store-unavailable", considered: 0, detail }, rejected: [],
  });
  if (!sources || typeof sources !== "object" || Array.isArray(sources)) return unavailable("sources missing");
  const knowledgeRows = Array.isArray(sources.knowledge) ? sources.knowledge : null;
  const memoryRows = Array.isArray(sources.failureMemory) ? sources.failureMemory : null;
  if (!knowledgeRows && !memoryRows) return unavailable("no knowledge or failureMemory array");

  const versions = knownVersions(sources.versions);
  const now = Number.isFinite(options?.now) ? Number(options.now) : Date.now();
  const minOccurrences = Math.max(MIN_OCCURRENCES_FLOOR,
    integer(options?.minOccurrences) ?? EXPERIENCE_PLAN_LIMITS.minOccurrences);
  const maxCandidates = Math.max(1, Math.min(EXPERIENCE_PLAN_LIMITS.maxCandidates,
    integer(options?.maxCandidates) ?? EXPERIENCE_PLAN_LIMITS.maxCandidates));

  const groups = new Map();
  let considered = 0;

  const groupFor = (problemKey) => {
    const existing = groups.get(problemKey);
    if (existing) return existing;
    const created = emptyGroup(problemKey);
    groups.set(problemKey, created);
    return created;
  };

  const addRow = (record, fromMemory) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return;
    const target = bounded(text(record.scope)) || bounded(text(record.problem));
    if (!target) return;
    considered += 1;
    const group = groupFor(target);
    const key = text(record.key);
    const conclusions = parseConclusionStrategy(record.strategy);
    const occurrences = Math.max(1, integer(record.occurrences) ?? 1);
    const lastSeen = isoOrNull(record.lastSeen);
    const firstSeen = isoOrNull(record.firstSeen);
    accumulateWindow(group, firstSeen, lastSeen);
    group.regressionCount = Math.max(group.regressionCount,
      Math.max(0, integer(record.regressionCount) ?? 0));
    for (const ref of Array.isArray(record.evidenceRefs) ? record.evidenceRefs : []) {
      appendBounded(group.evidenceRefs, bounded(ref), EXPERIENCE_PLAN_LIMITS.maxEvidenceRefs);
    }
    const decision = bounded(text(record.decision) || text(record.lastStatus), 40);
    const outcome = bounded(text(record.lastOutcome), 40);
    const failureCount = Math.max(0, integer(record.failureCount) ?? 0);
    const successCount = Math.max(0, integer(record.successCount) ?? 0);
    if (conclusions) {
      // One row is one (problem, strategy, versions) accumulator; the same
      // knowledge key must not count twice when a caller hands over two
      // projections of the same row.
      const seen = fromMemory ? group.seenMemoryKeys : group.seenKnowledgeKeys;
      if (key && seen.has(key)) return;
      if (key) seen.add(key);
      const attempt = {
        strategy: bounded(conclusions.approach),
        fingerprint: bounded(conclusions.fingerprint, 32),
        decision,
        outcome,
        at: lastSeen,
        epoch: epoch(lastSeen) ?? 0,
        versions: {
          dsh: bounded(conclusions.dsh, 64),
          cordis: bounded(conclusions.cordis, 64),
          evolution: bounded(conclusions.evolution, 64),
        },
        failureSignal: failureSignals(decision, outcome),
        occurrences,
      };
      group.conclusions.push(attempt);
      if (attempt.failureSignal) {
        if (fromMemory) group.memoryMax = Math.max(group.memoryMax, occurrences);
        else group.knowledgeSum += occurrences;
      }
      return;
    }
    if (failureCount > 0) {
      const seen = fromMemory ? group.seenMemoryKeys : group.seenKnowledgeKeys;
      if (key && seen.has(key)) return;
      if (key) seen.add(key);
      group.failures.push({
        epoch: epoch(lastSeen) ?? 0,
        occurrences,
        failureMode: bounded(text(record.failureMode)),
        rootCause: bounded(text(record.rootCause)),
        lastSeen,
      });
      appendBounded(group.failureModes, bounded(text(record.failureMode)), 3);
      appendBounded(group.rootCauses, bounded(text(record.rootCause)), 3);
      if (fromMemory) group.memoryMax = Math.max(group.memoryMax, occurrences);
      else group.knowledgeSum += occurrences;
      return;
    }
    if (successCount > 0) {
      group.resolved.push({ epoch: epoch(lastSeen) ?? 0, at: lastSeen, outcome: outcome || "success" });
    }
  };

  for (const record of knowledgeRows ?? []) addRow(record, false);
  for (const record of memoryRows ?? []) addRow(record, true);

  const candidates = [];
  const rejected = [];
  let failureGroups = 0;

  for (const group of groups.values()) {
    const failureSignal = group.failures.length > 0
      || group.conclusions.some((attempt) => attempt.failureSignal);
    if (!failureSignal) continue;
    failureGroups += 1;
    const latestFailure = Math.max(
      ...group.failures.map((row) => row.epoch),
      ...group.conclusions.filter((attempt) => attempt.failureSignal).map((attempt) => attempt.epoch),
    );
    const resolution = group.resolved.reduce((best, row) => (best === null || row.epoch > best.epoch ? row : best), null);
    // An adopted conclusion under the *same* applicability is a resolution too:
    // the promotion fact for a normalized problem identity can be absent (the
    // promotion bridge keeps its own target rules), so the structured verdict is
    // the durable record that a candidate for this target already earned
    // adoption. A newer failure after that adoption still reopens the target.
    const adoptedConclusion = group.conclusions
      .filter((attempt) => attempt.decision === "adopted"
        && attempt.epoch >= latestFailure
        && sameApplicabilityOf(attempt.versions, versions))
      .reduce((best, attempt) => (best === null || attempt.epoch > best.epoch ? attempt : best), null);
    // A resolution at or after the latest failure means this target is already
    // handled; retrying it would repeat work the history says is done.
    if ((resolution && resolution.epoch >= latestFailure) || adoptedConclusion) {
      rejected.push({
        problemKey: group.problemKey,
        reason: "already-resolved",
        occurrences: Math.max(group.knowledgeSum, group.memoryMax),
        lastSeen: group.lastSeen,
        detail: "a recorded resolution or adopted conclusion is at least as new as the latest failure",
      });
      continue;
    }
    const occurrences = Math.max(group.knowledgeSum, group.memoryMax);
    if (occurrences < minOccurrences) {
      rejected.push({
        problemKey: group.problemKey,
        reason: "insufficient-evidence",
        occurrences,
        lastSeen: group.lastSeen,
        detail: `occurrences ${occurrences} < ${minOccurrences}`,
      });
      continue;
    }

    const attempts = group.conclusions
      .map((attempt) => ({ ...attempt, sameApplicability: sameApplicabilityOf(attempt.versions, versions) }))
      .sort((left, right) => (right.epoch - left.epoch)
        || (left.fingerprint < right.fingerprint ? -1 : left.fingerprint > right.fingerprint ? 1 : 0));
    const priorAttempts = attempts.slice(0, EXPERIENCE_PLAN_LIMITS.maxAttempts).map((attempt) => ({
      strategy: bounded(attempt.strategy),
      fingerprint: attempt.fingerprint,
      decision: attempt.decision,
      outcome: attempt.outcome,
      applicability: attempt.versions,
      sameApplicability: attempt.sameApplicability,
      at: attempt.at,
    }));
    const provenIneffective = attempts
      .filter((attempt) => attempt.sameApplicability && INEFFECTIVE_DECISIONS.has(attempt.decision))
      .slice(0, EXPERIENCE_PLAN_LIMITS.maxAttempts)
      .map((attempt) => ({
        strategy: bounded(attempt.strategy),
        fingerprint: attempt.fingerprint,
        decision: attempt.decision,
        at: attempt.at,
      }));
    const failureModes = group.failureModes.slice(0, 3);
    const regressionCount = group.regressionCount;
    const evidenceRefs = group.evidenceRefs.slice(0, EXPERIENCE_PLAN_LIMITS.maxEvidenceRefs);
    const { improvement, metrics } = acceptanceFor(group.problemKey,
      [...failureModes, ...group.rootCauses].join(" "));
    const highRisk = /(core|host|loader|registry|composition|node_modules)/i.test(group.problemKey);
    candidates.push({
      problemKey: group.problemKey,
      problem: group.problemKey,
      occurrences,
      failureModes,
      regressionCount,
      firstSeen: group.firstSeen,
      lastSeen: group.lastSeen,
      evidenceRefs,
      priorAttempts,
      provenIneffective,
      knownResolution: resolution ? { at: resolution.at, outcome: bounded(resolution.outcome, 40) } : null,
      applicability: versions ? { ...versions } : null,
      applicabilityVerified: Boolean(versions),
      requiresNewHypothesis: provenIneffective.length > 0,
      risk: highRisk ? "high" : attempts.length > 0 ? "medium" : "low",
      whyCordisPlugin: whyCordisPlugin(group.problemKey),
      expectedImprovement: bounded(`${improvement}；probeControlStable 对照不得回归。`),
      acceptanceMetrics: metrics,
      rollbackConditions: rollbackConditionsFor(group.problemKey),
      score: scoreOf({
        occurrences,
        lastEpoch: group.lastEpoch,
        failureModes,
        regressionCount,
        evidenceRefs,
      }, now, minOccurrences),
    });
  }

  candidates.sort((left, right) => (right.score - left.score)
    || (right.occurrences - left.occurrences)
    || ((epoch(right.lastSeen) ?? 0) - (epoch(left.lastSeen) ?? 0))
    || (left.problemKey < right.problemKey ? -1 : left.problemKey > right.problemKey ? 1 : 0));
  rejected.sort((left, right) => (left.problemKey < right.problemKey ? -1 : left.problemKey > right.problemKey ? 1 : 0));

  // A focus narrows the ordered candidate set *before* the output cap, so a
  // matching target outside the top `maxCandidates` is still reachable. The cap
  // keeps bounding what the caller pays for; it must not decide relevance.
  const focus = text(options?.focus).trim().toLowerCase();
  const focusTokens = focus ? focus.split(/[^a-z0-9\u3400-\u9fff]+/u).filter((token) => token.length > 1) : [];
  const visible = focusTokens.length === 0 ? candidates : candidates.filter((candidate) => {
    const haystack = [candidate.problemKey, candidate.problem, ...(candidate.failureModes || [])].join(" ").toLowerCase();
    return focusTokens.every((token) => haystack.includes(token));
  });
  const boundedCandidates = visible.slice(0, maxCandidates);
  let none = null;
  if (boundedCandidates.length === 0) {
    let reason;
    if (failureGroups === 0) reason = "no-failure-signal";
    else if (rejected.length > 0 && rejected.every((entry) => entry.reason === "already-resolved")) reason = "already-resolved";
    else reason = "insufficient-evidence";
    none = {
      reason,
      considered,
      detail: focus && candidates.length > 0
        ? `no evidence-ranked candidate matched focus "${bounded(focus, 80)}" across ${considered} considered records`
        : reason === "no-failure-signal"
          ? `no failure signal in ${considered} considered records`
          : reason === "already-resolved"
            ? "every recurring failure target already has a newer recorded resolution"
            : `no target reached the evidence threshold across ${considered} considered records`,
    };
  }
  return {
    ok: true,
    candidates: boundedCandidates,
    selected: boundedCandidates[0] ?? null,
    none,
    rejected: rejected.slice(0, EXPERIENCE_PLAN_LIMITS.maxRejected),
  };
}
