import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evolutionDomainSpec, openDomainStorage } from '../../lib/domain-storage.js';
import { EvolutionEventBridge, signEventBridgeEnvelope } from '../../lib/orchestrator.js';
import { digestApplied, digestEventLogPrefix, eventLogCheckpointPath, planEventLogReplay,
  readEventLogCheckpoint, writeEventLogCheckpoint } from '../../lib/event-log-checkpoint.js';
// The official storage packages are dev dependencies of this repo, so the
// domain integration is exercised against the real official implementation.
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

const KEY = 'b'.repeat(64);

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-event-log-'));
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  // The official domain notifies every write through its handle as
  // `domain/changed`; the fixture mirrors that so the invalidation path is real.
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

test('the stored marker digest always describes the committed marker map', async () => {
  const f = await fixture();
  const port = await openDomainStorage(f.ctx, f.config);
  try {
    const appliedNow = () => f.ctx.storageDomain.get('evolution_domain').global.get().applied;
    const checkpointFile = eventLogCheckpointPath(f.root);
    appendEnvelope(f.config.eventBridgePath, eventFor('exp-digest'), { sequence: 1 });
    assert.deepEqual(await port.flush(), { applied: 1, duplicates: 0 });
    const first = readEventLogCheckpoint(checkpointFile);
    assert.equal(first.appliedDigest, digestApplied(appliedNow()));

    // A pass that commits nothing must keep binding the same map: the checkpoint
    // stays trusted instead of degrading to per-record verification.
    assert.deepEqual(await port.flush(), { applied: 0, duplicates: 1 });
    assert.equal(readEventLogCheckpoint(checkpointFile).appliedDigest, first.appliedDigest);
    assert.equal(planEventLogReplay({ file: f.config.eventBridgePath, key: KEY,
      writer: 'dsh-evolution-orchestrator', checkpoint: readEventLogCheckpoint(checkpointFile),
      applied: appliedNow() }).trusted, true);

    // A committed record must move the stored digest together with the map.
    appendEnvelope(f.config.eventBridgePath, eventFor('exp-digest-2'), { sequence: 2 });
    assert.deepEqual(await port.flush(), { applied: 1, duplicates: 1 });
    const advanced = readEventLogCheckpoint(checkpointFile);
    assert.equal(Object.keys(appliedNow()).length, 2);
    assert.notEqual(advanced.appliedDigest, first.appliedDigest);
    assert.equal(advanced.appliedDigest, digestApplied(appliedNow()));
  } finally { await port.close(); await teardown(f); }
});

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

test('a mid-history marker rollback between runs is repaired by a fresh process', async () => {
  const f = await fixture();
  let port = await openDomainStorage(f.ctx, f.config);
  const envelopes = [1, 2, 3].map((sequence) =>
    appendEnvelope(f.config.eventBridgePath, eventFor(`exp-rewound-${sequence}`), { sequence }));
  assert.deepEqual(await port.flush(), { applied: 3, duplicates: 0 });
  await port.close();
  // Rewind one marker in the middle of the consumed prefix, keeping the first
  // and last witness intact, the way a restored or rewound home would, with no
  // plugin running. Only the marker-map digest can detect this, and it is only
  // reused within one port: a prefix trusted from a stale digest would skip
  // per-record work and leave the missing marker unrepaired.
  const expected = Object.fromEntries(envelopes.map((envelope) => [envelope.event.eventId, envelope.mac]));
  const domain = await f.ctx.storageDomain.open(evolutionDomainSpec);
  try {
    const current = domain.global.get();
    assert.deepEqual(current.applied, expected);
    const rewound = { ...current.applied };
    delete rewound[envelopes[1].event.eventId];
    await domain.global.set({ ...current, applied: rewound });
  } finally { await domain.close(); }
  port = await openDomainStorage(f.ctx, f.config);
  try {
    const result = await port.flush();
    assert.equal(result.applied + result.duplicates, 3, 'every record is processed per record again');
    assert.deepEqual(f.ctx.storageDomain.get('evolution_domain').global.get().applied, expected,
      'the rewound marker is repaired, never skipped by a reused digest');
    assert.deepEqual(await port.flush(), { applied: 0, duplicates: 3 });
  } finally { await port.close(); await teardown(f); }
});

test('a marker rewound through the official handle while the port is alive is repaired', async () => {
  const f = await fixture();
  const port = await openDomainStorage(f.ctx, f.config);
  try {
    const envelopes = [1, 2, 3].map((sequence) =>
      appendEnvelope(f.config.eventBridgePath, eventFor(`exp-live-${sequence}`), { sequence }));
    assert.deepEqual(await port.flush(), { applied: 3, duplicates: 0 });
    const expected = Object.fromEntries(envelopes.map((envelope) => [envelope.event.eventId, envelope.mac]));
    // The plugin is not the only holder of the official handle: anything with
    // the context can open this domain. A rewind through that handle must
    // invalidate the reused digest, or the new checkpoint would authenticate a
    // marker map that is already missing an absorbed record.
    const handle = f.ctx.storageDomain.get(evolutionDomainSpec.name).global;
    const rewound = { ...handle.get().applied };
    delete rewound[envelopes[1].event.eventId];
    await handle.set({ ...handle.get(), applied: rewound });
    appendEnvelope(f.config.eventBridgePath, eventFor('exp-live-4'), { sequence: 4 });
    assert.deepEqual(await port.flush(), { applied: 1, duplicates: 3 });
    await port.close();
    const restarted = await openDomainStorage(f.ctx, f.config);
    try {
      await restarted.flush();
      const applied = f.ctx.storageDomain.get(evolutionDomainSpec.name).global.get().applied;
      for (const [id, mac] of Object.entries(expected)) assert.equal(applied[id], mac, `marker ${id} must survive`);
      assert.equal(Object.keys(applied).length, 4);
      // The stored digest must describe the repaired map: a stale one would be
      // written into the next checkpoint and silently skip the prefix again.
      const checkpoint = readEventLogCheckpoint(eventLogCheckpointPath(f.root));
      assert.equal(checkpoint.appliedDigest, digestApplied(applied));
    } finally { await restarted.close(); }
  } finally { await teardown(f); }
});

test('a listener that rewrites the pending record cannot bypass its validation', async () => {
  // The official domain hands the written document to every `domain/changed`
  // listener, so the recovery path re-checks the fields it reads before the
  // final commit validates the aggregate and marker map again. Each variant gets
  // a fresh home because the injected failure deliberately leaves the pending
  // record in place for recovery.
  for (const [name, mutate] of [
    ['a stage name outside the staging root', pending => { pending.stage = '../../escape'; }],
    ['a file list that is not a file list', pending => { pending.files = null; }],
    ['a file entry without a digest', pending => { pending.files = [{ file: 'state.json', bytes: 1 }]; }],
    ['a pending record removed altogether', (pending, document) => { document.pending = undefined; }],
  ]) {
    const f = await fixture();
    const port = await openDomainStorage(f.ctx, f.config);
    let pendingMutation = mutate;
    f.ctx.on('domain/changed', change => {
      if (!pendingMutation || !change?.value?.pending) return;
      const run = pendingMutation;
      pendingMutation = null;
      run(change.value.pending, change.value);
    });
    try {
      appendEnvelope(f.config.eventBridgePath, eventFor('exp-listener'), { sequence: 1 });
      await assert.rejects(port.flush(), (error) => error?.name === 'ZodError', `${name} must fail loudly`);
    } finally {
      // The port records the injected failure and rethrows it on close.
      await port.close().catch(() => {});
      await teardown(f);
    }
  }
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
