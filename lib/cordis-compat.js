// Contract classification and readers for every Cordis / official-Include
// surface this bundle touches.
//
// This module is the single source of truth for that list: the runtime readers
// (`lib/orchestrator.js`, `lib/promotion-include.js`) and the doctor
// (`lib/diagnostics.js`) consume the same table, so the report can never claim
// a different dependency set than the code actually uses.
//
// Classification is taken from the shipped packages, not from guesswork. The
// classification was made against the first verified baseline and re-checked
// against the second (see COMPATIBILITY.md for the matrix):
//
//   public       an exported member with a documented contract in the package
//                that ships it (`@deepseek-ai/cordis` 4.0.4,
//                `@deepseek-ai/cordis-plugin-loader` 1.0.5,
//                `@deepseek-ai/cordis-plugin-include` 1.0.9).
//   undocumented a public runtime property with no documented contract, so its
//                shape may change without a major version bump.
//   private      underscore-prefixed and treated as special by the package
//                itself (cordis `isSpecialProperty` skips every `_`-prefixed
//                property when resolving context members), i.e. internal by the
//                owning package's own rule.
//
// Every entry records the public replacement that is actually used when one
// exists. An entry without a replacement is kept and reported, so an upgrade
// review knows exactly which surface can break and what the plugin degrades to.
//
// This module deliberately imports NOTHING from the host packages. The doctor
// entry point (`scripts/doctor.mjs`) runs in a plugin-only profile where host
// packages are not on plain Node's resolution path, so a top-level host import
// here would break diagnostics — the same reason `js-yaml` ships as a bundle
// dependency. Host values are therefore either handed in by the running bundle
// (`registerIsolateKey`, called from `lib/index.js`, which the host loads with
// host resolution available) or derived from a contract that needs no import.

export const SURFACE_PUBLIC = 'public';
export const SURFACE_UNDOCUMENTED = 'undocumented';
export const SURFACE_PRIVATE = 'private';

const isObject = (value) => typeof value === 'object' && value !== null;

/**
 * The isolation-map symbol, i.e. Cordis' `Context.isolate`.
 *
 * `Context.isolate` is documented as "symbol key of the isolation map", but the
 * static itself lives in a package this module must not import (see above).
 * Cordis builds that static as `Symbol.for('cordis.isolate')`, so the key is a
 * global registry entry that is identical in every module instance — the
 * running host hands over the authoritative value anyway via
 * `registerIsolateKey(Context.isolate)`.
 *
 * The assumption is asserted in `test/cordis-compat.test.mjs` against the real
 * package. If a future cordis stopped using a registered symbol, the public
 * path simply stops resolving and `serviceImpl()` falls back to the private
 * `_getImpl()` — reported as such by `serviceImplSource()` — rather than
 * silently reporting every service as unbound.
 */
let isolateKey = Symbol.for('cordis.isolate');

/** Adopt the live host's `Context.isolate` value; called from `lib/index.js`. */
export function registerIsolateKey(key) {
  if (typeof key === 'symbol') isolateKey = key;
}

/** The isolate symbol currently in use (for evidence, never for guessing). */
export function currentIsolateKey() {
  return isolateKey;
}

/** The isolation map of `ctx`, or null when this host exposes no such map. */
function isolateMap(ctx) {
  if (!isObject(ctx?.reflect?.store)) return null;
  const map = ctx[isolateKey];
  return isObject(map) ? map : null;
}

/**
 * Public resolution of a bound service implementation.
 *
 * `ReflectService.store` is documented as "service implementations, keyed by
 * isolation label" and `Impl` documents `fiber` as "the fiber that provided the
 * service (owns its lifetime)"; the isolation map is the documented
 * `Context.isolate` member. Together they are exactly what the private
 * `ReflectService._getImpl(name, false)` computes, including the isolation
 * lookup, without depending on a `_`-prefixed method.
 */
export function publicServiceImplPath(ctx) {
  return isolateMap(ctx) !== null;
}

/** Resolve the bound implementation record for `name`, public path first. */
export function serviceImpl(ctx, name) {
  const map = isolateMap(ctx);
  if (map) {
    const key = map[name];
    if (!key) return undefined;
    // The public path is authoritative when it is present: a declaration with
    // no bound implementation in this scope must stay unbound, exactly like
    // `_getImpl(name, false)` returns undefined.
    return ctx.reflect.store[key];
  }
  const lookup = ctx?.reflect?._getImpl;
  if (typeof lookup !== 'function') return undefined;
  try {
    return lookup.call(ctx.reflect, name, false);
  } catch {
    return undefined;
  }
}

/** Which resolution path `serviceImpl()` uses on this host. */
export function serviceImplSource(ctx) {
  if (publicServiceImplPath(ctx)) return 'public: ctx.reflect.store + Context.isolate';
  if (typeof ctx?.reflect?._getImpl === 'function') return 'private fallback: ctx.reflect._getImpl';
  return 'unavailable';
}

/**
 * Whether a Cordis fiber is in `FiberState.ACTIVE`.
 *
 * `FiberState` is a `const enum`, so it is erased from the published runtime
 * and its numeric values cannot be imported. The numeric literal is therefore
 * never trusted; the documented public lifecycle fields are used instead:
 *
 *   `uid`     "unique id within the registry; 0 for the root fiber, `null` once
 *             disposed"
 *   `store`   "snapshot of required service implementations while loaded;
 *             `undefined` otherwise"
 *   `inertia` "the in-flight load/unload transition, if one is currently
 *             running"
 *
 * `store` alone is not enough: `_reload()` publishes the snapshot before the
 * plugin body runs, so a LOADING fiber also has a store. Requiring the absence
 * of `inertia` excludes that window. Verified equal to `state === 2` for
 * PENDING, LOADING, ACTIVE, FAILED, DISPOSED and UNLOADING in
 * `test/cordis-compat.test.mjs`, which asserts the equivalence against the real
 * package so a future renumbering is caught here instead of silently accepted.
 */
export function fiberIsActive(fiber) {
  if (!fiber) return false;
  if (fiber.uid === null || fiber.uid === undefined) return false;
  if (fiber.store === undefined) return false;
  return fiber.inertia === undefined;
}

/**
 * The Cordis / loader / Include surfaces this bundle reads.
 *
 * `probe` reports whether the surface is answerable on a live context;
 * `required` marks the surfaces whose absence degrades correctness (the doctor
 * reports those as `degraded`), while advisory surfaces only reduce detail.
 */
export const SURFACES = Object.freeze([
  {
    api: 'ctx.registry.values() (components)',
    kind: SURFACE_PUBLIC,
    owner: '@deepseek-ai/cordis',
    contract: 'RegistryService.values() — "Iterate the registered plugin runtimes"; Context.registry is a documented member',
    reads: 'live plugin runtimes and their fibers (component inventory)',
    replacement: null,
    required: true,
    probe: (ctx) => typeof ctx?.registry?.values === 'function',
    count: (ctx) => { try { return [...ctx.registry.values()].length; } catch { return null; } },
  },
  {
    api: 'ctx.reflect.props (service declarations)',
    kind: SURFACE_PUBLIC,
    owner: '@deepseek-ai/cordis',
    contract: 'ReflectService.props — "Declared context properties (services and accessors), by name"; exported Property type',
    reads: 'which service names are declared, and whether each is a service or an accessor',
    replacement: null,
    required: true,
    probe: (ctx) => isObject(ctx?.reflect?.props),
    count: (ctx) => (isObject(ctx?.reflect?.props) ? Object.keys(ctx.reflect.props).length : null),
  },
  {
    api: 'ctx.reflect._getImpl() (service implementations)',
    kind: SURFACE_PRIVATE,
    owner: '@deepseek-ai/cordis',
    contract: 'private by the package\'s own rule: underscore-prefixed members are skipped by ReflectService.handler',
    reads: 'the bound implementation record and its owning fiber, for the live service inventory',
    replacement: 'ctx.reflect.store + Context.isolate',
    required: true,
    probe: (ctx) => serviceImplSource(ctx) !== 'unavailable',
    count: null,
    resolution: serviceImplSource,
    alternativeOk: publicServiceImplPath,
  },
  {
    api: 'ctx.events._hooks (event listeners)',
    kind: SURFACE_PRIVATE,
    owner: '@deepseek-ai/cordis',
    contract: "private by the package's own rule; cordis 4.x publishes no public listener enumeration (ctx.on/once register, dispatch modes deliver)",
    reads: 'the registered listener inventory (event, callback name, owning fiber)',
    replacement: null,
    noReplacementReason: 'cordis 4.x has no public API that enumerates registered listeners: ctx.on/once only register, and emit/parallel/serial/bail/waterfall only deliver. The only alternative would be a second listener bookkeeping table maintained by this plugin, which would be a less accurate second Fact source. The doctor reports this surface individually, so a host that drops it is reported degraded instead of silently guessing.',
    required: true,
    probe: (ctx) => isObject(ctx?.events?._hooks),
    count: (ctx) => (isObject(ctx?.events?._hooks) ? Object.keys(ctx.events._hooks).length : null),
  },
  {
    api: 'Fiber.getEffects() + Fiber.state/uid/inject/store/inertia (lifecycle and effect metadata)',
    kind: SURFACE_PUBLIC,
    owner: '@deepseek-ai/cordis',
    contract: 'Fiber.getEffects() — "Return metadata for currently registered effects" with the exported EffectMeta type; the lifecycle fields are documented members of the exported Fiber class',
    reads: 'per-fiber lifecycle state, dependency declarations, effect labels and nesting depth',
    replacement: 'FiberState.ACTIVE is NOT importable (const enum, erased at runtime) — fiberIsActive() uses the documented lifecycle fields instead',
    required: false,
    probe: (ctx) => {
      const fiber = ctx?.fiber;
      if (!fiber || typeof fiber.getEffects !== 'function') return false;
      return ['state', 'uid', 'inject', 'store', 'inertia'].every((field) => field in fiber);
    },
    count: null,
  },
  {
    api: 'official Include instance state (root.data, entry resolution, entry.fiber/options/disabled)',
    kind: SURFACE_UNDOCUMENTED,
    owner: '@deepseek-ai/cordis-plugin-loader + @deepseek-ai/cordis-plugin-include',
    contract: 'EntryTree.resolve()/await()/root and Entry.options/disabled/fiber are public members of the shipped loader classes, but the packages publish no stability contract for them; no public API lists the live root entry list, so the stale-tree check reads root.data and fails closed when it cannot',
    reads: 'the mounted promoted row, its fiber health and its bound dependencies',
    replacement: 'EntryTree.resolve(rowId) instead of EntryTree.store[rowId]',
    required: true,
    probe: (ctx, extra) => {
      const capabilities = extra?.promotionRuntime?.capabilities;
      // The loader members are exercised through the live promoted-Include
      // adapter, which records what it actually found at mount time. Without a
      // mounted adapter the surface is not observable, so it is not claimed.
      return Boolean(capabilities?.entryResolver && capabilities?.treeAwait && capabilities?.liveRootEntries);
    },
    count: null,
    resolution: (ctx, extra) => {
      const capabilities = extra?.promotionRuntime?.capabilities;
      if (!capabilities) return 'not observable: no mounted promoted Include adapter in this process';
      return `loader members observed at mount: ${Object.entries(capabilities).filter(([, value]) => value === true).map(([key]) => key).join(', ') || 'none'}`;
    },
  },
  {
    api: 'ctx.tools.schemas() (visible tools)',
    kind: SURFACE_PUBLIC,
    owner: '@deepseek-ai/dsh-tools',
    contract: 'host service surface: ToolsService.schemas()/get()',
    reads: 'the tool surface visible to the agent, for rotation evidence',
    replacement: null,
    required: true,
    probe: (ctx) => typeof ctx?.tools?.schemas === 'function',
    count: null,
  },
  {
    api: 'dynamicCordisRunner.snapshot()',
    kind: SURFACE_PUBLIC,
    owner: '@deepseek-ai/dsh-cordis-host-runner',
    contract: 'host service surface: snapshot()/define()/run()/stop()/undefine()',
    reads: 'dynamic Cordis Packages and their active runs',
    replacement: null,
    required: true,
    probe: (ctx) => typeof ctx?.dynamicCordisRunner?.snapshot === 'function',
    count: null,
  },
  {
    api: "ctx.get('cordisInspect').list() (providers)",
    kind: SURFACE_PUBLIC,
    owner: '@deepseek-ai/dsh-cordis-client-runner',
    contract: 'host service surface: optional cordisInspect provider registry',
    reads: 'registered inspect providers',
    replacement: null,
    required: false,
    probe: (ctx) => typeof ctx?.get?.('cordisInspect')?.list === 'function',
    count: null,
  },
]);

/**
 * Probe every recorded surface on a live context.
 *
 * @param ctx — the live Cordis context, or undefined in CLI mode.
 * @param extra — `{ promotionRuntime }` when the mounted promoted-Include
 *   adapter is available; it carries the loader capabilities observed at mount.
 * @returns `{ probes, unavailable, advisoryUnavailable, privateSurfaces, publicReplacements }`.
 *   `unavailable` contains only required surfaces, so an optional or already
 *   replaced surface never turns a healthy report into a degraded one.
 */
export function probeSurfaces(ctx, extra = {}) {
  const probes = SURFACES.map((surface) => {
    let ok = false;
    let count = null;
    try {
      ok = Boolean(surface.probe(ctx, extra));
      count = ok && typeof surface.count === 'function' ? surface.count(ctx, extra) : null;
    } catch {
      ok = false;
      count = null;
    }
    return {
      api: surface.api,
      kind: surface.kind,
      owner: surface.owner,
      required: surface.required,
      ok,
      count,
      reads: surface.reads,
      contract: surface.contract,
      replacement: surface.replacement,
      ...(surface.noReplacementReason ? { noReplacementReason: surface.noReplacementReason } : {}),
      ...(typeof surface.resolution === 'function' ? { resolution: surface.resolution(ctx, extra) } : {}),
      ...(typeof surface.alternativeOk === 'function' ? { publicAlternativeOk: Boolean(surface.alternativeOk(ctx)) } : {}),
    };
  });
  return {
    probes,
    unavailable: probes.filter((probe) => probe.required && !probe.ok).map((probe) => probe.api),
    advisoryUnavailable: probes.filter((probe) => !probe.required && !probe.ok).map((probe) => probe.api),
    privateSurfaces: probes.filter((probe) => probe.kind === SURFACE_PRIVATE && probe.required).map((probe) => probe.api),
    privateSurfacesWithoutReplacement: probes.filter((probe) => probe.kind === SURFACE_PRIVATE && !probe.replacement).map((probe) => ({ api: probe.api, reason: probe.noReplacementReason ?? null })),
    publicReplacements: probes.filter((probe) => probe.kind !== SURFACE_PUBLIC && probe.replacement).map((probe) => ({ api: probe.api, replacement: probe.replacement })),
    undocumentedSurfaces: probes.filter((probe) => probe.kind === SURFACE_UNDOCUMENTED).map((probe) => probe.api),
  };
}

/** The recorded list, for documentation and tests that must not drift. */
export function recordedSurfaces() {
  return SURFACES.map((surface) => ({
    api: surface.api, kind: surface.kind, owner: surface.owner, required: surface.required,
    replacement: surface.replacement, noReplacementReason: surface.noReplacementReason ?? null, reads: surface.reads,
  }));
}
