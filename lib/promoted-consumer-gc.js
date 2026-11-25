/**
 * Bounded, startup-only reclamation of stale per-session consumer compositions.
 *
 * A consumer session writes one `<profile>.<sessionId>.cordis.yml` per boot.
 * When a process is killed before its disposer runs, that file survives forever.
 * This module is the whole answer: it is host-free (only Node built-ins), it
 * runs once after mount, and it never touches the profile's stable composition,
 * its activation report or the publication index.
 *
 * The only liveness signal is a per-session lease carrying `pid` + `hostname`.
 * `process.kill(pid, 0)` returning ESRCH is the sole death proof; everything else
 * (including another host's pid, EPERM, bad JSON and a missing lease inside the
 * window) is kept. Pid reuse can only make a dead session look alive, so the
 * failure mode is a conservative false negative, never a deleted live session.
 *
 * The legacy time window applies to any composition without a lease. Its common
 * sources are already-ended sessions (pre-feature leftovers and files retained
 * after an unproven dispose), but a still-live session whose lease write failed
 * also lands in the window: that is a known residual risk. Removing such a file
 * affects only that file; it never unmounts an already mounted row, because the
 * official Include reads the composition only on an explicit refresh.
 *
 * When more sessions exist than `maxEntries`, a small persistent cursor advances
 * the processed window between serial passes, independent of when the host boots;
 * booting at the same wall-clock time every day still visits every stem under
 * that serial assumption. Concurrent boots can read the same cursor, process the
 * same window and write the same lastSessionId, so two passes together advance
 * only one window. Each pass still processes at most `maxEntries` and never
 * deletes a live session, but the coverage guarantee assumes serial starts.
 * Scanning alone never stats or deletes.
 *
 * No timers, watchers, polling or background promises live here. Every operation
 * is awaited by the caller, and the collector contains its own failures.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const CONSUMER_SESSION_LEASE_KIND = 'dsh-evolution-consumer-session-lease';
export const CONSUMER_SESSION_LEASE_SCHEMA_VERSION = 1;
export const CONSUMER_SESSION_GC_LIMITS = Object.freeze({
  staleCompositionMs: 24 * 60 * 60 * 1000,
  maxEntries: 8192,
  maxRemovals: 1024,
  maxLeaseBytes: 4096,
  maxCursorBytes: 2048,
});

const PROFILE_RE = /^[a-z0-9-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMPOSITION_RE = /^([a-z0-9-]+)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.cordis\.yml$/;
const LEASE_RE = /^([a-z0-9-]+)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lease\.json$/;
const MAX_FAILURES = 8;
const CURSOR_KIND = 'dsh-evolution-consumer-session-gc-cursor';
const CURSOR_SCHEMA_VERSION = 1;
/** The one closed vocabulary for failure codes; anything else is `other`. */
const GC_ERROR_CODES = new Set([
  'EACCES', 'EPERM', 'ENOENT', 'EISDIR', 'ENOTDIR', 'ENOSPC', 'EMFILE', 'ENFILE',
  'EBUSY', 'EROFS', 'EEXIST', 'E_LEASE_TOO_LARGE', 'SyntaxError', 'TypeError',
  'RangeError', 'Error', 'unknown', 'other',
]);

/** `<profile>.<sessionId>.cordis.yml` / `.lease.json`; invalid input throws. */
export function consumerSessionFileNames(profile, sessionId) {
  if (typeof profile !== 'string' || !PROFILE_RE.test(profile)) {
    throw new TypeError(`Invalid consumer profile: ${String(profile)}`);
  }
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
    throw new TypeError(`Invalid consumer session id: ${String(sessionId)}`);
  }
  return {
    composition: `${profile}.${sessionId}.cordis.yml`,
    lease: `${profile}.${sessionId}.lease.json`,
  };
}

/** Atomic lease write: temp 0600 + fsync + rename. Failures throw. */
export async function writeConsumerSessionLease({
  consumersDir,
  profile,
  sessionId,
  pid = process.pid,
  hostname = os.hostname(),
  now = () => Date.now(),
  processStartedAt = now() - Math.round(process.uptime() * 1000),
} = {}) {
  if (typeof consumersDir !== 'string' || consumersDir === '') {
    throw new TypeError('Consumer session lease requires a consumers directory');
  }
  const { lease } = consumerSessionFileNames(profile, sessionId);
  const file = path.join(consumersDir, lease);
  const document = {
    schemaVersion: CONSUMER_SESSION_LEASE_SCHEMA_VERSION,
    kind: CONSUMER_SESSION_LEASE_KIND,
    profile,
    sessionId,
    pid,
    hostname,
    createdAt: new Date(now()).toISOString(),
    processStartedAt: new Date(processStartedAt).toISOString(),
  };
  await fsp.mkdir(consumersDir, { recursive: true, mode: 0o700 });
  // The temp name deliberately cannot match either GC pattern, so an aborted
  // write is left to the existing `.consumer-*.tmp` boundary, not reclaimed.
  const temp = path.join(consumersDir, `.consumer-lease-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    const handle = await fsp.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(temp, file);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return file;
}

/** Remove this session's lease; ENOENT counts as success, other failures throw. */
export async function removeConsumerSessionLease({ consumersDir, profile, sessionId } = {}) {
  const { lease } = consumerSessionFileNames(profile, sessionId);
  await fsp.rm(path.join(consumersDir, lease), { force: true });
}

/** The only death proof: ESRCH. Everything else stays "alive/unproven". */
export function defaultIsProcessAlive(pid) {
  if (pid === process.pid) return true;
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'ESRCH' ? false : true;
  }
}

function boundedCode(error) {
  // A supplied `code` is authoritative even when it is outside the closed set:
  // an injected sentinel must be mapped to `other`, not rescued by `error.name`.
  if (typeof error?.code === 'string') return GC_ERROR_CODES.has(error.code) ? error.code : 'other';
  if (typeof error?.name === 'string') return GC_ERROR_CODES.has(error.name) ? error.name : 'other';
  return 'other';
}

function pushFailure(result, name, error) {
  if (result.failures.length >= MAX_FAILURES) return;
  result.failures.push({
    name: typeof name === 'string' && name !== '' ? path.basename(name) : 'unknown',
    code: boundedCode(error),
  });
}

function validLease(document, profile, sessionId) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return false;
  if (document.schemaVersion !== CONSUMER_SESSION_LEASE_SCHEMA_VERSION) return false;
  if (document.kind !== CONSUMER_SESSION_LEASE_KIND) return false;
  if (document.profile !== profile) return false;
  if (document.sessionId !== sessionId) return false;
  if (!Number.isSafeInteger(document.pid) || document.pid <= 0) return false;
  if (typeof document.hostname !== 'string' || document.hostname === '') return false;
  // createdAt / processStartedAt are diagnostic only; they never gate removal.
  return true;
}

function consumerCursorName(profile) {
  return `.consumer-session-gc-cursor-${profile}.json`;
}

/** A malformed/foreign/oversized cursor is no cursor: restart at index 0. */
async function readConsumerCursor(consumersDir, profile, maxBytes) {
  const file = path.join(consumersDir, consumerCursorName(profile));
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return null;
  }
  if (!stat.isFile() || !Number.isFinite(maxBytes) || stat.size > maxBytes) return null;
  try {
    const document = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (!document || typeof document !== 'object' || Array.isArray(document)) return null;
    if (document.schemaVersion !== CURSOR_SCHEMA_VERSION) return null;
    if (document.kind !== CURSOR_KIND) return null;
    if (document.profile !== profile) return null;
    if (typeof document.lastSessionId !== 'string' || !UUID_RE.test(document.lastSessionId)) return null;
    return document.lastSessionId;
  } catch {
    return null;
  }
}

/** Atomic cursor write: temp 0600 + fsync + rename. Failures throw. */
async function writeConsumerCursor(consumersDir, profile, lastSessionId) {
  const file = path.join(consumersDir, consumerCursorName(profile));
  const temp = path.join(consumersDir, `.consumer-gc-cursor-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  const document = {
    schemaVersion: CURSOR_SCHEMA_VERSION,
    kind: CURSOR_KIND,
    profile,
    lastSessionId,
  };
  try {
    const handle = await fsp.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(temp, file);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return file;
}

/**
 * One bounded collection pass. Never throws for filesystem or judgement
 * failures; the caller awaits it once, after mount, and only reads the result.
 */
export async function collectConsumerSessionGarbage({
  consumersDir,
  profile,
  now = Date.now(),
  limits = CONSUMER_SESSION_GC_LIMITS,
  isProcessAlive = defaultIsProcessAlive,
  hostname = os.hostname(),
  removeFile = (file) => fsp.rm(file, { force: true }),
  dryRun = false,
} = {}) {
  const startedAt = Date.now();
  const result = {
    status: 'ok',
    scanned: 0,
    sessions: 0,
    removedCompositions: 0,
    removedLeases: 0,
    bytesReclaimed: 0,
    kept: { live: 0, recent: 0, unproven: 0, foreignHost: 0 },
    keptOtherProfile: 0,
    ignored: 0,
    failures: [],
    deferred: 0,
    truncated: false,
    dryRun: dryRun === true,
    decisions: [],
    durationMs: 0,
  };
  const finish = (status) => {
    result.status = status;
    result.durationMs = Date.now() - startedAt;
    return result;
  };
  const effective = { ...CONSUMER_SESSION_GC_LIMITS, ...(limits && typeof limits === 'object' ? limits : {}) };

  try {
    if (typeof profile !== 'string' || !PROFILE_RE.test(profile)) {
      throw new TypeError(`Invalid consumer profile: ${String(profile)}`);
    }
    if (typeof consumersDir !== 'string' || consumersDir === '') {
      throw new TypeError('Consumer session GC requires a consumers directory');
    }

    let entries;
    try {
      entries = await fsp.readdir(consumersDir, { withFileTypes: true });
    } catch (error) {
      // A missing directory is an honest absence, not a failure to create one.
      return finish(error?.code === 'ENOENT' ? 'absent' : 'unavailable');
    }
    result.scanned = entries.length;

    const sessions = new Map();
    for (const entry of entries) {
      const name = entry.name;
      const isComposition = COMPOSITION_RE.test(name);
      const isLease = LEASE_RE.test(name);
      if (!isComposition && !isLease) {
        result.ignored += 1;
        continue;
      }
      const match = (isComposition ? COMPOSITION_RE : LEASE_RE).exec(name);
      const [, entryProfile, sessionId] = match;
      if (entryProfile !== profile) {
        result.keptOtherProfile += 1;
        continue;
      }
      let record = sessions.get(sessionId);
      if (!record) {
        record = { sessionId, composition: null, lease: null, unprovenEntry: false };
        sessions.set(sessionId, record);
      }
      const kind = isComposition ? 'composition' : 'lease';
      if (entry.isFile() !== true) {
        // Never follow or delete a symlink/directory that merely looks like a
        // lease or composition. It makes the whole stem unprovable, so a
        // sibling composition cannot fall through to the legacy time window.
        result.ignored += 1;
        record.unprovenEntry = true;
        continue;
      }
      // Scanning is cheap (readdir only). Stat/read/remove are paid only by
      // the cursor window below, so a session outside it is untouched.
      record[kind] = { file: path.join(consumersDir, name) };
    }

    const ordered = [...sessions.keys()].sort();
    result.sessions = ordered.length;
    if (ordered.length > effective.maxEntries) result.truncated = true;

    // A persistent cursor, not the clock, decides where the next bounded pass
    // resumes. Booting at the same time every day therefore still advances.
    let first = 0;
    if (result.truncated) {
      const lastSessionId = await readConsumerCursor(consumersDir, profile, effective.maxCursorBytes);
      if (lastSessionId !== null) {
        const index = ordered.findIndex((sessionId) => sessionId > lastSessionId);
        if (index !== -1) first = index;
      }
    }
    const window = ordered.slice(first).concat(ordered.slice(0, first)).slice(0, effective.maxEntries);

    // `now` is injected as a numeric timestamp by the promotion-style callers
    // and as a clock function by the lease writer's siblings. Accept both.
    const nowMs = Number(typeof now === 'function' ? now() : now);

    for (const sessionId of window) {
      const record = sessions.get(sessionId);
      const decision = { sessionId, action: 'keep', reason: 'recent' };
      const removals = [];
      try {
        for (const kind of ['lease', 'composition']) {
          const target = record[kind];
          if (!target) continue;
          try {
            const stat = await fsp.stat(target.file);
            target.size = stat.size;
            target.mtimeMs = stat.mtimeMs;
          } catch (error) {
            // Without an mtime a legacy composition cannot be time-proven, and
            // without a size it cannot be accounted. Keep the whole session.
            pushFailure(result, path.basename(target.file), error);
            record.unprovenEntry = true;
          }
        }
        if (record.unprovenEntry) {
          decision.reason = 'unproven-lease';
        } else if (record.lease) {
          let document;
          if (record.lease.size > effective.maxLeaseBytes) {
            pushFailure(result, path.basename(record.lease.file), { code: 'E_LEASE_TOO_LARGE' });
          } else {
            try {
              document = JSON.parse(await fsp.readFile(record.lease.file, 'utf8'));
            } catch (error) {
              pushFailure(result, path.basename(record.lease.file), error);
            }
          }
          if (record.unprovenEntry || !validLease(document, profile, sessionId)) {
            decision.reason = 'unproven-lease';
          } else if (document.hostname !== hostname) {
            decision.reason = 'foreign-host';
          } else {
            let alive;
            try {
              alive = isProcessAlive(document.pid);
            } catch (error) {
              alive = true; // Unprovable liveness is never a death sentence.
              pushFailure(result, path.basename(record.lease.file), error);
            }
            if (alive) {
              decision.reason = 'live-lease';
            } else {
              decision.action = 'remove';
              decision.reason = 'stale-lease';
              if (record.composition) removals.push({ kind: 'composition', target: record.composition });
              removals.push({ kind: 'lease', target: record.lease });
            }
          }
        } else if (record.composition) {
          if (record.unprovenEntry || !Number.isFinite(nowMs)) {
            decision.reason = 'unproven-lease';
          } else if (nowMs - record.composition.mtimeMs > effective.staleCompositionMs) {
            decision.action = 'remove';
            decision.reason = 'legacy-window';
            removals.push({ kind: 'composition', target: record.composition });
          } else {
            decision.reason = 'recent';
          }
        } else {
          decision.reason = 'unproven-lease';
        }
      } catch (error) {
        decision.reason = 'unproven-lease';
        removals.length = 0;
        pushFailure(result, `${profile}.${sessionId}`, error);
      }

      if (decision.action === 'keep') {
        if (decision.reason === 'live-lease') result.kept.live += 1;
        else if (decision.reason === 'recent') result.kept.recent += 1;
        else if (decision.reason === 'foreign-host') result.kept.foreignHost += 1;
        else result.kept.unproven += 1;
      } else if (!result.dryRun) {
        for (const { kind, target } of removals) {
          if (result.removedCompositions + result.removedLeases >= effective.maxRemovals) {
            result.deferred += 1;
            continue;
          }
          try {
            await removeFile(target.file);
            if (kind === 'composition') result.removedCompositions += 1;
            else result.removedLeases += 1;
            result.bytesReclaimed += Number.isFinite(target.size) ? target.size : 0;
          } catch (error) {
            pushFailure(result, path.basename(target.file), error);
          }
        }
      }
      result.decisions.push(decision);
    }

    // Commit the cursor only after the whole window (including failures) has
    // been processed. A write failure is a bounded diagnostic, never a failed
    // collection; the next boot simply resumes from the old cursor.
    if (!result.dryRun && result.truncated && window.length > 0) {
      try {
        await writeConsumerCursor(consumersDir, profile, window[window.length - 1]);
      } catch (error) {
        pushFailure(result, consumerCursorName(profile), error);
      }
    }
    return finish('ok');
  } catch (error) {
    pushFailure(result, 'collect', error);
    return finish('unavailable');
  }
}
