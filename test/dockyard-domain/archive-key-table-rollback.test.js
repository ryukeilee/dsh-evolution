// A failed archive append must leave the archive's key tables exactly as they
// were.
//
// `#archiveEntries()` records the key of every row it is about to append in
// `archiveKnown` (and may toggle `archiveTombstones`), then appends. Its
// rollback used to restore a full copy of both tables; it now undoes exactly the
// entries that attempt added or toggled (`addedKnown` / `toggledTombstones`).
// The two are equivalent only if nothing else replaces those tables while the
// attempt is awaiting, which is what the assertions below are about:
//
//   - a key whose append failed must NOT stay in the table. If it did, the next
//     eviction of that row would skip it ("already archived"), drop it from the
//     hot window, and the record would exist in neither place;
//   - a tombstone toggle whose append failed must be undone, or the collection's
//     published `count` (`known - tombstones`) would drift from the rows the
//     archive actually holds.
//
// Both are checked against the observable state: the archive file's lines, the
// published `coldArchives` metadata and `history()`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { EvolutionMemory } from '../../lib/dockyard-domain/memory.js';

const authority = { assertMutation() {}, isActive: () => true };

async function makeHome(t, initial = {}, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-archive-rollback-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const stateFile = path.join(home, 'state.json');
  let aggregate = {
    evolution: { schema: 4, observations: [], experiments: [], coldArchives: {}, eventBridge: { schema: 1, applied: [] }, ...initial },
  };
  const stateStore = {
    filePath: stateFile,
    async load() { return structuredClone(aggregate); },
    async update(updater) {
      aggregate = updater(aggregate);
      await fs.writeFile(stateFile, JSON.stringify(aggregate));
    },
  };
  let failWrites = false;
  const openMemory = async () => {
    const memory = new EvolutionMemory({
      stateStore,
      hotEntries: 1,
      ...options,
      archiveMaxBytes: 64 * 1024,
      clock: () => new Date('2026-10-28T00:00:00.000Z'),
      mutationAuthority: authority,
      archiveWriteGuard: async () => {
        if (failWrites) throw Object.assign(new Error('EIO: simulated archive write failure'), { code: 'EIO' });
      },
    });
    await memory.load();
    return memory;
  };
  return { home, stateFile, openMemory, fail: () => { failWrites = true; }, allow: () => { failWrites = false; }, state: () => aggregate };
}

const signal = (id) => ({ id, type: 'tool/error', componentId: 'archive-rollback', message: `signal ${id}`, forceRecord: true });

const archiveLines = async (home, collection) => {
  const file = path.join(home, `state.json.${collection}-archive.jsonl`);
  try {
    return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
};

test('a failed append leaves no key behind, so the retry still writes the row', async (t) => {
  const { home, openMemory, fail, allow } = await makeHome(t);
  const memory = await openMemory();

  // `hotEntries: 1`: the second record evicts the first, and that append fails.
  await memory.recordObservation(signal('a'));
  fail();
  await memory.recordObservation(signal('b'));
  assert.deepEqual(await archiveLines(home, 'observations'), [], 'a failed append writes nothing');
  assert.equal(memory.snapshot().coldArchives?.observations, undefined,
    'a failed append publishes no archive metadata');
  const fault = (memory.archiveIntegrity().observations ?? []).find((entry) => entry.kind === 'deferred-write');
  assert.ok(fault, 'the failure is still reported as a deferred write');
  const kept = memory.history('observations').map((entry) => entry.id);
  assert.deepEqual(kept, ['a', 'b'], 'both rows stay in the hot window while the archive write fails');

  // The retry evicts both rows. If the failed attempt had left `a` in the key
  // table, this append would skip it and `a` would vanish from `history()`.
  allow();
  await memory.recordObservation(signal('c'));
  const lines = await archiveLines(home, 'observations');
  assert.deepEqual(lines.map((entry) => entry.id), ['a', 'b'], 'the retry archives exactly the rows it evicted');
  const history = memory.history('observations').map((entry) => entry.id);
  assert.deepEqual(history, ['a', 'b', 'c'], 'every record is still reachable exactly once');
  assert.equal(memory.snapshot().coldArchives.observations.count, 2, 'the published count matches the archived rows');
  assert.ok(!(memory.archiveIntegrity().observations ?? []).some((entry) => entry.kind === 'deferred-write'),
    'the completed write clears the fault');

  // And a reload reads the same three rows from the same two places.
  const reloaded = await openMemory();
  assert.deepEqual(reloaded.history('observations').map((entry) => entry.id), ['a', 'b', 'c']);
});

test('a failed append does not publish a tombstone decision it did not write', async (t) => {
  // A retired row is archived with its tombstone marker, which is why the key
  // table subtracts those keys from the published row `count`. Seeding the field
  // is the only way to reach that branch through the public surface, and it is a
  // shape an older durable document can legitimately carry.
  const retired = { id: 'retired', type: 'tool/error', componentId: 'archive-rollback', message: 'retired signal', __evolutionTombstone: 1 };
  const { home, openMemory, fail, allow } = await makeHome(t, { observations: [retired] });
  const memory = await openMemory();
  assert.deepEqual(memory.snapshot().coldArchives?.observations, undefined, 'a load without excess keeps no archive metadata');

  fail();
  await memory.recordObservation(signal('a'));
  assert.deepEqual(await archiveLines(home, 'observations'), [], 'the failed append wrote nothing');
  assert.equal(memory.snapshot().coldArchives?.observations?.count ?? 0, 0,
    'a failed append must not publish a count derived from a tombstone it did not write');

  allow();
  await memory.recordObservation(signal('b'));
  const lines = await archiveLines(home, 'observations');
  assert.deepEqual(lines.map((entry) => entry.id), ['retired', 'a'], 'the retry writes both evicted rows');
  assert.equal(memory.snapshot().coldArchives.observations.count, 1,
    'the tombstoned row is subtracted from the published count, not from the archive');
});

test('a failed attempt that toggles one key twice restores the table it started from', async (t) => {
  // One attempt can carry two entries with the same archive key: a restored or
  // loaded snapshot may hold two versions of one durable id, and one of them is
  // the tombstoned form. The replacement path processes both, so the same key is
  // toggled twice in one attempt, and the rollback has to restore the state the
  // attempt started from - which is why the toggles are undone in reverse. (The
  // order is not observable through the port: every archive read re-installs
  // both tables from the file, so a leaked bit is gone before the next
  // publication. The assertion below pins the outcome this path must produce
  // either way, and the duplicate-key attempt is what exercises it.)
  const row = (id, extra = {}) => ({ id, type: 'tool/error', componentId: 'archive-rollback', ...extra });
  const retired = { ...row('dup', { message: 'retired dup' }), __evolutionTombstone: 1 };
  const fixture = await makeHome(t, { observations: [row('dup', { message: 'archived dup' }), row('filler')] }, { hotEntries: 1 });
  const { openMemory, fail, allow } = fixture;
  const memory = await openMemory();
  // The load evicts and archives the first row, which is what puts the key in
  // the table with a known, non-tombstoned value.
  assert.deepEqual((await archiveLines(fixture.home, 'observations')).map((entry) => entry.id), ['dup']);
  assert.equal(memory.snapshot().coldArchives.observations.count, 1);

  // A cold boundary (`count: 1`) makes `restore()` treat the leading rows as the
  // cold segment. Both versions of `dup` reach one replacement attempt, which is
  // the only shape that toggles one key twice in a single attempt.
  fail();
  await memory.restore({ observations: [retired, row('dup', { message: 'plain dup' }), row('hot')],
    coldArchives: { observations: { count: 1 } } });
  assert.deepEqual((await archiveLines(fixture.home, 'observations')).map((entry) => entry.id), ['dup'],
    'the failed attempt wrote nothing');

  // A later successful write for the same collection publishes the count from
  // the tables. It must not inherit a tombstone bit from the failed attempt.
  allow();
  await memory.restore({ observations: [row('cold'), row('kept')], coldArchives: { observations: { count: 1 } } });
  assert.deepEqual((await archiveLines(fixture.home, 'observations')).map((entry) => entry.id), ['dup', 'cold'],
    'the retry archived its own cold row');
  assert.equal(memory.snapshot().coldArchives.observations.count, 2,
    'the count is the two archived rows minus no tombstone: the failed attempt must not leave one behind');
});
