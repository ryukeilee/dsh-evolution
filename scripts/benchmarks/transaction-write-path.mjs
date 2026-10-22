// A/B benchmark for the domain write path's commit shape.
//
// Every domain write opens one transaction: `installPending()` -> `mirrorArchives()`
// -> `createMemory(stage)` -> `work()` -> `changedArchiveFiles()` -> `syncStage()`
// -> publish the pending record -> install the staged files -> `hydrate()`. The two
// whole-document writes in that sequence (the pending record, then the record that
// clears it) are the largest single cost of a transaction, and they exist to
// sequence "the staged bytes are durable" before "the aggregate that describes
// them is durable".
//
// A transaction whose change list is empty has nothing to sequence. The candidate
// commits the document it ends at in one write and drops the stage; this script
// measures what that saves - and proves it changes no durable byte - against a
// baseline restored from git.
//
//   node scripts/benchmarks/transaction-write-path.mjs [--baseline <rev>] [--rounds 3] [--samples 9]
//
// Scenarios (each on the real official `DomainFacility` + `JsonStorageBackend`):
//   daily   - a committed history of 1000 events, then one new record per
//             transaction: the shape of a session whose collections are still
//             below their hot window, so no archive file changes
//   bulk    - ten new records per transaction: a bridge backlog, or one tool call
//             that emits a chain of events; crosses the hot window mid-run, so it
//             reports the cost of both shapes in one run
//   archive - a seeded active observation archive past its hot window, so every
//             transaction appends to the archive file (the no-regression case)
//   steady  - `flush()` with no new record: the every-agent-step path
//
// Each scenario runs a clean pass for wall clock and CPU (the numbers to trust) and
// an instrumented pass that counts the filesystem calls and whole-document writes
// per transaction (mechanism, not timing). A separate pass runs both sides under a
// frozen clock and a deterministic UUID sequence and requires the durable tree to
// be byte-identical.
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
const BASELINE_REV = option("baseline", "b943b21");
const ROUNDS = Number(option("rounds", 3));
const SAMPLES = Number(option("samples", 9));
const WARMUP = Number(option("warmup", 3));
const FROZEN_NOW = Date.parse("2026-11-02T00:00:00.000Z");
const HISTORY_EVENTS = Number(option("history", 1000));
const BULK_RECORDS = 10;
const BULK_TRANSACTIONS = 8;
const ARCHIVE_WARMUP = 60;
const OBSERVATION_ROWS = Array.from({ length: 40 }, (_, index) => ({
  id: `seed-obs-${index}`, patternKey: `pattern-${index}`, type: "agent/error", severity: "error",
  observedAt: `2026-10-20T00:00:${String(index).padStart(2, "0")}.000Z`, message: `seeded observation ${index}`,
}));

// Shape guards. The baseline publishes a pending record and then clears it with a
// second whole-document write; the candidate commits the closing document in one
// write when the stage changed nothing. A revision that matches neither side
// cannot be compared by this script, and comparing the same code twice would
// silently report a zero difference.
const BASELINE_SHAPE = "pending: { stage, aggregate, applied: ledger, files } }));";
const CANDIDATE_SHAPE = "const staged = files.length > 0;";
function shapeOf(source) {
  return { publishesPending: source.includes(BASELINE_SHAPE), singleWriteCommit: source.includes(CANDIDATE_SHAPE) };
}

function materializeBaseline() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "transaction-write-path-baseline-"));
  fs.cpSync(path.join(REPO_ROOT, "lib"), path.join(directory, "lib"), { recursive: true });
  const source = execFileSync("git", ["show", `${BASELINE_REV}:lib/domain-storage.js`], { cwd: REPO_ROOT, encoding: "utf8" });
  fs.writeFileSync(path.join(directory, "lib", "domain-storage.js"), source);
  fs.symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(directory, "node_modules"));
  const baselineShape = shapeOf(source);
  const candidateShape = shapeOf(fs.readFileSync(path.join(REPO_ROOT, "lib", "domain-storage.js"), "utf8"));
  assert.ok(baselineShape.publishesPending, `baseline ${BASELINE_REV} must publish a pending record`);
  assert.equal(baselineShape.singleWriteCommit, false, `baseline ${BASELINE_REV} must not already collapse the commit`);
  assert.ok(candidateShape.singleWriteCommit, "the working tree must commit a transaction that changed no archive file in one write");
  assert.ok(candidateShape.publishesPending, "the working tree must keep publishing a pending record when it staged archive bytes");
  const digest = (text) => crypto.createHash("sha256").update(text).digest("hex");
  return { directory, baselineShape, candidateShape,
    sources: { baseline: { revision: BASELINE_REV, sha256: digest(source), bytes: Buffer.byteLength(source) },
      candidate: { sha256: digest(fs.readFileSync(path.join(REPO_ROOT, "lib", "domain-storage.js"), "utf8")),
        bytes: fs.statSync(path.join(REPO_ROOT, "lib", "domain-storage.js")).size } } };
}

// Frozen or advancing clock. The advancing clock is the production condition (a
// timestamp per record); the frozen one is for byte comparison.
function installClock(mode) {
  const RealDate = globalThis.Date;
  let drift = 0;
  class StubDate extends RealDate {
    constructor(...values) { if (values.length === 0) super(FROZEN_NOW + (mode === "freeze" ? 0 : drift++)); else super(...values); }
    static now() { return FROZEN_NOW + (mode === "freeze" ? 0 : drift++); }
  }
  Object.setPrototypeOf(StubDate, RealDate);
  globalThis.Date = StubDate;
  return () => { globalThis.Date = RealDate; };
}

// Deterministic identifiers so two implementations can be compared byte for byte.
// The sequence lives in a shared object and the replacement is installed before
// any library module is imported: an ES module binds a builtin export once, so a
// stub installed later would only affect modules evaluated afterwards, and a
// per-run closure would keep counting across runs.
const UUID_STATE = { seed: 0 };
{
  const original = crypto.randomUUID;
  crypto.randomUUID = () => `${String(++UUID_STATE.seed).padStart(8, "0")}-0000-4000-8000-000000000000`;
  process.on("exit", () => { crypto.randomUUID = original; });
  // Re-point the builtin's named export at the replacement now, so every module
  // evaluated later binds it instead of the original.
  syncBuiltinESMExports();
}
/** Restart the identifier sequence at `base`. Called before every transaction with a
 *  base unique to that transaction, so a generated identifier depends on what the
 *  transaction itself generated rather than on how many scratch file names the
 *  implementation happened to draw (the two sides differ exactly there), while
 *  identifiers stay distinct across transactions - a sequence restarted at zero
 *  would make every transaction generate the same record ids, and the records would
 *  then merge instead of accumulating. */
const resetUuidSequence = (base = 0) => { UUID_STATE.seed = base; };

const SIGNED = (sequence) => ({ schema: 1, eventId: `evolution:measurement-completed:bench-experiment-${sequence}`,
  eventType: "measurement-completed", experimentId: `bench-experiment-${sequence}`,
  proposalId: `bench-proposal-${sequence}`, target: "plugin:bench", capability: "plugin:bench",
  lineageId: "plugin:bench", status: "measured", measurement: { latency: 12, throughput: 100 },
  evidence: { summary: "Synthetic measured evolution event" }, canary: {},
  audit: { producer: "dsh-evolution-orchestrator", at: "2026-10-07T00:00:00.000Z" } });

// A distinct target per write keeps each observation a distinct pattern, which is
// what makes the hot window overflow and evict: a repeated pattern is accumulated
// instead of archived, and the transaction would then have nothing to install.
const OBSERVATION = (index) => ({ type: "agent/error", code: "AGENT_ERROR", message: `synthetic failure ${index}`,
  target: `tool:stage-${index}`, componentId: "agent", severity: "error", status: "failed" });

/** Filesystem accounting. Sync calls go through the CJS object (the ESM named
 *  bindings are re-synced); the official backend uses `node:fs/promises`, which is
 *  the same object as `fs.promises`, so patching it before the backend is imported
 *  counts every whole-document replace it issues - the number this round is about. */
const TRACED = ["fsyncSync", "writeFileSync", "appendFileSync", "renameSync", "linkSync", "mkdirSync", "rmSync",
  "readFileSync", "lstatSync", "readdirSync", "statSync", "copyFileSync"];
function installer(roots) {
  const originals = new Map();
  const counts = new Map();
  const state = { documentWrites: 0, tokenWrites: 0 };
  const bump = (op, target) => {
    const bucket = typeof target !== "string" ? "other"
      : target.startsWith(roots.staging) ? "stage"
        : target.startsWith(roots.live) ? "live"
          : target.startsWith(roots.official) ? "official" : "other";
    const key = `${bucket}/${op}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  const isDocument = (target) => typeof target === "string" && target === roots.document;
  const isToken = (target) => typeof target === "string" && target === roots.token;
  for (const name of TRACED) {
    originals.set(name, fs[name]);
    fs[name] = function traced(...values) {
      const target = name === "linkSync" || name === "renameSync" || name === "copyFileSync" ? values[1] : values[0];
      if (name === "renameSync" && isDocument(target)) state.documentWrites += 1;
      if (name === "renameSync" && isToken(target)) state.tokenWrites += 1;
      bump(name, target);
      return originals.get(name).apply(this, values);
    };
  }
  for (const name of ["rename", "open"]) {
    originals.set(`promises.${name}`, fs.promises[name]);
    fs.promises[name] = function traced(...values) {
      if (name === "rename" && isDocument(values[1])) state.documentWrites += 1;
      if (name === "rename" && isToken(values[1])) state.tokenWrites += 1;
      if (name === "open") bump("open.async", values[0]);
      return originals.get(`promises.${name}`).apply(this, values);
    };
  }
  syncBuiltinESMExports();
  return {
    reset() { counts.clear(); state.documentWrites = 0; state.tokenWrites = 0; },
    read() {
      return { documentWrites: state.documentWrites, tokenWrites: state.tokenWrites,
        calls: Object.fromEntries(counts.entries()) };
    },
    restore() {
      for (const [name, method] of originals) {
        if (name.startsWith("promises.")) fs.promises[name.slice("promises.".length)] = method;
        else fs[name] = method;
      }
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
  const eventLog = path.join(root, "execution-events.jsonl");
  const port = await openDomainStorage(ctx, { presetDir: root, eventBridgePath: eventLog, eventBridgeKey: "b".repeat(64) });
  return { port, backend, ctx, eventLog };
}

/** The archive tree's observable state: relative name -> size. */
function archiveTree(directory) {
  const rows = {};
  const walk = (current, relative) => {
    let names;
    try { names = fs.readdirSync(current).sort(); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
    for (const name of names) {
      const nested = relative ? `${relative}/${name}` : name;
      const absolute = path.join(current, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) { walk(absolute, nested); continue; }
      rows[nested] = Number(stat.size);
    }
  };
  walk(directory, "");
  return rows;
}

function seedFixture(root, scenario) {
  fs.mkdirSync(path.join(root, "dockyard"), { recursive: true, mode: 0o700 });
  if (scenario !== "archive") return null;
  const active = path.join(root, "dockyard", "state.json.observations-archive.jsonl");
  fs.writeFileSync(active, `${OBSERVATION_ROWS.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
  return active;
}

/** Commit a history of `count` signed records as the document's applied ledger, so
 *  the measured transactions face a document the size a lived-in install has. */
async function seedHistory(libDirectory, root, count) {
  const { signEventBridgeEnvelope } = globalThis.__bridge;
  const key = "b".repeat(64);
  const lines = [];
  const applied = {};
  for (let sequence = 1; sequence <= count; sequence += 1) {
    const envelope = signEventBridgeEnvelope(SIGNED(sequence), { key, sequence });
    applied[envelope.event.eventId] = envelope.mac;
    lines.push(JSON.stringify(envelope));
  }
  fs.writeFileSync(path.join(root, "execution-events.jsonl"), `${lines.join("\n")}\n`);
  const { evolutionDomainSpec } = await import(pathToFileURL(path.join(libDirectory, "lib", "domain-storage.js")).href);
  const { DomainFacility } = await import("@deepseek-ai/dsh-storage-domain");
  const { JsonStorageBackend } = await import("@deepseek-ai/dsh-storage-json");
  const backend = new JsonStorageBackend(path.join(root, "official"));
  const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: "json" });
  const domain = await ctx.storageDomain.open(evolutionDomainSpec);
  await domain.global.set({ schema: 1, aggregate: {}, applied, pending: null });
  await domain.close();
  await backend.close();
  return { key, sequence: count };
}

/** One measured pass. */
async function runScenario(libDirectory, { scenario, clockMode, trace }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `transaction-write-path-${scenario}-`));
  const active = seedFixture(root, scenario);
  const roots = { staging: path.join(root, "domain-staging"), live: path.join(root, "dockyard"),
    official: path.join(root, "official"), document: path.join(root, "official", "evolution_domain.json"),
    token: path.join(root, "domain-commit.token") };
  const counter = trace ? installer(roots) : null;
  resetUuidSequence();
  const restoreClock = installClock(clockMode);
  let opened = null;
  const samples = [];
  try {
    const seeded = scenario === "daily" || scenario === "bulk" ? await seedHistory(libDirectory, root, HISTORY_EVENTS) : null;
    opened = await openPort(libDirectory, root);
    const { port, eventLog } = opened;
    const { signEventBridgeEnvelope } = globalThis.__bridge;
    const key = seeded?.key ?? "b".repeat(64);
    let sequence = seeded?.sequence ?? 0;
    const append = (count) => {
      const lines = [];
      for (let index = 0; index < count; index += 1) {
        sequence += 1;
        lines.push(JSON.stringify(signEventBridgeEnvelope(SIGNED(sequence), { key, sequence })));
      }
      fs.appendFileSync(eventLog, `${lines.join("\n")}\n`);
    };
    // One identifier sequence per transaction, on a base unique to it: see
    // `resetUuidSequence`.
    let sequenceBase = 0;
    const aligned = async (task) => { sequenceBase += 1000; resetUuidSequence(sequenceBase); return task(); };
    if (seeded) {
      // One pass authenticates the committed history, finds every marker already
      // in the ledger and advances the replay checkpoint; the measured passes then
      // only pay for the record they actually deliver.
      const pass = await aligned(() => port.flush());
      assert.equal(pass.applied, 0, `${scenario}: the seeded history must already be committed`);
      assert.equal(pass.duplicates, HISTORY_EVENTS, `${scenario}: the seeded history must be seen as duplicates`);
    }
    if (scenario === "archive") {
      // Warm-up drives the hot observation window past its limit, so every
      // measured write evicts one row and appends it to the active archive.
      for (let warm = 0; warm < ARCHIVE_WARMUP; warm += 1) await aligned(() => port.observe(OBSERVATION(warm)));
    } else if (scenario !== "steady") {
      for (let warm = 0; warm < WARMUP; warm += 1) await aligned(() => port.observe(OBSERVATION(warm)));
    }
    const transaction = (index) => {
      if (scenario === "archive") return port.observe(OBSERVATION(1000 + index));
      if (scenario === "steady") return port.flush();
      append(scenario === "bulk" ? BULK_RECORDS : 1);
      return port.flush();
    };
    const count = scenario === "bulk" ? BULK_TRANSACTIONS : SAMPLES;
    if (counter) counter.reset();
    for (let index = 0; index < count; index += 1) {
      const before = archiveTree(roots.live);
      const cpu = process.cpuUsage();
      const started = performance.now();
      await aligned(() => transaction(index));
      const wallMs = performance.now() - started;
      const used = process.cpuUsage(cpu);
      const after = archiveTree(roots.live);
      samples.push({ wallMs, cpuMs: (used.user + used.system) / 1000,
        archiveChanged: JSON.stringify(before) !== JSON.stringify(after),
        documentBytes: fs.existsSync(roots.document) ? fs.statSync(roots.document).size : 0 });
    }
    const traced = counter ? counter.read() : null;
    // Rows name their archive file by absolute path, so the fixture root is
    // replaced by a placeholder before two runs are compared.
    const read = (file) => fs.readFileSync(file, "utf8").split(root).join("<root>");
    const durable = {
      document: fs.existsSync(roots.document) ? read(roots.document) : null,
      archives: Object.keys(archiveTree(roots.live)).sort().map((name) => [name, read(path.join(roots.live, ...name.split("/")))]),
    };
    const stagingLeft = fs.existsSync(roots.staging) ? fs.readdirSync(roots.staging).length : 0;
    const archiveBytes = active && fs.existsSync(active) ? fs.statSync(active).size : 0;
    await port.close();
    opened = null;
    return { samples, traced, durable, stagingLeft, archiveBytes,
      archiveChanging: samples.filter((sample) => sample.archiveChanged).length };
  } finally {
    if (opened) { try { await opened.port.close(); } catch {} try { await opened.backend.close(); } catch {} }
    counter?.restore();
    restoreClock();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
const group = (samples) => samples.length === 0 ? null : ({
  transactions: samples.length,
  wallMs: median(samples.map((sample) => sample.wallMs)),
  cpuMs: median(samples.map((sample) => sample.cpuMs)),
  wallSamples: samples.map((sample) => Number(sample.wallMs.toFixed(3))),
  cpuSamples: samples.map((sample) => Number(sample.cpuMs.toFixed(3))),
  documentBytes: median(samples.map((sample) => sample.documentBytes)),
});
const summarize = (run) => ({
  wallMs: median(run.samples.map((sample) => sample.wallMs)),
  cpuMs: median(run.samples.map((sample) => sample.cpuMs)),
  transactions: run.samples.length,
  archiveChanging: run.samples.filter((sample) => sample.archiveChanged).length,
  unchangedArchives: group(run.samples.filter((sample) => !sample.archiveChanged)),
  changedArchives: group(run.samples.filter((sample) => sample.archiveChanged)),
  documentBytes: median(run.samples.map((sample) => sample.documentBytes)),
  stagingLeft: run.stagingLeft,
  traced: run.traced ? {
    documentWritesPerTransaction: Number((run.traced.documentWrites / run.samples.length).toFixed(2)),
    tokenWritesPerTransaction: Number((run.traced.tokenWrites / run.samples.length).toFixed(2)),
    callsPerTransaction: Object.fromEntries(Object.entries(run.traced.calls)
      .map(([name, value]) => [name, Number((value / run.samples.length).toFixed(2))])),
  } : null,
});

const baseline = materializeBaseline();
const SIDES = { baseline: () => baseline.directory, candidate: () => REPO_ROOT };
process.on("exit", () => fs.rmSync(baseline.directory, { recursive: true, force: true }));

// The bridge signing helper comes from the working tree; both sides are measured
// with the same signed envelopes.
globalThis.__bridge = await import(pathToFileURL(path.join(REPO_ROOT, "lib", "orchestrator.js")).href);

const SCENARIOS = ["daily", "bulk", "archive", "steady"];
const output = {
  baseline: BASELINE_REV, rounds: ROUNDS, samples: SAMPLES, warmup: WARMUP, history: HISTORY_EVENTS,
  environment: { node: process.version, platform: `${process.platform}/${process.arch}`, cpus: os.cpus().length,
    loadAverageAtStart: os.loadavg() },
  protocol: {
    measurementClock: "deterministic clock advancing 1 ms per read (production condition, reproducible)",
    equivalenceClock: "frozen at 2026-11-02T00:00:00.000Z with a deterministic UUID sequence; durable output must be byte-identical",
    order: "each round alternates which side runs first",
    sides: "baseline restores lib/domain-storage.js from the recorded revision into a copy of lib/; candidate is this working tree",
    instrumentedPass: "one additional pass per side with wrapped fs calls; the official backend's whole-document replace is counted through fs.promises",
  },
  shapeGuards: baseline.shapeGuards ?? { baseline: baseline.baselineShape, candidate: baseline.candidateShape },
  sources: baseline.sources,
  scenarios: [],
};

for (const scenario of SCENARIOS) {
  const record = { scenario, rounds: [] };
  for (let round = 1; round <= ROUNDS; round += 1) {
    const order = round % 2 === 1 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    const measured = { round, order, sides: {} };
    for (const side of order) {
      const clean = summarize(await runScenario(SIDES[side](), { scenario, clockMode: "advance", trace: false }));
      const traced = summarize(await runScenario(SIDES[side](), { scenario, clockMode: "advance", trace: true }));
      measured.sides[side] = { ...clean, traced: traced.traced };
    }
    // The workload is asserted, not assumed: `daily` must be a run of transactions
    // that change no archive file, `archive` must change one on every transaction.
    if (scenario === "daily" || scenario === "steady") {
      for (const side of order) assert.equal(measured.sides[side].archiveChanging, 0,
        `${scenario}: every measured transaction must leave the archive tree untouched (${side})`);
    }
    if (scenario === "archive") {
      for (const side of order) assert.equal(measured.sides[side].archiveChanging, measured.sides[side].transactions,
        "archive: every measured transaction must move the active archive file");
    }
    // Both sides must see the same transaction shapes; only the commit shape differs.
    assert.equal(measured.sides.baseline.archiveChanging, measured.sides.candidate.archiveChanging,
      `${scenario}: both sides must classify the same transactions as archive-changing`);
    record.rounds.push(measured);
  }
  const pick = (side, key) => record.rounds.map((round) => round.sides[side][key]);
  const medianOf = (side, key) => median(pick(side, key));
  const groupOf = (side, name) => {
    const rows = pick(side, name).filter((value) => value !== null);
    if (rows.length === 0) return null;
    return { transactions: median(rows.map((row) => row.transactions)),
      wallMs: median(rows.map((row) => row.wallMs)), cpuMs: median(rows.map((row) => row.cpuMs)),
      wallRounds: rows.map((row) => Number(row.wallMs.toFixed(2))),
      cpuRounds: rows.map((row) => Number(row.cpuMs.toFixed(2))) };
  };
  const calls = (side) => {
    const merged = new Map();
    for (const round of record.rounds) {
      for (const [name, value] of Object.entries(round.sides[side].traced.callsPerTransaction)) merged.set(name, [...(merged.get(name) ?? []), value]);
    }
    return Object.fromEntries([...merged.entries()].map(([name, values]) => [name, median(values)]));
  };
  record.summary = {
    sides: Object.fromEntries(Object.keys(SIDES).map((side) => [side, {
      wallMs: medianOf(side, "wallMs"), cpuMs: medianOf(side, "cpuMs"),
      wallRounds: pick(side, "wallMs").map((value) => Number(value.toFixed(2))),
      cpuRounds: pick(side, "cpuMs").map((value) => Number(value.toFixed(2))),
      transactions: medianOf(side, "transactions"),
      archiveChanging: medianOf(side, "archiveChanging"),
      documentBytes: medianOf(side, "documentBytes"),
      unchangedArchives: groupOf(side, "unchangedArchives"),
      changedArchives: groupOf(side, "changedArchives"),
      documentWritesPerTransaction: medianOf(side, "traced").documentWritesPerTransaction,
      tokenWritesPerTransaction: medianOf(side, "traced").tokenWritesPerTransaction,
      calls: calls(side),
      stagingLeft: pick(side, "stagingLeft").reduce((max, value) => Math.max(max, value), 0),
    }])),
  };
  output.scenarios.push(record);
}

// Equivalence: frozen clock, deterministic UUIDs, byte-identical durable output.
const equivalence = [];
for (const scenario of SCENARIOS) {
  const runs = {};
  for (const side of ["baseline", "candidate"]) {
    runs[side] = await runScenario(SIDES[side](), { scenario, clockMode: "freeze", trace: false });
  }
  assert.equal(runs.candidate.stagingLeft, 0, `${scenario}: a committed transaction must leave no staged directory`);
  assert.equal(runs.baseline.stagingLeft, 0, `${scenario}: the baseline must leave no staged directory either`);
  // The frozen pass must not degenerate into a comparison of two runs that do no
  // work: an identifier repeated across transactions would merge records instead of
  // accumulating them, and a run that never grows its archive proves nothing about
  // the archive bytes. Both sides therefore have to show the shape the scenario
  // claims, in the frozen pass too.
  const shape = { daily: [0, 0], steady: [0, 0], bulk: [1, Infinity] };
  for (const side of ["baseline", "candidate"]) {
    const changing = runs[side].archiveChanging;
    const total = runs[side].samples.length;
    if (scenario === "archive") {
      // This scenario exists to be the no-regression case, so every measured
      // transaction has to append to the active archive - not just one of them.
      assert.equal(changing, total,
        `archive: the frozen run of ${side} must append to the active archive on every transaction, saw ${changing}/${total}`);
      continue;
    }
    const [low, high] = shape[scenario];
    assert.ok(changing >= low && changing <= high,
      `${scenario}: the frozen run of ${side} must keep the scenario shape, saw ${changing} archive-changing transaction(s)`);
  }
  if (scenario === "archive") {
    // The seeded file holds the 40 fixture rows; a run whose records merged would
    // leave it exactly that size.
    const seeded = Buffer.byteLength(`${OBSERVATION_ROWS.map((row) => JSON.stringify(row)).join("\n")}\n`);
    for (const side of ["baseline", "candidate"]) {
      assert.ok(runs[side].archiveBytes > seeded,
        `archive: the frozen run of ${side} must append to the active archive (${runs[side].archiveBytes} <= ${seeded})`);
    }
  }
  assert.equal(runs.candidate.durable.document, runs.baseline.durable.document,
    `${scenario}: both implementations must persist the same domain document under a frozen clock`);
  assert.deepEqual(runs.candidate.durable.archives, runs.baseline.durable.archives,
    `${scenario}: both implementations must persist the same archive bytes under a frozen clock`);
  equivalence.push({ scenario, durableByteIdentical: true, archiveFiles: runs.candidate.durable.archives.length,
    documentBytes: runs.candidate.durable.document?.length ?? 0,
    archiveChanging: { baseline: runs.baseline.archiveChanging, candidate: runs.candidate.archiveChanging },
    activeArchiveBytes: runs.candidate.archiveBytes });
}
output.equivalence = equivalence;
output.environment.loadAverageAtEnd = os.loadavg();
console.log(JSON.stringify(output, null, 2));
