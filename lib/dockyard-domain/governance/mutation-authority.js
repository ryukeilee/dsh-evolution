import { AsyncLocalStorage } from "node:async_hooks";
import { clone } from "./helpers.js";
class DockyardError extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details; } }
export class MutationAuthorityError extends DockyardError {
  constructor(operation, details = {}) {
    super("E_MUTATION_AUTHORITY_REQUIRED", `Mutation requires the Evolution MutationAuthority: ${operation}`, {
      operation,
      ...details,
    });
    this.name = "MutationAuthorityError";
  }
}

export class MutationAuthority {
  #storage = new AsyncLocalStorage();
  #token = Symbol("dsh-mutation-authority");
  #decisions = [];
  #activeRuns = 0;
  #idleWaiters = new Set();
  #maintenance = null;

  isActive() {
    const context = this.#storage.getStore();
    return context?.token === this.#token && context.active === true;
  }

  isMaintenanceActive() {
    const context = this.#storage.getStore();
    return this.isActive() && context?.maintenance === true;
  }

  assertMutation(operation = "runtime mutation") {
    if (!this.isActive()) throw new MutationAuthorityError(operation);
    return true;
  }

  #record(operation, status = "entered") {
    this.#decisions.push({ operation: String(operation ?? "runtime mutation"), status, at: new Date().toISOString() });
    if (this.#decisions.length > 200) this.#decisions.splice(0, this.#decisions.length - 200);
  }

  async #waitForMaintenance() {
    const maintenance = this.#maintenance;
    if (maintenance && !this.isMaintenanceActive()) await maintenance.done;
  }

  async #waitForIdle() {
    if (this.#activeRuns === 0) return;
    await new Promise((resolve) => this.#idleWaiters.add(resolve));
  }

  #notifyIdle() {
    if (this.#activeRuns !== 0) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }

  async run(operation, perform) {
    if (typeof perform !== "function") throw new TypeError("MutationAuthority.run requires a function");
    // A nested call made by the maintenance transaction already carries the
    // lease. Do not count it as a competing writer or deadlock the drain.
    if (this.isMaintenanceActive()) return perform();
    if (this.#maintenance) {
      await this.#waitForMaintenance();
      return this.run(operation, perform);
    }
    this.#activeRuns += 1;
    const context = { token: this.#token, active: true, operation: String(operation ?? "runtime mutation"), startedAt: Date.now() };
    this.#record(context.operation);
    try {
      return await this.#storage.run(context, perform);
    } finally {
      context.active = false;
      this.#activeRuns -= 1;
      this.#notifyIdle();
    }
  }

  async runMaintenance(operation, perform) {
    if (typeof perform !== "function") throw new TypeError("MutationAuthority.runMaintenance requires a function");
    if (this.isMaintenanceActive()) return perform();
    if (this.isActive()) throw new MutationAuthorityError(String(operation) + ".nested-maintenance");
    while (this.#maintenance) await this.#maintenance.done;
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    const lease = { operation: String(operation ?? "runtime maintenance"), done };
    this.#maintenance = lease;
    this.#record(lease.operation, "maintenance_waiting");
    try {
      await this.#waitForIdle();
      this.#record(lease.operation, "maintenance_entered");
      const context = { token: this.#token, active: true, operation: lease.operation, startedAt: Date.now(), maintenance: true };
      try { return await this.#storage.run(context, perform); }
      finally { context.active = false; }
    } finally {
      if (this.#maintenance === lease) this.#maintenance = null;
      resolveDone();
      this.#notifyIdle();
    }
  }

  inspect() {
    return {
      active: this.isActive(),
      maintenance: this.#maintenance ? { operation: this.#maintenance.operation, active: this.isMaintenanceActive() } : null,
      activeRuns: this.#activeRuns,
      recentMutations: this.#decisions.slice(-20).map(clone),
    };
  }
}

