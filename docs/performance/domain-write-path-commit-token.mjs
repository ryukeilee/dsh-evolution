// A/B of the durable commit token on the default-config domain write path.
//
// Run: node docs/performance/domain-write-path-commit-token.mjs --writes 400 --sessions 3 --warmup 1
//
// Both sides are derived from the repository's own lib/ tree in a temporary
// directory: `tokenon` is a byte copy, `tokenoff` replaces only
// `writeCommitToken()`'s file operations with a no-op that still draws the same
// two `commitTokenEntropy()` values, so the only difference under test is the
// token's I/O. `commitTokenEntropy()` is `randomBytes(16).toString('hex')`, not
// the stubbed `randomUUID()`, so both sides keep the same deterministic id
// sequence and every persisted byte outside the token is comparable.
//
// The measurement shape follows scripts/benchmarks/domain-write-commit.mjs
// (same fixture, same workload, frozen clock, per-run deterministic UUID
// sequence, 8 latency buckets, cpuUsage accounting, warmup + measured sessions
// with alternating order). Two deliberate differences are documented in
// docs/performance/domain-write-path-commit-token.md section 2: the two sides
// are the same tree with and without the token I/O (not rc.8 vs the working
// tree), and `domain-commit.token` itself is excluded from the tree digest
// because it is the artifact under measurement. Every other persisted byte, the
// query projections and the post-restart projections are compared exactly for
// every pair, and the run exits non-zero on any divergence.
import assert from "node:assert/strict";
import fs, { cpSync } from "node:fs";
import crypto, { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { JsonStorageBackend } from "@deepseek-ai/dsh-storage-json";
import { materializeDomainStorage } from "../../test/domain-storage/domain-storage-baseline.js";

const QUERY_COLLECTIONS = ["cycles", "observations", "proposals", "experiments", "promotions", "outcomes", "lineage", "knowledge"];
const FROZEN_NOW = Date.parse("2026-10-12T00:00:00.000Z");
const TOKEN = "domain-commit.token";
const REPO_LIB = fileURLToPath(new URL("../../lib", import.meta.url));
const options = { writes: 400, sessions: 3, warmup: 1, buckets: 8, tokenon: null, tokenoff: null };
for (let i = 2; i < process.argv.length; i += 1) {
  const name = process.argv[i].slice(2);
  const value = process.argv[i + 1];
  if (!Object.hasOwn(options, name) || value === undefined) throw new Error(`Unknown/missing option: ${process.argv[i]}`);
  options[name] = typeof options[name] === "number" ? Number(value) : value;
  i += 1;
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const emit = (value) => console.log(JSON.stringify(value));
const round = (value) => Math.round(value * 1000) / 1000;
function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const deviations = values.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
  const dmiddle = Math.floor(deviations.length / 2);
  const mad = deviations.length % 2 ? deviations[dmiddle] : (deviations[dmiddle - 1] + deviations[dmiddle]) / 2;
  return { samples: values.length, median, mad, min: sorted[0], max: sorted.at(-1) };
}
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
function freezeUuid() {
  const original = crypto.randomUUID;
  let counter = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
  syncBuiltinESMExports();
  return { reset: () => { counter = 0; }, restore: () => { crypto.randomUUID = original; syncBuiltinESMExports(); } };
}
async function readTree(root, excluded) {
  const files = new Map();
  const walk = async (directory, relative) => {
    for (const name of (await readdir(directory)).sort()) {
      const absolute = join(directory, name);
      const nested = relative ? `${relative}/${name}` : name;
      const info = await stat(absolute);
      if (info.isDirectory()) await walk(absolute, nested);
      else if (info.isFile() && !excluded.has(nested)) files.set(nested, await readFile(absolute));
    }
  };
  await walk(root, "");
  return files;
}
const digestTree = (files) => Object.fromEntries([...files.keys()].sort().map((name) => [name, sha256(files.get(name))]));

async function run(openDomainStorage, home, options, uuid) {
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
    for (let i = 0; i < options.writes; i += 1) {
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
    assert.deepEqual(restarted, queries, "a restart must reproduce the pre-close projection");
    const tokenBytes = fs.existsSync(join(root, TOKEN)) ? fs.readFileSync(join(root, TOKEN), "utf8").trim().length : null;
    const tree = await readTree(root, new Set(["domain-archive-lock", TOKEN]));
    const size = (await stat(join(root, "official", "evolution_domain.json"))).size;
    const names = await readdir(join(root, "dockyard"));
    const segments = names.filter((name) => name.endsWith(".jsonl"));
    const archiveBytes = (await Promise.all(segments.map((name) => stat(join(root, "dockyard", name)).then((info) => info.size))))
      .reduce((sum, value) => sum + value, 0);
    const size_ = Math.max(1, Math.floor(options.writes / options.buckets));
    const latency = [];
    for (let i = 0; i < options.writes; i += size_) {
      const slice = writeMs.slice(i, i + size_);
      if (slice.length) latency.push({ from: i + 1, to: i + slice.length, median: round(summarize(slice).median) });
    }
    return { writeMs, latency, cpuMs, tokenBytes,
      digests: { tree: digestTree(tree),
        queries: Object.fromEntries(Object.entries(queries).map(([collection, value]) => [collection, `${value.count}:${sha256(JSON.stringify(value.entries))}`])),
        restarted: Object.fromEntries(Object.entries(restarted).map(([collection, value]) => [collection, `${value.count}:${sha256(JSON.stringify(value.entries))}`])) },
      shape: { globalBytes: size, archiveFiles: segments.length, archiveBytes, hotObservations: queries.observations.count, knowledge: queries.knowledge.count } };
  } finally {
    if (port) await port.close();
    await backend.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** Copy the repo lib/ tree twice and revert only the token file operations. */
function deriveTrees(home) {
  const tokenon = join(home, "lib-tokenon");
  const tokenoff = join(home, "lib-tokenoff");
  cpSync(REPO_LIB, tokenon, { recursive: true });
  cpSync(REPO_LIB, tokenoff, { recursive: true });
  const file = join(tokenoff, "domain-storage.js");
  const source = fs.readFileSync(file, "utf8");
  const written = [
    "  const temporary = `${file}.${commitTokenEntropy()}.tmp`;",
    "  fs.writeFileSync(temporary, `${commitTokenEntropy()}\\n`, { mode: 0o600 });",
    "  try { fs.renameSync(temporary, file); }",
    "  catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }",
  ].join("\n");
  // Self-check: if writeCommitToken() changes shape, this variant would silently
  // become "token on vs a slightly different token on" and measure nothing. The
  // match must occur exactly once, so a second write site elsewhere cannot pass.
  if (source.split(written).length - 1 !== 1) {
    throw new Error("writeCommitToken() no longer has the shape this variant reverts; update the stub");
  }
  fs.writeFileSync(file, source.replace(written, [
    "  // Measurement variant: draw the same entropy as the real writer and write no",
    "  // file, so only the token's I/O is removed from the timed path.",
    "  void `${file}.${commitTokenEntropy()}.tmp`;",
    "  void `${commitTokenEntropy()}\\n`;",
  ].join("\n")));
  return { tokenon, tokenoff };
}

const home = await mkdtemp(join(tmpdir(), "dsh-domain-token-ab-"));
try {
  const derived = deriveTrees(home);
  options.tokenon = derived.tokenon;
  options.tokenoff = derived.tokenoff;
  const sources = {};
  const implementations = {};
  for (const side of ["tokenoff", "tokenon"]) {
    const directory = options[side];
    const source = await readFile(join(directory, "domain-storage.js"), "utf8");
    sources[side] = { source: join(directory, "domain-storage.js"), sourceSha256: sha256(source) };
    implementations[side] = (await materializeDomainStorage(source, home, side, join(directory, "domain-storage.js"))).openDomainStorage;
  }
  // The token-on side must be the repository's own bytes, so the digest reported
  // here is the digest of the file this measurement is cited against.
  const repoSourceSha256 = sha256(await readFile(join(REPO_LIB, "domain-storage.js"), "utf8"));
  assert.equal(sources.tokenon.sourceSha256, repoSourceSha256,
    "the measured token-on tree must be a byte copy of the repository lib/");
  emit({ type: "metadata", node: process.version, platform: `${process.platform}/${process.arch}`,
    sources, repoSourceSha256, writes: options.writes, sessions: options.sessions, warmup: options.warmup,
    family: "same tree, token I/O on vs off", comparedSide: "persisted tree minus domain-archive-lock and domain-commit.token",
    clock: `frozen at ${new Date(FROZEN_NOW).toISOString()}`,
    scope: "openDomainStorage over the official DomainFacility/JsonStorageBackend, then public port.observe() per write: stage mirror, memory load, work, commit, archive install, hydrate; fixture reset, assertions, snapshots and hashes are outside the timed interval",
    order: "alternate tokenoff/tokenon order per iteration; both run in the same fixture path; the archive tree, the query projections and the post-restart projections are compared as raw bytes with no masking for every warmup and measured session",
    command: [process.execPath, ...process.argv.slice(1)] });
  const results = { tokenoff: [], tokenon: [] };
  const unfreeze = freezeClock();
  const uuid = freezeUuid();
  try {
    for (let i = 0; i < options.warmup + options.sessions; i += 1) {
      const warmup = i < options.warmup;
      const order = i % 2 === 0 ? ["tokenoff", "tokenon"] : ["tokenon", "tokenoff"];
      const pair = {};
      for (const side of order) pair[side] = await run(implementations[side], home, options, uuid);
      emit({ type: "equivalence", iteration: i + 1, warmup, tokenBytes: { tokenoff: pair.tokenoff.tokenBytes, tokenon: pair.tokenon.tokenBytes },
        digests: { tokenoff: pair.tokenoff.digests, tokenon: pair.tokenon.digests }, shape: pair.tokenon.shape });
      assert.equal(pair.tokenoff.tokenBytes, null, "the token-off side must not write a token");
      assert.ok(pair.tokenon.tokenBytes > 0, "the token-on side must write a token");
      assert.deepEqual(pair.tokenon.digests, pair.tokenoff.digests, `iteration ${i + 1}: every persisted byte outside the token must match`);
      assert.deepEqual(pair.tokenon.shape, pair.tokenoff.shape, `iteration ${i + 1}: persisted shape mismatch`);
      for (const side of order) {
        const result = pair[side];
        const summary = summarize(result.writeMs);
        emit({ type: "sample", implementation: side, iteration: i + 1, warmup, order, sourceSha256: sources[side].sourceSha256,
          totalMs: round(result.writeMs.reduce((sum, value) => sum + value, 0)),
          cpuMs: round(result.cpuMs), cpuPerWriteMs: round(result.cpuMs / options.writes),
          perWriteMedianMs: round(summary.median), perWriteMadMs: round(summary.mad),
          perWriteMinMs: round(summary.min), perWriteMaxMs: round(summary.max),
          latency: result.latency, shape: result.shape, equivalent: true });
        if (!warmup) results[side].push(result);
      }
    }
  } finally { uuid.restore(); unfreeze(); }
  const summary = {};
  for (const side of ["tokenoff", "tokenon"]) {
    const sessions = results[side];
    summary[side] = {
      totalMs: summarize(sessions.map((session) => session.writeMs.reduce((sum, value) => sum + value, 0))),
      cpuMs: summarize(sessions.map((session) => session.cpuMs)),
      perWriteMedianMs: summarize(sessions.flatMap((session) => session.writeMs.map(round))),
      perSessionMedianMs: summarize(sessions.map((session) => summarize(session.writeMs).median)),
      lastBucketMedianMs: summarize(sessions.map((session) => session.latency.at(-1).median)),
    };
  }
  const change = (before, after) => ({ before, after, deltaPercent: before === 0 ? null : round(((after - before) / before) * 100) });
  emit({ type: "summary", writes: options.writes, sessions: options.sessions, warmup: options.warmup, sources, repoSourceSha256, summary, comparison: {
    totalMs: change(summary.tokenoff.totalMs.median, summary.tokenon.totalMs.median),
    cpuMs: change(summary.tokenoff.cpuMs.median, summary.tokenon.cpuMs.median),
    perWriteMedianMs: change(summary.tokenoff.perWriteMedianMs.median, summary.tokenon.perWriteMedianMs.median),
    perSessionMedianMs: change(summary.tokenoff.perSessionMedianMs.median, summary.tokenon.perSessionMedianMs.median),
    lastBucketMedianMs: change(summary.tokenoff.lastBucketMedianMs.median, summary.tokenon.lastBucketMedianMs.median),
  }, equivalent: true });
} finally {
  await rm(home, { recursive: true, force: true });
}
