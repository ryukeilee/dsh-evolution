// The staged replay's per-element collection certificate.
//
// A cold replay saves once per absorbed record and the payload's collection
// arrays hold rows the working memory only ever replaces. With `elementChecks`
// enabled the staged save check judges each row's own text once per transaction,
// deep-freezes the row, and serializes only a small shell on the remaining saves.
//
// This file pins the claim the reuse rests on instead of asserting it in prose:
// on the same payload the element path and `assertTransactionSave()` must reach
// the same outcome (throw or not, same error), for records that are exactly the
// shapes a compositional check could get wrong - unrepresentable values, cycles,
// accessors, `toJSON`, the own-`__proto__` literal, sparse arrays, class
// instances and very deep values. It also pins what the certificate observably
// does: one serialization per row, the row and everything below it frozen, and
// no freeze when the check fell back to the whole document.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertStagedTransactionSave, assertTransactionSave, createStagedWindowChecks } from '../../lib/domain-storage.js';

function capture(run) {
  try {
    return { threw: false, value: run() };
  } catch (error) {
    return { threw: true, name: error?.name, message: error?.message };
  }
}
const outcome = (run) => {
  const { threw, name, message } = capture(run);
  return { threw, name, message };
};

const marker = (index) => Object.freeze({
  eventId: `evolution:measurement-completed:case-${index}`,
  eventType: 'measurement-completed',
  experimentId: `case-${index}`,
  appliedAt: '2026-10-28T00:00:00.000Z',
});
/** The payload the staged store is handed; `state` becomes `evolution`. */
const document = (state = {}) => ({
  evolution: { schema: 4, experiments: [], eventBridge: { schema: 1, applied: [marker(1)] }, ...state },
});
const elementsOf = () => createStagedWindowChecks({ elementChecks: true }).elements;
/** The element path, with no window certificate, so the window is walked. */
const checkWithElements = (payload, elements) => assertStagedTransactionSave(payload, new WeakMap(), null, elements);
const checkWhole = (payload) => assertTransactionSave(payload);

const deepValue = (depth, leaf = { done: true }) => {
  let value = leaf;
  for (let index = 0; index < depth; index += 1) value = { nested: value };
  return value;
};
const row = (extra = {}) => ({ id: 'record-1', status: 'measured', recordedAt: '2026-10-28T00:00:00.000Z', ...extra });

// [name, the collection array's contents, both checks must throw]
const cases = [
  ['a plain record', [row()], false],
  ['a record with nested objects and arrays', [row({ measurement: { latency: 1 }, tags: ['a', 'b'], evidence: { ok: true } }), row({ id: 'record-2' })], false],
  ['a record with a null prototype object', [row({ meta: Object.assign(Object.create(null), { a: 1 }) })], false],
  ['a record with values JSON writes as null', [row({ ratio: Number.NaN, cap: Number.POSITIVE_INFINITY })], false],
  ['a record with members JSON omits', [row({ skipped: undefined })], false],
  ['a record inside a nested array', [{ list: [row(), row({ id: 'record-3' })] }], false],
  ['a literal as a row value', [row({ note: '__proto__' })], false],
  ['a literal as a nested row value', [row({ notes: [{ text: '__proto__' }] })], false],
  ['a row owning the literal key', [JSON.parse('{"id":"record-1","__proto__":"leak"}')], false],
  ['a record holding a bigint', [row({ total: 10n })], true],
  ['a record holding a function', [row({ run() {} })], false],
  ['a record holding a symbol', [row({ value: Symbol('s') })], false],
  ['a circular record', (() => { const value = { id: 'cycle' }; value.self = value; return [value]; })(), true],
  ['a record with a throwing getter', [(() => {
    const value = { id: 'accessor' };
    Object.defineProperty(value, 'boom', { enumerable: true, get() { throw new TypeError('getter must not run'); } });
    return value;
  })()], true],
  ['a record with a throwing toJSON', [{ toJSON() { throw new TypeError('toJSON must not run'); } }], true],
  ['a class instance record', [new (class Record { constructor() { this.id = 'class'; } })()], false],
  ['a record holding a sparse array', [row({ values: [1, , 3] })], false],
  ['a very deep record', [deepValue(4000)], false],
  ['a very deep record carrying the literal', [deepValue(4000, { note: '__proto__' })], true],
  ['a shared nested object', (() => { const shared = { a: 1 }; return [row({ first: shared }), row({ id: 'record-2', second: shared })]; })(), false],
  ['an empty collection', [], false],
];

test('the element certificate reaches the same outcome as the whole-document check', () => {
  for (const [name, experiments, throws] of cases) {
    const payload = document({ experiments });
    const withElements = outcome(() => checkWithElements(payload, elementsOf()));
    const whole = outcome(() => checkWhole(document({ experiments })));
    assert.deepEqual(withElements, whole, `${name}: element path must match the whole-document check`);
    assert.equal(withElements.threw, throws, `${name}: pinned outcome`);
  }
});

test('a collection array the substitution cannot describe stays in the shell', () => {
  const subclass = new (class Records extends Array {})();
  subclass.push(row());
  for (const value of [subclass, Object.assign([row()], { toJSON: () => [] })]) {
    const payload = document({ experiments: value });
    assert.deepEqual(outcome(() => checkWithElements(payload, elementsOf())), outcome(() => checkWhole(payload)));
  }
});

test('each row is serialized once and frozen with everything below it', () => {
  const elements = elementsOf();
  const nested = { deep: [1, 2] };
  const record = row({ measurement: nested });
  const experiments = [record];
  const payload = document({ experiments });
  const original = JSON.stringify;
  let recordSerializations = 0;
  JSON.stringify = function counted(value, ...rest) {
    if (value === record) recordSerializations += 1;
    return original.call(JSON, value, ...rest);
  };
  try {
    checkWithElements(payload, elements);
    checkWithElements(payload, elements);
    checkWithElements(payload, elements);
  } finally {
    JSON.stringify = original;
  }
  assert.equal(recordSerializations, 1, 'a judged row must not be serialized again');
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(nested));
  assert.ok(Object.isFrozen(nested.deep));
  assert.equal(Object.isFrozen(experiments), false, 'the collection array itself stays live');
  assert.equal(Object.isFrozen(payload.evolution), false, 'the document stays live');
});

test('a new row is judged on its own save and the judged rows are reused', () => {
  const elements = elementsOf();
  const first = row();
  const second = row({ id: 'record-2' });
  const experiments = [first];
  checkWithElements(document({ experiments }), elements);
  assert.ok(Object.isFrozen(first));
  experiments.push(second);
  const original = JSON.stringify;
  const serialized = [];
  JSON.stringify = function counted(value, ...rest) {
    if (value === first || value === second) serialized.push(value === first ? 'first' : 'second');
    return original.call(JSON, value, ...rest);
  };
  try {
    checkWithElements(document({ experiments }), elements);
  } finally {
    JSON.stringify = original;
  }
  assert.deepEqual(serialized, ['second']);
  assert.ok(Object.isFrozen(second));
});

test('a fallback neither freezes nor certifies the row it could not prove', () => {
  const elements = elementsOf();
  const literal = row({ note: '__proto__' });
  const payload = document({ experiments: [literal] });
  assert.deepEqual(outcome(() => checkWithElements(payload, elements)), outcome(() => checkWhole(payload)));
  assert.equal(Object.isFrozen(literal), false, 'a literal row falls back and stays mutable');
  // A later save repeats the same fallback instead of believing a cached pass.
  assert.deepEqual(outcome(() => checkWithElements(payload, elements)), outcome(() => checkWhole(payload)));

  const bigint = row({ total: 10n });
  assert.deepEqual(outcome(() => checkWithElements(document({ experiments: [bigint] }), elementsOf())),
    outcome(() => checkWhole(document({ experiments: [bigint] }))));
  assert.equal(Object.isFrozen(bigint), false);
});

test('the element certificate is per transaction, not per value', () => {
  const record = row();
  const payload = document({ experiments: [record] });
  const original = JSON.stringify;
  let serializations = 0;
  JSON.stringify = function counted(value, ...rest) {
    if (value === record) serializations += 1;
    return original.call(JSON, value, ...rest);
  };
  try {
    checkWithElements(payload, elementsOf());
    checkWithElements(payload, elementsOf());
  } finally {
    JSON.stringify = original;
  }
  assert.equal(serializations, 2, 'two transactions judge the same row independently');
});

test('without the element memo the check stays the released one', () => {
  const record = row();
  const payload = document({ experiments: [record] });
  assert.deepEqual(outcome(() => assertStagedTransactionSave(payload, new WeakMap(), null)), outcome(() => checkWhole(payload)));
  assert.equal(Object.isFrozen(record), false);
  assert.equal(createStagedWindowChecks().elements, null);
  assert.equal(createStagedWindowChecks({ elementChecks: false }).elements, null);
});

test('the window certificate keeps working next to the element certificate', () => {
  const checks = createStagedWindowChecks({ elementChecks: true });
  const initial = Object.freeze([marker(1)]);
  checks.changed(null, initial, null);
  const record = row();
  const first = { evolution: { schema: 4, experiments: [record], eventBridge: { schema: 1, applied: initial } } };
  assertStagedTransactionSave(first, new WeakMap(), checks.windows, checks.elements);
  assert.equal(checks.windows.get(initial).verified, true);
  assert.ok(Object.isFrozen(record));
  // A successor window reports its one added marker; the element path runs too.
  const added = marker(2);
  const next = Object.freeze([initial[0], added]);
  checks.changed(initial, next, added);
  const successor = { evolution: { schema: 4, experiments: [record], eventBridge: { schema: 1, applied: next } } };
  assertStagedTransactionSave(successor, new WeakMap(), checks.windows, checks.elements);
  assert.equal(checks.windows.get(next).verified, true);
});
