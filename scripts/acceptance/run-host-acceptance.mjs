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
 *      semantics and unchanged user data (with `--no-hmr` the host must report
 *      `restart-required` / `no-hmr` and apply the saved selection on restart)
 *   6. CLI uninstall, host boot with the bundle absent, CLI reinstall
 *   7. core flow again, proving the original user data was retained
 *   8. the README upgrade/rollback flow, real promotion through the official
 *      Include adapter across restarts, and a canary rollback
 *   9. (with --experience-evolution) real tool failures -> evolution_plan ->
 *      paired baseline/candidate probes -> refuse or promote -> restart recall
 *  10. (with --cross-entry) publish a stable promotion from the full-kernel Web
 *      entry with explicit ACP/Web approval, then prove the ACP and Web
 *      consumers mount it without the Evolution kernel: restart, incompatible
 *      plugin isolation, tampered source, operator revocation, simulated host
 *      upgrade/revalidation, and a real headless ACP consumer boot
 *  11. final doctor
 *
 * Usage:
 *   node scripts/acceptance/run-host-acceptance.mjs --host 0.2.0-rc.2 \
 *     [--tarball dist/dsh-evolution-0.2.0-rc.1.tgz] [--out docs/evidence/...] \
 *     [--work <dir>] [--runtime <dir>] [--no-hmr] [--experience-evolution] \
 *     [--cross-entry] [--keep]
 */
import { fork, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPO_ROOT, DIST_DIR, archiveContentDigest, packageFileName, readManifest } from '../release/release-lib.mjs';
import { createPrivateNpmEnv } from './npm-cache-env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBES = path.join(HERE, 'probes');
/**
 * Never inherit the caller's DSH environment. This acceptance must run only
 * against the isolated `$DSH_HOME` it creates: a caller that is itself running
 * inside a DSH profile (for example an ACP agent session) exports `DSH_PROFILE`
 * and `DSH_HOME`, and the booted host gives `process.env.DSH_PROFILE` priority
 * over its own `profileContext` when it resolves its profile. Inheriting it
 * would make the run diagnose (and consume) the wrong profile while the data
 * root is the isolated one.
 */
const INHERITED_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_')));
/** The tool surface the bundle registers (lib/registration.js#EVOLUTION_TOOLS).
 *  It is pinned here as a number so the harness does not have to load the host
 *  module; `scripts/acceptance/probes/*.mjs` wait for the same count live. */
const EXPECTED_TOOL_COUNT = 12;

/**
 * The experience-driven experiment acceptance runs its phases in separate
 * processes that share one `$DSH_HOME`. It needs the official batch tool
 * executor (`ctx.tools.execute({calls})`) that `0.2.2-rc.1` introduced; the
 * older declared hosts do not have that surface.
 */
const EXPERIENCE_EVOLUTION_HOSTS = Object.freeze(['0.2.2-rc.1', '0.2.2-rc.2']);
const EXPERIENCE_EVOLUTION_PHASES = ['seed', 'invalid', 'restart', 'regression'];

function parseArgs(argv) {
  const options = { keep: false, timeoutMs: 180000, noHmr: false, experienceEvolution: false, crossEntry: false };
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
    else if (arg === '--no-hmr') options.noHmr = true;
    else if (arg === '--experience-evolution') options.experienceEvolution = true;
    else if (arg === '--cross-entry') options.crossEntry = true;
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
  --no-hmr            disable the host's HMR row in every boot overlay, so a
                      profile change is applied on restart ("restart-required")
  --experience-evolution
                      add the real-host experience-driven experiment acceptance
                      (real failures -> plan -> baseline/candidate probes ->
                      measure -> refuse or promote -> restart recall); only
                      supported on ${EXPERIENCE_EVOLUTION_HOSTS.join(' or ')}
  --cross-entry       add the real-host cross-entry promotion acceptance: publish
                      a stable promotion with explicit ACP/Web approval from the
                      full-kernel Web entry, then prove the consumer-only Web and
                      headless ACP entries mount it and every fault-isolation,
                      revocation and revalidation case; only supported on
                      ${EXPERIENCE_EVOLUTION_HOSTS.join(' or ')}
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
if (options.experienceEvolution && !EXPERIENCE_EVOLUTION_HOSTS.includes(options.host)) {
  console.error(`refusing to run: --experience-evolution needs the official batch tool executor, which only ${EXPERIENCE_EVOLUTION_HOSTS.join(' or ')} of the declared hosts provides`);
  process.exit(2);
}
if (options.crossEntry && !EXPERIENCE_EVOLUTION_HOSTS.includes(options.host)) {
  console.error(`refusing to run: --cross-entry needs the host surfaces (batch tool executor, official Include consumer) that only ${EXPERIENCE_EVOLUTION_HOSTS.join(' or ')} of the declared hosts provides`);
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
  // The host capability that decides whether a profile change is applied live.
  // Every boot overlay disables the `hmr` row when this is false.
  hostLiveApply: options.noHmr ? 'disabled' : 'enabled',
  startedAt: new Date().toISOString(),
  steps: [],
  ...(options.experienceEvolution ? { experienceEvolution: {} } : {}),
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

/**
 * Count the raw samples a probe reported, by scenario role. The runner
 * re-derives every count from the samples instead of trusting the probe's own
 * summary; a phase only passes when the recorded calls show the behaviour the
 * phase claims (baseline fails, candidate succeeds, control does not regress).
 */
function countProbeSamples(samples) {
  const summary = { total: 0, errors: 0, target: { total: 0, errors: 0 }, control: { total: 0, errors: 0 } };
  for (const sample of Array.isArray(samples) ? samples : []) {
    const bucket = sample?.role === 'control' ? summary.control : summary.target;
    bucket.total += 1;
    summary.total += 1;
    if (sample?.isError === true) { bucket.errors += 1; summary.errors += 1; }
  }
  return summary;
}

/** Independent semantic cross-check of one experience-evolution phase. */
function crossCheckExperiencePhase(phase, result) {
  if (!result || result.ok === false) return { ok: false, reason: 'the phase did not report ok' };
  if (phase === 'restart') {
    const checks = {
      promotedToolExecuted: result.promotedTool?.executed === true && result.promotedTool?.markerMatched === true,
      startupSettled: ['stable', 'none', 'committed', 'committed-cleaned'].includes(result.startupPhase),
      sharedConclusion: Number(result.history?.successes ?? 0) > 0,
      planSettled: result.planSettled === true,
      durableEvidence: result.durableEvidence?.sidecar === true && result.durableEvidence?.decision === true
        && Boolean(result.durableEvidence?.applicability),
    };
    return {
      ok: Object.values(checks).every(Boolean),
      checks,
      failure: Object.entries(checks).filter(([, value]) => !value).map(([name]) => name),
    };
  }
  const baseline = countProbeSamples(result.probes?.baseline?.samples);
  const candidate = countProbeSamples(result.probes?.candidate?.samples);
  const checks = {};
  if (phase === 'seed') {
    checks.safetyPreflight = result.probes?.baseline?.safety?.policy === 'official-concurrency-safe'
      && result.probes?.candidate?.safety?.policy === 'official-concurrency-safe';
    checks.baselineTargetFailed = baseline.target.total > 0 && baseline.target.errors === baseline.target.total;
    checks.baselineControlSucceeded = baseline.control.total > 0 && baseline.control.errors === 0;
    checks.candidateTargetSucceeded = candidate.target.total > 0 && candidate.target.errors === 0;
    checks.candidateControlSucceeded = candidate.control.total > 0 && candidate.control.errors === 0;
    checks.measureBenefit = result.measure?.gates?.measuredEvidence === true && result.measure?.gates?.realBenefit === true;
    checks.canarySettled = result.canary?.second === 'stable';
  } else if (phase === 'invalid') {
    checks.safetyPreflight = result.probes?.baseline?.safety?.policy === 'official-concurrency-safe'
      && result.probes?.candidate?.safety?.policy === 'official-concurrency-safe';
    checks.baselineTargetFailed = baseline.target.total > 0 && baseline.target.errors === baseline.target.total;
    checks.candidateTargetUnimproved = candidate.target.total > 0 && candidate.target.errors === candidate.target.total;
    checks.gatesRefused = result.measure?.gates?.measuredEvidence === false && result.measure?.gates?.realBenefit === false;
    checks.runtimeRecovered = result.revert?.runtimeRecovered === true;
    checks.claimReleased = result.claimReleased === true;
    checks.strategyRefused = result.duplicateProposal?.reason === 'strategy-already-proven-ineffective';
  } else if (phase === 'regression') {
    checks.safetyPreflight = result.probes?.baseline?.safety?.policy === 'official-concurrency-safe'
      && result.probes?.candidate?.safety?.policy === 'official-concurrency-safe';
    checks.baselineTargetFailed = baseline.target.total > 0 && baseline.target.errors === baseline.target.total;
    checks.baselineControlSucceeded = baseline.control.total > 0 && baseline.control.errors === 0;
    checks.candidateTargetSucceeded = candidate.target.total > 0 && candidate.target.errors === 0;
    checks.candidateControlRegressed = candidate.control.errors > 0;
    checks.promotionRefused = result.refused?.reason === 'promotion-gate' || result.refused?.reason === 'domain-evaluator-rollback';
    checks.runtimeRecovered = result.revert?.runtimeRecovered === true;
  } else {
    return { ok: false, reason: `unknown experience-evolution phase ${phase}` };
  }
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    baseline,
    candidate,
    failure: Object.entries(checks).filter(([, value]) => !value).map(([name]) => name),
  };
}

/** The evidence projection of one phase; raw samples stay bounded and free of
 *  tool error text (only codes, roles and timestamps cross this boundary). */
function selectExperienceEvidence(phase, result) {
  const probes = {};
  for (const name of ['baseline', 'candidate']) {
    const part = result?.probes?.[name];
    if (part) probes[name] = { scenarioDigest: part.scenarioDigest ?? null, safety: part.safety ?? null, samples: part.samples ?? [], summary: countProbeSamples(part.samples) };
  }
  return {
    ok: true,
    phase,
    experimentId: result?.experimentId ?? null,
    toolCount: result?.toolCount ?? null,
    store: result?.store ?? null,
    plan: result?.plan ?? null,
    probes,
    measure: result?.measure ?? null,
    canary: result?.canary ?? null,
    refused: result?.refused ?? null,
    revert: result?.revert ?? null,
    trialGone: result?.trialGone ?? null,
    duplicateProposal: result?.duplicateProposal ?? null,
    claimReleased: result?.claimReleased ?? null,
    conclusionRecallable: result?.conclusionRecallable ?? null,
    promotedTool: result?.promotedTool ?? null,
    startupPhase: result?.startupPhase ?? null,
    history: result?.history ?? null,
    planSettled: result?.planSettled ?? null,
    durableEvidence: result?.durableEvidence ?? null,
    controlRestored: result?.controlRestored ?? null,
  };
}

function cliPath() {
  return path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

function runCommand(command, args, { cwd = work, env = {}, timeoutMs = options.timeoutMs } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...INHERITED_ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (bytes) => { output += bytes.toString(); });
    child.stderr.on('data', (bytes) => { output += bytes.toString(); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, output: `${output}\n${error.message}` }); });
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
  });
}

function runCliProfile(profile, args) {
  return runCommand(process.execPath, [cliPath(), 'plugin', '--profile', profile, ...args], {
    env: { DSH_HOME: home },
  });
}

function runCli(args) {
  return runCliProfile('web', args);
}

/**
 * Boot one probe entry. Existing callers keep the original three-argument form
 * (web profile, no extra rows); the cross-entry acceptance passes extra overlay
 * rows (for example disabling the kernel row to boot a consumer-only entry) and
 * an alternate profile without changing any earlier step.
 */
function bootProbe(name, probeFile, extraEnv = {}, { profile = 'web', rows = [], awaitExit = false } = {}) {
  const patchFile = path.join(work, `${name}.patch.yml`);
  // `--no-hmr` addresses the base bundle's `hmr` row in the official overlay
  // form ("id-targeted config overrides, disables, and insert lists"). It is the
  // documented "applies changes on restart" configuration, not a workaround:
  // without the service, PluginManager.configure() runs the operation directly
  // and reload() composes the saved profile instead of reconciling it live.
  const hmrRow = options.noHmr ? '- id: hmr\n  disabled: true\n' : '';
  const extraRows = rows
    .map((row) => `- id: ${row.id}\n  disabled: ${row.disabled === true}\n`)
    .join('');
  fs.writeFileSync(patchFile, `${hmrRow}${extraRows}- insert:\n    - id: evolution-acceptance-${name}\n      name: '${pathToFileURL(probeFile).href}'\n`);
  return new Promise((resolve) => {
    const child = fork(
      cliPath(),
      ['--profile', profile, '--patch', patchFile, '--', '--no-open', '--host', '127.0.0.1', '--port', '0'],
      { cwd: work, env: { ...INHERITED_ENV, DSH_HOME: home, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
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
      if (!awaitExit) { resolve({ ...value, log: text }); return; }
      // Consumer restarts must start only after the previous entry finished its
      // shutdown: its disposal rewrites the consumer state, and reading that
      // write as the next boot's activation would fake a duplicate-free restart.
      const exited = () => resolve({ ...value, log: text });
      if (child.exitCode !== null || child.signalCode !== null) { exited(); return; }
      child.once('exit', exited);
      setTimeout(exited, 5000).unref?.();
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

/**
 * A version strictly greater than the shipped one, for the upgrade step.
 *
 * A release candidate keeps the historical `<version>.upgrade` suffix: that is a
 * valid pre-release of the same `major.minor.patch` and sorts above the candidate
 * itself. A stable version has no pre-release component to extend, so
 * `0.2.0.upgrade` is not semver at all and the official CLI would refuse it;
 * the upgrade artifact takes the next patch instead, which is what a real
 * upgrade to a newer release looks like.
 */
function upgradeVersionFor(version) {
  if (version.includes('-')) return `${version}.upgrade`;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error('the bundle version is neither a stable semver version nor a pre-release of one');
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

/** Pack an already-extracted package directory (used for the upgrade artifact). */
function packDirectory(dir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const result = spawnSync('npm', ['pack', '--json', '--pack-destination', destDir, '--ignore-scripts'], {
    cwd: dir,
    encoding: 'utf8',
    env: createPrivateNpmEnv(work),
  });
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
// cross-entry acceptance (--cross-entry)
// ---------------------------------------------------------------------------

/** The marker events the promoted probe plugins register; the consumer probe
 *  executes the same names, so one fixed vocabulary links both phases. */
const CROSS_ENTRY_MARKERS = Object.freeze({
  stable: 'cross-entry/probe/stable',
  incompatible: 'cross-entry/probe/incompatible',
});

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function fileSha256(file) {
  try { return sha256(file); } catch { return null; }
}

function assertCross(condition, message) {
  if (!condition) throw new Error(`cross-entry: ${message}`);
}

/** Boot one Web entry that runs only the lightweight consumer (kernel row off). */
async function bootWebConsumer(label, { expect, markers, kernel = false }) {
  const bootAfter = new Date().toISOString();
  return bootProbe(`cross-entry-${label}`, path.join(PROBES, 'cross-entry-consumer-probe.mjs'), {
    EVOLUTION_CROSS_ENTRY_PROFILE: 'web',
    EVOLUTION_CROSS_ENTRY_EXPECT: JSON.stringify(expect),
    EVOLUTION_CROSS_ENTRY_MARKERS: JSON.stringify(markers || {}),
    EVOLUTION_CROSS_ENTRY_BOOT_AFTER: bootAfter,
    ...(kernel ? { EVOLUTION_CROSS_ENTRY_EXPECT_KERNEL: '1' } : {}),
  }, kernel ? { awaitExit: true } : { rows: [{ id: 'evolution-orchestrator', disabled: true }], awaitExit: true });
}

/**
 * Boot the full Evolution kernel on the Web profile with the promoted-consumer
 * row disabled, then call the registered `evolution_plan` tool (the unified
 * read-only review) in that real host.
 *
 * The isolated host acceptance has no Desktop binary, so the Web profile is the
 * publisher stand-in: leaving the promoted consumer enabled would rewrite the
 * Web activation row as `disabled/publisher-profile` (the publisher profile
 * never mounts its own publications) before the review reads it. The durable
 * activation records the real consumer-only boots wrote are the facts the
 * review must classify, so this boot only disables the consumer row; the kernel,
 * the tool registry and the tool call are real. The probe snapshots the
 * publication index bytes around the tool call and fails on any write.
 */
async function bootWebReview(label, phase) {
  return bootProbe(`cross-entry-${label}`, path.join(PROBES, 'cross-entry-promotion-probe.mjs'), {
    EVOLUTION_CROSS_ENTRY_PHASE: phase,
    EVOLUTION_ACCEPTANCE_CWD: work,
  }, { rows: [{ id: 'evolution-promoted-consumer', disabled: true }] });
}

/**
 * Boot the headless ACP consumer.
 *
 * The ACP entry is a JSON-RPC server, so the runner keeps its stdin open with
 * one documented, model-free `initialize` handshake and waits for the probe's
 * file receipt. No session is created and no model call is made; the ACP entry
 * boots its plugin tree (and therefore the consumer) as soon as it starts.
 */
function bootAcpConsumer(label, { expect, markers }) {
  const probeFile = path.join(PROBES, 'cross-entry-consumer-probe.mjs');
  const patchFile = path.join(work, `cross-entry-${label}.patch.yml`);
  fs.writeFileSync(patchFile, `- id: evolution-orchestrator\n  disabled: true\n- insert:\n    - id: evolution-acceptance-${label}\n      name: '${pathToFileURL(probeFile).href}'\n`);
  const receipt = path.join(work, `cross-entry-${label}.receipt.json`);
  const bootAfter = new Date().toISOString();
  return new Promise((resolve) => {
    const child = spawn(cliPath(), ['--profile', 'acp', '--patch', patchFile], {
      cwd: work,
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
      fs.writeFileSync(path.join(logs, `cross-entry-${label}.log`), text);
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
    } catch { /* reported by the timeout if the entry cannot start */ }
    poll = setInterval(() => {
      if (!fs.existsSync(receipt)) return;
      const value = readJsonFile(receipt);
      if (!value) return;
      finish(value.ok === false ? { error: value.error } : { result: value });
    }, 200);
  });
}

/**
 * The `--cross-entry` steps. Every assertion below fails the run; the evidence
 * section records the observed facts (ids, statuses, hit counts, digests,
 * file presence) instead of restating the expectation.
 */
async function runCrossEntryAcceptance() {
  const dataRoot = path.join(home, 'storages', 'evolution');
  const sharedDir = path.join(dataRoot, 'shared-plugins');
  const publishedPath = path.join(sharedDir, 'published.json');
  const consumerStatePath = (profile) => path.join(sharedDir, 'consumers', `${profile}.json`);
  const promotedRoot = path.join(dataRoot, 'promoted');
  const archiveDir = path.join(dataRoot, 'archive', 'experiments');
  const sharedExperienceDb = path.join(home, 'storages', 'evolution-experience', 'experience.sqlite');

  const report = {
    // The isolated host acceptance has no Desktop binary, so the full Evolution
    // kernel booted on the Web profile is the promotion authority here and the
    // published records carry `publisherProfile: 'web'`. The real Desktop ->
    // ACP/Web role split is proven by scripts/acceptance/run-cross-entry.mjs.
    publisherProfile: 'web',
    publisherProfileNote: 'isolated host acceptance boots the full Evolution kernel on the web profile; no Desktop binary in CI',
    markers: { ...CROSS_ENTRY_MARKERS },
    indexPath: path.join('$DSH_HOME', 'storages', 'evolution', 'shared-plugins', 'published.json'),
  };
  evidence.crossEntry = report;

  // (a) publish a stable promotion with explicit ACP/Web approval.
  const publishOutcome = await bootProbe('cross-entry-publish', path.join(PROBES, 'cross-entry-promotion-probe.mjs'), {
    EVOLUTION_CROSS_ENTRY_PHASE: 'publish',
    EVOLUTION_ACCEPTANCE_CWD: work,
  });
  const published = publishOutcome.result;
  const stable = published?.candidates?.stable;
  const desktopOnly = published?.candidates?.desktopOnly;
  const incompatible = published?.candidates?.incompatible;
  record('cross-entry-publish', {
    ok: !publishOutcome.error && Boolean(stable && desktopOnly && incompatible),
    ids: { stable: stable?.id, desktopOnly: desktopOnly?.id, incompatible: incompatible?.id },
    approvedProfiles: stable?.approvedProfiles,
    stable: stable?.stable,
    desktopOnlySharedStatus: desktopOnly?.sharedStatus,
    incompatibleRequiredServices: incompatible?.requiredServices,
    indexUpdatedAt: published?.index?.updatedAt,
    services: published?.services,
    error: publishOutcome.error,
  });
  if (publishOutcome.error) throw new Error(`cross-entry publish probe failed: ${publishOutcome.error}`);
  assertCross(Boolean(stable && desktopOnly && incompatible), 'the publish probe did not report all three candidates');
  assertCross(JSON.stringify(stable.approvedProfiles) === JSON.stringify(['acp', 'web']), `the published record carries approvedProfiles ${JSON.stringify(stable.approvedProfiles)}`);
  assertCross(stable.stable?.decision === 'benefit' && stable.stable?.canary?.startupVerified === true && typeof stable.stable?.committedAt === 'string', 'the published record has no stable proof');
  assertCross(/^[a-f0-9]{64}$/.test(String(stable.sourceSha256)), 'the published record has no source digest');
  assertCross(['published', 'updated', 'unchanged'].includes(stable.sharedStatus), `the stable commit reported shared.status ${stable.sharedStatus}`);
  assertCross(desktopOnly.sharedStatus === 'desktop-only' && desktopOnly.published === false, `the Desktop-only control reported ${JSON.stringify({ status: desktopOnly.sharedStatus, published: desktopOnly.published })}`);
  assertCross(Array.isArray(incompatible.requiredServices) && incompatible.requiredServices.includes('evolution'), `the incompatible record does not require the kernel service: ${JSON.stringify(incompatible.requiredServices)}`);

  const indexAfterPublish = readJsonFile(publishedPath);
  assertCross(Boolean(indexAfterPublish) && Array.isArray(indexAfterPublish.plugins), 'the publication index is missing after the stable commit');
  const publishedIds = indexAfterPublish.plugins.map((row) => row?.id);
  assertCross(publishedIds.includes(stable.id) && publishedIds.includes(incompatible.id), `the publication index does not contain both approved records: ${JSON.stringify(publishedIds)}`);
  assertCross(!publishedIds.includes(desktopOnly.id), 'the Desktop-only control promotion was published');
  assertCross(indexAfterPublish.updatedAt === published.index.updatedAt, `the probe observed index ${published.index.updatedAt}, the file says ${indexAfterPublish.updatedAt}`);
  const indexUpdatedAt = indexAfterPublish.updatedAt;
  report.index = {
    updatedAt: indexUpdatedAt,
    digest: fileSha256(publishedPath),
    records: indexAfterPublish.plugins.map((row) => ({
      id: row?.id,
      approvedProfiles: row?.approvedProfiles,
      sourceSha256: row?.sourceSha256,
      stable: row?.stable,
      host: row?.host,
    })),
  };
  report.publish = { steps: published.steps, services: published.services, candidates: { stable, desktopOnly, incompatible } };

  const expectedActive = {
    [stable.id]: { status: 'active' },
    [incompatible.id]: { status: 'skipped-incompatible', reason: 'missing-service' },
  };
  const activeMarkers = {
    [stable.id]: CROSS_ENTRY_MARKERS.stable,
    [incompatible.id]: CROSS_ENTRY_MARKERS.incompatible,
  };
  /** A bounded projection of one unified-review receipt for the evidence file. */
  const reviewSummary = (receipt) => {
    const review = receipt?.review ?? {};
    const stablePlugins = review.stablePlugins ?? {};
    const selfEvolution = review.selfEvolution ?? {};
    return {
      phase: receipt?.phase ?? null,
      readOnly: stablePlugins.readOnly === true && selfEvolution.readOnly === true,
      status: stablePlugins.status ?? null,
      indexRecordCount: stablePlugins.indexRecordCount ?? null,
      truncated: stablePlugins.truncated ?? null,
      primary: selfEvolution.primary ?? null,
      kind: selfEvolution.kind ?? null,
      hasBlockingStableIssue: selfEvolution.hasBlockingStableIssue ?? null,
      incomplete: selfEvolution.incomplete === true,
      record: (stablePlugins.records ?? []).find((row) => row.id === stable.id) ?? null,
      nextActions: selfEvolution.nextActions ?? [],
      indexDigest: receipt?.index?.digest ?? null,
      indexDigestAfter: receipt?.index?.digestAfter ?? null,
      steps: receipt?.steps ?? [],
    };
  };

  // (b) consumer-only boot: same home, same Web profile, kernel row disabled.
  const firstConsumer = await bootWebConsumer('consumer', { expect: expectedActive, markers: activeMarkers });
  const firstResult = firstConsumer.result;
  record('cross-entry-consumer', {
    ok: !firstConsumer.error && Boolean(firstResult),
    profile: firstResult?.profile,
    kernelPresent: firstResult?.kernelPresent,
    evolutionTools: firstResult?.evolutionTools,
    observedIndexUpdatedAt: firstResult?.observedIndexUpdatedAt,
    indexUpdatedAt,
    rows: firstResult?.rows,
    markerHits: firstResult?.markerHits,
    services: firstResult?.services,
    error: firstConsumer.error,
  });
  if (firstConsumer.error) throw new Error(`cross-entry consumer probe failed: ${firstConsumer.error}`);
  assertCross(firstResult.kernelPresent === false && firstResult.evolutionTools === 0, 'the consumer-only boot still runs the Evolution kernel');
  assertCross(firstResult.observedIndexUpdatedAt === indexUpdatedAt, `the consumer observed index ${firstResult.observedIndexUpdatedAt}, expected ${indexUpdatedAt}`);
  assertCross(firstResult.markerHits?.[stable.id] === 1, `the promoted listener executed ${firstResult.markerHits?.[stable.id]} times, expected exactly once`);
  assertCross(firstResult.markerHits?.[incompatible.id] === 0, 'the incompatible plugin was mounted in the consumer');
  report.consumer = { initial: firstResult };

  // (c) restart: no duplicate instance or registration, activatedAt moves.
  const restarted = await bootWebConsumer('consumer-restart', { expect: expectedActive, markers: activeMarkers });
  const restartResult = restarted.result;
  const firstActivatedAt = (firstResult.rows || []).find((row) => row.id === stable.id)?.activatedAt;
  const secondActivatedAt = (restartResult?.rows || []).find((row) => row.id === stable.id)?.activatedAt;
  record('cross-entry-consumer-restart', {
    ok: !restarted.error && Boolean(restartResult),
    rows: restartResult?.rows,
    markerHits: restartResult?.markerHits,
    firstActivatedAt,
    secondActivatedAt,
    error: restarted.error,
  });
  if (restarted.error) throw new Error(`cross-entry consumer restart probe failed: ${restarted.error}`);
  assertCross(restartResult.markerHits?.[stable.id] === 1, `the promoted listener executed ${restartResult.markerHits?.[stable.id]} times after restart, expected exactly once`);
  assertCross(typeof firstActivatedAt === 'string' && typeof secondActivatedAt === 'string' && secondActivatedAt > firstActivatedAt, `activatedAt did not move across restart: ${firstActivatedAt} -> ${secondActivatedAt}`);
  report.consumer.restart = restartResult;

  // (d) full-kernel Web boot: the consumer row is also enabled, and it must not
  //     double-mount its own profile's publications.
  const combined = await bootWebConsumer('consumer-kernel', {
    expect: {
      [stable.id]: { status: 'disabled', reason: 'publisher-profile', expectListener: true },
      [incompatible.id]: { status: 'disabled', reason: 'publisher-profile' },
    },
    markers: { [stable.id]: CROSS_ENTRY_MARKERS.stable },
    kernel: true,
  });
  const combinedResult = combined.result;
  record('cross-entry-consumer-kernel', {
    ok: !combined.error && Boolean(combinedResult),
    kernelPresent: combinedResult?.kernelPresent,
    evolutionTools: combinedResult?.evolutionTools,
    rows: combinedResult?.rows,
    markerHits: combinedResult?.markerHits,
    error: combined.error,
  });
  if (combined.error) throw new Error(`cross-entry full-kernel consumer probe failed: ${combined.error}`);
  assertCross(combinedResult.kernelPresent === true && combinedResult.evolutionTools === EXPECTED_TOOL_COUNT, 'the full-kernel Web boot did not expose the kernel surface');
  assertCross(combinedResult.markerHits?.[stable.id] === 1, `the full-kernel Web boot registered the promoted listener ${combinedResult.markerHits?.[stable.id]} times, expected exactly once (no duplicate mount)`);
  report.consumer.kernelCombined = combinedResult;

  // (e) tampered promoted source: only that record is invalid, the other keeps
  //     its own status, and restoring the bytes recovers.
  const stableSource = path.join(promotedRoot, stable.pluginName, 'lib', 'index.js');
  const incompatibleSource = path.join(promotedRoot, incompatible.pluginName, 'lib', 'index.js');
  assertCross(fs.existsSync(stableSource), 'the promoted stable source is missing');
  assertCross(fs.existsSync(incompatibleSource), 'the promoted incompatible source is missing');
  assertCross(fileSha256(stableSource) === stable.sourceSha256, 'the promoted stable source digest does not match the published record');
  const stableSourceBytes = fs.readFileSync(stableSource);
  fs.writeFileSync(stableSource, `${stableSourceBytes.toString('utf8')}\n// tampered by the isolated acceptance run\n`);
  let tamperedResult;
  try {
    const tampered = await bootWebConsumer('consumer-tampered', {
      expect: {
        [stable.id]: { status: 'skipped-invalid', reason: 'source-digest-mismatch' },
        [incompatible.id]: { status: 'skipped-incompatible', reason: 'missing-service' },
      },
      markers: {},
    });
    if (tampered.error) throw new Error(`cross-entry tampered-source probe failed: ${tampered.error}`);
    tamperedResult = tampered.result;
  } finally {
    fs.writeFileSync(stableSource, stableSourceBytes);
  }
  record('cross-entry-tampered-source', { ok: Boolean(tamperedResult), rows: tamperedResult?.rows });
  assertCross(tamperedResult.rows.some((row) => row.id === stable.id && row.status === 'skipped-invalid' && row.reason === 'source-digest-mismatch'), `the tampered source was not reported as skipped-invalid: ${JSON.stringify(tamperedResult.rows)}`);
  assertCross(tamperedResult.rows.some((row) => row.id === incompatible.id && row.status === 'skipped-incompatible'), 'the tampered plugin changed the unrelated record');
  assertCross(fileSha256(stableSource) === stable.sourceSha256, 'restoring the promoted source bytes failed');
  const recovered = await bootWebConsumer('consumer-source-restored', { expect: expectedActive, markers: activeMarkers });
  if (recovered.error) throw new Error(`cross-entry source-restore probe failed: ${recovered.error}`);
  assertCross(recovered.result.markerHits?.[stable.id] === 1, 'the restored source did not mount again');
  report.consumer.tampered = tamperedResult;
  report.consumer.sourceRestored = recovered.result;

  // (f) operator revocation through the installed shared-plugins CLI.
  const sharedCli = path.join(home, 'profiles', 'web', 'node_modules', 'dsh-evolution', 'scripts', 'shared-plugins.mjs');
  assertCross(fs.existsSync(sharedCli), `the installed bundle has no shared-plugins CLI at ${sharedCli}`);
  const revoke = await runCommand(process.execPath, [sharedCli, 'disable', '--home', home, '--plugin', stable.id, '--profile', 'web'], { env: { DSH_HOME: home } });
  record('cross-entry-revoke', { ok: revoke.code === 0, code: revoke.code, tail: revoke.output.trim().split('\n').slice(-3) });
  assertCross(revoke.code === 0, `shared-plugins disable exited ${revoke.code}: ${revoke.output.slice(-500)}`);
  const revoked = await bootWebConsumer('consumer-revoked', {
    expect: {
      [stable.id]: { status: 'disabled', reason: 'operator-disabled' },
      [incompatible.id]: { status: 'skipped-incompatible', reason: 'missing-service' },
    },
    markers: {},
  });
  if (revoked.error) throw new Error(`cross-entry revoked probe failed: ${revoked.error}`);
  assertCross(revoked.result.rows.some((row) => row.id === stable.id && row.status === 'disabled' && row.reason === 'operator-disabled'), `the revoked record is not disabled: ${JSON.stringify(revoked.result.rows)}`);
  report.consumer.revoked = revoked.result;
  const restore = await runCommand(process.execPath, [sharedCli, 'enable', '--home', home, '--plugin', stable.id, '--profile', 'web'], { env: { DSH_HOME: home } });
  record('cross-entry-enable', { ok: restore.code === 0, code: restore.code, tail: restore.output.trim().split('\n').slice(-3) });
  assertCross(restore.code === 0, `shared-plugins enable exited ${restore.code}: ${restore.output.slice(-500)}`);
  const reenabled = await bootWebConsumer('consumer-reenabled', { expect: expectedActive, markers: activeMarkers });
  if (reenabled.error) throw new Error(`cross-entry re-enabled probe failed: ${reenabled.error}`);
  assertCross(reenabled.result.markerHits?.[stable.id] === 1, 'the re-enabled record did not mount again');
  report.consumer.reenabled = reenabled.result;

  // (g) simulated host upgrade: a record verified on another DSH release needs
  //     revalidation and is not mounted; the unrelated record is unaffected;
  //     restoring the index recovers without changing promoted bytes.
  const preserved = {
    promotedSources: {
      stable: { path: path.join('$DSH_HOME', 'storages', 'evolution', 'promoted', stable.pluginName, 'lib', 'index.js'), sha256: fileSha256(stableSource) },
      incompatible: { path: path.join('$DSH_HOME', 'storages', 'evolution', 'promoted', incompatible.pluginName, 'lib', 'index.js'), sha256: fileSha256(incompatibleSource) },
      desktopOnly: { path: path.join('$DSH_HOME', 'storages', 'evolution', 'promoted', desktopOnly.pluginName, 'lib', 'index.js'), sha256: fileSha256(path.join(promotedRoot, desktopOnly.pluginName, 'lib', 'index.js')) },
    },
    archives: [stable.experimentId, incompatible.experimentId, desktopOnly.experimentId].map((experimentId) => ({
      experimentId,
      archive: fs.existsSync(path.join(archiveDir, `${experimentId}.md`)),
      sidecar: fs.existsSync(path.join(archiveDir, `${experimentId}.evidence.json`)),
    })),
    sharedExperience: { present: fs.existsSync(sharedExperienceDb), sha256: fileSha256(sharedExperienceDb) },
    memory: { present: fs.existsSync(memoryPath), sha256: fileSha256(memoryPath) },
  };
  assertCross(preserved.promotedSources.stable.sha256 === stable.sourceSha256, 'the stable promoted source is not the published source');
  assertCross(preserved.promotedSources.incompatible.sha256 === incompatible.sourceSha256, 'the incompatible promoted source is not the published source');
  assertCross(preserved.archives.every((row) => row.archive && row.sidecar), `promotion archives/sidecars are missing: ${JSON.stringify(preserved.archives)}`);
  assertCross(preserved.sharedExperience.present, 'the shared-experience SQLite database is missing');

  const indexBytes = fs.readFileSync(publishedPath);
  const simulatedIndex = JSON.parse(indexBytes.toString('utf8'));
  const simulatedRow = simulatedIndex.plugins.find((row) => row?.id === stable.id);
  assertCross(Boolean(simulatedRow), 'the published stable record disappeared before the upgrade simulation');
  simulatedRow.host = { ...simulatedRow.host, dsh: '9.9.9-simulated-upgrade' };
  const simulatedIndexBytes = Buffer.from(`${JSON.stringify(simulatedIndex, null, 2)}\n`);
  const simulatedIndexDigest = crypto.createHash('sha256').update(simulatedIndexBytes).digest('hex');
  fs.writeFileSync(publishedPath, simulatedIndexBytes);
  let revalidationResult;
  let pendingReview;
  try {
    const pending = await bootWebConsumer('consumer-revalidation', {
      expect: {
        [stable.id]: { status: 'pending-revalidation', reason: 'host-version-mismatch' },
        [incompatible.id]: { status: 'skipped-incompatible', reason: 'missing-service' },
      },
      markers: {},
    });
    if (pending.error) throw new Error(`cross-entry revalidation probe failed: ${pending.error}`);
    revalidationResult = pending.result;
    // The review runs while the simulated upgrade is the only index on disk, so
    // it classifies exactly the state the consumer boot just observed.
    pendingReview = await bootWebReview('review-pending', 'review-pending');
  } finally {
    fs.writeFileSync(publishedPath, indexBytes);
  }
  record('cross-entry-revalidation', { ok: Boolean(revalidationResult), rows: revalidationResult?.rows });
  assertCross(revalidationResult.rows.some((row) => row.id === stable.id && row.status === 'pending-revalidation' && row.reason === 'host-version-mismatch'), `the upgraded-host record is not pending-revalidation: ${JSON.stringify(revalidationResult.rows)}`);
  assertCross(revalidationResult.rows.some((row) => row.id === incompatible.id && row.status === 'skipped-incompatible'), 'the simulated upgrade changed the unrelated record');
  if (pendingReview.error) throw new Error(`cross-entry pending-revalidation review probe failed: ${pendingReview.error}`);
  const pendingReviewReceipt = pendingReview.result;
  const pendingReviewDocument = pendingReviewReceipt?.review ?? {};
  const pendingReviewStable = (pendingReviewDocument.stablePlugins?.records ?? []).find((row) => row.id === stable.id);
  const pendingReviewActions = (pendingReviewDocument.selfEvolution?.nextActions ?? []).filter((row) => row.recordId === stable.id);
  const pendingRevalidate = pendingReviewActions.find((row) => row.action === 'revalidate');
  record('cross-entry-review-pending-revalidation', { ok: Boolean(pendingReviewReceipt), summary: reviewSummary(pendingReviewReceipt), error: pendingReview.error });
  assertCross(pendingReviewDocument.stablePlugins?.readOnly === true && pendingReviewDocument.selfEvolution?.readOnly === true, 'the review during the simulated upgrade does not declare itself read-only');
  assertCross(pendingReviewStable?.status === 'pending-revalidation', `the review did not report the upgraded record as pending-revalidation: ${JSON.stringify(pendingReviewStable)}`);
  assertCross(pendingReviewStable?.action === 'revalidate', `the upgraded record action is ${pendingReviewStable?.action}, expected revalidate`);
  assertCross(pendingReviewStable?.hostCompatible === false && pendingReviewStable?.hostReason === 'host-version-mismatch', `the upgraded record host verdict is ${JSON.stringify({ compatible: pendingReviewStable?.hostCompatible, reason: pendingReviewStable?.hostReason })}`);
  assertCross(pendingRevalidate?.recordId === stable.id, `the revalidate next action does not name the upgraded record: ${JSON.stringify(pendingRevalidate)}`);
  assertCross(typeof pendingRevalidate.command === 'string' && pendingRevalidate.command.includes('shared-plugins.mjs') && pendingRevalidate.command.includes('revalidate --evidence'), `the revalidate next action has no operator command: ${JSON.stringify(pendingRevalidate.command)}`);
  const pendingForbidden = Array.isArray(pendingRevalidate.forbidden) ? pendingRevalidate.forbidden : [];
  assertCross(pendingForbidden.includes('edit or regenerate the promoted plugin source'), `the revalidate next action does not forbid regenerating the source: ${JSON.stringify(pendingForbidden)}`);
  assertCross(pendingForbidden.includes('weaken the recorded host identity'), `the revalidate next action does not protect the recorded host identity: ${JSON.stringify(pendingForbidden)}`);
  assertCross(pendingReviewDocument.selfEvolution?.primary === 'revalidate' && pendingReviewDocument.selfEvolution?.hasBlockingStableIssue === true, `the review did not give the host upgrade priority over other work: ${JSON.stringify({ primary: pendingReviewDocument.selfEvolution?.primary, blocking: pendingReviewDocument.selfEvolution?.hasBlockingStableIssue })}`);
  // The list is filtered to the upgraded record; only a repair action for that
  // record would mean the upgrade became a source change (experience actions
  // have no recordId and are covered by the revalidate-primary assertion).
  assertCross(!pendingReviewActions.some((row) => row.action === 'repair-stable'), `the host upgrade was turned into a source change: ${JSON.stringify(pendingReviewActions)}`);
  assertCross(pendingReviewReceipt.index.digest === simulatedIndexDigest && pendingReviewReceipt.index.digestAfter === simulatedIndexDigest, 'the review read or wrote an index other than the simulated upgrade index');
  assertCross(fileSha256(publishedPath) === report.index.digest, 'restoring the publication index failed');
  const restoredIndex = await bootWebConsumer('consumer-index-restored', { expect: expectedActive, markers: activeMarkers });
  if (restoredIndex.error) throw new Error(`cross-entry index-restore probe failed: ${restoredIndex.error}`);
  assertCross(restoredIndex.result.markerHits?.[stable.id] === 1, 'the restored index did not mount the record again');
  report.consumer.revalidation = revalidationResult;
  report.consumer.indexRestored = restoredIndex.result;

  const afterPreserved = {
    promotedSources: {
      stable: fileSha256(stableSource),
      incompatible: fileSha256(incompatibleSource),
      desktopOnly: fileSha256(path.join(promotedRoot, desktopOnly.pluginName, 'lib', 'index.js')),
    },
    sharedExperience: fileSha256(sharedExperienceDb),
    memory: fileSha256(memoryPath),
  };
  assertCross(afterPreserved.promotedSources.stable === preserved.promotedSources.stable.sha256
    && afterPreserved.promotedSources.incompatible === preserved.promotedSources.incompatible.sha256
    && afterPreserved.promotedSources.desktopOnly === preserved.promotedSources.desktopOnly.sha256,
  'a consumer boot changed the promoted plugin sources');
  assertCross(afterPreserved.sharedExperience === preserved.sharedExperience.sha256, 'a consumer boot changed the shared-experience SQLite database');
  assertCross(afterPreserved.memory === preserved.memory.sha256, 'a consumer boot changed the Evolution memory');
  report.preserved = { ...preserved, after: afterPreserved };

  // (h) real headless ACP consumer: install the same bundle into the acp
  //     profile of the same isolated home and boot it with the kernel disabled.
  const acpAdded = await runCliProfile('acp', ['add', tarball]);
  record('cross-entry-acp-install', { ok: acpAdded.code === 0, code: acpAdded.code, tail: acpAdded.output.trim().split('\n').slice(-3) });
  assertCross(acpAdded.code === 0, `dsh plugin --profile acp add failed: ${acpAdded.output.slice(-800)}`);
  const acp = await bootAcpConsumer('acp-consumer', { expect: expectedActive, markers: activeMarkers });
  const acpResult = acp.result;
  record('cross-entry-acp-consumer', {
    ok: !acp.error && Boolean(acpResult),
    profile: acpResult?.profile,
    kernelPresent: acpResult?.kernelPresent,
    evolutionTools: acpResult?.evolutionTools,
    observedIndexUpdatedAt: acpResult?.observedIndexUpdatedAt,
    indexUpdatedAt,
    rows: acpResult?.rows,
    markerHits: acpResult?.markerHits,
    services: acpResult?.services,
    error: acp.error,
  });
  if (acp.error) throw new Error(`cross-entry ACP consumer probe failed: ${acp.error}`);
  assertCross(acpResult.profile === 'acp', `the ACP consumer reported profile ${acpResult.profile}`);
  assertCross(acpResult.kernelPresent === false && acpResult.evolutionTools === 0, 'the ACP consumer boot still runs the Evolution kernel');
  assertCross(acpResult.observedIndexUpdatedAt === indexUpdatedAt, `the ACP consumer observed index ${acpResult.observedIndexUpdatedAt}, expected ${indexUpdatedAt}`);
  assertCross(acpResult.markerHits?.[stable.id] === 1, `the ACP consumer executed the promoted listener ${acpResult.markerHits?.[stable.id]} times, expected exactly once`);
  report.acp = {
    installedProfile: 'acp',
    consumerStatePath: path.join('$DSH_HOME', 'storages', 'evolution', 'shared-plugins', 'consumers', 'acp.json'),
    consumerStatePresent: fs.existsSync(consumerStatePath('acp')),
    result: acpResult,
  };

  // (i) the unified self-evolution review on the healthy, fully consumed record.
  //     The isolated host has no Desktop binary, so this boot runs the real Web
  //     kernel with only the promoted-consumer row disabled: the activation
  //     records the review reads are the durable facts the real consumer boots
  //     above wrote. The stable record must be active with no action, and the
  //     deliberately incompatible record must be surfaced for repair.
  log('cross-entry: running the unified self-evolution review on the healthy record');
  const activeReview = await bootWebReview('review-active', 'review-active');
  if (activeReview.error) throw new Error(`cross-entry active review probe failed: ${activeReview.error}`);
  const activeReviewReceipt = activeReview.result;
  const activeReviewDocument = activeReviewReceipt?.review ?? {};
  const activeReviewStable = (activeReviewDocument.stablePlugins?.records ?? []).find((row) => row.id === stable.id);
  const activeReviewActions = (activeReviewDocument.selfEvolution?.nextActions ?? []).filter((row) => row.recordId === stable.id);
  record('cross-entry-review-active', { ok: Boolean(activeReviewReceipt), summary: reviewSummary(activeReviewReceipt), error: activeReview.error });
  assertCross(activeReviewReceipt?.steps?.[0]?.name === 'evolution_plan' && activeReviewReceipt.steps[0].ok === true, 'the review receipt does not prove the evolution_plan tool ran');
  assertCross(activeReviewDocument.stablePlugins?.readOnly === true && activeReviewDocument.selfEvolution?.readOnly === true, 'the healthy review does not declare itself read-only');
  assertCross(activeReviewStable?.status === 'active', `the review did not report the healthy stable record as active: ${JSON.stringify(activeReviewStable)}`);
  assertCross(activeReviewStable?.action === null && activeReviewActions.length === 0, `the review advised an action for the healthy stable record: ${JSON.stringify(activeReviewActions)}`);
  assertCross((activeReviewDocument.stablePlugins?.records ?? []).some((row) => row.id === incompatible.id && row.status === 'incompatible' && row.action === 'repair-stable'), 'the review did not report the deliberately incompatible record for repair');
  assertCross(activeReviewReceipt.index.digest === activeReviewReceipt.index.digestAfter && activeReviewReceipt.index.digest === report.index.digest, 'the healthy review changed the publication index');

  // (j) recover from pending-revalidation exactly as an operator would: put the
  //     simulated upgrade back on disk (the record is still pending-revalidation
  //     in every consumer), adopt the real evidence on the isolated home through
  //     the operator command, and keep the adopted index. If adoption fails the
  //     original index is restored so the home is not left describing a host
  //     that never verified the record; restoring after success would delete the
  //     adopted revalidation generation, so the adopted bytes stay.
  log('cross-entry: adopting the revalidation evidence on the isolated home from the pending state');
  const webConsumerState = readJsonFile(consumerStatePath('web'));
  const acpConsumerState = readJsonFile(consumerStatePath('acp'));
  const consumerRowActive = (state) => (state?.plugins ?? []).some((row) => row?.id === stable.id && row.status === 'active');
  assertCross(consumerRowActive(webConsumerState) && consumerRowActive(acpConsumerState), 'both consumer entries must be active before revalidation evidence is adopted');
  assertCross(typeof stable.host?.dsh === 'string' && typeof stable.host?.cordis === 'string' && typeof stable.host?.include === 'string', `the published record has no complete host identity: ${JSON.stringify(stable.host)}`);
  const reviewEvidencePath = path.join(work, 'cross-entry-review-revalidate-evidence.json');
  fs.writeFileSync(reviewEvidencePath, `${JSON.stringify({
    schemaVersion: 1,
    kind: 'dsh-evolution-cross-entry-evidence',
    ok: true,
    host: { dsh: stable.host.dsh, cordis: stable.host.cordis, include: stable.host.include, node: stable.host.node ?? null },
    plugins: [{ id: stable.id, sourceSha256: stable.sourceSha256, profiles: { web: { active: true }, acp: { active: true } } }],
  }, null, 2)}\n`);
  fs.writeFileSync(publishedPath, simulatedIndexBytes);
  let adopted;
  try {
    adopted = await runCommand(process.execPath, [sharedCli, 'revalidate', '--home', home, '--evidence', reviewEvidencePath, '--json'], { env: { DSH_HOME: home } });
  } catch (error) {
    fs.writeFileSync(publishedPath, indexBytes);
    throw error;
  }
  if (adopted.code !== 0) fs.writeFileSync(publishedPath, indexBytes);
  record('cross-entry-revalidate-adopt', { ok: adopted.code === 0, code: adopted.code, adoptedFrom: 'pending-revalidation', tail: adopted.output.trim().slice(-800) });
  assertCross(adopted.code === 0, `revalidate adoption failed: ${adopted.output.slice(-800)}`);
  const adoptedIndex = readJsonFile(publishedPath);
  const adoptedRecord = adoptedIndex?.plugins?.find((row) => row.id === stable.id);
  assertCross(Array.isArray(adoptedRecord?.revalidation) && adoptedRecord.revalidation.length >= 1, 'the adopted evidence did not add a revalidation generation');
  assertCross(adoptedRecord.host?.dsh === stable.host.dsh, `the adopted record host ${adoptedRecord.host?.dsh} is not the published host ${stable.host.dsh}`);
  assertCross(adoptedIndex.updatedAt !== indexUpdatedAt, 'adoption did not advance the publication index');
  const adoptedConsumer = await bootWebConsumer('consumer-adopted', { expect: expectedActive, markers: activeMarkers });
  if (adoptedConsumer.error) throw new Error(`cross-entry adopted-index consumer probe failed: ${adoptedConsumer.error}`);
  const adoptedConsumerResult = adoptedConsumer.result;
  assertCross(adoptedConsumerResult.observedIndexUpdatedAt === adoptedIndex.updatedAt, `the adopted-index consumer observed index ${adoptedConsumerResult.observedIndexUpdatedAt}, expected ${adoptedIndex.updatedAt}`);
  assertCross(adoptedConsumerResult.markerHits?.[stable.id] === 1, `the revalidated record did not mount in the consumer: ${JSON.stringify(adoptedConsumerResult.markerHits)}`);

  // (k) review after adoption: the record must no longer be pending-revalidation
  //     and the review must not advise revalidation. The ACP activation record is
  //     stale against the advanced index (this stage boots the Web consumer
  //     only), so the remaining action is a restart, never a source change.
  log('cross-entry: running the unified self-evolution review after revalidation adoption');
  const revalidatedReview = await bootWebReview('review-revalidated', 'review-revalidated');
  if (revalidatedReview.error) throw new Error(`cross-entry revalidated review probe failed: ${revalidatedReview.error}`);
  const revalidatedReviewReceipt = revalidatedReview.result;
  const revalidatedReviewDocument = revalidatedReviewReceipt?.review ?? {};
  const revalidatedReviewStable = (revalidatedReviewDocument.stablePlugins?.records ?? []).find((row) => row.id === stable.id);
  const revalidatedReviewActions = (revalidatedReviewDocument.selfEvolution?.nextActions ?? []).filter((row) => row.recordId === stable.id);
  record('cross-entry-review-revalidated', { ok: Boolean(revalidatedReviewReceipt), summary: reviewSummary(revalidatedReviewReceipt), error: revalidatedReview.error });
  assertCross(revalidatedReviewDocument.stablePlugins?.readOnly === true && revalidatedReviewDocument.selfEvolution?.readOnly === true, 'the post-revalidation review does not declare itself read-only');
  // The stable record is compatible again and no longer needs revalidation; the ACP activation row is stale against the adopted index because only the Web consumer was booted, so the one remaining action is a restart, never a source change.
  assertCross(revalidatedReviewStable?.status === 'restart-required' && revalidatedReviewStable?.action === 'restart-consumer', `the post-revalidation review did not report the stale ACP consumer as a restart: ${JSON.stringify(revalidatedReviewStable)}`);
  assertCross(revalidatedReviewStable?.hostCompatible === true, `the adopted record is still not host-compatible: ${JSON.stringify(revalidatedReviewStable?.hostReason)}`);
  assertCross(revalidatedReviewStable?.action !== 'revalidate' && !revalidatedReviewActions.some((row) => row.action === 'revalidate'), `the review still advises revalidation after adoption: ${JSON.stringify(revalidatedReviewActions)}`);
  assertCross(Number.isInteger(revalidatedReviewStable?.revalidationGenerations) && revalidatedReviewStable.revalidationGenerations >= 1, 'the review does not report the adopted revalidation generation');
  assertCross(revalidatedReviewReceipt.index.digest === revalidatedReviewReceipt.index.digestAfter && revalidatedReviewReceipt.index.digest === fileSha256(publishedPath), 'the post-revalidation review changed the publication index');

  report.review = {
    active: reviewSummary(activeReviewReceipt),
    pendingRevalidation: reviewSummary(pendingReviewReceipt),
    revalidated: reviewSummary(revalidatedReviewReceipt),
    revalidateAdoption: {
      code: adopted.code,
      adoptedFrom: 'pending-revalidation',
      revalidationGenerations: adoptedRecord.revalidation.length,
      adoptedIndexDigest: fileSha256(publishedPath),
      consumerObservedIndexUpdatedAt: adoptedConsumerResult.observedIndexUpdatedAt,
    },
  };
  log(`cross-entry: stable record ${stable.id}, ACP/Web consumers active, incompatible ${incompatible.id} skipped, unified review active -> pending-revalidation -> revalidated`);
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
    // Merge, never replace: the doctor's HOST_MODULES list has no
    // `@deepseek-ai/cordis-plugin-loader`, which this bundle reads as a
    // transitive dependency of the official Include adapter, so overwriting here
    // would silently drop it from the evidence. The doctor stays authoritative
    // for every module it does report; modules it does not report keep the
    // version read straight from the installed runtime above.
    evidence.hostModules = {
      ...evidence.hostModules,
      ...Object.fromEntries(moduleCheck.evidence.modules.map((module) => [module.name, module.version])),
    };
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
    && firstCore.result.toolCount === EXPECTED_TOOL_COUNT
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
    if (options.noHmr && action !== 'verify') {
      // The probe already derives the live tree from the capability; here the
      // capability is absent for the whole run, so the report is not ambiguous.
      const result = outcome.result;
      if (result.application !== 'restart-required' || result.restartReason !== 'no-hmr') {
        throw new Error(`lifecycle ${action} reported application=${result.application} restartReason=${result.restartReason}, expected restart-required/no-hmr`);
      }
      if (result.liveApplyBefore || result.liveApplyAfter) {
        throw new Error(`lifecycle ${action} observed the HMR capability although the run disabled it`);
      }
    }
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
    && secondCore.result.toolCount === EXPECTED_TOOL_COUNT
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
  const upgradeVersion = upgradeVersionFor(manifest.version);
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
    ok: Boolean(upgradedLifecycle.result) && upgradedLifecycle.result.toolCount === EXPECTED_TOOL_COUNT && upgradedLifecycle.result.memoryUnchanged === true,
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
    ok: Boolean(rolledBackLifecycle.result) && rolledBackLifecycle.result.toolCount === EXPECTED_TOOL_COUNT && rolledBackLifecycle.result.memoryUnchanged === true,
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

  // 9. experience-driven evolution through the real host: seed real tool
  //    failures, let evolution_plan discover the problem, run the paired
  //    baseline/candidate probes, then prove refusal, promotion and recall
  //    across a restart. Every phase is its own process; the state file in the
  //    scratch directory carries the experiment identity between them.
  if (options.experienceEvolution) {
    const probeFile = path.join(PROBES, 'experience-evolution-probe.mjs');
    const stateFile = path.join(work, 'experience-evolution-state.json');
    for (const phase of EXPERIENCE_EVOLUTION_PHASES) {
      const outcome = await bootProbe(`experience-evolution-${phase}`, probeFile, {
        EVOLUTION_EXPERIENCE_PHASE: phase,
        EVOLUTION_PROBE_STATE: stateFile,
        EVOLUTION_ACCEPTANCE_CWD: work,
      });
      const result = outcome.result;
      const crossCheck = crossCheckExperiencePhase(phase, result);
      const phaseOk = !outcome.error && Boolean(result) && result.ok !== false
        && result.phase === phase && crossCheck.ok;
      record(`experiment-${phase}`, {
        ok: phaseOk,
        phase,
        experimentId: result?.experimentId,
        toolCount: result?.toolCount,
        crossCheck,
        error: outcome.error,
      });
      if (outcome.error) throw new Error(`experience-evolution ${phase} failed: ${outcome.error}`);
      if (!result || result.ok === false || result.phase !== phase) {
        throw new Error(`experience-evolution ${phase} did not report a successful ${phase} phase`);
      }
      if (!crossCheck.ok) {
        throw new Error(`experience-evolution ${phase} evidence did not cross-check: ${JSON.stringify(crossCheck)}`);
      }
      evidence.experienceEvolution[phase] = selectExperienceEvidence(phase, result);
    }
  }

  // 10. cross-entry promotion and consumption: a Desktop-verified stable plugin
  //     is published with explicit ACP/Web approval from the full-kernel Web
  //     entry, then mounted by the consumer-only Web and headless ACP entries,
  //     with every incompatibility, fault-isolation, revocation and
  //     revalidation case exercised through the real host.
  if (options.crossEntry) await runCrossEntryAcceptance();

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
