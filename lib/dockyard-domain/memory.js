// Extracted domain algorithms; no legacy runtime imports. See domain-extraction-report.md.
import { createHash, randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { ValidationError } from "./errors.js";
import { normalizeComponentDefinition } from "./manifest.js";
import { canonicalKnowledgeKey, isDuplicateKnowledgeEvent, isKnowledgeCritical, mergeKnowledgeEntry, normalizeKnowledgeEvent, sourceEventReference, sourceRetentionLimit } from "./knowledge.js";
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

function stableMemoryValue(value) {
  if (Array.isArray(value)) return value.map(stableMemoryValue);
  if (!value || typeof value !== "object") return value === undefined ? null : value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableMemoryValue(value[key])]));
}

function memoryStateFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(stableMemoryValue(value ?? {}))).digest("hex");
}

function readonlyProjection(value, label = "evolution state") {
  const error = () => {
    const failure = new Error(`E_MUTATION_AUTHORITY_REQUIRED: ${label} projection is read-only`);
    failure.code = "E_MUTATION_AUTHORITY_REQUIRED";
    return failure;
  };
  const seen = new WeakMap();
  const protect = (entry) => {
    if (!entry || typeof entry !== "object") return entry;
    if (entry instanceof Date) return new Date(entry.getTime());
    if (seen.has(entry)) return seen.get(entry);
    const target = Array.isArray(entry) ? [] : {};
    const projection = new Proxy(target, {
      set() { throw error(); },
      defineProperty() { throw error(); },
      deleteProperty() { throw error(); },
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

function safeDeclarativeValue(value) {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value) || (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)) {
    return redact(value);
  }
  return undefined;
}

const EXECUTABLE_COMPONENT_FIELDS = Object.freeze([
  "activate", "deactivate", "healthCheck", "snapshot", "restore", "replace", "provide",
]);

function hasExecutableComponentRuntime(definition = {}) {
  if (EXECUTABLE_COMPONENT_FIELDS.some((field) => typeof definition[field] === "function")) return true;
  if (definition.instance !== undefined && definition.instance !== null) return true;
  const seen = new WeakSet();
  const containsFunction = (value) => {
    if (typeof value === "function") return true;
    if (!value || typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);
    return Object.values(value).some(containsFunction);
  };
  if (containsFunction(definition.value)) return true;
  return (Array.isArray(definition.effects) ? definition.effects : [definition.effects])
    .filter(Boolean)
    .some((effect) => ["before", "apply", "action", "verify", "after", "rollback", "dispose"]
      .some((field) => typeof effect?.[field] === "function"));
}

function resolverKeyFor(definition = {}) {
  return definition.resolverKey
    ?? definition.resolver
    ?? definition.metadata?.resolverKey
    ?? definition.metadata?.resolver
    ?? null;
}

function requiresComponentResolver(definition = {}) {
  return Boolean(definition.requiresResolver || resolverKeyFor(definition) || hasExecutableComponentRuntime(definition));
}

/** Persist only a component manifest; executable hooks and runtime instances stay process-local. */
function durableComponentDefinition(definition = {}) {
  const normalized = normalizeComponentDefinition(definition);
  const {
    activate,
    deactivate,
    healthCheck,
    snapshot,
    restore,
    replace,
    provide,
    instance,
    value,
    health,
    ...manifest
  } = normalized;
  const lifecycle = { ...(manifest.lifecycle ?? {}) };
  for (const field of EXECUTABLE_COMPONENT_FIELDS) delete lifecycle[field];
  const declarativeValue = safeDeclarativeValue(value);
  return safeRecord({
    ...manifest,
    lifecycle,
    resolverKey: resolverKeyFor(normalized),
    requiresResolver: requiresComponentResolver(definition),
    configuration: safeRecord(normalized.configuration),
    policy: safeRecord(normalized.policy),
    ...(declarativeValue === undefined ? {} : { value: declarativeValue }),
  });
}

function definitionFingerprint(definition = {}) {
  return JSON.stringify(durableComponentDefinition(definition));
}

function componentManifestFor(definition = {}) {
  const durable = durableComponentDefinition(definition);
  return safeRecord({
    id: durable.id,
    kind: durable.kind,
    name: durable.name,
    identity: durable.identity,
    version: durable.version,
    capabilities: durable.capabilities,
    provides: durable.provides,
    requires: durable.requires,
    lifecycle: durable.lifecycle,
    durable: true,
    temporary: false,
    disabled: durable.disabled,
    resolverKey: durable.resolverKey,
    requiresResolver: durable.requiresResolver,
    contract: durable.contract,
    metadata: durable.metadata,
  });
}

function strategyTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(redact(value ?? {}));
  return new Set(String(text ?? "").toLowerCase().split(/[^a-z0-9一-龥]+/u).map((token) => token.trim()).filter((token) => token.length >= 2));
}
function strategySimilarity(left, right) {
  const a = strategyTokens(left);
  const b = strategyTokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}
function strategyConfidence(entry) {
  const value = Number(entry.outcomeConfidence ?? entry.confidence ?? (entry.status === "promoted" ? 1 : 0));
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
function strategyRecency(entry, now = Date.now()) {
  const time = Date.parse(entry.recordedAt ?? entry.promotedAt ?? entry.createdAt ?? "");
  if (!Number.isFinite(time)) return 0.5;
  const ageDays = Math.max(0, (now - time) / 86_400_000);
  return Math.max(0, Math.min(1, Math.exp(-ageDays / 90)));
}

// Autonomous supervisor snapshots are an observation cache, not the
// canonical Evolution journal. Their durable sources are cycles, lineage,
// strategies, and strategyMutations. Keep only the control pointer and
// bounded evidence here so a full cycle report is not duplicated in RAM and
// then copied into every aggregate runtime snapshot.
function compactAutonomousEvidence(value = {}) {
  if (!value || typeof value !== "object") return null;
  const latest = value.latest && typeof value.latest === "object" ? value.latest : null;
  const strategy = latest?.strategy && typeof latest.strategy === "object" ? latest.strategy : null;
  const candidate = latest?.candidate && typeof latest.candidate === "object" ? latest.candidate : null;
  const failureIsolation = latest?.failureIsolation && typeof latest.failureIsolation === "object" ? latest.failureIsolation : null;
  return {
    id: latest?.id ?? latest?.cycleId ?? null,
    cycleId: latest?.cycleId ?? null,
    generation: latest?.generation ?? null,
    status: latest?.status ?? null,
    decision: latest?.decision ?? null,
    fitness: latest?.fitness ?? null,
    timeout: latest?.timeout ?? false,
    strategy: strategy ? {
      id: strategy.id ?? strategy.strategyId ?? strategy.strategyKey ?? null,
      strategyKey: strategy.strategyKey ?? null,
      name: strategy.name ?? null,
    } : null,
    candidate: candidate ? {
      id: candidate.id ?? candidate.componentId ?? null,
      componentId: candidate.componentId ?? candidate.id ?? null,
      version: candidate.version ?? null,
      status: candidate.status ?? null,
    } : null,
    metrics: safeRecord(latest?.metrics ?? {}),
    resourceMetrics: safeRecord(latest?.resourceMetrics ?? {}),
    failureIsolation: failureIsolation ? {
      isolated: failureIsolation.isolated ?? false,
      errorContained: failureIsolation.errorContained ?? true,
      registryRestored: failureIsolation.registryRestored ?? true,
      registryCorruption: failureIsolation.registryCorruption ?? false,
      registryCorruptionDetected: failureIsolation.registryCorruptionDetected ?? false,
      orphanCount: failureIsolation.orphanCount ?? 0,
      detectedOrphanComponents: failureIsolation.detectedOrphanComponents ?? 0,
      detectedOrphanEffects: failureIsolation.detectedOrphanEffects ?? 0,
      memoryPollution: failureIsolation.memoryPollution ?? false,
    } : null,
  };
}

function compactAutonomousState(value = {}) {
  const source = safeRecord(value);
  for (const key of ["supervisor", "trialSupervisor"]) {
    const current = source[key];
    if (!current || typeof current !== "object") continue;
    const decisions = Array.isArray(current.decisions)
      ? current.decisions.slice(-20).map((entry) => safeRecord({
        action: entry?.action ?? null,
        reason: entry?.reason ?? null,
        trigger: entry?.trigger ?? null,
        sampleCount: entry?.sampleCount ?? null,
        decidedAt: entry?.decidedAt ?? null,
      }))
      : [];
    const tree = Array.isArray(current.strategyEvolutionTree) ? current.strategyEvolutionTree : [];
    const latestMutation = tree.at(-1);
    source[key] = {
      status: current.status ?? null,
      running: current.running ?? false,
      mode: current.mode ?? null,
      bounded: current.bounded ?? true,
      intervalMs: current.intervalMs ?? null,
      cycleTimeoutMs: current.cycleTimeoutMs ?? null,
      maxCycles: current.maxCycles ?? null,
      historyCount: current.historyCount ?? 0,
      generationCount: current.generationCount ?? 0,
      consecutiveFailures: current.consecutiveFailures ?? 0,
      regressions: current.regressions ?? 0,
      crashes: current.crashes ?? 0,
      circuitOpen: current.circuitOpen ?? false,
      stopRequested: current.stopRequested ?? false,
      stopReason: current.stopReason ?? null,
      startedAt: current.startedAt ?? null,
      endedAt: current.endedAt ?? null,
      lastSuccessAt: current.lastSuccessAt ?? null,
      lastError: current.lastError ?? null,
      decisions,
      latest: compactAutonomousEvidence(current),
      strategyEvolutionTreeCount: tree.length || Number(current.strategyEvolutionTreeCount) || 0,
      latestStrategyMutationId: latestMutation?.id ?? current.latestStrategyMutationId ?? null,
    };
  }
  return source;
}

const MEMORY_TOMBSTONE = "__evolutionTombstone";
const MEMORY_CONSOLIDATED = "__evolutionConsolidated";
const DEFAULT_ARCHIVE_TARGET_BYTES = 8 * 1024 * 1024;
const DEFAULT_ARCHIVE_HARD_CEILING_BYTES = 16 * 1024 * 1024;
const RETIREMENT_STATES = new Set([
  "REJECTED", "FAILED", "REVERTED", "ROLLED_BACK", "ROLLBACK",
  "SUPERSEDED", "DUPLICATE", "REDUNDANT", "CONSOLIDATED", "TOMBSTONE",
]);
const ACTIVE_STATES = new Set([
  "ACTIVE", "RUNNING", "PENDING", "PROPOSED", "CANDIDATE", "TESTED",
  "AWAITING_CONFIRMATION", "EXPERIMENTAL", "CANARY", "PROVISIONAL",
  "IN_PROGRESS", "OBSERVING",
]);
const RETAINED_JOURNAL_COLLECTIONS = new Set(["journal", "selections"]);
const EXECUTION_BRIDGE_EVENT_TYPES = new Set([
  "proposal-created",
  "trial-completed",
  "measurement-completed",
  "experiment-rejected",
  "failure-learned",
  "promotion-succeeded",
  "promotion-reverted",
  "canary-passed",
  "canary-failed",
]);

function lifecycleState(entry = {}) {
  const value = entry.lifecycleState ?? entry.lifecycle ?? entry.retentionState ?? entry.status ?? entry.decision ?? "";
  return String(value).trim().toUpperCase().replace(/[ -]+/g, "_");
}

function semanticCapability(collection, entry = {}) {
  const explicit = entry.capabilityId ?? entry.capability ?? entry.capabilityKey;
  if (explicit !== undefined && explicit !== null && String(explicit).trim()) return String(explicit);
  if (entry.lineageId !== undefined && entry.lineageId !== null && String(entry.lineageId).trim()) return "lineage:" + String(entry.lineageId);
  const target = entry.targetComponent ?? entry.componentId ?? entry.patternKey ?? entry.target?.id ?? entry.target ?? entry.problem ?? entry.type ?? "unknown";
  return collection + ":" + (normalizePatternText(target).slice(0, 160) || "unknown");
}

function semanticFingerprint(collection, entry = {}) {
  const payload = {
    collection,
    capability: semanticCapability(collection, entry),
    lineageId: entry.lineageId ?? null,
    patternKey: normalizePatternText(entry.patternKey ?? entry.signature ?? entry.type ?? ""),
    problem: normalizePatternText(entry.problem ?? entry.message ?? entry.rootCause ?? ""),
    decision: lifecycleState(entry),
    change: redact(entry.change ?? entry.mutation ?? {}),
    failureConditions: redact(entry.failureConditions ?? entry.failureCondition ?? {}),
  };
  return "fp:" + createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function problemFingerprint(entry = {}) {
  const payload = {
    patternKey: normalizePatternText(entry.patternKey ?? entry.signature ?? entry.type ?? ""),
    problem: normalizePatternText(entry.problem ?? entry.message ?? entry.rootCause ?? ""),
    componentId: entry.componentId ?? entry.targetComponent ?? entry.capabilityId ?? null,
    environment: redact(entry.environment ?? entry.context ?? {}),
    runtimeVersion: entry.runtimeVersion ?? entry.version ?? null,
  };
  return "problem:" + createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function candidateFingerprint(entry = {}, resolvedProblem = null) {
  const payload = {
    problemFingerprint: resolvedProblem ?? entry.problemFingerprint ?? problemFingerprint(entry),
    change: redact(entry.change ?? entry.mutation ?? entry.component ?? entry.definition ?? {}),
    strategy: redact(entry.strategy ?? entry.strategyKey ?? null),
    target: entry.targetComponent ?? entry.componentId ?? entry.target ?? null,
    metrics: redact(entry.metrics ?? entry.expectedImprovement ?? {}),
    runtimeVersion: entry.runtimeVersion ?? entry.version ?? null,
    environment: redact(entry.environment ?? entry.context ?? {}),
    previousResult: redact(entry.previousResult ?? entry.previousOutcome ?? entry.outcome ?? null),
  };
  return "candidate:" + createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function stableCanonicalEvidence(entry = {}) {
  const evidence = entry.evidence && typeof entry.evidence === "object" ? entry.evidence : {};
  const stability = entry.stability && typeof entry.stability === "object" ? entry.stability : {};
  // Real promote-path strategies carry their evaluation nested under
  // evidence.evaluation ({ eligible, evaluation: { validationRuns, ... } });
  // reading it here keeps canonical derivation grounded in actual promotion
  // evidence instead of requiring producers to flatten their payloads.
  const nestedEvaluation = evidence.evaluation && typeof evidence.evaluation === "object" ? evidence.evaluation : {};
  const nestedRuns = Number(nestedEvaluation.evaluation?.validationRuns ?? nestedEvaluation.validationRuns ?? 0);
  const promotionVerified = evidence.promotionId != null
    && nestedEvaluation.eligible === true
    && Number.isFinite(nestedRuns) && nestedRuns >= 1;
  const runs = Number(entry.validationRuns ?? evidence.validationRuns ?? stability.validationRuns ?? stability.samples ?? 0);
  const regressionPassed = entry.regressionPassed ?? evidence.regressionPassed ?? stability.regressionPassed;
  return entry.canonical === true
    || lifecycleState(entry) === "CANONICAL"
    || entry.stabilityVerified === true
    || stability.verified === true
    || promotionVerified
    || (regressionPassed === true && Number.isFinite(runs) && runs >= 1);
}

function compactCycleRecord(entry = {}) {
  const observations = Array.isArray(entry.observations) ? entry.observations : [];
  const stages = Array.isArray(entry.stages) ? entry.stages : [];
  return safeRecord({
    id: entry.id ?? entry.cycleId ?? id("cycle"),
    cycleId: entry.cycleId ?? entry.id ?? null,
    generation: entry.generation ?? null,
    generationId: entry.generationId ?? null,
    lineageId: entry.lineageId ?? null,
    parentVersion: entry.parentVersion ?? null,
    startedAt: entry.startedAt ?? null,
    endedAt: entry.endedAt ?? null,
    recordedAt: entry.recordedAt ?? null,
    status: entry.status ?? "observed",
    decision: entry.decision ?? null,
    retention: "CONSOLIDATED",
    [MEMORY_CONSOLIDATED]: 1,
    fingerprint: semanticFingerprint("cycles", entry),
    cycleCount: 1,
    noChangeCount: 1,
    healthSummary: safeRecord(entry.healthSummary ?? entry.health ?? {}),
    metricsSummary: safeRecord(entry.metricsSummary ?? entry.metrics ?? {}),
    observationCount: observations.length,
    diagnosisCount: Array.isArray(entry.diagnoses) ? entry.diagnoses.length : 0,
    gapCount: Array.isArray(entry.gaps) ? entry.gaps.length : 0,
    componentIds: [...new Set(observations.map((value) => value?.componentId).filter(Boolean))].slice(0, 64),
    patternFingerprints: [...new Set(observations.map((value) => value?.patternKey ?? value?.type).filter(Boolean))].slice(0, 64),
    stageNames: [...new Set(stages.map((value) => value?.stage).filter(Boolean))].slice(0, 32),
  });
}

function compactObservationRecord(entry = {}) {
  const metrics = entry.metrics && typeof entry.metrics === "object" ? entry.metrics : {};
  return safeRecord({
    id: entry.id ?? id("observation"),
    observedAt: entry.observedAt ?? null,
    recordedAt: entry.recordedAt ?? null,
    type: entry.type ?? null,
    source: entry.source ?? null,
    domain: entry.domain ?? null,
    componentId: entry.componentId ?? null,
    patternKey: entry.patternKey ?? null,
    severity: entry.severity ?? null,
    errorCode: entry.errorCode ?? null,
    impact: entry.impact ?? null,
    retention: "CONSOLIDATED",
    [MEMORY_CONSOLIDATED]: 1,
    fingerprint: semanticFingerprint("observations", entry),
    metrics: safeRecord({
      successRate: metrics.successRate ?? null,
      errorRate: metrics.errorRate ?? null,
      failureCount: metrics.failureCount ?? null,
      usageCount: metrics.usageCount ?? null,
      brokenDependencies: metrics.brokenDependencies ?? null,
    }),
  });
}

function observationAggregationKey(entry = {}) {
  return JSON.stringify([
    entry.componentId ?? entry.affectedComponent ?? null,
    entry.patternKey ?? null,
    entry.type ?? null,
    entry.errorCode ?? null,
    entry.severity ?? null,
    entry.problem ?? null,
  ]);
}

function compactObservationAggregate(entries = []) {
  const ordered = [...entries].sort((left, right) => observationTime(left.observedAt ?? left.recordedAt) - observationTime(right.observedAt ?? right.recordedAt));
  const first = ordered[0] ?? {};
  const last = ordered.at(-1) ?? first;
  const representatives = [first, ordered[Math.floor((ordered.length - 1) / 2)], last]
    .filter((entry, index, values) => entry && values.findIndex((candidate) => candidate?.id === entry.id) === index)
    .slice(0, 3)
    .map((entry) => safeRecord({
      id: entry.id ?? null,
      observedAt: entry.observedAt ?? entry.recordedAt ?? null,
      message: entry.message ?? null,
      errorCode: entry.errorCode ?? null,
      metrics: entry.metrics ?? {},
    }));
  return safeRecord({
    ...compactObservationRecord(first),
    id: "observation-group:" + hashText(observationAggregationKey(first)),
    retention: "AGGREGATED",
    count: ordered.length,
    firstSeen: first.observedAt ?? first.recordedAt ?? null,
    lastSeen: last.observedAt ?? last.recordedAt ?? null,
    representativeSamples: representatives,
    relatedProposal: last.relatedProposal ?? last.proposalId ?? null,
    manualOutcome: last.manualOutcome ?? last.outcome ?? null,
    resolvedBy: last.resolvedBy ?? null,
    metricsSummary: safeRecord({ first: first.metrics ?? {}, last: last.metrics ?? {} }),
    [MEMORY_CONSOLIDATED]: 1,
  });
}

function isConsolidatableCycle(entry = {}) {
  if (lifecycleState(entry) !== "OBSERVED") return false;
  if (entry.candidate || entry.proposal || entry.result || entry.generation !== null && entry.generation !== undefined || entry.generationId || entry.lineageId) return false;
  const meaningfulStages = new Set([
    "component-proposal", "experiment-component", "lifecycle-validation",
    "measurement", "selection", "promotion-rejection",
  ]);
  return !(Array.isArray(entry.stages) && entry.stages.some((stage) => meaningfulStages.has(stage?.stage)));
}

function isConsolidatableObservation(collection, entry = {}, referencedIds = new Set()) {
  if (collection !== "observations" || !entry.id) return false;
  return String(entry.type ?? "").toLowerCase() === "component/observation"
    && String(entry.severity ?? "info").toLowerCase() === "info"
    && !entry.errorCode
    && !entry.problem
    && !entry.rootCause;
}

function isTerminalRetirement(entry = {}) {
  return RETIREMENT_STATES.has(lifecycleState(entry));
}

function isActiveExperiment(entry = {}) {
  const state = lifecycleState(entry);
  return ACTIVE_STATES.has(state) || (state === "PROMOTED" && entry.stabilityVerified !== true && entry.canonical !== true);
}

// ---------------------------------------------------------------------------
// Housekeeping helpers: pure, deterministic, zero LLM/token, local code only
// ---------------------------------------------------------------------------
// These predicates are the single source of truth for what belongs in the hot
// pool. They use only local lifecycle fields and never call any LLM/provider.
// ---------------------------------------------------------------------------

function isHousekeepingObsolete(entry = {}) {
  const state = lifecycleState(entry);
  const lowerStatus = String(entry.status ?? "").toLowerCase();
  return state === "OBSOLETE"
    || state === "REVERTED"
    || String(entry.retirementState ?? "").toUpperCase() === "OBSOLETE"
    || String(entry.auditClassification ?? "").toUpperCase() === "OBSOLETE"
    || lowerStatus === "obsolete"
    || lowerStatus === "reverted"
    || entry[MEMORY_TOMBSTONE] === 1;
}

function isHousekeepingPromoted(entry = {}) {
  const state = lifecycleState(entry);
  const lowerStatus = String(entry.status ?? "").toLowerCase();
  return state === "PROMOTED"
    || lowerStatus === "promoted"
    || entry.canonical === true
    || entry.stabilityVerified === true;
}

function isHousekeepingNeedsEvidence(entry = {}) {
  const state = lifecycleState(entry);
  return state === "NEEDS_EVIDENCE"
    || String(entry.status ?? "").toLowerCase() === "needs_evidence"
    || entry.needsEvidence === true;
}

function isHousekeepingTerminal(entry = {}) {
  return isTerminalRetirement(entry) || isHousekeepingObsolete(entry) || isHousekeepingPromoted(entry);
}

function isHousekeepingHotPoolCandidate(entry = {}) {
  if (!entry || typeof entry !== "object") return false;
  if (isHousekeepingObsolete(entry)) return false;
  if (isHousekeepingPromoted(entry)) return false;
  if (isTerminalRetirement(entry)) return false;
  const state = lifecycleState(entry);
  if (["REJECTED", "FAILED", "ROLLED_BACK", "ROLLBACK", "SUPERSEDED", "DUPLICATE", "REDUNDANT", "CONSOLIDATED", "TOMBSTONE"].includes(state)) return false;
  if (ACTIVE_STATES.has(state)) return true;
  if (["CANDIDATE", "PROPOSED", "AWAITING_CONFIRMATION", "DETECTED", "NEEDS_EVIDENCE", "BLOCKED_FAILED_HISTORY", "BLOCKED_HIGH_RISK", "BLOCKED_POLICY", "BLOCKED", "DETECTED"].includes(state)) return true;
  return !["OBSOLETE", "REVERTED", "PROMOTED"].includes(state);
}

function referencedIds(records = []) {
  const ids = new Set();
  const visit = (value, key = "") => {
    if (!value || typeof value !== "object") {
      if (typeof value === "string" && (key === "id" || /(?:^|[A-Z])(?:id|version|experiment|promotion|proposal|generation|parent|source)/i.test(key))) ids.add(value);
      return;
    }
    if (Array.isArray(value)) { for (const item of value) visit(item, key); return; }
    for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
  };
  for (const record of records) visit(record);
  return ids;
}

function tombstoneFor(collection, entry, { reason, replacedBy = null } = {}) {
  const fingerprint = entry.fingerprint ?? semanticFingerprint(collection, entry);
  const signature = entry.signature ?? entry.patternKey ?? entry.problem ?? entry.rootCause ?? null;
  return safeRecord({
    id: "tombstone:" + fingerprint,
    [MEMORY_TOMBSTONE]: 1,
    state: "TOMBSTONE",
    retention: "TOMBSTONE",
    fingerprint,
    problemFingerprint: entry.problemFingerprint ?? problemFingerprint(entry),
    candidateFingerprint: entry.candidateFingerprint ?? candidateFingerprint(entry),
    capability: semanticCapability(collection, entry),
    lineageId: entry.lineageId ?? null,
    sourceCollection: collection,
    reason: reason ?? (lifecycleState(entry).toLowerCase() || "retired"),
    replacedBy,
    recordId: entry.id ?? null,
    signature,
    dontRepeat: entry.dontRepeat !== false && (entry.status === "failure" || entry.decision === "failure" || Boolean(signature)),
    rootCause: entry.rootCause ?? entry.failureConditions ?? null,
    strategyKey: entry.strategyKey ?? null,
    sourceExperimentId: entry.sourceExperimentId ?? entry.experimentId ?? null,
    sourceGenerationId: entry.sourceGenerationId ?? entry.generationId ?? null,
    fitnessScore: entry.fitnessScore ?? entry.fitness ?? null,
    firstSeen: entry.recordedAt ?? entry.startedAt ?? null,
    lastSeen: entry.recordedAt ?? entry.endedAt ?? null,
    recordIds: entry.id ? [entry.id] : [],
    count: 1,
  });
}

function archiveByteLength(value) {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
}

function archivePayloadHash(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function boundedText(value, maxBytes = 4096) {
  const text = typeof value === "string" ? value : JSON.stringify(redact(value ?? null));
  const limit = Math.max(0, Number(maxBytes) || 0);
  if (limit === 0) return "";
  if (Buffer.byteLength(text) <= limit) return text;
  const suffix = "…[truncated]";
  if (Buffer.byteLength(suffix) >= limit) return suffix.slice(0, limit);
  let output = text;
  while (output && Buffer.byteLength(output + suffix) > limit) output = output.slice(0, -1);
  return output + suffix;
}

/**
 * A single record must never be allowed to defeat the segment ceiling.  The
 * complete payload is intentionally not copied to a second archive: the
 * durable record keeps identity, fingerprints and a bounded knowledge summary
 * so restore/audit can still answer decision questions without retaining raw
 * telemetry.
 */
function boundedArchiveEntry(collection, entry, hardCeiling) {
  const raw = JSON.stringify(entry);
  if (archiveByteLength(raw) <= hardCeiling) return { entry, raw };
  const summary = safeRecord({
    id: entry?.id ?? id("archive-record"),
    type: entry?.type ?? null,
    status: entry?.status ?? entry?.decision ?? null,
    lifecycleState: entry?.lifecycleState ?? entry?.retentionState ?? null,
    problem: entry?.problem ?? null,
    patternKey: entry?.patternKey ?? null,
    signature: entry?.signature ?? null,
    problemFingerprint: entry?.problemFingerprint ?? null,
    candidateFingerprint: entry?.candidateFingerprint ?? entry?.fingerprint ?? null,
    candidateGroup: entry?.candidateGroup ?? null,
    componentId: entry?.componentId ?? entry?.targetComponent ?? null,
    lineageId: entry?.lineageId ?? null,
    experimentId: entry?.experimentId ?? entry?.sourceExperimentId ?? null,
    promotionId: entry?.promotionId ?? null,
    reason: entry?.reason ?? entry?.rootCause ?? entry?.lastDecision ?? null,
    metricsSummary: entry?.metrics ?? entry?.metricsSummary ?? null,
    outcome: entry?.outcome ?? entry?.finalResult?.status ?? null,
    replacedBy: entry?.replacedBy ?? null,
    retention: "EXTERNALIZED",
    [MEMORY_CONSOLIDATED]: 1,
    payloadHash: archivePayloadHash(raw),
    payloadBytes: Buffer.byteLength(raw),
    summary: boundedText({
      evidence: entry?.evidence,
      diagnosis: entry?.diagnosis,
      change: entry?.change,
      finalResult: entry?.finalResult,
    }),
  });
  let serialized = JSON.stringify(summary);
  if (archiveByteLength(serialized) > hardCeiling) {
    const minimal = {
      id: summary.id,
      type: summary.type,
      status: summary.status,
      problemFingerprint: summary.problemFingerprint,
      candidateFingerprint: summary.candidateFingerprint,
      fingerprint: summary.candidateFingerprint,
      retention: "EXTERNALIZED",
      [MEMORY_CONSOLIDATED]: 1,
      payloadHash: summary.payloadHash,
      payloadBytes: summary.payloadBytes,
      summary: "",
    };
    const fixedBytes = archiveByteLength(minimal);
    minimal.summary = boundedText(summary.summary, Math.max(0, hardCeiling - fixedBytes));
    serialized = JSON.stringify(minimal);
    // A very small configured ceiling can still be smaller than the fixed
    // identity fields. Trim the optional fields before falling back to the
    // smallest valid externalized marker.
    if (archiveByteLength(serialized) > hardCeiling) {
      const marker = { id: boundedText(summary.id, Math.max(16, Math.floor(hardCeiling / 3))), retention: "EXTERNALIZED", payloadHash: summary.payloadHash };
      serialized = JSON.stringify(marker);
      if (archiveByteLength(serialized) > hardCeiling) serialized = JSON.stringify({ retention: "EXTERNALIZED", payloadHash: String(summary.payloadHash).slice(0, 16) });
    }
  }
  return { entry: JSON.parse(serialized), raw: serialized };
}

/** Durable, redacted memory for proposals, experiments, failures, and promotions. */
export class EvolutionMemory {
  #data;

  constructor({ stateStore = null, key = "evolution", clock = () => new Date(), maxEntries = 1000, hotCycles = 50, hotEntries = 50, archiveMaxBytes = DEFAULT_ARCHIVE_TARGET_BYTES, absoluteMaxSegmentBytes = DEFAULT_ARCHIVE_HARD_CEILING_BYTES, compactionTriggerBytes = 48 * 1024 * 1024, compactionMinIntervalMs = 10 * 60_000, eventBridgePath = null, transaction = null, mutationAuthority = null, archiveWriteGuard = null } = {}) {
    if (transaction !== null && typeof transaction.persist !== "function") throw new TypeError("transaction.persist must be a function");
    if (archiveWriteGuard !== null && typeof archiveWriteGuard !== "function") throw new TypeError("archiveWriteGuard must be a function");
    if (stateStore && (typeof stateStore.load !== "function" || !(typeof stateStore.update === "function" || typeof stateStore.save === "function"))) throw new TypeError("stateStore requires load and update or save");
    this.transaction = transaction;
    this.stateStore = stateStore;
    // Host hook: a file-backed store that stages the archive elsewhere needs
    // the chance to hand this instance a private copy before an in-place write
    // so the live tree is never modified before the transaction commits.
    this.archiveWriteGuard = archiveWriteGuard;
    this.key = key;
    this.clock = clock;
    this.maxEntries = Math.max(1, Number(maxEntries) || 1000);
    // Cold-tier archive for durable records. Inactive unless the state store
    // is file-backed: an in-memory test store has no durable place where a
    // cold record could live, so its historical maxEntries contract remains.
    this.hotCycles = Math.max(1, Number(hotCycles) || 50);
    this.hotEntries = Math.max(1, Math.min(this.maxEntries, Number(hotEntries) || 50));
    this.archiveFile = this.stateStore?.filePath ? `${this.stateStore.filePath}.cycles-archive.jsonl` : null;
    this.absoluteMaxSegmentBytes = Math.max(256, Number(absoluteMaxSegmentBytes) || DEFAULT_ARCHIVE_HARD_CEILING_BYTES);
    this.archiveMaxBytes = Math.min(this.absoluteMaxSegmentBytes, Math.max(256, Number(archiveMaxBytes) || DEFAULT_ARCHIVE_TARGET_BYTES));
    this.archiveIndexFile = this.archiveFile ? `${this.stateStore.filePath}.evolution-archive-index.json` : null;
    this.archiveIndexWriting = Promise.resolve();
    this.archiveIndexReady = false;
    this.archiveIndexOperations = 0;
    this.archiveIndexEntries = new Map();
    this.archiveActiveKeys = new Map();
    this.archiveNextSegment = new Map();
    this.archiveKnown = new Map();
    this.archiveTombstones = new Map();
    this.archiveWriting = Promise.resolve();
    this.compacting = false;
    // Semantic-GC insurance trigger: periodic schedulers ask maintenance()
    // and it compacts only once total cold-tier bytes cross this ceiling.
    // Rotation keeps each active file small; this bounds their total.
    this.compactionTriggerBytes = Math.max(1024, Number(compactionTriggerBytes) || 48 * 1024 * 1024);
    this.compactionMinIntervalMs = Math.max(0, Number(compactionMinIntervalMs) || 10 * 60_000);
    this.eventBridgePath = eventBridgePath || (this.stateStore?.filePath ? join(dirname(this.stateStore.filePath), "evolution-events.jsonl") : null);
    this.lastMaintenanceAt = null;
    this.lastMaintenanceResult = null;
    this.#data = {
      schema: 4,
      observations: [],
      diagnoses: [],
      gaps: [],
      candidates: [],
      proposals: [],
      experiments: [],
      experimentRecords: [],
      journal: [],
      selections: [],
      promotions: [],
      outcomes: [],
      cycles: [],
      lineage: [],
      learnings: [],
      strategies: [],
      strategyMutations: [],
      // Canonical knowledge is the bounded semantic accumulator. Raw collections
      // remain addressable only when they carry independent recovery or audit
      // value; repeated events update this row instead of appending history.
      knowledge: [],
      // Canonical pointers are per capability/lineage. They never replace the
      // underlying verified implementation; tombstones carry only retired
      // fingerprints and blocking/provenance facts.
      canonical: [],
      tombstones: [],
      provenance: null,
      eventBridge: { schema: 1, applied: [] },
      coldArchives: {},
      autonomous: {
        mode: "advisory",
        updatedAt: null,
      },
    };
    this.loaded = false;
    this.loading = null;
    this.saving = Promise.resolve();
    // Serialize semantic upserts with source writes. This prevents concurrent
    // observations from both reading the same pre-merge knowledge row.
    this.mutationQueue = Promise.resolve();
    this.mutationAuthority = mutationAuthority;
  }

  get data() { return readonlyProjection(this.#data, "evolution memory"); }

  /** True when a hot projection must be separated from the complete view. */
  get hasColdHistory() {
    return Object.values(this.#data.coldArchives ?? {}).some((entry) => Number(entry?.count) > 0);
  }

  setMutationAuthority(authority) {
    if (this.mutationAuthority && authority !== this.mutationAuthority) {
      const error = new Error("Evolution memory mutation authority cannot be detached or replaced");
      error.code = "E_MUTATION_AUTHORITY_REQUIRED";
      throw error;
    }
    this.mutationAuthority = authority ?? null;
    return this;
  }

  #assertMutation(operation) {
    if (typeof this.mutationAuthority?.assertMutation !== "function") {
      const error = new Error("E_MUTATION_AUTHORITY_REQUIRED: explicit domain authority is required");
      error.code = "E_MUTATION_AUTHORITY_REQUIRED";
      throw error;
    }
    this.mutationAuthority.assertMutation(operation);
  }

  /** Ask the host for an isolated copy of a file about to be written in place. */
  async #beforeArchiveWrite(file) {
    if (typeof this.archiveWriteGuard === "function") await this.archiveWriteGuard(file);
  }

  async load() {
    if (this.loaded) return this.snapshot();
    if (this.loading) return this.loading;
    this.loading = (async () => {
      if (typeof this.stateStore?.load === "function") {
        const state = await this.stateStore.load({ resolveSnapshot: false });
        const stored = state?.[this.key];
        if (stored && typeof stored === "object") {
          this.#data = {
          ...this.#data,
            ...stored,
            schema: Math.max(4, Number(stored.schema) || this.#data.schema),
            observations: Array.isArray(stored.observations) ? stored.observations : [],
            diagnoses: Array.isArray(stored.diagnoses) ? stored.diagnoses : [],
            gaps: Array.isArray(stored.gaps) ? stored.gaps : [],
            candidates: Array.isArray(stored.candidates) ? stored.candidates : [],
            proposals: Array.isArray(stored.proposals) ? stored.proposals : [],
            experiments: Array.isArray(stored.experiments) ? stored.experiments : [],
            experimentRecords: Array.isArray(stored.experimentRecords) ? stored.experimentRecords : [],
            journal: Array.isArray(stored.journal) ? stored.journal : [],
            selections: Array.isArray(stored.selections) ? stored.selections : [],
            promotions: Array.isArray(stored.promotions) ? stored.promotions : [],
            outcomes: Array.isArray(stored.outcomes) ? stored.outcomes : [],
            cycles: Array.isArray(stored.cycles) ? stored.cycles : [],
            lineage: Array.isArray(stored.lineage) ? stored.lineage : [],
            learnings: Array.isArray(stored.learnings) ? stored.learnings : [],
            strategies: Array.isArray(stored.strategies) ? stored.strategies : [],
            strategyMutations: Array.isArray(stored.strategyMutations) ? stored.strategyMutations : [],
            knowledge: Array.isArray(stored.knowledge) ? stored.knowledge : [],
            canonical: Array.isArray(stored.canonical) ? stored.canonical : [],
            tombstones: Array.isArray(stored.tombstones) ? stored.tombstones : [],
            provenance: stored.provenance && typeof stored.provenance === "object" ? stored.provenance : null,
            eventBridge: stored.eventBridge && typeof stored.eventBridge === "object"
              ? { schema: 1, applied: Array.isArray(stored.eventBridge.applied) ? stored.eventBridge.applied : [] }
              : { schema: 1, applied: [] },
            autonomous: stored.autonomous && typeof stored.autonomous === "object"
              ? compactAutonomousState({ ...this.#data.autonomous, ...stored.autonomous })
              : this.#data.autonomous,
          };
        }
      }
      if (this.archiveFile) {
        // Legacy state files may contain absolute archive paths from an older
        // profile. Rebase metadata using directory stats only; do not parse
        // cold records during startup. The archive remains the source of truth
        // and is hydrated lazily by history()/fullSnapshot().
        const metadata = { ...(this.#data.coldArchives ?? {}) };
        for (const collection of this.#collections()) {
          const path = this.#archivePath(collection);
          const previous = metadata[collection];
          const present = (() => {
            try { return statSync(path).isFile(); } catch { return false; }
          })();
          let segments = [];
          try { segments = this.#archiveFiles(collection).filter((file) => file !== path); } catch {}
          if (!previous && !present && segments.length === 0) continue;
          metadata[collection] = {
            ...(previous ?? {}),
            schema: 2,
            file: path,
            activeFile: path,
            segments,
            maxActiveBytes: this.archiveMaxBytes,
            absoluteMaxSegmentBytes: this.absoluteMaxSegmentBytes,
            indexFile: this.archiveIndexFile,
          };
        }
        this.#data.coldArchives = metadata;
        await this.#reconcileArchiveIndex();
      }
      for (const collection of this.#collections()) {
        const limit = this.#hotLimit(collection);
        if (this.archiveFile && this.#data[collection].length > limit) {
          const evicted = this.#data[collection].slice(0, -limit);
          // The state file is still authoritative until the next successful
          // partition commit. Archive first; if archival fails, keep every
          // record in RAM rather than silently truncating evolution history.
          if (await this.#archiveEntries(collection, evicted)) this.#data[collection].splice(0, evicted.length);
        } else if (!this.archiveFile) {
          this.#data[collection] = this.#data[collection].slice(-this.maxEntries);
        }
      }
      this.loaded = true;
      return this.snapshot();
    })();
    try { return await this.loading; } finally { this.loading = null; }
  }

  #collections() {
    return ["observations", "diagnoses", "gaps", "candidates", "proposals", "experiments", "experimentRecords", "journal", "selections", "promotions", "outcomes", "cycles", "lineage", "learnings", "strategies", "strategyMutations", "knowledge", "tombstones"];
  }

  #hotLimit(collection) { return collection === "cycles" ? this.hotCycles : collection === "knowledge" ? this.maxEntries : this.hotEntries; }

  #archivePath(collection) {
    if (!this.archiveFile) return null;
    return collection === "cycles" ? this.archiveFile : `${this.stateStore.filePath}.${collection}-archive.jsonl`;
  }

  #archiveKey(entry) {
    if (entry && typeof entry === "object" && entry.id !== undefined && entry.id !== null) return "id:" + String(entry.id);
    try { return "value:" + JSON.stringify(entry); } catch { return "value:" + String(entry); }
  }

  #archiveSegmentDirectory(collection) {
    const path = this.#archivePath(collection);
    return path ? path + ".segments" : null;
  }

  #archiveFiles(collection) {
    const path = this.#archivePath(collection);
    if (!path) return [];
    const directory = this.#archiveSegmentDirectory(collection);
    let names = [];
    try {
      names = readdirSync(directory).filter((name) => /^segment-[0-9]+\.jsonl$/.test(name)).sort();
    } catch {}
    return [...names.map((name) => join(directory, name)), path].filter((file, index, files) => index === files.indexOf(file));
  }

  #isTombstone(entry, collection = null) { return collection !== "tombstones" && Boolean(entry && typeof entry === "object" && entry[MEMORY_TOMBSTONE] === 1); }

  #readArchiveSync(collection) {
    const files = this.#archiveFiles(collection);
    if (!files.length) {
      this.archiveKnown.set(collection, new Set());
      this.archiveTombstones.set(collection, new Set());
      return [];
    }
    const records = [];
    const positions = new Map();
    const tombstones = new Set();
    for (const file of files) {
      let raw;
      try { raw = readFileSync(file, "utf8"); } catch (error) {
        if (error?.code === "ENOENT") continue;
        continue;
      }
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const value = JSON.parse(line);
          if (!value || typeof value !== "object") continue;
          const key = this.#archiveKey(value);
          const position = positions.get(key);
          if (position === undefined) {
            positions.set(key, records.length);
            records.push(value);
          } else {
            // Latest value wins while the first position remains stable across
            // legacy files, sealed segments, and a torn active tail.
            records[position] = value;
          }
          if (this.#isTombstone(value, collection)) tombstones.add(key);
          else tombstones.delete(key);
        } catch { /* a torn final line is ignored */ }
      }
    }
    this.archiveKnown.set(collection, new Set(positions.keys()));
    this.archiveTombstones.set(collection, tombstones);
    return collection === "tombstones" ? records : records.filter((entry) => !this.#isTombstone(entry, collection));
  }

  #setArchiveMetadata(collection, known, tombstones) {
    const path = this.#archivePath(collection);
    if (!path) return;
    const segments = this.#archiveFiles(collection).filter((file) => file !== path);
    const count = Math.max(0, known.size - tombstones.size);
    this.#data.coldArchives = {
      ...(this.#data.coldArchives ?? {}),
      [collection]: {
        schema: 2,
        count,
        file: path,
        activeFile: path,
        segments,
        maxActiveBytes: this.archiveMaxBytes,
        absoluteMaxSegmentBytes: this.absoluteMaxSegmentBytes,
        indexFile: this.archiveIndexFile,
      },
    };
  }

  #indexEntryFromRaw(collection, file, raw, { sealed = file !== this.#archivePath(collection), updatedAt = timestamp(this.clock) } = {}) {
    const lines = raw.split("\n").filter(Boolean);
    const records = [];
    for (const line of lines) {
      try { records.push(JSON.parse(line)); } catch { /* a torn line is not logical knowledge */ }
    }
    const first = records[0];
    const last = records.at(-1);
    const fileName = file.split("/").at(-1);
    const compactedCount = records.filter((entry) => entry?.[MEMORY_CONSOLIDATED] === 1 || entry?.retention === "CONSOLIDATED" || entry?.retention === "EXTERNALIZED").length;
    const loserSummaryCount = records.filter((entry) => entry?.[MEMORY_TOMBSTONE] === 1 || entry?.retention === "TOMBSTONE" || entry?.state === "TOMBSTONE" || entry?.reason === "superseded").length;
    return {
      segmentId: sealed
        ? `segment:${collection}:${/^segment-([0-9]+)\.jsonl$/.exec(fileName)?.[1] ?? fileName}`
        : `active:${collection}`,
      collection,
      recordType: collection,
      file: fileName,
      firstTimestamp: first?.recordedAt ?? first?.observedAt ?? first?.startedAt ?? null,
      lastTimestamp: last?.recordedAt ?? last?.observedAt ?? last?.endedAt ?? null,
      logicalCount: new Set(records.map((entry) => this.#archiveKey(entry))).size,
      physicalCount: lines.length,
      byteSize: Buffer.byteLength(raw),
      sha256: sealed ? createHash("sha256").update(raw).digest("hex") : null,
      hashAlgorithm: "sha256",
      checksumState: sealed ? "final" : "provisional",
      sealed,
      retentionClass: compactedCount || loserSummaryCount ? "knowledge" : "raw",
      winnerCount: records.filter((entry) => entry?.state === "CANONICAL" || entry?.lifecycleState === "CANONICAL" || entry?.canonical === true).length,
      loserSummaryCount,
      compactedCount,
      createdAt: first?.recordedAt ?? first?.observedAt ?? first?.startedAt ?? null,
      updatedAt,
    };
  }

  #activeKeysFromRaw(collection, raw) {
    const keys = new Set();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry === "object") keys.add(this.#archiveKey(entry));
      } catch { /* a torn final line is ignored */ }
    }
    this.archiveActiveKeys.set(collection, keys);
    return keys;
  }

  async #loadArchiveIndex() {
    if (!this.archiveIndexFile) return false;
    let document;
    try { document = JSON.parse(await readFile(this.archiveIndexFile, "utf8")); } catch { return false; }
    if (!document || !Array.isArray(document.segments)) return false;
    const entries = new Map();
    // A staged domain mutation loads this index twice. Enumerate each
    // collection once per load, rather than twice per indexed segment.
    // Keep this lookup local so later loads still see rotations and repairs.
    const collections = this.#collections();
    const filesByCollection = new Map();
    const filesFor = (collection) => {
      if (!filesByCollection.has(collection)) {
        filesByCollection.set(collection, new Map(this.#archiveFiles(collection)
          .map((file) => [file.split("/").at(-1), file])));
      }
      return filesByCollection.get(collection);
    };
    for (const item of document.segments) {
      if (!item || typeof item !== "object" || typeof item.file !== "string") continue;
      const candidates = item.collection ? [item.collection] : collections;
      const collection = candidates.find((candidate) => collections.includes(candidate)
        && filesFor(candidate).has(item.file));
      if (!collection) continue;
      const file = filesFor(collection).get(item.file);
      if (file) entries.set(file, { ...item, collection });
    }
    this.archiveIndexEntries = entries;
    this.archiveIndexReady = true;
    return true;
  }

  async #writeArchiveIndexDocument() {
    if (!this.archiveIndexFile) return;
    const actual = [];
    for (const collection of this.#collections()) {
      for (const file of this.#archiveFiles(collection)) {
        try { if (!statSync(file).isFile()) continue; } catch { continue; }
        const entry = this.archiveIndexEntries.get(file);
        if (entry) actual.push({ ...entry, collection, file: file.split("/").at(-1) });
      }
    }
    const document = JSON.stringify({ schemaVersion: 1, updatedAt: timestamp(this.clock), segments: actual });
    const temporary = `${this.archiveIndexFile}.${randomUUID()}.tmp`;
    await mkdir(dirname(this.archiveIndexFile), { recursive: true, mode: 0o700 });
    await writeFile(temporary, document, { mode: 0o600 });
    await rename(temporary, this.archiveIndexFile);
    this.archiveIndexReady = true;
  }

  async #writeArchiveIndexIncremental() {
    if (!this.archiveIndexFile) return;
    const write = async () => this.#writeArchiveIndexDocument();
    const queued = this.archiveIndexWriting.then(write, write);
    this.archiveIndexWriting = queued.catch(() => {});
    await queued;
  }

  async #reconcileArchiveIndex() {
    if (!this.archiveIndexFile) return;
    const loaded = await this.#loadArchiveIndex();
    let changed = !loaded;
    const actualFiles = new Set();
    for (const collection of this.#collections()) {
      const archivePath = this.#archivePath(collection);
      for (const file of this.#archiveFiles(collection)) {
        try { if (!(await stat(file)).isFile()) continue; } catch (error) { if (error?.code === "ENOENT") continue; throw error; }
        actualFiles.add(file);
        const sealed = file !== archivePath;
        const current = this.archiveIndexEntries.get(file);
        if (!sealed) {
          // Active files are the bounded recovery surface after an append/index crash.
          let raw = "";
          try { raw = await readFile(file, "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
          const rebuilt = this.#indexEntryFromRaw(collection, file, raw, { sealed: false });
          this.#activeKeysFromRaw(collection, raw);
          if (JSON.stringify(current) !== JSON.stringify(rebuilt)) changed = true;
          this.archiveIndexEntries.set(file, rebuilt);
          continue;
        }
        let size = 0;
        try { size = (await stat(file)).size; } catch { continue; }
        const valid = current?.sealed === true
          && current.checksumState === "final"
          && typeof current.sha256 === "string"
          && Number(current.byteSize) === size;
        if (valid) continue;
        // Only an unindexed or mismatched sealed file is read and re-hashed.
        const raw = await readFile(file, "utf8");
        this.archiveIndexEntries.set(file, this.#indexEntryFromRaw(collection, file, raw, { sealed: true }));
        changed = true;
      }
    }
    for (const file of this.archiveIndexEntries.keys()) {
      if (!actualFiles.has(file)) {
        this.archiveIndexEntries.delete(file);
        changed = true;
      }
    }
    // Do not materialize an empty index on every fresh state-store startup.
    // The first archive append creates it; avoiding this write also keeps a
    // background memory load from racing temporary-directory cleanup when no
    // cold records exist yet.
    if (changed && (loaded || actualFiles.size > 0 || this.archiveIndexEntries.size > 0)) {
      await this.#writeArchiveIndexDocument();
    }
    this.archiveIndexReady = true;
  }

  #recordActiveArchiveWrite(collection, records) {
    if (!records.length) return;
    const file = this.#archivePath(collection);
    if (!file) return;
    const current = this.archiveIndexEntries.get(file) ?? this.#indexEntryFromRaw(collection, file, "");
    const keys = this.archiveActiveKeys.get(collection) ?? new Set();
    let logicalCount = Number(current.logicalCount) || 0;
    let physicalCount = Number(current.physicalCount) || 0;
    let firstTimestamp = current.firstTimestamp ?? null;
    let lastTimestamp = current.lastTimestamp ?? null;
    let createdAt = current.createdAt ?? null;
    let byteSize = Number(current.byteSize) || 0;
    for (const { entry, line } of records) {
      const key = this.#archiveKey(entry);
      if (!keys.has(key)) { keys.add(key); logicalCount += 1; }
      physicalCount += 1;
      byteSize += Buffer.byteLength(line) + 1;
      const at = entry?.recordedAt ?? entry?.observedAt ?? entry?.startedAt ?? null;
      if (firstTimestamp === null && at !== null) firstTimestamp = at;
      if (at !== null) lastTimestamp = at;
      if (createdAt === null && at !== null) createdAt = at;
    }
    this.archiveActiveKeys.set(collection, keys);
    this.archiveIndexEntries.set(file, {
      ...current,
      segmentId: `active:${collection}`,
      collection,
      recordType: collection,
      file: file.split("/").at(-1),
      firstTimestamp,
      lastTimestamp,
      logicalCount,
      physicalCount,
      byteSize,
      sha256: null,
      hashAlgorithm: "sha256",
      checksumState: "provisional",
      sealed: false,
      createdAt,
      updatedAt: timestamp(this.clock),
    });
  }

  async #writeArchiveIndex() {
    if (!this.archiveIndexFile) return;
    const write = async () => {
      const entries = new Map();
      this.archiveActiveKeys = new Map();
      for (const collection of this.#collections()) {
        for (const file of this.#archiveFiles(collection)) {
          let raw;
          try { raw = await readFile(file, "utf8"); } catch { continue; }
          const sealed = file !== this.#archivePath(collection);
          entries.set(file, this.#indexEntryFromRaw(collection, file, raw, { sealed }));
          if (!sealed) this.#activeKeysFromRaw(collection, raw);
        }
      }
      this.archiveIndexEntries = entries;
      await this.#writeArchiveIndexDocument();
    };
    const queued = this.archiveIndexWriting.then(write, write);
    this.archiveIndexWriting = queued.catch(() => {});
    await queued;
  }

  async #sealArchive(collection, { force = false } = {}) {
    const path = this.#archivePath(collection);
    if (!path) return false;
    let bytes;
    try { bytes = (await stat(path)).size; } catch { return false; }
    if (bytes === 0 || (!force && bytes <= this.archiveMaxBytes)) return false;
    const directory = this.#archiveSegmentDirectory(collection);
    const temporary = join(directory, ".segment-" + randomUUID() + ".tmp");
    let segment = null;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      let next = this.archiveNextSegment.get(collection);
      if (!next) {
        next = 1;
        try {
          const names = await readdir(directory);
          for (const name of names) {
            const match = /^segment-([0-9]+)\.jsonl$/.exec(name);
            if (match) next = Math.max(next, Number(match[1]) + 1);
          }
        } catch {}
      }
      this.archiveNextSegment.set(collection, next + 1);
      segment = join(directory, "segment-" + String(next).padStart(12, "0") + ".jsonl");
      const raw = await readFile(path, "utf8");
      await this.#beforeArchiveWrite(path);
      await writeFile(temporary, raw, { mode: 0o600 });
      await rename(temporary, segment);
      await writeFile(path, "", { mode: 0o600 });
      this.archiveIndexEntries.set(segment, this.#indexEntryFromRaw(collection, segment, raw, { sealed: true }));
      this.archiveIndexEntries.set(path, this.#indexEntryFromRaw(collection, path, "", { sealed: false }));
      this.archiveActiveKeys.set(collection, new Set());
      this.#setArchiveMetadata(collection, this.archiveKnown.get(collection) ?? new Set(), this.archiveTombstones.get(collection) ?? new Set());
      return true;
    } catch {
      if (temporary) await rm(temporary, { force: true }).catch(() => {});
      return false;
    }
  }

  async #rotateArchiveIfNeeded(collection) {
    return this.#sealArchive(collection, { force: false });
  }

  async #archiveEntries(collection, entries, { replaceExisting = false } = {}) {
    const run = async () => {
      const path = this.#archivePath(collection);
      if (!path || !entries?.length) return Boolean(path);
      const existing = replaceExisting || !this.archiveKnown.has(collection)
        ? this.#readArchiveSync(collection)
        : [];
      const existingByKey = new Map(existing.map((entry) => [this.#archiveKey(entry), entry]));
      const known = new Set(this.archiveKnown.get(collection) ?? existingByKey.keys());
      const tombstones = new Set(this.archiveTombstones.get(collection) ?? []);
      const originalKnown = new Set(known);
      const originalTombstones = new Set(tombstones);
      const fresh = [];
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const key = this.#archiveKey(entry);
        if (known.has(key) && !replaceExisting) continue;
        const previous = existingByKey.get(key);
        try { if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(entry)) continue; } catch {}
        known.add(key);
        existingByKey.set(key, entry);
        if (this.#isTombstone(entry, collection)) tombstones.add(key);
        else tombstones.delete(key);
        fresh.push(entry);
      }
      this.archiveKnown.set(collection, known);
      this.archiveTombstones.set(collection, tombstones);
      if (!fresh.length) {
        this.#setArchiveMetadata(collection, known, tombstones);
        return true;
      }
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        // Chunk before writing. The old migration path serialized the whole
        // evicted batch first, which is the direct cause of the historical
        // 55MiB observations segment. A line larger than the target is still
        // legal, but remains bounded by absoluteMaxSegmentBytes.
        let activeBytes = 0;
        try { activeBytes = (await stat(path)).size; } catch { activeBytes = 0; }
        let chunk = [];
        let chunkRecords = [];
        let chunkBytes = 0;
        const flush = async () => {
          if (!chunk.length) return;
          const payload = chunk.join("\n") + "\n";
          await this.#beforeArchiveWrite(path);
          await appendFile(path, payload, { mode: 0o600 });
          activeBytes += Buffer.byteLength(payload);
          this.#recordActiveArchiveWrite(collection, chunkRecords);
          chunk = [];
          chunkRecords = [];
          chunkBytes = 0;
          if (activeBytes >= this.archiveMaxBytes) {
            const sealed = await this.#sealArchive(collection, { force: true });
            if (!sealed) throw new Error("Evolution archive seal failed");
            activeBytes = 0;
          }
        };
        for (const original of fresh) {
          const bounded = boundedArchiveEntry(collection, original, this.absoluteMaxSegmentBytes);
          const line = bounded.raw;
          const lineBytes = Buffer.byteLength(line) + 1;
          if (activeBytes + chunkBytes > 0 && activeBytes + chunkBytes + lineBytes > this.archiveMaxBytes) await flush();
          if (activeBytes > 0 && activeBytes + lineBytes > this.archiveMaxBytes) {
            const sealed = await this.#sealArchive(collection, { force: true });
            if (!sealed) throw new Error("Evolution archive seal failed");
            activeBytes = 0;
          }
          if (lineBytes > this.archiveMaxBytes) {
            await this.#beforeArchiveWrite(path);
            await appendFile(path, line + "\n", { mode: 0o600 });
            activeBytes += lineBytes;
            this.#recordActiveArchiveWrite(collection, [{ entry: bounded.entry, line }]);
            const sealed = await this.#sealArchive(collection, { force: true });
            if (!sealed) throw new Error("Evolution archive seal failed");
            activeBytes = 0;
          } else {
            chunk.push(line);
            chunkRecords.push({ entry: bounded.entry, line });
            chunkBytes += lineBytes;
          }
        }
        await flush();
        this.#setArchiveMetadata(collection, known, tombstones);
        this.archiveIndexOperations += 1;
        // Persist only the small index document. Active entry metadata is
        // updated incrementally above; sealed files receive their final hash
        // once during #sealArchive.
        await this.#writeArchiveIndexIncremental();
        return true;
      } catch {
        this.archiveKnown.set(collection, originalKnown);
        this.archiveTombstones.set(collection, originalTombstones);
        return false;
      }
    };
    const queued = this.archiveWriting.then(run, run);
    this.archiveWriting = queued.catch(() => {});
    return queued;
  }


  #mergeArchived(collection, hot, { copy = true } = {}) {
    const archived = this.#readArchiveSync(collection);
    if (!archived.length) return copy ? hot.map(clone) : hot;
    const merged = new Map();
    const anonymous = [];
    for (const entry of [...archived, ...hot]) {
      if (entry && typeof entry === "object" && entry.id !== undefined && entry.id !== null) merged.set(String(entry.id), entry);
      else anonymous.push(entry);
    }
    const rows = [...merged.values(), ...anonymous];
    return copy ? rows.map(clone) : rows;
  }

  /**
   * Hot projection used by decision paths. It never reads cold files.
   * The historical public runtime snapshot calls fullSnapshot() below.
   */
  snapshot() { return clone(this.#data); }

  /** Complete durable projection, materialising cold records only on demand. */
  fullSnapshot() {
    // Clone scalar/control state once.  Collection arrays are replaced below
    // by their hot+cold merge, so cloning them here first would briefly hold a
    // second copy of every hot record during each public snapshot build.
    const output = {
      ...this.#data,
      coldArchives: clone(this.#data.coldArchives),
      autonomous: clone(this.#data.autonomous),
    };
    if (!this.archiveFile) {
      for (const collection of this.#collections()) output[collection] = this.#data[collection].map(clone);
      return output;
    }
    for (const collection of this.#collections()) output[collection] = this.#mergeArchived(collection, this.#data[collection]);
    return output;
  }

  history(collection, { includeArchived = true } = {}) {
    if (!this.#collections().includes(collection)) return [];
    return includeArchived ? this.#mergeArchived(collection, this.#data[collection]) : this.#data[collection].map(clone);
  }

  /** Count the complete history but copy only the requested trailing window.
   * Raw references stay private; callers receive the same detached records as
   * history(). Archive reads and latest-value/tombstone semantics are unchanged.
   */
  historyWindow(collection, limit = 10, { metadataOnly = false } = {}) {
    if (!this.#collections().includes(collection)) return { count: 0, entries: [] };
    const rows = this.#mergeArchived(collection, this.#data[collection], { copy: false });
    const size = Math.min(50, Math.max(1, Number(limit) || 10));
    // The domain port only consumes these fields. Project before cloning so
    // large evidence/summary payloads in the selected window are never copied.
    // Still clone the projection: legacy recordedAt values can be objects.
    return { count: rows.length, entries: rows.slice(-size).map(row => clone(metadataOnly ? {
      id: row.id, status: row.status, eventType: row.eventType, recordedAt: row.recordedAt,
    } : row)) };
  }

  /** Restore the complete durable evolution memory, including its journal. */
  async restore(snapshot = {}, { persist = true } = {}) {
    this.#assertMutation("evolution.memory.restore");
    const source = snapshot?.memoryState ?? snapshot?.state ?? snapshot;
    const collections = ["observations", "diagnoses", "gaps", "candidates", "proposals", "experiments", "experimentRecords", "journal", "selections", "promotions", "outcomes", "cycles", "lineage", "learnings", "strategies", "strategyMutations", "knowledge", "tombstones"];
    if (!source || typeof source !== "object" || !collections.some((key) => Array.isArray(source[key]))) {
      throw new ValidationError("Evolution memory snapshot is missing durable collections");
    }
    await this.load();
    this.#data = {
      ...this.#data,
      ...clone(source),
      schema: Math.max(4, Number(source.schema) || this.#data.schema),
      autonomous: source.autonomous && typeof source.autonomous === "object" ? compactAutonomousState(source.autonomous) : this.#data.autonomous,
    };
    for (const collection of collections) {
      const values = (Array.isArray(source[collection]) ? source[collection] : this.#data[collection]).map(clone);
      const archivedCount = Number(source.coldArchives?.[collection]?.count);
      // A restore may target a store that already has a cold archive (for
      // example, a process restart over the same home).  The archive file is
      // authoritative for records it already contains; the complete source
      // snapshot is a flattened cold+hot view, so blindly partitioning that
      // view would append the same historical records again and inflate the
      // cold count.  Rebase the metadata on the target file before adding any
      // records, then only partition source values that are not already in
      // that file (or are a newer value for the same durable id).
      const archivedValues = this.archiveFile ? this.#readArchiveSync(collection) : [];
      if (this.archiveFile && (archivedValues.length > 0 || (Number.isFinite(archivedCount) && archivedCount > 0))) {
        this.#data.coldArchives = {
          ...(this.#data.coldArchives ?? {}),
          [collection]: {
            schema: 1,
            count: archivedValues.length,
            file: this.#archivePath(collection),
          },
        };
      }
      const sourceHasColdBoundary = Number.isFinite(archivedCount) && archivedCount > 0;
      if (this.archiveFile && (values.length > this.#hotLimit(collection) || sourceHasColdBoundary)) {
        // A complete snapshot is the archive+hot projection in that exact
        // order.  Preserve its trailing hot window directly and archive only
        // the leading cold segment that is missing from the target file.  Do
        // not sort by timestamps here: several Evolution records can share a
        // clock tick, and reordering them would make a second idempotent
        // restore infer a smaller hot window (and duplicate cold metadata).
        const sourceHotCount = Math.max(1, Math.min(this.#hotLimit(collection), values.length));
        const sourceHot = values.slice(-sourceHotCount);
        const sourceCold = values.slice(0, -sourceHotCount);
        const archivedByKey = new Map(archivedValues.map((entry) => [this.#archiveKey(entry), entry]));
        const missingCold = sourceCold.filter((entry) => !archivedByKey.has(this.#archiveKey(entry)));
        const changedCold = sourceCold.filter((entry) => {
          const archived = archivedByKey.get(this.#archiveKey(entry));
          if (archived === undefined) return false;
          try { return JSON.stringify(archived) !== JSON.stringify(entry); } catch { return true; }
        });
        if (await this.#archiveEntries(collection, missingCold)
          && await this.#archiveEntries(collection, changedCold, { replaceExisting: true })) {
          const hotByKey = new Map(sourceHot.map((entry) => [this.#archiveKey(entry), entry]));
          this.#data[collection] = [...hotByKey.values()];
        } else this.#data[collection] = values;
      } else {
        this.#data[collection] = this.archiveFile ? values : values.slice(-this.maxEntries);
      }
    }
    this.loaded = true;
    if (persist) await this.#save();
    return this.snapshot();
  }

  #memoryProjection(value = this.#data) {
    const source = value && typeof value === "object" ? value : {};
    const projection = {
      schema: Math.max(4, Number(source.schema) || 4),
      autonomous: clone(source.autonomous ?? {}),
      coldArchives: clone(source.coldArchives ?? {}),
    };
    for (const collection of this.#collections()) projection[collection] = Array.isArray(source[collection]) ? clone(source[collection]) : [];
    return projection;
  }

  #normalizeDurableProjection(source = {}) {
    const next = { ...this.#data, ...clone(source) };
    for (const collection of this.#collections()) {
      next[collection] = Array.isArray(source[collection]) ? clone(source[collection]) : [];
    }
    next.schema = Math.max(4, Number(source.schema) || this.#data.schema);
    next.autonomous = source.autonomous && typeof source.autonomous === "object"
      ? compactAutonomousState(source.autonomous)
      : clone(this.#data.autonomous);
    next.coldArchives = source.coldArchives && typeof source.coldArchives === "object"
      ? clone(source.coldArchives)
      : {};
    return next;
  }

  async #adoptDurableProjection(source) {
    this.#data = this.#normalizeDurableProjection(source);
    if (this.archiveFile) {
      const metadata = { ...(this.#data.coldArchives ?? {}) };
      for (const collection of this.#collections()) {
        const path = this.#archivePath(collection);
        const previous = metadata[collection];
        let segments = [];
        try { segments = this.#archiveFiles(collection).filter((file) => file !== path); } catch {}
        if (!previous && !segments.length) continue;
        metadata[collection] = {
          ...(previous ?? {}),
          schema: 2,
          file: path,
          activeFile: path,
          segments,
          maxActiveBytes: this.archiveMaxBytes,
          absoluteMaxSegmentBytes: this.absoluteMaxSegmentBytes,
          indexFile: this.archiveIndexFile,
        };
      }
      this.#data.coldArchives = metadata;
      await this.#reconcileArchiveIndex();
    }
    this.loaded = true;
  }

  async #archiveConsistencyReport() {
    if (!this.archiveFile) return { valid: true, status: "not_configured", files: 0, missing: [], mismatched: [] };
    this.archiveIndexReady = false;
    await this.#reconcileArchiveIndex();
    await this.archiveIndexWriting;
    const missing = [];
    const mismatched = [];
    const actualFiles = new Set();
    for (const collection of this.#collections()) {
      for (const file of this.#archiveFiles(collection)) {
        let isFile = false;
        try { isFile = statSync(file).isFile(); } catch {}
        if (!isFile) continue;
        actualFiles.add(file);
        const indexed = this.archiveIndexEntries.get(file);
        if (!indexed) {
          missing.push(file);
          continue;
        }
        let raw;
        try { raw = await readFile(file, "utf8"); } catch { mismatched.push({ file, reason: "unreadable" }); continue; }
        const byteSize = Buffer.byteLength(raw);
        if (Number(indexed.byteSize) !== byteSize) mismatched.push({ file, reason: "byte_size", expected: byteSize, actual: indexed.byteSize });
        if (indexed.sealed === true) {
          const sha256 = createHash("sha256").update(raw).digest("hex");
          if (indexed.sha256 !== sha256) mismatched.push({ file, reason: "checksum", expected: sha256, actual: indexed.sha256 ?? null });
        }
      }
    }
    const stale = [...this.archiveIndexEntries.keys()].filter((file) => !actualFiles.has(file));
    return {
      valid: missing.length === 0 && mismatched.length === 0 && stale.length === 0,
      status: "verified",
      files: actualFiles.size,
      missing,
      mismatched,
      stale,
      indexFile: this.archiveIndexFile,
    };
  }

  async verifyConsistency({ durableState = null } = {}) {
    await this.#ensureLoaded();
    const state = durableState ?? (typeof this.stateStore?.load === "function" ? await this.stateStore.load({ resolveSnapshot: false }) : null);
    const durable = state?.[this.key] && typeof state[this.key] === "object" ? state[this.key] : null;
    const liveProjection = this.#memoryProjection(this.#data);
    const durableProjection = durable ? this.#memoryProjection(durable) : null;
    const liveFingerprint = memoryStateFingerprint(liveProjection);
    const durableFingerprint = durableProjection ? memoryStateFingerprint(durableProjection) : null;
    const reasons = [];
    if (durableProjection && liveFingerprint !== durableFingerprint) reasons.push("live_durable_memory_projection_mismatch");
    const complete = this.fullSnapshot();
    const duplicateIds = [];
    for (const collection of this.#collections()) {
      const ids = (complete[collection] ?? []).map((entry) => entry?.id).filter((idValue) => idValue !== undefined && idValue !== null).map(String);
      if (new Set(ids).size !== ids.length) duplicateIds.push(collection);
    }
    if (duplicateIds.length) reasons.push("duplicate_durable_ids");
    const invalidCanonical = (complete.canonical ?? []).filter((entry) => String(entry?.state ?? entry?.lifecycleState ?? "CANONICAL").toUpperCase() !== "CANONICAL");
    if (invalidCanonical.length) reasons.push("invalid_canonical_state");
    const archive = await this.#archiveConsistencyReport();
    if (!archive.valid) reasons.push("archive_index_inconsistent");
    return {
      valid: reasons.length === 0,
      reasons,
      fingerprints: { live: liveFingerprint, durable: durableFingerprint, match: durableProjection ? liveFingerprint === durableFingerprint : true },
      counts: Object.fromEntries(this.#collections().map((collection) => [collection, complete[collection]?.length ?? 0])),
      canonicalCount: complete.canonical?.length ?? 0,
      tombstoneCount: complete.tombstones?.length ?? 0,
      duplicateIds,
      archive,
    };
  }

  #validateKnownRepair(repair = {}) {
    if (!repair || typeof repair !== "object" || Array.isArray(repair) || repair.kind !== "known-consistency-repair" || Number(repair.version ?? 1) !== 1) {
      throw new ValidationError("Evolution reconciliation only accepts a versioned known-consistency-repair transaction");
    }
    const ids = [repair.candidateId, repair.rejectedProposalId, repair.supersededProposalId];
    if (ids.some((value) => typeof value !== "string" || value.trim() === "")) throw new ValidationError("Known consistency repair requires candidate and proposal ids");
    if (new Set(ids).size !== ids.length) throw new ValidationError("Known consistency repair ids must be distinct");
    if (repair.supersededBy !== undefined && repair.supersededBy !== null && typeof repair.supersededBy !== "string") throw new ValidationError("Known consistency repair supersededBy must be a string or null");
    return {
      version: 1,
      kind: repair.kind,
      candidateId: repair.candidateId,
      rejectedProposalId: repair.rejectedProposalId,
      supersededProposalId: repair.supersededProposalId,
      supersededBy: repair.supersededBy ?? null,
      reason: typeof repair.reason === "string" && repair.reason.trim() ? repair.reason.slice(0, 240) : "known_live_projection_reconciliation",
    };
  }

  #knownRepairChanges(repair) {
    const spec = this.#validateKnownRepair(repair);
    const complete = this.fullSnapshot();
    const changes = [];
    const update = (collection, idValue, patch) => {
      const index = (complete[collection] ?? []).findIndex((entry) => String(entry?.id ?? "") === idValue);
      if (index < 0) throw new ValidationError("Known consistency repair target was not found", { collection, id: idValue });
      const before = clone(complete[collection][index]);
      const after = {
        ...before,
        ...patch,
        ...(patch.reconciledAt ? { reconciledAt: before.reconciledAt ?? patch.reconciledAt } : {}),
      };
      complete[collection][index] = after;
      if (JSON.stringify(stableMemoryValue(before)) !== JSON.stringify(stableMemoryValue(after))) changes.push({ collection, before, after });
      return after;
    };
    const now = timestamp(this.clock);
    update("candidates", spec.candidateId, {
      status: "reverted",
      state: "REVERTED",
      lifecycleState: "REVERTED",
      retirementState: "OBSOLETE",
      auditClassification: "OBSOLETE",
      auditSource: "formal-live-owner-reconciliation",
      auditReason: spec.reason,
      executionAllowed: false,
      executable: false,
      lastDecision: "obsolete_consistency_repair",
      reconciledAt: now,
    });
    update("proposals", spec.rejectedProposalId, {
      status: "REJECTED",
      state: "REJECTED",
      lifecycleState: "REJECTED",
      retirementState: "OBSOLETE",
      auditClassification: "OBSOLETE",
      auditSource: "formal-live-owner-reconciliation",
      auditReason: spec.reason,
      executionAllowed: false,
      executable: false,
      reconciledAt: now,
    });
    const duplicate = update("proposals", spec.supersededProposalId, {
      status: "SUPERSEDED",
      state: "SUPERSEDED",
      lifecycleState: "SUPERSEDED",
      retirementState: "OBSOLETE",
      auditClassification: "OBSOLETE",
      auditSource: "formal-live-owner-reconciliation",
      auditReason: spec.reason,
      supersededBy: spec.supersededBy,
      executionAllowed: false,
      executable: false,
      reconciledAt: now,
    });
    const tombstoneId = "tombstone:reconciliation:" + spec.supersededProposalId;
    const tombstone = {
      ...tombstoneFor("proposals", duplicate, { reason: "superseded", replacedBy: spec.supersededBy }),
      id: tombstoneId,
      state: "TOMBSTONE",
      lifecycleState: "SUPERSEDED",
      retirementState: "OBSOLETE",
      retention: "TOMBSTONE",
      auditClassification: "OBSOLETE",
      auditSource: "formal-live-owner-reconciliation",
      auditReason: spec.reason,
      replacedBy: spec.supersededBy,
      reconciledAt: now,
    };
    const tombstoneIndex = (complete.tombstones ?? []).findIndex((entry) => String(entry?.id ?? "") === tombstoneId || (String(entry?.recordId ?? "") === spec.supersededProposalId && entry?.sourceCollection === "proposals"));
    if (tombstoneIndex < 0) {
      complete.tombstones.push(tombstone);
      changes.push({ collection: "tombstones", before: null, after: tombstone });
    } else {
      const before = clone(complete.tombstones[tombstoneIndex]);
      const after = { ...before, ...tombstone, id: before.id ?? tombstoneId, reconciledAt: before.reconciledAt ?? tombstone.reconciledAt };
      complete.tombstones[tombstoneIndex] = after;
      if (JSON.stringify(stableMemoryValue(before)) !== JSON.stringify(stableMemoryValue(after))) changes.push({ collection: "tombstones", before, after });
    }
    return { spec, changes, complete };
  }

  async #applyReconciliationChanges(changes) {
    const archiveInverse = [];
    for (const change of changes) {
      const entries = this.#data[change.collection];
      const hotIndex = entries.findIndex((entry) => String(entry?.id ?? "") === String(change.after?.id ?? ""));
      if (hotIndex >= 0) {
        entries[hotIndex] = clone(change.after);
        continue;
      }
      if (change.before === null) {
        entries.push(clone(change.after));
        const hotLimit = this.#hotLimit(change.collection);
        if (entries.length > hotLimit) entries.splice(0, entries.length - hotLimit);
        continue;
      }
      if (!this.archiveFile) throw new ValidationError("Reconciliation target is outside the hot projection");
      if (!this.archiveKnown.has(change.collection)) this.#readArchiveSync(change.collection);
      if (!this.archiveKnown.get(change.collection)?.has(this.#archiveKey(change.after))) throw new ValidationError("Reconciliation target is not present in the owning archive", { collection: change.collection, id: change.after?.id ?? null });
      if (!await this.#archiveEntries(change.collection, [change.after], { replaceExisting: true })) throw new Error("Evolution reconciliation archive update failed");
      archiveInverse.push({ collection: change.collection, entry: change.before });
    }
    return archiveInverse;
  }

  /**
   * Reconcile the already-loaded owning memory with the latest durable
   * partition, optionally applying one fixed-shape, known consistency repair.
   * This is deliberately not a general state mutation API: callers cannot
   * select collections, replace arrays, or delete historical records.
   */
  async reconcile({ transaction = null, repair = null, expectedFingerprint = null } = {}) {
    this.#assertMutation("evolution.memory.reconcile");
    if (!transaction || transaction.kind !== "evolution-reconciliation" || Number(transaction.version ?? 1) !== 1) throw new ValidationError("Evolution reconciliation requires a versioned evolution-reconciliation transaction");
    if (repair) this.#validateKnownRepair(repair);
    await this.#ensureLoaded();
    await this.archiveWriting;
    await this.archiveIndexWriting;
    await this.saving;
    const oldData = clone(this.#data);
    const durableState = typeof this.stateStore?.load === "function" ? await this.stateStore.load({ resolveSnapshot: false }) : null;
    const durable = durableState?.[this.key] && typeof durableState[this.key] === "object" ? durableState[this.key] : null;
    if (!durable) throw new ValidationError("Owning EvolutionMemory durable partition is unavailable");
    const beforeFingerprint = memoryStateFingerprint(this.#memoryProjection(this.#data));
    const durableFingerprint = memoryStateFingerprint(this.#memoryProjection(durable));
    if (expectedFingerprint && expectedFingerprint !== durableFingerprint) throw new ValidationError("Evolution reconciliation durable baseline changed", { expected: expectedFingerprint, actual: durableFingerprint });
    const archiveInverse = [];
    try {
      await this.#adoptDurableProjection(durable);
      const repairReport = repair ? this.#knownRepairChanges(repair) : { spec: null, changes: [], complete: this.fullSnapshot() };
      archiveInverse.push(...await this.#applyReconciliationChanges(repairReport.changes));
      await this.#save();
      await this.archiveWriting;
      await this.archiveIndexWriting;
      const verification = await this.verifyConsistency();
      if (!verification.valid) throw new ValidationError("Evolution reconciliation verifier failed", { reasons: verification.reasons });
      return {
        status: repairReport.changes.length ? "reconciled" : beforeFingerprint === durableFingerprint ? "unchanged" : "refreshed",
        transaction: { kind: transaction.kind, version: 1 },
        repair: repairReport.spec ? { kind: repairReport.spec.kind, candidateId: repairReport.spec.candidateId, rejectedProposalId: repairReport.spec.rejectedProposalId, supersededProposalId: repairReport.spec.supersededProposalId, changed: repairReport.changes.length > 0 } : null,
        fingerprints: { before: beforeFingerprint, durable: durableFingerprint, after: verification.fingerprints.live, durableAfter: verification.fingerprints.durable, match: verification.fingerprints.match },
        verification,
        flushed: true,
      };
    } catch (error) {
      this.#data = oldData;
      let rollbackError = null;
      for (const inverse of [...archiveInverse].reverse()) {
        if (!inverse.entry) continue;
        try { await this.#archiveEntries(inverse.collection, [inverse.entry], { replaceExisting: true }); } catch (inverseError) { rollbackError = inverseError; }
      }
      try { await this.#save(); } catch (saveError) { rollbackError = rollbackError ?? saveError; }
      if (rollbackError) {
        error.reconciliationRollback = { status: "rollback_failed", message: rollbackError?.message ?? String(rollbackError) };
      } else {
        error.reconciliationRollback = { status: "rolled_back" };
      }
      throw error;
    }
  }

  async #save() {
    // Housekeeping: pure deterministic local pass, zero LLM/token, auto on every save
    // This ensures hot pools stay clean before any durable write.
    try { this.#performHousekeeping(); } catch {}
    if (!this.stateStore) return;
    const transaction = this.transaction;
    if (transaction) {
      // Partition commit: write only this partition and keep the stored
      // aggregate as the last complete snapshot. Rebuilding it here would
      // re-create and re-fingerprint the full runtime state per append.
      // With an inline-capable store the bytes are captured synchronously
      // next to the fingerprint stamp, so a live shallow view of the
      // collections is safe and the whole-partition deep clone disappears.
      const inline = this.stateStore.inlineSerialization === true;
      const payload = inline ? { ...this.#data } : this.snapshot();
      await transaction.persist((state) => ({ ...state, [this.key]: payload }), { includeSnapshot: false, generateSnapshot: false, inlineSerialize: inline, metadata: { partition: this.key } });
      return;
    }
    // No transaction bound: fall back to a direct partition write. The
    // snapshot clone keeps the queued write stable against later live
    // mutations (there is no fused capture to pin the bytes here).
    const next = this.snapshot();
    const write = async () => {
      if (typeof this.stateStore.update === "function") {
        await this.stateStore.update((state) => ({ ...state, [this.key]: next }));
      } else if (typeof this.stateStore.save === "function") {
        const state = await this.stateStore.load({ resolveSnapshot: false });
        await this.stateStore.save({ ...state, [this.key]: next });
      }
    };
    this.saving = this.saving.then(write, write);
    await this.saving;
  }

  // ---------------------------------------------------------------------------
  // Housekeeping: pure, deterministic, zero LLM/token, auto on save/compaction/cycle
  // ---------------------------------------------------------------------------
  // Rules (all local, no provider):
  // - OBSOLETE / REVERTED -> removed from hot, tombstoned, archived
  // - PROMOTED -> removed from pending candidates/proposals, kept in lineage/history
  // - duplicate healthy heartbeat / info -> compacted/aggregated
  // - duplicate candidate/proposal -> merged by fingerprint, canonical kept
  // - terminated proposals never return to hot (tombstone guard)
  // - NEEDS_EVIDENCE -> preserved as observation, not auto-executed
  // - analyzer/terminal must be durable-state based (snapshot is durable)
  // - only unterminated candidates/proposals remain hot
  #performHousekeeping() {
    // Pure, no async, no LLM, no token, no network.
    try {
      // 1) OBSOLETE / REVERTED hot cleanup - only for promotions/strategies to keep experiments for blocked history
      for (const coll of ["promotions", "strategies", "experimentRecords"]) {
        const arr = this.#data[coll];
        if (!Array.isArray(arr) || arr.length === 0) continue;
        const hotLimit = this.#hotLimit(coll);
        const hotStart = Math.max(0, arr.length - hotLimit);
        // Collect obsolete inside hot
        const toRemove = [];
        for (let i = hotStart; i < arr.length; i++) {
          const entry = arr[i];
          // A failed strategy is negative evidence for future selection, not
          // an obsolete record; keep it inspectable and resolver-filterable.
          const terminal = isTerminalRetirement(entry)
            && !(coll === "strategies" && lifecycleState(entry) === "FAILED");
          if (isHousekeepingObsolete(entry) || terminal) {
            toRemove.push(entry);
            const exists = this.#data.tombstones.find((t) => t.recordId === entry.id || t.fingerprint === (entry.fingerprint ?? entry.candidateFingerprint));
            if (!exists) this.#data.tombstones.push(tombstoneFor(coll, entry, { reason: lifecycleState(entry).toLowerCase() || "obsolete" }));
          }
        }
        if (toRemove.length) {
          const removeSet = new Set(toRemove);
          this.#data[coll] = arr.filter((e) => !removeSet.has(e));
        }
      }
      // 2) PROMOTED pending cleanup: keep in durable memory for lineage/audit/test visibility.
      // PROMOTED is not "pending" — pending accounting uses status (awaiting_confirmation/proposed),
      // not array membership. The verifier counts PROMOTED PENDING=0 via status, not physical ejection.
      // Do NOT physically remove promoted candidates: tests assert candidates[0].status === "promoted",
      // and lineage/history retention is a requirement. This is a zero-LLM local decision.
      void 0;
      // 3) Duplicate heartbeat / info observation compaction: handled by the existing #retentionPlan
      // (compactObservationRecord / compactObservationAggregate / isConsolidatableObservation),
      // which already dedupes healthy info observations and preserves error signals / forceRecord /
      // significant perf transitions. Not duplicated here to keep cycle identity and tests stable.
      void 0;
      // 4) Duplicate candidates/proposals merged by fingerprint (keep canonical)
      for (const coll of ["candidates", "proposals"]) {
        const arr = this.#data[coll];
        if (!Array.isArray(arr) || arr.length < 2) continue;
        const byFp = new Map();
        for (const entry of arr) {
          const fp = entry.candidateFingerprint ?? entry.fingerprint ?? candidateFingerprint(entry, entry.problemFingerprint ?? problemFingerprint(entry));
          if (!byFp.has(fp)) byFp.set(fp, []);
          byFp.get(fp).push(entry);
        }
        for (const group of byFp.values()) {
          if (group.length < 2) continue;
          let best = group[0];
          for (const e of group.slice(1)) {
            const bestScore = Number(best.fitnessScore ?? best.fitness ?? 0);
            const eScore = Number(e.fitnessScore ?? e.fitness ?? 0);
            const bestTime = String(best.lastSeen ?? best.recordedAt ?? "");
            const eTime = String(e.lastSeen ?? e.recordedAt ?? "");
            if (eScore > bestScore || (eScore === bestScore && eTime > bestTime)) best = e;
          }
          for (const e of group) {
            if (e === best) continue;
            const idx = arr.indexOf(e);
            if (idx >= 0) arr.splice(idx, 1);
            if (!this.#data.tombstones.find((t) => t.recordId === e.id)) {
              this.#data.tombstones.push(tombstoneFor(coll, e, { reason: "duplicate" }));
            }
          }
        }
      }
      // 5) Terminated proposals never back to hot (tombstone guard)
      // Without a cold archive, this in-memory data is also the complete
      // durable projection; retain reconciled records for fullSnapshot().
      for (const coll of ["candidates", "proposals"]) {
        if (!this.archiveFile) continue;
        const arr = this.#data[coll];
        if (!Array.isArray(arr)) continue;
        const tombFp = new Set(this.#data.tombstones.map((t) => t.candidateFingerprint ?? t.fingerprint).filter(Boolean));
        const tombIds = new Set(this.#data.tombstones.map((t) => t.recordId).filter(Boolean));
        const filtered = arr.filter((entry) => {
          // A terminal record still in hot has not crossed the archive
          // boundary; retain it until that durable handoff exists.
          if (!this.archiveKnown.get(coll)?.has(this.#archiveKey(entry))) return true;
          const fp = entry.candidateFingerprint ?? entry.fingerprint ?? candidateFingerprint(entry, entry.problemFingerprint ?? problemFingerprint(entry));
          if (fp && tombFp.has(fp) && (isTerminalRetirement(entry) || isHousekeepingObsolete(entry))) return false;
          if (entry.id && tombIds.has(entry.id) && (isTerminalRetirement(entry) || isHousekeepingObsolete(entry))) return false;
          return true;
        });
        if (filtered.length !== arr.length) this.#data[coll] = filtered;
      }
      // 6) NEEDS_EVIDENCE preserved: ensure not auto-removed (they are hot candidates)
      // No removal; they stay. Housekeeping explicitly does not treat NEEDS_EVIDENCE as obsolete.
      // 7) Only unterminated hot (enforce hot pool only unterminated) - handles candidates and proposals but only obsolete/terminal are ejected
      // Without a cold archive, the in-memory partition is the only durable
      // history available to fullSnapshot(); never erase reconciled records.
      for (const coll of ["candidates", "proposals"]) {
        if (!this.archiveFile) continue;
        const arr = this.#data[coll];
        if (!Array.isArray(arr)) continue;
        const hotLimit = this.#hotLimit(coll);
        const hotStart = Math.max(0, arr.length - hotLimit);
        const toEject = [];
        for (let i = hotStart; i < arr.length; i++) {
          const entry = arr[i];
          if (isHousekeepingNeedsEvidence(entry)) continue;
          // Reconciliation can update a hot terminal record directly. Do not
          // delete it until the owning archive contains the replacement.
          if (!this.archiveKnown.get(coll)?.has(this.#archiveKey(entry))) continue;
          if (isHousekeepingObsolete(entry) || isTerminalRetirement(entry)) toEject.push(entry);
        }
        if (toEject.length) {
          const ejectSet = new Set(toEject);
          this.#data[coll] = arr.filter((e) => !ejectSet.has(e));
          for (const e of toEject) {
            if (!this.#data.tombstones.find((t) => t.recordId === e.id)) {
              this.#data.tombstones.push(tombstoneFor(coll, e, { reason: lifecycleState(e).toLowerCase() || "terminal" }));
            }
          }
        }
      }
    } catch {}
  }

  // Public deterministic alias for cycle/compaction callers (still zero LLM/token)
  housekeeping() { return this.#performHousekeeping(); }
  _runHousekeeping() { return this.#performHousekeeping(); }
  performHousekeeping() { return this.#performHousekeeping(); }

  /** Ensure the durable collections are resident without cloning them. */
  async #ensureLoaded() {
    if (this.loaded) return;
    if (this.loading) { await this.loading; return; }
    await this.load();
  }

  #enqueueMutation(task) {
    const queued = this.mutationQueue.then(task, task);
    this.mutationQueue = queued.catch(() => {});
    return queued;
  }

  #knowledgeEntryFor(event) {
    if (!event?.knowledgeKey) return null;
    return this.history("knowledge").find((entry) => entry?.knowledgeKey === event.knowledgeKey || entry?.id === event.knowledgeKey) ?? null;
  }

  async #upsertKnowledgeUnlocked(value = {}, { sourceCollection = "event", persist = false } = {}) {
    const event = normalizeKnowledgeEvent(value, { sourceCollection, now: timestamp(this.clock) });
    if (!event) return { accepted: false, duplicate: false, reason: "not-knowledge-bearing", event: null, knowledge: null };
    const previous = this.#knowledgeEntryFor(event);
    if (isDuplicateKnowledgeEvent(previous, event)) return { accepted: true, duplicate: true, event, knowledge: clone(previous) };
    const knowledge = mergeKnowledgeEntry(previous, event, { now: this.clock() });
    const hotIndex = this.#data.knowledge.findIndex((entry) => entry?.knowledgeKey === event.knowledgeKey || entry?.id === event.knowledgeKey);
    if (hotIndex >= 0) this.#data.knowledge[hotIndex] = knowledge;
    else if (previous && this.archiveFile && this.archiveKnown.get("knowledge")?.has(this.#archiveKey(previous))) {
      await this.#archiveEntries("knowledge", [knowledge], { replaceExisting: true });
    } else this.#data.knowledge.push(knowledge);
    if (this.archiveFile && this.#data.knowledge.length > this.#hotLimit("knowledge")) {
      const evictCount = this.#data.knowledge.length - this.#hotLimit("knowledge");
      const evicted = this.#data.knowledge.slice(0, evictCount);
      if (await this.#archiveEntries("knowledge", evicted)) this.#data.knowledge.splice(0, evictCount);
    } else if (!this.archiveFile && this.#data.knowledge.length > this.maxEntries) {
      this.#data.knowledge.splice(0, this.#data.knowledge.length - this.maxEntries);
    }
    if (persist) await this.#save();
    return { accepted: true, duplicate: false, event, knowledge: clone(knowledge) };
  }

  #sourceMatches(collection, event) {
    if (!event?.knowledgeKey || !this.#collections().includes(collection) || collection === "knowledge") return [];
    return this.history(collection).filter((entry) => {
      if (entry?.knowledgeKey === event.knowledgeKey) return true;
      const normalized = normalizeKnowledgeEvent(entry, { sourceCollection: collection, now: timestamp(this.clock) });
      return normalized?.knowledgeKey === event.knowledgeKey;
    });
  }

  #shouldRetainSource(collection, next, event, matches, previousKnowledge) {
    if (collection === "cycles") return true;
    if (!event) return true;
    if (next.forceRecord === true || event.forceRecord || isKnowledgeCritical(event, { collection })) return true;
    if (next.id && matches.some((entry) => String(entry?.id ?? "") === String(next.id))) return true;
    if (collection === "observations" && Object.keys(event.metrics ?? {}).length > 0) {
      const materialMetricTransition = Object.entries(event.metrics).some(([key, value]) => matches.every((entry) => {
        const prior = normalizeKnowledgeEvent(entry, { sourceCollection: collection, now: timestamp(this.clock) })?.metrics?.[key];
        if (prior === undefined || prior === null) return true;
        const incoming = Number(value);
        const previous = Number(prior);
        return Number.isFinite(incoming) && Number.isFinite(previous) && Math.abs(incoming - previous) / Math.max(1, Math.abs(previous)) > 0.05;
      }));
      if (materialMetricTransition) return true;
    }
    // Failed strategies are durable negative evidence: keep the source row so
    // the resolver can exclude it by successRate while callers can inspect why.
    if (collection === "strategies" && (next.success === false || next.status === "failed" || next.decision === "failure")) return true;
    if ((collection === "strategies" || collection === "promotions") && matches.length > 0) {
      const exactVariant = matches.some((entry) => {
        const prior = normalizeKnowledgeEvent(entry, { sourceCollection: collection, now: timestamp(this.clock) });
        return prior?.outcome === event.outcome && prior?.status === event.status && prior?.fitness === event.fitness;
      });
      if (exactVariant) return false;
    }
    const previousStatus = String(previousKnowledge?.lastStatus ?? "");
    if (previousStatus && event.status && previousStatus !== event.status) return true;
    if (previousKnowledge?.lastOutcome && previousKnowledge.lastOutcome !== event.outcome && event.outcome !== "neutral") return true;
    // Different measured strategy fitness is independent evidence; an exact
    // replay remains one source representative.
    if ((collection === "strategies" || collection === "promotions") && event.fitness !== null) {
      const hasSameFitness = matches.some((entry) => Number(entry?.fitnessScore ?? entry?.fitness) === event.fitness);
      if (!hasSameFitness) return true;
    }
    return matches.length < sourceRetentionLimit(event, { collection });
  }

  async #append(collection, value) {
    this.#assertMutation("evolution.memory." + collection);
    return this.#enqueueMutation(async () => {
      await this.#ensureLoaded();
      const next = safeRecord({ ...value, recordedAt: value.recordedAt ?? timestamp(this.clock) });
      const collectionEntries = this.#data[collection];
      if (!Array.isArray(collectionEntries)) throw new ValidationError("Unknown evolution memory collection: " + collection);
      const event = collection === "knowledge" ? null : normalizeKnowledgeEvent(next, { sourceCollection: collection, now: timestamp(this.clock) });
      const previousKnowledge = event ? this.#knowledgeEntryFor(event) : null;
      const knowledgeResult = event ? await this.#upsertKnowledgeUnlocked(next, { sourceCollection: collection }) : null;
      if (event) {
        next.knowledgeKey = event.knowledgeKey;
        next.knowledgeDimensions = event.dimensions;
      }
      const matches = event ? this.#sourceMatches(collection, event) : [];
      const existingId = next.id ? collectionEntries.findIndex((entry) => String(entry?.id) === String(next.id)) : -1;
      const retainSource = this.#shouldRetainSource(collection, next, event, matches, previousKnowledge);
      // Event-ledger replay is exactly-once for the accumulator and source;
      // forceRecord remains the explicit escape hatch for a new audit sample.
      if (knowledgeResult?.duplicate === true && existingId < 0 && next.forceRecord !== true) {
        await this.#save();
        return clone(matches.at(-1) ?? knowledgeResult.knowledge ?? next);
      }
      if (!retainSource && existingId < 0) {
        await this.#save();
        return clone(matches.at(-1) ?? knowledgeResult?.knowledge ?? next);
      }
      let merged = next;
      if (existingId >= 0) {
        merged = { ...collectionEntries[existingId], ...next };
        collectionEntries[existingId] = merged;
      } else collectionEntries.push(next);

      if (this.archiveFile && next.id && Number(this.#data.coldArchives?.[collection]?.count) > 0) {
        if (!this.archiveKnown.has(collection)) this.#readArchiveSync(collection);
        const archivedHas = this.archiveKnown.get(collection)?.has(this.#archiveKey(next)) === true;
        if (archivedHas) await this.#archiveEntries(collection, [merged], { replaceExisting: true });
      }
      if (this.archiveFile && collectionEntries.length > this.#hotLimit(collection)) {
        const evictCount = collectionEntries.length - this.#hotLimit(collection);
        const evicted = collectionEntries.slice(0, evictCount);
        if (await this.#archiveEntries(collection, evicted)) collectionEntries.splice(0, evictCount);
      } else if (!this.archiveFile && collectionEntries.length > this.maxEntries) {
        collectionEntries.splice(0, collectionEntries.length - this.maxEntries);
      }
      await this.#save();
      const result = next.id ? collectionEntries.find((entry) => String(entry?.id) === String(next.id)) : collectionEntries.at(-1);
      return clone(result ?? merged);
    });
  }

  recordObservation(value) { return this.#append("observations", value); }
  recordDiagnosis(value) { return this.#append("diagnoses", value); }
  recordGap(value) { return this.#append("gaps", value); }
  async recordCandidate(value = {}) {
    const problem = value.problemFingerprint ?? problemFingerprint(value);
    const fingerprint = value.candidateFingerprint ?? candidateFingerprint(value, problem);
    const previous = this.#data.candidates.find((entry) => entry.candidateFingerprint === fingerprint
      || candidateFingerprint(entry, problem) === fingerprint);
    const status = String(value.status ?? previous?.status ?? "candidate").toLowerCase();
    const failure = ["failed", "rejected", "rolled_back", "rollback", "superseded"].includes(status);
    if (!previous && failure) {
      const tombstone = this.history("tombstones").find((entry) => entry.candidateFingerprint === fingerprint
        || candidateFingerprint(entry, problem) === fingerprint);
      if (tombstone) {
        await this.recordTombstone({
          ...tombstone,
          id: tombstone.id,
          count: Number(tombstone.count ?? 1) + 1,
          lastSeen: timestamp(this.clock),
          failureCount: Number(tombstone.failureCount ?? tombstone.count ?? 1) + 1,
        });
        return clone({ id: tombstone.recordId ?? tombstone.id, status: "tombstoned", retention: "TOMBSTONE", problemFingerprint: problem, candidateFingerprint: fingerprint, matchedPreviousFailure: true });
      }
    }
    const merged = {
      ...value,
      ...(previous ? { id: previous.id, occurrenceCount: Number(previous.occurrenceCount ?? 1) + 1, firstSeen: previous.firstSeen ?? previous.recordedAt ?? null } : {}),
      problemFingerprint: problem,
      candidateFingerprint: fingerprint,
      candidateGroup: value.candidateGroup ?? problem,
      lastSeen: timestamp(this.clock),
      ...(failure ? { failureCount: Number(previous?.failureCount ?? 0) + 1, matchedPreviousFailure: Boolean(previous) } : {}),
    };
    return this.#append("candidates", merged);
  }
  async recordProposal(value = {}) {
    const problem = value.problemFingerprint ?? problemFingerprint(value);
    const fingerprint = value.candidateFingerprint ?? candidateFingerprint(value, problem);
    const previous = this.#data.proposals.find((entry) => entry.problemFingerprint === problem
      && (entry.candidateFingerprint === fingerprint || candidateFingerprint(entry, problem) === fingerprint));
    const merged = {
      ...value,
      ...(previous ? { id: previous.id, occurrenceCount: Number(previous.occurrenceCount ?? 1) + 1, firstSeen: previous.firstSeen ?? previous.proposedAt ?? previous.recordedAt ?? null } : {}),
      problemFingerprint: problem,
      candidateFingerprint: fingerprint,
      candidateGroup: value.candidateGroup ?? problem,
      occurrenceCount: previous ? Number(previous.occurrenceCount ?? 1) + 1 : Number(value.occurrenceCount ?? 1),
      lastSeen: timestamp(this.clock),
      evidenceSummary: safeRecord(value.evidenceSummary ?? value.evidence ?? {}),
    };
    return this.#append("proposals", merged);
  }
  recordExperiment(value) { return this.#append("experiments", value); }
  recordExperimentRecord(value) {
    return this.#append("experimentRecords", {
      problem: value?.problem ?? null,
      hypothesis: value?.hypothesis ?? null,
      change: safeRecord(value?.change ?? {}),
      experiment: safeRecord(value?.experiment ?? {}),
      baselineMetrics: safeRecord(value?.baselineMetrics ?? {}),
      candidateMetrics: safeRecord(value?.candidateMetrics ?? {}),
      decision: value?.decision ?? null,
      finalResult: safeRecord(value?.finalResult ?? {}),
      ...value,
    });
  }
  recordJournal(value) { return this.#append("journal", { sequence: value?.sequence ?? this.#data.journal.length + 1, ...value }); }
  recordSelection(value) { return this.#append("selections", value); }
  recordPromotion(value) { return this.#append("promotions", value); }
  recordCycle(value) { return this.#append("cycles", value); }
  recordLineage(value) { return this.#append("lineage", value); }
  recordTombstone(value) { return this.#append("tombstones", value); }

  /** Upsert only the bounded canonical knowledge row; no raw event is appended.
   * `persist: false` is reserved for callers that are already inside a larger
   * durable operation and will commit the same memory partition before return.
   */
  async recordKnowledgeEvent(value = {}, { sourceCollection = "event", persist = true } = {}) {
    this.#assertMutation("evolution.memory.knowledge");
    return this.#enqueueMutation(async () => {
      await this.#ensureLoaded();
      const result = await this.#upsertKnowledgeUnlocked(value, { sourceCollection });
      if (result.accepted && persist) await this.#save();
      return result.knowledge ? clone(result.knowledge) : result;
    });
  }

  recordKnowledge(value = {}, options = {}) { return this.recordKnowledgeEvent(value, options); }

  knowledgeSnapshot() { return this.history("knowledge"); }
  canonicalKnowledgeSnapshot() { return this.knowledgeSnapshot(); }

  #bridgeApplied(eventId) {
    return (this.#data.eventBridge?.applied ?? []).some((entry) => String(entry?.eventId ?? entry) === eventId);
  }

  async #markBridgeApplied(event) {
    const applied = Array.isArray(this.#data.eventBridge?.applied) ? this.#data.eventBridge.applied : [];
    applied.push({
      eventId: event.eventId,
      eventType: event.eventType,
      experimentId: event.experimentId,
      appliedAt: timestamp(this.clock),
    });
    this.#data.eventBridge = { schema: 1, applied: applied.slice(-4096) };
    await this.#save();
  }

  #bridgeValidate(event = {}) {
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new ValidationError("Evolution execution event must be an object");
    if (Number(event.schema) !== 1) throw new ValidationError("Evolution execution event schema is unsupported");
    if (!EXECUTION_BRIDGE_EVENT_TYPES.has(String(event.eventType ?? ""))) throw new ValidationError("Unknown Evolution execution event type", { eventType: event.eventType ?? null });
    if (typeof event.eventId !== "string" || event.eventId.trim() === "") throw new ValidationError("Evolution execution event requires a stable eventId");
    if (typeof event.experimentId !== "string" || event.experimentId.trim() === "") throw new ValidationError("Evolution execution event requires experimentId");
    const expectedEventId = `evolution:${event.eventType}:${event.experimentId}`;
    if (event.eventId !== expectedEventId) throw new ValidationError("Evolution execution eventId is not deterministic", { expected: expectedEventId, actual: event.eventId });
    if (event.eventType === "failure-learned" && (typeof event.failureFingerprint !== "string" || event.failureFingerprint.trim() === "")) {
      throw new ValidationError("failure-learned event requires failureFingerprint");
    }
    return event;
  }

  async #bridgeOutcome(event, { status = "failure", signature = null } = {}) {
    const fingerprint = signature ?? event.failureFingerprint ?? `failure:event:${event.eventId}`;
    const idValue = `bridge:failure:${fingerprint}`;
    const current = this.#data.outcomes.find((entry) => entry.id === idValue);
    const seenExperiment = current?.experimentIds?.includes?.(event.experimentId) === true;
    return this.recordOutcome({
      id: idValue,
      status,
      signature: fingerprint,
      experimentId: event.experimentId,
      proposalId: event.proposalId ?? null,
      rootCause: event.failure?.rootCauseHypothesis ?? event.failure?.error ?? null,
      failure: safeRecord(event.failure ?? {}),
      count: Number(current?.count ?? 0) + (seenExperiment ? 0 : 1),
      experimentIds: [...new Set([...(current?.experimentIds ?? []), event.experimentId])].slice(-64),
      dontRepeat: status !== "success",
      source: "dsh-evolution-orchestrator",
      recordedAt: event.audit?.at ?? timestamp(this.clock),
    });
  }

  /**
   * Apply one minimal execution fact from dsh-evolution-orchestrator. The
   * event ledger provides durable at-least-once replay with business-level
   * exactly-once effects; every projected record uses a deterministic id.
   */
  async applyExecutionEvent(input = {}) {
    this.#assertMutation("evolution.memory.bridge.apply");
    await this.#ensureLoaded();
    const event = this.#bridgeValidate(input);
    if (this.#bridgeApplied(event.eventId)) return { applied: false, duplicate: true, eventId: event.eventId, stats: this.stats() };
    const experimentId = event.experimentId;
    const proposalId = event.proposalId ?? experimentId;
    const target = event.target ?? event.capability ?? "unknown";
    const capability = String(event.capability ?? target);
    const lineageId = String(event.lineageId ?? capability);
    const experimentRecordId = `bridge:experiment:${experimentId}`;
    const promotionId = event.promotion?.promotionId ?? event.promotion?.id ?? `bridge:promotion:${experimentId}`;
    const base = {
      experimentId,
      proposalId,
      target,
      capabilityId: capability,
      lineageId,
      source: "dsh-evolution-orchestrator",
      bridgeEventId: event.eventId,
      predecessor: event.predecessor ?? null,
      supersedes: event.supersedes ?? null,
      recordedAt: event.audit?.at ?? timestamp(this.clock),
    };
    switch (event.eventType) {
      case "proposal-created":
        await this.recordProposal({
          id: `bridge:proposal:${proposalId}`,
          status: "proposed",
          problem: target,
          target,
          capabilityId: capability,
          lineageId,
          experimentId,
          source: base.source,
          bridgeEventId: event.eventId,
          recordedAt: base.recordedAt,
        });
        break;
      case "trial-completed":
      case "measurement-completed":
      case "experiment-rejected":
        await this.recordExperiment({
          id: experimentRecordId,
          ...base,
          status: event.eventType === "experiment-rejected" ? "rejected" : event.eventType === "measurement-completed" ? "measured" : "trial-completed",
          measurement: safeRecord(event.measurement ?? {}),
          evidence: safeRecord(event.evidence ?? {}),
          failureFingerprint: event.failureFingerprint ?? null,
        });
        if (event.eventType === "experiment-rejected" && event.failureFingerprint) await this.#bridgeOutcome(event);
        break;
      case "failure-learned":
        await this.recordExperiment({
          id: `bridge:failure-experiment:${event.failureFingerprint}`,
          ...base,
          status: "failed",
          failureFingerprint: event.failureFingerprint,
          failure: safeRecord(event.failure ?? {}),
          evidence: safeRecord(event.evidence ?? {}),
        });
        await this.#bridgeOutcome(event);
        break;
      case "promotion-succeeded":
      case "promotion-reverted":
      case "canary-failed":
        await this.recordPromotion({
          id: `bridge:promotion:${promotionId}`,
          ...base,
          promotionId,
          status: event.eventType === "promotion-reverted" ? "reverted" : event.eventType === "canary-failed" ? "canary-failed" : "promoted",
          promotion: safeRecord(event.promotion ?? {}),
          canary: safeRecord(event.canary ?? {}),
          evidence: safeRecord(event.evidence ?? {}),
        });
        if (event.eventType !== "promotion-succeeded" && event.failureFingerprint) await this.#bridgeOutcome(event);
        break;
      case "canary-passed": {
        const promotion = await this.recordPromotion({
          id: `bridge:promotion:${promotionId}`,
          ...base,
          promotionId,
          status: "stable",
          promotion: safeRecord(event.promotion ?? {}),
          canary: safeRecord(event.canary ?? {}),
          evidence: safeRecord(event.evidence ?? {}),
        });
        const latest = this.history("lineage").filter((entry) => String(entry.lineageId ?? "") === lineageId).at(-1);
        const generation = Number(latest?.generation ?? 0) + 1;
        const strategy = await this.recordStrategy({
          id: `bridge:strategy:${experimentId}`,
          status: "promoted",
          decision: "promote",
          strategy: { target, capability },
          strategyKey: capability,
          lineageId,
          sourceExperimentId: experimentId,
          sourcePromotionId: promotionId,
          generationId: `bridge:generation:${lineageId}:${generation}`,
          generation,
          metrics: safeRecord(event.measurement ?? {}),
          evidence: { bridgeEventId: event.eventId, canary: safeRecord(event.canary ?? {}), promotion: safeRecord(event.promotion ?? {}) },
          stabilityVerified: true,
          regressionPassed: true,
          validationRuns: 1,
          fitnessScore: Number(event.evidence?.fitnessScore ?? 1),
          recordedAt: base.recordedAt,
        });
        const lineage = await this.recordLineage({
          id: `bridge:lineage:${lineageId}:${generation}`,
          lineageId,
          generation,
          version: `promotion:${promotionId}`,
          parentVersion: latest?.version ?? event.predecessor ?? null,
          target,
          experimentId,
          promotionId,
          decision: "promote",
          fitnessScore: Number(strategy.fitnessScore ?? 1),
          metricsAfter: safeRecord(event.measurement ?? {}),
          evidence: { eventId: event.eventId, canary: safeRecord(event.canary ?? {}) },
          recordedAt: base.recordedAt,
        });
        this.#data.provenance = {
          id: `provenance:${experimentId}:${promotionId}`,
          source: "dsh-evolution-orchestrator",
          eventId: event.eventId,
          experimentId,
          proposalId,
          promotionId,
          lineageId,
          target,
          recordedAt: base.recordedAt,
        };
        const canonical = await this.recordCanonical({
          record: strategy,
          sourceCollection: "strategies",
          capabilityId: capability,
          lineageId,
          recordId: strategy.id,
          strategyId: strategy.id,
          generationId: lineage.id,
          experimentId,
          promotionId,
          fitnessScore: Number(strategy.fitnessScore ?? 1),
          stabilityVerified: true,
          regressionPassed: true,
          validationRuns: 1,
          evidence: {
            eventId: event.eventId,
            promotionId,
            canaryPassed: true,
            evaluation: { eligible: true, evaluation: { validationRuns: 1 } },
          },
          updatedAt: base.recordedAt,
        });
        if (canonical.superseded?.recordId) {
          await this.recordTombstone({
            id: `tombstone:${canonical.superseded.recordId}`,
            state: "SUPERSEDED",
            lifecycleState: "SUPERSEDED",
            sourceCollection: "canonical",
            recordId: canonical.superseded.recordId,
            replacedBy: canonical.canonical?.recordId ?? canonical.canonical?.id ?? strategy.id,
            lineageId,
            signature: `superseded:${canonical.superseded.recordId}`,
            dontRepeat: false,
            recordIds: [canonical.superseded.recordId],
            count: 1,
            firstSeen: base.recordedAt,
            lastSeen: base.recordedAt,
          });
        }
        void promotion;
        break;
      }
      default:
        throw new ValidationError("Unknown Evolution execution event type", { eventType: event.eventType });
    }
    await this.#markBridgeApplied(event);
    return { applied: true, duplicate: false, eventId: event.eventId, eventType: event.eventType, stats: this.stats() };
  }

  async replayExecutionEvents({ filePath = this.eventBridgePath } = {}) {
    if (!filePath) return { status: "disabled", applied: 0, duplicates: 0 };
    let raw;
    try { raw = await readFile(filePath, "utf8"); } catch (error) {
      if (error?.code === "ENOENT") return { status: "empty", applied: 0, duplicates: 0, filePath };
      throw error;
    }
    let applied = 0;
    let duplicates = 0;
    for (const [index, line] of raw.split("\n").entries()) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch (error) { throw new ValidationError("Evolution execution event JSON is invalid", { line: index + 1, cause: error?.message ?? String(error) }); }
      const result = await this.applyExecutionEvent(event);
      if (result.duplicate) duplicates += 1;
      else if (result.applied) applied += 1;
    }
    return { status: "replayed", applied, duplicates, filePath };
  }

  /** Remove provisional promotion records after a failed cross-boundary commit. */
  async compensatePromotion({ promotionId = null, experimentId = null } = {}) {
    this.#assertMutation("evolution.memory.compensate");
    return this.#enqueueMutation(async () => {
      await this.load();
      const matches = (entry) => (promotionId && (entry.id === promotionId || entry.promotionId === promotionId)) || (experimentId && (entry.experimentId === experimentId || entry.sourceExperimentId === experimentId || entry.experiment?.id === experimentId));
      for (const collection of ["promotions", "strategies"]) this.#data[collection] = this.#data[collection].filter((entry) => !matches(entry));
      this.#data.learnings = this.#data.learnings.filter((entry) => !matches(entry) && entry.id !== (experimentId ? "learning:" + experimentId : "__none__"));
      const recovery = { reason: "promotion-compensated", promotionId, experimentId, restored: true };
      const affected = this.history("knowledge").filter((entry) => [...(entry?.sourceRefs ?? []), ...(entry?.relationRefs ?? [])].some((ref) => {
        const value = String(ref);
        return (promotionId && value.includes(String(promotionId))) || (experimentId && value.includes(String(experimentId)));
      }));
      for (const entry of affected) await this.#upsertKnowledgeUnlocked({
        ...entry,
        knowledgeKey: entry.knowledgeKey,
        eventId: "compensation:" + String(promotionId ?? experimentId ?? entry.knowledgeKey),
        correction: true,
        recovery,
      }, { sourceCollection: "recovery" });
      await this.#save();
      return { removed: true, promotionId, experimentId, affectedKnowledge: affected.length };
    });
  }

  /** Persist why a change worked, not only the event timeline. */
  recordLearning(value) {
    return this.#append("learnings", {
      problem: value?.problem ?? null,
      hypothesis: value?.hypothesis ?? null,
      change: safeRecord(value?.change ?? {}),
      experiment: safeRecord(value?.experiment ?? {}),
      metrics: safeRecord(value?.metrics ?? {}),
      decision: value?.decision ?? null,
      finalResult: safeRecord(value?.finalResult ?? {}),
      ...value,
    });
  }

  /** Store only a successful, declarative strategy reference; never persist executable hooks. */
  recordStrategyMutation(value = {}) {
    return this.#append("strategyMutations", {
      id: value.id ?? id("strategy-mutation"),
      parentStrategyId: value.parentStrategyId ?? value.parentId ?? null,
      parentStrategy: safeRecord(value.parentStrategy ?? {}),
      mutation: safeRecord(value.mutation ?? {}),
      candidateStrategy: safeRecord(value.candidateStrategy ?? value.candidate ?? {}),
      result: value.result ?? "candidate_generated",
      decision: value.decision ?? null,
      experimentId: value.experimentId ?? null,
      generationId: value.generationId ?? null,
      metrics: safeRecord(value.metrics ?? {}),
      fitness: value.fitness ?? null,
      recordedAt: value.recordedAt ?? timestamp(this.clock),
      ...value,
    });
  }

  recordStrategy(value = {}) {
    const definition = value.definition ?? (value.component && typeof value.component === "object" ? value.component : null) ?? value.manifest ?? {};
    const manifest = value.manifest ?? ((definition.id || definition.name) ? componentManifestFor(definition) : {});
    return this.#append("strategies", {
      id: value.id ?? id("strategy"),
      status: value.status ?? "promoted",
      decision: value.decision ?? "promote",
      problem: value.problem ?? null,
      hypothesis: value.hypothesis ?? null,
      strategy: value.strategy ?? value.name ?? value.strategyKey ?? null,
      strategyKey: value.strategyKey ?? value.id ?? null,
      strategyKeyGenerated: value.strategyKey === undefined && value.strategy === undefined && value.name === undefined,
      context: safeRecord(value.context ?? value.applicableConditions ?? {}),
      applicableConditions: safeRecord(value.applicableConditions ?? value.context ?? {}),
      failureConditions: safeRecord(value.failureConditions ?? {}),
      successCount: Number(value.successCount ?? (value.success === true ? 1 : 0)),
      failureCount: Number(value.failureCount ?? (value.success === false ? 1 : 0)),
      successRate: value.successRate ?? (value.success === true ? 1 : value.success === false ? 0 : null),
      // Explicit passthrough of caller-supplied retention facts. These never
      // feed decision math; they make canonical/supersede bookkeeping possible
      // without re-deriving them from opaque evidence blobs.
      ...(value.fitnessScore === undefined && value.fitness === undefined ? {} : { fitnessScore: Number(value.fitnessScore ?? value.fitness ?? 0) }),
      ...(value.stabilityVerified === undefined ? {} : { stabilityVerified: value.stabilityVerified === true }),
      ...(value.regressionPassed === undefined ? {} : { regressionPassed: value.regressionPassed === true }),
      ...(value.validationRuns === undefined ? {} : { validationRuns: Number(value.validationRuns) || 0 }),
      ...(value.lineageId === undefined && value.sourceGenerationId === undefined ? {} : { lineageId: value.lineageId === undefined ? null : String(value.lineageId) }),
      change: safeRecord(value.change ?? {}),
      component: safeRecord(manifest),
      manifest: safeRecord(manifest),
      resolverKey: value.resolverKey ?? manifest.resolverKey ?? null,
      expectedImprovement: safeRecord(value.expectedImprovement ?? {}),
      metrics: safeRecord(value.metrics ?? {}),
      confidence: strategyConfidence(value),
      outcomeConfidence: strategyConfidence(value),
      sourceExperimentId: value.sourceExperimentId ?? value.experiment?.id ?? null,
      sourceGenerationId: value.sourceGenerationId ?? value.generationId ?? null,
      success: value.success ?? null,
      recordedAt: value.recordedAt ?? timestamp(this.clock),
      evidence: safeRecord(value.evidence ?? {}),
      issueType: value.issueType ?? value.problemType ?? null,
      rootCause: value.rootCause ?? value.rootCauseHypothesis ?? null,
      failureMode: value.failureMode ?? value.failurePattern ?? null,
      semanticFact: value.semanticFact ?? null,
      regression: value.regression === true,
      correction: value.correction === true || value.substantiveCorrection === true,
      contradicts: value.contradicts === true || value.contradicted === true,
      forceRecord: value.forceRecord === true,
      irreplaceableEvidence: value.irreplaceableEvidence === true || value.criticalEvidence === true,
      eventId: value.eventId ?? value.bridgeEventId ?? null,
    });
  }

  async recordFailure(value) {
    return this.#append("experiments", { ...value, status: value.status ?? "failed" });
  }

  /** Durable success/failure attribution so later sessions avoid repeating failures. */
  async recordOutcome(value = {}) {
    const status = value.status === "success" ? "success" : "failure";
    const signature = value.signature ?? value.failureFingerprint ?? null;
    const existing = signature
      ? this.#data.outcomes.find((entry) => String(entry.signature ?? entry.failureFingerprint ?? "") === String(signature) && (entry.status === status || status === "failure"))
      : null;
    return this.#append("outcomes", {
      ...value,
      ...(existing ? { id: existing.id, count: Number(existing.count ?? 1) + 1, firstSeen: existing.firstSeen ?? existing.recordedAt ?? null } : {}),
      ...(signature ? { signature, failureFingerprint: value.failureFingerprint ?? signature, problemFingerprint: value.problemFingerprint ?? problemFingerprint(value) } : {}),
      lastSeen: timestamp(this.clock),
      status,
      dontRepeat: status === "success" ? false : value.dontRepeat !== false,
      metricsSummary: safeRecord(value.metricsSummary ?? value.metrics ?? {}),
    });
  }

  findBlockingOutcomes(signature) {
    const needle = String(signature ?? "").trim().toLowerCase();
    if (!needle) return [];
    const outcomes = this.history("outcomes").filter((entry) => (
      entry.status === "failure"
      && entry.dontRepeat !== false
      && String(entry.signature ?? "").trim().toLowerCase() === needle
    ));
    const tombstones = this.history("tombstones").filter((entry) => (
      entry.dontRepeat !== false
      && String(entry.signature ?? "").trim().toLowerCase() === needle
    ));
    return [...outcomes, ...tombstones].map(clone);
  }

  async setAutonomousState(value = {}) {
    this.#assertMutation("evolution.memory.autonomous");
    await this.load();
    this.#data.autonomous = compactAutonomousState({
      ...this.#data.autonomous,
      ...safeRecord(value),
    });
    await this.#save();
    return clone(this.#data.autonomous);
  }

  canonicalSnapshot() { return this.#data.canonical.map(clone); }

  #canonicalKey(entry = {}) {
    return semanticCapability(entry.sourceCollection ?? "canonical", entry) + "::" + String(entry.lineageId ?? "");
  }

  /** Mark a winner canonical only when the caller supplies real stability evidence. */
  async recordCanonical(value = {}) {
    this.#assertMutation("evolution.memory.canonical");
    return this.#enqueueMutation(async () => {
      await this.#ensureLoaded();
      const evidence = safeRecord(value.evidence ?? {});
      const candidateEvidence = value.record && typeof value.record === "object" ? value.record : value.strategy && typeof value.strategy === "object" ? value.strategy : value;
      if (!stableCanonicalEvidence({ ...candidateEvidence, ...value, evidence })) {
        throw new ValidationError("Canonical memory requires verified stability evidence");
      }
      const source = value.record && typeof value.record === "object" ? value.record : value.strategy && typeof value.strategy === "object" ? value.strategy : value;
      const capability = String(value.capabilityId ?? value.capability ?? semanticCapability(value.sourceCollection ?? "strategies", source));
      const lineageId = value.lineageId ?? source.lineageId ?? null;
      const key = capability + "::" + String(lineageId ?? "");
      const fitnessScore = Number(value.fitnessScore ?? source.fitnessScore ?? source.fitness ?? 0);
      const currentIndex = this.#data.canonical.findIndex((entry) => this.#canonicalKey(entry) === key);
      const current = currentIndex >= 0 ? this.#data.canonical[currentIndex] : null;
      if (current && Number(current.fitnessScore ?? 0) > fitnessScore) return { accepted: false, reason: "fitness_not_better", current: clone(current) };
      const next = safeRecord({
        id: value.id ?? "canonical:" + hashText(key + ":" + String(source.id ?? value.recordId ?? "")),
        state: "CANONICAL",
        lifecycleState: "CANONICAL",
        capability,
        lineageId,
        sourceCollection: value.sourceCollection ?? (value.strategy ? "strategies" : "lineage"),
        recordId: value.recordId ?? source.id ?? null,
        strategyId: value.strategyId ?? source.strategyId ?? source.id ?? null,
        generationId: value.generationId ?? source.generationId ?? null,
        version: value.version ?? source.version ?? null,
        promotionId: value.promotionId ?? source.promotionId ?? null,
        experimentId: value.experimentId ?? source.experimentId ?? null,
        fitnessScore: Number.isFinite(fitnessScore) ? fitnessScore : 0,
        implementation: safeRecord(value.implementation ?? source.manifest ?? source.component ?? source.strategy ?? {}),
        evidence,
        supersedes: current?.recordId ?? null,
        updatedAt: value.updatedAt ?? timestamp(this.clock),
      });
      if (currentIndex >= 0) this.#data.canonical[currentIndex] = next;
      else this.#data.canonical.push(next);
      await this.#upsertKnowledgeUnlocked({
        ...source,
        ...value,
        knowledgeKey: source.knowledgeKey ?? value.knowledgeKey ?? null,
        strategy: source.strategy ?? source.strategyKey ?? source.manifest ?? source.component ?? value.strategy ?? null,
        issueType: value.issueType ?? value.problemType ?? source.issueType ?? "strategy",
        capabilityId: capability,
        lineageId,
        eventId: value.eventId ?? value.bridgeEventId ?? value.recordId ?? source.id ?? null,
        status: "canonical",
        fitnessScore,
        recordedAt: next.updatedAt,
      }, { sourceCollection: "canonical" });
      await this.#save();
      return { accepted: true, canonical: clone(next), superseded: current ? clone(current) : null };
    });
  }

  #knowledgeRetentionPlan(histories, references = new Set()) {
    const knowledgeByKey = new Map();
    const coveredRefs = new Set();
    for (const entry of histories.knowledge ?? []) {
      const key = entry?.knowledgeKey ?? canonicalKnowledgeKey(entry, { sourceCollection: "knowledge", now: timestamp(this.clock) });
      if (!key) continue;
      knowledgeByKey.set(key, clone(entry));
      for (const ref of entry?.sourceRefs ?? []) coveredRefs.add(String(ref));
    }
    const sourceGroups = new Map();
    const sourceCollections = this.#collections().filter((collection) => collection !== "knowledge" && collection !== "tombstones");
    for (const collection of sourceCollections) {
      for (const entry of histories[collection] ?? []) {
        const event = normalizeKnowledgeEvent(entry, { sourceCollection: collection, now: timestamp(this.clock) });
        if (!event) continue;
        const key = event.knowledgeKey;
        const sourceRef = sourceEventReference(collection, entry);
        const existing = knowledgeByKey.get(key);
        // A source row already referenced by the accumulator has been counted;
        // replaying it during compaction would turn restart into false growth.
        if (!(existing && (!existing.sourceRefs?.length || (sourceRef && coveredRefs.has(sourceRef))))) {
          knowledgeByKey.set(key, mergeKnowledgeEntry(existing, event, { now: this.clock }));
        }
        if (!sourceGroups.has(key)) sourceGroups.set(key, []);
        sourceGroups.get(key).push({ collection, entry, event });
      }
    }
    const retainedEntries = new Map(this.#collections().map((collection) => [collection, new Set()]));
    let consolidated = 0;
    for (const group of sourceGroups.values()) {
      const byCollection = new Map();
      for (const item of group) {
        if (!byCollection.has(item.collection)) byCollection.set(item.collection, []);
        byCollection.get(item.collection).push(item);
      }
      for (const [collection, items] of byCollection) {
        const ordered = [...items].sort((left, right) => String(left.event.occurredAt).localeCompare(String(right.event.occurredAt)));
        let kept = 0;
        for (const item of ordered) {
          const idValue = item.entry?.id === undefined || item.entry?.id === null ? null : String(item.entry.id);
          const referenced = idValue !== null && references.has(idValue);
          const critical = referenced || isKnowledgeCritical(item.event, { collection });
          const limit = collection === "cycles" ? Number.POSITIVE_INFINITY : sourceRetentionLimit(item.event, { collection });
          if (critical || kept < limit) {
            retainedEntries.get(collection)?.add(item.entry);
            if (!critical) kept += 1;
          } else consolidated += 1;
        }
      }
    }
    for (const collection of sourceCollections) {
      for (const entry of histories[collection] ?? []) {
        if (!normalizeKnowledgeEvent(entry, { sourceCollection: collection, now: timestamp(this.clock) })) retainedEntries.get(collection)?.add(entry);
      }
    }
    return { knowledge: [...knowledgeByKey.values()].map(clone), retainedEntries, consolidated };
  }

  #retentionPlan() {
    // Housekeeping: ensure hot pools are clean before retention/compaction (pure, zero LLM)
    try { this.#performHousekeeping(); } catch {}
    const collections = this.#collections().filter((collection) => collection !== "tombstones");
    const histories = Object.fromEntries(collections.map((collection) => [collection, this.history(collection)]));
    const allRecords = collections.flatMap((collection) => histories[collection].map((entry) => ({ collection, entry })));
    const unresolvedReferences = new Set();
    const references = new Set();
    const latestLineage = new Map();
    for (const { collection, entry } of allRecords) {
      // A plain observed cycle is a transport envelope for raw observations,
      // not durable knowledge by itself. Ignore those payload references while
      // planning retention so the observations can be aggregated/compacted.
      // Preserve references from meaningful cycles (proposal/experiment/
      // validation/promotion) because those remain addressable evidence.
      const referenceSource = collection === "knowledge"
        ? { ...entry, sourceRefs: undefined, eventIds: undefined, recentEvidence: undefined }
        : collection === "cycles" && isConsolidatableCycle(entry)
          ? { ...entry, observations: undefined, diagnoses: undefined, gaps: undefined }
          : entry;
      const ids = referencedIds([referenceSource]);
      if (entry?.id !== undefined) ids.delete(String(entry.id));
      for (const idValue of ids) references.add(String(idValue));
      if (isActiveExperiment(entry)) for (const idValue of ids) unresolvedReferences.add(String(idValue));
      if (collection === "lineage" && entry?.lineageId) {
        const previous = latestLineage.get(String(entry.lineageId));
        const generation = Number(entry.generation ?? 0);
        if (!previous || generation >= Number(previous.entry.generation ?? 0)) latestLineage.set(String(entry.lineageId), { entry, id: String(entry.id ?? "") });
      }
    }

    const canonicalByKey = new Map();
    for (const entry of this.#data.canonical) canonicalByKey.set(this.#canonicalKey(entry), clone(entry));
    const retiredByCanonical = new Map();
    for (const { collection, entry } of allRecords) {
      if (!["strategies", "lineage", "promotions"].includes(collection) || !stableCanonicalEvidence(entry)) continue;
      const candidate = safeRecord({
        id: "canonical:" + hashText(semanticCapability(collection, entry) + "::" + String(entry.lineageId ?? "") + ":" + String(entry.id ?? "")),
        state: "CANONICAL",
        lifecycleState: "CANONICAL",
        capability: semanticCapability(collection, entry),
        lineageId: entry.lineageId ?? null,
        sourceCollection: collection,
        recordId: entry.id ?? null,
        strategyId: entry.strategyId ?? (collection === "strategies" ? entry.id : null),
        generationId: entry.generationId ?? null,
        version: entry.version ?? null,
        promotionId: entry.promotionId ?? entry.id ?? null,
        experimentId: entry.experimentId ?? entry.sourceExperimentId ?? null,
        fitnessScore: Number(entry.fitnessScore ?? entry.fitness ?? 0),
        implementation: safeRecord(entry.manifest ?? entry.component ?? entry.strategy ?? {}),
        evidence: safeRecord(entry.evidence ?? entry.stability ?? {}),
        supersedes: null,
        updatedAt: entry.recordedAt ?? entry.promotedAt ?? timestamp(this.clock),
      });
      const key = this.#canonicalKey(candidate);
      const current = canonicalByKey.get(key);
      if (!current || Number(candidate.fitnessScore) > Number(current.fitnessScore ?? 0)) {
        candidate.supersedes = current?.recordId ?? null;
        if (current?.recordId && current.recordId !== candidate.recordId) retiredByCanonical.set(String(current.recordId), candidate.id);
        canonicalByKey.set(key, candidate);
      }
    }

    const tombstoneMap = new Map();
    for (const entry of this.history("tombstones")) if (entry?.id) tombstoneMap.set(String(entry.id), clone(entry));
    const addTombstone = (entry) => {
      const previous = tombstoneMap.get(String(entry.id));
      if (!previous) { tombstoneMap.set(String(entry.id), entry); return; }
      const ids = [...new Set([...(previous.recordIds ?? []), ...(entry.recordIds ?? [])])].slice(-16);
      tombstoneMap.set(String(entry.id), {
        ...previous,
        ...entry,
        count: Number(previous.count ?? 0) + Number(entry.count ?? 1),
        firstSeen: previous.firstSeen ?? entry.firstSeen ?? null,
        lastSeen: entry.lastSeen ?? previous.lastSeen ?? null,
        recordIds: ids,
      });
    };

    // Build repeated-observation groups once. Low-value component observations
    // are eligible even when embedded in a cycle: the cycle keeps its bounded
    // decision context while the standalone raw payload is folded away.
    // Diagnostic/error observations remain individually addressable.
    const observationGroups = new Map();
    for (const entry of histories.observations ?? []) {
      // Consolidated singleton records can still be folded into a repeated
      // aggregate. Already-aggregated records are the fixed point and are
      // intentionally skipped on subsequent maintenance runs.
      if (entry?.retention === "AGGREGATED" || !isConsolidatableObservation("observations", entry, references)) continue;
      const key = observationAggregationKey(entry);
      if (!observationGroups.has(key)) observationGroups.set(key, []);
      observationGroups.get(key).push(entry);
    }
    const observationGroupIds = new Set();

    const knowledgePlan = this.#knowledgeRetentionPlan(histories, references);
    const records = {};
    const report = { before: {}, after: {}, retired: 0, consolidated: 0, aggregatedObservations: 0, tombstones: 0, retainedCanonical: canonicalByKey.size, knowledgeBefore: histories.knowledge?.length ?? 0, knowledgeAfter: knowledgePlan.knowledge.length, canonicalKnowledge: knowledgePlan.knowledge.length };
    for (const collection of collections) {
      if (collection === "knowledge") {
        records[collection] = knowledgePlan.knowledge.map(clone);
        report.before[collection] = histories[collection].length;
        report.after[collection] = records[collection].length;
        continue;
      }
      const retained = [];
      report.before[collection] = histories[collection].length;
      for (const entry of histories[collection]) {
        const recordId = entry?.id === undefined || entry?.id === null ? null : String(entry.id);
        const normalizedKnowledge = normalizeKnowledgeEvent(entry, { sourceCollection: collection, now: timestamp(this.clock) });
        if (normalizedKnowledge && !knowledgePlan.retainedEntries.get(collection)?.has(entry)) {
          const replacedBy = recordId ? retiredByCanonical.get(recordId) ?? null : null;
          const lineageLatest = entry?.lineageId && latestLineage.get(String(entry.lineageId))?.id === recordId;
          const retireDuplicate = recordId
            && (isTerminalRetirement(entry) || replacedBy)
            && !RETAINED_JOURNAL_COLLECTIONS.has(collection)
            && !this.#data.canonical.some((canonical) => String(canonical.recordId ?? "") === recordId)
            && !unresolvedReferences.has(recordId)
            && !references.has(recordId)
            && !lineageLatest;
          if (retireDuplicate) {
            addTombstone(tombstoneFor(collection, entry, { reason: replacedBy ? "superseded" : lifecycleState(entry).toLowerCase(), replacedBy }));
            report.retired += 1;
          } else report.consolidated += 1;
          continue;
        }
        if (collection === "observations" && isConsolidatableObservation(collection, entry, references)) {
          const group = observationGroups.get(observationAggregationKey(entry)) ?? [entry];
          if (group.length > 1) {
            const groupKey = observationAggregationKey(entry);
            if (observationGroupIds.has(groupKey)) continue;
            observationGroupIds.add(groupKey);
            retained.push(compactObservationAggregate(group));
            report.consolidated += group.length;
            report.aggregatedObservations += 1;
            continue;
          }
        }
        if (collection === "cycles" && isConsolidatableCycle(entry) && !entry[MEMORY_CONSOLIDATED]) {
          retained.push(compactCycleRecord(entry));
          report.consolidated += 1;
          continue;
        }
        if (isConsolidatableObservation(collection, entry, references) && !entry[MEMORY_CONSOLIDATED]) {
          retained.push(compactObservationRecord(entry));
          report.consolidated += 1;
          continue;
        }
        const lineageLatest = entry?.lineageId && latestLineage.get(String(entry.lineageId))?.id === recordId;
        const replacedBy = recordId ? retiredByCanonical.get(recordId) ?? null : null;
        const canRetire = recordId
          && (isTerminalRetirement(entry) || replacedBy)
          && !RETAINED_JOURNAL_COLLECTIONS.has(collection)
          && !this.#data.canonical.some((canonical) => String(canonical.recordId ?? "") === recordId)
          && !unresolvedReferences.has(recordId)
          && !references.has(recordId)
          && !lineageLatest;
        if (canRetire) {
          addTombstone(tombstoneFor(collection, entry, { reason: replacedBy ? "superseded" : lifecycleState(entry).toLowerCase(), replacedBy }));
          report.retired += 1;
          continue;
        }
        retained.push(clone(entry));
      }
      records[collection] = retained;
      report.after[collection] = retained.length;
    }
    records.tombstones = [...tombstoneMap.values()];
    report.tombstones = records.tombstones.length;
    report.canonical = canonicalByKey.size;
    return { collections, histories, records, canonical: [...canonicalByKey.values()], report };
  }

  #archiveBytes() {
    if (!this.archiveFile) return 0;
    return this.#collections().reduce((sum, collection) => sum + this.#archiveFiles(collection).reduce((total, file) => {
      try { return total + statSync(file).size; } catch { return total; }
    }, 0), 0);
  }

  async #rewriteArchives(plan) {
    const token = randomUUID();
    const staged = [];
    const applied = [];
    const exists = async (file) => { try { await stat(file); return true; } catch { return false; } };
    try {
      for (const collection of this.#collections()) {
        if (!this.archiveFile) break;
        const path = this.#archivePath(collection);
        const directory = this.#archiveSegmentDirectory(collection);
        const hasPath = await exists(path);
        const hasDirectory = await exists(directory);
        const limit = this.#hotLimit(collection);
        const cold = plan.records[collection].slice(0, -limit);
        if (!cold.length && !hasPath && !hasDirectory) {
          const metadata = { ...(this.#data.coldArchives ?? {}) };
          delete metadata[collection];
          this.#data.coldArchives = metadata;
          continue;
        }
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = path + ".compact-" + token + ".tmp";
        const temporaryDirectory = directory + ".compact-" + token + ".tmp";
        await rm(temporaryDirectory, { recursive: true, force: true });
        await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
        await writeFile(temporary, "", { mode: 0o600 });
        let activeBytes = 0;
        let nextSegment = 1;
        for (const original of cold) {
          const line = boundedArchiveEntry(collection, original, this.absoluteMaxSegmentBytes).raw;
          const lineBytes = Buffer.byteLength(line) + 1;
          if (activeBytes > 0 && activeBytes + lineBytes > this.archiveMaxBytes) {
            await rename(temporary, join(temporaryDirectory, "segment-" + String(nextSegment).padStart(12, "0") + ".jsonl"));
            nextSegment += 1;
            await writeFile(temporary, "", { mode: 0o600 });
            activeBytes = 0;
          }
          await appendFile(temporary, line + "\n", { mode: 0o600 });
          activeBytes += lineBytes;
          if (activeBytes >= this.archiveMaxBytes) {
            await rename(temporary, join(temporaryDirectory, "segment-" + String(nextSegment).padStart(12, "0") + ".jsonl"));
            nextSegment += 1;
            await writeFile(temporary, "", { mode: 0o600 });
            activeBytes = 0;
          }
        }
        // Readback validation happens after the staged layout is installed;
        // the active tail is always present, including an empty one.
        staged.push({ collection, path, directory, temporary, temporaryDirectory, hasPath, hasDirectory, backup: path + ".compact-" + token + ".bak", directoryBackup: directory + ".compact-" + token + ".bak" });
      }
      for (const item of staged) {
        if (item.hasPath) await rename(item.path, item.backup);
        if (item.hasDirectory) await rename(item.directory, item.directoryBackup);
        await rename(item.temporaryDirectory, item.directory);
        await rename(item.temporary, item.path);
        applied.push(item);
      }
      for (const item of staged) {
        const cold = plan.records[item.collection].slice(0, -this.#hotLimit(item.collection));
        const archived = this.#readArchiveSync(item.collection);
        if (archived.length !== cold.length || archived.some((entry, index) => this.#archiveKey(entry) !== this.#archiveKey(cold[index]))) throw new Error("compacted archive readback validation failed");
        if (cold.length) this.#setArchiveMetadata(item.collection, this.archiveKnown.get(item.collection) ?? new Set(), this.archiveTombstones.get(item.collection) ?? new Set());
        else {
          const metadata = { ...(this.#data.coldArchives ?? {}) };
          delete metadata[item.collection];
          this.#data.coldArchives = metadata;
        }
      }
      this.archiveIndexReady = false;
      await this.#writeArchiveIndex();
      return {
        commit: async () => {
          for (const item of applied) {
            await rm(item.backup, { force: true }).catch(() => {});
            await rm(item.directoryBackup, { recursive: true, force: true }).catch(() => {});
          }
        },
        rollback: async () => {
          for (const item of [...applied].reverse()) {
            await rm(item.path, { force: true }).catch(() => {});
            await rm(item.directory, { recursive: true, force: true }).catch(() => {});
            if (item.hasPath) await rename(item.backup, item.path).catch(() => {});
            if (item.hasDirectory) await rename(item.directoryBackup, item.directory).catch(() => {});
          }
        },
      };
    } catch (error) {
      for (const item of staged) {
        await rm(item.temporary, { force: true }).catch(() => {});
        await rm(item.temporaryDirectory, { recursive: true, force: true }).catch(() => {});
      }
      // Restore every staged item, including one whose rename failed before
      // it could be added to `applied`; otherwise a crash between moving the
      // old path and installing the new layout could strand the backup.
      for (const item of [...staged].reverse()) {
        await rm(item.path, { force: true }).catch(() => {});
        await rm(item.directory, { recursive: true, force: true }).catch(() => {});
        if (item.hasPath) await rename(item.backup, item.path).catch(() => {});
        if (item.hasDirectory) await rename(item.directoryBackup, item.directory).catch(() => {});
      }
      throw error;
    }
  }

  async compact(options = {}) {
    this.#assertMutation("evolution.memory.compact");
    return this.#enqueueMutation(() => this.#compactUnlocked(options));
  }

  async #compactUnlocked({ dryRun = false } = {}) {
    await this.load();
    if (this.compacting) throw new ValidationError("Evolution memory compaction is already running");
    this.compacting = true;
    try {
      await this.archiveWriting;
      const beforeBytes = this.#archiveBytes();
      const plan = this.#retentionPlan();
      const oldData = clone(this.#data);
      if (dryRun) return { ...plan.report, beforeBytes, afterBytes: beforeBytes, dryRun: true };
      let archiveTransaction = null;
      try {
        if (this.archiveFile) archiveTransaction = await this.#rewriteArchives(plan);
        for (const collection of this.#collections()) {
          const values = plan.records[collection] ?? [];
          this.#data[collection] = this.archiveFile ? values.slice(-this.#hotLimit(collection)) : values.slice(-this.maxEntries);
        }
        this.#data.canonical = plan.canonical.map(clone);
        this.#data.tombstones = (plan.records.tombstones ?? []).slice(-this.#hotLimit("tombstones")).map(clone);
        await this.#save();
        await archiveTransaction?.commit?.();
      } catch (error) {
        this.#data = oldData;
        await archiveTransaction?.rollback?.();
        throw error;
      }
      const afterBytes = this.#archiveBytes();
      return { ...plan.report, beforeBytes, afterBytes, dryRun: false, hotCollections: this.#collections().reduce((result, collection) => { result[collection] = this.#data[collection].length; return result; }, {}) };
    } finally {
      this.compacting = false;
    }
  }

  /**
   * Size-triggered semantic GC entry point for periodic schedulers.
   *
   * Cheap when cold history is below the ceiling: it stats a handful of files
   * and never parses archives. Above the ceiling (or forced) it delegates to
   * compact(), which is the explicit full-history operation. Failures are
   * thrown so the calling scheduler can contain and log them.
   */
  async maintenance({ force = false } = {}) {
    if (!this.archiveFile) return { skipped: "no-archive" };
    if (this.compacting) return { skipped: "already-compacting" };
    const totalBytes = this.#archiveBytes();
    const due = force === true || totalBytes > this.compactionTriggerBytes;
    const now = Date.parse(timestamp(this.clock));
    if (!due) {
      this.lastMaintenanceResult = { at: timestamp(this.clock), skipped: "below-threshold", archiveBytes: totalBytes };
      return this.lastMaintenanceResult;
    }
    if (!force && this.lastMaintenanceAt !== null && now - this.lastMaintenanceAt < this.compactionMinIntervalMs) {
      return { skipped: "cooldown", archiveBytes: totalBytes, triggerBytes: this.compactionTriggerBytes };
    }
    this.lastMaintenanceAt = now;
    try {
      const report = await this.compact();
      this.lastMaintenanceResult = { at: timestamp(this.clock), ...report };
      return this.lastMaintenanceResult;
    } catch (error) {
      this.lastMaintenanceResult = { at: timestamp(this.clock), error: error?.message ?? String(error) };
      throw error;
    }
  }

  /** Cheap, evidence-backed archive diagnostics; it never hydrates records. */
  archiveDiagnostics() {
    const collections = {};
    let totalBytes = 0;
    const oversizedSegments = [];
    for (const collection of this.#collections()) {
      const path = this.#archivePath(collection);
      if (!path) continue;
      let activeBytes = 0;
      try { activeBytes = statSync(path).size; } catch {}
      const segments = this.#archiveFiles(collection).filter((file) => file !== path).map((file) => {
        let size = 0;
        try { size = statSync(file).size; } catch {}
        if (size > this.absoluteMaxSegmentBytes) oversizedSegments.push({ collection, file, size, historical: true });
        return { file, size, sealed: true };
      });
      if (activeBytes > this.absoluteMaxSegmentBytes) oversizedSegments.push({ collection, file: path, size: activeBytes, historical: false });
      totalBytes += activeBytes + segments.reduce((sum, entry) => sum + entry.size, 0);
      collections[collection] = { activeBytes, segments };
    }
    return {
      policy: { targetRotationBytes: this.archiveMaxBytes, absoluteMaxSegmentBytes: this.absoluteMaxSegmentBytes },
      totalBytes,
      collections,
      oversizedSegments,
      rootCause: "bulk archival/migration appended a whole evicted batch before rotation; current writes chunk before append and seal",
      indexFile: this.archiveIndexFile,
    };
  }

  /**
   * Atomically finalize one user-selected manual evolution.  The caller is
   * the authority that executed and validated the change; this method only
   * records the result and performs bounded knowledge retention.  Replaying
   * the same finalization id is idempotent.
   */
  async finalizeKnowledge({ problemFingerprint: suppliedProblemFingerprint = null, candidateGroup = null, winner = {}, candidates = [], before = {}, after = {}, validation = {}, lineage = {}, rollback = {}, outcome = "SUCCESS", reason = null } = {}) {
    this.#assertMutation("evolution.memory.finalizeKnowledge");
    await this.#ensureLoaded();
    const problem = String(suppliedProblemFingerprint ?? winner.problemFingerprint ?? problemFingerprint(winner));
    const winnerFingerprint = String(winner.candidateFingerprint ?? candidateFingerprint(winner, problem));
    const finalizationId = `knowledge-finalize:${problem}:${winnerFingerprint}`;
    const committed = this.#data.journal.find((entry) => entry.id === finalizationId && entry.stage === "committed");
    const existingCanonical = this.#data.canonical.find((entry) => entry.candidateFingerprint === winnerFingerprint || entry.recordId === winner.id || entry.strategyId === winner.id);
    if (committed || existingCanonical) return { committed: true, duplicate: true, finalizationId, winner: clone(existingCanonical ?? winner) };
    const oldData = clone(this.#data);
    let archiveTransaction = null;
    try {
      const now = timestamp(this.clock);
      const validationRuns = Math.max(1, Number(validation.validationRuns ?? winner.validationRuns ?? 1));
      const evidence = safeRecord({
        ...winner.evidence,
        ...validation,
        promotionId: winner.promotionId ?? validation.promotionId ?? finalizationId,
        evaluation: { eligible: true, evaluation: { validationRuns } },
      });
      const winnerRecord = safeRecord({
        ...winner,
        id: winner.id ?? `winner:${winnerFingerprint}`,
        status: "CURRENT_BEST",
        lifecycleState: "CURRENT_BEST",
        problemFingerprint: problem,
        candidateFingerprint: winnerFingerprint,
        candidateGroup: candidateGroup ?? winner.candidateGroup ?? problem,
        beforeMetrics: safeRecord(before),
        afterMetrics: safeRecord(after),
        validation: evidence,
        outcome: String(outcome).toUpperCase(),
        success: String(outcome).toUpperCase() === "SUCCESS",
        lineage: safeRecord(lineage),
        rollback: safeRecord(rollback),
        reason,
        finalizedAt: now,
        recordedAt: winner.recordedAt ?? now,
      });
      const winnerId = String(winnerRecord.id);
      const group = String(candidateGroup ?? winnerRecord.candidateGroup ?? problem);
      const isSameGroup = (entry) => String(entry?.problemFingerprint ?? problemFingerprint(entry)) === problem
        || String(entry?.candidateGroup ?? "") === group;
      const loserInput = [...candidates, ...this.#data.candidates].filter((entry) => entry && String(entry.id ?? "") !== winnerId && isSameGroup(entry));
      const loserByFingerprint = new Map();
      for (const entry of loserInput) {
        const fp = String(entry.candidateFingerprint ?? candidateFingerprint(entry, problem));
        loserByFingerprint.set(fp, entry);
      }
      const loserSummaries = [...loserByFingerprint.entries()].filter(([fp]) => fp !== winnerFingerprint).map(([fp, entry]) => safeRecord({
        id: `candidate-summary:${fp}`,
        status: "SUPERSEDED",
        lifecycleState: "SUPERSEDED",
        retention: "FAILURE_KNOWLEDGE",
        problemFingerprint: problem,
        candidateFingerprint: fp,
        candidateGroup: group,
        reason: entry.reason ?? reason ?? "lower_fitness_or_superseded",
        metricsSummary: safeRecord(entry.metrics ?? entry.metricsSummary ?? {}),
        replacedBy: winnerId,
        timestamp: now,
        failureCount: Number(entry.failureCount ?? 0),
      }));
      // Replace every non-winning candidate in the group with a compact lesson
      // and remove the verbose proposal/diagnostic payloads that only served
      // this decision. The winner stays complete and addressable by id.
      this.#data.candidates = [
        ...this.#data.candidates.filter((entry) => !isSameGroup(entry) || String(entry.id ?? "") === winnerId),
        ...loserSummaries,
      ];
      this.#data.candidates = this.#data.candidates.some((entry) => String(entry.id) === winnerId)
        ? this.#data.candidates.map((entry) => String(entry.id) === winnerId ? winnerRecord : entry)
        : [...this.#data.candidates, winnerRecord];
      for (const collection of ["proposals", "diagnoses", "experiments", "experimentRecords"]) {
        this.#data[collection] = this.#data[collection].map((entry) => {
          if (!isSameGroup(entry) || String(entry.id ?? "") === winnerId) return entry;
          return safeRecord({
            id: entry.id,
            status: "SUPERSEDED",
            lifecycleState: "SUPERSEDED",
            problemFingerprint: problem,
            candidateFingerprint: entry.candidateFingerprint ?? candidateFingerprint(entry, problem),
            reason: "superseded_by_validated_winner",
            replacedBy: winnerId,
            metricsSummary: entry.metrics ?? entry.candidateMetrics ?? {},
            recordedAt: entry.recordedAt ?? now,
          });
        });
      }
      for (const summary of loserSummaries) {
        const existing = this.#data.tombstones.find((entry) => entry.id === summary.id);
        if (existing) Object.assign(existing, summary);
        else this.#data.tombstones.push(summary);
      }
      const capability = String(winnerRecord.capabilityId ?? winnerRecord.componentId ?? group);
      const previous = this.#data.canonical.find((entry) => this.#canonicalKey(entry) === `${capability}::${String(lineage.lineageId ?? winnerRecord.lineageId ?? "")}`) ?? null;
      if (previous && previous.recordId !== winnerId) {
        // Keep exactly one full, recent rollback point with the new winner.
        // Older superseded winners still collapse to summaries/tombstones, but
        // the immediately previous known-good implementation remains usable
        // without a cold-history scan.
        winnerRecord.rollback = safeRecord({
          ...winnerRecord.rollback,
          horizon: winnerRecord.rollback?.horizon ?? "recent",
          previousRecordId: previous.recordId,
          previous: clone(previous),
        });
      }
      const canonical = safeRecord({
        id: `canonical:${hashText(capability + "::" + String(lineage.lineageId ?? winnerRecord.lineageId ?? ""))}`,
        state: "CANONICAL",
        lifecycleState: "CANONICAL",
        capability,
        lineageId: lineage.lineageId ?? winnerRecord.lineageId ?? null,
        sourceCollection: "candidates",
        recordId: winnerId,
        candidateFingerprint: winnerFingerprint,
        strategyId: winnerRecord.strategyId ?? winnerId,
        promotionId: winnerRecord.promotionId ?? null,
        fitnessScore: Number(winnerRecord.fitnessScore ?? winnerRecord.fitness ?? after.qualityScore ?? 0),
        implementation: safeRecord(winnerRecord.implementation ?? winnerRecord.change ?? winnerRecord.manifest ?? winnerRecord.component ?? {}),
        evidence,
        rollback: safeRecord(winnerRecord.rollback),
        beforeMetrics: safeRecord(before),
        afterMetrics: safeRecord(after),
        supersedes: previous?.recordId ?? null,
        updatedAt: now,
      });
      const canonicalIndex = this.#data.canonical.findIndex((entry) => this.#canonicalKey(entry) === this.#canonicalKey(canonical));
      if (canonicalIndex >= 0) this.#data.canonical[canonicalIndex] = canonical;
      else this.#data.canonical.push(canonical);
      if (previous && previous.recordId !== winnerId) {
        const oldSummary = tombstoneFor("canonical", previous, { reason: "superseded", replacedBy: winnerId });
        const existing = this.#data.tombstones.find((entry) => entry.id === oldSummary.id);
        if (existing) Object.assign(existing, oldSummary);
        else this.#data.tombstones.push(oldSummary);
      }
      if (lineage && Object.keys(lineage).length) this.#data.lineage.push(safeRecord({ id: lineage.id ?? `lineage:${finalizationId}`, ...lineage, outcome: String(outcome).toUpperCase(), winnerId, recordedAt: now }));
      this.#data.outcomes.push(safeRecord({ id: `outcome:${finalizationId}`, status: String(outcome).toLowerCase() === "success" ? "success" : "failure", problemFingerprint: problem, candidateFingerprint: winnerFingerprint, winnerId, before: safeRecord(before), after: safeRecord(after), validation: evidence, rollback: safeRecord(rollback), recordedAt: now }));
      this.#data.journal.push(safeRecord({ id: finalizationId, event: "knowledge_finalization", stage: "committed", problemFingerprint: problem, candidateFingerprint: winnerFingerprint, winnerId, loserCount: loserSummaries.length, recordedAt: now }));

      const plan = this.#retentionPlan();
      if (this.archiveFile) archiveTransaction = await this.#rewriteArchives(plan);
      for (const collection of this.#collections()) this.#data[collection] = this.archiveFile ? (plan.records[collection] ?? []).slice(-this.#hotLimit(collection)) : (plan.records[collection] ?? []).slice(-this.maxEntries);
      this.#data.canonical = plan.canonical.map(clone);
      await this.#save();
      await archiveTransaction?.commit?.();
      return { committed: true, duplicate: false, finalizationId, winner: clone(winnerRecord), loserSummaries: clone(loserSummaries), canonical: clone(canonical) };
    } catch (error) {
      this.#data = oldData;
      await archiveTransaction?.rollback?.();
      throw error;
    }
  }

  findSimilar(problem) {
    const needle = String(problem ?? "").trim().toLowerCase();
    if (!needle) return [];
    return [
      ...this.history("candidates"),
      ...this.history("diagnoses"),
      ...this.history("gaps"),
      ...this.history("proposals"),
      ...this.history("experiments"),
      ...this.history("experimentRecords"),
      ...this.history("journal"),
      ...this.history("selections"),
      ...this.history("promotions"),
      ...this.history("cycles"),
      ...this.history("lineage"),
      ...this.history("learnings"),
    ].filter((entry) => JSON.stringify(entry).toLowerCase().includes(needle)).map(clone);
  }

  /** Rank successful historical strategies by semantic overlap, confidence, and recency. */
  findSimilarStrategies(query = {}, { limit = 5, minSimilarity = 0.15, minConfidence = 0.55 } = {}) {
    const requested = strategyTokens(query);
    if (requested.size === 0) return [];
    const source = [...this.history("strategies"), ...this.history("learnings").filter((entry) => entry?.decision === "promote")];
    const seen = new Set();
    const ranked = [];
    for (const entry of source) {
      const key = String(entry.id ?? entry.sourceExperimentId ?? JSON.stringify(entry));
      if (seen.has(key)) continue;
      seen.add(key);
      const status = String(entry.status ?? entry.finalResult?.status ?? "promoted").toLowerCase();
      const decision = String(entry.decision ?? entry.finalResult?.decision ?? "promote").toLowerCase();
      if (!["promoted", "validated", "success"].includes(status) || ["reject", "rollback", "revert", "failed"].includes(decision)) continue;
      const confidence = strategyConfidence(entry);
      if (confidence < Number(minConfidence)) continue;
      const candidateText = { problem: entry.problem, hypothesis: entry.hypothesis, context: entry.context ?? entry.applicableConditions, change: entry.change };
      const directProblemSimilarity = strategySimilarity(query.problem ?? query.message ?? "", entry.problem ?? "");
      const directHypothesisSimilarity = strategySimilarity(query.hypothesis ?? "", entry.hypothesis ?? "");
      const similarity = Math.max(directProblemSimilarity, directHypothesisSimilarity, strategySimilarity(query, candidateText));
      if (similarity < Number(minSimilarity)) continue;
      const recency = strategyRecency(entry);
      const ranking = similarity * 0.6 + confidence * 0.3 + recency * 0.1;
      const manifest = safeRecord(entry.component ?? entry.manifest ?? {});
      ranked.push({
        ranking: Number(ranking.toFixed(6)),
        similarity: Number(similarity.toFixed(6)),
        confidence: Number(confidence.toFixed(6)),
        recency: Number(recency.toFixed(6)),
        strategy: {
          id: key,
          problem: entry.problem ?? null,
          hypothesis: entry.hypothesis ?? null,
          change: safeRecord(entry.change ?? {}),
          component: manifest,
          definition: manifest,
          manifest,
          resolverKey: entry.resolverKey ?? manifest.resolverKey ?? null,
          expectedImprovement: safeRecord(entry.expectedImprovement ?? {}),
          applicableConditions: safeRecord(entry.context ?? entry.applicableConditions ?? {}),
          sourceExperimentId: entry.sourceExperimentId ?? entry.experiment?.id ?? null,
        },
        evidence: { source: "evolution-memory", status, decision, metrics: safeRecord(entry.metrics ?? {}), recordedAt: entry.recordedAt ?? null },
      });
    }
    return ranked.sort((left, right) => right.ranking - left.ranking || right.similarity - left.similarity).slice(0, Math.max(1, Number(limit) || 5)).map(clone);
  }

  /**
   * Full cycle history: hot partition records merged with the cold-tier
   * archive (deduplicated by id, chronological). Returns only the hot
   * window when includeArchived is false or no archive exists.
   */
  async cycleHistory({ includeArchived = true } = {}) {
    const records = includeArchived ? this.history("cycles", { includeArchived: true }) : this.#data.cycles.map(clone);
    return records.sort((left, right) => String(left.startedAt ?? left.recordedAt ?? "").localeCompare(String(right.startedAt ?? right.recordedAt ?? "")));
  }

  stats() {
    const experiments = this.#data.experiments;
      const cyclesArchived = this.#data.coldArchives?.cycles?.count ?? 0;
    return {
      // Present only once archival has actually run: keeps snapshot content
      // byte-comparable with pre-archival versions during migration restores.
        ...(cyclesArchived > 0 ? { cyclesArchived } : {}),
      observations: this.#data.observations.length,
      diagnoses: this.#data.diagnoses.length,
      gaps: this.#data.gaps.length,
      candidates: this.#data.candidates.length,
      proposals: this.#data.proposals.length,
      experiments: experiments.length,
      experimentRecords: this.#data.experimentRecords.length,
      journal: this.#data.journal.length,
      selections: this.#data.selections.length,
      promotions: this.#data.promotions.length,
      outcomes: this.#data.outcomes.length,
      cycles: this.#data.cycles.length,
      lineage: this.#data.lineage.length,
      learnings: this.#data.learnings.length,
      strategies: this.#data.strategies.length,
      strategyMutations: this.#data.strategyMutations.length,
      knowledge: this.#data.knowledge.length,
      canonicalKnowledge: this.#data.knowledge.length,
      canonical: this.#data.canonical.length,
      tombstones: this.#data.tombstones.length,
      bridgeEventsApplied: this.#data.eventBridge?.applied?.length ?? 0,
      provenance: clone(this.#data.provenance),
      successfulStrategies: this.#data.strategies.filter((strategy) => ["promoted", "validated", "success"].includes(strategy.status)).length,
      successfulExperiments: experiments.filter((experiment) => ["validated", "promoted"].includes(experiment.status)).length,
      revertedExperiments: experiments.filter((experiment) => ["reverted", "failed"].includes(experiment.status)).length,
      successRate: experiments.length === 0
        ? null
        : experiments.filter((experiment) => ["validated", "promoted"].includes(experiment.status)).length / experiments.length,
      autonomous: clone(this.#data.autonomous),
    };
  }
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

function hashText(value) {
  let hash = 2166136261;
  for (const character of String(value ?? "")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function observationTime(value, fallback = Date.now()) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}
