// Differential equivalence for the knowledge/retention plan and the compaction
// it drives.
//
// The working tree normalizes each source row once per plan, reuses the plan's
// own copy of a knowledge row, and collects non-knowledge-bearing rows in the
// pass that already visited them. The classification loop in `#retentionPlan()`
// reads that pass's own `retainedEntries` classification instead of normalizing
// the row again. This test drives the guarded pre-change implementation
// (`archiveIndexBaseline()` reverses the change) and the working tree over the
// same cold archives, and requires identical plan reports, identical resulting
// state, identical on-disk bytes and an identical repeated compaction. A row
// shape is only covered if the run actually takes the corresponding decision, so
// the corpus asserts non-trivial retirement, consolidation, aggregation,
// accumulator growth and accumulator-guard outcomes before comparing.
//
// The plan's ownership of its output is not asserted here: every public read
// (`history`, `snapshot`, `fullSnapshot`) clones, so a black-box test cannot
// observe whether a live row object was borrowed. That claim rests on
// `#mergeArchived(..., { copy: true })` always cloning, on `mergeKnowledgeEntry`
// being pure with respect to its previous entry, and on nothing reading
// `plan.histories`; it is argued in `docs/performance/retention-plan-cost.md`.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { EvolutionMemory } from "../../lib/dockyard-domain/memory.js";
import { mergeKnowledgeEntry, normalizeKnowledgeEvent } from "../../lib/dockyard-domain/knowledge.js";
import { JsonStateStore } from "./support.js";
import { archiveIndexBaseline } from "./archive-index-baseline.js";

const NOW = "2026-10-12T00:00:00.000Z";
const AT = "2026-10-10T00:00:00.000Z";
const WORKING_MEMORY = fileURLToPath(new URL("../../lib/dockyard-domain/memory.js", import.meta.url));

/** Load a copy of memory.js whose relative imports point at this tree. */
async function importMemorySource(source, label) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-retention-baseline-"));
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

const baseline = await archiveIndexBaseline();
const BaselineMemory = await importMemorySource(baseline.source, "the derived pre-change baseline");

// ---------------------------------------------------------------------------
// Cold corpus. Every collection below is written as a real archive file, so the
// plan reads the same bytes `load()` indexed and `compact()` rewrites; a few
// rows are also written into the state file so both the hot and the archived
// half of `#mergeArchived()` take part.
// ---------------------------------------------------------------------------

/** A source row with real dimensions; its identity is a hash of them. */
function seedSource(index) {
  return {
    id: `seed-${index}`,
    issueType: "performance",
    rootCause: `root-cause-${index}`,
    strategy: "bounded retry",
    componentId: `plugin:seed-${index}`,
    status: "success",
    recordedAt: AT,
    metrics: { latency: index % 5 + 1 },
  };
}

/** The identity `seedSource(index)` and any replay of it normalize to. */
function seedKey(index) {
  return normalizeKnowledgeEvent(seedSource(index), { sourceCollection: "observations", now: new Date(AT) }).knowledgeKey;
}

/**
 * An accumulator row in the exact shape `mergeKnowledgeEntry` produces.
 * `sourceRefs: []` is the shape the merge guard short-circuits on.
 */
function knowledgeRow(index, { sourceRefs }) {
  const event = normalizeKnowledgeEvent(seedSource(index), { sourceCollection: "observations", now: new Date(AT) });
  return { ...mergeKnowledgeEntry(null, event, { now: new Date(AT) }), sourceRefs, dimensions: event.dimensions };
}

/** A second source row with the same dimensions: the same accumulator key. */
function replayObservation(index) {
  return { ...seedSource(index), id: `replay-${index}`, sourceRefs: undefined };
}

/** A consolidatable healthy observation (component/observation, info). */
function infoObservation(index, component = index % 4) {
  return {
    id: `obs-${index}`,
    type: "component/observation",
    severity: "info",
    componentId: `component-${component}`,
    patternKey: `pattern-${component}`,
    observedAt: AT,
    recordedAt: AT,
    message: `heartbeat ${index}`,
    metrics: { latency: index },
  };
}

/** An error observation: knowledge-bearing and never folded away. */
function errorObservation(index) {
  return {
    id: `error-obs-${index}`,
    type: "component/observation",
    severity: "error",
    componentId: `component-${index}`,
    problem: `failure-${index}`,
    rootCause: `root-cause-${index % 6}`,
    errorCode: `E${index}`,
    observedAt: AT,
    recordedAt: AT,
    message: `error ${index}`,
  };
}

/** A row with no knowledge identity at all: retained, never grouped. */
function opaqueRow(index) {
  return { id: `opaque-${index}`, note: `no identity ${index}`, recordedAt: AT };
}

function observedCycle(index, { meaningful = false, bearing = false } = {}) {
  return {
    id: `cycle-${index}`,
    lifecycleState: "OBSERVED",
    status: "observed",
    observedAt: AT,
    recordedAt: AT,
    stages: meaningful ? [{ stage: "measurement" }] : [{ stage: "collect" }],
    ...(bearing ? { problem: `cycle problem ${index}`, rootCause: `cycle root cause ${index}` } : {}),
  };
}

function terminalOutcome(index) {
  return { id: `outcome-${index}`, status: "rejected", lifecycleState: "REJECTED", signature: `sig-${index}`, rootCause: `root-cause-${index}`, recordedAt: AT, lastSeenAt: AT };
}

function terminalPromotion(index) {
  return { id: `promotion-${index}`, status: "rolled_back", lifecycleState: "ROLLED_BACK", capabilityId: `capability-${index}`, recordedAt: AT };
}

function corpus() {
  return {
    // 0 and 1 exist to drive the merge guard in both directions: 0 covers no
    // reference of its replay, 1 has no sourceRefs at all.
    knowledge: [
      knowledgeRow(0, { sourceRefs: [`observations:seed-0`] }),
      knowledgeRow(1, { sourceRefs: [] }),
      ...Array.from({ length: 4 }, (_, index) => knowledgeRow(index + 2, { sourceRefs: [] })),
    ],
    observations: [
      ...Array.from({ length: 12 }, (_, index) => infoObservation(index, index % 3)),
      ...Array.from({ length: 4 }, (_, index) => errorObservation(index)),
      replayObservation(0),
      replayObservation(1),
      ...Array.from({ length: 2 }, (_, index) => opaqueRow(index)),
    ],
    // 99 is knowledge-bearing with a meaningful stage: it enters a retention
    // group under the `cycles` collection, whose limit is unbounded.
    cycles: [...Array.from({ length: 6 }, (_, index) => observedCycle(index)), observedCycle(99, { meaningful: true, bearing: true })],
    outcomes: Array.from({ length: 6 }, (_, index) => terminalOutcome(index)),
    promotions: Array.from({ length: 4 }, (_, index) => terminalPromotion(index)),
    lineage: [
      { id: "lineage-1", lineageId: "lineage-1", generation: 1, capability: "capability-1", recordedAt: AT },
      { id: "lineage-2", lineageId: "lineage-2", generation: 2, capability: "capability-2", recordedAt: AT },
    ],
    candidates: [
      { id: "candidate-1", problem: "candidate problem", status: "proposed", lifecycleState: "PROPOSED", recordedAt: AT },
      { id: "candidate-2", problem: "candidate problem", status: "promoted", lifecycleState: "PROMOTED", recordedAt: AT },
    ],
  };
}

/** The rows that start in the state file instead of the archive. */
function hotRows(rows) {
  return { observations: rows.observations.slice(0, 2), knowledge: rows.knowledge.slice(0, 1) };
}

async function seed(home, rows) {
  const store = new JsonStateStore({ home });
  await mkdir(dirname(store.filePath), { recursive: true });
  await store.save({ evolution: hotRows(rows) });
  for (const [collection, entries] of Object.entries(rows)) {
    const file = collection === "cycles" ? `${store.filePath}.cycles-archive.jsonl` : `${store.filePath}.${collection}-archive.jsonl`;
    await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  }
  return store;
}

async function diskDigests(home, relative = "") {
  const digests = {};
  for (const entry of await readdir(join(home, relative), { withFileTypes: true })) {
    const name = join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(digests, await diskDigests(home, name));
    else digests[name] = createHash("sha256").update(await readFile(join(home, name))).digest("hex");
  }
  return Object.fromEntries(Object.entries(digests).sort(([left], [right]) => left.localeCompare(right)));
}

function newMemory(MemoryClass, store) {
  const memory = new MemoryClass({
    stateStore: store, clock: () => new Date(NOW), maxEntries: 1000,
    hotEntries: 3, hotCycles: 2, archiveMaxBytes: 4096,
  });
  memory.setMutationAuthority({ assertMutation() {}, isActive: () => true });
  return memory;
}

/** Drive one implementation over the corpus and record everything observable. */
async function runSide(MemoryClass, home) {
  // The same home is reused for both sides, so it starts from exactly the
  // corpus bytes every time: a side's own compacted archives, index document
  // and sealed segments must not be visible to the next side.
  await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true });
  const store = await seed(home, corpus());
  const memory = newMemory(MemoryClass, store);
  await memory.load();
  const dryRun = await memory.compact({ dryRun: true });
  const first = await memory.compact();
  const firstState = JSON.stringify(memory.fullSnapshot());
  const firstBytes = await diskDigests(home);
  const second = await memory.compact();
  const secondState = JSON.stringify(memory.fullSnapshot());
  const secondBytes = await diskDigests(home);
  return { dryRun, first, second, firstState, firstBytes, secondState, secondBytes };
}

/** In-memory state port: no file path, so the memory has no archive tier. */
class InMemoryStore {
  constructor(state) { this.state = state; }
  async load() { return structuredClone(this.state); }
  async update(change) { this.state = await change(structuredClone(this.state)); }
}

test("the retention plan and its compaction are byte-identical to the pre-change baseline", async (t) => {
  // Both sides run in the same home path, wiped between runs: the resulting
  // state records the archive paths it owns, so two directories would differ
  // for a reason that is not the retention plan.
  const home = await mkdtemp(join(tmpdir(), "dsh-retention-differential-"));
  try {
    const before = await runSide(BaselineMemory, home);
    const after = await runSide(EvolutionMemory, home);

    // The corpus must actually decide something, or an accidental no-op plan
    // would compare equal for the wrong reason.
    assert.ok(before.first.retired > 0, "terminal rows must be retired");
    assert.ok(before.first.consolidated > 0, "consolidatable rows must be consolidated");
    assert.ok(before.first.aggregatedObservations > 0, "repeated observations must be aggregated");
    assert.ok(before.first.knowledgeAfter > before.first.knowledgeBefore, "keyed source rows must grow the accumulator");
    assert.ok(before.first.tombstones > 0, "retirement must record tombstones");
    assert.ok(Object.keys(before.firstBytes).some((name) => name.includes(".segments/segment-")), "the corpus must seal at least one segment");

    // ...and both directions of the accumulator guard must have been taken: the
    // replay of seed-0 is absorbed, the replay of seed-1 is not.
    const knowledge = JSON.parse(after.firstState).knowledge;
    const byKey = new Map(knowledge.map((row) => [row.knowledgeKey, row]));
    assert.equal(byKey.get(seedKey(0))?.count, 2, "a replay must merge into an accumulator that does not cover its reference");
    assert.equal(byKey.get(seedKey(1))?.count, 1, "an accumulator with no sourceRefs must not absorb a replay");

    assert.deepEqual(after.dryRun, before.dryRun, "the dry-run report must be identical");
    assert.deepEqual(after.first, before.first, "the compaction report must be identical");
    assert.deepEqual(after.second, before.second, "the repeated compaction report must be identical");
    assert.equal(after.firstState, before.firstState, "the resulting state must be byte-identical");
    assert.deepEqual(after.firstBytes, before.firstBytes, "every state, index and archive file must be byte-identical");
    assert.equal(after.secondState, before.secondState, "the second compaction must leave the same state");
    assert.deepEqual(after.secondBytes, before.secondBytes, "the second compaction must leave the same bytes");
    t.diagnostic(`retired ${before.first.retired}, consolidated ${before.first.consolidated}, aggregated ${before.first.aggregatedObservations}, knowledge ${before.first.knowledgeBefore}->${before.first.knowledgeAfter}, ${Object.keys(before.firstBytes).length} files`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the same plan is byte-identical without an archive tier", async (t) => {
  // No file path means no archive: the plan runs over the in-memory partition
  // only, which is the other half of every retention decision.
  const rows = corpus();
  const side = async (MemoryClass) => {
    const memory = newMemory(MemoryClass, new InMemoryStore({ evolution: rows }));
    await memory.load();
    const dryRun = await memory.compact({ dryRun: true });
    const first = await memory.compact();
    const state = JSON.stringify(memory.fullSnapshot());
    const second = await memory.compact();
    return { dryRun, first, second, state, secondState: JSON.stringify(memory.fullSnapshot()) };
  };
  const before = await side(BaselineMemory);
  const after = await side(EvolutionMemory);
  assert.ok(before.first.retired > 0, "the in-memory corpus must still retire");
  assert.deepEqual(after.dryRun, before.dryRun, "the in-memory dry-run report must be identical");
  assert.deepEqual(after.first, before.first, "the in-memory report must be identical");
  assert.equal(after.state, before.state, "the in-memory state must be byte-identical");
  assert.deepEqual(after.second, before.second, "the in-memory repeated report must be identical");
  assert.equal(after.secondState, before.secondState, "the in-memory second compaction must leave the same state");
  t.diagnostic(`in-memory: retired ${before.first.retired}, consolidated ${before.first.consolidated}, knowledge ${before.first.knowledgeBefore}->${before.first.knowledgeAfter}`);
});

test("repeated compaction converges to a fixed point", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-retention-idempotent-"));
  try {
    const store = await seed(home, corpus());
    const memory = newMemory(EvolutionMemory, store);
    await memory.load();
    await memory.compact();

    // Compaction folds repeated observations into aggregate rows, and an
    // aggregate is itself knowledge-bearing with an identity of its own, so the
    // accumulator reaches its fixed point on the pass after the aggregate is
    // written. What must not happen is unbounded growth: the third pass must
    // change neither the state nor the bytes.
    await memory.compact();
    const settled = JSON.stringify(memory.fullSnapshot());
    const settledBytes = await diskDigests(home);
    const third = await memory.compact();
    assert.equal(JSON.stringify(memory.fullSnapshot()), settled, "compaction must converge to a fixed point");
    assert.deepEqual(await diskDigests(home), settledBytes, "the converged point must also hold on disk");
    assert.equal(third.knowledgeAfter, third.knowledgeBefore, "the converged accumulator must stop growing");
    t.diagnostic(`compaction converged: knowledge ${third.knowledgeBefore}, retired ${third.retired}, consolidated ${third.consolidated}`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The clock contract.
//
// The plan reads the clock once per source row in the pass that normalizes the
// row and once per source row in the classification loop, and it derives each
// knowledge record's `firstSeen`/`lastSeen`/`recentEvidence[].at` from the read
// that belongs to its own row. The pre-change plan additionally walked every
// source row a third time, and that pass is the one this change folds away, so
// its clock read is the only one that disappears. One read per source row is
// therefore the entire, exact bound of what moved:
//
// - a plan started from the same clock position derives every knowledge record
//   timestamp exactly as the pre-change plan did;
// - every clock read after the plan - the write-time stamps of the archive index
//   document, and a later plan's own derived stamps in the same process - sees
//   the value the removed reads would have consumed;
// - the retention decisions, the knowledge identities, the archive record bytes
//   and the set of files written do not move at all.
//
// Under a real clock the second point is simply the time the removed row walk
// used to take; it is only observable at all with a clock that advances per
// call. It is pinned here so that a future change cannot widen it silently,
// because it cannot be removed without walking the rows again for no purpose.

/**
 * A source row with knowledge dimensions but no timestamp of its own, so its
 * derived stamp is exactly the clock value the plan read while normalizing it.
 * Five of them, walked in order, make a collapsed or shortened clock sequence
 * visible as a repeated or shifted timestamp.
 */
function timelessSource(index) {
  return {
    id: `timeless-${index}`,
    issueType: "performance",
    rootCause: `timeless root cause ${index}`,
    strategy: "bounded retry",
    componentId: `plugin:timeless-${index}`,
    status: "success",
    metrics: { latency: index + 1 },
  };
}

const TIMELESS_COUNT = 5;

/** The accumulator identity `timelessSource(index)` normalizes to. */
function timelessKey(index) {
  return normalizeKnowledgeEvent(timelessSource(index), { sourceCollection: "observations", now: new Date(AT) }).knowledgeKey;
}

function clockCorpus() {
  const rows = corpus();
  rows.observations = [...rows.observations, ...Array.from({ length: TIMELESS_COUNT }, (_, index) => timelessSource(index))];
  return rows;
}

const INDEX_SUFFIX = ".evolution-archive-index.json";

/**
 * Drive a dry run and a full compaction with a per-call advancing clock.
 * `resetPerPlan` restarts the clock before each plan, which is the "same clock
 * position" case; without it the two plans share one advancing clock, which is
 * the "later plan in the same process" case.
 */
async function clockSide(MemoryClass, home, rows, { resetPerPlan }) {
  // The same home is reused for both sides, so each side starts from the corpus
  // bytes and neither side's compacted archives are visible to the other.
  await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true });
  const store = await seed(home, rows);
  let ticks = 0;
  const memory = new MemoryClass({
    stateStore: store, clock: () => new Date(Date.parse(NOW) + (ticks += 1) * 1000),
    maxEntries: 1000, hotEntries: 3, hotCycles: 2, archiveMaxBytes: 4096,
  });
  memory.setMutationAuthority({ assertMutation() {}, isActive: () => true });
  await memory.load();
  // Only the plan's own reads are counted: load() and the fixture are the same
  // on both sides.
  if (resetPerPlan) ticks = 0;
  const beforeDryRun = ticks;
  const dryRun = await memory.compact({ dryRun: true });
  const dryRunClockReads = ticks - beforeDryRun;
  if (resetPerPlan) ticks = 0;
  const beforeCompact = ticks;
  const first = await memory.compact();
  const compactClockReads = ticks - beforeCompact;
  const indexDocument = JSON.parse(await readFile(`${store.filePath}${INDEX_SUFFIX}`, "utf8"));
  return { dryRun, first, dryRunClockReads, compactClockReads, indexDocument, knowledge: memory.fullSnapshot().knowledge, bytes: await diskDigests(home) };
}

/** The index document's shape with only its wall-clock stamps removed. */
function withoutWallClockStamps(document) {
  return {
    ...document,
    updatedAt: null,
    segments: (document.segments ?? []).map((segment) => ({ ...segment, updatedAt: null })),
  };
}

test("the plan's clock contract: one read per source row per reader, and only the clock position moves", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-retention-clock-"));
  try {
    // Same clock position for each plan on both sides: nothing but the read
    // count may differ.
    const before = await clockSide(BaselineMemory, home, clockCorpus(), { resetPerPlan: true });
    const after = await clockSide(EvolutionMemory, home, clockCorpus(), { resetPerPlan: true });

    // The dry run reports exactly the rows the plan walked, so the number of
    // clock reads the change removed is knowable from the plan itself.
    const walked = Object.entries(before.dryRun.before)
      .filter(([collection]) => collection !== "knowledge")
      .reduce((sum, [, count]) => sum + count, 0);
    assert.ok(walked > 20, "the corpus must walk a non-trivial number of source rows");
    assert.equal(before.dryRunClockReads - after.dryRunClockReads, walked,
      "exactly the folded sweep's one clock read per source row may disappear");
    assert.ok(after.dryRunClockReads > walked, "the plan must still read the clock per row in both remaining passes");
    assert.equal(before.compactClockReads - after.compactClockReads, walked,
      "the write phase must read the clock exactly as often as before");

    // Both sides keep the same decisions and the same derived timestamps. The
    // timeless rows are stamped by their own read, so a collapsed or shared
    // read would move them.
    assert.deepEqual(after.dryRun, before.dryRun, "the dry-run report must be identical under an advancing clock");
    assert.deepEqual(after.first, before.first, "the compaction report must be identical under an advancing clock");
    assert.deepEqual(after.knowledge, before.knowledge, "every knowledge record, timestamp included, must be identical");
    const firstSeen = new Map(after.knowledge.map((row) => [row.knowledgeKey, row.firstSeen]));
    const timelessStamps = Array.from({ length: TIMELESS_COUNT }, (_, index) => firstSeen.get(timelessKey(index)));
    assert.ok(timelessStamps.every((value) => typeof value === "string"), "every timeless row must reach the accumulator table");
    assert.equal(new Set(timelessStamps).size, TIMELESS_COUNT,
      "each timeless row must be stamped by the clock read of its own row");
    assert.ok(timelessStamps.every((value) => value !== NOW), "the stamp must come from the advancing clock, not the fixture time");

    // Every persisted file but the index is byte-identical. The index differs
    // only in its wall-clock stamps, and by exactly the removed reads.
    assert.deepEqual(Object.keys(after.bytes).sort(), Object.keys(before.bytes).sort(), "both sides must write the same files");
    for (const [name, digest] of Object.entries(before.bytes)) {
      if (name.endsWith(INDEX_SUFFIX)) continue;
      assert.equal(after.bytes[name], digest, `${name} must be byte-identical under an advancing clock`);
    }
    const indexName = Object.keys(before.bytes).find((name) => name.endsWith(INDEX_SUFFIX));
    assert.ok(indexName, "the corpus must write an archive index document");
    assert.notEqual(after.bytes[indexName], before.bytes[indexName], "the index is the one file a wall-clock stamp moves");
    assert.deepEqual(withoutWallClockStamps(after.indexDocument), withoutWallClockStamps(before.indexDocument),
      "the index must differ in nothing but its wall-clock stamps");
    assert.equal(Date.parse(before.indexDocument.updatedAt) - Date.parse(after.indexDocument.updatedAt), walked * 1000,
      "the index stamp must move by exactly the folded reads and nothing else");

    // A later plan in the same process, sharing one advancing clock: the dry run
    // no longer consumes the folded read, so the plan that persists sees the
    // clock exactly that much earlier - and nothing else moves.
    const sharedBefore = await clockSide(BaselineMemory, home, clockCorpus(), { resetPerPlan: false });
    const sharedAfter = await clockSide(EvolutionMemory, home, clockCorpus(), { resetPerPlan: false });
    assert.deepEqual(sharedAfter.first, sharedBefore.first, "the second plan's decisions must still be identical");
    const sharedShiftMs = (sharedBefore.dryRunClockReads - sharedAfter.dryRunClockReads) * 1000;
    assert.equal(sharedShiftMs, walked * 1000, "the shared-clock shift must be the earlier plan's removed reads");
    // Only a row whose stamp comes from the clock may move; a row that carries
    // its own fixture timestamp may not, and nothing but a stamp may move at all.
    // A later plan in this process sees the clock earlier than the baseline by
    // the reads the earlier plan no longer made, so the candidate's row is
    // compared after moving those stamps *forward* into the baseline's frame.
    // The whole row is compared, so no field is hidden behind a projection.
    const shiftStamps = (row, ms) => {
      const shift = (value) => (typeof value === "string" && Number.isFinite(Date.parse(value))
        ? new Date(Date.parse(value) + ms).toISOString() : value);
      const shiftList = (items) => (items ?? []).map((item) => ({ ...item, at: shift(item.at) }));
      return {
        ...row,
        firstSeen: shift(row.firstSeen),
        lastSeen: shift(row.lastSeen),
        updatedAt: shift(row.updatedAt),
        ...(Object.hasOwn(row, "lastCorrectionAt") ? { lastCorrectionAt: shift(row.lastCorrectionAt) } : {}),
        ...(Object.hasOwn(row, "recentEvidence") ? { recentEvidence: shiftList(row.recentEvidence) } : {}),
        ...(Object.hasOwn(row, "trend") ? { trend: { ...row.trend, recent: shiftList(row.trend.recent) } } : {}),
      };
    };
    const earlier = new Map(sharedBefore.knowledge.map((row) => [row.knowledgeKey, row]));
    const movedKeys = [];
    for (const row of sharedAfter.knowledge) {
      const previous = earlier.get(row.knowledgeKey);
      assert.ok(previous, `${row.knowledgeKey} must exist on the baseline too`);
      if (isDeepStrictEqual(row, previous)) continue;
      movedKeys.push(row.knowledgeKey);
      assert.deepEqual(shiftStamps(row, sharedShiftMs), previous,
        "a later plan may differ only in clock-derived stamps, and only by the removed reads");
    }
    assert.deepEqual(movedKeys.sort(), Array.from({ length: TIMELESS_COUNT }, (_, index) => timelessKey(index)).sort(),
      "exactly the rows without a timestamp of their own may move");
    t.diagnostic(`walked ${walked} source rows: reads ${before.dryRunClockReads}->${after.dryRunClockReads} (dry run), index stamp and later clock-derived stamps move ${walked * 1000}ms`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
