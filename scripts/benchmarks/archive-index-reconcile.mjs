// Public-path benchmark: load() reconciles an active archive; compact() rewrites
// it and invokes #writeArchiveIndex. Compact timings include retention and I/O.
// Baseline source: archiveIndexBaseline() in test/dockyard-domain/archive-index-baseline.js.
// Write its source to an os.tmpdir() file, then alternate these commands:
// node scripts/benchmarks/archive-index-reconcile.mjs --memory <baseline-file>
// node scripts/benchmarks/archive-index-reconcile.mjs
// --memory uses the snapshot's source with this repository's imports;
// it never replaces working-tree files or stashes user changes.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JsonStateStore } from "../../test/dockyard-domain/support.js";

const args = process.argv.slice(2);
const options = { rows: 20000, runs: 5, warmup: 1, memory: fileURLToPath(new URL("../../lib/dockyard-domain/memory.js", import.meta.url)) };
for (let i = 0; i < args.length; i += 2) {
  const name = args[i].slice(2);
  if (!args[i].startsWith("--") || !Object.hasOwn(options, name) || args[i + 1] === undefined) throw new Error(`Unknown/missing option: ${args[i]}`);
  options[name] = name === "memory" ? resolve(args[i + 1]) : Number(args[i + 1]);
}
for (const name of ["rows", "runs", "warmup"]) {
  if (!Number.isSafeInteger(options[name]) || options[name] < (name === "warmup" ? 0 : 1)) throw new Error(`Invalid --${name}`);
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
function summarize(samples) {
  const middle = median(samples);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return { medianMs: middle, madMs: median(samples.map((value) => Math.abs(value - middle))),
    stddevMs: Math.sqrt(samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length),
    minMs: Math.min(...samples), maxMs: Math.max(...samples) };
}

const home = await mkdtemp(join(tmpdir(), "dsh-archive-benchmark-"));
try {
  const source = await readFile(options.memory, "utf8");
  const dependencyBase = new URL("../../lib/dockyard-domain/memory.js", import.meta.url);
  const modulePath = join(home, "memory.mjs");
  await writeFile(modulePath, source.replace(/from (["'])(\.\.?\/[^"']+)\1/g,
    (_match, quote, specifier) => `from ${quote}${new URL(specifier, dependencyBase).href}${quote}`));
  const { EvolutionMemory } = await import(pathToFileURL(modulePath).href);
  const store = new JsonStateStore({ home });
  const archive = `${store.filePath}.journal-archive.jsonl`;
  const raw = Array.from({ length: options.rows }, (_, i) => JSON.stringify({
    id: `bench-${i}`, recordedAt: "2026-10-12T00:00:00.000Z", eventType: "benchmark", details: "x".repeat(64),
  })).join("\n") + '\n{invalid}\n   \n{"torn":\n';
  await mkdir(dirname(archive), { recursive: true });
  const memoryOptions = { stateStore: store, clock: () => new Date("2026-10-12T00:00:00.000Z"),
    hotEntries: 1, archiveMaxBytes: Buffer.byteLength(raw) * 2, absoluteMaxSegmentBytes: Buffer.byteLength(raw) * 2 };
  console.log(JSON.stringify({ node: process.version, source: options.memory, sourceSha256: createHash("sha256").update(source).digest("hex"),
    rows: options.rows, bytes: Buffer.byteLength(raw), runs: options.runs, warmup: options.warmup,
    scope: "load=reconcile; compact=public compact including #writeArchiveIndex, retention, archive I/O and save" }));
  const results = { load: [], compact: [] };
  for (let i = 0; i < options.warmup + options.runs; i += 1) {
    // Recreate the identical recovery surface outside each timed interval.
    await rm(store.filePath, { force: true });
    await rm(`${store.filePath}.evolution-archive-index.json`, { force: true });
    await writeFile(archive, raw);
    const memory = new EvolutionMemory(memoryOptions);
    memory.setMutationAuthority({ assertMutation() {}, isActive: () => true });
    const start = performance.now();
    await memory.load();
    const loaded = performance.now();
    await memory.compact();
    const compacted = performance.now();
    const sample = { iteration: i + 1, warmup: i < options.warmup, loadMs: loaded - start, compactMs: compacted - loaded };
    console.log(JSON.stringify(sample));
    if (!sample.warmup) { results.load.push(sample.loadMs); results.compact.push(sample.compactMs); }
    const document = JSON.parse(await readFile(`${store.filePath}.evolution-archive-index.json`, "utf8"));
    const active = document.segments.find((entry) => entry.collection === "journal" && !entry.sealed);
    if (document.segments.length !== 1 || active?.logicalCount !== options.rows - 1 || active.physicalCount !== options.rows - 1) throw new Error("Benchmark did not exercise a large active index rebuild");
  }
  console.log(JSON.stringify({ summary: { load: summarize(results.load), compact: summarize(results.compact) } }));
} finally { await rm(home, { recursive: true, force: true }); }
