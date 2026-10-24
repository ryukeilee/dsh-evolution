/**
 * `contentSha256` is the environment-independent identity of a released
 * package, so it must only be computed from content the reader actually
 * models. These tests pin that boundary for the tar reader:
 *
 *   - a regular-file archive keeps the exact digest the pre-fix reader
 *     produced, byte for byte (the committed pins must not move);
 *   - any entry type the reader cannot model — symbolic link, hard link,
 *     directory — is rejected with the entry named, instead of being skipped,
 *     because a skipped entry is invisible to the digest and would make two
 *     different archives share one `contentSha256`;
 *   - every committed artifact in `release/` still parses, and the pinned one
 *     still matches `release/manifest.json#contentSha256`.
 *
 * The fixtures are synthetic and live in `os.tmpdir()`; nothing here reads a
 * real DSH home, a credential, or the network.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import {
  RELEASE_DIR,
  archiveContentDigest,
  archiveEntries,
  readReleaseManifest,
  readTarEntries,
  releaseArtifactPath,
} from '../scripts/release/release-lib.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-release-integrity-tar-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// a minimal, deterministic ustar writer (no external tar)
// ---------------------------------------------------------------------------

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function headerBlock({ name, mode = 0o644, size = 0, type = '0', linkname = '' }) {
  const block = Buffer.alloc(512, 0);
  block.write(name, 0, 100, 'utf8');
  block.write(octal(mode, 8), 100, 8, 'utf8');
  block.write(octal(0, 8), 108, 8, 'utf8'); // uid
  block.write(octal(0, 8), 116, 8, 'utf8'); // gid
  block.write(octal(size, 12), 124, 12, 'utf8');
  block.write(octal(499162500, 12), 136, 12, 'utf8'); // mtime: node-tar's `portable` timestamp
  block.fill(0x20, 148, 156); // checksum field is spaces while summing
  block.write(type, 156, 1, 'utf8');
  block.write(linkname, 157, 100, 'utf8');
  block.write('ustar\0', 257, 6, 'utf8');
  block.write('00', 263, 2, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
  return block;
}

function entryBlock(entry) {
  const payload = entry.type === undefined || entry.type === '0' ? (entry.bytes ?? Buffer.alloc(0)) : Buffer.alloc(0);
  const parts = [headerBlock({ ...entry, size: payload.length })];
  if (payload.length > 0) {
    parts.push(payload);
    const padding = (512 - (payload.length % 512)) % 512;
    if (padding > 0) parts.push(Buffer.alloc(padding, 0));
  }
  return Buffer.concat(parts);
}

function tarball(entries) {
  return zlib.gzipSync(Buffer.concat([...entries.map(entryBlock), Buffer.alloc(1024, 0)]));
}

function writeFixture(name, bytes) {
  const file = path.join(scratch, name);
  fs.writeFileSync(file, bytes);
  return file;
}

// Two regular files: the only content every variant below has in common.
const README = { name: 'package/README.md', bytes: Buffer.from('hello dsh\n', 'utf8'), mode: 0o644 };
const INDEX = { name: 'package/index.js', bytes: Buffer.from('export default 1;\n', 'utf8'), mode: 0o644 };
const REGULAR_ONLY = tarball([README, INDEX]);

// The same two regular files plus one symbolic link that points outside the
// package. `tar` records the link target, not the file content, so a reader
// that skips it cannot tell this archive from `REGULAR_ONLY`.
const WITH_SYMLINK = tarball([
  README,
  INDEX,
  { name: 'package/index.js.link', type: '2', linkname: '/etc/passwd', mode: 0o777 },
]);

// ---------------------------------------------------------------------------
// regular files: identical behaviour, pinned to the exact pre-fix value
// ---------------------------------------------------------------------------

test('a regular-file-only archive keeps the exact content digest it had before the fail-closed change', () => {
  const file = writeFixture('regular-only.tgz', REGULAR_ONLY);
  // Recorded with the reader as it stood before non-regular entries were
  // rejected. The value must not move: `release/manifest.json` pins digests
  // produced by the same code path.
  assert.equal(archiveContentDigest(file), '2cf56659269a2a04829e5858f6169d31477e185f099c3a9bda1bd3b74bde04d2');
  assert.deepEqual(archiveEntries(file), [
    { path: 'README.md', mode: 0o644 },
    { path: 'index.js', mode: 0o644 },
  ]);
});

// ---------------------------------------------------------------------------
// unsupported entry types: rejected, named, not skipped
// ---------------------------------------------------------------------------

test('an archive whose only difference is a symbolic link is not collapsed onto the regular-only digest', () => {
  const regularFile = writeFixture('regular-only-copy.tgz', REGULAR_ONLY);
  const symlinkFile = writeFixture('with-symlink.tgz', WITH_SYMLINK);

  // The two archives really are different bytes ...
  assert.notEqual(
    crypto.createHash('sha256').update(fs.readFileSync(symlinkFile)).digest('hex'),
    crypto.createHash('sha256').update(fs.readFileSync(regularFile)).digest('hex'),
  );

  // ... and the content digest now refuses to speak for the one it cannot read,
  // instead of returning the same value for both.
  const regularDigest = archiveContentDigest(regularFile);
  assert.throws(
    () => archiveContentDigest(symlinkFile),
    (error) => {
      // The rejection reports the entry's position and type, never its path: an
      // entry name is archive content, so it is not printed back.
      assert.match(error.message, /tar entry \d+ at byte \d+: unsupported entry type/);
      assert.match(error.message, /symbolic link/);
      assert.equal(error.message.includes('index.js'), false, 'the rejected entry path must not be echoed');
      return true;
    },
  );
  assert.throws(() => readTarEntries(symlinkFile), /unsupported entry type/);
  assert.throws(() => archiveEntries(symlinkFile), /unsupported entry type/);
  assert.equal(regularDigest, archiveContentDigest(regularFile));
});

test('a hard link entry is rejected rather than skipped', () => {
  const file = writeFixture('with-hardlink.tgz', tarball([
    README,
    INDEX,
    { name: 'package/index.js.hard', type: '1', linkname: 'package/README.md' },
  ]));
  assert.throws(() => archiveContentDigest(file), (error) => {
    assert.match(error.message, /unsupported entry type/);
    assert.match(error.message, /hard link/);
    assert.equal(error.message.includes('index.js.hard'), false, 'the rejected entry path must not be echoed');
    return true;
  });
});

test('a directory entry is rejected rather than skipped', () => {
  // No committed artifact contains a directory entry (npm 11 writes none), so
  // there is no released evidence that ignoring them would be digest-safe.
  // Allowing one requires an artifact on hand, not a guess.
  const file = writeFixture('with-directory.tgz', tarball([
    README,
    INDEX,
    { name: 'package/lib/', type: '5' },
  ]));
  assert.throws(() => archiveContentDigest(file), (error) => {
    assert.match(error.message, /unsupported entry type/);
    assert.match(error.message, /directory/);
    assert.equal(error.message.includes('lib/'), false, 'the rejected entry path must not be echoed');
    return true;
  });
});

test('a pax extended header is rejected rather than skipped', () => {
  const file = writeFixture('with-pax.tgz', tarball([
    README,
    { name: 'PaxHeader/README.md', type: 'x', bytes: Buffer.from('30 path=package/README.md\n', 'utf8') },
  ]));
  assert.throws(() => archiveContentDigest(file), /pax extended header/);
});

// ---------------------------------------------------------------------------
// committed artifacts: nothing in release/ depended on the skipped entries
// ---------------------------------------------------------------------------

test('every committed artifact still parses under the fail-closed reader', () => {
  const artifacts = fs.readdirSync(RELEASE_DIR).filter((name) => name.endsWith('.tgz')).sort();
  assert.deepEqual(artifacts.length > 0, true, 'release/ must contain the pinned artifacts');
  for (const name of artifacts) {
    const entries = readTarEntries(path.join(RELEASE_DIR, name));
    assert.deepEqual(entries.length > 0, true, `${name} parsed to no entries`);
  }
});

test('the pinned artifact parses and still matches release/manifest.json#contentSha256', () => {
  const pin = readReleaseManifest();
  const artifact = releaseArtifactPath(pin);
  assert.equal(archiveContentDigest(artifact), pin.contentSha256);
  assert.equal(archiveEntries(artifact).length, pin.entries);
  const modes = [...new Set(archiveEntries(artifact).map((entry) => `0o${entry.mode.toString(8)}`))].sort();
  assert.deepEqual(modes, pin.modes);
});
