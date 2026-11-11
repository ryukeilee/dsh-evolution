/**
 * Cross-entry sharing of verified stable promotions.
 *
 * The Desktop profile is the only promotion authority: it owns the Promotion,
 * Trial, Canary and rollback state machine. This module never decides that a
 * promotion is stable. It starts from durable stable facts that the Desktop
 * kernel already committed (the promotion evidence sidecar, the promoted
 * composition row and the promoted plugin source) and produces one small,
 * atomically written publication index under the shared `$DSH_HOME` data root.
 *
 * A consumer entry in another profile (ACP, Web) only reads that index. It
 * never writes the promotion journal, the canary state, the composition or the
 * domain storage; its own activation record is written to a separate
 * `shared-plugins/consumers/<profile>.json`, so a consumer can never turn a
 * failed load into a Desktop promotion fact.
 *
 * This module is deliberately host-free: it imports only Node builtins. The
 * Desktop publisher and the lightweight consumers both share it, so the record
 * shape, the digest rules and the compatibility decision have exactly one
 * implementation. The consumer entry (`lib/promoted-consumer.js`) adds the
 * Cordis/Include lifecycle around it.
 *
 * Invariants:
 * - A record is only created from a stable commit: `stable.committedAt`, a
 *   satisfied canary window and a `benefit` decision must all be present.
 * - The plugin source is referenced in place. Its bytes are hashed at publish
 *   time and re-hashed before every activation; a mismatch, a symlinked plugin
 *   directory or a path outside `promoted/` is refused.
 * - The index and every consumer state file are written through one atomic
 *   writer, so a concurrent reader sees either the previous complete file or
 *   the next complete file, never a half write.
 * - Republishing the same stable fact is idempotent. A conflicting source digest
 *   for an existing id is refused instead of silently replacing verified bytes.
 * - Historical stable promotions that never recorded explicit cross-entry
 *   approval stay Desktop-only: no record is generated for them.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SHARED_SCHEMA_VERSION = 1;
export const SHARED_KIND = 'dsh-evolution-shared-plugins';
export const SHARED_CONSUMER_KIND = 'dsh-evolution-promoted-consumer';

/** The profiles that can run the promotion authority. Only Desktop does. */
export const SHARED_PROFILES = Object.freeze(['desktop', 'acp', 'web']);
/** The profiles allowed to consume published plugins. Desktop mounts its own. */
export const SHARED_CONSUMER_PROFILES = Object.freeze(['acp', 'web']);

export const SHARED_RECORD_ID = /^evolution-promoted-[a-f0-9]{12}$/;
export const SHARED_EXPERIMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const SHARED_SERVICE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const SHARED_MEMBER_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
export const SHARED_DIGEST = /^[a-f0-9]{64}$/;
export const SHARED_ENTRY = 'lib/index.js';
export const SHARED_PLUGIN_PREFIX = 'dsh-evolution-promoted-';

/**
 * Capabilities a consumer proves on its own live context before it mounts a
 * published plugin. The publisher records the same facts from the Desktop
 * kernel, so a record can only ever require a capability that a real Cordis
 * runtime actually exposed:
 *
 * - `fiberLifecycle`: the public Fiber lifecycle fields used to decide whether
 *   a mounted row is really active.
 * - `fiberAwait`: `Fiber.await()`, used to prove disposal finished.
 * - `include`: the official Loader/Include members used to mount the row
 *   (`EntryTree.resolve`/`await`/`root.data`).
 * - `toolsRegistry`: `ctx.tools.schemas()`, required only by records whose
 *   plugin declares the `tools` service in its `inject` list.
 */
export const SHARED_CAPABILITIES = Object.freeze(['fiberLifecycle', 'fiberAwait', 'include', 'toolsRegistry']);

/** Consumer activation states. Names are the reported diagnostic vocabulary. */
export const SHARED_STATUS = Object.freeze({
  ACTIVE: 'active',
  DISABLED: 'disabled',
  UNNAPPROVED: 'skipped-unapproved',
  INCOMPATIBLE: 'skipped-incompatible',
  INVALID: 'skipped-invalid',
  REVALIDATION: 'pending-revalidation',
  FAILED: 'failed',
  MISSING: 'missing',
});

// Publication is a read-modify-write of one index file. Two Desktop processes
// (or a startup reconciliation racing a stable commit) must not interleave, so
// the index has one small exclusive lock next to it. The owner is proven by
// pid/hostname:
//
// - A same-host owner that is still running is never reclaimed, no matter how
//   old the lock file is. A slow fsync, a paused process or a long publication
//   must not let a second writer into the critical section; the age of the file
//   only describes when the lock was written, not whether its owner is done.
// - A same-host owner that is provably gone is reclaimed at once.
// - A lock that cannot be proven either way (a foreign host, or bytes that are
//   not a readable owner record) is reclaimed only after the stale window, and
//   reclaiming it is serialized by a sibling `<lock>.reclaim` marker: two
//   reclaimers racing over one dead lock must not be able to rename the fresh
//   lock that one of them created after the other removed the dead one.
const PUBLISH_LOCK_STALE_MS = 10_000;
const PUBLISH_LOCK_TIMEOUT_MS = 2_500;
const PUBLISH_LOCK_RETRY_MS = 25;

function delay(ms) {
  // The timer must keep the process alive: while a publication waits for the
  // lock, this timer is often the only pending handle. An unref'd timer made
  // the test runner (and a short-lived caller) consider the event loop settled
  // and cancel the pending publication promise.
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Classify one lock-like file.
 *
 * Only a same-host record with an integer pid is proof of an owner; everything
 * else is `unowned` and can only be reasoned about by age. `stat` is returned
 * so a reclaimer can prove it is looking at the same inode it classified.
 */
async function inspectPublishLock(file) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch (error) {
    return { state: error?.code === 'ENOENT' ? 'absent' : 'unknown', owner: null, stat: null };
  }
  let owner = null;
  try { owner = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { owner = null; }
  if (isObject(owner) && owner.hostname === os.hostname() && Number.isInteger(owner.pid) && owner.pid > 0) {
    return { state: processAlive(owner.pid) ? 'live' : 'dead', owner, stat };
  }
  return { state: 'unowned', owner, stat };
}

/** Whether the inspected lock may be removed. A live owner never may. */
function publishLockIsReclaimable(view) {
  if (view?.state === 'dead') return true;
  if (view?.state !== 'unowned') return false;
  // A different host shares the same $DSH_HOME only through unsupported means;
  // its lock is never reclaimed by pid, only by the stale window. The same
  // window waits out an unreadable or malformed lock instead of guessing.
  return Date.now() - view.stat.mtimeMs > PUBLISH_LOCK_STALE_MS;
}

/**
 * Remove one reclaimable lock under the sibling reclaim marker.
 *
 * The marker is what makes the `rename` safe: while it is held no second
 * reclaimer can act, and a dead owner cannot release the lock it left behind,
 * so the inode this attempt classified is still the one it renames. The lock is
 * renamed (never deleted in place) so `open(..., 'wx')` acquisition is released
 * atomically and a fresh lock created right after the rename is not touched.
 * Returns true when the lock was moved away.
 */
async function reclaimPublishLock(lockPath, view) {
  const marker = `${lockPath}.reclaim`;
  let handle;
  try {
    handle = await fsp.open(marker, 'wx', 0o600);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const held = await inspectPublishLock(marker);
    // A reclaimer holds the marker for one rename. Reclaim it only when its
    // owner is provably gone (a crashed reclaimer), never while it is alive.
    if (held.state === 'dead') await fsp.rm(marker, { force: true }).catch(() => {});
    else if (held.state === 'unowned' && Date.now() - held.stat.mtimeMs > PUBLISH_LOCK_STALE_MS) {
      await fsp.rm(marker, { force: true }).catch(() => {});
    }
    return false;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ token: 'reclaim', pid: process.pid, hostname: os.hostname(), at: nowIso() })}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close().catch(() => {});
  }
  try {
    // Re-classify under the marker. Reclaiming a lock that changed after the
    // first classification would delete another process's new lock.
    const current = await inspectPublishLock(lockPath);
    if (!publishLockIsReclaimable(current)) return false;
    if (current.stat.dev !== view.stat.dev || current.stat.ino !== view.stat.ino) return false;
    const bury = `${lockPath}.${crypto.randomBytes(6).toString('hex')}.stale`;
    try {
      await fsp.rename(lockPath, bury);
    } catch {
      return false;
    }
    await fsp.rm(bury, { force: true }).catch(() => {});
    return true;
  } finally {
    await fsp.rm(marker, { force: true }).catch(() => {});
  }
}

/** Acquire the index publication lock; returns the release function. */
async function acquirePublishLock(paths) {
  const { lockPath } = sharingPaths(paths);
  await fsp.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = crypto.randomUUID();
  const payload = `${JSON.stringify({ token, pid: process.pid, hostname: os.hostname(), at: new Date().toISOString() })}\n`;
  const deadline = Date.now() + PUBLISH_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await fsp.open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(payload, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      // Prove this call still owns the path before entering the critical
      // section. A process paused between `open(...,'wx')` and the payload write
      // leaves an empty lock that another process may reclaim by age; the write
      // then lands in the detached inode, and publishing under a lock someone
      // else now holds is the lost-update this lock exists to prevent.
      let owned;
      try { owned = JSON.parse(await fsp.readFile(lockPath, 'utf8')); } catch { owned = null; }
      if (owned?.token !== token) continue;
      return async () => {
        try {
          const owner = JSON.parse(await fsp.readFile(lockPath, 'utf8'));
          if (owner?.token === token) await fsp.rm(lockPath, { force: true });
        } catch {
          // The lock is gone or unreadable; never remove a lock this call cannot
          // prove it owns (a reclaim may already have taken it over).
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const view = await inspectPublishLock(lockPath);
      if (publishLockIsReclaimable(view) && await reclaimPublishLock(lockPath, view)) continue;
      if (Date.now() > deadline) {
        const busy = new Error('another process is publishing shared plugins');
        busy.code = 'E_SHARED_PUBLISH_BUSY';
        throw busy;
      }
      await delay(PUBLISH_LOCK_RETRY_MS);
    }
  }
}

// ---------------------------------------------------------------------------
// paths and small utilities
// ---------------------------------------------------------------------------

/**
 * Sharing paths under the same data root the Desktop kernel and the consumers
 * already share. `dataRoot` is `<DSH_HOME>/storages/evolution`, so every entry
 * on the machine sees the same publication index through the same `$DSH_HOME`.
 */
export function sharingPaths(paths = {}) {
  const dataRoot = path.resolve(paths.dataRoot || paths.presetDir || '');
  if (!dataRoot) throw new Error('Shared plugin paths require a data root');
  const dir = path.join(dataRoot, 'shared-plugins');
  return {
    dataRoot,
    dir,
    indexPath: path.join(dir, 'published.json'),
    disablePath: path.join(dir, 'disabled.json'),
    consumersDir: path.join(dir, 'consumers'),
    statePath: (profile) => path.join(dir, 'consumers', `${safeProfile(profile)}.json`),
    compositionPath: (profile) => path.join(dir, 'consumers', `${safeProfile(profile)}.cordis.yml`),
    lockPath: path.join(dir, '.publish.lock'),
  };
}

function safeProfile(profile) {
  if (!SHARED_CONSUMER_PROFILES.includes(profile) && !SHARED_PROFILES.includes(profile)) {
    throw new Error(`Unknown DSH profile for shared plugin state: ${String(profile)}`);
  }
  return profile;
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value, limit = 200) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * A bounded, credential-free failure projection for consumer state.
 *
 * The consumer must record why a plugin was skipped, but it must not copy a
 * plugin's thrown text (which can quote anything) into its state file. Only a
 * closed reason vocabulary, the numeric/identifier host error code and a digest
 * of the raw value cross this boundary; `reason` is supplied by the caller.
 */
export function sharedFailure(error, reason) {
  const code = typeof error?.code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(error.code) ? error.code : null;
  const name = typeof error?.name === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(error.name) ? error.name : null;
  let digest = null;
  try {
    const raw = typeof error?.message === 'string' ? error.message : String(error ?? '');
    digest = sha256(raw.slice(0, 64 * 1024));
  } catch {
    digest = null;
  }
  return { reason, errorCode: code, errorName: name, errorDigest: digest };
}

/** One atomic, optionally durable file replacement. */
async function writeFileAtomic(file, content, { durable = true } = {}) {
  const directory = path.dirname(file);
  const existed = await pathExists(directory);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = path.join(directory, `.shared-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    const handle = await fsp.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      if (durable) await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(temp, file);
    if (durable) {
      await syncDirectory(directory);
      if (!existed) await syncDirectory(path.dirname(directory));
    }
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fsp.open(directory, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is a durability improvement, not a correctness gate: the
    // rename already published a complete file atomically. Platforms without
    // directory handles keep working; a crash then loses at most the newest
    // publication and the next startup republishes it from stable facts.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function pathExists(file) {
  try { await fsp.lstat(file); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

// ---------------------------------------------------------------------------
// host facts
// ---------------------------------------------------------------------------

/**
 * Exact host identity a promotion was verified on.
 *
 * `packageOf(name, baseUrl)` is the official `pluginPackages` service method
 * (`PluginPackages.packageOf`), so the versions are read from the packages the
 * booted host actually resolved, not guessed from a version string or a PATH
 * lookup. Missing packages stay `null` and make the record unverifiable, which
 * is reported instead of being treated as compatible.
 */
export function captureHostFacts({ packageOf, profile, baseUrl } = {}) {
  const read = (name) => {
    try {
      const found = typeof packageOf === 'function' ? packageOf(name, baseUrl) : null;
      return typeof found?.version === 'string' && found.version.trim() !== '' ? found.version.trim() : null;
    } catch {
      return null;
    }
  };
  return {
    profile: typeof profile === 'string' && profile.trim() !== '' ? profile.trim() : null,
    dsh: read('@deepseek-ai/dsh'),
    cordis: read('@deepseek-ai/cordis'),
    include: read('@deepseek-ai/cordis-plugin-include'),
    node: process.version,
    capturedAt: nowIso(),
  };
}

/**
 * The live capabilities a consumer proves before mounting. The Include half is
 * taken from the mounted adapter's recorded `capabilities`, i.e. from the
 * official loader members that were really reachable, not from a package
 * version comparison.
 */
export function probeSharedCapabilities({ ctx, includeCapabilities } = {}) {
  const fiber = ctx?.fiber;
  const lifecycle = Boolean(fiber)
    && ['state', 'uid', 'inject', 'inertia'].every((field) => field in fiber)
    && ('store' in fiber || 'committed' in fiber);
  return {
    fiberLifecycle: lifecycle,
    fiberAwait: typeof fiber?.await === 'function',
    include: Boolean(includeCapabilities?.entryResolver && includeCapabilities?.treeAwait && includeCapabilities?.liveRootEntries),
    toolsRegistry: typeof ctx?.tools?.schemas === 'function',
  };
}

/**
 * Compare a recorded host identity with the live one.
 *
 * The DSH release is pinned exactly (the bundle's own `peerDependencies`
 * contract is exact versions), while Cordis and the official Include only
 * require a matching `major.minor`: their patch releases are compatible by
 * semantic versioning but the recorded capability probes still have to answer
 * every recorded capability on the live context. That combination is what makes
 * a version bump safe without pretending the capability set never changes.
 */
export function hostCompatible(recorded, current) {
  if (!isObject(recorded) || !isObject(current)) return { ok: false, reason: 'host-facts-missing' };
  if (typeof recorded.dsh !== 'string' || recorded.dsh !== current.dsh) return { ok: false, reason: 'host-version-mismatch' };
  if (majorMinor(recorded.cordis) !== majorMinor(current.cordis)) return { ok: false, reason: 'cordis-version-mismatch' };
  if (majorMinor(recorded.include) !== majorMinor(current.include)) return { ok: false, reason: 'include-version-mismatch' };
  if (nodeMajor(recorded.node) !== nodeMajor(current.node)) return { ok: false, reason: 'node-version-mismatch' };
  return { ok: true, reason: null };
}

function majorMinor(version) {
  if (typeof version !== 'string') return null;
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  return match ? `${match[1]}.${match[2]}` : null;
}

function nodeMajor(version) {
  if (typeof version !== 'string') return null;
  const match = /^v?(\d+)/.exec(version.trim());
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// record construction (Desktop publisher)
// ---------------------------------------------------------------------------

function assertSafeArray(values, predicate) {
  return Array.isArray(values) && values.every((value) => typeof value === 'string' && predicate(value));
}

function stableRecordId(rowId) {
  return typeof rowId === 'string' && SHARED_RECORD_ID.test(rowId) ? rowId : null;
}

/**
 * Build one publication record from a stable promotion.
 *
 * Inputs are the durable facts the Desktop kernel already wrote: `experiment`
 * (in-memory record, for the proposal/owner lineage), `durable` (the committed
 * plugin identity) and, on the recovery path, the promotion journal. The
 * function refuses everything that is not a verified stable commit; it never
 * upgrades a canary-pending or rolled-back promotion.
 */

/**
 * A verified publication identity: the exact bytes the promotion wrote and the
 * host that was asked to verify them. It is captured once, at promotion time,
 * and travels with the durable stable fact, so a later republish can never
 * adopt a modified source file or an upgraded host as "verified".
 */
export function normalizePublication(value) {
  if (!isObject(value)) return null;
  if (!SHARED_DIGEST.test(String(value.sourceSha256 ?? ''))) return null;
  if (!SHARED_DIGEST.test(String(value.manifestSha256 ?? ''))) return null;
  const host = value.host;
  if (!isObject(host)
    || typeof host.dsh !== 'string'
    || typeof host.cordis !== 'string'
    || typeof host.include !== 'string'
    || typeof host.node !== 'string') return null;
  return {
    sourceSha256: value.sourceSha256,
    manifestSha256: value.manifestSha256,
    verifiedAt: typeof value.verifiedAt === 'string' ? value.verifiedAt : null,
    host: {
      profile: typeof host.profile === 'string' ? host.profile : null,
      dsh: host.dsh,
      cordis: host.cordis,
      include: host.include,
      node: host.node,
      capturedAt: typeof host.capturedAt === 'string' ? host.capturedAt : null,
    },
  };
}

/**
 * Normalize a Cordis `inject` export.
 *
 * Cordis accepts a plain array (every entry required) and, in the shipped 4.x
 * API, an object that maps each **service name** to optional intercept config
 * (`Inject<M> = (keyof M)[] | { [K in keyof M]?: M[K] }`). Flattening only the
 * array form silently turned an object-declared dependency into "no
 * dependencies", so the consumer mounted a plugin whose required service was
 * absent and recorded a sticky failure instead of skipping it up front. The
 * object form is therefore read as its own service-name keys, which is what
 * `Inject.resolve()` and the fiber dependency resolution use as well.
 */
export function normalizeInjectDeclarations(inject) {
  if (Array.isArray(inject)) {
    return { required: uniqueServiceNames(inject), error: null };
  }
  if (isObject(inject)) {
    return { required: uniqueServiceNames(Object.keys(inject)), error: null };
  }
  return { required: [], error: null };
}

function uniqueServiceNames(values) {
  return [...new Set(values.filter((name) => typeof name === 'string' && SHARED_SERVICE_NAME.test(name)))];
}

export async function buildSharedRecord({ paths, experiment, durable, journal = null, approvedProfiles = [], host = null, capabilities = null, source = {}, requirePublication = false } = {}) {
  if (!paths?.pluginRoot || !(paths?.dataRoot || paths?.presetDir)) throw new Error('Shared plugin publication requires the evolution data root');
  const pluginName = typeof durable?.pluginName === 'string' ? durable.pluginName : null;
  const rowId = stableRecordId(durable?.rowId);
  const moduleUrl = typeof durable?.moduleUrl === 'string' ? durable.moduleUrl : null;
  const experimentId = typeof experiment?.id === 'string' ? experiment.id : typeof journal?.experimentId === 'string' ? journal.experimentId : null;
  if (!pluginName || !rowId || !moduleUrl) throw new Error('Shared plugin publication requires a committed plugin identity');
  if (!experimentId || !SHARED_EXPERIMENT_ID.test(experimentId)) throw new Error('Shared plugin publication requires a safe experiment id');
  if (!Array.isArray(approvedProfiles) || approvedProfiles.some((profile) => !SHARED_CONSUMER_PROFILES.includes(profile))) {
    throw new Error('Shared plugin publication requires consumer profiles from: acp, web');
  }
  const profiles = [...new Set(approvedProfiles)];
  if (profiles.length === 0) throw new Error('Desktop-only promotions are not published');
  // Stable proof: the canary must have closed its window with a startup check
  // and a benefit decision, and the durable commit time must be present.
  const canary = mergeCanaryProof(journal?.canary, experiment?.canary, source.canary);
  const hip = Number(canary?.healthObservationWindow);
  const observations = Array.isArray(canary?.observations) ? canary.observations.length : 0;
  const committedAt = source.stableCommittedAt || experiment?.stableCommittedAt || null;
  const decisionKind = decisionKindOf(experiment, journal, source);
  if (!committedAt) throw new Error('Shared plugin publication requires a stable commit time');
  if (canary?.startupVerified !== true) throw new Error('Shared plugin publication requires a verified startup canary');
  if (!Number.isFinite(hip) || hip < 1 || observations < hip) throw new Error('Shared plugin publication requires a satisfied canary health window');
  if (decisionKind !== 'benefit') throw new Error('Shared plugin publication requires the canary benefit decision');

  // The verification identity is the one captured when the promotion was
  // written (source/manifest digests and host facts), never the reconciler's
  // current view. Republishing after a crash must not launder a changed source
  // or a new host into a "verified" record; when the identity is required
  // (startup reconciliation) a missing one refuses the publication.
  const publication = normalizePublication(source.publication ?? journal?.publication ?? durable?.publication ?? experiment?.publication);
  if (requirePublication && !publication) throw new Error('Shared plugin publication requires the verified publication identity');
  const plugin = await readPromotedPlugin(paths, { pluginName, moduleUrl, entry: SHARED_ENTRY });
  if (publication) {
    if (plugin.sourceSha256 !== publication.sourceSha256) throw new Error('Shared plugin source differs from the verified promotion source');
    if (plugin.manifestSha256 !== publication.manifestSha256) throw new Error('Shared plugin manifest differs from the verified promotion manifest');
  }
  const moduleNamespace = await import(pathToFileURL(plugin.modulePath).href);
  const injectDeclaration = normalizeInjectDeclarations(moduleNamespace?.inject);
  if (injectDeclaration.error) throw new Error(injectDeclaration.error);
  const requiredServices = injectDeclaration.required;
  const declared = isObject(moduleNamespace?.requires) ? moduleNamespace.requires : null;
  const serviceMembers = declared && isObject(declared.services)
    ? Object.fromEntries(Object.entries(declared.services)
        .filter(([name, members]) => SHARED_SERVICE_NAME.test(name) && assertSafeArray(members, (member) => SHARED_MEMBER_NAME.test(member)))
        .map(([name, members]) => [name, [...new Set(members)]]))
    : {};
  const requiredCapabilities = Object.entries(capabilities || {})
    .filter(([name, ok]) => SHARED_CAPABILITIES.includes(name) && ok === true)
    .map(([name]) => name);
  const missingCore = ['fiberLifecycle', 'fiberAwait', 'include'].filter((name) => !requiredCapabilities.includes(name));
  if (missingCore.length > 0) {
    throw new Error('Shared plugin publication requires every official lifecycle capability');
  }
  if (!requiredServices.includes('tools') && requiredCapabilities.includes('toolsRegistry')) {
    // The tools registry is only relevant to a plugin that injects tools; keep
    // the record's requirement list minimal so an unrelated host without tools
    // is not reported incompatible for a plugin that never used it.
    requiredCapabilities.splice(requiredCapabilities.indexOf('toolsRegistry'), 1);
  } else if (requiredServices.includes('tools') && !requiredCapabilities.includes('toolsRegistry')) {
    throw new Error('Shared plugin publication requires the tools registry capability for a tools-injecting plugin');
  }
  const verifiedHost = publication?.host || host;
  if (!isObject(verifiedHost)
    || typeof verifiedHost.dsh !== 'string'
    || typeof verifiedHost.cordis !== 'string'
    || typeof verifiedHost.include !== 'string'
    || typeof verifiedHost.node !== 'string') {
    throw new Error('Shared plugin publication requires a resolved host identity');
  }
  return {
    id: rowId,
    schemaVersion: SHARED_SCHEMA_VERSION,
    experimentId,
    pluginName,
    moduleUrl,
    entry: SHARED_ENTRY,
    sourceSha256: plugin.sourceSha256,
    manifestSha256: plugin.manifestSha256,
    publisherProfile: verifiedHost?.profile || 'desktop',
    approvedProfiles: profiles,
    stable: {
      committedAt: String(committedAt),
      promotionTimestamp: durable?.promotionTimestamp || canary?.promotionTimestamp || null,
      decision: decisionKind,
      canary: {
        healthObservationWindow: hip,
        observations,
        startupVerified: canary.startupVerified === true,
      },
    },
    requiredServices,
    serviceMembers,
    requiredCapabilities,
    hostOnly: true,
    publicationVerifiedAt: publication?.verifiedAt || publication?.at || null,
    host: verifiedHost ? {
      dsh: verifiedHost.dsh ?? null,
      cordis: verifiedHost.cordis ?? null,
      include: verifiedHost.include ?? null,
      node: verifiedHost.node ?? null,
      verifiedAt: verifiedHost.capturedAt || publication?.verifiedAt || nowIso(),
    } : null,
    revalidation: [],
    publishedAt: nowIso(),
  };
}

function mergeCanaryProof(...candidates) {
  const rows = candidates.filter((row) => isObject(row));
  if (rows.length === 0) return null;
  const observations = [];
  const seen = new Set();
  for (const row of rows) {
    for (const observation of Array.isArray(row.observations) ? row.observations : []) {
      const key = typeof observation?.barrierId === 'string' ? observation.barrierId : JSON.stringify(observation);
      if (seen.has(key)) continue;
      seen.add(key);
      observations.push(observation);
    }
  }
  return {
    ...rows[0],
    observations,
    startupVerified: rows.some((row) => row.startupVerified === true),
    healthObservationWindow: rows.map((row) => Number(row.healthObservationWindow)).find((value) => Number.isFinite(value) && value > 0) ?? null,
    promotionTimestamp: rows.map((row) => row.promotionTimestamp).find((value) => typeof value === 'string') ?? null,
  };
}

function decisionKindOf(experiment, journal, source = {}) {
  const inMemory = experiment?.decision?.kind;
  if (typeof inMemory === 'string') return inMemory;
  const fromSource = source.decision?.kind;
  if (typeof fromSource === 'string') return fromSource;
  const snapshot = journal?.evidenceSnapshot;
  const snapKind = snapshot?.decision?.kind;
  if (typeof snapKind === 'string') return snapKind;
  // A journal in the `stable-committed` phase can only have been written after
  // the canary window completed and the benefit decision was assigned, so the
  // phase itself is the durable stable proof on the recovery path.
  if (journal?.phase === 'stable-committed') return 'benefit';
  return null;
}

/**
 * Read the promoted plugin in place. The path is derived from the committed
 * identity, never from the record's own `moduleUrl` alone, and every component
 * is checked so a symlink or a `../` cannot move the read outside `promoted/`.
 */
export async function readPromotedPlugin(paths, { pluginName, moduleUrl, entry = SHARED_ENTRY } = {}) {
  if (typeof pluginName !== 'string' || !pluginName.startsWith(SHARED_PLUGIN_PREFIX)) throw new Error('Shared plugin source name is not a promoted plugin name');
  if (pluginName !== path.basename(pluginName)) throw new Error('Shared plugin source name is not a plain directory name');
  const root = path.resolve(paths.pluginRoot);
  const pluginDir = path.join(root, pluginName);
  // The directory itself must be a real directory. Comparing realpath() to the
  // configured path would also reject a data root that is legitimately reached
  // through a platform symlink (for example /var -> /private/var on macOS), so
  // the check is the entry's own type, not its parent's path spelling.
  const dirStat = await fsp.lstat(pluginDir).catch(() => null);
  if (!dirStat?.isDirectory() || dirStat.isSymbolicLink()) throw new Error('Shared plugin directory is missing or reached through a symbolic link');
  const modulePath = path.join(pluginDir, ...entry.split('/'));
  const moduleStat = await fsp.lstat(modulePath).catch(() => null);
  if (!moduleStat?.isFile() || moduleStat.isSymbolicLink()) throw new Error('Shared plugin entry is missing or a symbolic link');
  const manifestPath = path.join(pluginDir, 'package.json');
  const manifestStat = await fsp.lstat(manifestPath).catch(() => null);
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink()) throw new Error('Shared plugin manifest is missing or a symbolic link');
  const expectedUrl = pathToFileURL(modulePath).href;
  if (typeof moduleUrl === 'string' && moduleUrl !== expectedUrl) throw new Error('Shared plugin module URL does not match the promoted plugin directory');
  if (!path.resolve(modulePath).startsWith(`${path.resolve(pluginDir)}${path.sep}`)) throw new Error('Shared plugin entry escapes its directory');
  const moduleBytes = await fsp.readFile(modulePath);
  const manifestBytes = await fsp.readFile(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error('Shared plugin manifest is not valid JSON');
  }
  if (manifest?.name !== pluginName) throw new Error('Shared plugin manifest name does not match its directory');
  return {
    pluginDir,
    modulePath,
    manifestPath,
    moduleBytes,
    manifestBytes,
    sourceSha256: sha256(moduleBytes),
    manifestSha256: sha256(manifestBytes),
    moduleUrl: expectedUrl,
  };
}

// ---------------------------------------------------------------------------
// publication index
// ---------------------------------------------------------------------------

/** Strict per-record validation; returns a reason instead of throwing. */
export function validateSharedRecord(record, paths = {}) {
  const fail = (reason) => ({ ok: false, reason });
  if (!isObject(record)) return fail('record-not-an-object');
  if (record.schemaVersion !== SHARED_SCHEMA_VERSION) return fail('record-schema-version');
  if (!SHARED_RECORD_ID.test(String(record.id ?? ''))) return fail('record-id');
  if (!SHARED_EXPERIMENT_ID.test(String(record.experimentId ?? ''))) return fail('record-experiment-id');
  // The record id is `evolution-promoted-<12 hex>`; the promoted directory is
  // the same identity with the bundle's `dsh-` package prefix.
  const expectedPluginName = `dsh-${record.id}`;
  if (record.pluginName !== expectedPluginName) return fail('record-plugin-name');
  if (record.entry !== SHARED_ENTRY) return fail('record-entry');
  if (!SHARED_DIGEST.test(String(record.sourceSha256 ?? ''))) return fail('record-source-digest');
  if (!SHARED_DIGEST.test(String(record.manifestSha256 ?? ''))) return fail('record-manifest-digest');
  if (!SHARED_PROFILES.includes(record.publisherProfile)) return fail('record-publisher-profile');
  if (!Array.isArray(record.approvedProfiles) || record.approvedProfiles.length === 0) return fail('record-approved-profiles');
  if (record.approvedProfiles.some((profile) => !SHARED_CONSUMER_PROFILES.includes(profile))) return fail('record-approved-profiles');
  if (!isObject(record.stable) || typeof record.stable.committedAt !== 'string' || record.stable.committedAt === '') return fail('record-stable-proof');
  if (record.stable.decision !== 'benefit') return fail('record-stable-decision');
  if (!isObject(record.stable.canary) || record.stable.canary.startupVerified !== true) return fail('record-stable-startup');
  const window = Number(record.stable.canary.healthObservationWindow);
  const observations = Number(record.stable.canary.observations);
  if (!Number.isFinite(window) || window < 1 || !Number.isFinite(observations) || observations < window) return fail('record-stable-window');
  if (!Array.isArray(record.requiredServices) || record.requiredServices.some((name) => !SHARED_SERVICE_NAME.test(String(name)))) return fail('record-required-services');
  if (record.publicationVerifiedAt !== undefined && record.publicationVerifiedAt !== null && typeof record.publicationVerifiedAt !== 'string') return fail('record-publication-verified-at');
  if (!isObject(record.serviceMembers)) return fail('record-service-members');
  for (const [name, members] of Object.entries(record.serviceMembers)) {
    if (!SHARED_SERVICE_NAME.test(name)) return fail('record-service-members');
    if (!assertSafeArray(members, (member) => SHARED_MEMBER_NAME.test(member))) return fail('record-service-members');
  }
  if (!Array.isArray(record.requiredCapabilities) || record.requiredCapabilities.some((name) => !SHARED_CAPABILITIES.includes(name))) return fail('record-capabilities');
  if (!record.requiredCapabilities.includes('fiberLifecycle') || !record.requiredCapabilities.includes('fiberAwait') || !record.requiredCapabilities.includes('include')) return fail('record-capabilities');
  if (record.hostOnly !== true) return fail('record-host-only');
  if (!isObject(record.host) || typeof record.host.dsh !== 'string' || typeof record.host.cordis !== 'string' || typeof record.host.include !== 'string' || typeof record.host.node !== 'string') return fail('record-host');
  if (record.revalidation !== undefined && (!Array.isArray(record.revalidation) || record.revalidation.some((row) => !isObject(row)))) return fail('record-revalidation');
  if (typeof record.publishedAt !== 'string' || record.publishedAt === '') return fail('record-published-at');
  const derivedDir = paths.pluginRoot ? path.join(paths.pluginRoot, record.pluginName) : null;
  if (derivedDir && !path.resolve(derivedDir).startsWith(`${path.resolve(paths.pluginRoot)}${path.sep}`)) return fail('record-source-path');
  if (typeof record.moduleUrl !== 'string' || !record.moduleUrl.startsWith('file:')) return fail('record-module-url');
  try {
    const file = fileURLToPath(record.moduleUrl);
    if (!file.startsWith(`${path.resolve(derivedDir)}${path.sep}`)) return fail('record-module-path');
  } catch {
    return fail('record-module-url');
  }
  return { ok: true, reason: null };
}

/**
 * Read the publication index.
 *
 * An absent index is a normal Desktop-only install. An unreadable or malformed
 * index is reported, never guessed around: consumers treat it as "nothing is
 * approved". A single malformed record does not discard the valid ones, so one
 * bad publication cannot stop an unrelated verified plugin from activating.
 */
export async function readSharedIndex(paths) {
  const { indexPath } = sharingPaths(paths);
  let bytes;
  try {
    bytes = await fsp.readFile(indexPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'absent', index: null, records: [], invalid: [], updatedAt: null, digest: null };
    return { status: 'unreadable', index: null, records: [], invalid: [], updatedAt: null, digest: null, error: sharedFailure(error, 'index-unreadable') };
  }
  let index;
  try {
    index = JSON.parse(bytes);
  } catch {
    return { status: 'invalid', index: null, records: [], invalid: [{ index: null, reason: 'index-not-json' }], updatedAt: null, digest: sha256(bytes) };
  }
  const invalid = [];
  if (!isObject(index) || index.schemaVersion !== SHARED_SCHEMA_VERSION || index.kind !== SHARED_KIND || !Array.isArray(index.plugins)) {
    return { status: 'invalid', index: null, records: [], invalid: [{ index: null, reason: 'index-shape' }], updatedAt: null, digest: sha256(bytes) };
  }
  const records = [];
  const seen = new Set();
  index.plugins.forEach((record, position) => {
    const verdict = validateSharedRecord(record, paths);
    if (!verdict.ok) { invalid.push({ index: position, id: record?.id ?? null, reason: verdict.reason }); return; }
    if (seen.has(record.id)) { invalid.push({ index: position, id: record.id, reason: 'duplicate-id' }); return; }
    seen.add(record.id);
    records.push(record);
  });
  return {
    status: 'ok',
    index,
    records,
    invalid,
    updatedAt: typeof index.updatedAt === 'string' ? index.updatedAt : null,
    digest: sha256(bytes),
  };
}

/**
 * Publish one record, idempotently.
 *
 * - A missing index is created.
 * - The same stable fact (identical source digest and identity) is a no-op.
 * - A record whose source digest disagrees with the already published bytes is
 *   refused: verified bytes are never silently replaced by a different file.
 *
 * The read-modify-write is CAS-like: the file is captured, the new document is
 * built from that capture, and the write is retried when the file changed under
 * us. Desktop publishes a handful of records at a time, so bounded retries are
 * enough and no second lock protocol is introduced.
 */
export async function publishSharedRecord(paths, record, { maxAttempts = 3 } = {}) {
  const verdict = validateSharedRecord(record, paths);
  if (!verdict.ok) return { status: 'refused', reason: verdict.reason };
  const out = sharingPaths(paths);
  const release = await acquirePublishLock(paths);
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const current = await readSharedIndex(paths);
      if (current.status === 'invalid' || current.status === 'unreadable') return { status: 'refused', reason: `index-${current.status}` };
      const index = current.index ?? { schemaVersion: SHARED_SCHEMA_VERSION, kind: SHARED_KIND, updatedAt: nowIso(), publisher: { profile: record.publisherProfile }, plugins: [] };
      const existingIndex = index.plugins.findIndex((row) => row?.id === record.id);
      let nextRecord = record;
      if (existingIndex >= 0) {
        const existing = index.plugins[existingIndex];
        if (typeof existing?.sourceSha256 === 'string' && existing.sourceSha256 !== record.sourceSha256) {
          return { status: 'conflict', reason: 'source-digest-conflict' };
        }
        const merged = mergeSharedRecord(existing, record);
        if (isDeepStrictEqualJson(merged, existing)) return { status: 'unchanged', record: existing };
        nextRecord = merged;
      }
      const plugins = existingIndex >= 0
        ? index.plugins.map((row, position) => (position === existingIndex ? nextRecord : row))
        : [...index.plugins, nextRecord];
      const nextIndex = {
        ...index,
        schemaVersion: SHARED_SCHEMA_VERSION,
        kind: SHARED_KIND,
        updatedAt: nowIso(),
        publisher: { ...(isObject(index.publisher) ? index.publisher : {}), profile: record.publisherProfile },
        plugins,
      };
      await writeFileAtomic(out.indexPath, `${JSON.stringify(nextIndex, null, 2)}\n`);
      // Verify the merge actually landed. The lock already serializes writers;
      // this read-back still fails closed if a writer outside this protocol (or
      // a rollback of the rename) left the index without our record.
      const verify = await readSharedIndex(paths);
      const landed = verify.records.find((row) => row.id === record.id);
      if (landed && landed.sourceSha256 === nextRecord.sourceSha256) {
        return { status: existingIndex >= 0 ? 'updated' : 'published', record: nextRecord };
      }
    }
    return { status: 'conflict', reason: 'index-changed-concurrently' };
  } finally {
    await release();
  }
}

function isDeepStrictEqualJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Merge a republish onto an existing record instead of replacing it.
 *
 * The verified identity, source digest and stable proof are immutable. A
 * republish may add revalidation generations (after a host upgrade) and refresh
 * nothing else; the first publication time is kept so the record's origin stays
 * auditable.
 */
function mergeSharedRecord(existing, record) {
  const revalidation = [...(Array.isArray(existing.revalidation) ? existing.revalidation : [])];
  for (const row of Array.isArray(record.revalidation) ? record.revalidation : []) {
    if (!revalidation.some((known) => isDeepStrictEqualJson(known, row))) revalidation.push(row);
  }
  // Keep the recorded verification time when the host identity did not change:
  // a plain republish of the same stable fact must be a byte-identical no-op,
  // and it must not overwrite a revalidation generation's host identity that was
  // adopted from real isolated-host evidence.
  const sameHost = isObject(existing.host) && isObject(record.host)
    && ['dsh', 'cordis', 'include', 'node'].every((key) => existing.host[key] === record.host[key]);
  return {
    ...record,
    host: sameHost ? existing.host : record.host,
    publishedAt: typeof existing.publishedAt === 'string' ? existing.publishedAt : record.publishedAt,
    revalidation,
  };
}

/** True when the index changed after the consumer started. */
export function indexChangedSince(indexUpdatedAt, consumerState) {
  const observed = consumerState?.observedIndexUpdatedAt;
  if (!indexUpdatedAt || !observed) return false;
  return indexUpdatedAt !== observed;
}

// ---------------------------------------------------------------------------
// per-profile disable (operator revocation)
// ---------------------------------------------------------------------------

export async function readDisableState(paths) {
  const { disablePath } = sharingPaths(paths);
  let bytes;
  try {
    bytes = await fsp.readFile(disablePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'absent', entries: [] };
    return { status: 'unreadable', entries: [], error: sharedFailure(error, 'disable-state-unreadable') };
  }
  let value;
  try {
    value = JSON.parse(bytes);
  } catch {
    return { status: 'invalid', entries: [] };
  }
  if (!isObject(value) || value.schemaVersion !== SHARED_SCHEMA_VERSION || !Array.isArray(value.entries)) return { status: 'invalid', entries: [] };
  const entries = value.entries.filter((entry) => isObject(entry)
    && SHARED_RECORD_ID.test(String(entry.pluginId ?? ''))
    && SHARED_CONSUMER_PROFILES.includes(entry.profile)
    && typeof entry.disabledAt === 'string');
  return { status: 'ok', entries, updatedAt: value.updatedAt ?? null };
}

export function isDisabledForProfile(disableState, pluginId, profile) {
  return Array.isArray(disableState?.entries)
    && disableState.entries.some((entry) => entry.pluginId === pluginId && entry.profile === profile);
}

export async function setDisabledForProfile(paths, { pluginId, profile, disabled, reason = 'operator' } = {}) {
  if (!SHARED_RECORD_ID.test(String(pluginId ?? ''))) throw new Error('Shared plugin id is invalid');
  if (!SHARED_CONSUMER_PROFILES.includes(profile)) throw new Error('Only ACP and Web can be revoked');
  const current = await readDisableState(paths);
  const entries = (current.entries || []).filter((entry) => !(entry.pluginId === pluginId && entry.profile === profile));
  if (disabled) entries.push({ pluginId, profile, disabledAt: nowIso(), reason: boundedText(reason, 120) || 'operator' });
  const { disablePath } = sharingPaths(paths);
  const next = { schemaVersion: SHARED_SCHEMA_VERSION, kind: 'dsh-evolution-shared-plugin-disable', updatedAt: nowIso(), entries };
  await writeFileAtomic(disablePath, `${JSON.stringify(next, null, 2)}\n`);
  return { ok: true, disabled, entries };
}

// ---------------------------------------------------------------------------
// consumer state (written only by a consumer entry)
// ---------------------------------------------------------------------------

export async function readConsumerState(paths, profile) {
  const out = sharingPaths(paths);
  const file = out.statePath(profile);
  let bytes;
  try {
    bytes = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'absent', state: null };
    return { status: 'unreadable', state: null, error: sharedFailure(error, 'consumer-state-unreadable') };
  }
  let value;
  try {
    value = JSON.parse(bytes);
  } catch {
    return { status: 'invalid', state: null };
  }
  if (!isObject(value) || value.schemaVersion !== SHARED_SCHEMA_VERSION || value.kind !== SHARED_CONSUMER_KIND || value.profile !== profile || !Array.isArray(value.plugins)) {
    return { status: 'invalid', state: null };
  }
  return { status: 'ok', state: value };
}

export async function writeConsumerState(paths, profile, state) {
  const out = sharingPaths(paths);
  const file = out.statePath(profile);
  await writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
  return file;
}

/** Build the loopback-free state document a consumer writes after one start. */
export function consumerStateDocument({ profile, host, indexUpdatedAt, compositionPath, plugins }) {
  return {
    schemaVersion: SHARED_SCHEMA_VERSION,
    kind: SHARED_CONSUMER_KIND,
    profile,
    updatedAt: nowIso(),
    host: host ?? null,
    observedIndexUpdatedAt: indexUpdatedAt ?? null,
    compositionPath: compositionPath ?? null,
    plugins: Array.isArray(plugins) ? plugins : [],
  };
}

// ---------------------------------------------------------------------------
// compatibility decision (consumer)
// ---------------------------------------------------------------------------

/**
 * Decide whether one published record may be mounted in the current profile.
 *
 * Static checks run first and prove what can be proven without executing the
 * plugin: record integrity, source digest, approval, operator revocation, host
 * identity and required services/capabilities. A record that passes is mounted
 * through the official Include; the mount's fiber is then verified separately.
 * A record that fails is reported with a closed status and no part of the host
 * is touched, so one incompatible plugin can never affect another.
 */
export async function evaluateSharedRecord({
  paths,
  record,
  profile,
  host,
  capabilities,
  services = {},
  mountedModuleUrls = [],
  kernelEnabled = false,
  disableState = null,
  previousState = null,
}) {
  const verdict = validateSharedRecord(record, paths);
  if (!verdict.ok) return { status: SHARED_STATUS.INVALID, reason: verdict.reason };
  // Operator revocation is a safety control, so its own state must fail closed:
  // a `disabled.json` that exists but cannot be read or parsed is unknown, not
  // "nothing is revoked". Mounting anything then could activate a plugin the
  // operator explicitly disabled; report the record as skipped instead.
  if (disableState?.status === 'invalid' || disableState?.status === 'unreadable') {
    return { status: SHARED_STATUS.INVALID, reason: `disable-state-${disableState.status}` };
  }
  // A profile that authored the publication normally mounts it through its own
  // Evolution kernel composition, so the consumer must stay out of the way.
  // That only applies while the kernel row is actually enabled here: a profile
  // whose kernel is disabled (or an isolated validation host that promotes
  // under a non-desktop profile) has no other mounter, and the consumer is the
  // correct one. This is decided from the loader entry's static `disabled`
  // state, so two entries initialising concurrently cannot race the decision.
  if (kernelEnabled && record.publisherProfile === profile) return { status: SHARED_STATUS.DISABLED, reason: 'publisher-profile' };
  const alreadyMounted = mountedModuleUrls.includes(record.moduleUrl);
  if (alreadyMounted) return { status: SHARED_STATUS.DISABLED, reason: 'already-mounted' };
  if (isDisabledForProfile(disableState, record.id, profile)) return { status: SHARED_STATUS.DISABLED, reason: 'operator-disabled' };
  if (!record.approvedProfiles.includes(profile)) return { status: SHARED_STATUS.UNNAPPROVED, reason: 'profile-not-approved' };
  let source;
  try {
    source = await readPromotedPlugin(paths, { pluginName: record.pluginName, moduleUrl: record.moduleUrl, entry: record.entry });
  } catch (error) {
    return { status: SHARED_STATUS.INVALID, reason: 'source-unusable', detail: sharedFailure(error, 'source-unusable') };
  }
  if (source.sourceSha256 !== record.sourceSha256) return { status: SHARED_STATUS.INVALID, reason: 'source-digest-mismatch' };
  if (source.manifestSha256 !== record.manifestSha256) return { status: SHARED_STATUS.INVALID, reason: 'manifest-digest-mismatch' };
  const hostVerdict = hostCompatible(record.host, host);
  if (!hostVerdict.ok) return { status: SHARED_STATUS.REVALIDATION, reason: hostVerdict.reason };
  const missingCapabilities = (record.requiredCapabilities || []).filter((name) => capabilities?.[name] !== true);
  if (missingCapabilities.length > 0) return { status: SHARED_STATUS.INCOMPATIBLE, reason: 'missing-host-capability', capabilities: missingCapabilities };
  const missingServices = (record.requiredServices || []).filter((name) => services.has?.(name) !== true);
  if (missingServices.length > 0) return { status: SHARED_STATUS.INCOMPATIBLE, reason: 'missing-service', services: missingServices };
  for (const [name, members] of Object.entries(record.serviceMembers || {})) {
    const missing = members.filter((member) => services.memberPresent?.(name, member) !== true);
    if (missing.length > 0) return { status: SHARED_STATUS.INCOMPATIBLE, reason: 'missing-service-member', service: name, members: missing };
  }
  // A previous start that failed for this exact source and host identity stays
  // failed until the operator resets it: retrying a proven failure on every boot
  // would be a production trial loop, not a verification.
  const previous = previousState?.plugins?.find?.((row) => row.id === record.id);
  if (previous?.status === SHARED_STATUS.FAILED
    && previous.sourceSha256 === record.sourceSha256
    && previous.hostDigest === hostDigest(host)) {
    return { status: SHARED_STATUS.FAILED, reason: previous.reason || 'previous-failure', sticky: true };
  }
  return { status: 'eligible', reason: null, source };
}

export function hostDigest(host) {
  return sha256(JSON.stringify({ dsh: host?.dsh ?? null, cordis: host?.cordis ?? null, include: host?.include ?? null, node: host?.node ?? null }));
}

// ---------------------------------------------------------------------------
// consumer composition
// ---------------------------------------------------------------------------

/**
 * The exact Include entry list a consumer may mount: one row per eligible
 * record, named by its verified module URL. The caller writes this to the
 * consumer-owned composition file; the Desktop composition is never reused.
 */
export function consumerCompositionEntries(records) {
  const seen = new Set();
  const entries = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id);
    entries.push({ id: `shared-${record.id}`, name: record.moduleUrl });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// startup reconciliation (Desktop publisher)
// ---------------------------------------------------------------------------

const EVIDENCE_SUFFIX = '.evidence.json';

/**
 * Read the durable stable facts a publication may be rebuilt from.
 *
 * Only the stable evidence sidecars are scanned. Each sidecar is the record the
 * stable commit wrote next to `exp-<id>.md`; a candidate must carry a
 * `stableCommittedAt`, a committed `durable` identity and an explicit
 * non-empty `shareTargets` list. Anything else stays out of the index, so a
 * historical Desktop-only promotion is never auto-deployed.
 *
 * Selection is newest first and only reads sidecars that are not published
 * already (`publishedExperimentIds`), so the bounded read budget belongs to the
 * records that actually need republishing. Before this, the oldest 200 sidecar
 * names were read and then filtered, so on a store with more experiments a
 * recent stable commit whose index write was lost in a crash was never reached:
 * exactly the failure this reconciler exists for.
 */
export async function scanStableShareCandidates(paths, { maxRecords = 200, publishedExperimentIds = null } = {}) {
  if (!paths?.archiveDir) return [];
  let names;
  try {
    names = await fsp.readdir(paths.archiveDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const published = publishedExperimentIds instanceof Set
    ? publishedExperimentIds
    : new Set(Array.isArray(publishedExperimentIds) ? publishedExperimentIds : []);
  const candidates = [];
  // Experiment ids embed their creation time (`exp-<time36>-<seq36>-<hex>`), so
  // a descending name order reads the newest stable commits first.
  for (const name of names.filter((entry) => entry.endsWith(EVIDENCE_SUFFIX)).sort().reverse()) {
    if (candidates.length >= maxRecords) break;
    const experimentId = name.slice(0, -EVIDENCE_SUFFIX.length);
    if (!SHARED_EXPERIMENT_ID.test(experimentId)) continue;
    if (published.has(experimentId)) continue;
    let snapshot;
    try {
      snapshot = JSON.parse(await fsp.readFile(path.join(paths.archiveDir, name), 'utf8'));
    } catch {
      continue;
    }
    if (!isObject(snapshot) || typeof snapshot.stableCommittedAt !== 'string' || snapshot.stableCommittedAt === '') continue;
    const shareTargets = Array.isArray(snapshot.shareTargets)
      ? snapshot.shareTargets.filter((profile) => SHARED_CONSUMER_PROFILES.includes(profile))
      : [];
    if (shareTargets.length === 0) continue;
    if (!isObject(snapshot.durable) || typeof snapshot.durable.rowId !== 'string') continue;
    candidates.push({
      experimentId,
      durable: snapshot.durable,
      shareTargets: [...new Set(shareTargets)],
      stableCommittedAt: snapshot.stableCommittedAt,
      canary: snapshot.canary ?? null,
      decision: isObject(snapshot.decision) ? snapshot.decision : null,
      // The verified publication identity captured at promotion time. A
      // candidate without it cannot be republished: a reconciler that adopted
      // its own current host or the current file bytes would turn a changed
      // source or an upgraded host into a "verified" record.
      publication: normalizePublication(snapshot.publication ?? snapshot.durable?.publication ?? null),
    });
  }
  return candidates;
}

/**
 * Publish every stable promotion whose durable evidence records an explicit
 * cross-entry approval but whose publication is missing (for example a crash
 * between the stable commit and the index write).
 *
 * Only durable stable facts are read: the evidence sidecar written by the
 * stable commit. Records are never created from an in-memory claim, and the
 * existing index is only extended, never rebuilt from scratch, so an operator
 * revocation or a revalidation generation is preserved.
 */
export async function reconcileSharedIndex({ paths, host, capabilities, maxRecords = 200 } = {}) {
  const current = await readSharedIndex(paths);
  if (current.status === 'invalid' || current.status === 'unreadable') {
    return { status: current.status, published: [], unchanged: 0, skipped: [] };
  }
  const publishedExperimentIds = new Set(current.records.map((row) => row.experimentId));
  const published = [];
  const skipped = [];
  // Sidecars for records already in the index are skipped without being read;
  // they are the "unchanged" stable facts of this reconcile pass.
  let unchanged = current.records.length;
  for (const candidate of await scanStableShareCandidates(paths, { maxRecords, publishedExperimentIds })) {
    try {
      if (!candidate.publication) {
        skipped.push({ id: candidate?.durable?.rowId ?? null, reason: 'no-verified-publication-identity' });
        continue;
      }
      const record = await buildSharedRecord({
        paths,
        requirePublication: true,
        experiment: {
          id: candidate.experimentId,
          state: 'stable',
          stableCommittedAt: candidate.stableCommittedAt,
          canary: candidate.canary,
          ...(candidate.decision ? { decision: candidate.decision } : {}),
        },
        durable: candidate.durable,
        journal: null,
        approvedProfiles: candidate.shareTargets,
        host,
        capabilities,
        source: {
          stableCommittedAt: candidate.stableCommittedAt,
          canary: candidate.canary,
          decision: candidate.decision,
          publication: candidate.publication,
        },
      });
      const known = current.records.some((row) => row.id === record.id && row.sourceSha256 === record.sourceSha256);
      if (known) { unchanged += 1; continue; }
      const result = await publishSharedRecord(paths, record);
      if (result.status === 'published' || result.status === 'updated') {
        published.push({ id: record.id, status: result.status });
        publishedExperimentIds.add(candidate.experimentId);
      }
      else if (result.status === 'unchanged') unchanged += 1;
      else skipped.push({ id: record.id, reason: result.reason || result.status });
    } catch (error) {
      skipped.push({ id: candidate?.durable?.rowId ?? null, reason: boundedText(error?.message || String(error), 160) || 'reconcile-failed' });
    }
  }
  return { status: 'ok', published, unchanged, skipped };
}

/** True when the index and the consumer state disagree about the last start. */
export function consumerNeedsRestart(indexUpdatedAt, state) {
  if (!indexUpdatedAt) return false;
  const observed = state?.observedIndexUpdatedAt;
  if (!observed) return true;
  return indexUpdatedAt !== observed;
}

/**
 * Scan the publication index for records that are invalid, conflicting or were
 * verified on a different host than the one that owns this data root. The
 * doctor reports this; nothing here mutates state.
 */
export async function inspectSharedIndex({ paths } = {}) {
  const index = await readSharedIndex(paths);
  const disable = await readDisableState(paths);
  return { index, disable };
}
