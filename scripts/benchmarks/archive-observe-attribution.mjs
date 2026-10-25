// Read-only attribution of one `port.observe()` on the archive transaction.
//
// This script is diagnosis, not a benefit measurement. It runs the same fixture
// as `domain-archive.mjs` (the real official `DomainFacility` +
// `JsonStorageBackend` through `openDomainStorage`, synthetic temp data) and
// counts and times filesystem calls per samples, attributing every call to the
// innermost repository frame that issued it. Nothing is skipped and no
// production code is patched, so the wall clock is also usable as a baseline
// reading; the per-caller shares are attribution only.
//
//   node --max-old-space-size=4096 scripts/benchmarks/archive-observe-attribution.mjs \
//     [--segments N] [--segment-bytes N] [--samples N] [--warm-writes N] [--expect-lib-sha256 H ...]
//
// `--warm-writes` runs that many extra observes before the measured ones. It is
// how the shapes differ: without it the transaction changes no archive file, so
// the stage publishes nothing and no file is fsynced; with enough warm writes the
// built-in hot window overflows and each measured observe appends to an active
// archive, which is the shape that runs `syncStage()` and `installArchiveFiles()`.
//
// Attribution only. Wrapping every fs call captures a stack per call, which is
// far more expensive than the call itself, so the wall clock here is inflated
// (about +9% on the 256-segment shape) and must not be quoted as a baseline
// reading. `domain-archive.mjs` is the uninstrumented baseline for that shape.
// The call counts and the per-caller split are what this script is for.
//
// `--expect-lib-sha256` pins the `lib/` tree this run is allowed to describe:
// the combined SHA-256 of the sorted per-file digest list (the same value the
// benchmark prints as `libTreeSha256`). A run whose tree does not match fails
// instead of producing numbers for source nobody can reproduce.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openDomainStorage } from '../../lib/domain-storage.js';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const repeated = name => {
  const out = [];
  for (let index = 0; index < args.length; index++) if (args[index] === `--${name}`) out.push(args[index + 1]);
  return out;
};
const segments = Number(option('segments', 256));
const segmentBytes = Math.max(16, Number(option('segment-bytes', 1024)));
const samples = Number(option('samples', 7));
const warmWrites = Number(option('warm-writes', 0));
const expectedTrees = repeated('expect-lib-sha256');

function libTreeSha256() {
  const files = [];
  const walk = (directory, prefix) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (fs.lstatSync(absolute).isDirectory()) { walk(absolute, relative); continue; }
      if (relative.endsWith('.js')) files.push([relative, createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')]);
    }
  };
  walk(path.join(REPO_ROOT, 'lib'), '');
  files.sort((left, right) => (left[0] < right[0] ? -1 : 1));
  return createHash('sha256').update(files.map(([name, digest]) => `${digest}  ./${name}\n`).join('')).digest('hex');
}

const libTree = libTreeSha256();
if (expectedTrees.length && !expectedTrees.includes(libTree)) {
  throw new Error(`lib/ tree is ${libTree}, expected one of ${expectedTrees.join(', ')}`);
}

// Attribution wrapper. The caller is the innermost stack frame that belongs to
// this repository, with `node:internal` frames skipped, so native `link`/`rm`
// calls land on the module that issued them.
const CALLERS = new Map();
const COST = new Map();
const local = frame => frame.startsWith(REPO_ROOT) && !frame.includes('/node_modules/');
function callerOf() {
  const stack = new Error().stack.split('\n').slice(3);
  for (const line of stack) {
    const match = /((?:file:\/\/)?\/[^):]+):(\d+):(\d+)/.exec(line);
    if (!match) continue;
    const file = match[1].replace(/^file:\/\//, '');
    if (!local(file)) continue;
    return `${path.relative(REPO_ROOT, file).replace(/^lib\//, 'lib/')}:${match[2]}`;
  }
  return '(unknown)';
}
const TRACKED = ['readdirSync', 'lstatSync', 'statSync', 'readFileSync', 'openSync', 'linkSync',
  'renameSync', 'unlinkSync', 'rmSync', 'mkdirSync', 'writeFileSync', 'fsyncSync', 'closeSync'];
const originals = new Map();
for (const name of TRACKED) {
  originals.set(name, fs[name]);
  fs[name] = function (...callArgs) {
    const site = callerOf();
    const key = `${name}@${site}`;
    const start = performance.now();
    try { return originals.get(name).apply(this, callArgs); }
    finally {
      const elapsed = performance.now() - start;
      const row = CALLERS.get(key) ?? { calls: 0, elapsedMs: 0 };
      row.calls++;
      row.elapsedMs += elapsed;
      CALLERS.set(key, row);
      COST.set(name, (COST.get(name) ?? 0) + elapsed);
    }
  };
}
syncBuiltinESMExports();

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-observe-attribution-'));
const archiveRoot = path.join(root, 'dockyard');
const archive = 'state.json.cycles-archive.jsonl';
const directory = path.join(archiveRoot, archive + '.segments');
fs.mkdirSync(directory, { recursive: true });
const index = [];
for (let i = 0; i < segments; i++) {
  const file = `segment-${String(i + 1).padStart(12, '0')}.jsonl`;
  const raw = JSON.stringify({ id: `cycle-${i}`, status: 'observed', recordedAt: '2026-08-26T12:00:00.000Z', summary: 'x'.repeat(segmentBytes) }) + '\n';
  fs.writeFileSync(path.join(directory, file), raw, { mode: 0o600 });
  index.push({ collection: 'cycles', file, sealed: true, checksumState: 'final', byteSize: Buffer.byteLength(raw), sha256: createHash('sha256').update(raw).digest('hex') });
}
fs.writeFileSync(path.join(archiveRoot, 'state.json.evolution-archive-index.json'), JSON.stringify({ schemaVersion: 1, segments: index }));
const backend = new JsonStorageBackend(path.join(root, 'official'));
const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });

const reset = () => { CALLERS.clear(); COST.clear(); };
let port;
try {
  port = await openDomainStorage(ctx, { presetDir: root, eventBridgePath: path.join(root, 'events.jsonl'), eventBridgeKey: 'b'.repeat(64) });
  await port.observe({ code: 'BENCH_ERROR', target: 'tool:bench' }); // warm up, not recorded
  for (let warm = 0; warm < warmWrites; warm++) await port.observe({ code: 'BENCH_ERROR', target: 'tool:bench' });
  const results = [];
  for (let sample = 0; sample < samples; sample++) {
    reset();
    const cpu = process.cpuUsage();
    const start = performance.now();
    await port.observe({ code: 'BENCH_ERROR', target: 'tool:bench' });
    const elapsedMs = performance.now() - start;
    const used = process.cpuUsage(cpu);
    results.push({ elapsedMs, cpuMs: (used.user + used.system) / 1000,
      byFunction: Object.fromEntries([...COST.entries()].map(([name, elapsed]) => [name, Number(elapsed.toFixed(3))])),
      byCaller: Object.fromEntries([...CALLERS.entries()].map(([key, row]) => [key, { calls: row.calls, elapsedMs: Number(row.elapsedMs.toFixed(3)) }])) });
  }
  assert.equal(port.query('cycles').count, segments);
  assert.ok(port.query('observations').count > 0);
  await port.close();
  port = null;
  port = await openDomainStorage(ctx, { presetDir: root, eventBridgePath: path.join(root, 'events.jsonl'), eventBridgeKey: 'b'.repeat(64) });
  assert.equal(port.query('cycles').count, segments);
  const median = key => results.map(row => row[key]).sort((a, b) => a - b)[Math.floor(results.length / 2)];
  const merged = (field) => {
    const totals = new Map();
    for (const row of results) for (const [key, value] of Object.entries(row[field])) {
      const previous = totals.get(key) ?? (field === 'byCaller' ? { calls: 0, elapsedMs: 0 } : 0);
      totals.set(key, field === 'byCaller'
        ? { calls: previous.calls + value.calls, elapsedMs: previous.elapsedMs + value.elapsedMs }
        : previous + value);
    }
    return [...totals.entries()].map(([key, value]) => [key, field === 'byCaller'
      ? { calls: Number((value.calls / samples).toFixed(2)), elapsedMs: Number((value.elapsedMs / samples).toFixed(3)) }
      : Number((value / samples).toFixed(3))])
      .sort((left, right) => (field === 'byCaller'
        ? right[1].elapsedMs - left[1].elapsedMs
        : right[1] - left[1]));
  };
  console.log(JSON.stringify({
    node: process.version, platform: `${process.platform}/${process.arch}`,
    libTreeSha256: libTree, segments, segmentBytes, samples, warmWrites,
    median: { elapsedMs: median('elapsedMs'), cpuMs: median('cpuMs') },
    perSampleElapsedMs: results.map(row => Number(row.elapsedMs.toFixed(3))),
    byFunction: Object.fromEntries(merged('byFunction')),
    byCaller: Object.fromEntries(merged('byCaller')),
    results
  }, null, 2));
} finally {
  if (port) await port.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
}
