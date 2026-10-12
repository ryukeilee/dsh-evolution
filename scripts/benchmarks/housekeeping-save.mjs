// Public-path A/B benchmark. No working-tree replacements or private calls.
// With no --memory, materialise housekeepingBaseline().source in os.tmpdir()
// and invoke this script with --memory <file>. That option is the baseline,
// never an arbitrary historical snapshot; after always uses the working tree.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JsonStateStore } from "../../test/dockyard-domain/support.js";
import { housekeepingBaseline } from "../../test/dockyard-domain/housekeeping-baseline.js";

const WORKING_MEMORY = fileURLToPath(new URL("../../lib/dockyard-domain/memory.js", import.meta.url));
const SCALES = ["default-save", "hot-200", "hot-1000", "hot-5000"];
const NOW = "2026-10-12T00:00:00.000Z";
const FIRST = "2026-10-10T00:00:00.000Z";
const LAST = "2026-10-11T00:00:00.000Z";
const args = process.argv.slice(2);
const options = { memory: null, scale: "all", rows: 2000, runs: 5, warmup: 1 };
if (args.length === 1 && args[0] === "--help") {
  console.log(`Usage: node scripts/benchmarks/housekeeping-save.mjs [options]
  --scale all|default-save|hot-200|hot-1000|hot-5000  (default: all)
  --rows <integer >= 204>  default-save public writes (default: 2000)
  --runs <positive integer>  measured sessions/passes per implementation (default: 5)
  --warmup <nonnegative integer>  uncounted sessions/passes (default: 1)
  --memory <file>  exact housekeepingBaseline().source, stored outside the tree
Without --memory, a temporary baseline is generated and passed to a child run.
Hot scales have fixed rows per collection; --rows only controls default-save.
JSONL: metadata, every write, paired run samples with equality hashes, summaries.
Scope: default-save includes public append, save, housekeeping and file I/O;
hot timings exclude fixture reconstruction, load, snapshots and equality checks.
Smoke: node scripts/benchmarks/housekeeping-save.mjs --scale default-save --rows 240 --warmup 0 --runs 1
Formal: node scripts/benchmarks/housekeeping-save.mjs --scale all --rows 2000 --warmup 1 --runs 5`);
  process.exit(0);
}
for (let i = 0; i < args.length; i += 2) {
  const name = args[i].slice(2);
  if (!args[i].startsWith("--") || !Object.hasOwn(options, name)
      || args[i + 1] === undefined || args[i + 1].startsWith("--")) {
    throw new Error(`Unknown/missing option: ${args[i]}`);
  }
  options[name] = name === "memory" ? resolve(args[i + 1])
    : name === "scale" ? args[i + 1] : Number(args[i + 1]);
}
for (const name of ["rows", "runs", "warmup"]) {
  const minimum = name === "rows" ? 204 : name === "warmup" ? 0 : 1;
  if (!Number.isSafeInteger(options[name]) || options[name] < minimum) throw new Error(`Invalid --${name}: expected integer >= ${minimum}`);
}
if (options.scale !== "all" && !SCALES.includes(options.scale)) throw new Error(`Invalid --scale: ${options.scale}`);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const emit = (value) => console.log(JSON.stringify(value));
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function summarize(values) {
  const middle = median(values);
  return { samples: values.length, medianMs: middle,
    madMs: median(values.map((value) => Math.abs(value - middle))),
    minMs: Math.min(...values), maxMs: Math.max(...values) };
}

async function importMemorySource(source, home, label) {
  const modulePath = join(home, `${label}.mjs`);
  await writeFile(modulePath, source.replace(/from (["'])(\.\.?\/[^"']+)\1/g,
    (_match, quote, specifier) => `from ${quote}${new URL(specifier, pathToFileURL(WORKING_MEMORY)).href}${quote}`));
  const { EvolutionMemory } = await import(pathToFileURL(modulePath).href);
  assert.equal(typeof EvolutionMemory, "function", `${label} must export EvolutionMemory`);
  return EvolutionMemory;
}

// Four-entry groups exercise score selection, later timestamps and exact ties.
// Every fourth group lacks both fingerprint fields, exercising derived hashes.
function seededRecords(collection, rows) {
  return Array.from({ length: rows }, (_, i) => {
    const group = Math.floor(i / 4);
    return { id: `${collection}-${i}`, problem: `${collection}-problem-${group}`,
      change: { kind: "benchmark", group }, recordedAt: FIRST,
      lastSeen: i % 4 < 2 ? FIRST : LAST, fitnessScore: i % 4 === 0 ? 1 : 2,
      lifecycleState: group % 8 === 0 ? "REJECTED" : "NEEDS_EVIDENCE",
      ...(group % 4 === 3 ? {} : { candidateFingerprint: `${collection}-fp-${group}` }) };
  });
}
function hotSeed(rows) {
  const evolution = { schema: 4, candidates: seededRecords("candidates", rows),
    proposals: seededRecords("proposals", rows),
    tombstones: Array.from({ length: rows }, (_, i) => ({
      id: `seed-tombstone-${i}`, recordId: `retired-${i}`, fingerprint: `retired-fp-${i}`,
      candidateFingerprint: `retired-candidate-${i}`, state: "TOMBSTONE", count: 1,
    })) };
  for (const collection of ["promotions", "strategies", "experimentRecords"]) {
    evolution[collection] = Array.from({ length: rows }, (_, i) => ({
      id: `${collection}-${i}`, fingerprint: `${collection}-fp-${i}`,
      lifecycleState: "OBSOLETE", recordedAt: FIRST, problem: `${collection}-problem-${i}`,
    }));
  }
  return { evolution };
}
const jsonl = (records) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";

async function capture(memory, store) {
  const full = memory.fullSnapshot();
  const snapshotJson = JSON.stringify(full);
  const tombstonesJson = JSON.stringify(full.tombstones);
  // Keep hot tombstones too: fullSnapshot merges equal ids, which could mask
  // an erroneous extra occurrence or order change in the actual hot array.
  const hotTombstonesJson = JSON.stringify(memory.snapshot().tombstones);
  const archives = new Map();
  for (const name of (await readdir(dirname(store.filePath))).sort()) {
    if (/^state\.json\..+-archive\.jsonl$/.test(name)) {
      archives.set(name, await readFile(join(dirname(store.filePath), name)));
    } else if (/^state\.json\..+-archive\.jsonl\.segments$/.test(name)) {
      for (const segment of (await readdir(join(dirname(store.filePath), name))).sort()) {
        if (!/^segment-[0-9]+\.jsonl$/.test(segment)) continue;
        const relative = join(name, segment);
        archives.set(relative, await readFile(join(dirname(store.filePath), relative)));
      }
    }
  }
  const archiveSha256 = Object.fromEntries([...archives].map(([name, bytes]) => [name, sha256(bytes)]));
  return { snapshotJson, tombstonesJson, hotTombstonesJson, archives,
    digest: { snapshotSha256: sha256(snapshotJson), tombstonesSha256: sha256(tombstonesJson),
      hotTombstonesSha256: sha256(hotTombstonesJson), tombstones: full.tombstones.length,
      hotTombstones: memory.snapshot().tombstones.length, archiveSha256,
      archiveBytes: [...archives.values()].reduce((sum, bytes) => sum + bytes.length, 0) } };
}
function assertEquivalent(baseline, after, label) {
  assert.equal(after.digest.snapshotSha256, baseline.digest.snapshotSha256, `${label}: fullSnapshot JSON sha256 mismatch`);
  assert.equal(after.tombstonesJson, baseline.tombstonesJson, `${label}: tombstones byte/order/count mismatch`);
  assert.equal(after.hotTombstonesJson, baseline.hotTombstonesJson, `${label}: hot tombstones byte/order/count mismatch`);
  assert.deepEqual([...after.archives.keys()], [...baseline.archives.keys()], `${label}: archive file set mismatch`);
  for (const [name, bytes] of baseline.archives) {
    assert.ok(bytes.equals(after.archives.get(name)), `${label}: archive bytes mismatch: ${name}`);
  }
}

async function run(Memory, fixtureHome, scale, rows, seed) {
  // Rebuild exactly the same home (including absolute snapshot paths) outside
  // all timed intervals. No archives, index, or in-memory cache carry over.
  await rm(fixtureHome, { recursive: true, force: true });
  const store = new JsonStateStore({ filePath: join(fixtureHome, "state.json") });
  await mkdir(fixtureHome, { recursive: true });
  if (seed) {
    await writeFile(store.filePath, JSON.stringify(seed));
    // Nonempty durable history makes archive-byte equality non-vacuous.
    // load() keeps archiveKnown lazy; do not prime it via history/fullSnapshot
    // before timing, so this remains the actual fresh-load housekeeping path.
    for (const collection of ["candidates", "proposals"]) {
      await writeFile(`${store.filePath}.${collection}-archive.jsonl`, jsonl(seed.evolution[collection]));
    }
  }
  const memory = new Memory({ stateStore: store, clock: () => new Date(NOW),
    ...(seed ? { maxEntries: rows, hotEntries: rows } : {}) });
  memory.setMutationAuthority({ assertMutation() {}, isActive: () => true });
  await memory.load();
  assert.ok(memory.archiveFile, "file store must enable archives");
  const writes = [];
  const timings = {};
  if (scale === "default-save") {
    assert.equal(memory.maxEntries, 1000);
    assert.equal(memory.hotEntries, 50);
    const before = performance.now();
    memory.housekeeping();
    timings.beforeHousekeepingMs = performance.now() - before;
    for (let i = 0; i < rows; i += 1) {
      const operation = ["recordCandidate", "recordProposal", "recordPromotion", "recordObservation"][i % 4];
      const value = { id: `write-${i}`, problem: `problem-${i}`, fingerprint: `fp-${i}`,
        problemFingerprint: `problem-fp-${i}`, candidateFingerprint: `candidate-fp-${i}`,
        lifecycleState: operation === "recordPromotion" ? "OBSOLETE" : "NEEDS_EVIDENCE",
        recordedAt: NOW, forceRecord: true, change: { kind: "benchmark", index: i } };
      const start = performance.now();
      await memory[operation](value);
      writes.push({ write: i + 1, operation, writeMs: performance.now() - start });
    }
    const after = performance.now();
    memory.housekeeping();
    timings.afterHousekeepingMs = performance.now() - after;
    timings.writeTotalMs = writes.reduce((sum, write) => sum + write.writeMs, 0);
    timings.writeMeanMs = timings.writeTotalMs / rows;
    const hot = memory.snapshot();
    assert.equal(hot.promotions.length, 0, "obsolete public promotions must be retired on save");
    assert.equal(hot.tombstones.length, Math.floor((rows + 1) / 4), "tombstones must grow organically once per promotion");
    assert.equal((await store.load()).evolution.tombstones.length, hot.tombstones.length, "save must persist housekeeping effects");
    for (const collection of ["candidates", "proposals", "observations"]) {
      assert.equal(hot[collection].length, 50, `${collection} must cross the default hot/archive boundary`);
    }
  } else {
    const start = performance.now();
    memory.housekeeping();
    timings.housekeepingMs = performance.now() - start;
    const hot = memory.snapshot();
    assert.equal(hot.tombstones.length, rows * 5.5, "obsolete and duplicate retirement must complete, preserving seed tombstones");
    for (const collection of ["promotions", "strategies", "experimentRecords"]) {
      assert.equal(hot[collection].length, 0, `${collection} obsolete cleanup must complete`);
    }
    const expectedIds = (collection) => Array.from({ length: rows / 4 }, (_, group) => `${collection}-${group * 4 + 2}`);
    for (const collection of ["candidates", "proposals"]) {
      assert.deepEqual(hot[collection].map((entry) => entry.id), expectedIds(collection), `${collection} must retain the first exact-tie winner before lazy cold-history hydration`);
    }
  }
  const result = await capture(memory, store);
  assert.ok(result.archives.size > 0 && result.digest.archiveBytes > 0, "archive equality must be non-vacuous");
  return { ...result, timings, writes };
}

const home = await mkdtemp(join(tmpdir(), "dsh-housekeeping-benchmark-"));
try {
  const baseline = await housekeepingBaseline();
  if (!options.memory) {
    const baselineFile = join(home, "baseline-source.mjs");
    await writeFile(baselineFile, baseline.source);
    const code = await new Promise((fulfill, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args, "--memory", baselineFile], { stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => signal ? reject(new Error(`Benchmark child terminated: ${signal}`)) : fulfill(exitCode));
    });
    process.exitCode = code;
  } else {
    const baselineSource = await readFile(options.memory, "utf8");
    assert.equal(baselineSource, baseline.source, "--memory must contain exactly housekeepingBaseline().source");
    const afterSource = await readFile(WORKING_MEMORY, "utf8");
    assert.notEqual(sha256(afterSource), sha256(baselineSource), "A/B implementations must have different source hashes");
    const implementations = {
      baseline: await importMemorySource(baselineSource, home, "baseline"),
      after: await importMemorySource(afterSource, home, "after"),
    };
    const sources = { baseline: { source: options.memory, sourceSha256: sha256(baselineSource) },
      after: { source: WORKING_MEMORY, sourceSha256: sha256(afterSource) } };
    emit({ type: "metadata", node: process.version, platform: process.platform, arch: process.arch,
      sources, pinPredatesIndex: baseline.pinPredatesIndex, runs: options.runs, warmup: options.warmup,
      scale: options.scale, rows: options.scale.startsWith("hot-") ? Number(options.scale.slice(4)) : options.rows,
      rowsScope: "default-save writes; hot-N has N rows in each of six seed collections",
      scope: "default-save: each public write including save/housekeeping/knowledge/archive/state I/O, plus public housekeeping before/after; hot-N: one public housekeeping after untimed fresh load; fixture reset, assertions, snapshots and hashes excluded",
      order: "alternate baseline/after order per iteration; equality checked for every warmup and measured pair",
      command: [process.execPath, fileURLToPath(import.meta.url), ...args] });
    for (const scale of options.scale === "all" ? SCALES : [options.scale]) {
      const rows = scale === "default-save" ? options.rows : Number(scale.slice(4));
      const seed = scale === "default-save" ? null : hotSeed(rows);
      const results = { baseline: [], after: [] };
      let reference;
      let referenceDigests;
      for (let i = 0; i < options.warmup + options.runs; i += 1) {
        const warmup = i < options.warmup;
        const order = i % 2 === 0 ? ["baseline", "after"] : ["after", "baseline"];
        const pair = {};
        for (const implementation of order) pair[implementation] = await run(implementations[implementation], join(home, "fixture"), scale, rows, seed);
        const digests = { baseline: pair.baseline.digest, after: pair.after.digest };
        // Emit hashes even on failure, then throw with a nonzero process exit.
        emit({ type: "equivalence", scale, rows, iteration: i + 1, warmup, digests });
        assertEquivalent(pair.baseline, pair.after, `${scale} iteration ${i + 1}`);
        if (reference) assertEquivalent(reference, pair.baseline, `${scale} deterministic replay`);
        else { reference = pair.baseline; referenceDigests = digests; }
        for (const implementation of order) {
          const result = pair[implementation];
          for (const write of result.writes) emit({ type: "write", implementation, scale, rows,
            sourceSha256: sources[implementation].sourceSha256, iteration: i + 1, warmup, ...write });
          emit({ type: "sample", implementation, scale, rows, sourceSha256: sources[implementation].sourceSha256,
            iteration: i + 1, warmup, order, ...result.timings, digests, equivalent: true });
          if (!warmup) results[implementation].push(result);
        }
      }
      const summary = {};
      for (const implementation of ["baseline", "after"]) {
        const samples = results[implementation];
        summary[implementation] = Object.fromEntries(Object.keys(samples[0].timings)
          .map((metric) => [metric, summarize(samples.map((sample) => sample.timings[metric]))]));
        if (scale === "default-save") summary[implementation].pooledWrites = summarize(samples.flatMap((sample) => sample.writes.map((write) => write.writeMs)));
      }
      emit({ type: "summary", scale, rows, runs: options.runs, warmup: options.warmup, sources, summary,
        sampleUnit: scale === "default-save" ? "session; pooledWrites describes individual writes, not independent sessions" : "fresh-load housekeeping pass",
        digests: referenceDigests, equivalent: true });
    }
  }
} finally {
  await rm(home, { recursive: true, force: true });
}
