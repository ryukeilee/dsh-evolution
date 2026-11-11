// Regression for the shared-publication lock (review round: reliability closure).
//
// The original `publishLockIsReclaimable()` returned "reclaimable" as soon as
// the lock file's mtime was older than 10s, *before* reading the owner. A live
// same-host publisher that held the lock through a slow fsync, a paused process
// or a long publication was therefore evicted, two writers entered the index
// read-modify-write at the same time, and the record one of them had already
// reported as published was overwritten by the other.
//
// The lock is now a small SQLite database acquired with `BEGIN IMMEDIATE`.
// SQLite provides atomic acquisition, cross-process exclusion and crash
// rollback, so there is no lease to reclaim: no mtime window, no reclaim
// marker, and no way for a paused holder to be judged gone while it is alive.
// These regressions drive real child processes for the cases a same-process
// test cannot prove: a live holder blocks, and a crashed holder does not wedge
// publishing.
//
// Every fixture lives under a fresh os.tmpdir() directory. Nothing here reads a
// real DSH home or a real promotion.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  buildSharedRecord,
  publishSharedRecord,
  readSharedIndex,
  sharingPaths,
} from '../lib/promoted-sharing.js';

const HEX = (value) => crypto.createHash('sha256').update(value).digest('hex');
const HOST = { profile: 'desktop', dsh: '0.2.3', cordis: '4.1.0', include: '1.1.0', node: process.version, capturedAt: '2026-01-01T00:00:00.000Z' };
const CAPABILITIES = { fiberLifecycle: true, fiberAwait: true, include: true, toolsRegistry: true };

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

async function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fs.access(file);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${path.basename(file)}`);
      await new Promise((resolve) => { setTimeout(resolve, 10); });
    }
  }
}

function spawnLockHolder(dbPath, readyPath, mode) {
  const code = mode === 'crash'
    ? `const { DatabaseSync } = require('node:sqlite'); const fs = require('node:fs');
       const db = new DatabaseSync(process.argv[1]);
       db.exec('PRAGMA busy_timeout=0'); db.exec('BEGIN IMMEDIATE');
       fs.writeFileSync(process.argv[2], 'ready'); process.exit(0);`
    : `const { DatabaseSync } = require('node:sqlite'); const fs = require('node:fs');
       const db = new DatabaseSync(process.argv[1]);
       db.exec('PRAGMA busy_timeout=0'); db.exec('BEGIN IMMEDIATE');
       fs.writeFileSync(process.argv[2], 'ready'); setInterval(() => {}, 1000);`;
  return spawn(process.execPath, ['-e', code, dbPath, readyPath], { stdio: ['ignore', 'ignore', 'ignore'] });
}

test('concurrent publications serialize and never lose a record', async (t) => {
  const env = await fixture(t);
  const records = [await buildRecord(env)];
  for (let index = 0; index < 5; index += 1) {
    records.push(await addRecord(env, {
      id: `exp-lock-concurrent-${index}`,
      pluginName: `dsh-evolution-promoted-${String(index).padStart(12, 'b')}`,
    }));
  }
  const results = await Promise.all(records.map((record) => publishSharedRecord(env.paths, record)));
  for (const result of results) assert.ok(['published', 'updated'].includes(result.status), JSON.stringify(result));
  const index = await readSharedIndex(env.paths);
  assert.deepEqual(index.records.map((row) => row.id).sort(), records.map((record) => record.id).sort());
});

test('a live publisher blocks a second one and the second fails closed', async (t) => {
  const env = await fixture(t);
  const record = await buildRecord(env);
  const { lockPath } = sharingPaths(env.paths);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const ready = path.join(env.root, 'holder.ready');
  const holder = spawnLockHolder(lockPath, ready, 'hold');
  t.after(() => { try { holder.kill('SIGKILL'); } catch { /* already gone */ } });
  await waitForFile(ready);
  const started = Date.now();
  await assert.rejects(publishSharedRecord(env.paths, record), (error) => error?.code === 'E_SHARED_PUBLISH_BUSY');
  assert.ok(Date.now() - started >= 2000, 'the waiter respected its bounded wait before failing closed');
  assert.equal((await readSharedIndex(env.paths)).status, 'absent', 'the blocked publisher wrote nothing');
  holder.kill('SIGKILL');
  await new Promise((resolve) => holder.once('exit', resolve));
  const published = await publishSharedRecord(env.paths, record);
  assert.equal(published.status, 'published');
});

test('a publisher that crashes while holding the lock does not wedge publishing', async (t) => {
  const env = await fixture(t);
  const record = await buildRecord(env);
  const { lockPath } = sharingPaths(env.paths);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const ready = path.join(env.root, 'crasher.ready');
  const crasher = spawnLockHolder(lockPath, ready, 'crash');
  const exitCode = await new Promise((resolve) => crasher.once('exit', resolve));
  assert.equal(exitCode, 0);
  await waitForFile(ready);
  // SQLite rolls the abandoned transaction back when the next connection opens;
  // the next publisher acquires and completes without a reclaim path.
  const published = await publishSharedRecord(env.paths, record);
  assert.equal(published.status, 'published');
  assert.equal((await readSharedIndex(env.paths)).records.length, 1);
});

test('the lock database is a private regular file and a non-file path is refused', async (t) => {
  const env = await fixture(t);
  const record = await buildRecord(env);
  await publishSharedRecord(env.paths, record);
  const { lockPath } = sharingPaths(env.paths);
  const stat = await fs.stat(lockPath);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.mode & 0o077, 0, 'the lock database is private to the owner');
  await fs.rm(lockPath, { force: true });
  await fs.mkdir(lockPath);
  await assert.rejects(publishSharedRecord(env.paths, record), /not a regular file/);
});

test('a leftover lease file from the previous protocol neither blocks nor is deleted', async (t) => {
  const env = await fixture(t);
  const record = await buildRecord(env);
  const { dir } = sharingPaths(env.paths);
  await fs.mkdir(dir, { recursive: true });
  const legacy = path.join(dir, '.publish.lock');
  const bytes = JSON.stringify({ token: 'legacy', pid: 999_999_999, hostname: os.hostname(), at: new Date(0).toISOString() });
  await fs.writeFile(legacy, bytes);
  assert.equal((await publishSharedRecord(env.paths, record)).status, 'published');
  assert.equal(await fs.readFile(legacy, 'utf8'), bytes, 'unknown on-disk state is preserved');
});

test('the first concurrent creators of the lock database all publish', async (t) => {
  const env = await fixture(t);
  const records = [];
  for (let index = 0; index < 4; index += 1) {
    records.push(await addRecord(env, {
      id: `exp-lock-first-${index}`,
      pluginName: `dsh-evolution-promoted-${String(index).padStart(12, 'c')}`,
    }));
  }
  const { paths } = env;
  const moduleUrl = new URL('../lib/promoted-sharing.js', import.meta.url).href;
  const pathsFile = path.join(env.root, 'paths.json');
  await fs.writeFile(pathsFile, JSON.stringify(paths));
  const recordFiles = [];
  for (const record of records) {
    const file = path.join(env.root, `${record.id}.record.json`);
    await fs.writeFile(file, JSON.stringify(record));
    recordFiles.push(file);
  }
  const code = `(async () => {
    const fs = require('node:fs');
    const mod = await import(process.argv[1]);
    const paths = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const record = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    const result = await mod.publishSharedRecord(paths, record);
    process.exit(result.status === 'published' || result.status === 'updated' ? 0 : 3);
  })().catch((error) => { console.error(String(error?.code || error)); process.exit(2); });`;
  // Every process races on the very first creation of the lock database: the
  // loser of the exclusive create must join the winner's file, not fail.
  const children = recordFiles.map((recordFile) => spawn(process.execPath, ['-e', code, moduleUrl, pathsFile, recordFile], { stdio: ['ignore', 'ignore', 'pipe'] }));
  const errors = recordFiles.map(() => '');
  children.forEach((child, index) => { child.stderr.on('data', (chunk) => { errors[index] += String(chunk); }); });
  const codes = await Promise.all(children.map((child) => new Promise((resolve) => child.once('exit', (exitCode) => resolve(exitCode)))));
  assert.deepEqual(codes, [0, 0, 0, 0], errors.join(' | '));
  const index = await readSharedIndex(paths);
  assert.deepEqual(index.records.map((row) => row.id).sort(), records.map((record) => record.id).sort());
});
