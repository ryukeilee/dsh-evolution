// Regression for the retention floor's file-generation ambiguity. The bridge is
// at-least-once, so a discarded record can be byte-identical to a retained one:
// the still-untruncated prior file then begins with exactly the bytes the floor
// calls the tail. A digest-only reader cannot distinguish that crash window from
// a completed truncation whose later appends recreated the same prefix. The
// floor now records the originating dev/ino for that ambiguous shape, so the
// classifier can judge the file's generation instead of only its bytes.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDomainStorage } from '../lib/domain-storage.js';
import { EvolutionEventBridge, externalizeEventBridgeEvidence, signEventBridgeEnvelope } from '../lib/orchestrator.js';
import {
  advanceRetention, completeEventLogTruncation, digestLogBytes,
  inspectEventLogFloor, planLogPrune,
} from '../lib/event-log-checkpoint.js';
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

const KEY = 'd'.repeat(64);
const WRITER = 'dsh-evolution-orchestrator';

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floor-generation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function identityOf(file) {
  const stat = fs.statSync(file, { bigint: true });
  return { dev: stat.dev, ino: stat.ino };
}

function line(id, sequence) {
  return JSON.stringify(signEventBridgeEnvelope({ eventId: id, eventType: 'measurement-completed', data: {} },
    { key: KEY, writer: WRITER, sequence })) + '\n';
}

test('an ambiguous floor truncates the still-pending prior file', (t) => {
  const root = scratch(t);
  const file = path.join(root, 'events.jsonl');
  const first = line('evt-1', 1);
  fs.writeFileSync(file, first + first); // two byte-identical records
  const buffer = fs.readFileSync(file);
  const plan = planLogPrune({ buffer, key: KEY, writer: WRITER,
    applied: { 'evt-1': JSON.parse(first.trim()).mac }, retainRecords: 1,
    identity: identityOf(file) });
  assert.ok(plan);
  assert.equal(plan.prior.ambiguousPrefix, true);
  assert.ok(plan.prior.identity);
  assert.equal(digestLogBytes(KEY, buffer.subarray(0, plan.tail.bytes)), plan.tail.digest);
  const retention = advanceRetention(null, { prunable: plan.prunable, log: plan, key: KEY });

  assert.equal(inspectEventLogFloor({ file, key: KEY, floor: retention }).status, 'deferred');
  const completion = completeEventLogTruncation({ file, key: KEY, floor: retention, withAppendLock: (_f, fn) => fn() });
  assert.equal(completion.status, 'truncated');
  assert.equal(fs.statSync(file).size, plan.tail.bytes);
});

test('appends that recreate the prior prefix after truncation are not truncated again', (t) => {
  const root = scratch(t);
  const file = path.join(root, 'events.jsonl');
  const first = line('evt-1', 1);
  fs.writeFileSync(file, first + first);
  const buffer = fs.readFileSync(file);
  const plan = planLogPrune({ buffer, key: KEY, writer: WRITER,
    applied: { 'evt-1': JSON.parse(first.trim()).mac }, retainRecords: 1,
    identity: identityOf(file) });
  const retention = advanceRetention(null, { prunable: plan.prunable, log: plan, key: KEY });
  assert.equal(completeEventLogTruncation({ file, key: KEY, floor: retention, withAppendLock: (_f, fn) => fn() }).status, 'truncated');
  const afterTruncation = fs.readFileSync(file);
  const generationAfter = identityOf(file);
  assert.notDeepEqual(generationAfter, plan.prior.identity, 'the rename publishes a new generation');

  // A later delivery of the same record recreates the discarded prefix:
  // A A -> A, then A. The new file is byte-identical to the old prior but has a
  // different generation, which is exactly the sol-loop counterexample.
  fs.appendFileSync(file, first);
  const recreated = fs.readFileSync(file);
  assert.equal(recreated.length, buffer.length, 'the new file is byte-identical to the old prior');
  assert.deepEqual(digestLogBytes(KEY, recreated), plan.prior.digest);
  assert.deepEqual(identityOf(file), generationAfter, 'appends keep the generation');

  assert.equal(inspectEventLogFloor({ file, key: KEY, floor: retention }).status, 'already-truncated');
  const again = completeEventLogTruncation({ file, key: KEY, floor: retention, withAppendLock: (_f, fn) => fn() });
  assert.equal(again.status, 'already-truncated');
  assert.deepEqual(fs.readFileSync(file), recreated, 'the appended records survive');
});

test('a completed truncation stays completed across a restart', async (t) => {
  const root = scratch(t);
  const file = path.join(root, 'events.jsonl');
  const first = line('evt-1', 1);
  fs.writeFileSync(file, first + first);
  const plan = planLogPrune({ buffer: fs.readFileSync(file), key: KEY, writer: WRITER,
    applied: { 'evt-1': JSON.parse(first.trim()).mac }, retainRecords: 1, identity: identityOf(file) });
  const retention = advanceRetention(null, { prunable: plan.prunable, log: plan, key: KEY });
  await fs.promises.writeFile(path.join(root, 'retention.json'), JSON.stringify(retention));
  await completeEventLogTruncation({ file, key: KEY, floor: retention, withAppendLock: (_f, fn) => fn() });
  const before = fs.readFileSync(file);
  // Re-read the floor the way a new process would: it describes the same bytes
  // but not the generation that just completed the truncation.
  const reopened = JSON.parse(await fs.promises.readFile(path.join(root, 'retention.json'), 'utf8'));
  assert.equal(inspectEventLogFloor({ file, key: KEY, floor: reopened }).status, 'already-truncated');
  assert.deepEqual(fs.readFileSync(file), before);
});

test('a non-ambiguous floor keeps its historical bytes and classification', (t) => {
  const root = scratch(t);
  const file = path.join(root, 'events.jsonl');
  const first = line('evt-1', 1);
  const second = line('evt-2', 2);
  fs.writeFileSync(file, first + second);
  const plan = planLogPrune({ buffer: fs.readFileSync(file), key: KEY, writer: WRITER,
    applied: { 'evt-1': JSON.parse(first.trim()).mac, 'evt-2': JSON.parse(second.trim()).mac },
    retainRecords: 1, identity: identityOf(file) });
  assert.equal(plan.prior.ambiguousPrefix, undefined);
  assert.deepEqual(Object.keys(plan.prior), ['bytes', 'digest']);
  const retention = advanceRetention(null, { prunable: plan.prunable, log: plan, key: KEY });
  assert.equal(inspectEventLogFloor({ file, key: KEY, floor: retention }).status, 'deferred');
});

test('a legacy ambiguous floor without identity keeps the historical digest-only behavior', (t) => {
  const root = scratch(t);
  const file = path.join(root, 'events.jsonl');
  const first = line('evt-1', 1);
  fs.writeFileSync(file, first + first);
  const plan = planLogPrune({ buffer: fs.readFileSync(file), key: KEY, writer: WRITER,
    applied: { 'evt-1': JSON.parse(first.trim()).mac }, retainRecords: 1 });
  assert.equal(plan.prior.ambiguousPrefix, undefined);
  const retention = advanceRetention(null, { prunable: plan.prunable, log: plan, key: KEY });
  assert.equal(inspectEventLogFloor({ file, key: KEY, floor: retention }).status, 'already-truncated');
});

test('the domain store keeps appends that recreate a truncated duplicate prefix, including after a restart', async (t) => {
  const root = scratch(t);
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const listeners = new Map();
  const ctx = {
    emit(name, ...args) { for (const listener of listeners.get(name) ?? []) listener(...args); },
    on(name, listener) {
      const list = listeners.get(name) ?? [];
      list.push(listener);
      listeners.set(name, list);
      return () => { const index = list.indexOf(listener); if (index >= 0) list.splice(index, 1); };
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
  const open = () => openDomainStorage(ctx, {
    ...config,
    externalizeEventEvidence: (entries) => externalizeEventBridgeEvidence({ archiveDir: config.archiveDir }, entries),
  });
  t.after(async () => { await backend.close(); });

  const bridge = new EvolutionEventBridge({ file: config.eventBridgePath, key: KEY });
  const payload = { schema: 1, eventId: `evolution:measurement-completed:recreated`, eventType: 'measurement-completed',
    experimentId: 'recreated', proposalId: 'recreated', target: 'fixture-target', capability: 'fixture-target',
    lineageId: 'fixture-target', status: 'measured', measurement: { latencyMs: 1 }, promotion: null, canary: null,
    evidence: {}, audit: { producer: WRITER, at: new Date().toISOString() } };
  bridge.emit('measurement-completed', {}, payload);
  const original = fs.readFileSync(config.eventBridgePath);
  let port = await open();
  try {
    assert.deepEqual(await port.flush(), { applied: 0, duplicates: 1 }, 'the at-least-once duplicate is deduped before reclaim');
    // A second at-least-once delivery of the same envelope makes the prior file
    // begin with exactly the bytes the floor will retain.
    fs.appendFileSync(config.eventBridgePath, original);
    const report = await port.reclaim({ confirmation: true, archives: false, log: true, retainRecords: 1 });
    assert.equal(report.log.status, 'discarded');
    assert.equal(report.log.truncated, 'truncated');
    const retained = fs.readFileSync(config.eventBridgePath);
    assert.deepEqual(retained, original);

    // The same bytes arrive again after truncation: a new generation with the
    // old prefix. It must be absorbed, never truncated away again.
    fs.appendFileSync(config.eventBridgePath, original);
    const recreated = fs.readFileSync(config.eventBridgePath);
    assert.deepEqual(recreated, Buffer.concat([original, original]));
    const flushed = await port.flush();
    // The pruned marker no longer conflicts, but the memory's marker window
    // still recognises the id, so the recreated delivery is a duplicate rather
    // than a new effect (documented boundary). What matters here is that the
    // bytes survive: a confused classifier would truncate them away.
    assert.equal(flushed.applied, 0);
    assert.ok(flushed.duplicates >= 1);
    assert.deepEqual(fs.readFileSync(config.eventBridgePath), recreated, 'flush did not discard appended bytes');

    // Reopen the store: startup recovery sees the committed floor and the same
    // generation, and must leave the recreated bytes alone.
    await port.close();
    port = await open();
    assert.deepEqual(fs.readFileSync(config.eventBridgePath), recreated);
    const afterRestart = await port.flush();
    assert.equal(afterRestart.applied, 0);
    assert.ok(afterRestart.duplicates >= 1);
  } finally {
    if (port) await port.close().catch(() => {});
  }
});

test('an ambiguous floor whose bytes match neither generation is refused', (t) => {
  const root = scratch(t);
  const file = path.join(root, 'events.jsonl');
  const first = line('evt-1', 1);
  fs.writeFileSync(file, first + first);
  const plan = planLogPrune({ buffer: fs.readFileSync(file), key: KEY, writer: WRITER,
    applied: { 'evt-1': JSON.parse(first.trim()).mac }, retainRecords: 1, identity: identityOf(file) });
  const retention = advanceRetention(null, { prunable: plan.prunable, log: plan, key: KEY });
  fs.writeFileSync(file, 'garbage\n');
  assert.equal(inspectEventLogFloor({ file, key: KEY, floor: retention }).status, 'unknown');
});
