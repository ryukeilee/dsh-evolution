import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { types } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { constants as bufferConstants } from "node:buffer";
import { inspectLegacyStartupDrift } from "./compat/legacy-startup-drift.js";
import { fiberIsActive, serviceImpl, serviceImplSource } from "./cordis-compat.js";

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
export function signEventBridgeEnvelope(event, { key, writer = "dsh-evolution-orchestrator", sequence } = {}) {
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

function text(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function optionalText(value, field) {
  if (value === undefined || value === null) return undefined;
  return text(value, field);
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

function safeString(value) {
  return typeof value === "string" ? value : String(value ?? "");
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
      return [{
        name,
        active: fiberIsActive(impl.fiber),
        owner: stableOwner(impl.fiber) || "unknown",
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

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function compactValue(value, { maxText = 1200, maxItems = 8, depth = 0 } = {}) {
  if (value === undefined || value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    const redacted = value
      .replace(/\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [redacted]");
    return redacted.length > maxText ? `${redacted.slice(0, maxText)}…[truncated]` : redacted;
  }
  if (depth >= 4) return "[compacted]";
  if (Array.isArray(value)) return value.slice(0, maxItems).map((item) => compactValue(item, { maxText, maxItems, depth: depth + 1 }));
  if (!isObject(value)) return safeString(value);
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/^(?:raw|fullOutput|stdout|stderr|logs?|transcript)$/i.test(key)) continue;
    result[key] = compactValue(entry, { maxText, maxItems, depth: depth + 1 });
  }
  return result;
}

// The depth bound shared by the load predicate and the content-derived
// identity. A restored record may nest up to this many levels, and the
// identity has to distinguish every record the loader accepts, so the
// serializer stops one level past the bound rather than at it.
const MEMORY_ENTRY_MAX_DEPTH = 64;

// JSON with sorted keys and a bounded depth. The bound matters for the
// content-derived identity of restored records: a record restored from data
// that nests far deeper than any signature input must not raise a RangeError
// while startup is loading it, and doctor and runtime must agree on it.
function stableJson(value, depth = 0) {
  if (depth > MEMORY_ENTRY_MAX_DEPTH) return '"[max-depth]"';
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item, depth + 1)).join(",")}]`;
  if (!isObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key], depth + 1)}`).join(",")}}`;
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
    const result = plain ? {} : { $class: value.constructor?.name || "anonymous" };
    for (const key of Object.keys(value)) {
      result[key] = toLosslessJson(value[key], ancestors);
    }
    return result;
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

  load() {
    if (!this.file) return this.snapshot();
    let stored;
    try {
      stored = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        // A corrupted memory file must not take the orchestrator down: move it
        // aside (quarantine), continue with an empty memory, and surface a
        // queryable warning instead of failing startup.
        const quarantined = `${this.file}.quarantine-${process.pid}-${Date.now()}`;
        let moved = false;
        try {
          fs.renameSync(this.file, quarantined);
          this.quarantine = { from: this.file, to: quarantined, at: now(), reason: "parse-failure" };
          moved = true;
        } catch (renameError) {
          // Keep the unreadable source intact if quarantine cannot be made;
          // startup still continues, but the warning remains queryable.
          this.warnings.push(`evolution-memory.json 无法隔离（parse failure: ${error.message}；quarantine failure: ${renameError.message}）；已用空 memory 继续启动`);
        }
        if (moved) {
          this.warnings.push(`evolution-memory.json 损坏已隔离: ${quarantined}（parse failure: ${error.message}）；已用空 memory 继续启动`);
          try { this.compact({ save: true }); } catch (saveError) {
            this.warnings.push(`evolution-memory.json 空 memory 写入失败（${saveError.message}）；runtime 仍继续启动`);
          }
        }
        return this.snapshot();
      }
    }
    // A record that is not an object cannot be deduplicated or trimmed without
    // guessing, so the whole file is quarantined like any other damaged state;
    // a restored record that merely lacks an identity gets a derived one below.
    const entriesUsable = Array.isArray(stored?.entries) && stored.entries.every(isUsableMemoryEntry);
    if (stored?.schema === 1 && entriesUsable) {
      this.data = stored;
      for (const entry of this.data.entries) {
        if (typeof entry.signature !== "string" || entry.signature.length === 0) entry.signature = storedEntrySignature(entry);
      }
    } else if (stored !== undefined) {
      const reason = stored?.schema === 1 ? "entry-failure" : "schema-failure";
      const description = stored?.schema === 1 ? "记录不可用" : "结构无效";
      const quarantined = `${this.file}.quarantine-${process.pid}-${Date.now()}`;
      let moved = false;
      try {
        fs.renameSync(this.file, quarantined);
        this.quarantine = { from: this.file, to: quarantined, at: now(), reason };
        moved = true;
      } catch (error) {
        this.warnings.push(`evolution-memory.json ${description}且无法隔离（${error.message}）；已用空 memory 继续启动`);
      }
      if (moved) {
        this.warnings.push(`evolution-memory.json ${description}已隔离: ${quarantined}；已用空 memory 继续启动`);
        try { this.compact({ save: true }); } catch (error) {
          this.warnings.push(`evolution-memory.json 空 memory 写入失败（${error.message}）；runtime 仍继续启动`);
        }
      }
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

function failureCategory(error, phase) {
  const message = safeString(error?.message || error).toLowerCase();
  if (phase.includes("cleanup") || phase === "revert" || /dispose|rollback|undefine|stop|orphan/.test(message)) return "cleanup-or-rollback";
  if (/regression/.test(message)) return "regression";
  if (/repeat/.test(message)) return "repeatability";
  if (/permission|approval|unauthor/.test(message)) return "approval-or-permission";
  if (/syntax|compile|parse/.test(message)) return "invalid-code";
  if (/journal|atomic|promotion|mount|reload/.test(message)) return "durable-promotion";
  return "runtime-trial";
}

function failureLearning({ record, phase, error, rollbackResult, rootCauseHypothesis, nextPreventionHint }) {
  return {
    experimentId: record.id,
    failurePhase: phase,
    errorCategory: failureCategory(error, phase),
    error: safeString(error?.message || error),
    rootCauseHypothesis: rootCauseHypothesis || "需要依据 Cordis inspect 与 cleanup proof 继续定位；当前不把症状升级为永久规则。",
    rollbackResult: rollbackResult ?? { ok: false, status: "unknown" },
    nextPreventionHint: nextPreventionHint || "下一次实验先复核基线、边界与可逆性，并避免复用未证实的假设。",
    recordedAt: now(),
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
    const key = JSON.stringify([item?.id, item?.barrierId, item?.at, item?.experimentId]);
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

function mergeMeasurement(current, durable) {
  if (isMissing(durable)) return current;
  if (isMissing(current)) return durable;
  return {
    at: preferTruthy(current.at, durable.at) || current.at,
    solvesProblem: preferBoolean(current.solvesProblem, durable.solvesProblem),
    sideEffects: preferArray(current.sideEffects, durable.sideEffects),
    orphanResources: preferArray(current.orphanResources, durable.orphanResources),
    performanceChange: preferTruthy(current.performanceChange, durable.performanceChange) || current.performanceChange,
    errorChange: preferTruthy(current.errorChange, durable.errorChange) || current.errorChange,
    metrics: preferObject(current.metrics, durable.metrics),
    beforeMetrics: preferObject(current.beforeMetrics, durable.beforeMetrics),
    afterMetrics: preferObject(current.afterMetrics, durable.afterMetrics),
    observationWindow: preferTruthy(current.observationWindow, durable.observationWindow) || current.observationWindow,
    sampleCount: preferTruthy(current.sampleCount, durable.sampleCount) ?? current.sampleCount,
    benefitEvidence: preferTruthy(current.benefitEvidence, durable.benefitEvidence) || current.benefitEvidence,
    repeatable: preferBoolean(current.repeatable, durable.repeatable),
    regressionPassed: preferBoolean(current.regressionPassed, durable.regressionPassed),
    reversible: preferBoolean(current.reversible, durable.reversible),
    cleanupEvidence: preferTruthy(current.cleanupEvidence, durable.cleanupEvidence) || current.cleanupEvidence,
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

export async function persistEvidenceSnapshot(archiveDir, experimentId, payload) {
  const file = evidenceSnapshotPath(archiveDir, experimentId);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await writeAtomic(file, JSON.stringify(payload, null, 2) + "\n");
  return file;
}

export function snapshotEvidenceFromRecord(record) {
  return {
    version: 1,
    capturedAt: now(),
    latestObservation: record?.latestObservation || null,
    observations: Array.isArray(record?.observations) ? record.observations : [],
    cleanupProof: record?.cleanupProof || null,
    recoveryProof: record?.recoveryProof || null,
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
  return {
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
  };
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
  let key;
  let trustedWriters;
  let initialized = false;
  let failed = false;
  let failure;
  const initialize = () => {
    if (initialized) return;
    initialized = true;
    key = options?.key || process.env.DSH_EVOLUTION_EVENT_BRIDGE_KEY;
    trustedWriters = new Set(options?.trustedWriters || ["dsh-evolution-orchestrator"]);
  };
  let measurement = null;
  let gates = null;
  let promotion = null;
  let canary = null;
  let latestAt = null;
  const sequences = new Map();
  const consume = (line) => {
    if (failed) return;
    try {
      initialize();
      if (typeof key !== "string" || key.length < 16 || !line.trim()) return;
      let envelope;
      try {
        envelope = JSON.parse(line);
      } catch {
        return;
      }
      const verified = verifyEventBridgeEnvelope(envelope, key);
      if (!verified) return;
      const { event, writer, sequence } = verified;
      if (!trustedWriters.has(writer)) return;
      const prior = sequences.get(writer) || 0;
      // Strictly increasing per-writer sequences already reject every replay.
      if (sequence <= prior) return;
      sequences.set(writer, sequence);
      if (event?.experimentId !== experimentId || typeof event?.eventType !== "string") return;
      latestAt = event.audit?.at || latestAt;
      if (event.eventType === "measurement-completed" && isObject(event.measurement)) measurement = event.measurement;
      if (event.eventType === "promotion-succeeded") {
        if (isObject(event.evidence)) gates = event.evidence;
        if (isObject(event.promotion)) promotion = event.promotion;
        if (isObject(event.measurement) && !measurement) measurement = event.measurement;
      }
      if (event.eventType === "canary-passed" && isObject(event.canary)) canary = event.canary;
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
  initialize();
  if (typeof key !== "string" || key.length < 16) return null;
  const canaryObservations = Array.isArray(canary?.observations) ? canary.observations : [];
  const observations = [];
  if (measurement) observations.push(measurement);
  for (const entry of canaryObservations) observations.push(entry);
  if (observations.length === 0 && !gates && !promotion) return null;
  const runtimeRecovered = gates?.runtimeRecovered === true;
  return {
    version: 1,
    source: "event-bridge",
    capturedAt: latestAt || null,
    promotionTimestamp: promotion?.promotionTimestamp || null,
    observations,
    latestObservation: measurement || null,
    cleanupProof: null,
    recoveryProof: {
      status: runtimeRecovered ? "recovered" : "unknown",
      source: "event-bridge:promotion-succeeded",
      verificationSource: "event-bridge:gates.runtimeRecovered",
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
    const merged = { ...candidate };
    for (const key of Object.keys(acc)) {
      if (isMissing(acc[key])) {
        if (!isMissing(candidate[key])) merged[key] = candidate[key];
      } else {
        merged[key] = acc[key];
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
  }
  return merged;
}

/**
 * Pure archive renderer shared by archive() and the archive-replay path.
 * Keeps the durable `exp-*.md` shape stable so both the memory path and
 * the replay path produce identical section semantics.
 */
export function renderExperimentArchive({ id, state, reason, proposal, pluginId, packageId, observations, latestMeasurement, recoveryProof, recovered, failure, memorySignature, duplicateCount, retention }) {
  return [
    `# Evolution experiment ${id}`,
    "",
    `- state: ${state}`,
    `- terminal reason: ${reason}`,
    `- owner: ${proposal?.owner || "unknown"}`,
    `- created: ${proposal?.createdAt || "unknown"}`,
    `- source package: ${pluginId || "none"}/${packageId || "none"}`,
    "",
    "## Proposal",
    `- why: ${proposal?.why || ""}`,
    `- target: ${proposal?.target || ""}`,
    `- impact: ${(proposal?.impactScope || []).join(", ")}`,
    `- success metrics: ${(proposal?.successMetrics || []).join("; ")}`,
    "",
    "## Observations",
    "```json",
    JSON.stringify(observations, null, 2),
    "```",
    "",
    "## Latest measurement",
    "```json",
    JSON.stringify(latestMeasurement, null, 2),
    "```",
    "",
    "## Runtime recovery",
    `- recovered: ${recovered}`,
    `- proof: ${JSON.stringify(recoveryProof || { status: recovered ? "recovered" : "unknown" })}`,
    "",
    "## Failure learning",
    "```json",
    JSON.stringify(failure || { status: "none" }, null, 2),
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
 */
export async function replayExperimentEvidence(paths, experimentId) {
  if (!paths?.archiveDir || !experimentId) throw new Error("replay requires archiveDir and experimentId");
  const sources = [
    await readEvidenceSnapshot(paths.archiveDir, experimentId),
    await readArchiveMdEvidence(paths.archiveDir, experimentId),
    await readEventBridgeEvidence(paths.eventBridgePath, experimentId, { key: paths.eventBridgeKey, trustedWriters: [paths.eventBridgeWriter || "dsh-evolution-orchestrator"] }),
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
  });
  const archivePath = path.join(paths.archiveDir, `${experimentId}.md`);
  await writeAtomic(archivePath, content);
  const sidecar = {
    version: 1,
    source: (merged.source || "replay") + "+replay",
    capturedAt: now(),
    promotionTimestamp: merged.promotionTimestamp || durable?.promotionTimestamp || null,
    latestObservation: record.latestObservation || null,
    observations: record.observations || [],
    cleanupProof: record.cleanupProof || null,
    recoveryProof,
    runtimeRecovered: recovered,
    gateEvidence: record.lastGateEvidence || null,
    durable,
    canary: record.canary || null,
    ownerId: record.ownerId || null,
    proposal: record.proposal || null,
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
 * shared numeric metric must actually improve. Low-risk experiments stay
 * simple: two small metric objects plus a window label are enough.
 */
export function measuredEvidenceOf(observation) {
  const nested = isObject(observation?.metrics) ? observation.metrics : {};
  const before = isObject(observation?.beforeMetrics) ? observation.beforeMetrics : isObject(nested.before) ? nested.before : isObject(nested.beforeMetrics) ? nested.beforeMetrics : null;
  const after = isObject(observation?.afterMetrics) ? observation.afterMetrics : isObject(nested.after) ? nested.after : isObject(nested.afterMetrics) ? nested.afterMetrics : null;
  if (!before || !after || Object.keys(before).length === 0 || Object.keys(after).length === 0) return false;
  const window = observation?.observationWindow;
  if (!(typeof window === "string" && window.trim() !== "") && !(typeof window === "number" && Number.isFinite(window))) return false;
  if (!Number.isInteger(Number(observation?.sampleCount)) || Number(observation.sampleCount) < 1) return false;
  return Object.keys(before).some((key) => typeof before[key] === "number" && typeof after[key] === "number" && after[key] < before[key]);
}

export function promotionGates(experiment, { requireRuntimeRecovery = true } = {}) {
  const observation = experiment.latestObservation;
  const metrics = observation?.metrics;
  const hasMetrics = isObject(metrics) && Object.keys(metrics).length > 0;
  const realBenefit = observation?.solvesProblem === true && (
    hasMetrics || meaningfulChange(observation.performanceChange) || meaningfulChange(observation.errorChange) || typeof observation.benefitEvidence === "string" && observation.benefitEvidence.length > 0
  );
  const noOrphans = (observation?.orphanResources || []).length === 0;
  const gates = {
    realBenefit,
    measuredEvidence: measuredEvidenceOf(observation),
    repeatable: observation?.repeatable === true,
    regressionTest: observation?.regressionPassed === true,
    reversible: observation?.reversible === true,
    cleanupEvidence: typeof observation?.cleanupEvidence === "string" && observation.cleanupEvidence.trim().length > 0,
    noOrphans,
    runtimeRecovered: experiment.runtimeRecovered === true,
  };
  const evidence = [gates.realBenefit, gates.measuredEvidence, gates.repeatable, gates.regressionTest, gates.reversible, gates.cleanupEvidence, gates.noOrphans];
  return { ...gates, eligible: evidence.every(Boolean) && (!requireRuntimeRecovery || gates.runtimeRecovered) };
}

/**
 * Shape a matured experiment record into the extracted Dockyard evaluator's
 * evidence contract. The evaluator is advisory in `promote()`; absent evidence
 * stays absent instead of being synthesized into a passing claim.
 */
export function domainEvaluationEvidence(experiment = {}) {
  const observation = experiment.latestObservation || {};
  return {
    beforeMetrics: observation.beforeMetrics,
    afterMetrics: observation.afterMetrics,
    metrics: observation.metrics,
    goalResult: observation.solvesProblem === true ? true : null,
    regressionResult: observation.regressionPassed,
    currentVersion: experiment.durable?.rowId,
    historicalBestVersion: experiment.previousDurable?.rowId,
    benefitEvidence: observation.benefitEvidence,
  };
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
    eventBridgeWriter: config.eventBridgeWriter || "dsh-evolution-orchestrator",
    driftStatePath: config.driftStatePath || path.join(os.homedir(), ".local", "share", "dsh-local", "dsh-profiles-state.json"),
    ownershipDir: config.ownershipDir || path.join(presetDir, ".evolution-ownership"),
  };
}

async function readIfExists(file) {
  try {
    return await fsp.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function writeAtomic(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.evolution-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await fsp.writeFile(temp, content, "utf8");
    await fsp.rename(temp, file);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
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
  // scope. Conservative lexical refusal (including comments/strings) is
  // intentional; this is not a security parser or a sandbox compatibility
  // claim. Keep runner-only helpers out even when used lazily in apply().
  if (/\bharness\b/.test(hostCode)) throw new Error("Promotion does not support runner sandbox harness helpers (including harness.handle); Host-only standalone Plugin required");
  try { new Function(hostCode); } catch (error) {
    throw new Error(`Promotion requires a synchronous standalone Host body: ${error.message}`);
  }
}

function packageSource(hostCode, pluginName) {
  assertPromotableHostSource(hostCode);
  return `// Generated by dsh-evolution-orchestrator after a verified Promotion.\n// The Plugin lifecycle remains owned by Cordis.\nconst plugin = Function(${JSON.stringify(hostCode)})();\nexport const name = plugin?.name || ${JSON.stringify(pluginName)};\nexport const inject = plugin?.inject;\nexport const provide = plugin?.provide;\nexport const intercept = plugin?.intercept;\nexport const Config = plugin?.Config;\nexport function apply(ctx, config) {\n  if (typeof plugin === "function") return plugin(ctx, config);\n  if (plugin && typeof plugin.apply === "function") return plugin.apply(ctx, config);\n  throw new Error("Promoted Cordis Plugin did not return a function or an object with apply(ctx)");\n}\n`;
}

async function pathExists(file) {
  try { await fsp.lstat(file); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function writeJournal(file, journal) {
  await writeAtomic(file, JSON.stringify(journal, null, 2) + "\n");
}

function pathWithin(target, root) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertJournalTargets(journal, paths) {
  if (!paths?.presetDir || !paths?.promotionStateDir || !paths?.pluginRoot || !paths?.archiveDir) {
    throw new Error("Evolution promotion journal recovery requires the complete configured target roots");
  }
  if (path.resolve(journal.stateDir) !== path.resolve(paths.promotionStateDir)) throw new Error("Evolution promotion journal state directory is outside the configured preset");
  if (journal.stageDir && !pathWithin(journal.stageDir, paths.promotionStateDir)) throw new Error("Evolution promotion journal stage directory is outside its state directory");
  if (!Array.isArray(journal.records)) throw new Error("Evolution promotion journal has no valid change plan");
  const roots = [paths.pluginRoot, paths.presetDir, paths.archiveDir].filter(Boolean);
  for (const record of journal.records || []) {
    if (!new Set(["file", "path"]).has(record?.type)
      || typeof record?.target !== "string"
      || pathWithin(record.target, paths.promotionStateDir)
      || !roots.some((root) => pathWithin(record.target, root))
      || record.type === "file" && (typeof record.backup !== "string" || path.basename(record.backup) !== record.backup)) {
      throw new Error("Evolution promotion journal contains an out-of-boundary target");
    }
  }
}

async function rollbackPromotionJournal(journal, paths) {
  const records = Array.isArray(journal?.records) ? journal.records : [];
  const failures = [];
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
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await fsp.copyFile(path.join(journal.stateDir, "backups", record.backup), target);
        } else {
          await fsp.rm(target, { force: true });
        }
      } else if (record.type === "path" || record.type === "symlink") {
        await fsp.rm(target, { recursive: record.type === "path", force: true });
      }
    } catch (error) {
      failures.push({ target, error: safeString(error?.message || error) });
    }
  }
  // Disk rollback is not runtime rollback. Join the official Include's
  // removal/disposal before claiming recovery or deleting its journal.
  if (paths?.promotionRuntime) {
    try { await paths.promotionRuntime.refresh(); } catch (error) {
      failures.push({ target: paths.compositionPath, error: safeString(error?.message || error) });
    }
  }
  if (failures.length > 0) {
    journal.phase = "rollback-failed";
    journal.rollbackFailures = failures;
    await writeJournal(path.join(journal.stateDir, "journal.json"), journal).catch(() => {});
    throw new Error(`Evolution promotion rollback failed for ${failures.length} target(s); journal preserved at ${journal.stateDir}`);
  }
  if (journal.stageDir) await fsp.rm(journal.stageDir, { recursive: true, force: true });
  await fsp.rm(journal.stateDir, { recursive: true, force: true });
  return { ok: true };
}

/** Recover a promotion interrupted between journal commit phases. */
export async function recoverInterruptedPromotion(paths) {
  const journalPath = path.join(paths.promotionStateDir, "journal.json");
  if (!await pathExists(journalPath)) return { recovered: false, status: "none" };
  let journal;
  try {
    journal = JSON.parse(await fsp.readFile(journalPath, "utf8"));
  } catch (error) {
    throw new Error(`Evolution promotion journal is unreadable: ${error.message}`);
  }
  assertJournalTargets(journal, paths);
  if (journal.phase === "stable-committed" || journal.phase === "committed") {
    await fsp.rm(journal.stateDir, { recursive: true, force: true }).catch(() => {});
    return { recovered: true, status: "committed-cleaned" };
  }
  if (journal.phase === "canary-observing") {
    return { recovered: false, status: "canary-pending", experimentId: journal.experimentId, journal };
  }
  if (journal.phase === "rollback-failed") throw new Error(`Evolution promotion rollback is incomplete: ${journal.stateDir}`);
  await rollbackPromotionJournal(journal);
  return { recovered: true, status: "rolled-back", experimentId: journal.experimentId };
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

async function writeDurablePromotionUnlocked({ experiment, packageInspection, paths, canaryWindow = 2 }) {
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
  const moduleUrl = pathToFileURL(modulePath).href;
  if (await pathExists(pluginPath)) throw new Error(`Promotion target already exists: ${pluginName}`);

  const compositionBefore = await readIfExists(paths.compositionPath);
  const evolutionBefore = await readIfExists(paths.evolutionPath);
  const entries = paths.promotionRuntime.parse(compositionBefore);
  if (entries.some(entry => entry.id === rowId || entry.name === moduleUrl)) throw new Error(`Promotion row already exists: ${rowId}`);
  const compositionAfter = paths.promotionRuntime.stringify([...entries, { id: rowId, name: moduleUrl }]);
  const archivePath = path.join(paths.archiveDir, `${experiment.id}.md`);
  const archive = [
    `# Evolution experiment ${experiment.id}`,
    "",
    `- state: ${String(experiment.state).startsWith("promotion-") || experiment.state === "promoting" ? "canary-observing" : experiment.state}`,
    `- owner: ${experiment.proposal.owner}`,
    `- created: ${experiment.proposal.createdAt}`,
    `- promoted: ${now()}`,
    `- durable plugin: ${pluginName}`,
    `- source sha256: ${crypto.createHash("sha256").update(hostCode).digest("hex")}`,
    "",
    "## Proposal",
    `- why: ${experiment.proposal.why}`,
    `- target: ${experiment.proposal.target}`,
    `- impact: ${experiment.proposal.impactScope.join(", ")}`,
    `- success metrics: ${experiment.proposal.successMetrics.join("; ")}`,
    "",
    "## Observation",
    "```json",
    JSON.stringify(experiment.latestObservation || {}, null, 2),
    "```",
    "",
    "## Runtime recovery",
    `- recovered: ${experiment.runtimeRecovered === true}`,
    `- proof: ${JSON.stringify(experiment.recoveryProof || experiment.cleanupProof || { status: experiment.runtimeRecovered === true ? "recovered" : "unknown" })}`,
    `- rollback: remove ${paths.compositionPath} row ${rowId}, remove ${pluginPath}, and start a new session`,
    "",
  ].join("\n");
  const evolutionAfter = updateEvolutionPointer(evolutionBefore, experiment, { pluginName, pluginPath, presetId: paths.presetId, rowId, archivePath });
  const plannedFiles = new Map([[paths.compositionPath, compositionAfter], [paths.evolutionPath, evolutionAfter], [archivePath, archive]]);
  const stateDir = paths.promotionStateDir;
  const journalPath = path.join(stateDir, "journal.json");
  await fsp.rm(stateDir, { recursive: true, force: true });
  await fsp.mkdir(path.join(stateDir, "backups"), { recursive: true, mode: 0o700 });
  const records = [];
  for (const target of [paths.compositionPath, paths.evolutionPath, archivePath]) {
    const existed = await pathExists(target);
    if (existed && !fs.statSync(target).isFile()) throw new Error(`Promotion target is not a regular file: ${target}`);
    const key = crypto.createHash("sha256").update(target).digest("hex").slice(0, 16) + ".bak";
    if (existed) await fsp.copyFile(target, path.join(stateDir, "backups", key));
    records.push({ type: "file", target, existed, backup: key,
      beforeDigest: existed ? sha256(await fsp.readFile(target, "utf8")) : null,
      expectedAfter: sha256(plannedFiles.get(target)) });
  }
  records.push({ type: "path", target: pluginPath, existed: false });
  const journal = {
    version: 1,
    phase: "prepared",
    experimentId: experiment.id,
    ownerId: experiment.ownerId,
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
    },
    // Persist evidence at durable write time so the journal is the single
    // source of truth across sessions. observeCanary restores hydrate from
    // this field rather than rebuilding empty.
    evidenceSnapshot: snapshotEvidenceFromRecord(experiment),
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
    await writeAtomic(modulePath, packageSource(hostCode, pluginName));
    await writeAtomic(packageJsonPath, JSON.stringify({
      name: pluginName,
      version: "0.1.0",
      private: true,
      type: "module",
      main: "lib/index.js",
      files: ["lib"],
    }, null, 2) + "\n");
    if (await readIfExists(paths.compositionPath) !== compositionBefore) {
      throw new Error("Promotion composition changed after prepare; refusing to overwrite concurrent modification");
    }
    await writeAtomic(paths.compositionPath, compositionAfter);
    await writeAtomic(paths.evolutionPath, evolutionAfter);
    await writeAtomic(archivePath, archive);
    const verification = await verifyDurablePromotion({ pluginName, pluginPath, compositionPath: paths.compositionPath, rowId, promotionRuntime: paths.promotionRuntime });
    journal.phase = "canary-observing";
    journal.verification = verification;
    journal.durable = { pluginName, pluginPath, moduleUrl, rowId, archivePath, presetId: paths.presetId, adapter: "official-include" };
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
    journalPath,
    promotionTimestamp: journal.canary.promotionTimestamp,
    healthObservationWindow: journal.canary.healthObservationWindow,
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
  const active = sameHost && processAlive(pid);
  if (active) return { recovered: false, status: "active", owner: metadata, ageMs };
  const stale = !Number.isFinite(createdAt)
    || ageMs >= Math.max(1, Number(ttlMs) || 15 * 60 * 1000)
    || (metadata && sameHost && Number.isInteger(pid) && !processAlive(pid));
  if (!stale) return { recovered: false, status: "fresh-unowned", owner: metadata, ageMs };
  await fsp.rm(lockPath, { recursive: true, force: true });
  return { recovered: true, status: "stale-recovered", owner: metadata, ageMs };
}

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
  await writeAtomic(path.join(lockDir, "lock.json"), JSON.stringify({
    schema: 1,
    token,
    pid: process.pid,
    hostname: os.hostname(),
    owner: options.experiment?.ownerId || "unknown",
    operation: "promotion",
    createdAt: now(),
  }, null, 2) + "\n");
  try {
    return await writeDurablePromotionUnlocked(options);
  } finally {
    try {
      const current = JSON.parse(await fsp.readFile(path.join(lockDir, "lock.json"), "utf8"));
      if (current.token === token) await fsp.rm(lockDir, { recursive: true, force: true });
    } catch {
      // Preserve an unknown/replaced lock rather than removing another
      // process's ownership record.
    }
  }
}

async function readCanaryJournal(paths) {
  const journalPath = path.join(paths.promotionStateDir, "journal.json");
  if (!await pathExists(journalPath)) return null;
  const journal = JSON.parse(await fsp.readFile(journalPath, "utf8"));
  assertJournalTargets(journal, paths);
  return journal.phase === "canary-observing" ? journal : null;
}

function executionFailureFingerprint(record = {}) {
  const failure = record.failure || {};
  return failure.error || failure.errorCategory || failure.failurePhase
    ? `failure:${sha256(stableJson({
      phase: failure.failurePhase ?? null,
      category: failure.errorCategory ?? null,
      error: failure.error ?? null,
      rootCauseHypothesis: failure.rootCauseHypothesis ?? null,
      nextPreventionHint: failure.nextPreventionHint ?? null,
    }))}`
    : null;
}

/**
 * Small, append-only A→B transport. It carries execution facts only; the
 * runtime memory plane owns interpretation, deduplication, lineage, and GC.
 * Duplicate lines are intentional at-least-once delivery and are made
 * idempotent by EvolutionMemory.applyExecutionEvent().
 */
export class EvolutionEventBridge {
  constructor({ file, key = process.env.DSH_EVOLUTION_EVENT_BRIDGE_KEY, writer = "dsh-evolution-orchestrator" } = {}) {
    this.file = file;
    this.key = key;
    this.writer = writer;
    this.seen = new Set();
    this.sequence = 0;
    if (this.file) {
      try {
        for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const stored = JSON.parse(line);
            const verified = verifyEventBridgeEnvelope(stored, this.key);
            if (verified?.writer === this.writer) this.sequence = Math.max(this.sequence, verified.sequence);
            if (typeof verified?.event?.eventId === "string") this.seen.add(verified.event.eventId);
          } catch { /* B remains fail-closed when it replays malformed content. */ }
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
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
      measurement: payload.measurement ?? (record.latestObservation ? compactValue(record.latestObservation) : null),
      failureFingerprint: payload.failureFingerprint ?? executionFailureFingerprint(record),
      failure: payload.failure ?? (record.failure ? compactValue(record.failure) : null),
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
    if (this.seen.has(event.eventId)) return event;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const envelope = signEventBridgeEnvelope(event, { key: this.key, writer: this.writer, sequence: ++this.sequence });
    const fd = fs.openSync(this.file, "a", 0o600);
    try { fs.writeSync(fd, `${JSON.stringify(envelope)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const dirfd = fs.openSync(path.dirname(this.file), "r");
    try { fs.fsyncSync(dirfd); } finally { fs.closeSync(dirfd); }
    this.seen.add(event.eventId);
    return event;
  }
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
    this.paths = defaultPaths(config);
    this.eventBridge = config.eventBridge || new EvolutionEventBridge({ file: this.paths.eventBridgePath, key: this.paths.eventBridgeKey, writer: this.paths.eventBridgeWriter });
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
    this.suppressedPatterns = new Set();
    this.sequence = 0;
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
    const observations = snapshotJson(this.observations.slice(-20));
    const candidates = snapshotJson([...this.candidates.values()]);
    const result = toLosslessJson(runtime);
    result.evolutionObservations = observations;
    result.evolutionCandidates = candidates;
    return result;
  }

  emitExecutionEvent(type, record, payload = {}) {
    const event = this.eventBridge.emit(type, record, payload);
    void this.ctx.emit?.("evolution/execution-event", event);
    return event;
  }

  /**
   * Legacy startup drift detection lives in the explicit compatibility
   * adapter `lib/compat/legacy-startup-drift.js`; it is off by default and its
   * external `drift-engine.js` import is never loaded unless a caller opts in.
   */
  async inspectStartupDrift() {
    const summary = await inspectLegacyStartupDrift(this.paths);
    if (summary.status === "drift") this.ctx.logger?.warn?.(`[evolution] Live/Backup drift detected: ${JSON.stringify(summary)}`);
    await this.ctx.emit?.("evolution/drift", summary);
    return summary;
  }

  propose(args, exec) {
    const agent = ownerOf(exec);
    const proposal = {
      why: text(args?.why, "why"),
      target: text(args?.target, "target"),
      impactScope: scopeList(args?.impactScope),
      successMetrics: stringList(args?.successMetrics, "successMetrics"),
      risk: safeString(args?.risk || "low").toLowerCase(),
      owner: agent.id,
      createdAt: now(),
    };
    const id = `exp-${Date.now().toString(36)}-${(++this.sequence).toString(36)}`;
    const record = {
      id,
      proposal,
      state: "proposed",
      ownerId: agent.id,
      baseline: this.inspect(agent),
      observations: [],
      runtimeRecovered: false,
      targets: normalizeTargets(args),
    };
    this.experiments.set(id, record);
    this.emitExecutionEvent("proposal-created", record);
    return {
      ok: true,
      experimentId: id,
      phase: record.state,
      proposal,
      baseline: runtimeSignature(record.baseline),
    };
  }

  async trial(args, exec) {
    const agent = ownerOf(exec);
    const record = this.requireOwned(args?.experimentId, agent);
    if (record.state !== "proposed") throw new Error(`experiment ${record.id} is ${record.state}; Trial requires proposed state`);
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
      record.composition = { name: composition.name, purpose: composition.purpose, hasClient: typeof code.client === "string" && code.client.trim() !== "" };
      receipt = await this.runner.run(agent, definition.pluginId, definition.packageId, "run", exec.signal);
      if (!receipt?.ok) throw new Error(receipt?.message || `Cordis rejected Trial for ${record.id}`);
    } catch (error) {
      let rollbackResult;
      try {
        if (!record.pluginId) throw new Error("Cordis define did not return a plugin id");
        rollbackResult = await this.runner.undefine(agent, definition.pluginId);
      } catch (rollbackError) {
        rollbackResult = { ok: false, error: safeString(rollbackError?.message || rollbackError) };
      }
      record.state = "trial-failed";
      record.failure = failureLearning({
        record,
        phase: "trial",
        error,
        rollbackResult,
        nextPreventionHint: "先用 evolution_runtime_inspect 确认 Host-only 代码与 Cordis 注入，再重新定义 Trial；重复失败必须更换假设。",
      });
      await this.archive(record, "trial-failed");
      this.emitExecutionEvent("experiment-rejected", record, { status: record.state });
      this.emitExecutionEvent("failure-learned", record, { status: record.state });
      this.releaseTargets(record);
      this.experiments.delete(record.id);
      throw error;
    }
    record.state = receipt.status === "awaiting-approval" ? "trial-awaiting-approval" : "trial";
    record.trialStartedAt = now();
    record.runtime = this.inspect(agent);
    this.emitExecutionEvent("trial-completed", record, {
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

  measure(args, exec) {
    const agent = ownerOf(exec);
    const record = this.requireOwned(args?.experimentId, agent);
    if (!["trial", "trial-awaiting-approval"].includes(record.state)) throw new Error(`experiment ${record.id} is ${record.state}; Measure requires an active Trial`);
    const input = args?.observation;
    if (!input || typeof input !== "object") throw new Error("observation is required");
    if (typeof input.solvesProblem !== "boolean") throw new Error("observation.solvesProblem must be boolean");
    const observation = {
      at: now(),
      solvesProblem: input.solvesProblem,
      sideEffects: stringList(input.sideEffects || [], "observation.sideEffects", { required: false }),
      orphanResources: stringList(input.orphanResources || [], "observation.orphanResources", { required: false }),
      performanceChange: input.performanceChange === undefined ? "unchanged" : input.performanceChange,
      errorChange: input.errorChange === undefined ? "unchanged" : input.errorChange,
      metrics: isObject(input.metrics) ? input.metrics : {},
      beforeMetrics: isObject(input.beforeMetrics) ? input.beforeMetrics : undefined,
      afterMetrics: isObject(input.afterMetrics) ? input.afterMetrics : undefined,
      observationWindow: normalizeObservationWindow(input.observationWindow),
      sampleCount: Number.isInteger(input.sampleCount) && input.sampleCount > 0 ? input.sampleCount : undefined,
      benefitEvidence: optionalText(input.benefitEvidence, "observation.benefitEvidence"),
      repeatable: input.repeatable === true,
      regressionPassed: input.regressionPassed === true,
      reversible: input.reversible === true,
      cleanupEvidence: optionalText(input.cleanupEvidence, "observation.cleanupEvidence"),
    };
    record.latestObservation = observation;
    record.observations.push(observation);
    record.state = "measured";
    record.trialFrozen = true;
    record.frozenAt = now();
    record.runtime = this.inspect(agent);
    this.emitExecutionEvent("measurement-completed", record, {
      status: record.state,
      measurement: observation,
    });
    return {
      ok: true,
      experimentId: record.id,
      phase: record.state,
      observation,
      gates: promotionGates(record, { requireRuntimeRecovery: false }),
      runtime: runtimeSignature(record.runtime),
    };
  }

  async disposeTrial(record, agent) {
    let stop;
    let removed;
    const errors = [];
    try { stop = await this.runner.stop(agent, record.pluginId); } catch (error) { errors.push(`stop: ${safeString(error?.message || error)}`); stop = { ok: false, error: errors.at(-1) }; }
    try { removed = await this.runner.undefine(agent, record.pluginId); } catch (error) { errors.push(`undefine: ${safeString(error?.message || error)}`); removed = { ok: false, error: errors.at(-1) }; }
    record.dispose = { stop, removed, at: now() };
    record.runtimeAfterDispose = this.inspect(agent);
    const signatureRecovered = signatureEqual(record.trialBaseline || record.baseline, record.runtimeAfterDispose);
    record.runtimeRecovered = errors.length === 0 && stop?.ok === true && removed?.ok === true && signatureRecovered;
    record.cleanupProof = { stopOk: stop?.ok === true, removedOk: removed?.ok === true, signatureRecovered, errors, at: now() };
    record.recoveryProof = captureCurrentRecoveryProof(record);
    return { stop, removed, runtime: runtimeSignature(record.runtimeAfterDispose), recovered: record.runtimeRecovered, errors };
  }

  async revert(args, exec) {
    const agent = ownerOf(exec);
    const record = this.requireOwned(args?.experimentId, agent);
    if (!["trial", "trial-awaiting-approval", "measured"].includes(record.state)) throw new Error(`experiment ${record.id} is ${record.state}; Revert requires a Trial`);
    this.claimOperation(record, "revert");
    record.state = "reverting";
    const disposed = await this.disposeTrial(record, agent);
    record.state = disposed.recovered ? "reverted" : "revert-failed";
    if (!disposed.recovered) record.failure = failureLearning({
      record,
      phase: "revert",
      error: new Error("Cordis cleanup did not prove runtime recovery"),
      rollbackResult: { stop: disposed.stop, removed: disposed.removed, errors: disposed.errors },
      nextPreventionHint: "不要继续 Promotion；先修复 disposer/rollback 路径并重新建立基线。",
    });
    await this.archive(record, "revert");
    if (disposed.recovered) this.emitExecutionEvent("promotion-reverted", record, { status: record.state, evidence: record.cleanupProof });
    else {
      this.emitExecutionEvent("experiment-rejected", record, { status: record.state, evidence: record.cleanupProof });
      this.emitExecutionEvent("failure-learned", record, { status: record.state });
    }
    this.releaseOperation(record);
    if (disposed.recovered) this.releaseTargets(record);
    return {
      ok: disposed.recovered,
      experimentId: record.id,
      phase: record.state,
      runtimeRecovered: disposed.recovered,
      runtime: disposed.runtime,
      stop: disposed.stop,
      removed: disposed.removed,
      archive: record.archivePath,
    };
  }

  async promote(args, exec) {
    if (!this.paths.promotionRuntime) throw new Error('Evolution promotion requires an active official Include adapter; no production writes permitted');
    const agent = ownerOf(exec);
    const record = this.requireOwned(args?.experimentId, agent);
    if (record.state !== "measured") throw new Error(`experiment ${record.id} is ${record.state}; Promotion requires Measure first`);
    if (args?.confirmation !== true) {
      return {
        ok: false,
        experimentId: record.id,
        phase: "awaiting-owner-confirmation",
        reason: "explicit_user_confirmation_required_for_production_promotion",
        recommendation: "promote after reviewing the measured evidence and rollback proof",
        gates: promotionGates(record, { requireRuntimeRecovery: false }),
      };
    }
    let domainEvaluation;
    if (this.domainStorage) {
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
        return { ok: false, experimentId: record.id, phase: record.state, reason: 'domain-evaluator-rollback', domainEvaluation,
          gates: promotionGates(record, { requireRuntimeRecovery: false }) };
      }
    }
    this.claimOperation(record, "promote");
    record.state = "promotion-preparing";
    const evidenceGates = promotionGates(record, { requireRuntimeRecovery: false });
    if (!evidenceGates.eligible) {
      record.failure = failureLearning({
        record,
        phase: "promotion-gate",
        error: new Error("promotion evidence gate failed"),
        rollbackResult: record.dispose || { ok: false, status: "not-run" },
        nextPreventionHint: "补齐 benefit、repeatability、regression、reversibility、cleanup evidence；不以文本覆盖缺失证据。",
      });
      await this.archive(record, "promotion-gate");
      this.emitExecutionEvent("experiment-rejected", record, { status: record.state, evidence: evidenceGates });
      this.emitExecutionEvent("failure-learned", record, { status: record.state });
      record.state = "measured";
      this.releaseOperation(record);
      return { ok: false, experimentId: record.id, phase: record.state, reason: "promotion-gate", gates: evidenceGates };
    }
    let packageInspection;
    let packageInspectionError;
    try {
      packageInspection = this.runner.inspectPackage(agent, record.pluginId, record.packageId);
    } catch (error) {
      packageInspectionError = error;
    }
    const disposed = await this.disposeTrial(record, agent);
    if (packageInspectionError) {
      record.state = "promotion-failed";
      record.failure = failureLearning({
        record,
        phase: "promotion-inspection",
        error: packageInspectionError,
        rollbackResult: { stop: disposed.stop, removed: disposed.removed, errors: disposed.errors },
        nextPreventionHint: "先修复 Cordis Package inspection，再重新建立 Trial；不能在未读取 Host 代码时写入 durable Plugin。",
      });
      await this.archive(record, "promotion-inspection-failed");
      this.emitExecutionEvent("experiment-rejected", record, { status: record.state });
      this.emitExecutionEvent("failure-learned", record, { status: record.state });
      this.releaseOperation(record);
      if (disposed.recovered) this.releaseTargets(record);
      return { ok: false, experimentId: record.id, phase: record.state, reason: "package-inspection-failed", runtimeRecovered: disposed.recovered, archive: record.archivePath };
    }
    const gates = promotionGates(record);
    if (!disposed.recovered || !gates.eligible) {
      record.state = "revert-failed";
      record.failure = failureLearning({
        record,
        phase: "promotion-cleanup",
        error: new Error("Promotion cleanup did not prove runtime recovery"),
        rollbackResult: { stop: disposed.stop, removed: disposed.removed, errors: disposed.errors },
        nextPreventionHint: "保留 Trial 为失败学习样本；检查 Cordis disposer、event listener 和动态 Plugin 是否仍存活。",
      });
      await this.archive(record, "promotion-rejected-runtime-not-recovered");
      this.emitExecutionEvent("experiment-rejected", record, { status: record.state, evidence: gates });
      this.emitExecutionEvent("failure-learned", record, { status: record.state });
      this.releaseOperation(record);
      return { ok: false, experimentId: record.id, phase: record.state, reason: "runtime-not-recovered", runtime: disposed.runtime, gates, archive: record.archivePath };
    }
    record.state = "promoting";
    record.lastGateEvidence = { gates, evidence: evidenceGates, at: now() };
    // The durable archive describes the intended terminal state; the in-memory
    // record remains "promoting" until the journaled commit verifies.
    let durable;
    try {
      durable = await writeDurablePromotion({ experiment: record, packageInspection, paths: this.paths, canaryWindow: this.canaryWindow, lockTtlMs: this.promotionLockTtlMs });
    } catch (error) {
      record.state = "promotion-failed";
      record.failure = failureLearning({
        record,
        phase: "promotion-commit",
        error,
        rollbackResult: { ok: true, status: "journal-rollback-attempted" },
        nextPreventionHint: "检查 promotion journal、backup、原子写入和 reload/mount verify；下次调用会先恢复未完成事务。",
      });
      await this.archive(record, "promotion-failed");
      this.emitExecutionEvent("experiment-rejected", record, { status: record.state });
      this.emitExecutionEvent("failure-learned", record, { status: record.state });
      this.releaseOperation(record);
      this.releaseTargets(record);
      throw error;
    }
    record.state = "canary-observing";
    record.durable = durable;
    record.archivePath = durable.archivePath;    record.canary = { promotionTimestamp: durable.promotionTimestamp, healthObservationWindow: durable.healthObservationWindow, startupVerified: false, observations: [] };
    this.emitExecutionEvent("promotion-succeeded", record, {
      status: record.state,
      promotion: durable,
      evidence: gates,
    });
    this.releaseOperation(record);
    return {
      ok: true,
      experimentId: record.id,
      phase: record.state,
      gates,
      domainEvaluation,
      runtimeRecovered: true,
      nextSession: durable,
      canary: structuredClone(record.canary),
      rollback: `automatic until stable commit; remove composition row ${durable.rowId} and ${durable.pluginPath}, then start a new session`,
    };
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
        const claim = { schema: 1, target, experimentId: record.id, ownerId: record.ownerId, pid: process.pid, hostname: os.hostname(), acquiredAt: now() };
        let opened = false;
        for (let attempt = 0; attempt < 2 && !opened; attempt += 1) {
          try {
            const fd = fs.openSync(file, "wx", 0o600);
            try { fs.writeFileSync(fd, `${JSON.stringify(claim)}\n`); } finally { fs.closeSync(fd); }
            opened = true;
          } catch (error) {
            if (error?.code !== "EEXIST") throw error;
            let existing;
            try { existing = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error(`experiment ownership is unreadable for ${target}`); }
            if (existing.experimentId === record.id) { opened = true; break; }
            let stale = false;
            if (existing.hostname === os.hostname() && Number.isInteger(existing.pid)) {
              try { process.kill(existing.pid, 0); } catch (pidError) { stale = pidError?.code === "ESRCH"; }
            }
            if (stale && attempt === 0) { fs.rmSync(file, { force: true }); continue; }
            throw new Error(`unsafe parallel experiment conflicts on ${target} (owned by ${existing.experimentId || "unknown"})`);
          }
        }
        acquired.push({ target, file });
        this.targetOwners.set(target, record.id);
      }
    } catch (error) {
      for (const entry of acquired.reverse()) {
        this.targetOwners.delete(entry.target);
        try {
          const existing = JSON.parse(fs.readFileSync(entry.file, "utf8"));
          if (existing.experimentId === record.id) fs.rmSync(entry.file, { force: true });
        } catch {}
      }
      throw error;
    }
    record.targetsAcquired = true;
  }

  releaseTargets(record) {
    for (const target of record.targets || []) {
      if (this.targetOwners.get(target) === record.id) this.targetOwners.delete(target);
      const file = path.join(this.paths.ownershipDir, `${sha256(target)}.json`);
      try {
        const existing = JSON.parse(fs.readFileSync(file, "utf8"));
        if (existing.experimentId === record.id) fs.rmSync(file, { force: true });
      } catch (error) {
        if (error?.code !== "ENOENT") this.ctx.logger?.warn?.(`[evolution] unable to release target ownership ${target}: ${error?.message || error}`);
      }
    }
    record.targetsAcquired = false;
  }

  claimOperation(record, operation) {
    const active = this.operationClaims.get(record.id);
    if (active) throw new Error(`experiment ${record.id} is busy with ${active}`);
    this.operationClaims.set(record.id, operation);
  }

  releaseOperation(record) { this.operationClaims.delete(record.id); }

  async observeCanary(args, exec) {
    const agent = ownerOf(exec);
    const experimentId = text(args?.experimentId, "experimentId");
    let record = this.experiments.get(experimentId);
    let journal = await readCanaryJournal(this.paths);
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
    if (!record && journal?.experimentId === experimentId) {
      // Hydrate from durable sources in priority order. We never start with
      // an empty observations array or `runtimeRecovered: true` when better
      // evidence exists. The snapshot lives on the journal at promotion time,
      // as a sidecar `*.evidence.json` next to the durable archive, and as a
      // parsed view of the `exp-*.md` archive itself when no machine-readable
      // snapshot survives.
      const hydrated = {
        id: journal.experimentId,
        ownerId: journal.ownerId || agent.id,
        proposal: journal.proposal || { owner: journal.ownerId || agent.id, why: "restored canary", target: "unknown", impactScope: [], successMetrics: [], createdAt: journal.canary?.promotionTimestamp },
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
      this.experiments.set(record.id, record);
      this.acquireTargets(record);
    } else if (!record) {
      // Cross-session fallback: no in-memory record, no journal, but durable
      // snapshot exists (e.g. an older promotion whose journal has been
      // cleaned up but the archive and sidecar remain). Materialize a
      // minimum record from the durable evidence so canary observation can
      // continue without throwing.
      if (durableSnapshot) {
        const promotedFromArchive = await readPromotedIdentityFromArchive(this.paths.archiveDir, experimentId);
        record = {
          id: experimentId,
          ownerId: agent.id,
          proposal: { owner: agent.id, why: "restored canary from durable archive", target: promotedFromArchive?.target || "unknown", impactScope: [], successMetrics: [], createdAt: durableSnapshot.capturedAt || null },
          targets: [],
          state: "canary-observing",
          runtimeRecovered: durableSnapshot.runtimeRecovered === true,
          durable: promotedFromArchive || { archivePath: path.join(this.paths.archiveDir, `${experimentId}.md`), presetId: this.paths.presetId, promotionTimestamp: durableSnapshot.promotionTimestamp || durableSnapshot.capturedAt || null },
          canary: { promotionTimestamp: durableSnapshot.promotionTimestamp || durableSnapshot.capturedAt || null, healthObservationWindow: 2, startupVerified: false, observations: [] },
          observations: Array.isArray(durableSnapshot.observations) ? durableSnapshot.observations : [],
          latestObservation: durableSnapshot.latestObservation || null,
          cleanupProof: durableSnapshot.cleanupProof || null,
          recoveryProof: durableSnapshot.recoveryProof || null,
          lastGateEvidence: durableSnapshot.gateEvidence || null,
        };
        this.experiments.set(record.id, record);
      }
    } else if (record && durableSnapshot) {
      // Record is already in memory but a richer durable snapshot exists.
      // Apply monotonic merge so we never downgrade evidence that was
      // captured in earlier sessions.
      hydrateRecordFromSnapshot(record, durableSnapshot);
    }
    if (!record) throw new Error(`experiment ${experimentId} is not known in this session`);
    if (record.ownerId !== agent.id && args.startupTransition !== true) throw new Error(`experiment ${record.id} is owned by another Agent`);
    if (record.state !== "canary-observing") throw new Error(`experiment ${record.id} is ${record.state}; canary observation requires canary-observing state`);
    // Journal is now an optimization, not a hard requirement: when the
    // journal is missing but a durable snapshot exists, we continue so that
    // legitimate canary observation across a session restart is preserved.
    // The durable snapshot has already been used to hydrate record above.
    // We also synthesize a minimum in-memory journal derived from the
    // durable snapshot so the rest of observeCanary can keep its existing
    // write-journal / monotonic-merge logic intact. When the journal is
    // entirely absent, the new barriers are written into the in-memory
    // record only; they are still persisted via the sidecar finalSnapshot
    // below.
    if (!journal && durableSnapshot) {
      journal = {
        version: 1,
        phase: "canary-observing",
        experimentId: record.id,
        ownerId: record.ownerId,
        proposal: record.proposal,
        targets: record.targets || [],
        stateDir: this.paths.promotionStateDir,
        records: [],
        canary: record.canary || { promotionTimestamp: durableSnapshot.promotionTimestamp || durableSnapshot.capturedAt || null, healthObservationWindow: 2, startupVerified: false, observations: [] },
        evidenceSnapshot: durableSnapshot,
        durable: record.durable || {},
      };
    }
    if (!journal && args.startupTransition !== true) throw new Error(`canary journal and durable evidence are missing for ${record.id}`);
    if (!journal) {
      // startupTransition path: synthesize a minimum journal so the rest of
      // observeCanary still has somewhere to push canary observations.
      journal = { canary: { observations: [], startupVerified: false, healthObservationWindow: 1, promotionTimestamp: null }, stateDir: this.paths.promotionStateDir, evidenceSnapshot: null, durable: record.durable || {} };
    }
    const barrier = args?.barrier;
    if (!barrier || barrier.reached !== true || typeof barrier.id !== "string" || barrier.id.trim() === "") {
      throw new Error("canary observation requires a deterministic reached barrier id");
    }
    const observation = {
      at: now(),
      barrierId: barrier.id,
      startupVerified: args.startupVerified === true,
      componentHealth: args.componentHealth || "healthy",
      dependenciesPresent: args.dependenciesPresent !== false,
      metricRegression: args.metricRegression === true,
      metrics: compactValue(args.metrics || {}),
      evidence: compactValue(args.evidence || {}),
    };
    journal.canary.observations ||= [];
    if (!journal.canary.observations.some((entry) => entry.barrierId === observation.barrierId)) journal.canary.observations.push(observation);
    journal.canary.startupVerified ||= observation.startupVerified;
    record.canary = structuredClone(journal.canary);
    const regression = observation.metricRegression
      || observation.dependenciesPresent === false
      || !["healthy", "active", "ok"].includes(String(observation.componentHealth).toLowerCase())
      || args.startupVerified === false;
    if (regression) {
      if (this.paths.promotionRuntime && !journal.records?.length) throw new Error("Cannot roll back promotion without its authoritative journal change plan");
      await rollbackPromotionJournal(journal, this.paths);
      record.state = "rolled-back";
      record.failure = failureLearning({
        record,
        phase: "canary",
        error: new Error(observation.metricRegression ? "metric regression" : "startup/component/dependency canary regression"),
        rollbackResult: { ok: true, status: "rolled-back-to-last-known-good" },
        nextPreventionHint: "保留 canary 失败签名；重新验证 startup、component health、dependency 与 metric 后再提出新实验。",
      });
      await this.archive(record, "canary-regression");
      this.emitExecutionEvent("canary-failed", record, { status: record.state, canary: observation });
      this.emitExecutionEvent("promotion-reverted", record, { status: record.state, canary: observation });
      this.emitExecutionEvent("failure-learned", record, { status: record.state });
      this.releaseTargets(record);
      return { ok: false, experimentId: record.id, phase: record.state, rollback: "last-known-good", observation };
    }
    const complete = journal.canary.startupVerified === true
      && journal.canary.observations.length >= journal.canary.healthObservationWindow;
    if (!complete) {
      await writeJournal(path.join(journal.stateDir, "journal.json"), journal);
      return { ok: true, experimentId: record.id, phase: "canary-observing", stable: false, remaining: journal.canary.healthObservationWindow - journal.canary.observations.length, canary: structuredClone(journal.canary) };
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
    const finalSnapshot = {
      ...(stableDurableSnapshot || {}),
      version: 1,
      source: (stableDurableSnapshot?.source || "stable-commit") + "+stable-commit",
      capturedAt: now(),
      latestObservation: record.latestObservation || stableDurableSnapshot?.latestObservation || null,
      observations: record.observations?.length ? record.observations : (stableDurableSnapshot?.observations || []),
      cleanupProof: preferObject(stableDurableSnapshot?.cleanupProof, record.cleanupProof),
      recoveryProof: preferObject(stableDurableSnapshot?.recoveryProof, record.recoveryProof),
      runtimeRecovered: record.runtimeRecovered === true || stableDurableSnapshot?.runtimeRecovered === true,
      stableCommittedAt: journal.stableCommittedAt,
      gateEvidence: record.lastGateEvidence || stableDurableSnapshot?.gateEvidence || null,
      // Stable-commit must not drop promotion identity / lineage that
      // the pre-fix code path did not persist. Carry forward whatever
      // the durable sources and the hydrated record hold.
      durable: record.durable || stableDurableSnapshot?.durable || null,
      canary: record.canary || stableDurableSnapshot?.canary || null,
      ownerId: record.ownerId || stableDurableSnapshot?.ownerId || null,
      proposal: record.proposal || stableDurableSnapshot?.proposal || null,
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
    await this.archive(record, "stable-commit");
    this.emitExecutionEvent("canary-passed", record, {
      status: record.state,
      canary: journal.canary,
      promotion: record.durable,
      evidence: { stableCommittedAt: record.stableCommittedAt },
    });
    this.releaseTargets(record);
    return { ok: true, experimentId: record.id, phase: record.state, stable: true, stableCommittedAt: record.stableCommittedAt, canary: structuredClone(journal.canary) };
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
      startupTransition: true,
    }, { agent, signal: new AbortController().signal });
  }

  patternKey(input = {}) {
    return sha256(stableJson({
      type: input.type || "runtime/error",
      code: input.code || input.errorCode || input.error?.code || "unknown",
      target: input.target || input.component || input.plugin || "runtime",
      message: safeString(input.message || input.error?.message || "").toLowerCase().replace(/\b\d+\b/g, "#"),
    }));
  }

  async observeAutonomous(input = {}, exec) {
    const agent = ownerOf(exec);
    const patternKey = this.patternKey(input);
    const observations = this.patterns.get(patternKey) || [];
    const observation = { observationId: `obs-${Date.now().toString(36)}-${(++this.sequence).toString(36)}`, at: now(), patternKey, input: compactValue(input) };
    observations.push(observation);
    this.observations.push(observation);
    if (this.observations.length > 200) this.observations.splice(0, this.observations.length - 200);
    this.patterns.set(patternKey, observations.slice(-this.patternThreshold));
    const strategy = this.strategies[patternKey] || this.strategies[input.code] || this.strategies[input.errorCode];
    if (observations.length < this.patternThreshold) return { phase: "pattern-observing", patternKey, occurrences: observations.length };
    if (this.suppressedPatterns.has(patternKey)) return { phase: "suppressed", patternKey, reason: "duplicate-failure" };
    const risk = safeString(strategy?.risk || input.risk || "high").toLowerCase();
    const candidate = {
      candidateId: `candidate-${patternKey.slice(0, 12)}`,
      patternKey,
      risk,
      observationIds: observations.map((entry) => entry.observationId),
      strategy: strategy ? { target: strategy.target, idPrefix: strategy.idPrefix } : null,
      createdAt: now(),
    };
    this.candidates.set(patternKey, candidate);
    if (!strategy) return { phase: "candidate", patternKey, candidate, automatic: false, reason: "no-approved-strategy" };
    if (risk === "high" || this.autonomousPolicy.high === "deny" && risk === "high") {
      return { phase: "blocked-high-risk", patternKey, candidate, automatic: false };
    }
    if (risk === "medium" || this.autonomousPolicy[risk] === "confirm") {
      return { phase: "candidate-awaiting-confirmation", patternKey, candidate, automatic: false, reason: "confirmation-required" };
    }
    if (risk !== "low" || this.autonomousPolicy.low !== "experiment") {
      return { phase: "candidate", patternKey, candidate, automatic: false, reason: "policy-blocked" };
    }
    const failureSignature = this.memory.signature({ problem: input.message || input.code, experiment: { patternKey }, result: "autonomous-failure", prevention: "suppress duplicate" });
    if (this.memory.hasActiveSignature(failureSignature)) {
      this.suppressedPatterns.add(patternKey);
      return { phase: "suppressed", patternKey, reason: "failure-memory" };
    }
    if (this.prepareRuntime) await this.prepareRuntime(agent, exec.signal);
    const proposed = this.propose({
      why: input.message || `autonomous pattern ${patternKey}`,
      target: strategy.target || `plugin:${strategy.composition?.name || patternKey.slice(0, 12)}`,
      targets: strategy.targets,
      impactScope: strategy.impactScope || ["runtime"],
      successMetrics: strategy.successMetrics || ["error rate decreases"],
      risk,
    }, exec);
    try {
      await this.trial({ experimentId: proposed.experimentId, idPrefix: strategy.idPrefix, composition: strategy.composition }, exec);
      const measured = typeof strategy.measure === "function" ? await strategy.measure({ input, observations: structuredClone(observations) }) : strategy.observation;
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
      if (this.mode !== "autonomous" || !this.unattended) {
        return {
          phase: "candidate-awaiting-confirmation",
          patternKey,
          experimentId: proposed.experimentId,
          candidate,
          gates,
          recommendation,
          automatic: false,
        };
      }
      // Even an explicitly configured autonomous observer may not turn its
      // own observation into production approval.  Keep the candidate in the
      // measured state and return the same owner-confirmation recommendation.
      return {
        phase: "candidate-awaiting-confirmation",
        patternKey,
        experimentId: proposed.experimentId,
        candidate,
        gates,
        recommendation,
        automatic: false,
      };
    } catch (error) {
      this.suppressedPatterns.add(patternKey);
      this.memory.record({
        signature: failureSignature,
        problem: input.message || input.code || "autonomous failure",
        evidence: input,
        experiment: { patternKey, target: strategy.target },
        result: { state: "failed", category: failureCategory(error, "autonomous"), error: safeString(error?.message || error) },
        prevention: "suppress duplicate autonomous failure until a new strategy or explicit retry is supplied",
      });
      return { phase: /regression/i.test(error?.message || "") ? "rolled-back-regression" : "rolled-back-no-improvement", patternKey, error: safeString(error?.message || error) };
    }
  }

  requireOwned(id, agent) {
    const experimentId = text(id, "experimentId");
    const record = this.experiments.get(experimentId);
    if (!record) throw new Error(`experiment ${experimentId} is not known in this session`);
    if (record.ownerId !== agent.id) throw new Error(`experiment ${experimentId} is owned by another Agent`);
    return record;
  }

  async archive(record, reason) {
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
    const cleanupMerged = preferObject(durableSnapshot?.cleanupProof, record.cleanupProof);
    const recoveryMerged = preferObject(durableSnapshot?.recoveryProof, record.recoveryProof) || cleanupMerged;
    const recoveredMerged = (record.runtimeRecovered === true) || (durableSnapshot?.runtimeRecovered === true);
    const memory = this.memory.record({
      problem: record.proposal.why,
      evidence: latestMerged || observationsMerged.at(-1) || {},
      experiment: {
        id: record.id,
        target: record.proposal.target,
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
      `- owner: ${record.proposal.owner}`,
      `- created: ${record.proposal.createdAt}`,
      `- source package: ${record.pluginId || "none"}/${record.packageId || "none"}`,
      "",
      "## Proposal",
      `- why: ${record.proposal.why}`,
      `- target: ${record.proposal.target}`,
      `- impact: ${record.proposal.impactScope.join(", ")}`,
      `- success metrics: ${record.proposal.successMetrics.join("; ")}`,
      "",
      "## Observations",
      "```json",
      JSON.stringify(observationsMerged, null, 2),
      "```",
      "",
      "## Latest measurement",
      "```json",
      JSON.stringify(latestMerged, null, 2),
      "```",
      "",
      "## Runtime recovery",
      `- recovered: ${recoveredMerged}`,
      `- proof: ${JSON.stringify(recoveryMerged || { status: recoveredMerged ? "recovered" : "unknown" })}`,
      "",
      "## Failure learning",
      "```json",
      JSON.stringify(record.failure || { status: "none" }, null, 2),
      "```",
      "",
      "## Memory lifecycle",
      `- signature: ${record.memorySignature}`,
      `- duplicate count: ${memory.entry.count}`,
      `- retention: bounded to ${this.memory.maxEntries} compact records`,
      "",
    ].join("\n");
    await writeAtomic(file, content);
    record.archivePath = file;
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
