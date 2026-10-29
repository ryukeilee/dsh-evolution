// An archive append no longer re-creates the directory it has already created,
// and takes one identity `stat` where two separate stats asked the same question.
//
// The torn-tail read is *not* skipped: an identity comparison cannot prove the
// last byte is still the newline this instance wrote (a same-size rewrite can
// restore the timestamp, and a writer that interleaves between the append and the
// identity stat makes that stat describe its bytes), so the byte is read on every
// append and the cases below are behaviour, not a memo. The directory skip is the
// only memo here, and it has a way to be wrong: a directory that disappears
// anyway. `#appendArchiveBytes()` re-creates it and retries once, which is what
// the unconditional `mkdir` before every append did.
//
// The tail cases stay in this file because they are the behaviour the append path
// must keep: a fragment is quarantined instead of concatenated, whether it was
// there before the first append, was appended by someone else, was produced by a
// same-length rewrite, or sits in a file that replaced the one this instance had.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EvolutionMemory } from '../../lib/dockyard-domain/memory.js';
import { JsonStateStore } from './support.js';

const NOW = '2026-10-29T00:00:00.000Z';
const ARCHIVE = 'state.json.observations-archive.jsonl';

function scratch(t, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `archive-append-probe-${name}-`));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function makeMemory(root, { nested = false } = {}) {
  const store = new JsonStateStore({ filePath: path.join(root, nested ? 'nested' : '', 'state.json') });
  fs.mkdirSync(path.dirname(store.filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(store.filePath, JSON.stringify({ evolution: { schema: 4 } }), { mode: 0o600 });
  const memory = new EvolutionMemory({ stateStore: store, clock: () => new Date(NOW),
    maxEntries: 1000, hotEntries: 1, hotCycles: 1, archiveMaxBytes: 64 * 1024, absoluteMaxSegmentBytes: 64 * 1024 });
  memory.setMutationAuthority({ assertMutation() {}, isActive: () => true });
  return memory;
}

const row = (id, payload = 'x'.repeat(40)) => ({
  id, type: 'component/observation', severity: 'info', componentId: `component-${id}`, recordedAt: NOW, payload,
});

/** Record enough rows for `id` to be evicted into the active archive file. */
async function archive(memory, id, payload) {
  // The hot window holds one row, so each record evicts the previous one.
  await memory.recordObservation(row(`${id}-seed`, payload));
  await memory.recordObservation(row(id, payload));
  await memory.recordObservation(row(`${id}-next`, payload));
}

function activeFile(root, { nested = false } = {}) {
  return path.join(root, nested ? 'nested' : '', ARCHIVE);
}

function visibleIds(memory) {
  return new Set(memory.history('observations').map(entry => String(entry?.id ?? '')));
}

test('a fragment that was already in the file before the first append is still repaired', async (t) => {
  const root = scratch(t, 'pre-existing');
  // A torn final line from someone else, present before this instance starts.
  fs.writeFileSync(activeFile(root), '{"id":"fragment"', { mode: 0o600 });
  const memory = makeMemory(root);
  await archive(memory, 'after-fragment');
  const ids = visibleIds(memory);
  assert.ok(ids.has('after-fragment'), 'the appended row is readable');
  assert.ok(!ids.has('fragment'), 'the unterminated fragment is not a record');
  const quarantine = path.join(root, 'state.json.observationsquarantine-archive.jsonl');
  assert.match(fs.readFileSync(quarantine, 'utf8'), /"fragment"/, 'the fragment is preserved byte for byte');
  assert.ok(fs.readFileSync(activeFile(root), 'utf8').endsWith('\n'), 'the active file ends on a newline');
});

test('a fragment another writer appends after this instance\'s own append is still repaired', async (t) => {
  const root = scratch(t, 'external-append');
  const memory = makeMemory(root);
  await archive(memory, 'first');
  assert.ok(visibleIds(memory).has('first'));
  // Someone else appends a fragment: the file no longer ends on a record
  // boundary, so the next append must repair it first.
  fs.appendFileSync(activeFile(root), '{"id":"late-fragment"');
  await archive(memory, 'second');
  const ids = visibleIds(memory);
  assert.ok(ids.has('second'), 'the row appended after the fragment is readable');
  assert.ok(!ids.has('late-fragment'));
  const quarantine = path.join(root, 'state.json.observationsquarantine-archive.jsonl');
  assert.match(fs.readFileSync(quarantine, 'utf8'), /late-fragment/, 'the late fragment is quarantined, not concatenated');
});

test('a same-length rewrite of the file is not trusted', async (t) => {
  const root = scratch(t, 'same-length');
  const memory = makeMemory(root);
  await archive(memory, 'first');
  const raw = fs.readFileSync(activeFile(root));
  // Replace the terminating newline with a byte, so the file is exactly as long
  // as the instance left it but no longer ends on a record boundary. Only the
  // last byte itself can show this.
  const rewritten = Buffer.concat([raw.subarray(0, raw.length - 1), Buffer.from('x')]);
  fs.writeFileSync(activeFile(root), rewritten, { mode: 0o600 });
  assert.equal(fs.statSync(activeFile(root)).size, raw.length, 'the rewrite keeps the byte count');
  // The next eviction appends the row that is hot right now. If the probe were
  // skipped, that row's line would be concatenated into the fragment and dropped
  // by the reader; repaired first, it is a record of its own.
  await memory.recordObservation(row('after-rewrite'));
  assert.ok(fs.readFileSync(activeFile(root), 'utf8').endsWith('\n'), 'the file is repaired before the append');
  // Read the row back from a fresh instance: this one still holds the parse it
  // carried forward, so only a restart shows what the file actually says.
  const reopened = makeMemory(root);
  await reopened.load();
  const ids = visibleIds(reopened);
  assert.ok(ids.has('first-next'), 'the row appended into the torn file is readable, not merged into the fragment');
  assert.ok(!ids.has('first'), 'the row whose line was torn is not claimed as a record');
});

test('a replaced active file is a different inode and its fragment is repaired', async (t) => {
  const root = scratch(t, 'replaced');
  const memory = makeMemory(root);
  await archive(memory, 'first');
  // Same length as the file this instance left, but a different inode whose last
  // byte is not a newline.
  const length = fs.statSync(activeFile(root)).size;
  const head = '{"id":"replaced';
  const fragment = Buffer.from(`${head}${'\u0000'.repeat(Math.max(0, length - head.length))}`);
  assert.equal(fragment.length, length, 'the replacement keeps the byte count');
  const replacement = path.join(root, 'replacement.jsonl');
  fs.writeFileSync(replacement, fragment, { mode: 0o600 });
  fs.renameSync(replacement, activeFile(root));
  await memory.recordObservation(row('after-replacement'));
  const reopened = makeMemory(root);
  await reopened.load();
  const ids = visibleIds(reopened);
  assert.ok(ids.has('first-next'), 'the row appended into the replaced file is readable');
  assert.ok(!ids.has('replaced'), 'the replacement fragment is not a record');
});

test('an instance whose own appends stayed terminated appends every row exactly once', async (t) => {
  const root = scratch(t, 'own-appends');
  const memory = makeMemory(root);
  for (const id of ['row-1', 'row-2', 'row-3', 'row-4']) await archive(memory, id);
  const raw = fs.readFileSync(activeFile(root), 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  const stored = lines.map(line => JSON.parse(line).id);
  for (const id of ['row-1', 'row-2', 'row-3', 'row-4']) {
    assert.equal(stored.filter(value => value === id).length, 1, `${id} is appended exactly once`);
  }
  const ids = visibleIds(memory);
  for (const id of ['row-1', 'row-2', 'row-3', 'row-4']) assert.ok(ids.has(id));
});

test('a directory removed anyway is re-created and the append retried', async (t) => {
  const root = scratch(t, 'directory');
  const memory = makeMemory(root, { nested: true });
  await archive(memory, 'before-removal');
  const file = activeFile(root, { nested: true });
  assert.ok(fs.existsSync(file), 'the first appends created the directory');
  // The instance already answered "the directory exists", so this removal is the
  // case the memo would otherwise turn into a failed write. One more record is
  // enough: it evicts the row that is hot right now, and that eviction is the
  // append this test is about (the save that follows would re-create the
  // directory on its own, which is why the row is read back from the file here).
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  await memory.recordObservation(row('after-removal'));
  assert.ok(fs.existsSync(file), 'the append re-created the directory instead of failing');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'exactly the evicted row was appended');
  assert.equal(JSON.parse(lines[0]).id, 'before-removal-next');
});
