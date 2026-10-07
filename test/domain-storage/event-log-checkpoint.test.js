import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDomainStorage } from '../../lib/domain-storage.js';
import { EvolutionEventBridge, signEventBridgeEnvelope } from '../../lib/orchestrator.js';
import { digestEventLogPrefix, eventLogCheckpointPath, planEventLogReplay,
  readEventLogCheckpoint, writeEventLogCheckpoint } from '../../lib/event-log-checkpoint.js';
// The official storage packages are dev dependencies of this repo, so the
// domain integration is exercised against the real official implementation.
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

const KEY = 'b'.repeat(64);

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-event-log-'));
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'), eventBridgeKey: KEY };
  return { root, ctx, config, backend, bridge: new EvolutionEventBridge({ file: config.eventBridgePath, key: KEY }) };
}

async function teardown(f) { await f.backend.close(); fs.rmSync(f.root, { recursive: true, force: true }); }

function appendEnvelope(file, event, { sequence, key = KEY }) {
  const envelope = signEventBridgeEnvelope(event, { key, sequence });
  fs.appendFileSync(file, `${JSON.stringify(envelope)}\n`);
  return envelope;
}

function eventFor(id, status = 'measured') {
  return { schema: 1, eventId: `evolution:measurement-completed:${id}`, eventType: 'measurement-completed',
    experimentId: id, status, measurement: { latency: 1 }, audit: { at: '2026-10-07T00:00:00.000Z' } };
}

test('an authenticated prefix is reused and only new records need per-record work', async () => {
  const f = await fixture();
  const port = await openDomainStorage(f.ctx, f.config);
  f.bridge.emit('trial-completed', { id: 'exp-reuse', proposal: { target: 'plugin:reuse' } });
  assert.deepEqual(await port.flush(), { applied: 1, duplicates: 0 });
  const checkpointFile = eventLogCheckpointPath(f.root);
  const first = readEventLogCheckpoint(checkpointFile);
  assert.equal(first.bytes, fs.statSync(f.config.eventBridgePath).size);
  assert.equal(first.records, 1);
  assert.equal(first.digest, digestEventLogPrefix(KEY, fs.readFileSync(f.config.eventBridgePath), first.bytes));
  assert.equal(first.first.mac, first.last.mac);

  // Unchanged history: the plan reports the prefix as trusted and hands over no
  // complete lines, so nothing is parsed, canonicalized or MAC-checked again.
  const steady = planEventLogReplay({ file: f.config.eventBridgePath, key: KEY, writer: 'dsh-evolution-orchestrator',
    checkpoint: readEventLogCheckpoint(checkpointFile), applied: { [first.last.id]: first.last.mac } });
  assert.equal(steady.trusted, true);
  assert.equal(steady.prefixRecords, 1);
  assert.deepEqual(steady.lines, []);
  assert.equal(steady.advance, false);
  assert.deepEqual(await port.flush(), { applied: 0, duplicates: 1 });
  assert.deepEqual(readEventLogCheckpoint(checkpointFile), first, 'a steady pass must not rewrite the checkpoint');

  // A new record is verified per record and then folded into the prefix.
  appendEnvelope(f.config.eventBridgePath, eventFor('exp-reuse'), { sequence: 2 });
  assert.deepEqual(await port.flush(), { applied: 1, duplicates: 1 });
  const advanced = readEventLogCheckpoint(checkpointFile);
  assert.equal(advanced.records, 2);
  assert.ok(advanced.bytes > first.bytes);
  assert.deepEqual(await port.flush(), { applied: 0, duplicates: 2 });
  await port.close();
  await teardown(f);
});

test('a tampered consumed prefix is still rejected and never advances the checkpoint', async () => {
  const f = await fixture();
  const port = await openDomainStorage(f.ctx, f.config);
  f.bridge.emit('trial-completed', { id: 'exp-tamper', proposal: { target: 'plugin:tamper' } });
  assert.deepEqual(await port.flush(), { applied: 1, duplicates: 0 });
  const checkpointFile = eventLogCheckpointPath(f.root);
  const pristine = readEventLogCheckpoint(checkpointFile);
  const original = fs.readFileSync(f.config.eventBridgePath, 'utf8');

  // Rewrite an already absorbed record in place: the keyed prefix digest no
  // longer matches, so the pass falls back to full per-record verification and
  // fails exactly as it did before the checkpoint existed.
  const tampered = JSON.parse(original.trim());
  tampered.event.status = 'forged';
  fs.writeFileSync(f.config.eventBridgePath, `${JSON.stringify(tampered)}\n`);
  await assert.rejects(port.flush(), /E_DOMAIN_EVENT_AUTH/);
  assert.deepEqual(readEventLogCheckpoint(checkpointFile), pristine, 'a rejected pass must not bless the tampered bytes');

  // Restoring the bytes restores the fast path; the checkpoint was not lost.
  fs.writeFileSync(f.config.eventBridgePath, original);
  assert.deepEqual(await port.flush(), { applied: 0, duplicates: 1 });
  await assert.rejects(port.close(), /E_DOMAIN_EVENT_AUTH/);
  await teardown(f);
});

test('a forged or rolled back checkpoint cannot skip verification', async () => {
  const f = await fixture();
  const port = await openDomainStorage(f.ctx, f.config);
  f.bridge.emit('trial-completed', { id: 'exp-forge', proposal: { target: 'plugin:forge' } });
  assert.deepEqual(await port.flush(), { applied: 1, duplicates: 0 });
  const checkpointFile = eventLogCheckpointPath(f.root);
  const document = readEventLogCheckpoint(checkpointFile);
  const tampered = JSON.parse(fs.readFileSync(f.config.eventBridgePath, 'utf8').trim());
  tampered.event.status = 'forged';
  fs.writeFileSync(f.config.eventBridgePath, `${JSON.stringify(tampered)}\n`);

  // A checkpoint that claims the tampered bytes are authenticated without the
  // key (digest replaced by a constant) must not be trusted.
  writeEventLogCheckpoint(checkpointFile, { ...document, digest: 'f'.repeat(64) });
  await assert.rejects(port.flush(), /E_DOMAIN_EVENT_AUTH/);
  // A checkpoint claiming more bytes than the file holds must not be trusted.
  writeEventLogCheckpoint(checkpointFile, { ...document, bytes: document.bytes + 4096 });
  await assert.rejects(port.flush(), /E_DOMAIN_EVENT_AUTH/);
  // A checkpoint naming another file must not be trusted.
  writeEventLogCheckpoint(checkpointFile, { ...document, file: { dev: document.file.dev, ino: '999999999' } });
  await assert.rejects(port.flush(), /E_DOMAIN_EVENT_AUTH/);
  // A checkpoint bound to another trusted writer must not be trusted.
  writeEventLogCheckpoint(checkpointFile, { ...document, writer: 'other-writer' });
  await assert.rejects(port.flush(), /E_DOMAIN_EVENT_AUTH/);
  await assert.rejects(port.close(), /E_DOMAIN_EVENT_AUTH/);
  await teardown(f);
});

test('a rolled back marker map is refused by the witnesses and re-verified per record', async () => {
  const f = await fixture();
  const port = await openDomainStorage(f.ctx, f.config);
  f.bridge.emit('trial-completed', { id: 'exp-witness', proposal: { target: 'plugin:witness' } });
  assert.deepEqual(await port.flush(), { applied: 1, duplicates: 0 });
  const checkpoint = readEventLogCheckpoint(eventLogCheckpointPath(f.root));
  assert.equal(checkpoint.first.mac, checkpoint.last.mac);
  // The durable marker no longer carries the authenticated MAC: the committed
  // domain state moved backwards, so the prefix must not be reused.
  assert.equal(planEventLogReplay({ file: f.config.eventBridgePath, key: KEY, writer: 'dsh-evolution-orchestrator',
    checkpoint, applied: {} }).trusted, false);
  assert.equal(planEventLogReplay({ file: f.config.eventBridgePath, key: KEY, writer: 'dsh-evolution-orchestrator',
    checkpoint, applied: { [checkpoint.last.id]: 'f'.repeat(64) } }).trusted, false);
  assert.equal(planEventLogReplay({ file: f.config.eventBridgePath, key: KEY, writer: 'dsh-evolution-orchestrator',
    checkpoint, applied: { [checkpoint.last.id]: checkpoint.last.mac } }).trusted, true);
  await port.close();
  await teardown(f);
});

test('replaced, truncated and torn logs fall back to full per-record verification', async () => {
  const f = await fixture();
  let port = await openDomainStorage(f.ctx, f.config);
  for (let index = 0; index < 3; index++) {
    appendEnvelope(f.config.eventBridgePath, eventFor(`exp-${index}`), { sequence: index + 1 });
  }
  assert.deepEqual(await port.flush(), { applied: 3, duplicates: 0 });

  // Truncated to a complete line boundary: the prefix cannot be reused.
  const lines = fs.readFileSync(f.config.eventBridgePath, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(f.config.eventBridgePath, `${lines.slice(0, 2).join('\n')}\n`);
  assert.deepEqual(await port.flush(), { applied: 0, duplicates: 2 });
  assert.equal(fs.statSync(f.config.eventBridgePath).size, Buffer.byteLength(`${lines.slice(0, 2).join('\n')}\n`));

  // Replaced by a new file with the same bytes: new inode, so re-verified.
  const replaced = path.join(f.root, 'replacement.jsonl');
  fs.writeFileSync(replaced, fs.readFileSync(f.config.eventBridgePath));
  fs.renameSync(replaced, f.config.eventBridgePath);
  assert.deepEqual(await port.flush(), { applied: 0, duplicates: 2 });

  // A torn trailing line is processed but never covered by the checkpoint.
  // The record was applied before the truncation, so it is a duplicate now.
  const torn = JSON.parse(lines[2]);
  fs.appendFileSync(f.config.eventBridgePath, JSON.stringify(torn));
  assert.deepEqual(await port.flush(), { applied: 0, duplicates: 3 });
  const afterTorn = fs.statSync(f.config.eventBridgePath).size;
  const covered = readEventLogCheckpoint(eventLogCheckpointPath(f.root));
  assert.ok(covered.bytes < afterTorn, 'a torn line must stay outside the checkpoint');
  // Completing the line makes the same record a duplicate and advances.
  fs.appendFileSync(f.config.eventBridgePath, '\n');
  assert.deepEqual(await port.flush(), { applied: 0, duplicates: 3 });
  assert.equal(readEventLogCheckpoint(eventLogCheckpointPath(f.root)).bytes, fs.statSync(f.config.eventBridgePath).size);
  await port.close();

  // A missing checkpoint is simply a cold pass: full verification, then a
  // fresh checkpoint with the same counts.
  fs.rmSync(eventLogCheckpointPath(f.root));
  port = await openDomainStorage(f.ctx, f.config);
  assert.deepEqual(await port.flush(), { applied: 0, duplicates: 3 });
  assert.equal(readEventLogCheckpoint(eventLogCheckpointPath(f.root)).records, 3);
  await port.close();
  await teardown(f);
});

test('a malformed or unknown checkpoint document is treated as absent', async () => {
  const f = await fixture();
  const file = eventLogCheckpointPath(f.root);
  fs.writeFileSync(file, 'not json');
  assert.equal(readEventLogCheckpoint(file), null);
  fs.writeFileSync(file, JSON.stringify({ schema: 99, bytes: 1, records: 1, digest: 'a'.repeat(64), writer: 'w', file: { dev: '1', ino: '2' } }));
  assert.equal(readEventLogCheckpoint(file), null);
  const valid = { schema: 2, appliedDigest: 'a'.repeat(64), mac: 'b'.repeat(64), bytes: 2, records: 1, digest: crypto.createHash('sha256').update('x').digest('hex'),
    writer: 'w', file: { dev: '1', ino: '2' }, first: { id: 'a', mac: 'b' }, last: null };
  writeEventLogCheckpoint(file, valid);
  assert.deepEqual(readEventLogCheckpoint(file), valid);
  fs.writeFileSync(file, JSON.stringify({ ...valid, last: { id: 'a' } }));
  assert.equal(readEventLogCheckpoint(file), null);
  await f.backend.close();
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('a checkpoint the plugin can no longer write does not fail the pass', async () => {
  const f = await fixture();
  const port = await openDomainStorage(f.ctx, f.config);
  f.bridge.emit('trial-completed', { id: 'exp-readonly', proposal: { target: 'plugin:readonly' } });
  assert.deepEqual(await port.flush(), { applied: 1, duplicates: 0 });
  const file = eventLogCheckpointPath(f.root);
  fs.rmSync(file);
  fs.mkdirSync(file);
  appendEnvelope(f.config.eventBridgePath, eventFor('exp-readonly'), { sequence: 2 });
  assert.deepEqual(await port.flush(), { applied: 1, duplicates: 1 });
  fs.rmdirSync(file);
  assert.deepEqual(await port.flush(), { applied: 0, duplicates: 2 });
  await port.close();
  await teardown(f);
});

test('metadata forgery and a missing middle marker invalidate the entire checkpoint', async () => {
  const f = await fixture();
  const port = await openDomainStorage(f.ctx, f.config);
  try {
    for (let i = 0; i < 3; i++) appendEnvelope(f.config.eventBridgePath, eventFor(`middle-${i}`), { sequence: i + 1 });
    await port.flush();
    const checkpoint = readEventLogCheckpoint(eventLogCheckpointPath(f.root));
    const applied = { ...f.ctx.storageDomain.get('evolution_domain').global.get().applied };
    const plan = (candidate, markers = applied) => planEventLogReplay({ file: f.config.eventBridgePath, key: KEY,
      writer: 'dsh-evolution-orchestrator', checkpoint: candidate, applied: markers });
    assert.equal(plan(checkpoint).trusted, true);
    for (const patch of [{ records: 999 }, { first: null, last: null }, { mac: '0'.repeat(64) }]) {
      assert.equal(plan({ ...checkpoint, ...patch }).trusted, false);
    }
    delete applied['evolution:measurement-completed:middle-1'];
    assert.equal(plan(checkpoint).trusted, false, 'endpoint witnesses cannot prove all middle markers exist');
  } finally { await port.close(); await teardown(f); }
});

test('every replay reads the full prefix and rejects same-size middle tampering with restored timestamps', async () => {
  const f = await fixture();
  const port = await openDomainStorage(f.ctx, f.config);
  try {
    for (let i = 0; i < 5; i++) appendEnvelope(f.config.eventBridgePath, eventFor(`prefix-${i}`), { sequence: i + 1 });
    await port.flush();
    const checkpoint = readEventLogCheckpoint(eventLogCheckpointPath(f.root));
    const applied = f.ctx.storageDomain.get('evolution_domain').global.get().applied;
    const plan = () => planEventLogReplay({ file: f.config.eventBridgePath, key: KEY,
      writer: 'dsh-evolution-orchestrator', checkpoint, applied });
    const originalRead = fs.readSync;
    let bytesRead = 0;
    fs.readSync = (...args) => { const bytes = originalRead(...args); bytesRead += bytes; return bytes; };
    try {
      assert.equal(plan().trusted, true);
      assert.equal(bytesRead, checkpoint.bytes);
      bytesRead = 0;
      assert.equal(plan().trusted, true);
      assert.equal(bytesRead, checkpoint.bytes, 'even a repeated unchanged pass must inspect every consumed byte');
    } finally { fs.readSync = originalRead; }

    const before = fs.statSync(f.config.eventBridgePath);
    const lines = fs.readFileSync(f.config.eventBridgePath, 'utf8').split('\n');
    lines[2] = lines[2].replace('measured', 'feasured');
    fs.writeFileSync(f.config.eventBridgePath, lines.join('\n'));
    fs.utimesSync(f.config.eventBridgePath, before.atime, before.mtime);
    const after = fs.statSync(f.config.eventBridgePath);
    assert.equal(after.ino, before.ino);
    assert.equal(after.size, before.size);
    assert.ok(Math.abs(after.mtimeMs - before.mtimeMs) < 1, 'timestamp restored to filesystem precision');
    assert.equal(plan().trusted, false);
    await assert.rejects(port.flush(), /E_DOMAIN_EVENT_AUTH/);
    assert.deepEqual(readEventLogCheckpoint(eventLogCheckpointPath(f.root)), checkpoint);
    await assert.rejects(port.close(), /E_DOMAIN_EVENT_AUTH/);
  } finally { await teardown(f); }
});
