// The cold-archive scan reads bytes, not whole files.
//
// `#scanArchiveRead` and the archive-index scan fold one line at a time out of a
// bounded chunk, so nothing in the read path holds a whole file as one string, a
// split line array, or one parsed object per record. That representation is only
// allowed to be unobservable, so these tests pin it the way the earlier read
// rounds did: against the frozen whole-file implementation, on the shapes where a
// streaming read can go wrong.
//
// Covered here and not by the older differentials:
//   - a multi-byte character split across a read-chunk boundary, and a single
//     record longer than one chunk, including the locator read-back of a row
//     outside the retained window;
//   - bytes that are not valid UTF-8, where the decoded text a digest covers is
//     not the file's raw bytes (and the locator offsets are the decoded ones the
//     whole-file read computed);
//   - a file whose read fails part-way: the rows read before the failure must not
//     survive, because a single failed whole-file read never produced them.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { readBaselineSource } from './dockyard-domain/archive-index-baseline.js';
import { JsonStateStore } from './dockyard-domain/support.js';

const NOW = '2026-10-12T00:00:00.000Z';
const CHUNK = 1024 * 1024;
const WORKING_MEMORY = fileURLToPath(new URL('../lib/dockyard-domain/memory.js', import.meta.url));

/**
 * Import the frozen whole-file implementation, with its relative imports
 * rewritten onto this tree's siblings - the same construction the archive-index
 * differential uses, so both comparisons run against the same dependencies.
 */
async function baselineMemory() {
  const source = await readBaselineSource();
  assert.match(source, /raw\.split\("\\n"\)/, 'the frozen baseline must be the whole-file scan');
  const directory = await mkdtemp(join(tmpdir(), 'stream-scan-baseline-'));
  const modulePath = join(directory, 'memory.mjs');
  const dependencyBase = pathToFileURL(WORKING_MEMORY);
  await writeFile(modulePath, source.replace(/from (["'])(\.\.?\/[^"']+)\1/g,
    (_match, quote, specifier) => `from ${quote}${new URL(specifier, dependencyBase).href}${quote}`));
  const { EvolutionMemory } = await import(pathToFileURL(modulePath).href);
  await rm(directory, { recursive: true, force: true });
  return EvolutionMemory;
}

const BaselineMemory = await baselineMemory();
const { EvolutionMemory } = await import('../lib/dockyard-domain/memory.js');

const authority = { assertMutation() {}, isActive: () => true };
const json = (value) => JSON.stringify(value);
const line = (value) => json(value) + '\n';

function openMemory(Type, filePath, options = {}) {
  const memory = new Type({
    stateStore: new JsonStateStore({ filePath }), clock: () => new Date(NOW),
    mutationAuthority: authority, hotEntries: 8, hotCycles: 1, ...options,
  });
  memory.setMutationAuthority(authority);
  return memory;
}

async function home(t) {
  const root = await mkdtemp(join(tmpdir(), 'stream-scan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, 'state.json');
  await writeFile(filePath, json({ evolution: { schema: 4 } }));
  return { root, filePath };
}

/**
 * Write one collection as sealed segments plus an active tail, byte for byte.
 * `segments` are raw strings so a test can seed bytes that are not valid UTF-8.
 */
async function writeArchive(filePath, collection, { segments = [], active = '' }) {
  const path = `${filePath}.${collection}-archive.jsonl`;
  const directory = `${path}.segments`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files = [];
  for (const [index, bytes] of segments.entries()) {
    const file = join(directory, `segment-${String(index + 1).padStart(12, '0')}.jsonl`);
    await writeFile(file, bytes, { mode: 0o600 });
    files.push(file);
  }
  await writeFile(path, active, { mode: 0o600 });
  return { path, directory, files };
}

async function indexDocument(filePath) {
  const index = `${filePath}.evolution-archive-index.json`;
  try { return await readFile(index, 'utf8'); } catch { return null; }
}

/** Everything the scan decides, in a form two implementations can be compared by. */
async function view(memory, filePath, collection, limit = 50) {
  const observed = {
    history: memory.history(collection),
    window: memory.historyWindow(collection, limit),
    windowAll: memory.historyWindow(collection, limit, { metadataOnly: true }),
    snapshot: memory.fullSnapshot(),
    faults: memory.archiveIntegrity(),
    index: await indexDocument(filePath),
    activeKeys: [...(memory.archiveActiveKeys.get(collection) ?? new Set())].sort(),
  };
  // The cache representation itself is not comparable across the two
  // implementations; it is read after the calls above populated it.
  const cache = memory.archiveReadCache.get(collection) ?? null;
  return { observed, cache: cache && { format: cache.keys ? 'table' : 'records', entries: (cache.keys ?? cache.records).length, windowFrom: cache.windowFrom ?? null } };
}

async function scan(Type, filePath, options = {}) {
  const memory = openMemory(Type, filePath, options);
  await memory.load({ snapshot: false });
  return { memory, ...await view(memory, filePath, 'outcomes') };
}

test('a character split across a read-chunk boundary and a record longer than one chunk read as one line', async (t) => {
  const { filePath } = await home(t);
  const emoji = Buffer.from('\u{1F600}', 'utf8');
  const row = (prefix) => ({ id: 'boundary', summary: `${prefix}\u{1F600}\u{1F600}`, recordedAt: NOW });
  // Place the first emoji so that it starts two bytes before the first chunk ends:
  // a reader that decoded each chunk on its own would decode two replacements.
  let prefix = 'a'.repeat(CHUNK - 100);
  prefix = 'a'.repeat(prefix.length + (CHUNK - 2 - Buffer.from(json(row(prefix)), 'utf8').indexOf(emoji)));
  const first = row(prefix);
  const bytes = Buffer.from(json(first), 'utf8');
  const crossing = bytes.indexOf(emoji);
  assert.ok(crossing < CHUNK && crossing + emoji.length > CHUNK, `the character must straddle the chunk (${crossing})`);
  assert.ok(bytes.length > CHUNK, 'the first record must span the first chunk');
  // Three more fat rows put the first one outside the retained row window, so its
  // value can only come back through its locator.
  const rows = [first];
  for (const id of ['b', 'c', 'd']) rows.push({ id, summary: 'p'.repeat(1_500_000), recordedAt: NOW });
  await writeArchive(filePath, 'outcomes', { active: rows.map(line).join('') });

  const options = { archiveMaxBytes: 64 * 1024 * 1024 };
  const expected = await scan(BaselineMemory, filePath, options);
  const actual = await scan(EvolutionMemory, filePath, options);
  assert.deepEqual(actual.observed, expected.observed, 'the streamed scan answers what the whole-file scan answered');
  assert.equal(actual.observed.history[0].summary, `${prefix}\u{1F600}\u{1F600}`, 'the split character survives');
  assert.ok(actual.cache.windowFrom > 0, 'the first row is outside the retained window');
});

test('bytes that are not valid UTF-8 keep the decoded digest, byte size and locator offsets of the whole-file read', async (t) => {
  const { filePath } = await home(t);
  // A line that is not valid UTF-8 decodes with replacements, so its decoded byte
  // length is not its raw length; the whole-file read hashed, counted and
  // located those bytes through the decoded text, and so must the streamed read.
  const invalid = Buffer.concat([Buffer.from('{"id":"bad","label":"'), Buffer.from([0xe2, 0x82]), Buffer.from('"}\n')]);
  const unicode = Buffer.from(line({ id: 'unicode', label: '\u65e0 id \u{1F600} \u00e9', recordedAt: NOW }), 'utf8');
  const sealedBytes = Buffer.concat([invalid, unicode]);
  await writeArchive(filePath, 'outcomes', {
    segments: [sealedBytes],
    active: line({ id: 'active', label: '\u00fc', recordedAt: NOW }),
  });

  const expected = await scan(BaselineMemory, filePath);
  const actual = await scan(EvolutionMemory, filePath);
  assert.deepEqual(actual.observed, expected.observed, 'the decoded text, digest and faults are identical');
  const sealed = JSON.parse(actual.observed.index).segments.find((entry) => entry.sealed);
  assert.equal(sealed.sha256, crypto.createHash('sha256').update(sealedBytes.toString('utf8')).digest('hex'),
    'a sealed digest still covers the decoded text, exactly as a whole-file hash did');
  assert.equal(sealed.byteSize, Buffer.byteLength(sealedBytes.toString('utf8')));
  assert.equal(sealed.physicalCount, 2);
});

test('a file whose read fails part-way leaves no rows behind, exactly as a failed whole-file read', async (t) => {
  const { filePath } = await home(t);
  // Two sealed segments larger than one read chunk: the fault fires on the second
  // chunk of the first one, after a whole chunk of its rows was already parsed.
  const row = (index) => line({ id: `row-${index}`, summary: 'r'.repeat(300_000), recordedAt: NOW });
  const faulted = Array.from({ length: 5 }, (_, index) => row(index)).join('');
  const readable = line({ id: 'readable-0', recordedAt: NOW });
  const { files } = await writeArchive(filePath, 'outcomes', { segments: [faulted, readable] });
  assert.ok(Buffer.byteLength(faulted) > CHUNK, 'the faulted segment must span more than one read chunk');

  const plainReadFileSync = fs.readFileSync;
  const plainReadSync = fs.readSync;
  const plainOpenSync = fs.openSync;
  const plainCloseSync = fs.closeSync;
  const runFaulted = async (Type) => {
    // A successor instance whose load does not read the segments: the first load
    // records the index document for these bytes, and a sealed entry that still
    // matches the file's size is not read or re-hashed. The scan is the only
    // reader left, which is where the fault is injected.
    const primed = openMemory(Type, filePath);
    await primed.load({ snapshot: false });

    const fds = new Map();
    fs.openSync = (file, ...args) => {
      const fd = plainOpenSync(file, ...args);
      fds.set(fd, String(file));
      return fd;
    };
    fs.closeSync = (fd) => { fds.delete(fd); return plainCloseSync(fd); };
    fs.readFileSync = (file, ...args) => {
      if (String(file) === files[0]) throw Object.assign(new Error('injected read fault'), { code: 'EIO' });
      return plainReadFileSync(file, ...args);
    };
    let chunks = 0;
    fs.readSync = function (fd, ...args) {
      const target = args[0];
      if (fds.get(fd) === files[0] && target && target.length >= CHUNK) {
        chunks += 1;
        if (chunks > 1) throw Object.assign(new Error('injected read fault'), { code: 'EIO' });
      }
      return plainReadSync.call(this, fd, ...args);
    };
    syncBuiltinESMExports();
    try {
      const memory = openMemory(Type, filePath);
      await memory.load({ snapshot: false });
      return {
        history: memory.history('outcomes'),
        faults: memory.archiveIntegrity(),
        keys: memory.archiveReadCache.get('outcomes')?.keys ?? null,
      };
    } finally {
      fs.readFileSync = plainReadFileSync;
      fs.readSync = plainReadSync;
      fs.openSync = plainOpenSync;
      fs.closeSync = plainCloseSync;
      syncBuiltinESMExports();
    }
  };

  const expected = await runFaulted(BaselineMemory);
  const actual = await runFaulted(EvolutionMemory);
  assert.deepEqual(actual.history, expected.history, 'the rows read before the failure are not kept');
  assert.deepEqual(actual.faults, expected.faults, 'the fault describes the same file at the same path');
  assert.equal(actual.faults.outcomes.at(-1).kind, 'unreadable');
  assert.equal(actual.faults.outcomes.at(-1).code, 'EIO');
  // The readable segment still contributes its row: one failed file must not take
  // the readable files with it.
  assert.deepEqual(actual.history.map((row) => row.id).sort(), expected.history.map((row) => row.id).sort());
  assert.deepEqual(actual.history.map((row) => row.id), ['readable-0']);
});

test('a window row the scan trimmed is read back from its own bytes, including bytes that are not valid UTF-8', async (t) => {
  const { filePath } = await home(t);
  // 2049 tombstones fill the scan's retained ring and push the two visible rows
  // out of it, while the window still wants them - the window skips tombstones,
  // so it walks back past all of them. The first row holds a byte that is not
  // valid UTF-8, whose decoded length is longer than the bytes it was parsed
  // from; a locator built from the decoded length would read a different range.
  const rows = [
    Buffer.concat([Buffer.from('{"id":"bad","label":"'), Buffer.from([0x80]), Buffer.from('"}\n')]),
    Buffer.from(line({ id: 'good', label: 'fine', recordedAt: NOW })),
  ];
  for (let index = 0; index < 2049; index += 1) rows.push(Buffer.from(line({ id: `t-${index}`, __evolutionTombstone: 1 })));
  await writeArchive(filePath, 'outcomes', { active: Buffer.concat(rows) });

  const expected = await scan(BaselineMemory, filePath);
  const actual = await scan(EvolutionMemory, filePath);
  assert.deepEqual(actual.observed, expected.observed, 'the streamed scan answers what the whole-file scan answered');
  assert.deepEqual(actual.observed.window.entries.map((row) => row.id), ['bad', 'good'],
    'a trimmed window row is filled from its line instead of becoming a hole');
  assert.equal(actual.observed.window.entries[0].label, '\uFFFD', 'the invalid byte keeps its decoded text');
  assert.equal(actual.cache.windowFrom, 0, 'the window still reaches the first visible position');
  assert.equal(actual.cache.entries, 2051);
});
