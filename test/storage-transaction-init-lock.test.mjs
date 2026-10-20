/**
 * Initialization and lock ownership of the domain archive writer.
 *
 * Both cases were first reproduced against the unfixed implementation: the two
 * archive roots were created outside the guarded initialization, so a failure
 * there left the storage medium open and the bare-pid lock held (the retry in
 * the same process then met its own pid), and a stale lock was reclaimed with a
 * plain `unlink` after a check, so a process that had already replaced the lock
 * lost it. Nothing here weakens the released contract: a dead owner's lock is
 * still reclaimed, and a live owner's lock is still refused.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDomainStorage } from '../lib/domain-storage.js';
// The official storage packages are dev dependencies of this repo, so the
// domain integration is exercised against the real official implementation.
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

const LOCK_NAME = 'domain-archive.lock';

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-init-lock-'));
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  const facility = new DomainFacility(ctx, { backend: 'json' });
  const closes = [];
  const open = facility.open.bind(facility);
  // Count the close calls the port makes on the medium it opened, so a failed
  // initialization can be held to closing what it opened.
  facility.open = async spec => {
    const domain = await open(spec);
    const close = domain.close.bind(domain);
    domain.close = async (...args) => { closes.push(Date.now()); return close(...args); };
    return domain;
  };
  ctx.storageDomain = facility;
  const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'), eventBridgeKey: 'b'.repeat(64) };
  return { root, ctx, config, backend, closes, lock: path.join(root, LOCK_NAME) };
}

async function teardown(f) { await f.backend.close(); fs.rmSync(f.root, { recursive: true, force: true }); }

/** A pid that is provably not running any more. */
function deadPid() {
  const output = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(output);
}

test('P2-4: a failed root creation closes the domain, releases the lock, and allows a retry', async () => {
  const f = await fixture();
  try {
    // A regular file where the archive root belongs: `mkdirSync` refuses.
    fs.writeFileSync(path.join(f.root, 'dockyard'), 'not a directory');
    await assert.rejects(openDomainStorage(f.ctx, f.config), error => error.code === 'EEXIST' || error.code === 'ENOTDIR');
    assert.equal(fs.existsSync(f.lock), false, 'a failed initialization must not leave the archive lock behind');
    assert.equal(f.closes.length, 1, 'the medium this attempt opened must be closed');

    fs.rmSync(path.join(f.root, 'dockyard'));
    const port = await openDomainStorage(f.ctx, f.config);
    await port.observe({ code: 'BENCH_ERROR', target: 'tool:retry' });
    await port.close();
    assert.equal(fs.existsSync(f.lock), false, 'a closed port releases its own lock');
  } finally { await teardown(f); }
});

test('P2-4: a failed staging creation is covered by the same guard', async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.root, 'domain-staging'), 'not a directory');
    await assert.rejects(openDomainStorage(f.ctx, f.config), error => error.code === 'EEXIST' || error.code === 'ENOTDIR');
    assert.equal(fs.existsSync(f.lock), false);
    assert.equal(f.closes.length, 1);
  } finally { await teardown(f); }
});

test('P2-4: a medium that refuses to open still releases the lock', async () => {
  const f = await fixture();
  try {
    f.ctx.storageDomain = { open: async () => { throw new Error('INJECTED_OPEN_FAILURE'); } };
    await assert.rejects(openDomainStorage(f.ctx, f.config), /INJECTED_OPEN_FAILURE/);
    assert.equal(fs.existsSync(f.lock), false);
    assert.deepEqual(fs.readdirSync(f.root).filter(name => name.startsWith(LOCK_NAME)), []);
  } finally { await teardown(f); }
});

test('P2-7a: a reclaim never deletes a lock another process acquired in between', async () => {
  const f = await fixture();
  const stale = deadPid();
  fs.writeFileSync(f.lock, String(stale));

  // Replace the stale lock with a live one exactly between the reclaim's read of
  // the old owner and its attempt to remove the entry.
  const originalRead = fs.readFileSync;
  let replaced = false;
  fs.readFileSync = function patched(file, ...args) {
    const content = originalRead.call(fs, file, ...args);
    if (!replaced && path.resolve(String(file)) === path.resolve(f.lock) && String(content).trim() === String(stale)) {
      replaced = true;
      fs.writeFileSync(f.lock, String(process.pid));
    }
    return content;
  };
  try {
    await assert.rejects(openDomainStorage(f.ctx, f.config), /E_DOMAIN_ARCHIVE_LOCK/);
  } finally { fs.readFileSync = originalRead; }

  assert.equal(replaced, true, 'the competing replacement must actually have happened');
  assert.equal(fs.readFileSync(f.lock, 'utf8'), String(process.pid),
    'the lock another process acquired must survive the reclaim attempt');
  assert.deepEqual(fs.readdirSync(f.root).filter(name => name.startsWith(LOCK_NAME)), [LOCK_NAME],
    'a failed reclaim leaves exactly one lock entry and no temporary copy');
  await teardown(f);
});

test('P2-7a: close does not remove a lock another owner now holds', async () => {
  const f = await fixture();
  try {
    const port = await openDomainStorage(f.ctx, f.config);
    assert.equal(fs.readFileSync(f.lock, 'utf8'), String(process.pid));
    // Another owner takes the path while this port is still open.
    fs.rmSync(f.lock);
    fs.writeFileSync(f.lock, String(process.ppid));
    await port.close();
    assert.equal(fs.readFileSync(f.lock, 'utf8'), String(process.ppid),
      'a release must not delete a lock whose bytes and inode are not the ones it wrote');
    assert.deepEqual(fs.readdirSync(f.root).filter(name => name.startsWith(LOCK_NAME)), [LOCK_NAME]);
  } finally {
    fs.rmSync(f.lock, { force: true });
    await teardown(f);
  }
});

test('P2-7a: a dead owner is still reclaimed and a live owner is still refused', async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(f.lock, String(deadPid()));
    const port = await openDomainStorage(f.ctx, f.config);
    assert.equal(fs.readFileSync(f.lock, 'utf8'), String(process.pid), 'a dead owner is reclaimed');
    await port.close();
    assert.equal(fs.existsSync(f.lock), false);

    fs.writeFileSync(f.lock, String(process.ppid));
    await assert.rejects(openDomainStorage(f.ctx, f.config), /E_DOMAIN_ARCHIVE_LOCK/);
    assert.equal(fs.readFileSync(f.lock, 'utf8'), String(process.ppid), 'a live owner keeps its lock');
  } finally {
    fs.rmSync(f.lock, { force: true });
    await teardown(f);
  }
});
