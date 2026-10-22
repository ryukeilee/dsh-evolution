/**
 * Publishing a committed archive stage.
 *
 * `installArchiveFiles` verifies every staged file against the digest recorded
 * in the durable pending record and then gives the verified staged inode its
 * live name (`link` plus `rename`) instead of copying the bytes into a new file
 * and fsyncing that copy. The staged entry is deliberately left in place: it is
 * the copy a replay installs from, so a crash in the middle of an install still
 * leaves one durable copy per recorded file.
 *
 * These cases pin the properties that make that substitution legal - the bytes
 * installed are the bytes verified, the live entry is replaced atomically, the
 * staged copy survives, re-running installs the same thing, and a filesystem
 * that refuses the link falls back to writing the verified bytes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { installArchiveFiles, mirrorArchives, changedArchiveFiles } from '../lib/archive-stage.js';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const ACTIVE = 'state.json.cycles-archive.jsonl';
const OTHER = 'state.json.observations-archive.jsonl';
const SEGMENTS = 'state.json.cycles-archive.jsonl.segments';
const SEGMENT = `${SEGMENTS}/segment-000000000001.jsonl`;

function scratch(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-publish-'));
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
const inode = file => { const stat = fs.lstatSync(file, { bigint: true }); return `${stat.dev}:${stat.ino}`; };
const temporaries = directory => fs.readdirSync(directory).filter(name => name.includes('.tmp'));

/** A live tree with two committed archive files plus a sealed segment. */
function fixture(t) {
  const live = scratch(t);
  const staging = scratch(t);
  write(path.join(live, ACTIVE), 'LIVE-ACTIVE\n');
  write(path.join(live, OTHER), 'LIVE-OTHER\n');
  write(path.join(live, SEGMENT), 'LIVE-SEGMENT\n');
  write(path.join(staging, ACTIVE), 'STAGED-ACTIVE\n');
  write(path.join(staging, SEGMENT), 'STAGED-SEGMENT\n');
  return { live, staging };
}

test('a published file is the verified staged inode, and the staged copy stays', (t) => {
  const { live, staging } = fixture(t);
  const files = [record(ACTIVE, 'STAGED-ACTIVE\n'), record(SEGMENT, 'STAGED-SEGMENT\n')];
  const stagedActive = inode(path.join(staging, ACTIVE));
  const liveActive = inode(path.join(live, ACTIVE));

  installArchiveFiles(staging, live, files);

  assert.equal(bytes(path.join(live, ACTIVE)), 'STAGED-ACTIVE\n');
  assert.equal(bytes(path.join(live, SEGMENT)), 'STAGED-SEGMENT\n');
  assert.notEqual(inode(path.join(live, ACTIVE)), liveActive, 'the live entry must be replaced, not written through');
  assert.equal(inode(path.join(live, ACTIVE)), stagedActive,
    'the published file must be the inode whose bytes were verified');
  assert.equal(inode(path.join(live, SEGMENT)), inode(path.join(staging, SEGMENT)));
  assert.equal(bytes(path.join(staging, ACTIVE)), 'STAGED-ACTIVE\n',
    'the staged copy is what a replay installs from and must survive the publish');
  assert.equal(fs.lstatSync(path.join(live, ACTIVE), { bigint: true }).mode & 0o777n, 0o600n,
    'the published file keeps the staged mode');
  // The change list names two files; the untouched live file is not published.
  assert.equal(bytes(path.join(live, OTHER)), 'LIVE-OTHER\n');
  assert.deepEqual(temporaries(live), [], 'the atomic replace leaves no temporary entry behind');
});

test('publishing writes no second copy of a durable file', (t) => {
  const { live, staging } = fixture(t);
  const files = [record(ACTIVE, 'STAGED-ACTIVE\n'), record(SEGMENT, 'STAGED-SEGMENT\n')];
  const written = [];
  const synced = [];
  const originalWrite = fs.writeFileSync;
  const originalSync = fs.fsyncSync;
  fs.writeFileSync = function traced(...values) { written.push(String(values[0])); return originalWrite.apply(this, values); };
  fs.fsyncSync = function traced(...values) { synced.push(values[0]); return originalSync.apply(this, values); };
  syncBuiltinESMExports();
  try { installArchiveFiles(staging, live, files); }
  finally {
    fs.writeFileSync = originalWrite;
    fs.fsyncSync = originalSync;
    syncBuiltinESMExports();
  }
  assert.deepEqual(written, [], 'no staged file may be rewritten into the live tree');
  // The only remaining fsyncs are the destination directories: the file data was
  // already durable when the stage committed (`syncStage`), so publishing it
  // needs the directory entry to be durable, not the bytes again.
  for (const descriptor of synced) assert.equal(typeof descriptor, 'number', 'only directory fsyncs remain');
});

test('a filesystem that refuses the link falls back to writing the verified bytes', (t) => {
  const { live, staging } = fixture(t);
  const files = [record(ACTIVE, 'STAGED-ACTIVE\n'), record(SEGMENT, 'STAGED-SEGMENT\n')];
  const original = fs.linkSync;
  fs.linkSync = () => { const error = new Error('EXDEV: cross-device link not permitted'); error.code = 'EXDEV'; throw error; };
  syncBuiltinESMExports();
  try { installArchiveFiles(staging, live, files); }
  finally { fs.linkSync = original; syncBuiltinESMExports(); }

  assert.equal(bytes(path.join(live, ACTIVE)), 'STAGED-ACTIVE\n');
  assert.equal(bytes(path.join(live, SEGMENT)), 'STAGED-SEGMENT\n');
  assert.notEqual(inode(path.join(live, ACTIVE)), inode(path.join(staging, ACTIVE)),
    'the fallback publishes a copy, never the staged inode');
  assert.equal(fs.lstatSync(path.join(live, ACTIVE), { bigint: true }).mode & 0o777n, 0o600n);
  assert.deepEqual(temporaries(live), []);
});

test('replaying the same install publishes the same bytes again', (t) => {
  const { live, staging } = fixture(t);
  const files = [record(ACTIVE, 'STAGED-ACTIVE\n'), record(SEGMENT, 'STAGED-SEGMENT\n')];
  installArchiveFiles(staging, live, files);
  const first = { active: inode(path.join(live, ACTIVE)), segment: inode(path.join(live, SEGMENT)) };
  assert.equal(fs.lstatSync(path.join(staging, ACTIVE), { bigint: true }).nlink, 2n,
    'the staged entry and the live entry share the verified inode');

  installArchiveFiles(staging, live, files);

  assert.equal(bytes(path.join(live, ACTIVE)), 'STAGED-ACTIVE\n');
  assert.equal(bytes(path.join(live, SEGMENT)), 'STAGED-SEGMENT\n');
  assert.equal(inode(path.join(live, ACTIVE)), first.active, 'a replay keeps the same committed inode');
  assert.equal(inode(path.join(live, SEGMENT)), first.segment);
  assert.equal(fs.lstatSync(path.join(staging, ACTIVE), { bigint: true }).nlink, 2n,
    'a replay must not accumulate links');
  assert.deepEqual(temporaries(live), []);
});

test('the whole change list is still verified before anything is published', (t) => {
  const { live, staging } = fixture(t);
  const files = [record(ACTIVE, 'STAGED-ACTIVE\n'), record(SEGMENT, 'STAGED-SEGMENT\n')];
  const damaged = [files[0], { ...files[1], sha256: sha256('DAMAGED\n') }];
  assert.throws(() => installArchiveFiles(staging, live, damaged), /E_DOMAIN_PENDING_ARCHIVE_CORRUPT/);
  assert.equal(bytes(path.join(live, ACTIVE)), 'LIVE-ACTIVE\n',
    'a stage that cannot be installed in full must not publish a prefix of itself');
  assert.equal(bytes(path.join(live, SEGMENT)), 'LIVE-SEGMENT\n');
  assert.equal(bytes(path.join(staging, ACTIVE)), 'STAGED-ACTIVE\n', 'a refused install consumes nothing');
});

test('a staged tree is built with one directory creation per directory', (t) => {
  const live = scratch(t);
  const stage = path.join(scratch(t), 'stage-1');
  for (let index = 1; index <= 8; index++) {
    write(path.join(live, `${SEGMENTS}/segment-${String(index).padStart(12, '0')}.jsonl`), `{"id":"${index}"}\n`);
  }
  write(path.join(live, ACTIVE), '{"id":"active"}\n');
  const created = [];
  const original = fs.mkdirSync;
  fs.mkdirSync = function traced(target, ...rest) { created.push(String(target)); return original.call(this, target, ...rest); };
  syncBuiltinESMExports();
  let snapshot;
  try { snapshot = mirrorArchives(live, stage); }
  finally { fs.mkdirSync = original; syncBuiltinESMExports(); }
  // The stage root and the segment directory: the mirror must not ask for the
  // same directory once per mirrored file.
  assert.deepEqual([...new Set(created)].sort(), [stage, path.join(stage, SEGMENTS)].sort());
  assert.equal(created.length, 2);
  assert.deepEqual(changedArchiveFiles(stage, snapshot), [], 'the mirror shares every inode');
});

test('a live entry that is not the staged inode is replaced, never followed', (t) => {
  const { live, staging } = fixture(t);
  const target = path.join(live, ACTIVE);
  const outside = path.join(scratch(t), 'outside.jsonl');
  write(outside, 'OUTSIDE\n');
  fs.rmSync(target);
  fs.symlinkSync(outside, target);
  const files = [record(ACTIVE, 'STAGED-ACTIVE\n')];

  installArchiveFiles(staging, live, files);

  assert.equal(fs.lstatSync(target).isSymbolicLink(), false, 'the published entry replaces the link itself');
  assert.equal(bytes(target), 'STAGED-ACTIVE\n');
  assert.equal(bytes(outside), 'OUTSIDE\n', 'nothing is ever written through the live entry');
});

/**
 * A crash between two publishes of one change list, through the real port.
 * The first entry is already on the live tree as the verified staged inode when
 * the second one fails, so the restart has to finish the install without
 * publishing the first entry a second time.
 */
test('a restart finishes a half-published stage and publishes only what is missing', async (t) => {
  const { openDomainStorage } = await import('../lib/domain-storage.js');
  const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
  const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');
  const root = scratch(t);
  const live = path.join(root, 'dockyard');
  fs.mkdirSync(live, { recursive: true, mode: 0o700 });
  // One default hot window, so the first observation overflows it and archives.
  write(path.join(live, 'state.json'), JSON.stringify({ evolution: { schema: 4,
    observations: Array.from({ length: 50 }, (_, index) => ({ type: 'tool/result', code: 'SEED', message: 'seeded',
      componentId: `plugin:seed-${index}`, severity: 'info', status: 'observed', success: true,
      recordedAt: '2026-10-12T00:00:00.000Z', id: `seed-${index}` })) } }));
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'),
    eventBridgeKey: 'b'.repeat(64), domainSeed: true };
  const observe = { type: 'agent/error', code: 'AGENT_ERROR', message: 'partial publish', target: 'tool:partial',
    componentId: 'agent', severity: 'error', status: 'failed' };
  t.after(async () => { await backend.close(); });

  const liveIndex = path.join(live, 'state.json.evolution-archive-index.json');
  const liveArchive = path.join(live, 'state.json.observations-archive.jsonl');
  const oldArchive = '{"id":"cold"}\n';
  write(liveArchive, oldArchive);
  const port = await openDomainStorage(ctx, config);
  let pending = null;
  let firstFailure = false;
  const originalRename = fs.renameSync;
  fs.renameSync = function (from, to) {
    // The change list is ordered by name, so the index publishes first. Fail the
    // archive publish: the index has to stay published and the archive must not.
    if (to === liveArchive && !firstFailure) {
      firstFailure = true;
      pending = ctx.storageDomain.get('evolution_domain').global.get().pending;
      throw new Error('INJECTED_SECOND_PUBLISH');
    }
    return originalRename.call(this, from, to);
  };
  let failure = null;
  try { await port.observe(observe); } catch (error) { failure = error; }
  fs.renameSync = originalRename;
  assert.match(String(failure?.message), /INJECTED_SECOND_PUBLISH/);
  assert.equal(fs.readdirSync(path.join(root, 'domain-staging')).length, 1, 'the refused stage stays on disk as the record');
  assert.ok(pending?.files?.length >= 2, 'the durable pending record must list the whole change list');
  assert.equal(bytes(liveArchive), oldArchive, 'the failed entry must not be published');
  assert.equal(inode(liveIndex), inode(path.join(root, 'domain-staging', pending.stage,
    'state.json.evolution-archive-index.json')), 'the interrupted install already published the index by inode');
  const staged = fs.readFileSync(path.join(root, 'domain-staging', pending.stage,
    'state.json.observations-archive.jsonl'), 'utf8');
  await assert.rejects(port.close(), /INJECTED_SECOND_PUBLISH/);

  // Recovery publishes only what the interruption left unpublished; a second
  // publish of the index entry would consume another staged inode.
  const publishes = [];
  const originalLink = fs.linkSync;
  fs.linkSync = function (from, to) {
    if (String(to).startsWith(live)) publishes.push(String(from));
    return originalLink.call(this, from, to);
  };
  let restarted;
  try { restarted = await openDomainStorage(ctx, config); }
  finally { fs.linkSync = originalLink; syncBuiltinESMExports(); }
  assert.equal(ctx.storageDomain.get('evolution_domain').global.get().pending, null);
  assert.deepEqual(publishes.map(file => path.basename(file)), ['state.json.observations-archive.jsonl'],
    'recovery must not republish an entry that is already installed');
  assert.equal(bytes(liveArchive), staged, 'recovery installs the entry the interruption left unpublished');
  assert.equal(fs.existsSync(path.join(root, 'domain-staging', pending.stage)), false);
  assert.deepEqual(temporaries(live), [], 'neither the interrupted install nor the replay leaves a temporary entry');
  assert.equal((await restarted.query('observations')).count > 0, true);
  await restarted.close();
});
