// Targeted counter-example tests for the retention/compaction streaming change.
//
// These do not restate the implementation: each one looks for a failure mode the
// performance work could introduce, using only public state.
//
// 1. A dry run must not write. It is asserted on the file tree and on the state
//    port, so "only in-memory" cannot stand in for "durable".
// 2. The plan's output must not borrow mutable rows. The plan now reads without
//    cloning (`historyView()`), so a row it keeps must be cloned unless this call
//    already owns it. `#data` hot rows and rows retained by `archiveReadCache` are
//    not owned by the plan. The identity of a hot row is observable through
//    `historyView()` (live rows), and `archiveReadCache` is a public instance
//    field, so the invariant is checked directly: after compaction, no hot row
//    may be the same object as a pre-compaction hot row or a pre-compaction
//    cached archive row.
// 3. Priming the archive read cache must not change any observable result. Reads
//    before the plan then a write, a housekeeping pass and a second compaction
//    must produce the same reports, state and bytes as a run that never primed
//    the cache - on both implementations, and identically between them.
//
// What these tests cannot observe: a transient plan-internal row that never
// reaches `#data`, and object sharing that ends before the next public read. The
// identity and behavior checks above cover every borrow that can outlive the
// plan, which is the invariant the change must keep.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EvolutionMemory } from "../../lib/dockyard-domain/memory.js";
import {
  AT,
  InjectableStore,
  cleanupPinnedMemory,
  createMemory,
  diskDigests,
  diskListing,
  loadPinnedMemory,
  readSurfaces,
  seedCorpus,
  standardCorpus,
  stateDigest,
} from "./retention-plan-streaming-support.mjs";

const pinned = await loadPinnedMemory();
const homeRoot = await mkdtemp(join(tmpdir(), "dsh-retention-v021-safety-"));
after(async () => {
  await rm(homeRoot, { recursive: true, force: true });
  await cleanupPinnedMemory();
});

/** The collections the plan visits (`#collections()` without `tombstones`). */
function collectionNames(memory) {
  const snapshot = memory.fullSnapshot();
  return Object.keys(snapshot).filter((key) => Array.isArray(snapshot[key]) && key !== "canonical");
}

function viewSnapshot(memory) {
  const collections = collectionNames(memory);
  const view = {};
  for (const collection of collections) {
    const hotIds = new Set(memory.history(collection, { includeArchived: false }).map((row) => String(row.id)));
    const rows = memory.historyView(collection);
    const hotRows = new Map();
    for (const row of rows) {
      if (row && typeof row === "object" && row.id !== undefined && row.id !== null && hotIds.has(String(row.id))) {
        hotRows.set(String(row.id), row);
      }
    }
    const cache = memory.archiveReadCache.get(collection) ?? null;
    const cacheRows = new Map();
    for (const row of cache?.window ?? []) {
      if (row && typeof row === "object" && row.id !== undefined && row.id !== null) cacheRows.set(String(row.id), row);
    }
    view[collection] = {
      hotIds,
      hotRows,
      cacheRows,
      cacheJson: JSON.stringify((cache?.window ?? []).filter((row) => row && typeof row === "object")),
    };
  }
  return view;
}

test("a dry run performs no durable write", async (t) => {
  const home = join(homeRoot, "dry-run");
  const reports = {};
  for (const [label, MemoryClass] of [["pinned", pinned.EvolutionMemory], ["working", EvolutionMemory]]) {
    const store = await seedCorpus(home, standardCorpus(), { StoreClass: InjectableStore });
    const memory = createMemory(MemoryClass, store);
    await memory.load();
    const bytesBefore = await diskDigests(home);
    const listingBefore = await diskListing(home);
    const updatesBefore = store.updateCalls;
    const savesBefore = store.saveCalls;
    const dryRun = await memory.compact({ dryRun: true });
    const bytesAfter = await diskDigests(home);
    const listingAfter = await diskListing(home);
    assert.equal(store.updateCalls, updatesBefore, `${label}: a dry run must not call the state port's update`);
    assert.equal(store.saveCalls, savesBefore, `${label}: a dry run must not call the state port's save`);
    assert.deepEqual(bytesAfter, bytesBefore, `${label}: a dry run must not change any file`);
    assert.deepEqual(listingAfter, listingBefore, `${label}: a dry run must not create or remove any file`);
    assert.equal(dryRun.dryRun, true, `${label}: the report must say it was a dry run`);
    assert.equal(dryRun.afterBytes, dryRun.beforeBytes, `${label}: a dry run must report the bytes it found`);
    reports[label] = dryRun;
  }
  assert.deepEqual(reports.working, reports.pinned, "the dry-run report must be identical to the pinned implementation");
  t.diagnostic(`dry run: retired ${reports.pinned.retired}, consolidated ${reports.pinned.consolidated}, ${reports.pinned.beforeBytes} bytes`);
});

/**
 * Run one implementation with or without priming every read that fills
 * `archiveReadCache`, then write, run housekeeping and compact again.
 */
async function cachedRun(MemoryClass, home, { prime }) {
  const store = await seedCorpus(home, standardCorpus(), { StoreClass: InjectableStore });
  const memory = createMemory(MemoryClass, store);
  await memory.load();
  const violations = { reusedLiveRows: [], cacheRowsMovedIntoStore: [], hotRowAliasesCache: [] };
  const identityCoverage = { preHotRows: 0, preCacheRows: 0, postHotRows: 0, postCacheRows: 0 };
  let primed = null;
  if (prime) {
    // Every public full-history read hydrates the cache window.
    for (const collection of collectionNames(memory)) {
      memory.history(collection);
      memory.historyView(collection);
      memory.historyWindow(collection, 5);
    }
    memory.fullSnapshot();
    primed = viewSnapshot(memory);
    for (const state of Object.values(primed)) {
      identityCoverage.preHotRows += state.hotRows.size;
      identityCoverage.preCacheRows += state.cacheRows.size;
    }
  }

  // A dry run must not mutate rows the cache retains: it is a read-only plan.
  const cacheJsonBeforeDryRun = primed ? JSON.stringify(Object.fromEntries(Object.entries(primed).map(([collection, state]) => [collection, state.cacheJson]))) : null;
  const dryRun = await memory.compact({ dryRun: true });
  if (primed) {
    const afterDryRun = viewSnapshot(memory);
    const cacheJsonAfterDryRun = JSON.stringify(Object.fromEntries(Object.entries(afterDryRun).map(([collection, state]) => [collection, state.cacheJson])));
    assert.equal(cacheJsonAfterDryRun, cacheJsonBeforeDryRun, "a dry run must not modify a cached archive row");
    primed = viewSnapshot(memory);
  }

  const first = await memory.compact();
  const firstBytes = await diskDigests(home);
  if (primed) {
    const after = viewSnapshot(memory);
    for (const state of Object.values(after)) {
      identityCoverage.postHotRows += state.hotRows.size;
      identityCoverage.postCacheRows += state.cacheRows.size;
    }
    for (const collection of Object.keys(primed)) {
      const beforeState = primed[collection];
      const afterState = after[collection];
      for (const [id, row] of beforeState.hotRows) {
        // A hot row the plan kept must be a new object: the store still owned it.
        if (afterState.hotRows.get(id) === row) violations.reusedLiveRows.push(`${collection}:${id}`);
      }
      for (const [id, row] of beforeState.cacheRows) {
        // A cached archive row must never be adopted as a hot store row.
        if (afterState.hotIds.has(id) && afterState.hotRows.get(id) === row) violations.cacheRowsMovedIntoStore.push(`${collection}:${id}`);
      }
      for (const id of afterState.hotIds) {
        // The store's own hot row must not be the archive cache's row either.
        if (afterState.hotRows.get(id) === afterState.cacheRows.get(id)) violations.hotRowAliasesCache.push(`${collection}:${id}`);
      }
    }
  }

  // A later write and housekeeping pass, then a second compaction: a borrowed row
  // that outlived the plan would surface in these observables.
  await memory.recordObservation({
    id: "post-compaction-observation",
    type: "component/observation",
    severity: "error",
    componentId: "component-post",
    problem: "post problem",
    rootCause: "post root cause",
    recordedAt: "2026-10-11T00:00:00.000Z",
  });
  memory.housekeeping();
  const second = await memory.compact();
  const secondBytes = await diskDigests(home);
  const surfaces = readSurfaces(memory);
  const restarted = createMemory(MemoryClass, new InjectableStore({ home }));
  await restarted.load();
  const restartSurfaces = readSurfaces(restarted);
  const restartBytes = await diskDigests(home);
  return { dryRun, first, second, firstBytes, secondBytes, surfaces, restartSurfaces, restartBytes, violations, identityCoverage };
}

test("the plan's output does not borrow live store or archive-cache rows", async (t) => {
  const home = join(homeRoot, "aliasing");
  for (const [label, MemoryClass] of [["pinned", pinned.EvolutionMemory], ["working", EvolutionMemory]]) {
    const primed = await cachedRun(MemoryClass, home, { prime: true });
    assert.ok(primed.identityCoverage.preHotRows > 0, `${label}: the identity check must have hot store rows to compare`);
    assert.ok(primed.identityCoverage.preCacheRows > 0, `${label}: the identity check must have cached archive rows to compare`);
    assert.ok(primed.identityCoverage.postHotRows > 0, `${label}: the hot window must still hold rows after compaction`);
    assert.ok(primed.identityCoverage.postCacheRows > 0, `${label}: the archive cache must be repopulated by compaction`);
    assert.deepEqual(primed.violations.reusedLiveRows, [],
      `${label}: a plan that keeps a hot row must not hand the store's own object back`);
    assert.deepEqual(primed.violations.cacheRowsMovedIntoStore, [],
      `${label}: a cached archive row must not become a hot store row`);
    assert.deepEqual(primed.violations.hotRowAliasesCache, [],
      `${label}: a hot store row must not also be the archive cache's row`);

    // Priming the cache is an optimization of reads, not a change of behavior.
    const unprimed = await cachedRun(MemoryClass, home, { prime: false });
    assert.deepEqual(primed.dryRun, unprimed.dryRun, `${label}: the dry-run report must not depend on cache state`);
    assert.deepEqual(primed.first, unprimed.first, `${label}: the first compaction must not depend on cache state`);
    assert.deepEqual(primed.second, unprimed.second, `${label}: the second compaction must not depend on cache state`);
    assert.deepEqual(primed.firstBytes, unprimed.firstBytes, `${label}: the bytes after the first compaction must not depend on cache state`);
    assert.deepEqual(primed.secondBytes, unprimed.secondBytes, `${label}: the bytes after the second compaction must not depend on cache state`);
    assert.deepEqual(primed.restartSurfaces, unprimed.restartSurfaces, `${label}: a restarted instance must read the same state regardless of cache state`);
    assert.deepEqual(primed.restartBytes, unprimed.restartBytes, `${label}: restarting must not rewrite the tree regardless of cache state`);
  }

  const pinnedPrimed = await cachedRun(pinned.EvolutionMemory, home, { prime: true });
  const workingPrimed = await cachedRun(EvolutionMemory, home, { prime: true });
  assert.deepEqual(workingPrimed.dryRun, pinnedPrimed.dryRun, "the primed dry-run report must be identical");
  assert.deepEqual(workingPrimed.first, pinnedPrimed.first, "the primed first compaction report must be identical");
  assert.deepEqual(workingPrimed.second, pinnedPrimed.second, "the primed second compaction report must be identical");
  assert.deepEqual(workingPrimed.firstBytes, pinnedPrimed.firstBytes, "the primed first compaction bytes must be identical");
  assert.deepEqual(workingPrimed.secondBytes, pinnedPrimed.secondBytes, "the primed second compaction bytes must be identical");
  assert.deepEqual(workingPrimed.surfaces, pinnedPrimed.surfaces, "the primed read surfaces must be identical");
  assert.deepEqual(workingPrimed.restartSurfaces, pinnedPrimed.restartSurfaces, "the primed restart surfaces must be identical");
  t.diagnostic(`primed cache: retired ${pinnedPrimed.first.retired}, knowledge ${pinnedPrimed.first.knowledgeBefore}->${pinnedPrimed.first.knowledgeAfter}, identity coverage ${JSON.stringify(pinnedPrimed.identityCoverage)}, ${Object.keys(pinnedPrimed.firstBytes).length} files`);
});

// ---------------------------------------------------------------------------
// The row-shape contract of a cache-window row.
//
// `#historyPlanRows()` reads a cache-window row live and only clones it on the
// way out, on the stated assumption that such a row is `JSON.parse` output. This
// test pins that boundary from both sides:
//
// - a hot row with a non-JSON nested value (the documented in-memory Error-DTO
//   case) must still be read as its clone, exactly like the pinned
//   implementation, or the clone shape of the existing `history()` contract
//   would move;
// - a cache-window row injected through the public `archiveReadCache` with a
//   nested `Error` (whose own enumerable properties `structuredClone` drops)
//   makes the candidate read a reference the pinned implementation cannot see.
//   That divergence proves the assumption is load-bearing, and the JSON
//   round-trip of the very same row proves the divergence disappears for every
//   shape a production window row can have: production window rows only come
//   from `JSON.parse` of archive lines (or an inherited cache holding those
//   parses), and a hand-written cache entry is outside that contract.
//
// No production path was found that puts a non-JSON value into a window row:
// the state file is JSON, archive lines are JSON, and `archiveReadCache` is
// documented as parsed bytes handed to a staged successor.
// ---------------------------------------------------------------------------

/** A store that returns its state as-is, so an Error DTO stays an Error object. */
class RawStore {
  constructor(state) { this.state = state; }
  async load() { return this.state; }
  async update(change) { this.state = await change(this.state); }
}

function hotNonJsonRows() {
  const boom = new Error("hot nested error");
  boom.recordId = "hot-protected";
  return {
    observations: [
      {
        id: "hot-holder",
        type: "component/observation",
        severity: "error",
        problem: "hot problem",
        rootCause: "hot root cause",
        recordedAt: AT,
        nested: { boom, when: new Date(AT), map: new Map([["key", "hot-protected"]]) },
      },
      { id: "hot-target", lifecycleState: "REJECTED", note: "opaque terminal row", recordedAt: AT },
      { id: "hot-filler", type: "component/observation", severity: "info", componentId: "component-hot", patternKey: "pattern-hot", recordedAt: AT },
    ],
    knowledge: [],
    canonical: [],
    tombstones: [],
  };
}

async function hotNonJsonSide(MemoryClass) {
  const store = new RawStore({ evolution: hotNonJsonRows() });
  const memory = createMemory(MemoryClass, store);
  await memory.load();
  const dryRun = await memory.compact({ dryRun: true });
  const first = await memory.compact();
  return { dryRun, first, stateDigest: stateDigest(memory.fullSnapshot()) };
}

/** Replace one primed `gaps` window row with a hand-written object. */
function injectWindowRow(memory, { roundTrip }) {
  memory.history("gaps");
  const entry = memory.archiveReadCache.get("gaps");
  const index = entry.window.findIndex((row) => row && row.id === "ref-holder");
  assert.ok(index >= 0, "the fixture gap row must be in the archive cache window");
  const boom = new Error("injected nested error");
  boom.recordId = "terminal-opaque";
  const injected = {
    ...entry.window[index],
    injected: { boom, when: new Date(AT), lookup: new Map([["key", "terminal-opaque"]]), list: [new Set(["terminal-opaque"])] },
  };
  // The round-trip is what `JSON.parse` of an archive line would produce; an
  // Error's own `recordId` becomes a plain own property, which both sides see.
  entry.window[index] = roundTrip ? JSON.parse(JSON.stringify(injected)) : injected;
}

async function injectedWindowSide(MemoryClass, home, { roundTrip }) {
  const store = await seedCorpus(home, standardCorpus(), { StoreClass: InjectableStore });
  const memory = createMemory(MemoryClass, store);
  await memory.load();
  injectWindowRow(memory, { roundTrip });
  const dryRun = await memory.compact({ dryRun: true });
  const first = await memory.compact();
  const snapshot = memory.fullSnapshot();
  return {
    dryRun,
    first,
    stateDigest: stateDigest(snapshot),
    gaps: snapshot.gaps.map((row) => row.id),
    tombstones: snapshot.tombstones.map((tombstone) => tombstone.recordId),
    bytes: await diskDigests(home),
  };
}

test("a non-JSON cache-window row is outside the documented archive-row contract", async (t) => {
  // 1) The existing clone shape applies to hot rows: an Error DTO lost its own
  // properties before the plan saw it and still does.
  const hotBaseline = await hotNonJsonSide(pinned.EvolutionMemory);
  const hotCandidate = await hotNonJsonSide(EvolutionMemory);
  assert.equal(hotBaseline.first.retired, 1, "the hot-row fixture must retire its terminal row");
  assert.deepEqual(hotBaseline.dryRun, hotCandidate.dryRun, "a hot non-JSON row must produce the same dry-run report");
  assert.deepEqual(hotBaseline.first, hotCandidate.first, "a hot non-JSON row must produce the same compaction report");
  assert.equal(hotBaseline.stateDigest, hotCandidate.stateDigest, "a hot non-JSON row must produce the same clone shape");

  // 2) A hand-written non-JSON window row makes the candidate observe a
  //    reference the pinned implementation's clone cannot carry. This is an
  //    out-of-contract shape, so divergence is characterized rather than
  //    required: a more conservative implementation that also cloned window rows
  //    would match the pin and is equally acceptable here. What must never
  //    differ is the JSON round-trip below, which is the only shape a production
  //    window row can have.
  const home = join(homeRoot, "non-json-window");
  const baseline = await injectedWindowSide(pinned.EvolutionMemory, home, { roundTrip: false });
  const candidate = await injectedWindowSide(EvolutionMemory, home, { roundTrip: false });
  const diverges = JSON.stringify(baseline) !== JSON.stringify(candidate);
  if (diverges) {
    // The pinned implementation's clone loses the Error's own recordId, so only
    // the live read can see the reference; every difference must be that one
    // decision.
    assert.equal(baseline.dryRun.retired, candidate.dryRun.retired + 1,
      "the injected Error's own recordId is visible to the live read and lost by the clone");
    assert.ok(baseline.tombstones.includes("terminal-opaque"),
      "the pinned implementation retires the row the nested Error named");
    assert.ok(candidate.gaps.includes("terminal-opaque"),
      "the candidate keeps the row the live nested Error named");
    assert.notEqual(baseline.stateDigest, candidate.stateDigest, "the divergence reaches the state");
  } else {
    // A candidate that clones the window row before deciding matches the pin;
    // that is stricter than required and is accepted by the JSON round-trip
    // assertion below.
    assert.deepEqual(candidate, baseline, "without divergence the whole out-of-contract outcome is identical");
  }

  // 3) The JSON round-trip of the same row is what a production window row can
  //    be, and there both implementations agree completely.
  const baselineJson = await injectedWindowSide(pinned.EvolutionMemory, home, { roundTrip: true });
  const candidateJson = await injectedWindowSide(EvolutionMemory, home, { roundTrip: true });
  assert.ok(baselineJson.gaps.includes("terminal-opaque"), "the round-tripped own property still names the row");
  assert.ok(!baselineJson.tombstones.includes("terminal-opaque"), "the round-tripped own property still protects the row");
  assert.deepEqual(baselineJson, candidateJson, "a JSON-shaped window row must behave identically");
  t.diagnostic(`non-JSON window row: ${diverges ? "diverges (out of contract)" : "no divergence"} - pinned retires ${baseline.dryRun.retired}, candidate ${candidate.dryRun.retired}; JSON round-trip identical (retired ${baselineJson.dryRun.retired})`);
});
