// The bridge marker window is the one part of the memory state the port's save
// check judges once per marker instead of re-serializing it on every save
// (`assertStagedTransactionSave` in `lib/domain-storage.js`). That reuse is
// sound only while a marker cannot change after it enters the window, so the
// memory states that as a property of the value - `Object.freeze` - instead of a
// convention, and this file pins it:
//
//   - every marker this instance appends is frozen and holds only primitive
//     fields, which is exactly the shape the check may memoize;
//   - every marker a load brings in is frozen too, or a restart with a full
//     window would silently fall back to re-serializing all 4,096 of them on
//     every save of the next batch;
//   - a marker that is not a plain object is left alone (freezing it would not
//     make it immutable, and the check keeps judging that window as before);
//   - freezing changes no durable byte and no projection: the window is still
//     read, appended to and published exactly as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { EvolutionMemory } from '../../lib/dockyard-domain/memory.js';

const authority = { assertMutation() {}, isActive: () => true };

async function makeMemory(t, initial = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bridge-markers-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const stateFile = path.join(home, 'state.json');
  let aggregate = { evolution: { schema: 4, eventBridge: { schema: 1, applied: [] }, coldArchives: {}, ...initial } };
  const stateStore = {
    filePath: stateFile,
    // The port's staged store declares this, so `#save` hands `persist` the live
    // shallow view (`{ ...this.#data }`) instead of a deep clone.
    inlineSerialization: true,
    async load() { return structuredClone(aggregate); },
    async update(updater) { aggregate = updater(aggregate); await fs.writeFile(stateFile, JSON.stringify(aggregate)); },
  };
  // The port's staged store is `transaction.persist`, and the payload it is
  // handed is the memory's live state (`{ ...this.#data }`, not a clone), which
  // is exactly the object the save check judges. Capturing it is how this test
  // sees what the check sees.
  let saved = null;
  const persist = async (updater) => {
    const next = updater(aggregate);
    saved = next.evolution;
    aggregate = next;
  };
  const memory = new EvolutionMemory({
    stateStore,
    transaction: { persist },
    clock: () => new Date('2026-10-28T00:00:00.000Z'),
    mutationAuthority: authority,
  });
  await memory.load();
  return { memory, home, stateFile, aggregate: () => aggregate, saved: () => saved };
}

const event = (sequence) => ({
  schema: 1,
  eventId: `evolution:measurement-completed:marker-${sequence}`,
  eventType: 'measurement-completed',
  experimentId: `marker-${sequence}`,
  proposalId: `proposal-marker-${sequence}`,
  target: 'plugin:marker-window',
  capability: 'plugin:marker-window',
  lineageId: 'plugin:marker-window',
  measurement: { latency: 10 + sequence },
  evidence: { testPassed: true },
  audit: { producer: 'dsh-evolution-orchestrator', at: '2026-10-28T00:00:00.000Z' },
});

const flatPrimitive = (value) => value !== null && ['string', 'number', 'boolean'].includes(typeof value);

test('an applied marker is frozen and flat, so the save check can judge it once', async (t) => {
  const { memory, saved } = await makeMemory(t);
  const applied = await memory.applyExecutionEvent(event(1));
  assert.equal(applied.applied, true);

  const window = saved().eventBridge.applied;
  assert.equal(window.length, 1);
  const [marker] = window;
  assert.ok(Object.isFrozen(marker), 'a marker must be immutable once it is in the window');
  assert.deepEqual(Object.keys(marker).sort(), ['appliedAt', 'eventId', 'eventType', 'experimentId']);
  for (const value of Object.values(marker)) assert.ok(flatPrimitive(value), 'a marker holds only primitive fields');

  // A later save hands over the same window object and the same marker objects:
  // the memory appends and never rewrites one.
  await memory.recordExperiment({ id: 'plain-experiment', status: 'candidate' });
  const after = saved().eventBridge.applied;
  assert.equal(after.length, 1);
  assert.equal(after[0], marker, 'the window keeps the marker object itself');
});

test('a loaded marker window is frozen without changing what it projects', async (t) => {
  const stored = {
    schema: 4,
    eventBridge: {
      schema: 1,
      applied: [
        { eventId: 'evolution:measurement-completed:loaded-1', eventType: 'measurement-completed', experimentId: 'loaded-1', appliedAt: '2026-10-27T00:00:00.000Z' },
        { eventId: 'evolution:measurement-completed:loaded-2', eventType: 'measurement-completed', experimentId: 'loaded-2', appliedAt: '2026-10-27T00:00:01.000Z' },
      ],
    },
  };
  const { memory, aggregate, saved } = await makeMemory(t, { eventBridge: stored.eventBridge });

  // The frozen state is the memory's own view, which `persist` is handed; the
  // public projection is a clone and is compared for its values only.
  assert.deepEqual(memory.snapshot().eventBridge, stored.eventBridge, 'freezing must not change the projection');

  // Appending keeps the older markers, their values and their immutable identity.
  await memory.applyExecutionEvent(event(3));
  const window = saved().eventBridge.applied;
  assert.equal(window.length, 3);
  assert.deepEqual(window.slice(0, 2), stored.eventBridge.applied);
  for (const marker of window) assert.ok(Object.isFrozen(marker), 'a loaded marker is frozen after load');
  assert.ok(window[2].eventId.endsWith('marker-3'));

  // A published document still round-trips through JSON unchanged.
  const durable = JSON.parse(JSON.stringify(aggregate()));
  assert.deepEqual(durable.evolution.eventBridge.applied, memory.snapshot().eventBridge.applied);
});

test('a window this instance did not write still replays unchanged', async (t) => {
  // A window written by something else may hold values with no primitive-only
  // shape. Freezing is shallow, so such a marker is frozen but still carries a
  // nested value - which is exactly why the save check only reuses a marker whose
  // own fields are all primitive (`staged-save-check.test.js` pins that fallback)
  // and keeps judging this window in full.
  const loaded = [{ eventId: 'not-plain', nested: { deep: [1, 2] } }, 'a string entry', 42];
  const { memory, saved } = await makeMemory(t, { eventBridge: { schema: 1, applied: loaded } });
  assert.deepEqual(memory.snapshot().eventBridge.applied, loaded, 'the projection is the stored window');

  assert.equal((await memory.applyExecutionEvent(event(4))).applied, true);
  const window = saved().eventBridge.applied;
  assert.deepEqual(window.slice(0, 3), loaded, 'every loaded entry is kept as it was');
  assert.equal(window.length, 4);
  assert.equal(window[3].eventId.endsWith('marker-4'), true);
});
