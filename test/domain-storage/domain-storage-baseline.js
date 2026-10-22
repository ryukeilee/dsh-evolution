import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RELEASE_DIR, readTarEntries } from "../../scripts/release/release-lib.mjs";

const WORKING_SOURCE = fileURLToPath(new URL("../../lib/domain-storage.js", import.meta.url));

// The merged write-path variant under test landed after this artifact was
// pinned, so the artifact is the frozen pre-change source for it. The manifest
// pin moves on with every candidate, so the anchor is named explicitly instead
// of following it.
const PRE_CHANGE_ARTIFACT = "dsh-evolution-0.2.0-rc.8.tgz";
const SOURCE_PATH = "lib/domain-storage.js";

// [post-change text, pre-change text]. Reversing the change must reproduce the
// pinned artifact byte for byte; an exact single-occurrence guard fails on any
// shape drift instead of silently rebuilding something else.
//
// The three reversed pieces are the whole retained variant, and each one
// removes work that is provably redundant rather than any check that can still
// reject:
//
// 1. `installPending` closed a committed recovery by re-parsing the document it
//    had already parsed one step earlier. `pending.aggregate` and
//    `pending.applied` come straight out of that `schema.parse` result, and the
//    remaining fields are the literals `schema: 1` and `pending: null`, so the
//    closing document is provably accepted before the second walk starts. The
//    validation that must stay - the full document check that runs before any
//    staged file is installed - is untouched.
// 2. The state store's `update` cloned the incoming aggregate before handing it
//    to the updater, and then projected the result through
//    `aggregateSchema.parse`, which is itself a fresh deep value
//    (`JSON.parse(JSON.stringify(...))`). The clone could only be copied again.
//    Both updaters this store receives are pure spreads that never mutate their
//    argument.
// 3. The same store did not declare `inlineSerialization`, so `EvolutionMemory`
//    deep-cloned the live partition (`snapshot()`) before persisting it. The
//    bytes are captured synchronously by the JSON projection inside `update`,
//    so the shallow live view is equivalent and the clone is the third copy of
//    the same value in that call.
//
// A fourth candidate - dropping the `EvolutionObservationStore` that `hydrate()`
// loads and never reads - was measured with these three and then withdrawn: its
// `load()` is not inert, because `snapshot()` reads `memory.hasColdHistory`,
// which coerces every `coldArchives` entry with `Number(count)`. Dropping the
// call let the first commit after a durable aggregate with a non-coercible
// entry succeed where the released implementation refuses it. See
// `docs/performance/domain-write-path.md` section 4.
//
// A later round added a fourth reversed piece: both load calls that discard the
// projection they used to build now ask for it not to be built (`load({ snapshot:
// false })`). Loading is unchanged apart from the skipped clone, and the
// cold-history read the withdrawn candidate depended on is performed explicitly
// by the observation store's own `load()`.
//
// The write-path variant is not the only change after the anchor: on-demand
// experience recall added a read-only `recall` method to the same port, and a
// read that never writes cannot change the persisted bytes this file's
// benchmark compares. It is still reversed below so the reconstruction keeps
// reproducing the pinned pre-change source byte for byte instead of silently
// dropping the anchor. A later round stopped copying the rows that method reads
// (`memory.historyView`, the read-only view) because the collector projects
// every field it keeps into its own record; that is the same insertion, so the
// same piece reverses it.
//
// The last round after the anchor added the durable commit token and the
// pre-publication compare: `createHash` for the aggregate digest, one block of
// helpers (deterministic serialization, digest, ledger comparison, refusal
// message, token read/replace/advance), the token path beside the archive lock,
// the committed-state snapshot `mutate()` captures, the compare that refuses to
// publish, and the token advances in `installPending()` and the authorized seed.
// None of it changes the persisted aggregate the benchmark compares; it is
// reversed here for the same reason as the pieces above - the reconstruction
// reproduces the pinned artifact, not an approximation of it. Two of those
// pieces sit inside fragments an earlier round already own (the `installPending()`
// closing write and the pending publication), so they are folded into those
// fragments rather than given anchors of their own.
//
// Every piece below is applied in the order written, and each one names text the
// other direction can also find: no piece deletes text another piece is anchored
// on, and no piece is anchored on an empty string.
const reversals = [
  ["return { instance };", "return { instance, getAggregate: () => structuredClone(aggregate) };"],
  // The port-local parsed archive handoff is independent of the older write-path
  // changes below; remove it first to preserve the byte-exact release anchor.
  ["async function createMemory(dir, initial, archiveWriteGuard = null, deferLoadArchiveWrites = false, archiveReadCache = memory?.archiveReadCache)",
   "async function createMemory(dir, initial, archiveWriteGuard = null, deferLoadArchiveWrites = false)"],
  ["archiveWriteGuard, deferLoadArchiveWrites, archiveReadCache });", "archiveWriteGuard, deferLoadArchiveWrites });"],
  ["async function hydrate(archiveReadCache = memory?.archiveReadCache)", "async function hydrate()"],
  ["createMemory(root, domain.global.get().aggregate, null, true, archiveReadCache)", "createMemory(root, domain.global.get().aggregate, null, true)"],
  ["await hydrate(current.instance.archiveReadCache);", "await hydrate();"],
  // The publication compares the committed aggregate by content, so the module imports
  // `createHash` from the same module; both directions stay a single-line substitution.
  ["import { createHash, randomBytes, randomUUID } from 'node:crypto';\n",
   "import { randomUUID } from 'node:crypto';\n"],
  // The lock-fencing round landed after every round below, so it is reversed first.
  // `assertArchiveLockHeld()` re-proves, immediately before each write it guards, that
  // the lock this attempt acquired is still the entry at the lock path: the two guarded
  // points are the install of a staged tree (a commit and `installPending()`'s recovery
  // run the same install) and the publish of the pending record, which is the commit
  // point. It adds no field to the persisted document and moves no existing line, so the
  // three pieces are pure insertions and reversing them restores the pinned source; the
  // writes they precede are untouched. They are reversed in file order: the definition,
  // then its two call sites.
  ["  return removeLockIfUnchanged(lock, token.identity, token.raw) === LOCK_REMOVED;\n" +
   "}\n" +
   "/**\n" +
   " * Prove that the lock this port acquired is still the entry at the lock path.\n" +
   " *\n" +
   " * The lock is a bare pid, so the bytes alone cannot tell two ports of one\n" +
   " * process apart; the identity (device and inode) is what pins the file object\n" +
   " * `acquireArchiveLock` created. The two guarded points are the pending record\n" +
   " * that publishes a commit and the install of staged files into the live tree\n" +
   " * (recovery runs the same install): two ports that both believe they own the\n" +
   " * archive overwrite each other there, so a port that cannot prove ownership\n" +
   " * refuses the write instead. This is a check before the write, not a lease -\n" +
   " * the lock can still be taken between the check and the syscall that follows\n" +
   " * it, which is the window a filesystem without kernel leases leaves open. The\n" +
   " * derived archive index repair and the replay checkpoint are not committed\n" +
   " * archive data and are not gated by this check.\n" +
   " */\n" +
   "function assertArchiveLockHeld(lock, token) {\n" +
   "  // Any failure to prove ownership - replaced, gone, unreadable, not a regular\n" +
   "  // file - is a refusal, never a pass.\n" +
   "  let held;\n" +
   "  try {\n" +
   "    const identity = lockIdentity(lock);\n" +
   "    held = identity.dev === token.identity.dev && identity.ino === token.identity.ino\n" +
   "      && fs.readFileSync(lock, 'utf8') === token.raw;\n" +
   "  } catch { held = false; }\n" +
   "  if (!held) throw new Error('E_DOMAIN_ARCHIVE_LOCK');\n" +
   "}\n",
   "  return removeLockIfUnchanged(lock, token.identity, token.raw) === LOCK_REMOVED;\n" +
   "}\n"],
  // `installPending()` proves ownership before it installs staged files: recovery writes
  // the shared tree in exactly the place a commit does.
  ["    if (!current.pending) return;\n" +
   "    // Recovery installs the live tree exactly where a commit does, so it proves\n" +
   "    // ownership first: a committed stage installed under a lock this port no\n" +
   "    // longer holds would write the shared tree beside the port that holds it.\n" +
   "    assertArchiveLockHeld(lock, lockToken);\n",
   "    if (!current.pending) return;\n"],
  // `mutate()` proves ownership immediately before it publishes the pending record, which
  // is the commit point. The publish line itself belongs to the entry further down.
  ["    syncStage({ directory: dir, stagingRoot: staging, files });\n" +
   "    // Publishing the pending record is the commit point: it makes this\n" +
   "    // transaction the document every later port reads and recovers, and it\n" +
   "    // replaces the aggregate the real lock owner may have just committed. The\n" +
   "    // lock is therefore re-proved immediately before it.\n" +
   "    assertArchiveLockHeld(lock, lockToken);\n",
   "    syncStage({ directory: dir, stagingRoot: staging, files });\n"],
  // The pid reader that the identity pair replaced, plus the reclaim-result
  // constants and the link-unsupported code set the guarded reclaim needs.
  ["/** What a reclaim did with the entry it inspected: removed, already changed, or\n" +
   " *  a path now held by a process this attempt cannot prove anything about. */\n" +
   "const LOCK_REMOVED = 'removed';\n" +
   "const LOCK_CHANGED = 'changed';\n" +
   "const LOCK_HELD = 'held';\n" +
   "/** Error codes that mean \"this filesystem has no hard links\", where the\n" +
   " *  non-overwriting restore falls back to an exclusive copy. */\n" +
   "const LOCK_LINK_UNSUPPORTED = new Set(['EPERM', 'EACCES', 'EOPNOTSUPP', 'ENOTSUP', 'ENOSYS', 'EMLINK']);\n" +
   "function ownerAlive(pid) {\n",
   "function lockOwnerPid(lock) {\n" +
   "  let raw;\n" +
   "  try { raw = fs.readFileSync(lock, 'utf8').trim(); } catch { return undefined; }\n" +
   "  const pid = Number(raw);\n" +
   "  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;\n" +
   "}\n" +
   "function ownerAlive(pid) {\n"],
  // The lock identity, the owner read that pairs it with the bytes, the removal that
  // verifies the entry before it deletes it, the non-overwriting restore that puts a
  // replaced entry back, and the token release, all replacing `reclaimLock()`.
  // The lock-fencing round replaced `reclaimLock()` with identity-checked helpers; the
  // commit-token block below now sits between `releaseArchiveLock()` and
  // `acquireArchiveLock()`, so this piece is anchored on the `reclaimLock()` it replaces
  // instead of trailing the next function header.
  ["/** The identity of the lock entry: the device and inode pin the file object, so\n" +
   " *  a later comparison distinguishes \"the lock I inspected\" from \"a lock another\n" +
   " *  process wrote into the same path\". A link or a non-regular entry at the lock\n" +
   " *  path is never taken and never removed. */\n" +
   "function lockIdentity(lock) {\n" +
   "  const stat = fs.lstatSync(lock, { bigint: true });\n" +
   "  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('E_DOMAIN_ARCHIVE_LOCK');\n" +
   "  return { dev: String(stat.dev), ino: String(stat.ino) };\n" +
   "}\n" +
   "/**\n" +
   " * Read a lock's recorded owner together with the identity and bytes of the entry\n" +
   " * that carries it. The identity is taken before the content, so a replacement\n" +
   " * that lands in between is remembered by a pair that no single file satisfies\n" +
   " * and the reclaim below refuses to act on it. `null` means the lock is gone.\n" +
   " * `pid: null` means the content is not an owner pid (the writer was killed\n" +
   " * between create and write, or the file is not ours to read).\n" +
   " */\n" +
   "function readLockOwner(lock) {\n" +
   "  let identity;\n" +
   "  try { identity = lockIdentity(lock); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }\n" +
   "  let raw;\n" +
   "  try { raw = fs.readFileSync(lock, 'utf8'); }\n" +
   "  catch (error) {\n" +
   "    if (error?.code === 'ENOENT') return null;\n" +
   "    return { identity, raw: null, pid: null };\n" +
   "  }\n" +
   "  const pid = Number(raw.trim());\n" +
   "  return { identity, raw, pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null };\n" +
   "}\n" +
   "/**\n" +
   " * Remove the lock only while it is still the entry described by `identity` and\n" +
   " * still carries `raw` (an unreadable lock can only be pinned by its identity).\n" +
   " * The entry is renamed to a private name first, so the verification happens on\n" +
   " * a file this process owns: a mismatch means another process replaced the lock\n" +
   " * after it was inspected, and the entry is put back (without replacing whatever\n" +
   " * holds the path now) instead of deleted. Returns what happened to the entry: it\n" +
   " * is gone (`LOCK_REMOVED`), it was already replaced or released\n" +
   " * (`LOCK_CHANGED`), or the path was taken while it was isolated and the reclaim\n" +
   " * therefore failed (`LOCK_HELD`).\n" +
   " */\n" +
   "function removeLockIfUnchanged(lock, identity, raw) {\n" +
   "  // A cheap content check first: once the entry has changed, the lock stays where\n" +
   "  // the other process put it and the path is never made free.\n" +
   "  if (raw !== null) {\n" +
   "    let current;\n" +
   "    try { current = fs.readFileSync(lock, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return LOCK_CHANGED; throw error; }\n" +
   "    if (current !== raw) return LOCK_CHANGED;\n" +
   "  }\n" +
   "  const moved = `${lock}.${randomUUID()}.released`;\n" +
   "  try { fs.renameSync(lock, moved); } catch (error) { if (error?.code === 'ENOENT') return LOCK_CHANGED; throw error; }\n" +
   "  let unchanged = false;\n" +
   "  try {\n" +
   "    const stat = fs.lstatSync(moved, { bigint: true });\n" +
   "    unchanged = String(stat.dev) === identity.dev && String(stat.ino) === identity.ino\n" +
   "      && (raw === null || fs.readFileSync(moved, 'utf8') === raw);\n" +
   "  } catch { unchanged = false; }\n" +
   "  if (!unchanged) return restoreLockEntry(lock, moved);\n" +
   "  try { fs.unlinkSync(moved); } catch (error) { if (error?.code !== 'ENOENT') throw error; }\n" +
   "  return LOCK_REMOVED;\n" +
   "}\n" +
   "/**\n" +
   " * Put an isolated lock entry back without replacing whatever holds the path now.\n" +
   " *\n" +
   " * The isolation exists because check-and-remove cannot be atomic, and it makes\n" +
   " * the path free for as long as the verification lasts, so another process can\n" +
   " * acquire it before this runs. `rename` would silently replace that lock and\n" +
   " * destroy a live owner's claim, so the entry is linked into place instead:\n" +
   " * `link` fails with `EEXIST` when the path is taken, and the private copy is\n" +
   " * unlinked only once the path is provably this entry again. A filesystem without\n" +
   " * hard links falls back to an exclusive copy, which refuses the same way. When\n" +
   " * the path is taken the new owner's lock is left untouched and the isolated\n" +
   " * entry is kept under an `.orphan` name instead of being discarded, and the\n" +
   " * reclaim reports failure so the caller raises the lock error rather than\n" +
   " * retrying against a lock it cannot prove anything about.\n" +
   " */\n" +
   "function restoreLockEntry(lock, moved) {\n" +
   "  try {\n" +
   "    fs.linkSync(moved, lock);\n" +
   "  } catch (error) {\n" +
   "    if (error?.code === 'EEXIST') return orphanLockEntry(lock, moved);\n" +
   "    if (!LOCK_LINK_UNSUPPORTED.has(error?.code)) throw error;\n" +
   "    try { fs.copyFileSync(moved, lock, fs.constants.COPYFILE_EXCL); }\n" +
   "    catch (copyError) { if (copyError?.code === 'EEXIST') return orphanLockEntry(lock, moved); throw copyError; }\n" +
   "  }\n" +
   "  try { fs.unlinkSync(moved); } catch (error) { if (error?.code !== 'ENOENT') throw error; }\n" +
   "  return LOCK_CHANGED;\n" +
   "}\n" +
   "/** Keep an isolated lock entry that lost the path as an auditable orphan: the\n" +
   " *  entry is the only record of the owner whose lock this attempt removed. */\n" +
   "function orphanLockEntry(lock, moved) {\n" +
   "  const orphan = `${lock}.${randomUUID()}.orphan`;\n" +
   "  try { fs.renameSync(moved, orphan); } catch { /* it stays under its private name */ }\n" +
   "  return LOCK_HELD;\n" +
   "}\n" +
   "/** Reclaim one inspected lock entry; a path another process took meanwhile is a\n" +
   " *  failed reclaim, not a successful one, and is reported as the lock error. */\n" +
   "function reclaimArchiveLock(lock, owner) {\n" +
   "  if (removeLockIfUnchanged(lock, owner.identity, owner.raw) === LOCK_HELD) throw new Error('E_DOMAIN_ARCHIVE_LOCK');\n" +
   "}\n" +
   "/** Release exactly the lock this attempt created: both its identity and its\n" +
   " *  content are checked, so a lock another process acquired in the meantime\n" +
   " *  survives this call. */\n" +
   "function releaseArchiveLock(lock, token) {\n" +
   "  if (!token) return false;\n" +
   "  return removeLockIfUnchanged(lock, token.identity, token.raw) === LOCK_REMOVED;\n" +
   "}\n",
   "function reclaimLock(lock) {\n" +
   "  try { fs.unlinkSync(lock); } catch (error) { if (error?.code !== 'ENOENT') throw error; }\n" +
   "}\n"],
  // The commit-token round added one contiguous block between the lock helpers and
  // `acquireArchiveLock()`: the deterministic serialization of a validated aggregate, its
  // digest, the ledger comparison, the refusal message, and the durable commit token the
  // publication advances (read, atomic replace, and the compare-then-advance step). It
  // inserts no line into any existing function - `acquireArchiveLock()` below is the anchor
  // in both directions - so reversing it restores the pinned source exactly.
  ["/**\n" +
   " * Deterministic serialization of a schema-validated aggregate.\n" +
   " *\n" +
   " * `JSON.stringify` keeps the key order of whatever wrote the document last, so\n" +
   " * two documents with the same content but a different key order would hash\n" +
   " * differently. This walk sorts every object's keys, so the digest below depends\n" +
   " * on content alone. Values are already JSON projections (`aggregateSchema`\n" +
   " * normalizes through `JSON.parse(JSON.stringify(...))`), so no `undefined`,\n" +
   " * `NaN` or cyclic value can reach it.\n" +
   " */\n" +
   "function stableJson(value) {\n" +
   "  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;\n" +
   "  if (value && typeof value === 'object') {\n" +
   "    const keys = Object.keys(value).sort();\n" +
   "    return `{${keys.map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;\n" +
   "  }\n" +
   "  return JSON.stringify(value) ?? 'null';\n" +
   "}\n" +
   "/** Content digest of one aggregate: the transaction keeps this instead of a\n" +
   " *  second copy of the aggregate it started from. */\n" +
   "const aggregateDigest = aggregate => createHash('sha256').update(stableJson(aggregate)).digest('hex');\n" +
   "/** Key-by-key equality of two validated event ledgers (string MACs). */\n" +
   "const sameEventLedger = (left, right) => {\n" +
   "  const keys = Object.keys(left);\n" +
   "  return keys.length === Object.keys(right).length && keys.every(key => left[key] === right[key]);\n" +
   "};\n" +
   "/** The refusal a publication raises when the document it was computed from is\n" +
   " *  no longer the committed one. Same code as the lock refusal - the caller's\n" +
   " *  remedy is the same (do not retry against state it did not read) - with a\n" +
   " *  message that names the actual cause. */\n" +
   "const E_COMMIT_OVERWRITTEN = 'E_DOMAIN_ARCHIVE_LOCK: the shared domain document has been changed by another commit since this transaction started, so its pending record was not published';\n" +
   "/**\n" +
   " * The durable commit token: one small file beside the archive lock that every\n" +
   " * write of the shared domain document advances.\n" +
   " *\n" +
   " * It is not a second coordination mechanism; it is the only durable evidence a\n" +
   " * commit leaves behind. The official domain layer keeps the document this port\n" +
   " * read in memory and updates it from this port's own writes only (`global.get()`\n" +
   " * returns the live value, it never re-reads the medium), so a comparison of the\n" +
   " * in-memory document against the transaction's baseline cannot see a commit\n" +
   " * another port published - and the medium (a whole-document replace) offers no\n" +
   " * compare-and-swap. Comparing this token is therefore what separates \"the\n" +
   " * document this transaction was computed from\" from \"the document another port\n" +
   " * published meanwhile\".\n" +
   " *\n" +
   " * The token carries no data and is never interpreted: an absent or empty file\n" +
   " * reads as `null`, and a crash - or a write that fails - may leave it advanced\n" +
   " * without a commit, which costs the next transaction one spurious refusal (it\n" +
   " * reads whatever it finds as its baseline). It is deliberately not fsynced - a\n" +
   " * crash ends every transaction, so only visibility between live ports matters -\n" +
   " * but it is replaced atomically, so no reader sees a torn or empty token.\n" +
   " */\n" +
   "const COMMIT_TOKEN_NAME = 'domain-commit.token';\n" +
   "/** Entropy for the token value and its private temporary name. Deliberately\n" +
   " *  not `crypto.randomUUID()`: the differential harness stubs that function with\n" +
   " *  a deterministic sequence so record ids persist reproducibly, and a token\n" +
   " *  drawn from it would consume ids from the same sequence and shift every later\n" +
   " *  id. The token stays opaque and is only ever compared for equality, so any\n" +
   " *  independent 128-bit random value is enough - but it must differ per commit,\n" +
   " *  because equal tokens are how a port detects that nobody else committed. */\n" +
   "const commitTokenEntropy = () => randomBytes(16).toString('hex');\n" +
   "function readCommitToken(file) {\n" +
   "  try { return fs.readFileSync(file, 'utf8').trim() || null; }\n" +
   "  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }\n" +
   "}\n" +
   "function writeCommitToken(file) {\n" +
   "  const temporary = `${file}.${commitTokenEntropy()}.tmp`;\n" +
   "  fs.writeFileSync(temporary, `${commitTokenEntropy()}\\n`, { mode: 0o600 });\n" +
   "  try { fs.renameSync(temporary, file); }\n" +
   "  catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }\n" +
   "}\n" +
   "/** Advance the token only while it still carries `expected`; `false` means\n" +
   " *  another commit advanced it first and this transaction must not publish. The\n" +
   " *  read and the replace are adjacent synchronous steps, so no other port of this\n" +
   " *  process can interleave between them. */\n" +
   "function advanceCommitToken(file, expected) {\n" +
   "  if (readCommitToken(file) !== expected) return false;\n" +
   "  writeCommitToken(file);\n" +
   "  return true;\n" +
   "}\n" +
   "async function acquireArchiveLock(lock) {\n",
   "async function acquireArchiveLock(lock) {\n"],
  // `acquireArchiveLock()` returns the token it wrote (content and identity) and
  // reclaims only the entry its decision was made about.
  ["  const raw = String(process.pid);\n" +
   "  for (;;) {\n" +
   "    try {\n" +
   "      fs.writeFileSync(lock, raw, { flag: 'wx', mode: 0o600 });\n" +
   "      return { raw, identity: lockIdentity(lock) };\n" +
   "    } catch (error) {\n" +
   "      if (error?.code !== 'EEXIST') throw error;\n" +
   "      const owner = readLockOwner(lock);\n" +
   "      if (!owner) continue;\n" +
   "      if (owner.pid === null) {\n" +
   "        let ageMs = 0;\n" +
   "        try { ageMs = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }\n" +
   "        // Reclaim only the entry this decision was made about; a lock that was\n" +
   "        // replaced in the meantime stays where another process put it.\n" +
   "        if (ageMs >= LOCK_SETTLE_MS) { reclaimArchiveLock(lock, owner); continue; }\n" +
   "        if (Date.now() >= deadline) throw new Error('E_DOMAIN_ARCHIVE_LOCK');\n" +
   "        await new Promise(resolve => setTimeout(resolve, 100));\n" +
   "        continue;\n" +
   "      }\n" +
   "      if (owner.pid === process.pid || ownerAlive(owner.pid)) throw new Error('E_DOMAIN_ARCHIVE_LOCK');\n" +
   "      reclaimArchiveLock(lock, owner);\n",
   "  for (;;) {\n" +
   "    try {\n" +
   "      fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });\n" +
   "      return;\n" +
   "    } catch (error) {\n" +
   "      if (error?.code !== 'EEXIST') throw error;\n" +
   "      const pid = lockOwnerPid(lock);\n" +
   "      if (pid === null || pid === undefined) {\n" +
   "        let ageMs = 0;\n" +
   "        try { ageMs = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }\n" +
   "        if (ageMs >= LOCK_SETTLE_MS) { reclaimLock(lock); continue; }\n" +
   "        if (Date.now() >= deadline) throw new Error('E_DOMAIN_ARCHIVE_LOCK');\n" +
   "        await new Promise(resolve => setTimeout(resolve, 100));\n" +
   "        continue;\n" +
   "      }\n" +
   "      if (pid === process.pid || ownerAlive(pid)) throw new Error('E_DOMAIN_ARCHIVE_LOCK');\n" +
   "      reclaimLock(lock);\n"],
  // The port resolves the durable commit token beside the archive lock. The declaration is
  // an insertion between two lines that stay in place, so reversing it drops only the one
  // line and leaves both neighbours as the pin wrote them.
  ["  const lock = path.join(config.presetDir, 'domain-archive.lock');\n" +
   "  const commitToken = path.join(config.presetDir, COMMIT_TOKEN_NAME);\n",
   "  const lock = path.join(config.presetDir, 'domain-archive.lock');\n"],
  // Opening the storage medium and creating the two roots moved into the guarded
  // sequence: a failure before it used to leave the domain open and the lock held.
  // The lower half of that move is registered further down, at the `try` it belongs to.
  ["  const lockToken = await acquireArchiveLock(lock);\n" +
   "  let domain;\n" +
   "  const root = path.join(config.presetDir, 'dockyard');\n" +
   "  const staging = path.join(config.presetDir, 'domain-staging');\n" +
   "  const scope = new AsyncLocalStorage();\n",
   "  await acquireArchiveLock(lock);\n" +
   "  let domain;\n" +
   "  try { domain = await ctx.storageDomain.open(evolutionDomainSpec); }\n" +
   "  catch (error) { fs.unlinkSync(lock); throw error; }\n" +
   "  const root = path.join(config.presetDir, 'dockyard');\n" +
   "  const staging = path.join(config.presetDir, 'domain-staging');\n" +
   "  fs.mkdirSync(root, { recursive: true, mode: 0o700 });\n" +
   "  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });\n" +
   "  const scope = new AsyncLocalStorage();\n"],
  // `createMemory()` takes the deferred-write flag.
  ["  async function createMemory(dir, initial, archiveWriteGuard = null, deferLoadArchiveWrites = false) {\n",
   "  async function createMemory(dir, initial, archiveWriteGuard = null) {\n"],
  // Hands it to the memory instance it builds.
  ["    const instance = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority, archiveWriteGuard, deferLoadArchiveWrites });\n",
   "    const instance = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority, archiveWriteGuard });\n"],
  // `hydrate()` loads the live tree without writing to it: a load-time eviction would
  // append to a live archive file outside any staged transaction.
  ["    // The live tree is loaded without writing to it: a load-time eviction would\n" +
   "    // append to a live archive file outside any staged transaction, and a crash\n" +
   "    // there leaves a fragment no later append can repair. Over-limit records stay\n" +
   "    // in this instance's hot projection and the next mutation archives them\n" +
   "    // inside its own transaction, which is where archive writes belong.\n" +
   "    const current = await createMemory(root, domain.global.get().aggregate, null, true);\n",
   "    const current = await createMemory(root, domain.global.get().aggregate);\n"],
  // `mutate()` reads the ledger after `installPending()` has recovered one, and merges a
  // caller's markers onto it instead of writing the pre-recovery snapshot back out.
  // `mutate()` reads the ledger after `installPending()` has recovered one, merges a
  // caller's markers onto it instead of writing the pre-recovery snapshot back out, and
  // captures the committed state the transaction was computed from: the ledger, the
  // aggregate object and the durable commit token. The whole head is one block in front of
  // the `stage` line, so reversing it drops the snapshot and restores the pinned signature
  // and default in the same step.
  ["  async function mutate(work, applied) {\n" +
   "    await installPending();\n" +
   "    // The ledger has to be read after the recovery above: `installPending()`\n" +
   "    // installs a committed pending record's ledger, and a snapshot taken before\n" +
   "    // it would write the recovered markers straight back out of the record, so\n" +
   "    // the next replay would apply events whose marker it had just lost. A\n" +
   "    // caller that passes its own ledger (`replay()` adds the event it just\n" +
   "    // verified) is merged onto the recovered one: recovery only ever installs\n" +
   "    // committed markers, and the caller's set is the newer of the two.\n" +
   "    const committed = domain.global.get();\n" +
   "    const recovered = committed.applied;\n" +
   "    // The publication below replaces the whole shared document, so the\n" +
   "    // transaction remembers the committed state it was computed from: the ledger\n" +
   "    // it merges onto, the aggregate it started from, and the durable commit\n" +
   "    // token. The publication refuses to publish when any of the three changed by\n" +
   "    // then. The aggregate is compared by value through the deterministic digest\n" +
   "    // below, but an unchanged reference settles it without hashing: while nothing\n" +
   "    // replaced this port's document, the value is the very object captured here,\n" +
   "    // so an ordinary commit does not walk its aggregate a second time.\n" +
   "    const baseline = { applied: { ...recovered }, aggregate: committed.aggregate, token: readCommitToken(commitToken) };\n" +
   "    const ledger = mergeEventLedger(recovered, applied);\n",
   "  async function mutate(work, applied = domain.global.get().applied) {\n" +
   "    await installPending();\n"],

  // The pending record carries that recovered ledger.
  // The publication refuses to publish when the document it was computed from is no longer
  // the committed one: the fence proves which entry the lock path holds, the document this
  // port knows and the durable commit token say whether another commit landed meanwhile,
  // and the residual window (check and replace are still two steps) is stated in the block
  // itself. The final `set` reads the compared `latest` document instead of calling
  // `domain.global.get()` twice; reversing the block restores that single line exactly.
  ["    // The fence proves which entry the lock path holds; it cannot prove that the\n" +
   "    // document this transaction read is still the committed one, because the\n" +
   "    // check and the write are not one step. Two compares therefore guard the\n" +
   "    // publication: the document this port knows (a same-process writer sharing\n" +
   "    // this handle shows up here), and the durable commit token that every write\n" +
   "    // of that document advances (the only cross-port evidence available - see\n" +
   "    // COMMIT_TOKEN_NAME). Either one failing publishes nothing; the stage stays\n" +
   "    // on disk as the record of the refused transaction.\n" +
   "    //\n" +
   "    // Residual boundary, stated exactly: the compare and the write are still two\n" +
   "    // steps. A commit that lands after the token was advanced and before the\n" +
   "    // medium's atomic replace completes is still overwritten by this write, and\n" +
   "    // this port cannot detect it. That window is one in-flight backend write\n" +
   "    // instead of the whole transaction (stage mirror, work and fsyncs), and\n" +
   "    // closing it entirely needs a compare-and-swap from the medium itself: the\n" +
   "    // official domain handle offers `get`/`set` over the document this process\n" +
   "    // loaded, and the JSON backend replaces the whole unit in one write, so no\n" +
   "    // such primitive exists here. Re-reading the medium by reopening the domain\n" +
   "    // would drop this port's domain handle, which the port's own lifecycle pins.\n" +
   "    const latest = domain.global.get();\n" +
   "    const unchanged = latest.pending === null\n" +
   "      && sameEventLedger(latest.applied, baseline.applied)\n" +
   "      && (latest.aggregate === baseline.aggregate\n" +
   "        || aggregateDigest(latest.aggregate) === aggregateDigest(baseline.aggregate));\n" +
   "    if (!unchanged || !advanceCommitToken(commitToken, baseline.token)) throw new Error(E_COMMIT_OVERWRITTEN);\n" +
   "    await domain.global.set(schema.parse({ schema: 1, aggregate: latest.aggregate, applied: latest.applied, pending: { stage, aggregate, applied: ledger, files } }));\n",
   "    await domain.global.set(schema.parse({ schema: 1, aggregate: domain.global.get().aggregate, applied: domain.global.get().applied, pending: { stage, aggregate, applied, files } }));\n"],

  // The guarded sequence itself: the medium is open before the roots are created, and a
  // failure here is now inside the `catch` below.
  // `try {` alone is not unique (`acquireArchiveLock()` and `restoreLockEntry()`
  // open one too), so the piece carries the `scope.run` line that follows the moved
  // block on both sides: that line is the same in the pinned file and in the
  // working tree, and it pins which `try` this piece is about.
  ["  try {\n" +
   "    domain = await ctx.storageDomain.open(evolutionDomainSpec);\n" +
   "    // Creating the two roots belongs to the guarded sequence: the storage\n" +
   "    // medium is already open here, so a failure at this point used to leave the\n" +
   "    // domain open and the lock held, and a retry in the same process met its own\n" +
   "    // pid and refused itself.\n" +
   "    fs.mkdirSync(root, { recursive: true, mode: 0o700 });\n" +
   "    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });\n" +
   "    await scope.run(token, async () => {\n",
   "  try {\n" +
   "    await scope.run(token, async () => {\n"],
  // A seeded document replaces the shared one, so the seed advances the commit token for the
  // same reason a commit does; the write is inserted immediately before the `set` it guards.
  ["        // A seeded document replaces the shared one, so it advances the token\n" +
   "        // for the same reason a commit does.\n" +
   "        writeCommitToken(commitToken);\n" +
   "        await domain.global.set(schema.parse({ schema: 1, aggregate: { evolution: { ...seed.evolution, eventBridge: { schema: 1, applied: [] } } }, applied: {}, pending: null }));\n",
   "        await domain.global.set(schema.parse({ schema: 1, aggregate: { evolution: { ...seed.evolution, eventBridge: { schema: 1, applied: [] } } }, applied: {}, pending: null }));\n"],
  // A failed attempt closes what it opened and releases only the lock it wrote; a
  // successful close releases the same token.
  ["  } catch (error) {\n" +
   "    // Close what this attempt opened and release only the lock it wrote, so the\n" +
   "    // failed attempt leaves nothing behind that a retry would trip over.\n" +
   "    await domain?.close();\n" +
   "    releaseArchiveLock(lock, lockToken);\n" +
   "    throw error;\n" +
   "  }\n" +
   "  const close = () => {\n" +
   "    closing = true;\n" +
   "    return disposal ??= (async () => { await chain; await domain.close(); releaseArchiveLock(lock, lockToken); if (failure) throw failure; })();\n",
   "  } catch (error) { await domain.close(); fs.unlinkSync(lock); throw error; }\n" +
   "  const close = () => {\n" +
   "    closing = true;\n" +
   "    return disposal ??= (async () => { await chain; await domain.close(); fs.unlinkSync(lock); if (failure) throw failure; })();\n"],
  ["import { EvolutionMemory, EvolutionObservationStore, EvolutionEvaluator } from './dockyard-domain/index.js';\n" +
   "import { collectKnowledgeExperience } from './experience-recall.js';\n",
   "import { EvolutionMemory, EvolutionObservationStore, EvolutionEvaluator } from './dockyard-domain/index.js';\n"],
  ["    // Evaluator is deliberately advisory, never production authority.\n" +
   "    evaluate: evidence => evaluator.evaluate(evidence),\n" +
   "    // On-demand, bounded read of the canonical knowledge rows this store already\n" +
   "    // owns. It is model-free and only called by an explicit owner-triggered\n" +
   "    // action; a failure here is reported to the caller, never cached as\n" +
   "    // \"no history\".\n" +
   "    recall: (input = {}, options = {}) => {\n" +
   "      if (closing) throw new Error('E_DOMAIN_CLOSED');\n" +
   "      // The collector below projects every field it keeps into its own bounded\n" +
   "      // record and never returns or writes an input row, so the read-only view\n" +
   "      // is enough: copying the rows outside its `maxConsidered` window is the\n" +
   "      // whole cost of the detached history read at this size.\n" +
   "      return collectKnowledgeExperience(memory.historyView('knowledge'), input, options);\n" +
   "    },\n" +
   "    close,\n",
   "    // Evaluator is deliberately advisory, never production authority.\n" +
   "    evaluate: evidence => evaluator.evaluate(evidence), close,\n"],
  ["    // The store is not read afterwards, and neither is the projection its\n" +
   "    // `load()` would return, so the load is asked for without it. What\n" +
   "    // `hydrate()` does need from the load is its cold-history read:\n" +
   "    // `memory.hasColdHistory` derives `Number(count)` from every\n" +
   "    // `coldArchives` entry and therefore rejects a durable aggregate whose\n" +
   "    // entry cannot be coerced. Removing this call silently accepted the first\n" +
   "    // commit after such a state was written; keeping it preserves the loud\n" +
   "    // failure the released implementation has, with or without the projection.\n" +
   "    observations = new EvolutionObservationStore({ memory });\n" +
   "    await observations.load({ snapshot: false });\n",
   "    observations = new EvolutionObservationStore({ memory });\n" +
   "    await observations.load();\n"],
  ["    const instance = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority, archiveWriteGuard });\n" +
   "    // The load's own work is required (state restore, archive index\n" +
   "    // reconciliation, eviction and archival); the hot projection it would\n" +
   "    // return is not: no caller of this factory reads it.\n" +
   "    await instance.load({ snapshot: false });\n",
   "    const instance = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority, archiveWriteGuard });\n" +
   "    await instance.load();\n"],
  // Closing a committed record replaces the shared document, so `installPending()`
  // advances the commit token immediately before the `set` it guards: a token that did not
  // move would tell a concurrent transaction that the document it read is still committed.
  // The line is an insertion between the existing comment and the `set`, both unchanged.
  ["    // `current` is the output of `schema.parse` above, so `pending.aggregate`\n" +
   "    // and `pending.applied` are already validated projections of this exact\n" +
   "    // durable document; re-parsing them with the same schema can only\n" +
   "    // reproduce them. The two remaining fields are the literals below, which\n" +
   "    // are fixed valid values, so the closing document is provably accepted by\n" +
   "    // `schema` one step earlier and needs no second walk. The full validation\n" +
   "    // still happens before any staged file is installed, which is the boundary\n" +
   "    // that must not move.\n" +
   "    // Installing a committed record replaces the shared document, so it\n" +
   "    // advances the commit token first: a token that did not move would tell a\n" +
   "    // concurrent transaction that the document it read is still committed.\n" +
   "    writeCommitToken(commitToken);\n" +
   "    await domain.global.set({ schema: 1, aggregate: current.pending.aggregate, applied: current.pending.applied, pending: null });\n",
   "    await domain.global.set(schema.parse({ schema: 1, aggregate: current.pending.aggregate, applied: current.pending.applied, pending: null }));\n"],

  // The transaction-store check is a named function so a regression can call it;
  // the pinned artifact had no such check at this position.
  ["const safeIdentifier = value => typeof value === 'string' && /^[a-zA-Z0-9_:./-]{1,160}$/.test(value) ? value : null;\n" +
      "/**\n" +
      " * The check a transaction's working store still performs on every save.\n" +
      " *\n" +
      " * It used to be the preprocess of `aggregateSchema.parse(payload)`, which built\n" +
      " * the whole projection and then dropped it (see `createMemory`). This runs the\n" +
      " * same three steps in the same order and discards what they produce, so a save\n" +
      " * throws exactly where it threw: `JSON.stringify`; the `JSON.parse` of its output,\n" +
      " * which throws only when the stringify returned `undefined`; and the recursive\n" +
      " * own-`__proto__` strip, which runs only when the serialized text carries that\n" +
      " * literal, and would overflow on a document nested deeply enough. The parse is the\n" +
      " * step skipped on the common path, and it is the one that builds the deep copy no\n" +
      " * reader wants; the substring search costs what that preprocess already paid for\n" +
      " * the same decision.\n" +
      " *\n" +
      " * What is no longer reproduced is the schema's *verdict* on the projection, which\n" +
      " * is fixed for the payload this updater produces (see `createMemory`). The check is\n" +
      " * kept as a named function because the throw is a boundary - a save whose payload\n" +
      " * JSON cannot represent aborts the transaction before anything is published - and\n" +
      " * because `transaction-save-validation.test.js` pins it differentially against\n" +
      " * `aggregateSchema`.\n" +
      " */\n" +
      "export function assertTransactionSave(payload) {\n" +
      "  const text = JSON.stringify(payload);\n" +
      "  // `JSON.parse(undefined)` is the error the previous call reached through the\n" +
      "  // same expression; every other unrepresentable value already threw above.\n" +
      "  if (text === undefined) JSON.parse(text);\n" +
      "  else if (text.includes(`\"${PROTO_KEY}\"`)) stripOwnProtoKeys(JSON.parse(text));\n" +
      "}\n" +
      "export function projectObservation(input = {}) {",
   "const safeIdentifier = value => typeof value === 'string' && /^[a-zA-Z0-9_:./-]{1,160}$/.test(value) ? value : null;\n" +
   "export function projectObservation(input = {}) {"],
  // The transaction's working store no longer keeps the projection it built for
  // every save. Its value was never read (the commit publishes
  // `instance.snapshot()`, and the store's `load()` is only reached by
  // `reconcile()`/`verifyConsistency()`, which no port path calls), and the
  // call's exception behaviour is `JSON.stringify`'s, kept verbatim as
  // `assertTransactionSave()`. The released shape is the projection this
  // store held.
  ["    // `inlineSerialization` is honest here: `update` captures the bytes of the\n" +
      "    // payload it is handed with the synchronous `JSON.stringify` below, before\n" +
      "    // it returns, so the caller's live shallow view cannot change what is\n" +
      "    // checked. It keeps no snapshot of those bytes, and no reader of this store\n" +
      "    // wants one (see below).\n" +
      "    //\n" +
      "    // What that check does not do any more is keep the projection it used to\n" +
      "    // build and store. Two things were true of `aggregateSchema.parse(payload)`\n" +
      "    // at this call site, and only the second one is observable:\n" +
      "    //\n" +
      "    // - The value it returned was never read. The only commit path is\n" +
      "    //   `mutate()`, which publishes the snapshot it takes after `work()`\n" +
      "    //   returns; the next updater keeps only `evolution`, which it replaces\n" +
      "    //   wholesale; and the store's own `load()` has exactly two callers -\n" +
      "    //   `reconcile()` and `verifyConsistency()` - neither of which any port path\n" +
      "    //   reaches (`createMemory` itself loads the instance before a record\n" +
      "    //   exists). So the projection was built and dropped once per save, and a\n" +
      "    //   transaction saves once per appended record plus once for the bridge\n" +
      "    //   marker (`measurement-completed` 2, a rejected/failure pair 3,\n" +
      "    //   `canary-passed` 5-6): a burst projected the whole document once per save\n" +
      "    //   - 2 to 6 times per record, growing with the records the burst has\n" +
      "    //   already appended - and kept none of those projections.\n" +
      "    //\n" +
      "    // - Its exception behaviour is reproduced step for step. The preprocess\n" +
      "    //   (`toJsonProjection`) has three steps that can throw - the stringify, the\n" +
      "    //   parse of its output, and the recursive own-`__proto__` strip - and\n" +
      "    //   `assertTransactionSave` runs the same three in the same order, so a save\n" +
      "    //   still throws exactly where it threw (including the `SyntaxError` of\n" +
      "    //   parsing an `undefined` stringify and the `RangeError` of a strip that\n" +
      "    //   overflows). Only the parse on the common path is skipped, and that is the\n" +
      "    //   step that builds the deep copy nothing reads.\n" +
      "    //\n" +
      "    //   What is not reproduced is the schema's verdict on that projection, and it\n" +
      "    //   is fixed for this payload: its only own top-level key is `evolution`\n" +
      "    //   (every state this store holds is either the initial committed aggregate or\n" +
      "    //   a payload of the same shape, and the durable schema admits nothing else),\n" +
      "    //   and the only field the schema inspects inside it is an integer\n" +
      "    //   `schema >= 4`, which the durable document this port loads guarantees\n" +
      "    //   (`memory.js`'s `schema: Math.max(4, Number(...) || ...)` keeps it at every\n" +
      "    //   load and reconcile; the looser values a direct `restore()` could inject\n" +
      "    //   are outside this store's reach, because no port path calls it). Both\n" +
      "    //   events the port feeds this store are JSON-projected before they reach it\n" +
      "    //   (`projectExecutionEvent`, `safeRecord`, `projectObservation`), so a payload\n" +
      "    //   the verdict could reject is not reachable from here either.\n" +
      "    //\n" +
      "    // Keeping the stringify therefore keeps the only observable effect of the\n" +
      "    // removed call - the throw - on the exact same value, and the durable\n" +
      "    // document is still validated in full by the publication's `schema.parse`.\n" +
      "    const stateStore = { filePath: path.join(dir, 'state.json'), inlineSerialization: true, load: async () => structuredClone(aggregate),\n" +
      "      update: async updater => {\n" +
      "        const next = updater(aggregate);\n" +
      "        assertTransactionSave(next);\n" +
      "        aggregate = next;\n" +
      "      } };\n",
   "    const stateStore = { filePath: path.join(dir, 'state.json'), load: async () => structuredClone(aggregate),\n" +
   "      update: async updater => { aggregate = aggregateSchema.parse(updater(structuredClone(aggregate))); } };\n"],
  // The exactly-once fix landed inside the grouped path, after the group itself: a
  // recovered commit installs a group's markers before the next transaction reads
  // the document, and the memory's bridge marker window keeps only the last 4096
  // records, so a longer group must consult the recovered ledger instead of its own
  // markers before it applies anything. Reversing these two insertions first
  // restores the grouped shape the piece below reverses to the released per-record
  // path; the released source has neither.
  ["      const outcome = await mutate(async (instance, store, { recovered }) => {\n" +
   "        let duplicated = 0;\n" +
   "        for (const entry of entries) {\n" +
   "          // A recovered commit installed this record's aggregate effects and its\n" +
   "          // marker before this transaction read the document, so it is already\n" +
   "          // durable and must not be applied again. The memory cannot decide this\n" +
   "          // on its own: it keeps only the last 4096 bridge markers\n" +
   "          // (`#markBridgeApplied`), so re-applying a longer group would re-apply\n" +
   "          // its head - and that append scrolls the window, cascading through the\n" +
   "          // rest of the group. The committed ledger is the authority.\n" +
   "          if (recovered[entry.eventId] === entry.mac) { duplicated += 1; continue; }\n" +
   "          const result = await instance.applyExecutionEvent(entry.event);\n" +
   "          if (result.duplicate) duplicated += 1;\n" +
   "        }\n" +
   "        return { duplicates: duplicated };\n" +
   "      }, ledger);\n",
   "      const outcome = await mutate(async instance => {\n" +
   "        let duplicated = 0;\n" +
   "        for (const entry of entries) {\n" +
   "          const result = await instance.applyExecutionEvent(entry.event);\n" +
   "          if (result.duplicate) duplicated += 1;\n" +
   "        }\n" +
   "        return { duplicates: duplicated };\n" +
   "      }, ledger);\n",],
  ["    // `recovered` is the committed marker map *after* the recovery above, so\n" +
   "    // `work` can tell a record that this transaction still has to apply from one\n" +
   "    // a recovered commit already installed. It is not a cache: the memory's own\n" +
   "    // bridge marker window keeps only the last 4096 records, which is not enough\n" +
   "    // to recognise a long group that this port already applied.\n" +
   "    const result = await work(current.instance, store, { recovered });\n",
   "    const result = await work(current.instance, store);\n",],
  // The replay path now commits every record a pass authenticated in one
  // transaction instead of one per record. Each record still pays its own
  // parse, MAC verification, writer check, marker/conflict check and is applied
  // in file order; only the stage mirror, the two whole-document writes, their
  // fsyncs and the reload are shared. Reversing the block restores the pinned
  // per-record loop; the writer predicate inside it is reversed by the piece
  // below, so this one must stay above it.
  ["    let applied = 0, duplicates = plan.trusted ? plan.prefixRecords : 0;\n" +
   "    let first = null, last = null;\n" +
   "    // Records this pass authenticated but has not committed yet. A step that\n" +
   "    // arrives after a burst of events (one operation emits two or three\n" +
   "    // records, the autonomous observer emits them between steps, or the process\n" +
   "    // was down while another one appended) used to pay one complete durable\n" +
   "    // transaction per record: a stage mirror, an aggregate snapshot, two\n" +
   "    // whole-document writes, their fsyncs and a full reload. The records are\n" +
   "    // independent and already ordered, and each one still pays its own parse,\n" +
   "    // MAC verification, writer check, marker/conflict check and application in\n" +
   "    // file order, so the group is committed by one transaction that replaces\n" +
   "    // the per-record ones. Nothing is skipped, reordered or applied twice; only\n" +
   "    // the transport work between them is shared.\n" +
   "    const batch = [];\n" +
   "    // The marker map is the dedup authority for the pass, so a record this batch\n" +
   "    // owns must stay visible to the marker check of the record after it until\n" +
   "    // the commit publishes it.\n" +
   "    const batchMarks = new Map();\n" +
   "    const absorb = (line, { witnessed }) => {\n" +
   "      const envelope = JSON.parse(line);\n" +
   "      const verified = verifyEventBridgeEnvelope(envelope, config.eventBridgeKey);\n" +
   "      if (!eventBridgeWriterTrusted(verified, writer)) throw new Error('E_DOMAIN_EVENT_AUTH');\n" +
   "      const eventId = safeIdentifier(verified.event.eventId);\n" +
   "      if (witnessed) {\n" +
   "        const witness = { id: String(eventId), mac: envelope.mac };\n" +
   "        first ??= witness;\n" +
   "        last = witness;\n" +
   "      }\n" +
   "      // Authenticate every record the checkpoint does not cover, including\n" +
   "      // duplicates, before consulting the marker. Already committed events need\n" +
   "      // neither a second parse nor a full DTO.\n" +
   "      const marker = domain.global.get().applied[eventId] || batchMarks.get(eventId);\n" +
   "      if (marker) {\n" +
   "        if (marker !== envelope.mac) throw new Error('E_DOMAIN_EVENT_ID_CONFLICT');\n" +
   "        duplicates++; return;\n" +
   "      }\n" +
   "      batchMarks.set(eventId, envelope.mac);\n" +
   "      batch.push({ eventId, mac: envelope.mac, event: projectExecutionEvent(verified.event) });\n" +
   "    };\n" +
   "    /** Commit what this pass authenticated as one transaction. */\n" +
   "    const commit = async () => {\n" +
   "      if (!batch.length) return;\n" +
   "      const entries = batch.splice(0, batch.length);\n" +
   "      batchMarks.clear();\n" +
   "      // The whole committed map is handed to `mutate()` rather than only the\n" +
   "      // records this group adds: the transaction merges the caller's set onto the\n" +
   "      // markers an interrupted commit recovered from disk, and it must keep\n" +
   "      // refusing an eventId the two sides disagree about\n" +
   "      // (`E_DOMAIN_EVENT_ID_CONFLICT`) - a marker only this group knows is not\n" +
   "      // enough to detect that.\n" +
   "      const ledger = { ...domain.global.get().applied };\n" +
   "      for (const entry of entries) ledger[entry.eventId] = entry.mac;\n" +
   "      const outcome = await mutate(async instance => {\n" +
   "        let duplicated = 0;\n" +
   "        for (const entry of entries) {\n" +
   "          const result = await instance.applyExecutionEvent(entry.event);\n" +
   "          if (result.duplicate) duplicated += 1;\n" +
   "        }\n" +
   "        return { duplicates: duplicated };\n" +
   "      }, ledger);\n" +
   "      duplicates += outcome.duplicates;\n" +
   "      applied += entries.length - outcome.duplicates;\n" +
   "    };\n" +
   "    let refusal = null;\n" +
   "    for (const line of plan.lines) {\n" +
   "      if (!line.trim()) continue;\n" +
   "      try { absorb(line, { witnessed: true }); } catch (error) { refusal = error; break; }\n" +
   "    }\n" +
   "    // A torn trailing line is processed exactly as before but stays outside\n" +
   "    // the checkpoint, so a later append re-processes it instead of silently\n" +
   "    // skipping bytes that were never a complete record.\n" +
   "    if (!refusal && plan.remainder.trim()) {\n" +
   "      try { absorb(plan.remainder, { witnessed: false }); } catch (error) { refusal = error; }\n" +
   "    }\n" +
   "    // The per-record path committed every record it had authenticated before the\n" +
   "    // one that was refused, so a refusal must not roll back what this pass has\n" +
   "    // already verified: that progress is committed first and the refusal is then\n" +
   "    // reported exactly as before, without advancing the checkpoint below. A\n" +
   "    // failure inside the group's own transaction aborts the whole group instead:\n" +
   "    // nothing of it is published, and the next pass re-applies it in file order\n" +
   "    // with the same marker map, so no record can be skipped or applied twice. If\n" +
   "    // that commit fails while a refusal is also pending, the commit failure is\n" +
   "    // what the pass reports - the per-record path reached the same commit before\n" +
   "    // it read the refused record.\n" +
   "    await commit();\n" +
   "    if (refusal) throw refusal;\n" +
   "",
"    let applied = 0, duplicates = plan.trusted ? plan.prefixRecords : 0;\n" +
   "    let first = null, last = null;\n" +
   "    const absorb = async (line, { witnessed }) => {\n" +
   "      const envelope = JSON.parse(line);\n" +
   "      const verified = verifyEventBridgeEnvelope(envelope, config.eventBridgeKey);\n" +
   "      if (!eventBridgeWriterTrusted(verified, writer)) throw new Error('E_DOMAIN_EVENT_AUTH');\n" +
   "      const eventId = safeIdentifier(verified.event.eventId);\n" +
   "      if (witnessed) {\n" +
   "        const witness = { id: String(eventId), mac: envelope.mac };\n" +
   "        first ??= witness;\n" +
   "        last = witness;\n" +
   "      }\n" +
   "      // The committed domain marker covers the complete single-event batch.\n" +
   "      // Authenticate every record the checkpoint does not cover, including\n" +
   "      // duplicates, before consulting it. Already committed events need\n" +
   "      // neither a second parse nor a full DTO.\n" +
   "      const marker = domain.global.get().applied[eventId];\n" +
   "      if (marker) {\n" +
   "        if (marker !== envelope.mac) throw new Error('E_DOMAIN_EVENT_ID_CONFLICT');\n" +
   "        duplicates++; return;\n" +
   "      }\n" +
   "      const event = projectExecutionEvent(verified.event);\n" +
   "      const result = await mutate(instance => instance.applyExecutionEvent(event), { ...domain.global.get().applied, [event.eventId]: envelope.mac });\n" +
   "      if (result.duplicate) duplicates++; else applied++;\n" +
   "    };\n" +
   "    for (const line of plan.lines) {\n" +
   "      if (!line.trim()) continue;\n" +
   "      await absorb(line, { witnessed: true });\n" +
   "    }\n" +
   "    // A torn trailing line is processed exactly as before but stays outside\n" +
   "    // the checkpoint, so a later append re-processes it instead of silently\n" +
   "    // skipping bytes that were never a complete record.\n" +
   "    if (plan.remainder.trim()) await absorb(plan.remainder, { witnessed: false });\n" +
   ""],
  // The event-bridge authentication rule was unified after the anchor: the
  // replay path now calls the same exported predicate the doctor uses, and the
  // writer default comes from one exported constant. The rule is unchanged - a
  // record is replayable only when its MAC verifies and it names the trusted
  // writer - so reversing these three lines restores the pinned source instead
  // of dropping the anchor.
  ["import { EVENT_BRIDGE_DEFAULT_WRITER, eventBridgeWriterTrusted, safeErrorDto, verifyEventBridgeEnvelope } from './orchestrator.js';\n",
   "import { verifyEventBridgeEnvelope } from './orchestrator.js';\n"],
  ["    const writer = config.eventBridgeWriter || EVENT_BRIDGE_DEFAULT_WRITER;\n",
   "    const writer = config.eventBridgeWriter || 'dsh-evolution-orchestrator';\n"],
  ["      if (!eventBridgeWriterTrusted(verified, writer)) throw new Error('E_DOMAIN_EVENT_AUTH');\n",
   "      if (!verified || verified.writer !== writer) throw new Error('E_DOMAIN_EVENT_AUTH');\n"],
  // The archive-lock comment now states what the settle window and the
  // live-owner rule actually guarantee, and it carries the rendezvous rule a
  // reclaim and a release both depend on. Both paragraphs belong to this one
  // comment, so the whole comment is one piece: the later wording and the
  // rendezvous paragraph have no anchor the pinned text also has, so a
  // paragraph-only piece could only be anchored on text this piece rewrites, and
  // an empty anchor cannot be replayed in the other direction.
  ["/**\n * Acquire the cross-process archive lock. A lock whose owner is dead, or whose\n * content was never written (the writer was killed between create and write),\n * must not brick the plugin: a lock that cannot be read or parsed is reclaimed\n * only once the file has not been modified for LOCK_SETTLE_MS, while a lock\n * whose readable content names a live owner is refused, never taken.\n *\n * The path is the only rendezvous point between processes, so a reclaim and a\n * release both prove that the entry they remove is still the exact file they\n * inspected: the content alone cannot, because the path outlives every lock that\n * occupies it.\n */",
   "/**\n * Acquire the cross-process archive lock. A lock whose owner is dead, or whose\n * content was never written (the writer was killed between create and write),\n * must not brick the plugin: an unparsable lock is reclaimed only after it has\n * definitively settled, so an in-flight writer can never be displaced.\n */"],
  // The ledger-merge guard: recovery installs the committed markers it just
  // recovered, and the caller's own set is merged onto them. An eventId both
  // sides know with a different MAC is the same conflict the replay path
  // rejects, so it throws instead of letting either side win.
  ["/**\n" +
   " * Merge the ledger a caller passes onto the one recovery installed.\n" +
   " *\n" +
   " * The caller's set is the newer of the two - `replay()` adds the event it just\n" +
   " * verified - so a marker only the caller knows is added. When both sets know the\n" +
   " * same eventId with a different MAC, they disagree about which envelope was\n" +
   " * committed under that identity, and that is a conflict rather than an update:\n" +
   " * it is the same condition the replay path rejects on the live ledger\n" +
   " * (`E_DOMAIN_EVENT_ID_CONFLICT`). Letting either side win here would silently\n" +
   " * rewrite an event identity that is already committed, so neither does. This\n" +
   " * check runs on the ledger `installPending()` just installed, which is the only\n" +
   " * moment the recovered markers - and therefore the conflict - are visible.\n" +
   " */\n" +
   "function mergeEventLedger(recovered, applied) {\n" +
   "  if (!applied) return recovered;\n" +
   "  const merged = { ...recovered };\n" +
   "  for (const [eventId, mac] of Object.entries(applied)) {\n" +
   "    const known = merged[eventId];\n" +
   "    if (known !== undefined && known !== mac) throw new Error('E_DOMAIN_EVENT_ID_CONFLICT');\n" +
   "    merged[eventId] = mac;\n" +
   "  }\n" +
   "  return merged;\n" +
   "}\n" +
   "const safeIdentifier = value => typeof value === 'string'",
   "const safeIdentifier = value => typeof value === 'string'"],
  // Round 4 routed the checkpoint warning through `safeErrorDto`, because a log
  // line is a boundary like any other. Reversing it restores the pinned source
  // instead of dropping the anchor.
  ["        // Losing the checkpoint only means the next pass re-verifies history.\n        // The warning is a log line, and a log line is a boundary: it carries\n        // the safe DTO (redacted summary, category, digest), not the raw message.\n        const detail = safeErrorDto(error, 'event-log-checkpoint');\n        ctx.logger?.warn?.(`[evolution] event log checkpoint not written: ${detail.errorSummary} (${detail.errorCategory}, ${detail.errorDigest})`);\n",
   "        // Losing the checkpoint only means the next pass re-verifies history.\n        ctx.logger?.warn?.(`[evolution] event log checkpoint not written: ${error?.message || error}`);\n"],
  // The whole-document schema no longer validates every value against
  // `z.json()`. `aggregateSchema` preprocesses with `toJsonProjection`, and the
  // output of `JSON.parse(JSON.stringify(...))` can only be JSON - an in-memory
  // `NaN`/`Infinity` became `null` inside the projection, and a value that only
  // parses to `Infinity` (`1e999`) is normalized to `null` the same way - so the
  // recursive walk could never reject a projected document. It only walked the
  // aggregate again on every save of every transaction step. `passthrough()`
  // keeps the unknown evolution fields and the strict document shape, which is
  // the part that can still reject.
  //
  // The walk did transform one thing: it built its result with plain property
  // assignment, so an own `__proto__` key (which `JSON.parse` can create)
  // vanished instead of being kept. The projection therefore drops that key
  // itself, which is why this piece covers the whole block and not just the
  // schema line.
  ["// The legacy aggregate can carry `undefined` object fields (e.g. relationRefs).\n" +
   "// JSON is the durable medium, and the old file backend already dropped those\n" +
   "// fields through JSON.stringify, so normalize to the exact JSON projection before\n" +
   "// validating: this keeps strict persistence semantics without silently changing\n" +
   "// state.\n" +
   "//\n" +
   "// That projection is also why no per-value JSON schema is needed below. Its\n" +
   "// output can only be `null`, booleans, strings, arrays, plain objects and\n" +
   "// numbers that `JSON.stringify` accepted - an in-memory `NaN` or `Infinity` is\n" +
   "// already `null` by the time anything is validated - so a recursive `z.json()`\n" +
   "// over every value could never reject a projected document; it only walked the\n" +
   "// whole aggregate a second time on every transaction step, and a single\n" +
   "// transaction step saves several times (`#append`, then `#markBridgeApplied`).\n" +
   "// `passthrough()` keeps the unknown evolution fields instead of stripping them\n" +
   "// (`catchall` would keep validating them), so the strict document shape, the\n" +
   "// `evolution.schema` integer and every structural requirement still hold.\n" +
   "const PROTO_KEY = '__proto__';\n" +
   "/**\n" +
   " * Drop one own `__proto__` key, which only `JSON.parse` can create: assigning\n" +
   " * that name on an ordinary object sets the prototype instead of an own key, so\n" +
   " * the recursive `z.record`-based walk this schema used to do dropped it as a\n" +
   " * side effect of building its result. Dropping it here keeps the projection's\n" +
   " * output identical to what that walk returned (`aggregate-schema-equivalence`\n" +
   " * pins the case at every depth), and past this point no schema ever assigns it.\n" +
   " */\n" +
   "function stripOwnProtoKeys(value) {\n" +
   "  if (Array.isArray(value)) { for (const item of value) stripOwnProtoKeys(item); return; }\n" +
   "  if (!value || typeof value !== 'object') return;\n" +
   "  if (Object.hasOwn(value, PROTO_KEY)) delete value[PROTO_KEY];\n" +
   "  for (const key of Object.keys(value)) stripOwnProtoKeys(value[key]);\n" +
   "}\n" +
   "/**\n" +
   " * The one projection every durable value goes through. The extra key is only\n" +
   " * looked for in the serialized text: `JSON.stringify` must spell an own key of\n" +
   " * that name literally, so a document that cannot contain one - every document\n" +
   " * this plugin writes - pays a substring search, not a second walk. (A string\n" +
   " * value that happens to read `__proto__` only makes the walk run and find\n" +
   " * nothing.)\n" +
   " */\n" +
   "const toJsonProjection = value => {\n" +
   "  const text = JSON.stringify(value);\n" +
   "  const projected = JSON.parse(text);\n" +
   "  if (text.includes(`\"${PROTO_KEY}\"`)) stripOwnProtoKeys(projected);\n" +
   "  return projected;\n" +
   "};\n" +
   "const aggregateSchema = z.preprocess(toJsonProjection,\n" +
   "  z.object({ evolution: z.object({ schema: z.number().int().min(4) }).passthrough().optional() }).strict());",
   "const json = z.json();\n" +
   "// The legacy aggregate can carry `undefined` object fields (e.g. relationRefs).\n" +
   "// JSON is the durable medium, and the old file backend already dropped those\n" +
   "// fields through JSON.stringify, so normalize to the exact JSON projection before\n" +
   "// validating: this keeps strict JSON validation without silently changing state.\n" +
   "const toJsonProjection = value => JSON.parse(JSON.stringify(value));\n" +
   "const aggregateSchema = z.preprocess(toJsonProjection,\n" +
   "  z.object({ evolution: z.object({ schema: z.number().int().min(4) }).catchall(json).optional() }).strict());"]
];

/** Revert only the retained write-path variant; everything else stays as written. */
export function reconstructPreMerge(source) {
  for (const [after, before] of reversals) {
    assert.equal(source.split(after).length - 1, 1,
      "domain-storage merged-variant post-change shape must occur exactly once before reconstruction");
    source = source.replace(after, before);
  }
  return source;
}

/**
 * The pre-change implementation used by the equivalence test and the benchmark.
 *
 * `release/dsh-evolution-0.2.0-rc.8.tgz` is committed and predates this change,
 * so the reconstruction must reproduce its file byte for byte. That assertion is
 * deliberately unconditional: losing the anchor must be a conscious edit, not a
 * silent downgrade to a reconstruction that only checks its own shape.
 */
export async function domainStorageBaseline() {
  const working = await readFile(new URL("../../lib/domain-storage.js", import.meta.url), "utf8");
  const reconstructed = reconstructPreMerge(working);
  assert.notEqual(reconstructed, working, "the reconstruction must actually change the source");
  const artifact = join(RELEASE_DIR, PRE_CHANGE_ARTIFACT);
  assert.ok(fs.existsSync(artifact),
    `${PRE_CHANGE_ARTIFACT} is the authoritative pre-change source for the merged write-path variant; restore it or move the anchor deliberately`);
  const pinned = readTarEntries(artifact).find((entry) => entry.path === SOURCE_PATH);
  assert.ok(pinned, "the pinned artifact must ship the domain storage implementation");
  const pinnedSource = pinned.bytes.toString("utf8");
  assert.match(pinnedSource, /await domain\.global\.set\(schema\.parse\(\{ schema: 1, aggregate: current\.pending\.aggregate/,
    `${PRE_CHANGE_ARTIFACT} must predate the merged write-path variant`);
  assert.equal(reconstructed, pinnedSource,
    "the reconstruction must be byte-identical to the authoritative pre-change pin");
  return { source: reconstructed, reconstructed, anchor: { artifact: PRE_CHANGE_ARTIFACT, pinnedSource } };
}

/**
 * Materialise one `lib/domain-storage.js` source as an importable module so an
 * A/B run or a differential test can load the pre-change and post-change
 * implementations side by side. Relative specifiers resolve to the tree the
 * source belongs to (the working tree by default), so a whole-tree comparison
 * really loads two trees' siblings; bare specifiers resolve through this
 * process's module map. Only the file under test differs.
 */
/**
 * Rewrite import specifiers only where a specifier can be.
 *
 * The patterns must not match prose that merely reads `from "..."`. A real
 * specifier never spans a line, so the quoted run excludes `\n`, and that is what
 * keeps a wrapped doc comment out - the exact shape that broke this rewrite once
 * (`... from "a lock another ..."` continues on the next line, and rewriting it
 * corrupted the module being copied). A single-line `from "..."` inside a
 * comment or a string is still rewritten, because this is a pattern and not a
 * parser; every source it is given here has single-line specifiers.
 */
export async function materializeDomainStorage(source, home, label, resolveFrom = WORKING_SOURCE) {
  const modulePath = join(home, `${label}.mjs`);
  const rewritten = source
    .replace(/from (["'])(\.\/[^"'\n]+)\1/g,
      (_match, quote, specifier) => `from ${quote}${new URL(specifier, pathToFileURL(resolveFrom)).href}${quote}`)
    .replace(/from (["'])([^."'\n][^"'\n]*)\1/g,
      (_match, quote, specifier) => `from ${quote}${import.meta.resolve(specifier)}${quote}`);
  await writeFile(modulePath, rewritten);
  const module = await import(pathToFileURL(modulePath).href);
  assert.equal(typeof module.openDomainStorage, "function", `${label} must export openDomainStorage`);
  assert.ok(module.evolutionDomainSpec, `${label} must export evolutionDomainSpec`);
  return module;
}
