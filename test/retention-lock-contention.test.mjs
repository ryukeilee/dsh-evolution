/**
 * What a committed retention floor needs from the append lock.
 *
 * `completeEventLogTruncation()` used to take the append lock first and classify
 * afterwards, so *every* pass over a root that had ever reclaimed waited for the
 * append lock - 500 ms, and then a retryable `E_DOMAIN_EVENT_LOG_BUSY` - even
 * when the committed truncation had already run. Two consequences were reachable
 * without any corruption: a fresh runtime could not open (`replay()` refuses the
 * pass), and an owner's `reclaim()` could not run, while an unrelated writer was
 * appending a record. The floor's own state was consistent the whole time.
 *
 * The classification is now decided before the lock is taken, because "nothing
 * to finish" needs no exclusion: only a truncation replaces the head of the log,
 * and it publishes that head with one rename. The deferred branch still runs
 * entirely under the lock, and still re-classifies there.
 *
 * The same lock is also the only *retryable* failure of a committed truncation.
 * It used to wrap every failure of that call, so a rewrite that cannot run for
 * its own reason (here: a directory that refuses a new file) was reported as a
 * lock race that a restart would clear, while every later pass failed the same
 * way.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDomainStorage } from '../lib/domain-storage.js';
import { completeEventLogTruncation, digestLogBytes } from '../lib/event-log-checkpoint.js';
import { EVENT_BRIDGE_APPEND_LOCK_BUSY, EvolutionEventBridge, EVENT_BRIDGE_DEFAULT_WRITER,
  externalizeEventBridgeEvidence, withEventBridgeAppendLock } from '../lib/orchestrator.js';
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

const KEY = 'c'.repeat(64);
const WRITER = EVENT_BRIDGE_DEFAULT_WRITER;
const AT = '2026-10-27T00:00:00.000Z';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-lock-'));
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const listeners = new Map();
  const ctx = {
    emit(name, ...args) { for (const listener of listeners.get(name) ?? []) listener(...args); },
    on(name, listener) {
      const registered = listeners.get(name) ?? [];
      registered.push(listener);
      listeners.set(name, registered);
      return () => { const index = registered.indexOf(listener); if (index >= 0) registered.splice(index, 1); };
    },
    logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {},
  };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const config = {
    presetDir: root,
    archiveDir: path.join(root, 'archive'),
    eventBridgePath: path.join(root, 'execution-events.jsonl'),
    eventBridgeKey: KEY,
    eventBridgeWriter: WRITER,
  };
  t.after(async () => {
    fs.chmodSync(root, 0o700);
    await backend.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, ctx, config, backend };
}

const openPort = f => openDomainStorage(f.ctx, { ...f.config,
  externalizeEventEvidence: entries => externalizeEventBridgeEvidence({ archiveDir: f.config.archiveDir }, entries) });
const ledger = f => f.ctx.storageDomain.get('evolution_domain').global.get();
const logBytes = file => fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
const lockPathFor = file => `${file}.append.lock`;

/** A same-host owner that is this live process, so no reclaim may take it. */
function holdLock(file) {
  const lockPath = lockPathFor(file);
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, 'owner'), JSON.stringify({ token: 'held', pid: process.pid, hostname: os.hostname(), acquiredAt: Date.now() }));
  return () => fs.rmSync(lockPath, { recursive: true, force: true });
}

function writeMeasurements(config, count) {
  const bridge = new EvolutionEventBridge({ file: config.eventBridgePath, key: KEY });
  for (let index = 0; index < count; index += 1) {
    const id = `exp-${String(index).padStart(4, '0')}`;
    bridge.emit('measurement-completed', {}, {
      schema: 1, eventId: `evolution:measurement-completed:${id}`, eventType: 'measurement-completed',
      experimentId: id, proposalId: id, target: 'fixture-target', capability: 'fixture-target',
      lineageId: 'fixture-target', status: 'measured', measurement: { latencyMs: 10 + index },
      promotion: null, canary: null, evidence: {}, audit: { producer: WRITER, at: AT },
    });
  }
}

test('a completed floor needs no append lock: reclaim and reopen survive a live writer', async (t) => {
  const f = await fixture(t);
  let port = await openPort(f);
  let release = () => {};
  try {
    writeMeasurements(f.config, 6);
    assert.deepEqual(await port.flush(), { applied: 6, duplicates: 0 });
    const first = await port.reclaim({ confirmation: true, archives: false, retainRecords: 2 });
    assert.equal(first.log.status, 'discarded');
    assert.equal(first.log.truncated, 'truncated');
    const floor = structuredClone(ledger(f).retention);
    const kept = logBytes(f.config.eventBridgePath);

    // The committed truncation already ran, so nothing about this floor needs the
    // append lock - and an unrelated live writer must not turn a no-op reclaim or
    // a start-up replay into `E_DOMAIN_EVENT_LOG_BUSY`.
    release = holdLock(f.config.eventBridgePath);
    const second = await port.reclaim({ confirmation: true, archives: false, retainRecords: 2 });
    assert.equal(second.log.status, 'nothing-absorbed');
    assert.deepEqual(ledger(f).retention, floor);
    assert.deepEqual(logBytes(f.config.eventBridgePath), kept);

    await port.close();
    port = await openPort(f);
    assert.equal(port !== null, true);
    assert.deepEqual(ledger(f).retention, floor);
    assert.deepEqual(logBytes(f.config.eventBridgePath), kept);
    // The retained records are still the absorbed ones, so the pass after the
    // reopen does no per-record work.
    assert.deepEqual(await port.flush(), { applied: 0, duplicates: 2 });
  } finally {
    release();
    await port.close().catch(() => {});
  }
});

test('a deferred floor still refuses a second reclaim, and only as the lock outcome', async (t) => {
  const f = await fixture(t);
  const port = await openPort(f);
  let release = () => {};
  try {
    writeMeasurements(f.config, 8);
    assert.deepEqual(await port.flush(), { applied: 8, duplicates: 0 });
    // Blank historical bytes are valid, but they must not let a second plan
    // replace a floor whose truncation has not run.
    fs.writeFileSync(f.config.eventBridgePath, Buffer.concat([Buffer.from('\n'), logBytes(f.config.eventBridgePath)]));
    release = holdLock(f.config.eventBridgePath);
    const deferred = await port.reclaim({ confirmation: true, archives: false, retainRecords: 2 });
    assert.equal(deferred.log.truncated, 'deferred');
    const floor = structuredClone(ledger(f).retention);
    const prior = logBytes(f.config.eventBridgePath);
    await assert.rejects(port.reclaim({ confirmation: true, archives: false, retainRecords: 2 }), (error) => {
      assert.equal(error.code, 'E_DOMAIN_EVENT_LOG_BUSY');
      assert.equal(error.cause?.code, EVENT_BRIDGE_APPEND_LOCK_BUSY);
      return true;
    });
    assert.deepEqual(ledger(f).retention, floor);
    assert.deepEqual(logBytes(f.config.eventBridgePath), prior);
    release();
    release = () => {};
    const completed = await port.reclaim({ confirmation: true, archives: false, retainRecords: 2 });
    assert.equal(completed.log.status, 'nothing-absorbed');
    assert.deepEqual(ledger(f).retention, floor);
    assert.equal(logBytes(f.config.eventBridgePath).length, floor.log.tail.bytes);
  } finally {
    release();
    await port.close().catch(() => {});
  }
});

test('a truncation that fails on its own keeps its own code instead of a retry hint', async (t) => {
  const f = await fixture(t);
  const port = await openPort(f);
  let release = () => {};
  try {
    writeMeasurements(f.config, 8);
    assert.deepEqual(await port.flush(), { applied: 8, duplicates: 0 });
    fs.writeFileSync(f.config.eventBridgePath, Buffer.concat([Buffer.from('\n'), logBytes(f.config.eventBridgePath)]));
    release = holdLock(f.config.eventBridgePath);
    const deferred = await port.reclaim({ confirmation: true, archives: false, retainRecords: 2 });
    assert.equal(deferred.log.truncated, 'deferred');
    release();
    release = () => {};
    const floor = structuredClone(ledger(f).retention);
    const prior = logBytes(f.config.eventBridgePath);

    // The lock is free, so completion is attempted and the append-lock helper
    // fails for its own reason: it cannot create the lock directory here. That is
    // not contention, and reporting it as `E_DOMAIN_EVENT_LOG_BUSY` would invite an
    // operator to retry a pass that can only fail the same way.
    fs.chmodSync(f.root, 0o500);
    await assert.rejects(port.flush(), (error) => {
      assert.equal(error.code, 'EACCES');
      return true;
    });
    fs.chmodSync(f.root, 0o700);
    // The failed pass changed nothing, and the next pass still completes it.
    assert.deepEqual(ledger(f).retention, floor);
    assert.deepEqual(logBytes(f.config.eventBridgePath), prior);
    assert.deepEqual(await port.flush(), { applied: 0, duplicates: 2 });
    assert.equal(logBytes(f.config.eventBridgePath).length, floor.log.tail.bytes);
  } finally {
    fs.chmodSync(f.root, 0o700);
    release();
    await port.close().catch(() => {});
  }
});

test('a rewrite that refuses its own bound keeps a named error, not a retry hint', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-bounded-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'execution-events.jsonl');
  const prior = Buffer.from('AB');
  const tail = Buffer.from('B');
  const floor = { schema: 1, markers: { pruned: 1, chain: crypto.createHash('sha256').update('chain').digest('hex') },
    log: { bytes: 1, records: 1,
      prior: { bytes: prior.length, digest: digestLogBytes(KEY, prior) },
      tail: { bytes: tail.length, digest: digestLogBytes(KEY, tail) } } };
  // The log is the prior file plus bytes appended after the commit. Its head is
  // `A`, not the claimed tail `B`, so the deferred branch runs, and the region it
  // would keep is above the ceiling this call is given.
  fs.writeFileSync(file, Buffer.concat([prior, Buffer.from(' CDEF')]));
  const completion = () => completeEventLogTruncation({ file, key: KEY, floor, withAppendLock: withEventBridgeAppendLock, retainCeiling: 4 });
  assert.throws(completion, (error) => {
    assert.equal(error.code, 'E_DOMAIN_EVENT_LOG_RETAIN_UNBOUNDED');
    return true;
  });
  // Nothing was written: the bound refuses the rewrite before its temporary exists.
  assert.equal(fs.readFileSync(file, 'utf8'), 'AB CDEF');
});

test('a missing log is proved without touching the only copy of its retained bytes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-missing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'execution-events.jsonl');
  const prior = Buffer.from('AB');
  const tail = Buffer.from('B');
  const floor = { schema: 1, markers: { pruned: 1, chain: crypto.createHash('sha256').update('chain').digest('hex') },
    log: { bytes: 1, records: 1,
      prior: { bytes: prior.length, digest: digestLogBytes(KEY, prior) },
      tail: { bytes: tail.length, digest: digestLogBytes(KEY, tail) } } };
  // A crashed rewrite leaves its own temporary beside the log. With the log gone,
  // that temporary can be the only copy of the retained bytes, so proving
  // `absent` must not delete it.
  const temporary = `${file}.0123456789abcdef.reclaim.tmp`;
  fs.writeFileSync(temporary, tail);
  const completion = completeEventLogTruncation({ file, key: KEY, floor, withAppendLock: withEventBridgeAppendLock });
  assert.equal(completion.status, 'absent');
  assert.equal(fs.readFileSync(temporary, 'utf8'), 'B');
  assert.equal(fs.existsSync(lockPathFor(file)), false, 'proving it needs no lock either');
});
