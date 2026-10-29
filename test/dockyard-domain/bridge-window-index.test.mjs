// The bridge marker window answers "have I applied this eventId?" from an index
// instead of scanning up to 4,096 entries per applied record. The index is only a
// faster way to ask the released expression
// (`applied.some(entry => String(entry?.eventId ?? entry) === eventId)`), so this
// file pins every way it could answer something else:
//
//   - a loaded window (an instance that did not build it) is indexed too, and a
//     duplicate in it is still recognised;
//   - the entry an append pushes out of the window stops matching, and one that
//     is still in the window because it appeared twice keeps matching until the
//     last copy leaves;
//   - a bare string entry is *not* its own id in the released expression: it reads
//     `String.prototype.eventId`, so a poisoned prototype answers a different id.
//     That is why a window containing one is never indexed, and this file pins the
//     poisoned-prototype answer;
//   - an entry whose `eventId` is not an own data string (`new String(id)`, a null
//     `eventId`, a number, a nested value) keeps the scan and therefore keeps
//     `String(...)`'s answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { EvolutionMemory } from '../../lib/dockyard-domain/memory.js';

const NOW = '2026-10-29T00:00:00.000Z';
const WINDOW = 4096;

const event = sequence => ({
  schema: 1,
  eventId: `evolution:measurement-completed:window-${sequence}`,
  eventType: 'measurement-completed',
  experimentId: `window-${sequence}`,
  proposalId: `proposal-window-${sequence}`,
  target: 'plugin:window',
  capability: 'plugin:window',
  lineageId: 'plugin:window',
  measurement: { latency: 10 },
  evidence: { testPassed: true },
  audit: { producer: 'dsh-evolution-orchestrator', at: NOW },
});

const marker = sequence => ({
  eventId: `evolution:measurement-completed:window-${sequence}`,
  eventType: 'measurement-completed',
  experimentId: `window-${sequence}`,
  appliedAt: NOW,
});

async function makeMemory(t, window, { live = false } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bridge-window-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let aggregate = { evolution: { schema: 4, eventBridge: { schema: 1, applied: window }, coldArchives: {} } };
  const stateStore = {
    filePath: path.join(home, 'state.json'),
    inlineSerialization: true,
    // A state store that hands over its live aggregate instead of a copy is a
    // documented port shape, and the only one through which a window entry that
    // is not plain data can reach the memory.
    async load() { return live ? aggregate : structuredClone(aggregate); },
    async update(updater) { aggregate = updater(aggregate); },
  };
  let saved = null;
  const persist = async updater => { const next = updater(aggregate); saved = next.evolution; aggregate = next; };
  const memory = new EvolutionMemory({ stateStore, transaction: { persist }, clock: () => new Date(NOW),
    mutationAuthority: { assertMutation() {}, isActive: () => true } });
  await memory.load();
  return { memory, saved: () => saved };
}

test('a duplicate is recognised in a window this instance loaded', async (t) => {
  const window = Array.from({ length: WINDOW }, (_, index) => marker(index + 1));
  const { memory } = await makeMemory(t, window);
  const duplicate = await memory.applyExecutionEvent(event(WINDOW));
  assert.deepEqual({ applied: duplicate.applied, duplicate: duplicate.duplicate }, { applied: false, duplicate: true });
  // An event the window does not cover is still applied, and the appends keep the
  // window at its bound with the head dropped.
  const fresh = await memory.applyExecutionEvent(event(WINDOW + 1));
  assert.equal(fresh.applied, true);
});

test('the entry an append drops stops matching, and a duplicate id keeps matching until its last copy leaves', async (t) => {
  // The head id appears twice: the first append drops one copy and the id must
  // keep matching; the second append drops the other and it must stop.
  const window = Array.from({ length: WINDOW }, (_, index) => marker(index + 1));
  window[0] = marker(1);
  window[1] = marker(1);
  const { memory, saved } = await makeMemory(t, window);
  const idOf = sequence => `evolution:measurement-completed:window-${sequence}`;

  assert.equal((await memory.applyExecutionEvent(event(WINDOW + 1))).applied, true);
  assert.equal(saved().eventBridge.applied.length, WINDOW);
  const stillPresent = await memory.applyExecutionEvent({ ...event(1), experimentId: 'window-1', eventId: idOf(1) });
  assert.deepEqual({ applied: stillPresent.applied, duplicate: stillPresent.duplicate }, { applied: false, duplicate: true },
    'one copy of the id is still inside the window');

  assert.equal((await memory.applyExecutionEvent(event(WINDOW + 2))).applied, true);
  // Both copies of `window-1` have now been pushed out. The event is applied
  // again, which is exactly what the released scan answers for a window that no
  // longer holds the id.
  const afterDrop = await memory.applyExecutionEvent({ ...event(1), experimentId: 'window-1', eventId: idOf(1) });
  assert.equal(afterDrop.applied, true, 'an id that left the window is not remembered by the index');
  assert.equal((await memory.applyExecutionEvent(event(WINDOW + 3))).applied, true);
  // The newest appends are matched by the maintained index.
  const newest = await memory.applyExecutionEvent(event(WINDOW + 2));
  assert.deepEqual({ applied: newest.applied, duplicate: newest.duplicate }, { applied: false, duplicate: true });
});

test('a bare string entry answers through String.prototype, so that window is not indexed', async (t) => {
  // `entry?.eventId` on a string primitive reads `String.prototype.eventId`. The
  // released scan therefore answers whatever the prototype says, and poisoning it
  // after this instance built any index would change the answer.
  const window = ['evolution:measurement-completed:bare'];
  const poisoned = 'evolution:measurement-completed:poisoned';
  const { memory } = await makeMemory(t, window);
  const answer = async (eventId, experimentId) => {
    const result = await memory.applyExecutionEvent({ ...event(1), eventId, experimentId });
    return { applied: result.applied, duplicate: result.duplicate };
  };
  // Without the poison the string is its own id, through `String(entry)`.
  assert.deepEqual(await answer('evolution:measurement-completed:bare', 'bare'), { applied: false, duplicate: true });
  Object.defineProperty(String.prototype, 'eventId', { value: poisoned, configurable: true });
  try {
    assert.deepEqual(await answer(poisoned, 'poisoned'), { applied: false, duplicate: true },
      'the released scan reads the inherited id, so the poisoned id is what the window answers');
    assert.deepEqual(await answer('evolution:measurement-completed:other', 'other'), { applied: true, duplicate: false });
  } finally {
    delete String.prototype.eventId;
  }
});

test('a window whose ids are not decided by data keeps the released scan', async (t) => {
  // A window this plugin did not write can hold entries whose id does not come
  // from an `eventId` data property, so it must keep the released scan:
  //   - a bare string is its own id,
  //   - `{ eventId: null }` falls through `??` to the object itself
  //     (`String({})` = "[object Object]"), and a number or a nested object is
  //     not a plain data `eventId` either.
  const window = [marker(1), { eventId: null }, 42, { eventId: new String('evolution:measurement-completed:wrapped') }];
  const { memory, saved } = await makeMemory(t, window);
  const answer = async (eventId, experimentId) => {
    const result = await memory.applyExecutionEvent({ ...event(1), eventId, experimentId });
    return { applied: result.applied, duplicate: result.duplicate };
  };
  assert.deepEqual(await answer('evolution:measurement-completed:window-1', 'window-1'), { applied: false, duplicate: true });
  assert.deepEqual(await answer('evolution:measurement-completed:wrapped', 'wrapped'), { applied: false, duplicate: true },
    'an `eventId` that is not a primitive string still answers through `String(...)`');
  // An id no entry answers is applied even though the window holds an entry whose
  // `eventId` is not a string; nothing in the fallback matches "[object Object]".
  assert.deepEqual(await answer('evolution:measurement-completed:fresh', 'fresh'), { applied: true, duplicate: false });
  // The window is still published with every entry, unchanged and in order.
  await memory.recordExperiment({ id: 'plain', status: 'candidate' });
  assert.deepEqual(saved().eventBridge.applied.slice(0, window.length), window);
});

test('a marker whose eventId is an accessor is read once per lookup, not once per window', async (t) => {
  // The released expression reads `eventId` on every lookup, and an accessor's
  // answer is a function of code rather than of the window's data, so this window
  // is never indexed. The read count is what shows it: an indexed window would
  // read the accessor once (when the index is built) and never again.
  const identifier = 'evolution:measurement-completed:accessor-stable';
  let reads = 0;
  const entry = { appliedAt: NOW, experimentId: 'accessor-stable' };
  Object.defineProperty(entry, 'eventId', {
    enumerable: true,
    get() { reads += 1; return identifier; },
  });
  const { memory } = await makeMemory(t, [entry], { live: true });
  const answer = async () => {
    const result = await memory.applyExecutionEvent({ ...event(1), eventId: identifier, experimentId: 'accessor-stable' });
    return { applied: result.applied, duplicate: result.duplicate };
  };
  const before = reads;
  assert.deepEqual(await answer(), { applied: false, duplicate: true });
  const afterFirst = reads;
  assert.deepEqual(await answer(), { applied: false, duplicate: true });
  assert.equal(afterFirst - before, 1, 'the first lookup reads the accessor once');
  assert.equal(reads - afterFirst, 1, 'the second lookup reads it again instead of consulting an index');
});
