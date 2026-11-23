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
// Below this many attempts an observed failure rate is too noisy to replace the
// all-time frequency signal. The rate is a bounded in-process window, never a
// lifetime total; see `rateBasis` on each candidate.
const MIN_RATE_SAMPLES = 5;
// Recovery tools are projected from bounded knowledge records; a free-text
// value is not a tool name and must not justify a hook recommendation.
const RECOVERY_TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/;
const DAY_MS = 86_400_000;
const MAX_STRATEGY_JSON = 4096;

/**
 * The score is the sum of five bounded terms whose weights sum to 1:
 * frequency (.35), recency (.20), breadth (.15), regression (.15) and
 * evidence (.15). Each term is normalized to 0..1 (see `scoreOf`), and the
 * result is rounded to 4 decimals so the plan compares equal across runs.
 * When a real observed window exists, "frequency" is the failure rate inside
 * that window instead of the all-time count: a tool called thousands of times
 * that now fails once is not a better target than one that fails on every
 * observed attempt. Records without a window keep the historical formula.
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
    degradations: [],
    resolved: [],
    conclusions: [],
    failureModes: [],
    degradationModes: [],
    // Classification input, separate from the bounded output lists above: a
    // target can carry more than three distinct modes, and dropping the fourth
    // before classifying it is what made a single caller-input mode hide a
    // code-run failure. Counts cover every mode (no list cap); the few mode
    // strings kept for display are bounded separately.
    failureOriginCounts: new Map(),
    // Occurrence/attempt sums per origin, kept apart for knowledge rows (sum)
    // and memory rows (max) so a mixed target's floor, frequency and score use
    // only the actionable failures while caller input stays in excludedModes.
    failureOriginKnowledge: new Map(),
    failureOriginMemoryMax: new Map(),
    failureOriginAttempts: new Map(),
    failureOriginSuccesses: new Map(),
    failureOriginLastEpoch: new Map(),
    failureOriginLastSeen: new Map(),
    failureOriginRegression: new Map(),
    failureOriginEvidenceRefs: new Map(),
    failureOriginRootCauses: new Map(),
    failureActionableModes: [],
    callerModes: [],
    rootCauses: [],
    evidenceRefs: [],
    seenKnowledgeKeys: new Set(),
    seenMemoryKeys: new Set(),
    knowledgeSum: 0,
    memoryMax: 0,
    lossSum: 0,
    lossRecoveryCalls: 0,
    lossRecoveryTools: [],
    observedAttempts: 0,
    observedSuccesses: 0,
    regressionCount: 0,
    firstSeen: null,
    lastSeen: null,
    firstEpoch: null,
    lastEpoch: null,
  };
}

/** The observed denominator a failure row carries, if any. */
function metricSum(record, name) {
  const stat = record?.metrics && typeof record.metrics === "object" ? record.metrics[name] : null;
  const value = Number(stat?.sum);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * Which side a failure can be fixed on. `caller-input` failures are the caller's
 * own bad arguments or drifted edit context; `host` ones come from a host guard;
 * only `tool`/`unknown` are Evolution candidates. The classification uses the
 * normalized failure modes the stored semantic fact carries.
 */
function failureOrigin(modes) {
  const textValue = (Array.isArray(modes) ? modes : []).join(" ").toLowerCase();
  if (/guard|trust root|denied|refused/.test(textValue)) return "host";
  // A call to a tool that is not installed is a capability gap, not a caller
  // mistake: the workflow asked for an operation the system did not provide.
  if (/unknown tool|not registered|missing capability|not installed/.test(textValue)) return "capability-gap";
  if (/invalid args|patch mismatch|edit missing|edit not found|not found|missing|stale revision|lead required/.test(textValue)) return "caller-input";
  if (/timeout|aborted|busy|unavailable|rate limit|rate-limit/.test(textValue)) return "environment";
  return "unknown";
}

/** The failure mode a stored failure row already carries.
 *
 *  `recordFailure` keeps the pre-2026-11-17 event shape, so no separate
 *  `failureMode` survives storage; the host code reaches the row through its
 *  message, which the domain projects as `semanticFact`
 *  (`official operation failure code run failure`). The generic placeholder
 *  names no cause and is deliberately not a mode.
 */
const FAILURE_FACT_RE = /^official operation failure (.+)$/;
function derivedFailureMode(semanticFact) {
  const fact = text(semanticFact).trim().toLowerCase();
  const match = FAILURE_FACT_RE.exec(fact);
  if (!match) return "";
  const detail = match[1].trim();
  if (!detail || detail === "host operation failure") return "";
  return bounded(detail, 80);
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
 * Record one mode for origin classification. Counts are unbounded by mode
 * identity (a bounded number of host failure codes), while only the first few
 * actionable/caller strings are kept for output. This is what keeps a 25th
 * actionable mode from being dropped by an output-list cap. The occurrence and
 * attempt sums let a mixed target use only its actionable failures.
 */
function trackOriginMode(group, mode, { occurrences = 0, attempts = 0, successes = 0, fromMemory = false,
  epochValue = 0, lastSeen = null, regression = 0, evidenceRefs = [], rootCause = "" } = {}) {
  if (!mode && !rootCause) return;
  // A failure row with only a rootCause names a cause without a mode; it is an
  // actionable, unclassified failure, not caller input.
  const origin = mode ? failureOrigin([mode]) : "unknown";
  group.failureOriginCounts.set(origin, (group.failureOriginCounts.get(origin) ?? 0) + 1);
  const count = Math.max(0, Number(occurrences) || 0);
  if (fromMemory) group.failureOriginMemoryMax.set(origin, Math.max(group.failureOriginMemoryMax.get(origin) ?? 0, count));
  else group.failureOriginKnowledge.set(origin, (group.failureOriginKnowledge.get(origin) ?? 0) + count);
  group.failureOriginAttempts.set(origin, (group.failureOriginAttempts.get(origin) ?? 0) + Math.max(0, Number(attempts) || 0));
  group.failureOriginSuccesses.set(origin, (group.failureOriginSuccesses.get(origin) ?? 0) + Math.max(0, Number(successes) || 0));
  if (epochValue > (group.failureOriginLastEpoch.get(origin) ?? -Infinity)) {
    group.failureOriginLastEpoch.set(origin, epochValue);
    if (lastSeen) group.failureOriginLastSeen.set(origin, lastSeen);
  }
  group.failureOriginRegression.set(origin, Math.max(group.failureOriginRegression.get(origin) ?? 0, Math.max(0, Number(regression) || 0)));
  const refs = group.failureOriginEvidenceRefs.get(origin) ?? [];
  for (const ref of Array.isArray(evidenceRefs) ? evidenceRefs : []) appendBounded(refs, ref, EXPERIENCE_PLAN_LIMITS.maxEvidenceRefs);
  if (refs.length > 0) group.failureOriginEvidenceRefs.set(origin, refs);
  if (rootCause) {
    const causes = group.failureOriginRootCauses.get(origin) ?? [];
    appendBounded(causes, rootCause, 3);
    if (causes.length > 0) group.failureOriginRootCauses.set(origin, causes);
  }
  if (mode) appendBounded(origin === "caller-input" ? group.callerModes : group.failureActionableModes, mode, 3);
}

/** The existing origin precedence, applied to a set of per-mode results. */
const ORIGIN_PRIORITY = Object.freeze(["host", "capability-gap", "environment", "unknown"]);
function preferredOrigin(origins) {
  for (const origin of ORIGIN_PRIORITY) if (origins.includes(origin)) return origin;
  return "unknown";
}

/**
 * Per-loss-kind projection of the recorded degradations.
 *
 * A tool target can carry several distinct losses (`read` both truncates a long
 * line and caps a long output). The merged `kinds` array says which losses were
 * seen but not how much each one costs, so a capability that already handles one
 * kind cannot be told apart from the one still happening. This projection keeps
 * each kind's own occurrence count, recovery cost and observed recovery tools;
 * it is bounded like every other returned list and never invents a kind.
 */
function lossBreakdownOf(rows) {
  const byKind = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const entry = byKind.get(row.kind) ?? {
      kind: row.kind,
      occurrences: 0,
      recoveryCalls: 0,
      recoveryTools: [],
      firstSeen: null,
      lastSeen: null,
    };
    entry.occurrences += Math.max(0, Number(row.occurrences) || 0);
    entry.recoveryCalls += Math.max(0, Number(row.recoveryCalls) || 0);
    appendBounded(entry.recoveryTools, row.recoveryTool, 3);
    // An older row may carry only `lastSeen`; that is still the best lower
    // bound for this kind, never a synthesized current time.
    const rowFirst = epoch(row.firstSeen) ?? epoch(row.lastSeen);
    if (rowFirst !== null && (entry.firstSeen === null || rowFirst < epoch(entry.firstSeen))) {
      entry.firstSeen = row.firstSeen ?? row.lastSeen;
    }
    const rowLast = epoch(row.lastSeen);
    if (rowLast !== null && (entry.lastSeen === null || rowLast > epoch(entry.lastSeen))) entry.lastSeen = row.lastSeen;
    byKind.set(row.kind, entry);
  }
  return [...byKind.values()]
    .sort((left, right) => (right.occurrences - left.occurrences)
      || (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0))
    .slice(0, 3);
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

/**
 * Which *form* an evidence-backed candidate should take. This is a decision,
 * not a description: a loss that the model already recovers from by calling
 * another tool is a bad target for a new tool (the model has to choose it),
 * but a good target for a policy on the official hook that transforms the
 * existing result. A missing capability has no observed recovery path, so it
 * stays a tool-form candidate. The shape carries the observed baseline so a
 * caller can verify against the path the workflow actually took.
 */
function shapeFor(loss, declaresWorkflow) {
  // `recoveryCalls` is cumulative across observations while the knowledge row
  // carries only its recorded recovery tool(s). Never describe the total as if
  // one recorded tool performed all of those calls.
  const recoveryTools = (loss?.recoveryTools ?? []).slice(0, 3).filter((tool) => RECOVERY_TOOL_NAME.test(tool));
  const verificationKind = declaresWorkflow ? "paired-real-session" : "capability-probe";
  if (loss && declaresWorkflow && loss.recoverable && recoveryTools.length > 0) {
    return {
      improvement: "context-policy",
      hook: "tools/post-execute",
      baselinePath: {
        kind: "observed-recovery",
        lossKinds: loss.kinds.slice(0, 3),
        recoveryTools,
        recoveryCalls: loss.recoveryCalls,
        recoveryCallsBasis: "cumulative",
        recoveryToolBasis: "recorded",
      },
      verificationKind,
      improvementReason: bounded(`已观测到 ${loss.kinds.join("/")} 退化，累计恢复调用 ${loss.recoveryCalls} 次，记录到的恢复工具：${recoveryTools.join("/")}；新工具要求模型主动选择，改由官方 tools/post-execute 变换既有结果，并以成对真实会话验证。`),
    };
  }
  return {
    improvement: "tool",
    hook: null,
    baselinePath: null,
    verificationKind,
    improvementReason: bounded(loss
      ? "退化证据未声明工作流收益或恢复工具不可用于该钩子；保留工具形态，并按现有门禁验证。"
      : "未观测到可替代的恢复路径；通过官方工具注册补齐能力，并以隔离 Trial 验证。"),
  };
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

function scoreOf({ occurrences, lastEpoch, failureModes, regressionCount, evidenceRefs,
  observedAttempts, observedFailureRate, rateBasis }, now, minOccurrences) {
  // Frequency: a target that recurs twice the minimum saturates the term. With
  // a trustworthy observed window, the share of attempts that failed is the
  // better signal — all-time counts cannot tell a still-broken tool from one
  // that was fixed long ago and is now called constantly.
  const countedFrequency = clamp01(occurrences / (minOccurrences * 2));
  const usableRate = rateBasis === "observed-window"
    && Number.isInteger(observedAttempts) && observedAttempts >= MIN_RATE_SAMPLES
    && typeof observedFailureRate === "number" && observedFailureRate >= 0 && observedFailureRate <= 1;
  const frequency = usableRate ? clamp01(observedFailureRate) : countedFrequency;
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
 * A non-error degradation is scored on its observed loss, not on errors:
 * frequency and recency still matter, and the two new terms are the measured
 * recovery cost (calls spent after the degraded result) and whether a recovery
 * path was observed at all. The weights sum to 1 and every term is bounded, so
 * this score is deterministic like the historical one. It is only used for a
 * group that has degradation evidence; records without it keep their previous
 * score byte for byte.
 */
const DEGRADATION_SCORE_WEIGHTS = Object.freeze({
  frequency: 0.45,
  recency: 0.15,
  cost: 0.20,
  recoverability: 0.10,
  evidence: 0.10,
});

function degradationScoreOf({ occurrences, lastEpoch, recoveryCalls, evidenceRefs }, now, minOccurrences) {
  const frequency = clamp01(occurrences / (minOccurrences * 2));
  const days = lastEpoch === null ? 30 : Math.max(0, (now - lastEpoch) / DAY_MS);
  const recency = clamp01(1 - days / 30);
  const averageCalls = occurrences > 0 ? recoveryCalls / occurrences : 0;
  const cost = clamp01(averageCalls / 3);
  const recoverability = recoveryCalls > 0 ? 1 : 0.5;
  const evidence = evidenceRefs.length > 0 ? 1 : 0.5;
  const total = DEGRADATION_SCORE_WEIGHTS.frequency * frequency
    + DEGRADATION_SCORE_WEIGHTS.recency * recency
    + DEGRADATION_SCORE_WEIGHTS.cost * cost
    + DEGRADATION_SCORE_WEIGHTS.recoverability * recoverability
    + DEGRADATION_SCORE_WEIGHTS.evidence * evidence;
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
    const decision = bounded(text(record.decision) || text(record.lastStatus), 40);
    const outcome = bounded(text(record.lastOutcome), 40);
    // A degradation row is neither a failure nor a resolution. It carries a
    // neutral outcome plus the observed recovery call, so treating it as a
    // failure would corrupt the denominator and treating it as a success would
    // hide the loss.
    if (bounded(text(record.issueType)).toLowerCase() === "tool degradation") {
      const seen = fromMemory ? group.seenMemoryKeys : group.seenKnowledgeKeys;
      if (key && seen.has(key)) return;
      if (key) seen.add(key);
      const lossOccurrences = Math.max(1, integer(record.occurrences) ?? 1);
      const kind = bounded(text(record.failureMode) || "degradation", 80);
      const recoveryCalls = metricSum(record, "recoverycalls");
      // The writer marks an observed recovery with a `tool:` reason and an
      // `observed` status. A failed/unknown status or a free-text reason is
      // not a recovery tool, even when it has the shape of a word.
      const recoveryStatus = bounded(text(record.recoveryStatus), 40).toLowerCase();
      const rawRecoveryTool = text(record.recoveryTool);
      const recoveryTool = (!recoveryStatus || recoveryStatus === "observed")
        && /^tool:[A-Za-z_][A-Za-z0-9_.-]{0,79}$/.test(rawRecoveryTool)
        ? bounded(rawRecoveryTool.slice(5), 80) : "";
      const lossRefs = (Array.isArray(record.evidenceRefs) ? record.evidenceRefs : [])
        .map((ref) => bounded(ref)).filter(Boolean).slice(0, EXPERIENCE_PLAN_LIMITS.maxEvidenceRefs);
      const lossRegression = Math.max(0, integer(record.regressionCount) ?? 0);
      group.degradations.push({ epoch: epoch(lastSeen) ?? 0, occurrences: lossOccurrences, kind, recoveryCalls, recoveryTool, firstSeen, lastSeen, evidenceRefs: lossRefs, regressionCount: lossRegression });
      group.lossSum += lossOccurrences;
      group.lossRecoveryCalls += recoveryCalls;
      appendBounded(group.degradationModes, kind, 3);
      appendBounded(group.lossRecoveryTools, recoveryTool, 3);
      return;
    }
    accumulateWindow(group, firstSeen, lastSeen);
    group.regressionCount = Math.max(group.regressionCount,
      Math.max(0, integer(record.regressionCount) ?? 0));
    for (const ref of Array.isArray(record.evidenceRefs) ? record.evidenceRefs : []) {
      appendBounded(group.evidenceRefs, bounded(ref), EXPERIENCE_PLAN_LIMITS.maxEvidenceRefs);
    }
    // `problem` is the stored semantic fact when `scope` carries the target.
    const recordedMode = bounded(text(record.failureMode)) || derivedFailureMode(record.problem);
    const rowAttempts = metricSum(record, "attemptssincefailure");
    const rowSuccesses = metricSum(record, "successessincefailure");
    const failureCount = Math.max(0, integer(record.failureCount) ?? 0);
    const successCount = Math.max(0, integer(record.successCount) ?? 0);
    if (conclusions) {
      // One row is one (problem, strategy, versions) accumulator; the same
      // knowledge key must not count twice when a caller hands over two
      // projections of the same row.
      const seen = fromMemory ? group.seenMemoryKeys : group.seenKnowledgeKeys;
      if (key && seen.has(key)) return;
      if (key) seen.add(key);
      group.observedAttempts += rowAttempts;
      group.observedSuccesses += rowSuccesses;
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
      // A conclusion records the cause the owner or the experiment already
      // identified. Without this, a target whose only evidence is a structured
      // conclusion (rootCause set, no failure row) looked unattributed and was
      // rejected even though the cause was recorded.
      appendBounded(group.failureModes, recordedMode, 3);
      trackOriginMode(group, recordedMode, {
        occurrences: attempt.failureSignal ? occurrences : 0,
        attempts: rowAttempts,
        successes: rowSuccesses,
        fromMemory,
        epochValue: attempt.failureSignal ? attempt.epoch : 0,
        lastSeen: attempt.failureSignal ? lastSeen : null,
        regression: attempt.failureSignal ? Math.max(0, integer(record.regressionCount) ?? 0) : 0,
        evidenceRefs: attempt.failureSignal
          ? (Array.isArray(record.evidenceRefs) ? record.evidenceRefs : []).map((ref) => bounded(ref)).filter(Boolean)
          : [],
        rootCause: attempt.failureSignal ? bounded(text(record.rootCause)) : "",
      });
      appendBounded(group.rootCauses, bounded(text(record.rootCause)), 3);
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
      group.observedAttempts += rowAttempts;
      group.observedSuccesses += rowSuccesses;
      group.failures.push({
        epoch: epoch(lastSeen) ?? 0,
        occurrences,
        failureMode: recordedMode,
        rootCause: bounded(text(record.rootCause)),
        lastSeen,
      });
      appendBounded(group.failureModes, recordedMode, 3);
      trackOriginMode(group, recordedMode, {
        occurrences,
        attempts: rowAttempts,
        successes: rowSuccesses,
        fromMemory,
        epochValue: epoch(lastSeen) ?? 0,
        lastSeen,
        regression: Math.max(0, integer(record.regressionCount) ?? 0),
        evidenceRefs: (Array.isArray(record.evidenceRefs) ? record.evidenceRefs : []).map((ref) => bounded(ref)).filter(Boolean),
        rootCause: bounded(text(record.rootCause)),
      });
      appendBounded(group.rootCauses, bounded(text(record.rootCause)), 3);
      if (fromMemory) group.memoryMax = Math.max(group.memoryMax, occurrences);
      else group.knowledgeSum += occurrences;
      return;
    }
    if (successCount > 0) {
      group.observedAttempts += rowAttempts;
      group.observedSuccesses += rowSuccesses;
      group.resolved.push({ epoch: epoch(lastSeen) ?? 0, at: lastSeen, outcome: outcome || "success" });
    }
  };

  for (const record of knowledgeRows ?? []) addRow(record, false);
  for (const record of memoryRows ?? []) addRow(record, true);

  // A loss below the floor may not refresh a group's recency or reopen a
  // resolved error target; only a qualifying degradation contributes its time.
  for (const group of groups.values()) {
    if (group.lossSum >= minOccurrences) {
      for (const row of group.degradations) {
        accumulateWindow(group, row.firstSeen, row.lastSeen);
        group.regressionCount = Math.max(group.regressionCount, row.regressionCount);
        for (const ref of row.evidenceRefs) appendBounded(group.evidenceRefs, ref, EXPERIENCE_PLAN_LIMITS.maxEvidenceRefs);
      }
    }
  }

  const candidates = [];
  const rejected = [];
  let failureGroups = 0;

  for (const group of groups.values()) {
    const failureSignal = group.failures.length > 0
      || group.degradations.length > 0
      || group.conclusions.some((attempt) => attempt.failureSignal);
    if (!failureSignal) continue;
    failureGroups += 1;
    const lossQualifies = group.degradations.length > 0 && group.lossSum >= minOccurrences;
    // Classify before reopening/resolving: a newer caller-input failure must not
    // reopen an actionable target that is already resolved, and scoring must use
    // only the actionable evidence. Degradations are actionable losses.
    const failureOrigins = [...group.failureOriginCounts.keys()];
    const actionableOrigins = failureOrigins.filter((origin) => origin !== "caller-input");
    const mixedCaller = failureOrigins.includes("caller-input") && (actionableOrigins.length > 0 || lossQualifies);
    const lossLatest = lossQualifies
      ? group.degradations.reduce((best, row) => (best === null || row.epoch > best.epoch ? row : best), null)
      : null;
    const actionableLastEpoch = Math.max(0, ...actionableOrigins.map((origin) => group.failureOriginLastEpoch.get(origin) ?? 0));
    const latestFailure = mixedCaller
      ? Math.max(actionableLastEpoch, lossLatest?.epoch ?? 0)
      : Math.max(
        ...group.failures.map((row) => row.epoch),
        ...(lossQualifies ? group.degradations.map((row) => row.epoch) : []),
        ...group.conclusions.filter((attempt) => attempt.failureSignal).map((attempt) => attempt.epoch),
      );
    // The candidate's recency is the actionable failure/loss time. Caller-input
    // timestamps stay out of both the reopen comparison and the score.
    const actionableLastSeen = actionableOrigins
      .map((origin) => ({ epoch: group.failureOriginLastEpoch.get(origin) ?? 0, seen: group.failureOriginLastSeen.get(origin) }))
      .filter((row) => row.seen)
      .reduce((best, row) => (best === null || row.epoch > best.epoch ? row : best), null);
    const lastSeen = mixedCaller
      ? ((actionableLastSeen?.epoch ?? -1) >= (lossLatest?.epoch ?? -1)
        ? (actionableLastSeen?.seen ?? null)
        : (lossLatest?.lastSeen ?? null))
      : group.lastSeen;
    const lastEpoch = mixedCaller ? Math.max(actionableLastEpoch, lossLatest?.epoch ?? 0) : group.lastEpoch;
    // A mixed target may be selected on its actionable failures only: 100
    // caller-input failures must not lift one code-run failure over the floor.
    // Caller modes stay visible in `excludedModes`; per-origin sums keep the
    // knowledge-sum / memory-max shapes the existing floor used.
    const callerKnowledge = group.failureOriginKnowledge.get("caller-input") ?? 0;
    const actionableKnowledge = Math.max(0, group.knowledgeSum - callerKnowledge);
    const actionableMemory = Math.max(0, ...[...group.failureOriginMemoryMax]
      .filter(([origin]) => origin !== "caller-input").map(([, value]) => value));
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
    // A mixed target may be selected on its actionable failures only: 100
    // caller-input failures must not lift one code-run failure over the floor.
    const occurrences = mixedCaller
      ? Math.max(actionableKnowledge, actionableMemory, lossQualifies ? group.lossSum : 0)
      : Math.max(group.knowledgeSum, group.memoryMax, group.lossSum);
    // A resolution at or after the latest failure means this target is already
    // handled; retrying it would repeat work the history says is done.
    if ((resolution && resolution.epoch >= latestFailure) || adoptedConclusion) {
      rejected.push({
        problemKey: group.problemKey,
        reason: "already-resolved",
        occurrences,
        lastSeen,
        detail: "a recorded resolution or adopted conclusion is at least as new as the latest failure",
      });
      continue;
    }
    if (occurrences < minOccurrences) {
      rejected.push({
        problemKey: group.problemKey,
        reason: "insufficient-evidence",
        occurrences,
        lastSeen,
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
    // One bounded selection feeds both `kinds` and `breakdown`, so the two
    // lists cannot disagree when a target carries more than three loss kinds.
    const lossBreakdown = lossQualifies ? lossBreakdownOf(group.degradations) : [];
    const lossKinds = lossBreakdown.map((row) => row.kind);
    const loss = lossQualifies ? {
      kinds: lossKinds,
      occurrences: group.lossSum,
      recoveryCalls: group.lossRecoveryCalls,
      averageRecoveryCalls: group.lossSum > 0 ? Math.round((group.lossRecoveryCalls / group.lossSum) * 100) / 100 : 0,
      recoveryTools: group.lossRecoveryTools.slice(0, 3),
      recoverable: group.lossRecoveryCalls > 0,
      // Each kind keeps its own evidence. A merged target can contain a loss an
      // installed capability already handles and a different one that is still
      // happening; without this projection the next proposal cannot tell which
      // kind it is being asked to solve.
      breakdown: lossBreakdown,
    } : null;
    // Only a degradation that reaches the floor may change a candidate's
    // attribution or score; a below-threshold loss must not lend a workflow
    // model to an otherwise unattributed error counter.
    const failureModes = [...new Set([...(lossQualifies ? group.degradationModes : []), ...group.failureModes])].slice(0, 3);
    const rootCauses = (mixedCaller
      ? [...new Set(actionableOrigins.flatMap((origin) => group.failureOriginRootCauses.get(origin) ?? []))]
      : group.rootCauses).slice(0, 3);
    // Classify against every collected mode. The counts are not capped by mode
    // identity, so a caller-input mode followed by a 25th actionable mode still
    // cannot discard the whole target.
    const classifiedModes = [...group.failureOriginCounts.values()]
      .reduce((total, count) => total + count, 0);
    const allCallerInput = loss === null && classifiedModes > 0 && actionableOrigins.length === 0;
    // A caller-input failure is not a defect Evolution can fix: the arguments or
    // the edit context were wrong, and a new tool cannot change that.
    if (allCallerInput) {
      rejected.push({
        problemKey: group.problemKey,
        reason: "caller-input",
        occurrences,
        lastSeen: group.lastSeen,
        detail: "the recorded failure modes are caller input (arguments, edit context or unknown tool), not a capability gap",
      });
      continue;
    }
    // Merge the already-computed per-mode origins with the existing precedence;
    // this cannot match across a mode boundary and does not depend on record
    // order.
    const origin = loss !== null ? "unknown" : preferredOrigin(actionableOrigins);
    const excludedModes = mixedCaller ? group.callerModes.slice(0, 3) : [];
    const actionableOutputModes = group.failureActionableModes;
    const describedModes = mixedCaller
      ? [...new Set([
        ...(lossQualifies ? group.degradationModes : []),
        ...actionableOutputModes,
      ])].slice(0, 3)
      : failureModes;
    // A bare tool-name counter names no cause, so a candidate built only from it
    // cannot be verified against the failure it claims to fix. Such a target is
    // still surfaced (the owner can see it and repair the signal) but it is
    // labelled unattributed, is reported as such, and never declares
    // the workflow benefit model the promotion gate requires; an attributed
    // target does.
    const attributed = describedModes.length > 0 || rootCauses.length > 0;
    // A mixed target's frequency uses only the actionable failures' observed
    // window; caller-input attempts stay out of the denominator.
    const callerAttempts = group.failureOriginAttempts.get("caller-input") ?? 0;
    const callerSuccesses = group.failureOriginSuccesses.get("caller-input") ?? 0;
    const observedAttempts = mixedCaller ? Math.max(0, group.observedAttempts - callerAttempts) : group.observedAttempts;
    // The denominator counts attempts inside the observed window; `occurrences`
    // is the all-time failure count and must not be mixed into that window.
    const observedSuccesses = Math.max(0, Math.min(
      mixedCaller ? Math.max(0, group.observedSuccesses - callerSuccesses) : group.observedSuccesses,
      observedAttempts,
    ));
    const observedFailures = Math.max(0, observedAttempts - observedSuccesses);
    const rateBasis = observedAttempts > 0 ? "observed-window" : "failure-count-only";
    const observedFailureRate = observedAttempts > 0
      ? Math.round((observedFailures / observedAttempts) * 10_000) / 10_000 : null;
    const regressionCount = mixedCaller
      ? Math.max(0, ...actionableOrigins.map((origin) => group.failureOriginRegression.get(origin) ?? 0),
        ...(lossQualifies ? group.degradations.map((row) => row.regressionCount) : []))
      : group.regressionCount;
    const evidenceRefs = mixedCaller
      ? [...new Set([
        ...actionableOrigins.flatMap((origin) => group.failureOriginEvidenceRefs.get(origin) ?? []),
        ...(lossQualifies ? group.degradations.flatMap((row) => row.evidenceRefs) : []),
      ])].slice(0, EXPERIENCE_PLAN_LIMITS.maxEvidenceRefs)
      : group.evidenceRefs.slice(0, EXPERIENCE_PLAN_LIMITS.maxEvidenceRefs);
    const acceptance = loss === null
      ? acceptanceFor(group.problemKey, [...describedModes, ...rootCauses].join(" "))
      : {
        improvement: `减少 ${group.problemKey} 的 ${lossKinds.join("/")} 退化，降低恢复调用与轮次`,
        metrics: [
          { name: "turns", direction: "lower" },
          { name: "toolCalls", direction: "lower" },
          { name: "recoveryCalls", direction: "lower" },
          { name: "probeControlStable", direction: "stable" },
        ],
      };
    const { improvement, metrics } = acceptance;
    // Compute the durable declaration first: a context-policy candidate has no
    // capability to self-test, so it may only be recommended when the existing
    // benefit declaration already requires paired real-session evidence.
    const declaresWorkflow = /^tool[ :]/.test(group.problemKey) && attributed && origin !== "host";
    const benefitModel = declaresWorkflow ? { kind: "workflow", metric: "failureRate" } : null;
    const shape = shapeFor(loss, declaresWorkflow);
    const highRisk = /(core|host|loader|registry|composition|node_modules)/i.test(group.problemKey);
    candidates.push({
      problemKey: group.problemKey,
      problem: group.problemKey,
      occurrences,
      failureModes: describedModes,
      attribution: attributed ? "classified" : "unattributed",
      origin,
      ...(excludedModes.length > 0 ? { excludedModes, mixedOrigin: true } : {}),
      observedAttempts,
      observedSuccesses,
      observedFailureRate,
      rateBasis,
      loss,
      ...shape,
      // A tool-failure target claims to fix a workflow failure, so a capability
      // self-test cannot prove it. The experiment must carry this model for the
      // promotion gate to require a workflow before/after.
      ...(benefitModel ? { benefitModel } : {}),
      regressionCount,
      firstSeen: group.firstSeen,
      lastSeen,
      evidenceRefs,
      priorAttempts,
      provenIneffective,
      knownResolution: resolution ? { at: resolution.at, outcome: bounded(resolution.outcome, 40) } : null,
      applicability: versions ? { ...versions } : null,
      applicabilityVerified: Boolean(versions),
      requiresNewHypothesis: provenIneffective.length > 0,
      risk: highRisk ? "high" : attempts.length > 0 ? "medium" : "low",
      whyCordisPlugin: loss === null
        ? whyCordisPlugin(group.problemKey)
        : shape.improvement === "context-policy"
          ? "通过官方 tools/post-execute 改造既有执行路径，并以成对真实会话证据验证。"
          : "通过官方 Cordis 工具注册补齐能力，并以隔离 Trial 与现有门禁验证。",
      expectedImprovement: bounded(`${improvement}；probeControlStable 对照不得回归。`),
      acceptanceMetrics: metrics,
      rollbackConditions: rollbackConditionsFor(group.problemKey),
      score: loss === null
        ? scoreOf({
          occurrences,
          lastEpoch,
          failureModes: describedModes,
          regressionCount,
          evidenceRefs,
          observedAttempts,
          observedFailureRate,
          rateBasis,
        }, now, minOccurrences)
        : degradationScoreOf({
          occurrences: group.lossSum,
          lastEpoch,
          recoveryCalls: group.lossRecoveryCalls,
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
