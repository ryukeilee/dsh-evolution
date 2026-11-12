#!/usr/bin/env node
/**
 * Reproduce / regress the ACP promoted-consumer shutdown-state defect.
 *
 * 0.2.8's consumer writes one state file per profile under
 * $DSH_HOME/storages/evolution/shared-plugins/consumers/<profile>.json. A
 * session that is closed while it is mounting cannot mount anymore: its own
 * Cordis context is inactive, the official Include reports INACTIVE_EFFECT, and
 * the failed startup report (or the disposal of an empty session) overwrites the
 * active report another live ACP session already wrote. The read-side review
 * then reports the plugin as host-unavailable / restart-required with a
 * restart-consumer action even though a real session has it mounted.
 *
 * This runner is self-contained and isolated:
 *
 *   1. creates a temporary DSH_HOME (never ~/.dsh; the runner refuses the real
 *      home and the repository tree) and installs the packed tarball into the
 *      acp profile through the official CLI, then applies the same managed
 *      profile patch scripts/setup-experience.mjs uses. It never starts the
 *      Desktop application.
 *   2. writes one promoted-plugin fixture (published/dsh-evolution-promoted-12hex,
 *      a tool plus an event marker) and a published.json record shaped like the
 *      Desktop publisher's output.
 *   3. boots the real ACP entry once to calibrate the record host from the
 *      consumer state, rewrites the index, and boots again until the baseline
 *      row is active. A probe receipt proves the promoted tool is registered
 *      and (when the live definition exposes execute) callable.
 *   4. saves the baseline acp.json bytes and, for each attempt, atomically
 *      restores them, spawns a fresh ACP entry, waits for the consumer to claim
 *      the profile (sessionId changes), immediately sends SIGTERM (a session
 *      closed during startup), waits for exit and records the final state. The
 *      read-side review (lib/self-evolution-review.js#readPublishedPluginReview)
 *      is then run against that final state.
 *   5. switches the installed implementation between the two phases by
 *      replacing only the lib/*.js files that differ from git HEAD inside
 *      <home>/profiles/acp/node_modules/dsh-evolution: pre-fix writes the
 *      git show HEAD:<rel> bytes, fixed writes the current worktree bytes. The
 *      worktree itself is never modified.
 *
 * Usage:
 *   node scripts/acceptance/reproduce-consumer-shutdown-state.mjs \
 *     --tarball dist/dsh-evolution-0.2.8.tgz \
 *     --out docs/evidence/promoted-consumer-shutdown-state-20261113.json \
 *     --phase pre-fix --attempts 8
 *
 * Exit codes: 0 the phase expectation is satisfied, 1 it is not, 2 setup failed
 * (the evidence still records the failure and the last known facts).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { REPO_ROOT } from '../release/release-lib.mjs';
import { managedPatch } from '../setup-experience.mjs';
import { readPublishedPluginReview } from '../../lib/self-evolution-review.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(HERE, 'probes', 'consumer-abort-probe.mjs');
const DEFAULT_CLI = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const REAL_HOME = path.resolve(process.env.HOME || os.homedir(), '.dsh');
const PROFILE = 'acp';
const INITIALIZE = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }) + '\n';

/** Every inherited DSH_* / EVOLUTION_* value belongs to the driving session. */
const INHERITED_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_') && !key.startsWith('EVOLUTION_')),
);

function log(message) {
  process.stdout.write('[consumer-shutdown] ' + message + '\n');
}

function parseArgs(argv) {
  const options = { attempts: 8, timeoutMs: 90000, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(arg + ' requires a value');
      index += 1;
      return next;
    };
    if (arg === '--tarball') options.tarball = path.resolve(value());
    else if (arg === '--out') options.out = path.resolve(value());
    else if (arg === '--phase') options.phase = value();
    else if (arg === '--attempts') options.attempts = Number(value());
    else if (arg === '--work') options.work = path.resolve(value());
    else if (arg === '--cli') options.cli = path.resolve(value());
    else if (arg === '--timeout-ms') options.timeoutMs = Number(value());
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error('unknown argument: ' + arg);
  }
  return options;
}

const HELP = [
  'node scripts/acceptance/reproduce-consumer-shutdown-state.mjs --tarball <packed.tgz> --out <evidence.json> --phase <pre-fix|fixed> [options]',
  '',
  '  --tarball <path>   packed bundle (required; npm run release:pack or npm pack)',
  '  --out <path>       evidence JSON (required)',
  '  --phase <name>     pre-fix (git HEAD implementation) | fixed (worktree)',
  '  --attempts <n>     number of shutdown-during-startup attempts (default 8)',
  '  --work <dir>       scratch directory (default: a fresh temp directory)',
  '  --cli <path>       official dsh CLI (default: the Desktop runtime CLI)',
  '  --timeout-ms <n>   per-boot timeout (default 90000)',
  '  --keep             keep the scratch directory (logs and injected files)',
  '',
].join('\n');

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (!options.tarball) throw new Error('--tarball is required\n' + HELP);
if (!options.out) throw new Error('--out is required\n' + HELP);
if (options.phase !== 'pre-fix' && options.phase !== 'fixed') {
  throw new Error('--phase must be "pre-fix" or "fixed"');
}
if (!Number.isInteger(options.attempts) || options.attempts < 1) {
  throw new Error('--attempts must be a positive integer');
}

const cli = options.cli || (fs.existsSync(DEFAULT_CLI) ? DEFAULT_CLI : 'dsh');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isInside = (child, parent) => child === parent || child.startsWith(parent + path.sep);

const evidence = {
  schemaVersion: 1,
  kind: 'dsh-evolution-promoted-consumer-shutdown-state',
  phase: options.phase,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  result: null,
  error: null,
};

const work = options.work || fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-evolution-consumer-shutdown-' + options.phase + '-'));
const home = path.join(work, 'home');
const logs = path.join(work, 'logs');
const dataRoot = path.join(home, 'storages', 'evolution');
const sharedDir = path.join(dataRoot, 'shared-plugins');
const consumersDir = path.join(sharedDir, 'consumers');
const statePath = path.join(consumersDir, PROFILE + '.json');
const indexPath = path.join(sharedDir, 'published.json');
const pkgDir = path.join(home, 'profiles', PROFILE, 'node_modules', 'dsh-evolution');
const profilePatch = path.join(home, 'profiles', PROFILE, 'cordis.patch.yml');

/** Evidence files are repository artifacts: never leak the scratch/home paths. */
function project(value) {
  if (typeof value === 'string') {
    // Replace inside longer strings too: child-log tails quote absolute paths.
    return value
      .split(REPO_ROOT).join('<repo>')
      .split(home).join('$DSH_HOME')
      .split(work).join('<work>');
  }
  if (Array.isArray(value)) return value.map(project);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, project(item)]));
  }
  return value;
}

function assertIsolatedHome(target) {
  const resolved = path.resolve(target);
  if (resolved === REAL_HOME) throw new Error('refusing to use the real DSH home');
  if (isInside(resolved, REAL_HOME)) throw new Error('refusing a home inside the real DSH home');
  if (isInside(REAL_HOME, resolved)) throw new Error('refusing a home that contains the real DSH home');
  if (isInside(resolved, path.resolve(REPO_ROOT))) throw new Error('refusing a home inside the repository worktree');
  return resolved;
}

function readBytes(file) {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function readJson(file) {
  const bytes = readBytes(file);
  if (bytes === null) return { status: 'absent', value: null, bytes: null };
  try {
    return { status: 'ok', value: JSON.parse(bytes.toString('utf8')), bytes };
  } catch {
    return { status: 'invalid', value: null, bytes };
  }
}

function atomicWrite(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + process.pid + '-' + crypto.randomBytes(4).toString('hex') + '.tmp';
  const handle = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temp, file);
  try {
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } catch {
    // Directory fsync is a durability improvement, not a correctness gate.
  }
}

function runCommand(command, args, { cwd = REPO_ROOT, env = {}, timeout = options.timeoutMs } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...INHERITED_ENV, ...env },
    encoding: 'utf8',
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    code: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

function git(args, { encoding = 'utf8' } = {}) {
  return spawnSync('git', ['-C', REPO_ROOT, ...args], {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs,
  });
}

function changedLibFiles() {
  const tracked = (git(['diff', '--name-only', 'HEAD', '--', 'lib/']).stdout || '')
    .split('\n').map((line) => line.trim()).filter(Boolean);
  const untracked = (git(['ls-files', '--others', '--exclude-standard', '--', 'lib/']).stdout || '')
    .split('\n').map((line) => line.trim()).filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort();
}

function gitHeadFile(rel) {
  const result = git(['show', 'HEAD:' + rel], { encoding: 'buffer' });
  if (result.status !== 0) return null;
  return result.stdout;
}

/** Resolve a spawned child's stdout/stderr to one scratch log plus a bounded tail. */
function childLog(label) {
  const file = path.join(logs, label + '.log');
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  const stream = fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
  let tail = '';
  const record = (bytes) => {
    stream.write(bytes);
    tail = (tail + bytes.toString('utf8')).slice(-8000);
  };
  return { file, stream, record, tail: () => tail };
}

function spawnAcp({ label, patchFile, extraEnv = {} }) {
  const sink = childLog(label);
  const child = spawn(cli, ['--profile', PROFILE, '--patch', patchFile], {
    cwd: home,
    env: { ...INHERITED_ENV, DSH_HOME: home, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', sink.record);
  child.stderr.on('data', sink.record);
  child.once('exit', () => { try { sink.stream.end(); } catch { /* closed */ } });
  try {
    child.stdin.write(INITIALIZE);
  } catch {
    // The boot failure is reported by the receipt/exit wait.
  }
  return { child, sink };
}

function stopChild(child, timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once('exit', (code, signal) => finish({ code, signal }));
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    setTimeout(() => {
      if (settled) return;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      setTimeout(() => finish({ code: child.exitCode, signal: child.signalCode ?? 'SIGKILL' }), 5000).unref?.();
    }, timeoutMs).unref?.();
  });
}

/** Read the consumer state until its bytes stop changing for a quiet interval. */
async function settleState(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    const bytes = readBytes(statePath);
    const digest = bytes ? sha256(bytes) : null;
    if (digest !== last) {
      last = digest;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= 250) {
      return bytes;
    }
    await sleep(50);
  }
  return readBytes(statePath);
}

async function waitFor(predicate, { label, timeoutMs = options.timeoutMs, intervalMs = 50, child = null }) {
  const deadline = Date.now() + timeoutMs;
  let exited = null;
  if (child) child.once('exit', (code, signal) => { exited = { code, signal }; });
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    if (exited) throw new Error(label + ': the ACP entry exited early (' + (exited.code ?? exited.signal) + ')');
    await sleep(intervalMs);
  }
  throw new Error(label + ': timed out after ' + timeoutMs + ' ms');
}

/** Wait for the JSON receipt the probe writes after the promoted tree settled. */
async function waitReceipt(file, child, timeoutMs) {
  return waitFor(() => {
    const receipt = readJson(file);
    return receipt.status === 'ok' ? receipt.value : null;
  }, { label: 'probe receipt ' + path.basename(file), timeoutMs, child, intervalMs: 100 });
}

function summarizeRows(state) {
  return (Array.isArray(state?.plugins) ? state.plugins : []).map((row) => ({
    id: row?.id ?? null,
    status: row?.status ?? null,
    reason: row?.reason ?? null,
    sourceSha256: row?.sourceSha256 ?? null,
    activatedAt: row?.activatedAt ?? null,
    errorCode: row?.errorCode ?? null,
  }));
}

function summarizeState(state) {
  if (!state || typeof state !== 'object') return null;
  return {
    sessionId: typeof state.sessionId === 'string' ? state.sessionId : null,
    updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : null,
    observedIndexUpdatedAt: typeof state.observedIndexUpdatedAt === 'string' ? state.observedIndexUpdatedAt : null,
    disposedAt: typeof state.disposedAt === 'string' ? state.disposedAt : null,
    disposal: state.disposal && typeof state.disposal === 'object' ? state.disposal : null,
    host: state.host && typeof state.host === 'object' ? {
      profile: state.host.profile ?? null,
      dsh: state.host.dsh ?? null,
      cordis: state.host.cordis ?? null,
      include: state.host.include ?? null,
      node: state.host.node ?? null,
    } : null,
    rows: summarizeRows(state),
  };
}

async function runReview(host) {
  const review = await readPublishedPluginReview({
    paths: { dataRoot },
    host: host && typeof host === 'object' ? host : null,
  });
  return {
    status: review.status,
    summary: review.summary,
    nextActions: review.nextActions,
    nextActionsDropped: review.nextActionsDropped,
    consumers: review.consumers,
    records: review.records,
  };
}

/** One install + fixture + baseline + attempts run. Throws on setup failure. */
async function run() {
  assertIsolatedHome(home);
  fs.mkdirSync(work, { recursive: true, mode: 0o700 });
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  fs.mkdirSync(consumersDir, { recursive: true, mode: 0o700 });

  // ---------------------------------------------------------------------
  // installation through the official CLI (official profile initialization)
  // ---------------------------------------------------------------------
  const tarballBytes = fs.readFileSync(options.tarball);
  const tarballSha256 = sha256(tarballBytes);
  const cacheDir = path.join(home, 'storages', 'evolution-package-cache');
  const artifact = path.join(cacheDir, tarballSha256 + '.tgz');
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const cached = readBytes(artifact);
  if (!cached || !cached.equals(tarballBytes)) atomicWrite(artifact, tarballBytes);

  const version = runCommand(cli, ['--version'], { cwd: home, env: { DSH_HOME: home }, timeout: 30000 });
  log('official CLI: ' + (version.stdout.trim() || version.stderr.trim() || 'unknown'));
  const install = runCommand(cli, ['plugin', '--profile', PROFILE, 'add', artifact], { cwd: home, env: { DSH_HOME: home } });
  if (install.code !== 0) {
    throw new Error('official plugin add failed (' + (install.code ?? install.signal) + '): ' + (install.stderr || install.stdout).slice(-2000));
  }
  if (!fs.existsSync(pkgDir)) throw new Error('the official CLI did not install the bundle into the acp profile');

  const currentPatch = readBytes(profilePatch)?.toString('utf8') ?? '';
  // The probe entry is inserted per boot through --patch (a profile patch that
  // also named it would insert the same id twice). The managed block only
  // selects the consumer role for this profile.
  atomicWrite(profilePatch, Buffer.from(managedPatch(currentPatch, PROFILE), 'utf8'));

  // ---------------------------------------------------------------------
  // pin the implementation this phase is supposed to test
  // ---------------------------------------------------------------------
  const changed = changedLibFiles();
  let dereferenced = false;
  const stat = fs.lstatSync(pkgDir);
  if (stat.isSymbolicLink()) {
    const real = fs.realpathSync(pkgDir);
    const temp = pkgDir + '.isolated-' + process.pid;
    fs.cpSync(real, temp, { recursive: true, dereference: true, preserveTimestamps: true });
    fs.rmSync(pkgDir, { force: true });
    fs.renameSync(temp, pkgDir);
    dereferenced = true;
  }
  const replacements = [];
  for (const rel of changed) {
    const dest = path.join(pkgDir, rel);
    const before = readBytes(dest);
    let bytes;
    let source;
    if (options.phase === 'pre-fix') {
      bytes = gitHeadFile(rel);
      source = 'HEAD';
    } else {
      const abs = path.join(REPO_ROOT, rel);
      bytes = fs.existsSync(abs) ? fs.readFileSync(abs) : null;
      source = 'working-tree';
    }
    if (bytes === null) {
      if (before !== null) fs.rmSync(dest, { force: true });
    } else if (before === null || !before.equals(bytes)) {
      atomicWrite(dest, bytes);
    }
    const after = readBytes(dest);
    replacements.push({
      rel,
      source,
      present: after !== null,
      sha256: after ? sha256(after) : null,
      beforeSha256: before ? sha256(before) : null,
      contentChanged: after !== null && (before === null || !before.equals(after)),
    });
  }

  const libFiles = [];
  const walk = (directory, prefix = '') => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = path.join(prefix, entry.name);
      if (entry.isDirectory()) walk(path.join(directory, entry.name), rel);
      else if (entry.isFile() && entry.name.endsWith('.js')) libFiles.push({ rel, sha256: sha256(fs.readFileSync(path.join(directory, entry.name))) });
    }
  };
  walk(path.join(pkgDir, 'lib'));
  const packageLibDigest = sha256(libFiles.map((file) => file.rel + ':' + file.sha256).join('\n'));
  const packageVersion = readJson(path.join(pkgDir, 'package.json')).value?.version ?? null;

  evidence.invocation = ['node', 'scripts/acceptance/reproduce-consumer-shutdown-state.mjs']
    .concat(process.argv.slice(2).map((arg) => (arg === options.tarball ? '<tarball>' : arg === options.out ? '<out>' : arg)));
  evidence.isolation = {
    home: project(home),
    work: project(work),
    realHomeRefused: true,
    workIsTemporary: isInside(work, os.tmpdir()),
  };
  evidence.environment = {
    runner: { node: process.version, platform: process.platform + '-' + process.arch },
    cli: { path: project(cli), version: (version.stdout || '').trim() || null },
    dsh: (version.stdout || '').trim() || null,
    repo: {
      root: '<repo>',
      head: (git(['rev-parse', 'HEAD']).stdout || '').trim(),
      branch: (git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout || '').trim(),
      libDiffFiles: changed,
    },
  };
  evidence.install = {
    tarball: { name: path.basename(options.tarball), sha256: tarballSha256, bytes: tarballBytes.length },
    artifact: project(artifact),
    profile: PROFILE,
    packageVersion,
    packageDir: project(pkgDir),
    dereferencedSymlink: dereferenced,
    profilePatch: project(profilePatch),
    packageLibDigest,
    packageLibFileCount: libFiles.length,
  };
  evidence.implementation = { phase: options.phase, changedLibFiles: changed, replacements };

  // ---------------------------------------------------------------------
  // promoted-plugin fixture
  // ---------------------------------------------------------------------
  const runId = crypto.randomBytes(8).toString('hex');
  const experimentId = 'exp-consumer-shutdown-' + runId;
  const recordId = 'evolution-promoted-' + sha256(experimentId).slice(0, 12);
  const pluginName = 'dsh-' + recordId;
  const toolName = 'consumer_abort_probe_' + runId.slice(0, 6);
  const markerName = 'consumer-abort/' + runId + '/marker';
  const pluginRoot = path.join(dataRoot, 'promoted');
  const pluginDir = path.join(pluginRoot, pluginName);
  const modulePath = path.join(pluginDir, 'lib', 'index.js');
  const manifestPath = path.join(pluginDir, 'package.json');
  const moduleSource = [
    'export const name = ' + JSON.stringify(pluginName) + ';',
    "export const inject = ['tools'];",
    'export function apply(ctx) {',
    '  ctx.tools.register({',
    '    name: ' + JSON.stringify(toolName) + ',',
    "    description: 'Isolated promoted consumer-shutdown probe tool.',",
    "    parameters: { type: 'object', properties: {} },",
    "    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },",
    '    isConcurrencySafe: () => true,',
    '    async execute() { return { ok: true, tool: ' + JSON.stringify(toolName) + ' }; },',
    '  });',
    '  ctx.on(' + JSON.stringify(markerName) + ', (payload) => { if (payload && typeof payload === \'object\') payload.hits = (payload.hits ?? 0) + 1; });',
    '}',
    '',
  ].join('\n');
  fs.mkdirSync(path.join(pluginDir, 'lib'), { recursive: true, mode: 0o700 });
  atomicWrite(modulePath, Buffer.from(moduleSource, 'utf8'));
  atomicWrite(manifestPath, Buffer.from(JSON.stringify({ name: pluginName, version: '1.0.0', type: 'module', main: 'lib/index.js' }, null, 2) + '\n', 'utf8'));
  const sourceSha256 = sha256(readBytes(modulePath));
  const manifestSha256 = sha256(readBytes(manifestPath));

  // ---------------------------------------------------------------------
  // calibration boot: the record host identity comes from the live consumer
  // ---------------------------------------------------------------------
  const probePatch = path.join(work, 'probe.patch.yml');
  atomicWrite(probePatch, Buffer.from('- insert:\n    - id: consumer-abort-probe\n      name: ' + JSON.stringify(pathToFileURL(PROBE).href) + '\n', 'utf8'));

  function probeEnv(label, receiptPath) {
    return {
      EVOLUTION_ENTRY_PROBE_OUT: receiptPath,
      EVOLUTION_CONSUMER_ABORT_TOOL: toolName,
      EVOLUTION_CONSUMER_ABORT_MARKER: markerName,
      EVOLUTION_CONSUMER_ABORT_STATE: statePath,
      EVOLUTION_CONSUMER_ABORT_PROFILE: PROFILE,
      EVOLUTION_CONSUMER_ABORT_LABEL: label,
    };
  }

  async function bootWithProbe(label) {
    const receiptPath = path.join(work, 'receipts', label + '.json');
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
    const { child, sink } = spawnAcp({ label, patchFile: probePatch, extraEnv: probeEnv(label, receiptPath) });
    let receipt;
    try {
      receipt = await waitReceipt(receiptPath, child, options.timeoutMs);
    } catch (error) {
      await stopChild(child);
      throw new Error(label + ': ' + error.message + '\n' + sink.tail().slice(-3000));
    }
    return { child, receipt, receiptPath, logTail: () => sink.tail() };
  }

  log('calibration boot');
  const calibration = await bootWithProbe('calibration');
  const calibrationState = readJson(statePath);
  const calibrationHost = calibrationState.value?.host;
  if (!calibrationHost
    || ['dsh', 'cordis', 'include', 'node'].some((key) => typeof calibrationHost[key] !== 'string' || calibrationHost[key].trim() === '')) {
    await stopChild(calibration.child);
    throw new Error('the calibration boot did not publish a complete host identity: ' + JSON.stringify(calibrationHost));
  }
  await stopChild(calibration.child);
  await settleState();
  const calBytes = readBytes(statePath);

  const record = {
    id: recordId,
    schemaVersion: 1,
    experimentId,
    pluginName,
    moduleUrl: pathToFileURL(modulePath).href,
    entry: 'lib/index.js',
    sourceSha256,
    manifestSha256,
    publisherProfile: 'desktop',
    approvedProfiles: [PROFILE],
    stable: {
      committedAt: '2026-01-01T00:00:00.000Z',
      promotionTimestamp: '2026-01-01T00:00:00.000Z',
      decision: 'benefit',
      canary: { healthObservationWindow: 2, observations: 2, startupVerified: true },
    },
    requiredServices: ['tools'],
    serviceMembers: {},
    requiredCapabilities: ['fiberLifecycle', 'fiberAwait', 'include', 'toolsRegistry'],
    hostOnly: true,
    host: {
      profile: typeof calibrationHost.profile === 'string' ? calibrationHost.profile : PROFILE,
      dsh: calibrationHost.dsh,
      cordis: calibrationHost.cordis,
      include: calibrationHost.include,
      node: calibrationHost.node,
    },
    revalidation: [],
    publishedAt: new Date().toISOString(),
  };
  const indexUpdatedAt = new Date().toISOString();
  atomicWrite(indexPath, Buffer.from(JSON.stringify({
    schemaVersion: 1,
    kind: 'dsh-evolution-shared-plugins',
    updatedAt: indexUpdatedAt,
    publisher: { profile: 'desktop' },
    plugins: [record],
  }, null, 2) + '\n', 'utf8'));

  evidence.fixture = {
    recordId,
    experimentId,
    pluginName,
    toolName,
    markerName,
    sourceSha256,
    manifestSha256,
    pluginDir: project(pluginDir),
    indexPath: project(indexPath),
    indexUpdatedAt,
    calibration: {
      host: calibrationHost,
      receipt: calibration.receipt,
      consumerState: calibrationState.value ? summarizeState(calibrationState.value) : null,
    },
  };

  // ---------------------------------------------------------------------
  // baseline boot: one real ACP session mounts the promoted plugin
  // ---------------------------------------------------------------------
  log('baseline boot (expect active)');
  const baseline = await bootWithProbe('baseline');
  const baselineReceived = baseline.receipt;
  if (baselineReceived.ok !== true) throw new Error('baseline probe failed: ' + JSON.stringify(baselineReceived));
  if (baselineReceived.tool?.found !== true) {
    await stopChild(baseline.child);
    throw new Error('the promoted tool was not registered in the baseline boot: ' + JSON.stringify(baselineReceived.tool));
  }
  if (baselineReceived.tool?.hasExecute === true && baselineReceived.tool?.execution?.ok !== true) {
    await stopChild(baseline.child);
    throw new Error('the registered promoted tool could not be executed: ' + JSON.stringify(baselineReceived.tool?.execution ?? null));
  }
  const activeState = readJson(statePath).value;
  const activeRow = activeState?.plugins?.find((row) => row?.id === recordId);
  if (activeRow?.status !== 'active') {
    await stopChild(baseline.child);
    throw new Error('the baseline consumer row is ' + (activeRow?.status ?? 'missing') + ': ' + JSON.stringify(activeRow ?? null));
  }
  if (activeState.observedIndexUpdatedAt !== indexUpdatedAt) {
    await stopChild(baseline.child);
    throw new Error('the baseline observed index ' + activeState.observedIndexUpdatedAt + ', expected ' + indexUpdatedAt);
  }
  await stopChild(baseline.child);
  const baselineBytes = await settleState();
  if (!baselineBytes) throw new Error('the baseline consumer state disappeared');
  const baselineState = JSON.parse(baselineBytes.toString('utf8'));
  const baselineRow = baselineState.plugins.find((row) => row.id === recordId);
  if (baselineRow?.status !== 'active') {
    throw new Error('the baseline consumer state is not active after disposal: ' + JSON.stringify(baselineRow ?? null));
  }
  if (typeof baselineState.sessionId !== 'string' || baselineState.sessionId === '') {
    throw new Error('the baseline consumer state has no sessionId');
  }

  const baselineReview = await runReview(baselineState.host);
  const baselineRecordReview = baselineReview.records.find((row) => row.id === recordId) ?? null;
  if (baselineReview.status !== 'active' || baselineRecordReview?.status !== 'active') {
    throw new Error('the baseline review is ' + baselineReview.status + '/' + (baselineRecordReview?.status ?? 'missing') + ', expected active');
  }
  evidence.baseline = {
    sessionId: baselineState.sessionId,
    observedIndexUpdatedAt: baselineState.observedIndexUpdatedAt,
    statePath: project(statePath),
    stateSha256: sha256(baselineBytes),
    state: summarizeState(baselineState),
    indexSha256: sha256(readBytes(indexPath)),
    probeReceipt: baselineReceived,
    review: {
      status: baselineReview.status,
      action: baselineRecordReview?.action ?? null,
      record: baselineRecordReview,
      nextActions: baselineReview.nextActions,
      summary: baselineReview.summary,
      consumers: baselineReview.consumers,
    },
    calibrationStateSha256: calBytes ? sha256(calBytes) : null,
  };

  // ---------------------------------------------------------------------
  // attempts: restore the baseline bytes, spawn, kill on claim
  // ---------------------------------------------------------------------
  const attempts = [];
  for (let index = 0; index < options.attempts; index += 1) {
    const label = 'attempt-' + String(index + 1).padStart(2, '0');
    log('attempt ' + (index + 1) + '/' + options.attempts);
    atomicWrite(statePath, baselineBytes);
    const restoredSha = sha256(readBytes(statePath));
    const startedAt = Date.now();
    const receiptPath = path.join(work, 'receipts', label + '.json');
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
    const { child, sink } = spawnAcp({ label, patchFile: probePatch, extraEnv: probeEnv(label, receiptPath) });

    const attempt = {
      index: index + 1,
      label,
      restoredSha256: restoredSha,
      baselineSessionId: baselineState.sessionId,
      observedSessionId: null,
      observedAfterMs: null,
      claimNotObserved: false,
      exit: null,
      destroyed: null,
      finalState: null,
      finalStateSha256: null,
      review: null,
      checks: null,
      error: null,
      logTail: null,
    };

    let claim = null;
    try {
      claim = await waitFor(() => {
        const bytes = readBytes(statePath);
        if (!bytes) return null;
        if (sha256(bytes) === restoredSha) return null;
        const state = JSON.parse(bytes.toString('utf8'));
        if (typeof state?.sessionId !== 'string' || state.sessionId === baselineState.sessionId) return null;
        return state;
      }, { label: label + ' claim', timeoutMs: Math.min(options.timeoutMs, 60000), intervalMs: 5, child });
    } catch (error) {
      // A missing claim means the attempt never reached the consumer; it is a
      // failed observation, not a phase result.
      attempt.claimNotObserved = true;
      attempt.error = error.message;
    }
    if (claim) {
      attempt.observedSessionId = claim.sessionId;
      attempt.observedAfterMs = Date.now() - startedAt;
      // Immediately close the session while it is still mounting.
      attempt.exit = await stopChild(child);
    } else {
      attempt.exit = await stopChild(child);
    }
    const finalBytes = await settleState();
    attempt.finalStateSha256 = finalBytes ? sha256(finalBytes) : null;
    const finalState = finalBytes ? JSON.parse(finalBytes.toString('utf8')) : null;
    attempt.finalState = summarizeState(finalState);
    const finalRow = finalState?.plugins?.find((row) => row?.id === recordId) ?? null;
    attempt.destroyed = finalRow?.status !== 'active';

    try {
      // The failed startup report can carry a null host (that is part of the
      // defect real evidence shows). The review must still be asked against a
      // complete live identity: the baseline host is the one this isolated
      // profile really captured, so use it when the final state is incomplete.
      const finalHostComplete = Boolean(finalState?.host)
        && ['dsh', 'cordis', 'include', 'node'].every((key) => typeof finalState.host[key] === 'string' && finalState.host[key].trim() !== '');
      const review = await runReview(finalHostComplete ? finalState.host : baselineState.host);
      const recordReview = review.records.find((row) => row.id === recordId) ?? null;
      const restartActions = review.nextActions.filter((action) => action?.action === 'restart-consumer'
        && (action.recordId == null || action.recordId === recordId));
      attempt.review = {
        status: review.status,
        recordStatus: recordReview?.status ?? null,
        recordAction: recordReview?.action ?? null,
        recordReasons: recordReview?.reasons ?? [],
        profiles: recordReview?.profiles ?? [],
        restartActions,
        nextActions: review.nextActions,
        summary: review.summary,
        needsRestart: review.consumers?.[PROFILE]?.needsRestart ?? null,
        consumerRows: review.consumers?.[PROFILE]?.rows ?? [],
      };
      const reviewBad = (recordReview?.status === 'host-unavailable' || recordReview?.status === 'restart-required')
        && restartActions.length > 0;

      const changedKeys = finalState && baselineState
        ? [...new Set([...Object.keys(finalState), ...Object.keys(baselineState)])]
          .filter((key) => JSON.stringify(finalState[key]) !== JSON.stringify(baselineState[key]))
          .sort()
        : [];
      const allowedChanges = new Set(['updatedAt', 'disposedAt', 'disposal']);
      const unexpectedChanges = changedKeys.filter((key) => !allowedChanges.has(key));

      const fixedChecks = {
        claimObserved: Boolean(claim),
        sessionIdRestored: finalState?.sessionId === baselineState.sessionId,
        rowActive: finalRow?.status === 'active',
        rowUnchanged: JSON.stringify(finalRow) === JSON.stringify(baselineRow),
        observedIndexUnchanged: finalState?.observedIndexUpdatedAt === baselineState.observedIndexUpdatedAt,
        disposalRecorded: typeof finalState?.disposedAt === 'string',
        onlyDisposalFieldsChanged: unexpectedChanges.length === 0,
        reviewActive: recordReview?.status === 'active' && recordReview?.action == null,
        noRestartAction: restartActions.length === 0,
      };
      attempt.checks = {
        preFixExpectation: attempt.destroyed && reviewBad,
        fixedExpectation: Object.entries(fixedChecks).every(([, value]) => value === true),
        fixedChecks,
        reviewBad,
        changedKeys,
      };
    } catch (error) {
      attempt.error = attempt.error ?? ('review failed: ' + error.message);
      attempt.checks = { preFixExpectation: false, fixedExpectation: false, reviewBad: false, changedKeys: [] };
    }
    attempt.logTail = sink.tail().slice(-3000);
    attempts.push(attempt);
    log('  claim=' + (attempt.observedSessionId ?? 'none') + ' destroyed=' + attempt.destroyed + ' review=' + (attempt.review?.recordStatus ?? 'n/a'));
  }

  // ---------------------------------------------------------------------
  // phase verdict
  // ---------------------------------------------------------------------
  const destroyed = attempts.filter((attempt) => attempt.checks?.preFixExpectation === true);
  const fixedFailures = attempts.filter((attempt) => attempt.checks?.fixedExpectation !== true);
  const claimFailures = attempts.filter((attempt) => attempt.claimNotObserved);
  const reproduced = options.phase === 'pre-fix' ? destroyed.length > 0 : false;
  const fixedSatisfied = options.phase === 'fixed'
    ? fixedFailures.length === 0 && claimFailures.length === 0 && attempts.length === options.attempts
    : false;
  const satisfied = options.phase === 'pre-fix' ? reproduced : fixedSatisfied;

  evidence.result = {
    expected: options.phase === 'pre-fix'
      ? 'at least one shutdown-during-startup attempt replaces the active report with a failed/empty report and the review asks to restart the consumer'
      : 'every shutdown-during-startup attempt preserves the baseline active report and the review still reports active with no restart action',
    satisfied,
    attempts: attempts.length,
    destroyedAttempts: destroyed.length,
    claimFailures: claimFailures.length,
    fixedFailures: fixedFailures.length,
    defectReproduced: destroyed.length > 0,
    baselineSessionId: baselineState.sessionId,
    baselineReviewStatus: baselineReview.status,
  };
  evidence.attempts = attempts;
  evidence.finishedAt = new Date().toISOString();

  return satisfied;
}

let exitCode = 2;
try {
  const satisfied = await run();
  exitCode = satisfied ? 0 : 1;
} catch (error) {
  evidence.error = { message: String(error?.message || error).slice(0, 6000), stack: String(error?.stack || '').slice(0, 6000) };
  evidence.finishedAt = new Date().toISOString();
  log('setup failed: ' + (error?.message || error));
  exitCode = 2;
} finally {
  evidence.workDir = project(work);
  if (options.keep) {
    log('kept scratch directory: ' + work);
  } else {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  fs.mkdirSync(path.dirname(options.out), { recursive: true, mode: 0o700 });
  atomicWrite(options.out, Buffer.from(JSON.stringify(project(evidence), null, 2) + '\n', 'utf8'));
  log('evidence: ' + options.out);
}

process.exit(exitCode);
