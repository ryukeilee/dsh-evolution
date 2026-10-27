/**
 * Cold-archive read cost, and the two integrity boundaries this round measured
 * instead of changing.
 *
 * `EvolutionMemory` learns what a cold archive holds by reading it, and a
 * knowledge-bearing append asks about the source collection and the knowledge
 * accumulator on every mutation, so the same unchanged bytes were read and
 * parsed once per append (P2-13). The first cases below pin the property that
 * replaced that: a repeated read of unchanged files is answered from the parse
 * this process already holds, an append it performed itself carries its own
 * lines forward, and every other change to those files - an append from outside,
 * an in-place rewrite, a torn tail, a rotation, a compaction - is observed
 * exactly as a fresh read would observe it. The last cases pin the two
 * boundaries this round did not change: a sealed segment is validated by size
 * (not by re-hashing its bytes) when `load()` rebuilds the index, and the
 * runtime index document is already persisted by each append rather than only
 * by that rebuild.
 *
 * Read volume is measured, not timed: `readFile`/`readFileSync` and the byte-level
 * `openSync`/`readSync` pair are patched on the CommonJS exports of node:fs /
 * node:fs/promises before the module that imports them is instantiated, so the
 * bytes counted are the bytes this code actually asked the filesystem for. Both
 * forms are counted because the cold-archive scan reads bytes rather than whole
 * files. Nothing here asserts a duration.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const fs = require("node:fs");
const fsp = require("node:fs/promises");

// ---------------------------------------------------------------- accounting
const reads = { calls: 0, bytes: 0, files: [] };
const plainReadFileSync = fs.readFileSync;
const plainReadFile = fsp.readFile;
const plainOpenSync = fs.openSync;
const plainCloseSync = fs.closeSync;
const plainReadSync = fs.readSync;
const plainWriteFile = fsp.writeFile;
const plainMkdir = fsp.mkdir;
const plainRm = fsp.rm;
const plainStat = fsp.stat;
const plainReaddir = fsp.readdir;
const plainAppendFile = fsp.appendFile;
const account = (result, path) => {
  // Both an archive file and a sealed segment directory carry the archive name,
  // so the whole path decides whether this read is cold-archive traffic.
  if (String(path).includes("-archive.jsonl")) {
    reads.calls += 1;
    reads.bytes += typeof result === "string" ? Buffer.byteLength(result) : (result?.byteLength ?? 0);
    reads.files.push(String(path).split("/").at(-1));
  }
  return result;
};
fs.readFileSync = function accounted(...args) { return account(plainReadFileSync.apply(this, args), args[0]); };
fsp.readFile = async function accounted(...args) { return account(await plainReadFile.apply(this, args), args[0]); };
// A byte-level read counts the bytes it returned, for the files this process
// opened through the patched entry point.
const openArchives = new Map();
fs.openSync = function accounted(...args) {
  const fd = plainOpenSync.apply(this, args);
  if (String(args[0]).includes("-archive.jsonl")) openArchives.set(fd, String(args[0]));
  return fd;
};
fs.closeSync = function accounted(fd) { openArchives.delete(fd); return plainCloseSync.call(this, fd); };
fs.readSync = function accounted(fd, ...args) {
  const read = plainReadSync.call(this, fd, ...args);
  const path = openArchives.get(fd);
  if (path !== undefined && read > 0) { reads.calls += 1; reads.bytes += read; reads.files.push(path.split("/").at(-1)); }
  return read;
};
const resetReads = () => { reads.calls = 0; reads.bytes = 0; reads.files = []; };

const { EvolutionMemory } = await import("../lib/dockyard-domain/memory.js");

// ------------------------------------------------------------------ harness
const NOW = "2026-01-01T00:00:00.000Z";
const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliett", "kilo", "lima"];

/** File-backed store; every instance sees the aggregate the file holds. */
function fileStore(filePath) {
  return {
    filePath,
    load: async () => { try { return JSON.parse(await plainReadFile(filePath, "utf8")); } catch { return {}; } },
    save: async (state) => { await plainWriteFile(filePath, JSON.stringify(state), { mode: 0o600 }); },
    update: async (updater) => { await plainWriteFile(filePath, JSON.stringify(updater(await (async () => { try { return JSON.parse(await plainReadFile(filePath, "utf8")); } catch { return {}; } })())), { mode: 0o600 }); },
  };
}

async function scratch(t) {
  const directory = await fsp.mkdtemp(join(tmpdir(), "memory-perf-"));
  t.after(() => plainRm(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * A knowledge-bearing observation: a distinct message is a distinct knowledge
 * key, so appends neither fold into one accumulator row nor count as replays.
 */
function observation(index) {
  return {
    id: `cold-${index}`, type: "tool/error", componentId: `component-${index % 3}`,
    message: `failure-word-${WORDS[index % WORDS.length]}`, severity: "error", recordedAt: NOW,
  };
}

/** Write one collection as `sealedCount` records across two segments plus an active tail. */
async function writeArchive(filePath, collection, records, { segments = 2 } = {}) {
  const path = `${filePath}.${collection}-archive.jsonl`;
  const directory = `${path}.segments`;
  await plainMkdir(directory, { recursive: true, mode: 0o700 });
  const lines = records.map((record) => JSON.stringify(record));
  const sealed = lines.slice(0, Math.max(0, lines.length - 1));
  const active = lines.slice(Math.max(0, lines.length - 1));
  const perSegment = Math.ceil(sealed.length / segments) || 1;
  let index = 1;
  for (let offset = 0; offset < sealed.length; offset += perSegment) {
    await plainWriteFile(join(directory, `segment-${String(index).padStart(12, "0")}.jsonl`), sealed.slice(offset, offset + perSegment).join("\n") + "\n", { mode: 0o600 });
    index += 1;
  }
  await plainWriteFile(path, active.length ? active.join("\n") + "\n" : "", { mode: 0o600 });
  return { path, directory };
}

async function coldFixture(t, { cold = 12, knowledge = 6 } = {}) {
  const directory = await scratch(t);
  const filePath = join(directory, "state.json");
  const layout = {
    observations: await writeArchive(filePath, "observations", Array.from({ length: cold }, (_, index) => observation(index))),
    knowledge: await writeArchive(filePath, "knowledge", Array.from({ length: knowledge }, (_, index) => ({
      id: `knowledge-${index}`, knowledgeKey: `knowledge-${index}`, lastStatus: "error",
      occurrenceCount: 1, confidence: 0.5, sourceRefs: [`observations:cold-${index}`], recordedAt: NOW,
    }))),
  };
  await plainWriteFile(filePath, JSON.stringify({ evolution: { schema: 4, observations: [], knowledge: [], coldArchives: {} } }), { mode: 0o600 });
  return { directory, filePath, layout };
}

function openMemory(fixture, overrides = {}) {
  return new EvolutionMemory({
    stateStore: fileStore(fixture.filePath), clock: () => new Date(NOW),
    mutationAuthority: { assertMutation() {} }, ...overrides,
  });
}

/** The archived+hot view of one collection, as the public reader returns it. */
const view = (memory, collection) => JSON.stringify(memory.history(collection));

/** Cold archive bytes currently on disk, which is what one full uncached read costs. */
async function coldBytes(fixture) {
  let bytes = 0;
  for (const { path, directory } of Object.values(fixture.layout)) {
    bytes += (await plainStat(path)).size;
    for (const name of await plainReaddir(directory)) bytes += (await plainStat(join(directory, name))).size;
  }
  return bytes;
}

// ------------------------------------------------------- repeated reads (P2-13)
test("a repeated append does not re-read archive bytes this process already parsed", async (t) => {
  const fixture = await coldFixture(t);
  const memory = openMemory(fixture, { hotEntries: 4, maxEntries: 100 });
  await memory.load({ snapshot: false });
  const cold = await coldBytes(fixture);

  // The first append has to learn what the archive holds: it reads the cold tier
  // once, which no cache can avoid without trusting bytes it has not seen.
  resetReads();
  await memory.recordObservation(observation(20));
  const first = { ...reads };
  assert.ok(first.bytes >= cold * 0.9, `the first append reads the cold tier (${first.bytes} vs ${cold})`);

  // Every later append reads what it changed, not the history behind it. Four
  // further appends overflow the hot window of four, so they also append to the
  // active archive file: those appends are carried into the cached parse.
  resetReads();
  for (let index = 21; index < 25; index += 1) await memory.recordObservation(observation(index));
  assert.ok(reads.bytes < cold * 0.1, `four further appends read no cold history (${reads.bytes} bytes, cold tier ${cold})`);
});

test("an append this instance performed is carried without a rescan", async (t) => {
  const fixture = await coldFixture(t);
  const memory = openMemory(fixture, { hotEntries: 2, maxEntries: 100 });
  await memory.load({ snapshot: false });
  // The first append reads the cold tier once.
  resetReads();
  await memory.recordObservation(observation(30));
  assert.ok(reads.calls > 0);
  // With a hot window of two, every append after the second evicts one record
  // into the active archive file, so the parse has to accept repeated appends.
  resetReads();
  for (let index = 31; index < 37; index += 1) await memory.recordObservation(observation(index));
  assert.equal(reads.bytes, 0, `eviction appends re-read archived bytes: ${reads.files.join(",")}`);
  const fresh = openMemory(fixture, { hotEntries: 2, maxEntries: 100 });
  await fresh.load({ snapshot: false });
  assert.equal(view(memory, "observations"), view(fresh, "observations"), "the cached view equals the file");
});

// --------------------------------------------------- invalidation outside the cache
test("an append from outside this instance is observed by the next read", async (t) => {
  const fixture = await coldFixture(t);
  const memory = openMemory(fixture);
  await memory.load({ snapshot: false });
  assert.equal(JSON.parse(view(memory, "observations")).length, 12);
  // Grow the active file behind the instance's back: only its size changes.
  await plainAppendFile(fixture.layout.observations.path, JSON.stringify(observation(40)) + "\n");
  const fresh = openMemory(fixture);
  await fresh.load({ snapshot: false });
  assert.equal(JSON.parse(view(memory, "observations")).length, 13);
  assert.equal(view(memory, "observations"), view(fresh, "observations"));
});

test("an in-place rewrite of the same length is observed by the next read", async (t) => {
  const fixture = await coldFixture(t);
  const memory = openMemory(fixture);
  await memory.load({ snapshot: false });
  view(memory, "observations"); // warm the cached parse
  const path = fixture.layout.observations.path;
  const raw = await plainReadFile(path, "utf8");
  const before = await plainStat(path, { bigint: true });
  // Same byte length, one different field: only the modification time moves.
  const rewritten = raw.replace('"severity":"error"', '"severity":"fatal"');
  assert.notEqual(rewritten, raw);
  assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(raw));
  await plainWriteFile(path, rewritten, { mode: 0o600 });
  const after = await plainStat(path, { bigint: true });
  if (before.mtimeNs === after.mtimeNs) {
    t.diagnostic("filesystem mtime did not move; the size-based half of the identity cannot be tested here");
    return;
  }
  const fresh = openMemory(fixture);
  await fresh.load({ snapshot: false });
  assert.equal(view(memory, "observations"), view(fresh, "observations"));
});

test("a torn tail is reported through the cached read as a plain scan reports it", async (t) => {
  const fixture = await coldFixture(t);
  const memory = openMemory(fixture);
  await memory.load({ snapshot: false });
  view(memory, "observations"); // warm the cached parse
  await plainAppendFile(fixture.layout.observations.path, '{"id":"torn-99","recordedAt":"2026-01-01T00:00:09.000Z","payl');
  // Two reads of the same torn bytes: the fault has to survive the second one.
  assert.equal(JSON.parse(view(memory, "observations")).length, 12);
  assert.equal(JSON.parse(view(memory, "observations")).length, 12);
  const faults = memory.archiveIntegrity().observations ?? [];
  assert.deepEqual(faults.map((fault) => fault.kind), ["torn-tail"]);
  const fresh = openMemory(fixture);
  await fresh.load({ snapshot: false });
  assert.equal(view(memory, "observations"), view(fresh, "observations"));
});

test("rotation and compaction leave the cached view equal to the file", async (t) => {
  const fixture = await coldFixture(t);
  // A tiny active-file target makes every eviction seal the active file.
  const memory = openMemory(fixture, { hotEntries: 2, maxEntries: 20, archiveMaxBytes: 512, absoluteMaxSegmentBytes: 4096 });
  await memory.load({ snapshot: false });
  for (let index = 50; index < 56; index += 1) await memory.recordObservation(observation(index));
  const rotated = openMemory(fixture, { hotEntries: 2, maxEntries: 20, archiveMaxBytes: 512, absoluteMaxSegmentBytes: 4096 });
  await rotated.load({ snapshot: false });
  assert.equal(view(memory, "observations"), view(rotated, "observations"), "sealing keeps the cached view true");
  assert.ok((await plainReaddir(fixture.layout.observations.directory)).length >= 2, "rotation produced a second segment");
  await memory.compact();
  const compacted = openMemory(fixture, { hotEntries: 2, maxEntries: 20, archiveMaxBytes: 512, absoluteMaxSegmentBytes: 4096 });
  await compacted.load({ snapshot: false });
  assert.equal(view(memory, "observations"), view(compacted, "observations"), "compaction keeps the cached view true");
  assert.equal(view(memory, "knowledge"), view(compacted, "knowledge"));
});

// ------------------------------------------- sealed-tier boundary (P3-3)
test("load() accepts a same-size sealed segment; verifyConsistency() reports it", async (t) => {
  const fixture = await coldFixture(t);
  // First load writes the index document that records each sealed segment's size
  // and digest.
  const primed = openMemory(fixture);
  await primed.load({ snapshot: false });
  const segment = join(fixture.layout.observations.directory, (await plainReaddir(fixture.layout.observations.directory)).sort()[0]);
  const original = await plainReadFile(segment, "utf8");
  const tampered = original.replace("failure-word-alpha", "failure-word-omega");
  assert.equal(Buffer.byteLength(tampered), Buffer.byteLength(original), "the tampered segment keeps every byte count");
  await plainWriteFile(segment, tampered, { mode: 0o600 });

  // load() compares the recorded size, which still matches, so it reuses the
  // indexed sealed segment instead of reading it.
  resetReads();
  const loaded = openMemory(fixture);
  await loaded.load({ snapshot: false });
  assert.equal(reads.files.filter((name) => name.startsWith("segment-")).length, 0, "load() does not read the sealed tier");
  assert.deepEqual(loaded.archiveIntegrity(), {}, "load() reports no fault for a same-size change");

  // verifyConsistency() re-reads and re-hashes the sealed tier, which is where a
  // same-size change becomes visible.
  const report = await loaded.verifyConsistency();
  assert.equal(report.valid, false);
  assert.ok(report.reasons.includes("archive_index_inconsistent"), `reasons: ${report.reasons.join(",")}`);
  assert.deepEqual(report.archive.mismatched.map((entry) => entry.reason), ["checksum"]);
});

// ------------------------------------------- index persistence (P3-5)
test("an append persists the index document, and load() reads only the active files", async (t) => {
  const fixture = await coldFixture(t);
  const memory = openMemory(fixture, { hotEntries: 2, maxEntries: 20 });
  await memory.load({ snapshot: false });
  const indexFile = `${fixture.filePath}.evolution-archive-index.json`;
  const before = JSON.parse(await plainReadFile(indexFile, "utf8"));
  const beforeActive = before.segments.find((entry) => entry.collection === "observations" && !entry.sealed);
  // An eviction appends to the active file, so the index document has to be
  // rewritten by the append itself: nothing else reconciles it.
  for (let index = 60; index < 64; index += 1) await memory.recordObservation(observation(index));
  const after = JSON.parse(await plainReadFile(indexFile, "utf8"));
  const afterActive = after.segments.find((entry) => entry.collection === "observations" && !entry.sealed);
  const active = await plainStat(fixture.layout.observations.path);
  assert.ok(afterActive.physicalCount > beforeActive.physicalCount, "the appended lines are in the index");
  assert.equal(Number(afterActive.byteSize), active.size, "the indexed active size is the file's size");

  // A restart therefore needs the active files only; every sealed segment is
  // covered by an entry whose size still matches.
  resetReads();
  const restarted = openMemory(fixture, { hotEntries: 2, maxEntries: 20 });
  await restarted.load({ snapshot: false });
  assert.ok(reads.files.every((name) => !name.startsWith("segment-")), `sealed segments read at load: ${reads.files.join(",")}`);
});

test("a missing index falls back to a full scan instead of trusting nothing", async (t) => {
  const fixture = await coldFixture(t);
  const primed = openMemory(fixture);
  await primed.load({ snapshot: false });
  await plainRm(`${fixture.filePath}.evolution-archive-index.json`, { force: true });
  let sealedBytes = 0;
  for (const { directory } of Object.values(fixture.layout)) {
    for (const name of await plainReaddir(directory)) sealedBytes += (await plainStat(join(directory, name))).size;
  }
  resetReads();
  const restarted = openMemory(fixture);
  await restarted.load({ snapshot: false });
  assert.ok(reads.bytes >= sealedBytes * 0.9, `a missing index re-reads every sealed segment (${reads.bytes} vs ${sealedBytes})`);
  assert.equal(view(restarted, "observations"), view(primed, "observations"));
});
