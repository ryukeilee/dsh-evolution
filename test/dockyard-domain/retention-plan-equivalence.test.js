// Differential equivalence for the knowledge/retention plan and the compaction
// it drives.
//
// The working tree normalizes each source row once per plan, reuses the plan's
// own copy of a knowledge row, and collects non-knowledge-bearing rows in the
// pass that already visited them. This test drives the guarded pre-change
// implementation (`archiveIndexBaseline()` reverses the change) and the working
// tree over the same cold archives, and requires identical plan reports,
// identical resulting state, identical on-disk bytes and an identical repeated
// compaction. A row shape is only covered if the run actually takes the
// corresponding decision, so the corpus asserts non-trivial retirement,
// consolidation, aggregation and accumulator growth before comparing.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { EvolutionMemory } from "../../lib/dockyard-domain/memory.js";
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
// plan reads the same bytes `load()` indexed and `compact()` rewrites.
// ---------------------------------------------------------------------------

/** An accumulator row in the exact shape `mergeKnowledgeEntry` produces. */
function knowledgeRow(index) {
  return {
    id: `knowledge:acc-${index}`,
    knowledgeKey: `knowledge:acc-${index}`,
    schema: 1,
    canonical: true,
    retention: "CANONICAL_KNOWLEDGE",
    state: "KNOWN",
    issueType: "problem",
    problemType: "problem",
    rootCause: `root-cause-${index}`,
    strategy: null,
    failureMode: null,
    semanticFact: `semantic-fact-${index}`,
    scope: `scope-${index % 3}`,
    dimensions: { issueType: "problem", rootCause: `root-cause-${index}`, strategy: null, failureMode: null, semanticFact: `semantic-fact-${index}`, scope: `scope-${index % 3}` },
    count: 2,
    occurrenceCount: 2,
    firstSeen: AT,
    lastSeen: AT,
    lastSourceCollection: "observations",
    lastOutcome: "failure",
    sourceCounts: { observations: 2 },
    sourceRefs: index % 2 === 0 ? [`obs:${index}`, `obs:${index + 100}`] : [],
    lineageRefs: [],
    relationRefs: [],
    eventIds: [],
    evidenceCount: 2,
    recentEvidence: [{ at: AT, note: `evidence-${index}` }],
    confidence: 0.4,
    effectStats: { successCount: 0, failureCount: 2, neutralCount: 0, regressionCount: 0, fitnessCount: 0, fitnessSum: 0, fitnessMean: null, bestFitness: null, worstFitness: null, successRate: 0, metrics: {} },
    effects: { successCount: 0, failureCount: 2 },
    successCount: 0,
    failureCount: 2,
    regressionCount: 0,
    contradicted: false,
    contradictionCount: 0,
    revision: 0,
    learned: false,
    updatedAt: AT,
  };
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

/** A source row that names an accumulator key and nothing else. */
function keyedObservation(index) {
  return { id: `keyed-obs-${index}`, knowledgeKey: `knowledge:acc-${index}`, observedAt: AT, recordedAt: AT, note: `keyed ${index}` };
}

/** A row with no knowledge identity at all: retained, never grouped. */
function opaqueRow(index) {
  return { id: `opaque-${index}`, note: `no identity ${index}`, recordedAt: AT };
}

function observedCycle(index, { meaningful = false } = {}) {
  return {
    id: `cycle-${index}`,
    lifecycleState: "OBSERVED",
    status: "observed",
    observedAt: AT,
    recordedAt: AT,
    stages: meaningful ? [{ stage: "measurement" }] : [{ stage: "collect" }],
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
    knowledge: Array.from({ length: 6 }, (_, index) => knowledgeRow(index)),
    observations: [
      ...Array.from({ length: 12 }, (_, index) => infoObservation(index, index % 3)),
      ...Array.from({ length: 4 }, (_, index) => errorObservation(index)),
      ...Array.from({ length: 4 }, (_, index) => keyedObservation(index)),
      ...Array.from({ length: 2 }, (_, index) => opaqueRow(index)),
    ],
    cycles: [...Array.from({ length: 6 }, (_, index) => observedCycle(index)), observedCycle(99, { meaningful: true })],
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

async function seed(home, rows) {
  const store = new JsonStateStore({ home });
  await mkdir(dirname(store.filePath), { recursive: true });
  await store.save({ evolution: {} });
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

/** Drive one implementation over the corpus and record everything observable. */
async function runSide(MemoryClass, home) {
  // The same home is reused for both sides, so it starts from exactly the
  // corpus bytes every time: a side's own compacted archives, index document
  // and sealed segments must not be visible to the next side.
  await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true });
  const store = await seed(home, corpus());
  const memory = new MemoryClass({
    stateStore: store, clock: () => new Date(NOW), maxEntries: 1000,
    hotEntries: 3, hotCycles: 2, archiveMaxBytes: 4096,
  });
  memory.setMutationAuthority({ assertMutation() {}, isActive: () => true });
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

test("repeated compaction converges to a fixed point and never aliases the pre-compaction records", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-retention-idempotent-"));
  try {
    const store = await seed(home, corpus());
    const memory = new EvolutionMemory({
      stateStore: store, clock: () => new Date(NOW), maxEntries: 1000,
      hotEntries: 3, hotCycles: 2, archiveMaxBytes: 4096,
    });
    memory.setMutationAuthority({ assertMutation() {}, isActive: () => true });
    await memory.load();
    const before = memory.fullSnapshot();
    await memory.compact();
    const after = memory.fullSnapshot();

    // The new live table must not be reachable from the pre-compaction table: a
    // plan that published a live row object instead of its own copy would make
    // these identities equal.
    for (const collection of Object.keys(before)) {
      const previous = before[collection];
      const current = after[collection];
      if (!Array.isArray(previous) || !Array.isArray(current)) continue;
      for (const entry of previous) {
        assert.ok(!current.includes(entry), `${collection}: compaction must not carry a pre-compaction object into the new state`);
      }
    }

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
