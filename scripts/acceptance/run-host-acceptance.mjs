#!/usr/bin/env node
/**
 * Real host acceptance for one supported DSH version.
 *
 * This reproduces, from a fresh runtime, the acceptance the support claim is
 * based on. Nothing here needs a model, a credential, or the author's machine:
 * it installs the requested official DSH release, installs the packed bundle
 * through the official plugin CLI, and drives the real host.
 *
 * Steps:
 *   1. install the requested DSH release into a throwaway runtime
 *   2. `dsh plugin --profile web add <tarball>` in a fresh $DSH_HOME
 *   3. read-only CLI doctor over the official composition
 *   4. core flow through the official tool registry (inspect/propose/trial/
 *      measure/revert) and memory persistence
 *   5. official pluginManager disable -> enable, asserting live-vs-selected
 *      semantics and unchanged user data
 *   6. CLI uninstall, host boot with the bundle absent, CLI reinstall
 *   7. core flow again, proving the original user data was retained
 *   8. final doctor
 *
 * Usage:
 *   node scripts/acceptance/run-host-acceptance.mjs --host 0.2.0-rc.2 \
 *     [--tarball dist/dsh-evolution-0.2.0-rc.1.tgz] [--out docs/evidence/...] \
 *     [--work <dir>] [--runtime <dir>] [--keep]
 */
import { fork, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPO_ROOT, DIST_DIR, archiveContentDigest, packageFileName, readManifest } from '../release/release-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBES = path.join(HERE, 'probes');

function parseArgs(argv) {
  const options = { keep: false, timeoutMs: 180000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };
    if (arg === '--host') options.host = value();
    else if (arg === '--tarball') options.tarball = path.resolve(value());
    else if (arg === '--out') options.out = path.resolve(value());
    else if (arg === '--work') options.work = path.resolve(value());
    else if (arg === '--runtime') options.runtime = path.resolve(value());
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--timeout-ms') options.timeoutMs = Number(value());
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const HELP = `node scripts/acceptance/run-host-acceptance.mjs --host <dsh-version> [options]

  --host <version>    official @deepseek-ai/dsh release to accept (required)
  --tarball <path>    packed bundle (default: dist/<name>-<version>.tgz)
  --out <path>        evidence JSON (default: docs/evidence/dsh-<host>.json)
  --work <dir>        scratch directory (default: a fresh temp directory)
  --runtime <dir>     reuse an already-prepared runtime instead of installing
  --keep              keep the scratch directory after the run
`;

const options = parseArgs(process.argv.slice(2));
if (options.help) { process.stdout.write(HELP); process.exit(0); }
if (!options.host) { console.error(HELP); process.exit(2); }

const manifest = readManifest();
const supportedHosts = (manifest.peerDependencies['@deepseek-ai/dsh'] || '').split('||').map((v) => v.trim());
if (!supportedHosts.includes(options.host)) {
  console.error(`refusing to run: ${options.host} is not a declared supported host (${supportedHosts.join(', ')})`);
  process.exit(2);
}

const tarball = options.tarball || path.join(DIST_DIR, packageFileName(manifest));
if (!fs.existsSync(tarball)) {
  console.error(`missing tarball ${tarball}; run "npm run release:pack" first`);
  process.exit(2);
}
const tarballSha256 = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
const tarballContentSha256 = archiveContentDigest(tarball);
const outPath = options.out || path.join(REPO_ROOT, 'docs', 'evidence', `dsh-${options.host}.json`);

const work = options.work || fs.mkdtempSync(path.join(os.tmpdir(), `dsh-evolution-accept-${options.host}-`));
fs.mkdirSync(work, { recursive: true });
const runtime = options.runtime || path.join(work, 'runtime');
const home = path.join(work, 'home');
const logs = path.join(work, 'logs');
fs.mkdirSync(logs, { recursive: true });

const evidence = {
  host: options.host,
  packageVersion: manifest.version,
  tarball: path.relative(REPO_ROOT, tarball),
  tarballSha256,
  // The environment-independent identity of the package that was installed:
  // `npm pack` bytes vary with the npm version, the archive content does not.
  contentSha256: tarballContentSha256,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  work,
  startedAt: new Date().toISOString(),
  steps: [],
};

const log = (message) => console.log(`[${options.host}] ${message}`);
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const memoryPath = path.join(home, 'storages', 'evolution', 'evolution-memory.json');
const memorySha = () => (fs.existsSync(memoryPath) ? sha256(memoryPath) : null);
const memoryEntryCount = () => {
  try { return (JSON.parse(fs.readFileSync(memoryPath, 'utf8')).entries || []).length; } catch { return 0; }
};

function record(name, detail) {
  evidence.steps.push({ name, at: new Date().toISOString(), ...detail });
  log(`${name}: ${detail.ok === false ? 'FAILED' : 'ok'}`);
}

/**
 * Evidence is committed to the repository, so local scratch paths are replaced
 * with stable placeholders. Nothing else is rewritten: the recorded versions,
 * exit codes and step results stay exactly as observed.
 */
function redact(value) {
  const json = JSON.stringify(value)
    .split(JSON.stringify(home).slice(1, -1)).join('$DSH_HOME')
    .split(JSON.stringify(work).slice(1, -1)).join('<work>');
  return JSON.parse(json);
}

function cliPath() {
  return path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

function runCommand(command, args, { cwd = work, env = {}, timeoutMs = options.timeoutMs } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (bytes) => { output += bytes.toString(); });
    child.stderr.on('data', (bytes) => { output += bytes.toString(); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, output: `${output}\n${error.message}` }); });
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
  });
}

function runCli(args) {
  return runCommand(process.execPath, [cliPath(), 'plugin', '--profile', 'web', ...args], {
    env: { DSH_HOME: home },
  });
}

function bootProbe(name, probeFile, extraEnv = {}) {
  const patchFile = path.join(work, `${name}.patch.yml`);
  fs.writeFileSync(patchFile, `- insert:\n    - id: evolution-acceptance-${name}\n      name: '${pathToFileURL(probeFile).href}'\n`);
  return new Promise((resolve) => {
    const child = fork(
      cliPath(),
      ['--profile', 'web', '--patch', patchFile, '--', '--no-open', '--host', '127.0.0.1', '--port', '0'],
      { cwd: work, env: { ...process.env, DSH_HOME: home, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    let text = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fs.writeFileSync(path.join(logs, `${name}.log`), text);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
      resolve({ ...value, log: text });
    };
    const timer = setTimeout(() => finish({ error: `${name} timed out after ${options.timeoutMs} ms` }), options.timeoutMs);
    child.stdout.on('data', (bytes) => { text += bytes.toString().replace(/token=\S+/g, 'token=[redacted]'); });
    child.stderr.on('data', (bytes) => { text += bytes.toString(); });
    child.on('message', (message) => {
      if (message?.ready) child.send('run');
      else if (message?.result) finish({ result: message.result });
      else if (message?.error) finish({ error: message.error });
    });
    child.on('exit', (code, signal) => finish({ error: `${name} exited before reporting: ${code ?? signal}` }));
  });
}

function readInstalledModuleVersion(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(runtime, 'node_modules', name, 'package.json'), 'utf8')).version;
  } catch { return null; }
}

/** The version of the bundle the profile currently has installed. */
function installedBundleVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'profiles', 'web', 'node_modules', 'dsh-evolution', 'package.json'), 'utf8')).version;
  } catch { return null; }
}

/** Pack an already-extracted package directory (used for the upgrade artifact). */
function packDirectory(dir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const result = spawnSync('npm', ['pack', '--json', '--pack-destination', destDir, '--ignore-scripts'], { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`npm pack failed in ${dir}: ${(result.stderr || '').split('\n').slice(-5).join('\n')}`);
  const parsed = JSON.parse(result.stdout);
  const info = Array.isArray(parsed) ? parsed[0] : parsed;
  return path.join(destDir, info.filename);
}

function runCommandSync(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  return { code: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

/** Resolve a module version through pnpm's layout when it is not a direct dependency. */
function pnpmModuleVersion(name) {
  const direct = readInstalledModuleVersion(name);
  if (direct) return direct;
  const storeDir = path.join(runtime, 'node_modules', '.pnpm');
  if (!fs.existsSync(storeDir)) return null;
  const prefix = `${name.replace('/', '+')}@`;
  for (const entry of fs.readdirSync(storeDir)) {
    if (!entry.startsWith(prefix)) continue;
    try {
      return JSON.parse(fs.readFileSync(path.join(storeDir, entry, 'node_modules', name, 'package.json'), 'utf8')).version;
    } catch { /* keep looking */ }
  }
  return null;
}

// ---------------------------------------------------------------------------

async function main() {
  log(`work directory ${work}`);

  // 1. install the official host into a throwaway runtime
  if (!fs.existsSync(cliPath())) {
    if (options.runtime) throw new Error(`--runtime ${runtime} does not contain @deepseek-ai/dsh/lib/bin.js`);
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({
      name: `dsh-evolution-acceptance-${options.host}`,
      version: '0.0.0',
      private: true,
      type: 'module',
      dependencies: { '@deepseek-ai/dsh': options.host },
      packageManager: 'pnpm@11.26.0',
    }, null, 2));
    log(`installing @deepseek-ai/dsh@${options.host}`);
    const installed = await runCommand('pnpm', ['install', '--config.strict-dep-builds=false'], { cwd: runtime });
    record('host-install', { ok: installed.code === 0, code: installed.code, tail: installed.output.trim().split('\n').slice(-4) });
    if (installed.code !== 0) throw new Error(`pnpm install failed: ${installed.output.split('\n').slice(-8).join('\n')}`);
  } else {
    record('host-install', { ok: true, reused: true });
  }

  const hostVersion = JSON.parse(fs.readFileSync(path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version;
  evidence.hostVersion = hostVersion;
  evidence.hostModules = Object.fromEntries(
    ['@deepseek-ai/cordis', '@deepseek-ai/cordis-plugin-include', '@deepseek-ai/cordis-plugin-loader'].map((name) => [name, pnpmModuleVersion(name)]),
  );
  if (hostVersion !== options.host) throw new Error(`installed host ${hostVersion} does not match requested ${options.host}`);

  // 2. install the bundle through the official CLI
  const added = await runCli(['add', tarball]);
  record('plugin-add', { ok: added.code === 0, code: added.code, tail: added.output.trim().split('\n').slice(-3) });
  if (added.code !== 0) throw new Error(`dsh plugin add failed: ${added.output.split('\n').slice(-8).join('\n')}`);
  const profileManifest = JSON.parse(fs.readFileSync(path.join(home, 'profiles', 'web', 'package.json'), 'utf8'));
  const listed = (profileManifest.dsh?.profile?.bundles || []).includes('dsh-evolution');
  record('profile-lists-bundle', { ok: listed, bundles: profileManifest.dsh?.profile?.bundles });
  if (!listed) throw new Error('the installed profile does not list dsh-evolution');

  const installedDoctor = path.join(home, 'profiles', 'web', 'node_modules', 'dsh-evolution', 'scripts', 'doctor.mjs');
  const doctor = (label) => runCommand(process.execPath, [installedDoctor, '--home', home, '--dsh-cli', cliPath(), '--json'], { env: { DSH_HOME: home } });

  // 3. read-only CLI doctor
  const firstDoctor = await doctor();
  let report = null;
  try { report = JSON.parse(firstDoctor.output); } catch { /* reported below */ }
  const doctorCheck = (id) => report?.checks?.find((check) => check.id === id);
  const versionCheck = doctorCheck('host.version');
  record('doctor-cli', {
    ok: Boolean(report) && report.status !== 'blocked',
    status: report?.status,
    exitCode: firstDoctor.code,
    hostVersion: versionCheck?.evidence?.found,
    verified: versionCheck?.evidence?.verified,
    degraded: report?.summary?.degraded,
    blocked: report?.summary?.blocked,
  });
  if (!report) throw new Error(`the CLI doctor did not produce JSON (exit ${firstDoctor.code})`);
  if (report.status === 'blocked') throw new Error('the CLI doctor reports a blocked install');
  if (versionCheck?.evidence?.verified !== true) throw new Error(`host.version did not report the host as verified: ${JSON.stringify(versionCheck?.evidence)}`);
  const moduleCheck = doctorCheck('host.modules');
  if (moduleCheck?.evidence?.modules) {
    evidence.hostModules = Object.fromEntries(moduleCheck.evidence.modules.map((module) => [module.name, module.version]));
  }
  evidence.doctor = {
    status: report.status,
    coverage: report.coverage,
    degradedCapabilities: report.degradedCapabilities,
    levels: Object.fromEntries(report.checks.map((check) => [check.id, check.level])),
    findings: report.checks
      .filter((check) => check.level !== 'ok')
      .map((check) => ({ id: check.id, level: check.level, summary: check.summary })),
  };

  // 4. core flow through the real host
  const coreFile = path.join(PROBES, 'core-probe.mjs');
  const firstCore = await bootProbe('core-1', coreFile, { EVOLUTION_ACCEPTANCE_CWD: work });
  const firstCoreOk = Boolean(firstCore.result)
    && firstCore.result.toolCount === 9
    && firstCore.result.reverted === true
    && firstCore.result.memoryPersisted === true;
  record('core-flow', {
    ok: firstCoreOk,
    toolCount: firstCore.result?.toolCount,
    tools: firstCore.result?.tools,
    steps: firstCore.result?.steps,
    reverted: firstCore.result?.reverted,
    cleanupProof: firstCore.result?.cleanupProof,
    signatureDiff: firstCore.result?.signatureDiff,
    memoryPersisted: firstCore.result?.memoryPersisted,
    error: firstCore.error,
  });
  if (firstCore.error) throw new Error(`core flow probe failed: ${firstCore.error}`);
  if (!firstCoreOk) throw new Error(`core flow did not complete cleanly (reverted=${firstCore.result?.reverted}, tools=${firstCore.result?.toolCount})`);
  evidence.memoryShaAfterCore = memorySha();

  // 5. official pluginManager disable -> enable
  const lifecycleFile = path.join(PROBES, 'lifecycle-probe.mjs');
  for (const action of ['verify', 'disable', 'enable', 'verify']) {
    const outcome = await bootProbe(`lifecycle-${action}-${evidence.steps.length}`, lifecycleFile, { EVOLUTION_LIFECYCLE_ACTION: action });
    record(`lifecycle-${action}`, {
      ok: Boolean(outcome.result) && outcome.result.memoryUnchanged === true,
      result: outcome.result,
      error: outcome.error,
    });
    if (outcome.error) throw new Error(`lifecycle ${action} failed: ${outcome.error}`);
  }

  // 6. official CLI uninstall, body boot, CLI reinstall
  const beforeUninstall = memorySha();
  const memoryEntriesAtUninstall = memoryEntryCount();
  const removed = await runCli(['remove', 'dsh-evolution']);
  record('plugin-remove', { ok: removed.code === 0, code: removed.code, tail: removed.output.trim().split('\n').slice(-3) });
  if (removed.code !== 0) throw new Error(`dsh plugin remove failed: ${removed.output.split('\n').slice(-8).join('\n')}`);
  if (memorySha() !== beforeUninstall) throw new Error('uninstall changed Evolution user data');

  const bodyFile = path.join(PROBES, 'body-probe.mjs');
  const body = await bootProbe('body', bodyFile);
  record('body-after-uninstall', {
    ok: Boolean(body.result?.bodyOk) && body.result?.evolutionAbsent === true && body.result?.evolutionTools === 0,
    result: body.result,
    error: body.error,
  });
  if (body.error) throw new Error(`the host body failed to boot after uninstall: ${body.error}`);

  const reinstalled = await runCli(['add', tarball]);
  record('plugin-reinstall', { ok: reinstalled.code === 0, code: reinstalled.code, tail: reinstalled.output.trim().split('\n').slice(-3) });
  if (reinstalled.code !== 0) throw new Error(`dsh plugin add failed on reinstall: ${reinstalled.output.split('\n').slice(-8).join('\n')}`);

  // 7. core flow again: the original data must come back unchanged
  const secondCore = await bootProbe('core-2', coreFile, { EVOLUTION_ACCEPTANCE_CWD: work });
  const secondCoreOk = Boolean(secondCore.result)
    && secondCore.result.toolCount === 9
    && secondCore.result.existingMemoryRetained === true;
  record('core-flow-after-reinstall', {
    ok: secondCoreOk,
    toolCount: secondCore.result?.toolCount,
    reverted: secondCore.result?.reverted,
    memoryEntriesBefore: secondCore.result?.memoryEntriesBefore,
    memoryEntriesAfter: secondCore.result?.memoryEntriesAfter,
    existingMemoryRetained: secondCore.result?.existingMemoryRetained,
    signatureDiff: secondCore.result?.signatureDiff,
    error: secondCore.error,
  });
  if (secondCore.error) throw new Error(`core flow after reinstall failed: ${secondCore.error}`);
  if (!secondCoreOk) throw new Error('core flow after reinstall did not retain the original memory');
  evidence.memoryShaBeforeUninstall = beforeUninstall;
  evidence.memoryEntriesAtUninstall = memoryEntriesAtUninstall;
  evidence.memoryEntriesAfterReinstall = memoryEntryCount();
  evidence.memoryShaAfterReinstall = memorySha();
  if (evidence.memoryShaAfterReinstall === null) throw new Error('reinstall lost the Evolution memory file');
  if (evidence.memoryEntriesAfterReinstall < memoryEntriesAtUninstall) {
    throw new Error(`reinstall lost memory entries: ${memoryEntriesAtUninstall} -> ${evidence.memoryEntriesAfterReinstall}`);
  }

  // 7b. the README upgrade and rollback flows, exercised for real: install a
  //     re-versioned build of this same tree over the current one, then put the
  //     current tarball back. Both steps must keep the profile working and the
  //     Evolution user data byte-identical.
  const upgradeRoot = path.join(work, 'upgrade');
  fs.rmSync(upgradeRoot, { recursive: true, force: true });
  fs.mkdirSync(upgradeRoot, { recursive: true });
  const extracted = runCommandSync('tar', ['-xzf', tarball, '-C', upgradeRoot]);
  if (extracted.code !== 0) throw new Error(`could not unpack ${tarball}: ${extracted.output}`);
  const upgradeSource = path.join(upgradeRoot, 'package');
  const upgradeVersion = `${manifest.version}.upgrade`;
  const upgradeManifestPath = path.join(upgradeSource, 'package.json');
  const upgradeManifest = JSON.parse(fs.readFileSync(upgradeManifestPath, 'utf8'));
  upgradeManifest.version = upgradeVersion;
  fs.writeFileSync(upgradeManifestPath, `${JSON.stringify(upgradeManifest, null, 2)}\n`);
  const upgradeTarball = packDirectory(upgradeSource, upgradeRoot);
  evidence.upgradeRollback = { from: manifest.version, to: upgradeVersion };

  const beforeUpgrade = memorySha();
  const upgraded = await runCli(['add', upgradeTarball]);
  record('cli-upgrade', {
    ok: upgraded.code === 0 && installedBundleVersion() === upgradeVersion,
    code: upgraded.code,
    installedVersion: installedBundleVersion(),
    tail: upgraded.output.trim().split('\n').slice(-3),
  });
  if (upgraded.code !== 0) throw new Error(`dsh plugin add (upgrade) failed: ${upgraded.output.split('\n').slice(-8).join('\n')}`);
  if (installedBundleVersion() !== upgradeVersion) throw new Error(`upgrade left version ${installedBundleVersion()}`);
  const upgradedLifecycle = await bootProbe('lifecycle-after-upgrade', path.join(PROBES, 'lifecycle-probe.mjs'), { EVOLUTION_LIFECYCLE_ACTION: 'verify' });
  record('host-after-upgrade', {
    ok: Boolean(upgradedLifecycle.result) && upgradedLifecycle.result.toolCount === 9 && upgradedLifecycle.result.memoryUnchanged === true,
    result: upgradedLifecycle.result,
    error: upgradedLifecycle.error,
  });
  if (upgradedLifecycle.error) throw new Error(`the host failed after upgrade: ${upgradedLifecycle.error}`);
  if (memorySha() !== beforeUpgrade) throw new Error('the upgrade changed Evolution user data');

  const rolledBack = await runCli(['add', tarball]);
  record('cli-rollback', {
    ok: rolledBack.code === 0 && installedBundleVersion() === manifest.version,
    code: rolledBack.code,
    installedVersion: installedBundleVersion(),
    tail: rolledBack.output.trim().split('\n').slice(-3),
  });
  if (rolledBack.code !== 0) throw new Error(`dsh plugin add (rollback) failed: ${rolledBack.output.split('\n').slice(-8).join('\n')}`);
  if (installedBundleVersion() !== manifest.version) throw new Error(`rollback left version ${installedBundleVersion()}`);
  const rolledBackLifecycle = await bootProbe('lifecycle-after-rollback', path.join(PROBES, 'lifecycle-probe.mjs'), { EVOLUTION_LIFECYCLE_ACTION: 'verify' });
  record('host-after-rollback', {
    ok: Boolean(rolledBackLifecycle.result) && rolledBackLifecycle.result.toolCount === 9 && rolledBackLifecycle.result.memoryUnchanged === true,
    result: rolledBackLifecycle.result,
    error: rolledBackLifecycle.error,
  });
  if (rolledBackLifecycle.error) throw new Error(`the host failed after rollback: ${rolledBackLifecycle.error}`);
  if (memorySha() !== beforeUpgrade) throw new Error('the rollback changed Evolution user data');
  evidence.upgradeRollback.preservedUserData = true;

  // 8. real promotion through the official Include adapter, across restarts.
  //    The promote phase commits the candidate at the startup barrier, the
  //    restart-and-rollback phase proves the committed listener survived a real
  //    restart and that a canary regression removes only the new candidate, and
  //    the verify phase re-checks the committed state after a further restart.
  const promotionFile = path.join(PROBES, 'promotion-probe.mjs');
  evidence.promotion = {};
  for (const command of ['promote', 'restart-and-rollback', 'verify']) {
    const outcome = await bootProbe(`promotion-${command}`, promotionFile, {
      EVOLUTION_PROMOTION_COMMAND: command,
      EVOLUTION_ACCEPTANCE_CWD: work,
    });
    const result = outcome.result;
    const ok = !outcome.error && Boolean(result) && (
      command === 'promote' ? result.promotedListener === true
        : command === 'restart-and-rollback' ? result.rollbackVerified === true
          : result.verified === true);
    record(`promotion-${command}`, {
      ok,
      steps: result?.steps?.map((step) => ({ name: step.name, ok: step.ok, phase: step.phase })),
      startupPhase: result?.startup?.phase,
      committed: result?.promotion?.durable,
      rolledBack: result?.rollbackPromotion?.durable,
      error: outcome.error,
    });
    if (outcome.error) throw new Error(`promotion ${command} failed: ${outcome.error}`);
    if (!ok) throw new Error(`promotion ${command} did not reach its expected end state`);
    evidence.promotion[command] = {
      ok,
      startupPhase: result?.startup?.phase,
      committed: result?.promotion?.durable,
      rolledBack: result?.rollbackPromotion?.durable,
    };
  }

  const finalDoctor = await runCommand(process.execPath, [installedDoctor, '--home', home, '--dsh-cli', cliPath(), '--json'], { env: { DSH_HOME: home } });
  let finalReport = null;
  try { finalReport = JSON.parse(finalDoctor.output); } catch { /* reported below */ }
  record('doctor-final', {
    ok: Boolean(finalReport) && finalReport.status !== 'blocked',
    status: finalReport?.status,
    exitCode: finalDoctor.code,
    findings: finalReport?.checks?.filter((check) => check.level !== 'ok').map((check) => ({ id: check.id, level: check.level, summary: check.summary })),
  });
  if (!finalReport) throw new Error('the final doctor did not produce JSON');
  if (finalReport.status === 'blocked') throw new Error('the final doctor reports a blocked install');

  evidence.ok = evidence.steps.every((step) => step.ok !== false);
  evidence.finishedAt = new Date().toISOString();
  return evidence;
}

let failure = null;
try {
  await main();
} catch (error) {
  failure = String(error.stack || error);
  evidence.ok = false;
  evidence.error = failure;
  evidence.finishedAt = new Date().toISOString();
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(redact(evidence), null, 2)}\n`);
log(`evidence written to ${path.relative(REPO_ROOT, outPath)}`);

if (!options.keep && !options.work) {
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
}

if (failure) {
  console.error(failure);
  process.exit(1);
}
console.log(JSON.stringify({ host: evidence.host, ok: evidence.ok, steps: evidence.steps.map((step) => ({ name: step.name, ok: step.ok })) }));
