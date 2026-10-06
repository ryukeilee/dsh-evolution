/**
 * Continuous Self-Evolving Harness compatibility facade.
 *
 * The implementation lives in focused internal modules. This facade keeps
 * the historical import path and public exports stable while assembling the
 * existing evolution services without creating another Runtime or Registry.
 */
import { EvolutionDiscovery } from "./discovery-metrics.js";
import { EvolutionLineage } from "./lineage.js";
import { EvolutionStrategyMemory, EvolutionStrategyResolver } from "./strategy.js";
import { EvolutionSupervisor } from "./supervisor.js";
import { EvolutionTrialSupervisor } from "./trial-supervisor.js";

function clone(value) {
  if (value === undefined || value === null) return value;
  try { return structuredClone(value); } catch {
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
    return value;
  }
}

export {
  EvolutionDiscovery,
  normalizeEvolutionTargetProposal,
  normalizeEvolutionProposal,
  AutonomousDiscovery,
  EvolutionTargetDiscovery,
  DiscoveryLayer,
} from "./discovery-metrics.js";
export {
  EvolutionLineage,
  MultiGenerationEvolution,
  EvolutionLineageStore,
} from "./lineage.js";
export {
  EvolutionStrategyMemory,
  EvolutionStrategyResolver,
  EvolutionStrategyMutator,
  StrategyMutation,
  StrategyEvolutionTree,
  StrategyResolver,
} from "./strategy.js";
export {
  EvolutionSupervisor,
  ContinuousEvolutionSupervisor,
  AutonomousEvolutionSupervisor,
} from "./supervisor.js";
export {
  EvolutionTrialSupervisor,
  ContinuousEvolutionTrialSupervisor,
  LongRunningEvolutionSupervisor,
} from "./trial-supervisor.js";

/** Composition facade that wires only existing Evolution services together. */
export class ContinuousEvolutionHarness {
  constructor({ runtime = null, engine = null, host = null, evidence = null, transaction = null, mutationAuthority = null, cycle = null, memory = engine?.memory ?? null, metrics = engine?.metrics ?? null, stateStore = null, discovery = null, lineage = null, strategyMemory = null, strategyResolver = null, supervisor = null, strategies = {}, clock = () => new Date(), logger = console, ...options } = {}) {
    if (runtime) throw new TypeError("Use explicit Host/Evidence/Persistence ports, not runtime");
    this.runtime = null;
    this.engine = engine;
    this.memory = memory;
    this.metrics = metrics;
    this.cycle = cycle;
    this.discovery = discovery ?? new EvolutionDiscovery({ metrics, memory, clock, ...(options.discoveryOptions ?? {}) });
    this.lineage = lineage ?? new EvolutionLineage({ memory, stateStore, transaction, mutationAuthority, clock, ...(options.lineageOptions ?? {}) });
    this.strategyMemory = strategyMemory ?? new EvolutionStrategyMemory({ memory, stateStore, mutationAuthority, clock, ...(options.strategyOptions ?? {}) });
    this.strategyResolver = strategyResolver ?? new EvolutionStrategyResolver({ memory: this.memory, strategyMemory: this.strategyMemory, strategies, clock });
    this.supervisor = supervisor ?? new EvolutionTrialSupervisor({ host, evidence, mutationAuthority, engine, cycle, discovery: this.discovery, lineage: this.lineage, strategyMemory: this.strategyMemory, strategyResolver: this.strategyResolver, strategyMutator: this.strategyResolver.mutator, memory, metrics, clock, logger, ...(options.supervisorOptions ?? {}) });
    this.ready = Promise.all([this.lineage.ready, this.strategyMemory.ready, this.supervisor.ready]).then(() => this);
  }
  setMutationAuthority(authority) {
    this.lineage?.setMutationAuthority?.(authority);
    this.strategyMemory?.setMutationAuthority?.(authority);
    this.supervisor?.setMutationAuthority?.(authority);
    if (this.strategyResolver?.mutator) this.strategyResolver.mutator.mutationAuthority = authority;
    return this;
  }
  async load() { await this.memory?.load?.(); await this.lineage.load(); return this; }
  async discover(input = {}) { await this.load(); return this.discovery.propose(input); }
  async runCycle(options = {}) { await this.ready; return this.supervisor.runCycle(options); }
  async runGenerations(options = {}) { await this.ready; return this.supervisor.runGenerations(options); }
  async runThreeCycles(options = {}) { await this.ready; return this.supervisor.runThreeCycles?.(options) ?? this.supervisor.runGenerations({ ...options, count: 3 }); }
  async runCycles(options = {}) { await this.ready; return this.supervisor.runCycles?.(options) ?? this.supervisor.runGenerations(options); }
  async runLongRunning(options = {}) { await this.ready; return this.supervisor.runLongRunning?.(options) ?? this.supervisor.runCycles({ ...options, count: options.count ?? 50 }); }
  async runMultiGeneration(options = {}) { await this.ready; return this.supervisor.runMultiGeneration?.(options) ?? this.supervisor.runGenerations({ ...options, count: options.count ?? 10 }); }
  report(options = {}) { return this.supervisor.report(options); }
  reportThreeCycles(options = {}) { return this.supervisor.reportThreeCycles?.(options) ?? this.supervisor.report({ ...options, cycles: 3, required: 3 }); }
  reportLongRunning(options = {}) { return this.supervisor.report(options); }
  start(options = {}) { return this.supervisor.start(options); }
  stop() { return this.supervisor.stop(); }
  refreshProjection(memorySnapshot = null) {
    const source = memorySnapshot ?? this.memory?.fullSnapshot?.() ?? this.memory?.snapshot?.() ?? {};
    this.lineage?.refreshProjection?.(source);
    this.strategyMemory?.refreshProjection?.(source);
    return this.snapshot({ memorySnapshot: source });
  }
  snapshot({ memorySnapshot = null } = {}) {
    // The harness snapshot is part of the public runtime snapshot contract:
    // materialise lineage/strategy cold tiers only here. Supervisor and
    // discovery remain evidence-sized, so routine decision paths do not pin
    // their historical payloads.
    return {
      discovery: this.discovery.snapshot(),
      lineage: memorySnapshot?.lineage
        ? { schema: 1, generations: memorySnapshot.lineage, count: memorySnapshot.lineage.length }
        : this.lineage.fullSnapshot?.() ?? this.lineage.snapshot(),
      strategyMemory: memorySnapshot?.strategies || memorySnapshot?.strategyMutations
        ? {
            strategies: memorySnapshot.strategies ?? [],
            mutations: memorySnapshot.strategyMutations ?? [],
            count: (memorySnapshot.strategies ?? []).length,
            mutationCount: (memorySnapshot.strategyMutations ?? []).length,
          }
        : this.strategyMemory.fullSnapshot?.() ?? this.strategyMemory.snapshot(),
      supervisor: this.supervisor.snapshot(),
    };
  }
  async restoreSnapshot(snapshot = {}, { persist = true } = {}) {
    await this.ready;
    if (snapshot.lineage && Array.isArray(snapshot.lineage.generations)) await this.lineage.restore(snapshot.lineage, { persist });
    if (snapshot.strategyMemory && (Array.isArray(snapshot.strategyMemory.strategies) || Array.isArray(snapshot.strategyMemory.mutations))) await this.strategyMemory.restore(snapshot.strategyMemory, { persist });
    const supervisor = snapshot.supervisor;
    if (supervisor && typeof supervisor === "object") {
      if (Array.isArray(supervisor.history)) this.supervisor.history = supervisor.history.map(clone);
      if (supervisor.stopRequested !== undefined) this.supervisor.stopRequested = Boolean(supervisor.stopRequested);
      if (supervisor.stopReason !== undefined) this.supervisor.stopReason = supervisor.stopReason;
      if (supervisor.consecutiveFailures !== undefined) this.supervisor.consecutiveFailures = Number(supervisor.consecutiveFailures) || 0;
      if (supervisor.regressions !== undefined) this.supervisor.regressions = Number(supervisor.regressions) || 0;
      if (supervisor.crashes !== undefined) this.supervisor.crashes = Number(supervisor.crashes) || 0;
      if (supervisor.rollbackAttempts !== undefined) this.supervisor.rollbackAttempts = Number(supervisor.rollbackAttempts) || 0;
      if (supervisor.completedCycles !== undefined) this.supervisor.completedCycles = Number(supervisor.completedCycles) || 0;
    }
    return this.snapshot();
  }
}

export const SelfEvolvingHarness = ContinuousEvolutionHarness;
export const DSHContinuousEvolutionHarness = ContinuousEvolutionHarness;
export function createContinuousEvolutionHarness(options = {}) { return new ContinuousEvolutionHarness(options); }
export function createEvolutionDiscovery(options = {}) { return new EvolutionDiscovery(options); }
export function createEvolutionLineage(options = {}) { return new EvolutionLineage(options); }
export function createEvolutionSupervisor(options = {}) { return new EvolutionSupervisor(options); }
export function createEvolutionTrialSupervisor(options = {}) { return new EvolutionTrialSupervisor(options); }
