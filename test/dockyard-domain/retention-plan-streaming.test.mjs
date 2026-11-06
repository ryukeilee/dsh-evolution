// Regression coverage for the retention-plan streaming round.
//
//  1. `compact({ dryRun: true })` is zero-write and its report is produced
//     without materialising the plan output: the dry-run test pins the observable
//     contract (no state/index/archive byte changes, no file added or removed, the
//     parsed archive table is adopted rather than replaced).
//  2. The knowledge-finalization path keeps the complete plan output: it calls
//     `#retentionPlan()` with the default `materialize: true`, so its canonical
//     row and candidate-summary tombstones must still be written and survive a
//     later compaction.
//  3. The plan's output owns its rows: a row it hands to the store must never be
//     the live hot row or the archive-cache window row it read. Mutating those
//     borrowed originals after the compaction must not change the store.
//
// The clock contract and the full pre-change differential stay in
// retention-plan-equivalence.test.js; this file is the targeted safety net.

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { EvolutionMemory } from "../../lib/dockyard-domain/memory.js";
import { JsonStateStore } from "./support.js";

const NOW = "2026-10-12T00:00:00.000Z";
const AT = "2026-10-10T00:00:00.000Z";

function memoryFor(store, options = {}) {
  const memory = new EvolutionMemory({
    stateStore: store,
    clock: () => new Date(NOW),
    maxEntries: 1000,
    hotEntries: 2,
    hotCycles: 2,
    archiveMaxBytes: 512,
    ...options,
  });
  memory.setMutationAuthority({ assertMutation() {}, isActive: () => true });
  return memory;
}

async function home(t) {
  const root = await mkdtemp(join(tmpdir(), "dsh-retention-streaming-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** sha256 of every regular file below `root`, keyed by its relative path. */
async function digests(root, relative = "") {
  const output = {};
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(output, await digests(root, path));
    else output[path] = createHash("sha256").update(await readFile(join(root, path))).digest("hex");
  }
  return Object.fromEntries(Object.entries(output).sort(([left], [right]) => left.localeCompare(right)));
}

/** A row with no knowledge identity at all: retained, never grouped. */
function opaqueRow(index) {
  return { id: `opaque-${index}`, note: `no identity ${index}`, recordedAt: AT, payload: "x".repeat(240) };
}

function terminalRow(index) {
  return {
    id: `terminal-${index}`,
    status: "failed",
    lifecycleState: "FAILED",
    signature: `terminal-signature-${index}`,
    rootCause: `terminal root cause ${index}`,
    recordedAt: AT,
  };
}

/** A retained hot candidate: opaque to the plan, distinct housekeeping fingerprint. */
function hotCandidateRow(index) {
  return { id: `hot-candidate-${index}`, note: `hot candidate ${index}`, recordedAt: AT, candidateFingerprint: `probe-candidate-${index}` };
}

test("a dry run writes nothing and keeps the archive read cache entry it read", async (t) => {
  const root = await home(t);
  const store = new JsonStateStore({ home: root });
  await mkdir(dirname(store.filePath), { recursive: true });
  await store.save({ evolution: { observations: Array.from({ length: 14 }, (_, index) => opaqueRow(index)) } });

  const memory = memoryFor(store);
  await memory.load();
  // The first compaction rewrites the cold tier, seals segments and writes the
  // index: the dry run below then reads a layout that already holds sealed files.
  await memory.compact();
  const beforeState = JSON.stringify(memory.fullSnapshot());
  const beforeFiles = await digests(root);
  assert.ok(Object.keys(beforeFiles).some((name) => /\.segments[\\/]segment-/.test(name)),
    "the fixture must hold at least one sealed segment");
  const cached = memory.archiveReadCache.get("observations");
  assert.ok(cached && cached.keys.length > 0, "the first compaction must leave a parsed archive table");

  const report = await memory.compact({ dryRun: true });

  assert.equal(report.dryRun, true);
  assert.equal(report.beforeBytes, report.afterBytes, "a dry run must report no archive byte change");
  assert.equal(JSON.stringify(memory.fullSnapshot()), beforeState, "a dry run must not mutate the store");
  assert.deepEqual(await digests(root), beforeFiles, "a dry run must not write, add or remove any file");
  assert.equal(memory.archiveReadCache.get("observations"), cached,
    "a dry run must adopt the parsed archive table instead of replacing it");
});

test("knowledge finalization still receives the complete plan output", async (t) => {
  const root = await home(t);
  const store = new JsonStateStore({ home: root });
  await mkdir(dirname(store.filePath), { recursive: true });
  await store.save({ evolution: {} });

  const memory = memoryFor(store);
  await memory.load();
  const result = await memory.finalizeKnowledge({
    problemFingerprint: "probe-problem",
    candidateGroup: "probe-group",
    winner: {
      id: "winner-probe",
      candidateFingerprint: "probe-winner",
      problem: "probe problem",
      rootCause: "probe root cause",
      capabilityId: "probe-capability",
      fitnessScore: 2,
      implementation: { kind: "probe" },
    },
    candidates: [{ id: "loser-probe", problemFingerprint: "probe-problem", candidateFingerprint: "probe-loser" }],
    outcome: "SUCCESS",
    validation: { validationRuns: 2, verified: true },
  });

  assert.equal(result.committed, true);
  // A plan without materialised records/canonical/tombstones would fail the
  // write path outright (records are sliced and canonical is replaced below).
  assert.ok(result.canonical && result.canonical.recordId === "winner-probe",
    "finalization must return the canonical row the plan produced");
  assert.ok(memory.canonicalSnapshot().some((row) => row.recordId === "winner-probe"),
    "the canonical row must be applied to the store");
  assert.ok(memory.history("tombstones").some((row) => row.id === "candidate-summary:probe-loser"),
    "the loser summary tombstone must be applied to the store");

  await memory.compact();
  assert.ok(memory.canonicalSnapshot().some((row) => row.recordId === "winner-probe"),
    "a later compaction must keep the finalized canonical row");
  assert.ok(memory.history("tombstones").some((row) => row.id === "candidate-summary:probe-loser"),
    "a later compaction must keep the finalized tombstone");
});

test("the plan's output owns its rows: no live hot or cache-window row is handed to the store", async (t) => {
  const root = await home(t);
  const store = new JsonStateStore({ home: root });
  await mkdir(dirname(store.filePath), { recursive: true });
  // The first three outcomes are opaque (retained); the last two are terminal and
  // sit in the hot window. After load() the opaque rows are archived and the
  // terminal rows are hot, so compaction keeps the archived rows as the new hot
  // tail: the retained rows it transfers into #data are exactly cache-window rows.
  // The two candidates stay hot and are retained, so the transferred hot rows
  // exercise the other half of the borrowed set.
  await store.save({ evolution: {
    outcomes: [opaqueRow(0), opaqueRow(1), opaqueRow(2), terminalRow(0), terminalRow(1)],
    candidates: [hotCandidateRow(0), hotCandidateRow(1)],
  } });

  const memory = memoryFor(store);
  await memory.load();
  assert.deepEqual(memory.snapshot().outcomes.map((row) => row.id), ["terminal-0", "terminal-1"],
    "load() must keep only the trailing hot window");

  // Read once so the archive read cache holds the retained window of cold rows.
  const view = memory.historyView("outcomes");
  const cached = memory.archiveReadCache.get("outcomes");
  assert.ok(cached?.window?.some(Boolean), "the cold history must be parsed into a retained window");
  const borrowed = new Set();
  for (const row of view) if (row && typeof row === "object") borrowed.add(row);
  for (const row of cached.window) if (row && typeof row === "object") borrowed.add(row);
  for (const row of memory.historyView("candidates")) if (row && typeof row === "object") borrowed.add(row);
  assert.ok(borrowed.size >= 4, "both hot and archived rows must take part");

  const report = await memory.compact();
  assert.equal(report.retired, 2, "the terminal hot rows must be retired");
  const settled = JSON.stringify(memory.snapshot());
  assert.deepEqual(memory.snapshot().outcomes.map((row) => row.id), ["opaque-1", "opaque-2"],
    "the archived retained rows must become the new hot tail");
  assert.deepEqual(memory.snapshot().candidates.map((row) => row.id), ["hot-candidate-0", "hot-candidate-1"],
    "the retained hot rows must stay in the hot window");

  // A correct plan clones every borrowed row. If a hot or cache-window row object
  // had been transferred into #data, mutating the borrowed original would now
  // change the store's projection.
  for (const row of borrowed) row.probeLeak = true;
  assert.equal(JSON.stringify(memory.snapshot()), settled,
    "the plan must not hand a live hot or archive-cache row to the store");
});

test("an inherited archive cache decides the same plan and keeps its window rows out of the output", async (t) => {
  const root = await home(t);
  const store = new JsonStateStore({ home: root });
  await mkdir(dirname(store.filePath), { recursive: true });
  const rows = { outcomes: [opaqueRow(0), opaqueRow(1), opaqueRow(2), terminalRow(0), terminalRow(1)] };
  await store.save({ evolution: rows });

  const predecessor = memoryFor(store);
  await predecessor.load();
  // Populate the parse a successor instance will inherit.
  const view = predecessor.historyView("outcomes");
  assert.equal(view.length, 5);
  const inheritedCache = predecessor.archiveReadCache;
  assert.ok([...inheritedCache.values()].some((entry) => entry.window?.length),
    "the predecessor must hold a parsed window");

  const inherited = memoryFor(new JsonStateStore({ home: root }), { archiveReadCache: inheritedCache });
  await inherited.load();
  const dryRun = await inherited.compact({ dryRun: true });
  const cached = inherited.archiveReadCache.get("outcomes");
  const borrowed = new Set();
  for (const row of inherited.historyView("outcomes")) if (row && typeof row === "object") borrowed.add(row);
  for (const row of cached.window) if (row && typeof row === "object") borrowed.add(row);
  const report = await inherited.compact();
  assert.equal(report.retired, 2, "the inherited cache must not change the retirement decision");
  const inheritedState = JSON.stringify(inherited.fullSnapshot());
  const inheritedBytes = await digests(root);

  // A leaked cache-window row would now change the store's projection.
  const settled = JSON.stringify(inherited.snapshot());
  for (const row of borrowed) row.probeLeak = true;
  assert.equal(JSON.stringify(inherited.snapshot()), settled,
    "an inherited cache row must not become a store row");
  assert.equal(JSON.stringify(inherited.fullSnapshot()), inheritedState,
    "mutating borrowed rows must not change the durable projection either");

  // Reference: the same corpus and steps on a freshly seeded instance.
  await rm(root, { recursive: true, force: true });
  await mkdir(dirname(store.filePath), { recursive: true });
  await store.save({ evolution: rows });
  const reference = memoryFor(store);
  await reference.load();
  const referenceDryRun = await reference.compact({ dryRun: true });
  const referenceReport = await reference.compact();
  assert.deepEqual(dryRun, referenceDryRun, "the inherited cache must not change the dry-run report");
  assert.deepEqual(report, referenceReport, "the inherited cache must not change the compaction report");
  assert.equal(JSON.stringify(reference.fullSnapshot()), inheritedState,
    "the inherited cache must not change the resulting state");
  assert.deepEqual(await digests(root), inheritedBytes, "the inherited cache must not change the written bytes");
});

test("without an archive tier every row is hot and none is handed to the store", async (t) => {
  class InMemoryStore {
    constructor(state) { this.state = state; }
    async load() { return structuredClone(this.state); }
    async update(change) { this.state = await change(structuredClone(this.state)); }
    async save(state) { this.state = structuredClone(state); }
  }
  const store = new InMemoryStore({ evolution: { outcomes: [opaqueRow(0), opaqueRow(1), opaqueRow(2), opaqueRow(3)] } });
  const memory = memoryFor(store);
  await memory.load();

  const view = memory.historyView("outcomes");
  assert.equal(view.length, 4, "without an archive the whole hot partition is the history");
  const report = await memory.compact();
  assert.equal(report.after.outcomes, 4, "with no archive tier maxEntries, not hotEntries, bounds the store");
  assert.deepEqual(memory.snapshot().outcomes.map((row) => row.id), ["opaque-0", "opaque-1", "opaque-2", "opaque-3"]);

  const settled = JSON.stringify(memory.snapshot());
  for (const row of view) row.probeLeak = true;
  assert.equal(JSON.stringify(memory.snapshot()), settled,
    "the plan must not hand a live hot row to the store when there is no archive tier");

  const dryRun = await memory.compact({ dryRun: true });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.after.outcomes, report.after.outcomes, "the dry run must report the same counts");
});

test("a forced archive-read fallback produces the same plan as a clean read", async (t) => {
  // More rows than the retained window holds, so positions outside the window are
  // read back through their locators instead of the cached window.
  const rows = Array.from({ length: 2100 }, (_, index) => ({ id: `opaque-${index}`, note: `no identity ${index}`, recordedAt: AT }));

  const rootA = await home(t);
  const storeA = new JsonStateStore({ home: rootA });
  await mkdir(dirname(storeA.filePath), { recursive: true });
  await storeA.save({ evolution: { outcomes: rows } });
  const forced = memoryFor(storeA);
  await forced.load();
  const beforeDryRun = await digests(rootA);
  forced.historyView("outcomes"); // populate the cached parse the plan will adopt
  const cached = forced.archiveReadCache.get("outcomes");
  assert.ok(cached.windowFrom > 0, "the fixture must leave positions outside the retained window");
  // A locator that no longer describes its line is exactly what the fallback
  // recovery rescan exists for: `#archiveRowsFrom()` cannot reproduce row 0, so
  // `#readArchiveSync()` rescans and answers from the fresh rows.
  const corrupted = {
    ...cached,
    locators: {
      files: cached.locators.files,
      ordinal: cached.locators.ordinal,
      start: new Float64Array(cached.locators.start),
      length: new Uint32Array(cached.locators.length),
    },
  };
  corrupted.locators.start[0] = 0;
  corrupted.locators.length[0] = 4;
  forced.archiveReadCache.set("outcomes", corrupted);

  const dryRun = await forced.compact({ dryRun: true });
  assert.notEqual(forced.archiveReadCache.get("outcomes"), corrupted,
    "the corrupted table must have been replaced by the fallback rescan");
  assert.deepEqual(await digests(rootA), beforeDryRun, "the fallback recovery must not write");

  const rootB = await home(t);
  const storeB = new JsonStateStore({ home: rootB });
  await mkdir(dirname(storeB.filePath), { recursive: true });
  await storeB.save({ evolution: { outcomes: rows } });
  const clean = memoryFor(storeB);
  await clean.load();
  const referenceDryRun = await clean.compact({ dryRun: true });
  assert.deepEqual(dryRun, referenceDryRun, "the fallback read must produce the same report as a clean read");
});

test("a malformed persisted tombstone recordIds aborts a dry run exactly like a compaction", async (t) => {
  const root = await home(t);
  const store = new JsonStateStore({ home: root });
  await mkdir(dirname(store.filePath), { recursive: true });
  // The domain schema does not validate `recordIds`, so a persisted JSON row can
  // carry a non-iterable one. The plan's tombstone merge spreads it: the dry run
  // and the real compaction must raise the same TypeError, because a report must
  // not describe an execution the write path would refuse.
  await store.save({ evolution: {
    tombstones: [{ id: "tombstone:fp", fingerprint: "fp", recordIds: { invalid: true }, count: 1, recordedAt: AT }],
    gaps: [{ id: "victim", status: "rejected", lifecycleState: "REJECTED", fingerprint: "fp", recordedAt: AT }],
  } });
  const memory = memoryFor(store);
  await memory.load();
  const beforeFiles = await digests(root);
  const beforeState = JSON.stringify(memory.fullSnapshot());

  await assert.rejects(memory.compact({ dryRun: true }),
    (error) => error instanceof TypeError && /not iterable/.test(error.message),
    "a dry run must evaluate the tombstone merge and raise the same TypeError as a compaction");
  assert.deepEqual(await digests(root), beforeFiles, "an aborted dry run must not write");
  assert.equal(JSON.stringify(memory.fullSnapshot()), beforeState, "an aborted dry run must not change the store");
  await assert.rejects(memory.compact(),
    (error) => error instanceof TypeError && /not iterable/.test(error.message),
    "the real compaction must keep raising the same TypeError");
});
