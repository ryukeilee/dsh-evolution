/**
 * Round 5 review: four blockers and one class of unsafe output in the build and
 * publish boundary. Each counterexample below is built from the committed
 * artifact (or a real `release:pack` run) inside a private `os.tmpdir()`
 * directory; nothing here writes `release/`, `dist/`, a fixed byte or a real
 * credential. Every sentinel is synthetic.
 *
 *   1. `readTarEntries` proved that a payload's padding block *exists* but never
 *      that its bytes are zero. A marker written into the padding changed the
 *      tarball's sha256, kept `contentSha256` identical, and was accepted by
 *      both the candidate check and `tar` — so hidden data could ship.
 *   2. A `package/` prefix was stripped *when present*, so an archive with no
 *      `package/` root produced the same digest while `npm install` could not
 *      find `package.json` in it. The path is now rebuilt from `name` + the
 *      ustar `prefix` and must be a normalised file under one `package/` root.
 *   3. `builtWith.node`/`builtWith.npm` accepted a pre-release suffix of one to
 *      ten lowercase letters plus digits per identifier, which is a
 *      credential-shaped label: `v26.12.0-secrettok` or `11.20.0-sklive` passed
 *      and `release:publish` copied it into `release/manifest.json` verbatim.
 *      Both fields now validate against the pre-release tags Node and npm
 *      actually publish, per field (`PRERELEASE_TAGS`), plus a bounded numeric
 *      counter. The values in this file were chosen because the reviewed
 *      grammar *accepted* them — a sentinel with a hyphen, uppercase letter or
 *      underscore proved nothing, because those were refused all along.
 *   4. `release:pack` overwrote an existing output whose manifest carried an
 *      unknown top-level property, silently dropping the caller's field. The
 *      manifest schema is now closed and the whole directory is preserved.
 *   5. Candidate metadata, the `--from`/`--dist` paths, pin values and tar entry
 *      paths were interpolated into rejection messages. Every surface named
 *      below now reports a stable field name or position instead.
 *
 * Also covered: the candidate tarball is read once, so the bytes the publisher
 * installs are the bytes it hashed and unpacked; and TAR header metadata the
 * content digest does not cover (owner ids/names, timestamp, device numbers,
 * link name, magic, bytes after a string field) is held to the canonical values
 * both real producers write.
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
  BUILD_MANIFEST_FIELDS,
  REPO_ROOT,
  builtWithProblems,
  contentDigestOf,
  readManifest,
  readReleaseManifest,
  readTarEntries,
  releaseArtifactPath,
} from '../scripts/release/release-lib.mjs';
import { inspectBuildManifest, inspectCandidateBuild, inspectPinnedRelease } from '../scripts/release/publish-artifact.mjs';
import { assertUsableDist, targetPath } from '../scripts/release/pack.mjs';

const packageManifest = readManifest();
const pinned = readReleaseManifest();
const FILENAME = `${packageManifest.name}-${packageManifest.version}.tgz`;
const ARTIFACT = releaseArtifactPath(pinned);
const ARTIFACT_BYTES = fs.readFileSync(ARTIFACT);
const PACK = path.join(REPO_ROOT, 'scripts', 'release', 'pack.mjs');
const PUBLISH = path.join(REPO_ROOT, 'scripts', 'release', 'publish-artifact.mjs');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-build-boundary-'));
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

/** `0o644`/`0o755` strings, the spelling `release/manifest.json` records. */
function modesOf(entries) {
  return [...new Set(entries.map((entry) => entry.mode))].sort((a, b) => a - b).map((mode) => `0o${mode.toString(8)}`);
}

function captureError(call) {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

/** Name + content hash of everything in a directory, for "left as it was" checks. */
function snapshot(dir) {
  const state = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) state[name] = `symlink -> ${fs.readlinkSync(file)}`;
    else if (stat.isFile()) state[name] = `file ${sha256Of(fs.readFileSync(file))}`;
    else state[name] = `mode ${stat.mode.toString(8)}`;
  }
  return state;
}

/** The committed release set, hashed so a test can prove it was not written to. */
function committedReleaseSnapshot() {
  return Object.fromEntries(['manifest.json', FILENAME, 'SHA256SUMS'].map((name) => {
    const file = path.join(REPO_ROOT, 'release', name);
    const stat = fs.lstatSync(file);
    return [name, stat.isFile() ? sha256Of(fs.readFileSync(file)) : `not-a-file:${stat.mode}`];
  }));
}

/** `{ filename, sha256, contentSha256, entries, entryModes }` describing a tarball. */
function verifiedFor(bytes) {
  const entries = readTarEntries(Buffer.from(bytes));
  return {
    filename: FILENAME,
    sha256: sha256Of(bytes),
    contentSha256: contentDigestOf(entries),
    entries: entries.map((entry) => entry.path).sort(),
    entryModes: entries.map((entry) => entry.mode),
    bytes: bytes.length,
  };
}

/** A build manifest that is fully self-consistent with `bytes` unless overridden. */
function buildManifestNamed(verified, overrides = {}) {
  return {
    name: packageManifest.name,
    version: packageManifest.version,
    filename: FILENAME,
    sha256: verified.sha256,
    contentSha256: verified.contentSha256,
    entries: verified.entries.length,
    modes: [...new Set(verified.entryModes)].sort((a, b) => a - b).map((mode) => `0o${mode.toString(8)}`),
    builtWith: { node: 'v26.12.0', npm: '11.20.0', platform: 'darwin-arm64' },
    ...overrides,
  };
}

/** Write a `--from` candidate and return its directory. */
function writeCandidate(bytes, buildManifest) {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, FILENAME), bytes);
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(buildManifest, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${sha256Of(bytes)}  ${FILENAME}\n`);
  return dir;
}

// ---------------------------------------------------------------------------
// a minimal ustar writer and an in-place artifact rewriter
// ---------------------------------------------------------------------------

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

/** The canonical metadata both real producers write (measured; see release-lib). */
const CANONICAL = {
  mode: 0o644, uid: 0, gid: 0, timestamp: 499162500, type: '0',
  magic: 'ustar\u000000', uname: '', gname: '', linkname: '', prefix: '',
};

/** Repair a header's checksum after a field was rewritten by a test. */
function reseal(header) {
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
}

/**
 * Visit every header of an uncompressed artifact. `visit` mutates the header or
 * the payload directly; the caller re-seals headers it changed.
 */
function walkEntries(tar, visit) {
  let offset = 0;
  let index = 0;
  for (;;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return;
    const size = parseInt(header.toString('latin1', 124, 136).replace(/\0| /g, ''), 8) || 0;
    const dataStart = offset + 512;
    const padded = dataStart + Math.ceil(size / 512) * 512;
    visit({ header, index, offset, size, dataStart, padded });
    offset = padded;
    index += 1;
  }
}

/** One-entry canonical archive; every field is overridable so a test can mis-set it. */
function tarWith(options = {}) {
  const fields = { ...CANONICAL, ...options };
  const payload = fields.contents ?? Buffer.from('shipped\n');
  const header = Buffer.alloc(512, 0);
  header.write(fields.name, 0, 100, 'latin1');
  header.write(octal(fields.mode, 8), 100, 8, 'latin1');
  header.write(octal(fields.uid, 8), 108, 8, 'latin1');
  header.write(octal(fields.gid, 8), 116, 8, 'latin1');
  header.write(octal(payload.length, 12), 124, 12, 'latin1');
  header.write(octal(fields.timestamp, 12), 136, 12, 'latin1');
  header.write(fields.type, 156, 1, 'latin1');
  header.write(fields.linkname, 157, 100, 'latin1');
  header.write(fields.magic, 257, 8, 'latin1');
  header.write(fields.uname, 265, 32, 'latin1');
  header.write(fields.gname, 297, 32, 'latin1');
  header.write(octal(fields.devMajor ?? 0, 8), 329, 8, 'latin1');
  header.write(octal(fields.devMinor ?? 0, 8), 337, 8, 'latin1');
  header.write(fields.prefix, 345, 155, 'latin1');
  if (fields.afterPrefix) fields.afterPrefix.copy(header, 500);
  reseal(header);
  const data = Buffer.alloc(Math.ceil(payload.length / 512) * 512, 0);
  payload.copy(data);
  return zlib.gzipSync(Buffer.concat([header, data, Buffer.alloc(1024, 0)]));
}

function writeTarball(label, bytes) {
  const file = path.join(freshDir(), label);
  fs.writeFileSync(file, bytes);
  return file;
}

/** The system tar's listing, or `null` when this platform has no usable `tar`. */
function systemTarListOf(file) {
  const probe = spawnSync('tar', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return null;
  return spawnSync('tar', ['-tzf', file], { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// blocker 1: the bytes that complete a payload block
// ---------------------------------------------------------------------------

const PADDING_MARKER = 'sk-review-sentinel-padding';

test('a non-zero payload padding block is refused, and the content digest cannot see it', (t) => {
  const tar = Buffer.from(zlib.gunzipSync(ARTIFACT_BYTES));
  let target = null;
  walkEntries(tar, (entry) => {
    if (target === null && entry.size > 0 && entry.size % 512 !== 0 && entry.padded - entry.dataStart - entry.size > PADDING_MARKER.length) {
      target = entry;
    }
  });
  assert.ok(target !== null, 'the committed artifact must have an entry with padding room');
  // A marker in the padding: the header is untouched, so its checksum still
  // matches, and the entry's own bytes are unchanged.
  tar.write(PADDING_MARKER, target.dataStart + target.size, PADDING_MARKER.length, 'latin1');
  const tampered = zlib.gzipSync(tar);
  const file = writeTarball('padding-marker.tgz', tampered);

  // The review's premise: the archive still unpacks, and the content identity is
  // byte-identical to the released one, because the digest never reads padding.
  const system = systemTarListOf(file);
  if (system === null) t.diagnostic('no system tar on PATH; the reader still refused the padding');
  else assert.equal(system.status, 0, 'the system tar accepts the tampered archive, which is why the digest alone cannot catch it');
  assert.equal(contentDigestOf(readTarEntries(Buffer.from(ARTIFACT_BYTES))), pinned.contentSha256);

  const error = captureError(() => readTarEntries(file));
  assert.match(error.message, /tar entry \d+ at byte \d+: the padding after the entry's payload is not zero/);
  assert.equal(error.message.includes(PADDING_MARKER), false, 'the marker must not be echoed');

  // End to end: a candidate whose manifest is fully self-consistent with the
  // tampered bytes (sha256 of those bytes, the genuine content digest, entries
  // and modes) is refused, and neither side of the scene changes.
  const verified = verifiedFor(ARTIFACT_BYTES);
  const dir = writeCandidate(tampered, buildManifestNamed({
    ...verified,
    sha256: sha256Of(tampered),
    contentSha256: pinned.contentSha256,
    entries: pinned.entries,
    modes: pinned.modes,
  }));
  const beforeCandidate = snapshot(dir);
  const beforeRelease = committedReleaseSnapshot();

  const result = inspectCandidateBuild({ fromDir: dir, filename: FILENAME, packageManifest, verified });
  assert.ok(result.problems.length > 0, 'a marker in the padding must not be pinnable');
  assert.match(result.problems.join('\n'), /is not a readable gzipped npm archive/);
  assert.match(result.problems.join('\n'), /the padding after the entry's payload is not zero/);
  assert.equal(result.problems.join('\n').includes(PADDING_MARKER), false);
  assert.equal(result.archive, null, 'no archive description may come from a rejected archive');
  assert.deepEqual(snapshot(dir), beforeCandidate, 'the candidate directory must be left as it was');
  assert.deepEqual(committedReleaseSnapshot(), beforeRelease, 'the committed release set must be untouched');

  // The released bytes themselves have zero padding, so the stricter rule does
  // not describe a different artifact than the one that shipped.
  assert.equal(readTarEntries(ARTIFACT).length, pinned.entries);
});

// ---------------------------------------------------------------------------
// blocker 2: the archive's single `package/` root
// ---------------------------------------------------------------------------

/**
 * Rewrite every entry's header `name` (and clear the prefix) with `map`, which
 * receives the current full name and returns the new one.
 */
function renamingEntries(bytes, map) {
  const tar = Buffer.from(zlib.gunzipSync(bytes));
  walkEntries(tar, ({ header }) => {
    const prefix = header.toString('latin1', 345, 500).replace(/\0.*$/s, '');
    const name = header.toString('latin1', 0, 100).replace(/\0.*$/s, '');
    const full = prefix ? `${prefix}/${name}` : name;
    const renamed = map(full);
    header.fill(0, 0, 100);
    header.write(renamed, 0, 100, 'latin1');
    header.fill(0, 345, 500);
    reseal(header);
  });
  return zlib.gzipSync(tar);
}

test('a rootless archive is refused even though it produces the pinned content digest', (t) => {
  const rootless = renamingEntries(ARTIFACT_BYTES, (name) => name.replace(/^package\//, ''));
  const file = writeTarball('rootless.tgz', rootless);

  // Why this mattered: the unpacked content is *identical* to the released one,
  // so the digest could not tell the two archives apart, while `npm install`
  // cannot find `package.json` without the `package/` root.
  const listed = systemTarListOf(file);
  if (listed === null) t.diagnostic('no system tar on PATH; the reader still refused the rootless archive');
  else {
    assert.equal(listed.status, 0, 'the rootless archive is still a valid tar');
    assert.equal(listed.stdout.split('\n').some((line) => line.startsWith('package/')), false, 'no entry lives under package/ any more');
  }

  // The review's symptom, reproduced directly: installing the rootless archive
  // cannot find `package.json` at all. The archive is otherwise a valid tar of
  // the released files, so only the root rule separates the two.
  const installDir = freshDir();
  fs.writeFileSync(path.join(installDir, 'package.json'), '{"name":"rootless-probe","version":"1.0.0"}\n');
  const installed = spawnSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', file], {
    cwd: installDir,
    encoding: 'utf8',
    timeout: 120000,
    // A private cache: the probe never writes the user's npm cache.
    env: { ...process.env, npm_config_cache: path.join(installDir, '.npm-cache') },
  });
  if (installed.error) t.diagnostic(`no usable npm to prove the install failure: ${installed.error.message}`);
  else {
    assert.notEqual(installed.status, 0, 'a rootless archive must not install');
    assert.match(`${installed.stdout}\n${installed.stderr}`, /Could not read package\.json/);
  }

  const error = captureError(() => readTarEntries(file));
  assert.match(error.message, /tar entry \d+ at byte \d+: the entry path is not a file under the archive's single package\/ root/);

  const verified = verifiedFor(ARTIFACT_BYTES);
  const dir = writeCandidate(rootless, buildManifestNamed({
    ...verified,
    sha256: sha256Of(rootless),
    contentSha256: pinned.contentSha256,
    entries: pinned.entries,
    modes: pinned.modes,
  }));
  const beforeCandidate = snapshot(dir);
  const beforeRelease = committedReleaseSnapshot();
  const result = inspectCandidateBuild({ fromDir: dir, filename: FILENAME, packageManifest, verified });
  assert.ok(result.problems.length > 0, 'a rootless archive must not be pinnable');
  assert.match(result.problems.join('\n'), /not a file under the archive's single package\/ root/);
  assert.equal(result.archive, null);
  assert.deepEqual(snapshot(dir), beforeCandidate);
  assert.deepEqual(committedReleaseSnapshot(), beforeRelease);
});

test('an extra root, a doubled separator and a traversal segment are refused', () => {
  const cases = [
    ['extra root', (name) => name.replace(/^package\//, 'vendor/')],
    ['prefix escape', (name) => name.replace(/^package\//, 'package/../')],
    ['doubled separator', (name) => name.replace(/^package\//, 'package//')],
    ['absolute', (name) => `/${name}`],
  ];
  for (const [label, map] of cases) {
    const file = writeTarball(`${label.replace(/\s+/g, '-')}.tgz`, renamingEntries(ARTIFACT_BYTES, map));
    assert.throws(
      () => readTarEntries(file),
      /the entry path is not a (normalised relative path|file under the archive's single package\/ root)/,
      `${label}: must be refused`,
    );
  }
});

test('the ustar prefix field is part of the path, and cannot be used to leave package/', () => {
  // prefix + name is joined the way tar joins it, then validated: a prefix that
  // carries the root is accepted, one that escapes it is not.
  const [underRoot] = readTarEntries(writeTarball('prefix-ok.tgz', tarWith({ name: 'index.js', prefix: 'package/lib' })));
  assert.equal(underRoot.path, 'lib/index.js');

  for (const [label, options] of [
    ['prefix rootless', { name: 'index.js', prefix: 'vendor' }],
    ['prefix traversal', { name: 'index.js', prefix: '../package' }],
    ['name traversal', { name: '../package/index.js' }],
    ['prefix dot', { name: 'index.js', prefix: '.' }],
  ]) {
    assert.throws(
      () => readTarEntries(writeTarball(`${label.replace(/\s+/g, '-')}.tgz`, tarWith(options))),
      /the entry path is not a (normalised relative path|file under the archive's single package\/ root)/,
      label,
    );
  }

  // The escape hatch for synthetic fixtures that are not npm packages, which no
  // release entry point uses.
  const [rootless] = readTarEntries(writeTarball('rootless-fixture.tgz', tarWith({ name: 'index.js' })), { requirePackageRoot: false });
  assert.equal(rootless.path, 'index.js');
  assert.throws(
    () => readTarEntries(writeTarball('rootless-fixture-strict.tgz', tarWith({ name: 'index.js' }))),
    /single package\/ root/,
    'the default stays strict',
  );
  // The call chain is what makes the rule real: every release entry point
  // (pack, publish, verify-artifact, verify-package, pin-relation and the host
  // acceptance runner) reads archives through `readTarEntries` with the default,
  // so none of them may opt out of the root rule. The module that declares the
  // option is not a call site and is skipped.
  for (const relative of ['scripts/release', 'scripts/acceptance']) {
    for (const name of fs.readdirSync(path.join(REPO_ROOT, relative))) {
      if (!name.endsWith('.mjs') || name === 'release-lib.mjs') continue;
      const source = fs.readFileSync(path.join(REPO_ROOT, relative, name), 'utf8');
      assert.equal(
        /requirePackageRoot\s*:\s*false/.test(source), false,
        `${relative}/${name} must keep the package/ root rule`,
      );
    }
  }
});

test('every committed artifact and a real npm pack output still pass the root rule', (t) => {
  const artifacts = fs.readdirSync(path.join(REPO_ROOT, 'release')).filter((name) => name.endsWith('.tgz'));
  assert.ok(artifacts.length >= 14, 'the committed artifacts must still be there');
  for (const name of artifacts) {
    const entries = readTarEntries(path.join(REPO_ROOT, 'release', name));
    assert.ok(entries.length > 0, `${name} parsed to no entries`);
    assert.equal(entries.some((entry) => entry.path.startsWith('package/')), false, `${name}: paths are relative to package/`);
  }

  const dir = path.join(scratch, 'npm-pack-root');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'dsh-root-probe', version: '0.0.0', files: ['index.js'] }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'index.js'), 'export default 1;\n');
  const packed = spawnSync('npm', ['pack', '--json', '--pack-destination', dir, '--ignore-scripts'], { cwd: dir, encoding: 'utf8' });
  if (packed.status !== 0) {
    t.diagnostic(`no usable npm to produce a fresh pack: ${packed.stderr}`);
    return;
  }
  const info = JSON.parse(packed.stdout)[0];
  const entries = readTarEntries(path.join(dir, info.filename));
  assert.deepEqual(entries.map((entry) => entry.path).sort(), ['index.js', 'package.json']);
});

// ---------------------------------------------------------------------------
// blocker 3: the toolchain version grammar
// ---------------------------------------------------------------------------

const TOOLCHAIN_SENTINEL = 'sk-review-sentinel-toolchain';
/**
 * A bare lowercase word of nine letters, which is far shorter than any field bound
 * and is exactly the shape of a lowercase credential. It matters that the
 * sentinel has no hyphen, uppercase letter or underscore: those were already
 * refused by the reviewed grammar (`[a-z]{1,10}[0-9]{0,8}` per identifier), so a
 * sentinel made of them proves nothing about the rule that was wrong.
 */
const VERSION_SENTINEL = 'secretkey';

test('a credential-shaped pre-release suffix is not a toolchain version', () => {
  // Every value in this table was accepted by the reviewed grammar and would
  // have been copied verbatim into release/manifest.json by `release:publish`.
  const sentinelValues = {
    node: ['v26.12.0-secretkey', 'v26.12.0-sklive', 'v26.12.0-tokenabc', 'v26.12.0-abcdefgh', 'v26.12.0-abcdefgh.abcdefgh', 'v26.12.0-nightly.secretkey'],
    npm: ['11.20.0-secretkey', '11.20.0-sklive', '11.20.0-zzzzzzzz', '11.20.0-rc.secretkey', '11.20.0-alpha.secretabc'],
  };
  for (const field of ['node', 'npm']) {
    for (const value of sentinelValues[field]) {
      const problems = builtWithProblems({ node: process.version, npm: '11.20.0', platform: 'linux-x64', [field]: value });
      assert.ok(problems.length > 0, `${field}: ${value.slice(0, 12)}… must be refused`);
      assert.match(problems.join('\n'), new RegExp(`builtWith\\.${field}`));
      assert.equal(problems.join('\n').includes(TOOLCHAIN_SENTINEL), false, `${field}: the sentinel must not be echoed`);
      assert.equal(problems.join('\n').includes(VERSION_SENTINEL), false, `${field}: the value itself must not be echoed`);
      assert.equal(problems.join('\n').includes('sklive'), false, `${field}: nor any other credential-shaped part`);
      assert.equal(/a string/.test(problems.join('\n')), true, `${field}: the report states the kind, not the value`);
    }
  }

  // The values that must keep working: this machine's real toolchain, the
  // committed pin's record, and the public pre-release tags Node/npm publish.
  const npmVersion = spawnSync('npm', ['--version'], { encoding: 'utf8' });
  if (npmVersion.status === 0) {
    const version = npmVersion.stdout.trim();
    assert.deepEqual(
      builtWithProblems({ node: process.version, npm: version, platform: `${process.platform}-${process.arch}` }),
      [],
      `the toolchain this machine actually reports must stay pinnable (${version})`,
    );
  }
  assert.deepEqual(builtWithProblems(pinned.builtWith), []);
  // The tags each field's own history publishes: nodejs.org/download/rc has
  // `rc.0`–`rc.6`, and the npm registry alpha/beta/next/pre/rc with a numeric
  // counter. A node nightly is not an identifier here — it is only the whole
  // build stamp, covered by its own case below.
  for (const node of ['v26.12.0', 'v22.0.0-rc.1', 'v26.0.0-rc.6', 'v20.0.0-rc1', 'v27.0.0-nightly202610236d4646731e']) {
    assert.deepEqual(builtWithProblems({ ...pinned.builtWith, node }), [], node);
  }
  for (const npm of ['11.20.0', '11.0.0-pre.0', '9.8.1-rc.0', '7.0.0-beta.13', '11.0.0-next.3', '1.1.0-alpha.7']) {
    assert.deepEqual(builtWithProblems({ ...pinned.builtWith, npm }), [], npm);
  }

  // A nightly is one whole build stamp — tag word, eight-digit date, ten- or
  // forty-character commit — and nothing else. As a generic identifier it also
  // spelled the tag word alone, the date with no commit, and a stamp joined to
  // another identifier; none of those is a version any nightly index publishes.
  for (const node of ['v27.0.0-nightly', 'v27.0.0-nightly20261023', 'v27.0.0-nightly20261023.rc1']) {
    const problems = builtWithProblems({ ...pinned.builtWith, node });
    assert.ok(problems.length > 0, `${node} must be refused`);
    assert.equal(problems.join('\n').includes(node), false, `${node}: the value must not be echoed`);
  }

  // The allow-list is per field, because the histories are: a tag npm publishes
  // is still a value no Node build ever reports in `process.version`.
  for (const [field, value] of [['node', 'v26.12.0-beta.1'], ['node', 'v26.12.0-pre.2'], ['node', 'v26.12.0-next.3'], ['npm', '11.20.0-nightly20230101']]) {
    assert.ok(builtWithProblems({ ...pinned.builtWith, [field]: value }).length > 0, `${field}: ${value} is not published in that history`);
  }

  // One real shape stays refused on purpose, and is documented as such: a pre-1.0
  // npm tag with a hyphen inside one identifier (`alpha-0`, published in 2010),
  // which this grammar spells as two identifiers. The nightly form with a date and
  // commit is admitted — see release-build-boundary-round6.test.mjs for the
  // measured shape and its counterexamples.
  assert.ok(builtWithProblems({ ...pinned.builtWith, npm: '1.1.0-alpha-0' }).length > 0);
});

test('a sentinel in a toolchain version is refused by the manifest check and by the publisher before any write', () => {
  const verified = verifiedFor(ARTIFACT_BYTES);
  const sentinel = VERSION_SENTINEL;
  const archive = {
    filename: FILENAME,
    sha256: verified.sha256,
    contentSha256: verified.contentSha256,
    entries: verified.entries.length,
    modes: modesOf(readTarEntries(Buffer.from(ARTIFACT_BYTES))),
  };
  for (const field of ['node', 'npm']) {
    const buildManifest = buildManifestNamed(verified, {
      builtWith: { ...buildManifestNamed(verified).builtWith, [field]: `${field === 'node' ? 'v26.12.0' : '11.20.0'}-${sentinel}` },
    });
    const problems = inspectBuildManifest({ packageManifest, buildManifest, archive });
    assert.ok(problems.length > 0, `${field}: the manifest check must refuse the suffix`);
    assert.match(problems.join('\n'), new RegExp(`builtWith\\.${field}`));
    assert.equal(problems.join('\n').includes(sentinel), false, `${field}: the manifest report must not echo it`);
  }

  // The same record through the candidate check, and then through the publisher
  // command, whose failure must also leave `release/` and the candidate intact.
  const dir = writeCandidate(ARTIFACT_BYTES, buildManifestNamed(verified, {
    builtWith: { node: 'v26.12.0', npm: `11.20.0-${sentinel}`, platform: 'darwin-arm64' },
  }));
  const beforeCandidate = snapshot(dir);
  const beforeRelease = committedReleaseSnapshot();
  const candidateResult = inspectCandidateBuild({ fromDir: dir, filename: FILENAME, packageManifest, verified });
  assert.equal(candidateResult.problems.length, 1, 'the toolchain record is the only problem');
  assert.match(candidateResult.problems[0], /builtWith\.npm is not a npm version/);
  assert.equal(candidateResult.problems.join('\n').includes(sentinel), false);

  const run = spawnSync(process.execPath, [PUBLISH, '--from', dir], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.notEqual(run.status, 0, 'the publisher must refuse the suffix');
  const surface = `${run.stdout}\n${run.stderr}`;
  assert.match(surface, /builtWith\.npm is not a npm version/);
  assert.match(surface, /nothing was pinned/);
  assert.equal(surface.includes(sentinel), false, 'the publisher error must not echo the rejected suffix');
  assert.deepEqual(committedReleaseSnapshot(), beforeRelease, 'nothing may be pinned');
  assert.deepEqual(snapshot(dir), beforeCandidate, 'the candidate must be left as it was');
});

// ---------------------------------------------------------------------------
// blocker 4: the build manifest schema is closed
// ---------------------------------------------------------------------------

test('release:pack refuses an output whose manifest carries an unknown top-level field and preserves it', () => {
  const seed = path.join(scratch, 'pack-seed');
  const seeded = spawnSync(process.execPath, [PACK, '--dist', seed], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(seeded.status, 0, `packing the seed output failed:\n${seeded.stderr}`);

  // What the writer emits, exactly: the schema is not a minimum.
  const written = JSON.parse(fs.readFileSync(path.join(seed, 'manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(written), BUILD_MANIFEST_FIELDS, 'the build manifest holds exactly the fields the writer emits');

  const dir = path.join(scratch, 'pack-usernote');
  fs.cpSync(seed, dir, { recursive: true });
  const manifestFile = path.join(dir, 'manifest.json');
  const withNote = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  withNote.userNote = `kept by the caller: ${TOOLCHAIN_SENTINEL}`;
  fs.writeFileSync(manifestFile, `${JSON.stringify(withNote, null, 2)}\n`);
  const before = snapshot(dir);

  const result = spawnSync(process.execPath, [PACK, '--dist', dir], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'an output with an unknown manifest field must not be overwritten');
  const surface = `${result.stdout}\n${result.stderr}`;
  assert.match(surface, /not a release:pack build manifest/);
  assert.match(surface, /1 unexpected top-level property/);
  assert.equal(surface.includes(TOOLCHAIN_SENTINEL), false, 'the value of the unknown field must not be echoed');
  assert.equal(surface.includes('userNote'), false, 'nor its name');
  assert.deepEqual(snapshot(dir), before, 'the whole directory must be preserved, including the caller\'s field');
  assert.equal(JSON.parse(fs.readFileSync(manifestFile, 'utf8')).userNote, withNote.userNote, 'the caller\'s field is still there');

  // The same candidate through the publisher: the pin schema is closed on that
  // side too, so a field the packer never writes cannot reach `release/` even
  // when the tarball beside it is genuine.
  const published = spawnSync(process.execPath, [PUBLISH, '--from', dir], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.notEqual(published.status, 0, 'the publisher must refuse the extra field');
  const publishSurface = `${published.stdout}\n${published.stderr}`;
  assert.match(publishSurface, /1 unexpected top-level property/);
  assert.match(publishSurface, /nothing was pinned/);
  assert.equal(publishSurface.includes(TOOLCHAIN_SENTINEL), false, 'the extra field\'s value must not be echoed');
  assert.equal(publishSurface.includes('userNote'), false, 'nor its name');
  assert.deepEqual(snapshot(dir), before, 'a refused publish leaves the candidate as it was');
});

// ---------------------------------------------------------------------------
// blocker 5 / P2: rejections report fields and positions, never values or paths
// ---------------------------------------------------------------------------

const SURFACE_SENTINEL = 'sk-review-sentinel-surface';

test('no candidate metadata, pin value, entry path or caller path reaches an error surface', () => {
  const verified = verifiedFor(ARTIFACT_BYTES);
  const archive = {
    filename: FILENAME,
    sha256: verified.sha256,
    contentSha256: verified.contentSha256,
    entries: verified.entries.length,
    modes: modesOf(readTarEntries(Buffer.from(ARTIFACT_BYTES))),
  };
  const base = buildManifestNamed(verified);
  const releaseBefore = committedReleaseSnapshot();

  // 1. the build manifest check: every mismatching field, one at a time.
  const mismatches = [
    ['name', SURFACE_SENTINEL],
    ['version', `0.0.1-${SURFACE_SENTINEL}`],
    ['filename', `${SURFACE_SENTINEL}.tgz`],
    ['sha256', SURFACE_SENTINEL],
    ['contentSha256', SURFACE_SENTINEL],
    ['entries', SURFACE_SENTINEL],
    ['modes', [SURFACE_SENTINEL]],
  ];
  for (const [field, value] of mismatches) {
    const problems = inspectBuildManifest({ packageManifest, buildManifest: { ...base, [field]: value }, archive });
    assert.ok(problems.length > 0, `${field}: must be refused`);
    assert.equal(problems.join('\n').includes(SURFACE_SENTINEL), false, `${field}: the value must not be echoed`);
  }

  // An extra top-level property is reported by count, not by name or value.
  const extraProblems = inspectBuildManifest({
    packageManifest,
    buildManifest: { ...base, [`note${SURFACE_SENTINEL}`]: SURFACE_SENTINEL },
    archive,
  });
  assert.match(extraProblems.join('\n'), /1 unexpected top-level property/);
  assert.equal(extraProblems.join('\n').includes(SURFACE_SENTINEL), false);

  // 2. the candidate check, with the sentinel in the tarball's own entry path.
  const entryBytes = tarWith({ name: `package/${SURFACE_SENTINEL}`, type: '2' });
  const entryDir = writeCandidate(entryBytes, buildManifestNamed(verifiedFor(ARTIFACT_BYTES), {
    sha256: sha256Of(entryBytes),
    contentSha256: pinned.contentSha256,
    entries: 1,
    modes: ['0o644'],
  }));
  const entryResult = inspectCandidateBuild({ fromDir: entryDir, filename: FILENAME, packageManifest, verified });
  assert.match(entryResult.problems.join('\n'), /unsupported entry type \(symbolic link\)/);
  assert.equal(entryResult.problems.join('\n').includes(SURFACE_SENTINEL), false, 'the entry path must not be echoed');

  // 3. a candidate whose manifest names a sentinel and whose directory is named
  // after one: the `--from` path itself is caller input and is never printed.
  const sentinelDir = path.join(freshDir(), SURFACE_SENTINEL);
  fs.mkdirSync(sentinelDir);
  fs.writeFileSync(path.join(sentinelDir, 'manifest.json'), `${JSON.stringify({ ...base, name: SURFACE_SENTINEL }, null, 2)}\n`);
  const missingTarball = inspectCandidateBuild({ fromDir: sentinelDir, filename: FILENAME, packageManifest, verified });
  assert.match(missingTarball.problems.join('\n'), /the build tarball is missing/);
  assert.equal(missingTarball.problems.join('\n').includes(SURFACE_SENTINEL), false, 'the directory path must not be echoed');

  const publishRun = spawnSync(process.execPath, [PUBLISH, '--from', sentinelDir], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.notEqual(publishRun.status, 0);
  const publishSurface = `${publishRun.stdout}\n${publishRun.stderr}`;
  assert.match(publishSurface, /the build tarball is missing/);
  assert.match(publishSurface, /nothing was pinned/);
  assert.equal(publishSurface.includes(SURFACE_SENTINEL), false, 'the publisher must not echo --from or candidate metadata');
  assert.equal(publishSurface.includes(scratch), false, 'nor any absolute path');
  assert.deepEqual(committedReleaseSnapshot(), releaseBefore, 'a refused run pins nothing');

  // 4. a pin whose fields all carry the sentinel: the set is refused, and the
  // report names fields and categories only.
  const pinDir = freshDir();
  fs.writeFileSync(path.join(pinDir, 'manifest.json'), `${JSON.stringify({
    name: SURFACE_SENTINEL,
    version: SURFACE_SENTINEL,
    filename: SURFACE_SENTINEL,
    sha256: SURFACE_SENTINEL,
    contentSha256: SURFACE_SENTINEL,
    entries: SURFACE_SENTINEL,
    modes: [SURFACE_SENTINEL],
    builtWith: { ...base.builtWith, platform: SURFACE_SENTINEL },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(pinDir, 'SHA256SUMS'), `${SURFACE_SENTINEL}  ${SURFACE_SENTINEL}\n`);
  fs.writeFileSync(path.join(pinDir, FILENAME), ARTIFACT_BYTES);
  const pinProblems = inspectPinnedRelease({ releaseDir: pinDir, packageManifest, expected: verified }).problems;
  assert.ok(pinProblems.length > 0, 'a pin full of foreign values must be refused');
  assert.equal(pinProblems.join('\n').includes(SURFACE_SENTINEL), false, 'no pin value may be echoed');

  // A mismatching digest and mode set in an otherwise valid set: same rule.
  const setDir = freshDir();
  fs.copyFileSync(ARTIFACT, path.join(setDir, FILENAME));
  fs.writeFileSync(path.join(setDir, 'manifest.json'), `${JSON.stringify({
    ...base,
    sha256: sha256Of(ARTIFACT_BYTES),
    contentSha256: SURFACE_SENTINEL,
    entries: verified.entries.length,
    modes: [SURFACE_SENTINEL],
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(setDir, 'SHA256SUMS'), `${sha256Of(ARTIFACT_BYTES)}  ${FILENAME}\n`);
  const mismatchProblems = inspectPinnedRelease({ releaseDir: setDir, packageManifest, expected: verified }).problems;
  assert.ok(mismatchProblems.length > 0);
  assert.match(mismatchProblems.join('\n'), /contentSha256/);
  assert.equal(mismatchProblems.join('\n').includes(SURFACE_SENTINEL), false);
  assert.deepEqual(committedReleaseSnapshot(), releaseBefore);
});

// ---------------------------------------------------------------------------
// blocker 5 / P2, continued: the whole failing chain, one vector at a time
// ---------------------------------------------------------------------------

/**
 * Every way a `--dist` or `--from` directory can be wrong, checked as the
 * operator sees it. The rule is the same on each: a fixed label (`the build
 * directory`, `manifest.json`, `the build tarball`), the field or category that
 * disagrees, and nothing that came from the caller's path or the candidate's
 * bytes.
 *
 * What the surface contains is the script's own report: a fixed label (`the build
 * directory`, `manifest.json`, `the build tarball`), the field or category that
 * disagrees, and — for a filesystem exception — the errno category only. Nothing
 * comes from the caller's path, the candidate's bytes or a stack trace; the round-6
 * tests cover the exception path (a `--dist` below a regular file).
 */
test('every failing pack and publish surface reports a fixed label, never a path or a parser snippet', () => {
  const sentinel = SURFACE_SENTINEL;
  const scratchDir = freshDir();
  const fileInsteadOfDir = path.join(scratchDir, 'a-file');
  fs.writeFileSync(fileInsteadOfDir, 'not a directory\n');

  const invalidJson = freshDir();
  fs.writeFileSync(path.join(invalidJson, 'manifest.json'), `{"name":"${sentinel}",`);
  fs.writeFileSync(path.join(invalidJson, 'SHA256SUMS'), `x  ${sentinel}\n`);

  const notATar = freshDir();
  fs.writeFileSync(path.join(notATar, 'manifest.json'), `${JSON.stringify(buildManifestNamed(verifiedFor(ARTIFACT_BYTES)), null, 2)}\n`);
  fs.writeFileSync(path.join(notATar, FILENAME), Buffer.from(sentinel));

  const linkedTarball = freshDir();
  fs.writeFileSync(path.join(linkedTarball, 'manifest.json'), `${JSON.stringify(buildManifestNamed(verifiedFor(ARTIFACT_BYTES)), null, 2)}\n`);
  fs.symlinkSync(ARTIFACT, path.join(linkedTarball, FILENAME));

  const vectors = [
    ['pack --dist is a file', [PACK, '--dist', fileInsteadOfDir], /it exists and is not a directory/],
    ['pack --dist inside lib/', [PACK, '--dist', path.join(REPO_ROOT, 'lib', sentinel)], /inside the repository but the only in-repo output directory/],
    ['pack --dist inside release/', [PACK, '--dist', path.join(REPO_ROOT, 'release', sentinel)], /inside release\//],
    ['pack --dist is the repository', [PACK, '--dist', REPO_ROOT], /it is the repository root/],
    ['pack --dist holds an invalid manifest', [PACK, '--dist', invalidJson], /it is not valid JSON/],
    ['publish --from is a file', [PUBLISH, '--from', fileInsteadOfDir], /the build directory is not a directory/],
    ['publish --from does not exist', [PUBLISH, '--from', path.join(scratchDir, sentinel)], /the build directory is missing/],
    ['publish --from holds an invalid manifest', [PUBLISH, '--from', invalidJson], /the build manifest is not readable: invalid JSON/],
    ['publish --from tarball is not an archive', [PUBLISH, '--from', notATar], /not a readable gzipped npm archive/],
    ['publish --from tarball is a symlink', [PUBLISH, '--from', linkedTarball], /the build tarball is a symbolic link/],
  ];
  const releaseBefore = committedReleaseSnapshot();
  for (const [label, argv, pattern] of vectors) {
    const run = spawnSync(process.execPath, argv, { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.notEqual(run.status, 0, `${label}: must fail`);
    const surface = `${run.stdout}\n${run.stderr}`;
    assert.match(surface, pattern, label);
    assert.equal(/SENTINEL|secretkey/i.test(surface), false, `${label}: no caller or candidate string may be echoed`);
    assert.equal(surface.includes(scratch), false, `${label}: no absolute caller path may be echoed`);
    assert.equal(/Unexpected (token|end of JSON)|is not valid JSON:\s*\{/.test(surface), false, `${label}: no JSON parser snippet may be echoed`);
  }
  assert.deepEqual(committedReleaseSnapshot(), releaseBefore, 'no refused run may touch the committed release set');
  assert.deepEqual(fs.readdirSync(invalidJson).sort(), ['SHA256SUMS', 'manifest.json'], 'a refused run writes nothing beside the candidate');
});

test('pack and its guards never echo a caller-supplied output path', () => {
  const sentinel = SURFACE_SENTINEL;
  const outside = path.join(freshDir(), sentinel);
  fs.mkdirSync(outside);
  // A foreign file under the tarball name: the refusal names the output part that
  // collided, never the `--dist` path.
  fs.writeFileSync(path.join(outside, FILENAME), 'not a build\n');
  const result = spawnSync(process.execPath, [PACK, '--dist', outside], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  const surface = `${result.stdout}\n${result.stderr}`;
  assert.match(surface, /refusing to overwrite an incomplete output/);
  assert.equal(surface.includes(sentinel), false, 'the --dist path must not be echoed');
  assert.equal(surface.includes(outside), false);

  // The guards themselves, called directly with sentinel-bearing arguments.
  assert.throws(
    () => assertUsableDist(path.join(REPO_ROOT, 'lib'), { repoRoot: REPO_ROOT, releaseDir: path.join(REPO_ROOT, 'release'), defaultDistDir: path.join(REPO_ROOT, 'dist') }),
    (error) => {
      assert.match(error.message, /refusing to build into/);
      assert.equal(error.message.includes(REPO_ROOT), false, 'the guard must not print the path');
      return true;
    },
  );
  assert.throws(
    () => targetPath(path.join(freshDir(), sentinel), `../${sentinel}`),
    (error) => {
      assert.match(error.message, /refusing to touch/);
      assert.equal(error.message.includes(sentinel), false, 'the rejected name must not be echoed');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// the candidate bytes are read once
// ---------------------------------------------------------------------------

test('the candidate check returns the exact bytes it hashed, for the publisher to install', () => {
  const verified = verifiedFor(ARTIFACT_BYTES);
  const dir = writeCandidate(ARTIFACT_BYTES, buildManifestNamed(verified));
  const result = inspectCandidateBuild({ fromDir: dir, filename: FILENAME, packageManifest, verified });
  assert.deepEqual(result.problems, []);
  assert.equal(Buffer.isBuffer(result.bytes), true, 'the verified bytes must be handed back');
  assert.equal(sha256Of(result.bytes), result.sha256, 'those bytes are the ones the reported sha256 describes');
  assert.equal(result.archive.sha256, sha256Of(result.bytes));
  assert.equal(result.bytes.equals(ARTIFACT_BYTES), true);

  // A `fromDir` that changes after the inspection cannot change what gets
  // installed: the buffer the checks produced is unaffected by the swap.
  fs.writeFileSync(path.join(dir, FILENAME), zlib.gzipSync(Buffer.alloc(1024, 0)));
  assert.equal(result.bytes.equals(ARTIFACT_BYTES), true, 'the returned bytes are the saved copy, not a live read');
  assert.equal(sha256Of(result.bytes), result.sha256);

  // And the publisher installs that buffer, never a fresh read of the path.
  const source = fs.readFileSync(PUBLISH, 'utf8');
  assert.match(source, /const \{ buildManifest, sha256: builtSha, bytes: builtBytes \} = candidate;/);
  assert.match(source, /\{ target: artifactPath, contents: builtBytes \}/);
  assert.equal(/const built = path\.join\(options\.from, filename\)/.test(source), false, 'the candidate path is not re-derived for a second read');
  assert.equal(/contents: fs\.readFileSync\(built\)/.test(source), false, 'the artifact is never re-read after verification');
});

// ---------------------------------------------------------------------------
// TAR header metadata the content digest does not cover
// ---------------------------------------------------------------------------

test('header metadata the digest does not cover must be canonical', () => {
  const sentinel = SURFACE_SENTINEL;
  const cases = [
    ['user name', { uname: sentinel }, /the entry owner names are not empty/],
    ['group name', { gname: sentinel }, /the entry owner names are not empty/],
    ['link name', { linkname: sentinel }, /the entry link name is not empty/],
    ['magic', { magic: 'ustar\u0000  ' }, /header magic and version are not the canonical ustar form/],
    ['timestamp', { timestamp: 499162501 }, /the entry timestamp is not the canonical packaging timestamp/],
    ['owner ids', { uid: 1000 }, /the entry owner ids are not the canonical zero/],
    ['device numbers', { devMajor: 3, devMinor: 7 }, /the entry device numbers are not the canonical zero/],
    ['header padding', { afterPrefix: Buffer.from(sentinel, 'latin1').subarray(0, 12) }, /the header padding after the name prefix is not zero/],
    // Bytes after the NUL of the string fields are header space no unpacker
    // reads, so they carry content no digest covers.
    ['name tail', { extra: 'name' }, /the name field carries data after its NUL terminator/],
    ['prefix tail', { extra: 'prefix' }, /the name prefix field carries data after its NUL terminator/],
    ['owner name tail', { extra: 'uname' }, /the user name field carries data after its NUL terminator/],
  ];
  for (const [label, options, pattern] of cases) {
    const bytes = tarWith({ name: 'package/index.js', ...options });
    if (options.extra) {
      // Append the marker after the field's NUL and re-seal the header.
      const tar = Buffer.from(zlib.gunzipSync(bytes));
      const header = tar.subarray(0, 512);
      const [start, length] = { name: [0, 100], prefix: [345, 155], uname: [265, 32] }[options.extra];
      const used = header.subarray(start, start + length).indexOf(0);
      header.write(sentinel, start + used + 1, Math.min(sentinel.length, length - used - 1), 'latin1');
      reseal(header);
      const file = writeTarball(`${label.replace(/\s+/g, '-')}-tail.tgz`, zlib.gzipSync(tar));
      const error = captureError(() => readTarEntries(file));
      assert.match(error.message, pattern, label);
      assert.equal(error.message.includes(sentinel), false, `${label}: the bytes must not be echoed`);
      continue;
    }
    const file = writeTarball(`${label.replace(/\s+/g, '-')}.tgz`, bytes);
    const error = captureError(() => readTarEntries(file));
    assert.match(error.message, pattern, label);
    assert.equal(error.message.includes(sentinel), false, `${label}: the field content must not be echoed`);
  }
});

test('the committed artifacts and a real npm pack keep their canonical header metadata', () => {
  // Both real producers are the evidence for the canonical values: if this ever
  // fails, the reader is rejecting what the release actually ships.
  for (const name of fs.readdirSync(path.join(REPO_ROOT, 'release')).filter((entry) => entry.endsWith('.tgz'))) {
    assert.ok(readTarEntries(path.join(REPO_ROOT, 'release', name)).length > 0, name);
  }
  assert.equal(contentDigestOf(readTarEntries(ARTIFACT)), pinned.contentSha256, 'the pinned digest is unchanged');
});
