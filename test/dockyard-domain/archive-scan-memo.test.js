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
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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
