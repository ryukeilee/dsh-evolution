/**
 * A reclaim that has to put an already-moved lock entry back must not overwrite
 * whatever took the path in the meantime.
 *
 * `removeLockIfUnchanged` isolates the entry it inspected by renaming it to a
 * private name, verifies it there, and put it back when the verification fails.
 * That put-back used `fs.renameSync`, which silently replaces an existing target
 * - and the path is free for exactly as long as the isolation lasts, so another
 * process can acquire it in that window. The sequence below is that interleaving:
 * the checker inspects an old lock, another process replaces it, the checker
 * isolates the replacement, a third process acquires the now-free path, and the
 * failed verification renames the private copy back over the third process's
 * lock. Against the unfixed implementation the third lock was destroyed and its
 * holder believed it owned the archive.
 *
 * The window is residual by construction - the isolation has to make the path
 * free for the verification to be possible at all - so what is fixed is the
 * outcome: the restore is a non-overwriting link, and a path that is occupied
 * keeps its owner while the isolated entry is preserved as an auditable orphan
 * and the reclaim reports failure instead of success.
 *
 * The second test pins the paths that must not change: a dead owner is still
 * reclaimed, a live owner is still refused, and a lock this process wrote is
 * still released by its own close.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-fix-lock-reclaim-'));
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'), eventBridgeKey: 'b'.repeat(64) };
  return { root, ctx, config, backend, lock: path.join(root, LOCK_NAME) };
}

async function teardown(f) { await f.backend.close(); fs.rmSync(f.root, { recursive: true, force: true }); }

/** A pid that is provably not running any more. */
function deadPid() {
  const output = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(output);
}
/** A live holder of the lock path, so the refusal paths see a real owner. */
function liveHolder(t) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  t.after(() => child.kill());
  return { pid: child.pid, kill: () => child.kill() };
}

test('R5: a failed verification keeps the lock that took the path instead of overwriting it', async (t) => {
  const f = await fixture();
  const third = liveHolder(t); // the process that acquires the freed path
  const other = liveHolder(t);  // the process whose entry is isolated
  const stale = deadPid();
  fs.writeFileSync(f.lock, String(stale), { mode: 0o600 });

  // The deterministic interleaving: the isolation move of the *stale* lock is
  // what another process replaces, so the entry that lands under the private
  // name is not the one the checker inspected, and the path is free when the
  // third process takes it.
  const plainRename = fs.renameSync;
  let isolated = null, thirdInode = null;
  fs.renameSync = function interleaved(from, to) {
    if (isolated === null && path.resolve(String(from)) === path.resolve(f.lock) && String(to).includes('.released')) {
      // Another process replaces the lock after it was inspected.
      fs.unlinkSync(f.lock);
      fs.writeFileSync(f.lock, String(other.pid), { flag: 'wx', mode: 0o600 });
      const moved = plainRename.call(fs, from, to);
      isolated = String(to);
      // A third process acquires the path the isolation just freed.
      fs.writeFileSync(f.lock, String(third.pid), { flag: 'wx', mode: 0o600 });
      thirdInode = fs.statSync(f.lock).ino;
      return moved;
    }
    return plainRename.call(fs, from, to);
  };

  let error = null;
  try {
    await openDomainStorage(f.ctx, f.config);
  } catch (caught) { error = caught; } finally { fs.renameSync = plainRename; }

  assert.equal(isolated !== null, true, 'the isolation must actually have happened');
  assert.match(String(error?.message), /E_DOMAIN_ARCHIVE_LOCK/,
    'a reclaim whose put-back target is occupied reports failure instead of claiming success');
  assert.equal(fs.readFileSync(f.lock, 'utf8'), String(third.pid),
    'the lock the third process acquired must keep its bytes');
  assert.equal(fs.statSync(f.lock).ino, thirdInode,
    'the lock the third process acquired must keep its inode');
  assert.equal(fs.existsSync(isolated), false,
    'the isolated entry must not stay behind under its private name');
  const orphans = fs.readdirSync(f.root).filter((name) => name.startsWith(LOCK_NAME) && name.endsWith('.orphan'));
  assert.deepEqual(orphans.length, 1,
    `the isolated entry has to be preserved as exactly one auditable orphan, saw ${JSON.stringify(fs.readdirSync(f.root))}`);
  assert.equal(fs.readFileSync(path.join(f.root, orphans[0]), 'utf8'), String(other.pid),
    'the orphan must be the entry that was isolated, byte for byte');
  await teardown(f);
});

test('R5: a dead owner is still reclaimed, a live owner is still refused, and close still releases', async (t) => {
  const f = await fixture();
  try {
    fs.writeFileSync(f.lock, String(deadPid()), { mode: 0o600 });
    const port = await openDomainStorage(f.ctx, f.config);
    assert.equal(fs.readFileSync(f.lock, 'utf8'), String(process.pid), 'a dead owner is reclaimed');
    assert.deepEqual(fs.readdirSync(f.root).filter((name) => name.startsWith(LOCK_NAME)), [LOCK_NAME],
      'a reclaim that succeeded leaves no private copy behind');
    await port.close();
    assert.equal(fs.existsSync(f.lock), false, 'close releases the lock this process wrote');

    const holder = liveHolder(t);
    fs.writeFileSync(f.lock, String(holder.pid), { mode: 0o600 });
    await assert.rejects(openDomainStorage(f.ctx, f.config), /E_DOMAIN_ARCHIVE_LOCK/);
    assert.equal(fs.readFileSync(f.lock, 'utf8'), String(holder.pid), 'a live owner keeps its lock');
    assert.deepEqual(fs.readdirSync(f.root).filter((name) => name.startsWith(LOCK_NAME)), [LOCK_NAME],
      'a refused acquisition touches nothing');
  } finally {
    fs.rmSync(f.lock, { force: true });
    await teardown(f);
  }
});
