#!/usr/bin/env node
/**
 * End-to-end cold-start benchmark against an installed official DSH runtime.
 *
 * It measures the real host process: spawn -> the state named by the config is
 * reachable (`evolution` service + its 10 tools, and the `hmr` service when the
 * config leaves it enabled). Alternating A/B order and a per-config median make
 * the host-level cost of the profile configuration visible, which is the whole
 * point of the "profile changes apply on restart" deployment.
 *
 * Configurations (all booted through the official `--patch` overlay):
 *   evolution-hmr-on   Evolution bundle selected, host HMR row enabled
 *   evolution-hmr-off  Evolution bundle selected, `hmr` row disabled
 *   host-hmr-on        same profile with the bundle deselected
 *   host-hmr-off       same profile with the bundle deselected, `hmr` disabled
 *
 * The two host-only configurations boot a copy of the given home whose
 * `dsh.profile.bundles` no longer selects this bundle; the package stays
 * installed, so only the bundle's own startup work disappears.
 *
 * Usage:
 *   node --max-old-space-size=4096 scripts/benchmarks/host-startup.mjs \
 *     --runtime <dir with @deepseek-ai/dsh installed> --home <DSH_HOME> \
 *     [--rounds 9] [--idle-ms 0] [--out docs/performance/<name>.json] [--keep]
 *
 * The home must already have this bundle installed and selected (for example
 * the `--keep` scratch directory of `run-host-acceptance.mjs`). This script
 * never reads a production home: pass an isolated one.
 */
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(HERE, 'probes', 'host-startup-probe.mjs');

function parseArgs(argv) {
  const options = { rounds: 9, idleMs: 0, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };
    if (arg === '--runtime') options.runtime = path.resolve(value());
    else if (arg === '--home') options.home = path.resolve(value());
    else if (arg === '--rounds') options.rounds = Number(value());
    else if (arg === '--idle-ms') options.idleMs = Number(value());
    else if (arg === '--out') options.out = path.resolve(value());
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help || !options.runtime || !options.home) {
  process.stdout.write('node scripts/benchmarks/host-startup.mjs --runtime <dir> --home <DSH_HOME> [--rounds 9] [--idle-ms 0] [--out file] [--keep]\n');
  process.exit(options.help ? 0 : 2);
}
if (!Number.isSafeInteger(options.rounds) || options.rounds < 2) throw new Error('--rounds must be an integer >= 2');
if (!Number.isSafeInteger(options.idleMs) || options.idleMs < 0) throw new Error('--idle-ms must be a non-negative integer');

const cli = path.join(options.runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
if (!fs.existsSync(cli)) throw new Error(`${options.runtime} does not contain @deepseek-ai/dsh/lib/bin.js`);
const hostVersion = JSON.parse(fs.readFileSync(path.join(options.runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version;
const bundleVersion = JSON.parse(fs.readFileSync(path.join(options.home, 'profiles', 'web', 'node_modules', 'dsh-evolution', 'package.json'), 'utf8')).version;
const manifest = JSON.parse(fs.readFileSync(path.join(options.home, 'profiles', 'web', 'package.json'), 'utf8'));
if (!(manifest.dsh?.profile?.bundles || []).includes('dsh-evolution')) throw new Error('the given home does not select dsh-evolution in its web profile');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-evolution-startup-'));
const evolutionHome = path.join(work, 'evolution-home');
const hostHome = path.join(work, 'host-only-home');
fs.cpSync(options.home, evolutionHome, { recursive: true, verbatimSymlinks: true });
fs.cpSync(options.home, hostHome, { recursive: true, verbatimSymlinks: true });
const hostManifestPath = path.join(hostHome, 'profiles', 'web', 'package.json');
const hostManifest = JSON.parse(fs.readFileSync(hostManifestPath, 'utf8'));
hostManifest.dsh.profile.bundles = hostManifest.dsh.profile.bundles.filter((name) => name !== 'dsh-evolution');
fs.writeFileSync(hostManifestPath, `${JSON.stringify(hostManifest, null, 2)}\n`);

const patchFor = (name, noHmr) => {
  const file = path.join(work, `${name}.patch.yml`);
  // `- id: hmr / disabled: true` is the official overlay form for disabling a
  // base-bundle row; with the service absent the host applies profile changes on
  // restart instead of reconciling them live.
  fs.writeFileSync(file, `${noHmr ? '- id: hmr\n  disabled: true\n' : ''}- insert:\n    - id: evolution-startup-bench\n      name: '${pathToFileURL(PROBE).href}'\n`);
  return file;
};

const configs = [
  { name: 'evolution-hmr-on', home: evolutionHome, hmr: true, evolution: true },
  { name: 'evolution-hmr-off', home: evolutionHome, hmr: false, evolution: true },
  { name: 'host-hmr-on', home: hostHome, hmr: true, evolution: false },
  { name: 'host-hmr-off', home: hostHome, hmr: false, evolution: false },
].map((config) => ({ ...config, patch: patchFor(config.name, !config.hmr) }));

function boot(config) {
  const started = process.hrtime.bigint();
  return new Promise((resolve) => {
    const child = fork(cli, ['--profile', 'web', '--patch', config.patch, '--', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
      cwd: work,
      env: {
        ...process.env,
        DSH_HOME: config.home,
        BENCH_EVOLUTION: config.evolution ? '1' : '0',
        BENCH_HMR: config.hmr ? '1' : '0',
        BENCH_IDLE_MS: String(options.idleMs),
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
      resolve({ ...value, wallMs: Number(process.hrtime.bigint() - started) / 1e6 });
    };
    const timer = setTimeout(() => finish({ error: 'probe timed out' }), 180000);
    child.on('message', (message) => {
      if (message?.ready) child.send('run');
      else if (message?.result) {
        // A probe that never reaches the state it names is a failed sample, not
        // a slow one: counting it would put an unready boot into the median.
        if (message.result.timedOut === true) finish({ error: 'probe never reached its ready state', ...message.result });
        else finish(message.result);
      } else if (message?.error) finish({ error: message.error });
    });
    child.on('exit', (code, signal) => finish({ error: `host exited before reporting: ${code ?? signal}` }));
  });
}

const samples = [];
for (let round = 0; round < options.rounds; round += 1) {
  // Alternate the order so a drift in machine state cannot favour one config.
  const order = round % 2 === 0 ? configs : [...configs].reverse();
  for (const config of order) {
    const result = await boot(config);
    samples.push({ round, config: config.name, ...result });
    process.stdout.write(`${JSON.stringify({ round, config: config.name, wallMs: Math.round(result.wallMs), readyMs: Math.round(result.readyMs), rssMiB: Math.round(result.rssMiB), cpuMs: Math.round((result.cpuUserMs || 0) + (result.cpuSystemMs || 0)), idleCpuMs: result.idle ? Math.round(result.idle.cpuUserMs + result.idle.cpuSystemMs) : null, tools: result.evolutionTools, hmr: result.hmr, evolution: result.evolution, error: result.error })}\n`);
  }
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const summary = Object.fromEntries(configs.map((config) => {
  const own = samples.filter((sample) => sample.config === config.name && !sample.error);
  const pick = (field) => median(own.map((sample) => sample[field]));
  return [config.name, {
    samples: own.length,
    errors: samples.filter((sample) => sample.config === config.name && sample.error).length,
    wallMs: pick('wallMs'),
    readyMs: pick('readyMs'),
    rssMiB: pick('rssMiB'),
    heapUsedMiB: pick('heapUsedMiB'),
    // One median over the per-sample total, not the sum of two medians: the
    // components are not independent of each other within a sample.
    cpuMs: median(own.map((sample) => sample.cpuUserMs + sample.cpuSystemMs)),
  }];
}));
const payload = {
  host: hostVersion,
  bundle: bundleVersion,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  rounds: options.rounds,
  idleMs: options.idleMs,
  startedAt: new Date().toISOString(),
  summary,
  samples,
};
process.stdout.write(`${JSON.stringify({ summary }, null, 2)}\n`);
// A sample that never reached its ready state must fail the run, not shrink the
// median silently.
const failed = samples.filter((sample) => sample.error);
if (failed.length > 0) {
  process.stderr.write(`${failed.length} of ${samples.length} samples failed, for example: ${JSON.stringify(failed[0])}\n`);
  process.exitCode = 1;
}
if (options.out) {
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, `${JSON.stringify(payload, null, 2)}\n`);
}
if (!options.keep) fs.rmSync(work, { recursive: true, force: true });
else process.stdout.write(`work directory kept at ${work}\n`);
