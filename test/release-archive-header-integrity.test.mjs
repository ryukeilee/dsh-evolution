/**
 * The release tooling reads gzipped npm tarballs with its own dependency-free
 * reader (`readTarEntries`) and treats what it returns as the archive's content.
 * That reader used to parse header fields and never verify the header's own
 * checksum, so an archive `tar` refuses to unpack could still describe content
 * here — and `inspectCandidateBuild` would accept it.
 *
 * The counterexample from review: take a real `npm pack` artifact, overwrite the
 * first header's checksum field with ASCII `00000000`, re-gzip it, copy the new
 * sha256 into the candidate's build manifest. `tar -tzf` rejects the file, but
 * the candidate check reported success. Every test below builds such an archive
 * in a private `os.tmpdir()` fixture; nothing is pinned and no committed byte is
 * written.
 *
 * Round 3 added the second half of the same problem: headers that parse but a
 * block structure that does not exist. A 1-byte file with a correct checksum and
 * no payload padding, no end blocks, is 513 bytes of tar that `tar -tzf` calls
 * truncated; the reader used to walk past the end of the buffer and report the
 * entry. The framing rules are tested here too, together with the two archives
 * that must keep being accepted: the committed artifact and a real `npm pack`
 * run in a temporary package, so the stricter reader cannot silently stop
 * describing what the release actually ships.
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
import { inspectBuildManifest, inspectCandidateBuild } from '../scripts/release/publish-artifact.mjs';

const packageManifest = readManifest();
const pinned = readReleaseManifest();
const FILENAME = `${packageManifest.name}-${packageManifest.version}.tgz`;
const ARTIFACT = releaseArtifactPath(pinned);
const ARTIFACT_BYTES = fs.readFileSync(ARTIFACT);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-archive-header-integrity-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const PACK = path.join(REPO_ROOT, 'scripts', 'release', 'pack.mjs');
const PUBLISH = path.join(REPO_ROOT, 'scripts', 'release', 'publish-artifact.mjs');

let fixtureCount = 0;
function freshDir() {
  const dir = path.join(scratch, `set-${fixtureCount += 1}`);
  fs.mkdirSync(dir);
  return dir;
}

function sha256Of(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function writeTarball(label, bytes) {
  const file = path.join(freshDir(), label);
  fs.writeFileSync(file, bytes);
  return file;
}

/** The committed artifact's uncompressed tar. */
function uncompressedArtifact() {
  return Buffer.from(zlib.gunzipSync(ARTIFACT_BYTES));
}

/** The review's tamper: the stored first-header checksum replaced with ASCII zeros. */
function withZeroedChecksum(bytes) {
  const tar = Buffer.from(zlib.gunzipSync(bytes));
  tar.write('00000000', 148, 8, 'ascii');
  return zlib.gzipSync(tar);
}

/**
 * Rewrite one regular entry's *raw* header mode and repair the header checksum,
 * the way a tampered candidate would: the resulting archive is valid tar, so
 * only the mode contract can reject it.
 */
function withEntryMode(bytes, suffix, mode) {
  const tar = Buffer.from(zlib.gunzipSync(bytes));
  let offset = 0;
  for (;;) {
    assert.equal(offset + 512 <= tar.length, true, `no entry ending in ${suffix}`);
    const header = tar.subarray(offset, offset + 512);
    assert.equal(header.every((byte) => byte === 0), false, `no entry ending in ${suffix}`);
    const name = header.toString('latin1', 0, 100).replace(/\0.*$/s, '');
    const size = parseInt(header.toString('latin1', 124, 136).replace(/\0| /g, ''), 8) || 0;
    if (name.endsWith(suffix)) {
      header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'latin1');
      // The checksum field itself is summed as spaces, then rewritten.
      header.fill(0x20, 148, 156);
      const sum = header.reduce((total, byte) => total + byte, 0);
      header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
      return zlib.gzipSync(tar);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
}

/** `0o644`/`0o755` strings, the spelling `release/manifest.json` records. */
function modesOf(entries) {
  return [...new Set(entries.map((entry) => entry.mode))].sort((a, b) => a - b).map((mode) => `0o${mode.toString(8)}`);
}

/** The error a synchronous call throws, so its exact message can be inspected. */
function captureError(call) {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

/** Any rejection of a damaged header: the checksum check or a field parse. */
const REJECTED = /the recorded header checksum does not match the header|is neither an octal nor a base-256 number/;

// ---------------------------------------------------------------------------
// the reader itself
// ---------------------------------------------------------------------------

test('the committed artifact passes strict header validation', () => {
  const entries = readTarEntries(ARTIFACT);
  assert.equal(entries.length, pinned.entries, 'the reader still sees every pinned entry');
  assert.equal(contentDigestOf(entries), pinned.contentSha256, 'and the same content');
});

test('a header checksum that does not match the header is rejected', () => {
  const zeroed = writeTarball('zeroed.tgz', withZeroedChecksum(ARTIFACT_BYTES));
  assert.throws(
    () => readTarEntries(zeroed),
    /tar entry 0 at byte 0: the recorded header checksum does not match the header/,
  );

  // Any single flipped byte in a header is detected too, not only a zeroed field.
  for (const [label, index] of [['name', 4], ['mode', 101], ['size', 130], ['type', 156], ['magic', 257], ['prefix', 400], ['padding', 511]]) {
    const tar = uncompressedArtifact();
    tar[index] ^= 0xff;
    assert.throws(
      () => readTarEntries(writeTarball(`flip-${label}.tgz`, zlib.gzipSync(tar))),
      REJECTED,
      `a flipped byte at offset ${index} (${label}) must be rejected`,
    );
  }
});

test('a checksum field that is not octal or base-256 is rejected, not guessed', () => {
  for (const [label, value] of [['text', 'notascii'], ['octal-with-8', '00000008'], ['negative', '-0000001']]) {
    const tar = uncompressedArtifact();
    tar.write(value, 148, 8, 'ascii');
    assert.throws(
      () => readTarEntries(writeTarball(`garbage-${label}.tgz`, zlib.gzipSync(tar))),
      /is neither an octal nor a base-256 number/,
      `${label}: a non-numeric checksum field must be reported as such`,
    );
  }
});

test('a header whose checksum field is all NUL is rejected rather than read as zero', () => {
  const tar = uncompressedArtifact();
  tar.fill(0, 148, 156);
  assert.throws(
    () => readTarEntries(writeTarball('nul-checksum.tgz', zlib.gzipSync(tar))),
    /the recorded header checksum does not match the header/,
  );
});

test('an entry whose declared size runs past the end of the archive is a truncation', () => {
  // A valid header with a correct checksum that claims more data than exists:
  // only the length check can catch this, so it must not be silently shortened.
  const tar = uncompressedArtifact();
  const firstSize = parseInt(tar.toString('ascii', 124, 136).replace(/\0/g, '').trim(), 8);
  assert.ok(firstSize > 0, 'the committed artifact must have a non-empty first entry');
  const truncated = tar.subarray(0, 512 + firstSize - 8);
  assert.throws(
    () => readTarEntries(writeTarball('truncated-entry.tgz', zlib.gzipSync(truncated))),
    /truncated archive: .* declares \d+ bytes but only \d+ remain/,
  );
});

// ---------------------------------------------------------------------------
// a hand-built archive: the standard octal form and POSIX base-256
// ---------------------------------------------------------------------------

/** One-entry ustar archive, so the number encodings can be chosen explicitly. */
/**
 * One-entry ustar archive, so the number encodings and the block *structure* can
 * be chosen explicitly. `pad`/`endBlocks`/`after` exist because a tar's framing
 * is part of its validity, not an implementation detail: a payload occupies
 * whole 512-byte blocks and the archive closes with two all-zero blocks.
 */
function tarWith({
  sizeEncoding = 'octal', checksumEncoding = 'octal', contents = Buffer.from('shipped\n'),
  pad = true, endBlocks = 2, after = Buffer.alloc(0),
  name = 'package/index.js', type = '0', mode = 0o644,
} = {}) {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, 'latin1');
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'latin1');
  header.write('0000000\0', 108, 8, 'latin1');
  header.write('0000000\0', 116, 8, 'latin1');
  // The canonical node-tar `portable` timestamp, which both real producers write.
  header.write(`${(499162500).toString(8).padStart(11, '0')}\0`, 136, 12, 'latin1');
  header.write(type, 156, 1, 'latin1');
  header.write('ustar\u000000', 257, 8, 'latin1');

  const encode = (value, style, length) => {
    if (style === 'base256') {
      const field = Buffer.alloc(length, 0);
      field[0] = 0x80;
      field.writeUInt32BE(value, length - 4);
      return field;
    }
    return Buffer.from(`${value.toString(8).padStart(length - 1, '0')}\0`, 'latin1');
  };
  encode(contents.length, sizeEncoding, 12).copy(header, 124);
  const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 0x20 : byte), 0);
  if (checksumEncoding === 'zeroAscii') header.write('00000000', 148, 8, 'ascii');
  else encode(sum, checksumEncoding, 8).copy(header, 148);

  const data = Buffer.alloc(pad ? Math.ceil(contents.length / 512) * 512 : contents.length, 0);
  contents.copy(data);
  return zlib.gzipSync(Buffer.concat([header, data, Buffer.alloc(endBlocks * 512, 0), after]));
}

test('the standard octal header and a POSIX base-256 header are both read', () => {
  for (const options of [
    { sizeEncoding: 'octal', checksumEncoding: 'octal' },
    { sizeEncoding: 'base256', checksumEncoding: 'octal' },
    { sizeEncoding: 'octal', checksumEncoding: 'base256' },
    { sizeEncoding: 'base256', checksumEncoding: 'base256' },
  ]) {
    const label = `${options.sizeEncoding}-size/${options.checksumEncoding}-checksum`;
    const entries = readTarEntries(writeTarball(`hand-built-${label.replace('/', '-')}.tgz`, tarWith(options)));
    assert.deepEqual(entries.map((entry) => entry.path), ['index.js'], label);
    assert.equal(entries[0].mode, 0o644, label);
    assert.equal(entries[0].bytes.toString('utf8'), 'shipped\n', label);
  }

  // A negative base-256 sign byte is a value this reader refuses to model.
  const tar = Buffer.from(zlib.gunzipSync(tarWith()));
  tar[148] = 0xff;
  assert.throws(
    () => readTarEntries(writeTarball('negative-base256.tgz', zlib.gzipSync(tar))),
    /tar entry 0 at byte 0: header checksum uses a base-256 encoding with an unsupported sign byte/,
  );

  // ASCII zeros are the review's tamper: a parseable field, a checksum no tar
  // accepts. Built here without touching the committed artifact.
  assert.throws(
    () => readTarEntries(writeTarball('zero-ascii-checksum.tgz', tarWith({ checksumEncoding: 'zeroAscii' }))),
    /the recorded header checksum does not match the header/,
  );
});

// ---------------------------------------------------------------------------
// the archive's block structure: padding, end marker, no stray tail
// ---------------------------------------------------------------------------

/**
 * Round 3 review counterexample: one 1-byte regular file, a *correct* header
 * checksum, exactly one byte of payload — and then the end of the gzip stream.
 * No 511 bytes of padding, no two zero blocks: 513 bytes of tar in total, which
 * `tar -tzf` reports as "Truncated input file (needed 512 bytes, only 1
 * available)". The reader used to jump one whole block ahead from the start of
 * the payload without checking that the block exists, so it reported the entry
 * as readable — and `inspectCandidateBuild` reads candidates through it.
 */
test('a payload that is not followed by its whole block is a truncation, not a readable entry', (t) => {
  const bytes = tarWith({ contents: Buffer.from('x'), pad: false, endBlocks: 0 });
  const file = writeTarball('one-byte-no-padding.tgz', bytes);
  assert.equal(zlib.gunzipSync(fs.readFileSync(file)).length, 513, 'the fixture is the review\'s 513-byte archive');

  const system = systemTarListOf(file);
  if (system === null) t.diagnostic('no system tar on PATH; the archive was still rejected by the reader');
  else assert.notEqual(system.status, 0, 'the system tar must reject the truncated archive');

  assert.throws(
    () => readTarEntries(file),
    /truncated archive: tar entry 0 at byte 0 declares 1 bytes, whose 1 512-byte payload block\(s\) end at byte 1024, but the archive ends at byte 513/,
  );
});

test('an archive needs two complete zero blocks to end, and nothing but zeros after them', () => {
  const cases = [
    // padding present, but the end marker is one block short / missing entirely.
    ['one end block', { endBlocks: 1 }, /end-of-archive marker .* is 512 bytes, but a tar ends with two complete 512-byte zero blocks/],
    ['no end block', { endBlocks: 0 }, /the entry blocks end at byte 1024 without an end-of-archive marker/],
    ['partial end block', { endBlocks: 2, after: Buffer.alloc(100, 0) }, /ends with a partial 100-byte block/],
    // non-zero bytes after a valid marker: entries this reader would not model.
    ['data after the marker', { endBlocks: 2, after: Buffer.concat([Buffer.from('junk'), Buffer.alloc(508, 0)]) }, /unexpected data after the end-of-archive marker/],
    // a second header after the marker, i.e. an archive that was cut and re-joined.
    ['entry after the marker', { endBlocks: 1, after: Buffer.from(zlib.gunzipSync(tarWith()).subarray(0, 1024)) }, /unexpected data after the end-of-archive marker/],
  ];
  // These are deliberately stricter than a lenient system `tar`: the bsdtar on
  // this machine stops at the first zero block and never looks at what follows,
  // so it accepts a lone marker and even a header after it. A release reader
  // cannot: what it does not model is not covered by `contentSha256`, so the
  // framing it accepts has to be the standard one. Both real producers — `npm
  // pack` and the committed artifact — write exactly that.
  for (const [label, options, pattern] of cases) {
    const file = writeTarball(`${label.replace(/[^a-z]+/gi, '-')}.tgz`, tarWith(options));
    assert.throws(() => readTarEntries(file), pattern, `${label}: must be rejected`);
  }
});

test('a valid padding block and extra zero blocks past the marker are still accepted', () => {
  // A 1-byte payload with its 511 bytes of padding: the same file the rejected
  // fixture above is, but framed correctly.
  const padded = readTarEntries(writeTarball('one-byte-padded.tgz', tarWith({ contents: Buffer.from('x') })));
  assert.deepEqual(padded.map((entry) => [entry.path, entry.bytes.toString('utf8')]), [['index.js', 'x']]);

  // GNU tar pads the last record to the blocking factor with more zero blocks.
  const extraZeros = readTarEntries(writeTarball('extra-zero-blocks.tgz', tarWith({ endBlocks: 4 })));
  assert.deepEqual(extraZeros.map((entry) => entry.path), ['index.js'], 'extra zero blocks are still an end marker');
});

/**
 * The reader's framing rules must not reject the archives the release actually
 * ships, so both real producers are checked here: the committed artifact and a
 * genuine `npm pack` run in a private fixture directory.
 */
test('the committed artifact and a real npm pack output are both still accepted', (t) => {
  const committed = readTarEntries(ARTIFACT);
  assert.equal(committed.length, pinned.entries, 'every committed entry is still read');

  const dir = path.join(scratch, 'npm-pack');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'dsh-release-reader-probe', version: '0.0.0', files: ['index.js'] }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(dir, 'index.js'), 'export default 1;\n');
  const packed = spawnSync('npm', ['pack', '--json', '--pack-destination', dir, '--ignore-scripts'], { cwd: dir, encoding: 'utf8' });
  assert.equal(packed.status, 0, `the fixture needs a working npm: ${packed.stderr}`);
  const info = JSON.parse(packed.stdout)[0];
  const file = path.join(dir, info.filename);

  const system = systemTarListOf(file);
  if (system === null) t.diagnostic('no system tar on PATH; npm pack output was still accepted by the reader');
  else assert.equal(system.status, 0, 'the system tar accepts npm pack output');

  const entries = readTarEntries(file);
  assert.deepEqual(entries.map((entry) => entry.path).sort(), ['index.js', 'package.json'], 'npm pack output is read entry for entry');
  assert.match(contentDigestOf(entries), /^[0-9a-f]{64}$/);
});

/**
 * The same 513-byte archive through the candidate check: a build directory that
 * is self-consistent with its own bytes must still be refused, because those
 * bytes are not a tar. Nothing may be pinned.
 */
test('a candidate build whose tarball is a truncated tar is refused and nothing is pinned', (t) => {
  const dir = freshDir();
  const bytes = tarWith({ contents: Buffer.from('x'), pad: false, endBlocks: 0 });
  const buildManifest = {
    name: packageManifest.name,
    version: packageManifest.version,
    filename: FILENAME,
    sha256: sha256Of(bytes),
    contentSha256: pinned.contentSha256,
    entries: pinned.entries,
    modes: pinned.modes,
    builtWith: { node: 'v26.12.0', npm: '11.20.0', platform: 'darwin-arm64' },
  };
  fs.writeFileSync(path.join(dir, FILENAME), bytes);
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(buildManifest, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${buildManifest.sha256}  ${FILENAME}\n`);
  const beforeCandidate = snapshot(dir);
  const beforeRelease = committedReleaseSnapshot();

  const system = systemTarList(dir);
  if (system === null) t.diagnostic('no system tar on PATH; the archive was still rejected by the reader');
  else assert.notEqual(system.status, 0, 'the system tar rejects the truncated archive');

  const result = inspectCandidateBuild({
    fromDir: dir,
    filename: FILENAME,
    packageManifest,
    verified: verifiedForThisTree(),
  });

  assert.ok(result.problems.length > 0, 'a truncated archive must not be accepted as a release:pack output');
  assert.match(result.problems.join('\n'), /is not a readable gzipped npm archive/);
  assert.match(result.problems.join('\n'), /512-byte payload block\(s\) end at byte 1024/);
  assert.equal(result.archive, null, 'no archive description may be produced from a rejected archive');
  assert.deepEqual(snapshot(dir), beforeCandidate, 'the candidate directory must be left as it was');
  assert.deepEqual(committedReleaseSnapshot(), beforeRelease, 'the committed release set must be untouched');
});

// ---------------------------------------------------------------------------
// the counterexample, end to end through the candidate check
// ---------------------------------------------------------------------------

/** A `--from` directory holding the tampered tarball and a manifest that agrees with it. */
function tamperedCandidate() {
  const bytes = withZeroedChecksum(ARTIFACT_BYTES);
  const dir = freshDir();
  const genuine = readTarEntries(ARTIFACT);
  const buildManifest = {
    name: packageManifest.name,
    version: packageManifest.version,
    filename: FILENAME,
    // The manifest is made fully self-consistent with the tampered bytes: this
    // is what the review's counterexample did, and what used to be enough.
    sha256: sha256Of(bytes),
    contentSha256: contentDigestOf(genuine),
    entries: genuine.length,
    modes: [...new Set(genuine.map((entry) => entry.mode))].sort((a, b) => a - b).map((mode) => `0o${mode.toString(8)}`),
    builtWith: { node: 'v26.12.0', npm: '11.20.0', platform: 'darwin-arm64' },
  };
  fs.writeFileSync(path.join(dir, FILENAME), bytes);
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(buildManifest, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${buildManifest.sha256}  ${FILENAME}\n`);
  return { dir, bytes, buildManifest };
}

function verifiedForThisTree() {
  const entries = readTarEntries(ARTIFACT);
  return {
    filename: FILENAME,
    sha256: sha256Of(ARTIFACT_BYTES),
    contentSha256: contentDigestOf(entries),
    entries: entries.map((entry) => entry.path).sort(),
    entryModes: entries.map((entry) => entry.mode),
    bytes: ARTIFACT_BYTES.length,
  };
}

/** Name + content hash of everything in a directory. */
function snapshot(dir) {
  return Object.fromEntries(fs.readdirSync(dir).sort().map((name) => {
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    return [name, stat.isFile() ? sha256Of(fs.readFileSync(file)) : `not-a-file:${stat.mode}`];
  }));
}

/** The committed release set, hashed so a test can prove it was not written to. */
function committedReleaseSnapshot() {
  return Object.fromEntries(['manifest.json', FILENAME, 'SHA256SUMS'].map((name) => {
    const file = path.join(REPO_ROOT, 'release', name);
    const stat = fs.lstatSync(file);
    return [name, stat.isFile() ? sha256Of(fs.readFileSync(file)) : `not-a-file:${stat.mode}`];
  }));
}

/** `tar -tvzf <file>`, or `null` when the platform has no usable system tar. */
function systemTarVerboseOf(file) {
  const probe = spawnSync('tar', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return null;
  return spawnSync('tar', ['-tvzf', file], { encoding: 'utf8' });
}

/** `tar -tzf <file>`, or `null` when the platform has no usable system tar. */
function systemTarListOf(file) {
  const probe = spawnSync('tar', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return null;
  return spawnSync('tar', ['-tzf', file], { encoding: 'utf8' });
}

function systemTarList(dir) {
  return systemTarListOf(path.join(dir, FILENAME));
}

test('a candidate whose tar header checksum was zeroed is refused and nothing is pinned', (t) => {
  const candidate = tamperedCandidate();
  const beforeCandidate = snapshot(candidate.dir);
  const beforeRelease = committedReleaseSnapshot();

  const tarCheck = systemTarList(candidate.dir);
  if (tarCheck === null) t.diagnostic('no system tar on PATH; the archive was still rejected by the reader');
  else assert.notEqual(tarCheck.status, 0, 'the system tar must also reject the tampered archive');

  const result = inspectCandidateBuild({
    fromDir: candidate.dir,
    filename: FILENAME,
    packageManifest,
    verified: verifiedForThisTree(),
  });

  assert.ok(result.problems.length > 0, 'a tampered header must not be accepted as a release:pack output');
  assert.match(result.problems.join('\n'), /the recorded header checksum does not match the header/);
  assert.deepEqual(result.buildManifest, candidate.buildManifest, 'the manifest is still reported for the error message');
  assert.equal(result.archive, null, 'no archive description may be produced from a rejected archive');

  // Fail closed on disk: the candidate is untouched and no fixed point was
  // written (this test never calls the publisher, so `release/` can only change
  // if the inspection itself wrote something).
  assert.deepEqual(snapshot(candidate.dir), beforeCandidate, 'the candidate directory must be left as it was');
  assert.deepEqual(committedReleaseSnapshot(), beforeRelease, 'the committed release set must be untouched');
});

// ---------------------------------------------------------------------------
// the raw header mode: canonical modes only, never masked
// ---------------------------------------------------------------------------

/**
 * Round 4 review counterexample: take the real artifact, rewrite the executable
 * `scripts/doctor.mjs` entry's raw mode to 04755 (setuid), repair the header
 * checksum, re-gzip and recompute the candidate's sha256. `contentDigestOf()`
 * used to receive `mode & 0o777`, so 04755 became 0755 and the setuid bit never
 * entered the digest: the candidate passed `inspectCandidateBuild` while the
 * system `tar` showed a setuid file. The reader now validates the raw mode at
 * the shared archive boundary and refuses anything but 0644/0755 instead of
 * normalising it away.
 */
test('only the two canonical raw modes are accepted at the archive boundary', () => {
  // The digest records `mode.toString(8)`, i.e. only the low permission bits, so
  // a header mode whose high bits are not part of that spelling cannot be
  // described by `contentSha256`. The contract is the packer's: 0644 or 0755,
  // exactly — the same pair `commitContentDigest()` accepts from git.
  for (const mode of [0o600, 0o640, 0o664, 0o700, 0o777, 0o444, 0o1755, 0o2755, 0o4755, 0o6755]) {
    const file = writeTarball(`mode-${mode.toString(8)}.tgz`, tarWith({ mode }));
    assert.throws(
      () => readTarEntries(file),
      /tar entry 0 at byte 0: the entry mode is not one of the canonical release modes \(0o644, 0o755\)/,
      `mode 0o${mode.toString(8)} must be refused`,
    );
  }
  for (const mode of [0o644, 0o755]) {
    const [entry] = readTarEntries(writeTarball(`mode-ok-${mode.toString(8)}.tgz`, tarWith({ mode })));
    assert.equal(entry.mode, mode, `mode 0o${mode.toString(8)} must be accepted unchanged`);
  }
});

test('an executable entry rewritten to a setuid mode is rejected, not masked away', (t) => {
  const tampered = withEntryMode(ARTIFACT_BYTES, 'scripts/doctor.mjs', 0o4755);
  const file = writeTarball('setuid-doctor.tgz', tampered);

  // The tamper is real: the system tar applies the bit a masking digest missed.
  const listed = systemTarVerboseOf(file);
  if (listed === null) t.diagnostic('no system tar on PATH; the raw mode field was still rejected by the reader');
  else {
    assert.equal(listed.status, 0, 'the tampered archive is still a valid tar');
    assert.match(listed.stdout, /^-rwsr-xr-x\s.*package\/scripts\/doctor\.mjs$/m, 'the system tar must show the setuid bit');
  }

  const error = captureError(() => readTarEntries(file));
  assert.match(error.message, /tar entry \d+ at byte \d+: the entry mode is not one of the canonical release modes \(0o644, 0o755\)/);
  assert.equal(error.message.includes('doctor.mjs'), false, 'the rejected entry path must not be echoed');

  // A candidate that the masking reader accepted: its manifest is fully
  // self-consistent with the tampered bytes and reuses the genuine content
  // digest, entry count and modes (04755 normalised to 0755).
  const genuine = readTarEntries(ARTIFACT);
  const buildManifest = {
    name: packageManifest.name,
    version: packageManifest.version,
    filename: FILENAME,
    sha256: sha256Of(tampered),
    contentSha256: contentDigestOf(genuine),
    entries: genuine.length,
    modes: modesOf(genuine),
    builtWith: { node: 'v26.12.0', npm: '11.20.0', platform: 'darwin-arm64' },
  };
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, FILENAME), tampered);
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(buildManifest, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${buildManifest.sha256}  ${FILENAME}\n`);
  const beforeCandidate = snapshot(dir);
  const beforeRelease = committedReleaseSnapshot();

  const result = inspectCandidateBuild({
    fromDir: dir,
    filename: FILENAME,
    packageManifest,
    verified: verifiedForThisTree(),
  });
  assert.ok(result.problems.length > 0, 'a setuid entry must not be pinnable');
  assert.match(result.problems.join('\n'), /is not a readable gzipped npm archive/);
  assert.match(result.problems.join('\n'), /not one of the canonical release modes/);
  assert.equal(result.archive, null, 'no archive description may be produced from a rejected archive');
  assert.deepEqual(snapshot(dir), beforeCandidate, 'the candidate directory must be left as it was');
  assert.deepEqual(committedReleaseSnapshot(), beforeRelease, 'the committed release set must be untouched');

  // The real artifact still reads with exactly the pinned identity and the
  // canonical mode set; the setuid rewrite is the only thing that changed.
  assert.deepEqual([...new Set(genuine.map((entry) => entry.mode))].sort(), [0o644, 0o755]);
  assert.equal(contentDigestOf(genuine), pinned.contentSha256);
});

// ---------------------------------------------------------------------------
// rejections report positions and field names, never candidate values
// ---------------------------------------------------------------------------

const METADATA_SENTINEL = 'sk-review-sentinel-metadata';

/**
 * Round 4 review: a rejected candidate's own metadata was quoted back into the
 * error (`build manifest name is "sk-...", this package is "dsh-evolution"`),
 * so a secret pasted into the build manifest reached the pack guard, the
 * candidate inspection, the publisher's error and every log between them. The
 * same applied to the raw tar entry path in a reader rejection. Every surface
 * now names only a fixed field and a mismatch category — and this test follows
 * one sentinel through all of them, in a private `os.tmpdir()` fixture, while
 * proving `release/` and the candidate directories are never written to.
 */
test('no rejection surface echoes a candidate sentinel from metadata or an entry path', () => {
  const sentinel = METADATA_SENTINEL;
  const releaseBefore = committedReleaseSnapshot();

  // 1. the toolchain schema: a credential-shaped platform is not a platform.
  const toolchainProblems = builtWithProblems({ node: 'v26.12.0', npm: '11.20.0', platform: sentinel });
  assert.match(toolchainProblems.join('\n'), /builtWith\.platform is not a Node platform-architecture pair/);
  assert.equal(toolchainProblems.join('\n').includes(sentinel), false, 'a rejected platform must not be echoed');
  assert.equal(
    builtWithProblems({ node: sentinel, npm: '11.20.0', platform: 'linux-x64' }).join('\n').includes(sentinel),
    false,
    'nor may a sentinel in another field be echoed',
  );

  // Every documented Node OS/architecture pair is still accepted, whatever
  // machine this runs on: the schema is cross-machine, not "this process only".
  for (const platform of [
    'darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'linux-arm', 'linux-ia32',
    'linux-ppc64', 'linux-s390x', 'linux-riscv64', 'linux-loong64', 'win32-x64', 'win32-arm64',
    'freebsd-x64', 'openbsd-arm64', 'android-arm64', 'aix-ppc64', 'sunos-x64', 'haiku-x64',
  ]) {
    assert.deepEqual(builtWithProblems({ node: 'v26.12.0', npm: '11.20.0', platform }), [], platform);
  }

  // 2. the build manifest check the publisher runs before pinning.
  const expected = verifiedForThisTree();
  const archive = {
    filename: FILENAME,
    sha256: expected.sha256,
    contentSha256: expected.contentSha256,
    entries: expected.entries.length,
    modes: modesOf(readTarEntries(ARTIFACT)),
  };
  const baseManifest = {
    name: packageManifest.name,
    version: packageManifest.version,
    filename: FILENAME,
    sha256: archive.sha256,
    contentSha256: archive.contentSha256,
    entries: archive.entries,
    modes: archive.modes,
    builtWith: { node: 'v26.12.0', npm: '11.20.0', platform: 'darwin-arm64' },
  };
  const namedManifest = { ...baseManifest, name: sentinel };
  const manifestProblems = inspectBuildManifest({ packageManifest, buildManifest: namedManifest, archive });
  assert.match(manifestProblems.join('\n'), /build manifest name does not match this package/);
  assert.equal(manifestProblems.join('\n').includes(sentinel), false, 'the manifest report must not echo the value');

  // 3. the candidate inspection, with the sentinel as the build manifest name.
  const namedDir = freshDir();
  fs.writeFileSync(path.join(namedDir, FILENAME), ARTIFACT_BYTES);
  fs.writeFileSync(path.join(namedDir, 'manifest.json'), `${JSON.stringify(namedManifest, null, 2)}\n`);
  fs.writeFileSync(path.join(namedDir, 'SHA256SUMS'), `${archive.sha256}  ${FILENAME}\n`);
  const beforeNamed = snapshot(namedDir);
  const namedResult = inspectCandidateBuild({ fromDir: namedDir, filename: FILENAME, packageManifest, verified: expected });
  assert.ok(namedResult.problems.length > 0, 'a candidate naming another package must be refused');
  assert.match(namedResult.problems.join('\n'), /build manifest name does not match this package/);
  assert.equal(namedResult.problems.join('\n').includes(sentinel), false, 'the candidate report must not echo the value');
  assert.deepEqual(snapshot(namedDir), beforeNamed, 'inspecting a rejected candidate must not touch it');

  // 4. the tar reader and the candidate inspection, with the sentinel as an
  // illegal entry's path. The rejection names the entry's position and type.
  const entryBytes = tarWith({ name: `package/${sentinel}`, type: '2' });
  const entryFile = writeTarball('sentinel-entry.tgz', entryBytes);
  const entryError = captureError(() => readTarEntries(entryFile));
  assert.match(entryError.message, /tar entry 0 at byte 0: unsupported entry type \(symbolic link\)/);
  assert.equal(entryError.message.includes(sentinel), false, 'the rejected entry path must not be echoed');

  const entryDir = freshDir();
  fs.writeFileSync(path.join(entryDir, FILENAME), entryBytes);
  fs.writeFileSync(path.join(entryDir, 'manifest.json'), `${JSON.stringify({
    ...baseManifest,
    sha256: sha256Of(entryBytes),
    entries: 1,
    modes: ['0o644'],
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(entryDir, 'SHA256SUMS'), `${sha256Of(entryBytes)}  ${FILENAME}\n`);
  const beforeEntry = snapshot(entryDir);
  const entryResult = inspectCandidateBuild({ fromDir: entryDir, filename: FILENAME, packageManifest, verified: expected });
  assert.match(entryResult.problems.join('\n'), /is not a readable gzipped npm archive/);
  assert.match(entryResult.problems.join('\n'), /unsupported entry type/);
  assert.equal(entryResult.problems.join('\n').includes(sentinel), false, 'the tarball entry path must not be echoed');
  assert.equal(entryResult.archive, null);
  assert.deepEqual(snapshot(entryDir), beforeEntry, 'inspecting a rejected candidate must not touch it');

  // 5. the pack guard over an existing output whose manifest name is the
  // sentinel: the build is refused before anything is packed or installed.
  const packDir = path.join(scratch, 'sentinel-pack');
  fs.mkdirSync(packDir);
  fs.writeFileSync(path.join(packDir, 'manifest.json'), `${JSON.stringify({
    ...baseManifest,
    name: sentinel,
    filename: `${sentinel}-${packageManifest.version}.tgz`,
    sha256: 'a'.repeat(64),
    contentSha256: 'b'.repeat(64),
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(packDir, 'SHA256SUMS'), `${'a'.repeat(64)}  ${sentinel}-${packageManifest.version}.tgz\n`);
  const beforePack = snapshot(packDir);
  const packRun = spawnSync(process.execPath, [PACK, '--dist', packDir], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.notEqual(packRun.status, 0, 'pack must refuse a manifest that names another package');
  const packSurface = `${packRun.stdout}\n${packRun.stderr}`;
  assert.match(packSurface, /describes a different package/);
  assert.equal(packSurface.includes(sentinel), false, 'the pack guard must not echo the candidate name');
  assert.deepEqual(snapshot(packDir), beforePack, 'the output directory must be left as it was');

  // 6. the publisher's own error surface. The candidate is refused by the
  // inspection, so the run stops before any install: `release/` and the
  // candidate directory must be byte-identical afterwards.
  const publishRun = spawnSync(process.execPath, [PUBLISH, '--from', namedDir], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.notEqual(publishRun.status, 0, 'the publisher must refuse a candidate that names another package');
  const publishSurface = `${publishRun.stdout}\n${publishRun.stderr}`;
  assert.match(publishSurface, /build manifest name does not match this package/);
  assert.match(publishSurface, /nothing was pinned/, 'the run must say that it wrote nothing');
  assert.equal(publishSurface.includes(sentinel), false, 'the publisher error must not echo the candidate value');
  assert.deepEqual(committedReleaseSnapshot(), releaseBefore, 'a rejected candidate must be refused before anything is pinned');
  assert.deepEqual(snapshot(namedDir), beforeNamed, 'and the candidate directory must be left as it was');
});
