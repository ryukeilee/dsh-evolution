// Cross-entry publication, validation, compatibility and reconciliation.
//
// Every fixture lives under a fresh os.tmpdir() directory. Nothing here reads a
// real DSH home or a real promotion; the promoted plugin is synthesized with the
// same shape the Desktop promotion transaction writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildSharedRecord,
  consumerCompositionEntries,
  consumerStateDocument,
  evaluateSharedRecord,
  hostCompatible,
  hostDigest,
  publishSharedRecord,
  readConsumerState,
  readDisableState,
  readPromotedPlugin,
  readSharedIndex,
  reconcileSharedIndex,
  scanStableShareCandidates,
  setDisabledForProfile,
  sharingPaths,
  SHARED_STATUS,
  validateSharedRecord,
  writeConsumerState,
} from '../lib/promoted-sharing.js';

const HEX = (value) => crypto.createHash('sha256').update(value).digest('hex');
const HOST = { profile: 'desktop', dsh: '0.2.2-rc.1', cordis: '4.1.0', include: '1.1.0', node: 'v24.21.0', capturedAt: '2026-01-01T00:00:00.000Z' };
const CAPABILITIES = { fiberLifecycle: true, fiberAwait: true, include: true, toolsRegistry: true };

function scratch(name) {
  return fs.mkdtemp(path.join(os.tmpdir(), `evo-sharing-${name}-`));
}

async function fixture(t, { id = 'exp-share-1', pluginName = 'dsh-evolution-promoted-abcdefabcdef', moduleSource = null, inject = ['tools'], manifestName = null } = {}) {
  const root = await scratch('root');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = {
    dataRoot: root,
    presetDir: root,
    pluginRoot: path.join(root, 'promoted'),
    archiveDir: path.join(root, 'archive'),
    compositionPath: path.join(root, 'promoted.cordis.yml'),
  };
  const pluginDir = path.join(paths.pluginRoot, pluginName);
  await fs.mkdir(path.join(pluginDir, 'lib'), { recursive: true });
  const modulePath = path.join(pluginDir, 'lib', 'index.js');
  const source = moduleSource || `export const name = ${JSON.stringify(pluginName)};\nexport const inject = ${JSON.stringify(inject)};\nexport function apply(ctx) { ctx.on("shared/probe", (payload) => { payload.hits += 1; }); }\n`;
  await fs.writeFile(modulePath, source);
  await fs.writeFile(path.join(pluginDir, 'package.json'), `${JSON.stringify({ name: manifestName || pluginName, version: '0.1.0', private: true, type: 'module', main: 'lib/index.js' }, null, 2)}\n`);
  await fs.mkdir(paths.archiveDir, { recursive: true });
  const durable = {
    pluginName,
    pluginPath: pluginDir,
    moduleUrl: pathToFileURL(modulePath).href,
    rowId: `evolution-promoted-${pluginName.slice('dsh-evolution-promoted-'.length)}`,
  };
  const experiment = stableExperiment(id, durable);
  return { root, paths, pluginDir, modulePath, source, durable, experiment };
}

function stableExperiment(id, durable) {
  return {
    id,
    ownerId: 'desktop-owner',
    state: 'stable',
    stableCommittedAt: '2026-01-02T00:00:00.000Z',
    shareTargets: ['acp', 'web'],
    canary: {
      promotionTimestamp: '2026-01-01T23:00:00.000Z',
      healthObservationWindow: 2,
      startupVerified: true,
      observations: [{ barrierId: 'startup:desktop' }, { barrierId: 'post:desktop' }],
    },
    decision: { version: 1, kind: 'benefit', source: 'canary-passed' },
    durable,
  };
}

async function buildRecord(env, overrides = {}) {
  return buildSharedRecord({
    paths: env.paths,
    experiment: overrides.experiment ?? env.experiment,
    durable: overrides.durable ?? env.durable,
    journal: null,
    approvedProfiles: overrides.approvedProfiles ?? env.experiment.shareTargets,
    host: overrides.host ?? HOST,
    capabilities: overrides.capabilities ?? CAPABILITIES,
    source: { stableCommittedAt: overrides.stableCommittedAt ?? env.experiment.stableCommittedAt },
    ...overrides.buildOptions,
  });
}

test('a publication record is built only from a verified stable commit', async (t) => {
  const env = await fixture(t);
  const record = await buildRecord(env);
  assert.equal(record.id, env.durable.rowId);
  assert.deepEqual(record.approvedProfiles, ['acp', 'web']);
  assert.deepEqual(record.requiredServices, ['tools']);
  assert.deepEqual(record.requiredCapabilities, ['fiberLifecycle', 'fiberAwait', 'include', 'toolsRegistry']);
  assert.equal(record.stable.decision, 'benefit');
  assert.equal(record.sourceSha256, HEX(env.source));
  assert.equal(validateSharedRecord(record, env.paths).ok, true);

  // No stable commit time: not a stable fact.
  await assert.rejects(buildSharedRecord({
    paths: env.paths,
    experiment: { ...env.experiment, stableCommittedAt: undefined },
    durable: env.durable,
    approvedProfiles: ['acp'],
    host: HOST,
    capabilities: CAPABILITIES,
  }), /stable commit time/);
  // Canary window not satisfied.
  const shortCanary = { ...env.experiment, canary: { ...env.experiment.canary, observations: [{ barrierId: 'one' }] } };
  await assert.rejects(buildRecord(env, { experiment: shortCanary }), /health window/);
  // Startup canary never verified.
  const unverified = { ...env.experiment, canary: { ...env.experiment.canary, startupVerified: false } };
  await assert.rejects(buildRecord(env, { experiment: unverified }), /startup canary/);
  // A regression decision is not a publishable stable fact.
  const regression = { ...env.experiment, decision: { kind: 'regression' } };
  await assert.rejects(buildRecord(env, { experiment: regression }), /benefit decision/);
  // Desktop-only promotions are never published.
  await assert.rejects(buildRecord(env, { approvedProfiles: [] }), /Desktop-only/);
  // Only consumer profiles may be approved.
  await assert.rejects(buildRecord(env, { approvedProfiles: ['acp', 'mobile'] }), /acp, web/);
  // A missing host identity is unverifiable, not compatible.
  await assert.rejects(buildRecord(env, { host: { profile: 'desktop' } }), /host identity/);
  // A missing official capability cannot be attested.
  await assert.rejects(buildRecord(env, { capabilities: { fiberLifecycle: true, fiberAwait: true, include: false } }), /lifecycle capability/);
});

test('publishing is atomic, idempotent and refuses a conflicting source digest', async (t) => {
  const env = await fixture(t);
  const record = await buildRecord(env);
  const first = await publishSharedRecord(env.paths, record);
  assert.equal(first.status, 'published');
  const index = await readSharedIndex(env.paths);
  assert.equal(index.status, 'ok');
  assert.equal(index.records.length, 1);
  // Atomic writer leaves no temporary file behind.
  const leftovers = (await fs.readdir(path.dirname(sharingPaths(env.paths).indexPath))).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, []);

  const again = await publishSharedRecord(env.paths, { ...record, publishedAt: '2026-02-01T00:00:00.000Z' });
  assert.equal(again.status, 'unchanged');
  assert.equal((await readSharedIndex(env.paths)).records[0].publishedAt, record.publishedAt);

  // A republish with the same id but different bytes is a conflict: verified
  // bytes are never silently replaced.
  const conflicting = { ...record, sourceSha256: 'f'.repeat(64) };
  const refusal = await publishSharedRecord(env.paths, conflicting);
  assert.equal(refusal.status, 'conflict');
  assert.equal((await readSharedIndex(env.paths)).records[0].sourceSha256, record.sourceSha256);
});

test('one malformed record does not discard the valid ones', async (t) => {
  const env = await fixture(t);
  const record = await buildRecord(env);
  await publishSharedRecord(env.paths, record);
  const indexPath = sharingPaths(env.paths).indexPath;
  const document = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  document.plugins.push({ id: 'evolution-promoted-000000000000', schemaVersion: 1 });
  await fs.writeFile(indexPath, JSON.stringify(document));
  const index = await readSharedIndex(env.paths);
  assert.equal(index.status, 'ok');
  assert.deepEqual(index.records.map((row) => row.id), [record.id]);
  assert.equal(index.invalid.length, 1);
  assert.equal(index.invalid[0].reason, 'record-experiment-id');
});

test('source identity is read in place and rejects symlinks, mismatches and traversal', async (t) => {
  const env = await fixture(t);
  const plugin = await readPromotedPlugin(env.paths, env.durable);
  assert.equal(plugin.sourceSha256, HEX(env.source));

  // moduleUrl must match the promoted directory.
  await assert.rejects(readPromotedPlugin(env.paths, { ...env.durable, moduleUrl: pathToFileURL(path.join(env.root, 'elsewhere.js')).href }), /module URL/);
  // A symlinked plugin directory is refused even when it points inside.
  const linkDir = path.join(env.paths.pluginRoot, 'dsh-evolution-promoted-111111111111');
  await fs.symlink(env.pluginDir, linkDir);
  await assert.rejects(readPromotedPlugin(env.paths, { ...env.durable, pluginName: 'dsh-evolution-promoted-111111111111', moduleUrl: env.durable.moduleUrl }), /symbolic link|URL/);
  // A symlinked entry file is refused.
  const linkedModule = path.join(env.pluginDir, 'lib', 'linked.js');
  await fs.symlink(path.join(env.pluginDir, 'lib', 'index.js'), linkedModule);
  await assert.rejects(readPromotedPlugin(env.paths, { ...env.durable, entry: 'lib/linked.js', moduleUrl: pathToFileURL(linkedModule).href }), /symbolic link/);
  // Path traversal cannot leave the plugin directory.
  await assert.rejects(readPromotedPlugin(env.paths, { ...env.durable, entry: '../../escape.js', moduleUrl: env.durable.moduleUrl }), /manifest|missing|symbolic/);
});

test('the consumer decides eligibility without executing an ineligible plugin', async (t) => {
  const env = await fixture(t);
  const record = await buildRecord(env);
  const currentHost = { ...HOST, profile: 'acp' };
  const base = {
    paths: env.paths,
    record,
    host: currentHost,
    capabilities: CAPABILITIES,
    services: { has: (name) => name === 'tools', memberPresent: () => true },
    mountedModuleUrls: [],
    disableState: { entries: [] },
    previousState: null,
  };
  const eligible = await evaluateSharedRecord({ ...base, profile: 'acp' });
  assert.equal(eligible.status, 'eligible');

  const unapproved = await evaluateSharedRecord({ ...base, profile: 'web' });
  assert.equal(unapproved.status, 'eligible', 'web is approved by the fixture');

  const notApproved = { ...record, approvedProfiles: ['web'] };
  assert.equal((await evaluateSharedRecord({ ...base, profile: 'acp', record: notApproved })).status, SHARED_STATUS.UNNAPPROVED);

  const disabled = await evaluateSharedRecord({ ...base, profile: 'acp', disableState: { entries: [{ pluginId: record.id, profile: 'acp', disabledAt: '2026-01-01' }] } });
  assert.equal(disabled.status, SHARED_STATUS.DISABLED);
  assert.equal(disabled.reason, 'operator-disabled');

  const publisher = await evaluateSharedRecord({ ...base, profile: 'desktop', host: { ...HOST, profile: 'desktop' }, kernelEnabled: true, services: { has: () => true, memberPresent: () => true } });
  assert.equal(publisher.status, SHARED_STATUS.DISABLED);
  assert.equal(publisher.reason, 'publisher-profile');
  // The same profile may consume its own publication when its kernel row is
  // disabled: no other mounter exists, so the consumer is the correct one.
  const publisherWithoutKernel = await evaluateSharedRecord({ ...base, profile: 'acp', host: currentHost, kernelEnabled: false });
  assert.equal(publisherWithoutKernel.status, 'eligible');

  const alreadyMounted = await evaluateSharedRecord({ ...base, profile: 'acp', mountedModuleUrls: [record.moduleUrl] });
  assert.equal(alreadyMounted.status, SHARED_STATUS.DISABLED);
  assert.equal(alreadyMounted.reason, 'already-mounted');

  const missingService = await evaluateSharedRecord({ ...base, profile: 'acp', services: { has: () => false, memberPresent: () => true } });
  assert.equal(missingService.status, SHARED_STATUS.INCOMPATIBLE);
  assert.equal(missingService.reason, 'missing-service');
  assert.deepEqual(missingService.services, ['tools']);

  const missingCapability = await evaluateSharedRecord({ ...base, profile: 'acp', capabilities: { ...CAPABILITIES, include: false } });
  assert.equal(missingCapability.status, SHARED_STATUS.INCOMPATIBLE);
  assert.equal(missingCapability.reason, 'missing-host-capability');

  // A different DSH release needs revalidation instead of a guessed mount.
  const revalidation = await evaluateSharedRecord({ ...base, profile: 'acp', host: { ...currentHost, dsh: '0.2.3-rc.1' } });
  assert.equal(revalidation.status, SHARED_STATUS.REVALIDATION);
  assert.equal(revalidation.reason, 'host-version-mismatch');

  // Tampered bytes are refused with the invalid status.
  await fs.writeFile(env.modulePath, 'tampered');
  const tampered = await evaluateSharedRecord({ ...base, profile: 'acp' });
  assert.equal(tampered.status, SHARED_STATUS.INVALID);
  assert.equal(tampered.reason, 'source-digest-mismatch');

  // A sticky previous failure is not retried on every boot.
  await fs.writeFile(env.modulePath, env.source);
  const failed = await evaluateSharedRecord({
    ...base, profile: 'acp',
    previousState: { plugins: [{ id: record.id, status: SHARED_STATUS.FAILED, sourceSha256: record.sourceSha256, hostDigest: hostDigest(currentHost) }] },
  });
  assert.equal(failed.status, SHARED_STATUS.FAILED);
  assert.equal(failed.sticky, true);
});

test('host identity comparison is capability-friendly but never version-blind', () => {
  const base = { dsh: '0.2.2-rc.1', cordis: '4.1.0', include: '1.1.0', node: 'v24.21.0' };
  assert.equal(hostCompatible(base, { ...base, cordis: '4.1.3', include: '1.1.7', node: 'v24.9.0' }).ok, true);
  assert.equal(hostCompatible(base, { ...base, dsh: '0.2.2-rc.2' }).reason, 'host-version-mismatch');
  assert.equal(hostCompatible(base, { ...base, cordis: '4.2.0' }).reason, 'cordis-version-mismatch');
  assert.equal(hostCompatible(base, { ...base, include: '1.2.0' }).reason, 'include-version-mismatch');
  assert.equal(hostCompatible(base, { ...base, node: 'v26.0.0' }).reason, 'node-version-mismatch');
  assert.equal(hostCompatible(null, base).reason, 'host-facts-missing');
});

test('per-profile revocation and consumer state round-trip atomically', async (t) => {
  const env = await fixture(t);
  const record = await buildRecord(env);
  await publishSharedRecord(env.paths, record);
  await setDisabledForProfile(env.paths, { pluginId: record.id, profile: 'acp', disabled: true });
  const disabled = await readDisableState(env.paths);
  assert.equal(disabled.status, 'ok');
  assert.equal(disabled.entries.length, 1);
  await setDisabledForProfile(env.paths, { pluginId: record.id, profile: 'acp', disabled: false });
  assert.equal((await readDisableState(env.paths)).entries.length, 0);

  const state = consumerStateDocument({ profile: 'acp', host: HOST, indexUpdatedAt: '2026-01-01T00:00:00.000Z', compositionPath: '/tmp/x.yml', plugins: [{ id: record.id, status: 'active' }] });
  await writeConsumerState(env.paths, 'acp', state);
  const read = await readConsumerState(env.paths, 'acp');
  assert.equal(read.status, 'ok');
  assert.equal(read.state.plugins[0].status, 'active');
  assert.equal(compareJson(read.state, state), true);
});

function compareJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

test('consumer composition entries contain each record exactly once', async (t) => {
  const env = await fixture(t);
  const record = await buildRecord(env);
  const entries = consumerCompositionEntries([record, record, null]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, `shared-${record.id}`);
  assert.equal(entries[0].name, record.moduleUrl);
});

test('startup reconciliation republishes only explicit stable approvals', async (t) => {
  const env = await fixture(t, { id: 'exp-share-reconcile' });
  // A stable sidecar with an explicit approval and a committed durable identity.
  const manifestBytes = await fs.readFile(path.join(env.pluginDir, 'package.json'), 'utf8');
  const sidecar = {
    stableCommittedAt: '2026-01-02T00:00:00.000Z',
    shareTargets: ['acp'],
    durable: env.durable,
    canary: env.experiment.canary,
    decision: { kind: 'benefit' },
    // The verified publication identity is the durable stable fact a reconciler
    // must reuse; without it a republish is refused, never re-derived.
    publication: { sourceSha256: HEX(env.source), manifestSha256: HEX(manifestBytes), verifiedAt: '2026-01-02T00:00:00.000Z', host: HOST },
  };
  await fs.writeFile(path.join(env.paths.archiveDir, 'exp-share-reconcile.evidence.json'), JSON.stringify(sidecar));
  // A historical Desktop-only stable promotion stays out of the index.
  await fs.writeFile(path.join(env.paths.archiveDir, 'exp-desktop-only.evidence.json'), JSON.stringify({ ...sidecar, shareTargets: [] }));
  const candidates = await scanStableShareCandidates(env.paths);
  assert.deepEqual(candidates.map((row) => row.experimentId), ['exp-share-reconcile']);

  const newerHost = { ...HOST, dsh: '0.2.9-rc.9', cordis: '4.9.0', include: '1.9.0', node: 'v26.0.0' };
  const result = await reconcileSharedIndex({ paths: env.paths, host: newerHost, capabilities: CAPABILITIES });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.published.map((row) => row.id), [env.durable.rowId]);
  const index = await readSharedIndex(env.paths);
  assert.deepEqual(index.records[0].approvedProfiles, ['acp']);
  assert.equal(index.records[0].stable.canary.healthObservationWindow, 2);
  // The reconciler's own host is NOT adopted: the record keeps the identity the
  // promotion was verified on, so consumers on the new host wait for
  // revalidation instead of treating an unverified host as verified.
  assert.equal(index.records[0].host.dsh, HOST.dsh);
  assert.equal(index.records[0].host.cordis, HOST.cordis);

  // Reconcile again: the same stable fact is a no-op.
  const again = await reconcileSharedIndex({ paths: env.paths, host: HOST, capabilities: CAPABILITIES });
  assert.deepEqual(again.published, []);
  assert.ok(again.unchanged >= 1);
  assert.equal((await readSharedIndex(env.paths)).records.length, 1);
});

test('concurrent publications never lose a record and never expose a half write', async (t) => {
  const env = await fixture(t, { id: 'exp-share-concurrent' });
  const first = await buildRecord(env);
  // A second promoted plugin inside the same data root, published at the same
  // time as the first: the CAS retry must merge both records.
  const secondPluginName = 'dsh-evolution-promoted-1234567890ab';
  const secondDir = path.join(env.paths.pluginRoot, secondPluginName);
  await fs.mkdir(path.join(secondDir, 'lib'), { recursive: true });
  await fs.writeFile(path.join(secondDir, 'lib', 'index.js'), env.source);
  await fs.writeFile(path.join(secondDir, 'package.json'), `${JSON.stringify({ name: secondPluginName, version: '0.1.0', type: 'module', main: 'lib/index.js' })}\n`);
  const secondRecord = await buildRecord(env, {
    durable: { pluginName: secondPluginName, pluginPath: secondDir, moduleUrl: pathToFileURL(path.join(secondDir, 'lib', 'index.js')).href, rowId: 'evolution-promoted-1234567890ab' },
    experiment: { ...env.experiment, id: 'exp-share-concurrent-2', durable: { pluginName: secondPluginName, pluginPath: secondDir, moduleUrl: pathToFileURL(path.join(secondDir, 'lib', 'index.js')).href, rowId: 'evolution-promoted-1234567890ab' } },
  });
  // A stray temporary file left by a crashed writer is ignored, because only
  // the published name is ever read.
  const sharedDir = path.dirname(sharingPaths(env.paths).indexPath);
  await fs.mkdir(sharedDir, { recursive: true });
  await fs.writeFile(path.join(sharedDir, '.shared-crashed-writer.tmp'), '{"partial":');
  const results = await Promise.all([
    publishSharedRecord(env.paths, first),
    publishSharedRecord(env.paths, secondRecord),
  ]);
  assert.deepEqual(results.map((row) => row.status).sort(), ['published', 'published']);
  const index = await readSharedIndex(env.paths);
  assert.equal(index.status, 'ok');
  assert.equal(index.records.length, 2);
  assert.deepEqual(index.records.map((row) => row.id).sort(), [first.id, secondRecord.id].sort());
});

test('the publication lock reclaims a dead owner and never steals a live one', async (t) => {
  const os = await import('node:os');
  const env = await fixture(t, { id: 'exp-share-lock' });
  const record = await buildRecord(env);
  const sharedDir = path.dirname(sharingPaths(env.paths).indexPath);
  await fs.mkdir(sharedDir, { recursive: true });
  const lockPath = sharingPaths(env.paths).lockPath;
  // The previous publisher crashed before releasing its lock: its pid is gone.
  await fs.writeFile(lockPath, JSON.stringify({ token: 'dead-owner', pid: 999_999_999, hostname: os.hostname(), at: new Date(0).toISOString() }));
  const published = await publishSharedRecord(env.paths, record);
  assert.equal(published.status, 'published');
  await assert.rejects(fs.access(lockPath), 'the successful publisher releases its own lock');

  // A live owner's lock is waited out, not deleted, and the publication fails
  // closed instead of interleaving with it.
  await fs.writeFile(lockPath, JSON.stringify({ token: 'live-owner', pid: process.pid, hostname: os.hostname(), at: new Date().toISOString() }));
  await assert.rejects(publishSharedRecord(env.paths, record), (error) => error?.code === 'E_SHARED_PUBLISH_BUSY');
  assert.equal((await readSharedIndex(env.paths)).records.length, 1, 'the live owner\'s index state is untouched');
  await fs.rm(lockPath, { force: true });
});

test('a reconciler never republishes a changed source or a missing identity', async (t) => {
  const env = await fixture(t, { id: 'exp-share-reconcile-tamper' });
  const manifestBytes = await fs.readFile(path.join(env.pluginDir, 'package.json'), 'utf8');
  const sidecar = {
    stableCommittedAt: '2026-01-02T00:00:00.000Z',
    shareTargets: ['acp'],
    durable: env.durable,
    canary: env.experiment.canary,
    decision: { kind: 'benefit' },
    publication: { sourceSha256: HEX(env.source), manifestSha256: HEX(manifestBytes), verifiedAt: '2026-01-02T00:00:00.000Z', host: HOST },
  };
  const sidecarPath = path.join(env.paths.archiveDir, 'exp-share-reconcile-tamper.evidence.json');
  await fs.writeFile(sidecarPath, JSON.stringify(sidecar));
  // The plugin bytes changed after the stable commit: refuse, do not launder.
  await fs.writeFile(env.modulePath, 'tampered after stable commit');
  const tampered = await reconcileSharedIndex({ paths: env.paths, host: HOST, capabilities: CAPABILITIES });
  assert.deepEqual(tampered.published, []);
  assert.equal((await readSharedIndex(env.paths)).records.length, 0);
  assert.ok(tampered.skipped.some((row) => /verified promotion source|differs/.test(String(row.reason))), JSON.stringify(tampered.skipped));

  // A stable approval with no recorded publication identity cannot be rebuilt
  // from the reconciler's current view either.
  await fs.writeFile(env.modulePath, env.source);
  await fs.writeFile(sidecarPath, JSON.stringify({ ...sidecar, publication: undefined }));
  const anonymous = await reconcileSharedIndex({ paths: env.paths, host: HOST, capabilities: CAPABILITIES });
  assert.deepEqual(anonymous.published, []);
  assert.ok(anonymous.skipped.some((row) => row.reason === 'no-verified-publication-identity'), JSON.stringify(anonymous.skipped));
});

test('Cordis object-form inject declarations gate compatibility by required services', async (t) => {
  const env = await fixture(t, {
    id: 'exp-share-object-inject',
    moduleSource: 'export const name = "declared";\nexport const inject = { required: ["kernelOnlyService"], optional: ["tools"] };\nexport function apply() {}\n',
  });
  const record = await buildRecord(env);
  assert.deepEqual(record.requiredServices, ['kernelOnlyService']);
  assert.deepEqual(record.optionalServices, ['tools']);
  const decision = await evaluateSharedRecord({
    paths: env.paths,
    record,
    profile: 'acp',
    host: { ...HOST, profile: 'acp' },
    capabilities: CAPABILITIES,
    services: { has: (name) => name === 'tools', memberPresent: () => true },
    mountedModuleUrls: [],
    disableState: { entries: [] },
    previousState: null,
  });
  assert.equal(decision.status, SHARED_STATUS.INCOMPATIBLE);
  assert.equal(decision.reason, 'missing-service');
  assert.deepEqual(decision.services, ['kernelOnlyService']);
  // The optional service is not a compatibility requirement.
  assert.equal((await evaluateSharedRecord({
    paths: env.paths, record, profile: 'acp', host: { ...HOST, profile: 'acp' }, capabilities: CAPABILITIES,
    services: { has: (name) => name === 'kernelOnlyService', memberPresent: () => true },
    mountedModuleUrls: [], disableState: { entries: [] }, previousState: null,
  })).status, 'eligible');
});
