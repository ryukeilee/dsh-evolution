#!/usr/bin/env node
// R13 sparse-path A/B: re-measure only the zero-candidate / single-candidate
// recall paths after the `records.length < 2` early return was added. Uses the
// same worker mode, shared fixture and alternating order as the main benchmark.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const MAIN = path.join(REPO, 'scripts/benchmarks/r13-shared-experience-scale.mjs');
const BASE = process.env.R13_BASE_LIB || BASE_FROM_ARGS();
function BASE_FROM_ARGS() {
  const i = process.argv.indexOf('--base-lib');
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  throw new Error('--base-lib <baseline lib dir> is required');
}
const CAND = path.join(REPO, 'lib');
const rounds = 3; const samplesPerSide = 2;
const outIdx = process.argv.indexOf('--out');
const out = outIdx >= 0 ? process.argv[outIdx + 1] : null;
const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
function spawn(mode, lib, args) {
  const r = spawnSync(process.execPath, ['--max-old-space-size=4096', MAIN, mode, '--lib', lib, ...args],
    { encoding: 'utf8', timeout: 300000 });
  if (r.status !== 0) throw new Error(mode + ' failed: ' + r.stderr + r.stdout);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
const workloads = [
  { name: 'recall-none', n: 10000 },
  { name: 'recall-one', n: 10000 },
];
const fixtures = {};
const owned = [];
for (const w of workloads) {
  const built = spawn('build', CAND, ['--workload', w.name, '--n', String(w.n), '--seed', '0']);
  fixtures[w.name] = built.root;
  owned.push(built.root);
}
try {
  const entries = [];
  for (let round = 0; round < rounds; round += 1) {
    const order = round % 2 === 0 ? [['A', BASE], ['B', CAND]] : [['B', CAND], ['A', BASE]];
    const pair = {};
    for (const [side, lib] of order) {
      pair[side] = {};
      for (const w of workloads) {
        const values = [];
        let last = null;
        for (let s = 0; s < samplesPerSide; s += 1) {
          last = spawn('worker', lib, ['--workload', w.name, '--n', String(w.n), '--seed', String(round * 1000 + s),
            '--fixture', fixtures[w.name]]);
          values.push(last);
        }
        pair[side][w.name] = {
          cpuMs: median(values.map((v) => v.cpuMs)),
          wallMs: median(values.map((v) => v.wallMs)),
          samples: values, fingerprint: last.fingerprint, dbBytes: last.dbBytes, stats: last.stats,
        };
      }
    }
    for (const w of workloads) {
      if (pair.A[w.name].fingerprint !== pair.B[w.name].fingerprint) {
        throw new Error('round ' + round + ' ' + w.name + ': fingerprints differ');
      }
    }
    entries.push({ round, order: order.map(([s]) => s).join(','), A: pair.A, B: pair.B });
  }
  const summary = {};
  for (const w of workloads) {
    const a = median(entries.map((e) => e.A[w.name].cpuMs));
    const b = median(entries.map((e) => e.B[w.name].cpuMs));
    summary[w.name] = { aCpuMs: a, bCpuMs: b, changePercent: +((b - a) / a * 100).toFixed(2),
      perPairDeltaMs: entries.map((e) => +(e.B[w.name].cpuMs - e.A[w.name].cpuMs).toFixed(4)) };
  }
  const result = {
    method: 'R13 sparse-path A/B after the length<2 early return. Both sides load their own tree, '
      + 'shared fixture per workload, alternating A,B / B,A, independent process per sample, '
      + 'process.cpuUsage() main metric, output fingerprints asserted equal per round.',
    node: process.version, platform: process.platform + '-' + process.arch,
    baseLib: BASE, candLib: CAND, rounds, samples: samplesPerSide, summary, observations: entries,
  };
  if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
} finally {
  for (const dir of owned) fs.rmSync(dir, { recursive: true, force: true });
}
