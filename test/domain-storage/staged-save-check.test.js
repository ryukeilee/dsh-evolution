// The staged transaction's save check against the whole-document check it
// replaces on the common path.
//
// A cold replay saves once per absorbed record, and 96% of every payload is the
// bridge marker window, which does not change between saves except by one
// appended marker (`lib/dockyard-domain/memory.js` freezes each marker as it
// appends it). `assertStagedTransactionSave()` therefore judges the window one
// marker at a time and serializes the rest of the document per save, falling
// back to the unmodified `assertTransactionSave()` on the unmodified payload
// whenever it cannot prove that substitution is exact.
//
// This file pins that claim instead of asserting it in prose: every case below
// runs both functions on the same payload and requires the same outcome, and
// the cases are the shapes where a compositional check could drift - the
// literal, the recursive copy, a cycle, an unrepresentable value, an accessor, a
// `toJSON`, a window that is not the shape the store produced, and a marker
// that is shared with the rest of the document.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertStagedTransactionSave, assertTransactionSave } from '../../lib/domain-storage.js';

/** Run a call and report what it did, without letting the throw escape. */
function capture(run) {
  try {
    return { threw: false, value: run() };
  } catch (error) {
    return { threw: true, name: error?.name, message: error?.message };
  }
}

/** What a call did, without the value it produced (the checks return nothing). */
const outcome = (run) => {
  const { threw, name, message } = capture(run);
  return { threw, name, message };
};

const marker = (index, extra = {}) => Object.freeze({
  eventId: `evolution:measurement-completed:case-${index}`,
  eventType: 'measurement-completed',
  experimentId: `case-${index}`,
  appliedAt: '2026-10-28T00:00:00.000Z',
  ...extra,
});

/** The document the staged store is handed, with a bridge window of `window`. */
const document = (window, { bridge = {}, state = {} } = {}) => ({
  evolution: { schema: 4, experiments: [], eventBridge: { schema: 1, applied: window, ...bridge }, ...state },
});

const sharedMarker = marker('shared', { note: '__proto__' });
const circular = document([marker(1)]);
circular.evolution.experiments.push(circular.evolution);

const cases = [
  // [name, payload, the check's memoized path runs, both checks must throw]
  ['no evolution member', {}, false, false],
  ['evolution is not an object', { evolution: 4 }, false, false],
  ['no eventBridge', { evolution: { schema: 4 } }, false, false],
  ['eventBridge without a window', { evolution: { schema: 4, eventBridge: { schema: 1 } } }, false, false],
  ['the window is not an array', { evolution: { schema: 4, eventBridge: { schema: 1, applied: {} } } }, false, false],
  ['an empty window', document([]), false, false],
  ['one frozen marker', document([marker(1)]), true, false],
  ['a full window of frozen markers', document(Array.from({ length: 4096 }, (unused, index) => marker(index))), true, false],
  ['a marker that is not frozen', document([{ eventId: 'x', eventType: 'y', experimentId: 'z', appliedAt: 'w' }]), false, false],
  ['a marker with a nested object', document([marker(1, { nested: { deep: [1, 2] } })]), false, false],
  ['a marker that is an array', document([Object.freeze([1, 2, 3])]), false, false],
  ['a sparse window', document([marker(1), , marker(3)]), false, false],
  ['a window holding a primitive', document([marker(1), 'marker']), false, false],
  ['a window holding a function', document([marker(1), () => 1]), false, false],
  ['marker values that JSON writes as null', document([marker(1, { ratio: Number.NaN, cap: Number.POSITIVE_INFINITY })]), true, false],
  ['marker values that JSON omits', document([marker(1, { skipped: undefined })]), false, false],
  ['a marker whose value is the literal as a string', document([marker(1, { note: '__proto__' })]), false, false],
  ['a marker that owns the literal key', document([JSON.parse('{"eventId":"a","eventType":"b","experimentId":"c","appliedAt":"d","__proto__":"leak"}')]
    .map((value) => Object.freeze(value))), false, false],
  ['the literal only in the second marker', document([marker(1), marker(2, { note: '__proto__' })]), false, false],
  ['the literal in the rest of the document', document([marker(1)], { state: { note: '__proto__' } }), false, false],
  ['the literal in a record that shares a marker', document([sharedMarker], { state: { experiments: [{ ref: sharedMarker }] } }), false, false],
  ['a marker shared by two window slots', document([sharedMarker, sharedMarker]), false, false],
  ['a bigint inside a record', document([marker(1)], { state: { total: 10n } }), false, true],
  ['a bigint inside a marker', document([Object.freeze({ eventId: 1n })]), false, true],
  ['a circular record', { evolution: { schema: 4, eventBridge: { schema: 1, applied: [marker(1)] }, experiments: [circular.evolution] } }, false, true],
  ['a throwing getter in a record', (() => {
    const payload = document([marker(1)]);
    Object.defineProperty(payload.evolution, 'boom', { enumerable: true, get() { throw new TypeError('getter must not run'); } });
    return payload;
  })(), false, true],
  ['a throwing toJSON in a record', (() => {
    const payload = document([marker(1)]);
    payload.evolution.nested = { toJSON() { throw new TypeError('toJSON must not run'); } };
    return payload;
  })(), false, true],
  ['a toJSON on the state', (() => {
    const payload = document([marker(1)]);
    payload.evolution.toJSON = () => ({ replaced: true });
    return payload;
  })(), false, false],
  ['a toJSON on eventBridge', (() => {
    const payload = document([marker(1)]);
    payload.evolution.eventBridge.toJSON = () => ({ schema: 1, applied: [] });
    return payload;
  })(), false, false],
  ['an accessor for evolution', (() => {
    const payload = { evolution: document([marker(1)]).evolution };
    Object.defineProperty(payload, 'evolution', { enumerable: true, configurable: true,
      get() { return document([marker(1)]).evolution; } });
    return payload;
  })(), false, false],
  ['an accessor for eventBridge', (() => {
    const payload = document([marker(1)]);
    const bridge = payload.evolution.eventBridge;
    Object.defineProperty(payload.evolution, 'eventBridge', { enumerable: true, configurable: true,
      get() { return bridge; } });
    return payload;
  })(), false, false],
  ['an accessor for the window', (() => {
    const payload = document([marker(1)]);
    const window = payload.evolution.eventBridge.applied;
    Object.defineProperty(payload.evolution.eventBridge, 'applied', { enumerable: true, configurable: true,
      get() { return window; } });
    return payload;
  })(), false, false],
  ['a marker with a non-enumerable toJSON answering undefined', (() => {
    const value = { eventId: 'a', eventType: 'b', experimentId: 'c', appliedAt: 'd' };
    Object.defineProperty(value, 'toJSON', { value: () => undefined });
    return document([Object.freeze(value)]);
  })(), false, false],
  ['a marker with a non-enumerable toJSON carrying the literal', (() => {
    const value = { eventId: 'a', eventType: 'b', experimentId: 'c', appliedAt: 'd' };
    Object.defineProperty(value, 'toJSON', { value: () => ({ note: '__proto__' }) });
    return document([Object.freeze(value)]);
  })(), false, false],
  ['a window with its own toJSON', (() => {
    const payload = document([marker(1)]);
    Object.defineProperty(payload.evolution.eventBridge.applied, 'toJSON', { value: () => 'window' });
    return payload;
  })(), false, false],
  ['a window whose toJSON throws', (() => {
    const payload = document([marker(1)]);
    Object.defineProperty(payload.evolution.eventBridge.applied, 'toJSON', { value() { throw new TypeError('window toJSON'); } });
    return payload;
  })(), false, true],
  ['a window from an array subclass', (() => {
    class Window extends Array {}
    const payload = document(new Window());
    payload.evolution.eventBridge.applied.push(marker(1));
    return payload;
  })(), false, false],
  ['a non-enumerable evolution member', (() => {
    const payload = document([marker(1)]);
    const state = payload.evolution;
    delete payload.evolution;
    Object.defineProperty(payload, 'evolution', { value: state, enumerable: false });
    return payload;
  })(), false, false],
  ['a non-enumerable window', (() => {
    const payload = document([marker(1)]);
    const window = payload.evolution.eventBridge.applied;
    delete payload.evolution.eventBridge.applied;
    Object.defineProperty(payload.evolution.eventBridge, 'applied', { value: window, enumerable: false });
    return payload;
  })(), false, false],
  ['a toJSON on the payload itself', (() => {
    const payload = document([marker(1)]);
    payload.toJSON = () => ({ evolution: { schema: 4 } });
    return payload;
  })(), false, false],
  ['undefined', undefined, false, true],
  ['null', null, false, false],
  ['a string payload', 'payload', false, false],
];

test('the staged save check reaches the same verdict as the whole-document check', () => {
  for (const [name, payload, memoPath, shouldThrow] of cases) {
    const verdicts = new WeakMap();
    const whole = outcome(() => assertTransactionSave(payload));
    // A fresh memo per case is what a store that has not seen these markers yet
    // has; the memo-reuse case below is the other half.
    const staged = outcome(() => assertStagedTransactionSave(payload, verdicts));
    assert.deepEqual(staged, whole, `${name}: the staged check must agree with assertTransactionSave()`);
    assert.equal(staged.threw, shouldThrow, `${name}: the documented outcome must be the one both checks reach`);
    // A verdict may only ever be remembered for a value this check can judge
    // once: a frozen flat marker. Everything else has to keep taking the
    // whole-document check, which is what makes the two verdicts the same by
    // construction rather than by agreement. (A payload can hold verdicts and
    // still fall back later - a hole in the window, for instance - so this does
    // not assert the fallback itself.)
    const window = payload?.evolution?.eventBridge?.applied;
    const entries = Array.isArray(window) ? window : [];
    for (const entry of entries) {
      if (!verdicts.has(entry)) continue;
      assert.ok(entry && typeof entry === 'object' && !Array.isArray(entry) && Object.isFrozen(entry),
        `${name}: only a frozen object may be judged once`);
      for (const value of Object.values(entry)) {
        assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value),
          `${name}: only a flat JSON record may be judged once`);
      }
    }
    if (!memoPath) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Object.isFrozen(entry) === false) continue;
      assert.equal(typeof verdicts.get(entry), 'boolean', `${name}: the window must be judged one marker at a time`);
    }
  }
});

test('the staged save check reuses a memoized marker instead of serializing it again', () => {
  // A frozen proxy counts the property reads `JSON.stringify` and the marker
  // predicate make. The first call must read it; the second call, on a payload
  // whose window is otherwise unchanged, must not read it at all. That is the
  // property the whole saving depends on, and it cannot be observed from the
  // verdict alone.
  let reads = 0;
  const target = Object.freeze({ eventId: 'evolution:measurement-completed:probe', eventType: 'measurement-completed',
    experimentId: 'probe', appliedAt: '2026-10-28T00:00:00.000Z' });
  const counted = new Proxy(target, {
    get(object, key, receiver) { reads += 1; return Reflect.get(object, key, receiver); },
    getOwnPropertyDescriptor(object, key) { reads += 1; return Reflect.getOwnPropertyDescriptor(object, key); },
  });
  const payload = document([counted]);
  const verdicts = new WeakMap();
  assertStagedTransactionSave(payload, verdicts);
  const afterFirst = reads;
  assert.ok(afterFirst > 0, 'the first call must read the marker');
  assert.equal(verdicts.get(counted), false);
  assertStagedTransactionSave(payload, verdicts);
  assert.equal(reads, afterFirst, 'a memoized marker must not be read again');
});

test('an envelope member that answers differently per read keeps the whole-document check', () => {
  // The substitution reads `payload.evolution`, `state.eventBridge` and
  // `bridge.applied` directly and then re-creates the document around them. For
  // an accessor those are two reads where `JSON.stringify` would make one, so
  // the check refuses the substitution instead of guessing. Each factory below
  // answers the first read with the real value and throws on the second: the
  // whole-document check reads once and accepts, and the staged check must reach
  // the same verdict by falling back rather than by reading twice.
  const oneShot = (target, key, value) => {
    let reads = 0;
    Object.defineProperty(target, key, { enumerable: true, configurable: true, get() {
      reads += 1;
      if (reads > 1) throw new TypeError(`second read of ${key}`);
      return value;
    } });
  };
  const factories = {
    evolution: () => {
      const payload = document([marker(1)]);
      const state = payload.evolution;
      oneShot(payload, 'evolution', state);
      return payload;
    },
    // Sibling members of the window: the substitution copies the whole document,
    // so an accessor anywhere on it would be read a second time by a fallback.
    // The window below holds an unfrozen marker, which is what makes the check
    // fall back after it has read the document once.
    siblingOfTheWindow: () => {
      const payload = document([{ eventId: 'x', eventType: 'y', experimentId: 'z', appliedAt: 'w' }]);
      oneShot(payload.evolution, 'note', { value: 1 });
      return payload;
    },
    siblingOfTheState: () => {
      const payload = document([marker(1)]);
      oneShot(payload, 'other', { value: 2 });
      return payload;
    },
    eventBridge: () => {
      const payload = document([marker(1)]);
      oneShot(payload.evolution, 'eventBridge', payload.evolution.eventBridge);
      return payload;
    },
    applied: () => {
      const payload = document([marker(1)]);
      oneShot(payload.evolution.eventBridge, 'applied', payload.evolution.eventBridge.applied);
      return payload;
    },
  };
  for (const [key, make] of Object.entries(factories)) {
    const whole = outcome(() => assertTransactionSave(make()));
    assert.equal(whole.threw, false, `${key}: the whole-document check reads the member once`);
    const verdicts = new WeakMap();
    const staged = outcome(() => assertStagedTransactionSave(make(), verdicts));
    assert.deepEqual(staged, whole, `${key}: the staged check must not read the member twice`);
    assert.equal(verdicts.size ?? 0, 0, `${key}: a payload it cannot substitute must not be memoized`);
  }
});

test('a marker whose own toJSON answers differently per read keeps the whole-document check', () => {
  // `memoizableMarker()` refuses any marker that carries its own `toJSON`: the
  // element's text would then be a function of code rather than of the frozen
  // value, and the second save would reuse a verdict about a text that no longer
  // holds. A fresh payload per side is what makes the two runs comparable.
  const make = () => {
    let reads = 0;
    const value = { eventId: 'a', eventType: 'b', experimentId: 'c', appliedAt: 'd' };
    Object.defineProperty(value, 'toJSON', { value() {
      reads += 1;
      return reads === 1 ? { note: 'plain' } : { note: '__proto__' };
    } });
    return document([Object.freeze(value)]);
  };
  const whole = outcome(() => assertTransactionSave(make()));
  assert.equal(whole.threw, false, 'the whole-document check reads the marker once');
  const verdicts = new WeakMap();
  const staged = outcome(() => assertStagedTransactionSave(make(), verdicts));
  assert.deepEqual(staged, whole, 'the staged check must not memoize a marker whose text can change');
});

test('a marker that carries its own toJSON is never memoized', () => {
  // The memo is only sound while a marker's text cannot change, so a marker that
  // carries its own `toJSON` must not be memoized even though it is frozen and
  // its own fields are primitives. That is asserted on the memo itself: the
  // consequence - a later save reaching a different verdict - would need the
  // recursive copy to overflow, which depends on the stack this runs in.
  const withToJSON = { eventId: 'a', eventType: 'b', experimentId: 'c', appliedAt: 'd' };
  Object.defineProperty(withToJSON, 'toJSON', { value: () => ({ note: 'plain' }) });
  const marker_ = Object.freeze(withToJSON);
  const payload = document([marker_]);
  const verdicts = new WeakMap();
  assert.equal(outcome(() => assertStagedTransactionSave(payload, verdicts)).threw, false);
  assert.equal(verdicts.has(marker_), false, 'a marker whose text is produced by code cannot be judged once');
  // The same marker without its `toJSON` is what the memo is for.
  const plainMarker = Object.freeze({ eventId: 'a', eventType: 'b', experimentId: 'c', appliedAt: 'd' });
  const other = new WeakMap();
  assert.equal(outcome(() => assertStagedTransactionSave(document([plainMarker]), other)).threw, false);
  assert.equal(other.get(plainMarker), false, 'a frozen flat marker is judged once');
});

test('a document carrying the literal runs the whole-document check', () => {
  // The recursive own-`__proto__` copy the literal triggers is what can overflow
  // a deep document, so this check must not judge only part of the document. Its
  // consequence is a stack overflow, which depends on the environment; the part
  // that does not is the memo, and both places the literal can be found leave
  // their own mark on it.
  const inTheBody = marker(1);
  const bodyVerdicts = new WeakMap();
  const bodyPayload = document([inTheBody], { state: { note: '__proto__' } });
  assert.equal(outcome(() => assertStagedTransactionSave(bodyPayload, bodyVerdicts)).threw, false);
  assert.equal(bodyVerdicts.has(inTheBody), false, 'the body literal must send the whole document through the check');

  // A literal that only the window carries is found while judging it: the marker
  // itself is judged (its verdict is the literal), and the markers behind it are
  // not judged at all because the document goes through the whole-document check
  // instead.
  const before = marker(2);
  const inTheWindow = marker(3, { note: '__proto__' });
  const behind = marker(4);
  const windowVerdicts = new WeakMap();
  const windowPayload = document([before, inTheWindow, behind]);
  assert.equal(outcome(() => assertStagedTransactionSave(windowPayload, windowVerdicts)).threw, false);
  assert.equal(windowVerdicts.get(before), false, 'a marker before the literal is judged once');
  assert.equal(windowVerdicts.get(inTheWindow), true, 'the literal marker is judged once, as the literal');
  assert.equal(windowVerdicts.has(behind), false, 'nothing behind the literal marker is judged');
});

test('a payload the staged check cannot reason about keeps the whole-document error', () => {
  // A window that is frozen but not flat still takes the fallback, so the throw
  // and its position are the ones `JSON.stringify` produces on the whole
  // document.
  const shared = Object.freeze({ eventId: 'a', eventType: 'b', experimentId: 'c', appliedAt: 'd', nested: { deep: true } });
  const payload = document([shared, Object.freeze({ eventId: 'e', value: 1n })]);
  const whole = outcome(() => assertTransactionSave(payload));
  const staged = outcome(() => assertStagedTransactionSave(payload, new WeakMap()));
  assert.deepEqual(staged, whole);
  assert.equal(staged.threw, true);
  assert.equal(staged.name, 'TypeError');
});
