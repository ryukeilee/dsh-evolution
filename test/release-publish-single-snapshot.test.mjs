/**
 * The "is this pin intact?" answer describes one artifact, so both halves of it
 * — the byte hash the pin records and the content digest/entry count/modes
 * unpacked from it — must come from the same read of that file.
 *
 * It used to read the path twice: `fs.readFileSync(artifact)` for `sha256`, then
 * `readTarEntries(artifact)` for the entries. A pin whose `sha256` matched the
 * bytes present at the first read and whose `contentSha256` matched the bytes
 * present at the second was therefore reported as complete, even though no
 * single revision of the file ever carried both. This is the one state a pin
 * must never reach by accident, so the checks now derive everything from one
 * buffer.
 *
 * The regression below builds exactly that straddling pin from two snapshots of
 * the committed artifact and substitutes the bytes the file returns per read.
 * It first shows the pin agrees with neither snapshot on its own, then runs the
 * inspection in a child process where the substitution is live — the only place
 * a per-read answer can be installed, since the module's own `fs` object is what
 * is patched. Nothing here writes to the repository's `release/`.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  REPO_ROOT, contentDigestOf, readManifest, readReleaseManifest, readTarEntries, releaseArtifactPath,
} from '../scripts/release/release-lib.mjs';
import { inspectPinnedRelease } from '../scripts/release/publish-artifact.mjs';

const PUBLISH_MODULE = path.join(REPO_ROOT, 'scripts', 'release', 'publish-artifact.mjs');
const packageManifest = readManifest();
const pinned = readReleaseManifest();
const FILENAME = `${packageManifest.name}-${packageManifest.version}.tgz`;

/** Snapshot A: the committed artifact, byte for byte. */
const SNAPSHOT_A = fs.readFileSync(releaseArtifactPath(pinned));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-publish-single-snapshot-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function sha256Of(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function modesOf(entries) {
  return [...new Set(entries.map((entry) => entry.mode))].sort((a, b) => a - b).map((mode) => `0o${mode.toString(8)}`);
}

/**
 * Snapshot B: a valid archive with the same entries, entry count and modes as A
 * but different file content, so its content digest and its bytes both differ.
 */
function mutateFirstPayload(bytes) {
  const tar = Buffer.from(zlib.gunzipSync(bytes));
  for (let offset = 0, headers = 0; headers < 64; headers += 1) {
    assert.ok(offset + 512 <= tar.length, 'the committed artifact must have a non-empty entry');
    const size = parseInt(tar.toString('ascii', offset + 124, offset + 136).trim() || '0', 8);
    if (size > 0) {
      const mutated = Buffer.from(tar);
      mutated[offset + 512 + size - 1] ^= 0xff;
      return zlib.gzipSync(mutated);
    }
    offset += 512;
  }
  throw new Error('the committed artifact has no entry with content');
}

const SNAPSHOT_B = mutateFirstPayload(SNAPSHOT_A);
const ENTRIES_B = readTarEntries(SNAPSHOT_B);

/**
 * A pin that straddles the two snapshots: the byte hash of A, and the content
 * digest, entry count and modes of B.
 */
const STRADDLING_PIN = {
  name: packageManifest.name,
  version: packageManifest.version,
  filename: FILENAME,
  sha256: sha256Of(SNAPSHOT_A),
  contentSha256: contentDigestOf(ENTRIES_B),
  entries: ENTRIES_B.length,
  modes: modesOf(ENTRIES_B),
};

function releaseSet(label, artifactBytes) {
  const dir = path.join(scratch, label);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, FILENAME), artifactBytes);
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(STRADDLING_PIN, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${STRADDLING_PIN.sha256}  ${FILENAME}\n`);
  return { dir, artifact: path.join(dir, FILENAME) };
}

test('the straddling pin is satisfied by no single snapshot of the artifact', () => {
  assert.notEqual(sha256Of(SNAPSHOT_A), sha256Of(SNAPSHOT_B), 'the two snapshots must differ in bytes');
  assert.notEqual(contentDigestOf(readTarEntries(SNAPSHOT_A)), STRADDLING_PIN.contentSha256,
    'the two snapshots must differ in content');

  // Snapshot A only: the bytes match the pin, the content does not.
  const onlyA = releaseSet('only-a', SNAPSHOT_A);
  assert.deepEqual(inspectPinnedRelease({ releaseDir: onlyA.dir, selfConsistentOnly: true }).problems,
    ['the pinned artifact contains different content than release/manifest.json records']);

  // Snapshot B only: the content matches the pin, the bytes do not.
  const onlyB = releaseSet('only-b', SNAPSHOT_B);
  assert.deepEqual(inspectPinnedRelease({ releaseDir: onlyB.dir, selfConsistentOnly: true }).problems,
    ['the pinned artifact hashes to different bytes than release/manifest.json records']);
});

/**
 * The reader below answers the artifact path with A on the first read and B on
 * the second, so a two-read inspection would find a match for every field while
 * looking at two different files. It reports how many times the inspection
 * opened the artifact, and whether the substitution was live at all.
 */
const ALTERNATING_READER = `import fs from 'node:fs';

const [, , artifactPath, releaseDir, moduleUrl, snapshotAPath, snapshotBPath] = process.argv;
const original = fs.readFileSync;
const snapshotA = original.call(fs, snapshotAPath);
const snapshotB = original.call(fs, snapshotBPath);

let artifactReads = 0;
fs.readFileSync = function readFileSync(target, ...rest) {
  if (String(target) === artifactPath) {
    artifactReads += 1;
    return artifactReads === 1 ? snapshotA : snapshotB;
  }
  return original.call(fs, target, ...rest);
};

// Two direct reads must already disagree, or the measurement below says nothing.
const substitutionLive = !fs.readFileSync(artifactPath).equals(fs.readFileSync(artifactPath));

artifactReads = 0;
const { inspectPinnedRelease } = await import(moduleUrl);
const { problems } = inspectPinnedRelease({ releaseDir, selfConsistentOnly: true });
process.stdout.write(JSON.stringify({ substitutionLive, artifactReads, problems }));
`;

test('the inspection derives sha256 and entries from one read of the artifact', () => {
  const set = releaseSet('alternating', SNAPSHOT_B);
  const snapshotAFile = path.join(scratch, 'snapshot-a.tgz');
  const snapshotBFile = path.join(scratch, 'snapshot-b.tgz');
  const reader = path.join(scratch, 'alternating-reader.mjs');
  fs.writeFileSync(snapshotAFile, SNAPSHOT_A);
  fs.writeFileSync(snapshotBFile, SNAPSHOT_B);
  fs.writeFileSync(reader, ALTERNATING_READER);

  const child = spawnSync(process.execPath, [
    reader, set.artifact, set.dir, pathToFileURL(PUBLISH_MODULE).href, snapshotAFile, snapshotBFile,
  ], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const reported = JSON.parse(child.stdout);

  assert.equal(reported.substitutionLive, true, 'the per-read substitution must actually take effect');
  // Two reads used to mean "sha256 from one snapshot, content from the other".
  assert.equal(reported.artifactReads, 1, 'the artifact must be read exactly once');
  assert.deepEqual(reported.problems, ['the pinned artifact contains different content than release/manifest.json records']);
});
