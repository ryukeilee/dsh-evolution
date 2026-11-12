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
import {
  SHARED_CONSUMER_PROFILES,
  SHARED_STATUS,
  captureHostFacts,
  claimConsumerSession,
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
    await writeConsumerState(resolvedPaths, profile, document, { sessionId });
    session.stateWritten = true;
    return document;
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

  async function mountOnce() {
    const previous = await claimConsumerSession(resolvedPaths, profile, sessionId);
    session.previousState = previous.state ?? null;
    // Cancellation before evaluation must not erase inherited plugin failures.
    // Prior active rows are not activation proof for this new host.
    session.rows = (previous.state?.plugins ?? []).filter(row => row.status === SHARED_STATUS.FAILED);
    session.host = captureHostFacts({
      packageOf: hostPackageReader(ctx),
      profile,
      baseUrl: typeof ctx?.baseUrl === 'string' ? ctx.baseUrl : undefined,
    });
    const index = await readSharedIndex(resolvedPaths);
    const disableState = await readDisableState(resolvedPaths);
    session.indexUpdatedAt = index.updatedAt ?? null;

    let adapter;
    try {
      // The consumer composition is derived state: start from an empty list so
      // rows no longer published or now revoked are never mounted with stale
      // entries. The file is ours, per profile, written atomically.
      await writeCompositionAtomic(compositionPath, compositionText([]));
      for (let attempt = 0; ; attempt += 1) {
        if (session.disposed || contextCannotPublish(ctx)) return session;
        // An entry that is already being torn down cannot mount, and its
        // INACTIVE_EFFECT is not a profile or plugin failure. Stop before the
        // mount; disposal keeps the inherited report instead of publishing a
        // failure that would overwrite another live session's activation.
        try {
          adapter = await mountInclude(ctx, { path: compositionPath, initial: [] });
          break;
        } catch (error) {
          // Only the official lifecycle error with proven child cleanup may
          // retry. No plugin source has been placed in this empty Include yet.
          if (error?.code !== 'INACTIVE_EFFECT' || error?.consumerRetrySafe !== true || attempt >= 2) {
            // The retry budget only exists for a startup race in a session that
            // is still alive. If this session's own context went inactive while
            // the mount ran, this is cancellation, not a host failure.
            if (error?.code === 'INACTIVE_EFFECT' && contextCannotPublish(ctx)) return session;
            throw error;
          }
          await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
        }
      }
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
    const decisions = [];
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
      decisions.push({ record, decision });
    }

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
      const failure = sharedFailure(error, 'include-refresh-failed');
      for (const { record } of eligible) {
        rowById.set(record.id, {
          id: record.id,
          status: SHARED_STATUS.FAILED,
          reason: 'include-refresh-failed',
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
          rowById.set(record.id, decisionRow(record, { status: SHARED_STATUS.FAILED, reason: 'plugin-apply-failed', error }, session.host));
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
