/** Durable evolution lineage backed by the existing memory/state store. */
import { clamp01, clone, finite, hash, safeRecord, safeValue, timestamp } from "./shared.js";
import { metricsFitness } from "./discovery-metrics.js";
import { assertMutation, requirePort } from "./ports.js";

export function decisionName(value) {
  return String(value ?? "observe").toLowerCase();
}

function targetKey(target) {
  if (target && typeof target === "object") return String(target.lineageId ?? target.targetId ?? target.target ?? target.componentId ?? target.problem ?? "runtime");
  return String(target ?? "runtime");
}

function readonlyProjection(value) {
  const seen = new WeakMap();
  const protect = (entry) => {
    if (!entry || typeof entry !== "object") return entry;
    if (entry instanceof Date) return new Date(entry.getTime());
    if (seen.has(entry)) return seen.get(entry);
    const target = Array.isArray(entry) ? [] : {};
    const projection = new Proxy(target, {
      set() { const error = new Error("E_MUTATION_AUTHORITY_REQUIRED: evolution lineage projection is read-only"); error.code = "E_MUTATION_AUTHORITY_REQUIRED"; throw error; },
      defineProperty() { const error = new Error("E_MUTATION_AUTHORITY_REQUIRED: evolution lineage projection is read-only"); error.code = "E_MUTATION_AUTHORITY_REQUIRED"; throw error; },
      deleteProperty() { const error = new Error("E_MUTATION_AUTHORITY_REQUIRED: evolution lineage projection is read-only"); error.code = "E_MUTATION_AUTHORITY_REQUIRED"; throw error; },
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

function normalizeLineageRecord(input = {}, previous = null, clock = () => new Date()) {
  const generationValue = finite(input.generation ?? input.generationId);
  const generation = generationValue === null ? (previous ? Number(previous.generation) + 1 : 1) : Math.max(1, Math.floor(generationValue));
  const target = input.target ?? input.targetId ?? input.targetComponent ?? input.componentId ?? input.problem ?? previous?.target ?? "runtime";
  const lineageId = String(input.lineageId ?? previous?.lineageId ?? "lineage:" + hash(targetKey(target)));
  const parentId = input.parentId ?? input.parentGenerationId ?? previous?.id ?? null;
  const metricsBefore = safeRecord(input.metricsBefore ?? input.beforeMetrics ?? input.baselineMetrics ?? {});
  const metricsAfter = safeRecord(input.metricsAfter ?? input.afterMetrics ?? input.candidateMetrics ?? {});
  const decision = decisionName(input.decision ?? input.status ?? "observe");
  const fitnessScore = clamp01(input.fitnessScore ?? input.fitness ?? metricsFitness(metricsAfter), 0);
  const version = input.version ?? input.candidateVersion ?? "generation-" + generation;
  const idValue = String(input.id ?? "generation:" + hash(lineageId + ":" + generation + ":" + version));
  return {
    id: idValue,
    lineageId,
    generationId: String(input.generationId ?? idValue),
    generation,
    parentId,
    parentVersion: input.parentVersion ?? input.parent_version ?? previous?.version ?? null,
    parent: input.parent ?? input.parentVersion ?? input.parent_version ?? previous?.version ?? null,
    rootId: input.rootId ?? previous?.rootId ?? idValue,
    version: String(version),
    target: safeValue(target),
    mutation: safeRecord(input.mutation ?? input.change ?? {}),
    metricsBefore,
    metricsAfter,
    beforeMetrics: metricsBefore,
    afterMetrics: metricsAfter,
    decision,
    fitnessScore,
    status: input.status ?? decision,
    experimentId: input.experimentId ?? null,
    cycleId: input.cycleId ?? null,
    strategyId: input.strategyId ?? null,
    recordedAt: input.recordedAt ?? timestamp(clock),
  };
}

/** Durable generation records backed by EvolutionMemory's existing store. */
export class EvolutionLineage {
  #records = [];
  #mutationAuthority = null;

  constructor({ memory = null, stateStore = null, key = "evolutionLineage", clock = () => new Date(), maxEntries = 1000, mutationAuthority = null, transaction = null } = {}) {
    this.memory = memory;
    this.stateStore = stateStore ?? memory?.stateStore ?? null;
    this.transaction = transaction;
    this.key = key;
    this.clock = clock;
    this.maxEntries = Math.max(1, Number(maxEntries) || 1000);
    this.#records = [];
    this.#mutationAuthority = mutationAuthority;
    this.loaded = false;
    this.loading = null;
    this.ready = Promise.resolve(this);
  }

  get records() { return readonlyProjection(this.#records); }

  setMutationAuthority(authority) {
    if (this.#mutationAuthority && authority !== this.#mutationAuthority) {
      const error = new Error("Evolution lineage mutation authority cannot be detached or replaced");
      error.code = "E_MUTATION_AUTHORITY_REQUIRED";
      throw error;
    }
    this.#mutationAuthority = authority ?? null;
    return this;
  }

  #assertMutation(operation) { assertMutation(this.#mutationAuthority, operation); }

  async load() {
    if (this.loaded) return this.snapshot();
    if (this.loading) return this.loading;
    this.loading = (async () => {
      if (this.memory?.load) {
        const value = await this.memory.load();
        this.#records = (value.lineage ?? []).slice(-(this.memory?.hotEntries ?? this.maxEntries)).map(clone);
      } else if (this.stateStore?.load) {
        const state = await this.stateStore.load({ resolveSnapshot: false });
        this.#records = (state[this.key]?.generations ?? []).slice(-this.maxEntries).map(clone);
      }
      this.loaded = true;
      return this.snapshot();
    })();
    try { return await this.loading; } finally { this.loading = null; }
  }

  snapshot() { return { schema: 1, generations: this.#records.map(clone), count: this.#records.length }; }

  refreshProjection(memorySnapshot = null) {
    const source = memorySnapshot?.lineage ?? this.memory?.fullSnapshot?.().lineage ?? this.memory?.snapshot?.().lineage ?? null;
    if (!Array.isArray(source)) return this.snapshot();
    const hotLimit = this.memory?.hotEntries ?? this.maxEntries;
    this.#records = source.slice(-hotLimit).map(clone);
    this.loaded = true;
    return this.snapshot();
  }

  /** Complete lineage projection for the public runtime snapshot boundary. */
  fullSnapshot() {
    const source = this.memory?.fullSnapshot?.().lineage;
    if (Array.isArray(source)) return { schema: 1, generations: source.map(clone), count: source.length };
    return this.snapshot();
  }

  async restore(snapshot = {}, { persist = true } = {}) {
    this.#assertMutation("evolution.lineage.restore");
    const generations = Array.isArray(snapshot?.generations) ? snapshot.generations : Array.isArray(snapshot) ? snapshot : null;
    if (!generations) throw new TypeError("Evolution lineage snapshot is missing generations");
    await this.load();
    if (persist && !this.memory?.restore) requirePort(this.transaction, "persist", "Persistence");
    const hotLimit = this.memory?.hotEntries ?? this.maxEntries;
    this.#records = generations.slice(-hotLimit).map(clone);
    this.loaded = true;
    if (this.memory?.load) {
      await this.memory.load();
      if (this.memory.restore) await this.memory.restore({ ...this.memory.fullSnapshot?.() ?? this.memory.snapshot(), lineage: generations.map(clone) }, { persist });
    } else if (persist) {
      const payload = this.snapshot();
      await this.transaction.persist((state) => ({ ...state, [this.key]: payload }), { includeSnapshot: false, generateSnapshot: false, metadata: { partition: this.key } });
    }
    return this.snapshot();
  }
  list({ lineageId = null, target = null, limit = null, includeArchived = false } = {}) {
    const source = includeArchived && this.memory?.history
      ? this.memory.history("lineage")
      : this.#records;
    let result = source.filter((entry) => (!lineageId || entry.lineageId === lineageId) && (!target || targetKey(entry.target) === targetKey(target)));
    if (limit !== null && Number(limit) > 0) result = result.slice(-Number(limit));
    return result.map(clone);
  }
  generations(options = {}) { return this.list(options); }
  latest(options = {}) {
    const hot = this.list({ ...options, includeArchived: false }).at(-1) ?? null;
    if (hot || options.includeArchived === false || !this.memory?.history) return hot;
    return this.list({ ...options, includeArchived: true }).at(-1) ?? null;
  }
  best(options = {}) {
    const candidates = this.list(options).filter((entry) => !["rollback", "rolled_back", "rejected", "failed", "reverted"].includes(decisionName(entry.decision)));
    return candidates.sort((left, right) => Number(right.fitnessScore) - Number(left.fitnessScore) || Number(right.generation) - Number(left.generation)).at(0) ?? null;
  }
  historicalBest(options = {}) { return this.best({ ...options, includeArchived: true }); }

  async record(input = {}) {
    this.#assertMutation("evolution.lineage.record");
    await this.load();
    if (!this.memory?.recordLineage) requirePort(this.transaction, "persist", "Persistence");
    const previous = input.parentId ? this.#records.find((entry) => entry.id === input.parentId) : this.latest({ lineageId: input.lineageId, target: input.target ?? input.targetComponent });
    const record = normalizeLineageRecord(input, previous, this.clock);
    const existingIndex = this.#records.findIndex((entry) => entry.id === record.id);
    if (existingIndex >= 0) this.#records[existingIndex] = { ...this.#records[existingIndex], ...record };
    else this.#records.push(record);
    this.#records = this.#records.slice(-(this.memory?.hotEntries ?? this.maxEntries));
    let persisted = record;
    if (this.memory?.recordLineage) persisted = await this.memory.recordLineage(record);
    else {
      const payload = this.snapshot();
      await this.transaction.persist((state) => ({ ...state, [this.key]: payload }), { includeSnapshot: false, generateSnapshot: false, metadata: { partition: this.key } });
    }
    const index = this.#records.findIndex((entry) => entry.id === record.id);
    if (index >= 0) this.#records[index] = { ...this.#records[index], ...clone(persisted) };
    return clone(this.#records[index] ?? record);
  }

  recordGeneration(input = {}) { return this.record(input); }
  next(input = {}) { return this.record(input); }

  compare(current, historicalBest = null) {
    const currentRecord = current?.fitnessScore !== undefined ? current : normalizeLineageRecord(current ?? {}, null, this.clock);
    const best = historicalBest ?? this.best({ lineageId: currentRecord.lineageId, target: currentRecord.target });
    if (!best) return { compared: false, current: clone(currentRecord), historicalBest: null, improved: true, regressed: false, decision: "no_historical_best" };
    const improved = Number(currentRecord.fitnessScore) > Number(best.fitnessScore);
    const regressed = Number(currentRecord.fitnessScore) < Number(best.fitnessScore);
    return {
      compared: true,
      currentVersion: currentRecord.version,
      historicalBestVersion: best.version,
      currentFitness: Number(currentRecord.fitnessScore),
      historicalBestFitness: Number(best.fitnessScore),
      improved,
      regressed,
      decision: improved ? "promote" : regressed ? "keep_historical_best" : "hold",
      current: clone(currentRecord),
      historicalBest: clone(best),
    };
  }
}

export const MultiGenerationEvolution = EvolutionLineage;
export const EvolutionLineageStore = EvolutionLineage;
