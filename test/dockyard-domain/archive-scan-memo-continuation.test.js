/**
 * The committed-load continuation of the active-archive scan memo.
 *
 * A staged domain transaction reads the active file through a hard-linked
 * mirror, appends to a private copy, and installs that same inode into the live
 * tree. The committed load then sees a file whose identity changed (private
 * inode, larger size), so the plain memo is a miss and re-parses every record.
 * This round continues the exact scan facts across that append and publishes
 * them only after the install preserved the identity the append produced.
 *
 * These tests are deliberately a separate file: the persisted-index
 * differential in `archive-index-equivalence.test.js` imports a reconstruction
 * whose shape guards run before any behavioural assertion, so an injected fault
 * there would prove only that the guards work.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { EvolutionMemory } from "../../lib/dockyard-domain/memory.js";
import { openDomainStorage } from "../../lib/domain-storage.js";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { JsonStorageBackend } from "@deepseek-ai/dsh-storage-json";
import { JsonStateStore } from "./support.js";

const NOW = "2026-10-12T00:00:00.000Z";
const LAST = "2026-10-11T00:00:00.000Z";
const INDEX_SUFFIX = ".evolution-archive-index.json";

async function fixture(collection, raw, { hot = [], options = {} } = {}) {
  const home = await mkdtemp(join(tmpdir(), "dsh-scan-continuation-"));
  const store = new JsonStateStore({ home });
  const archive = `${store.filePath}.${collection}-archive.jsonl`;
  await mkdir(dirname(archive), { recursive: true });
  await writeFile(archive, raw);
  await mkdir(dirname(store.filePath), { recursive: true });
  await writeFile(store.filePath, JSON.stringify({ evolution: { schema: 4, [collection]: hot, coldArchives: {} } }));
  return { home, store, archive, filePath: store.filePath, options };
}

async function open(store, options = {}) {
  const memory = new EvolutionMemory({
    stateStore: store, clock: () => new Date(NOW), maxEntries: 100, hotEntries: 1, ...options,
  });
  memory.setMutationAuthority({ assertMutation() {} });
  await memory.load({ snapshot: false });
  return memory;
}

function comparable(entry) {
  const { updatedAt, ...rest } = entry;
  return JSON.parse(JSON.stringify(rest));
}

/** Open the same bytes under a fresh inode so the process-local memo cannot hit. */
async function freshCopy(home, collection) {
  const copy = await mkdtemp(join(tmpdir(), "dsh-scan-continuation-fresh-"));
  await cp(home, copy, { recursive: true });
  const store = new JsonStateStore({ home: copy });
  const memory = await open(store);
  return { copy, memory, archive: `${store.filePath}.${collection}-archive.jsonl`, filePath: store.filePath };
}

async function cleanup(...homes) {
  for (const home of homes) await rm(home, { recursive: true, force: true });
}

async function indexSegments(filePath) {
  try {
    const document = JSON.parse(await readFile(`${filePath}${INDEX_SUFFIX}`, "utf8"));
    return document.segments.map((entry) => {
      const { updatedAt, ...rest } = entry;
      return rest;
    });
  } catch { return null; }
}

const ACTIVE_PARSE_FRAME = /#(?:foldArchiveFacts|archiveFactsFromFile|archiveFactsFromText|indexEntryFromFacts)\b/;
/** Count parses of the given active lines whose stack is the index-fact scan. */
async function countActiveParses(lines, run) {
  const original = JSON.parse;
  const counts = new Map(lines.map((line) => [line, 0]));
  JSON.parse = function counted(source, ...rest) {
    if (typeof source === "string" && counts.has(source) && ACTIVE_PARSE_FRAME.test(new Error().stack ?? "")) {
      counts.set(source, counts.get(source) + 1);
    }
    return Reflect.apply(original, this, [source, ...rest]);
  };
  try { return { result: await run(), parses: [...counts.values()].reduce((sum, count) => sum + count, 0) }; }
  finally { JSON.parse = original; }
}

const observations = (...rows) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

const scenarios = [
  { name: "an empty active file followed by its first append", raw: "", hot: [{ id: "hot-1", recordedAt: NOW }] },
  { name: "primitive, invalid and whitespace-only base lines", raw: ["123", "{invalid}", "   \t", JSON.stringify({ id: "base", recordedAt: NOW })].join("\n") + "\n", hot: [{ id: "hot-1", recordedAt: NOW }] },
  { name: "a first record without a timestamp stays null", raw: observations({ id: "first" }), hot: [{ id: "hot-1", recordedAt: NOW }] },
  { name: "invalid-only base lines make the append the first parsed record", raw: "{invalid}\n   \t\n", hot: [{ id: "hot-1", recordedAt: NOW }] },
  { name: "the last timestamp is read from endedAt", raw: observations({ id: "first", recordedAt: NOW }), hot: [{ id: "hot-1", endedAt: LAST }] },
  { name: "a startedAt-only last record does not become the last timestamp", raw: observations({ id: "first", recordedAt: NOW }), hot: [{ id: "hot-1", startedAt: LAST }] },
  { name: "an oversized record updates the compacted facts", raw: observations({ id: "first", recordedAt: NOW }), hot: [{ id: "hot-1", recordedAt: NOW, summary: "x".repeat(5000) }], options: { absoluteMaxSegmentBytes: 2048 } },
  { name: "a tombstone row updates the loser facts", raw: observations({ id: "first", recordedAt: NOW }), hot: [{ id: "hot-1", recordedAt: NOW, retention: "TOMBSTONE" }] },
  { name: "a canonical row updates the winner count", raw: observations({ id: "first", recordedAt: NOW }), hot: [{ id: "hot-1", recordedAt: NOW, state: "CANONICAL" }] },
  { name: "a complete unterminated tail counts the separator it gains", raw: JSON.stringify({ id: "first", recordedAt: NOW }), hot: [{ id: "hot-1", recordedAt: NOW }] },
];

for (const scenario of scenarios) {
  test(`an append continues the scan facts exactly: ${scenario.name}`, async () => {
    const files = await fixture("observations", scenario.raw, { hot: scenario.hot, options: scenario.options });
    const memory = await open(files.store, { archiveWriteGuard: async () => {}, ...scenario.options });
    await memory.recordObservation({ id: "new-1", recordedAt: NOW, forceRecord: true });
    const current = memory.archiveIndexEntries.get(files.archive);
    assert.ok(current, "the append must have written the active archive");
    const fresh = await freshCopy(files.home, "observations");
    try {
      const expected = fresh.memory.archiveIndexEntries.get(fresh.archive);
      assert.ok(expected, "the fresh copy must have an active entry");
      assert.deepEqual(comparable(current), comparable(expected),
        "the continued entry must equal what a fresh scan of the final bytes builds");
      assert.deepEqual(await indexSegments(files.filePath), await indexSegments(fresh.filePath),
        "the persisted index document must describe the final bytes");
    } finally { await cleanup(files.home, fresh.copy); }
  });
}

test("a committed seed lets the next load reuse the entry without parsing the active file", async () => {
  const raw = observations({ id: "base", recordedAt: NOW });
  const files = await fixture("observations", raw, { hot: [{ id: "hot-1", recordedAt: NOW }] });
  // The staged working copy records a seed on a successful append; the port
  // publishes it only after the install. Here the file is the live file (no
  // mirror), so publishing is the same identity check the commit performs.
  const staged = await open(files.store, { archiveWriteGuard: async () => {} });
  await staged.recordObservation({ id: "new-1", recordedAt: NOW, forceRecord: true });
  assert.equal(staged.publishArchiveScanSeeds(files.filePath), true);
  const lines = (await readFile(files.archive, "utf8")).split("\n").filter(Boolean);
  const fresh = await freshCopy(files.home, "observations");
  try {
    let reopened;
    const { parses } = await countActiveParses(lines, async () => {
      reopened = await open(new JsonStateStore({ home: files.home }));
      return reopened.archiveIndexEntries.get(files.archive);
    });
    assert.equal(parses, 0, "the committed load must use the seed instead of re-parsing the active lines");
    assert.deepEqual(comparable(reopened.archiveIndexEntries.get(files.archive)),
      comparable(fresh.memory.archiveIndexEntries.get(fresh.archive)));
  } finally { await cleanup(files.home, fresh.copy); }
});

test("a copy fallback that changes the inode is not published", async () => {
  const files = await fixture("observations", observations({ id: "base", recordedAt: NOW }), { hot: [{ id: "hot-1", recordedAt: NOW }] });
  const staged = await open(files.store, { archiveWriteGuard: async () => {} });
  await staged.recordObservation({ id: "new-1", recordedAt: NOW, forceRecord: true });
  // The install is allowed to fall back to copying the verified bytes; that
  // replaces the inode, so the identity the append produced no longer holds.
  const replacement = `${files.archive}.replacement`;
  await writeFile(replacement, await readFile(files.archive));
  await rename(replacement, files.archive);
  assert.equal(staged.publishArchiveScanSeeds(files.filePath), true);
  const lines = (await readFile(files.archive, "utf8")).split("\n").filter(Boolean);
  try {
    const { parses } = await countActiveParses(lines, async () => {
      const reopened = await open(new JsonStateStore({ home: files.home }));
      return reopened.archiveIndexEntries.get(files.archive);
    });
    assert.ok(parses > 0, "a replaced inode must be scanned, not served from the append seed");
  } finally { await cleanup(files.home); }
});

test("an external append after publication is observed by the next load", async () => {
  const files = await fixture("observations", observations({ id: "base", recordedAt: NOW }), { hot: [{ id: "hot-1", recordedAt: NOW }] });
  const staged = await open(files.store, { archiveWriteGuard: async () => {} });
  await staged.recordObservation({ id: "new-1", recordedAt: NOW, forceRecord: true });
  staged.publishArchiveScanSeeds(files.filePath);
  const external = JSON.stringify({ id: "external-1", recordedAt: LAST });
  await writeFile(files.archive, (await readFile(files.archive, "utf8")) + external + "\n");
  const lines = (await readFile(files.archive, "utf8")).split("\n").filter(Boolean);
  try {
    let reopened;
    const { parses } = await countActiveParses(lines, async () => {
      reopened = await open(new JsonStateStore({ home: files.home }));
      return reopened.archiveIndexEntries.get(files.archive);
    });
    assert.equal(parses, lines.length, "a grown file must be scanned in full, not answered from the seed");
    assert.equal(reopened.archiveActiveKeys.get("observations").has(`id:external-1`), true);
  } finally { await cleanup(files.home); }
});

test("a sealed active file does not publish a seed for the empty file it becomes", async () => {
  const files = await fixture("observations", observations({ id: "base", recordedAt: NOW }), {
    hot: [{ id: "hot-1", recordedAt: NOW, summary: "s".repeat(400) }], options: { archiveMaxBytes: 256, absoluteMaxSegmentBytes: 4096 },
  });
  const staged = await open(files.store, { archiveWriteGuard: async () => {}, archiveMaxBytes: 256, absoluteMaxSegmentBytes: 4096 });
  await staged.recordObservation({ id: "new-1", recordedAt: NOW, forceRecord: true });
  staged.publishArchiveScanSeeds(files.filePath);
  const reopened = await open(new JsonStateStore({ home: files.home }), { archiveMaxBytes: 256, absoluteMaxSegmentBytes: 4096 });
  const active = reopened.archiveIndexEntries.get(files.archive);
  assert.ok(active, "the empty active file still has an entry");
  assert.equal(active.byteSize, 0, "the sealed active file is empty");
  assert.equal(active.physicalCount, 0);
  assert.equal(active.sealed, false);
  await cleanup(files.home);
});

test("the real port publishes the seed after install, so committed observes parse no active lines", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-scan-continuation-port-"));
  const backend = new JsonStorageBackend(join(root, "official"));
  const ctx = {
    emit() {}, logger: { warn() {}, error() {} },
    storage: { backend: { get: () => backend } }, effect() {},
  };
  ctx.storageDomain = new DomainFacility(ctx, { backend: "json" });
  const live = join(root, "dockyard");
  const activeArchive = join(live, "state.json.observations-archive.jsonl");
  const signal = (component, extra = {}) => ({
    type: "tool/result", code: "CACHE_READY", message: "cache warmup completed",
    problem: "cache warmup", componentId: `plugin:${component}`, severity: "info",
    status: "observed", success: true, recordedAt: NOW, ...extra,
  });
  await mkdir(live, { recursive: true });
  await writeFile(activeArchive, observations(signal("cold", { id: "cold" })));
  // A full hot window makes the next observation evict one record into the
  // active archive, which is the append whose facts the committed load reuses.
  await writeFile(join(live, "state.json"), JSON.stringify({
    evolution: { schema: 4, observations: Array.from({ length: 50 }, (_, index) => signal(`seed-${index}`, { id: `seed-${index}` })) },
  }));
  const port = await openDomainStorage(ctx, {
    presetDir: root, eventBridgePath: join(root, "execution-events.jsonl"),
    eventBridgeKey: "b".repeat(64), domainSeed: true,
  });
  const lines = (await readFile(activeArchive, "utf8")).split("\n").filter(Boolean);
  try {
    for (let round = 1; round <= 2; round += 1) {
      const { parses } = await countActiveParses(lines, async () => {
        await port.observe({ code: `CACHE_TEST_${round}`, target: "tool:x" });
      });
      assert.equal(parses, 0,
        `committed observe ${round} must reuse the seed instead of re-parsing active lines`);
    }
    const document = JSON.parse(await readFile(`${live}/state.json.evolution-archive-index.json`, "utf8"));
    const active = document.segments.find((entry) => entry.collection === "observations" && entry.sealed === false);
    assert.ok(active, "the committed index must still describe the active archive");
    assert.equal(active.byteSize, (await readFile(activeArchive)).length,
      "the committed index entry must describe the installed bytes");
    assert.equal(active.physicalCount, (await readFile(activeArchive, "utf8")).split("\n").filter(Boolean).length);
  } finally {
    await port.close();
    await backend.close();
    await rm(root, { recursive: true, force: true });
  }
});
