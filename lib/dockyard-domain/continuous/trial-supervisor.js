/** Bounded long-running trial supervisor over EvolutionSupervisor. */
import { clamp01, clone, finite, hash, safeRecord, safeValue, timestamp } from "./shared.js";
import { EvolutionDiscovery } from "./discovery-metrics.js";
import { EvolutionSupervisor } from "./supervisor.js";
import { metricsFitness, trialReport, trialSnapshot } from "./reporting.js";

import { assertMutation, boundedCount, requirePort } from "./ports.js";

function trialMetricValue(source, names) {
  for (const value of [source, source?.metrics, source?.result?.metrics, source?.result]) {
    if (!value || typeof value !== "object") continue;
    for (const name of names) {
      const number = finite(value[name]);
      if (number !== null) return number;
    }
  }
  return null;
}

function trialResourceMetrics(before = {}, after = {}, result = {}) {
  const source = { ...safeRecord(after), ...safeRecord(result?.metrics ?? result) };
  const baseline = safeRecord(before);
  return {
    token: trialMetricValue(source, ["tokenUsage", "tokens", "tokenCount", "token_usage"]) ?? trialMetricValue(baseline, ["tokenUsage", "tokens", "tokenCount", "token_usage"]),
    latencyMs: trialMetricValue(source, ["latencyMs", "latency", "p95LatencyMs", "durationMs", "completionTimeMs"]) ?? trialMetricValue(baseline, ["latencyMs", "latency", "p95LatencyMs", "durationMs", "completionTimeMs"]),
    memoryBytes: trialMetricValue(source, ["memoryBytes", "memory", "heapUsed", "heapUsedBytes"]) ?? trialMetricValue(baseline, ["memoryBytes", "memory", "heapUsed", "heapUsedBytes"]),
    storageBytes: trialMetricValue(source, ["storageBytes", "storage", "stateBytes", "storageSize"]) ?? trialMetricValue(baseline, ["storageBytes", "storage", "stateBytes", "storageSize"]),
  };
}

function trialFingerprint(value) {
  try { return JSON.stringify(value ?? {}); } catch { return "[unserializable]"; }
}

// Registry inspection objects may carry full component state, control-plane
// snapshots, callbacks, and diagnostics.  The trial rollback contract only
// needs a stable identity/lifecycle/effect projection to detect host-runtime
// pollution.  Keeping that projection small prevents every cycle from
// retaining the same full snapshot twice (baseline + final fingerprint).
function trialComponentFingerprint(entry = {}) {
  const dependencyIds = (value) => (Array.isArray(value) ? value : [])
    .map((dependency) => typeof dependency === "object" && dependency !== null
      ? dependency.id ?? dependency.name ?? dependency.componentId ?? dependency.key ?? null
      : dependency)
    .filter((dependency) => dependency !== null && dependency !== undefined)
    .map(String)
    .sort();
  return {
    id: entry.id ?? null,
    version: entry.version ?? null,
    status: entry.status ?? null,
    lifecycle: typeof entry.lifecycle === "string" ? entry.lifecycle : entry.lifecycle?.scope ?? entry.lifecycleState ?? null,
    durable: entry.durable ?? null,
    temporary: entry.temporary ?? null,
    disabled: entry.disabled ?? null,
    requires: dependencyIds(entry.requires),
    resolvedDependencies: dependencyIds(entry.resolvedDependencies),
    effectCount: Array.isArray(entry.effectIds) ? entry.effectIds.length : 0,
    orphanEffectCount: Array.isArray(entry.orphanEffectIds) ? entry.orphanEffectIds.length : 0,
  };

}

function trialEffectFingerprint(entry = {}) {
  return {
    id: null,
    ownerId: entry.ownerId ?? null,
    status: entry.status ?? null,
    kind: entry.kind ?? null,
    label: entry.label ?? null,
    phase: entry.phase ?? null,
  };
}

function trialRuntimeFingerprint(components = [], effects = []) {
  const uniqueEffects = new Map();
  for (const effect of effects) {
    const projection = trialEffectFingerprint(effect);
    const key = `${projection.ownerId}:${projection.status}:${projection.kind}:${projection.label}:${projection.phase}`;
    const current = uniqueEffects.get(key);
    uniqueEffects.set(key, current ? { ...current, count: current.count + 1 } : { ...projection, count: 1 });
  }
  return trialFingerprint({
    components: components.map(trialComponentFingerprint).sort((left, right) => String(left.id).localeCompare(String(right.id))),
    effects: [...uniqueEffects.values()].sort((left, right) => `${left.ownerId}:${left.kind}:${left.label}`.localeCompare(`${right.ownerId}:${right.kind}:${right.label}`)),
  });
}

function trialTimeoutError(timeoutMs) {
  const error = new Error(`Evolution trial cycle timed out after ${timeoutMs}ms`);
  error.code = "ETRIALTIMEOUT";
  error.timeout = true;
  error.timeoutMs = timeoutMs;
  return error;
}

/**
 * Bounded long-running trial layer over EvolutionSupervisor. It owns no
 * components and performs no mutation itself; candidate work remains in the
 * existing EvolutionEngine/ComponentEvolutionCycle and their rollback seams.
 */
export class EvolutionTrialSupervisor {
  constructor({
    supervisor = null,
    runtime = null,
    engine = null,
    host = null,
    evidence = null,
    mutationAuthority = null,
    maxRollbacks = 3,
    rollbackTimeoutMs = 30_000,
    cycle = null,
    discovery = null,
    lineage = null,
    strategyMemory = null,
    strategyResolver = null,
    strategyMutator = null,
    memory = engine?.memory ?? null,
    metrics = engine?.metrics ?? null,
    runEvolution = null,
    rollback = null,
    clock = () => new Date(),
    logger = console,
    cycleTimeoutMs = 30_000,
    maxCycles = 50,
    maxConsecutiveFailures = 3,
    maxRegressions = 3,
    maxOrphans = 0,
    maxMemoryEntries = memory?.maxEntries ?? 1000,
    stopCondition = null,
    ...options
  } = {}) {
    this.clock = clock;
    this.logger = logger;
    if (runtime) throw new TypeError("Use explicit Host/Evidence/Persistence ports, not runtime");
    this.runtime = null;
    this.host = host;
    this.evidence = evidence;
    this.mutationAuthority = mutationAuthority;
    this.maxRollbacks = boundedCount(maxRollbacks, 3, 10000);
    this.rollbackTimeoutMs = Number(rollbackTimeoutMs);
    if (!Number.isFinite(this.rollbackTimeoutMs) || this.rollbackTimeoutMs <= 0) throw new RangeError("rollbackTimeoutMs must be finite and positive");
    this.rollbackAttempts = 0;
    this.engine = engine;
    this.cycle = cycle;
    this.discovery = discovery ?? new EvolutionDiscovery({ metrics, memory, clock });
    this.lineage = lineage;
    this.strategyMemory = strategyMemory;
    this.strategyResolver = strategyResolver;
    this.strategyMutator = strategyMutator ?? strategyResolver?.mutator ?? null;
    this.memory = memory;
    this.metrics = metrics;
    this.runEvolution = runEvolution;
    this.rollback = rollback;
    const timeout = Number(cycleTimeoutMs);
    this.cycleTimeoutMs = Number.isFinite(timeout) ? Math.max(1, timeout) : 30_000;
    const cycleLimit = Number(maxCycles);
    this.maxCycles = Number.isFinite(cycleLimit) ? Math.min(10000, Math.max(1, Math.floor(cycleLimit))) : 50;
    this.maxConsecutiveFailures = Math.max(1, Number(maxConsecutiveFailures) || 3);
    this.maxRegressions = boundedCount(maxRegressions, 3, 10000);
    this.maxOrphans = Math.max(0, Number(maxOrphans) || 0);
    this.maxMemoryEntries = Math.max(1, Number(maxMemoryEntries) || 1000);
    this.stopCondition = stopCondition;
    this.base = supervisor ?? new EvolutionSupervisor({
      host,
      evidence,
      mutationAuthority,
      maxCycles: this.maxCycles,
      engine,
      cycle,
      discovery: this.discovery,
      lineage,
      strategyMemory,
      strategyResolver,
      memory,
      metrics,
      runEvolution,
      clock,
      logger,
      ...options,
    });
    this.history = [];
    this.queue = Promise.resolve();
    this.inFlight = null;
    this.running = false;
    this.stopRequested = false;
    this.stopReason = null;
    this.maintenancePaused = false;
    this.maintenanceResumeRunning = false;
    this.consecutiveFailures = 0;
    this.regressions = 0;
    this.crashes = 0;
    this.startedAt = null;
    this.endedAt = null;
    this.ready = Promise.resolve(this);
  }

  #enqueue(task) {
    if (this.maintenancePaused) {
      const error = new Error("Evolution trial supervisor is paused for maintenance");
      error.code = "E_EVOLUTION_MAINTENANCE_PAUSED";
      throw error;
    }
    const next = this.queue.then(task, task);
    this.inFlight = next;
    this.queue = next.catch((error) => {
      this.logger?.warn?.("Evolution trial supervisor failed: " + (error?.message ?? error));
      return null;
    }).finally(() => { if (this.inFlight === next) this.inFlight = null; });
    return next;
  }

  #runtimeState() {
    const state = requirePort(this.host, "inspectState", "Host")();
    if (!state || !Array.isArray(state.components) || !Array.isArray(state.effects) ||
        typeof state.invariants?.valid !== "boolean" || !Array.isArray(state.invariants.violations)) {
      throw new TypeError("Host.inspectState must return components/effects/invariants evidence");
    }
    const { components, effects, invariants } = state;
    const componentList = Array.isArray(components) ? components : components.components ?? [];
    const effectList = Array.isArray(effects) ? effects : [...(effects.effects ?? []), ...(effects.active ?? [])];
    const orphanComponents = componentList.filter((entry) => /orphan/i.test(String(entry.status ?? entry.lifecycle ?? ""))).length;
    const orphanEffects = effectList.filter((entry) => /orphan|rollback_failed/i.test(String(entry.status ?? entry.lifecycle ?? ""))).length;
    const memorySnapshot = this.memory?.snapshot?.() ?? {};
    const collections = ["observations", "diagnoses", "gaps", "candidates", "proposals", "experiments", "experimentRecords", "journal", "selections", "promotions", "outcomes", "cycles", "lineage", "learnings", "strategies", "strategyMutations"];
    const memoryCounts = Object.fromEntries(collections.map((key) => [key, Array.isArray(memorySnapshot[key]) ? memorySnapshot[key].length : 0]));
    const duplicateIds = collections.some((key) => {
      const ids = (memorySnapshot[key] ?? []).map((entry) => entry?.id).filter(Boolean);
      return new Set(ids).size !== ids.length;
    });
    const memoryPollution = Object.values(memoryCounts).some((count) => count > this.maxMemoryEntries) || duplicateIds;
    return {
      components: componentList.map((entry) => safeRecord({ id: entry.id, version: entry.version, status: entry.status, lifecycle: entry.lifecycle })),
      effects: effectList.map((entry) => safeRecord({ id: entry.id, ownerId: entry.ownerId, status: entry.status, kind: entry.kind })),
      invariants: safeRecord(invariants),
      orphanComponents,
      orphanEffects,
      orphanCount: orphanComponents + orphanEffects,
      registryCorruption: invariants.valid === false || (Array.isArray(invariants.violations) && invariants.violations.length > 0),
      memoryCounts,
      memoryPollution,
      fingerprint: trialRuntimeFingerprint(componentList, effectList),
    };
  }

  async #withTimeout(task, timeoutMs = this.cycleTimeoutMs) {
    // Host must abort AND settle/dispose work before rejecting, not merely race a timer.
    return requirePort(this.host, "runWithDeadline", "Host")(task, { timeoutMs });
  }

  setMutationAuthority(authority) {
    if (this.mutationAuthority && this.mutationAuthority !== authority) throw new Error("E_MUTATION_AUTHORITY_REQUIRED: cannot replace authority");
    this.mutationAuthority = authority;
    this.base.setMutationAuthority?.(authority);
    return this;
  }

  async #strategy(input, target) {
    const supplied = input.strategyCandidate ?? input.strategy ?? null;
    const resolved = this.strategyResolver?.resolve ? await this.strategyResolver.resolve(target ?? {}) : null;
    const previous = this.strategyMutator?.tree?.().at(-1)?.candidateStrategy ?? this.history.at(-1)?.strategy ?? null;
    const parent = input.parentStrategy ?? supplied ?? resolved ?? previous;
    const strategyInput = safeRecord(input.strategyInput ?? {
      target: target ?? null,
      problem: target?.problem ?? input.problem ?? null,
      context: target?.context ?? input.context ?? {},
      resolvedStrategyId: resolved?.id ?? resolved?.strategyKey ?? null,
      reusedFromMemory: Boolean(resolved),
    });
    if (!this.strategyMutator?.mutate) {
      const futureSelection = safeRecord({
        source: resolved ? "evolution-memory" : "input",
        strategyId: parent?.id ?? parent?.strategyKey ?? null,
      });
      return {
        parent,
        candidate: supplied ?? parent,
        node: null,
        causality: { strategyInput, candidateChange: {}, experimentResult: {}, futureSelection },
      };
    }
    const mutation = input.mutation ?? { type: "bounded-parameter-mutation", dimension: target?.suggested_area ?? target?.suggestedArea ?? "runtime", step: 1 };
    const futureSelection = safeRecord({
      source: resolved ? "evolution-memory" : "input",
      strategyId: parent?.id ?? parent?.strategyKey ?? null,
    });
    const mutated = await this.strategyMutator.mutate({
      parentStrategy: parent ?? { strategy: "runtime-observation", context: {} },
      mutation,
      target,
      generation: input.generation,
      generationId: input.generationId,
      experimentId: input.experimentId,
      strategyInput,
      futureSelection,
    });
    return {
      parent,
      candidate: mutated,
      node: mutated.node ?? null,
      causality: mutated.causality ?? mutated.node?.causality ?? {
        strategyInput,
        candidateChange: safeRecord(mutation),
        experimentResult: {},
        futureSelection,
      },
    };
  }

  async #rollback(input, result, error, reason) {
    assertMutation(this.mutationAuthority, "evolution.trial.rollback");
    if (this.rollbackAttempts >= this.maxRollbacks) {
      return { attempted: false, status: "rollback_budget_exhausted", reason };
    }
    this.rollbackAttempts += 1;
    try {
      const rollback = requirePort(this.host, "rollback", "Host");
      const value = await this.#withTimeout(signal => rollback({
        input, result, error, reason, signal,
        experimentId: input.experimentId ?? result?.experimentId ?? result?.experiment?.id ?? null,
      }), this.rollbackTimeoutMs);
      return { attempted: true, status: "rolled_back", result: safeValue(value) };
    } catch (rollbackError) {
      return { attempted: true, status: "rollback_failed", error: safeValue(rollbackError) };
    }
  }

  #decision(report, error) {
    if (error?.timeout) return "timeout_rollback";
    if (error) return "failure_rollback";
    const result = report?.result ?? report;
    return String(result?.decision ?? report?.lineage?.decision ?? report?.status ?? report?.decision?.action ?? "observe").toLowerCase();
  }

  #fitness(report, metricsAfter) {
    const explicit = finite(report?.result?.fitnessScore ?? report?.result?.fitness ?? report?.lineage?.fitnessScore ?? report?.fitnessScore ?? report?.fitness);
    return explicit === null ? metricsFitness(metricsAfter) : clamp01(explicit);
  }

  async #run(input = {}) {
    assertMutation(this.mutationAuthority, "evolution.trial.run");
    requirePort(this.host, "runWithDeadline", "Host");
    requirePort(this.host, "rollback", "Host");
    requirePort(this.memory, "recordCycle", "Persistence.memory");
    const cycleNumber = this.history.length + 1;
    const generation = Math.max(1, Math.floor(Number(input.generation ?? cycleNumber) || cycleNumber));
    const startedAt = timestamp(this.clock);
    const beforeState = this.#runtimeState();
    const discoveryInput = { ...input };
    const discoveredTargets = this.discovery?.propose
      ? await this.discovery.propose(discoveryInput)
      : this.discovery?.analyze
        ? this.discovery.analyze(discoveryInput)
        : [];
    const discovered = input.proposals?.[0] ?? discoveredTargets[0] ?? null;
    const strategy = await this.#strategy(input, discovered);
    const discoveredProposal = discovered && !input.proposals
      ? { ...discovered, trend: null, trendSignals: [], degrading: false, priority: discovered.priority === "low" ? "medium" : discovered.priority, estimatedBenefit: discovered.estimatedBenefit ?? discovered.benefitScore ?? 0.2 }
      : null;
    const trialInput = {
      ...input,
      ...(discoveredProposal ? { proposals: [discoveredProposal] } : {}),
      generation,
      strategy: strategy.candidate ?? input.strategy ?? null,
      strategyCandidate: strategy.candidate ?? null,
      strategyOutcome: input.strategyOutcome ?? {
        ...(strategy.candidate && typeof strategy.candidate === "object" ? safeRecord(strategy.candidate) : {}),
        ...strategy.causality,
      },
      runEvolution: input.runEvolution ?? this.runEvolution,
      signal: undefined,
    };
    let report = null;
    let error = null;
    try {
      report = await this.#withTimeout((signal) => this.base.runCycle({ ...trialInput, signal, trial: true }));
    } catch (caught) {
      error = caught;
      report = caught.report ?? null;
      this.crashes += 1;
    }
    let afterState;
    try { afterState = this.#runtimeState(); } catch (inspectionError) {
      error ??= inspectionError;
      afterState = { ...beforeState, registryCorruption: true, fingerprint: null, inspectionError: safeValue(inspectionError) };
    }
    const baseResult = report?.result ?? report ?? {};
    const metricsBefore = safeRecord(input.beforeMetrics ?? report?.metricsBefore ?? {});
    const metricsAfter = safeRecord(input.afterMetrics ?? report?.metricsAfter ?? baseResult.metricsAfter ?? baseResult.metrics ?? {});
    const decision = this.#decision(report, error);
    const regressed = /reject|fail|rollback|timeout/i.test(decision) || report?.lineage?.decision === "rollback";
    const needsRollback = Boolean(error || regressed || afterState.registryCorruption || afterState.orphanCount > this.maxOrphans);
    const rollback = needsRollback ? await this.#rollback(input, baseResult, error, decision) : { attempted: false, status: "not_required" };
    let finalState;
    try { finalState = this.#runtimeState(); } catch (inspectionError) {
      error ??= inspectionError;
      finalState = { ...beforeState, registryCorruption: true, fingerprint: null, inspectionError: safeValue(inspectionError) };
    }
    const registryRestored = !needsRollback || beforeState.fingerprint === finalState.fingerprint;
    const resources = trialResourceMetrics(metricsBefore, metricsAfter, baseResult);
    const fitness = this.#fitness(report, metricsAfter);
    const experimentResult = safeRecord({
      status: error ? "failed" : String(report?.status ?? baseResult.status ?? decision),
      decision,
      experimentId: baseResult.experimentId ?? baseResult.experiment?.id ?? input.experimentId ?? null,
      metrics: metricsAfter,
      fitness,
      rollback: rollback.status,
    });
    const causality = {
      strategyInput: safeRecord(strategy.causality?.strategyInput ?? input.strategyInput ?? {}),
      candidateChange: safeRecord(strategy.causality?.candidateChange ?? input.mutation ?? {}),
      experimentResult,
      futureSelection: safeRecord(strategy.causality?.futureSelection ?? {
        source: strategy.parent ? "evolution-memory" : "input",
        strategyId: strategy.parent?.id ?? strategy.parent?.strategyKey ?? null,
        generation,
      }),
    };
    const record = {
      id: "trial-cycle:" + hash(String(startedAt) + ":" + cycleNumber),
      cycleId: report?.cycleId ?? report?.id ?? null,
      timestamp: startedAt,
      startedAt,
      endedAt: timestamp(this.clock),
      generation,
      target: clone(discovered ?? null),
      strategy: safeValue(strategy.candidate ?? strategy.parent ?? null),
      candidate: safeValue(baseResult.candidate ?? baseResult.component ?? strategy.candidate ?? input.candidate ?? null),
      metrics: { before: metricsBefore, after: metricsAfter, resources },
      decision,
      decisionDetail: safeValue(report?.decision ?? baseResult.decision ?? null),
      fitness,
      status: error ? "failed" : String(report?.status ?? baseResult.status ?? decision),
      timeout: Boolean(error?.timeout),
      error: error ? safeValue(error) : null,
      rollback,
      failureIsolation: {
        isolated: false, // Domain supervision is not a security/official runtime isolation proof.
        errorContained: needsRollback ? rollback.status === "rolled_back" && registryRestored : true,
        registryRestored,
        inspectionError: finalState.inspectionError ?? afterState.inspectionError ?? null,
        registryCorruption: finalState.registryCorruption,
        registryCorruptionDetected: afterState.registryCorruption,
        orphanComponents: finalState.orphanComponents,
        orphanEffects: finalState.orphanEffects,
        orphanCount: finalState.orphanCount,
        detectedOrphanComponents: afterState.orphanComponents,
        detectedOrphanEffects: afterState.orphanEffects,
        orphanDetected: afterState.orphanCount > this.maxOrphans,
        memoryPollution: finalState.memoryPollution,
        baselineFingerprint: beforeState.fingerprint,
        finalFingerprint: finalState.fingerprint,
      },
      resourceMetrics: resources,
      phases: ["discovery", "proposal", "candidate", "canary", "evaluation", rollback.status === "not_required" && !error ? "promotion" : "rollback", "memory"],
      baseReport: safeValue(report),
      executionBoundary: "domain-port-contract; not official execution or security isolation proof",
      strategyMutation: safeValue(strategy.node),
      causality,
      strategyInput: causality.strategyInput,
      candidateChange: causality.candidateChange,
      experimentResult: causality.experimentResult,
      futureSelection: causality.futureSelection,
    };
    if (this.strategyMutator?.recordResult && strategy.node) {
      await this.strategyMutator.recordResult(strategy.node, {
        result: record.status,
        decision,
        experimentId: baseResult.experimentId ?? baseResult.experiment?.id,
        generationId: report?.lineage?.generationId,
        metrics: metricsAfter,
        fitness,
        ...causality,
      });
    }
    this.history.push(record);
    if (this.history.length > this.maxCycles) this.history.splice(0, this.history.length - this.maxCycles);
    if (error || regressed || record.status === "failed" || rollback.status === "rollback_failed") this.consecutiveFailures += 1;
    else this.consecutiveFailures = 0;
    if (regressed) this.regressions += 1;
    if (this.memory?.recordCycle) await this.memory.recordCycle(record);
    if (this.memory?.setAutonomousState) await this.memory.setAutonomousState({ trialSupervisor: this.snapshot() });
    this.#applyStopConditions(record);
    return clone(record);
  }

  #applyStopConditions(record) {
    if (this.stopRequested) return;
    if (record.timeout) { this.stopRequested = true; this.stopReason = "cycle_timeout"; return; }
    if (["rollback_failed", "rollback_budget_exhausted"].includes(record.rollback.status)) { this.stopRequested = true; this.stopReason = record.rollback.status; return; }
    if (!record.failureIsolation.registryRestored) { this.stopRequested = true; this.stopReason = "rollback_not_restored"; return; }
    if (this.history.length >= this.maxCycles) { this.stopRequested = true; this.stopReason = "max_cycles"; return; }
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) { this.stopRequested = true; this.stopReason = "consecutive_failures"; return; }
    if (this.regressions > this.maxRegressions) { this.stopRequested = true; this.stopReason = "regression_budget_exhausted"; return; }
    if (record.failureIsolation.orphanDetected) { this.stopRequested = true; this.stopReason = "orphan_component_detected"; return; }
    if (record.failureIsolation.registryCorruptionDetected) { this.stopRequested = true; this.stopReason = "registry_corruption"; return; }
    if (typeof this.stopCondition === "function") {
      try {
        if (this.stopCondition({ record: clone(record), history: this.history.map(clone), supervisor: this })) {
          this.stopRequested = true;
          this.stopReason = "custom_stop_condition";
        }
      } catch (error) {
        this.stopRequested = true;
        this.stopReason = "stop_condition_error";
        record.stopConditionError = safeValue(error);
        throw error;
      }
    }
  }

  runCycle(input = {}) {
    return this.#enqueue(async () => {
      if (this.stopRequested) return { status: "stopped", reason: this.stopReason, cycle: null, snapshot: this.snapshot() };
      if (!this.startedAt) this.startedAt = timestamp(this.clock);
      this.running = true;
      try { return await this.#run(input); } finally { this.running = false; this.endedAt = timestamp(this.clock); }
    });
  }

  tick(input = {}) { return this.runCycle(input); }
  runEvolutionCycle(input = {}) { return this.runCycle(input); }

  async runCycles({ count = 10, cycles = null, generationStart = 1, generations = null, ...options } = {}) {
    const requested = boundedCount(cycles ?? count, 10, Number.MAX_SAFE_INTEGER);
    const total = Math.min(requested, this.maxCycles - this.history.length);
    const reports = [];
    for (let index = 0; index < total && !this.stopRequested; index += 1) {
      const cycleInput = Array.isArray(generations) ? (generations[index] ?? {}) : {};
      reports.push(await this.runCycle({ ...options, ...cycleInput, generation: cycleInput.generation ?? Number(generationStart) + index }));
    }
    return this.report({ reports, required: requested });
  }

  async runLongRunning({ count = 50, ...options } = {}) { return this.runCycles({ ...options, count }); }
  async runMultiGeneration({ count = 10, ...options } = {}) { return this.runGenerations({ ...options, count }); }

  async runGenerations({ count = 10, generations = null, ...options } = {}) {
    const requested = boundedCount(count, 10, Number.MAX_SAFE_INTEGER);
    const total = Math.min(requested, this.maxCycles - this.history.length);
    const reports = [];
    let parentVersion = options.parentVersion ?? null;
    for (let index = 0; index < total && !this.stopRequested; index += 1) {
      const generationInput = Array.isArray(generations) ? (generations[index] ?? {}) : {};
      const report = await this.runCycle({
        ...options,
        ...generationInput,
        generation: generationInput.generation ?? (options.generationStart ?? 1) + index,
        parentVersion: generationInput.parentVersion ?? parentVersion,
      });
      reports.push(report);
      parentVersion = report?.baseReport?.lineage?.version ?? report?.baseReport?.result?.version ?? report?.candidate?.version ?? parentVersion;
    }
    return this.report({ reports, required: requested });
  }

  async start({ count = 10, runImmediately = false, ...options } = {}) {
    if (this.maintenancePaused) {
      const error = new Error("Evolution trial supervisor is paused for maintenance");
      error.code = "E_EVOLUTION_MAINTENANCE_PAUSED";
      throw error;
    }
    if (this.running) return this.snapshot();
    this.stopRequested = false;
    this.stopReason = null;
    this.startedAt ??= timestamp(this.clock);
    if (runImmediately) await this.runCycle(options);
    // A bounded start performs only the requested finite window. There is no
    // implicit unbounded timer; callers that need periodic operation schedule
    // explicit finite windows and inspect the returned stop condition.
    if (count > 1 && runImmediately) await this.runCycles({ count: count - 1, ...options });
    return this.snapshot();
  }

  stop(reason = "manual_stop") {
    this.stopRequested = true;
    this.stopReason = reason;
    this.base.stop?.();
    this.running = false;
    this.endedAt = timestamp(this.clock);
    return this;
  }

  async pauseForMaintenance() {
    if (!this.maintenancePaused) {
      this.maintenancePaused = true;
      this.maintenanceResumeRunning = this.running;
      this.stop("maintenance_pause");
    }
    await this.queue.catch(() => {});
    await this.inFlight?.catch?.(() => {});
    return { status: "paused", running: this.maintenanceResumeRunning };
  }

  async resumeFromMaintenance({ resume = true } = {}) {
    if (!this.maintenancePaused) return this.snapshot();
    const shouldRun = resume !== false && this.maintenanceResumeRunning;
    this.maintenancePaused = false;
    this.maintenanceResumeRunning = false;
    if (shouldRun) {
      await this.start({ count: 0, runImmediately: false });
      return { status: "running", running: this.running };
    }
    return { status: "stopped", running: false };
  }

  reset() {
    this.stopRequested = false;
    this.stopReason = null;
    this.consecutiveFailures = 0;
    this.regressions = 0;
    this.crashes = 0;
    return this.snapshot();
  }

  report(options = {}) { return trialReport(this, options); }

  snapshot() { return trialSnapshot(this); }

  reportThreeCycles(options = {}) { return this.report({ ...options, cycles: 3, required: 3 }); }
}

export const ContinuousEvolutionTrialSupervisor = EvolutionTrialSupervisor;
export const LongRunningEvolutionSupervisor = EvolutionTrialSupervisor;
