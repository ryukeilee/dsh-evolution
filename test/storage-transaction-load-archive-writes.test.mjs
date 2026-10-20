/**
 * Load-time eviction must not write the live archive tree.
 *
 * `hydrate()` loads the live aggregate through the same store the writer uses.
 * When a collection was already over the hot window (a smaller `hotEntries`
 * after an upgrade, or hot records written by an older version), that load
 * evicted the excess and appended it to a live archive file directly, outside
 * any staged transaction: a crash there leaves a fragment the next append cannot
 * repair. The case below was first reproduced against the unfixed implementation,
 * and it does not weaken the released contract: the excess is still archived, and
 * the first mutation archives it inside its own transaction.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDomainStorage } from '../lib/domain-storage.js';
// The official storage packages are dev dependencies of this repo, so the
// domain integration is exercised against the real official implementation.
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

const HOT_LIMIT = 50;

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-load-archive-'));
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'), eventBridgeKey: 'b'.repeat(64) };
  return { root, ctx, config, backend,
    domain: () => ctx.storageDomain.get('evolution_domain'),
    archive: path.join(root, 'dockyard', 'state.json.observations-archive.jsonl'),
    globalPath: path.join(root, 'official', 'evolution_domain.json') };
}

async function teardown(f) { await f.backend.close(); fs.rmSync(f.root, { recursive: true, force: true }); }

function observations(count) {
  return Array.from({ length: count }, (_, index) => ({ id: `seed-${index}`, type: 'tool/error',
    componentId: 'tool-1', message: `seed message ${index}`, recordedAt: '2026-01-01T00:00:00.000Z' }));
}

const archived = f => (fs.existsSync(f.archive)
  ? fs.readFileSync(f.archive, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line).id)
  : []);

test('P2-14: startup keeps over-limit records hot and archives them in the next transaction', async () => {
  const f = await fixture();
  let port = await openDomainStorage(f.ctx, f.config);
  await port.observe({ code: 'BENCH_ERROR', target: 'tool:bootstrap' });
  await port.close();

  // A durable aggregate one record past the hot window, as an upgrade with a
  // smaller hot window leaves behind.
  const document = JSON.parse(fs.readFileSync(f.globalPath, 'utf8'));
  document.global.aggregate.evolution.observations = observations(HOT_LIMIT + 1);
  fs.writeFileSync(f.globalPath, JSON.stringify(document));

  port = await openDomainStorage(f.ctx, f.config);
  try {
    assert.equal(fs.existsSync(f.archive), false,
      'loading the live tree must not append to a live archive file outside a staged transaction');
    assert.equal(f.domain().global.get().aggregate.evolution.observations.length, HOT_LIMIT + 1,
      'nothing is dropped from the durable aggregate by a deferred load');
    assert.equal(port.query('observations', 200).count, HOT_LIMIT + 1,
      'the over-limit records stay in the hot projection');

    // The first mutation archives the excess inside its own transaction.
    await port.observe({ code: 'BENCH_ERROR', target: 'tool:after-startup' });
    assert.deepEqual(archived(f), ['seed-0', 'seed-1'], 'the excess is archived by the committing transaction, not by the load');
    assert.equal(f.domain().global.get().aggregate.evolution.observations.length, HOT_LIMIT,
      'the hot window converges to its limit instead of growing without bound');
    assert.equal(port.query('observations', 200).count, HOT_LIMIT + 2);
  } finally { await port.close(); }

  // A restart sees the same partition: the archive is not rewritten again.
  port = await openDomainStorage(f.ctx, f.config);
  try {
    assert.deepEqual(archived(f), ['seed-0', 'seed-1']);
    assert.equal(port.query('observations', 200).count, HOT_LIMIT + 2);
  } finally { await port.close(); }
  await teardown(f);
});
