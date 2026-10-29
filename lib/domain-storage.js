import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EvolutionMemory, EvolutionObservationStore, EvolutionEvaluator } from './dockyard-domain/index.js';
import { buildExperienceQuery, collectKnowledgeExperience, EXPERIENCE_RECALL_LIMITS } from './experience-recall.js';
import { EVENT_BRIDGE_APPEND_LOCK_BUSY, EVENT_BRIDGE_DEFAULT_WRITER, eventBridgeWriterTrusted, verifyEventBridgeEnvelope } from './orchestrator.js';
// Kept on its own line: `flush-checkpoint-diagnostics.test.js` derives the
// pre-fix module by substituting the single-line replay import below, and that
// anchor has to stay byte-identical.
import { createEventBridgeEvidenceIndex, withEventBridgeAppendLock } from './orchestrator.js';
import { warnRedacted } from './registration.js';
import { advanceRetention, completeEventLogTruncation, DEFAULT_LOG_RETAIN_RECORDS, inspectEventLogFloor,
  eventLogCheckpointDocument, eventLogCheckpointPath, planEventLogReplay, planLogPrune, planRetainedCoverage,
  readEventLogCheckpoint, RETENTION_SCHEMA, verifyLogFloorTail, writeEventLogCheckpoint } from './event-log-checkpoint.js';
import { assertLiveTreeUnchanged, changedArchiveFiles, copyArchives, installArchiveFiles, mirrorArchives,
  privatizeArchiveFile, removeStage, stageDirectory, syncFile, syncStage, syncTree, writeStageManifest } from './archive-stage.js';


// The legacy aggregate can carry `undefined` object fields (e.g. relationRefs).
// JSON is the durable medium, and the old file backend already dropped those
// fields through JSON.stringify, so normalize to the exact JSON projection before
// validating: this keeps strict persistence semantics without silently changing
// state.
//
// That projection is also why no per-value JSON schema is needed below. Its
// output can only be `null`, booleans, strings, arrays, plain objects and
// numbers that `JSON.stringify` accepted - an in-memory `NaN` or `Infinity` is
// already `null` by the time anything is validated - so a recursive `z.json()`
// over every value could never reject a projected document; it only walked the
// whole aggregate a second time on every transaction step, and a single
// transaction step saves several times (`#append`, then `#markBridgeApplied`).
// What is left is the strict structural schema below.
const PROTO_KEY = '__proto__';
/**
 * A copy of `value` with every own `__proto__` key removed, at every depth.
 *
 * Only `JSON.parse` (or an explicit define) can create that key: assigning the
 * name on an ordinary object sets the prototype instead of an own key, which is
 * why the recursive `z.record`-based walk this schema used to do dropped it as a
 * side effect of building its result. The copy is what the structural schema
 * validates, so the accept/reject decision is the one that walk made
 * (`aggregate-schema-equivalence` pins it at every depth); the document that is
 * returned and persisted keeps the key, because it is part of a record's
 * identity and deleting it would make the in-memory identity drift from the
 * reloaded one. Past the validation copy nothing ever assigns that name.
 */
function withoutOwnProtoKeys(value) {
  if (Array.isArray(value)) return value.map(withoutOwnProtoKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== PROTO_KEY).map(([key, item]) => [key, withoutOwnProtoKeys(item)]));
}
/**
 * The one projection every durable value goes through. It returns the JSON
 * document and, when the serialized text carries the own-`__proto__` literal, a
 * key-free copy of it for the structural check to judge.
 *
 * The literal is only looked for in the text: `JSON.stringify` must spell an own
 * key of that name literally, so a document that cannot contain one - every
 * document a plugin that never records such a payload writes - pays a substring
 * search and shares one object, not a second walk. It is also the gate the
 * retired deep walk effectively had, so the depth at which a document overflows
 * a recursive walk is the same depth it overflowed before. (A string value that
 * happens to read `__proto__` only makes the walk run and find nothing.)
 */
const toJsonProjection = value => {
  const text = JSON.stringify(value);
  const document = JSON.parse(text);
  const validation = text.includes(`"${PROTO_KEY}"`) ? withoutOwnProtoKeys(document) : document;
  return { document, validation };
};
/**
 * The structural requirements of one aggregate document: the only top-level
 * member it may carry, that member being an optional object, and the integer
 * `schema >= 4` inside it. `passthrough()` keeps the unknown evolution fields
 * instead of stripping them (`catchall` would keep validating them). It judges
 * the key-free copy this projection hands it, which is the same document the
 * retired deep walk judged.
 */
const aggregateStructure = z.object({ evolution: z.object({ schema: z.number().int().min(4) }).passthrough().optional() }).strict();
/**
 * The document schema every durable aggregate goes through.
 *
 * The two halves of the old single schema are split here, and only in how the
 * verdict is produced: the structural requirements moved into
 * `aggregateStructure`, which judges the key-free copy, and this wrapper
 * re-reports its issues from the same place - with their own paths - so a
 * refusal keeps the exact issue code and path it had when this schema judged the
 * document directly (`domain-hotpath-20261024-entry-validation` pins one of
 * them). What changed deliberately is the *value*: this returns the JSON
 * projection with an own `__proto__` key, because that key is part of a record's
 * identity and dropping it made the in-memory identity differ from the reloaded
 * one.
 */
const aggregateSchema = z.preprocess(toJsonProjection,
  z.object({ document: z.unknown(), validation: z.unknown() }).strict()
    .superRefine(({ validation }, ctx) => {
      const result = aggregateStructure.safeParse(validation);
      if (result.success) return;
      for (const issue of result.error.issues) ctx.addIssue({ ...issue, path: issue.path });
    })
    .transform(({ document }) => document));
const appliedSchema = z.record(z.string(), z.string());
/**
 * One entry of the committed change list. A staged file is replaced in the live
 * tree; a `removed` entry is the only form of deletion the protocol has, and it
 * is restricted by `isRemovableArchiveSegment` in `archive-stage.js` to a sealed
 * segment whose records a compaction retired into the aggregate. The old shape
 * (no `removed`) still parses, so a pending record written by an earlier version
 * recovers exactly as before.
 */
const archiveFilesSchema = z.array(z.union([
  z.object({ file: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  z.object({ file: z.string(), removed: z.literal(true), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
]));
/**
 * The durable retention floor (`lib/event-log-checkpoint.js`). Optional on both
 * the committed document and the pending record, so a database written before
 * this version loads unchanged and a reclaim's floor is installed atomically
 * with the ledger it prunes.
 */
const retentionSchema = z.object({
  schema: z.literal(RETENTION_SCHEMA),
  markers: z.object({ pruned: z.number().int().nonnegative(), chain: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  log: z.object({
    // Cumulative over every reclaim this root ever ran.
    bytes: z.number().int().nonnegative(),
    records: z.number().int().nonnegative(),
    prior: z.object({ bytes: z.number().int().positive(), digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
    tail: z.object({ bytes: z.number().int().positive(), digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  }).strict().nullable(),
}).strict().superRefine((value, ctx) => {
  // A floor whose retained tail is not strictly shorter than the file it was
  // computed from cannot describe a truncation at all.
  if (value.log && value.log.prior.bytes <= value.log.tail.bytes) {
    ctx.addIssue({ code: 'custom', path: ['log', 'prior'], message: 'prior.bytes must be greater than tail.bytes' });
  }
});
const pendingSchema = z.object({ stage: z.string().regex(/^stage-[a-f0-9-]+$/), aggregate: aggregateSchema, applied: appliedSchema,
  files: archiveFilesSchema.optional(), retention: retentionSchema.optional() }).strict();
const schema = z.object({ schema: z.literal(1), aggregate: aggregateSchema, applied: appliedSchema,
  retention: retentionSchema.nullable().optional(), pending: pendingSchema.nullable() }).strict();
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/;
/**
 * Mirrors the official `defineDomain` fail-loud checks (dsh-storage-domain/src/spec.ts)
 * for this hand-written spec: both storage backends reject a unit name outside
 * `UNIT_NAME_RE`, and a global schema that accepts `null` would collide with the
 * medium's "never written" sentinel. The plugin does not import the domain package
 * at runtime; it consumes the host `ctx.storageDomain` service instead.
 */
export function assertDomainSpec(spec) {
  if (!UNIT_NAME_RE.test(spec.name)) throw new Error(`Evolution domain name '${spec.name}' must match ${UNIT_NAME_RE}`);
  if (!Number.isInteger(spec.version) || spec.version < 0) throw new Error(`Evolution domain '${spec.name}' version must be a non-negative integer`);
  for (const table of Object.keys(spec.tables)) {
    if (!UNIT_NAME_RE.test(table)) throw new Error(`Evolution domain '${spec.name}' table '${table}' must match ${UNIT_NAME_RE}`);
  }
  if (spec.global !== undefined && spec.global.schema.safeParse(null).success) {
    throw new Error(`Evolution domain '${spec.name}' global schema must not accept null`);
  }
  return spec;
}
export const evolutionDomainSpec = assertDomainSpec({
  name: 'evolution_domain', version: 1, tables: {},
  global: { schema, initial: { schema: 1, aggregate: {}, applied: {}, pending: null } },
});
/**
 * Acquire the cross-process archive lock. A lock whose owner is dead, or whose
 * content was never written (the writer was killed between create and write),
 * must not brick the plugin: a lock that cannot be read or parsed is reclaimed
 * only once the file has not been modified for LOCK_SETTLE_MS, while a lock
 * whose readable content names a live owner is refused, never taken.
 *
 * The path is the only rendezvous point between processes, so a reclaim and a
 * release both prove that the entry they remove is still the exact file they
 * inspected: the content alone cannot, because the path outlives every lock that
 * occupies it.
 */
const LOCK_SETTLE_MS = 1000;
const LOCK_RETRY_MS = 5000;
/** What a reclaim did with the entry it inspected: removed, already changed, or
 *  a path now held by a process this attempt cannot prove anything about. */
const LOCK_REMOVED = 'removed';
const LOCK_CHANGED = 'changed';
const LOCK_HELD = 'held';
/** Error codes that mean "this filesystem has no hard links", where the
 *  non-overwriting restore falls back to an exclusive copy. */
const LOCK_LINK_UNSUPPORTED = new Set(['EPERM', 'EACCES', 'EOPNOTSUPP', 'ENOTSUP', 'ENOSYS', 'EMLINK']);
function ownerAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}
/** The identity of the lock entry: the device and inode pin the file object, so
 *  a later comparison distinguishes "the lock I inspected" from "a lock another
 *  process wrote into the same path". A link or a non-regular entry at the lock
 *  path is never taken and never removed. */
function lockIdentity(lock) {
  const stat = fs.lstatSync(lock, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('E_DOMAIN_ARCHIVE_LOCK');
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
/**
 * Read a lock's recorded owner together with the identity and bytes of the entry
 * that carries it. The identity is taken before the content, so a replacement
 * that lands in between is remembered by a pair that no single file satisfies
 * and the reclaim below refuses to act on it. `null` means the lock is gone.
 * `pid: null` means the content is not an owner pid (the writer was killed
 * between create and write, or the file is not ours to read).
 */
function readLockOwner(lock) {
  let identity;
  try { identity = lockIdentity(lock); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  let raw;
  try { raw = fs.readFileSync(lock, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { identity, raw: null, pid: null };
  }
  const pid = Number(raw.trim());
  return { identity, raw, pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null };
}
/**
 * Remove the lock only while it is still the entry described by `identity` and
 * still carries `raw` (an unreadable lock can only be pinned by its identity).
 * The entry is renamed to a private name first, so the verification happens on
 * a file this process owns: a mismatch means another process replaced the lock
 * after it was inspected, and the entry is put back (without replacing whatever
 * holds the path now) instead of deleted. Returns what happened to the entry: it
 * is gone (`LOCK_REMOVED`), it was already replaced or released
 * (`LOCK_CHANGED`), or the path was taken while it was isolated and the reclaim
 * therefore failed (`LOCK_HELD`).
 */
function removeLockIfUnchanged(lock, identity, raw) {
  // A cheap content check first: once the entry has changed, the lock stays where
  // the other process put it and the path is never made free.
  if (raw !== null) {
    let current;
    try { current = fs.readFileSync(lock, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return LOCK_CHANGED; throw error; }
    if (current !== raw) return LOCK_CHANGED;
  }
  const moved = `${lock}.${randomUUID()}.released`;
  try { fs.renameSync(lock, moved); } catch (error) { if (error?.code === 'ENOENT') return LOCK_CHANGED; throw error; }
  let unchanged = false;
  try {
    const stat = fs.lstatSync(moved, { bigint: true });
    unchanged = String(stat.dev) === identity.dev && String(stat.ino) === identity.ino
      && (raw === null || fs.readFileSync(moved, 'utf8') === raw);
  } catch { unchanged = false; }
  if (!unchanged) return restoreLockEntry(lock, moved);
  try { fs.unlinkSync(moved); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  return LOCK_REMOVED;
}
/**
 * Put an isolated lock entry back without replacing whatever holds the path now.
 *
 * The isolation exists because check-and-remove cannot be atomic, and it makes
 * the path free for as long as the verification lasts, so another process can
 * acquire it before this runs. `rename` would silently replace that lock and
 * destroy a live owner's claim, so the entry is linked into place instead:
 * `link` fails with `EEXIST` when the path is taken, and the private copy is
 * unlinked only once the path is provably this entry again. A filesystem without
 * hard links falls back to an exclusive copy, which refuses the same way. When
 * the path is taken the new owner's lock is left untouched and the isolated
 * entry is kept under an `.orphan` name instead of being discarded, and the
 * reclaim reports failure so the caller raises the lock error rather than
 * retrying against a lock it cannot prove anything about.
 */
function restoreLockEntry(lock, moved) {
  try {
    fs.linkSync(moved, lock);
  } catch (error) {
    if (error?.code === 'EEXIST') return orphanLockEntry(lock, moved);
    if (!LOCK_LINK_UNSUPPORTED.has(error?.code)) throw error;
    try { fs.copyFileSync(moved, lock, fs.constants.COPYFILE_EXCL); }
    catch (copyError) { if (copyError?.code === 'EEXIST') return orphanLockEntry(lock, moved); throw copyError; }
  }
  try { fs.unlinkSync(moved); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  return LOCK_CHANGED;
}
/** Keep an isolated lock entry that lost the path as an auditable orphan: the
 *  entry is the only record of the owner whose lock this attempt removed. */
function orphanLockEntry(lock, moved) {
  const orphan = `${lock}.${randomUUID()}.orphan`;
  try { fs.renameSync(moved, orphan); } catch { /* it stays under its private name */ }
  return LOCK_HELD;
}
/** Reclaim one inspected lock entry; a path another process took meanwhile is a
 *  failed reclaim, not a successful one, and is reported as the lock error. */
function reclaimArchiveLock(lock, owner) {
  if (removeLockIfUnchanged(lock, owner.identity, owner.raw) === LOCK_HELD) throw new Error('E_DOMAIN_ARCHIVE_LOCK');
}
/** Release exactly the lock this attempt created: both its identity and its
 *  content are checked, so a lock another process acquired in the meantime
 *  survives this call. */
function releaseArchiveLock(lock, token) {
  if (!token) return false;
  return removeLockIfUnchanged(lock, token.identity, token.raw) === LOCK_REMOVED;
}
/**
 * Read-only classification of the archive lock entry, from the rules the
 * acquiring port itself applies (the same `lockIdentity`, `readLockOwner` and
 * `LOCK_SETTLE_MS` above), for the doctor.
 *
 * The doctor must not carry a second interpretation of this path. `inspectLock()`
 * in lib/diagnostics.js reads the *promotion* directory lock, a different
 * protocol; reading the archive lock through it disagreed with the runtime about
 * non-regular entries and about the settle window. Nothing here mutates.
 *
 * `reclaimable` means the acquire would remove this entry: a named owner that is
 * gone, or ownerless/unreadable bytes that are older than `LOCK_SETTLE_MS`. A
 * non-regular entry (a link, a directory, a device) is never `reclaimable`,
 * because `lockIdentity` refuses it and the acquiring port raises
 * `E_DOMAIN_ARCHIVE_LOCK` instead of interpreting it.
 */
export function inspectArchiveLock(lockPath) {
  const absent = { present: false, kind: 'absent', pid: null, ownerAlive: false, malformed: false, settling: false, reclaimable: false, ageMs: 0, raw: null };
  let stat;
  try { stat = fs.lstatSync(lockPath); }
  catch (error) {
    if (error?.code === 'ENOENT') return absent;
    // A failed lstat is not proof of absence, and it is not a lock that can be
    // interpreted either.
    return { present: true, kind: 'unknown', pid: null, ownerAlive: false, malformed: true, settling: false, reclaimable: false, ageMs: 0, raw: null, readError: error?.code || 'READ_FAILED' };
  }
  const ageMs = Math.max(0, Date.now() - stat.mtimeMs);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    const kind = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'other';
    return { present: true, kind, pid: null, ownerAlive: false, malformed: true, settling: false, reclaimable: false, ageMs, raw: null };
  }
  let owner;
  try { owner = readLockOwner(lockPath); }
  catch (error) {
    return { present: true, kind: 'unknown', pid: null, ownerAlive: false, malformed: true, settling: false, reclaimable: false, ageMs, raw: null, readError: error?.code || 'READ_FAILED' };
  }
  if (!owner) return absent;
  const alive = owner.pid === null ? false : ownerAlive(owner.pid);
  const malformed = owner.pid === null;
  // The runtime reclaims an ownerless entry only after the settle window; a named
  // owner it can prove gone is reclaimed immediately.
  const settling = malformed && ageMs < LOCK_SETTLE_MS;
  return { present: true, kind: 'file', pid: owner.pid, ownerAlive: alive, malformed, settling, reclaimable: !alive && !settling, ageMs, raw: owner.raw };
}
/**
 * Prove that the lock this port acquired is still the entry at the lock path.
 *
 * The lock is a bare pid, so the bytes alone cannot tell two ports of one
 * process apart; the identity (device and inode) is what pins the file object
 * `acquireArchiveLock` created. The two guarded points are the pending record
 * that publishes a commit and the install of staged files into the live tree
 * (recovery runs the same install): two ports that both believe they own the
 * archive overwrite each other there, so a port that cannot prove ownership
 * refuses the write instead. This is a check before the write, not a lease -
 * the lock can still be taken between the check and the syscall that follows
 * it, which is the window a filesystem without kernel leases leaves open. The
 * derived archive index repair and the replay checkpoint are not committed
 * archive data and are not gated by this check.
 */
function assertArchiveLockHeld(lock, token) {
  // Any failure to prove ownership - replaced, gone, unreadable, not a regular
  // file - is a refusal, never a pass.
  let held;
  try {
    const identity = lockIdentity(lock);
    held = identity.dev === token.identity.dev && identity.ino === token.identity.ino
      && fs.readFileSync(lock, 'utf8') === token.raw;
  } catch { held = false; }
  if (!held) throw new Error('E_DOMAIN_ARCHIVE_LOCK');
}
/**
 * Deterministic serialization of a schema-validated aggregate.
 *
 * `JSON.stringify` keeps the key order of whatever wrote the document last, so
 * two documents with the same content but a different key order would hash
 * differently. This walk sorts every object's keys, so the digest below depends
 * on content alone. Values are already JSON projections (`aggregateSchema`
 * normalizes through `JSON.parse(JSON.stringify(...))`), so no `undefined`,
 * `NaN` or cyclic value can reach it.
 */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
/** Content digest of one aggregate: the transaction keeps this instead of a
 *  second copy of the aggregate it started from. */
const aggregateDigest = aggregate => createHash('sha256').update(stableJson(aggregate)).digest('hex');
/** Key-by-key equality of two validated event ledgers (string MACs). */
const sameEventLedger = (left, right) => {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => left[key] === right[key]);
};
/** The refusal a publication raises when the document it was computed from is
 *  no longer the committed one. Same code as the lock refusal - the caller's
 *  remedy is the same (do not retry against state it did not read) - with a
 *  message that names the actual cause. */
const E_COMMIT_OVERWRITTEN = 'E_DOMAIN_ARCHIVE_LOCK: the shared domain document has been changed by another commit since this transaction started, so its pending record was not published';
/**
 * The durable commit token: one small file beside the archive lock that every
 * write of the shared domain document advances.
 *
 * It is not a second coordination mechanism; it is the only durable evidence a
 * commit leaves behind. The official domain layer keeps the document this port
 * read in memory and updates it from this port's own writes only (`global.get()`
 * returns the live value, it never re-reads the medium), so a comparison of the
 * in-memory document against the transaction's baseline cannot see a commit
 * another port published - and the medium (a whole-document replace) offers no
 * compare-and-swap. Comparing this token is therefore what separates "the
 * document this transaction was computed from" from "the document another port
 * published meanwhile".
 *
 * The token carries no data and is never interpreted: an absent or empty file
 * reads as `null`, and a crash - or a write that fails - may leave it advanced
 * without a commit, which costs the next transaction one spurious refusal (it
 * reads whatever it finds as its baseline). It is deliberately not fsynced - a
 * crash ends every transaction, so only visibility between live ports matters -
 * but it is replaced atomically, so no reader sees a torn or empty token.
 */
const COMMIT_TOKEN_NAME = 'domain-commit.token';
/** Entropy for the token value and its private temporary name. Deliberately
 *  not `crypto.randomUUID()`: the differential harness stubs that function with
 *  a deterministic sequence so record ids persist reproducibly, and a token
 *  drawn from it would consume ids from the same sequence and shift every later
 *  id. The token stays opaque and is only ever compared for equality, so any
 *  independent 128-bit random value is enough - but it must differ per commit,
 *  because equal tokens are how a port detects that nobody else committed. */
const commitTokenEntropy = () => randomBytes(16).toString('hex');
function readCommitToken(file) {
  try { return fs.readFileSync(file, 'utf8').trim() || null; }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}
function writeCommitToken(file) {
  const temporary = `${file}.${commitTokenEntropy()}.tmp`;
  fs.writeFileSync(temporary, `${commitTokenEntropy()}\n`, { mode: 0o600 });
  try { fs.renameSync(temporary, file); }
  catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
}
/** Advance the token only while it still carries `expected`; `false` means
 *  another commit advanced it first and this transaction must not publish. The
 *  read and the replace are adjacent synchronous steps, so no other port of this
 *  process can interleave between them. */
function advanceCommitToken(file, expected) {
  if (readCommitToken(file) !== expected) return false;
  writeCommitToken(file);
  return true;
}
async function acquireArchiveLock(lock) {
  const deadline = Date.now() + LOCK_RETRY_MS;
  const raw = String(process.pid);
  for (;;) {
    // A lock whose bytes never arrived names no owner this process wrote, but
    // `readLockOwner` can only fall back to "no named owner" for content that
    // does not parse as a pid: a truncated pid (`"1"` of `"1234"`) reads as a
    // different, possibly live, pid and would refuse the archive for good. A
    // failed acquisition also returns no token, so no lock anyone holds can be
    // lost by dropping the entry this attempt created. `EEXIST` proves nothing
    // was created and never reaches the cleanup below.
    //
    // The removal is identity-fenced rather than by path: an empty lock is
    // reclaimable after `LOCK_SETTLE_MS`, so a port that stalled between the
    // exclusive open and the failed write can find another port's lock at this
    // path by the time it cleans up. `fstat` pins the inode this call created
    // before the write begins, and `removeLockIfUnchanged` puts back an entry
    // that is not it. Removal is best effort: a cleanup failure must not replace
    // the storage error the caller has to act on.
    let identity = null;
    try {
      const descriptor = fs.openSync(lock, 'wx', 0o600);
      try {
        const stat = fs.fstatSync(descriptor, { bigint: true });
        identity = { dev: String(stat.dev), ino: String(stat.ino) };
      } catch (error) {
        try { fs.closeSync(descriptor); } catch {}
        throw error;
      }
      try {
        fs.writeFileSync(descriptor, raw);
      } catch (error) {
        // The failed write is why the lock is unusable, so it stays the error
        // the caller sees even if closing the descriptor also fails.
        try { fs.closeSync(descriptor); } catch {}
        throw error;
      }
      fs.closeSync(descriptor);
      // The token carries the inode `fstat` read from this call's own descriptor,
      // not the one the path names now. An empty lock is reclaimable after
      // `LOCK_SETTLE_MS`, so a port that stalls between the open and the write
      // writes its pid into an entry another port has already renamed out of the
      // way: the bytes land on a detached inode that no path reaches, and an
      // identity read from the path would hand that port the new owner's inode as
      // its own token - two ports, identical pid bytes, both passing the
      // ownership fence. With this identity the stalled port cannot prove it owns
      // the path and refuses the write (`E_DOMAIN_ARCHIVE_LOCK`) instead of
      // overwriting a live owner.
      return { raw, identity };
    } catch (error) {
      if (identity) { try { removeLockIfUnchanged(lock, identity, null); } catch {} }
      if (error?.code !== 'EEXIST') throw error;
      const owner = readLockOwner(lock);
      if (!owner) continue;
      if (owner.pid === null) {
        let ageMs = 0;
        try { ageMs = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
        // Reclaim only the entry this decision was made about; a lock that was
        // replaced in the meantime stays where another process put it.
        if (ageMs >= LOCK_SETTLE_MS) { reclaimArchiveLock(lock, owner); continue; }
        if (Date.now() >= deadline) throw new Error('E_DOMAIN_ARCHIVE_LOCK');
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }
      if (owner.pid === process.pid || ownerAlive(owner.pid)) throw new Error('E_DOMAIN_ARCHIVE_LOCK');
      reclaimArchiveLock(lock, owner);
    }
  }
}
/** No authority token or mutable Memory is exported. Every mutation is queued,
 * staged and committed by this private port. The journal is NOT cross-medium atomic. */
export async function openDomainStorage(ctx, config) {
  const lock = path.join(config.presetDir, 'domain-archive.lock');
  const commitToken = path.join(config.presetDir, COMMIT_TOKEN_NAME);
  const lockToken = await acquireArchiveLock(lock);
  let domain;
  const root = path.join(config.presetDir, 'dockyard');
  const staging = path.join(config.presetDir, 'domain-staging');
  const scope = new AsyncLocalStorage();
  const token = {};
  const authority = { assertMutation() { if (scope.getStore() !== token) throw new Error('E_MUTATION_AUTHORITY_REQUIRED'); } };
  let chain = Promise.resolve(), closing = false, disposal, failure;
  let memory, observations;
  const evaluator = new EvolutionEvaluator();
  function enqueue(job) {
    if (closing) return Promise.reject(new Error('E_DOMAIN_CLOSED'));
    const result = chain.then(() => scope.run(token, job));
    chain = result.then(() => {}, error => { failure = error; });
    return result;
  }
  async function installPending() {
    const current = schema.parse(domain.global.get());
    if (!current.pending) return;
    // Recovery installs the live tree exactly where a commit does, so it proves
    // ownership first: a committed stage installed under a lock this port no
    // longer holds would write the shared tree beside the port that holds it.
    assertArchiveLockHeld(lock, lockToken);
    const source = stageDirectory(staging, current.pending.stage);
    if (!fs.existsSync(source)) throw new Error('E_DOMAIN_PENDING_ARCHIVE_MISSING');
    // The durable pending record carries the exact list of files the stage
    // changed, with their digests, so recovery installs those files (atomic
    // replace, replayable, never recomputing a partially applied event) and
    // leaves everything else untouched: a staged file that was not written is
    // a hard link to the live, already durable file. A stage that carries no
    // durable file list - one written by an older version - is replayed as a full copy.
    const files = current.pending.files;
    if (files) installArchiveFiles(source, root, files);
    else { copyArchives(source, root); syncTree(root); }
    // `current` is the output of `schema.parse` above, so `pending.aggregate`
    // and `pending.applied` are already validated projections of this exact
    // durable document; re-parsing them with the same schema can only
    // reproduce them. The two remaining fields are the literals below, which
    // are fixed valid values, so the closing document is provably accepted by
    // `schema` one step earlier and needs no second walk. The full validation
    // still happens before any staged file is installed, which is the boundary
    // that must not move.
    // Installing a committed record replaces the shared document, so it
    // advances the commit token first: a token that did not move would tell a
    // concurrent transaction that the document it read is still committed.
    writeCommitToken(commitToken);
    // The retention floor a reclaim committed travels with the pending record,
    // so replaying the transaction cannot install a pruned ledger without the
    // floor that proves what was pruned. A record written before the floor
    // existed falls back to the committed one (itself `null` on old data).
    const floor = current.pending.retention ?? current.retention ?? null;
    await domain.global.set({ schema: 1, aggregate: current.pending.aggregate, applied: current.pending.applied,
      ...(floor === null ? {} : { retention: floor }), pending: null });
    removeStage(source);
  }
  async function createMemory(dir, initial, archiveWriteGuard = null, deferLoadArchiveWrites = false, archiveReadCache = memory?.archiveReadCache) {
    let aggregate = structuredClone(initial);
    // The bridge markers this transaction's saves reuse verdicts for; it lives
    // exactly as long as this working store (see `assertStagedTransactionSave`).
    const markerVerdicts = new WeakMap();
    // `inlineSerialization` is honest here: `update` captures the bytes of the
    // payload it is handed with the synchronous `JSON.stringify` below, before
    // it returns, so the caller's live shallow view cannot change what is
    // checked. It keeps no snapshot of those bytes, and no reader of this store
    // wants one (see below).
    //
    // What that check does not do any more is keep the projection it used to
    // build and store. Two things were true of `aggregateSchema.parse(payload)`
    // at this call site, and only the second one is observable:
    //
    // - The value it returned was never read. The only commit path is
    //   `mutate()`, which publishes the snapshot it takes after `work()`
    //   returns; the next updater keeps only `evolution`, which it replaces
    //   wholesale; and the store's own `load()` has exactly two callers -
    //   `reconcile()` and `verifyConsistency()` - neither of which any port path
    //   reaches (`createMemory` itself loads the instance before a record
    //   exists). So the projection was built and dropped once per save, and a
    //   transaction saves once per appended record plus once for the bridge
    //   marker (`measurement-completed` 2, a rejected/failure pair 3,
    //   `canary-passed` 5-6): a burst projected the whole document once per save
    //   - 2 to 6 times per record, growing with the records the burst has
    //   already appended - and kept none of those projections.
    //
    // - Its exception behaviour is reproduced step for step. The preprocess
    //   (`toJsonProjection`) has three steps that can throw - the stringify, the
    //   parse of its output, and the recursive own-`__proto__` copy - and
    //   `assertTransactionSave` runs the same three in the same order, so a save
    //   still throws exactly where it threw (including the `SyntaxError` of
    //   parsing an `undefined` stringify and the `RangeError` of a copy that
    //   overflows). Only the parse on the common path is skipped, and that is the
    //   step that builds the deep copy nothing reads.
    //
    //   What is not reproduced is the schema's verdict on that projection, and it
    //   is fixed for this payload: its only own top-level key is `evolution`
    //   (every state this store holds is either the initial committed aggregate or
    //   a payload of the same shape, and the durable schema admits nothing else),
    //   and the only field the schema inspects inside it is an integer
    //   `schema >= 4`, which the durable document this port loads guarantees
    //   (`memory.js`'s `schema: Math.max(4, Number(...) || ...)` keeps it at every
    //   load and reconcile; the looser values a direct `restore()` could inject
    //   are outside this store's reach, because no port path calls it). Both
    //   events the port feeds this store are JSON-projected before they reach it
    //   (`projectExecutionEvent`, `safeRecord`, `projectObservation`), so a payload
    //   the verdict could reject is not reachable from here either.
    //
    // Keeping the stringify therefore keeps the only observable effect of the
    // removed call - the throw - on the exact same value, and the durable
    // document is still validated in full by the publication's `schema.parse`.
    const stateStore = { filePath: path.join(dir, 'state.json'), inlineSerialization: true, load: async () => aggregate,
      // `load` hands out the aggregate this factory already cloned from
      // `initial` above; it used to clone it a second time. The only reader of
      // that value is the instance created below, through exactly one
      // `EvolutionMemory.load()` (`loaded` guards any later call), which spreads
      // it into its own state and keeps the collection arrays - it keeps neither
      // the store's object nor a copy of it. The store's own later reader is the
      // `update` spread base below, and that spread replaces the only field the
      // aggregate carries (`evolution`, the one key `aggregateSchema` admits)
      // with the payload before the result is kept, so no reader ever observes
      // the second copy. This is the same shallow-view stance
      // `inlineSerialization: true` already takes for the payload `update` is
      // handed: neither direction keeps a snapshot of values no reader wants.
      // The eager `structuredClone(initial)` above stays, because it is what
      // detaches this transaction from the committed document (and refuses a
      // live value the medium could not store).
      update: async updater => {
        const next = updater(aggregate);
        assertStagedTransactionSave(next, markerVerdicts);
        aggregate = next;
      } };
    const instance = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority, archiveWriteGuard, deferLoadArchiveWrites, archiveReadCache, coalesceMeasurementMarkerPersist: archiveWriteGuard !== null, deferArchiveIndexWrites: archiveWriteGuard !== null });
    // The load's own work is required (state restore, archive index
    // reconciliation, eviction and archival); the hot projection it would
    // return is not: no caller of this factory reads it.
    await instance.load({ snapshot: false });
    return { instance };
  }
  async function hydrate(archiveReadCache = memory?.archiveReadCache) {
    const index = path.join(root, 'state.json.evolution-archive-index.json');
    const before = fs.existsSync(index) ? fs.statSync(index).ino : null;
    // The live tree is loaded without writing to it: a load-time eviction would
    // append to a live archive file outside any staged transaction, and a crash
    // there leaves a fragment no later append can repair. Over-limit records stay
    // in this instance's hot projection and the next mutation archives them
    // inside its own transaction, which is where archive writes belong.
    const current = await createMemory(root, domain.global.get().aggregate, null, true, archiveReadCache);
    memory = current.instance;
    // The store is not read afterwards, and neither is the projection its
    // `load()` would return, so the load is asked for without it. What
    // `hydrate()` does need from the load is its cold-history read:
    // `memory.hasColdHistory` derives `Number(count)` from every
    // `coldArchives` entry and therefore rejects a durable aggregate whose
    // entry cannot be coerced. Removing this call silently accepted the first
    // commit after such a state was written; keeping it preserves the loud
    // failure the released implementation has, with or without the projection.
    observations = new EvolutionObservationStore({ memory });
    await observations.load({ snapshot: false });
    // Loading may repair the derived index by atomic replacement. Keep that
    // repaired file durable before a later stage shares its inode.
    if (fs.existsSync(index) && fs.statSync(index).ino !== before) { syncFile(index); syncFile(root); }
  }
  async function mutate(work, applied, details = null) {
    await installPending();
    // The ledger has to be read after the recovery above: `installPending()`
    // installs a committed pending record's ledger, and a snapshot taken before
    // it would write the recovered markers straight back out of the record, so
    // the next replay would apply events whose marker it had just lost. A
    // caller that passes its own ledger (`replay()` adds the event it just
    // verified) is merged onto the recovered one: recovery only ever installs
    // committed markers, and the caller's set is the newer of the two.
    const committed = domain.global.get();
    const recovered = committed.applied;
    // The publication below replaces the whole shared document, so the
    // transaction remembers the committed state it was computed from: the ledger
    // it merges onto, the aggregate it started from, and the durable commit
    // token. The publication refuses to publish when any of the three changed by
    // then. The aggregate is compared by value through the deterministic digest
    // below, but an unchanged reference settles it without hashing: while nothing
    // replaced this port's document, the value is the very object captured here,
    // so an ordinary commit does not walk its aggregate a second time.
    const baseline = { applied: { ...recovered }, aggregate: committed.aggregate, token: readCommitToken(commitToken) };
    // A caller may also hand in a *decision* instead of a ledger table. Only the
    // reclaim does, because it is the one operation that both removes markers
    // and advances the retention floor, and both must be derived from the work
    // it just ran. A table keeps the released merge, and the floor it commits is
    // the committed one.
    const committedRetention = committed.retention ?? null;
    const stage = `stage-${randomUUID()}`;
    const dir = stageDirectory(staging, stage);
    // The stage is a mirror of the committed tree: a hard link for every file the
    // transaction may write in place, and a link to the live directory for every
    // sealed segment directory it may not (see `mirrorArchives`). Unchanged files
    // need no copy and no fsync because they are the bytes that were already
    // durable in the committed tree.
    const mirror = mirrorArchives(root, dir);
    const privatized = new Set();
    const archiveWriteGuard = file => privatizeArchiveFile({ live: root, directory: dir, snapshot: mirror, privatized, file });
    const current = await createMemory(dir, domain.global.get().aggregate, archiveWriteGuard);
    const store = new EvolutionObservationStore({ memory: current.instance });
    // `recovered` is the committed marker map *after* the recovery above, so
    // `work` can tell a record that this transaction still has to apply from one
    // a recovered commit already installed. It is not a cache: the memory's own
    // bridge marker window keeps only the last 4096 records, which is not enough
    // to recognise a long group that this port already applied.
    const result = await work(current.instance, store, { recovered });
    // The appends this work did owe the staged archive index one document instead
    // of one per archived record. Pay it here, before anything below reads the
    // stage. The flush is load-bearing for publication, not for validation: the
    // index is a hard-linked archive name, so a document this instance never wrote
    // is byte-identical to the committed one and `changedArchiveFiles()` would
    // simply not list it - the transaction would install the archive files without
    // the index, and `hydrate()` would rewrite it after the commit, leaving a
    // window in which the committed tree has archived bytes and no index at all.
    await current.instance.flushDeferredArchiveIndex();
    // Even a deduplicated operation must retain load/maintenance changes.
    const aggregate = { evolution: current.instance.snapshot() };
    // Nothing may have written the live tree through the staged mirror; if it
    // did, the stage no longer describes the committed archive and the
    // transaction fails loudly instead of installing a mixed tree.
    assertLiveTreeUnchanged(root, mirror);
    // The live root is what proves a deletion's bytes: a file the stage no
    // longer has is removed only after its committed digest is re-read from the
    // tree the transaction snapshotted.
    const files = changedArchiveFiles(dir, mirror, root);
    const decided = typeof applied === 'function'
      ? applied(recovered, committedRetention)
      : { ledger: mergeEventLedger(recovered, applied), retention: committedRetention };
    const ledger = decided.ledger;
    const retention = decided.retention ?? null;
    if (details) {
      details.changed = files.filter(entry => entry.removed !== true).length;
      details.removed = files.filter(entry => entry.removed === true).length;
      details.stagedBytes = files.reduce((sum, entry) => entry.removed === true ? sum : sum + entry.bytes, 0);
      details.removedBytes = files.reduce((sum, entry) => entry.removed === true ? sum + entry.bytes : sum, 0);
    }
    // The stage commits before the aggregate: recovery can always replay the
    // staged files and then commit, and never recomputes an event whose
    // marker is already durable. Files the writer did not touch are hard
    // links to the committed tree, so an empty change list installs nothing.
    writeStageManifest(dir, files);
    // A transaction that changed no archive file has nothing to sequence: the
    // pending record exists so that recovery can replay staged bytes onto the
    // committed tree before the aggregate that describes them is read, and its
    // install list is empty here. Writing that record, installing nothing and
    // clearing it again would replace the whole document twice and fsync a
    // stage no durable record names, so this transaction commits the document
    // it ends at in one write and drops the stage.
    const staged = files.length > 0;
    if (staged) syncStage({ directory: dir, stagingRoot: staging, files });
    // Publishing the pending record is the commit point: it makes this
    // transaction the document every later port reads and recovers, and it
    // replaces the aggregate the real lock owner may have just committed. The
    // lock is therefore re-proved immediately before it.
    assertArchiveLockHeld(lock, lockToken);
    // The fence proves which entry the lock path holds; it cannot prove that the
    // document this transaction read is still the committed one, because the
    // check and the write are not one step. Two compares therefore guard the
    // publication: the document this port knows (a same-process writer sharing
    // this handle shows up here), and the durable commit token that every write
    // of that document advances (the only cross-port evidence available - see
    // COMMIT_TOKEN_NAME). Either one failing publishes nothing; the stage stays
    // on disk as the record of the refused transaction.
    //
    // Residual boundary, stated exactly: the compare and the write are still two
    // steps. A commit that lands after the token was advanced and before the
    // medium's atomic replace completes is still overwritten by this write, and
    // this port cannot detect it. That window is one in-flight backend write
    // instead of the whole transaction (stage mirror, work and fsyncs), and
    // closing it entirely needs a compare-and-swap from the medium itself: the
    // official domain handle offers `get`/`set` over the document this process
    // loaded, and the JSON backend replaces the whole unit in one write, so no
    // such primitive exists here. Re-reading the medium by reopening the domain
    // would drop this port's domain handle, which the port's own lifecycle pins.
    const latest = domain.global.get();
    const unchanged = latest.pending === null
      && sameEventLedger(latest.applied, baseline.applied)
      && (latest.aggregate === baseline.aggregate
        || aggregateDigest(latest.aggregate) === aggregateDigest(baseline.aggregate));
    if (!unchanged || !advanceCommitToken(commitToken, baseline.token)) throw new Error(E_COMMIT_OVERWRITTEN);
    if (staged) {
      await domain.global.set(schema.parse({ schema: 1, aggregate: latest.aggregate, applied: latest.applied,
        pending: { stage, aggregate, applied: ledger, files, ...(retention === null ? {} : { retention }) } }));
      await installPending();
    } else {
      // The document the two-write path converges to: the committed aggregate and
      // ledger this transaction computed, with no pending record. `schema.parse`
      // still projects and validates exactly what `installPending()` wrote, and
      // the stage is removed where an install would have removed it. A crash
      // before this write leaves the previous document and an unreferenced stage
      // directory, which is the same state a crash before the pending record
      // leaves today.
      await domain.global.set(schema.parse({ schema: 1, aggregate, applied: ledger, pending: null, ...(retention === null ? {} : { retention }) }));
      removeStage(dir, mirror);
    }
    await hydrate(current.instance.archiveReadCache);
    return result;
  }
  async function replay() {
    const writer = config.eventBridgeWriter || EVENT_BRIDGE_DEFAULT_WRITER;
    const checkpointFile = eventLogCheckpointPath(config.presetDir);
    // The stored checkpoint lets an authenticated, already absorbed prefix skip
    // per-record work. It is only trusted when its keyed digest matches the
    // bytes on disk now, so any change to consumed history still falls back to
    // full per-record verification below.
    const committedDocument = domain.global.get();
    const committedRetention = committedDocument.retention ?? null;
    // A committed floor can outlive the rewrite it describes: the commit is the
    // point of no return and the truncation is its replayable completion, so a
    // crash between them must not turn into a permanent refusal. Finishing it
    // first is also what makes the records below actually gone: their markers were
    // pruned with the floor, so the bytes must leave before anything is planned.
    // With a floor, a *missing* log is a refusal like any other non-continuation:
    // the floor says the log had bytes, so its absence is an external destruction
    // of a durable artifact, not a fresh start.
    if (committedRetention?.log) {
      const floorLog = config.eventBridgePath ? (() => {
        try { return fs.statSync(config.eventBridgePath).size; } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          return null;
        }
      })() : null;
      if (floorLog === null) {
        const missing = new Error('E_DOMAIN_EVENT_LOG_FLOOR_MISMATCH: a retention floor is committed but the event log is missing; restore its retained bytes or start a new data root');
        missing.code = 'E_DOMAIN_EVENT_LOG_FLOOR_MISMATCH';
        throw missing;
      }
      let completion;
      try {
        completion = completeEventLogTruncation({ file: config.eventBridgePath, key: config.eventBridgeKey,
          floor: committedRetention, withAppendLock: withEventBridgeAppendLock });
      } catch (error) {
        // The committed truncation could not run (a live writer holds the append
        // lock, or the file cannot be rewritten). The state is consistent and the
        // next pass retries a lock race, but a rewrite that fails for its own
        // reason is permanent: that pass cannot prove anything about the log, so
        // it reports the real cause instead of a synthesized retry hint.
        throw truncationFailure(error, 'the committed truncation could not run; retry once the writer releases the log');
      }
      void completion;
    }
    const plan = planEventLogReplay({ file: config.eventBridgePath, key: config.eventBridgeKey, writer,
      checkpoint: readEventLogCheckpoint(checkpointFile), applied: committedDocument.applied, retention: committedRetention });
    if (!plan) return { applied: 0, duplicates: 0 };
    let applied = 0, duplicates = plan.trusted ? plan.prefixRecords : 0;
    let first = null, last = null;
    // Records this pass authenticated but has not committed yet. A step that
    // arrives after a burst of events (one operation emits two or three
    // records, the autonomous observer emits them between steps, or the process
    // was down while another one appended) used to pay one complete durable
    // transaction per record: a stage mirror, an aggregate snapshot, two
    // whole-document writes, their fsyncs and a full reload. The records are
    // independent and already ordered, and each one still pays its own parse,
    // MAC verification, writer check, marker/conflict check and application in
    // file order, so the group is committed by one transaction that replaces
    // the per-record ones. Nothing is skipped, reordered or applied twice; only
    // the transport work between them is shared.
    const batch = [];
    // The marker map is the dedup authority for the pass, so a record this batch
    // owns must stay visible to the marker check of the record after it until
    // the commit publishes it.
    const batchMarks = new Map();
    const absorb = (line, { witnessed }) => {
      const envelope = JSON.parse(line);
      const verified = verifyEventBridgeEnvelope(envelope, config.eventBridgeKey);
      if (!eventBridgeWriterTrusted(verified, writer)) throw new Error('E_DOMAIN_EVENT_AUTH');
      const eventId = safeIdentifier(verified.event.eventId);
      if (witnessed) {
        const witness = { id: String(eventId), mac: envelope.mac };
        first ??= witness;
        last = witness;
      }
      // Authenticate every record the checkpoint does not cover, including
      // duplicates, before consulting the marker. Already committed events need
      // neither a second parse nor a full DTO.
      const marker = domain.global.get().applied[eventId] || batchMarks.get(eventId);
      if (marker) {
        if (marker !== envelope.mac) throw new Error('E_DOMAIN_EVENT_ID_CONFLICT');
        duplicates++; return;
      }
      batchMarks.set(eventId, envelope.mac);
      batch.push({ eventId, mac: envelope.mac, event: projectExecutionEvent(verified.event) });
    };
    /** Commit what this pass authenticated as one transaction. */
    const commit = async () => {
      if (!batch.length) return;
      const entries = batch.splice(0, batch.length);
      batchMarks.clear();
      // The whole committed map is handed to `mutate()` rather than only the
      // records this group adds: the transaction merges the caller's set onto the
      // markers an interrupted commit recovered from disk, and it must keep
      // refusing an eventId the two sides disagree about
      // (`E_DOMAIN_EVENT_ID_CONFLICT`) - a marker only this group knows is not
      // enough to detect that.
      const ledger = { ...domain.global.get().applied };
      for (const entry of entries) ledger[entry.eventId] = entry.mac;
      const outcome = await mutate(async (instance, store, { recovered }) => {
        let duplicated = 0;
        for (const entry of entries) {
          // A recovered commit installed this record's aggregate effects and its
          // marker before this transaction read the document, so it is already
          // durable and must not be applied again. The memory cannot decide this
          // on its own: it keeps only the last 4096 bridge markers
          // (`#markBridgeApplied`), so re-applying a longer group would re-apply
          // its head - and that append scrolls the window, cascading through the
          // rest of the group. The committed ledger is the authority.
          if (recovered[entry.eventId] === entry.mac) { duplicated += 1; continue; }
          const result = await instance.applyExecutionEvent(entry.event);
          if (result.duplicate) duplicated += 1;
        }
        return { duplicates: duplicated };
      }, ledger);
      duplicates += outcome.duplicates;
      applied += entries.length - outcome.duplicates;
    };
    let refusal = null;
    for (const line of plan.lines) {
      if (!line.trim()) continue;
      try { absorb(line, { witnessed: true }); } catch (error) { refusal = error; break; }
    }
    // A torn trailing line is processed exactly as before but stays outside
    // the checkpoint, so a later append re-processes it instead of silently
    // skipping bytes that were never a complete record.
    if (!refusal && plan.remainder.trim()) {
      try { absorb(plan.remainder, { witnessed: false }); } catch (error) { refusal = error; }
    }
    // The per-record path committed every record it had authenticated before the
    // one that was refused, so a refusal must not roll back what this pass has
    // already verified: that progress is committed first and the refusal is then
    // reported exactly as before, without advancing the checkpoint below. A
    // failure inside the group's own transaction aborts the whole group instead:
    // nothing of it is published, and the next pass re-applies it in file order
    // with the same marker map, so no record can be skipped or applied twice. If
    // that commit fails while a refusal is also pending, the commit failure is
    // what the pass reports - the per-record path reached the same commit before
    // it read the refused record.
    await commit();
    if (refusal) throw refusal;
    if (plan.advance) {
      try {
        const after = domain.global.get();
        writeEventLogCheckpoint(checkpointFile, eventLogCheckpointDocument({ plan, writer, key: config.eventBridgeKey,
          applied: after.applied, retention: after.retention ?? null, witnesses: { first, last } }));
      } catch (error) {
        // Losing the checkpoint only means the next pass re-verifies history.
        // The warning is a log line, and a log line is a boundary: it carries
        // the safe DTO (redacted summary, category, digest), not the raw message.
        // It goes through the one redacted-warning entry point so the warning
        // cannot become the outcome of the pass: a logger that throws, or one
        // that rejects, stays a diagnostic instead of a failed flush.
        warnRedacted(ctx, 'event log checkpoint not written', error, 'event-log-checkpoint');
      }
    }
    return { applied, duplicates };
  }
  /** Read the bridge log once, or report why it cannot be read. */
  function readEventLogBytes() {
    const file = config.eventBridgePath;
    if (!file) return { status: 'not-configured' };
    if (typeof config.eventBridgeKey !== 'string' || config.eventBridgeKey.length < 16) return { status: 'no-key' };
    try { return { status: 'readable', file, bytes: fs.readFileSync(file) }; }
    catch (error) {
      if (error?.code === 'ENOENT') return { status: 'absent' };
      throw error;
    }
  }
  const eventBridgeWriterName = () => config.eventBridgeWriter || EVENT_BRIDGE_DEFAULT_WRITER;
  /**
   * The evidence the rows of one prefix carry, per experiment.
   *
   * It is the same projection the hydration chain reads (`readEventBridgeEvidence`
   * via the shared index), applied to the bytes that are about to be discarded.
   * Only experiments the prefix actually mentions are considered: a record that
   * another experiment's rows already carry loses nothing when this prefix goes.
   */
  function prefixEvidence(prefix, writer) {
    const index = createEventBridgeEvidenceIndex({ key: config.eventBridgeKey, trustedWriters: [writer] });
    const mentioned = new Set();
    for (const line of prefix.toString('utf8').split('\n')) {
      const routed = index.consume(line);
      if (routed) mentioned.add(routed.experimentId);
    }
    const entries = [];
    for (const experimentId of index.experimentIds()) {
      if (!mentioned.has(experimentId)) continue;
      const evidence = index.project(experimentId);
      if (evidence) entries.push({ experimentId, evidence });
    }
    return entries;
  }
  /**
   * Discard the absorbed prefix of the bridge log and derive the ledger/floor
   * that must be committed with it.
   *
   * The order is the safety argument. Evidence leaves the log first (the
   * externalizer writes it durably and throws to abort otherwise), then the
   * transaction commits the pruned ledger and the floor - and only after that
   * commit does anything truncate the log. A refused commit therefore leaves the
   * log untouched, and a truncation that never ran is completed by the first
   * replay from the committed floor (`completeEventLogTruncation`): the floor
   * records both the bytes it was computed from and the bytes that stay, so the
   * state "committed but not yet truncated" is provable instead of a refusal.
   */
  function requireReclaimContinuation(source, retention, { dryRun = false } = {}) {
    if (!retention?.log) return 'ready';
    const floor = retention.log;
    if (source.status === 'readable' && verifyLogFloorTail({ buffer: source.bytes, floor, key: config.eventBridgeKey })) return 'ready';
    if (dryRun && source.status === 'readable'
      && inspectEventLogFloor({ file: source.file, key: config.eventBridgeKey, floor: retention }).status === 'deferred') return 'pending-truncation';
    const error = new Error('E_DOMAIN_EVENT_LOG_FLOOR_MISMATCH: reclaim requires the committed retention tail; restore its retained bytes or start a new data root');
    error.code = 'E_DOMAIN_EVENT_LOG_FLOOR_MISMATCH';
    throw error;
  }
  function finishReclaimTruncation(retention) {
    if (!retention?.log) return;
    try {
      completeEventLogTruncation({ file: config.eventBridgePath, key: config.eventBridgeKey,
        floor: retention, withAppendLock: withEventBridgeAppendLock });
    } catch (cause) {
      throw truncationFailure(cause, 'the previous committed truncation could not run; retry once the writer releases the log');
    }
  }
  /**
   * The one append-lock outcome is retryable; every other failure of a committed
   * truncation is not, and keeps its own code so an operator sees what actually
   * failed. Reporting a permanent refusal as `E_DOMAIN_EVENT_LOG_BUSY` used to
   * make it look like a lock race that a restart would clear, while every later
   * pass failed the same way.
   */
  function truncationFailure(cause, message) {
    if (cause?.code !== EVENT_BRIDGE_APPEND_LOCK_BUSY) return cause;
    const error = new Error(`E_DOMAIN_EVENT_LOG_BUSY: ${message}`);
    error.code = 'E_DOMAIN_EVENT_LOG_BUSY';
    error.cause = cause;
    return error;
  }
  async function reclaimLog({ recovered, committedRetention, retainRecords, decision }) {
    // Finish the previous committed transaction before deriving another floor.
    // Otherwise blank bytes ahead of pruned markers can advance a new plan.
    finishReclaimTruncation(committedRetention);
    const source = readEventLogBytes();
    requireReclaimContinuation(source, committedRetention);
    if (source.status !== 'readable') return { status: source.status };
    const writer = eventBridgeWriterName();
    const key = config.eventBridgeKey;
    const plan = planLogPrune({ buffer: source.bytes, key, writer, applied: recovered, retainRecords });
    if (!plan) return { status: 'nothing-absorbed', bytes: source.bytes.length };
    const evidence = prefixEvidence(source.bytes.subarray(0, plan.prefixBytes), writer);
    let externalized = null;
    if (evidence.length > 0) {
      if (typeof config.externalizeEventEvidence !== 'function') {
        throw new Error('E_DOMAIN_EVIDENCE_EXTERNALIZER_REQUIRED: the event log prefix carries promotion/measurement evidence and no durable externalizer is configured, so the prefix cannot be discarded');
      }
      externalized = await config.externalizeEventEvidence(evidence);
    }
    const ledger = { ...recovered };
    for (const { eventId } of plan.prunable) delete ledger[eventId];
    const previous = committedRetention ?? null;
    const log = {
      bytes: (previous?.log?.bytes ?? 0) + plan.prefixBytes,
      records: (previous?.log?.records ?? 0) + plan.boundaryRecords,
      prior: plan.prior,
      tail: plan.tail,
    };
    decision.ledger = ledger;
    decision.retention = advanceRetention(previous, { prunable: plan.prunable, log, key });
    decision.plan = plan;
    return {
      status: 'discarded',
      file: source.file,
      bytes: source.bytes.length,
      discardedBytes: plan.prefixBytes,
      discardedRecords: plan.boundaryRecords,
      retainedBytes: plan.tail.bytes,
      prunedMarkers: plan.prunable.length,
      evidenceEntries: evidence.length,
      evidence: externalized,
    };
  }
  /**
   * Reclaim capacity from history that is already absorbed.
   *
   * Two things are reclaimed, and both are only ever removed on proof:
   *
   *   - Archives: the same semantic compaction `EvolutionMemory#compact()` has
   *     always performed (terminal records retired into aggregate rows), now
   *     expressed inside the domain transaction. The segments it no longer has
   *     are published as deletions in the committed change list, so the live
   *     tree loses them only after the replacement files are installed, and a
   *     replay installs exactly the same list.
   *   - The event log: its absorbed prefix is discarded, but only after the
   *     evidence those rows carry has been written to its durable home, and the
   *     markers of the discarded records are pruned only after the truncation is
   *     durable. The floor that records both is committed with the ledger.
   *
   * Everything else refuses: a compaction whose archive integrity gate finds
   * unreadable or conflicting evidence throws before any byte is discarded, and a
   * log that changed while it was being planned is left exactly as it was.
   */
  async function reclaimInternal(options = {}) {
    const dryRun = options.dryRun === true;
    const archives = options.archives !== false;
    const log = options.log !== false;
    const retainRecords = options.retainRecords === undefined ? DEFAULT_LOG_RETAIN_RECORDS : options.retainRecords;
    if (dryRun) {
      return scope.run(token, async () => {
        const report = { dryRun: true, archives: null, log: null };
        if (archives) report.archives = await memory.compact({ dryRun: true });
        if (log) {
          const source = readEventLogBytes();
          const continuation = requireReclaimContinuation(source, domain.global.get().retention, { dryRun: true });
          if (continuation === 'pending-truncation') report.log = { status: continuation, bytes: source.bytes.length };
          else if (source.status !== 'readable') report.log = { status: source.status };
          else {
            const plan = planLogPrune({ buffer: source.bytes, key: config.eventBridgeKey, writer: eventBridgeWriterName(), applied: domain.global.get().applied, retainRecords });
            report.log = plan
              ? { status: 'would-discard', bytes: source.bytes.length, discardedBytes: plan.prefixBytes, discardedRecords: plan.boundaryRecords,
                  retainedBytes: plan.tail.bytes, prunedMarkers: plan.prunable.length,
                  evidence: prefixEvidence(source.bytes.subarray(0, plan.prefixBytes), eventBridgeWriterName()).length }
              : { status: 'nothing-absorbed', bytes: source.bytes.length };
          }
        }
        return report;
      });
    }
    const report = { dryRun: false, archives: null, log: null, transaction: null };
    const decision = { ledger: null, retention: null, coverage: null };
    const details = {};
    await mutate(async (instance) => {
      if (archives) report.archives = await instance.compact();
      if (log) report.log = await reclaimLog({ recovered: domain.global.get().applied, committedRetention: domain.global.get().retention ?? null, retainRecords, decision });
      return null;
    }, (recovered, committedRetention) => (decision.ledger
      ? { ledger: decision.ledger, retention: decision.retention }
      : { ledger: recovered, retention: committedRetention }), details);
    report.transaction = { changedFiles: details.changed, removedSegmentFiles: details.removed,
      stagedBytes: details.stagedBytes, removedBytes: details.removedBytes };
    if (report.log?.status === 'discarded') {
      // The floor is committed; now the bytes may go. This is the same call the
      // next replay makes, so a failure here is a deferred truncation, not a
      // lost record - it is reported and completed on the following pass.
      let completed;
      try {
        completed = completeEventLogTruncation({
          file: report.log.file,
          key: config.eventBridgeKey,
          floor: domain.global.get().retention ?? null,
          withAppendLock: withEventBridgeAppendLock,
        });
      } catch (error) {
        // The floor is committed, so this is a deferred truncation: the next
        // replay finishes it. Reporting it as a failed reclaim would also poison
        // the port's recorded failure (and `close()` with it) for a state that is
        // already consistent.
        completed = { status: 'deferred', error: error?.code ?? 'E_DOMAIN_EVENT_LOG_DEFERRED' };
      }
      report.log.truncated = completed.status;
      report.log.truncatedBytes = completed.bytes ?? (completed.status === 'already-truncated' ? report.log.retainedBytes : 0);
      if (completed.error) report.log.truncatedError = completed.error;
      decision.coverage = completed.status === 'truncated' || completed.status === 'already-truncated'
        ? planRetainedCoverage({ buffer: fs.readFileSync(report.log.file), key: config.eventBridgeKey,
            writer: eventBridgeWriterName(), applied: domain.global.get().applied })
        : null;
    }
    if (decision.coverage) {
      // The truncation replaced every byte the previous checkpoint described, so
      // publish the one that describes the log as it is now. It is derived state:
      // losing it only costs the next pass a full verification, and a concurrent
      // port that writes its own checkpoint writes an equally valid one.
      try {
        const file = eventLogCheckpointPath(config.presetDir);
        const logStat = fs.statSync(report.log.file, { bigint: true });
        writeEventLogCheckpoint(file, eventLogCheckpointDocument({
          plan: { identity: { dev: String(logStat.dev), ino: String(logStat.ino) }, next: decision.coverage },
          writer: eventBridgeWriterName(),
          key: config.eventBridgeKey,
          applied: domain.global.get().applied,
          retention: domain.global.get().retention ?? null,
          witnesses: { first: decision.coverage.first, last: decision.coverage.last },
        }));
      } catch (error) {
        warnRedacted(ctx, 'reclaim checkpoint not written', error, 'event-log-checkpoint');
      }
    }
    return report;
  }

  try {
    domain = await ctx.storageDomain.open(evolutionDomainSpec);
    // Creating the two roots belongs to the guarded sequence: the storage
    // medium is already open here, so a failure at this point used to leave the
    // domain open and the lock held, and a retry in the same process met its own
    // pid and refused itself.
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    await scope.run(token, async () => {
      await installPending();
      if (!domain.global.get().aggregate.evolution && config.domainSeed === true) {
        // Only explicitly authorized NEW-root seed; never discover another home.
        const seed = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
        // A seeded document replaces the shared one, so it advances the token
        // for the same reason a commit does.
        writeCommitToken(commitToken);
        // A seed declares this root empty, so it also drops any retention floor:
        // keeping a floor without the ledger it describes would claim pruned
        // markers that the emptied ledger cannot prove.
        await domain.global.set(schema.parse({ schema: 1, aggregate: { evolution: { ...seed.evolution, eventBridge: { schema: 1, applied: [] } } },
          applied: {}, pending: null }));
      }
      await hydrate();
      // Establish durability once for archives inherited from older versions
      // or an explicitly seeded root, before sharing unchanged files.
      syncTree(root);
      syncFile(config.presetDir);
      await replay();
    });
  } catch (error) {
    // Close what this attempt opened and release only the lock it wrote, so the
    // failed attempt leaves nothing behind that a retry would trip over.
    //
    // A close that fails is the one case where the lock stays, and the failure
    // is reported beside the error that caused it, never instead of it. The
    // release is provably safe only after the medium confirmed it drained: a
    // rejected `Domain.close()` says the medium did not release the unit, and
    // this port then cannot prove it stopped writing the pending record that
    // recovery of this archive reads. The lock is a bare pid, so it is reclaimed
    // once this process is gone; keeping it here refuses a second port for the
    // rest of this process instead of admitting one beside an unproven writer.
    // That costs no recovery path: the domain handle a failed close leaves open
    // keeps its name in the facility, so a same-process retry is refused there
    // anyway.
    let closed = true;
    try { await domain?.close(); } catch (closeError) {
      closed = false;
      // Reported through the one redacted-warning entry point, which contains a
      // logger that throws and one that rejects: a diagnostic about the failed
      // close must never become the error this call throws, and must never leave
      // an unhandled rejection behind.
      warnRedacted(ctx, 'failed initialization kept the archive lock: the storage medium did not confirm its close', closeError, 'domain-close-cleanup');
    }
    if (closed) {
      // The release itself is cleanup too, so a throw here is reported the same
      // way rather than replacing the initialization error.
      try { releaseArchiveLock(lock, lockToken); } catch (releaseError) {
        warnRedacted(ctx, 'failed initialization could not release the archive lock', releaseError, 'lock-release-cleanup');
      }
    }
    throw error;
  }
  const close = () => {
    closing = true;
    // The close runs before the release, never in a `finally`: a rejected
    // `Domain.close()` leaves the medium unproven, so the lock is kept for the
    // reason the failed initialization above keeps it - no second port may open
    // this archive while this process cannot prove it stopped writing it. The
    // lock is a bare pid, so a later process reclaims it once this one is gone.
    return disposal ??= (async () => { await chain; await domain.close(); releaseArchiveLock(lock, lockToken); if (failure) throw failure; })();
  };
  ctx.effect(() => close);
  return Object.freeze({
    replay: () => enqueue(replay),
    // Explicit, owner-authorized capacity reclaim. It runs on the same queue and
    // the same staged transaction as every other mutation, so a concurrent writer
    // can never observe a half-reclaimed archive or a ledger without its floor.
    // The confirmation is refused *here*, before the operation is queued: a
    // caller error must not become the port's recorded failure, which `close()`
    // would otherwise rethrow at shutdown.
    reclaim: async options => {
      if (options?.dryRun !== true && options?.confirmation !== true) {
        throw new Error('E_DOMAIN_RECLAIM_CONFIRMATION: reclaiming retires archive history and prunes authenticated markers; an explicit confirmation: true is required');
      }
      return enqueue(() => reclaimInternal(options));
    },
    flush: () => enqueue(replay),
    observe: dto => enqueue(() => mutate((_memory, store) => store.record(projectObservation(dto)))),
    query: (collection = 'cycles', limit = 10) => {
      if (closing) throw new Error('E_DOMAIN_CLOSED');
      if (!['cycles', 'observations', 'proposals', 'experiments', 'promotions', 'outcomes', 'lineage', 'knowledge'].includes(collection)) throw new Error('E_DOMAIN_QUERY_COLLECTION');
      const rows = memory.historyWindow(collection, limit, { metadataOnly: true });
      return { collection, count: rows.count, entries: rows.entries.map(row => ({
        id: safeIdentifier(row.id), status: safeIdentifier(row.status), eventType: safeIdentifier(row.eventType),
        recordedAt: /^\d{4}-\d{2}-\d{2}T/.test(row.recordedAt || '') ? row.recordedAt : null,
      })), promotionMetrics: 'not-integrated-independent-evidence-required' };
    },
    // Evaluator is deliberately advisory, never production authority.
    evaluate: evidence => evaluator.evaluate(evidence),
    // On-demand, bounded read of the canonical knowledge rows this store already
    // owns. It is model-free and only called by an explicit owner-triggered
    // action; a failure here is reported to the caller, never cached as
    // "no history".
    recall: (input = {}, options = {}) => {
      if (closing) throw new Error('E_DOMAIN_CLOSED');
      // The collector's own contract is what is bounded: it scans the stored
      // canonical key of every row and projects the rows inside its
      // `maxConsidered` window, plus an exact key replay outside it. The scan
      // view answers both from the archive index, so a complete history is not
      // materialised to answer it and neither the returned records nor the
      // reported `scanned`/`considered` counts change.
      const query = buildExperienceQuery(input);
      return collectKnowledgeExperience(memory.historyScan('knowledge', {
        exactKey: typeof query.knowledgeKey === 'string' ? query.knowledgeKey : null,
        window: EXPERIENCE_RECALL_LIMITS.maxConsidered,
      }), input, options);
    },
    close,
  });
}
/**
 * Merge the ledger a caller passes onto the one recovery installed.
 *
 * The caller's set is the newer of the two - `replay()` adds the event it just
 * verified - so a marker only the caller knows is added. When both sets know the
 * same eventId with a different MAC, they disagree about which envelope was
 * committed under that identity, and that is a conflict rather than an update:
 * it is the same condition the replay path rejects on the live ledger
 * (`E_DOMAIN_EVENT_ID_CONFLICT`). Letting either side win here would silently
 * rewrite an event identity that is already committed, so neither does. This
 * check runs on the ledger `installPending()` just installed, which is the only
 * moment the recovered markers - and therefore the conflict - are visible.
 *
 * The caller's table is walked with `Object.keys()` and one indexed read per key
 * instead of `Object.entries()`, which built a `[eventId, mac]` pair array for
 * every marker the table holds (20,000 of them at 20,000 committed events) only
 * to read the same two values back out of it. Both forms visit the same own
 * enumerable string keys in the same order and read each value exactly once;
 * `Object.entries()` only interleaves the descriptor read and the value read per
 * key, which is not observable on the table this function is given: its sole
 * caller is `replay()`, which builds that table as `{ ...applied }` and then
 * assigns one string MAC per new record, so every own property is a data
 * property written by the spread or by that assignment. (A table carrying
 * accessors would be the one shape where an interleaved read could differ, and
 * no port path produces one.) Exported so a differential regression can compare
 * it against the `Object.entries()` form it replaces; nothing outside this
 * module calls it.
 */
export function mergeEventLedger(recovered, applied) {
  if (!applied) return recovered;
  const merged = { ...recovered };
  for (const eventId of Object.keys(applied)) {
    const mac = applied[eventId];
    const known = merged[eventId];
    if (known !== undefined && known !== mac) throw new Error('E_DOMAIN_EVENT_ID_CONFLICT');
    merged[eventId] = mac;
  }
  return merged;
}
const safeIdentifier = value => typeof value === 'string' && /^[a-zA-Z0-9_:./-]{1,160}$/.test(value) ? value : null;
/**
 * The check a transaction's working store still performs on every save.
 *
 * It used to be the preprocess of `aggregateSchema.parse(payload)`, which built
 * the whole projection and then dropped it (see `createMemory`). This runs the
 * same three steps in the same order and discards what they produce, so a save
 * throws exactly where it threw: `JSON.stringify`; the `JSON.parse` of its output,
 * which throws only when the stringify returned `undefined`; and the recursive
 * own-`__proto__` copy, which runs only when the serialized text carries that
 * literal, and would overflow on a document nested deeply enough. The parse is the
 * step skipped on the common path, and it is the one that builds the deep copy no
 * reader wants; the substring search costs what that preprocess already paid for
 * the same decision.
 *
 * What is no longer reproduced is the schema's *verdict* on the projection, which
 * is fixed for the payload this updater produces (see `createMemory`). The check is
 * kept as a named function because the throw is a boundary - a save whose payload
 * JSON cannot represent aborts the transaction before anything is published - and
 * because `transaction-save-validation.test.js` pins it differentially against
 * `aggregateSchema`.
 */
export function assertTransactionSave(payload) {
  const text = JSON.stringify(payload);
  // `JSON.parse(undefined)` is the error the previous call reached through the
  // same expression; every other unrepresentable value already threw above.
  if (text === undefined) JSON.parse(text);
  else if (text.includes(`"${PROTO_KEY}"`)) withoutOwnProtoKeys(JSON.parse(text));
}
/** True when `key` is an own enumerable data property of `value`. */
function ownEnumerableDataProperty(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && descriptor.enumerable === true
    && descriptor.get === undefined && descriptor.set === undefined;
}
/**
 * True when `value` is a plain object - `Object.prototype` or a null prototype,
 * no own `toJSON` - whose own enumerable string keys are all data properties.
 * Copying such an object reads no code, and `JSON.stringify` writes it field by
 * field, so the staged check can read it once and rebuild the document around
 * it. A non-enumerable own `toJSON` is why the descriptor test is separate: it
 * is invisible to `Object.keys` and decisive for `JSON.stringify`.
 */
function plainDataObject(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertyDescriptor(value, 'toJSON') !== undefined) return false;
  for (const key of Object.keys(value)) {
    if (!ownEnumerableDataProperty(value, key)) return false;
  }
  return true;
}
/**
 * A value whose serialization this store may judge once and then reuse.
 *
 * The reuse is sound only for a value that cannot change afterwards, so this is
 * `Object.isFrozen` plus everything that would still make the serialization
 * live: a plain prototype (an inherited `toJSON` would run), an array (its
 * indices are not audited here), accessors (reading them is not a stable value),
 * and any own value that is not `null`, a string, a boolean or a number. The
 * last requirement is what makes the verdict *complete*: a value made only of
 * those cannot throw in `JSON.stringify`, so a memoized one can never be the
 * reason the whole document is rejected.
 */
function memoizableMarker(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!Object.isFrozen(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  // An own `toJSON` (enumerable or not) makes the text a function of code, not
  // of the frozen value, so it can never be memoized.
  if (Object.getOwnPropertyDescriptor(value, 'toJSON') !== undefined) return false;
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined) return false;
    const field = descriptor.value;
    if (field !== null && typeof field !== 'string' && typeof field !== 'number' && typeof field !== 'boolean') return false;
  }
  return true;
}
const EMPTY_WINDOW = Object.freeze([]);
/**
 * `assertTransactionSave` for the staged memory transaction, which is where the
 * whole-document check actually costs: a cold replay saves once per absorbed
 * record, and 96% of every one of those payloads is the bridge marker window
 * (`evolution.eventBridge.applied`, 729,112 of 757,413 bytes at 20,000 records).
 * Re-serializing that window on every save re-derives a verdict about markers
 * that cannot have changed: `EvolutionMemory` freezes each marker as it appends
 * it and never writes into an existing one, so `memoizableMarker()` holds for
 * everything in the window and each marker is serialized exactly once.
 *
 * The verdict is the one the whole-document check produces, because both
 * properties it decides are compositional over the document's parts:
 *
 *   - Representability. A memoized marker cannot throw (see
 *     `memoizableMarker()`), and every other byte of the document is serialized
 *     on every save, in the document's own key order, with only the window's
 *     contents replaced by an empty array. So the first value that makes the
 *     document unserializable is still the one that throws, with the same error.
 *   - The own-`__proto__` literal. `JSON.stringify` writes each value as a
 *     complete JSON value, and the bytes between two values (`{`, `}`, `[`, `]`,
 *     `,`, `:` and a key's own text) can never complete the literal, so a
 *     document's text contains it iff one of those parts does.
 *
 * Anything else - no `evolution.eventBridge.applied` array, an `eventBridge` or
 * `toJSON` this store did not produce, a window entry that is not a memoizable
 * marker, or a document whose text does contain the literal - runs the
 * unmodified `assertTransactionSave()` on the unmodified payload. The literal
 * case in particular must keep doing that: the recursive copy it triggers is
 * what can overflow, and it has to see the whole document.
 *
 * `verdicts` is the per-transaction memo. It is a `WeakMap` keyed by the marker
 * objects themselves, so it dies with the records it describes and needs no
 * invalidation: a memoized marker is frozen and holds only primitive data
 * properties, so its text - and therefore its verdict - cannot change. Exported
 * for the differential regression that compares it against
 * `assertTransactionSave()` on the same payloads; nothing outside this module
 * calls it.
 */
export function assertStagedTransactionSave(payload, verdicts) {
  const whole = () => assertTransactionSave(payload);
  // The document is rebuilt around the window, so the three members the rebuild
  // reads and then re-creates must be plain data objects with an own enumerable
  // data property at that key. Reading them then cannot run code, and reads no
  // value other than the one the document's own serialization sees - including
  // when this check falls back after having read them once.
  if (!plainDataObject(payload) || !ownEnumerableDataProperty(payload, 'evolution')) return whole();
  const state = payload.evolution;
  if (!plainDataObject(state) || !ownEnumerableDataProperty(state, 'eventBridge')) return whole();
  const bridge = state.eventBridge;
  if (!plainDataObject(bridge) || !ownEnumerableDataProperty(bridge, 'applied')) return whole();
  const window = bridge.applied;
  // The substitution takes the window out of the document, so it must be an
  // array `JSON.stringify` writes element by element: a subclass, or an array
  // carrying its own `toJSON`, answers with something else. An empty window
  // needs no substitution either - the payload is the document.
  if (!Array.isArray(window) || Object.getPrototypeOf(window) !== Array.prototype
    || Object.getOwnPropertyDescriptor(window, 'toJSON') !== undefined) return whole();
  if (window.length === 0) return whole();
  // Everything but the window, serialized exactly as the whole payload is.
  const text = JSON.stringify({ ...payload, evolution: { ...state, eventBridge: { ...bridge, applied: EMPTY_WINDOW } } });
  if (text === undefined) return whole();
  // A document that already carries the literal needs the whole-document check:
  // the recursive copy it triggers is what can overflow, and it has to see the
  // whole document. Nothing the window adds can change that verdict.
  if (text.includes(`"${PROTO_KEY}"`)) return whole();
  for (const marker of window) {
    let verdict = verdicts.get(marker);
    if (verdict === undefined) {
      if (!memoizableMarker(marker)) return whole();
      const markerText = JSON.stringify(marker);
      // `JSON.stringify` answers `undefined` for a value whose own `toJSON`
      // returns it; in an array that element is written as `null`.
      // `memoizableMarker()` already refuses a visible `toJSON`, so this is the
      // bottom of the ladder rather than a reachable state.
      if (markerText === undefined) return whole();
      verdict = markerText.includes(`"${PROTO_KEY}"`);
      verdicts.set(marker, verdict);
    }
    if (verdict) return whole();
  }
}
export function projectObservation(input = {}) {
  const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(input.code || '') ? input.code : 'HOST_OPERATION_FAILED';
  const target = safeIdentifier(input.target) || 'host';
  return { source: 'official-tools', type: input.type === 'agent/error' ? 'agent/error' : 'tool/error',
    code, message: `Official operation failed (${code})`, componentId: target, severity: 'error', status: 'failed' };
}
function projectExecutionEvent(event) {
  const identifier = value => safeIdentifier(value);
  const numeric = value => Object.fromEntries(Object.entries(value || {}).filter(([k,v]) => /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(k) && typeof v === 'number' && Number.isFinite(v)));
  return { schema: 1, eventId: identifier(event.eventId), eventType: event.eventType,
    experimentId: identifier(event.experimentId), proposalId: identifier(event.proposalId),
    target: identifier(event.target), capability: identifier(event.capability), lineageId: identifier(event.lineageId),
    status: identifier(event.status), failureFingerprint: identifier(event.failureFingerprint),
    failure: event.failure ? { code: 'EVOLUTION_OPERATION_FAILED' } : null,
    promotion: event.promotion ? { id: identifier(event.promotion.id) } : null,
    measurement: numeric(event.measurement), evidence: {}, canary: {},
    audit: { producer: 'dsh-evolution-orchestrator', at: event.audit?.at },
  };
}

/**
 * Run one bounded maintenance step under the archive lock a port takes.
 *
 * The doctor's offline repairs are the only caller. A staging directory may only
 * be removed while no port can sit between staging and publication, and a plan
 * read before this lock existed cannot answer that, so the callback re-reads and
 * acts under the lock. The callback is not a publication of the shared document
 * and proves no ownership of its own. The lock is released only while it is
 * still the entry this call wrote; a path this protocol cannot interpret is
 * never reclaimed or removed, it is reported as an error to the caller.
 */
export async function withArchiveLock(lockPath, operation) {
  const token = await acquireArchiveLock(lockPath);
  try { return await operation(); }
  finally { releaseArchiveLock(lockPath, token); }
}
