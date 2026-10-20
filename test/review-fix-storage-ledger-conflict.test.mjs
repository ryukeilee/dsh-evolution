/**
 * The caller's ledger may extend the recovered one, but it may never disagree
 * with it about an event that is already committed.
 *
 * An interrupted replay leaves the committed markers inside the pending record
 * while the live ledger has not installed them yet, and a caller that passes its
 * own ledger (`replay()` adds the event it just verified) is merged onto the
 * recovered one. That merge used to be a plain spread, so the caller's marker
 * won: the live ledger held no marker for the event (it had not been installed
 * yet), the log carried a *different*, correctly signed envelope for the same
 * eventId, and the mutated ledger the transaction committed held the second MAC
 * while the first was silently dropped. The one check that rejects exactly this
 * - `E_DOMAIN_EVENT_ID_CONFLICT` in the replay path - never saw it, because the
 * marker it compares against was installed one step later.
 *
 * The first case is that sequence and was reproduced against the unfixed
 * implementation: the replay reported `{applied: 0, duplicates: 1}`, threw
 * nothing, and left the second MAC in the ledger. The two cases after it are the
 * positive contracts the conflict detection must not break: a caller ledger that
 * extends the recovered one still merges, a pure recovery with no caller ledger
 * behaves as before, and the markers are still there after a restart.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDomainStorage } from '../lib/domain-storage.js';
import { EvolutionEventBridge, signEventBridgeEnvelope } from '../lib/orchestrator.js';
// The official storage packages are dev dependencies of this repo, so the
// domain integration is exercised against the real official implementation.
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

const RECOVERED = 'recovered-event-1';
const RECOVERED_MAC = 'c'.repeat(64);

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-fix-ledger-conflict-'));
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'), eventBridgeKey: 'b'.repeat(64) };
  const bridge = new EvolutionEventBridge({ file: config.eventBridgePath, key: config.eventBridgeKey });
  return { root, ctx, config, backend, bridge, domain: () => ctx.storageDomain.get('evolution_domain') };
}

async function teardown(f) { await f.backend.close(); fs.rmSync(f.root, { recursive: true, force: true }); }

/**
 * The durable state an interrupted replay leaves: the pending record carries the
 * markers that were committed with it, while the live ledger - the document the
 * pending record replaces - does not hold them yet.
 */
async function injectPending(f, live, recovered = { ...live.applied, [RECOVERED]: RECOVERED_MAC }) {
  const stage = `stage-${randomUUID()}`;
  fs.mkdirSync(path.join(f.root, 'domain-staging', stage), { recursive: true, mode: 0o700 });
  await f.domain().global.set({
    schema: 1,
    aggregate: live.aggregate,
    applied: live.applied,
    pending: { stage, aggregate: live.aggregate, applied: recovered, files: [] },
  });
  for (const eventId of Object.keys(recovered)) {
    assert.equal(f.domain().global.get().applied[eventId], undefined,
      'the injected pending must carry a marker the live ledger does not have yet');
  }
}

test('R6: a caller ledger that disagrees with a recovered marker is rejected, not merged', async () => {
  const f = await fixture();
  const port = await openDomainStorage(f.ctx, f.config);
  try {
    // A committed event, and the durable state an interrupted replay leaves: the
    // live ledger is the pre-replay document, the pending record holds the
    // marker that was committed with it.
    const beforeFirstReplay = structuredClone(f.domain().global.get());
    f.bridge.emit('trial-completed', { id: 'exp-conflict', proposal: { target: 'plugin:review' } }, { status: 'trial-A' });
    const first = JSON.parse(fs.readFileSync(f.config.eventBridgePath, 'utf8'));
    assert.deepEqual(await port.replay(), { applied: 1, duplicates: 0 });
    const committed = structuredClone(f.domain().global.get());
    assert.equal(committed.applied[first.event.eventId], first.mac);
    // The interrupted replay: the marker committed with that event is only in
    // the pending record, so the replay path cannot see it before it installs.
    await injectPending(f, beforeFirstReplay, committed.applied);

    // The log now carries a different, correctly signed envelope for the same
    // eventId: the recovered marker and this envelope cannot both be true.
    const second = signEventBridgeEnvelope({ ...first.event, status: 'DIFFERENT-CONTENT-SAME-ID' },
      { key: f.config.eventBridgeKey, writer: first.writer, sequence: first.sequence + 1 });
    assert.equal(second.event.eventId, first.event.eventId, 'the conflict is about one eventId');
    assert.notEqual(second.mac, first.mac, 'the two envelopes carry different MACs');
    fs.writeFileSync(f.config.eventBridgePath, JSON.stringify(second) + '\n');

    await assert.rejects(port.replay(), /E_DOMAIN_EVENT_ID_CONFLICT/);

    const after = f.domain().global.get();
    assert.equal(after.pending, null, 'the rejected replay must not commit a pending record');
    assert.equal(after.applied[first.event.eventId], first.mac,
      'the recovered marker must not be overwritten by the conflicting MAC');
    assert.notEqual(after.applied[first.event.eventId], second.mac);
    // The port keeps the failure and re-raises it once, when it is closed.
    await assert.rejects(port.close(), /E_DOMAIN_EVENT_ID_CONFLICT/);
  } finally { await teardown(f); }
});

test('R6: a caller ledger that extends the recovered one still merges, and survives a restart', async () => {
  const f = await fixture();
  let port = await openDomainStorage(f.ctx, f.config);
  try {
    await injectPending(f, structuredClone(f.domain().global.get()));
    // A new event with no marker anywhere: the caller's ledger is the recovered
    // ledger plus this marker, which is the merge that has to keep working.
    f.bridge.emit('trial-completed', { id: 'exp-extends', proposal: { target: 'plugin:extends' } });
    const envelope = JSON.parse(fs.readFileSync(f.config.eventBridgePath, 'utf8').trim());
    assert.deepEqual(await port.replay(), { applied: 1, duplicates: 0 });

    const applied = f.domain().global.get().applied;
    assert.equal(applied[RECOVERED], RECOVERED_MAC, 'the recovered marker survives the merge');
    assert.equal(applied[String(envelope.event.eventId)], envelope.mac, 'the replayed event is recorded');
  } finally { await port.close(); }

  port = await openDomainStorage(f.ctx, f.config);
  try {
    const applied = f.domain().global.get().applied;
    assert.equal(applied[RECOVERED], RECOVERED_MAC, 'the marker is still committed after a restart');
    assert.deepEqual(await port.replay(), { applied: 0, duplicates: 1 },
      'the ledger stays monotonic: the replayed event is still known');
  } finally { await port.close(); }
  await teardown(f);
});

test('R6: a pure recovery with no caller ledger keeps the recovered markers', async () => {
  const f = await fixture();
  const port = await openDomainStorage(f.ctx, f.config);
  try {
    await injectPending(f, structuredClone(f.domain().global.get()));
    await port.observe({ code: 'BENCH_ERROR', target: 'tool:ledger-conflict' });
    const global = f.domain().global.get();
    assert.equal(global.pending, null, 'the mutation that followed commits the recovered pending');
    assert.equal(global.applied[RECOVERED], RECOVERED_MAC, 'no caller ledger means no merge and no change');
    assert.deepEqual(fs.readdirSync(path.join(f.root, 'domain-staging')), [], 'the replayed stage is removed');
  } finally { await port.close(); }
  await teardown(f);
});
