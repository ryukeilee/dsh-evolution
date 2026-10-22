// Per-phase attribution for the events `domain-flush-ledger-cost.mjs` measures.
//
// The A/B run says how much wall clock and CPU one `flush()` costs on each side;
// this script says where the difference lands. It copies the side's
// `lib/domain-storage.js` into a scratch tree, wraps the call sites of the
// transaction in `performance.now()` pairs (the instrumentation is inserted by
// exact-substring patch, and the patch fails loudly if a call site moved), and
// runs the same fixture as the benchmark on the real official
// `DomainFacility` + `JsonStorageBackend`. Both sides get the same wrappers, so
// the phase figures are comparable.
//
//   node scripts/benchmarks/domain-flush-ledger-attribution.mjs --side baseline --baseline c85dfa7
//   node scripts/benchmarks/domain-flush-ledger-attribution.mjs --side candidate --out /tmp/attr-candidate.json
//
// Phases: `merge` (mergeEventLedger), `memory.cloneLoad` (the clone the working
// store no longer takes), `memory.create`, `copy.replayLedger`, `copy.baseline`,
// `plan` (checkpoint read + digest + log read/hash), `checkpoint.write`,
// `snapshot`, `set` (document projection + backend write), `hydrate`.
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
const SIDE = option("side", "candidate");
const BASELINE_REV = option("baseline", "c85dfa7");
const HISTORY = Number(option("history", 20000));
const NEW_EVENTS = Number(option("new-events", 1));
const SAMPLES = Number(option("samples", 9));
const AGGREGATE = option("aggregate", "none");
const OUT = option("out", null);
const FROZEN_NOW = Date.parse("2026-11-03T00:00:00.000Z");
const KEY = "b".repeat(64);
const SOURCE = "lib/domain-storage.js";

function instrument(source) {
  // [{ start, end, name }]: insert a timer pair around the exact source span of
  // one call site. `end` defaults to `start` (a whole single-line statement).
  const statements = [
    { start: "const ledger = mergeEventLedger(recovered, applied);", name: "merge" },
    { start: "const plan = planEventLogReplay({ file: config.eventBridgePath, key: config.eventBridgeKey, writer,",
      end: "      checkpoint: readEventLogCheckpoint(checkpointFile), applied: domain.global.get().applied });", name: "plan" },
    { start: "const ledger = { ...domain.global.get().applied };", name: "copy.replayLedger" },
    { start: "const baseline = { applied: { ...recovered }, aggregate: committed.aggregate, token: readCommitToken(commitToken) };", name: "copy.baseline" },
    { start: "const current = await createMemory(dir, domain.global.get().aggregate, archiveWriteGuard);", name: "memory.create" },
    { start: "const aggregate = { evolution: current.instance.snapshot() };", name: "snapshot" },
    { start: "await hydrate(current.instance.archiveReadCache);", name: "hydrate" },
    { start: "await domain.global.set(schema.parse({ schema: 1, aggregate: latest.aggregate, applied: latest.applied, pending: { stage, aggregate, applied: ledger, files } }));", name: "set.pending" },
    { start: "await domain.global.set(schema.parse({ schema: 1, aggregate, applied: ledger, pending: null }));", name: "set.final" },

    { start: "writeEventLogCheckpoint(checkpointFile, eventLogCheckpointDocument({ plan, writer, key: config.eventBridgeKey, applied: domain.global.get().applied, witnesses: { first, last } }));", name: "checkpoint.write" },
  ];
  let patched = source;
  // The install that follows the pending record write: the call is on the line
  // before the `} else {`, so it is wrapped directly instead of by span text.
  const installAnchor = "      await installPending();\n    } else {";
  assert.equal(patched.split(installAnchor).length - 1, 1, "installPending.afterSet: the staged branch must occur exactly once");
  patched = patched.replace(installAnchor,
    "      globalThis.__attrStart('installPending.afterSet'); await installPending(); globalThis.__attrEnd('installPending.afterSet');\n    } else {");
  for (const { start: before, end: after = before, name } of statements) {
    assert.equal(patched.split(before).length - 1, 1, `${name}: ${JSON.stringify(before)} must occur exactly once`);
    patched = patched.replace(before, `globalThis.__attrStart('${name}'); ${before}`);
    assert.equal(patched.split(after).length - 1, 1, `${name}: ${JSON.stringify(after)} must occur exactly once after the start marker`);
    patched = patched.replace(after, `${after} globalThis.__attrEnd('${name}');`);
  }
  const cloneLoad = /load: async \(\) => (?:structuredClone\(aggregate\)|aggregate),/;
  assert.equal(patched.split(cloneLoad).length - 1, 1, "memory.cloneLoad: the store's load must occur exactly once");
  patched = patched.replace(cloneLoad, (match) => `load: async () => { globalThis.__attrStart('memory.cloneLoad'); const loaded = ${match.includes("structuredClone") ? "structuredClone(aggregate)" : "aggregate"}; globalThis.__attrEnd('memory.cloneLoad'); return loaded; },`);
  assert.notEqual(patched, source, "the instrumentation must change the source");
  return patched;
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flush-attribution-"));
fs.cpSync(path.join(REPO_ROOT, "lib"), path.join(scratch, "lib"), { recursive: true });
fs.symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(scratch, "node_modules"));
const source = SIDE === "baseline"
  ? execFileSync("git", ["show", `${BASELINE_REV}:${SOURCE}`], { cwd: REPO_ROOT, encoding: "utf8" })
  : fs.readFileSync(path.join(REPO_ROOT, SOURCE), "utf8");
if (SIDE === "baseline") {
  assert.ok(source.includes("Object.entries(applied)"), `baseline ${BASELINE_REV} must be the pre-change implementation`);
  assert.ok(source.includes("load: async () => structuredClone(aggregate),"), `baseline ${BASELINE_REV} must still clone in the store's load`);
} else {
  assert.ok(source.includes("Object.keys(applied)"), "the candidate must walk the caller's table by key");
  assert.ok(source.includes("load: async () => aggregate,"), "the candidate must not clone in the store's load");
}
const instrumented = instrument(source);
if (process.env.ATTR_DUMP) fs.writeFileSync(process.env.ATTR_DUMP, instrumented);
fs.writeFileSync(path.join(scratch, SOURCE), instrumented);

// Frozen clock and deterministic identifiers, as in the byte-comparison pass.
class StubDate extends Date {
  constructor(...values) { if (values.length === 0) super(FROZEN_NOW); else super(...values); }
  static now() { return FROZEN_NOW; }
}
globalThis.Date = StubDate;
{
  const original = crypto.randomUUID;
  let seed = 0;
  crypto.randomUUID = () => `${String(++seed).padStart(8, "0")}-0000-4000-8000-000000000000`;
  process.on("exit", () => { crypto.randomUUID = original; });
  syncBuiltinESMExports();
}

// Phases nest (`createMemory()` calls the store's `load`), so the timers form a
// stack: an outer phase's figure includes the inner ones it contains.
const PHASES = new Map();
const stack = [];
globalThis.__attrStart = (name) => { stack.push({ name, at: performance.now() }); };
globalThis.__attrEnd = (name) => {
  const open = stack.pop();
  assert.equal(open?.name, name, `phase ${name} must close the one it opened`);
  PHASES.set(name, (PHASES.get(name) ?? 0) + (performance.now() - open.at));
};

const SIGNED = (sequence) => ({ schema: 1, eventId: `evolution:measurement-completed:attr-${sequence}`,
  eventType: "measurement-completed", experimentId: `attr-${sequence}`, proposalId: `attr-proposal-${sequence}`,
  target: "plugin:attr", capability: "plugin:attr", lineageId: "plugin:attr", status: "measured",
  measurement: { latency: 12 }, evidence: { summary: "attribution" }, canary: {},
  audit: { producer: "dsh-evolution-orchestrator", at: "2026-10-07T00:00:00.000Z" } });
const seededRow = (collection, index) => ({
  id: `${collection}-seed-${index}`, recordId: `${collection}-seed-${index}`, status: "recorded",
  recordedAt: `2026-10-0${(index % 9) + 1}T00:00:00.000Z`, problemFingerprint: `fingerprint-${collection}-${index}`,
  capability: "plugin:attr", target: "plugin:attr", lineageId: "plugin:attr", eventType: "measurement-completed",
  summary: `seeded ${collection} row ${index} carrying the record volume a lived-in install holds`,
  measurement: { latency: index }, evidence: { summary: "seeded" },
  payload: { nested: { a: index, b: "x".repeat(48) }, list: [1, 2, 3, index] },
});
function seededEvolution(shape) {
  const evolution = { schema: 5, eventBridge: { schema: 1, applied: [] }, observations: [] };
  for (const collection of ["proposals", "experiments", "cycles"]) {
    evolution[collection] = Array.from({ length: 40 }, (_, index) => seededRow(collection, index));
  }
  evolution.knowledge = Array.from({ length: 400 }, (_, index) => seededRow("knowledge", index));
  evolution.observations = Array.from({ length: 24 }, (_, index) => seededRow("observations", index));
  if (shape === "evict") evolution.experiments = Array.from({ length: 50 }, (_, index) => seededRow("experiments", 1000 + index));
  return evolution;
}

const { signEventBridgeEnvelope } = await import(pathToFileURL(path.join(REPO_ROOT, "lib", "orchestrator.js")).href);
const { openDomainStorage } = await import(pathToFileURL(path.join(scratch, SOURCE)).href);
const { DomainFacility } = await import("@deepseek-ai/dsh-storage-domain");
const { JsonStorageBackend } = await import("@deepseek-ai/dsh-storage-json");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "flush-attribution-fixture-"));
const eventLog = path.join(root, "execution-events.jsonl");
const lines = [], applied = {};
for (let sequence = 1; sequence <= HISTORY; sequence += 1) {
  const envelope = signEventBridgeEnvelope(SIGNED(sequence), { key: KEY, sequence });
  applied[envelope.event.eventId] = envelope.mac;
  lines.push(JSON.stringify(envelope));
}
fs.writeFileSync(eventLog, HISTORY === 0 ? "" : `${lines.join("\n")}\n`);
{
  const backend = new JsonStorageBackend(path.join(root, "official"));
  const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: "json" });
  const domain = await ctx.storageDomain.open({ name: "evolution_domain", version: 1, tables: {},
    global: { schema: (await import(pathToFileURL(path.join(scratch, SOURCE)).href)).evolutionDomainSpec.global.schema,
      initial: { schema: 1, aggregate: {}, applied: {}, pending: null } } });
  const aggregate = AGGREGATE === "none" ? {} : { evolution: seededEvolution(AGGREGATE) };
  await domain.global.set({ schema: 1, aggregate, applied, pending: null });
  await domain.close();
  await backend.close();
}
const backend = new JsonStorageBackend(path.join(root, "official"));
const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
ctx.storageDomain = new DomainFacility(ctx, { backend: "json" });
const port = await openDomainStorage(ctx, { presetDir: root, eventBridgePath: eventLog, eventBridgeKey: KEY });
let sequence = HISTORY;
const append = (count) => {
  const out = [];
  for (let index = 0; index < count; index += 1) { sequence += 1; out.push(JSON.stringify(signEventBridgeEnvelope(SIGNED(sequence), { key: KEY, sequence }))); }
  if (out.length) fs.appendFileSync(eventLog, `${out.join("\n")}\n`);
};
const cold = await port.flush();
assert.deepEqual(cold, { applied: 0, duplicates: HISTORY }, "the seeded history must already be committed");
for (let warm = 0; warm < 3; warm += 1) { append(NEW_EVENTS); await port.flush(); }
PHASES.clear();
const measured = [];
for (let index = 0; index < SAMPLES; index += 1) {
  append(NEW_EVENTS);
  const cpu = process.cpuUsage();
  const started = performance.now();
  const result = await port.flush();
  measured.push({ wallMs: performance.now() - started,
    cpuMs: (() => { const used = process.cpuUsage(cpu); return (used.user + used.system) / 1000; })() });
  assert.deepEqual(result, { applied: NEW_EVENTS, duplicates: HISTORY + NEW_EVENTS * (3 + index) });
}
const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
const round3 = (value) => Number(value.toFixed(3));
const report = {
  side: SIDE, baseline: SIDE === "baseline" ? BASELINE_REV : null,
  scenario: { history: HISTORY, newEvents: NEW_EVENTS, aggregate: AGGREGATE }, samples: SAMPLES,
  wallMs: round3(median(measured.map((row) => row.wallMs))),
  cpuMs: round3(median(measured.map((row) => row.cpuMs))),
  phases: Object.fromEntries([...PHASES.entries()].map(([name, total]) => [name, round3(total / SAMPLES)]).sort((left, right) => right[1] - left[1])),
};
await port.close();
await backend.close();
fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(scratch, { recursive: true, force: true });
const text = JSON.stringify(report, null, 2);
if (OUT) fs.writeFileSync(path.resolve(OUT), `${text}\n`);
console.log(text);
