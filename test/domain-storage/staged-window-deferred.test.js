// The bridge marker window of the private staged replay working copy.
//
// A cold replay saves once per absorbed record. The released staging rebuilt a
// frozen successor of the marker window for every one of those records (a copy
// of up to 4,095 references plus a freeze). This file pins the replacement:
// that working copy grows one native array in place, reports every append to
// the port with the exact length and tail marker it produced, and publishes the
// bounded last-4,096 window through `snapshot()`.
//
// The save certificate is the part that must not loosen. These tests pin:
//
//   - only the marker(s) appended since the last successful save are judged;
//   - a window that does not match the last reported length/tail is walked in
//     full, exactly like an unreported window;
//   - a failed save certifies nothing, and the next save still rejects;
//   - the body/literal checks still run before the certificate;
//   - the deferred form exists only for the replay's own working copy; every
//     other transaction keeps the released frozen-window check;
//   - the published window is exactly the last 4,096 markers, in event order,
//     with the same ids, dedup answers and bounds as the released path.
import test from 'node:test';
import assert from 'node:assert/strict';

import { EvolutionMemory } from '../../lib/dockyard-domain/memory.js';
import { assertStagedTransactionSave, assertTransactionSave, createStagedWindowChecks } from '../../lib/domain-storage.js';

const marker = (index, extra = {}) => Object.freeze({
  eventId: `evolution:measurement-completed:deferred-${index}`,
  eventType: 'measurement-completed',
  experimentId: `deferred-${index}`,
  appliedAt: '2026-10-28T00:00:00.000Z',
  ...extra,
});
const document = (window) => ({ evolution: { schema: 4, experiments: [], eventBridge: { schema: 1, applied: window } } });
const capture = (work) => {
  try { work(); return null; } catch (error) { return { name: error.name, message: error.message }; }
};

/** The deferred checker with a memo whose reads are counted. */
function deferredChecker() {
  const checks = createStagedWindowChecks({ deferredWindows: true });
  const memo = new WeakMap();
  let gets = 0;
  const get = memo.get.bind(memo);
  memo.get = (value) => { gets += 1; return get(value); };
  return {
    ...checks,
    memo,
    gets: () => gets,
    check: (payload) => assertStagedTransactionSave(payload, memo, checks.windows, checks.elements),
  };
}

test('a reported in-place append judges only its added marker', () => {
  const c = deferredChecker();
  const window = Array.from({ length: 4096 }, (unused, index) => marker(`seed-${index}`));
  c.changed(null, window, null);
  c.check(document(window));
  assert.equal(c.gets(), 4096, 'the seed window is walked once');

  c.check(document(window));
  assert.equal(c.gets(), 4096, 'a verified window with no reported append is not walked again');

  const added = marker('next');
  window.push(added);
  c.changed(window, window, added);
  c.check(document(window));
  assert.equal(c.gets(), 4097, 'only the reported marker is judged');
});

test('an unreported push or tail change keeps the released whole-document walk', () => {
  const c = deferredChecker();
  const window = [marker('one')];
  c.changed(null, window, null);
  c.check(document(window));

  // A push nobody reported cannot inherit the verified record: the recorded
  // length no longer matches, so the whole-document check decides.
  window.push(Object.freeze({ eventId: 1n }));
  assert.deepEqual(capture(() => c.check(document(window))), capture(() => assertTransactionSave(document(window))));
  assert.equal(c.windows.get(window), undefined, 'the mismatched report is dropped, not inherited');

  // Same length, different tail: also not the value the hook was told about.
  const reported = [marker('reported')];
  c.changed(null, reported, null);
  c.check(document(reported));
  reported[reported.length - 1] = Object.freeze({ eventId: 2n });
  assert.deepEqual(capture(() => c.check(document(reported))), capture(() => assertTransactionSave(document(reported))));
});

test('a failed save certifies nothing, and the next save still rejects', () => {
  const c = deferredChecker();
  const window = [marker('one')];
  c.changed(null, window, null);
  c.check(document(window));

  const added = Object.freeze({ eventId: 'unsafe', value: 1n });
  window.push(added);
  c.changed(window, window, added);
  const error = capture(() => c.check(document(window)));
  assert.equal(error.name, 'TypeError');
  assert.equal(c.windows.get(window).verified, false);

  // Appending a sound marker afterwards does not launder the failed entry: the
  // retained window still contains it, so the next save rejects at the same
  // value again.
  const next = marker('next');
  window.push(next);
  c.changed(window, window, next);
  assert.deepEqual(capture(() => c.check(document(window))), error);
});

test('the body and literal checks still decide before the certificate', () => {
  const c = deferredChecker();
  const window = Array.from({ length: 8 }, (unused, index) => marker(index));
  c.changed(null, window, null);
  c.check(document(window));

  for (const build of [
    () => { const payload = document(window); payload.evolution.total = 10n; return payload; },
    () => { const payload = document(window); payload.evolution.nested = { toJSON() { throw new TypeError('body toJSON'); } }; return payload; },
    () => { const payload = document(window); payload.evolution.note = '__proto__'; return payload; },
  ]) {
    assert.deepEqual(capture(() => c.check(build())), capture(() => assertTransactionSave(build())));
  }
});

test('the periodic reduction is re-reported by identity, not inherited by array equality', () => {
  const c = deferredChecker();
  const window = Array.from({ length: 4096 }, (unused, index) => marker(`seed-${index}`));
  c.changed(null, window, null);
  c.check(document(window));
  const afterSeed = c.gets();

  // What the memory does at its bound: append, then replace the window with the
  // retained suffix. The new array was never reported while it did not exist.
  const added = marker('reduced');
  window.push(added);
  const reduced = window.slice(-4096);
  c.changed(window, reduced, added);
  c.check(document(reduced));
  assert.equal(c.gets(), afterSeed + 1, 'the reduction inherits the judged markers and judges only the new one');
  assert.equal(c.windows.get(reduced).verified, true);

  // A window the hook never reported (a different array with the same values)
  // has no certificate at all.
  const unreported = reduced.slice();
  c.check(document(unreported));
  assert.equal(c.windows.get(unreported), undefined);
});

test('a mutable window reported without deferred mode keeps the released walk', () => {
  const checks = createStagedWindowChecks();
  const memo = new WeakMap();
  const window = [marker('mutable')];
  checks.changed(null, window, null);
  assert.equal(checks.windows.get(window), undefined);
  assert.deepEqual(
    capture(() => assertStagedTransactionSave(document(window), memo, checks.windows)),
    capture(() => assertTransactionSave(document(window))),
  );
});

const event = (sequence) => ({
  schema: 1,
  eventId: `evolution:measurement-completed:deferred-${sequence}`,
  eventType: 'measurement-completed',
  experimentId: `deferred-${sequence}`,
  proposalId: `proposal-deferred-${sequence}`,
  target: 'plugin:deferred-window',
  capability: 'plugin:deferred-window',
  lineageId: 'plugin:deferred-window',
  measurement: { latency: sequence },
  evidence: { testPassed: true },
  audit: { producer: 'dsh-evolution-orchestrator', at: '2026-10-28T00:00:00.000Z' },
});

/**
 * The port's private replay working copy in miniature: the staged store's save
 * check, the window hook, and a measurement marker whose save is coalesced.
 */
async function replayMemory({ defer, events, initialWindow = [] }) {
  const checks = createStagedWindowChecks({ deferredWindows: defer });
  const memo = new WeakMap();
  let aggregate = { evolution: { schema: 4, eventBridge: { schema: 1, applied: initialWindow }, coldArchives: {} } };
  const reports = [];
  const stateStore = {
    inlineSerialization: true,
    async load() { return structuredClone(aggregate); },
    async update(updater) {
      const next = updater(aggregate);
      assertStagedTransactionSave(next, memo, checks.windows, checks.elements);
      aggregate = next;
    },
  };
  const memory = new EvolutionMemory({
    stateStore,
    clock: () => new Date('2026-10-28T00:00:00.000Z'),
    transaction: {
      persist: stateStore.update,
      bridgeWindowChanged(previous, next, added) {
        reports.push({ previous, next, added });
        checks.changed(previous, next, added);
      },
    },
    archiveWriteGuard: () => {},
    coalesceMeasurementMarkerPersist: true,
    deferBridgeWindowRebuild: defer,
    mutationAuthority: { assertMutation() {} },
  });
  await memory.load();
  for (const record of events) await memory.applyExecutionEvent(record);
  return { memory, reports };
}

test('the staged replay window grows in place and publishes the released bounded window', async () => {
  const events = Array.from({ length: 4300 }, (unused, index) => event(index + 1));
  const released = await replayMemory({ defer: false, events });
  const deferred = await replayMemory({ defer: true, events });

  const releasedWindow = released.memory.snapshot().eventBridge.applied;
  const deferredWindow = deferred.memory.snapshot().eventBridge.applied;
  assert.equal(releasedWindow.length, 4096);
  assert.equal(deferredWindow.length, 4096);
  assert.deepEqual(deferredWindow.map((entry) => entry.eventId), releasedWindow.map((entry) => entry.eventId),
    'the published window is the same last 4,096 markers, in the same order');
  assert.deepEqual(JSON.parse(JSON.stringify(deferred.memory.snapshot())), JSON.parse(JSON.stringify(released.memory.snapshot())));
  assert.equal(deferred.memory.stats().bridgeEventsApplied, 4096);
  assert.equal(released.memory.stats().bridgeEventsApplied, 4096);

  // The released path published a new frozen successor for every marker; the
  // deferred path appends to one array (no reduction is reached at 5,000).
  const replacements = (reports) => reports.filter((report) => report.previous !== null && report.next !== report.previous).length;
  assert.equal(replacements(released.reports), events.length);
  assert.equal(replacements(deferred.reports), 0);
  assert.ok(deferred.reports.every((report) => report.next === deferred.reports[0].next),
    'every append reaches the hook as the same owned array');
  assert.ok(deferred.reports.every((report) => report.next.length <= 4300));

  // Bounded membership semantics: the newest marker dedupes, the oldest one no
  // longer does.
  assert.equal((await deferred.memory.applyExecutionEvent(event(4300))).duplicate, true);
  assert.equal((await released.memory.applyExecutionEvent(event(4300))).duplicate, true);
  assert.equal((await deferred.memory.applyExecutionEvent(event(1))).applied, true);
  assert.equal((await released.memory.applyExecutionEvent(event(1))).applied, true);
});

test('the periodic reduction keeps the replay window bounded, ordered and within one extra window', async () => {
  const total = 8200;
  const events = Array.from({ length: total }, (unused, index) => event(index + 1));
  const deferred = await replayMemory({ defer: true, events });
  const window = deferred.memory.snapshot().eventBridge.applied;
  assert.equal(window.length, 4096);
  assert.deepEqual(window.map((entry) => entry.eventId),
    events.slice(-4096).map((record) => record.eventId));
  assert.equal(deferred.memory.stats().bridgeEventsApplied, 4096);

  const replacements = deferred.reports.filter((report) => report.previous !== null && report.next !== report.previous);
  assert.equal(replacements.length, 1, 'one reduction for 8,200 appends');
  assert.ok(deferred.reports.every((report) => report.next.length <= 8193),
    'the growable window never holds more than the bounded window plus one');
  assert.equal(deferred.memory.fullSnapshot().eventBridge.applied.length, 4096);
});

test('a loaded window the released index cannot read falls back without changing the result', async () => {
  const loaded = [Object.freeze({ eventId: 'not-plain', nested: { deep: [1, 2] } }), 'primitive', 42];
  const events = [event(1), event(2)];
  const released = await replayMemory({ defer: false, events, initialWindow: loaded.map((entry) => entry) });
  const deferred = await replayMemory({ defer: true, events, initialWindow: loaded.map((entry) => entry) });
  assert.deepEqual(deferred.memory.snapshot().eventBridge.applied, released.memory.snapshot().eventBridge.applied);
  assert.deepEqual(JSON.parse(JSON.stringify(deferred.memory.snapshot())), JSON.parse(JSON.stringify(released.memory.snapshot())));
});

test('a loaded window longer than the bound is reduced on the first append', async () => {
  // The durable window is bounded, but a restored or older document can carry
  // more. The released path drops everything before its last 4,095 entries plus
  // the new marker; the in-place window must answer membership over the same
  // set before and after that append.
  const loaded = Array.from({ length: 4100 }, (unused, index) => marker(`loaded-${index}`));
  const events = [event(1)];
  const released = await replayMemory({ defer: false, events, initialWindow: loaded.map((entry) => entry) });
  const deferred = await replayMemory({ defer: true, events, initialWindow: loaded.map((entry) => entry) });
  const releasedWindow = released.memory.snapshot().eventBridge.applied;
  const deferredWindow = deferred.memory.snapshot().eventBridge.applied;
  assert.equal(releasedWindow.length, 4096);
  assert.deepEqual(deferredWindow.map((entry) => entry.eventId), releasedWindow.map((entry) => entry.eventId));

  // The first stored id is outside the reduced window and the last stored one is
  // inside it, in both implementations.
  assert.equal((await deferred.memory.applyExecutionEvent(event(0))).applied,
    (await released.memory.applyExecutionEvent(event(0))).applied);
  assert.equal((await deferred.memory.applyExecutionEvent(event(1))).duplicate,
    (await released.memory.applyExecutionEvent(event(1))).duplicate);
});
