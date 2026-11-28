// DSH-EVOLUTION-CHAIN-GAP-01 / P1: after the shared index is updated, doctor
// and the shared-plugins operator commands must name the consumer profiles that
// have not loaded it and give restart guidance. A profile that already observed
// the current index must stay on the normal path.
//
// Synthetic fixtures only (os.tmpdir()); no real DSH home is read or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectDiagnostics, resolveEvolutionPaths } from '../lib/diagnostics.js';
import { consumerStateDocument, publishSharedRecord, readSharedIndex, setDisabledForProfile, sharingPaths, writeConsumerState } from '../lib/promoted-sharing.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(testDir, '..', 'scripts', 'shared-plugins.mjs');
const repoRoot = path.dirname(testDir);
const HOST_CLI = path.join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const HEX = (value) => crypto.createHash('sha256').update(value).digest('hex');
const KEY = 'b'.repeat(64);
const SOURCE = 'export const name = "shared";\nexport const inject = ["tools"];\nexport function apply() {}\n';
const OLD = '2020-01-01T00:00:00.000Z';

function recordFor(suffix, host, modulePath, manifest, approvedProfiles) {
  const pluginName = `dsh-evolution-promoted-${suffix}`;
  return {
    id: `evolution-promoted-${suffix}`, schemaVersion: 1, experimentId: `exp-chain-gap-01-${suffix}`,
    pluginName, moduleUrl: pathToFileURL(modulePath).href, entry: 'lib/index.js',
    sourceSha256: HEX(SOURCE), manifestSha256: HEX(manifest),
    publisherProfile: 'desktop', approvedProfiles,
    stable: { committedAt: '2026-01-02T00:00:00.000Z', promotionTimestamp: '2026-01-01T00:00:00.000Z', decision: 'benefit', canary: { healthObservationWindow: 2, observations: 2, startupVerified: true } },
    requiredServices: ['tools'], serviceMembers: {}, requiredCapabilities: ['fiberLifecycle', 'fiberAwait', 'include', 'toolsRegistry'],
    hostOnly: true, host, revalidation: [], publishedAt: '2026-01-02T00:00:00.000Z',
  };
}

async function fixture(t, suffixes = ['aaaaaaaaaaaa'], approvedProfiles = ['acp', 'web']) {
  const dshHome = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-chain-gap-01-doctor-'));
  t.after(() => fs.rm(dshHome, { recursive: true, force: true }));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-chain-gap-01-cli-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const paths = resolveEvolutionPaths({ dshHome });
  const cliPaths = resolveEvolutionPaths({ dshHome: home });
  for (const p of [paths, cliPaths]) {
    await fs.mkdir(p.dataRoot, { recursive: true, mode: 0o700 });
    await fs.writeFile(p.keyPath, KEY, { mode: 0o600 });
  }
  const observed = await diagnose(dshHome);
  const hostEvidence = observed.checks.find((check) => check.id === 'host.version')?.evidence ?? {};
  const modulesCheck = observed.checks.find((check) => check.id === 'host.modules');
  const modules = modulesCheck?.evidence?.modules ?? [];
  const facts = modulesCheck?.evidence?.hostFacts ?? null;
  const moduleVersion = (name) => modules.find((module) => module.name === name)?.version ?? null;
  const host = {
    dsh: facts?.dsh ?? hostEvidence.found ?? null,
    cordis: facts?.cordis ?? moduleVersion('@deepseek-ai/cordis'),
    include: facts?.include ?? moduleVersion('@deepseek-ai/cordis-plugin-include'),
    node: process.version,
    verifiedAt: '2026-01-02T00:00:00.000Z',
  };
  const records = [];
  for (const [target, suffix] of [['doctor', suffixes[0]], ['cli', suffixes[0]], ['cli', suffixes[1] ?? 'bbbbbbbbbbbb']]) {
    if (!suffix) continue;
    const root = target === 'doctor' ? paths : cliPaths;
    const pluginDir = path.join(root.pluginRoot, `dsh-evolution-promoted-${suffix}`);
    await fs.mkdir(path.join(pluginDir, 'lib'), { recursive: true });
    const modulePath = path.join(pluginDir, 'lib', 'index.js');
    await fs.writeFile(modulePath, SOURCE);
    const manifest = `${JSON.stringify({ name: `dsh-evolution-promoted-${suffix}`, version: '0.1.0', type: 'module', main: 'lib/index.js' })}\n`;
    await fs.writeFile(path.join(pluginDir, 'package.json'), manifest);
    const record = recordFor(suffix, host, modulePath, manifest, approvedProfiles);
    await publishSharedRecord({ dataRoot: root.dataRoot, pluginRoot: root.pluginRoot }, record);
    records.push({ root, record });
  }
  const index = await readSharedIndex({ dataRoot: paths.dataRoot, pluginRoot: paths.pluginRoot });
  const cliIndex = await readSharedIndex({ dataRoot: cliPaths.dataRoot, pluginRoot: cliPaths.pluginRoot });
  return { dshHome, paths, cliPaths, host, records, index, cliIndex };
}

async function writeConsumers(root, host, pluginIds, observed) {
  for (const [profile, indexUpdatedAt] of Object.entries(observed)) {
    await writeConsumerState({ dataRoot: root.dataRoot }, profile, consumerStateDocument({
      profile, host, indexUpdatedAt, compositionPath: null,
      plugins: pluginIds.map((id) => ({ id, status: 'active', reason: null })),
    }));
  }
}

const checkOf = (report) => report.checks.find((check) => check.id === 'promotion.sharing');

function diagnose(dshHome) {
  // These fixtures test publication/restart state, not machine-local CLI
  // discovery. Pin the installed host so PATH cannot invalidate the records.
  return collectDiagnostics({ dshHome, home: true, cliPath: HOST_CLI, probe: { skipComposition: true } });
}

function runCli(args, dataRoot) {
  const result = spawnSync(process.execPath, [CLI, ...args, '--data-root', dataRoot, '--json'], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch { /* reported by assertions */ }
  return { code: result.status, json, stderr: result.stderr };
}

test('doctor names the stale profile in summary and remediation, while acp stays on the normal path', async (t) => {
  const env = await fixture(t);
  await writeConsumers(env.paths, env.host, [env.records[0].record.id], { acp: env.index.updatedAt, web: OLD });
  const check = checkOf(await diagnose(env.dshHome));
  assert.equal(check.level, 'degraded', JSON.stringify(check.evidence));
  assert.deepEqual(check.evidence.pendingRestart, ['web']);
  assert.match(check.summary, /web/);
  assert.match(check.remediation, /web/);
  assert.match(check.remediation, /[Rr]estart/);
  assert.equal(check.evidence.pendingRestart.includes('acp'), false, 'acp followed the index and must not be named');
});

test('a consumer that already observed the current index keeps the unchanged normal path', async (t) => {
  const env = await fixture(t);
  await writeConsumers(env.paths, env.host, [env.records[0].record.id], { acp: env.index.updatedAt, web: env.index.updatedAt });
  const check = checkOf(await diagnose(env.dshHome));
  assert.equal(check.level, 'ok', JSON.stringify(check.evidence));
  assert.deepEqual(check.evidence.pendingRestart, []);
  assert.doesNotMatch(check.summary, /need a restart/);
  assert.equal(check.remediation, undefined);
});

test('approve, supersede, disable and enable report the stale profile in their JSON result', async (t) => {
  // A fresh data root per command: supersede rotates the index timestamp, so
  // the command's own effect on acp must not leak into the next case.
  const cases = [
    // approve actually widens the record: web starts at the current index, the
    // approval rotates it, and both consumers then need a restart.
    ['approve', ['approve', '--plugin', 'P0', '--profile', 'web', '--approval', 'owner words'], ['acp', 'web'], ['acp']],
    ['supersede', ['supersede', '--old', 'P0', '--new', 'P1', '--profile', 'web', '--approval', 'owner words'], ['acp', 'web'], ['acp', 'web']],
    ['disable', ['disable', '--plugin', 'P0', '--profile', 'web'], ['web'], ['acp', 'web']],
    ['enable', ['enable', '--plugin', 'P0', '--profile', 'web'], ['web'], ['acp', 'web']],
  ];
  for (const [name, template, expected, profiles] of cases) {
    const env = await fixture(t, ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'], profiles);
    const [first, second] = env.records.filter((row) => row.root === env.cliPaths).map((row) => row.record);
    await writeConsumers(env.cliPaths, env.host, [first.id, second.id], { acp: env.cliIndex.updatedAt, web: OLD });
    const args = template.map((value) => value === 'P0' ? first.id : value === 'P1' ? second.id : value);
    const run = runCli(args, env.cliPaths.dataRoot);
    assert.equal(run.code, 0, `${name}: ${run.stderr}`);
    assert.deepEqual(run.json.pendingRestartProfiles, expected, `${name}: ${JSON.stringify(run.json)}`);
    assert.match(run.json.restartGuidance ?? '', /web/);
    assert.match(run.json.restartGuidance ?? '', /[Rr]estart/);
  }
});

test('a revoked active mount is a revocation restart, not a claim of index lag', async (t) => {
  const env = await fixture(t);
  const record = env.records[0].record;
  // acp already observed the current index, but still mounts the plugin.
  await writeConsumers(env.paths, env.host, [record.id], { acp: env.index.updatedAt, web: env.index.updatedAt });
  await writeConsumers(env.cliPaths, env.host, [record.id], { acp: env.cliIndex.updatedAt, web: env.cliIndex.updatedAt });
  await setDisabledForProfile({ dataRoot: env.paths.dataRoot }, { pluginId: record.id, profile: 'acp', disabled: true });
  const check = checkOf(await diagnose(env.dshHome));
  assert.equal(check.level, 'degraded');
  assert.deepEqual(check.evidence.pendingRestart, ['acp']);
  assert.deepEqual(check.evidence.pendingRestartDetails, [{ profile: 'acp', reason: 'revoked-active-mount' }]);
  assert.match(check.summary, /revoked/);
  assert.match(check.remediation, /revoked/);
  const run = runCli(['disable', '--plugin', record.id, '--profile', 'acp'], env.cliPaths.dataRoot);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.json.pendingRestartProfiles, ['acp']);
  assert.deepEqual(run.json.pendingRestartDetails, [{ profile: 'acp', reason: 'revoked-active-mount' }]);
  assert.match(run.json.restartGuidance, /revoked/);
});

test('a profile can need both a revoked unload and a stale-index reload', async (t) => {
  const env = await fixture(t, ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
  const [oldRecord, replacement] = env.records.filter((row) => row.root === env.cliPaths).map((row) => row.record);
  for (const root of [env.paths, env.cliPaths]) {
    const ids = env.records.filter((row) => row.root === root).map((row) => row.record.id);
    await writeConsumerState({ dataRoot: root.dataRoot }, 'web', consumerStateDocument({
      profile: 'web', host: env.host, indexUpdatedAt: OLD, compositionPath: null,
      plugins: ids.map((id) => ({ id, status: 'active', reason: null })),
    }));
  }
  await setDisabledForProfile({ dataRoot: env.paths.dataRoot }, { pluginId: oldRecord.id, profile: 'web', disabled: true });
  await setDisabledForProfile({ dataRoot: env.cliPaths.dataRoot }, { pluginId: oldRecord.id, profile: 'web', disabled: true });
  const check = checkOf(await diagnose(env.dshHome));
  assert.deepEqual(check.evidence.pendingRestartDetails, [
    { profile: 'web', reason: 'revoked-active-mount' }, { profile: 'web', reason: 'index-stale' },
  ]);
  assert.deepEqual(check.evidence.pendingRestart, ['web'], 'the profile is still named once');
  assert.match(check.summary, /revoked/);
  assert.match(check.summary, /have not loaded the current shared index/);
  assert.match(check.remediation, /revoked/);
  assert.match(check.remediation, /load the current shared index/);
  const run = runCli(['disable', '--plugin', replacement.id, '--profile', 'acp'], env.cliPaths.dataRoot);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.json.pendingRestartProfiles, ['web']);
  assert.deepEqual(run.json.pendingRestartDetails, [
    { profile: 'web', reason: 'revoked-active-mount' }, { profile: 'web', reason: 'index-stale' },
  ]);
});

test('list uses the same pending-restart decision as the top-level CLI result', async (t) => {
  const env = await fixture(t);
  const record = env.records.find((row) => row.root === env.cliPaths).record;
  await writeConsumers(env.cliPaths, env.host, [record.id], { acp: env.cliIndex.updatedAt, web: env.cliIndex.updatedAt });
  await setDisabledForProfile({ dataRoot: env.cliPaths.dataRoot }, { pluginId: record.id, profile: 'acp', disabled: true });
  const run = runCli(['list'], env.cliPaths.dataRoot);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.json.consumers.acp.needsRestart, true);
  assert.deepEqual(run.json.pendingRestartProfiles, ['acp']);
  assert.deepEqual(run.json.pendingRestartDetails, [{ profile: 'acp', reason: 'revoked-active-mount' }]);
});

test('list keeps a revoked active mount visible when the publication index is absent', async (t) => {
  const env = await fixture(t);
  const record = env.records.find((row) => row.root === env.cliPaths).record;
  await writeConsumers(env.cliPaths, env.host, [record.id], { acp: env.cliIndex.updatedAt });
  await setDisabledForProfile({ dataRoot: env.cliPaths.dataRoot }, { pluginId: record.id, profile: 'acp', disabled: true });
  await fs.rm(sharingPaths(env.cliPaths).indexPath, { force: true });
  const run = runCli(['list'], env.cliPaths.dataRoot);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.json.indexStatus, 'absent');
  assert.equal(run.json.consumers.acp.needsRestart, true);
  assert.deepEqual(run.json.pendingRestartProfiles, ['acp']);
  assert.deepEqual(run.json.pendingRestartDetails, [{ profile: 'acp', reason: 'revoked-active-mount' }]);
});

test('enable reports a reload when the consumer last observed an operator-disabled row', async (t) => {
  const env = await fixture(t);
  const record = env.records.find((row) => row.root === env.cliPaths).record;
  await writeConsumerState({ dataRoot: env.cliPaths.dataRoot }, 'acp', consumerStateDocument({
    profile: 'acp', host: env.host, indexUpdatedAt: env.cliIndex.updatedAt, compositionPath: null,
    plugins: [{ id: record.id, status: 'disabled', reason: 'operator-disabled' }],
  }));
  await setDisabledForProfile({ dataRoot: env.cliPaths.dataRoot }, { pluginId: record.id, profile: 'acp', disabled: true });
  const run = runCli(['enable', '--plugin', record.id, '--profile', 'acp'], env.cliPaths.dataRoot);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.json.pendingRestartProfiles, ['acp']);
  assert.deepEqual(run.json.pendingRestartDetails, [{ profile: 'acp', reason: 'eligibility-restored' }]);
  assert.match(run.json.restartGuidance, /eligible again/);
});

test('an unreadable revocation table cannot be mistaken for restored eligibility', async (t) => {
  const env = await fixture(t);
  const record = env.records.find((row) => row.root === env.cliPaths).record;
  await writeConsumerState({ dataRoot: env.cliPaths.dataRoot }, 'acp', consumerStateDocument({
    profile: 'acp', host: env.host, indexUpdatedAt: env.cliIndex.updatedAt, compositionPath: null,
    plugins: [{ id: record.id, status: 'disabled', reason: 'operator-disabled' }],
  }));
  await fs.writeFile(sharingPaths(env.cliPaths).disablePath, '{invalid\n');
  const run = runCli(['list'], env.cliPaths.dataRoot);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.json.disableStatus, 'invalid');
  assert.equal(run.json.consumers.acp.needsRestart, false);
  assert.deepEqual(run.json.pendingRestartProfiles, []);
  assert.equal(run.json.pendingRestartDetails?.some((row) => row.reason === 'eligibility-restored'), false);
});

test('CLI normal path reports an empty pending-restart list when every consumer followed the index', async (t) => {
  const env = await fixture(t);
  const record = env.records.find((row) => row.root === env.cliPaths).record;
  await writeConsumers(env.cliPaths, env.host, [record.id], { acp: env.cliIndex.updatedAt, web: env.cliIndex.updatedAt });
  const run = runCli(['approve', '--plugin', record.id, '--profile', 'web', '--approval', 'owner words'], env.cliPaths.dataRoot);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.json.pendingRestartProfiles, []);
  assert.equal(run.json.restartGuidance, undefined);
});
