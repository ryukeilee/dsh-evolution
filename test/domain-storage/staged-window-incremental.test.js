import test from 'node:test';
import assert from 'node:assert/strict';
import { EvolutionMemory } from '../../lib/dockyard-domain/memory.js';
import { assertStagedTransactionSave, assertTransactionSave, createStagedWindowChecks } from '../../lib/domain-storage.js';
const marker = id => Object.freeze({ eventId: id, eventType: 'measurement-completed', experimentId: id, appliedAt: 'fixed' });
const doc = window => ({ evolution: { schema: 4, experiments: [], eventBridge: { schema: 1, applied: window } } });
const capture = work => { try { work(); return null; } catch (error) { return { name: error.name, message: error.message }; } };
function checker() {
  const checks = createStagedWindowChecks();
  const memo = new WeakMap();
  let gets = 0;
  const get = memo.get.bind(memo);
  memo.get = value => { gets++; return get(value); };
  return { ...checks, memo, gets: () => gets, check: payload => assertStagedTransactionSave(payload, memo, checks.windows) };
}

test('an immutable successor checks only its added marker, and the old window stays immutable', () => {
  const c = checker();
  const initial = Object.freeze(Array.from({ length: 4096 }, (_, i) => marker(String(i))));
  c.changed(null, initial, null); c.check(doc(initial));
  assert.equal(c.gets(), 4096);
  c.check(doc(initial)); assert.equal(c.gets(), 4096);
  const added = marker('next');
  const next = Object.freeze([...initial.slice(1), added]);
  c.changed(initial, next, added);
  c.check(doc(next)); assert.equal(c.gets(), 4097, 'no repeated walk of the prior window');
  assert.throws(() => { initial[0] = added; }, TypeError);
  assert.throws(() => next.push(added), TypeError);
});

test('mutable and unreported replacement windows keep the complete check', () => {
  const c = checker();
  const mutable = [marker('old')];
  c.changed(null, mutable, null); c.check(doc(mutable));
  mutable.push(Object.freeze({ eventId: 'new', value: 1n }));
  assert.deepEqual(capture(() => c.check(doc(mutable))), capture(() => assertTransactionSave(doc(mutable))));
  const replacement = Object.freeze([marker('replacement'), Object.freeze({ eventId: 'bad', value: 1n })]);
  assert.deepEqual(capture(() => c.check(doc(replacement))), capture(() => assertTransactionSave(doc(replacement))));
  assert.equal(capture(() => c.check(doc(replacement))).name, 'TypeError');
});

test('a successor does not serialize its added marker before the save, and a failed save is not certified', () => {
  const c = checker();
  const initial = Object.freeze([marker('old')]);
  c.changed(null, initial, null); c.check(doc(initial));
  let calls = 0;
  const bad = Object.freeze({ toJSON() { calls++; throw new TypeError('new marker at save'); } });
  const next = Object.freeze([...initial, bad]);
  c.changed(initial, next, bad);
  assert.equal(calls, 0, 'publishing lineage must not run JSON code');
  const error = capture(() => c.check(doc(next)));
  assert.deepEqual(error, { name: 'TypeError', message: 'new marker at save' });
  assert.equal(calls, 1);
  assert.equal(c.windows.get(next).verified, false);
  assert.deepEqual(capture(() => c.check(doc(next))), error);
  assert.equal(calls, 2, 'the failed window must keep checking at the next save');
});

test('a cached window never bypasses body serialization, literals or mutable nested marker values', () => {
  const c = checker();
  const initial = Object.freeze([marker('old')]);
  c.changed(null, initial, null); c.check(doc(initial));
  for (const value of [1n, (() => { const value = {}; value.self = value; return value; })(), { toJSON() { throw new TypeError('body at save'); } }]) {
    const payload = doc(initial); payload.evolution.experiments.push(value);
    assert.deepEqual(capture(() => c.check(payload)), capture(() => assertTransactionSave(payload)));
  }
  const withLiteral = doc(initial); withLiteral.evolution.note = '__proto__';
  assert.deepEqual(capture(() => c.check(withLiteral)), capture(() => assertTransactionSave(withLiteral)));
  const nested = { value: 1 };
  const nextMarker = Object.freeze({ eventId: 'nested', nested });
  const next = Object.freeze([...initial, nextMarker]);
  c.changed(initial, next, nextMarker); c.check(doc(next));
  assert.equal(c.windows.get(next).verified, false, 'a fallback is not a certificate');
  nested.value = 1n;
  assert.deepEqual(capture(() => c.check(doc(next))), capture(() => assertTransactionSave(doc(next))));
});

test('the private memory reports immutable bounded successors; ordinary stores retain mutable windows', async () => {
  const make = async privateWindow => {
    const c = checker(); const windows = [];
    let aggregate = doc(Array.from({ length: 4096 }, (_, i) => marker(`seed-${i}`)));
    const stateStore = { inlineSerialization: true, load: async () => structuredClone(aggregate), update: async updater => { aggregate = updater(aggregate); } };
    const persist = async updater => { const next = updater(aggregate); c.check(next); aggregate = next; };
    const changed = (previous, next, added) => { windows.push({ previous, next, added }); c.changed(previous, next, added); };
    const memory = new EvolutionMemory({ stateStore, transaction: { persist, ...(privateWindow ? { bridgeWindowChanged: changed } : {}) }, mutationAuthority: { assertMutation() {} } });
    await memory.load();
    const event = id => ({ schema: 1, eventId: `evolution:measurement-completed:${id}`, eventType: 'measurement-completed', experimentId: id, measurement: {} });
    await memory.applyExecutionEvent(event('one'));
    await memory.applyExecutionEvent(event('two'));
    await memory.recordExperiment({ id: 'flush' });
    return { c, windows, aggregate };
  };
  const privateResult = await make(true);
  assert.equal(privateResult.windows.length, 3);
  for (const { next } of privateResult.windows) { assert.equal(next.length, 4096); assert.ok(Object.isFrozen(next)); }
  assert.equal(privateResult.c.gets(), 4098, 'one full seed walk plus one check per added marker');
  const publicResult = await make(false);
  assert.equal(publicResult.windows.length, 0);
  assert.equal(Object.isFrozen(publicResult.aggregate.evolution.eventBridge.applied), false);
  assert.deepEqual(privateResult.aggregate.evolution.eventBridge.applied.map(x => x.eventId), publicResult.aggregate.evolution.eventBridge.applied.map(x => x.eventId));
});
