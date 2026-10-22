// A/B benchmark for the archive-index reconciliation comparison.
//
// The measured defect: `#reconcileArchiveIndex()` compared a rebuilt active-
// archive index entry with the loaded one through `JSON.stringify`, while
// `#reconcileActiveArchive()` stamps `updatedAt` from the clock on every load.
// Two loads of unchanged bytes therefore always differed, and every load
// rewrote the whole index document - a durable write on a read-only path, and a
// changed staged file that the domain transaction then fsyncs and installs.
//
// Both sides are real module trees: the candidate is this working tree, the
// baseline is `lib/` from a git revision with only
// `lib/dockyard-domain/memory.js` restored (shape-guarded below). Both run in
// one process, alternating which goes first, against identical fixtures.
//
//   node scripts/benchmarks/archive-index-churn.mjs [--baseline <rev>] [--rounds 3] [--loads 15] [--writes 15]
//
// Measurement rounds use a deterministic clock that advances one millisecond per
// read, which is the production condition (a clock that moves between loads) made
// reproducible. Equivalence rounds freeze the clock and require byte-identical
// durable output: under an advancing clock the two sides consume clock values at
// different rates (the candidate stops rewriting the index), so their timestamps
// are not comparable by construction; the frozen run is what proves the fix only
// removes writes. Nothing in the working tree is modified.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
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
// The commit this round started from: it must still carry the pre-change
// comparison, so a reproduction after this change landed keeps working.
const BASELINE_REV = option("baseline", "445830b");
const ROUNDS = Number(option("rounds", 3));
const LOADS = Number(option("loads", 15));
const WRITES = Number(option("writes", 15));
const FROZEN_NOW = Date.parse("2026-10-22T00:00:00.000Z");

const BASELINE_ONLY = 'if (JSON.stringify(current) !== JSON.stringify(rebuilt)) changed = true;';
const CANDIDATE_ONLY = 'if (!sameIndexEntry(current, rebuilt)) changed = true;';

function materializeBaseline() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "archive-index-churn-baseline-"));
  fs.cpSync(path.join(REPO_ROOT, "lib"), path.join(directory, "lib"), { recursive: true });
  const memoryPath = path.join(directory, "lib", "dockyard-domain", "memory.js");
  fs.writeFileSync(memoryPath, execFileSync("git", ["-C", REPO_ROOT, "show", `${BASELINE_REV}:lib/dockyard-domain/memory.js`], { encoding: "utf8" }));
  fs.symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(directory, "node_modules"));
  const source = fs.readFileSync(memoryPath, "utf8");
  assert.equal(source.split(BASELINE_ONLY).length - 1, 1, `baseline ${BASELINE_REV} must contain the pre-change comparison exactly once`);
  assert.equal(source.split(CANDIDATE_ONLY).length - 1, 0, `baseline ${BASELINE_REV} must not contain the candidate comparison`);
  return directory;
}

function resetUuidSequence() {
  let seed = 0;
  const original = crypto.randomUUID;
  crypto.randomUUID = () => `${String(++seed).padStart(8, "0")}-0000-4000-8000-000000000000`;
  // The modules import `randomUUID` as a binding; without this the stub only
  // affects callers that read it off the namespace at call time.
  syncBuiltinESMExports();
  return () => { crypto.randomUUID = original; syncBuiltinESMExports(); };
}

/** `freeze` renders both sides byte-comparable. `advance` is the production
 *  condition: one millisecond per clock read, deterministic per run. */
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

const ARCHIVE_ROWS = Array.from({ length: 40 }, (_, index) => ({
  id: `seed-obs-${index}`, patternKey: `pattern-${index}`, type: "agent/error", severity: "error",
  observedAt: `2026-10-20T00:00:${String(index).padStart(2, "0")}.000Z`, message: `seeded observation ${index}`,
}));

function seedMemoryFixture(root) {
  const filePath = path.join(root, "state.json");
  fs.writeFileSync(`${filePath}.observations-archive.jsonl`, `${ARCHIVE_ROWS.map(row => JSON.stringify(row)).join("\n")}\n`);
  let stored = { evolution: { schema: 4, observations: ARCHIVE_ROWS.map(row => ({ ...row })) } };
  const stateStore = {
    filePath, inlineSerialization: true,
    load: async () => structuredClone(stored),
    update: async updater => { stored = updater(stored); },
    save: async value => { stored = value; },
  };
  return { filePath, stateStore, stored: () => stored };
}

const median = values => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];

async function runLoadSide(libDirectory, mode) {
  const { EvolutionMemory } = await import(pathToFileURL(path.join(libDirectory, "lib", "dockyard-domain", "memory.js")).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-index-churn-loads-"));
  const { filePath, stateStore, stored } = seedMemoryFixture(root);
  const create = () => new EvolutionMemory({ stateStore, maxEntries: 20, hotEntries: 5,
    mutationAuthority: { assertMutation() {} } });
  const restoreUuid = resetUuidSequence();
  const restoreClock = installClock(mode);
  try {
    // Fixture setup: the first load archives the overflow and writes the index.
    await create().load({ snapshot: false });
    const indexFile = `${filePath}.evolution-archive-index.json`;
    assert.ok(fs.existsSync(indexFile), "the seeded archive must produce an index");
    const samples = [];
    let replacements = 0;
    for (let sample = 0; sample < LOADS; sample++) {
      const inode = fs.statSync(indexFile).ino;
      const cpu = process.cpuUsage();
      const started = performance.now();
      await create().load({ snapshot: false });
      const used = process.cpuUsage(cpu);
      samples.push({ wallMs: performance.now() - started, cpuMs: (used.user + used.system) / 1000 });
      if (fs.statSync(indexFile).ino !== inode) replacements += 1;
    }
    // The state store of this fixture keeps its document in memory and never
    // writes it; write the final value so the compared tree includes the state
    // document as well as the archive files and the index.
    fs.writeFileSync(filePath, JSON.stringify(stored()));
    const durable = fs.readdirSync(root).sort().map(name => [name, fs.readFileSync(path.join(root, name), "utf8")]);
    return { samples, replacements, durable };
  } finally {
    restoreClock();
    restoreUuid();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const OBSERVATION = index => ({ type: "agent/error", code: "AGENT_ERROR", message: `synthetic failure ${index}`,
  target: "agent", componentId: "agent", severity: "error", status: "failed" });

async function runPortSide(libDirectory, root, mode) {
  const { openDomainStorage } = await import(pathToFileURL(path.join(libDirectory, "lib", "domain-storage.js")).href);
  const { DomainFacility } = await import("@deepseek-ai/dsh-storage-domain");
  const { JsonStorageBackend } = await import("@deepseek-ai/dsh-storage-json");
  const backend = new JsonStorageBackend(path.join(root, "official"));
  const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: "json" });
  const eventLog = path.join(root, "events.jsonl");
  fs.writeFileSync(eventLog, "");
  const restoreUuid = resetUuidSequence();
  const restoreClock = installClock(mode);
  let port = null;
  try {
    port = await openDomainStorage(ctx, { presetDir: root, eventBridgePath: eventLog, eventBridgeKey: "b".repeat(64) });
    const indexFile = path.join(root, "dockyard", "state.json.evolution-archive-index.json");
    assert.ok(fs.existsSync(indexFile), "the seeded archive must produce an index on open");
    for (let warm = 0; warm < 3; warm++) await port.observe(OBSERVATION(warm));
    const samples = [];
    let replacements = 0, fsyncs = 0;
    const realFsync = fs.fsyncSync;
    fs.fsyncSync = function (...values) { fsyncs += 1; return realFsync.apply(this, values); };
    syncBuiltinESMExports();
    try {
      for (let sample = 0; sample < WRITES; sample++) {
        const inode = fs.statSync(indexFile).ino;
        const startedFsyncs = fsyncs;
        const cpu = process.cpuUsage();
        const started = performance.now();
        await port.observe(OBSERVATION(100 + sample));
        const used = process.cpuUsage(cpu);
        samples.push({ wallMs: performance.now() - started, cpuMs: (used.user + used.system) / 1000,
          syncFsyncs: fsyncs - startedFsyncs });
        if (fs.statSync(indexFile).ino !== inode) replacements += 1;
      }
    } finally {
      fs.fsyncSync = realFsync;
      syncBuiltinESMExports();
    }
    await port.close();
    port = null;
    await backend.close();
    const read = file => fs.readFileSync(file, "utf8");
    const dockyard = path.join(root, "dockyard");
    const durable = {
      document: read(path.join(root, "official", "evolution_domain.json")).split(root).join("<root>"),
      index: read(indexFile),
      archives: fs.readdirSync(dockyard).filter(name => name !== "state.json.evolution-archive-index.json").sort()
        .map(name => [name, read(path.join(dockyard, name)).split(root).join("<root>")]),
    };
    return { samples, replacements, durable };
  } finally {
    if (port) await port.close();
    restoreClock();
    restoreUuid();
  }
}

const summarize = results => ({
  wallMs: median(results.samples.map(sample => sample.wallMs)),
  cpuMs: median(results.samples.map(sample => sample.cpuMs)),
  syncFsyncs: results.samples.some(sample => sample.syncFsyncs !== undefined)
    ? median(results.samples.map(sample => sample.syncFsyncs)) : null,
  indexReplacements: results.replacements,
});

const baselineDirectory = materializeBaseline();
const restore = () => fs.rmSync(baselineDirectory, { recursive: true, force: true });
process.on("exit", restore);

const SIDES = { baseline: () => baselineDirectory, candidate: () => REPO_ROOT };
const output = { baseline: BASELINE_REV, rounds: ROUNDS, loads: LOADS, writes: WRITES,
  environment: { node: process.version, platform: `${process.platform}/${process.arch}`, cpus: os.cpus().length,
    loadAverageAtStart: os.loadavg() },
  protocol: {
    measurementClock: "deterministic clock advancing 1 ms per read (production condition, reproducible)",
    equivalenceClock: "frozen at 2026-10-22T00:00:00.000Z; durable output must be byte-identical",
    order: "each round alternates which side runs first",
    fixture: "40 seeded rows in state.json.observations-archive.jsonl plus the same hot rows in the state store; maxEntries 20, hotEntries 5 at the memory level, production defaults through the domain port",
  }, rounds: [] };

try {
  for (let round = 1; round <= ROUNDS; round++) {
    const order = round % 2 === 1 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    const measured = { round, order, loads: {}, port: {} };
    for (const side of order) measured.loads[side] = summarize(await runLoadSide(SIDES[side](), "advance"));
    for (const side of order) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `archive-index-churn-port-${side}-`));
      fs.mkdirSync(path.join(root, "dockyard"), { recursive: true });
      fs.writeFileSync(path.join(root, "dockyard", "state.json.observations-archive.jsonl"), `${ARCHIVE_ROWS.map(row => JSON.stringify(row)).join("\n")}\n`);
      try { measured.port[side] = summarize(await runPortSide(SIDES[side](), root, "advance")); }
      finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
    output.rounds.push(measured);
  }

  // Equivalence: frozen clock, byte-identical durable output on both sides.
  const equivalence = { loads: [], port: [] };
  for (const side of ["baseline", "candidate"]) {
    const loaded = await runLoadSide(SIDES[side](), "freeze");
    equivalence.loads.push({ side, durable: loaded.durable });
  }
  assert.deepEqual(equivalence.loads[1].durable, equivalence.loads[0].durable,
    "both implementations must persist identical state files under a frozen clock");
  for (const side of ["baseline", "candidate"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `archive-index-churn-freeze-${side}-`));
    fs.mkdirSync(path.join(root, "dockyard"), { recursive: true });
    fs.writeFileSync(path.join(root, "dockyard", "state.json.observations-archive.jsonl"), `${ARCHIVE_ROWS.map(row => JSON.stringify(row)).join("\n")}\n`);
    try { equivalence.port.push({ side, durable: (await runPortSide(SIDES[side](), root, "freeze")).durable }); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  assert.equal(equivalence.port[1].durable.document, equivalence.port[0].durable.document,
    "both implementations must persist the same domain document under a frozen clock");
  assert.equal(equivalence.port[1].durable.index, equivalence.port[0].durable.index,
    "both implementations must persist the same archive index under a frozen clock");
  assert.deepEqual(equivalence.port[1].durable.archives, equivalence.port[0].durable.archives,
    "both implementations must persist the same archive bytes under a frozen clock");
  output.equivalence = { frozenClockDurableByteIdentical: true,
    compared: ["the memory-level state document, archive files and archive index", "official/evolution_domain.json, every archive file and the archive index through the real port"] };

  const pick = (side, group, key) => output.rounds.map(round => round[group][side][key]);
  output.summary = {
    perLoad: Object.fromEntries(Object.keys(SIDES).map(side => [side, { wallMs: median(pick(side, "loads", "wallMs")),
      cpuMs: median(pick(side, "loads", "cpuMs")), indexReplacements: median(pick(side, "loads", "indexReplacements")) }])),
    perWrite: Object.fromEntries(Object.keys(SIDES).map(side => [side, { wallMs: median(pick(side, "port", "wallMs")),
      cpuMs: median(pick(side, "port", "cpuMs")), syncFsyncs: median(pick(side, "port", "syncFsyncs")),
      indexReplacements: median(pick(side, "port", "indexReplacements")) }])),
  };
  output.environment.loadAverageAtEnd = os.loadavg();
  console.log(JSON.stringify(output, null, 2));
} finally {
  restore();
}
