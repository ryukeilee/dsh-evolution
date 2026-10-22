// The replay checkpoint's keyed digest, and the one-pass fork that produces both
// of the digests a pass needs.
//
// A pass over a log that grew has to authenticate two nested byte ranges: the
// consumed prefix (against the checkpoint it starts from) and the whole file
// (the checkpoint it writes). Both used to be hashed from scratch, so the prefix
// was hashed twice per passing flush. `createEventLogKeyedDigest` forks the HMAC
// state at the boundary instead, and everything in this file exists to pin that the
// fork produces exactly the values `crypto.createHmac('sha256', key)` produces - the
// stored digest may not move, because it authenticates bytes that were already
// committed.
//
// There are two independent implementations on purpose: the full read still uses
// `crypto.createHmac` through `digestEventLogPrefix`, and only the grown read uses
// the fork. A checkpoint written by one is therefore verified by the other on the
// next pass, and both directions are asserted below.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDomainStorage } from '../../lib/domain-storage.js';
import { signEventBridgeEnvelope } from '../../lib/orchestrator.js';
import { createEventLogKeyedDigest, digestEventLogPrefix, eventLogCheckpointPath,
  planEventLogReplay, readEventLogCheckpoint } from '../../lib/event-log-checkpoint.js';
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

const KEY = 'b'.repeat(64);
const native = (key, bytes) => crypto.createHmac('sha256', key).update(bytes).digest('hex');

/** Every key lands on one side of the HMAC block size, and every message lands on
 *  one side of it too: short, exactly one block, one block plus a byte, empty. */
const KEYS = ['k', 'k'.repeat(63), 'k'.repeat(64), 'k'.repeat(65), 'k'.repeat(200),
  'ü'.repeat(21), Buffer.from('a-buffer-key-that-is-longer-than-nothing')];
const LENGTHS = [0, 1, 63, 64, 65, 4096, 1 << 20, (1 << 20) + 7];

test('the forkable keyed digest is byte-identical to crypto.createHmac', () => {
  for (const key of KEYS) {
    for (const length of LENGTHS) {
      const bytes = Buffer.alloc(length, 0x5a);
      const digest = createEventLogKeyedDigest(key);
      digest.update(bytes);
      assert.equal(digest.hex(), native(key, bytes), `key ${key.length} bytes, message ${length} bytes`);
    }
  }
});

test('the forkable keyed digest matches crypto.createHmac across chunk boundaries', () => {
  // The read loop feeds a chunk at a time, so the same state has to produce the
  // same digest however the message is cut up.
  const bytes = crypto.randomBytes(300_000);
  for (const chunk of [1, 63, 64, 65, 4096, 100_000, bytes.length]) {
    const digest = createEventLogKeyedDigest(KEY);
    for (let offset = 0; offset < bytes.length; offset += chunk) digest.update(bytes.subarray(offset, offset + chunk));
    assert.equal(digest.hex(), native(KEY, bytes), `chunk size ${chunk}`);
  }
});

test('a forked digest covers exactly the bytes seen before the fork, and the fork does not disturb the original', () => {
  const bytes = crypto.randomBytes(200_000);
  for (const cut of [0, 1, 63, 64, 65, 1024, 131_072, bytes.length - 1, bytes.length]) {
    const digest = createEventLogKeyedDigest(KEY);
    digest.update(bytes.subarray(0, cut));
    const prefix = digest.fork().hex();
    digest.update(bytes.subarray(cut));
    assert.equal(prefix, native(KEY, bytes.subarray(0, cut)), `prefix at ${cut}`);
    assert.equal(digest.hex(), native(KEY, bytes), `whole message with the fork at ${cut}`);
    // Two forks may be taken from one instance, and each one is independent.
    const first = createEventLogKeyedDigest(KEY);
    first.update(bytes.subarray(0, 1000));
    const early = first.fork();
    first.update(bytes.subarray(1000, 2000));
    const late = first.fork();
    assert.equal(early.hex(), native(KEY, bytes.subarray(0, 1000)));
    assert.equal(late.hex(), native(KEY, bytes.subarray(0, 2000)));
  }
});

test('digestEventLogPrefix still reports the native HMAC of the prefix', () => {
  const bytes = crypto.randomBytes(4096);
  for (const length of [0, 1, 64, 1024, bytes.length]) {
    assert.equal(digestEventLogPrefix(KEY, bytes, length), native(KEY, bytes.subarray(0, length)));
  }
});

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-keyed-digest-'));
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'), eventBridgeKey: KEY };
  return { root, ctx, config, backend };
}
const teardown = async (f) => { await f.backend.close(); fs.rmSync(f.root, { recursive: true, force: true }); };
const eventFor = (id) => ({ schema: 1, eventId: `evolution:measurement-completed:${id}`, eventType: 'measurement-completed',
  experimentId: id, status: 'measured', measurement: { latency: 1 }, audit: { at: '2026-10-07T00:00:00.000Z' } });
function append(file, id, sequence) {
  const envelope = signEventBridgeEnvelope(eventFor(id), { key: KEY, sequence });
  fs.appendFileSync(file, `${JSON.stringify(envelope)}\n`);
  return envelope;
}

test('the checkpoint a grown pass writes carries the native HMAC of the whole log', async () => {
  const f = await fixture();
  const port = await openDomainStorage(f.ctx, f.config);
  try {
    append(f.config.eventBridgePath, 'digest-1', 1);
    assert.deepEqual(await port.flush(), { applied: 1, duplicates: 0 });
    // The first checkpoint is written by the full-read path, which still hashes
    // with `crypto.createHmac`.
    const cold = readEventLogCheckpoint(eventLogCheckpointPath(f.root));
    assert.equal(cold.digest, native(KEY, fs.readFileSync(f.config.eventBridgePath)));
    // The next pass reads a log that grew, so its digests come out of the fork:
    // both the prefix digest it verifies against and the whole-file digest it
    // stores have to be the native values.
    append(f.config.eventBridgePath, 'digest-2', 2);
    const appliedNow = () => f.ctx.storageDomain.get('evolution_domain').global.get().applied;
    const plan = planEventLogReplay({ file: f.config.eventBridgePath, key: KEY, writer: 'dsh-evolution-orchestrator',
      checkpoint: cold, applied: appliedNow() });
    assert.equal(plan.trusted, true, 'the fork must reproduce the digest the full read stored');
    assert.deepEqual(await port.flush(), { applied: 1, duplicates: 1 });
    const advanced = readEventLogCheckpoint(eventLogCheckpointPath(f.root));
    const bytes = fs.readFileSync(f.config.eventBridgePath);
    assert.equal(advanced.bytes, bytes.length);
    assert.equal(advanced.digest, native(KEY, bytes), 'the stored digest must cover exactly the log bytes');
    assert.equal(advanced.digest, plan.next.digest, 'the plan must hand over the digest it verified');
    // A steady pass hashes the whole log once and reports the same digest.
    const steady = planEventLogReplay({ file: f.config.eventBridgePath, key: KEY, writer: 'dsh-evolution-orchestrator',
      checkpoint: advanced, applied: appliedNow() });
    assert.equal(steady.trusted, true);
    assert.equal(steady.next.digest, advanced.digest);
    assert.equal(steady.next.bytes, advanced.bytes);
  } finally { await port.close(); await teardown(f); }
});

test('a checkpoint whose digest does not match the log bytes is still rejected', async () => {
  const f = await fixture();
  const port = await openDomainStorage(f.ctx, f.config);
  try {
    append(f.config.eventBridgePath, 'reject-1', 1);
    append(f.config.eventBridgePath, 'reject-2', 2);
    assert.deepEqual(await port.flush(), { applied: 2, duplicates: 0 });
    const stored = readEventLogCheckpoint(eventLogCheckpointPath(f.root));
    // Rewrite one byte of a record the checkpoint covers without touching its
    // length: the fork covers every byte, so the digest must notice.
    const file = f.config.eventBridgePath;
    const bytes = fs.readFileSync(file);
    const index = bytes.indexOf(Buffer.from('reject-1'));
    bytes[index] = 'R'.charCodeAt(0);
    fs.writeFileSync(file, bytes);
    const plan = planEventLogReplay({ file, key: KEY, writer: 'dsh-evolution-orchestrator', checkpoint: stored,
      applied: f.ctx.storageDomain.get('evolution_domain').global.get().applied });
    assert.equal(plan.trusted, false, 'a changed byte inside the consumed prefix must not be trusted');
    assert.equal(plan.prefixRecords, 0, 'an untrusted checkpoint covers no records');
    assert.equal(plan.lines.length, 2, 'the whole log is handed back for per-record verification');
  } finally { await port.close(); await teardown(f); }
});

test('a record that lands while the pass is reading does not advance the checkpoint', async () => {
  // `stat.size === consumed` when the pass starts, so the read is not treated as a
  // grown log - but a writer appends one record before the last chunk is read. The
  // pass may not fold bytes it did not authenticate into the checkpoint, and the
  // record it did read has to be handed back for per-record verification.
  const f = await fixture();
  const port = await openDomainStorage(f.ctx, f.config);
  const originalReadSync = fs.readSync;
  try {
    append(f.config.eventBridgePath, 'torn-1', 1);
    append(f.config.eventBridgePath, 'torn-2', 2);
    assert.deepEqual(await port.flush(), { applied: 2, duplicates: 0 });
    const stored = readEventLogCheckpoint(eventLogCheckpointPath(f.root));
    const pristine = fs.statSync(f.config.eventBridgePath).size;
    let appended = false;
    fs.readSync = function patched(...values) {
      const size = originalReadSync.apply(this, values);
      if (!appended) {
        appended = true;
        append(f.config.eventBridgePath, 'torn-3', 3);
      }
      return size;
    };
    let plan;
    try {
      plan = planEventLogReplay({ file: f.config.eventBridgePath, key: KEY, writer: 'dsh-evolution-orchestrator',
        checkpoint: stored, applied: f.ctx.storageDomain.get('evolution_domain').global.get().applied });
    } finally { fs.readSync = originalReadSync; }
    assert.equal(appended, true);
    assert.ok(fs.statSync(f.config.eventBridgePath).size > pristine, 'the append must have landed during the read');
    assert.equal(plan.trusted, true, 'the authenticated prefix is still the prefix');
    assert.equal(plan.advance, false, 'a checkpoint must not cover bytes that arrived mid-read');
    assert.equal(plan.next.digest, null);
    assert.equal(plan.lines.length, 1, 'the record that arrived mid-read is verified per record');
    // The record is still applied exactly once by the next real pass.
    assert.deepEqual(await port.flush(), { applied: 1, duplicates: 2 });
    assert.deepEqual(await port.flush(), { applied: 0, duplicates: 3 });
  } finally { fs.readSync = originalReadSync; await port.close(); await teardown(f); }
});
