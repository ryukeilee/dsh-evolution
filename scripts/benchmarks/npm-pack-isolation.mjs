#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createPrivateNpmEnv } from '../acceptance/npm-cache-env.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RESULT_PATH = path.join(REPO_ROOT, 'docs/performance/npm-pack-isolation.json');
const NODE22 = '/opt/homebrew/opt/node@22/bin/node';
const NODE22_BIN = path.dirname(NODE22);
const NODE_HEAP = '--max-old-space-size=4096';
const TEST_FILES = [
  'test/release-archive-header-integrity.test.mjs',
  'test/release-build-boundary-regressions.test.mjs',
  'test/release-build-boundary-round6.test.mjs',
  'test/release-build-boundary-round7.test.mjs',
  'test/release-integrity-pack-dist-ownership.test.mjs',
];

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function parseArgs(argv) {
  const result = { full: false, write: false, packages: 12, rounds: 3 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--full') result.full = true;
    else if (arg === '--write') result.write = true;
    else if (arg === '--packages' || arg === '--rounds') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < (arg === '--packages' ? 1 : 3)) {
        throw new Error(`${arg} must be an integer >= ${arg === '--packages' ? 1 : 3}`);
      }
      result[arg.slice(2)] = value;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return result;
}

function isolatedBaseEnv(root, label) {
  const home = path.join(root, 'homes', label);
  const config = path.join(root, 'npm-config', label);
  const temp = path.join(root, 'tmp');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(temp, { recursive: true });
  const userConfig = path.join(config, 'user.npmrc');
  const globalConfig = path.join(config, 'global.npmrc');
  fs.writeFileSync(userConfig, '');
  fs.writeFileSync(globalConfig, '');

  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => (
    !/^npm_config_/i.test(key)
      && !['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TMPDIR', 'TMP', 'TEMP', 'NODE_OPTIONS'].includes(key.toUpperCase())
  )));
  return {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    PATH: `${NODE22_BIN}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
    NODE_OPTIONS: NODE_HEAP,
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_progress: 'false',
  };
}

function snapshotPath(root) {
  let files = 0;
  let bytes = 0;
  let directories = 0;
  if (!fs.existsSync(root)) return { files, bytes, directories, exists: false };

  const visit = (current) => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        directories += 1;
        visit(target);
      } else if (entry.isFile()) {
        files += 1;
        bytes += fs.statSync(target).size;
      }
    }
  };
  visit(root);
  return { files, bytes, directories, exists: true };
}

function snapshotLocations(locations) {
  const perLocation = locations.map(({ label, path: locationPath }) => ({
    label,
    ...snapshotPath(locationPath),
  }));
  return perLocation.reduce((sum, item) => ({
    files: sum.files + item.files,
    bytes: sum.bytes + item.bytes,
    directories: sum.directories + item.directories,
  }), { files: 0, bytes: 0, directories: 0 });
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const maxCapture = 1024 * 1024;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { if (stdout.length < maxCapture) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < maxCapture) stderr += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 120_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      resolve({ exitCode: null, signal: null, error: error.code ?? error.name, stdout, stderr });
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({ exitCode, signal, error: null, stdout, stderr });
    });
  });
}

function makeFixtures(root, count) {
  return Array.from({ length: count }, (_, index) => {
    const id = String(index + 1).padStart(2, '0');
    const fixtureRoot = path.join(root, `fixture-${id}`);
    fs.mkdirSync(fixtureRoot, { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'package.json'), `${JSON.stringify({
      name: `npm-pack-isolation-probe-${id}`,
      version: '1.0.0',
      description: 'Temporary npm pack isolation probe',
      files: ['index.js'],
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(fixtureRoot, 'index.js'), `export const fixture = ${index + 1};\n`);
    return { id, root: fixtureRoot };
  });
}

async function packFixture(fixture, destination, env) {
  fs.mkdirSync(destination, { recursive: true });
  const result = await runProcess('npm', [
    'pack', '--json', '--pack-destination', destination, '--ignore-scripts',
  ], { cwd: fixture.root, env });
  let filename = null;
  if (result.exitCode === 0) {
    try {
      const parsed = JSON.parse(result.stdout);
      filename = Array.isArray(parsed) ? parsed[0]?.filename ?? null : parsed?.filename ?? null;
    } catch {
      result.error = 'invalid-npm-json-output';
    }
  }
  return {
    id: fixture.id,
    success: result.exitCode === 0 && filename !== null,
    exitCode: result.exitCode,
    error: result.error,
    filename,
  };
}

function npmStateLocations(armRoot, fixtures, arm) {
  if (arm === 'shared-cache') {
    return [
      { label: 'shared/cache', path: path.join(armRoot, 'shared', 'cache') },
      { label: 'shared/logs', path: path.join(armRoot, 'shared', 'logs') },
    ];
  }
  return fixtures.map((fixture) => ({
    label: `${fixture.id}/.npm-private`,
    path: path.join(fixture.root, '.npm-private'),
  }));
}

async function runArm({ root, fixtures, round, arm }) {
  const armRoot = path.join(root, arm);
  const locations = npmStateLocations(armRoot, fixtures, arm);
  if (arm === 'shared-cache') {
    for (const location of locations) fs.mkdirSync(location.path, { recursive: true });
  }

  const before = snapshotLocations(locations);
  const startedAt = performance.now();
  const results = await Promise.all(fixtures.map(async (fixture, index) => {
    const output = path.join(armRoot, 'output', `round-${round}`, fixture.id);
    const baseEnv = isolatedBaseEnv(root, `${arm}-r${round}-${fixture.id}`);
    let env;
    let destinations;
    if (arm === 'shared-cache') {
      destinations = {
        cache: path.join(armRoot, 'shared', 'cache'),
        logs: path.join(armRoot, 'shared', 'logs'),
      };
      env = {
        ...baseEnv,
        npm_config_cache: destinations.cache,
        npm_config_logs_dir: destinations.logs,
      };
    } else {
      env = createPrivateNpmEnv(fixture.root, baseEnv);
      destinations = {
        cache: env.npm_config_cache,
        logs: env.npm_config_logs_dir,
      };
    }
    const withinPrivateFixture = isWithin(path.join(fixture.root, '.npm-private'), destinations.cache)
      && isWithin(path.join(fixture.root, '.npm-private'), destinations.logs);
    return {
      ...(await packFixture(fixture, output, env)),
      stateLocations: arm === 'shared-cache'
        ? { cache: 'shared/cache', logs: 'shared/logs' }
        : { cache: `${fixture.id}/.npm-private/*/cache`, logs: `${fixture.id}/.npm-private/*/logs` },
      privateStateWithinFixture: arm === 'private-per-process' ? withinPrivateFixture : null,
      homeRedirected: env.HOME !== os.homedir(),
      index,
    };
  }));
  const durationMs = Math.round(performance.now() - startedAt);
  const after = snapshotLocations(locations);
  return {
    arm,
    durationMs,
    success: results.filter((item) => item.success).length,
    failure: results.filter((item) => !item.success).length,
    state: { before, after },
    writesObserved: after.files > before.files || after.bytes > before.bytes,
    allPrivateStateWithinFixture: arm === 'private-per-process'
      ? results.every((item) => item.privateStateWithinFixture)
      : null,
    allHomesRedirected: results.every((item) => item.homeRedirected),
    results: results.map(({ index, ...item }) => item),
  };
}

async function runAb({ root, packages, rounds }) {
  const abRoot = path.join(root, 'ab');
  const baselineFixtures = makeFixtures(path.join(abRoot, 'shared-cache', 'fixtures'), packages);
  const privateFixtures = makeFixtures(path.join(abRoot, 'private-per-process', 'fixtures'), packages);
  const roundsResult = [];
  for (let round = 1; round <= rounds; round += 1) {
    const arms = round % 2 === 1
      ? ['shared-cache', 'private-per-process']
      : ['private-per-process', 'shared-cache'];
    const byArm = {};
    for (const arm of arms) {
      byArm[arm] = await runArm({
        root: path.join(abRoot, arm),
        fixtures: arm === 'shared-cache' ? baselineFixtures : privateFixtures,
        round,
        arm,
      });
    }
    roundsResult.push({ round, ...byArm });
  }
  return {
    packages,
    rounds: roundsResult,
    contaminationEvidence: {
      sharedCacheWritesObserved: roundsResult.some((round) => round['shared-cache'].writesObserved),
      privateFixtureWritesObserved: roundsResult.some((round) => round['private-per-process'].writesObserved),
      privateStateWithinFixture: roundsResult.every((round) => round['private-per-process'].allPrivateStateWithinFixture),
      childHomesRedirected: roundsResult.every((round) => (
        round['shared-cache'].allHomesRedirected && round['private-per-process'].allHomesRedirected
      )),
      locations: {
        baseline: '临时根/shared-cache/shared/{cache,logs}',
        candidate: '临时根/private-per-process/fixtures/fixture-*/.npm-private/<pid-uuid>/{cache,logs}',
      },
    },
  };
}

function makeOneFixture(root) {
  return makeFixtures(root, 1)[0];
}

function permissionErrorDetails(result) {
  const surface = `${result.stderr}\n${result.stdout}`;
  const value = (pattern) => surface.match(pattern)?.[1] ?? null;
  return {
    npmCode: value(/npm error code ([A-Z]+)/i),
    syscall: value(/npm error syscall ([^\s]+)/i),
    pathBasename: value(/npm error path .*[/\\]([^/\\\s]+)\s*$/im),
    exitCode: result.exitCode,
    spawnError: result.error,
  };
}

async function runReadonlyFailure(root) {
  const fixture = makeOneFixture(path.join(root, 'readonly', 'fixture'));
  const cache = path.join(root, 'readonly', 'shared', 'cache');
  const logs = path.join(root, 'readonly', 'shared', 'logs');
  const out = path.join(root, 'readonly', 'output');
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(logs, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  const safeEnv = isolatedBaseEnv(root, 'readonly-shared');
  const readonlyEnv = {
    ...safeEnv,
    npm_config_cache: cache,
    npm_config_logs_dir: logs,
  };
  let readonlyResult;
  try {
    fs.chmodSync(cache, 0o555);
    fs.chmodSync(logs, 0o555);
    readonlyResult = await runProcess('npm', [
      'pack', '--json', '--pack-destination', out, '--ignore-scripts',
    ], { cwd: fixture.root, env: readonlyEnv });
  } finally {
    fs.chmodSync(cache, 0o755);
    fs.chmodSync(logs, 0o755);
  }

  const privateEnv = createPrivateNpmEnv(fixture.root, isolatedBaseEnv(root, 'readonly-private'));
  const privateOutput = path.join(root, 'readonly', 'private-output');
  const privateResult = await packFixture(fixture, privateOutput, privateEnv);
  const details = permissionErrorDetails(readonlyResult);
  return {
    readonlyShared: {
      ...details,
      reproducedEaccesMkdir: details.npmCode === 'EACCES' && details.syscall === 'mkdir',
      cacheAndLogsModeDuringPack: '0555',
    },
    sameFixturePrivate: {
      success: privateResult.success,
      exitCode: privateResult.exitCode,
      stateWithinFixture: isWithin(path.join(fixture.root, '.npm-private'), privateEnv.npm_config_cache)
        && isWithin(path.join(fixture.root, '.npm-private'), privateEnv.npm_config_logs_dir),
    },
  };
}

async function runConcurrentTests(root, count = 3) {
  const runnerEnv = isolatedBaseEnv(root, 'test-runner-node22');
  const results = [];
  for (let iteration = 1; iteration <= count; iteration += 1) {
    const startedAt = performance.now();
    const run = await runProcess(NODE22, [NODE_HEAP, '--test', '--test-concurrency=5', ...TEST_FILES], {
      cwd: REPO_ROOT,
      env: runnerEnv,
      timeoutMs: 300_000,
    });
    results.push({
      iteration,
      durationMs: Math.round(performance.now() - startedAt),
      exitCode: run.exitCode,
      pass: Number(run.stdout.match(/^# pass (\d+)$/m)?.[1] ?? 0),
      fail: Number(run.stdout.match(/^# fail (\d+)$/m)?.[1] ?? 0),
      summaryFound: /^# pass \d+$/m.test(run.stdout) && /^# fail \d+$/m.test(run.stdout),
      spawnError: run.error,
    });
  }
  return { invocationCount: count, files: TEST_FILES, results };
}

async function npmVersion(root) {
  const fixture = path.join(root, 'version-probe');
  fs.mkdirSync(fixture, { recursive: true });
  const result = await runProcess('npm', ['--version'], {
    cwd: fixture,
    env: isolatedBaseEnv(root, 'npm-version'),
  });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(NODE22)) throw new Error(`Node 22 executable is unavailable at ${NODE22}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-pack-isolation-'));
  if (isWithin(os.homedir(), root)) {
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error('temporary experiment root must be outside the user home directory');
  }

  let output;
  try {
    const ab = await runAb({ root, packages: args.packages, rounds: args.rounds });
    output = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      environment: {
        node: process.version,
        nodeExecutable: process.execPath,
        npm: await npmVersion(root),
        npmExecutable: path.join(NODE22_BIN, 'npm'),
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
        machine: os.cpus()[0]?.model ?? null,
        logicalCpuCount: os.cpus().length,
        heapLimit: NODE_HEAP,
        experimentRootOutsideHome: true,
        childHomeAndNpmConfigRedirected: true,
        maxNpmConcurrencyPerArm: args.packages,
      },
      ab,
      full: args.full,
    };
    if (args.full) {
      output.readonlyFailure = await runReadonlyFailure(root);
      output.concurrentTests = await runConcurrentTests(root, 3);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  if (args.write) fs.writeFileSync(RESULT_PATH, serialized);
  process.stdout.write(serialized);
  const failures = output.ab.rounds.some((round) => (
    round['shared-cache'].failure > 0 || round['private-per-process'].failure > 0
  ));
  const fullFailure = args.full && (
    !output.readonlyFailure.readonlyShared.reproducedEaccesMkdir
      || !output.readonlyFailure.sameFixturePrivate.success
      || output.concurrentTests.results.some((result) => result.exitCode !== 0 || result.fail !== 0 || !result.summaryFound)
  );
  if (failures || fullFailure) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`npm pack isolation failed: ${error.message}\n`);
  process.exitCode = 1;
});
