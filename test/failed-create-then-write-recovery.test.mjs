// A file created with `O_EXCL` and then not written is a durable artifact that
// the same code refuses to read, so one transient write error becomes permanent.
// Three creation sites had this shape, and all three created the artifact:
//
//  - `storageConfig()` (`lib/index.js`) creates `data/event-bridge.key` and then
//    validates it against `/^[a-f0-9]{64}$/`. A write that fails after the open
//    leaves a zero-length key, and every later session then refuses to start
//    ("Evolution event bridge key is invalid; refusing to replace it"). It must
//    refuse: replacing a key invalidates every MAC already written with it. The
//    only place that failure can be undone is the attempt that created the file.
//  - `EvolutionOrchestrator#acquireTargets()` (`lib/orchestrator.js`) creates the
//    target claim and writes the claim JSON into it. A failed write leaves an
//    empty claim, and the read side below only accepts a complete JSON claim - it
//    deliberately does not delete an entry it cannot interpret - so every later
//    `evolution_trial` for that target fails with "experiment ownership is
//    unreadable" until a human deletes the file.
//  - `acquireArchiveLock()` (`lib/domain-storage.js`) creates
//    `domain-archive.lock` and writes the pid into it. `readLockOwner()` can only
//    treat unparseable content as "no named owner", so an empty lock costs the
//    settle window and a truncated pid (`"1"` of `"1234"`) reads as a different,
//    possibly live, pid and refuses the archive for good.
//
// The fault injection below reproduces the exact on-disk state of that failure
// mode: `O_EXCL` creation succeeds (the file exists, zero length) and the
// following write raises ENOSPC. What it does not reproduce is the storage
// layer's own behaviour after the error - which is the point, because the port
// must not depend on it.
//
// The nine tests fall into three groups.
//
// Three cover a failed *write*: the key, the claim and the archive lock each
// assert that the half-created artifact is gone, that the original error still
// reaches the caller, that whatever in-memory claim the call took is released,
// and that the operation succeeds on the next attempt.
//
// One covers a failed *close* on the archive lock: the bytes reached the entry,
// the acquisition returned no token, and the lock is removed anyway, because a
// lock nobody holds would name this process as a live owner and refuse every
// later open in it.
//
// The other five are the opposite direction - what the cleanup must NOT remove:
//
//  - a failure raised *before* the entry existed removes nothing, because `wx`
//    never proved the entry was this call's;
//  - a write that completed keeps its bytes even when the descriptor then fails
//    to close, because a key or a claim is already valid and another session may
//    already have read it (asserted for both);
//  - the archive lock is removed by inode and not by path, because an empty lock
//    is reclaimable after the settle window: a port that stalled after its
//    exclusive open must not delete the lock a second port put there meanwhile,
//    and must not be able to prove ownership of it either.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EvolutionOrchestrator } from '../lib/orchestrator.js';
import { storageConfig } from '../lib/index.js';
import { openDomainStorage } from '../lib/domain-storage.js';
import { resolveEvolutionPaths } from '../lib/diagnostics.js';
import {
  scratchRoot, promotionPaths, orchestratorContext, execFor, exists,
} from './orchestrator-durability-fixtures.mjs';
// The official storage packages are dev dependencies of this repo, so the lock
// is exercised against the real official implementation.
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

const KEY_PATH_RE = /^[a-f0-9]{64}$/;

function enospc() {
  return Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
}

/**
 * Replace one descriptor write with "the exclusive open succeeded, the write did
 * not". Every site under test opens the file itself and then writes the numeric
 * descriptor, so the entry really is created (zero length) before the failure -
 * which is exactly the post-failure state a full disk produces.
 */
function failAfterCreate(t, file) {
  const realWriteFileSync = fs.writeFileSync;
  const realOpenSync = fs.openSync;
  let injected = 0;
  let targetFd = -1;
  fs.openSync = function patchedOpen(target, ...rest) {
    const fd = realOpenSync.call(fs, target, ...rest);
    if (String(target) === file) targetFd = fd;
    return fd;
  };
  fs.writeFileSync = function patchedWrite(target, ...rest) {
    if (typeof target === 'number' && target === targetFd && injected === 0) {
      injected += 1;
      targetFd = -1;
      throw enospc();
    }
    return realWriteFileSync.call(fs, target, ...rest);
  };
  t.after(() => { fs.writeFileSync = realWriteFileSync; fs.openSync = realOpenSync; });
  return () => injected;
}

test('a failed first write leaves no event-bridge key, and the next start creates one', async t => {
  const root = await scratchRoot('partial-key');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { keyPath } = resolveEvolutionPaths({ dataRoot: root });
  const injected = failAfterCreate(t, keyPath);

  // The primary error is the write, not a derived "invalid key" complaint.
  assert.throws(() => storageConfig({ dataRoot: root }), /ENOSPC/);
  assert.equal(injected(), 1, 'the write failure was injected on the key file');
  assert.equal(fs.existsSync(keyPath), false, 'the half-created key was removed');
  assert.deepEqual(fs.readdirSync(path.dirname(keyPath)).filter((name) => name.startsWith('event-bridge')), [],
    'no partial key artifact survived');

  // The next start writes a real key and uses it. Before the cleanup this threw
  // "Evolution event bridge key is invalid; refusing to replace it" forever.
  const resolved = storageConfig({ dataRoot: root });
  assert.match(resolved.eventBridgeKey, KEY_PATH_RE);
  assert.equal(fs.readFileSync(keyPath, 'utf8'), resolved.eventBridgeKey);

  // `EEXIST` must stay untouched: an existing key is reused, never replaced.
  const again = storageConfig({ dataRoot: root });
  assert.equal(again.eventBridgeKey, resolved.eventBridgeKey);
});

test('a failure raised before the key exists never removes the key another writer created', async t => {
  const root = await scratchRoot('key-race');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { keyPath } = resolveEvolutionPaths({ dataRoot: root });
  // A second start writes the key first; this call's exclusive open then fails
  // for a reason that is not `EEXIST` (a descriptor limit is the realistic one),
  // so this call created nothing and may delete nothing.
  const foreign = 'a'.repeat(64);
  const realOpenSync = fs.openSync;
  let fired = false;
  fs.openSync = function patchedOpen(target, ...rest) {
    if (!fired && path.resolve(String(target)) === path.resolve(keyPath)) {
      // The other writer wins the race first, then this call's exclusive open
      // fails for a reason that is not `EEXIST`. `fired` is already set, so the
      // write below is not routed back into this patch.
      fired = true;
      fs.writeFileSync(keyPath, foreign, { flag: 'wx', mode: 0o600 });
      throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
    }
    return realOpenSync.call(fs, target, ...rest);
  };
  t.after(() => { fs.openSync = realOpenSync; });

  assert.throws(() => storageConfig({ dataRoot: root }), /EMFILE/);
  assert.equal(fs.readFileSync(keyPath, 'utf8'), foreign, 'the other writer\'s key was left byte-identical');
});

test('a close that fails after a complete write keeps the key, and the next start reuses it', async t => {
  const root = await scratchRoot('key-close');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { keyPath } = resolveEvolutionPaths({ dataRoot: root });
  const realOpenSync = fs.openSync;
  const realCloseSync = fs.closeSync;
  let keyFd = -1;
  let fired = 0;
  fs.openSync = function patchedOpen(target, ...rest) {
    const fd = realOpenSync.call(fs, target, ...rest);
    if (String(target) === keyPath) keyFd = fd;
    return fd;
  };
  fs.closeSync = function patchedClose(fd) {
    if (fd === keyFd && fired === 0) {
      fired += 1;
      keyFd = -1;
      realCloseSync.call(fs, fd);
      throw Object.assign(new Error('EIO: i/o error, close'), { code: 'EIO' });
    }
    return realCloseSync.call(fs, fd);
  };
  t.after(() => { fs.openSync = realOpenSync; fs.closeSync = realCloseSync; });

  assert.throws(() => storageConfig({ dataRoot: root }), /EIO/);
  assert.equal(fired, 1, 'the close failure was injected');
  // The bytes are complete, so the key is valid. Removing it would make a session
  // that had already read it continue on a key the next start no longer has.
  const written = fs.readFileSync(keyPath, 'utf8');
  assert.match(written, KEY_PATH_RE, 'the complete key survived the failed close');
  assert.equal(storageConfig({ dataRoot: root }).eventBridgeKey, written, 'the next start reused the same key');
});

test('a close that fails after a complete claim write keeps it, and the same trial adopts it', async t => {
  const root = await scratchRoot('claim-close');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = promotionPaths(root);
  const ctx = orchestratorContext();
  let installed = false;
  ctx.dynamicCordisRunner = {
    snapshot: () => (installed ? [{ pluginId: 'candidate', packages: [] }] : []),
    define: () => { installed = true; return { pluginId: 'candidate', packageId: 'package' }; },
    run: async () => ({ ok: true, status: 'active' }),
    stop: async () => ({ ok: true }),
    undefine: async () => { installed = false; return { ok: true }; },
  };
  const core = new EvolutionOrchestrator(ctx, { ...paths, startupDrift: false, eventBridge: { emit: () => ({}) } });
  const exec = execFor();
  const composition = { name: 'claim-close', purpose: 'close failure', code: { host: 'return {};' } };
  const claimFile = path.join(root, '.evolution-ownership',
    `${createHash('sha256').update('plugin:claim-close').digest('hex')}.json`);

  const realOpenSync = fs.openSync;
  const realCloseSync = fs.closeSync;
  let claimFd = -1;
  let fired = 0;
  fs.openSync = function patchedOpen(target, ...rest) {
    const fd = realOpenSync.call(fs, target, ...rest);
    if (String(target) === claimFile) claimFd = fd;
    return fd;
  };
  fs.closeSync = function patchedClose(fd) {
    if (fd === claimFd && fired === 0) {
      fired += 1;
      claimFd = -1;
      realCloseSync.call(fs, fd);
      throw Object.assign(new Error('EIO: i/o error, close'), { code: 'EIO' });
    }
    return realCloseSync.call(fs, fd);
  };
  t.after(() => { fs.openSync = realOpenSync; fs.closeSync = realCloseSync; });

  const first = core.propose({ why: 'claim', target: 'plugin:claim-close', impactScope: ['test'], successMetrics: ['claim'] }, exec);
  await assert.rejects(core.trial({ experimentId: first.experimentId, composition }, exec), /EIO/);
  assert.equal(fired, 1, 'the close failure was injected');
  const held = fs.readFileSync(claimFile, 'utf8');
  assert.equal(JSON.parse(held).experimentId, first.experimentId, 'the complete claim survived the failed close');

  // The retry of the same experiment adopts the claim it already wrote instead of
  // failing on its own entry, and the target is claimed exactly once.
  const started = await core.trial({ experimentId: first.experimentId, composition }, exec);
  assert.equal(started.ok, true);
  assert.equal(core.targetOwners.get('plugin:claim-close'), first.experimentId);
  assert.equal(fs.readFileSync(claimFile, 'utf8'), held, 'the adopted claim was left byte-identical');
});

test('a failed claim write releases the target, and the next trial can claim it', async t => {
  const root = await scratchRoot('partial-claim');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = promotionPaths(root);
  const ctx = orchestratorContext();
  let installed = false;
  ctx.dynamicCordisRunner = {
    snapshot: () => (installed ? [{ pluginId: 'candidate', packages: [] }] : []),
    define: () => { installed = true; return { pluginId: 'candidate', packageId: 'package' }; },
    run: async () => ({ ok: true, status: 'active' }),
    stop: async () => ({ ok: true }),
    undefine: async () => { installed = false; return { ok: true }; },
  };
  const core = new EvolutionOrchestrator(ctx, { ...paths, startupDrift: false, eventBridge: { emit: () => ({}) } });
  const exec = execFor();
  const composition = { name: 'partial-claim', purpose: 'claim write failure', code: { host: 'return {};' } };
  const ownershipDir = path.join(root, '.evolution-ownership');
  const claimFile = path.join(ownershipDir, `${createHash('sha256').update('plugin:claim').digest('hex')}.json`);

  const first = core.propose({ why: 'claim', target: 'plugin:claim', impactScope: ['test'], successMetrics: ['claim'] }, exec);
  const injected = failAfterCreate(t, claimFile);
  await assert.rejects(core.trial({ experimentId: first.experimentId, composition }, exec), /ENOSPC/);
  assert.equal(injected(), 1, 'the write failure was injected on the claim file');
  assert.equal(fs.existsSync(claimFile), false, 'the half-written claim was removed');
  assert.equal(await exists(ownershipDir) ? fs.readdirSync(ownershipDir).length : 0, 0, 'the ownership directory holds no stale claim');
  assert.equal(core.targetOwners.get('plugin:claim'), undefined, 'the in-memory target lock was never taken');

  // Without the cleanup this is the permanent failure the claim file caused:
  // "experiment ownership is unreadable for plugin:claim".
  const second = core.propose({ why: 'claim', target: 'plugin:claim', impactScope: ['test'], successMetrics: ['claim'] }, exec);
  const started = await core.trial({ experimentId: second.experimentId, composition }, exec);
  assert.equal(started.ok, true);
  assert.equal(core.targetOwners.get('plugin:claim'), second.experimentId);

  // A claim an owner really holds is never removed by another experiment's
  // failed attempt: the cleanup only ever deletes the entry its own `wx` made.
  const held = fs.readFileSync(claimFile, 'utf8');
  assert.equal(JSON.parse(held).experimentId, second.experimentId);
  const third = core.propose({ why: 'claim', target: 'plugin:claim', impactScope: ['test'], successMetrics: ['claim'] }, exec);
  await assert.rejects(core.trial({ experimentId: third.experimentId, composition }, exec),
    /unsafe parallel experiment conflicts on plugin:claim/);
  assert.equal(fs.readFileSync(claimFile, 'utf8'), held, 'the holder claim was left byte-identical');
});

test('a failed lock write leaves no lock file, and the next open takes the archive', async t => {
  const root = await scratchRoot('partial-lock');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = {
    emit() {}, on() {}, logger: { warn() {}, error() {} },
    storage: { backend: { get: () => backend } }, effect() {},
  };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const config = { presetDir: root, eventBridgePath: path.join(root, 'events.jsonl'), eventBridgeKey: 'b'.repeat(64) };
  const lockPath = path.join(root, 'domain-archive.lock');
  const injected = failAfterCreate(t, lockPath);

  await assert.rejects(openDomainStorage(ctx, config), /ENOSPC/);
  assert.equal(injected(), 1, 'the write failure was injected on the lock file');
  assert.equal(fs.existsSync(lockPath), false, 'the half-written lock was removed');

  // The next open takes the archive immediately. Before the cleanup it first
  // paid the one-second settle window to reclaim the empty lock.
  let port = null;
  try {
    port = await openDomainStorage(ctx, config);
    await port.observe({ code: 'SAFE_ERROR', target: 'tool:sample', message: 'lock recovery' });
    assert.equal(port.query('observations').count, 1);
  } finally {
    if (port) await port.close();
    await backend.close();
  }
});

test('a failed lock acquisition never removes the lock another port took meanwhile', async t => {
  const root = await scratchRoot('lock-fence');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = {
    emit() {}, on() {}, logger: { warn() {}, error() {} },
    storage: { backend: { get: () => backend } }, effect() {},
  };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const config = { presetDir: root, eventBridgePath: path.join(root, 'events.jsonl'), eventBridgeKey: 'b'.repeat(64) };
  const lockPath = path.join(root, 'domain-archive.lock');
  const otherPid = String(process.pid + 1);

  // The stalled-then-failed shape: this call's exclusive open created an empty
  // lock, another port reclaimed it after the settle window and wrote its own pid,
  // and only then did this call's write fail. The cleanup must leave that lock.
  const realOpenSync = fs.openSync;
  const realWriteFileSync = fs.writeFileSync;
  const realUnlinkSync = fs.unlinkSync;
  let lockFd = -1;
  let fired = 0;
  fs.openSync = function patchedOpen(target, ...rest) {
    const fd = realOpenSync.call(fs, target, ...rest);
    if (String(target) === lockPath) lockFd = fd;
    return fd;
  };
  fs.writeFileSync = function patchedWrite(target, ...rest) {
    if (typeof target === 'number' && target === lockFd && fired === 0) {
      fired += 1;
      lockFd = -1;
      realUnlinkSync.call(fs, lockPath);
      realWriteFileSync.call(fs, lockPath, otherPid, { flag: 'wx', mode: 0o600 });
      throw enospc();
    }
    return realWriteFileSync.call(fs, target, ...rest);
  };
  t.after(() => { fs.openSync = realOpenSync; fs.writeFileSync = realWriteFileSync; });

  await assert.rejects(openDomainStorage(ctx, config), /ENOSPC/);
  assert.equal(fired, 1, 'the write failure was injected after another port took the lock');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), otherPid, 'the other port\'s lock survived the failed acquisition');
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith('domain-archive.lock.')), [],
    'the fenced removal left no isolated copy behind');
  await backend.close();
});

test('a port that stalled across a reclaim cannot prove ownership of the lock it lost', async t => {
  const root = await scratchRoot('lock-stall');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = {
    emit() {}, on() {}, logger: { warn() {}, error() {} },
    storage: { backend: { get: () => backend } }, effect() {},
  };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const config = { presetDir: root, eventBridgePath: path.join(root, 'events.jsonl'), eventBridgeKey: 'b'.repeat(64) };
  const lockPath = path.join(root, 'domain-archive.lock');
  const pid = String(process.pid);

  // The interleaving: this call's exclusive open created an empty lock, it was
  // preempted for longer than the settle window, another port reclaimed the entry
  // (rename then unlink, exactly what `removeLockIfUnchanged` does) and wrote a
  // lock of its own with the same pid bytes - both ports belong to this process.
  // This call's descriptor still points at the detached inode, so its write
  // lands there and no path reaches it.
  const realOpenSync = fs.openSync;
  const realWriteFileSync = fs.writeFileSync;
  const realRenameSync = fs.renameSync;
  const realUnlinkSync = fs.unlinkSync;
  let lockFd = -1;
  let fired = 0;
  fs.openSync = function patchedOpen(target, ...rest) {
    const fd = realOpenSync.call(fs, target, ...rest);
    if (String(target) === lockPath) lockFd = fd;
    return fd;
  };
  fs.writeFileSync = function patchedWrite(target, ...rest) {
    if (typeof target === 'number' && target === lockFd && fired === 0) {
      fired += 1;
      lockFd = -1;
      const reclaimed = `${lockPath}.reclaimed`;
      realRenameSync.call(fs, lockPath, reclaimed);
      realUnlinkSync.call(fs, reclaimed);
      realWriteFileSync.call(fs, lockPath, pid, { flag: 'wx', mode: 0o600 });
    }
    return realWriteFileSync.call(fs, target, ...rest);
  };
  t.after(() => { fs.openSync = realOpenSync; fs.writeFileSync = realWriteFileSync; });

  let port = null;
  try {
    port = await openDomainStorage(ctx, config);
    assert.equal(fired, 1, 'the stalled open was injected');
    // The pid bytes are identical, so only the inode distinguishes the two
    // owners. The token must not name the one the path holds now.
    assert.equal(fs.readFileSync(lockPath, 'utf8'), pid, 'the reclaiming port holds the lock path');

    // Its first durable write must refuse: it cannot prove it still owns the lock.
    await assert.rejects(port.observe({ code: 'SAFE_ERROR', target: 'tool:stall', message: 'lost lock' }),
      /E_DOMAIN_ARCHIVE_LOCK/);
    assert.equal(port.query('observations').count, 0, 'the refused transaction committed nothing');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), pid, 'the reclaiming port still holds the lock path');
  } finally {
    // The port records the refused write as its failure, so closing reports it;
    // what matters here is that the other port's lock survives the release.
    if (port) await port.close().catch(() => {});
    assert.equal(fs.readFileSync(lockPath, 'utf8'), pid, 'the release left the other port\'s lock byte-identical');
    await backend.close();
  }
});

test('a failed lock acquisition removes its own lock even when the write completed', async t => {
  const root = await scratchRoot('lock-close');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = {
    emit() {}, on() {}, logger: { warn() {}, error() {} },
    storage: { backend: { get: () => backend } }, effect() {},
  };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const config = { presetDir: root, eventBridgePath: path.join(root, 'events.jsonl'), eventBridgeKey: 'b'.repeat(64) };
  const lockPath = path.join(root, 'domain-archive.lock');

  // The write reached the entry and only the close failed. This attempt returned
  // no token, so no port holds this lock: keeping it would name this process as a
  // live owner and refuse every later `openDomainStorage` here - a transient
  // `EIO` would make the archive unusable until the process exits. That is the
  // one place where a completed write is not kept, and it is decided by
  // ownership, not by whether the bytes arrived.
  const realOpenSync = fs.openSync;
  const realCloseSync = fs.closeSync;
  let lockFd = -1;
  let fired = 0;
  let contentAtClose = null;
  fs.openSync = function patchedOpen(target, ...rest) {
    const fd = realOpenSync.call(fs, target, ...rest);
    if (String(target) === lockPath) lockFd = fd;
    return fd;
  };
  fs.closeSync = function patchedClose(fd) {
    if (fd === lockFd && fired === 0) {
      fired += 1;
      lockFd = -1;
      realCloseSync.call(fs, fd);
      // The bytes are complete at this point; the cleanup below is what decides
      // whether they survive.
      contentAtClose = fs.readFileSync(lockPath, 'utf8');
      throw Object.assign(new Error('EIO: i/o error, close'), { code: 'EIO' });
    }
    return realCloseSync.call(fs, fd);
  };
  t.after(() => { fs.openSync = realOpenSync; fs.closeSync = realCloseSync; });

  await assert.rejects(openDomainStorage(ctx, config), /EIO/);
  assert.equal(fired, 1, 'the close failure was injected after a complete write');
  assert.equal(contentAtClose, String(process.pid), 'the pid did reach the entry before the close failed');
  assert.equal(fs.existsSync(lockPath), false, 'the lock of a failed acquisition was removed');

  // The retry acquires the archive instead of meeting its own pid as a live owner.
  let port = null;
  try {
    port = await openDomainStorage(ctx, config);
    await port.observe({ code: 'SAFE_ERROR', target: 'tool:sample', message: 'close recovery' });
    assert.equal(port.query('observations').count, 1);
  } finally {
    if (port) await port.close();
    await backend.close();
  }
});
