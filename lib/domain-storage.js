import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EvolutionMemory, EvolutionObservationStore, EvolutionEvaluator } from './dockyard-domain/index.js';
import { collectKnowledgeExperience } from './experience-recall.js';
import { EVENT_BRIDGE_DEFAULT_WRITER, eventBridgeWriterTrusted, safeErrorDto, verifyEventBridgeEnvelope } from './orchestrator.js';
import { eventLogCheckpointDocument, eventLogCheckpointPath, planEventLogReplay,
  readEventLogCheckpoint, writeEventLogCheckpoint } from './event-log-checkpoint.js';
import { assertLiveTreeUnchanged, changedArchiveFiles, copyArchives, installArchiveFiles, mirrorArchives,
  privatizeArchiveFile, stageDirectory, syncFile, syncStage, syncTree, writeStageManifest } from './archive-stage.js';

const json = z.json();
// The legacy aggregate can carry `undefined` object fields (e.g. relationRefs).
// JSON is the durable medium, and the old file backend already dropped those
// fields through JSON.stringify, so normalize to the exact JSON projection before
// validating: this keeps strict JSON validation without silently changing state.
const toJsonProjection = value => JSON.parse(JSON.stringify(value));
const aggregateSchema = z.preprocess(toJsonProjection,
  z.object({ evolution: z.object({ schema: z.number().int().min(4) }).catchall(json).optional() }).strict());
const appliedSchema = z.record(z.string(), z.string());
const archiveFilesSchema = z.array(z.object({ file: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict());
const schema = z.object({ schema: z.literal(1), aggregate: aggregateSchema, applied: appliedSchema,
  pending: z.object({ stage: z.string().regex(/^stage-[a-f0-9-]+$/), aggregate: aggregateSchema, applied: appliedSchema, files: archiveFilesSchema.optional() }).strict().nullable() }).strict();
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
    try {
      fs.writeFileSync(lock, raw, { flag: 'wx', mode: 0o600 });
      return { raw, identity: lockIdentity(lock) };
    } catch (error) {
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
    await domain.global.set({ schema: 1, aggregate: current.pending.aggregate, applied: current.pending.applied, pending: null });
    fs.rmSync(source, { recursive: true });
  }
  async function createMemory(dir, initial, archiveWriteGuard = null, deferLoadArchiveWrites = false) {
    let aggregate = structuredClone(initial);
    // `inlineSerialization` is honest here: `update` captures the bytes with
    // the synchronous JSON projection inside `aggregateSchema.parse` before it
    // returns, so the caller's live shallow view cannot change what is
    // persisted. The projection already produces a fresh deep value, so the
    // extra clone of the incoming aggregate would only copy it twice; the
    // updaters handed to this store are pure (`{ ...state, [key]: payload }`)
    // and never mutate the argument they receive.
    const stateStore = { filePath: path.join(dir, 'state.json'), inlineSerialization: true, load: async () => structuredClone(aggregate),
      update: async updater => { aggregate = aggregateSchema.parse(updater(aggregate)); } };
    const instance = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority, archiveWriteGuard, deferLoadArchiveWrites });
    // The load's own work is required (state restore, archive index
    // reconciliation, eviction and archival); the hot projection it would
    // return is not: no caller of this factory reads it.
    await instance.load({ snapshot: false });
    return { instance, getAggregate: () => structuredClone(aggregate) };
  }
  async function hydrate() {
    const index = path.join(root, 'state.json.evolution-archive-index.json');
    const before = fs.existsSync(index) ? fs.statSync(index).ino : null;
    // The live tree is loaded without writing to it: a load-time eviction would
    // append to a live archive file outside any staged transaction, and a crash
    // there leaves a fragment no later append can repair. Over-limit records stay
    // in this instance's hot projection and the next mutation archives them
    // inside its own transaction, which is where archive writes belong.
    const current = await createMemory(root, domain.global.get().aggregate, null, true);
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
  async function mutate(work, applied) {
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
    const ledger = mergeEventLedger(recovered, applied);
    const stage = `stage-${randomUUID()}`;
    const dir = stageDirectory(staging, stage);
    // The stage is a hard-link mirror of the live tree: complete and correct
    // without copying, and unchanged files need no fsync because they are the
    // bytes that were already durable in the committed tree.
    const snapshot = mirrorArchives(root, dir);
    const privatized = new Set();
    const archiveWriteGuard = file => privatizeArchiveFile({ directory: dir, snapshot, privatized, file });
    const current = await createMemory(dir, domain.global.get().aggregate, archiveWriteGuard);
    const store = new EvolutionObservationStore({ memory: current.instance });
    const result = await work(current.instance, store);
    // Even a deduplicated operation must retain load/maintenance changes.
    const aggregate = { evolution: current.instance.snapshot() };
    // Nothing may have written the live tree through the staged mirror; if it
    // did, the stage no longer describes the committed archive and the
    // transaction fails loudly instead of installing a mixed tree.
    assertLiveTreeUnchanged(root, snapshot);
    const files = changedArchiveFiles(dir, snapshot);
    // The stage commits before the aggregate: recovery can always replay the
    // staged files and then commit, and never recomputes an event whose
    // marker is already durable. Files the writer did not touch are hard
    // links to the committed tree, so an empty change list installs nothing.
    writeStageManifest(dir, files);
    syncStage({ directory: dir, stagingRoot: staging, files });
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
    await domain.global.set(schema.parse({ schema: 1, aggregate: latest.aggregate, applied: latest.applied, pending: { stage, aggregate, applied: ledger, files } }));
    await installPending();
    await hydrate();
    return result;
  }
  async function replay() {
    const writer = config.eventBridgeWriter || EVENT_BRIDGE_DEFAULT_WRITER;
    const checkpointFile = eventLogCheckpointPath(config.presetDir);
    // The stored checkpoint lets an authenticated, already absorbed prefix skip
    // per-record work. It is only trusted when its keyed digest matches the
    // bytes on disk now, so any change to consumed history still falls back to
    // full per-record verification below.
    const plan = planEventLogReplay({ file: config.eventBridgePath, key: config.eventBridgeKey, writer,
      checkpoint: readEventLogCheckpoint(checkpointFile), applied: domain.global.get().applied });
    if (!plan) return { applied: 0, duplicates: 0 };
    let applied = 0, duplicates = plan.trusted ? plan.prefixRecords : 0;
    let first = null, last = null;
    const absorb = async (line, { witnessed }) => {
      const envelope = JSON.parse(line);
      const verified = verifyEventBridgeEnvelope(envelope, config.eventBridgeKey);
      if (!eventBridgeWriterTrusted(verified, writer)) throw new Error('E_DOMAIN_EVENT_AUTH');
      const eventId = safeIdentifier(verified.event.eventId);
      if (witnessed) {
        const witness = { id: String(eventId), mac: envelope.mac };
        first ??= witness;
        last = witness;
      }
      // The committed domain marker covers the complete single-event batch.
      // Authenticate every record the checkpoint does not cover, including
      // duplicates, before consulting it. Already committed events need
      // neither a second parse nor a full DTO.
      const marker = domain.global.get().applied[eventId];
      if (marker) {
        if (marker !== envelope.mac) throw new Error('E_DOMAIN_EVENT_ID_CONFLICT');
        duplicates++; return;
      }
      const event = projectExecutionEvent(verified.event);
      const result = await mutate(instance => instance.applyExecutionEvent(event), { ...domain.global.get().applied, [event.eventId]: envelope.mac });
      if (result.duplicate) duplicates++; else applied++;
    };
    for (const line of plan.lines) {
      if (!line.trim()) continue;
      await absorb(line, { witnessed: true });
    }
    // A torn trailing line is processed exactly as before but stays outside
    // the checkpoint, so a later append re-processes it instead of silently
    // skipping bytes that were never a complete record.
    if (plan.remainder.trim()) await absorb(plan.remainder, { witnessed: false });
    if (plan.advance) {
      try {
        writeEventLogCheckpoint(checkpointFile, eventLogCheckpointDocument({ plan, writer, key: config.eventBridgeKey, applied: domain.global.get().applied, witnesses: { first, last } }));
      } catch (error) {
        // Losing the checkpoint only means the next pass re-verifies history.
        // The warning is a log line, and a log line is a boundary: it carries
        // the safe DTO (redacted summary, category, digest), not the raw message.
        const detail = safeErrorDto(error, 'event-log-checkpoint');
        ctx.logger?.warn?.(`[evolution] event log checkpoint not written: ${detail.errorSummary} (${detail.errorCategory}, ${detail.errorDigest})`);
      }
    }
    return { applied, duplicates };
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
        await domain.global.set(schema.parse({ schema: 1, aggregate: { evolution: { ...seed.evolution, eventBridge: { schema: 1, applied: [] } } }, applied: {}, pending: null }));
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
    await domain?.close();
    releaseArchiveLock(lock, lockToken);
    throw error;
  }
  const close = () => {
    closing = true;
    return disposal ??= (async () => { await chain; await domain.close(); releaseArchiveLock(lock, lockToken); if (failure) throw failure; })();
  };
  ctx.effect(() => close);
  return Object.freeze({
    replay: () => enqueue(replay),
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
      // The collector below projects every field it keeps into its own bounded
      // record and never returns or writes an input row, so the read-only view
      // is enough: copying the rows outside its `maxConsidered` window is the
      // whole cost of the detached history read at this size.
      return collectKnowledgeExperience(memory.historyView('knowledge'), input, options);
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
 */
function mergeEventLedger(recovered, applied) {
  if (!applied) return recovered;
  const merged = { ...recovered };
  for (const [eventId, mac] of Object.entries(applied)) {
    const known = merged[eventId];
    if (known !== undefined && known !== mac) throw new Error('E_DOMAIN_EVENT_ID_CONFLICT');
    merged[eventId] = mac;
  }
  return merged;
}
const safeIdentifier = value => typeof value === 'string' && /^[a-zA-Z0-9_:./-]{1,160}$/.test(value) ? value : null;
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
