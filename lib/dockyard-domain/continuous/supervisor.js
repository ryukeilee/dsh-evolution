/** Decision supervisor for continuous evolution. */
import { clamp01, clone, finite, hash, safeRecord, safeValue, timestamp } from "./shared.js";
import { normalizeProposal } from "./discovery-metrics.js";
import { metricsFitness, supervisorReport, supervisorSnapshot } from "./reporting.js";

import { assertMutation, boundedCount, requirePort } from "./ports.js";

const SUPERVISOR_ACTIONS = Object.freeze({ WAIT: "wait", OBSERVE: "observe", ANALYZE: "analyze", EXPERIMENT: "experiment" });

function proposalBenefit(proposal = {}) {
  return finite(proposal.benefitScore ?? proposal.estimatedBenefit ?? proposal.expectedBenefit ?? proposal.benefit) ?? 0;
}

function proposalIsRegression(proposal = {}) {
  return proposal.trend === "degrading" || proposal.trend === "abnormal_growth" || proposal.degrading === true || proposal.regression === true || (Array.isArray(proposal.trendSignals) && proposal.trendSignals.some((value) => /degrad|regression|abnormal/i.test(String(value))));
}

function proposalSampleCount(proposals) {
  return proposals.reduce((sum, proposal) => Math.max(sum, Number(proposal.sampleCount ?? proposal.occurrences ?? 0) || 0), 0);
}

/**
 * Long-running decision supervisor. It decides whether to wait, observe,
 * analyze, or authorize an existing evolution cycle. The cycle/engine remain
 * responsible for all actual experiments and mutations.
 */
export class EvolutionSupervisor {
  constructor({ runtime = null, engine = null, host = null, evidence = null, mutationAuthority = null, maxCycles = 50, cycle = null, discovery = null, lineage = null, strategyMemory = null, strategyResolver = null, memory = engine?.memory ?? null, metrics = engine?.metrics ?? null, metricProvider = null, runEvolution = null, clock = () => new Date(), logger = console, mode = "scheduled", minSamples = 3, minConfidence = 0.65, minBenefit = 0.1, intervalMs = 30_000, maxConsecutiveFailures = 3, eventTypes = ["evolution/observation", "performance/metric", "tool/failed", "session/failed", "goal/failed"], autoStart = false } = {}) {
    if (runtime) throw new TypeError("Use explicit Host/Evidence/Persistence ports, not runtime");
    this.runtime = null;
    this.host = host;
    this.evidence = evidence;
    this.mutationAuthority = mutationAuthority;
    this.maxCycles = boundedCount(maxCycles, 50, 10000);
    this.engine = engine;
    this.cycle = cycle;
    this.discovery = discovery;
    this.lineage = lineage;
    this.strategyMemory = strategyMemory;
    this.strategyResolver = strategyResolver;
    this.memory = memory;
    this.metrics = metrics;
    this.metricProvider = metricProvider;
    this.runEvolution = runEvolution;
    this.clock = clock;
    this.logger = logger;
    this.mode = String(mode ?? "scheduled").toLowerCase();
    this.minSamples = Math.max(1, Number(minSamples) || 3);
    this.minConfidence = clamp01(minConfidence, 0.65);
    this.minBenefit = Math.max(0, Number(minBenefit) || 0.1);
    this.intervalMs = Math.max(0, Number(intervalMs) || 30_000);
    this.maxConsecutiveFailures = Math.max(1, Number(maxConsecutiveFailures) || 3);
    this.eventTypes = [...eventTypes];
    this.autoStart = autoStart === true;
    this.running = false;
    this.timer = null;
    this.unsubscribers = [];
    this.queue = Promise.resolve();
    this.inFlight = null;
    this.history = [];
    this.completedCycles = 0;
    this.decisions = [];
    this.consecutiveFailures = 0;
    this.circuitOpen = false;
    this.lastSuccessAt = null;
    this.lastError = null;
    this.startedAt = null;
    this.ready = Promise.resolve(this);
  }

  #enqueue(task) {
    const next = this.queue.then(task, task);
    this.inFlight = next;
    this.queue = next.catch((error) => {
      this.lastError = error?.message ?? String(error);
      if (!error?.report) this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.maxConsecutiveFailures) this.circuitOpen = true;
      this.logger?.warn?.("Evolution supervisor cycle failed: " + this.lastError);
      return { status: "failed", error: this.lastError };
    }).finally(() => { if (this.inFlight === next) this.inFlight = null; });
    return next;
  }

  setMutationAuthority(authority) {
    if (this.mutationAuthority && this.mutationAuthority !== authority) throw new Error("E_MUTATION_AUTHORITY_REQUIRED: cannot replace authority");
    this.mutationAuthority = authority;
    return this;
  }

  #sampleCount(input, proposals, metrics) {
    return Number(input.sampleCount ?? proposalSampleCount(proposals) ?? (Array.isArray(metrics?.samples) ? metrics.samples.length : 0)) || 0;
  }

  async #metrics(input, phase) {
    if (phase === "before" && input.beforeMetrics !== undefined) return clone(input.beforeMetrics);
    if (phase === "after" && input.afterMetrics !== undefined) return clone(input.afterMetrics);
    if (typeof input.metricProvider === "function") return clone(await input.metricProvider({ phase, supervisor: this, runtime: this.runtime }));
    if (typeof this.metricProvider === "function") return clone(await this.metricProvider({ phase, supervisor: this, runtime: this.runtime }));
    if (phase === "before" && input.metrics !== undefined) {
      const value = input.metrics;
      return value && typeof value.snapshot === "function" ? clone(value.snapshot()) : clone(value);
    }
    if (this.metrics?.snapshot) return clone(this.metrics.snapshot());
    return clone(await requirePort(this.evidence, "metrics", "Evidence")({ phase, input }));
  }

  decide({ proposals = [], metrics = {}, sampleCount = 0, trigger = "scheduled" } = {}) {
    const normalized = (Array.isArray(proposals) ? proposals : [proposals]).filter(Boolean).map((value) => normalizeProposal(value, { clock: this.clock }));
    const count = Number(sampleCount) || this.#sampleCount({}, normalized, metrics);
    let action = SUPERVISOR_ACTIONS.OBSERVE;
    let reason = "no_high_value_target";
    if (count < this.minSamples && normalized.length === 0) {
      action = SUPERVISOR_ACTIONS.WAIT;
      reason = "insufficient_data";
    } else if (normalized.length === 0) {
      action = SUPERVISOR_ACTIONS.OBSERVE;
      reason = "no_candidate_target";
    } else if (normalized.some(proposalIsRegression)) {
      action = SUPERVISOR_ACTIONS.ANALYZE;
      reason = "clear_regression_or_degradation";
    } else if (normalized.every((proposal) => proposal.confidence < this.minConfidence)) {
      action = SUPERVISOR_ACTIONS.OBSERVE;
      reason = "low_confidence";
    } else if (normalized.some((proposal) => proposal.confidence >= this.minConfidence && (proposal.priority === "high" || proposalBenefit(proposal) >= this.minBenefit))) {
      action = SUPERVISOR_ACTIONS.EXPERIMENT;
      reason = "high_benefit_candidate";
    }
    const decision = { action, reason, trigger, sampleCount: count, proposals: normalized.map(clone), decidedAt: timestamp(this.clock) };
    this.decisions.push(clone(decision));
    if (this.decisions.length > 100) this.decisions.splice(0, this.decisions.length - 100);
    return decision;
  }

  async #execute(input, decision, beforeMetrics, proposals) {
    if (decision.action !== SUPERVISOR_ACTIONS.EXPERIMENT) return null;
    assertMutation(this.mutationAuthority, "evolution.supervisor.execute");
    const execute = requirePort(this.host, "executeCycle", "Host");
    const validate = requirePort(this.evidence, "validateResult", "Evidence");
    requirePort(this.memory, "setAutonomousState", "Persistence.memory");
    if (input.runEvolution || input.experiment || this.runEvolution || this.cycle) {
      throw new TypeError("Execution callbacks/cycle must be adapted into Host.executeCycle");
    }
    const result = await execute({ ...input, target: proposals[0] ?? null, proposals, decision, metricsBefore: beforeMetrics, supervisor: this });
    if (await validate(result, { input, metricsBefore: beforeMetrics }) !== true) {
      throw new Error("E_CONTINUOUS_EVIDENCE_REJECTED: result evidence not verified");
    }
    return result;
  }

  async #runCycle(input = {}) {
    if (this.completedCycles >= this.maxCycles) return { status: "blocked", reason: "max_cycles", proposals: [] };
    if (this.circuitOpen) return { status: "blocked", reason: "circuit_open", decision: { action: SUPERVISOR_ACTIONS.WAIT, reason: "circuit_open" }, proposals: [] };
    const beforeMetrics = await this.#metrics(input, "before");
    const proposals = input.proposals
      ? (Array.isArray(input.proposals) ? input.proposals : [input.proposals]).map((value) => normalizeProposal(value, { clock: this.clock }))
      : this.discovery?.propose
        ? await this.discovery.propose({ ...input, metrics: beforeMetrics })
        : this.discovery?.analyze
          ? this.discovery.analyze({ ...input, metrics: beforeMetrics })
          : [];
    const decision = this.decide({ proposals, metrics: beforeMetrics, sampleCount: this.#sampleCount(input, proposals, beforeMetrics), trigger: input.trigger ?? this.mode });
    let executionError = null;
    let result = null;
    let afterMetrics = input.afterMetrics !== undefined ? clone(input.afterMetrics) : beforeMetrics;
    try {
      result = await this.#execute(input, decision, beforeMetrics, proposals);
      if (input.afterMetrics === undefined && result?.metricsAfter !== undefined) afterMetrics = clone(result.metricsAfter);
      else if (input.afterMetrics === undefined && decision.action === SUPERVISOR_ACTIONS.EXPERIMENT) afterMetrics = await this.#metrics({ ...input, result }, "after");
      this.consecutiveFailures = 0;
      this.lastSuccessAt = timestamp(this.clock);
      this.lastError = null;
      this.circuitOpen = false;
    } catch (error) {
      executionError = error;
      this.consecutiveFailures += 1;
      this.lastError = error?.message ?? String(error);
      if (this.consecutiveFailures >= this.maxConsecutiveFailures) this.circuitOpen = true;
      result = { status: "failed", error: this.lastError };
    }
    const target = proposals[0] ?? {};
    let lineageRecord = null;
    if (this.lineage && input.recordLineage !== false) {
      lineageRecord = await this.lineage.record({
        lineageId: input.lineageId,
        generation: input.generation,
        parentId: input.parentId,
        parentVersion: input.parentVersion,
        version: input.version ?? result?.version ?? "generation-" + String(input.generation ?? this.lineage.list({ lineageId: input.lineageId }).length + 1),
        target: input.target ?? target.targetComponent ?? target.suggested_area ?? target.problem ?? "runtime",
        mutation: input.mutation ?? result?.mutation ?? { area: target.suggested_area ?? target.suggestedArea ?? null },
        metricsBefore: beforeMetrics,
        metricsAfter: afterMetrics,
        decision: result?.decision ?? result?.status ?? decision.action,
        fitnessScore: result?.fitnessScore ?? result?.fitness ?? metricsFitness(afterMetrics),
        experimentId: result?.experimentId ?? result?.experiment?.id ?? null,
        cycleId: result?.id ?? result?.cycleId ?? null,
        strategyId: result?.strategyId ?? null,
      });
    }
    const strategyOutcome = input.strategyOutcome ?? (result?.strategy ? { ...result.strategy, success: result.status === "promoted" || result.status === "validated" } : null);
    if (strategyOutcome && this.strategyMemory?.learn) await this.strategyMemory.learn({ ...strategyOutcome, success: !executionError && ["promoted", "validated", "adopted"].includes(result?.status), sourceGenerationId: lineageRecord?.generationId });
    const report = {
      id: "supervisor-cycle:" + hash(String(timestamp(this.clock)) + ":" + String(this.history.length + 1)),
      trigger: input.trigger ?? this.mode,
      startedAt: beforeMetrics?.recordedAt ?? timestamp(this.clock),
      endedAt: timestamp(this.clock),
      status: result?.status ?? decision.action,
      decision,
      proposals: proposals.map(clone),
      metricsBefore: safeRecord(beforeMetrics),
      metricsAfter: safeRecord(afterMetrics),
      result: safeValue(result),
      lineage: lineageRecord,
      strategyLearned: Boolean(strategyOutcome),
    };
    this.completedCycles += 1;
    this.history.push(report);
    if (this.history.length > 100) this.history.splice(0, this.history.length - 100);
    if (this.memory?.setAutonomousState) await this.memory.setAutonomousState({ supervisor: this.snapshot() });
    if (executionError) { executionError.report = clone(report); throw executionError; }
    return clone(report);
  }

  runCycle(input = {}) { return this.#enqueue(() => this.#runCycle(input)); }
  tick(input = {}) { return this.runCycle({ ...input, trigger: input.trigger ?? this.mode }); }
  runDaily(input = {}) { return this.runCycle({ ...input, trigger: "daily" }); }
  runScheduled(input = {}) { return this.runCycle({ ...input, trigger: "scheduled" }); }
  runEvent(input = {}) { return this.runCycle({ ...input, trigger: "event" }); }

  async runGenerations({ count = 3, generations = null, ...options } = {}) {
    const total = boundedCount(count, 3, this.maxCycles);
    const reports = [];
    let parent = options.parentVersion ?? null;
    for (let index = 0; index < total; index += 1) {
      const generationInput = Array.isArray(generations) ? (generations[index] ?? {}) : {};
      const report = await this.runCycle({ ...options, ...generationInput, generation: generationInput.generation ?? index + 1, parentVersion: generationInput.parentVersion ?? parent, lineageId: generationInput.lineageId ?? options.lineageId, trigger: generationInput.trigger ?? options.trigger ?? "scheduled" });
      reports.push(report);
      parent = report.lineage?.version ?? generationInput.version ?? parent;
      if (this.circuitOpen || this.completedCycles >= this.maxCycles) break;
      if (options.stopOnRegression && (report.decision?.action === SUPERVISOR_ACTIONS.ANALYZE || report.lineage?.decision === "rollback")) break;
    }
    return this.report({ reports, required: total });
  }
  runCycles(options = {}) { return this.runGenerations(options); }
  runThreeCycles(options = {}) { return this.runGenerations({ ...options, count: 3 }); }

  async start({ mode = this.mode, intervalMs = this.intervalMs, runImmediately = false, eventTypes = this.eventTypes, ...options } = {}) {
    if (this.running || this.circuitOpen) return this.snapshot();
    assertMutation(this.mutationAuthority, "evolution.supervisor.start");
    this.mode = String(mode ?? "scheduled").toLowerCase();
    this.intervalMs = Math.max(0, Number(intervalMs) || this.intervalMs);
    this.eventTypes = [...eventTypes];
    const eventMode = ["event", "event-driven", "event_driven"].includes(this.mode);
    const register = requirePort(this.host, eventMode ? "subscribe" : "schedule", "Host");
    // Host owns errors, finite scheduling budgets and Cordis scope disposal.
    const dispose = eventMode
      ? register(this.eventTypes, event => this.handleEvent(event, options))
      : register(() => this.tick(options), { intervalMs: this.intervalMs, maxCycles: this.maxCycles });
    if (typeof dispose !== "function") throw new TypeError("Host scheduler must return a disposer");
    this.unsubscribers.push(dispose);
    this.running = true;
    this.startedAt = timestamp(this.clock);
    if (runImmediately) await this.tick({ ...options, trigger: this.mode });
    return this.snapshot();
  }

  startDaily(options = {}) { return this.start({ ...options, mode: "daily" }); }
  startScheduled(options = {}) { return this.start({ ...options, mode: "scheduled" }); }
  startEventDriven(options = {}) { return this.start({ ...options, mode: "event" }); }
  scheduleDaily(options = {}) { return this.startDaily(options); }
  schedule(options = {}) { return this.startScheduled(options); }

  handleEvent(event = {}, options = {}) {
    const type = typeof event === "string" ? event : event.type;
    if (type && this.eventTypes.length > 0 && !this.eventTypes.includes(type)) return Promise.resolve({ status: "ignored", reason: "event_not_allowlisted", eventType: type });
    const payload = typeof event === "object" ? event.payload ?? event : {};
    return this.runEvent({ ...options, event: safeValue(event), ...payload });
  }

  stop() {
    // No domain-owned timer.
    this.timer = null;
    this.running = false;
    const errors = [];
    for (const unsubscribe of this.unsubscribers.splice(0)) try { unsubscribe(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Continuous host disposal failed");
    return this;
  }

  resetCircuit() { this.circuitOpen = false; this.consecutiveFailures = 0; this.lastError = null; return this.snapshot(); }

  report(options = {}) { return supervisorReport(this, options); }

  reportThreeCycles(options = {}) { return this.report({ ...options, cycles: 3, required: 3 }); }

  snapshot() { return supervisorSnapshot(this); }
}

export const ContinuousEvolutionSupervisor = EvolutionSupervisor;
export const AutonomousEvolutionSupervisor = EvolutionSupervisor;
