import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { evolutionDomainSpec, openDomainStorage } from '../../lib/domain-storage.js';
import { digestApplied } from '../../lib/event-log-checkpoint.js';
import { signEventBridgeEnvelope } from '../../lib/orchestrator.js';

const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

/**
 * Contract tests for the observable behaviour of `digestApplied`.
 *
 * `digestApplied(applied)` is `sha256(JSON.stringify(applied))`, and it is what a
 * replay checkpoint stores so that a committed marker map that moved behind the
 * port's back can be detected. The committed implementation serializes and hashes
 * on every call.
 *
 * This file was written against a withdrawn attempt at that optimization: a hit
 * skipped both the serialization and the hash for a root it could prove is an
 * inert JSON table, i.e. a root that is
 *
 *   - not a Proxy, not an Array, not a boxed primitive, not a module namespace
 *     object, not a `JSON.rawJSON` wrapper;
 *   - prototype is `Object.prototype` or `null`;
 *   - no `toJSON` descriptor on the root or on `Object.prototype` (own or
 *     inherited), because `JSON.stringify` calls it without it appearing in
 *     `Object.keys()`;
 *   - every key is an own enumerable string key with a data descriptor;
 *   - the snapshot is taken by pure reflection (no getter invocation) before the
 *     serialization, the whole admission is re-checked on every call, and a hit
 *     compares the complete key/value list, order included.
 *
 * Everything below is therefore written as *observable-behaviour* equivalence
 * with the single-serialization implementation: same digest, same thrown value,
 * same reads, same number of reads, and (for a Proxy root) the same trap trace.
 * Nothing here inspects how a cache would store anything, so the committed
 * implementation passes every test in this file.
 *
 * The attempt does not, and that is why it was withdrawn: a table that is inert as
 * far as `JSON` is concerned still digests through `crypto`, and a hit that skips
 * hashing cannot reproduce that boundary (see the crypto boundary section below).
 * What follows is not a description of a correct cache - it is the set of shapes
 * and failure modes a hit path has to survive, and the counterexamples that ended
 * the attempt are pinned here:
 *
 *   - an identity-keyed `WeakMap` throws on `undefined` and answers a mutated map
 *     from memory (tests 8, 11, 13);
 *   - a snapshot-taken-after-the-serialization cache stores the state *after* the
 *     reads it just made, so a self-mutating getter serves a stale digest (test 9);
 *   - a cache that re-checks by reading `applied[key]` invokes an accessor the
 *     serialization would have invoked once, i.e. one extra observable read
 *     (test 10);
 *   - a cache that tests descriptor membership with `'value' in descriptor` reads
 *     `Object.prototype.value` for every accessor descriptor, which is an extra
 *     read (or an exception) the serialization never performs, and can even treat
 *     a getter as data (test 17);
 *   - a cache that fills its snapshot container through `container[index] = value`
 *     while the container still inherits from `Object.prototype` runs an inherited
 *     numeric setter and silently loses the element (test 17);
 *   - a cache that trusts root keys/values only misses `toJSON` on the root's
 *     prototype, boxed wrappers behind a reset prototype, `JSON.rawJSON`, and
 *     nested mutables (tests 5, 6, 11, 12, 13);
 *   - a cache that sniffs with `instanceof`, `Object.prototype.toString`, or
 *     `String(value)` either admits a fake boxed wrapper or invokes a conversion
 *     the serialization never performs (test 12);
 *   - a cache that probes the root with `in`/`Object.getPrototypeOf` adds Proxy
 *     traps that the serialization never triggers (tests 2, 3, 14);
 *   - a hit path that forwards the text as `update.call(hash, text)` reads `call`
 *     off the native function, that reuses a digest produced while
 *     `crypto.createHash` was replaced, or that answers from memory a call whose
 *     hashing throws leaves the crypto boundary, which is what ended the attempt.
 *
 * Every differential builds its input *fresh* on both sides, so reading the
 * production input cannot pollute the reference, and vice versa. Where an input is
 * inherently single-shot both sides are asserted against the literal text that the
 * specification says the serialization produces.
 */
const KEY = 'b'.repeat(64);
const MARKER = 'evolution:measurement-completed:';
const marker = (id) => `${MARKER}${id}`;
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
/** Reference digest for a value that was just constructed for this assertion alone. */
const freshDigest = (value) => sha256(JSON.stringify(value));
/** Reference digest from the exact text, without touching any input object. */
const digestOfText = sha256;

function capture(run) {
  try { return { value: run() }; } catch (error) { return { error }; }
}
function throwsIdentity(run, sentinel, message) {
  const outcome = capture(run);
  assert.ok(outcome.error, `${message}: expected the call to throw`);
  assert.equal(outcome.error, sentinel, `${message}: the thrown value must be the same object`);
}
function throwsMatching(run, pattern, message) {
  const outcome = capture(run);
  assert.ok(outcome.error, `${message}: expected the call to throw`);
  assert.match(String(outcome.error?.message ?? outcome.error), pattern, message);
  return outcome.error;
}

const trapLabel = (key) => (typeof key === 'symbol' ? `@@${key.description ?? 'symbol'}` : String(key));
/**
 * A Proxy that records every trap an implementation could trip. It deliberately
 * records more operations than `JSON.stringify` uses, so a candidate that probes
 * the root before serializing shows up as extra entries instead of passing
 * unnoticed.
 */
function traced(target, log) {
  return new Proxy(target, {
    get(t, key, receiver) { log.push(`get:${trapLabel(key)}`); return Reflect.get(t, key, receiver); },
    has(t, key) { log.push(`has:${trapLabel(key)}`); return Reflect.has(t, key); },
    ownKeys(t) { log.push('ownKeys'); return Reflect.ownKeys(t); },
    getOwnPropertyDescriptor(t, key) {
      log.push(`gopd:${trapLabel(key)}`); return Reflect.getOwnPropertyDescriptor(t, key);
    },
    getPrototypeOf(t) { log.push('getPrototypeOf'); return Reflect.getPrototypeOf(t); },
    setPrototypeOf(t, proto) { log.push('setPrototypeOf'); return Reflect.setPrototypeOf(t, proto); },
    defineProperty(t, key, descriptor) {
      log.push(`defineProperty:${trapLabel(key)}`); return Reflect.defineProperty(t, key, descriptor);
    },
    deleteProperty(t, key) { log.push(`delete:${trapLabel(key)}`); return Reflect.deleteProperty(t, key); },
  });
}
/** Compare the traps one digest call trips with the traps one serialization trips. */
function assertSameTrapTrace(build, message) {
  const referenceLog = [];
  const reference = build(referenceLog);
  const referenceText = JSON.stringify(reference);
  const referenceTrace = [...referenceLog];
  assert.ok(referenceTrace.length > 0, `${message}: the probe itself must be observable`);

  const digestLog = [];
  const table = build(digestLog);
  const first = digestLog.length;
  const digest = digestApplied(table);
  const firstTrace = digestLog.slice(first);
  assert.deepEqual(firstTrace, referenceTrace,
    `${message}: one digest call must trip exactly the traps one serialization trips`);
  assert.equal(digest, sha256(referenceText), `${message}: the digest must be the serialization's`);
  for (const forbidden of ['getPrototypeOf', 'has:toJSON', 'setPrototypeOf']) {
    assert.equal(firstTrace.includes(forbidden), false,
      `${message}: the digest must not probe the root with ${forbidden}`);
  }

  const secondStart = digestLog.length;
  const second = digestApplied(table);
  const secondTrace = digestLog.slice(secondStart);
  assert.deepEqual(secondTrace, referenceTrace,
    `${message}: a second call must run the serialization again, not answer from memory`);
  assert.equal(second, digest, `${message}: a repeated call must agree`);
  return firstTrace;
}

// --- 1. the stable case -------------------------------------------------------

test('a stable marker map digests to sha256 of its exact text, every call', () => {
  const table = { [marker('a')]: A, [marker('b')]: B };
  const expected = digestOfText(`{"${marker('a')}":"${A}","${marker('b')}":"${B}"}`);
  for (let call = 1; call <= 3; call += 1) {
    assert.equal(digestApplied(table), expected, `call ${call} must digest the text it produced`);
  }
  assert.equal(digestApplied({}), digestOfText('{}'), 'an empty map is the empty object text');
});

// --- 2. Proxy roots: exact trap trace, no probe, no memory --------------------

test('a Proxy root is digested through exactly the traps a serialization trips', () => {
  const symbol = Symbol('not-a-marker');
  const build = (log) => {
    const target = {};
    Object.defineProperty(target, 'hidden', { value: 'H', enumerable: false, configurable: true, writable: true });
    target[marker('a')] = A;
    target[symbol] = 'symbol value';
    Object.defineProperty(target, marker('b'), { enumerable: true, configurable: true, get: () => B });
    return traced(target, log);
  };
  const trace = assertSameTrapTrace(build, 'Proxy root');
  assert.equal(trace.includes(`get:${trapLabel(symbol)}`), false, 'a symbol key is never read');
  assert.equal(trace.includes(`gopd:${trapLabel(symbol)}`), false, 'a symbol key is never described');
  assert.ok(trace.includes('gopd:hidden'), 'the enumeration check still describes a non-enumerable key');
  assert.equal(trace.includes('get:hidden'), false, 'a non-enumerable key is never read');

  // A cache that probed the root, or answered the second call from memory, would
  // have tripped fewer (or different) traps; both calls are pinned above.
  const changing = [];
  let reads = 0;
  const dynamic = traced({ [marker('d')]: A }, changing);
  assert.equal(digestApplied(dynamic), digestOfText(`{"${marker('d')}":"${A}"}`));
  reads += 1;
  assert.equal(reads, 1);
});

test('a Proxy root whose reads change between calls is always re-serialized', () => {
  let value = A;
  const log = [];
  const table = new Proxy({ [marker('a')]: A }, {
    get(target, key, receiver) {
      log.push(`get:${trapLabel(key)}`);
      return key === marker('a') ? value : Reflect.get(target, key, receiver);
    },
    ownKeys(target) { log.push('ownKeys'); return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) {
      log.push(`gopd:${trapLabel(key)}`); return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  const first = digestApplied(table);
  assert.equal(first, digestOfText(`{"${marker('a')}":"${A}"}`));
  assert.deepEqual(log, ['get:toJSON', 'ownKeys', `gopd:${marker('a')}`, `get:${marker('a')}`]);
  value = C;
  assert.equal(digestApplied(table), digestOfText(`{"${marker('a')}":"${C}"}`),
    'a Proxy is never a cacheable root');
  assert.notEqual(digestApplied(table), first);
});

// --- 3. Proxy values inside a plain root --------------------------------------

test('a Proxy value inside a plain root is digested with the same trap trace', () => {
  const build = (log) => ({ [marker('a')]: A, nested: traced({ deep: 'value' }, log) });
  assertSameTrapTrace(build, 'nested Proxy');

  let produced = 'first';
  const dynamic = new Proxy({ deep: 'first' }, {
    get(target, key, receiver) {
      if (key === 'deep') return produced;
      return Reflect.get(target, key, receiver);
    },
  });
  const table = { [marker('a')]: A, nested: dynamic };
  const first = digestApplied(table);
  assert.equal(first, digestOfText(`{"${marker('a')}":"${A}","nested":{"deep":"first"}}`));
  produced = 'second';
  assert.equal(digestApplied(table),
    digestOfText(`{"${marker('a')}":"${A}","nested":{"deep":"second"}}`));
  assert.notEqual(digestApplied(table), first);
});

// --- 4. thrown values keep their identity -------------------------------------

test('a value thrown during the serialization is rethrown unchanged, on every call', () => {
  const sentinel = new Error('digest sentinel');
  sentinel.marker = 'sentinel';

  const trapSentinel = new Error('trap sentinel');
  const trapProxy = new Proxy({}, {
    ownKeys() { throw trapSentinel; },
  });
  throwsIdentity(() => digestApplied(trapProxy), trapSentinel, 'trap throw (1)');
  throwsIdentity(() => digestApplied(trapProxy), trapSentinel, 'trap throw (2)');

  let getterReads = 0;
  const getterTable = {};
  Object.defineProperty(getterTable, marker('a'), { enumerable: true, configurable: true,
    get() { getterReads += 1; throw sentinel; } });
  throwsIdentity(() => digestApplied(getterTable), sentinel, 'getter throw (1)');
  throwsIdentity(() => digestApplied(getterTable), sentinel, 'getter throw (2)');
  assert.equal(getterReads, 2, 'one read per call, and the second call still throws');

  const toJSONTable = { [marker('a')]: A };
  Object.defineProperty(toJSONTable, 'toJSON', { enumerable: false, configurable: true,
    value() { throw sentinel; } });
  throwsIdentity(() => digestApplied(toJSONTable), sentinel, 'toJSON throw (1)');
  throwsIdentity(() => digestApplied(toJSONTable), sentinel, 'toJSON throw (2)');

  const boxed = new String('a');
  Object.defineProperty(boxed, Symbol.toPrimitive, { configurable: true, get() { throw sentinel; } });
  throwsIdentity(() => digestApplied(boxed), sentinel, 'boxed Symbol.toPrimitive throw (1)');
  throwsIdentity(() => digestApplied(boxed), sentinel, 'boxed Symbol.toPrimitive throw (2)');
});

// --- 5. root-level toJSON -----------------------------------------------------

test('a root-level toJSON is always honoured, whatever its descriptor looks like', () => {
  let produced = 'first';
  const ownHidden = { [marker('a')]: A };
  Object.defineProperty(ownHidden, 'toJSON', { enumerable: false, configurable: true,
    value: () => ({ produced }) });
  const first = digestApplied(ownHidden);
  assert.equal(first, digestOfText('{"produced":"first"}'));
  produced = 'second';
  assert.equal(digestApplied(ownHidden), digestOfText('{"produced":"second"}'),
    'an own non-enumerable toJSON is invisible to key enumeration and still decides the text');

  // A callable own *enumerable* key named `toJSON`: the serialization runs it, so a
  // cache that only checks "is there a toJSON descriptor" on the prototype, or one
  // that snapshots keys without noticing that `toJSON` is special, would cache a
  // digest that no longer describes the map.
  let counter = 0;
  const callable = { [marker('b')]: B };
  Object.defineProperty(callable, 'toJSON', { enumerable: true, configurable: true,
    value: () => ({ counter: ++counter }) });
  assert.equal(digestApplied(callable), digestOfText('{"counter":1}'));
  assert.equal(digestApplied(callable), digestOfText('{"counter":2}'));
  assert.equal(digestApplied(callable), digestOfText('{"counter":3}'));

  // A non-callable toJSON is an ordinary value as far as the serialization is
  // concerned; `undefined` values are dropped, everything else is kept.
  assert.equal(digestApplied({ [marker('c')]: C, toJSON: 'text' }),
    digestOfText(`{"${marker('c')}":"${C}","toJSON":"text"}`));
  assert.equal(digestApplied({ toJSON: undefined }), digestOfText('{}'));
  assert.equal(digestApplied({ toJSON: null }), digestOfText('{"toJSON":null}'));
});

test('an inherited toJSON is honoured, and a prototype swap is re-examined', () => {
  let produced = 'first';
  const prototype = { toJSON() { return { produced }; } };
  const table = Object.create(prototype);
  table[marker('a')] = A;
  const first = digestApplied(table);
  assert.equal(first, digestOfText('{"produced":"first"}'));
  produced = 'second';
  assert.equal(digestApplied(table), digestOfText('{"produced":"second"}'));

  // Same own keys, same values, a different prototype: only the toJSON lookup moved.
  const plain = { [marker('a')]: A };
  const beforeSwap = digestApplied(plain);
  assert.equal(beforeSwap, digestOfText(`{"${marker('a')}":"${A}"}`));
  Object.setPrototypeOf(plain, { toJSON: () => ({ swapped: true }) });
  assert.equal(digestApplied(plain), digestOfText('{"swapped":true}'),
    'a prototype installed after a call must be honoured on the next call');
  Object.setPrototypeOf(plain, null);
  assert.equal(digestApplied(plain), beforeSwap, 'returning to a plain prototype returns the old text');
});

test('an Object.prototype.toJSON installed between calls is honoured', () => {
  const table = { [marker('a')]: A };
  const before = digestApplied(table);
  assert.equal(before, digestOfText(`{"${marker('a')}":"${A}"}`));
  let during;
  try {
    Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, writable: true,
      value: () => ({ overridden: true }) });
    during = digestApplied(table);
  } finally { delete Object.prototype.toJSON; }
  assert.equal(during, digestOfText('{"overridden":true}'),
    'a cache must re-check Object.prototype every call; JSON.stringify reads it every call');
  assert.notEqual(during, before);
  assert.equal(digestApplied(table), before, 'removing the override restores the text');
});

test('an inherited enumerable getter is never read, because the serialization only reads own keys', () => {
  let inheritedReads = 0;
  const table = { [marker('a')]: A };
  const before = digestApplied(table);
  let during;
  try {
    Object.defineProperty(Object.prototype, 'ghost', { enumerable: true, configurable: true,
      get() { inheritedReads += 1; return 'ghost'; } });
    during = digestApplied(table);
    assert.equal(Object.keys(table).includes('ghost'), false);
  } finally { delete Object.prototype.ghost; }
  assert.equal(during, before);
  assert.equal(inheritedReads, 0, 'an inherited enumerable getter is not part of the text and must not be read');
});

// --- 6. non-object roots ------------------------------------------------------

test('non-object roots keep the serialization behaviour instead of a cache behaviour', () => {
  assert.equal(digestApplied(7), digestOfText('7'));
  assert.equal(digestApplied(null), digestOfText('null'));
  assert.equal(digestApplied(true), digestOfText('true'));
  assert.equal(digestApplied('marker'), digestOfText('"marker"'));

  // `JSON.stringify(undefined)` is `undefined`, and the committed call hands that to
  // the hash, which throws. A `WeakMap` key or a `typeof applied === 'object'` guard
  // changes this into a different TypeError or into a returned digest.
  for (const [name, value] of [
    ['undefined', undefined], ['a function', () => {}], ['a symbol', Symbol('root')],
  ]) {
    const first = capture(() => digestApplied(value));
    const second = capture(() => digestApplied(value));
    assert.ok(first.error instanceof TypeError, `${name}: the committed call throws a TypeError`);
    assert.ok(second.error instanceof TypeError, `${name}: and it throws again, it is not remembered`);
  }

  const big = capture(() => digestApplied(10n));
  assert.ok(big.error instanceof TypeError, 'a BigInt root is a TypeError');
  assert.match(big.error.message, /BigInt/);
  assert.ok(capture(() => digestApplied({ [marker('a')]: A, value: 10n })).error instanceof TypeError,
    'a BigInt value is a TypeError');

  const cycle = { [marker('a')]: A };
  cycle.self = cycle;
  throwsMatching(() => digestApplied(cycle), /circular/i, 'a cycle (1)');
  throwsMatching(() => digestApplied(cycle), /circular/i, 'a cycle (2)');

  // Values that the serialization drops must not become digest input.
  assert.equal(digestApplied({ a: undefined }), digestOfText('{}'));
  assert.equal(digestApplied({ a() {} }), digestOfText('{}'));
  assert.equal(digestApplied({ a: Symbol('dropped') }), digestOfText('{}'));
  assert.equal(digestApplied({ a: undefined, b: NaN, c: -0 }), digestOfText('{"b":null,"c":0}'));

  // A throwing input must not poison a later valid call, and a valid call must not
  // make a later throwing input return.
  assert.equal(digestApplied({ [marker('ok')]: A }), digestOfText(`{"${marker('ok')}":"${A}"}`));
  assert.ok(capture(() => digestApplied(undefined)).error instanceof TypeError);
  assert.equal(digestApplied({ [marker('ok')]: A }), digestOfText(`{"${marker('ok')}":"${A}"}`));
});

// --- 7. getters that change the map while it is being read --------------------

test('a one-shot getter is read once per call and the digest follows every call', () => {
  let reads = 0;
  const table = {};
  Object.defineProperty(table, marker('flip'), { enumerable: true, configurable: true,
    get: () => (reads++ === 0 ? A : B) });
  assert.equal(digestApplied(table), digestOfText(`{"${marker('flip')}":"${A}"}`));
  assert.equal(digestApplied(table), digestOfText(`{"${marker('flip')}":"${B}"}`));
  const settled = digestApplied(table);
  assert.equal(settled, digestOfText(`{"${marker('flip')}":"${B}"}`));
  assert.equal(reads, 3, 'one read per call, never a second one for a snapshot');
});

test('the digest does not add a read, so it cannot throw where the serialization cannot', () => {
  let reads = 0;
  const table = {};
  Object.defineProperty(table, marker('x'), { enumerable: true, configurable: true,
    get() { reads += 1; if (reads > 1) throw new Error('second read'); return A; } });
  const outcome = capture(() => digestApplied(table));
  assert.equal(outcome.error, undefined, 'the single read the serialization performs succeeded');
  assert.equal(outcome.value, digestOfText(`{"${marker('x')}":"${A}"}`));
});

test('a getter that adds or deletes keys is re-examined on the next call', () => {
  const growing = {};
  let grew = false;
  Object.defineProperty(growing, marker('a'), { enumerable: true, configurable: true,
    get() { if (!grew) { grew = true; growing[marker('z')] = C; } return A; } });
  assert.equal(digestApplied(growing), digestOfText(`{"${marker('a')}":"${A}"}`),
    'a key added during the read is outside the enumeration the serialization captured');
  assert.equal(digestApplied(growing),
    digestOfText(`{"${marker('a')}":"${A}","${marker('z')}":"${C}"}`),
    'the next call must see the key the first call added');

  const shrinking = { [marker('a')]: A, [marker('b')]: B };
  Object.defineProperty(shrinking, marker('a'), { enumerable: true, configurable: true,
    get() { delete shrinking[marker('b')]; return A; } });
  assert.equal(digestApplied(shrinking), digestOfText(`{"${marker('a')}":"${A}"}`));
  assert.equal(digestApplied(shrinking), digestOfText(`{"${marker('a')}":"${A}"}`));
});

// --- 8. descriptor re-checks on a table that looks cacheable ------------------

test('a table that looked cacheable is re-verified key by key, descriptor by descriptor', () => {
  const key = marker('a');
  const table = {};
  Object.defineProperty(table, key, { value: A, enumerable: true, configurable: true, writable: true });
  assert.equal(digestApplied(table), digestOfText(`{"${key}":"${A}"}`));

  // The value is unchanged; only enumerability changed, and it removes the key.
  Object.defineProperty(table, key, { value: A, enumerable: false, configurable: true, writable: true });
  assert.equal(digestApplied(table), digestOfText('{}'),
    'a key that stopped being enumerable leaves the text');

  // Same key and same value again, so the text is the old one; the accessor may be
  // read exactly once per call, by the serialization.
  let reads = 0;
  Object.defineProperty(table, key, { enumerable: true, configurable: true,
    get() { reads += 1; return A; } });
  assert.equal(digestApplied(table), digestOfText(`{"${key}":"${A}"}`));
  assert.equal(reads, 1, 're-verification must not read the value the serialization reads');
  assert.equal(digestApplied(table), digestOfText(`{"${key}":"${A}"}`));
  assert.equal(reads, 2, 'one read per call, exactly');

  // A different value behind the accessor changes the text.
  Object.defineProperty(table, key, { enumerable: true, configurable: true, get: () => C });
  assert.equal(digestApplied(table), digestOfText(`{"${key}":"${C}"}`));

  // Removing and re-inserting the *first* key moves it to the end, and JSON text is
  // ordered.
  const ordered = { [marker('a')]: A, [marker('b')]: B };
  const inOrder = digestApplied(ordered);
  delete ordered[marker('a')];
  ordered[marker('a')] = A;
  assert.equal(digestApplied(ordered), digestOfText(`{"${marker('b')}":"${B}","${marker('a')}":"${A}"}`));
  assert.notEqual(digestApplied(ordered), inOrder,
    'the same key/value set in a different order is a different text');

  // A key appended after a call is part of the next text.
  const appended = { [marker('a')]: A };
  assert.equal(digestApplied(appended), digestOfText(`{"${marker('a')}":"${A}"}`));
  appended[marker('b')] = B;
  assert.equal(digestApplied(appended),
    digestOfText(`{"${marker('a')}":"${A}","${marker('b')}":"${B}"}`));
});

// --- 9. nested mutables -------------------------------------------------------

test('a mutation inside a nested value changes the digest', () => {
  const inner = { state: 'first' };
  const table = { [marker('a')]: A, nested: inner };
  const first = digestApplied(table);
  assert.equal(first, digestOfText(`{"${marker('a')}":"${A}","nested":{"state":"first"}}`));
  inner.state = 'second';
  assert.equal(digestApplied(table),
    digestOfText(`{"${marker('a')}":"${A}","nested":{"state":"second"}}`),
    'the root keys and their value identities did not change; the text did');
  assert.notEqual(digestApplied(table), first);

  const list = ['first'];
  const withList = { [marker('b')]: B, list };
  assert.equal(digestApplied(withList), digestOfText(`{"${marker('b')}":"${B}","list":["first"]}`));
  list.push('second');
  assert.equal(digestApplied(withList),
    digestOfText(`{"${marker('b')}":"${B}","list":["first","second"]}`));

  const at = new Date(Date.parse('2026-01-01T00:00:00.000Z'));
  const dated = { [marker('c')]: C, at };
  assert.equal(digestApplied(dated),
    digestOfText(`{"${marker('c')}":"${C}","at":"2026-01-01T00:00:00.000Z"}`));
  at.setTime(Date.parse('2026-02-02T00:00:00.000Z'));
  assert.equal(digestApplied(dated),
    digestOfText(`{"${marker('c')}":"${C}","at":"2026-02-02T00:00:00.000Z"}`),
    'a nested toJSON (Date.prototype.toJSON) makes the value mutable behind an unchanged identity');

  let produced = 'one';
  const nestedToJSON = {};
  Object.defineProperty(nestedToJSON, 'toJSON', { configurable: true, value: () => ({ produced }) });
  const viaToJSON = { [marker('d')]: A, nested: nestedToJSON };
  assert.equal(digestApplied(viaToJSON), digestOfText(`{"${marker('d')}":"${A}","nested":{"produced":"one"}}`));
  produced = 'two';
  assert.equal(digestApplied(viaToJSON),
    digestOfText(`{"${marker('d')}":"${A}","nested":{"produced":"two"}}`));

  // A Map has no enumerable own properties: it serializes as `{}` and its entries
  // are not part of the text, so changing them changes nothing.
  const map = new Map([['x', 1]]);
  const withMap = { [marker('e')]: B, map };
  const mapFirst = digestApplied(withMap);
  assert.equal(mapFirst, digestOfText(`{"${marker('e')}":"${B}","map":{}}`));
  map.set('y', 2);
  assert.equal(digestApplied(withMap), mapFirst);
});

// --- 10. boxed primitives, including prototype-reset and fake wrappers --------

test('boxed primitives are digested by their internal slot, not by their own keys', () => {
  assert.equal(digestApplied(new Number(5)), digestOfText('5'));
  assert.equal(digestApplied(new Boolean(false)), digestOfText('false'));
  assert.equal(digestApplied(new String('ab')), digestOfText('"ab"'));
  const withOwnKey = new String('ab');
  withOwnKey.extra = 'own';
  assert.equal(digestApplied(withOwnKey), digestOfText('"ab"'),
    'own enumerable keys never reach the text of a String wrapper');

  // A String wrapper whose prototype was reset to Object.prototype is no longer
  // `instanceof String`, but it is still a boxed primitive: the text comes from
  // `[[StringData]]` through the (now plain) prototype chain.
  const reset = new String('ab');
  Object.setPrototypeOf(reset, Object.prototype);
  assert.equal(Object.getPrototypeOf(reset), Object.prototype);
  assert.equal(digestApplied(reset), digestOfText('"[object String]"'));
  reset.toString = () => 'changed';
  assert.equal(digestApplied(reset), digestOfText('"changed"'),
    'an own toString behind a plain-looking prototype decides the primitive conversion');

  let produced = 0;
  const dynamic = new String('ab');
  Object.setPrototypeOf(dynamic, Object.prototype);
  Object.defineProperty(dynamic, Symbol.toPrimitive, { configurable: true,
    get() { produced += 1; return () => `v${produced}`; } });
  assert.equal(digestApplied(dynamic), digestOfText('"v1"'));
  assert.equal(digestApplied(dynamic), digestOfText('"v2"'),
    'a symbol-keyed conversion the enumeration never reports still changes the text');

  const resetNumber = new Number(5);
  Object.setPrototypeOf(resetNumber, Object.prototype);
  assert.equal(digestApplied(resetNumber), digestOfText('null'));
  resetNumber.valueOf = () => 42;
  assert.equal(digestApplied(resetNumber), digestOfText('42'));

  const resetBoolean = new Boolean(false);
  Object.setPrototypeOf(resetBoolean, Object.prototype);
  resetBoolean[Symbol.toPrimitive] = () => true;
  assert.equal(digestApplied(resetBoolean), digestOfText('false'),
    'a Boolean wrapper ignores Symbol.toPrimitive, and so must its digest');

  // Null prototypes on a wrapper make the primitive conversion itself throw.
  for (const wrapper of [new String('zz'), new Number(3)]) {
    Object.setPrototypeOf(wrapper, null);
    throwsMatching(() => digestApplied(wrapper), /Cannot convert object to primitive value/i,
      'a null-proto wrapper cannot convert');
    throwsMatching(() => digestApplied(wrapper), /Cannot convert object to primitive value/i,
      'a null-proto wrapper cannot convert on the second call either');
  }
});

test('objects that merely look boxed are plain objects with a plain text', () => {
  const fakeNumber = Object.create(Number.prototype);
  assert.equal(digestApplied(fakeNumber), digestOfText('{}'),
    'no [[NumberData]], so no ToNumber: `instanceof` must not be the admission test');
  Object.defineProperty(fakeNumber, Symbol.toPrimitive, { configurable: true,
    get() { throw new Error('a plain object is never converted'); } });
  assert.equal(digestApplied(fakeNumber), digestOfText('{}'));

  const fakeString = Object.create(String.prototype);
  fakeString.a = 'own';
  assert.equal(digestApplied(fakeString), digestOfText('{"a":"own"}'));
  Object.defineProperty(fakeString, 'toString', { configurable: true,
    value() { throw new Error('a plain object is never converted'); } });
  assert.equal(digestApplied(fakeString), digestOfText('{"a":"own"}'),
    'a plain object with a throwing toString is still serialized as an ordinary object');

  // A fake wrapper with only index-shaped keys must not be mistaken for its data.
  const fakeIndexed = Object.create(String.prototype);
  fakeIndexed[0] = 'a';
  fakeIndexed[1] = 'b';
  assert.equal(digestApplied(fakeIndexed), digestOfText('{"0":"a","1":"b"}'));
});

// --- 11. rawJSON --------------------------------------------------------------

test('JSON.rawJSON keeps its raw text, and a plain lookalike keeps its own text', () => {
  const raw = JSON.rawJSON('1.5');
  const lookalike = { rawJSON: '1.5' };
  // Interleaved on purpose: a cache keyed on the *content* of the root (keys and
  // values) cannot tell these two apart, but their texts differ.
  assert.equal(digestApplied(lookalike), digestOfText('{"rawJSON":"1.5"}'));
  assert.equal(digestApplied(raw), digestOfText('1.5'),
    'a rawJSON root serializes as its raw text, not as `{"rawJSON":"1.5"}`');
  assert.equal(digestApplied(lookalike), digestOfText('{"rawJSON":"1.5"}'));

  const nested = { [marker('a')]: A, value: JSON.rawJSON('1.0') };
  assert.equal(digestApplied(nested), digestOfText(`{"${marker('a')}":"${A}","value":1.0}`));
  const other = { [marker('a')]: A, value: JSON.rawJSON('1.00') };
  assert.ok(JSON.stringify(nested) !== JSON.stringify(other));
  assert.notEqual(digestApplied(other), digestApplied(nested),
    'the raw text is the serialization even when the wrapper structure is identical');
  const lookalikeNested = { [marker('a')]: A, value: { rawJSON: '1.0' } };
  assert.equal(digestApplied(lookalikeNested),
    digestOfText(`{"${marker('a')}":"${A}","value":{"rawJSON":"1.0"}}`));
  assert.equal(digestApplied([JSON.rawJSON('2.0')]), digestOfText('[2.0]'));
});

// --- 12. cross-realm ----------------------------------------------------------

test('objects from another realm are digested by their text, including their own Object.prototype', () => {
  const context = vm.createContext({});
  const foreign = vm.runInContext('({ a: "x", b: "y" })', context);
  assert.notEqual(Object.getPrototypeOf(foreign), Object.prototype);
  const first = digestApplied(foreign);
  assert.equal(first, digestOfText('{"a":"x","b":"y"}'));
  foreign.a = 'changed';
  assert.equal(digestApplied(foreign), digestOfText('{"a":"changed","b":"y"}'),
    'a foreign prototype is not a reason to remember a digest');

  let during;
  try {
    vm.runInContext('Object.prototype.toJSON = function () { return { foreign: true }; }', context);
    during = digestApplied(foreign);
  } finally {
    vm.runInContext('delete Object.prototype.toJSON', context);
  }
  assert.equal(during, digestOfText('{"foreign":true}'),
    'the foreign realm\'s Object.prototype.toJSON is part of the text');
  assert.equal(digestApplied(foreign), digestOfText('{"a":"changed","b":"y"}'));

  const foreignNull = vm.runInContext('Object.create(null)', context);
  foreignNull.a = 'v';
  assert.equal(digestApplied(foreignNull), digestOfText('{"a":"v"}'));
  assert.equal(digestApplied(vm.runInContext('new String("ab")', context)), digestOfText('"ab"'));
  assert.equal(digestApplied(vm.runInContext('[1, 2]', context)), digestOfText('[1,2]'));

  const foreignProxy = vm.runInContext(`(record) => new Proxy({ a: 1 }, {
    get(t, k, r) { record('get:' + String(k)); return Reflect.get(t, k, r); },
    ownKeys(t) { record('ownKeys'); return Reflect.ownKeys(t); },
    getOwnPropertyDescriptor(t, k) { record('gopd:' + String(k)); return Reflect.getOwnPropertyDescriptor(t, k); },
    getPrototypeOf(t) { record('getPrototypeOf'); return Reflect.getPrototypeOf(t); },
    has(t, k) { record('has:' + String(k)); return Reflect.has(t, k); }
  })`, context);
  assertSameTrapTrace((log) => foreignProxy((entry) => log.push(entry)), 'foreign Proxy');
});

// --- 13. symbol keys and non-enumerable symbol getters ------------------------

test('symbol-keyed properties are never read, even when they are enumerable getters', () => {
  let enumerableReads = 0;
  let hiddenReads = 0;
  const table = { [marker('a')]: A };
  Object.defineProperty(table, Symbol('enumerable'), { enumerable: true, configurable: true,
    get() { enumerableReads += 1; return 'value'; } });
  Object.defineProperty(table, Symbol('hidden'), { enumerable: false, configurable: true,
    get() { hiddenReads += 1; throw new Error('a symbol getter must never run'); } });
  assert.equal(digestApplied(table), digestOfText(`{"${marker('a')}":"${A}"}`));
  assert.equal(digestApplied(table), digestOfText(`{"${marker('a')}":"${A}"}`));
  assert.equal(enumerableReads, 0);
  assert.equal(hiddenReads, 0);

  const symbolsOnly = { [Symbol('a')]: 1, [Symbol('b')]: 2 };
  assert.equal(digestApplied(symbolsOnly), digestOfText('{}'));
  symbolsOnly[marker('late')] = C;
  assert.equal(digestApplied(symbolsOnly), digestOfText(`{"${marker('late')}":"${C}"}`));
});

// --- 14. namespaces (a real domain runtime and namespace-shaped values) ------

test('a real domain runtime is not a marker map: its serialization behaviour is kept', async () => {
  const fixture = await openFixture();
  try {
    const domain = fixture.ctx.storageDomain.get(evolutionDomainSpec.name);
    assert.equal(Object.getPrototypeOf(domain)?.constructor?.name, 'DomainImpl');
    throwsMatching(() => digestApplied(domain), /circular/i, 'a domain runtime is circular (1)');
    throwsMatching(() => digestApplied(domain), /circular/i, 'a domain runtime is circular (2)');
  } finally { await fixture.close(); }
});

test('namespace-shaped containers are digested by JSON semantics, not by their contents', () => {
  const namespaceLike = { name: 'evolution', tables: new Map([['markers', { size: 1 }]]),
    handles: new Set(['global']), scoped: Object.create(null) };
  namespaceLike.scoped.key = 'value';
  const first = digestApplied(namespaceLike);
  assert.equal(first, digestOfText(
    '{"name":"evolution","tables":{},"handles":{},"scoped":{"key":"value"}}'));
  namespaceLike.tables.set('other', {});
  namespaceLike.handles.add('table');
  assert.equal(digestApplied(namespaceLike), first, 'Map and Set entries are not part of the text');

  class Namespace { constructor() { this.name = 'evolution'; this.count = 1; } }
  const instance = new Namespace();
  const before = digestApplied(instance);
  assert.equal(before, digestOfText('{"name":"evolution","count":1}'));
  Namespace.prototype.toJSON = () => ({ fromPrototype: true });
  try {
    assert.equal(digestApplied(instance), digestOfText('{"fromPrototype":true}'),
      'a prototype that gained toJSON after a call must be re-examined');
  } finally { delete Namespace.prototype.toJSON; }
  assert.equal(digestApplied(instance), before);
});

// --- 15. integer keys and delete/reinsert ------------------------------------

test('key order decides the text, including integer keys and delete/reinsert', () => {
  const mixed = {};
  mixed[marker('b')] = B;
  mixed[2] = 'two';
  mixed[1] = 'one';
  mixed[marker('a')] = A;
  assert.equal(digestApplied(mixed),
    digestOfText(`{"1":"one","2":"two","${marker('b')}":"${B}","${marker('a')}":"${A}"}`),
    'integer-shaped keys sort first, ascending, whatever the insertion order');

  // An integer key re-inserted keeps its position, so the text is unchanged.
  const integers = { 2: 'two', 1: 'one' };
  const integerText = digestApplied(integers);
  delete integers[1];
  integers[1] = 'one';
  assert.equal(digestApplied(integers), integerText);

  // Removing and re-inserting the *first* key moves it to the end, and JSON text is
  // ordered.
  const strings = { [marker('a')]: A, [marker('b')]: B };
  const stringText = digestApplied(strings);
  delete strings[marker('a')];
  strings[marker('a')] = A;
  assert.notEqual(digestApplied(strings), stringText,
    'the same key/value set in a different order is a different text');

  // `01` is not an integer index; `1` is.
  const padded = { '01': 'padded', 1: 'one' };
  assert.equal(digestApplied(padded), digestOfText('{"1":"one","01":"padded"}'));
});

// --- 16. own keys that shadow the methods a cache might use ------------------

test('own keys that shadow helper methods are data, and are digested as data', () => {
  let helperCalled = 0;
  const table = {
    constructor: 'c',
    valueOf: 'v',
    toString: 't',
    hasOwnProperty: () => { helperCalled += 1; throw new Error('the digest must not call the map\'s own helper'); },
    [marker('a')]: A,
  };
  const expected = digestOfText(
    `{"constructor":"c","valueOf":"v","toString":"t","${marker('a')}":"${A}"}`);
  assert.equal(digestApplied(table), expected);
  assert.equal(digestApplied(table), expected);
  assert.equal(helperCalled, 0, 'a cache must use Object.hasOwn / Object.getOwnPropertyDescriptor, not the map\'s methods');

  // `__proto__` as an own data key is a marker key like any other; it does not move
  // the prototype and it is part of the text.
  const withProtoKey = {};
  Object.defineProperty(withProtoKey, '__proto__', { value: 'own', enumerable: true,
    configurable: true, writable: true });
  assert.equal(Object.getPrototypeOf(withProtoKey), Object.prototype);
  assert.equal(digestApplied(withProtoKey), digestOfText('{"__proto__":"own"}'));
});

// --- 17. prototype pollution that descriptor-based reflection must not observe -
//
// "Reflection only" has two ways to stop being true:
//
//   * testing a descriptor field with `'value' in descriptor` and then reading
//     `descriptor.value`. `in` walks the prototype chain, so the test is true for
//     every *accessor* descriptor as soon as anything defines
//     `Object.prototype.value`, and the read then runs that inherited accessor: an
//     extra read, or an exception, where the serialization performs neither - and
//     worse, an accessor key that looks like a data key with the inherited value.
//   * filling the snapshot container with `container[index] = value` while the
//     container still inherits from `Object.prototype`: `[[Set]]` finds an inherited
//     setter for a numeric key instead of creating an own element, so a polluted
//     prototype observes every snapshot and can even make it throw.
//
// Both are process-wide side effects, and `node:test` itself (or the assertion
// library) may read such a property while reporting a failure. Each probe therefore
// runs in its own process, where only the digest can see the polluted prototype.
// The committed implementation passes all of them trivially: it never inspects a
// descriptor and never allocates a container.

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIGEST_MODULE = pathToFileURL(path.join(REPO_ROOT, 'lib', 'event-log-checkpoint.js')).href;

function runIsolatedProbe(body) {
  const script = `import { digestApplied } from ${JSON.stringify(DIGEST_MODULE)};\n${body}`;
  const result = spawnSync(process.execPath,
    ['--max-old-space-size=4096', '--input-type=module', '-e', script],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0,
    `isolated probe failed: ${result.stderr || result.stdout}`);
  const line = String(result.stdout).trim().split('\n').filter(Boolean).at(-1);
  assert.ok(line, 'the isolated probe must report one line of JSON');
  return JSON.parse(line);
}

/** Two calls over an accessor key whose value changes in between. */
const ACCESSOR_PROBE_CALLS = `
let first, second, firstError = null, secondError = null;
try { first = digestApplied(table); } catch (error) { firstError = error.message; }
produced = ${JSON.stringify(C)};
try { second = digestApplied(table); } catch (error) { secondError = error.message; }
process.stdout.write(JSON.stringify({ first: first ?? null, second: second ?? null, firstError, secondError }) + '\\n');
`;

test('an Object.prototype.value data property cannot turn an accessor key into data', () => {
  const key = marker('polluted');
  // The table and its accessor are built first: `Object.defineProperty` itself runs
  // `ToPropertyDescriptor`, which reads `value` through the prototype chain, so a
  // polluted prototype has to appear after the fixture exists (as it would in a
  // process that loads a polyfill later).
  const report = runIsolatedProbe(`
const A = ${JSON.stringify(A)};
const C = ${JSON.stringify(C)};
const KEY = ${JSON.stringify(key)};
let produced = A;
let reads = 0;
const table = {};
Object.defineProperty(table, KEY, { enumerable: true, configurable: true,
  get() { reads += 1; return produced; } });
Object.defineProperty(Object.prototype, 'value', { configurable: true, writable: true, value: 'hijacked' });
${ACCESSOR_PROBE_CALLS}
`);
  assert.equal(report.firstError, null);
  assert.equal(report.secondError, null);
  assert.equal(report.first, sha256(`{"${key}":"${A}"}`));
  assert.equal(report.second, sha256(`{"${key}":"${C}"}`),
    'an inherited Object.prototype.value is not the value of an accessor key');
});

test('descriptor inspection never reads a descriptor field through Object.prototype', () => {
  const dataKey = marker('data');
  const liveKey = marker('live');
  const report = runIsolatedProbe(`
const A = ${JSON.stringify(A)};
const C = ${JSON.stringify(C)};
let produced = A;
let tableReads = 0;
const table = {};
Object.defineProperty(table, ${JSON.stringify(dataKey)}, { value: A, enumerable: true, configurable: true, writable: true });
Object.defineProperty(table, ${JSON.stringify(liveKey)}, { enumerable: true, configurable: true,
  get() { tableReads += 1; return produced; } });
const FIELDS = ['value', 'writable', 'enumerable', 'configurable', 'get', 'set'];
const reads = { value: 0, writable: 0, enumerable: 0, configurable: 0, get: 0, set: 0 };
// A null-prototype descriptor object: the *installation* must not read the
// prototype it is about to pollute.
for (const field of FIELDS) {
  const descriptor = Object.create(null);
  descriptor.configurable = true;
  descriptor.get = () => { reads[field] += 1; return field === 'value' ? 'hijacked' : true; };
  Object.defineProperty(Object.prototype, field, descriptor);
}
let first, second, firstError = null, secondError = null;
try { first = digestApplied(table); } catch (error) { firstError = error.message; }
produced = C;
try { second = digestApplied(table); } catch (error) { secondError = error.message; }
process.stdout.write(JSON.stringify({ first: first ?? null, second: second ?? null, firstError, secondError,
  tableReads, reads }) + '\\n');
`);
  assert.equal(report.firstError, null);
  assert.equal(report.secondError, null);
  assert.deepEqual(report.reads,
    { value: 0, writable: 0, enumerable: 0, configurable: 0, get: 0, set: 0 },
    'a descriptor carries its own fields; Object.prototype fields are not part of it');
  assert.equal(report.tableReads, 2, 'the accessor key is read once per call');
  assert.equal(report.first, sha256(`{"${dataKey}":"${A}","${liveKey}":"${A}"}`));
  assert.equal(report.second, sha256(`{"${dataKey}":"${A}","${liveKey}":"${C}"}`));
});

test('an Object.prototype.value accessor cannot make the digest throw', () => {
  const key = marker('polluted-throw');
  const report = runIsolatedProbe(`
const A = ${JSON.stringify(A)};
const C = ${JSON.stringify(C)};
const KEY = ${JSON.stringify(key)};
let produced = A;
const table = {};
Object.defineProperty(table, KEY, { enumerable: true, configurable: true,
  get() { return produced; } });
const pollution = Object.create(null);
pollution.configurable = true;
pollution.get = () => { throw new Error('Object.prototype.value was read'); };
Object.defineProperty(Object.prototype, 'value', pollution);
${ACCESSOR_PROBE_CALLS}
`);
  assert.equal(report.firstError, null, 'the digest must not read Object.prototype.value');
  assert.equal(report.secondError, null);
  assert.equal(report.first, sha256(`{"${key}":"${A}"}`));
  assert.equal(report.second, sha256(`{"${key}":"${C}"}`));
});

test('the snapshot container cannot create indices through an inherited numeric setter', () => {
  const firstKey = marker('one');
  const secondKey = marker('two');
  const report = runIsolatedProbe(`
const A = ${JSON.stringify(A)};
const B = ${JSON.stringify(B)};
const C = ${JSON.stringify(C)};
const state = { count: 0 };
Object.defineProperty(Object.prototype, '0', { configurable: true,
  set() { state.count += 1; } });
const table = { ${JSON.stringify(firstKey)}: A, ${JSON.stringify(secondKey)}: B };
let first, second, firstError = null, secondError = null;
try { first = digestApplied(table); } catch (error) { firstError = error.message; }
table[${JSON.stringify(firstKey)}] = C;
try { second = digestApplied(table); } catch (error) { secondError = error.message; }
process.stdout.write(JSON.stringify({ first: first ?? null, second: second ?? null, firstError, secondError,
  setterCalls: state.count }) + '\\n');
`);
  assert.equal(report.firstError, null);
  assert.equal(report.secondError, null);
  assert.equal(report.setterCalls, 0,
    'a snapshot container must be prototype-free (Object.create(null)), not an array or object literal');
  assert.equal(report.first, sha256(`{"${firstKey}":"${A}","${secondKey}":"${B}"}`));
  assert.equal(report.second, sha256(`{"${firstKey}":"${C}","${secondKey}":"${B}"}`));
});

test('a throwing inherited numeric setter cannot break the digest', () => {
  const firstKey = marker('one-throw');
  const secondKey = marker('two-throw');
  const report = runIsolatedProbe(`
const A = ${JSON.stringify(A)};
const B = ${JSON.stringify(B)};
Object.defineProperty(Object.prototype, '0', { configurable: true,
  set() { throw new Error('Object.prototype[0] setter was invoked'); } });
const table = { ${JSON.stringify(firstKey)}: A, ${JSON.stringify(secondKey)}: B };
let first, second, firstError = null, secondError = null;
try { first = digestApplied(table); } catch (error) { firstError = error.message; }
try { second = digestApplied(table); } catch (error) { secondError = error.message; }
process.stdout.write(JSON.stringify({ first: first ?? null, second: second ?? null, firstError, secondError }) + '\\n');
`);
  assert.equal(report.firstError, null);
  assert.equal(report.secondError, null);
  assert.equal(report.first, sha256(`{"${firstKey}":"${A}","${secondKey}":"${B}"}`));
  assert.equal(report.second, report.first);
});

// --- the crypto boundary: the same call shape, the same errors ----------------
//
// The committed digest is one expression: `crypto.createHash(...)`, then a method
// call of the hash's `update`, then `digest`. Three ways to stop being equivalent
// at that boundary are invisible to a digest comparison alone, and every one of
// them needs a process-wide patch, so these probes also run in their own process:
//
//   * forwarding the text as `update.call(hash, text)` reads `call` off the native
//     function itself, which the committed method call never reads;
//   * reusing a digest that was produced while `crypto.createHash` was replaced
//     serves a digest for text it does not describe, after the replacement is gone;
//   * answering from memory a call whose `update`, `digest` or `createHash` throws
//     swallows the exception where the committed expression rethrows it.

const CALL_PROBE_KEY = marker('call-gate');
// The serialization runs this `toJSON` *before* the text is hashed, so it is the one
// place where an input can arm a property on the hashing primitives that hashing
// itself will visit next.
const TOJSON_ARMS_CALL = `
import crypto from 'node:crypto';
const KEY = ${JSON.stringify(CALL_PROBE_KEY)};
const nativeUpdate = crypto.Hash.prototype.update;
const sentinel = new Error('the digest read Hash.prototype.update.call');
let armed = false;
const table = {};
Object.defineProperty(table, 'toJSON', { enumerable: false, configurable: true, value() {
  // An own accessor on the native function object. Reading the function itself, and
  // calling it as a method, never touches it; reading its .call property does.
  if (!armed) {
    armed = true;
    Object.defineProperty(nativeUpdate, 'call', { configurable: true,
      get() { throw sentinel; } });
  }
  return { produced: 'inert' };
} });
let first, second, firstError = null, secondError = null;
try { first = digestApplied(table); } catch (error) { firstError = error === sentinel ? 'sentinel' : String(error); }
const armedAfterFirstCall = Object.hasOwn(nativeUpdate, 'call');
delete nativeUpdate.call;
const stillArmed = Object.hasOwn(nativeUpdate, 'call');
try { second = digestApplied(table); } catch (error) { secondError = error === sentinel ? 'sentinel' : String(error); }
process.stdout.write(JSON.stringify({ first: first ?? null, second: second ?? null, firstError,
  secondError, armedAfterFirstCall, stillArmed }) + '\\n');
`;

test('a toJSON that arms `call` on the native update function never makes the digest throw', () => {
  const report = runIsolatedProbe(TOJSON_ARMS_CALL);
  assert.equal(report.armedAfterFirstCall, true,
    'the probe itself must have installed the accessor, or it pins nothing');
  assert.equal(report.stillArmed, false, 'the isolated probe restores what it patched');
  assert.equal(report.firstError, null,
    'the committed expression calls the update function; it never reads its `call` property');
  assert.equal(report.secondError, null);
  assert.equal(report.first, sha256('{"produced":"inert"}'));
  assert.equal(report.second, report.first, 'the second call runs the same serialization again');
});

test('a digest taken while createHash was replaced is not reused after it is restored', () => {
  const key = marker('createhash-swap');
  const report = runIsolatedProbe(`
import crypto from 'node:crypto';
const KEY = ${JSON.stringify(key)};
const A = ${JSON.stringify(A)};
const B = ${JSON.stringify(B)};
const nativeCreateHash = crypto.createHash;
const textDigest = (text) => nativeCreateHash('sha256').update(text).digest('hex');
const table = { [KEY]: A };
// The map's own text, and the text the replacement actually hashes instead of it.
const X = JSON.stringify(table);
const Y = X.replace(A, B);
const report = { distinct: X !== Y, X: textDigest(X), Y: textDigest(Y) };
let substitute = true;
crypto.createHash = function (algorithm, options) {
  const hash = nativeCreateHash.call(this, algorithm, options);
  const nativeUpdate = hash.update;
  Object.defineProperty(hash, 'update', { configurable: true, writable: true,
    value: (data, encoding) => nativeUpdate.call(hash, substitute ? Y : data, encoding) });
  return hash;
};
try { report.first = digestApplied(table); } catch (error) { report.firstError = String(error); }
crypto.createHash = nativeCreateHash;
substitute = false;
report.restored = crypto.createHash === nativeCreateHash;
try { report.second = digestApplied(table); } catch (error) { report.secondError = String(error); }
try { report.third = digestApplied(table); } catch (error) { report.thirdError = String(error); }
process.stdout.write(JSON.stringify(report) + '\\n');
`);
  assert.equal(report.distinct, true, 'x and y must be different texts, or the probe proves nothing');
  assert.equal(report.restored, true);
  assert.equal(report.firstError, undefined);
  assert.equal(report.secondError, undefined);
  assert.equal(report.thirdError, undefined);
  assert.equal(report.first, report.Y, 'the first call hashes what the installed createHash hands it');
  assert.equal(report.second, report.X,
    'once createHash is restored the same map must digest its own text, not the text it was hashed as');
  assert.equal(report.third, report.X);
});

test('after a warm pass, a crypto call that throws is rethrown by the very next digest', () => {
  const key = marker('crypto-sentinel');
  const report = runIsolatedProbe(`
import crypto from 'node:crypto';
const KEY = ${JSON.stringify(key)};
const A = ${JSON.stringify(A)};
const table = { [KEY]: A };
const report = {};
const warm = digestApplied(table);
report.warmRepeats = digestApplied(table) === warm;
const nativeUpdate = crypto.Hash.prototype.update;
const nativeDigest = crypto.Hash.prototype.digest;
const nativeCreateHash = crypto.createHash;
const sentinels = { update: new Error('Hash.prototype.update sentinel'),
  digest: new Error('Hash.prototype.digest sentinel'),
  createHash: new Error('crypto.createHash sentinel') };
const attempt = (name, install, restore) => {
  let returned = null, threw = null;
  try {
    install();
    try { returned = digestApplied(table); } catch (error) { threw = error; }
  } finally { restore(); }
  report[name] = { returned, sentinel: threw === sentinels[name], threw: threw === null ? null : String(threw) };
};
attempt('update', () => { crypto.Hash.prototype.update = () => { throw sentinels.update; }; },
  () => { crypto.Hash.prototype.update = nativeUpdate; });
attempt('digest', () => { crypto.Hash.prototype.digest = () => { throw sentinels.digest; }; },
  () => { crypto.Hash.prototype.digest = nativeDigest; });
attempt('createHash', () => { crypto.createHash = () => { throw sentinels.createHash; }; },
  () => { crypto.createHash = nativeCreateHash; });
report.restoredDigest = digestApplied(table) === warm;
process.stdout.write(JSON.stringify(report) + '\\n');
`);
  assert.equal(report.warmRepeats, true, 'the map must be warm before each patch, or no path is cached');
  const primitives = ['update', 'digest', 'createHash'];
  const answeredFromMemory = Object.fromEntries(primitives.map((name) =>
    [name, report[name].returned === null ? null : 'digest']));
  assert.deepEqual(answeredFromMemory, { update: null, digest: null, createHash: null },
    'a call whose hashing throws must not be answered from memory');
  const identities = Object.fromEntries(primitives.map((name) => [name, report[name].sentinel]));
  assert.deepEqual(identities, { update: true, digest: true, createHash: true },
    `each thrown sentinel must arrive as the same object: ${JSON.stringify(
      Object.fromEntries(primitives.map((name) => [name, report[name].threw])))}`);
  assert.equal(report.restoredDigest, true, 'and restoring the primitives restores the digest');
});

// --- 18. the port-level outcome the digest protects --------------------------

test('after a warm pass, a middle marker that reports another MAC is refused by per-record verification', async () => {
  const fixture = await openFixture();
  try {
    const envelopes = [1, 2, 3].map((sequence) => {
      const envelope = signEventBridgeEnvelope({ schema: 1, eventId: marker(`live-${sequence}`),
        eventType: 'measurement-completed', experimentId: `live-${sequence}`, status: 'measured',
        measurement: { latency: 1 }, audit: { at: '2026-10-07T00:00:00.000Z' } },
      { key: KEY, sequence });
      fs.appendFileSync(fixture.config.eventBridgePath, `${JSON.stringify(envelope)}\n`);
      return envelope;
    });
    assert.deepEqual(await fixture.port.flush(), { applied: 3, duplicates: 0 });
    assert.deepEqual(await fixture.port.flush(), { applied: 0, duplicates: 3 },
      'the second pass must trust the checkpoint the first pass wrote');

    const applied = fixture.ctx.storageDomain.get(evolutionDomainSpec.name).global.get().applied;
    const middle = envelopes[1].event.eventId;
    assert.equal(applied[middle], envelopes[1].mac);
    // The live map now reports a different MAC for a record the checkpoint covers,
    // with the same key in the same position. If the digest of the map is reused,
    // the checkpoint stays trusted and the conflict surfaces every record as
    // already applied instead of being refused.
    applied[middle] = C;
    await assert.rejects(fixture.port.flush(), /E_DOMAIN_EVENT_ID_CONFLICT/,
      'a map that no longer matches the checkpoint must be refused by per-record verification');
    await assert.rejects(fixture.port.flush(), /E_DOMAIN_EVENT_ID_CONFLICT/,
      'and the refusal must survive the next pass');
    await assert.rejects(fixture.port.close(), /E_DOMAIN_EVENT_ID_CONFLICT/,
      'the port re-reports the same refusal on close');
  } finally { await fixture.close(); }
});

async function openFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'applied-digest-narrow-cache-'));
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = { emit() {}, on() { return () => {}; }, logger: { warn() {}, error() {} },
    storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'),
    eventBridgeKey: KEY };
  const port = await openDomainStorage(ctx, config);
  let closed = false;
  return {
    ctx, config, port, root, backend,
    async close() {
      if (!closed) {
        closed = true;
        await port.close().catch(() => {});
      }
      await backend.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
