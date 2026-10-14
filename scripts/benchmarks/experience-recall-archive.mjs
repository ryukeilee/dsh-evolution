// A/B benchmark for the durable knowledge/observation archive reads on the
// record path, against the pinned pre-change implementation.
//
// The measured path is the real one: a file-backed `EvolutionMemory` whose
// cold archive already holds history, then the public `recordObservation()`
// entry point the authenticated event bridge and the observation store both
// use. Nothing is replaced in the working tree and no private method is
// called.
//
// The baseline is the pinned release artifact (`release/manifest.json`),
// extracted into a temporary directory and imported as-is. Both sides use the
// same fixture bytes and the same frozen clock, and every scenario asserts the
// two implementations persisted identical `state.json` and archive bytes
// before its timings are reported, so a faster candidate that changes a
// retention decision fails instead of scoring.
//
//   node scripts/benchmarks/experience-recall-archive.mjs [--rows N] [--rounds N] [--warmup N] [--samples N] [--json]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { EvolutionMemory } from "../../lib/dockyard-domain/memory.js";
import { collectKnowledgeExperience, finalizeExperienceRecall } from "../../lib/experience-recall.js";
import { readReleaseManifest, releaseArtifactPath } from "../release/release-lib.mjs";

const NOW = "2026-10-12T00:00:00.000Z";
const TARGET = "plugin:edge-cache";
const INPUT = { why: "edge cache warmup latency", target: TARGET, impactScope: ["runtime"], successMetrics: ["p95 latency decreases"] };

function parseArgs(argv) {
  const options = { rows: 10000, rounds: 3, warmup: 1, samples: 7, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--json") { options.json = true; continue; }
    const value = Number(argv[index + 1]);
    index += 1;
    if (key === "--rows") options.rows = value;
    else if (key === "--rounds") options.rounds = value;
    else if (key === "--warmup") options.warmup = value;
    else if (key === "--samples") options.samples = value;
    else throw new Error(`unknown option ${key}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

async function loadBaseline() {
  const pin = readReleaseManifest();
  const directory = await mkdtemp(join(tmpdir(), "dsh-archive-baseline-"));
  execFileSync("tar", ["-xzf", releaseArtifactPath(pin), "-C", directory, "package/lib"], { stdio: "ignore" });
  const module = await import(pathToFileURL(join(directory, "package/lib/dockyard-domain/memory.js")).href);
  assert.equal(module.EvolutionMemory.name, "EvolutionMemory");
  return { pin, directory, Memory: module.EvolutionMemory };
}

// --- fixtures ---------------------------------------------------------------

function knowledgeRow(index) {
  const scope = `plugin:module-${index}`;
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
    confidence: 0.6,
    effectStats, effects: effectStats,
    successCount: (index % 7) + 1, failureCount: index % 3, successRate: 0.6, fitnessMean: 0.7, regressionCount: 0,
    trend: { window: 8, recent: [{ at: seen, outcome: "success", confidence: 0.6, regression: false }], lastOutcome: "success", direction: "stable", failureRate: 0.3, successRate: 0.6, regressionCount: 0 },
    learned: true, updatedAt: seen,
  };
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

const INCOMING = {
  id: "incoming-observation",
  type: "tool/error", code: "HOST_OPERATION_FAILED", message: "official operation failed",
  componentId: TARGET, severity: "error", status: "failed",
  problem: "edge cache warmup latency", target: TARGET, capabilityId: TARGET,
  metrics: { latency: 12 }, recordedAt: NOW,
};

function storeFor(home) {
  const filePath = join(home, ".dockyard-dsh", "state.json");
  let aggregate = {};
  return {
    filePath,
    inlineSerialization: true,
    load: async () => structuredClone(aggregate),
    update: async (updater) => {
      aggregate = updater(aggregate);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(`${filePath}.tmp`, JSON.stringify(aggregate), { mode: 0o600 });
      await rename(`${filePath}.tmp`, filePath);
    },
  };
}

async function makeMemory(MemoryClass, collection, rows, { hotEntries = 8 } = {}) {
  const home = await mkdtemp(join(tmpdir(), "dsh-archive-bench-"));
  const store = storeFor(home);
  const archive = `${store.filePath}.${collection}-archive.jsonl`;
  await mkdir(dirname(archive), { recursive: true });
  await writeFile(archive, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const instance = new MemoryClass({ stateStore: store, clock: () => new Date(NOW), hotEntries, archiveMaxBytes: 64 * 1024 * 1024 });
  instance.setMutationAuthority({ assertMutation() {}, isActive: () => true });
  await instance.load();
  return { home, store, archive, instance };
}

async function persisted(memory) {
  return {
    state: (await readFile(memory.store.filePath, "utf8")).split(memory.home).join("<home>"),
    archive: await readFile(memory.archive, "utf8"),
  };
}

// --- scenarios --------------------------------------------------------------

async function scenarioAppendColdKnowledge(MemoryClass, rows) {
  const memory = await makeMemory(MemoryClass, "knowledge", rows, { hotEntries: 4 });
  let count = 0;
  return {
    async run() { await memory.instance.recordObservation({ ...INCOMING, id: `incoming-${count += 1}`, recordedAt: NOW }); },
    async finish() { return { ...(await persisted(memory)), rows: rows.length }; },
    async dispose() { await rm(memory.home, { recursive: true, force: true }); },
  };
}

async function scenarioAppendColdSource(MemoryClass, rows) {
  const memory = await makeMemory(MemoryClass, "observations", rows, { hotEntries: 8 });
  let count = 0;
  return {
    async run() { await memory.instance.recordObservation({ ...INCOMING, id: `incoming-${count += 1}`, componentId: `plugin:other-${count}`, target: `plugin:other-${count}`, capabilityId: `plugin:other-${count}`, recordedAt: NOW }); },
    async finish() { return { ...(await persisted(memory)), rows: rows.length }; },
    async dispose() { await rm(memory.home, { recursive: true, force: true }); },
  };
}

async function scenarioRecallControl(MemoryClass, rows) {
  const memory = await makeMemory(MemoryClass, "knowledge", rows, { hotEntries: 0 });
  return {
    async run() { finalizeExperienceRecall(INPUT, [collectKnowledgeExperience(memory.instance.history("knowledge"), INPUT, {})], {}); },
    async finish() { return { rows: rows.length }; },
    async dispose() { await rm(memory.home, { recursive: true, force: true }); },
  };
}

const SCENARIOS = [
  ["append with a cold knowledge archive", "knowledge", scenarioAppendColdKnowledge],
  ["append with a cold source archive", "observations", scenarioAppendColdSource],
  ["recall over a cold knowledge archive (control)", "knowledge", scenarioRecallControl],
];

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function timeScenario(Scenario, MemoryClass, rows) {
  const scenario = await Scenario(MemoryClass, rows);
  try {
    for (let index = 0; index < options.warmup; index += 1) await scenario.run();
    const samples = [];
    for (let index = 0; index < options.samples; index += 1) {
      const cpu = process.cpuUsage();
      const start = performance.now();
      await scenario.run();
      samples.push({ wallMs: performance.now() - start, cpuMs: (process.cpuUsage(cpu).user + process.cpuUsage(cpu).system) / 1000 });
    }
    return { samples, evidence: await scenario.finish() };
  } finally {
    await scenario.dispose();
  }
}

async function main() {
  const baseline = await loadBaseline();
  const rows = {
    knowledge: Array.from({ length: options.rows }, (_, index) => knowledgeRow(index)),
    observations: Array.from({ length: options.rows }, (_, index) => observationRow(index)),
  };
  const report = { node: process.version, platform: `${process.platform}/${process.arch}`, baseline: { version: baseline.pin.version, sha256: baseline.pin.sha256 }, rows: options.rows, rounds: options.rounds, warmup: options.warmup, samples: options.samples, scenarios: [] };
  try {
    for (const [label, collection, Scenario] of SCENARIOS) {
      const rounds = [];
      for (let round = 0; round < options.rounds; round += 1) {
        // Alternate which implementation runs first so a warm page cache or a
        // drifting machine cannot favour one side.
        const order = round % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
        const result = {};
        for (const side of order) {
          const MemoryClass = side === "baseline" ? baseline.Memory : EvolutionMemory;
          result[side] = await timeScenario(Scenario, MemoryClass, rows[collection]);
        }
        assert.deepEqual(result.candidate.evidence, result.baseline.evidence, `${label}: the two implementations did not persist the same bytes`);
        rounds.push({ order, baseline: result.baseline.samples, candidate: result.candidate.samples });
      }
      const sideMedian = (side, key) => median(rounds.map((round) => median(round[side].map((sample) => sample[key]))));
      const entry = {
        label,
        baseline: { wallMs: sideMedian("baseline", "wallMs"), cpuMs: sideMedian("baseline", "cpuMs") },
        candidate: { wallMs: sideMedian("candidate", "wallMs"), cpuMs: sideMedian("candidate", "cpuMs") },
        rounds,
      };
      entry.delta = {
        wallPct: ((entry.candidate.wallMs - entry.baseline.wallMs) / entry.baseline.wallMs) * 100,
        cpuPct: ((entry.candidate.cpuMs - entry.baseline.cpuMs) / entry.baseline.cpuMs) * 100,
      };
      report.scenarios.push(entry);
    }
  } finally {
    await rm(baseline.directory, { recursive: true, force: true });
  }
  if (options.json) { console.log(JSON.stringify(report, null, 2)); return; }
  console.log(`node ${report.node} ${report.platform} | baseline dsh-evolution-${report.baseline.version} | rows ${report.rows}`);
  for (const entry of report.scenarios) {
    console.log(`${entry.label}`);
    console.log(`  wall  ${entry.baseline.wallMs.toFixed(3)} -> ${entry.candidate.wallMs.toFixed(3)} ms  (${entry.delta.wallPct.toFixed(2)}%)`);
    console.log(`  cpu   ${entry.baseline.cpuMs.toFixed(3)} -> ${entry.candidate.cpuMs.toFixed(3)} ms  (${entry.delta.cpuPct.toFixed(2)}%)`);
  }
}

await main();
