#!/usr/bin/env node
/**
 * Local three-entry cross-entry evidence runner (macOS Desktop + ACP + Web).
 *
 * This is the end-to-end proof that a plugin promoted to stable by the real
 * Desktop application is mounted and executed by the ACP and Web consumer
 * entries, without the Evolution kernel in those entries.
 *
 * What it does, from scratch, in one isolated `$DSH_HOME`:
 *   1. creates a temporary work tree and an empty isolated home;
 *   2. installs a freshly packed bundle into the desktop, acp and web profiles
 *      through the official CLI using `scripts/setup-experience.mjs --apply`
 *      (desktop keeps the Evolution kernel; acp/web run only the promoted
 *      consumer);
 *   3. runs the real Desktop binary with an isolated Electron user-data
 *      directory and a probe that promotes a standalone plugin with explicit
 *      `targetProfiles: ['acp','web']` approval (the probe reuses the host
 *      acceptance publish flow: propose -> trial -> measure -> confirmation
 *      gate -> confirmed promote -> two canary observations -> stable commit ->
 *      publication);
 *   4. boots the Web consumer twice and the ACP consumer twice (headless: one
 *      model-free JSON-RPC `initialize` handshake keeps the ACP entry alive)
 *      and asserts the promoted marker listener executes exactly once per boot,
 *      the consumer state is `active`, and the activation time moves across
 *      restarts;
 *   5. runs the unified self-evolution review from the real Desktop kernel
 *      (`evolution_plan` through the official registry) three times: on the
 *      healthy record (active, no action), inside a simulated host upgrade
 *      (pending-revalidation with a revalidate action that forbids source
 *      edits) and after the operator revalidate evidence is adopted on the
 *      isolated home (active again); the probe snapshots the publication index
 *      around every call, so the review is proven read-only;
 *   6. writes `docs/evidence/cross-entry-desktop-<host>.json` with stable
 *      `$DSH_HOME` placeholders and the `dsh-evolution-cross-entry-evidence`
 *      shape the `dsh-evolution-shared revalidate` command accepts;
 *   7. removes the temporary work tree unless `--keep` is given.
 *
 * Exact commands:
 *   npm run release:pack
 *   node scripts/acceptance/run-cross-entry.mjs \
 *     --tarball dist/dsh-evolution-0.2.3.tgz \
 *     --out docs/evidence/cross-entry-desktop-0.2.2-rc.1.json
 *
 * Optional: --work <dir>, --keep, --cli <dsh>, --desktop-binary <path>,
 *           --timeout-ms <n>.
 *
 * The installed application is never modified: it is only executed with an
 * isolated `--user-data-dir` and an isolated `$DSH_HOME`, and the runner refuses
 * the real `~/.dsh`.
 *
 * ROOT CAUSE OF THE OLD `hits=2` OBSERVATION (proven 2026-11-11 on macOS, DSH
 * 0.2.2-rc.1, Desktop Electron): a manual publish attempt reused an isolated
 * `$DSH_HOME` in which an earlier run had already committed a stable plugin
 * whose generated source registers the same fixed event name
 * (`cross-entry/probe/stable`). On the second boot the Desktop kernel restores
 * that promoted plugin from `promoted.cordis.yml`, so its listener exists
 * before the new trial and the new trial adds a second listener for the same
 * name: `hits=2`. That is two different plugins sharing a marker name, not one
 * plugin being activated twice. On a fresh isolated home the same real Desktop
 * run executes every trial and promoted marker exactly once (see this runner's
 * evidence file), and the probe now asserts the exact listener count before and
 * after each trial/marker execution. This runner additionally gives every run
 * its own marker namespace, so a persisted home can never reproduce that
 * ambiguity, and it records the actual Desktop Electron/DSH/Cordis/Include/Node/
 * Evolution versions plus the unmodified promotion state. It is intentionally
 * not part of CI (it needs the installed macOS Desktop application); the CI
 * host acceptance (`docs/evidence/cross-entry-0.2.2-rc.1.json`, `--cross-entry`)
 * proves the same role split through a real headless ACP entry and a real Web
 * entry. This runner initializes the isolated Desktop profile itself when the
 * profile manifest is absent.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPO_ROOT, archiveContentDigest } from '../release/release-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DESKTOP = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const DESKTOP_CLI = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const SETUP = path.join(REPO_ROOT, 'scripts', 'setup-experience.mjs');
const PROBE = path.join(HERE, 'probes', 'cross-entry-promotion-probe.mjs');
const CONSUMER_PROBE = path.join(HERE, 'probes', 'cross-entry-consumer-probe.mjs');
/**
 * Per-run event namespace. A stable plugin keeps its marker name in its
 * generated promoted source, so reusing the fixed names in a persisted home
 * makes a later run observe the earlier run's listener. A fresh namespace per
 * run keeps every assertion unambiguous even when `--work` is reused.
 */
const RUN_ID = crypto.randomBytes(8).toString('hex');
const MARKERS = Object.freeze({
  stable: `cross-entry/probe/${RUN_ID}/stable`,
  desktopOnly: `cross-entry/probe/${RUN_ID}/desktop-only`,
  incompatible: `cross-entry/probe/${RUN_ID}/incompatible`,
  loadFailure: `cross-entry/probe/${RUN_ID}/load-failure`,
});

/**
 * The driving session may itself run inside a DSH profile (an ACP agent exports
 * `DSH_PROFILE`/`DSH_HOME` into every shell). Never let that leak into the
 * isolated entries: this runner only talks to the home it creates.
 */
const INHERITED_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_')));

function parseArgs(argv) {
  const options = { keep: false, timeoutMs: 240000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };
    if (arg === '--tarball') options.tarball = path.resolve(value());
    else if (arg === '--out') options.out = path.resolve(value());
    else if (arg === '--work') options.work = path.resolve(value());
    else if (arg === '--cli') options.cli = path.resolve(value());
    else if (arg === '--desktop-binary') options.desktopBinary = path.resolve(value());
    else if (arg === '--timeout-ms') options.timeoutMs = Number(value());
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const HELP = `node scripts/acceptance/run-cross-entry.mjs --tarball <packed.tgz> [options]

  --tarball <path>         freshly packed bundle (required; npm run release:pack)
  --out <path>             evidence JSON (default docs/evidence/cross-entry-desktop-<host>.json)
  --work <dir>             scratch directory (default: a fresh temp directory)
  --cli <path>             official dsh CLI (default: the Desktop runtime CLI when installed)
  --desktop-binary <path>  Desktop executable (default: ${DEFAULT_DESKTOP})
  --timeout-ms <n>         per-entry timeout (default 240000)
  --keep                   keep the scratch directory after the run
`;

const options = parseArgs(process.argv.slice(2));
if (options.help) { process.stdout.write(HELP); process.exit(0); }
if (!options.tarball) { console.error(HELP); process.exit(2); }
const desktopBinary = options.desktopBinary || DEFAULT_DESKTOP;
const cli = options.cli || (fs.existsSync(DESKTOP_CLI) ? DESKTOP_CLI : 'dsh');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
  console.log(`[cross-entry] ${message}`);
}

function run(command, args, { cwd = REPO_ROOT, env = {}, timeoutMs = options.timeoutMs } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...INHERITED_ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (bytes) => { output += bytes.toString(); });
    child.stderr.on('data', (bytes) => { output += bytes.toString(); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, output: `${output}\n${error.message}` }); });
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
  });
}

function runSync(command, args, { cwd = REPO_ROOT, env = {} } = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...INHERITED_ENV, ...env }, encoding: 'utf8' });
  return { code: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function assert(condition, message) {
  if (!condition) throw new Error(`cross-entry: ${message}`);
}

const sha256File = (file) => {
  try { return sha256(fs.readFileSync(file)); } catch { return null; }
};

/** Every regular file under `root`, relative and sorted, for tree snapshots. */
function walkRelative(root, prefix = '') {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(prefix === '' ? root : path.join(root, prefix), { withFileTypes: true }); } catch { return out; }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkRelative(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Digest of every file under one root. Used to prove that the consumer entries
 * did not modify the Desktop promotion state: the promotion journal directory is
 * already gone after a stable commit, so the proof covers the whole data root
 * (evidence sidecars, promoted sources and composition, memory, domain files)
 * rather than a single file that may not exist.
 */
function treeDigest(root, { exclude = [] } = {}) {
  const rows = [];
  for (const rel of walkRelative(root)) {
    if (exclude.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) continue;
    rows.push([rel, sha256File(path.join(root, rel))]);
  }
  return { digest: sha256(JSON.stringify(rows)), files: Object.fromEntries(rows) };
}

/** The installed application's bundle version (macOS `Info.plist`). */
function desktopAppVersion(binary) {
  const plist = path.resolve(path.dirname(binary), '..', 'Info.plist');
  if (!fs.existsSync(plist)) return null;
  const result = spawnSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  try { return JSON.parse(result.stdout).CFBundleShortVersionString ?? null; } catch { return null; }
}

function packageVersion(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).version ?? null; } catch { return null; }
}

/**
 * The shared experience store is opened by the experience collector in every
 * profile (including the consumers). "Preserved" therefore means the committed
 * rows are still there, not that the SQLite file bytes never change.
 */
async function experienceSnapshot(dshHome) {
  const dir = path.join(dshHome, 'storages', 'evolution-experience');
  const file = path.join(dir, 'experience.sqlite');
  const snapshot = { path: '$DSH_HOME/storages/evolution-experience/experience.sqlite', present: fs.existsSync(file), sha256: sha256File(file), rows: null };
  if (!snapshot.present) return snapshot;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
      snapshot.rows = Object.fromEntries(tables.map((table) => {
        try { return [table, db.prepare(`SELECT COUNT(*) AS n FROM "${String(table).replaceAll('"', '""')}"`).get().n]; } catch { return [table, null]; }
      }));
    } finally { db.close(); }
  } catch (error) {
    snapshot.rows = { unavailable: String(error?.code || error?.message || error) };
  }
  return snapshot;
}

/** ISO-8601 timestamp check for the durable stable proof. */
const isIsoTimestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));

/**
 * Boot one Web consumer entry with the profile's managed patch (which disables
 * the kernel row) plus a probe insert row, and drive it through the IPC channel.
 */
function bootWebConsumer(label, { expect, markers }) {
  const patchFile = path.join(work, `${label}.patch.yml`);
  fs.writeFileSync(patchFile, `- insert:\n    - id: cross-entry-${label}\n      name: '${pathToFileURL(CONSUMER_PROBE).href}'\n`);
  const bootAfter = new Date().toISOString();
  return new Promise((resolve) => {
    const child = spawn(cli, ['--profile', 'web', '--patch', patchFile, '--', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
      cwd: home,
      env: {
        ...INHERITED_ENV,
        DSH_HOME: home,
        EVOLUTION_CROSS_ENTRY_PROFILE: 'web',
        EVOLUTION_CROSS_ENTRY_EXPECT: JSON.stringify(expect),
        EVOLUTION_CROSS_ENTRY_MARKERS: JSON.stringify(markers || {}),
        EVOLUTION_CROSS_ENTRY_BOOT_AFTER: bootAfter,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let text = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fs.writeFileSync(path.join(logs, `${label}.log`), text);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
      // The next boot must start only after this entry's disposal state write
      // finished, otherwise that write can be read as the next activation.
      const exited = () => resolve({ ...value, log: text });
      if (child.exitCode !== null || child.signalCode !== null) { exited(); return; }
      child.once('exit', exited);
      setTimeout(exited, 5000).unref?.();
    };
    const timer = setTimeout(() => finish({ error: `${label} timed out after ${options.timeoutMs} ms` }), options.timeoutMs);
    child.stdout.on('data', (bytes) => { text += bytes.toString(); });
    child.stderr.on('data', (bytes) => { text += bytes.toString(); });
    child.on('exit', (code, signal) => finish({ error: `${label} exited before reporting: ${code ?? signal}` }));
    child.on('message', (message) => {
      if (message?.ready) child.send('run');
      else if (message?.result) finish({ result: message.result });
      else if (message?.error) finish({ error: message.error });
    });
  });
}

/**
 * Boot one ACP consumer entry headlessly. The ACP server needs its stdin open;
 * one `initialize` handshake is enough (no session, no model call). The probe
 * writes a file receipt.
 */
function bootAcpConsumer(label, { expect, markers }) {
  const patchFile = path.join(work, `${label}.patch.yml`);
  fs.writeFileSync(patchFile, `- insert:\n    - id: cross-entry-${label}\n      name: '${pathToFileURL(CONSUMER_PROBE).href}'\n`);
  const receipt = path.join(work, `${label}.receipt.json`);
  const bootAfter = new Date().toISOString();
  return new Promise((resolve) => {
    const child = spawn(cli, ['--profile', 'acp', '--patch', patchFile], {
      cwd: home,
      env: {
        ...INHERITED_ENV,
        DSH_HOME: home,
        EVOLUTION_ENTRY_PROBE_OUT: receipt,
        EVOLUTION_CROSS_ENTRY_PROFILE: 'acp',
        EVOLUTION_CROSS_ENTRY_EXPECT: JSON.stringify(expect),
        EVOLUTION_CROSS_ENTRY_MARKERS: JSON.stringify(markers || {}),
        EVOLUTION_CROSS_ENTRY_BOOT_AFTER: bootAfter,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let text = '';
    let settled = false;
    let poll = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      fs.writeFileSync(path.join(logs, `${label}.log`), text);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
      const exited = () => resolve({ ...value, log: text });
      if (child.exitCode !== null || child.signalCode !== null) { exited(); return; }
      child.once('exit', exited);
      setTimeout(exited, 5000).unref?.();
    };
    const timer = setTimeout(() => finish({ error: `${label} timed out after ${options.timeoutMs} ms` }), options.timeoutMs);
    child.stdout.on('data', (bytes) => { text += bytes.toString(); });
    child.stderr.on('data', (bytes) => { text += bytes.toString(); });
    child.on('exit', (code, signal) => finish({ error: `${label} exited before reporting: ${code ?? signal}` }));
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })}\n`);
    } catch { /* reported by the timeout */ }
    poll = setInterval(() => {
      if (!fs.existsSync(receipt)) return;
      const value = readJson(receipt);
      if (!value) return;
      finish(value.ok === false ? { error: value.error } : { result: value });
    }, 200);
  });
}

/**
 * The official CLI refuses `plugin --profile desktop add` until the Desktop
 * application has initialized its profile once. Launch the real application in
 * the isolated home, wait for the profile manifest, then fully quit it before
 * the CLI writes the bundle. The installed application is only executed, never
 * modified, and the user-data directory stays inside the scratch tree.
 */
async function initializeDesktopProfile() {
  const manifestPath = path.join(home, 'profiles', 'desktop', 'package.json');
  if (fs.existsSync(manifestPath)) return { initialized: false, alreadyPresent: true };
  const userData = path.join(work, 'electron-init-user-data');
  const logFile = fs.openSync(path.join(logs, 'desktop-init.log'), 'w', 0o600);
  const env = { ...INHERITED_ENV, DSH_HOME: home };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(desktopBinary, [`--user-data-dir=${userData}`], { cwd: home, env, stdio: ['ignore', logFile, logFile] });
  fs.closeSync(logFile);
  let exited = false;
  const exit = new Promise((resolve) => child.once('exit', () => { exited = true; resolve(); }));
  try {
    const deadline = Date.now() + options.timeoutMs;
    while (!fs.existsSync(manifestPath) && !exited && Date.now() < deadline) await sleep(250);
    if (!fs.existsSync(manifestPath)) throw new Error('the Desktop application did not initialize its profile');
    return { initialized: true, alreadyPresent: false };
  } finally {
    if (!exited) child.kill('SIGTERM');
    await Promise.race([exit, sleep(8000).then(() => { if (!exited) child.kill('SIGKILL'); })]);
    // The CLI refuses while the Desktop application still holds the profile.
    await sleep(1000);
  }
}

/**
 * Install the cross-entry probe entry into the isolated Desktop profile patch
 * exactly once. Every Desktop launch of this runner composes the same probe; the
 * phase environment decides what it runs.
 */
function ensureDesktopProbe() {
  const patchFile = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml');
  const marker = '# isolated cross-entry publish probe';
  const previous = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
  if (!previous.includes(marker)) {
    fs.appendFileSync(patchFile, `\n${marker}\n- insert:\n    - id: cross-entry-publish-probe\n      name: '${pathToFileURL(PROBE).href}'\n`);
  }
}

/**
 * Run the real Desktop application with the cross-entry probe in one phase and
 * wait for its file receipt. The application is only ever executed with the
 * isolated `--user-data-dir` and `$DSH_HOME` created by this runner.
 */
function runDesktopProbe(label, phase, { extraEnv = {}, receiptName = `desktop-${label}` } = {}) {
  ensureDesktopProbe();
  const receipt = path.join(work, `${receiptName}.json`);
  const userData = path.join(work, 'electron-user-data');
  const logFile = fs.openSync(path.join(logs, `desktop-${label}.log`), 'w', 0o600);
  const env = {
    ...INHERITED_ENV,
    DSH_HOME: home,
    EVOLUTION_ENTRY_PROBE_OUT: receipt,
    EVOLUTION_CROSS_ENTRY_PHASE: phase,
    ...extraEnv,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(desktopBinary, [`--user-data-dir=${userData}`], { cwd: home, env, stdio: ['ignore', logFile, logFile] });
  fs.closeSync(logFile);
  let exited = false;
  const exit = new Promise((resolve) => child.once('exit', () => { exited = true; resolve(); }));
  return (async () => {
    try {
      const deadline = Date.now() + options.timeoutMs;
      while (!fs.existsSync(receipt) && !exited && Date.now() < deadline) await sleep(200);
      if (!fs.existsSync(receipt)) {
        throw new Error(exited
          ? `the Desktop application exited before the ${phase} probe reported`
          : `the Desktop application did not produce a ${phase} receipt within ${options.timeoutMs} ms`);
      }
      const value = readJson(receipt);
      if (!value) throw new Error(`the Desktop ${phase} receipt is unreadable`);
      if (value.ok === false) throw new Error(`the Desktop ${phase} probe failed: ${value.error}`);
      return value;
    } finally {
      if (!exited) child.kill('SIGTERM');
      await Promise.race([exit, sleep(5000).then(() => { if (!exited) child.kill('SIGKILL'); })]);
    }
  })();
}

/** Run the real Desktop application and wait for the publish probe receipt. */
function runDesktopPublish() {
  return runDesktopProbe('publish', 'publish', {
    receiptName: 'desktop-publish',
    // A per-run marker namespace and the extended candidate set (a real
    // consumer-side load failure) are only used by this runner.
    extraEnv: {
      EVOLUTION_CROSS_ENTRY_MARKERS: JSON.stringify(MARKERS),
      EVOLUTION_CROSS_ENTRY_EXTENDED: '1',
      EVOLUTION_ACCEPTANCE_CWD: home,
    },
  });
}

/**
 * Run the unified self-evolution review from the real Desktop kernel. The probe
 * calls the registered `evolution_plan` tool and snapshots the publication
 * index bytes around that call; the driver asserts what the recorded state must
 * classify as.
 */
function runDesktopReview(label, phase) {
  return runDesktopProbe(label, phase, { extraEnv: { EVOLUTION_ACCEPTANCE_CWD: home } });
}

/** Replace local scratch paths with stable placeholders for committed evidence. */
function redact(value) {
  const json = JSON.stringify(value)
    .split(JSON.stringify(home).slice(1, -1)).join('$DSH_HOME')
    .split(JSON.stringify(work).slice(1, -1)).join('<work>');
  return JSON.parse(json);
}

let failure = null;
const work = options.work || fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-evolution-cross-entry-'));
const home = path.join(work, 'home');
const logs = path.join(work, 'logs');
const evidence = {
  schemaVersion: 1,
  kind: 'dsh-evolution-cross-entry-evidence',
  ok: false,
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  isolatedHome: '$DSH_HOME',
  startedAt: new Date().toISOString(),
  markers: { ...MARKERS },
  commands: {
    pack: 'npm run release:pack',
    run: 'node scripts/acceptance/run-cross-entry.mjs --tarball <packed.tgz> --out <evidence.json>',
  },
};

try {
  if (home === path.resolve(process.env.HOME || '', '.dsh')) throw new Error('refusing the formal DSH_HOME');
  if (!fs.existsSync(options.tarball)) throw new Error(`missing tarball ${options.tarball}; run "npm run release:pack" first`);
  if (!fs.existsSync(desktopBinary)) throw new Error(`Desktop binary not found at ${desktopBinary}; this runner needs the macOS Desktop application`);
  fs.mkdirSync(logs, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  log(`work directory ${work}`);

  const tarballBytes = fs.readFileSync(options.tarball);
  evidence.tarball = {
    path: path.relative(REPO_ROOT, options.tarball),
    sha256: sha256(tarballBytes),
    contentSha256: archiveContentDigest(options.tarball),
  };
  evidence.desktopBinary = path.basename(desktopBinary);

  // 1. the official CLI identity this run drives.
  const version = runSync(cli, ['--version'], { cwd: work, env: { DSH_HOME: home } });
  if (version.code !== 0) throw new Error(`the official CLI did not report a version: ${version.output.slice(-800)}`);
  const hostVersion = version.output.trim().split('\n').filter(Boolean).pop();
  evidence.host = { dsh: hostVersion, cli: path.basename(cli) };

  // 2. initialize the Desktop profile once (the official CLI requires it), then
  //    install the freshly packed bundle into all three profiles through the
  //    official CLI and setup-experience's managed patch.
  log('initializing the isolated Desktop profile once');
  evidence.desktopInitialization = await initializeDesktopProfile();
  log('installing the packed bundle into desktop/acp/web profiles');
  const setup = runSync(process.execPath, [SETUP, '--tarball', options.tarball, '--home', home, '--cli', cli, '--apply'], {
    cwd: REPO_ROOT,
    env: { DSH_HOME: home },
  });
  evidence.setup = { code: setup.code, tail: setup.output.trim().split('\n').slice(-8) };
  assert(setup.code === 0, `setup-experience --apply failed: ${setup.output.slice(-1200)}`);
  for (const profile of ['desktop', 'acp', 'web']) {
    const manifestPath = path.join(home, 'profiles', profile, 'package.json');
    const installed = path.join(home, 'profiles', profile, 'node_modules', 'dsh-evolution', 'package.json');
    assert(fs.existsSync(manifestPath), `the ${profile} profile was not created`);
    assert(fs.existsSync(installed), `the bundle is not installed in the ${profile} profile`);
    const patch = fs.readFileSync(path.join(home, 'profiles', profile, 'cordis.patch.yml'), 'utf8');
    assert(patch.includes('BEGIN dsh-evolution shared experience'), `the ${profile} profile has no managed setup block`);
    assert(/evolution-promoted-consumer/.test(patch), `the ${profile} profile patch does not name the promoted consumer`);
    assert(new RegExp(`evolution-orchestrator\\n  disabled: ${profile !== 'desktop'}`).test(patch), `the ${profile} profile does not have the expected kernel enablement`);
  }
  evidence.profiles = Object.fromEntries(['desktop', 'acp', 'web'].map((profile) => [profile, {
    manifest: path.join('$DSH_HOME', 'profiles', profile, 'package.json'),
    bundle: path.join('$DSH_HOME', 'profiles', profile, 'node_modules', 'dsh-evolution'),
  }]));

  // 3. the real Desktop application performs the cross-entry promotion.
  log('running the real Desktop application for the cross-entry promotion');
  const publish = await runDesktopPublish();
  evidence.desktop = {
    binary: path.basename(desktopBinary),
    applicationVersion: desktopAppVersion(desktopBinary),
    userDataDir: '<work>/electron-user-data',
    publisherProfile: 'desktop',
    phase: publish.phase,
    hostRuntime: publish.hostRuntime ?? null,
    markers: publish.markers ?? null,
    extended: publish.extended === true,
    services: publish.services,
    candidates: publish.candidates,
    index: publish.index,
  };
  const stable = publish.candidates?.stable;
  const incompatible = publish.candidates?.incompatible;
  const desktopOnly = publish.candidates?.desktopOnly;
  const loadFailure = publish.candidates?.loadFailure ?? null;
  assert(Boolean(stable && incompatible && desktopOnly), 'the Desktop publish probe did not report all candidates');
  assert(JSON.stringify(stable.approvedProfiles) === JSON.stringify(['acp', 'web']), `the Desktop-published record carries approvedProfiles ${JSON.stringify(stable.approvedProfiles)}`);
  assert(desktopOnly.sharedStatus === 'desktop-only' && desktopOnly.published === false, 'the Desktop-only control promotion was published');
  // The publisher ran inside the installed Desktop application: the receipt must
  // prove the Electron runtime and use the exact Node version the durable host
  // identity was captured with.
  assert(typeof publish.hostRuntime?.electron === 'string' && publish.hostRuntime.electron !== '', 'the Desktop publish receipt does not prove an Electron runtime');
  const normalizeNodeVersion = (value) => String(value ?? '').replace(/^v/, '');
  assert(normalizeNodeVersion(publish.hostRuntime.node) === normalizeNodeVersion(stable.host?.node), `the committed host Node ${stable.host?.node} is not the Desktop runtime ${publish.hostRuntime.node}`);
  assert(publish.markers && JSON.stringify(publish.markers) === JSON.stringify(MARKERS), 'the Desktop publish probe did not use this run marker namespace');
  assert(publish.extended === true, 'the Desktop publish probe did not run the extended candidate set');
  assert(Boolean(loadFailure), 'the extended Desktop run did not report the load-failure candidate');
  assert(JSON.stringify(loadFailure.approvedProfiles) === JSON.stringify(['acp', 'web']), `the load-failure record carries approvedProfiles ${JSON.stringify(loadFailure.approvedProfiles)}`);

  const dataRoot = path.join(home, 'storages', 'evolution');
  const publishedPath = path.join(dataRoot, 'shared-plugins', 'published.json');
  const indexBytes = fs.readFileSync(publishedPath);
  const index = JSON.parse(indexBytes);
  assert(Boolean(index) && Array.isArray(index.plugins), 'the publication index is missing after the Desktop promotion');
  const stableRecord = index.plugins.find((row) => row?.id === stable.id);
  assert(Boolean(stableRecord), 'the Desktop-published stable record is missing from the index');
  assert(stableRecord.publisherProfile === 'desktop', `the record publisherProfile is ${stableRecord.publisherProfile}, expected desktop`);
  assert(!index.plugins.some((row) => row?.id === desktopOnly.id), 'the Desktop-only control promotion was published');
  // Durable stable proof: a committed timestamp, the satisfied canary window
  // and the benefit decision are all required, and the published byte digests
  // are recomputed from the promoted source instead of trusted from the record.
  assert(isIsoTimestamp(stableRecord.stable?.committedAt) && isIsoTimestamp(stableRecord.stable?.promotionTimestamp), `the record has no durable stable commit times: ${JSON.stringify(stableRecord.stable)}`);
  assert(stableRecord.stable?.decision === 'benefit' && stableRecord.stable?.canary?.startupVerified === true, 'the Desktop-published record has no stable proof');
  const canaryWindow = stableRecord.stable?.canary?.healthObservationWindow;
  const canaryObservations = stableRecord.stable?.canary?.observations;
  assert(Number.isInteger(canaryWindow) && canaryWindow >= 1 && Number.isInteger(canaryObservations) && canaryObservations >= canaryWindow, `the record does not carry a satisfied canary window: ${JSON.stringify(stableRecord.stable?.canary)}`);
  // The explicit cross-entry approval was a separate input, and neither the
  // confirmation gate nor the open canary window published anything: the record
  // appears only after the canary committed stable.
  assert(stable.gates?.publishedAtConfirmationGate === false, `the confirmation-gated promotion published a record: ${JSON.stringify(stable.gates)}`);
  assert(stable.gates?.publishedBeforeCanaryCommit === false, `the plugin was published before the canary committed stable: ${JSON.stringify(stable.gates)}`);
  assert(stable.gates?.publishedAfterFirstObservation === false, `the plugin was published while the canary window was still open: ${JSON.stringify(stable.gates)}`);
  evidence.approval = {
    input: { confirmation: true, targetProfiles: ['acp', 'web'] },
    approvedProfiles: stableRecord.approvedProfiles,
    publishedAtConfirmationGate: stable.gates.publishedAtConfirmationGate,
    publishedBeforeCanaryCommit: stable.gates.publishedBeforeCanaryCommit,
    publishedAfterFirstObservation: stable.gates.publishedAfterFirstObservation,
    desktopOnlyControlPublished: index.plugins.some((row) => row?.id === desktopOnly.id),
  };
  assert(stableRecord.hostOnly === true, 'the published record is not host-only');
  assert(stableRecord.host?.dsh === hostVersion, `the verified host DSH ${stableRecord.host?.dsh} is not the installed CLI ${hostVersion}`);
  const stableModuleFile = fileURLToPath(stableRecord.moduleUrl);
  assert(sha256File(stableModuleFile) === stableRecord.sourceSha256, 'the promoted source digest does not match the published record');
  assert(sha256File(path.join(path.dirname(stableModuleFile), '..', 'package.json')) === stableRecord.manifestSha256, 'the promoted manifest digest does not match the published record');
  assert(!index.plugins.some((row) => row?.id === loadFailure.id && !Array.isArray(row.approvedProfiles)), 'the load-failure record was not published with its approval');
  const indexDigest = sha256(indexBytes);
  evidence.index = {
    path: path.join('$DSH_HOME', 'storages', 'evolution', 'shared-plugins', 'published.json'),
    updatedAt: index.updatedAt,
    digest: indexDigest,
    records: index.plugins.map((row) => ({ id: row?.id, publisherProfile: row?.publisherProfile, approvedProfiles: row?.approvedProfiles, sourceSha256: row?.sourceSha256, manifestSha256: row?.manifestSha256, host: row?.host, stable: row?.stable })),
  };

  const evolutionVersion = packageVersion(path.join(home, 'profiles', 'desktop', 'node_modules', 'dsh-evolution', 'package.json'));
  assert(typeof evolutionVersion === 'string' && evolutionVersion !== '', 'the installed Evolution bundle version is unreadable');
  evidence.versions = {
    desktop: {
      application: desktopAppVersion(desktopBinary),
      electron: publish.hostRuntime.electron,
      chrome: publish.hostRuntime.chrome ?? null,
      node: publish.hostRuntime.node,
    },
    runner: { node: process.version, platform: `${process.platform}-${process.arch}` },
    dsh: hostVersion,
    cordis: stableRecord.host?.cordis ?? null,
    include: stableRecord.host?.include ?? null,
    evolution: evolutionVersion,
  };
  // The revalidate-shaped whole-file projection needs the verified host
  // identity at the top level (the operator command reads it from there).
  evidence.host = { ...evidence.host, cordis: stableRecord.host?.cordis ?? null, include: stableRecord.host?.include ?? null, node: stableRecord.host?.node ?? process.version };

  // Everything the promotion left behind, before any consumer runs. The
  // consumer's own state directory is the only thing it is allowed to write.
  const CONSUMER_STATE = 'shared-plugins/consumers';
  const evolutionBefore = treeDigest(dataRoot, { exclude: [CONSUMER_STATE] });
  const experienceBefore = await experienceSnapshot(home);

  const expectedActive = {
    [stable.id]: { status: 'active' },
    [incompatible.id]: { status: 'skipped-incompatible', reason: 'missing-service' },
    [loadFailure.id]: { status: 'failed', reason: 'plugin-apply-failed' },
  };
  const activeMarkers = {
    [stable.id]: MARKERS.stable,
    [incompatible.id]: MARKERS.incompatible,
    [loadFailure.id]: MARKERS.loadFailure,
  };
  const nodeMajor = (value) => String(value ?? '').replace(/^v/, '').split('.')[0];

  /** Assert one consumer boot really mounted only the records it may mount. */
  function assertConsumerBoot(profile, result, label, expectedIndexUpdatedAt = index.updatedAt) {
    assert(result.profile === profile, `the ${profile} consumer ${label} reported profile ${result.profile}`);
    assert(result.probeInstances === 1, `the ${profile} consumer ${label} composed ${result.probeInstances} probe instances`);
    assert(result.kernelPresent === false, `the ${profile} consumer ${label} still runs the Evolution kernel service`);
    assert(JSON.stringify(result.kernelOnlyTools) === '[]', `the ${profile} consumer ${label} registered kernel tools: ${JSON.stringify(result.kernelOnlyTools)}`);
    assert((result.evolutionToolNames || []).every((name) => name === 'evolution_history'), `the ${profile} consumer ${label} registered unexpected evolution tools: ${JSON.stringify(result.evolutionToolNames)}`);
    assert(result.markerListeners?.[stable.id] === 1, `the ${profile} consumer ${label} registered ${result.markerListeners?.[stable.id]} listeners for the stable record`);
    assert(result.markerHits?.[stable.id] === 1, `the ${profile} consumer ${label} executed the promoted listener ${result.markerHits?.[stable.id]} times`);
    assert(result.markerListeners?.[incompatible.id] === 0, `the ${profile} consumer ${label} mounted the incompatible plugin`);
    assert(result.markerHits?.[incompatible.id] === 0, `the ${profile} consumer ${label} executed the incompatible plugin`);
    assert(result.markerListeners?.[loadFailure.id] === 0, `the ${profile} consumer ${label} registered a listener for the failed plugin`);
    assert(result.markerHits?.[loadFailure.id] === 0, `the ${profile} consumer ${label} executed the failed plugin`);
    assert(result.observedIndexUpdatedAt === expectedIndexUpdatedAt, `the ${profile} consumer ${label} observed index ${result.observedIndexUpdatedAt}, expected ${expectedIndexUpdatedAt}`);
    assert(nodeMajor(result.processVersions?.node) === nodeMajor(stableRecord.host?.node), `the ${profile} consumer ${label} ran on Node ${result.processVersions?.node}, not the verified host Node ${stableRecord.host?.node}`);
  }
  const bootWeb = async (label, payload) => {
    const outcome = await bootWebConsumer(label, payload);
    if (outcome.error) throw new Error(`Web consumer ${label} failed: ${outcome.error}`);
    return outcome.result;
  };
  const bootAcp = async (label, payload) => {
    const outcome = await bootAcpConsumer(label, payload);
    if (outcome.error) throw new Error(`ACP consumer ${label} failed: ${outcome.error}`);
    return outcome.result;
  };

  // 4. the Web consumer, twice, with no kernel.
  log('booting the Web consumer entry (restart x2)');
  const webBoots = [];
  for (const label of ['web-1', 'web-2']) {
    const result = await bootWeb(label, { expect: expectedActive, markers: activeMarkers });
    assertConsumerBoot('web', result, label);
    webBoots.push(result);
  }
  const webActivated = webBoots.map((boot) => (boot.rows || []).find((row) => row.id === stable.id)?.activatedAt);
  assert(typeof webActivated[0] === 'string' && typeof webActivated[1] === 'string' && webActivated[1] > webActivated[0], `Web activatedAt did not move across restart: ${webActivated.join(' -> ')}`);
  const webState = readJson(path.join(dataRoot, 'shared-plugins', 'consumers', 'web.json'));
  evidence.web = {
    consumerStatePath: path.join('$DSH_HOME', 'storages', 'evolution', 'shared-plugins', 'consumers', 'web.json'),
    boots: webBoots,
    consumerState: webState ? { updatedAt: webState.updatedAt, observedIndexUpdatedAt: webState.observedIndexUpdatedAt, plugins: webState.plugins } : null,
  };
  assert(sha256(fs.readFileSync(publishedPath)) === indexDigest, 'the Web consumer boot changed the publication index');

  // 5. the ACP consumer, twice, headless and with no kernel.
  log('booting the headless ACP consumer entry (restart x2)');
  const acpBoots = [];
  for (const label of ['acp-1', 'acp-2']) {
    const result = await bootAcp(label, { expect: expectedActive, markers: activeMarkers });
    assertConsumerBoot('acp', result, label);
    acpBoots.push(result);
  }
  const acpActivated = acpBoots.map((boot) => (boot.rows || []).find((row) => row.id === stable.id)?.activatedAt);
  assert(typeof acpActivated[0] === 'string' && typeof acpActivated[1] === 'string' && acpActivated[1] > acpActivated[0], `ACP activatedAt did not move across restart: ${acpActivated.join(' -> ')}`);
  const acpState = readJson(path.join(dataRoot, 'shared-plugins', 'consumers', 'acp.json'));
  evidence.acp = {
    consumerStatePath: path.join('$DSH_HOME', 'storages', 'evolution', 'shared-plugins', 'consumers', 'acp.json'),
    boots: acpBoots,
    consumerState: acpState ? { updatedAt: acpState.updatedAt, observedIndexUpdatedAt: acpState.observedIndexUpdatedAt, plugins: acpState.plugins } : null,
  };
  assert(sha256(fs.readFileSync(publishedPath)) === indexDigest, 'the ACP consumer boot changed the publication index');

  // 6. the unified self-evolution review in the real Desktop kernel. The
  //    published stable record is active and needs no action; the two records
  //    whose consumers really failed are reported as repair-stable (the review
  //    is supposed to surface them, not hide them), and the review writes
  //    nothing: the probe snapshots the publication index bytes around the
  //    evolution_plan tool call and fails on any change.
  log('running the unified self-evolution review in the real Desktop host (healthy record)');
  const activeReview = await runDesktopReview('review-active', 'review-active');
  const reviewDocument = (receipt) => receipt?.review ?? {};
  const reviewRecord = (receipt, id) => (reviewDocument(receipt).stablePlugins?.records ?? []).find((row) => row.id === id) ?? null;
  const reviewActionsFor = (receipt, id) => (reviewDocument(receipt).selfEvolution?.nextActions ?? []).filter((row) => row.recordId === id);
  const summarizeReview = (receipt) => {
    const document = reviewDocument(receipt);
    const stablePlugins = document.stablePlugins ?? {};
    return {
      phase: receipt.phase,
      primary: document.selfEvolution?.primary ?? null,
      kind: document.selfEvolution?.kind ?? null,
      hasBlockingStableIssue: document.selfEvolution?.hasBlockingStableIssue ?? null,
      readOnly: stablePlugins.readOnly === true && document.selfEvolution?.readOnly === true,
      status: stablePlugins.status ?? null,
      summary: stablePlugins.summary ?? null,
      indexRecordCount: stablePlugins.indexRecordCount ?? null,
      truncated: stablePlugins.truncated ?? null,
      stableRecord: (stablePlugins.records ?? []).find((row) => row.id === stable.id) ?? null,
      nextActions: document.selfEvolution?.nextActions ?? [],
      incomplete: document.selfEvolution?.incomplete === true,
      indexDigest: receipt.index?.digest ?? null,
      indexDigestAfter: receipt.index?.digestAfter ?? null,
      indexUpdatedAt: receipt.index?.updatedAt ?? null,
      steps: receipt.steps ?? [],
    };
  };
  const activeReviewDocument = reviewDocument(activeReview);
  const activeReviewStable = reviewRecord(activeReview, stable.id);
  assert(activeReview.steps?.[0]?.name === 'evolution_plan' && activeReview.steps[0].ok === true, 'the Desktop review receipt does not prove the evolution_plan tool ran');
  assert(activeReviewDocument.stablePlugins?.readOnly === true && activeReviewDocument.selfEvolution?.readOnly === true, 'the Desktop review does not declare itself read-only');
  assert(activeReviewStable?.status === 'active', `the review did not report the healthy stable record as active: ${JSON.stringify(activeReviewStable)}`);
  assert(activeReviewStable?.action === null && reviewActionsFor(activeReview, stable.id).length === 0, `the review advised an action for the healthy stable record: ${JSON.stringify(reviewActionsFor(activeReview, stable.id))}`);
  assert(activeReviewDocument.stablePlugins?.status === 'incompatible', `the review did not report the deliberately broken published records: ${activeReviewDocument.stablePlugins?.status}`);
  assert((activeReviewDocument.stablePlugins?.records ?? []).some((row) => row.id === incompatible.id && row.status === 'incompatible' && row.action === 'repair-stable'), 'the review did not report the real consumer-side service skip as repair-stable');
  assert((activeReviewDocument.stablePlugins?.records ?? []).some((row) => row.id === loadFailure.id && row.status === 'incompatible' && row.action === 'repair-stable'), 'the review did not report the real consumer-side apply failure as repair-stable');
  assert(activeReview.index.digest === activeReview.index.digestAfter, 'the Desktop review changed the publication index bytes');
  assert(sha256(fs.readFileSync(publishedPath)) === indexDigest, 'the Desktop review changed the publication index');

  // 7. real rejection paths on the records this Desktop run published: a
  //    tampered source must be skipped-invalid (not mounted) while the other
  //    records keep their verdicts, and a host-version mismatch must hold the
  //    record back as pending-revalidation until the index is restored.
  log('driving the real rejection paths (tampered source, host-version mismatch)');
  const rejections = {};
  const stableSourcePath = fileURLToPath(stableRecord.moduleUrl);
  const originalSource = fs.readFileSync(stableSourcePath);
  const tamperedSource = Buffer.concat([originalSource, Buffer.from('\n// acceptance tamper: source digest must not match\n')]);
  let tamperedSourceAfterBoot;
  let indexAfterTamperedBoot;
  let tamperedBoot;
  try {
    fs.writeFileSync(stableSourcePath, tamperedSource);
    tamperedBoot = await bootWeb('web-tampered', {
      expect: {
        [stable.id]: { status: 'skipped-invalid', reason: 'source-digest-mismatch' },
        [incompatible.id]: { status: 'skipped-incompatible', reason: 'missing-service' },
        [loadFailure.id]: { status: 'failed', reason: 'plugin-apply-failed' },
      },
      markers: activeMarkers,
    });
    // Read the injected files back BEFORE restoring them: restoring first would
    // hide a consumer that rewrote either file during the tampered boot.
    tamperedSourceAfterBoot = fs.readFileSync(stableSourcePath);
    indexAfterTamperedBoot = fs.readFileSync(publishedPath);
  } finally {
    fs.writeFileSync(stableSourcePath, originalSource);
  }
  assert(tamperedSourceAfterBoot?.equals(tamperedSource), 'the consumer changed the tampered promoted source during its boot');
  assert(indexAfterTamperedBoot?.equals(indexBytes), 'the consumer changed the publication index during the tampered boot');
  assert(sha256File(stableSourcePath) === stableRecord.sourceSha256, 'the tampered promoted source was not restored byte-for-byte');
  assert(tamperedBoot.markerListeners?.[stable.id] === 0 && tamperedBoot.markerHits?.[stable.id] === 0, 'the tampered record was still mounted');
  rejections.tamperedSource = {
    status: (tamperedBoot.rows || []).find((row) => row.id === stable.id)?.status ?? null,
    reason: (tamperedBoot.rows || []).find((row) => row.id === stable.id)?.reason ?? null,
    otherStatus: (tamperedBoot.rows || []).filter((row) => row.id !== stable.id).map((row) => ({ id: row.id, status: row.status, reason: row.reason ?? null })),
    restoredSourceSha256: sha256File(stableSourcePath),
  };
  assert(sha256(fs.readFileSync(publishedPath)) === indexDigest, 'the tampered consumer boot changed the publication index');

  const originalIndex = fs.readFileSync(publishedPath);
  const modifiedIndex = JSON.parse(originalIndex);
  const upgradeTarget = modifiedIndex.plugins.find((row) => row.id === stable.id);
  upgradeTarget.host = { ...upgradeTarget.host, dsh: '9.9.9-acceptance-upgrade' };
  const modifiedIndexBytes = Buffer.from(`${JSON.stringify(modifiedIndex, null, 2)}\n`);
  let upgradedIndexAfterBoot;
  let upgradedBoot;
  let pendingReview;
  try {
    fs.writeFileSync(publishedPath, modifiedIndexBytes);
    upgradedBoot = await bootWeb('web-upgraded', {
      expect: {
        [stable.id]: { status: 'pending-revalidation', reason: 'host-version-mismatch' },
        [incompatible.id]: { status: 'skipped-incompatible', reason: 'missing-service' },
        [loadFailure.id]: { status: 'failed', reason: 'plugin-apply-failed' },
      },
      markers: activeMarkers,
    });
    upgradedIndexAfterBoot = fs.readFileSync(publishedPath);
    // The review runs while the simulated upgrade is the only index on disk, so
    // it classifies exactly the state the consumer boots just observed.
    pendingReview = await runDesktopReview('review-pending', 'review-pending');
  } finally {
    fs.writeFileSync(publishedPath, originalIndex);
  }
  assert(upgradedIndexAfterBoot?.equals(modifiedIndexBytes), 'the consumer changed the publication index during the pending-revalidation boot');
  assert(sha256(fs.readFileSync(publishedPath)) === indexDigest, 'the publication index was not restored byte-for-byte');
  assert(upgradedBoot.markerListeners?.[stable.id] === 0 && upgradedBoot.markerHits?.[stable.id] === 0, 'the pending-revalidation record was still mounted');
  rejections.hostVersionMismatch = {
    status: (upgradedBoot.rows || []).find((row) => row.id === stable.id)?.status ?? null,
    reason: (upgradedBoot.rows || []).find((row) => row.id === stable.id)?.reason ?? null,
    otherStatus: (upgradedBoot.rows || []).filter((row) => row.id !== stable.id).map((row) => ({ id: row.id, status: row.status, reason: row.reason ?? null })),
    restoredIndexSha256: sha256(fs.readFileSync(publishedPath)),
  };
  // The unified review must prefer revalidation over a source change: the
  // record was verified on another DSH release, so the only allowed next action
  // is the operator revalidate step, and it explicitly forbids editing or
  // regenerating the promoted source.
  const pendingReviewDocument = reviewDocument(pendingReview);
  const pendingReviewStable = reviewRecord(pendingReview, stable.id);
  const pendingReviewAction = reviewActionsFor(pendingReview, stable.id);
  assert(pendingReviewDocument.stablePlugins?.readOnly === true && pendingReviewDocument.selfEvolution?.readOnly === true, 'the Desktop review during the simulated upgrade does not declare itself read-only');
  assert(pendingReviewStable?.status === 'pending-revalidation', `the review did not report the upgraded record as pending-revalidation: ${JSON.stringify(pendingReviewStable)}`);
  assert(pendingReviewStable?.action === 'revalidate', `the upgraded record action is ${pendingReviewStable?.action}, expected revalidate`);
  assert(pendingReviewStable?.hostCompatible === false && pendingReviewStable?.hostReason === 'host-version-mismatch', `the upgraded record host verdict is ${JSON.stringify({ compatible: pendingReviewStable?.hostCompatible, reason: pendingReviewStable?.hostReason })}`);
  const pendingRevalidate = pendingReviewAction.find((row) => row.action === 'revalidate');
  assert(pendingRevalidate?.recordId === stable.id, `the revalidate next action does not name the upgraded record: ${JSON.stringify(pendingRevalidate)}`);
  assert(typeof pendingRevalidate.command === 'string' && pendingRevalidate.command.includes('shared-plugins.mjs') && pendingRevalidate.command.includes('revalidate --evidence'), `the revalidate next action has no operator command: ${JSON.stringify(pendingRevalidate.command)}`);
  const pendingForbidden = Array.isArray(pendingRevalidate.forbidden) ? pendingRevalidate.forbidden : [];
  assert(pendingForbidden.includes('edit or regenerate the promoted plugin source'), `the revalidate next action does not forbid regenerating the source: ${JSON.stringify(pendingForbidden)}`);
  assert(pendingForbidden.includes('weaken the recorded host identity'), `the revalidate next action does not protect the recorded host identity: ${JSON.stringify(pendingForbidden)}`);
  assert(pendingReviewDocument.selfEvolution?.primary === 'revalidate' && pendingReviewDocument.selfEvolution?.hasBlockingStableIssue === true, `the review did not give the host upgrade priority over other work: ${JSON.stringify({ primary: pendingReviewDocument.selfEvolution?.primary, blocking: pendingReviewDocument.selfEvolution?.hasBlockingStableIssue })}`);
  assert(!pendingReviewAction.some((row) => row.action === 'repair-stable' || row.action === 'experience-candidate'), `the host upgrade was turned into a source change: ${JSON.stringify(pendingReviewAction)}`);
  assert(pendingReview.index.digest === sha256(modifiedIndexBytes) && pendingReview.index.digest === pendingReview.index.digestAfter, 'the Desktop review read or wrote an index other than the simulated upgrade index');
  rejections.hostVersionMismatch.review = {
    status: pendingReviewStable?.status ?? null,
    primary: pendingReviewDocument.selfEvolution?.primary ?? null,
    action: pendingRevalidate ? { action: pendingRevalidate.action, recordId: pendingRevalidate.recordId, command: pendingRevalidate.command, forbidden: pendingForbidden } : null,
    indexDigest: pendingReview.index.digest,
    indexDigestAfter: pendingReview.index.digestAfter,
  };
  const recoveredBoot = await bootWeb('web-recovered', { expect: expectedActive, markers: activeMarkers });
  assertConsumerBoot('web', recoveredBoot, 'web-recovered');
  rejections.recovered = {
    status: (recoveredBoot.rows || []).find((row) => row.id === stable.id)?.status ?? null,
    markerHits: recoveredBoot.markerHits?.[stable.id] ?? null,
    activatedAt: (recoveredBoot.rows || []).find((row) => row.id === stable.id)?.activatedAt ?? null,
  };
  evidence.rejections = rejections;

  // 8. every consumer boot above ran outside the Desktop authority: the
  //    promotion state, promoted sources and the publication index are
  //    byte-identical, and the shared experience rows are all still present.
  const evolutionAfter = treeDigest(dataRoot, { exclude: [CONSUMER_STATE] });
  const changed = Object.keys(evolutionBefore.files).filter((rel) => evolutionBefore.files[rel] !== evolutionAfter.files[rel]);
  const added = Object.keys(evolutionAfter.files).filter((rel) => !(rel in evolutionBefore.files));
  const removed = Object.keys(evolutionBefore.files).filter((rel) => !(rel in evolutionAfter.files));
  assert(changed.length === 0 && added.length === 0 && removed.length === 0, `the consumers changed the Desktop promotion state: changed=${JSON.stringify(changed)} added=${JSON.stringify(added)} removed=${JSON.stringify(removed)}`);
  const experienceAfter = await experienceSnapshot(home);
  assert(experienceAfter.present, 'the shared experience store disappeared during the consumer boots');
  if (experienceBefore.rows && experienceAfter.rows) {
    assert(JSON.stringify(experienceBefore.rows) === JSON.stringify(experienceAfter.rows), `the consumer boots changed the shared experience rows: ${JSON.stringify({ before: experienceBefore.rows, after: experienceAfter.rows })}`);
  }
  evidence.preserved = {
    evolutionTreeDigestBefore: evolutionBefore.digest,
    evolutionTreeDigestAfter: evolutionAfter.digest,
    promotedSources: Object.fromEntries(index.plugins.map((row) => [row.id, sha256File(fileURLToPath(row.moduleUrl))])),
    sharedExperience: { before: experienceBefore, after: experienceAfter },
  };

  // 9. the revalidate-shaped projection: exact host identity, source digest and
  //    per-profile activation proof, only for records some consumer activated.
  const profileProof = (boots, row) => ({
    active: boots.every((boot) => (boot.rows || []).some((entry) => entry.id === row.id && entry.status === 'active')),
    status: (boots.at(-1)?.rows || []).find((entry) => entry.id === row.id)?.status ?? null,
    markerHits: boots.at(-1)?.markerHits?.[row.id] ?? null,
    markerListeners: boots.at(-1)?.markerListeners?.[row.id] ?? null,
  });
  const consumerWebBoots = [...webBoots, recoveredBoot];
  evidence.plugins = index.plugins
    .map((row) => ({ id: row.id, sourceSha256: row.sourceSha256, approvedProfiles: row.approvedProfiles, profiles: { web: profileProof(consumerWebBoots, row), acp: profileProof(acpBoots, row) } }))
    .filter((row) => row.profiles.web.active || row.profiles.acp.active);
  evidence.skippedRecords = index.plugins
    .filter((row) => !evidence.plugins.some((kept) => kept.id === row.id))
    .map((row) => ({
      id: row.id,
      sourceSha256: row.sourceSha256,
      web: profileProof(consumerWebBoots, row),
      acp: profileProof(acpBoots, row),
    }));
  assert(evidence.plugins.some((row) => row.id === stable.id), 'the stable record has no consumer activation proof');
  assert(evidence.skippedRecords.some((row) => row.id === incompatible.id), 'the incompatible record was not reported as skipped');

  // The committed evidence must be consumable by the operator revalidation
  // command. Run it on a copy of the isolated home so this check cannot change
  // the real promotion state the evidence describes.
  const revalidateEvidence = path.join(work, 'revalidate-evidence.json');
  fs.writeFileSync(revalidateEvidence, `${JSON.stringify(redact(evidence), null, 2)}\n`);
  const revalidateHome = path.join(work, 'revalidate-home');
  // Only the data root is needed by the revalidation command; copying the
  // profile node_modules would duplicate the installed runtime for no reason.
  fs.mkdirSync(revalidateHome, { recursive: true });
  fs.cpSync(path.join(home, 'storages'), path.join(revalidateHome, 'storages'), { recursive: true });
  // The copied records still name the original absolute module URLs, and the
  // official path validation rejects a record whose source is outside its own
  // data root. Rewrite the copy to point at the copied promoted sources.
  const copiedIndexPath = path.join(revalidateHome, 'storages', 'evolution', 'shared-plugins', 'published.json');
  const copiedIndex = JSON.parse(fs.readFileSync(copiedIndexPath, 'utf8'));
  for (const record of copiedIndex.plugins) {
    record.moduleUrl = pathToFileURL(path.join(revalidateHome, 'storages', 'evolution', 'promoted', record.pluginName, 'lib', 'index.js')).href;
  }
  fs.writeFileSync(copiedIndexPath, `${JSON.stringify(copiedIndex, null, 2)}\n`);
  const revalidate = runSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'shared-plugins.mjs'), 'revalidate', '--home', revalidateHome, '--evidence', revalidateEvidence, '--json'], {
    cwd: REPO_ROOT,
    env: { DSH_HOME: revalidateHome },
  });
  assert(revalidate.code === 0, `the evidence file was rejected by dsh-evolution-shared revalidate: ${revalidate.output.slice(-1200)}`);
  evidence.revalidate = { command: 'dsh-evolution-shared revalidate --home <copy> --evidence <this file>', code: revalidate.code, result: revalidate.output.trim().slice(-2000) };

  // 10. adopt the same real cross-entry evidence on the isolated home through
  //     the operator command itself, then review again. The copy above stays the
  //     proof that the evidence is consumable without changing the home it
  //     describes; this step is the actual operator action a self-evolution
  //     request must observe after a host upgrade. Once the record is
  //     revalidated and both consumers have booted against the new index it must
  //     be active again with no revalidate action.
  log('adopting the revalidation evidence on the isolated home and re-reviewing');
  const realRevalidate = runSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'shared-plugins.mjs'), 'revalidate', '--home', home, '--evidence', revalidateEvidence, '--json'], {
    cwd: REPO_ROOT,
    env: { DSH_HOME: home },
  });
  assert(realRevalidate.code === 0, `the operator revalidation was refused on the isolated home: ${realRevalidate.output.slice(-1200)}`);
  evidence.revalidate.realHome = { command: 'dsh-evolution-shared revalidate --home $DSH_HOME --evidence <this file>', code: realRevalidate.code, result: realRevalidate.output.trim().slice(-2000) };
  const revalidatedIndex = JSON.parse(fs.readFileSync(publishedPath, 'utf8'));
  const revalidatedRecord = revalidatedIndex.plugins.find((row) => row.id === stable.id);
  assert(Array.isArray(revalidatedRecord?.revalidation) && revalidatedRecord.revalidation.length >= 1, 'the adopted revalidation was not recorded on the isolated home');
  assert(revalidatedRecord.host?.dsh === hostVersion, `the adopted record host ${revalidatedRecord.host?.dsh} is not the installed host ${hostVersion}`);
  const webRevalidated = await bootWeb('web-revalidated', { expect: expectedActive, markers: activeMarkers });
  assertConsumerBoot('web', webRevalidated, 'web-revalidated', revalidatedIndex.updatedAt);
  const acpRevalidated = await bootAcp('acp-revalidated', { expect: expectedActive, markers: activeMarkers });
  assertConsumerBoot('acp', acpRevalidated, 'acp-revalidated', revalidatedIndex.updatedAt);
  const revalidatedReview = await runDesktopReview('review-revalidated', 'review-revalidated');
  const revalidatedReviewDocument = reviewDocument(revalidatedReview);
  const revalidatedReviewStable = reviewRecord(revalidatedReview, stable.id);
  assert(revalidatedReviewDocument.stablePlugins?.readOnly === true && revalidatedReviewDocument.selfEvolution?.readOnly === true, 'the post-revalidation Desktop review does not declare itself read-only');
  assert(revalidatedReviewStable?.status === 'active', `the review did not report the revalidated stable record as active: ${JSON.stringify(revalidatedReviewStable)}`);
  assert(revalidatedReviewStable?.action === null && reviewActionsFor(revalidatedReview, stable.id).length === 0, `the review still advises an action after revalidation: ${JSON.stringify(reviewActionsFor(revalidatedReview, stable.id))}`);
  assert(revalidatedReviewStable?.hostCompatible === true, `the revalidated record is still not host-compatible: ${JSON.stringify(revalidatedReviewStable?.hostReason)}`);
  assert(Number.isInteger(revalidatedReviewStable?.revalidationGenerations) && revalidatedReviewStable.revalidationGenerations >= 1, 'the review does not report the adopted revalidation generation');
  assert((revalidatedReviewDocument.selfEvolution?.nextActions ?? []).every((row) => row.action !== 'revalidate'), 'the review still advises revalidation after the evidence was adopted');
  assert(revalidatedReview.index.digest === revalidatedReview.index.digestAfter, 'the post-revalidation review changed the publication index bytes');
  assert(sha256(fs.readFileSync(publishedPath)) === revalidatedReview.index.digest, 'the post-revalidation review changed the publication index');
  evidence.review = {
    active: summarizeReview(activeReview),
    pendingRevalidation: summarizeReview(pendingReview),
    revalidated: summarizeReview(revalidatedReview),
  };

  evidence.ok = true;
  evidence.finishedAt = new Date().toISOString();
  log(`stable record ${stable.id} mounted by Web and ACP consumers; incompatible ${incompatible.id} skipped; load failure ${loadFailure.id} isolated; unified review active -> pending-revalidation -> active`);
} catch (error) {
  failure = String(error.stack || error);
  evidence.ok = false;
  evidence.error = String(error.message || error);
  evidence.finishedAt = new Date().toISOString();
}

const outPath = options.out || path.join(REPO_ROOT, 'docs', 'evidence', `cross-entry-desktop-${evidence.host?.dsh || 'unknown'}.json`);
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
console.log(JSON.stringify({ ok: evidence.ok, host: evidence.host, stable: evidence.desktop?.candidates?.stable?.id, web: evidence.web?.boots?.length, acp: evidence.acp?.boots?.length }));
