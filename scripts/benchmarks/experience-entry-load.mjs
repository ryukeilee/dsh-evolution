#!/usr/bin/env node
// Cold module-graph cost of the entries an ACP or Web session loads.
//
// The profile patches enable `evolution-experience`,
// `evolution-experience-history`, `evolution-promoted-consumer`, `guard` and,
// on ACP, `desktop-task-client`; the orchestrator row is disabled outside
// Desktop. Before this change the lightweight experience entry still imported
// the orchestrator, the doctor and the tool registration module, so every
// ACP/Web session parsed and instantiated the kernel graph for two small helpers.
//
// Each probe runs in a fresh child process (the only honest way to measure ESM
// parse/instantiate cost), the entry sets are imported in alternating order, and
// every probe asserts the expected `apply` export exists, so a broken build
// fails instead of being timed. `--baseline <commit>` materialises `lib/` from
// that commit in a temp directory with a `node_modules` symlink; the candidate
// is always the working tree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { registerHooks } from 'node:module';
import { REPO_ROOT } from '../release/release-lib.mjs';

const SELF = fileURLToPath(import.meta.url);
const ENTRY_SETS = {
  experience: ['experience-collector'],
  history: ['experience-history'],
  web: ['experience-collector', 'experience-history', 'promoted-consumer', 'guard'],
  acp: ['experience-collector', 'experience-history', 'promoted-consumer', 'guard', 'desktop-task-client'],
};

async function probe(root, entries) {
  const seen = new Set();
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!seen.has(url)) seen.add(url);
      return result;
    },
  });
  const cpuStart = process.cpuUsage();
  const started = performance.now();
  for (const entry of entries) {
    const module = await import(pathToFileURL(path.join(root, 'lib', entry + '.js')).href);
    assert.equal(typeof module.apply, 'function', entry + ' has no apply() export');
  }
  const ms = performance.now() - started;
  const cpu = process.cpuUsage(cpuStart);
  const memory = process.memoryUsage();
  let libBytes = 0;
  let totalBytes = 0;
  const files = [];
  // A module URL is resolved to the real path by Node's ESM loader, so a root
  // under the macOS /tmp symlink arrives as /private/tmp. Compare real roots.
  const realRoot = fs.realpathSync(root);
  const libRoot = path.join(realRoot, 'lib') + path.sep;
  for (const url of seen) {
    if (!url.startsWith('file://')) continue;
    try {
      const file = fileURLToPath(url);
      const bytes = fs.statSync(file).size;
      totalBytes += bytes;
      if (file.startsWith(libRoot)) { libBytes += bytes; files.push([path.relative(realRoot, file), bytes]); }
    } catch { /* a hook may see a URL that is not a regular file */ }
  }
  files.sort((left, right) => right[1] - left[1]);
  return {
    ms: ms,
    cpuMs: (cpu.user + cpu.system) / 1000,
    rssMiB: memory.rss / 1048576,
    modules: seen.size,
    libBytes: libBytes,
    totalBytes: totalBytes,
    files: files.slice(0, 8),
  };
}

function materialize(commit, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const archive = execFileSync('git', ['-C', REPO_ROOT, 'archive', commit, 'lib'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', directory], { input: archive });
  const target = path.join(directory, 'node_modules');
  if (!fs.existsSync(target)) fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), target, 'dir');
  return directory;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
}

const args = process.argv.slice(2);
if (args[0] === '--probe') {
  const result = await probe(args[1], args[2].split(','));
  console.log(JSON.stringify(result));
  process.exit(0);
}
const options = { baseline: null, rounds: 7, out: null, keep: false };
for (let index = 0; index < args.length; index += 1) {
  const name = args[index].slice(2);
  if (args[index] === '--keep') { options.keep = true; continue; }
  const value = args[index + 1];
  if (!args[index].startsWith('--') || !Object.hasOwn(options, name) || value === undefined) throw new Error('Unknown/missing option: ' + args[index]);
  index += 1;
  options[name] = name === 'rounds' ? Number(value) : value;
}
if (!options.baseline) throw new Error('--baseline <commit> is required; the candidate is the working tree');
if (!Number.isSafeInteger(options.rounds) || options.rounds < 1) throw new Error('Invalid --rounds: expected integer >= 1');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-entry-load-'));
const baselineRoot = materialize(options.baseline, path.join(work, 'baseline'));
const candidateRoot = REPO_ROOT;
const single = (root, entries) => {
  const output = execFileSync(process.execPath, ['--max-old-space-size=4096', SELF, '--probe', root, entries], { encoding: 'utf8', timeout: 120_000 });
  return JSON.parse(output.trim().split('\n').at(-1));
};
const samples = [];
for (let round = 0; round < options.rounds; round += 1) {
  const order = round % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
  for (const [name, entries] of Object.entries(ENTRY_SETS)) {
    const pair = {};
    for (const side of order) pair[side] = single(side === 'baseline' ? baselineRoot : candidateRoot, entries.join(','));
    samples.push({ round: round, order: order.join(','), entrySet: name, baseline: pair.baseline, candidate: pair.candidate });
  }
}
const summary = {};
let regression = null;
for (const name of Object.keys(ENTRY_SETS)) {
  const rows = samples.filter((sample) => sample.entrySet === name);
  const entry = {
    baselineMs: median(rows.map((row) => row.baseline.ms)),
    candidateMs: median(rows.map((row) => row.candidate.ms)),
    baselineCpuMs: median(rows.map((row) => row.baseline.cpuMs)),
    candidateCpuMs: median(rows.map((row) => row.candidate.cpuMs)),
    baselineModules: rows[0].baseline.modules,
    candidateModules: rows[0].candidate.modules,
    baselineLibBytes: rows[0].baseline.libBytes,
    candidateLibBytes: rows[0].candidate.libBytes,
    baselineRssMiB: median(rows.map((row) => row.baseline.rssMiB)),
    candidateRssMiB: median(rows.map((row) => row.candidate.rssMiB)),
  };
  if (entry.candidateLibBytes >= entry.baselineLibBytes) regression = name;
  summary[name] = entry;
}
const result = {
  node: process.version,
  platform: process.platform + '-' + process.arch,
  baselineCommit: options.baseline,
  method: 'Fresh child process per probe, module graph counted with node:module registerHooks, entry sets in alternating order, '
    + options.rounds + ' rounds per set; medians reported. Each probe imports the entries and asserts every apply() export exists.',
  entrySets: ENTRY_SETS,
  samples: samples,
  summary: summary,
};
if (options.out) {
  fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
  fs.writeFileSync(options.out, JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify(summary, null, 2));
if (!options.keep) fs.rmSync(work, { recursive: true, force: true });
if (regression) {
  console.error('entry module graph did not shrink for: ' + regression);
  process.exitCode = 1;
}
