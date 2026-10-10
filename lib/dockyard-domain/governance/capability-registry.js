import { ValidationError } from "../errors.js";
import { MutationAuthorityError } from "./mutation-authority.js";
import { clone, timestamp, safeRecord, clamp01 } from "./helpers.js";
import { computeFitnessScore } from "./fitness.js";
export const CAPABILITY_LIFECYCLE = Object.freeze({
  CANDIDATE: "candidate",
  EXPERIMENTAL: "experimental",
  PROMOTED: "promoted",
  ACTIVE: "active",
  SUSPECT: "suspect",
  DEPRECATED: "deprecated",
  ARCHIVED: "archived",
  REMOVED: "removed",
});

export const ACTIVE_LIFECYCLE_STATES = new Set([
  CAPABILITY_LIFECYCLE.ACTIVE, CAPABILITY_LIFECYCLE.PROMOTED,
  CAPABILITY_LIFECYCLE.EXPERIMENTAL, CAPABILITY_LIFECYCLE.CANDIDATE, CAPABILITY_LIFECYCLE.SUSPECT,
]);

/** 创建链（genesis）与退休链（retirement）共用一张迁移表；rollback 与 replacement-promotion 边显式列出。 */
export const CAPABILITY_TRANSITIONS = Object.freeze({
  candidate: ["experimental", "promoted", "active", "removed"],
  experimental: ["promoted", "candidate", "removed"],
  promoted: ["active", "deprecated", "experimental"],
  active: ["candidate", "suspect", "deprecated"],
  suspect: ["deprecated", "active"],
  deprecated: ["archived", "active", "suspect"],
  archived: ["removed", "deprecated", "active"],
  removed: [],
});

function emptyCapabilityStats() {
  return {
    usageCount: 0,
    successCount: 0,
    failureCount: 0,
    totalLatencyMs: 0,
    totalResourceCost: 0,
    userFeedbackSum: 0,
    userFeedbackCount: 0,
  };
}

function capabilityMetricsFromStats(stats = emptyCapabilityStats()) {
  const usageCount = Number(stats.usageCount) || 0;
  return {
    usageCount,
    successRate: usageCount > 0 ? stats.successCount / usageCount : null,
    errorRate: usageCount > 0 ? stats.failureCount / usageCount : null,
    avgLatencyMs: usageCount > 0 ? stats.totalLatencyMs / usageCount : null,
    avgResourceCost: usageCount > 0 ? stats.totalResourceCost / usageCount : null,
    avgUserFeedback: stats.userFeedbackCount > 0 ? stats.userFeedbackSum / stats.userFeedbackCount : null,
  };
}

export class CapabilityRegistry {
  constructor({ store = null, clock = () => new Date(), logger = console, mutationAuthority = null } = {}) {
    if (!store || !mutationAuthority) throw new MutationAuthorityError("capability.ports.required");
    this.store = store;
    this.clock = clock;
    this.logger = logger;
    this.mutationAuthority = mutationAuthority;
    this.ready = store ? store.load() : Promise.resolve(null);
  }

  #queue = Promise.resolve();
  #enqueue(operation, perform) {
    this.#assertMutation(operation);
    const next = this.#queue.then(async () => { await this.ready; this.#assertMutation(operation); return perform(); });
    this.#queue = next.catch(() => {});
    return next;
  }
  registerCapability(spec = {}) { return this.#enqueue("capability.register", () => this.#registerCapability(spec)); }
  transition(id, state, options) { return this.#enqueue("capability.transition", () => this.#transition(id, state, options)); }
  recordUsage(id, options) { return this.#enqueue("capability.recordUsage", () => this.#recordUsage(id, options)); }
  recordVersion(id, options) { return this.#enqueue("capability.recordVersion", () => this.#recordVersion(id, options)); }

  setMutationAuthority(authority) {
    if (this.mutationAuthority && authority !== this.mutationAuthority) throw new MutationAuthorityError("capability.authority.replace");
    this.mutationAuthority = authority ?? null;
    return this;
  }

  #assertMutation(operation) {
    if (!this.mutationAuthority) throw new MutationAuthorityError(operation);
    this.mutationAuthority.assertMutation(operation);
  }

  list({ lifecycleState = null } = {}) {
    const all = this.store?.data.capabilities ?? [];
    return clone(lifecycleState ? all.filter((entry) => entry.lifecycleState === lifecycleState) : all);
  }

  get(capabilityId) {
    return clone((this.store?.data.capabilities ?? []).find((entry) => entry.id === capabilityId) ?? null);
  }

  dependentsOf(capabilityId) {
    return this.list().filter((entry) => entry.id !== capabilityId
      && Array.isArray(entry.dependencies)
      && entry.dependencies.map(String).includes(String(capabilityId)));
  }

  async #registerCapability(spec = {}) {
    this.#assertMutation("capability.register");
    if (!spec.id) throw new ValidationError("Capability requires an id");
    const now = timestamp(this.clock);
    const existing = (this.store?.data.capabilities ?? []).find((entry) => entry.id === spec.id);
    if (existing?.lifecycleState === CAPABILITY_LIFECYCLE.REMOVED) {
      throw new ValidationError("Cannot re-register a removed capability", { capabilityId: spec.id });
    }
    const lifecycleState = spec.lifecycleState ?? existing?.lifecycleState ?? CAPABILITY_LIFECYCLE.ACTIVE;
    if (!Object.hasOwn(CAPABILITY_TRANSITIONS, lifecycleState)) throw new ValidationError("Unknown capability lifecycle state");
    if (existing && lifecycleState !== existing.lifecycleState) throw new ValidationError("Use transition to change capability lifecycle");
    const record = {
      ...existing,
      schema: 1,
      id: spec.id,
      type: spec.type ?? existing?.type ?? "tool",
      version: spec.version ?? existing?.version ?? "0.0.0",
      owner: spec.owner ?? existing?.owner ?? "dsh-autonomous-evolution",
      plugin: safeRecord(spec.plugin ?? existing?.plugin),
      component: spec.component ?? existing?.component ?? spec.id,
      dependencies: (Array.isArray(spec.dependencies) ? spec.dependencies : existing?.dependencies ?? []).map(String),
      provides: (Array.isArray(spec.provides) && spec.provides.length > 0 ? spec.provides : [spec.id]).map(String),
      lifecycleState,
      versionHistory: existing?.versionHistory ?? [],
      stats: existing?.stats ?? emptyCapabilityStats(),
      deprecationReason: existing?.deprecationReason ?? null,
      replacement: existing?.replacement ?? null,
      archivePath: existing?.archivePath ?? null,
      previousLifecycleState: existing?.previousLifecycleState ?? null,
      rollback: safeRecord(spec.rollback ?? existing?.rollback),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const metrics = capabilityMetricsFromStats(record.stats);
    const fitness = computeFitnessScore(
      { ...metrics, maintenanceCost: record.plugin.directory ? 0.3 : 0.1 },
      { computedAt: now },
    );
    record.fitnessScore = fitness.score;
    record.fitnessFactors = fitness.factors;
    await this.#persist(record);
    return clone(record);
  }

  async #transition(capabilityId, toState, { reason = null } = {}) {
    this.#assertMutation("capability.transition");
    const current = this.get(capabilityId);
    if (!current) throw new ValidationError(`Capability is not registered: ${capabilityId}`);
    const allowed = CAPABILITY_TRANSITIONS[current.lifecycleState] ?? [];
    if (!allowed.includes(toState)) {
      throw new ValidationError(
        `Illegal capability lifecycle transition: ${current.lifecycleState} → ${toState}`,
        { capabilityId, from: current.lifecycleState, to: toState, allowed },
      );
    }
    current.previousLifecycleState = current.lifecycleState;
    current.lifecycleState = toState;
    current.updatedAt = timestamp(this.clock);
    current.history = [
      ...(current.history ?? []),
      { from: current.previousLifecycleState, to: toState, reason: reason ? String(reason) : null, at: current.updatedAt },
    ].slice(-50);
    await this.#persist(current);
    return clone(current);
  }

  async #recordUsage(capabilityId, { success = true, latencyMs = 0, resourceCost = 0, userFeedback = null } = {}) {
    this.#assertMutation("capability.recordUsage");
    const current = this.get(capabilityId);
    if (!current) throw new ValidationError(`Capability is not registered: ${capabilityId}`);
    const stats = { ...emptyCapabilityStats(), ...current.stats };
    stats.usageCount += 1;
    if (success) stats.successCount += 1;
    else stats.failureCount += 1;
    stats.totalLatencyMs += Math.max(0, Number(latencyMs) || 0);
    stats.totalResourceCost += Math.max(0, Number(resourceCost) || 0);
    if (userFeedback !== null && userFeedback !== undefined && Number.isFinite(Number(userFeedback))) {
      stats.userFeedbackSum += clamp01(userFeedback);
      stats.userFeedbackCount += 1;
    }
    current.stats = stats;
    current.updatedAt = timestamp(this.clock);
    const metrics = capabilityMetricsFromStats(stats);
    const fitness = computeFitnessScore(
      { ...metrics, maintenanceCost: current.plugin?.directory ? 0.3 : 0.1 },
      { computedAt: current.updatedAt },
    );
    current.metrics = metrics;
    current.fitnessScore = fitness.score;
    current.fitnessFactors = fitness.factors;
    await this.#persist(current);
    return { capability: clone(current), metrics, fitnessScore: current.fitnessScore };
  }

  metrics(capabilityId) {
    const current = this.get(capabilityId);
    if (!current) throw new ValidationError(`Capability is not registered: ${capabilityId}`);
    return capabilityMetricsFromStats(current.stats ?? emptyCapabilityStats());
  }

  async #recordVersion(capabilityId, { version, note = null } = {}) {
    this.#assertMutation("capability.recordVersion");
    const current = this.get(capabilityId);
    if (!current) throw new ValidationError(`Capability is not registered: ${capabilityId}`);
    current.versionHistory = [
      ...(current.versionHistory ?? []),
      { version: String(version ?? current.version), note: note ? String(note) : null, at: timestamp(this.clock) },
    ];
    current.version = String(version ?? current.version);
    current.updatedAt = timestamp(this.clock);
    await this.#persist(current);
    return clone(current.versionHistory);
  }

  async #persist(record) {
    if (!this.store) return;
    await this.store.update((data) => {
      const capabilities = [...(data.capabilities ?? [])];
      const index = capabilities.findIndex((entry) => entry.id === record.id);
      if (index >= 0) capabilities[index] = clone(record);
      else capabilities.push(clone(record));
      return { ...data, capabilities };
    });
  }

  snapshot() {
    // `list()` clones every capability, so the count is taken from the one copy
    // this snapshot returns instead of building a second discarded copy.
    const capabilities = this.list();
    return {
      capabilities,
      activeCount: capabilities.filter((entry) => ACTIVE_LIFECYCLE_STATES.has(entry.lifecycleState)).length,
    };
  }
}

