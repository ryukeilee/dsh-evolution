/**
 * The process-local active-archive scan memo, on its own.
 *
 * `#reconcileActiveArchive()` reuses the read/parse/index work of an active
 * archive file whose exact bytes this process already scanned, so the memo is a
 * performance device that must never become a source of truth. This file drives
 * every shape where a stale answer would be observable - unchanged bytes
 * (reused), a file that grew under the running process (rescanned), and the same
 * path replaced by a new inode (rescanned) - and requires the indexed state to
 * be exactly the one a fresh scan computes.
 *
 * It deliberately does not import the pre-change baseline reconstruction that
 * `archive-index-equivalence.test.js` uses: a source-level fault injection into
 * the memo region would trip that reconstruction's shape guard before any
 * behavioral assertion ran, which would make a fault-injection run prove the
 * wrong thing. Nothing here needs a baseline; the requirements are absolute.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { EvolutionMemory } from "../../lib/dockyard-domain/memory.js";
import { JsonStateStore } from "./support.js";

const NOW = "2026-10-12T00:00:00.000Z";
const FIRST = "2026-10-10T00:00:00.000Z";
const LAST = "2026-10-11T00:00:00.000Z";
const RAW = [
  JSON.stringify({ id: "same", recordedAt: FIRST, state: "CANONICAL" }),
  JSON.stringify({ id: "same", observedAt: NOW, retention: "CONSOLIDATED" }),
  "{invalid}",
  "123",
  '"text"',
  "null",
  "true",
  JSON.stringify({ payload: "无 id" }),
  "[]",
  "   \t",
  JSON.stringify({ id: "last", endedAt: LAST, retention: "TOMBSTONE" }),
  '{"torn":',
  "",
].join("\n");
const EXPECTED_KEYS = new Set(["id:same", 'value:{"payload":"无 id"}', "value:[]", "id:last"]);

async function fixture(collection, raw) {
  const home = await mkdtemp(join(tmpdir(), "dsh-archive-memo-"));
  const store = new JsonStateStore({ home });
  const archive = `${store.filePath}.${collection}-archive.jsonl`;
  await mkdir(dirname(archive), { recursive: true });
  await writeFile(archive, raw);
  return { home, store, archive, index: `${store.filePath}.evolution-archive-index.json` };
}

async function newMemory(store, options = {}) {
  const memory = new EvolutionMemory({
    stateStore: store, clock: () => new Date(NOW), hotEntries: 1,
    archiveMaxBytes: 1024 * 1024, ...options,
  });
  memory.setMutationAuthority({ assertMutation() {}, isActive: () => true });
  await memory.load();
  return memory;
}

async function indexEntries(file) {
  const document = JSON.parse(await readFile(file, "utf8"));
  assert.equal(document.schemaVersion, 1);
  return document.segments;
}

/**
 * Count how often each active archive line is parsed by the archive-index scan
 * helpers while `run` executes, attributed by stack frame so the retention and
 * merge paths (which legitimately parse other lines) stay out of the count.
 */
const ARCHIVE_INDEX_PARSE = /#(?:scanArchiveRaw|indexEntryFromRaw|activeKeysFromRaw)\b/;
async function countArchiveLineParses(lines, run) {
  const original = JSON.parse;
  const counts = new Map(lines.map((line) => [line, 0]));
  JSON.parse = function (...args) {
    const source = args[0];
    if (typeof source === "string" && counts.has(source) && ARCHIVE_INDEX_PARSE.test(new Error().stack ?? "")) {
      counts.set(source, counts.get(source) + 1);
    }
    return Reflect.apply(original, this, args);
  };
  try { await run(); } finally { JSON.parse = original; }
  return counts;
}

const totalParses = (counts) => [...counts.values()].reduce((sum, count) => sum + count, 0);

test("the active-archive scan memo only answers for the bytes this process scanned", async () => {
  const files = await fixture("observations", RAW);
  try {
    const first = await newMemory(files.store);
    const scanned = await indexEntries(files.index);
    assert.deepEqual(first.archiveActiveKeys.get("observations"), EXPECTED_KEYS);
    const activeLines = RAW.split("\n").filter(Boolean);

    // Unchanged bytes: a second instance must reuse the scan instead of
    // re-parsing the file, and expose the same keys.
    const reusedParses = await countArchiveLineParses(activeLines, () => newMemory(new JsonStateStore({ home: files.home })));
    assert.equal(totalParses(reusedParses), 0, "unchanged bytes must not be rescanned");
    const reused = await newMemory(new JsonStateStore({ home: files.home }));
    assert.deepEqual(reused.archiveActiveKeys.get("observations"), EXPECTED_KEYS);
    assert.deepEqual(await indexEntries(files.index), scanned, "reusing a scan must not rewrite the index");

    // The memo must not share a key set with any instance, in either
    // direction: the instance that produced the recorded scan keeps appending
    // to its own set as it writes, and a reusing instance must not share it.
    first.archiveActiveKeys.get("observations").add("id:leaked");
    reused.archiveActiveKeys.get("observations").add("id:leaked-later");
    const isolated = await newMemory(new JsonStateStore({ home: files.home }));
    assert.equal(isolated.archiveActiveKeys.get("observations").has("id:leaked"), false,
      "the instance that produced the memo entry must not share its key set with the memo");
    assert.equal(isolated.archiveActiveKeys.get("observations").has("id:leaked-later"), false,
      "a reusing instance must not share its key set with the memo");
    assert.deepEqual(isolated.archiveActiveKeys.get("observations"), EXPECTED_KEYS);

    // The file grew while this process held the memo: the recovery surface an
    // append by another writer leaves behind must be scanned in full.
    const appended = JSON.stringify({ id: "appended", recordedAt: LAST });
    await appendFile(files.archive, appended + "\n");
    const grownParses = await countArchiveLineParses([...activeLines, appended],
      () => newMemory(new JsonStateStore({ home: files.home })));
    assert.equal(grownParses.get(appended), 1, "an appended line must be scanned, not served from the memo");
    assert.equal(totalParses(grownParses), activeLines.length + 1, "the grown file must be scanned in full");
    const grown = await indexEntries(files.index);
    assert.equal(grown[0].physicalCount, activeLines.length + 1);
    assert.equal(grown[0].logicalCount, 9);
    assert.equal(grown[0].byteSize, Buffer.byteLength(RAW) + Buffer.byteLength(appended) + 1);
    assert.equal(await readFile(files.archive, "utf8"), RAW + appended + "\n", "recovery keeps the appended bytes");

    // The same path replaced by a new inode with identical bytes: the recorded
    // file identity, not the path or the content alone, decides, so the
    // replacement is scanned again.
    await writeFile(`${files.archive}.replacement`, RAW + appended + "\n");
    await rename(`${files.archive}.replacement`, files.archive);
    const replacedParses = await countArchiveLineParses([...activeLines, appended],
      () => newMemory(new JsonStateStore({ home: files.home })));
    assert.equal(totalParses(replacedParses), activeLines.length + 1, "a replaced inode must be scanned in full");
    const replaced = await newMemory(new JsonStateStore({ home: files.home }));
    assert.equal(replaced.archiveActiveKeys.get("observations").has("id:appended"), true);
    assert.deepEqual(await indexEntries(files.index), grown, "identical bytes keep the identical index entry");
  } finally { await rm(files.home, { recursive: true, force: true }); }
});

test("the memo is keyed by the file identity, not by size and time alone", async () => {
  // Every component is individually observable when the timestamps are pinned
  // to whole seconds, which `utimes` reproduces exactly: a replacement file can
  // share the size and the mtime of the scanned file while being a different
  // inode, a rewrite can change the bytes without changing the size, and an
  // append can be hidden behind a restored mtime.
  const raw = JSON.stringify({ id: "a", recordedAt: NOW }) + "\n";
  const files = await fixture("observations", raw);
  const pinned = 1_000_000_000;
  const lines = raw.split("\n").filter(Boolean);
  try {
    await utimes(files.archive, pinned, pinned);
    const first = await newMemory(files.store);
    assert.equal(first.archiveActiveKeys.get("observations").has("id:a"), true);

    // Same size, same mtime, different inode: an inode-blind key would answer
    // with the old entry and never see the replacement's row.
    const replacementLine = JSON.stringify({ id: "b", recordedAt: NOW });
    const replacement = `${files.archive}.replacement`;
    await writeFile(replacement, replacementLine + "\n");
    await utimes(replacement, pinned, pinned);
    await rename(replacement, files.archive);
    const replacedParses = await countArchiveLineParses([...lines, replacementLine],
      () => newMemory(new JsonStateStore({ home: files.home })));
    assert.equal(replacedParses.get(replacementLine), 1, "a new inode with the same size and mtime must be scanned");
    const replaced = await newMemory(new JsonStateStore({ home: files.home }));
    assert.deepEqual([...replaced.archiveActiveKeys.get("observations")], ["id:b"]);

    // Same inode, same size, rewritten in place: only the mtime changes, and a
    // time-blind key would keep answering with the replaced row.
    const rewrittenLine = JSON.stringify({ id: "d", recordedAt: NOW });
    assert.equal(Buffer.byteLength(rewrittenLine), Buffer.byteLength(replacementLine), "the rewrite must keep the byte size");
    await writeFile(files.archive, rewrittenLine + "\n");
    const rewrittenParses = await countArchiveLineParses([replacementLine, rewrittenLine],
      () => newMemory(new JsonStateStore({ home: files.home })));
    assert.equal(rewrittenParses.get(rewrittenLine), 1, "an in-place rewrite with the same size must be scanned");
    const rewritten = await newMemory(new JsonStateStore({ home: files.home }));
    assert.deepEqual([...rewritten.archiveActiveKeys.get("observations")], ["id:d"]);

    // Same inode, same mtime, larger size: a size-blind key would answer with
    // the old entry and never see the appended row. The mtime is pinned before
    // the scan as well, so the memo's recorded stamp is (this size, this mtime)
    // and only the size can tell the grown file apart.
    await utimes(files.archive, pinned, pinned);
    await newMemory(new JsonStateStore({ home: files.home }));
    const appended = JSON.stringify({ id: "c", recordedAt: NOW });
    await appendFile(files.archive, appended + "\n");
    await utimes(files.archive, pinned, pinned);
    const grownParses = await countArchiveLineParses([rewrittenLine, appended], () => newMemory(new JsonStateStore({ home: files.home })));
    assert.equal(grownParses.get(appended), 1, "a grown file with a restored mtime must be scanned");
    assert.equal(grownParses.get(rewrittenLine), 1, "the scan must cover the whole grown file");
    const grown = await newMemory(new JsonStateStore({ home: files.home }));
    assert.deepEqual([...grown.archiveActiveKeys.get("observations")].sort(), ["id:c", "id:d"]);
  } finally { await rm(files.home, { recursive: true, force: true }); }
});

test("a memoized entry keeps the file name it was scanned under", async () => {
  // The entry names its own file, so two names for the same inode and
  // collection are two different entries even though they share every byte.
  const home = await mkdtemp(join(tmpdir(), "dsh-archive-memo-"));
  const firstStore = new JsonStateStore({ filePath: join(home, "a.json") });
  const secondStore = new JsonStateStore({ filePath: join(home, "b.json") });
  const firstArchive = `${firstStore.filePath}.observations-archive.jsonl`;
  const secondArchive = `${secondStore.filePath}.observations-archive.jsonl`;
  await mkdir(dirname(firstArchive), { recursive: true });
  await writeFile(firstArchive, JSON.stringify({ id: "a", recordedAt: NOW }) + "\n");
  const { linkSync } = await import("node:fs");
  linkSync(firstArchive, secondArchive);
  try {
    const first = await newMemory(firstStore);
    const second = await newMemory(secondStore);
    assert.equal(first.archiveIndexEntries.get(firstArchive).file, "a.json.observations-archive.jsonl");
    assert.equal(second.archiveIndexEntries.get(secondArchive).file, "b.json.observations-archive.jsonl",
      "an entry must keep the name it was scanned under");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("the memo hands out its own index entry, including an object-valued timestamp", async () => {
  // `recordedAt` is whatever the archive row carried, and it can be an object,
  // so the index entry can hold a nested value. The memo must not share that
  // entry (or the value inside it) with any instance: mutating it through one
  // instance would otherwise reach the next instance and the persisted index.
  const raw = JSON.stringify({ id: "a", recordedAt: { label: "original" } }) + "\n";
  const files = await fixture("observations", raw);
  try {
    const first = await newMemory(files.store);
    const entry = first.archiveIndexEntries.get(files.archive);
    assert.deepEqual(entry.firstTimestamp, { label: "original" });
    entry.physicalCount = 999;
    entry.firstTimestamp.label = "mutated";

    const second = await newMemory(new JsonStateStore({ home: files.home }));
    const reused = second.archiveIndexEntries.get(files.archive);
    assert.equal(reused.physicalCount, 1, "an instance must not share its index entry with the memo");
    assert.deepEqual(reused.firstTimestamp, { label: "original" },
      "an instance must not share the entry's nested timestamp value with the memo");
    const [persisted] = await indexEntries(files.index);
    assert.equal(persisted.physicalCount, 1, "the persisted index must describe the scanned bytes");
    assert.deepEqual(persisted.firstTimestamp, { label: "original" });

    // The hit side must be detached as well: mutating the entry a reusing
    // instance received must not reach the next one.
    reused.physicalCount = 777;
    reused.firstTimestamp.label = "mutated-again";
    const third = await newMemory(new JsonStateStore({ home: files.home }));
    const again = third.archiveIndexEntries.get(files.archive);
    assert.equal(again.physicalCount, 1, "a reusing instance must not share its index entry with the memo");
    assert.deepEqual(again.firstTimestamp, { label: "original" },
      "a reusing instance must not share the entry's nested value with the memo");
  } finally { await rm(files.home, { recursive: true, force: true }); }
});

test("a memoized entry names its own collection, not the file identity alone", async () => {
  // Two collections' active archives are the same inode only if something
  // outside this plugin hard-linked them; the memo answers by file identity, so
  // the collection has to be part of the key or the entry's `segmentId`,
  // `recordType` and `file` would describe the wrong collection on disk.
  const home = await mkdtemp(join(tmpdir(), "dsh-archive-memo-"));
  const store = new JsonStateStore({ home });
  const observations = `${store.filePath}.observations-archive.jsonl`;
  const knowledge = `${store.filePath}.knowledge-archive.jsonl`;
  await mkdir(dirname(observations), { recursive: true });
  await writeFile(observations, JSON.stringify({ id: "shared", recordedAt: NOW }) + "\n");
  const { linkSync } = await import("node:fs");
  linkSync(observations, knowledge);
  try {
    const memory = await newMemory(store);
    const active = (collection) => memory.archiveIndexEntries.get(`${store.filePath}.${collection}-archive.jsonl`);
    assert.equal(active("observations").segmentId, "active:observations");
    assert.equal(active("observations").collection, "observations");
    assert.equal(active("knowledge").segmentId, "active:knowledge");
    assert.equal(active("knowledge").collection, "knowledge");
    assert.equal(active("knowledge").file, knowledge.split("/").at(-1));
    const [persistedObservations, persistedKnowledge] = await indexEntries(`${store.filePath}.evolution-archive-index.json`);
    assert.equal(persistedObservations.collection, "observations");
    assert.equal(persistedKnowledge.collection, "knowledge");
  } finally { await rm(home, { recursive: true, force: true }); }
});
