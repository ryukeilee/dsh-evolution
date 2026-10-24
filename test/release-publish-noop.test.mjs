/**
 * `npm run release:publish` is a no-op when the committed pin already names the
 * fresh build. That decision describes three files together — the pin, the
 * tarball it names and `release/SHA256SUMS` — so it must not be made from the
 * pinned sha256 alone (a deleted or corrupt tarball and a stale checksum file
 * used to report "nothing to do"). The write side is the same boundary: the
 * destinations must be committed regular files, and a fixed point may only be
 * replaced after the set being replaced was verified complete.
 *
 * These tests exercise the helpers on fixtures in `os.tmpdir()`. They never
 * write to the committed `release/`; every rejection also asserts the fixture was
 * left as it was. The one test that runs the publisher command itself does so
 * with a candidate the inspection already refuses, so the run stops before any
 * install and is checked to have left both the candidate and `release/`
 * untouched; no `release:publish` is ever performed.
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
  REPO_ROOT, builtWithProblems, contentDigestOf, readManifest, readReleaseManifest, readTarEntries, releaseArtifactPath,
} from '../scripts/release/release-lib.mjs';
import {
  inspectPinnedRelease, inspectPinWriteTargets, inspectBuildManifest, inspectCandidateBuild, installFile, installReleaseSet,
} from '../scripts/release/publish-artifact.mjs';

const packageManifest = readManifest();
const pinned = readReleaseManifest();
const FILENAME = `${packageManifest.name}-${packageManifest.version}.tgz`;
/** The committed artifact, copied into fixtures so no test writes to `release/`. */
const ARTIFACT_BYTES = fs.readFileSync(releaseArtifactPath(pinned));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-release-publish-noop-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let fixtureCount = 0;
function freshDir() {
  const dir = path.join(scratch, `set-${fixtureCount += 1}`);
  fs.mkdirSync(dir);
  return dir;
}

function sha256Of(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function modesOf(entries) {
  return [...new Set(entries.map((entry) => entry.mode))].sort((a, b) => a - b).map((mode) => `0o${mode.toString(8)}`);
}

/** Same entries and modes, different file content: a valid archive, other bytes. */
function mutateFirstEntry(bytes) {
  const tar = Buffer.from(zlib.gunzipSync(bytes));
  const firstSize = parseInt(tar.toString('ascii', 124, 136).trim() || '0', 8);
  assert.ok(firstSize > 0, 'the committed artifact must have a non-empty first entry');
  tar[512 + firstSize - 1] ^= 0xff;
  return zlib.gzipSync(tar);
}

function writePin(dir, pin) {
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(pin, null, 2)}\n`);
}

function writeSums(dir, sha256, filename) {
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${sha256}  ${filename}\n`);
}

/**
 * A release set assembled the way `publish-artifact.mjs` writes one, plus the
 * description of the fresh build it claims to pin.
 */
function releaseSet() {
  const dir = freshDir();
  const artifact = path.join(dir, FILENAME);
  fs.writeFileSync(artifact, ARTIFACT_BYTES);
  const entries = readTarEntries(artifact);
  const sha256 = sha256Of(ARTIFACT_BYTES);
  const expected = {
    filename: FILENAME,
    sha256,
    contentSha256: contentDigestOf(entries),
    entries: entries.length,
    modes: modesOf(entries),
  };
  const pin = {
    name: packageManifest.name,
    version: packageManifest.version,
    filename: FILENAME,
    sha256,
    contentSha256: expected.contentSha256,
    entries: entries.length,
    modes: expected.modes,
  };
  writePin(dir, pin);
  writeSums(dir, sha256, FILENAME);
  return { dir, artifact, pin, expected };
}

function inspectOf(set, overrides = {}) {
  return inspectPinnedRelease({
    releaseDir: set.dir,
    packageManifest,
    expected: set.expected,
    ...overrides,
  }).problems;
}

function rewritePin(set, mutate) {
  const file = path.join(set.dir, 'manifest.json');
  const pin = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(pin);
  writePin(set.dir, pin);
}

/** Name + content hash of everything in a fixture directory (symlinks by target). */
function snapshot(dir) {
  return Object.fromEntries(fs.readdirSync(dir).sort().map((name) => {
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return [name, `symlink:${fs.readlinkSync(file)}`];
    return [name, stat.isFile() ? sha256Of(fs.readFileSync(file)) : 'not-a-file'];
  }));
}

/** Every counterexample must fail closed and leave the scene untouched. */
function assertRejected(set, problemPattern, label) {
  const before = snapshot(set.dir);
  const problems = inspectOf(set);
  assert.ok(problems.length > 0, `${label}: an anomalous release set must not be reported as intact`);
  assert.match(problems.join('\n'), problemPattern, `${label}: the failure must name what is wrong`);
  assert.deepEqual(snapshot(set.dir), before, `${label}: the inspection must not modify the release set`);
  return problems;
}

// ---------------------------------------------------------------------------
// the only state that may no-op: complete and mutually consistent
// ---------------------------------------------------------------------------

test('a complete release set passes the no-op check and the write guard', () => {
  const set = releaseSet();
  assert.deepEqual(inspectOf(set), []);
  const targets = inspectPinWriteTargets({ releaseDir: set.dir, filename: FILENAME });
  assert.equal(targets.pinPresent, true);
  assert.deepEqual(targets.problems, []);
});

test('the committed release/ set passes the same inspection', () => {
  // The real pin is checked against the real artifact, so a hand-edited pin
  // field or a checksum file that drifted is caught by `npm test` too. The
  // fresh build is derived from the committed artifact: this asks "does the set
  // agree with itself", not "is the tree the release" (`pack:check` owns that).
  const artifact = releaseArtifactPath(pinned);
  const entries = readTarEntries(artifact);
  const problems = inspectPinnedRelease({
    expected: {
      filename: FILENAME,
      sha256: sha256Of(fs.readFileSync(artifact)),
      contentSha256: contentDigestOf(entries),
      entries: entries.length,
      modes: modesOf(entries),
    },
  }).problems;
  assert.deepEqual(problems, []);
});

test('a pin for another build is not a no-op', () => {
  // The tree moved on, so a fresh build no longer matches the pin. The answer
  // must be "re-pin", never "nothing to do".
  const set = releaseSet();
  const newer = releaseSet();
  newer.expected = { ...newer.expected, sha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64) };
  const problems = inspectOf(set, { expected: newer.expected });
  assert.ok(problems.length > 0);
  assert.match(problems.join('\n'), /is not this build's/);
  assert.match(problems.join('\n'), /pass --force/i);
});

// ---------------------------------------------------------------------------
// counterexample: the pinned tarball is missing or damaged
// ---------------------------------------------------------------------------

test('a missing or truncated pinned artifact fails', () => {
  const missing = releaseSet();
  fs.rmSync(missing.artifact);
  assertRejected(missing, /the pinned artifact is missing from release\//, 'missing tarball');

  const truncated = releaseSet();
  const bytes = fs.readFileSync(truncated.artifact);
  fs.writeFileSync(truncated.artifact, bytes.subarray(0, Math.floor(bytes.length / 2)));
  assertRejected(truncated, /hashes to|not a readable gzipped npm archive/, 'truncated tarball');
});

test('a readable but different artifact fails', () => {
  // Same entries and modes, different file content: the set must be rejected on
  // the byte hash and on the content digest, not only on whether it unpacks.
  const set = releaseSet();
  fs.writeFileSync(set.artifact, mutateFirstEntry(ARTIFACT_BYTES));
  const problems = assertRejected(set, /hashes to/, 'different artifact bytes');
  assert.match(problems.join('\n'), /contains different content than release\/manifest\.json records/, 'the content digest must be checked too');
});

// ---------------------------------------------------------------------------
// counterexample: the attached checksum file is missing or stale
// ---------------------------------------------------------------------------

test('a missing or stale release/SHA256SUMS fails', () => {
  const missing = releaseSet();
  fs.rmSync(path.join(missing.dir, 'SHA256SUMS'));
  assertRejected(missing, /missing release\/SHA256SUMS/, 'missing checksum file');

  const stale = releaseSet();
  fs.writeFileSync(path.join(stale.dir, 'SHA256SUMS'), `${'f'.repeat(64)}  ${FILENAME}\n`);
  assertRejected(stale, /release\/SHA256SUMS does not record exactly the pinned artifact/, 'stale checksum');
});

// ---------------------------------------------------------------------------
// counterexample: the pin does not describe its own set
// ---------------------------------------------------------------------------

test('pin fields that disagree with the set fail', () => {
  const cases = [
    [(pin) => { pin.version = '9.9.9'; }, /pins a version/, 'wrong version'],
    [(pin) => { pin.contentSha256 = 'e'.repeat(64); }, /contentSha256/, 'wrong content digest'],
    [(pin) => { pin.entries += 1; }, /entry count/, 'wrong entry count'],
    [(pin) => { pin.modes = ['0o600']; }, /pins a mode set/, 'wrong modes'],
  ];
  for (const [mutate, pattern, label] of cases) {
    const set = releaseSet();
    rewritePin(set, mutate);
    assertRejected(set, pattern, label);
  }
});

test('an unreadable pin or one naming a path outside release/ fails', () => {
  const corrupt = releaseSet();
  fs.writeFileSync(path.join(corrupt.dir, 'manifest.json'), '{"version": ');
  assertRejected(corrupt, /not a readable pin/, 'corrupt pin JSON');

  const traversal = releaseSet();
  rewritePin(traversal, (pin) => { pin.filename = '../manifest.json'; });
  assertRejected(traversal, /not a plain file name inside release\//, 'path traversal in the pin filename');
});

// ---------------------------------------------------------------------------
// counterexample: release/ holds a symlink instead of a committed file
// ---------------------------------------------------------------------------

test('a symlinked pin, tarball or checksum file is rejected instead of followed', () => {
  // The decoys are byte-identical to a valid set, so a reader that follows the
  // links would call the set intact. lstat must reject the path itself.
  const source = releaseSet();
  const outside = freshDir();
  for (const name of ['manifest.json', FILENAME, 'SHA256SUMS']) {
    fs.copyFileSync(path.join(source.dir, name), path.join(outside, name));
  }
  for (const name of ['manifest.json', FILENAME, 'SHA256SUMS']) {
    const set = releaseSet();
    fs.rmSync(path.join(set.dir, name));
    fs.symlinkSync(path.join(outside, name), path.join(set.dir, name));
    assertRejected(set, /symbolic link/, `${name} symlink`);
  }
});

test('a dangling symlink is named as a link, not as a missing file', () => {
  // `fs.existsSync` follows links, so a broken link reads as absent.
  const set = releaseSet();
  fs.rmSync(set.artifact);
  fs.symlinkSync(path.join(scratch, 'no-such-artifact.tgz'), set.artifact);
  const problems = assertRejected(set, /symbolic link/, 'dangling tarball symlink');
  assert.equal(problems.some((problem) => /missing release\//.test(problem)), false);
});

// ---------------------------------------------------------------------------
// the write guard: no orphan targets, no symlinks, no symlinked release/
// ---------------------------------------------------------------------------

test('writing refuses an orphaned target when no pin exists', () => {
  const artifactOrphan = freshDir();
  fs.writeFileSync(path.join(artifactOrphan, FILENAME), ARTIFACT_BYTES);
  assert.match(
    inspectPinWriteTargets({ releaseDir: artifactOrphan, filename: FILENAME }).problems.join('\n'),
    /orphan artifact/,
  );

  const sumsOrphan = freshDir();
  writeSums(sumsOrphan, sha256Of(ARTIFACT_BYTES), FILENAME);
  assert.match(
    inspectPinWriteTargets({ releaseDir: sumsOrphan, filename: FILENAME }).problems.join('\n'),
    /orphan checksum file/,
  );

  const empty = freshDir();
  const targets = inspectPinWriteTargets({ releaseDir: empty, filename: FILENAME });
  assert.equal(targets.pinPresent, false);
  assert.deepEqual(targets.problems, []);
});

test('writing refuses symlinked destinations and a symlinked or missing release/', () => {
  for (const name of ['manifest.json', FILENAME, 'SHA256SUMS']) {
    const set = releaseSet();
    fs.rmSync(path.join(set.dir, name));
    fs.symlinkSync(path.join(scratch, `decoy-${name}`), path.join(set.dir, name));
    assert.match(
      inspectPinWriteTargets({ releaseDir: set.dir, filename: FILENAME }).problems.join('\n'),
      /symbolic link/,
      `${name} symlink`,
    );
  }

  const real = freshDir();
  const linked = path.join(scratch, `release-link-${fixtureCount += 1}`);
  fs.symlinkSync(real, linked);
  assert.match(
    inspectPinWriteTargets({ releaseDir: linked, filename: FILENAME }).problems.join('\n'),
    /symbolic link, not a real directory/,
  );
  assert.match(
    inspectPinWriteTargets({ releaseDir: path.join(scratch, 'no-such-dir'), filename: FILENAME }).problems.join('\n'),
    /is missing/,
  );
  const asFile = path.join(scratch, `release-as-file-${fixtureCount += 1}`);
  fs.writeFileSync(asFile, '');
  assert.match(
    inspectPinWriteTargets({ releaseDir: asFile, filename: FILENAME }).problems.join('\n'),
    /not a directory/,
  );
});

test('writing refuses an artifact name the existing pin does not cover', () => {
  const set = releaseSet();
  const other = `${packageManifest.name}-0.0.0-old.tgz`;
  fs.copyFileSync(set.artifact, path.join(set.dir, other));
  assert.match(
    inspectPinWriteTargets({ releaseDir: set.dir, filename: other }).problems.join('\n'),
    /orphan artifact/,
  );
});

test('--force may replace only a complete existing fixed point', () => {
  const set = releaseSet();
  const oldName = `${packageManifest.name}-0.0.0-old.tgz`;
  fs.renameSync(set.artifact, path.join(set.dir, oldName));
  rewritePin(set, (pin) => { pin.version = '0.0.0-old'; pin.filename = oldName; });
  const oldPin = JSON.parse(fs.readFileSync(path.join(set.dir, 'manifest.json'), 'utf8'));
  writeSums(set.dir, oldPin.sha256, oldName);

  assert.deepEqual(
    inspectPinnedRelease({ releaseDir: set.dir, selfConsistentOnly: true }).problems,
    [],
    'an older but complete set may be replaced',
  );
  assert.ok(inspectOf(set).length > 0, 'the same set is still not a no-op for the current build');

  fs.truncateSync(path.join(set.dir, oldName), 128);
  assert.ok(
    inspectPinnedRelease({ releaseDir: set.dir, selfConsistentOnly: true }).problems.length > 0,
    'a damaged set must not be replaced',
  );
});

/**
 * Round 14 review, P1: a real tarball copied to another name inside `release/`,
 * with the pin and `SHA256SUMS` moved onto those bytes, is a *self-consistent*
 * set — the byte hash, the content digest, the entry count and the mode set all
 * agree — but it is not this pin's artifact. `--force` only asked whether the set
 * it replaces was complete, so this one looked like a complete fixed point and
 * was replaced. The name a pin may hold is `<name>-<version>.tgz`, and nothing
 * else is a fixed point at all.
 *
 * The same defect is on the write side: `inspectPinWriteTargets` saw no orphan
 * artifact (the new destination simply did not exist yet) and allowed the write.
 */
test('an artifact under any name but <name>-<version>.tgz is not a replaceable pin', () => {
  const conforming = releaseSet();
  assert.deepEqual(
    inspectPinnedRelease({ releaseDir: conforming.dir, selfConsistentOnly: true }).problems,
    [],
    'the fixture itself is a complete, self-consistent pin',
  );

  const alternate = 'alternate-artifact.tgz';
  const set = releaseSet();
  fs.renameSync(set.artifact, path.join(set.dir, alternate));
  rewritePin(set, (pin) => { pin.filename = alternate; });
  writeSums(set.dir, set.pin.sha256, alternate);
  const before = snapshot(set.dir);

  // The premise, recorded: the three files agree with each other under the wrong
  // name, so only the shape of the pinned name can refuse this set.
  assert.equal(sha256Of(fs.readFileSync(path.join(set.dir, alternate))), set.pin.sha256);
  assert.equal(fs.readFileSync(path.join(set.dir, 'SHA256SUMS'), 'utf8'), `${set.pin.sha256}  ${alternate}\n`);

  const previous = inspectPinnedRelease({ releaseDir: set.dir, selfConsistentOnly: true }).problems;
  assert.ok(previous.length > 0, 'a self-consistent set under another name must not be replaceable');
  assert.match(previous.join('\n'), /is not this pin's own "<name>-<version>\.tgz" file name/);
  assert.equal(previous.join('\n').includes(alternate), false, 'the pinned name is not echoed');

  const targets = inspectPinWriteTargets({ releaseDir: set.dir, filename: FILENAME });
  assert.ok(targets.problems.length > 0, 'the write guard must refuse the same set');
  assert.match(targets.problems.join('\n'), /is not this pin's own "<name>-<version>\.tgz" file name/);
  assert.deepEqual(snapshot(set.dir), before, 'the inspection must leave the set as it was');
});

test('the no-op inspection requires release/ itself to be a real directory', () => {
  // A symlinked release/ can point at a complete external set; following it
  // would report that set as this repository's pin.
  const external = releaseSet();
  const linked = path.join(scratch, `release-dir-link-${fixtureCount += 1}`);
  fs.symlinkSync(external.dir, linked);
  const before = snapshot(external.dir);
  const problems = inspectPinnedRelease({ releaseDir: linked, packageManifest, expected: external.expected }).problems;
  assert.ok(problems.length > 0);
  assert.match(problems.join('\n'), /symbolic link, not a real directory/);
  assert.deepEqual(snapshot(external.dir), before, 'a symlinked release/ must not be read into or modified');
});

// ---------------------------------------------------------------------------
// the build manifest: everything it records is checked before it is pinned
// ---------------------------------------------------------------------------

function buildManifestFor(expected) {
  return {
    name: packageManifest.name,
    version: packageManifest.version,
    filename: FILENAME,
    sha256: expected.sha256,
    contentSha256: expected.contentSha256,
    entries: expected.entries,
    modes: expected.modes,
    builtWith: { node: 'v26.12.0', npm: '11.20.0', platform: 'darwin-arm64' },
  };
}

test('the build manifest is checked against the package and the archive before pinning', () => {
  const expected = releaseSet().expected;
  assert.deepEqual(
    inspectBuildManifest({ packageManifest, buildManifest: buildManifestFor(expected), archive: expected }),
    [],
  );

  const cases = [
    [(manifest) => { manifest.modes = ['0o600']; }, /modes/, 'wrong modes'],
    [(manifest) => { manifest.entries += 1; }, /entries/, 'wrong entry count'],
    [(manifest) => { manifest.name = 'other-package'; }, /name/, 'wrong name'],
    [(manifest) => { manifest.version = '9.9.9'; }, /version/, 'wrong version'],
    [(manifest) => { manifest.filename = `${packageManifest.name}-0.0.0.tgz`; }, /filename/, 'wrong filename'],
    [(manifest) => { manifest.sha256 = 'a'.repeat(64); }, /sha256/, 'SHA that is not the built tarball'],
    [(manifest) => { manifest.contentSha256 = 'b'.repeat(64); }, /contentSha256/, 'digest that is not the archive'],
    [(manifest) => { manifest.builtWith = { node: 'garbage', npm: 7, platform: '' }; }, /builtWith/, 'malformed toolchain'],
    [(manifest) => { delete manifest.builtWith; }, /builtWith/, 'missing toolchain'],
    [(manifest) => { manifest.builtWith = { ...manifest.builtWith, apiKey: 'sk-test-secret' }; }, /builtWith carries 1 unexpected property/, 'an extra toolchain property'],
    [(manifest) => { manifest.builtWith = { ...manifest.builtWith, note: 'x'.repeat(4096) }; }, /unexpected property/, 'a long extra property'],
    [(manifest) => { manifest.builtWith = { node: 'v0.0.0', npm: '0.0.0' }; }, /builtWith\.platform is not a string/, 'a missing toolchain field'],
    [(manifest) => { manifest.builtWith = { ...manifest.builtWith, platform: 'a'.repeat(200) }; }, /longer than the \d+-character limit/, 'an oversized toolchain field'],
    [(manifest) => { manifest.builtWith = { ...manifest.builtWith, node: `v26.12.0-${'a'.repeat(200)}` }; }, /builtWith\.node/, 'an oversized version suffix'],
  ];
  for (const [mutate, pattern, label] of cases) {
    const buildManifest = buildManifestFor(expected);
    mutate(buildManifest);
    const problems = inspectBuildManifest({ packageManifest, buildManifest, archive: expected });
    assert.ok(problems.length > 0, `${label}: a mismatched build manifest must not be pinned`);
    assert.match(problems.join('\n'), pattern, `${label}: the failure must name the field`);
  }
});

/**
 * `builtWith` is copied verbatim into `release/manifest.json`, so a property the
 * schema does not know about would be *published*. The schema has to be exact,
 * and a rejection must not echo the value it rejected.
 */
test('the build manifest toolchain record is an exact schema, and rejection does not echo values', () => {
  const expected = releaseSet().expected;
  const sentinel = 'sk-test-secret-do-not-publish';
  const buildManifest = { ...buildManifestFor(expected), builtWith: { ...buildManifestFor(expected).builtWith, apiKey: sentinel } };
  const problems = inspectBuildManifest({ packageManifest, buildManifest, archive: expected });
  assert.equal(problems.length, 1, 'exactly one problem: the unexpected property');
  assert.match(problems[0], /builtWith carries 1 unexpected property; only node, npm, platform may be recorded/);
  assert.equal(problems.join('\n').includes(sentinel), false, 'a rejected value must never be echoed into the log');
  assert.equal(problems.join('\n').includes('apiKey'), false, 'nor may an unexpected property name be echoed: it is candidate data too');

  // The real toolchain record the packer writes is still accepted, so the
  // stricter schema did not start rejecting standard `npm pack` metadata.
  assert.deepEqual(inspectBuildManifest({
    packageManifest,
    buildManifest: { ...buildManifestFor(expected), builtWith: { node: process.version, npm: '11.20.0', platform: `${process.platform}-${process.arch}` } },
    archive: expected,
  }), []);
  assert.deepEqual(
    builtWithProblems(readReleaseManifest().builtWith),
    [],
    'the toolchain recorded by the committed pin still satisfies the schema',
  );
});

/**
 * `builtWith.platform` is copied verbatim into the committed pin, so it has to
 * be a value Node can actually report — `${process.platform}-${process.arch}` —
 * not merely a character-set-clean token. The old bound accepted
 * `sk-test-secret-do-not-publish`, which would have been published. Cross-machine
 * semantics are explicit: every documented OS/architecture pair is accepted
 * regardless of the machine running the check.
 */
test('builtWith.platform is a Node platform-architecture pair, never an echoed value', () => {
  const expected = releaseSet().expected;
  const toolchain = buildManifestFor(expected).builtWith;
  const sentinel = 'sk-test-secret-do-not-publish';

  const refused = [
    ['a credential-shaped sentinel', sentinel],
    ['a bare platform', 'linux'],
    ['an unknown platform', 'plan9-x64'],
    ['an unknown architecture', 'linux-sparc'],
    ['an absolute path', '/Users/example'],
  ];
  for (const [label, platform] of refused) {
    const problems = builtWithProblems({ ...toolchain, platform });
    assert.ok(problems.length > 0, `${label}: must be refused as a platform`);
    assert.match(problems.join('\n'), /builtWith\.platform is not a Node platform-architecture pair/, label);
    // The same record is refused by the manifest check the publisher runs before
    // any write.
    assert.equal(
      inspectBuildManifest({
        packageManifest,
        buildManifest: { ...buildManifestFor(expected), builtWith: { ...toolchain, platform } },
        archive: expected,
      }).length,
      1,
      `${label}: the build manifest check must refuse it too`,
    );
    if (platform === sentinel) {
      assert.equal(problems.join('\n').includes(sentinel), false, 'a rejected platform must not be echoed');
    }
  }

  for (const platform of [
    'darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'linux-ia32', 'linux-ppc64',
    'linux-s390x', 'linux-riscv64', 'linux-loong64', 'win32-x64', 'win32-arm64', 'freebsd-x64',
    'openbsd-arm64', 'android-arm64', 'aix-ppc64', 'sunos-x64', 'haiku-x64',
  ]) {
    assert.deepEqual(builtWithProblems({ ...toolchain, platform }), [], platform);
    assert.deepEqual(
      inspectBuildManifest({
        packageManifest,
        buildManifest: { ...buildManifestFor(expected), builtWith: { ...toolchain, platform } },
        archive: expected,
      }),
      [],
      `${platform}: a build from another supported machine must still be pinnable`,
    );
  }
});

// ---------------------------------------------------------------------------
// the candidate build in --from: its tarball is unpacked, not just hashed
// ---------------------------------------------------------------------------

function verifiedFor(bytes) {
  const file = path.join(freshDir(), FILENAME);
  fs.writeFileSync(file, bytes);
  const entries = readTarEntries(file);
  return {
    filename: FILENAME,
    sha256: sha256Of(bytes),
    contentSha256: contentDigestOf(entries),
    entries: entries.map((entry) => entry.path).sort(),
    entryModes: entries.map((entry) => entry.mode),
    bytes: bytes.length,
  };
}

function distManifestFor(verified, sha256 = verified.sha256) {
  return {
    name: packageManifest.name,
    version: packageManifest.version,
    filename: FILENAME,
    sha256,
    contentSha256: verified.contentSha256,
    entries: verified.entries.length,
    modes: [...new Set(verified.entryModes)].sort((a, b) => a - b).map((mode) => `0o${mode.toString(8)}`),
    builtWith: { node: 'v26.12.0', npm: '11.20.0', platform: 'darwin-arm64' },
  };
}

function writeDist(dir, bytes, buildManifest) {
  fs.writeFileSync(path.join(dir, FILENAME), bytes);
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(buildManifest, null, 2)}\n`);
}

test('a candidate tarball is unpacked and matched to this tree, not just to its own sha', () => {
  const verified = verifiedFor(ARTIFACT_BYTES);

  const goodDir = freshDir();
  writeDist(goodDir, ARTIFACT_BYTES, distManifestFor(verified));
  assert.deepEqual(inspectCandidateBuild({ fromDir: goodDir, filename: FILENAME, packageManifest, verified }).problems, []);

  // A valid archive with different content: its own sha is copied into the
  // build manifest (so the two agree with each other) and the *correct* content
  // digest/entries/modes for this tree are kept. Only unpacking the candidate
  // and comparing its content catches it.
  const swapped = mutateFirstEntry(ARTIFACT_BYTES);
  assert.notEqual(sha256Of(swapped), sha256Of(ARTIFACT_BYTES));
  const swappedDir = freshDir();
  writeDist(swappedDir, swapped, distManifestFor(verified, sha256Of(swapped)));
  const swappedProblems = inspectCandidateBuild({ fromDir: swappedDir, filename: FILENAME, packageManifest, verified }).problems;
  assert.ok(swappedProblems.length > 0, 'a swapped tarball must not be pinnable');
  assert.match(swappedProblems.join('\n'), /does not contain the content this tree builds/, 'the candidate tarball itself must be unpacked and compared');

  // The same swapped bytes with the original sha left in the manifest are
  // rejected on the manifest/archive binding instead.
  const staleDir = freshDir();
  writeDist(staleDir, swapped, distManifestFor(verified));
  assert.match(
    inspectCandidateBuild({ fromDir: staleDir, filename: FILENAME, packageManifest, verified }).problems.join('\n'),
    /build manifest sha256/,
  );

  // Worst case: the manifest is made fully self-consistent with the swapped
  // tarball (sha, content digest, entries and modes all describing it). The
  // manifest/tarball binding now holds, so only the comparison with what this
  // tree builds rejects it.
  const selfConsistentDir = freshDir();
  writeDist(selfConsistentDir, swapped, distManifestFor(verifiedFor(swapped), sha256Of(swapped)));
  assert.match(
    inspectCandidateBuild({ fromDir: selfConsistentDir, filename: FILENAME, packageManifest, verified }).problems.join('\n'),
    /does not contain the content this tree builds/,
  );

  const brokenDir = freshDir();
  writeDist(brokenDir, ARTIFACT_BYTES.subarray(0, 200), distManifestFor(verified));
  assert.match(
    inspectCandidateBuild({ fromDir: brokenDir, filename: FILENAME, packageManifest, verified }).problems.join('\n'),
    /not a readable gzipped npm archive/,
  );

  const linkedDir = freshDir();
  fs.copyFileSync(path.join(goodDir, 'manifest.json'), path.join(linkedDir, 'manifest.json'));
  fs.symlinkSync(path.join(goodDir, FILENAME), path.join(linkedDir, FILENAME));
  assert.match(
    inspectCandidateBuild({ fromDir: linkedDir, filename: FILENAME, packageManifest, verified }).problems.join('\n'),
    /symbolic link/,
  );
});

/**
 * The build manifest is the only thing `release:publish` copies into the pin, so
 * a candidate that is byte-identical and content-identical must still be refused
 * when its `builtWith` carries a property the schema does not know.
 */
test('a candidate build whose toolchain record carries extra metadata is refused before any write', () => {
  const verified = verifiedFor(ARTIFACT_BYTES);
  const sentinel = 'sk-test-secret-do-not-publish';
  const dir = freshDir();
  const buildManifest = { ...distManifestFor(verified), builtWith: { ...distManifestFor(verified).builtWith, apiKey: sentinel } };
  writeDist(dir, ARTIFACT_BYTES, buildManifest);
  const before = snapshot(dir);

  const result = inspectCandidateBuild({ fromDir: dir, filename: FILENAME, packageManifest, verified });
  assert.ok(result.problems.length > 0, 'a candidate with unpublished metadata must not be pinnable');
  assert.match(result.problems.join('\n'), /builtWith carries 1 unexpected property/);
  assert.equal(result.problems.join('\n').includes(sentinel), false, 'the rejected value must not be echoed into the report');
  assert.deepEqual(snapshot(dir), before, 'inspecting a rejected candidate must not touch it');
});

/**
 * Round 3 review counterexample: `builtWith.node` carrying a credential-shaped
 * value. The schema rejected it, but the message quoted the value back
 * (`builtWith.node is not a Node version: "sk-review-sentinel-secret"`), so the
 * secret reached every layer that prints those problems — including the
 * publisher's own error. A rejected value is now reported as its *kind* only,
 * and the review's sentinel is followed through all four surfaces.
 */
test('a rejected toolchain value never reaches a report or the publisher error', () => {
  const expected = releaseSet().expected;
  const sentinel = 'sk-review-sentinel-secret';
  const toolchain = buildManifestFor(expected).builtWith;

  // 1. the schema helper, for every shape a known field can take wrong.
  const shapes = [
    ['a credential-shaped string', sentinel],
    ['an object holding it', { token: sentinel }],
    ['an array holding it', [sentinel]],
    ['a number', 12345],
    ['a boolean', true],
  ];
  for (const [label, value] of shapes) {
    const problems = builtWithProblems({ ...toolchain, node: value });
    assert.ok(problems.length > 0, `${label}: builtWith.node must be rejected`);
    assert.match(problems.join('\n'), /builtWith\.node/, `${label}: the failure must name the field`);
    assert.equal(problems.join('\n').includes(sentinel), false, `${label}: the rejected value must not be echoed`);
  }

  // 2. the build manifest check that the publisher runs before pinning.
  const manifestProblems = inspectBuildManifest({
    packageManifest,
    buildManifest: { ...buildManifestFor(expected), builtWith: { ...toolchain, node: sentinel } },
    archive: expected,
  });
  assert.match(manifestProblems.join('\n'), /builtWith\.node is not a Node version: a string/);
  assert.equal(manifestProblems.join('\n').includes(sentinel), false, 'the manifest report must not echo the value');

  // 3. the candidate check: the tarball is the committed artifact byte for byte,
  // so the only reason to refuse it is the toolchain record it claims.
  const verified = verifiedFor(ARTIFACT_BYTES);
  const dir = freshDir();
  const candidateManifest = { ...distManifestFor(verified), builtWith: { ...distManifestFor(verified).builtWith, node: sentinel } };
  writeDist(dir, ARTIFACT_BYTES, candidateManifest);
  const beforeCandidate = snapshot(dir);
  const result = inspectCandidateBuild({ fromDir: dir, filename: FILENAME, packageManifest, verified });
  assert.deepEqual(result.problems, ['builtWith.node is not a Node version: a string'], 'the candidate is refused for the toolchain record only');
  assert.equal(result.problems.join('\n').includes(sentinel), false, 'the candidate report must not echo the value');
  assert.deepEqual(snapshot(dir), beforeCandidate, 'inspecting a rejected candidate must not touch it');

  // 4. the publisher's own error surface, and the proof that the refusal
  // happens before any install: `release/` must be byte-identical afterwards.
  const releaseDir = path.join(REPO_ROOT, 'release');
  const beforeRelease = snapshot(releaseDir);
  const run = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, 'scripts/release/publish-artifact.mjs'), '--from', dir],
    { encoding: 'utf8' },
  );
  assert.notEqual(run.status, 0, 'the publisher must refuse a candidate whose toolchain record is rejected');
  const surface = `${run.stdout}\n${run.stderr}`;
  assert.match(surface, /builtWith\.node is not a Node version/);
  assert.match(surface, /nothing was pinned/, 'the run must say that it wrote nothing');
  assert.equal(surface.includes(sentinel), false, 'the publisher error must not echo the rejected value');
  assert.equal(surface.includes('sk-review'), false, 'nor any part of it');
  assert.deepEqual(snapshot(releaseDir), beforeRelease, 'a rejected candidate must be refused before anything is pinned');
  assert.deepEqual(snapshot(dir), beforeCandidate, 'and the candidate directory must be left as it was');
});

// ---------------------------------------------------------------------------
// installing a file: exclusive staging names, no following, no foreign cleanup
// ---------------------------------------------------------------------------

function stagingNameFor(target, nonce, processId = 'test') {
  return path.join(path.dirname(target), `.${path.basename(target)}.publish-${processId}-${nonce}.tmp`);
}

test('installing never reuses, follows or deletes a pre-existing staging name', () => {
  const dir = freshDir();
  const target = path.join(dir, FILENAME);
  const marker = stagingNameFor(target, 'collision');
  fs.writeFileSync(marker, 'marker');
  assert.throws(
    () => installFile({ target, contents: Buffer.from('released'), nonce: 'collision', processId: 'test' }),
    /staging name .* already taken/,
  );
  assert.equal(fs.readFileSync(marker, 'utf8'), 'marker', 'an entry this call did not create must be preserved');
  assert.equal(fs.existsSync(target), false);

  const linkedDir = freshDir();
  const linkedTarget = path.join(linkedDir, FILENAME);
  const decoy = path.join(freshDir(), 'outside');
  fs.writeFileSync(decoy, 'outside');
  const link = stagingNameFor(linkedTarget, 'link');
  fs.symlinkSync(decoy, link);
  assert.throws(
    () => installFile({ target: linkedTarget, contents: Buffer.from('released'), nonce: 'link', processId: 'test' }),
    /staging name .* already taken/,
  );
  assert.equal(fs.readFileSync(decoy, 'utf8'), 'outside', 'a pre-existing staging symlink must not be followed');
  assert.equal(fs.readlinkSync(link), decoy, 'the pre-existing symlink must be preserved');
  assert.equal(fs.existsSync(linkedTarget), false);
});

test('installing replaces a symlinked target instead of writing through it', () => {
  const dir = freshDir();
  const outside = path.join(freshDir(), 'outside');
  fs.writeFileSync(outside, 'outside');
  const target = path.join(dir, FILENAME);
  fs.symlinkSync(outside, target);
  installFile({ target, contents: Buffer.from('released'), nonce: 'installed', processId: 'test' });
  assert.equal(fs.lstatSync(target).isFile(), true, 'the target directory entry is replaced by a regular file');
  assert.equal(fs.readFileSync(target, 'utf8'), 'released');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside', 'the link target must be untouched');
  assert.deepEqual(fs.readdirSync(dir), [FILENAME], 'no staging file is left behind');
});

/**
 * The release set is staged in full before any of it is renamed into place, so a
 * failure on the last staging step must leave the previous set byte-identical.
 * The failure is deterministic: the third staging name is pre-created, which the
 * exclusive open refuses without touching the caller's entry.
 */
test('a release set that fails while staging leaves the previous set untouched', () => {
  const set = releaseSet();
  const before = snapshot(set.dir);
  const pinContents = fs.readFileSync(path.join(set.dir, 'manifest.json'));
  const taken = path.join(set.dir, `.manifest.json.publish-test-third.tmp`);
  fs.writeFileSync(taken, 'caller staging file\n');
  const withMarker = snapshot(set.dir);

  assert.throws(
    () => installReleaseSet([
      { target: path.join(set.dir, FILENAME), contents: Buffer.from('new artifact\n') },
      { target: path.join(set.dir, 'SHA256SUMS'), contents: Buffer.from('new sums\n') },
      { target: path.join(set.dir, 'manifest.json'), contents: Buffer.from('{}\n') },
    ], { nonce: 'third', processId: 'test' }),
    /staging name .* already taken/,
  );

  assert.deepEqual(snapshot(set.dir), withMarker, 'no target may be replaced and no staging file may be left behind');
  assert.deepEqual(
    Object.keys(snapshot(set.dir)).sort(),
    [...Object.keys(before), path.basename(taken)].sort(),
    'the only addition is the staging file this call did not create',
  );
  assert.equal(fs.readFileSync(path.join(set.dir, 'manifest.json')).equals(pinContents), true, 'the pin is unchanged');
  assert.equal(fs.readFileSync(taken, 'utf8'), 'caller staging file\n', 'a taken staging name is never overwritten or removed');

  // The unchanged set is still a complete, self-consistent release set.
  fs.rmSync(taken);
  assert.deepEqual(inspectPinnedRelease({ releaseDir: set.dir, selfConsistentOnly: true }).problems, []);
});

// ---------------------------------------------------------------------------
// the publisher only reports a no-op through these checks
// ---------------------------------------------------------------------------

test('the publisher gates the no-op and the write on the whole set', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'scripts/release/publish-artifact.mjs'), 'utf8');
  const start = source.indexOf('if (pinPresent && !options.force)');
  const end = source.indexOf("console.log(`release/ already pins");
  assert.ok(start >= 0 && end > start, 'the no-op branch must be locatable');
  const branch = source.slice(start, end);
  assert.match(branch, /inspectPinnedRelease\(\{ expected: expectedBuild \}\)/, 'the no-op must verify the whole set');
  assert.match(branch, /existing\.problems\.length > 0/, 'and must fail when that verification reports a problem');
  assert.match(source, /inspectPinWriteTargets\(\{ filename \}\)/, 'the write path must check its targets');
  assert.match(source, /selfConsistentOnly: true/, '--force must verify the set it replaces');
  const candidateIndex = source.indexOf('inspectCandidateBuild({');
  assert.match(source, /inspectCandidateBuild\(\{ fromDir: options\.from, filename, packageManifest: manifest, verified \}\)/, 'the candidate tarball must be unpacked and checked');
  const installIndex = source.indexOf('installReleaseSet([');
  assert.ok(candidateIndex >= 0 && installIndex > candidateIndex, 'the candidate build must be checked before anything is pinned');
  assert.equal(/fs\.copyFileSync\(built, artifactPath\)/.test(source), false, 'the artifact must not be copied directly onto the target');
  assert.equal(/fs\.writeFileSync\(existingPath,/.test(source), false, 'the pin must not be written directly onto the target');
  // The three files are installed as one set, in the order that keeps a pin from
  // ever naming files that are not installed yet.
  const installed = source.slice(installIndex, source.indexOf(']);', installIndex));
  assert.match(installed, /target: artifactPath, contents: builtBytes/, 'the artifact must be installed through the staging helper, from the bytes the candidate check verified');
  assert.match(installed, /target: existingPath, contents:/, 'the pin must be installed through the staging helper');
  assert.ok(installed.indexOf('artifactPath') < installed.indexOf("path.join(RELEASE_DIR, 'SHA256SUMS')"), 'the artifact must be staged before the checksum file');
  assert.ok(installed.indexOf('SHA256SUMS') < installed.indexOf('existingPath'), 'the pin must be staged last');
  assert.equal(/installFile\(\{ target: artifactPath/.test(source), false, 'the set must be installed as one set, not file by file');
  const lib = fs.readFileSync(path.join(REPO_ROOT, 'scripts/release/release-lib.mjs'), 'utf8');
  assert.match(lib, /fs\.openSync\(temporary, 'wx'/, 'the staging file must be created exclusively');
  assert.equal(/fs\.rmSync\(temporary, \{ force: true \}\)/.test(lib), true, 'only the staging files this call created are removed');
});
