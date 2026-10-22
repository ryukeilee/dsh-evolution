// A/B benchmark and cost attribution for the archive transaction I/O.
//
// Every domain write opens one transaction: `mirrorArchives()` builds a full
// hard-link view of the live archive tree, the writer works inside that stage,
// `changedArchiveFiles()` hashes what changed, `syncStage()` makes it durable,
// and `installArchiveFiles()` publishes the change list onto the live tree
// before the stage is removed. The question this script answers is where that
// work actually goes, and what a candidate implementation saves.
//
// Two sides run in one process, alternating which goes first, against identical
// fixtures: the candidate is this working tree, the baseline is a copy of
// `lib/` with only `lib/archive-stage.js` restored from a git revision. Both
// sides are shape-guarded below so a reproduction cannot silently compare the
// same code twice.
//
//   node scripts/benchmarks/archive-stage-io.mjs [--baseline <rev>] [--rounds 3] [--writes 12] [--sealed 0] [--sealed 216]
//
// Each scenario is measured twice per side: a clean pass for wall clock and CPU
// (the numbers to trust), and an instrumented pass that counts filesystem calls
// per transaction and attributes them to the stage, the live tree or the
// official backend (indicative timings only, the wrappers themselves cost time).
// Equivalence is checked separately under a frozen clock and a deterministic
// UUID sequence, where the durable output of both sides has to be byte-identical.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";
import { pathToFileURL, fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const repeated = (name) => args.reduce((values, value, index) => (value === `--${name}` ? [...values, args[index + 1]] : values), []);
const BASELINE_REV = option("baseline", "adcdb2f");
const ROUNDS = Number(option("rounds", 3));
const WRITES = Number(option("writes", 15));
const WARMUP = Number(option("warmup", 60));
const SCENARIOS = repeated("sealed").map(Number);
if (!SCENARIOS.length) SCENARIOS.push(0, 216);
const FROZEN_NOW = Date.parse("2026-11-02T00:00:00.000Z");
const SEGMENT_BYTES = 1024;

// Shape guards. The baseline must install a changed archive by rewriting its
// bytes into a temporary file and fsyncing it; the candidate must publish the
// already-durable staged inode instead. A revision that matches neither cannot
// be compared by this script.
const BASELINE_ONLY = "fs.writeFileSync(temporary, content, { mode });";
const CANDIDATE_ONLY = "linkSync(staged, temporary)";

function materializeBaseline() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "archive-stage-io-baseline-"));
  fs.cpSync(path.join(REPO_ROOT, "lib"), path.join(directory, "lib"), { recursive: true });
  const stagePath = path.join(directory, "lib", "archive-stage.js");
  fs.writeFileSync(stagePath, execFileSync("git", ["-C", REPO_ROOT, "show", `${BASELINE_REV}:lib/archive-stage.js`], { encoding: "utf8" }));
  fs.symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(directory, "node_modules"));
  const source = fs.readFileSync(stagePath, "utf8");
  assert.equal(source.split(BASELINE_ONLY).length - 1, 1, `baseline ${BASELINE_REV} must install by rewriting bytes exactly once`);
  assert.equal(source.split(CANDIDATE_ONLY).length - 1, 0, `baseline ${BASELINE_REV} must not publish the staged inode`);
  return directory;
}

function resetUuidSequence() {
  let seed = 0;
  const original = crypto.randomUUID;
  crypto.randomUUID = () => `${String(++seed).padStart(8, "0")}-0000-4000-8000-000000000000`;
  syncBuiltinESMExports();
  return () => { crypto.randomUUID = original; syncBuiltinESMExports(); };
}

/** `freeze` renders both sides byte-comparable; `advance` is the production
 *  condition (one millisecond per clock read) made reproducible. */
function installClock(mode) {
  const RealDate = Date;
  let millis = FROZEN_NOW;
  class StubDate extends RealDate {
    constructor(...values) {
      if (values.length > 0) super(...values);
      else if (mode === "advance") super(millis++);
      else super(FROZEN_NOW);
    }
    static now() { return mode === "advance" ? millis : FROZEN_NOW; }
  }
  Object.setPrototypeOf(StubDate, RealDate);
  globalThis.Date = StubDate;
  return () => { globalThis.Date = RealDate; };
}

const OBSERVATION_ROWS = Array.from({ length: 40 }, (_, index) => ({
  id: `seed-obs-${index}`, patternKey: `pattern-${index}`, type: "agent/error", severity: "error",
  observedAt: `2026-10-20T00:00:${String(index).padStart(2, "0")}.000Z`, message: `seeded observation ${index}`,
}));

/** A preset root that already holds a live archive: an observations active file
 *  (the file every write appends to) and, for the large scenario, sealed cycle
 *  segments plus the index that describes them. */
function seedFixture(root, sealed) {
  const archiveRoot = path.join(root, "dockyard");
  fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(archiveRoot, "state.json.observations-archive.jsonl"),
    `${OBSERVATION_ROWS.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
  if (!sealed) return;
  const directory = path.join(archiveRoot, "state.json.cycles-archive.jsonl.segments");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const index = [];
  for (let i = 0; i < sealed; i++) {
    const file = `segment-${String(i + 1).padStart(12, "0")}.jsonl`;
    const raw = `${JSON.stringify({ id: `cycle-${i}`, status: "observed", recordedAt: "2026-08-26T12:00:00.000Z", summary: "x".repeat(SEGMENT_BYTES) })}\n`;
    fs.writeFileSync(path.join(directory, file), raw, { mode: 0o600 });
    index.push({ collection: "cycles", file, sealed: true, checksumState: "final", byteSize: Buffer.byteLength(raw), sha256: crypto.createHash("sha256").update(raw).digest("hex") });
  }
  fs.writeFileSync(path.join(archiveRoot, "state.json.evolution-archive-index.json"),
    JSON.stringify({ schemaVersion: 1, segments: index }), { mode: 0o600 });
}

// A distinct target per write keeps each observation a distinct pattern, which is
// what makes the hot window overflow and evict: a repeated pattern is accumulated
// instead of archived, and the transaction would then have nothing to install.
const OBSERVATION = (index) => ({ type: "agent/error", code: "AGENT_ERROR", message: `synthetic failure ${index}`,
  target: `tool:stage-${index}`, componentId: "agent", severity: "error", status: "failed" });

/** Filesystem-call accounting. Two-path calls are attributed to the tree they
 *  write into, so the mirror (live -> stage) and the install (stage -> live) are
 *  told apart; fd-based calls are attributed through the path the fd opened. */
const TRACED = ["readFileSync", "writeFileSync", "appendFileSync", "linkSync", "renameSync", "unlinkSync",
  "mkdirSync", "rmSync", "fsyncSync", "openSync", "closeSync", "readdirSync", "lstatSync", "statSync",
  "copyFileSync", "existsSync", "fstatSync", "rmdirSync"];
const TWO_PATH = new Set(["linkSync", "renameSync", "copyFileSync"]);

function installer(roots) {
  const originals = new Map();
  const counters = new Map();
  const fileDescriptors = new Map();
  const workload = { mirrorLinks: 0, installLinks: 0, installRewrites: 0, installFsyncs: 0, calls: 0 };
  const bucketOf = (target) => {
    if (typeof target !== "string") return "other";
    if (target.startsWith(roots.staging)) return "stage";
    if (target.startsWith(roots.live)) return "live";
    if (target.startsWith(roots.official)) return "official";
    return "other";
  };
  const bump = (bucket, op, elapsed, bytes) => {
    workload.calls += 1;
    const key = `${bucket}\u0000${op}`;
    const entry = counters.get(key) ?? { bucket, op, calls: 0, ms: 0, bytes: 0 };
    entry.calls += 1; entry.ms += elapsed; entry.bytes += bytes ?? 0;
    counters.set(key, entry);
  };
  for (const name of TRACED) {
    originals.set(name, fs[name]);
    fs[name] = function traced(...values) {
      const started = performance.now();
      try {
        const result = originals.get(name).apply(this, values);
        if (name === "openSync" && typeof result === "number" && typeof values[0] === "string") fileDescriptors.set(result, values[0]);
        if (name === "closeSync") fileDescriptors.delete(values[0]);
        const target = name === "fsyncSync" ? fileDescriptors.get(values[0]) : (TWO_PATH.has(name) ? values[1] : values[0]);
        if (name === "linkSync") { if (bucketOf(values[1]) === "stage") workload.mirrorLinks += 1; if (bucketOf(values[1]) === "live") workload.installLinks += 1; }
        if (name === "writeFileSync" && bucketOf(values[0]) === "live" && String(values[0]).endsWith(".tmp")) workload.installRewrites += 1;
        if (name === "fsyncSync" && bucketOf(target) === "live" && String(target).endsWith(".tmp")) workload.installFsyncs += 1;
        const bytes = name === "readFileSync" && typeof result !== "string" && result?.byteLength !== undefined ? result.byteLength
          : name === "writeFileSync" && typeof values[1] === "string" ? Buffer.byteLength(values[1])
            : name === "writeFileSync" && values[1]?.byteLength !== undefined ? values[1].byteLength
              : name === "appendFileSync" && typeof values[1] === "string" ? Buffer.byteLength(values[1]) : 0;
        bump(bucketOf(target), name, performance.now() - started, bytes);
        return result;
      } catch (error) {
        bump(bucketOf(values[0]), `${name}!error`, performance.now() - started, 0);
        throw error;
      }
    };
  }
  syncBuiltinESMExports();
  return {
    reset() { counters.clear(); workload.calls = 0; workload.mirrorLinks = 0; workload.installLinks = 0; workload.installRewrites = 0; workload.installFsyncs = 0; },
    snapshot() {
      const rows = [...counters.values()].map((entry) => ({ ...entry, ms: Number(entry.ms.toFixed(3)) }));
      return rows.sort((left, right) => left.bucket.localeCompare(right.bucket) || right.ms - left.ms);
    },
    workloadOf(writes) { return Object.fromEntries(Object.entries(workload).map(([key, value]) => [key, Number((value / writes).toFixed(2))])); },
    restore() {
      for (const [name, method] of originals) fs[name] = method;
      syncBuiltinESMExports();
    },
  };
}

async function openPort(libDirectory, root) {
  const { openDomainStorage } = await import(pathToFileURL(path.join(libDirectory, "lib", "domain-storage.js")).href);
  const { DomainFacility } = await import("@deepseek-ai/dsh-storage-domain");
  const { JsonStorageBackend } = await import("@deepseek-ai/dsh-storage-json");
  const backend = new JsonStorageBackend(path.join(root, "official"));
  const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: "json" });
  const eventLog = path.join(root, "events.jsonl");
  fs.writeFileSync(eventLog, "");
  const port = await openDomainStorage(ctx, { presetDir: root, eventBridgePath: eventLog, eventBridgeKey: "b".repeat(64) });
  return { port, backend, ctx };
}

/** One measured scenario run. `trace` swaps in the call counter for the
 *  instrumented pass; the clean pass leaves the filesystem untouched. */
async function runScenario(libDirectory, { sealed, clockMode, trace, warmup }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-stage-io-"));
  seedFixture(root, sealed);
  const roots = { staging: path.join(root, "domain-staging"), live: path.join(root, "dockyard"), official: path.join(root, "official") };
  const counter = trace ? installer(roots) : null;
  const restoreUuid = resetUuidSequence();
  const restoreClock = installClock(clockMode);
  let opened = null, samples = [], perWrite = null, workload = null;
  try {
    opened = await openPort(libDirectory, root);
    const { port } = opened;
    // Warm-up drives the hot window past its limit so the measured writes are the
    // steady state: every observation evicts one and appends to the active
    // archive, which is the transaction this script measures.
    for (let warm = 0; warm < warmup; warm++) await port.observe(OBSERVATION(warm));
    const active = path.join(roots.live, "state.json.observations-archive.jsonl");
    const activeBefore = fs.existsSync(active) ? fs.statSync(active).size : 0;
    counter?.reset();
    for (let sample = 0; sample < WRITES; sample++) {
      const cpu = process.cpuUsage();
      const started = performance.now();
      await port.observe(OBSERVATION(1000 + sample));
      samples.push({ wallMs: performance.now() - started, cpuMs: (process.cpuUsage(cpu).user + process.cpuUsage(cpu).system) / 1000 });
    }
    if (counter) { perWrite = counter.snapshot().map((entry) => ({ ...entry, calls: entry.calls / WRITES, ms: Number((entry.ms / WRITES).toFixed(3)) })); workload = counter.workloadOf(WRITES); }
    // Workload guard: the measured writes have to move the active archive, and
    // the side has to publish it the way its implementation does.
    assert.ok(fs.statSync(active).size > activeBefore, "the measured writes must append to the active archive");
    const read = (file) => fs.readFileSync(file, "utf8");
    const durable = {
      document: read(path.join(root, "official", "evolution_domain.json")).split(root).join("<root>"),
      archives: fs.readdirSync(roots.live).sort().flatMap((name) => {
        const file = path.join(roots.live, name);
        if (fs.statSync(file).isDirectory()) {
          return fs.readdirSync(file).sort().map((nested) => [`${name}/${nested}`, read(path.join(file, nested)).split(root).join("<root>")]);
        }
        return [[name, read(file).split(root).join("<root>")]];
      }),
    };
    const stagingLeft = fs.existsSync(roots.staging) ? fs.readdirSync(roots.staging) : [];
    await port.close();
    opened = null;
    await opened?.backend.close?.();
    return { samples, perWrite, workload, durable, stagingLeft };
  } finally {
    if (opened) { try { await opened.port.close(); } catch {} try { await opened.backend.close(); } catch {} }
    counter?.restore();
    restoreClock();
    restoreUuid();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
const summarize = (run) => ({
  wallMs: median(run.samples.map((sample) => sample.wallMs)),
  cpuMs: median(run.samples.map((sample) => sample.cpuMs)),
  wallMsAll: run.samples.map((sample) => Number(sample.wallMs.toFixed(3))),
  stagingLeft: run.stagingLeft.length,
});

const baselineDirectory = materializeBaseline();
const SIDES = { baseline: () => baselineDirectory, candidate: () => REPO_ROOT };
process.on("exit", () => fs.rmSync(baselineDirectory, { recursive: true, force: true }));

const output = {
  baseline: BASELINE_REV, rounds: ROUNDS, writes: WRITES, warmup: WARMUP, sealed: [...SCENARIOS],
  environment: { node: process.version, platform: `${process.platform}/${process.arch}`, cpus: os.cpus().length,
    loadAverageAtStart: os.loadavg() },
  protocol: {
    measurementClock: "deterministic clock advancing 1 ms per read (production condition, reproducible)",
    equivalenceClock: "frozen at 2026-11-02T00:00:00.000Z; durable output must be byte-identical",
    order: "each round alternates which side runs first",
    fixture: "40 seeded rows in state.json.observations-archive.jsonl; the large scenario adds sealed 1 KiB cycle segments plus their index; the warm-up drives the hot observation window past its limit so every measured write appends to the active archive, which the run asserts",
    instrumentedPass: "a second pass per side with wrapped fs calls; two-path calls are attributed to the tree they write into, fsyncs through the fd's path",
  },
  scenarios: [],
};

for (const sealed of SCENARIOS) {
  const scenario = { sealed, rounds: [] };
  for (let round = 1; round <= ROUNDS; round++) {
    const order = round % 2 === 1 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    const measured = { round, order, sides: {} };
    for (const side of order) {
      const clean = summarize(await runScenario(SIDES[side](), { sealed, clockMode: "advance", trace: false, warmup: WARMUP }));
      const traced = await runScenario(SIDES[side](), { sealed, clockMode: "advance", trace: true, warmup: WARMUP });
      // The shape of the publish step is what the two sides are supposed to
      // differ in, so it is asserted rather than assumed.
      if (side === "baseline") {
        assert.ok(traced.workload.installRewrites > 0, "the baseline must publish by rewriting the changed bytes");
        assert.equal(traced.workload.installLinks, 0, "the baseline must not publish the staged inode");
      } else {
        assert.equal(traced.workload.installRewrites, 0, "the candidate must not rewrite an already durable staged file");
        assert.ok(traced.workload.installLinks > 0, "the candidate must publish the staged inode");
        assert.equal(traced.workload.installFsyncs, 0, "the candidate must not fsync a second copy of a durable file");
      }
      measured.sides[side] = { ...clean, attribution: traced.perWrite, workload: traced.workload };
    }
    // Equivalence is checked on every round in the large scenario only once at
    // the end: it is a byte comparison, not a measurement.
    scenario.rounds.push(measured);
  }
  const pick = (side, key) => scenario.rounds.map((round) => round.sides[side][key]);
  const attribution = (side) => {
    const merged = new Map();
    for (const round of scenario.rounds) {
      for (const entry of round.sides[side].attribution ?? []) {
        const key = `${entry.bucket}\u0000${entry.op}`;
        const row = merged.get(key) ?? { bucket: entry.bucket, op: entry.op, calls: [], ms: [] };
        row.calls.push(entry.calls); row.ms.push(entry.ms);
        merged.set(key, row);
      }
    }
    return [...merged.values()].map((row) => ({ bucket: row.bucket, op: row.op,
      callsPerWrite: Number(median(row.calls).toFixed(2)), msPerWrite: Number(median(row.ms).toFixed(3)) }))
      .sort((left, right) => right.msPerWrite - left.msPerWrite);
  };
  const workload = (side) => Object.fromEntries(Object.keys(scenario.rounds[0].sides[side].workload ?? {})
    .map((key) => [key, median(pick(side, "workload").map((entry) => entry[key]))]));
  scenario.summary = {
    perWrite: Object.fromEntries(Object.keys(SIDES).map((side) => [side, {
      wallMs: median(pick(side, "wallMs")), cpuMs: median(pick(side, "cpuMs")),
      wallRuns: pick(side, "wallMsAll").map((values) => median(values)),
      stagingLeft: Math.max(...pick(side, "stagingLeft")), workload: workload(side),
    }])),
    attribution: Object.fromEntries(Object.keys(SIDES).map((side) => [side, attribution(side)])),
  };
  output.scenarios.push(scenario);
}

// Equivalence: frozen clock, deterministic UUIDs, byte-identical durable output.
const equivalence = [];
for (const sealed of SCENARIOS) {
  const runs = {};
  for (const side of ["baseline", "candidate"]) {
    runs[side] = await runScenario(SIDES[side](), { sealed, clockMode: "freeze", trace: false, warmup: WARMUP });
  }
  assert.equal(runs.candidate.stagingLeft.length, 0, "a committed transaction must leave no staged directory");
  assert.equal(runs.candidate.durable.document, runs.baseline.durable.document,
    "both implementations must persist the same domain document under a frozen clock");
  assert.deepEqual(runs.candidate.durable.archives, runs.baseline.durable.archives,
    "both implementations must persist the same archive bytes under a frozen clock");
  equivalence.push({ sealed, durableByteIdentical: true, archiveFiles: runs.candidate.durable.archives.length });
}
output.equivalence = equivalence;
output.environment.loadAverageAtEnd = os.loadavg();
console.log(JSON.stringify(output, null, 2));
