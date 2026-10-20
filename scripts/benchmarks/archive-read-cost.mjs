// Cold-archive read/index cost, measured through public EvolutionMemory paths
// only (load, recordObservation; no private method is called directly):
//
//   mutation        load() then ONE recordObservation() carrying a knowledge key
//                   no archived record has: the cost of the first cold append of
//                   a process. Reports wall time and the bytes
//                   readFile/readFileSync returned, attributed per file.
//   mutation-batch  load() then 32 recordObservation() calls on the same
//                   instance, with a hot window of 8 so the later calls evict
//                   into the active archive file. This is the steady state a
//                   long-running profile is in, and the number the per-mutation
//                   curve has to be read from: the cumulative cost of repeated
//                   appends is `batch` times it.
//   load            load({ snapshot: false }) on a fresh instance with the
//                   archive index document present: the restart cost.
//   load-noindex    the same with the index document deleted - the missing-index
//                   fallback, where every file is read and parsed.
//   hash-sealed     read + sha256 of every sealed segment: exactly what a
//                   load-time checksum re-verification of the sealed tier would
//                   add to `load`. Not a code path; it is the cost the
//                   `byteSize`-only sealed check currently avoids.
//   key-fallback    `knowledgeKeyOf` over every fixture observation row: what is
//                   left of the cold scan in `#sourceMatches` once the bytes are
//                   cached, because a row whose stored key is not the event's key
//                   is re-identified from its own fields.
//
// Only readFile/readFileSync are accounted, and both are patched on the CommonJS
// exports of node:fs / node:fs/promises *before* any ES module wrapping them is
// instantiated, which is why this file takes fs through createRequire and
// imports the memory module dynamically. That is the whole accounting surface:
// memory.js reads archives with those two functions only.
//
// Fixture: a temporary state root with, per collection, one active archive file
// and three sealed segments (sealed:active = 3:1), records split 50/50 between
// knowledge-bearing observations and the knowledge accumulator rows those
// observations produce. Observation scopes repeat over 64 components, so the
// 40 000-row scale really has archived rows the measured append matches. Every
// record carries a 96-byte summary, so a row is ~300 bytes on disk - the order of
// magnitude real rows have. Nothing outside the temporary root is read or
// written; the real DSH_HOME is never touched.
//
// Run with --expose-gc for the retained-heap columns: `mutation-batch` reports
// heapUsed right after load and right after the appends, both after an explicit
// gc, so the delta is what answering those appends kept alive. Only the
// difference between two sides over identical fixtures is meaningful.
//
// node --expose-gc scripts/benchmarks/archive-read-cost.mjs
//   [--memory <file>]... [--scales 2000,10000,40000] [--samples N]
//   [--rounds N] [--warmup N] [--out <path>] [--json]
//
// --memory may be given twice: the two sides then alternate (round 1 A/B, round
// 2 B/A, ...) over identical fixtures and both are reported with the ratio.
// Omit it to measure the working tree's lib/dockyard-domain/memory.js. Relative
// imports of a --memory file are rebased onto this repository's
// lib/dockyard-domain/, so a snapshot of another revision can be measured as-is.
// Sample timings are milliseconds. Fixture creation, index priming, snapshots
// and hashing of the fixture itself are outside every timed interval. Each
// (side, scale) pair imports its own module copy, so the per-process archive
// scan memo of one scale cannot be reused by the next.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { arch, cpus, loadavg, release, tmpdir, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const fs = require("node:fs");
const fsp = require("node:fs/promises");

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const DOMAIN = join(REPO, "lib", "dockyard-domain");
const NOW = "2026-10-12T00:00:00.000Z";
const { knowledgeKeyOf } = await import(pathToFileURL(join(DOMAIN, "knowledge.js")).href);

// ---------------------------------------------------------------- accounting
const counters = { calls: 0, bytes: 0, byFile: new Map() };
/** A sealed segment's basename repeats across collections; its directory carries the collection. */
const fileLabel = (path) => {
  const parts = String(path).split("/");
  const parent = parts.at(-2) ?? "";
  return parent.endsWith(".segments") ? `${parent.replace(/^state\.json\./, "").replace(/\.segments$/, "")}/${parts.at(-1)}` : parts.at(-1);
};
const account = (result, path) => {
  const bytes = typeof result === "string" ? Buffer.byteLength(result) : (result?.byteLength ?? 0);
  counters.calls += 1;
  counters.bytes += bytes;
  const name = fileLabel(path);
  counters.byFile.set(name, (counters.byFile.get(name) ?? 0) + bytes);
  return result;
};
const plainReadFileSync = fs.readFileSync;
const plainReadFile = fsp.readFile;
const plainWriteFile = fsp.writeFile;
fs.readFileSync = function accounted(...args) { return account(plainReadFileSync.apply(this, args), args[0]); };
fsp.readFile = async function accounted(...args) { return account(await plainReadFile.apply(this, args), args[0]); };
function begin() { counters.calls = 0; counters.bytes = 0; counters.byFile = new Map(); }
function end(extra = {}) {
  return {
    ...extra,
    readCalls: counters.calls,
    readBytes: counters.bytes,
    readByFile: Object.fromEntries([...counters.byFile].filter(([, bytes]) => bytes > 0)),
  };
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const round = (value) => Number(value.toFixed(3));
const summarize = (samples) => ({ samples: samples.length, medianMs: round(median(samples)), minMs: round(Math.min(...samples)), maxMs: round(Math.max(...samples)) });

// ------------------------------------------------------------------- options
function parseArgs(args) {
  const options = { memories: [], scales: [2000, 10000, 40000], samples: 2, rounds: 2, warmup: 1, batch: 32, out: null, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--json") { options.json = true; continue; }
    if (key === "--help") {
      console.log("Usage: node scripts/benchmarks/archive-read-cost.mjs [--memory <file>]... [--scales 2000,10000,40000] [--samples N] [--rounds N] [--warmup N] [--out <path>] [--json]\n--memory twice selects alternating A/B sides over identical fixtures.");
      return null;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${key}`);
    index += 1;
    if (key === "--memory") options.memories.push(resolve(value));
    else if (key === "--scales") options.scales = value.split(",").map(Number);
    else if (key === "--out") options.out = resolve(value);
    else if (["--samples", "--rounds", "--warmup", "--batch"].includes(key)) options[key.slice(2)] = Number(value);
    else throw new Error(`unknown option ${key}`);
  }
  for (const key of ["samples", "rounds", "warmup", "batch"]) {
    if (!Number.isSafeInteger(options[key]) || options[key] < (key === "warmup" ? 0 : 1)) throw new Error(`invalid --${key}`);
  }
  if (!options.scales.length || options.scales.some((rows) => !Number.isSafeInteger(rows) || rows < 200)) throw new Error("invalid --scales: expected integers >= 200");
  const sides = options.memories.length ? options.memories : [join(DOMAIN, "memory.js")];
  if (sides.length > 2) throw new Error("--memory accepts at most two sides");
  return { ...options, sides };
}

// ---------------------------------------------------------------- memory load
const scratch = await fsp.mkdtemp(join(tmpdir(), "dsh-archive-read-cost-"));
/**
 * Write one copy of a side with its relative imports rebased onto this
 * repository's lib/dockyard-domain/, and return the URL a fresh module instance
 * of it can be imported from. A copy per (side, scale) keeps the two sides -
 * and the process-local archive scan memo each module holds - independent.
 */
async function sideCopyUrl(file, label) {
  const source = await plainReadFile(file, "utf8");
  const rebased = source.replace(/from (["'])(\.\.?\/[^"']+)\1/g,
    (match, quote, specifier) => `from ${quote}${new URL(specifier, pathToFileURL(join(DOMAIN, "memory.js")).href).href}${quote}`);
  const copy = join(scratch, `memory-${basename(label)}.mjs`);
  await plainWriteFile(copy, rebased);
  return pathToFileURL(copy).href;
}

/**
 * A fresh module instance of one side. The archive scan memo is module scope,
 * so a restart measured with an already-imported copy would answer from the
 * previous load's scan: every sample gets its own instance, exactly as a real
 * restart gets its own process. Importing happens outside every timed interval.
 */
let moduleInstance = 0;
const freshClass = async (url) => (await import(`${url}?instance=${(moduleInstance += 1)}`)).EvolutionMemory;

class StateStore {
  constructor(filePath) { this.filePath = filePath; }
  async load() { try { return JSON.parse(await plainReadFile(this.filePath, "utf8")); } catch { return {}; } }
  async save(state) { await plainWriteFile(this.filePath, JSON.stringify(state), { mode: 0o600 }); }
  update(updater) { return (async () => this.save(await updater(await this.load())))(); }
}

// ------------------------------------------------------------------- fixture
// 50% knowledge-bearing observations over 64 repeated component scopes, 50%
// knowledge accumulator rows keyed by the canonical key of those observations.
function buildRecords(rows) {
  const observations = [];
  const knowledge = [];
  for (let index = 0; index < rows; index += 1) {
    const occurredAt = new Date(Date.parse(NOW) - (rows - index) * 1000).toISOString();
    const observation = {
      id: `observation-${index}`, source: "component", type: "component/observation",
      componentId: `component-${index % 64}`, severity: "info",
      summary: "observation-summary-".padEnd(96, "o"),
      metrics: { memoryUsage: index % 1024, cpuUsage: index % 37 }, recordedAt: occurredAt,
    };
    // Written rows carry their canonical key (`#append` sets it), which is what
    // lets a reader compare a stored key instead of re-deriving one.
    const key = knowledgeKeyOf(observation);
    observation.knowledgeKey = key;
    observations.push(observation);
    knowledge.push({
      id: key, knowledgeKey: key, lastStatus: "info", occurrenceCount: 1, confidence: 0.5,
      summary: "knowledge-summary-".padEnd(96, "k"), sourceRefs: [`observations:observation-${index}`],
      recordedAt: occurredAt,
    });
  }
  return { observations, knowledge };
}

async function writeCollection(filePath, collection, records) {
  const path = `${filePath}.${collection}-archive.jsonl`;
  const directory = `${path}.segments`;
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const lines = records.map((record) => JSON.stringify(record));
  const sealed = lines.slice(0, Math.floor(lines.length * 0.75));
  const active = lines.slice(Math.floor(lines.length * 0.75));
  const perSegment = Math.ceil(sealed.length / 3) || 1;
  let segment = 1;
  for (let offset = 0; offset < sealed.length; offset += perSegment) {
    // Padded like production's segment names so the index entry ids match.
    await plainWriteFile(join(directory, `segment-${String(segment).padStart(12, "0")}.jsonl`), sealed.slice(offset, offset + perSegment).join("\n") + "\n", { mode: 0o600 });
    segment += 1;
  }
  await plainWriteFile(path, active.length ? active.join("\n") + "\n" : "", { mode: 0o600 });
  const bytes = (part) => (part.length ? Buffer.byteLength(part.join("\n") + "\n") : 0);
  return { path, directory, sealedBytes: bytes(sealed), activeBytes: bytes(active), sealedRows: sealed.length, activeRows: active.length };
}

async function createFixture(rows) {
  const home = await fsp.mkdtemp(join(scratch, `scale-${rows}-`));
  const filePath = join(home, "state.json");
  const { observations, knowledge } = buildRecords(rows);
  const layout = {
    observations: await writeCollection(filePath, "observations", observations),
    knowledge: await writeCollection(filePath, "knowledge", knowledge),
  };
  await plainWriteFile(filePath, JSON.stringify({ evolution: { schema: 4, observations: [], knowledge: [], coldArchives: {} } }), { mode: 0o600 });
  return {
    home, filePath, layout, observationRecords: observations,
    indexFile: `${filePath}.evolution-archive-index.json`,
    sealedBytes: layout.observations.sealedBytes + layout.knowledge.sealedBytes,
    activeBytes: layout.observations.activeBytes + layout.knowledge.activeBytes,
    sealedRows: layout.observations.sealedRows + layout.knowledge.sealedRows,
    activeRows: layout.observations.activeRows + layout.knowledge.activeRows,
  };
}

const memoryOptions = (fixture) => ({ stateStore: new StateStore(fixture.filePath), clock: () => new Date(NOW), mutationAuthority: { assertMutation() {} } });

/** Every file under the temporary root, so a sample can be repeated on identical bytes. */
async function captureFixture(fixture) {
  const snapshot = new Map();
  const walk = async (directory) => {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else snapshot.set(path, await plainReadFile(path));
    }
  };
  await walk(fixture.home);
  return snapshot;
}

/**
 * Restore the fixture bytes a measurement started from. Every sample therefore
 * sees the same cold history, the same state file and the same primed index,
 * and no sample can inherit the previous sample's archived rows.
 */
async function restoreFixture(fixture, snapshot) {
  const walk = async (directory) => {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await walk(path); await fsp.rm(path, { recursive: true, force: true }); }
      else await fsp.rm(path, { force: true });
    }
  };
  await walk(fixture.home);
  for (const [path, bytes] of snapshot) {
    await fsp.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await plainWriteFile(path, bytes, { mode: 0o600 });
  }
}

// ------------------------------------------------------------------ measuring
const SAMPLE_ORDER = ["mutation", "mutation-batch", "load", "hash-sealed", "load-noindex", "key-fallback"];

async function measureMutation(EvolutionMemory, fixture) {
  const memory = new EvolutionMemory(memoryOptions(fixture));
  await memory.load({ snapshot: false });
  begin();
  const start = performance.now();
  await memory.recordObservation({
    id: `appended-${Math.random().toString(16).slice(2)}`, source: "component", type: "component/observation",
    componentId: `appended-${Math.random().toString(16).slice(2)}`, severity: "warn",
    summary: "appended-observation".padEnd(96, "a"),
  });
  const ms = performance.now() - start;
  return end({ ms: round(ms) });
}

/**
 * The steady state: `batch` appends on one loaded instance, with a hot window of
 * 8 so every append after the eighth evicts one record into the active archive
 * file. Appends alternate between a scope whose knowledge key the archive
 * already owns and a scope it has never seen.
 */
async function measureBatch(EvolutionMemory, fixture, batch) {
  const memory = new EvolutionMemory({ ...memoryOptions(fixture), hotEntries: 8 });
  await memory.load({ snapshot: false });
  globalThis.gc?.();
  const heapBeforeMiB = Number((process.memoryUsage().heapUsed / 2 ** 20).toFixed(1));
  begin();
  const start = performance.now();
  for (let index = 0; index < batch; index += 1) {
    await memory.recordObservation({
      id: `batch-${index}-${Math.random().toString(16).slice(2)}`, source: "component", type: "component/observation",
      componentId: index % 2 === 0 ? "component-7" : `batch-scope-${index}`, severity: "warn",
      summary: "batched-observation".padEnd(96, "b"),
    });
  }
  const ms = performance.now() - start;
  // Retained parse cost: the same live objects on both sides, so the difference
  // between sides is what a cached parse holds. Only meaningful with
  // --expose-gc; without it the number is a lower bound.
  globalThis.gc?.();
  const heapAfterMiB = Number((process.memoryUsage().heapUsed / 2 ** 20).toFixed(1));
  return end({ ms: round(ms), perMutationMs: round(ms / batch), batchSize: batch, hotEntries: 8, heapBeforeMiB, heapAfterMiB, heapDeltaMiB: Number((heapAfterMiB - heapBeforeMiB).toFixed(1)) });
}

async function measureLoad(EvolutionMemory, fixture, { dropIndex = false } = {}) {
  if (dropIndex) await fsp.rm(fixture.indexFile, { force: true });
  const memory = new EvolutionMemory(memoryOptions(fixture));
  begin();
  const start = performance.now();
  await memory.load({ snapshot: false });
  const ms = performance.now() - start;
  return end({ ms: round(ms) });
}

/**
 * What `#sourceMatches` still has to do per mutation once the read is cached: for
 * every archived source row whose stored key is not the event's key, it recomputes
 * the canonical key from the row's own fields. This measures that fallback over
 * exactly the fixture's observation rows, which is the same set the filter visits.
 */
async function measureKeyFallbackScan(fixture) {
  begin();
  const start = performance.now();
  let matched = 0;
  for (const record of fixture.observationRecords) if (knowledgeKeyOf(record) === "knowledge:none") matched += 1;
  const ms = performance.now() - start;
  return end({ ms: round(ms), scannedRows: fixture.observationRecords.length, matched });
}

async function measureSealedHashing(fixture) {
  const files = [];
  for (const layout of Object.values(fixture.layout)) {
    for (const name of await fsp.readdir(layout.directory)) files.push(join(layout.directory, name));
  }
  begin();
  const start = performance.now();
  let last = "";
  for (const file of files) last = sha256(await fsp.readFile(file)).slice(0, 12);
  const ms = performance.now() - start;
  return end({ ms: round(ms), sealedFiles: files.length, lastDigest: last });
}

/** Load once so the archive index document exists exactly as production writes it. */
async function primeIndex(EvolutionMemory, fixture) {
  const memory = new EvolutionMemory(memoryOptions(fixture));
  await memory.load({ snapshot: false });
  try {
    const raw = await plainReadFile(fixture.indexFile);
    const document = JSON.parse(raw);
    return { bytes: raw.byteLength, segments: document.segments.length, sealed: document.segments.filter((entry) => entry.sealed).length, active: document.segments.filter((entry) => !entry.sealed).length };
  } catch { return null; }
}

async function measureScale(side, scale, options, order) {
  const url = await sideCopyUrl(side.file, `${side.label}-${scale}`);
  const fixture = await createFixture(scale);
  const result = {
    rows: scale, sealedRows: fixture.sealedRows, activeRows: fixture.activeRows,
    sealedBytes: fixture.sealedBytes, activeBytes: fixture.activeBytes, coldBytes: fixture.sealedBytes + fixture.activeBytes,
    index: await primeIndex(await freshClass(url), fixture), samples: {}, raw: {},
  };
  // Prime the index, then freeze those bytes: every sample below starts from
  // exactly this cold history, state file and index document.
  const snapshot = await captureFixture(fixture);
  const collected = Object.fromEntries(SAMPLE_ORDER.map((name) => [name, []]));
  for (let roundIndex = 0; roundIndex < options.rounds; roundIndex += 1) {
    for (const kind of order) {
      for (let sample = 0; sample < options.samples + options.warmup; sample += 1) {
        const warmup = sample < options.warmup;
        await restoreFixture(fixture, snapshot);
        let measured = null;
        const EvolutionMemory = await freshClass(url);
        if (kind === "mutation") measured = await measureMutation(EvolutionMemory, fixture);
        else if (kind === "mutation-batch") measured = await measureBatch(EvolutionMemory, fixture, options.batch);
        else if (kind === "load") measured = await measureLoad(EvolutionMemory, fixture);
        else if (kind === "hash-sealed") measured = await measureSealedHashing(fixture);
        else if (kind === "key-fallback") measured = await measureKeyFallbackScan(fixture);
        else if (kind === "load-noindex") measured = await measureLoad(EvolutionMemory, fixture, { dropIndex: true });
        if (measured && !warmup) collected[kind].push(measured);
      }
    }
  }
  for (const kind of SAMPLE_ORDER) {
    const entries = collected[kind];
    result.samples[kind] = {
      ...summarize(entries.map((entry) => entry.ms)),
      medianReadCalls: median(entries.map((entry) => entry.readCalls)),
      medianReadBytes: median(entries.map((entry) => entry.readBytes)),
      readByFile: entries.at(-1)?.readByFile ?? {},
      ...(entries.at(-1)?.sealedFiles ? { sealedFiles: entries.at(-1).sealedFiles } : {}),
      ...(entries.at(-1)?.perMutationMs !== undefined ? { medianPerMutationMs: median(entries.map((entry) => entry.perMutationMs)), batchSize: entries.at(-1).batchSize } : {}),
      ...(entries.at(-1)?.heapDeltaMiB !== undefined ? {
        medianHeapBeforeMiB: median(entries.map((entry) => entry.heapBeforeMiB)),
        medianHeapAfterMiB: median(entries.map((entry) => entry.heapAfterMiB)),
        medianHeapDeltaMiB: median(entries.map((entry) => entry.heapDeltaMiB)),
      } : {}),
    };
    result.raw[kind] = entries;
  }
  await fsp.rm(fixture.home, { recursive: true, force: true });
  return result;
}

// ----------------------------------------------------------------------- main
const options = parseArgs(process.argv.slice(2));
if (!options) process.exit(0);
const baseMetadata = async (file, label) => {
  const source = await plainReadFile(file, "utf8");
  return { label, file, sourceSha256: sha256(Buffer.from(source)), sourceBytes: Buffer.byteLength(source) };
};
const sides = [];
for (const [index, file] of options.sides.entries()) sides.push(await baseMetadata(file, String.fromCharCode(65 + index)));
const report = {
  node: process.version, platform: process.platform, release: release(), arch: arch(),
  cpu: cpus()[0]?.model ?? "unknown", cpus: cpus().length, memoryGiB: Number((totalmem() / 2 ** 30).toFixed(1)),
  loadavg: loadavg().map((value) => Number(value.toFixed(2))),
  scope: "public EvolutionMemory paths only; readFile/readFileSync bytes attributed per file name; fixture creation, index priming and snapshots outside every timed interval; no official host transaction, fsync or multi-process work",
  fixture: "temporary state root; per collection 3 sealed segments + 1 active archive file; 50% knowledge-bearing observations over 64 repeated component scopes, 50% knowledge accumulator rows; ~300 byte rows",
  scales: options.scales, samples: options.samples, rounds: options.rounds, warmup: options.warmup, order: SAMPLE_ORDER,
  sides, results: {},
};
// Round order alternates A/B then B/A over the two sides; a single side has one order.
for (const scale of options.scales) {
  const rotated = options.rounds > 1 && sides.length === 2 ? [sides, [...sides].reverse()] : [sides];
  const perSide = new Map();
  for (const roundSides of rotated) {
    for (const side of roundSides) {
      const measured = await measureScale(side, scale, options, SAMPLE_ORDER);
      const existing = perSide.get(side.label);
      if (!existing) { perSide.set(side.label, measured); continue; }
      // Fold the second round's samples into the first so the report keeps every round.
      for (const kind of SAMPLE_ORDER) existing.raw[kind].push(...measured.raw[kind]);
      for (const kind of SAMPLE_ORDER) {
        const entries = existing.raw[kind];
        existing.samples[kind] = {
          ...summarize(entries.map((entry) => entry.ms)),
          medianReadCalls: median(entries.map((entry) => entry.readCalls)),
          medianReadBytes: median(entries.map((entry) => entry.readBytes)),
          readByFile: entries.at(-1)?.readByFile ?? {},
          ...(measured.samples[kind].sealedFiles ? { sealedFiles: measured.samples[kind].sealedFiles } : {}),
          ...(measured.samples[kind].medianPerMutationMs !== undefined ? { medianPerMutationMs: median(entries.map((entry) => entry.perMutationMs)), batchSize: measured.samples[kind].batchSize } : {}),
          ...(measured.samples[kind].medianHeapDeltaMiB !== undefined ? {
            medianHeapBeforeMiB: median(entries.map((entry) => entry.heapBeforeMiB)),
            medianHeapAfterMiB: median(entries.map((entry) => entry.heapAfterMiB)),
            medianHeapDeltaMiB: median(entries.map((entry) => entry.heapDeltaMiB)),
          } : {}),
        };
      }
    }
  }
  for (const [label, measured] of perSide) {
    report.results[`${label}@${scale}`] = { side: label, ...measured };
    if (!options.json) {
      const cell = (name) => `${name}=${measured.samples[name].medianMs}ms/read=${(measured.samples[name].medianReadBytes / 1024).toFixed(0)}KiB/${measured.samples[name].medianReadCalls}x`;
      console.log(`[${label} rows=${scale} cold=${(measured.coldBytes / 1024).toFixed(0)}KiB sealed=${(measured.sealedBytes / 1024).toFixed(0)}KiB active=${(measured.activeBytes / 1024).toFixed(0)}KiB] ` +
        `${cell("mutation")} ${cell("mutation-batch")} ${cell("load")} ${cell("load-noindex")} ${cell("hash-sealed")} ${cell("key-fallback")}`);
    }
  }
}
if (sides.length === 2) {
  report.ratios = {};
  for (const scale of options.scales) {
    const a = report.results[`A@${scale}`];
    const b = report.results[`B@${scale}`];
    if (!a || !b) continue;
    report.ratios[scale] = Object.fromEntries(SAMPLE_ORDER.map((name) => [name, {
      aMedianMs: a.samples[name].medianMs, bMedianMs: b.samples[name].medianMs,
      bOverA: round(b.samples[name].medianMs / a.samples[name].medianMs),
      aMedianReadBytes: a.samples[name].medianReadBytes, bMedianReadBytes: b.samples[name].medianReadBytes,
    }]));
  }
}
if (options.json) console.log(JSON.stringify(report, null, 2));
else console.log(JSON.stringify({ summary: { sides: report.sides, ratios: report.ratios ?? null } }));
if (options.out) {
  await fsp.mkdir(dirname(options.out), { recursive: true });
  await plainWriteFile(options.out, JSON.stringify(report, null, 2) + "\n");
  if (!options.json) console.log(`wrote ${options.out}`);
}
await fsp.rm(scratch, { recursive: true, force: true });
