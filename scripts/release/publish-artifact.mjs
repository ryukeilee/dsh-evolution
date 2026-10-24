#!/usr/bin/env node
/**
 * Pin the current ./dist build as the published artifact under ./release.
 *
 * This is the only thing that writes `release/manifest.json`, and it is a
 * deliberate, reviewable step rather than a side effect of packing:
 *
 *   release/dsh-evolution-<version>.tgz   the exact bytes that get published
 *   release/manifest.json                 their checksum and content digest
 *   release/SHA256SUMS                    the checksum file attached to the release
 *
 * Why the bytes are committed at all: `npm pack` compresses through the bundled
 * zlib, so npm 10 and npm 11 produce different bytes for byte-identical
 * content. A release must still name one exact artifact, so the artifact is
 * stored and verified rather than rebuilt and hoped for.
 *
 * Refuses to pin a build whose content differs from the tree's declared files,
 * and refuses to change a pin silently: pass --force to replace one.
 *
 * Re-running it against an existing pin is a no-op only when the release set is
 * really complete: the pin, the tarball it names and `release/SHA256SUMS` must
 * all be present and agree with the fresh build and with each other. Comparing
 * only `manifest.json#sha256` (as this script used to) reports success for a
 * deleted or corrupt tarball and for a stale checksum file, which is the one
 * state a release must never enter. The inspection below only reads, so a
 * failure leaves the release set exactly as it was found for a human to
 * inspect; nothing is repaired, deleted or replaced implicitly.
 *
 * Usage: node scripts/release/publish-artifact.mjs [--from <dir>] [--force]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILD_MANIFEST_FIELDS, DIST_DIR, DuplicateJsonKeyError, RELEASE_DIR, assertCleanContent, assertCleanEntries, assertReproducible,
  builtWithProblems, commitContentDigest, contentDigestOf, expectedEntries, gitOutput,
  installFileSet, packageFileName, parseJsonText, pinArtifactFileName, readManifest, readTarEntries, releaseArtifactPath,
} from './release-lib.mjs';

/** The pin records modes as `0o644`/`0o755` strings; `pack.mjs` derives them the same way. */
function pinModesFrom(entryModes) {
  return [...new Set(entryModes)].sort((a, b) => a - b).map((mode) => `0o${mode.toString(8)}`);
}

/** The host versions whose acceptance evidence the pin records. */
function verifiedHostsOf(packageManifest) {
  return (packageManifest.peerDependencies?.['@deepseek-ai/dsh'] || '')
    .split('||').map((value) => value.trim()).filter(Boolean);
}

/**
 * Whether `absolute` itself is a committed regular file.
 *
 * `fs.existsSync` and `fs.readFileSync` follow symbolic links, so a link named
 * `release/manifest.json`, a pinned tarball or `release/SHA256SUMS` would be
 * read from whatever it points at — possibly outside the repository — and a
 * dangling link would only read as "missing". The release set is committed
 * bytes, so the path itself must be a regular file before anything opens it.
 *
 * This is an integrity check, not a security boundary: it closes the ordinary
 * "release/ contains a symlink" case, not a concurrent swap between lstat and
 * read.
 */
function committedFileStatus(absolute) {
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: false, missing: true, message: 'is missing' };
    // `error.message` embeds the absolute path, which for a candidate build is a
    // path the caller supplied. Only the code is reported.
    return { ok: false, missing: false, message: `cannot be inspected (${error.code || 'unknown error'})` };
  }
  if (stat.isFile()) return { ok: true, missing: false };
  return {
    ok: false,
    missing: false,
    message: stat.isSymbolicLink() ? 'is a symbolic link, not a committed regular file' : 'is not a regular file',
  };
}

/**
 * Verify that the committed release set is complete and internally consistent.
 *
 * `expected` is the freshly verified build: `{ filename, sha256, contentSha256,
 * entries, modes }`, where `modes` are the canonical `0o644`/`0o755` strings.
 *
 * The set is exactly three things, and each is checked against the others:
 *
 *   - the pin describes *this* package and *this* build: name, version,
 *     filename, byte hash, content digest, entry count and modes;
 *   - the tarball the pin names exists, hashes to the pinned bytes, unpacks
 *     under the fail-closed reader, and yields the pinned content digest,
 *     entry count and modes. It is read into memory exactly once: the byte
 *     hash and the unpacked entries describe one snapshot, so no swap between
 *     two reads can satisfy `sha256` from one revision of the file and
 *     `contentSha256`/`entries`/`modes` from another;
 *   - `release/SHA256SUMS` records exactly the pinned artifact.
 *
 * Optional metadata (`sourceCommit`, `builtWith`, acceptance evidence) is not
 * re-audited here: it is not part of the three files that make a release set
 * self-consistent, and `pack:check`/`verify-provenance` own it. Returns
 * `{ pin, problems }`; `problems` empty means the set is intact. It never
 * writes, so callers can fail without disturbing the scene.
 *
 * Each of the three paths must itself be a regular committed file: every path
 * is lstat-checked before it is opened, so a symlink in `release/` — including
 * a dangling one, which `existsSync` reports as absent — fails by name instead
 * of being followed out of the release set. `release/` itself must be a real
 * directory for the same reason: a symlinked directory would let the whole
 * three-file set be read from somewhere else and still look intact.
 *
 * `selfConsistentOnly` answers the writer's other question: does the set that
 * already exists agree with *its own* pin? Nothing is then compared to this
 * package or to a fresh build, because replacing a fixed point for a new version
 * legitimately finds an older version in `release/`; the artifact and checksum
 * checks below still hold the pin to its own record.
 */
export function inspectPinnedRelease({
  releaseDir = RELEASE_DIR, packageManifest = readManifest(), expected, selfConsistentOnly = false,
} = {}) {
  if (!expected && !selfConsistentOnly) throw new Error('inspectPinnedRelease requires the freshly verified build');
  const problems = [];
  const dirStatus = committedDirectoryStatus(releaseDir);
  if (!dirStatus.ok) {
    return { pin: null, problems: [`release/ ${dirStatus.message}`] };
  }
  const pinFile = path.join(releaseDir, 'manifest.json');
  const pinStatus = committedFileStatus(pinFile);
  if (!pinStatus.ok) {
    return { pin: null, problems: [`release/manifest.json ${pinStatus.message}`] };
  }
  let pin;
  try {
    // A pin that repeats a key is ambiguous — `JSON.parse` would keep the last
    // value and drop the earlier one — so the text is checked before it is used.
    pin = parseJsonText(fs.readFileSync(pinFile, 'utf8'));
  } catch (error) {
    // A parser message quotes the input it choked on; committed or not, that
    // content is not something an error report reprints.
    return {
      pin: null,
      problems: [error instanceof DuplicateJsonKeyError
        ? 'release/manifest.json is not a readable pin: it repeats an object key'
        : 'release/manifest.json is not a readable pin: invalid JSON'],
    };
  }

  // -------------------------------------------------------------------------
  // the pin describes this package and this build (no-op question only)
  // -------------------------------------------------------------------------
  // Every rejection names the field and the category. The recorded values —
  // digests, entry counts, mode sets — are pin data, and this report is printed
  // to a terminal and pasted into issues, so none of them is quoted back.
  if (!selfConsistentOnly) {
    if (pin.name !== packageManifest.name) {
      problems.push('release/manifest.json names a different package than this one');
    }
    if (pin.version !== packageManifest.version) {
      problems.push('release/manifest.json pins a version that this package does not build');
    }
    const filename = `${packageManifest.name}-${packageManifest.version}.tgz`;
    if (pin.filename !== filename) {
      problems.push('release/manifest.json pins a filename that this package does not build');
    }
    if (pin.sha256 !== expected.sha256) {
      problems.push('release/manifest.json pins a sha256 that is not this build\'s; pass --force to replace the pin');
    }
    if (pin.contentSha256 !== expected.contentSha256) {
      problems.push('release/manifest.json pins a contentSha256 that is not this build\'s; pass --force to replace the pin');
    }
    if (pin.entries !== expected.entries) {
      problems.push('release/manifest.json pins an entry count that is not this build\'s');
    }
    if (JSON.stringify(pin.modes) !== JSON.stringify(expected.modes)) {
      problems.push('release/manifest.json pins a mode set that is not this build\'s');
    }
  }
  // -------------------------------------------------------------------------
  // the tarball the pin names is exactly the pinned artifact
  // -------------------------------------------------------------------------
  // A pin is data, so its filename is data too: never let it name a path
  // outside `release/`, and never read a file the pin was not meant to cover.
  if (typeof pin.filename !== 'string' || pin.filename === '' || pin.filename === '.' || pin.filename === '..'
    || path.basename(pin.filename) !== pin.filename || /[\\/]/.test(pin.filename)) {
    problems.push('release/manifest.json#filename is not a plain file name inside release/');
    return { pin, problems };
  }
  // Being a plain name inside `release/` is not enough: the pin's artifact is its
  // own `<name>-<version>.tgz`. A real tarball copied to any other name, with the
  // pin and `SHA256SUMS` moved onto those bytes, is internally consistent — every
  // digest check below passes — and is still not the artifact this pin describes.
  // `--force` asks this question through `selfConsistentOnly`, so the name is
  // held to the same definition here; `pinArtifactFileName()` owns it.
  try {
    pinArtifactFileName(pin);
  } catch (error) {
    problems.push(error.message);
    return { pin, problems };
  }

  const artifact = path.join(releaseDir, pin.filename);
  const artifactStatus = committedFileStatus(artifact);
  if (!artifactStatus.ok) {
    problems.push(artifactStatus.missing
      ? 'the pinned artifact is missing from release/; the pin names a file that is not committed'
      : `the pinned artifact ${artifactStatus.message}; the pin must name a committed regular file`);
    return { pin, problems };
  }
  // One read, two derivations. Hashing the path and then re-opening it for the
  // entries let a file swapped between the two calls record the bytes of one
  // revision and the content of another — a release set no single artifact ever
  // had. The buffer below is the only thing either check looks at.
  const artifactBytes = fs.readFileSync(artifact);
  const sha256 = crypto.createHash('sha256').update(artifactBytes).digest('hex');
  if (sha256 !== pin.sha256) {
    problems.push('the pinned artifact hashes to different bytes than release/manifest.json records');
  }
  let entries;
  try {
    entries = readTarEntries(artifactBytes);
  } catch (error) {
    problems.push(`the pinned artifact is not a readable gzipped npm archive: ${error.message}`);
    return { pin, problems };
  }
  const contentSha256 = contentDigestOf(entries);
  if (contentSha256 !== pin.contentSha256) {
    problems.push('the pinned artifact contains different content than release/manifest.json records');
  }
  if (entries.length !== pin.entries) {
    problems.push('the pinned artifact has an entry count that release/manifest.json does not record');
  }
  const modes = pinModesFrom(entries.map((entry) => entry.mode));
  if (JSON.stringify(modes) !== JSON.stringify(pin.modes)) {
    problems.push('the pinned artifact carries a mode set that release/manifest.json does not record');
  }

  // -------------------------------------------------------------------------
  // the attached checksum file records that same artifact
  // -------------------------------------------------------------------------
  const sumsFile = path.join(releaseDir, 'SHA256SUMS');
  const sumsStatus = committedFileStatus(sumsFile);
  if (!sumsStatus.ok) {
    problems.push(sumsStatus.missing
      ? 'missing release/SHA256SUMS; the release attaches it as the checksum file'
      : `release/SHA256SUMS ${sumsStatus.message}; it must be the committed checksum file`);
  } else {
    const recorded = fs.readFileSync(sumsFile, 'utf8').trim();
    const wanted = `${pin.sha256}  ${pin.filename}`;
    if (recorded !== wanted) {
      problems.push('release/SHA256SUMS does not record exactly the pinned artifact\'s checksum and file name');
    }
  }

  return { pin, problems };
}

/**
 * Whether `absolute` itself is a real directory (not a symlink to one).
 *
 * Same reason as `committedFileStatus`: a symlinked `release/` would make the
 * writer place the released bytes wherever the link points.
 */
function committedDirectoryStatus(absolute) {
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: false, missing: true, message: 'is missing' };
    return { ok: false, missing: false, message: `cannot be inspected (${error.code || 'unknown error'})` };
  }
  if (stat.isDirectory()) return { ok: true, missing: false };
  return {
    ok: false,
    missing: false,
    message: stat.isSymbolicLink() ? 'is a symbolic link, not a real directory' : 'is not a directory',
  };
}

/**
 * Check the build manifest `release:pack` writes against this package and the
 * tarball it names.
 *
 * `release:publish` copies `modes` and `builtWith` from this file into the pin
 * but otherwise trusted it. A byte-consistent build could therefore describe a
 * different package, version or entry list, and pinning it would create a fixed
 * point that `release:verify` rejects. Every field the packer writes is
 * re-derived here from the archive that is actually present instead.
 *
 * `archive` is the built tarball's own byte hash plus the content digest, entry
 * count and modes unpacked from that same tarball. Returns the problems; empty
 * means the build manifest describes this archive.
 */
export function inspectBuildManifest({ packageManifest, buildManifest, archive } = {}) {
  if (!packageManifest || !buildManifest || !archive) {
    throw new Error('inspectBuildManifest requires the package manifest, the build manifest and the archive');
  }
  if (buildManifest === null || typeof buildManifest !== 'object' || Array.isArray(buildManifest)) {
    return ['the build manifest is not a JSON object of the fields release:pack writes'];
  }
  const problems = [];
  // The schema is closed, like `builtWith`: a candidate that carries a property
  // `release:pack` does not write is not a release:pack output, and refusing it
  // by count keeps both the property name and its value out of the log.
  const extra = Object.keys(buildManifest).filter((key) => !BUILD_MANIFEST_FIELDS.includes(key));
  if (extra.length > 0) {
    problems.push(`the build manifest carries ${extra.length} unexpected top-level ${extra.length === 1 ? 'property' : 'properties'}; release:pack writes only ${BUILD_MANIFEST_FIELDS.join(', ')}`);
  }
  const filename = `${packageManifest.name}-${packageManifest.version}.tgz`;
  // Every rejection names the field that disagrees and which side it disagrees
  // with — never the candidate's value. A value in a build manifest is
  // candidate data, and this report is printed to a terminal and pasted into
  // issues; the field name is all a reader needs to know what to fix.
  for (const [field, expected] of [['name', packageManifest.name], ['version', packageManifest.version], ['filename', filename]]) {
    if (buildManifest[field] !== expected) {
      problems.push(`build manifest ${field} does not match this package`);
    }
  }
  for (const field of ['sha256', 'contentSha256', 'entries']) {
    if (buildManifest[field] !== archive[field]) {
      problems.push(`build manifest ${field} does not match the verified archive`);
    }
  }
  if (JSON.stringify(buildManifest.modes) !== JSON.stringify(archive.modes)) {
    problems.push('build manifest modes do not match the verified archive');
  }

  // `builtWith` is copied verbatim into the pin as the toolchain that produced
  // the released bytes, so it has to be *exactly* a toolchain record. A partial
  // check would let a build manifest smuggle any extra property — an API key,
  // a home directory, arbitrary text — into `release/manifest.json`, which is a
  // committed file. `builtWithProblems` owns that schema, and `pack.mjs` refuses
  // to overwrite an output that fails the same one.
  problems.push(...builtWithProblems(buildManifest.builtWith));
  return problems;
}

/**
 * Verify a `release:pack` output directory before any of it is pinned.
 *
 * The build manifest and the tarball are two separate claims: a manifest can be
 * made hash-consistent with a swapped tarball by copying that tarball's own
 * sha256 into it. So the candidate tarball itself is unpacked here, its bytes
 * are bound to the manifest's `sha256`, its content digest/entries/modes are
 * bound to the manifest's, and those content properties are also compared with
 * what re-packing this tree produced. Only the compressed bytes may differ
 * (npm's zlib output is not stable across environments); content must not.
 *
 * Inputs are lstat-checked and symlinks are refused, so `--from` cannot point
 * the pin at a linked directory or tarball. The tarball is read into memory
 * exactly once: its byte hash, the entries unpacked from it and the `bytes` the
 * caller installs are all that same buffer, so a `fromDir` that changes after
 * the checks cannot make the run install bytes it never verified. `verified` is
 * the re-pack result: `{ contentSha256, entries, entryModes }`. Returns
 * `{ problems, buildManifest, sha256, archive, bytes }`; callers must not pin
 * anything unless `problems` is empty.
 *
 * Every message names a fixed label (`the build directory`, `the build
 * manifest`, `the build tarball`) and never the caller's path: `--from` is an
 * operator-supplied path, so it is not printed back into a rejection.
 *
 * The candidate directory's own `SHA256SUMS` is deliberately **not** read. The
 * `--from` contract is `manifest.json` plus the tarball it describes: the
 * publisher rebuilds the checksum file it installs from the tarball bytes it
 * installs (and the pin records the same hash), so a stale or forged checksum
 * file in a build directory cannot reach the fixed point. Requiring it here
 * would only add a second, weaker copy of the same claim.
 */
export function inspectCandidateBuild({ fromDir, filename, packageManifest, verified } = {}) {
  if (!fromDir || !filename || !packageManifest || !verified) {
    throw new Error('inspectCandidateBuild requires fromDir, filename, packageManifest and verified');
  }
  // Nothing below quotes a path from `fromDir`. That directory is a caller
  // argument, and every message here is printed to a terminal and pasted into
  // issues; the labels below name which of the two candidate files is wrong.
  const rejected = (problems, extra = {}) => ({
    problems, buildManifest: null, sha256: null, archive: null, bytes: null, ...extra,
  });
  const problems = [];
  const dirStatus = committedDirectoryStatus(fromDir);
  if (!dirStatus.ok) {
    return rejected([`the build directory ${dirStatus.message}`]);
  }
  const manifestPath = path.join(fromDir, 'manifest.json');
  const manifestStatus = committedFileStatus(manifestPath);
  if (!manifestStatus.ok) {
    return rejected([`the build manifest ${manifestStatus.message}`]);
  }
  let buildManifest;
  try {
    // One read, parsed once: the manifest this inspection judged is the snapshot
    // that produced `buildManifest`, not whatever is there at the next open. A
    // repeated key makes `JSON.parse` keep the last value and drop the earlier
    // one, so the text is checked before the object is trusted.
    buildManifest = parseJsonText(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    // `JSON.parse` quotes the input it choked on, which is candidate content.
    return rejected([error instanceof DuplicateJsonKeyError
      ? 'the build manifest is not readable: it repeats an object key, so which value applies is ambiguous'
      : 'the build manifest is not readable: invalid JSON']);
  }

  const tarball = path.join(fromDir, filename);
  const tarballStatus = committedFileStatus(tarball);
  if (!tarballStatus.ok) {
    return rejected([`the build tarball ${tarballStatus.message}`], { buildManifest });
  }
  // Read the candidate bytes once. The hash, the unpacked content and the bytes
  // the caller installs all come from this one buffer, so the artifact that was
  // verified is the artifact that is pinned: re-opening the file after the
  // checks would let a swap in `fromDir` install bytes the checks never saw.
  let bytes;
  try {
    bytes = fs.readFileSync(tarball);
  } catch (error) {
    return rejected([`the build tarball cannot be read (${error.code || 'unknown error'})`], { buildManifest });
  }
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  let entries;
  try {
    entries = readTarEntries(bytes);
  } catch (error) {
    return rejected([`the build tarball is not a readable gzipped npm archive: ${error.message}`], { buildManifest, sha256 });
  }
  const archive = {
    filename,
    sha256,
    contentSha256: contentDigestOf(entries),
    entries: entries.length,
    modes: pinModesFrom(entries.map((entry) => entry.mode)),
  };
  problems.push(...inspectBuildManifest({ packageManifest, buildManifest, archive }));

  // The manifest is now bound to this tarball; the tarball's *content* must also
  // be what re-packing this tree produces, or the pin would claim released
  // content that these bytes do not have. Only the field name is reported: the
  // digests, entry lists and modes are candidate metadata.
  if (archive.contentSha256 !== verified.contentSha256) {
    problems.push('the build tarball does not contain the content this tree builds; re-run "npm run release:pack"');
  }
  if (archive.entries !== verified.entries.length) {
    problems.push('the build tarball has a different entry count than this tree builds');
  }
  if (JSON.stringify(archive.modes) !== JSON.stringify(pinModesFrom(verified.entryModes))) {
    problems.push('the build tarball carries a different mode set than this tree builds');
  }
  return { problems, buildManifest, sha256, archive, bytes };
}

/**
 * Problems that make *writing* the pin unsafe; empty when the write may proceed.
 *
 * This is a separate boundary from the read-side inspection above, because the
 * write primitives follow links: `copyFileSync`/`writeFileSync` on a symlinked
 * target would replace the file it points at, possibly outside the repository.
 * So every destination — `release/` itself and the three files — is lstat-checked
 * here, and symlinks or special files are refused by name.
 *
 * An existing target that no pin accounts for is an orphan from an unknown
 * state and is never absorbed into a new pin: an existing artifact is allowed
 * only when the pin being replaced names that same file (the caller has already
 * verified that set is complete), and an existing `SHA256SUMS` only when there
 * is a pin to be replaced. Everything else fails closed, leaving the scene as
 * found.
 *
 * Returns `{ pinPresent, pin, problems }`.
 */
export function inspectPinWriteTargets({ releaseDir = RELEASE_DIR, filename } = {}) {
  if (!filename) throw new Error('inspectPinWriteTargets requires the artifact file name');
  const problems = [];
  const dirStatus = committedDirectoryStatus(releaseDir);
  if (!dirStatus.ok) {
    problems.push(`release/ ${dirStatus.message}; the committed release set is never created implicitly`);
    return { pinPresent: false, pin: null, problems };
  }

  const pinFile = path.join(releaseDir, 'manifest.json');
  const pinStatus = committedFileStatus(pinFile);
  let pin = null;
  if (pinStatus.ok) {
    try {
      pin = parseJsonText(fs.readFileSync(pinFile, 'utf8'));
    } catch (error) {
      problems.push(error instanceof DuplicateJsonKeyError
        ? 'release/manifest.json is not a readable pin, so the existing set cannot be replaced safely (it repeats an object key)'
        : 'release/manifest.json is not a readable pin, so the existing set cannot be replaced safely (invalid JSON)');
    }
  } else if (!pinStatus.missing) {
    problems.push(`release/manifest.json ${pinStatus.message}`);
  }
  const pinPresent = pinStatus.ok && pin !== null;

  // The fixed point being replaced has to be one a pin may name at all: its own
  // `<name>-<version>.tgz`. Otherwise `--force` would replace a set whose artifact
  // is a real tarball under some other name just because the pin, the checksum
  // file and those bytes agree with each other.
  if (pinPresent) {
    try {
      pinArtifactFileName(pin);
    } catch (error) {
      problems.push(error.message);
    }
  }

  const destinations = [
    { label: 'artifact', name: filename },
    { label: 'checksum file', name: 'SHA256SUMS' },
  ];
  for (const destination of destinations) {
    const status = committedFileStatus(path.join(releaseDir, destination.name));
    if (status.ok) {
      if (!pinPresent) {
        problems.push(`release/${destination.name} already exists but release/manifest.json ${pinStatus.missing ? 'is missing' : 'does not account for it'}; refusing to overwrite an orphan ${destination.label}`);
      } else if (destination.label === 'artifact' && pin.filename !== filename) {
        // The pin's own file name is pin data; it is not quoted back.
        problems.push(`release/${filename} already exists but the existing pin names a different artifact; refusing to overwrite an orphan artifact`);
      }
    } else if (!status.missing) {
      problems.push(`release/${destination.name} ${status.message}`);
    }
  }

  return { pinPresent, pin, problems };
}

/**
 * Install `contents` at `target` through an exclusively created staging file.
 *
 * The staging *name* used to be written through directly and then removed in a
 * `finally`: a pre-existing file there was overwritten, a pre-existing symlink
 * was followed (and then renamed into place), and the cleanup could delete a
 * file this call never created. The staging file is now opened with `wx`
 * (O_CREAT|O_EXCL, which does not follow an existing symlink and does not reuse
 * an existing file), so a collision fails closed and leaves the owner's entry
 * alone. Only a staging file this call actually created is ever removed, and
 * only when the rename did not consume it.
 *
 * `rename` replaces the target's directory entry itself, so a symlink at the
 * destination is replaced rather than written through. `nonce`/`processId` are
 * injectable so the collision behaviour can be tested deterministically.
 */
export function installFile({
  target, contents, nonce = crypto.randomBytes(6).toString('hex'), processId = process.pid,
} = {}) {
  if (!target || contents === undefined || contents === null) throw new Error('installFile requires a target and contents');
  installFileSet([{ target, contents }], () => stagingNameFor(target, { nonce, processId }), { mode: 0o644 });
}

/** The staging name for one destination; unique to this process, this run and this target. */
function stagingNameFor(target, { nonce, processId }) {
  return path.join(path.dirname(target), `.${path.basename(target)}.publish-${processId}-${nonce}.tmp`);
}

/**
 * Install a complete release set — artifact, `SHA256SUMS`, pin, in that order —
 * as one set.
 *
 * The three files used to be installed one at a time, so a failure while writing
 * the second left a new artifact beside the previous pin and checksum file: the
 * old set was destroyed even though the run pinned nothing. Every byte is now
 * staged first, so only a rename-phase failure can leave a mixed set, and that
 * state is reported as incomplete by the next run (`inspectPinnedRelease`
 * refuses a tarball that does not hash to the pin) rather than passing as a
 * released set. The pin is still written last, so no pin ever names files that
 * are not installed yet.
 *
 * `stagingNameFor` is not followed from a value on disk: a taken staging name
 * fails closed, and only staging names this call created are removed.
 */
export function installReleaseSet(files, { nonce = crypto.randomBytes(6).toString('hex'), processId = process.pid } = {}) {
  const used = new Set();
  installFileSet(files, (target) => {
    const name = stagingNameFor(target, { nonce, processId });
    if (used.has(name)) throw new Error('refusing to replace the target: the same staging name is already staged by this install');
    used.add(name);
    return name;
  }, { mode: 0o644 });
}

function parseArgs(argv) {
  const options = { from: DIST_DIR, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--from') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error('--from requires a value');
      options.from = path.resolve(next);
      index += 1;
    } else if (argv[index] === '--force') options.force = true;
    else if (argv[index] === '--help' || argv[index] === '-h') {
      console.log('node scripts/release/publish-artifact.mjs [--from <dir>] [--force]');
      process.exit(0);
    } else {
      // The rejected token is not printed: it can be a caller-supplied path.
      throw new Error('unknown argument; usage: node scripts/release/publish-artifact.mjs [--from <dir>] [--force]');
    }
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  const manifest = readManifest();
  const filename = packageFileName(manifest);

  // The build we are about to pin must still be what this tree declares.
  const expected = expectedEntries(manifest);
  const verified = assertReproducible();
  assertCleanEntries(verified.entries, expected);
  assertCleanContent(verified.entries);
  // The candidate directory is verified as a whole: manifest against its own
  // tarball, and that tarball's unpacked content against this tree's re-pack.
  // The inspection returns the exact bytes it verified, and those bytes — not a
  // new read of the same path — are what gets installed below.
  const candidate = inspectCandidateBuild({ fromDir: options.from, filename, packageManifest: manifest, verified });
  if (candidate.problems.length > 0) {
    throw new Error([
      'the build directory is not a usable release:pack output for this tree:',
      ...candidate.problems.map((problem) => `  - ${problem}`),
      'nothing was pinned; re-run "npm run release:pack" and review the build output.',
    ].join('\n'));
  }
  const { buildManifest, sha256: builtSha, bytes: builtBytes } = candidate;
  const expectedBuild = {
    filename: verified.filename,
    sha256: builtSha,
    contentSha256: verified.contentSha256,
    entries: verified.entries.length,
    modes: pinModesFrom(verified.entryModes),
  };

  const existingPath = path.join(RELEASE_DIR, 'manifest.json');
  const existingStatus = committedFileStatus(existingPath);
  if (!existingStatus.ok && !existingStatus.missing) {
    throw new Error(`refusing to write the pin: release/manifest.json ${existingStatus.message}`);
  }
  const pinPresent = existingStatus.ok;

  if (pinPresent && !options.force) {
    // "Already pinned" is a claim about three files, so prove all three before
    // saying it. A missing/corrupt tarball, a stale SHA256SUMS or a pin that
    // disagrees with its own artifact lands here as a failure instead.
    const existing = inspectPinnedRelease({ expected: expectedBuild });
    if (existing.problems.length > 0) {
      throw new Error([
        'release/ is not a complete pin of this build:',
        ...existing.problems.map((problem) => `  - ${problem}`),
        'nothing was written. Re-pin deliberately with --force only if these bytes are the ones to ship;',
        'otherwise restore the release set from git and inspect what changed.',
      ].join('\n'));
    }
    console.log(`release/ already pins ${builtSha}; nothing to do`);
    return;
  }

  if (pinPresent) {
    // --force replaces a fixed point, so the set being replaced must itself be
    // complete. Otherwise the overwrite would launder a damaged or half-written
    // state into something that looks like a reviewed release.
    const previous = inspectPinnedRelease({ selfConsistentOnly: true });
    if (previous.problems.length > 0) {
      throw new Error([
        'refusing to replace an existing pin that is not a complete release set:',
        ...previous.problems.map((problem) => `  - ${problem}`),
        'nothing was written. Restore release/ from git, or remove the damaged files deliberately.',
      ].join('\n'));
    }
  }

  // The write side has its own boundary: release/ must be a real directory, and
  // no destination may be a symlink or an orphan of a pin we do not have.
  const targets = inspectPinWriteTargets({ filename });
  if (targets.problems.length > 0) {
    throw new Error([
      `refusing to write ${filename} into release/:`,
      ...targets.problems.map((problem) => `  - ${problem}`),
      'nothing was written; inspect release/ before continuing.',
    ].join('\n'));
  }

  const hosts = verifiedHostsOf(manifest);
  // The commit this artifact was built from. It is recorded on purpose: the
  // release workflow refuses to publish a new release whose pin does not name a
  // commit in the tagged history, so a pin cannot be copied onto a tag it did
  // not come from. The release commit that carries this file is a later commit,
  // so `sourceCommit` is checked as an ancestor of the tag, not as an equality.
  const sourceCommit = gitOutput(['rev-parse', 'HEAD']);
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new Error(`git returned an unusable commit id: ${JSON.stringify(sourceCommit)}`);
  }
  if (commitContentDigest(sourceCommit) !== verified.contentSha256) {
    throw new Error('the build differs from HEAD shipped content; commit the source before pinning it');
  }
  const releaseManifest = {
    name: manifest.name,
    version: manifest.version,
    filename,
    sha256: builtSha,
    contentSha256: verified.contentSha256,
    entries: verified.entries.length,
    modes: buildManifest.modes,
    builtWith: buildManifest.builtWith,
    sourceCommit,
    // The acceptance evidence recorded against exactly these bytes.
    verifiedHosts: hosts,
    evidence: hosts.map((host) => `docs/evidence/dsh-${host}.json`),
  };

  const artifactPath = releaseArtifactPath(releaseManifest);
  // Artifact and checksum file first, pin last: an interrupted write can never
  // leave a new pin naming files that are not installed yet, so the half-written
  // state is reported as incomplete by the next run instead of passing as a
  // released set. All three are staged before any of them is renamed into place,
  // so a failure while writing leaves the previous set byte-identical.
  installReleaseSet([
    // The exact buffer this run hashed and unpacked, never a fresh read of the
    // candidate path: a `--from` directory that changed after the checks must
    // not get different bytes installed under the bytes that were verified.
    { target: artifactPath, contents: builtBytes },
    { target: path.join(RELEASE_DIR, 'SHA256SUMS'), contents: Buffer.from(`${builtSha}  ${filename}\n`, 'utf8') },
    { target: existingPath, contents: Buffer.from(`${JSON.stringify(releaseManifest, null, 2)}\n`, 'utf8') },
  ]);

  console.log(`pinned ${filename}`);
  console.log(`  sha256 (published bytes)      ${builtSha}`);
  console.log(`  contentSha256 (any platform)  ${verified.contentSha256}`);
  console.log(`  entries                       ${verified.entries.length}`);
  console.log(`  sourceCommit                  ${sourceCommit}`);
  console.log('');
  console.log('now re-run the host acceptance so ./docs/evidence matches these bytes, then');
  console.log('run "npm run pack:check" and commit release/ together with the evidence.');
}

// Only run as a command: importing this module (the release-set tests do) must
// not parse arguments, pack the tree or touch `release/`.
//
// Compared by real path, not by URL spelling, exactly as `pack.mjs` does. Node
// resolves this module to its real path, so a caller's alias — a symbolic link
// to this script, or a temp root like `/var` → `/private/var` on macOS — keeps
// the entry URL distinct from `import.meta.url`. The URL comparison then said
// "not invoked directly", and the publisher exited 0 having run no check and
// written nothing, which reads exactly like a successful pin.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(entry) === fs.realpathSync(self);
  } catch {
    return path.resolve(entry) === path.resolve(self);
  }
})();

/**
 * Report a failure at the CLI boundary: one line, no stack trace.
 *
 * A filesystem exception's own message embeds the path it was given, and with
 * `--from` that is a caller-supplied path that must not be printed back. Those
 * are reported as a fixed label plus the errno category only. Everything else
 * this script raises is a fixed label built from the inspected part, so its
 * message is the report.
 */
function reportFailure(error) {
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : null;
  const isFileSystem = code !== null && /^E[A-Z0-9]{1,31}$/.test(code)
    && (error.syscall !== undefined || typeof error.errno === 'number');
  if (isFileSystem) {
    process.stderr.write(`release:publish failed: a filesystem operation failed (${code})\n`);
    return;
  }
  process.stderr.write(`release:publish failed: ${error instanceof Error ? error.message : 'an unknown error'}\n`);
}

if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    reportFailure(error);
    process.exitCode = 1;
  }
}
