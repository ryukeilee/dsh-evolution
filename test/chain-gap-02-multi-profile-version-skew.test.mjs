// Chain-gap-02: multi-profile installed-version skew must be visible in the
// doctor report and reported by the setup installer after --apply.
//
// Every fixture is a synthetic DSH home under os.tmpdir(); nothing here reads a
// real profile, the real DSH_HOME, or any user data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { collectDiagnostics } from '../lib/diagnostics.js';
import { resolveEvolutionPaths } from '../lib/evolution-paths.js';
import { installedVersionSummary } from '../scripts/setup-experience.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(here);
const scratchRoots = [];
const SKEW_ID = 'host.profile-version-consistency';

function scratch(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `evo-chain-gap-02-${name}-`));
  scratchRoots.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of scratchRoots) fs.rmSync(dir, { recursive: true, force: true });
});

/** Install one profile's manifest, optionally leaving it absent or invalid. */
function writeProfile(home, profile, { version = null, manifest = true, installed = true, invalidInstalled = false } = {}) {
  const dir = path.join(home, 'profiles', profile);
  fs.mkdirSync(dir, { recursive: true });
  if (manifest) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: `dsh-profile-${profile}`, dsh: { profile: { bundles: ['dsh-evolution'] } },
    }));
  } else {
    fs.writeFileSync(path.join(dir, 'package.json'), '{ not json');
  }
  if (installed) {
    const bundleDir = path.join(dir, 'node_modules', 'dsh-evolution');
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'package.json'), invalidInstalled
      ? '{ broken'
      : JSON.stringify({ name: 'dsh-evolution', version }));
  }
  return dir;
}

/** A DSH home with an initialized data root so doctor can resolve its paths. */
function makeHome(name, profiles) {
  const home = scratch(name);
  const paths = resolveEvolutionPaths({ dshHome: home });
  fs.mkdirSync(paths.dataRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.keyPath, 'a'.repeat(64), { mode: 0o600 });
  for (const [profile, options] of Object.entries(profiles)) writeProfile(home, profile, options);
  return home;
}

const diagnose = (home, extra = {}) => collectDiagnostics({
  home: true, dshHome: home, profile: 'acp', probe: { skipComposition: true }, ...extra,
});

// ---------------------------------------------------------------------------
// doctor: cross-profile consistency check
// ---------------------------------------------------------------------------

test('doctor reports every installed profile version and degrades on skew', async () => {
  const home = makeHome('skew', {
    desktop: { version: '0.2.23' },
    acp: { version: '0.2.23' },
    web: { version: '0.2.22' },
  });
  const report = await diagnose(home);
  const check = report.checks.find((entry) => entry.id === SKEW_ID);
  assert.ok(check, 'the cross-profile check exists even when only acp is diagnosed');
  assert.equal(check.level, 'degraded');
  assert.equal(check.evidence.skewed, true);
  assert.deepEqual(check.evidence.installedVersions, [
    { profile: 'acp', installedVersion: '0.2.23' },
    { profile: 'desktop', installedVersion: '0.2.23' },
    { profile: 'web', installedVersion: '0.2.22' },
  ]);
  assert.deepEqual(check.evidence.distinctVersions, ['0.2.22', '0.2.23']);
  assert.equal(check.evidence.referenceVersion, '0.2.23');
  assert.deepEqual(check.evidence.remediationByProfile.map((row) => row.profile), ['web']);
  assert.match(check.remediation, /web: `dsh plugin --profile web add dsh-evolution-0\.2\.23\.tgz`/);
  assert.equal(JSON.stringify(report).includes('0.2.22'), true, 'the whole report now carries the lagging version');
  // The single-profile verdict is unchanged and still healthy for acp.
  assert.equal(report.checks.find((entry) => entry.id === 'host.install').level, 'ok');
});

test('doctor does not add a degraded check when all profiles agree', async () => {
  const home = makeHome('consistent', {
    desktop: { version: '0.2.23' },
    acp: { version: '0.2.23' },
    web: { version: '0.2.23' },
  });
  const report = await diagnose(home);
  const check = report.checks.find((entry) => entry.id === SKEW_ID);
  assert.equal(check.level, 'ok');
  assert.equal(check.evidence.skewed, false);
  assert.equal(check.evidence.referenceVersion, '0.2.23');
  assert.equal(report.checks.filter((entry) => entry.level === 'degraded' && entry.id === SKEW_ID).length, 0);
});

test('a profile without dsh-evolution installed is listed but excluded from skew', async () => {
  const home = makeHome('not-installed', {
    desktop: { version: '0.2.23' },
    acp: { version: '0.2.23' },
    web: { installed: false },
  });
  const report = await diagnose(home);
  const check = report.checks.find((entry) => entry.id === SKEW_ID);
  assert.equal(check.level, 'ok');
  assert.equal(check.evidence.web ?? undefined, undefined);
  assert.deepEqual(check.evidence.profiles.find((row) => row.profile === 'web'), {
    profile: 'web', installedVersion: null, state: 'not-installed',
  });
  assert.equal(check.evidence.installedVersions.length, 2);
  assert.equal(check.evidence.distinctVersions.length, 1);
});

test('unreadable profile or installed manifests are reported as unknown, never fatal', async () => {
  const home = makeHome('unreadable', {
    desktop: { version: '0.2.23' },
    acp: { version: '0.2.23' },
    web: { version: null, invalidInstalled: true },
    broken: { manifest: false },
  });
  const report = await diagnose(home);
  const check = report.checks.find((entry) => entry.id === SKEW_ID);
  assert.ok(check, 'the check survives unreadable manifests');
  assert.equal(check.level, 'ok', 'unknown profiles do not create skew');
  assert.deepEqual(check.evidence.profiles.find((row) => row.profile === 'web'), {
    profile: 'web', installedVersion: null, state: 'unknown', reason: 'installed-manifest-unreadable',
  });
  assert.deepEqual(check.evidence.profiles.find((row) => row.profile === 'broken'), {
    profile: 'broken', installedVersion: null, state: 'unknown', reason: 'profile-manifest-unreadable',
  });
  assert.equal(check.evidence.installedVersions.length, 2);
});

test('the doctor CLI JSON makes the lagging profile visible from a single-profile run', () => {
  const home = makeHome('cli', {
    desktop: { version: '0.2.23' },
    acp: { version: '0.2.23' },
    web: { version: '0.2.22' },
  });
  const result = spawnSync(process.execPath, ['--max-old-space-size=4096',
    path.join(repoRoot, 'scripts', 'doctor.mjs'),
    '--home', home, '--profile', 'acp', '--no-composition', '--json'], { encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, `doctor exit ${result.status}: ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  const check = report.checks.find((entry) => entry.id === SKEW_ID);
  assert.equal(check.level, 'degraded');
  assert.match(check.summary, /web=0\.2\.22/);
  assert.match(result.stdout, /"installedVersion": "0\.2\.22"/);
});

// ---------------------------------------------------------------------------
// setup-experience: readback summary after --apply
// ---------------------------------------------------------------------------

test('installedVersionSummary detects skew and names lagging profiles', () => {
  const home = scratch('summary');
  for (const [profile, version] of Object.entries({ desktop: '0.2.23', acp: '0.2.23', web: '0.2.22' })) {
    writeProfile(home, profile, { version });
  }
  const summary = installedVersionSummary(home, ['desktop', 'acp', 'web']);
  assert.equal(summary.skewed, true);
  assert.equal(summary.referenceVersion, '0.2.23');
  assert.deepEqual(summary.unfinished.map((row) => row.profile), ['web']);
  assert.deepEqual(summary.profiles.map((row) => row.installedVersion), ['0.2.23', '0.2.23', '0.2.22']);
});

test('installedVersionSummary treats unreadable profiles as unknown and consistent installs as clean', () => {
  const home = scratch('summary-clean');
  writeProfile(home, 'desktop', { version: '0.2.23' });
  writeProfile(home, 'acp', { version: '0.2.23' });
  writeProfile(home, 'web', { version: null, invalidInstalled: true });
  const clean = installedVersionSummary(home, ['desktop', 'acp']);
  assert.equal(clean.skewed, false);
  assert.deepEqual(clean.unfinished, []);
  const withUnknown = installedVersionSummary(home, ['desktop', 'acp', 'web']);
  assert.equal(withUnknown.skewed, false);
  assert.equal(withUnknown.profiles.find((row) => row.profile === 'web').installedVersion, null);
  assert.ok(withUnknown.profiles.find((row) => row.profile === 'web').error);
});

/** A stand-in official CLI that installs a chosen version per profile. */
function fakeCli(root) {
  const script = path.join(root, 'fake-cli.mjs');
  fs.writeFileSync(script, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const home = process.env.DSH_HOME;
const args = process.argv.slice(2);
const profile = args[args.indexOf('--profile') + 1];
if (process.env.FAIL_PROFILE === profile) process.exit(7);
const versions = JSON.parse(process.env.FAKE_VERSIONS || '{"desktop":"0.2.23","acp":"0.2.23","web":"0.2.23"}');
const dir = path.join(home, 'profiles', profile, 'node_modules', 'dsh-evolution');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-evolution', version: versions[profile] }));
`);
  const wrapper = path.join(root, 'fake-dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  fs.chmodSync(wrapper, 0o755);
  return wrapper;
}

function runSetup(root, { home, cli, versions, failProfile, apply }) {
  const tarball = path.join(root, 'candidate.tgz');
  if (!fs.existsSync(tarball)) fs.writeFileSync(tarball, 'test tarball');
  const args = ['--max-old-space-size=4096', path.join(repoRoot, 'scripts', 'setup-experience.mjs'),
    '--home', home, '--tarball', tarball, '--cli', cli];
  if (apply) args.push('--apply');
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home, FAKE_VERSIONS: JSON.stringify(versions), ...(failProfile ? { FAIL_PROFILE: failProfile } : {}) },
  });
}

test('setup --apply prints a per-profile readback and exits nonzero while skewed', () => {
  const root = scratch('setup-skew');
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const cli = fakeCli(root);
  const result = runSetup(root, { home, cli, versions: { desktop: '0.2.23', acp: '0.2.23', web: '0.2.22' }, apply: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, `exit ${result.status}: ${result.stdout}\n${result.stderr}`);
  const json = JSON.parse(result.stdout.slice(result.stdout.indexOf('{\n  "installSummary"')));
  assert.equal(json.installSummary.skewed, true);
  assert.deepEqual(json.installSummary.unfinished.map((row) => row.profile), ['web']);
  assert.match(result.stderr, /unfinished profiles: web=0\.2\.22/);
});

test('setup --apply exits zero when every profile agrees, and dry-run is unchanged', () => {
  const root = scratch('setup-clean');
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const cli = fakeCli(root);
  const applied = runSetup(root, { home, cli, versions: { desktop: '0.2.23', acp: '0.2.23', web: '0.2.23' }, apply: true });
  assert.equal(applied.status, 0, `exit ${applied.status}: ${applied.stdout}\n${applied.stderr}`);
  assert.match(applied.stdout, /"skewed": false/);
  assert.equal(applied.stderr, '');

  const dryHome = path.join(root, 'dry-home');
  fs.mkdirSync(dryHome, { recursive: true });
  const dry = runSetup(root, { home: dryHome, cli, versions: { desktop: '0.2.23', acp: '0.2.23', web: '0.2.23' }, apply: false });
  assert.equal(dry.status, 0);
  assert.equal(dry.stdout.includes('installSummary'), false, 'dry-run still only prints the plan');
  assert.deepEqual(JSON.parse(dry.stdout).apply, false);
});

test('setup --apply reports unfinished profiles after a partial install', () => {
  const root = scratch('setup-partial');
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const cli = fakeCli(root);
  const result = runSetup(root, { home, cli, versions: { desktop: '0.2.23', acp: '0.2.23', web: '0.2.23' }, failProfile: 'acp', apply: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Installation stopped at acp/);
  const json = JSON.parse(result.stdout.slice(result.stdout.indexOf('{\n  "installSummary"')));
  assert.deepEqual(json.installSummary.unfinished.map((row) => row.profile), ['acp', 'web']);
});
