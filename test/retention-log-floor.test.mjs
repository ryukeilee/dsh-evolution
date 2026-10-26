/**
 * Marker pruning and the event-log floor.
 *
 * Two blockers this pins, both measured in `docs/performance/retention-reclaim-blockers.md`:
 *
 *   R2 - the replay checkpoint stored a digest of the *whole* marker map, so
 *        removing one marker (the only way to bound the map) invalidated the
 *        digest and turned the entire consumed prefix back into per-record work.
 *   R3 - discarding the absorbed prefix of the event log deleted the only rows
 *        that carried an older promotion's gate evidence and durable metadata.
 *
 * The fix keeps the integrity check and makes both removals provable: the pruned
 * markers are committed to by a keyed chain in a durable retention floor, the
 * discarded log bytes by the retained tail's digest, and the facts those rows
 * carried are externalized to the evidence sidecar the hydration chain already
 * prefers over the bridge. Every test below therefore asserts *both* halves:
 * a legitimate reclaim stays trusted and keeps its evidence, and an unrecorded
 * change is still refused.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evolutionDomainSpec, openDomainStorage } from '../lib/domain-storage.js';
import { eventLogCheckpointPath, planEventLogReplay, planLogPrune, readEventLogCheckpoint } from '../lib/event-log-checkpoint.js';
import { EvolutionEventBridge, externalizeEventBridgeEvidence, readEventBridgeEvidence,
  readEvidenceSnapshot, signEventBridgeEnvelope, withEventBridgeAppendLock } from '../lib/orchestrator.js';
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

const KEY = 'b'.repeat(64);
const WRITER = 'dsh-evolution-orchestrator';
const AT = '2026-10-26T00:00:00.000Z';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-log-'));
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
  t.after(async () => { await backend.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, ctx, config, backend };
}

function event(id, index, type = 'measurement-completed', extra = {}) {
  return {
    schema: 1,
    eventId: `evolution:${type}:${id}`,
    eventType: type,
    experimentId: id,
    proposalId: id,
    target: 'fixture-target',
    capability: 'fixture-target',
    lineageId: 'fixture-target',
    status: 'measured',
    measurement: { latencyMs: 10 + index },
    promotion: null,
    canary: null,
    evidence: {},
    audit: { producer: WRITER, at: AT },
    ...extra,
  };
}

/** Write `count` measurement rows and return their event ids in file order. */
function writeMeasurements(config, count, prefix = 'exp') {
  const bridge = new EvolutionEventBridge({ file: config.eventBridgePath, key: KEY });
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    const payload = event(`${prefix}-${String(index).padStart(4, '0')}`, index);
    bridge.emit('measurement-completed', {}, payload);
    ids.push(payload.eventId);
  }
  return ids;
}

async function openPort(f, extra = {}) {
  return openDomainStorage(f.ctx, {
    ...f.config,
    ...extra,
    externalizeEventEvidence: entries => externalizeEventBridgeEvidence({ archiveDir: f.config.archiveDir }, entries),
  });
}

const ledger = (f) => f.ctx.storageDomain.get('evolution_domain').global.get();
const logBytes = file => fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);

test('a confirmed reclaim prunes discarded markers and keeps the consumed prefix trusted', async (t) => {
  const f = await fixture(t);
  const port = await openPort(f);
  try {
    const ids = writeMeasurements(f.config, 200);
    assert.deepEqual(await port.flush(), { applied: 200, duplicates: 0 });
    assert.equal(Object.keys(ledger(f).applied).length, 200);

    // Without the confirmation the destructive path refuses outright.
    await assert.rejects(() => port.reclaim({ archives: false }), /E_DOMAIN_RECLAIM_CONFIRMATION/);
    assert.equal(Object.keys(ledger(f).applied).length, 200);

    const before = logBytes(f.config.eventBridgePath);
    const report = await port.reclaim({ confirmation: true, archives: false, log: true, retainRecords: 1 });
    assert.equal(report.log.status, 'discarded');
    assert.equal(report.log.discardedRecords, 199);
    assert.equal(report.log.prunedMarkers, 199);
    const after = ledger(f);
    assert.equal(Object.keys(after.applied).length, 1, 'only the retained record keeps a marker');
    assert.equal(after.retention.markers.pruned, 199);
    assert.equal(after.retention.log.bytes, report.log.discardedBytes);
    // The doctor validates the committed global with this same schema, so a
    // document a reclaim wrote must still be a valid one.
    assert.equal(evolutionDomainSpec.global.schema.safeParse(after).success, true);
    const kept = logBytes(f.config.eventBridgePath);
    assert.ok(kept.length < before.length, 'the log actually shrank');
    assert.equal(kept.length, after.retention.log.tail.bytes);
    assert.equal(crypto.createHmac('sha256', KEY).update(kept).digest('hex'), after.retention.log.tail.digest,
      'the floor records the digest of exactly the bytes that remain');

    // R2: the consumed prefix is still trusted, so a later pass does no
    // per-record work for it. This is the assertion the released implementation
    // cannot satisfy: pruning a marker there invalidated the whole digest.
    const checkpoint = readEventLogCheckpoint(eventLogCheckpointPath(f.root));
    assert.ok(checkpoint, 'the reclaim publishes a checkpoint for the log it wrote');
    const plan = planEventLogReplay({ file: f.config.eventBridgePath, key: KEY, writer: WRITER,
      checkpoint, applied: after.applied, retention: after.retention });
    assert.equal(plan.trusted, true);
    assert.equal(plan.prefixRecords, 1);
    assert.equal(plan.completeRecords, 0);
    assert.deepEqual(await port.flush(), { applied: 0, duplicates: 1 });

    // A retained marker that disappears without a floor covering it is still a
    // rollback: the checkpoint must not be trusted any more.
    assert.equal(planEventLogReplay({ file: f.config.eventBridgePath, key: KEY, writer: WRITER,
      checkpoint, applied: {}, retention: after.retention }).trusted, false);

    // Nor can the floor be edited to hide a marker loss: the chain is keyed.
    const forged = { ...after.retention, markers: { ...after.retention.markers, pruned: 200 } };
    assert.equal(planEventLogReplay({ file: f.config.eventBridgePath, key: KEY, writer: WRITER,
      checkpoint, applied: {}, retention: forged }).trusted, false);
    assert.equal(ids.length, 200);
  } finally { await port.close().catch(() => {}); }
});

test('a discarded prefix externalizes its promotion evidence before the log shrinks', async (t) => {
  const f = await fixture(t);
  const port = await openPort(f);
  try {
    const bridge = new EvolutionEventBridge({ file: f.config.eventBridgePath, key: KEY });
    bridge.emit('measurement-completed', {}, event('exp-promoted', 1));
    bridge.emit('promotion-succeeded', {}, event('exp-promoted', 2, 'promotion-succeeded', {
      status: 'promoted',
      evidence: { runtimeRecovered: true, testsPassed: true, goalPassed: true },
      promotion: { id: 'promotion-1', rowId: 'row-1', pluginName: 'fixture-plugin', promotionTimestamp: '2026-10-26T00:00:02.000Z', healthObservationWindow: 2 },
    }));
    bridge.emit('canary-passed', {}, event('exp-promoted', 3, 'canary-passed', {
      status: 'stable',
      canary: { promotionTimestamp: '2026-10-26T00:00:02.000Z', healthObservationWindow: 2, startupVerified: true,
        observations: [{ healthy: true, at: '2026-10-26T00:00:03.000Z' }] },
    }));
    assert.deepEqual(await port.flush(), { applied: 3, duplicates: 0 });
    const before = await readEventBridgeEvidence(f.config.eventBridgePath, 'exp-promoted', { key: KEY, trustedWriters: [WRITER] });
    assert.equal(before.gateEvidence.runtimeRecovered, true);

    const report = await port.reclaim({ confirmation: true, archives: false, log: true, retainRecords: 1 });
    assert.equal(report.log.discardedRecords, 2);
    assert.ok(report.log.evidenceEntries > 0, 'the discarded prefix carries evidence that had to be externalized');
    assert.equal(report.log.evidence.written >= 1, true, 'the externalizer wrote a durable sidecar');

    // The bridge no longer holds the promotion row...
    const fromBridge = await readEventBridgeEvidence(f.config.eventBridgePath, 'exp-promoted', { key: KEY, trustedWriters: [WRITER] });
    assert.equal(fromBridge?.gateEvidence ?? null, null, 'the truncated log no longer carries the gate evidence');
    // ...but the durable sidecar the hydration chain reads first does.
    const sidecar = await readEvidenceSnapshot(f.config.archiveDir, 'exp-promoted');
    assert.ok(sidecar, 'the evidence was written to its durable home before the bytes were discarded');
    assert.equal(sidecar.gateEvidence.runtimeRecovered, true);
    assert.equal(sidecar.runtimeRecovered, true);
    assert.equal(sidecar.durable.pluginName, 'fixture-plugin');
    assert.equal(sidecar.promotionTimestamp, '2026-10-26T00:00:02.000Z');

    // Replaying the truncated log re-applies nothing.
    assert.deepEqual(await port.flush(), { applied: 0, duplicates: 1 });
  } finally { await port.close().catch(() => {}); }
});

test('a reclaim without a durable evidence home, or with a failing one, discards nothing', async (t) => {
  const f = await fixture(t);
  const bare = await openDomainStorage(f.ctx, { ...f.config });
  try {
    const bridge = new EvolutionEventBridge({ file: f.config.eventBridgePath, key: KEY });
    bridge.emit('measurement-completed', {}, event('exp-bare', 1));
    bridge.emit('promotion-succeeded', {}, event('exp-bare', 2, 'promotion-succeeded', {
      evidence: { runtimeRecovered: true },
      promotion: { id: 'promotion-bare', promotionTimestamp: '2026-10-26T00:00:02.000Z' },
    }));
    assert.deepEqual(await bare.flush(), { applied: 2, duplicates: 0 });
    const before = logBytes(f.config.eventBridgePath);
    await assert.rejects(() => bare.reclaim({ confirmation: true, archives: false, log: true, retainRecords: 1 }),
      /E_DOMAIN_EVIDENCE_EXTERNALIZER_REQUIRED/);
    assert.deepEqual(logBytes(f.config.eventBridgePath), before, 'a refusal leaves the log byte-identical');
    assert.equal(Object.keys(ledger(f).applied).length, 2);
    assert.equal(ledger(f).retention, undefined, 'nothing was committed');
  } finally { await bare.close().catch(() => {}); }

  const failing = await openDomainStorage(f.ctx, { ...f.config, externalizeEventEvidence: async () => { throw new Error('sidecar unavailable'); } });
  try {
    const before = logBytes(f.config.eventBridgePath);
    await assert.rejects(() => failing.reclaim({ confirmation: true, archives: false, log: true, retainRecords: 1 }), /sidecar unavailable/);
    assert.deepEqual(logBytes(f.config.eventBridgePath), before);
    assert.equal(Object.keys(ledger(f).applied).length, 2);
  } finally { await failing.close().catch(() => {}); }
});

test('a log that is not the floor continuation is refused instead of re-absorbed', async (t) => {
  const f = await fixture(t);
  const port = await openPort(f);
  try {
    writeMeasurements(f.config, 50);
    assert.deepEqual(await port.flush(), { applied: 50, duplicates: 0 });
    await port.reclaim({ confirmation: true, archives: false, log: true, retainRecords: 1 });
    assert.ok(ledger(f).retention?.log);

    // A different file at the log path: the retained tail is not its head, so the
    // records it holds cannot be proven to be new.
    const foreign = signEventBridgeEnvelope(event('exp-foreign', 0), { key: KEY, sequence: 1 });
    fs.writeFileSync(f.config.eventBridgePath, `${JSON.stringify(foreign)}\n`);
    // Drop the checkpoint so the full-verification path (the one that consults the
    // floor) is exercised.
    fs.rmSync(eventLogCheckpointPath(f.root), { force: true });
    await assert.rejects(() => port.flush(), /E_DOMAIN_EVENT_LOG_FLOOR_MISMATCH/);
    assert.equal(Object.keys(ledger(f).applied).length, 1, 'the refused pass committed nothing');
    // An empty log does not prove the retained bytes were not lost, so it is a
    // refusal too (see the dedicated case below).
    fs.writeFileSync(f.config.eventBridgePath, '');
    await assert.rejects(() => port.flush(), /E_DOMAIN_EVENT_LOG_FLOOR_MISMATCH/);
  } finally { await port.close().catch(() => {}); }
});

test('a committed floor whose truncation never ran is completed by the next replay', async (t) => {
  const f = await fixture(t);
  let port = await openPort(f);
  try {
    writeMeasurements(f.config, 20);
    assert.deepEqual(await port.flush(), { applied: 20, duplicates: 0 });
    // The first reclaim establishes a floor; the second one is the case that a
    // per-round digest could not describe (the retained tail moves).
    await port.reclaim({ confirmation: true, archives: false, log: true, retainRecords: 2 });
    writeMeasurements(f.config, 5, 'later');
    assert.deepEqual(await port.flush(), { applied: 5, duplicates: 2 });
    const priorBytes = logBytes(f.config.eventBridgePath);
    const markersBefore = Object.keys(ledger(f).applied).length;
    const report = await port.reclaim({ confirmation: true, archives: false, log: true, retainRecords: 2 });
    assert.equal(report.log.status, 'discarded');
    assert.equal(report.log.truncated, 'truncated');
    const truncatedBytes = logBytes(f.config.eventBridgePath);
    assert.ok(truncatedBytes.length < priorBytes.length);
    assert.equal(report.log.discardedRecords, 5);
    assert.equal(report.log.prunedMarkers, 5);

    // The crash window: the floor is committed, the log still holds every byte
    // the plan was computed from. Restoring those exact bytes is that state.
    fs.writeFileSync(f.config.eventBridgePath, priorBytes);
    assert.deepEqual(await port.flush(), { applied: 0, duplicates: 2 },
      'the committed truncation is completed, and only the retained records remain');
    assert.deepEqual(logBytes(f.config.eventBridgePath), truncatedBytes, 'the log is back to the retained tail');
    assert.equal(Object.keys(ledger(f).applied).length, markersBefore - 5);

    // The same state across a restart: a fresh facility must open (a permanent
    // refusal here would make the plugin unreachable, including this tool).
    fs.writeFileSync(f.config.eventBridgePath, priorBytes);
    await port.close();
    port = null;
    f.ctx.storageDomain = new (f.ctx.storageDomain.constructor)(f.ctx, { backend: 'json' });
    const reopened = await openPort(f);
    try {
      assert.deepEqual(logBytes(f.config.eventBridgePath), truncatedBytes, 'opening the store completes the committed truncation');
      assert.deepEqual(await reopened.flush(), { applied: 0, duplicates: 2 });
    } finally { await reopened.close().catch(() => {}); }
  } finally { if (port) await port.close().catch(() => {}); }
});

test('the discard boundary is found on bytes, so a torn or invalid tail is retained exactly', async (t) => {
  const f = await fixture(t);
  const port = await openPort(f);
  try {
    writeMeasurements(f.config, 3);
    assert.deepEqual(await port.flush(), { applied: 3, duplicates: 0 });
    // A line the JSON writer would never produce: invalid UTF-8 is decoded to a
    // different number of code units, so a text-derived offset would split it.
    const damaged = Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a]);
    fs.appendFileSync(f.config.eventBridgePath, damaged);
    const buffer = logBytes(f.config.eventBridgePath);
    const plan = planLogPrune({ buffer, key: KEY, writer: WRITER, applied: ledger(f).applied, retainRecords: 1 });
    assert.equal(plan.boundaryRecords, 3);
    assert.deepEqual(buffer.subarray(plan.prefixBytes), damaged, 'the damaged line is retained byte for byte');
    assert.equal(plan.prefixBytes, buffer.length - damaged.length);
    assert.equal(plan.tail.bytes, damaged.length);
    assert.equal(plan.tail.digest, crypto.createHmac('sha256', KEY).update(damaged).digest('hex'));
    // The damaged bytes are not a record, and replay refuses an unparseable
    // *complete* line rather than skipping bytes (the released behaviour). What
    // matters here is that the truncation kept them byte for byte, so the evidence
    // of the damage is still on disk.
    await assert.rejects(() => port.flush(), /Expected property name/);
  } finally { await port.close().catch(() => {}); }
});

test('a record whose committed MAC differs stops the discard boundary', async (t) => {
  const f = await fixture(t);
  const port = await openPort(f);
  try {
    writeMeasurements(f.config, 3);
    assert.deepEqual(await port.flush(), { applied: 3, duplicates: 0 });
    const applied = { ...ledger(f).applied };
    const first = Object.keys(applied)[0];
    applied[first] = 'f'.repeat(64);
    const buffer = logBytes(f.config.eventBridgePath);
    const plan = planLogPrune({ buffer, key: KEY, writer: WRITER, applied, retainRecords: 1 });
    assert.equal(plan, null, 'no prefix is provably absorbed once the first MAC disagrees');
    const report = await port.reclaim({ confirmation: true, archives: false, log: true, retainRecords: 1 });
    assert.equal(report.log.status, 'discarded', 'the committed ledger still authorizes the real discard');
    assert.equal(report.log.prunedMarkers, 2);
  } finally { await port.close().catch(() => {}); }
});

test('evidence whose identity is not a safe file name is refused, not written', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    () => externalizeEventBridgeEvidence({ archiveDir: f.config.archiveDir },
      [{ experimentId: '../escape', evidence: { version: 1, source: 'event-bridge', observations: [] } }]),
    /E_DOMAIN_EVIDENCE_ID_UNSAFE/,
  );
  assert.equal(fs.existsSync(path.join(f.root, 'escape.evidence.json')), false);
  assert.equal(fs.existsSync(f.config.archiveDir) && fs.readdirSync(f.config.archiveDir).length > 0, false,
    'no partial evidence was written for the refused prefix');
});

test('a pruned identity is no longer a replay conflict: the record is applied again', async (t) => {
  const f = await fixture(t);
  const port = await openPort(f);
  try {
    writeMeasurements(f.config, 4);
    assert.deepEqual(await port.flush(), { applied: 4, duplicates: 0 });
    await port.reclaim({ confirmation: true, archives: false, log: true, retainRecords: 1 });
    const prunedId = 'evolution:measurement-completed:exp-0000';
    assert.equal(Object.hasOwn(ledger(f).applied, prunedId), false, 'the prefix record lost its marker');
    // The same event identity re-emitted after the prune carries a new sequence
    // (a new MAC). The marker that used to make that a refusal is gone with the
    // record, so the documented boundary is "applied again", not a conflict.
    const bridge = new EvolutionEventBridge({ file: f.config.eventBridgePath, key: KEY });
    bridge.emit('measurement-completed', {}, event('exp-0000', 0, 'measurement-completed', { measurement: { latencyMs: 99 } }));
    // The domain ledger absorbs the identity again under its new MAC. The
    // in-memory marker window (`#bridgeApplied`, last 4096 ids) still recognizes
    // the id, so the record's *effects* are not re-applied and the pass reports it
    // as a duplicate. Either way there is no conflict: that is the boundary a
    // pruned marker leaves behind, and it is recorded here instead of being
    // implied by the old fail-closed behaviour.
    assert.deepEqual(await port.flush(), { applied: 0, duplicates: 2 });
    assert.equal(typeof ledger(f).applied[prunedId], 'string', 'the identity is absorbed again under its new MAC');
  } finally { await port.close().catch(() => {}); }
});

test('a second reclaim accumulates the pruned markers and their chain', async (t) => {
  const f = await fixture(t);
  const port = await openPort(f);
  try {
    writeMeasurements(f.config, 30);
    assert.deepEqual(await port.flush(), { applied: 30, duplicates: 0 });
    const first = await port.reclaim({ confirmation: true, archives: false, log: true, retainRecords: 3 });
    const afterFirst = ledger(f).retention;
    assert.equal(afterFirst.markers.pruned, first.log.prunedMarkers);
    const chainAfterFirst = afterFirst.markers.chain;
    assert.equal(afterFirst.log.records, first.log.discardedRecords);

    writeMeasurements(f.config, 4, 'later');
    assert.deepEqual(await port.flush(), { applied: 4, duplicates: 3 });
    const second = await port.reclaim({ confirmation: true, archives: false, log: true, retainRecords: 3 });
    const afterSecond = ledger(f).retention;
    assert.equal(afterSecond.markers.pruned, afterFirst.markers.pruned + second.log.prunedMarkers,
      'the floor keeps promising every marker it ever pruned, not just the last round');
    assert.equal(afterSecond.log.records, afterFirst.log.records + second.log.discardedRecords,
      'the discarded record count is cumulative');
    assert.notEqual(afterSecond.markers.chain, chainAfterFirst, 'the chain moved with the new prune');
    assert.equal(afterSecond.log.bytes, afterFirst.log.bytes + second.log.discardedBytes);
    assert.equal(evolutionDomainSpec.global.schema.safeParse(ledger(f)).success, true);
  } finally { await port.close().catch(() => {}); }
});

test('a log that is not the floor continuation is refused, including a deleted one', async (t) => {
  const f = await fixture(t);
  const port = await openPort(f);
  try {
    writeMeasurements(f.config, 6);
    assert.deepEqual(await port.flush(), { applied: 6, duplicates: 0 });
    const staleLog = logBytes(f.config.eventBridgePath);
    await port.reclaim({ confirmation: true, archives: false, log: true, retainRecords: 2 });
    const keptLog = logBytes(f.config.eventBridgePath);
    assert.deepEqual(await port.flush(), { applied: 0, duplicates: 2 });

    // Restoring the *exact* bytes the plan was computed from is the crash window
    // the floor already describes, so a pass completes the committed truncation
    // instead of refusing: nothing is re-applied, and the log is back to the tail.
    fs.writeFileSync(f.config.eventBridgePath, staleLog);
    assert.deepEqual(await port.flush(), { applied: 0, duplicates: 2 });
    assert.deepEqual(logBytes(f.config.eventBridgePath), keptLog, 'the committed truncation was completed');

    // A file that is neither that prior file nor its retained tail is refused: it
    // may hold records whose markers were pruned, and nothing can prove it does
    // not. A single changed byte is enough to leave the provable set.
    const altered = Buffer.from(staleLog);
    altered[0] = altered[0] === 0x7b ? 0x20 : 0x7b;
    fs.writeFileSync(f.config.eventBridgePath, altered);
    await assert.rejects(() => port.flush(), /E_DOMAIN_EVENT_LOG_FLOOR_MISMATCH/);

    // Deleting the log is refused too. The empty file carries no record, but it
    // also does not prove the retained bytes were not lost, and the next append
    // would then create a head that can never match the floor. Failing here keeps
    // the state visible instead of accepting one pass and refusing the next.
    fs.writeFileSync(f.config.eventBridgePath, '');
    await assert.rejects(() => port.flush(), /E_DOMAIN_EVENT_LOG_FLOOR_MISMATCH/);

    // Restoring the retained bytes (the floor records their digest) is the remedy.
    fs.writeFileSync(f.config.eventBridgePath, keptLog);
    assert.deepEqual(await port.flush(), { applied: 0, duplicates: 2 });
  } finally { await port.close().catch(() => {}); }
});

test('a deferred truncation completes later and keeps the records appended meanwhile', async (t) => {
  const f = await fixture(t);
  const port = await openPort(f);
  const lockPath = `${f.config.eventBridgePath}.append.lock`;
  try {
    writeMeasurements(f.config, 10);
    assert.deepEqual(await port.flush(), { applied: 10, duplicates: 0 });
    const before = fs.statSync(f.config.eventBridgePath).size;
    fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(lockPath, 'owner'), JSON.stringify({ token: 'held-by-this-test', pid: process.pid,
      hostname: os.hostname(), acquiredAt: Date.now() }), { mode: 0o600 });
    const report = await port.reclaim({ confirmation: true, archives: false, log: true, retainRecords: 2 });
    assert.equal(report.log.truncated, 'deferred');
    fs.rmSync(lockPath, { recursive: true, force: true });

    // A record appended while the truncation is still pending must survive it: the
    // floor's claim covers the kept tail only, and the completion copies the rest
    // verbatim.
    writeMeasurements(f.config, 2, 'after');
    const flushed = await port.flush();
    assert.equal(flushed.applied, 2, 'the appended records are absorbed, not refused');
    const size = fs.statSync(f.config.eventBridgePath).size;
    assert.ok(size < before, `the deferred truncation ran: ${size} < ${before}`);
    const floorTail = ledger(f).retention.log.tail;
    assert.equal(crypto.createHmac('sha256', KEY).update(logBytes(f.config.eventBridgePath).subarray(0, floorTail.bytes)).digest('hex'),
      floorTail.digest, 'the file still begins with exactly the bytes the floor retained');
    // The retained records and the two appended ones are all in the log now.
    assert.deepEqual(await port.flush(), { applied: 0, duplicates: 4 });
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
    await port.close().catch(() => {});
  }
});

test('a floor without its log is refused rather than treated as an empty one', async (t) => {
  const f = await fixture(t);
  const port = await openPort(f);
  try {
    writeMeasurements(f.config, 5);
    assert.deepEqual(await port.flush(), { applied: 5, duplicates: 0 });
    await port.reclaim({ confirmation: true, archives: false, log: true, retainRecords: 2 });
    const keptLog = logBytes(f.config.eventBridgePath);
    fs.rmSync(f.config.eventBridgePath);
    await assert.rejects(() => port.flush(), /E_DOMAIN_EVENT_LOG_FLOOR_MISMATCH/);
    // Restoring the retained bytes is the remedy, exactly as for an empty file.
    fs.writeFileSync(f.config.eventBridgePath, keptLog);
    assert.deepEqual(await port.flush(), { applied: 0, duplicates: 2 });
  } finally { await port.close().catch(() => {}); }
});
