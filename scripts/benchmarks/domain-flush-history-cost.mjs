// What one `flush()` costs when the applied history is long and new events arrive.
//
// `registration.js` calls `domainStorage.flush()` on every `agent/pre-step` and at
// the end of every Evolution tool call, so this is the plugin's hottest path. One
// piece of it re-reads the whole history for nothing:
//
// `event-log-checkpoint.js`'s `readEventLog()` hashed the consumed prefix twice when
// the log grew: once to authenticate the checkpoint the pass starts from, and once -
// over a byte range that *contains* that prefix - to authenticate the checkpoint the
// pass writes. Two HMAC instances, `2 * consumed` bytes hashed per advancing pass;
// the working tree forks one instance at the boundary instead.
//
// This script measures that against a baseline restored from git, on the real
// official `DomainFacility` + `JsonStorageBackend`, at three history sizes and with
// no new event, one new event and a burst of three. It also proves the change
// changes no durable byte.
//
//   node scripts/benchmarks/domain-flush-history-cost.mjs [--baseline <rev>] [--rounds 3] [--samples 9]
//   node scripts/benchmarks/domain-flush-history-cost.mjs --scenario history-200-new-1 --rounds 5 --samples 15
//   node scripts/benchmarks/domain-flush-history-cost.mjs --profile candidate --profile-out /tmp/c.cpuprofile
//
// Each scenario is measured in its own pass: fixture construction and signing are
// outside the timed region, and every sample asserts the exact
// `{applied, duplicates}` the pass must report. An instrumented pass counts the
// filesystem calls, the whole-document replaces and the bytes fed to SHA-256/HMAC
// per flush - those counts are the mechanism this round removes, and they are what
// makes the attribution in the write-up checkable rather than asserted. The
// `--profile` mode holds a V8 CPU profile open across the measured samples only
// (the new events' signing and append happen inside it, and are disclosed in the
// write-up).
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
const BASELINE_REV = option("baseline", "f469d57");
const ROUNDS = Number(option("rounds", 3));
const SAMPLES = Number(option("samples", 9));
const WARMUP = Number(option("warmup", 3));
const EQUIVALENCE_SAMPLES = Number(option("equivalence-samples", 3));
// A separate invocation for the CPU attribution: only the measured flushes are
// profiled (no fixture build, no signing), so the profile's top frames are the work
// one flush does. Summarize it with the two rules in the write-up: self time per
// function, and the nearest `lib/` frame as the caller.
const PROFILE_SIDE = option("profile", null);
const PROFILE_SCENARIO = option("profile-scenario", "history-20000-new-1");
const PROFILE_OUT = option("profile-out", null);
const FROZEN_NOW = Date.parse("2026-11-03T00:00:00.000Z");
const KEY = "b".repeat(64);
const SOURCE_FILES = ["lib/domain-storage.js", "lib/event-log-checkpoint.js"];

// Shape guards. The baseline must be the implementation this round replaces: the
// per-record path publishes nothing it has not verified, and its two whole-history
// operations are the ones described above. The candidate must be the one this round
// leaves behind. A revision that matches neither side cannot be compared by this
// script, and comparing the same code twice would silently report a zero difference.
const BASELINE_SHAPES = [
  "const boundary = stat.size === consumed ? null : crypto.createHmac(DIGEST_ALGORITHM, key);",
];
const CANDIDATE_SHAPES = [
  "if (consumedHex === null && offset + verifiedBytes >= consumed) consumedHex = digest.fork().hex();",
];
const ABSENT_IN_CANDIDATE = BASELINE_SHAPES;
const ABSENT_IN_BASELINE = CANDIDATE_SHAPES;

// `--scenario` narrows the run to some of the nine shapes (comma separated, e.g.
// `history-200-new-1`); by default every shape is measured.
const ONLY = option("scenario", null)?.split(",").map((name) => name.trim()).filter(Boolean) ?? null;
const label = (scenario) => `history-${scenario.history}-new-${scenario.newEvents}`;
const SCENARIOS = [200, 2000, 20000].flatMap((history) => [
  { history, newEvents: 0 },
  { history, newEvents: 1 },
  { history, newEvents: 3 },
]).filter((scenario) => ONLY === null || ONLY.includes(label(scenario)));

function materializeBaseline() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flush-history-cost-baseline-"));
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

/** Filesystem accounting, plus the bytes each pass hands to SHA-256/HMAC.
 *
 *  Sync calls and the `crypto` factories go through the CJS objects (the ESM named
 *  bindings are re-synced), which is what `lib/` imports, so every call the port
 *  makes is counted. `digestBytes` is the number this round is about: the replay
 *  checkpoint is authenticated with SHA-256, and hashing the same range twice shows
 *  up here as bytes, independent of how fast this machine happens to hash. */
const TRACED = ["fsyncSync", "writeFileSync", "appendFileSync", "renameSync", "linkSync", "mkdirSync", "rmSync",
  "readFileSync", "readSync", "lstatSync", "readdirSync", "statSync", "copyFileSync", "openSync"];
function installer(roots) {
  const originals = new Map();
  const counts = new Map();
  const state = { documentWrites: 0, tokenWrites: 0, logBytesRead: 0, digestBytes: 0 };
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
  // A keyed or plain digest, wrapped so its input length is counted. `copy()` is
  // what the candidate uses to fork the state at the checkpoint boundary, so the
  // wrapper has to keep it - and it must not count the forked instance twice: a
  // fork carries the bytes already counted on the instance it was copied from.
  const wrapDigest = (inner) => ({
    update(data) { state.digestBytes += typeof data === "string" ? Buffer.byteLength(data) : data.length; inner.update(data); return this; },
    digest(...values) { return inner.digest(...values); },
    copy(...values) { return wrapDigest(inner.copy(...values), 0); },
  });
  for (const name of ["createHash", "createHmac"]) {
    originals.set(`crypto.${name}`, crypto[name]);
    crypto[name] = function traced(...values) { return wrapDigest(originals.get(`crypto.${name}`).apply(this, values)); };
  }
  syncBuiltinESMExports();
  return {
    reset() { counts.clear(); state.documentWrites = 0; state.tokenWrites = 0; state.logBytesRead = 0; state.digestBytes = 0; },
    read() { return { documentWrites: state.documentWrites, tokenWrites: state.tokenWrites,
      logBytesRead: state.logBytesRead, digestBytes: state.digestBytes, calls: Object.fromEntries(counts.entries()) }; },
    restore() {
      for (const [name, method] of originals) {
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

/** Commit a history of `count` signed records as the document's applied ledger and
 *  as the event log, so the measured passes face a lived-in install. The aggregate
 *  starts empty: this round touches the marker table and the log bytes, not the
 *  aggregate, and an empty aggregate keeps that boundary visible in the numbers. */
/** A seeded active archive, so the equivalence pass compares a non-empty archive
 *  tree instead of two empty directories. The measured passes run without it: this
 *  round does not touch archive I/O, and a seeded archive would add reconcile work
 *  to every sample. */
const OBSERVATION_ROWS = Array.from({ length: 24 }, (_, index) => ({
  id: `seed-obs-${index}`, patternKey: `pattern-${index}`, type: 'agent/error', severity: 'error',
  observedAt: `2026-10-20T00:00:${String(index).padStart(2, '0')}.000Z`, message: `seeded observation ${index}`,
}));
function seedArchives(root) {
  const directory = path.join(root, 'dockyard');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'state.json.observations-archive.jsonl'),
    `${OBSERVATION_ROWS.map((row) => JSON.stringify(row)).join('\n')}\n`, { mode: 0o600 });
}

async function seedHistory(libDirectory, root, eventLog, count) {
  const { signEventBridgeEnvelope } = globalThis.__bridge;
  const lines = [];
  const applied = {};
  for (let sequence = 1; sequence <= count; sequence += 1) {
    const envelope = signEventBridgeEnvelope(SIGNED(sequence), { key: KEY, sequence });
    applied[envelope.event.eventId] = envelope.mac;
    lines.push(JSON.stringify(envelope));
  }
  fs.writeFileSync(eventLog, count === 0 ? "" : `${lines.join("\n")}\n`);
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
  return { sequence: count };
}

/** One measured pass over a scenario, from fixture build to durable artifacts. */
async function runScenario(libDirectory, { history, newEvents }, { clockMode, trace, samples, profile = null, archives = false }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `flush-history-cost-${history}-${newEvents}-`));
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
    const { sequence: seeded } = await seedHistory(libDirectory, root, eventLog, history);
    if (archives) seedArchives(root);
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
    assert.deepEqual(cold, { applied: 0, duplicates: history }, `history ${history}: the seeded history must already be committed`);
    for (let warm = 0; warm < WARMUP; warm += 1) { append(newEvents); await aligned(() => port.flush()); }
    const expected = (index) => ({ applied: newEvents, duplicates: history + newEvents * (WARMUP + index) });
    if (counter) counter.reset();
    // Profiling starts here: the fixture build, the cold pass and its signing are
    // behind us, so the profile holds the measured `flush()` calls only.
    await profile?.start?.();
    for (let index = 0; index < samples; index += 1) {
      append(newEvents);
      const cpu = process.cpuUsage();
      const started = performance.now();
      const result = await aligned(() => port.flush());
      const wallMs = performance.now() - started;
      const used = process.cpuUsage(cpu);
      assert.deepEqual(result, expected(index), `${label({ history, newEvents })}: the pass must report what it applied`);
      rows.push({ wallMs, cpuMs: (used.user + used.system) / 1000 });
    }
    await profile?.stop?.();
    const traced = counter ? counter.read() : null;
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
    const beforeRestart = { document: read(roots.document), checkpoint: read(roots.checkpoint) };
    await port.close();
    opened = null;
    const reopened = await openPort(libDirectory, root, eventLog);
    const restart = await reopened.port.flush();
    const restartedLeaves = fs.existsSync(roots.staging) ? fs.readdirSync(roots.staging).length : 0;
    await reopened.port.close();
    await reopened.backend.close();
    const afterRestart = { document: read(roots.document), checkpoint: read(roots.checkpoint) };
    return { rows, traced, durable, stagingLeft, restartedLeaves, restart,
      restartDocumentUnchanged: beforeRestart.document === afterRestart.document,
      restartCheckpointUnchanged: beforeRestart.checkpoint === afterRestart.checkpoint,
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
  traced: run.traced ? {
    documentWritesPerFlush: round3(run.traced.documentWrites / run.rows.length),
    tokenWritesPerFlush: round3(run.traced.tokenWrites / run.rows.length),
    handleSyncsPerFlush: round3(Object.entries(run.traced.calls)
      .filter(([name]) => name.endsWith("/sync")).reduce((total, [, value]) => total + value, 0) / run.rows.length),
    logBytesReadPerFlush: Math.round(run.traced.logBytesRead / run.rows.length),
    digestBytesPerFlush: Math.round(run.traced.digestBytes / run.rows.length),
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

if (PROFILE_SIDE !== null) {
  // Profiling mode: hold a V8 CPU profile open across one side's measured passes,
  // then stop. The profile covers the fixture build too, but every frame this round
  // is about is reached from `flush()` and is reported with its nearest `lib/`
  // caller, so the attribution does not depend on excluding anything by hand.
  const scenario = SCENARIOS.find((candidate) => label(candidate) === PROFILE_SCENARIO);
  assert.ok(scenario, `unknown --profile-scenario ${PROFILE_SCENARIO}`);
  assert.ok(SIDES[PROFILE_SIDE], `unknown --profile ${PROFILE_SIDE}`);
  const samples = Number(option("profile-samples", 6));
  const inspector = (await import("node:inspector")).default ?? await import("node:inspector");
  const session = new inspector.Session();
  session.connect();
  const post = (method) => new Promise((resolve, reject) => session.post(method, (error, value) => error ? reject(error) : resolve(value)));
  await post("Profiler.enable");
  let profile = null;
  const controls = {
    start: async () => { await post("Profiler.start"); },
    stop: async () => { profile = (await post("Profiler.stop")).profile; },
  };
  await runScenario(SIDES[PROFILE_SIDE](), scenario, { clockMode: "advance", trace: false, samples, profile: controls });
  session.disconnect();
  if (PROFILE_OUT) fs.writeFileSync(PROFILE_OUT, JSON.stringify(profile));
  console.log(JSON.stringify({ side: PROFILE_SIDE, scenario: label(scenario), samples,
    profileOut: PROFILE_OUT, profiled: true }, null, 2));
} else {
  await report();
}

async function report() {

const output = {
  baseline: BASELINE_REV, rounds: ROUNDS, samples: SAMPLES, warmup: WARMUP,
  scenarios: SCENARIOS.map((scenario) => label(scenario)),
  environment: { node: process.version, platform: `${process.platform}/${process.arch}`, cpus: os.cpus().length,
    loadAverageAtStart: os.loadavg() },
  protocol: {
    measurementClock: "deterministic clock advancing 1 ms per read (production condition, reproducible)",
    equivalenceClock: "frozen at 2026-11-03T00:00:00.000Z with a deterministic UUID sequence; durable output must be byte-identical",
    order: "each round alternates which side runs first",
    sides: "baseline restores lib/domain-storage.js and lib/event-log-checkpoint.js from the recorded revision into a copy of lib/; candidate is this working tree",
    warmup: "the seeded history is absorbed by a cold pass, then `warmup` flushed bursts",
    instrumentedPass: "one additional pass per side with wrapped fs/crypto calls; counts are per flush",
    historyShape: "the seeded history is a committed applied marker table plus its signed log; the aggregate starts empty, because this round touches neither the aggregate nor its projection",
  },
  sources: baseline.sources,
  results: [],
};

for (const scenario of SCENARIOS) {
  const record = { scenario: label(scenario), history: scenario.history, newEvents: scenario.newEvents, rounds: [] };
  for (let round = 1; round <= ROUNDS; round += 1) {
    const order = round % 2 === 1 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    const measured = { round, order, sides: {} };
    for (const side of order) {
      const clean = summarize(await runScenario(SIDES[side](), scenario, { clockMode: "advance", trace: false, samples: SAMPLES }));
      const traced = summarize(await runScenario(SIDES[side](), scenario, { clockMode: "advance", trace: true, samples: SAMPLES }));
      measured.sides[side] = { ...clean, traced: traced.traced };
      // The restart check is a correctness assertion, not a measurement: both sides
      // must find nothing left to apply, and no staged directory behind them.
      assert.deepEqual(clean.restart, { applied: 0, duplicates: scenario.history + scenario.newEvents * (WARMUP + SAMPLES) },
        `${record.scenario} (${side}): a restart must find every record already committed`);
      assert.equal(clean.stagingLeft, 0, `${record.scenario} (${side}): a committed transaction must leave no staged directory`);
      assert.equal(clean.restartedLeaves, 0, `${record.scenario} (${side}): a restart must leave no staged directory`);
      assert.equal(clean.restartDocumentUnchanged, true, `${record.scenario} (${side}): a restart must not rewrite the document`);
      assert.equal(clean.restartCheckpointUnchanged, true, `${record.scenario} (${side}): a restart must not move the checkpoint`);
      clean.restart = undefined; clean.restartedLeaves = undefined;
      clean.restartDocumentUnchanged = undefined; clean.restartCheckpointUnchanged = undefined;
    }
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
    callsPerFlush: calls(side),
  }]));
  const base = record.summary.baseline, candidateSide = record.summary.candidate;
  record.delta = {
    wallPercent: round3(100 * (candidateSide.wallMs - base.wallMs) / base.wallMs),
    cpuPercent: round3(100 * (candidateSide.cpuMs - base.cpuMs) / base.cpuMs),
    digestBytesPerFlush: base.digestBytesPerFlush - candidateSide.digestBytesPerFlush,
  };
  output.results.push(record);
}

// Equivalence: frozen clock, deterministic identifiers, byte-identical durable
// output. The checkpoint digest is the part that must not move: the candidate
// computes it from one pass over the log instead of two, and if that value changed
// at all this pass fails here rather than in the field.
const equivalence = [];
for (const scenario of SCENARIOS) {
  const runs = {};
  for (const side of ["baseline", "candidate"]) {
    runs[side] = await runScenario(SIDES[side](), scenario, { clockMode: "freeze", trace: false, samples: EQUIVALENCE_SAMPLES, archives: true });
  }
  const name = label(scenario);
  for (const side of ["baseline", "candidate"]) {
    assert.equal(runs[side].stagingLeft, 0, `${name} (${side}): a committed transaction must leave no staged directory`);
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
  // The archive tree is seeded in this pass, so the comparison above is not a
  // comparison of two empty directories: the seeded file and the derived index are
  // both part of it.
  assert.ok(runs.candidate.durable.archives.length >= 2,
    `${name}: the equivalence pass must compare a seeded archive tree, saw ${runs.candidate.durable.archives.length} file(s)`);
  // The equivalence pass must not degenerate into a comparison of two empty runs.
  assert.ok(runs.candidate.durable.checkpoint !== null, `${name}: the measured passes must have written a checkpoint`);
  if (scenario.newEvents > 0) {
    const markers = Object.keys(JSON.parse(runs.candidate.durable.document).global.applied);
    assert.equal(markers.length, scenario.history + scenario.newEvents * (WARMUP + EQUIVALENCE_SAMPLES),
      `${name}: every record must be committed exactly once`);
  }
  equivalence.push({ scenario: name, durableByteIdentical: true,
    documentBytes: runs.candidate.documentBytes, checkpointBytes: runs.candidate.checkpointBytes,
    archiveFiles: runs.candidate.durable.archives.length });
}
output.equivalence = equivalence;
output.environment.loadAverageAtEnd = os.loadavg();
console.log(JSON.stringify(output, null, 2));
}
