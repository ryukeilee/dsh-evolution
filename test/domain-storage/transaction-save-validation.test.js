// What a transaction's working store must still do to every save.
//
// `createMemory()` used to write `aggregateSchema.parse(payload)` and keep the
// result; the result was never read (the commit publishes `instance.snapshot()`,
// and the store's `load()` is only reached by `reconcile()`/`verifyConsistency()`,
// which no port path calls), so the projection built and dropped a whole deep
// copy once per save - once per appended record plus once per bridge marker. It
// now performs only the part that could be observed, `assertTransactionSave`,
// which is the same `JSON.stringify` the schema's preprocess ran.
//
// This file pins that claim instead of asserting it in prose, in both
// directions:
//
// 1. Where the old call threw, the new one throws the same error. That is the
//    exception boundary a save owns: a payload JSON cannot represent aborts the
//    transaction before it publishes anything.
// 2. Where the two can disagree - and they can only disagree about the schema's
//    *verdict*, never about representability - the payload shape required is one
//    the port cannot hand this store: the committed aggregate is validated by
//    the same schema at the entry of every transaction, and both events the port
//    feeds the store are JSON-projected before they reach it. The second test
//    states that divergence exactly, so a future reader cannot mistake it for
//    something the differential test would have caught.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertTransactionSave, evolutionDomainSpec, openDomainStorage } from '../../lib/domain-storage.js';

const aggregateSchema = evolutionDomainSpec.global.schema.shape.aggregate;

/** Run a call and report what it did, without letting the throw escape. */
function capture(run) {
  try {
    return { threw: false, value: run() };
  } catch (error) {
    return { threw: true, name: error?.name, message: error?.message };
  }
}

// A document whose serialized text carries the own-`__proto__` literal, which is
// the only case where the preprocess's recursive strip runs (and the only case
// where it can overflow its stack). Built at the depth the review used.
const protoLiteral = { evolution: { schema: 4, note: '__proto__' } };
const deepProtoLiteral = (() => {
  const payload = { evolution: { schema: 4 } };
  let node = payload.evolution;
  for (let depth = 0; depth < 12000; depth += 1) { node.child = { note: 'x' }; node = node.child; }
  node.leak = '__proto__';
  return payload;
})();

const circular = { evolution: { schema: 4, list: [] } };
circular.evolution.self = circular;

const throwingGetter = { evolution: { schema: 4 } };
Object.defineProperty(throwingGetter.evolution, 'boom', { enumerable: true, get() { throw new TypeError('getter must not run'); } });

const throwingToJson = { evolution: { schema: 4, nested: { toJSON() { throw new TypeError('toJSON must not run'); } } } };

// Payloads JSON can represent, plus the payloads it cannot. The store receives
// `{ ...state, evolution: { ...memoryState } }`, so every entry here is wrapped
// the same way.
const representable = [
  { evolution: { schema: 4 } },
  { evolution: { schema: 4, experiments: [], knowledge: [{ id: 'k', count: 1 }] } },
  { evolution: { schema: 4, nan: Number.NaN, infinite: Number.POSITIVE_INFINITY } },
  { evolution: { schema: 4, date: new Date('2026-10-07T00:00:00.000Z') } },
  { evolution: { schema: 4, missing: undefined, list: [undefined, 1] } },
  { evolution: { schema: 4, fn: () => 1 } },
  {},
];
const unrepresentable = [
  { evolution: { schema: 4, big: 10n } },
  circular,
  throwingGetter,
  throwingToJson,
  { evolution: { schema: 4, deep: { big: 1n } } },
  undefined,
];
// The strip path: the projection normalizes the literal away and both checks
// must agree on the verdict, including on a document deep enough that the
// recursion itself is what throws.
const stripPath = [protoLiteral, deepProtoLiteral];

test('a save still throws exactly where the whole-document projection threw', () => {
  for (const payload of [...representable, ...stripPath, ...unrepresentable]) {
    const save = capture(() => assertTransactionSave(payload));
    const projection = capture(() => aggregateSchema.parse(payload));
    assert.equal(save.threw, projection.threw,
      `representability must agree for ${JSON.stringify(Object.keys(payload?.evolution ?? {}))}`);
    if (projection.threw) {
      assert.equal(save.name, projection.name);
      assert.equal(save.message, projection.message);
    }
  }
});

test('the only divergence is a verdict the port cannot hand this store', async () => {
  // The schema rejects an `evolution.schema` below 4 and any key beside
  // `evolution`. Stringifying such a payload cannot throw, so this is the one
  // place the two checks differ. It is not a state this store can receive: the
  // payload's only own key comes from the committed aggregate, and a committed
  // document of that shape is refused when the medium hands it back - the
  // official domain validates the global document on read, and this port parses
  // it again at the entry of every transaction.
  for (const payload of [{ evolution: { schema: 3 } }, { evolution: { schema: 4 }, extra: 1 }]) {
    const save = capture(() => assertTransactionSave(payload));
    const projection = capture(() => aggregateSchema.parse(payload));
    assert.equal(save.threw, false, 'the save check is the representability half, not the schema verdict');
    assert.equal(projection.threw, true);
    assert.equal(projection.name, 'ZodError');
  }
  const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
  const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');
  for (const aggregate of [{ evolution: { schema: 3 } }, { evolution: { schema: 4 }, extra: 1 }]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-save-validation-'));
    const backend = new JsonStorageBackend(path.join(root, 'official'));
    const ctx = { emit() {}, on() { return () => {}; }, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
    ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
    const domain = await ctx.storageDomain.open(evolutionDomainSpec);
    try {
      // The write itself is not validated (the official facility validates the
      // global document when it reads it back), which is exactly why the port
      // keeps its own entry parse.
      await domain.global.set({ schema: 1, aggregate, applied: {}, pending: null });
    } finally {
      await domain.close();
    }
    try {
      await assert.rejects(openDomainStorage(ctx, { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'), eventBridgeKey: 'b'.repeat(64) }),
        // The official facility reports it as its own refusal ("stored global
        // does not match its schema") over the schema error that follows it.
        (error) => /stored global does not match its schema/.test(error?.message ?? ''));
    } finally {
      await backend.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

/**
 * Count the `JSON.stringify` calls whose argument is an aggregate payload - the
 * `{ evolution: ... }` value a save hands its store, and the same shape the
 * document parse projects. A flush therefore stringifies one payload per save
 * plus the fixed document parses; only the per-save part scales with the
 * backlog, which is what makes this a behavioural pin on the kept check rather
 * than on an absolute number.
 */
async function countPayloadStringifies(records) {
  const { signEventBridgeEnvelope } = await import('../../lib/orchestrator.js');
  const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
  const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');
  const key = 'b'.repeat(64);
  const event = (sequence) => ({ schema: 1, eventId: `evolution:measurement-completed:pin-experiment-${sequence}`,
    eventType: 'measurement-completed', experimentId: `pin-experiment-${sequence}`, proposalId: `pin-proposal-${sequence}`,
    target: 'plugin:pin', capability: 'plugin:pin', lineageId: 'plugin:pin', status: 'measured',
    measurement: { latency: 1 }, evidence: {}, canary: {},
    audit: { producer: 'dsh-evolution-orchestrator', at: '2026-10-07T00:00:00.000Z' } });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-save-stringify-'));
  const file = path.join(root, 'execution-events.jsonl');
  const lines = []; const applied = {}; let sequence = 0;
  for (let index = 0; index < 5; index += 1) {
    sequence += 1;
    const envelope = signEventBridgeEnvelope(event(index), { key, sequence });
    applied[envelope.event.eventId] = envelope.mac;
    lines.push(JSON.stringify(envelope));
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = { emit() {}, on() { return () => {}; }, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const domain = await ctx.storageDomain.open(evolutionDomainSpec);
  await domain.global.set({ schema: 1, aggregate: {}, applied, pending: null });
  await domain.close();
  const port = await openDomainStorage(ctx, { presetDir: root, eventBridgePath: file, eventBridgeKey: key });
  const payloadShaped = (value) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((name) => name === 'evolution');
  try {
    assert.deepEqual(await port.flush(), { applied: 0, duplicates: 5 });
    for (let index = 0; index < records; index += 1) {
      sequence += 1;
      fs.appendFileSync(file, `${JSON.stringify(signEventBridgeEnvelope(event(100 + index), { key, sequence }))}\n`);
    }
    let counted = 0;
    const original = JSON.stringify;
    JSON.stringify = function (value, ...rest) { if (payloadShaped(value)) counted += 1; return original.call(this, value, ...rest); };
    try {
      assert.deepEqual(await port.flush(), { applied: records, duplicates: 5 });
    } finally { JSON.stringify = original; }
    return counted;
  } finally { await port.close(); await backend.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

test('each save still stringifies its payload once, which is what the store checks', async () => {
  // A completed measurement saves twice (the record, then the bridge marker), so
  // the two backlogs differ by six saves. The fixed document parses every flush
  // pays cancel out in the difference, and a store that stopped calling the check
  // (or called it a fixed number of times) cannot produce it.
  const small = await countPayloadStringifies(2);
  const large = await countPayloadStringifies(5);
  assert.ok(small >= 4, `a two-record flush must stringify at least its four saves, saw ${small}`);
  assert.equal(large - small, 6, `six extra saves must add six payload stringifies, saw ${small} -> ${large}`);
});
