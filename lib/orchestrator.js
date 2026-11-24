import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { types } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { constants as bufferConstants } from "node:buffer";
import { inspectLegacyStartupDrift } from "./compat/legacy-startup-drift.js";
import { syncFile } from "./archive-stage.js";
import { normalizeCanaryVerification } from "./canary-verification.js";

// The journal and evidence snapshot need only the binding identity. The full
// descriptor (which can contain bounded file lines) stays in the Desktop task
// state, where it is needed to replay the read-only check after a restart.
function publicCanaryObligation(verification) {
  if (!verification) return null;
  const { kind, tool, bindingDigest, requiredObservations } = verification;
  return { kind, tool, bindingDigest, requiredObservations };
}
import { fiberIsActive, serviceImpl, serviceImplSource } from "./cordis-compat.js";
import { collectFailureMemoryExperience, failureMemoryExperienceRecord, finalizeExperienceRecall } from "./experience-recall.js";
import { EXPERIENCE_PLAN_LIMITS, planEvolutionCandidates, strategyFingerprint } from "./experience-plan.js";
import { captureReviewHost, composeSelfEvolutionReview, readPublishedPluginReview } from "./self-evolution-review.js";
import { readUsageProjection } from "./capability-usage.js";
import { measuredMetricBenefit } from "./dockyard-domain/evaluator.js";
import {
  buildSharedRecord,
  captureHostFacts,
  normalizePublication,
  probeSharedCapabilities,
  publishSharedRecord,
  reconcileSharedIndex,
  SHARED_CONSUMER_PROFILES,
  SHARED_PROFILES,
} from "./promoted-sharing.js";
import { detectRuntimeVersions } from "./runtime-versions.js";
import { PTC_WRAPPED_VALUE, ptcDirectCallRefusal, ptcWrappedEnvelope } from "./ptc-transport.js";
import { withVerificationCall } from "./verification-call.js";
import {
  ERROR_SUMMARY_MAX,
  ERROR_TEXT_KEY,
  failureCategory,
  isCredentialKeyName,
  redactCredentialShapes,
  redactJsonParseMessage,
  safeErrorDto,
  safeString,
  sha256,
} from "./error-boundary.js";

export { redactJsonParseMessage, safeErrorDto };
export { toolFailurePatternDigest } from "./error-boundary.js";
export { detectRuntimeVersions };

// The append lock writes its owner token with the writer that existed when this
// module loaded: a test (or a host) that replaces `fs.writeSync` to inject a
// short data write must not be able to stall the lock's own bookkeeping.
const rawWriteSync = fs.writeSync;
const EVENT_BRIDGE_SCAN_CHUNK_BYTES = 1024 * 1024;
const EMPTY_SEGMENT = Buffer.alloc(0);

const FIBER_STATES = ["pending", "loading", "active", "failed", "disposed", "unloading"];
const NEUTRAL_CHANGES = new Set(["unchanged", "none", "no change", "无变化", "无明显变化"]);
const EXECUTION_EVENT_TYPES = new Set([
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

function now() {
  return new Date().toISOString();
}

// Only escaped property names are memoized, never payloads or authentication
// results. Bound both key count and length for untrusted bridge input.
const bridgeJsonKeys = new Map();
function bridgeJsonKey(key) {
  const cached = bridgeJsonKeys.get(key);
  if (cached !== undefined) return cached;
  const encoded = JSON.stringify(key);
  if (key.length <= 64 && bridgeJsonKeys.size < 128) bridgeJsonKeys.set(key, encoded);
  return encoded;
}

function canonicalBridgeJson(value) {
  // Preserve the signed byte format (including lexical key order), without
  // allocating a mapped array and joined string for every nested container.
  if (Array.isArray(value)) {
    let output = "[";
    const length = value.length;
    for (let i = 0; i < length; i++) {
      if (i) output += ",";
      if (i in value) output += canonicalBridgeJson(value[i]) ?? "";
    }
    return output + "]";
  }
  if (value && typeof value === "object") {
    let output = "{";
    const keys = Object.keys(value).sort();
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (i) output += ",";
      output += `${bridgeJsonKey(key)}:${canonicalBridgeJson(value[key])}`;
    }
    return output + "}";
  }
  return JSON.stringify(value);
}

/** Sign an append-only bridge payload. The key is injected by the runtime or
 * environment and is never stored in the bridge itself. */
export function signEventBridgeEnvelope(event, { key, writer = EVENT_BRIDGE_DEFAULT_WRITER, sequence } = {}) {
  if (!event || typeof event !== "object" || !key || !writer || !Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("invalid event bridge authentication input");
  }
  const payload = { schema: 2, writer, sequence, event };
  const mac = crypto.createHmac("sha256", String(key)).update(canonicalBridgeJson(payload)).digest("hex");
  return { ...payload, mac };
}

export function verifyEventBridgeEnvelope(envelope, key) {
  if (!envelope || envelope.schema !== 2 || typeof envelope.writer !== "string" || !Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1 || !isObject(envelope.event) || typeof envelope.mac !== "string") return null;
  if (typeof key !== "string" || key.length < 16) return null;
  const payload = { schema: 2, writer: envelope.writer, sequence: envelope.sequence, event: envelope.event };
  const expected = crypto.createHmac("sha256", key).update(canonicalBridgeJson(payload)).digest();
  let actual;
  try { actual = Buffer.from(envelope.mac, "hex"); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  return { event: envelope.event, writer: envelope.writer, sequence: envelope.sequence };
}

/** The writer identity the runtime binds the event bridge and its replay checkpoint to. */
export const EVENT_BRIDGE_DEFAULT_WRITER = "dsh-evolution-orchestrator";
/** The code of the one append-lock outcome a caller may retry: a live writer
 *  holds the lock. Every other failure of a rewrite keeps its own identity, so a
 *  permanent refusal is never reported as a transient one. */
export const EVENT_BRIDGE_APPEND_LOCK_BUSY = "E_EVENT_BRIDGE_APPEND_LOCK_BUSY";

/** A bridge record is replayable only when its MAC verifies and it names the trusted writer. */
export function eventBridgeWriterTrusted(verified, writer) {
  return Boolean(verified) && verified.writer === writer;
}

function text(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function optionalText(value, field) {
  if (value === undefined || value === null) return undefined;
  return text(value, field);
}

/**
 * Free text a durable observation keeps as evidence. `optionalText` still owns
 * the validation (non-empty, trimmed); the value then crosses the credential
 * boundary where it is *captured*, because the same string is read by the
 * archive renderer, the evidence sidecar and the event bridge, and none of those
 * three is the right place to be the only one doing it. The projection is
 * `EVIDENCE_PROJECTION` (the credential rule with the row bounds lifted), so a
 * credential-free field is stored byte for byte as before.
 */
function evidenceText(value, field) {
  const trimmed = optionalText(value, field);
  return trimmed === undefined ? undefined : compactValue(trimmed, EVIDENCE_PROJECTION);
}

/** The same projection for an observation field whose default is a literal. */
function evidenceValue(value, fallback) {
  return value === undefined ? fallback : compactValue(value, EVIDENCE_PROJECTION);
}

/**
 * The same boundary for a list of short evidence strings, applied per element:
 * the list is kept as a list (same length, same order), each element is claimed
 * as its own value. `stringList` alone is not this boundary — it validates and
 * trims, and that was enough for `sideEffects` and `orphanResources` to be stored
 * raw, which put `sideEffects: ["password=<secret>"]` into `exp-*.md`, the
 * evidence sidecar, the promotion journal and the event bridge, and put
 * `orphanResources` into the rollback path unchanged. The bounds are
 * `compactValue`'s row defaults (1200 characters), the same bounds `metrics`
 * keeps in this record: a measurement row is a bounded telemetry row, so a
 * credential-free entry shorter than that is stored byte for byte as before.
 */
function evidenceList(values) {
  return values.map((item) => compactValue(item));
}

function stringList(value, field, { required = true } = {}) {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.length === 0 && required) throw new Error(`${field} must be a non-empty string array`);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`${field} must contain only non-empty strings`);
  }
  return value.map((item) => item.trim());
}

function scopeList(value) {
  if (typeof value === "string") return [text(value, "impactScope")];
  return stringList(value, "impactScope");
}

/**
 * Explicit cross-entry deployment approval for one promotion.
 *
 * `confirmation: true` proves the owner approves the production promotion; it
 * must never be read as approval to deploy the same plugin into every profile.
 * The target list therefore defaults to an empty list (Desktop-only, the
 * historical behaviour) and every value is validated against the profiles that
 * can consume a published plugin. `desktop` is accepted for symmetry but is
 * implicit: the Desktop kernel always mounts its own promoted composition.
 */
export function normalizeShareTargets(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("targetProfiles must be an array of desktop, acp, or web");
  const targets = [];
  for (const raw of value) {
    if (typeof raw !== "string") throw new Error("targetProfiles must contain only strings");
    const profile = raw.trim().toLowerCase();
    if (!SHARED_PROFILES.includes(profile)) throw new Error(`targetProfiles contains an unknown profile: ${profile || "(empty)"}`);
    if (profile === "desktop") continue;
    if (!SHARED_CONSUMER_PROFILES.includes(profile)) throw new Error(`targetProfiles cannot deploy to ${profile}`);
    if (!targets.includes(profile)) targets.push(profile);
  }
  return targets;
}

/**
 * The benefit model a proposal commits to. `workflow` means the experiment
 * claims to fix an observed workflow failure and must therefore prove a
 * workflow before/after; `capability` means it adds a capability and makes no
 * workflow claim. Absent means the historical contract (no extra gate).
 */
export function normalizeBenefitModel(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = value.kind === "workflow" ? "workflow" : value.kind === "capability" ? "capability" : null;
  if (!kind) return null;
  const metric = typeof value.metric === "string" && value.metric.trim()
    ? value.metric.trim().slice(0, 80) : null;
  return { kind, ...(metric ? { metric } : {}) };
}

function ownerOf(exec) {
  const agent = exec?.agent;
  if (!agent || typeof agent.id !== "string" || agent.id.length === 0) {
    throw new Error("Evolution tools require an Agent-backed session");
  }
  return agent;
}

function ownerId(exec) {
  return ownerOf(exec).id;
}

function safeState(fiber) {
  const value = fiber?.state;
  return typeof value === "number" ? FIBER_STATES[value] ?? `state-${value}` : safeString(value || "unknown");
}

function safeEffectDetails(fiber) {
  if (!fiber || typeof fiber.getEffects !== "function") {
    return { known: false, values: [{ label: "unknown", disposer: "unknown" }] };
  }
  try {
    const values = fiber.getEffects().map((effect) => ({
      label: typeof effect?.label === "string" ? effect.label : "unknown",
      // Cordis exposes effect metadata, not the disposer function itself.  The
      // marker is deliberately factual: it proves a registered effect exists;
      // callers must not infer a disposer body from it.
      disposer: effect ? "registered" : "unknown",
      children: Array.isArray(effect?.children) ? effect.children.map((child) => child?.label || "unknown") : [],
    }));
    return { known: true, values };
  } catch {
    return { known: false, values: [{ label: "unknown", disposer: "unknown" }] };
  }
}

function fiberView(fiber, runtimeName) {
  const effectInfo = safeEffectDetails(fiber);
  return {
    name: runtimeName || fiber?.name || "anonymous",
    uid: fiber?.uid ?? null,
    state: safeState(fiber),
    inject: Object.keys(fiber?.inject || {}).sort(),
    effects: effectInfo.values.map((effect) => effect.label),
    effectDetails: effectInfo.values,
    ownership: fiber ? { fiber: fiber.name || "anonymous", uid: fiber.uid ?? null } : "unknown",
  };
}

function stableOwner(fiber) {
  if (!fiber) return undefined;
  return {
    name: fiber.name || "anonymous",
    uid: fiber.uid ?? null,
    state: safeState(fiber),
  };
}

function jsonTools(ctx, agent) {
  try {
    if (typeof ctx.tools?.schemas !== "function") return null;
    return ctx.tools.schemas(agent).map((schema) => ({
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters,
    }));
  } catch (error) {
    return null;
  }
}

function inspectComponents(ctx) {
  if (typeof ctx.registry?.values !== "function") return null;
  const components = [];
  let runtimes;
  try {
    runtimes = [...ctx.registry.values()];
    for (const runtime of runtimes) {
      const fibers = runtime?.fibers ? [...runtime.fibers] : [];
      for (const fiber of fibers) components.push(fiberView(fiber, runtime.name || fiber?.name));
    }
  } catch {
    return null;
  }
  return components.sort((left, right) => `${left.name}:${left.uid}`.localeCompare(`${right.name}:${right.uid}`));
}

/**
 * Read the bound service inventory.
 *
 * `serviceImpl()` resolves the implementation through the documented public
 * surfaces (`ctx.reflect.store` + `Context.isolate`) and only falls back to the
 * private `ctx.reflect._getImpl()` when those are absent; `fiberIsActive()`
 * decides ACTIVE from documented lifecycle fields instead of the
 * `FiberState.ACTIVE` numeric literal. Both live in `lib/cordis-compat.js`,
 * which the doctor also reads, so the report cannot drift from the real reads.
 */
function inspectServices(ctx) {
  try {
    const props = ctx.reflect?.props;
    if (!props || serviceImplSource(ctx) === "unavailable") return null;
    return Object.keys(props).filter((name) => props[name]?.type === "service").sort().flatMap((name) => {
      const impl = serviceImpl(ctx, name, { throwOnError: true });
      // Declaration metadata is global, but implementations are scope-local.
      // An unbound declaration is NOT an active service with an unknown owner.
      // Keep fail-closed unknown ownership for every actual bound implementation.
      if (!impl) return [];
      const ownerFiber = impl.fiber ?? impl.ctx?.fiber;
      return [{
        name,
        active: fiberIsActive(ownerFiber),
        owner: stableOwner(ownerFiber) || "unknown",
      }];
    });
  } catch {
    // An unreadable inventory is not an empty inventory. Recovery must remain
    // fail-closed even when the same lookup fails before and after a trial.
    return null;
  }
}

function inspectEvents(ctx) {
  if (!ctx.events?._hooks) return null;
  const hooks = ctx.events?._hooks || {};
  return Object.keys(hooks).filter((name) => Array.isArray(hooks[name]) && hooks[name].length > 0).sort().map((name) => ({
    name,
    listeners: Array.isArray(hooks[name]) ? hooks[name].map((hook) => ({
      callback: hook.callback?.name || "anonymous",
      owner: stableOwner(hook.ctx?.fiber) || "unknown",
    })) : [],
  }));
}

function inspectDynamicPlugins(runner, agent) {
  if (!runner || typeof runner.snapshot !== "function") return null;
  let rows = [];
  try {
    rows = runner.snapshot(agent) || [];
  } catch {
    return null;
  }
  return rows.map((row) => ({
    pluginId: safeString(row.pluginId),
    currentPackageId: row.currentPackageId === undefined ? undefined : safeString(row.currentPackageId),
    nextPackageId: row.nextPackageId === undefined ? undefined : safeString(row.nextPackageId),
    packages: (row.packages || []).map((pkg) => ({
      packageId: safeString(pkg.packageId),
      name: pkg.name,
      purpose: pkg.purpose,
      hasHostHalf: pkg.hasHostHalf === true,
      hasClientHalf: pkg.hasClientHalf === true,
    })),
    activeRun: row.activeRun ? {
      pluginRunId: safeString(row.activeRun.pluginRunId),
      packageId: safeString(row.activeRun.packageId),
      handlers: [...(row.activeRun.handlers || [])],
      fiber: fiberView(row.activeRun.fiber, `dynamic:${safeString(row.pluginId)}`),
    } : undefined,
    latestRun: row.latestRun ? {
      pluginRunId: safeString(row.latestRun.pluginRunId),
      packageId: safeString(row.latestRun.packageId),
      status: row.latestRun.status,
      error: row.latestRun.error,
    } : undefined,
  })).sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}

function inspectProviders(ctx) {
  try {
    const registry = ctx.get?.("cordisInspect");
    if (!registry || typeof registry.list !== "function") return null;
    return registry.list().map((provider) => ({
      platform: provider.platform,
      id: provider.id,
      description: provider.description,
      methods: (provider.methods || []).map((method) => method.name),
    }));
  } catch {
    return null;
  }
}

/**
 * Read facts from the actual Cordis context. This intentionally derives every
 * list from Cordis registries and scoped services; it is not a second runtime
 * inventory maintained by Evolution.
 */
export function inspectRuntime(ctx, agent, runner = ctx.dynamicCordisRunner) {
  const componentsResult = inspectComponents(ctx);
  const components = componentsResult || [];
  const servicesResult = inspectServices(agent?.ctx || ctx);
  const eventsResult = inspectEvents(ctx);
  const toolsResult = jsonTools(ctx, agent);
  const dynamicPluginsResult = inspectDynamicPlugins(runner, agent);
  const services = servicesResult || [];
  const events = eventsResult || [];
  const tools = toolsResult || [];
  const dynamicPlugins = dynamicPluginsResult || [];
  const providersResult = inspectProviders(ctx);
  const providers = providersResult || [];
  const unknown = [];
  if (componentsResult === null) unknown.push("module-registry");
  if (servicesResult === null) unknown.push("service-registry");
  if (eventsResult === null) unknown.push("event-listeners");
  if (toolsResult === null) unknown.push("tool-registry");
  if (dynamicPluginsResult === null) unknown.push("dynamic-plugin-registry");
  if (providersResult === null) unknown.push("inspect-provider-registry");
  for (const component of components) {
    if (component.effectDetails?.some((effect) => effect.disposer === "unknown")) unknown.push(`effect-disposer:${component.name}:${component.uid ?? "unknown"}`);
  }
  for (const service of services) {
    if (service.owner === "unknown") unknown.push(`service-owner:${service.name}`);
  }
  for (const event of events) {
    for (const listener of event.listeners) {
      if (listener.owner === "unknown") unknown.push(`event-owner:${event.name}:${listener.callback}`);
    }
  }
  const recoveryProof = {
    modules: components.map((component) => ({ name: component.name, uid: component.uid, owner: component.ownership, state: component.state })),
    services: services.map((service) => ({ name: service.name, active: service.active, owner: service.owner })),
    tools: tools.map((tool) => ({ name: tool.name, owner: "unknown" })),
    eventListeners: events.flatMap((event) => event.listeners.map((listener) => ({ event: event.name, callback: listener.callback, owner: listener.owner }))),
    effects: components.flatMap((component) => (component.effectDetails || []).map((effect) => ({ component: component.name, uid: component.uid, ...effect }))),
    dynamicPlugins: dynamicPlugins.map((plugin) => ({ pluginId: plugin.pluginId, owner: agent?.id || "unknown", activeRun: plugin.activeRun?.pluginRunId || null })),
    unknown: [...new Set(unknown)].sort(),
  };
  const capabilities = {
    services: services.filter((service) => service.active).map((service) => service.name),
    tools: tools.map((tool) => tool.name),
    dynamicPlugins: dynamicPlugins.map((plugin) => plugin.pluginId),
    inspectProviders: providers.map((provider) => provider.id),
  };
  return {
    runtime: "cordis",
    components,
    services,
    tools,
    capabilities,
    dependencies: components.map((component) => ({
      component: component.name,
      uid: component.uid,
      requires: component.inject,
    })),
    events,
    inspectProviders: providers,
    dynamicPlugins,
    recoveryProof,
  };
}

const RECOVERY_UNAVAILABLE = new Set([
  "module-registry",
  "service-registry",
  "event-listeners",
  "tool-registry",
  "dynamic-plugin-registry",
  "inspect-provider-registry",
  "recovery-proof-unavailable",
]);

// Reuse keys only for inert JSON trees. Preserve the original comparator for
// exotic values, including observable getters/toJSON and exception behavior.
function inertSignatureValue(value, ancestors = new Set()) {
  if (value === null || typeof value !== "object") {
    return value === null || typeof value === "undefined" || typeof value === "string"
      || typeof value === "boolean" || typeof value === "number";
  }
  if (types.isProxy(value) || ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) return false;
  if ("toJSON" in value) return false;
  const keys = Object.keys(value);
  const array = Array.isArray(value);
  if (array && keys.length !== value.length) return false;
  ancestors.add(value);
  try {
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index];
      if ((array && key !== String(index)) || Object.prototype.__lookupGetter__.call(value, key)
        || !inertSignatureValue(value[key], ancestors)) return false;
    }
    return true;
  } finally { ancestors.delete(value); }
}

function sortSignatureRows(rows) {
  if (rows.length < 2) return rows;
  // Small registries cost less to sort directly than to validate/decorate.
  if (rows.length <= 32 || !rows.every(row => inertSignatureValue(row))) {
    return rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  return rows.map(value => ({ value, key: JSON.stringify(value) }))
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(row => row.value);
}

function stableDynamicPlugin(plugin = {}) {
  const packages = sortSignatureRows((plugin.packages || []).map((pkg) => ({
    name: pkg.name ?? null,
    purpose: pkg.purpose ?? null,
    hasHostHalf: pkg.hasHostHalf === true,
    hasClientHalf: pkg.hasClientHalf === true,
  })));
  const packageById = new Map((plugin.packages || []).map((pkg) => [String(pkg.packageId), pkg]));
  const packageRef = (packageId) => {
    if (packageId === undefined || packageId === null) return null;
    const pkg = packageById.get(String(packageId));
    return pkg ? {
      name: pkg.name ?? null,
      purpose: pkg.purpose ?? null,
      hasHostHalf: pkg.hasHostHalf === true,
      hasClientHalf: pkg.hasClientHalf === true,
    } : { declared: true };
  };
  return {
    pluginId: plugin.pluginId ?? null,
    packages,
    currentPackage: packageRef(plugin.currentPackageId),
    nextPackage: packageRef(plugin.nextPackageId),
    activeRun: plugin.activeRun ? {
      package: packageRef(plugin.activeRun.packageId),
      handlers: [...(plugin.activeRun.handlers || [])].sort(),
    } : null,
  };
}

function stableRecoveryProof(proof = {}) {
  return {
    // Fiber UIDs, owner UIDs, and process-local active-run IDs are not runtime
    // effects. Keep semantic ownership/state while excluding those volatile
    // handles from the recovery comparison.
    modules: sortSignatureRows((proof.modules || []).map((module) => ({
      name: module.name ?? null,
      state: module.state ?? null,
      owner: module.owner?.name ?? module.owner ?? null,
    }))),
    services: sortSignatureRows((proof.services || []).map((service) => ({
      name: service.name ?? null,
      active: service.active === true,
      owner: service.owner?.name ?? service.owner ?? null,
    }))),
    tools: (proof.tools || []).map((tool) => tool.name ?? null).sort(),
    eventListeners: sortSignatureRows((proof.eventListeners || []).map((listener) => ({
      event: listener.event ?? null,
      callback: listener.callback ?? null,
      owner: listener.owner?.name ?? listener.owner ?? null,
    }))),
    effects: sortSignatureRows((proof.effects || []).map((effect) => ({
      component: effect.component ?? null,
      label: effect.label ?? null,
      disposer: effect.disposer ?? null,
      children: [...(effect.children || [])].sort(),
    }))),
    dynamicPlugins: sortSignatureRows((proof.dynamicPlugins || []).map(stableDynamicPlugin)),
    unknown: [...new Set(proof.unknown || [])].sort(),
  };
}

/** Stable, detached projection used only to prove that Cordis was restored. */
export function runtimeSignature(runtime) {
  return {
    components: sortSignatureRows((runtime.components || []).map((component) => ({
      name: component.name,
      state: component.state,
      inject: [...(component.inject || [])].sort(),
      effects: [...(component.effects || [])].sort(),
    }))),
    services: sortSignatureRows((runtime.services || []).map((service) => ({
      name: service.name,
      active: service.active === true,
      owner: service.owner?.name,
    }))),
    tools: (runtime.tools || []).map((tool) => tool.name).sort(),
    events: sortSignatureRows((runtime.events || []).map((event) => ({
      name: event.name,
      listeners: sortSignatureRows((event.listeners || []).map((listener) => ({
        callback: listener.callback,
        owner: listener.owner?.name,
      }))),
    }))),
    dynamicPlugins: sortSignatureRows((runtime.dynamicPlugins || []).map(stableDynamicPlugin)),
    recoveryProof: stableRecoveryProof(runtime.recoveryProof || { unknown: ["recovery-proof-unavailable"] }),
  };
}

export function signatureEqual(left, right) {
  const leftSignature = runtimeSignature(left);
  const rightSignature = runtimeSignature(right);
  // Stable, pre-existing unknown owners are safe only when both sides retain
  // exactly the same unknown set. Registry-unavailable markers remain
  // fail-closed: an unreadable proof can never establish recovery.
  const leftUnknown = leftSignature.recoveryProof?.unknown || [];
  const rightUnknown = rightSignature.recoveryProof?.unknown || [];
  if (leftUnknown.some((value) => RECOVERY_UNAVAILABLE.has(value))
    || rightUnknown.some((value) => RECOVERY_UNAVAILABLE.has(value))) return false;
  if (JSON.stringify(leftUnknown) !== JSON.stringify(rightUnknown)) return false;
  return JSON.stringify(leftSignature) === JSON.stringify(rightSignature);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function slug(value, fallback = "evo") {
  const result = safeString(value).toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 6);
  return result.length >= 3 ? result : fallback;
}

function meaningfulChange(value) {
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return false;
  return !NEUTRAL_CHANGES.has(value.trim().toLowerCase());
}

function normalizeObservationWindow(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) throw new Error("observation.observationWindow must be a finite positive number or non-empty string");
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  throw new Error("observation.observationWindow must be a finite positive number or non-empty string");
}

// The projection a durable evidence record uses: the credential rule with its
// bounds lifted. `compactValue`'s defaults (a bounded telemetry row) truncate
// text at `maxText`, keep `maxItems` entries and compact past `maxDepth`; an
// observation, a proposal and the archive document are not bounded rows, and the
// contract those records have is that a record carrying no credential is stored
// and rendered byte for byte as before. The one exception is the credential rule's
// own bound, not a bound of this projection: any single field above
// `REDACTION_TEXT_BOUND` (65,536 characters) is replaced by `withheldTextMarker`
// whether or not it holds a credential, exactly as it is under `compactValue`'s
// defaults, so "byte for byte" means "byte for byte below that bound". So the
// archive renderer, the proposal and the measurement capture pass these bounds and
// get the credential rule alone.
const EVIDENCE_PROJECTION = { maxText: Number.MAX_SAFE_INTEGER, maxItems: Number.MAX_SAFE_INTEGER, maxDepth: 64 };

function compactValue(value, { maxText = 1200, maxItems = 8, depth = 0, maxDepth = 4 } = {}) {
  if (value === undefined || value === null || typeof value === "boolean") return value;
  // JSON has no Infinity/NaN and folds -0 into 0: normalize here so a record
  // this process writes is always one it can read back with the same identity.
  if (typeof value === "number") return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : String(value);
  if (typeof value === "string") {
    const redacted = redactCredentialShapes(value);
    return redacted.length > maxText ? `${redacted.slice(0, maxText)}…[truncated]` : redacted;
  }
  if (depth >= maxDepth) return "[compacted]";
  // JSON.stringify writes an array hole or an undefined element as null and
  // drops an undefined property entirely; normalize to that shape now so the
  // identity is computed on the record a reload will actually produce.
  if (Array.isArray(value)) return Array.from(value.slice(0, maxItems), (item) => {
    const compacted = compactValue(item, { maxText, maxItems, depth: depth + 1, maxDepth });
    return compacted === undefined ? null : compacted;
  });
  if (!isObject(value)) return safeString(value);
  const entries = [];
  for (const [key, entry] of Object.entries(value)) {
    if (/^(?:raw|fullOutput|stdout|stderr|logs?|transcript)$/i.test(key)) continue;
    // Key-aware, whole-value redaction. A structured record has already
    // separated the key from the value, so no text rule can see the pair; the
    // decision is therefore made on the key alone and the value is replaced
    // wholesale whatever its type or shape (string, number, object, array, and
    // at any depth, inside arrays of objects included). This is the fail-closed
    // direction: a lost diagnostic field costs a detail, a kept credential costs
    // the boundary.
    if (isCredentialKeyName(key)) {
      // The same marker the text rules emit, so a reader and the tests see one
      // "this was a credential" spelling at both boundaries.
      entries.push([key, "[redacted]"]);
      continue;
    }
    const compacted = compactValue(entry, { maxText, maxItems, depth: depth + 1, maxDepth });
    if (compacted !== undefined) entries.push([key, compacted]);
  }
  // Object.fromEntries defines own properties, so a "__proto__" key survives
  // instead of hitting the prototype setter and silently disappearing.
  return Object.fromEntries(entries);
}

// The depth bound shared by the load predicate and the content-derived
// identity. A restored record may nest up to this many levels, and the
// identity has to distinguish every record the loader accepts, so the
// serializer stops one level past the bound rather than at it.
const MEMORY_ENTRY_MAX_DEPTH = 64;

const NUMBER_LITERAL_CHARACTER = /[0-9eE+.-]/;

// JSON with sorted keys and a bounded depth. The bound matters for the
// content-derived identity of restored records: a record restored from data
// that nests far deeper than any signature input must not raise a RangeError
// while startup is loading it, and doctor and runtime must agree on it.
function stableJson(value, depth = 0) {
  if (depth > MEMORY_ENTRY_MAX_DEPTH) return '"[max-depth]"';
  // Holes and undefined must not serialize like a missing or null value. Read
  // arrays by own index, not through a custom iterator: validation and hashing
  // must agree on the same JSON value even when a tool result overrides
  // Symbol.iterator. Plain arrays keep their historical serialization.
  if (Array.isArray(value)) {
    const parts = [];
    for (let index = 0; index < value.length; index += 1) {
      parts.push(stableJson(Object.hasOwn(value, index) ? value[index] : undefined, depth + 1));
    }
    return `[${parts.join(",")}]`;
  }
  if (value === undefined) return '"[undefined]"';
  // Numbers JSON cannot round-trip must not share a serialization: 1e400 and
  // -1e400 both stringify to null, and -0 to 0, which would merge records.
  if (typeof value === "number" && !Number.isFinite(value)) return JSON.stringify(String(value));
  if (typeof value === "number" && Object.is(value, -0)) return JSON.stringify("-0");
  if (!isObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key], depth + 1)}`).join(",")}}`;
}

/**
 * A workflow `expected` is hashed with `stableJson()`, which folds values past
 * `MEMORY_ENTRY_MAX_DEPTH` into one `"[max-depth]"` marker. Without a guard two
 * expectations that differ only below that depth share one digest, and a wrong
 * candidate result is then judged correct. The same lossless shape is required
 * of the canary functional check; a cyclic or non-finite value is rejected
 * instead of folded, and the depth bound leaves headroom for the serializer.
 */
function probeLosslessSnapshot(value, depth = 0, seen = new Set()) {
  if (depth > MEMORY_ENTRY_MAX_DEPTH) return { ok: false };
  if (value === null || typeof value === "string" || typeof value === "boolean") return { ok: true, snapshot: value };
  if (typeof value === "number") {
    return Number.isFinite(value) && !Object.is(value, -0) ? { ok: true, snapshot: value } : { ok: false };
  }
  if (typeof value !== "object" || seen.has(value)) return { ok: false };
  // Only plain records and dense arrays serialize losslessly. `stableJson()`
  // walks own keys, so a Date serializes as `{}` and would satisfy an `{}`
  // expectation; such a value is not a JSON record and must not be measured.
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return { ok: false };
  }
  seen.add(value);
  let ok = true;
  let snapshot;
  if (Array.isArray(value)) {
    const items = [];
    for (let index = 0; index < value.length && ok; index += 1) {
      // An accessor can answer differently on a second read; read each value
      // once, into the snapshot that is both validated and hashed.
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (!descriptor || descriptor.get || descriptor.set) { ok = false; break; }
      const child = probeLosslessSnapshot(descriptor.value, depth + 1, seen);
      if (!child.ok) { ok = false; break; }
      items.push(child.snapshot);
    }
    snapshot = items;
  } else {
    const entries = [];
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set) { ok = false; break; }
      const child = probeLosslessSnapshot(descriptor.value, depth + 1, seen);
      if (!child.ok) { ok = false; break; }
      entries.push([key, child.snapshot]);
    }
    snapshot = Object.fromEntries(entries);
  }
  seen.delete(value);
  return ok ? { ok: true, snapshot } : { ok: false };
}

/**
 * Exact decimal views of a double and of a JSON number literal, as
 * `digits * 10^exponent`. JSON gives no precision contract, so
 * `9007199254740993` parses to the same double as `9007199254740992`; the lost
 * digit is gone before any serializer runs, and two stored records differing
 * only in such a literal would share an identity. It has to be checked on the
 * raw text, not on the parsed value.
 */
function decimalOfDouble(value) {
  if (value === 0) return { digits: 0n, exponent: 0 };
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const sign = (bits >> 63n) === 1n ? -1n : 1n;
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xfffffffffffffn;
  const mantissa = biased === 0 ? fraction : fraction | (1n << 52n);
  const binaryExponent = biased === 0 ? -1074 : biased - 1075;
  if (binaryExponent >= 0) return { digits: sign * (mantissa << BigInt(binaryExponent)), exponent: 0 };
  return { digits: sign * mantissa * 5n ** BigInt(-binaryExponent), exponent: binaryExponent };
}

function decimalOfLiteral(source) {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match) return null;
  const integer = match[2] || "";
  const fraction = match[3] || "";
  const exponent = Number(match[4] || 0);
  if (!Number.isSafeInteger(exponent)) return null;
  return { digits: (match[1] === "-" ? -1n : 1n) * BigInt(`${integer}${fraction}` || "0"), exponent: exponent - fraction.length };
}

function sameDecimal(left, right) {
  if (!left || !right) return false;
  let a = left.digits, aExponent = left.exponent, b = right.digits, bExponent = right.exponent;
  if (a === 0n || b === 0n) return a === b;
  while (a % 10n === 0n) { a /= 10n; aExponent += 1; }
  while (b % 10n === 0n) { b /= 10n; bExponent += 1; }
  return a === b && aExponent === bExponent;
}

/**
 * True when `source` names the same number as the double JSON.parse produced.
 * A literal survives when it is either the shortest round-trip form of that
 * double (the common case, and the fast path) or its exact decimal expansion.
 */
function numberLiteralSurvives(source) {
  const value = Number(source);
  if (!Number.isFinite(value)) return false;
  const literal = decimalOfLiteral(source);
  if (sameDecimal(literal, decimalOfLiteral(String(value)))) return true;
  return sameDecimal(literal, decimalOfDouble(value));
}

/**
 * Checks the parts of a JSON document that JSON.parse cannot report: number
 * literals whose digits do not survive parsing, and duplicate object keys,
 * whose earlier values are silently dropped. Both would let two different
 * stored records share an identity after parsing. Exported so the doctor
 * rejects exactly the files the runtime quarantines.
 */
export function inspectMemoryText(text) {
  const stack = [];
  let expectKey = false;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '"') {
      const start = index;
      index += 1;
      while (index < text.length) {
        if (text[index] === "\\") { index += 2; continue; }
        if (text[index] === '"') { index += 1; break; }
        index += 1;
      }
      const frame = stack[stack.length - 1];
      if (expectKey && frame && frame.keys) {
        let key;
        try { key = JSON.parse(text.slice(start, index)); } catch { key = text.slice(start, index); }
        if (frame.keys.has(key)) return { ok: false, reason: "duplicate-key-failure" };
        frame.keys.add(key);
      }
      expectKey = false;
      continue;
    }
    if (character === "{") { stack.push({ keys: new Set() }); expectKey = true; index += 1; continue; }
    if (character === "[") { stack.push({ keys: null }); expectKey = false; index += 1; continue; }
    if (character === "}" || character === "]") { stack.pop(); expectKey = false; index += 1; continue; }
    if (character === ",") {
      const frame = stack[stack.length - 1];
      expectKey = Boolean(frame && frame.keys);
      index += 1;
      continue;
    }
    if (character === ":") { expectKey = false; index += 1; continue; }
    if (character === "-" || (character >= "0" && character <= "9")) {
      const start = index;
      index += 1;
      while (index < text.length && NUMBER_LITERAL_CHARACTER.test(text[index])) index += 1;
      if (!numberLiteralSurvives(text.slice(start, index))) return { ok: false, reason: "number-failure" };
      continue;
    }
    index += 1;
  }
  return { ok: true };
}

/**
 * Pure data projection at the tool output boundary (Proposal #1).
 * Rewrites any value into the harness lossless-JSON contract without touching
 * live Cordis objects: undefined -> null; functions/symbols/bigints -> String
 * markers; non-finite numbers -> String; -0 -> 0; Date -> ISO string; Error ->
 * { name, message }; Map/Set -> arrays; other class instances -> projected own
 * enumerable properties tagged with $class; cycles -> "[Circular]". Values
 * that are already lossless pass through struct unchanged, so JSON-compatible
 * information is preserved verbatim.
 */
export function toLosslessJson(value, ancestors = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "undefined") return null;
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") return String(value);
  if (ancestors.has(value)) return "[Circular]";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => toLosslessJson(item, ancestors));
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) return { name: value.name, message: String(value.message ?? "") };
    if (value instanceof Map) return [...value.entries()].map((entry) => toLosslessJson(entry, ancestors));
    if (value instanceof Set) return [...value.values()].map((item) => toLosslessJson(item, ancestors));
    const plain = Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
    // `$class` stays first for a non-plain object, and an instance's own `$class`
    // overrides the value in place: `Object.fromEntries` defines own properties,
    // so a later duplicate keeps the first position. Assigning into `{}` instead
    // would hand a data-derived `__proto__` key to the prototype setter, which
    // drops the key and (for an object payload) makes it the output's prototype.
    const entries = plain ? [] : [["$class", value.constructor?.name || "anonymous"]];
    for (const key of Object.keys(value)) {
      entries.push([key, toLosslessJson(value[key], ancestors)]);
    }
    return Object.fromEntries(entries);
  } finally {
    ancestors.delete(value);
  }
}

// Fuse cloning and projection for ordinary snapshot trees. Fall back to the
// original boundary for aliases, accessors and exotic objects: structuredClone
// has observable semantics there (including DataCloneError and prototype loss).
function snapshotJson(value) {
  const fallback = Symbol("snapshot-fallback");
  const seen = new Set();
  function visit(input) {
    if (input === null || typeof input !== "object") {
      if (typeof input === "function" || typeof input === "symbol") throw fallback;
      return toLosslessJson(input, seen);
    }
    if (types.isProxy(input)) throw fallback;
    const array = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input);
    if ((!array && prototype !== Object.prototype && prototype !== null) || seen.has(input)) throw fallback;
    seen.add(input);
    const keys = Object.keys(input);
    // Sparse arrays and extra properties retain the native clone behavior.
    if (array && keys.length !== input.length) throw fallback;
    const result = array ? new Array(input.length) : {};
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index];
      if (array && key !== String(index)) throw fallback;
      // Looking up the getter avoids allocating a descriptor for every field.
      if (Object.prototype.__lookupGetter__.call(input, key) || key === "__proto__") throw fallback;
      result[key] = visit(input[key]);
    }
    return result;
  }
  try { return visit(value); }
  catch (error) {
    if (error !== fallback) throw error;
    return toLosslessJson(structuredClone(value));
  }
}

/**
 * A restored record the file-backed memory can hold safely. A record nested
 * deeper than the signature bound is damaged input for this format: the store
 * is cloned on every snapshot, and a deeply nested record would take startup
 * down with a stack overflow instead of being quarantined. The walk is
 * iterative on purpose - a recursive one would fail on exactly the input it
 * has to reject - and the doctor uses the same predicate so the two never
 * disagree about a file one of them rejects.
 */
export function isUsableMemoryEntry(entry) {
  if (!isObject(entry)) return false;
  const stack = [[entry, 0]];
  while (stack.length > 0) {
    const [current, depth] = stack.pop();
    if (depth > MEMORY_ENTRY_MAX_DEPTH) return false;
    // Values JSON cannot represent faithfully cannot be read back with the same
    // identity, so they are damaged input for this format.
    if (typeof current === "number" && (!Number.isFinite(current) || Object.is(current, -0))) return false;
    if (Array.isArray(current)) { for (const value of current) stack.push([value, depth + 1]); }
    else if (isObject(current)) { for (const value of Object.values(current)) stack.push([value, depth + 1]); }
  }
  return true;
}

/**
 * The identity a stored failure record is deduplicated by. Records written by
 * `record()` always carry a mode signature; a record restored from older data
 * may not, and deriving the digest from the whole record keeps it apart from
 * every different record instead of collapsing unrelated records into one
 * entry under a missing key.
 */
function storedEntrySignature(entry) {
  return typeof entry.signature === "string" && entry.signature.length > 0
    ? entry.signature
    : sha256(stableJson(entry));
}

/** Durable, deduplicated and bounded failure memory. */
export class EvolutionMemory {
  constructor({ file, maxEntries = 200, maxText = 1200, maxItems = 8 } = {}) {
    this.file = file;
    this.maxEntries = Math.max(1, Number(maxEntries) || 200);
    this.maxText = Math.max(128, Number(maxText) || 1200);
    this.maxItems = Math.max(1, Number(maxItems) || 8);
    this.data = { schema: 1, entries: [] };
    this.warnings = [];
    this.quarantine = null;
    this.load();
  }

  /**
   * Move a damaged memory file aside, keep its bytes, and continue with an
   * empty memory. Returns true when the original file was moved.
   */
  quarantineFile(reason, description) {
    const quarantined = `${this.file}.quarantine-${process.pid}-${Date.now()}`;
    let moved = false;
    try {
      fs.renameSync(this.file, quarantined);
      this.quarantine = { from: this.file, to: quarantined, at: now(), reason };
      moved = true;
    } catch (error) {
      // Keep the unreadable source intact if quarantine cannot be made;
      // startup still continues, but the warning remains queryable.
      this.warnings.push(`evolution-memory.json ${description}且无法隔离（${error.message}）；已用空 memory 继续启动`);
    }
    if (moved) {
      this.warnings.push(`evolution-memory.json ${description}已隔离: ${quarantined}；已用空 memory 继续启动`);
      try { this.compact({ save: true }); } catch (error) {
        this.warnings.push(`evolution-memory.json 空 memory 写入失败（${error.message}）；runtime 仍继续启动`);
      }
    }
    return moved;
  }

  load() {
    if (!this.file) return this.snapshot();
    let stored;
    let inspection = { ok: true };
    try {
      // A file that is not well-formed UTF-8 must not be "repaired" by a lossy
      // decode: the replacement characters would merge distinct records, and a
      // later save would overwrite the original bytes. A BOM is not part of
      // JSON either, and keeping it here makes the parse fail instead of a save
      // silently rewriting the file without it.
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(this.file));
      inspection = inspectMemoryText(text);
      stored = JSON.parse(text);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        // A corrupted memory file must not take the orchestrator down: move it
        // aside (quarantine), continue with an empty memory, and surface a
        // queryable warning instead of failing startup.
        const encodingFailure = error instanceof TypeError && /encoded/i.test(String(error.message));
        if (encodingFailure) this.quarantineFile("encoding-failure", "编码无效");
        // The parse message can embed a quoted excerpt of the file; the warning is
        // queryable through inspect and the tool result, so it crosses the boundary.
        else this.quarantineFile("parse-failure", `损坏（parse failure: ${redactJsonParseMessage(String(error?.message ?? error))}）`);
        return this.snapshot();
      }
    }
    // A record that is not an object cannot be deduplicated or trimmed without
    // guessing, so the whole file is quarantined like any other damaged state;
    // a restored record that merely lacks an identity gets a derived one below.
    // Content a parse could not preserve exactly - a lossy number literal, a
    // duplicate key, a lossy decode - counts as damaged too: the difference is
    // unobservable afterwards, so two records could share an identity.
    const entriesUsable = Array.isArray(stored?.entries) && stored.entries.every(isUsableMemoryEntry);
    if (inspection.ok && stored?.schema === 1 && entriesUsable) {
      this.data = stored;
      for (const entry of this.data.entries) {
        if (typeof entry.signature !== "string" || entry.signature.length === 0) entry.signature = storedEntrySignature(entry);
      }
    } else if (stored !== undefined) {
      const descriptions = {
        "number-failure": "数值无法保真解析",
        "duplicate-key-failure": "对象含重复键",
        "entry-failure": "记录不可用",
        "schema-failure": "结构无效",
      };
      const reason = inspection.ok ? (stored?.schema === 1 ? "entry-failure" : "schema-failure") : inspection.reason;
      this.quarantineFile(reason, descriptions[reason] || "损坏");
    }
    this.retainEntries();
    return this.snapshot();
  }

  snapshot() { return structuredClone(this.data); }

  diagnostics() {
    return { warnings: [...this.warnings], quarantine: this.quarantine ? { ...this.quarantine } : null };
  }

  signature(entry = {}) {
    const experiment = isObject(entry.experiment)
      ? Object.fromEntries(Object.entries(entry.experiment).filter(([key]) => !/^(?:id|experimentId|createdAt|recordedAt|at)$/i.test(key)))
      : entry.experiment;
    const basis = compactValue({
      problem: entry.problem,
      experiment,
      result: entry.result?.category || entry.result?.state || entry.result,
      prevention: entry.prevention,
    }, { maxText: this.maxText, maxItems: this.maxItems });
    return sha256(stableJson(basis));
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  record(entry = {}) {
    const compacted = compactValue({
      problem: entry.problem || "unknown",
      evidence: entry.evidence || {},
      experiment: entry.experiment || {},
      result: entry.result || {},
      prevention: entry.prevention || "unknown",
    }, { maxText: this.maxText, maxItems: this.maxItems });
    const signature = typeof entry.signature === "string" && entry.signature.length > 0
      ? entry.signature
      : this.signature(compacted);
    const at = entry.at || now();
    const existing = this.data.entries.find((item) => item.signature === signature);
    if (existing) {
      existing.count = (Number(existing.count) || 1) + 1;
      existing.lastSeenAt = at;
      existing.evidence = compacted.evidence;
      existing.result = compacted.result;
      existing.prevention = compacted.prevention;
      existing.status = entry.status || existing.status || "active";
    } else {
      this.data.entries.push({ signature, count: 1, firstSeenAt: at, lastSeenAt: at, status: entry.status || "active", ...compacted });
    }
    this.retainEntries({ keep: signature });
    this.save();
    const recorded = existing || this.data.entries.find((item) => storedEntrySignature(item) === signature);
    return { entry: structuredClone(recorded), duplicate: Boolean(existing) };
  }

  /**
   * Deduplicate by signature, keep the newest `maxEntries`, and drop the rest.
   * Split out of `compact()` because recording a failure and loading a stored
   * memory both only need the trimmed state: cloning the whole record set for a
   * value they discard was the largest single cost of recording.
   */
  retainEntries({ keep = null } = {}) {
    const bySignature = new Map();
    for (const entry of this.data.entries) {
      const signature = storedEntrySignature(entry);
      const previous = bySignature.get(signature);
      if (!previous || String(previous.lastSeenAt) <= String(entry.lastSeenAt)) bySignature.set(signature, entry);
    }
    const kept = [...bySignature.values()]
      .sort((left, right) => String(left.lastSeenAt).localeCompare(String(right.lastSeenAt)))
      .slice(-this.maxEntries);
    // The record written by this call must survive its own retention pass: a
    // clock that moved backwards sorts it older than a full store, so the
    // failure just observed would be dropped instead of the oldest record.
    if (keep !== null && !kept.some((entry) => storedEntrySignature(entry) === keep)) {
      const recorded = bySignature.get(keep);
      if (recorded) {
        if (kept.length >= this.maxEntries) kept.shift();
        kept.push(recorded);
      }
    }
    this.data.entries = kept;
  }

  compact({ save = true } = {}) {
    this.retainEntries();
    if (save) this.save();
    return this.snapshot();
  }

  hasActiveSignature(signature) {
    return this.data.entries.some((entry) => entry.signature === signature && entry.status !== "resolved");
  }

  resolve(signature) {
    const entry = this.data.entries.find((item) => item.signature === signature);
    if (!entry) return false;
    entry.status = "resolved";
    entry.resolvedAt = now();
    this.save();
    return true;
  }
}

function normalizeTargets(args = {}) {
  const explicit = isObject(args.targets) ? args.targets : {};
  const result = [];
  for (const [kind, values] of [
    ["component", explicit.components],
    ["plugin", explicit.plugins],
    ["configuration", explicit.configurations],
  ]) {
    for (const value of Array.isArray(values) ? values : values ? [values] : []) {
      result.push(`${kind}:${text(value, `targets.${kind}`)}`);
    }
  }
  if (result.length === 0) {
    const target = text(args.target, "target");
    const match = /^(component|plugin|configuration):(.+)$/i.exec(target);
    result.push(match ? `${match[1].toLowerCase()}:${match[2].trim()}` : `configuration:${target}`);
  }
  return [...new Set(result)].sort();
}

// How many distinct error patterns one process keeps a live observation window
// (and a candidate view) for. The observation stream is already capped at 200;
// these two maps grow from the same input stream and had no cap at all, so an
// unattended process that observes indefinitely many distinct patterns kept both
// of them for its whole lifetime. Absent from the cap is the durable record
// itself: dropping an observation window only means the pattern starts counting
// again, and a live experiment awaiting its owner is found through
// `this.experiments` (see `pendingAutonomousCandidate`), never through these
// maps, so eviction can never cause a second trial for the same hypothesis.
const AUTONOMOUS_PATTERN_CAP = 200;

/**
 * One pattern's evidence window, assembled from the two halves that know about
 * it: the durable rows the store still retains for this exact identity, and the
 * rows this session already counted.
 *
 * These are a union, never a replacement. The durable read is a bounded tail of
 * the *whole* observation collection (`autonomousObservations`), so a busy
 * session - every failing tool call and every provider error is one row - pushes
 * a pattern's own rows out of that tail while unrelated faults keep arriving. The
 * observer then read fewer occurrences than it had already committed, reported
 * `occurrences: 1` for a fault it had recorded three times, and never reached
 * `patternThreshold`: the whole loop (strategy -> isolated Trial -> measurement)
 * silently never started for a fault that recurs slowly. Replacing the session's
 * window with that tail threw away evidence the process held in memory. Unioning
 * keeps both halves and therefore cannot count a pattern downwards in a session;
 * the durable half still carries the cross-restart evidence, which stays bounded
 * by the store's retained tail (see README's cross-session boundary).
 *
 * Deduplication is by `observationId`, the one identity both halves share
 * (`projectObservation` records the observation under that id), so an occurrence
 * that is in the durable tail and in the session window counts once. Rows are
 * returned oldest first, because the durable half and the session half can each
 * be missing a piece the other has.
 */
function mergePatternEvidence(...groups) {
  const seen = new Set();
  const merged = [];
  for (const group of groups) {
    for (const row of Array.isArray(group) ? group : []) {
      const id = row?.observationId;
      if (typeof id !== "string" || id === "" || seen.has(id)) continue;
      seen.add(id);
      merged.push(row);
    }
  }
  // `Array.prototype.sort` is stable, so two rows stamped in the same
  // millisecond keep the order they were read in.
  return merged.sort((left, right) => safeString(left?.at).localeCompare(safeString(right?.at)));
}

// Failures that say something about the environment, not about the hypothesis:
// another experiment holds the target, the same experiment is mid-operation, or
// a resource/permission error. None of them is evidence that the strategy does
// not work, so none may become a durable "do not repeat this" record. Before
// this boundary existed every throw on the autonomous path was recorded as a
// `runtime-trial` failure, including the target-conflict text produced by the
// observer's own still-pending experiment - which permanently suppressed a
// strategy that had just produced eligible evidence.
//
// Matched against the bounded, credential-redacted DTO, with plain alternations
// only: no expression here may backtrack over provider-controlled text.
const TRANSIENT_AUTONOMOUS_FAILURES = [
  /unsafe parallel experiment conflicts/i,
  // A claim that cannot be read or parsed (a permission error, a half-written
  // entry, a corrupt body) is a local condition: `acquireTargets()` reports all
  // of them as "experiment ownership is unreadable" and keeps the file for the
  // operator, so none of them is evidence about the hypothesis. Without this the
  // underlying `EACCES` never reached the DTO and a permissions accident became a
  // permanent "this strategy does not work" record.
  /ownership is unreadable/i,
  /is busy with/i,
  /E_EVENT_BRIDGE_APPEND_LOCK_BUSY|E_DOMAIN_EVENT_LOG_BUSY/,
  /\b(?:EACCES|EPERM|EBUSY|ENOSPC|EAGAIN|EMFILE|ENFILE)\b/,
  /approval|permission|unauthor/i,
  // A user or host cancellation aborts a Trial that never produced evidence
  // about the hypothesis; so does a runtime that is still occupied by another
  // experiment (see `assertRuntimeAvailable`).
  /\bE_EVOLUTION_RUNTIME_BUSY\b|\bE_EVOLUTION_TRIAL_NOT_ACTIVE\b/,
  /\babort(?:ed|error)?\b/i,
  /\bcancel(?:led|ed)?\b/i,
];

// The states in which one experiment occupies the process-wide runtime the
// Trial baseline describes. Two of them at once cannot both recover: each
// Trial's baseline was captured before the other plugin existed, so reverting
// either one sees the other as drift (AGENTS.md invariant 3) and leaves both
// targets claimed with neither experiment revertable.
const RUNTIME_OCCUPYING_STATES = new Set(["trial-starting", "trial", "trial-awaiting-approval", "measured"]);
const RUNTIME_BUSY_CODE = "E_EVOLUTION_RUNTIME_BUSY";

// Terminal records kept in memory. They are history, not authority: the
// durable archive and the failure memory already hold them, and a record that
// still owns a target claim or an operation claim is never dropped.
const TERMINAL_EXPERIMENT_STATES = new Set(["reverted", "trial-failed", "promotion-failed", "rolled-back", "stable"]);
// States `revert` accepts: a live (or frozen) Trial, plus the two states in which a
// cleanup ran but could not prove runtime recovery. The second group is not a
// terminal verdict - the record still owns the runtime and its target claim - so it
// stays retryable instead of becoming an unreachable occupant.
const RETRYABLE_CLEANUP_STATES = new Set(["revert-failed", "trial-cleanup-failed"]);
const REVERTABLE_STATES = new Set(["trial", "trial-awaiting-approval", "measured", ...RETRYABLE_CLEANUP_STATES]);

// The minimum spacing between two retries of one unproven autonomous cleanup.
//
// The retry is driven by later observations, never by a timer or a loop, and it is
// the same `revert` the owner could run by hand: the same official disposers and
// the same baseline captured before the first mutation, so it either proves the
// runtime is free or changes nothing about what the record owns (target claim,
// baseline, evidence). The cooldown is what keeps a persistently failing cleanup
// from being retried once per error event, while still letting a transient
// stop/undefine failure be retried soon after the environment recovers. It is a
// condition evaluated when an observation arrives, not a schedule: an idle session
// retries nothing.
const AUTONOMOUS_CLEANUP_RECOVERY_COOLDOWN_MS = 30_000;

// The minimum spacing between two attempts of one hypothesis whose last attempt
// failed for an environment reason (see `TRANSIENT_AUTONOMOUS_FAILURES`).
//
// Such a failure is not evidence about the declaration, so it must not become the
// session verdict `suppressedPatterns` holds - the conflict it reports can be over
// while this process is still running (the occupant was reverted, a permission was
// fixed, the host finished its operation), and retiring the hypothesis until the
// next restart threw away a valid strategy for a condition that no longer exists.
// It is a timestamp instead: a later observation attempts the hypothesis again once
// this interval has passed. Like the cleanup retry this is a condition evaluated
// when an observation arrives, never a timer or a loop, and it keeps a persistent
// conflict from being re-probed once per error event.
const AUTONOMOUS_TRANSIENT_RETRY_COOLDOWN_MS = 30_000;

/**
 * The official runner's documented "already in the target state" disposer reasons.
 *
 * Cleanup has to be retryable (see `revert()`), and the disposers it retries are not
 * idempotent: a run that was already stopped answers `not-running` instead of
 * `ok`, and a plugin that was already removed answers `plugin-missing`. Both
 * responses describe the state this cleanup exists to prove, so they count as
 * proof for the step they answer; anything else (a thrown receipt, an unknown
 * reason, a future shape) does not. The runner publishes both as closed unions,
 * which is why the reason vocabulary is a contract and not host phrasing.
 */
const DISPOSER_PROVED_REASONS = Object.freeze({
  stop: new Set(["not-running", "plugin-missing"]),
  undefine: new Set(["plugin-missing"]),
});

function disposerProved(step, receipt) {
  if (receipt?.ok === true) return true;
  const reason = typeof receipt?.reason === "string" ? receipt.reason : null;
  return reason !== null && DISPOSER_PROVED_REASONS[step].has(reason);
}

function autonomousFailureIsTransient(detail) {
  const text = `${detail?.errorCode ?? ""} ${detail?.errorSummary ?? ""}`;
  return TRANSIENT_AUTONOMOUS_FAILURES.some((pattern) => pattern.test(text));
}

/**
 * Rollback evidence nests provider error text under `error`, `errors` and
 * `message`. Those leaves cross the same boundary as the failure's own text;
 * every other string is still bounded and credential-redacted.
 *
 * `maxDepth`/`maxItems` are parameters because a cleanup proof is small while a
 * recovery proof also carries the runtime fingerprints, which nest deeper than
 * a rollback receipt. One projection, two bounds: there is no second scrubber.
 */
function safeErrorEvidence(value, depth = 0, { maxDepth = 4, maxItems = 8 } = {}) {
  if (typeof value === "string") return redactCredentialShapes(value).slice(0, ERROR_SUMMARY_MAX);
  if (value === null || typeof value !== "object") return value;
  if (depth >= maxDepth) return "[compacted]";
  // Reading a record is not non-throwing by itself: `Object.entries` runs
  // `ownKeys`, `getOwnPropertyDescriptor` and a `get` per key, and a Proxy or an
  // accessor can throw from any of them; `Array.isArray` throws on a revoked
  // Proxy and `slice` throws when an index getter does. A node whose properties
  // cannot be read is therefore withheld wholesale — the same `[compacted]`
  // marker the depth bound uses — instead of rethrowing. The read is the only
  // thing inside the guard, so a nested node that fails is withheld on its own
  // rather than taking its readable siblings with it.
  let isList = false;
  try { isList = Array.isArray(value); } catch { return "[compacted]"; }
  if (isList) {
    let items;
    try { items = value.slice(0, maxItems); } catch { return "[compacted]"; }
    // A guarded `slice` is not the whole traversal: `slice` itself can be an
    // override (a Proxy handler's own `slice`) that returns a non-array, and the
    // `map` that followed it then threw `TypeError: items.map is not a function`
    // out of a boundary documented as non-throwing. `length` and every index are
    // reads too, and a getter can throw from either. The result of the traversal
    // is therefore produced under guards that fail closed to `[compacted]` for
    // this node, while one unreadable element is withheld on its own so the
    // readable elements (and the sibling fields of the record above) survive
    // exactly as they do for one unreadable property of an object.
    let length;
    try {
      if (!Array.isArray(items)) return "[compacted]";
      length = items.length;
      // Read AND type-checked inside the guard: `length` is coerced again by the
      // loop comparison, so a value a source can return without throwing (a
      // Symbol, a string, a throwing `valueOf`) would otherwise escape here.
      if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return "[compacted]";
    } catch { return "[compacted]"; }
    const output = [];
    for (let index = 0; index < length && index < maxItems; index += 1) {
      let present;
      try { present = index in items; } catch { output.push("[compacted]"); continue; }
      // `Array.prototype.map` skips holes, so a sparse proof keeps its shape here
      // too instead of gaining explicit `undefined` entries.
      if (!present) { output.length += 1; continue; }
      let item;
      try { item = items[index]; } catch { output.push("[compacted]"); continue; }
      output.push(safeErrorEvidence(item, depth + 1, { maxDepth, maxItems }));
    }
    return output;
  }
  let entries;
  try { entries = Object.entries(value); } catch { return "[compacted]"; }
  // Collected as pairs and built with `Object.fromEntries`, so a data-derived
  // `__proto__` key is defined as an own property here too: assigning into `{}`
  // dropped it and let the payload (which can carry a `status`) become this
  // node's prototype, where a later reader inherited it as a real field.
  const output = [];
  for (const [key, entry] of entries) {
    if (/^(?:raw|fullOutput|stdout|stderr|logs?|transcript)$/i.test(key)) continue;
    // Key-aware, whole-value redaction: the same predicate `compactValue` uses,
    // derived from the same one `CREDENTIAL_KEY` table. A proof record has
    // already separated the key from the value, so the text rules above cannot
    // see the pair — `{ evidence: { access_token: "…" } }` matches no
    // assignment shape at all, because key and value are two object properties.
    // The decision is therefore made on the key alone and the value is replaced
    // wholesale, whatever its type (string, number, boolean, object, array) and
    // at every depth this projection walks, arrays of objects included. The
    // marker is the same one the text rules and `compactValue` emit, so a reader
    // sees one spelling for "this was a credential" at all three boundaries.
    // This is the fail-closed direction: a lost diagnostic field costs a detail,
    // a kept credential costs the boundary. It runs before `ERROR_TEXT_KEY`
    // because a credential key is decided by the key, not by the value's text.
    if (isCredentialKeyName(key)) {
      output.push([key, "[redacted]"]);
      continue;
    }
    output.push([key, ERROR_TEXT_KEY.test(key) && typeof entry === "string"
      ? safeErrorDto(entry, "rollback").errorSummary
      : safeErrorEvidence(entry, depth + 1, { maxDepth, maxItems })]);
  }
  return Object.fromEntries(output);
}

// A recovery proof also carries the runtime fingerprints, so it nests deeper than
// a rollback receipt and must not lose fingerprint rows to the receipt's bounds.
const PROOF_EVIDENCE_BOUNDS = { maxDepth: 8, maxItems: 512 };

/**
 * The one boundary for `cleanupProof` / `recoveryProof`. Both are written into
 * the archive, the evidence sidecar and the event bridge, and both can also be
 * *read back* from an older durable record that an earlier version wrote with
 * raw error text — so the projection is applied where a proof is captured and
 * again where a stored proof is rendered, never only on one side.
 */
function safeProofForPersistence(proof) {
  if (proof === null || proof === undefined) return null;
  if (typeof proof !== "object") return proof;
  return safeErrorEvidence(proof, 0, PROOF_EVIDENCE_BOUNDS);
}

function failureLearning({ record, phase, error, rollbackResult, rootCauseHypothesis, nextPreventionHint }) {
  return {
    experimentId: record.id,
    failurePhase: phase,
    ...safeErrorDto(error, phase),
    rootCauseHypothesis: rootCauseHypothesis || "需要依据 Cordis inspect 与 cleanup proof 继续定位；当前不把症状升级为永久规则。",
    rollbackResult: rollbackResult === undefined || rollbackResult === null ? { ok: false, status: "unknown" } : safeErrorEvidence(rollbackResult),
    nextPreventionHint: nextPreventionHint || "下一次实验先复核基线、边界与可逆性，并避免复用未证实的假设。",
    recordedAt: now(),
  };
}

// The failure record is built *on the failure path*, between the failing
// operation and the `finally` that releases the operation claim, the target lock
// and the experiment record. It must therefore never be able to throw: the sixth
// review reproduced exactly that (`failureLearning` -> `safeErrorDto` -> a
// `RangeError` from the redaction rules on an 8 MiB message), and the throw left
// the Trial target lock held and the experiment record alive, bypassing the
// release in `trial()`'s `finally`.
//
// `safeErrorDto` and `safeErrorEvidence` are non-throwing and bounded by
// construction now, so this wrapper is the second guard rather than the fix: if
// the DTO ever did fail, the durable record degrades to a classification-only
// failure object with a fixed, text-free summary, and the cleanup path still
// runs with the original error still propagating to the caller.
const FAILURE_DTO_FALLBACK_SUMMARY = "[failure details withheld: the safe error boundary failed]";

function safeFailureLearning(args) {
  try {
    return failureLearning(args);
  } catch {
    const phase = typeof args?.phase === "string" ? args.phase.slice(0, 64) : "unknown";
    return {
      experimentId: args?.record?.id ?? null,
      failurePhase: phase,
      errorCode: null,
      errorCategory: failureCategory({ message: "" }, phase),
      // Digest-shaped and deterministic per phase, so a reader that validates the
      // field's shape still accepts the record while nobody can mistake it for
      // the digest of a real message.
      errorDigest: `sha256:${sha256(`failure-dto-unavailable:${phase}`).slice(0, 16)}`,
      errorSummary: FAILURE_DTO_FALLBACK_SUMMARY,
      errorLength: 0,
      rootCauseHypothesis: "失败 DTO 构造本身失败，未保留任何原始文本；依据 failurePhase 与运行时不变量继续定位。",
      rollbackResult: { ok: false, status: "unknown" },
      nextPreventionHint: "先修复安全错误边界（它必须对任意输入不抛异常），再重新建立 Trial 基线。",
      recordedAt: now(),
    };
  }
}

/**
 * Normalize a failure for durable output through the same boundary. A failure
 * rebuilt from an older record or an old durable snapshot can still carry the
 * raw message under `error`; re-deriving the safe fields and dropping that key
 * keeps the archive from writing the text again.
 */
function safeFailureForPersistence(failure) {
  if (!failure || typeof failure !== "object") return { status: "none" };
  const { error, ...rest } = failure;
  const detail = error === undefined ? null : safeErrorDto(error, rest.failurePhase || "runtime");
  return safeErrorEvidence({
    ...rest,
    ...(detail === null ? {} : {
      errorCode: rest.errorCode ?? detail.errorCode,
      errorCategory: rest.errorCategory ?? detail.errorCategory,
      errorDigest: rest.errorDigest ?? detail.errorDigest,
      errorSummary: rest.errorSummary ?? detail.errorSummary,
      errorLength: rest.errorLength ?? detail.errorLength,
    }),
  });
}

/**
 * The Compose decision is durable evidence too: its reasons are bounded text
 * (probe reasons include tool/step names, never tool output), and the whole
 * document crosses the same evidence projection the surrounding archive uses.
 */
function safeDecisionForPersistence(decision) {
  return isObject(decision) ? compactValue(decision, EVIDENCE_PROJECTION) : null;
}

/**
 * Observation input feeds both the failure memory and the inspect output. The
 * free-text message is replaced by the safe error summary and the classification
 * fields are added, so no later reader has to sanitize it again.
 */
function safeObservationInput(input) {
  if (!isObject(input)) return input;
  // The raw `error` object is dropped rather than copied: its own `message`
  // field would otherwise survive nested inside compactValue.
  const { error, ...rest } = input;
  const compacted = compactValue(rest);
  const detail = safeErrorDto(input.message ?? error ?? "", "observation");
  return {
    ...compacted,
    message: detail.errorSummary,
    errorCode: input.errorCode ?? detail.errorCode ?? compacted.errorCode ?? null,
    errorCategory: input.errorCategory ?? detail.errorCategory,
    errorDigest: input.errorDigest ?? detail.errorDigest,
  };
}

// ---------------------------------------------------------------------------
// Evidence persistence helpers (goal-9c7d4023)
//
// Cross-session hydration and stable-commit merge must NOT downgrade
// previously persisted evidence. Empty arrays, null, undefined, "unknown"
// and missing fields are downgrades; recovered observations, populated
// metrics, true gates, and successful recovery proofs are upgrades.
// ---------------------------------------------------------------------------

const EVIDENCE_SNAPSHOT_SUFFIX = ".evidence.json";

function isMissing(value) {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function isUnknownStatus(value) {
  return value && typeof value === "object"
    && (value.status === "unknown" || value.status === "not-required" || value.status === "not-run");
}

function preferTruthy(existing, candidate) {
  if (isMissing(candidate)) return existing;
  if (isMissing(existing)) return candidate;
  return candidate;
}

function preferArray(existing, candidate) {
  const ex = Array.isArray(existing) ? existing : [];
  const ca = Array.isArray(candidate) ? candidate : [];
  if (ca.length === 0) return ex;
  if (ex.length === 0) return ca;
  const seen = new Set();
  const merged = [];
  for (const item of [...ex, ...ca]) {
    // Proof objects carry an id/barrier/at/experimentId identity. Plain
    // measurements carry bare strings (sideEffects, orphanResources): all four
    // object fields are undefined there, so a single identity key collapsed
    // every distinct string into one. Key primitives by their own value.
    const key = item !== null && typeof item === "object"
      ? JSON.stringify(["proof", item.id, item.barrierId, item.at, item.experimentId])
      : JSON.stringify([typeof item, item]);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function preferObject(existing, candidate) {
  if (isMissing(candidate)) return existing;
  if (isMissing(existing)) return candidate;
  // Monotonic: never let a known-good value be downgraded by an unknown
  // status payload. If the existing payload already proves a real status
  // (anything other than unknown/not-required/not-run), keep it; only adopt
  // unknown values when existing is missing or also unknown.
  if (isUnknownStatus(candidate) && !isUnknownStatus(existing)) return existing;
  if (isUnknownStatus(existing) && !isUnknownStatus(candidate)) return candidate;
  return { ...existing, ...candidate };
}

// Metrics are a different shape from the structured proofs above: a durable
// snapshot is a floor, not an authority. A known current value must never be
// overwritten by an older durable value on the same key; missing current fields
// simply fall back to the durable floor.
function preferMetricObject(current, durable) {
  if (isMissing(durable)) return current;
  if (isMissing(current)) return durable;
  const merged = { ...durable };
  for (const [key, value] of Object.entries(current)) {
    // Every own key on the current measurement stays its own data property,
    // including an own `__proto__` key whose value is itself empty. Filling it
    // from durable would replace a fact the current observation actually
    // carries. Plain assignment would hand `__proto__` to the prototype setter
    // (AGENTS.md invariant 12).
    if (value === undefined) continue;
    Object.defineProperty(merged, key, { value, enumerable: true, configurable: true, writable: true });
  }
  return merged;
}

function preferEvidenceSnapshot(sidecar, archive) {
  // The sidecar is the authoritative machine-readable snapshot. The
  // archive-md parse is a fallback for older promotions whose sidecar was
  // never written. We never fabricate evidence: if both are missing, we
  // return null. The merged result is the union of non-missing fields,
  // and recoveryProof prefers the sidecar (because it carries the full
  // capture metadata); the archive-md only contributes fields that the
  // sidecar does not have.
  if (!sidecar && !archive) return null;
  if (!sidecar) return archive;
  if (!archive) return sidecar;
  return {
    version: 1,
    source: sidecar.source ? `${sidecar.source}+archive-md` : "sidecar+archive-md",
    capturedAt: sidecar.capturedAt || archive.capturedAt || null,
    promotionTimestamp: sidecar.promotionTimestamp || archive.promotionTimestamp || null,
    latestObservation: preferObject(archive.latestObservation, sidecar.latestObservation) || archive.latestObservation || sidecar.latestObservation || null,
    observations: preferArray(sidecar.observations, archive.observations),
    cleanupProof: preferObject(archive.cleanupProof, sidecar.cleanupProof) || sidecar.cleanupProof || archive.cleanupProof || null,
    recoveryProof: preferObject(archive.recoveryProof, sidecar.recoveryProof) || sidecar.recoveryProof || archive.recoveryProof || null,
    runtimeRecovered: sidecar.runtimeRecovered === true || archive.runtimeRecovered === true,
    gateEvidence: sidecar.gateEvidence || archive.gateEvidence || null,
  };
}

function preferBoolean(existing, candidate) {
  if (candidate === true) return true;
  if (candidate === false) return existing;
  return existing;
}

export function mergeMeasurement(current, durable) {
  if (isMissing(durable)) return current;
  if (isMissing(current)) return durable;
  return {
    at: preferTruthy(current.at, durable.at) || current.at,
    solvesProblem: preferBoolean(current.solvesProblem, durable.solvesProblem),
    sideEffects: preferArray(current.sideEffects, durable.sideEffects),
    orphanResources: preferArray(current.orphanResources, durable.orphanResources),
    performanceChange: preferTruthy(current.performanceChange, durable.performanceChange) || current.performanceChange,
    errorChange: preferTruthy(current.errorChange, durable.errorChange) || current.errorChange,
    metrics: preferMetricObject(current.metrics, durable.metrics),
    beforeMetrics: preferMetricObject(current.beforeMetrics, durable.beforeMetrics),
    afterMetrics: preferMetricObject(current.afterMetrics, durable.afterMetrics),
    observationWindow: preferTruthy(current.observationWindow, durable.observationWindow) || current.observationWindow,
    sampleCount: preferTruthy(current.sampleCount, durable.sampleCount) ?? current.sampleCount,
    benefitEvidence: preferTruthy(current.benefitEvidence, durable.benefitEvidence) || current.benefitEvidence,
    repeatable: preferBoolean(current.repeatable, durable.repeatable),
    regressionPassed: preferBoolean(current.regressionPassed, durable.regressionPassed),
    reversible: preferBoolean(current.reversible, durable.reversible),
    cleanupEvidence: preferTruthy(current.cleanupEvidence, durable.cleanupEvidence) || current.cleanupEvidence,
    // Probe evidence is a structured sub-document, not one of the fixed scalar
    // fields above. It is only present when a probe pair exists, so a legacy
    // measurement keeps exactly the key set it had.
    ...(isObject(current.probe) || isObject(durable.probe) ? { probe: preferObject(current.probe, durable.probe) } : {}),
    // Same rule for the two fields the task-coupled measurement contributes: a
    // canary/restart merge must not drop the evidence the stable sidecar will
    // later describe. They stay absent on legacy measurements.
    ...(current.evidenceKind !== undefined || durable.evidenceKind !== undefined
      ? { evidenceKind: preferTruthy(current.evidenceKind, durable.evidenceKind) } : {}),
    ...(isObject(current.taskBenefit) || isObject(durable.taskBenefit)
      ? { taskBenefit: preferObject(current.taskBenefit, durable.taskBenefit) } : {}),
    // The marker that says the comparison above came from the kernel probe (and
    // therefore carries its measured cost budget) is authoritative evidence, not
    // a scalar measurement. A canary/restart merge that drops it makes the same
    // numbers read as a legacy zero-tolerance observation: an in-budget duration
    // becomes a regression, the advisory evaluator vetoes the promotion and the
    // promotion gates stop being eligible. Keep it present on both sides, and
    // absent on measurements that never had it.
    ...(current.probeDerived !== undefined || durable.probeDerived !== undefined
      ? { probeDerived: current.probeDerived === true || durable.probeDerived === true } : {}),
  };
}

export function evidenceSnapshotPath(archiveDir, experimentId) {
  return path.join(archiveDir, `${experimentId}${EVIDENCE_SNAPSHOT_SUFFIX}`);
}

export async function readEvidenceSnapshot(archiveDir, experimentId) {
  const file = evidenceSnapshotPath(archiveDir, experimentId);
  if (!await pathExists(file)) return null;
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The strict variant: only a missing file means "no snapshot".
 *
 * Readers that *merge* evidence may treat an unreadable sidecar as absent (the
 * evidence under it is unknown, not gone). A writer that is about to replace the
 * file may not: it would overwrite the only copy of a scene it never read. The
 * reclaim externalizer uses this one and aborts instead.
 */
async function readEvidenceSnapshotForExternalization(archiveDir, experimentId) {
  const file = evidenceSnapshotPath(archiveDir, experimentId);
  let text;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Evolution evidence sidecar is unreadable (${file}); refusing to overwrite it`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Evolution evidence sidecar is not valid JSON (${file}); refusing to overwrite it`);
  }
}

export async function persistEvidenceSnapshot(archiveDir, experimentId, payload) {
  const file = evidenceSnapshotPath(archiveDir, experimentId);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await writeAtomic(file, JSON.stringify(payload, null, 2) + "\n", { durable: true });
  return file;
}

export function snapshotEvidenceFromRecord(record) {
  return {
    version: 1,
    capturedAt: now(),
    latestObservation: record?.latestObservation || null,
    observations: Array.isArray(record?.observations) ? record.observations : [],
    cleanupProof: safeProofForPersistence(record?.cleanupProof),
    recoveryProof: safeProofForPersistence(record?.recoveryProof),
    runtimeRecovered: record?.runtimeRecovered === true,
    gateEvidence: record?.lastGateEvidence || null,
    promotionTimestamp: record?.durable?.promotionTimestamp || record?.promotedAt || null,
    // Cross-session metadata so hydration can restore identity and
    // lineage (pluginName / rowId / archive path / canary state) even
    // after the promotion journal is deleted on stable commit.
    durable: record?.durable || null,
    canary: record?.canary || null,
    ownerId: record?.ownerId || null,
    proposal: record?.proposal || null,
    // Cross-entry deployment approval and the stable-commit marker travel with
    // the durable evidence so a restart (including the crash window between the
    // stable journal phase and its cleanup) can publish the exact approved
    // scope without re-running the canary or inventing an approval.
    ...(Array.isArray(record?.shareTargets) && record.shareTargets.length > 0 ? { shareTargets: [...record.shareTargets] } : {}),
    ...(typeof record?.stableCommittedAt === "string" && record.stableCommittedAt !== "" ? { stableCommittedAt: record.stableCommittedAt } : {}),
    ...(normalizePublication(record?.publication ?? record?.durable?.publication) ? { publication: normalizePublication(record.publication ?? record.durable.publication) } : {}),
    ...(isObject(record?.decision) ? { decision: record.decision } : {}),
  };
}

export function hydrateRecordFromSnapshot(record, snapshot) {
  if (!snapshot) return record;
  if (snapshot.latestObservation) {
    record.latestObservation = mergeMeasurement(record.latestObservation || {}, snapshot.latestObservation);
  }
  if (Array.isArray(snapshot.observations) && snapshot.observations.length > 0) {
    record.observations = preferArray(record.observations, snapshot.observations);
  }
  if (snapshot.cleanupProof) {
    record.cleanupProof = preferObject(record.cleanupProof, snapshot.cleanupProof);
    if (snapshot.runtimeRecovered === true) record.runtimeRecovered = true;
  }
  if (snapshot.recoveryProof) {
    record.recoveryProof = preferObject(record.recoveryProof, snapshot.recoveryProof);
    if (snapshot.recoveryProof.status === "recovered") record.runtimeRecovered = true;
  }
  if (snapshot.gateEvidence) record.lastGateEvidence = snapshot.gateEvidence;
  if (snapshot.runtimeRecovered === true) record.runtimeRecovered = true;
  // Cross-session metadata hydration: identity and lineage fields are
  // restored from the durable snapshot when the in-memory record was
  // rebuilt without them. Missing fields stay missing; existing values
  // are never overwritten by null/empty.
  if (snapshot.durable && !record.durable) record.durable = snapshot.durable;
  if (snapshot.canary && !record.canary) record.canary = snapshot.canary;
  if (snapshot.ownerId && !record.ownerId) record.ownerId = snapshot.ownerId;
  if (snapshot.proposal && !record.proposal) record.proposal = snapshot.proposal;
  if (Array.isArray(snapshot.shareTargets) && snapshot.shareTargets.length > 0 && !Array.isArray(record.shareTargets)) {
    record.shareTargets = [...snapshot.shareTargets];
  }
  if (typeof snapshot.stableCommittedAt === "string" && snapshot.stableCommittedAt !== "" && !record.stableCommittedAt) {
    record.stableCommittedAt = snapshot.stableCommittedAt;
  }
  if (!normalizePublication(record.publication) && normalizePublication(snapshot.publication)) {
    record.publication = normalizePublication(snapshot.publication);
  }
  if (record.publication && record.durable && !record.durable.publication) {
    record.durable = { ...record.durable, publication: record.publication };
  }
  if (snapshot.decision && !record.decision) record.decision = snapshot.decision;
  return record;
}

function captureCurrentRecoveryProof(record) {
  const recovered = record?.runtimeRecovered === true;
  const cleanup = record?.cleanupProof || null;
  const baseline = record?.trialBaseline || record?.baseline;
  // Full factual proof capture: status is derived from the actual
  // dispose/recovery verification (stop/undefine/signature equality).
  // Fingerprints are the stable runtime signatures taken before the
  // Trial and after dispose; noOrphans reflects the measured
  // orphanResources; recoveryPending is false whenever the signature
  // equality check actually ran and passed. Nothing here is invented.
  // The result crosses the cleanup/recovery proof boundary before it is
  // stored: a proof is durable evidence (archive, sidecar, event bridge).
  return safeProofForPersistence({
    status: recovered ? "recovered" : (cleanup?.status || "unknown"),
    source: cleanup?.source || "disposeTrial",
    verificationSource: cleanup ? "disposeTrial:stop+undefine+signature" : null,
    capturedAt: cleanup?.at || now(),
    beforeFingerprint: baseline ? runtimeSignature(baseline) : null,
    afterFingerprint: record?.runtimeAfterDispose ? runtimeSignature(record.runtimeAfterDispose) : null,
    noOrphans: Array.isArray(record?.latestObservation?.orphanResources) ? record.latestObservation.orphanResources.length === 0 : (cleanup ? cleanup.errors?.length === 0 : null),
    recoveryPending: recovered ? false : null,
    runtimeRecovered: recovered,
    cleanupProof: cleanup,
  });
}

/**
 * Last-ditch evidence recovery: parse the human-readable `exp-*.md` archive
 * to extract the most recent Observations / Latest measurement / Runtime
 * recovery sections. This is used when neither the journal nor the
 * `*.evidence.json` sidecar is present (for example, the original
 * promotion was performed by a code path that did not yet persist the
 * evidence snapshot, but the archive itself is durable on disk).
 *
 * The parser is intentionally conservative: missing / unparseable sections
 * become `null` rather than fabricating evidence, so this function never
 * upgrades evidence; it can only recover what is already written.
 */
function parseArchiveMdEvidence(content) {
  if (typeof content !== "string" || content === "") return null;
  const extractJsonBlock = (labels) => {
    const list = Array.isArray(labels) ? labels : [labels];
    for (const label of list) {
      const re = new RegExp("## " + label + "[^\n]*\n```json\n([\\s\\S]*?)```", "i");
      const match = content.match(re);
      if (match) {
        try {
          return JSON.parse(match[1]);
        } catch (err) {
                    // fall through to the next label
        }
      } else {
              }
    }
    return null;
  };
  // Observations may have been written as either "## Observation" (singular,
  // pre-stable-commit format) or "## Observations" (plural, post-stable-commit
  // format). Accept both.
  const rawObservations = extractJsonBlock(["Observations", "Observation"]);
  const rawLatest = extractJsonBlock(["Latest measurement", "Latest Measurement", "Measurement"]);
  const extractProofLine = () => {
    const lines = content.split("\n");
    const idx = lines.findIndex((l) => l.startsWith("- proof: "));
    if (idx === -1) return null;
    try {
      return JSON.parse(lines[idx].slice("- proof: ".length).trim());
    } catch {
      return null;
    }
  };
  const extractRecoveredFlag = () => {
    const lines = content.split("\n");
    const idx = lines.findIndex((l) => l.startsWith("- recovered: "));
    if (idx === -1) return null;
    const v = lines[idx].slice("- recovered: ".length).trim();
    return v === "true";
  };
  const observations = rawObservations;
    // `## Observation` (singular) is the pre-stable-commit gate measurement;
  // treat it as a single-element observation array so the rest of the
  // monotonic merge logic sees the same shape as `## Observations`.
  const observationsArray = Array.isArray(observations)
    ? observations
    : (observations && typeof observations === "object" ? [observations] : []);
  const latestObservation = rawLatest
    || (Array.isArray(observationsArray) && observationsArray.length === 1 && typeof observationsArray[0] === "object" ? observationsArray[0] : null)
    || null;
  const proof = extractProofLine();
  const recovered = extractRecoveredFlag();
    if (!observations && !latestObservation && !proof && recovered === null) return null;
  return {
    version: 1,
    source: "archive-md",
    observations: observationsArray,
    latestObservation,
    recoveryProof: proof || null,
    runtimeRecovered: recovered === true,
    capturedAt: null,
  };
}

export async function readArchiveMdEvidence(archiveDir, experimentId) {
  if (!archiveDir || !experimentId) return null;
  const file = path.join(archiveDir, `${experimentId}.md`);
  if (!await pathExists(file)) return null;
  try {
    return parseArchiveMdEvidence(await fsp.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Best-effort recovery of the promotion identity (pluginName / rowId /
 * target) from a `exp-*.md` archive whose durable journal is gone. Used
 * only by the cross-session canary hydration path; everything else goes
 * through the journal or the sidecar.
 */
async function readPromotedIdentityFromArchive(archiveDir, experimentId) {
  if (!archiveDir || !experimentId) return null;
  const file = path.join(archiveDir, `${experimentId}.md`);
  if (!await pathExists(file)) return null;
  try {
    const content = await fsp.readFile(file, "utf8");
    const lines = content.split("\n");
    const findLine = (prefix) => {
      const line = lines.find((l) => l.startsWith(prefix));
      return line ? line.slice(prefix.length).trim() : null;
    };
    const pluginName = findLine("- durable plugin: ");
    const promoted = findLine("- promoted: ");
    const target = (() => {
      const line = lines.find((l) => l.startsWith("- target: "));
      return line ? line.slice("- target: ".length).trim() : null;
    })();
    if (!pluginName && !promoted && !target) return null;
    return {
      pluginName: pluginName || undefined,
      target: target || undefined,
      promotionTimestamp: promoted || undefined,
      archivePath: file,
    };
  } catch {
    return null;
  }
}

/**
 * Parse the stable, factual header metadata of a durable `exp-*.md`
 * archive (owner, created, proposal text, memory signature, duplicate
 * count). The event bridge does not carry these fields, so this reader
 * feeds the cross-session hydration / archive-replay path. Missing
 * fields stay missing — nothing is fabricated.
 */
export async function readArchiveMdMetadata(archiveDir, experimentId) {
  if (!archiveDir || !experimentId) return null;
  const file = path.join(archiveDir, `${experimentId}.md`);
  if (!await pathExists(file)) return null;
  try {
    const content = await fsp.readFile(file, "utf8");
    const lines = content.split("\n");
    const findLine = (prefix) => {
      const line = lines.find((l) => l.startsWith(prefix));
      return line ? line.slice(prefix.length).trim() : null;
    };
    const owner = findLine("- owner: ");
    const created = findLine("- created: ");
    const why = findLine("- why: ");
    const target = findLine("- target: ");
    const impact = findLine("- impact: ");
    const success = findLine("- success metrics: ");
    const pluginName = findLine("- durable plugin: ");
    const promoted = findLine("- promoted: ");
    const memorySignature = findLine("- signature: ");
    const duplicateLine = findLine("- duplicate count: ");
    if (!owner && !created && !why && !pluginName) return null;
    return {
      owner: owner || undefined,
      created: created || undefined,
      proposal: {
        why: why || "restored from durable archive",
        target: target || "unknown",
        impactScope: impact ? impact.split(", ").filter(Boolean) : [],
        successMetrics: success ? success.split("; ").filter(Boolean) : [],
        createdAt: created || null,
        owner: owner || "unknown",
      },
      memorySignature: memorySignature || undefined,
      duplicateCount: duplicateLine ? Number(duplicateLine) || null : null,
      durable: {
        pluginName: pluginName || undefined,
        promotionTimestamp: promoted || undefined,
      },
    };
  } catch {
    return null;
  }
}

// Keep only the current chunk and incomplete line, rather than the whole
// decoded log and split/filter arrays. Snapshot regular-file size just as
// readFile does, so an appending writer cannot extend this replay indefinitely.
async function visitEventBridgeLines(eventsPath, visit) {
  const visitWhole = (content) => {
    let start = 0;
    for (;;) {
      const end = content.indexOf("\n", start);
      visit(content.slice(start, end === -1 ? content.length : end));
      if (end === -1) break;
      start = end + 1;
    }
  };
  if (typeof eventsPath !== "string" && !Buffer.isBuffer(eventsPath) && !(eventsPath instanceof URL)) {
    // Preserve readFile's FileHandle support and invalid-input errors.
    visitWhole(await fsp.readFile(eventsPath, "utf8"));
    return;
  }
  // Special files retain the native path-based read (one open, including FIFO
  // rendezvous and platform-specific directory errors). Re-stat the opened
  // regular file below so this preflight does not define the replay size.
  let preflight;
  try { preflight = await fsp.stat(eventsPath); } catch { /* use native errors */ }
  if (!preflight?.isFile() || preflight.size > 0x7fffffff) {
    visitWhole(await fsp.readFile(eventsPath, "utf8"));
    return;
  }
  const file = await fsp.open(eventsPath, "r");
  let readError;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 0x7fffffff) {
      // Preserve native readFile behavior/errors for special files and sizes
      // it refuses, including the platform-specific directory error message.
      // The path changed after preflight: never reopen a different object.
      visitWhole(await file.readFile("utf8"));
      return;
    }
    let remaining = stat.isFile() && stat.size > 0 ? stat.size : Infinity;
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, remaining));
    const decoder = new StringDecoder("utf8");
    const fragments = [];
    let decodedLength = 0;
    const consume = (chunk) => {
      decodedLength += chunk.length;
      // readFile's whole UTF-8 string cannot exceed this runtime limit.
      if (decodedLength > bufferConstants.MAX_STRING_LENGTH) throw new RangeError("Invalid string length");
      let start = 0;
      for (;;) {
        const end = chunk.indexOf("\n", start);
        if (end === -1) {
          if (start < chunk.length) fragments.push(chunk.slice(start));
          break;
        }
        const line = chunk.slice(start, end);
        if (fragments.length) {
          fragments.push(line);
          visit(fragments.join(""));
          fragments.length = 0;
        } else visit(line);
        start = end + 1;
      }
    };
    while (remaining > 0) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, remaining), null);
      if (bytesRead === 0) break;
      remaining -= bytesRead;
      consume(decoder.write(buffer.subarray(0, bytesRead)));
    }
    consume(decoder.end());
    if (fragments.length) visit(fragments.join(""));
  } catch (error) {
    readError = error;
    throw error;
  } finally {
    try { await file.close(); } catch (closeError) {
      // Match readFile's aggregation: a close failure must not erase a read
      // failure, and the read error keeps its message/code and first position.
      if (readError && closeError && readError !== closeError) {
        if (Array.isArray(readError.errors)) {
          readError.errors.push(closeError);
          throw readError;
        }
        const combined = new AggregateError([readError, closeError], readError.message);
        combined.code = readError.code;
        throw combined;
      }
      throw closeError || readError;
    }
  }
}

/**
 * The projection rules that turn authenticated execution-bridge rows into the
 * durable evidence one experiment carries.
 *
 * This used to live inside `readEventBridgeEvidence`, which keeps one
 * experiment's accumulation state and returns the merge of its rows. A capacity
 * reclaim needs the same rules for every experiment at once: before it discards
 * an absorbed prefix of the log it has to externalize the facts that only those
 * rows carry. Sharing the accumulation is what keeps the two readers from
 * drifting - the reclaim and the hydration chain must agree on what a row means,
 * or the reclaim would discard evidence the reader still expects.
 *
 * The order of the checks is the released reader's order, and it is observable:
 * a row is authenticated, attributed to the trusted writer and admitted by the
 * per-writer sequence before its experiment is considered, so a row that belongs
 * to another experiment still advances the sequence and can therefore suppress a
 * later lower-sequence duplicate. `consume()` returns the routed row only after
 * those checks, so a caller can see which experiments a prefix mentions.
 */

export function createEventBridgeEvidenceIndex({ key, trustedWriters } = {}) {
  if (typeof key !== 'string' || key.length < 16) throw new TypeError('event bridge evidence key must be a string of at least 16 characters');
  const writers = trustedWriters instanceof Set ? trustedWriters : new Set(trustedWriters || []);
  const sequences = new Map();
  const states = new Map();
  const stateFor = (experimentId) => {
    let state = states.get(experimentId);
    if (!state) {
      state = { measurement: null, gates: null, promotion: null, canary: null, latestAt: null };
      states.set(experimentId, state);
    }
    return state;
  };
  /** Route one log line. Returns `{ experimentId, eventType }` when the line is
   *  this bridge's own authenticated record, `null` otherwise. */
  function consume(line) {
    if (!line.trim()) return null;
    let envelope;
    try { envelope = JSON.parse(line); } catch { return null; }
    const verified = verifyEventBridgeEnvelope(envelope, key);
    if (!verified) return null;
    const { event, writer, sequence } = verified;
    if (!eventBridgeWriterTrusted(verified, writer) || !writers.has(writer)) return null;
    const prior = sequences.get(writer) || 0;
    // Strictly increasing per-writer sequences already reject every replay.
    if (sequence <= prior) return null;
    sequences.set(writer, sequence);
    if (typeof event?.experimentId !== 'string' || event.experimentId === '' || typeof event?.eventType !== 'string') return null;
    const experimentId = event.experimentId;
    const state = stateFor(experimentId);
    state.latestAt = event.audit?.at || state.latestAt;
    if (event.eventType === 'measurement-completed' && isObject(event.measurement)) state.measurement = event.measurement;
    if (event.eventType === 'promotion-succeeded') {
      if (isObject(event.evidence)) state.gates = event.evidence;
      if (isObject(event.promotion)) state.promotion = event.promotion;
      if (isObject(event.measurement) && !state.measurement) state.measurement = event.measurement;
    }
    if (event.eventType === 'canary-passed' && isObject(event.canary)) state.canary = event.canary;
    return { experimentId, eventType: event.eventType };
  }
  /** The evidence object for one experiment, or `null` when its rows carry none. */
  function project(experimentId) {
    const state = states.get(experimentId);
    if (!state) return null;
    const { measurement, gates, promotion, canary, latestAt } = state;
    const canaryObservations = Array.isArray(canary?.observations) ? canary.observations : [];
    const observations = [];
    if (measurement) observations.push(measurement);
    for (const entry of canaryObservations) observations.push(entry);
    if (observations.length === 0 && !gates && !promotion) return null;
    const runtimeRecovered = gates?.runtimeRecovered === true;
    return {
      version: 1,
      source: 'event-bridge',
      capturedAt: latestAt || null,
      promotionTimestamp: promotion?.promotionTimestamp || null,
      observations,
      latestObservation: measurement || null,
      cleanupProof: null,
      recoveryProof: {
        status: runtimeRecovered ? 'recovered' : 'unknown',
        source: 'event-bridge:promotion-succeeded',
        verificationSource: 'event-bridge:gates.runtimeRecovered',
        capturedAt: promotion?.promotionTimestamp || latestAt || null,
        runtimeRecovered,
        gateEvidence: gates,
      },
      runtimeRecovered,
      gateEvidence: gates || null,
      durable: promotion
        ? {
            pluginName: promotion.pluginName,
            pluginPath: promotion.pluginPath,
            linkPath: promotion.linkPath,
            rowId: promotion.rowId,
            archivePath: promotion.archivePath,
            presetId: promotion.presetId,
            promotionTimestamp: promotion.promotionTimestamp,
            healthObservationWindow: promotion.healthObservationWindow,
          }
        : null,
      canary: canary
        ? {
            promotionTimestamp: canary.promotionTimestamp || promotion?.promotionTimestamp || null,
            healthObservationWindow: canary.healthObservationWindow || 2,
            startupVerified: canary.startupVerified === true,
            observations: canaryObservations,
          }
        : null,
    };
  }
  function experimentIds() {
    return [...states.keys()];
  }
  return { consume, project, experimentIds };
}

/**
 * Persisted Execution-event collector: replay the append-only event bridge
 * (`evolution-events.jsonl`) for one experiment and project the factual
 * evidence it carries — the full measurement, the promotion gate evidence,
 * the promotion metadata and the canary observations. This is the 4th
 * priority durable authority in the hydration chain and the ONLY surviving
 * source for older promotions whose journal/sidecar were never written.
 * Fields the bridge does not carry (cleanupProof internals, owner id)
 * stay missing; the recovery proof is derived strictly from the persisted
 * promotion gate result (gates.runtimeRecovered), never invented.
 */
export async function readEventBridgeEvidence(eventsPath, experimentId) {
  if (!eventsPath || !experimentId) return null;
  const options = arguments[2];
  // The row projection is shared with the capacity reclaim in `domain-storage.js`
  // (it calls `createEventBridgeEvidenceIndex` below) because a reclaim has to
  // apply the same rules to a whole discarded prefix before it may drop it; this
  // reader keeps its released drain/precedence behaviour and only asks that
  // shared index what the rows for one experiment mean.
  let index = null;
  let initialized = false;
  let key;
  let trustedWriters;
  let failed = false;
  let failure;
  const consume = (line) => {
    if (failed) return;
    try {
      // Option reads stay inside the drain: a getter that throws must not
      // outrank a filesystem failure that the drain itself is about to raise.
      if (!initialized) {
        initialized = true;
        key = options?.key || process.env.DSH_EVOLUTION_EVENT_BRIDGE_KEY;
        trustedWriters = new Set(options?.trustedWriters || [EVENT_BRIDGE_DEFAULT_WRITER]);
      }
      if (!index) {
        if (typeof key !== "string" || key.length < 16) return;
        index = createEventBridgeEvidenceIndex({ key, trustedWriters });
      }
      index.consume(line);
    } catch (error) {
      failed = true;
      failure = error;
    }
  };
  try {
    await visitEventBridgeLines(eventsPath, consume);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  // The old readFile completed before option/verification errors. Drain reads
  // before rethrowing those errors so filesystem failure precedence is retained.
  if (failed) throw failure;
  if (!index) return null;
  return index.project(experimentId);
}

/**
 * Write the evidence a discarded log prefix was the only carrier of.
 *
 * A reclaim may only drop bytes whose facts survive elsewhere, and the durable
 * home for bridge evidence is the per-experiment sidecar the promotion path
 * already writes (`persistEvidenceSnapshot`) - the same file the hydration chain
 * merges ahead of the bridge itself. Each entry is merged onto the existing
 * sidecar with the established monotonic rule, so an externalization can only
 * upgrade what is already durable, never downgrade a richer snapshot to what the
 * log happened to still carry. A sidecar the merge did not change is not
 * rewritten, so repeating a reclaim costs no fsyncs for evidence it already
 * externalized.
 */
export async function externalizeEventBridgeEvidence(paths, entries) {
  let written = 0;
  let skipped = 0;
  const files = [];
  for (const entry of entries || []) {
    const experimentId = entry?.experimentId;
    if (typeof experimentId !== "string" || experimentId === "" || !entry.evidence) { skipped += 1; continue; }
    // The identity becomes a file name inside the archive directory. A value that
    // is not one safe component is refused before anything is written: skipping it
    // would discard evidence the reclaim claims to have preserved, and writing it
    // would leave the archive directory.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(experimentId) || experimentId.includes("..")) {
      const error = new Error("E_DOMAIN_EVIDENCE_ID_UNSAFE: an experiment id in the discarded prefix is not a safe evidence file name, so the prefix cannot be externalized");
      error.code = "E_DOMAIN_EVIDENCE_ID_UNSAFE";
      throw error;
    }
    const existing = await readEvidenceSnapshotForExternalization(paths.archiveDir, experimentId);
    const merged = mergeEvidenceSources([existing, entry.evidence]);
    if (!merged) { skipped += 1; continue; }
    if (existing && JSON.stringify(existing) === JSON.stringify(merged)) { skipped += 1; continue; }
    files.push(await persistEvidenceSnapshot(paths.archiveDir, experimentId, merged));
    written += 1;
  }
  return { written, skipped, files: files.length };
}

/**
 * Monotonic evidence merge across every available durable source in the
 * hydration priority order (journal snapshot > sidecar > archive-md >
 * event bridge). Evidence can only stay or upgrade: empty arrays, null,
 * undefined, "" and unknown-status payloads never overwrite real values
 * from any source. Identity/metadata (durable, canary, ownerId, proposal)
 * takes the first non-null value in priority order.
 */
export function mergeEvidenceSources(sources) {
  const present = (sources || []).filter(Boolean);
  if (present.length === 0) return null;
  let observations = [];
  let latestObservation = null;
  let cleanupProof = null;
  let recoveryProof = null;
  let runtimeRecovered = false;
  // Sources are given in priority order (highest first). Each pass is
  // monotonic: preferX keeps the accumulated value when the candidate is
  // empty/missing/unknown, so evidence can only stay or upgrade no matter
  // the order. On field-level ties the earlier (higher-priority) source
  // wins; candidate-only fields are added as upgrades. This differs from
  // the generic preferObject/mergeMeasurement helpers (which let the
  // candidate win) so that cross-session hydration honours the documented
  // authority order: journal snapshot > sidecar > archive-md > event bridge.
  const preferPriority = (acc, candidate) => {
    if (isMissing(candidate) || isUnknownStatus(candidate)) return acc;
    if (isMissing(acc) || isUnknownStatus(acc)) return candidate;
    return { ...candidate, ...acc };
  };
  const mergeLatest = (acc, candidate) => {
    if (isMissing(candidate)) return acc;
    if (isMissing(acc)) return candidate;
    // The spread keeps the candidate's own enumerable string *and* symbol keys,
    // in position, exactly as the pre-fix copy did. Each merged key is then
    // redefined as an own data property instead of assigned: per-key assignment
    // sent an accumulated `__proto__` key to the prototype setter, which dropped
    // it and adopted the payload as the merged prototype. The `isMissing` read of
    // `candidate[key]` is the same plain read the old condition performed (an
    // inherited value keeps its pre-fix meaning); when it is missing too, nothing
    // is assigned, which is the no-op the old conditional assignment had.
    const merged = { ...candidate };
    for (const key of Object.keys(acc)) {
      if (isMissing(acc[key])) {
        if (isMissing(candidate[key])) continue;
        Object.defineProperty(merged, key, { value: candidate[key], enumerable: true, configurable: true, writable: true });
      } else {
        Object.defineProperty(merged, key, { value: acc[key], enumerable: true, configurable: true, writable: true });
      }
    }
    return merged;
  };
  for (const snapshot of present) {
    observations = preferArray(observations, snapshot.observations);
    latestObservation = mergeLatest(latestObservation, snapshot.latestObservation);
    cleanupProof = preferPriority(cleanupProof, snapshot.cleanupProof);
    recoveryProof = preferPriority(recoveryProof, snapshot.recoveryProof);
    runtimeRecovered = runtimeRecovered || snapshot.runtimeRecovered === true;
  }
  const merged = {
    version: 1,
    source: present.map((s) => s.source).filter(Boolean).join("+"),
    capturedAt: present.map((s) => s.capturedAt).filter(Boolean).sort().at(-1) || null,
    promotionTimestamp: present.map((s) => s.promotionTimestamp).filter(Boolean).sort().at(-1) || null,
    observations,
    latestObservation: latestObservation && Object.keys(latestObservation).length > 0 ? latestObservation : null,
    cleanupProof,
    recoveryProof,
    runtimeRecovered,
    gateEvidence: null,
  };
  for (const snapshot of present) {
    if (!merged.gateEvidence) merged.gateEvidence = snapshot.gateEvidence || null;
    if (!merged.durable && snapshot.durable) merged.durable = snapshot.durable;
    if (!merged.canary && snapshot.canary) merged.canary = snapshot.canary;
    if (!merged.ownerId && snapshot.ownerId) merged.ownerId = snapshot.ownerId;
    if (!merged.proposal && snapshot.proposal) merged.proposal = snapshot.proposal;
    if (!merged.stableCommittedAt && typeof snapshot.stableCommittedAt === "string" && snapshot.stableCommittedAt !== "") {
      merged.stableCommittedAt = snapshot.stableCommittedAt;
    }
    if (!Array.isArray(merged.shareTargets) && Array.isArray(snapshot.shareTargets) && snapshot.shareTargets.length > 0) {
      merged.shareTargets = [...snapshot.shareTargets];
    }
    if (!merged.publication && normalizePublication(snapshot.publication)) {
      merged.publication = normalizePublication(snapshot.publication);
    }
    // Conditional on purpose: a snapshot written before decisions existed must
    // serialize exactly as it did, and "no decision recorded" is not the same
    // fact as "the measurement was insufficient".
    if (!merged.decision && isObject(snapshot.decision)) merged.decision = snapshot.decision;
  }
  return merged;
}

/**
 * Union of two canary records: barriers merge by id, nothing is dropped, and a
 * verified startup stays verified.
 */
function mergeCanaryEvidence(current, incoming) {
  const base = isObject(current) ? current : null;
  const next = isObject(incoming) ? incoming : null;
  if (!base && !next) return null;
  const barriers = new Map();
  for (const barrier of [...(base?.observations || []), ...(next?.observations || [])]) {
    if (!isObject(barrier)) continue;
    const key = typeof barrier.barrierId === "string" ? barrier.barrierId : sha256(stableJson(barrier));
    barriers.set(key, { ...(barriers.get(key) || {}), ...barrier });
  }
  return {
    ...(base || {}),
    ...(next || {}),
    observations: [...barriers.values()],
    startupVerified: base?.startupVerified === true || next?.startupVerified === true,
  };
}

/**
 * A `committed-pending-cleanup` journal is the last durable copy of its canary
 * barriers: they live only there until the state directory is removed. Merge
 * them into the sidecar and the archive first; a failed write throws so the
 * caller keeps the journal (and its evidence) instead of deleting it.
 */
async function persistCommittedCanaryEvidence(journal, paths) {
  const pending = mergeCanaryEvidence(null, journal?.canary);
  if (!pending || pending.observations.length === 0) return null;
  const experimentId = journal?.experimentId;
  if (typeof experimentId !== "string" || experimentId === "") {
    throw new Error(`Evolution promotion journal ${journal?.stateDir} holds canary observations but no experiment id; journal preserved`);
  }
  if (!paths?.archiveDir) throw new Error("Evolution promotion canary evidence requires the archive directory; journal preserved");
  const journalSnapshot = isObject(journal.evidenceSnapshot) ? journal.evidenceSnapshot : null;
  const sidecar = await readEvidenceSnapshot(paths.archiveDir, experimentId);
  const canary = mergeCanaryEvidence(mergeCanaryEvidence(sidecar?.canary, journalSnapshot?.canary), pending);
  await replayExperimentEvidence(paths, experimentId, {
    sources: [
      // The journal's stable phase is the last durable copy of the commit
      // marker and the approved deployment scope: carry both into the sidecar
      // so startup reconciliation can publish the exact approved scope after a
      // crash between the stable phase write and the journal cleanup.
      ...(journalSnapshot ? [{
        ...journalSnapshot,
        canary,
        ...(typeof journal?.stableCommittedAt === "string" && journal.stableCommittedAt !== "" ? { stableCommittedAt: journal.stableCommittedAt } : {}),
        ...(Array.isArray(journal?.shareTargets) && journal.shareTargets.length > 0 ? { shareTargets: [...journal.shareTargets] } : {}),
        ...(normalizePublication(journal?.publication) ? { publication: normalizePublication(journal.publication) } : {}),
        // The promotion-time snapshot predates the committed durable identity,
        // so the journal's own durable record (with the verified publication
        // identity) is the only source for it in the committed crash window.
        ...(isObject(journal?.durable) ? { durable: journal.durable } : {}),
        // A `stable-committed` phase is only written after the canary window
        // completed and the benefit decision was assigned, and the snapshot
        // predates that assignment. Record the implied decision so replay keeps
        // a durable stable proof for reconciliation.
        ...(journal?.phase === "stable-committed"
          ? { decision: { version: 1, kind: "benefit", source: "stable-committed", at: journal.stableCommittedAt || now() } }
          : {}),
      }] : []),
      { source: "promotion-journal-canary", capturedAt: pending.promotionTimestamp || now(), canary },
    ],
  });
  return canary;
}

/**
 * Pure archive renderer shared by archive() and the archive-replay path.
 * Keeps the durable `exp-*.md` shape stable so both the memory path and
 * the replay path produce identical section semantics.
 */
export function renderExperimentArchive({ id, state, reason, proposal, pluginId, packageId, observations, latestMeasurement, recoveryProof, recovered, failure, memorySignature, duplicateCount, retention, canary, decision = null }) {
  // Read-back boundary: `recoveryProof` can come straight from an older durable
  // snapshot, so it crosses the same projection as a freshly captured one.
  const safeProof = safeProofForPersistence(recoveryProof);
  // Everything user-authored in this document crosses the credential boundary
  // here as well as where it was captured: this renderer is also the replay path,
  // so `proposal` and the observation blocks can come from an older durable
  // record written before the capture-side projection existed. See
  // `EVIDENCE_PROJECTION`: the bounds are lifted so a record carrying no
  // credential renders byte for byte as before (below `REDACTION_TEXT_BOUND`; a
  // larger single field is withheld by that bound either way). `canary` is not
  // projected here
  // because `observeCanary` already stores its `metrics`/`evidence` through
  // `compactValue` when the window is opened.
  const safeProposal = isObject(proposal) ? compactValue(proposal, EVIDENCE_PROJECTION) : {};
  return [
    `# Evolution experiment ${id}`,
    "",
    `- state: ${state}`,
    `- terminal reason: ${reason}`,
    `- owner: ${safeProposal.owner || "unknown"}`,
    `- created: ${safeProposal.createdAt || "unknown"}`,
    `- source package: ${pluginId || "none"}/${packageId || "none"}`,
    "",
    "## Proposal",
    `- why: ${safeProposal.why || ""}`,
    `- target: ${safeProposal.target || ""}`,
    `- impact: ${(safeProposal.impactScope || []).join(", ")}`,
    `- success metrics: ${(safeProposal.successMetrics || []).join("; ")}`,
    "",
    "## Observations",
    "```json",
    JSON.stringify(compactValue(observations, EVIDENCE_PROJECTION), null, 2),
    "```",
    "",
    "## Latest measurement",
    "```json",
    JSON.stringify(compactValue(latestMeasurement, EVIDENCE_PROJECTION), null, 2),
    "```",
    // Conditional on purpose: an archive written before decisions existed must
    // render byte for byte as it did, and a missing decision is not the same
    // claim as an unproven experiment.
    ...(isObject(decision) ? ["", "## Decision", "```json", JSON.stringify(safeDecisionForPersistence(decision), null, 2), "```"] : []),
    "",
    "## Runtime recovery",
    `- recovered: ${recovered}`,
    `- proof: ${JSON.stringify(safeProof || { status: recovered ? "recovered" : "unknown" })}`,
    ...(isObject(canary) && Array.isArray(canary.observations) && canary.observations.length > 0
      ? ["", "## Canary", "```json", JSON.stringify(canary, null, 2), "```"]
      : []),
    "",
    "## Failure learning",
    "```json",
    JSON.stringify(failure ? safeFailureForPersistence(failure) : { status: "none" }, null, 2),
    "```",
    "",
    "## Memory lifecycle",
    `- signature: ${memorySignature}`,
    `- duplicate count: ${duplicateCount}`,
    `- retention: bounded to ${retention} compact records`,
    "",
  ].join("\n");
}

/**
 * Formal archive-replay path (evidence persistence fix): rebuild the final
 * durable archive for an experiment from the surviving trusted sources
 * (sidecar, archive-md, event bridge) through the SAME monotonic merge and
 * the SAME renderer used by archive(). It never fabricates evidence and
 * never touches failure memory or the promotion journal — it only rewrites
 * the experiment's own `.md` and `*.evidence.json` sidecar, which is the
 * documented terminal artifact. Used to restore older legitimate
 * promotions whose archive was downgraded by the pre-fix code path.
 *
 * `sources` are extra durable sources, highest priority first; recovery uses
 * them to hand the journal's last copy of a canary window to this same path.
 */
export async function replayExperimentEvidence(paths, experimentId, { sources: extraSources = [] } = {}) {
  if (!paths?.archiveDir || !experimentId) throw new Error("replay requires archiveDir and experimentId");
  const sources = [
    ...(Array.isArray(extraSources) ? extraSources : []),
    await readEvidenceSnapshot(paths.archiveDir, experimentId),
    await readArchiveMdEvidence(paths.archiveDir, experimentId),
    await readEventBridgeEvidence(paths.eventBridgePath, experimentId, { key: paths.eventBridgeKey, trustedWriters: [paths.eventBridgeWriter || EVENT_BRIDGE_DEFAULT_WRITER] }),
  ];
  const merged = mergeEvidenceSources(sources);
  if (!merged) throw new Error(`no durable evidence exists for ${experimentId}`);
  const archiveMeta = await readArchiveMdMetadata(paths.archiveDir, experimentId);
  const identity = await readPromotedIdentityFromArchive(paths.archiveDir, experimentId);
  const durable = merged.durable || identity || archiveMeta?.durable || null;
  const proposal = merged.proposal || archiveMeta?.proposal || {
    owner: archiveMeta?.owner || "unknown",
    why: "restored",
    target: identity?.target || "unknown",
    impactScope: [],
    successMetrics: [],
    createdAt: archiveMeta?.created || null,
  };
  const record = {
    id: experimentId,
    state: "stable",
    ownerId: archiveMeta?.owner || null,
    proposal,
    durable,
    canary: merged.canary || null,
    runtimeRecovered: merged.runtimeRecovered === true,
    cleanupProof: merged.cleanupProof || null,
    recoveryProof: merged.recoveryProof || null,
    observations: merged.observations || [],
    latestObservation: merged.latestObservation || null,
    lastGateEvidence: merged.gateEvidence || null,
  };
  hydrateRecordFromSnapshot(record, merged);
  const recoveryProof = preferObject(merged.recoveryProof, record.recoveryProof) || merged.cleanupProof;
  const recovered = record.runtimeRecovered === true || merged.runtimeRecovered === true;
  const content = renderExperimentArchive({
    id: record.id,
    state: "stable",
    reason: "stable-commit",
    proposal: record.proposal,
    pluginId: "none",
    packageId: "none",
    observations: merged.observations || [],
    latestMeasurement: merged.latestObservation || {},
    recoveryProof,
    recovered,
    failure: null,
    memorySignature: archiveMeta?.memorySignature || null,
    duplicateCount: archiveMeta?.duplicateCount ?? 1,
    retention: 200,
    canary: record.canary || null,
    decision: record.decision || null,
  });
  const archivePath = path.join(paths.archiveDir, `${experimentId}.md`);
  await writeAtomic(archivePath, content, { durable: true });
  const sidecar = {
    version: 1,
    source: (merged.source || "replay") + "+replay",
    capturedAt: now(),
    promotionTimestamp: merged.promotionTimestamp || durable?.promotionTimestamp || null,
    latestObservation: record.latestObservation || null,
    observations: record.observations || [],
    cleanupProof: safeProofForPersistence(record.cleanupProof || null),
    recoveryProof: safeProofForPersistence(recoveryProof),
    runtimeRecovered: recovered,
    gateEvidence: record.lastGateEvidence || null,
    durable,
    canary: record.canary || null,
    ownerId: record.ownerId || null,
    proposal: record.proposal || null,
    // Stable-commit facts must survive this replay: they are the durable input
    // to cross-entry publication. Dropping them (or the verified publication
    // identity) makes startup reconciliation see no approved stable fact and
    // the journal is deleted right after this write.
    ...(typeof merged.stableCommittedAt === "string" && merged.stableCommittedAt !== "" ? { stableCommittedAt: merged.stableCommittedAt } : {}),
    ...(Array.isArray(merged.shareTargets) && merged.shareTargets.length > 0 ? { shareTargets: [...merged.shareTargets] } : {}),
    ...(normalizePublication(merged.publication) ? { publication: normalizePublication(merged.publication) } : {}),
    ...(isObject(record.decision) ? { decision: record.decision } : {}),
  };
  await persistEvidenceSnapshot(paths.archiveDir, experimentId, sidecar);
  return {
    experimentId,
    archivePath,
    sidecarPath: evidenceSnapshotPath(paths.archiveDir, experimentId),
    observations: sidecar.observations.length,
    recovered,
  };
}

/**
 * Promotion evidence gate: an improvement claim must carry before/after
 * metrics, the observation window, and a sample count, and at least one
 * recognized finite numeric metric must improve and none may regress.
 */
export function measuredEvidenceOf(observation) {
  // A task-coupled measurement is a paired real-session before/after, not a
  // probe aggregate. Its own validator already decided correctness and the
  // improvement direction, so the generic metric heuristic must not re-judge
  // the same numbers with a rule written for probe rows.
  if (observation?.evidenceKind === "task-coupled") return observation?.taskBenefit?.benefit === true;
  const nested = isObject(observation?.metrics) ? observation.metrics : {};
  const before = [observation?.beforeMetrics, nested.before, nested.beforeMetrics].filter((value) => value !== undefined);
  const after = [observation?.afterMetrics, nested.after, nested.afterMetrics].filter((value) => value !== undefined);
  if (!before.length || !after.length || [...before, ...after].some((value) => !isObject(value) || Object.keys(value).length === 0)) return false;
  const window = observation?.observationWindow;
  if (!(typeof window === "string" && window.trim() !== "") && !(typeof window === "number" && Number.isFinite(window) && window > 0)) return false;
  if (!Number.isInteger(Number(observation?.sampleCount)) || Number(observation.sampleCount) < 1) return false;
  // Only measure() can attach probeDerived/comparison; caller fields are not
  // copied. The paired workflow already evaluates correctness AND its explicit
  // execution-cost budget. Reapplying the legacy zero-regression numeric rule
  // here would reject permitted overhead even when quality demonstrably improves.
  if (observation.probeDerived === true && observation.probe?.comparison?.workload) return observation.probe.comparison.benefit === true;
  return measuredMetricBenefit(before, after);
}

// ---------------------------------------------------------------------------
// Task-coupled evidence
//
// The deterministic probe can replace one tool call with identical arguments.
// The path a model actually takes after a degraded result is usually a
// multi-step fallback (read -> run_code -> shell), and those steps are exactly
// the write/shell calls the probe safety policy refuses to replay. A workflow
// claim therefore needs evidence from real paired sessions: the same natural
// task and the same model, run once without the candidate and once with it.
//
// The artifact is produced out of band (the acceptance harness) and bound to the
// exact candidate Host source; the kernel validates its structure and internal
// consistency, then derives the observation from it. It cannot upgrade itself
// into a benefit: correctness must hold on every session, the candidate must be
// exercised, and the cost must move in the claimed direction without a material
// regression. Like revalidation evidence, this is operator-produced evidence:
// the channel is not an authorization boundary.
// ---------------------------------------------------------------------------

const IMPROVEMENT_FORMS = Object.freeze(["tool", "context-policy"]);
const TASK_BENEFIT_LIMITS = Object.freeze({ minSessions: 3, maxSessions: 10, maxTokens: 50_000_000, maxDurationMs: 86_400_000 });

/** Normalize the declared improvement form; absent keeps the historical tool form. */
export function normalizeImprovement(value) {
  if (value === undefined || value === null || value === "") return "tool";
  const form = String(value).trim().toLowerCase();
  if (!IMPROVEMENT_FORMS.includes(form)) {
    throw probeFailure("E_EVOLUTION_IMPROVEMENT", 'improvement must be "tool" or "context-policy"');
  }
  return form;
}

function taskSessionMetrics(raw, label, issues) {
  if (!isObject(raw)) {
    issues.push(`${label} must be an object`);
    return null;
  }
  const bounded = (key, max) => {
    const value = raw[key];
    if (!Number.isInteger(value) || value < 0 || value > max) {
      issues.push(`${label}.${key} must be a bounded non-negative integer`);
      return null;
    }
    return value;
  };
  const sessions = bounded("sessions", TASK_BENEFIT_LIMITS.maxSessions);
  const correct = bounded("correct", TASK_BENEFIT_LIMITS.maxSessions);
  const failures = bounded("failures", 1000);
  const turns = bounded("turns", 10_000);
  const toolCalls = bounded("toolCalls", 100_000);
  const tokens = bounded("tokens", TASK_BENEFIT_LIMITS.maxTokens);
  const durationMs = bounded("durationMs", TASK_BENEFIT_LIMITS.maxDurationMs);
  if ([sessions, correct, failures, turns, toolCalls, tokens, durationMs].some((value) => value === null)) return null;
  if (sessions < TASK_BENEFIT_LIMITS.minSessions) issues.push(`${label}.sessions must be at least ${TASK_BENEFIT_LIMITS.minSessions}`);
  if (correct > sessions) issues.push(`${label}.correct cannot exceed sessions`);
  return { sessions, correct, failures, turns, toolCalls, tokens, durationMs };
}

const TASK_SHA = /^[a-f0-9]{64}$/;

/**
 * Validate one task-coupled evidence artifact against this experiment.
 * Returns the normalized artifact and the derived verdict; the caller decides
 * whether an invalid artifact is an error (measure) or simply unproven (gate).
 */
export function validateTaskBenefit(raw, { hostSha256 = null, taskId = null, improvement = "tool", applicability = null } = {}) {
  const issues = [];
  if (!isObject(raw)) return { ok: false, issues: ["taskBenefit must be an object"], artifact: null, benefit: false };
  if (raw.schemaVersion !== 1) issues.push("taskBenefit.schemaVersion must be 1");
  if (raw.kind !== "paired-real-session") issues.push('taskBenefit.kind must be "paired-real-session"');
  if (raw.complete !== true) issues.push("taskBenefit.complete must be true; an incomplete run is unknown, not zero");
  if (typeof raw.candidateHostSha256 !== "string" || !TASK_SHA.test(raw.candidateHostSha256)) {
    issues.push("taskBenefit.candidateHostSha256 must be a lowercase sha256");
  } else if (hostSha256 !== null && raw.candidateHostSha256 !== hostSha256) {
    issues.push("taskBenefit.candidateHostSha256 does not match the Trial candidate source");
  }
  if (typeof raw.taskId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw.taskId)) {
    issues.push("taskBenefit.taskId is invalid");
  } else if (taskId !== null && raw.taskId !== taskId) {
    issues.push("taskBenefit.taskId does not match this desktop task");
  }
  const task = isObject(raw.task) ? raw.task : null;
  if (!task || typeof task.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(task.id)) issues.push("taskBenefit.task.id is invalid");
  for (const key of ["promptSha256", "expectSha256"]) {
    if (!task || typeof task[key] !== "string" || !TASK_SHA.test(task[key])) issues.push(`taskBenefit.task.${key} must be a lowercase sha256`);
  }
  if (typeof raw.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(raw.model)) issues.push("taskBenefit.model is invalid");
  const host = isObject(raw.host) ? raw.host : null;
  if (!host || typeof host.dsh !== "string" || host.dsh === "" || typeof host.cordis !== "string" || host.cordis === "") {
    issues.push("taskBenefit.host must carry the dsh and cordis versions the sessions ran on");
  } else if (applicability) {
    // Both versions identify the environment the sessions ran on. An unknown
    // version cannot bind evidence to this host, and a Cordis mismatch is a
    // different composition runtime, not a comparable one.
    if (applicability.dsh === "unknown" || applicability.cordis === "unknown") {
      issues.push("host applicability is unknown; real-session evidence cannot be bound to this host");
    } else if (host.dsh !== applicability.dsh || host.cordis !== applicability.cordis) {
      issues.push("taskBenefit.host does not match this host; evidence from another host is not comparable");
    }
  }
  const baseline = taskSessionMetrics(raw.baseline, "taskBenefit.baseline", issues);
  const candidate = taskSessionMetrics(raw.candidate, "taskBenefit.candidate", issues);
  const runs = isObject(raw.runs) ? raw.runs : null;
  if (!runs || !Number.isInteger(runs.baseline) || !Number.isInteger(runs.candidate) || runs.baseline !== runs.candidate) {
    issues.push("taskBenefit.runs must declare the same integer count for both sides");
  } else if (runs.baseline !== (baseline?.sessions ?? runs.baseline) || runs.candidate !== (candidate?.sessions ?? runs.candidate)) {
    // The harness must run the declared count; a mismatch means the artifact no
    // longer describes the run it claims.
    issues.push("taskBenefit.runs must equal the measured baseline and candidate sessions");
  }
  if (baseline && candidate && baseline.sessions !== candidate.sessions) issues.push("baseline and candidate must run the same number of sessions");
  const adoption = isObject(raw.adoption) ? raw.adoption : {};
  const sessionsUsingCandidate = Number.isInteger(adoption.sessionsUsingCandidate) ? adoption.sessionsUsingCandidate : 0;
  const sessionsExercised = Number.isInteger(adoption.sessionsExercised) ? adoption.sessionsExercised : 0;
  for (const [key, value] of [["sessionsUsingCandidate", sessionsUsingCandidate], ["sessionsExercised", sessionsExercised]]) {
    if (!Number.isInteger(adoption[key]) || value < 0 || (candidate && value > candidate.sessions)) {
      issues.push(`taskBenefit.adoption.${key} must be an integer between 0 and the candidate session count`);
    }
  }
  const correctBoth = Boolean(baseline && candidate && baseline.correct === baseline.sessions && candidate.correct === candidate.sessions);
  if (baseline && candidate && !correctBoth) issues.push("every session on both sides must answer the task correctly");
  const improved = Boolean(baseline && candidate && (candidate.turns < baseline.turns || candidate.toolCalls < baseline.toolCalls));
  // A completed, correctly bound run with a negative result is still a valid
  // measurement: it is recorded as unproven and rejected by the gate instead of
  // being turned into an error that leaves the Trial in flight. Only contract
  // violations make the artifact invalid.
  const verdictIssues = [];
  if (baseline && candidate && !improved) verdictIssues.push("the candidate side did not reduce turns or tool calls");
  const noRegression = Boolean(baseline && candidate
    && candidate.failures <= baseline.failures
    && candidate.tokens <= Math.max(baseline.tokens * 1.05, baseline.tokens + 2000)
    && candidate.durationMs <= Math.max(baseline.durationMs * 1.25, baseline.durationMs + 60_000));
  if (baseline && candidate && !noRegression) verdictIssues.push("the candidate side regressed failures, tokens or wall time beyond the budget");
  // A tool-form candidate exists only if the model chose it; a context-policy
  // component exists only if it actually transformed a step. A benefit whose
  // mechanism never ran is a difference between two unrelated runs.
  const mechanismRan = improvement === "context-policy" ? sessionsExercised >= 1 : sessionsUsingCandidate >= 1;
  if (!mechanismRan) verdictIssues.push(improvement === "context-policy"
    ? "the context policy never transformed a step; the difference is not attributable to it"
    : "the model never chose the candidate tool; its benefit is unproven");
  // Any contract violation keeps the verdict false: an artifact that is
  // internally inconsistent must not still reach the gate as a benefit.
  const benefit = issues.length === 0 && correctBoth && improved && noRegression && mechanismRan;
  // Binding checks above compare the *raw* values (the plan declared them).
  // Everything stored below crosses the credential boundary: a model slug or a
  // task id can be credentials-shaped, and this artifact reaches the measurement,
  // the promotion journal and the evidence sidecar. Project through the same
  // text rule every other durable string uses.
  // Redact the whole value first, then bound its length: truncating before
  // redaction can cut a credential below the minimum length its rule requires
  // (for example "sk-abcdefg" at a 60-char boundary), leaving a prefix that no
  // longer matches anything.
  const projected = (value, limit) => typeof value === "string"
    ? compactValue(value, { ...EVIDENCE_PROJECTION, maxText: limit }) : null;
  const artifact = {
    schemaVersion: 1,
    kind: "paired-real-session",
    complete: true,
    taskId: projected(raw.taskId, 128),
    task: {
      id: projected(task?.id, 120),
      promptSha256: projected(task?.promptSha256, 64),
      expectSha256: projected(task?.expectSha256, 64),
    },
    candidateHostSha256: projected(raw.candidateHostSha256, 64),
    model: projected(raw.model, 200),
    host: host ? { dsh: projected(host.dsh, 60), cordis: projected(host.cordis, 60) } : null,
    improvement,
    runs: { baseline: runs?.baseline ?? null, candidate: runs?.candidate ?? null },
    baseline,
    candidate,
    adoption: { sessionsUsingCandidate, sessionsExercised },
    correctness: { baseline: Boolean(baseline && baseline.correct === baseline.sessions), candidate: Boolean(candidate && candidate.correct === candidate.sessions) },
    improved,
    regression: !noRegression,
    mechanismRan,
    benefit,
    issues: [...issues, ...verdictIssues].slice(0, 12),
  };
  return { ok: issues.length === 0, issues, verdictIssues, artifact, benefit };
}

export function promotionGates(experiment, { requireRuntimeRecovery = true } = {}) {
  const observation = experiment.latestObservation;
  const metrics = observation?.metrics;
  const hasMetrics = isObject(metrics) && Object.keys(metrics).length > 0;
  const measuredEvidence = measuredEvidenceOf(observation);
  const realBenefit = observation?.solvesProblem === true && (
    measuredEvidence || hasMetrics || meaningfulChange(observation.performanceChange) || meaningfulChange(observation.errorChange) || typeof observation.benefitEvidence === "string" && observation.benefitEvidence.length > 0
  );
  const noOrphans = (observation?.orphanResources || []).length === 0;
  const gates = {
    realBenefit,
    measuredEvidence,
    repeatable: observation?.repeatable === true,
    regressionTest: observation?.regressionPassed === true,
    reversible: observation?.reversible === true,
    cleanupEvidence: typeof observation?.cleanupEvidence === "string" && observation.cleanupEvidence.trim().length > 0,
    noOrphans,
    runtimeRecovered: experiment.runtimeRecovered === true,
  };
  // A candidate that claims to fix an observed workflow failure must prove the
  // *workflow* improved. Capability samples that only exercise the new tool are
  // a self-test, so they cannot satisfy this gate. The requirement is opt-in
  // through the proposal's benefit model so existing capability experiments
  // keep their contract until they declare a workflow goal.
  // An explicit workflow probe is itself a workflow claim, whatever the caller
  // declared: without this, a paired workload plus `benefitModel.kind:
  // "capability"` could still promote on a single-tool substitution.
  const workflowRequired = experiment?.proposal?.benefitModel?.kind === "workflow"
    || observation?.probe?.comparison?.benefitKind === "workflow"
    || isObject(observation?.probe?.comparison?.workload);
  if (workflowRequired) {
    // Only a probe comparison can prove this. A caller-supplied evidenceKind is
    // metadata, never a gate credential.
    // A paired real-session artifact is the other admissible proof: it compares
    // the candidate against the path a real model actually takes, which a
    // deterministic probe cannot express when that path uses a shell fallback.
    gates.workflowBenefit = observation?.probe?.comparison?.benefitKind === "workflow"
      || observation?.taskBenefit?.benefit === true;
  }
  // A workflow claim must be proven against the model's actual execution path.
  // The probe can only replace one tool call with the same arguments; the real
  // fallback path (for example read -> run_code -> shell) is not probe-safe.
  // Every workflow proposal therefore needs a paired real-session artifact
  // bound to this candidate's source. A capability self-test cannot stand in.
  const taskRequired = experiment?.proposal?.improvement === "context-policy" || workflowRequired;
  if (taskRequired) gates.taskBenefit = observation?.taskBenefit?.benefit === true;
  const evidence = [gates.realBenefit, gates.measuredEvidence, gates.repeatable, gates.regressionTest, gates.reversible, gates.cleanupEvidence, gates.noOrphans];
  if (workflowRequired) evidence.push(gates.workflowBenefit);
  if (taskRequired) evidence.push(gates.taskBenefit);
  return { ...gates, eligible: evidence.every(Boolean) && (!requireRuntimeRecovery || gates.runtimeRecovered) };
}

/**
 * Shape a matured experiment record into the extracted Dockyard evaluator's
 * evidence contract. The evaluator is advisory in `promote()`; absent evidence
 * stays absent instead of being synthesized into a passing claim.
 */
export function domainEvaluationEvidence(experiment = {}) {
  const observation = experiment.latestObservation || {};
  const nested = isObject(observation.metrics) ? observation.metrics : {};
  const comparison = observation.probeDerived === true ? observation.probe?.comparison : null;
  // The explicit cost budget belongs to whichever measurement the kernel
  // accepted: a paired workflow comparison, or a task-coupled artifact that
  // already checked tokens and wall time. Without this, a task result that
  // saved a whole turn but spent 1ms more would pass the promotion gates and
  // then be vetoed by the advisory evaluator's zero-tolerance duration rule.
  const budgeted = (comparison?.benefit === true && comparison?.workload?.durationAcceptable === true)
    || (observation.taskBenefit?.benefit === true && observation.taskBenefit?.regression === false);
  const advisoryMetrics = (metrics) => {
    if (!budgeted || !isObject(metrics)) return metrics;
    // The authoritative workflow comparator already applies the explicit cost
    // budget. Keep raw durations in the observation/probe, but do not reinterpret
    // permitted overhead as a zero-tolerance advisory regression. Every other
    // metric and all unproven/over-budget/legacy evidence retain the old veto.
    // Tokens are a permitted cost dimension of the same accepted budget (+5%
    // or +2000 tokens); the evaluator's own token rule would otherwise veto a
    // result the task gate accepted. The raw values stay in the observation.
    const { durationMs, tokens, ...rest } = metrics;
    return rest;
  };
  return {
    beforeMetrics: advisoryMetrics(observation.beforeMetrics ?? nested.before ?? nested.beforeMetrics),
    afterMetrics: advisoryMetrics(observation.afterMetrics ?? nested.after ?? nested.afterMetrics),
    metrics: observation.metrics,
    goalResult: observation.solvesProblem === true ? true : null,
    regressionResult: observation.regressionPassed,
    currentVersion: experiment.durable?.rowId,
    historicalBestVersion: experiment.previousDurable?.rowId,
    benefitEvidence: observation.benefitEvidence,
  };
}

// ---------------------------------------------------------------------------
// Propose–Probe–Compose evidence
//
// The probe is executed here, through the official tool pipeline, not taken
// from the caller. `evolution_probe` records one fixed scenario in the
// `proposed` state (the baseline, before any Trial mutation) and re-runs the
// same scenario in the `trial` state (the candidate). Both executions produce
// raw per-call outcomes; `evolution_measure` derives the before/after metrics
// from those executions, so a caller cannot hand a favorable aggregate to the
// gate. Only one scenario is fixed at a time, and the candidate phase must
// reproduce the baseline scenario digest and applicability exactly.
// ---------------------------------------------------------------------------

const PROBE_LIMITS = Object.freeze({
  maxSteps: 8,
  maxRepetitions: 5,
  maxScenarioId: 120,
  maxArgumentsBytes: 2048,
  stepTimeoutMs: 30_000,
});
const PROBE_STEP_ROLES = new Set(["target", "control"]);
const INEFFECTIVE_CONCLUSIONS = new Set(["no-benefit", "regression"]);
/**
 * Tools that can never be probe steps, even when their definition claims
 * concurrency safety. `isConcurrencySafe` is a dispatch-overlap contract, not a
 * "finishes all work inline" contract: the real Desktop `subagent` definition
 * declares it while immediately returning an activation and continuing the
 * delegated work in the background (which can then run shell/write after the
 * probe released its runtime claim). Delegation, background jobs, scheduling,
 * profile mutation, UI/user interaction, session-transcript readers and
 * non-deterministic network tools are therefore excluded by their actual
 * registered names and prefixes, before any definition is trusted.
 */
const PROBE_FORBIDDEN_TOOLS = new Set([
  "run_code",
  "subagent",
  "subagent_fork",
  "interrupt_agent",
  "send_message",
  "workflow",
  "ralph",
  "create_goal",
  "update_goal",
  "get_goal",
  "exit_plan_mode",
  "plugin_manager",
  "ask_user_question",
  "present",
  "working_directory",
  "todo_write",
  "skill",
]);
const PROBE_FORBIDDEN_PREFIXES = Object.freeze([
  "evolution_",
  "job_",
  "schedule_",
  "list_",
  "subagent",
  "session_",
  "web_",
]);

function probeFailure(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function roundMetric(value) {
  return Math.round(value * 10_000) / 10_000;
}

/** The condition a conclusion applies to: an explicit triple, never a default. */
export function applicabilityFromVersions(versions = {}) {
  return {
    dsh: typeof versions.host === "string" && versions.host ? versions.host : "unknown",
    cordis: typeof versions.cordis === "string" && versions.cordis ? versions.cordis : "unknown",
    evolution: typeof versions.evolution === "string" && versions.evolution ? versions.evolution : "unknown",
  };
}

export function applicabilityKnown(applicability = {}) {
  return [applicability.dsh, applicability.cordis, applicability.evolution]
    .every((value) => typeof value === "string" && value !== "" && value !== "unknown");
}

/** Normalize one caller-declared scenario into the fixed shape a probe runs. */
export function normalizeProbeScenario(raw) {
  if (!isObject(raw)) throw probeFailure("E_EVOLUTION_PROBE_SCENARIO", "scenario must be an object");
  const rawId = text(raw.id, "scenario.id");
  if (rawId.length > PROBE_LIMITS.maxScenarioId) throw probeFailure("E_EVOLUTION_PROBE_SCENARIO", `scenario.id exceeds ${PROBE_LIMITS.maxScenarioId} characters`);
  // The id is echoed in the tool result, the persisted observation and the
  // decision, so it crosses the same credential/redaction boundary at capture
  // as every other durable string. It is also part of the scenario digest: a
  // redacted id is a redacted experiment identity, never the raw secret.
  const id = compactValue(rawId, EVIDENCE_PROJECTION);
  const workflow = raw.kind === "workflow";
  if (raw.kind !== undefined && !workflow) throw probeFailure("E_EVOLUTION_PROBE_SCENARIO", "unknown scenario kind");
  const rawSteps = raw.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) throw probeFailure("E_EVOLUTION_PROBE_SCENARIO", "scenario.steps must be a non-empty array");
  if (rawSteps.length > PROBE_LIMITS.maxSteps) throw probeFailure("E_EVOLUTION_PROBE_SCENARIO", `scenario.steps exceeds ${PROBE_LIMITS.maxSteps} steps`);
  const repetitions = raw.repetitions === undefined ? 2 : Number(raw.repetitions);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > PROBE_LIMITS.maxRepetitions) {
    throw probeFailure("E_EVOLUTION_PROBE_SCENARIO", `scenario.repetitions must be an integer between 1 and ${PROBE_LIMITS.maxRepetitions}`);
  }
  const steps = rawSteps.map((step, index) => {
    if (!isObject(step)) throw probeFailure("E_EVOLUTION_PROBE_SCENARIO", `scenario.steps[${index}] must be an object`);
    const name = text(step.name, `scenario.steps[${index}].name`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(name)) {
      throw probeFailure("E_EVOLUTION_PROBE_SCENARIO", `scenario.steps[${index}].name is not a valid tool name`);
    }
    const role = step.role === undefined ? "target" : String(step.role);
    if (!PROBE_STEP_ROLES.has(role)) throw probeFailure("E_EVOLUTION_PROBE_SCENARIO", `scenario.steps[${index}].role must be target or control`);
    // A capability the Trial is expected to add cannot be registered while the
    // baseline runs in `proposed` state. Declaring it here keeps one scenario
    // serving both phases: the baseline records a real "capability absent"
    // failure row instead of refusing the whole pair, and the candidate phase
    // must resolve (and prove concurrency-safe) the same declared step.
    if (step.absentInBaseline !== undefined && typeof step.absentInBaseline !== "boolean") {
      throw probeFailure("E_EVOLUTION_PROBE_SCENARIO", `scenario.steps[${index}].absentInBaseline must be a boolean`);
    }
    let argumentsJson = "{}";
    if (step.arguments !== undefined) {
      if (!isObject(step.arguments)) throw probeFailure("E_EVOLUTION_PROBE_SCENARIO", `scenario.steps[${index}].arguments must be an object`);
      argumentsJson = JSON.stringify(step.arguments);
      if (argumentsJson.length > PROBE_LIMITS.maxArgumentsBytes) {
        throw probeFailure("E_EVOLUTION_PROBE_SCENARIO", `scenario.steps[${index}].arguments exceed ${PROBE_LIMITS.maxArgumentsBytes} bytes`);
      }
    }
    let workload = {};
    if (workflow) {
      if (step.absentInBaseline === true) throw probeFailure("E_EVOLUTION_PROBE_SCENARIO", "workflow baseline must execute an installed tool");
      const candidateName = step.candidateName ?? name;
      if (typeof candidateName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(candidateName)) throw probeFailure("E_EVOLUTION_PROBE_SCENARIO", "invalid candidateName");
      if (role === "control" && candidateName !== name) throw probeFailure("E_EVOLUTION_PROBE_SCENARIO", "workflow controls must keep the installed baseline path");
      const expectedValue = Object.hasOwn(step, "expected") ? probeLosslessSnapshot(step.expected) : { ok: false };
      if (!expectedValue.ok || !isObject(step.arguments)
        || JSON.stringify(expectedValue.snapshot) === undefined || JSON.stringify(expectedValue.snapshot).length > 16384) throw probeFailure("E_EVOLUTION_PROBE_SCENARIO", "workflow requires bounded, lossless expected JSON and explicit arguments");
      const rawPath = step.resultPath ?? [];
      if (!Array.isArray(rawPath) || rawPath.length > 8) throw probeFailure("E_EVOLUTION_PROBE_SCENARIO", "invalid workflow resultPath");
      // Copy by own index into a plain array: the scenario digest and the
      // runtime path walk must read the same ordinary values, not a proxy's
      // iterator that can disagree with indexed access.
      let resultPath;
      try {
        resultPath = Array.from({ length: rawPath.length }, (_, index) => Object.getOwnPropertyDescriptor(rawPath, index)?.value);
      } catch {
        throw probeFailure("E_EVOLUTION_PROBE_SCENARIO", "invalid workflow resultPath");
      }
      if (resultPath.some((key) => typeof key !== "string" || key.length > 100)) throw probeFailure("E_EVOLUTION_PROBE_SCENARIO", "invalid workflow resultPath");
      workload = { candidateName, resultPath, expectedDigest: `sha256:${sha256(stableJson(expectedValue.snapshot))}` };
    }
    return { name, role, arguments: argumentsJson, ...(step.absentInBaseline === true ? { absentInBaseline: true } : {}), ...workload };
  });
  return {
    id,
    description: typeof raw.description === "string" ? compactValue(raw.description, EVIDENCE_PROJECTION) : "",
    repetitions,
    steps,
    ...(workflow ? { kind: "workflow" } : {}),
  };
}

/** One scenario + one applicability triple: both phases must reproduce it. */
export function probeScenarioDigest(scenario, applicability) {
  return `sha256:${sha256(stableJson({
    scenario: {
      id: scenario.id,
      ...(scenario.kind === "workflow" ? { kind: "workflow" } : {}),
      repetitions: scenario.repetitions,
      // The absence declaration is part of the paired-experiment identity; it is
      // appended only when set so scenarios written before this field keep the
      // same digest.
      steps: scenario.steps.map((step) => [step.name, step.role, step.arguments, ...(step.absentInBaseline === true ? [true] : []), ...(scenario.kind === "workflow" ? [step.candidateName, step.resultPath, step.expectedDigest] : [])]),
    },
    applicability: applicabilityFromVersions({ host: applicability.dsh, cordis: applicability.cordis, evolution: applicability.evolution }),
  }))}`;
}

/** The one classification a PTC transport failure shares across probe rows. */
const PROBE_TRANSPORT_ERROR_CODE = "E_EVOLUTION_PROBE_TRANSPORT";
// Codes that mean the tool was never measured, whether they came from a local
// throw or from an official result row. They must never become a benefit or a
// regression verdict.
const UNMEASURED_PROBE_CODES = new Set([
  "E_EVOLUTION_PROBE_TIMEOUT", "PROBE_NO_RESULT", "TOOL_TIMEOUT", "ABORTED", "ABORTED_BEFORE_DISPATCH",
]);

/** A bounded identifier-shaped code, or null when the host supplied something else. */
function probeIdentifier(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(text) ? text : null;
}

function probeResultRow(update, step, callId) {
  const results = Array.isArray(update?.results) ? update.results : [];
  // Match the official batch row by its call id. Taking `results[0]` could
  // credit an unrelated concurrent call's result to this step, and an empty
  // batch fell back to the bare update (often `{}`), which looked like a
  // successful measurement of a value that was never returned. Both made an
  // unmeasured candidate look like a benefit.
  const matched = callId ? results.find((row) => row?.callId === callId) : undefined;
  // A single unnamed row is the legacy/simplified-pipeline shape: there is no
  // ambiguity about which call it belongs to. More than one unnamed row must
  // not be guessed at.
  const settled = matched ?? (callId && results.length === 1 && results[0]?.callId === undefined ? results[0] : callId ? undefined : results[0]);
  if (!settled) return { isError: true, code: "PROBE_NO_RESULT", valueDigest: null };
  // A row matched by call id must carry the tool result. Falling back to the
  // row object (which only has routing metadata) would record a successful
  // measurement of a value the tool never returned. Only an unnamed legacy
  // inline row may still be read as the result itself.
  const hasResult = Object.hasOwn(settled, "result");
  if (matched && !hasResult) return { isError: true, code: "PROBE_NO_RESULT", valueDigest: null };
  const result = hasResult ? settled.result : (settled.callId === undefined && typeof settled === "object" ? settled : null);
  // An empty object is not a tool outcome. Without an explicit result field it
  // would be counted as a successful measurement of a value that was never
  // produced. A value-less success ({ isError: false }) is still valid.
  // Only an explicit tool outcome is a measurement: a boolean `isError` (with
  // or without a value), or a legacy value-only result. A bare error object,
  // an empty results batch, or an undefined isError is no result at all.
  const hasOutcome = isObject(result) && (
    (Object.hasOwn(result, "isError") && typeof result.isError === "boolean")
    || (!Object.hasOwn(result, "isError") && Object.hasOwn(result, "value") && !Object.hasOwn(result, "error"))
  );
  if (!hasOutcome) return { isError: true, code: "PROBE_NO_RESULT", valueDigest: null };
  if (result.isError !== true) {
    const valueDescriptor = Object.getOwnPropertyDescriptor(result, "value");
    const valueAccessible = valueDescriptor && !valueDescriptor.get && !valueDescriptor.set;
    const value = valueAccessible ? valueDescriptor.value : undefined;
    // Result projection is untrusted input: a descriptor snapshot can throw on a
    // hostile object. Keep that failure inside this row as an unmeasurable cost
    // instead of letting it escape as a generic probe execution failure.
    let whole;
    let cost;
    try {
      whole = probeLosslessSnapshot(value);
      cost = whole.ok ? { bytes: Buffer.byteLength(JSON.stringify(whole.snapshot) ?? ""), unmeasurable: false }
        : { bytes: null, unmeasurable: true };
    } catch {
      whole = { ok: false };
      cost = { bytes: null, unmeasurable: true };
    }
    if (step?.expectedDigest) {
      // Walk resultPath on the already captured snapshot, not on the raw tool
      // result. Otherwise a hostile proxy can answer the path read and the byte
      // count differently, billing one value while proving another.
      if (!whole.ok) {
        return { isError: true, code: "PROBE_VALUE_NOT_LOSSLESS", valueDigest: null,
          outputBytes: null, outputUnmeasurable: true, transportSucceeded: true };
      }
      let selected = whole.snapshot;
      for (const key of step.resultPath) {
        if (selected === null || typeof selected !== "object") { selected = undefined; break; }
        selected = Object.hasOwn(selected, key) ? selected[key] : undefined;
      }
      const observed = selected === undefined ? { ok: true, snapshot: undefined } : probeLosslessSnapshot(selected);
      if (!observed.ok) {
        return { isError: true, code: "PROBE_VALUE_NOT_LOSSLESS", valueDigest: null,
          outputBytes: cost.bytes, outputUnmeasurable: cost.unmeasurable, transportSucceeded: true };
      }
      const valueDigest = observed.snapshot === undefined ? null : `sha256:${sha256(stableJson(observed.snapshot))}`;
      const correct = valueDigest === step.expectedDigest;
      return { isError: !correct, code: correct ? null : "E_EVOLUTION_PROBE_INCORRECT", valueDigest,
        outputBytes: cost.bytes, outputUnmeasurable: cost.unmeasurable, transportSucceeded: true };
    }
    return { isError: false, code: null, valueDigest: value === undefined ? null : `sha256:${sha256(stableJson(whole.ok ? whole.snapshot : value))}`,
      outputBytes: cost.bytes, outputUnmeasurable: cost.unmeasurable };
  }
  const error = isObject(result.error) ? result.error : {};
  const info = isObject(error.info) ? error.info : {};
  let rawCode;
  try {
    rawCode = String(info.code ?? error.code ?? result.code ?? "").trim();
  } catch {
    rawCode = "";
  }
  // The error object is host/pipeline data. Only a bounded identifier-shaped
  // code is stored; anything else is the generic classification, so a hostile
  // or unexpected error object cannot carry an arbitrary string into the
  // durable probe evidence.
  const code = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(rawCode) ? rawCode : "TOOL_ERROR";
  // A PTC transport row keeps the uniform probe classification in `code` and the
  // host's own code here, so callers can always recognize a transport failure
  // without losing the diagnostic identity.
  const transportCode = probeIdentifier(info.transportCode);
  // A PTC execution that was cancelled or timed out before it produced a tool
  // outcome did not measure the tool. The existing error code is preserved, but
  // the independent marker keeps the comparison from reading it as a baseline
  // failure (or a candidate regression) that the other side improved on.
  // The direct pipeline reports cancellation/timeout as a result row rather
  // than throwing. Without this, a timed-out baseline could be "fixed" by a
  // successful candidate, or a timed-out candidate written as a permanent
  // regression conclusion.
  const unmeasured = info.unmeasured === true || UNMEASURED_PROBE_CODES.has(code);
  return { isError: true, code, valueDigest: null,
    ...(transportCode ? { transportCode } : {}),
    ...(unmeasured ? { unmeasured: true } : {}),
    ...(step?.expectedDigest ? { outputBytes: Buffer.byteLength(JSON.stringify(result) ?? ""), transportSucceeded: false } : {}) };
}

/** The settled row of a single-call batch, or undefined when the pipeline returned none. */
function probeSettledRow(batch, callId) {
  const results = Array.isArray(batch?.results) ? batch.results : [];
  return results.find((row) => row?.callId === callId);
}

/**
 * The program a probe step runs under a PTC preset.
 *
 * The wrapper marks its own envelope with the shared sentinel, and its arguments
 * travel as JSON text parsed inside the program. Writing the arguments as an
 * object literal would hand an own `__proto__` key to the prototype setter, so
 * the probe would measure different arguments than the direct pipeline would
 * have dispatched.
 */
function probePtcProgram(step) {
  const argumentsJson = step.arguments || "{}";
  const binding = JSON.stringify(step.name);
  return [
    // Preparation happens before the tool-call try: an unparsable argument or a
    // missing SDK binding never reached the tool body, so it must fail the
    // program (transport failure) instead of being recorded as a tool outcome.
    `const args = JSON.parse(${JSON.stringify(argumentsJson)});`,
    `if (typeof tools[${binding}] !== "function") throw new Error("probe step binding is unavailable");`,
    "let value;",
    "try {",
    `  value = await tools[${binding}](args);`,
    "} catch {",
    // A thrown binding only proves the call was attempted. The program-facing
    // ToolCallError hides whether the tool body ran, so this marks a diagnostic
    // failure only; the host records it as unmeasured and it cannot become a
    // benefit. The original error text cannot ride the run_code value either.
    `  return { ${JSON.stringify(PTC_WRAPPED_VALUE)}: true, ok: false };`,
    "}",
    `return { ${JSON.stringify(PTC_WRAPPED_VALUE)}: true, ok: true, value };`,
  ].join("\n");
}

/** One probe row for a transport failure: uniform code plus the host's own code. */
function probeTransportResult(callId, transportCode, message) {
  return { results: [{ callId, result: { isError: true, error: {
    message,
    info: { code: PROBE_TRANSPORT_ERROR_CODE, ...(transportCode ? { transportCode } : {}) },
  } } }] };
}

/**
 * Run one probe step through the official PTC transport.
 *
 * Under a PTC preset the executor refuses a direct `tools.execute` call for any
 * tool other than `run_code`. That refusal happens before policy and before the
 * tool body, so the same step can be re-issued inside a `run_code` program
 * where the SDK exposes the same registered tools. A thrown binding is recorded
 * with its diagnostic code (`E_EVOLUTION_PROBE_TOOL_ERROR`) but marked
 * unmeasured, because the program-facing error cannot prove the tool body ran;
 * a transport failure (program exception, runtime death, malformed envelope) is
 * reported as an error row and can never be mistaken for a successful step.
 */
async function executeProbeStepThroughPtc({ tools, agent, signal, step, callId }) {
  const batch = await tools.execute({
    agent,
    signal,
    calls: [{
      type: "tool_call",
      id: callId,
      name: "run_code",
      arguments: JSON.stringify({
        code: probePtcProgram(step),
        description: `evolution probe step: ${step.name}`.slice(0, 200),
      }),
    }],
  });
  const result = probeSettledRow(batch, callId)?.result;
  if (!isObject(result)) {
    return probeTransportResult(callId, "NO_RESULT", "the run_code transport returned no result for the probe step");
  }
  if (result.isError === true) {
    const info = isObject(result.error?.info) ? result.error.info : {};
    const hostCode = probeIdentifier(info.code);
    // Cancellation keeps the existing classification: only a failure that is
    // not the caller's abort is a transport failure.
    if (hostCode === "ABORTED" || hostCode === "ABORTED_BEFORE_DISPATCH") {
      return { results: [{ callId, result: { isError: true, error: {
        message: "the probe step was aborted before it measured the tool",
        info: { code: hostCode, transportCode: hostCode, unmeasured: true },
      } } }] };
    }
    return probeTransportResult(callId, hostCode || "UNKNOWN", "the run_code transport failed for the probe step");
  }
  const wrapped = ptcWrappedEnvelope(result.value);
  if (wrapped === null || wrapped[PTC_WRAPPED_VALUE] !== true || typeof wrapped.ok !== "boolean") {
    return probeTransportResult(callId, "MALFORMED_ENVELOPE", "the run_code transport returned no wrapped probe result");
  }
  if (wrapped.ok === true) {
    return { results: [{ callId, result: {
      isError: false,
      ...(Object.hasOwn(wrapped, "value") ? { value: wrapped.value } : {}),
    } }] };
  }
  // The program-facing ToolCallError does not prove the tool body ran: the
  // official SDK throws for argument validation and policy refusal too, and it
  // deliberately hides their internal classification. A thrown binding is
  // therefore recorded as a tool error for diagnostics but marked unmeasured, so
  // it can never become the baseline failure a later candidate success improves
  // on. Values that really ran and mismatched stay measured through the digest.
  return { results: [{ callId, result: {
    isError: true,
    error: {
      message: "the probe step failed inside run_code",
      info: { code: "E_EVOLUTION_PROBE_TOOL_ERROR", unmeasured: true },
    },
  } }] };
}

/**
 * Run one declared scenario through the official tool pipeline. Only a bounded
 * row per call is kept (tool name, role, isError, classified code, a digest of
 * the returned value); the value itself never enters the record, so a scenario
 * cannot use the probe to copy a file or a credential into the archive.
 */
async function executeProbeScenario({ tools, agent, signal, scenario, phase, stepTimeoutMs, absent = [] }) {
  if (typeof tools?.execute !== "function") {
    throw probeFailure("E_EVOLUTION_PROBE_UNAVAILABLE", "the official tool pipeline is not available in this runtime");
  }
  const timeoutMs = Number.isFinite(stepTimeoutMs) && stepTimeoutMs > 0 ? stepTimeoutMs : PROBE_LIMITS.stepTimeoutMs;
  // Declared-absent positions are the only steps a baseline may skip. They are
  // recorded as a normal error row (the capability really is not installed), so
  // the paired comparison still comes from raw executions instead of a claim.
  const absentPositions = new Set(Array.isArray(absent) ? absent : []);
  const outer = new AbortController();
  const abortOuter = () => outer.abort();
  if (signal?.aborted) outer.abort();
  else signal?.addEventListener?.("abort", abortOuter, { once: true });
  const samples = [];
  try {
    for (let repetition = 0; repetition < scenario.repetitions; repetition += 1) {
      for (let index = 0; index < scenario.steps.length; index += 1) {
        if (outer.signal.aborted) throw probeFailure("E_EVOLUTION_PROBE_ABORTED", "the probe was aborted before all steps ran");
        const step = scenario.steps[index];
        if (phase === "baseline" && absentPositions.has(index)) {
          samples.push({
            repetition,
            index,
            step: step.name,
            role: step.role,
            isError: true,
            code: "E_EVOLUTION_PROBE_CAPABILITY_ABSENT",
            valueDigest: null,
            durationMs: 0,
          });
          continue;
        }
        const callId = `probe-${crypto.randomUUID()}`;
        const startedAt = Date.now();
        const stepController = new AbortController();
        const abortStep = () => stepController.abort();
        outer.signal.addEventListener("abort", abortStep, { once: true });
        let row;
        let timer;
        let pending = null;
        let timedOut = false;
        // Which official route actually carried this step. A PTC preset refuses
        // the direct pipeline call and the step runs inside run_code; the marker
        // is part of the durable sample so the acceptance can tell the two apart.
        let transport = "direct";
        try {
          pending = Promise.resolve().then(() => withVerificationCall(agent, callId, async () => {
            const batch = await tools.execute({
              agent,
              signal: stepController.signal,
              calls: [{ type: "tool_call", id: callId, name: step.name, arguments: step.arguments }],
            });
            // The refusal is returned before policy and before the tool body, so
            // re-issuing the identical call through run_code cannot duplicate an
            // effect. "run_code" itself is never a probe step (safety preflight).
            if (step.name !== "run_code" && ptcDirectCallRefusal(probeSettledRow(batch, callId)?.result, step.name) !== null) {
              transport = "run_code";
              return executeProbeStepThroughPtc({ tools, agent, signal: stepController.signal, step, callId });
            }
            return batch;
          }));
          const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              // Cancel the official call, not just the local wait: the earlier
              // implementation left the call running after the probe moved on,
              // so it could still act inside the Trial or during cleanup.
              stepController.abort();
              reject(probeFailure("E_EVOLUTION_PROBE_TIMEOUT", `probe step ${step.name} exceeded ${timeoutMs} ms`));
            }, timeoutMs);
          });
          row = probeResultRow(await Promise.race([pending, timeout]), step, callId);
        } catch (error) {
          stepController.abort();
          if (pending) {
            // A probe row is only evidence once the call it describes is over.
            // Wait for the aborted call to settle; if the pipeline ignores the
            // signal, fail the probe instead of continuing next to a live call.
            // The settle wait must keep the event loop alive: an unref'd timer
            // here let Node 22 resolve the loop while this promise was still
            // pending, cancelling the whole test file. The timer is cleared as
            // soon as the call settles, so a normal abort does not pay for it.
            const settled = await new Promise((resolve) => {
              const timer = setTimeout(() => resolve(false), Math.max(timeoutMs, 1000));
              pending.then(() => { clearTimeout(timer); resolve(true); }, () => { clearTimeout(timer); resolve(true); });
            });
            if (!settled) {
              // The call is still running after its abort. It may still act on
              // the runtime, so the probe must not silently hand the runtime
              // back: the operation claim stays held until the call actually
              // settles, and conflicting lifecycle operations are refused until
              // then.
              const stuck = probeFailure("E_EVOLUTION_PROBE_ABORT_STUCK", `the timed-out probe step ${step.name} did not settle after abort`);
              stuck.holdProbeClaim = true;
              stuck.settlePromise = pending.then(() => undefined, () => undefined);
              throw stuck;
            }
          }
          const detail = safeErrorDto(error, "probe");
          // An abort keeps its existing classification. Any other failure of a
          // step that had to use the run_code transport is a transport failure,
          // even when `tools.execute` throws instead of returning a result, so
          // callers always see E_EVOLUTION_PROBE_TRANSPORT for that route.
          const aborted = outer.signal.aborted || detail.errorCode === "ABORTED";
          const transportCode = transport === "run_code" && !timedOut && !aborted
            ? (probeIdentifier(detail.errorCode) || "EXECUTION_FAILED") : null;
          // A cancelled or timed-out step did not measure the tool on either
          // route, even though its own timeout/cancellation code is preserved.
          // Marking only PTC executions let a direct timeout be read as a real
          // tool failure: a baseline that timed out could be reported as a
          // candidate benefit, or a candidate timeout as a permanent regression.
          const unmeasured = timedOut || aborted;
          row = {
            isError: true,
            code: timedOut ? "E_EVOLUTION_PROBE_TIMEOUT"
              : transportCode !== null ? PROBE_TRANSPORT_ERROR_CODE
              : (detail.errorCode || "PROBE_EXECUTION_FAILED"),
            valueDigest: null,
            ...(transportCode !== null ? { transportCode } : {}),
            ...(unmeasured ? { unmeasured: true } : {}),
          };
        } finally {
          if (timer) clearTimeout(timer);
          outer.signal.removeEventListener?.("abort", abortStep);
        }
        samples.push({ repetition, index, step: step.name, role: step.role, ...row, transport, durationMs: Date.now() - startedAt, ...(step.expectedDigest ? { expectedDigest: step.expectedDigest } : {}) });
      }
    }
  } finally {
    signal?.removeEventListener?.("abort", abortOuter);
    outer.abort();
  }
  return { at: now(), samples, summary: probeSummary({ samples }) };
}

/** Aggregate one phase of raw probe rows without letting the caller do it. */
export function probeSummary(run = {}) {
  const samples = Array.isArray(run.samples) ? run.samples : [];
  const steps = new Map();
  // Which official route carried each execution. A PTC preset refuses the direct
  // pipeline call, so a workload that claims to have run on that host must show
  // `run_code` here; a silent fall back to the native path is visible instead of
  // being inferred from timings. Counts stay bounded (two integers per phase).
  const transports = { direct: 0, run_code: 0 };
  let transportFailed = false;
  let unmeasured = false;
  let outputUnmeasurable = false;
  for (const sample of samples) {
    if (sample?.transport === "run_code") transports.run_code += 1;
    else if (sample?.transport === "direct") transports.direct += 1;
    if (sample?.code === PROBE_TRANSPORT_ERROR_CODE) transportFailed = true;
    // A timeout or a missing official batch row is not a measurement on any
    // route. Recognize the codes as well as the explicit flag so a pair built
    // from an older row or a direct timeout cannot become a benefit/regression.
    if (sample?.unmeasured === true || UNMEASURED_PROBE_CODES.has(sample?.code)) unmeasured = true;
    if (sample?.outputUnmeasurable === true) outputUnmeasurable = true;
    const index = Number.isInteger(sample?.index) ? sample.index : 0;
    const entry = steps.get(index) ?? {
      index,
      step: safeString(sample?.step),
      role: sample?.role === "control" ? "control" : "target",
      executions: 0,
      successes: 0,
      errors: 0,
      codes: [],
      digests: [],
    };
    entry.executions += 1;
    if (sample?.isError === true) {
      entry.errors += 1;
      const code = safeString(sample.code);
      if (code && !entry.codes.includes(code) && entry.codes.length < 3) entry.codes.push(code);
    } else {
      entry.successes += 1;
      const digest = safeString(sample?.valueDigest);
      if (digest && !entry.digests.includes(digest) && entry.digests.length < 2) entry.digests.push(digest);
    }
    steps.set(index, entry);
  }
  const perStep = [...steps.values()].sort((left, right) => left.index - right.index);
  const executions = samples.length;
  const successes = perStep.reduce((total, step) => total + step.successes, 0);
  const errors = executions - successes;
  return {
    executions,
    successes,
    errors,
    successRate: executions > 0 ? roundMetric(successes / executions) : 0,
    transports,
    // A transport failure or an unmeasured PTC execution invalidates the pair:
    // neither is a measurement of the candidate's behavior, and a later success
    // must not be read as its benefit.
    transportFailed,
    unmeasured,
    outputUnmeasurable,
    perStep,
  };
}

/**
 * Compare the two phases. A benefit needs a target step that failed in the
 * baseline and succeeds in the candidate, with no step regressing; a control
 * step that succeeded in the baseline must still succeed and return the same
 * value digest, so a candidate that "fixes" the target by changing unrelated
 * behavior cannot pass the correctness gate.
 */
export function compareProbeRuns(baseline, candidate) {
  const before = probeSummary(baseline);
  const after = probeSummary(candidate);
  const reasons = [];
  const steps = [];
  let regression = false;
  let targetImproved = 0;
  let improvedAbsentTargets = 0;
  let improvedMeasuredTargets = 0;
  for (const step of before.perStep) {
    const next = after.perStep.find((entry) => entry.index === step.index);
    const row = {
      index: step.index,
      step: step.step,
      role: step.role,
      executions: step.executions,
      baselineSuccesses: step.successes,
      candidateSuccesses: next?.successes ?? 0,
    };
    steps.push(row);
    if ((next?.successes ?? 0) < step.successes) {
      regression = true;
      if (reasons.length < 6) reasons.push(`${row.step}: candidate succeeded ${row.candidateSuccesses}/${row.executions} vs baseline ${row.baselineSuccesses}/${step.executions}`);
    }
    if (step.role === "target" && row.candidateSuccesses > row.baselineSuccesses) {
      targetImproved += 1;
      // A step whose only baseline outcome was the declared capability-absent
      // row proves the tool now exists, not that a workflow improved. Steps
      // that really ran in the baseline and failed are the workflow signal.
      const absent = step.successes === 0 && step.codes.includes("E_EVOLUTION_PROBE_CAPABILITY_ABSENT");
      if (absent) improvedAbsentTargets += 1;
      else improvedMeasuredTargets += 1;
    }
    if (step.role === "control" && step.successes === step.executions) {
      if ((next?.successes ?? 0) !== step.executions) {
        regression = true;
        if (reasons.length < 6) reasons.push(`${row.step}: correctness control no longer succeeds`);
      } else {
        const baselineDigests = step.digests.join("|");
        const candidateDigests = (next?.digests ?? []).join("|");
        if (baselineDigests && candidateDigests && baselineDigests !== candidateDigests) {
          regression = true;
          if (reasons.length < 6) reasons.push(`${row.step}: correctness control result changed`);
        }
      }
    }
  }
  const controlSteps = steps.filter((step) => step.role === "control");
  const controlStable = controlSteps.every((step) => step.baselineSuccesses === step.candidateSuccesses && step.candidateSuccesses === step.executions);
  // A repetition is consistent when every step is all-success or all-failure
  // within a phase; the benefit claim is only repeatable when both phases are
  // consistent and each step actually ran more than once.
  const consistent = (summary) => summary.perStep.every((step) => step.executions === 0 || step.successes === 0 || step.successes === step.executions);
  // A step that failed in the official transport did not measure the tool, so a
  // later success is not evidence of a benefit and the pair is not repeatable.
  const transportFailed = before.transportFailed === true || after.transportFailed === true;
  const unmeasured = before.unmeasured === true || after.unmeasured === true;
  const measurementInvalid = transportFailed || unmeasured;
  const repeatable = !measurementInvalid
    && before.perStep.length > 0
    && before.executions >= 2 * before.perStep.length
    && consistent(before)
    && consistent(after);
  const benefit = !measurementInvalid && targetImproved > 0 && !regression && after.errors < before.errors;
  // A transport failure or an unmeasured PTC execution is not a strategy
  // regression or a "no benefit" verdict: the pair did not measure both sides,
  // so writing that conclusion into shared experience would block a valid
  // hypothesis for the wrong reason.
  if (measurementInvalid) regression = false;
  if (measurementInvalid && reasons.length < 6) {
    reasons.push("a step failed in the official PTC transport or was not measured; the pair is not comparable");
  }
  const benefitKind = !benefit
    ? null
    // A plain probe pair replaces one tool call with identical arguments. Even
    // when the baseline call really ran and failed, that is a tool-level
    // before/after, not a workflow: the model's surrounding path is absent.
    // Only the paired workload (compareWorkflowProbeRuns) or task evidence may
    // claim a workflow benefit.
    : improvedMeasuredTargets > 0 ? "tool-improvement" : "capability-self-test";
  const workflowBenefit = false;
  if (!benefit && !regression && reasons.length === 0) reasons.push("candidate did not improve any target step over the baseline");
  if (regression && reasons.length === 0) reasons.push("candidate regressed a measured step");
  return {
    benefit,
    benefitKind,
    workflowBenefit,
    improvedAbsentTargets,
    improvedMeasuredTargets,
    regression,
    controlStable,
    repeatable,
    transportFailed,
    unmeasured,
    measurementInvalid,
    targetImproved,
    before,
    after,
    steps,
    reasons: reasons.slice(0, 6),
    beforeMetrics: { successRate: before.successRate, errorCount: before.errors },
    afterMetrics: { successRate: after.successRate, errorCount: after.errors },
    sampleDigest: {
      baseline: `sha256:${sha256(stableJson(baseline?.samples ?? []))}`,
      candidate: `sha256:${sha256(stableJson(candidate?.samples ?? []))}`,
    },
  };
}

/**
 * The measurement a completed probe pair contributes. `measure()` replaces the
 * caller-supplied aggregates with these values, so the promotion gates read
 * evidence the orchestrator computed from real executions.
 */
export function compareWorkflowProbeRuns(baseline, candidate, scenario) {
  const initialBaseline = baseline;
  const initialSummary = probeSummary(initialBaseline);
  baseline = candidate.reference ?? baseline;
  const comparison = compareProbeRuns(baseline, candidate);
  // A transport failure in any of the three runs (pre-Trial baseline, in-Trial
  // reference, candidate) means at least one phase did not measure the tool.
  // Treating its error as a baseline failure would turn a transport problem
  // into a candidate benefit, so the pair is insufficient evidence instead.
  const transportFailed = initialSummary.transportFailed === true
    || comparison.before.transportFailed === true || comparison.after.transportFailed === true;
  const unmeasured = initialSummary.unmeasured === true
    || comparison.before.unmeasured === true || comparison.after.unmeasured === true;
  const baseMeasurementInvalid = transportFailed || unmeasured || initialSummary.outputUnmeasurable === true
    || comparison.measurementInvalid === true;
  const outcomes = (run) => stableJson((run?.samples ?? []).map(({ index, repetition, isError, code, valueDigest }) => ({ index, repetition, isError, code, valueDigest })));
  const comparable = outcomes(initialBaseline) === outcomes(baseline);
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
  const costs = (run) => {
    const rows = run?.samples ?? [];
    const totals = Array.from({ length: scenario.repetitions }, (_, repetition) => rows
      .filter((row) => row.repetition === repetition).reduce((sum, row) => sum + row.durationMs, 0));
    return { calls: rows.length, medianDurationMs: median(totals), totalDurationMs: totals.reduce((a, b) => a + b, 0),
      outputBytes: rows.reduce((sum, row) => sum + (row.outputBytes ?? 0), 0),
      outputUnmeasurable: rows.some((row) => row.outputUnmeasurable === true), perRepetitionMs: totals };
  };
  const beforeCost = costs(baseline), afterCost = costs(candidate);
  // A cost that could not be measured safely is not a zero-byte result: it must
  // not turn into a false cost regression or benefit in the paired verdict.
  const outputUnmeasurable = beforeCost.outputUnmeasurable || afterCost.outputUnmeasurable;
  const measurementInvalid = baseMeasurementInvalid || outputUnmeasurable;
  const complete = (run) => scenario.steps.every((step, index) => Array.from({ length: scenario.repetitions }, (_, repetition) => {
    const rows = (run?.samples ?? []).filter((row) => row.index === index && row.repetition === repetition);
    return rows.length === 1 && rows[0].expectedDigest === step.expectedDigest && Number.isFinite(rows[0].durationMs);
  }).every(Boolean)) && run?.samples?.length === scenario.steps.length * scenario.repetitions;
  const controls = scenario.steps.filter((step) => step.role === "control");
  const enough = Boolean(candidate.reference) && comparable && !measurementInvalid && scenario.repetitions >= 5 && scenario.steps.length >= 2 && controls.length > 0
    && complete(baseline) && complete(candidate) && comparison.repeatable && comparison.controlStable;
  const durationAcceptable = afterCost.medianDurationMs <= Math.max(beforeCost.medianDurationMs * 1.25, beforeCost.medianDurationMs + 5);
  const outputAcceptable = afterCost.outputBytes <= beforeCost.outputBytes * 4 + 1024;
  const allCorrect = comparison.after.errors === 0;
  const fasterPairs = beforeCost.perRepetitionMs.filter((value, index) => afterCost.perRepetitionMs[index] <= value * 0.8 && value - afterCost.perRepetitionMs[index] >= 2).length;
  const efficiency = allCorrect && comparison.before.errors === 0 && fasterPairs >= 4
    && afterCost.medianDurationMs <= beforeCost.medianDurationMs * 0.8 && beforeCost.medianDurationMs - afterCost.medianDurationMs >= 2;
  const quality = allCorrect && comparison.before.errors > 0;
  // An invalid pair cannot prove a regression or a benefit: both sides were not
  // measured. The decision then stays insufficient-evidence.
  const regression = measurementInvalid ? false : (comparison.regression || !durationAcceptable || !outputAcceptable);
  const benefit = enough && !regression && (quality || efficiency);
  const reasons = [];
  if (!comparable) reasons.push("baseline outcomes changed during the paired workload; environment comparability is unproven");
  if (measurementInvalid) reasons.push("a workload step failed in the official PTC transport or was not measured; the paired measurement is not comparable");
  if (!enough) reasons.push("insufficient evidence: need five complete, consistent repetitions, multiple cases and a stable correctness control");
  if (!durationAcceptable) reasons.push("candidate execution overhead exceeds the duration budget (25% or 5ms per workload)");
  if (!outputAcceptable) reasons.push("candidate result bytes exceed the quality budget (4x baseline plus 1024 bytes)");
  if (comparison.regression) reasons.push(...comparison.reasons);
  if (!quality && !efficiency) reasons.push("no verified correctness or repeatable execution-cost improvement");
  return { ...comparison, benefit, benefitKind: benefit ? "workflow" : null, workflowBenefit: benefit,
    // The top-level flags describe all three runs, not only the reference and
    // candidate summaries the child comparison saw.
    transportFailed, unmeasured, measurementInvalid, regression, repeatable: enough, reasons: reasons.slice(0, 6),
    sampleDigest: { ...comparison.sampleDigest, beforeTrialBaseline: `sha256:${sha256(stableJson(initialBaseline.samples))}` },
    beforeMetrics: { ...comparison.beforeMetrics, failureRate: roundMetric(1 - comparison.before.successRate), durationMs: beforeCost.medianDurationMs },
    afterMetrics: { ...comparison.afterMetrics, failureRate: roundMetric(1 - comparison.after.successRate), durationMs: afterCost.medianDurationMs },
    workload: { evidenceKind: "experimental-workflow", sufficient: enough, comparable, quality, efficiency,
      metricSource: "official tools.execute; expected-result digests; wall-clock including dispatch and result projection; serialized result bytes",
      beforeCost, afterCost, durationAcceptable, outputAcceptable,
      pairing: candidate.reference ? "alternating AB/BA in the active Trial; baseline also captured before Trial" : "unpaired",
      baselineMetricSource: "reference samples; outcomes verified against pre-Trial baseline",
      baselineTransports: initialSummary.transports, transportFailed, unmeasured, measurementInvalid,
      validationDurationMs: costs(initialBaseline).totalDurationMs } };
}

export function deriveProbeObservation(probe) {
  const comparison = probe?.comparison;
  if (!probe?.baseline || !probe?.candidate || !comparison) return null;
  return {
    scenarioId: probe.scenario?.id ?? null,
    scenarioDigest: probe.scenarioDigest ?? null,
    versions: probe.versions ?? null,
    ...(isObject(probe.safety) ? { safety: probe.safety } : {}),
    comparison: {
      benefit: comparison.benefit,
      benefitKind: comparison.benefitKind,
      workflowBenefit: comparison.workflowBenefit,
      regression: comparison.regression,
      controlStable: comparison.controlStable,
      repeatable: comparison.repeatable,
      targetImproved: comparison.targetImproved,
      measurementInvalid: comparison.measurementInvalid === true,
      transportFailed: comparison.transportFailed === true,
      unmeasured: comparison.unmeasured === true,
      before: comparison.before,
      after: comparison.after,
      beforeMetrics: comparison.beforeMetrics,
      afterMetrics: comparison.afterMetrics,
      sampleDigest: comparison.sampleDigest,
      reasons: comparison.reasons,
      steps: comparison.steps,
      ...(comparison.workload ? { workload: comparison.workload } : {}),
    },
    samples: { baseline: probe.baseline.samples, candidate: probe.candidate.samples,
      ...(probe.candidate.reference ? { reference: probe.candidate.reference.samples } : {}) },
  };
}

/**
 * The Compose side of one experiment, derived from the evidence already in
 * `record.latestObservation` / `record.probe`. It never grants promotion
 * authority: `promotionGates` stays the production gate, and this result only
 * records *why* an experiment was adopted, reverted, rejected, or left
 * unproven so later recall can reuse the lesson.
 */
export function classifyExperimentDecision(experiment = {}, { at = null, source = "measure" } = {}) {
  const observation = experiment.latestObservation || null;
  // After a restart the in-session `probe` is not rebuilt, but the durable
  // observation carries the comparison. Reading only `experiment.probe` used to
  // turn an invalid pair (which wrote `regressionPassed: false`) into a real
  // regression verdict, publishing a false conclusion into shared experience
  // and blocking the same hypothesis from being proposed again. The in-session
  // probe still wins when both exist; the durable one is the fallback.
  const probe = experiment.probe || observation?.probe || null;
  const comparison = probe?.comparison || null;
  const gates = observation ? promotionGates(experiment, { requireRuntimeRecovery: false }) : null;
  const reasons = [];
  // `regressionPassed: false` is ambiguous without a candidate comparison: the
  // incomplete-probe branch below writes it to mean "correctness was not
  // proven", not "a regression was observed". Only a real candidate comparison
  // can turn that into the regression verdict; everything else is unproven.
  const probeIncomplete = observation?.probe?.incomplete === true;
  // A capability self-test explicitly reports "correctness not proven", not a
  // measured regression; treating its regressionPassed:false as a regression
  // wrote a regression conclusion into shared experience for every honest
  // capability measurement. The legacy caller-supplied path keeps its meaning.
  const capabilitySelfTest = observation?.evidenceKind === "capability-self-test";
  // A task-coupled artifact is the only measurement a context-policy candidate
  // has. `measure()` derives `regressionPassed` from `taskBenefit.regression`,
  // but when the mechanism never ran that number only compares two unrelated
  // runs: it cannot be a regression verdict for this hypothesis. The same
  // ambiguity as a capability self-test applies, so keep it unproven.
  // A Desktop plan may declare both a workload probe and task evidence. When a
  // probe pair exists `measure()` keeps `evidenceKind: comparative-workload`, but
  // the validated task artifact is still attached and is the only evidence
  // about whether the candidate mechanism actually ran and helped. Gate on the
  // artifact itself, never on the evidenceKind label.
  const taskBenefit = isObject(observation?.taskBenefit) ? observation.taskBenefit : null;
  const taskMechanismRan = taskBenefit ? taskBenefit.mechanismRan === true : null;
  const measurementInvalid = comparison?.measurementInvalid === true;
  // Regression is decided by the evidence that actually measured it, not by the
  // combined `regressionPassed` flag. A probe only reports a regression when its
  // own comparison says so; a task artifact only when the mechanism actually ran
  // and its cost budget was exceeded. The ambiguous flag is meaningful only on
  // the legacy caller-supplied path with no probe and no task artifact (where a
  // capability self-test or an incomplete probe must still stay unproven).
  const probeRegression = comparison?.regression === true;
  const taskRegression = taskBenefit !== null && taskMechanismRan === true && taskBenefit.regression === true;
  // With no task artifact, the caller-supplied flag keeps its established
  // meaning on both the legacy and the probed path (a failed correctness claim).
  const callerOrProbeRegression = taskBenefit === null && !capabilitySelfTest && !probeIncomplete
    && observation?.regressionPassed === false;
  // A failed/invalid probe pair only invalidates probe-derived regression. A
  // validated task artifact that actually ran and exceeded its budget measured
  // the regression itself and stays authoritative.
  const regression = taskRegression || (!measurementInvalid && (probeRegression || callerOrProbeRegression));
  const measured = Boolean(observation) && measuredEvidenceOf(observation);
  const benefit = Boolean(observation)
    && observation.solvesProblem === true
    && measured
    && observation.repeatable === true
    && observation.regressionPassed === true;
  let kind = "insufficient-evidence";
  if (regression) {
    kind = "regression";
    // The task artifact is the authoritative measurement when it ran; a probe
    // that failed in transit only explains why no second comparison exists.
    if (taskRegression) reasons.push("the candidate mechanism ran and exceeded the task cost budget");
    for (const reason of comparison?.reasons || []) if (reasons.length < 5) reasons.push(reason);
    if (reasons.length === 0) reasons.push("regression evidence is present");
  } else if (benefit) {
    kind = "benefit";
    reasons.push("measured behavior improved and the correctness control stayed stable");
  } else if (taskBenefit && taskMechanismRan === true && taskBenefit.benefit === false && taskBenefit.regression === false) {
    // A complete paired real-session measurement that actually ran the
    // candidate and found no improvement is a durable lesson independent of the
    // workload probe: an invalid/insufficient probe must not swallow it. Real
    // probe regressions are still caught by the `regression` branch above.
    kind = "no-benefit";
    reasons.push("paired real sessions ran the candidate but found no improvement");
  } else if (comparison?.measurementInvalid === true) {
    // The pair did not measure both sides: this is not a benefit, a regression
    // or a "no benefit" verdict, and recording one would block a valid strategy.
    kind = "insufficient-evidence";
    for (const reason of comparison.reasons || []) if (reasons.length < 5) reasons.push(reason);
  } else if (comparison?.workload?.sufficient === false) {
    reasons.push(...comparison.reasons.slice(0, 5));
  } else if (comparison && comparison.benefit === false && comparison.before?.executions > 0) {
    kind = "no-benefit";
    for (const reason of comparison.reasons || []) if (reasons.length < 5) reasons.push(reason);
    if (reasons.length === 0) reasons.push("the probe found no improvement over the baseline");
  } else if (!observation) {
    reasons.push("no measurement was recorded");
  } else if (!measured) {
    reasons.push("the measurement does not prove a measurable benefit");
  } else {
    reasons.push("benefit evidence is present, but correctness or repeatability proof is missing");
  }
  const eligible = gates?.eligible === true;
  if (kind === "benefit" && !eligible) {
    kind = "insufficient-evidence";
    reasons.push("at least one promotion gate has no supporting evidence");
  }
  return {
    version: 1,
    kind,
    source,
    at: at || now(),
    observationAt: observation?.at || null,
    eligible,
    reasons: reasons.slice(0, 6),
    gates: gates ? {
      realBenefit: gates.realBenefit,
      measuredEvidence: gates.measuredEvidence,
      repeatable: gates.repeatable,
      regressionTest: gates.regressionTest,
      reversible: gates.reversible,
      cleanupEvidence: gates.cleanupEvidence,
      noOrphans: gates.noOrphans,
      runtimeRecovered: gates.runtimeRecovered,
    } : null,
    probe: comparison ? {
      benefit: comparison.benefit,
      regression: comparison.regression,
      controlStable: comparison.controlStable,
      repeatable: comparison.repeatable,
      targetImproved: comparison.targetImproved,
      scenarioId: probe?.scenario?.id ?? probe?.scenarioId ?? null,
      scenarioDigest: probe?.scenarioDigest ?? null,
      sampleDigest: comparison.sampleDigest ?? null,
    } : null,
  };
}

/** The conclusion a terminal transition records for the next evolution round. */
export function conclusionKindFor(record = {}, { fallback = "insufficient-evidence" } = {}) {
  const comparison = record?.probe?.comparison;
  const kind = record?.decision?.kind;
  if (comparison?.regression === true || kind === "regression") return "regression";
  if (kind === "no-benefit") return "no-benefit";
  if (kind === "benefit") return "reverted-unconfirmed";
  return fallback;
}

// Task-coupled experiments have no probe pair: their measured before/after
// counts are projected directly onto latestObservation by measure(). These are
// the only numeric facts such an experiment produces, so they must survive into
// the durable conclusion or the next planning round sees a verdict with no
// benefit numbers at all.
// validateTaskBenefit requires equal session counts and all-correct sessions on
// both sides, so sessions/correct deltas are always zero and would only consume
// a projection slot. These are the deltas that can actually differ.
const TASK_METRIC_DELTA_KEYS = Object.freeze([
  "failures", "turns", "toolCalls", "tokens", "durationMs",
]);

function conclusionMetrics(record) {
  // A canary regression is a verdict from the last production barrier, not from
  // the workload probe or task artifact measured earlier. No caller in the
  // official host path supplies numeric before/after metrics to a canary
  // observation: a failed startup, component, dependency or functional check is
  // recorded in the observation/archive/sidecar, not as a session delta. The
  // measured probe/task numbers stay there in full. Projecting them into the
  // shared conclusion would put apparent gains beside a `regression` verdict
  // and mislead the next discovery round, so publish no delta for this verdict.
  // This only changes the bounded shared lesson; promotion, gates, archive and
  // authorization are untouched, and canary-passed (`source: canary-passed`)
  // keeps its probe/task projection byte for byte.
  if (record?.decision?.source === "canary" && record?.decision?.kind === "regression") return {};
  // The conclusion can be published after a process restart (a promotion's
  // canary commits in the next session), where `record.probe` was never rebuilt:
  // only `latestObservation.probe` survives the evidence snapshot. Read the
  // measured delta from that durable projection as well, or the shared lesson
  // would lose the only numbers the experiment actually produced.
  const comparison = record?.probe?.comparison ?? record?.latestObservation?.probe?.comparison;
  const probeBasis = comparison?.beforeMetrics && comparison?.afterMetrics
    ? { before: comparison.beforeMetrics, after: comparison.afterMetrics }
    : null;
  // A context-policy / taskBenefit-only experiment has no probe comparison.
  // Only a validated task artifact makes these numbers durable evidence: an
  // arbitrary caller-supplied before/after object must not be promoted into a
  // shared lesson (the same rule the probe branch applies to caller metrics).
  const taskArtifact = record?.latestObservation?.taskBenefit;
  const taskBasis = !probeBasis
    && taskArtifact && typeof taskArtifact === "object" && !Array.isArray(taskArtifact)
    && taskArtifact.mechanismRan === true
    && record.latestObservation.beforeMetrics && record.latestObservation.afterMetrics
    ? { before: record.latestObservation.beforeMetrics, after: record.latestObservation.afterMetrics }
    : null;
  // A Desktop plan may declare both a workload probe and a task artifact. When
  // the validated task artifact ran the candidate and found no benefit (or a
  // cost regression) while the probe did not itself report a regression, the
  // classifier derives the verdict from the task evidence — even when the
  // probe's comparison was positive. The durable lesson must then project the
  // task artifact's deltas: carrying the probe's positive numbers would record
  // "no benefit" beside apparent gains and mislead the next round.
  // A probe regression still owns its verdict and keeps the probe basis, and a
  // task artifact that did not run (or was positive) can never displace it.
  // This changes only the shared conclusion projection: the probe numbers stay
  // in the full observation, archive and evidence sidecar, and probe-only and
  // task-only conclusions keep their historical shape byte for byte.
  const taskDroveNegative = Boolean(
    probeBasis
    && comparison?.regression !== true
    && taskArtifact && typeof taskArtifact === "object" && !Array.isArray(taskArtifact)
    && taskArtifact.mechanismRan === true
    && (taskArtifact.benefit === false || taskArtifact.regression === true)
    && (record?.decision?.kind === "no-benefit" || record?.decision?.kind === "regression")
    && isObject(taskArtifact.baseline) && isObject(taskArtifact.candidate),
  );
  const basis = taskDroveNegative
    ? { before: taskArtifact.baseline, after: taskArtifact.candidate }
    : (probeBasis ?? taskBasis);
  if (!basis) return {};
  // `knowledge.js` drops metric names matching count/date/id/version/status/
  // score/confidence, so the delta keys avoid those words to stay in the
  // canonical effect stats: the measured change is part of the lesson.
  // Probe-based conclusions keep their byte-for-byte historical shape.
  const metrics = probeBasis && !taskDroveNegative
    ? {
      successRateDelta: roundMetric(basis.after.successRate - basis.before.successRate),
      errorsDelta: basis.after.errorCount - basis.before.errorCount,
    }
    : {};
  // A task-coupled basis has session counts instead of tool success metrics;
  // project only the numeric keys it actually carries.
  if (taskBasis || taskDroveNegative) {
    if (Number.isFinite(basis.before.successRate) && Number.isFinite(basis.after.successRate)) {
      metrics.successRateDelta = roundMetric(basis.after.successRate - basis.before.successRate);
    }
    if (Number.isFinite(basis.before.errorCount) && Number.isFinite(basis.after.errorCount)) {
      metrics.errorsDelta = basis.after.errorCount - basis.before.errorCount;
    }
    for (const key of TASK_METRIC_DELTA_KEYS) {
      if (Number.isFinite(basis.before[key]) && Number.isFinite(basis.after[key])) {
        metrics[`${key}Delta`] = basis.after[key] - basis.before[key];
      }
    }
  }
  return metrics;
}

function defaultPaths(config = {}) {
  const dshHome = config.dshHome || process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const presetId = config.presetId || "evolution";
  const presetDir = config.presetDir || path.join(dshHome, "storages", "evolution");
  return {
    presetId,
    presetDir,
    pluginRoot: config.pluginRoot || path.join(presetDir, "promoted"),
    promotionRuntime: config.promotionRuntime,
    compositionPath: config.compositionPath || path.join(presetDir, "promoted.cordis.yml"),
    evolutionPath: config.evolutionPath || path.join(presetDir, "EVOLUTION.md"),
    archiveDir: config.archiveDir || path.join(presetDir, "knowledge", "archive", new Date().getUTCFullYear().toString(), "experiments"),
    promotionStateDir: config.promotionStateDir || path.join(presetDir, ".evolution-promotion"),
    promotionLockPath: config.promotionLockPath || `${config.promotionStateDir || path.join(presetDir, ".evolution-promotion")}.lock`,
    memoryPath: config.memoryPath || path.join(presetDir, "knowledge", "evolution-memory.json"),
    eventBridgePath: config.eventBridgePath || process.env.DSH_EVOLUTION_EVENT_BRIDGE || path.join(os.homedir(), ".dockyard-dsh", "evolution-events.jsonl"),
    eventBridgeKey: config.eventBridgeKey || process.env.DSH_EVOLUTION_EVENT_BRIDGE_KEY,
    eventBridgeWriter: config.eventBridgeWriter || EVENT_BRIDGE_DEFAULT_WRITER,
    driftStatePath: config.driftStatePath || path.join(os.homedir(), ".local", "share", "dsh-local", "dsh-profiles-state.json"),
    ownershipDir: config.ownershipDir || path.join(presetDir, ".evolution-ownership"),
  };
}

/**
 * Read one promotion target once and report whether it existed. The bytes this
 * returns become the rollback baseline, the backup the journal names and the
 * content the plan was derived from, so all three describe one snapshot.
 */
async function capturePromotionTarget(target) {
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return { existed: false, before: null };
    throw error;
  }
  if (!stat.isFile()) throw new Error(`Promotion target is not a regular file: ${target}`);
  return { existed: true, before: await fsp.readFile(target, "utf8") };
}

async function writeAtomic(file, content, { durable = false } = {}) {
  const directory = path.dirname(file);
  // Only the durable path pays for this check: a directory created here needs
  // its own entry on disk, a pre-existing one does not.
  const existingDirectory = durable ? await pathExists(directory) : true;
  await fsp.mkdir(directory, { recursive: true });
  const temp = path.join(directory, `.evolution-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await fsp.writeFile(temp, content, "utf8");
    // The cold archive's protocol, applied only where the caller asks for it:
    // the bytes reach the disk before the rename, and the new directory entry
    // reaches the disk before a caller may delete the journal that describes
    // it. Only the promotion transaction and the evidence it must not lose opt
    // in, so the per-experiment records keep their previous cost.
    if (durable) syncFile(temp);
    await fsp.rename(temp, file);
    if (durable) {
      syncDirectoryEntry(directory);
      // A fresh directory (the promotion state directory, an archive
      // subdirectory, the plugin directory) is only durable once its own entry
      // exists in its parent.
      if (!existingDirectory) syncDirectoryEntry(path.dirname(directory));
    }
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** fsync one directory's entry list; archive-stage keeps its own copy private. */
function syncDirectoryEntry(directory) {
  const descriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function replaceSection(source, title, body) {
  const header = `## ${title}`;
  const block = `${header}\n${body.trim()}\n`;
  const pattern = new RegExp(`^${header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n[\\s\\S]*?(?=^## |\\s*$)`, "m");
  return pattern.test(source) ? source.replace(pattern, block) : `${source.trimEnd()}\n\n${block}`;
}

function updateEvolutionPointer(source, experiment, durable) {
  const state = String(experiment.state).startsWith("promotion-") || experiment.state === "promoting" ? "canary-observing" : experiment.state;
  const pointer = [
    `- last experiment: ${experiment.id} (${state})`,
    `- durable capability: ${durable.pluginName} (${durable.pluginPath})`,
    `- next session: preset ${durable.presetId} re-reads the composition and mounts the promoted Cordis Plugin`,
    `- rollback: remove composition row ${durable.rowId} and the plugin directory ${durable.pluginPath}, then start a new session`,
    `- archive: ${durable.archivePath}`,
  ].join("\n");
  return replaceSection(source, "实验指针", pointer);
}

export function assertPromotableHostSource(hostCode) {
  // A standalone Plugin has no official runner sandbox / active-run handler
  // scope. The only sandbox helpers a promoted Plugin can receive are the two
  // that have a real runtime equivalent: `harness.defineTool` is the official
  // `defineTool` from @deepseek-ai/dsh-tools, and `harness.registerTool` is the
  // official `ctx.tools.register`. Keep every other runner-only helper (for
  // example `harness.handle`) out, including lazily inside apply(). This stays a
  // conservative lexical refusal, not a security parser or a sandbox
  // compatibility claim.
  const withoutToolHelpers = hostCode.replace(/\bharness\s*\.\s*(?:defineTool|registerTool)\b/g, "");
  if (/\bharness\b/.test(withoutToolHelpers)) throw new Error("Promotion supports only harness.defineTool / harness.registerTool; other runner sandbox helpers (including harness.handle) and sandbox-only scopes are not available to a Host-only standalone Plugin");
  try { new Function(hostCode); } catch (error) {
    throw new Error(`Promotion requires a synchronous standalone Host body: ${error.message}`);
  }
}

/**
 * Resolve the official runner sandbox helpers for a harness-using Promotion.
 *
 * The Trial's `harness.defineTool` is not the bare `@deepseek-ai/dsh-tools`
 * builder: the runner's sandbox normalizes the parameter DSL and marks the tool
 * for its guarded registration. A Promoted Plugin must receive that exact pair,
 * or a composition that passed Trial can fail to load after promotion. The
 * helpers live in the runner package at `lib/types/guard.js`, next to the
 * package entry the profile loader resolves; the generated module imports that
 * one immutable URL (the same installation this host verified).
 */
function resolvePromotedHarnessUrl(paths) {
  if (typeof paths?.promotedHarnessUrl === "string" && paths.promotedHarnessUrl !== "") return paths.promotedHarnessUrl;
  try {
    const runnerEntry = import.meta.resolve?.("@deepseek-ai/dsh-cordis-host-runner");
    if (typeof runnerEntry === "string" && runnerEntry !== "") {
      const guard = runnerEntry.replace(/\/lib\/index\.js$/, "/lib/types/guard.js");
      if (guard !== runnerEntry) return guard;
    }
  } catch {
    // Fall through to the explicit error in the caller.
  }
  return null;
}

/** Load the resolved runner helpers once to prove this host can import them and
    that the module actually exports the pair the generated source uses. */
async function requirePromotedHarnessUrl(paths) {
  const url = resolvePromotedHarnessUrl(paths);
  if (url === null) {
    throw new Error("Promotion cannot resolve the official @deepseek-ai/dsh-cordis-host-runner sandbox helpers; run the Promotion from an installed profile");
  }
  let module;
  try {
    module = await import(url);
  } catch {
    throw new Error("Promotion cannot load the official runner sandbox helpers resolved for this host");
  }
  if (typeof module?.sandboxDefineTool !== "function" || typeof module?.sandboxRegisterTool !== "function") {
    throw new Error("Promotion requires the official runner sandbox defineTool/registerTool helpers");
  }
  return url;
}

function packageSource(hostCode, pluginName, harnessUrl = null) {
  assertPromotableHostSource(hostCode);
  // `harness` is the Trial sandbox's name for the two helpers a Promoted Plugin
  // can actually receive. The generated module imports the runner's own sandbox
  // pair, so a composition that passed Trial keeps the same parameter
  // normalization and guarded registration after promotion and in every
  // consumer profile.
  const usesHarness = /\bharness\b/.test(hostCode);
  if (usesHarness && (typeof harnessUrl !== "string" || harnessUrl === "")) {
    throw new Error("Promotion cannot resolve the official runner sandbox helpers for a harness-using Host body");
  }
  const importLine = usesHarness ? `import { sandboxDefineTool as __dshSandboxDefineTool, sandboxRegisterTool as __dshSandboxRegisterTool } from ${JSON.stringify(harnessUrl)};\n` : "";
  const harnessLine = usesHarness ? `const harness = Object.freeze({ defineTool: __dshSandboxDefineTool, registerTool: __dshSandboxRegisterTool });\n` : "";
  const factory = usesHarness ? `Function("harness", ${JSON.stringify(hostCode)})(harness)` : `Function(${JSON.stringify(hostCode)})()`;
  return `// Generated by dsh-evolution-orchestrator after a verified Promotion.\n// The Plugin lifecycle remains owned by Cordis.\n${importLine}${harnessLine}const plugin = ${factory};\nexport const name = plugin?.name || ${JSON.stringify(pluginName)};\nexport const inject = plugin?.inject;\nexport const provide = plugin?.provide;\nexport const intercept = plugin?.intercept;\nexport const Config = plugin?.Config;\nexport function apply(ctx, config) {\n  if (typeof plugin === "function") return plugin(ctx, config);\n  if (plugin && typeof plugin.apply === "function") return plugin.apply(ctx, config);\n  throw new Error("Promoted Cordis Plugin did not return a function or an object with apply(ctx)");\n}\n`;
}

async function pathExists(file) {
  try { await fsp.lstat(file); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

/**
 * One rollback failure at the shape both persisted journal boundaries read.
 * A rollback failure is created through `safeErrorDto`, so the provider's raw
 * message is already gone when it reaches here; this projection keeps the target
 * (the thing an operator has to act on) plus the category, the irreversible
 * digest and the redacted summary, and re-derives those fields when a journal
 * written by an older version still carries the raw text under `error`.
 */
function safeJournalFailure(failure) {
  const source = failure && typeof failure === "object" ? failure : {};
  const legacy = typeof source.error === "string" ? safeErrorDto(source.error, "rollback") : null;
  const detail = typeof source.errorCategory === "string" ? source : legacy;
  return {
    target: typeof source.target === "string" ? source.target : null,
    errorCode: detail?.errorCode ?? null,
    errorCategory: detail?.errorCategory ?? "runtime-trial",
    errorDigest: detail?.errorDigest ?? null,
    errorSummary: detail?.errorSummary ?? "unknown error",
  };
}

function safeJournalFailures(failures) {
  return (Array.isArray(failures) ? failures : []).map(safeJournalFailure);
}

/**
 * The sidecar's copy of a preserved journal: the phase, the two paths an
 * operator needs to open it, and the projected failure rows — never the change
 * plan and never the raw error text. `journal.json` keeps the recovery plan it
 * needs, and both boundaries take their failure rows from `safeJournalFailures`,
 * so neither can persist a credential shape the other one drops.
 */
function safePromotionJournalForPersistence(journal) {
  const source = journal && typeof journal === "object" ? journal : {};
  const stateDir = typeof source.stateDir === "string" ? source.stateDir : null;
  return {
    preserved: true,
    phase: typeof source.phase === "string" ? source.phase : null,
    stateDir,
    journalPath: typeof source.journalPath === "string" ? source.journalPath
      : stateDir === null ? null : path.join(stateDir, "journal.json"),
    failures: safeJournalFailures(Array.isArray(source.failures) ? source.failures : source.rollbackFailures),
  };
}

async function writeJournal(file, journal) {
  // `rollbackFailures` is the only journal field that carries provider text, and
  // it is projected here rather than at each call site, so every phase that
  // writes journal.json crosses the same boundary.
  const projected = journal && typeof journal === "object" && journal.rollbackFailures !== undefined
    ? { ...journal, rollbackFailures: safeJournalFailures(journal.rollbackFailures) }
    : journal;
  await writeAtomic(file, JSON.stringify(projected, null, 2) + "\n", { durable: true });
}

function pathWithin(target, root) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

const JOURNAL_RECORD_TYPES = new Set(["file", "path"]);
// Experiment ids become file names inside the archive directory, so the journal
// boundary only accepts the shape `propose()` generates (a superset is not
// enough: a separator would escape the archive directory).
const PROMOTION_EXPERIMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROMOTION_DIGEST = /^[0-9a-f]{64}$/;
// The startup barrier is the only caller allowed to advance a canary owned by
// another (previous) session. It is a module-private symbol, not an argument a
// tool caller could supply: the owner check must not be forgeable from JSON.
const STARTUP_TRANSITION = Symbol("evolution.startup-transition");

/**
 * The single promotion-journal boundary rule, shared by recovery and the
 * doctor. It returns a refusal reason, or null when the journal targets stay
 * inside the configured roots; recovery throws the reason and diagnostics
 * reports it, so both refuse the same journals with the same explanation.
 */
export function checkJournalBoundary(journal, paths) {
  if (!paths?.presetDir || !paths?.promotionStateDir || !paths?.pluginRoot || !paths?.archiveDir
    || !paths?.compositionPath || !paths?.evolutionPath) {
    return "journal boundary requires the complete configured target roots";
  }
  if (typeof journal?.stateDir !== "string" || path.resolve(journal.stateDir) !== path.resolve(paths.promotionStateDir)) {
    return "journal stateDir is outside the configured promotion state directory";
  }
  if (journal.stageDir && (typeof journal.stageDir !== "string" || !pathWithin(journal.stageDir, paths.promotionStateDir))) {
    return "journal stageDir escapes its state directory";
  }
  if (!Array.isArray(journal.records)) return "journal has no change plan";
  // An empty plan cannot describe an interrupted transaction: the promotion
  // always writes the composition, the pointer, the archive and the plugin
  // directory. Rolling it back would restore nothing and then delete the last
  // evidence that something was in flight, so it is classified as unknown.
  if (journal.records.length === 0) return "journal has an empty change plan";
  const roots = [paths.pluginRoot, paths.presetDir, paths.archiveDir].filter(Boolean);
  for (const record of journal.records) {
    if (!JOURNAL_RECORD_TYPES.has(record?.type) || typeof record?.target !== "string") return "journal record has an unsupported shape";
    if (pathWithin(record.target, paths.promotionStateDir)) return "journal record targets its own state directory";
    if (!roots.some((root) => pathWithin(record.target, root))) return "journal record targets a path outside the configured roots";
    if (record.type === "file" && (typeof record.backup !== "string" || path.basename(record.backup) !== record.backup)) return "journal backup name is not a bare file name";
  }
  if (typeof journal.experimentId !== "string" || !PROMOTION_EXPERIMENT_ID.test(journal.experimentId)) {
    return "journal has no valid experiment identity";
  }
  // Containment alone is not enough: it accepts a root itself, so a journal that
  // named `presetDir`, `dockyard` or `knowledge` would make recovery delete all
  // durable knowledge and still report a successful rollback. The plan must name
  // exactly the files this transaction writes and the plugin directory it
  // creates; anything else is a journal this version cannot prove it wrote.
  const fileTargets = new Set([
    path.resolve(paths.compositionPath),
    path.resolve(paths.evolutionPath),
    path.resolve(paths.archiveDir, `${journal.experimentId}.md`),
  ]);
  // The promoted plugin directory is derived from the experiment id by the only
  // writer (`writeDurablePromotionUnlocked`), so the plan can be checked against
  // it instead of merely being "some child of pluginRoot": the latter still let
  // a journal delete another experiment's promoted code.
  const expectedPlugin = path.resolve(paths.pluginRoot, `dsh-evolution-promoted-${sha256(journal.experimentId).slice(0, 12)}`);
  const seenTargets = new Set();
  const seenFiles = new Set();
  let pluginRecords = 0;
  for (const record of journal.records) {
    const target = path.resolve(record.target);
    if (seenTargets.has(target)) return "journal change plan names one target more than once";
    seenTargets.add(target);
    if (record.type === "file") {
      if (!fileTargets.has(target)) return "journal file record is not one of this transaction's planned files";
      // The rollback relies on these relationships: `existed` selects restore
      // vs remove, and a restored file needs the digest its backup must match.
      if (typeof record.existed !== "boolean") return "journal file record has no baseline state";
      if (record.existed ? !PROMOTION_DIGEST.test(record.beforeDigest ?? "") : record.beforeDigest !== null) {
        return "journal file record has an invalid rollback baseline";
      }
      if (!PROMOTION_DIGEST.test(record.expectedAfter ?? "")) return "journal file record has no planned digest";
      seenFiles.add(target);
      continue;
    }
    pluginRecords += 1;
    if (target !== expectedPlugin) return "journal path record is not this transaction's promoted plugin directory";
  }
  // A partial plan restores part of the transaction and then deletes the only
  // evidence that the rest was applied; only the writer's complete plan is a
  // state this version can prove it produced.
  if (seenFiles.size !== 3 || pluginRecords !== 1) return "journal change plan is missing part of this transaction";
  return null;
}

/**
 * The single promotion-journal phase classification, shared by recovery, the
 * canary reader, and the doctor: legal phases map to the recovery state they
 * own, and a phase that is missing or unrecognised stays `state-unknown`. The
 * destructive callers refuse that state instead of defaulting to a rollback;
 * the doctor reports it as blocked without offering a repair.
 */
const PROMOTION_JOURNAL_PHASE_STATES = new Map([
  ["prepared", "incomplete"],
  ["committing", "incomplete"],
  ["canary-observing", "canary-observing"],
  ["stable-committed", "committed-pending-cleanup"],
  ["committed", "committed-pending-cleanup"],
  ["rollback-failed", "rollback-failed"],
]);

export function classifyPromotionJournal(journal, paths) {
  const boundary = checkJournalBoundary(journal, paths);
  if (boundary) return { state: "state-unknown", phase: journal?.phase ?? null, boundary };
  const phase = journal?.phase ?? null;
  return { state: PROMOTION_JOURNAL_PHASE_STATES.get(phase) ?? "state-unknown", phase, boundary: null };
}

/**
 * The shared refusal for a journal the destructive callers must not act on: a
 * boundary violation, a phase that cannot be classified, or a failed rollback
 * that is preserved for inspection. Recovery and the canary reader call this
 * so both refuse with one message implementation. Callers that already know
 * the state dispatch on it afterwards.
 */
function assertJournalRecoverable(journal, { state, phase, boundary }) {
  if (boundary) throw new Error(`Evolution promotion journal recovery refused: ${boundary}`);
  if (state === "state-unknown") {
    throw new Error(`Evolution promotion journal recovery refused: unrecognised promotion journal phase ${JSON.stringify(phase)}; journal preserved at ${journal.stateDir}`);
  }
  if (state === "rollback-failed") throw new Error(`Evolution promotion rollback is incomplete: ${journal.stateDir}`);
}

async function rollbackPromotionJournal(journal, paths) {
  const records = Array.isArray(journal?.records) ? journal.records : [];
  const failures = [];
  const verifiedBackups = new Map();
  const fileRecords = records.filter((record) => record?.type === "file");
  // Preflight every file CAS and every backup before changing any target. The
  // journal digest proves what the target contained before promotion; without
  // matching the backup bytes to that digest, copying a damaged backup would
  // turn corruption into an apparently successful rollback and then delete the
  // only recovery evidence.
  for (const record of fileRecords.slice().reverse()) {
    const target = record.target;
    try {
      if (record.existed && !/^[0-9a-f]{64}$/.test(record.beforeDigest ?? "")) {
        throw new Error("Rollback backup has no valid before digest; preserving recovery state");
      }
      let needsRestore = true;
      if (record.expectedAfter) {
        const current = await pathExists(target) ? sha256(await fsp.readFile(target, "utf8")) : null;
        if (current === record.beforeDigest) needsRestore = false;
        else if (current !== record.expectedAfter) throw new Error("Rollback CAS conflict; preserving concurrent modification");
      }
      if (!record.existed) continue;
      const backupPath = path.join(journal.stateDir, "backups", record.backup);
      if (!needsRestore) {
        // The target already holds its baseline, so no backup is needed to
        // complete this target. One that is *absent* was deleted by a previous
        // rollback that was interrupted while removing the state directory: that
        // is the post-restore cleanup window, not evidence about this target, and
        // refusing here made a normal crash unrecoverable because the targets
        // were already correct. A backup that still exists must verify - a
        // damaged one is a scene the operator has to see.
        try { await fsp.access(backupPath); } catch { continue; }
      }
      const backup = await fsp.readFile(backupPath);
      if (sha256(backup.toString("utf8")) !== record.beforeDigest) {
        throw new Error("Rollback backup digest mismatch; preserving recovery state");
      }
      if (needsRestore) verifiedBackups.set(target, backup);
    } catch (error) {
      failures.push({ target, ...safeErrorDto(error, "rollback") });
    }
  }
  if (failures.length === 0) {
    for (const record of records.slice().reverse()) {
      const target = record.target;
      if (typeof target !== "string" || target.length === 0) continue;
      try {
        if (record.type === "file") {
          if (record.expectedAfter) {
            const current = await pathExists(target) ? sha256(await fsp.readFile(target, "utf8")) : null;
            if (current === record.beforeDigest) continue;
            if (current !== record.expectedAfter) throw new Error("Rollback CAS conflict; preserving concurrent modification");
          }
          if (record.existed) {
            const backup = verifiedBackups.get(target);
            if (!backup) throw new Error("Rollback backup was not verified; preserving recovery state");
            await writeAtomic(target, backup, { durable: true });
          } else {
            await fsp.rm(target, { force: true });
          }
        } else if (record.type === "path" || record.type === "symlink") {
          await fsp.rm(target, { recursive: record.type === "path", force: true });
        }
      } catch (error) {
        // The rollback failure list is durable (promotion journal and the failure
        // sidecar), so its provider text crosses the safe-error boundary here.
        failures.push({ target, ...safeErrorDto(error, "rollback") });
      }
    }
  }
  // Disk rollback is not runtime rollback. Join the official Include's
  // removal/disposal before claiming recovery or deleting its journal.
  if (paths?.promotionRuntime) {
    try { await paths.promotionRuntime.refresh(); } catch (error) {
      // A failed refresh is a rollback step failure like any other: the same
      // boundary, the same durable fields, and no raw message.
      failures.push({ target: paths.compositionPath, ...safeErrorDto(error, "rollback") });
    }
  }
  if (failures.length > 0) {
    journal.phase = "rollback-failed";
    journal.rollbackFailures = failures;
    await writeJournal(path.join(journal.stateDir, "journal.json"), journal).catch(() => {});
    const error = new Error(`Evolution promotion rollback failed for ${failures.length} target(s); journal preserved at ${journal.stateDir}`);
    // The journal is preserved, so the files it still describes are live
    // evidence. The caller must not write its terminal archive over one of
    // them; the marker is what lets it put the failure record somewhere else
    // instead (AGENTS.md invariant 2: never delete the scene). It is the same
    // projection the sidecar writes, so no boundary receives raw error text.
    error.promotionJournal = safePromotionJournalForPersistence({
      phase: "rollback-failed",
      stateDir: journal.stateDir,
      journalPath: path.join(journal.stateDir, "journal.json"),
      failures,
    });
    throw error;
  }
  if (journal.stageDir) await fsp.rm(journal.stageDir, { recursive: true, force: true });
  await fsp.rm(journal.stateDir, { recursive: true, force: true });
  return { ok: true };
}

/**
 * A promotion state directory is only "no transaction" when it is absent.
 * This is the single directory-presence rule shared by startup recovery and the
 * canary reader; journal *phase* classification stays in
 * `classifyPromotionJournal`.
 */
async function promotionStateKnown(paths) {
  if (await pathExists(path.join(paths.promotionStateDir, "journal.json"))) return true;
  if (await pathExists(paths.promotionStateDir)) {
    throw new Error(`Evolution promotion state directory exists without a readable journal.json; refusing to guess at its state and preserving ${paths.promotionStateDir}`);
  }
  return false;
}

/** Recover a promotion interrupted between journal commit phases. */
export async function recoverInterruptedPromotion(paths) {
  if (!await promotionStateKnown(paths)) return { recovered: false, status: "none" };
  const journalPath = path.join(paths.promotionStateDir, "journal.json");
  let journal;
  try {
    journal = JSON.parse(await fsp.readFile(journalPath, "utf8"));
  } catch (error) {
    // The journal is durable user data: a parse failure must not echo its bytes.
    throw new Error(`Evolution promotion journal is unreadable: ${redactJsonParseMessage(String(error?.message ?? error))}`);
  }
  const classification = classifyPromotionJournal(journal, paths);
  assertJournalRecoverable(journal, classification);
  const { state } = classification;
  if (state === "committed-pending-cleanup") {
    // The canary barriers only exist in this journal until the state directory
    // is removed, so they are persisted (monotonic merge) into the sidecar and
    // the archive first. A failed evidence write throws and keeps the journal.
    await persistCommittedCanaryEvidence(journal, paths);
    await fsp.rm(journal.stateDir, { recursive: true, force: true }).catch(() => {});
    return { recovered: true, status: "committed-cleaned" };
  }
  if (state === "canary-observing") {
    return { recovered: false, status: "canary-pending", experimentId: journal.experimentId, journal };
  }
  await rollbackPromotionJournal(journal);
  return { recovered: true, status: "rolled-back", experimentId: journal.experimentId };
}

/** A contained host diagnostic; a logger that throws cannot fail startup. */
function containedWarn(ctx, message) {
  try {
    const logged = ctx?.logger?.warn?.(message);
    if (logged && typeof logged.catch === "function") void logged.catch(() => {});
  } catch {
    // Diagnostics are not a lifecycle step.
  }
}

/**
 * Reconcile the cross-entry publication index from durable stable facts.
 *
 * Runs once at kernel startup, after interrupted transactions were recovered and
 * after the promoted Include mounted. It only republishes stable commits whose
 * evidence sidecar records an explicit cross-entry approval and whose published
 * record is missing (for example a crash between the stable journal phase and
 * the journal cleanup, or between the stable commit and the index write). It
 * never creates an approval, never reopens a canary, never touches a consumer
 * profile and never deletes a record or a plugin.
 */
export async function reconcileSharedPromotions(config = {}) {
  const ctx = config.ctx;
  const paths = {
    dataRoot: config.presetDir || config.dataRoot,
    pluginRoot: config.pluginRoot,
    archiveDir: config.archiveDir,
  };
  if (!paths.dataRoot || !paths.pluginRoot || !paths.archiveDir) {
    return { status: "not-configured", published: [], unchanged: 0, skipped: [] };
  }
  let packageOf;
  try {
    const packages = ctx?.get?.("pluginPackages");
    if (packages && typeof packages.packageOf === "function") packageOf = (name, baseUrl) => packages.packageOf(name, baseUrl);
  } catch {
    packageOf = undefined;
  }
  let profile = null;
  try { profile = ctx?.get?.("profileContext")?.name ?? null; } catch { profile = null; }
  const host = captureHostFacts({ packageOf, profile, baseUrl: ctx?.baseUrl });
  const capabilities = probeSharedCapabilities({ ctx, includeCapabilities: config.promotionRuntime?.capabilities });
  const result = await reconcileSharedIndex({ paths, host, capabilities, maxRecords: config.maxSharedRecords });
  if (Array.isArray(result.published) && result.published.length > 0) {
    containedWarn(ctx, `[evolution] republished ${result.published.length} shared plugin record(s) from durable stable evidence`);
  }
  if (Array.isArray(result.skipped) && result.skipped.length > 0) {
    containedWarn(ctx, `[evolution] ${result.skipped.length} shared plugin record(s) were not republished`);
  }
  return result;
}

async function verifyDurablePromotion({ pluginName, pluginPath, compositionPath, rowId, promotionRuntime }) {
  const modulePath = path.join(pluginPath, "lib", "index.js");
  const packageJsonPath = path.join(pluginPath, "package.json");
  if (!await pathExists(modulePath) || !await pathExists(packageJsonPath)) throw new Error("Promotion verify failed: plugin files are missing");
  const manifest = JSON.parse(await fsp.readFile(packageJsonPath, "utf8"));
  if (manifest.name !== pluginName || manifest.main !== "lib/index.js") throw new Error("Promotion verify failed: plugin manifest mismatch");
  if (!promotionRuntime?.verify || !promotionRuntime?.parse) throw new Error("Promotion requires the official Include adapter");
  const moduleUrl = pathToFileURL(modulePath).href;
  const entries = promotionRuntime.parse(await fsp.readFile(compositionPath, "utf8"));
  const rows = entries.filter(entry => entry.id === rowId);
  if (rows.length !== 1 || rows[0].name !== moduleUrl || rows[0].disabled) {
    throw new Error("Promotion verify failed: composition row is not reloadable");
  }
  return { plugin: true, composition: true, ...await promotionRuntime.verify(rowId, moduleUrl) };
}

async function writeDurablePromotionUnlocked({ experiment, packageInspection, paths, canaryWindow = 2, canaryVerification = null, publicationHost = null }) {
  const recovered = await recoverInterruptedPromotion(paths);
  if (recovered.status === "canary-pending") throw new Error(`Evolution promotion canary is still pending for ${recovered.experimentId}`);
  const durableId = sha256(experiment.id).slice(0, 12);
  const pluginName = `dsh-evolution-promoted-${durableId}`;
  const rowId = `evolution-promoted-${durableId}`;
  if (packageInspection?.code?.client !== undefined) throw new Error("Promotion currently requires a Host-only Package; Client activation still needs an approval-aware durable composition");
  const hostCode = text(packageInspection?.code?.host, "Package host code");
  const pluginPath = path.join(paths.pluginRoot, pluginName);
  const modulePath = path.join(pluginPath, "lib", "index.js");
  const packageJsonPath = path.join(pluginPath, "package.json");
  if (!paths.promotionRuntime?.verify || !paths.promotionRuntime?.refresh) throw new Error("Promotion requires the official Include adapter");
  assertPromotableHostSource(hostCode);
  // Resolve and load the sandbox helpers before the first disk write of this
  // transaction. A resolution failure here must not leave a promotion state
  // directory without a journal (recovery reports that as permanently blocked);
  // the generated module is also what later records digest, so it is part of
  // the plan, not a side effect of committing it.
  const harnessUrl = /\bharness\b/.test(hostCode) ? await requirePromotedHarnessUrl(paths) : null;
  const moduleContent = packageSource(hostCode, pluginName, harnessUrl);
  const moduleUrl = pathToFileURL(modulePath).href;
  if (await pathExists(pluginPath)) throw new Error(`Promotion target already exists: ${pluginName}`);

  const compositionCapture = await capturePromotionTarget(paths.compositionPath);
  const evolutionCapture = await capturePromotionTarget(paths.evolutionPath);
  const compositionBefore = compositionCapture.before ?? "";
  const evolutionBefore = evolutionCapture.before ?? "";
  const entries = paths.promotionRuntime.parse(compositionBefore);
  if (entries.some(entry => entry.id === rowId || entry.name === moduleUrl)) throw new Error(`Promotion row already exists: ${rowId}`);
  const compositionAfter = paths.promotionRuntime.stringify([...entries, { id: rowId, name: moduleUrl }]);
  const archivePath = path.join(paths.archiveDir, `${experiment.id}.md`);
  // This is the second renderer: it writes the promotion archive itself instead
  // of calling `renderExperimentArchive`, so the fields it interpolates are
  // projected here as well. Capture-time projection covers `proposal.why` today,
  // and that is exactly why this cannot be the only defence — the same renderer
  // runs over a record that was restored from a durable snapshot. The proof is
  // already projected where it is captured (`safeProofForPersistence`) and this
  // block renders it as JSON, so it is not projected a third time.
  const safeProposal = compactValue(experiment.proposal, EVIDENCE_PROJECTION);
  const observationRendered = compactValue(experiment.latestObservation || {}, EVIDENCE_PROJECTION);
  const archive = [
    `# Evolution experiment ${experiment.id}`,
    "",
    `- state: ${String(experiment.state).startsWith("promotion-") || experiment.state === "promoting" ? "canary-observing" : experiment.state}`,
    `- owner: ${safeProposal.owner}`,
    `- created: ${safeProposal.createdAt}`,
    `- promoted: ${now()}`,
    `- durable plugin: ${pluginName}`,
    `- source sha256: ${crypto.createHash("sha256").update(hostCode).digest("hex")}`,
    ...(Array.isArray(experiment.shareTargets) && experiment.shareTargets.length > 0
      ? [`- shared with: ${experiment.shareTargets.join(", ")} (after a stable canary commit)`]
      : []),
    "",
    "## Proposal",
    `- why: ${safeProposal.why}`,
    `- target: ${safeProposal.target}`,
    `- impact: ${safeProposal.impactScope.join(", ")}`,
    `- success metrics: ${safeProposal.successMetrics.join("; ")}`,
    "",
    "## Observation",
    "```json",
    JSON.stringify(observationRendered, null, 2),
    "```",
    "",
    "## Runtime recovery",
    `- recovered: ${experiment.runtimeRecovered === true}`,
    `- proof: ${JSON.stringify(experiment.recoveryProof || experiment.cleanupProof || { status: experiment.runtimeRecovered === true ? "recovered" : "unknown" })}`,
    `- rollback: remove ${paths.compositionPath} row ${rowId}, remove ${pluginPath}, and start a new session`,
    "",
  ].join("\n");
  const evolutionAfter = updateEvolutionPointer(evolutionBefore, experiment, { pluginName, pluginPath, presetId: paths.presetId, rowId, archivePath });
  // Every planned file and its rollback baseline come from one capture taken
  // before the plan is built. Reading the target again when the records are
  // written (the previous order) let an external edit land in between: the plan
  // was generated from the old bytes while the CAS baseline hashed the new ones,
  // so the conflict check passed and the edit was overwritten.
  const archiveCapture = await capturePromotionTarget(archivePath);
  const stateDir = paths.promotionStateDir;
  const journalPath = path.join(stateDir, "journal.json");
  // Recovery above refuses an unknown state directory and removes one it
  // classified for rollback/cleanup. Reaching this point means the directory
  // must be absent: create it, but never delete a directory whose provenance
  // this process has not proven.
  if (await pathExists(stateDir)) throw new Error(`Evolution promotion state directory is not clean and was not removed by recovery: ${stateDir}`);
  await fsp.mkdir(path.join(stateDir, "backups"), { recursive: true, mode: 0o700 });
  const records = [];
  // The backup is written from the captured bytes, through the durable writer,
  // so the bytes the journal digests are the bytes on disk (a `copyFile` left
  // both the file and the new directory entry unsynced while the journal was
  // already durable).
  for (const [target, capture, after] of [
    [paths.compositionPath, compositionCapture, compositionAfter],
    [paths.evolutionPath, evolutionCapture, evolutionAfter],
    [archivePath, archiveCapture, archive],
  ]) {
    const key = crypto.createHash("sha256").update(target).digest("hex").slice(0, 16) + ".bak";
    if (capture.existed) await writeAtomic(path.join(stateDir, "backups", key), capture.before, { durable: true });
    records.push({ type: "file", target, existed: capture.existed, backup: key,
      beforeDigest: capture.existed ? sha256(capture.before) : null,
      expectedAfter: sha256(after) });
  }
  records.push({ type: "path", target: pluginPath, existed: false });
  // The publication identity binds the verified host to the exact bytes this
  // transaction will write. It is computed before the journal so the journal,
  // the evidence sidecar and the returned durable identity all carry the same
  // fact; reconciliation re-verifies these digests instead of trusting the
  // current file contents.
  const manifestContent = JSON.stringify({
    name: pluginName,
    version: "0.1.0",
    private: true,
    type: "module",
    main: "lib/index.js",
    files: ["lib"],
  }, null, 2) + "\n";
  const publication = normalizePublication({
    sourceSha256: sha256(moduleContent),
    manifestSha256: sha256(manifestContent),
    verifiedAt: now(),
    host: publicationHost ? { ...publicationHost, capturedAt: publicationHost.capturedAt || now() } : null,
  });
  const journal = {
    version: 1,
    phase: "prepared",
    experimentId: experiment.id,
    ownerId: experiment.ownerId,
    ...(Array.isArray(experiment.shareTargets) && experiment.shareTargets.length > 0
      ? { shareTargets: [...experiment.shareTargets] }
      : {}),
    ...(publication ? { publication } : {}),
    proposal: compactValue(experiment.proposal),
    targets: experiment.targets,
    stateDir,
    stageDir: path.join(stateDir, "stage"),
    records,
    canary: {
      promotionTimestamp: now(),
      healthObservationWindow: Math.max(1, Number(canaryWindow) || 2),
      startupVerified: false,
      observations: [],
      ...(canaryVerification ? { verification: publicCanaryObligation(canaryVerification) } : {}),
    },
    // Persist evidence at durable write time so the journal is the single
    // source of truth across sessions. observeCanary restores hydrate from
    // this field rather than rebuilding empty.
    evidenceSnapshot: {
      ...snapshotEvidenceFromRecord(experiment),
      ...(publication ? { publication } : {}),
    },
  };
  await writeJournal(journalPath, journal);
  // Also write the snapshot next to the durable archive so it survives
  // journal deletion on stable commit.
  await persistEvidenceSnapshot(paths.archiveDir, experiment.id, journal.evidenceSnapshot);
  try {
    await fsp.mkdir(journal.stageDir, { recursive: true });
    journal.phase = "committing";
    await writeJournal(journalPath, journal);
    await fsp.mkdir(path.join(pluginPath, "lib"), { recursive: true });
    await writeAtomic(modulePath, moduleContent, { durable: true });
    await writeAtomic(packageJsonPath, manifestContent, { durable: true });
    // `writeAtomic` fsyncs a directory entry only when *it* created that
    // directory, and `mkdir()` above created `pluginPath/lib` (and, on a first
    // promotion, `pluginPath` and `pluginRoot`). Without these three fsyncs the
    // durable journal could reach `canary-observing` - and recovery could report
    // `canary-pending` - while the plugin tree it names was still only in the
    // page cache, so Include would load a module the disk no longer has.
    syncDirectoryEntry(path.join(pluginPath, "lib"));
    syncDirectoryEntry(pluginPath);
    syncDirectoryEntry(paths.pluginRoot);
    // Every planned file is compared against the digest captured at prepare,
    // not only the composition: EVOLUTION.md and the archive are the same kind
    // of evidence, and an external edit of either is the same conflict.
    for (const record of records) {
      if (record.type !== "file") continue;
      const current = await pathExists(record.target) ? sha256(await fsp.readFile(record.target, "utf8")) : null;
      if (current !== record.beforeDigest) {
        throw new Error(`Promotion target ${record.target} changed after prepare; refusing to overwrite concurrent modification`);
      }
    }
    await writeAtomic(paths.compositionPath, compositionAfter, { durable: true });
    await writeAtomic(paths.evolutionPath, evolutionAfter, { durable: true });
    await writeAtomic(archivePath, archive, { durable: true });
    const verification = await verifyDurablePromotion({ pluginName, pluginPath, compositionPath: paths.compositionPath, rowId, promotionRuntime: paths.promotionRuntime });
    journal.phase = "canary-observing";
    journal.verification = verification;
    journal.durable = {
      pluginName, pluginPath, moduleUrl, rowId, archivePath, presetId: paths.presetId, adapter: "official-include",
      ...(publication ? { publication } : {}),
    };
    await writeJournal(journalPath, journal);
  } catch (error) {
    await rollbackPromotionJournal(journal, paths);
    throw error;
  }
  return {
    pluginName,
    pluginPath,
    moduleUrl,
    adapter: "official-include",
    rowId,
    archivePath,
    presetId: paths.presetId,
    ...(publication ? { publication } : {}),
    journalPath,
    promotionTimestamp: journal.canary.promotionTimestamp,
    healthObservationWindow: journal.canary.healthObservationWindow,
    ...(journal.canary.verification ? { canaryVerification: publicCanaryObligation(journal.canary.verification) } : {}),
  };
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Remove only a lock whose owner is provably gone or whose unowned metadata
 * has exceeded the TTL.  A live PID always wins over the TTL so an active
 * promotion can never be stolen by a second process.
 */
// Tokens this process is holding right now (see `writeDurablePromotion`).
const heldPromotionTokens = new Set();

export async function recoverStalePromotionLock({ lockPath, ttlMs = 15 * 60 * 1000, nowMs = Date.now() } = {}) {
  if (!lockPath) throw new Error("promotion lock path is required");
  let stat;
  try {
    stat = await fsp.lstat(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { recovered: false, status: "none" };
    throw error;
  }
  if (!stat.isDirectory()) throw new Error("Evolution promotion lock is not a directory; refusing to remove it");
  const metadataPath = path.join(lockPath, "lock.json");
  let metadata = null;
  try {
    metadata = JSON.parse(await fsp.readFile(metadataPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.name !== "SyntaxError") {
      throw new Error(`Evolution promotion lock metadata is unreadable: ${error.message}`);
    }
  }
  const createdAt = Date.parse(metadata?.createdAt || metadata?.timestamp || "") || stat.mtimeMs;
  const ageMs = Math.max(0, nowMs - createdAt);
  const pid = Number(metadata?.pid);
  const sameHost = !metadata?.hostname || metadata.hostname === os.hostname();
  // A lock that names this process but a token this process is not holding is
  // its own unsuccessful cleanup, not a live owner. Cross-process semantics do
  // not change: another PID is still judged only by `processAlive`.
  const ownResidue = sameHost && Number.isInteger(pid) && pid === process.pid && !heldPromotionTokens.has(metadata?.token);
  const active = sameHost && processAlive(pid) && !ownResidue;
  if (active) return { recovered: false, status: "active", owner: metadata, ageMs };
  const stale = ownResidue
    || !Number.isFinite(createdAt)
    || ageMs >= Math.max(1, Number(ttlMs) || 15 * 60 * 1000)
    || (metadata && sameHost && Number.isInteger(pid) && !processAlive(pid));
  if (!stale) return { recovered: false, status: "fresh-unowned", owner: metadata, ageMs };
  // Judging the lock stale and removing it are two steps, and another process
  // can finish its own recovery (or start a new promotion) in between. Take the
  // directory away with one atomic rename, then prove the quarantined directory
  // is the one this call judged stale before deleting anything; a replacement
  // lock is renamed back and never reported as recovered.
  const quarantine = `${lockPath}.${process.pid}-${crypto.randomUUID()}.stale`;
  try {
    await fsp.rename(lockPath, quarantine);
  } catch (error) {
    if (error?.code === "ENOENT") return { recovered: false, status: "none" };
    throw error;
  }
  let quarantined;
  let quarantinedMetadata = null;
  try {
    quarantined = await fsp.lstat(quarantine);
    quarantinedMetadata = JSON.parse(await fsp.readFile(path.join(quarantine, "lock.json"), "utf8"));
  } catch (error) {
    if (error?.name !== "SyntaxError" && error?.code !== "ENOENT") {
      throw new Error(`Evolution promotion lock quarantine is unreadable: ${error.message}`);
    }
  }
  const sameInode = quarantined?.dev === stat.dev && quarantined?.ino === stat.ino;
  const sameOwner = metadata?.token === undefined || quarantinedMetadata?.token === metadata.token;
  if (!sameInode || !sameOwner) {
    try {
      await fsp.rename(quarantine, lockPath);
    } catch (error) {
      throw new Error(`Evolution promotion lock was replaced by another owner and could not be restored from ${quarantine}: ${error.message}`);
    }
    return { recovered: false, status: "lock-replaced", owner: metadata, ageMs };
  }
  await fsp.rm(quarantine, { recursive: true, force: true });
  return { recovered: true, status: "stale-recovered", owner: metadata, ageMs };
}

/**
 * Durable promotion primitive: the journaled composition commit and nothing
 * else. Owner confirmation (`confirmation: true`), the eight promotion gates and
 * the owner check live in `EvolutionOrchestrator.promote()`. This module is
 * exported as `dsh-evolution/core` for host-level integrators; a caller that
 * imports it directly owns those gates itself. It is never a tool path.
 */
export async function writeDurablePromotion(options) {
  const lockDir = options.paths.promotionLockPath || `${options.paths.promotionStateDir}.lock`;
  await recoverStalePromotionLock({ lockPath: lockDir, ttlMs: options.lockTtlMs });
  const token = crypto.randomUUID();
  try {
    await fsp.mkdir(lockDir, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("another Evolution promotion owns the composition commit target");
    throw error;
  }
  // Register the token before the metadata lands. The residue rule reclaims a
  // lock that names this process but a token it does not hold, so a concurrent
  // call in this process must never be able to observe our pid with our token
  // still missing from the set: that would let it rename a live lock away.
  heldPromotionTokens.add(token);
  try {
    await writeAtomic(path.join(lockDir, "lock.json"), JSON.stringify({
      schema: 1,
      token,
      pid: process.pid,
      hostname: os.hostname(),
      owner: options.experiment?.ownerId || "unknown",
      operation: "promotion",
      createdAt: now(),
    }, null, 2) + "\n");
  } catch (error) {
    // This call created the directory and no other owner can have written into
    // it, so a lock without metadata would block every later promotion until
    // the TTL. Remove exactly what this call made and report the real failure.
    try { await fsp.rm(lockDir, { recursive: true, force: true }); } catch { /* the TTL reclaims it */ }
    heldPromotionTokens.delete(token);
    throw error;
  }
  try {
    return await writeDurablePromotionUnlocked(options);
  } finally {
    try {
      const current = JSON.parse(await fsp.readFile(path.join(lockDir, "lock.json"), "utf8"));
      if (current.token === token) await fsp.rm(lockDir, { recursive: true, force: true });
    } catch {
      // Preserve an unknown/replaced lock rather than removing another
      // process's ownership record.
    } finally {
      // A failed removal must not turn this process's own residue into a live
      // owner: once the token is no longer held, the next call reclaims it.
      heldPromotionTokens.delete(token);
    }
  }
}

async function readCanaryJournal(paths) {
  if (!await promotionStateKnown(paths)) return null;
  const journalPath = path.join(paths.promotionStateDir, "journal.json");
  let journal;
  try {
    journal = JSON.parse(await fsp.readFile(journalPath, "utf8"));
  } catch (error) {
    // Same boundary as recovery: the parse message may quote the journal.
    throw new Error(`Evolution promotion journal is unreadable: ${redactJsonParseMessage(String(error?.message ?? error))}`);
  }
  // A journal that cannot be classified, violates the boundary, or failed its
  // rollback must never be treated as "no journal": callers would otherwise
  // synthesize a fresh one and overwrite or delete the preserved evidence.
  const classification = classifyPromotionJournal(journal, paths);
  assertJournalRecoverable(journal, classification);
  return classification.state === "canary-observing" ? journal : null;
}

function executionFailureFingerprint(record = {}) {
  const failure = record.failure || {};
  // Older durable records used raw `error`; the failure DTO uses the digest.
  const error = failure.errorDigest ?? failure.error ?? null;
  return error || failure.errorCategory || failure.failurePhase
    ? `failure:${sha256(stableJson({
      phase: failure.failurePhase ?? null,
      category: failure.errorCategory ?? null,
      error,
      rootCauseHypothesis: failure.rootCauseHypothesis ?? null,
      nextPreventionHint: failure.nextPreventionHint ?? null,
    }))}`
    : null;
}

// The largest unterminated tail this writer verifies before appending. Event
// records are bounded by the projection bounds (a few KiB); a larger tail is not
// a record this writer produced, so the append is refused instead of guessed.
const EVENT_BRIDGE_TAIL_SCAN = 1024 * 1024;

const EVENT_BRIDGE_APPEND_LOCK = ".append.lock";
const EVENT_BRIDGE_RECLAIM_LOCK = ".reclaim";
// A live owner is never reclaimed; these windows only judge an unowned or
// foreign-host entry, and cap how long a writer waits for a live one.
const EVENT_BRIDGE_LOCK_STALE_MS = 2000;
const EVENT_BRIDGE_RECLAIM_STALE_MS = 10_000;
const EVENT_BRIDGE_LOCK_RETRY_MS = 5;
// Wait at most 500 ms for a live writer, which is far longer than one append.
const EVENT_BRIDGE_LOCK_ATTEMPTS = 100;
const eventBridgeLockTick = new Int32Array(new SharedArrayBuffer(4));

function readEventBridgeLockOwner(lockPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(lockPath, "owner"), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch { return null; }
}

/** A same-host owner is alive unless the OS proves the pid gone (`ESRCH`). */
function eventBridgeLockOwnerAlive(owner) {
  if (!owner || owner.hostname !== os.hostname()) return false;
  const pid = Number(owner.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; }
}

function eventBridgeLockAge(lockPath, nowMs) {
  try { return nowMs - fs.statSync(lockPath).mtimeMs; } catch { return 0; }
}

/**
 * Remove the lock only while the state read *now* proves it may go. The
 * exclusive marker is a sibling file, never a child: creating a child refreshes
 * the directory mtime the age is judged by, and a marker inside the directory
 * would be deleted with it. The caller must hold the marker, so two reclaimers
 * cannot act on one another's snapshot - the previous version cached the age
 * before `mkdir(marker)`, and a second reclaimer could delete the fresh lock the
 * first had just created while its owner record was still being written.
 */
function reclaimEventBridgeLock(lockPath, markerPath) {
  const owner = readEventBridgeLockOwner(lockPath);
  if (eventBridgeLockOwnerAlive(owner)) return false;
  if (owner && owner.hostname === os.hostname()) {
    // Same host and the pid is gone: proven dead, no TTL needed.
    try { fs.rmSync(lockPath, { recursive: true, force: true }); return true; } catch { return false; }
  }
  // A foreign host or an unowned entry can only be judged by age, read after the
  // marker was acquired (so the entry judged is the one that is there now).
  if (eventBridgeLockAge(lockPath, Date.now()) <= EVENT_BRIDGE_LOCK_STALE_MS) return false;
  try { fs.rmSync(lockPath, { recursive: true, force: true }); return true; } catch { return false; }
}

function tryClaimReclaimMarker(markerPath) {
  try {
    const descriptor = fs.openSync(markerPath, "wx", 0o600);
    fs.closeSync(descriptor);
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") return false;
    // A marker left by a crashed reclaimer would wedge every later attempt; it
    // is only held for a few syscalls, so an old one can be removed.
    try {
      if (Date.now() - fs.statSync(markerPath).mtimeMs > EVENT_BRIDGE_RECLAIM_STALE_MS) fs.unlinkSync(markerPath);
    } catch { /* another reclaimer removed or refreshed it */ }
    return false;
  }
}

function releaseReclaimMarker(markerPath) {
  try { fs.unlinkSync(markerPath); } catch { /* already gone */ }
}

/**
 * Serialize appends across processes. A single `write(2)` with O_APPEND is
 * atomic for a regular file, but this writer verifies the tail and may resume a
 * short write in several calls; two writers doing that at once can interleave
 * one record's bytes with another's and split both into unparseable lines.
 *
 * The lock is a directory carrying `{token, pid, hostname, acquiredAt}`. A live
 * same-host pid is never reclaimed, however old the marker is: a slow fsync must
 * not let a second writer in. A pid the OS proves gone is reclaimed at once, and
 * an unowned or foreign-host entry only after the stale window (this protocol,
 * like the promotion claim, covers one host and one data root).
 */
function acquireEventBridgeAppendLock(lockPath) {
  const token = crypto.randomUUID();
  const owner = JSON.stringify({ token, pid: process.pid, hostname: os.hostname(), acquiredAt: Date.now() });
  const markerPath = `${lockPath}${EVENT_BRIDGE_RECLAIM_LOCK}`;
  for (let attempt = 0; attempt < EVENT_BRIDGE_LOCK_ATTEMPTS; attempt += 1) {
    let created = false;
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    if (created) {
      let ownerFd;
      try {
        ownerFd = fs.openSync(path.join(lockPath, "owner"), "wx", 0o600);
        const bytes = Buffer.from(owner, "utf8");
        let offset = 0;
        while (offset < bytes.length) {
          const written = rawWriteSync(ownerFd, bytes, offset, bytes.length - offset);
          if (!Number.isInteger(written) || written <= 0) {
            throw new Error("Evolution execution event bridge append lock could not write its owner record");
          }
          offset += written;
        }
        return token;
      } catch (error) {
        // This call created the directory and no other owner can have written
        // into it; remove exactly what this call made and report the failure.
        try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* reclaimed later */ }
        throw error;
      } finally {
        try { if (ownerFd !== undefined) fs.closeSync(ownerFd); } catch { /* already closed */ }
      }
    }
    const held = readEventBridgeLockOwner(lockPath);
    if (!eventBridgeLockOwnerAlive(held) && tryClaimReclaimMarker(markerPath)) {
      try {
        if (reclaimEventBridgeLock(lockPath, markerPath)) continue;
      } finally {
        releaseReclaimMarker(markerPath);
      }
    }
    Atomics.wait(eventBridgeLockTick, 0, 0, EVENT_BRIDGE_LOCK_RETRY_MS);
  }
  // Named, because "another writer holds it" is the one outcome a caller may
  // retry: a rewrite that cannot take the lock must be able to say so, and a
  // failure that is not this must not be reported as if it were.
  const error = new Error("Evolution execution event bridge append lock is held by another writer; refusing to interleave a record");
  error.code = EVENT_BRIDGE_APPEND_LOCK_BUSY;
  throw error;
}

/**
 * Hold the append lock across one operation that rewrites the log.
 *
 * Appenders take this lock around their tail check and their append, so a
 * rewrite that took it too cannot interleave with a record that is being added:
 * without it, a rename between an appender's `open` and its `write` sends the
 * record into the inode the rename detached, and the record is gone. The caller
 * gets the same refusal an appender gets when a live writer holds it; a reclaim
 * that cannot take the lock discards nothing.
 */
export function withEventBridgeAppendLock(file, operation) {
  const lockPath = `${file}${EVENT_BRIDGE_APPEND_LOCK}`;
  const token = acquireEventBridgeAppendLock(lockPath);
  try { return operation(); }
  finally { releaseEventBridgeAppendLock(lockPath, token); }
}

/** Release only the lock that still carries this call's token. */
function releaseEventBridgeAppendLock(lockPath, token) {
  const held = readEventBridgeLockOwner(lockPath);
  if (!held || held.token !== token) return;
  try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* the ownerless entry is reclaimed later */ }
}

function readLastEventBridgeLine(fd, size) {
  const length = Math.min(size, EVENT_BRIDGE_TAIL_SCAN);
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = fs.readSync(fd, buffer, read, length - read, size - length + read);
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error("Evolution execution event bridge could not read its last record; refusing to append");
    }
    read += count;
  }
  const newline = buffer.lastIndexOf(0x0a);
  if (newline < 0 && length < size) {
    throw new Error("Evolution execution event bridge last record is larger than the verification window; refusing to append");
  }
  return buffer.subarray(newline + 1).toString("utf8");
}

/**
 * Small, append-only A→B transport. It carries execution facts only; the
 * runtime memory plane owns interpretation, deduplication, lineage, and GC.
 * Duplicate lines are intentional at-least-once delivery and are made
 * idempotent by EvolutionMemory.applyExecutionEvent().
 */
export class EvolutionEventBridge {
  constructor({ file, key = process.env.DSH_EVOLUTION_EVENT_BRIDGE_KEY, writer = EVENT_BRIDGE_DEFAULT_WRITER, scanChunkBytes = EVENT_BRIDGE_SCAN_CHUNK_BYTES, onVerifiedEvent } = {}) {
    this.file = file;
    this.key = key;
    this.writer = writer;
    this.seen = new Set();
    this.sequence = 0;
    this.pending = null;
    this.onVerifiedEvent = onVerifiedEvent;
    if (this.file) {
      if (!Number.isSafeInteger(scanChunkBytes) || scanChunkBytes < 1) {
        throw new RangeError("scanChunkBytes must be a positive safe integer");
      }
      // Split at the LF byte before decoding: LF cannot occur inside a
      // multi-byte UTF-8 sequence, so decoding each complete line range with
      // Buffer.toString("utf8") has the same replacement behavior as decoding
      // the whole file and then splitting it. The reusable chunk and one-line
      // carry target lower peak RSS, not less per-record work.
      const scanBuffer = Buffer.allocUnsafe(scanChunkBytes);
      let descriptor;
      let scanError = null;
      // A line that spans chunks is held as its byte segments and joined once,
      // when its LF arrives. Repeated `Buffer.concat` into a single carry would
      // be quadratic in the length of a line that never ends: a corrupt log with
      // no LF at all would pay one growing copy per chunk instead of one join.
      let carry = [];
      let carryBytes = 0;
      const takeLine = (segment) => {
        const bytes = carryBytes === 0 ? segment : Buffer.concat([...carry, segment], carryBytes + segment.length);
        carry = [];
        carryBytes = 0;
        return bytes.toString("utf8");
      };
      const holdSegment = (segment) => {
        carry.push(Buffer.from(segment));
        carryBytes += segment.length;
      };
      const consumeLine = (line) => {
        if (!line.trim()) return;
        try {
          const stored = JSON.parse(line);
          const verified = verifyEventBridgeEnvelope(stored, this.key);
          // A valid MAC alone does not make a record this installation's own:
          // a foreign writer's eventId must not occupy a dedup slot, or the
          // trusted event carrying it would be silently skipped. The sequence
          // and the dedup slot stay behind the same gate.
          if (!eventBridgeWriterTrusted(verified, this.writer)) return;
          this.sequence = Math.max(this.sequence, verified.sequence);
          if (typeof verified.event?.eventId === "string") this.seen.add(verified.event.eventId);
          onVerifiedEvent?.(verified.event, { sequence: verified.sequence, writer: verified.writer });
        } catch { /* B remains fail-closed when it replays malformed content. */ }
      };
      try {
        descriptor = fs.openSync(this.file, "r");
        while (true) {
          const length = fs.readSync(descriptor, scanBuffer, 0, scanBuffer.length, null);
          if (length === 0) break;
          let start = 0;
          let index = scanBuffer.indexOf(0x0a, start);
          while (index !== -1 && index < length) {
            consumeLine(takeLine(scanBuffer.subarray(start, index)));
            start = index + 1;
            index = scanBuffer.indexOf(0x0a, start);
          }
          if (start < length) holdSegment(scanBuffer.subarray(start, length));
        }
        // `split("\n")` also yields a final element after a trailing LF, or one
        // empty element for an empty file; consuming an empty line keeps those
        // cases on the same `trim()` path as every other logical line.
        consumeLine(carryBytes === 0 ? "" : takeLine(EMPTY_SEGMENT));
      } catch (error) {
        if (error?.code !== "ENOENT") scanError = error;
      } finally {
        if (descriptor !== undefined) {
          try { fs.closeSync(descriptor); }
          catch (error) { if (!scanError && error?.code !== "ENOENT") scanError = error; }
        }
      }
      if (scanError) throw scanError;
    }
  }

  project(type, record = {}, payload = {}) {
    if (!EXECUTION_EVENT_TYPES.has(type)) throw new Error(`Unknown Evolution execution event type: ${type}`);
    const experimentId = String(payload.experimentId ?? record.id ?? "").trim();
    if (!experimentId) throw new Error("Evolution execution event requires experimentId");
    const proposalId = String(payload.proposalId ?? record.proposalId ?? record.id ?? "").trim() || null;
    const target = payload.target ?? record.proposal?.target ?? record.targets?.[0] ?? null;
    const capability = payload.capability ?? target ?? null;
    const lineageId = payload.lineageId ?? record.proposal?.lineageId ?? capability ?? null;
    const event = {
      schema: 1,
      eventId: `evolution:${type}:${experimentId}`,
      eventType: type,
      experimentId,
      proposalId,
      target,
      capability,
      lineageId,
      status: payload.status ?? record.state ?? null,
      predecessor: payload.predecessor ?? record.proposal?.predecessor ?? record.predecessor ?? null,
      supersedes: payload.supersedes ?? record.proposal?.supersedes ?? record.supersedes ?? null,
      // An explicit payload measurement is projected here too. `measure()`
      // already projects the observation it emits, but `project()` is a public
      // boundary and a caller can hand it an unprojected object; the boundary is
      // the place that decides, not the caller (this is the same `compactValue`
      // row projection the record-derived branch has always used).
      measurement: payload.measurement === undefined || payload.measurement === null
        ? (record.latestObservation ? compactValue(record.latestObservation) : null)
        : compactValue(payload.measurement),
      // `learn: false` marks an event that must stay observable without becoming
      // a durable "do not repeat this" verdict. The domain turns any event that
      // carries a fingerprint into an outcome with `dontRepeat: true`
      // (`#bridgeOutcome`), so a failure that is not evidence about the hypothesis
      // carries none at all. The payload itself keeps the `failure` object as
      // operation evidence.
      failureFingerprint: payload.learn === false ? null : (payload.failureFingerprint ?? executionFailureFingerprint(record)),
      failure: payload.failure ?? (record.failure ? compactValue(safeFailureForPersistence(record.failure)) : null),
      promotion: payload.promotion ?? (record.durable ? compactValue(record.durable) : null),
      canary: payload.canary ?? (record.canary ? compactValue(record.canary) : null),
      evidence: compactValue(payload.evidence ?? record.latestObservation ?? {}),
      audit: {
        producer: "dsh-evolution-orchestrator",
        version: "0.1.0",
        at: payload.at ?? now(),
      },
    };
    return toLosslessJson(event);
  }

  emit(type, record = {}, payload = {}) {
    const event = this.project(type, record, payload);
    if (!this.file) throw new Error("Evolution execution event bridge path is required");
    if (typeof this.key !== "string" || this.key.length < 16) throw new Error("Evolution execution event bridge requires an authentication key");
    // A previous call may have appended all (or part) of its line and then
    // failed during fsync. Complete that same signed envelope before creating
    // another sequence number: retrying with a new MAC would make an otherwise
    // valid duplicate eventId fail closed during domain replay.
    if (this.pending) {
      this.persistPending();
      if (this.seen.has(event.eventId)) return event;
    }
    if (this.seen.has(event.eventId)) return event;
    const envelope = signEventBridgeEnvelope(event, { key: this.key, writer: this.writer, sequence: ++this.sequence });
    this.pending = {
      event,
      sequence: envelope.sequence,
      line: Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8"),
      start: null,
      identity: null,
    };
    this.persistPending();
    return event;
  }

  persistPending() {
    const pending = this.pending;
    if (!pending) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    // One writer at a time, including across processes: the tail verification
    // below and the multi-call append must not interleave with another writer.
    const lockPath = `${this.file}${EVENT_BRIDGE_APPEND_LOCK}`;
    const lockToken = acquireEventBridgeAppendLock(lockPath);
    try {
      // `a+` preserves append semantics and also lets a retry verify the exact
      // prefix left by its previous attempt before it resumes. If a different
      // writer replaced or interleaved the pending bytes, fail closed and keep
      // the pending evidence instead of appending a second, conflicting envelope.
      const fd = fs.openSync(this.file, "a+", 0o600);
      try {
        const stat = fs.fstatSync(fd, { bigint: true });
        const identity = { dev: String(stat.dev), ino: String(stat.ino) };
        if (pending.identity && (pending.identity.dev !== identity.dev || pending.identity.ino !== identity.ino)) {
          throw new Error("Evolution execution event bridge pending append changed; refusing to resume it");
        }
        if (pending.start === null) {
          const end = Number(stat.size);
          // A crash can leave a complete, already-signed record without its
          // trailing newline. Replay accepts that shape as a valid remainder, so
          // appending straight onto it would glue two records into one line that
          // no later replay can parse, and the next startup would refuse the log.
          // Finish the separator as part of this append: the prefix verification
          // below covers it too, and a crash after it leaves at most an empty
          // line, which replay skips. An unterminated tail that does not verify
          // is a torn record: the append is refused so the tail stays the one
          // unterminated line the doctor's trim repair can still identify.
          let line = pending.line;
          if (end > 0) {
            const tail = Buffer.alloc(1);
            const read = fs.readSync(fd, tail, 0, 1, end - 1);
            if (!Number.isInteger(read) || read !== 1) {
              throw new Error("Evolution execution event bridge could not read its last byte; refusing to append a second record onto an unknown boundary");
            }
            if (tail[0] !== 0x0a) {
              const lastLine = readLastEventBridgeLine(fd, end);
              let complete = false;
              try { complete = Boolean(verifyEventBridgeEnvelope(JSON.parse(lastLine), this.key)); } catch { complete = false; }
              if (!complete) {
                throw new Error("Evolution execution event bridge ends with an incomplete or unverified record; refusing to append onto it");
              }
              line = Buffer.concat([Buffer.from("\n", "utf8"), pending.line]);
            }
          }
          // Only a boundary this call has *proven* may become the resumable
          // offset. Publishing it before the tail check let a refused append (a
          // torn tail) be retried as if the boundary were known, and the retry
          // appended onto the same torn record. The separator decision is part of
          // that proof, so it is published with it.
          pending.line = line;
          pending.start = end;
          pending.identity = identity;
        }
        if (stat.size < BigInt(pending.start)) {
          throw new Error("Evolution execution event bridge pending append was truncated; refusing to resume it");
        }
        const visible = Math.min(pending.line.length, Number(stat.size - BigInt(pending.start)));
        const prefix = Buffer.alloc(visible);
        let read = 0;
        while (read < visible) {
          const count = fs.readSync(fd, prefix, read, visible - read, pending.start + read);
          if (!Number.isInteger(count) || count <= 0) {
            throw new Error("Evolution execution event bridge pending append could not be verified; refusing to resume it");
          }
          read += count;
        }
        if (!prefix.equals(pending.line.subarray(0, visible))) {
          throw new Error("Evolution execution event bridge pending append was changed; refusing to resume it");
        }
        // A failed fsync can leave fewer visible bytes than the previous write
        // count. Resume from the verified on-disk prefix rather than trusting that
        // count or signing the same eventId again.
        let offset = visible;
        while (offset < pending.line.length) {
          const written = fs.writeSync(fd, pending.line, offset, pending.line.length - offset);
          if (!Number.isInteger(written) || written <= 0) {
            throw new Error(`Evolution execution event bridge wrote ${written} of ${pending.line.length - offset} bytes; refusing to treat a partial event as durable`);
          }
          offset += written;
        }
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      const dirfd = fs.openSync(path.dirname(this.file), "r");
      try { fs.fsyncSync(dirfd); } finally { fs.closeSync(dirfd); }
      this.seen.add(pending.event.eventId);
      this.pending = null;
    } finally {
      try { releaseEventBridgeAppendLock(lockPath, lockToken); } catch { /* a stale marker is reclaimed by the next writer */ }
    }
    this.onVerifiedEvent?.(pending.event, { sequence: pending.sequence, writer: this.writer });
  }
}

/**
 * Parse a claim document exactly once. The `error` marker keeps "the bytes are
 * not JSON" separate from "the document parsed to a value with no owner
 * fields": the acquisition treats the first as an unreadable file and the second
 * as a conflicting claim, and a JSON body of `null` is the second (it parses).
 */
export function parseTargetClaim(text) {
  if (typeof text !== "string") return { parsed: null, error: "not-text" };
  try { return { parsed: JSON.parse(text), error: null }; } catch { return { parsed: null, error: "not-json" }; }
}

/**
 * The one on-disk target claim protocol, classified from an already parsed
 * document.
 *
 * `acquireTargets()` parses, reads `experimentId` off the raw parsed value for
 * adoption, and only classifies after adoption was rejected - the pre-change
 * order, so the adoption read keeps the pre-change outcome (including the
 * TypeError a JSON body of `null` produced). `lib/diagnostics.js` runs the same
 * two steps in the same order but never adopts, so the runtime and the doctor
 * cannot disagree about what a claim file means (AGENTS.md §4 第 11 条：never a
 * second protocol on the same path).
 *
 * - `unreadable`   the bytes are not JSON, so no reader can ever adopt them
 * - `reclaimable`  same host, an integer pid, and that pid is gone
 * - `live`         same host and the recorded pid answers; a pid reused by an
 *                  unrelated process is indistinguishable from an in-flight trial
 * - `foreign-host` another hostname was recorded, so this host cannot tell
 * - `incomplete`   parseable, but carries no usable hostname/pid
 */
export const TARGET_CLAIM_STATES = Object.freeze({
  UNREADABLE: "unreadable",
  RECLAIMABLE: "reclaimable",
  LIVE: "live",
  FOREIGN_HOST: "foreign-host",
  INCOMPLETE: "incomplete",
});

/**
 * Liveness of a claim's recorded pid. Only `ESRCH` proves the owner is gone;
 * `EPERM` and every other error mean "cannot prove dead", so the claim is never
 * reclaimed on an unproven signal.
 */
function claimOwnerAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; }
}

export function classifyTargetClaim(parsed, { hostname = os.hostname(), alive = claimOwnerAlive } = {}) {
  if (!parsed || parsed.error !== null) return { state: TARGET_CLAIM_STATES.UNREADABLE, claim: null };
  const claim = parsed.parsed;
  // A document that parses but is not an object carries no claim fields, so it
  // is `incomplete` rather than unreadable: the bytes were read, the owner is
  // simply not there.
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) return { state: TARGET_CLAIM_STATES.INCOMPLETE, claim };
  // Exactly the pre-change precondition, in the pre-change order: a hostname
  // that differs (or is not a string) was never stale, and any integer pid on
  // this host was probed - 0 and negative pids included, because that is what
  // `process.kill(pid, 0)` did. Only `ESRCH` proves the owner gone.
  if (claim.hostname !== hostname) {
    return { state: typeof claim.hostname === "string" ? TARGET_CLAIM_STATES.FOREIGN_HOST : TARGET_CLAIM_STATES.INCOMPLETE, claim };
  }
  if (!Number.isInteger(claim.pid)) return { state: TARGET_CLAIM_STATES.INCOMPLETE, claim };
  return { state: alive(claim.pid) ? TARGET_CLAIM_STATES.LIVE : TARGET_CLAIM_STATES.RECLAIMABLE, claim };
}

export class EvolutionOrchestrator {
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.runner = ctx.dynamicCordisRunner;
    this.promotionAdapter = config.promotionAdapter;
    this.prepareRuntime = config.prepareRuntime;
    this.diagnose = typeof config.diagnose === 'function'
      ? options => config.diagnose(options)
      : () => { throw new Error('Evolution diagnostics are not wired in this runtime'); };
    this.domainStorage = config.domainStorage;
    this.sharedExperience = config.sharedExperience;
    this.paths = defaultPaths(config);
    this.eventBridge = config.eventBridge || new EvolutionEventBridge({ file: this.paths.eventBridgePath, key: this.paths.eventBridgeKey, writer: this.paths.eventBridgeWriter,
      // Re-publish verified structured facts on restart. This is an additive
      // metadata projection, not a migration of legacy free-text knowledge;
      // durable shared event identities make retries harmless.
      onVerifiedEvent: (event, order) => this.publishSharedExperience(event, order) });
    this.experiments = new Map();
    this.targetOwners = new Map();
    this.operationClaims = new Map();
    this.memory = config.memory || new EvolutionMemory({
      file: this.paths.memoryPath,
      maxEntries: config.memoryMaxEntries,
      maxText: config.memoryMaxText,
      maxItems: config.memoryMaxItems,
    });
    this.canaryWindow = Math.max(1, Number(config.canaryWindow) || 2);
    this.promotionLockTtlMs = Math.max(1000, Number(config.promotionLockTtlMs) || 15 * 60 * 1000);
    const configuredMode = typeof config.mode === "string" ? config.mode.trim().toLowerCase() : config.autonomous === true ? "autonomous" : "advisory";
    this.mode = new Set(["manual", "advisory", "autonomous"]).has(configuredMode) ? configuredMode : "advisory";
    this.unattended = config.unattended === true;
    this.autonomous = this.mode === "autonomous";
    this.autonomousPolicy = {
      low: "experiment",
      medium: "confirm",
      high: "deny",
      ...(isObject(config.autonomousPolicy) ? config.autonomousPolicy : {}),
    };
    this.patternThreshold = Math.max(2, Number(config.patternThreshold) || 3);
    this.strategies = config.autonomousStrategies || {};
    this.patterns = new Map();
    this.observations = [];
    this.candidates = new Map();
    // Session-scoped suppression, keyed by hypothesis identity
    // (`patternKey:strategyFingerprint`), not by pattern: a declaration that
    // failed stops this session, a different declaration for the same pattern is
    // a new hypothesis and gets its own attempt. The durable half of the same
    // decision lives in the failure memory under the same identity.
    this.suppressedPatterns = new Set();
    // Experiment id -> `{ attempts, at }` for retries of an autonomous record whose
    // own cleanup could not be proven. It is session bookkeeping, not evidence about
    // a hypothesis: the timestamp only spaces the retries
    // (`cleanupRecoveryCooldownMs`), and the record keeps its target claim, its
    // captured baseline and its evidence until a retry proves recovery.
    this.cleanupRecoveryAttempts = new Map();
    // How long one unproven cleanup has to wait before a later observation may
    // retry it. Tests set it to zero; production keeps the default so a persistent
    // failure costs at most one retry per interval instead of one per error event.
    const cleanupRecoveryCooldown = Number(config.cleanupRecoveryCooldownMs);
    this.cleanupRecoveryCooldownMs = Number.isFinite(cleanupRecoveryCooldown) && cleanupRecoveryCooldown >= 0
      ? cleanupRecoveryCooldown
      : AUTONOMOUS_CLEANUP_RECOVERY_COOLDOWN_MS;
    // How long a hypothesis deferred by an environment failure has to wait before a
    // later observation may attempt it again. Same shape and purpose as the cleanup
    // cooldown above: tests set it to zero, production keeps the default so a
    // persistent conflict costs at most one attempt per interval, not one per event.
    const transientRetryCooldown = Number(config.transientRetryCooldownMs);
    this.transientRetryCooldownMs = Number.isFinite(transientRetryCooldown) && transientRetryCooldown >= 0
      ? transientRetryCooldown
      : AUTONOMOUS_TRANSIENT_RETRY_COOLDOWN_MS;
    // Hypothesis identity -> `{ attempts, at }` for an attempt that ended in a
    // transient environment failure. This is session bookkeeping, not evidence: it
    // only spaces the retries (`transientRetryCooldownMs`), so the hypothesis is
    // attempted again once the conflict is gone instead of staying suppressed until
    // the process exits. The durable failure memory is never written for these.
    this.deferredPatterns = new Map();
    // Identities whose autonomous decision reservation was not released when a
    // proven revert tried to free it. `autonomousDecisions()` is an open-time
    // snapshot, so the inherited-decision path cannot see a reservation this
    // process took; these identities are retried by a later observation instead.
    this.pendingDecisionReleases = new Set();
    // Synchronous, per-identity guard for the window between identity resolution
    // and the later `observing` registration (see observeAutonomous).
    this.autonomousPlanning = new Set();
    // Identity -> the observation currently running a Trial for it, so two
    // concurrent observers (an `agent/error` and a `tools/result` for the same
    // failure, or two provider errors at once) cannot propose two experiments for
    // one hypothesis and then fight over its target claim.
    this.observing = new Set();
    this.sequence = 0;
    // On-demand experience recall for the explicit evolution path. It is off
    // only when an owner disables it; it never starts a timer, a poll loop, or
    // a model turn of its own.
    this.experienceRecall = config.experienceRecall !== false;
    // The applicability triple recorded on conclusions and on probe evidence.
    // An injected value is used verbatim (tests and hosts that can prove their
    // versions); otherwise it is detected once, lazily, from the process entry
    // point, and stays "unknown" when the runtime does not expose it.
    this.configuredVersions = isObject(config.runtimeVersions) ? {
      host: typeof config.runtimeVersions.host === "string" ? config.runtimeVersions.host : null,
      cordis: typeof config.runtimeVersions.cordis === "string" ? config.runtimeVersions.cordis : null,
      evolution: typeof config.runtimeVersions.evolution === "string" ? config.runtimeVersions.evolution : null,
    } : null;
    this.detectedVersions = null;
    // One probe step's bounded wait. A host test may lower it; production keeps
    // the same 30 s ceiling, and the timeout aborts the official call before the
    // probe moves on.
    const probeStepTimeout = Number(config.probeStepTimeoutMs);
    this.probeStepTimeoutMs = Number.isFinite(probeStepTimeout) && probeStepTimeout > 0
      ? probeStepTimeout
      : PROBE_LIMITS.stepTimeoutMs;
  }

  /** The versions this orchestrator records as the experiment's applicability. */
  runtimeVersions() {
    if (this.configuredVersions) return { ...this.configuredVersions };
    if (!this.detectedVersions) this.detectedVersions = detectRuntimeVersions();
    return { ...this.detectedVersions };
  }

  applicability() {
    return applicabilityFromVersions(this.runtimeVersions());
  }

  inspect(agent) {
    // Proposal #1: project at the output boundary so every stored baseline and
    // every tool-facing view satisfies the lossless-JSON contract. Live Cordis
    // objects are only read, never mutated.
    const runtime = {
      ...inspectRuntime(this.ctx, agent, this.runner),
      evolutionPolicy: {
        mode: this.mode,
        unattended: this.unattended,
        autonomous: this.autonomous,
        evolvableByDefault: true,
        trustRoot: "Cordis",
        productionPromotion: "explicit-user-confirmation",
      },
      evolutionMemory: this.memory.diagnostics(),
    };
    // Observation input can carry a provider error message. It is stored
    // through the safe-error boundary already, and this projection keeps an
    // input that arrived by another route from reaching the tool output raw.
    const observations = snapshotJson(this.observations.slice(-20).map((entry) => (
      isObject(entry) && isObject(entry.input)
        && (entry.input.message !== undefined || entry.input.error !== undefined)
        ? { ...entry, input: safeObservationInput(entry.input) }
        : entry
    )));
    const candidates = snapshotJson([...this.candidates.values()]);
    const result = toLosslessJson(runtime);
    result.evolutionObservations = observations;
    result.evolutionCandidates = candidates;
    return result;
  }

  emitExecutionEvent(type, record, payload = {}) {
    const event = this.eventBridge.emit(type, record, payload);
    // A host event dispatch is foreign code on this path; a rejected promise it
    // returns is its own failure and must not become an unhandled rejection that
    // takes the process down after the event was already durable.
    const dispatched = this.ctx.emit?.("evolution/execution-event", event);
    if (dispatched && typeof dispatched.catch === "function") void dispatched.catch(() => {});
    return event;
  }

  publishSharedExperience(event, order) {
    try { this.sharedExperience?.recordEvolution(event, this.paths.eventBridgePath, order); }
    catch (error) { this.warn(`Shared experience publication failed: ${safeErrorDto(error, 'experience-publish').errorSummary}`); }
  }

  /**
   * The host identity and the official lifecycle capabilities this kernel can
   * actually prove. They are recorded with every publication so a consumer can
   * compare the same facts on its own context instead of trusting a version
   * string or the package.json of the plugin.
   */
  sharedPluginFacts() {
    let packageOf;
    try {
      const packages = this.ctx.get?.("pluginPackages");
      if (packages && typeof packages.packageOf === "function") packageOf = (name, baseUrl) => packages.packageOf(name, baseUrl);
    } catch {
      // An unreadable package service leaves the host facts unknown, which makes
      // the publication unverifiable rather than silently compatible.
    }
    let profile = null;
    try { profile = this.ctx.get?.("profileContext")?.name ?? null; } catch { profile = null; }
    const host = captureHostFacts({ packageOf, profile, baseUrl: this.ctx.baseUrl });
    const capabilities = probeSharedCapabilities({ ctx: this.ctx, includeCapabilities: this.paths.promotionRuntime?.capabilities });
    return { host, capabilities };
  }

  /**
   * Reuse the verified publication identity captured when the approved
   * promotion was written. This deliberately never creates one: deriving it
   * from the current file bytes and the current host at stable-commit time
   * would let a source modified after promotion, or a host upgraded during the
   * canary, be relabelled as "verified". A missing identity keeps the promotion
   * Desktop-only instead of publishing an unverifiable record.
   */
  reusePublicationIdentity(record) {
    if (!Array.isArray(record?.shareTargets) || record.shareTargets.length === 0) return null;
    const existing = normalizePublication(record?.durable?.publication ?? record?.publication);
    if (!existing) return null;
    if (!record.publication) record.publication = existing;
    if (record.durable && !record.durable.publication) record.durable = { ...record.durable, publication: existing };
    return existing;
  }

  /**
   * Publish one stable promotion to the cross-entry index.
   *
   * Only explicit approval recorded on the promotion can reach here, and only
   * after the canary committed stable. Every failure is contained and reported
   * as a diagnostic: the promotion is already durable, so a failed publication
   * must neither undo it nor make the canary result look unsuccessful. Startup
   * reconciliation retries from the same durable facts.
   */
  async publishCrossEntryPlugin(record, journal = null) {
    const shareTargets = Array.isArray(record?.shareTargets) ? record.shareTargets.filter((profile) => SHARED_CONSUMER_PROFILES.includes(profile)) : [];
    if (shareTargets.length === 0) return { status: "desktop-only", profiles: [] };
    try {
      const { host, capabilities } = this.sharedPluginFacts();
      const sharedRecord = await buildSharedRecord({
        paths: this.paths,
        // Live publication is held to the same rule as reconciliation: the
        // verified identity must already exist. Without it the record cannot
        // prove the bytes/host the promotion was verified on.
        requirePublication: true,
        experiment: record,
        durable: record.durable,
        journal,
        approvedProfiles: shareTargets,
        host,
        capabilities,
        source: { stableCommittedAt: record.stableCommittedAt },
      });
      const result = await publishSharedRecord(this.paths, sharedRecord);
      if (result.status === "published" || result.status === "updated" || result.status === "unchanged") {
        this.warn(`[evolution] shared plugin ${sharedRecord.id} ${result.status} for ${shareTargets.join(", ")}`);
        return { status: result.status, id: sharedRecord.id, profiles: [...shareTargets] };
      }
      this.warn(`[evolution] shared plugin publication refused (${result.reason || result.status})`);
      return { status: "failed", reason: result.reason || result.status, profiles: [...shareTargets] };
    } catch (error) {
      this.warn(`[evolution] shared plugin publication failed: ${safeErrorDto(error, "shared-publish").errorSummary}`);
      return { status: "failed", reason: "publish-failed", profiles: [...shareTargets] };
    }
  }

  /**
   * One contained diagnostic line. `ctx.logger` is host-provided code and every
   * caller here is usually already handling a failure, so neither a logger that
   * throws nor one that returns a rejected promise may replace the outcome it
   * describes (nor surface as an unhandled rejection). `registration.js` has the
   * same boundary for observer diagnostics (`warnRedacted`).
   */
  warn(message) {
    try {
      const logged = this.ctx.logger?.warn?.(message);
      if (logged && typeof logged.catch === "function") void logged.catch(() => {});
    } catch {
      // A diagnostic that cannot be written is not a lifecycle failure.
    }
  }

  /**
   * Legacy startup drift detection lives in the explicit compatibility
   * adapter `lib/compat/legacy-startup-drift.js`; the bundle entry disables it
   * with `startupDrift: false`, and its external `drift-engine.js` import is
   * only reached when a caller leaves that flag enabled and the state file
   * names an existing engine.
   */
  async inspectStartupDrift() {
    const summary = await inspectLegacyStartupDrift(this.paths);
    if (summary.status === "drift") this.warn(`[evolution] Live/Backup drift detected: ${JSON.stringify(summary)}`);
    await this.ctx.emit?.("evolution/drift", summary);
    return summary;
  }

  /**
   * Bounded, model-free recall of directly relevant history for one explicit
   * evolution request: already-resolved problems, approaches that already
   * failed, and measured strategies worth reusing. Both sources stay
   * independent, so a missing or failing domain store degrades to local
   * failure memory instead of being read as "no experience".
   */
  recallExperience(input = {}, options = {}) {
    if (this.experienceRecall === false) return null;
    // Every read on this path is contained: the local failure-memory read, the
    // domain store call, and the finalizer's own read of whatever object the
    // store handed back. A `recall()` result is a source object, so its `error`
    // or `records` can be a throwing getter; the finalizer used to run outside
    // this try, so `evolution_history` (which calls this entry directly) let
    // that exception — and its text — escape to the tool result.
    try {
      const sources = [collectFailureMemoryExperience(this.memory?.data?.entries ?? [], input, options)];
      if (this.sharedExperience) {
        try { sources.push(this.sharedExperience.recall(input, options)); }
        catch (error) { sources.push({ source: 'shared-knowledge', error: safeErrorDto(error, 'recall').errorSummary }); }
      }
      let storeFailure = null;
      if (typeof this.domainStorage?.recall !== "function") {
        sources.push({ source: "knowledge", error: "unavailable" });
      } else {
        let recalled;
        let recallThrew = false;
        try {
          recalled = this.domainStorage.recall(input, options);
        } catch (error) {
          // The store's own message is provider/plugin text: it crosses the
          // credential boundary before it can reach `unavailable` (and from there
          // the proposal output).
          recallThrew = true;
          storeFailure = safeErrorDto(error, "recall");
          sources.push({ source: "knowledge", error: storeFailure.errorSummary });
        }
        // A thrown call and a call that returns no source are two different
        // facts: the first reports the redacted reason, the second keeps the
        // `unavailable` marker the store has always contributed, so neither is
        // silently read as "no history".
        if (!recallThrew) {
          sources.push(recalled && typeof recalled === "object" ? recalled : { source: "knowledge", error: "unavailable" });
        }
      }
      const recall = finalizeExperienceRecall(input, sources, options);
      // A source object is data, so the finalizer always recomputes the DTO from
      // the redacted summary it is handed and never reads a source-supplied one.
      // This DTO is the only one computed over the *original* message, so its
      // category and digest are the fingerprint that keeps two failures apart
      // even when redaction collapses their text: it replaces that source's
      // recomputed entry instead of being added beside it.
      if (storeFailure) {
        recall.sourceErrors = [
          { source: "knowledge", ...storeFailure },
          ...recall.sourceErrors.filter((entry) => entry.source !== "knowledge"),
        ];
      }
      return recall;
    } catch (error) {
      // Same degradation, one level up: an unreadable source or a finalizer
      // failure still returns a bounded, redacted recall instead of throwing
      // into `evolution_propose` / `evolution_history`. `input` here is the
      // caller's own already-projected request, so the fallback does not re-read
      // anything the store supplied.
      const detail = safeErrorDto(error, "recall");
      try {
        const degraded = finalizeExperienceRecall(input, [{ source: "knowledge", error: detail.errorSummary }], options);
        degraded.sourceErrors = [{ source: "knowledge", ...detail }];
        return degraded;
      } catch {
        // The query itself could not be read either: report nothing rather than
        // raise. `propose` attaches a recall only when one came back.
        return null;
      }
    }
  }

  /**
   * Bounded, model-free discovery of the next evolution target. It reads the
   * unified shared experience plus the local durable failure memory, groups the
   * recorded facts by problem identity, ranks the unresolved recurring ones by
   * evidence, and reports what it rejected and why. It never creates an
   * experiment, never starts a Trial, and never writes to the stores.
   */
  plan(args = {}, exec = null) {
    const limits = EXPERIENCE_PLAN_LIMITS;
    const requestedLimit = Number(args?.limit);
    const maxCandidates = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(limits.maxCandidates, Math.floor(requestedLimit))
      : limits.maxCandidates;
    const requestedMinimum = Number(args?.minOccurrences);
    // A caller may raise the evidence bar, never lower it.
    const minOccurrences = Number.isFinite(requestedMinimum) && requestedMinimum > 0
      ? Math.max(limits.minOccurrences, Math.floor(requestedMinimum))
      : limits.minOccurrences;
    const sources = { knowledge: [], failureMemory: [], versions: this.applicability() };
    const sourceErrors = [];
    let sharedCount = 0;
    let sharedTruncated = false;
    if (this.sharedExperience && typeof this.sharedExperience.discover === "function") {
      try {
        const discovered = this.sharedExperience.discover({ window: limits.maxConsidered });
        sources.knowledge = Array.isArray(discovered?.records) ? discovered.records : [];
        sharedCount = sources.knowledge.length;
        sharedTruncated = discovered?.truncated === true;
      } catch (error) {
        const detail = safeErrorDto(error, "plan");
        sourceErrors.push({ source: "shared-knowledge", ...detail });
      }
    } else {
      sourceErrors.push({ source: "shared-knowledge", errorCode: "E_EVOLUTION_PLAN_NO_SHARED_STORE", errorCategory: "unavailable", errorDigest: sha256("shared-store-unavailable").slice(0, 32), errorSummary: "shared experience store unavailable" });
    }
    try {
      sources.failureMemory = (this.memory?.data?.entries ?? [])
        .map((entry) => failureMemoryExperienceRecord(entry, { maxText: limits.maxText, maxEvidenceRefs: limits.maxEvidenceRefs }))
        .filter(Boolean);
    } catch (error) {
      sourceErrors.push({ source: "failure-memory", ...safeErrorDto(error, "plan") });
    }
    // Optional focus: a token filter over the problem identity, so an owner can
    // point the same bounded discovery at one subsystem without widening it.
    // It is applied inside the planner *before* the output cap, so a matching
    // target outside the top `maxCandidates` is still reachable.
    const focus = typeof args?.focus === "string" ? compactValue(args.focus.trim().toLowerCase(), EVIDENCE_PROJECTION) : "";
    let planned;
    try {
      planned = planEvolutionCandidates(sources, { minOccurrences, maxCandidates, focus, now: Date.now() });
    } catch (error) {
      return {
        ok: false,
        phase: "plan",
        reason: "plan-unavailable",
        ...safeErrorDto(error, "plan"),
        limits: { maxCandidates, minOccurrences },
        sources: { shared: sharedCount, failureMemory: sources.failureMemory.length, truncated: sharedTruncated, errors: sourceErrors.slice(0, 3) },
      };
    }
    const candidates = Array.isArray(planned?.candidates) ? planned.candidates : [];
    // An unreadable shared store with no local failure memory is not the same
    // fact as "history has no failure signal": report the store itself as the
    // reason the plan is empty.
    let none = planned?.none ?? null;
    if (none && candidates.length === 0 && sources.knowledge.length === 0 && sources.failureMemory.length === 0
      && sourceErrors.some((entry) => entry.source === "shared-knowledge")) {
      none = { reason: "store-unavailable", considered: 0, detail: "the unified experience store is unavailable and local failure memory is empty" };
    }
    // A bounded discovery window that withheld older facts is not the same
    // fact as "history has no failure signal". Leaving the generic reason in
    // place lets the owner (and the model reading this tool result) conclude
    // there is nothing to evolve when the real problem is outside the window.
    if (none && none.reason === "no-failure-signal" && candidates.length === 0 && sharedTruncated) {
      none = {
        ...none,
        reason: "discovery-window-truncated",
        detail: "the bounded discovery window withheld older facts; filtering the records already read cannot recover them, so this is not evidence of no failure signal",
      };
    }
    const selected = candidates[0] ?? null;
    if (selected) {
      try {
        const experienceRecall = this.recallExperience({
          target: selected.problemKey,
          problem: selected.problem,
          failureMode: selected.failureModes?.[0],
        });
        if (experienceRecall) selected.experienceRecall = experienceRecall;
      } catch (error) {
        selected.experienceRecall = { unavailable: [`recall-failed:${safeErrorDto(error, "recall").errorSummary}`] };
      }
    }
    return {
      ok: true,
      phase: "plan",
      focus: focus || null,
      selected,
      candidates,
      none: candidates.length > 0 ? null : (none ?? { reason: "no-failure-signal", considered: 0, detail: "no unresolved recurring failure met the evidence bar" }),
      rejected: Array.isArray(planned?.rejected) ? planned.rejected.slice(0, limits.maxRejected) : [],
      versions: this.runtimeVersions(),
      applicability: this.applicability(),
      applicabilityVerified: applicabilityKnown(this.applicability()),
      limits: { maxCandidates, minOccurrences },
      sources: { shared: sharedCount, failureMemory: sources.failureMemory.length, truncated: sharedTruncated, errors: sourceErrors.slice(0, 3) },
    };
  }

  /**
   * The unified read-only review a natural-language self-evolution request
   * starts from: previously published stable plugins checked against this host,
   * then the existing evidence-ranked experience plan, composed into one
   * ordered set of next actions.
   *
   * This wrapper adds the durable-edition audit and the priority decision; the
   * synchronous plan() keeps serving callers that only need experience
   * discovery. It never starts an experiment, never mounts a Trial and never
   * writes the publication index. A review failure is reported as a closed
   * status instead of turning the owner's request into a tool error.
   */
  async reviewSelfEvolution(args = {}, exec = null) {
    const plan = this.plan(args, exec);
    let stable;
    try {
      // One host-identity path for both entries: the same fallback the ACP
      // audit uses, so a Desktop kernel whose package service cannot resolve
      // the Include does not classify differently from the ACP side.
      const host = captureReviewHost(this.ctx);
      // The operator-run scanner persists a bounded counts table; the review
      // reads that one small file and never scans sessions. A damaged, absent or
      // stale projection is reported as evidence and cannot unlock a retirement
      // recommendation.
      const usage = await readUsageProjection({ dataRoot: this.paths.dataRoot ?? this.paths.presetDir });
      stable = await readPublishedPluginReview({
        paths: this.paths,
        host,
        usage: usage.usage,
        usageStatus: usage.evidence.status,
      });
    } catch (error) {
      stable = {
        kind: "dsh-evolution-self-evolution-review",
        readOnly: true,
        status: "unavailable",
        reason: "review-unavailable",
        records: [],
        summary: null,
        nextActions: [],
        error: safeErrorDto(error, "self-evolution-review"),
      };
    }
    // Match reviewExperience's availability rule: an unreadable shared store is
    // not the same fact as an empty one. Local failure memory can still feed the
    // planner, but the review must say it is incomplete instead of claiming a
    // complete Desktop review when the shared half could not be read.
    const planErrors = Array.isArray(plan?.sources?.errors) ? plan.sources.errors : [];
    const sharedError = planErrors.some((entry) => entry?.source === "shared-knowledge");
    const sharedKnowledge = Number(plan?.sources?.shared ?? 0);
    const experienceAvailable = plan?.ok !== false && (!sharedError || sharedKnowledge > 0);
    const experience = plan?.ok === false
      ? {
          available: false,
          selected: null,
          candidates: [],
          none: { reason: "plan-unavailable", detail: plan.reason ?? "plan unavailable" },
          rejected: [],
          sources: plan?.sources ?? null,
          errors: [{ source: "experience-plan", errorCode: "E_EVOLUTION_PLAN_UNAVAILABLE" }],
        }
      : {
          available: experienceAvailable,
          selected: plan.selected ?? null,
          candidates: plan.candidates ?? [],
          none: plan.none ?? null,
          rejected: plan.rejected ?? [],
          sources: plan?.sources ?? null,
          errors: planErrors,
        };
    // composeSelfEvolutionReview reads the applicability triple (dsh/cordis/
    // evolution), so pass the same mapping the plan already recorded instead of
    // the host-keyed runtimeVersions object.
    const review = composeSelfEvolutionReview({ stable, experience, versions: this.applicability() });
    return { ...plan, stablePlugins: stable, selfEvolution: review };
  }

  /**
   * Whether this exact strategy, for this exact problem and applicability, is
   * already recorded as ineffective. A conclusion recorded under a different
   * DSH/Cordis triple is deliberately not equivalent: it is returned as
   * `sameApplicability: false` and does not block the proposal.
   */
  priorIneffectiveConclusion(target, fingerprint) {
    if (!this.sharedExperience || typeof this.sharedExperience.findConclusions !== "function") return null;
    const applicability = this.applicability();
    if (!applicabilityKnown(applicability)) return null;
    try {
      const found = this.sharedExperience.findConclusions({ target, applicability, strategyFingerprint: fingerprint });
      const matches = Array.isArray(found?.matches) ? found.matches : [];
      const prior = matches.find((match) => match.sameApplicability === true && INEFFECTIVE_CONCLUSIONS.has(match.decision));
      if (!prior) return null;
      return {
        knowledgeKey: prior.knowledgeKey ?? null,
        decision: prior.decision,
        outcome: prior.outcome ?? null,
        regressionCount: prior.regressionCount ?? 0,
        at: prior.lastSeen ?? null,
        applicability,
      };
    } catch (error) {
      this.warn(`[evolution] conclusion lookup failed: ${safeErrorDto(error, "conclusion").errorSummary}`);
      return null;
    }
  }

  /**
   * Publish one terminal experiment conclusion to the unified experience. A
   * conclusion describes the strategy under one applicability triple; the same
   * identity re-recorded with a failed/regressed outcome demotes its earlier
   * success inside the store. The write is best-effort: it can never change the
   * lifecycle result it describes.
   */
  publishConclusion(record, kind, source = "decision") {
    if (!record?.id || !this.sharedExperience || typeof this.sharedExperience.recordConclusion !== "function") return null;
    try {
      const proposal = record.proposal || {};
      const target = safeString(proposal.target) || safeString(record.targets?.[0]) || "unknown";
      const strategy = typeof proposal.strategy === "string" && proposal.strategy.trim() !== ""
        ? proposal.strategy
        : safeString(record.composition?.name) || "unnamed-cordis-plugin";
      // Every identity field here must be stable for the whole experiment:
      // the same experiment can publish a conclusion at the promotion gate and
      // again at revert, and the shared store treats a different content digest
      // under the same event id as a conflict. `record.failure` is cleared or
      // replaced between those two transitions, so it must not feed identity.
      const rootCause = typeof proposal.rootCause === "string" ? proposal.rootCause : "";
      const comparison = record.probe?.comparison;
      // failureMode is one of the six knowledge identity dimensions. Adding a
      // task-specific value here would give the same hypothesis a second
      // identity, leaving an old regression row alive next to a later adopted
      // verdict. The `decision`/`outcome` already records a task regression, so
      // keep failureMode exactly as the probe path has always written it.
      const failureMode = comparison?.regression === true ? "regression" : "";
      const decision = typeof record.decision?.kind === "string" ? record.decision : null;
      const fingerprint = typeof proposal.strategyFingerprint === "string" && /^[a-f0-9]{8,32}$/.test(proposal.strategyFingerprint)
        ? proposal.strategyFingerprint
        : strategyFingerprint(target, strategy);
      const applicability = this.applicability();
      // A neutral terminal verdict (revert without a proven failure, or an
      // unmeasurable experiment) must not erase an already proven negative for
      // the same hypothesis under the same versions. The store now restores the
      // negative verdict from its immutable counters on read, but skipping the
      // write also keeps `lastStatus` honest for other consumers of the row.
      // This gate is best-effort: an unreadable store is not a reason to publish
      // a verdict that may overwrite durable negative evidence.
      if (kind === "reverted-unconfirmed" || kind === "insufficient-evidence") {
        try {
          const prior = this.sharedExperience.findConclusions({ target, strategyFingerprint: fingerprint, applicability });
          if (prior?.matches?.some((match) => match.sameApplicability === true
            && (match.decision === "no-benefit" || match.decision === "regression"))) return null;
        } catch {
          return null;
        }
      }
      return this.sharedExperience.recordConclusion({
        experimentId: record.id,
        target,
        problem: target,
        strategy,
        strategyFingerprint: fingerprint,
        rootCause,
        failureMode,
        decision: kind,
        metrics: conclusionMetrics(record),
        applicability,
        occurredAt: decision?.at || record.frozenAt || record.promotedAt || now(),
        source,
      }, this.paths.eventBridgePath);
    } catch (error) {
      this.warn(`[evolution] shared conclusion publication failed: ${safeErrorDto(error, "conclusion").errorSummary}`);
      return null;
    }
  }

  propose(args, exec, options = {}) {
    const agent = ownerOf(exec);
    const target = evidenceText(args?.target, "target");
    const benefitModel = normalizeBenefitModel(args?.benefitModel);
    // The declared improvement form decides which verification contract this
    // experiment owes. A context policy changes how an existing step is fed, so
    // it has no candidate tool to self-test; its only admissible proof is the
    // paired real-session artifact (the taskBenefit gate).
    const improvement = normalizeImprovement(args?.improvement);
    if (improvement === "context-policy" && benefitModel?.kind !== "workflow") {
      throw probeFailure("E_EVOLUTION_IMPROVEMENT", 'a context-policy improvement must declare benefitModel.kind = "workflow"; it has no capability to self-test');
    }
    const strategy = evidenceText(args?.strategy, "strategy");
    const rootCause = evidenceText(args?.rootCause, "rootCause");
    const fingerprint = strategy ? strategyFingerprint(target, strategy) : null;
    // A strategy that has already been measured and recorded as ineffective
    // under the *same* applicability is not worth another Trial. A different
    // hypothesis gets a different fingerprint and is allowed; a different
    // DSH/Cordis triple is not "the same conditions" and does not block.
    if (strategy) {
      const prior = this.priorIneffectiveConclusion(target, fingerprint);
      if (prior) {
        return {
          ok: false,
          phase: "rejected",
          reason: "strategy-already-proven-ineffective",
          target,
          strategyFingerprint: fingerprint,
          applicability: this.applicability(),
          prior,
          advice: "This strategy was already measured and recorded as ineffective under the same DSH/Cordis versions. Change the hypothesis or the plugin behavior first; the recorded evidence requires new proof, not a repeat.",
          experienceRecall: this.recallExperience({ target, problem: target, strategy }),
        };
      }
    }
    // The proposal text is durable: it is written into the archive, the evidence
    // sidecar and the event bridge, and it is echoed back to the caller. It
    // therefore crosses the credential boundary where it is captured, so no
    // reader has to remember to project it.
    const proposal = {
      why: evidenceText(args?.why, "why"),
      target,
      impactScope: scopeList(args?.impactScope).map((entry) => compactValue(entry, EVIDENCE_PROJECTION)),
      successMetrics: stringList(args?.successMetrics, "successMetrics").map((entry) => compactValue(entry, EVIDENCE_PROJECTION)),
      risk: safeString(args?.risk || "low").toLowerCase(),
      owner: agent.id,
      createdAt: now(),
      applicability: this.applicability(),
      ...(strategy ? { strategy } : {}),
      ...(rootCause ? { rootCause } : {}),
      ...(benefitModel ? { benefitModel } : {}),
      ...(improvement === "tool" ? {} : { improvement }),
      ...(fingerprint ? { strategyFingerprint: fingerprint } : {}),
    };
    const id = `exp-${Date.now().toString(36)}-${(++this.sequence).toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
    const record = {
      id,
      proposal,
      state: "proposed",
      ownerId: agent.id,
      baseline: this.inspect(agent),
      observations: [],
      runtimeRecovered: false,
      targets: normalizeTargets(args),
      // The observer's internal proposal must not consume the explicit
      // `evolution_propose` quota: it is created and trialed in one observation,
      // while a caller's proposal can be left pending indefinitely.
      proposalSource: options.internal === true ? 'autonomous' : 'explicit',
    };
    this.experiments.set(id, record);
    if (record.proposalSource === 'explicit') this.pruneProposedExperiments();
    // The event bridge is auxiliary evidence, not part of the proposal's
    // authority: the record lives in memory and the caller gets it back. A
    // failed append used to throw after the record was inserted, so the
    // proposal existed but the caller saw a failure and no experiment id
    // (the autonomous observer treats that as "nothing was proposed" and
    // leaves the orphan behind on every retry).
    this.emitEventSafely(record, "proposal-created");
    const result = {
      ok: true,
      experimentId: id,
      phase: record.state,
      proposal,
      baseline: runtimeSignature(record.baseline),
    };
    // Advisory only: the recall never blocks a proposal and never grants
    // promotion authority. It is attached to the owner-triggered proposal so
    // the caller can prefer an already-recorded resolution over a repeat
    // experiment without any background model cost.
    try {
      const experienceRecall = this.recallExperience({
        why: proposal.why,
        target: proposal.target,
        impactScope: proposal.impactScope,
        successMetrics: proposal.successMetrics,
      });
      if (experienceRecall) result.experienceRecall = experienceRecall;
    } catch (error) {
      // Same boundary as the source-level catch: the recall is advisory, so a
      // failed read degrades to a redacted summary plus its classified
      // fingerprint instead of echoing the thrown text into the proposal result.
      const detail = safeErrorDto(error, "recall");
      result.experienceRecall = {
        unavailable: [`recall-failed:${detail.errorSummary}`],
        sourceErrors: [{ source: "knowledge", ...detail }],
      };
    }
    return result;
  }

  async trial(args, exec) {
    const agent = ownerOf(exec);
    const record = this.requireOwned(args?.experimentId, agent);
    if (record.state !== "proposed") throw new Error(`experiment ${record.id} is ${record.state}; Trial requires proposed state`);
    this.assertRuntimeAvailable(record);
    const composition = args?.composition;
    if (!composition || typeof composition !== "object") throw new Error("composition is required");
    const code = composition.code;
    if (!code || typeof code.host !== "string" || code.host.trim() === "") throw new Error("composition.code.host must be a non-empty JavaScript function body");
    // Keep the proposal snapshot for review, but prove cleanup against the
    // live runtime immediately before the first trial mutation. There is no
    // await between this read and define(); drift during run() still fails.
    const trialBaseline = this.inspect(agent);
    this.acquireTargets(record);
    record.trialBaseline = trialBaseline;
    record.state = "trial-starting";
    let definition;
    let receipt;
    try {
      definition = this.runner.define({
        sessionId: agent.id,
        plugin: { kind: "new", idPrefix: slug(args?.idPrefix, "evo") },
        name: text(composition.name, "composition.name"),
        purpose: text(composition.purpose, "composition.purpose"),
        code: {
          host: code.host,
          ...(typeof code.client === "string" && code.client.trim() !== "" ? { client: code.client } : {}),
        },
      });
      record.pluginId = safeString(definition.pluginId);
      record.packageId = safeString(definition.packageId);
      record.composition = { name: composition.name, purpose: composition.purpose,
        hasClient: typeof code.client === "string" && code.client.trim() !== "",
        // The task-coupled evidence is bound to this exact source, so a later
        // artifact produced for different code cannot be reused here.
        hostSha256: sha256(code.host) };
      receipt = await this.runner.run(agent, definition.pluginId, definition.packageId, "run", exec.signal);
      if (!receipt?.ok) throw new Error(receipt?.message || `Cordis rejected Trial for ${record.id}`);
    } catch (error) {
      // Everything from here to the `finally` is evidence about a Trial that
      // already failed, so none of it may decide whether the lock is released.
      // The sixth review's second blocker was exactly that: `failureLearning()`
      // threw (RangeError from the redaction rules on an 8 MiB message), the
      // failure record was never written, and the `finally` below was still
      // skipped because the throw happened before the `try` — leaving the target
      // lock on disk and the experiment record in memory. The evidence block is
      // now inside the `try`, its own failures are reported as warnings, and the
      // original error is always the one the caller receives.
      let undone = false;
      try {
        let rollbackResult;
        try {
          if (!record.pluginId) {
            // `define` never returned a plugin id, so this call cannot name
            // anything to undo. That is the one shape that proves nothing was
            // created; it is not the same state as a failed undo.
            rollbackResult = { ok: true, status: "not-required" };
            undone = true;
          } else {
            rollbackResult = await this.runner.undefine(agent, record.pluginId);
            undone = rollbackResult?.ok === true;
          }
        } catch (rollbackError) {
          // Not `safeString(rollbackError?.message)`: that reads a property and runs
          // a `toString` on a hostile object *outside* any guard, on a path whose
          // job is to release things. The receipt crosses the same boundary as the
          // cleanup receipts and cannot throw.
          const detail = safeErrorDto(rollbackError, "cleanup");
          rollbackResult = { ok: false, error: detail.errorSummary, errorCategory: detail.errorCategory, errorDigest: detail.errorDigest };
        }
        record.state = undone ? "trial-failed" : "trial-cleanup-failed";
        record.failure = safeFailureLearning({
          record,
          phase: "trial",
          error,
          rollbackResult,
          nextPreventionHint: "先用 evolution_runtime_inspect 确认 Host-only 代码与 Cordis 注入，再重新定义 Trial；重复失败必须更换假设。",
        });
        // An environment failure is not evidence about the hypothesis. It stays
        // an archived operation record (the evidence file and the rejection event)
        // but it is not written into the durable failure *learning*, which the
        // experience recall presents as "approaches that already failed": neither
        // the local memory nor the domain, whose outcome rows are derived from the
        // bridge event's fingerprint.
        const transient = autonomousFailureIsTransient(safeErrorDto(error, "trial"));
        await this.archiveTerminal(record, record.state, { learn: !transient });
        if (transient) {
          this.emitEventSafely(record, "experiment-rejected", { status: record.state, learn: false });
        } else {
          this.emitEventSafely(record, "experiment-rejected", { status: record.state });
          this.emitEventSafely(record, "failure-learned", { status: record.state });
        }
      } catch {
        // Deliberately swallows: the caller gets the original Trial error, and a
        // secondary evidence failure must not replace the reason the Trial
        // failed. The warning is a fixed line so reporting it cannot re-enter the
        // boundary that just failed.
        this.warn(`[evolution] trial evidence write failed for ${record.id}; its target lock is released only if the Trial's undo was proven`);
      } finally {
        // Only a cleanup that proved the Trial is gone may release the target
        // claim and drop the record. A failed `undefine()` means the plugin may
        // still be mounted, and releasing the claim would let a second experiment
        // claim a target the runtime still holds (AGENTS.md invariant 3). The
        // retained record says which state it reached and why.
        if (undone) {
          this.releaseTargets(record);
          // A release blocked by cross-process lock contention keeps its claim
          // as the recovery basis. Keep the record too: dropping it here would
          // strand the in-memory target owner and the on-disk claim with no
          // record left to retry the release on the next availability check.
          if (record.targetsAcquired !== true) this.experiments.delete(record.id);
        }
      }
      throw error;
    }
    record.state = receipt.status === "awaiting-approval" ? "trial-awaiting-approval" : "trial";
    record.trialStartedAt = now();
    record.runtime = this.inspect(agent);
    // The Trial is defined, running and holding its target claim at this point.
    // A bridge failure must not turn that state into a reported failure: the
    // caller would retry against a live Trial it was told did not exist.
    this.emitEventSafely(record, "trial-completed", {
      status: record.state,
      evidence: { cordis: receipt, pluginId: record.pluginId, packageId: record.packageId },
    });
    return {
      ok: true,
      experimentId: record.id,
      phase: record.state,
      owner: record.ownerId,
      pluginId: record.pluginId,
      packageId: record.packageId,
      cordis: {
        status: receipt.status,
        pluginRunId: receipt.pluginRunId === undefined ? undefined : safeString(receipt.pluginRunId),
        nextPackageId: receipt.nextPackageId === undefined ? undefined : safeString(receipt.nextPackageId),
      },
      runtime: runtimeSignature(record.runtime),
    };
  }

  /**
   * Record one phase of the experiment's fixed scenario.
   *
   * The baseline runs in the `proposed` state, before any Trial mutation, and
   * the candidate runs while the Trial is mounted. Both phases execute the same
   * declared steps through the official tool pipeline; the orchestrator keeps
   * the raw rows and compares them itself, so the caller cannot submit an
   * aggregate. The candidate phase must reproduce the baseline scenario digest
   * and applicability exactly, which is what makes the comparison a paired
   * experiment instead of two unrelated observations.
   */
  /**
   * Refuse a probe scenario whose steps cannot be proven probe-safe.
   *
   * The official tool definition carries one truthful safety signal we can read
   * without a second registry or sandbox: `isConcurrencySafe(args) === true`
   * opts a tool into parallel dispatch, whose documented contract forbids
   * mutating parent-owned state (shared state must tolerate concurrency or fail
   * closed). A tool that does not opt in may write files, run shell commands or
   * change external systems, so it is refused before any call is made. Unknown
   * tools and the reserved `run_code` transport are refused for the same reason:
   * their behaviour cannot be proven in advance.
   */
  assertProbeSafety(agent, scenario, phase) {
    const tools = this.ctx?.tools;
    if (typeof tools?.get !== "function") {
      throw probeFailure("E_EVOLUTION_PROBE_SAFETY", "cannot prove scenario safety: the official tool registry does not expose tool definitions");
    }
    const steps = [];
    const absent = [];
    scenario.steps.forEach((declared, index) => {
      const step = scenario.kind === "workflow" && phase === "candidate" ? { ...declared, name: declared.candidateName } : declared;
      if (PROBE_FORBIDDEN_TOOLS.has(step.name) || PROBE_FORBIDDEN_PREFIXES.some((prefix) => step.name.startsWith(prefix))) {
        throw probeFailure(
          "E_EVOLUTION_PROBE_UNSAFE_STEP",
          `probe step ${step.name} is a delegation, background, scheduling, session, network, UI or lifecycle entry point; it cannot be proven probe-safe`,
        );
      }
      let definition;
      try {
        definition = tools.get(step.name, agent);
      } catch {
        // A registry failure is not evidence that the capability is absent. If
        // it were recorded as an absent-capability row, a later successful
        // lookup could turn an always-installed tool into a fabricated benefit.
        // The catch throws directly: a sentinel comparison would miss a thrown
        // `null`/`undefined`, which is a valid (if odd) rejection value.
        throw probeFailure("E_EVOLUTION_PROBE_SAFETY", `cannot resolve probe step ${step.name}: the official tool registry lookup failed`);
      }
      if (!definition && phase === "baseline" && step.absentInBaseline === true) {
        // The declared capability is not installed yet: the baseline records
        // its absence as the measured failure. The candidate phase still
        // requires the same step to resolve and opt into the official
        // concurrency-safe contract, so the comparison cannot be won by a typo,
        // an undeclared name, or a capability that never appears.
        absent.push(index);
        steps.push({ name: step.name, role: step.role, absent: true });
        return;
      }
      if (!definition) {
        throw probeFailure("E_EVOLUTION_PROBE_UNSAFE_STEP", `probe step ${step.name} is not registered; an unknown tool cannot be proven safe`);
      }
      let parsed;
      try {
        parsed = JSON.parse(step.arguments || "{}");
      } catch {
        parsed = null;
      }
      let safe = false;
      if (parsed !== null && typeof definition.isConcurrencySafe === "function") {
        try {
          safe = definition.isConcurrencySafe(parsed) === true;
        } catch {
          safe = false;
        }
      }
      if (!safe) {
        throw probeFailure("E_EVOLUTION_PROBE_UNSAFE_STEP", `probe step ${step.name} does not opt into the official concurrency-safe tool contract; write, shell and external side effects are refused unless the tool proves that contract`);
      }
      // A declared-absent step that is already registered runs as a real
      // measurement (the flag only permits absence, it never fakes a failure).
      steps.push({ name: step.name, role: step.role });
    });
    return Object.freeze({
      checked: true,
      policy: "official-concurrency-safe",
      steps: Object.freeze(steps),
      absent: Object.freeze(absent),
    });
  }

  async probe(args, exec) {
    const agent = ownerOf(exec);
    const record = this.requireOwned(args?.experimentId, agent);
    const phase = String(args?.phase || "").trim().toLowerCase();
    if (phase !== "baseline" && phase !== "candidate") throw probeFailure("E_EVOLUTION_PROBE_PHASE", 'phase must be "baseline" or "candidate"');
    const scenario = normalizeProbeScenario(args?.scenario);
    const applicability = this.applicability();
    const scenarioDigest = probeScenarioDigest(scenario, applicability);
    // Baseline and candidate share the exact same safety preflight: a scenario
    // that is refused in one phase can never run in the other.
    const safety = this.assertProbeSafety(agent, scenario, phase);
    if (scenario.kind === "workflow" && phase === "candidate") this.assertProbeSafety(agent, scenario, "baseline");
    // Every reason to refuse is checked before the operation claim is taken, so
    // a refused call never leaves a claim behind. A baseline measures the live
    // runtime, so it must be the only experiment driving it: a baseline captured
    // while another Trial is mounted would attribute that Trial's behaviour to
    // this experiment's own candidate later (the blocker this check exists for).
    let mode;
    if (phase === "baseline") {
      if (record.state !== "proposed") {
        throw probeFailure("E_EVOLUTION_PROBE_PHASE", `baseline probe requires proposed state; experiment ${record.id} is ${record.state}`);
      }
      if (record.probe?.baseline) {
        if (record.probe.scenarioDigest !== scenarioDigest) {
          throw probeFailure("E_EVOLUTION_PROBE_SCENARIO", "the baseline was already recorded with a different scenario or applicability");
        }
        return this.probeResult(record, "baseline");
      }
      this.assertRuntimeAvailable(record);
      mode = "baseline";
    } else {
      if (!["trial", "trial-awaiting-approval"].includes(record.state)) {
        throw probeFailure("E_EVOLUTION_PROBE_PHASE", `candidate probe requires an active Trial; experiment ${record.id} is ${record.state}`);
      }
      if (!record.probe?.baseline) {
        throw probeFailure("E_EVOLUTION_PROBE_BASELINE", "candidate probe requires a baseline recorded before the Trial");
      }
      if (record.probe.scenarioDigest !== scenarioDigest) {
        throw probeFailure("E_EVOLUTION_PROBE_SCENARIO", "the candidate scenario does not reproduce the baseline scenario digest/applicability");
      }
      if (record.probe.candidate) return this.probeResult(record, "candidate");
      mode = "candidate";
    }
    // A probe measures the live runtime, so it must be the only experiment
    // driving it. The operation claim keeps a concurrent revert/promote (or a
    // Trial started from another call) from switching the runtime under a
    // running probe.
    this.claimOperation(record, "probe");
    let holdClaim = false;
    try {
      const execute = (selected, label) => executeProbeScenario({ tools: this.ctx?.tools, agent, signal: exec?.signal,
        scenario: selected, phase: label, stepTimeoutMs: this.probeStepTimeoutMs, absent: safety.absent });
      let run;
      if (scenario.kind === "workflow" && phase === "candidate") {
        const reference = { samples: [] };
        run = { at: now(), samples: [], reference };
        for (let repetition = 0; repetition < scenario.repetitions; repetition += 1) {
          // Alternate order to avoid attributing warmed filesystem/provider caches
          // to the candidate. All calls remain under the same probe operation claim.
          for (const label of repetition % 2 === 0 ? ["reference", "candidate"] : ["candidate", "reference"]) {
            const selected = { ...scenario, repetitions: 1, steps: scenario.steps.map((step) => ({ ...step,
              name: label === "candidate" ? step.candidateName : step.name })) };
            const part = await execute(selected, `${label}-${repetition}`);
            (label === "candidate" ? run : reference).samples.push(...part.samples.map((row) => ({ ...row, repetition })));
          }
        }
        run.summary = probeSummary(run);
        reference.summary = probeSummary(reference);
      } else run = await execute(scenario, phase);
      if (mode === "baseline") {
        record.probe = {
          version: 1,
          scenario,
          scenarioDigest,
          versions: applicability,
          safety,
          recordedAt: now(),
          baseline: run,
          candidate: null,
          comparison: null,
        };
        return this.probeResult(record, "baseline");
      }
      record.probe.candidate = run;
      record.probe.candidateAt = now();
      record.probe.comparison = compareProbeRuns(record.probe.baseline, run);
      if (scenario.kind === "workflow") {
        record.probe.comparison = compareWorkflowProbeRuns(record.probe.baseline, run, scenario);
        if (!applicabilityKnown(applicability)) {
          Object.assign(record.probe.comparison, { benefit: false, benefitKind: null, workflowBenefit: false, repeatable: false });
          record.probe.comparison.workload.sufficient = false;
          record.probe.comparison.reasons.unshift("host applicability is unknown; environment comparability is unproven");
        }
      }
      return this.probeResult(record, "candidate");
    } catch (error) {
      if (error?.holdProbeClaim === true && error.settlePromise) {
        // A timed-out official call is still running. The claim is released only
        // when that call actually settles; until then every conflicting
        // lifecycle step is refused, so a revert cannot dispose the Trial next
        // to a live probe call.
        holdClaim = true;
        void Promise.resolve(error.settlePromise).then(() => {
          try { this.releaseOperation(record); } catch { /* claim map is in-process state */ }
        }, () => {
          try { this.releaseOperation(record); } catch { /* claim map is in-process state */ }
        });
      }
      throw error;
    } finally {
      if (!holdClaim) this.releaseOperation(record);
    }
  }

  probeResult(record, phase) {
    const probe = record.probe || {};
    return {
      ok: true,
      experimentId: record.id,
      phase,
      scenarioId: probe.scenario?.id ?? null,
      scenarioDigest: probe.scenarioDigest ?? null,
      versions: probe.versions ?? null,
      safety: probe.safety ?? null,
      baseline: probe.baseline?.summary ?? null,
      candidate: probe.candidate?.summary ?? null,
      comparison: probe.comparison ?? null,
      samples: phase === "candidate" ? (probe.candidate?.samples ?? []) : (probe.baseline?.samples ?? []),
      baselineSamples: phase === "candidate" ? (probe.baseline?.samples ?? []) : undefined,
      ...(probe.scenario?.kind === "workflow" ? { referenceSamples: probe.candidate?.reference?.samples ?? [] } : {}),
    };
  }

  measure(args, exec) {
    const agent = ownerOf(exec);
    const record = this.requireOwned(args?.experimentId, agent);
    if (!["trial", "trial-awaiting-approval"].includes(record.state)) throw new Error(`experiment ${record.id} is ${record.state}; Measure requires an active Trial`);
    const input = args?.observation;
    if (!input || typeof input !== "object") throw new Error("observation is required");
    if (typeof input.solvesProblem !== "boolean") throw new Error("observation.solvesProblem must be boolean");
    // Task-coupled evidence is optional on the wire and mandatory for the gate
    // when the proposal claims a workflow benefit. It is validated here, before
    // any durable write, so a malformed or mis-bound artifact fails the call
    // instead of being archived as if it were evidence.
    const taskId = args?.taskId === undefined ? null : text(args.taskId, "taskId");
    let taskBenefit;
    if (input.taskBenefit !== undefined) {
      if (!record.composition?.hostSha256) {
        // A Trial that never recorded its Host source cannot bind real-session
        // evidence to what it mounts; accepting it would attach an artifact to
        // code it may not describe.
        throw probeFailure("E_EVOLUTION_TASK_EVIDENCE", "the Trial did not bind its Host source; task evidence cannot be attributed");
      }
      const validated = validateTaskBenefit(input.taskBenefit, {
        hostSha256: record.composition?.hostSha256 ?? null,
        taskId,
        improvement: record.proposal?.improvement ?? "tool",
        applicability: this.applicability(),
      });
      if (!validated.ok) {
        throw probeFailure("E_EVOLUTION_TASK_EVIDENCE", `task benefit evidence rejected: ${validated.issues.slice(0, 4).join("; ")}`);
      }
      taskBenefit = validated.artifact;
    }
    const observation = {
      at: now(),
      solvesProblem: input.solvesProblem,
      sideEffects: evidenceList(stringList(input.sideEffects || [], "observation.sideEffects", { required: false })),
      orphanResources: evidenceList(stringList(input.orphanResources || [], "observation.orphanResources", { required: false })),
      performanceChange: evidenceValue(input.performanceChange, "unchanged"),
      errorChange: evidenceValue(input.errorChange, "unchanged"),
      // A measurement row is a bounded telemetry row, not an archive document: it
      // keeps `compactValue`'s row bounds (1200 chars / 8 items / depth 4), which
      // is what it kept before the archive's `EVIDENCE_PROJECTION` existed. A
      // caller-supplied metric object must not be able to inflate the durable
      // observation, the evidence sidecar, `exp-*.md` or the bridge payload by an
      // unbounded factor. Redaction is unaffected: the key-aware credential rule
      // lives inside `compactValue`'s object branch, so `{ token: … }` is still
      // `[redacted]` here with the row bounds restored.
      metrics: isObject(input.metrics) ? compactValue(input.metrics) : {},
      beforeMetrics: isObject(input.beforeMetrics) ? compactValue(input.beforeMetrics) : undefined,
      afterMetrics: isObject(input.afterMetrics) ? compactValue(input.afterMetrics) : undefined,
      observationWindow: evidenceValue(normalizeObservationWindow(input.observationWindow), undefined),
      sampleCount: Number.isInteger(input.sampleCount) && input.sampleCount > 0 ? input.sampleCount : undefined,
      benefitEvidence: evidenceText(input.benefitEvidence, "observation.benefitEvidence"),
      // Provenance of the measurement itself: capability samples that only
      // exercise the candidate tool are a self-test, not a workflow before/after.
      evidenceKind: ["capability-self-test", "comparative-workload", "caller-measurement", "task-coupled"].includes(input.evidenceKind)
        ? input.evidenceKind : undefined,
      ...(taskBenefit === undefined ? {} : { taskBenefit }),
      repeatable: input.repeatable === true,
      regressionPassed: input.regressionPassed === true,
      reversible: input.reversible === true,
      cleanupEvidence: evidenceText(input.cleanupEvidence, "observation.cleanupEvidence"),
    };
    // A completed probe pair is the authoritative measurement: the before/after
    // metrics, the window, the sample count, `solvesProblem`, repeatability and
    // the regression verdict are all recomputed from the raw executions the
    // orchestrator recorded, and the caller's versions of those fields are
    // replaced. The caller still supplies reversible/cleanup/orphan/risk text,
    // which are process facts a probe cannot observe.
    const derivedProbe = deriveProbeObservation(record.probe);
    if (derivedProbe) {
      const comparison = derivedProbe.comparison;
      if (comparison.workload) observation.evidenceKind = "comparative-workload";
      observation.probe = derivedProbe;
      observation.probeDerived = true;
      observation.beforeMetrics = { ...comparison.beforeMetrics };
      observation.afterMetrics = { ...comparison.afterMetrics };
      observation.observationWindow = `probe:${derivedProbe.scenarioId ?? "scenario"}`;
      observation.sampleCount = Math.max(1, comparison.after?.executions ?? 0);
      observation.solvesProblem = comparison.benefit === true;
      observation.repeatable = comparison.repeatable === true;
      // Correctness is both claimed by the caller and observed by the probe: a
      // control step that changed means the candidate is not correct even when
      // it improved the target step.
      observation.regressionPassed = input.regressionPassed === true
        && comparison.regression !== true
        && comparison.controlStable !== false;
      // The caller's metric object is dropped, not merged: it is unverified
      // input, and the advisory evaluator reads `metrics` before the derived
      // before/after snapshots. Keeping only the probe's own counts means no
      // caller-supplied number can reach either the gates or the evaluator.
      observation.metrics = {
        probeBenefit: comparison.benefit === true ? 1 : 0,
        probeControlStable: comparison.controlStable === true ? 1 : 0,
        probeWorkflowBenefit: comparison.workflowBenefit === true ? 1 : 0,
      };
      observation.benefitEvidence = `probe ${derivedProbe.scenarioId ?? "scenario"}: candidate ${comparison.after.successes}/${comparison.after.executions} vs baseline ${comparison.before.successes}/${comparison.before.executions}; errorCount ${comparison.before.errors}->${comparison.after.errors}; benefit=${comparison.benefit}; regression=${comparison.regression}`;
    } else if (record.probe?.baseline) {
      // A baseline without a candidate is not a measurement. It is recorded as
      // explicitly unproven instead of being promoted by the caller's claims.
      observation.probe = {
        scenarioId: record.probe.scenario?.id ?? null,
        scenarioDigest: record.probe.scenarioDigest ?? null,
        versions: record.probe.versions ?? null,
        incomplete: true,
        baseline: record.probe.baseline.summary ?? null,
      };
      // A baseline-only probe contributes no measurement. Caller-supplied
      // aggregates are dropped too, so `measuredEvidence` cannot be satisfied
      // by text the probe never observed.
      observation.solvesProblem = false;
      observation.repeatable = false;
      observation.regressionPassed = false;
      observation.beforeMetrics = undefined;
      observation.afterMetrics = undefined;
      observation.sampleCount = undefined;
      observation.observationWindow = undefined;
      observation.metrics = {};
    }
    // A task-coupled artifact is the only measurement a context-policy
    // candidate has; when a probe pair also exists, both must agree before the
    // observation claims a benefit.
    if (taskBenefit !== undefined) {
      if (!derivedProbe) {
        observation.evidenceKind = "task-coupled";
        observation.solvesProblem = taskBenefit.benefit === true;
        observation.repeatable = taskBenefit.correctness.baseline && taskBenefit.correctness.candidate
          && taskBenefit.runs.candidate >= 3;
        observation.regressionPassed = observation.repeatable && taskBenefit.regression === false;
        observation.beforeMetrics = {
          sessions: taskBenefit.baseline.sessions, correct: taskBenefit.baseline.correct,
          failures: taskBenefit.baseline.failures, turns: taskBenefit.baseline.turns,
          toolCalls: taskBenefit.baseline.toolCalls, tokens: taskBenefit.baseline.tokens,
          durationMs: taskBenefit.baseline.durationMs,
        };
        observation.afterMetrics = {
          sessions: taskBenefit.candidate.sessions, correct: taskBenefit.candidate.correct,
          failures: taskBenefit.candidate.failures, turns: taskBenefit.candidate.turns,
          toolCalls: taskBenefit.candidate.toolCalls, tokens: taskBenefit.candidate.tokens,
          durationMs: taskBenefit.candidate.durationMs,
        };
        observation.metrics = {
          taskSessions: taskBenefit.candidate.sessions,
          taskTurns: taskBenefit.candidate.turns,
          taskToolCalls: taskBenefit.candidate.toolCalls,
          taskBenefit: taskBenefit.benefit === true ? 1 : 0,
        };
        observation.observationWindow = `task:${taskBenefit.task.id ?? "scenario"}`;
        observation.sampleCount = taskBenefit.candidate.sessions;
        observation.benefitEvidence = `paired real sessions (${taskBenefit.model ?? "unknown model"}): baseline ${taskBenefit.baseline.turns} turns/${taskBenefit.baseline.toolCalls} calls vs candidate ${taskBenefit.candidate.turns} turns/${taskBenefit.candidate.toolCalls} calls; correct ${taskBenefit.baseline.correct}/${taskBenefit.baseline.sessions} vs ${taskBenefit.candidate.correct}/${taskBenefit.candidate.sessions}`.slice(0, 900);
      } else {
        observation.solvesProblem = observation.solvesProblem === true && taskBenefit.benefit === true;
        observation.repeatable = observation.repeatable === true && taskBenefit.runs.candidate >= 3;
        observation.regressionPassed = observation.regressionPassed === true && taskBenefit.regression === false;
      }
    }
    record.latestObservation = observation;
    record.observations.push(observation);
    record.state = "measured";
    record.trialFrozen = true;
    record.frozenAt = now();
    record.runtime = this.inspect(agent);
    record.decision = classifyExperimentDecision(record, { at: now(), source: "measure" });
    // Same boundary as `trial`: the measurement is already recorded and the
    // trial is frozen. An auxiliary event write cannot make that measurement
    // fail, which for the autonomous observer would revert a successful Trial
    // and learn a failure the strategy never produced.
    this.emitEventSafely(record, "measurement-completed", {
      status: record.state,
      measurement: observation,
    });
    return {
      ok: true,
      experimentId: record.id,
      phase: record.state,
      observation,
      decision: record.decision,
      gates: promotionGates(record, { requireRuntimeRecovery: false }),
      runtime: runtimeSignature(record.runtime),
    };
  }

  async disposeTrial(record, agent) {
    let stop;
    let removed;
    const errors = [];
    // The cleanup receipt is durable evidence: its text reaches the cleanup and
    // recovery proofs, the archive and the event bridge, so every message
    // crosses the safe-error boundary here, at the point of capture. The
    // classification and digest stay attached so the failure is still
    // diagnosable after redaction.
    //
    // `stop()` and `undefine()` are two independent disposers and both must run:
    // a receipt that cannot be built is evidence about a cleanup, so it may not
    // decide whether the *next* cleanup step runs. Two guards make that true
    // structurally — `safeErrorDto` is total (it degrades rather than throwing),
    // and this helper degrades once more if the boundary itself ever regressed —
    // so `undefine()` is reached even when building the `stop()` receipt fails.
    const receipt = (label, error) => {
      let detail;
      try {
        detail = safeErrorDto(error, "cleanup");
      } catch {
        detail = { errorSummary: DEGRADED_ERROR_SUMMARY, errorCategory: DEGRADED_ERROR_CATEGORY, errorDigest: DEGRADED_ERROR_DIGEST };
      }
      errors.push(`${label}: ${detail.errorSummary}`);
      return { ok: false, error: detail.errorSummary, errorCategory: detail.errorCategory, errorDigest: detail.errorDigest };
    };
    try { stop = await this.runner.stop(agent, record.pluginId); } catch (error) { stop = receipt("stop", error); }
    try { removed = await this.runner.undefine(agent, record.pluginId); } catch (error) { removed = receipt("undefine", error); }
    record.dispose = { stop, removed, at: now() };
    record.runtimeAfterDispose = this.inspect(agent);
    const signatureRecovered = signatureEqual(record.trialBaseline || record.baseline, record.runtimeAfterDispose);
    // `stopOk` / `removedOk` mean "this step is proven", not "this call answered ok":
    // the official disposers are not idempotent, and two of their documented
    // refusals prove the state the cleanup needs instead of denying it
    // (`@deepseek-ai/dsh-cordis-host-runner` types: `DynamicCordisStopResponse`
    // answers `not-running` when the plugin has no active run and `plugin-missing`
    // when it does not exist; `DynamicCordisUndefineReceipt` answers
    // `plugin-missing` when it is already gone). Both are closed unions, so a
    // retry after a partially successful cleanup sees exactly these: `stop` ->
    // `not-running` once the first attempt stopped the run. Reading them as plain
    // failures made the retry path in `revert()` unable to ever prove recovery,
    // which left the record and its target claim held for the rest of the process.
    // A thrown receipt, an unknown reason or any other shape stays unproven.
    const stopProved = disposerProved("stop", stop);
    const removedProved = disposerProved("undefine", removed);
    record.runtimeRecovered = errors.length === 0 && stopProved && removedProved && signatureRecovered;
    record.cleanupProof = { stopOk: stopProved, removedOk: removedProved, signatureRecovered, errors, at: now() };
    record.recoveryProof = captureCurrentRecoveryProof(record);
    return { stop, removed, runtime: runtimeSignature(record.runtimeAfterDispose), recovered: record.runtimeRecovered, errors };
  }

  /**
   * Terminal evidence write for a failed or rejected operation. An archive
   * failure is recorded as a warning: it must never skip the cleanup
   * (operation claim, target lock, experiment record) that the caller keeps in
   * a `finally`.
   *
   * `options.preserveArchiveFile` carries the preserved promotion journal when
   * the commit failed with a CAS conflict/rollback failure. The transaction's
   * own `exp-*.md` is then live evidence owned by that journal, so the failure
   * record goes to `exp-*.failure.json` in the same directory and the archive
   * file is left exactly as the journal left it.
   *
   * `options.learn: false` writes the same archive and events but skips the
   * durable failure *learning*: an environment failure must never become a
   * "this approach already failed" entry in the experience recall.
   */
  async archiveTerminal(record, reason, options = {}) {
    try {
      return await this.archive(record, reason, options);
    } catch (error) {
      // A warning is a durable-looking log line: it crosses the same boundary
      // as the archive it describes.
      const detail = safeErrorDto(error, "archive");
      record.archiveWarning = detail.errorSummary;
      record.archiveWarningCategory = detail.errorCategory;
      record.archiveWarningDigest = detail.errorDigest;
      this.warn(`[evolution] ${reason} archive failed for ${record.id}: ${detail.errorSummary} (${detail.errorCategory}, ${detail.errorDigest})`);
      return null;
    }
  }

  /**
   * One execution event; a bridge failure is a warning, not an operation
   * failure. Callers only use this for events that describe an already
   * committed transition or an already-recorded failure: the event is
   * auxiliary evidence, so neither a rejected append nor a throwing logger may
   * replace the result the caller is entitled to.
   */
  emitEventSafely(record, type, payload = {}) {
    let failure;
    try {
      return this.emitExecutionEvent(type, record, payload);
    } catch (error) {
      failure = error;
    }
    const detail = safeErrorDto(failure, "event-bridge");
    record.eventBridgeWarning = detail.errorSummary;
    record.eventBridgeWarningCategory = detail.errorCategory;
    record.eventBridgeWarningDigest = detail.errorDigest;
    this.warn(`[evolution] ${type} emission failed for ${record.id}: ${detail.errorSummary} (${detail.errorCategory}, ${detail.errorDigest})`);
    return null;
  }

  async revert(args, exec) {
    const agent = ownerOf(exec);
    const record = this.requireOwned(args?.experimentId, agent);
    // A cleanup that could not prove runtime recovery is retryable, and it has to
    // be: `revert-failed` and `trial-cleanup-failed` deliberately keep the target
    // claim and keep the record occupying the runtime (AGENTS.md invariant 3),
    // while no lifecycle entry point accepted them. Every later Trial in the
    // process was then refused with `E_EVOLUTION_RUNTIME_BUSY` and advice ("revert
    // or promote it") that no tool could carry out, and the failure hint this
    // file writes on that path ("fix the dispose path and re-establish the
    // baseline") named a step that is itself refused - a transient stop/undefine
    // failure ended the evolution loop until the host was restarted.
    //
    // The retry is the same cleanup, not a weaker one: it runs the same official
    // disposers and compares the runtime against the same single baseline captured
    // before the first mutation, and it releases the claim only when that proof
    // passes (`disposeTrial`). A retry that still cannot prove recovery therefore
    // changes nothing about what this record owns.
    if (!REVERTABLE_STATES.has(record.state)) throw new Error(`experiment ${record.id} is ${record.state}; Revert requires a Trial`);
    this.claimOperation(record, "revert");
    record.state = "reverting";
    // `disposed` stays `null` while the cleanup itself is running, and a throw
    // from it (the cleanup receipt is built on this very path) leaves it `null`:
    // that is an *unknown* runtime state, which the `finally` treats exactly like
    // `recovered: false` — the operation claim is released, the target lock is
    // not, because a failed revert may not free a target the runtime still owns.
    let disposed = null;
    try {
      // Inside the guarded block, not before it: a throw from the cleanup or from
      // its evidence must not skip the `finally` that releases the operation
      // claim.
      disposed = await this.disposeTrial(record, agent);
      record.state = disposed.recovered ? "reverted" : "revert-failed";
      if (disposed.recovered) {
        // A proven recovery is the terminal outcome, so the archive it is about to
        // write may not also carry a failure block claiming the opposite ("Cordis
        // cleanup did not prove runtime recovery" beside `recovered: true`). That
        // contradiction now has two routine sources: this retry, and a record whose
        // earlier Promotion gate rejection left `failure` behind and is then
        // reverted. The superseded failure stays durable where it was emitted - the
        // authenticated event log (`failure-learned`) and the failure-memory entry
        // `archive()` wrote for it - so nothing is hidden by dropping it here.
        record.failure = undefined;
      } else {
        record.failure = safeFailureLearning({
          record,
          phase: "revert",
          error: new Error("Cordis cleanup did not prove runtime recovery"),
          rollbackResult: { stop: disposed.stop, removed: disposed.removed, errors: disposed.errors },
          nextPreventionHint: "先确认 disposer 失败是否为暂时性并重试 evolution_revert；持续失败再修复 dispose 路径并重新建立基线。",
        });
      }
      // A revert is a terminal decision even when it was not measured: the
      // archive records what was known, and the conclusion records that the
      // strategy did not earn adoption. Neither path may invent a benefit.
      if (!record.decision) record.decision = classifyExperimentDecision(record, { at: now(), source: "revert" });
      // An invalid pair did not measure the strategy, so a successful revert must
      // not write a local failure-memory entry that later recall presents as a
      // failed approach. A cleanup failure keeps the normal learning path: that
      // is an environment outcome, not a hypothesis verdict.
      const invalidMeasuredPair = disposed.recovered
        && (record.probe?.comparison?.measurementInvalid === true
          || record.latestObservation?.probe?.comparison?.measurementInvalid === true);
      await this.archiveTerminal(record, "revert", invalidMeasuredPair ? { learn: false } : {});
      if (disposed.recovered) this.publishConclusion(record, conclusionKindFor(record), "revert");
      if (disposed.recovered && record.autonomous) {
        // Releasing the durable reservation is bookkeeping after the cleanup
        // proof, not part of that proof. A storage failure here must not turn a
        // successful revert into `revert-failed`: the autonomous observer would
        // then read it as a strategy failure and write session suppression and
        // durable failure memory for a hypothesis that was never disproved.
        const identity = `${record.autonomous.patternKey}:${record.autonomous.strategyFingerprint}`;
        try {
          await this.domainStorage?.releaseAutonomousDecision?.(identity);
          this.pendingDecisionReleases.delete(identity);
        } catch {
          // Keep the identity for the next observation of the same hypothesis:
          // without this, the durable hold outlives the reverted experiment and
          // no tool can answer the resulting `prior-decision-requires-owner`.
          this.pendingDecisionReleases.add(identity);
          this.warn('[evolution] could not release an autonomous decision reservation after a proven revert; a later observation will retry it');
        }
      }
      if (disposed.recovered) this.emitEventSafely(record, "promotion-reverted", { status: record.state, evidence: record.cleanupProof });
      else {
        this.emitEventSafely(record, "experiment-rejected", { status: record.state, evidence: record.cleanupProof });
        this.emitEventSafely(record, "failure-learned", { status: record.state });
      }
    } catch (error) {
      // The cleanup did not produce a proof, so the revert did not happen. The
      // record keeps the failure (`safeFailureLearning` is total) and the caller
      // still receives the original error; the release below runs either way,
      // because a `finally` is entered even when this `catch` throws.
      record.state = "revert-failed";
      record.failure = safeFailureLearning({
        record,
        phase: "revert",
        error,
        rollbackResult: { stop: record.dispose?.stop, removed: record.dispose?.removed },
        nextPreventionHint: "清理路径本身报错，运行时是否恢复未知；不要继续 Promotion，先重试 evolution_revert，持续失败再复现并修复 dispose 路径。",
      });
      throw error;
    } finally {
      // The claim and (on a proven recovery) the target lock are released even
      // when the revert evidence cannot be written. `disposed?.recovered === true`
      // and not `disposed?.recovered`: only a cleanup that *proved* recovery may
      // release the lock, an absent proof may not.
      this.releaseOperation(record);
      if (disposed?.recovered === true) this.releaseTargets(record);
    }
    return {
      ok: disposed.recovered,
      experimentId: record.id,
      phase: record.state,
      runtimeRecovered: disposed.recovered,
      runtime: disposed.runtime,
      stop: disposed.stop,
      removed: disposed.removed,
      archive: record.archivePath,
      decision: record.decision,
    };
  }

  async promote(args, exec) {
    if (!this.paths.promotionRuntime) throw new Error('Evolution promotion requires an active official Include adapter; no production writes permitted');
    // A context-policy candidate has no tool of its own: without a durable
    // functional-check obligation a purely healthy startup observation can fill
    // the canary window and commit stable even though the candidate's effect was
    // never observed. The obligation is optional and additive: older callers
    // keep the health-only window, and the kernel never weakens its own default.
    const canaryVerification = normalizeCanaryVerification(args?.canaryVerification);
    const requestedFromCheck = Number(canaryVerification?.requiredObservations);
    const requestedFromCaller = Number(args?.canaryWindow);
    const requestedWindow = Math.max(Number.isSafeInteger(requestedFromCheck) ? requestedFromCheck : 0,
      Number.isSafeInteger(requestedFromCaller) && requestedFromCaller >= 1 && requestedFromCaller <= 5 ? requestedFromCaller : 0);
    const canaryWindow = requestedWindow > 0 ? Math.max(this.canaryWindow, requestedWindow) : this.canaryWindow;
    const agent = ownerOf(exec);
    const record = this.requireOwned(args?.experimentId, agent);
    if (record.state !== "measured") throw new Error(`experiment ${record.id} is ${record.state}; Promotion requires Measure first`);
    // Validate the deployment scope before anything mutates, so a typo in the
    // requested profiles is refused on both the confirmation-gated and the
    // confirmed path instead of being silently treated as Desktop-only.
    const shareTargets = normalizeShareTargets(args?.targetProfiles);
    if (args?.confirmation !== true) {
      return {
        ok: false,
        experimentId: record.id,
        phase: "awaiting-owner-confirmation",
        reason: "explicit_user_confirmation_required_for_production_promotion",
        recommendation: "promote after reviewing the measured evidence and rollback proof",
        decision: record.decision ?? null,
        shareTargets,
        gates: promotionGates(record, { requireRuntimeRecovery: false }),
      };
    }
    // A context-policy candidate has no tool of its own: its only admissible
    // functional proof is the declared check. The read-only owner-gate call
    // above must stay usable without it; enforce the obligation only on the
    // confirmed path, before any durable write. Tool-form and historical
    // experiments keep their existing health-only canary contract.
    if (record.proposal?.improvement === "context-policy" && canaryVerification === null) {
      throw new Error("a context-policy promotion requires canaryVerification with a read-only functional check and observations 1..5");
    }
    let domainEvaluation;
    // An invalid probe pair (transport failure or unmeasured PTC execution) did
    // not measure both sides. Letting the advisory evaluator turn its error
    // counts into a regression would replace the recorded insufficient-evidence
    // outcome and publish a strategy verdict the pair cannot support.
    const measurementInvalid = record.probe?.comparison?.measurementInvalid === true
      || record.latestObservation?.probe?.comparison?.measurementInvalid === true;
    if (this.domainStorage && !measurementInvalid) {
      // The extracted Dockyard evaluator is advisory here: the matured
      // `promotionGates` above remain the production authority. The evaluator
      // contributes an explicit hard veto when it proves a regression, and its
      // full decision is recorded on the promotion and the tool result.
      try {
        domainEvaluation = this.domainStorage.evaluate(domainEvaluationEvidence(record));
      } catch (error) {
        domainEvaluation = { decision: 'reject', reason: `domain evaluator failed: ${error?.message || error}`, evaluatorError: true };
      }
      record.domainEvaluation = domainEvaluation;
      if (domainEvaluation.decision === 'rollback') {
        // The advisory evaluator proved a regression, so the Compose decision is
        // recorded, but it is not published as a durable conclusion: an advisory
        // veto is not a measured experiment outcome, and the owner can still
        // correct the measurement instead of the strategy. A verdict that
        // `measure()` already reached from the experiment itself is different:
        // a real regression or no-benefit must survive the veto, or the owner's
        // revert would publish `insufficient-evidence` instead of the lesson the
        // measurement actually proved.
        const measuredVerdict = record.decision
          && record.decision.source !== "domain-evaluator"
          && (record.decision.kind === "regression" || record.decision.kind === "no-benefit");
        if (!measuredVerdict) record.decision = {
          version: 1,
          // An advisory veto is not a measured experiment verdict. Call it
          // what it is so `conclusionKindFor()` cannot turn a later owner
          // revert into a durable `regression` conclusion: that would write a
          // permanent "proven ineffective" lesson into shared experience and
          // block the same hypothesis in every later session, even though the
          // owner may only need to correct the measurement. The veto is still
          // visible here, on the tool result and on the archive.
          kind: "insufficient-evidence",
          source: "domain-evaluator",
          advisoryRegression: true,
          at: now(),
          observationAt: record.latestObservation?.at || null,
          eligible: false,
          reasons: ["advisory evaluator proved a regression in the measured metrics; the owner may correct the measurement before reverting"],
          gates: null,
          probe: record.decision?.probe ?? null,
        };
        return { ok: false, experimentId: record.id, phase: record.state, reason: 'domain-evaluator-rollback', domainEvaluation,
          decision: record.decision,
          gates: promotionGates(record, { requireRuntimeRecovery: false }) };
      }
    }
    this.claimOperation(record, "promote");
    record.state = "promotion-preparing";
    // Cross-entry deployment approval belongs to the promotion, not to the
    // confirmation flag: it is persisted with the durable transaction (journal,
    // evidence snapshot and archive) so a stable commit can publish it later and
    // a rollback leaves no shareable record behind.
    if (shareTargets.length > 0) record.shareTargets = shareTargets;
    else delete record.shareTargets;
    const evidenceGates = promotionGates(record, { requireRuntimeRecovery: false });
    if (!evidenceGates.eligible) {
      try {
        // The failure DTO is built inside the `try` that owns the release: an
        // exception here must not leave the operation claim behind.
        record.failure = safeFailureLearning({
          record,
          phase: "promotion-gate",
          error: new Error("promotion evidence gate failed"),
          rollbackResult: record.dispose || { ok: false, status: "not-run" },
          nextPreventionHint: "补齐 benefit、repeatability、regression、reversibility、cleanup evidence；不以文本覆盖缺失证据。",
        });
        // An invalid pair is not a strategy verdict: keep the rejection and its
        // archive as diagnostic evidence, but do not write a `dontRepeat` failure
        // memory or a `failure-learned` event that would contradict the
        // insufficient-evidence conclusion published beside it.
        await this.archiveTerminal(record, "promotion-gate", measurementInvalid ? { learn: false } : {});
        // A gate rejection is a real Compose outcome: the experiment did not
        // prove its benefit, so the next round must find that recorded instead
        // of starting from zero. The record stays `measured`, so a corrected
        // measurement can still supersede this conclusion under the same
        // identity.
        if (!record.decision) record.decision = classifyExperimentDecision(record, { at: now(), source: "promotion-gates" });
        // A gate rejection is often a measured regression (regressionTest is one
        // of the eight gates). Publish the verdict the classifier reached so a
        // regression that is never reverted is still learnable; only the other
        // non-verdict outcomes stay insufficient-evidence. `conclusionKindFor`
        // is not used here because its `benefit -> reverted-unconfirmed` branch
        // would misdescribe a rejection that had no revert.
        const gateConclusion = record.decision?.kind === "regression" ? "regression"
          : record.decision?.kind === "no-benefit" ? "no-benefit"
          : "insufficient-evidence";
        this.publishConclusion(record, gateConclusion, "promotion-gates");
        this.emitEventSafely(record, "experiment-rejected", { status: record.state, evidence: evidenceGates, ...(measurementInvalid ? { learn: false } : {}) });
        if (!measurementInvalid) this.emitEventSafely(record, "failure-learned", { status: record.state });
      } finally {
        record.state = "measured";
        this.releaseOperation(record);
      }
      return { ok: false, experimentId: record.id, phase: record.state, reason: "promotion-gate", decision: record.decision, gates: evidenceGates };
    }
    let packageInspection;
    let packageInspectionError;
    try {
      packageInspection = this.runner.inspectPackage(agent, record.pluginId, record.packageId);
    } catch (error) {
      packageInspectionError = error;
    }
    let disposed;
    try {
      disposed = await this.disposeTrial(record, agent);
    } catch (error) {
      // The cleanup threw before it built a proof, so no evidence branch below
      // has run yet and none of them owns the release. The operation claim is
      // released here; the target lock deliberately stays claimed, because an
      // unknown cleanup outcome is not a proven runtime recovery — the same rule
      // the `promotion-cleanup` branch applies immediately below.
      record.state = "revert-failed";
      try {
        record.failure = safeFailureLearning({
          record,
          phase: "promotion-cleanup",
          error,
          rollbackResult: { stop: record.dispose?.stop, removed: record.dispose?.removed },
          nextPreventionHint: "清理路径本身报错，运行时是否恢复未知；保留 trial 现场，先复现并修复 dispose 路径。",
        });
      } finally {
        this.releaseOperation(record);
      }
      // The original exception still reaches a direct caller unchanged, but a
      // host driving this through the tool channel needs a structured signal:
      // without one it cannot tell a pre-canary cleanup failure from a timeout
      // and skips the ordinary `evolution_revert` retry.
      error.promotionCleanupFailed = true;
      error.promotionPhase = record.state;
      throw error;
    }
    if (packageInspectionError) {
      // A failed inspection is terminal only when the Trial was actually disposed.
      // When the cleanup cannot prove recovery, a terminal state would strand the
      // target claim with no usable exit: `revert` refuses a terminal record,
      // `promote` needs `measured`, and `trial` reports E_EVOLUTION_RUNTIME_BUSY
      // with advice ("revert or promote") neither tool can carry out. Keep the
      // same retryable state the other unproven-cleanup branch uses so a later
      // `evolution_revert` can retry the disposers against the captured baseline.
      // The archive still records the inspection stage as the reason; only the
      // lifecycle state changes, and `runtimeRecovered` below stays honest.
      record.state = disposed.recovered ? "promotion-failed" : "revert-failed";
      try {
        record.failure = safeFailureLearning({
          record,
          phase: "promotion-inspection",
          error: packageInspectionError,
          rollbackResult: { stop: disposed.stop, removed: disposed.removed, errors: disposed.errors },
          nextPreventionHint: "先修复 Cordis Package inspection，再重新建立 Trial；不能在未读取 Host 代码时写入 durable Plugin。",
        });
        await this.archiveTerminal(record, "promotion-inspection-failed");
        this.emitEventSafely(record, "experiment-rejected", { status: record.state });
        this.emitEventSafely(record, "failure-learned", { status: record.state });
      } finally {
        this.releaseOperation(record);
        if (disposed.recovered) this.releaseTargets(record);
      }
      return { ok: false, experimentId: record.id, phase: record.state, reason: "package-inspection-failed", runtimeRecovered: disposed.recovered, archive: record.archivePath };
    }
    const gates = promotionGates(record);
    if (!disposed.recovered || !gates.eligible) {
      record.state = "revert-failed";
      try {
        record.failure = safeFailureLearning({
          record,
          phase: "promotion-cleanup",
          error: new Error("Promotion cleanup did not prove runtime recovery"),
          rollbackResult: { stop: disposed.stop, removed: disposed.removed, errors: disposed.errors },
          nextPreventionHint: "保留 Trial 为失败学习样本；检查 Cordis disposer、event listener 和动态 Plugin 是否仍存活。",
        });
        await this.archiveTerminal(record, "promotion-rejected-runtime-not-recovered");
        this.emitEventSafely(record, "experiment-rejected", { status: record.state, evidence: gates });
        this.emitEventSafely(record, "failure-learned", { status: record.state });
      } finally {
        // The target lock stays claimed on purpose: the runtime was not
        // recovered, so this trial still owns it (AGENTS.md invariant 3).
        this.releaseOperation(record);
      }
      return { ok: false, experimentId: record.id, phase: record.state, reason: "runtime-not-recovered", runtime: disposed.runtime, gates, archive: record.archivePath };
    }
    record.state = "promoting";
    // The promotion journal snapshots the record immediately; a decision that
    // only existed in memory would not reach the archive the transaction writes.
    if (!record.decision) record.decision = classifyExperimentDecision(record, { at: now(), source: "promotion" });
    record.lastGateEvidence = { gates, evidence: evidenceGates, at: now() };
    // The durable archive describes the intended terminal state; the in-memory
    // record remains "promoting" until the journaled commit verifies.
    let durable;
    try {
      durable = await writeDurablePromotion({
        experiment: record,
        packageInspection,
        paths: this.paths,
        canaryWindow,
        canaryVerification,
        lockTtlMs: this.promotionLockTtlMs,
        // Only an explicitly approved promotion needs a verified publication
        // identity: it is captured once here, with the exact bytes the commit
        // writes and the host that accepted the promotion, and it travels with
        // the durable stable fact so a later republish cannot adopt a changed
        // source or an upgraded host as "verified".
        publicationHost: shareTargets.length > 0 ? this.sharedPluginFacts().host : null,
      });
    } catch (error) {
      record.state = "promotion-failed";
      try {
        record.failure = safeFailureLearning({
          record,
          phase: "promotion-commit",
          error,
          rollbackResult: error?.promotionJournal?.phase === "rollback-failed"
            ? { ok: false, status: "rollback-failed" }
            : { ok: false, status: "rollback-unverified" },
          nextPreventionHint: "检查 promotion journal、backup、原子写入和 reload/mount verify；下次调用会先恢复未完成事务。",
        });
        // A preserved journal means the commit's own files are still evidence:
        // the failure record goes to a sidecar instead of overwriting them.
        const preserved = error?.promotionJournal?.preserved === true ? error.promotionJournal : null;
        await this.archiveTerminal(record, "promotion-failed", { preserveArchiveFile: preserved });
        this.emitEventSafely(record, "experiment-rejected", { status: record.state });
        this.emitEventSafely(record, "failure-learned", { status: record.state });
      } finally {
        this.releaseOperation(record);
        this.releaseTargets(record);
      }
      throw error;
    }
    record.state = "canary-observing";
    record.durable = durable;
    record.archivePath = durable.archivePath;    record.canary = { promotionTimestamp: durable.promotionTimestamp, healthObservationWindow: durable.healthObservationWindow, startupVerified: false, observations: [] };
    if (durable.canaryVerification) record.canary.verification = durable.canaryVerification;
    // The promotion is durable at this point. Release the operation claim before
    // the fallible event write: an event-bridge failure must not leave the
    // record permanently busy with `promote` for the rest of the process.
    this.releaseOperation(record);
    this.emitEventSafely(record, "promotion-succeeded", {
      status: record.state,
      promotion: durable,
      evidence: gates,
    });
    return {
      ok: true,
      experimentId: record.id,
      phase: record.state,
      gates,
      decision: record.decision,
      domainEvaluation,
      runtimeRecovered: true,
      // The approval scope persists; the publication itself waits for the
      // stable canary commit and is reported separately by that transition.
      shareTargets: [...(record.shareTargets || [])],
      nextSession: durable,
      canary: structuredClone(record.canary),
      // The host needs the exact binding digest to attach to each functional
      // observation, including the ones replayed after a host restart.
      canaryVerification: durable.canaryVerification ? structuredClone(durable.canaryVerification) : null,
      rollback: `automatic until stable commit; remove composition row ${durable.rowId} and ${durable.pluginPath}, then start a new session`,
    };
  }

  // Reuse the event bridge's tested cross-process mutex for the short
  // read-classify-replace window. Its reclaim marker serializes reclaimers and
  // its token-checked release cannot remove another call's lock.
  withTargetClaimLock(ownershipDir, target, act) {
    const lockTarget = path.join(ownershipDir, sha256(target) + '.json.claim-lock-target');
    return withEventBridgeAppendLock(lockTarget, act);
  }


  acquireTargets(record) {
    const conflicts = (record.targets || []).filter((target) => {
      const owner = this.targetOwners.get(target);
      return owner && owner !== record.id;
    });
    if (conflicts.length > 0) throw new Error(`unsafe parallel experiment conflicts on ${conflicts.join(", ")}`);
    fs.mkdirSync(this.paths.ownershipDir, { recursive: true, mode: 0o700 });
    const acquired = [];
    try {
      for (const target of record.targets || []) {
        const file = path.join(this.paths.ownershipDir, `${sha256(target)}.json`);
        // Serialize the whole read-classify-replace window for this target.
        this.withTargetClaimLock(this.paths.ownershipDir, target, () => {
        const claim = { schema: 1, target, experimentId: record.id, ownerId: record.ownerId, pid: process.pid, hostname: os.hostname(), acquiredAt: now() };
        let opened = false;
        for (let attempt = 0; attempt < 2 && !opened; attempt += 1) {
          // A claim is accepted only once its JSON is complete, and the reader
          // below deliberately does not delete an entry it cannot interpret, so
          // an entry this call created and then failed to write would refuse the
          // target for the rest of the archive's life. Two flags record what the
          // call can prove: that `wx` created the entry, and that the claim JSON
          // reached it. Only the first without the second is removed - a claim
          // whose bytes are complete is not deleted, because a retry of the same
          // experiment adopts it by id and a different experiment must see a
          // conflict rather than lose the claim it may already have acted on.
          let created = false;
          let wrote = false;
          try {
            const fd = fs.openSync(file, "wx", 0o600);
            created = true;
            try {
              fs.writeFileSync(fd, `${JSON.stringify(claim)}\n`);
              wrote = true;
            } catch (error) {
              // The failed write is what makes the claim unusable, so it stays
              // the error the caller sees even if closing the descriptor also
              // fails.
              try { fs.closeSync(fd); } catch {}
              throw error;
            }
            fs.closeSync(fd);
            opened = true;
          } catch (error) {
            // `wx` proves the entry is this call's own, so a pre-existing claim
            // is never touched; the removal is best effort, because a cleanup
            // failure must not replace the storage error the caller has to act
            // on, and the leftover is then the same orphan a crash would leave.
            if (created && !wrote) { try { fs.rmSync(file, { force: true }); } catch {} }
            if (error?.code !== "EEXIST") throw error;
            let text;
            try { text = fs.readFileSync(file, "utf8"); } catch { throw new Error(`experiment ownership is unreadable for ${target}`); }
            // Parse, adopt by experiment id, then classify - the pre-change order.
            // The adoption read touches the raw parsed value first, so a JSON body
            // of `null` throws exactly the TypeError the pre-change code threw.
            const parsed = parseTargetClaim(text);
            if (parsed.error !== null) throw new Error(`experiment ownership is unreadable for ${target}`);
            if (parsed.parsed.experimentId === record.id) {
              // Adopt only our own claim. A claim left by a previous process of
              // this same experiment still carries that process's (now dead) pid:
              // without refreshing it this owner believes it holds the target
              // while a third process classifies the stale entry RECLAIMABLE and
              // steals it, leaving two owners of one target. Rewriting the
              // liveness identity under the per-target lock makes every other
              // acquirer see a live owner. A claim already bearing this process's
              // identity is left byte-identical (no liveness fact to refresh).
              const stored = parsed.parsed;
              if (stored.hostname !== os.hostname() || stored.pid !== process.pid) {
                const adopted = { ...stored, pid: process.pid, hostname: os.hostname(), acquiredAt: now() };
                const tmp = `${file}.${crypto.randomUUID()}.tmp`;
                try {
                  fs.writeFileSync(tmp, `${JSON.stringify(adopted)}\n`, { mode: 0o600 });
                  fs.renameSync(tmp, file);
                } catch (error) {
                  try { fs.rmSync(tmp, { force: true }); } catch {}
                  throw error;
                }
              }
              opened = true;
              break;
            }
            // One classification drives both sides: the doctor reports the same
            // state this call acts on. Only `reclaimable` entries are removed,
            // and only on the first attempt, so a claim whose owner cannot be
            // proven gone stays where it is and keeps refusing the target.
            const classified = classifyTargetClaim(parsed);
            if (classified.state === TARGET_CLAIM_STATES.RECLAIMABLE && attempt === 0) {
              // The surrounding per-target lock serializes every acquirer of
              // this target, so the bytes just classified cannot be replaced
              // before the removal. Re-read under the lock to prove the owner
              // is still gone, then remove only that proven entry.
              // Byte equality proves the entry is still the one classified,
              // without a second liveness probe (the contract probes once).
              if (fs.readFileSync(file, "utf8") !== text) continue;
              fs.rmSync(file, { force: true });
              continue;
            }
            throw new Error(`unsafe parallel experiment conflicts on ${target} (owned by ${classified.claim?.experimentId || "unknown"})`);
          }
        }
        });
        acquired.push({ target, file });
        this.targetOwners.set(target, record.id);
      }
    } catch (error) {
      for (const entry of acquired.reverse()) {
        // Roll back under the same target lock as acquisition: an unlocked
        // read-then-delete could remove a claim another process just installed.
        let released = false;
        try {
          this.withTargetClaimLock(this.paths.ownershipDir, entry.target, () => {
            let existing;
            try { existing = JSON.parse(fs.readFileSync(entry.file, "utf8")); }
            catch (cause) { if (cause?.code === "ENOENT") return; throw cause; }
            if (existing.experimentId === record.id) fs.rmSync(entry.file, { force: true });
          });
          released = true;
        } catch {}
        if (released) this.targetOwners.delete(entry.target);
      }
      throw error;
    }
    record.targetsAcquired = true;
  }

  releaseTargets(record) {
    let allReleased = true;
    for (const target of record.targets || []) {
      const file = path.join(this.paths.ownershipDir, `${sha256(target)}.json`);
      let fileOk = false;
      try {
        // The ownership check and deletion must be serialized with acquisition.
        // An unlocked read-then-delete could remove a claim another process
        // installed between the two steps.
        this.withTargetClaimLock(this.paths.ownershipDir, target, () => {
          let existing;
          try { existing = JSON.parse(fs.readFileSync(file, "utf8")); }
          catch (cause) { if (cause?.code === "ENOENT") return; throw cause; }
          if (existing.experimentId === record.id) fs.rmSync(file, { force: true });
        });
        fileOk = true;
      } catch (error) {
        // A lock-contention or read failure leaves targetsAcquired true, so the
        // owner can retry the cleanup instead of losing the claim silently.
        if (error?.code === "ENOENT") fileOk = true;
        else {
          this.warn(`[evolution] unable to release target ownership ${target}: ${safeErrorDto(error, "cleanup").errorSummary}`);
          fileOk = false;
        }
      }
      if (fileOk && this.targetOwners.get(target) === record.id) this.targetOwners.delete(target);
      if (!fileOk) allReleased = false;
    }
    if (allReleased) record.targetsAcquired = false;
  }

  claimOperation(record, operation) {
    const active = this.operationClaims.get(record.id);
    if (active) throw new Error(`experiment ${record.id} is busy with ${active}`);
    this.operationClaims.set(record.id, operation);
  }

  /**
   * One Trial at a time per process.
   *
   * Every Trial proves its cleanup against a baseline of the whole runtime, so
   * two live Trials in one process cannot both be reverted: each baseline
   * predates the other plugin, and the drift rule that protects a real
   * concurrent edit then reports both as unrecovered and keeps both target
   * claims. Refusing the second Trial is the smallest rule that keeps that state
   * unreachable; the caller is told exactly which experiment to close first.
   */
  assertRuntimeAvailable(record) {
    // A baseline probe is a measurement of the live runtime: while one is
    // executing, a Trial would mutate the very behaviour it is measuring. The
    // check covers both directions (trial during a probe here, and a probe
    // whose baseline another Trial already invalidated is caught at probe start).
    const ownOperation = this.operationClaims.get(record.id);
    if (ownOperation === "probe") {
      const error = new Error(`experiment ${record.id} is capturing probe evidence; wait for it to finish before starting a Trial`);
      error.code = RUNTIME_BUSY_CODE;
      throw error;
    }
    for (const [id, other] of this.experiments) {
      if (id === record.id) continue;
      if (this.operationClaims.get(id) === "probe") {
        const error = new Error(`experiment ${id} is capturing probe evidence; wait for it to finish before starting a Trial`);
        error.code = RUNTIME_BUSY_CODE;
        throw error;
      }
      if (!RUNTIME_OCCUPYING_STATES.has(other.state) && other.targetsAcquired !== true) continue;
      // A terminal record that still reports a target claim is a release that
      // was blocked by cross-process lock contention (PR #89 made release take
      // the same per-target lock as acquisition). The lock may have cleared
      // since, so retry here: one transient BUSY must not wedge every later
      // Trial for that target for the rest of the session. A live Trial never
      // reaches this - it is excluded by RUNTIME_OCCUPYING_STATES above.
      if (other.targetsAcquired === true && TERMINAL_EXPERIMENT_STATES.has(other.state)) {
        // The observer already retries this claim on a cooldown. A different
        // observation arriving inside that window must not bypass it here and
        // attempt the same cross-process lock again on every Trial check.
        const attempt = this.cleanupRecoveryAttempts.get(id);
        const coolingDown = attempt && Date.now() - attempt.at < this.cleanupRecoveryCooldownMs;
        if (!coolingDown) {
          this.releaseTargets(other);
          if (other.targetsAcquired !== true) continue;
        }
      }
      // The advice has to name a step this plugin can actually perform: while the
      // occupant's cleanup is unproven, `promote` refuses it (Promotion requires
      // Measure first) and only a retried `evolution_revert` can finish it.
      const next = RETRYABLE_CLEANUP_STATES.has(other.state)
        ? "its cleanup was not proven, so retry evolution_revert to finish disposing it"
        : "revert or promote it";
      const error = new Error(`another experiment occupies the runtime (${id}, ${other.state}); ${next} before starting a new Trial`);
      error.code = RUNTIME_BUSY_CODE;
      throw error;
    }
  }

  releaseOperation(record) { this.operationClaims.delete(record.id); }

  /**
   * Serialize canary observations per experiment through the same in-process
   * operation claims revert/promote use. The journal is a read-modify-replace
   * file, so two concurrent observations would both read the same barriers and
   * the last write would silently drop the first; the second caller gets an
   * explicit busy error instead.
   */
  async observeCanary(args, exec, transition = null) {
    const claim = { id: text(args?.experimentId, "experimentId") };
    this.claimOperation(claim, "canary");
    try {
      return await this.observeCanaryJournal(args, exec, transition);
    } finally {
      this.releaseOperation(claim);
    }
  }

  async observeCanaryJournal(args, exec, transition = null) {
    const startupTransition = transition === STARTUP_TRANSITION;
    const agent = ownerOf(exec);
    const experimentId = text(args?.experimentId, "experimentId");
    let record = this.experiments.get(experimentId);
    let journal = await readCanaryJournal(this.paths);
    if (journal && journal.experimentId !== experimentId) {
      // One promotion canary is live at a time: its journal is the only phase
      // authority, and it may not lend its owner to a different experiment.
      throw new Error(`promotion canary for ${journal.experimentId} is still pending; experiment ${experimentId} cannot be observed`);
    }
    // Resolve the strongest durable evidence snapshot available for this
    // experiment. We never want to start a cross-session canary observation
    // with empty observations / unknown recovery proof when at least one of
    // the following sources is on disk: (1) journal.evidenceSnapshot from
    // writeDurablePromotion, (2) the sidecar *.evidence.json next to the
    // archive, (3) the durable exp-*.md archive itself (parsed for the
    // most recent Observations / Runtime recovery sections), (4) the
    // append-only execution-event bridge (measurement / gates / canary for
    // older promotions whose journal and sidecar were never written).
    // The sources are merged monotonically (evidence can only stay or
    // upgrade), so an empty or degraded snapshot never wipes richer data.
    const durableSnapshot = mergeEvidenceSources([
      journal?.evidenceSnapshot || null,
      await readEvidenceSnapshot(this.paths.archiveDir, experimentId),
      await readArchiveMdEvidence(this.paths.archiveDir, experimentId),
      await readEventBridgeEvidence(this.paths.eventBridgePath, experimentId, { key: this.paths.eventBridgeKey, trustedWriters: [this.paths.eventBridgeWriter] }),
    ]);
    // The promotion owner is only ever read from durable state: the live
    // journal first, then the evidence sidecar / archive, then the in-memory
    // record this session created. A caller's own agent id is deliberately not
    // a fallback: that would let any session claim a promotion whose journal
    // was already cleaned up.
    const durableOwner = [journal?.ownerId, durableSnapshot?.ownerId, durableSnapshot?.proposal?.owner, record?.ownerId]
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .find((value) => value !== "") ?? null;
    if (!record && journal?.experimentId === experimentId) {
      // Hydrate from durable sources in priority order. We never start with
      // an empty observations array or `runtimeRecovered: true` when better
      // evidence exists. The snapshot lives on the journal at promotion time,
      // as a sidecar `*.evidence.json` next to the durable archive, and as a
      // parsed view of the `exp-*.md` archive itself when no machine-readable
      // snapshot survives.
      const hydrated = {
        id: journal.experimentId,
        ownerId: durableOwner,
        proposal: journal.proposal || { owner: durableOwner, why: "restored canary", target: "unknown", impactScope: [], successMetrics: [], createdAt: journal.canary?.promotionTimestamp },
        targets: journal.targets || [],
        state: "canary-observing",
        runtimeRecovered: durableSnapshot?.runtimeRecovered === true,
        durable: journal.durable,
        canary: journal.canary,
        observations: Array.isArray(durableSnapshot?.observations) ? durableSnapshot.observations : [],
        latestObservation: durableSnapshot?.latestObservation || null,
        cleanupProof: durableSnapshot?.cleanupProof || null,
        recoveryProof: durableSnapshot?.recoveryProof || null,
        lastGateEvidence: durableSnapshot?.gateEvidence || null,
      };
      // If the durable sidecar is missing for whatever reason, fall back to
      // the in-process in-memory record if it has better data than empty.
      record = hydrated;
      // Acquire the target claims before registering the recovered record. If
      // the shared lock is contended, this call fails without a cached record,
      // so the next observation retries the acquisition instead of advancing
      // the canary on a trial that owns no claim.
      this.acquireTargets(record);
      this.experiments.set(record.id, record);
    } else if (!record && durableSnapshot) {
      // Durable evidence outlives the journal by design: a stable commit keeps
      // the sidecar and the archive and removes the journal. That is a terminal
      // state, so it may not be reopened into canary-observing: the journal is
      // the only authority that can advance the canary state machine, and a
      // caller's own id is never the owner (AGENTS.md invariants 2 and 5/6).
      throw new Error(`experiment ${experimentId} has no live promotion journal; refusing to resume canary observation from durable evidence alone`);
    } else if (record && durableSnapshot) {
      // Record is already in memory but a richer durable snapshot exists.
      // Apply monotonic merge so we never downgrade evidence that was
      // captured in earlier sessions.
      hydrateRecordFromSnapshot(record, durableSnapshot);
    }
    if (!record) throw new Error(`experiment ${experimentId} is not known in this session`);
    if (durableOwner === null) throw new Error(`experiment ${record.id} has no durable owner; refusing to guess who may advance its canary`);
    if (record.ownerId && record.ownerId !== durableOwner) throw new Error(`experiment ${record.id} owner ${record.ownerId} disagrees with its durable owner ${durableOwner}`);
    record.ownerId = durableOwner;
    if (record.ownerId !== agent.id && !startupTransition) throw new Error(`experiment ${record.id} is owned by another Agent`);
    if (record.state !== "canary-observing") throw new Error(`experiment ${record.id} is ${record.state}; canary observation requires canary-observing state`);
    if (!journal) {
      // Missing journal is the same unknown state startup recovery refuses (see
      // promotionStateKnown): stop the state machine instead of synthesizing a
      // journal that would rewrite the durable record.
      throw new Error(`canary journal is missing for ${record.id}; refusing to advance the canary state machine from a durable snapshot alone`);
    }
    const barrier = args?.barrier;
    if (!barrier || barrier.reached !== true || typeof barrier.id !== "string" || barrier.id.trim() === "") {
      throw new Error("canary observation requires a deterministic reached barrier id");
    }
    const verification = journal.canary.verification || null;
    const evidence = compactValue(args.evidence || {});
    const functionalClaim = evidence.functionalCheck && typeof evidence.functionalCheck === "object" ? evidence.functionalCheck : null;
    // A startup health replay never carries a functional check. It can prove
    // the plugin loads, never that the context-policy candidate took effect.
    const verificationKind = args.verificationKind === "functional" && functionalClaim ? "functional" : "health";
    const observation = {
      at: now(),
      barrierId: barrier.id,
      startupVerified: args.startupVerified === true,
      componentHealth: args.componentHealth || "healthy",
      dependenciesPresent: args.dependenciesPresent !== false,
      metricRegression: args.metricRegression === true,
      metrics: compactValue(args.metrics || {}),
      evidence,
      verificationKind,
    };
    journal.canary.observations ||= [];
    if (!journal.canary.observations.some((entry) => entry.barrierId === observation.barrierId)) journal.canary.observations.push(observation);
    journal.canary.startupVerified ||= observation.startupVerified;
    record.canary = structuredClone(journal.canary);
    // A claimed but mismatched/failed functional check is itself a canary
    // regression: the candidate was exercised and did not take effect.
    const functionalRegression = functionalClaim !== null && (functionalClaim.matched !== true
      || (verification !== null && functionalClaim.bindingDigest !== verification.bindingDigest));
    const regression = observation.metricRegression
      || functionalRegression
      || observation.dependenciesPresent === false
      || !["healthy", "active", "ok"].includes(String(observation.componentHealth).toLowerCase())
      || args.startupVerified === false;
    if (regression) {
      if (this.paths.promotionRuntime && !journal.records?.length) throw new Error("Cannot roll back promotion without its authoritative journal change plan");
      await rollbackPromotionJournal(journal, this.paths);
      record.state = "rolled-back";
      // The canary is the last production barrier: a regression here is the
      // strongest Compose evidence the experiment can produce, and it is
      // recorded before the archive renders it.
      record.decision = {
        version: 1,
        kind: "regression",
        source: "canary",
        at: now(),
        observationAt: observation.at,
        eligible: false,
        reasons: [observation.metricRegression
          ? "canary observed a metric regression"
          : "canary observed a startup, component, or dependency regression"],
        gates: record.decision?.gates ?? null,
        probe: record.decision?.probe ?? null,
      };
      record.failure = safeFailureLearning({
        record,
        phase: "canary",
        error: new Error(observation.metricRegression ? "metric regression" : "startup/component/dependency canary regression"),
        rollbackResult: { ok: true, status: "rolled-back-to-last-known-good" },
        nextPreventionHint: "保留 canary 失败签名；重新验证 startup、component health、dependency 与 metric 后再提出新实验。",
      });
      try {
        await this.archive(record, "canary-regression");
        this.publishConclusion(record, "regression", "canary");
        this.emitEventSafely(record, "canary-failed", { status: record.state, canary: observation });
        this.emitEventSafely(record, "promotion-reverted", { status: record.state, canary: observation });
        this.emitEventSafely(record, "failure-learned", { status: record.state });
      } finally {
        // The rollback already happened: its targets are no longer owned even
        // when the archive or an event write fails.
        this.releaseTargets(record);
      }
      return { ok: false, experimentId: record.id, phase: record.state, rollback: "last-known-good", observation, decision: record.decision };
    }
    // The window is a count of observations of ANY kind, but an experiment that
    // declared a functional obligation also needs that many MATCHING functional
    // observations. Health-only observations (notably the startup replay) can
    // never satisfy the obligation, even if they fill the numeric window.
    const functionalObservations = journal.canary.observations.filter((entry) => entry.verificationKind === "functional"
      && entry.evidence?.functionalCheck?.matched === true
      && (!verification || entry.evidence.functionalCheck.bindingDigest === verification.bindingDigest)).length;
    const requiredFunctional = verification?.requiredObservations ?? 0;
    const complete = journal.canary.startupVerified === true
      && journal.canary.observations.length >= journal.canary.healthObservationWindow
      && functionalObservations >= requiredFunctional;
    if (!complete) {
      await writeJournal(path.join(journal.stateDir, "journal.json"), journal);
      return { ok: true, experimentId: record.id, phase: "canary-observing", stable: false,
        remaining: Math.max(0, journal.canary.healthObservationWindow - journal.canary.observations.length),
        remainingFunctional: Math.max(0, requiredFunctional - functionalObservations),
        canary: structuredClone(journal.canary) };
    }
    journal.phase = "stable-committed";
    journal.stableCommittedAt = now();
    await writeJournal(path.join(journal.stateDir, "journal.json"), journal);
    // Hydrate record from durable sources BEFORE journal deletion: the
    // sidecar and the archive itself persist on disk, but in-memory
    // `record.observations` would otherwise be empty on a cross-session
    // canary. Hydrating here is monotonic: durable evidence always wins
    // over missing/unknown values in the rebuilt record. We use the same
    // three-tier chain as the top of observeCanary so that archive()
    // below sees the richest possible evidence regardless of which
    // durable sources survived.
    const stableDurableSnapshot = journal.evidenceSnapshot
      || await readEvidenceSnapshot(this.paths.archiveDir, record.id)
      || await readArchiveMdEvidence(this.paths.archiveDir, record.id);
    if (stableDurableSnapshot) {
      hydrateRecordFromSnapshot(record, stableDurableSnapshot);
    }
    // Update the sidecar with the final recovery proof so the stable-commit
    // archive is a true monotonic merge rather than a downgrade. The new
    // sidecar carries the in-memory record's evidence (which may be
    // upgraded by the just-completed canary window) on top of the durable
    // floor from `stableDurableSnapshot`.
    // The stable commit adopts the candidate. It is written into the final
    // sidecar before the journal disappears so a restart can still tell the
    // difference between "adopted" and "no measurement".
    record.decision = {
      version: 1,
      kind: "benefit",
      source: "canary-passed",
      at: now(),
      observationAt: record.latestObservation?.at ?? null,
      eligible: true,
      reasons: ["the measured candidate passed the startup, health, dependency, and metric canary window"],
      gates: record.decision?.gates ?? null,
      probe: record.decision?.probe ?? null,
    };
    this.reusePublicationIdentity(record);
    const stablePublication = normalizePublication(record?.durable?.publication ?? record?.publication);
    const finalSnapshot = {
      ...(stableDurableSnapshot || {}),
      version: 1,
      source: (stableDurableSnapshot?.source || "stable-commit") + "+stable-commit",
      capturedAt: now(),
      latestObservation: record.latestObservation || stableDurableSnapshot?.latestObservation || null,
      observations: record.observations?.length ? record.observations : (stableDurableSnapshot?.observations || []),
      cleanupProof: safeProofForPersistence(preferObject(stableDurableSnapshot?.cleanupProof, record.cleanupProof)),
      recoveryProof: safeProofForPersistence(preferObject(stableDurableSnapshot?.recoveryProof, record.recoveryProof)),
      runtimeRecovered: record.runtimeRecovered === true || stableDurableSnapshot?.runtimeRecovered === true,
      stableCommittedAt: journal.stableCommittedAt,
      gateEvidence: record.lastGateEvidence || stableDurableSnapshot?.gateEvidence || null,
      // Stable-commit must not drop promotion identity / lineage that
      // the pre-fix code path did not persist. Carry forward whatever
      // the durable sources and the hydrated record hold.
      durable: record.durable || stableDurableSnapshot?.durable || null,
      canary: record.canary || stableDurableSnapshot?.canary || null,
      ownerId: durableOwner,
      proposal: record.proposal || stableDurableSnapshot?.proposal || null,
      // The approved deployment scope is part of the stable fact: persist it in
      // the final sidecar so a restart can publish (or reconcile) exactly what
      // the owner approved, never a broader scope.
      ...(Array.isArray(record.shareTargets) && record.shareTargets.length > 0 ? { shareTargets: [...record.shareTargets] } : {}),
      ...(stablePublication ? { publication: stablePublication } : {}),
      decision: record.decision,
    };
    await persistEvidenceSnapshot(this.paths.archiveDir, record.id, finalSnapshot);
    await fsp.rm(journal.stateDir, { recursive: true, force: true });
    record.state = "stable";
    record.stableCommittedAt = journal.stableCommittedAt;
    // Refresh the in-memory record from the sidecar we just wrote so
    // archive() below cannot accidentally use a record field that is
    // older than the just-persisted finalSnapshot.
    const postWriteSidecar = await readEvidenceSnapshot(this.paths.archiveDir, record.id);
    if (postWriteSidecar) hydrateRecordFromSnapshot(record, postWriteSidecar);
    try {
      await this.archive(record, "stable-commit");
      this.publishConclusion(record, "adopted", "canary-passed");
      this.emitEventSafely(record, "canary-passed", {
        status: record.state,
        canary: journal.canary,
        promotion: record.durable,
        evidence: { stableCommittedAt: record.stableCommittedAt },
      });
    } finally {
      // The stable commit is durable and its journal is gone: this experiment no
      // longer owns the target, even if the archive or the event write failed.
      this.releaseTargets(record);
    }
    // Only a stable commit may export the plugin to the other entries. The
    // publication is additive: a failure here never changes the promotion
    // outcome, and startup reconciliation republishes from the same durable
    // stable evidence.
    const shared = await this.publishCrossEntryPlugin(record, journal);
    return { ok: true, experimentId: record.id, phase: record.state, stable: true, stableCommittedAt: record.stableCommittedAt, canary: structuredClone(journal.canary), decision: record.decision, shared };
  }

  async verifyStartupCanary(agent) {
    const journal = await readCanaryJournal(this.paths);
    if (!journal) return { status: "none" };
    let verified = false;
    let health = "missing";
    let dependenciesPresent = false;
    try {
      await verifyDurablePromotion({
        pluginName: journal.durable.pluginName,
        pluginPath: journal.durable.pluginPath,
        compositionPath: this.paths.compositionPath,
        rowId: journal.durable.rowId,
        promotionRuntime: this.paths.promotionRuntime,
      });
      const actual = await this.paths.promotionRuntime.health(journal.durable.rowId, pathToFileURL(path.join(journal.durable.pluginPath, "lib", "index.js")).href);
      health = actual.componentHealth;
      dependenciesPresent = actual.dependenciesPresent;
      verified = health === "active" && dependenciesPresent;
    } catch {
      verified = false;
    }
    return this.observeCanary({
      experimentId: journal.experimentId,
      startupVerified: verified,
      componentHealth: health,
      dependenciesPresent,
      metricRegression: false,
      barrier: { id: `startup:${agent.id}`, reached: true },
      evidence: { source: "new-session-startup" },
    }, { agent, signal: new AbortController().signal }, STARTUP_TRANSITION);
  }

  patternKey(input = {}) {
    return sha256(stableJson({
      type: input.type || "runtime/error",
      code: input.code || input.errorCode || input.error?.code || "unknown",
      target: input.target || input.component || input.plugin || "runtime",
      message: safeString(input.message || input.error?.message || "").toLowerCase().replace(/\b\d+\b/g, "#"),
      // Distinct errors that share a redacted summary stay distinct patterns.
      // The message above already collapses every digit, so the digest is the
      // only component that can tell `after 100 ms` from `after 200 ms` apart;
      // `errorPatternDigest` is that same digest with only the labelled duration
      // normalized. Without it, the identity is exactly what the base assigns.
      digest: input.errorPatternDigest ?? input.errorDigest ?? safeErrorDto(input.message ?? input.error ?? "", "observation").errorDigest,
    }));
  }

  /**
   * The identity of one autonomous hypothesis: what the experiment would do, not
   * which pattern it was derived from.
   *
   * Both suppressions (in-session and durable) and the "already measured, waiting
   * for its owner" check are keyed by it. Without it the key was the pattern
   * alone, so an owner who replaced the failing declaration with a different one
   * (another target, another composition, another risk) was suppressed forever:
   * the recorded failure kept matching, although the `prevention` text written
   * beside it promises "until a new strategy ... is supplied". Conversely the same
   * declaration stays suppressed across restarts, which is what keeps the loop
   * from re-running a proven failure.
   *
   * `measure` and `observation` are deliberately excluded. They are host-side
   * callbacks, not durable evidence: they cannot be read back, so they cannot
   * identify a hypothesis that outlives the process, and hashing a function's
   * source would make the identity depend on formatting. A different measurement
   * callback alone therefore does not create a new hypothesis - changing the
   * declaration does.
   */
  strategyFingerprint(strategy) {
    try {
      const composition = isObject(strategy?.composition) ? strategy.composition : null;
      const code = isObject(composition?.code) ? composition.code : null;
      // `propose()` reads `impactScope` through `scopeList()`, which accepts the
      // bare string form. Reading only arrays here collapsed every string-form
      // declaration to `null`, so changing only the declared scope kept the old
      // identity (and stayed suppressed, and kept answering for the old target)
      // exactly the way `targets` did before its reader was fixed. The array form
      // is read as before, so an existing identity does not move.
      const list = (value) => {
        if (Array.isArray(value)) return value.map((entry) => safeString(entry));
        if (typeof value === "string" && value.trim() !== "") return [value.trim()];
        return null;
      };
      // `targets` is the object form `normalizeTargets()` reads
      // (`{ components, plugins, configurations }`), not a string array. Treating
      // it as one collapsed every declaration to `null`, so changing only the
      // declared targets kept the old failure's identity and stayed suppressed
      // forever - and kept reporting a measured candidate for the old target.
      // The shape below is the same kind list and sort order that function uses,
      // written totally here so an unreadable declaration cannot throw.
      const targets = (value) => {
        if (!isObject(value)) return null;
        // `Object.fromEntries`, like the rest of this file: a key that arrives as
        // `__proto__` must become an own property instead of reaching a setter.
        const declared = [];
        for (const kind of ["components", "plugins", "configurations"]) {
          const raw = value[kind];
          if (raw === undefined || raw === null || raw === "") continue;
          const entries = (Array.isArray(raw) ? raw : [raw]).map((entry) => safeString(entry)).sort();
          if (entries.length > 0) declared.push([kind, entries]);
        }
        return declared.length > 0 ? Object.fromEntries(declared) : null;
      };
      return sha256(stableJson({
        target: safeString(strategy?.target ?? ""),
        targets: targets(strategy?.targets),
        idPrefix: safeString(strategy?.idPrefix ?? ""),
        risk: safeString(strategy?.risk ?? ""),
        impactScope: list(strategy?.impactScope),
        successMetrics: list(strategy?.successMetrics),
        composition: composition ? {
          name: safeString(composition.name ?? ""),
          purpose: safeString(composition.purpose ?? ""),
          // The code decides what actually runs, so it is part of the identity.
          // It is hashed rather than stored: a long Host body must not be copied
          // into the candidate DTO, the failure memory or the observation stream.
          host: typeof code?.host === "string" ? sha256(code.host) : null,
          client: typeof code?.client === "string" ? sha256(code.client) : null,
        } : null,
      }));
    } catch {
      // A declaration that cannot be read cannot be compared either. One shared
      // identity keeps the observer total instead of throwing out of a path that
      // is only allowed to report.
      return sha256("strategy-unreadable");
    }
  }

  /**
   * Release a decision reservation that this process inherited and cannot resolve.
   *
   * `reserveAutonomousDecision` is taken before a Trial touches the runner and
   * released by every outcome the session can still prove: a proven revert, or a
   * transient failure whose proposal was discarded. Nothing releases it when the
   * process ends first - a crash, or a plain shutdown while a `measured` candidate
   * still waits for its owner - and the durable reservation then outlives both the
   * Trial and the record it described. Every later session answered that
   * hypothesis with `prior-decision-requires-owner`, i.e. it pointed at a decision
   * nobody could make: the Trial it named did not survive the process, so it
   * cannot be promoted, and there is no record left to revert. That retired one
   * hypothesis per interrupted decision, which is the same failure mode the
   * cleanup retry prevents for a failure that is still observable.
   *
   * The release is confined to reservations this process inherited
   * (`autonomousDecisions()` is the state at open), so a decision this session
   * took is never released, and it is skipped entirely while any record here
   * answers for the identity - a `measured` candidate waiting for its owner, a
   * Trial the host has not approved yet, or an unproven cleanup - because those
   * are live decisions the owner can still act on. Promotion authority is
   * untouched: an autonomous decision never promotes, `promote` needs a live
   * in-process record (`requireOwned`), and this release cannot create, approve
   * or revert one. What it can cost is at most one extra isolated Trial for a
   * hypothesis whose earlier Trial is gone, and that Trial again stops at owner
   * confirmation.
   */
  async releaseInheritedAutonomousDecision(identity) {
    const port = this.domainStorage;
    if (typeof port?.autonomousDecisions !== "function" || typeof port?.releaseAutonomousDecision !== "function") return null;
    for (const record of this.experiments.values()) {
      const marker = record.autonomous;
      if (!isObject(marker) || `${marker.patternKey}:${marker.strategyFingerprint}` !== identity) continue;
      // Only a live decision (one still awaiting its owner, occupying the
      // runtime, or carrying an unproven cleanup) may block the release of an
      // inherited reservation. Terminal records (reverted/stable/rejected/...)
      // no longer represent a decision and must not leak the reservation.
      if (record.targetsAcquired === true || this.operationClaims.has(record.id)) return null;
      if (record.state === "measured" || RETRYABLE_CLEANUP_STATES.has(record.state)) return null;
    }
    const inherited = await port.autonomousDecisions();
    if (!Array.isArray(inherited) || !inherited.includes(identity)) return null;
    await port.releaseAutonomousDecision(identity);
    this.warn(`[evolution] released an autonomous decision this process inherited and can no longer resolve (${identity.slice(0, 12)}...); the hypothesis is eligible for a new isolated Trial`);
    return { reason: "previous-session-decision" };
  }

  /**
   * The experiment this hypothesis already produced that is still waiting for its
   * owner, if there is one.
   *
   * The observer leaves an eligible trial mounted in `measured` state and returns
   * "awaiting confirmation". A later observation of the same error used to start
   * a second experiment, which could not claim the same target and threw
   * `unsafe parallel experiment conflicts` - recorded as a trial failure, i.e. the
   * strategy that had just passed every gate was suppressed by its own success.
   * Only `measured` with eligible evidence counts: promotion, revert or a rejected
   * gate moves the record off that state, and a new attempt is then legitimate.
   */
  pendingAutonomousCandidate(patternKey, strategyFingerprint) {
    let pending = null;
    for (const record of this.experiments.values()) {
      const marker = record.autonomous;
      if (!isObject(marker) || marker.patternKey !== patternKey) continue;
      if (marker.strategyFingerprint !== strategyFingerprint) continue;
      pending = record;
    }
    if (!pending || pending.state !== "measured") return null;
    const gates = promotionGates(pending, { requireRuntimeRecovery: false });
    return gates.eligible ? { record: pending, gates } : null;
  }

  /**
   * Leave no trial behind when the autonomous path throws after it mutated the
   * runtime. A `measure` or gate error used to keep the trial mounted and its
   * target claimed for the rest of the session (and in `ownership/` until the
   * process died), while the failure memory said the strategy was done. The
   * cleanup reuses `revert`, which proves runtime recovery and keeps the target
   * lock when it cannot (AGENTS.md invariant 3); its own failure is reported as
   * evidence, never thrown over the reason the experiment failed.
   */
  async cleanupAutonomousTrial(experimentId, exec) {
    const record = this.experiments.get(experimentId);
    if (!record) return { status: "not-run" };
    // Nothing was mutated yet: the autonomous caller created this proposal and
    // the Trial never reached `acquireTargets` (a target conflict, an unready
    // runtime, a declaration that cannot be defined). Leaving the record behind
    // would keep one unreachable proposal per deferred attempt, so it is
    // discarded here - only the autonomous path may do that, because an explicit
    // caller still owns its proposal and can fix it and retry.
    if (record.state === "proposed") {
      // A proposed record should not own a target claim, but if an exception
      // left one attached, dropping the record would strand it. Release it
      // before discarding so the runtime is not permanently occupied.
      if (record.targetsAcquired === true) {
        this.releaseTargets(record);
        // If the release could not be proven, keep the record (and its target
        // list) as the recovery basis instead of discarding it: otherwise the
        // claim is stranded with no record left to release it later.
        if (record.targetsAcquired === true) {
          return { status: "not-recovered", phase: record.state };
        }
      }
      this.operationClaims.delete(record.id);
      this.experiments.delete(record.id);
      return { status: "discarded", phase: record.state };
    }
    // A gate rejection reverts the trial itself before it throws, so the record
    // already carries the outcome: report that outcome instead of reverting a
    // second time (which `revert` would refuse anyway).
    if (record.state === "reverted") {
      // `revert` proved runtime recovery but its post-cleanup bookkeeping may
      // have failed to release the target claim (for example a cross-process
      // append-lock race). The runtime is recovered, but reporting `recovered`
      // while the claim is still held would skip the release retry below and
      // strand the target for the rest of this process.
      if (record.targetsAcquired === true) {
        this.releaseTargets(record);
        if (record.targetsAcquired === true) return { status: "not-recovered", phase: record.state };
      }
      return { status: "recovered", phase: record.state };
    }
    // An unproven cleanup is retried through `revert` rather than reported as
    // final: returning `not-recovered` here left the runtime occupied by a record
    // the observer itself had failed to dispose, which refuses every later
    // autonomous Trial for the rest of the session.
    if (!REVERTABLE_STATES.has(record.state)) {
      // A terminal (or otherwise non-revertable) record may still carry a target
      // claim that a previous release failed to remove. Retry the release so the
      // claim is not stranded; do not revert, since the Trial is already gone.
      if (record.targetsAcquired === true) {
        this.releaseTargets(record);
        if (!record.targetsAcquired) return { status: "recovered", phase: record.state };
        return { status: "not-recovered", phase: record.state };
      }
      return { status: "not-required", phase: record.state };
    }
    try {
      const reverted = await this.revert({ experimentId }, exec);
      if (reverted.runtimeRecovered === true && record.targetsAcquired === true) {
        // A retry can prove runtime recovery while its post-cleanup claim
        // release still loses a cross-process lock race. Re-check the claim so
        // that case is retried instead of being reported as fully recovered.
        this.releaseTargets(record);
        if (record.targetsAcquired === true) return { status: "not-recovered", phase: reverted.phase };
      }
      return { status: reverted.runtimeRecovered === true ? "recovered" : "not-recovered", phase: reverted.phase };
    } catch (error) {
      const detail = safeErrorDto(error, "cleanup");
      return { status: "failed", errorCategory: detail.errorCategory, errorDigest: detail.errorDigest, errorSummary: detail.errorSummary };
    }
  }

  /**
   * The autonomous record whose unproven cleanup still occupies the runtime while
   * this session may still retry that cleanup, if there is one.
   *
   * Only a record the observer itself created (the `autonomous` marker) qualifies:
   * an explicit caller still owns its experiment, so the observer may not dispose of
   * it on that owner's behalf.
   */
  autonomousCleanupOccupant() {
    for (const record of this.experiments.values()) {
      if (!isObject(record.autonomous)) continue;
      // Live trials own their targets legitimately; they are not stranded claims.
      if (RUNTIME_OCCUPYING_STATES.has(record.state)) continue;
      // Any autonomous record that still carries a target claim is an occupant
      // whose claim must be retried rather than stranded (proposed exception,
      // terminal release failure, or unproven cleanup).
      if (record.targetsAcquired === true) return record;
      if (!RETRYABLE_CLEANUP_STATES.has(record.state)) continue;
      if (record.targetsAcquired !== true) continue;
      return record;
    }
    return null;
  }

  /**
   * Retry the cleanup of an autonomous Trial the observer could not dispose of, so a
   * temporary disposer failure cannot end the evolution loop.
   *
   * `cleanupAutonomousTrial` fails toward the safe side: `revert` keeps the record,
   * its target claim and its captured baseline when recovery is not proven, and such
   * a record then refuses every later Trial with `E_EVOLUTION_RUNTIME_BUSY`. Nothing
   * retried it either: the observer returned "deferred", spent its one attempt for
   * the hypothesis it was answering for, and the manual `evolution_revert` was the
   * only exit - so one transient stop/undefine failure ended the evolution loop.
   * The retry here is that same cleanup, not a weaker one (same official disposers,
   * same single baseline captured before the first mutation, claim released only on
   * proof), spaced by `cleanupRecoveryCooldownMs` so a persistent failure is not
   * retried once per error event.
   */
  async recoverAutonomousOccupancy(exec) {
    // Drop bookkeeping for records this process no longer holds in a retryable state
    // (an owner finished the cleanup through `evolution_revert`, or the record was
    // pruned after its claim was released).
    //
    // A record whose retry is *in flight* answers `reverting` on the way to
    // `revert-failed` / `reverted`, and that is not a retryable cleanup state. It has
    // to keep its timestamp: a concurrent observation of another pattern reaching
    // this method while the disposers are running would otherwise drop it, and the
    // next observation after a failed retry would run the disposers again
    // immediately - the cooldown would hold only for the failures nobody observed
    // concurrently.
    for (const id of [...this.cleanupRecoveryAttempts.keys()]) {
      const record = this.experiments.get(id);
      const state = record?.state;
      if (state === "reverting" || RETRYABLE_CLEANUP_STATES.has(state)) continue;
      // Any terminal autonomous record can still hold a target claim whose
      // release lost a cross-process lock race. That release is retried here,
      // so its cooldown must survive between observations.
      if (TERMINAL_EXPERIMENT_STATES.has(state) && record.targetsAcquired === true) continue;
      this.cleanupRecoveryAttempts.delete(id);
    }
    const occupant = this.autonomousCleanupOccupant();
    if (!occupant) return { status: "not-required" };
    const residualClaim = TERMINAL_EXPERIMENT_STATES.has(occupant.state) && occupant.targetsAcquired === true;
    const nextAdvice = residualClaim
      ? "a later observation retries the remaining target claim release; evolution_revert cannot act on an already reverted record"
      : "retry evolution_revert to finish disposing it";
    const previous = this.cleanupRecoveryAttempts.get(occupant.id) ?? null;
    const attempts = previous?.attempts ?? 0;
    if (previous && Date.now() - previous.at < this.cleanupRecoveryCooldownMs) {
      // Reported, not retried: the record still owns the runtime, and its cleanup
      // has to wait for the cooldown to pass. Nothing was released.
      return {
        status: "cooling-down",
        experimentId: occupant.id,
        phase: occupant.state,
        attempts,
        next: nextAdvice,
      };
    }
    this.cleanupRecoveryAttempts.set(occupant.id, { attempts: attempts + 1, at: Date.now() });
    const cleanup = await this.cleanupAutonomousTrial(occupant.id, exec);
    const claimHeldAfter = this.experiments.get(occupant.id)?.targetsAcquired === true;
    if (!claimHeldAfter && (cleanup.status === "recovered" || !RETRYABLE_CLEANUP_STATES.has(occupant.state))) {
      this.cleanupRecoveryAttempts.delete(occupant.id);
    }
    if (cleanup.status === "recovered" && !claimHeldAfter) {
      return { status: "recovered", experimentId: occupant.id, attempts: attempts + 1, cleanup };
    }
    // A retry that could not prove recovery released nothing, so the honest advice
    // is the one `assertRuntimeAvailable` already gives: the manual revert is the
    // remaining exit, and a later observation retries after the cooldown.
    return {
      status: "unproven",
      experimentId: occupant.id,
      phase: occupant.state,
      attempts: attempts + 1,
      cleanup,
      next: claimHeldAfter && TERMINAL_EXPERIMENT_STATES.has(occupant.state)
        ? "a later observation retries the remaining target claim release; evolution_revert cannot release a claim on a terminal record"
        : nextAdvice,
    };
  }

  /** Keep the per-pattern observation windows, candidate views, session
   *  suppression keys, environment deferrals and terminal records bounded. */
  pruneAutonomousPatterns() {
    while (this.patterns.size > AUTONOMOUS_PATTERN_CAP) {
      const oldest = this.patterns.keys().next().value;
      this.patterns.delete(oldest);
      this.candidates.delete(oldest);
    }
    while (this.candidates.size > AUTONOMOUS_PATTERN_CAP) {
      this.candidates.delete(this.candidates.keys().next().value);
    }
    while (this.pendingDecisionReleases.size > AUTONOMOUS_PATTERN_CAP) {
      this.pendingDecisionReleases.delete(this.pendingDecisionReleases.values().next().value);
    }
    while (this.autonomousPlanning.size > AUTONOMOUS_PATTERN_CAP) {
      this.autonomousPlanning.delete(this.autonomousPlanning.values().next().value);
    }
    // Session suppression is a cache of "do not retry this hypothesis in this
    // process", not evidence: the durable half lives in the failure memory under
    // the same identity and is checked after this set. Dropping the oldest key
    // therefore costs at most one extra attempt in a very long session, where
    // keeping it cost memory that never came back.
    while (this.suppressedPatterns.size > AUTONOMOUS_PATTERN_CAP) {
      this.suppressedPatterns.delete(this.suppressedPatterns.values().next().value);
    }
    // Deferrals are the same kind of session bookkeeping: dropping the oldest key
    // costs at most one extra attempt of a hypothesis nothing observed for the
    // length of the whole window, and keeping it would cost memory that never came
    // back.
    while (this.deferredPatterns.size > AUTONOMOUS_PATTERN_CAP) {
      this.deferredPatterns.delete(this.deferredPatterns.keys().next().value);
    }
    this.pruneTerminalExperiments();
  }

  /**
   * Record that one hypothesis is answered for this session and trim the caches
   * immediately: the cap has to hold at every return, not only after the next
   * observation.
   */
  suppressForSession(identity) {
    // A recorded verdict supersedes a deferral: both answer the same identity, and
    // the durable failure is the authoritative one.
    this.deferredPatterns.delete(identity);
    this.suppressedPatterns.delete(identity);
    this.suppressedPatterns.add(identity);
    this.pruneAutonomousPatterns();
  }

  /**
   * Record that this hypothesis's attempt met an environment failure, so a later
   * observation may attempt it again once the conflict is gone.
   *
   * Deliberately not `suppressForSession`: that holds a verdict about the
   * declaration and lasts until the process exits. A transient failure says nothing
   * about the declaration, and the condition it reports can disappear while this
   * process is running - one `E_EVOLUTION_RUNTIME_BUSY` while another experiment was
   * measured permanently retired a valid hypothesis, even after its owner reverted
   * the occupant. The entry is a timestamp plus an attempt count: `observeAutonomous`
   * reports the remaining wait instead of a duplicate failure, and attempts the
   * hypothesis again after `transientRetryCooldownMs`. Nothing about the resource
   * gates changes - a retry still has to pass `assertRuntimeAvailable`, the target
   * claims, the pending-candidate check and the cleanup retry.
   */
  deferForSession(identity) {
    const previous = this.deferredPatterns.get(identity) ?? null;
    this.deferredPatterns.delete(identity);
    const entry = { attempts: (previous?.attempts ?? 0) + 1, at: Date.now() };
    this.deferredPatterns.set(identity, entry);
    this.pruneAutonomousPatterns();
    return entry;
  }

  /**
   * Drop the oldest terminal experiment records past the same cap.
   *
   * A record that still owns a target claim, or that an operation is running on,
   * is never dropped: `releaseTargets` is the only way its claim is released and
   * it cannot run without the record. What is dropped is history that the
   * archive, the evidence sidecar and the failure memory already hold.
   */
  /**
   * Bound explicit proposals as well as terminal records. Every proposal keeps
   * a full `inspect()` baseline, so an unattended caller of `evolution_propose`
   * can otherwise grow the process without limit even though no Trial ever
   * starts. An autonomous proposal is never dropped here: its record carries a
   * reserved decision placeholder whose release is tied to that record, and
   * dropping it would wedge the hypothesis until the next process start.
   */
  pruneProposedExperiments() {
    let count = 0;
    for (const record of this.experiments.values()) {
      if (record.state === "proposed" && record.proposalSource !== 'autonomous') count += 1;
    }
    if (count <= AUTONOMOUS_PATTERN_CAP) return;
    for (const [id, record] of this.experiments) {
      if (count <= AUTONOMOUS_PATTERN_CAP) return;
      if (record.state !== "proposed" || record.proposalSource === 'autonomous' || isObject(record.autonomous)) continue;
      if (record.targetsAcquired === true || this.operationClaims.has(id)) continue;
      this.experiments.delete(id);
      count -= 1;
    }
  }

  pruneTerminalExperiments() {
    if (this.experiments.size <= AUTONOMOUS_PATTERN_CAP) return;
    for (const [id, record] of this.experiments) {
      if (this.experiments.size <= AUTONOMOUS_PATTERN_CAP) return;
      if (!TERMINAL_EXPERIMENT_STATES.has(record.state)) continue;
      if (record.targetsAcquired === true || this.operationClaims.has(id)) continue;
      this.experiments.delete(id);
    }
  }

  async observeAutonomous(input = {}, exec) {
    const agent = ownerOf(exec);
    const patternKey = this.patternKey(input);
    // Everything this method stores or records reads the safe input: the
    // observation stream (and therefore inspect), the failure memory and the
    // proposal text never see the raw provider message.
    const safeInput = safeObservationInput(input);
    const observation = { observationId: `obs-${crypto.randomUUID()}`, at: now(), patternKey, input: compactValue(safeInput) };
    let observations;
    if (this.domainStorage) {
      // Commit before counting or deciding. A failed write must never produce
      // an experiment based on evidence that the next session cannot recover.
      await this.domainStorage.observe({ ...safeInput, observationId: observation.observationId,
        patternKey: `autonomous-v1:${patternKey}` });
      // Read the session half *after* the commit, never before it. Two of these
      // calls really do overlap - `agent/error` and `tools/result` are independent
      // observers, and nothing serializes them - so an occurrence committed while
      // this call was waiting for its own write has already updated the window in
      // between. A snapshot taken before the await misses exactly those, and the
      // count then came out one short for a hypothesis that did reach its
      // threshold (reported as `pattern-observing` although every occurrence was
      // recorded). Reading it here needs no lock: the window is written before
      // this call resumes and both halves are deduplicated by `observationId`.
      const remembered = this.patterns.get(patternKey) || [];
      if (this.domainStorage.autonomousObservations) {
        // Union, not replacement: see `mergePatternEvidence`. The current row is
        // already committed, so it normally arrives in the durable half; it is
        // named here as well because a port that answers a stale tail must not
        // drop the occurrence this call is about.
        observations = mergePatternEvidence(
          this.domainStorage.autonomousObservations().filter(row => row.patternKey === patternKey),
          remembered,
          [{ observationId: observation.observationId, at: observation.at, patternKey }],
        );
      } else {
        observations = mergePatternEvidence(remembered, [observation]);
      }
    } else {
      // The session's own half of this pattern's window. In the durable branch it
      // holds the durable row shape, so the union stays homogeneous whatever the
      // store happens to retain; here it holds the observation rows themselves.
      observations = mergePatternEvidence(this.patterns.get(patternKey) || [], [observation]);
    }
    this.observations.push(observation);
    if (this.observations.length > 200) this.observations.splice(0, this.observations.length - 200);
    this.patterns.delete(patternKey);
    this.patterns.set(patternKey, observations.slice(-this.patternThreshold));
    this.pruneAutonomousPatterns();
    const strategy = this.strategies[patternKey] || this.strategies[input.code] || this.strategies[input.errorCode];
    if (observations.length < this.patternThreshold) return { phase: "pattern-observing", patternKey, occurrences: observations.length };
    const strategyFingerprint = strategy ? this.strategyFingerprint(strategy) : null;
    const identity = `${patternKey}:${strategyFingerprint ?? "no-strategy"}`;
    const risk = safeString(strategy?.risk || input.risk || "high").toLowerCase();
    const candidate = {
      candidateId: `candidate-${patternKey.slice(0, 12)}`,
      patternKey,
      risk,
      strategyFingerprint,
      observationIds: observations.map((entry) => entry.observationId),
      strategy: strategy ? { target: strategy.target, idPrefix: strategy.idPrefix } : null,
      createdAt: now(),
    };
    this.candidates.delete(patternKey);
    this.candidates.set(patternKey, candidate);
    this.pruneAutonomousPatterns();
    if (!strategy) return { phase: "candidate", patternKey, candidate, automatic: false, reason: "no-approved-strategy" };
    if (risk === "high" || this.autonomousPolicy.high === "deny" && risk === "high") {
      return { phase: "blocked-high-risk", patternKey, strategyFingerprint, candidate, automatic: false };
    }
    if (risk === "medium" || this.autonomousPolicy[risk] === "confirm") {
      return { phase: "candidate-awaiting-confirmation", patternKey, strategyFingerprint, candidate, automatic: false, reason: "confirmation-required" };
    }
    if (risk !== "low" || this.autonomousPolicy.low !== "experiment") {
      return { phase: "candidate", patternKey, strategyFingerprint, candidate, automatic: false, reason: "policy-blocked" };
    }
    // Synchronous guard: two concurrent observations of the same hypothesis must
    // not both proceed past this point. The durable `observing` set is only
    // registered later (after awaits), so it cannot serialize them on its own.
    if (this.autonomousPlanning.has(identity)) {
      return { phase: "observing", patternKey, strategyFingerprint, candidate, automatic: false, reason: "observation-in-flight" };
    }
    this.autonomousPlanning.add(identity);
    // A cleanup this session could not prove still owns the runtime, and every
    // later Trial is refused with `E_EVOLUTION_RUNTIME_BUSY` until it is disposed
    // of. Retry that same cleanup once per observation before deciding anything
    // about this event, so a transient stop/undefine failure cannot end the loop.
    // The retry keeps the record, its target claim and its captured baseline unless
    // the cleanup proves recovery (see `recoverAutonomousOccupancy`).
    let cleanupRecovery;
    try {
      cleanupRecovery = await this.recoverAutonomousOccupancy(exec);
    } catch (error) {
      this.autonomousPlanning.delete(identity);
      throw error;
    }
    const recoveryEvidence = cleanupRecovery.status === "not-required" ? null : { cleanupRecovery };
    // A live experiment for this exact hypothesis is already waiting for its
    // owner. Reporting it is the whole answer: a second Trial would mutate the
    // runtime again, conflict on the target claim it already owns, and record its
    // own success as a failure.
    const pending = this.pendingAutonomousCandidate(patternKey, strategyFingerprint);
    if (pending) {
      candidate.experimentId = pending.record.id;
      this.candidates.set(patternKey, candidate);
      this.autonomousPlanning.delete(identity);
      return {
        phase: "candidate-awaiting-confirmation",
        patternKey,
        strategyFingerprint,
        experimentId: pending.record.id,
        candidate,
        gates: pending.gates,
        recommendation: {
          action: "promote",
          confirmationRequired: true,
          reason: "explicit_user_confirmation_required_for_production_promotion",
          experimentId: pending.record.id,
        },
        automatic: false,
        reason: "already-measured-awaiting-owner",
      };
    }
    // A suppressed hypothesis answers nothing this event, but the cleanup retry
    // above still ran: that is how a hypothesis the observer already spent its
    // attempt on returns the runtime to the next eligible one.
    if (this.suppressedPatterns.has(identity)) {
      this.autonomousPlanning.delete(identity);
      return { phase: "suppressed", patternKey, strategyFingerprint, reason: "duplicate-failure", ...(recoveryEvidence ?? {}) };
    }
    // A transient environment failure is a timestamp, not a verdict: the conflict it
    // reported can be gone by now. Inside the cooldown the wait is reported and
    // nothing is touched; once it has passed the hypothesis is attempted again,
    // exactly like a first attempt (the same gates and claims decide whether it
    // runs). This is what lets one `E_EVOLUTION_RUNTIME_BUSY` stop being permanent.
    const deferral = this.deferredPatterns.get(identity) ?? null;
    if (deferral) {
      const remaining = this.transientRetryCooldownMs - (Date.now() - deferral.at);
      if (remaining > 0) {
        this.autonomousPlanning.delete(identity);
        return {
          phase: "experiment-deferred",
          patternKey,
          strategyFingerprint,
          reason: "transient-retry-cooldown",
          retryAfterMs: remaining,
          attempts: deferral.attempts,
          ...(recoveryEvidence ?? {}),
        };
      }
    }
    const failureSignature = this.memory.signature({
      problem: input.errorPatternDigest != null ? patternKey : safeInput.message || safeInput.code,
      // The declaration is part of the durable identity, so a changed strategy
      // no longer matches the recorded failure and is retried once, while an
      // unchanged one stays suppressed across restarts.
      experiment: { patternKey, strategy: strategyFingerprint },
      result: "autonomous-failure",
      prevention: "suppress duplicate",
    });
    // Read-only compatibility: the current raw digest and safe summary can
    // reproduce exactly one old identity, never an unknown historical duration.
    const legacyFailureSignature = input.errorPatternDigest != null ? this.memory.signature({
      problem: safeInput.message || safeInput.code,
      experiment: { patternKey: this.patternKey({ ...input, errorPatternDigest: undefined }), strategy: strategyFingerprint },
      result: "autonomous-failure",
      prevention: "suppress duplicate",
    }) : null;
    if (this.memory.hasActiveSignature(failureSignature)
      || legacyFailureSignature !== null && this.memory.hasActiveSignature(legacyFailureSignature)) {
      this.suppressForSession(identity);
      this.autonomousPlanning.delete(identity);
      return { phase: "suppressed", patternKey, strategyFingerprint, reason: "failure-memory" };
    }
    if (this.observing.has(identity)) {
      this.autonomousPlanning.delete(identity);
      return { phase: "observing", patternKey, strategyFingerprint, candidate, automatic: false, reason: "observation-in-flight" };
    }
    this.observing.add(identity);
    this.autonomousPlanning.delete(identity);
    let proposed;
    // Whether this attempt ended in an environment failure. Only that outcome
    // keeps the deferral: every other outcome means the hypothesis is no longer
    // waiting on the environment (it is measured, awaiting its owner, or answered
    // by a session/durable verdict), so the entry is dropped in `finally`.
    let deferredThisAttempt = false;
    // Reported with the decision this observation reaches: a released inherited
    // reservation is why this hypothesis could run at all (see
    // `releaseInheritedAutonomousDecision`).
    let decisionRecovery = null;
    // Whether this attempt took a durable reservation. A proposal rejected by
    // the ineffectiveness gate must give it back instead of leaving the identity
    // reserved until the next process start.
    let decisionReserved = false;
    try {
      // Complete a release that failed at revert time. `autonomousDecisions()`
      // is the state at store open, so a reservation taken by *this* process is
      // invisible to the inherited-decision path. This runs inside the
      // per-identity `observing` guard so two concurrent observations cannot
      // both queue a release, and a failure keeps the cooldown via
      // `deferredThisAttempt` (the `finally` below preserves it).
      if (this.pendingDecisionReleases.has(identity)) {
        let released = false;
        if (typeof this.domainStorage?.releaseAutonomousDecision !== "function") {
          released = true;
        } else {
          try {
            await this.domainStorage.releaseAutonomousDecision(identity);
            released = true;
          } catch {
            // Still unavailable: defer, never write a strategy failure.
          }
        }
        if (released) {
          this.pendingDecisionReleases.delete(identity);
        } else {
          const retry = this.deferForSession(identity);
          deferredThisAttempt = true;
          return {
            phase: "experiment-deferred",
            patternKey,
            strategyFingerprint,
            candidate,
            automatic: false,
            reason: "decision-release-pending",
            retryAfterMs: this.transientRetryCooldownMs,
            attempts: retry?.attempts,
            ...(recoveryEvidence ?? {}),
          };
        }
      }
      if (this.domainStorage?.reserveAutonomousDecision) {
        let reserved = await this.domainStorage.reserveAutonomousDecision(identity);
        if (!reserved) {
          decisionRecovery = await this.releaseInheritedAutonomousDecision(identity);
          if (decisionRecovery) reserved = await this.domainStorage.reserveAutonomousDecision(identity);
        }
        if (!reserved) {
          // A reservation held by a transient failure whose cleanup stayed
          // unproven is not an owner decision. Keep it in the retry window so
          // the next event waits out the cooldown instead of spinning on a
          // terminal-looking answer.
          this.deferForSession(identity);
          deferredThisAttempt = true;
          return { phase: "candidate-awaiting-confirmation", patternKey, strategyFingerprint,
            candidate, automatic: false, reason: "prior-decision-requires-owner",
            ...(decisionRecovery ? { decisionRecovery } : {}) };
        }
        decisionReserved = true;
      }
      if (this.prepareRuntime) await this.prepareRuntime(agent, exec.signal);
      // Give the declaration a stable text identity. `propose()` uses it to
      // consult the durable ineffectiveness conclusion gate, and
      // `publishConclusion()` fingerprints the terminal conclusion from the same
      // proposal. Without it the observer never read conclusions at all (its own
      // failure memory is bounded and pruned), so a hypothesis already proven
      // no-benefit/regression could be re-tried after a restart. The observer's
      // own suppression/occupancy identity (the 64-hex declaration fingerprint)
      // is unchanged and remains in the autonomous marker.
      // Derive the conclusion identity ONLY from the full declaration fingerprint
      // (which already includes the Host source code). A name/prefix-only text
      // kept an old `no-benefit` conclusion attached to a genuinely new
      // declaration that only changed the candidate source, and a name that
      // happens to be credential-shaped ("token") collapsed two distinct
      // declarations to the same redacted string.
      const declarationStrategy = `evolution-declaration:${strategyFingerprint ?? "undeclared"}`;
      proposed = this.propose({
        why: safeInput.message || `autonomous pattern ${patternKey}`,
        target: strategy.target || `plugin:${strategy.composition?.name || patternKey.slice(0, 12)}`,
        targets: strategy.targets,
        impactScope: strategy.impactScope || ["runtime"],
        successMetrics: strategy.successMetrics || ["error rate decreases"],
        risk,
        strategy: declarationStrategy,
      }, exec, { internal: true });
      if (proposed.ok === false && proposed.phase === "rejected") {
        // A prior durable verdict answered this declaration. That is not a new
        // strategy failure: return the gate's own reason and release the
        // reservation taken above rather than writing a failure lesson for a
        // proposal that never reached a Trial.
        if (decisionReserved) {
          try {
            await this.domainStorage.releaseAutonomousDecision(identity);
            this.pendingDecisionReleases.delete(identity);
          } catch {
            this.pendingDecisionReleases.add(identity);
            this.deferForSession(identity);
            deferredThisAttempt = true;
          }
        }
        this.autonomousPlanning.delete(identity);
        return {
          phase: "strategy-already-proven-ineffective",
          patternKey,
          strategyFingerprint,
          candidate,
          prior: proposed.prior,
          strategyFingerprintOfConclusion: proposed.strategyFingerprint,
          automatic: false,
          reason: "prior-ineffective-conclusion",
          ...(decisionRecovery ? { decisionRecovery } : {}),
        };
      }
      // The marker is what `pendingAutonomousCandidate` reads back after this
      // method returns; it is written before the Trial so a failed Trial's
      // archived record carries the hypothesis it was testing.
      this.requireOwned(proposed.experimentId, agent).autonomous = {
        patternKey,
        strategyFingerprint,
        idPrefix: strategy.idPrefix ?? null,
      };
      await this.trial({ experimentId: proposed.experimentId, idPrefix: strategy.idPrefix, composition: strategy.composition }, exec);
      const trialed = this.requireOwned(proposed.experimentId, agent);
      if (trialed.state !== "trial") {
        // A Trial the host is still waiting to approve has not run. Measuring it
        // would freeze evidence about code that never executed (and, on an
        // unchanged metric, learn a strategy failure for a Trial that could still
        // happen). The Trial stays mounted for the owner who has to approve it.
        candidate.experimentId = trialed.id;
        this.candidates.set(patternKey, candidate);
        return {
          phase: trialed.state,
          patternKey,
          strategyFingerprint,
          experimentId: trialed.id,
          candidate,
          automatic: false,
          reason: "trial-not-active",
          ...(decisionRecovery ? { decisionRecovery } : {}),
        };
      }
      const measured = typeof strategy.measure === "function" ? await strategy.measure({ input: safeInput, observations: structuredClone(observations) }) : strategy.observation;
      this.measure({ experimentId: proposed.experimentId, observation: measured }, exec);
      const measuredRecord = this.requireOwned(proposed.experimentId, agent);
      const gates = promotionGates(measuredRecord, { requireRuntimeRecovery: false });
      if (!gates.eligible) {
        await this.revert({ experimentId: proposed.experimentId }, exec);
        throw new Error(measured?.regressionPassed === false ? "metric regression" : "experiment produced no improvement");
      }
      // Advisory is deliberately complete through isolated trial, replay /
      // regression evidence, and recovery proof.  Production replacement is
      // a separate owner action; this path must never self-assert approval.
      const recommendation = {
        action: "promote",
        confirmationRequired: true,
        reason: "explicit_user_confirmation_required_for_production_promotion",
        experimentId: proposed.experimentId,
      };
      // Both modes return the same owner-confirmation answer: neither an
      // `advisory` nor an explicitly configured `autonomous` observer may turn
      // its own observation into production approval. The candidate stays in the
      // measured state and is now findable by the next observation of this
      // hypothesis instead of being re-experimented.
      candidate.experimentId = proposed.experimentId;
      this.candidates.set(patternKey, candidate);
      return {
        phase: "candidate-awaiting-confirmation",
        patternKey,
        strategyFingerprint,
        experimentId: proposed.experimentId,
        candidate,
        gates,
        recommendation,
        automatic: false,
        ...(decisionRecovery ? { decisionRecovery } : {}),
      };
    } catch (error) {
      this.autonomousPlanning.delete(identity);
      const detail = safeErrorDto(error, "autonomous");
      const cleanup = proposed ? await this.cleanupAutonomousTrial(proposed.experimentId, exec) : { status: "not-run" };
      // Nothing existed to learn from when the failure came before the proposal:
      // an unready runtime or an unreadable declaration never mutated anything,
      // so neither can be evidence that the hypothesis is wrong. Neither can a
      // failure that names the environment.
      const transient = !proposed || autonomousFailureIsTransient(detail);
      // The two kinds answer the identity differently. A failure of the declaration
      // itself is a verdict for this session (and, below, a durable one), so it is
      // not attempted again. An environment failure says nothing about the
      // declaration: it is deferred by `transientRetryCooldownMs`, so a later event
      // attempts the hypothesis again once the conflict is gone - a target that was
      // held by another experiment must not be re-probed on every error event, and
      // the hypothesis must not be retired for the rest of the session either. The
      // cleanup retry at the top of this method runs before this decision, so the
      // events that arrive during the wait keep retrying the *occupant's* cleanup.
      // Nothing here re-runs a hypothesis that already reached a Trial, and no
      // retry ever touches a strategy the failure memory has answered.
      const deferral = transient ? this.deferForSession(identity) : null;
      if (!transient) this.suppressForSession(identity);
      deferredThisAttempt = transient;
      if (transient) {
        // Release the decision reservation for every cleanup outcome. A failed
        // disposer may leave `not-recovered`/`failed` behind, but that is an
        // unfinished cleanup, not an owner-approved decision; holding the slot
        // forever made every later observation return
        // `prior-decision-requires-owner` and stalled the hypothesis until a
        // process restart. The runtime claim and the experiment record still
        // gate any new Trial, so releasing here cannot start a concurrent one.
        if (typeof this.domainStorage?.releaseAutonomousDecision === "function") {
          try {
            await this.domainStorage.releaseAutonomousDecision(identity);
            this.pendingDecisionReleases.delete(identity);
          } catch {
            this.pendingDecisionReleases.add(identity);
            this.warn('[evolution] could not release an autonomous decision reservation after a transient failure; a later observation will retry it');
          }
        } else {
          this.pendingDecisionReleases.delete(identity);
        }
        // No durable record: the environment, not the hypothesis, failed. Writing
        // one would suppress a possibly valid strategy in every later session on
        // evidence that says nothing about it.
        return {
          phase: "experiment-deferred",
          patternKey,
          strategyFingerprint,
          error: detail.errorSummary,
          errorCategory: detail.errorCategory,
          errorDigest: detail.errorDigest,
          cleanup,
          automatic: false,
          reason: "transient-failure",
          attempts: deferral?.attempts,
          retryAfterMs: this.transientRetryCooldownMs,
          ...(decisionRecovery ? { decisionRecovery } : {}),
          // What this event's cleanup retry found: `recovered` means the runtime was
          // reclaimed for later observations, `unproven`/`cooling-down` mean the
          // occupant still owns it and the explicit revert is the remaining exit.
          ...(recoveryEvidence ?? {}),
        };
      }
      this.memory.record({
        signature: failureSignature,
        problem: safeInput.message || safeInput.code || "autonomous failure",
        evidence: safeInput,
        experiment: { patternKey, target: strategy.target, strategy: strategyFingerprint },
        result: { state: "failed", category: detail.errorCategory, errorDigest: detail.errorDigest, errorSummary: detail.errorSummary, cleanup: cleanup.status },
        prevention: "suppress this autonomous strategy until its declaration changes (target, composition, risk) or the recorded failure is resolved",
      });
      return {
        phase: /regression/i.test(detail.errorSummary) ? "rolled-back-regression" : "rolled-back-no-improvement",
        patternKey,
        strategyFingerprint,
        error: detail.errorSummary,
        errorCategory: detail.errorCategory,
        errorDigest: detail.errorDigest,
        cleanup,
        ...(decisionRecovery ? { decisionRecovery } : {}),
      };
    } finally {
      this.observing.delete(identity);
      // The wait this observation cancelled is only re-established by another
      // environment failure (`deferredThisAttempt`, whose entry was just written).
      if (!deferredThisAttempt) this.deferredPatterns.delete(identity);
    }
  }

  requireOwned(id, agent) {
    const experimentId = text(id, "experimentId");
    const record = this.experiments.get(experimentId);
    if (!record) throw new Error(`experiment ${experimentId} is not known in this session`);
    if (record.ownerId !== agent.id) throw new Error(`experiment ${experimentId} is owned by another Agent`);
    return record;
  }

  async archive(record, reason, options = {}) {
    const file = path.join(this.paths.archiveDir, `${record.id}.md`);
    // Monotonic merge: durable evidence snapshot (if present) is the floor;
    // the in-memory record may upgrade individual fields. We never let the
    // rebuilt record's empty/unknown values overwrite a real durable one.
    // The event-bridge source is critical for legitimate promotions whose
    // sidecar was never written (older code path) and whose journal has
    // been removed after stable commit. We must not let stable-commit
    // overwrite a real, durable archive with empty fields.
    const sidecarSnapshot = await readEvidenceSnapshot(this.paths.archiveDir, record.id);
    const archiveSnapshot = await readArchiveMdEvidence(this.paths.archiveDir, record.id);
    const bridgeSnapshot = await readEventBridgeEvidence(this.paths.eventBridgePath, record.id, { key: this.paths.eventBridgeKey, trustedWriters: [this.paths.eventBridgeWriter] });
    // Monotonic merge across ALL durable authorities (sidecar, archive-md,
    // event bridge) so archive() never downgrades evidence that survived
    // in any of them — including older promotions whose journal/sidecar
    // were never written but whose event-bridge measurement exists.
    const durableSnapshot = mergeEvidenceSources([sidecarSnapshot, archiveSnapshot, bridgeSnapshot]);
    if (durableSnapshot) {
      hydrateRecordFromSnapshot(record, durableSnapshot);
    }
    const observationsMerged = preferArray(durableSnapshot?.observations, record.observations);
    const latestMerged = mergeMeasurement(record.latestObservation || {}, durableSnapshot?.latestObservation || {});
    // Read-back boundary: a durable snapshot (or an in-memory record restored
    // from one) can still carry the raw error text an older version wrote, so
    // both proofs are projected again here, at the point they are rendered.
    const cleanupMerged = safeProofForPersistence(preferObject(durableSnapshot?.cleanupProof, record.cleanupProof));
    const recoveryMerged = safeProofForPersistence(preferObject(durableSnapshot?.recoveryProof, record.recoveryProof)) || cleanupMerged;
    const recoveredMerged = (record.runtimeRecovered === true) || (durableSnapshot?.runtimeRecovered === true);
    // Renderer boundary. `archive()` builds its own Markdown instead of calling
    // `renderExperimentArchive`, so it projects every field it interpolates
    // rather than relying on the capture side having done it: `record.proposal`
    // can be replaced wholesale by `hydrateRecordFromSnapshot` two blocks above
    // (a durable record an older version wrote), and the observation blocks come
    // from the same merge. `EVIDENCE_PROJECTION` is the credential rule with the
    // row bounds lifted, so a credential-free record renders byte for byte as
    // before (below `REDACTION_TEXT_BOUND`; a larger single field is withheld by
    // that bound either way). The pool of durable authorities is why this cannot be
    // left to capture: the archive is also the replay path.
    const safeProposal = compactValue(record.proposal, EVIDENCE_PROJECTION);
    const observationsRendered = compactValue(observationsMerged, EVIDENCE_PROJECTION);
    const latestRendered = compactValue(latestMerged, EVIDENCE_PROJECTION);
    const memory = options.learn === false
      ? { entry: { signature: null, count: 0 }, duplicate: false }
      : this.memory.record({
        problem: safeProposal.why,
        evidence: latestRendered || observationsRendered.at(-1) || {},
        experiment: {
          id: record.id,
          target: safeProposal.target,
          targets: record.targets,
          phase: record.failure?.failurePhase || reason,
        },
        result: {
          state: record.state,
          category: record.failure?.errorCategory || reason,
          rollback: record.failure?.rollbackResult || cleanupMerged || { status: "not-required" },
        },
        prevention: record.failure?.nextPreventionHint || "retain verified rollback and promotion evidence",
        status: record.state === "stable" ? "resolved" : "active",
      });
    record.memorySignature = memory.entry.signature;
    if (memory.duplicate && record.failure) {
      record.archivePath = this.paths.memoryPath;
      return record.archivePath;
    }
    const content = [
      `# Evolution experiment ${record.id}`,
      "",
      `- state: ${record.state}`,
      `- terminal reason: ${reason}`,
      `- owner: ${safeProposal.owner}`,
      `- created: ${safeProposal.createdAt}`,
      `- source package: ${record.pluginId || "none"}/${record.packageId || "none"}`,
      "",
      "## Proposal",
      `- why: ${safeProposal.why}`,
      `- target: ${safeProposal.target}`,
      `- impact: ${safeProposal.impactScope.join(", ")}`,
      `- success metrics: ${safeProposal.successMetrics.join("; ")}`,
      "",
      "## Observations",
      "```json",
      JSON.stringify(observationsRendered, null, 2),
      "```",
      "",
      "## Latest measurement",
      "```json",
      JSON.stringify(latestRendered, null, 2),
      "```",
      // Conditional for the same reason as the renderer: a record without a
      // decision keeps the exact archive it had, and a missing decision never
      // becomes a fabricated "insufficient" claim.
      ...(isObject(record.decision) ? ["", "## Decision", "```json", JSON.stringify(safeDecisionForPersistence(record.decision), null, 2), "```"] : []),
      "",
      "## Runtime recovery",
      `- recovered: ${recoveredMerged}`,
      `- proof: ${JSON.stringify(recoveryMerged || { status: recoveredMerged ? "recovered" : "unknown" })}`,
      "",
      "## Failure learning",
      "```json",
      JSON.stringify(safeFailureForPersistence(record.failure), null, 2),
      "```",
      "",
      "## Memory lifecycle",
      `- signature: ${record.memorySignature ?? "not recorded (environment failure, not a strategy verdict)"}`,
      `- duplicate count: ${memory.entry.count}`,
      `- retention: bounded to ${this.memory.maxEntries} compact records`,
      "",
    ].join("\n");
    if (options.preserveArchiveFile?.preserved === true) {
      // The promotion journal survived a CAS conflict / rollback failure, so
      // this transaction's `exp-*.md` is live evidence owned by that journal:
      // rewriting it would destroy the concurrent edit the rollback refused to
      // overwrite (AGENTS.md invariant 2). The terminal failure record moves to
      // a sidecar next to it; the caller keeps the thrown error and the
      // `failure-learned` event as the user-visible report.
      const evidenceFile = path.join(this.paths.archiveDir, `${record.id}.failure.json`);
      await writeAtomic(evidenceFile, `${JSON.stringify({
        version: 1,
        source: "archive-preserved-failure",
        experimentId: record.id,
        state: record.state,
        terminalReason: reason,
        capturedAt: now(),
        preservedArchive: file,
        promotionJournal: safePromotionJournalForPersistence(options.preserveArchiveFile),
        failure: safeFailureForPersistence(record.failure),
        cleanupProof: safeProofForPersistence(record.cleanupProof),
        recoveryProof: safeProofForPersistence(record.recoveryProof),
        note: "the promotion journal is preserved, so the archive in this directory was not rewritten; this sidecar carries the terminal failure record",
      }, null, 2)}\n`, { durable: true });
      record.failureEvidencePath = evidenceFile;
      this.warn(`[evolution] ${reason} for ${record.id} left ${file} untouched because the promotion journal is preserved; failure record written to ${evidenceFile}`);
      return evidenceFile;
    }
    await writeAtomic(file, content);
    record.archivePath = file;
    // A terminal record is history once its archive exists. Bounding them here
    // keeps a long explicit session from retaining every experiment it ever ran
    // (each record keeps a baseline and a runtime snapshot); a record that still
    // owns a claim or an operation is never dropped.
    this.pruneTerminalExperiments();
    let archives = [];
    try {
      archives = (await fsp.readdir(this.paths.archiveDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /^exp-.*\.md$/.test(entry.name))
        .map((entry) => path.join(this.paths.archiveDir, entry.name));
      const ranked = await Promise.all(archives.map(async (archive) => ({ archive, mtime: (await fsp.stat(archive)).mtimeMs })));
      for (const stale of ranked.sort((left, right) => left.mtime - right.mtime).slice(0, Math.max(0, ranked.length - this.memory.maxEntries))) {
        if (stale.archive !== file) await fsp.rm(stale.archive, { force: true });
      }
    } catch {
      // Memory JSON remains bounded even if archive directory inspection is unavailable.
    }
    return file;
  }
}
