/**
 * Install-time integrity of a committed archive stage.
 *
 * Both cases were first reproduced against the unfixed implementation:
 * `installArchiveFiles` verified, created and renamed one file at a time, so a
 * stage whose second entry was un-installable had already replaced the first
 * live file, and a live intermediate directory that is a symlink redirected the
 * install outside the archive root. Nothing here weakens the released contract:
 * every staged file still has to match its recorded digest, and a successful
 * install still rewrites only the files the stage lists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installArchiveFiles } from '../lib/archive-stage.js';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const ACTIVE = 'state.json.cycles-archive.jsonl';
const OTHER = 'state.json.observations-archive.jsonl';
const SEGMENTS = 'state.json.cycles-archive.jsonl.segments';
const SEGMENT = `${SEGMENTS}/segment-000000000001.jsonl`;

function scratch(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-transaction-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
}

function record(file, content) {
  return { file, bytes: Buffer.byteLength(content), sha256: sha256(content) };
}

const bytes = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

/** A live tree with two committed archive files, and the matching stage. */
function fixture(t) {
  const live = scratch(t);
  const staging = scratch(t);
  write(path.join(live, ACTIVE), 'LIVE-ACTIVE\n');
  write(path.join(live, OTHER), 'LIVE-OTHER\n');
  write(path.join(staging, ACTIVE), 'STAGED-ACTIVE\n');
  write(path.join(staging, OTHER), 'STAGED-OTHER\n');
  return { live, staging };
}

test('P2-3: an un-installable later file leaves every live byte untouched', (t) => {
  const { live, staging } = fixture(t);
  const files = [record(ACTIVE, 'STAGED-ACTIVE\n'), record(OTHER, 'STAGED-OTHER\n')];

  // A damaged stage: the second entry's digest no longer matches its bytes.
  const corrupt = [files[0], { ...files[1], sha256: sha256('DAMAGED\n') }];
  assert.throws(() => installArchiveFiles(staging, live, corrupt), /E_DOMAIN_PENDING_ARCHIVE_CORRUPT/);
  assert.equal(bytes(path.join(live, ACTIVE)), 'LIVE-ACTIVE\n',
    'the first live file must not be replaced when a later staged file cannot be installed');
  assert.equal(bytes(path.join(live, OTHER)), 'LIVE-OTHER\n');

  // A stage that lost its second file must fail the same way.
  fs.unlinkSync(path.join(staging, OTHER));
  assert.throws(() => installArchiveFiles(staging, live, files), /E_DOMAIN_PENDING_ARCHIVE_MISSING/);
  assert.equal(bytes(path.join(live, ACTIVE)), 'LIVE-ACTIVE\n', 'a missing staged file must not publish a prefix of the stage');
  assert.equal(bytes(path.join(live, OTHER)), 'LIVE-OTHER\n');

  // A staged entry whose recorded length disagrees is rejected by length alone.
  write(path.join(staging, OTHER), 'STAGED-OTHER\n');
  assert.throws(() => installArchiveFiles(staging, live, [files[0], { ...files[1], bytes: 3 }]),
    /E_DOMAIN_PENDING_ARCHIVE_CORRUPT/);
  assert.equal(bytes(path.join(live, ACTIVE)), 'LIVE-ACTIVE\n');

  // Once the stage is sound again the replay installs all of it.
  installArchiveFiles(staging, live, files);
  assert.equal(bytes(path.join(live, ACTIVE)), 'STAGED-ACTIVE\n');
  assert.equal(bytes(path.join(live, OTHER)), 'STAGED-OTHER\n');
});

test('P2-9: an intermediate symlink is refused instead of writing outside the root', (t) => {
  const { live, staging } = fixture(t);
  const outside = scratch(t);
  fs.symlinkSync(outside, path.join(live, SEGMENTS));
  write(path.join(staging, SEGMENT), 'ESCAPED\n');
  const files = [record(SEGMENT, 'ESCAPED\n')];

  assert.throws(() => installArchiveFiles(staging, live, files), /Archive symlink rejected/);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing may be written through a symlinked intermediate directory');
  assert.equal(fs.lstatSync(path.join(live, SEGMENTS)).isSymbolicLink(), true, 'the live tree must be left exactly as it was');

  // The same rule protects the staged side: a stage that redirects a directory
  // outside its own root is not a stage this port will read from.
  fs.unlinkSync(path.join(live, SEGMENTS));
  const stagedSegments = path.join(staging, SEGMENTS);
  const stagedOutside = scratch(t);
  write(path.join(stagedOutside, 'segment-000000000001.jsonl'), 'ESCAPED\n');
  fs.rmSync(stagedSegments, { recursive: true, force: true });
  fs.symlinkSync(stagedOutside, stagedSegments);
  assert.throws(() => installArchiveFiles(staging, live, files), /Archive symlink rejected/);
  assert.equal(bytes(path.join(live, SEGMENT)), null, 'a rejected install creates no live file');

  // A regular file where a directory belongs is refused for the same reason.
  fs.unlinkSync(stagedSegments);
  write(stagedSegments, 'not a directory\n');
  assert.throws(() => installArchiveFiles(staging, live, files), /E_DOMAIN_PENDING_ARCHIVE_INVALID/);
  assert.equal(bytes(path.join(live, SEGMENT)), null);
});
