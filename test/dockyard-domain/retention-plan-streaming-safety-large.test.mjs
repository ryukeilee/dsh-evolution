// Large-corpus extension of the ownership / dry-run counter-examples.
//
// The small safety test proves the invariants on a corpus where every decision
// is visible. This file repeats the two that do not scale with corpus size on a
// cold tier of 40,000 records:
//
// 1. `compact({ dryRun: true })` must still perform zero durable writes: no
//    state-port update/save, no file content or listing change.
// 2. The plan's output must not borrow `#data` hot rows or `archiveReadCache`
//    window rows. The 40,000 cold rows make the tail positions the plan reads
//    through the cache a real part of the retained output, so a wrong ownership
//    decision shows up as a shared object rather than as an incidental copy.
//    After the first compaction the test also performs a write, a public
//    housekeeping pass and a second compaction, and it opens a successor
//    instance that *inherits* the predecessor's `archiveReadCache` (the shape
//    domain-storage uses for a staged replay working copy). Reports, bytes and
//    read surfaces must match the pinned 0.2.1 implementation in every step.
//
// Deliberately heavier than the small test: this file is the scale check, not
// the exhaustive semantic one. It runs as its own test process so the heap cap
// of the full suite applies to it unchanged.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { EvolutionMemory } from "../../lib/dockyard-domain/memory.js";
import {
  AT,
  InjectableStore,
  cleanupPinnedMemory,
  createMemory,
  diskDigests,
  fixedClock,
  loadPinnedMemory,
  stateDigest,
} from "./retention-plan-streaming-support.mjs";

const pinned = await loadPinnedMemory();
const homeRoot = await mkdtemp(join(tmpdir(), "dsh-retention-v021-large-"));

after(async () => {
  await rm(homeRoot, { recursive: true, force: true });
  await cleanupPinnedMemory();
});

// `#collections()`: the plan visits every one of these.
const COLLECTIONS = [
  "observations", "diagnoses", "gaps", "candidates", "proposals", "experiments",
  "experimentRecords", "journal", "selections", "promotions", "outcomes", "cycles",
  "lineage", "learnings", "strategies", "strategyMutations", "knowledge", "tombstones",
];

const LARGE = {
  observations: 16_000,
  knowledge: 8_000,
  cycles: 8_000,
  outcomes: 4_000,
  promotions: 4_000,
};

/**
 * 40,000 cold records: repeated healthy observations that aggregate, error
 * observations that stay addressable, knowledge accumulators, observed cycles,
 * and terminal outcomes/promotions that retire into tombstones.
 */
function largeCorpus() {
  const { mergeKnowledgeEntry, normalizeKnowledgeEvent } = pinned.knowledge;
  const sourceAt = (index) => ({
    id: `seed-${index}`,
    issueType: "performance",
    rootCause: `root-cause-${index}`,
    strategy: "bounded retry",
    componentId: `plugin:seed-${index}`,
    status: "success",
    recordedAt: AT,
    metrics: { latency: index % 5 + 1 },
  });
  const observations = [];
  const infoCount = LARGE.observations - 3_200 - 1_600;
  for (let index = 0; index < infoCount; index += 1) {
    observations.push({
      id: `obs-${index}`,
      type: "component/observation",
      severity: "info",
      componentId: `component-${index % 200}`,
      patternKey: `pattern-${index % 200}`,
      observedAt: AT,
      recordedAt: AT,
      message: `heartbeat ${index}`,
      metrics: { latency: index % 97 },
    });
  }
  for (let index = 0; index < 3_200; index += 1) {
    observations.push({
      id: `error-obs-${index}`,
      type: "component/observation",
      severity: "error",
      componentId: `error-component-${index}`,
      problem: `failure-${index}`,
      rootCause: `error-root-cause-${index % 500}`,
      errorCode: `E${index % 500}`,
      observedAt: AT,
      recordedAt: AT,
      message: `error ${index}`,
    });
  }
  for (let index = 0; index < 1_600; index += 1) {
    observations.push({ id: `opaque-${index}`, note: `opaque record ${index}`, recordedAt: AT });
  }
  const knowledge = Array.from({ length: LARGE.knowledge }, (_, index) => {
    const event = normalizeKnowledgeEvent(sourceAt(index), { sourceCollection: "observations", now: new Date(AT) });
    return { ...mergeKnowledgeEntry(null, event, { now: new Date(AT) }), sourceRefs: [], dimensions: event.dimensions };
  });
  const cycles = Array.from({ length: LARGE.cycles }, (_, index) => ({
    id: `cycle-${index}`,
    lifecycleState: "OBSERVED",
    status: "observed",
    observedAt: AT,
    recordedAt: AT,
    stages: [{ stage: "collect" }],
  }));
  const outcomes = Array.from({ length: LARGE.outcomes }, (_, index) => ({
    id: `outcome-${index}`,
    status: "rejected",
    lifecycleState: "REJECTED",
    signature: `signature-${index}`,
    rootCause: `outcome-root-cause-${index}`,
    recordedAt: AT,
    lastSeenAt: AT,
  }));
  const promotions = Array.from({ length: LARGE.promotions }, (_, index) => ({
    id: `promotion-${index}`,
    status: "rolled_back",
    lifecycleState: "ROLLED_BACK",
    capabilityId: `capability-${index}`,
    recordedAt: AT,
  }));
  const total = Object.values(LARGE).reduce((sum, count) => sum + count, 0);
  assert.equal(total, 40_000, "the large corpus must hold exactly 40,000 cold records");
  return { observations, knowledge, cycles, outcomes, promotions };
}

async function seedLarge(home, rows) {
  await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true });
  const store = new InjectableStore({ home });
  await mkdir(dirname(store.filePath), { recursive: true });
  // Every one of the 40,000 records lives in its archive file. The state file
  // keeps a few hot rows that duplicate already-cold ids, so the hot half of
  // the merge is exercised without adding records to the cold total.
  await store.save({
    evolution: {
      observations: [rows.observations[0]],
      knowledge: [rows.knowledge[0]],
      outcomes: [rows.outcomes[0]],
      canonical: [],
    },
  });
  for (const [collection, entries] of Object.entries(rows)) {
    await writeFile(`${store.filePath}.${collection}-archive.jsonl`, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  }
  return store;
}

/** Live-row identity view: which returned objects the store or the cache owns. */
function captureOwnership(memory) {
  const view = {};
  let hotRows = 0;
  let cacheRows = 0;
  for (const collection of COLLECTIONS) {
    const hotIds = new Set(memory.history(collection, { includeArchived: false }).map((row) => String(row.id)));
    const rows = memory.historyView(collection);
    const hotById = new Map();
    for (const row of rows) {
      if (row && typeof row === "object" && row.id !== undefined && row.id !== null && hotIds.has(String(row.id))) hotById.set(String(row.id), row);
    }
    const cacheById = new Map();
    for (const row of memory.archiveReadCache.get(collection)?.window ?? []) {
      if (row && typeof row === "object" && row.id !== undefined && row.id !== null) cacheById.set(String(row.id), row);
    }
    hotRows += hotById.size;
    cacheRows += cacheById.size;
    view[collection] = { hotIds, hotById, cacheById };
  }
  return { view, hotRows, cacheRows };
}

function ownershipViolations(primed, after) {
  const reusedLiveRows = [];
  const cacheRowsMovedIntoStore = [];
  const hotRowAliasesCache = [];
  for (const collection of COLLECTIONS) {
    const before = primed.view[collection];
    const current = after.view[collection];
    for (const [id, row] of before.hotById) {
      if (current.hotById.get(id) === row) reusedLiveRows.push(`${collection}:${id}`);
    }
    for (const [id, row] of before.cacheById) {
      if (current.hotIds.has(id) && current.hotById.get(id) === row) cacheRowsMovedIntoStore.push(`${collection}:${id}`);
    }
    for (const id of current.hotIds) {
      if (current.hotById.get(id) === current.cacheById.get(id)) hotRowAliasesCache.push(`${collection}:${id}`);
    }
  }
  return { reusedLiveRows, cacheRowsMovedIntoStore, hotRowAliasesCache };
}

function scanSurface(memory, collection) {
  const scan = memory.historyScan(collection, { window: 3 });
  const total = Number(scan.total) || 0;
  return {
    total,
    exact: [scan.exact(0), scan.exact(Math.max(0, total - 1))],
    rows: Array.from({ length: Math.min(3, total) }, (_, index) => scan.row(index)),
  };
}

/**
 * One implementation over 40,000 cold records:
 * dry run (must write nothing) -> prime cache -> compact -> ownership checks ->
 * write + housekeeping + second compact -> inherited-cache successor dry run.
 */
async function largeSide(MemoryClass, home) {
  const rows = largeCorpus();
  const store = await seedLarge(home, rows);
  const clock = fixedClock();
  const memory = createMemory(MemoryClass, store, { clock: clock.clock, options: { archiveMaxBytes: 4 * 1024 * 1024 } });
  await memory.load();

  const updatesAfterLoad = store.updateCalls;
  const savesAfterLoad = store.saveCalls;
  const bytesBeforeDryRun = await diskDigests(home);
  const dryRun = await memory.compact({ dryRun: true });
  const bytesAfterDryRun = await diskDigests(home);
  const dryRunUpdateCalls = store.updateCalls - updatesAfterLoad;
  const dryRunSaveCalls = store.saveCalls - savesAfterLoad;

  // Prime every archive read cache before the plan reads it.
  for (const collection of COLLECTIONS) memory.history(collection);
  const primed = captureOwnership(memory);
  const first = await memory.compact();
  const firstBytes = await diskDigests(home);
  const afterFirst = captureOwnership(memory);
  const violations = ownershipViolations(primed, afterFirst);

  // A later write and a public housekeeping pass, then a second compaction: a
  // borrowed row that outlived the plan would surface here or in the bytes.
  await memory.recordObservation({
    id: "post-compaction-observation",
    type: "component/observation",
    severity: "error",
    componentId: "component-post",
    problem: "post compaction problem",
    rootCause: "post compaction root cause",
    recordedAt: "2026-10-11T00:00:00.000Z",
  });
  memory.housekeeping();
  const second = await memory.compact();
  const secondBytes = await diskDigests(home);
  const secondStateDigest = stateDigest(memory.fullSnapshot());

  // Restart recovery on a limited but representative surface.
  const restarted = createMemory(MemoryClass, new InjectableStore({ home }), { clock: clock.clock, options: { archiveMaxBytes: 4 * 1024 * 1024 } });
  await restarted.load();
  const restartSurfaces = {
    window: restarted.historyWindow("observations", 5),
    knowledgeScan: scanSurface(restarted, "knowledge"),
    cyclesScan: scanSurface(restarted, "cycles"),
    stats: restarted.stats(),
  };

  // The successor instance inherits the predecessor's archive read cache, the
  // same way domain-storage hands a staged working copy its cache.
  const inherited = createMemory(MemoryClass, new InjectableStore({ home }), {
    clock: clock.clock,
    options: { archiveReadCache: memory.archiveReadCache, archiveMaxBytes: 4 * 1024 * 1024 },
  });
  await inherited.load();
  const inheritedBytesAfterLoad = await diskDigests(home);
  const inheritedDryRun = await inherited.compact({ dryRun: true });
  const inheritedBytesAfterDryRun = await diskDigests(home);
  const inheritedSurfaces = {
    window: inherited.historyWindow("knowledge", 5),
    knowledgeScan: scanSurface(inherited, "knowledge"),
  };

  return {
    dryRun, first, second,
    bytesBeforeDryRun, bytesAfterDryRun, firstBytes, secondBytes,
    dryRunUpdateCalls, dryRunSaveCalls,
    violations, primedCoverage: { hotRows: primed.hotRows, cacheRows: primed.cacheRows, postHotRows: afterFirst.hotRows, postCacheRows: afterFirst.cacheRows },
    secondStateDigest, restartSurfaces,
    inheritedDryRun, inheritedSurfaces, inheritedBytesAfterLoad, inheritedBytesAfterDryRun,
  };
}

test("40,000 cold records: dry run writes nothing and the plan borrows no live row", async (t) => {
  const home = join(homeRoot, "large");
  const before = await largeSide(pinned.EvolutionMemory, home);

  // The dry run must be a pure plan at this scale too.
  assert.equal(before.dryRunUpdateCalls, 0, "a 40k dry run must not call the state port's update");
  assert.equal(before.dryRunSaveCalls, 0, "a 40k dry run must not call the state port's save");
  assert.deepEqual(before.bytesAfterDryRun, before.bytesBeforeDryRun, "a 40k dry run must not change any file");

  // The plan must actually decide something at this scale.
  assert.ok(before.first.retired > 0, "the large corpus must retire terminal rows");
  assert.ok(before.first.consolidated > 0, "the large corpus must consolidate rows");
  assert.ok(before.first.aggregatedObservations > 0, "the large corpus must aggregate repeated observations");
  assert.ok(before.first.tombstones > 0, "the large corpus must record tombstones");
  assert.ok(before.first.knowledgeAfter > before.first.knowledgeBefore, "the accumulator must grow at scale");
  assert.ok(before.primedCoverage.hotRows > 0, "the ownership check must have hot store rows");
  assert.ok(before.primedCoverage.cacheRows > 0, "the ownership check must have cached archive rows");
  assert.ok(before.primedCoverage.postHotRows > 0, "the hot window must still hold rows after compaction");
  assert.ok(before.primedCoverage.postCacheRows > 0, "the archive cache must be repopulated by compaction");
  assert.deepEqual(before.violations.reusedLiveRows, [], "the plan must not hand a hot store row back");
  assert.deepEqual(before.violations.cacheRowsMovedIntoStore, [], "a cached archive row must not become a hot store row");
  assert.deepEqual(before.violations.hotRowAliasesCache, [], "a hot store row must not also be a cached archive row");
  assert.deepEqual(before.inheritedBytesAfterDryRun, before.inheritedBytesAfterLoad,
    "a dry run on an inherited-cache successor must not write");

  const after = await largeSide(EvolutionMemory, home);
  assert.deepEqual(after.dryRun, before.dryRun, "the 40k dry-run report must be identical");
  assert.deepEqual(after.first, before.first, "the 40k first compaction report must be identical");
  assert.deepEqual(after.second, before.second, "the 40k second compaction report must be identical");
  assert.deepEqual(after.bytesBeforeDryRun, before.bytesBeforeDryRun, "the seeded 40k bytes must be identical");
  assert.deepEqual(after.firstBytes, before.firstBytes, "every file after the 40k first compaction must be byte-identical");
  assert.deepEqual(after.secondBytes, before.secondBytes, "every file after the 40k second compaction must be byte-identical");
  assert.equal(after.secondStateDigest, before.secondStateDigest, "the 40k state after the second compaction must be identical");
  assert.deepEqual(after.restartSurfaces, before.restartSurfaces, "the 40k restart surfaces must be identical");
  assert.deepEqual(after.inheritedDryRun, before.inheritedDryRun, "the inherited-cache successor's dry-run report must be identical");
  assert.deepEqual(after.inheritedSurfaces, before.inheritedSurfaces, "the inherited-cache successor's read surfaces must be identical");
  assert.deepEqual(after.inheritedBytesAfterLoad, before.inheritedBytesAfterLoad, "the inherited-cache successor must load to identical bytes");
  assert.deepEqual(after.inheritedBytesAfterDryRun, before.inheritedBytesAfterDryRun, "the inherited-cache dry run must leave identical bytes");

  t.diagnostic(`40k: retired ${before.first.retired}, consolidated ${before.first.consolidated}, aggregated ${before.first.aggregatedObservations}, tombstones ${before.first.tombstones}, knowledge ${before.first.knowledgeBefore}->${before.first.knowledgeAfter}; ownership coverage ${JSON.stringify(before.primedCoverage)}; files ${Object.keys(before.firstBytes).length}`);
});
