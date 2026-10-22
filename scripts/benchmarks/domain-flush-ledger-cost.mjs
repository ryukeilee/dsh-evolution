// What one `flush()` costs when the committed marker table is long and new
// events arrive, on the real official `DomainFacility` + `JsonStorageBackend`.
//
// `registration.js` calls `domainStorage.flush()` on every `agent/pre-step` and
// at the end of every Evolution tool call, so this is the plugin's hottest path.
// A pass that carries new events commits one transaction, and that transaction
// used to build and drop two full copies of the marker table:
//
// - `mergeEventLedger()` walked the caller's table with `Object.entries()`,
//   which allocates a `[eventId, mac]` pair array for every marker (20,000 of
//   them at 20,000 committed events) only to read the two values back out.
// - the working store `createMemory()` builds handed the memory a
//   `structuredClone` of the aggregate it had already cloned, so every
//   transaction cloned the aggregate twice per memory instance.
//
// This script measures the working tree against a baseline restored from git on
// the real backend, across three history sizes and three backlog sizes, plus a
// seeded non-empty aggregate, a seeded non-empty archive tree and a shape that
// archives on every commit. It also proves the change changes no durable byte
// (document, replay checkpoint content, archive tree) under a frozen clock and a
// deterministic identifier sequence, and reports the mechanism counters (whole
// document writes, handle syncs, digest bytes, `structuredClone` calls and
// bytes, GC entries) that the A/B difference is attributed to.
//
//   node scripts/benchmarks/domain-flush-ledger-cost.mjs [--baseline <rev>] [--rounds 3] [--samples 9]
//   node scripts/benchmarks/domain-flush-ledger-cost.mjs --scenario history-20000-new-1 --rounds 5 --samples 15
//   node scripts/benchmarks/domain-flush-ledger-cost.mjs --out docs/performance/domain-flush-ledger-cost.json
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { pathToFileURL, fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const BASELINE_REV = option("baseline", "c85dfa7");
const ROUNDS = Number(option("rounds", 3));
const SAMPLES = Number(option("samples", 9));
const WARMUP = Number(option("warmup", 3));
const EQUIVALENCE_SAMPLES = Number(option("equivalence-samples", 3));
const OUT = option("out", null);
const FROZEN_NOW = Date.parse("2026-11-03T00:00:00.000Z");
const KEY = "b".repeat(64);
const SOURCE_FILES = ["lib/domain-storage.js"];

// Shape guards. The baseline must be the implementation this round replaces: it
// walks the caller's table with `Object.entries()`, and its working store clones
// the aggregate before handing it to the memory. The candidate must be the one
// this round leaves behind. A revision that matches neither side cannot be
// compared by this script, and comparing the same code twice would silently
// report a zero difference.
const BASELINE_SHAPES = [
  "for (const [eventId, mac] of Object.entries(applied)) {",
  "load: async () => structuredClone(aggregate),",
];
const CANDIDATE_SHAPES = [
  "for (const eventId of Object.keys(applied)) {",
  "    const mac = applied[eventId];",
  "load: async () => aggregate,",
];
const ABSENT_IN_CANDIDATE = BASELINE_SHAPES.filter((shape) => shape !== "load: async () => structuredClone(aggregate),");
const ABSENT_IN_BASELINE = CANDIDATE_SHAPES.filter((shape) => shape !== "load: async () => aggregate,");

const label = (scenario) => `history-${scenario.history}-new-${scenario.newEvents}`
  + (scenario.aggregate === "none" ? "" : `-${scenario.aggregate}`)
  + (scenario.archives ? "-archive" : "");

const SCENARIOS = [];
for (const history of [200, 2000, 20000]) {
  for (const newEvents of [0, 1, 3]) SCENARIOS.push({ history, newEvents, aggregate: "none", archives: false });
}
// A committed aggregate with the record volume a lived-in install carries: the
// hot window only, so a later load archives nothing and the measured pass stays
// the single-document commit it is measuring.
for (const [history, newEvents] of [[2000, 1], [2000, 3], [20000, 1], [20000, 3]]) {
  SCENARIOS.push({ history, newEvents, aggregate: "hot", archives: false });
}
// The same aggregate with a non-empty archive tree under `dockyard/`: every
// transaction mirrors it, re-checks it and re-reads its derived index.
for (const [history, newEvents] of [[2000, 1], [20000, 1]]) {
  SCENARIOS.push({ history, newEvents, aggregate: "hot", archives: true });
}
// The `experiments` hot window is full, so every new event evicts a record and
// the transaction takes the two-write staged path instead of the single write.
// (`hot` seeds twelve rows there instead, which keeps all of its passes at one
// document write; the script asserts the exact count per shape.)
for (const [history, newEvents] of [[2000, 1], [2000, 3]]) {
  SCENARIOS.push({ history, newEvents, aggregate: "evict", archives: true });
}
const ONLY = option("scenario", null)?.split(",").map((name) => name.trim()).filter(Boolean) ?? null;
const SELECTED = SCENARIOS.filter((scenario) => ONLY === null || ONLY.includes(label(scenario)));
assert.ok(SELECTED.length > 0, `no scenario matches ${JSON.stringify(ONLY)}`);

function materializeBaseline() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flush-ledger-cost-baseline-"));
  fs.cpSync(path.join(REPO_ROOT, "lib"), path.join(directory, "lib"), { recursive: true });
  fs.symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(directory, "node_modules"));
  const sources = {};
  for (const file of SOURCE_FILES) {
    const source = execFileSync("git", ["show", `${BASELINE_REV}:${file}`], { cwd: REPO_ROOT, encoding: "utf8" });
    fs.writeFileSync(path.join(directory, file), source);
    sources[file] = source;
  }
  const combined = Object.values(sources).join("\n");
  const candidate = SOURCE_FILES.map((file) => fs.readFileSync(path.join(REPO_ROOT, file), "utf8")).join("\n");
  for (const shape of BASELINE_SHAPES) {
    assert.ok(combined.includes(shape), `baseline ${BASELINE_REV} must contain ${JSON.stringify(shape)}`);
  }
  for (const shape of ABSENT_IN_BASELINE) {
    assert.equal(combined.includes(shape), false, `baseline ${BASELINE_REV} must not already contain ${JSON.stringify(shape)}`);
  }
  for (const shape of CANDIDATE_SHAPES) {
    assert.ok(candidate.includes(shape), `the working tree must contain ${JSON.stringify(shape)}`);
  }
  for (const shape of ABSENT_IN_CANDIDATE) {
    assert.equal(candidate.includes(shape), false, `the working tree must not still contain ${JSON.stringify(shape)}`);
  }
  const digest = (text) => crypto.createHash("sha256").update(text).digest("hex");
  return { directory, sources: Object.fromEntries(SOURCE_FILES.map((file) => [file, {
    baseline: { revision: BASELINE_REV, sha256: digest(sources[file]), bytes: Buffer.byteLength(sources[file]) },
    candidate: { sha256: digest(fs.readFileSync(path.join(REPO_ROOT, file), "utf8")),
      bytes: fs.statSync(path.join(REPO_ROOT, file)).size },
  }])) };
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
// Installed before any library module is imported: an ES module binds a builtin
// export once, so a stub installed later would only affect modules evaluated
// afterwards.
const UUID_STATE = { seed: 0 };
{
  const original = crypto.randomUUID;
  crypto.randomUUID = () => `${String(++UUID_STATE.seed).padStart(8, "0")}-0000-4000-8000-000000000000`;
  process.on("exit", () => { crypto.randomUUID = original; });
  syncBuiltinESMExports();
}
/** Restart the identifier sequence at `base` before every transaction, so a
 *  generated identifier depends on what the transaction generated rather than on
 *  how many scratch names the implementation happened to draw. */
const resetUuidSequence = (base = 0) => { UUID_STATE.seed = base; };

const SIGNED = (sequence) => ({ schema: 1, eventId: `evolution:measurement-completed:bench-experiment-${sequence}`,
  eventType: "measurement-completed", experimentId: `bench-experiment-${sequence}`,
  proposalId: `bench-proposal-${sequence}`, target: "plugin:bench", capability: "plugin:bench",
  lineageId: "plugin:bench", status: "measured", measurement: { latency: 12, throughput: 100 },
  evidence: { summary: "Synthetic measured evolution event" }, canary: {},
  audit: { producer: "dsh-evolution-orchestrator", at: "2026-10-07T00:00:00.000Z" } });

/** Filesystem accounting, the bytes each pass hands to SHA-256/HMAC, the
 *  `structuredClone` calls behind the working store, and the GC entries the
 *  measured loop produced. Every count is per flush in the report. */
const TRACED = ["fsyncSync", "writeFileSync", "appendFileSync", "renameSync", "linkSync", "mkdirSync", "rmSync",
  "readFileSync", "readSync", "lstatSync", "readdirSync", "statSync", "copyFileSync", "openSync"];
function installer(roots) {
  const originals = new Map();
  const counts = new Map();
  const state = { documentWrites: 0, tokenWrites: 0, logBytesRead: 0, digestBytes: 0,
    clones: 0, cloneBytes: 0, cloneMs: 0, gcEntries: 0, gcMs: 0 };
  const bucketOf = (target) => typeof target !== "string" ? "other"
    : target.startsWith(roots.staging) ? "stage"
      : target.startsWith(roots.live) ? "live"
        : target.startsWith(roots.official) ? "official"
          : target === roots.eventLog ? "eventLog" : "other";
  const bump = (op, target) => {
    const key = `${bucketOf(target)}/${op}`;
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
      const result = originals.get(name).apply(this, values);
      if (name === "readSync") state.logBytesRead += result;
      else if (name === "readFileSync" && target === roots.eventLog) state.logBytesRead += result.length;
      return result;
    };
  }
  for (const name of ["rename", "open", "readFile"]) {
    originals.set(`promises.${name}`, fs.promises[name]);
    fs.promises[name] = function traced(...values) {
      if (name === "rename" && isDocument(values[1])) state.documentWrites += 1;
      if (name === "rename" && isToken(values[1])) state.tokenWrites += 1;
      if (name !== "readFile") bump(`${name}.async`, values[0]);
      const result = originals.get(`promises.${name}`).apply(this, values);
      if (name !== "open") return result;
      // The JSON backend makes a document write durable through the handle it gets
      // from `open`, not through `fsyncSync`, so the sync has to be counted on that
      // handle or this script would claim "no I/O" without having looked.
      const target = values[0];
      return Promise.resolve(result).then((handle) => {
        const sync = handle.sync.bind(handle);
        handle.sync = async function counted(...args) { bump("sync", target); return sync(...args); };
        return handle;
      });
    };
  }
  // A keyed or plain digest, wrapped so its input length is counted.
  const wrapDigest = (inner) => ({
    update(data) { state.digestBytes += typeof data === "string" ? Buffer.byteLength(data) : data.length; inner.update(data); return this; },
    digest(...values) { return inner.digest(...values); },
    copy(...values) { return wrapDigest(inner.copy(...values)); },
  });
  for (const name of ["createHash", "createHmac"]) {
    originals.set(`crypto.${name}`, crypto[name]);
    crypto[name] = function traced(...values) { return wrapDigest(originals.get(`crypto.${name}`).apply(this, values)); };
  }
  // The working store's redundant clone is one of the two changes; the count and
  // the bytes it copied are the mechanism behind that half of the difference.
  originals.set("structuredClone", structuredClone);
  globalThis.structuredClone = function traced(value) {
    const started = performance.now();
    const result = originals.get("structuredClone")(value);
    state.cloneMs += performance.now() - started;
    state.clones += 1;
    try { state.cloneBytes += Buffer.byteLength(JSON.stringify(value)); } catch { /* unmeasurable */ }
    return result;
  };
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) { state.gcEntries += 1; state.gcMs += entry.duration; }
  });
  try { observer.observe({ entryTypes: ["gc"] }); } catch { /* gc entries are optional */ }
  syncBuiltinESMExports();
  return {
    reset() {
      counts.clear();
      Object.assign(state, { documentWrites: 0, tokenWrites: 0, logBytesRead: 0, digestBytes: 0,
        clones: 0, cloneBytes: 0, cloneMs: 0, gcEntries: 0, gcMs: 0 });
    },
    read() { return { ...state, calls: Object.fromEntries(counts.entries()) }; },
    restore() {
      observer.disconnect();
      globalThis.structuredClone = originals.get("structuredClone");
      for (const [name, method] of originals) {
        if (name === "structuredClone") continue;
        if (name.startsWith("promises.")) fs.promises[name.slice("promises.".length)] = method;
        else if (name.startsWith("crypto.")) crypto[name.slice("crypto.".length)] = method;
        else fs[name] = method;
      }
      syncBuiltinESMExports();
    },
  };
}

async function openPort(libDirectory, root, eventLog) {
  const { openDomainStorage } = await import(pathToFileURL(path.join(libDirectory, "lib", "domain-storage.js")).href);
  const { DomainFacility } = await import("@deepseek-ai/dsh-storage-domain");
  const { JsonStorageBackend } = await import("@deepseek-ai/dsh-storage-json");
  const backend = new JsonStorageBackend(path.join(root, "official"));
  const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: "json" });
  const port = await openDomainStorage(ctx, { presetDir: root, eventBridgePath: eventLog, eventBridgeKey: KEY });
  return { port, backend, ctx };
}

/** The archive tree's observable state: relative name -> sha256. */
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
      rows[nested] = crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
    }
  };
  walk(directory, "");
  return rows;
}

/** One durable aggregate row, shaped like the ones the memory appends. */
const seededRow = (collection, index) => ({
  id: `${collection}-seed-${index}`, recordId: `${collection}-seed-${index}`, status: "recorded",
  recordedAt: `2026-10-0${(index % 9) + 1}T00:00:00.000Z`, problemFingerprint: `fingerprint-${collection}-${index}`,
  capability: "plugin:bench", target: "plugin:bench", lineageId: "plugin:bench", eventType: "measurement-completed",
  summary: `seeded ${collection} row ${index} carrying the record volume a lived-in install holds`,
  measurement: { latency: index, throughput: 100 + index }, evidence: { summary: "seeded" },
  payload: { nested: { a: index, b: "x".repeat(48) }, list: [1, 2, 3, index] },
});

/** The seeded aggregate: the hot window of a lived-in install (well under the
 *  memory's per-collection hot limits, so `load()` archives nothing), plus - for
 *  the shapes that force the staged path - a full `experimentRecords` window, so
 *  every applied record evicts one and the transaction writes an archive file. */
function seededEvolution(shape) {
  if (shape === "none") return {};
  const evolution = { schema: 5, eventBridge: { schema: 1, applied: [] }, observations: [] };
  // Every collection stays under its hot limit even after the whole measured run
  // has appended its records (`experiments` grows by `newEvents` per pass, and the
  // limit is 50), so this shape is the single-document commit it claims to be.
  for (const collection of ["proposals", "experiments", "cycles"]) {
    evolution[collection] = Array.from({ length: 12 }, (_, index) => seededRow(collection, index));
  }
  evolution.knowledge = Array.from({ length: 400 }, (_, index) => seededRow("knowledge", index));
  evolution.observations = Array.from({ length: 24 }, (_, index) => seededRow("observations", index));
  if (shape === "evict") {
    // `measurement-completed` appends to `experiments`, whose hot window is 50, so
    // a full window means every applied record evicts one into the collection
    // archive - the two-write staged path this shape exists to measure.
    evolution.experiments = Array.from({ length: 50 }, (_, index) => seededRow("experiments", 1000 + index));
  }
  return evolution;
}

/** A non-empty archive tree: the collection archives an install of this age
 *  carries, plus the derived index `load()` reconciles against. The rows are
 *  intentionally not in the hot window, so no measured commit rewrites them. */
const ARCHIVED_OBSERVATIONS = Array.from({ length: 2000 }, (_, index) => ({
  id: `archived-observation-${index}`, patternKey: `pattern-${index % 24}`, type: "agent/error", severity: "error",
  observedAt: `2026-10-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
  message: `archived observation ${index}`,
}));
const ARCHIVED_KNOWLEDGE = Array.from({ length: 500 }, (_, index) => seededRow("knowledge", 10000 + index));
function seedArchives(root) {
  const directory = path.join(root, "dockyard");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, "state.json.observations-archive.jsonl"),
    `${ARCHIVED_OBSERVATIONS.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(directory, "state.json.knowledge-archive.jsonl"),
    `${ARCHIVED_KNOWLEDGE.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
}

async function seedHistory(libDirectory, root, eventLog, count, scenario) {
  const { signEventBridgeEnvelope } = globalThis.__bridge;
  const lines = [];
  const applied = {};
  for (let sequence = 1; sequence <= count; sequence += 1) {
    const envelope = signEventBridgeEnvelope(SIGNED(sequence), { key: KEY, sequence });
    applied[envelope.event.eventId] = envelope.mac;
    lines.push(JSON.stringify(envelope));
  }
  fs.writeFileSync(eventLog, count === 0 ? "" : `${lines.join("\n")}\n`);
  if (scenario.archives) seedArchives(root);
  const { evolutionDomainSpec } = await import(pathToFileURL(path.join(libDirectory, "lib", "domain-storage.js")).href);
  const { DomainFacility } = await import("@deepseek-ai/dsh-storage-domain");
  const { JsonStorageBackend } = await import("@deepseek-ai/dsh-storage-json");
  const backend = new JsonStorageBackend(path.join(root, "official"));
  const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: "json" });
  const domain = await ctx.storageDomain.open(evolutionDomainSpec);
  const aggregate = scenario.aggregate === "none" ? {} : { evolution: seededEvolution(scenario.aggregate) };
  await domain.global.set({ schema: 1, aggregate, applied, pending: null });
  await domain.close();
  await backend.close();
  return { sequence: count };
}

/** One measured pass over a scenario, from fixture build to durable artifacts. */
async function runScenario(libDirectory, scenario, { clockMode, trace, samples, profile = null }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `flush-ledger-cost-${scenario.history}-${scenario.newEvents}-`));
  const eventLog = path.join(root, "execution-events.jsonl");
  const roots = { staging: path.join(root, "domain-staging"), live: path.join(root, "dockyard"),
    official: path.join(root, "official"), document: path.join(root, "official", "evolution_domain.json"),
    token: path.join(root, "domain-commit.token"), eventLog,
    checkpoint: path.join(root, "event-log.checkpoint.json") };
  const counter = trace ? installer(roots) : null;
  resetUuidSequence();
  const restoreClock = installClock(clockMode);
  let opened = null;
  const rows = [];
  try {
    const { sequence: seeded } = await seedHistory(libDirectory, root, eventLog, scenario.history, scenario);
    opened = await openPort(libDirectory, root, eventLog);
    const { port } = opened;
    const { signEventBridgeEnvelope } = globalThis.__bridge;
    let sequence = seeded;
    const append = (count) => {
      const lines = [];
      for (let index = 0; index < count; index += 1) {
        sequence += 1;
        lines.push(JSON.stringify(signEventBridgeEnvelope(SIGNED(sequence), { key: KEY, sequence })));
      }
      if (lines.length > 0) fs.appendFileSync(eventLog, `${lines.join("\n")}\n`);
    };
    // One identifier sequence per transaction, on a base unique to it: see
    // `resetUuidSequence`.
    let sequenceBase = 0;
    const aligned = async (task) => { sequenceBase += 1000; resetUuidSequence(sequenceBase); return task(); };
    // The cold pass authenticates the seeded history once, finds every marker
    // already committed and advances the replay checkpoint past it.
    const cold = await aligned(() => port.flush());
    assert.deepEqual(cold, { applied: 0, duplicates: scenario.history }, `history ${scenario.history}: the seeded history must already be committed`);
    for (let warm = 0; warm < WARMUP; warm += 1) { append(scenario.newEvents); await aligned(() => port.flush()); }
    const expected = (index) => ({ applied: scenario.newEvents, duplicates: scenario.history + scenario.newEvents * (WARMUP + index) });
    // Profiling starts here: the fixture build, the cold pass and its signing are
    // behind us, so the profile holds the measured `flush()` calls only.
    const totals = counter ? { documentWrites: 0, tokenWrites: 0, logBytesRead: 0, digestBytes: 0,
      clones: 0, cloneBytes: 0, cloneMs: 0, gcEntries: 0, gcMs: 0, calls: new Map() } : null;
    await profile?.start?.();
    for (let index = 0; index < samples; index += 1) {
      append(scenario.newEvents);
      // The counters are opened after the append, so signing and appending the new
      // record are outside every per-flush figure (the CPU and wall timers below
      // already exclude them).
      if (counter) counter.reset();
      const cpu = process.cpuUsage();
      const started = performance.now();
      const result = await aligned(() => port.flush());
      const wallMs = performance.now() - started;
      const used = process.cpuUsage(cpu);
      assert.deepEqual(result, expected(index), `${label(scenario)}: the pass must report what it applied`);
      rows.push({ wallMs, cpuMs: (used.user + used.system) / 1000 });
      if (counter) {
        const read = counter.read();
        for (const name of ["documentWrites", "tokenWrites", "logBytesRead", "digestBytes", "clones", "cloneBytes", "cloneMs", "gcEntries", "gcMs"]) {
          totals[name] += read[name];
        }
        for (const [name, value] of Object.entries(read.calls)) totals.calls.set(name, (totals.calls.get(name) ?? 0) + value);
      }
    }
    await profile?.stop?.();
    const traced = totals === null ? null : { ...totals, calls: Object.fromEntries(totals.calls) };
    const read = (file) => fs.readFileSync(file, "utf8").split(root).join("<root>");
    // The checkpoint's `file.dev`/`file.ino` identify the fixture's own log file and
    // its `mac` binds them, so those three fields are per-run by construction. Every
    // other field - the consumed length, the record count, the keyed digest of the
    // consumed prefix, the witnesses and the marker-map digest - is content, and it
    // is what the two implementations have to agree on byte for byte.
    const checkpoint = fs.existsSync(roots.checkpoint) ? JSON.parse(read(roots.checkpoint)) : null;
    const durable = {
      document: fs.existsSync(roots.document) ? read(roots.document) : null,
      checkpoint: checkpoint === null ? null : {
        schema: checkpoint.schema, bytes: checkpoint.bytes, records: checkpoint.records, digest: checkpoint.digest,
        writer: checkpoint.writer, first: checkpoint.first, last: checkpoint.last, appliedDigest: checkpoint.appliedDigest },
      checkpointFileIdentityPresent: checkpoint !== null && typeof checkpoint.file?.dev === "string" && typeof checkpoint.file?.ino === "string",
      archives: Object.entries(archiveTree(roots.live)).sort(([left], [right]) => left < right ? -1 : 1)
        .map(([name, digest]) => [name, digest]),
    };
    const stagingLeft = fs.existsSync(roots.staging) ? fs.readdirSync(roots.staging).length : 0;
    // A restart replays the log during `openDomainStorage()`, before anything can
    // call `flush()`. So the proof that nothing was left to apply is that opening
    // the port leaves the durable document and the checkpoint byte for byte as they
    // were; the `flush()` afterwards only confirms the same thing from the port's
    // side. Asserting the `flush()` result alone would pass even if the startup pass
    // had just re-applied something.
    const beforeRestart = { document: read(roots.document), checkpoint: read(roots.checkpoint), archives: archiveTree(roots.live) };
    await port.close();
    opened = null;
    const reopened = await openPort(libDirectory, root, eventLog);
    const restart = await reopened.port.flush();
    const restartedLeaves = fs.existsSync(roots.staging) ? fs.readdirSync(roots.staging).length : 0;
    await reopened.port.close();
    await reopened.backend.close();
    const afterRestart = { document: read(roots.document), checkpoint: read(roots.checkpoint), archives: archiveTree(roots.live) };
    return { rows, traced, durable, stagingLeft, restartedLeaves, restart,
      restartDocumentUnchanged: beforeRestart.document === afterRestart.document,
      restartCheckpointUnchanged: beforeRestart.checkpoint === afterRestart.checkpoint,
      restartArchivesUnchanged: JSON.stringify(beforeRestart.archives) === JSON.stringify(afterRestart.archives),
      documentBytes: durable.document === null ? 0 : Buffer.byteLength(durable.document),
      checkpointBytes: durable.checkpoint === null ? 0 : Buffer.byteLength(JSON.stringify(durable.checkpoint)),
      logBytes: fs.statSync(eventLog).size };
  } finally {
    if (opened) { try { await opened.port.close(); } catch {} try { await opened.backend.close(); } catch {} }
    counter?.restore();
    restoreClock();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
const round3 = (value) => Number(value.toFixed(3));
const summarize = (run) => ({
  transactions: run.rows.length,
  wallMs: median(run.rows.map((row) => row.wallMs)),
  cpuMs: median(run.rows.map((row) => row.cpuMs)),
  wallSamples: run.rows.map((row) => round3(row.wallMs)),
  cpuSamples: run.rows.map((row) => round3(row.cpuMs)),
  documentBytes: run.documentBytes,
  checkpointBytes: run.checkpointBytes,
  logBytes: run.logBytes,
  stagingLeft: run.stagingLeft,
  restartedLeaves: run.restartedLeaves,
  restart: run.restart,
  restartDocumentUnchanged: run.restartDocumentUnchanged,
  restartCheckpointUnchanged: run.restartCheckpointUnchanged,
  restartArchivesUnchanged: run.restartArchivesUnchanged,
  traced: run.traced ? {
    documentWritesPerFlush: round3(run.traced.documentWrites / run.rows.length),
    tokenWritesPerFlush: round3(run.traced.tokenWrites / run.rows.length),
    handleSyncsPerFlush: round3(Object.entries(run.traced.calls)
      .filter(([name]) => name.endsWith("/sync")).reduce((total, [, value]) => total + value, 0) / run.rows.length),
    logBytesReadPerFlush: Math.round(run.traced.logBytesRead / run.rows.length),
    digestBytesPerFlush: Math.round(run.traced.digestBytes / run.rows.length),
    structuredClonesPerFlush: round3(run.traced.clones / run.rows.length),
    clonedBytesPerFlush: Math.round(run.traced.cloneBytes / run.rows.length),
    cloneMsPerFlush: round3(run.traced.cloneMs / run.rows.length),
    gcEntriesPerFlush: round3(run.traced.gcEntries / run.rows.length),
    gcMsPerFlush: round3(run.traced.gcMs / run.rows.length),
    callsPerFlush: Object.fromEntries(Object.entries(run.traced.calls)
      .map(([name, value]) => [name, round3(value / run.rows.length)])),
  } : null,
});

const baseline = materializeBaseline();
const SIDES = { baseline: () => baseline.directory, candidate: () => REPO_ROOT };
process.on("exit", () => fs.rmSync(baseline.directory, { recursive: true, force: true }));
// The bridge signing helper comes from the working tree; both sides are measured
// with the same signed envelopes.
globalThis.__bridge = await import(pathToFileURL(path.join(REPO_ROOT, "lib", "orchestrator.js")).href);

const output = {
  baseline: BASELINE_REV, rounds: ROUNDS, samples: SAMPLES, warmup: WARMUP,
  scenarios: SELECTED.map(label),
  environment: { node: process.version, platform: `${process.platform}/${process.arch}`, cpus: os.cpus().length,
    loadAverageAtStart: os.loadavg() },
  protocol: {
    measurementClock: "deterministic clock advancing 1 ms per read (production condition, reproducible)",
    equivalenceClock: "frozen at 2026-11-03T00:00:00.000Z with a deterministic UUID sequence; durable output must be byte-identical",
    order: "each round alternates which side runs first",
    sides: "baseline restores lib/domain-storage.js from the recorded revision into a copy of lib/; candidate is this working tree",
    warmup: "the seeded history is absorbed by a cold pass, then `warmup` flushed bursts",
    instrumentedPass: "one additional pass per side with wrapped fs/crypto/structuredClone calls and a GC observer; the counters are opened after the new records are signed and appended, so every count is exactly one flush",
    historyShape: "the seeded history is a committed applied marker table plus its signed log. The `-hot` scenarios also seed an aggregate that stays inside the memory's per-collection hot window for the whole run (so every pass writes the document once), the `-evict` scenarios seed the `experiments` window at its limit (so every applied record evicts one and every pass also stages an archive file), and the `-archive` scenarios additionally seed a non-empty dockyard archive tree.",
    expectedDocumentWrites: "0 per steady pass (no new record), 1 per advancing flush, 2 for the `-evict` ones, which also stage an archive file; the injected run asserts the exact count per shape",
  },
  sources: baseline.sources,
  results: [],
};

for (const scenario of SELECTED) {
  const record = { scenario: label(scenario), history: scenario.history, newEvents: scenario.newEvents,
    aggregate: scenario.aggregate, archives: scenario.archives, rounds: [] };
  // A steady pass carries no new record, so it commits nothing. An advancing pass
  // writes the document exactly once, except in the `-evict` shape, which also
  // stages an archive file on every pass. Both shapes are seeded so that count is
  // stable, and the assertion is exact: a shape that drifts off its path fails the
  // run instead of silently measuring a mixture.
  const expectedWrites = scenario.newEvents === 0 ? 0 : scenario.aggregate === "evict" ? 2 : 1;
  for (let round = 1; round <= ROUNDS; round += 1) {
    const order = round % 2 === 1 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    const measured = { round, order, sides: {} };
    for (const side of order) {
      const clean = summarize(await runScenario(SIDES[side](), scenario, { clockMode: "advance", trace: false, samples: SAMPLES }));
      measured.sides[side] = { ...clean, traced: null };
      // The restart check is a correctness assertion, not a measurement: both sides
      // must find nothing left to apply, and no staged directory behind them.
      assert.deepEqual(clean.restart, { applied: 0, duplicates: scenario.history + scenario.newEvents * (WARMUP + SAMPLES) },
        `${record.scenario} (${side}): a restart must find every record already committed`);
      assert.equal(clean.stagingLeft, 0, `${record.scenario} (${side}): a committed transaction must leave no staged directory`);
      assert.equal(clean.restartedLeaves, 0, `${record.scenario} (${side}): a restart must leave no staged directory`);
      assert.equal(clean.restartDocumentUnchanged, true, `${record.scenario} (${side}): a restart must not rewrite the document`);
      assert.equal(clean.restartCheckpointUnchanged, true, `${record.scenario} (${side}): a restart must not move the checkpoint`);
      assert.equal(clean.restartArchivesUnchanged, true, `${record.scenario} (${side}): a restart must not rewrite the archive tree`);
      clean.restart = undefined; clean.restartedLeaves = undefined;
      clean.restartDocumentUnchanged = undefined; clean.restartCheckpointUnchanged = undefined;
      clean.restartArchivesUnchanged = undefined;
    }
    // The mechanism counters are one traced run per side per round; they are not
    // part of the timing comparison.
    for (const side of order) {
      const traced = summarize(await runScenario(SIDES[side](), scenario, { clockMode: "advance", trace: true, samples: SAMPLES }));
      assert.equal(traced.traced.documentWritesPerFlush, expectedWrites,
        `${record.scenario} (${side}): the scenario must take the ${expectedWrites}-write path`);
      measured.sides[side].traced = traced.traced;
    }
    assert.equal(measured.sides.baseline.traced.documentWritesPerFlush,
      measured.sides.candidate.traced.documentWritesPerFlush,
      `${record.scenario}: both implementations must take the same document-write path`);
    record.rounds.push(measured);
  }
  const pick = (side, key) => record.rounds.map((round) => round.sides[side][key]);
  const medianOf = (side, key) => median(pick(side, key));
  const tracedOf = (side, key) => median(pick(side, "traced").map((traced) => traced[key]));
  const calls = (side) => {
    const merged = new Map();
    for (const round of record.rounds) {
      for (const [name, value] of Object.entries(round.sides[side].traced.callsPerFlush)) merged.set(name, [...(merged.get(name) ?? []), value]);
    }
    return Object.fromEntries([...merged.entries()].map(([name, values]) => [name, median(values)]).sort(([left], [right]) => left < right ? -1 : 1));
  };
  record.summary = Object.fromEntries(Object.keys(SIDES).map((side) => [side, {
    wallMs: medianOf(side, "wallMs"), cpuMs: medianOf(side, "cpuMs"),
    wallRounds: pick(side, "wallMs").map(round3), cpuRounds: pick(side, "cpuMs").map(round3),
    documentBytes: medianOf(side, "documentBytes"), checkpointBytes: medianOf(side, "checkpointBytes"),
    logBytes: medianOf(side, "logBytes"),
    documentWritesPerFlush: tracedOf(side, "documentWritesPerFlush"),
    handleSyncsPerFlush: tracedOf(side, "handleSyncsPerFlush"),
    logBytesReadPerFlush: tracedOf(side, "logBytesReadPerFlush"),
    digestBytesPerFlush: tracedOf(side, "digestBytesPerFlush"),
    structuredClonesPerFlush: tracedOf(side, "structuredClonesPerFlush"),
    clonedBytesPerFlush: tracedOf(side, "clonedBytesPerFlush"),
    cloneMsPerFlush: tracedOf(side, "cloneMsPerFlush"),
    gcEntriesPerFlush: tracedOf(side, "gcEntriesPerFlush"),
    gcMsPerFlush: tracedOf(side, "gcMsPerFlush"),
    callsPerFlush: calls(side),
  }]));
  const base = record.summary.baseline, candidateSide = record.summary.candidate;
  record.delta = {
    wallPercent: round3(100 * (candidateSide.wallMs - base.wallMs) / base.wallMs),
    cpuPercent: round3(100 * (candidateSide.cpuMs - base.cpuMs) / base.cpuMs),
    digestBytesPerFlush: base.digestBytesPerFlush - candidateSide.digestBytesPerFlush,
    structuredClonesPerFlush: base.structuredClonesPerFlush - candidateSide.structuredClonesPerFlush,
    clonedBytesPerFlush: base.clonedBytesPerFlush - candidateSide.clonedBytesPerFlush,
  };
  output.results.push(record);
}

// Equivalence: frozen clock, deterministic identifiers, byte-identical durable
// output - the domain document, the checkpoint's content fields and the archive
// tree.
const equivalence = [];
for (const scenario of SELECTED) {
  const runs = {};
  for (const side of ["baseline", "candidate"]) {
    runs[side] = await runScenario(SIDES[side](), scenario, { clockMode: "freeze", trace: false, samples: EQUIVALENCE_SAMPLES });
  }
  const name = label(scenario);
  for (const side of ["baseline", "candidate"]) {
    assert.equal(runs[side].stagingLeft, 0, `${name} (${side}): a committed transaction must leave no staged directory`);
    assert.equal(runs[side].restartDocumentUnchanged, true, `${name} (${side}): a restart must not rewrite the document`);
    assert.equal(runs[side].restartCheckpointUnchanged, true, `${name} (${side}): a restart must not move the checkpoint`);
    assert.equal(runs[side].restartArchivesUnchanged, true, `${name} (${side}): a restart must not rewrite the archive tree`);
  }
  assert.equal(runs.candidate.durable.document, runs.baseline.durable.document,
    `${name}: both implementations must persist the same domain document under a frozen clock`);
  assert.deepEqual(runs.candidate.durable.checkpoint, runs.baseline.durable.checkpoint,
    `${name}: both implementations must persist the same replay checkpoint under a frozen clock`);
  for (const side of ["baseline", "candidate"]) {
    assert.equal(runs[side].durable.checkpointFileIdentityPresent, true,
      `${name} (${side}): the checkpoint must still be bound to a file identity`);
  }
  assert.deepEqual(runs.candidate.durable.archives, runs.baseline.durable.archives,
    `${name}: both implementations must persist the same archive bytes under a frozen clock`);
  if (scenario.archives) {
    assert.ok(runs.candidate.durable.archives.length >= 2,
      `${name}: the equivalence pass must compare a seeded archive tree, saw ${runs.candidate.durable.archives.length} file(s)`);
  }
  assert.ok(runs.candidate.durable.checkpoint !== null, `${name}: the measured passes must have written a checkpoint`);
  if (scenario.newEvents > 0) {
    const markers = Object.keys(JSON.parse(runs.candidate.durable.document).global.applied);
    assert.equal(markers.length, scenario.history + scenario.newEvents * (WARMUP + EQUIVALENCE_SAMPLES),
      `${name}: every record must be committed exactly once`);
  }
  const document = JSON.parse(runs.candidate.durable.document).global;
  assert.equal(document.pending, null, `${name}: a committed pass must leave no pending record`);
  if (scenario.aggregate !== "none") {
    const collections = Object.entries(document.aggregate.evolution).filter(([, value]) => Array.isArray(value));
    assert.ok(collections.length > 0, `${name}: the equivalence pass must compare a non-empty aggregate`);
  }
  equivalence.push({ scenario: name, durableByteIdentical: true,
    documentBytes: runs.candidate.documentBytes, checkpointBytes: runs.candidate.checkpointBytes,
    archiveFiles: runs.candidate.durable.archives.length });
}
output.equivalence = equivalence;
output.environment.loadAverageAtEnd = os.loadavg();
const text = JSON.stringify(output, null, 2);
if (OUT) {
  fs.mkdirSync(path.dirname(path.resolve(REPO_ROOT, OUT)), { recursive: true });
  fs.writeFileSync(path.resolve(REPO_ROOT, OUT), `${text}\n`);
  process.stderr.write(`wrote ${OUT}\n`);
}
console.log(text);
