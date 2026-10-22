// `mergeEventLedger()`: the union of the recovered marker map and the caller's.
//
// A transaction merges the marker table a caller hands in onto the one
// `installPending()` just installed, and an eventId both sides know with a
// different MAC is a conflict rather than an update.
//
// The differential below is the point of this file. A transaction walks the
// caller's table with `Object.keys()` and one indexed read per key instead of
// `Object.entries()`, which built a `[eventId, mac]` pair array for every marker
// the table holds only to read the two values straight back out of it. The
// reference body is the `Object.entries()` form, copied verbatim, and every case
// has to produce the same JSON text (key order included) or the same refusal.
//
// The cases include the four shapes an earlier attempt at removing work here got
// wrong, because they are the ones where "the same walk" is not obvious: a caller
// key whose name `{ ...recovered }` answers from `Object.prototype`
// (`__proto__`, `constructor`, `toString`, `hasOwnProperty`), a recovered marker
// whose value is `undefined`, a caller table in another order, and a table whose
// entries are not all own enumerable string keys (a symbol or a non-enumerable
// descriptor must stay invisible in both forms).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeEventLedger } from '../../lib/domain-storage.js';

const MAC = (index) => 'a'.repeat(56) + String(index).padStart(8, '0');

/** The pre-change implementation, verbatim, as the differential's reference. */
function referenceMergeEventLedger(recovered, applied) {
  if (!applied) return recovered;
  const merged = { ...recovered };
  for (const [eventId, mac] of Object.entries(applied)) {
    const known = merged[eventId];
    if (known !== undefined && known !== mac) throw new Error('E_DOMAIN_EVENT_ID_CONFLICT');
    merged[eventId] = mac;
  }
  return merged;
}

const outcome = (fn) => {
  try { return { text: JSON.stringify(fn()) }; } catch (error) { return { threw: String(error.message) }; }
};

/** An own `__proto__` key, which only a define or `JSON.parse` can create. */
const withOwnProto = (pairs) => JSON.parse(`{${pairs.map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`).join(',')}}`);

const CASES = {
  'covered, same order': () => [{ 'event-a': MAC(1), 'event-b': MAC(2) }, { 'event-a': MAC(1), 'event-b': MAC(2), 'event-c': MAC(3) }],
  'covered, caller order reversed': () => [{ 'event-a': MAC(1), 'event-b': MAC(2) }, { 'event-b': MAC(2), 'event-a': MAC(1) }],
  'covered, caller order interleaved': () => [{ 'event-a': MAC(1), 'event-b': MAC(2) }, { 'event-a': MAC(1), 'event-x': MAC(9), 'event-b': MAC(2) }],
  'covered, conflict': () => [{ 'event-a': MAC(1) }, { 'event-a': MAC(2) }],
  'uncovered marker, conflict': () => [{ 'event-r': MAC(9), 'event-a': MAC(1) }, { 'event-a': MAC(2) }],
  'recovered-only marker': () => [{ 'event-r': MAC(9), 'event-a': MAC(1) }, { 'event-a': MAC(1), 'event-new': MAC(7) }],
  'recovered marker with an undefined value': () => [{ 'event-a': undefined }, { 'event-a': MAC(1) }],
  'recovered marker with an undefined value and nothing else': () => [{ 'event-a': undefined }, { 'event-a': undefined }],
  'caller adds a key named __proto__': () => [{}, withOwnProto([['__proto__', MAC(1)]])],
  'caller adds a key named constructor': () => [{}, { constructor: MAC(1) }],
  'caller adds a key named toString': () => [{ 'event-a': MAC(1) }, { 'event-a': MAC(1), toString: MAC(2) }],
  'caller adds a key named hasOwnProperty': () => [{ 'event-a': MAC(1) }, { 'event-a': MAC(1), hasOwnProperty: MAC(2) }],
  'recovered owns __proto__, caller agrees': () => [withOwnProto([['__proto__', MAC(1)]]), withOwnProto([['__proto__', MAC(1)]])],
  'recovered owns __proto__, caller disagrees': () => [withOwnProto([['__proto__', MAC(1)]]), withOwnProto([['__proto__', MAC(2)]])],
  'both empty': () => [{}, {}],
  'caller adds a non-string value for a new key': () => [{ 'event-r': MAC(9) }, { 'event-x': 7 }],
  'caller replaces a recovered marker with a non-string value': () => [{ 'event-a': MAC(1) }, { 'event-a': 42 }],
  'caller map is smaller than the recovered map': () => [{ 'event-a': MAC(1), 'event-b': MAC(2) }, { 'event-a': MAC(1) }],
  'integer-like keys': () => [{ 2: MAC(2), 1: MAC(1), 'event-a': MAC(3) }, { 'event-a': MAC(3), 1: MAC(1), 2: MAC(2) }],
  'symbol-keyed caller entry is invisible to both forms': () => {
    const applied = { 'event-a': MAC(1) };
    Object.defineProperty(applied, Symbol('event-s'), { value: MAC(2), enumerable: true, writable: true, configurable: true });
    return [{ 'event-r': MAC(9), 'event-a': MAC(1) }, applied];
  },
  'non-enumerable caller entry is invisible to both forms': () => {
    const applied = { 'event-a': MAC(1) };
    Object.defineProperty(applied, 'event-hidden', { value: MAC(2), enumerable: false, writable: true, configurable: true });
    return [{ 'event-r': MAC(9), 'event-a': MAC(1) }, applied];
  },
  'large covered ledger': () => {
    const recovered = {}, applied = {};
    for (let index = 0; index < 5000; index += 1) recovered[`event-${index}`] = MAC(index);
    for (const [key, value] of Object.entries(recovered)) applied[key] = value;
    for (let index = 5000; index < 5003; index += 1) applied[`event-${index}`] = MAC(index);
    return [recovered, applied];
  },
  'the shape `replay()` hands in (spread plus assigned MACs)': () => {
    const recovered = {};
    for (let index = 0; index < 300; index += 1) recovered[`evolution:measurement-completed:bench-${index}`] = MAC(index);
    const applied = { ...recovered };
    for (let index = 300; index < 303; index += 1) applied[`evolution:measurement-completed:bench-${index}`] = MAC(index);
    return [recovered, applied];
  },
};

test('every case produces the pre-change bytes, or the pre-change refusal', () => {
  for (const [name, build] of Object.entries(CASES)) {
    const [recovered, applied] = build();
    assert.deepEqual(outcome(() => mergeEventLedger(recovered, applied)), outcome(() => referenceMergeEventLedger(recovered, applied)), name);
  }
});

test('a key whose name comes from the prototype is refused, not published', () => {
  // `{ ...recovered }` answers `constructor` from `Object.prototype`, so the copy
  // loop reports a conflict for a caller key of that name. The keyed walk has to
  // read the copy the same way.
  for (const key of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    const applied = key === '__proto__' ? withOwnProto([['__proto__', MAC(1)]]) : { [key]: MAC(1) };
    assert.throws(() => mergeEventLedger({}, applied), /E_DOMAIN_EVENT_ID_CONFLICT/, key);
    assert.throws(() => mergeEventLedger({ 'event-a': MAC(1) }, { 'event-a': MAC(1), [key]: MAC(2) }), /E_DOMAIN_EVENT_ID_CONFLICT/, key);
  }
});

test('neither input is written to', () => {
  const recovered = { 'event-r': MAC(9), 'event-a': MAC(1) };
  const applied = { 'event-a': MAC(1), 'event-new': MAC(7) };
  const recoveredBefore = JSON.stringify(recovered);
  const appliedBefore = JSON.stringify(applied);
  mergeEventLedger(recovered, applied);
  assert.equal(JSON.stringify(recovered), recoveredBefore);
  assert.equal(JSON.stringify(applied), appliedBefore);
});

test('the recovered markers are returned untouched when the caller has no ledger', () => {
  const recovered = { 'event-a': MAC(1) };
  assert.equal(mergeEventLedger(recovered, undefined), recovered);
  assert.equal(mergeEventLedger(recovered, null), recovered);
});

test('an empty caller table still copies, so the live document is never advertised', () => {
  const recovered = { 'event-a': MAC(1) };
  const merged = mergeEventLedger(recovered, {});
  assert.notEqual(merged, recovered);
  assert.deepEqual(merged, recovered);
});

test('the published table keeps the recovered order and appends the caller keys in its order', () => {
  const recovered = { 'event-b': MAC(2), 'event-a': MAC(1) };
  const applied = { 'event-a': MAC(1), 'event-new-b': MAC(8), 'event-b': MAC(2), 'event-new-a': MAC(7) };
  assert.deepEqual(Object.keys(mergeEventLedger(recovered, applied)),
    ['event-b', 'event-a', 'event-new-b', 'event-new-a']);
});
