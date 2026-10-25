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
import { syncFile } from "./archive-stage.js";
import { fiberIsActive, serviceImpl, serviceImplSource } from "./cordis-compat.js";
import { collectFailureMemoryExperience, finalizeExperienceRecall } from "./experience-recall.js";

// The append lock writes its owner token with the writer that existed when this
// module loaded: a test (or a host) that replaces `fs.writeSync` to inject a
// short data write must not be able to stall the lock's own bookkeeping.
const rawWriteSync = fs.writeSync;

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

// Last line of defence for free text that reaches a durable record. It is not
// the credential boundary itself: `safeErrorDto` never keeps the raw message,
// and every string copied into a durable record runs through this shape list.
// There is exactly one implementation of this rule: `safeErrorDto`'s summary,
// `compactValue`'s string branch, `safeErrorEvidence`, the event bridge payload,
// the failure memory and the archive renderer all call `redactCredentialShapes`.
// That single entry point is also the single place where the rule is *bounded
// and non-throwing*: text above `REDACTION_TEXT_BOUND` is withheld instead of
// scanned, and any rule failure yields the same marker rather than an exception
// or a fallback to the original text. Those two properties belong to the entry
// point, not to the callers, because a caller that forgets them turns a
// redaction failure into a failed cleanup path (see the bound's definition).
//
// Covered shapes. Every assignment rule accepts `:` or `=`, any spacing, an
// optionally quoted key (single or double, with or without the backslash escape
// a JSON body has when it is embedded inside another JSON string), and works
// case-insensitively, so `apiKey`, `API_KEY`, `api-key` and `db_password` all
// count:
//   password=hunter2, api_key: review-key, admin_token=x
//   "password":"x", "api_key": "x", 'token':'x', password: "x", token='x'
//   {"password":"x"} and the escaped form {\"password\":\"x\"}
//   {"credentials":{"value":"x"}} and "api_keys":["x"]  (container replaced)
//   scheme://user:secret@host (removed structurally, not per vendor)
//   sk-/ghp_/xox*- vendor tokens, AWS key ids, `Bearer <token>`
//   <credential key>[:=] followed by the whole remainder of the text, for any key
//   in `CREDENTIAL_KEY` — which includes every auth-header value (`Bearer`,
//   `Basic`, `Digest`, `AWS4-HMAC-SHA256`, an unknown vendor scheme), because the
//   assignment rule claims the whole remainder instead of the prefix a scheme's
//   own grammar would declare, and instead of any structural end
//
// NOT covered, deliberately and by construction: binary or non-UTF8 payloads;
// a secret split across fields or concatenated at runtime; a base64, hex or
// URL-encoded secret (encoding removes the shape being matched); a secret with
// no label from `CREDENTIAL_KEY` (an unlabelled high-entropy string is a
// secret-detection problem, not this boundary); and any key spelling absent from
// `CREDENTIAL_KEY`. A quote, a bracket, a comma and a quoted sibling key are all
// gone after a credential assignment, because none of them ends a value any more.
// Matching is biased to over-match: a mangled summary is acceptable,
// a leaked credential is not, so the remainder of the text goes with the value.
//
// A credential-key hit IS an unconditional whole-value redaction: no inner
// grammar ends the value early. That is the fix for the ninth review's auth
// continuation leak. The rule used to also carry a scheme-grammar layer
// (`AUTH_SCHEME`/`AUTH_PARAM`/`AUTH_OPAQUE`) that recognised `Bearer`, `Digest`,
// `AWS4-HMAC-SHA256`, … and stopped at the boundary the scheme's own grammar
// declares — one opaque token, or one `name=value` parameter list. Everything the
// peer actually sent past that boundary stayed in plaintext, and the bare-value
// branch could not re-match it because the value already read `[redacted]`:
//
//   Authorization: Bearer aa <secret>        -> Authorization: [redacted] <secret>
//   X-Auth-Token: Bearer aa <secret>         -> X-Auth-Token: [redacted] <secret>
//   Authorization: Bearer aa\"<secret>\"bb    -> Authorization: [redacted]\"<secret>\"bb
//   Authorization: AWS4-… Signature=<secret> -> Authorization: [redacted] Signature=<secret>
//
// That layer is gone rather than widened: a list of scheme names is an
// enumeration, and every such list is wrong for the next vendor. Every keyed
// value now takes the same whole-value path, which is why
// `token: X-Custom-Scheme <material>` and `Authorization: Bearer aa <material>`
// are redacted by the same rule.
//
// The accepted trade-off, asserted by the tests: prose that follows an auth
// header is redacted with it (`Authorization: Bearer abc123 and the host was
// unreachable` -> `Authorization: [redacted]`). Keeping a diagnostic detail must
// never cost a credential. What survives is the key name, the failure category
// and the digest.
//
// Two things JSON stringification does to a shape this table already matched,
// both handled here by bounded escape recognition instead of being left to
// leak. A message that reached a durable record through `JSON.stringify` (the
// bridge payload, the archive JSON, an evidence DTO) has its whitespace and
// quotes escaped, and each extra layer doubles the backslashes:
//
//  - Logical whitespace. A newline is `\n` after one layer, `\\n` after two and
//    `\\\\n` after three, so the spacing between a key and its separator, or
//    between a key and its material, is either real
//    space/tab/newline/carriage-return or 1..15 backslashes plus the escape
//    letter (1, 2, 4 and 8 for the first four layers; the extra headroom is
//    free). `ESCAPED_WS` is that escape form and `WS_RUN` is the logical
//    whitespace run.
//  - Logical quotes. The same doubling applies to `"`/`'`: 1, 3, 7 and 15
//    backslashes for the first four layers, so `\\{0,15}` covers a bare quote
//    and its first four escaped forms. `QUOTED` is only the quoted *key* prefix
//    now: the value rule re-emits nothing but the assignment prefix, so a value's
//    own quotes (escaped or not) are discarded with the rest of the remainder
//    instead of being closed again.
//
// The bound is four layers, not three: a payload can carry an escape sequence of
// its own *and* be stringified again, so two escaped newlines inside one layer of
// wrapper is a four-layer form of the same shape. Neither bound is a general
// JSON parser: more than four layers, and escapes other than
// `\n`/`\r`/`\t`/`\v`/`\f`, are outside what this recognises.
const ESCAPED_WS = String.raw`\\{1,15}[nrtvf]`;
const WS_RUN = String.raw`(?:[ \t\n\r\v\f]|${ESCAPED_WS})*`;
const QUOTED = String.raw`\\{0,15}["']`;
// One list of key spellings, used by two boundaries: the assignment rule below
// (a key and its value inside one string) and `isCredentialKeyName` (a key and
// its value already separated as an object property). The separator class is
// `[._-]`, so `api_key`, `api-key` and `api.key` are the same spelling.
const CREDENTIAL_KEY = [
  String.raw`password`, String.raw`passwd`, String.raw`passphrase`, String.raw`pwd`,
  String.raw`secret`, String.raw`client[._-]?secret`,
  String.raw`secret[._-]?(?:access[._-]?)?key`,
  String.raw`token`, String.raw`access[._-]?(?:key|token)`, String.raw`refresh[._-]?token`, String.raw`id[._-]?token`,
  String.raw`auth(?:orization)?[._-]?token`, String.raw`authorization`,
  String.raw`api[._-]?key`, String.raw`x[._-]?api[._-]?key`, String.raw`private[._-]?key`,
  String.raw`credential(?:s|[._-]?ref)?`,
  String.raw`session[._-]?(?:id|key|token)`, String.raw`cookie`,
].join("|");
// The lookbehind replaces `\b` so `db_password`/`X_API_KEY` are recognised while
// `mytoken` is not; the trailing guard accepts `tokens` but not `tokenizer`.
const CREDENTIAL_ASSIGNMENT = String.raw`(?<![A-Za-z0-9])((?:${QUOTED})?(?:${CREDENTIAL_KEY})s?(?![A-Za-z0-9])(?:${QUOTED})?${WS_RUN}[:=]${WS_RUN})`;
// The same family as a *whole-key* predicate, derived from the one list above so
// no spelling is maintained twice. `compactValue` needs it because a structured
// record has already separated the key from the value: `{access_token: "…"}` is
// one property, and no text rule can match across that boundary. Normalizing the
// key (lowercase, non-alphanumerics removed) is what makes the predicate
// spelling-independent; the whole name and every word inside it are tested,
// because normalization removes the separators the text rule's lookbehind used to
// allow, so `db_password`, `X_API_KEY` and `apiKey` must all be recognised.
const CREDENTIAL_KEY_FAMILY = String.raw`(?:${CREDENTIAL_KEY})s?$`;
// The whole-key form: the family fragment anchored at both ends.
const CREDENTIAL_KEY_NAME = new RegExp(`^${CREDENTIAL_KEY_FAMILY}`);
// The same list as a *suffix* predicate, and the reason it exists: whole-name
// matching normalized `db_api_key` to `dbapikey`, which is neither the whole name
// nor one of its words, so the structured boundary was weaker than the text one
// while the text rule matched `api[-_]?key` *inside* `db_api_key`. A normalized
// key that ends with a credential spelling is therefore a credential key whatever
// precedes it — the same prefix tolerance the text rule's lookbehind already has
// (`db_password`, `X_API_KEY`) — so `dbapikey`, `serviceaccesskey`,
// `xgoogapikey` and `vendorprivatekey` are redacted by both boundaries instead of
// only by the text one. The keys that must stay readable still do: `note`,
// `value`, `reason`, `status`, `latency`, `errors`, `successRate` and `tokenizer`
// end in none of these spellings (`tokenizer` does not end in `token`).
const CREDENTIAL_KEY_SUFFIX = new RegExp(CREDENTIAL_KEY_FAMILY);

function isCredentialKeyName(key) {
  // Fail closed: a key this cannot decide is redacted, not passed through.
  if (typeof key !== "string") return true;
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  // A key with no alphanumeric character at all (`"___"`) decides nothing.
  if (normalized === "") return true;
  if (CREDENTIAL_KEY_NAME.test(normalized)) return true;
  if (CREDENTIAL_KEY_SUFFIX.test(normalized)) return true;
  return key
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .some((part) => part !== "" && CREDENTIAL_KEY_NAME.test(part.toLowerCase()));
}
// The value rule, and the whole of it: once a credential key and its separator
// have matched, the value is the remainder of the text. There is no structural
// end, no quote pairing, no container balancing and no first-character
// restriction, because each of those was a separate way to stop early and leave
// material behind. Three review rounds found three of them in a row:
//
//   password=x]Q7v9...      -> password=[redacted]]Q7v9...      (bracket end)
//   password=x}"Q7v9..."    -> password=[redacted]}"Q7v9..."    (container + quote)
//   password=x];"Q7v9..."   -> password=[redacted]];"Q7v9..."   (both)
//
// The concept behind all three — "find the structural end of the value so sibling
// JSON fields survive" — is the defect, not any one boundary. It is removed
// rather than widened, which also removes the branches and constants that existed
// only to serve it (`QUOTED_RUN`, `STRUCTURAL_VALUE_END`, `VALUE_TAIL`,
// `BARE_VALUE`, `DOUBLE_QUOTED_VALUE`, `SINGLE_QUOTED_VALUE`,
// `UNTERMINATED_QUOTED_VALUE`, `CONTAINER_VALUE`). The pattern surface is smaller
// than before, and nothing of a value can leak because nothing of it is kept: the
// replacement is the assignment prefix plus the marker.
//
// The accepted costs, asserted by the tests. They are diagnostic losses,
// deliberately traded for a boundary that cannot truncate:
//   - `{"password":"x","retry":3}` renders as `{"password":[redacted]`: the
//     closing quote, the comma and every sibling field after a credential key are
//     gone, and the fragment is not valid JSON on its own (it stays safe as an
//     embedded string);
//   - any text after a credential assignment on any later line is gone too, which
//     was already true for multi-line messages.
// What survives is what a record needs to be diagnosable: the key name, the
// failure category and the digest.
const CREDENTIAL_VALUE_PATTERN = new RegExp(String.raw`${CREDENTIAL_ASSIGNMENT}[\s\S]*`, "gi");

const CREDENTIAL_TEXT_PATTERNS = [
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@"],
  // Group 1 is the assignment prefix — the credential key, its separator and the
  // logical whitespace around either. The replacement keeps exactly that and
  // appends the marker, so no byte of the value can survive: there is no capture
  // group for an opening quote, because the value is not parsed at all.
  [CREDENTIAL_VALUE_PATTERN, "$1[redacted]"],
  [/\b(?:sk-|gh[pousr]_|xox[abprs]-)[A-Za-z0-9_-]{8,}\b/g, "[redacted]"],
  [/\b(?:AKIA|ASIA|AIDA|ABIA|ACCA|AGPA|ANPA|ANVA|AIPA)[A-Z0-9]{8,}\b/g, "[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "Bearer [redacted]"],
];

// The bound on the free text this boundary will scan, and the marker that
// replaces text above it. Both are part of the same rule, not two knobs:
//
// Why a bound at all. The rule table above is a set of regular expressions over
// user-controlled text, and `redactCredentialShapes` below is the single place
// that runs all of them. A pathological input (the sixth review used an 8 MiB run
// of `\\x` inside an unterminated quoted parameter, 8,388,608 characters) makes
// V8's backtracking matcher exhaust the stack and throw `RangeError: Maximum
// call stack size exceeded`. A scrubber that throws is worse than one that
// withholds: the throw left `failureLearning()` before the `try/finally` that
// releases the Trial's target lock, so a redaction failure became a leaked lock
// and a retained experiment record.
//
// Why 64 KiB, and what it costs. The bound is not free, and it is not a no-op for
// durable text: it changes what a durable field *keeps* at the boundary. At or
// below the bound, `redactCredentialShapes` returns redacted text and the caller's
// own truncation still applies, so a 65,536-character message still yields its
// first `ERROR_SUMMARY_MAX` (240) or `maxText` (1200) characters — after
// redaction — in a failure DTO, an archive field or a journal proposal. At 65,537
// characters and above the same field becomes `withheldTextMarker(length)`
// instead: the marker is shorter than any caller truncation, so those first 240 /
// 1200 characters are simply gone. That is a real loss of persistent information
// for text above the bound, accepted in exchange for the property below, not an
// absence of cost.
//
// Why exactly this value. 64 KiB is two orders of magnitude above what any
// durable field keeps and far above the error, journal and proof strings this
// boundary sees, so the loss above lands on text that would have been truncated
// to 240 / 1200 characters anyway. It is also the bound
// that keeps the *worst measured* rule cost small: the backslash-run shape is
// quadratic in the scan length (measured 11.5 ms at 65 KiB, 401 ms at 2 MiB), so
// 64 KiB caps it near 12 ms while 256 KiB would already be ~180 ms. Anything
// longer is a payload, not a message, and the marker says so without carrying a
// byte of it.
const REDACTION_TEXT_BOUND = 64 * 1024;
// Bounded, fail-closed placeholder. It carries the original length, so a record
// still shows how much was withheld, and nothing else. It is deliberately *not*
// a truncation of the original: cutting the text keeps the first characters of
// the credential it starts with (`token: VendorV3 a="<cut here>`), which is the
// leak this design rules out in both directions. It keeps the `[redacted]`
// marker a reader and the tests already look for, so "the text was redacted" and
// "the text was withheld unscanned" are both visible instead of the latter
// looking like an untouched field.
const withheldTextMarker = (length) => `[redacted] [message withheld: ${length} characters]`;

function redactCredentialShapes(value) {
  let text;
  // Even the coercion is fail-closed: a hostile `toString` must not turn a
  // scrubber into a thrower.
  try { text = typeof value === "string" ? value : String(value); } catch { return withheldTextMarker(0); }
  const length = text.length;
  if (length > REDACTION_TEXT_BOUND) return withheldTextMarker(length);
  // A rule's replacement is either a string or a function; both are handled the
  // same way by `String.prototype.replace`, so this stays one rule list.
  try {
    for (const [pattern, replacement] of CREDENTIAL_TEXT_PATTERNS) text = text.replace(pattern, replacement);
  } catch {
    // Fail closed on any rule failure: the marker replaces the text, never the
    // text itself and never a truncation of it, and a partially redacted buffer
    // does not survive either.
    return withheldTextMarker(length);
  }
  return text;
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
  // Holes and undefined must not serialize like a missing or null value.
  if (Array.isArray(value)) return `[${Array.from(value, (item) => stableJson(item, depth + 1)).join(",")}]`;
  if (value === undefined) return '"[undefined]"';
  // Numbers JSON cannot round-trip must not share a serialization: 1e400 and
  // -1e400 both stringify to null, and -0 to 0, which would merge records.
  if (typeof value === "number" && !Number.isFinite(value)) return JSON.stringify(String(value));
  if (typeof value === "number" && Object.is(value, -0)) return JSON.stringify("-0");
  if (!isObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key], depth + 1)}`).join(",")}}`;
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

// The single error -> safe DTO boundary. What leaves this function is the
// error code, the failure category, an irreversible digest and a bounded,
// credential-redacted summary; the raw message never leaves it. Everything that
// persists an error (failure learning, the archive, the event bridge, the
// observation stream feeding inspect) reads its fields from here instead of
// copying `error.message`.
//
// It never throws and never returns unbounded text, for any input. `errorDigest`
// and `errorLength` are still computed on the whole raw message, so a withheld
// summary is identifiable and comparable; only the summary is replaced.
//
// Total, not merely guarded. Reading a property is as able to throw as converting
// one (`error.message` may be a getter; `String(value)` runs a hostile
// `toString`/`Symbol.toPrimitive`), so `readErrorField`/`coerceErrorText` wrap the
// read *and* the conversion, and the reads the DTO needs are the only reads it
// performs — `name` and `stack` are never touched, so a throwing getter on either
// cannot reach it. When a read or a conversion does throw, the DTO does not
// degrade field by field and it does not throw: it becomes `degradedErrorDto()`,
// which carries no text of the error at all. A half-read message would be a claim
// about text the boundary only partly attributed, which is worse than saying so.
const ERROR_SUMMARY_MAX = 240;
// The fixed DTO for an error that could not be read. Every field is a literal,
// and the key set is the same five keys the readable path returns, because
// callers (`safeErrorEvidence`, the archive renderer, `registration.js`) rely on
// those keys existing. `errorCategory` is `DEGRADED_ERROR_CATEGORY` rather than a
// phase-derived guess — a category is a claim about a message nobody read.
// `errorDigest` is deliberately *not* digest-shaped (`sha256:` plus exactly 16
// hex characters is the readable form), so no reader can confuse the placeholder
// with the digest of a real message, while the value stays stable and
// deterministic. `errorLength: 0` says no text was measured.
const DEGRADED_ERROR_CATEGORY = "unclassified";
const DEGRADED_ERROR_DIGEST = "sha256:unavailable";
const DEGRADED_ERROR_SUMMARY = "[error details unavailable: the error object could not be read]";
const degradedErrorDto = () => ({
  errorCode: null,
  errorCategory: DEGRADED_ERROR_CATEGORY,
  errorDigest: DEGRADED_ERROR_DIGEST,
  errorSummary: DEGRADED_ERROR_SUMMARY,
  errorLength: 0,
});

// The unreadable signal. A sentinel instead of `undefined`/`null`, so "the read
// threw" cannot be confused with "the property is absent" (which has a defined,
// non-degraded meaning for `message`).
const ERROR_FIELD_UNREADABLE = Symbol("evolution.error-field-unreadable");

function readErrorField(error, key) {
  try { return error?.[key]; } catch { return ERROR_FIELD_UNREADABLE; }
}

function coerceErrorText(value) {
  try {
    if (typeof value === "string") return value;
    if (value === undefined || value === null) return "";
    return String(value);
  } catch { return ERROR_FIELD_UNREADABLE; }
}

// The classification is a keyword scan over at most the first 4 KiB, and that
// bound is a loss of *precision*, not a semantic no-op: a message whose only
// `regression`, `repeat`, `permission`, `syntax`, `journal` or `cleanup` keyword
// appears after character 4,095 is classified by its phase and by whatever
// keywords do precede the bound, so it can land on `runtime-trial` while an
// unbounded scan would have said `regression`. The bound is kept because the
// scan must not become one more unbounded rule family over untrusted text, and
// because the messages this boundary sees state their nature far inside 4 KiB:
// a keyword behind a payload that large is already an unusual shape (the
// tests pin both sides of the cut, not a claim that no such message exists).
const ERROR_CATEGORY_TEXT_BOUND = 4 * 1024;

// `JSON.parse` failures are user-facing diagnostics, and V8 embeds a quoted
// excerpt of the input in the message for token-level failures:
//
//   Unexpected token 'U', "{"a":USER_PRIVATE}" is not valid JSON
//
// That excerpt is the content of a durable file - memory, journal, event bridge,
// domain aggregate - so it may contain credentials or user data. Every site that
// turns a parse failure into a log line, warning or evidence field crosses this
// boundary first: the excerpt is replaced, the structural part of the message
// (and its position) is kept so the failure stays diagnosable.
const JSON_PARSE_FAILURE_SUFFIX = "is not valid JSON";

/** Project a parse-failure message so it never carries the parsed bytes. */
export function redactJsonParseMessage(message) {
  const text = typeof message === "string" ? message : String(message ?? "");
  // V8 appends `, "<excerpt>"... is not valid JSON` to token-level failures.
  // This walks the message once instead of matching it with a regular expression
  // whose repetition could be made quadratic by a long input; the excerpt (and
  // the ellipsis V8 adds when it truncated it) is dropped, the structure kept.
  const suffixAt = text.lastIndexOf(JSON_PARSE_FAILURE_SUFFIX);
  if (suffixAt >= 0) {
    const quoteAt = text.indexOf('"');
    if (quoteAt >= 0 && quoteAt < suffixAt) {
      let end = quoteAt;
      while (end > 0) {
        const code = text.charCodeAt(end - 1);
        if (code === 0x2c || code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) end -= 1;
        else break;
      }
      const projected = `${text.slice(0, end)} ${JSON_PARSE_FAILURE_SUFFIX}`;
      return projected.trim() === "" ? "invalid JSON" : projected;
    }
  }
  return text.trim() === "" ? "invalid JSON" : text;
}

export function safeErrorDto(error, phase = "runtime") {
  // `phase` is compared with `String.prototype.includes`, so a non-string phase
  // (a hand-written durable record can carry one) would be a `TypeError` inside
  // the boundary rather than a classification.
  const phaseText = typeof phase === "string" ? phase : "runtime";
  const fromString = typeof error === "string";
  // `error?.message ?? error ?? ""`: a message of `null`/`undefined` falls back to
  // the thrown value itself, exactly as before; only the reads and the coercions
  // are new.
  const message = fromString ? error : readErrorField(error, "message");
  if (message === ERROR_FIELD_UNREADABLE) return degradedErrorDto();
  const subject = fromString || (message !== undefined && message !== null) ? message : error;
  const raw = coerceErrorText(subject);
  if (raw === ERROR_FIELD_UNREADABLE) return degradedErrorDto();
  const codeValue = fromString ? "" : readErrorField(error, "code");
  if (codeValue === ERROR_FIELD_UNREADABLE) return degradedErrorDto();
  const code = coerceErrorText(codeValue ?? "");
  if (code === ERROR_FIELD_UNREADABLE) return degradedErrorDto();
  const categoryText = raw.length > ERROR_CATEGORY_TEXT_BOUND ? raw.slice(0, ERROR_CATEGORY_TEXT_BOUND) : raw;
  return {
    errorCode: code ? redactCredentialShapes(code).slice(0, 64) : null,
    errorCategory: failureCategory({ message: categoryText }, phaseText),
    errorDigest: `sha256:${sha256(raw).slice(0, 16)}`,
    errorSummary: redactCredentialShapes(raw).slice(0, ERROR_SUMMARY_MAX) || "unknown error",
    errorLength: raw.length,
  };
}

const ERROR_TEXT_KEY = /^(?:error|errors|message|reason|detail)$/i;

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
    trustedWriters = new Set(options?.trustedWriters || [EVENT_BRIDGE_DEFAULT_WRITER]);
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
      ...(journalSnapshot ? [{ ...journalSnapshot, canary }] : []),
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
export function renderExperimentArchive({ id, state, reason, proposal, pluginId, packageId, observations, latestMeasurement, recoveryProof, recovered, failure, memorySignature, duplicateCount, retention, canary }) {
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
      const backup = await fsp.readFile(path.join(journal.stateDir, "backups", record.backup));
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
    await writeAtomic(modulePath, packageSource(hostCode, pluginName), { durable: true });
    await writeAtomic(packageJsonPath, JSON.stringify({
      name: pluginName,
      version: "0.1.0",
      private: true,
      type: "module",
      main: "lib/index.js",
      files: ["lib"],
    }, null, 2) + "\n", { durable: true });
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
const EVENT_BRIDGE_LOCK_STALE_MS = 2000;
const EVENT_BRIDGE_LOCK_RETRY_MS = 5;
// Wait at most 500 ms for a live writer, which is far longer than one append and
// far shorter than the stale window: a live writer always releases first, and a
// crashed writer's marker becomes reclaimable after the window instead of
// blocking this call for its whole length.
const EVENT_BRIDGE_LOCK_ATTEMPTS = 100;
const eventBridgeLockTick = new Int32Array(new SharedArrayBuffer(4));

function eventBridgeLockOwner(lockPath) {
  try { return fs.readFileSync(path.join(lockPath, "owner"), "utf8").trim(); } catch { return null; }
}

/**
 * Serialize appends across processes. A single `write(2)` with O_APPEND is
 * atomic for a regular file, but this writer verifies the tail and may resume a
 * short write in several calls; two writers doing that at once can interleave
 * one record's bytes with another's and split both into unparseable lines.
 *
 * The lock is a directory carrying an owner token, and it is only ever removed
 * through an atomic rename: the entry that moves into the quarantine path is
 * exactly the entry that was judged, so a lock created in between is either not
 * moved or is moved back. Deleting by path (the first version did that) let a
 * reclaimer remove a fresh lock that had replaced the stale one, and let a slow
 * writer remove the lock of whoever had reclaimed it.
 */
function acquireEventBridgeAppendLock(lockPath) {
  const token = crypto.randomUUID();
  for (let attempt = 0; attempt < EVENT_BRIDGE_LOCK_ATTEMPTS; attempt += 1) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let held;
      try { held = fs.statSync(lockPath); } catch { continue; }
      if (Date.now() - held.mtimeMs > EVENT_BRIDGE_LOCK_STALE_MS) {
        const quarantine = `${lockPath}.${process.pid}-${token}.stale`;
        try { fs.renameSync(lockPath, quarantine); } catch { continue; }
        let moved;
        try { moved = fs.statSync(quarantine); } catch { continue; }
        if (Date.now() - moved.mtimeMs > EVENT_BRIDGE_LOCK_STALE_MS) {
          fs.rmSync(quarantine, { recursive: true, force: true });
          continue;
        }
        // The entry that moved is not the stale one this call judged (a fresh
        // owner took the path after the stat): put it back, never delete it.
        try { fs.renameSync(quarantine, lockPath); } catch (error) {
          throw new Error(`Evolution execution event bridge append lock was replaced and could not be restored from ${quarantine}: ${error.message}`);
        }
        continue;
      }
      Atomics.wait(eventBridgeLockTick, 0, 0, EVENT_BRIDGE_LOCK_RETRY_MS);
      continue;
    }
    const ownerPath = path.join(lockPath, "owner");
    let ownerFd;
    try {
      ownerFd = fs.openSync(ownerPath, "wx", 0o600);
      const bytes = Buffer.from(token, "utf8");
      let offset = 0;
      while (offset < bytes.length) {
        const written = rawWriteSync(ownerFd, bytes, offset, bytes.length - offset);
        if (!Number.isInteger(written) || written <= 0) {
          throw new Error("Evolution execution event bridge append lock could not write its owner token");
        }
        offset += written;
      }
      return token;
    } catch (error) {
      try { if (ownerFd !== undefined) fs.closeSync(ownerFd); } catch { /* closed below or never opened */ }
      ownerFd = undefined;
      // This call created the directory and no other owner can have written into
      // it; remove exactly what this call made and report the real failure.
      try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* stale-reclaimed later */ }
      throw error;
    } finally {
      try { if (ownerFd !== undefined) fs.closeSync(ownerFd); } catch { /* already closed */ }
    }
  }
  throw new Error("Evolution execution event bridge append lock is held by another writer; refusing to interleave a record");
}

/** Release only the lock that still carries this call's token. */
function releaseEventBridgeAppendLock(lockPath, token) {
  const quarantine = `${lockPath}.${process.pid}-${token}.release`;
  try { fs.renameSync(lockPath, quarantine); } catch { return; }
  let owner = null;
  try { owner = fs.readFileSync(path.join(quarantine, "owner"), "utf8").trim(); } catch { /* unreadable */ }
  if (owner === token) {
    fs.rmSync(quarantine, { recursive: true, force: true });
    return;
  }
  // Not ours (another writer reclaimed the stale entry and created a new lock):
  // restore it instead of deleting the new owner's marker.
  try { fs.renameSync(quarantine, lockPath); } catch (error) {
    throw new Error(`Evolution execution event bridge append lock was reclaimed and could not be restored from ${quarantine}: ${error.message}`);
  }
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
  constructor({ file, key = process.env.DSH_EVOLUTION_EVENT_BRIDGE_KEY, writer = EVENT_BRIDGE_DEFAULT_WRITER } = {}) {
    this.file = file;
    this.key = key;
    this.writer = writer;
    this.seen = new Set();
    this.sequence = 0;
    this.pending = null;
    if (this.file) {
      try {
        for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const stored = JSON.parse(line);
            const verified = verifyEventBridgeEnvelope(stored, this.key);
            // A valid MAC alone does not make a record this installation's own:
            // a foreign writer's eventId must not occupy a dedup slot, or the
            // trusted event carrying it would be silently skipped. The sequence
            // and the dedup slot stay behind the same gate.
            if (!eventBridgeWriterTrusted(verified, this.writer)) continue;
            this.sequence = Math.max(this.sequence, verified.sequence);
            if (typeof verified.event?.eventId === "string") this.seen.add(verified.event.eventId);
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
      // An explicit payload measurement is projected here too. `measure()`
      // already projects the observation it emits, but `project()` is a public
      // boundary and a caller can hand it an unprojected object; the boundary is
      // the place that decides, not the caller (this is the same `compactValue`
      // row projection the record-derived branch has always used).
      measurement: payload.measurement === undefined || payload.measurement === null
        ? (record.latestObservation ? compactValue(record.latestObservation) : null)
        : compactValue(payload.measurement),
      failureFingerprint: payload.failureFingerprint ?? executionFailureFingerprint(record),
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
          pending.start = end;
          pending.identity = identity;
          // A crash can leave a complete, already-signed record without its
          // trailing newline. Replay accepts that shape as a valid remainder, so
          // appending straight onto it would glue two records into one line that
          // no later replay can parse, and the next startup would refuse the log.
          // Finish the separator as part of this append: the prefix verification
          // below covers it too, and a crash after it leaves at most an empty
          // line, which replay skips. An unterminated tail that does not verify
          // is a torn record: the append is refused so the tail stays the one
          // unterminated line the doctor's trim repair can still identify.
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
              pending.line = Buffer.concat([Buffer.from("\n", "utf8"), pending.line]);
            }
          }
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
 * cannot disagree about what a claim file means (AGENTS.md §4.1: never a second
 * protocol on the same path).
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
    // On-demand experience recall for the explicit evolution path. It is off
    // only when an owner disables it; it never starts a timer, a poll loop, or
    // a model turn of its own.
    this.experienceRecall = config.experienceRecall !== false;
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
    void this.ctx.emit?.("evolution/execution-event", event);
    return event;
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
    if (summary.status === "drift") this.ctx.logger?.warn?.(`[evolution] Live/Backup drift detected: ${JSON.stringify(summary)}`);
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

  propose(args, exec) {
    const agent = ownerOf(exec);
    // The proposal text is durable: it is written into the archive, the evidence
    // sidecar and the event bridge, and it is echoed back to the caller. It
    // therefore crosses the credential boundary where it is captured, so no
    // reader has to remember to project it.
    const proposal = {
      why: evidenceText(args?.why, "why"),
      target: evidenceText(args?.target, "target"),
      impactScope: scopeList(args?.impactScope).map((entry) => compactValue(entry, EVIDENCE_PROJECTION)),
      successMetrics: stringList(args?.successMetrics, "successMetrics").map((entry) => compactValue(entry, EVIDENCE_PROJECTION)),
      risk: safeString(args?.risk || "low").toLowerCase(),
      owner: agent.id,
      createdAt: now(),
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
    };
    this.experiments.set(id, record);
    this.emitExecutionEvent("proposal-created", record);
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
      // Everything from here to the `finally` is evidence about a Trial that
      // already failed, so none of it may decide whether the lock is released.
      // The sixth review's second blocker was exactly that: `failureLearning()`
      // threw (RangeError from the redaction rules on an 8 MiB message), the
      // failure record was never written, and the `finally` below was still
      // skipped because the throw happened before the `try` — leaving the target
      // lock on disk and the experiment record in memory. The evidence block is
      // now inside the `try`, its own failures are reported as warnings, and the
      // original error is always the one the caller receives.
      try {
        let rollbackResult;
        try {
          if (!record.pluginId) throw new Error("Cordis define did not return a plugin id");
          rollbackResult = await this.runner.undefine(agent, definition.pluginId);
        } catch (rollbackError) {
          // Not `safeString(rollbackError?.message)`: that reads a property and runs
          // a `toString` on a hostile object *outside* any guard, on a path whose
          // job is to release things. The receipt crosses the same boundary as the
          // cleanup receipts and cannot throw.
          const detail = safeErrorDto(rollbackError, "cleanup");
          rollbackResult = { ok: false, error: detail.errorSummary, errorCategory: detail.errorCategory, errorDigest: detail.errorDigest };
        }
        record.state = "trial-failed";
        record.failure = safeFailureLearning({
          record,
          phase: "trial",
          error,
          rollbackResult,
          nextPreventionHint: "先用 evolution_runtime_inspect 确认 Host-only 代码与 Cordis 注入，再重新定义 Trial；重复失败必须更换假设。",
        });
        // A failed define/run activated nothing, so its target lock and record are
        // released even when the evidence cannot be written.
        await this.archiveTerminal(record, "trial-failed");
        this.emitEventSafely(record, "experiment-rejected", { status: record.state });
        this.emitEventSafely(record, "failure-learned", { status: record.state });
      } catch {
        // Deliberately swallows: the record is discarded below, the caller gets
        // the original Trial error, and a secondary evidence failure must not
        // replace the reason the Trial failed. The warning is a fixed line so
        // reporting it cannot re-enter the boundary that just failed.
        this.ctx.logger?.warn?.(`[evolution] trial evidence write failed for ${record.id}; releasing its target lock and dropping the record`);
      } finally {
        this.releaseTargets(record);
        this.experiments.delete(record.id);
      }
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
      repeatable: input.repeatable === true,
      regressionPassed: input.regressionPassed === true,
      reversible: input.reversible === true,
      cleanupEvidence: evidenceText(input.cleanupEvidence, "observation.cleanupEvidence"),
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
    record.runtimeRecovered = errors.length === 0 && stop?.ok === true && removed?.ok === true && signatureRecovered;
    record.cleanupProof = { stopOk: stop?.ok === true, removedOk: removed?.ok === true, signatureRecovered, errors, at: now() };
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
      this.ctx.logger?.warn?.(`[evolution] ${reason} archive failed for ${record.id}: ${detail.errorSummary} (${detail.errorCategory}, ${detail.errorDigest})`);
      return null;
    }
  }

  /** One execution event; a bridge failure is a warning, not a cleanup barrier. */
  emitEventSafely(record, type, payload = {}) {
    try {
      return this.emitExecutionEvent(type, record, payload);
    } catch (error) {
      const detail = safeErrorDto(error, "event-bridge");
      record.eventBridgeWarning = detail.errorSummary;
      record.eventBridgeWarningCategory = detail.errorCategory;
      record.eventBridgeWarningDigest = detail.errorDigest;
      this.ctx.logger?.warn?.(`[evolution] ${type} emission failed for ${record.id}: ${detail.errorSummary} (${detail.errorCategory}, ${detail.errorDigest})`);
      return null;
    }
  }

  async revert(args, exec) {
    const agent = ownerOf(exec);
    const record = this.requireOwned(args?.experimentId, agent);
    if (!["trial", "trial-awaiting-approval", "measured"].includes(record.state)) throw new Error(`experiment ${record.id} is ${record.state}; Revert requires a Trial`);
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
      if (!disposed.recovered) record.failure = safeFailureLearning({
        record,
        phase: "revert",
        error: new Error("Cordis cleanup did not prove runtime recovery"),
        rollbackResult: { stop: disposed.stop, removed: disposed.removed, errors: disposed.errors },
        nextPreventionHint: "不要继续 Promotion；先修复 disposer/rollback 路径并重新建立基线。",
      });
      await this.archiveTerminal(record, "revert");
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
        nextPreventionHint: "清理路径本身报错，运行时是否恢复未知；不要继续 Promotion，先复现并修复 dispose 路径。",
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
        await this.archiveTerminal(record, "promotion-gate");
        this.emitEventSafely(record, "experiment-rejected", { status: record.state, evidence: evidenceGates });
        this.emitEventSafely(record, "failure-learned", { status: record.state });
      } finally {
        record.state = "measured";
        this.releaseOperation(record);
      }
      return { ok: false, experimentId: record.id, phase: record.state, reason: "promotion-gate", gates: evidenceGates };
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
      throw error;
    }
    if (packageInspectionError) {
      record.state = "promotion-failed";
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
    record.lastGateEvidence = { gates, evidence: evidenceGates, at: now() };
    // The durable archive describes the intended terminal state; the in-memory
    // record remains "promoting" until the journaled commit verifies.
    let durable;
    try {
      durable = await writeDurablePromotion({ experiment: record, packageInspection, paths: this.paths, canaryWindow: this.canaryWindow, lockTtlMs: this.promotionLockTtlMs });
    } catch (error) {
      record.state = "promotion-failed";
      try {
        record.failure = safeFailureLearning({
          record,
          phase: "promotion-commit",
          error,
          rollbackResult: { ok: true, status: "journal-rollback-attempted" },
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
            if (parsed.parsed.experimentId === record.id) { opened = true; break; }
            // One classification drives both sides: the doctor reports the same
            // state this call acts on. Only `reclaimable` entries are removed,
            // and only on the first attempt, so a claim whose owner cannot be
            // proven gone stays where it is and keeps refusing the target.
            const classified = classifyTargetClaim(parsed);
            if (classified.state === TARGET_CLAIM_STATES.RECLAIMABLE && attempt === 0) { fs.rmSync(file, { force: true }); continue; }
            throw new Error(`unsafe parallel experiment conflicts on ${target} (owned by ${classified.claim?.experimentId || "unknown"})`);
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
        if (error?.code !== "ENOENT") this.ctx.logger?.warn?.(`[evolution] unable to release target ownership ${target}: ${safeErrorDto(error, "cleanup").errorSummary}`);
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
      this.experiments.set(record.id, record);
      this.acquireTargets(record);
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
      record.failure = safeFailureLearning({
        record,
        phase: "canary",
        error: new Error(observation.metricRegression ? "metric regression" : "startup/component/dependency canary regression"),
        rollbackResult: { ok: true, status: "rolled-back-to-last-known-good" },
        nextPreventionHint: "保留 canary 失败签名；重新验证 startup、component health、dependency 与 metric 后再提出新实验。",
      });
      try {
        await this.archive(record, "canary-regression");
        this.emitEventSafely(record, "canary-failed", { status: record.state, canary: observation });
        this.emitEventSafely(record, "promotion-reverted", { status: record.state, canary: observation });
        this.emitEventSafely(record, "failure-learned", { status: record.state });
      } finally {
        // The rollback already happened: its targets are no longer owned even
        // when the archive or an event write fails.
        this.releaseTargets(record);
      }
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
    }, { agent, signal: new AbortController().signal }, STARTUP_TRANSITION);
  }

  patternKey(input = {}) {
    return sha256(stableJson({
      type: input.type || "runtime/error",
      code: input.code || input.errorCode || input.error?.code || "unknown",
      target: input.target || input.component || input.plugin || "runtime",
      message: safeString(input.message || input.error?.message || "").toLowerCase().replace(/\b\d+\b/g, "#"),
      // Distinct errors that share a redacted summary stay distinct patterns.
      digest: input.errorDigest ?? null,
    }));
  }

  async observeAutonomous(input = {}, exec) {
    const agent = ownerOf(exec);
    const patternKey = this.patternKey(input);
    // Everything this method stores or records reads the safe input: the
    // observation stream (and therefore inspect), the failure memory and the
    // proposal text never see the raw provider message.
    const safeInput = safeObservationInput(input);
    const observations = this.patterns.get(patternKey) || [];
    const observation = { observationId: `obs-${Date.now().toString(36)}-${(++this.sequence).toString(36)}`, at: now(), patternKey, input: compactValue(safeInput) };
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
    const failureSignature = this.memory.signature({ problem: safeInput.message || safeInput.code, experiment: { patternKey }, result: "autonomous-failure", prevention: "suppress duplicate" });
    if (this.memory.hasActiveSignature(failureSignature)) {
      this.suppressedPatterns.add(patternKey);
      return { phase: "suppressed", patternKey, reason: "failure-memory" };
    }
    if (this.prepareRuntime) await this.prepareRuntime(agent, exec.signal);
    const proposed = this.propose({
      why: safeInput.message || `autonomous pattern ${patternKey}`,
      target: strategy.target || `plugin:${strategy.composition?.name || patternKey.slice(0, 12)}`,
      targets: strategy.targets,
      impactScope: strategy.impactScope || ["runtime"],
      successMetrics: strategy.successMetrics || ["error rate decreases"],
      risk,
    }, exec);
    try {
      await this.trial({ experimentId: proposed.experimentId, idPrefix: strategy.idPrefix, composition: strategy.composition }, exec);
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
      const detail = safeErrorDto(error, "autonomous");
      this.memory.record({
        signature: failureSignature,
        problem: safeInput.message || safeInput.code || "autonomous failure",
        evidence: safeInput,
        experiment: { patternKey, target: strategy.target },
        result: { state: "failed", category: detail.errorCategory, errorDigest: detail.errorDigest, errorSummary: detail.errorSummary },
        prevention: "suppress duplicate autonomous failure until a new strategy or explicit retry is supplied",
      });
      return {
        phase: /regression/i.test(error?.message || "") ? "rolled-back-regression" : "rolled-back-no-improvement",
        patternKey,
        error: detail.errorSummary,
        errorCategory: detail.errorCategory,
        errorDigest: detail.errorDigest,
      };
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
    const memory = this.memory.record({
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
      `- signature: ${record.memorySignature}`,
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
      this.ctx.logger?.warn?.(`[evolution] ${reason} for ${record.id} left ${file} untouched because the promotion journal is preserved; failure record written to ${evidenceFile}`);
      return evidenceFile;
    }
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
