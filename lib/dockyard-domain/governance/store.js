import { ValidationError } from "../errors.js";
import { MutationAuthorityError } from "./mutation-authority.js";
import { clone, readonlyProjection } from "./helpers.js";

export function emptyGovernancePartition() {
  return { schema: 1, capabilities: [], coreProposals: [], replacements: [], retirements: [] };
}
export function validateGovernancePartition(input) {
  if (!input || input.schema !== 1) throw new ValidationError("Unsupported governance schema");
  const result = emptyGovernancePartition();
  for (const key of ["capabilities", "coreProposals", "replacements", "retirements"]) {
    if (!Array.isArray(input[key])) throw new ValidationError(`Governance collection must be an array: ${key}`);
    result[key] = structuredClone(input[key]);
  }
  const ids = new Set();
  for (const record of result.capabilities) {
    if (!record?.id || ids.has(record.id)) throw new ValidationError("Governance capability id must be unique");
    ids.add(record.id);
  }
  return result;
}

/** Explicit partition adapter. No runtime snapshot, ambient transaction, home discovery or cold-history pruning. */
export class GovernanceStore {
  #data = emptyGovernancePartition();
  #queue = Promise.resolve();
  #loading = null;
  #loaded = false;
  constructor({ stateStore, transaction = null, key = "governance", mutationAuthority } = {}) {
    if (!stateStore || typeof stateStore.load !== "function" || typeof stateStore.update !== "function") throw new ValidationError("Governance requires stateStore.load/update ports");
    if (!mutationAuthority) throw new MutationAuthorityError("governance.store.authority.required");
    if (transaction && typeof transaction.persist !== "function") throw new ValidationError("Governance transaction requires persist port");
    this.stateStore = stateStore;
    this.transaction = transaction;
    this.key = key;
    this.mutationAuthority = mutationAuthority;
  }
  get data() { return readonlyProjection(this.#data, "governance store"); }
  setMutationAuthority(authority) {
    if (authority !== this.mutationAuthority) throw new MutationAuthorityError("governance.store.authority.replace");
    return this;
  }
  async load() {
    if (this.#loaded) return this.snapshot();
    if (this.#loading) return this.#loading;
    this.#loading = (async () => {
      const state = await this.stateStore.load();
      this.#data = state?.[this.key] === undefined ? emptyGovernancePartition() : validateGovernancePartition(state[this.key]);
      this.#loaded = true;
      return this.snapshot();
    })();
    try { return await this.#loading; } finally { this.#loading = null; }
  }
  snapshot() { return clone(this.#data); }
  update(mutator) {
    this.mutationAuthority.assertMutation("governance.store.update");
    const next = this.#queue.then(async () => {
      this.mutationAuthority.assertMutation("governance.store.commit");
      await this.load();
      const draft = this.snapshot();
      const value = await mutator(draft);
      const candidate = validateGovernancePartition(value ?? draft);
      if (JSON.stringify(candidate.coreProposals) !== JSON.stringify(this.#data.coreProposals)) throw new ValidationError("coreProposals are readOnly-history");
      const update = (state) => ({ ...state, [this.key]: clone(candidate) });
      if (this.transaction) await this.transaction.persist(update, { metadata: { partition: this.key } });
      else await this.stateStore.update(update);
      // Failed persistence never advertises an uncommitted in-memory state.
      this.#data = candidate;
      return this.snapshot();
    });
    this.#queue = next.catch(() => {});
    return next;
  }
  async drain() { await this.#queue; }
}
