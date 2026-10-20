// P2-7b: stale-lock recovery is check-then-act. Removing the lock must be
// tied to the exact stale directory that was judged stale, so a lock another
// process created in the meantime is never deleted.
// P3-19: a short append write must be completed before the event id is marked
// as seen, otherwise the log keeps half a record and the event is never retried.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EvolutionEventBridge, recoverStalePromotionLock } from '../lib/orchestrator.js';
import { scratchRoot, exists } from './orchestrator-durability-fixtures.mjs';

async function seedLock(lockPath, metadata) {
  await fsp.mkdir(lockPath, { recursive: true });
  await fsp.writeFile(path.join(lockPath, 'lock.json'), `${JSON.stringify(metadata)}\n`);
}

test('P2-7b a lock replaced while the stale judgement is pending survives the recovery', async t => {
  const root = await scratchRoot('lock-race');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'promotion.lock');
  await seedLock(lockPath, {
    token: 'stale-token', pid: 999999, hostname: os.hostname(), createdAt: '2020-01-01T00:00:00.000Z',
  });

  const originalReadFile = fsp.readFile;
  let injected = false;
  fsp.readFile = async function injectedReadFile(file, ...rest) {
    const result = await originalReadFile.call(this, file, ...rest);
    if (!injected && String(file).endsWith(path.join('promotion.lock', 'lock.json'))) {
      injected = true;
      // The other process wins the race after this process judged the lock
      // stale: it removes the stale directory and owns a fresh, live lock.
      await fsp.rm(lockPath, { recursive: true, force: true });
      await seedLock(lockPath, {
        token: 'live-token', pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString(),
      });
    }
    return result;
  };
  let result;
  try {
    result = await recoverStalePromotionLock({ lockPath, ttlMs: 15 * 60 * 1000 });
  } finally {
    fsp.readFile = originalReadFile;
  }

  assert.equal(injected, true, 'the race window was exercised');
  assert.equal(result.recovered, false, `recovery must not report the replaced lock as recovered: ${JSON.stringify(result)}`);
  assert.equal(await exists(lockPath), true, 'the live lock directory was preserved');
  const survivors = await fsp.readdir(lockPath);
  assert.deepEqual(survivors.filter(name => name.endsWith('.json')), ['lock.json']);
  assert.equal(JSON.parse(await fsp.readFile(path.join(lockPath, 'lock.json'), 'utf8')).token, 'live-token');
  // No quarantine directory may be left behind when the identity matched nothing.
  const leftovers = (await fsp.readdir(root)).filter(name => name !== 'promotion.lock');
  assert.deepEqual(leftovers, [], `no orphan quarantine directories: ${JSON.stringify(leftovers)}`);
});

test('P2-7b a lock whose owner is provably gone is still recovered', async t => {
  const root = await scratchRoot('lock-stale');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'promotion.lock');
  await seedLock(lockPath, {
    token: 'stale-token', pid: 999999, hostname: os.hostname(), createdAt: '2020-01-01T00:00:00.000Z',
  });
  const result = await recoverStalePromotionLock({ lockPath, ttlMs: 15 * 60 * 1000 });
  assert.equal(result.recovered, true);
  assert.equal(result.status, 'stale-recovered');
  assert.equal(await exists(lockPath), false);
  assert.deepEqual(await fsp.readdir(root), []);
});

test('P3-19 a short append write is completed before the event is marked as seen', async t => {
  const root = await scratchRoot('event-short-write');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'evolution-events.jsonl');
  const bridge = new EvolutionEventBridge({ file, key: 'e'.repeat(64), writer: 'durability-writer' });
  const record = { id: 'exp-short', state: 'proposed', proposal: { target: 'plugin:durability' } };

  const originalWriteSync = fs.writeSync;
  let partialWrites = 0;
  fs.writeSync = function observedWriteSync(descriptor, data, ...rest) {
    if (partialWrites >= 6) return originalWriteSync.call(this, descriptor, data, ...rest);
    if (typeof data === 'string' && rest.length === 0) {
      partialWrites += 1;
      const piece = data.slice(0, 7);
      originalWriteSync.call(this, descriptor, piece);
      return Buffer.byteLength(piece);
    }
    if (Buffer.isBuffer(data) && rest.length >= 2) {
      partialWrites += 1;
      const [offset, length] = rest;
      return originalWriteSync.call(this, descriptor, data, offset, Math.min(length, 7));
    }
    return originalWriteSync.call(this, descriptor, data, ...rest);
  };
  let first;
  try {
    first = bridge.emit('proposal-created', record, {});
  } finally {
    fs.writeSync = originalWriteSync;
  }

  assert.ok(partialWrites >= 2, `the short writes were exercised: ${partialWrites}`);
  const content = await fsp.readFile(file, 'utf8');
  assert.equal(content.endsWith('\n'), true, 'the record ends with a newline');
  assert.equal(content.split('\n').filter(Boolean).length, 1, 'exactly one complete record');
  const envelope = JSON.parse(content.trim());
  assert.equal(envelope.event.eventId, first.eventId);
  assert.equal(envelope.mac.length, 64);

  // The same event id must not be appended twice now that it is durable.
  const before = await fsp.readFile(file, 'utf8');
  bridge.emit('proposal-created', record, {});
  assert.equal(await fsp.readFile(file, 'utf8'), before, 'a completed record is not re-appended');
});

test('P3-19 a write that makes no progress raises instead of marking the event seen', async t => {
  const root = await scratchRoot('event-zero-write');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'evolution-events.jsonl');
  const bridge = new EvolutionEventBridge({ file, key: 'f'.repeat(64), writer: 'durability-writer' });
  const record = { id: 'exp-zero', state: 'proposed', proposal: { target: 'plugin:durability' } };

  const originalWriteSync = fs.writeSync;
  fs.writeSync = function observedWriteSync(descriptor, data, ...rest) {
    if (typeof data === 'string' && rest.length === 0) return 0;
    if (Buffer.isBuffer(data) && rest.length >= 2) return 0;
    return originalWriteSync.call(this, descriptor, data, ...rest);
  };
  try {
    assert.throws(() => bridge.emit('proposal-created', record, {}), /event bridge/i);
  } finally {
    fs.writeSync = originalWriteSync;
  }
  // Nothing was seen, so the same event is attempted (and written) next time.
  const written = bridge.emit('proposal-created', record, {});
  const content = await fsp.readFile(file, 'utf8');
  assert.equal(content.split('\n').filter(Boolean).length, 1);
  assert.equal(JSON.parse(content.trim()).event.eventId, written.eventId);
});
