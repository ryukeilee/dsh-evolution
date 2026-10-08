import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDomainStorage, projectObservation, evolutionDomainSpec } from '../../lib/domain-storage.js';
import { EvolutionEventBridge, signEventBridgeEnvelope } from '../../lib/orchestrator.js';
import { EvolutionMemory } from '../../lib/dockyard-domain/memory.js';
// Official storage packages are dev dependencies of this repo, so the domain
// integration is exercised against the real official implementation.
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-domain-'));
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'), eventBridgeKey: 'b'.repeat(64) };
  return { root, ctx, config, backend, bridge: new EvolutionEventBridge({ file: config.eventBridgePath, key: config.eventBridgeKey }) };
}
test('metadata queries match the previous window path without cloning payloads', async () => {
  const f = await fixture();
  const collections = ['cycles', 'observations', 'proposals', 'experiments', 'promotions', 'outcomes', 'lineage', 'knowledge'];
  const root = path.join(f.root, 'dockyard');
  fs.mkdirSync(root);
  const records = [
    { id: 'valid:1', status: 'observed', eventType: 'safe/type', recordedAt: '2026-08-26T00:00:00Z' },
    { id: '<unsafe>', status: 'bad value', eventType: 'x'.repeat(161), recordedAt: 'invalid' },
    { status: null, recordedAt: ['2026-08-26T00:00:00Z'] },
    { id: 'valid:1', status: 'updated', recordedAt: '2026-08-25T00:00:00Z' },
    { id: 'deleted', __evolutionTombstone: 1 },
  ].map(row => ({ ...row, evidence: { payload: 'x'.repeat(1024 * 1024) } }));
  for (const collection of collections) fs.writeFileSync(path.join(root, `state.json.${collection}-archive.jsonl`), records.map(row => JSON.stringify(row)).join('\n') + '\n{"torn":');
  let port;
  const originalWindow = EvolutionMemory.prototype.historyWindow;
  const originalClone = globalThis.structuredClone;
  try {
    port = await openDomainStorage(f.ctx, f.config);
    for (const collection of collections) {
      for (const limit of [undefined, 1, 2.5, 0, -1, 50, 100, NaN, Infinity]) {
        EvolutionMemory.prototype.historyWindow = function (name, size) { return originalWindow.call(this, name, size); };
        const expected = port.query(collection, limit);
        EvolutionMemory.prototype.historyWindow = originalWindow;
        let clonedPayloads = 0;
        globalThis.structuredClone = value => {
          if (value?.evidence) clonedPayloads++;
          return originalClone(value);
        };
        const actual = port.query(collection, limit);
        globalThis.structuredClone = originalClone;
        assert.deepEqual(actual, expected);
        assert.equal(clonedPayloads, 0);
        const nested = actual.entries.find(row => Array.isArray(row.recordedAt));
        if (nested) nested.recordedAt[0] = 'changed';
        assert.deepEqual(port.query(collection, limit), expected);
      }
    }
    assert.throws(() => port.query('unknown'), /E_DOMAIN_QUERY_COLLECTION/);
  } finally {
    EvolutionMemory.prototype.historyWindow = originalWindow;
    globalThis.structuredClone = originalClone;
    if (port) await port.close();
    await f.backend.close();
    fs.rmSync(f.root, { recursive: true });
  }
});
test('official domain: single-event batch, durable replay, restart, bounded read-only projection', async () => {
  const f = await fixture();
  let port = await openDomainStorage(f.ctx, f.config);
  for (const type of ['proposal-created', 'trial-completed', 'measurement-completed', 'promotion-succeeded', 'canary-passed']) f.bridge.emit(type, { id: 'exp-safe', proposal: { target: 'plugin:safe' }, state: 'stable' });
  assert.equal((await port.replay()).applied, 5);
  const before = port.query('lineage');
  assert.equal(before.count, 1);
  assert.equal((await port.replay()).duplicates, 5);
  assert.deepEqual(port.query('lineage'), before);
  await port.observe({ code: 'SAFE_ERROR', target: 'tool:sample', message: 'password=user secret raw stdout' });
  assert.equal(port.query('observations').count, 1);
  assert.ok(!JSON.stringify(port.query('observations')).includes('secret'));
  await port.close();
  await assert.rejects(port.observe({}), /E_DOMAIN_CLOSED/);
  port = await openDomainStorage(f.ctx, f.config);
  assert.deepEqual(port.query('lineage'), before);
  assert.equal((await port.replay()).duplicates, 5);
  await port.close(); await f.backend.close(); fs.rmSync(f.root, { recursive: true });
});
test('pending archive commit resumes without incrementing canary generation', async () => {
  const f = await fixture();
  const port = await openDomainStorage(f.ctx, f.config);
  f.bridge.emit('canary-passed', { id: 'crash-event', proposal: { target: 'plugin:crash' } });
  const domain = f.ctx.storageDomain.get(evolutionDomainSpec.name);
  const set = domain.global.set;
  let injected = false;
  domain.global.set = async value => {
    if (!injected && value.pending === null && Object.keys(value.applied).length) { injected = true; throw new Error('INJECTED_FINAL_COMMIT'); }
    return set(value);
  };
  await assert.rejects(port.replay(), /INJECTED_FINAL_COMMIT/);
  assert.ok(domain.global.get().pending);
  await assert.rejects(port.close(), /INJECTED_FINAL_COMMIT/);
  const restarted = await openDomainStorage(f.ctx, f.config);
  assert.equal(restarted.query('lineage').count, 1);
  assert.equal((await restarted.replay()).duplicates, 1);
  await restarted.close(); await f.backend.close(); fs.rmSync(f.root, { recursive: true });
});
test('committed duplicates still authenticate and reject conflicting signed IDs', async () => {
  for (const mode of ['tampered', 'conflict', 'writer']) {
    const f = await fixture();
    const port = await openDomainStorage(f.ctx, f.config);
    f.bridge.emit('trial-completed', { id: 'exp-safe', proposal: { target: 'plugin:safe' } });
    assert.equal((await port.flush()).applied, 1);
    const original = JSON.parse(fs.readFileSync(f.config.eventBridgePath, 'utf8').trim());
    assert.equal((await port.flush()).duplicates, 1);
    let changed;
    if (mode === 'tampered') changed = { ...original, event: { ...original.event, status: 'forged' } };
    else changed = signEventBridgeEnvelope({ ...original.event, status: 'changed' }, {
      key: f.config.eventBridgeKey, sequence: original.sequence,
      writer: mode === 'writer' ? 'other-writer' : original.writer,
    });
    fs.writeFileSync(f.config.eventBridgePath, JSON.stringify(changed) + '\n');
    const expected = mode === 'conflict' ? /E_DOMAIN_EVENT_ID_CONFLICT/ : /E_DOMAIN_EVENT_AUTH/;
    await assert.rejects(port.flush(), expected);
    await assert.rejects(port.close(), expected);
    await f.backend.close();
    fs.rmSync(f.root, { recursive: true });
  }
});
test('untrusted envelope rejected, close propagates failure; schema and safe DTO reject raw data', async () => {
  const f = await fixture();
  const port = await openDomainStorage(f.ctx, f.config);
  fs.writeFileSync(f.config.eventBridgePath, JSON.stringify({ schema: 2, writer: 'forged', sequence: 1, event: {}, mac: 'bad' })+'\n');
  await assert.rejects(port.replay(), /E_DOMAIN_EVENT_AUTH/);
  await assert.rejects(port.close(), /E_DOMAIN_EVENT_AUTH/);
  assert.throws(() => evolutionDomainSpec.global.schema.parse({ schema: 1, aggregate: { credentials: {} }, applied: {}, pending: null }));
  assert.ok(!JSON.stringify(projectObservation({ code: 'lower secret', message: 'secret' })).includes('secret'));
  await f.backend.close(); fs.rmSync(f.root, { recursive: true });
});
test('an interrupted or dead-owner archive lock is reclaimed instead of bricking startup', async () => {
  const f = await fixture();
  const lockPath = path.join(f.root, 'domain-archive.lock');
  // Owner pid that cannot be alive: startup must reclaim it.
  fs.writeFileSync(lockPath, '999999999');
  let port = await openDomainStorage(f.ctx, f.config);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), String(process.pid));
  await port.close();
  // Interrupted create: the lock exists but its pid was never written.
  fs.writeFileSync(lockPath, '');
  const past = new Date(Date.now() - 5000);
  fs.utimesSync(lockPath, past, past);
  port = await openDomainStorage(f.ctx, f.config);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), String(process.pid));
  await port.close();
  // A live owner still wins: the lock is never stolen from a running process.
  fs.writeFileSync(lockPath, String(process.pid));
  await assert.rejects(openDomainStorage(f.ctx, f.config), /E_DOMAIN_ARCHIVE_LOCK/);
  fs.unlinkSync(lockPath);
  await f.backend.close(); fs.rmSync(f.root, { recursive: true });
});
