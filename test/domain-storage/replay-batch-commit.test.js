// Regression coverage for the grouped replay commit in lib/domain-storage.js.
//
// A step that arrives after a burst of bridge records (one operation emits two
// or three, the observer emits them between steps, or the process was down
// while another one appended) commits the whole burst as one durable
// transaction instead of one per record. The properties that must not move are
// the ones these tests pin: every record is still parsed, MAC-verified,
// writer-checked, conflict-checked and applied in file order; the marker map
// still decides dedup; a refusal still keeps the records that were already
// authenticated durable and still does not advance the checkpoint; and a
// failure inside the group's own transaction leaves nothing of it published, so
// a restart or the next pass applies each record exactly once.
//
// `openDomainStorage()` runs one replay pass while it opens, so every test
// appends its records after the port is open and measures the explicit
// `flush()` that follows - that is the call `registration.js` makes after a
// tool and before an agent step.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evolutionDomainSpec, openDomainStorage } from '../../lib/domain-storage.js';
import { signEventBridgeEnvelope } from '../../lib/orchestrator.js';
import { eventLogCheckpointPath, readEventLogCheckpoint } from '../../lib/event-log-checkpoint.js';
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

const KEY = 'b'.repeat(64);

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-replay-batch-'));
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
  const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'), eventBridgeKey: KEY };
  return { root, ctx, config, backend };
}

async function teardown(f) { await f.backend.close(); fs.rmSync(f.root, { recursive: true, force: true }); }

function eventFor(id, type = 'measurement-completed', extra = {}) {
  return { schema: 1, eventId: `evolution:${type}:${id}`, eventType: type, experimentId: id,
    proposalId: `proposal:${id}`, target: 'plugin:batch', capability: 'plugin:batch', lineageId: 'plugin:batch',
    status: type === 'experiment-rejected' ? 'rejected' : 'measured', measurement: { latency: 1 },
    ...(type === 'failure-learned' ? { failureFingerprint: `fingerprint:${id}`, failure: { code: 'SYNTHETIC' } } : {}),
    ...extra, audit: { at: '2026-10-07T00:00:00.000Z' } };
}

const signed = (event, sequence, key = KEY) => signEventBridgeEnvelope(event, { key, sequence });
function append(f, event, sequence) {
  const envelope = signed(event, sequence);
  fs.appendFileSync(f.config.eventBridgePath, `${JSON.stringify(envelope)}\n`);
  return envelope;
}

/** Count the durable publications of the shared document, split by phase. */
function countPublications(f) {
  const counted = { commits: 0, closes: 0 };
  f.ctx.on('domain/changed', (change) => {
    if (change?.domain !== evolutionDomainSpec.name) return;
    if (change.value?.pending) counted.commits += 1;
    else counted.closes += 1;
  });
  return counted;
}

/** The committed durable document of the official JSON medium; an empty shape
 *  before the first write, so an absent document reads as "nothing committed". */
function committed(f) {
  const file = path.join(f.root, 'official', 'evolution_domain.json');
  if (!fs.existsSync(file)) return { applied: {}, pending: null, aggregate: { evolution: { eventBridge: { applied: [] } } } };
  return JSON.parse(fs.readFileSync(file, 'utf8')).global;
}
const appliedMarkers = (f) => committed(f).applied;
const bridgeApplied = (f) => committed(f).aggregate.evolution.eventBridge.applied;

test('a burst of records is committed by one transaction, in file order', async () => {
  const f = await fixture();
  const port = await openDomainStorage(f.ctx, f.config);
  try {
    const historical = append(f, eventFor('burst-0'), 1);
    assert.deepEqual(await port.flush(), { applied: 1, duplicates: 0 });
    // The checkpoint now covers that record, so the burst below is the only
    // per-record work the next pass does.
    assert.equal(readEventLogCheckpoint(eventLogCheckpointPath(f.root)).records, 1);

    const counted = countPublications(f);
    const burst = [append(f, eventFor('burst-1'), 2), append(f, eventFor('burst-2', 'trial-completed'), 3),
      append(f, eventFor('burst-3', 'experiment-rejected'), 4), append(f, eventFor('burst-4', 'failure-learned'), 5),
      append(f, eventFor('burst-5', 'canary-passed'), 6)];
    assert.deepEqual(await port.flush(), { applied: burst.length, duplicates: 1 });
    // One commit point and one close for the whole burst: the stage mirror, the
    // two whole-document writes, their fsyncs and the reload are paid once.
    assert.deepEqual(counted, { commits: 1, closes: 1 });
    // Every record is still individually authenticated and recorded, in order.
    const markers = appliedMarkers(f);
    assert.equal(markers[historical.event.eventId], historical.mac);
    for (const envelope of burst) assert.equal(markers[envelope.event.eventId], envelope.mac);
    const order = [historical.event.eventId, ...burst.map((envelope) => envelope.event.eventId)];
    assert.deepEqual(Object.keys(markers), order);
    assert.deepEqual(bridgeApplied(f).map((entry) => entry.eventId), order);
    // The whole burst is inside the checkpoint prefix afterwards: one pass.
    assert.equal(readEventLogCheckpoint(eventLogCheckpointPath(f.root)).records, 1 + burst.length);
    assert.deepEqual(await port.flush(), { applied: 0, duplicates: 1 + burst.length });
  } finally { await port.close(); await teardown(f); }
});

test('a repeated identity inside one burst is deduplicated or refused, never applied twice', async () => {
  const f = await fixture();
  const port = await openDomainStorage(f.ctx, f.config);
  try {
    // Same eventId, same MAC: the second record is the duplicate the per-record
    // path would have found in the marker map after the first commit.
    const first = signed(eventFor('repeat-a'), 1);
    fs.appendFileSync(f.config.eventBridgePath, `${JSON.stringify(first)}\n${JSON.stringify(first)}\n`);
    assert.deepEqual(await port.flush(), { applied: 1, duplicates: 1 });
    assert.deepEqual(bridgeApplied(f).map((entry) => entry.eventId), [first.event.eventId]);
    assert.deepEqual(await port.flush(), { applied: 0, duplicates: 2 });
  } finally { await port.close(); await teardown(f); }

  // Same eventId, different MAC: the group refuses it before publishing the
  // conflicting record, exactly like the per-record conflict refusal.
  const other = await fixture();
  const conflicted = await openDomainStorage(other.ctx, other.config);
  try {
    const stored = signed(eventFor('repeat-b'), 1);
    const conflicting = signEventBridgeEnvelope({ ...stored.event, status: 'forged' }, { key: KEY, sequence: 2 });
    fs.appendFileSync(other.config.eventBridgePath, `${JSON.stringify(stored)}\n${JSON.stringify(conflicting)}\n`);
    await assert.rejects(conflicted.flush(), /E_DOMAIN_EVENT_ID_CONFLICT/);
    // The record authenticated before the conflict stays durable; the conflicting
    // one is never applied and the checkpoint is not written.
    assert.deepEqual(Object.keys(appliedMarkers(other)), [stored.event.eventId]);
    assert.deepEqual(bridgeApplied(other).map((entry) => entry.eventId), [stored.event.eventId]);
    assert.equal(readEventLogCheckpoint(eventLogCheckpointPath(other.root)), null);
    await assert.rejects(conflicted.close(), /E_DOMAIN_EVENT_ID_CONFLICT/);
  } finally { await teardown(other); }
});

test('a refused record keeps the verified prefix durable and never advances the checkpoint', async () => {
  const f = await fixture();
  const valid = [signed(eventFor('prefix-0'), 1), signed(eventFor('prefix-1'), 2)];
  const stored = signed(eventFor('prefix-2'), 3);
  const forged = { ...stored, event: { ...stored.event, status: 'forged' } };
  const trailing = signed(eventFor('prefix-4'), 5);
  const lines = [...valid, stored, forged, trailing].map((envelope) => JSON.stringify(envelope));
  const port = await openDomainStorage(f.ctx, f.config);
  let closed = false;
  try {
    // Written after the port is open, so the burst is this explicit `flush()`.
    fs.writeFileSync(f.config.eventBridgePath, `${lines.join('\n')}\n`);
    await assert.rejects(port.flush(), /E_DOMAIN_EVENT_AUTH/);
    // The three records authenticated before the forged one are durable, exactly
    // as the per-record path committed each one before it read the next; the
    // forged record and everything after it are not applied, and the pass did not
    // bless the bytes it rejected.
    assert.deepEqual(Object.keys(appliedMarkers(f)), [...valid, stored].map((envelope) => envelope.event.eventId));
    assert.equal(readEventLogCheckpoint(eventLogCheckpointPath(f.root)), null);
    await assert.rejects(port.close(), /E_DOMAIN_EVENT_AUTH/);
    closed = true;
  } finally { if (!closed) await port.close().catch(() => {}); }

  // Repairing the bytes lets the next process finish the file: the records it
  // already committed are duplicates and nothing is applied twice.
  fs.writeFileSync(f.config.eventBridgePath, `${[...valid, stored, trailing].map((envelope) => JSON.stringify(envelope)).join('\n')}\n`);
  const reopened = await openDomainStorage(f.ctx, f.config);
  try {
    const order = [...valid, stored, trailing].map((envelope) => envelope.event.eventId);
    assert.deepEqual(Object.keys(appliedMarkers(f)), order);
    assert.deepEqual(bridgeApplied(f).map((entry) => entry.eventId), order);
    assert.deepEqual(await reopened.flush(), { applied: 0, duplicates: 4 });
  } finally { await reopened.close(); await teardown(f); }
});

test('a failure inside the group transaction publishes nothing and the retry applies each record once', async () => {
  const f = await fixture();
  const genuine = [signed(eventFor('fail-0'), 1), signed(eventFor('fail-1'), 2), signed(eventFor('fail-2'), 3)];
  // The last record is authentic and correctly signed but names an event type
  // the domain refuses, so it fails inside the group's `work()`.
  const poison = signed({ ...eventFor('fail-3'), eventType: 'unknown-type' }, 4);
  const port = await openDomainStorage(f.ctx, f.config);
  let closed = false;
  try {
    fs.writeFileSync(f.config.eventBridgePath, `${[...genuine, poison].map((envelope) => JSON.stringify(envelope)).join('\n')}\n`);
    await assert.rejects(port.flush(), /Unknown Evolution execution event type/);
    // Nothing of the group reached the durable document: the transaction aborted.
    assert.deepEqual(Object.keys(appliedMarkers(f)), []);
    assert.equal(committed(f).pending, null);
    assert.deepEqual(bridgeApplied(f), []);
    await assert.rejects(port.close(), /Unknown Evolution execution event type/);
    closed = true;
  } finally { if (!closed) await port.close().catch(() => {}); }

  // Dropping the refused record lets a new process apply the genuine ones once.
  fs.writeFileSync(f.config.eventBridgePath, `${genuine.map((envelope) => JSON.stringify(envelope)).join('\n')}\n`);
  const reopened = await openDomainStorage(f.ctx, f.config);
  try {
    const order = genuine.map((envelope) => envelope.event.eventId);
    assert.deepEqual(Object.keys(appliedMarkers(f)), order);
    assert.deepEqual(bridgeApplied(f).map((entry) => entry.eventId), order);
    assert.deepEqual(await reopened.flush(), { applied: 0, duplicates: 3 });
  } finally { await reopened.close(); await teardown(f); }
});

test('an interrupted group commit is recovered from its pending record exactly once', async () => {
  const f = await fixture();
  const envelopes = [signed(eventFor('crash-0'), 1), signed(eventFor('crash-1', 'trial-completed'), 2),
    signed(eventFor('crash-2', 'canary-passed'), 3)];
  const port = await openDomainStorage(f.ctx, f.config);
  const domain = f.ctx.storageDomain.get(evolutionDomainSpec.name);
  const set = domain.global.set;
  let closed = false;
  try {
    let injected = false;
    domain.global.set = async (value) => {
      // The commit point (the pending record) becomes durable; the closing write
      // that installs it is the one that fails.
      if (!injected && value.pending === null && Object.keys(value.applied).length) { injected = true; throw new Error('INJECTED_GROUP_FINAL_COMMIT'); }
      return set(value);
    };
    fs.writeFileSync(f.config.eventBridgePath, `${envelopes.map((envelope) => JSON.stringify(envelope)).join('\n')}\n`);
    await assert.rejects(port.flush(), /INJECTED_GROUP_FINAL_COMMIT/);
    assert.equal(injected, true);
    assert.ok(domain.global.get().pending, 'the interrupted group must stay recoverable');
    await assert.rejects(port.close(), /INJECTED_GROUP_FINAL_COMMIT/);
    closed = true;
  } finally {
    domain.global.set = set;
    if (!closed) await port.close().catch(() => {});
  }

  // The next process installs the pending record: every record of the group is
  // present exactly once and the replay has nothing left to apply.
  const restarted = await openDomainStorage(f.ctx, f.config);
  try {
    const order = envelopes.map((envelope) => envelope.event.eventId);
    assert.deepEqual(Object.keys(appliedMarkers(f)), order);
    assert.deepEqual(bridgeApplied(f).map((entry) => entry.eventId), order);
    assert.deepEqual(await restarted.flush(), { applied: 0, duplicates: 3 });
  } finally { await restarted.close(); await teardown(f); }
});

test('the state a burst commits matches one record per transaction', async () => {
  // The group only changes how many transactions carry the same records, so the
  // committed state must be identical: the same marker map, the same memory
  // ledger in file order, and the same aggregate. The clock and the generated
  // identifiers are frozen so two runs of one workload are byte-comparable.
  const RealDate = Date;
  const FROZEN = Date.parse('2026-10-12T00:00:00.000Z');
  class FrozenDate extends RealDate { constructor(...value) { if (value.length === 0) super(FROZEN); else super(...value); } static now() { return FROZEN; } }
  Object.setPrototypeOf(FrozenDate, RealDate);
  const originalUuid = crypto.randomUUID;
  globalThis.Date = FrozenDate;
  const events = [eventFor('same-0'), eventFor('same-1', 'trial-completed'), eventFor('same-2', 'promotion-succeeded')];
  // Every file the port commits, not a summary of it: the whole durable global
  // document (aggregate included, so a dropped experiment or knowledge row shows
  // up) plus a digest per archive file. Nothing is masked.
  const committedState = (f) => {
    const global = JSON.parse(fs.readFileSync(path.join(f.root, 'official', 'evolution_domain.json'), 'utf8')).global;
    const tree = {};
    const directory = path.join(f.root, 'dockyard');
    if (fs.existsSync(directory)) {
      for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true }).filter((item) => item.isFile())) {
        const file = path.join(entry.parentPath, entry.name);
        tree[path.relative(directory, file)] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      }
    }
    return { global, tree };
  };
  const run = async (oneAtATime) => {
    const f = await fixture();
    let counter = 0;
    crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
    // A throw from `flush()` or `close()` must fail this test, so nothing is
    // returned from `finally`: only the fixture cleanup is guaranteed.
    try {
      const port = await openDomainStorage(f.ctx, f.config);
      const envelopes = events.map((event, index) => signed(event, index + 1));
      for (let index = 0; index < envelopes.length; index += 1) {
        if (oneAtATime) {
          const upto = envelopes.slice(0, index + 1);
          fs.writeFileSync(f.config.eventBridgePath, `${upto.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
        } else if (index === 0) {
          fs.writeFileSync(f.config.eventBridgePath, `${envelopes.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
        }
        await port.flush();
      }
      await port.close();
      return committedState(f);
    } finally {
      await f.backend.close();
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  };
  try {
    const once = await run(false);
    const oneAtATime = await run(true);
    assert.equal(Object.keys(once.global.applied).length, 3);
    assert.deepEqual(once.global, oneAtATime.global, 'the grouped commit must produce the same durable document');
    assert.deepEqual(once.global.aggregate.evolution.eventBridge.applied.map((entry) => entry.eventId),
      events.map((event) => event.eventId));
    assert.deepEqual(once.tree, oneAtATime.tree, 'the grouped commit must install the same archive tree');
  } finally { crypto.randomUUID = originalUuid; globalThis.Date = RealDate; }
});
