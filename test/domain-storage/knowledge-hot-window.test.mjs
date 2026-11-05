// The knowledge hot window is bounded independently of `maxEntries` for a
// file-backed store, because every durable commit writes the whole aggregate
// (twice when the transaction stages archive bytes). The cold archive is the
// complete history: every read merges through it, and `load()` already evicts
// over-limit rows into it. These tests pin the properties that make the bound a
// partition change only: identity, accumulation, order, restart recovery, the
// first transaction on a legacy document, and the archive failure paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { EvolutionMemory } from '../../lib/dockyard-domain/index.js';
import { mergeKnowledgeEntry, normalizeKnowledgeEvent } from '../../lib/dockyard-domain/knowledge.js';
import { openDomainStorage, projectObservation } from '../../lib/domain-storage.js';
import { JsonStateStore } from '../dockyard-domain/support.js';

const NOW = Date.parse('2026-11-05T00:00:00.000Z');
const HOT = 200;
const authority = { assertMutation() {} };

const codeOf = index => {
  let text = '';
  let value = index;
  do { text = String.fromCharCode(65 + (value % 26)) + text; value = Math.floor(value / 26); } while (value > 0);
  return `SUBJECT_${text}`;
};
const inputOf = index => ({ code: codeOf(index), type: index % 2 ? 'agent/error' : 'tool/error', target: 'host', status: 'failed',
  source: 'official-tools', severity: 'error', componentId: 'host',
  message: `Official operation failed (${codeOf(index)})` });

function temporary(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function memoryAt(t, root, options = {}) {
  const filePath = path.join(root, 'state.json');
  const memory = new EvolutionMemory({ stateStore: new JsonStateStore({ filePath }), mutationAuthority: authority, clock: () => new Date(NOW), ...options });
  await memory.load({ snapshot: false });
  return { memory, filePath };
}

async function reopen(t, root, options = {}) {
  return memoryAt(t, root, options);
}

const knowledgeOf = memory => memory.fullSnapshot().knowledge;
const keysOf = memory => knowledgeOf(memory).map(row => row.knowledgeKey);

test('the hot knowledge window is bounded while the complete history survives a restart', async t => {
  const root = temporary(t, 'knowledge-window-');
  const { memory } = await memoryAt(t, root);
  const count = HOT + 250;
  for (let index = 0; index < count; index += 1) await memory.recordKnowledgeEvent(inputOf(index));

  assert.equal(memory.snapshot().knowledge.length, HOT, 'the published aggregate keeps only the bounded hot window');
  assert.equal(knowledgeOf(memory).length, count, 'the cold archive still holds every row');
  const keys = keysOf(memory);
  assert.equal(new Set(keys).size, count, 'every subject keeps one canonical row');

  const restarted = await reopen(t, root);
  assert.equal(restarted.memory.snapshot().knowledge.length, HOT);
  assert.equal(keysOf(restarted.memory).length, count);
  assert.deepEqual(keysOf(restarted.memory), keys, 'restart preserves the complete order');
});

test('a cold knowledge row keeps its position and accumulates at most one row', async t => {
  const root = temporary(t, 'knowledge-update-');
  const { memory } = await memoryAt(t, root);
  for (let index = 0; index < HOT + 1; index += 1) await memory.recordKnowledgeEvent(inputOf(index));
  const target = inputOf(0);
  const key = knowledgeOf(memory)[0].knowledgeKey;
  assert.equal(memory.snapshot().knowledge.some(row => row.knowledgeKey === key), false, 'the first subject must have been evicted');

  const updated = await memory.recordKnowledgeEvent({ ...target, status: 'failed', outcome: 'failure' });
  assert.equal(updated.count, 2);
  const rows = knowledgeOf(memory);
  assert.equal(rows.length, HOT + 1, 'an update must not append a second canonical row');
  assert.equal(rows[0].knowledgeKey, key, 'a cold update keeps its original position');
  assert.equal(rows[0].count, 2);
  assert.equal(rows.filter(row => row.knowledgeKey === key).length, 1);
  assert.equal(memory.snapshot().knowledge.some(row => row.knowledgeKey === key), false, 'the updated row stays cold');

  const restarted = await reopen(t, root);
  const after = knowledgeOf(restarted.memory);
  assert.equal(after[0].knowledgeKey, key);
  assert.equal(after[0].count, 2);
  assert.equal(after.length, HOT + 1);
});

test('a failed archive eviction keeps the row and the next append retries it', async t => {
  const root = temporary(t, 'knowledge-evict-failure-');
  const { memory, filePath } = await memoryAt(t, root);
  for (let index = 0; index < HOT; index += 1) await memory.recordKnowledgeEvent(inputOf(index));
  const archive = `${filePath}.knowledge-archive.jsonl`;
  assert.equal(fs.existsSync(archive), false);

  // A directory at the archive path makes the append fail without touching any
  // committed byte. The eviction reports failure instead of dropping the row.
  fs.mkdirSync(archive);
  await memory.recordKnowledgeEvent(inputOf(HOT));
  assert.equal(memory.snapshot().knowledge.length, HOT + 1, 'the failed eviction keeps the row hot');
  assert.equal(knowledgeOf(memory).length, HOT + 1, 'nothing is lost');
  assert.equal(fs.statSync(archive).isDirectory(), true, 'the failed write changed nothing');
  assert.ok(memory.archiveIntegrity().knowledge?.some(fault => fault.kind === 'deferred-write'),
    'the failure is reported as a deferred write');

  fs.rmdirSync(archive);
  await memory.recordKnowledgeEvent(inputOf(HOT + 1));
  assert.equal(memory.snapshot().knowledge.length, HOT, 'a later append drains the over-limit rows');
  assert.equal(fs.statSync(archive).isFile(), true);
  assert.equal(knowledgeOf(memory).length, HOT + 2);

  const restarted = await reopen(t, root);
  assert.equal(knowledgeOf(restarted.memory).length, HOT + 2);
});

test('a failed cold-row update rejects the record and a retry applies it once', async t => {
  const root = temporary(t, 'knowledge-update-failure-');
  const filePath = path.join(root, 'state.json');
  // The host's own write guard is the seam that fails a write without changing
  // the archive's identity, so the cold row is still resolvable when the update
  // is attempted.
  let failWrites = false;
  const memory = new EvolutionMemory({ stateStore: new JsonStateStore({ filePath }), mutationAuthority: authority,
    clock: () => new Date(NOW), archiveWriteGuard: file => {
      if (failWrites && String(file).includes('knowledge-archive.jsonl')) {
        const error = new Error('INJECTED_ARCHIVE_WRITE');
        error.code = 'EACCES';
        throw error;
      }
    } });
  await memory.load({ snapshot: false });
  for (let index = 0; index < HOT + 1; index += 1) await memory.recordKnowledgeEvent(inputOf(index));
  const archive = `${filePath}.knowledge-archive.jsonl`;
  assert.equal(fs.statSync(archive).isFile(), true);
  const before = fs.readFileSync(archive);
  const key = knowledgeOf(memory)[0].knowledgeKey;

  failWrites = true;
  await assert.rejects(memory.recordKnowledgeEvent(inputOf(0)), error => error.code === 'E_ARCHIVE_WRITE_FAILED');
  assert.equal(memory.fullSnapshot().knowledge[0].count, 1, 'the refused update did not change the accumulator');
  assert.equal(fs.readFileSync(archive).equals(before), true, 'the archive bytes were not replaced');

  failWrites = false;
  const retried = await memory.recordKnowledgeEvent(inputOf(0));
  assert.equal(retried.count, 2, 'the retry applies the update exactly once');
  assert.equal(knowledgeOf(memory)[0].knowledgeKey, key);
  assert.equal(knowledgeOf(memory)[0].count, 2);
});

test('an invalid tail on the knowledge archive is quarantined, not merged', async t => {
  const root = temporary(t, 'knowledge-torn-tail-');
  const { memory, filePath } = await memoryAt(t, root);
  for (let index = 0; index < HOT + 1; index += 1) await memory.recordKnowledgeEvent(inputOf(index));
  const archive = `${filePath}.knowledge-archive.jsonl`;
  const committed = knowledgeOf(memory).length;
  fs.appendFileSync(archive, '{"id":"knowledge:torn","knowledgeKey"');

  const restarted = await reopen(t, root);
  await restarted.memory.recordKnowledgeEvent(inputOf(HOT + 1));
  assert.equal(knowledgeOf(restarted.memory).length, committed + 1, 'the torn fragment is not a record');
  const quarantine = `${filePath}.knowledgequarantine-archive.jsonl`;
  assert.equal(fs.existsSync(quarantine), true, 'the fragment is preserved for an operator');
  assert.match(fs.readFileSync(quarantine, 'utf8'), /knowledge:torn/);
});

test('a legacy document with a full hot knowledge window migrates inside the first transaction', async t => {
  const root = temporary(t, 'knowledge-legacy-');
  // The previous version could leave up to `maxEntries` (1,000) knowledge rows
  // in the committed aggregate. Build that document with the released
  // normalisation functions and open it exactly as a seeded root.
  const rows = [];
  for (let index = 0; index < 1000; index += 1) {
    const observation = { ...projectObservation(inputOf(index)), id: `obs-${index}`,
      patternKey: `official-tools:${inputOf(index).type}:${codeOf(index)}`,
      observedAt: new Date(NOW + index).toISOString() };
    const event = normalizeKnowledgeEvent(observation, { sourceCollection: 'observations', now: new Date(NOW) });
    rows.push(mergeKnowledgeEntry(null, event, { now: new Date(NOW) }));
  }
  fs.mkdirSync(path.join(root, 'dockyard'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dockyard', 'state.json'), JSON.stringify({ evolution: { schema: 4, knowledge: rows, observations: [] } }));

  const backend = new JsonStorageBackend(path.join(root, 'official'));
  t.after(() => backend.close().catch(() => {}));
  const makeContext = () => {
    const ctx = { emit() {}, effect() {}, logger: { warn() {} }, on() { return () => {}; }, storage: { backend: { get: () => backend } } };
    ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
    return ctx;
  };
  const config = { presetDir: root, eventBridgePath: path.join(root, 'events.jsonl'), eventBridgeKey: 'b'.repeat(64), domainSeed: true };
  let ctx = makeContext();
  let port = await openDomainStorage(ctx, config);
  const archive = path.join(root, 'dockyard', 'state.json.knowledge-archive.jsonl');
  assert.equal(fs.existsSync(archive), false, 'opening the document writes no live archive');
  assert.equal(port.query('knowledge', 50).count, 1000);
  await port.close();

  // The first mutation must stage the migration and publish nothing when the
  // commit is refused; the live tree stays as the previous version left it.
  ctx = makeContext();
  port = await openDomainStorage(ctx, config);
  const domain = ctx.storageDomain.get('evolution_domain');
  const set = domain.global.set.bind(domain.global);
  let refused = true;
  domain.global.set = async value => {
    if (!refused) return set(value);
    refused = false;
    throw new Error('INJECTED_COMMIT');
  };
  await assert.rejects(port.observe(inputOf(5000)), /INJECTED_COMMIT/);
  assert.equal(fs.existsSync(archive), false, 'a refused transaction leaves no live archive');
  assert.equal(domain.global.get().aggregate.evolution.knowledge.length, 1000, 'the committed document did not move');
  await assert.rejects(port.close(), /INJECTED_COMMIT/);

  // A fresh port retries the same observation; the migration commits with the
  // complete history and the bounded window.
  ctx = makeContext();
  port = await openDomainStorage(ctx, config);
  await port.observe(inputOf(5000));
  assert.equal(port.query('knowledge', 50).count, 1001);
  const committed = JSON.parse(fs.readFileSync(path.join(root, 'official', 'evolution_domain.json'), 'utf8')).global.aggregate.evolution;
  assert.equal(committed.knowledge.length, HOT, 'the committed aggregate is bounded by the hot window');
  assert.equal(fs.statSync(archive).isFile(), true);
  const archived = fs.readFileSync(archive, 'utf8').split('\n').filter(Boolean).length;
  assert.equal(archived, 1001 - HOT, 'every other canonical row reached the archive inside the transaction');
  await port.close();

  const reopened = makeContext();
  port = await openDomainStorage(reopened, config);
  assert.equal(port.query('knowledge', 50).count, 1001);
  assert.equal(port.query('knowledge', 50).entries.length, 50);
  await port.close();
});

test('a repeated knowledge identity accumulates in one row across an archive and a restart', async t => {
  const root = temporary(t, 'knowledge-duplicate-');
  const { memory } = await memoryAt(t, root);
  for (let index = 0; index < HOT + 1; index += 1) await memory.recordKnowledgeEvent(inputOf(index));
  const first = await memory.recordKnowledgeEvent(inputOf(0));
  const second = await memory.recordKnowledgeEvent(inputOf(0));
  assert.equal(first.count, 2);
  assert.equal(second.count, 3);
  assert.equal(knowledgeOf(memory).filter(row => row.knowledgeKey === first.knowledgeKey).length, 1);

  const restarted = await reopen(t, root);
  const rows = knowledgeOf(restarted.memory).filter(row => row.knowledgeKey === first.knowledgeKey);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 3);
});
