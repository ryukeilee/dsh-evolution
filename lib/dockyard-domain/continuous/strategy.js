/** Declarative strategy memory, resolution, mutation, and mutation trees. */
import { clamp01, clone, finite, hash, safeRecord, safeValue, timestamp } from "./shared.js";
import { decisionName } from "./lineage.js";
import { assertMutation } from "./ports.js";

const SUCCESS_DECISIONS = new Set(["success", "succeeded", "validated", "promote", "promoted", "adopted"]);

function tokenSet(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? {});
  return new Set(String(text).toLowerCase().split(/[^a-z0-9_:-]+/).filter((token) => token.length > 1));
}

function similarity(left, right) {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / Math.max(a.size, b.size);
}

function strategyKey(input) {
  const strategy = typeof input.strategy === "string" ? input.strategy : input.strategy?.name ?? input.name ?? input.change?.type ?? input.change ?? "strategy";
  const context = input.context ?? input.applicableConditions ?? {};
  return String(input.id ?? "strategy:" + hash(String(strategy) + ":" + JSON.stringify(context)));
}

/**
 * Keep the causal chain next to the strategy record.  These are deliberately
 * declarative, redacted values: they explain why a strategy was reused and
 * what happened to its candidate without introducing a learning subsystem.
 */
function causalEvidence(input = {}, previous = {}) {
  const previousCausality = previous?.causality ?? {};
  const choose = (...values) => values.find((value) => (
    value !== undefined
      && value !== null
      && (!(typeof value === "object") || Object.keys(value).length > 0)
  ));
  const strategyInput = safeRecord(
    choose(input.strategyInput, input.selectionInput, input.query, previous.strategyInput, previousCausality.strategyInput) ?? {},
  );
  const candidateChange = safeRecord(
    choose(input.candidateChange, input.mutation, input.change, previous.candidateChange, previousCausality.candidateChange) ?? {},
  );
  const experimentSource = choose(
    input.experimentResult,
    input.result && typeof input.result === "object" ? input.result : null,
    typeof input.result === "string" ? { status: input.result } : null,
    previous.experimentResult,
    previousCausality.experimentResult,
  ) ?? {};
  const experimentResult = safeRecord(experimentSource);
  const futureSelection = safeRecord(
    choose(input.futureSelection, input.selection, previous.futureSelection, previousCausality.futureSelection) ?? {},
  );
  return {
    strategyInput,
    candidateChange,
    experimentResult,
    futureSelection,
  };
}

function withCausalityFields(target, causality) {
  const normalized = {
    strategyInput: clone(causality?.strategyInput ?? {}),
    candidateChange: clone(causality?.candidateChange ?? {}),
    experimentResult: clone(causality?.experimentResult ?? {}),
    futureSelection: clone(causality?.futureSelection ?? {}),
  };
  return {
    ...target,
    causality: clone(normalized),
    strategyInput: clone(normalized.strategyInput),
    candidateChange: clone(normalized.candidateChange),
    experimentResult: clone(normalized.experimentResult),
    futureSelection: clone(normalized.futureSelection),
  };
}

function readonlyProjection(value) {
  const seen = new WeakMap();
  const protect = (entry) => {
    if (!entry || typeof entry !== "object") return entry;
    if (entry instanceof Date) return new Date(entry.getTime());
    if (seen.has(entry)) return seen.get(entry);
    const target = Array.isArray(entry) ? [] : {};
    const projection = new Proxy(target, {
      set() { const error = new Error("E_MUTATION_AUTHORITY_REQUIRED: strategy memory projection is read-only"); error.code = "E_MUTATION_AUTHORITY_REQUIRED"; throw error; },
      defineProperty() { const error = new Error("E_MUTATION_AUTHORITY_REQUIRED: strategy memory projection is read-only"); error.code = "E_MUTATION_AUTHORITY_REQUIRED"; throw error; },
      deleteProperty() { const error = new Error("E_MUTATION_AUTHORITY_REQUIRED: strategy memory projection is read-only"); error.code = "E_MUTATION_AUTHORITY_REQUIRED"; throw error; },
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

/** Aggregates successful and failed outcomes into declarative strategy memory. */
export class EvolutionStrategyMemory {
  #local = [];
  #mutations = [];
  #mutationAuthority = null;

  constructor({ memory = null, stateStore = null, clock = () => new Date(), maxEntries = 1000, minSuccessRate = 0.5, mutationAuthority = null } = {}) {
    this.memory = memory;
    this.stateStore = stateStore ?? memory?.stateStore ?? null;
    this.clock = clock;
    this.maxEntries = Math.max(1, Number(maxEntries) || 1000);
    this.minSuccessRate = clamp01(minSuccessRate, 0.5);
    this.#local = [];
    this.#mutations = [];
    this.#mutationAuthority = mutationAuthority;
    this.ready = Promise.resolve(this);
  }

  get local() { return readonlyProjection(this.#local); }
  get mutations() { return readonlyProjection(this.#mutations); }

  setMutationAuthority(authority) {
    if (this.#mutationAuthority && authority !== this.#mutationAuthority) {
      const error = new Error("Evolution strategy memory mutation authority cannot be detached or replaced");
      error.code = "E_MUTATION_AUTHORITY_REQUIRED";
      throw error;
    }
    this.#mutationAuthority = authority ?? null;
    return this;
  }

  #assertMutation(operation) { assertMutation(this.#mutationAuthority, operation); }

  list({ includeArchived = false } = {}) {
    const values = includeArchived && this.memory?.history
      ? this.memory.history("strategies")
      : this.memory?.snapshot?.().strategies ?? this.#local;
    return values.slice(-this.maxEntries).map(clone);
  }

  async learn(input = {}) {
    this.#assertMutation("evolution.strategy.learn");
    await this.ready;
    await this.memory?.load?.();
    const idValue = strategyKey(input);
    const previous = this.list({ includeArchived: true }).find((entry) => entry.id === idValue || entry.strategyKey === idValue);
    const decision = decisionName(input.decision ?? input.status ?? (input.success === false ? "failure" : "success"));
    const success = input.success === undefined ? SUCCESS_DECISIONS.has(decision) : input.success === true;
    const successCount = Number(previous?.successCount ?? 0) + (success ? 1 : 0);
    const failureCount = Number(previous?.failureCount ?? 0) + (success ? 0 : 1);
    const total = successCount + failureCount;
    const context = safeRecord(input.context ?? input.applicableConditions ?? {});
    const failureConditions = safeRecord(input.failureConditions ?? input.failureCondition ?? (success ? {} : context));
    const causality = causalEvidence(input, previous);
    const record = withCausalityFields({
      ...(previous ?? {}),
      id: idValue,
      strategyKey: idValue,
      strategy: safeValue(input.strategy ?? previous?.strategy ?? input.name ?? input.change ?? "declarative-strategy"),
      context: safeRecord(previous?.context ?? {}),
      applicableConditions: { ...(safeRecord(previous?.applicableConditions ?? {})), ...context },
      failureConditions: { ...(safeRecord(previous?.failureConditions ?? {})), ...failureConditions },
      successCount,
      failureCount,
      successRate: total ? Number((successCount / total).toFixed(6)) : 0,
      status: success || successCount > 0 ? "promoted" : "failed",
      decision: success ? "promote" : decision,
      confidence: clamp01(input.confidence ?? previous?.confidence ?? (success ? 0.7 : 0.3), 0.5),
      outcomeConfidence: clamp01(input.outcomeConfidence ?? input.confidence ?? previous?.outcomeConfidence ?? (success ? 0.7 : 0.3), 0.5),
      metrics: safeRecord(input.metrics ?? previous?.metrics ?? {}),
      sourceExperimentId: input.sourceExperimentId ?? input.experimentId ?? previous?.sourceExperimentId ?? null,
      sourceGenerationId: input.sourceGenerationId ?? input.generationId ?? previous?.sourceGenerationId ?? null,
      recordedAt: input.recordedAt ?? timestamp(this.clock),
      evidence: safeRecord(input.evidence ?? {}),
    }, causality);
    if (this.memory?.recordStrategy) await this.memory.recordStrategy(record);
    else {
      const index = this.#local.findIndex((entry) => entry.id === idValue);
      if (index >= 0) this.#local[index] = { ...this.#local[index], ...record }; else this.#local.push(record);
      this.#local = this.#local.slice(-this.maxEntries);
    }
    return clone(record);
  }

  recordSuccess(input = {}) { return this.learn({ ...input, success: true, decision: "promote" }); }
  recordFailure(input = {}) { return this.learn({ ...input, success: false, decision: input.decision ?? "failure" }); }

  listMutations({ includeArchived = false } = {}) {
    const values = includeArchived && this.memory?.history
      ? this.memory.history("strategyMutations")
      : this.memory?.snapshot?.().strategyMutations ?? this.#mutations;
    return values.slice(-this.maxEntries).map(clone);
  }

  async recordMutation(input = {}) {
    this.#assertMutation("evolution.strategy.mutation");
    await this.ready;
    await this.memory?.load?.();
    const causality = causalEvidence(input);
    const value = withCausalityFields({
      id: input.id ?? "strategy-mutation:" + hash(JSON.stringify(input.parentStrategy ?? input.parent ?? {})) + ":" + String(this.listMutations({ includeArchived: true }).length + 1),
      parentStrategyId: input.parentStrategyId ?? input.parentId ?? null,
      parentStrategy: safeRecord(input.parentStrategy ?? input.parent ?? {}),
      mutation: safeRecord(input.mutation ?? {}),
      candidateStrategy: safeRecord(input.candidateStrategy ?? input.candidate ?? {}),
      result: input.result ?? "candidate_generated",
      decision: input.decision ?? null,
      experimentId: input.experimentId ?? null,
      generationId: input.generationId ?? null,
      metrics: safeRecord(input.metrics ?? {}),
      fitness: finite(input.fitness),
      recordedAt: input.recordedAt ?? timestamp(this.clock),
    }, causality);
    if (this.memory?.recordStrategyMutation) {
      await this.memory.recordStrategyMutation(value);
    } else {
      const index = this.#mutations.findIndex((entry) => entry.id === value.id);
      if (index >= 0) this.#mutations[index] = { ...this.#mutations[index], ...value }; else this.#mutations.push(value);
      this.#mutations = this.#mutations.slice(-this.maxEntries);
    }
    return clone(value);
  }

  rank(query = {}, { limit = 5, minSuccessRate = this.minSuccessRate } = {}) {
    const queryText = { problem: query.problem ?? query.message ?? "", context: query.context ?? query.applicableConditions ?? {}, target: query.target ?? query.suggested_area ?? query.suggestedArea ?? "" };
    return this.list({ includeArchived: true }).map((entry) => {
      const successRate = finite(entry.successRate) ?? (entry.status === "promoted" ? 1 : 0);
      const applicableScore = similarity(queryText, entry.applicableConditions ?? entry.context ?? {});
      const problemScore = similarity(queryText.problem, entry.problem ?? entry.strategy ?? "");
      const score = Math.max(applicableScore, problemScore);
      const failureScore = similarity(queryText, entry.failureConditions ?? {});
      return { entry, successRate, score, failureScore, ranking: score * 0.55 + successRate * 0.35 + clamp01(entry.confidence, 0.5) * 0.1 };
    }).filter((value) => value.successRate >= Number(minSuccessRate) && value.score > 0 && value.failureScore < 0.8)
      .sort((left, right) => right.ranking - left.ranking)
      .slice(0, Math.max(1, Number(limit) || 5))
      .map((value) => ({ ranking: Number(value.ranking.toFixed(6)), similarity: Number(value.score.toFixed(6)), confidence: clamp01(value.entry.confidence, 0.5), strategy: clone(value.entry), evidence: { successRate: value.successRate, failureConditions: clone(value.entry.failureConditions ?? {}) } }));
  }

  resolve(query = {}, options = {}) { return this.rank(query, options).at(0)?.strategy ?? null; }
  findSimilar(query = {}, options = {}) { return this.rank(query, options); }
  refreshProjection(memorySnapshot = null) {
    const source = memorySnapshot ?? this.memory?.fullSnapshot?.() ?? this.memory?.snapshot?.() ?? {};
    if (!this.memory) {
      this.#local = (source.strategies ?? []).slice(-this.maxEntries).map(clone);
      this.#mutations = (source.strategyMutations ?? source.mutations ?? []).slice(-this.maxEntries).map(clone);
    }
    return this.snapshot();
  }

  snapshot() { return { strategies: this.list(), mutations: this.listMutations(), count: this.list().length, mutationCount: this.listMutations().length }; }

  /** Complete declarative strategy projection for the public runtime snapshot. */
  fullSnapshot() {
    const source = this.memory?.fullSnapshot?.();
    if (source) {
      const strategies = Array.isArray(source.strategies) ? source.strategies.map(clone) : [];
      const mutations = Array.isArray(source.strategyMutations) ? source.strategyMutations.map(clone) : [];
      return { strategies, mutations, count: strategies.length, mutationCount: mutations.length };
    }
    return this.snapshot();
  }

  async restore(snapshot = {}, { persist = true } = {}) {
    this.#assertMutation("evolution.strategy.restore");
    if (!snapshot || typeof snapshot !== "object") throw new TypeError("Evolution strategy snapshot is required");
    await this.ready;
    await this.memory?.load?.();
    const strategies = Array.isArray(snapshot.strategies) ? snapshot.strategies : [];
    const mutations = Array.isArray(snapshot.mutations) ? snapshot.mutations : [];
    if (this.memory?.load) {
      await this.memory.load();
      if (this.memory.restore) await this.memory.restore({ ...this.memory.fullSnapshot?.() ?? this.memory.snapshot(), strategies: strategies.map(clone), strategyMutations: mutations.map(clone) }, { persist });
    } else {
      this.#local = strategies.slice(-this.maxEntries).map(clone);
      this.#mutations = mutations.slice(-this.maxEntries).map(clone);
    }
    return this.snapshot();
  }
}

export class EvolutionStrategyResolver {
  constructor({ memory = null, strategyMemory = null, strategies = {}, minSuccessRate = 0.5, mutator = null, clock = () => new Date(), mutationAuthority = null } = {}) {
    this.memory = strategyMemory ?? (memory ? new EvolutionStrategyMemory({ memory, minSuccessRate, mutationAuthority }) : null);
    this.strategies = strategies;
    this.mutator = mutator ?? new EvolutionStrategyMutator({ strategyMemory: this.memory, clock, mutationAuthority });
  }
  async resolve(query = {}, context = {}) {
    const input = { ...query, context: { ...(query.context ?? {}), ...(context ?? {}) } };
    if (this.memory) {
      const resolved = this.memory.resolve(input);
      if (!resolved) return null;
      // Preserve the selected memory record while making the resolver input
      // explicit evidence for the next mutation/result record.
      const causality = causalEvidence({
        strategyInput: input,
        futureSelection: {
          source: "evolution-memory",
          strategyId: resolved.id ?? resolved.strategyKey ?? null,
        },
      }, resolved);
      return withCausalityFields(clone(resolved), causality);
    }
    const keys = [query.strategyKey, query.patternKey, query.type, query.domain, "default"].filter(Boolean);
    for (const key of keys) {
      const value = this.strategies instanceof Map ? this.strategies.get(key) : this.strategies[key];
      if (value) return typeof value === "function" ? value(query, context) : clone(value);
    }
    return null;
  }
  rank(query = {}, options = {}) { return this.memory?.rank(query, options) ?? []; }
  find(query = {}, options = {}) { return this.rank(query, options); }
  async mutate(query = {}, parent = null, options = {}) {
    const resolved = parent ?? await this.resolve(query, options.context ?? {});
    return this.mutator.mutate({
      ...query,
      parentStrategy: resolved ?? query.parentStrategy ?? query.seedStrategy ?? null,
      strategyInput: options.strategyInput ?? query,
      futureSelection: options.futureSelection ?? {
        source: resolved ? "evolution-memory" : "input",
        strategyId: resolved?.id ?? resolved?.strategyKey ?? null,
      },
      ...options,
    });
  }
  mutationTree() { return this.mutator.tree(); }
}

/**
 * Generates declarative strategy candidates. Mutation is data-only: actual
 * experiments still run through the existing EvolutionEngine/Cycle seams.
 */
export class EvolutionStrategyMutator {
  constructor({ strategyMemory = null, memory = null, clock = () => new Date(), maxEntries = 1000, mutationAuthority = null } = {}) {
    this.strategyMemory = strategyMemory;
    this.mutationAuthority = mutationAuthority;
    this.memory = memory;
    this.clock = clock;
    this.maxEntries = Math.max(1, Number(maxEntries) || 1000);
    this.local = [];
  }

  async mutate({ parentStrategy = null, parent = null, mutation = {}, target = null, generation = null, generationId = null, experimentId = null, strategyInput = {}, futureSelection = {} } = {}) {
    const source = parentStrategy ?? parent ?? { strategy: "seed-strategy", context: {} };
    const parentRecord = safeRecord(source);
    const parentId = String(parentRecord.id ?? parentRecord.strategyKey ?? parentRecord.strategy ?? "seed-strategy");
    const mutationRecord = {
      ...safeRecord(mutation),
      type: mutation.type ?? "parameter-exploration",
      dimension: mutation.dimension ?? mutation.parameter ?? target?.suggested_area ?? target?.suggestedArea ?? "runtime",
      step: finite(mutation.step) ?? 1,
      generation: generation === null ? null : Number(generation),
    };
    const mutationId = "mutation:" + hash(parentId + ":" + JSON.stringify(mutationRecord) + ":" + String(generation ?? "next"));
    const causality = causalEvidence({
      strategyInput,
      candidateChange: mutationRecord,
      futureSelection,
    }, parentRecord);
    const candidate = withCausalityFields({
      ...parentRecord,
      id: String(parentRecord.id ?? "strategy") + "::" + mutationId,
      parentStrategyId: parentId,
      parentId,
      strategyKey: String(parentRecord.strategyKey ?? parentRecord.id ?? parentId) + "::" + mutationId,
      status: "candidate",
      result: "candidate_generated",
      mutation: mutationRecord,
      target: target?.problem ?? target?.metric ?? target?.suggested_area ?? target?.suggestedArea ?? null,
      generatedAt: timestamp(this.clock),
    }, causality);
    const node = withCausalityFields({
      id: mutationId,
      parentStrategyId: parentId,
      parentStrategy: parentRecord,
      mutation: mutationRecord,
      candidateStrategy: candidate,
      result: "candidate_generated",
      decision: null,
      experimentId,
      generationId,
      metrics: {},
      fitness: null,
      recordedAt: timestamp(this.clock),
    }, causality);
    if (this.strategyMemory?.recordMutation) await this.strategyMemory.recordMutation(node);
    else if (this.memory?.recordStrategyMutation) await this.memory.recordStrategyMutation(node);
    else { assertMutation(this.mutationAuthority, "evolution.strategy.mutator"); this.local.push(node); }
    this.local = this.local.slice(-this.maxEntries);
    return { ...clone(candidate), mutationId, parentStrategyId: parentId, node: clone(node) };
  }

  async recordResult(candidateOrNode, { result = "experiment", decision = null, experimentId = null, generationId = null, metrics = {}, fitness = null, strategyInput = undefined, candidateChange = undefined, futureSelection = undefined, experimentResult = undefined } = {}) {
    const node = candidateOrNode?.node ?? candidateOrNode ?? {};
    const update = {
      ...node,
      result,
      decision,
      experimentId: experimentId ?? node.experimentId ?? null,
      generationId: generationId ?? node.generationId ?? null,
      metrics: safeRecord(metrics),
      fitness: finite(fitness),
      strategyInput: strategyInput ?? node.strategyInput,
      candidateChange: candidateChange ?? node.candidateChange ?? node.mutation,
      experimentResult: experimentResult ?? {
        status: result,
        decision,
        experimentId: experimentId ?? node.experimentId ?? null,
        metrics: safeRecord(metrics),
        fitness: finite(fitness),
      },
      futureSelection: futureSelection ?? node.futureSelection,
    };
    const normalizedUpdate = withCausalityFields(update, causalEvidence(update, node));
    if (this.strategyMemory?.recordMutation) return this.strategyMemory.recordMutation(normalizedUpdate);
    if (this.memory?.recordStrategyMutation) return this.memory.recordStrategyMutation(normalizedUpdate);
    assertMutation(this.mutationAuthority, "evolution.strategy.mutator.result");
    const index = this.local.findIndex((entry) => entry.id === normalizedUpdate.id);
    if (index >= 0) this.local[index] = { ...this.local[index], ...normalizedUpdate };
    return clone(normalizedUpdate);
  }

  tree() {
    const fromMemory = this.strategyMemory?.listMutations?.() ?? this.memory?.snapshot?.().strategyMutations ?? [];
    return [...fromMemory, ...this.local.filter((entry) => !fromMemory.some((value) => value.id === entry.id))].slice(-this.maxEntries).map(clone);
  }
}

export const StrategyMutation = EvolutionStrategyMutator;
export const StrategyEvolutionTree = EvolutionStrategyMutator;
export const StrategyResolver = EvolutionStrategyResolver;
