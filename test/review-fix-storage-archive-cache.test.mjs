/**
 * The cold-archive read cache may only carry appended lines forward under an
 * identity it proved *before* the append.
 *
 * `#extendArchiveReadCache` used to be handed the active file only after
 * `appendFile` returned, and accepted the append into the cached parse whenever
 * the post-append size was exactly the cached size plus the bytes appended. A
 * same-length in-place rewrite by another writer leaves the size alone, so the
 * grow-by-exactly check could not see it: the cached parse kept answering the
 * old value, and the new modification time of the *appended* file was recorded
 * as the identity of those old bytes. `compact()` then rewrote the archive from
 * that parse, so the stale value did not merely stay in the projection - it was
 * written back over the external writer's data.
 *
 * The first case is that exact sequence and was reproduced against the unfixed
 * implementation: `history()` reported `OLD` for a file holding `NEW`, and the
 * value on disk after `compact()` was `OLD` again. The second case is the
 * control: an append this instance performs with no outside writer still has to
 * be carried into the cached parse, so the fix may not be "drop the cache".
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const fs = require("node:fs");
const fsp = require("node:fs/promises");

// ------------------------------------------------------------------ accounting
// Archive bytes are counted instead of timed. The patch is installed before the
// module under test is instantiated, so the bytes counted are the bytes this
// code asked the filesystem for.
const reads = { calls: 0, bytes: 0 };
const plainReadFileSync = fs.readFileSync;
const plainWriteFile = fsp.writeFile;
const plainRm = fsp.rm;
fs.readFileSync = function accounted(...args) {
  const result = plainReadFileSync.apply(this, args);
  if (String(args[0]).includes("-archive.jsonl")) {
    reads.calls += 1;
    reads.bytes += typeof result === "string" ? Buffer.byteLength(result) : (result?.byteLength ?? 0);
  }
  return result;
};
const resetReads = () => { reads.calls = 0; reads.bytes = 0; };

const { EvolutionMemory } = await import("../lib/dockyard-domain/memory.js");

// ------------------------------------------------------------------- harness
const NOW = "2026-01-01T00:00:00.000Z";

/** File-backed store: a second instance reads the same durable aggregate. */
function fileStore(filePath) {
  const read = async () => JSON.parse(await fsp.readFile(filePath, "utf8"));
  const write = async (state) => { await plainWriteFile(filePath, JSON.stringify(state), { mode: 0o600 }); };
  return { filePath, load: read, save: write, update: async (updater) => { await write(updater(await read())); } };
}

async function scratch(t) {
  const directory = await fsp.mkdtemp(join(tmpdir(), "review-fix-archive-cache-"));
  t.after(() => plainRm(directory, { recursive: true, force: true }));
  return directory;
}

async function fixture(t, overrides = {}) {
  const directory = await scratch(t);
  const filePath = join(directory, "state.json");
  await plainWriteFile(filePath, JSON.stringify({ evolution: { schema: 4, journal: [] } }), { mode: 0o600 });
  const open = () => new EvolutionMemory({
    stateStore: fileStore(filePath), clock: () => new Date(NOW),
    mutationAuthority: { assertMutation() {} }, ...overrides,
  });
  return { directory, filePath, archive: `${filePath}.journal-archive.jsonl`, open };
}

const coldNote = (memory) => memory.history("journal").find((entry) => entry.id === "cold")?.note;

// ------------------------------------------------- regression: stale carry-over
test("R4: a same-length external rewrite is not carried into the cache by the next append", async (t) => {
  const f = await fixture(t, { hotEntries: 1, maxEntries: 100 });
  const memory = f.open();
  await memory.load({ snapshot: false });
  await plainWriteFile(f.archive, '{"id":"cold","note":"OLD"}\n', { mode: 0o600 });
  memory.history("journal"); // warm the cached parse
  await memory.recordJournal({ id: "hot1" });

  // Same byte length, one different value: only the modification time moves, so
  // a size-only grow check cannot observe it.
  await plainWriteFile(f.archive, '{"id":"cold","note":"NEW"}\n', { mode: 0o600 });
  await memory.recordJournal({ id: "hot2" });

  assert.equal(coldNote(memory), "NEW",
    "the read after an append must not answer with a value the file no longer holds");

  await memory.compact();
  const reopened = f.open();
  await reopened.load({ snapshot: false });
  assert.equal(coldNote(reopened), "NEW",
    "compaction must not write the pre-append value back over the external writer's data");
});

// --------------------------------------------------- control: the cache still pays
test("R4 control: an append this instance performs is still carried without a rescan", async (t) => {
  const f = await fixture(t, { hotEntries: 2, maxEntries: 100 });
  const lines = Array.from({ length: 12 }, (_, index) => JSON.stringify({ id: `cold-${index}`, note: `value-${index}` }));
  await plainWriteFile(f.archive, lines.join("\n") + "\n", { mode: 0o600 });
  const memory = f.open();
  await memory.load({ snapshot: false });

  // The first eviction has to learn what the archive holds; nothing may be
  // assumed about bytes this process has not read. This also proves the
  // accounting above is live rather than silently counting nothing. The hot
  // window holds two records, so the third append is what evicts.
  resetReads();
  for (let index = 1; index < 4; index += 1) await memory.recordJournal({ id: `hot-${index}` });
  assert.ok(reads.bytes > 0, "the first eviction reads the cold tier");

  const before = (await fsp.stat(f.archive)).size;
  resetReads();
  for (let index = 4; index < 10; index += 1) await memory.recordJournal({ id: `hot-${index}` });
  assert.ok((await fsp.stat(f.archive)).size > before, "the appends in the loop reached the active archive file");
  assert.equal(reads.calls, 0, "appends this instance performed re-read archived bytes");

  const reopened = f.open();
  await reopened.load({ snapshot: false });
  assert.deepEqual(memory.history("journal"), reopened.history("journal"),
    "the cached parse still equals what a fresh instance reads from the same file");
});
