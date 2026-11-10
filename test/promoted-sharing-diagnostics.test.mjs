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
import { consumerStateDocument, publishSharedRecord, writeConsumerState } from '../lib/promoted-sharing.js';

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
