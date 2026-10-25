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
//
// One deliberate difference is pinned separately below. Both the retired deep
// walk and the plain `z.record` assignment it used dropped an own `__proto__` key
// while building the result, so the projection used to hand back - and the port
// used to persist - a document whose key was gone. That key is part of a
// record's identity (`compactValue()` in the domain), so dropping it made the
// identity of an in-memory row differ from the identity of the same row after a
// reload. The working tree therefore validates the key-free copy and returns the
// JSON projection with the key. For a document without such a key the two
// implementations still agree byte for byte, which is what the first test
// requires; for one with it, the first test requires each side to produce
// exactly its own documented output instead.
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

/**
 * `true` when `value` owns `__proto__` anywhere. Rebuilt here instead of
 * imported, so the assertion does not run the implementation's own walk.
 */
function hasOwnProto(value) {
  if (Array.isArray(value)) return value.some(hasOwnProto);
  if (!value || typeof value !== 'object') return false;
  if (Object.hasOwn(value, '__proto__')) return true;
  return Object.values(value).some(hasOwnProto);
}

/** The key-free copy, derived independently of the implementation's copy. */
function stripOwnProtoKeys(value) {
  if (Array.isArray(value)) return value.map(stripOwnProtoKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== '__proto__').map(([key, entry]) => [key, stripOwnProtoKeys(entry)]));
}

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
    if (!before.ok) {
      assert.deepEqual({ code: after.code }, { code: before.code }, `${label}: refusal shape must match`);
      continue;
    }
    const projected = JSON.stringify(JSON.parse(JSON.stringify(document)));
    if (hasOwnProto(JSON.parse(projected))) {
      // The deliberate change: the working tree returns the JSON projection with
      // the key, the retired walk returned its key-free copy.
      assert.equal(after.value, projected, `${label}: the returned document must be the JSON projection, own __proto__ included`);
      assert.equal(before.value, JSON.stringify(stripOwnProtoKeys(JSON.parse(projected))), `${label}: the reference result must be the key-free projection`);
    } else {
      assert.equal(after.value, before.value, `${label}: the validated projection must be byte-identical`);
    }
  }
});

test('the validated copy drops an own __proto__ key while the returned document keeps it', () => {
  // `JSON.parse` can create an own `__proto__` property; assigning that name on
  // an ordinary object instead sets the prototype, so the recursive
  // `z.record`-based walk dropped it while building its result. That is still
  // the verdict the structural schema has to judge - it judges the key-free copy
  // - but it is no longer what the projection returns: the document is the JSON
  // projection, so a nested key reaches the persisted document.
  for (const [label, document] of Object.entries(documents)) {
    const projected = JSON.parse(JSON.stringify(document));
    const before = verdict(preChangeAggregateSchema, document);
    let parsed;
    try { parsed = currentAggregateSchema.parse(document); } catch {
      // A refusal stays a refusal on both sides; the first test pins the verdict.
      assert.equal(before.ok, false, `${label}: a document this schema refuses must be refused by the reference too`);
      continue;
    }
    assert.equal(before.ok, true, `${label}: a document this schema accepts must be accepted by the reference too`);
    assert.equal(JSON.stringify(parsed), JSON.stringify(projected), `${label}: the returned document must be the JSON projection`);
    assert.equal(hasOwnProto(parsed), hasOwnProto(projected), `${label}: the key must survive exactly where the projection has it`);
    // The reference walk is what dropped it, at every depth, and it still does.
    assert.equal(hasOwnProto(JSON.parse(before.value)), false, `${label}: the retired walk's result must stay key-free`);
    // The key-free copy the schema validated really differs from the returned
    // document whenever the projection carries the key - otherwise the two
    // assertions above would be vacuous.
    if (hasOwnProto(projected)) {
      assert.notEqual(JSON.stringify(parsed), JSON.stringify(stripOwnProtoKeys(projected)), `${label}: the validated copy must differ from the returned document`);
    }
  }
  // Depth by depth, on the shapes the corpus carries.
  const keysOf = (value) => Object.keys(value);
  assert.deepEqual(keysOf(currentAggregateSchema.parse(documents['keys the JSON projection keeps verbatim']).evolution), ['schema', '__proto__', 'constructor']);
  assert.deepEqual(keysOf(currentAggregateSchema.parse(documents['an own __proto__ key below the top level']).evolution.data), ['__proto__', 'constructor']);
  assert.deepEqual(keysOf(currentAggregateSchema.parse(documents['an own __proto__ key in an array element']).evolution.rows[0]), ['__proto__', 'id']);
  assert.deepEqual(keysOf(currentAggregateSchema.parse(documents['an own __proto__ key from a metric map']).evolution.experiments[0].measurement), ['__proto__', 'latency']);
  assert.deepEqual(keysOf(currentAggregateSchema.parse(documents['an own __proto__ key in nested arrays']).evolution.m[0][0]), ['__proto__']);
  const exercised = currentAggregateSchema.parse(documents['an own __proto__ key from a metric map']);
  assert.equal(Object.getOwnPropertyDescriptor(exercised.evolution.experiments[0].measurement, '__proto__').value, 5, 'the key must be an own data property with its value');
  assert.equal(Object.getPrototypeOf(exercised.evolution.experiments[0].measurement), Object.prototype);
  // And keeping the key is not a widening: the other `constructor` / `prototype`
  // names stay as ordinary own keys, as before.
  const kept = currentAggregateSchema.parse({ evolution: { schema: 4, constructor: 2, prototype: 3 } });
  assert.equal(kept.evolution.constructor, 2);
  assert.equal(kept.evolution.prototype, 3);
});

test('a refusal keeps the reference issue code, path and message', () => {
  // The working tree produces the structural verdict from the key-free copy and
  // re-reports its issues from the same place, so a caller must see the issue
  // list the reference schema produced - not one path deeper. The transaction
  // entry check matches on `code` and `path`
  // (`domain-hotpath-20261024-entry-validation.test.js`), which is why this is
  // pinned rather than assumed.
  let compared = 0;
  for (const [label, document] of Object.entries(documents)) {
    let reference;
    try { preChangeAggregateSchema.parse(document); continue; } catch (error) { reference = error; }
    let current;
    try { currentAggregateSchema.parse(document); } catch (error) { current = error; }
    assert.ok(current, `${label}: the working tree must refuse what the reference refuses`);
    assert.deepEqual(current.issues, reference.issues, `${label}: the refusal must keep the reference issue code, path and message`);
    compared += 1;
  }
  assert.ok(compared >= 8, `only ${compared} refusals were compared; the differential must not be vacuous`);
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
