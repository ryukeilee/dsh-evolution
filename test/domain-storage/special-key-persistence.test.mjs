// A data-derived `__proto__` key has to survive the official domain medium.
//
// Every durable value in this plugin passes `aggregateSchema`, whose preprocess
// is the JSON projection (`JSON.parse(JSON.stringify(...))`). `JSON.stringify`
// spells an own `__proto__` key literally, so the project the projection exposes
// once carried the key - and the recursive own-`__proto__` strip that reproduced
// the verdict of the retired `z.record`-based walk then deleted it from the
// document that *was returned and persisted*. That made the identity of a row
// that owns the key depend on where it was read from: the hot projection kept
// `knowledgeKey` from the in-memory value, while every reload recomputed it from
// the stripped bytes, so the same observation was two subjects.
//
// The strip still runs, but only on the copy the structural schema validates;
// the document the projection returns and persists keeps the key. This test
// pins that round trip against the real official storage packages: a legacy row
// written straight into the backend's file keeps its payload, its identity and
// its ordinary (key-free) neighbours byte for byte across a full transaction, a
// close and a reopen.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDomainStorage, evolutionDomainSpec } from '../../lib/domain-storage.js';
import { knowledgeKeyOf } from '../../lib/dockyard-domain/knowledge.js';
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

const RECORDED_AT = '2026-10-01T00:00:00.000Z';
/** A legacy row whose payload owns `__proto__`, exactly as `JSON.parse` can create. */
const LEGACY = JSON.parse(`{"id":"legacy-proto","type":"tool/error","problem":"proto payload","componentId":"plugin:proto","severity":"error","strategy":{"__proto__":{"x":1},"b":2},"semanticFact":{"__proto__":null,"n":1},"recordedAt":"${RECORDED_AT}"}`);
/** A plain neighbour with no own `__proto__` key at all. */
const PLAIN = { id: 'plain-row', type: 'tool/error', problem: 'plain payload', componentId: 'plugin:plain', severity: 'error', strategy: { b: 2 }, recordedAt: RECORDED_AT };

function fileOf(root) { return path.join(root, 'official', 'evolution_domain.json'); }

/** Write a domain document by hand, the way an older build left it on disk. */
function seed(root, observations) {
  fs.mkdirSync(path.join(root, 'official'), { recursive: true });
  fs.writeFileSync(fileOf(root), JSON.stringify({
    unit: { name: evolutionDomainSpec.name, version: 1 },
    global: { schema: 1, aggregate: { evolution: { schema: 5, observations } }, applied: {}, pending: null },
    tables: {},
  }));
}

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-domain-special-key-'));
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'), eventBridgeKey: 'b'.repeat(64) };
  return { root, ctx, config, backend };
}

/** The observations of the durable document on disk, as JSON data. */
function durableObservations(root) {
  return JSON.parse(fs.readFileSync(fileOf(root), 'utf8')).global.aggregate.evolution.observations;
}

test('an own __proto__ payload survives the domain projection, a commit, a close and a reopen', async () => {
  const f = await fixture();
  try {
    seed(f.root, [LEGACY, PLAIN]);
    const legacyIdentity = knowledgeKeyOf(LEGACY);
    const plainBefore = JSON.stringify(PLAIN);
    assert.match(legacyIdentity, /^knowledge:[0-9a-f]{32}$/);
    // The seed row's identity is the one that includes its payload.
    assert.notEqual(legacyIdentity, knowledgeKeyOf({ ...LEGACY, strategy: { b: 2 } }));

    let port = await openDomainStorage(f.ctx, f.config);
    const loaded = f.ctx.storageDomain.get(evolutionDomainSpec.name).global.get().aggregate.evolution.observations;
    assert.equal(loaded.length, 2);
    assert.equal(Object.hasOwn(loaded[0].strategy, '__proto__'), true, 'the loaded row must keep its payload');
    assert.deepEqual(loaded[0].strategy.__proto__, { x: 1 });
    assert.equal(Object.hasOwn(loaded[0].semanticFact, '__proto__'), true);
    assert.equal(loaded[0].semanticFact.__proto__, null);
    // This is the failure the strip caused: the identity recomputed from the
    // document the projection returned did not match the one the row was
    // recorded under, so a reload turned one subject into two.
    assert.equal(knowledgeKeyOf(loaded[0]), legacyIdentity, 'the projection must not change the identity');
    assert.deepEqual(port.query('observations').entries.map((row) => row.id).sort(), ['legacy-proto', 'plain-row']);

    // A full transaction commit: the observation port appends a record and the
    // whole aggregate is republished through the same projection.
    await port.observe({ code: 'SAFE_ERROR', target: 'tool:sample' });
    await port.close();
    await f.backend.close();

    // The durable bytes keep the payload and leave the plain neighbour alone.
    const afterCommit = durableObservations(f.root);
    const legacyAfter = afterCommit.find((row) => row.id === 'legacy-proto');
    assert.ok(legacyAfter, 'the legacy row must still be on disk');
    assert.equal(Object.hasOwn(legacyAfter.strategy, '__proto__'), true, 'the persisted row must keep its payload');
    assert.deepEqual(legacyAfter.strategy.__proto__, { x: 1 });
    assert.equal(JSON.stringify(legacyAfter.strategy), JSON.stringify(LEGACY.strategy));
    assert.equal(JSON.stringify(legacyAfter.semanticFact), JSON.stringify(LEGACY.semanticFact));
    assert.equal(knowledgeKeyOf(legacyAfter), legacyIdentity);
    assert.equal(JSON.stringify(afterCommit.find((row) => row.id === 'plain-row')), plainBefore, 'a row without the key must be byte-identical');

    // Reopen: the same document, the same payload, the same identity.
    const secondBackend = new JsonStorageBackend(path.join(f.root, 'official'));
    const secondCtx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => secondBackend } }, effect() {} };
    secondCtx.storageDomain = new DomainFacility(secondCtx, { backend: 'json' });
    port = await openDomainStorage(secondCtx, f.config);
    const again = secondCtx.storageDomain.get(evolutionDomainSpec.name).global.get().aggregate.evolution.observations;
    const legacyAgain = again.find((row) => row.id === 'legacy-proto');
    assert.ok(legacyAgain);
    assert.equal(Object.hasOwn(legacyAgain.strategy, '__proto__'), true);
    assert.deepEqual(legacyAgain.strategy.__proto__, { x: 1 });
    assert.equal(knowledgeKeyOf(legacyAgain), legacyIdentity, 'the identity must be stable across the reopen');
    assert.equal(JSON.stringify(again.find((row) => row.id === 'plain-row')), plainBefore);
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal(({}).polluted, undefined);
    await port.close();
    await secondBackend.close();
    assert.equal(JSON.stringify(durableObservations(f.root).find((row) => row.id === 'plain-row')), plainBefore);
  } finally {
    await f.backend.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
