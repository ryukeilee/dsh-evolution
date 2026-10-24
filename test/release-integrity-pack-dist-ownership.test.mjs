/**
 * `scripts/release/pack.mjs` writes into a directory the caller chooses, and
 * that directory may already hold the caller's own files. The bug these tests
 * pin: the script removed `--dist` recursively before writing, so packing into
 * a scratch directory deleted unrelated files, and `--dist .` / `--dist release`
 * deleted the repository or the committed pin.
 *
 * The contract that replaces it:
 *
 *   - unrelated files survive a successful build, byte for byte, and other files
 *     in the directory are never read or removed;
 *   - a repeated successful run is defined: same content, same files, no growth;
 *   - a foreign or incomplete entry under a target name, a corrupted tarball, a
 *     manifest whose fields do not describe its own tarball, a name that escapes
 *     the directory, a build of another version, and a symbolic link (dangling
 *     or not) are all refusals that leave the directory exactly as it was;
 *   - packing or metadata generation failing never removes the previous output;
 *   - the repository root, `release/`, and any directory containing the
 *     repository are refused before anything is written.
 *
 * Every fixture lives in `os.tmpdir()`. The tests never write to the
 * repository's `dist/` or `release/`, and they never touch a developer's
 * untracked files there.
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
  DIST_DIR,
  REPO_ROOT,
  RELEASE_DIR,
  archiveContentDigest,
  readManifest,
  readTarEntries,
  treeContentDigest,
} from '../scripts/release/release-lib.mjs';import { assertUsableDist, installFile, installOutputSet, targetPath } from '../scripts/release/pack.mjs';

const PACK = path.join(REPO_ROOT, 'scripts', 'release', 'pack.mjs');
const manifest = readManifest();
const FILENAME = `${manifest.name}-${manifest.version}.tgz`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-pack-dist-ownership-'));
const seed = path.join(scratch, 'seed-output');

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function tempDir(label) {
  return fs.mkdtempSync(path.join(scratch, `${label}-`));
}

function runPack(dist, env = {}) {
  return spawnSync(process.execPath, [PACK, '--dist', dist], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256OfFile(file) {
  return sha256(fs.readFileSync(file));
}

/** Every entry in `dir` with its bytes (or link target), for "unchanged" checks. */
function snapshot(dir) {
  const state = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) state[name] = `symlink -> ${fs.readlinkSync(file)}`;
    else if (stat.isFile()) state[name] = `file ${sha256OfFile(file)}`;
    else state[name] = `mode ${stat.mode.toString(8)}`;
  }
  return state;
}

/**
 * One real build, reused as a valid "previous output" so each failure case below
 * costs no pack of its own instead of one per case.
 */
function seededOutput() {
  if (!fs.existsSync(path.join(seed, FILENAME))) {
    const result = runPack(seed);
    assert.equal(result.status, 0, `packing the seed build failed:\n${result.stderr}`);
  }
  return seed;
}

function previousOutput(label) {
  const dir = tempDir(label);
  fs.cpSync(seededOutput(), dir, { recursive: true });
  return dir;
}

/** Rewrite a copied output's manifest in place, keeping everything else as it is. */
function rewriteManifest(dir, damage) {
  const file = path.join(dir, 'manifest.json');
  const build = JSON.parse(fs.readFileSync(file, 'utf8'));
  damage(build);
  fs.writeFileSync(file, `${JSON.stringify(build, null, 2)}\n`);
}

/**
 * On POSIX, `npm` resolves through PATH, so a wrapper makes a chosen step fail
 * without touching the network or the real toolchain. The tests that use it also
 * start from a state where a guard regression cannot write anything, because
 * packing happens before installation.
 */
function writeNpmWrapper(label, body) {
  const bin = fs.mkdtempSync(path.join(scratch, `npm-wrapper-${label}-`));
  const npm = path.join(bin, 'npm');
  fs.writeFileSync(npm, `#!/bin/sh\n${body}`);
  fs.chmodSync(npm, 0o755);
  return { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
}

/** A failing `npm`, failing on every invocation. */
function failingNpmEnv() {
  return writeNpmWrapper('all', 'exit 1\n');
}

/** The real `npm` on PATH, for a wrapper that only fails a chosen invocation. */
function findNpm() {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, 'npm');
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* not here */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// success: unrelated files survive, repeated runs are defined
// ---------------------------------------------------------------------------

test('a build installs only its three files and leaves the caller\'s files untouched', () => {
  const dir = tempDir('markers');
  fs.writeFileSync(path.join(dir, 'user-data.txt'), 'user data\n');
  fs.mkdirSync(path.join(dir, 'keep'));
  fs.writeFileSync(path.join(dir, 'keep', 'note.md'), 'note\n');

  const result = runPack(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(dir).sort(), [FILENAME, 'SHA256SUMS', 'keep', 'manifest.json', 'user-data.txt'].sort());
  assert.equal(fs.readFileSync(path.join(dir, 'user-data.txt'), 'utf8'), 'user data\n');
  assert.equal(fs.readFileSync(path.join(dir, 'keep', 'note.md'), 'utf8'), 'note\n');
  assert.equal(fs.readdirSync(dir).filter((name) => name.includes('release-pack')).length, 0, 'no install temporaries are left behind');

  // The installed tarball is still the tree's declared content: fixing the
  // output directory did not change what is packed.
  const tarball = path.join(dir, FILENAME);
  assert.equal(archiveContentDigest(tarball), treeContentDigest());
  const entries = readTarEntries(tarball);
  const sha = sha256OfFile(tarball);
  assert.equal(fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8'), `${sha}  ${FILENAME}\n`);

  const build = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(build.name, manifest.name);
  assert.equal(build.version, manifest.version);
  assert.equal(build.filename, FILENAME);
  assert.equal(build.sha256, sha);
  assert.equal(build.contentSha256, archiveContentDigest(tarball));
  assert.equal(build.entries, entries.length);
  assert.deepEqual(build.modes, [...new Set(entries.map((entry) => entry.mode))].sort((a, b) => a - b).map((mode) => `0o${mode.toString(8)}`));
  assert.equal(typeof build.builtWith.node, 'string');
  assert.equal(typeof build.builtWith.npm, 'string');
  assert.equal(typeof build.builtWith.platform, 'string');
});

test('running twice over the same directory is defined: same files, same bytes, no growth', () => {
  const dir = tempDir('repeat');
  fs.writeFileSync(path.join(dir, 'user-data.txt'), 'user data\n');
  assert.equal(runPack(dir).status, 0);
  const first = snapshot(dir);

  const second = runPack(dir);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(snapshot(dir), first);
  assert.match(second.stdout, /replaced the previous release:pack output/);
});

// ---------------------------------------------------------------------------
// refusals: nothing under a target name is overwritten without proof
// ---------------------------------------------------------------------------

test('a foreign file under the tarball name is a collision, not something to replace', () => {
  const dir = tempDir('collision');
  fs.writeFileSync(path.join(dir, 'user-data.txt'), 'user data\n');
  fs.writeFileSync(path.join(dir, FILENAME), 'not a build\n');
  const before = snapshot(dir);

  const result = runPack(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to overwrite an incomplete output/);
  assert.deepEqual(snapshot(dir), before);
});

test('a manifest.json this tool did not write is refused, not replaced', () => {
  const dir = tempDir('foreign-manifest');
  fs.writeFileSync(path.join(dir, 'user-data.txt'), 'user data\n');
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{"hello":"world"}\n');
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), 'whatever\n');
  const before = snapshot(dir);

  const result = runPack(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a release:pack build manifest/);
  assert.deepEqual(snapshot(dir), before);
});

test('a manifest without the fields this tool writes is not proof of ownership', () => {
  const cases = [
    ['builtWith missing', (build) => { delete build.builtWith; }],
    ['entries not a positive integer', (build) => { build.entries = 0; }],
    ['modes empty', (build) => { build.modes = []; }],
    ['modes not octal', (build) => { build.modes = ['rw-r--r--']; }],
    ['builtWith incomplete', (build) => { build.builtWith = { node: build.builtWith.node }; }],
    ['builtWith extra property', (build) => { build.builtWith.apiKey = 'sk-test-secret-do-not-publish'; }],
    ['builtWith credential-shaped platform', (build) => { build.builtWith.platform = 'sk-test-secret-do-not-publish'; }],
    ['builtWith oversized value', (build) => { build.builtWith.platform = 'a'.repeat(200); }],
    ['contentSha256 not a digest', (build) => { build.contentSha256 = 'not-a-digest'; }],
  ];
  for (const [label, damage] of cases) {
    const dir = previousOutput(`manifest-fields-${label.replace(/[^a-z]+/gi, '-')}`);
    rewriteManifest(dir, damage);
    const before = snapshot(dir);

    const result = runPack(dir);
    assert.notEqual(result.status, 0, `${label}: expected a refusal`);
    assert.match(result.stderr, /not a release:pack build manifest/, label);
    assert.deepEqual(snapshot(dir), before, `${label}: the directory must be left as it was`);
  }
});

test('a manifest whose entries or modes do not describe the tarball is refused', () => {  const countDir = previousOutput('manifest-entry-count');
  const countTarball = path.join(countDir, FILENAME);
  const entries = readTarEntries(countTarball);
  rewriteManifest(countDir, (build) => { build.entries = entries.length + 1; });
  const countBefore = snapshot(countDir);

  const countResult = runPack(countDir);
  assert.notEqual(countResult.status, 0, 'a mismatched entry count must be refused');
  assert.match(countResult.stderr, /its recorded entry count does not match the tarball beside it/);
  assert.deepEqual(snapshot(countDir), countBefore, 'the mismatched output must be left as it was');

  const modeDir = previousOutput('manifest-modes');
  rewriteManifest(modeDir, (build) => { build.modes = ['0o600']; });
  const modeBefore = snapshot(modeDir);

  const modeResult = runPack(modeDir);
  assert.notEqual(modeResult.status, 0, 'a mismatched mode set must be refused');
  assert.match(modeResult.stderr, /its recorded mode set does not match the tarball beside it/);
  assert.deepEqual(snapshot(modeDir), modeBefore, 'the mismatched output must be left as it was');
});

/**
 * `builtWith` is copied verbatim into `release/manifest.json` by
 * `release:publish`, so the packer's own re-read of an output has to enforce the
 * same exact schema — and a rejection must not print the value it rejected.
 */
test('a previous output carrying extra toolchain metadata is refused without echoing it', () => {
  const dir = previousOutput('manifest-extra-toolchain');
  const sentinel = 'sk-test-secret-do-not-publish';
  rewriteManifest(dir, (build) => { build.builtWith.apiKey = sentinel; });
  const before = snapshot(dir);

  const result = runPack(dir);
  assert.notEqual(result.status, 0, 'a toolchain record with an unknown property must not be overwritten as ours');
  assert.match(result.stderr, /not a release:pack build manifest/);
  assert.match(result.stderr, /unexpected property/);
  assert.equal(result.stderr.includes(sentinel), false, 'the rejected value must not be echoed into the log');
  assert.equal(result.stderr.includes('apiKey'), false, 'nor may the rejected property name be echoed');
  assert.deepEqual(snapshot(dir), before, 'the directory must be left as it was');
});

/**
 * `builtWith.platform` used to be bounded by a character set only, so a
 * credential-shaped value (`sk-test-secret-do-not-publish`) was a valid
 * platform and would have been copied into `release/manifest.json` verbatim by
 * the publisher. It is now a Node `${process.platform}-${process.arch}` pair,
 * and a rejection reports the field and the category, never the value.
 */
test('a credential-shaped platform in a previous output is refused without echoing it', () => {
  const dir = previousOutput('manifest-platform-sentinel');
  const sentinel = 'sk-test-secret-do-not-publish';
  rewriteManifest(dir, (build) => { build.builtWith.platform = sentinel; });
  const before = snapshot(dir);

  const result = runPack(dir);
  assert.notEqual(result.status, 0, 'a credential-shaped platform must not pass as a toolchain record');
  assert.match(result.stderr, /not a release:pack build manifest/);
  assert.match(result.stderr, /builtWith\.platform is not a Node platform-architecture pair/);
  assert.equal(result.stderr.includes(sentinel), false, 'the rejected value must not be echoed into the log');
  assert.deepEqual(snapshot(dir), before, 'the directory must be left as it was');
});

test('a manifest whose recorded version escapes the output directory is refused before it is followed', () => {
  const parent = tempDir('traversal');
  const dir = path.join(parent, 'dist');
  fs.mkdirSync(dir);
  const victim = path.join(parent, 'victim.tgz');
  fs.writeFileSync(victim, 'precious\n');
  const escaping = {
    name: manifest.name,
    version: '0.0.1/../../victim',
    filename: `${manifest.name}-0.0.1/../../victim.tgz`,
    sha256: 'a'.repeat(64),
    contentSha256: 'b'.repeat(64),
    entries: 1,
    modes: ['0o644'],
    builtWith: { node: 'v0.0.0', npm: '0.0.0', platform: 'test' },
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(escaping, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${escaping.sha256}  ${escaping.filename}\n`);
  const before = snapshot(dir);

  const result = runPack(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a release:pack build manifest/);
  assert.deepEqual(fs.readdirSync(parent).sort(), ['dist', 'victim.tgz']);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'precious\n');
  assert.deepEqual(snapshot(dir), before);
});

test('a build of another version is refused and left in place, with a fresh --dist suggested', () => {
  const dir = previousOutput('other-version');
  const priorFilename = `${manifest.name}-0.0.0-prior.tgz`;
  fs.renameSync(path.join(dir, FILENAME), path.join(dir, priorFilename));
  rewriteManifest(dir, (build) => {
    build.version = '0.0.0-prior';
    build.filename = priorFilename;
  });
  const prior = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${prior.sha256}  ${priorFilename}\n`);
  const before = snapshot(dir);

  const result = runPack(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /a build of another version/);
  assert.match(result.stderr, /Pass a new --dist/);
  assert.deepEqual(snapshot(dir), before);
});

test('a corrupted tarball in an otherwise intact output is refused and preserved', () => {
  const dir = previousOutput('corrupted-tarball');
  fs.writeFileSync(path.join(dir, 'user-data.txt'), 'user data\n');
  fs.writeFileSync(path.join(dir, FILENAME), 'corrupted\n');
  const before = snapshot(dir);

  const result = runPack(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /damaged or incomplete/);
  assert.deepEqual(snapshot(dir), before);
});

test('a symbolic link at a target name is refused, whether it dangles or not', () => {
  const destinations = [
    // Broken on purpose: `existsSync` reports this link as absent, and the old
    // code would have renamed its own file over the caller's link.
    { label: 'dangling', target: './not-created-yet.txt', exists: false },
    { label: 'resolving', target: './user-data.txt', exists: true },
  ];
  for (const name of ['manifest.json', 'SHA256SUMS', FILENAME]) {
    for (const destination of destinations) {
      const label = `${destination.label}-${name.replace(/[^a-z0-9]+/gi, '-')}`;
      const dir = tempDir(`symlink-${label}`);
      fs.writeFileSync(path.join(dir, 'user-data.txt'), 'user data\n');
      const link = path.join(dir, name);
      fs.symlinkSync(destination.target, link);
      assert.equal(fs.existsSync(link), destination.exists, `${label}: the fixture has the expected link shape`);
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true, `${label}: the fixture is a symbolic link`);
      const before = snapshot(dir);

      const result = runPack(dir);
      assert.notEqual(result.status, 0, `${label}: a symbolic link must be refused`);
      assert.match(result.stderr, /refusing to overwrite .*not a regular file.*symlink/s, label);
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true, `${label}: the link must survive`);
      assert.equal(fs.readlinkSync(link), destination.target, `${label}: the link must still point where it did`);
      assert.deepEqual(snapshot(dir), before, `${label}: the directory must be left as it was`);
    }
  }
});

test('a symlinked or non-directory output path is refused instead of followed', () => {
  const parent = tempDir('dist-shape');
  const file = path.join(parent, 'out-file');
  fs.writeFileSync(file, 'file\n');
  const fromFile = runPack(file);
  assert.notEqual(fromFile.status, 0);
  assert.match(fromFile.stderr, /it exists and is not a directory/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'file\n');

  const realDir = path.join(parent, 'real-dir');
  fs.mkdirSync(realDir);
  fs.writeFileSync(path.join(realDir, 'user-data.txt'), 'user data\n');
  const link = path.join(parent, 'link-dir');
  fs.symlinkSync(realDir, link);
  const fromLink = runPack(link);
  assert.notEqual(fromLink.status, 0);
  assert.match(fromLink.stderr, /it is a symbolic link/);
  assert.deepEqual(fs.readdirSync(realDir), ['user-data.txt'], 'the link target must not be written through');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
});

// ---------------------------------------------------------------------------
// failures that must not touch the caller's directory
// ---------------------------------------------------------------------------

test('a failing pack leaves the previous output exactly as it was', { skip: process.platform === 'win32' }, () => {
  const dir = previousOutput('pack-failure');
  fs.writeFileSync(path.join(dir, 'user-data.txt'), 'user data\n');
  const before = snapshot(dir);

  const result = runPack(dir, failingNpmEnv());
  assert.notEqual(result.status, 0);
  assert.deepEqual(snapshot(dir), before, 'a pack failure must not touch the existing output');
});

test('a metadata failure after a successful pack leaves the previous output byte-identical', (t) => {
  const realNpm = process.platform === 'win32' ? null : findNpm();
  if (!realNpm) {
    t.skip('no npm on PATH to proxy to');
    return;
  }
  const dir = previousOutput('metadata-failure');
  fs.writeFileSync(path.join(dir, 'user-data.txt'), 'user data\n');
  const before = snapshot(dir);
  const quoted = `'${realNpm.replace(/'/g, `'\\''`)}'`;
  // `pack` is proxied to the real npm, so the build and the reproducibility check
  // both succeed and the run reaches the metadata step (`npm --version`), which
  // is where this fails. That is the path the pack-failure test above misses.
  const env = writeNpmWrapper(
    'metadata',
    `if [ "$1" = "--version" ]; then\n  echo "npm wrapper: the metadata step fails" >&2\n  exit 1\nfi\nexec ${quoted} "$@"\n`,
  );

  const result = runPack(dir, env);
  assert.notEqual(result.status, 0, 'a metadata failure must fail the run');
  assert.match(result.stderr, /the metadata step fails/, 'the failure must come from the metadata step, not from packing');
  assert.match(result.stdout, /content digest \(environment-independent\)/, 'the pack must have succeeded before the metadata step failed');
  assert.deepEqual(snapshot(dir), before, 'a metadata failure must not touch the existing output');
});

test('an install whose temporary name already exists leaves that file alone', () => {
  const dir = tempDir('temporary-collision');
  const dest = path.join(dir, FILENAME);
  const temporary = path.join(dir, 'injected-temporary.tmp');
  fs.writeFileSync(temporary, 'marker\n');
  const before = snapshot(dir);

  assert.throws(() => installFile(dest, Buffer.from('new bytes'), temporary), /EEXIST/);
  assert.deepEqual(snapshot(dir), before, 'a colliding temporary name must be left untouched');
  assert.equal(fs.readFileSync(temporary, 'utf8'), 'marker\n');
  assert.equal(fs.existsSync(dest), false, 'the target must not be created when the install fails');
});

test('a read-only output directory fails without leaving install temporaries', { skip: process.getuid?.() === 0 }, () => {
  const dir = previousOutput('read-only');
  const before = snapshot(dir);
  fs.chmodSync(dir, 0o500);
  try {
    assert.notEqual(runPack(dir).status, 0);
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  assert.deepEqual(snapshot(dir), before);
});

/**
 * The three output files are installed as one set: every byte is staged next to
 * its destination before any of them is renamed into place. So a failure while
 * *writing* — the realistic one, a full disk — happens before the previous
 * output has been touched at all.
 *
 * The failure is deterministic rather than simulated: the third staging name is
 * already taken, and the exclusive open refuses it.
 */
test('a failure while staging the output set leaves the previous output intact', () => {
  const dir = previousOutput('install-set-failure');
  fs.writeFileSync(path.join(dir, 'user-data.txt'), 'user data\n');
  const before = snapshot(dir);
  const taken = path.join(dir, '.taken-by-the-caller.tmp');
  fs.writeFileSync(taken, 'caller file\n');
  const withMarker = snapshot(dir);

  const contents = (name) => fs.readFileSync(path.join(dir, name));
  let asked = 0;
  assert.throws(
    () => installOutputSet(dir, [
      { name: FILENAME, contents: contents(FILENAME) },
      { name: 'manifest.json', contents: contents('manifest.json') },
      { name: 'SHA256SUMS', contents: contents('SHA256SUMS') },
    ], () => {
      asked += 1;
      return asked === 3 ? taken : path.join(dir, `.injected-staging-${asked}.tmp`);
    }),
    /staging name .* already taken/,
  );
  assert.equal(asked, 3, 'the failure must happen on the last staging step, after two files were staged');
  assert.deepEqual(snapshot(dir), withMarker, 'no output file may be replaced and no staging file may be left behind');
  assert.equal(fs.readFileSync(taken, 'utf8'), 'caller file\n', 'the caller\'s file is preserved');
  assert.deepEqual(
    Object.keys(snapshot(dir)).sort(),
    [...Object.keys(before), path.basename(taken)].sort(),
    'the only addition is the file the test created',
  );

  // The previous output is still complete, so the next real run replaces it
  // rather than reporting a half-written state.
  fs.rmSync(taken);
  const rerun = runPack(dir);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(rerun.stdout, /replaced the previous release:pack output/);
  assert.equal(fs.readFileSync(path.join(dir, 'user-data.txt'), 'utf8'), 'user data\n');
});

/**
 * The narrow window that remains: every staging step succeeded, and a rename
 * failed anyway (a permission change, a directory swap). That leaves a mixed
 * set — new tarball, old manifest and checksum file — which is *detected* and
 * preserved, never absorbed into a passing build.
 *
 * This fixture builds that state by hand, because a rename cannot be made to
 * fail without changing the directory; the two tests below produce it through
 * the real install path instead, by failing the second and the first rename.
 */
test('a mixed set from an interrupted install is refused and preserved', () => {
  const dir = previousOutput('interrupted-install');
  fs.writeFileSync(path.join(dir, 'user-data.txt'), 'user data\n');

  // A valid archive with different content: mutate one data byte of the first
  // entry, which leaves every header (and its checksum) untouched.
  const tar = Buffer.from(zlib.gunzipSync(fs.readFileSync(path.join(dir, FILENAME))));
  const firstSize = parseInt(tar.toString('ascii', 124, 136).replace(/\0/g, '').trim(), 8);
  assert.ok(firstSize > 0, 'the seed build must have a non-empty first entry');
  tar[512 + firstSize - 1] ^= 0xff;
  fs.writeFileSync(path.join(dir, FILENAME), zlib.gzipSync(tar));
  const before = snapshot(dir);

  const result = runPack(dir);
  assert.notEqual(result.status, 0, 'a mixed set must not be treated as a previous output');
  assert.match(result.stderr, /damaged or incomplete/, 'the manifest no longer describes the tarball beside it');
  assert.match(result.stderr, /pass a new --dist|delete those files/);
  assert.deepEqual(snapshot(dir), before, 'a mixed set is preserved for inspection, never repaired in place');
});

test('a manifest whose contentSha256 does not describe its tarball is refused even when sha256 does', () => {
  const cases = [    // The bytes match the recorded sha256 exactly; only the content digest is
    // forged/stale. Accepting either digest would let this pass.
    ['contentSha256 only', (build) => { build.contentSha256 = 'c'.repeat(64); }],
    // The mirror image: the content digest is right, the compressed bytes are not.
    ['sha256 only', (build) => { build.sha256 = 'd'.repeat(64); }],
  ];
  for (const [label, damage] of cases) {
    const dir = previousOutput(`manifest-digest-${label.replace(/[^a-z]+/gi, '-')}`);
    rewriteManifest(dir, damage);
    const before = snapshot(dir);

    const result = runPack(dir);
    assert.notEqual(result.status, 0, `${label}: expected a refusal`);
    assert.match(result.stderr, /records a different (sha256|contentSha256|sha256 and contentSha256) than the file has/, label);
    assert.match(result.stderr, /damaged or incomplete/, label);
    assert.deepEqual(snapshot(dir), before, `${label}: the directory must be left as it was`);
  }
});

// ---------------------------------------------------------------------------
// the narrow rename window: what a partial set is, and how it is reported
// ---------------------------------------------------------------------------

/**
 * A real second-rename failure.
 *
 * Staging cannot be made to fail on POSIX for a reason the previous test's
 * fixture does not already cover, but a rename can: a target that is a directory
 * cannot be replaced by a file. Turning the *second* target into a directory
 * inside the staging hook means the first rename has already replaced its file
 * when the second one fails.
 *
 * That is the state the tool has to name: the same errno category is printed
 * when nothing at all was replaced, and "inspect this partial set" and "retry"
 * are different instructions. Before this round both printed the identical line,
 * `a filesystem operation failed (EXIT)`, which reads exactly like the failure
 * before any write.
 */
test('a rename that fails after the first target was replaced reports the partial set', () => {
  const dir = previousOutput('rename-failure-second');
  const manifestPath = path.join(dir, 'manifest.json');
  const sumsPath = path.join(dir, 'SHA256SUMS');
  const sumsBefore = fs.readFileSync(sumsPath);
  const newTarball = zlib.gzipSync(Buffer.from('a different build\n'));

  let asked = 0;
  let failure;
  try {
    installOutputSet(dir, [
      { name: FILENAME, contents: newTarball },
      { name: 'manifest.json', contents: fs.readFileSync(manifestPath) },
      { name: 'SHA256SUMS', contents: sumsBefore },
    ], (target) => {
      asked += 1;
      if (asked === 2) {
        // Staging still succeeds (the staging name is a different entry); only
        // the rename onto `manifest.json` cannot replace a directory.
        fs.rmSync(manifestPath);
        fs.mkdirSync(manifestPath);
      }
      return path.join(dir, `.injected-staging-${asked}.tmp`);
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure, 'the failing rename must be reported, not swallowed');
  assert.match(
    failure.message,
    /failed after 1 of 3 target\(s\) were replaced \(EISDIR\)/,
    'the report must say how much of the set was already replaced, not only the errno',
  );
  assert.match(failure.message, /inspect it before retrying/);
  assert.equal(/[\\/]/.test(failure.message), false, 'the report must not reprint the caller-supplied path');

  // The partial state is real, and nothing else moved: the tarball holds the new
  // bytes, the failing target is the directory the rename could not replace, the
  // checksum file is untouched, and no staging file is left behind.
  assert.deepEqual(fs.readFileSync(path.join(dir, FILENAME)), newTarball);
  assert.equal(fs.lstatSync(manifestPath).isDirectory(), true);
  assert.deepEqual(fs.readFileSync(sumsPath), sumsBefore);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);

  // The next run refuses that partial set by name and leaves it for inspection.
  const before = snapshot(dir);
  const result = runPack(dir);
  assert.notEqual(result.status, 0, 'a partial set must not be accepted as a previous output');
  assert.match(result.stderr, /refusing to overwrite manifest\.json/);
  assert.match(result.stderr, /not a regular file \(directory\)/);
  assert.deepEqual(snapshot(dir), before, 'the partial set is preserved, never repaired in place');
});

/**
 * The same failure on the *first* rename: nothing was replaced, and the report
 * has to say so — a caller can retry that state instead of inspecting a mixed
 * set.
 */
test('a rename that fails on the first target reports that nothing was replaced', () => {
  const dir = tempDir('rename-failure-first');
  const names = ['a.txt', 'b.txt', 'c.txt'];
  for (const name of names) fs.writeFileSync(path.join(dir, name), `old ${name}\n`);
  const first = path.join(dir, names[0]);

  let asked = 0;
  let failure;
  try {
    installOutputSet(dir, names.map((name) => ({ name, contents: Buffer.from(`new ${name}\n`) })), (target) => {
      asked += 1;
      if (asked === 1) {
        fs.rmSync(first);
        fs.mkdirSync(first);
      }
      return path.join(dir, `.injected-staging-${asked}.tmp`);
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure, 'the failing rename must be reported');
  assert.match(failure.message, /failed before any target was replaced \(EISDIR\)/);
  assert.equal(/already replaced/.test(failure.message), false, 'nothing was replaced, so no partial set may be claimed');
  assert.equal(fs.lstatSync(first).isDirectory(), true, 'the target the rename could not replace is untouched');
  for (const name of names.slice(1)) {
    assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), `old ${name}\n`, `${name}: a target after the failing rename must not be replaced`);
  }
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
});

/**
 * A staging file that cannot be *created* is not a name collision.
 *
 * The exclusive open used to report every errno as "the staging name is already
 * taken", which is a claim only `EEXIST` supports: a missing or unwritable
 * directory sent the reader looking for an existing file that is not there.
 * `ENOTDIR` is used here because it is deterministic and needs no privileges.
 */
test('a staging file that cannot be created is not reported as a name collision', () => {
  const dir = tempDir('staging-cause');
  const blocker = path.join(dir, 'not-a-directory');
  fs.writeFileSync(blocker, 'blocker\n');
  const before = snapshot(dir);

  let failure;
  try {
    installOutputSet(dir, [{ name: FILENAME, contents: Buffer.from('bytes') }], () => path.join(blocker, 'staging.tmp'));
  } catch (error) {
    failure = error;
  }

  assert.ok(failure, 'the failed staging open must be reported');
  assert.match(failure.message, /the staging file cannot be created \(ENOTDIR\)/);
  assert.equal(/already taken/.test(failure.message), false, 'only EEXIST may be reported as a taken name');
  assert.equal(/[\\/]/.test(failure.message), false, 'the report must not reprint a path');
  assert.deepEqual(snapshot(dir), before, 'nothing may be created or replaced');
});

/**
 * The destination directory is re-identified immediately before anything is
 * installed.
 *
 * The caller's own guard runs before packing, and packing, hashing and
 * verification take seconds; a `--dist` replaced by a symbolic link inside that
 * window used to send every staging file and every rename wherever the link
 * points, outside the directory the caller proved it owned. The install path
 * therefore lstat-checks each destination directory before its first staging
 * open. The interval between that check and the open is not defended — this is a
 * correctness check, not a security sandbox.
 */
test('a destination directory replaced by a symbolic link before the install is refused', () => {
  const outside = tempDir('install-link-outside');
  const linkDir = path.join(tempDir('install-link-target'), 'dist');
  fs.symlinkSync(outside, linkDir);
  const outsideBefore = snapshot(outside);

  let failure;
  try {
    installOutputSet(linkDir, [{ name: FILENAME, contents: Buffer.from('released bytes') }]);
  } catch (error) {
    failure = error;
  }

  assert.ok(failure, 'a linked destination must be refused, not followed');
  assert.match(failure.message, /the target directory is no longer a real directory \(a symbolic link\)/);
  assert.equal(/[\\/]/.test(failure.message), false, 'the report must not reprint a path');
  assert.deepEqual(snapshot(outside), outsideBefore, 'nothing may be written through the link');
  assert.equal(fs.lstatSync(linkDir).isSymbolicLink(), true, 'the link itself is preserved');
  assert.deepEqual(fs.readdirSync(linkDir), [], 'no staging file may be created through the link');
});

// ---------------------------------------------------------------------------
// the repository and the committed pin are never output directories
// ---------------------------------------------------------------------------

test('the output-path guard refuses the repository, release/, and any container of them', () => {
  // Called directly, never through the CLI: if the guard regressed, running the
  // real script with `--dist <repo>` would remove the repository before npm ever
  // ran, so a failure here must not have a way to touch the working tree.
  const refused = [
    REPO_ROOT,
    RELEASE_DIR,
    path.join(RELEASE_DIR, 'nested'),
    path.dirname(REPO_ROOT),
    // In-repo source trees: these are not the build output directory, so a build
    // there would write a package into tracked sources or tests.
    ...['lib', 'test', 'docs', 'scripts', 'scripts/release'].map((name) => path.join(REPO_ROOT, name)),
  ];
  const pinBefore = sha256OfFile(path.join(RELEASE_DIR, 'manifest.json'));
  const repoBefore = fs.readdirSync(REPO_ROOT).sort();

  for (const target of refused) {
    assert.throws(() => assertUsableDist(target), /refusing to build into/, `${target}: must be refused`);
  }
  // The default build directory, a directory inside it, a dedicated directory
  // outside the repository, and a fresh one are all accepted.
  for (const target of [DIST_DIR, path.join(DIST_DIR, 'nested'), tempDir('guard-accepts'), path.join(scratch, 'not-created-yet')]) {
    assert.doesNotThrow(() => assertUsableDist(target), `${target}: must be accepted`);
  }
  // A symlink is not silently followed, wherever it points.
  const link = path.join(tempDir('guard-link'), 'link');
  fs.symlinkSync(REPO_ROOT, link);
  assert.throws(() => assertUsableDist(link), /refusing to build into/);

  assert.equal(sha256OfFile(path.join(RELEASE_DIR, 'manifest.json')), pinBefore, 'the committed pin must not change');
  assert.deepEqual(fs.readdirSync(REPO_ROOT).sort(), repoBefore, 'the repository root must not change');
});

test('a default dist/ that is a symlink makes every in-repo output path inadmissible', () => {
  // A throwaway repository, because this fixture needs `dist` to be a symlink:
  // doing that in the real checkout would mean touching a developer's output
  // directory, and following the link would make lib/ the allowed build root.
  const fakeRepo = path.join(tempDir('fake-repo'), 'pkg');
  fs.mkdirSync(path.join(fakeRepo, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(fakeRepo, 'release'), { recursive: true });
  fs.writeFileSync(path.join(fakeRepo, 'release', 'manifest.json'), '{}\n');
  fs.symlinkSync(path.join(fakeRepo, 'lib'), path.join(fakeRepo, 'dist'));
  const context = {
    repoRoot: fakeRepo,
    releaseDir: path.join(fakeRepo, 'release'),
    defaultDistDir: path.join(fakeRepo, 'dist'),
  };

  for (const target of ['lib', 'lib/nested', 'dist', 'dist/nested', 'release', '.']) {
    assert.throws(
      () => assertUsableDist(path.join(fakeRepo, target), context),
      /refusing to build into/,
      `${target}: must be refused while dist/ is a symlink`,
    );
  }
  // A directory outside that repository is still usable.
  assert.doesNotThrow(() => assertUsableDist(tempDir('fake-repo-outside'), context));

  // With a real dist/ in the same fake repository, dist/ is admissible again and
  // lib/ stays refused.
  fs.unlinkSync(path.join(fakeRepo, 'dist'));
  fs.mkdirSync(path.join(fakeRepo, 'dist'));
  assert.doesNotThrow(() => assertUsableDist(path.join(fakeRepo, 'dist'), context));
  assert.doesNotThrow(() => assertUsableDist(path.join(fakeRepo, 'dist', 'nested'), context));
  assert.throws(() => assertUsableDist(path.join(fakeRepo, 'lib'), context), /refusing to build into/);
  assert.deepEqual(fs.readdirSync(path.join(fakeRepo, 'lib')), [], 'no fixture may have written into lib/');
});

/**
 * A name that merely *begins* with two dots is an ordinary directory name.
 *
 * The containment helper compared `path.relative()` with a bare
 * `startsWith('..')`, so `..build` looked like the parent directory. Both
 * refusals that keep a build out of the committed pin (`inside release/`) and
 * out of tracked sources (`inside the repository but not the default dist/`)
 * were skipped for `<repo>/release/..build` and `<repo>/..build`.
 */
test('a directory whose name only begins with two dots is still inside its container', () => {
  const fakeRepo = path.join(tempDir('dotdot-repo'), 'pkg');
  fs.mkdirSync(path.join(fakeRepo, 'release'), { recursive: true });
  fs.mkdirSync(path.join(fakeRepo, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(fakeRepo, 'release', 'manifest.json'), '{}\n');
  const context = {
    repoRoot: fakeRepo,
    releaseDir: path.join(fakeRepo, 'release'),
    defaultDistDir: path.join(fakeRepo, 'dist'),
  };
  const insideRelease = path.join(fakeRepo, 'release', '..build');
  const insideRepo = path.join(fakeRepo, '..build');
  fs.mkdirSync(insideRelease);
  fs.mkdirSync(insideRepo);

  assert.throws(
    () => assertUsableDist(insideRelease, context),
    /inside release\//,
    'a directory inside release/ is refused by its container, whatever it is called',
  );
  assert.throws(
    () => assertUsableDist(insideRepo, context),
    /inside the repository but/,
    'an in-repo path outside the default dist/ stays refused',
  );

  // The real parent is still the parent, a sibling whose name begins with `..`
  // is still outside this repository, and a nested directory of the default
  // output directory is still admitted: nothing here became stricter.
  assert.throws(() => assertUsableDist(path.dirname(fakeRepo), context), /contains the repository/);
  const sibling = path.join(path.dirname(fakeRepo), '..sibling-build');
  fs.mkdirSync(sibling);
  assert.doesNotThrow(() => assertUsableDist(sibling, context));
  assert.doesNotThrow(() => assertUsableDist(path.join(fakeRepo, 'dist', '..nested'), context));

  assert.deepEqual(fs.readdirSync(insideRelease), []);
  assert.deepEqual(fs.readdirSync(insideRepo), []);
});

test('target names that are not one plain component are refused', () => {
  const dir = tempDir('target-names');
  for (const name of ['../escape.tgz', 'nested/manifest.json', '..', '.', 'a\\b', '']) {
    assert.throws(() => targetPath(dir, name), /refusing to touch/, JSON.stringify(name));
  }
  assert.equal(targetPath(dir, FILENAME), path.join(dir, FILENAME));
  assert.deepEqual(fs.readdirSync(dir), []);
});
