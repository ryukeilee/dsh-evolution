// Independent-process A/B of the cold archive parse cache: retained heap, peak
// RSS, GC, wall and CPU.
//
//   node --expose-gc scripts/benchmarks/archive-row-window.mjs --side candidate \
//     --lib lib --mode cache --rows 10000 --knowledge-rows 10000 --json
//   node --expose-gc scripts/benchmarks/archive-row-window.mjs --side baseline \
//     --lib /tmp/baseline-lib --mode port --workload evict --rows 10000 \
//     --knowledge-rows 10000 --samples 5 --json
//
// `--side` only labels the sample; the implementation tree comes from `--lib`.
// One side per process, and the driver in docs/performance/archive-row-window.md
// alternates the two sides round by round.
//
// `--mode cache` measures what the parse cache retains. It drives the real
// `EvolutionMemory` over an archive tree written by the fixture, takes one
// knowledge-bearing write (the read that populates both collections), collects,
// then drops one cache entry at a time and collects again. The difference is what
// that entry held. `--mode port` measures the whole official store instead:
// `port.observe()` wall/CPU over the sample loop, peak RSS for the process, GC
// count and time, and - with `--reads` - the `recall`/`query` read costs.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cpus, loadavg, tmpdir } from "node:os";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { JsonStorageBackend } from "@deepseek-ai/dsh-storage-json";

const FROZEN_NOW = Date.parse("2026-10-12T00:00:00.000Z");
const NOW = new Date(FROZEN_NOW).toISOString();
const TARGET = "plugin:edge-cache";
const MiB = (bytes) => Number((bytes / 2 ** 20).toFixed(3));
const round = (value) => Number(value.toFixed(3));
// Deterministic accounting for how much history one write materialises.
const counts = { archiveRowsParsed: 0, archiveBytesRead: 0 };
const realParse = JSON.parse;
JSON.parse = (...args) => {
  const value = realParse(...args);
  if (value && typeof value === "object" && /^(obs|key)-/.test(String(value.id ?? ""))) counts.archiveRowsParsed += 1;
  return value;
};
const realReadFileSync = fs.readFileSync;
fs.readFileSync = (...args) => {
  const value = realReadFileSync(...args);
  if (typeof args[0] === "string" && args[0].includes("-archive.jsonl")) counts.archiveBytesRead += typeof value === "string" ? Buffer.byteLength(value) : value.length;
  return value;
};
let uuidSequence = 0;
crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, "0")}`;
syncBuiltinESMExports();
class FrozenDate extends Date {
  constructor(...value) { if (value.length === 0) super(FROZEN_NOW); else super(...value); }
  static now() { return FROZEN_NOW; }
}
Object.setPrototypeOf(FrozenDate, Date);
globalThis.Date = FrozenDate;

function parseArgs(argv) {
  const options = { side: "candidate", lib: resolve("lib"), mode: "port", rows: 10000, knowledgeRows: 10000, workload: "repeat", warmup: 1, samples: 5, reads: false, layout: "segmented" };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--json") continue;
    if (key === "--reads") { options.reads = true; continue; }
    const value = argv[index + 1];
    index += 1;
    if (key === "--side") options.side = value;
    else if (key === "--lib") options.lib = resolve(value);
    else if (key === "--rows") options.rows = Number(value);
    else if (key === "--knowledge-rows") options.knowledgeRows = Number(value);
    else if (key === "--warmup") options.warmup = Number(value);
    else if (key === "--samples") options.samples = Number(value);
    else if (key === "--layout") {
      if (!["segmented", "single"].includes(value)) throw new Error(`unknown layout ${value}`);
      options.layout = value;
    } else if (key === "--mode") {
      if (!["port", "cache"].includes(value)) throw new Error(`unknown mode ${value}`);
      options.mode = value;
    } else if (key === "--workload") {
      if (!["repeat", "evict"].includes(value)) throw new Error(`unknown workload ${value}`);
      options.workload = value;
    } else throw new Error(`unknown option ${key}`);
  }
  if (options.mode === "cache" && !globalThis.gc) throw new Error("--mode cache requires --expose-gc");
  return options;
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
    recordedAt: new Date(FROZEN_NOW - index * 3_600_000).toISOString(),
  };
}

function knowledgeRow(index) {
  const scope = `plugin:knowledge-${index}`;
  const seen = new Date(FROZEN_NOW - index * 3_600_000).toISOString();
  const effectStats = { successCount: (index % 7) + 1, failureCount: index % 3, neutralCount: 0, regressionCount: 0, fitnessCount: 2, fitnessSum: 1.4, fitnessMean: 0.7, bestFitness: 0.8, worstFitness: 0.6, successRate: 0.6, metrics: {} };
  return {
    id: `key-${index}`, knowledgeKey: `knowledge:${String(index).padStart(32, "a")}`,
    schema: 1, canonical: true, retention: "CANONICAL_KNOWLEDGE", state: index % 2 ? "KNOWN" : "LEARNING",
    issueType: "performance", problemType: "latency", rootCause: `candidate warmup race in ${scope} pipeline`,
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

/**
 * Seed one archive tree; only the byte counts survive the fixture.
 *
 * Like a long-running host, most of the history is in sealed segments and only
 * the newest quarter is in the active file. A fixture that leaves every record
 * in one oversized active file forces the first append to rotate it, which
 * invalidates any parse of those bytes for a reason that has nothing to do with
 * the cache representation.
 */
async function fixture(options) {
  const root = await mkdtemp(join(tmpdir(), "dsh-row-window-"));
  const sizes = {};
  for (const [collection, build] of [["observations", observationRow], ["knowledge", knowledgeRow]]) {
    const count = collection === "knowledge" ? options.knowledgeRows : options.rows;
    let bytes = 0;
    const lines = [];
    for (let index = 0; index < count; index += 1) {
      const line = JSON.stringify(build(index));
      bytes += Buffer.byteLength(line) + 1;
      lines.push(line);
    }
    sizes[collection] = bytes;
    if (!lines.length) continue;
    const path = join(root, `state.json.${collection}-archive.jsonl`);
    const sealed = options.layout === "single" ? [] : lines.slice(0, Math.floor(lines.length * 0.75));
    const active = lines.slice(Math.floor(lines.length * 0.75));
    if (sealed.length) {
      const directory = `${path}.segments`;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const perSegment = Math.ceil(sealed.length / 3);
      let ordinal = 1;
      for (let offset = 0; offset < sealed.length; offset += perSegment) {
        await writeFile(join(directory, `segment-${String(ordinal).padStart(12, "0")}.jsonl`),
          sealed.slice(offset, offset + perSegment).join("\n") + "\n", { mode: 0o600 });
        ordinal += 1;
      }
    }
    await writeFile(path, active.length ? active.join("\n") + "\n" : "", { mode: 0o600 });
  }
  return { root, sizes };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function portableFixture(root) {
  const backend = new JsonStorageBackend(join(root, "official"));
  const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: "json" });
  const domain = await ctx.storageDomain.open((await import(pathToFileURL(join(process.cwd(), "lib/domain-storage.js")).href)).evolutionDomainSpec);
  await domain.global.set({ schema: 1, aggregate: {}, applied: {}, pending: null });
  await domain.close();
  return { backend, ctx };
}

async function cacheMode(options, libs) {
  const { root, sizes } = await fixture(options);
  await writeFile(join(root, "state.json"), JSON.stringify({ evolution: { schema: 4 } }));
  const { backend } = await portableFixture(root);
  const filePath = join(root, "state.json");
  const load = async () => { try { return JSON.parse(await fs.promises.readFile(filePath, "utf8")); } catch { return {}; } };
  const save = async (state) => { await fs.promises.writeFile(filePath, JSON.stringify(state), { mode: 0o600 }); };
  const stateStore = { filePath, inlineSerialization: true, load, save, update: (updater) => (async () => save(await updater(await load())))() };
  const memory = new libs.domain.EvolutionMemory({ stateStore, transaction: { persist: stateStore.update }, clock: () => new Date(NOW), mutationAuthority: { assertMutation() {} } });
  await memory.load({ snapshot: false });
  const measure = () => { globalThis.gc(); globalThis.gc(); return process.memoryUsage().heapUsed; };
  const baseline = (globalThis.gc(), globalThis.gc(), process.memoryUsage().heapUsed);
  // One knowledge-bearing write is the read that populates both collections.
  await memory.recordObservation({ id: "probe-0", source: "official-tools", type: "tool/error", code: "HOST_OPERATION_FAILED", componentId: "probe-scope", severity: "error", status: "failed", problem: "probe-scope warmup latency regression" });
  const withCache = measure();
  // Shape-agnostic: the retained-record format (the pre-round one) answers
  // `records`, the table format answers `keys` plus the row window.
  const inventory = [...memory.archiveReadCache].map(([collection, entry]) => ({
    collection,
    format: entry.keys ? "table" : "records",
    entries: entry.keys ? entry.keys.length : entry.records.length,
    windowFrom: entry.windowFrom ?? null,
    retainedRows: entry.window
      ? entry.window.reduce((count, row) => count + (row === undefined ? 0 : 1), 0)
      : entry.records.length,
    tombstones: entry.tombstones.size,
  }));
  // Only the collection names are held here: a snapshot of the entries would
  // itself keep the rows alive while the heap is measured, which is how a
  // retention attribution silently reads zero.
  const attribution = [];
  let previous = withCache;
  for (const collection of [...memory.archiveReadCache.keys()]) {
    memory.archiveReadCache.delete(collection);
    const after = measure();
    attribution.push({ collection, retainedMiB: MiB(previous - after) });
    previous = after;
  }
  // The rows must still be readable from the files once nothing is retained.
  globalThis.gc(); globalThis.gc();
  const rowsAfter = memory.historyWindow("knowledge", 10).count;
  const output = {
    side: options.side, lib: options.lib, mode: "cache", node: process.version,
    platform: `${process.platform}/${process.arch}`, cpus: cpus().length, loadAverage: Number(loadavg()[0]?.toFixed(2)) || undefined,
    rows: options.rows, knowledgeRows: options.knowledgeRows, fixtureBytes: sizes,
    retained: { withCacheMiB: MiB(withCache - baseline), withoutCacheMiB: MiB(previous - baseline), baselineMiB: MiB(baseline) },
    attribution,
    inventory,
    rowsAfter,
    heapMiB: MiB(process.memoryUsage().heapUsed), peakRssMiB: MiB(process.resourceUsage().maxRSS * 1024),
  };
  await backend.close();
  await rm(root, { recursive: true, force: true });
  return output;
}

async function portMode(options, libs) {
  const { root, sizes } = await fixture(options);
  const { backend, ctx } = await portableFixture(root);
  const dockyard = join(root, "dockyard");
  await mkdir(dockyard, { recursive: true });
  for (const name of ["observations", "knowledge"]) {
    const from = join(root, `state.json.${name}-archive.jsonl`);
    if (fs.existsSync(from)) fs.renameSync(from, join(dockyard, `state.json.${name}-archive.jsonl`));
  }
  const eventLog = join(root, "events.jsonl");
  await writeFile(eventLog, "");
  const gc = { count: 0, ms: 0 };
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) { gc.count += 1; gc.ms += entry.duration; }
  });
  observer.observe({ entryTypes: ["gc"] });
  const samples = [];
  const reads = { recall: [], query: [] };
  let port = null;
  try {
    port = await libs.storage.openDomainStorage(ctx, { presetDir: root, eventBridgePath: eventLog, eventBridgeKey: "b".repeat(64) });
    for (let index = 0; index < options.warmup; index += 1) {
      await port.observe({ code: "HOST_OPERATION_FAILED", target: options.workload === "evict" ? `${TARGET}-warm-${index}` : TARGET });
    }
    for (let index = 0; index < options.samples; index += 1) {
      const cpu = process.cpuUsage();
      const start = performance.now();
      await port.observe({ code: "HOST_OPERATION_FAILED", target: options.workload === "evict" ? `${TARGET}-${index}` : TARGET });
      const wallMs = performance.now() - start;
      const used = process.cpuUsage(cpu);
      samples.push({ wallMs: round(wallMs), cpuMs: round((used.user + used.system) / 1000), archiveRowsParsed: counts.archiveRowsParsed, archiveBytesRead: counts.archiveBytesRead, operations: globalThis.__counters ? JSON.parse(JSON.stringify(globalThis.__counters)) : null });
      if (globalThis.__counters) globalThis.__counters = {};
      counts.archiveRowsParsed = 0;
      counts.archiveBytesRead = 0;
    }
    if (options.reads) {
      for (let index = 0; index < 5; index += 1) {
        const start = performance.now();
        port.recall({ why: "edge cache warmup latency", target: TARGET, impactScope: ["runtime"], successMetrics: ["p95 latency decreases"] }, {});
        reads.recall.push(round(performance.now() - start));
        const queryStart = performance.now();
        port.query("observations", 20);
        reads.query.push(round(performance.now() - queryStart));
      }
    }
    const output = {
      side: options.side, lib: options.lib, mode: "port", node: process.version,
      platform: `${process.platform}/${process.arch}`, cpus: cpus().length, loadAverage: Number(loadavg()[0]?.toFixed(2)) || undefined,
      rows: options.rows, knowledgeRows: options.knowledgeRows, workload: options.workload, fixtureBytes: sizes,
      samples,
      medianWallMs: round(median(samples.map((sample) => sample.wallMs))),
      medianCpuMs: round(median(samples.map((sample) => sample.cpuMs))),
      reads: options.reads ? { recallMedianMs: round(median(reads.recall)), queryMedianMs: round(median(reads.query)), recallSamples: reads.recall, querySamples: reads.query } : null,
      heapMiB: MiB(process.memoryUsage().heapUsed), rssMiB: MiB(process.memoryUsage().rss),
      peakRssMiB: MiB(process.resourceUsage().maxRSS * 1024),
      gcCount: gc.count, gcMs: round(gc.ms),
    };
    return output;
  } finally {
    observer.disconnect();
    if (port) await port.close().catch(() => {});
    await backend.close();
    await rm(root, { recursive: true, force: true });
  }
}

const options = parseArgs(process.argv.slice(2));
const libs = {
  storage: await import(pathToFileURL(join(options.lib, "domain-storage.js")).href),
  domain: await import(pathToFileURL(join(options.lib, "dockyard-domain/index.js")).href),
};
assert.equal(typeof libs.storage.openDomainStorage, "function", `${options.lib} must export openDomainStorage`);
const output = options.mode === "cache" ? await cacheMode(options, libs) : await portMode(options, libs);
console.log(JSON.stringify(output, null, 2));
