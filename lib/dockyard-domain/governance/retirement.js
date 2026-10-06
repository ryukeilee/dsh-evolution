import { ValidationError } from "../errors.js";
import { ACTIVE_LIFECYCLE_STATES, CAPABILITY_LIFECYCLE } from "./capability-registry.js";
import { clone, id, timestamp } from "./helpers.js";

/** Source: governance.mjs removalPreconditions. Runtime dependency DTOs must come from HostLifecycle, not a second registry. */
export function removalPreconditions(record, { dependents = [], runtimeDependents = null } = {}) {
  if (!record) throw new ValidationError("Capability is not registered");
  const unmet = [];
  const active = dependents.filter((entry) => ACTIVE_LIFECYCLE_STATES.has(entry.lifecycleState));
  if (active.length) unmet.push({ check: "no_active_dependency", dependents: active.map((entry) => entry.id) });
  if (!Array.isArray(runtimeDependents)) unmet.push({ check: "host_dependency_evidence_required" });
  else if (runtimeDependents.length) unmet.push({ check: "no_active_runtime_dependency", dependents: runtimeDependents });
  if (!(record.versionHistory ?? []).some((entry) => entry.version && entry.version !== record.version)) unmet.push({ check: "version_history_exists" });
  if (!record.archivePath) unmet.push({ check: "rollback_archive_exists" });
  if (!record.replacement && !record.deprecationReason) unmet.push({ check: "replacement_or_deprecation_reason" });
  if (record.lifecycleState !== CAPABILITY_LIFECYCLE.ARCHIVED) unmet.push({ check: "archived_before_remove" });
  return { record: clone(record), unmet, satisfiable: unmet.length === 0 };
}

/** Retirement only. Artifacts are opaque refs; never delete plugin directories or user data. Host owns execution and recovery. */
export class CapabilityRetirementManager {
  constructor({ capabilities, authority, store, hostLifecycle, artifactResolver, clock = () => new Date() } = {}) {
    if (!capabilities || !authority || !store || typeof hostLifecycle?.activeDependents !== "function" || typeof hostLifecycle?.remove !== "function" || typeof artifactResolver?.archive !== "function" || typeof artifactResolver?.verifyArchive !== "function") throw new ValidationError("Retirement requires CapabilityRegistry/Authority/Persistence/HostLifecycle/ArtifactResolver ports");
    Object.assign(this, { capabilities, authority, store, hostLifecycle, artifactResolver, clock });
  }
  async #journal(capabilityId, entry) {
    await this.store.update((data) => ({ ...data, retirements: [...data.retirements, { id: id("retirement"), capabilityId, at: timestamp(this.clock), ...entry }] }));
  }
  async markSuspect(capabilityId, { reason = null } = {}) {
    return this.authority.execute({ kind: "capability.retire-suspect", target: `capability:${capabilityId}` }, async () => {
      const record = await this.capabilities.transition(capabilityId, "suspect", { reason });
      await this.#journal(capabilityId, { stage: "suspect", reason });
      return record;
    });
  }
  async markDeprecated(capabilityId, { reason = null, replacement = null } = {}) {
    return this.authority.execute({ kind: "capability.retire-deprecate", target: `capability:${capabilityId}` }, async () => {
      const record = await this.capabilities.transition(capabilityId, "deprecated", { reason });
      await this.store.update((data) => ({ ...data, capabilities: data.capabilities.map((entry) => entry.id === capabilityId ? { ...entry, deprecationReason: reason, replacement } : entry) }));
      await this.#journal(capabilityId, { stage: "deprecated", reason, replacement });
      return this.capabilities.get(record.id);
    });
  }
  async archive(capabilityId) {
    return this.authority.execute({ kind: "capability.retire-archive", target: `capability:${capabilityId}` }, async () => {
      const record = this.capabilities.get(capabilityId);
      if (record?.lifecycleState !== "deprecated") throw new ValidationError("Archive requires deprecated capability");
      await this.#journal(capabilityId, { stage: "archive_intent" });
      try {
        const archiveRef = await this.artifactResolver.archive(clone(record));
        if (typeof archiveRef !== "string" || !archiveRef || await this.artifactResolver.verifyArchive(archiveRef) !== true) throw new ValidationError("Verified rollback archive required");
        await this.store.update((data) => ({ ...data, capabilities: data.capabilities.map((entry) => entry.id === capabilityId ? { ...entry, archivePath: archiveRef } : entry) }));
        await this.capabilities.transition(capabilityId, "archived", { reason: "retirement_archive" });
        await this.#journal(capabilityId, { stage: "archived", archivePath: archiveRef });
        return this.capabilities.get(capabilityId);
      } catch (error) { await this.#journal(capabilityId, { stage: "archive_failed", error: String(error.message) }); throw error; }
    });
  }
  async remove(capabilityId, { reason = "retirement_remove" } = {}) {
    return this.authority.execute({ kind: "capability.retire-remove", target: `capability:${capabilityId}` }, async () => {
      const record = this.capabilities.get(capabilityId);
      const runtimeDependents = await this.hostLifecycle.activeDependents(clone(record));
      const checks = removalPreconditions(record, { dependents: this.capabilities.dependentsOf(capabilityId), runtimeDependents });
      if (!checks.satisfiable) throw new ValidationError("Capability removal preconditions are not met", checks);
      if (await this.artifactResolver.verifyArchive(record.archivePath) !== true) throw new ValidationError("Rollback archive verification failed");
      await this.#journal(capabilityId, { stage: "remove_intent", archivePath: record.archivePath });
      try {
        const receipt = await this.hostLifecycle.remove({ capabilityId, component: record.component, archiveRef: record.archivePath });
        if (receipt?.removed !== true || receipt?.quiescent !== true) throw new ValidationError("Host removal/quiescence evidence required");
        const removed = await this.capabilities.transition(capabilityId, "removed", { reason });
        await this.#journal(capabilityId, { stage: "removed", archivePreserved: record.archivePath });
        return { removed, archivePath: record.archivePath };
      } catch (error) { await this.#journal(capabilityId, { stage: "remove_failed", error: String(error.message), recoveryRequired: true }); throw error; }
    });
  }
}
