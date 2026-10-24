#!/usr/bin/env node
/**
 * Build a local release build into ./dist:
 *
 *   dsh-evolution-<version>.tgz   the packed bundle
 *   manifest.json                 what this build contains and which bytes it has
 *   SHA256SUMS                    the checksum of that exact tarball
 *
 * The pack is verified before it is written: the tree is packed twice and the
 * two tarballs must be byte-identical *in this environment*, the archive can
 * contain only the entries declared by `package.json#files` (plus the
 * always-included manifest files), and the shipped text must not mention a
 * local home directory or carry credential-shaped material.
 *
 * This does not publish anything and does not touch the committed pin in
 * `release/`. A build made with a different npm version has the same
 * `contentSha256` but different compressed bytes, so publishing is an explicit
 * second step: `npm run release:publish`.
 *
 * ## The output directory is shared with the caller
 *
 * `--dist` may point at a directory that already holds unrelated files (a
 * scratch directory, a CI workspace, a developer's `~/Downloads`). Earlier
 * versions removed that directory recursively before writing, which silently
 * deleted whatever else lived there; `--dist .` or `--dist release` destroyed
 * the repository or the committed pin. This script therefore never removes a
 * directory, and it only ever touches the three files named above:
 *
 *   1. Everything is built and verified in a private `mkdtemp` directory first,
 *      so a packing or metadata failure leaves the existing output untouched.
 *   2. `--dist` is refused when it is the repository, anything inside `release/`,
 *      a container of the repository, or any in-repo path outside the default
 *      `dist/` (a build output belongs in neither lib/, test/, docs/ nor a
 *      tracked source tree); an existing path must be a real directory, so a
 *      file or a symbolic link is refused rather than followed.
 *   3. A target name is replaced only when the directory holds a complete output
 *      of *this* build: `manifest.json` holds exactly the fields the writer emits
 *      (an extra top-level field is the caller's data and is refused, not
 *      dropped) and names this version's tarball, that tarball is a regular file
 *      whose sha256, content digest, entry count and canonical modes all match
 *      the recorded values, and `SHA256SUMS` reproduces exactly that line.
 *      Re-running over the same output is defined: same content, same files, no
 *      growth. Every rejection names a fixed label (`manifest.json`, `SHA256SUMS`,
 *      the build tarball) and never the caller's `--dist` path.
 *   4. The three files are installed as one set: every byte is staged next to its
 *      destination first and only then renamed into place, so a failure while
 *      writing (a full disk) leaves the previous output byte-identical instead
 *      of replacing the first files and stopping. A failure in the narrow
 *      rename-only window can still leave a mixed set, which the next run
 *      refuses by name rather than teaching itself to accept it.
 *   5. Every other pre-existing entry under a target name — a lone tarball, a
 *      foreign or damaged `manifest.json`, a corrupted tarball, a half-deleted
 *      set, a build of another version, a symbolic link (dangling or not), a
 *      special file — is a hard failure that names it and leaves the directory
 *      as it was. Nothing is guessed, merged or repaired; use a fresh `--dist`.
 *
 * Other files are never read, scanned or removed, so an unrelated file — even the
 * output of an older build — can stay there.
 *
 * Presence is decided with `lstat`, never `exists`/`stat`: a dangling symbolic
 * link at a target name is *there*, and renaming over it would destroy the
 * caller's link, so it is refused like any other non-regular entry. A name
 * recorded in an existing `manifest.json` has to be one plain path component, so
 * a manifest that records a `../` escape is rejected before it is read through.
 *
 * Usage: node scripts/release/pack.mjs [--dist <dir>]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  BUILD_MANIFEST_FIELDS, DIST_DIR, DuplicateJsonKeyError, RELEASE_DIR, REPO_ROOT, assertCleanContent,
  assertCleanEntries, assertReproducible, builtWithProblems, contentDigestOf, expectedEntries, formatBytes,
  installFileSet, packageFileName, packOnce, parseJsonText, readManifest, readTarEntries,
} from './release-lib.mjs';

const BUILD_MANIFEST = 'manifest.json';
const CHECKSUM_FILE = 'SHA256SUMS';
/** How the tarball is named in a rejection, instead of by its caller-chosen path. */
const TARBALL_LABEL = 'the build tarball';
/** A version string this packer could have written (`0.2.0-rc.17`). */
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;
/** The mode spelling a build manifest records: `0o644`. */
const SAFE_MODE = /^0o[0-7]{1,4}$/;

function parseArgs(argv) {
  const options = { dist: DIST_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--dist') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error('--dist requires a value');
      options.dist = path.resolve(next);
      index += 1;
    } else if (argv[index] === '--help' || argv[index] === '-h') {
      console.log('node scripts/release/pack.mjs [--dist <dir>]');
      process.exit(0);
    } else {
      // The rejected token is not printed: an argument value can be a path a
      // caller supplied, and a rejection is printed to a terminal and pasted
      // into issues.
      throw new Error('unknown argument; usage: node scripts/release/pack.mjs [--dist <dir>]');
    }
  }
  return options;
}

/** `target` with every symbolic link in the part that exists resolved. */
function canonicalPath(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.join(canonicalPath(path.dirname(target)), path.basename(target));
  }
}

/**
 * True when `child` is `parent` or lives below it.
 *
 * "Above" is exactly the `..` segment and a relative path that starts with
 * `../`; a name that merely begins with two dots is an ordinary directory name
 * *inside* `parent`. Comparing `startsWith('..')` collapsed the two, so a path
 * like `<repo>/release/..scratch` was read as being outside `release/` and
 * skipped the refusal it has to hit — the containment checks below are the only
 * thing keeping a build out of the committed pin.
 */
function isInside(child, parent) {
  const relative = path.relative(parent, child);
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/**
 * What is at `file`, without following a symbolic link and without reporting a
 * dangling link as absent: `absent | file | directory | symlink | special`.
 */
function classifyEntry(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return 'absent';
    // Every other filesystem exception carries the inspected path in its own
    // message (`ENOTDIR: not a directory, lstat '/…/sentinel/output'`), and with
    // `--dist` that path is the caller's. Only the errno category is reported.
    throw new Error(`refusing to inspect an output entry: the filesystem reported ${error.code || 'an unknown error'}`);
  }
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  return 'special';
}

/**
 * A name this script may install under: exactly one plain path component, so it
 * cannot leave the output directory. `path.basename` alone does not cover a
 * Windows separator, hence the explicit check.
 */
function isSafeFileName(value) {
  return typeof value === 'string'
    && value.length > 0 && value.length <= 255
    && value !== '.' && value !== '..'
    && value === path.basename(value)
    && !value.includes('\\')
    && !value.includes('\u0000');
}

/**
 * Resolve a release:pack target name inside `distDir`. Everything this script
 * reads, replaces or deletes goes through here. Exported for the same reason as
 * `assertUsableDist`: the escape check is cheap to call directly.
 */
export function targetPath(distDir, name) {
  if (!isSafeFileName(name)) {
    // Neither the name nor the directory is echoed: both can be caller input.
    throw new Error('refusing to touch a target name that is not a plain file name: it may resolve outside the output directory');
  }
  const file = path.join(distDir, name);
  if (path.dirname(file) !== path.resolve(distDir)) {
    throw new Error('refusing to touch a target name that resolves outside the output directory');
  }
  return file;
}

/**
 * Refuse an output directory whose contents are not ours to share: the
 * repository, the committed pin, a container of them, or any in-repo path except
 * the default `dist/`.
 *
 * The checks run on canonical paths, so `--dist ./release`, `--dist
 * <repo>/release/tmp` and `--dist <symlink-to-repo>` are refused like the direct
 * spellings. The in-repo allow-list is resolved from `defaultDistDir` only while
 * that is a real directory (or absent): a `dist/` that a user or a mistake
 * replaced with a symlink would otherwise turn its target — lib/, the pin — into
 * the allowed build root.
 *
 * Exported because this check must be testable without invoking the script: a
 * regression here would be destructive, so the tests call it directly instead of
 * running the CLI against a real repository path. `paths` lets a test build a
 * throwaway repository in `os.tmpdir()`; the CLI always uses the defaults.
 */
export function assertUsableDist(distDir, paths = {}) {
  const repo = canonicalPath(paths.repoRoot ?? REPO_ROOT);
  const release = canonicalPath(paths.releaseDir ?? RELEASE_DIR);
  const defaultDistDir = paths.defaultDistDir ?? DIST_DIR;
  const dist = canonicalPath(distDir);
  if (dist === repo) {
    throw new Error('refusing to build into the given output directory: it is the repository root, so pass a dedicated --dist directory');
  }
  if (isInside(dist, release)) {
    throw new Error('refusing to build into the given output directory: it is inside release/, which only "npm run release:publish" may change');
  }
  if (isInside(repo, dist)) {
    throw new Error('refusing to build into the given output directory: it contains the repository, so it is not a build output directory');
  }
  // Inside the repository only the default output directory may be written: any
  // other in-repo path (lib/, test/, docs/, scripts/) holds tracked sources, and
  // a build output there would land in the package or the tests.
  if (isInside(dist, repo)) {
    const buildRoot = admissibleBuildRoot(defaultDistDir);
    if (buildRoot === null || !isInside(dist, buildRoot)) {
      throw new Error('refusing to build into the given output directory: it is inside the repository but the only in-repo output directory is the default dist/ (while that is a real directory). Use the default dist/ or a directory outside the repository');
    }
  }
  const kind = classifyEntry(distDir);
  if (kind === 'symlink') {
    throw new Error('refusing to build into the given output directory: it is a symbolic link, and its target is not this script\'s to overwrite');
  }
  if (kind !== 'absent' && kind !== 'directory') {
    throw new Error('refusing to build into the given output directory: it exists and is not a directory');
  }
}

/**
 * The canonical default output directory, or `null` when no in-repo path is
 * admissible because that directory is not a real one (a symlinked `dist/` must
 * never promote its target to the allowed build root).
 */
function admissibleBuildRoot(defaultDistDir) {
  const kind = classifyEntry(defaultDistDir);
  if (kind === 'symlink' || kind === 'file' || kind === 'special') return null;
  return canonicalPath(defaultDistDir);
}

/**
 * Read one of this tool's own files out of the output directory.
 *
 * The path is derived from `--dist`, so an I/O failure is reported by code only:
 * `Error.message` embeds the absolute path, and this message is printed to a
 * terminal and pasted into issues.
 */
function readOutputFile(file) {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    throw new Error(`refusing to overwrite a release:pack output: it cannot be read (${error.code || 'unknown error'})`);
  }
}

/** The byte hash of bytes that were read once. */
function sha256Of(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * The content of `bytes` as a tarball, or `null` when they cannot be read as one,
 * so a corrupted file is reported as "not the recorded build" instead of a bare
 * zlib error.
 */
function readEntriesOrNull(bytes) {
  try {
    return readTarEntries(bytes);
  } catch {
    return null;
  }
}

/** The `0o<octal>` mode set a build manifest records for a set of entries. */
const canonicalModes = (entries) => [...new Set(entries.map((entry) => `0o${entry.mode.toString(8)}`))].sort();

function isDigest(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Read an existing `manifest.json` and prove it is the manifest this tool writes
 * for this package: every field the writer emits is checked, and no top-level
 * field may be one the writer does not emit. Without the entry count, the modes
 * and the `builtWith` triple, matching digests alone would let any foreign file
 * that names them stand in for a build output. An extra top-level property is
 * the caller's own content (a note, a scratch key, a secret pasted into the
 * wrong place), so the file is refused and left byte-identical rather than
 * rewritten without it. Anything short of an exact schema is a refusal, never a
 * file to overwrite.
 *
 * Rejections name the field and the category; the recorded value is candidate
 * data, and these messages are printed to a terminal and pasted into issues.
 */
function readBuildManifest(file, packageName) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    // A read error's message embeds the caller's path.
    throw new Error(`refusing to overwrite ${BUILD_MANIFEST}: it cannot be read (${error.code || 'unknown error'})`);
  }
  let parsed;
  try {
    // The text is checked for a repeated key before it is parsed: `JSON.parse`
    // keeps the last value and drops the earlier one, so a manifest that carries
    // `"builtWith": {...}` twice — the first with a pasted secret — parses as an
    // exact toolchain record and the dropped object's bytes are then overwritten.
    parsed = parseJsonText(text);
  } catch (error) {
    // The parser's own message quotes the input it choked on, which is exactly
    // the candidate content a rejection must not print.
    throw new Error(`refusing to overwrite ${BUILD_MANIFEST}: ${error instanceof DuplicateJsonKeyError
      ? 'it repeats an object key, so which value applies is ambiguous'
      : 'it is not valid JSON'}`);
  }

  const problems = [];
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    problems.push('not a JSON object');
  } else {
    const extra = Object.keys(parsed).filter((key) => !BUILD_MANIFEST_FIELDS.includes(key));
    if (extra.length > 0) {
      // Only the count is reported. A property name in a foreign manifest is
      // candidate data too, so it stays out of the log like its value.
      problems.push(`it carries ${extra.length} unexpected top-level ${extra.length === 1 ? 'property' : 'properties'}, and ${BUILD_MANIFEST} holds exactly ${BUILD_MANIFEST_FIELDS.join(', ')}`);
    }
    if (!isSafeFileName(parsed.name)) problems.push('name is not a plain package name');
    if (typeof parsed.version !== 'string' || !SAFE_VERSION.test(parsed.version)) problems.push('version is not a plain version string');
    const filename = typeof parsed.name === 'string' && typeof parsed.version === 'string'
      ? `${parsed.name}-${parsed.version}.tgz`
      : null;
    if (typeof parsed.filename !== 'string' || !isSafeFileName(parsed.filename) || parsed.filename !== filename) {
      problems.push('filename is not a plain "<name>-<version>.tgz"');
    }
    if (!isDigest(parsed.sha256)) problems.push('sha256 is not a lowercase hex digest');
    if (!isDigest(parsed.contentSha256)) problems.push('contentSha256 is not a lowercase hex digest');
    if (!Number.isInteger(parsed.entries) || parsed.entries <= 0) problems.push('entries is not a positive integer');
    if (!Array.isArray(parsed.modes) || parsed.modes.length === 0
      || !parsed.modes.every((mode) => typeof mode === 'string' && SAFE_MODE.test(mode))) {
      problems.push('modes is not a non-empty array of "0o<octal>" modes');
    }
    const builtWith = parsed.builtWith;
    const toolchainProblems = builtWithProblems(builtWith);
    if (toolchainProblems.length > 0) {
      problems.push(`builtWith is not the recorded {node,npm,platform} triple (${toolchainProblems.join('; ')})`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`refusing to overwrite ${BUILD_MANIFEST}: it is not a release:pack build manifest (${problems.join('; ')})`);
  }
  if (parsed.name !== packageName) {
    // The recorded name is candidate data; only this package's own name is
    // printed, because that is what a reader needs to tell builds apart.
    throw new Error(`refusing to overwrite ${BUILD_MANIFEST}: it describes a different package than "${packageName}"`);
  }
  return parsed;
}

/**
 * Decide, without changing anything, whether this run may install over what is
 * already in the output directory:
 *
 *   'absent'   none of the three target names is present
 *   'replace'  a complete, self-consistent output of this same build is present
 *
 * Everything else throws, naming the part of the release:pack output that made
 * the directory ambiguous. The caller's `--dist` path is never quoted back: it
 * can be a pasted path, and this message is printed and pasted into issues.
 */
function inspectExistingOutput(distDir, filename, packageName) {
  const distKind = classifyEntry(distDir);
  if (distKind === 'absent') return 'absent';
  // `assertUsableDist` already rejected every other non-directory kind.
  if (distKind !== 'directory') throw new Error('refusing to build into the given output directory: it is not a directory');

  const targets = [
    [BUILD_MANIFEST, targetPath(distDir, BUILD_MANIFEST)],
    [CHECKSUM_FILE, targetPath(distDir, CHECKSUM_FILE)],
    [TARBALL_LABEL, targetPath(distDir, filename)],
  ];
  const present = new Map();
  for (const [label, file] of targets) {
    const kind = classifyEntry(file);
    if (kind === 'absent') continue;
    // A symbolic link — including a dangling one, which `exists` reports as
    // absent — is never ours: renaming over it would destroy the caller's link.
    if (kind !== 'file') {
      throw new Error(`refusing to overwrite ${label}: it is not a regular file (${kind}), so it is not a release:pack output`);
    }
    present.set(label, file);
  }
  if (present.size === 0) return 'absent';

  // Without both metadata files nothing proves which build a tarball is.
  const missing = [BUILD_MANIFEST, CHECKSUM_FILE].filter((label) => !present.has(label));
  if (missing.length > 0) {
    throw new Error(
      `refusing to overwrite an incomplete output: found ${[...present.keys()].join(', ')}, missing ${missing.join(', ')}. `
      + 'A release:pack output is exactly manifest.json, SHA256SUMS and the tarball they describe; '
      + 'pass a new --dist, or delete those files yourself if they are stale',
    );
  }

  const manifestPath = present.get(BUILD_MANIFEST);
  const previous = readBuildManifest(manifestPath, packageName);
  if (previous.filename !== filename) {
    throw new Error(
      `refusing to overwrite a build of another version: ${BUILD_MANIFEST} does not describe ${filename}. `
      + 'Pass a new --dist, or delete the three files of that build yourself',
    );
  }

  const described = targetPath(distDir, filename);
  const describedKind = classifyEntry(described);
  if (describedKind === 'absent') {
    throw new Error(`refusing to overwrite ${BUILD_MANIFEST}: ${TARBALL_LABEL} it describes is missing from the output directory, so the previous output is incomplete`);
  }
  if (describedKind !== 'file') {
    throw new Error(`refusing to overwrite ${TARBALL_LABEL}: it is not a regular file (${describedKind}), so it is not the tarball ${BUILD_MANIFEST} describes`);
  }
  // The manifest has to describe *both* identities of the bytes that are here:
  // a matching sha256 says nothing about a stale or forged contentSha256, and a
  // matching content digest says nothing about the compressed bytes. Accepting
  // either one would let a half-written manifest stand in for a build output.
  //
  // Both identities come from one read, which is what makes that comparison
  // mean anything: read twice, a replaced file is two files, so each check can
  // be satisfied by a different file and the comparison never sees the
  // disagreement it exists to catch.
  const describedBytes = readOutputFile(described);
  const describedEntries = readEntriesOrNull(describedBytes);
  const actualSha = sha256Of(describedBytes);
  const actualContent = describedEntries === null ? null : contentDigestOf(describedEntries);
  if (actualSha !== previous.sha256 || actualContent !== previous.contentSha256) {
    const fields = [];
    if (actualSha !== previous.sha256) fields.push('sha256');
    if (actualContent !== previous.contentSha256) fields.push('contentSha256');
    throw new Error(
      `refusing to overwrite ${TARBALL_LABEL}: ${BUILD_MANIFEST} records a different ${fields.join(' and ')} than the file has, `
      + 'so the previous output is damaged or incomplete. A release:pack output is replaced only when its manifest describes '
      + 'its own tarball, so this set is left as found; pass a new --dist, or delete those files yourself if they are stale',
    );
  }
  // The digests already cover bytes; the structure has to agree with them too,
  // or `manifest.json` is not a description of this tarball.
  if (describedEntries.length !== previous.entries) {
    throw new Error(`refusing to overwrite ${BUILD_MANIFEST}: its recorded entry count does not match the tarball beside it`);
  }
  const describedModes = canonicalModes(describedEntries);
  const recordedModes = [...previous.modes].sort();
  if (describedModes.length !== recordedModes.length || describedModes.some((mode, index) => mode !== recordedModes[index])) {
    throw new Error(`refusing to overwrite ${BUILD_MANIFEST}: its recorded mode set does not match the tarball beside it`);
  }
  const sumsPath = present.get(CHECKSUM_FILE);
  if (readOutputFile(sumsPath).toString('utf8') !== `${previous.sha256}  ${previous.filename}\n`) {
    throw new Error(`refusing to overwrite ${CHECKSUM_FILE}: it does not describe the build recorded in ${BUILD_MANIFEST}`);
  }
  return 'replace';
}

/**
 * Install one file without ever exposing a half-written file under its final
 * name: the bytes go to a temporary name in the same directory (so the rename
 * cannot cross a device) and are renamed into place.
 *
 * Ownership of the temporary name starts only once `open` has created it: a name
 * that already exists makes the open fail, and the pre-existing file must then be
 * left exactly as it was. `temporary` is injectable so a test can prove that.
 */
export function installFile(dest, contents, temporary = temporaryNameFor(dest)) {
  installFileSet([{ target: dest, contents }], () => temporary);
}

/**
 * Install this run's complete output — tarball, then `manifest.json`, then
 * `SHA256SUMS` — as one set.
 *
 * Installing the three files one at a time replaced the first two before the
 * third was even written, so a full disk in the middle destroyed the previous
 * output and left a mixed set behind. The set is now staged in full first, and
 * only then renamed into place, so a failure while writing leaves the previous
 * output exactly as it was. The order is unchanged, so a failure between the
 * renames is reported as a partial set by `installFileSet` (`N of M targets were
 * replaced`) and refused by the next run (`inspectExistingOutput` rejects a
 * manifest that does not describe the tarball beside it).
 *
 * `temporaryNameOf` is injectable so a test can fail one staging step.
 */
export function installOutputSet(distDir, files, temporaryNameOf = temporaryNameFor) {
  return installFileSet(
    files.map(({ name, contents }) => ({ target: targetPath(distDir, name), contents })),
    temporaryNameOf,
  );
}

/** A temporary name next to `dest`, unique to this process and this install. */
function temporaryNameFor(dest) {
  return `${dest}.release-pack-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  assertUsableDist(options.dist);

  const manifest = readManifest();
  const filename = packageFileName(manifest);
  const expected = expectedEntries(manifest);
  const existing = inspectExistingOutput(options.dist, filename, manifest.name);

  console.log(`dsh-evolution ${manifest.version}: packing twice into a temporary directory to prove reproducibility`);
  const verified = assertReproducible();
  const entryCount = assertCleanEntries(verified.entries, expected);
  assertCleanContent(verified.entries);
  console.log(`  byte-identical in this environment: ${verified.sha256}`);
  console.log(`  content digest (environment-independent): ${verified.contentSha256}`);
  console.log(`  ${entryCount} entries, all inside the declared "files" allow-list`);

  // Everything below runs in a directory only this process knows about, so a
  // failure here cannot have touched the caller's output directory.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-evolution-build-'));
  try {
    const built = packOnce(staging);
    if (built.filename !== filename) throw new Error(`npm packed a different file name than the one ${BUILD_MANIFEST} declares: expected ${filename}`);
    if (built.sha256 !== verified.sha256 || built.contentSha256 !== verified.contentSha256) {
      throw new Error(`the artifact written to dist does not match the verified pack (${built.sha256} / ${built.contentSha256})`);
    }

    const builtWith = {
      node: process.version,
      npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
      platform: `${process.platform}-${process.arch}`,
    };
    const buildManifest = {
      name: manifest.name,
      version: manifest.version,
      filename: built.filename,
      sha256: built.sha256,
      contentSha256: built.contentSha256,
      entries: built.entries.length,
      modes: [...new Set(built.entryModes)].sort((a, b) => a - b).map((mode) => `0o${mode.toString(8)}`),
      builtWith,
    };
    fs.writeFileSync(path.join(staging, BUILD_MANIFEST), `${JSON.stringify(buildManifest, null, 2)}\n`);
    fs.writeFileSync(path.join(staging, CHECKSUM_FILE), `${built.sha256}  ${built.filename}\n`);

    // Only the three provable release:pack targets are written, and only now
    // that every byte exists and has been verified. Staging all three before any
    // rename is what keeps a write failure from destroying the previous output.
    fs.mkdirSync(options.dist, { recursive: true });
    installOutputSet(options.dist, [
      { name: built.filename, contents: fs.readFileSync(built.file) },
      { name: BUILD_MANIFEST, contents: fs.readFileSync(path.join(staging, BUILD_MANIFEST)) },
      { name: CHECKSUM_FILE, contents: fs.readFileSync(path.join(staging, CHECKSUM_FILE)) },
    ]);

    console.log('');
    console.log(`artifacts in ${options.dist}`);
    console.log(`  ${built.filename}  ${formatBytes(built.bytes)}  sha256 ${built.sha256}`);
    console.log(`  manifest.json  (built with node ${builtWith.node}, npm ${builtWith.npm}, ${builtWith.platform})`);
    console.log('  SHA256SUMS');
    if (existing === 'replace') console.log('  replaced the previous release:pack output');
    console.log('');
    console.log('to pin this build as the published artifact, run: npm run release:publish');
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Run only when executed as a script. The output-path checks are exported, so a
 * test can call them without starting a build — and without ever pointing the
 * CLI at a real repository path.
 */
function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(entry) === fs.realpathSync(self);
  } catch {
    return path.resolve(entry) === path.resolve(self);
  }
}

/**
 * Report a failure at the CLI boundary: one line, no stack trace.
 *
 * A filesystem exception's own message embeds the path it was given, and with
 * `--dist` that is a caller-supplied path that must not be printed back. Those
 * are reported as a fixed label plus the errno category only. Everything else
 * this script raises is already a fixed label (`refusing to …`) built from the
 * part of the output that failed, so its message is the report.
 */
function reportFailure(error) {
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : null;
  const isFileSystem = code !== null && /^E[A-Z0-9]{1,31}$/.test(code)
    && (error.syscall !== undefined || typeof error.errno === 'number');
  if (isFileSystem) {
    process.stderr.write(`release:pack failed: a filesystem operation failed (${code})\n`);
    return;
  }
  process.stderr.write(`release:pack failed: ${error instanceof Error ? error.message : 'an unknown error'}\n`);
}

if (invokedDirectly()) {
  try {
    main();
  } catch (error) {
    reportFailure(error);
    process.exitCode = 1;
  }
}
