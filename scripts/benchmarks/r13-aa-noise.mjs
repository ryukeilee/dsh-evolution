#!/usr/bin/env node
// R13 A/A noise floor: both "sides" load the SAME code, with the same
// alternating order, independent process per (round, side, workload, sample).
// Any difference here is pure scheduling / GC / fs noise, not a code effect.
// Main metric: process.cpuUsage() (user+system).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(import.meta.dirname, '../..');
const MAIN = path.join(REPO, 'scripts/benchmarks/r13-shared-experience-scale.mjs');
const args = process.argv.slice(2);
const opts = { rounds: 3, samples: 2, out: null, lib: path.join(REPO, 'lib') };
for (let i = 0; i < args.length; i += 1) {
  const name = args[i].startsWith('--') ? args[i].slice(2) : null;
  if (!name) throw new Error('unexpected arg ' + args[i]);
  const value = args[++i];
  if (value === undefined) throw new Error('missing value for ' + args[i]);
  if (name === 'rounds') opts.rounds = Number(value);
  else if (name === 'samples') opts.samples = Number(value);
  else if (name === 'out') opts.out = value;
  else if (name === 'lib') opts.lib = value;
  else throw new Error('unknown option ' + args[i]);
}
const workloads = [
  { name: 'recall', n: 10000 },
  { name: 'hot', n: 1000 },
];
const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
function run(workload, seed, lib) {
  const r = spawnSync(process.execPath, ['--max-old-space-size=4096', MAIN, 'worker',
    '--lib', lib, '--workload', workload, '--n', String(seed.n), '--seed', String(seed.id)],
    { encoding: 'utf8', timeout: 300000 });
  if (r.status !== 0) throw new Error('worker failed: ' + r.stderr + r.stdout);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
const samples = [];
for (let round = 0; round < opts.rounds; round += 1) {
  const order = round % 2 === 0 ? ['A', 'B'] : ['B', 'A'];
  const pair = {};
  for (const side of order) {
    pair[side] = {};
    for (const w of workloads) {
      const values = [];
      for (let s = 0; s < opts.samples; s += 1) {
        values.push(run(w.name, { n: w.n, id: round * 1000 + s }, opts.lib));
      }
      pair[side][w.name] = {
        cpuMs: median(values.map((v) => v.cpuMs)),
        wallMs: median(values.map((v) => v.wallMs)),
        samples: values,
      };
    }
  }
  samples.push({ round, order: order.join(','), A: pair.A, B: pair.B });
}
const summary = {};
for (const w of workloads) {
  const a = median(samples.map((s) => s.A[w.name].cpuMs));
  const b = median(samples.map((s) => s.B[w.name].cpuMs));
  summary[w.name] = { aCpuMs: a, bCpuMs: b, changePercent: +((b - a) / a * 100).toFixed(2),
    perPairDeltaMs: samples.map((s) => +(s.B[w.name].cpuMs - s.A[w.name].cpuMs).toFixed(4)) };
}
const result = {
  method: 'R13 A/A noise floor: both sides load the identical code (' + opts.lib + '), '
    + 'alternating order, independent process per (round, side, workload, sample), '
    + 'process.cpuUsage() main metric. Differences are pure noise.',
  node: process.version, platform: process.platform + '-' + process.arch,
  rounds: opts.rounds, samples: opts.samples, summary, samples,
};
if (opts.out) {
  fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
  fs.writeFileSync(opts.out, JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify(summary, null, 2));
void pathToFileURL;
