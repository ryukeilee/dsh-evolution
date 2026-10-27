import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { EvolutionMemory } from "../../lib/dockyard-domain/memory.js";
import { JsonStateStore } from "./support.js";
import { archiveIndexBaseline, baselineFromSources, readBaselineSource, reconstructPreArchiveIntegrity, reconstructPreSharedScan } from "./archive-index-baseline.js";

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
const JOURNAL_RAW = [1, 2, 3].map((id) => JSON.stringify({ id: `journal-${id}`, recordedAt: FIRST })).join("\n") + "\n";

const WORKING_MEMORY = fileURLToPath(new URL("../../lib/dockyard-domain/memory.js", import.meta.url));

/**
 * Import a copy of memory.js whose relative imports are rewritten to this
 * tree's sibling modules (exactly as scripts/benchmarks/archive-index-reconcile.mjs
 * does), so a snapshot runs against the same dependencies as the working tree.
 */
async function importMemorySource(source, label) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-archive-baseline-"));
  const modulePath = join(directory, "memory.mjs");
  const dependencyBase = pathToFileURL(WORKING_MEMORY);
  await writeFile(modulePath, source.replace(/from (["'])(\.\.?\/[^"']+)\1/g,
    (_match, quote, specifier) => `from ${quote}${new URL(specifier, dependencyBase).href}${quote}`));
  try {
    const { EvolutionMemory: Memory } = await import(pathToFileURL(modulePath).href);
    assert.equal(typeof Memory, "function", `${label} must export EvolutionMemory`);
    return Memory;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// While the pin predates the refactor it is authoritative. After a re-pin,
// the guarded reversal still supplies the full implementation before this one
// change; missing source or shape drift fails rather than skipping coverage.
const baseline = await archiveIndexBaseline();
const BaselineMemory = await importMemorySource(baseline.source, "the derived pre-change baseline");

async function fixture(collection, raw) {
  const home = await mkdtemp(join(tmpdir(), "dsh-archive-equivalence-"));
  const store = new JsonStateStore({ home });
  const archive = `${store.filePath}.${collection}-archive.jsonl`;
  await mkdir(dirname(archive), { recursive: true });
  await writeFile(archive, raw);
  return { home, store, archive, index: `${store.filePath}.evolution-archive-index.json` };
}

async function newMemory(MemoryClass, store, options = {}) {
  const memory = new MemoryClass({
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

function expectedActive(archive) {
  return {
    segmentId: "active:observations", collection: "observations", recordType: "observations",
    file: archive.split("/").at(-1), firstTimestamp: FIRST, lastTimestamp: LAST,
    logicalCount: 8, physicalCount: 12, byteSize: Buffer.byteLength(RAW),
    sha256: null, hashAlgorithm: "sha256", checksumState: "provisional", sealed: false,
    retentionClass: "knowledge", winnerCount: 1, loserSummaryCount: 1, compactedCount: 1,
    createdAt: FIRST, updatedAt: NOW,
  };
}

/**
 * Count how often each active archive line is parsed by the archive-index
 * helpers while `run` executes.
 *
 * The count is attributed two ways: the line's own text (so it measures per-line
 * duplicated work) and the stack frame (so only the archive-index
 * scan/index/active-key helpers are counted — a compact also legitimately parses
 * the same lines while planning retention and rewriting the archive, and that
 * unrelated work is not what this change removes).
 *
 * The old `load()` parsed every active line once in `#indexEntryFromRaw` and
 * again in `#activeKeysFromRaw`; the change shares one `#scanArchiveRaw`, so
 * each line is parsed exactly once.
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
  try {
    await run();
  } finally {
    JSON.parse = original;
  }
  return counts;
}

const totalParses = (counts) => [...counts.values()].reduce((sum, count) => sum + count, 0);
const maxParses = (counts) => Math.max(...counts.values());

/** Reconcile (fresh load) parse counts for one implementation, on a fresh home. */
async function reconcileParses(MemoryClass) {
  const files = await fixture("observations", RAW);
  try {
    const counts = await countArchiveLineParses(RAW.split("\n").filter(Boolean),
      () => newMemory(MemoryClass, files.store));
    const [entry] = await indexEntries(files.index);
    return { counts, physicalCount: entry.physicalCount };
  } finally {
    await rm(files.home, { recursive: true, force: true });
  }
}

/** Compact rebuild parse counts for one implementation, on a fresh home. */
async function compactParses(MemoryClass) {
  const files = await fixture("journal", JOURNAL_RAW);
  try {
    const memory = await newMemory(MemoryClass, files.store);
    const counts = await countArchiveLineParses(JOURNAL_RAW.split("\n").filter(Boolean), () => memory.compact());
    const [entry] = await indexEntries(files.index);
    return { counts, physicalCount: entry.physicalCount };
  } finally {
    await rm(files.home, { recursive: true, force: true });
  }
}

test("restart reconciliation preserves mixed JSONL index fields and object-only active deduplication", async () => {
  const files = await fixture("observations", RAW);
  try {
    await newMemory(EvolutionMemory, files.store);
    const memory = await newMemory(EvolutionMemory, new JsonStateStore({ home: files.home }));
    assert.deepEqual(await indexEntries(files.index), [expectedActive(files.archive)]);
    assert.deepEqual(memory.archiveActiveKeys.get("observations"), new Set([
      "id:same", 'value:{"payload":"无 id"}', "value:[]", "id:last",
    ]));
    assert.equal(await readFile(files.archive, "utf8"), RAW, "recovery keeps corrupt lines intact");
    await memory.recordObservation({ id: "same", type: "component/observation" });
    await memory.recordObservation({ id: "hold", type: "component/observation" });
    assert.equal(await readFile(files.archive, "utf8"), RAW, "evicting an already archived id must not append it");
    assert.deepEqual(await indexEntries(files.index), [expectedActive(files.archive)]);
  } finally { await rm(files.home, { recursive: true, force: true }); }
});

test("rotation seals the same raw bytes and resets active keys, including after restart", async () => {
  const files = await fixture("observations", RAW);
  try {
    const memory = await newMemory(EvolutionMemory, files.store, { archiveMaxBytes: Buffer.byteLength(RAW) });
    const before = (await indexEntries(files.index))[0];
    // The oversized eviction seals the existing raw first, then its own segment,
    // leaving an empty active tail through the real append/rotation path.
    await memory.recordObservation({ id: "oversized", type: "component/observation", details: "x".repeat(2048) });
    await memory.recordObservation({ id: "hold", type: "component/observation" });
    const entries = await indexEntries(files.index);
    const sealed = entries.find((entry) => entry.segmentId === "segment:observations:000000000001");
    assert.ok(sealed);
    assert.deepEqual(sealed, {
      ...before, segmentId: "segment:observations:000000000001", file: "segment-000000000001.jsonl",
      sealed: true, checksumState: "final", sha256: createHash("sha256").update(RAW).digest("hex"),
    });
    assert.equal(await readFile(join(files.archive + ".segments", sealed.file), "utf8"), RAW);
    assert.equal(await readFile(files.archive, "utf8"), "");
    assert.deepEqual(memory.archiveActiveKeys.get("observations"), new Set());
    const active = entries.find((entry) => !entry.sealed);
    assert.equal(active.logicalCount, 0);
    assert.equal(active.physicalCount, 0);
    assert.equal(active.sha256, null);
    const reloaded = await newMemory(EvolutionMemory, new JsonStateStore({ home: files.home }));
    assert.deepEqual(reloaded.archiveActiveKeys.get("observations"), new Set());
    assert.deepEqual(await indexEntries(files.index), entries);
  } finally { await rm(files.home, { recursive: true, force: true }); }
});

test("reconcile and compact parse each active archive line once", async (t) => {
  // Absolute, deterministic invariants: each active line is parsed at most once
  // and exactly once per physical line, independent of any "before" number.
  const reconcile = await reconcileParses(EvolutionMemory);
  assert.equal(maxParses(reconcile.counts), 1, "no active line may be parsed twice during reconcile");
  assert.equal(totalParses(reconcile.counts), reconcile.physicalCount,
    "reconcile must parse each physical active-archive line exactly once");

  const rebuild = await compactParses(EvolutionMemory);
  assert.equal(maxParses(rebuild.counts), 1, "no active line may be parsed twice during a compact rebuild");
  assert.equal(totalParses(rebuild.counts), rebuild.physicalCount,
    "the compact rebuild must parse each kept active line exactly once");

  // The guarded pre-change baseline is always present, so these reduction
  // assertions can never silently stop running after a re-pin.
  const before = await reconcileParses(BaselineMemory);
  const baseRebuild = await compactParses(BaselineMemory);
  t.diagnostic(`archive-line JSON.parse per active line: reconcile ${totalParses(before.counts)} -> ${totalParses(reconcile.counts)}, `
    + `compact ${totalParses(baseRebuild.counts)} -> ${totalParses(rebuild.counts)}`);
  assert.equal(maxParses(before.counts), 2, "the pre-change baseline parsed every active line twice");
  assert.equal(totalParses(reconcile.counts), before.physicalCount,
    "the reduction must not change which lines are counted as physical");
  assert.ok(totalParses(reconcile.counts) < totalParses(before.counts),
    `reconcile must strictly reduce parse calls: ${totalParses(reconcile.counts)} < ${totalParses(before.counts)}`);
  assert.ok(totalParses(rebuild.counts) < totalParses(baseRebuild.counts),
    `compact must strictly reduce parse calls: ${totalParses(rebuild.counts)} < ${totalParses(baseRebuild.counts)}`);

  const files = await fixture("journal", JOURNAL_RAW);
  try {
    const memory = await newMemory(EvolutionMemory, files.store);
    await memory.compact();
    const entries = await indexEntries(files.index);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].physicalCount, 2);
    assert.equal(entries[0].logicalCount, 2);
    assert.equal(entries[0].byteSize, Buffer.byteLength(await readFile(files.archive, "utf8")));
    assert.equal(entries[0].checksumState, "provisional");
    assert.equal(entries[0].sha256, null);
    assert.deepEqual(memory.archiveActiveKeys.get("journal"), new Set(["id:journal-1", "id:journal-2"]));
  } finally { await rm(files.home, { recursive: true, force: true }); }
});

/**
 * The whitespace-only line is the only shape where the old and new active-key
 * loops look different: the old loop skipped `!line.trim()` before parsing,
 * while the shared scan keeps every non-empty line (`filter(Boolean)`) and lets
 * `JSON.parse` throw. Whitespace is never valid JSON, so the outcomes coincide;
 * these two assertions pin that argument down instead of assuming it.
 */
test("a whitespace-only line is never active knowledge: filter(Boolean) + a throwing parse equals a trim() skip", async () => {
  const whitespace = "   \t";
  assert.throws(() => JSON.parse(whitespace), "whitespace is not valid JSON, so a shared scan drops it");
  assert.equal(Boolean(whitespace), true, "filter(Boolean) keeps the whitespace-only line, unlike !line.trim()");

  const files = await fixture("observations", RAW);
  try {
    const memory = await newMemory(EvolutionMemory, files.store);
    const keys = memory.archiveActiveKeys.get("observations");
    assert.equal([...keys].some((key) => key === whitespace || key.includes(whitespace)), false);
    // physicalCount keeps counting the whitespace-only line, exactly as before.
    assert.equal((await indexEntries(files.index))[0].physicalCount, 12);
  } finally { await rm(files.home, { recursive: true, force: true }); }
});

/** Every sealed segment file of an archive, keyed by name. */
async function sealedSegments(archive) {
  const directory = `${archive}.segments`;
  let names = [];
  try { names = (await readdir(directory)).sort(); } catch { return {}; }
  const out = {};
  for (const name of names) out[name] = await readFile(join(directory, name), "utf8");
  return out;
}

const scenarios = {
  "fresh reconcile, then a restart against the written index": async (MemoryClass, home) => {
    const files = await fixtureIn("observations", RAW, home);
    await newMemory(MemoryClass, files.store);
    const memory = await newMemory(MemoryClass, new JsonStateStore({ home }));
    return snapshotOf(files, memory, "observations");
  },
  "an eviction of an already archived id, then a genuinely new id": async (MemoryClass, home) => {
    const files = await fixtureIn("observations", RAW, home);
    const memory = await newMemory(MemoryClass, files.store);
    await memory.recordObservation({ id: "same", type: "component/observation" });
    await memory.recordObservation({ id: "hold", type: "component/observation" });
    return snapshotOf(files, memory, "observations");
  },
  "rotation seals the active raw into a segment and resets active keys": async (MemoryClass, home) => {
    const files = await fixtureIn("observations", RAW, home);
    const memory = await newMemory(MemoryClass, files.store, { archiveMaxBytes: Buffer.byteLength(RAW) });
    await memory.recordObservation({ id: "oversized", type: "component/observation", details: "x".repeat(2048) });
    await memory.recordObservation({ id: "hold", type: "component/observation" });
    return snapshotOf(files, memory, "observations");
  },
  "compaction rewrites the active archive": async (MemoryClass, home) => {
    const files = await fixtureIn("journal", JOURNAL_RAW, home);
    const memory = await newMemory(MemoryClass, files.store);
    await memory.compact();
    return snapshotOf(files, memory, "journal");
  },
};

async function fixtureIn(collection, raw, home) {
  const store = new JsonStateStore({ home });
  const archive = `${store.filePath}.${collection}-archive.jsonl`;
  await mkdir(dirname(archive), { recursive: true });
  await writeFile(archive, raw);
  return { home, store, archive, index: `${store.filePath}.evolution-archive-index.json` };
}

/** A full snapshot of everything the archive index and active-key state expose. */
async function snapshotOf(files, memory, collection) {
  return {
    index: await readFile(files.index, "utf8"),
    archive: await readFile(files.archive, "utf8"),
    segments: await sealedSegments(files.archive),
    activeKeys: [...(memory.archiveActiveKeys.get(collection) ?? new Set())].sort(),
  };
}

test("the pre-change baseline and the working tree agree byte for byte across every archive shape", async () => {
  // No skip: the module-level loader guarantees a full pre-change baseline
  // or fails before this test runs.
  for (const [name, scenario] of Object.entries(scenarios)) {
    const baselineHome = await mkdtemp(join(tmpdir(), "dsh-archive-baseline-"));
    const workingHome = await mkdtemp(join(tmpdir(), "dsh-archive-working-"));
    try {
      const before = await scenario(BaselineMemory, baselineHome);
      const after = await scenario(EvolutionMemory, workingHome);
      assert.equal(after.index, before.index, `${name}: the index document must be byte-identical`);
      assert.equal(after.archive, before.archive, `${name}: the active archive must be byte-identical`);
      assert.deepEqual(after.segments, before.segments, `${name}: sealed segments must be byte-identical`);
      assert.deepEqual(after.activeKeys, before.activeKeys, `${name}: active keys must be deeply equal`);
    } finally {
      await rm(baselineHome, { recursive: true, force: true });
      await rm(workingHome, { recursive: true, force: true });
    }
  }
});

test("the derived baseline matches the pre-change pin, and survives a shared-scan re-pin", async (t) => {
  assert.equal(baseline.source, baseline.reconstructed,
    "the authoritative source and guarded reconstruction must be byte-identical");
  const working = await readBaselineSource();
  const repinned = baselineFromSources(working, working);
  assert.equal(repinned.pinPredatesScan, false);
  assert.equal(repinned.source, baseline.source, "a shared-scan re-pin must retain the full old baseline");
  assert.throws(() => reconstructPreArchiveIntegrity(working.replace(
    "const integrityFaults = this.#durableArchiveIntegrityFaults();",
    "const integrityFaults = null;",
  )), /archive-integrity post-change shape must occur exactly once/,
  "archive-integrity shape drift must never silently no-op");
  assert.throws(() => reconstructPreSharedScan(working.replace("#scanArchiveRaw(raw) {", "#scanArchiveRaw(raw) {/* drift */")),
    /post-change shape must occur exactly once/, "shape drift must never silently no-op");
  t.diagnostic(baseline.pinPredatesScan
    ? "pre-change pin and reconstruction are byte-identical"
    : "the pin carries shared scans; the guarded reconstruction supplies the baseline");
});
