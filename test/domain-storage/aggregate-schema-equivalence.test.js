// Differential evidence for the whole-document schema in lib/domain-storage.js.
//
// `aggregateSchema` preprocesses its input with `toJsonProjection`
// (`JSON.parse(JSON.stringify(...))`) and then validated every value of the
// evolution subtree with a recursive `z.json()` through `catchall`. That walk
// cannot reject anything the projection produced: its output is `null`,
// booleans, strings, arrays, plain objects and finite numbers by construction,
// so the only rejections left are structural - the strict document shape, the
// required `evolution.schema` integer, and `aggregate` being an object. The
// working tree therefore only keeps the structural part (`passthrough()` keeps
// the unknown evolution fields and their values).
//
// This test reconstructs the pre-change schema from the same two public pieces
// it was written from (the projection and the structural object schemas) and
// requires the two to agree on every document in the corpus: the same accept or
// reject decision, and a byte-identical JSON projection of the result. The
// corpus covers the shapes that can actually reach a validation - not just
// well-formed aggregates - including the values the deep walk existed for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { evolutionDomainSpec } from '../../lib/domain-storage.js';

const toJsonProjection = value => JSON.parse(JSON.stringify(value));
/** The pre-change schema, exactly as the pinned source built it. */
const preChangeAggregateSchema = z.preprocess(toJsonProjection,
  z.object({ evolution: z.object({ schema: z.number().int().min(4) }).catchall(z.json()).optional() }).strict());
/** The working-tree schema, taken from the spec the port is opened with. */
const currentAggregateSchema = evolutionDomainSpec.global.schema.shape.aggregate;

const documents = {
  'an empty aggregate': {},
  'a valid aggregate': { evolution: { schema: 4, observations: [{ id: 'a', recordedAt: '2026-10-12T00:00:00.000Z' }] } },
  'unknown evolution fields with nested values': { evolution: { schema: 7, nested: { deep: [{ a: 1, b: null, c: [true, 'x'] }] } } },
  'legacy undefined object fields': { evolution: { schema: 4, lineages: [{ id: 'a', relationRefs: undefined, nested: { gone: undefined } }] } },
  'undefined inside an array': { evolution: { schema: 4, values: [undefined, 1] } },
  'non-finite numbers in memory': { evolution: { schema: 4, values: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY] } },
  'numbers that only parse as non-finite': JSON.parse('{"evolution":{"schema":4,"values":[1e999,-1e999]}}'),
  'a negative zero': { evolution: { schema: 4, value: -0 } },
  'keys the JSON projection keeps verbatim': JSON.parse('{"evolution":{"schema":4,"__proto__":{"x":1},"constructor":2}}'),
  'an own __proto__ key below the top level': JSON.parse('{"evolution":{"schema":4,"data":{"__proto__":{"x":1},"constructor":2}}}'),
  'an own __proto__ key in an array element': JSON.parse('{"evolution":{"schema":4,"rows":[{"__proto__":{"x":1},"id":"a"}]}}'),
  'an own __proto__ key from a metric map': JSON.parse('{"evolution":{"schema":4,"experiments":[{"measurement":{"__proto__":5,"latency":1}}]}}'),
  'an own __proto__ key in nested arrays': JSON.parse('{"evolution":{"schema":4,"m":[[{"__proto__":{"y":2}}]]}}'),
  'functions and symbols are dropped by the projection': { evolution: { schema: 4, fn() {}, [Symbol('s')]: 1 } },
  'a date becomes its JSON string': { evolution: { schema: 4, at: new Date('2026-10-12T00:00:00.000Z') } },
  'a nested array of objects': { evolution: { schema: 4, matrix: Array.from({ length: 8 }, (_, i) => ({ i, values: [i, i + 1] })) } },
  'a schema above the minimum': { evolution: { schema: 99 } },
  'a schema exactly at the minimum': { evolution: { schema: 4 } },
  'no evolution member': {},
  'a null evolution member': { evolution: null },
  'an array evolution member': { evolution: [] },
  'a string evolution member': { evolution: 'schema' },
  'a schema below the minimum': { evolution: { schema: 3 } },
  'a fractional schema': { evolution: { schema: 4.5 } },
  'a string schema': { evolution: { schema: '4' } },
  'a missing schema': { evolution: { observations: [] } },
  'an unknown top-level member': { evolution: { schema: 4 }, extra: 1 },
  'a top-level member that JSON drops': { evolution: { schema: 4 }, extra: undefined },
  'aggregate that is null': null,
  'aggregate that is an array': [{ evolution: { schema: 4 } }],
  'aggregate that is a string': 'aggregate',
  'aggregate that is a number': 4,
};

/** `{ ok: true, value }` or `{ ok: false, code, path }`, whatever the path. */
function verdict(schema, document) {
  try {
    return { ok: true, value: JSON.stringify(schema.parse(document)) };
  } catch (error) {
    if (error?.name === 'ZodError') return { ok: false, code: error.name, issues: error.issues?.length ?? 0 };
    return { ok: false, code: error?.constructor?.name ?? 'Error' };
  }
}

test('the projected aggregate schema accepts and rejects exactly what the deep JSON walk did', () => {
  for (const [label, document] of Object.entries(documents)) {
    const before = verdict(preChangeAggregateSchema, document);
    const after = verdict(currentAggregateSchema, document);
    assert.equal(after.ok, before.ok, `${label}: accept/reject decision must match (before ${JSON.stringify(before)}, after ${JSON.stringify(after)})`);
    if (before.ok) assert.equal(after.value, before.value, `${label}: the validated projection must be byte-identical`);
    else assert.deepEqual({ code: after.code }, { code: before.code }, `${label}: refusal shape must match`);
  }
});

test('the projection drops an own __proto__ key at every depth, as the deep walk did', () => {
  // `JSON.parse` can create an own `__proto__` property; assigning that name on
  // an ordinary object instead sets the prototype, so the recursive
  // `z.record`-based walk dropped it while building its result. The projection
  // has to drop it too, or a nested one would reach the persisted document.
  for (const document of Object.values(documents)) {
    let parsed;
    try { parsed = currentAggregateSchema.parse(document); } catch { continue; }
    const hasOwnProto = (value) => {
      if (Array.isArray(value)) return value.some(hasOwnProto);
      if (!value || typeof value !== 'object') return false;
      if (Object.hasOwn(value, '__proto__')) return true;
      return Object.values(value).some(hasOwnProto);
    };
    assert.equal(hasOwnProto(parsed), false, `no validated document may carry an own __proto__ key: ${JSON.stringify(parsed)}`);
  }
  // And the removal is exactly the old behavior, not a widening: the other
  // `constructor` / `prototype` names stay as ordinary own keys.
  const kept = currentAggregateSchema.parse({ evolution: { schema: 4, constructor: 2, prototype: 3 } });
  assert.equal(kept.evolution.constructor, 2);
  assert.equal(kept.evolution.prototype, 3);
});

test('the projection alone makes every value JSON, which is why the per-value walk is redundant', () => {
  // The claim above rests on this: after the projection, no value can be
  // anything z.json() would reject, so the deep walk had nothing left to refuse.
  for (const document of Object.values(documents)) {
    let projected;
    try { projected = JSON.parse(JSON.stringify(document)); } catch { continue; }
    const values = [];
    const collect = (value) => {
      if (Array.isArray(value)) { value.forEach(collect); return; }
      if (value && typeof value === 'object') { Object.values(value).forEach(collect); return; }
      values.push(value);
    };
    collect(projected);
    for (const value of values) {
      assert.ok(value === null || ['string', 'boolean', 'number'].includes(typeof value), `projected value ${String(value)} must be a JSON scalar`);
      if (typeof value === 'number') assert.ok(Number.isFinite(value), `projected number ${value} must be finite`);
    }
    assert.deepEqual(projected, JSON.parse(JSON.stringify(projected)), 'a projected document must be a fixed point of the projection');
  }
});
