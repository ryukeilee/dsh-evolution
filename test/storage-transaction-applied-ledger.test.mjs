/**
 * The applied-event ledger across a recovered pending transaction.
 *
 * `mutate()` used to read the ledger as a default parameter, which is evaluated
 * before its first `await installPending()`. A pending record therefore handed
 * its recovered eventId -> MAC markers to the domain, and the transaction that
 * followed immediately overwrote them with the pre-recovery snapshot. The next
 * replay then re-applied events whose marker it had just lost. Both cases below
 * were first reproduced against the unfixed implementation with a pending record
 * whose ledger carries a marker the live ledger does not, which is exactly the
 * state an interrupted replay leaves behind. Nothing here weakens the released
 * contract: an already-committed marker still has to survive and an ordinary
 * mutation still has to commit its own ledger.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDomainStorage } from '../lib/domain-storage.js';
import { EvolutionEventBridge } from '../lib/orchestrator.js';
// The official storage packages are dev dependencies of this repo, so the
// domain integration is exercised against the real official implementation.
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

const RECOVERED = 'recovered-event-1';
const RECOVERED_MAC = 'c'.repeat(64);

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-applied-ledger-'));
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'), eventBridgeKey: 'b'.repeat(64) };
  const bridge = new EvolutionEventBridge({ file: config.eventBridgePath, key: config.eventBridgeKey });
  return { root, ctx, config, backend, bridge, domain: () => ctx.storageDomain.get('evolution_domain') };
}

async function teardown(f) { await f.backend.close(); fs.rmSync(f.root, { recursive: true, force: true }); }

/**
 * Leave behind the record an interrupted replay would leave: the pending entry
 * names an empty staged change set and a ledger that already absorbed
 * `RECOVERED`, while the live ledger has not installed it yet.
 */
async function injectPending(f) {
  const global = f.domain().global.get();
  const stage = `stage-${randomUUID()}`;
  fs.mkdirSync(path.join(f.root, 'domain-staging', stage), { recursive: true, mode: 0o700 });
  await f.domain().global.set({
    schema: 1,
    aggregate: global.aggregate,
    applied: global.applied,
    pending: { stage, aggregate: global.aggregate, applied: { ...global.applied, [RECOVERED]: RECOVERED_MAC }, files: [] },
  });
  assert.equal(f.domain().global.get().applied[RECOVERED], undefined,
    'the injected pending must carry a marker the live ledger does not have yet');
}

test('P2-6: a mutation keeps the ledger markers a pending record recovered', async () => {
  const f = await fixture();
  const port = await openDomainStorage(f.ctx, f.config);
  try {
    await injectPending(f);
    await port.observe({ code: 'BENCH_ERROR', target: 'tool:ledger' });

    const global = f.domain().global.get();
    assert.equal(global.pending, null, 'the transaction that followed must commit the recovered pending');
    assert.equal(global.applied[RECOVERED], RECOVERED_MAC,
      'the recovered marker must survive the mutation that installed it');
    assert.deepEqual(fs.readdirSync(path.join(f.root, 'domain-staging')), [], 'the replayed stage is removed');
  } finally { await port.close(); }
  await teardown(f);
});

test('P2-6: the replay path keeps the recovered markers beside the marker it passes', async () => {
  const f = await fixture();
  const port = await openDomainStorage(f.ctx, f.config);
  try {
    await injectPending(f);
    f.bridge.emit('trial-completed', { id: 'exp-ledger', proposal: { target: 'plugin:ledger' } });
    await port.replay();
    const envelope = JSON.parse(fs.readFileSync(f.config.eventBridgePath, 'utf8').trim());
    const applied = f.domain().global.get().applied;
    assert.equal(applied[RECOVERED], RECOVERED_MAC,
      'the ledger the caller passes must be merged with the recovered ledger, not replace it');
    assert.equal(applied[String(envelope.event.eventId)], envelope.mac, 'the replayed event is still recorded');
  } finally { await port.close(); }
  await teardown(f);
});

test('P2-6: the recovered markers are still there after a restart', async () => {
  const f = await fixture();
  let port = await openDomainStorage(f.ctx, f.config);
  await injectPending(f);
  await port.observe({ code: 'BENCH_ERROR', target: 'tool:durable-ledger' });
  await port.close();
  port = await openDomainStorage(f.ctx, f.config);
  try {
    assert.equal(f.domain().global.get().applied[RECOVERED], RECOVERED_MAC,
      'a later replay must still see the marker as committed');
    assert.deepEqual(await port.replay(), { applied: 0, duplicates: 0 });
  } finally { await port.close(); }
  await teardown(f);
});
