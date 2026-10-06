/**
 * Shared helpers for the release tooling.
 *
 * The release entry points are deliberately dependency-free: they run in a
 * fresh checkout before anything is installed, so they may only use Node's
 * standard library plus the `npm` binary that is already on PATH.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DIST_DIR = path.join(REPO_ROOT, 'dist');
export const RELEASE_DIR = path.join(REPO_ROOT, 'release');

/** Files npm always includes regardless of the `files` allow-list. */
const ALWAYS_INCLUDED = new Set(['package.json', 'README.md', 'LICENSE']);

export function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
}

export function packageFileName(manifest = readManifest()) {
  return `${manifest.name}-${manifest.version}.tgz`;
}

/**
 * The committed pin for the published artifact. It is the authority for what
 * was released, so nothing regenerates it implicitly:
 * `scripts/release/publish-artifact.mjs` writes it and a human reviews it.
 */
export function readReleaseManifest() {
  const file = path.join(RELEASE_DIR, 'manifest.json');
  if (!fs.existsSync(file)) throw new Error(`missing ${path.relative(REPO_ROOT, file)}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function releaseArtifactPath(manifest = readReleaseManifest()) {
  return path.join(RELEASE_DIR, manifest.filename);
}

// ---------------------------------------------------------------------------
// reading an archive without an external `tar`
// ---------------------------------------------------------------------------

function cString(buffer, start, length) {
  let end = start;
  const limit = start + length;
  while (end < limit && buffer[end] !== 0) end += 1;
  return buffer.toString('utf8', start, end);
}

/**
 * Read a gzipped npm tarball into `{ path, mode, bytes }` entries, using only
 * Node's zlib and a minimal ustar reader. This keeps the release verification
 * dependency-free and identical on every platform.
 */
export function readTarEntries(tarball) {
  const tar = zlib.gunzipSync(fs.readFileSync(tarball));
  const entries = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = cString(header, 0, 100);
    const mode = parseInt(cString(header, 100, 8).trim() || '0', 8);
    const size = parseInt(cString(header, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156]);
    const prefix = cString(header, 345, 155);
    const dataStart = offset + 512;
    const isFile = type === '0' || type === '\u0000' || type === '';
    if (isFile) {
      // npm archives everything under a single top-level `package/` directory.
      const raw = prefix ? `${prefix}/${name}` : name;
      const relative = raw.startsWith('package/') ? raw.slice('package/'.length) : raw;
      entries.push({ path: relative, mode: mode & 0o777, bytes: tar.subarray(dataStart, dataStart + size) });
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/**
 * A canonical digest of an archive's *content*: every entry's path, mode and
 * content, in sorted order.
 *
 * This is the reproducible identity of a package. The gzipped bytes are not:
 * `npm pack` compresses through the bundled zlib, so npm 10 (Node 22) and
 * npm 11 (Node 26) produce different bytes for byte-identical content. Verified
 * by unpacking both: identical files, identical uncompressed size, different
 * compressed stream. Content is the part that must not change.
 */
export function contentDigestOf(entries) {
  const hash = crypto.createHash('sha256');
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`${entry.path}\0${entry.mode.toString(8)}\0`);
    hash.update(crypto.createHash('sha256').update(entry.bytes).digest('hex'));
    hash.update('\n');
  }
  return hash.digest('hex');
}

export function archiveContentDigest(tarball) {
  return contentDigestOf(readTarEntries(tarball));
}

export function archiveEntries(tarball) {
  return readTarEntries(tarball).map((entry) => ({ path: entry.path, mode: entry.mode }));
}

/**
 * The same canonical digest, computed directly from the files this tree
 * declares, with the modes the packer would assign. Comparing this with
 * `release/manifest.json#contentSha256` proves the working tree still builds
 * the released content without having to run `npm pack` at all.
 */
export function treeContentDigest() {
  const entries = expectedEntries().map((relative) => {
    const absolute = path.join(REPO_ROOT, relative);
    return { path: relative, mode: canonicalMode(absolute), bytes: fs.readFileSync(absolute) };
  });
  return contentDigestOf(entries);
}

// ---------------------------------------------------------------------------
// packing
// ---------------------------------------------------------------------------

function runNpm(args, options = {}) {
  return execFileSync('npm', args, { cwd: REPO_ROOT, encoding: 'utf8', ...options });
}

/**
 * A file's canonical mode: keep the executable bit, drop everything else.
 *
 * `npm pack` records the mode of the file on disk, so a checkout that happens
 * to carry mode 0600 (a restrictive umask, or a file copied out of another
 * tool) produced a different tarball than a fresh `git clone`, even though git
 * does not track 0600 at all. Normalising to 0644/0755 makes the artifact a
 * function of the tracked content and the tracked executable bit only.
 */
function canonicalMode(file) {
  return (fs.statSync(file).mode & 0o111) ? 0o755 : 0o644;
}

/**
 * Copy exactly the declared archive entries into `destDir` with canonical
 * modes and pack there, so the result never depends on local permissions.
 */
function stageAndPack(destDir) {
  const entries = expectedEntries();
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-evolution-stage-'));
  try {
    for (const entry of entries) {
      const source = path.join(REPO_ROOT, entry);
      if (!fs.existsSync(source)) throw new Error(`a declared file is missing from the tree: ${entry}`);
      const target = path.join(stage, entry);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      fs.chmodSync(target, canonicalMode(source));
    }
    const raw = runNpm(['pack', '--json', '--pack-destination', destDir, '--ignore-scripts'], { cwd: stage });
    const parsed = JSON.parse(raw);
    const info = Array.isArray(parsed) ? parsed[0] : parsed;
    const file = path.join(destDir, info.filename);
    const bytes = fs.readFileSync(file);
    const archived = archiveEntries(file);
    return {
      file,
      filename: info.filename,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      contentSha256: contentDigestOf(readTarEntries(file)),
      entries: archived.map((entry) => entry.path).sort(),
      entryModes: archived.map((entry) => entry.mode),
      bytes: bytes.length,
    };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * Pack the tree once into `destDir` and return the tarball path, its SHA256,
 * the content digest, the ordered entry list and the recorded file modes.
 */
export function packOnce(destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  return stageAndPack(destDir);
}

/**
 * Pack into two throwaway directories and require byte-identical tarballs.
 *
 * Byte identity is required *within one environment* — that is what catches an
 * unstable file list or a filesystem-mode leak. Across environments the
 * guarantee is `contentSha256`, because npm's compression is not stable.
 */
export function assertReproducible() {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-evolution-pack-a-'));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-evolution-pack-b-'));
  try {
    const a = packOnce(first);
    const b = packOnce(second);
    if (a.sha256 !== b.sha256) {
      throw new Error(`packaging is not reproducible in this environment: ${a.sha256} !== ${b.sha256}`);
    }
    if (a.contentSha256 !== b.contentSha256) {
      throw new Error('packaging is not reproducible in this environment: content digests differ');
    }
    if (JSON.stringify(a.entries) !== JSON.stringify(b.entries)) {
      throw new Error('packaging is not reproducible in this environment: file lists differ between runs');
    }
    // The temp directory is removed by the `finally` below, so the caller only
    // gets values that stay valid: never the tarball path itself.
    return {
      filename: a.filename,
      sha256: a.sha256,
      contentSha256: a.contentSha256,
      entries: a.entries,
      entryModes: a.entryModes,
      bytes: a.bytes,
    };
  } finally {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
}

/**
 * The exact, ordered allow-list of archive entries for this manifest: the
 * `files` allow-list plus the entries npm always adds. Nothing else may ship.
 */
export function expectedEntries(manifest = readManifest()) {
  const allowedPrefixes = [];
  const allowedFiles = new Set();
  for (const entry of manifest.files || []) {
    const normalized = entry.replace(/\/+$/, '');
    if (fs.existsSync(path.join(REPO_ROOT, normalized)) && fs.statSync(path.join(REPO_ROOT, normalized)).isDirectory()) {
      allowedPrefixes.push(`${normalized}/`);
    } else {
      allowedFiles.add(normalized);
    }
  }
  for (const name of ALWAYS_INCLUDED) allowedFiles.add(name);

  const walk = (relativeDir) => {
    const out = [];
    for (const dirent of fs.readdirSync(path.join(REPO_ROOT, relativeDir), { withFileTypes: true })) {
      const relative = path.posix.join(relativeDir.split(path.sep).join('/'), dirent.name);
      if (dirent.isDirectory()) out.push(...walk(relative));
      else out.push(relative);
    }
    return out;
  };

  const expected = new Set(allowedFiles);
  for (const prefix of allowedPrefixes) {
    const root = prefix.replace(/\/$/, '');
    for (const file of walk(root)) expected.add(file);
  }
  return [...expected].sort();
}

/** Patterns that must never appear in a published artifact. */
const FORBIDDEN_ENTRY = [
  { pattern: /(^|\/)test(\/|$)/, reason: 'development tests' },
  { pattern: /(^|\/)node_modules(\/|$)/, reason: 'installed dependencies' },
  { pattern: /(^|\/)\.git(\/|$)/, reason: 'git metadata' },
  { pattern: /\.tgz$/, reason: 'packed archive' },
  { pattern: /\.log$/, reason: 'local log' },
  { pattern: /(^|\/)\.env/, reason: 'environment/credential file' },
  { pattern: /(^|\/)\.migration-/, reason: 'local migration scratch' },
  { pattern: /(^|\/)dist(\/|$)/, reason: 'release output' },
  { pattern: /SHA256SUMS$/, reason: 'release output' },
  { pattern: /(^|\/)\.DS_Store$/, reason: 'macOS metadata' },
];

/** Personal/host-dependent text that must never be baked into the bundle. */
const FORBIDDEN_CONTENT = [
  { pattern: /\/Users\/[A-Za-z0-9._-]+/, reason: 'absolute macOS home path' },
  { pattern: /\/home\/[A-Za-z0-9._-]+\//, reason: 'absolute Linux home path' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: 'private key material' },
  { pattern: /\bghp_[A-Za-z0-9]{20,}/, reason: 'GitHub token' },
  { pattern: /\bsk-[A-Za-z0-9]{20,}/, reason: 'API key' },
  { pattern: /@(gmail|outlook|qq|163|126)\.com/i, reason: 'personal email address' },
];

export function assertCleanEntries(entries, expected) {
  const problems = [];
  const expectedSet = new Set(expected);
  for (const entry of entries) {
    for (const { pattern, reason } of FORBIDDEN_ENTRY) {
      if (pattern.test(entry)) problems.push(`${entry}: forbidden (${reason})`);
    }
    if (!expectedSet.has(entry)) problems.push(`${entry}: not in the declared allow-list (package.json "files")`);
  }
  for (const entry of expected) {
    if (!entries.includes(entry)) problems.push(`${entry}: declared in "files" but missing from the archive`);
  }
  if (problems.length > 0) throw new Error(`package contents are not clean:\n  - ${problems.join('\n  - ')}`);
  return entries.length;
}

/**
 * Scan the shipped text for host-dependent content. The archive is a
 * byte-for-byte copy of these files, so reading them from the tree is
 * equivalent and does not depend on a system `tar` with portable flags.
 */
export function assertCleanContent(entries = expectedEntries()) {
  const problems = [];
  for (const entry of entries) {
    const file = path.join(REPO_ROOT, entry);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) continue; // binary payload, nothing to scan
    for (const { pattern, reason } of FORBIDDEN_CONTENT) {
      const match = text.match(pattern);
      if (match) problems.push(`${entry}: ${match[0]}: ${reason}`);
    }
  }
  if (problems.length > 0) throw new Error(`package content is not portable:\n  - ${problems.join('\n  - ')}`);
}

export function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}
