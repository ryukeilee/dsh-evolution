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
import { readPublishedPluginReview, REVIEW_ACTIONS } from '../lib/self-evolution-review.js';

const HEX = (value) => crypto.createHash('sha256').update(value).digest('hex');
const KEY = 'b'.repeat(64);
const pluginName = 'dsh-evolution-promoted-abcdefabcdef';
const pluginId = 'evolution-promoted-abcdefabcdef';
// A complete host fact set that does not depend on an installed host CLI: the
// doctor's own observed host may be unavailable in a bare checkout, which must
// not decide whether a record can be published for these fixtures.
const SYNTHETIC_HOST = Object.freeze({
  dsh: '0.2.2-rc.5',
  cordis: '4.1.0',
  include: '1.1.0',
  node: process.version,
  verifiedAt: '2026-01-02T00:00:00.000Z',
});

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
  const modulesCheck = checkOf(report, 'host.modules');
  const modules = modulesCheck?.evidence?.modules ?? [];
  const facts = modulesCheck?.evidence?.hostFacts ?? null;
  const moduleVersion = (name) => modules.find((module) => module.name === name)?.version ?? null;
  const observed = {
    // A packaged host has no Node-resolvable package root; its module versions
    // come from the manifests that identified the CLI, never this process's
    // peer dependencies. Missing fields stay null.
    dsh: facts?.dsh ?? host.found ?? null,
    cordis: facts?.cordis ?? moduleVersion('@deepseek-ai/cordis'),
    include: facts?.include ?? moduleVersion('@deepseek-ai/cordis-plugin-include'),
    node: process.version,
    verifiedAt: '2026-01-02T00:00:00.000Z',
  };
  // A multi-version wrapper deliberately leaves the profile host unattributed.
  // Publication fixtures still need one complete identity; use the synthetic
  // set rather than inventing missing fields from the doctor process.
  return typeof observed.dsh === 'string' && observed.dsh ? observed : SYNTHETIC_HOST;
}

// Use the doctor's own observed host when one CLI version can be attributed;
// otherwise use the same complete synthetic identity as observedHostOf.
async function fixtureHost(dshHome) {
  return observedHostOf(dshHome);
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

// Same scene on both read-only surfaces: a valid index with a corrupt
// disabled.json makes consumers refuse every record, so doctor must report
// BLOCKED just like the unified review (which emits operator-action).
test('an unreadable revocation table blocks the doctor and the unified review', async (t) => {
  const env = await home(t);
  const host = await observedHostOf(env.dshHome);
  const dataRoot = { dataRoot: env.paths.dataRoot, pluginRoot: env.paths.pluginRoot };
  await publishSharedRecord(dataRoot, await recordFor(env, host));
  const disablePath = path.join(env.paths.dataRoot, 'shared-plugins', 'disabled.json');
  await fs.writeFile(disablePath, '{not json');
  const report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  const check = checkOf(report, 'promotion.sharing');
  assert.equal(check.level, 'blocked', JSON.stringify(check.evidence));
  assert.equal(check.evidence.disableStatus, 'invalid');
  assert.equal(check.evidence.blockingReason, 'disable-state-invalid');
  assert.match(check.summary, /revocation table is invalid; consumers refuse every record/);
  assert.match(check.remediation, /Restore it from a backup/);
  assert.doesNotMatch(check.remediation, /Read the per-profile consumer state/);

  const review = await readPublishedPluginReview({ paths: env.paths, host });
  assert.equal(review.status, 'blocked');
  assert.equal(review.records[0].status, 'blocked');
  assert.equal(review.records[0].action, REVIEW_ACTIONS.OPERATOR);
  assert.ok(review.nextActions.some((row) => row.action === REVIEW_ACTIONS.OPERATOR && /revocation table is invalid/.test(row.why)));
});

test('an empty index with a damaged revocation table is blocked on both surfaces', async (t) => {
  const env = await home(t);
  const host = await observedHostOf(env.dshHome);
  const indexPath = path.join(env.paths.dataRoot, 'shared-plugins', 'published.json');
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, `${JSON.stringify({
    schemaVersion: 1, kind: 'dsh-evolution-shared-plugins', updatedAt: new Date().toISOString(), plugins: [],
  }, null, 2)}\n`);
  await fs.writeFile(path.join(env.paths.dataRoot, 'shared-plugins', 'disabled.json'), '{not json');
  const report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  const check = checkOf(report, 'promotion.sharing');
  assert.equal(check.level, 'blocked', JSON.stringify(check.evidence));
  assert.equal(check.evidence.disableStatus, 'invalid');
  const review = await readPublishedPluginReview({ paths: env.paths, host });
  assert.equal(review.status, 'blocked');
  assert.equal(review.nextActions.some((row) => row.action === REVIEW_ACTIONS.OPERATOR && /revocation table is invalid/.test(row.why)), true);
});

test('a host-mismatched record with a damaged revocation table stays blocked, not revalidation', async (t) => {
  const env = await home(t);
  const host = await observedHostOf(env.dshHome);
  const dataRoot = { dataRoot: env.paths.dataRoot, pluginRoot: env.paths.pluginRoot };
  // Publish under a different DSH version so the live review sees pending
  // revalidation for the record itself.
  await publishSharedRecord(dataRoot, await recordFor(env, { ...host, dsh: '0.0.1' }));
  await fs.writeFile(path.join(env.paths.dataRoot, 'shared-plugins', 'disabled.json'), '{not json');
  const report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  const check = checkOf(report, 'promotion.sharing');
  assert.equal(check.level, 'blocked', JSON.stringify(check.evidence));
  assert.equal(check.evidence.disableStatus, 'invalid');
  const review = await readPublishedPluginReview({ paths: env.paths, host });
  assert.equal(review.status, 'blocked');
  assert.equal(review.records[0].status, 'blocked');
  assert.equal(review.records[0].action, REVIEW_ACTIONS.OPERATOR);
  assert.equal(review.nextActions.some((row) => row.action === REVIEW_ACTIONS.REVALIDATE), false,
    'a damaged revocation table cannot be recovered by revalidating a record');
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

// The revocation table is shape-validated through `String(entry.pluginId)`, so a
// non-string entry can reach the membership check. String interpolation would
// fold an array onto the record id it contains, turning it into a revocation the
// baseline's `===` never honoured; the id must keep its type and value.
test('a non-string revocation id does not revoke a matching record', async (t) => {
  const env = await home(t);
  const host = await observedHostOf(env.dshHome);
  const dataRoot = { dataRoot: env.paths.dataRoot, pluginRoot: env.paths.pluginRoot };
  await publishSharedRecord(dataRoot, await recordFor(env, host));
  const index = JSON.parse(await fs.readFile(path.join(env.paths.dataRoot, 'shared-plugins', 'published.json'), 'utf8'));
  await writeConsumerState({ dataRoot: env.paths.dataRoot }, 'acp', consumerStateDocument({
    profile: 'acp', host, indexUpdatedAt: index.updatedAt, compositionPath: null,
    plugins: [{ id: pluginId, status: 'active', reason: null }],
  }));
  await fs.writeFile(path.join(env.paths.dataRoot, 'shared-plugins', 'disabled.json'), `${JSON.stringify({
    schemaVersion: 1, kind: 'dsh-evolution-shared-plugin-disable', updatedAt: '2026-01-02T00:00:00.000Z',
    entries: [{ pluginId: [pluginId], profile: 'acp', disabledAt: '2026-01-02T00:00:00.000Z' }],
  }, null, 2)}\n`);
  const report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  const check = checkOf(report, 'promotion.sharing');
  assert.equal(check.level, 'ok', JSON.stringify(check.evidence));
  assert.deepEqual(check.evidence.pendingRestart ?? [], []);
});

// R11 C-1: published.json can survive while one record is edited away or a
// profile is removed from approvedProfiles. A still-active consumer mount keeps
// running, so the doctor must not report the same scene as healthy.
async function publishedWithActiveAcp(t) {
  const env = await home(t);
  const dataRoot = { dataRoot: env.paths.dataRoot, pluginRoot: env.paths.pluginRoot };
  const published = await publishSharedRecord(dataRoot, await recordFor(env, SYNTHETIC_HOST));
  assert.equal(published.status, 'published');
  const indexPath = path.join(env.paths.dataRoot, 'shared-plugins', 'published.json');
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  await writeConsumerState({ dataRoot: env.paths.dataRoot }, 'acp', consumerStateDocument({
    profile: 'acp', host: SYNTHETIC_HOST, indexUpdatedAt: index.updatedAt, compositionPath: null,
    plugins: [{ id: pluginId, status: 'active', reason: null }],
  }));
  return { env, indexPath, index };
}

test('a record deleted from a readable index still has an active orphan mount', async (t) => {
  const { env, indexPath, index } = await publishedWithActiveAcp(t);
  index.plugins = [];
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  const report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  const check = checkOf(report, 'promotion.sharing');
  assert.equal(check.level, 'degraded', JSON.stringify(check.evidence));
  assert.equal(check.evidence.status, 'ok');
  assert.deepEqual(check.evidence.orphanMounts, [{ profile: 'acp', id: pluginId, reason: 'record-missing' }]);
  assert.match(check.summary, /orphan active mount/);
  assert.match(check.remediation, /Restart the consumer/);
});

test('an unapproved profile still has an active orphan mount', async (t) => {
  const { env, indexPath, index } = await publishedWithActiveAcp(t);
  index.plugins[0].approvedProfiles = ['web'];
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  const report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  const check = checkOf(report, 'promotion.sharing');
  assert.equal(check.level, 'degraded', JSON.stringify(check.evidence));
  assert.equal(check.evidence.status, 'ok');
  assert.deepEqual(check.evidence.orphanMounts, [{ profile: 'acp', id: pluginId, reason: 'profile-not-approved' }]);
  assert.match(check.summary, /orphan active mount/);
  assert.match(check.remediation, /Restart the consumer/);
});

test('an approved, mounted record is not an orphan mount', async (t) => {
  const { env } = await publishedWithActiveAcp(t);
  const report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  const check = checkOf(report, 'promotion.sharing');
  assert.equal(check.evidence.status, 'ok');
  assert.deepEqual(check.evidence.orphanMounts, []);
});

// R11 consumer-state reliability: an unreadable state, or a state that claims
// to have observed the current index without an activation row for an approved
// record, cannot prove activation. Both read-only surfaces must agree that the
// affected consumer needs a restart instead of reporting a healthy publication.
test('an invalid consumer state degrades the doctor and requires a restart', async (t) => {
  const env = await home(t);
  const host = await fixtureHost(env.dshHome);
  const dataRoot = { dataRoot: env.paths.dataRoot, pluginRoot: env.paths.pluginRoot };
  await publishSharedRecord(dataRoot, await recordFor(env, host));
  const consumersDir = path.join(env.paths.dataRoot, 'shared-plugins', 'consumers');
  await fs.mkdir(consumersDir, { recursive: true });
  await fs.writeFile(path.join(consumersDir, 'acp.json'), '{not json');

  const report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  const check = checkOf(report, 'promotion.sharing');
  assert.equal(check.level, 'degraded', JSON.stringify(check.evidence));
  assert.deepEqual(check.evidence.unverifiedConsumers, [{ profile: 'acp', status: 'invalid' }]);
  assert.equal(check.evidence.consumers.acp.status, 'invalid');
  assert.match(check.summary, /restart/i);
  assert.match(check.remediation, /restart/i);

  const review = await readPublishedPluginReview({ paths: env.paths, host });
  assert.equal(review.records[0].status, 'restart-required');
  assert.ok(review.nextActions.some((row) => row.action === REVIEW_ACTIONS.RESTART && row.recordId === pluginId));
});

test('an absent index with an invalid consumer state keeps the existing absent shape', async (t) => {
  const env = await home(t);
  const host = await fixtureHost(env.dshHome);
  const consumersDir = path.join(env.paths.dataRoot, 'shared-plugins', 'consumers');
  await fs.mkdir(consumersDir, { recursive: true });
  await fs.writeFile(path.join(consumersDir, 'acp.json'), '{not json');

  const report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  const check = checkOf(report, 'promotion.sharing');
  assert.equal(check.level, 'ok', JSON.stringify(check.evidence));
  assert.equal(check.evidence.status, 'absent');
  assert.equal(check.evidence.unverifiedConsumers, undefined);
  const review = await readPublishedPluginReview({ paths: env.paths, host });
  assert.equal(review.status, 'absent');
});

test('an active consumer row is neither unverified nor a missing row', async (t) => {
  const env = await home(t);
  const observed = await observedHostOf(env.dshHome);
  const host = typeof observed.dsh === 'string' && observed.dsh ? observed : SYNTHETIC_HOST;
  const dataRoot = { dataRoot: env.paths.dataRoot, pluginRoot: env.paths.pluginRoot };
  await publishSharedRecord(dataRoot, await recordFor(env, host));
  const indexPath = path.join(env.paths.dataRoot, 'shared-plugins', 'published.json');
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  await writeConsumerState({ dataRoot: env.paths.dataRoot }, 'acp', consumerStateDocument({
    profile: 'acp', host, indexUpdatedAt: index.updatedAt, compositionPath: null,
    plugins: [{ id: pluginId, status: 'active', reason: null }],
  }));

  const report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  const check = checkOf(report, 'promotion.sharing');
  // Without a discoverable CLI the doctor also sees a host mismatch, so level
  // is only asserted healthy where the published host can actually be observed.
  if (observed.dsh) assert.equal(check.level, 'ok', JSON.stringify(check.evidence));
  assert.deepEqual(check.evidence.unverifiedConsumers, []);
  assert.deepEqual(check.evidence.missingConsumerRows, []);
  assert.deepEqual(check.evidence.unverifiedActivationRows, []);
});

test('a consumer that observed the current index without the record row is degraded', async (t) => {
  const env = await home(t);
  const observed = await observedHostOf(env.dshHome);
  const host = typeof observed.dsh === 'string' && observed.dsh ? observed : SYNTHETIC_HOST;
  const dataRoot = { dataRoot: env.paths.dataRoot, pluginRoot: env.paths.pluginRoot };
  await publishSharedRecord(dataRoot, await recordFor(env, host));
  const indexPath = path.join(env.paths.dataRoot, 'shared-plugins', 'published.json');
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  await writeConsumerState({ dataRoot: env.paths.dataRoot }, 'acp', consumerStateDocument({
    profile: 'acp', host, indexUpdatedAt: index.updatedAt, compositionPath: null, plugins: [],
  }));

  let report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  let check = checkOf(report, 'promotion.sharing');
  assert.equal(check.level, 'degraded', JSON.stringify(check.evidence));
  assert.deepEqual(check.evidence.missingConsumerRows, [{ profile: 'acp', id: pluginId }]);
  assert.match(check.remediation, /restart/i);

  const review = await readPublishedPluginReview({ paths: env.paths, host });
  assert.equal(review.records[0].status, 'restart-required');

  // Writing the activation row clears the suspicion without any other change.
  await writeConsumerState({ dataRoot: env.paths.dataRoot }, 'acp', consumerStateDocument({
    profile: 'acp', host, indexUpdatedAt: index.updatedAt, compositionPath: null,
    plugins: [{ id: pluginId, status: 'active', reason: null }],
  }));
  report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  check = checkOf(report, 'promotion.sharing');
  if (observed.dsh) assert.equal(check.level, 'ok', JSON.stringify(check.evidence));
  assert.deepEqual(check.evidence.missingConsumerRows, []);
});

// R2-2: a row whose status cannot be classified is not proof of activation;
// the unified review reports consumer-unknown -> unverified -> restart-required.
test('an activation row without a known status degrades the doctor and requires a restart', async (t) => {
  const env = await home(t);
  const observed = await observedHostOf(env.dshHome);
  const host = typeof observed.dsh === 'string' && observed.dsh ? observed : SYNTHETIC_HOST;
  const dataRoot = { dataRoot: env.paths.dataRoot, pluginRoot: env.paths.pluginRoot };
  await publishSharedRecord(dataRoot, await recordFor(env, host));
  const indexPath = path.join(env.paths.dataRoot, 'shared-plugins', 'published.json');
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  await writeConsumerState({ dataRoot: env.paths.dataRoot }, 'acp', consumerStateDocument({
    profile: 'acp', host, indexUpdatedAt: index.updatedAt, compositionPath: null,
    plugins: [{ id: pluginId }], // no status: cannot prove activation
  }));

  const report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  const check = checkOf(report, 'promotion.sharing');
  assert.equal(check.level, 'degraded', JSON.stringify(check.evidence));
  assert.deepEqual(check.evidence.unverifiedActivationRows, [{ profile: 'acp', id: pluginId, reason: 'consumer-unknown' }]);
  assert.deepEqual(check.evidence.consumers.acp.active, []);
  assert.match(check.summary, /restart/i);
  assert.match(check.remediation, /restart/i);

  const review = await readPublishedPluginReview({ paths: env.paths, host });
  assert.equal(review.records[0].status, 'restart-required');
});

// R2-2: the review only visits approved profiles. A damaged state for a profile
// with no approved, non-revoked record must not manufacture a restart request.
test('an unapproved profile with an invalid state does not degrade the doctor', async (t) => {
  const env = await home(t);
  const observed = await observedHostOf(env.dshHome);
  const host = typeof observed.dsh === 'string' && observed.dsh ? observed : SYNTHETIC_HOST;
  const dataRoot = { dataRoot: env.paths.dataRoot, pluginRoot: env.paths.pluginRoot };
  await publishSharedRecord(dataRoot, await recordFor(env, host));
  const indexPath = path.join(env.paths.dataRoot, 'shared-plugins', 'published.json');
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  index.plugins[0].approvedProfiles = ['web'];
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  await writeConsumerState({ dataRoot: env.paths.dataRoot }, 'web', consumerStateDocument({
    profile: 'web', host, indexUpdatedAt: index.updatedAt, compositionPath: null,
    plugins: [{ id: pluginId, status: 'active', reason: null }],
  }));
  const consumersDir = path.join(env.paths.dataRoot, 'shared-plugins', 'consumers');
  await fs.mkdir(consumersDir, { recursive: true });
  await fs.writeFile(path.join(consumersDir, 'acp.json'), '{not json');

  const report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  const check = checkOf(report, 'promotion.sharing');
  if (observed.dsh) assert.equal(check.level, 'ok', JSON.stringify(check.evidence));
  assert.deepEqual(check.evidence.unverifiedConsumers, []);
  assert.deepEqual(check.evidence.missingConsumerRows, []);
  assert.deepEqual(check.evidence.unverifiedActivationRows, []);

  const review = await readPublishedPluginReview({ paths: env.paths, host });
  assert.equal(review.records[0].status, 'active');
  assert.equal(review.nextActions.some((row) => row.action === REVIEW_ACTIONS.RESTART), false);
});

// R2-2: a consumer that refuses an approved record because eligibility changed
// needs a restart, just as the unified review reports (restart-required).
test('a skipped-unapproved activation row degrades the doctor and requires a restart', async (t) => {
  const env = await home(t);
  const observed = await observedHostOf(env.dshHome);
  const host = typeof observed.dsh === 'string' && observed.dsh ? observed : SYNTHETIC_HOST;
  const dataRoot = { dataRoot: env.paths.dataRoot, pluginRoot: env.paths.pluginRoot };
  await publishSharedRecord(dataRoot, await recordFor(env, host));
  const indexPath = path.join(env.paths.dataRoot, 'shared-plugins', 'published.json');
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  index.plugins[0].approvedProfiles = ['acp'];
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  await writeConsumerState({ dataRoot: env.paths.dataRoot }, 'acp', consumerStateDocument({
    profile: 'acp', host, indexUpdatedAt: index.updatedAt, compositionPath: null,
    plugins: [{ id: pluginId, status: 'skipped-unapproved', reason: 'eligibility-changed-since-consumer-start' }],
  }));

  const report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  const check = checkOf(report, 'promotion.sharing');
  assert.equal(check.level, 'degraded', JSON.stringify(check.evidence));
  assert.ok(check.evidence.inactiveConsumers.some((row) => row.profile === 'acp' && row.id === pluginId && row.status === 'skipped-unapproved'));
  assert.match(check.remediation, /restart/i);

  const review = await readPublishedPluginReview({ paths: env.paths, host });
  assert.equal(review.records[0].status, 'restart-required');
  assert.ok(review.nextActions.some((row) => row.action === REVIEW_ACTIONS.RESTART && row.recordId === pluginId));
});

test('a historical disabled row stays quiet while an actionable one needs a restart', async (t) => {
  const env = await home(t);
  const observed = await observedHostOf(env.dshHome);
  const host = typeof observed.dsh === 'string' && observed.dsh ? observed : SYNTHETIC_HOST;
  const dataRoot = { dataRoot: env.paths.dataRoot, pluginRoot: env.paths.pluginRoot };
  await publishSharedRecord(dataRoot, await recordFor(env, host));
  const indexPath = path.join(env.paths.dataRoot, 'shared-plugins', 'published.json');
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  index.plugins[0].approvedProfiles = ['acp'];
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  const writeState = (reason) => writeConsumerState({ dataRoot: env.paths.dataRoot }, 'acp', consumerStateDocument({
    profile: 'acp', host, indexUpdatedAt: index.updatedAt, compositionPath: null,
    plugins: [{ id: pluginId, status: 'disabled', reason }],
  }));

  await writeState('already-mounted');
  let report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  let check = checkOf(report, 'promotion.sharing');
  if (observed.dsh) assert.equal(check.level, 'ok', JSON.stringify(check.evidence));
  assert.deepEqual(check.evidence.inactiveConsumers, []);
  let review = await readPublishedPluginReview({ paths: env.paths, host });
  assert.equal(review.records[0].status, 'inactive');

  await writeState('operator-disabled');
  report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  check = checkOf(report, 'promotion.sharing');
  assert.equal(check.level, 'degraded', JSON.stringify(check.evidence));
  assert.ok(check.evidence.inactiveConsumers.some((row) => row.profile === 'acp' && row.status === 'disabled'));
  assert.match(check.remediation, /restart/i);
  review = await readPublishedPluginReview({ paths: env.paths, host });
  assert.equal(review.records[0].status, 'restart-required');
});

// R3-1: a consumer state can be structurally valid while one plugins entry is
// null. Null rows are not activation facts: neither read-only surface may
// dereference them, and only well-formed rows may prove activation.
test('a null activation row in an unapproved consumer does not break the review', async (t) => {
  const env = await home(t);
  const observed = await observedHostOf(env.dshHome);
  const host = typeof observed.dsh === 'string' && observed.dsh ? observed : SYNTHETIC_HOST;
  const dataRoot = { dataRoot: env.paths.dataRoot, pluginRoot: env.paths.pluginRoot };
  await publishSharedRecord(dataRoot, await recordFor(env, host));
  const indexPath = path.join(env.paths.dataRoot, 'shared-plugins', 'published.json');
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  index.plugins[0].approvedProfiles = ['web'];
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  await writeConsumerState({ dataRoot: env.paths.dataRoot }, 'web', consumerStateDocument({
    profile: 'web', host, indexUpdatedAt: index.updatedAt, compositionPath: null,
    plugins: [{ id: pluginId, status: 'active', reason: null }],
  }));
  await writeConsumerState({ dataRoot: env.paths.dataRoot }, 'acp', consumerStateDocument({
    profile: 'acp', host, indexUpdatedAt: index.updatedAt, compositionPath: null,
    plugins: [null],
  }));

  const report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  const check = checkOf(report, 'promotion.sharing');
  if (observed.dsh) assert.equal(check.level, 'ok', JSON.stringify(check.evidence));
  assert.deepEqual(check.evidence.missingConsumerRows, []);

  const review = await readPublishedPluginReview({ paths: env.paths, host });
  assert.equal(review.status, 'active');
  assert.equal(review.records[0].status, 'active');
  assert.equal(review.records[0].action, null);
  assert.equal(review.nextActions.some((row) => row.action === REVIEW_ACTIONS.RESTART), false);
});

test('a null activation row in an approved consumer is a missing row, not a crash', async (t) => {
  const env = await home(t);
  const observed = await observedHostOf(env.dshHome);
  const host = typeof observed.dsh === 'string' && observed.dsh ? observed : SYNTHETIC_HOST;
  const dataRoot = { dataRoot: env.paths.dataRoot, pluginRoot: env.paths.pluginRoot };
  await publishSharedRecord(dataRoot, await recordFor(env, host));
  const indexPath = path.join(env.paths.dataRoot, 'shared-plugins', 'published.json');
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  index.plugins[0].approvedProfiles = ['acp'];
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  await writeConsumerState({ dataRoot: env.paths.dataRoot }, 'acp', consumerStateDocument({
    profile: 'acp', host, indexUpdatedAt: index.updatedAt, compositionPath: null,
    plugins: [null],
  }));

  const report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  const check = checkOf(report, 'promotion.sharing');
  assert.equal(check.level, 'degraded', JSON.stringify(check.evidence));
  assert.deepEqual(check.evidence.missingConsumerRows, [{ profile: 'acp', id: pluginId }]);

  const review = await readPublishedPluginReview({ paths: env.paths, host });
  assert.equal(review.records[0].status, 'restart-required');
  assert.ok(review.nextActions.some((row) => row.action === REVIEW_ACTIONS.RESTART && row.recordId === pluginId));
});

test('a null activation row is dropped while a valid active row is kept', async (t) => {
  const env = await home(t);
  const observed = await observedHostOf(env.dshHome);
  const host = typeof observed.dsh === 'string' && observed.dsh ? observed : SYNTHETIC_HOST;
  const dataRoot = { dataRoot: env.paths.dataRoot, pluginRoot: env.paths.pluginRoot };
  await publishSharedRecord(dataRoot, await recordFor(env, host));
  const indexPath = path.join(env.paths.dataRoot, 'shared-plugins', 'published.json');
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  index.plugins[0].approvedProfiles = ['acp'];
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  await writeConsumerState({ dataRoot: env.paths.dataRoot }, 'acp', consumerStateDocument({
    profile: 'acp', host, indexUpdatedAt: index.updatedAt, compositionPath: null,
    plugins: [null, { id: pluginId, status: 'active', reason: null }],
  }));

  const report = await collectDiagnostics({ dshHome: env.dshHome, home: true, probe: { skipComposition: true } });
  const check = checkOf(report, 'promotion.sharing');
  if (observed.dsh) assert.equal(check.level, 'ok', JSON.stringify(check.evidence));
  assert.deepEqual(check.evidence.consumers.acp.active, [pluginId]);
  assert.deepEqual(check.evidence.missingConsumerRows, []);

  const review = await readPublishedPluginReview({ paths: env.paths, host });
  assert.equal(review.status, 'active');
  assert.equal(review.records[0].status, 'active');
  assert.equal(review.consumers.acp.rowCount, 1);
  assert.equal(review.consumers.acp.rows[0].id, pluginId);
});
