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
 */

const ARCHIVE_NAME_RE = /^state\.json\.(?:[A-Za-z]+-archive\.jsonl(?:\.segments)?|evolution-archive-index\.json)$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
/** The staged change list. It lives at the stage root, where the archive walk
 *  never looks, so a legacy reader only ever sees archive files. */
export const STAGE_MANIFEST = '.archive-files.json';

export const allowedArchive = name => ARCHIVE_NAME_RE.test(name);

function symlinkError() { return new Error('Archive symlink rejected'); }

function statOf(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (stat.isSymbolicLink()) throw symlinkError();
  return stat;
}

/**
 * Visit every regular file the domain owns, exactly the set the previous
 * implementation copied: names matching `allowedArchive` at the tree root,
 * and everything beneath them. Relative paths use `/`; symlinks are rejected
 * anywhere in the tree.
 */
export function walkArchives(root, visit, relative = '') {
  const directory = relative ? path.join(root, relative) : root;
  let names;
  try { names = fs.readdirSync(directory).sort(); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  for (const name of names) {
    if (!relative && !allowedArchive(name)) continue;
    const nested = relative ? `${relative}/${name}` : name;
    const absolute = path.join(root, nested);
    const stat = statOf(absolute);
    if (stat.isDirectory()) { walkArchives(root, visit, nested); continue; }
    if (stat.isFile()) visit(nested, absolute, stat);
  }
}

/**
 * Create the staged tree for one transaction and return the live tree's
 * identity snapshot. Each staged file is a hard link to the live file, so the
 * stage is a complete, correct view of the archive at the cost of one
 * directory entry per file. Filesystems that refuse a link fall back to a
 * real copy, and the snapshot records which files are shared.
 */
export function mirrorArchives(from, to) {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  const snapshot = new Map();
  walkArchives(from, (relative, absolute, stat) => {
    const target = path.join(to, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    let shared = true;
    try { fs.linkSync(absolute, target); } catch { shared = false; }
    if (!shared) fs.copyFileSync(absolute, target, fs.constants.COPYFILE_FICLONE);
    snapshot.set(relative, { dev: String(stat.dev), ino: String(stat.ino),
      size: stat.size, mtimeNs: stat.mtimeNs, shared });
  });
  return snapshot;
}

/**
 * Give the writer a private copy of a staged file before it is modified in
 * place. Called with the absolute path the writer resolved inside the stage.
 * A path outside the stage, or one that is already private, needs no copy.
 */
export function privatizeArchiveFile({ directory, snapshot, privatized, file }) {
  const relative = path.relative(directory, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
  const recorded = snapshot.get(relative);
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
 */
export function assertLiveTreeUnchanged(live, snapshot) {
  for (const [relative, before] of snapshot) {
    let stat;
    try { stat = statOf(path.join(live, relative)); } catch { throw isolationError(relative, 'is missing'); }
    if (String(stat.dev) !== before.dev || String(stat.ino) !== before.ino) throw isolationError(relative, 'was replaced');
    if (stat.size !== before.size || stat.mtimeNs !== before.mtimeNs) throw isolationError(relative, 'was modified');
  }
}

function isolationError(relative, reason) {
  const error = new Error(`E_DOMAIN_STAGE_ISOLATION: live archive ${relative} ${reason} during a staged domain transaction`);
  error.code = 'E_DOMAIN_STAGE_ISOLATION';
  return error;
}

/** Every staged file that is no longer the live file, with its digest. */
export function changedArchiveFiles(directory, snapshot) {
  const changed = [];
  walkArchives(directory, (relative, absolute, stat) => {
    const before = snapshot.get(relative);
    if (before && before.shared === true && before.dev === String(stat.dev) && before.ino === String(stat.ino)) return;
    changed.push({ file: relative, bytes: Number(stat.size),
      sha256: crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex') });
  });
  return changed;
}

export function stageDirectory(stagingRoot, stage) {
  return path.join(stagingRoot, stage);
}

export function writeStageManifest(directory, files) {
  const file = path.join(directory, STAGE_MANIFEST);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ schema: 1, files }), { mode: 0o600 });
  try { fs.renameSync(temporary, file); }
  catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
  // The durable pending record is authoritative for recovery. This on-disk
  // copy is diagnostic; losing it cannot change the installed file list.
  // syncStage makes its contents and directory entry durable.
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
    files.push({ file: entry.file, bytes: entry.bytes, sha256: entry.sha256 });
  }
  return files;
}

function isArchiveRelativePath(file) {
  if (file.length === 0 || path.isAbsolute(file)) return false;
  const parts = file.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) return false;
  return allowedArchive(parts[0]);
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
 */
export function syncStage({ directory, stagingRoot, files }) {
  syncFile(path.join(directory, STAGE_MANIFEST));
  const entries = [directory];
  for (const { file } of files) {
    const absolute = path.join(directory, ...file.split('/'));
    syncFile(absolute);
    entries.push(path.dirname(absolute));
  }
  syncDirectories(entries, stagingRoot);
}

/**
 * Install one staged file into the live tree with an atomic replace, after
 * verifying that the staged bytes are exactly the bytes that were recorded
 * when the stage was committed. Re-running is idempotent, which is what makes
 * crash recovery a replay rather than a recomputation.
 */
export function installArchiveFiles(source, live, files) {
  const directories = new Set();
  for (const { file, bytes, sha256 } of files) {
    if (!isArchiveRelativePath(file)) throw new Error('E_DOMAIN_PENDING_ARCHIVE_INVALID: invalid archive path');
    const staged = path.join(source, ...file.split('/'));
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
    const target = path.join(live, ...file.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, content, { mode: Number(stat.mode & 0o777n) });
      syncFile(temporary);
      fs.renameSync(temporary, target);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch {}
      throw error;
    }
    directories.add(path.dirname(target));
  }
  syncDirectories([...directories], live);
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
