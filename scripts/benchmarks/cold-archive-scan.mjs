// Independent-process A/B of the cold archive *first scan*: the reads that turn
// the archive files into the ordered key table, measured through the official
// `DomainFacility` + `JsonStorageBackend` path.
//
//   node --expose-gc scripts/benchmarks/cold-archive-scan.mjs --build --dir /tmp/fx20k \
//     --rows 20000 --knowledge-rows 20000
//   node --expose-gc scripts/benchmarks/cold-archive-scan.mjs --measure --dir /tmp/fx20k \
//     --lib lib --json
//   node --expose-gc scripts/benchmarks/cold-archive-scan.mjs --measure --dir /tmp/fx20k \
//     --lib /tmp/dsh-scan-base/lib --json
//
// `--build` writes the fixture once, so both sides read the same bytes: the
// child that measures only opens the port and performs the reads, and its peak
// RSS is therefore the scan plus the runtime, not a fixture the process built.
// `--side` only labels the sample; the implementation tree comes from `--lib`.
//
// Every number is one process. The driver in
// docs/performance/cold-archive-scan.md alternates the two sides round by round
// and repeats the whole thing on a second largeness so a single noisy run cannot
// be read as a result.
import fs from "node:fs";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
const memoryBreakdown = () => {
  const usage = process.memoryUsage();
  return { rssMiB: MiB(usage.rss), heapTotalMiB: MiB(usage.heapTotal), heapUsedMiB: MiB(usage.heapUsed), externalMiB: MiB(usage.external), arrayBuffersMiB: MiB(usage.arrayBuffers) };
};
const round = (value) => Number(value.toFixed(3));

let uuidSequence = 0;
crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, "0")}`;
class FrozenDate extends Date {
  constructor(...value) { if (value.length === 0) super(FROZEN_NOW); else super(...value); }
  static now() { return FROZEN_NOW; }
}
Object.setPrototypeOf(FrozenDate, Date);
globalThis.Date = FrozenDate;

/**
 * Count what the implementation actually does to the archive files: how many
 * archive lines it turns into objects, and how many archive bytes it pulls into
 * the process. `JSON.parse` and the two read entry points are the only ways the
 * domain reaches those bytes, so hooking them attributes the work without the
 * implementation having to report anything about itself.
 */
const counts = { archiveRowsParsed: 0, archiveBytesRead: 0, archiveOpens: 0 };
const isArchivePath = (value) => typeof value === "string" && value.includes("-archive.jsonl");
const realParse = JSON.parse;
JSON.parse = (...args) => {
  const value = realParse(...args);
  if (value && typeof value === "object" && /^(obs|key)-/.test(String(value.id ?? ""))) counts.archiveRowsParsed += 1;
  return value;
};
const realReadFileSync = fs.readFileSync;
fs.readFileSync = (...args) => {
  const value = realReadFileSync(...args);
  if (isArchivePath(args[0])) counts.archiveBytesRead += typeof value === "string" ? Buffer.byteLength(value) : value.length;
  return value;
};
const realPromisesReadFile = fs.promises.readFile;
fs.promises.readFile = async (...args) => {
  const value = await realPromisesReadFile(...args);
  const name = typeof args[0] === "string" ? args[0] : args[0]?.path;
  if (isArchivePath(name)) counts.archiveBytesRead += typeof value === "string" ? Buffer.byteLength(value) : value.length;
  return value;
};
const fdPaths = new Map();
const realOpenSync = fs.openSync;
fs.openSync = (...args) => {
  const fd = realOpenSync(...args);
  if (isArchivePath(args[0])) { fdPaths.set(fd, args[0]); counts.archiveOpens += 1; }
  return fd;
};
const realCloseSync = fs.closeSync;
fs.closeSync = (fd) => { fdPaths.delete(fd); return realCloseSync(fd); };
const realReadSync = fs.readSync;
fs.readSync = (...args) => {
  const read = realReadSync(...args);
  if (fdPaths.has(args[0])) counts.archiveBytesRead += read;
  return read;
};
syncBuiltinESMExports();

function parseArgs(argv) {
  const options = { side: "candidate", lib: resolve("lib"), mode: "measure", dir: null, rows: 20000, knowledgeRows: 20000, layout: "segmented", reads: false, profile: null };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--json") continue;
    if (key === "--build") { options.mode = "build"; continue; }
    if (key === "--measure") { options.mode = "measure"; continue; }
    if (key === "--reads") { options.reads = true; continue; }
    if (key === "--skip-scans") { options.skipScans = true; continue; }
    if (key === "--additive") { options.additive = true; continue; }
    const value = argv[index + 1];
    index += 1;
    if (key === "--side") options.side = value;
    else if (key === "--lib") options.lib = resolve(value);
    else if (key === "--dir") options.dir = resolve(value);
    else if (key === "--rows") options.rows = Number(value);
    else if (key === "--knowledge-rows") options.knowledgeRows = Number(value);
    else if (key === "--profile") options.profile = resolve(value);
    else if (key === "--layout") {
      if (!["segmented", "single", "additive"].includes(value)) throw new Error(`unknown layout ${value}`);
      options.layout = value;
    } else throw new Error(`unknown option ${key}`);
  }
  if (options.mode === "measure" && !options.dir) throw new Error("--measure requires --dir");
  if (options.mode === "build" && !options.dir) throw new Error("--build requires --dir");
  if (options.mode === "measure" && !globalThis.gc) throw new Error("--measure requires --expose-gc");
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
 * Seed one archive tree, in the shape a long-running host has: most of the
 * history is sealed into segments and only the newest quarter is in the active
 * file. Leaving every record in one oversized active file would measure the
 * rotation path instead of the read path.
 */
async function build(options) {
  const root = options.dir;
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, "state.json"), JSON.stringify({ evolution: { schema: 4 } }), { mode: 0o600 });
  await writeFile(join(root, "events.jsonl"), "");
  const sizes = {};
  const written = {};
  for (const [collection, buildRow] of [["observations", observationRow], ["knowledge", knowledgeRow]]) {
    const count = collection === "knowledge" ? options.knowledgeRows : options.rows;
    let bytes = 0;
    const lines = [];
    for (let index = 0; index < count; index += 1) {
      const line = JSON.stringify(buildRow(index));
      bytes += Buffer.byteLength(line) + 1;
      lines.push(line);
    }
    sizes[collection] = bytes;
    written[collection] = lines.length;
    if (!lines.length) continue;
    const path = join(root, `state.json.${collection}-archive.jsonl`);
    const split = options.layout === "single" ? 0 : Math.floor(lines.length * 0.75);
    const sealed = lines.slice(0, split);
    const active = lines.slice(split);
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
  // The row counts live beside the fixture so a measuring process never has to
  // read the archive to know how large it is - a whole-file count here showed up
  // as the scan's peak RSS in an early run.
  await writeFile(join(root, "counts.json"), JSON.stringify(written), { mode: 0o600 });
  return { root, sizes, written };
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

async function measure(options) {
  // Every run gets its own copy: the port writes a lock, an index document and
  // an event log, and a second run over the same tree would start from a
  // different durable state than the first.
  const root = await mkdtemp(join(tmpdir(), "dsh-cold-scan-"));
  const data = join(root, "data");
  await cp(options.dir, data, { recursive: true });
  const { backend, ctx } = await portableFixture(data);
  const dockyard = join(data, "dockyard");
  await mkdir(dockyard, { recursive: true });
  for (const name of ["observations", "knowledge"]) {
    const from = join(data, `state.json.${name}-archive.jsonl`);
    if (!fs.existsSync(from)) continue;
    const target = join(dockyard, `state.json.${name}-archive.jsonl`);
    fs.renameSync(from, target);
    if (fs.existsSync(`${from}.segments`)) fs.renameSync(`${from}.segments`, `${target}.segments`);
  }
  const eventLog = join(data, "events.jsonl");
  await writeFile(eventLog, "");
  const gc = { count: 0, ms: 0 };
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) { gc.count += 1; gc.ms += entry.duration; }
  });
  observer.observe({ entryTypes: ["gc"] });
  const libs = {
    domain: await import(pathToFileURL(join(options.lib, "dockyard-domain/index.js")).href),
    storage: await import(pathToFileURL(join(options.lib, "domain-storage.js")).href),
  };
  // What the fixture actually holds, recorded when it was built: a run that
  // silently measures a smaller archive than the documentation claims is worse
  // than a failed run, so the counts the port reports are asserted below.
  const expected = JSON.parse(await fs.promises.readFile(join(options.dir, "counts.json"), "utf8"));
  const heap = () => { globalThis.gc(); globalThis.gc(); return process.memoryUsage().heapUsed; };
  const snapshotCounts = () => {
    const snapshot = { ...counts };
    counts.archiveRowsParsed = 0; counts.archiveBytesRead = 0; counts.archiveOpens = 0;
    return snapshot;
  };
  let port = null;
  try {
    const base = heap();
    // Everything before this point (fixture copy, the line count above) is not
    // part of the open: count from here so the open's read volume is its own.
    snapshotCounts();
    const openCpu = process.cpuUsage();
    const openStart = performance.now();
    port = await libs.storage.openDomainStorage(ctx, { presetDir: data, eventBridgePath: eventLog, eventBridgeKey: "b".repeat(64) });
    const openWallMs = performance.now() - openStart;
    const openUsed = process.cpuUsage(openCpu);
    const opened = snapshotCounts();
    const afterOpen = heap();
    const afterOpenRss = process.memoryUsage().rss;
    const scans = {};
    let heapBefore = afterOpen;
    // `--profile` narrows the V8 CPU profile to the scan phase, so the profile
    // describes the read path instead of the port opening and the fixture count.
    const session = options.profile ? new (await import("node:inspector")).Session() : null;
    if (session) { session.connect(); await new Promise((done) => session.post("Profiler.enable", done)); await new Promise((done) => session.post("Profiler.start", done)); }
    for (const [collection, expectedCount] of options.skipScans ? [] : Object.entries(expected)) {
      const gcStart = { ...gc };
      const cpu = process.cpuUsage();
      const start = performance.now();
      const result = port.query(collection, 20);
      const wallMs = performance.now() - start;
      const used = process.cpuUsage(cpu);
      const counted = snapshotCounts();
      const after = heap();
      if (result.count !== expectedCount) {
        throw new Error(`${collection}: the port loaded ${result.count} rows, the fixture holds ${expectedCount}`);
      }
      scans[collection] = {
        wallMs: round(wallMs), cpuMs: round((used.user + used.system) / 1000),
        count: result.count, expected: expectedCount,
        heapDeltaMiB: MiB(after - heapBefore),
        gcCount: gc.count - gcStart.count, gcMs: round(gc.ms - gcStart.ms),
        rssMiB: MiB(process.memoryUsage().rss),
        ...counted,
      };
      heapBefore = after;
    }
    if (session) {
      const profile = await new Promise((done, fail) => session.post("Profiler.stop", (error, result) => error ? fail(error) : done(result.profile)));
      session.disconnect();
      fs.writeFileSync(options.profile, JSON.stringify(profile));
    }
    const reads = {};
    if (options.reads) {
      const timed = (label, run) => {
        const samples = [];
        for (let index = 0; index < 5; index += 1) {
          const start = performance.now();
          run();
          samples.push(round(performance.now() - start));
        }
        reads[label] = { medianMs: round(median(samples)), samples };
      };
      timed("query", () => port.query("observations", 50));
      timed("recall", () => port.recall({ why: "edge cache warmup latency", target: TARGET, impactScope: ["runtime"], successMetrics: ["p95 latency decreases"] }, {}));
      // One knowledge-bearing write: the read that archives an evicted row and
      // continues the cached digest. It is the common write path, measured apart
      // from the scan so its cost cannot be read as the scan's.
      const observeSamples = [];
      const observeCounts = [];
      for (let index = 0; index < 5; index += 1) {
        snapshotCounts();
        const cpu = process.cpuUsage();
        const start = performance.now();
        await port.observe({ code: "HOST_OPERATION_FAILED", target: `${TARGET}-write-${index}` });
        const used = process.cpuUsage(cpu);
        observeSamples.push({ wallMs: round(performance.now() - start), cpuMs: round((used.user + used.system) / 1000), ...snapshotCounts() });
        observeCounts.push(observeSamples.at(-1));
      }
      reads.observe = {
        medianWallMs: round(median(observeCounts.map((sample) => sample.wallMs))),
        medianCpuMs: round(median(observeCounts.map((sample) => sample.cpuMs))),
        samples: observeSamples,
      };
    }
    const retained = heap();
    const output = {
      side: options.side, lib: options.lib, mode: "measure", layout: options.layout,
      node: process.version, platform: `${process.platform}/${process.arch}`, cpus: cpus().length,
      loadAverage: Number(loadavg()[0]?.toFixed(2)) || undefined,
      rows: options.rows, knowledgeRows: options.knowledgeRows,
      open: { wallMs: round(openWallMs), cpuMs: round((openUsed.user + openUsed.system) / 1000), heapDeltaMiB: MiB(afterOpen - base), ...opened },
      scans, reads: options.reads ? reads : null,
      retainedMiB: MiB(retained - base), heapMiB: MiB(retained), rssMiB: MiB(process.memoryUsage().rss),
      live: memoryBreakdown(),
      peakRssMiB: MiB(process.resourceUsage().maxRSS * 1024),
      peakRssAfterOpenMiB: MiB(afterOpenRss),
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
const output = options.mode === "build" ? await build(options) : await measure(options);
process.stdout.write(`${JSON.stringify(output)}\n`);
