// The doctor's cross-entry publication check: read-only, per-record digests,
// host compatibility and each consumer's last activation result.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectDiagnostics, resolveEvolutionPaths } from '../lib/diagnostics.js';
import { consumerStateDocument, publishSharedRecord, setDisabledForProfile, writeConsumerState } from '../lib/promoted-sharing.js';

const HEX = (value) => crypto.createHash('sha256').update(value).digest('hex');
const KEY = 'b'.repeat(64);
const pluginName = 'dsh-evolution-promoted-abcdefabcdef';
const pluginId = 'evolution-promoted-abcdefabcdef';

async function home(t) {
  const dshHome = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-sharing-doctor-'));
  t.after(() => fs.rm(dshHome, { recursive: true, force: true }));
  const paths = resolveEvolutionPaths({ dshHome });
  await fs.mkdir(paths.dataRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(paths.keyPath, KEY, { mode: 0o600 });
  const pluginDir = path.join(paths.pluginRoot, pluginName);
  await fs.mkdir(path.join(pluginDir, 'lib'), { recursive: true });
  const modulePath = path.join(pluginDir, 'lib', 'index.js');
  const source = 'export const name = "shared";\nexport const inject = ["tools"];\nexport function apply() {}\n';
  await fs.writeFile(modulePath, source);
  const manifest = `${JSON.stringify({ name: pluginName, version: '0.1.0', type: 'module', main: 'lib/index.js' })}\n`;
  await fs.writeFile(path.join(pluginDir, 'package.json'), manifest);
  return { dshHome, paths, pluginDir, modulePath, source, manifest };
}

const checkOf = (report, id) => report.checks.find((check) => check.id === id);

async function recordFor(env, host) {
  return {
    id: pluginId, schemaVersion: 1, experimentId: 'exp-doctor-share', pluginName, moduleUrl: pathToFileURL(env.modulePath).href, entry: 'lib/index.js',
    sourceSha256: HEX(env.source), manifestSha256: HEX(env.manifest),
    publisherProfile: 'desktop', approvedProfiles: ['acp', 'web'],
    stable: { committedAt: '2026-01-02T00:00:00.000Z', promotionTimestamp: '2026-01-01T00:00:00.000Z', decision: 'benefit', canary: { healthObservationWindow: 2, observations: 2, startupVerified: true } },
    requiredServices: ['tools'], serviceMembers: {}, requiredCapabilities: ['fiberLifecycle', 'fiberAwait', 'include', 'toolsRegistry'],
    hostOnly: true, host, revalidation: [], publishedAt: '2026-01-02T00:00:00.000Z',
  };
}

async function observedHostOf(dshHome) {
  const report = await collectDiagnostics({ dshHome, home: true, probe: { skipComposition: true } });
  const host = checkOf(report, 'host.version')?.evidence ?? {};
  const modules = checkOf(report, 'host.modules')?.evidence?.modules ?? [];
  const moduleVersion = (name) => modules.find((module) => module.name === name)?.version ?? null;
  return {
    dsh: host.found ?? null,
    cordis: moduleVersion('@deepseek-ai/cordis'),
    include: moduleVersion('@deepseek-ai/cordis-plugin-include'),
    node: process.version,
    verifiedAt: '2026-01-02T00:00:00.000Z',
  };
}

test('no publication keeps every promotion Desktop-only and reports ok', async (t) => {
  const env = await home(t);
  const report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  const check = checkOf(report, 'promotion.sharing');
  assert.equal(check.level, 'ok');
  assert.equal(check.evidence.status, 'absent');
  assert.equal(report.status !== 'blocked', true);
});

test('an invalid record in an otherwise readable index blocks the check', async (t) => {
  const env = await home(t);
  const host = await observedHostOf(env.dshHome);
  const dataRoot = { dataRoot: env.paths.dataRoot, pluginRoot: env.paths.pluginRoot };
  assert.equal((await publishSharedRecord(dataRoot, await recordFor(env, host))).status, 'published');
  const indexPath = path.join(env.paths.dataRoot, 'shared-plugins', 'published.json');
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  delete index.plugins[0].pluginName; // one malformed row among otherwise valid data
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  const report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  const check = checkOf(report, 'promotion.sharing');
  assert.equal(check.level, 'blocked', JSON.stringify(check.evidence));
  assert.equal(check.evidence.invalidRecords.length, 1);
  assert.ok(check.evidence.problems.some((problem) => problem.id === pluginId));
  assert.match(check.remediation, /re-promoting it through Desktop/);
  assert.doesNotMatch(check.remediation, /dsh-evolution-shared disable/);
});

test('an absent index with a still-active consumer mount is degraded, not healthy', async (t) => {
  const env = await home(t);
  const host = await observedHostOf(env.dshHome);
  await writeConsumerState({ dataRoot: env.paths.dataRoot }, 'acp', consumerStateDocument({
    profile: 'acp', host, indexUpdatedAt: '2026-01-02T00:00:00.000Z', compositionPath: null,
    plugins: [{ id: pluginId, status: 'active', reason: null }],
  }));
  const report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  const check = checkOf(report, 'promotion.sharing');
  assert.equal(check.level, 'degraded', JSON.stringify(check.evidence));
  assert.equal(check.evidence.status, 'absent');
  assert.deepEqual(check.evidence.orphanMounts, [{ profile: 'acp', id: pluginId }]);
  assert.match(check.remediation, /Restart the consumer/);
});

test('a malformed consumer row does not crash the absent-index diagnosis', async (t) => {
  const env = await home(t);
  await writeConsumerState({ dataRoot: env.paths.dataRoot }, 'acp', consumerStateDocument({
    profile: 'acp', host: await observedHostOf(env.dshHome), indexUpdatedAt: '2026-01-02T00:00:00.000Z',
    compositionPath: null, plugins: [null, { id: pluginId, status: 'active', reason: null }],
  }));
  const report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  const check = checkOf(report, 'promotion.sharing');
  assert.equal(check.level, 'degraded');
  assert.deepEqual(check.evidence.orphanMounts, [{ profile: 'acp', id: pluginId }]);
});

test('a verified publication is reported per record and per consumer', async (t) => {
  const env = await home(t);
  const host = await observedHostOf(env.dshHome);
  const record = await recordFor(env, host);
  const dataRoot = { dataRoot: env.paths.dataRoot, pluginRoot: env.paths.pluginRoot };
  assert.equal((await publishSharedRecord(dataRoot, record)).status, 'published');
  await writeConsumerState({ dataRoot: env.paths.dataRoot }, 'acp', consumerStateDocument({
    profile: 'acp', host, indexUpdatedAt: '2026-01-02T00:00:00.000Z', compositionPath: null,
    plugins: [{ id: pluginId, status: 'active', reason: null }],
  }));
  const report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  const check = checkOf(report, 'promotion.sharing');
  assert.notEqual(check.level, 'blocked', JSON.stringify(check.evidence));
  const row = check.evidence.records.find((entry) => entry.id === pluginId);
  assert.equal(row.source, 'verified');
  assert.deepEqual(row.approvedProfiles, ['acp', 'web']);
  assert.deepEqual(check.evidence.consumers.acp.active, [pluginId]);
  // Web never ran, so its state is absent, not a fabricated success.
  assert.equal(check.evidence.consumers.web.status, 'absent');
});

test('tampered source or a malformed index blocks the sharing check', async (t) => {
  const env = await home(t);
  const host = await observedHostOf(env.dshHome);
  const dataRoot = { dataRoot: env.paths.dataRoot, pluginRoot: env.paths.pluginRoot };
  await publishSharedRecord(dataRoot, await recordFor(env, host));
  await fs.writeFile(env.modulePath, 'tampered bytes');
  let report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  let check = checkOf(report, 'promotion.sharing');
  assert.equal(check.level, 'blocked');
  assert.equal(check.evidence.records[0].source, 'source-digest-mismatch');

  await fs.writeFile(env.modulePath, env.source);
  await fs.writeFile(path.join(env.paths.dataRoot, 'shared-plugins', 'published.json'), '{not json');
  report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  check = checkOf(report, 'promotion.sharing');
  assert.equal(check.level, 'blocked');
  assert.equal(check.evidence.status, 'invalid');
});

test('a failed consumer activation degrades the check and names the plugin', async (t) => {
  const env = await home(t);
  const host = await observedHostOf(env.dshHome);
  const dataRoot = { dataRoot: env.paths.dataRoot, pluginRoot: env.paths.pluginRoot };
  await publishSharedRecord(dataRoot, await recordFor(env, host));
  await writeConsumerState({ dataRoot: env.paths.dataRoot }, 'web', consumerStateDocument({
    profile: 'web', host, indexUpdatedAt: '2026-01-02T00:00:00.000Z', compositionPath: null,
    plugins: [{ id: pluginId, status: 'failed', reason: 'plugin-apply-failed' }],
  }));
  const report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  const check = checkOf(report, 'promotion.sharing');
  assert.equal(check.level, 'degraded');
  assert.deepEqual(check.evidence.consumers.web.plugins.map((row) => row.status), ['failed']);
  assert.equal(check.evidence.consumers.web.plugins[0].reason, 'plugin-apply-failed');
});

test('an unreadable revocation table degrades the check and names its status', async (t) => {
  const env = await home(t);
  const host = await observedHostOf(env.dshHome);
  const dataRoot = { dataRoot: env.paths.dataRoot, pluginRoot: env.paths.pluginRoot };
  await publishSharedRecord(dataRoot, await recordFor(env, host));
  const disablePath = path.join(env.paths.dataRoot, 'shared-plugins', 'disabled.json');
  await fs.writeFile(disablePath, '{not json');
  const report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  const check = checkOf(report, 'promotion.sharing');
  assert.equal(check.level, 'degraded');
  assert.equal(check.evidence.disableStatus, 'invalid');
  assert.match(check.summary, /revocation table is invalid/);
});

// 2026-11-24 reliability round: a consumer that explicitly refuses an approved
// record is not a healthy publication, even when its bytes and host facts agree.
test('a skipped-incompatible consumer row degrades the sharing check', async (t) => {
  const env = await home(t);
  const host = await observedHostOf(env.dshHome);
  const dataRoot = { dataRoot: env.paths.dataRoot, pluginRoot: env.paths.pluginRoot };
  await publishSharedRecord(dataRoot, await recordFor(env, host));
  await writeConsumerState({ dataRoot: env.paths.dataRoot }, 'acp', consumerStateDocument({
    profile: 'acp', host, indexUpdatedAt: '2026-01-02T00:00:00.000Z', compositionPath: null,
    plugins: [{ id: pluginId, status: 'skipped-incompatible', reason: 'missing-host-capability' }],
  }));
  const report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  const check = checkOf(report, 'promotion.sharing');
  assert.equal(check.level, 'degraded', JSON.stringify(check.evidence));
  assert.deepEqual(check.evidence.inactiveConsumers, [{
    profile: 'acp', id: pluginId, status: 'skipped-incompatible', reason: 'missing-host-capability',
  }]);
});

// A consumer row written before an operator revoked the profile is historical:
// the unified review reports the record as disabled now, so doctor must not
// keep degrading on a stale refusal.
test('a revoked profile does not keep a stale failed consumer row degraded', async (t) => {
  const env = await home(t);
  const host = await observedHostOf(env.dshHome);
  const dataRoot = { dataRoot: env.paths.dataRoot, pluginRoot: env.paths.pluginRoot };
  await publishSharedRecord(dataRoot, await recordFor(env, host));
  const index = JSON.parse(await fs.readFile(path.join(env.paths.dataRoot, 'shared-plugins', 'published.json'), 'utf8'));
  await writeConsumerState({ dataRoot: env.paths.dataRoot }, 'acp', consumerStateDocument({
    profile: 'acp', host, indexUpdatedAt: index.updatedAt, compositionPath: null,
    plugins: [{ id: pluginId, status: 'failed', reason: 'plugin-apply-failed' }],
  }));
  await setDisabledForProfile(env.paths, { pluginId, profile: 'acp', disabled: true });
  const report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  const check = checkOf(report, 'promotion.sharing');
  assert.equal(check.level, 'ok', JSON.stringify(check.evidence));
  assert.deepEqual(check.evidence.deadConsumers ?? [], []);
});

test('a revoked record still mounted by a consumer needs a restart', async (t) => {
  const env = await home(t);
  const host = await observedHostOf(env.dshHome);
  const dataRoot = { dataRoot: env.paths.dataRoot, pluginRoot: env.paths.pluginRoot };
  await publishSharedRecord(dataRoot, await recordFor(env, host));
  const index = JSON.parse(await fs.readFile(path.join(env.paths.dataRoot, 'shared-plugins', 'published.json'), 'utf8'));
  await writeConsumerState({ dataRoot: env.paths.dataRoot }, 'acp', consumerStateDocument({
    profile: 'acp', host, indexUpdatedAt: index.updatedAt, compositionPath: null,
    plugins: [{ id: pluginId, status: 'active', reason: null }],
  }));
  await setDisabledForProfile(env.paths, { pluginId, profile: 'acp', disabled: true });
  const report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  const check = checkOf(report, 'promotion.sharing');
  assert.equal(check.level, 'degraded', JSON.stringify(check.evidence));
  assert.ok(check.evidence.pendingRestart.includes('acp'));
});
