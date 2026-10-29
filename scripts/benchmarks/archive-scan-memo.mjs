// Public-path benchmark for the active-archive reconcile that every staged
// domain mutation performs twice: once over the hard-linked mirror of the live
// tree and once over the committed tree.
//
// The measured unit is exactly the port's own sequence: `mirrorArchives()` the
// live tree (the same hard links `mutate()` creates), then build the memory
// instance over the mirror and `load()` it, which is where
// `#reconcileArchiveIndex()` scans every active archive. The first `load()` of
// the live tree is measured as the control: it always has to read the bytes.
//
// The baseline is the pinned release artifact extracted into a temporary
// directory and imported as-is, so the comparison is against the released
// implementation rather than a re-implementation. Every round recreates the
// fixture, and every side asserts the other's index document, active keys and
// archive bytes are identical before its timings are reported.
//
// The deterministic metric is the number of active-archive lines parsed by the
// scan helpers: the pre-change implementation re-parses all of them on the
// mirrored load, the working tree parses none because it already scanned those
// exact bytes in this process.
//
//   node scripts/benchmarks/archive-scan-memo.mjs [--rows N] [--knowledge-rows N]
//     [--rounds N] [--warmup N] [--samples N] [--retained] [--json]
//
// `--retained` additionally measures what the memo still holds after the
// instance that produced its records is gone; it needs `--expose-gc`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { mirrorArchives } from "../../lib/archive-stage.js";
import { JsonStateStore } from "../../test/dockyard-domain/support.js";
import { readReleaseManifest, releaseArtifactPath, REPO_ROOT } from "../release/release-lib.mjs";

const FROZEN_NOW = Date.parse("2026-10-12T00:00:00.000Z");
const NOW = new Date(FROZEN_NOW).toISOString();

function parseArgs(argv) {
  const options = { rows: 10000, knowledgeRows: 10000, rounds: 3, warmup: 1, samples: 5, json: false, retained: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--json") { options.json = true; continue; }
    if (key === "--retained") { options.retained = true; continue; }
    const value = Number(argv[index + 1]);
    index += 1;
    if (key === "--rows") options.rows = value;
    else if (key === "--knowledge-rows") options.knowledgeRows = value;
    else if (key === "--rounds") options.rounds = value;
    else if (key === "--warmup") options.warmup = value;
    else if (key === "--samples") options.samples = value;
    else throw new Error(`unknown option ${key}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

function freezeClock() {
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...value) { if (value.length === 0) super(FROZEN_NOW); else super(...value); }
    static now() { return FROZEN_NOW; }
  }
  Object.setPrototypeOf(FrozenDate, RealDate);
  globalThis.Date = FrozenDate;
  return () => { globalThis.Date = RealDate; };
}

async function loadBaseline() {
  const pin = readReleaseManifest();
  const directory = await mkdtemp(join(tmpdir(), "dsh-scan-memo-baseline-"));
  execFileSync("tar", ["-xzf", releaseArtifactPath(pin), "-C", directory, "package/lib"], { stdio: "ignore" });
  await symlink(join(REPO_ROOT, "node_modules"), join(directory, "package/node_modules"), "dir");
  const module = await import(pathToFileURL(join(directory, "package/lib/dockyard-domain/memory.js")).href);
  assert.equal(module.EvolutionMemory.name, "EvolutionMemory");
  return { pin, directory, Memory: module.EvolutionMemory };
}

function observationRow(index) {
  const scope = `plugin:module-${index}`;
  return {
    id: `obs-${index}`,
    knowledgeKey: `knowledge:${String(index).padStart(32, "b")}`,
    type: "tool/error", code: "HOST_OPERATION_FAILED", message: `official operation failed (${index})`,
    componentId: scope, severity: "error", status: "failed",
    problem: `${scope} warmup latency regression observed after a retry policy change`,
    target: scope, capabilityId: scope, metrics: { latency: 12 },
    recordedAt: new Date(Date.parse(NOW) - index * 3_600_000).toISOString(),
  };
}

function knowledgeRow(index) {
  const scope = `plugin:knowledge-${index}`;
  const seen = new Date(Date.parse(NOW) - index * 3_600_000).toISOString();
  const effectStats = { successCount: (index % 7) + 1, failureCount: index % 3, neutralCount: 0, regressionCount: 0, fitnessCount: 2, fitnessSum: 1.4, fitnessMean: 0.7, bestFitness: 0.8, worstFitness: 0.6, successRate: 0.6, metrics: {} };
  return {
    id: `key-${index}`,
    knowledgeKey: `knowledge:${String(index).padStart(32, "a")}`,
    schema: 1, canonical: true, retention: "CANONICAL_KNOWLEDGE",
    state: index % 2 ? "KNOWN" : "LEARNING",
    issueType: "performance", problemType: "latency",
    rootCause: `candidate warmup race in ${scope} pipeline`,
    strategy: JSON.stringify({ target: scope, capability: scope, retries: (index % 4) + 1 }),
    failureMode: index % 3 === 0 ? "network-error" : "timeout",
    semanticFact: `${scope} warmup latency regression observed after a retry policy change`,
    scope,
    count: (index % 9) + 1, occurrenceCount: (index % 9) + 1,
    firstSeen: seen, lastSeen: seen,
    lastSourceCollection: "observations", lastStatus: "measured", lastOutcome: index % 5 === 0 ? "failure" : "success",
    sourceCounts: { observations: (index % 9) + 1 },
    sourceRefs: [`observations:obs-${index}-a`, `journal:j-${index}-b`],
    lineageRefs: [], relationRefs: [], eventIds: [`event-${index}`],
    evidenceCount: (index % 9) + 1,
    recentEvidence: [{ source: "observations", id: `obs-${index}`, at: seen, outcome: "success", status: "measured", digest: `d${index}` }],
    confidence: 0.6, effectStats, effects: effectStats,
    successCount: (index % 7) + 1, failureCount: index % 3, successRate: 0.6, fitnessMean: 0.7, regressionCount: 0,
    trend: { window: 8, recent: [{ at: seen, outcome: "success", confidence: 0.6, regression: false }], lastOutcome: "success", direction: "stable", failureRate: 0.3, successRate: 0.6, regressionCount: 0 },
    learned: true, updatedAt: seen,
  };
}

/**
 * Count the active-archive lines the scan helpers parse while `run` executes.
 * The stack attribution keeps this to the archive-index scan helpers; the
 * retention and merge paths legitimately parse other lines.
 */
const ARCHIVE_INDEX_PARSE = /#(?:scanArchiveRaw|indexEntryFromRaw|activeKeysFromRaw|foldArchiveFacts|archiveFactsFromFile|archiveFactsFromText|indexEntryFromFacts)\b/;
async function countScanParses(lines, run) {
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
  return [...counts.values()].reduce((sum, count) => sum + count, 0);
}

/** One dockyard root with both active archives, written outside every timed interval. */
async function prepare(root, rows, knowledgeRows) {
  // The dockyard root is both the archive directory and the state-store home,
  // exactly as `mutate()` builds it for the staged and the committed tree.
  const store = new JsonStateStore({ filePath: join(root, "state.json") });
  const observations = `${store.filePath}.observations-archive.jsonl`;
  const knowledge = `${store.filePath}.knowledge-archive.jsonl`;
  await mkdir(dirname(observations), { recursive: true });
  await writeFile(observations, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  await writeFile(knowledge, knowledgeRows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return { store, observations, knowledge, stage: join(root, "stage") };
}

function instance(Memory, store, options = {}) {
  const memory = new Memory({
    stateStore: store, clock: () => new Date(NOW),
    archiveMaxBytes: 64 * 1024 * 1024, absoluteMaxSegmentBytes: 64 * 1024 * 1024, ...options,
  });
  memory.setMutationAuthority({ assertMutation() {}, isActive: () => true });
  return memory;
}

/**
 * The port's own sequence for one transaction's reconcile, with the parse
 * counting kept out of the timed interval: the live load always reads the
 * bytes, the mirror load repeats them over hard links, and the committed load
 * repeats them again after the commit. `instrument` counts the scan parses
 * instead of timing, because the stack attribution it needs would dominate
 * every measured interval.
 */
async function runSession(Memory, root, rows, knowledgeRows, { instrument = false } = {}) {
  const files = await prepare(root, rows, knowledgeRows);
  const lines = [
    ...rows.map((row) => JSON.stringify(row)),
    ...knowledgeRows.map((row) => JSON.stringify(row)),
  ];
  const live = instance(Memory, files.store);
  let liveParsed = null;
  const liveStart = performance.now();
  if (instrument) liveParsed = await countScanParses(lines, () => live.load());
  else await live.load();
  const liveMs = performance.now() - liveStart;

  // Exactly what `mutate()` does before it builds the staged memory: hard-link
  // the live tree, then load an instance over the mirror.
  const snapshot = mirrorArchives(root, files.stage);
  assert.ok(snapshot.files.size > 0, "the mirror must describe the live archive tree");
  const stageStore = new JsonStateStore({ filePath: join(files.stage, "state.json") });
  const staged = instance(Memory, stageStore);
  const mirrorStart = performance.now();
  const mirrorParsed = instrument ? await countScanParses(lines, () => staged.load()) : null;
  if (!instrument) await staged.load();
  const mirrorMs = performance.now() - mirrorStart;

  // The committed tree `mutate()` loads again through `hydrate()`. Nothing has
  // changed these bytes, so the second reconcile sees the same file identity.
  const committed = instance(Memory, files.store);
  const committedStart = performance.now();
  const committedParsed = instrument ? await countScanParses(lines, () => committed.load()) : null;
  if (!instrument) await committed.load();
  const committedMs = performance.now() - committedStart;

  const tree = {
    index: (await readFile(`${files.store.filePath}.evolution-archive-index.json`, "utf8")).split(root).join("<root>"),
    stageIndex: (await readFile(`${stageStore.filePath}.evolution-archive-index.json`, "utf8")).split(root).join("<root>"),
    observations: await readFile(files.observations, "utf8"),
    knowledge: await readFile(files.knowledge, "utf8"),
    activeKeys: JSON.stringify({
      observations: [...(committed.archiveActiveKeys.get("observations") ?? new Set())].sort(),
      knowledge: [...(committed.archiveActiveKeys.get("knowledge") ?? new Set())].sort(),
      stageObservations: [...(staged.archiveActiveKeys.get("observations") ?? new Set())].sort(),
      stageKnowledge: [...(staged.archiveActiveKeys.get("knowledge") ?? new Set())].sort(),
    }),
  };
  return { liveMs, mirrorMs, committedMs, liveParsed, mirrorParsed, committedParsed, tree };
}

async function timeSession(Memory, root, rows, knowledgeRows, { warmup, samples }) {
  const reference = await runSession(Memory, root, rows, knowledgeRows);
  const counts = await runSession(Memory, join(root, "counted"), rows, knowledgeRows, { instrument: true });
  assert.deepEqual(counts.tree, reference.tree, "counting parses must not change the persisted tree");
  // The control is the first load of a file this process has never scanned, so
  // it must read every active line; the reduction below must come from the
  // repeated loads, never from a control that stopped reading.
  assert.equal(counts.liveParsed, rows.length + knowledgeRows.length,
    "the first load of the live tree must parse every active line");
  const timed = [];
  for (let index = 0; index < warmup + samples; index += 1) {
    // A fresh fixture per sample, so the memo never carries over between them.
    const run = await runSession(Memory, join(root, `sample-${index}`), rows, knowledgeRows);
    assert.deepEqual(run.tree, reference.tree, "the persisted tree must not depend on the sample");
    if (index >= warmup) timed.push({ liveMs: run.liveMs, mirrorMs: run.mirrorMs, committedMs: run.committedMs });
  }
  return { ...reference, counts, samples: timed };
}

/**
 * What the memo still retains once the instance that produced its records is
 * gone. Requires `--expose-gc`: the measurement is a `heapUsed` difference taken
 * after an explicit collection, on a fixture of its own.
 */
async function measureRetained(Memory, root, rows, knowledgeRows) {
  const collect = async () => { globalThis.gc(); await new Promise((resolve) => setTimeout(resolve, 50)); globalThis.gc(); };
  const files = await prepare(root, rows, knowledgeRows);
  // The baseline is taken after the fixture exists, so the difference is what
  // the memo (and then the instance) keeps alive rather than the fixture bytes.
  await collect();
  const baseline = process.memoryUsage().heapUsed;
  let memory = instance(Memory, files.store);
  await memory.load();
  const keys = (memory.archiveActiveKeys.get("observations")?.size ?? 0) + (memory.archiveActiveKeys.get("knowledge")?.size ?? 0);
  await collect();
  const withInstance = process.memoryUsage().heapUsed;
  memory = null;
  await collect();
  const retained = process.memoryUsage().heapUsed;
  return { retainedBytes: retained - baseline, instanceBytes: withInstance - retained, keys };
}

const median = (values) => { const sorted = [...values].sort((left, right) => left - right); return sorted[Math.floor(sorted.length / 2)]; };

async function main() {
  const restoreClock = freezeClock();
  const baseline = await loadBaseline();
  const rows = Array.from({ length: options.rows }, (_, index) => observationRow(index));
  const knowledgeRows = Array.from({ length: options.knowledgeRows }, (_, index) => knowledgeRow(index));
  // The retained measurement runs first, while the memo is still empty: at its
  // 32-entry cap a later fixture would evict as much as it adds, and the
  // difference would read as zero.
  let retained = null;
  if (options.retained) {
    assert.equal(typeof globalThis.gc, "function", "--retained needs --expose-gc for a stable measurement");
    const home = await mkdtemp(join(tmpdir(), "dsh-scan-memo-retained-"));
    try {
      retained = await measureRetained((await import("../../lib/dockyard-domain/memory.js")).EvolutionMemory, home, rows, knowledgeRows);
    } finally { await rm(home, { recursive: true, force: true }); }
  }
  const report = {
    node: process.version, platform: `${process.platform}/${process.arch}`,
    baseline: { version: baseline.pin.version, sha256: baseline.pin.sha256 },
    rows: options.rows, knowledgeRows: options.knowledgeRows,
    rounds: options.rounds, warmup: options.warmup, samples: options.samples,
    scope: "mirrorArchives() of the live tree + load() of the mirror = the reconcile mutate() repeats",
    retained,
    roundsDetail: [],
  };
  try {
    for (let round = 0; round < options.rounds; round += 1) {
      const order = round % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
      const result = {};
      for (const side of order) {
        const home = await mkdtemp(join(tmpdir(), "dsh-scan-memo-"));
        try {
          result[side] = await timeSession(side === "baseline" ? baseline.Memory : (await import("../../lib/dockyard-domain/memory.js")).EvolutionMemory,
            home, rows, knowledgeRows, { warmup: options.warmup, samples: options.samples });
        } finally { await rm(home, { recursive: true, force: true }); }
      }
      assert.deepEqual(result.candidate.tree, result.baseline.tree, "the two implementations did not persist the same index and archive bytes");
      report.roundsDetail.push({
        order,
        baseline: { mirrorMs: result.baseline.samples.map((sample) => sample.mirrorMs), committedMs: result.baseline.samples.map((sample) => sample.committedMs), liveMs: result.baseline.samples.map((sample) => sample.liveMs), liveParsed: result.baseline.counts.liveParsed, mirrorParsed: result.baseline.counts.mirrorParsed, committedParsed: result.baseline.counts.committedParsed },
        candidate: { mirrorMs: result.candidate.samples.map((sample) => sample.mirrorMs), committedMs: result.candidate.samples.map((sample) => sample.committedMs), liveMs: result.candidate.samples.map((sample) => sample.liveMs), liveParsed: result.candidate.counts.liveParsed, mirrorParsed: result.candidate.counts.mirrorParsed, committedParsed: result.candidate.counts.committedParsed },
      });
    }
  } finally {
    restoreClock();
    await rm(baseline.directory, { recursive: true, force: true });
  }
  const sideMedian = (side, key) => median(report.roundsDetail.map((round) => median(round[side][key])));
  report.baselineLiveMs = sideMedian("baseline", "liveMs");
  report.candidateLiveMs = sideMedian("candidate", "liveMs");
  report.baselineMirrorMs = sideMedian("baseline", "mirrorMs");
  report.candidateMirrorMs = sideMedian("candidate", "mirrorMs");
  report.baselineCommittedMs = sideMedian("baseline", "committedMs");
  report.candidateCommittedMs = sideMedian("candidate", "committedMs");
  report.baselineTransactionMs = report.baselineMirrorMs + report.baselineCommittedMs;
  report.candidateTransactionMs = report.candidateMirrorMs + report.candidateCommittedMs;
  report.baselineLiveParsed = report.roundsDetail.at(-1).baseline.liveParsed;
  report.candidateLiveParsed = report.roundsDetail.at(-1).candidate.liveParsed;
  report.baselineMirrorParsed = report.roundsDetail.at(-1).baseline.mirrorParsed;
  report.candidateMirrorParsed = report.roundsDetail.at(-1).candidate.mirrorParsed;
  report.baselineCommittedParsed = report.roundsDetail.at(-1).baseline.committedParsed;
  report.candidateCommittedParsed = report.roundsDetail.at(-1).candidate.committedParsed;
  report.delta = {
    mirrorPct: ((report.candidateMirrorMs - report.baselineMirrorMs) / report.baselineMirrorMs) * 100,
    committedPct: ((report.candidateCommittedMs - report.baselineCommittedMs) / report.baselineCommittedMs) * 100,
    transactionPct: ((report.candidateTransactionMs - report.baselineTransactionMs) / report.baselineTransactionMs) * 100,
  };
  if (options.json) { console.log(JSON.stringify(report, null, 2)); return; }
  console.log(`node ${report.node} ${report.platform} | baseline dsh-evolution-${report.baseline.version} | rows ${report.rows} + ${report.knowledgeRows} knowledge`);
  console.log(`first load() of the live tree (control) ${report.baselineLiveMs.toFixed(3)} -> ${report.candidateLiveMs.toFixed(3)} ms`);
  console.log(`load() of the hard-linked mirror        ${report.baselineMirrorMs.toFixed(3)} -> ${report.candidateMirrorMs.toFixed(3)} ms (${report.delta.mirrorPct.toFixed(2)}%)`);
  console.log(`load() of the committed tree            ${report.baselineCommittedMs.toFixed(3)} -> ${report.candidateCommittedMs.toFixed(3)} ms (${report.delta.committedPct.toFixed(2)}%)`);
  console.log(`reconcile cost of one transaction       ${report.baselineTransactionMs.toFixed(3)} -> ${report.candidateTransactionMs.toFixed(3)} ms (${report.delta.transactionPct.toFixed(2)}%)`);
  console.log(`active lines parsed: first live load ${report.baselineLiveParsed} -> ${report.candidateLiveParsed}, mirror ${report.baselineMirrorParsed} -> ${report.candidateMirrorParsed}, committed ${report.baselineCommittedParsed} -> ${report.candidateCommittedParsed}`);
  if (report.retained) {
    console.log(`memo retained after the producing instance is gone: ${(report.retained.retainedBytes / 1024 / 1024).toFixed(2)} MiB for ${report.retained.keys} active keys (instance-only ${(report.retained.instanceBytes / 1024 / 1024).toFixed(2)} MiB)`);
  }
}

await main();
