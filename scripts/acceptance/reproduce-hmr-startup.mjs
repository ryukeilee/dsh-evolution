#!/usr/bin/env node
/** Official 0.2.2-rc.1 control, without Evolution. Diagnostic success means the
 * upstream guard failure was reproduced (and its absence with HMR disabled), not
 * that host acceptance passed.
 * Usage: node --max-old-space-size=4096 scripts/acceptance/reproduce-hmr-startup.mjs <runtime> <out.json>
 */
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

const [runtimeArg, outArg] = process.argv.slice(2);
if (!runtimeArg || !outArg) throw new Error('expected runtime directory and output JSON path');
const runtime = path.resolve(runtimeArg);
const out = path.resolve(outArg);
const modules = path.join(runtime, 'node_modules/@deepseek-ai');
const version = JSON.parse(fs.readFileSync(path.join(modules, 'dsh/package.json'))).version;
if (version !== '0.2.2-rc.1') throw new Error(`expected official 0.2.2-rc.1, found ${version}`);
const cli = path.join(modules, 'dsh/lib/bin.js');
const probe = path.join(path.dirname(fileURLToPath(import.meta.url)), 'probes/hmr-transaction-probe.mjs');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hmr-022-'));
// Keep the standalone diagnostic outside Evolution's package boundary. The
// official host correctly rejects this checkout's unsupported package metadata.
const standaloneProbe = path.join(work, 'hmr-transaction-probe.mjs');
fs.copyFileSync(probe, standaloneProbe);
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sources = ['dsh-plugin-manager/lib/index.js', 'dsh-hmr/lib/index.js', 'cordis/lib/index.js'];
const report = { host: version, node: process.version, work, diagnosticOnly: true,
  sources: Object.fromEntries(sources.map(file => [file, sha256(path.join(modules, file))])), runs: [] };

/** Create the disposable profile only when it does not exist yet, so the second
 * boot of a no-HMR pair sees the selection the first boot saved. `mode` is an
 * argument, not an environment read: the parent process does not run the host,
 * so reading it from the environment silently produced HMR-enabled overlays for
 * every mode. */
function prepareProfile(runDir, mode) {
  const home = path.join(runDir, 'home');
  const profile = path.join(home, 'profiles/web');
  if (!fs.existsSync(profile)) {
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true,
      dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }));
  }
  const patch = path.join(runDir, 'probe.patch.yml');
  const noHmr = /^no-hmr/.test(mode);
  // Disabling the base bundle's `hmr` row is the documented
  // "changes apply on restart" configuration; it is not a workaround around the
  // guard, and it leaves PluginManager, the loader and Cordis untouched.
  const hmrRow = noHmr ? "- id: hmr\n  disabled: true\n" : '';
  // The row must survive the mode switch, so it is rewritten per boot.
  fs.writeFileSync(patch, `${hmrRow}- insert:\n    - id: hmr-transaction-diagnostic\n      name: '${pathToFileURL(standaloneProbe).href}'\n`);
  if (noHmr && !fs.readFileSync(patch, 'utf8').startsWith('- id: hmr\n  disabled: true')) {
    throw new Error(`${mode}: the overlay does not disable the hmr row`);
  }
  return { home, patch };
}

function boot(runDir, mode) {
  const { home, patch } = prepareProfile(runDir, mode);
  return new Promise(resolve => {
    const child = fork(cli, ['--profile', 'web', '--patch', patch, '--', '--no-open', '--host', '127.0.0.1', '--port', '0'],
      { cwd: runDir, env: { ...process.env, DSH_HOME: home, HMR_REPRO_MODE: mode }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let result;
    const finish = value => {
      if (result) return;
      result = value;
      clearTimeout(timer);
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
    };
    let killTimer;
    const timer = setTimeout(() => finish({ error: 'probe timed out' }), 60000);
    child.on('message', message => {
      if (message?.ready) child.send('run');
      else if (message?.result || message?.error) finish(message);
    });
    child.on('error', error => finish({ error: String(error) }));
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve(result || { error: `host exited: ${code ?? signal}` });
    });
  });
}

function save() {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
}

/** The HMR-enabled control groups: the same enable action, two schedules. */
for (const mode of ['barrier', 'barrier', 'barrier', 'stable', 'stable', 'stable']) {
  const runDir = path.join(work, String(report.runs.length));
  const outcome = await boot(runDir, mode);
  const result = outcome.result;
  const expected = Boolean(result) && result.evolutionEntries === 0 && (mode === 'barrier'
    ? result.results[0]?.error?.diagnostic === 'HMR profile reconciliation must run inside runExclusive'
      && result.results[0].changed === true
      && result.events.some(event => event.stage === 'configure' && !event.hmr)
      && result.events.some(event => event.stage === 'reload' && event.hmr && !event.inTransaction)
    : result.results.length === 1 && result.results.every(item => item.application === 'applied')
      && result.events.filter(event => event.stage === 'reload').every(event => event.inTransaction));
  report.runs.push({ mode, expected, ...outcome });
  save();
  console.log(`${mode}: ${expected ? 'expected diagnostic outcome' : 'UNEXPECTED'}`);
}

/** The no-HMR route: the same enable action, no transaction and no live apply. */
for (let index = 0; index < 3; index += 1) {
  const runDir = path.join(work, `no-hmr-${index}`);
  const action = await boot(runDir, 'no-hmr');
  const applied = await boot(runDir, 'no-hmr-verify');
  const actionResult = action.result;
  const verifyResult = applied.result;
  const expected = Boolean(actionResult) && Boolean(verifyResult)
    && actionResult.evolutionEntries === 0
    && actionResult.results.length === 1
    && actionResult.results[0].changed === true
    && actionResult.results[0].application === 'restart-required'
    && actionResult.results[0].restartReason === 'no-hmr'
    && actionResult.results[0].error === undefined
    && actionResult.events.every(event => event.hmr === false)
    && actionResult.selected.includes('@deepseek-ai/dsh-web-app')
    // The saved selection is what the first boot withheld; the restart applies it.
    && verifyResult.results[0]?.webStartup === true
    && verifyResult.events.every(event => event.hmr === false)
    && verifyResult.selected.includes('@deepseek-ai/dsh-web-app');
  report.runs.push({ mode: 'no-hmr', expected, action, applied });
  save();
  console.log(`no-hmr: ${expected ? 'expected diagnostic outcome' : 'UNEXPECTED'}`);
}

if (sources.some(file => report.sources[file] !== sha256(path.join(modules, file)))) throw new Error('official source changed during reproduction');
if (report.runs.some(run => !run.expected)) process.exitCode = 1;
