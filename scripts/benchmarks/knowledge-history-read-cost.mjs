// Two isolated probes behind docs/performance/recall-view.md. Both run the real
// implementation (no re-implementation, no private-method calls beyond the public
// `history` / `historyWindow` / `recordObservation` surface):
//
//   1. the detached-read cost: `history("knowledge")` (merge + one copy per row)
//      against `historyWindow("knowledge", 50)` (the same merge plus the window
//      the public query allows, which is capped at 50 rows) and against a plain
//      JSON round-trip of the same rows, which is only a reference order of
//      magnitude and not a decomposition of either number;
//   2. the total cost a measured append adds when it carries metrics: the same
//      write with and without `metrics`. That difference covers everything the
//      metrics trigger (normalization, the knowledge accumulator's metric merge
//      and the extra persisted bytes), so it is an upper bound on the metric
//      branch alone, not an attribution to it.
//
//   node scripts/benchmarks/knowledge-history-read-cost.mjs [--rows N] [--samples N] [--json]
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

import { EvolutionMemory } from "../../lib/dockyard-domain/memory.js";

const NOW = "2026-10-12T00:00:00.000Z";
const SCOPE = "plugin:edge-cache";

function parseArgs(argv) {
  const options = { rows: 10000, samples: 5, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--json") { options.json = true; continue; }
    const value = Number(argv[index + 1]);
    index += 1;
    if (key === "--rows") options.rows = value;
    else if (key === "--samples") options.samples = value;
    else throw new Error(`unknown option ${key}`);
  }
  return options;
}

const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
const round = (value) => Math.round(value * 100) / 100;

/** A canonical knowledge row with the payload a long-running host accumulates. */
function knowledgeRow(index) {
  const scope = `plugin:module-${index}`;
  const seen = new Date(Date.parse(NOW) - index * 3_600_000).toISOString();
  const effectStats = { successCount: (index % 7) + 1, failureCount: index % 3, neutralCount: 0, regressionCount: 0, fitnessCount: 2, fitnessSum: 1.4, fitnessMean: 0.7, bestFitness: 0.8, worstFitness: 0.6, successRate: 0.6, metrics: {} };
  return {
    id: `key-${index}`, knowledgeKey: `knowledge:${String(index).padStart(32, "a")}`,
    schema: 1, canonical: true, retention: "CANONICAL_KNOWLEDGE", state: index % 2 ? "KNOWN" : "LEARNING",
    issueType: "performance", problemType: "latency",
    rootCause: `candidate warmup race in ${scope} pipeline`,
    strategy: JSON.stringify({ target: scope, capability: scope, retries: (index % 4) + 1 }),
    failureMode: index % 3 === 0 ? "network-error" : "timeout",
    semanticFact: `${scope} warmup latency regression observed after a retry policy change`,
    scope, count: (index % 9) + 1, occurrenceCount: (index % 9) + 1, firstSeen: seen, lastSeen: seen,
    lastSourceCollection: "observations", lastStatus: "measured", lastOutcome: index % 5 === 0 ? "failure" : "success",
    sourceCounts: { observations: (index % 9) + 1 },
    sourceRefs: [`observations:obs-${index}-a`, `journal:j-${index}-b`],
    lineageRefs: [], relationRefs: [], eventIds: [`event-${index}`], evidenceCount: (index % 9) + 1,
    recentEvidence: [{ source: "observations", id: `obs-${index}`, at: seen, outcome: "success", status: "measured", digest: `d${index}` }],
    confidence: 0.6, effectStats, effects: effectStats,
    successCount: (index % 7) + 1, failureCount: index % 3, successRate: 0.6, fitnessMean: 0.7, regressionCount: 0,
    trend: { window: 8, recent: [{ at: seen, outcome: "success", confidence: 0.6, regression: false }], lastOutcome: "success", direction: "stable", failureRate: 0.3, successRate: 0.6, regressionCount: 0 },
    learned: true, updatedAt: seen,
  };
}

const METRICS = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`metric${index}`, 10 + index]));
const MEASURED = {
  type: "tool/result", code: "MEASURED", message: "edge cache warmup latency",
  componentId: SCOPE, target: SCOPE, capabilityId: SCOPE, problem: "edge cache warmup latency",
  status: "measured", success: true, severity: "info", recordedAt: NOW,
};

function storeFor(home) {
  const filePath = join(home, ".dockyard-dsh", "state.json");
  let aggregate = {};
  return {
    filePath, inlineSerialization: true,
    load: async () => structuredClone(aggregate),
    update: async (updater) => { aggregate = updater(aggregate); await mkdir(dirname(filePath), { recursive: true }); await writeFile(`${filePath}.tmp`, JSON.stringify(aggregate), { mode: 0o600 }); },
  };
}

async function seeded(collection, rows) {
  const home = await mkdtemp(join(tmpdir(), "dsh-read-cost-"));
  const store = storeFor(home);
  const archive = `${store.filePath}.${collection}-archive.jsonl`;
  await mkdir(dirname(archive), { recursive: true });
  await writeFile(archive, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const instance = new EvolutionMemory({ stateStore: store, clock: () => new Date(NOW), hotEntries: 0, archiveMaxBytes: 512 * 1024 * 1024 });
  instance.setMutationAuthority({ assertMutation() {}, isActive: () => true });
  await instance.load();
  return { home, archive, instance };
}

async function detachedReadCost(options) {
  const rows = Array.from({ length: options.rows }, (_, index) => knowledgeRow(index));
  const seededMemory = await seeded("knowledge", rows);
  try {
    const full = [], window = [], roundTrip = [];
    for (let index = 0; index < options.samples; index += 1) {
      let started = performance.now();
      seededMemory.instance.history("knowledge");
      full.push(performance.now() - started);
      started = performance.now();
      // `historyWindow` clamps its limit to 50, so this is the merge plus 50
      // copies: the largest window the public query can return, not a 2,000-row
      // projection.
      const windowed = seededMemory.instance.historyWindow("knowledge", 50);
      window.push(performance.now() - started);
      if (windowed.entries.length !== Math.min(50, options.rows)) throw new Error("historyWindow returned an unexpected number of rows");
      started = performance.now();
      JSON.parse(JSON.stringify(rows));
      roundTrip.push(performance.now() - started);
    }
    return {
      rows: options.rows,
      archiveMiB: round(JSON.stringify(rows).length / (1024 * 1024)),
      historyMs: round(median(full)),
      historyWindow50Ms: round(median(window)),
      historyWindowRows: mildRows(options.rows),
      jsonRoundTripMs: round(median(roundTrip)),
    };
  } finally {
    await rm(seededMemory.home, { recursive: true, force: true });
  }
}

function mildRows(rows) { return Math.min(50, rows); }

async function metricBranchCost(options) {
  const measured = async (metrics) => {
    const seededMemory = await seeded("observations", [0, 1, 2, 3, 4, 5].map((index) => ({ ...MEASURED, id: `cold-${index}`, metrics: METRICS })));
    try {
      const samples = [];
      for (let index = 0; index < options.samples; index += 1) {
        const started = performance.now();
        await seededMemory.instance.recordObservation({ ...MEASURED, id: `incoming-${index}`, ...(metrics ? { metrics: METRICS } : {}) });
        samples.push(performance.now() - started);
      }
      return median(samples);
    } finally {
      await rm(seededMemory.home, { recursive: true, force: true });
    }
  };
  const withMetrics = await measured(true);
  const withoutMetrics = await measured(false);
  return {
    withMetricsMs: round(withMetrics),
    withoutMetricsMs: round(withoutMetrics),
    // Everything metrics add to the write (normalization, accumulator merge,
    // persisted bytes), not the metric branch on its own.
    metricsAddedMs: round(withMetrics - withoutMetrics),
    metricsAddedSharePct: round(((withMetrics - withoutMetrics) / withMetrics) * 100),
  };
}

const options = parseArgs(process.argv.slice(2));
const report = {
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  samples: options.samples,
  detachedRead: await detachedReadCost(options),
  metricBranch: await metricBranchCost(options),
};
if (options.json) console.log(JSON.stringify(report, null, 2));
else {
  const read = report.detachedRead;
  console.log(`node ${report.node} ${report.platform} | ${read.rows} knowledge rows (${read.archiveMiB} MiB)`);
  console.log(`  history("knowledge")            ${read.historyMs} ms  (merge + every row copied)`);
  console.log(`  historyWindow("knowledge",50)   ${read.historyWindow50Ms} ms  (merge + ${read.historyWindowRows} rows)`);
  console.log(`  JSON round-trip of the rows     ${read.jsonRoundTripMs} ms  (reference order of magnitude)`);
  const extra = report.metricBranch;
  console.log(`  measured append with metrics    ${extra.withMetricsMs} ms`);
  console.log(`  measured append without metrics ${extra.withoutMetricsMs} ms`);
  console.log(`  everything metrics add          ${extra.metricsAddedMs} ms (${extra.metricsAddedSharePct}% of the write; upper bound on the metric branch)`);
}
