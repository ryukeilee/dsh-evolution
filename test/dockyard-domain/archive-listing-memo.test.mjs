/**
 * The per-instance archive listing (`#archiveFiles`) asks the segment directory
 * once and reuses the answer while the directory is provably unchanged: same
 * inode, same mtime. A transaction asks for that listing several times per load
 * and per write, and at a few thousand sealed segments the `readdir` plus sort
 * was the largest per-transaction cost left after the mirror stopped writing one
 * link per segment.
 *
 * The failure this must never have is a *stale* listing: a segment that exists
 * but is not listed is a segment no reader scans and no compaction preserves.
 * So the memo is pinned on three independent properties:
 *
 *   - a rotation this instance performs drops the entry itself, whatever the
 *     directory timestamp says (a filesystem with one-second stamps would
 *     otherwise hide its own seal);
 *   - an entry appearing or disappearing outside this instance still invalidates
 *     it, because the recorded identity is the directory's own;
 *   - a replaced directory is a different directory, and the listing follows it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { EvolutionMemory } from '../../lib/dockyard-domain/memory.js';
import { JsonStateStore } from './support.js';

const NOW = '2026-10-27T00:00:00.000Z';
const ARCHIVE = 'state.json.observations-archive.jsonl';
const SEGMENTS = `${ARCHIVE}.segments`;

function scratch(t, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `listing-memo-${name}-`));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function segment(name, id) {
  return { name, raw: `${JSON.stringify({ id, status: 'observed', recordedAt: NOW, payload: 'x'.repeat(200) })}\n` };
}

function makeMemory(root, options = {}) {
  const store = new JsonStateStore({ filePath: path.join(root, 'state.json') });
  fs.writeFileSync(store.filePath, JSON.stringify({ evolution: { schema: 4 } }), { mode: 0o600 });
  const memory = new EvolutionMemory({ stateStore: store, clock: () => new Date(NOW),
    maxEntries: 1000, hotEntries: 2, hotCycles: 2, archiveMaxBytes: 512, absoluteMaxSegmentBytes: 4096, ...options });
  memory.setMutationAuthority({ assertMutation() {}, isActive: () => true });
  return memory;
}

/** Every visible record, read through the instance's own archive reader. */
async function archivedIds(memory) {
  await memory.load();
  return memory.history('observations').map(entry => String(entry?.id ?? '')).sort();
}

function writeSegments(root, entries) {
  const directory = path.join(root, SEGMENTS);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const entry of entries) fs.writeFileSync(path.join(directory, entry.name), entry.raw, { mode: 0o600 });
}

test('a segment added outside the instance is listed even though the directory entry is cached', async (t) => {
  const root = scratch(t, 'outside');
  const first = segment('segment-000000000001.jsonl', 'sealed-1');
  writeSegments(root, [first]);
  const memory = makeMemory(root);
  assert.deepEqual(await archivedIds(memory), ['sealed-1']);

  const second = segment('segment-000000000002.jsonl', 'sealed-2');
  writeSegments(root, [second]);
  assert.deepEqual((await memory.history('observations')).map(entry => String(entry.id)).sort(), ['sealed-1', 'sealed-2'],
    'a listing taken before the segment existed must not hide it');
});

test('a seal is listed even when the directory timestamp cannot show it', async (t) => {
  const root = scratch(t, 'seal');
  // One committed segment, and a durable aggregate above the hot limit so the
  // load archives rows and rotates the active file into a second segment.
  writeSegments(root, [segment('segment-000000000001.jsonl', 'sealed-1')]);
  const rows = Array.from({ length: 4 }, (_, index) => ({
    id: `rotation-${index}`, type: 'component/observation', severity: 'info',
    componentId: `component-${index}`, recordedAt: NOW, payload: `row-${index}-${'y'.repeat(200)}`,
  }));
  const store = new JsonStateStore({ filePath: path.join(root, 'state.json') });
  fs.writeFileSync(store.filePath, JSON.stringify({ evolution: { schema: 4, observations: rows } }), { mode: 0o600 });
  const directory = path.join(root, SEGMENTS);
  const identity = fs.statSync(directory, { bigint: true });
  const memory = new EvolutionMemory({ stateStore: store, clock: () => new Date(NOW),
    maxEntries: 1000, hotEntries: 2, hotCycles: 2, archiveMaxBytes: 512, absoluteMaxSegmentBytes: 4096 });
  memory.setMutationAuthority({ assertMutation() {}, isActive: () => true });
  // Model a filesystem whose directory stamps are coarser than one transaction:
  // every entry the instance adds after the first listing leaves the identity
  // this instance recorded unchanged. Only the instance's own invalidation can
  // keep its listing true, which is why it does not rely on the stamp alone.
  const original = fs.statSync;
  fs.statSync = function (target, ...rest) {
    if (String(target) === directory) return { dev: identity.dev, ino: identity.ino, mtimeNs: identity.mtimeNs };
    return original.call(this, target, ...rest);
  };
  syncBuiltinESMExports();
  try {
    // The stamp stays frozen while the instance reads its own archive too, so a
    // listing that only trusted the stamp would still be stale here.
    await memory.load();
    const sealed = fs.readdirSync(directory).filter(name => /^segment-[0-9]+\.jsonl$/.test(name));
    assert.ok(sealed.length >= 2, `the load must seal a second segment, got ${sealed.length}`);
    const ids = new Set(memory.history('observations').map(entry => String(entry?.id ?? '')));
    assert.ok(ids.has('sealed-1'), 'the committed segment stays readable');
    for (const row of rows) assert.ok(ids.has(row.id), `${row.id} must be readable through the segment the seal created`);
    assert.equal(memory.archiveDiagnostics().collections.observations.segments.length, sealed.length,
      'the instance counts every segment the seal created');
  } finally {
    fs.statSync = original;
    syncBuiltinESMExports();
  }
});

test('a replaced segment directory is read from, not remembered', async (t) => {
  const root = scratch(t, 'replaced');
  writeSegments(root, [segment('segment-000000000001.jsonl', 'sealed-1')]);
  const memory = makeMemory(root);
  assert.deepEqual(await archivedIds(memory), ['sealed-1']);

  // Replace the directory wholesale, exactly as a compaction installs its layout.
  const directory = path.join(root, SEGMENTS);
  fs.renameSync(directory, `${directory}.old`);
  writeSegments(root, [segment('segment-000000000007.jsonl', 'sealed-7')]);
  assert.deepEqual((await memory.history('observations')).map(entry => String(entry.id)), ['sealed-7'],
    'the listing follows the directory inode, not the name');
  fs.rmSync(`${directory}.old`, { recursive: true, force: true });
});
