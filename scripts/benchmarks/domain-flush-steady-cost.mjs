// What one steady-state `flush()` costs, where it spends it, and the shortcut this
// round measured and withdrew.
//
// `registration.js` calls `domainStorage.flush()` on every `agent/pre-step` and at
// the end of every Evolution tool call. The common case by far is the pass with no
// new event: it authenticates the consumed log prefix against the replay
// checkpoint and proves that the committed marker map is still the map that
// checkpoint was absorbed into, then applies nothing.
//
// That proof is `appliedDigest = sha256(JSON.stringify(applied))` and at 20000
// records it is about half of the steady-state flush. The map is normally the very
// object the previous pass digested, so "re-use what we just computed" is the
// obvious shortcut, and this script measures it: the same fixture runs against the
// committed implementation and against two versions of that shortcut (content
// comparison, and object identity), with the same call sites attributed.
//
// The shortcut is not equivalent, and the probes below are why. They are part of
// the measurement, not an afterthought: a faster number is only reported next to
// the inputs it silently certifies. Nothing in `lib/` was changed for this round -
// the section called `withdrawn` is the evidence for that decision, and
// `test/domain-storage/applied-digest-read-shape.test.js` pins the behaviour.
//
//   node scripts/benchmarks/domain-flush-steady-cost.mjs
//   node scripts/benchmarks/domain-flush-steady-cost.mjs --rounds 5 --samples 15 --out /tmp/steady.json
//   node scripts/benchmarks/domain-flush-steady-cost.mjs --scenario history-20000-new-0 --rounds 5
//
// Every fixture is built in its own directory under `os.tmpdir()` on the real
// official `DomainFacility` + `JsonStorageBackend`; nothing outside /tmp is written.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";
import { pathToFileURL, fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const ROUNDS = Number(option("rounds", 5));
const SAMPLES = Number(option("samples", 15));
const WARMUP = Number(option("warmup", 3));
const VARIANT_ROUNDS = Number(option("variant-rounds", 3));
const BEHAVIOR_HISTORY = Number(option("behavior-history", 2000));
const ATTRIBUTION_SAMPLES = Number(option("attribution-samples", 9));
const OUT = option("out", null);
const FROZEN_NOW = Date.parse("2026-11-03T00:00:00.000Z");
const KEY = "b".repeat(64);
const SOURCE_FILES = ["lib/event-log-checkpoint.js", "lib/domain-storage.js"];

const ONLY = option("scenario", null)?.split(",").map((name) => name.trim()).filter(Boolean) ?? null;
const label = (scenario) => `history-${scenario.history}-new-${scenario.newEvents}`;
// The measured shapes: the three steady states this round is about, plus one
// committing shape to show the pass that carries a new event is untouched.
const SCENARIOS = [{ history: 200, newEvents: 0 }, { history: 2000, newEvents: 0 },
  { history: 20000, newEvents: 0 }, { history: 20000, newEvents: 1 }]
  .filter((scenario) => ONLY === null || ONLY.includes(label(scenario)));
const STEADY = SCENARIOS.filter((scenario) => scenario.newEvents === 0);

const BEHAVIORS = ["tampered-prefix", "checkpoint-deleted", "marker-rewound-replaced",
  "marker-rewound-in-place", "torn-trailing-record", "restart"];

/** One `digestApplied` implementation each. `committed` is this working tree; the
 *  other two are the shortcut that was measured and withdrawn, patched into a
 *  scratch copy of the same `lib/` by exact substring. */
const DIGEST_BASELINE = `export function digestApplied(applied) {
  return crypto.createHash('sha256').update(JSON.stringify(applied)).digest('hex');
}`;
const DIGEST_MEMO_CONTENT = `const APPLIED_DIGEST_MEMO = new WeakMap();

export function digestApplied(applied) {
  const cached = APPLIED_DIGEST_MEMO.get(applied);
  if (cached !== undefined && appliedContentMatches(applied, cached)) return cached.digest;
  const digest = crypto.createHash('sha256').update(JSON.stringify(applied)).digest('hex');
  const snapshot = appliedSnapshot(applied);
  if (snapshot !== null && appliedContentMatches(applied, snapshot)) {
    APPLIED_DIGEST_MEMO.set(applied, { keys: snapshot.keys, values: snapshot.values, digest });
  } else APPLIED_DIGEST_MEMO.delete(applied);
  return digest;
}

function appliedSnapshot(applied) {
  const keys = Object.keys(applied);
  const values = new Array(keys.length);
  for (let index = 0; index < keys.length; index += 1) {
    const value = applied[keys[index]];
    if (typeof value !== 'string') return null;
    values[index] = value;
  }
  return { keys, values };
}

function appliedContentMatches(applied, snapshot) {
  const keys = Object.keys(applied);
  if (keys.length !== snapshot.keys.length) return false;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const value = applied[key];
    if (key !== snapshot.keys[index] || typeof value !== 'string' || value !== snapshot.values[index]) return false;
  }
  return true;
}`;
const DIGEST_MEMO_IDENTITY = `const APPLIED_DIGEST_MEMO = new WeakMap();

export function digestApplied(applied) {
  const cached = APPLIED_DIGEST_MEMO.get(applied);
  if (cached !== undefined) return cached;
  const digest = crypto.createHash('sha256').update(JSON.stringify(applied)).digest('hex');
  APPLIED_DIGEST_MEMO.set(applied, digest);
  return digest;
}`;
const VARIANTS = {
  "memo-content": { digest: DIGEST_MEMO_CONTENT, guard: "appliedContentMatches" },
  "memo-identity": { digest: DIGEST_MEMO_IDENTITY, guard: "APPLIED_DIGEST_MEMO" },
};

/** A scratch `lib/` with one variant's `digestApplied`, sharing this repo's
 *  `node_modules`. The patch fails loudly if the committed function is not what
 *  the variant replaces, so a drifted tree cannot silently produce a no-op. */
function materializeVariant(name) {
  const variant = VARIANTS[name];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `flush-steady-${name}-`));
  fs.cpSync(path.join(REPO_ROOT, "lib"), path.join(directory, "lib"), { recursive: true });
  fs.symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(directory, "node_modules"));
  const file = path.join(directory, "lib", "event-log-checkpoint.js");
  const source = fs.readFileSync(file, "utf8");
  assert.equal(source.split(DIGEST_BASELINE).length - 1, 1,
    `${name}: the committed digestApplied must occur exactly once, and be the single-serialization one`);
  const patched = source.replace(DIGEST_BASELINE, variant.digest);
  assert.ok(patched.includes(variant.guard), `${name}: the patch must add its guard`);
  fs.writeFileSync(file, patched);
  return directory;
}

/** What the committed sources must look like: no cache of a derived digest. */
function assertCommittedShapes() {
  const digest = fs.readFileSync(path.join(REPO_ROOT, "lib", "event-log-checkpoint.js"), "utf8");
  assert.ok(digest.includes(DIGEST_BASELINE), "this working tree must still digest the map on every call");
  for (const marker of ["APPLIED_DIGEST_MEMO", "appliedContentMatches", "appliedSnapshot"]) {
    assert.equal(digest.includes(marker), false, `the committed tree must not carry the withdrawn ${marker}`);
  }
  return digest;
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

// Deterministic identifiers, installed before any library module is imported: an
// ES module binds a builtin export once.
const UUID_STATE = { seed: 0 };
{
  const original = crypto.randomUUID;
  crypto.randomUUID = () => `${String(++UUID_STATE.seed).padStart(8, "0")}-0000-4000-8000-000000000000`;
  process.on("exit", () => { crypto.randomUUID = original; });
  syncBuiltinESMExports();
}
const resetUuidSequence = (base = 0) => { UUID_STATE.seed = base; };

const SIGNED = (sequence) => ({ schema: 1, eventId: `evolution:measurement-completed:steady-experiment-${sequence}`,
  eventType: "measurement-completed", experimentId: `steady-experiment-${sequence}`,
  proposalId: `steady-proposal-${sequence}`, target: "plugin:steady", capability: "plugin:steady",
  lineageId: "plugin:steady", status: "measured", measurement: { latency: 12, throughput: 100 },
  evidence: { summary: "Synthetic measured evolution event" }, canary: {},
  audit: { producer: "dsh-evolution-orchestrator", at: "2026-10-07T00:00:00.000Z" } });

/** Filesystem accounting, plus the bytes each pass hands to SHA-256/HMAC.
 *
 *  The `crypto` factories and the synchronous `fs` calls go through the CJS
 *  objects (the ESM named bindings are re-synced), which is what `lib/` imports,
 *  so every call the port makes is counted. `digestBytes` is the number the
 *  shortcut moves: it is one SHA-256 over the marker map's JSON text, and skipping
 *  it shows up here as bytes, independent of how fast this machine hashes. */
const TRACED = ["fsyncSync", "writeFileSync", "appendFileSync", "renameSync", "linkSync", "mkdirSync", "rmSync",
  "readFileSync", "readSync", "lstatSync", "readdirSync", "statSync", "copyFileSync", "openSync"];
function installer(roots) {
  const originals = new Map();
  const counts = new Map();
  const state = { documentWrites: 0, tokenWrites: 0, logBytesRead: 0, digestBytes: 0, largeStringifiedBytes: 0 };
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
        handle.sync = async function counted(...inner) { bump("sync", target); return sync(...inner); };
        return handle;
      });
    };
  }
  const wrapDigest = (inner) => ({
    update(data) { state.digestBytes += typeof data === "string" ? Buffer.byteLength(data) : data.length; inner.update(data); return this; },
    digest(...values) { return inner.digest(...values); },
    copy(...values) { return wrapDigest(inner.copy(...values)); },
  });
  for (const name of ["createHash", "createHmac"]) {
    originals.set(`crypto.${name}`, crypto[name]);
    crypto[name] = function traced(...values) { return wrapDigest(originals.get(`crypto.${name}`).apply(this, values)); };
  }
  // The map serialization a re-using digest skips: counted by its output length,
  // which is what would have been hashed.
  originals.set("JSON.stringify", JSON.stringify);
  JSON.stringify = function traced(...values) {
    const text = originals.get("JSON.stringify").apply(this, values);
    if (state.countingStringify && typeof text === "string" && text.length > 4096) state.largeStringifiedBytes += text.length;
    return text;
  };
  syncBuiltinESMExports();
  return {
    reset() {
      counts.clear();
      state.documentWrites = 0; state.tokenWrites = 0; state.logBytesRead = 0; state.digestBytes = 0;
      state.largeStringifiedBytes = 0; state.countingStringify = true;
    },
    read() { return { documentWrites: state.documentWrites, tokenWrites: state.tokenWrites,
      logBytesRead: state.logBytesRead, digestBytes: state.digestBytes,
      largeStringifiedBytes: state.largeStringifiedBytes, calls: Object.fromEntries(counts.entries()) }; },
    restore() {
      JSON.stringify = originals.get("JSON.stringify");
      for (const [name, method] of originals) {
        if (name === "JSON.stringify") continue;
        if (name.startsWith("promises.")) fs.promises[name.slice("promises.".length)] = method;
        else if (name.startsWith("crypto.")) crypto[name.slice("crypto.".length)] = method;
        else fs[name] = method;
      }
      syncBuiltinESMExports();
    },
  };
}

/** Per-phase timers, injected by exact-substring patch into a scratch copy of the
 *  side's sources. Every side gets the same wrappers on the same call sites, so the
 *  phase figures are comparable; a call site that moved fails the patch instead of
 *  reporting a zero. Every wrapper is an expression wrap, so a refusal that returns
 *  early still closes its phase. */
const TAIL_BLOCK = `  const text = tail.toString('utf8');
  const lines = text.split('\\n');
  const remainder = lines.pop();
  let completeRecords = 0;
  for (const line of lines) if (line.trim() !== '') completeRecords += 1;`;
const TAIL_WRAPPED = `  const __tail = globalThis.__timed('plan.tail', () => { ${TAIL_BLOCK.trim().replaceAll('\n  ', ' ')} return { lines, remainder, completeRecords }; });
  const { lines, remainder, completeRecords } = __tail;`;
const ATTRIBUTION_PATCHES = [
  ["lib/event-log-checkpoint.js",
    "if (checkpoint.appliedDigest !== digestApplied(applied)) return false;",
    "if (checkpoint.appliedDigest !== globalThis.__timed('plan.digestApplied', () => digestApplied(applied))) return false;"],
  ["lib/event-log-checkpoint.js",
    "const read = readEventLog({ file, key, consumed: candidate });",
    "const read = globalThis.__timed('plan.readEventLog', () => readEventLog({ file, key, consumed: candidate }));"],
  ["lib/event-log-checkpoint.js", TAIL_BLOCK, TAIL_WRAPPED],
  ["lib/domain-storage.js",
    "const plan = planEventLogReplay({ file: config.eventBridgePath, key: config.eventBridgeKey, writer,\n      checkpoint: readEventLogCheckpoint(checkpointFile), applied: domain.global.get().applied });",
    "const plan = globalThis.__timed('plan.total', () => planEventLogReplay({ file: config.eventBridgePath, key: config.eventBridgeKey, writer,\n      checkpoint: globalThis.__timed('plan.checkpointRead', () => readEventLogCheckpoint(checkpointFile)), applied: domain.global.get().applied }));"],
];
function instrument(source, file) {
  let patched = source;
  for (const [target, anchor, replacement] of ATTRIBUTION_PATCHES) {
    if (target !== file) continue;
    assert.equal(patched.split(anchor).length - 1, 1, `${file}: ${JSON.stringify(anchor.slice(0, 60))} must occur exactly once`);
    patched = patched.replace(anchor, replacement);
  }
  return patched;
}

const PROLOGUE = `import { performance as __performance } from "node:perf_hooks";
{
  const state = new Map();
  globalThis.__timed = (name, task) => { const at = __performance.now(); try { return task(); } finally { state.set(name, (state.get(name) ?? 0) + (__performance.now() - at)); } };
  globalThis.__attrReset = () => { state.clear(); };
  globalThis.__attrRead = () => Object.fromEntries(state);
}
`;

function materializeAttributed(libDirectory) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flush-steady-attr-"));
  fs.cpSync(path.join(libDirectory, "lib"), path.join(directory, "lib"), { recursive: true });
  fs.symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(directory, "node_modules"));
  for (const file of SOURCE_FILES) {
    const source = fs.readFileSync(path.join(libDirectory, file), "utf8");
    const patched = instrument(source, file);
    assert.notEqual(patched, source, `${file}: the instrumentation must change the source`);
    fs.writeFileSync(path.join(directory, file), file === "lib/event-log-checkpoint.js" ? PROLOGUE + patched : patched);
  }
  return directory;
}

const { signEventBridgeEnvelope } = await import(pathToFileURL(path.join(REPO_ROOT, "lib", "orchestrator.js")).href);

async function seedHistory(libDirectory, root, eventLog, count) {
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

async function openPort(libDirectory, root, eventLog) {
  const { openDomainStorage, evolutionDomainSpec } = await import(pathToFileURL(path.join(libDirectory, "lib", "domain-storage.js")).href);
  const { DomainFacility } = await import("@deepseek-ai/dsh-storage-domain");
  const { JsonStorageBackend } = await import("@deepseek-ai/dsh-storage-json");
  const backend = new JsonStorageBackend(path.join(root, "official"));
  const ctx = { emit() {}, on() { return () => {}; }, logger: { warn() {}, error() {} },
    storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: "json" });
  const port = await openDomainStorage(ctx, { presetDir: root, eventBridgePath: eventLog, eventBridgeKey: KEY });
  return { port, backend, ctx, evolutionDomainSpec };
}

function rootsOf(root, eventLog) {
  return { staging: path.join(root, "domain-staging"), live: path.join(root, "dockyard"),
    official: path.join(root, "official"), document: path.join(root, "official", "evolution_domain.json"),
    token: path.join(root, "domain-commit.token"), eventLog,
    checkpoint: path.join(root, "event-log.checkpoint.json") };
}

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

/** One measured scenario, from fixture build to durable artifacts. */
async function runScenario(libDirectory, { history, newEvents }, { clockMode, trace, samples }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `flush-steady-${history}-${newEvents}-`));
  const eventLog = path.join(root, "execution-events.jsonl");
  const roots = rootsOf(root, eventLog);
  const counter = trace ? installer(roots) : null;
  resetUuidSequence();
  const restoreClock = installClock(clockMode);
  let opened = null;
  const rows = [];
  try {
    const { sequence: seeded } = await seedHistory(libDirectory, root, eventLog, history);
    opened = await openPort(libDirectory, root, eventLog);
    const { port } = opened;
    let sequence = seeded;
    const append = (count) => {
      const lines = [];
      for (let index = 0; index < count; index += 1) {
        sequence += 1;
        lines.push(JSON.stringify(signEventBridgeEnvelope(SIGNED(sequence), { key: KEY, sequence })));
      }
      if (lines.length > 0) fs.appendFileSync(eventLog, `${lines.join("\n")}\n`);
    };
    let sequenceBase = 0;
    const aligned = async (task) => { sequenceBase += 1000; resetUuidSequence(sequenceBase); return task(); };
    const cold = await aligned(() => port.flush());
    assert.deepEqual(cold, { applied: 0, duplicates: history }, `history ${history}: the seeded history must already be committed`);
    for (let warm = 0; warm < WARMUP; warm += 1) { append(newEvents); await aligned(() => port.flush()); }
    const expected = (index) => ({ applied: newEvents, duplicates: history + newEvents * (WARMUP + index) });
    if (counter) counter.reset();
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
    const traced = counter ? counter.read() : null;
    const read = (file) => fs.readFileSync(file, "utf8").split(root).join("<root>");
    const checkpoint = fs.existsSync(roots.checkpoint) ? JSON.parse(read(roots.checkpoint)) : null;
    const durable = {
      document: fs.existsSync(roots.document) ? read(roots.document) : null,
      checkpoint: checkpoint === null ? null : checkpointContent(read(roots.checkpoint)),
      checkpointFileIdentityPresent: checkpoint !== null && typeof checkpoint.file?.dev === "string" && typeof checkpoint.file?.ino === "string",
      archives: Object.entries(archiveTree(roots.live)).sort(([left], [right]) => left < right ? -1 : 1)
        .map(([name, digest]) => [name, digest]),
    };
    const stagingLeft = fs.existsSync(roots.staging) ? fs.readdirSync(roots.staging).length : 0;
    const beforeRestart = { document: read(roots.document), checkpoint: read(roots.checkpoint) };
    await port.close();
    opened = null;
    const reopened = await openPort(libDirectory, root, eventLog);
    const restart = await reopened.port.flush();
    await reopened.port.close();
    await reopened.backend.close();
    const afterRestart = { document: read(roots.document), checkpoint: read(roots.checkpoint) };
    return { rows, traced, durable, stagingLeft, restart,
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

/** The checkpoint fields that are content: everything but the log's file identity. */
function checkpointContent(text) {
  const json = JSON.parse(text);
  return { schema: json.schema, bytes: json.bytes, records: json.records, digest: json.digest,
    writer: json.writer, first: json.first, last: json.last, appliedDigest: json.appliedDigest };
}

/** One refusal/recovery outcome, with the outcome asserted here rather than only
 *  compared between sides: a shared mistake must fail this script. */
async function runBehavior(libDirectory, name, { history }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `flush-steady-behavior-${name}-`));
  const eventLog = path.join(root, "execution-events.jsonl");
  const roots = rootsOf(root, eventLog);
  resetUuidSequence();
  let opened = null;
  try {
    const { sequence: seeded } = await seedHistory(libDirectory, root, eventLog, history);
    opened = await openPort(libDirectory, root, eventLog);
    const { port, evolutionDomainSpec } = opened;
    let sequence = seeded;
    const appendOne = () => {
      sequence += 1;
      const envelope = signEventBridgeEnvelope(SIGNED(sequence), { key: KEY, sequence });
      fs.appendFileSync(eventLog, `${JSON.stringify(envelope)}\n`);
      return envelope;
    };
    const handle = () => opened.ctx.storageDomain.get(evolutionDomainSpec.name).global;
    const appliedNow = () => opened.ctx.storageDomain.get(evolutionDomainSpec.name).global.get().applied;
    const read = (file) => fs.readFileSync(file, "utf8").split(root).join("<root>");
    const snapshot = () => ({ document: read(roots.document), checkpoint: read(roots.checkpoint) });
    assert.deepEqual(await port.flush(), { applied: 0, duplicates: history }, `${name}: the seeded history must already be committed`);
    const pristine = snapshot();
    const outcome = { name };
    const markers = () => Object.keys(appliedNow()).length;
    if (name === "tampered-prefix") {
      // Rewrite one byte of a record the checkpoint covers, keeping the length, so
      // only the authenticated prefix digest can notice.
      const bytes = fs.readFileSync(eventLog);
      const index = bytes.indexOf(Buffer.from("steady-experiment-1\""));
      assert.ok(index > 0, `${name}: the record to tamper with must be in the log`);
      bytes[index] = "S".charCodeAt(0);
      fs.writeFileSync(eventLog, bytes);
      outcome.flush = await port.flush().then((value) => ({ returned: value }),
        (error) => ({ threw: `${error.name}: ${String(error.message).slice(0, 120)}` }));
      assert.match(outcome.flush.threw ?? "", /E_DOMAIN_EVENT_AUTH/, `${name}: a changed prefix byte must be refused`);
      outcome.durableUnchanged = JSON.stringify(snapshot()) === JSON.stringify(pristine);
      assert.equal(outcome.durableUnchanged, true, `${name}: a refused pass must publish nothing`);
      outcome.markers = markers();
      assert.equal(outcome.markers, history, `${name}: a refused pass must not drop a marker`);
    } else if (name === "checkpoint-deleted") {
      fs.rmSync(roots.checkpoint);
      outcome.flush = await port.flush();
      assert.deepEqual(outcome.flush, { applied: 0, duplicates: history },
        `${name}: without a checkpoint every record must be re-verified as already applied`);
      outcome.checkpointContentUnchanged = JSON.stringify(checkpointContent(read(roots.checkpoint)))
        === JSON.stringify(checkpointContent(pristine.checkpoint));
      assert.equal(outcome.checkpointContentUnchanged, true, `${name}: re-verification must rewrite the same checkpoint`);
      outcome.durableUnchanged = read(roots.document) === pristine.document;
      assert.equal(outcome.durableUnchanged, true, `${name}: re-verification must not rewrite the document`);
      outcome.markers = markers();
    } else if (name === "marker-rewound-replaced" || name === "marker-rewound-in-place") {
      // The official handle is available to anything holding the context, so the
      // marker map can be rewound behind the port's back: once by replacing the map
      // object, once by editing the object the port already digested in place.
      const middle = SIGNED(Math.floor(history / 2)).eventId;
      const rewound = handle();
      if (name === "marker-rewound-replaced") {
        const next = { ...rewound.get().applied };
        delete next[middle];
        await rewound.set({ ...rewound.get(), applied: next });
      } else {
        const document = rewound.get();
        delete document.applied[middle];
        await rewound.set(document);
      }
      outcome.rewoundMarkerAbsent = appliedNow()[middle] === undefined;
      assert.equal(outcome.rewoundMarkerAbsent, true, `${name}: the rewind must have landed`);
      appendOne();
      outcome.flush = await port.flush();
      assert.deepEqual(outcome.flush, { applied: 2, duplicates: history - 1 },
        `${name}: the rewound marker must be re-applied, not skipped`);
      outcome.rewoundMarkerRepaired = appliedNow()[middle] !== undefined;
      assert.equal(outcome.rewoundMarkerRepaired, true, `${name}: the rewound marker must be repaired`);
      outcome.markers = markers();
      assert.equal(outcome.markers, history + 1, `${name}: every record must carry a marker again`);
      const checkpoint = JSON.parse(read(roots.checkpoint));
      outcome.checkpointDescribesMap = checkpoint.appliedDigest
        === crypto.createHash("sha256").update(JSON.stringify(appliedNow())).digest("hex");
      assert.equal(outcome.checkpointDescribesMap, true, `${name}: the checkpoint must describe the repaired map`);
      outcome.secondFlush = await port.flush();
      assert.deepEqual(outcome.secondFlush, { applied: 0, duplicates: history + 1 }, `${name}: the repair must settle`);
      await port.close();
      opened = null;
      const restarted = await openPort(libDirectory, root, eventLog);
      opened = restarted;
      outcome.restartFlush = await restarted.port.flush();
      assert.deepEqual(outcome.restartFlush, { applied: 0, duplicates: history + 1 },
        `${name}: a restart must find nothing left to apply`);
    } else if (name === "torn-trailing-record") {
      // A record whose line has not been terminated yet: it is verified and applied
      // per record, but must stay outside the checkpoint until its line feed lands.
      const envelope = signEventBridgeEnvelope(SIGNED(sequence + 1), { key: KEY, sequence: sequence + 1 });
      fs.appendFileSync(eventLog, JSON.stringify(envelope));
      outcome.tornFlush = await port.flush();
      assert.deepEqual(outcome.tornFlush, { applied: 1, duplicates: history },
        `${name}: an unterminated record is still authenticated and applied`);
      const covered = JSON.parse(read(roots.checkpoint));
      outcome.checkpointStopsBeforeTornLine = covered.bytes === fs.statSync(eventLog).size - Buffer.byteLength(JSON.stringify(envelope));
      assert.equal(outcome.checkpointStopsBeforeTornLine, true, `${name}: the checkpoint must not cover the torn line`);
      fs.appendFileSync(eventLog, "\n");
      outcome.terminatedFlush = await port.flush();
      assert.deepEqual(outcome.terminatedFlush, { applied: 0, duplicates: history + 1 },
        `${name}: the terminated record must be a duplicate`);
      outcome.markers = markers();
    } else if (name === "restart") {
      await port.close();
      opened = null;
      const restarted = await openPort(libDirectory, root, eventLog);
      opened = restarted;
      const after = snapshot();
      outcome.restartFlush = await restarted.port.flush();
      assert.deepEqual(outcome.restartFlush, { applied: 0, duplicates: history },
        `${name}: a restart must find every record already committed`);
      outcome.durableUnchanged = JSON.stringify(after) === JSON.stringify(pristine);
      assert.equal(outcome.durableUnchanged, true, `${name}: a restart must not rewrite the document or the checkpoint`);
    } else assert.fail(`unknown behavior ${name}`);
    outcome.markers ??= markers();
    outcome.archives = Object.keys(archiveTree(roots.live)).length;
    return outcome;
  } finally {
    if (opened) { try { await opened.port.close(); } catch {} try { await opened.backend.close(); } catch {} }
    resetUuidSequence();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Per-phase attribution for one side: the same steady fixture, with every call
 *  site wrapped in `performance.now()` pairs. */
async function runAttribution(libDirectory, { history }, samples) {
  const attributed = materializeAttributed(libDirectory);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `flush-steady-attr-run-${history}-`));
  const eventLog = path.join(root, "execution-events.jsonl");
  resetUuidSequence();
  let opened = null;
  try {
    await seedHistory(libDirectory, root, eventLog, history);
    opened = await openPort(attributed, root, eventLog);
    const { port } = opened;
    assert.deepEqual(await port.flush(), { applied: 0, duplicates: history }, "attribution: the seeded history must already be committed");
    await port.flush();
    globalThis.__attrReset();
    for (let index = 0; index < samples; index += 1) assert.deepEqual(await port.flush(), { applied: 0, duplicates: history });
    const phases = globalThis.__attrRead();
    return Object.fromEntries(Object.entries(phases).map(([phase, total]) => [phase, Number((total / samples).toFixed(3))]));
  } finally {
    if (opened) { try { await opened.port.close(); } catch {} try { await opened.backend.close(); } catch {} }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(attributed, { recursive: true, force: true });
  }
}

const uncached = (applied) => crypto.createHash("sha256").update(JSON.stringify(applied)).digest("hex");

/** The inputs a re-using digest silently certifies. Each probe answers: "does this
 *  implementation still return the digest of the bytes the argument serializes to
 *  right now?". `committed` must answer yes to every one. */
const PROBES = {
  "one-shot getter": async (directory) => {
    const { digestApplied } = await import(pathToFileURL(path.join(directory, "lib", "event-log-checkpoint.js")).href);
    const table = {};
    let reads = 0;
    Object.defineProperty(table, "evolution:measurement-completed:m", { enumerable: true, configurable: true,
      get: () => (reads++ === 0 ? "a".repeat(64) : "b".repeat(64)) });
    const first = digestApplied(table);
    const second = digestApplied(table);
    return { firstIsFirstRead: first === uncached({ "evolution:measurement-completed:m": "a".repeat(64) }),
      secondIsSecondRead: second === uncached({ "evolution:measurement-completed:m": "b".repeat(64) }),
      movedWithTheRead: first !== second };
  },
  "root toJSON": async (directory) => {
    const { digestApplied } = await import(pathToFileURL(path.join(directory, "lib", "event-log-checkpoint.js")).href);
    let produced = "first";
    const table = { "evolution:measurement-completed:m": "a".repeat(64) };
    Object.defineProperty(table, "toJSON", { enumerable: false, configurable: true, value: () => ({ produced }) });
    const before = digestApplied(table);
    produced = "second";
    const after = digestApplied(table);
    return { movedWithTheSerialization: before !== after, afterIsCurrent: after === uncached({ produced: "second" }) };
  },
  "array length": async (directory) => {
    const { digestApplied } = await import(pathToFileURL(path.join(directory, "lib", "event-log-checkpoint.js")).href);
    const table = ["a"];
    const before = digestApplied(table);
    table.length = 3;
    const after = digestApplied(table);
    return { movedWithTheLength: before !== after, afterIsCurrent: after === uncached(table) };
  },
  "read that throws": async (directory) => {
    const { digestApplied } = await import(pathToFileURL(path.join(directory, "lib", "event-log-checkpoint.js")).href);
    let reads = 0;
    const table = {};
    Object.defineProperty(table, "evolution:measurement-completed:x", { enumerable: true, configurable: true,
      get: () => { if (reads === 0) { reads += 1; return "a".repeat(64); } throw new Error("second read"); } });
    const outcome = await Promise.resolve()
      .then(() => ({ digest: digestApplied(table) })).catch((error) => ({ threw: error.message }));
    return { settled: outcome.digest !== undefined, outcome: outcome.threw ?? "digest", reads };
  },
  "non-object argument": async (directory) => {
    const { digestApplied } = await import(pathToFileURL(path.join(directory, "lib", "event-log-checkpoint.js")).href);
    const outcome = {};
    for (const value of [null, "marker"]) {
      outcome[String(value)] = await Promise.resolve().then(() => digestApplied(value))
        .then((digest) => ({ digestIsCurrent: digest === uncached(value) }), (error) => ({ threw: error.message.slice(0, 60) }));
    }
    return outcome;
  },
};

const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
const round3 = (value) => Number(value.toFixed(3));
const summarize = (run) => ({
  wallMs: median(run.rows.map((row) => row.wallMs)),
  cpuMs: median(run.rows.map((row) => row.cpuMs)),
  wallSamples: run.rows.map((row) => round3(row.wallMs)),
  cpuSamples: run.rows.map((row) => round3(row.cpuMs)),
  documentBytes: run.documentBytes,
  checkpointBytes: run.checkpointBytes,
  logBytes: run.logBytes,
  stagingLeft: run.stagingLeft,
  restart: run.restart,
  restartDocumentUnchanged: run.restartDocumentUnchanged,
  restartCheckpointUnchanged: run.restartCheckpointUnchanged,
  traced: run.traced ? {
    documentWritesPerFlush: round3(run.traced.documentWrites / run.rows.length),
    handleSyncsPerFlush: round3(Object.entries(run.traced.calls)
      .filter(([name]) => name.endsWith("/sync")).reduce((total, [, value]) => total + value, 0) / run.rows.length),
    logBytesReadPerFlush: Math.round(run.traced.logBytesRead / run.rows.length),
    digestBytesPerFlush: Math.round(run.traced.digestBytes / run.rows.length),
    largeStringifiedBytesPerFlush: Math.round(run.traced.largeStringifiedBytes / run.rows.length),
    callsPerFlush: Object.fromEntries(Object.entries(run.traced.calls)
      .map(([name, value]) => [name, round3(value / run.rows.length)])),
  } : null,
});

async function measure(libDirectory, scenario, rounds, samples) {
  const record = { scenario: label(scenario), history: scenario.history, newEvents: scenario.newEvents, rounds: [] };
  for (let round = 1; round <= rounds; round += 1) {
    const clean = summarize(await runScenario(libDirectory, scenario, { clockMode: "advance", trace: false, samples }));
    const traced = summarize(await runScenario(libDirectory, scenario, { clockMode: "advance", trace: true, samples }));
    assert.deepEqual(clean.restart, { applied: 0, duplicates: scenario.history + scenario.newEvents * (WARMUP + samples) },
      `${record.scenario}: a restart must find every record already committed`);
    assert.equal(clean.stagingLeft, 0, `${record.scenario}: a committed transaction must leave no staged directory`);
    assert.equal(clean.restartDocumentUnchanged, true, `${record.scenario}: a restart must not rewrite the document`);
    assert.equal(clean.restartCheckpointUnchanged, true, `${record.scenario}: a restart must not move the checkpoint`);
    const stripped = { ...clean, traced: traced.traced };
    for (const key of ["restart", "restartDocumentUnchanged", "restartCheckpointUnchanged", "stagingLeft"]) delete stripped[key];
    record.rounds.push(stripped);
  }
  const pick = (key) => record.rounds.map((round) => round[key]);
  const tracedOf = (key) => median(record.rounds.map((round) => round.traced[key]));
  const calls = () => {
    const merged = new Map();
    for (const round of record.rounds) {
      for (const [name, value] of Object.entries(round.traced.callsPerFlush)) merged.set(name, [...(merged.get(name) ?? []), value]);
    }
    return Object.fromEntries([...merged.entries()].map(([name, values]) => [name, median(values)])
      .sort(([left], [right]) => left < right ? -1 : 1));
  };
  record.summary = {
    wallMs: median(pick("wallMs")), cpuMs: median(pick("cpuMs")),
    wallRounds: pick("wallMs").map(round3), cpuRounds: pick("cpuMs").map(round3),
    documentBytes: pick("documentBytes")[0], checkpointBytes: pick("checkpointBytes")[0], logBytes: pick("logBytes")[0],
    documentWritesPerFlush: tracedOf("documentWritesPerFlush"),
    handleSyncsPerFlush: tracedOf("handleSyncsPerFlush"),
    logBytesReadPerFlush: tracedOf("logBytesReadPerFlush"),
    digestBytesPerFlush: tracedOf("digestBytesPerFlush"),
    largeStringifiedBytesPerFlush: tracedOf("largeStringifiedBytesPerFlush"),
    callsPerFlush: calls(),
  };
  return record;
}

async function report() {
  const committedDigest = assertCommittedShapes();
  const output = {
    implementation: "unchanged working tree: digestApplied still serializes the marker map on every call",
    rounds: ROUNDS, samples: SAMPLES, warmup: WARMUP, variantRounds: VARIANT_ROUNDS,
    scenarios: SCENARIOS.map(label),
    environment: { node: process.version, platform: `${process.platform}/${process.arch}`,
      cpus: os.cpus().length, loadAverageAtStart: os.loadavg() },
    protocol: {
      measurementClock: "deterministic clock advancing 1 ms per read (production condition, reproducible)",
      order: "rounds alternate which phase runs first; medians across rounds",
      sides: "`committed` is this working tree; `memo-content` and `memo-identity` are the withdrawn shortcut, patched into a scratch copy of the same lib/ by exact substring",
      warmup: "the seeded history is absorbed by a cold pass, then `warmup` flushed bursts",
      instrumentedPass: "one additional pass per config with wrapped fs/crypto/JSON calls; counts are per flush",
      historyShape: "the seeded history is a committed applied marker table plus its signed log; the aggregate stays empty, because this round touches neither the aggregate nor its projection",
    },
    sources: { committedDigestSha256: crypto.createHash("sha256").update(committedDigest).digest("hex"),
      committedDomainStorageSha256: crypto.createHash("sha256")
        .update(fs.readFileSync(path.join(REPO_ROOT, "lib", "domain-storage.js"))).digest("hex") },
    measured: [], withdrawn: [], attribution: [], probes: [], behaviors: [],
  };
  for (const scenario of SCENARIOS) {
    const record = await measure(REPO_ROOT, scenario, ROUNDS, SAMPLES);
    record.attribution = scenario.newEvents === 0
      ? await runAttribution(REPO_ROOT, scenario, ATTRIBUTION_SAMPLES) : null;
    output.measured.push(record);
  }
  // The withdrawn shortcut: same fixtures, same sample count, one `lib/` swap away.
  const variants = {};
  for (const [name] of Object.entries(VARIANTS)) variants[name] = materializeVariant(name);
  process.on("exit", () => { for (const directory of Object.values(variants)) fs.rmSync(directory, { recursive: true, force: true }); });
  for (const scenario of STEADY) {
    const committed = output.measured.find((record) => record.scenario === label(scenario)).summary;
    for (const [name, directory] of Object.entries(variants)) {
      const record = await measure(directory, scenario, VARIANT_ROUNDS, SAMPLES);
      record.variant = name;
      record.attribution = await runAttribution(directory, scenario, ATTRIBUTION_SAMPLES);
      record.deltaVersusCommitted = {
        wallPercent: round3(100 * (record.summary.wallMs - committed.wallMs) / committed.wallMs),
        cpuPercent: round3(100 * (record.summary.cpuMs - committed.cpuMs) / committed.cpuMs),
        digestBytesPerFlush: committed.digestBytesPerFlush - record.summary.digestBytesPerFlush,
      };
      output.withdrawn.push(record);
    }
  }
  // Attribution, both implementations, on the same call sites.
  for (const scenario of STEADY) {
    const committed = output.measured.find((record) => record.scenario === label(scenario));
    for (const record of output.withdrawn.filter((row) => row.scenario === label(scenario))) {
      output.attribution.push({ scenario: record.scenario, side: record.variant, phases: record.attribution,
        committedPhases: committed.attribution });
    }
  }
  // The probes: `committed` must answer every one correctly, and each variant has to
  // fail at least the ones it was withdrawn for, or the script is not measuring what
  // it claims to.
  const sides = { committed: REPO_ROOT, ...variants };
  for (const [name, probe] of Object.entries(PROBES)) {
    const observations = {};
    for (const [side, directory] of Object.entries(sides)) observations[side] = await probe(directory);
    output.probes.push({ name, observations });
  }
  const observed = (probeName, side) => output.probes.find((probe) => probe.name === probeName).observations[side];
  assert.equal(observed("one-shot getter", "committed").secondIsSecondRead, true,
    "the committed digest must follow the read it just made");
  assert.equal(observed("root toJSON", "committed").afterIsCurrent, true, "the committed digest must honour a root toJSON");
  assert.equal(observed("array length", "committed").afterIsCurrent, true, "the committed digest must honour array length");
  assert.equal(observed("read that throws", "committed").settled, true, "the committed digest must not read past the serialization");
  assert.deepEqual(observed("non-object argument", "committed"), { null: { digestIsCurrent: true }, marker: { digestIsCurrent: true } },
    "the committed digest must digest non-object arguments");
  for (const [name] of Object.entries(VARIANTS)) {
    assert.equal(observed("one-shot getter", name).movedWithTheRead, false,
      `${name}: the probe must show the stale digest a re-using implementation serves`);
    assert.equal(observed("root toJSON", name).afterIsCurrent, false, `${name}: a root toJSON must be missed`);
    assert.equal(observed("array length", name).afterIsCurrent, false, `${name}: an array length must be missed`);
  }
  // Refusal / recovery outcomes of the committed implementation.
  for (const name of BEHAVIORS) output.behaviors.push(await runBehavior(REPO_ROOT, name, { history: BEHAVIOR_HISTORY }));
  // Durable output of the committed implementation under a frozen clock, so the
  // numbers above are attached to the bytes that were actually measured.
  output.durable = [];
  for (const scenario of SCENARIOS) {
    const run = await runScenario(REPO_ROOT, scenario, { clockMode: "freeze", trace: false, samples: 3 });
    assert.equal(run.stagingLeft, 0, `${label(scenario)}: a committed transaction must leave no staged directory`);
    assert.ok(run.durable.checkpoint !== null, `${label(scenario)}: the measured passes must have written a checkpoint`);
    assert.equal(run.durable.checkpointFileIdentityPresent, true, `${label(scenario)}: the checkpoint must be bound to a file identity`);
    const markers = Object.keys(JSON.parse(run.durable.document).global.applied);
    assert.equal(markers.length, scenario.history + scenario.newEvents * (WARMUP + 3),
      `${label(scenario)}: every record must be committed exactly once`);
    output.durable.push({ scenario: label(scenario), documentBytes: run.documentBytes,
      checkpointBytes: run.checkpointBytes, checkpoint: run.durable.checkpoint, archiveFiles: run.durable.archives.length });
  }
  output.environment.loadAverageAtEnd = os.loadavg();
  if (OUT) fs.writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
}

await report();
