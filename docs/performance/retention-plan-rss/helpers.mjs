// Real EvolutionMemory -> compact() -> #retentionPlan() A/B benchmark.
// The baseline ref's whole lib/ tree is extracted into a disposable directory;
// --lib adds trees imported as-is (without --lib, compare the baseline ref
// against the working lib/). The default baseline ref is HEAD, which on a
// committed tree compares the implementation against itself: pass the commit
// the change was built on, e.g. `--baseline b7547f8`, to reproduce a gain.
//
// Each scale is TOTAL cold rows: 40% observations (repeated info envelopes with
// no knowledge dimensions, plus repeated error/diagnostic knowledge subjects),
// 20% canonical knowledge accumulators built by HEAD's normalizeKnowledgeEvent
// and mergeKnowledgeEntry, with dimensions + knowledgeKey + sourceRefs,
// 20% observed cycles, 10% FAILED outcomes, 10% REJECTED promotions. Canonical
// pointers protect a subset of outcomes, so both retention and retirement
// occur. No production planning function is copied or privately invoked here.
// Repeated knowledge groups contain at most eight source rows, fitting the
// bounded sourceRefs window so HEAD itself reaches a one-pass fixed point.
//
// node --expose-gc scripts/benchmarks/retention-plan-cost.mjs
//   [--lib <dir>]... [--baseline <ref>] [--scales 2000,10000,40000] [--samples N]
//   [--rounds N] [--warmup N] [--out <path>] [--json]
// Samples are fresh fixtures; setup/load/reconciliation, snapshots, hashing and
// the second compact() fixed-point check are outside the timed interval. The
// write phase includes planning, archive rewrite/readback/index and state save,
// but not the official host domain transaction, fsync or multi-process work.
// Heap/RSS peaks are sampled lower bounds: a timer cannot interrupt synchronous
// planning, and GC may reclaim allocations between observations. They are not
// total allocation counts. resourceUsage maxRSS is a separate process-lifetime
// high-water mark, never presented as a per-sample RSS peak.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { arch, cpus, loadavg, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const REPO = '/Users/ryukeili/.t3/worktrees/dsh-evolution/t3-b59d8ebf';
const NOW = '2026-10-12T00:00:00.000Z';
const ARGS = process.argv.slice(2);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const project = (value) => JSON.parse(JSON.stringify(value));
function firstDifference(actual, expected, path = '$') {
  if (isDeepStrictEqual(actual, expected)) return null;
  if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object') return path;
  for (const key of new Set([...Object.keys(actual), ...Object.keys(expected)])) {
    if (!Object.hasOwn(actual, key) || !Object.hasOwn(expected, key)) return `${path}.${key}`;
    const difference = firstDifference(actual[key], expected[key], `${path}.${key}`);
    if (difference) return difference;
  }
  return path;
}
const equal = (actual, expected, name) => {
  if (!isDeepStrictEqual(actual, expected)) assert.fail(`${name}: first difference ${firstDifference(actual, expected)}`);
};

function parseArgs(args) {
  const options = { libs: [], baseline: 'HEAD', scales: [2000, 10000, 40000], samples: 2, rounds: 2, warmup: 1, out: null, json: false };
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (key === '--json') { options.json = true; continue; }
    if (key === '--help') {
      console.log('Usage: node --expose-gc scripts/benchmarks/retention-plan-cost.mjs [--lib <dir>]... [--baseline <ref>] [--scales 2000,10000,40000] [--samples N] [--rounds N] [--warmup N] [--out <path>] [--json]\nThe baseline ref (default HEAD) is one side; without --lib the working lib/ is the other. Samples are per side, phase and round. Round orders alternate A/B then B/A (A/B/B/A).');
      return null;
    }
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${key}`);
    if (key === '--lib') options.libs.push(resolve(value));
    else if (key === '--baseline') options.baseline = value;
    else if (key === '--scales') options.scales = value.split(',').map(Number);
    else if (['--samples', '--rounds', '--warmup'].includes(key)) options[key.slice(2)] = Number(value);
    else if (key === '--out') options.out = resolve(value);
    else throw new Error(`unknown option ${key}`);
  }
  for (const key of ['samples', 'rounds', 'warmup']) {
    if (!Number.isSafeInteger(options[key]) || options[key] < (key === 'warmup' ? 0 : 1)) throw new Error(`invalid --${key}`);
  }
  if (!options.scales.length || options.scales.some((n) => !Number.isSafeInteger(n) || n < 100)) throw new Error('invalid --scales: expected integers >= 100');
  return options;
}

function freezeClock() {
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return RealDate.parse(NOW); }
  }
  globalThis.Date = FrozenDate;
  return () => { globalThis.Date = RealDate; };
}

async function loadSide(label, directory) {
  const { EvolutionMemory } = await import(pathToFileURL(join(directory, 'dockyard-domain/memory.js')).href);
  assert.equal(typeof EvolutionMemory, 'function', `${label}: missing EvolutionMemory`);
  const files = [];
  async function walk(path, prefix = '') {
    for (const item of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + item.name;
      if (item.isDirectory()) await walk(join(path, item.name), name + '/');
      else if (item.isFile()) files.push({ file: name, sha256: sha256(await readFile(join(path, item.name))) });
      else throw new Error(`${label}: unsupported lib entry ${name}`);
    }
  }
  await walk(directory);
  return { label, directory, EvolutionMemory, treeSha256: sha256(JSON.stringify(files)) };
}

// Build the input ONCE with baseline public functions, then give every side the
// exact same bytes. A variant's knowledge functions must not define its fixture.
function corpus(scale, knowledge) {
  const counts = { observations: Math.floor(scale * 0.4), knowledge: Math.floor(scale * 0.2), cycles: Math.floor(scale * 0.2), outcomes: Math.floor(scale * 0.1) };
  counts.promotions = scale - Object.values(counts).reduce((a, b) => a + b, 0);
  const rows = {};
  rows.observations = Array.from({ length: counts.observations }, (_, i) => i % 2 === 0 ? {
    id: `info-${i}`, type: 'component/observation', severity: 'info', status: 'observed', recordedAt: NOW,
    metrics: { usageCount: i + 1 },
  } : {
    id: `diagnostic-${i}`, type: 'tool/error', severity: 'error', status: 'measured',
    componentId: `plugin:diagnostic-${Math.floor(i / 16)}`, rootCause: 'synthetic retry timeout',
    errorCode: 'BENCH_DIAGNOSTIC', message: 'synthetic diagnostic only', recordedAt: NOW,
  });
  rows.knowledge = Array.from({ length: counts.knowledge }, (_, i) => {
    const source = { id: `seed-${i}`, issueType: 'performance', rootCause: 'synthetic warmup delay',
      strategy: 'bounded retry', componentId: `plugin:seed-${i}`, status: 'success', recordedAt: NOW,
      metrics: { latency: i % 9 + 1 } };
    const event = knowledge.normalizeKnowledgeEvent(source, { sourceCollection: 'observations', now: new Date(NOW) });
    return { ...knowledge.mergeKnowledgeEntry(null, event, { now: new Date(NOW) }), dimensions: event.dimensions };
  });
  rows.cycles = Array.from({ length: counts.cycles }, (_, i) => ({ id: `cycle-${i}`, status: 'observed',
    startedAt: NOW, endedAt: NOW, recordedAt: NOW, observations: [{ id: `info-${i * 2}` }], stages: [{ stage: 'observe' }] }));
  for (const collection of ['outcomes', 'promotions']) rows[collection] = Array.from({ length: counts[collection] }, (_, i) => ({
    id: `${collection}-${i}`, status: collection === 'outcomes' ? 'failed' : 'rejected',
    lifecycleState: collection === 'outcomes' ? 'FAILED' : 'REJECTED',
    componentId: `plugin:${collection}-${Math.floor(i / 8)}`, rootCause: 'synthetic terminal failure', recordedAt: NOW,
  }));
  // Protect outcomes only: hot terminal promotions are separately tombstoned by
  // housekeeping even when a canonical pointer exists, outside retention's
  // protection rule. That corpus is not a one-pass compact fixed point in HEAD.
  const canonical = ['outcomes'].flatMap((collection) => rows[collection].filter((_, i) => i % 16 === 0).map((row, i) => ({
    id: `canonical-${row.id}`, state: 'CANONICAL', lifecycleState: 'CANONICAL', sourceCollection: collection,
    capability: `protected:${collection}-${i}`, recordId: row.id, fitnessScore: 1, updatedAt: NOW,
  })));
  return { counts, canonical, files: Object.fromEntries(Object.entries(rows).map(([name, values]) =>
    [name, values.map((row) => JSON.stringify(row)).join('\n') + '\n'])) };
}

// A minimal real file-backed state port; all retention/archive logic remains
// inside the imported EvolutionMemory. No official host transaction is timed.
async function session(side, root, fixture) {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const filePath = join(root, 'state.json');
  await writeFile(filePath, JSON.stringify({ evolution: { canonical: fixture.canonical } }));
  for (const [collection, bytes] of Object.entries(fixture.files)) await writeFile(`${filePath}.${collection}-archive.jsonl`, bytes);
  const store = {
    filePath,
    async load() { return JSON.parse(await readFile(filePath, 'utf8')); },
    async update(change) {
      await writeFile(filePath + '.tmp', JSON.stringify(change(await this.load())));
      await rename(filePath + '.tmp', filePath);
    },
  };
  const memory = new side.EvolutionMemory({ stateStore: store, clock: () => new Date(NOW),
    maxEntries: 1000, hotEntries: 50, hotCycles: 50, archiveMaxBytes: 256 * 1024,
    mutationAuthority: { assertMutation() {} } });
  await memory.load();
  return memory;
}

async function archiveTree(root) {
  const files = [];
  async function walk(path, prefix = '') {
    for (const item of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + item.name;
      if (item.isDirectory()) await walk(join(path, item.name), name + '/');
      else if (name !== 'state.json') {
        const bytes = await readFile(join(path, item.name));
        files.push({ file: name, bytes: bytes.length, sha256: sha256(bytes) });
      }
    }
  }
  await walk(root);
  return files;
}

async function measure(memory, dryRun) {
  global.gc();
  const baseline = process.memoryUsage();
  let peakHeap = baseline.heapUsed;
  let peakRss = baseline.rss;
  const sampleMemory = () => {
    const usage = process.memoryUsage();
    peakHeap = Math.max(peakHeap, usage.heapUsed);
    peakRss = Math.max(peakRss, usage.rss);
  };
  const timer = setInterval(sampleMemory, 2);
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  let report, wallMs, cpu;
  try {
    report = await memory.compact(dryRun ? { dryRun: true } : {});
    wallMs = performance.now() - start;
    cpu = process.cpuUsage(cpuStart);
    sampleMemory();
  } finally { clearInterval(timer); }
  return { report: project(report), metrics: { wallMs, cpuUserMs: cpu.user / 1000,
    cpuSystemMs: cpu.system / 1000, cpuTotalMs: (cpu.user + cpu.system) / 1000,
    heapBaselineBytes: baseline.heapUsed, peakSampledHeapBytes: peakHeap,
    heapAllocationDeltaBytes: peakHeap - baseline.heapUsed, peakSampledRssBytes: peakRss,
    processLifetimeMaxRssBytes: process.resourceUsage().maxRSS * 1024 } };
}

async function run(side, root, fixture, phase, name) {
  const memory = await session(side, root, fixture);
  const beforeState = project(memory.fullSnapshot());
  const beforeArchive = await archiveTree(root);
  const { report, metrics } = await measure(memory, phase === 'dryRun');
  const state = project(memory.fullSnapshot());
  const archive = await archiveTree(root);
  if (phase === 'dryRun') {
    equal(state, beforeState, `${name}/dry-run-state-unchanged`);
    equal(archive, beforeArchive, `${name}/dry-run-archive-unchanged`);
    return { report, state, archive, metrics };
  }
  const secondReport = project(await memory.compact());
  equal(project(memory.fullSnapshot()), state, `${name}/idempotency-state`);
  equal(await archiveTree(root), archive, `${name}/idempotency-archive`);
  equal(JSON.parse(await readFile(join(root, 'state.json'), 'utf8')).evolution, project(memory.snapshot()), `${name}/persisted-hot-state`);
  return { report, secondReport, state, archive, metrics };
}

function compare(actual, expected, name) {
  for (const field of ['report', 'state', 'archive', 'secondReport']) equal(actual[field], expected[field], `${name}/equivalence-${field}`);
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function summary(samples) {
  return Object.fromEntries(Object.keys(samples[0].metrics).map((key) => [key, median(samples.map((sample) => sample.metrics[key]))]));
}


export {corpus, session, freezeClock, measure};
