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
 *   5. writes `docs/evidence/cross-entry-desktop-<host>.json` with stable
 *      `$DSH_HOME` placeholders and the `dsh-evolution-cross-entry-evidence`
 *      shape the `dsh-evolution-shared revalidate` command accepts;
 *   6. removes the temporary work tree unless `--keep` is given.
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
 * KNOWN LIMITATION (observed 2026-11-11 on macOS, DSH 0.2.2-rc.1):
 * the isolated Desktop application initializes its profile and installs the
 * bundle, but the in-app publish probe does not complete. Inside the Desktop
 * host the trial marker listener was observed twice (`hits=2`), so the probe
 * refused to continue instead of recording ambiguous evidence; the exact
 * Desktop-host composition that duplicates the listener was not isolated within
 * the run's time box. This runner is therefore NOT part of CI and does not by
 * itself prove the Desktop -> ACP/Web role split. The CI host acceptance
 * (`docs/evidence/cross-entry-0.2.2-rc.1.json`, `--cross-entry`) proves the
 * publisher path through the full Evolution kernel booted on the Web profile
 * and the consumer path on a real headless ACP entry and a real Web entry. This
 * runner additionally requires an already-initialized isolated Desktop profile
 * (it initializes one itself when the profile manifest is absent).
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
const MARKERS = Object.freeze({ stable: 'cross-entry/probe/stable', incompatible: 'cross-entry/probe/incompatible' });

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

/** Run the real Desktop application and wait for the publish probe receipt. */
function runDesktopPublish() {
  const patchFile = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml');
  const marker = '# isolated cross-entry publish probe';
  const previous = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
  if (!previous.includes(marker)) {
    fs.appendFileSync(patchFile, `\n${marker}\n- insert:\n    - id: cross-entry-publish-probe\n      name: '${pathToFileURL(PROBE).href}'\n`);
  }
  const receipt = path.join(work, 'desktop-publish.json');
  const userData = path.join(work, 'electron-user-data');
  const logFile = fs.openSync(path.join(logs, 'desktop.log'), 'w', 0o600);
  const env = {
    ...INHERITED_ENV,
    DSH_HOME: home,
    EVOLUTION_ENTRY_PROBE_OUT: receipt,
    EVOLUTION_CROSS_ENTRY_PHASE: 'publish',
    EVOLUTION_ACCEPTANCE_CWD: home,
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
          ? 'the Desktop application exited before the publish probe reported'
          : `the Desktop application did not produce a receipt within ${options.timeoutMs} ms`);
      }
      const value = readJson(receipt);
      if (!value) throw new Error('the Desktop publish receipt is unreadable');
      if (value.ok === false) throw new Error(`the Desktop publish probe failed: ${value.error}`);
      return value;
    } finally {
      if (!exited) child.kill('SIGTERM');
      await Promise.race([exit, sleep(5000).then(() => { if (!exited) child.kill('SIGKILL'); })]);
    }
  })();
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
  evidence.host = { dsh: hostVersion, cli: path.relative(REPO_ROOT, cli) };

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
    userDataDir: '<work>/electron-user-data',
    publisherProfile: 'desktop',
    phase: publish.phase,
    services: publish.services,
    candidates: publish.candidates,
    index: publish.index,
  };
  const stable = publish.candidates?.stable;
  const incompatible = publish.candidates?.incompatible;
  const desktopOnly = publish.candidates?.desktopOnly;
  assert(Boolean(stable && incompatible && desktopOnly), 'the Desktop publish probe did not report all candidates');
  assert(JSON.stringify(stable.approvedProfiles) === JSON.stringify(['acp', 'web']), `the Desktop-published record carries approvedProfiles ${JSON.stringify(stable.approvedProfiles)}`);
  assert(stable.stable?.decision === 'benefit' && stable.stable?.canary?.startupVerified === true, 'the Desktop-published record has no stable proof');
  assert(desktopOnly.sharedStatus === 'desktop-only' && desktopOnly.published === false, 'the Desktop-only control promotion was published');

  const dataRoot = path.join(home, 'storages', 'evolution');
  const publishedPath = path.join(dataRoot, 'shared-plugins', 'published.json');
  const index = readJson(publishedPath);
  assert(Boolean(index) && Array.isArray(index.plugins), 'the publication index is missing after the Desktop promotion');
  const stableRecord = index.plugins.find((row) => row?.id === stable.id);
  assert(Boolean(stableRecord), 'the Desktop-published stable record is missing from the index');
  assert(stableRecord.publisherProfile === 'desktop', `the record publisherProfile is ${stableRecord.publisherProfile}, expected desktop`);
  assert(!index.plugins.some((row) => row?.id === desktopOnly.id), 'the Desktop-only control promotion was published');
  const indexDigest = sha256(fs.readFileSync(publishedPath));
  evidence.index = {
    path: path.join('$DSH_HOME', 'storages', 'evolution', 'shared-plugins', 'published.json'),
    updatedAt: index.updatedAt,
    digest: indexDigest,
    records: index.plugins.map((row) => ({ id: row?.id, publisherProfile: row?.publisherProfile, approvedProfiles: row?.approvedProfiles, sourceSha256: row?.sourceSha256, host: row?.host, stable: row?.stable })),
  };

  const expectedActive = {
    [stable.id]: { status: 'active' },
    [incompatible.id]: { status: 'skipped-incompatible', reason: 'missing-service' },
  };
  const activeMarkers = { [stable.id]: MARKERS.stable, [incompatible.id]: MARKERS.incompatible };

  // 4. the Web consumer, twice, with no kernel.
  log('booting the Web consumer entry (restart x2)');
  const webBoots = [];
  for (const label of ['web-1', 'web-2']) {
    const outcome = await bootWebConsumer(label, { expect: expectedActive, markers: activeMarkers });
    if (outcome.error) throw new Error(`Web consumer ${label} failed: ${outcome.error}`);
    const result = outcome.result;
    assert(result.profile === 'web', `the Web consumer reported profile ${result.profile}`);
    assert(result.kernelPresent === false && result.evolutionTools === 0, 'the Web consumer boot still runs the Evolution kernel');
    assert(result.observedIndexUpdatedAt === index.updatedAt, `the Web consumer observed index ${result.observedIndexUpdatedAt}, expected ${index.updatedAt}`);
    assert(result.markerHits?.[stable.id] === 1, `the Web consumer executed the promoted listener ${result.markerHits?.[stable.id]} times`);
    assert(result.markerHits?.[incompatible.id] === 0, 'the Web consumer mounted the incompatible plugin');
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
    const outcome = await bootAcpConsumer(label, { expect: expectedActive, markers: activeMarkers });
    if (outcome.error) throw new Error(`ACP consumer ${label} failed: ${outcome.error}`);
    const result = outcome.result;
    assert(result.profile === 'acp', `the ACP consumer reported profile ${result.profile}`);
    assert(result.kernelPresent === false && result.evolutionTools === 0, 'the ACP consumer boot still runs the Evolution kernel');
    assert(result.observedIndexUpdatedAt === index.updatedAt, `the ACP consumer observed index ${result.observedIndexUpdatedAt}, expected ${index.updatedAt}`);
    assert(result.markerHits?.[stable.id] === 1, `the ACP consumer executed the promoted listener ${result.markerHits?.[stable.id]} times`);
    assert(result.markerHits?.[incompatible.id] === 0, 'the ACP consumer mounted the incompatible plugin');
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

  // 6. the revalidate-shaped projection: exact host identity, source digest and
  //    per-profile activation proof for each published plugin.
  evidence.plugins = index.plugins.map((row) => ({
    id: row.id,
    sourceSha256: row.sourceSha256,
    approvedProfiles: row.approvedProfiles,
    profiles: {
      web: {
        active: webBoots.every((boot) => (boot.rows || []).some((entry) => entry.id === row.id && entry.status === 'active')),
        status: (webBoots.at(-1)?.rows || []).find((entry) => entry.id === row.id)?.status ?? null,
        markerHits: webBoots.at(-1)?.markerHits?.[row.id] ?? null,
      },
      acp: {
        active: acpBoots.every((boot) => (boot.rows || []).some((entry) => entry.id === row.id && entry.status === 'active')),
        status: (acpBoots.at(-1)?.rows || []).find((entry) => entry.id === row.id)?.status ?? null,
        markerHits: acpBoots.at(-1)?.markerHits?.[row.id] ?? null,
      },
    },
  }));
  evidence.host = { ...evidence.host, cordis: stableRecord.host?.cordis ?? null, include: stableRecord.host?.include ?? null, node: stableRecord.host?.node ?? process.version };
  evidence.ok = true;
  evidence.finishedAt = new Date().toISOString();
  log(`stable record ${stable.id} mounted by Web and ACP consumers; incompatible ${incompatible.id} skipped`);
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
