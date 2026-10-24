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

/** A full, lowercase git object name. Short names are ambiguous, so they fail. */
export function isFullSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/**
 * This repository's `package.json`: the package metadata every release entry
 * point reads — `release:pack`, `release:publish`, `pack:check` and the pin
 * checks all decide what to build, what to name it and what to pin from it.
 *
 * It therefore goes through the same duplicate-safe reader as the build manifest
 * and the committed pin (`parseJsonText` below). `JSON.parse` keeps the last
 * value for a repeated key and drops the earlier one, so a hand-edited
 * `package.json` that spelled `"version"` twice would silently pin one of the
 * two — and the version decides the tarball name and the committed pin. The
 * refusal names one fixed label only: no path, no key, no value, no parser
 * message, because a document someone edits by hand is candidate data.
 */
export function readManifest() {
  const file = path.join(REPO_ROOT, 'package.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`package.json cannot be read (${error.code || 'unknown error'})`);
  }
  try {
    return parseJsonText(text);
  } catch (error) {
    // The parser's own message quotes the document. A repeated key is reported
    // by its own label: that manifest is ambiguous, not malformed.
    throw new Error(error instanceof DuplicateJsonKeyError
      ? 'package.json repeats an object key, so which value applies is ambiguous'
      : 'package.json is not readable: invalid JSON');
  }
}

// ---------------------------------------------------------------------------
// reading a JSON document without losing a repeated key
// ---------------------------------------------------------------------------

/**
 * A JSON document that repeats an object key.
 *
 * A distinct class rather than a `SyntaxError`, because the text *is* valid
 * JSON: the document is ambiguous, not malformed, and each caller reports it
 * with its own fixed label.
 */
export class DuplicateJsonKeyError extends Error {
  constructor() {
    // No key name and no fragment: this message is printed to a terminal and
    // pasted into issues, and a repeated key is candidate data like any other.
    super('a JSON object in this document repeats a key');
    this.name = 'DuplicateJsonKeyError';
  }
}

/** How deep the scan below may nest before it gives up. Real release JSON is 2-3. */
const JSON_SCAN_MAX_DEPTH = 256;

const JSON_ESCAPES = new Map([
  ['"', '"'], ['\\', '\\'], ['/', '/'], ['b', '\b'], ['f', '\f'], ['n', '\n'], ['r', '\r'], ['t', '\t'],
]);

/**
 * Reject a JSON text that repeats a key in any object, at any depth.
 *
 * `JSON.parse` keeps the last value for a repeated key and silently discards the
 * earlier ones. That is what let a build manifest carry
 * `"builtWith": {"apiKey": "sk-…"}` immediately before the genuine record: the
 * parsed object held only the second `builtWith`, so every schema check saw an
 * exact toolchain record, while the caller's first object was dropped the moment
 * the file was rewritten. Nothing `JSON.parse` returns can show this, so it is
 * decided on the text.
 *
 * This is a small RFC 8259 walk, not a value parse. It reads enough grammar to
 * tell an object key from a value, decodes `\uXXXX` escapes so that
 * `"\u0062uiltWith"` and `"builtWith"` are the same key, and leaves all values
 * to `JSON.parse`. A word repeated inside a string value, the same key in
 * sibling objects and an array of objects that each use the same key are all
 * fine. Nesting is capped, so a pathological document reports a syntax problem
 * instead of exhausting the stack.
 *
 * Throws `DuplicateJsonKeyError` on a repeat and `SyntaxError` on text this walk
 * cannot read; neither message quotes the document.
 */
export function assertNoDuplicateJsonKeys(text) {
  if (typeof text !== 'string') throw new TypeError('a JSON document has to be a string');
  let index = 0;
  const invalid = () => {
    throw new SyntaxError('the document is not JSON this reader can follow');
  };
  const at = () => text[index];
  const skipWhitespace = () => {
    for (;;) {
      const code = text.charCodeAt(index);
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) index += 1;
      else return;
    }
  };
  /** Read one string token at the opening quote and return its decoded value. */
  const readString = () => {
    index += 1;
    let value = '';
    for (;;) {
      if (index >= text.length) invalid();
      const unit = text.charCodeAt(index);
      if (unit === 0x22) {
        index += 1;
        return value;
      }
      if (unit === 0x5c) {
        const escape = text[index + 1];
        if (escape === 'u') {
          const hex = text.slice(index + 2, index + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) invalid();
          value += String.fromCharCode(Number.parseInt(hex, 16));
          index += 6;
        } else if (JSON_ESCAPES.has(escape)) {
          value += JSON_ESCAPES.get(escape);
          index += 2;
        } else {
          invalid();
        }
        continue;
      }
      value += text[index];
      index += 1;
    }
  };
  const readNumber = () => {
    const start = index;
    while (index < text.length && /[-+.eE0-9]/.test(text[index])) index += 1;
    if (index === start) invalid();
  };
  const parseValue = (depth) => {
    if (depth > JSON_SCAN_MAX_DEPTH) invalid();
    skipWhitespace();
    const character = at();
    if (character === '{') {
      index += 1;
      const keys = new Set();
      skipWhitespace();
      if (at() === '}') {
        index += 1;
        return;
      }
      for (;;) {
        skipWhitespace();
        if (at() !== '"') invalid();
        const key = readString();
        if (keys.has(key)) throw new DuplicateJsonKeyError();
        keys.add(key);
        skipWhitespace();
        if (at() !== ':') invalid();
        index += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (at() === ',') {
          index += 1;
          continue;
        }
        if (at() === '}') {
          index += 1;
          return;
        }
        invalid();
      }
    }
    if (character === '[') {
      index += 1;
      skipWhitespace();
      if (at() === ']') {
        index += 1;
        return;
      }
      for (;;) {
        parseValue(depth + 1);
        skipWhitespace();
        if (at() === ',') {
          index += 1;
          continue;
        }
        if (at() === ']') {
          index += 1;
          return;
        }
        invalid();
      }
    }
    if (character === '"') {
      readString();
      return;
    }
    if (character === '-' || (character >= '0' && character <= '9')) {
      readNumber();
      return;
    }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    invalid();
  };
  parseValue(0);
  skipWhitespace();
  if (index !== text.length) invalid();
}

/**
 * Parse a JSON document, refusing one that repeats an object key.
 *
 * Every entry point that reads a build manifest or a pin uses this instead of
 * `JSON.parse` alone: the parsed value cannot show that a key appeared twice, so
 * the text has to be checked before it is trusted. Throws
 * `DuplicateJsonKeyError` for an ambiguous document and `SyntaxError` for an
 * unreadable one.
 */
export function parseJsonText(text) {
  assertNoDuplicateJsonKeys(text);
  return JSON.parse(text);
}

/**
 * Run `git` in the repository and return its trimmed stdout.
 *
 * Only the release provenance checks use this: the packaging and artifact
 * verification never depend on git, so they run in an unpacked tarball or a
 * shallow checkout just as well as in a full clone.
 */
export function gitOutput(args, cwd = REPO_ROOT) {
  // stdout is the answer; stderr is captured rather than inherited because every
  // caller treats a failure as an expected answer ("this commit is not here")
  // and reports it itself. Without this, probing a shallow clone prints git's own
  // `fatal:` line beside the verdict.
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function packageFileName(manifest = readManifest()) {
  return `${manifest.name}-${manifest.version}.tgz`;
}

/**
 * Why `release/` itself is not usable as the release set's root, or `null`.
 *
 * Every read of the pin and of the pinned artifact goes through this: `release/`
 * has to be a real directory. A symbolic link here is not a cosmetic problem —
 * it makes every path *inside* the release set resolve somewhere else, so a
 * whole foreign directory (its `manifest.json`, its tarball, its `SHA256SUMS`)
 * would be read as this repository's committed release while every name looked
 * right. The message is one fixed label: the link's target is not something a
 * refusal report reprints.
 */
function releaseDirectoryProblem() {
  let stat;
  try {
    stat = fs.lstatSync(RELEASE_DIR);
  } catch (error) {
    return error.code === 'ENOENT' ? 'release/ is missing' : 'release/ cannot be inspected';
  }
  if (stat.isDirectory()) return null;
  return stat.isSymbolicLink() ? 'release/ is a symbolic link, not a real directory' : 'release/ is not a directory';
}

/**
 * The one file name a pin may name: its own npm tarball, inside `release/`.
 *
 * A pin is data — committed, hand-reviewed, and the authority for which file
 * gets verified, published and hashed — so its `filename` is data too. Joining
 * it onto `release/` unchecked let `"filename": "../outside.tgz"` (or an
 * absolute path, or `./manifest.json`) name a file outside the release set:
 * `verify-artifact` then hashed that foreign file and reported success when its
 * bytes happened to match the pin.
 *
 * So the name has to be exactly the single-component tarball name that the
 * pin's own `name` and `version` produce. That is stricter than "one path
 * component": it also rejects a plain name that is inside `release/` but is not
 * this release's artifact, which no reader here has any business reading. The
 * rejected value is never echoed — it is candidate data, and it may spell a
 * path.
 */
export function pinArtifactFileName(pin) {
  const filename = pin === null || typeof pin !== 'object' ? undefined : pin.filename;
  const plain = typeof filename === 'string'
    && filename.length > 0 && filename.length <= 255
    && filename !== '.' && filename !== '..'
    && !filename.includes('/') && !filename.includes('\\')
    && !filename.includes('\u0000')
    && path.basename(filename) === filename;
  const expected = pin !== null && typeof pin === 'object'
    && typeof pin.name === 'string' && pin.name.length > 0
    && typeof pin.version === 'string' && pin.version.length > 0
    ? `${pin.name}-${pin.version}.tgz`
    : null;
  if (!plain || expected === null || filename !== expected) {
    throw new Error('release/manifest.json#filename is not this pin\'s own "<name>-<version>.tgz" file name inside release/');
  }
  return filename;
}

/**
 * The status of one fixed-name file in the release root: `manifest.json`, the
 * pinned tarball's `SHA256SUMS`, and nothing else.
 *
 * `lstat` decides it, never `existsSync` or an open: `release/` must be a real
 * directory and the named file a regular file *in place*. A symbolic link —
 * including a dangling one, which `existsSync` reports as absent — is refused by
 * category, so a file in the release set is either the committed file or
 * nothing. Every message is a fixed label built from the caller's constant name
 * (never from anything inside the file), so a refusal reprints no path, no link
 * target and no content.
 *
 * This is a check *before* the read, not immunity to a concurrent process that
 * replaces the entry between this `lstat` and the caller's `open`. That race is
 * not defended here; the guarantee is that a link sitting there when the check
 * runs is never followed.
 */
export function releaseRootFileStatus(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255 || name === '.' || name === '..'
    || name.includes('/') || name.includes('\\') || name.includes('\u0000') || path.basename(name) !== name) {
    throw new Error('a release-root file name has to be one plain path component');
  }
  const file = path.join(RELEASE_DIR, name);
  const dirProblem = releaseDirectoryProblem();
  if (dirProblem !== null) return { ok: false, missing: false, file, message: dirProblem };
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: false, missing: true, file, message: `missing release/${name}` };
    return { ok: false, missing: false, file, message: `release/${name} cannot be inspected (${error.code || 'unknown error'})` };
  }
  if (stat.isFile()) return { ok: true, missing: false, file };
  return {
    ok: false,
    missing: false,
    file,
    message: stat.isSymbolicLink()
      ? `release/${name} is a symbolic link, not a committed regular file`
      : `release/${name} is not a regular file`,
  };
}

/**
 * The committed pin for the published artifact. It is the authority for what
 * was released, so nothing regenerates it implicitly:
 * `scripts/release/publish-artifact.mjs` writes it and a human reviews it.
 *
 * The file itself is decided by `releaseRootFileStatus()` (a real `release/`
 * directory and a regular `manifest.json` in place, by `lstat`), and only then is
 * the text read and parsed duplicate-safe. A pin that is a link to some other
 * document is not a pin this reader can verify anything from, so it is refused
 * before a byte is opened.
 */
export function readReleaseManifest() {
  const status = releaseRootFileStatus('manifest.json');
  if (!status.ok) throw new Error(status.message);
  let text;
  try {
    text = fs.readFileSync(status.file, 'utf8');
  } catch (error) {
    // `error.message` embeds the path it failed on; only the errno category is
    // reported, so a refusal never reprints a filesystem location.
    throw new Error(`release/manifest.json cannot be read (${error.code || 'unknown error'})`);
  }
  let pin;
  try {
    pin = parseJsonText(text);
  } catch (error) {
    // The parser's own message quotes the document. A repeated key is reported by
    // its own label: that pin is ambiguous, not malformed.
    throw new Error(error instanceof DuplicateJsonKeyError
      ? 'release/manifest.json repeats an object key, so which value applies is ambiguous'
      : 'release/manifest.json is not readable: invalid JSON');
  }
  // A pin whose file name is not its own tarball inside `release/` is not a pin
  // this reader can publish, verify or hash from, so every consumer gets the
  // refusal here rather than a path it might hand to `readFileSync`.
  pinArtifactFileName(pin);
  return pin;
}

/** The pinned source commit, when the pin records one. */
export function pinnedSourceCommit(pin = readReleaseManifest()) {
  return typeof pin.sourceCommit === 'string' ? pin.sourceCommit : null;
}

/**
 * Where the pin's own artifact is: `<repo>/release/<name>-<version>.tgz`.
 *
 * Path arithmetic only, but the two things that make it safe are decided here
 * rather than at each caller: the file name is validated by
 * `pinArtifactFileName()` and the joined path must still have `release/` as its
 * directory (`release/` itself being a real directory). The artifact's own file
 * type is not inspected here: `formatRelation()` needs the path for a name, and
 * `pinnedArtifactStatus()` is the read-side gate.
 */
export function releaseArtifactPath(manifest = readReleaseManifest()) {
  const filename = pinArtifactFileName(manifest);
  const dirProblem = releaseDirectoryProblem();
  if (dirProblem !== null) throw new Error(dirProblem);
  const file = path.join(RELEASE_DIR, filename);
  if (path.dirname(file) !== path.resolve(RELEASE_DIR)) {
    throw new Error('release/manifest.json#filename resolves outside release/');
  }
  return file;
}

/**
 * Whether the pin's artifact is a regular file in `release/` — decided by
 * `lstat`, before anything reads it.
 *
 * `existsSync` follows links, so it answers "is there a file at this path" and
 * not "is this the committed file": a symbolic link to a foreign tarball read
 * as a pinned release whenever it happened to carry the pinned bytes, and a
 * dangling link read as absent. Only a regular file passes; a link (dangling or
 * not), a directory, a device or a FIFO is refused by category.
 *
 * Returns `{ ok, missing, file, message }`; `message` is a fixed label and never
 * a path. Callers that must fail closed use `pinnedArtifactFile()`. As with
 * `releaseRootFileStatus()`, this is a pre-read check: a concurrent process that
 * replaces the artifact between this `lstat` and the read is not defended
 * against, and is not claimed to be.
 */
export function pinnedArtifactStatus(manifest = readReleaseManifest()) {
  const file = releaseArtifactPath(manifest);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: false, missing: true, file };
    return { ok: false, missing: false, file, message: 'cannot be inspected' };
  }
  if (stat.isFile()) return { ok: true, missing: false, file };
  return {
    ok: false,
    missing: false,
    file,
    message: stat.isSymbolicLink() ? 'is a symbolic link, not a regular file' : 'is not a regular file',
  };
}

/**
 * The pin's artifact path, or a refusal: the read-side gate for every archive
 * the release tooling opens *because the pin named it*. A caller that supplies
 * its own candidate path (e.g. `verify-artifact <tarball>`) does not go through
 * this, because that file is the caller's to choose.
 */
export function pinnedArtifactFile(manifest = readReleaseManifest()) {
  const status = pinnedArtifactStatus(manifest);
  if (!status.ok) {
    throw new Error(status.missing
      ? 'the pinned artifact is missing from release/'
      : `the pinned artifact ${status.message}`);
  }
  return status.file;
}

// ---------------------------------------------------------------------------
// reading an archive without an external `tar`
// ---------------------------------------------------------------------------

/**
 * A NUL-terminated header string, read the way tar reads it.
 */
function cString(header, start, length) {
  const field = header.subarray(start, start + length);
  let end = 0;
  while (end < field.length && field[end] !== 0) end += 1;
  return field.toString('utf8', 0, end);
}

/**
 * Require a header string field to be zero after its first NUL.
 *
 * tar reads a header string up to its first NUL and ignores the rest, so the
 * bytes after the terminator are header space nothing unpacks — and nothing in
 * `contentSha256` covers them either. Left unchecked, they are a place to carry
 * arbitrary text (an entry that unpacks to the same path, with a payload after
 * the name's NUL). Both real producers zero-pad every string field; a release
 * archive may only contain that form.
 */
function assertZeroPadded(header, start, length, label, where) {
  const field = header.subarray(start, start + length);
  let end = 0;
  while (end < field.length && field[end] !== 0) end += 1;
  for (let index = end; index < field.length; index += 1) {
    if (field[index] !== 0) {
      throw new Error(`${where}: the ${label} field carries data after its NUL terminator`);
    }
  }
}

/**
 * A numeric tar header field: the POSIX octal form or GNU/POSIX base-256.
 *
 * `npm pack` writes the standard octal form (six digits, then NUL, then space
 * for the checksum; eleven digits and NUL for the size). Base-256 is accepted
 * because a valid tar may encode a large size that way, but anything else — a
 * partially overwritten field, a text value, a negative sign — is an error:
 * guessing a number out of a damaged header is exactly how a tampered archive
 * slips past a reader that only parses fields.
 */
function tarNumber(header, start, length, label, where) {
  const field = header.subarray(start, start + length);
  if (field[0] & 0x80) {
    if (field[0] !== 0x80) {
      throw new Error(`${where}: ${label} uses a base-256 encoding with an unsupported sign byte`);
    }
    let value = 0;
    for (let index = 1; index < field.length; index += 1) {
      value = value * 256 + field[index];
      if (!Number.isSafeInteger(value)) throw new Error(`${where}: ${label} does not fit a safe integer`);
    }
    return value;
  }
  let first = 0;
  let last = field.length;
  // Padding is NUL or space on either side; the digits themselves must be octal.
  while (first < last && (field[first] === 0x00 || field[first] === 0x20)) first += 1;
  while (last > first && (field[last - 1] === 0x00 || field[last - 1] === 0x20)) last -= 1;
  const digits = field.toString('latin1', first, last);
  if (digits === '') return 0;
  if (!/^[0-7]+$/.test(digits)) {
    // Only the field name is reported. The bytes of the field are archive
    // content, and a rejection is printed to a terminal and pasted into issues.
    throw new Error(`${where}: ${label} is neither an octal nor a base-256 number`);
  }
  const value = parseInt(digits, 8);
  if (!Number.isSafeInteger(value)) throw new Error(`${where}: ${label} does not fit a safe integer`);
  return value;
}

/**
 * The tar header's own integrity check: the sum of all 512 header bytes with
 * the checksum field itself read as spaces.
 *
 * Parsing fields without this check accepts headers that no `tar` will unpack —
 * flipping the stored checksum to ASCII `00000000` still leaves a header this
 * reader used to read happily while `tar -tzf` rejected the archive. Since the
 * release tooling treats its own reader as the authority for archive content,
 * the reader has to enforce the same header integrity a real tar does.
 */
function tarHeaderChecksum(header) {
  let sum = 0;
  for (let index = 0; index < header.length; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  return sum;
}

/**
 * Names for the entry types this reader refuses to model, so a rejection says
 * what it found instead of only printing a raw type byte.
 */
const UNMODELLED_TAR_TYPES = new Map([
  ['1', 'hard link'],
  ['2', 'symbolic link'],
  ['3', 'character device'],
  ['4', 'block device'],
  ['5', 'directory'],
  ['6', 'FIFO'],
  ['7', 'contiguous file'],
  ['S', 'GNU sparse file'],
  ['x', 'pax extended header'],
  ['g', 'pax global header'],
  ['L', 'GNU long name'],
  ['K', 'GNU long link name'],
]);

/** The two raw modes a package entry may carry; see `readTarEntries` below. */
const CANONICAL_ARCHIVE_MODES = new Set([0o644, 0o755]);

/**
 * Header metadata `contentSha256` does not cover, and the only values the
 * release accepts for it.
 *
 * `contentDigestOf()` hashes each entry's path, mode and payload. Everything
 * else in a 512-byte header is therefore present in the artifact's bytes but
 * invisible to the content identity, and a candidate could carry arbitrary text
 * there (a user name, a group name, a link target, bytes after a string's NUL)
 * while unpacking to exactly the same content. The pinned `sha256` covers the
 * bytes, but `inspectCandidateBuild` compares *content* with what the tree
 * builds, so the digest alone cannot say whether those bytes are the ones the
 * packer wrote.
 *
 * The canonical values below were measured, not guessed: every entry of all 14
 * committed `release/*.tgz` (across the npm versions that produced them) and a
 * live `npm pack` on this machine carry
 *
 *   uid 0, gid 0, uname ``, gname ``, linkname ``, devmajor 0, devminor 0,
 *   magic/version `ustar\0` + `00`, mtime 499162500 (1985-10-26T08:15:00Z,
 *   node-tar's `portable` timestamp), and zero bytes after every string field
 *   and after the `prefix` field.
 *
 * Anything else fails closed instead of being ignored. None of these fields
 * changes what a file contains, so the digest and every pinned `contentSha256`
 * stay exactly as they are.
 */
const CANONICAL_ARCHIVE_MTIME = 499162500;
const CANONICAL_USTAR_MAGIC = Buffer.from('ustar\u000000', 'latin1');

/**
 * The entry's full path from the two header fields that carry it, as a path
 * relative to the archive's root.
 *
 * `name` and the ustar `prefix` are joined the way tar joins them, and only then
 * validated: an empty, absolute, `.`/`..` or doubled segment is rejected first,
 * so a name cannot reach outside the archive whatever the prefix says. An npm
 * package archive has exactly one top-level `package/` directory — that is what
 * `npm install <tarball>` requires — so every entry must be a file below it.
 * Stripping a `package/` prefix *when present* was enough to make a rootless
 * archive digest-identical to the real one while `npm install` could not find
 * `package.json` in it.
 *
 * `requirePackageRoot: false` is the escape hatch for synthetic fixtures that are
 * not npm packages; every release entry point keeps the default.
 */
function archiveEntryPath(prefix, name, where, requirePackageRoot) {
  const segments = [];
  for (const part of [prefix, name]) {
    if (part === '') continue;
    segments.push(...part.split('/'));
  }
  if (segments.length === 0) throw new Error(`${where}: the entry path is empty`);
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`${where}: the entry path is not a normalised relative path`);
    }
  }
  const underPackage = segments[0] === 'package' && segments.length > 1;
  if (requirePackageRoot && !underPackage) {
    throw new Error(`${where}: the entry path is not a file under the archive's single package/ root`);
  }
  const relative = underPackage ? segments.slice(1) : segments;
  if (relative.length === 0) {
    throw new Error(`${where}: the entry path is not a file under the archive's single package/ root`);
  }
  return relative.join('/');
}

/**
 * Read a gzipped npm tarball into `{ path, mode, bytes }` entries, using only
 * Node's zlib and a minimal ustar reader. This keeps the release verification
 * dependency-free and identical on every platform.
 *
 * Only regular files are modelled, and every other entry type is an error
 * rather than a skip. A skipped entry is invisible to `contentDigestOf`, so an
 * archive that keeps the same regular files and adds or drops a symlink would
 * still produce the pinned `contentSha256`: the digest would no longer identify
 * the artifact's content. `commitContentDigest()` already fails closed the same
 * way for a non-blob or non-0644/0755 git entry, so both sides of the release
 * now reject what they cannot model instead of one of them ignoring it.
 *
 * A directory entry would not change any file's bytes, but skipping it would
 * still drop its existence and its mode from the digest, so it is rejected like
 * the other types rather than quietly allowed. No released artifact needs it:
 * every entry of every committed `release/*.tgz` is a regular file (measured at
 * the rc.14 pin: 555 of 555 entries carry type `0`). Widen this only against an
 * artifact that actually shows the type.
 *
 * Every header's own checksum is verified before its fields are used, so an
 * archive that `tar` refuses cannot be described by this reader either. Fields
 * are parsed strictly (octal or base-256, never a best-effort `parseInt`), and a
 * declared size that runs past the end of the archive is a truncation error
 * rather than a silently short entry.
 *
 * The archive's block *structure* is validated too, because jumping from one
 * header to the next by arithmetic never proved the blocks in between exist.
 * A payload occupies a whole number of 512-byte blocks, the padding that
 * completes the last block must be zero, and a tar ends with two complete
 * all-zero blocks; all three are required. Two counterexamples motivated this:
 * a single 1-byte regular file with a correct header checksum but one byte of
 * payload, no padding and no end blocks, which `tar -tzf` reports as "Truncated
 * input file" while skipping `ceil(size / 512)` blocks from the payload start
 * walked off the end of the buffer and reported a readable entry; and the same
 * archive with a synthetic marker written into its padding, which was accepted
 * and still produced the pinned `contentSha256` while the marker's bytes
 * travelled with the release. A non-zero tail after the end marker is rejected
 * as well: GNU tar pads the last record with more zero blocks, so a non-zero
 * byte there means this reader and `tar` disagree about where the archive
 * stops. This is deliberately stricter than a lenient reader (`bsdtar` accepts
 * a lone zero block and ignores a header after it, because it stops looking):
 * content this reader does not model is not covered by `contentSha256`, so the
 * accepted framing has to be the standard one. Both real producers write
 * exactly that — `npm pack`, and every committed `release/*.tgz`.
 *
 * The entry path is rebuilt from the header's `name` and `prefix` fields and
 * must be a normalised relative path below the archive's single `package/`
 * root (see `archiveEntryPath`); rootless and extra-root archives are refused.
 * Header metadata the content digest does not cover — owner ids and names, the
 * timestamp, device numbers, the link name, the magic, and the bytes after any
 * string field — is held to the canonical values both producers write (see
 * `CANONICAL_ARCHIVE_MTIME`).
 *
 * The raw header mode is validated too, instead of being masked with `& 0o777`.
 * The mask is what let a candidate whose executable entry was rewritten to
 * 04755 (setuid) pass `inspectCandidateBuild`: the digest records only
 * `mode.toString(8)` of the low nine permission bits, so the setuid bit was
 * silently dropped on one side and still applied by `tar` on the other. A
 * release archive therefore carries only the two canonical modes the packer
 * writes — 0644 and 0755 — and anything else (setuid, setgid, sticky, 0600,
 * 0777) is rejected instead of normalised. That is the same contract
 * `commitContentDigest()` already enforces on the git side (`100644`/
 * `100755`), and it is what all 14 committed artifacts contain (measured:
 * 0644 and 0755 only, no high bits).
 *
 * Rejections report the entry's index and byte offset, never its path or any
 * other field content. A path is archive content: it can be the very string a
 * tampered candidate is trying to smuggle into the log, so the message says
 * *where* the bad entry is, not *what* it is called.
 */
export function readTarEntries(source, { requirePackageRoot = true } = {}) {
  const tar = zlib.gunzipSync(Buffer.isBuffer(source) ? source : fs.readFileSync(source));
  const entries = [];
  let offset = 0;
  let index = 0;
  for (;;) {
    // A header needs a whole block, and every entry is followed by the end
    // marker, so running out of blocks here means the archive is short.
    if (offset + 512 > tar.length) {
      throw new Error(`truncated archive: the entry blocks end at byte ${tar.length} without an end-of-archive marker`);
    }
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const where = `tar entry ${index} at byte ${offset}`;
    const name = cString(header, 0, 100);
    const mode = tarNumber(header, 100, 8, 'entry mode', where);
    const uid = tarNumber(header, 108, 8, 'entry uid', where);
    const gid = tarNumber(header, 116, 8, 'entry gid', where);
    const size = tarNumber(header, 124, 12, 'entry size', where);
    const mtime = tarNumber(header, 136, 12, 'entry timestamp', where);
    const type = String.fromCharCode(header[156]);
    const devMajor = tarNumber(header, 329, 8, 'entry device major number', where);
    const devMinor = tarNumber(header, 337, 8, 'entry device minor number', where);
    const prefix = cString(header, 345, 155);
    const dataStart = offset + 512;
    const storedChecksum = tarNumber(header, 148, 8, 'header checksum', where);
    const computedChecksum = tarHeaderChecksum(header);
    if (storedChecksum !== computedChecksum) {
      throw new Error(`${where}: the recorded header checksum does not match the header`);
    }
    // Header metadata the content digest does not cover: only the values both
    // real producers write are accepted (see CANONICAL_ARCHIVE_MTIME).
    if (uid !== 0 || gid !== 0) {
      throw new Error(`${where}: the entry owner ids are not the canonical zero`);
    }
    if (mtime !== CANONICAL_ARCHIVE_MTIME) {
      throw new Error(`${where}: the entry timestamp is not the canonical packaging timestamp`);
    }
    if (devMajor !== 0 || devMinor !== 0) {
      throw new Error(`${where}: the entry device numbers are not the canonical zero`);
    }
    if (!header.subarray(257, 265).equals(CANONICAL_USTAR_MAGIC)) {
      throw new Error(`${where}: the header magic and version are not the canonical ustar form`);
    }
    if (!header.subarray(500, 512).every((byte) => byte === 0)) {
      throw new Error(`${where}: the header padding after the name prefix is not zero`);
    }
    assertZeroPadded(header, 0, 100, 'name', where);
    assertZeroPadded(header, 345, 155, 'name prefix', where);
    assertZeroPadded(header, 265, 32, 'user name', where);
    assertZeroPadded(header, 297, 32, 'group name', where);
    if (cString(header, 265, 32) !== '' || cString(header, 297, 32) !== '') {
      throw new Error(`${where}: the entry owner names are not empty`);
    }
    if (dataStart + size > tar.length) {
      throw new Error(`truncated archive: ${where} declares ${size} bytes but only ${tar.length - dataStart} remain`);
    }
    const isFile = type === '0' || type === '\u0000' || type === '';
    if (!isFile) {
      const label = UNMODELLED_TAR_TYPES.get(type);
      throw new Error(`${where}: unsupported entry type${label ? ` (${label})` : ''}`);
    }
    // Only a regular file can be a package entry, and a regular file has no
    // link target: the field is header space `contentSha256` would not cover.
    assertZeroPadded(header, 157, 100, 'link name', where);
    if (cString(header, 157, 100) !== '') {
      throw new Error(`${where}: the entry link name is not empty`);
    }
    if (!CANONICAL_ARCHIVE_MODES.has(mode)) {
      throw new Error(`${where}: the entry mode is not one of the canonical release modes (0o644, 0o755)`);
    }
    const relative = archiveEntryPath(prefix, name, where, requirePackageRoot);
    // The payload occupies whole blocks, so the padding that completes the last
    // one has to be present. Skipping ahead by arithmetic is what accepted the
    // review's 513-byte archive: the entry's bytes were there, the block that
    // carries them was not.
    const blocks = Math.ceil(size / 512);
    const padded = dataStart + blocks * 512;
    if (padded > tar.length) {
      throw new Error(
        `truncated archive: ${where} declares ${size} bytes, whose ${blocks} 512-byte payload block(s) end at byte ${padded}, `
        + `but the archive ends at byte ${tar.length}`,
      );
    }
    // The bytes that complete the last payload block are not part of the
    // entry, so `contentSha256` never sees them. Zero padding is the only
    // content a release archive may put there; anything else is data no unpacker
    // reports and no digest covers.
    if (!tar.subarray(dataStart + size, padded).every((byte) => byte === 0)) {
      throw new Error(`${where}: the padding after the entry's payload is not zero`);
    }
    entries.push({ path: relative, mode, bytes: tar.subarray(dataStart, dataStart + size) });
    offset = padded;
    index += 1;
  }

  // Two complete zero blocks close a tar. More zero blocks are allowed (the
  // last record is padded to the blocking factor), non-zero bytes are not: they
  // are an entry this reader did not see, so the digest would not cover them.
  const endMarker = tar.subarray(offset);
  if (endMarker.length < 2 * 512) {
    throw new Error(
      `truncated archive: the end-of-archive marker at byte ${offset} is ${endMarker.length} bytes, `
      + 'but a tar ends with two complete 512-byte zero blocks',
    );
  }
  if (!endMarker.every((byte) => byte === 0)) {
    throw new Error(`unexpected data after the end-of-archive marker at byte ${offset}: the archive must end with zero blocks`);
  }
  if (endMarker.length % 512 !== 0) {
    throw new Error(`truncated archive: the archive ends with a partial ${endMarker.length % 512}-byte block after byte ${offset}`);
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
export function treeArchiveEntries() {
  return expectedEntries().map((relative) => {
    const absolute = path.join(REPO_ROOT, relative);
    return { path: relative, mode: canonicalMode(absolute), bytes: fs.readFileSync(absolute) };
  });
}

export function treeContentDigest() {
  return contentDigestOf(treeArchiveEntries());
}

/**
 * Digest the shipped files from git objects, independent of the working tree.
 *
 * The committed `package.json` is read with the same duplicate-safe reader as the
 * working tree's (`parseJsonText`), because its `files` allow-list decides which
 * blobs this digest covers. A commit whose manifest spelled `"files"` twice has
 * two answers; `JSON.parse` keeps the last one and returns a digest for a package
 * nobody committed (with `"\u0066iles"` it would not even look ambiguous on a
 * text comparison). Either way this fails closed: no digest, one fixed label, and
 * never the document, its keys or the parser's message.
 */
export function commitContentDigest(commit, cwd = REPO_ROOT) {
  // stderr is captured, not inherited: a caller that probes a commit which is not
  // in this checkout treats the failure as an answer and reports it itself.
  const gitBytes = (args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const text = gitBytes(['show', `${commit}:package.json`]).toString('utf8');
  let manifest;
  try {
    manifest = parseJsonText(text);
  } catch (error) {
    throw new Error(error instanceof DuplicateJsonKeyError
      ? 'the committed package.json repeats an object key, so which value applies is ambiguous'
      : 'the committed package.json is not readable: invalid JSON');
  }
  const declared = (manifest.files || []).map((entry) => entry.replace(/\/+$/, ''));
  const records = gitBytes(['ls-tree', '-rz', '--full-tree', commit]).toString('utf8').split('\0').filter(Boolean);
  const entries = [];
  for (const record of records) {
    const tab = record.indexOf('\t');
    const [mode, type, object] = record.slice(0, tab).split(' ');
    const relative = record.slice(tab + 1);
    if (!ALWAYS_INCLUDED.has(relative) && !declared.some((entry) => relative === entry || relative.startsWith(`${entry}/`))) continue;
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new Error(`unsupported shipped git entry: ${relative} (${mode} ${type})`);
    entries.push({ path: relative, mode: mode === '100755' ? 0o755 : 0o644, bytes: gitBytes(['cat-file', 'blob', object]) });
  }
  return contentDigestOf(entries);
}

// ---------------------------------------------------------------------------
// the recorded toolchain
// ---------------------------------------------------------------------------

/**
 * The only keys a `builtWith` record may carry.
 *
 * `release:pack` writes them, `release:publish` copies the record verbatim into
 * the pin, and `pack:check`/`verify-provenance` report it. Because it is copied
 * rather than re-derived, an accepted record is published metadata: a build
 * manifest that also carried `apiKey: "sk-..."` would be copied into
 * `release/manifest.json` and committed. The schema is therefore exact — these
 * three keys, no others — not "at least these fields".
 */
export const BUILT_WITH_FIELDS = ['node', 'npm', 'platform'];

/**
 * The exact top-level fields `release:pack` writes into a build manifest, in the
 * order it writes them.
 *
 * Like `builtWith`, this is a closed schema rather than a minimum: the packer
 * re-reads an existing output to decide whether it may replace it, and
 * `release:publish` reads the same file before anything is pinned. A manifest
 * that carries a property this list does not name was not written by this tool
 * (a user note, a scratch key, a pasted secret), so it is refused instead of
 * being overwritten — and instead of any of it reaching the committed pin.
 */
export const BUILD_MANIFEST_FIELDS = [
  'name', 'version', 'filename', 'sha256', 'contentSha256', 'entries', 'modes', 'builtWith',
];

/**
 * Bounded shapes for each field. `npm pack` records `v26.12.0`, `11.20.0` and
 * `darwin-arm64`; no released pin carries a pre-release suffix, so the suffix
 * grammar below is the narrow set of public tags a Node or npm build actually
 * publishes. Every bound here is also a bound on what can end up in the
 * committed pin.
 *
 * `platform` is not a free-form token: it is `${process.platform}-${process.arch}`
 * as Node spells them, so it is validated against the two documented
 * enumerations below. The bound has to be a shape no credential matches —
 * `sk-test-secret-do-not-publish` used to satisfy the old character-set pattern
 * and would have been copied verbatim into `release/manifest.json`.
 *
 * The version suffix is where the same problem came back: a character-set
 * pattern (24 characters of `[0-9A-Za-z.-]`, then one to ten lowercase letters
 * plus digits) is exactly the shape of a credential-shaped label, so
 * `v26.12.0-secrettok` or `11.20.0-sklive` was accepted and `release:publish`
 * copied it verbatim into the committed pin. A shape pattern cannot answer
 * "is this a version Node or npm publishes", so the suffix is now an
 * **allow-list of measured tags** rather than a character class
 * (`PRERELEASE_TAGS` below). An identifier is one of those tag words — with an
 * optional bounded numeric counter (`rc1`) — or a bare number (`rc.1`), and a
 * suffix is up to three of them joined by dots.
 *
 * A word neither registry has ever published cannot be admitted by
 * construction, whatever it spells. One real shape still fails closed, on
 * purpose: a pre-1.0 npm tag with a hyphen inside one identifier (`alpha-0`,
 * published in 2010), which this grammar spells as two identifiers. That tag is
 * out of scope for a toolchain field; a nightly build is not.
 *
 * A Node nightly is a real `process.version` a release can be built with, so it
 * is admitted as its own exact alternative (`NODE_NIGHTLY` below) — and *only*
 * as that whole suffix. The tag word `nightly` is deliberately absent from the
 * node identifier allow-list: as a generic identifier it spelled three values
 * the nightly index never published — `-nightly`, `-nightly20261023` (the build
 * date with the commit left off) and `-nightly20261023.rc1` (a build stamp
 * joined to another identifier). The admitted shape is the tag word, the
 * eight-digit build date and the commit — ten lowercase hex characters, or the
 * full 40-character object name — with nothing before, between or after them.
 * Measured against nodejs.org/download/nightly/index.json (370 entries, read on
 * 2026-10-23): every entry is `-nightly<YYYYMMDD><hex>`; 369 carry a
 * ten-character commit (the newest is `v27.0.0-nightly202610236d4646731e`) and
 * one 2023 entry carries the full object name. Both are admitted because both
 * are published shapes; no other commit length is, and a nightly suffix is one
 * build stamp, not an identifier list.
 *
 * `BUILT_WITH_MAX_LENGTH` is therefore the longest value these grammars can
 * spell (`v999.999.999-nightly20261023` plus a 40-character commit), not a
 * smaller number a real shape trips over: the pattern decides the shape, this cap
 * only stops a future edit from admitting something unbounded, and no admitted
 * shape is ever rejected for length.
 *
 * The platform sets are Node's documented values, not this process's: a build on
 * any supported OS/architecture must be pinnable from here, so `linux-ppc64` or
 * `win32-arm64` are as acceptable as `darwin-arm64`. Any combination the
 * platform/architecture lists admit is allowed; neither field has to match the
 * machine running `release:publish`. The pre-release tags are per field for the
 * same reason: admitting `beta` in `builtWith.node` would admit a value no Node
 * build publishes.
 */
const PRERELEASE_TAGS = new Map([
  // nodejs.org/download/rc/index.json: 277 entries, identifiers rc.0 – rc.6.
  // The nightly tag word is not an identifier here: a nightly is only the whole
  // build stamp `NODE_NIGHTLY` below, so `-nightly`, `-nightly20261023` and
  // `-nightly20261023.rc1` cannot be spelled at all.
  ['node', ['rc']],
  // The npm registry's version list: alpha, beta, next, pre and rc, each with a
  // numeric counter (alpha.7, beta.13, next.3, pre.6, rc.4).
  ['npm', ['alpha', 'beta', 'next', 'pre', 'rc']],
]);

/**
 * One Node nightly build stamp: tag word, eight-digit date, then the commit —
 * either the ten-character short name or the full 40-character object name.
 *
 * Those are the only two commit lengths the nightly index has ever published.
 * The whole suffix is this alternative, so a nightly cannot be shortened to the
 * tag word or the date, joined with another identifier (`-nightly20261023.rc1`)
 * or given a suffix (`-nightly202610236d4646731e.sklive`): none of those is a
 * build stamp.
 */
const NODE_NIGHTLY = 'nightly[0-9]{8}(?:[0-9a-f]{10}|[0-9a-f]{40})';

/**
 * The optional pre-release suffix: either one exact nightly stamp, or up to three
 * `-<identifier>` parts joined by dots.
 */
function prereleaseSuffix(tags, standalone = []) {
  const identifier = `(?:(?:${tags.join('|')})[0-9]{0,8}|[0-9]{1,8})`;
  const alternatives = standalone.map((shape) => `-${shape}`);
  alternatives.push(`-${identifier}(?:\\.${identifier}){0,2}`);
  return `(?:${alternatives.join('|')})?`;
}

const BUILT_WITH_PATTERNS = new Map([
  ['node', new RegExp(`^v\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}${prereleaseSuffix(PRERELEASE_TAGS.get('node'), [NODE_NIGHTLY])}$`)],
  ['npm', new RegExp(`^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}${prereleaseSuffix(PRERELEASE_TAGS.get('npm'))}$`)],
]);

/** Node's documented `process.platform` values. */
const BUILT_WITH_PLATFORMS = new Set([
  'aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32',
]);

/** Node's documented `process.arch` values. */
const BUILT_WITH_ARCHITECTURES = new Set([
  'arm', 'arm64', 'ia32', 'loong64', 'mips', 'mipsel', 'ppc', 'ppc64', 'riscv64', 's390', 's390x', 'x64',
]);

/** `os-arch` as `${process.platform}-${process.arch}` spells it. */
const HOST_PAIR = /^([a-z][a-z0-9]*)-([a-z0-9]+)$/;

/**
 * The longest value the two grammars can spell, as a second, independent bound.
 *
 * `v999.999.999-nightly20261023` plus a 40-character commit is 68 characters, and
 * `999.999.999-alpha99999999.alpha99999999.alpha99999999` is 53; nothing a build
 * reports comes close. The cap exists so a future edit cannot make the field
 * unbounded; it never rejects a value the patterns admit.
 */
const BUILT_WITH_MAX_LENGTH = 68;

/**
 * Name the *kind* of an unexpected value, never the value itself.
 *
 * A rejected build manifest may carry anything in an unexpected spot, and a
 * rejection message is printed to a terminal and pasted into issues. Not
 * echoing `JSON.stringify(record)` was not enough: this helper used to quote a
 * rejected string back (truncated to 40 characters), so
 * `builtWith: { node: "sk-..." }` put the value itself in the error. The
 * message now reports the field name and the kind only, which is all a reader
 * needs to fix the manifest — and nothing of a value that was pasted into it by
 * mistake can reach a log.
 */
function describeValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (value === undefined) return 'undefined';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

/**
 * Problems with a `builtWith` record; empty means it is exactly a toolchain
 * record of this build. Used by both the packer (when it refuses to overwrite an
 * existing output) and the publisher (before anything is written), so the two
 * cannot drift into accepting different records.
 */
export function builtWithProblems(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return [`builtWith is not a {${BUILT_WITH_FIELDS.join(',')}} toolchain record: ${describeValue(record)}`];
  }
  const problems = [];
  const extra = Object.keys(record).filter((key) => !BUILT_WITH_FIELDS.includes(key));
  if (extra.length > 0) {
    // Only the count is reported. The keys are candidate data too — a manifest
    // can name a property after the secret it carries — so the message states
    // which schema applies and how far the record is outside it, and the
    // rejected names stay out of the log like the rejected values.
    problems.push(`builtWith carries ${extra.length} unexpected ${extra.length === 1 ? 'property' : 'properties'}; only ${BUILT_WITH_FIELDS.join(', ')} may be recorded`);
  }
  for (const field of BUILT_WITH_FIELDS) {
    const value = record[field];
    if (typeof value !== 'string') {
      problems.push(`builtWith.${field} is not a string: ${describeValue(value)}`);
      continue;
    }
    if (value.length > BUILT_WITH_MAX_LENGTH) {
      problems.push(`builtWith.${field} is ${value.length} characters, longer than the ${BUILT_WITH_MAX_LENGTH}-character limit`);
      continue;
    }
    if (field === 'platform') {
      const pair = HOST_PAIR.exec(value);
      if (pair === null || !BUILT_WITH_PLATFORMS.has(pair[1]) || !BUILT_WITH_ARCHITECTURES.has(pair[2])) {
        problems.push('builtWith.platform is not a Node platform-architecture pair: a string');
      }
      continue;
    }
    if (!BUILT_WITH_PATTERNS.get(field).test(value)) {
      const expected = `a ${field === 'node' ? 'Node' : 'npm'} version`;
      problems.push(`builtWith.${field} is not ${expected}: ${describeValue(value)}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// installing files into a directory the caller also owns
// ---------------------------------------------------------------------------

/**
 * Require the directory that will receive `target` to still be a real directory.
 *
 * `lstat`, deliberately: a symbolic link to a directory has to be refused by
 * category rather than followed, because following it puts the staged bytes and
 * the renamed targets outside the tree the caller proved it owns. A directory
 * that is simply gone is reported as such instead of failing later on a staging
 * name whose parent does not exist.
 *
 * The message is one fixed label: the directory is derived from the target,
 * which with `--dist`/`--from` is a caller-supplied path.
 */
function assertRealTargetDirectory(target) {
  let stat;
  try {
    stat = fs.lstatSync(path.dirname(target));
  } catch (error) {
    throw new Error(`refusing to install: the target directory cannot be inspected (${error.code || 'unknown error'})`);
  }
  if (stat.isDirectory()) return;
  throw new Error(`refusing to install: the target directory is no longer a real directory (${stat.isSymbolicLink() ? 'a symbolic link' : 'not a directory'})`);
}

/**
 * Install a set of files through exclusively created staging names in the
 * destination directory.
 *
 * Two properties matter, and both used to be missing when a caller installed its
 * three output files one at a time:
 *
 *   - Nothing is written under a final name before every byte exists next to it,
 *     so a failure while writing (the realistic one: a full disk) leaves the
 *     previous files untouched instead of replacing the first two and then
 *     stopping.
 *   - A staging name is opened with `wx` (O_CREAT|O_EXCL), which never reuses an
 *     existing file and never follows an existing symlink, so a collision fails
 *     closed and the caller's entry is preserved. Only staging names this call
 *     created are ever removed.
 *
 * What is left per file is a `rename` of a directory entry, and the caller's
 * order is kept. A rename cannot fail for lack of space, but it can still fail
 * on a permission or directory change between two of them; that is the narrow
 * window in which a partial set exists, and it is reported as exactly that (see
 * below) rather than as a bare errno, so it is never read as "nothing was
 * written".
 *
 * The directory that receives each target is re-checked immediately before the
 * first staging file is created (see `assertRealTargetDirectory`). Every caller
 * decides that earlier — `assertUsableDist()` before packing, and
 * `inspectPinWriteTargets()` before the candidate is even unpacked — and then
 * spends seconds hashing and verifying. Without the re-check, a destination
 * directory replaced by a symbolic link in that window takes every staged name
 * and every rename with it. What remains is the interval between that `lstat`
 * and the staging `open`: this is a correctness check, not a security sandbox,
 * and a local process racing this tool can always swap a directory entry.
 *
 * `temporaryNameOf(target)` names the staging file for a target; it is
 * injectable so a test can force a deterministic failure.
 */
export function installFileSet(entries, temporaryNameOf, { mode = 0o666 } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('installFileSet requires at least one file to install');
  if (typeof temporaryNameOf !== 'function') throw new Error('installFileSet requires a function that names the staging file');
  for (const { target, contents } of entries) {
    if (typeof target !== 'string' || !target) throw new Error('installFileSet requires a target path for every file');
    if (contents === undefined || contents === null) throw new Error('installFileSet requires contents for every file');
  }
  // Every destination is identified before anything is written, so a directory
  // swapped for a link since the caller's own check fails closed with no bytes
  // staged and no target touched.
  for (const { target } of entries) assertRealTargetDirectory(target);
  const pending = [];
  try {
    for (const { target, contents } of entries) {
      const temporary = temporaryNameOf(target);
      let descriptor;
      try {
        descriptor = fs.openSync(temporary, 'wx', mode);
      } catch (error) {
        // Only `EEXIST` says the name was taken. Asserting that for every errno
        // was a false cause: an unwritable or vanished directory, an exhausted
        // descriptor table or a full disk all landed on "the staging name is
        // already taken", sending a reader to look for a file that is not
        // there. The target's own path is not reported — with `--dist`/`--from`
        // it is a caller-supplied path — so the label names the part and the
        // errno category only.
        const code = error.code || 'unknown error';
        throw new Error(code === 'EEXIST'
          ? `refusing to replace the target: the staging name is already taken (${code})`
          : `refusing to replace the target: the staging file cannot be created (${code})`);
      }
      // The exclusive open proved this staging file is ours, so it may be removed
      // again by the cleanup below.
      pending.push({ target, temporary });
      try {
        fs.writeFileSync(descriptor, contents);
      } finally {
        fs.closeSync(descriptor);
      }
    }
    let installed = 0;
    try {
      while (pending.length > 0) {
        fs.renameSync(pending[0].temporary, pending[0].target);
        pending.shift();
        installed += 1;
      }
    } catch (error) {
      // Every byte was staged, so this is the only failure that can leave a
      // partial set: the renames before it already replaced their targets and
      // cannot be undone. Report that state instead of only the errno category —
      // that category is printed for a failure before any rename too, and the
      // two outcomes need different handling (inspect the set versus retry).
      const code = error !== null && typeof error === 'object' && typeof error.code === 'string'
        ? error.code
        : 'unknown error';
      throw new Error(installed === 0
        ? `installing the file set failed before any target was replaced (${code})`
        : `installing the file set failed after ${installed} of ${entries.length} target(s) were replaced (${code}): the set is partial, so inspect it before retrying`);
    }
  } finally {
    for (const { temporary } of pending) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch { /* the failure that got us here is the one to report */ }
    }
  }
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
