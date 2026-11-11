// Regression for the shared-publication lock (review round: reliability closure).
//
// The original `publishLockIsReclaimable()` returned "reclaimable" as soon as
// the lock file's mtime was older than 10s, *before* reading the owner. A live
// same-host publisher that held the lock through a slow fsync, a paused process
// or a long publication was therefore evicted, two writers could enter the
// read-modify-write of `published.json` at the same time, and the record one of
// them had already committed (and reported as published) was overwritten by the
// other. The lock is now reclaimed by owner first (a live pid is never taken
// over), a provably dead same-host owner is recovered at once, and reclaiming
// an unowned/foreign lock is serialized by a sibling `.reclaim` marker so two
// reclaimers cannot delete a fresh lock one of them just created.
//
// Every fixture lives under a fresh os.tmpdir() directory. Nothing here reads a
// real DSH home or a real promotion.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  buildSharedRecord,
  publishSharedRecord,
  readSharedIndex,
  sharingPaths,
} from '../lib/promoted-sharing.js';

const HEX = (value) => crypto.createHash('sha256').update(value).digest('hex');
const HOST = { profile: 'desktop', dsh: '0.2.3', cordis: '4.1.0', include: '1.1.0', node: process.version, capturedAt: '2026-01-01T00:00:00.000Z' };
const CAPABILITIES = { fiberLifecycle: true, fiberAwait: true, include: true, toolsRegistry: true };
const DEAD_PID = 999_999_999;

async function scratch(name) {
  return fs.mkdtemp(path.join(os.tmpdir(), `evo-publish-lock-${name}-`));
}

async function fixture(t, { id = 'exp-lock-1', pluginName = 'dsh-evolution-promoted-abcdefabcdef' } = {}) {
  const root = await scratch('root');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = {
    dataRoot: root,
    presetDir: root,
    pluginRoot: path.join(root, 'promoted'),
    archiveDir: path.join(root, 'archive'),
  };
  const pluginDir = path.join(paths.pluginRoot, pluginName);
  await fs.mkdir(path.join(pluginDir, 'lib'), { recursive: true });
  const source = `export const name = ${JSON.stringify(pluginName)};\nexport const inject = ["tools"];\nexport function apply() {}\n`;
  await fs.writeFile(path.join(pluginDir, 'lib', 'index.js'), source);
  await fs.writeFile(path.join(pluginDir, 'package.json'), `${JSON.stringify({ name: pluginName, version: '0.1.0', type: 'module', main: 'lib/index.js' })}\n`);
  await fs.mkdir(paths.archiveDir, { recursive: true });
  const durable = {
    pluginName,
    pluginPath: pluginDir,
    moduleUrl: pathToFileURL(path.join(pluginDir, 'lib', 'index.js')).href,
    rowId: `evolution-promoted-${pluginName.slice('dsh-evolution-promoted-'.length)}`,
  };
  const experiment = {
    id,
    state: 'stable',
    stableCommittedAt: '2026-01-02T00:00:00.000Z',
    shareTargets: ['acp', 'web'],
    canary: {
      healthObservationWindow: 2,
      startupVerified: true,
      observations: [{ barrierId: 'startup:desktop' }, { barrierId: 'post:desktop' }],
    },
    decision: { version: 1, kind: 'benefit', source: 'canary-passed' },
    durable,
  };
  return { root, paths, pluginDir, source, durable, experiment };
}

async function buildRecord(env) {
  return buildSharedRecord({
    paths: env.paths,
    experiment: env.experiment,
    durable: env.durable,
    approvedProfiles: env.experiment.shareTargets,
    host: HOST,
    capabilities: CAPABILITIES,
    source: { stableCommittedAt: env.experiment.stableCommittedAt },
  });
}

/** Add one more promoted plugin under the same data root and build its record. */
async function addRecord(env, { id, pluginName }) {
  const pluginDir = path.join(env.paths.pluginRoot, pluginName);
  await fs.mkdir(path.join(pluginDir, 'lib'), { recursive: true });
  await fs.writeFile(path.join(pluginDir, 'lib', 'index.js'), env.source);
  await fs.writeFile(path.join(pluginDir, 'package.json'), `${JSON.stringify({ name: pluginName, version: '0.1.0', type: 'module', main: 'lib/index.js' })}\n`);
  const durable = {
    pluginName,
    pluginPath: pluginDir,
    moduleUrl: pathToFileURL(path.join(pluginDir, 'lib', 'index.js')).href,
    rowId: `evolution-promoted-${pluginName.slice('dsh-evolution-promoted-'.length)}`,
  };
  const experiment = { ...env.experiment, id, durable };
  return buildSharedRecord({
    paths: env.paths,
    experiment,
    durable,
    approvedProfiles: experiment.shareTargets,
    host: HOST,
    capabilities: CAPABILITIES,
    source: { stableCommittedAt: experiment.stableCommittedAt },
  });
}

async function writeLock(env, owner, { ageMs = 0 } = {}) {
  const { lockPath } = sharingPaths(env.paths);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, JSON.stringify(owner));
  if (ageMs > 0) {
    const old = new Date(Date.now() - ageMs);
    await fs.utimes(lockPath, old, old);
  }
  return lockPath;
}

function lockOwner(pid, extra = {}) {
  return { token: crypto.randomUUID(), pid, hostname: os.hostname(), at: new Date().toISOString(), ...extra };
}

async function readLock(env) {
  const { lockPath } = sharingPaths(env.paths);
  try {
    return JSON.parse(await fs.readFile(lockPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function reclaimLeftovers(directory) {
  return fs.readdir(directory).then((names) => names.filter((name) => name.includes('.reclaim') || name.endsWith('.stale') || name.includes('.tmp')));
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

test('a live same-host publisher keeps its lock past the stale window', async (t) => {
  const env = await fixture(t);
  const record = await buildRecord(env);
  // The owner is this live process; only the file age exceeds the stale window.
  const lockPath = await writeLock(env, lockOwner(process.pid), { ageMs: 60_000 });
  const stat = await fs.stat(lockPath);

  await assert.rejects(
    publishSharedRecord(env.paths, record),
    (error) => error?.code === 'E_SHARED_PUBLISH_BUSY',
    'a live owner must be waited out, never reclaimed',
  );
  // The live owner's lock survives untouched (same inode, same bytes), and no
  // index was written behind its back.
  const after = await fs.stat(lockPath);
  assert.equal(after.ino, stat.ino);
  assert.equal((await readLock(env)).pid, process.pid);
  assert.equal((await readSharedIndex(env.paths)).status, 'absent');
  await fs.rm(lockPath, { force: true });
});

test('a provably dead same-host owner is reclaimed at once, even when the lock is fresh', async (t) => {
  const env = await fixture(t);
  const record = await buildRecord(env);
  await writeLock(env, lockOwner(DEAD_PID), { ageMs: 0 });
  const result = await publishSharedRecord(env.paths, record);
  assert.equal(result.status, 'published');
  assert.equal(await readLock(env), null, 'the reclaimed lock is not left behind');
  assert.deepEqual(await reclaimLeftovers(path.dirname(sharingPaths(env.paths).lockPath)), []);
});

test('an unreadable or foreign lock is waited out while fresh and recovered once stale', async (t) => {
  const env = await fixture(t);
  const record = await buildRecord(env);
  const { lockPath } = sharingPaths(env.paths);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  // Foreign host: no pid proof is possible, so only the age window applies.
  const foreign = { token: 'foreign', pid: process.pid, hostname: `${os.hostname()}-elsewhere`, at: new Date().toISOString() };
  await writeLock(env, foreign);
  await assert.rejects(publishSharedRecord(env.paths, record), (error) => error?.code === 'E_SHARED_PUBLISH_BUSY');
  assert.equal((await readSharedIndex(env.paths)).status, 'absent');
  // Age the same lock past the window: it is now recoverable.
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(lockPath, old, old);
  const published = await publishSharedRecord(env.paths, record);
  assert.equal(published.status, 'published');

  // Malformed bytes are never guessed around while fresh either.
  await fs.writeFile(lockPath, '{"partial":');
  await assert.rejects(publishSharedRecord(env.paths, record), (error) => error?.code === 'E_SHARED_PUBLISH_BUSY');
  await fs.utimes(lockPath, old, old);
  assert.equal((await publishSharedRecord(env.paths, record)).status, 'unchanged');
});

test('a crashed reclaimer marker does not block lock recovery', async (t) => {
  const env = await fixture(t);
  const record = await buildRecord(env);
  const { lockPath } = sharingPaths(env.paths);
  await writeLock(env, lockOwner(DEAD_PID));
  await fs.writeFile(`${lockPath}.reclaim`, JSON.stringify(lockOwner(DEAD_PID)));
  const result = await publishSharedRecord(env.paths, record);
  assert.equal(result.status, 'published');
  assert.equal(await readLock(env), null);
  assert.deepEqual(await reclaimLeftovers(path.dirname(lockPath)), []);
  // A live reclaimer marker means another process is currently reclaiming the
  // dead lock: this attempt must fail closed instead of racing it.
  await writeLock(env, lockOwner(DEAD_PID));
  await fs.writeFile(`${lockPath}.reclaim`, JSON.stringify(lockOwner(process.pid)));
  await assert.rejects(publishSharedRecord(env.paths, record), (error) => error?.code === 'E_SHARED_PUBLISH_BUSY');
  await fs.rm(`${lockPath}.reclaim`, { force: true });
  await fs.rm(lockPath, { force: true });
});

test('reclaimers racing over a stale dead lock never lose a committed record', async (t) => {
  const env = await fixture(t);
  // A crashed publisher left its lock behind, and several processes start at
  // the same time: each publication must land, and none may delete the lock a
  // concurrent reclaimer has just created.
  await writeLock(env, lockOwner(DEAD_PID), { ageMs: 60_000 });
  const records = [await buildRecord(env)];
  for (let index = 0; index < 6; index += 1) {
    records.push(await addRecord(env, {
      id: `exp-lock-race-${index}`,
      pluginName: `dsh-evolution-promoted-${String(index).padStart(12, 'a')}`,
    }));
  }
  const target = env.paths;
  const results = await Promise.all(records.map((record) => publishSharedRecord(target, record)));
  for (const result of results) assert.ok(['published', 'updated'].includes(result.status), JSON.stringify(result));
  const index = await readSharedIndex(target);
  assert.equal(index.status, 'ok');
  assert.deepEqual(index.records.map((row) => row.id).sort(), records.map((record) => record.id).sort());
  assert.deepEqual(await reclaimLeftovers(path.dirname(sharingPaths(target).lockPath)), []);
  assert.equal(await fs.access(sharingPaths(target).lockPath).then(() => true).catch(() => false), false);
});

// The following two tests pin the interleavings an independent review used to
// demonstrate lost updates in the earlier implementation. They inject the exact
// pause points with the real `fs/promises` object the module imported (the same
// technique the archive-lock tests use), so they are deterministic rather than
// timing-dependent.

test('a paused acquirer never exposes a partial lock or loses the other publisher record', async (t) => {
  const env = await fixture(t);
  const pausedRecord = await buildRecord(env);
  const otherRecord = await addRecord(env, { id: 'exp-lock-partial-2', pluginName: 'dsh-evolution-promoted-bbbbbbbbbbbb' });
  const { lockPath } = sharingPaths(env.paths);
  const context = new AsyncLocalStorage();
  const pausedBeforePublish = deferred();
  const releasePause = deferred();
  const originalLink = fs.link;
  fs.link = async function (from, to, ...rest) {
    if (to === lockPath && context.getStore() === 'paused') {
      pausedBeforePublish.resolve();
      await releasePause.promise;
    }
    return originalLink.call(this, from, to, ...rest);
  };
  t.after(() => { fs.link = originalLink; });
  // A is paused after its owner record is complete but before it is published.
  // It never held a zero-byte lock, so B cannot mistake it for an abandoned one.
  const paused = context.run('paused', () => publishSharedRecord(env.paths, pausedRecord));
  await pausedBeforePublish.promise;
  // The paused writer has a complete owner record in a private temp file and no
  // lock at the published path: the property that replaced the zero-byte lock.
  await assert.rejects(fs.access(lockPath), (error) => error?.code === 'ENOENT');
  const other = await publishSharedRecord(env.paths, otherRecord);
  assert.equal(other.status, 'published');
  releasePause.resolve();
  const resumed = await paused;
  assert.equal(resumed.status, 'published');
  const index = await readSharedIndex(env.paths);
  assert.deepEqual(index.records.map((row) => row.id).sort(), [pausedRecord.id, otherRecord.id].sort());
  assert.equal(await fs.access(lockPath).then(() => true).catch(() => false), false);
});

test('a stale marker cleaner puts back a concurrent reclaimer marker instead of deleting it', async (t) => {
  const env = await fixture(t);
  const newRecord = await buildRecord(env);
  const staleRecord = await addRecord(env, { id: 'exp-lock-marker-2', pluginName: 'dsh-evolution-promoted-cccccccccccc' });
  const { lockPath } = sharingPaths(env.paths);
  const marker = `${lockPath}.reclaim`;
  // Both processes start from a crashed lock plus a crashed reclaimer marker.
  await writeLock(env, lockOwner(DEAD_PID), { ageMs: 60_000 });
  await fs.writeFile(marker, JSON.stringify(lockOwner(DEAD_PID)));
  const context = new AsyncLocalStorage();
  const staleAtClear = deferred();
  const releaseStale = deferred();
  const newAtLockRename = deferred();
  const releaseNew = deferred();
  const markerRestored = deferred();
  const originalRename = fs.rename;
  const originalLink = fs.link;
  let staleClearSeen = false;
  let newRenameSeen = false;
  fs.rename = async function (from, to, ...rest) {
    if (from === marker && context.getStore() === 'stale-cleaner' && !staleClearSeen) {
      staleClearSeen = true;
      staleAtClear.resolve();
      await releaseStale.promise;
    }
    if (from === lockPath && context.getStore() === 'new-reclaimer' && !newRenameSeen) {
      newRenameSeen = true;
      newAtLockRename.resolve();
      await releaseNew.promise;
    }
    return originalRename.call(this, from, to, ...rest);
  };
  fs.link = async function (from, to, ...rest) {
    const result = await originalLink.call(this, from, to, ...rest);
    if (to === marker && from.endsWith('.stale') && context.getStore() === 'stale-cleaner') markerRestored.resolve();
    return result;
  };
  t.after(() => { fs.rename = originalRename; fs.link = originalLink; });
  // The stale cleaner classifies the dead marker, then pauses before deleting it.
  const stale = context.run('stale-cleaner', () => publishSharedRecord(env.paths, staleRecord));
  await staleAtClear.promise;
  // A newer reclaimer clears the dead marker, publishes its own marker and
  // classifies the dead lock, then pauses before renaming the lock.
  const fresh = context.run('new-reclaimer', () => publishSharedRecord(env.paths, newRecord));
  await newAtLockRename.promise;
  const freshMarker = JSON.parse(await fs.readFile(marker, 'utf8'));
  assert.notEqual(freshMarker.token, 'reclaim');
  releaseStale.resolve();
  await markerRestored.promise; // the stale cleaner moved the live marker and put it back
  assert.deepEqual(JSON.parse(await fs.readFile(marker, 'utf8')), freshMarker, 'the live marker was restored byte-for-byte');
  releaseNew.resolve();
  const freshResult = await fresh;
  const staleResult = await stale;
  assert.equal(freshResult.status, 'published');
  assert.equal(staleResult.status, 'published');
  const index = await readSharedIndex(env.paths);
  assert.deepEqual(index.records.map((row) => row.id).sort(), [newRecord.id, staleRecord.id].sort());
  assert.deepEqual(await reclaimLeftovers(path.dirname(lockPath)), []);
});
