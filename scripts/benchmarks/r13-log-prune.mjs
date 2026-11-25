#!/usr/bin/env node
/**
 * A/B benchmark for the within-call pair reuse in planLogPrune()
 * (DSH-EVOLUTION-PERF-R13-01). Measures the isolated pure function on signed
 * log buffers at 3 history magnitudes, alternating baseline / candidate /
 * baseline-control, one independent process per (round x side x scale).
 *
 * Usage:
 *   NODE_OPTIONS=--max-old-space-size=4096 node scripts/benchmarks/r13-log-prune.mjs \
 *     --base a0380e5cf2761297ecd8ffe1c79e34865ac6baee --rounds 3 --samples 3 \
 *     --sizes 2000,20000,100000 \
 *     --out docs/performance/r13-event-log-prune.json
 *
 * A = git show <base>:lib/event-log-checkpoint.js (within a full baseline tree);
 * B = this worktree. Every subprocess reads the same frozen signed log + applied
 * map, so the two sides differ only in the candidate block. The result
 * fingerprint is asserted equal across every side/sample; if any differs the
 * JSON is still written but the script exits non-zero instead of reporting an
 * A/B between two behaviours.
 *
 * Fixtures live in a mkdtemp directory owned by this script and are removed on
 * exit. No caller-supplied directory is ever deleted (the script accepts none).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { signEventBridgeEnvelope } from '../../lib/orchestrator.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'b'.repeat(64);
const WRITER = 'dsh-evolution-orchestrator';
const OWNED = [];
process.once('exit', () => { for (const dir of OWNED) fs.rmSync(dir, { recursive: true, force: true }); });

function usage() {
  return [
    'Usage: node scripts/benchmarks/r13-log-prune.mjs [options]',
    '  --base <sha>       baseline commit (default: origin/main a0380e5...)',
    '  --rounds <n>       alternating rounds (default 3)',
    '  --samples <n>      samples per side per round (default 3)',
    '  --sizes <list>     comma-separated event counts (default 2000,20000,100000)',
    '  --out <path>       JSON output path',
  ].join('\n');
}

function parse(argv) {
  const out = { base: 'a0380e5cf2761297ecd8ffe1c79e34865ac6baee', rounds: 3, samples: 3,
    sizes: [2000, 20000, 100000], out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') { console.log(usage()); process.exit(0); }
    if (arg === '--base') out.base = argv[++i];
    else if (arg === '--rounds') out.rounds = Number(argv[++i]);
    else if (arg === '--samples') out.samples = Number(argv[++i]);
    else if (arg === '--sizes') out.sizes = argv[++i].split(',').map(Number);
    else if (arg === '--out') out.out = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  assert.ok(Number.isInteger(out.rounds) && out.rounds >= 3, 'rounds must be >= 3');
  assert.ok(Number.isInteger(out.samples) && out.samples >= 1);
  assert.ok(out.sizes.length >= 3 && out.sizes.every(n => Number.isInteger(n) && n > 0), 'need >= 3 sizes');
  assert.ok(out.out, '--out is required');
  return out;
}

function materializeBaseline(sha) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-log-prune-base-'));
  OWNED.push(dir);
  const archive = spawnSync('git', ['archive', sha], { cwd: REPO, maxBuffer: 512 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(`git archive failed: ${archive.stderr}`);
  const untar = spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout });
  if (untar.status !== 0) throw new Error(`tar extract failed: ${untar.stderr}`);
  try { fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules')); } catch {}
  return dir;
}

function buildFixture(count, dir) {
  const applied = {};
  const lines = [];
  for (let index = 0; index < count; index += 1) {
    const eventId = `evt-${String(index).padStart(8, '0')}`;
    const envelope = signEventBridgeEnvelope({ eventId, experimentId: 'r13', eventType: 'experiment-rejected',
      target: 'plugin:r13-benchmark' }, { key: KEY, writer: WRITER, sequence: index + 1 });
    applied[eventId] = envelope.mac;
    lines.push(JSON.stringify(envelope));
  }
  const buffer = Buffer.from(lines.join('\n') + '\n', 'utf8');
  const logFile = path.join(dir, `log-${count}.jsonl`);
  const appliedFile = path.join(dir, `applied-${count}.json`);
  fs.writeFileSync(logFile, buffer);
  fs.writeFileSync(appliedFile, JSON.stringify(applied));
  return { logFile, appliedFile, bytes: buffer.length, appliedKeys: Object.keys(applied).length };
}

function iterationsFor(count) {
  if (count <= 5000) return 30;
  if (count <= 30000) return 10;
  return 4;
}

function runWorker(tree, fixture, iterations) {
  const env = { ...process.env, R13_TREE: tree, R13_LOG: fixture.logFile, R13_APPLIED: fixture.appliedFile,
    R13_KEY: KEY, R13_WRITER: WRITER, R13_KEEP: '1', R13_ITER: String(iterations) };
  const result = spawnSync(process.execPath, ['--expose-gc', path.join(REPO, 'scripts/benchmarks/r13-log-prune-worker.mjs')],
    { cwd: REPO, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`worker failed (${result.status}): ${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const opts = parse(process.argv.slice(2));
const baselineTree = materializeBaseline(opts.base);
const candidateTree = REPO;
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-log-prune-fixtures-'));
OWNED.push(fixtureDir);
const run = { method: {
  task: 'DSH-EVOLUTION-PERF-R13-01', subsystem: 'event-log-checkpoint/planLogPrune pair reuse',
  base: opts.base, rounds: opts.rounds, samples: opts.samples, sizes: opts.sizes,
  metric: 'process.cpuUsage() user+system (primary); wall clock, maxRSS, log bytes (auxiliary)',
  isolation: 'one independent child process per round x side x sample; A,B,A-control alternated; identical frozen signed log + applied map read by both sides',
  A: 'baseline lib/ tree from git archive at --base', B: 'candidate worktree',
  control: 'A-control is a second baseline run in the same round to bound noise',
  harness: 'module import and fixture read outside the timed window; 2 warmups; --expose-gc; --max-old-space-size=4096 inherited via NODE_OPTIONS',
  environment: `node ${process.version}, ${process.platform}/${process.arch}`,
}, generatedAt: new Date().toISOString(), roundOrder: [], scales: [] };

let allFingerprintsEqual = true;
for (const count of opts.sizes) {
  const fixture = buildFixture(count, fixtureDir);
  const iterations = iterationsFor(count);
  const scale = { count, bytes: fixture.bytes, appliedKeys: fixture.appliedKeys, iterations, rounds: [] };
  for (let round = 0; round < opts.rounds; round += 1) {
    const order = round % 2 === 0 ? ['A', 'B', 'A2'] : ['B', 'A', 'A2'];
    const treeFor = { A: baselineTree, B: candidateTree, A2: baselineTree };
    const samples = [];
    for (const side of order) {
      for (let sample = 0; sample < opts.samples; sample += 1) {
        const measured = runWorker(treeFor[side], fixture, iterations);
        samples.push({ side, sample, ...measured });
      }
    }
    const fps = new Set(samples.map(s => s.fingerprint));
    if (fps.size !== 1) { allFingerprintsEqual = false; console.error(`fingerprint mismatch at ${count}/${round}: ${[...fps].join(', ')}`); }
    scale.rounds.push({ round, order, samples });
    run.roundOrder.push({ count, round, order });
  }
  const per = (side, key) => median(scale.rounds.flatMap(r => r.samples.filter(s => s.side === side).map(s => s[key])));
  const aCpu = per('A', 'cpuMicros'), bCpu = per('B', 'cpuMicros'), a2Cpu = per('A2', 'cpuMicros');
  scale.summary = {
    aCpuMedianUs: aCpu, bCpuMedianUs: bCpu, a2CpuMedianUs: a2Cpu,
    cpuRelativePercent: ((bCpu - aCpu) / aCpu) * 100,
    aaNoisePercent: ((a2Cpu - aCpu) / aCpu) * 100,
    aWallMedianMs: per('A', 'wallMs'), bWallMedianMs: per('B', 'wallMs'),
    aMaxRssKb: per('A', 'maxRssKb'), bMaxRssKb: per('B', 'maxRssKb'),
    fingerprint: [...new Set(scale.rounds.flatMap(r => r.samples.map(s => s.fingerprint)))],
  };
  run.scales.push(scale);
}
run.allFingerprintsEqual = allFingerprintsEqual;
fs.mkdirSync(path.dirname(opts.out), { recursive: true });
fs.writeFileSync(opts.out, JSON.stringify(run, null, 2) + '\n');
if (!allFingerprintsEqual) {
  console.error('refusing to report an A/B between two different behaviours; JSON written for inspection');
  process.exit(1);
}
for (const scale of run.scales) {
  const s = scale.summary;
  console.log(`${scale.count} events (${(scale.bytes / 1024 / 1024).toFixed(1)} MiB): A ${(s.aCpuMedianUs / 1000).toFixed(1)} ms -> B ${(s.bCpuMedianUs / 1000).toFixed(1)} ms (${s.cpuRelativePercent.toFixed(2)}%), A/A noise ${s.aaNoisePercent.toFixed(2)}%`);
}
