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
  const warnings = [];
  const ctx = { emit() {}, logger: { warn: line => warnings.push(String(line)), error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  const facility = new DomainFacility(ctx, { backend: 'json' });
  const closes = [];
  const domains = [];
  const open = facility.open.bind(facility);
  // Count the close calls the port makes on the medium it opened, so a failed
  // initialization can be held to closing what it opened, and keep the handles
  // themselves so a test can make the medium's own close reject.
  facility.open = async spec => {
    const domain = await open(spec);
    domains.push(domain);
    const close = domain.close.bind(domain);
    domain.close = async (...args) => { closes.push(Date.now()); return close(...args); };
    return domain;
  };
  ctx.storageDomain = facility;
  const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'), eventBridgeKey: 'b'.repeat(64) };
  return { root, ctx, config, backend, closes, domains, warnings, facility, lock: path.join(root, LOCK_NAME) };
}

async function teardown(f) { await f.backend.close(); fs.rmSync(f.root, { recursive: true, force: true }); }

/** Replace the close of every domain this fixture opens with a rejection, the way
 *  a medium whose drain or release fails behaves. The attempt is still counted,
 *  because it is still an attempt to close what the port opened. */
function failClose(f, message = 'INJECTED_CLOSE_FAILURE') {
  const open = f.ctx.storageDomain.open.bind(f.ctx.storageDomain);
  f.ctx.storageDomain.open = async spec => {
    const domain = await open(spec);
    domain.close = async () => { f.closes.push(Date.now()); throw new Error(message); };
    return domain;
  };
}

/** Make the archive-lock release throw, the way an `fs` call it makes can. The
 *  returned function undoes the patch. */
function throwOnRelease(f) {
  const originalUnlink = fs.unlinkSync;
  fs.unlinkSync = function patched(target, ...args) {
    const name = String(target);
    if (name.startsWith(`${f.lock}.`) && name.endsWith('.released')) {
      const error = new Error('INJECTED_RELEASE_FAILURE');
      error.code = 'EACCES';
      throw error;
    }
    return originalUnlink.call(fs, target, ...args);
  };
  return () => { fs.unlinkSync = originalUnlink; };
}

/** A logger whose `warn` fails the way `mode` says, once a diagnostic has to be
 *  written. Both shapes are legal for `ctx.logger.warn`. */
function hostileLogger(f, mode) {
  f.ctx.logger.warn = mode === 'throw'
    ? () => { throw new Error('LOGGER_SENTINEL'); }
    : () => Promise.reject(new Error('LOGGER_SENTINEL'));
}

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

// The first and third cases below were first reproduced against the unfixed
// implementation: `await domain?.close()` ran before the release and inside the
// same `catch`, so a close that rejected replaced the initialization error with
// its own and skipped the release, and the retained lock then refused the retry
// in the same process (`E_DOMAIN_ARCHIVE_LOCK`). The lock is kept on purpose when
// the medium does not confirm its close - a rejected `Domain.close()` is the
// medium saying it did not release the unit, so this port cannot prove it stopped
// writing the pending record that recovery of this archive reads. It costs no
// recovery path: the facility still holds the name the failed close never freed.
// The teardown case pins semantics the unfixed implementation already had, so it
// is a regression guard rather than a reproduction.

test('P2-4: a close that rejects during a failed initialization keeps the lock and never masks the error', async () => {
  const f = await fixture();
  try {
    // A regular file where the archive root belongs: `mkdirSync` refuses.
    fs.writeFileSync(path.join(f.root, 'dockyard'), 'not a directory');
    // The close failure carries a credential shape, so the log line can be held
    // to the redacted DTO instead of the raw message.
    failClose(f, 'INJECTED_CLOSE_FAILURE Bearer abcdefghijklmnop123456');
    await assert.rejects(openDomainStorage(f.ctx, f.config),
      error => error.code === 'EEXIST' || error.code === 'ENOTDIR',
      'the initialization error is what the caller sees, not the close failure');
    assert.equal(f.closes.length, 1, 'the medium this attempt opened is closed once');
    assert.equal(fs.readFileSync(f.lock, 'utf8'), String(process.pid),
      'a medium that did not confirm its close keeps the lock this attempt wrote');
    const kept = f.warnings.filter(line => line.includes('kept the archive lock'));
    assert.equal(kept.length, 1, 'the retained lock is reported once');
    assert.doesNotMatch(kept[0], /abcdefghijklmnop123456/, 'the log line carries the safe DTO, never the raw message');
    assert.match(kept[0], /Bearer \[redacted\]/);
    assert.match(kept[0], /sha256:[0-9a-f]{16}/);
    assert.notEqual(f.facility.get('evolution_domain'), undefined,
      'the failed close never freed the domain name, so the retry below is refused there too');
    fs.rmSync(path.join(f.root, 'dockyard'));
    await assert.rejects(openDomainStorage(f.ctx, f.config), /E_DOMAIN_ARCHIVE_LOCK/,
      'the retained lock refuses a second port while this process cannot prove it stopped writing');
  } finally { await teardown(f); }
});

test('P2-4: a close that rejects during teardown keeps the archive lock', async () => {
  const f = await fixture();
  try {
    const port = await openDomainStorage(f.ctx, f.config);
    assert.equal(fs.readFileSync(f.lock, 'utf8'), String(process.pid));
    f.domains.at(-1).close = async () => { throw new Error('INJECTED_CLOSE_FAILURE'); };
    await assert.rejects(port.close(), /INJECTED_CLOSE_FAILURE/, 'the teardown reports the close failure it hit');
    assert.equal(fs.readFileSync(f.lock, 'utf8'), String(process.pid),
      'a teardown close that fails keeps the lock: the medium is unproven');
    assert.deepEqual(fs.readdirSync(f.root).filter(name => name.startsWith(LOCK_NAME)), [LOCK_NAME],
      'a release that never ran leaves no temporary copy');
    await assert.rejects(openDomainStorage(f.ctx, f.config), /E_DOMAIN_ARCHIVE_LOCK/,
      'the kept lock is enforced for the rest of this process');
  } finally { await teardown(f); }
});

test('P2-4: a release that throws during a failed initialization never masks the error either', async () => {
  const f = await fixture();
  const originalUnlink = fs.unlinkSync;
  let injected = false;
  fs.unlinkSync = function patched(target, ...args) {
    const name = String(target);
    if (!injected && name.startsWith(`${f.lock}.`) && name.endsWith('.released')) {
      injected = true;
      const error = new Error('INJECTED_RELEASE_FAILURE');
      error.code = 'EACCES';
      throw error;
    }
    return originalUnlink.call(fs, target, ...args);
  };
  try {
    fs.writeFileSync(path.join(f.root, 'dockyard'), 'not a directory');
    await assert.rejects(openDomainStorage(f.ctx, f.config),
      error => error.code === 'EEXIST' || error.code === 'ENOTDIR',
      'a cleanup step that throws is reported, never thrown instead of the initialization error');
  } finally { fs.unlinkSync = originalUnlink; }
  try {
    assert.equal(injected, true, 'the release must actually have thrown');
    assert.equal(f.warnings.filter(line => line.includes('could not release the archive lock')).length, 1);
    // The throw happens after the entry was isolated under its private name, so
    // the protocol's own record of that entry survives instead of being deleted.
    assert.deepEqual(fs.readdirSync(f.root).filter(name => name.startsWith(LOCK_NAME)).map(name => name.endsWith('.released')), [true]);
  } finally { await teardown(f); }
});

/**
 * Run one failed initialization whose cleanup step fails (`branch`: the medium's
 * `close` rejects, or the archive-lock release throws) and whose logger fails the
 * way `mode` says, and report what the caller observed. Both cleanup branches
 * write the diagnostic through the same entry point, so both are exercised.
 */
async function cleanupFailureWithHostileLogger(mode, branch) {
  const f = await fixture();
  const restore = [];
  try {
    // A regular file where the archive root belongs: `mkdirSync` refuses.
    fs.writeFileSync(path.join(f.root, 'dockyard'), 'not a directory');
    if (branch === 'close') failClose(f);
    else restore.push(throwOnRelease(f));
    hostileLogger(f, mode);
    let thrown;
    try { await openDomainStorage(f.ctx, f.config); } catch (error) { thrown = error; }
    return { thrown };
  } finally {
    for (const undo of restore) undo();
    await teardown(f);
  }
}

/** The initialization error, never the injected sentinel or a logger failure. */
const primaryError = error => error?.code === 'EEXIST' || error?.code === 'ENOTDIR';

// A logger is host code the port does not own: `ctx.logger.warn` may throw
// synchronously or return a rejected promise. Either shape used to be able to
// replace the initialization error - the `warn` call sat inside the same `catch`
// as the release - so the cleanup diagnostic is written through the shared
// redacted-warning entry point, which contains both shapes.

test('P2-4: a logger that throws cannot replace the initialization error', async () => {
  for (const branch of ['close', 'release']) {
    const observed = await cleanupFailureWithHostileLogger('throw', branch);
    assert.equal(primaryError(observed.thrown), true,
      `the initialization error survives a throwing logger on the ${branch} branch, got: ${observed.thrown?.message}`);
    assert.doesNotMatch(String(observed.thrown?.message), /LOGGER_SENTINEL/);
  }
});

test('P2-4: a logger that returns a rejected promise cannot replace the initialization error or leak a rejection', async () => {
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(String(reason?.message ?? reason));
  process.on('unhandledRejection', onUnhandled);
  try {
    for (const branch of ['close', 'release']) {
      const observed = await cleanupFailureWithHostileLogger('reject', branch);
      assert.equal(primaryError(observed.thrown), true,
        `the initialization error survives a rejecting logger on the ${branch} branch, got: ${observed.thrown?.message}`);
      assert.doesNotMatch(String(observed.thrown?.message), /LOGGER_SENTINEL/);
    }
    // The containment is what settles the rejection; without it the log write is
    // an unhandled rejection the host would crash on.
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, [], 'a rejected log write is contained, not left unhandled');
  } finally { process.off('unhandledRejection', onUnhandled); }
});

test('P2-7a: a reclaim never deletes a lock another process acquired in between', async () => {  const f = await fixture();
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
