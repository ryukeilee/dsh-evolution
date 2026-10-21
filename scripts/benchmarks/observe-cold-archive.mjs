// End-to-end A/B benchmark of one public `port.observe()` write over a
// non-empty cold observations archive, against the pinned pre-change
// implementation.
//
// This is the production transaction: `openDomainStorage()` over the official
// `DomainFacility` + `JsonStorageBackend`, then one `port.observe()` call that
// stages, commits and hydrates the archive transaction. The fixture only seeds
// the cold archive and the empty event log; fixture construction is not timed.
//
// The baseline is the pinned release artifact extracted into a temporary
// directory (with this repository's `node_modules` linked so its `zod` import
// resolves) and imported as-is. Each side asserts the other persisted the same
// tree before its timings are reported.
//
//   node scripts/benchmarks/observe-cold-archive.mjs [--rows N] [--knowledge-rows N] [--rounds N] [--warmup N] [--samples N] [--json] [--variant <lib-dir>]...
//   [--baseline <lib-dir>] [--workload repeat|cold-hit|evict] [--attribute]
//   [--retained --memory-side baseline|candidate] (requires --expose-gc)
//
// `--variant` adds another implementation tree to the same run, compared against
// the same pinned baseline in the same alternating schedule; every side must
// persist a byte-identical tree or the run fails. It is how one change is
// attributed end to end: a variant tree that carries only that change separates
// its contribution from the combined one. The variant is read in place; no
// working-tree file is replaced.
//
// `--knowledge-rows` additionally seeds a cold knowledge archive, which is the
// state a long-running host is actually in: every append resolves a canonical
// knowledge row as well as scanning the source collection.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { cpus, loadavg, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { JsonStorageBackend } from "@deepseek-ai/dsh-storage-json";
import { openDomainStorage as candidateOpen, evolutionDomainSpec } from "../../lib/domain-storage.js";
import { canonicalKnowledgeKey } from "../../lib/dockyard-domain/knowledge.js";
import { readReleaseManifest, releaseArtifactPath, REPO_ROOT } from "../release/release-lib.mjs";

const FROZEN_NOW = Date.parse("2026-10-12T00:00:00.000Z");
const NOW = new Date(FROZEN_NOW).toISOString();
const TARGET = "plugin:edge-cache";
let uuidSequence = 0;
const realUUID = crypto.randomUUID;
const originalRead = fs.readFileSync, originalAsyncRead = fsp.readFile, originalParse = JSON.parse, originalHash = crypto.hash;
const counts = { readBytes: 0, archiveRowsParsed: 0, identityHashes: 0 };
function accountRead(file, value) {
  if (String(file).includes("-archive.jsonl")) counts.readBytes += Buffer.byteLength(value);
  return value;
}
function startAccounting() {
  fs.readFileSync = (...args) => accountRead(args[0], originalRead(...args));
  fsp.readFile = async (...args) => accountRead(args[0], await originalAsyncRead(...args));
  JSON.parse = (...args) => {
    const value = originalParse(...args);
    if (value && /^obs-|^key-/.test(value.id ?? "")) counts.archiveRowsParsed++;
    return value;
  };
  crypto.hash = (...args) => {
    if (typeof args[1] === "string" && args[1].startsWith('{"failureMode":')) counts.identityHashes++;
    return originalHash(...args);
  };
  syncBuiltinESMExports();
}
crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, "0")}`;
syncBuiltinESMExports();
// The recall query is the production shape: the explicit proposal's own target.
// `--op recall` seeds one row carrying the key this query resolves, at the head
// of the archive, so an exact-key hit that sits outside the collector's 2,000
// row window is exercised too.
const RECALL_INPUT = { why: "edge cache warmup latency", target: TARGET, impactScope: ["runtime"], successMetrics: ["p95 latency decreases"] };
const RECALL_KEY_TARGET = "plugin:knowledge-exact";
const RECALL_INPUT_EXACT = { why: "warmup latency regression", target: RECALL_KEY_TARGET };

/** Freeze the clock so two runs persist byte-comparable trees. */
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

function parseArgs(argv) {
  const options = { rows: 10000, knowledgeRows: 0, hotRows: 0, rounds: 3, warmup: 1, samples: 5, json: false, retained: false, attribute: false, variants: [], op: "observe", workload: "repeat" };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--json") { options.json = true; continue; }
    if (key === "--retained") { options.retained = true; continue; }
    if (key === "--attribute") { options.attribute = true; continue; }
    const value = argv[index + 1];
    index += 1;
    if (key === "--rows") options.rows = Number(value);
    else if (key === "--knowledge-rows") options.knowledgeRows = Number(value);
    else if (key === "--hot-rows") options.hotRows = Number(value);
    else if (key === "--rounds") options.rounds = Number(value);
    else if (key === "--warmup") options.warmup = Number(value);
    else if (key === "--samples") options.samples = Number(value);
    else if (key === "--baseline") options.baseline = resolve(value);
    else if (key === "--memory-side") {
      if (!["baseline", "candidate"].includes(value)) throw new Error(`unknown memory side ${value}`);
      options.memorySide = value;
    }
    else if (key === "--workload") {
      if (!["repeat", "cold-hit", "evict"].includes(value)) throw new Error(`unknown workload ${value}`);
      options.workload = value;
    }
    else if (key === "--op") {
      if (value !== "observe" && value !== "recall") throw new Error(`unknown op ${value}`);
      options.op = value;
    } else if (key === "--variant") options.variants.push(resolve(value));
    else throw new Error(`unknown option ${key}`);
  }
  return options;
}

/** A variant is a `lib/` directory; its port is imported exactly like the working tree's. */
async function loadVariant(directory) {
  const module = await import(pathToFileURL(join(directory, "domain-storage.js")).href);
  assert.equal(typeof module.openDomainStorage, "function", `${directory} must export openDomainStorage`);
  return { directory, openDomainStorage: module.openDomainStorage };
}

async function loadBaseline() {
  const pin = readReleaseManifest();
  const directory = await mkdtemp(join(tmpdir(), "dsh-observe-baseline-"));
  execFileSync("tar", ["-xzf", releaseArtifactPath(pin), "-C", directory, "package/lib"], { stdio: "ignore" });
  await symlink(join(REPO_ROOT, "node_modules"), join(directory, "package/node_modules"), "dir");
  const module = await import(pathToFileURL(join(directory, "package/lib/domain-storage.js")).href);
  return { pin, directory, openDomainStorage: module.openDomainStorage };
}

function observationRow(index) {
  const scope = `plugin:module-${index}`;
  return {
    id: `obs-${index}`,
    knowledgeKey: `knowledge:${String(index).padStart(32, "b")}`,
    type: "tool/error", code: "HOST_OPERATION_FAILED", message: `official operation failed (${index})`,
    componentId: scope, severity: "error", status: "failed",
    problem: `${scope} warmup latency regression observed after a retry policy change`,
    target: scope, capabilityId: scope, metrics: { latency: 12 },
    recordedAt: new Date(Date.parse(NOW) - index * 3_600_000).toISOString(),
  };
}

/** Canonical knowledge rows, so the write also has a subject to resolve in the knowledge archive. */
function knowledgeRow(index) {
  const scope = `plugin:knowledge-${index}`;
  const seen = new Date(Date.parse(NOW) - index * 3_600_000).toISOString();
  const effectStats = { successCount: (index % 7) + 1, failureCount: index % 3, neutralCount: 0, regressionCount: 0, fitnessCount: 2, fitnessSum: 1.4, fitnessMean: 0.7, bestFitness: 0.8, worstFitness: 0.6, successRate: 0.6, metrics: {} };
  return {
    id: `key-${index}`,
    knowledgeKey: `knowledge:${String(index).padStart(32, "a")}`,
    schema: 1, canonical: true, retention: "CANONICAL_KNOWLEDGE",
    state: index % 2 ? "KNOWN" : "LEARNING",
    issueType: "performance", problemType: "latency",
    rootCause: `candidate warmup race in ${scope} pipeline`,
    strategy: JSON.stringify({ target: scope, capability: scope, retries: (index % 4) + 1 }),
    failureMode: index % 3 === 0 ? "network-error" : "timeout",
    semanticFact: `${scope} warmup latency regression observed after a retry policy change`,
    scope,
    count: (index % 9) + 1, occurrenceCount: (index % 9) + 1,
    firstSeen: seen, lastSeen: seen,
    lastSourceCollection: "observations", lastStatus: "measured", lastOutcome: index % 5 === 0 ? "failure" : "success",
    sourceCounts: { observations: (index % 9) + 1 },
    sourceRefs: [`observations:obs-${index}-a`, `journal:j-${index}-b`],
    lineageRefs: [], relationRefs: [], eventIds: [`event-${index}`],
    evidenceCount: (index % 9) + 1,
    recentEvidence: [{ source: "observations", id: `obs-${index}`, at: seen, outcome: "success", status: "measured", digest: `d${index}` }],
    confidence: 0.6, effectStats, effects: effectStats,
    successCount: (index % 7) + 1, failureCount: index % 3, successRate: 0.6, fitnessMean: 0.7, regressionCount: 0,
    trend: { window: 8, recent: [{ at: seen, outcome: "success", confidence: 0.6, regression: false }], lastOutcome: "success", direction: "stable", failureRate: 0.3, successRate: 0.6, regressionCount: 0 },
    learned: true, updatedAt: seen,
  };
}

/** One knowledge row whose stored key is the key `RECALL_INPUT_EXACT` resolves,
 *  placed at the head of the archive so the collector's exact-key path has to
 *  reach past its `maxConsidered` window. Written by hand (not by the memory
 *  layer) so both sides read identical bytes. */
function exactHitRow() {
  const key = canonicalKnowledgeKey({ problem: RECALL_KEY_TARGET, target: RECALL_KEY_TARGET, capabilityId: RECALL_KEY_TARGET });
  assert.match(String(key), /^knowledge:[0-9a-f]{32}$/, "the exact-hit fixture key must be a canonical knowledge key");
  return {
    id: "key-exact",
    knowledgeKey: key,
    schema: 1, canonical: true, retention: "CANONICAL_KNOWLEDGE", state: "RESOLVED",
    issueType: "performance", problemType: "latency",
    rootCause: "candidate warmup race in the pooled client",
    strategy: "reuse the pooled client",
    failureMode: "timeout",
    semanticFact: RECALL_KEY_TARGET,
    scope: RECALL_KEY_TARGET,
    count: 5, occurrenceCount: 5,
    firstSeen: NOW, lastSeen: NOW,
    lastSourceCollection: "observations", lastStatus: "resolved", lastOutcome: "success",
    sourceCounts: { observations: 5 },
    sourceRefs: ["observations:obs-exact"],
    lineageRefs: [], relationRefs: [], eventIds: ["event-exact"],
    evidenceCount: 5,
    recentEvidence: [{ source: "observations", id: "obs-exact", at: NOW, outcome: "success", status: "resolved", digest: "dexact" }],
    confidence: 0.7,
    effectStats: { successCount: 4, failureCount: 1, successRate: 0.8, fitnessMean: 0.7, metrics: {} },
    successCount: 4, failureCount: 1, successRate: 0.8, fitnessMean: 0.7, regressionCount: 0,
    learned: true, updatedAt: NOW,
  };
}

async function session(openDomainStorage, rows, knowledgeRows = [], op = "observe", hotRows = [], workload = "repeat") {
  uuidSequence = 0;
  const root = await mkdtemp(join(tmpdir(), "dsh-observe-bench-"));
  const backend = new JsonStorageBackend(join(root, "official"));
  const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: "json" });
  const domain = await ctx.storageDomain.open(evolutionDomainSpec);
  // Hot rows are the instance's own hot knowledge window; they live in the
  // aggregate, not in an archive file, so a recall over a long-running host
  // reads a mixed hot+cold view exactly as this fixture does.
  const aggregate = hotRows.length ? { evolution: { schema: 4, knowledge: hotRows } } : {};
  await domain.global.set({ schema: 1, aggregate, applied: {}, pending: null });
  await domain.close();
  const dockyard = join(root, "dockyard");
  await mkdir(dockyard, { recursive: true });
  if (rows.length) await writeFile(join(dockyard, "state.json.observations-archive.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  if (knowledgeRows.length) {
    await writeFile(join(dockyard, "state.json.knowledge-archive.jsonl"), knowledgeRows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  }
  const eventLog = join(root, "events.jsonl");
  await writeFile(eventLog, "");
  const port = await openDomainStorage(ctx, { presetDir: root, eventBridgePath: eventLog, eventBridgeKey: "b".repeat(64) });
  let count = 0;
  const tree = async () => {
    const contents = [];
    const walk = async (directory, prefix = "") => {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const relative = prefix + entry.name;
        if (entry.isDirectory()) await walk(join(directory, entry.name), relative + "/");
        else contents.push(`${relative}\n${(await readFile(join(directory, entry.name), "utf8")).split(root).join("<root>")}`);
      }
    };
    await walk(dockyard);
    if (workload === "cold-hit") {
      const cold = (await readFile(join(dockyard, "state.json.knowledge-archive.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.ok(cold.some((row) => row.knowledgeKey === knowledgeRows[0].knowledgeKey && row.count > knowledgeRows[0].count), "cold-hit must update an archived accumulator");
    }
    // Include the real durable aggregate, not only the derived archive tree.
    const durable = await readFile(join(root, "official", "evolution_domain.json"), "utf8");
    return durable.split(root).join("<root>") + "\n" + contents.join("\n---\n");
  };
  let recallOutput = null;
  const observedOutput = [];
  return {
    bytes: rows.length,
    async run() {
      if (op === "recall") {
        // Both reads are the public port: the windowed query, and the exact-key
        // query that has to reach past the window.
        recallOutput = JSON.stringify({ window: port.recall(RECALL_INPUT, {}), exact: port.recall(RECALL_INPUT_EXACT, {}) });
        return;
      }
      count += 1;
      observedOutput.push(await port.observe({ code: "HOST_OPERATION_FAILED", target: workload === "evict" ? `${TARGET}-${String.fromCharCode(97 + count % 26)}-${String.fromCharCode(97 + Math.floor(count / 26))}` : TARGET }));
    },
    tree,
    output: () => op === "recall" ? recallOutput : JSON.stringify(observedOutput),
    async dispose() { await port.close(); await backend.close(); await rm(root, { recursive: true, force: true }); },
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function timeSession(openDomainStorage, rows, options, knowledgeRows, hotRows) {
  if (options.retained) globalThis.gc();
  const before = options.retained ? process.memoryUsage() : null;
  const current = await session(openDomainStorage, rows, knowledgeRows, options.op, hotRows, options.workload);
  try {
    for (let index = 0; index < options.warmup; index += 1) await current.run();
    const samples = [];
    for (let index = 0; index < options.samples; index += 1) {
      for (const key of Object.keys(counts)) counts[key] = 0;
      const cpu = process.cpuUsage();
      const start = performance.now();
      await current.run();
      const wallMs = performance.now() - start;
      const used = process.cpuUsage(cpu);
      samples.push({ wallMs, cpuMs: (used.user + used.system) / 1000, ...(options.attribute ? { ...counts } : {}) });
    }
    if (options.retained) globalThis.gc();
    const after = options.retained ? process.memoryUsage() : null;
    const retained = after ? { heapBytes: after.heapUsed - before.heapUsed, rssBytes: after.rss, rssDeltaBytes: after.rss - before.rss } : null;
    return { samples, retained, tree: await current.tree(), output: current.output() };
  } finally {
    await current.dispose();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.attribute) startAccounting();
  const restoreClock = freezeClock();
  if (options.retained && !globalThis.gc) throw new Error("--retained requires --expose-gc");
  if (options.memorySide && (!options.retained || options.rounds !== 1 || options.variants.length)) throw new Error("--memory-side requires --retained --rounds 1 and no variants");
  const baseline = options.baseline ? await loadVariant(options.baseline) : await loadBaseline();
  const variants = [];
  for (const directory of options.variants) variants.push(await loadVariant(directory));
  const sides = { baseline: baseline.openDomainStorage, candidate: candidateOpen };
  for (const [index, variant] of variants.entries()) sides[`variant${index + 1}`] = variant.openDomainStorage;
  const rows = Array.from({ length: options.rows }, (_, index) => observationRow(index));
  const knowledgeRows = Array.from({ length: options.knowledgeRows }, (_, index) => knowledgeRow(index));
  if (options.workload === "cold-hit") {
    // Same projected and normalized shape as port.observe; a cold accumulator
    // update changes the file on every call and must invalidate inherited reads.
    const { EvolutionObservationStore } = await import("../../lib/dockyard-domain/observation.js");
    const { projectObservation } = await import("../../lib/domain-storage.js");
    let normalized;
    const store = new EvolutionObservationStore({ memory: { recordObservation: async (row) => { normalized = row; return row; }, recordKnowledgeEvent() {}, snapshot: () => ({ observations: [] }) } });
    await store.record(projectObservation({ target: TARGET, code: "HOST_OPERATION_FAILED" }));
    const key = canonicalKnowledgeKey(normalized);
    knowledgeRows.unshift({ ...knowledgeRow(-1), id: key, knowledgeKey: key });
    uuidSequence = 0;
  }
  const hotRows = Array.from({ length: options.hotRows }, (_, index) => ({ ...knowledgeRow(options.knowledgeRows + index), id: `hot-${index}`, knowledgeKey: `knowledge:${String(index).padStart(32, "c")}` }));
  const exactRow = options.op === "recall" ? exactHitRow() : null;
  if (exactRow) knowledgeRows.unshift(exactRow);
  const sourceHashes = async (directory) => Object.fromEntries(await Promise.all(["domain-storage.js", "dockyard-domain/memory.js"].map(async (file) => [file, crypto.createHash("sha256").update(await readFile(join(directory, file))).digest("hex")])));
  const sources = { baseline: await sourceHashes(baseline.pin ? join(baseline.directory, "package/lib") : options.baseline), candidate: await sourceHashes(join(REPO_ROOT, "lib")) };
  for (const [index, variant] of variants.entries()) sources[`variant${index + 1}`] = await sourceHashes(variant.directory);
  const report = { node: process.version, platform: `${process.platform}/${process.arch}`, machine: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalmem: totalmem(), loadavg: loadavg() }, baseline: baseline.pin ? { version: baseline.pin.version, sha256: baseline.pin.sha256 } : { directory: options.baseline }, sources, op: options.op, workload: options.workload, rows: rows.length, knowledgeRows: knowledgeRows.length, hotRows: options.hotRows, rounds: options.rounds, warmup: options.warmup, samples: options.samples, retained: options.retained, attribution: options.attribute, variants: variants.map((variant) => variant.directory), roundsDetail: [] };
  try {
    for (let round = 0; round < options.rounds; round += 1) {
      // The baseline opens and closes every round while the other sides rotate
      // through the remaining positions, so no side keeps a fixed slot.
      const order = options.memorySide ? [options.memorySide] : ["baseline", "candidate", ...variants.map((_variant, index) => `variant${index + 1}`)];
      const rotation = round % order.length;
      const schedule = [...order.slice(rotation), ...order.slice(0, rotation)];
      const result = {};
      for (const side of schedule) result[side] = await timeSession(sides[side], rows, options, knowledgeRows, hotRows);
      for (const [side, value] of Object.entries(result)) {
        if (options.memorySide) continue; // Isolated memory run; equivalence is checked by paired runs.
        assert.equal(value.tree, result.baseline.tree, `the ${side} implementation did not persist the same tree`);
        assert.equal(value.output, result.baseline.output, `the ${side} implementation did not return the same records`);
        if (options.op === "recall") {
          // The recall answer itself is the equivalence proof: same records, same
          // order, same coverage/exact/score, same window and exact-key counts.
          assert.equal(value.output, result.baseline.output, `the ${side} implementation did not return the same recall records`);
          if (exactRow) {
            const exact = JSON.parse(value.output).exact;
            assert.ok(exact.records.some((record) => record.key === exactRow.knowledgeKey && record.exact === true),
              `the ${side} implementation lost the exact-key hit outside the window`);
          }
        }
      }
      report.roundsDetail.push({ order: schedule, ...Object.fromEntries(Object.entries(result).map(([side, value]) => [side, value.samples])), ...(options.retained ? { memory: Object.fromEntries(Object.entries(result).map(([side, value]) => [side, value.retained])) } : {}) });
    }
  } finally {
    restoreClock();
    if (baseline.pin) await rm(baseline.directory, { recursive: true, force: true });
  }
  if (options.memorySide) {
    report.memoryScope = "one side, one session, fresh process; GC before fixture construction and after writes; sampled RSS after GC, not peak RSS";
    report.memorySide = options.memorySide;
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const sideMedian = (side, key) => median(report.roundsDetail.map((round) => median(round[side].map((sample) => sample[key]))));
  report.baselineWallMs = sideMedian("baseline", "wallMs");
  report.candidateWallMs = sideMedian("candidate", "wallMs");
  report.baselineCpuMs = sideMedian("baseline", "cpuMs");
  report.candidateCpuMs = sideMedian("candidate", "cpuMs");
  report.delta = {
    wallPct: ((report.candidateWallMs - report.baselineWallMs) / report.baselineWallMs) * 100,
    cpuPct: ((report.candidateCpuMs - report.baselineCpuMs) / report.baselineCpuMs) * 100,
  };
  report.variantResults = variants.map((variant, index) => {
    const side = `variant${index + 1}`;
    const wallMs = sideMedian(side, "wallMs");
    const cpuMs = sideMedian(side, "cpuMs");
    return { directory: variant.directory, wallMs, cpuMs,
      wallPct: ((wallMs - report.baselineWallMs) / report.baselineWallMs) * 100,
      cpuPct: ((cpuMs - report.baselineCpuMs) / report.baselineCpuMs) * 100 };
  });
  if (options.json) { console.log(JSON.stringify(report, null, 2)); return; }
  const label = options.op === "recall" ? "port.recall() x2 (window + exact)" : "port.observe()";
  console.log(`node ${report.node} ${report.platform} | baseline ${report.baseline.version ?? report.baseline.directory} | cold rows ${report.rows} (+${report.knowledgeRows} knowledge, ${report.hotRows} hot, ${((rows.map((row) => JSON.stringify(row)).join("\n").length + knowledgeRows.map((row) => JSON.stringify(row)).join("\n").length) / 1024 / 1024).toFixed(2)} MiB)`);
  console.log(`${label} wall  ${report.baselineWallMs.toFixed(2)} -> ${report.candidateWallMs.toFixed(2)} ms (${report.delta.wallPct.toFixed(2)}%)`);
  console.log(`${label} cpu   ${report.baselineCpuMs.toFixed(2)} -> ${report.candidateCpuMs.toFixed(2)} ms (${report.delta.cpuPct.toFixed(2)}%)`);
  for (const variant of report.variantResults) {
    console.log(`variant ${variant.directory}\n  wall ${variant.wallMs.toFixed(2)} ms (${variant.wallPct.toFixed(2)}%)  cpu ${variant.cpuMs.toFixed(2)} ms (${variant.cpuPct.toFixed(2)}%)`);
  }
}

try { await main(); } finally {
  crypto.randomUUID = realUUID; crypto.hash = originalHash;
  fs.readFileSync = originalRead; fsp.readFile = originalAsyncRead; JSON.parse = originalParse;
  syncBuiltinESMExports();
}
