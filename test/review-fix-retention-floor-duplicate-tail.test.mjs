// Regression for the retention-floor classifier ambiguity when a discarded
// record is byte-identical to a retained one. The bridge is at-least-once, so
// duplicates are intentional: the prior file then begins with exactly the bytes
// the floor calls the retained tail. Classifying that file as `already-truncated`
// skipped the committed truncation forever and let every later replay re-absorb
// the pruned marker.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { signEventBridgeEnvelope } from '../lib/orchestrator.js';
import {
  advanceRetention, completeEventLogTruncation, digestLogBytes,
  inspectEventLogFloor, planLogPrune,
} from '../lib/event-log-checkpoint.js';

const KEY = 'c'.repeat(64);
const WRITER = 'dsh-evolution-orchestrator';

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floor-duplicate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function envelopeLine(sequence) {
  const event = { eventId: 'evt-duplicate-1', eventType: 'measurement-completed', data: { n: 1 } };
  return JSON.stringify(signEventBridgeEnvelope(event, { key: KEY, writer: WRITER, sequence })) + '\n';
}

function floorFor(buffer) {
  const mac = JSON.parse(buffer.toString('utf8').split('\n')[0]).mac;
  const plan = planLogPrune({
    buffer, key: KEY, writer: WRITER,
    applied: { 'evt-duplicate-1': mac }, retainRecords: 1,
  });
  return { plan, retention: advanceRetention(null, { prunable: plan?.prunable ?? [], log: plan, key: KEY }) };
}

test('a prior file whose prefix equals the retained tail is deferred, not already-truncated', (t) => {
  const root = scratch(t);
  const file = path.join(root, 'events.jsonl');
  const line = envelopeLine(1);
  const buffer = Buffer.from(line + line); // two byte-identical records
  fs.writeFileSync(file, buffer);
  const { plan, retention } = floorFor(buffer);
  assert.ok(plan, 'one of the two duplicate records is prunable');
  assert.ok(plan.prior.bytes > plan.tail.bytes);
  assert.equal(digestLogBytes(KEY, buffer.subarray(0, plan.tail.bytes)), plan.tail.digest,
    'the fixture really has prior prefix == tail bytes');

  // This is the exact misclassification: old code returned `already-truncated`.
  assert.equal(inspectEventLogFloor({ file, key: KEY, floor: retention }).status, 'deferred');

  const completion = completeEventLogTruncation({ file, key: KEY, floor: retention, withAppendLock: (_file, fn) => fn() });
  assert.equal(completion.status, 'truncated');
  assert.equal(fs.statSync(file).size, plan.tail.bytes, 'the committed truncation actually ran');

  // Nothing left to prune: a second round must not re-derive a floor and grow
  // the cumulative counters while the file stays the same size.
  assert.equal(floorFor(fs.readFileSync(file)).plan, null);
  assert.equal(inspectEventLogFloor({ file, key: KEY, floor: retention }).status, 'already-truncated');
});

test('a distinct-prefix floor keeps its historical classification', (t) => {
  const root = scratch(t);
  const file = path.join(root, 'events.jsonl');
  const first = envelopeLine(1);
  const second = JSON.stringify(signEventBridgeEnvelope(
    { eventId: 'evt-distinct-2', eventType: 'measurement-completed', data: { n: 2 } },
    { key: KEY, writer: WRITER, sequence: 2 },
  )) + '\n';
  const buffer = Buffer.from(first + second);
  fs.writeFileSync(file, buffer);
  const secondMac = JSON.parse(second.trim()).mac;
  const plan = planLogPrune({ buffer, key: KEY, writer: WRITER,
    applied: { 'evt-duplicate-1': JSON.parse(first.trim()).mac, 'evt-distinct-2': secondMac }, retainRecords: 1 });
  const retention = advanceRetention(null, { prunable: plan.prunable, log: plan, key: KEY });
  assert.equal(inspectEventLogFloor({ file, key: KEY, floor: retention }).status, 'deferred');
  const completion = completeEventLogTruncation({ file, key: KEY, floor: retention, withAppendLock: (_file, fn) => fn() });
  assert.equal(completion.status, 'truncated');
  assert.equal(fs.statSync(file).size, plan.tail.bytes);
});

test('a genuinely truncated duplicate-prefix log is reported already-truncated', (t) => {
  const root = scratch(t);
  const file = path.join(root, 'events.jsonl');
  const line = envelopeLine(1);
  const buffer = Buffer.from(line + line);
  fs.writeFileSync(file, buffer);
  const { plan, retention } = floorFor(buffer);
  fs.writeFileSync(file, buffer.subarray(plan.prior.bytes - plan.tail.bytes));
  assert.equal(inspectEventLogFloor({ file, key: KEY, floor: retention }).status, 'already-truncated');
  const completion = completeEventLogTruncation({ file, key: KEY, floor: retention, withAppendLock: (_file, fn) => fn() });
  assert.equal(completion.status, 'already-truncated');
  assert.equal(fs.statSync(file).size, plan.tail.bytes);
});
