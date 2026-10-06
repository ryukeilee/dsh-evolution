import { ValidationError } from "./errors.js";
import { normalizeComponentContract } from "./manifest-contract.js";
function clone(value) {
  if (value === undefined || value === null) return value;
  try {
    return structuredClone(value);
  } catch {
    if (Array.isArray(value)) return value.map(clone);
    if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
    return typeof value === "function" ? undefined : value;
  }
}

const COMPONENT_LIFECYCLE = Object.freeze({ STATIC: "static", DYNAMIC: "dynamic", TEMPORARY: "temporary", DURABLE: "durable" });
const SEMANTIC_COMPONENT_KINDS = new Set(["agent", "tool", "skill", "provider", "plugin", "evolution.strategy", "evolution.stage"]);
function unique(values) {
  const entries = Array.isArray(values) ? values : [values];
  return [...new Set(entries.filter((value) => value !== undefined && value !== null && String(value).trim() !== "").map(String))];
}

function normalizeRequirement(value) {
  if (typeof value === "string") {
    const normalized = { id: value, capability: value, optional: false };
    Object.defineProperty(normalized, "matchAny", { configurable: true, value: true });
    return normalized;
  }
  if (!value || typeof value !== "object") throw new ValidationError("Component dependency must be a string or object");
  const id = value.id ?? value.componentId ?? value.providerId ?? null;
  const capability = value.capability ?? value.provides ?? value.name ?? null;
  if (!id && !capability) throw new ValidationError("Component dependency requires id or capability");
  const normalized = {
    ...(id ? { id: String(id) } : {}),
    ...(capability ? { capability: String(capability) } : {}),
    ...(value.version !== undefined ? { version: clone(value.version) } : {}),
    ...(value.versionRange !== undefined ? { versionRange: clone(value.versionRange) } : {}),
    ...(value.range !== undefined ? { versionRange: clone(value.range) } : {}),
    ...(value.minVersion !== undefined ? { minVersion: String(value.minVersion) } : {}),
    ...(value.maxVersion !== undefined ? { maxVersion: String(value.maxVersion) } : {}),
    ...(value.capabilities ? { capabilities: unique(value.capabilities) } : {}),
    ...(value.selection ? { selection: String(value.selection) } : {}),
    optional: Boolean(value.optional),
  };
  if (value.matchAny === true) Object.defineProperty(normalized, "matchAny", { configurable: true, value: true });
  return normalized;
}

function normalizeRequirements(values) {
  return (Array.isArray(values) ? values : values ? [values] : []).map(normalizeRequirement);
}

function identityFor(input, id) {
  const identity = input.identity && typeof input.identity === "object" ? input.identity : {};
  return {
    name: String(identity.name ?? input.name ?? id),
    version: String(identity.version ?? input.version ?? "0.0.0"),
    ...(identity.namespace || input.namespace ? { namespace: String(identity.namespace ?? input.namespace) } : {}),
  };
}

/** Normalize the public component contract without retaining executable fields in snapshots. */
export function normalizeComponentDefinition(input = {}) {
  if (!input || typeof input !== "object") throw new ValidationError("Component definition is required");
  const id = input.id ?? input.identity?.id ?? input.name ?? input.identity?.name;
  if (!id) throw new ValidationError("Component identity requires id or name");
  const identity = identityFor(input, id);
  const lifecycle = input.lifecycle && typeof input.lifecycle === "object"
    ? { ...input.lifecycle }
    : { scope: input.temporary ? COMPONENT_LIFECYCLE.TEMPORARY : COMPONENT_LIFECYCLE.DYNAMIC };
  const provides = unique([
    id,
    ...(Array.isArray(input.provides) ? input.provides : input.provides ? [input.provides] : []),
    ...(Array.isArray(input.capabilities) ? input.capabilities : input.capabilities ? [input.capabilities] : []),
  ]);
  const requires = normalizeRequirements(input.requires ?? input.dependencies ?? []);
  const priorityValue = Number(input.priority ?? input.metadata?.priority ?? 0);
  const parentId = input.parentId ?? input.lifecycle?.parentId ?? null;
  const ownerId = input.ownerId ?? input.owner ?? input.metadata?.ownerId ?? null;
  const kind = String(input.kind ?? "component");
  const semanticKind = SEMANTIC_COMPONENT_KINDS.has(kind.toLowerCase());
  const normalized = {
    id: String(id),
    kind,
    identity: { ...identity, id: String(id) },
    name: String(input.name ?? identity.name),
    version: identity.version,
    capabilities: unique(input.capabilities ?? []),
    provides,
    requires,
    dependencies: requires.map((requirement) => ({ ...requirement })),
    contract: normalizeComponentContract({
      ...input,
      id: String(id),
      name: String(input.name ?? identity.name),
      version: identity.version,
      kind,
      apiVersion: input.apiVersion ?? input.contract?.apiVersion,
      capabilities: input.capabilities ?? [],
      provides,
      requires,
      migration: input.migration ?? (semanticKind ? { supported: true } : undefined),
      lifecycle,
      effects: input.effects,
    }),
    priority: Number.isFinite(priorityValue) ? priorityValue : 0,
    ...(parentId ? { parentId: String(parentId) } : {}),
    ...(ownerId ? { ownerId: String(ownerId) } : {}),
    selectionPolicy: String(input.selectionPolicy ?? input.policy?.selection ?? "priority"),
    effects: clone(Array.isArray(input.effects) ? input.effects : input.effects ? [input.effects] : []),
    lifecycle: {
      scope: lifecycle.scope ?? COMPONENT_LIFECYCLE.DYNAMIC,
      ...clone(lifecycle),
    },
    health: clone(input.health ?? { status: "unknown" }),
    temporary: Boolean(input.temporary || lifecycle.scope === COMPONENT_LIFECYCLE.TEMPORARY),
    durable: input.durable === undefined
      ? lifecycle.scope === COMPONENT_LIFECYCLE.DURABLE
      : Boolean(input.durable),
    disabled: Boolean(input.disabled),
    resolverKey: input.resolverKey ?? input.resolver ?? input.metadata?.resolverKey ?? input.metadata?.resolver ?? null,
    requiresResolver: Boolean(input.requiresResolver),
    configuration: clone(input.configuration ?? input.config ?? {}),
    policy: clone(input.policy ?? {}),
    metadata: clone(input.metadata ?? {}),
    activate: input.activate ?? input.lifecycle?.activate ?? null,
    deactivate: input.deactivate ?? input.lifecycle?.deactivate ?? null,
    remove: input.remove ?? input.lifecycle?.remove ?? null,
    healthCheck: input.healthCheck ?? input.lifecycle?.healthCheck ?? null,
    // State hooks are intentionally optional and are never treated as part of
    // the public contract. They are invoked only by the recovery boundary.
    snapshot: (typeof input.snapshot === "function" ? input.snapshot.bind(input) : input.snapshot) ?? input.lifecycle?.snapshot
      ?? (typeof input.instance?.snapshot === "function" ? input.instance.snapshot.bind(input.instance) : null),
    restore: (typeof input.restore === "function" ? input.restore.bind(input) : input.restore) ?? input.lifecycle?.restore
      ?? (typeof input.instance?.restore === "function" ? input.instance.restore.bind(input.instance) : null),
    replace: input.replace ?? null,
    instance: input.instance ?? null,
    value: input.value ?? input.service ?? null,
    provide: input.provide ?? null,
    immutableService: Boolean(input.immutableService ?? input.metadata?.immutableService),
  };
  // Data-only extraction: do not synthesize runtime activation/deactivation hooks.
  return normalized;
}
