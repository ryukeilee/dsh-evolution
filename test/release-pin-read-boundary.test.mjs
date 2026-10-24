/**
 * Round 9 independent review, P1: the read-only checks that start from the pin
 * could be steered out of `release/`.
 *
 * The pin (`release/manifest.json`) is the authority for the published bytes, so
 * three read-only entry points open the file it names and hash, unpack and
 * compare it: `verify-artifact.mjs` (the published-bytes gate),
 * `verify-package.mjs` (`pack:check`'s committed-artifact question) and
 * `pin-relation.mjs` (the development-tree diagnostic). All three got the path
 * from `releaseArtifactPath(pin)`, which was a bare
 * `path.join(RELEASE_DIR, pin.filename)`, and `readReleaseManifest()` read
 * `release/manifest.json` through `existsSync` + `readFileSync`, both of which
 * follow a symbolic link.
 *
 * Two counterexamples followed from that, and both end in a *passing* report:
 *
 *   * `"filename": "../outside.tgz"` resolves outside `release/`. If that
 *     foreign file happens to carry the pinned bytes — a copy of the release, a
 *     stale one, anything a machine can read — `verify-artifact` hashed it,
 *     compared it to the pin and printed "matches release/manifest.json". The
 *     check that is supposed to prove which bytes shipped proved it about a file
 *     nobody chose.
 *   * `release/manifest.json` as a symbolic link to a foreign pin, a symlinked
 *     `release/` directory, or a symlinked (or dangling) `*.tgz` inside it: every
 *     name in the report stays right while the content is read from elsewhere.
 *     The publisher already lstat-guards the set it writes; the readers above
 *     did not.
 *
 * What is pinned here, end to end, through the real entry points in throwaway
 * repositories under `os.tmpdir()`:
 *
 *   1. `release/` must be a real directory and `manifest.json` a regular file in
 *      place, before the pin text is read;
 *   2. a pin's `filename` must be its own single-component `<name>-<version>.tgz`
 *      inside `release/` — no separator (either slash), no absolute path, no
 *      `.`/`..`, no name that is not the pin's own tarball;
 *   3. the pin-named tarball must be a regular file, decided by `lstat` before
 *      anything is opened (a link, a dangling link, a directory or a special
 *      file is refused by category, not followed and not reported as "missing");
 *   4. a valid pinned release still passes.
 *
 * Every refusal is fail-closed and its surface is a fixed label: no rejected
 * value, no external path, no parser text, no errno text that embeds a path. The
 * "was not read" evidence is the error itself: one case makes the external file
 * unreadable (mode 000), so a read attempt would surface `EACCES` instead of the
 * label; the readable case asserts the old pass marker ("matches
 * release/manifest.json") is absent and the external bytes are unchanged.
 *
 * `verify-artifact <tarball>` with an explicit argument is a *different*
 * contract and is deliberately left alone: that path is the caller's candidate
 * (a CI artifact, a downloaded file), not something the pin names.
 *
 * Nothing here writes to, replaces or deletes anything in the repository's real
 * `release/` or `dist/`: the real pinned tarball is only read once, into the
 * throwaway root, to serve as the marker whose bytes the pin hashes.
 *
 * Round 14 review, P1: `verify-artifact`'s failure surface reprinted what it was
 * inspecting.
 *
 * The command is run against a candidate build on purpose (CI downloads the
 * uploaded release and verifies it), so its second argument is a path the caller
 * chose. Three ways the failure output echoed that data back:
 *
 *   * `missing tarball: <path>` printed the candidate path itself;
 *   * `sha256 is <candidate>, expected <pin>` and the matching content/entry/mode
 *     lines printed the candidate's digests *and* the pin's — in the human lines,
 *     in the mismatch list and in the JSON report;
 *   * a filesystem or gunzip exception was not caught at all, so Node printed the
 *     exception's own message (which embeds the path it was given) and a stack.
 *
 * What is pinned here is the whole failing surface of that command: every refusal
 * names the field and the side it disagrees with, a filesystem failure is its
 * errno category, and neither a value nor a stack frame appears. The pass output
 * is deliberately unchanged — a successful run states the bytes it verified.
 *
 * The publisher's `--force` precheck has the mirror-image defect, pinned in
 * `release-publish-noop.test.mjs`: a real tarball copied to another name with the
 * pin and `SHA256SUMS` moved onto it is self-consistent, and was treated as a
 * fixed point that `--force` may replace.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import {
  REPO_ROOT, archiveContentDigest, archiveEntries, pinArtifactFileName, pinnedArtifactFile,
  pinnedArtifactStatus, readReleaseManifest, releaseArtifactPath,
} from '../scripts/release/release-lib.mjs';

const RELEASE_MODULES = path.join(REPO_ROOT, 'scripts', 'release');
const HOST = '0.2.0-rc.2';
const PACKAGE = {
  name: 'dsh-evolution-probe',
  version: '0.0.1-rc.0',
  engines: { node: '>=26.0.0' },
  peerDependencies: { '@deepseek-ai/dsh': HOST },
  files: [],
};
const FILENAME = `${PACKAGE.name}-${PACKAGE.version}.tgz`;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-pin-read-boundary-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/**
 * The marker bytes: the committed artifact this repository already ships. Only
 * its bytes are used, so a pin fixture can record the exact sha256, content
 * digest, entry count and modes of a file it *does* contain — that is what makes
 * the traversal and symlink counterexamples reachable in the first place.
 */
const MARKER_FILE = path.join(scratch, 'marker.tgz');
fs.writeFileSync(MARKER_FILE, fs.readFileSync(pinnedArtifactFile(readReleaseManifest())));
const MARKER_BYTES = fs.readFileSync(MARKER_FILE);
const MARKER_SHA256 = crypto.createHash('sha256').update(MARKER_BYTES).digest('hex');
const MARKER_CONTENT_SHA256 = archiveContentDigest(MARKER_FILE);
const MARKER_ENTRIES = archiveEntries(MARKER_FILE).length;
const MARKER_MODES = [...new Set(archiveEntries(MARKER_FILE).map((entry) => `0o${entry.mode.toString(8)}`))].sort();

/**
 * The fixed labels these readers may print. Nothing else about the fixture —
 * a name, a link target, a digest, an errno line — may appear on the surface.
 */
const PIN_FILENAME_LABEL = "release/manifest.json#filename is not this pin's own \"<name>-<version>.tgz\" file name inside release/";
const PIN_LINK_LABEL = 'release/manifest.json is a symbolic link, not a committed regular file';
const RELEASE_LINK_LABEL = 'release/ is a symbolic link, not a real directory';
const ARTIFACT_LINK_LABEL = 'the pinned artifact is a symbolic link, not a regular file';
const PASS_MARKER = 'matches release/manifest.json';

/** A value no refusal may echo; it lives in every foreign pin/file these tests build. */
const SENTINEL = 'sk-pin-read-boundary';

let fixtureCount = 0;
function freshDir(label) {
  const dir = path.join(scratch, `${label}-${fixtureCount += 1}`);
  fs.mkdirSync(dir);
  return dir;
}

/** The marker's archive with one payload byte flipped: valid framing, other bytes. */
function mutateFirstEntry(bytes) {
  const tar = Buffer.from(zlib.gunzipSync(bytes));
  const firstSize = Number.parseInt(tar.toString('ascii', 124, 136).trim() || '0', 8);
  assert.ok(firstSize > 0, 'the committed artifact must have a non-empty first entry');
  tar[512 + firstSize - 1] ^= 0xff;
  return zlib.gzipSync(tar);
}

/** Whether this platform lets the test create a symbolic link at all. */
function symlinksWork() {
  const dir = freshDir('symlink-probe');
  const target = path.join(dir, 'target.txt');
  const link = path.join(dir, 'link.txt');
  fs.writeFileSync(target, 'probe\n');
  try {
    fs.symlinkSync(target, link, 'file');
    return fs.readFileSync(link, 'utf8') === 'probe\n';
  } catch {
    return false;
  }
}

/**
 * A throwaway repository root: the release modules (they derive `REPO_ROOT` from
 * their own location, so the copy *is* the repository they read) and a valid
 * `package.json`.
 */
function fakeRepo() {
  const root = freshDir('root');
  const modules = path.join(root, 'scripts', 'release');
  fs.mkdirSync(modules, { recursive: true });
  for (const name of fs.readdirSync(RELEASE_MODULES)) {
    if (name.endsWith('.mjs')) fs.copyFileSync(path.join(RELEASE_MODULES, name), path.join(modules, name));
  }
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(PACKAGE, null, 2)}\n`);
  // The declared shipped set is `files: []` plus the always-included names, so
  // these two have to exist for the tree digest (and therefore `pack:check` and
  // `pin-relation`) to read a tree instead of failing on a missing entry.
  fs.writeFileSync(path.join(root, 'README.md'), `# ${PACKAGE.name}\n\nversion \`${PACKAGE.version}\` supports host ${HOST}\n`);
  fs.writeFileSync(path.join(root, 'LICENSE'), 'MIT\n');
  return root;
}

/**
 * The metadata documents `verify-package.mjs` reads unconditionally. Their
 * content is not the subject here (each of those checks may fail and be
 * reported); what matters is that the run reaches the pin and artifact checks
 * instead of dying on a missing file.
 */
function writePackageMetadata(root) {
  fs.writeFileSync(path.join(root, 'package-lock.json'), `${JSON.stringify({
    name: PACKAGE.name,
    version: PACKAGE.version,
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: PACKAGE.name, version: PACKAGE.version } },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'README.md'), `# ${PACKAGE.name}\n\nversion \`${PACKAGE.version}\` supports host ${HOST}\n`);
  fs.writeFileSync(path.join(root, 'COMPATIBILITY.md'), `# compatibility\n\nhost ${HOST}\n`);
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), `# changelog\n\n## ${PACKAGE.version}\n`);
  fs.writeFileSync(path.join(root, 'LICENSE'), 'MIT\n');
}

/** The pin this package would legitimately record for a file of the marker bytes. */
function markerPin(overrides = {}) {
  return {
    name: PACKAGE.name,
    version: PACKAGE.version,
    filename: FILENAME,
    sha256: MARKER_SHA256,
    contentSha256: MARKER_CONTENT_SHA256,
    entries: MARKER_ENTRIES,
    modes: MARKER_MODES,
    ...overrides,
  };
}

function writePin(root, pin) {
  const release = path.join(root, 'release');
  fs.mkdirSync(release, { recursive: true });
  fs.writeFileSync(path.join(release, 'manifest.json'), `${JSON.stringify(pin, null, 2)}\n`);
  return release;
}

/** A regular pinned artifact with the marker's bytes inside `release/`. */
function writeArtifact(root) {
  fs.writeFileSync(path.join(root, 'release', FILENAME), MARKER_BYTES);
}

/** Name, size, mode and content hash of one file, so "unchanged" is checkable. */
function fileSnapshot(file) {
  const stat = fs.lstatSync(file);
  return {
    size: stat.size,
    mode: stat.mode,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  };
}

function run(root, script, args = []) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'release', script), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, surface: `${result.stdout}\n${result.stderr}` };
}

/**
 * The refusal is the fixed label, and the surface says nothing else about what
 * was inspected: no sentinel, no external path, no digest, no errno text (which
 * would carry a path), and no pass marker.
 */
function assertRefused(surface, label) {
  assert.equal(surface.split('\n').some((line) => line.includes(label)), true, `expected the fixed label "${label}"; got:\n${surface}`);
  assert.equal(surface.includes(SENTINEL), false, 'no rejected value or foreign content may be echoed');
  assert.equal(surface.includes(MARKER_SHA256), false, 'no digest of the inspected file may be echoed');
  assert.equal(surface.includes(PASS_MARKER), false, 'a refusal must not read as a verification pass');
  assert.equal(/EACCES|EPERM/.test(surface), false, 'the file must not have been opened at all');
}

// ---------------------------------------------------------------------------
// the path helper, decided without any filesystem read
// ---------------------------------------------------------------------------

test('a pin may only name its own single-component tarball inside release/', () => {
  const pin = markerPin();
  assert.equal(pinArtifactFileName(pin), FILENAME);
  assert.equal(releaseArtifactPath(pin), path.join(REPO_ROOT, 'release', FILENAME));
  assert.equal(path.dirname(releaseArtifactPath(pin)), path.resolve(REPO_ROOT, 'release'));
  for (const filename of [
    '../outside.tgz', './outside.tgz', '../../release/manifest.json', '..', '.', '',
    `nested/${FILENAME}`, `nested\\${FILENAME}`, path.join(REPO_ROOT, FILENAME),
    'other-package-0.0.1-rc.0.tgz', `${FILENAME}\u0000`, `${FILENAME} `,
  ]) {
    assert.throws(
      () => pinArtifactFileName(markerPin({ filename })),
      { message: PIN_FILENAME_LABEL },
      `filename ${JSON.stringify(filename)} must be refused`,
    );
  }
  // A pin whose own name/version would *produce* a path spelling is refused too:
  // the expected name is checked to be one component, not compared blindly.
  for (const name of ['../outside', 'a/b']) {
    assert.throws(() => pinArtifactFileName({ ...pin, name, filename: `${name}-${pin.version}.tgz` }), { message: PIN_FILENAME_LABEL });
  }
  // And a pin with no name/version has nothing to derive the name from.
  assert.throws(() => pinArtifactFileName({ filename: FILENAME }), { message: PIN_FILENAME_LABEL });
  assert.throws(() => pinArtifactFileName(null), { message: PIN_FILENAME_LABEL });
});

// ---------------------------------------------------------------------------
// verify-artifact: the pin-named target
// ---------------------------------------------------------------------------

test('a pinned filename that resolves outside release/ is refused and the outside file is not read', (t) => {
  const root = fakeRepo();
  const outside = path.join(root, 'outside.tgz');
  fs.writeFileSync(outside, MARKER_BYTES);
  // The premise, recorded: the old `path.join(RELEASE_DIR, pin.filename)` really
  // did name this file, and its bytes really are the bytes the pin records — so
  // the old check reported a pass for content read outside `release/`.
  assert.equal(fs.realpathSync(path.join(root, 'release', '..', 'outside.tgz')), fs.realpathSync(outside));
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(outside)).digest('hex'), MARKER_SHA256);
  writePin(root, markerPin({ filename: '../outside.tgz' }));

  const before = fileSnapshot(outside);
  const first = run(root, 'verify-artifact.mjs');
  assert.equal(first.status, 1, `the traversal pin must fail; got:\n${first.surface}`);
  assertRefused(first.surface, PIN_FILENAME_LABEL);
  assert.deepEqual(fileSnapshot(outside), before, 'the outside file must be untouched');

  // Read-side proof: unreadable, so any attempt to open it would surface EACCES
  // rather than the fixed label this refusal prints. (Skipped for root, where
  // mode 000 does not block a read.)
  try {
    fs.chmodSync(outside, 0o000);
    if (process.getuid?.() !== 0) {
      const second = run(root, 'verify-artifact.mjs');
      assert.equal(second.status, 1, `the traversal pin must fail the same way; got:\n${second.surface}`);
      assertRefused(second.surface, PIN_FILENAME_LABEL);
    }
  } finally {
    fs.chmodSync(outside, before.mode);
  }
  t.diagnostic(`refusal: ${PIN_FILENAME_LABEL}`);
});

test('release/manifest.json must be a regular file, not a link to a foreign pin', (t) => {
  if (!symlinksWork()) {
    t.skip('this platform cannot create symbolic links');
    return;
  }
  const root = fakeRepo();
  const release = writePin(root, markerPin());
  writeArtifact(root);
  // The foreign pin is a complete, self-consistent record with the marker bytes,
  // so if it were followed the run would pass — that is the counterexample.
  const foreign = path.join(scratch, `foreign-pin-${fixtureCount += 1}.json`);
  fs.writeFileSync(foreign, `${JSON.stringify(markerPin({ reviewSentinel: SENTINEL }), null, 2)}\n`);
  fs.rmSync(path.join(release, 'manifest.json'));
  fs.symlinkSync(foreign, path.join(release, 'manifest.json'), 'file');
  const before = fileSnapshot(foreign);

  const linked = run(root, 'verify-artifact.mjs');
  assert.equal(linked.status, 1, `a symlinked pin must fail; got:\n${linked.surface}`);
  assertRefused(linked.surface, PIN_LINK_LABEL);
  assert.deepEqual(fileSnapshot(foreign), before, 'the foreign pin must not be read or rewritten');

  // A dangling link is a link, not a missing pin.
  fs.rmSync(path.join(release, 'manifest.json'));
  fs.symlinkSync(path.join(scratch, 'no-such-pin.json'), path.join(release, 'manifest.json'), 'file');
  const dangling = run(root, 'verify-artifact.mjs');
  assert.equal(dangling.status, 1, `a dangling pin link must fail; got:\n${dangling.surface}`);
  assertRefused(dangling.surface, PIN_LINK_LABEL);
  assert.equal(dangling.surface.includes('missing release/manifest.json'), false, 'a dangling link is a link, not an absent pin');
  t.diagnostic(`refusal: ${PIN_LINK_LABEL}`);
});

test('release/ itself must be a real directory, not a link to a foreign release set', (t) => {
  if (!symlinksWork()) {
    t.skip('this platform cannot create symbolic links');
    return;
  }
  const root = fakeRepo();
  const foreign = freshDir('foreign-release');
  fs.writeFileSync(path.join(foreign, 'manifest.json'), `${JSON.stringify(markerPin({ reviewSentinel: SENTINEL }), null, 2)}\n`);
  fs.writeFileSync(path.join(foreign, FILENAME), MARKER_BYTES);
  fs.symlinkSync(foreign, path.join(root, 'release'), 'dir');

  const linked = run(root, 'verify-artifact.mjs');
  assert.equal(linked.status, 1, `a symlinked release/ must fail; got:\n${linked.surface}`);
  assertRefused(linked.surface, RELEASE_LINK_LABEL);
  // The foreign set is a complete pass if it were read; the refusal is the proof
  // that it was not.
  assert.equal(fileSnapshot(path.join(foreign, FILENAME)).sha256, MARKER_SHA256);
});

test('the pinned tarball must be a regular file: symlinks and dangling symlinks are refused', (t) => {
  if (!symlinksWork()) {
    t.skip('this platform cannot create symbolic links');
    return;
  }
  const root = fakeRepo();
  writePin(root, markerPin());
  const outside = path.join(scratch, `artifact-target-${fixtureCount += 1}.tgz`);
  fs.writeFileSync(outside, MARKER_BYTES);
  fs.symlinkSync(outside, path.join(root, 'release', FILENAME), 'file');
  const before = fileSnapshot(outside);

  const linked = run(root, 'verify-artifact.mjs');
  assert.equal(linked.status, 1, `a symlinked artifact must fail; got:\n${linked.surface}`);
  assertRefused(linked.surface, ARTIFACT_LINK_LABEL);
  assert.deepEqual(fileSnapshot(outside), before, 'the link target must be untouched');

  // Unreadable target: an attempted read would report EACCES, not the label.
  try {
    fs.chmodSync(outside, 0o000);
    const unreadable = run(root, 'verify-artifact.mjs');
    assert.equal(unreadable.status, 1, `the same refusal must hold; got:\n${unreadable.surface}`);
    assertRefused(unreadable.surface, ARTIFACT_LINK_LABEL);
  } finally {
    fs.chmodSync(outside, before.mode);
  }

  // A dangling link is refused as a link; the old reader reported it as absent.
  fs.rmSync(path.join(root, 'release', FILENAME));
  fs.symlinkSync(path.join(scratch, 'no-such-artifact.tgz'), path.join(root, 'release', FILENAME), 'file');
  const dangling = run(root, 'verify-artifact.mjs');
  assert.equal(dangling.status, 1, `a dangling artifact link must fail; got:\n${dangling.surface}`);
  assertRefused(dangling.surface, ARTIFACT_LINK_LABEL);
  assert.equal(dangling.surface.includes('missing tarball'), false, 'a dangling link must not be reported as a missing file');
  t.diagnostic(`refusal: ${ARTIFACT_LINK_LABEL}`);
});

test('a valid pinned release still passes the pin-named check', () => {
  const root = fakeRepo();
  writePin(root, markerPin());
  writeArtifact(root);

  // The real repository's own pin is the positive control for the status gate:
  // a regular committed artifact passes it.
  const status = pinnedArtifactStatus(readReleaseManifest());
  assert.equal(status.ok, true, 'the real release/ artifact is a regular file');
  assert.equal(path.dirname(status.file), path.resolve(REPO_ROOT, 'release'));

  const result = run(root, 'verify-artifact.mjs');
  assert.equal(result.status, 0, `a consistent pinned release must pass; got:\n${result.surface}`);
  assert.equal(result.surface.includes(PASS_MARKER), true, 'the pass names the pin it matched');
  assert.equal(result.surface.includes(MARKER_SHA256), true, 'and reports the bytes it hashed');
});

test('an explicit caller-supplied tarball keeps its own contract', () => {
  const root = fakeRepo();
  writePin(root, markerPin());
  writeArtifact(root);
  // The same bytes under the pinned name, in a directory the pin does not name:
  // this is the documented "verify a downloaded/CI artifact" path, so it is the
  // caller's candidate rather than the pin's target.
  const candidate = path.join(freshDir('candidate'), FILENAME);
  fs.writeFileSync(candidate, MARKER_BYTES);
  const result = run(root, 'verify-artifact.mjs', [candidate]);
  assert.equal(result.status, 0, `an explicit candidate path is still accepted; got:\n${result.surface}`);
  assert.equal(result.surface.includes('matches release/manifest.json'), true, `the candidate's bytes are the pin's: ${result.surface}`);
});

test('a failing candidate is reported by field and category only: no path, no digest, no stack', () => {
  const root = fakeRepo();
  writePin(root, markerPin());
  writeArtifact(root);

  // 1. A candidate that is not there. The path is caller data, so the report is
  // the category; the old line was `missing tarball: <path>`.
  const missingDir = path.join(scratch, `missing-${SENTINEL}`);
  fs.mkdirSync(missingDir);
  const missing = path.join(missingDir, `candidate-${SENTINEL}.tgz`);
  const missingRun = run(root, 'verify-artifact.mjs', [missing]);
  assert.equal(missingRun.status, 2, `a missing candidate is still a distinct failure; got:\n${missingRun.surface}`);
  assert.match(missingRun.surface, /verify-artifact failed: the tarball is missing/);
  assert.equal(missingRun.surface.includes(SENTINEL), false, 'the candidate path must not be echoed');
  assert.equal(missingRun.surface.includes(missingDir), false, 'nor the directory it lives in');
  assert.equal(missingRun.surface.includes(MARKER_SHA256), false);

  // 2. A readable candidate with another name and other bytes. The candidate's
  // digests and the pin's are exactly what the failure must not print.
  const otherBytes = mutateFirstEntry(MARKER_BYTES);
  const otherSha = crypto.createHash('sha256').update(otherBytes).digest('hex');
  const otherContent = archiveContentDigest(otherBytes);
  assert.notEqual(otherSha, MARKER_SHA256, 'the premise: other bytes, another sha256');
  assert.notEqual(otherContent, MARKER_CONTENT_SHA256, 'the premise: other content, another digest');
  const candidateDir = path.join(scratch, `candidate-${SENTINEL}`);
  fs.mkdirSync(candidateDir);
  const candidate = path.join(candidateDir, `candidate-${SENTINEL}.tgz`);
  fs.writeFileSync(candidate, otherBytes);
  const before = fileSnapshot(candidate);

  const mismatch = run(root, 'verify-artifact.mjs', [candidate]);
  assert.equal(mismatch.status, 1, `a candidate that is not the pin must fail; got:\n${mismatch.surface}`);
  assert.match(mismatch.surface, /the file name is not the one release\/manifest\.json records/);
  assert.match(mismatch.surface, /the sha256 is not the one release\/manifest\.json records/);
  assert.match(mismatch.surface, /the contentSha256 is not the one release\/manifest\.json records/);
  for (const value of [otherSha, otherContent, MARKER_SHA256, MARKER_CONTENT_SHA256, SENTINEL, PASS_MARKER]) {
    assert.equal(mismatch.surface.includes(value), false, `the report must not print ${value}`);
  }
  assert.equal(/^\s+at /m.test(mismatch.surface), false, 'no stack trace is printed');
  assert.deepEqual(fileSnapshot(candidate), before, 'the candidate is only read');

  // The JSON report of a failed run has the same rule: the problems, and none of
  // the numbers or the path this run could not confirm.
  const jsonMismatch = run(root, 'verify-artifact.mjs', [candidate, '--json']);
  assert.equal(jsonMismatch.status, 1);
  const failedReport = JSON.parse(jsonMismatch.stdout);
  assert.equal(failedReport.ok, false);
  assert.equal(Array.isArray(failedReport.problems) && failedReport.problems.length > 0, true);
  for (const field of ['file', 'sha256', 'contentSha256']) {
    assert.equal(field in failedReport, false, `a failed JSON report must not carry ${field}`);
  }
  assert.equal(jsonMismatch.surface.includes(otherSha), false);
  assert.equal(jsonMismatch.surface.includes(otherContent), false);
  assert.equal(jsonMismatch.surface.includes(MARKER_SHA256), false);
  assert.equal(jsonMismatch.surface.includes(MARKER_CONTENT_SHA256), false);

  // 3. A filesystem exception under the candidate path. Its own message embeds
  // that path, so only the errno category is reported.
  const directory = path.join(candidateDir, 'a-directory.tgz');
  fs.mkdirSync(directory);
  const failed = run(root, 'verify-artifact.mjs', [directory]);
  assert.equal(failed.status, 1, `an unreadable candidate must fail; got:\n${failed.surface}`);
  assert.match(failed.surface, /verify-artifact failed: a filesystem operation failed \(EISDIR\)/);
  assert.equal(failed.surface.includes('a-directory.tgz'), false, 'the candidate path must not be echoed');
  assert.equal(failed.surface.includes(SENTINEL), false);
  assert.equal(failed.surface.includes(MARKER_SHA256), false);
  assert.equal(/^\s+at /m.test(failed.surface), false, 'no stack trace is printed');

  // 4. A candidate that is not a gzipped archive: the decompression category, not
  // a parser message and not the bytes that failed.
  const garbage = path.join(candidateDir, 'garbage.tgz');
  fs.writeFileSync(garbage, `not a tarball: ${SENTINEL}\n`);
  const unreadable = run(root, 'verify-artifact.mjs', [garbage]);
  assert.equal(unreadable.status, 1, `a candidate that is not an archive must fail; got:\n${unreadable.surface}`);
  assert.match(unreadable.surface, /verify-artifact failed: the tarball could not be decompressed \(Z_DATA_ERROR\)/);
  assert.equal(unreadable.surface.includes(SENTINEL), false, 'the candidate bytes must not be echoed');
  assert.equal(unreadable.surface.includes('garbage.tgz'), false);
  assert.equal(unreadable.surface.includes(MARKER_SHA256), false);
  assert.equal(/^\s+at /m.test(unreadable.surface), false, 'no stack trace is printed');

  // The positive control: a pass still states the bytes it verified.
  const pass = run(root, 'verify-artifact.mjs', [path.join(root, 'release', FILENAME)]);
  assert.equal(pass.status, 0, `the pinned bytes still pass; got:\n${pass.surface}`);
  assert.equal(pass.surface.includes(MARKER_SHA256), true, 'a pass names the bytes it hashed');
});

// ---------------------------------------------------------------------------
// verify-package (pack:check) and pin-relation: the same pin read paths
// ---------------------------------------------------------------------------

test('pack:check refuses the pin read paths through its real entry point', (t) => {
  if (!symlinksWork()) {
    t.skip('this platform cannot create symbolic links');
    return;
  }
  // (a) the pin names a traversal path
  const traversal = fakeRepo();
  writePackageMetadata(traversal);
  writePin(traversal, markerPin({ filename: '../outside.tgz' }));
  const traversalRun = run(traversal, 'verify-package.mjs');
  assert.equal(traversalRun.status, 1, `pack:check must fail; got:\n${traversalRun.surface}`);
  assertRefused(traversalRun.surface, PIN_FILENAME_LABEL);
  assert.equal(traversalRun.surface.includes('all package checks passed'), false);

  // (b) the pin-named artifact is a link out of release/
  const linked = fakeRepo();
  writePackageMetadata(linked);
  writePin(linked, markerPin());
  const outside = path.join(scratch, `pkg-artifact-${fixtureCount += 1}.tgz`);
  fs.writeFileSync(outside, MARKER_BYTES);
  fs.symlinkSync(outside, path.join(linked, 'release', FILENAME), 'file');
  const before = fileSnapshot(outside);
  const linkedRun = run(linked, 'verify-package.mjs');
  assert.equal(linkedRun.status, 1, `pack:check must fail; got:\n${linkedRun.surface}`);
  assertRefused(linkedRun.surface, ARTIFACT_LINK_LABEL);
  assert.equal(linkedRun.surface.includes('all package checks passed'), false);
  assert.deepEqual(fileSnapshot(outside), before, 'the link target must be untouched');
  t.diagnostic(`refusals: ${PIN_FILENAME_LABEL} / ${ARTIFACT_LINK_LABEL}`);
});

test('pin-relation refuses to list differences from a pin target it must not open', (t) => {
  if (!symlinksWork()) {
    t.skip('this platform cannot create symbolic links');
    return;
  }
  // A tree that differs from the pin (any fixture tree does) makes the
  // diagnostic read the pinned archive to name the differing files — the second
  // pin-named read path.
  const linked = fakeRepo();
  writePin(linked, markerPin({ contentSha256: '0'.repeat(64) }));
  const outside = path.join(scratch, `relation-artifact-${fixtureCount += 1}.tgz`);
  fs.writeFileSync(outside, MARKER_BYTES);
  fs.symlinkSync(outside, path.join(linked, 'release', FILENAME), 'file');
  const before = fileSnapshot(outside);

  const diffRun = run(linked, 'pin-relation.mjs');
  assert.equal(diffRun.status, 1, `pin-relation must fail; got:\n${diffRun.surface}`);
  assertRefused(diffRun.surface, ARTIFACT_LINK_LABEL);
  assert.deepEqual(fileSnapshot(outside), before, 'the link target must be untouched');

  // The traversal pin is refused before any path is formed.
  const traversal = fakeRepo();
  writePin(traversal, markerPin({ filename: '../outside.tgz' }));
  const traversalRun = run(traversal, 'pin-relation.mjs');
  assert.equal(traversalRun.status, 1, `pin-relation must fail; got:\n${traversalRun.surface}`);
  assertRefused(traversalRun.surface, PIN_FILENAME_LABEL);
  t.diagnostic(`refusals: ${ARTIFACT_LINK_LABEL} / ${PIN_FILENAME_LABEL}`);
});

test('pin-relation still reports a valid pinned release, reading the artifact it names', () => {
  const root = fakeRepo();
  writePin(root, markerPin({ contentSha256: '0'.repeat(64) }));
  writeArtifact(root);
  // The pinned archive is the marker's own content, and the fixture tree is not
  // that content, so the diagnostic reads the archive and lists differences.
  const result = run(root, 'pin-relation.mjs', ['--json']);
  assert.ok(result.status === 0 || result.status === 1, `the diagnostic reports 0 or 1; got:\n${result.surface}`);
  const report = JSON.parse(result.stdout);
  assert.ok(Array.isArray(report.differing), 'the artifact was read and compared entry by entry');
  assert.equal(report.differing.length > 0, true, 'the fixture tree is not the pinned artifact');
  assert.equal(result.surface.includes(ARTIFACT_LINK_LABEL), false);
});
