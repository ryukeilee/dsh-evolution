// Shared harness for the retention/compaction streaming verification.
//
// The baseline is not a hand-maintained copy of `lib/`: it is the implementation
// shipped in the released 0.2.1 artifact, extracted at test time and imported as
// a second, independent module instance. The historical tarball stays in
// `release/` after the pin moves on, and its bytes are checked against a fixed
// digest (the same anchor convention as `test/archive-row-window.test.mjs` uses
// for rc.16), so this differential keeps comparing the working tree against the
// release the task names instead of following the current pin.
//
// The corpus builder uses the *pinned* knowledge helpers (`mergeKnowledgeEntry` /
// `normalizeKnowledgeEvent`) so that fixture rows are shaped by the reference
// implementation. Both sides still run their own `knowledge.js` when they
// normalize a source row: the fixture is input bytes, not shared objects.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readTarEntries } from "../../scripts/release/release-lib.mjs";
import { JsonStateStore } from "./support.js";

export const AT = "2026-10-10T00:00:00.000Z";
export const NOW = "2026-10-12T00:00:00.000Z";
export const PINNED_VERSION = "0.2.1";
/** The released 0.2.1 artifact is retained in `release/` after the pin moves. */
const PINNED_ARTIFACT = `dsh-evolution-${PINNED_VERSION}.tgz`;
const PINNED_ARTIFACT_SHA256 = "b06f61d5a08fe4d6cd4da7b5203800ad393d92fc087b0a396b1b726655600764";
export const WORKING_MEMORY = fileURLToPath(new URL("../../lib/dockyard-domain/memory.js", import.meta.url));
const RELEASE_DIRECTORY = fileURLToPath(new URL("../../release/", import.meta.url));

let extraction = null;
let extractedDirectory = null;
const variantDirectories = new Set();

/** Extract the pinned artifact once per process and import both reference modules. */
export async function loadPinnedMemory() {
  if (extraction) return extraction;
  extraction = (async () => {
    const artifact = await readFile(join(RELEASE_DIRECTORY, PINNED_ARTIFACT));
    assert.equal(createHash("sha256").update(artifact).digest("hex"), PINNED_ARTIFACT_SHA256,
      "the retention differential anchor must retain the released 0.2.1 bytes");
    const entries = readTarEntries(artifact);
    assert.ok(entries.some((entry) => entry.path === "lib/dockyard-domain/memory.js"),
      "the pinned artifact must ship the memory implementation");
    const directory = await mkdtemp(join(tmpdir(), "dsh-retention-v021-"));
    extractedDirectory = directory;
    for (const entry of entries) {
      const target = join(directory, entry.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, entry.bytes, { mode: entry.mode });
    }
    const memory = await import(pathToFileURL(join(directory, "lib/dockyard-domain/memory.js")).href);
    const knowledge = await import(pathToFileURL(join(directory, "lib/dockyard-domain/knowledge.js")).href);
    assert.equal(typeof memory.EvolutionMemory, "function", "the pinned memory module must export EvolutionMemory");
    assert.equal(typeof knowledge.mergeKnowledgeEntry, "function", "the pinned knowledge module must export the merge");
    return { directory, EvolutionMemory: memory.EvolutionMemory, knowledge };
  })();
  return extraction;
}

// A crashed test must not leave a multi-hundred-file extraction behind.
process.once("exit", () => {
  if (extractedDirectory) rmSync(extractedDirectory, { recursive: true, force: true });
  for (const directory of variantDirectories) rmSync(directory, { recursive: true, force: true });
});

/** Clean up early; the process-exit hook is the safety net. */
export async function cleanupPinnedMemory() {
  const directories = [extractedDirectory, ...variantDirectories].filter(Boolean);
  extractedDirectory = null;
  variantDirectories.clear();
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
}

/**
 * Extract the pinned artifact again and import a modified `memory.js` from it.
 *
 * This exists only for the harness's negative control: the differential must
 * reject a seeded behavioral difference, otherwise a comparison that silently
 * stopped comparing would keep passing. The transform is applied to the pinned
 * bytes, never to the working tree.
 */
export async function importPinnedVariant(transform) {
  const artifact = await readFile(join(RELEASE_DIRECTORY, PINNED_ARTIFACT));
  const entries = readTarEntries(artifact);
  const directory = await mkdtemp(join(tmpdir(), "dsh-retention-variant-"));
  variantDirectories.add(directory);
  for (const entry of entries) {
    const target = join(directory, entry.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const bytes = entry.path === "lib/dockyard-domain/memory.js"
      ? Buffer.from(transform(entry.bytes.toString("utf8")), "utf8")
      : entry.bytes;
    await writeFile(target, bytes, { mode: entry.mode });
  }
  const module = await import(pathToFileURL(join(directory, "lib/dockyard-domain/memory.js")).href);
  assert.equal(typeof module.EvolutionMemory, "function", "a variant of the pinned memory module must still export EvolutionMemory");
  return module.EvolutionMemory;
}

/** Fixed clock: every read tells the same time. */
export function fixedClock(iso = NOW) {
  const state = { reads: 0 };
  return {
    reads: () => state.reads,
    reset: () => { state.reads = 0; },
    clock: () => { state.reads += 1; return new Date(iso); },
  };
}

/**
 * Per-call advancing clock: a collapsed, reordered or dropped read is visible as
 * a different clock position in whatever is written next.
 */
export function advancingClock({ start = NOW, stepMs = 1000 } = {}) {
  const state = { reads: 0 };
  return {
    reads: () => state.reads,
    reset: () => { state.reads = 0; },
    clock: () => { state.reads += 1; return new Date(Date.parse(start) + state.reads * stepMs); },
  };
}

// ---------------------------------------------------------------------------
// Corpus.
//
// Every decision below is reached by at least one fixture row, and the
// assertions in the equivalence test check that the baseline took it before the
// two sides are compared. `hotRows()` seeds a subset of rows into the state file
// so one plan visits both the hot and the archived half of every collection.
// ---------------------------------------------------------------------------

const pinned = await loadPinnedMemory();
const { mergeKnowledgeEntry, normalizeKnowledgeEvent } = pinned.knowledge;

/** A source row with real knowledge dimensions; its identity is a hash of them. */
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

/** An accumulator row in the exact shape `mergeKnowledgeEntry` produces. */
function knowledgeRow(index, { sourceRefs, eventId = null } = {}) {
  const source = eventId ? { ...seedSource(index), eventId } : seedSource(index);
  const event = normalizeKnowledgeEvent(source, { sourceCollection: "observations", now: new Date(AT) });
  return { ...mergeKnowledgeEntry(null, event, { now: new Date(AT) }), sourceRefs, dimensions: event.dimensions };
}

/** A second source row with the same dimensions: the same accumulator key. */
function replayObservation(index, { eventId = null } = {}) {
  return { ...seedSource(index), id: `replay-${index}`, ...(eventId ? { eventId } : {}), sourceRefs: undefined };
}

/** A consolidatable healthy observation (component/observation, info). */
function infoObservation(index, component = index % 3) {
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

/** An error observation: knowledge-bearing and individually addressable. */
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

/**
 * A knowledge-bearing row with no timestamp of its own. Its derived
 * `firstSeen`/`lastSeen`/`recentEvidence[].at` are exactly the clock value read
 * while this row is normalized, so a collapsed, reordered or extra read moves
 * them and the differential sees it.
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

/**
 * The standard shape corpus. It mixes:
 * - an accumulator seed whose `sourceRefs` covers a replay (the merge guard
 *   short-circuits) and one without `sourceRefs` (the guard cannot apply);
 * - an accumulator seed with a covered `eventId` window that a replay extends;
 * - repeated healthy observations that aggregate, error observations that stay
 *   addressable, and rows with no knowledge identity;
 * - a knowledge-bearing meaningful cycle and plain observed cycles;
 * - terminal outcome/promotion rows (retirement + tombstones);
 * - two strategies under one canonical key, so the plan derives a canonical
 *   winner and retires the superseded one with `replacedBy`;
 * - an opaque terminal row named by a persisted canonical record (protected from
 *   retirement), an opaque terminal row named by a `sourceRefs` reference
 *   (protected), and an unreferenced terminal row (retired);
 * - a lineage with a terminal latest generation (protected) and a terminal older
 *   generation (retired);
 * - duplicate terminal candidates, whose tombstones merge.
 */
export function standardCorpus() {
  return {
    knowledge: [
      knowledgeRow(0, { sourceRefs: ["observations:seed-0"] }),
      knowledgeRow(1, { sourceRefs: [] }),
      ...Array.from({ length: 4 }, (_, index) => knowledgeRow(index + 2, { sourceRefs: [] })),
      // The `sourceRefs` entry is deliberately not the replay's reference, so the
      // replay merges and both the reference window and the event id window grow.
      knowledgeRow(6, { sourceRefs: ["observations:not-covered"], eventId: "event:seed-6" }),
    ],
    observations: [
      ...Array.from({ length: 12 }, (_, index) => infoObservation(index, index % 3)),
      ...Array.from({ length: 4 }, (_, index) => errorObservation(index)),
      replayObservation(0),
      replayObservation(1),
      replayObservation(6, { eventId: "event:replay-6" }),
      ...Array.from({ length: 2 }, (_, index) => opaqueRow(index)),
      // Three rows whose derived knowledge timestamps come from the clock.
      ...Array.from({ length: 3 }, (_, index) => timelessSource(index)),
    ],
    // 99 is knowledge-bearing with a meaningful stage: it stays addressable while
    // the plain observed cycles consolidate.
    cycles: [...Array.from({ length: 6 }, (_, index) => observedCycle(index)), observedCycle(99, { meaningful: true, bearing: true })],
    outcomes: Array.from({ length: 6 }, (_, index) => terminalOutcome(index)),
    promotions: Array.from({ length: 4 }, (_, index) => terminalPromotion(index)),
    strategies: [
      { id: "strategy-old", capabilityId: "cap-x", lineageId: "lin-1", status: "SUPERSEDED", rootCause: "x", recordedAt: AT, fitnessScore: 1, stabilityVerified: true },
      { id: "strategy-new", capabilityId: "cap-x", lineageId: "lin-1", status: "promoted", rootCause: "x", recordedAt: AT, fitnessScore: 5, stabilityVerified: true },
    ],
    lineage: [
      { id: "lineage-old", lineageId: "lin-9", generation: 1, capability: "cap-z", status: "SUPERSEDED", recordedAt: AT },
      { id: "lineage-latest", lineageId: "lin-9", generation: 2, capability: "cap-z", status: "REJECTED", recordedAt: AT },
    ],
    gaps: [
      // Referenced by `ref-holder`'s sourceRefs: the reference protects it from
      // retirement even though it is terminal and carries no knowledge identity.
      { id: "protected-ref", lifecycleState: "REJECTED", note: "referenced terminal row", recordedAt: AT },
      { id: "ref-holder", sourceRefs: ["protected-ref"], note: "holds a reference", recordedAt: AT },
      { id: "terminal-opaque", lifecycleState: "REJECTED", note: "unreferenced terminal row", recordedAt: AT },
    ],
    diagnoses: [
      // Named by the persisted canonical table's recordId below: canonical
      // bookkeeping protects it from retirement.
      { id: "canonical-protected", lifecycleState: "REJECTED", note: "canonical records this id", recordedAt: AT },
    ],
    candidates: [
      { id: "candidate-1", problem: "candidate problem", status: "proposed", lifecycleState: "PROPOSED", recordedAt: AT },
      { id: "candidate-2", problem: "candidate problem", status: "promoted", lifecycleState: "PROMOTED", recordedAt: AT },
      // Same problem/root cause: both produce the same tombstone identity, so
      // `addTombstone()` has to merge them.
      { id: "candidate-dup-a", problem: "dup problem", rootCause: "dup cause", status: "REJECTED", lifecycleState: "REJECTED", recordedAt: AT },
      { id: "candidate-dup-b", problem: "dup problem", rootCause: "dup cause", status: "REJECTED", lifecycleState: "REJECTED", recordedAt: AT },
    ],
  };
}

/** The rows that start in the state file instead of the archive. */
export function hotRows(rows) {
  return {
    observations: rows.observations.slice(0, 2),
    knowledge: rows.knowledge.slice(0, 1),
    outcomes: rows.outcomes.slice(0, 1),
    strategies: rows.strategies.slice(0, 1),
  };
}

/** The state document: hot rows plus the persisted canonical pointer. */
export function stateDocument(rows) {
  return {
    evolution: {
      ...hotRows(rows),
      canonical: [{
        id: "canonical:persisted",
        state: "CANONICAL",
        lifecycleState: "CANONICAL",
        capability: "cap-canonical-protected",
        lineageId: null,
        sourceCollection: "diagnoses",
        recordId: "canonical-protected",
        fitnessScore: 1,
        updatedAt: AT,
      }],
    },
  };
}

/** Where one collection's cold rows are written. */
export function archiveFileFor(store, collection) {
  return `${store.filePath}.${collection}-archive.jsonl`;
}

/**
 * Write the corpus as a real state file plus one archive file per collection.
 * The archive files are what `load()` indexes and `compact()` rewrites; writing
 * only the state file would make the archive half of the plan a no-op.
 */
export async function seedCorpus(home, rows = standardCorpus(), { StoreClass = JsonStateStore } = {}) {
  await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true });
  const store = new StoreClass({ home });
  await mkdir(dirname(store.filePath), { recursive: true });
  await store.save(stateDocument(rows));
  for (const [collection, entries] of Object.entries(rows)) {
    await writeFile(archiveFileFor(store, collection), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  }
  return store;
}

// ---------------------------------------------------------------------------
// Observables.
// ---------------------------------------------------------------------------

/** Recursive sha256 of every file under `home`, sorted by relative name. */
export async function diskDigests(home, relative = "") {
  const digests = {};
  for (const entry of await readdir(join(home, relative), { withFileTypes: true })) {
    const name = join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(digests, await diskDigests(home, name));
    else digests[name] = createHash("sha256").update(await readFile(join(home, name))).digest("hex");
  }
  return Object.fromEntries(Object.entries(digests).sort(([left], [right]) => left.localeCompare(right)));
}

/** File names only, for growth/no-write checks. */
export async function diskListing(home, relative = "") {
  const names = [];
  for (const entry of await readdir(join(home, relative), { withFileTypes: true })) {
    const name = join(relative, entry.name);
    if (entry.isDirectory()) names.push(...await diskListing(home, name));
    else names.push(name);
  }
  return names.sort();
}

/** The error surface a differential can compare: code and message, nothing thrown. */
export function errorShape(error) {
  // A failed rewrite can name a temporary path carrying a fresh random token;
  // the token is not part of the behaviour, so it is normalized out.
  const message = String(error?.message ?? error)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>");
  return {
    name: error?.name ?? null,
    code: error?.code ?? null,
    message,
    rollbackErrorCode: error?.rollbackError?.code ?? null,
  };
}

/** A compact identity for a full snapshot projection. */
export function stateDigest(snapshot) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export function createMemory(MemoryClass, store, { clock = fixedClock().clock, options = {} } = {}) {
  const memory = new MemoryClass({
    stateStore: store,
    clock,
    maxEntries: 1000,
    hotEntries: 3,
    hotCycles: 2,
    archiveMaxBytes: 4096,
    ...options,
  });
  memory.setMutationAuthority({ assertMutation() {}, isActive: () => true });
  return memory;
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

/** Every read surface the plan can influence, in a JSON-comparable projection. */
export function readSurfaces(memory) {
  const snapshot = memory.fullSnapshot();
  const collections = Object.keys(snapshot).filter((key) => Array.isArray(snapshot[key]) && key !== "canonical");
  return {
    snapshot,
    histories: Object.fromEntries(collections.map((collection) => [collection, memory.history(collection)])),
    hotHistories: Object.fromEntries(collections.map((collection) => [collection, memory.history(collection, { includeArchived: false })])),
    windows: {
      observations: memory.historyWindow("observations", 5),
      knowledge: memory.historyWindow("knowledge", 5),
    },
    scans: {
      observations: scanSurface(memory, "observations"),
      knowledge: scanSurface(memory, "knowledge"),
    },
    similar: memory.findSimilar("root-cause-1"),
    strategies: memory.findSimilarStrategies({ problem: "failure-1", hypothesis: "bounded retry" }),
    canonical: memory.canonicalSnapshot(),
    stats: memory.stats(),
  };
}

/** A store whose `update` can be made to fail once, on demand. */
export class InjectableStore extends JsonStateStore {
  constructor(options) {
    super(options);
    this.updateCalls = 0;
    this.saveCalls = 0;
    this.failNextUpdate = null;
  }

  async update(change) {
    this.updateCalls += 1;
    if (this.failNextUpdate) {
      const failure = this.failNextUpdate;
      this.failNextUpdate = null;
      throw failure;
    }
    return super.update(change);
  }

  async save(state) {
    this.saveCalls += 1;
    return super.save(state);
  }
}

/** An in-memory store: no file path, so the memory has no archive tier. */
export class InMemoryStore {
  constructor(state) { this.state = state; }
  async load() { return structuredClone(this.state); }
  async update(change) {
    this.state = await change(structuredClone(this.state));
  }
}

// ---------------------------------------------------------------------------
// The standard differential run.
// ---------------------------------------------------------------------------

/**
 * Drive one implementation over the standard corpus and record every observable
 * the streaming change must preserve:
 *
 * - the dry-run report and the disk bytes before/after it (dry runs write nothing);
 * - three real compactions: report, full state projection, per-file sha256;
 * - the clock read count of each phase (a read that moves must show up here);
 * - a fresh instance loading the same home afterwards, with every read surface.
 *
 * The home directory is wiped first, so both sides start from exactly the corpus
 * bytes and neither side's compacted archives are visible to the other.
 */
export async function runStandardSide(MemoryClass, { home, rows = standardCorpus(), clock = null, StoreClass = JsonStateStore } = {}) {
  const readings = clock ?? fixedClock();
  await seedCorpus(home, rows, { StoreClass });
  const memory = createMemory(MemoryClass, new StoreClass({ home }), { clock: readings.clock });
  const mark = () => readings.reads();
  const since = (start) => readings.reads() - start;

  let start = mark();
  await memory.load();
  const loadReads = since(start);
  const bytesBeforeDryRun = await diskDigests(home);

  start = mark();
  const dryRun = await memory.compact({ dryRun: true });
  const dryRunReads = since(start);
  const bytesAfterDryRun = await diskDigests(home);

  start = mark();
  const first = await memory.compact();
  const firstReads = since(start);
  const firstState = JSON.stringify(memory.fullSnapshot());
  const firstBytes = await diskDigests(home);

  start = mark();
  const second = await memory.compact();
  const secondReads = since(start);
  const secondState = JSON.stringify(memory.fullSnapshot());
  const secondBytes = await diskDigests(home);

  start = mark();
  const third = await memory.compact();
  const thirdReads = since(start);
  const thirdState = JSON.stringify(memory.fullSnapshot());
  const thirdBytes = await diskDigests(home);

  // Restart recovery: a new instance over the same durable tree must read back
  // everything the compacted instance reports.
  start = mark();
  const restarted = createMemory(MemoryClass, new StoreClass({ home }), { clock: readings.clock });
  await restarted.load();
  const restartLoadReads = since(start);
  const restartSurfaces = readSurfaces(restarted);
  const restartBytes = await diskDigests(home);

  return {
    dryRun, first, second, third,
    firstState, secondState, thirdState,
    firstBytes, secondBytes, thirdBytes,
    bytesBeforeDryRun, bytesAfterDryRun,
    clockReads: { load: loadReads, dryRun: dryRunReads, first: firstReads, second: secondReads, third: thirdReads, restartLoad: restartLoadReads },
    restartSurfaces, restartBytes,
  };
}

/**
 * The same compaction contract without an archive tier.
 *
 * An in-memory store has no `filePath`, so `EvolutionMemory` keeps its
 * historical `maxEntries` behaviour: the plan runs over the in-memory partition
 * only. That is the other branch of every retention decision and of the
 * compaction write-back, and it must move identically.
 */
export async function runInMemorySide(MemoryClass, { rows = standardCorpus(), clock = null } = {}) {
  const readings = clock ?? fixedClock();
  const store = new InMemoryStore({ evolution: rows });
  const memory = createMemory(MemoryClass, store, { clock: readings.clock });
  const since = (start) => readings.reads() - start;

  let start = readings.reads();
  await memory.load();
  const loadReads = since(start);
  start = readings.reads();
  const dryRun = await memory.compact({ dryRun: true });
  const dryRunReads = since(start);
  start = readings.reads();
  const first = await memory.compact();
  const firstReads = since(start);
  const firstState = JSON.stringify(memory.fullSnapshot());
  start = readings.reads();
  const second = await memory.compact();
  const secondReads = since(start);
  const secondState = JSON.stringify(memory.fullSnapshot());
  const surfaces = readSurfaces(memory);
  return {
    dryRun, first, second, firstState, secondState, surfaces,
    clockReads: { load: loadReads, dryRun: dryRunReads, first: firstReads, second: secondReads },
  };
}
