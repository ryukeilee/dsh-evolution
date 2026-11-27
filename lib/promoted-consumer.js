/**
 * Lightweight cross-entry consumer for Desktop-published, verified plugins.
 *
 * The ACP and Web profiles must be able to use a plugin that the Desktop
 * profile promoted to stable, without running the Evolution kernel in those
 * profiles: no orchestrator, no Trial/Canary state machine, no domain storage,
 * no tools and no model calls. This entry is the whole consumer:
 *
 * 1. Read the publication index the Desktop publisher wrote under the shared
 *    `$DSH_HOME` data root. The index and its records are owned by
 *    `lib/promoted-sharing.js`; nothing here promotes, retries a failed plugin,
 *    writes a journal, a canary record or the Desktop composition.
 * 2. Ask that module whether each record may be mounted in this profile. The
 *    decision covers record integrity, verified source bytes, explicit
 *    cross-entry approval, per-profile operator revocation, exact host identity,
 *    required services and the capabilities this live context actually proved.
 * 3. Mount only the eligible rows through the official Include adapter
 *    (`mountIncludeTree` from `lib/promotion-include.js`), into a consumer-owned
 *    composition file, and verify every row on the live tree: public resolve,
 *    module URL, enabled row, active Fiber, injected services bound in the
 *    entry's own scope, and a settled `Fiber.await()`.
 * 4. Write an activation record to `shared-plugins/consumers/<profile>.json`.
 *    That file is this profile's own report; it can never become a Desktop
 *    promotion fact.
 *
 * The entry is inert outside the consumer profiles: Desktop mounts promoted
 * plugins through its own `promoted.cordis.yml`, and an unknown profile must
 * mount nothing.
 *
 * This module deliberately imports only the sharing contract, the official
 * Include helper and the documented Cordis lifecycle readers. It must not pull
 * in `lib/orchestrator.js` or `lib/diagnostics.js` (they carry the kernel), and
 * it must not grow a second registry, polling or background work. Startup
 * retries are bounded and joined by the entry lifecycle.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fiberIsActive, fiberIsShuttingDown } from './cordis-compat.js';
import { mountIncludeTree } from './promotion-include.js';
import { detectHostIdentity } from './runtime-versions.js';
import {
  SHARED_CONSUMER_PROFILES,
  SHARED_STATUS,
  applySupersession,
  captureHostFacts,
  claimConsumerSession,
  completeHostFacts,
  hostFactsComplete,
  isConsumerHostFailure,
  consumerCompositionEntries,
  consumerStateDocument,
  evaluateSharedRecord,
  hostDigest,
  probeSharedCapabilities,
  readDisableState,
  readSharedIndex,
  sharedFailure,
  sharingPaths,
  writeConsumerState,
} from './promoted-sharing.js';

export const name = 'dsh-evolution-promoted-consumer';
export const inject = ['tools'];

/**
 * The data root shared with the Desktop publisher and the Evolution kernel.
 *
 * This is a local copy of the `dataRoot` half of
 * `diagnostics.resolveEvolutionPaths()` on purpose: importing the diagnostics
 * module would pull the kernel into a bundle entry that must stay lightweight.
 * The path test asserts equality against the diagnostics resolver, so the two
 * cannot drift.
 */
export function resolveConsumerDataRoot({ dshHome, dataRoot } = {}) {
  const home = path.resolve(dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  return path.resolve(dataRoot || path.join(home, 'storages', 'evolution'));
}

/** The booted profile, resolved exactly like `lib/index.js` does. */
export function resolveConsumerProfile(ctx, config = {}) {
  let fromContext;
  try {
    fromContext = typeof ctx?.get === 'function' ? ctx.get('profileContext')?.name : undefined;
  } catch {
    fromContext = undefined;
  }
  // The booted profile is the authoritative fact: `profileContext` names the
  // profile the host actually composed. `DSH_PROFILE` is only a fallback for
  // hosts without that service, because a driving session can export its own
  // profile name into the environment of an unrelated boot.
  const profile = config.profile || fromContext || process.env.DSH_PROFILE || null;
  return typeof profile === 'string' && profile.trim() !== '' ? profile.trim() : null;
}

function consumerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Whether this session can still publish a report about the profile.
 *
 * A consumer publishes from `apply()` while its own fiber is still LOADING, so
 * the fiber's ACTIVE state is not the test. What matters is whether the path to the
 * root is being torn down: Cordis clears a fiber's `uid` before running its
 * effect disposers, and a host shutdown brings the ancestor fibers to UNLOADING
 * before this entry's disposer is reached. A mount or probe result observed in
 * that window is an artefact of the teardown — a cancelled startup — not a fact
 * about the profile, so the session keeps the inherited report instead of
 * publishing rows that would overwrite a live session's activation.
 */
function contextCannotPublish(ctx) {
  try {
    return fiberIsShuttingDown(ctx?.fiber)
      || fiberIsShuttingDown(ctx?.fiber?.parent?.fiber)
      || fiberIsShuttingDown(ctx?.root?.fiber);
  } catch {
    return false;
  }
}

/** One atomic consumer-composition write: temp file then rename in place. */
async function writeCompositionAtomic(file, content) {
  const directory = path.dirname(file);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = path.join(directory, `.consumer-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    const handle = await fsp.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(temp, file);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * An entry list is valid YAML as JSON, and it is the exact shape the official
 * Include parses. Writing JSON keeps the consumer composition deterministic.
 */
function compositionText(entries) {
  return `${JSON.stringify(Array.isArray(entries) ? entries : [], null, 2)}\n`;
}

/** Module URLs already mounted by the profile's own loader tree. */
function loaderModuleUrls(ctx) {
  const urls = [];
  try {
    const loader = typeof ctx?.get === 'function' ? ctx.get('loader') : null;
    if (typeof loader?.entries !== 'function') return urls;
    for (const entry of loader.entries()) {
      // A disabled row is not mounted, so it cannot be a duplicate instance.
      if (entry?.disabled === true) continue;
      const url = entry?.options?.name;
      if (typeof url === 'string' && url !== '') urls.push(url);
    }
  } catch {
    // An unreadable loader is reported as "nothing known to be mounted"; the
    // per-record verification below still has to prove every mount.
  }
  return urls;
}

/**
 * Whether the Evolution kernel is enabled in this profile's loader tree.
 *
 * A record published by this profile is only a conflict when the kernel that
 * published it is actually mounted: a host can act as both publisher and
 * consumer role, and when the kernel row is disabled nothing else would ever
 * mount its published plugins. The static `entry.disabled` getter is used
 * deliberately: sibling entries initialize concurrently, so a fiber-activation
 * check would race the kernel's own startup.
 */
function kernelEnabledHere(ctx) {
  try {
    const loader = typeof ctx?.get === 'function' ? ctx.get('loader') : null;
    if (typeof loader?.entries !== 'function') return false;
    for (const entry of loader.entries()) {
      const options = entry?.options ?? {};
      const isKernel = options.id === 'evolution-orchestrator' || options.name === 'dsh-evolution';
      if (isKernel && entry.disabled !== true) return true;
    }
  } catch {
    // An unreadable loader means no kernel can be proven; the per-record
    // checks still gate every mount.
  }
  return false;
}

/** Live service availability in the consumer's own context. */
function serviceProbe(ctx) {
  const read = (service) => {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(service) : null;
    } catch {
      return null;
    }
  };
  return {
    has: (service) => {
      const impl = read(service);
      return impl !== null && impl !== undefined;
    },
    memberPresent: (service, member) => {
      const impl = read(service);
      if (impl === null || impl === undefined) return false;
      try {
        return member in impl;
      } catch {
        return false;
      }
    },
  };
}

/** The official `pluginPackages.packageOf` reader, or undefined when absent. */
function hostPackageReader(ctx) {
  try {
    const packages = typeof ctx?.get === 'function' ? ctx.get('pluginPackages') : null;
    if (typeof packages?.packageOf === 'function') return packages.packageOf.bind(packages);
  } catch {
    // Host facts stay null, which makes records unverifiable instead of assumed.
  }
  return undefined;
}

/**
 * Verify one eligible row on the live official Include tree.
 *
 * This is the consumer's own verification, not the Desktop kernel's: it only
 * accepts a row that the public resolver returns and that carries the exact
 * recorded module URL, is not disabled, has an active Fiber whose `inject`
 * services are all bound in its own scope, and whose `Fiber.await()` settled.
 * A rejected `await()` is the plugin's own startup failure.
 */
async function verifyConsumerEntry(adapter, rowId, record) {
  const entry = adapter.resolveEntry(rowId);
  if (!entry) throw consumerError('E_CONSUMER_ENTRY_MISSING', `consumer entry is missing: ${rowId}`);
  if (entry.options?.name !== record.moduleUrl) throw consumerError('E_CONSUMER_MODULE_MISMATCH', `consumer entry module URL does not match: ${rowId}`);
  if (entry.disabled) throw consumerError('E_CONSUMER_ENTRY_DISABLED', `consumer entry is disabled: ${rowId}`);
  const fiber = entry.fiber;
  if (!fiber) throw consumerError('E_CONSUMER_FIBER_MISSING', `consumer entry has no fiber: ${rowId}`);
  if (typeof fiber.await === 'function') {
    try {
      await fiber.await();
    } catch (error) {
      throw consumerError('E_CONSUMER_PLUGIN_APPLY_FAILED', `consumer plugin apply failed: ${rowId}: ${error?.message || error}`);
    }
  }
  if (!fiberIsActive(fiber)) throw consumerError('E_CONSUMER_FIBER_INACTIVE', `consumer entry fiber is not active: ${rowId}`);
  const missing = Object.keys(fiber.inject || {}).filter((service) => {
    try {
      return !fiber.ctx.get(service);
    } catch {
      return true;
    }
  });
  if (missing.length > 0) throw consumerError('E_CONSUMER_MISSING_DEPENDENCY', `consumer entry is missing bound services: ${missing.join(', ')}`);
  return fiber;
}

/**
 * Tool names currently registered on the host, read from the public registry.
 *
 * `ctx.tools.schemas()` is that registry and `ctx.get('tools')` may be absent
 * (a packaged entry without the service), in which case the caller records an
 * empty baseline. The service is the only honest proof of a plugin's real
 * presence: Cordis catches and logs a throwing effect disposer in
 * `Fiber._unload()`, so the official Include child's `dispose()` resolves and
 * clears its fibers/resolver while the tool it registered stays online.
 */
function toolNames(ctx) {
  try {
    const tools = typeof ctx?.get === 'function' ? ctx.get('tools') : null;
    if (typeof tools?.schemas !== 'function') return new Set();
    const names = new Set();
    for (const definition of tools.schemas()) {
      if (typeof definition?.name === 'string') names.add(definition.name);
    }
    return names;
  } catch {
    return new Set();
  }
}

/** Tool names registered on the host minus the baseline captured before mount. */
function pluginToolNames(ctx, baseline) {
  const names = toolNames(ctx);
  for (const name of baseline) names.delete(name);
  return names;
}

/**
 * The tool names that belonged to the old tree before disposal and are still
 * registered after it. A throwing effect disposer leaves such a leftover even
 * though the Fiber and public resolver both look released.
 */
function toolSurfaceLeftovers(ctx, baseline, before) {
  const after = toolNames(ctx);
  const leftovers = [];
  for (const name of before) {
    if (after.has(name)) leftovers.push(name);
  }
  return leftovers.sort();
}

/**
 * Prove an old Include subtree really unloaded before a fallback rebuild mounts
 * a second one over the same profile.
 *
 * `adapter.dispose()` resolving is not proof that every child disposer ran: a
 * row can stay online and a second subtree would then register the same plugin
 * twice. Three independent signals are required — no tool the old tree
 * registered is still on the live registry, every fiber captured from the old
 * tree has left ACTIVE, and the old resolver no longer serves any row it
 * evaluated. A resolver that throws is itself proof of teardown (the official
 * adapter drops its row lookup when the Include child disposes).
 */
function oldIncludeReleased(adapter, mounted, rowIds, { toolLeftovers = [] } = {}) {
  if (toolLeftovers.length > 0) return false;
  for (const { fiber } of mounted.values()) {
    if (fiberIsActive(fiber)) return false;
  }
  for (const rowId of rowIds) {
    let entry;
    try {
      entry = adapter.resolveEntry(rowId);
    } catch {
      // A disposed resolver cannot serve a live row; count it as released.
      continue;
    }
    if (entry) return false;
  }
  return true;
}

function invalidRow(invalid, host) {
  return {
    id: typeof invalid?.id === 'string' ? invalid.id : null,
    status: SHARED_STATUS.INVALID,
    reason: typeof invalid?.reason === 'string' && invalid.reason !== '' ? invalid.reason : 'index-invalid',
    sourceSha256: null,
    hostDigest: hostDigest(host),
    activatedAt: null,
    errorCode: null,
    errorName: null,
    errorDigest: null,
  };
}

function decisionRow(record, decision, host, { activatedAt = null } = {}) {
  if (decision?.sticky && decision.previous) return { ...decision.previous };
  const failure = sharedFailure(decision?.error, decision?.reason || 'consumer-error');
  return {
    id: record.id,
    status: decision?.status ?? SHARED_STATUS.FAILED,
    reason: decision?.reason ?? null,
    sourceSha256: typeof record.sourceSha256 === 'string' ? record.sourceSha256 : null,
    hostDigest: hostDigest(host),
    activatedAt,
    errorCode: decision?.error ? failure.errorCode : null,
    errorName: decision?.error ? failure.errorName : null,
    errorDigest: decision?.error ? failure.errorDigest : null,
  };
}

/**
 * The mount/dispose lifecycle without the bundle entry wiring.
 *
 * `mountInclude` is a seam for tests and for hosts that provide the official
 * Include differently; the default is the real official mounting helper. The
 * session owns exactly one Include child and one consumer composition per
 * profile, and it never throws from `glue` code paths that the host must
 * survive (the bundle `apply()` catches, and disposal records failures).
 */
export function createConsumerSession({
  ctx,
  config = {},
  profile,
  paths,
  mountInclude = mountIncludeTree,
  detectHost = detectHostIdentity,
  now = () => new Date().toISOString(),
} = {}) {
  if (!ctx) throw new Error('Promoted consumer session requires a context');
  if (!SHARED_CONSUMER_PROFILES.includes(profile)) throw new Error(`Promoted consumer profile is not a consumer profile: ${String(profile)}`);
  const dataRoot = resolveConsumerDataRoot(config);
  const resolvedPaths = paths ?? {
    ...sharingPaths({ dataRoot }),
    // The same in-place `promoted/` root the Desktop publisher wrote to; the
    // sharing contract re-hashes these bytes before every activation.
    pluginRoot: path.join(dataRoot, 'promoted'),
  };
  const sessionId = crypto.randomUUID();
  const compositionPath = resolvedPaths.compositionPath(profile).replace(/\.cordis\.yml$/, `.${sessionId}.cordis.yml`);
  // Captured before any Include subtree is mounted. Tools already registered by
  // the host are not ours; anything added afterwards that survives disposal is.
  const hostBaselineTools = toolNames(ctx);

  const session = {
    profile,
    sessionId,
    paths: resolvedPaths,
    compositionPath,
    adapter: null,
    host: null,
    indexUpdatedAt: null,
    rows: [],
    lastState: null,
    /** The report this session inherited before it claimed the profile. */
    previousState: null,
    stateWritten: false,
    disposed: false,
    disposeResult: null,
    /** A fallback disposal that left plugin tools registered on the live registry. */
    unreleasedOldTree: false,
    /** Live rows captured for disposal: record id -> { rowId, fiber, record }. */
    mounted: new Map(),
  };

  const writeState = async (plugins, indexUpdatedAt) => {
    // A startup that is already being torn down must not publish: the rows it
    // computed describe the teardown (a dead Include, empty capability or
    // service probes), and replacing a live session's activation report with
    // them is the misreport this consumer exists to avoid.
    if (session.disposed || contextCannotPublish(ctx)) return null;
    const document = consumerStateDocument({
      profile,
      host: session.host,
      indexUpdatedAt,
      compositionPath,
      plugins,
    });
    document.sessionId = sessionId;
    session.lastState = document;
    const written = await writeConsumerState(resolvedPaths, profile, document, { sessionId });
    if (written) session.stateWritten = true;
    return written ? document : null;
  };

  const failedRows = (index, reason, error) => {
    const failure = sharedFailure(error, reason);
    const rows = index.records.map((record) => ({
      id: record.id,
      status: SHARED_STATUS.FAILED,
      reason,
      sourceSha256: typeof record.sourceSha256 === 'string' ? record.sourceSha256 : null,
      hostDigest: hostDigest(session.host),
      activatedAt: null,
      errorCode: failure.errorCode,
      errorName: failure.errorName,
      errorDigest: failure.errorDigest,
    }));
    rows.push(...index.invalid.map((row) => invalidRow(row, session.host)));
    return rows;
  };

  /**
   * Two-phase mount.
   *
   * Phase A: mount the official Include over an empty consumer composition and
   * record the loader capabilities it really reached. Phase B: evaluate every
   * published record against that live capability set, write only the eligible
   * rows, refresh, then verify each row individually. A record that fails any
   * step is reported and never blocks the others.
   */
  let mounting;
  function mount() {
    if (session.disposed) return Promise.resolve(session);
    return mounting ??= mountOnce();
  }

  /**
   * Mount one official Include subtree over this session's composition.
   *
   * Only the official lifecycle error with proven child cleanup may retry:
   * neither a plugin source nor a fallback subtree has been loaded into the
   * new child yet. A session that can no longer publish returns null instead
   * of a tree, so neither the initial mount nor a fallback rebuild may report
   * a tree that was cancelled during startup.
   */
  async function mountIncludeWithRetry() {
    for (let attempt = 0; ; attempt += 1) {
      if (session.disposed || contextCannotPublish(ctx)) return null;
      try {
        return await mountInclude(ctx, { path: compositionPath, initial: [] });
      } catch (error) {
        if (error?.code !== 'INACTIVE_EFFECT' || error?.consumerRetrySafe !== true || attempt >= 2) {
          // A cancelled startup is not a host failure; do not publish a report
          // that would replace a live session's activation.
          if (error?.code === 'INACTIVE_EFFECT' && contextCannotPublish(ctx)) return null;
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
  }

  async function mountOnce() {
    const previous = await claimConsumerSession(resolvedPaths, profile, sessionId);
    session.previousState = previous.state ?? null;
    // Cancellation before evaluation must not erase inherited plugin failures.
    // Prior active rows are not activation proof for this new host.
    session.rows = (previous.state?.plugins ?? []).filter(row => row.status === SHARED_STATUS.FAILED);
    const captured = captureHostFacts({
      packageOf: hostPackageReader(ctx),
      profile,
      baseUrl: typeof ctx?.baseUrl === 'string' ? ctx.baseUrl : undefined,
    });
    // A packaged ACP/Web entry can boot without the official package service.
    // Fall back to the exact process/package identity (the same reader the
    // review and doctor use) so a real host is not reported as a version
    // mismatch for every published record. Only unproven fields may be filled.
    let detected = null;
    if (!hostFactsComplete(captured)) {
      try { detected = detectHost(); } catch { detected = null; }
    }
    session.host = completeHostFacts(captured, detected);
    const index = await readSharedIndex(resolvedPaths);
    const disableState = await readDisableState(resolvedPaths);
    session.indexUpdatedAt = index.updatedAt ?? null;

    let adapter;
    try {
      // The consumer composition is derived state: start from an empty list so
      // rows no longer published or now revoked are never mounted with stale
      // entries. The file is ours, per profile, written atomically.
      await writeCompositionAtomic(compositionPath, compositionText([]));
      adapter = await mountIncludeWithRetry();
      if (!adapter) return session;
    } catch (error) {
      session.rows = failedRows(index, 'include-unavailable', error).map(row => {
        const prior = previous.state?.plugins?.find(item => item.id === row.id);
        return prior?.status === SHARED_STATUS.FAILED && !isConsumerHostFailure(prior)
          && prior.sourceSha256 === row.sourceSha256 && prior.hostDigest === row.hostDigest ? prior : row;
      });
      if ((index.status === 'invalid' || index.status === 'unreadable') && index.invalid.length === 0) {
        session.rows.push(invalidRow({ id: null, reason: `index-${index.status}` }, session.host));
      }
      await writeState(session.rows, session.indexUpdatedAt);
      return session;
    }
    session.adapter = adapter;
    if (session.disposed) return session;
    // A capability probe failure must not abort the report: no proven capability
    // means every record is skipped as incompatible, which is the honest result
    // and is still written to the consumer state.
    let capabilities = null;
    try {
      capabilities = probeSharedCapabilities({ ctx, includeCapabilities: adapter.capabilities });
    } catch {
      capabilities = null;
    }
    const services = serviceProbe(ctx);
    const mountedModuleUrls = loaderModuleUrls(ctx);
    const kernelEnabled = kernelEnabledHere(ctx);
    const evaluated = [];
    for (const record of index.records) {
      let decision;
      try {
        decision = await evaluateSharedRecord({
          paths: resolvedPaths,
          record,
          profile,
          host: session.host,
          capabilities,
          services,
          mountedModuleUrls,
          disableState,
          previousState: previous.state,
          kernelEnabled,
        });
      } catch (error) {
        decision = { status: SHARED_STATUS.FAILED, reason: 'evaluation-failed', error };
      }
      if (decision?.status === 'eligible') mountedModuleUrls.push(record.moduleUrl);
      evaluated.push({ record, decision });
    }
    // Supersession is resolved only after every record was evaluated, so a
    // replacement that is itself ineligible cannot leave the profile with no
    // working plugin. The composition is written once from the result.
    const decisions = applySupersession(evaluated, { profile });

    const eligible = decisions.filter(({ decision }) => decision?.status === 'eligible');
    const rows = decisions
      .filter(({ decision }) => decision?.status !== 'eligible')
      .map(({ record, decision }) => decisionRow(record, decision, session.host));
    const rowById = new Map(rows.map((row) => [row.id, row]));

    let refreshed = false;
    try {
      await writeCompositionAtomic(compositionPath, compositionText(consumerCompositionEntries(eligible.map(({ record }) => record))));
      await adapter.refresh();
      refreshed = true;
    } catch (error) {
      // The first Include refresh is a host availability fact, not proof that
      // the published source is broken. It shares the non-sticky reason with a
      // missing Include, so the eligible rows are retried on the next start
      // instead of being skipped forever as a sticky plugin failure.
      const failure = sharedFailure(error, 'include-unavailable');
      for (const { record } of eligible) {
        rowById.set(record.id, {
          id: record.id,
          status: SHARED_STATUS.FAILED,
          reason: 'include-unavailable',
          sourceSha256: typeof record.sourceSha256 === 'string' ? record.sourceSha256 : null,
          hostDigest: hostDigest(session.host),
          activatedAt: null,
          errorCode: failure.errorCode,
          errorName: failure.errorName,
          errorDigest: failure.errorDigest,
        });
      }
    }

    if (refreshed) {
      // A failed refresh already replaced every eligible row above; only a
      // settled tree allows a per-row verification.
      for (const { record } of eligible) {
        const rowId = `shared-${record.id}`;
        const activeAt = now();
        try {
          const fiber = await verifyConsumerEntry(adapter, rowId, record);
          session.mounted.set(record.id, { rowId, fiber, record });
          rowById.set(record.id, {
            id: record.id,
            status: SHARED_STATUS.ACTIVE,
            reason: null,
            sourceSha256: record.sourceSha256,
            hostDigest: hostDigest(session.host),
            activatedAt: activeAt,
            errorCode: null,
            errorName: null,
            errorDigest: null,
          });
        } catch (error) {
          // Only the plugin's own apply failure is a sticky, per-plugin fact.
          // A missing/mismatched/disabled entry or fiber is a transient defect
          // of the live tree, not proof that the published source is broken:
          // report it non-sticky so the next healthy start retries the row.
          const reason = error?.code === 'E_CONSUMER_PLUGIN_APPLY_FAILED'
            ? 'plugin-apply-failed'
            : 'include-unavailable';
          rowById.set(record.id, decisionRow(record, { status: SHARED_STATUS.FAILED, reason, error }, session.host));
        }
      }

      // Static eligibility cannot prove a plugin will apply. If a replacement
      // failed on the live tree, restore the record it superseded in this same
      // start instead of waiting for another restart; the replacement keeps its
      // failure receipt so the operator can still see why the switch did not land.
      const failed = new Set(eligible
        .filter(({ record }) => rowById.get(record.id)?.status === SHARED_STATUS.FAILED)
        .map(({ record }) => record.id));
      const originalById = new Map(evaluated.map(({ record }) => [record.id, decisions.find((row) => row.record === record)?.decision]));
      const restored = new Map();
      // Walk back one generation at a time: C fails → try B → try A. Each pass
      // rebuilds the official Include subtree from the intended composition.
      // A freshly mounted subtree contains exactly the intended rows, so a
      // failed or superseded version can never survive the fallback and no
      // "settled tree" or live-entry heuristic is needed.
      for (let pass = 0; pass <= evaluated.length && failed.size > 0; pass += 1) {
        const reEvaluated = evaluated.map(({ record, decision }) => ({
          record,
          decision: failed.has(record.id) ? { status: SHARED_STATUS.FAILED, reason: 'plugin-apply-failed' } : decision,
        }));
        const after = applySupersession(reEvaluated, { profile });
        const candidates = [];
        for (const { record, decision } of after) {
          const original = originalById.get(record.id);
          if (decision?.status !== 'eligible' || !original || original.reason !== 'superseded-by'
            || !failed.has(original.supersededBy) || restored.has(record.id) || failed.has(record.id)) continue;
          // The first evaluation marked this record eligible before suppression,
          // so its URL is in the "already mounted" set even though it never was.
          const mountedAt = mountedModuleUrls.indexOf(record.moduleUrl);
          if (mountedAt >= 0) mountedModuleUrls.splice(mountedAt, 1);
          let fallback;
          try {
            fallback = await evaluateSharedRecord({
              paths: resolvedPaths,
              record,
              profile,
              host: session.host,
              capabilities,
              services,
              mountedModuleUrls,
              disableState,
              previousState: previous.state,
              kernelEnabled,
            });
          } catch {
            fallback = null;
          }
          if (fallback?.status === 'eligible') candidates.push(record);
          else failed.add(record.id);
        }
        if (candidates.length === 0) break;
        const surviving = eligible
          .filter(({ record }) => !failed.has(record.id))
          .map(({ record }) => record);
        const intended = [...surviving, ...restored.values(), ...candidates];
        // Rebuild instead of refreshing: dispose the old Include child, prove
        // it released every row, then write the intended composition and mount
        // a fresh subtree. The order is load-bearing: the old child's disposer
        // can flush the composition it was mounted from back to disk, so a
        // write before disposal would be overwritten by that flush. And a
        // disposer that returns without releasing a row would let the new
        // subtree register the same plugin twice, so the release proof gates
        // both the write and the mount.
        let oldReleased = false;
        let rebuildError = null;
        let toolLeftovers = [];
        try {
          // Snapshot the old tree's plugin tools before disposal. The host
          // baseline was captured before our first mount, so anything added
          // since is ours; a name still live after dispose is a leftover.
          const beforeTools = pluginToolNames(ctx, hostBaselineTools);
          await adapter.dispose();
          toolLeftovers = toolSurfaceLeftovers(ctx, hostBaselineTools, beforeTools);
          oldReleased = oldIncludeReleased(
            adapter,
            session.mounted,
            evaluated.map(({ record }) => `shared-${record.id}`),
            { toolLeftovers },
          );
        } catch (error) {
          rebuildError = error;
        }
        if (!oldReleased) session.unreleasedOldTree = true;
        if (oldReleased) {
          // The old subtree is provably gone. Stop pointing at it before
          // mounting the new tree, so a failed/null rebuild never leaves a
          // stale adapter behind.
          session.adapter = null;
          session.mounted.clear();
          try {
            await writeCompositionAtomic(compositionPath, compositionText(consumerCompositionEntries(intended)));
            const rebuilt = await mountIncludeWithRetry();
            if (!rebuilt) return session;
            adapter = rebuilt;
            session.adapter = adapter;
          } catch (error) {
            rebuildError = error;
          }
        } else if (!rebuildError) {
          // dispose() returned, but a plugin tool is still registered, a
          // captured fiber is still active or an old row still resolves. Fail
          // closed without a second subtree. The old adapter and fibers stay on
          // the session so the host's own dispose() can retry them and report
          // an unreleased tree honestly.
          rebuildError = consumerError('E_CONSUMER_OLD_TREE_NOT_RELEASED',
            toolLeftovers.length > 0
              ? `old Include subtree still has live tool registrations after disposal: ${toolLeftovers.join(', ')}`
              : 'old Include subtree still has live rows after disposal');
        }
        if (rebuildError) {
          // No intended row is mounted on a failed rebuild. Report the host
          // fact non-sticky for every row we meant to install, keep the
          // already-recorded plugin failures, and stop this start's fallback
          // instead of claiming an active tree that does not exist. Only a
          // proven-released old tree has had its adapter/fibers cleared above;
          // an unreleased one is deliberately kept for a later disposal retry.
          const failure = sharedFailure(rebuildError, 'include-unavailable');
          for (const record of intended) {
            rowById.set(record.id, {
              id: record.id,
              status: SHARED_STATUS.FAILED,
              reason: 'include-unavailable',
              sourceSha256: typeof record.sourceSha256 === 'string' ? record.sourceSha256 : null,
              hostDigest: hostDigest(session.host),
              activatedAt: null,
              errorCode: failure.errorCode,
              errorName: failure.errorName,
              errorDigest: failure.errorDigest,
            });
          }
          break;
        }
        // Verify the whole new tree, not just the candidate: a surviving row
        // can fail to apply too, and then its own predecessor must be walked
        // back on the next pass. Only a plugin's own apply failure is sticky;
        // a missing/disabled/failed entry is a host-level, non-sticky fact.
        for (const record of intended) {
          const rowId = `shared-${record.id}`;
          try {
            const fiber = await verifyConsumerEntry(adapter, rowId, record);
            session.mounted.set(record.id, { rowId, fiber, record });
            if (candidates.includes(record)) restored.set(record.id, record);
            rowById.set(record.id, {
              id: record.id, status: SHARED_STATUS.ACTIVE, reason: null,
              sourceSha256: record.sourceSha256, hostDigest: hostDigest(session.host), activatedAt: now(),
              errorCode: null, errorName: null, errorDigest: null,
            });
          } catch (error) {
            if (error?.code === 'E_CONSUMER_PLUGIN_APPLY_FAILED') {
              // A row that actually failed to apply is a per-record fact,
              // whether it is the candidate being tried or a surviving row
              // the rebuilt tree installed: drop its mount and let the next
              // pass walk back to the record it superseded.
              failed.add(record.id);
              restored.delete(record.id);
              session.mounted.delete(record.id);
              rowById.set(record.id, decisionRow(record, { status: SHARED_STATUS.FAILED, reason: 'plugin-apply-failed', error }, session.host));
            } else {
              session.mounted.delete(record.id);
              rowById.set(record.id, decisionRow(record, { status: SHARED_STATUS.FAILED, reason: 'include-unavailable', error }, session.host));
            }
          }
        }
      }
    }

    // Report one row per index record, in index order, then the invalid ones.
    // A record that was never a mount candidate keeps its evaluated status.
    session.rows = [
      ...index.records.map((record) => rowById.get(record.id) ?? decisionRow(record, { status: SHARED_STATUS.FAILED, reason: 'not-evaluated' }, session.host)),
      ...index.invalid.map((row) => invalidRow(row, session.host)),
    ];
    if ((index.status === 'invalid' || index.status === 'unreadable') && index.invalid.length === 0) {
      session.rows.push(invalidRow({ id: null, reason: `index-${index.status}` }, session.host));
    }
    await writeState(session.rows, session.indexUpdatedAt);
    return session;
  }

  /**
   * Official disposal: dispose the Include child Fiber (which owns every mounted
   * row), await each captured row's Fiber, then write the consumer state again
   * with the disposal proof. Nothing here throws: a disposal failure is a fact
   * the state file records, not a reason to fail the host's shutdown.
   */
  let disposing;
  function dispose() {
    return disposing ??= disposeOnce();
  }
  async function disposeOnce() {
    session.disposed = true;
    await mounting?.catch(() => {});
    const captured = [...session.mounted.values()];
    const failures = [];
    // Capture the live tree's plugin tools before disposal. Cordis can log a
    // throwing effect disposer and still resolve the child's dispose, leaving
    // its tool registered with no fiber/row evidence — the tool surface is the
    // proof that cannot be faked by a cleared uid or a dropped resolver entry.
    const beforeTools = session.adapter ? pluginToolNames(ctx, hostBaselineTools) : new Set();
    if (session.adapter) {
      try {
        await session.adapter.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    for (const { rowId, fiber } of captured) {
      try {
        if (typeof fiber?.await === 'function') await fiber.await();
        if (fiber && fiber.uid !== null) failures.push(consumerError('E_CONSUMER_FIBER_NOT_RELEASED', `consumer entry fiber was not released: ${rowId}`));
      } catch (error) {
        failures.push(error);
      }
    }
    if (session.adapter) {
      const leftovers = toolSurfaceLeftovers(ctx, hostBaselineTools, beforeTools);
      if (leftovers.length > 0) {
        session.unreleasedOldTree = true;
        failures.push(consumerError('E_CONSUMER_TOOL_SURFACE_NOT_RELEASED',
          `consumer entry tools still registered after disposal: ${leftovers.join(', ')}`));
      }
    }
    const result = { released: failures.length === 0, entries: captured.length };
    session.disposeResult = result;
    // A session that never published its own report (it was disposed during
    // startup, or its own context went inactive before evaluation) must not
    // replace the profile's last published report with an empty or failed one.
    // It only records its own disposal proof on the inherited facts, and keeps
    // the previous owner's session id so that report can still be updated by
    // the host that actually published it.
    const inherited = session.lastState === null ? session.previousState : null;
    const base = session.lastState ?? inherited ?? consumerStateDocument({
      profile,
      host: session.host,
      indexUpdatedAt: session.indexUpdatedAt,
      compositionPath,
      plugins: session.rows,
    });
    const owner = session.lastState === null && typeof inherited?.sessionId === 'string'
      ? inherited.sessionId
      : sessionId;
    try {
      session.lastState = { ...base, sessionId: owner, disposedAt: now(), disposal: { ...result } };
      await writeConsumerState(resolvedPaths, profile, session.lastState, { sessionId });
    } catch (error) {
      session.disposeResult = { ...result, stateWriteFailure: sharedFailure(error, 'consumer-state-write-failed') };
    }
    if (result.released) await fsp.rm(compositionPath, { force: true }).catch(() => {});
    return session.disposeResult;
  }

  return { mount, dispose, session };
}

/**
 * Bundle entry.
 *
 * Inert outside the consumer profiles and never throws: a profile that opted
 * into this entry must survive an unreadable index, an unavailable Include or a
 * failing promoted plugin. The activation record is the report; the host boot
 * is not the place to fail.
 */
export async function apply(ctx, config = {}) {
  let session;
  try {
    const profile = resolveConsumerProfile(ctx, config);
    if (!SHARED_CONSUMER_PROFILES.includes(profile)) return;
    const created = createConsumerSession({ ctx, config, profile });
    session = created.session;
    ctx.effect(() => () => created.dispose(), 'promoted-consumer');
    await created.mount();
  } catch (error) {
    // The consumer is inert by contract on any unexpected failure. When the
    // state file could not be written, the only remaining diagnosis is one
    // contained, redacted warning: no thrown value, no raw plugin text.
    if (!session?.stateWritten) warnConsumerStartup(ctx, error);
  }
}

/**
 * One contained warning for a consumer that failed before writing its state.
 *
 * The invariant-8 logger boundary: a host logger that throws or returns a
 * rejected promise must not turn a failed startup into a second failure or an
 * unhandled rejection. Only the closed reason vocabulary, the host error code
 * and a digest cross this boundary, never the plugin's own text.
 */
function warnConsumerStartup(ctx, error) {
  try {
    const failure = sharedFailure(error, 'consumer-startup');
    const label = failure.errorCode || failure.errorName || 'unknown';
    const logger = ctx?.logger;
    const warn = typeof logger?.warn === 'function' ? logger.warn.bind(logger) : null;
    if (!warn) return;
    Promise.resolve(warn('[evolution] promoted consumer unavailable (%s, digest %s)', label, failure.errorDigest || 'none')).catch(() => {});
  } catch {
    // Logging is advisory; the host boot must not depend on it.
  }
}
