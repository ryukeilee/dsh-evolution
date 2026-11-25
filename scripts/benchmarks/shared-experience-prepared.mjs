#!/usr/bin/env node
// Alternating A/B of the constant-SQL statement handles in the shared
// experience write path. A is the committed baseline lib/; B is this worktree's
// lib/ (prepared handles hoisted out of record()). Every (round, side,
// workload) runs in its own process with its own isolated roots, so a JIT or
// page-cache warmup on one side cannot be carried into the other. The order is
// reversed every round. CPU (process.cpuUsage) is the primary metric because a
// busy machine can move wall time without changing the work done.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const worker = path.join(here, 'shared-experience-prepared-worker.mjs');
const args = process.argv.slice(2);
const options = { rounds: 5, samples: 5, writes: 400, out: null, 'base-commit': null };
for (let i = 0; i < args.length; i += 1) {
  const name = args[i].slice(2);
  if (!Object.hasOwn(options, name) || i + 1 >= args.length) throw new Error('Unknown/missing option: ' + args[i]);
  i += 1;
  options[name] = args[i];
}
for (const name of ['rounds', 'samples', 'writes']) options[name] = Number(options[name]);
for (const name of ['rounds', 'samples', 'writes']) {
  if (!Number.isSafeInteger(options[name]) || options[name] < 1) throw new Error('Invalid --' + name);
}
if (!options.out) throw new Error('missing --out');
if (!options['base-commit']) throw new Error('missing --base-commit');

const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'r12-prepared-trees-'));
const baseTree = path.join(tree, 'base');
const candTree = path.join(tree, 'candidate');
fs.cpSync(path.join(repo, 'lib'), path.join(baseTree, 'lib'), { recursive: true });
fs.cpSync(path.join(repo, 'lib'), path.join(candTree, 'lib'), { recursive: true });
const baseline = spawnSync('git', ['show', `${options['base-commit']}:lib/shared-experience.js`], { cwd: repo, encoding: 'utf8' });
if (baseline.status !== 0) throw new Error('git show failed: ' + baseline.stderr);
fs.writeFileSync(path.join(baseTree, 'lib/shared-experience.js'), baseline.stdout);
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sources = {
  baselineCommit: options['base-commit'],
  baselineSha256: sha256(path.join(baseTree, 'lib/shared-experience.js')),
  candidateSha256: sha256(path.join(candTree, 'lib/shared-experience.js')),
};

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};
function runOne(side, workload, round) {
  const moduleFile = path.join(side === 'A' ? baseTree : candTree, 'lib/shared-experience.js');
  const result = spawnSync(process.execPath, [worker, '--module', moduleFile, '--workload', workload,
    '--writes', String(options.writes), '--samples', String(options.samples)], {
    encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' }, maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`worker failed (${side}/${workload}/round ${round}): ${result.stderr}\n${result.stdout}`);
  const line = result.stdout.split('\n').find((value) => value.startsWith('RESULT:'));
  if (!line) throw new Error('worker did not report a result');
  return JSON.parse(line.slice('RESULT:'.length));
}

const workloads = ['writes', 'duplicates', 'readcontrol'];
const samples = [];
for (let round = 0; round < options.rounds; round += 1) {
  const order = round % 2 === 0 ? ['A', 'B'] : ['B', 'A'];
  for (const workload of workloads) {
    const pair = {};
    for (const side of order) pair[side] = runOne(side, workload, round);
    const summarize = (value) => {
      const perSample = value.raw.map((row) => ({ wall: row.workWallMs, cpu: row.workCpuMs, open: row.openMs,
        close: row.closeMs, rss: row.maxRssKb, bytes: row.dbBytes, stats: row.stats, extra: row.extra }));
      return { wall: median(perSample.map((row) => row.wall)), cpu: median(perSample.map((row) => row.cpu)),
        open: median(perSample.map((row) => row.open)), close: median(perSample.map((row) => row.close)),
        rss: median(perSample.map((row) => row.rss)), bytes: median(perSample.map((row) => row.bytes)),
        raw: value.raw };
    };
    const A = summarize(pair.A); const B = summarize(pair.B);
    if (JSON.stringify(A.raw.map((r) => r.stats)) !== JSON.stringify(B.raw.map((r) => r.stats))) {
      throw new Error(`stats disagree (${workload}/round ${round})`);
    }
    samples.push({ round, order: order.join(','), workload, A, B });
  }
}
const summary = {};
for (const workload of workloads) {
  const rows = samples.filter((s) => s.workload === workload);
  const A = median(rows.map((s) => s.A.cpu)); const B = median(rows.map((s) => s.B.cpu));
  const Awall = median(rows.map((s) => s.A.wall)); const Bwall = median(rows.map((s) => s.B.wall));
  summary[workload] = {
    cpuBaselineMs: A, cpuCandidateMs: B, cpuDeltaPct: (B - A) / A * 100,
    wallBaselineMs: Awall, wallCandidateMs: Bwall, wallDeltaPct: (Bwall - Awall) / Awall * 100,
    openBaselineMs: median(rows.map((s) => s.A.open)), openCandidateMs: median(rows.map((s) => s.B.open)),
    rssBaselineKb: median(rows.map((s) => s.A.rss)), rssCandidateKb: median(rows.map((s) => s.B.rss)),
    dbBytesBaseline: median(rows.map((s) => s.A.bytes)), dbBytesCandidate: median(rows.map((s) => s.B.bytes)),
    perRoundCpuDeltaPct: rows.map((s) => (s.B.cpu - s.A.cpu) / s.A.cpu * 100),
    perRoundWallDeltaPct: rows.map((s) => (s.B.wall - s.A.wall) / s.A.wall * 100),
  };
}
const result = {
  node: process.version, platform: process.platform + '-' + process.arch, date: new Date().toISOString(),
  method: 'Baseline A = git show <base-commit>:lib/shared-experience.js, candidate B = worktree lib/. '
    + 'One fresh process and isolated temp root per round/side/workload; alternating order A,B then B,A. '
    + 'CPU is primary; wall, open, close, maxRSS and db bytes are also reported. Same workload and ids on both sides.',
  options, sources, samples, summary,
};
fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
fs.writeFileSync(options.out, JSON.stringify(result, null, 2) + '\n');
fs.rmSync(tree, { recursive: true, force: true });
console.log(JSON.stringify({ sources, summary }, null, 2));
