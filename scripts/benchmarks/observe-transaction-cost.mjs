// What one high-frequency fault observation costs on the released observe path
// (`registration` listener -> `observeAutonomous` -> `port.observe` -> `enqueue`
// -> `mutate` -> `hydrate`), where that time goes, and what the archive digest
// walk costs inside it.
//
// `--compare` measures A / A-control / B, where the baseline arms are rebuilt
// from `--baseline` (default: the revision before the digest-walk change) and B
// is this tree; the run fails unless the trees differ only in the files this
// round touches (`memory.js` and the commit-hook line in `domain-storage.js`).
// `--attribute` patches a temporary copy of `lib/` with expression-level timers;
// each anchor must match exactly one site, so a moved site fails the run instead
// of silently reporting nothing. `--counterexample` reproduces why the larger
// shortcut - a successor instance that adopts its predecessor's archive parse
// without performing its own reads - is not shippable: it no longer observes a
// new EACCES/EIO, which `test/observe-cache-read-fault.test.mjs` requires.
// See docs/performance/observe-transaction-digest-walk-20261107.md.
//
//   node --max-old-space-size=4096 --expose-gc scripts/benchmarks/observe-transaction-cost.mjs \
//     --compare --histories 1000,8000,20000 --rounds 5 --burst 16 --out <json>
//   node --max-old-space-size=4096 scripts/benchmarks/observe-transaction-cost.mjs \
//     --attribute --histories 1000,8000,20000 --steps 12 --out <json>
//   node --max-old-space-size=4096 scripts/benchmarks/observe-transaction-cost.mjs \
//     --counterexample --out <json>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { JsonStorageBackend } from "@deepseek-ai/dsh-storage-json";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const HERE = "scripts/benchmarks/observe-transaction-cost.mjs";
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const OUT = option("out", null);
const KEY = "b".repeat(64);
const MODE = ["measure", "compare", "attribute", "counterexample"].find((name) => args.includes(`--${name}`)) ?? "measure";
const numbers = (value) => value.split(",").map(Number).filter(Number.isSafeInteger);
const HISTORIES = numbers(option("histories", "0,1000,8000,20000"));
const STEPS = Number(option("steps", 12));
const ROUNDS = Number(option("rounds", 3));
const BURST = Number(option("burst", 16));
const WARMUP = Number(option("warmup", 2));
const BASELINE = option("baseline", "c2c8d2e2d8abf986ee14b360a842a72f999ddae7");
const ATTRIBUTE_BASELINE = option("attribute-baseline", null);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "observe-cost-"));

const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
/** Rotate which arm leads, then reverse every other round. */
const armOrder = (names, index) => {
  const shift = index % names.length;
  const rotated = [...names.slice(shift), ...names.slice(0, shift)];
  return index % 2 ? rotated.reverse() : rotated;
};
const round = (value, digits = 3) => Number(value.toFixed(digits));

/** One materialized `lib/` tree per arm, importable on its own. */
function materialize(name, transform = null) {
  const directory = path.join(temp, `arm-${name}`);
  fs.mkdirSync(directory);
  fs.cpSync(path.join(REPO, "lib"), path.join(directory, "lib"), { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(directory, "node_modules"));
  if (transform) transform(path.join(directory, "lib"));
  return directory;
}

async function importArm(directory) {
  const storage = await import(pathToFileURL(path.join(directory, "lib/domain-storage.js")).href);
  const domain = await import(pathToFileURL(path.join(directory, "lib/dockyard-domain/index.js")).href);
  const registration = await import(pathToFileURL(path.join(directory, "lib/registration.js")).href);
  return { ...storage, ...domain, apply: registration.apply };
}

function openRoot(root) {
  fs.mkdirSync(root, { recursive: true });
  const backend = new JsonStorageBackend(path.join(root, "official"));
  const listeners = new Map();
  const ctx = { emit() {}, effect() {}, logger: { warn() {}, error() {} },
    on: (event, handler) => listeners.set(event, handler),
    storage: { backend: { get: () => backend } }, dynamicCordisRunner: {},
    tools: { register() {} }, systemPrompt: { section() {} } };
  ctx.storageDomain = new DomainFacility(ctx, { backend: "json" });
  return { backend, ctx, listeners };
}

const configFor = (root) => ({ presetDir: root, eventBridgePath: path.join(root, "events.jsonl"),
  eventBridgeKey: KEY, startupDrift: false, patternThreshold: 3,
  autonomousStrategies: { AGENT_ERROR: { risk: "medium", target: "plugin:fix" },
    TOOL_ERROR: { risk: "medium", target: "plugin:fix" } } });

const probeDto = (index) => ({ code: "HOST_OPERATION_FAILED", type: "tool/error", target: "host",
  observationId: `obs-run-${index}`, patternKey: `autonomous-v1:${(index + 1).toString(16).padStart(64, "0")}` });

async function openSession(root, arm, { core }) {
  const { backend, ctx, listeners } = openRoot(root);
  const config = configFor(root);
  const port = await arm.openDomainStorage(ctx, config);
  const orchestrator = core ? arm.apply(ctx, { ...config, domainStorage: port }) : null;
  const pending = [];
  if (core) {
    // The listeners are emits: they do not return the observer promise, so the
    // measured call has to capture it to include the whole chain in the timing.
    const observeAutonomous = orchestrator.observeAutonomous.bind(orchestrator);
    orchestrator.observeAutonomous = (...values) => {
      const promise = observeAutonomous(...values);
      pending.push(promise.catch((error) => { throw error; }));
      return promise;
    };
  }
  return {
    port, orchestrator,
    observe: async (index) => {
      if (!core) return port.observe(probeDto(index));
      listeners.get("agent/error")({ agent: { id: "bench" },
        error: Object.assign(new Error("provider unavailable"), { code: "AGENT_ERROR" }) });
      while (pending.length) await pending.splice(0, pending.length).reduce((all, one) => all.then(() => one), Promise.resolve());
    },
    close: async () => { try { await port.close(); } finally { await backend.close(); } },
  };
}

/** A real observation row, produced by the released path, reused as the template. */
async function rowTemplate(arm) {
  const root = fs.mkdtempSync(path.join(temp, "template-"));
  const { backend, ctx } = openRoot(root);
  const port = await arm.openDomainStorage(ctx, configFor(root));
  await port.observe({ code: "HOST_OPERATION_FAILED", type: "tool/error", target: "host",
    observationId: "obs-template", patternKey: `autonomous-v1:${"a".repeat(64)}` });
  await port.close();
  await backend.close();
  const document = JSON.parse(fs.readFileSync(path.join(root, "official", "evolution_domain.json"), "utf8"));
  return document.global.aggregate.evolution.observations[0];
}

/**
 * A durable root with `history` archived observations built by the released path
 * once: opening it rotates the seeded rows into the cold tier and writes the
 * archive index exactly as a long-lived install would.
 */
async function buildFixture(arm, history) {
  const root = fs.mkdtempSync(path.join(temp, `fixture-${history}-`));
  const template = await rowTemplate(arm);
  const rows = [];
  for (let index = 0; index < history; index += 1) {
    const suffix = index.toString(36).padStart(6, "0");
    const at = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
    rows.push({ ...template, id: `observation:seed-${suffix}`, recordedAt: at, observedAt: at,
      patternKey: `tool:tools/result:code-${suffix}`, message: `Official operation failed (code-${suffix})`,
      knowledgeKey: `knowledge:tool:tools/result:code-${suffix}:${"b".repeat(48)}` });
  }
  const { backend, ctx } = openRoot(root);
  const opened = await ctx.storageDomain.open(arm.evolutionDomainSpec);
  await opened.global.set({ schema: 1, aggregate: { evolution: { schema: 4, observations: rows, knowledge: [] } },
    applied: {}, pending: null });
  await opened.close();
  await backend.close();
  const normalized = await openSession(root, arm, { core: false });
  await normalized.close();
  return root;
}

/** I/O counters: every call and byte the transaction asks the filesystem for. */
const io = { active: false, calls: {} };
function installCounters() {
  const restores = [];
  const bump = (name, bytes = 0) => {
    if (!io.active) return;
    const row = io.calls[name] ?? { calls: 0, bytes: 0 };
    row.calls += 1; row.bytes += bytes;
    io.calls[name] = row;
  };
  for (const name of ["readFileSync", "writeFileSync", "writeSync", "fsyncSync", "linkSync", "renameSync",
    "rmSync", "statSync", "lstatSync", "readdirSync", "mkdirSync", "openSync", "closeSync", "copyFileSync"]) {
    const original = fs[name];
    restores.push(() => { fs[name] = original; });
    fs[name] = function traced(...values) {
      const result = original.apply(this, values);
      bump(name, name === "readFileSync" ? (result?.length ?? 0)
        : name === "writeFileSync" && typeof values[1] === "string" ? Buffer.byteLength(values[1]) : 0);
      return result;
    };
  }
  for (const name of ["open", "rename", "rm", "mkdir", "stat", "writeFile", "readFile"]) {
    const original = fs.promises[name];
    restores.push(() => { fs.promises[name] = original; });
    fs.promises[name] = async function traced(...values) {
      const result = await original.apply(this, values);
      bump(`promises.${name}`, name === "writeFile" && typeof values[1] === "string" ? Buffer.byteLength(values[1]) : 0);
      if (name === "open") {
        for (const method of ["writeFile", "sync"]) {
          const saved = result[method];
          result[method] = function counted(...inner) {
            bump(`handle.${method}`, method === "writeFile" && typeof inner[0] === "string" ? Buffer.byteLength(inner[0]) : 0);
            return saved.apply(this, inner);
          };
        }
      }
      return result;
    };
  }
  syncBuiltinESMExports();
  return () => {
    for (const restore of restores.reverse()) restore();
    syncBuiltinESMExports();
  };
}

async function sample({ arm, armName, fixture, history, core, calls, round: roundIndex }) {
  const root = fs.mkdtempSync(path.join(temp, `sample-${armName}-${history}-${roundIndex}-`));
  fs.cpSync(fixture, root, { recursive: true });
  const session = await openSession(root, arm, { core });
  io.calls = {};
  // Warm the process (module init, JIT, the first cold archive scan) outside the
  // measured window; the reported call is a steady-state one. The memory window
  // starts after this warmup, so it describes the measured calls only.
  const rows = [];
  let sequence = 0;
  for (let index = 0; index < WARMUP; index += 1) {
    io.active = false;
    await session.observe(sequence);
    io.active = true;
    sequence += 1;
  }
  global.gc?.();
  const before = process.memoryUsage();
  for (let index = 0; index < calls; index += 1) {
    const cpu = process.cpuUsage();
    const started = performance.now();
    await session.observe(sequence);
    sequence += 1;
    const wallMs = performance.now() - started;
    const used = process.cpuUsage(cpu);
    rows.push({ wallMs, cpuMs: (used.user + used.system) / 1000, io: io.calls });
    io.calls = {};
  }
  io.active = false;
  global.gc?.();
  const after = process.memoryUsage();
  const candidateCount = session.orchestrator?.candidates?.size ?? null;
  await session.close();
  const reopened = await openSession(root, arm, { core: false });
  const durable = { observations: reopened.port.query("observations", 1).count,
    autonomous: reopened.port.autonomousObservations().length };
  await reopened.close();
  assert.equal(durable.observations, history + WARMUP + calls, `${armName} history ${history}: every observation must be durable`);
  if (core) assert.ok(durable.autonomous >= Math.min(calls, 3), `${armName}: autonomous evidence must survive restart`);
  const totals = {};
  for (const row of rows) for (const [key, value] of Object.entries(row.io)) {
    totals[key] ??= { calls: 0, bytes: 0 };
    totals[key].calls += value.calls; totals[key].bytes += value.bytes;
  }
  return { arm: armName, history, core, round: roundIndex, calls,
    wallMedian: round(median(rows.map((row) => row.wallMs))),
    cpuMedian: round(median(rows.map((row) => row.cpuMs))),
    wallMin: round(Math.min(...rows.map((row) => row.wallMs))),
    wallMax: round(Math.max(...rows.map((row) => row.wallMs))),
    ioPerCall: Object.fromEntries(Object.entries(totals).map(([key, value]) =>
      [key, { calls: round(value.calls / rows.length, 1), bytes: round(value.bytes / rows.length, 0) }])),
    heapDeltaBytes: after.heapUsed - before.heapUsed, rssDeltaBytes: after.rss - before.rss,
    candidates: candidateCount, durable };
}

function summarize(samples) {
  const groups = new Map();
  for (const sample of samples) {
    const key = `${sample.history}|${sample.core ? "chain" : "port"}|${sample.arm}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample);
  }
  const rows = [];
  for (const [key, list] of groups) {
    const [history, kind, arm] = key.split("|");
    const walls = list.flatMap((entry) => [entry.wallMedian]);
    const cpus = list.flatMap((entry) => [entry.cpuMedian]);
    rows.push({ history: Number(history), kind, arm, samples: list.length, calls: list[0].calls,
      wallMedian: round(median(walls)), cpuMedian: round(median(cpus)),
      wallMin: round(Math.min(...list.map((entry) => entry.wallMin))),
      wallMax: round(Math.max(...list.map((entry) => entry.wallMax))),
      heapMedian: median(list.map((entry) => entry.heapDeltaBytes)), io: list[0].ioPerCall });
  }
  return rows.sort((left, right) => left.history - right.history
    || left.kind.localeCompare(right.kind) || left.arm.localeCompare(right.arm));
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

const DOMAIN_STORAGE_ANCHORS = [
  ["async function hydrate(archiveReadCache = memory?.archiveReadCache) {",
    "async function hydrate(archiveReadCache = memory?.archiveReadCache) { const __h = performance.now();"],
  ["    const current = await createMemory(root, domain.global.get().aggregate, null, true, archiveReadCache);",
    "    let __m = performance.now(); const current = await createMemory(root, domain.global.get().aggregate, null, true, archiveReadCache); __A(\"hydrate.createMemory\", performance.now() - __m);"],
  ["    await observations.load({ snapshot: false });",
    "    __m = performance.now(); await observations.load({ snapshot: false }); __A(\"hydrate.observations.load\", performance.now() - __m); __A(\"hydrate.total\", performance.now() - __h);"],
  ["async function mutate(work, applied, details = null) {",
    "async function mutate(work, applied, details = null) { const __t = performance.now();"],
  ["    await installPending();\n    // The ledger has to be read after the recovery above:",
    "    let __p = performance.now(); await installPending(); __A(\"mutate.installPending1\", performance.now() - __p);\n    // The ledger has to be read after the recovery above:"],
  ["    const mirror = mirrorArchives(root, dir);",
    "    __p = performance.now(); const mirror = mirrorArchives(root, dir); __A(\"mutate.mirrorArchives\", performance.now() - __p);"],
  ["    const current = await createMemory(dir, domain.global.get().aggregate, archiveWriteGuard);",
    "    __p = performance.now(); const current = await createMemory(dir, domain.global.get().aggregate, archiveWriteGuard); __A(\"mutate.createMemoryStage\", performance.now() - __p);"],
  ["    const result = await work(current.instance, store, { recovered });",
    "    __p = performance.now(); const result = await work(current.instance, store, { recovered }); __A(\"mutate.work\", performance.now() - __p);"],
  ["    await current.instance.flushDeferredArchiveIndex();",
    "    __p = performance.now(); await current.instance.flushDeferredArchiveIndex(); __A(\"mutate.flushDeferredIndex\", performance.now() - __p);"],
  ["    assertLiveTreeUnchanged(root, mirror);",
    "    __p = performance.now(); assertLiveTreeUnchanged(root, mirror); __A(\"mutate.assertLiveTreeUnchanged\", performance.now() - __p);"],
  ["    const files = changedArchiveFiles(dir, mirror, root);",
    "    __p = performance.now(); const files = changedArchiveFiles(dir, mirror, root); __A(\"mutate.changedArchiveFiles\", performance.now() - __p);"],
  ["    writeStageManifest(dir, files);",
    "    __p = performance.now(); writeStageManifest(dir, files); __A(\"mutate.writeStageManifest\", performance.now() - __p);"],
  ["    if (staged) syncStage({ directory: dir, stagingRoot: staging, files });",
    "    __p = performance.now(); if (staged) syncStage({ directory: dir, stagingRoot: staging, files }); __A(\"mutate.syncStage\", performance.now() - __p);"],
  ["      await domain.global.set(schema.parse({ schema: 1, aggregate: latest.aggregate, applied: latest.applied,\n        pending: { stage, aggregate, applied: ledger, files, ...(retention === null ? {} : { retention }) } }));\n      await installPending();",
    "      __p = performance.now(); await domain.global.set(schema.parse({ schema: 1, aggregate: latest.aggregate, applied: latest.applied,\n        pending: { stage, aggregate, applied: ledger, files, ...(retention === null ? {} : { retention }) } })); __A(\"mutate.pendingSet\", performance.now() - __p);\n      __p = performance.now(); await installPending(); __A(\"mutate.installPending2\", performance.now() - __p);"],
  ["    await hydrate(current.instance.archiveReadCache);\n    return result;",
    "    __p = performance.now(); await hydrate(current.instance.archiveReadCache); __A(\"mutate.hydrate\", performance.now() - __p); __A(\"mutate.total\", performance.now() - __t);\n    return result;"],
  ["  async function installPending() {\n    const current = schema.parse(domain.global.get());",
    "  async function installPending() {\n    const __i = performance.now();\n    const current = schema.parse(domain.global.get());\n    __A(\"installPending.parse\", performance.now() - __i);"],
  ["    if (files) installArchiveFiles(source, root, files);",
    "    if (files) { const __f = performance.now(); installArchiveFiles(source, root, files); __A(\"installPending.installFiles\", performance.now() - __f); }"],
  ["    await domain.global.set({ schema: 1, aggregate: current.pending.aggregate, applied: current.pending.applied,\n      ...(floor === null ? {} : { retention: floor }), pending: null });",
    "    { const __g = performance.now(); await domain.global.set({ schema: 1, aggregate: current.pending.aggregate, applied: current.pending.applied,\n      ...(floor === null ? {} : { retention: floor }), pending: null }); __A(\"installPending.finalSet\", performance.now() - __g); }"],
];

const MEMORY_ANCHORS = [
  ["      const matches = event ? this.#sourceMatches(collection, event) : [];",
    "      const __sm = performance.now(); const matches = event ? this.#sourceMatches(collection, event) : []; __A(\"memory.sourceMatches\", performance.now() - __sm);"],
  ["  #sourceMatches(collection, event) {\n    if (!event?.knowledgeKey",
    "  #sourceMatches(collection, event) {\n    const __sr = performance.now();\n    if (!event?.knowledgeKey"],
  ["    const state = this.#archiveRead(collection);\n    const hotById = new Map();",
    "    const state = this.#archiveRead(collection);\n    __A(\"memory.sourceMatches.read\", performance.now() - __sr);\n    const hotById = new Map();"],
  ["      reads = new Map(files.map((file) => {",
    "      const __rd = performance.now(); reads = new Map(files.map((file) => {", ],
  ["      if (this.#archiveReadsCarry(cached, files, reads) && this.#archiveReadParts(collection)?.identity === located.identity) {",
    "      __A(\"memory.inheritedReads\", performance.now() - __rd);\n      if (this.#archiveReadsCarry(cached, files, reads) && this.#archiveReadParts(collection)?.identity === located.identity) {"],
  ["  async #archiveEntries(collection, entries, { replaceExisting = false } = {}) {\n    const run = async () => {",
    "  async #archiveEntries(collection, entries, { replaceExisting = false } = {}) {\n    const __e = performance.now();\n    const run = async () => {"],
  ["    const queued = this.archiveWriting.then(run, run);\n    this.archiveWriting = queued.catch(() => {});\n    return queued;",
    "    const queued = this.archiveWriting.then(run, run);\n    this.archiveWriting = queued.catch(() => {});\n    return queued.then((value) => { __A(\"memory.archiveEntries\", performance.now() - __e); return value; }, (error) => { __A(\"memory.archiveEntries\", performance.now() - __e); throw error; });"],
  ["    const rebuilt = this.#indexEntryFromFacts(collection, file, facts, { sealed: false });\n    this.archiveActiveKeys.set(collection, facts.objectKeys);\n    this.#archiveScanBases.set(collection, { identity, parsed: facts.parsed });\n    rememberArchiveScan(collection, file, info, rebuilt, facts.objectKeys, facts.parsed);\n    return rebuilt;",
    "    const rebuilt = this.#indexEntryFromFacts(collection, file, facts, { sealed: false });\n    this.archiveActiveKeys.set(collection, facts.objectKeys);\n    this.#archiveScanBases.set(collection, { identity, parsed: facts.parsed });\n    rememberArchiveScan(collection, file, info, rebuilt, facts.objectKeys, facts.parsed);\n    __A(\"memory.reconcileActiveScan\", performance.now() - __scanStart);\n    return rebuilt;"],
  ["  async #reconcileActiveArchive(collection, file) {\n    const info = await stat(file, { bigint: true });",
    "  async #reconcileActiveArchive(collection, file) {\n    const __scanStart = performance.now();\n    const info = await stat(file, { bigint: true });"],
];

function patchAnchors(text, anchors, file) {
  let patched = text;
  for (const [anchor, replacement] of anchors) {
    const parts = patched.split(anchor);
    assert.equal(parts.length, 2, `${file}: anchor must match exactly once: ${anchor.slice(0, 80)}`);
    patched = parts.join(replacement);
  }
  return patched;
}

function extractBaselineTree(name, ref) {
  const directory = path.join(temp, `arm-${name}`);
  fs.mkdirSync(directory);
  const archive = execFileSync("git", ["-C", REPO, "archive", ref, "lib"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", directory], { input: archive });
  fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(directory, "node_modules"));
  return directory;
}

function materializeAttributed() {
  const directory = ATTRIBUTE_BASELINE ? extractBaselineTree("attributed-baseline", ATTRIBUTE_BASELINE) : materialize("attributed");
  const prologue = "const __A = (key, ms) => globalThis.__attrAdd(key, ms);\n";
  const domainFile = path.join(directory, "lib/domain-storage.js");
  fs.writeFileSync(domainFile, prologue + patchAnchors(fs.readFileSync(domainFile, "utf8"), DOMAIN_STORAGE_ANCHORS, "domain-storage.js"));
  const memoryFile = path.join(directory, "lib/dockyard-domain/memory.js");
  fs.writeFileSync(memoryFile, prologue + patchAnchors(fs.readFileSync(memoryFile, "utf8"), MEMORY_ANCHORS, "memory.js"));
  return directory;
}

async function attribute() {
  const stats = new Map();
  globalThis.__attrAdd = (key, ms) => {
    const row = stats.get(key) ?? { total: 0, count: 0 };
    row.total += ms; row.count += 1;
    stats.set(key, row);
  };
  const arm = await importArm(materializeAttributed());
  const results = [];
  for (const history of HISTORIES) {
    const fixture = await buildFixture(arm, history);
    const root = fs.mkdtempSync(path.join(temp, `attr-${history}-`));
    fs.cpSync(fixture, root, { recursive: true });
    const session = await openSession(root, arm, { core: false });
    for (let index = 0; index < 3; index += 1) await session.port.observe(probeDto(900000 + index));
    stats.clear();
    const started = performance.now();
    // `observeAutonomous` reads committed evidence after every commit, and that
    // read is the new live instance's *first* archive read. Time both in the
    // order the observer runs them, so the read measurement is not a warmed
    // repeat on the same instance.
    const reads = [];
    for (let index = 0; index < STEPS; index += 1) {
      await session.port.observe(probeDto(index));
      const read = performance.now();
      session.port.autonomousObservations();
      reads.push(performance.now() - read);
    }
    const wall = (performance.now() - started) / STEPS;
    await session.close();
    results.push({ history, steps: STEPS, wallPerStep: round(wall), autonomousReadMs: round(median(reads)),
      phases: [...stats].map(([key, row]) => ({ key, perStep: round(row.total / STEPS), calls: row.count }))
        .sort((left, right) => right.perStep - left.perStep) });
  }
  return { mode: "attribute", node: process.version, platform: `${process.platform}/${process.arch}`, results };
}

// ---------------------------------------------------------------------------
// Counterexample: the withdrawn shortcut, reproduced without touching the tree.
// ---------------------------------------------------------------------------

const TRUST_FROM = `      reads = new Map(files.map((file) => {
        try { return [file, { digest: this.#archiveFileDigest(file) }]; }
        catch (error) { return [file, { error }]; }
      }));`;
const TRUST_TO = `      reads = new Map(files.map((file) => [file, { digest: cached.digests.get(file.split("/").at(-1)) }]));`;

function materializeTrustCandidate() {
  return materialize("trust-handoff", (libDirectory) => {
    const file = path.join(libDirectory, "dockyard-domain/memory.js");
    const text = fs.readFileSync(file, "utf8");
    assert.equal(text.split(TRUST_FROM).length, 2, "the withdrawn candidate anchor must match exactly once");
    fs.writeFileSync(file, text.replace(TRUST_FROM, TRUST_TO));
  });
}

/**
 * Reproduce the pinned requirement directly: a successor instance handed a
 * parse whose bytes it has not read itself must still observe a new EACCES.
 * The released implementation throws; the withdrawn candidate returns rows.
 */
async function successorReadProbe(arm) {
  const root = fs.mkdtempSync(path.join(temp, "read-fault-"));
  const live = path.join(root, "live");
  const stage = path.join(root, "stage");
  fs.mkdirSync(live); fs.mkdirSync(stage);
  const filename = "state.json.observations-archive.jsonl";
  const segmentDir = `${filename}.segments`;
  fs.mkdirSync(path.join(live, segmentDir)); fs.mkdirSync(path.join(stage, segmentDir));
  for (const [index, name] of [`${segmentDir}/segment-000000000001.jsonl`, filename].entries()) {
    fs.writeFileSync(path.join(live, name), `${JSON.stringify({ id: `cold-${index}`, message: "test" })}\n`);
    fs.linkSync(path.join(live, name), path.join(stage, name));
  }
  const authority = { assertMutation() {} };
  const make = (filePath, cache) => new arm.EvolutionMemory({ stateStore: { filePath, load: async () => ({}), update: async () => {} },
    archiveReadCache: cache, clock: () => new Date("2026-10-12T00:00:00.000Z"), mutationAuthority: authority });
  const predecessor = make(path.join(live, "state.json"));
  assert.equal(predecessor.history("observations").length, 2);
  const shared = predecessor.archiveReadCache;
  const successor = make(path.join(stage, "state.json"), shared);
  // The same one-shot injection the pinned test uses: one failed attempt to read
  // the successor's archive, whether it arrives through the whole-file read or
  // the byte-level scan. A fallback retry would show up as a second attempt.
  const read = fs.readFileSync;
  const open = fs.openSync;
  let attempts = 0;
  const inject = (file) => {
    if (String(file) !== path.join(stage, filename)) return;
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error("injected read fault"), { code: "EACCES" });
  };
  fs.readFileSync = (file, ...rest) => { inject(file); return read(file, ...rest); };
  fs.openSync = (file, ...rest) => { inject(file); return open(file, ...rest); };
  syncBuiltinESMExports();
  try {
    const rows = successor.history("observations");
    const faults = successor.archiveIntegrity();
    return { attempts, rows: rows.map((row) => row.id), faults: faults.observations?.map((fault) => fault.code) ?? [] };
  } finally {
    fs.readFileSync = read;
    fs.openSync = open;
    syncBuiltinESMExports();
  }
}

async function counterexample() {
  const released = await importArm(materialize("released"));
  const candidate = await importArm(materializeTrustCandidate());
  return { mode: "counterexample",
    requirement: "test/observe-cache-read-fault.test.mjs: a successor parse must observe its own EACCES/EIO",
    released: await successorReadProbe(released), candidate: await successorReadProbe(candidate),
    script: HERE };
}

// ---------------------------------------------------------------------------

/** A tree whose measured files are exactly the ones in `ref`; the rest is this tree. */
function materializeBaseline(name, ref) {
  return materialize(name, (libDirectory) => {
    for (const relative of ["dockyard-domain/memory.js", "domain-storage.js"]) {
      const file = path.join(libDirectory, relative);
      fs.writeFileSync(file, execFileSync("git", ["-C", REPO, "show", `${ref}:lib/${relative}`],
        { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 }));
    }
  });
}

async function measure({ armNames = ["A1", "A2", "A3"], armDirs = null, mode = "measure" } = {}) {
  const restoreCounters = installCounters();
  const arms = {};
  for (const name of armNames) arms[name] = await importArm(armDirs?.[name] ?? materialize(name));
  const fixtures = new Map();
  for (const history of HISTORIES) fixtures.set(history, await buildFixture(arms[armNames[0]], history));
  const samples = [];
  for (const history of HISTORIES) {
    for (const core of [true, false]) {
      const calls = core ? BURST : 1;
      for (let roundIndex = 0; roundIndex < ROUNDS; roundIndex += 1) {
        for (const name of armOrder(armNames, roundIndex)) {
          samples.push(await sample({ arm: arms[name], armName: name, fixture: fixtures.get(history),
            history, core, calls, round: roundIndex }));
        }
      }
    }
  }
  restoreCounters();
  return { mode, node: process.version, platform: `${process.platform}/${process.arch}`,
    method: "one process; fresh copied fixture per sample; arm order rotates through every permutation before repeating; warmup excluded; open/seed/restart excluded; official storage",
    baseline: armDirs ? BASELINE : null,
    histories: HISTORIES, rounds: ROUNDS, burst: BURST, warmup: WARMUP, samples, summary: summarize(samples) };
}

/**
 * A / A-control / B: two copies of the baseline revision and this working tree.
 * The baseline is rebuilt from `--baseline`; the run fails unless the two trees
 * differ in exactly the file the change touches, so the measured difference
 * cannot come from another edit.
 */
async function compare() {
  const baselineDirs = { A1: materializeBaseline("baseline-1", BASELINE), A2: materializeBaseline("baseline-2", BASELINE) };
  const candidateDirectory = materialize("candidate");
  const baselineLib = path.join(baselineDirs.A1, "lib");
  const candidateLib = path.join(candidateDirectory, "lib");
  const list = (directory, prefix = "") => fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory() ? list(path.join(directory, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`]).sort();
  const files = list(baselineLib);
  assert.deepEqual(list(candidateLib), files, "the two trees must contain the same files");
  const changed = files.filter((file) => !fs.readFileSync(path.join(baselineLib, file)).equals(fs.readFileSync(path.join(candidateLib, file))));
  assert.deepEqual(changed, ["dockyard-domain/memory.js", "domain-storage.js"], "only the measured files may differ from the baseline");
  return measure({ armNames: ["A1", "A2", "B"],
    armDirs: { ...baselineDirs, B: candidateDirectory }, mode: "compare" });
}

let output;
try {
  output = MODE === "attribute" ? await attribute()
    : MODE === "counterexample" ? await counterexample()
      : MODE === "compare" ? await compare()
        : await measure();
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
if (OUT) fs.writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
