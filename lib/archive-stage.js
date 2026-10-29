import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Isolation of the cold archive tree from the in-flight domain transaction.
 *
 * A domain mutation must never modify the live archive tree before its
 * aggregate is committed: the tree is the durable projection of the committed
 * state, and recovery replays a staged tree back onto it. The previous
 * implementation guaranteed this by copying every archive file into a staging
 * directory and fsyncing all of them, twice per transaction, even though an
 * ordinary write touches one active file. This module keeps the same guarantee
 * with work proportional to what actually changed:
 *
 *   - A staged file that was not written is a hard link to the live file. The
 *     two directory entries share one inode, so they are the same bytes by
 *     construction, no copy is made, and no fsync is needed for a file that
 *     was already durable as part of the committed tree.
 *   - A whole directory the writer cannot modify in place - the sealed segment
 *     directory of a collection - is a link to the live directory instead of one
 *     hard link per segment. The stage still shows the committed bytes, at one
 *     directory entry instead of thousands, and a write inside it first replaces
 *     the link with a materialized directory (see `privatizeArchiveFile()`).
 *   - A file the writer is about to modify in place is first given a private
 *     copy (reflinked when the filesystem supports it), so the live tree is
 *     never written through the staging entry.
 *   - Files written as new files or through an atomic replace are private by
 *     construction.
 *   - Changes are detected by inode identity, not by timestamps: a staged file
 *     whose inode is still the one the live tree has is provably unchanged.
 *
 * Everything the writer changed is listed with its digest, fsynced, and
 * installed as an atomic replace. A live tree that does not match the snapshot
 * taken when the stage was created is a hard failure (`E_DOMAIN_STAGE_ISOLATION`)
 * rather than a silent corruption: it means some writer bypassed the guard.
 *
 * A borrowed directory is read-only by construction and not by convention: the
 * snapshot records its identity, and `assertLiveTreeUnchanged()` refuses a live
 * directory that gained or lost an entry, so a write that leaked through the
 * borrow is reported instead of being installed as if the stage had made it.
 */

const ARCHIVE_NAME_RE = /^state\.json\.(?:[A-Za-z]+-archive\.jsonl(?:\.segments)?|evolution-archive-index\.json)$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
/**
 * The exact archive path a transaction is allowed to delete.
 *
 * A compaction replaces the segment directory wholesale, so the files it no
 * longer has are exactly the sealed segments whose records were retired into
 * the aggregate. Nothing else is deletable: the active archive and the derived
 * index are always rewritten rather than removed, and a stage that lost any
 * other archive file is an anomaly with no deletion protocol. Guessing there
 * would destroy bytes nobody ever proved replaceable, so the change list
 * refuses instead (`E_DOMAIN_STAGE_DELETION_UNSUPPORTED`).
 */
const REMOVABLE_ARCHIVE_RE = /^state\.json\.[A-Za-z]+-archive\.jsonl\.segments\/segment-[0-9]+\.jsonl$/;

export function isRemovableArchiveSegment(file) {
  return typeof file === 'string' && REMOVABLE_ARCHIVE_RE.test(file);
}

/**
 * A temporary a seal left behind inside a segment directory.
 *
 * `EvolutionMemory` writes `.segment-<uuid>.tmp` and renames it into place, so a
 * crash between those two calls leaves a file no reader ever opens
 * (`inspectArchiveIntegrity` lists only `segment-N.jsonl`). A compaction that
 * replaces the directory therefore "loses" it, and it must not become an
 * error - that would let an unnoticed crash residue block every later reclaim -
 * and must not become a deletion either, because nothing ever proved its bytes
 * replaceable. It stays exactly where it is: preserved, unchecked, and outside
 * the transaction.
 */
export function isArchiveSealResidue(file) {
  if (typeof file !== 'string') return false;
  const parts = file.split('/');
  if (parts.length !== 2) return false;
  if (!/^state\.json\.[A-Za-z]+-archive\.jsonl\.segments$/.test(parts[0])) return false;
  return parts[1].endsWith('.tmp');
}
/** The staged change list. It lives at the stage root, where the archive walk
 *  never looks, so a legacy reader only ever sees archive files. */
export const STAGE_MANIFEST = '.archive-files.json';

/**
 * The stage's borrow record: which directories it shows through a link to the
 * live tree instead of holding an entry per file (`mirrorArchives`). It lives at
 * the stage root like the change list, so the archive walk never sees it, and it
 * is what lets a reader of the staged view distinguish a borrow from a symlink
 * nobody recorded - `inspectArchiveIntegrity()` follows a segment-directory link
 * only when this record names it. Paths are relative to the stage root, so the
 * record says nothing about where the data root is. Nothing on the recovery path
 * reads it: recovery installs `pending.files` from the committed document, and a
 * file inside a borrow is never in that list (the writer materializes a borrow
 * before it writes into one). The record is only written by a stage that has
 * borrows, so a tree with no sealed segments has no extra file.
 */
export const STAGE_BORROWS = '.archive-borrowed.json';

export const allowedArchive = name => ARCHIVE_NAME_RE.test(name);

function symlinkError() {
  const error = new Error('Archive symlink rejected');
  error.code = 'E_DOMAIN_ARCHIVE_SYMLINK';
  return error;
}

function statOf(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (stat.isSymbolicLink()) throw symlinkError();
  return stat;
}

/** The parts of one directory's identity this module compares. */
function directoryIdentity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino), mtimeNs: String(stat.mtimeNs) };
}

function fileIdentity(stat, shared) {
  return { dev: String(stat.dev), ino: String(stat.ino), size: stat.size, mtimeNs: stat.mtimeNs, shared };
}

/**
 * Visit every regular file the domain owns, exactly the set the previous
 * implementation copied: names matching `allowedArchive` at the tree root,
 * and everything beneath them. Relative paths use `/`; a symlink is rejected
 * anywhere in the tree, except a directory the caller lists in `linked` - the
 * directories a stage borrows from the live tree (`mirrorArchives()`) - which
 * is not descended into, because the borrow already shows those entries.
 *
 * `directories` is called once per subdirectory before its entries are walked,
 * so a caller can decide how the directory itself is represented.
 */
export function walkArchives(root, visit, relative = '', { directories = null, linked = null } = {}) {
  const directory = relative ? path.join(root, relative) : root;
  let names;
  try { names = fs.readdirSync(directory).sort(); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  for (const name of names) {
    if (!relative && !allowedArchive(name)) continue;
    const nested = relative ? `${relative}/${name}` : name;
    const absolute = path.join(root, nested);
    const stat = fs.lstatSync(absolute, { bigint: true });
    if (stat.isSymbolicLink()) {
      if (linked?.has(nested)) continue;
      throw symlinkError();
    }
    if (stat.isDirectory()) {
      directories?.(nested, absolute, stat);
      walkArchives(root, visit, nested, { directories, linked });
      continue;
    }
    if (stat.isFile()) visit(nested, absolute, stat);
  }
}

/**
 * Create the staged tree for one transaction and return the live tree's
 * identity snapshot.
 *
 * The stage has to show exactly the committed archive - a transaction reads its
 * whole history through it - and it has to own every byte it writes, without
 * paying a per-file cost for the files it will not touch. A sealed segment is
 * immutable by protocol (it is written under a temporary name, renamed into
 * place, and never appended to again), so the two cases are different:
 *
 *   - A root-level archive file (an active archive, a quarantine file, the index)
 *     is a hard link to the live file: the writer may modify it in place, and the
 *     guard hands it a private copy first.
 *   - A nested directory (a collection's sealed segments) is a link to the live
 *     directory. The stage shows the committed bytes through it at the cost of
 *     one entry instead of one per segment, and `privatizeArchiveFile()` replaces
 *     the link with a materialized directory before anything is written inside it.
 *
 * The returned `files` snapshot records the identity of every archive file,
 * whether or not the stage holds an entry for it: it is what proves the live
 * tree did not move and what proves the bytes a deletion removes. `directories`
 * records the identity of every borrowed directory, so a live entry appearing or
 * disappearing under one is caught rather than trusted.
 */
export function mirrorArchives(from, to) {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  // Every distinct parent directory is made once. `walkArchives` visits a
  // directory's files before it recurses into its subdirectories, and a
  // recursive mkdir creates any level it is missing, so one mkdir per staged
  // directory is enough; asking per file used to cost two calls (mkdir and the
  // stat inside it) for every archive file on every transaction.
  const directories = new Set([to]);
  const mirror = { live: from, files: new Map(), directories: new Map() };
  const stageDirectory = relative => {
    const target = path.join(to, relative);
    const parent = path.dirname(target);
    if (!directories.has(parent)) { fs.mkdirSync(parent, { recursive: true, mode: 0o700 }); directories.add(parent); }
    return target;
  };
  const share = (relative, absolute, stat) => {
    const target = stageDirectory(relative);
    let shared = true;
    try { fs.linkSync(absolute, target); } catch { shared = false; }
    if (!shared) fs.copyFileSync(absolute, target, fs.constants.COPYFILE_FICLONE);
    mirror.files.set(relative, fileIdentity(stat, shared));
  };
  const borrow = (relative, absolute, stat) => {
    // A directory below a borrowed one cannot be linked here - the borrow
    // already resolves to the live tree - so the ancestor is materialized first
    // and the link is created inside the private copy.
    const parts = relative.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      materializeLinkedDirectory({ live: from, directory: to, mirror, relative: parts.slice(0, index).join('/') });
    }
    stageDirectory(relative);
    fs.symlinkSync(absolute, path.join(to, relative), 'dir');
    mirror.directories.set(relative, directoryIdentity(stat));
  };
  walkArchives(from, (relative, absolute, stat) => {
    // A file inside a borrowed directory needs no staged entry; the borrow shows
    // exactly this inode. It is still recorded, because the removal protocol and
    // the isolation proof are written against the committed tree, not the stage.
    if (relative.includes('/')) { mirror.files.set(relative, fileIdentity(stat, false)); return; }
    share(relative, absolute, stat);
  }, '', { directories: borrow });
  recordBorrows(to, mirror);
  return mirror;
}

/** Write the stage's borrow record. Called when the set of borrows changes, which
 *  is once per mirror and once per materialized directory that creates a new one. */
function recordBorrows(directory, mirror) {
  // A stage is built once and named per transaction, so a record can only exist
  // after a borrow was made: an empty set needs no file and no removal, which is
  // the ordinary transaction (a collection that never sealed has no directory to
  // borrow).
  if (!mirror.directories.size) return;
  const borrowed = [...mirror.directories.keys()].sort();
  fs.writeFileSync(path.join(directory, STAGE_BORROWS), JSON.stringify({ schema: 1, borrowed }), { mode: 0o600 });
}

/**
 * Give the stage a private copy of a directory it was lending from the live tree.
 *
 * The transaction may only write inside a directory it owns, so the first write
 * through a borrow replaces the link with a real directory whose files are hard
 * links to the same inodes: the staged view is unchanged (same bytes, same
 * identities), the new directory owns every entry it will add, and the live
 * directory keeps its own. The link is removed before anything is created, so a
 * half-built copy can never be read as if it were complete.
 */
function materializeLinkedDirectory({ live, directory, mirror, relative }) {
  if (!mirror.directories.has(relative)) return false;
  const target = path.join(directory, ...relative.split('/'));
  const staged = fs.lstatSync(target);
  if (!staged.isSymbolicLink()) return false;
  const source = path.join(live, ...relative.split('/'));
  const names = fs.readdirSync(source).sort();
  // Read every entry's identity before the link goes away: a failure here must
  // leave the borrow in place rather than an empty directory that would install
  // a deletion of every segment it used to show.
  const entries = names.map(name => {
    const absolute = path.join(source, name);
    const stat = statOf(absolute);
    return { name, absolute, stat, nested: `${relative}/${name}` };
  });
  fs.unlinkSync(target);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  let borrowed = false;
  for (const entry of entries) {
    if (entry.stat.isDirectory()) {
      fs.symlinkSync(entry.absolute, path.join(target, entry.name), 'dir');
      mirror.directories.set(entry.nested, directoryIdentity(entry.stat));
      borrowed = true;
      continue;
    }
    if (!entry.stat.isFile()) continue;
    let shared = true;
    try { fs.linkSync(entry.absolute, path.join(target, entry.name)); } catch { shared = false; }
    if (!shared) fs.copyFileSync(entry.absolute, path.join(target, entry.name), fs.constants.COPYFILE_FICLONE);
    mirror.files.set(entry.nested, fileIdentity(entry.stat, shared));
  }
  if (borrowed) recordBorrows(directory, mirror);
  return true;
}

/**
 * Give the writer a private copy of a staged file before it is modified in
 * place, and a private directory before it is written into. Called with the
 * absolute path the writer resolved inside the stage. A path outside the stage,
 * or one that is already private, needs no copy.
 */
export function privatizeArchiveFile({ live = null, directory, snapshot, privatized, file }) {
  const relative = path.relative(directory, file).split(path.sep).join('/');
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
  // A borrowed directory is not owned by this transaction: materializing it here
  // is what makes the write below land in the stage instead of in the live tree.
  const parts = relative.split('/');
  try {
    for (let index = 1; index < parts.length; index += 1) {
      materializeLinkedDirectory({ live: live ?? snapshot.live, directory, mirror: snapshot, relative: parts.slice(0, index).join('/') });
    }
  } catch (error) {
    // Archive maintenance can catch write errors. A partly materialized tree
    // must never be interpreted as a deliberate set of segment deletions.
    snapshot.materializationError ??= error;
    throw error;
  }
  const recorded = snapshot.files.get(relative);
  if (!recorded || recorded.shared !== true || privatized.has(relative)) return;
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.copyFileSync(file, temporary, fs.constants.COPYFILE_FICLONE);
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  privatized.add(relative);
}

/**
 * Fail loud when the live tree changed under the transaction. A shared staged
 * entry is the same inode as the live entry, so a size or mtime change there
 * means something wrote through the shared link; a changed inode or a missing
 * file means the live entry was replaced while the stage was in flight. Both
 * would make the staged view inconsistent with what recovery would install.
 *
 * A borrowed directory is checked the same way, one level up: the stage reads its
 * entries through the link, so an entry that appeared or disappeared there is a
 * change this transaction did not make and the stage did not record. Nothing
 * else changes a directory's mtime - creating, renaming or unlinking an entry
 * does, and reading through the link does not - so this is the proof that a
 * borrow still shows the committed set of segments.
 */
export function assertLiveTreeUnchanged(live, mirror) {
  for (const [relative, before] of mirror.files) {
    let stat;
    try { stat = statOf(path.join(live, ...relative.split('/'))); } catch { throw isolationError(relative, 'is missing'); }
    if (String(stat.dev) !== before.dev || String(stat.ino) !== before.ino) throw isolationError(relative, 'was replaced');
    if (stat.size !== before.size || stat.mtimeNs !== before.mtimeNs) throw isolationError(relative, 'was modified');
  }
  for (const [relative, before] of mirror.directories) {
    let stat;
    try { stat = statOf(path.join(live, ...relative.split('/'))); } catch { throw isolationError(relative, 'is missing'); }
    if (!stat.isDirectory()) throw isolationError(relative, 'is no longer a directory');
    if (String(stat.dev) !== before.dev || String(stat.ino) !== before.ino) throw isolationError(relative, 'was replaced');
    if (String(stat.mtimeNs) !== before.mtimeNs) throw isolationError(relative, 'gained or lost an entry');
  }
}

function isolationError(relative, reason) {
  const error = new Error(`E_DOMAIN_STAGE_ISOLATION: live archive ${relative} ${reason} during a staged domain transaction`);
  error.code = 'E_DOMAIN_STAGE_ISOLATION';
  return error;
}

/**
 * Every staged file that is no longer the live file, with its digest, plus one
 * `{ removed: true, bytes, sha256 }` entry for every live file the stage no
 * longer has.
 *
 * A deletion is derived from the snapshot, not from an intention the writer
 * expressed: a file is deleted because it was part of the committed tree when
 * the transaction started and the completed stage does not have it. The entry
 * records the bytes that are about to be deleted, read from the live tree after
 * proving the live entry is still the exact inode, size and mtime the snapshot
 * captured - so the digest describes the committed bytes, and the install can
 * refuse to delete anything that moved since. Only a sealed segment qualifies;
 * any other vanished archive file is a refusal, because nothing else has a
 * protocol that says its records were replaced.
 *
 * `live` is required exactly when the change list carries a deletion. A stage
 * without a live tree to prove the bytes against (a synthetic benchmark) gets a
 * loud failure instead of an unverifiable entry.
 *
 * A file the stage does not have is not by itself a deletion: a directory the
 * stage still borrows shows its files without holding an entry for them, and a
 * file under such a borrow is exactly the committed file `assertLiveTreeUnchanged()`
 * just proved unmoved. Only a file whose directory the transaction materialized
 * and then left out - the compaction's replaced segment layout - is a deletion.
 */
export function changedArchiveFiles(directory, mirror, live = null) {
  if (mirror.materializationError) throw mirror.materializationError;
  const changed = [];
  const staged = new Set();
  const borrowed = new Set();
  for (const relative of mirror.directories.keys()) {
    let stat = null;
    try { stat = fs.lstatSync(path.join(directory, ...relative.split('/'))); } catch {}
    if (stat?.isSymbolicLink()) borrowed.add(relative);
  }
  walkArchives(directory, (relative, absolute, stat) => {
    staged.add(relative);
    const before = mirror.files.get(relative);
    if (before && before.shared === true && before.dev === String(stat.dev) && before.ino === String(stat.ino)) return;
    changed.push({ file: relative, bytes: Number(stat.size),
      sha256: crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex') });
  }, '', { linked: borrowed });
  const beneathBorrow = relative => [...borrowed].some(parent => relative.startsWith(`${parent}/`));
  const removed = [];
  for (const [relative, before] of mirror.files) {
    if (staged.has(relative)) continue;
    if (isArchiveSealResidue(relative)) continue;
    if (beneathBorrow(relative)) continue;
    if (!isRemovableArchiveSegment(relative)) {
      throw new Error(`E_DOMAIN_STAGE_DELETION_UNSUPPORTED: ${relative} is absent from the stage and has no deletion protocol`);
    }
    if (!live) throw new Error(`E_DOMAIN_STAGE_DELETION_UNVERIFIABLE: ${relative} is absent from the stage and there is no live tree to prove the deleted bytes against`);
    const absolute = path.join(live, ...relative.split('/'));
    let content;
    try {
      const stat = statOf(absolute);
      if (String(stat.dev) !== before.dev || String(stat.ino) !== before.ino
        || stat.size !== before.size || stat.mtimeNs !== before.mtimeNs) {
        throw new Error(`E_DOMAIN_STAGE_DELETION_UNPROVEN: ${relative} changed after the stage was created`);
      }
      content = fs.readFileSync(absolute);
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`E_DOMAIN_STAGE_DELETION_UNPROVEN: ${relative} is absent from the stage and from the live tree`);
      throw error;
    }
    if (Number(before.size) !== content.length) throw new Error(`E_DOMAIN_STAGE_DELETION_UNPROVEN: ${relative} changed size while it was being read`);
    removed.push({ file: relative, removed: true, bytes: content.length,
      sha256: crypto.createHash('sha256').update(content).digest('hex') });
  }
  return [...changed, ...removed];
}

export function stageDirectory(stagingRoot, stage) {
  return path.join(stagingRoot, stage);
}

/**
 * Remove a stage, unlinking anything it points at outside itself first.
 *
 * A stage can hold a borrow - a link to a live archive directory - and the one
 * failure this cleanup must never have is following it: `rm -r` does not, but a
 * stage is removed from the transaction's commit path and from recovery, and
 * deleting the live archive tree is not a risk worth leaving to that behaviour.
 * Unlinking the borrow first also keeps the removal independent of entries the
 * stage made below it.
 *
 * `snapshot` is the mirror that built the stage. When it recorded no borrow, the
 * stage holds nothing that points outside itself and the pre-pass is skipped -
 * that is the ordinary transaction, and the scan was a measurable share of it.
 * Without a mirror (recovery of a stage this process did not build) the scan runs
 * because nothing else can say what the stage holds.
 */
export function removeStage(directory, snapshot = null) {
  if (snapshot === null || (snapshot.directories?.size ?? 0) > 0) {
    let names;
    try { names = fs.readdirSync(directory); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    for (const name of names) {
      const entry = path.join(directory, name);
      let stat = null;
      try { stat = fs.lstatSync(entry); } catch { continue; }
      if (stat.isSymbolicLink()) fs.unlinkSync(entry);
    }
  }
  fs.rmSync(directory, { recursive: true });
}

export function writeStageManifest(directory, files) {
  const file = path.join(directory, STAGE_MANIFEST);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ schema: 1, files }), { mode: 0o600 });
  try { fs.renameSync(temporary, file); }
  catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
  // The durable pending record is authoritative for recovery: it carries the
  // same file list, so nothing on the recovery path reads this copy. This
  // on-disk copy is diagnostic, and its contents are deliberately not fsynced
  // (`syncStage`): a crash may leave it truncated, which only costs a reader
  // that wanted the diagnostic view, while the installed file list still comes
  // from the committed document.
}

export function readStageManifest(directory) {
  let document;
  try { document = JSON.parse(fs.readFileSync(path.join(directory, STAGE_MANIFEST), 'utf8')); } catch { return null; }
  if (!document || document.schema !== 1 || !Array.isArray(document.files)) return null;
  const files = [];
  for (const entry of document.files) {
    if (!entry || typeof entry !== 'object') return null;
    if (typeof entry.file !== 'string' || !isArchiveRelativePath(entry.file)) return null;
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) return null;
    if (typeof entry.sha256 !== 'string' || !DIGEST_PATTERN.test(entry.sha256)) return null;
    if (entry.removed !== undefined && entry.removed !== true) return null;
    if (entry.removed === true && !isRemovableArchiveSegment(entry.file)) return null;
    files.push(entry.removed === true
      ? { file: entry.file, removed: true, bytes: entry.bytes, sha256: entry.sha256 }
      : { file: entry.file, bytes: entry.bytes, sha256: entry.sha256 });
  }
  return files;
}

function isArchiveRelativePath(file) {
  if (file.length === 0 || path.isAbsolute(file)) return false;
  const parts = file.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) return false;
  return allowedArchive(parts[0]);
}

/**
 * Check every directory level between an archive root and one of its files.
 * `walkArchives` already refuses a symlink it meets, but the install resolves a
 * destination the walk never visited, so it checks each level it is about to
 * traverse instead of relying on `mkdir`/`rename` to follow it. A missing level
 * ends the check: nothing can exist below it. With `create`, a missing level is
 * made one at a time after its own check, so a level that appears in between is
 * still refused rather than traversed.
 */
function archiveDirectories(base, parts, file, { create }) {
  let current = base;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    let stat = null;
    try { stat = fs.lstatSync(current); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (!stat) {
      if (!create) return;
      try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink()) throw symlinkError();
    if (!stat.isDirectory()) throw new Error(`E_DOMAIN_PENDING_ARCHIVE_INVALID: ${file} crosses a non-directory`);
  }
}

export function syncFile(file) {
  const descriptor = fs.openSync(file, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

/** Every directory from `entries` up to and including `stopAt`, deepest
 *  first, each fsynced exactly once. */
function syncDirectories(entries, stopAt) {
  const directories = new Set();
  for (const entry of entries) {
    for (let current = entry; ; current = path.dirname(current)) {
      directories.add(current);
      if (current === stopAt) break;
      const parent = path.dirname(current);
      if (parent === current) break;
    }
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) syncDirectory(directory);
}

/**
 * Make a completed stage durable: every changed file and the directory
 * entries that were created or replaced. Unchanged files are hard links to
 * already durable live files and need no fsync at all; the stage directory
 * itself is fsynced so the pending record can only ever reference a stage the
 * recovery can find.
 *
 * The stage manifest is written (it is the readable record of what this stage
 * changed) but is not fsynced: recovery installs `pending.files` from the
 * committed document, never the manifest, so its bytes are not durable state
 * and the fsync of it was only wait in the write path. Its directory entry is
 * still flushed together with the other entries below.
 */
export function syncStage({ directory, stagingRoot, files }) {
  const entries = [directory];
  for (const { file, removed } of files) {
    // A deletion has no staged bytes to flush: the file it removes belongs to
    // the already durable live tree.
    if (removed === true) continue;
    const absolute = path.join(directory, ...file.split('/'));
    syncFile(absolute);
    entries.push(path.dirname(absolute));
  }
  syncDirectories(entries, stagingRoot);
}

/**
 * Install every staged file into the live tree with an atomic replace, after
 * verifying that each staged file is a regular file whose bytes are exactly the
 * bytes that were recorded when the stage was committed. The whole change list
 * is verified, and its destination directories are checked, before the first
 * live entry moves: a stage that cannot be installed in full must leave the
 * committed tree byte-identical instead of publishing a prefix of it that the
 * next startup would have to reconcile. The bytes verified here are the bytes
 * installed below, so verification and install cannot disagree. Re-running is
 * idempotent, which is what makes crash recovery a replay rather than a
 * recomputation.
 *
 * The publish step gives the verified staged inode its live name (`link` and
 * `rename`) instead of copying the bytes into a new file and fsyncing that
 * copy. `syncStage` already made the staged inode durable, so the second copy
 * of the same bytes could only be written and synced to be discarded: the
 * verified bytes are that inode's bytes by construction, and `link` plus
 * `rename` replaces the live entry atomically, so a reader sees either the
 * committed file or the new one and never a partial write. The staged entry
 * itself stays in place, which keeps the stage the complete record of the
 * transaction that a replay installs from. A filesystem that refuses the link
 * (a stage that ended up on another medium) falls back to writing the verified
 * bytes, which is exactly what this function did before.
 */
export function installArchiveFiles(source, live, files) {
  const verified = [];
  const removals = [];
  for (const entry of files) {
    if (entry.removed === true) { removals.push(verifyArchiveRemoval(live, entry)); continue; }
    const { file, bytes, sha256 } = entry;
    if (!isArchiveRelativePath(file)) throw new Error('E_DOMAIN_PENDING_ARCHIVE_INVALID: invalid archive path');
    const parts = file.split('/');
    const staged = path.join(source, ...parts);
    archiveDirectories(source, parts, file, { create: false });
    let stat;
    try { stat = statOf(staged); } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`E_DOMAIN_PENDING_ARCHIVE_MISSING: ${file} is not staged`);
      throw error;
    }
    if (!stat.isFile()) throw new Error(`E_DOMAIN_PENDING_ARCHIVE_INVALID: ${file} is not a regular file`);
    const content = fs.readFileSync(staged);
    if (content.length !== bytes || crypto.createHash('sha256').update(content).digest('hex') !== sha256) {
      throw new Error(`E_DOMAIN_PENDING_ARCHIVE_CORRUPT: ${file} does not match the committed stage`);
    }
    archiveDirectories(live, parts, file, { create: false });
    verified.push({ file, parts, staged, content, mode: Number(stat.mode & 0o777n),
      dev: String(stat.dev), ino: String(stat.ino) });
  }
  const directories = new Set();
  for (const { file, parts, staged, content, mode, dev, ino } of verified) {
    const target = path.join(live, ...parts);
    archiveDirectories(live, parts, file, { create: true });
    // The temporary name is drawn before the entry is examined: one identifier
    // per published entry is what the released implementation consumed, and the
    // differential anchors that compare a frozen identifier sequence against it
    // depend on that count. A name that is not used is simply dropped.
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    // An interrupted install that already reached this entry left the live name
    // on exactly this inode. Renaming a second name of the same file onto it is
    // a no-op in POSIX that leaves the extra name behind, so the replay is
    // finished by proving the entry is already published and syncing its
    // directory. Nothing else about the file has to be re-derived: the bytes
    // verified above are its bytes. The check is an `lstat` that accepts only a
    // regular file, so every other shape of live entry - a symlink, a
    // directory, a device - is left to the rename below, which replaces or
    // refuses it exactly as it did before this change.
    let present = null;
    try { present = fs.lstatSync(target, { bigint: true }); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (present?.isFile() === true && String(present.dev) === dev && String(present.ino) === ino) {
      directories.add(path.dirname(target));
      continue;
    }
    try {
      let linked = true;
      try { fs.linkSync(staged, temporary); } catch { linked = false; }
      if (!linked) {
        fs.writeFileSync(temporary, content, { mode });
        syncFile(temporary);
      }
      fs.renameSync(temporary, target);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch {}
      throw error;
    }
    directories.add(path.dirname(target));
  }
  // Deletions come last, after every replacement is published: a failure while
  // publishing can only leave the committed tree with more files, never fewer,
  // and a replay that finds the segment already gone continues from where the
  // interrupted install stopped. The parent directory is flushed so the removal
  // is as durable as the installs that preceded it.
  for (const removal of removals) {
    if (!removal.present) continue;
    fs.unlinkSync(removal.target);
    directories.add(path.dirname(removal.target));
  }
  syncDirectories([...directories], live);
}

/**
 * Verify one committed deletion against the live tree, without touching it.
 *
 * The deletion list is verified together with the replacements and before the
 * first live byte moves, so a stage that cannot be installed in full leaves the
 * committed tree byte-identical. A live entry that is already gone is the normal
 * replay case and succeeds: the delete is idempotent. An entry whose bytes are
 * no longer the committed bytes is refused - deleting it would destroy evidence
 * the transaction never proved replaceable - and that refusal is the same before
 * a crash and during recovery, so recovery cannot install a prefix of a stage.
 */
function verifyArchiveRemoval(live, { file, bytes, sha256 }) {
  if (!isRemovableArchiveSegment(file)) throw new Error(`E_DOMAIN_PENDING_ARCHIVE_INVALID: ${file} is not a removable archive segment`);
  const parts = file.split('/');
  archiveDirectories(live, parts, file, { create: false });
  const target = path.join(live, ...parts);
  let stat;
  try { stat = statOf(target); } catch (error) {
    if (error?.code === 'ENOENT') return { file, target, present: false };
    throw error;
  }
  if (!stat.isFile()) throw new Error(`E_DOMAIN_PENDING_ARCHIVE_INVALID: ${file} is not a regular file`);
  const content = fs.readFileSync(target);
  if (content.length !== bytes || crypto.createHash('sha256').update(content).digest('hex') !== sha256) {
    throw new Error(`E_DOMAIN_PENDING_ARCHIVE_CORRUPT: ${file} does not match the committed deletion`);
  }
  return { file, target, present: true };
}

/** Legacy full-tree install, kept for a stage that carries no manifest. */
export function copyArchives(from, to) {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(from)) return;
  for (const name of fs.readdirSync(from).filter(allowedArchive)) {
    const source = path.join(from, name);
    if (fs.lstatSync(source).isSymbolicLink()) throw symlinkError();
    fs.cpSync(source, path.join(to, name), { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
  }
}

/** Legacy full-tree fsync, kept for a stage that carries no manifest. */
export function syncTree(dir) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.lstatSync(file).isDirectory()) syncTree(file); else syncFile(file);
  }
  syncFile(dir);
}


// Read-only integrity classification for the domain archive tree.

export const ARCHIVE_COLLECTIONS = Object.freeze([
  "observations", "diagnoses", "gaps", "candidates", "proposals", "experiments",
  "experimentRecords", "journal", "selections", "promotions", "outcomes", "cycles",
  "lineage", "learnings", "strategies", "strategyMutations", "knowledge", "tombstones",
]);

function archivePath(stateFile, collection) {
  return `${stateFile}.${collection}-archive.jsonl`;
}

function inferDomainGlobalPath(stateFile) {
  const stateDirectory = path.dirname(stateFile);
  const parent = path.dirname(stateDirectory);
  let presetDirectory = null;
  if (path.basename(stateDirectory) === "dockyard") presetDirectory = parent;
  else if (path.basename(parent) === "domain-staging" && /^stage-[a-f0-9-]+$/.test(path.basename(stateDirectory))) {
    presetDirectory = path.dirname(parent);
  }
  if (!presetDirectory) return null;
  return path.join(path.dirname(presetDirectory), `${path.basename(presetDirectory)}_domain.json`);
}

function readFileState(file, { readBytes = true } = {}) {
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile()) return { state: "unreadable", error: "not-a-regular-file" };
    return readBytes
      ? { state: "readable", size: info.size, bytes: fs.readFileSync(file) }
      : { state: "readable", size: info.size, bytes: null };
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "absent" };
    return { state: "unreadable", error: error?.code ?? String(error?.message ?? error) };
  }
}

function shouldReadContents(scanContents, file) {
  return typeof scanContents === "function" ? scanContents(file) === true : scanContents === true;
}

function readPendingState(domainGlobalPath, supplied) {
  if (supplied === true || supplied === false || supplied === null) return supplied;
  if (!domainGlobalPath) return false;
  const source = readFileState(domainGlobalPath);
  if (source.state === "absent") return false;
  if (source.state !== "readable") return null;
  try {
    const document = JSON.parse(source.bytes.toString("utf8"));
    if (!document || typeof document !== "object" || !document.global || typeof document.global !== "object"
      || !Object.hasOwn(document.global, "pending")) return null;
    return document.global.pending === null ? false : true;
  } catch {
    return null;
  }
}

function faultIdentity(fault) {
  return `${fault.collection}\u0000${fault.file}`;
}

function validIndexTarget(stateFile, entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  if (!ARCHIVE_COLLECTIONS.includes(entry.collection) || typeof entry.file !== "string") return null;
  const activeName = path.basename(archivePath(stateFile, entry.collection));
  if (entry.file === activeName) return { ...entry, sealed: false };
  if (/^segment-[0-9]+\.jsonl$/.test(entry.file)) return { ...entry, sealed: true };
  return null;
}

function inspectLines(raw, { active, file }) {
  const text = raw.toString("utf8");
  const endsWithNewline = raw.length === 0 || raw.at(-1) === 0x0a;
  const lines = text.split("\n");
  if (endsWithNewline) lines.pop();
  const faults = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    let value;
    try { value = JSON.parse(line); }
    catch {
      const trailing = index === lines.length - 1 && !endsWithNewline;
      faults.push({
        kind: trailing && active ? "torn-tail" : "invalid-line",
        file,
        line: index + 1,
        bytes: Buffer.byteLength(line),
      });
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      faults.push({ kind: "unusable-line", file, line: index + 1, bytes: Buffer.byteLength(line) });
    }
  }
  if (raw.length > 0 && !endsWithNewline) {
    const last = lines.at(-1) ?? "";
    let completeRecord = false;
    try {
      const value = JSON.parse(last);
      completeRecord = Boolean(value) && typeof value === "object" && !Array.isArray(value);
    } catch {}
    if (completeRecord) faults.push({ kind: "missing-trailing-newline", file, line: lines.length, bytes: Buffer.byteLength(last) });
  }
  return { lineCount: lines.length, invalid: faults.filter((fault) => fault.kind === "invalid-line").length, endsWithNewline, faults };
}

function compactArtifacts(root, stateFile) {
  const names = [];
  try {
    for (const name of fs.readdirSync(root)) {
      if (name.startsWith(path.basename(stateFile) + ".") && name.includes(".compact-") && /\.(?:bak|tmp)$/.test(name)) names.push(name);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") return { names, error: error?.code ?? String(error?.message ?? error) };
  }
  return { names: names.sort(), error: null };
}

/** The borrow record a stage wrote at its root, or null when it has none. */
function readBorrows(root) {
  let document;
  try { document = JSON.parse(fs.readFileSync(path.join(root, STAGE_BORROWS), "utf8")); } catch { return null; }
  if (!document || document.schema !== 1 || !Array.isArray(document.borrowed)) return null;
  return new Set(document.borrowed.filter((entry) => typeof entry === "string"));
}

/** Read-only classifier shared by runtime memory checks and doctor. */
export function inspectArchiveIntegrity({ stateFile, indexFile = `${stateFile}.evolution-archive-index.json`, domainGlobalPath = null, pendingInstall, scanContents = true } = {}) {
  if (typeof stateFile !== "string" || !stateFile) {
    return { valid: true, status: "not-configured", index: { state: "absent" }, files: [], findings: [], missingIndexTargets: [], persistedFaults: [], transitions: { pendingInstall: false, compaction: [] } };
  }
  const root = path.dirname(stateFile);
  const findings = [];
  const actualFiles = new Map();
  const files = [];
  const addFinding = (code, detail = {}) => findings.push({ code, ...detail });

  let index = { state: "absent", entries: [], integrityFaults: [] };
  const indexRead = readFileState(indexFile);
  if (indexRead.state === "unreadable") {
    index = { state: "unreadable", error: indexRead.error, entries: [], integrityFaults: [] };
    addFinding("archive-index-unreadable", { file: indexFile, error: indexRead.error });
  } else if (indexRead.state === "readable") {
    try {
      const document = JSON.parse(indexRead.bytes.toString("utf8"));
      if (!document || typeof document !== "object" || !Array.isArray(document.segments)) throw new Error("segments must be an array");
      index = {
        state: "readable",
        document,
        entries: document.segments,
        integrityFaults: document.integrityFaults ?? [],
      };
      if (document.integrityFaults !== undefined && !Array.isArray(document.integrityFaults)) {
        addFinding("archive-integrity-evidence-unusable", { file: indexFile, reason: "integrityFaults must be an array" });
        index.integrityFaults = [];
      }
    } catch (error) {
      index = { state: "invalid", error: String(error?.message ?? error), entries: [], integrityFaults: [] };
      addFinding("archive-index-invalid", { file: indexFile, error: index.error });
    }
  }

  const expected = new Map();
  const legacyEntries = [];
  for (const [position, entry] of index.entries.entries()) {
    const target = validIndexTarget(stateFile, entry);
    if (!target) {
      if (entry && typeof entry === "object" && !Array.isArray(entry) && entry.collection === undefined && typeof entry.file === "string") {
        legacyEntries.push({ position, entry });
        continue;
      }
      addFinding("archive-index-entry-unusable", { position, file: entry?.file ?? null, collection: entry?.collection ?? null });
      continue;
    }
    const key = faultIdentity(target);
    if (expected.has(key)) addFinding("archive-index-entry-duplicate", { collection: target.collection, file: target.file });
    else expected.set(key, target);
  }

  for (const collection of ARCHIVE_COLLECTIONS) {
    const activePath = archivePath(stateFile, collection);
    const segmentDirectory = `${activePath}.segments`;
    const paths = [];
    const active = readFileState(activePath, { readBytes: shouldReadContents(scanContents, activePath) });
    if (active.state === "readable") paths.push({ file: path.basename(activePath), path: activePath, active: true, size: active.size, bytes: active.bytes });
    else if (active.state === "unreadable") addFinding("archive-file-unreadable", { collection, file: path.basename(activePath), path: activePath, error: active.error });
    let names = [];
    let borrows;
    try {
      let info = fs.lstatSync(segmentDirectory);
      // A staged transaction shows this directory through a borrow instead of
      // holding one entry per sealed segment (`mirrorArchives()`). It is followed
      // only when the stage recorded that borrow: an unrecorded link, and any link
      // in a tree with no borrow record - the live tree, which nothing here ever
      // links - stays reported as unreadable rather than silently read through.
      if (info.isSymbolicLink()) {
        if (borrows === undefined) borrows = readBorrows(root);
        if (borrows?.has(path.relative(root, segmentDirectory))) info = fs.statSync(segmentDirectory);
      }
      if (!info.isDirectory()) addFinding("archive-segment-directory-unreadable", { collection, path: segmentDirectory, error: "not-a-regular-directory" });
      else names = fs.readdirSync(segmentDirectory).filter((name) => /^segment-[0-9]+\.jsonl$/.test(name)).sort();
    } catch (error) {
      if (error?.code !== "ENOENT") addFinding("archive-segment-directory-unreadable", { collection, path: segmentDirectory, error: error?.code ?? String(error?.message ?? error) });
    }
    for (const name of names) {
      const filePath = path.join(segmentDirectory, name);
      const result = readFileState(filePath, { readBytes: shouldReadContents(scanContents, filePath) });
      if (result.state === "readable") paths.push({ file: name, path: filePath, active: false, size: result.size, bytes: result.bytes });
      else addFinding("archive-file-unreadable", { collection, file: name, path: filePath, error: result.error ?? "missing-after-listing" });
    }
    for (const item of paths) {
      const key = faultIdentity({ collection, file: item.file });
      const digest = item.bytes ? crypto.createHash("sha256").update(item.bytes).digest("hex") : null;
      const lines = item.bytes ? inspectLines(item.bytes, { active: item.active, file: item.path }) : { lineCount: null, invalid: null, endsWithNewline: null, faults: [] };
      const record = { collection, file: item.file, path: item.path, active: item.active, sealed: !item.active, byteSize: item.bytes?.length ?? item.size, sha256: digest, lines: lines.lineCount, endsWithNewline: lines.endsWithNewline, faults: lines.faults };
      files.push(record);
      actualFiles.set(key, record);
      for (const fault of lines.faults) addFinding(`archive-${fault.kind}`, { collection, ...fault });
    }
  }

  for (const { position, entry } of legacyEntries) {
    const matches = [...actualFiles.keys()].filter((key) => key.endsWith(`\u0000${entry.file}`));
    if (matches.length === 1) {
      const [collection] = matches[0].split("\u0000");
      expected.set(matches[0], { ...entry, collection, sealed: entry.sealed === true || /^segment-[0-9]+\.jsonl$/.test(entry.file) });
    } else {
      addFinding("archive-index-entry-unusable", { position, file: entry.file, reason: matches.length ? "ambiguous legacy target" : "legacy target is absent and has no collection" });
    }
  }
  if (index.state === "readable") {
    for (const [key, actual] of actualFiles) {
      if (!expected.has(key)) addFinding("archive-file-unindexed", { collection: actual.collection, file: actual.file, path: actual.path });
    }
  } else if (index.state === "absent" && actualFiles.size > 0) {
    addFinding("archive-index-absent", { file: indexFile, archives: actualFiles.size });
    for (const actual of actualFiles.values()) addFinding("archive-file-unindexed", { collection: actual.collection, file: actual.file, path: actual.path });
  }

  for (const [key, entry] of expected) {
    const actual = actualFiles.get(key);
    if (!actual) continue;
    if (entry.sealed === true) {
      if (Number.isFinite(Number(entry.byteSize)) && Number(entry.byteSize) !== actual.byteSize) {
        addFinding("archive-sealed-size-mismatch", { collection: entry.collection, file: entry.file, expected: Number(entry.byteSize), actual: actual.byteSize });
      }
      if (typeof entry.sha256 === "string" && actual.sha256 !== null && entry.sha256 !== actual.sha256) {
        addFinding("archive-sealed-digest-mismatch", { collection: entry.collection, file: entry.file, expected: entry.sha256, actual: actual.sha256 });
      }
    }
  }

  const transitions = compactArtifacts(root, stateFile);
  if (transitions.error) addFinding("archive-transition-state-unreadable", { path: root, error: transitions.error });
  const pending = readPendingState(domainGlobalPath ?? inferDomainGlobalPath(stateFile), pendingInstall);
  const transitionActive = pending !== false || transitions.names.length > 0 || Boolean(transitions.error);
  const transitionKind = pending === true ? "pending-install" : pending === null ? "pending-state-unknown" : transitions.names.length ? "compaction" : transitions.error ? "transition-state-unknown" : null;
  const missingIndexTargets = [];
  for (const [key, entry] of expected) {
    if (actualFiles.has(key)) continue;
    const targetPath = entry.sealed === false
      ? archivePath(stateFile, entry.collection)
      : path.join(root, `${path.basename(archivePath(stateFile, entry.collection))}.segments`, entry.file);
    const detail = { collection: entry.collection, file: entry.file, path: targetPath, expected: { byteSize: Number.isSafeInteger(Number(entry.byteSize)) ? Number(entry.byteSize) : null, sha256: typeof entry.sha256 === "string" ? entry.sha256 : null }, indexEntry: entry, status: transitionActive ? "incomplete-transition" : "missing" };
    missingIndexTargets.push(detail);
    addFinding(transitionActive ? "archive-target-undetermined" : "archive-index-target-missing", { ...detail, transition: transitionKind, evidence: "The indexed target is absent; the cause is not proven." });
  }

  const persistedFaults = [];
  for (const [position, fault] of index.integrityFaults.entries()) {
    const validExpected = fault?.expected && typeof fault.expected === "object" && !Array.isArray(fault.expected)
      && (fault.expected.byteSize === null || Number.isSafeInteger(fault.expected.byteSize) && fault.expected.byteSize >= 0)
      && (fault.expected.sha256 === null || typeof fault.expected.sha256 === "string");
    const validEntry = fault?.indexEntry === undefined || fault.indexEntry && typeof fault.indexEntry === "object"
      && !Array.isArray(fault.indexEntry) && fault.indexEntry.collection === fault.collection
      && fault.indexEntry.file === fault.file && fault.indexEntry.sealed === true
      && (fault.expected?.byteSize === null ? fault.indexEntry.byteSize === null || fault.indexEntry.byteSize === undefined : Number(fault.indexEntry.byteSize) === fault.expected?.byteSize)
      && (fault.expected?.sha256 === null ? fault.indexEntry.sha256 === null || fault.indexEntry.sha256 === undefined : fault.indexEntry.sha256 === fault.expected?.sha256);
    if (!fault || typeof fault !== "object" || Array.isArray(fault) || fault.kind !== "missing-segment"
      || !ARCHIVE_COLLECTIONS.includes(fault.collection) || !/^segment-[0-9]+\.jsonl$/.test(fault.file ?? "")
      || !validExpected || !validEntry) {
      addFinding("archive-integrity-evidence-invalid", { file: indexFile, position });
      continue;
    }
    const key = faultIdentity(fault);
    let actual = actualFiles.get(key);
    if (actual && actual.sha256 === null) {
      const restored = readFileState(actual.path);
      if (restored.state === "readable") {
        actual.sha256 = crypto.createHash("sha256").update(restored.bytes).digest("hex");
        actual.byteSize = restored.bytes.length;
      }
    }
    const expectedBytes = fault.expected?.byteSize;
    const expectedDigest = fault.expected?.sha256;
    const restored = actual && Number.isSafeInteger(expectedBytes) && expectedBytes >= 0
      && typeof expectedDigest === "string" && /^[0-9a-f]{64}$/.test(expectedDigest)
      && actual.byteSize === expectedBytes && actual.sha256 === expectedDigest;
    const detail = {
      kind: "missing-segment",
      collection: fault.collection,
      file: fault.file,
      indexEntry: fault.indexEntry,
      expected: { byteSize: Number.isSafeInteger(expectedBytes) ? expectedBytes : null, sha256: typeof expectedDigest === "string" ? expectedDigest : null },
      status: restored ? "restored-bytes-proven" : actual ? "replacement-unproven" : transitionActive ? "incomplete-transition" : "missing",
      path: actual?.path ?? path.join(root, `${path.basename(archivePath(stateFile, fault.collection))}.segments`, fault.file),
      evidence: "The expected record contents are unknown; loss cause is not proven.",
    };
    persistedFaults.push(detail);
    if (!restored) addFinding("archive-loss-evidence", detail);
  }

  const quarantineFiles = [];
  for (const collection of ARCHIVE_COLLECTIONS) {
    const name = path.basename(archivePath(stateFile, collection)).replace("-archive.jsonl", "quarantine-archive.jsonl");
    const file = path.join(root, name);
    const result = readFileState(file, { readBytes: scanContents });
    if (result.state === "absent") continue;
    if (result.state === "unreadable") {
      const detail = { collection, file: name, path: file, error: result.error };
      quarantineFiles.push({ ...detail, state: "unreadable" });
      addFinding("archive-quarantine-unreadable", detail);
      continue;
    }
    quarantineFiles.push({ collection, file: name, path: file, state: "preserved-fragments", byteSize: result.size });
  }

  const unresolved = findings.some((finding) => !["archive-target-undetermined"].includes(finding.code));
  const valid = !unresolved && missingIndexTargets.length === 0;
  const mismatched = [];
  for (const finding of findings) {
    if (finding.code === "archive-file-unreadable") mismatched.push({ file: finding.path, reason: "unreadable" });
    else if (finding.code === "archive-sealed-size-mismatch") mismatched.push({ file: finding.path ?? path.join(root, `${path.basename(archivePath(stateFile, finding.collection))}.segments`, finding.file), reason: "byte_size", expected: finding.expected, actual: finding.actual });
    else if (finding.code === "archive-sealed-digest-mismatch") mismatched.push({ file: finding.path ?? path.join(root, `${path.basename(archivePath(stateFile, finding.collection))}.segments`, finding.file), reason: "checksum", expected: finding.expected, actual: finding.actual });
  }
  const missing = findings.filter((finding) => finding.code === "archive-file-unindexed").map((finding) => finding.path);
  const stale = missingIndexTargets.map((entry) => entry.path);
  for (const fault of persistedFaults) if (fault.status !== "restored-bytes-proven" && !stale.includes(fault.path)) stale.push(fault.path);
  return {
    valid,
    status: transitionActive ? "incomplete-transition" : valid ? "verified" : "inconsistent",
    files: actualFiles.size,
    missing,
    mismatched,
    stale,
    indexFile,
    index: { state: index.state, path: indexFile, ...(index.error ? { error: index.error } : {}) },
    files,
    findings,
    missingIndexTargets,
    persistedFaults,
    quarantineFiles,
    transitions: { pendingInstall: pending, compaction: transitions.names, kind: transitionKind },
    // A sealed file whose size changed can be re-hashed and its expected digest
    // replaced by the runtime reconciler before a later read-only scan sees it.
    // This classifier detects the old expectation only while it is still on disk.
  };
}
