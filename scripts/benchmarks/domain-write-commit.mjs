// End-to-end A/B benchmark of the default-config domain write path.
//
// The measured path is exactly the production one: `openDomainStorage(ctx,
// config)` over the real official `DomainFacility` + `JsonStorageBackend`, then
// public `port.observe()` writes, each of which stages, commits and hydrates the
// archive transaction. Nothing is replaced in the working tree and no private
// function is called.
//
// With no `--memory`, this script materialises `domainStorageBaseline().source`
// in a temporary directory and re-enters itself with `--memory <file>`. That
// option is the pinned pre-change baseline, never an arbitrary historical
// snapshot; the candidate is always the working tree.
//
// Both implementations run in one process against the same fixture path, one
// after the other, alternating which goes first. The clock is frozen and
// `crypto.randomUUID` is a per-run deterministic sequence reset before every
// run, so every pair asserts the full persisted tree, all query projections and
// the post-restart projections are identical as raw bytes - no mask, no
// placeholder and no field excluded from the digest, so a difference in an id or
// in a reference to one fails the comparison instead of hiding in it.
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto, { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { JsonStorageBackend } from "@deepseek-ai/dsh-storage-json";
import { domainStorageBaseline, materializeDomainStorage } from "../../test/domain-storage/domain-storage-baseline.js";

const WORKING_SOURCE = fileURLToPath(new URL("../../lib/domain-storage.js", import.meta.url));
const QUERY_COLLECTIONS = ["cycles", "observations", "proposals", "experiments", "promotions", "outcomes", "lineage", "knowledge"];
const FROZEN_NOW = Date.parse("2026-10-12T00:00:00.000Z");

const args = process.argv.slice(2);
const options = { memory: null, writes: 400, sessions: 3, warmup: 1, buckets: 8 };
if (args.length === 1 && args[0] === "--help") {
  console.log(`Usage: node scripts/benchmarks/domain-write-commit.mjs [options]
  --writes <integer >= 1>    public port.observe() writes per session (default: 400)
  --sessions <integer >= 1>  measured sessions per implementation (default: 3)
  --warmup <integer >= 0>    uncounted sessions (default: 1)
  --buckets <integer >= 1>   equal-size latency buckets reported per session (default: 8)
  --memory <file>            exact domainStorageBaseline().source, stored outside the tree
Without --memory, a temporary baseline is generated and passed to a child run.
The path measured is openDomainStorage + public observe() over the official
DomainFacility/JsonStorageBackend, i.e. the real default-config transaction.
JSONL: metadata, one sample per session, one summary; equivalence is asserted
per session pair and the process exits non-zero on any divergence.
Smoke: node scripts/benchmarks/domain-write-commit.mjs --writes 60 --sessions 1 --warmup 0
Formal: node scripts/benchmarks/domain-write-commit.mjs --writes 400 --sessions 3 --warmup 1`);
  process.exit(0);
}
for (let i = 0; i < args.length; i += 2) {
  const name = args[i].slice(2);
  if (!args[i].startsWith("--") || !Object.hasOwn(options, name) || args[i + 1] === undefined || args[i + 1].startsWith("--")) {
    throw new Error(`Unknown/missing option: ${args[i]}`);
  }
  options[name] = name === "memory" ? resolve(args[i + 1]) : Number(args[i + 1]);
}
for (const name of ["writes", "sessions", "buckets"]) {
  if (!Number.isSafeInteger(options[name]) || options[name] < 1) throw new Error(`Invalid --${name}: expected integer >= 1`);
}
if (!Number.isSafeInteger(options.warmup) || options.warmup < 0) throw new Error("Invalid --warmup: expected integer >= 0");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const emit = (value) => console.log(JSON.stringify(value));
const round = (value) => Math.round(value * 1000) / 1000;
function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { samples: values.length, median, mad: summarizeMedianAbsoluteDeviation(values, median), min: sorted[0], max: sorted.at(-1) };
}
function summarizeMedianAbsoluteDeviation(values, median) {
  const deviations = values.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
  const middle = Math.floor(deviations.length / 2);
  return deviations.length % 2 ? deviations[middle] : (deviations[middle - 1] + deviations[middle]) / 2;
}

/** Freeze the clock so two runs of one workload are byte-comparable. */
function freezeClock() {
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...value) { if (value.length === 0) super(FROZEN_NOW); else super(...value); }
    static now() { return FROZEN_NOW; }
  }
  Object.setPrototypeOf(FrozenDate, RealDate);
  globalThis.Date = FrozenDate;
  return () => { globalThis.Date = RealDate; };
}

/**
 * Make `crypto.randomUUID` a per-run deterministic sequence. Record ids embed
 * it, and every other UUID is only a temporary or staging name, so this turns
 * the persisted tree into something two runs must reproduce byte for byte
 * instead of something a mask has to blur. The counter is reset per run so both
 * implementations mint the same ids in the same order; a difference in call
 * order or count therefore fails the comparison instead of hiding in a mask.
 */
function freezeUuid() {
  const original = crypto.randomUUID;
  let counter = 0;
  const sequence = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
  crypto.randomUUID = sequence;
  syncBuiltinESMExports();
  return {
    reset: () => { counter = 0; },
    restore: () => { crypto.randomUUID = original; syncBuiltinESMExports(); },
  };
}

async function readTree(root) {
  const files = new Map();
  const walk = async (directory, relative) => {
    for (const name of (await readdir(directory)).sort()) {
      const absolute = join(directory, name);
      const nested = relative ? `${relative}/${name}` : name;
      const info = await stat(absolute);
      if (info.isDirectory()) await walk(absolute, nested);
      else if (info.isFile()) files.set(nested, await readFile(absolute));
    }
  };
  await walk(root, "");
  files.delete("domain-archive.lock");
  return files;
}

// The clock and the UUID source are frozen and both implementations run in the
// same fixture path, so the comparison is exact byte equality: no mask, no
// placeholder, no field excluded from the digest.
function digestTree(files) {
  return Object.fromEntries([...files.keys()].sort().map((name) => [name, sha256(files.get(name))]));
}

async function run(openDomainStorage, home, writes, buckets, uuid) {
  const root = join(home, "fixture");
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  uuid.reset();
  const backend = new JsonStorageBackend(join(root, "official"));
  const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: "json" });
  const config = { presetDir: root, eventBridgePath: join(root, "execution-events.jsonl"), eventBridgeKey: "b".repeat(64) };
  let port;
  try {
    port = await openDomainStorage(ctx, config);
    await port.observe({ code: "BENCH_ERROR", target: "tool:warm" });
    const writeMs = [];
    const cpuStart = process.cpuUsage();
    for (let i = 0; i < writes; i += 1) {
      const start = performance.now();
      await port.observe({ code: "BENCH_ERROR", target: `tool:${i}` });
      writeMs.push(performance.now() - start);
    }
    const used = process.cpuUsage(cpuStart);
    const cpuMs = (used.user + used.system) / 1000;
    const queries = Object.fromEntries(QUERY_COLLECTIONS.map((collection) => [collection, port.query(collection, 50)]));
    await port.close();
    port = null;
    const afterRestart = await openDomainStorage(ctx, config);
    const restarted = Object.fromEntries(QUERY_COLLECTIONS.map((collection) => [collection, afterRestart.query(collection, 50)]));
    await afterRestart.close();
    port = null;
    // The committed medium must reproduce exactly what the live port reported.
    assert.deepEqual(restarted, queries, "a restart must reproduce the pre-close projection");

    const tree = await readTree(root);
    const size = (await stat(join(root, "official", "evolution_domain.json"))).size;
    const indexes = await readdir(join(root, "dockyard"));
    const segments = indexes.filter((name) => name.endsWith(".jsonl"));
    const archiveBytes = (await Promise.all(segments.map((name) => stat(join(root, "dockyard", name)).then((info) => info.size))))
      .reduce((sum, value) => sum + value, 0);

    const size_ = Math.max(1, Math.floor(writes / buckets));
    const latency = [];
    for (let i = 0; i < writes; i += size_) {
      const slice = writeMs.slice(i, i + size_);
      if (slice.length) latency.push({ from: i + 1, to: i + slice.length, median: round(summarize(slice).median) });
    }
    return {
      writeMs, latency, cpuMs,
      digests: {
        tree: digestTree(tree),
        queries: Object.fromEntries(Object.entries(queries).map(([collection, value]) => [collection, `${value.count}:${sha256(JSON.stringify(value.entries))}`])),
        restarted: Object.fromEntries(Object.entries(restarted).map(([collection, value]) => [collection, `${value.count}:${sha256(JSON.stringify(value.entries))}`])),
      },
      shape: { globalBytes: size, archiveFiles: segments.length, archiveBytes, hotObservations: queries.observations.count, knowledge: queries.knowledge.count },
    };
  } finally {
    if (port) await port.close();
    await backend.close();
    await rm(root, { recursive: true, force: true });
  }
}

function assertEquivalent(baseline, after, label) {
  assert.deepEqual(after.digests.tree, baseline.digests.tree, `${label}: persisted tree digest mismatch`);
  assert.deepEqual(after.digests.queries, baseline.digests.queries, `${label}: query projection mismatch`);
  assert.deepEqual(after.digests.restarted, baseline.digests.restarted, `${label}: post-restart projection mismatch`);
  assert.deepEqual(after.shape, baseline.shape, `${label}: persisted shape mismatch`);
}

const home = await mkdtemp(join(tmpdir(), "dsh-domain-write-bench-"));
try {
  const baseline = await domainStorageBaseline();
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
    assert.equal(baselineSource, baseline.source, "--memory must contain exactly domainStorageBaseline().source");
    const afterSource = await readFile(WORKING_SOURCE, "utf8");
    const implementations = {
      baseline: (await materializeDomainStorage(baselineSource, home, "baseline")).openDomainStorage,
      after: (await materializeDomainStorage(afterSource, home, "after")).openDomainStorage,
    };
    const sources = { baseline: { source: options.memory, sourceSha256: sha256(baselineSource) },
      after: { source: WORKING_SOURCE, sourceSha256: sha256(afterSource) } };
    assert.notEqual(sources.baseline.sourceSha256, sources.after.sourceSha256, "A/B implementations must differ");
    emit({ type: "metadata", node: process.version, platform: `${process.platform}/${process.arch}`,
      sources, writes: options.writes, sessions: options.sessions, warmup: options.warmup, anchor: baseline.anchor.artifact,
      clock: `frozen at ${new Date(FROZEN_NOW).toISOString()}`, uuid: "crypto.randomUUID replaced by a per-run deterministic sequence, counter reset before every run",
      scope: "openDomainStorage over the official DomainFacility/JsonStorageBackend, then public port.observe() per write: stage mirror, memory load, work, commit, archive install, hydrate; fixture reset, assertions, snapshots and hashes are outside the timed interval",
      order: "alternate baseline/after order per iteration; both run in the same fixture path; the persisted tree, the query projections and the post-restart projections are compared as raw bytes with no masking for every warmup and measured session",
      command: [process.execPath, fileURLToPath(import.meta.url), ...args] });

    const results = { baseline: [], after: [] };
    const unfreeze = freezeClock();
    const uuid = freezeUuid();
    try {
      for (let i = 0; i < options.warmup + options.sessions; i += 1) {
        const warmup = i < options.warmup;
        const order = i % 2 === 0 ? ["baseline", "after"] : ["after", "baseline"];
        const pair = {};
        for (const implementation of order) pair[implementation] = await run(implementations[implementation], home, options.writes, options.buckets, uuid);
        emit({ type: "equivalence", iteration: i + 1, warmup, digests: { baseline: pair.baseline.digests, after: pair.after.digests } });
        assertEquivalent(pair.baseline, pair.after, `iteration ${i + 1}`);
        for (const implementation of order) {
          const result = pair[implementation];
          const summary = summarize(result.writeMs);
          emit({ type: "sample", implementation, iteration: i + 1, warmup, order, sourceSha256: sources[implementation].sourceSha256,
            totalMs: round(result.writeMs.reduce((sum, value) => sum + value, 0)),
            cpuMs: round(result.cpuMs), cpuPerWriteMs: round(result.cpuMs / options.writes),
            perWriteMedianMs: round(summary.median), perWriteMadMs: round(summary.mad),
            perWriteMinMs: round(summary.min), perWriteMaxMs: round(summary.max),
            latency: result.latency, shape: result.shape, equivalent: true });
          if (!warmup) results[implementation].push(result);
        }
      }
    } finally { uuid.restore(); unfreeze(); }

    const summary = {};
    for (const implementation of ["baseline", "after"]) {
      const sessions = results[implementation];
      summary[implementation] = {
        totalMs: summarize(sessions.map((session) => session.writeMs.reduce((sum, value) => sum + value, 0))),
        cpuMs: summarize(sessions.map((session) => session.cpuMs)),
        perWriteMedianMs: summarize(sessions.flatMap((session) => session.writeMs.map(round))),
        perSessionMedianMs: summarize(sessions.map((session) => summarize(session.writeMs).median)),
        lastBucketMedianMs: summarize(sessions.map((session) => session.latency.at(-1).median)),
      };
    }
    const change = (before, after) => ({ before, after, deltaPercent: before === 0 ? null : round(((after - before) / before) * 100) });
    emit({ type: "summary", writes: options.writes, sessions: options.sessions, warmup: options.warmup, sources,
      summary, comparison: {
        totalMs: change(summary.baseline.totalMs.median, summary.after.totalMs.median),
        cpuMs: change(summary.baseline.cpuMs.median, summary.after.cpuMs.median),
        perWriteMedianMs: change(summary.baseline.perWriteMedianMs.median, summary.after.perWriteMedianMs.median),
        perSessionMedianMs: change(summary.baseline.perSessionMedianMs.median, summary.after.perSessionMedianMs.median),
        lastBucketMedianMs: change(summary.baseline.lastBucketMedianMs.median, summary.after.lastBucketMedianMs.median),
      }, equivalent: true });
  }
} finally {
  await rm(home, { recursive: true, force: true });
}
