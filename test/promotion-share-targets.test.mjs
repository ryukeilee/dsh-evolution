// Promotion side of cross-entry sharing: explicit approval scope is persisted
// with the durable transaction and only a stable commit publishes it.
//
// Synthetic fixtures only (os.tmpdir()); no real DSH home is read or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeShareTargets, writeDurablePromotion, recoverInterruptedPromotion, snapshotEvidenceFromRecord, mergeEvidenceSources, hydrateRecordFromSnapshot, EvolutionOrchestrator, reconcileSharedPromotions } from '../lib/orchestrator.js';
import { readSharedIndex, sharingPaths } from '../lib/promoted-sharing.js';
import { promotionPaths, unitPromotionRuntime, promotionExperiment, HOST_CODE, orchestratorContext, scratchRoot } from './orchestrator-durability-fixtures.mjs';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

const HOST = { profile: 'desktop', dsh: '0.2.2-rc.1', cordis: '4.1.0', include: '1.1.0', node: 'v24.21.0', capturedAt: '2026-01-01T00:00:00.000Z' };
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function fixture(t, name = 'share-targets') {
  const root = await scratchRoot(name);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = promotionPaths(root);
  const pluginRoot = path.join(root, 'promoted');
  await fs.mkdir(pluginRoot, { recursive: true });
  await fs.mkdir(paths.archiveDir, { recursive: true });
  await fs.writeFile(paths.compositionPath, '[]\n');
  await fs.writeFile(paths.evolutionPath, '');
  paths.promotionRuntime = unitPromotionRuntime();
  return { root, paths };
}

test('approval scope defaults to Desktop-only and rejects unknown profiles', () => {
  assert.deepEqual(normalizeShareTargets(undefined), []);
  assert.deepEqual(normalizeShareTargets(['desktop']), []);
  assert.deepEqual(normalizeShareTargets(['acp', 'web', 'acp', 'desktop']), ['acp', 'web']);
  assert.throws(() => normalizeShareTargets(['mobile']), /unknown profile/);
  assert.throws(() => normalizeShareTargets('acp'), /array/);
  assert.throws(() => normalizeShareTargets([42]), /strings/);
});

test('the durable transaction records the approved deployment scope', async (t) => {
  const { root, paths } = await fixture(t);
  const experiment = { ...promotionExperiment('exp-share-scope'), shareTargets: ['acp', 'web'] };
  const durable = await writeDurablePromotion({ experiment, paths, packageInspection: { code: { host: HOST_CODE } } });
  const journalFile = path.join(paths.promotionStateDir, 'journal.json');
  const journal = JSON.parse(await fs.readFile(journalFile, 'utf8'));
  assert.deepEqual(journal.shareTargets, ['acp', 'web']);
  assert.deepEqual(journal.evidenceSnapshot.shareTargets, ['acp', 'web']);
  const archive = await fs.readFile(durable.archivePath, 'utf8');
  assert.match(archive, /shared with: acp, web/);
  assert.equal(journal.phase, 'canary-observing');
});

test('an approved promotion records the verified publication identity with its journal', async (t) => {
  const { paths } = await fixture(t, 'share-targets-publication');
  const experiment = { ...promotionExperiment('exp-share-publication'), shareTargets: ['acp'] };
  await writeDurablePromotion({ experiment, paths, packageInspection: { code: { host: HOST_CODE } }, publicationHost: HOST });
  const journal = JSON.parse(await fs.readFile(path.join(paths.promotionStateDir, 'journal.json'), 'utf8'));
  assert.equal(journal.publication.sourceSha256.length, 64);
  assert.equal(journal.publication.host.dsh, HOST.dsh);
  assert.deepEqual(journal.evidenceSnapshot.publication, journal.publication);
  assert.equal(journal.durable.publication.sourceSha256, journal.publication.sourceSha256);
  // The identity describes the bytes actually written, not the host's guess.
  const module = await fs.readFile(path.join(journal.durable.pluginPath, 'lib', 'index.js'));
  const manifest = await fs.readFile(path.join(journal.durable.pluginPath, 'package.json'));
  assert.equal(journal.publication.sourceSha256, sha256(module));
  assert.equal(journal.publication.manifestSha256, sha256(manifest));
});

test('a rollout without explicit approval records no sharing fact at all', async (t) => {
  const { paths } = await fixture(t, 'share-targets-desktop-only');
  const experiment = promotionExperiment('exp-share-desktop-only');
  await writeDurablePromotion({ experiment, paths, packageInspection: { code: { host: HOST_CODE } } });
  const journal = JSON.parse(await fs.readFile(path.join(paths.promotionStateDir, 'journal.json'), 'utf8'));
  assert.equal(Object.hasOwn(journal, 'shareTargets'), false);
  assert.equal(Object.hasOwn(journal.evidenceSnapshot, 'shareTargets'), false);
});

test('a rolled-back promotion leaves no publishable record', async (t) => {
  const { paths } = await fixture(t, 'share-targets-rollback');
  const experiment = { ...promotionExperiment('exp-share-rollback'), shareTargets: ['acp'] };
  await writeDurablePromotion({ experiment, paths, packageInspection: { code: { host: HOST_CODE } } });
  // Simulate an interruption before the canary commits: recovery rolls back.
  const journalFile = path.join(paths.promotionStateDir, 'journal.json');
  const journal = JSON.parse(await fs.readFile(journalFile, 'utf8'));
  journal.phase = 'committing';
  await fs.writeFile(journalFile, JSON.stringify(journal));
  const recovered = await recoverInterruptedPromotion(paths);
  assert.equal(recovered.status, 'rolled-back');
  assert.equal((await readSharedIndex({ dataRoot: paths.presetDir, pluginRoot: paths.pluginRoot })).status, 'absent');
  assert.equal(await fs.readFile(paths.compositionPath, 'utf8'), '[]\n');
});

test('stable commit evidence carries approval, commit time and host identity', async (t) => {
  const { paths } = await fixture(t, 'share-targets-evidence');
  const experiment = { ...promotionExperiment('exp-share-evidence'), shareTargets: ['acp'], stableCommittedAt: '2026-03-01T00:00:00.000Z' };
  const snapshot = snapshotEvidenceFromRecord(experiment);
  assert.deepEqual(snapshot.shareTargets, ['acp']);
  assert.equal(snapshot.stableCommittedAt, '2026-03-01T00:00:00.000Z');
  // Merging durable sources keeps both facts (a restart must not lose them).
  const merged = mergeEvidenceSources([{ source: 'sidecar', observations: [], shareTargets: ['acp'], stableCommittedAt: '2026-03-01T00:00:00.000Z' }, { source: 'bridge', observations: [] }]);
  assert.deepEqual(merged.shareTargets, ['acp']);
  assert.equal(merged.stableCommittedAt, '2026-03-01T00:00:00.000Z');
  const hydrated = hydrateRecordFromSnapshot({ id: 'exp-share-evidence' }, merged);
  assert.deepEqual(hydrated.shareTargets, ['acp']);
  assert.equal(hydrated.stableCommittedAt, '2026-03-01T00:00:00.000Z');
  // A snapshot without the new facts stays byte-compatible.
  const legacy = snapshotEvidenceFromRecord({ id: 'legacy' });
  assert.equal(Object.hasOwn(legacy, 'shareTargets'), false);
  assert.equal(Object.hasOwn(legacy, 'stableCommittedAt'), false);
});

test('a stable promotion with approval publishes once and only after the canary commits', async (t) => {
  const root = await scratchRoot('share-targets-publish');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = promotionPaths(root);
  const pluginRoot = paths.pluginRoot;
  const pluginName = 'dsh-evolution-promoted-abcdefabcdef';
  const rowId = 'evolution-promoted-abcdefabcdef';
  const pluginDir = path.join(pluginRoot, pluginName);
  await fs.mkdir(path.join(pluginDir, 'lib'), { recursive: true });
  const modulePath = path.join(pluginDir, 'lib', 'index.js');
  await fs.writeFile(modulePath, 'export const name = "shared";\nexport const inject = ["tools"];\nexport function apply() {}\n');
  await fs.writeFile(path.join(pluginDir, 'package.json'), `${JSON.stringify({ name: pluginName, version: '0.1.0', type: 'module', main: 'lib/index.js' })}\n`);
  // The verified publication identity is captured at promotion time; a live
  // publication must reuse it instead of deriving it from the current files.
  const publication = {
    sourceSha256: sha256('export const name = "shared";\nexport const inject = ["tools"];\nexport function apply() {}\n'),
    manifestSha256: sha256(await fs.readFile(path.join(pluginDir, 'package.json'))),
    verifiedAt: '2026-01-01T00:00:00.000Z',
    host: HOST,
  };
  const durable = { pluginName, pluginPath: pluginDir, moduleUrl: pathToFileURL(modulePath).href, rowId, promotionTimestamp: '2026-01-01T00:00:00.000Z', healthObservationWindow: 2, publication };
  const record = {
    id: 'exp-share-publish',
    ownerId: 'desktop-owner',
    state: 'stable',
    stableCommittedAt: '2026-01-02T00:00:00.000Z',
    shareTargets: ['acp', 'web'],
    durable,
    canary: { promotionTimestamp: '2026-01-01T00:00:00.000Z', healthObservationWindow: 2, startupVerified: true, observations: [{ barrierId: 'startup' }, { barrierId: 'health' }] },
    decision: { version: 1, kind: 'benefit' },
  };
  const ctx = {
    ...orchestratorContext(),
    baseUrl: 'file:///tmp/profile/',
    fiber: { state: 2, uid: 1, inject: {}, inertia: undefined, store: {}, await: async () => {} },
    get: (name) => {
      if (name === 'pluginPackages') return { packageOf: () => ({ version: '0.2.2-rc.1' }) };
      if (name === 'profileContext') return { name: 'desktop' };
      return undefined;
    },
  };
  const orchestrator = new EvolutionOrchestrator(ctx, {
    presetDir: paths.presetDir, pluginRoot, compositionPath: paths.compositionPath, evolutionPath: paths.evolutionPath,
    archiveDir: paths.archiveDir, promotionStateDir: paths.promotionStateDir, promotionLockPath: paths.promotionLockPath,
    eventBridgePath: paths.eventBridgePath, eventBridgeKey: paths.eventBridgeKey,
    promotionRuntime: { ...unitPromotionRuntime(), capabilities: { entryResolver: true, treeAwait: true, liveRootEntries: true } },
  });
  const sharedPaths = { dataRoot: paths.presetDir, pluginRoot };
  const before = await orchestrator.publishCrossEntryPlugin(record, null);
  assert.equal(before.status, 'published', JSON.stringify(before));
  const index = await readSharedIndex(sharedPaths);
  assert.equal(index.records.length, 1);
  assert.deepEqual(index.records[0].approvedProfiles, ['acp', 'web']);
  assert.equal(index.records[0].stable.committedAt, '2026-01-02T00:00:00.000Z');
  // The recorded host is the verified promotion host, not the kernel's current
  // identity (the fixture host differs from the fake package service).
  assert.equal(index.records[0].host.dsh, HOST.dsh);
  assert.equal(index.records[0].host.cordis, HOST.cordis);
  // Republishing the same stable fact is a no-op.
  const again = await orchestrator.publishCrossEntryPlugin(record, null);
  assert.equal(again.status, 'unchanged');
  assert.equal((await readSharedIndex(sharedPaths)).records.length, 1);
  // A Desktop-only record is never published.
  const desktopOnly = await orchestrator.publishCrossEntryPlugin({ ...record, shareTargets: [] }, null);
  assert.equal(desktopOnly.status, 'desktop-only');
  assert.equal((await readSharedIndex(sharedPaths)).records.length, 1);
  // A promotion that is not stable cannot be published even with approval.
  const notStable = { ...record, canary: { ...record.canary, startupVerified: false } };
  const refused = await orchestrator.publishCrossEntryPlugin(notStable, null);
  assert.equal(refused.status, 'failed');
  assert.equal((await readSharedIndex(sharedPaths)).records.length, 1);
  assert.ok(sharingPaths(sharedPaths).indexPath.endsWith(path.join('shared-plugins', 'published.json')));
});

test('startup reconciliation republishes durable stable approvals through the kernel wrapper', async (t) => {
  const { root, paths } = await fixture(t, 'share-targets-reconcile');
  const pluginName = 'dsh-evolution-promoted-abcdefabcdef';
  const rowId = 'evolution-promoted-abcdefabcdef';
  const pluginDir = path.join(paths.pluginRoot, pluginName);
  await fs.mkdir(path.join(pluginDir, 'lib'), { recursive: true });
  const modulePath = path.join(pluginDir, 'lib', 'index.js');
  await fs.writeFile(modulePath, 'export const name = "shared";\nexport const inject = ["tools"];\nexport function apply() {}\n');
  await fs.writeFile(path.join(pluginDir, 'package.json'), `${JSON.stringify({ name: pluginName, version: '0.1.0', type: 'module', main: 'lib/index.js' })}\n`);
  await fs.writeFile(path.join(paths.archiveDir, 'exp-share-reconcile.evidence.json'), JSON.stringify({
    stableCommittedAt: '2026-01-02T00:00:00.000Z',
    shareTargets: ['acp', 'web'],
    durable: { pluginName, pluginPath: pluginDir, moduleUrl: pathToFileURL(modulePath).href, rowId, promotionTimestamp: '2026-01-01T00:00:00.000Z' },
    canary: { promotionTimestamp: '2026-01-01T00:00:00.000Z', healthObservationWindow: 2, startupVerified: true, observations: [{ barrierId: 'startup' }, { barrierId: 'health' }] },
    decision: { version: 1, kind: 'benefit' },
    publication: {
      sourceSha256: sha256(await fs.readFile(modulePath)),
      manifestSha256: sha256(await fs.readFile(path.join(pluginDir, 'package.json'))),
      verifiedAt: '2026-01-02T00:00:00.000Z',
      host: HOST,
    },
  }));
  const ctx = {
    ...orchestratorContext(),
    baseUrl: 'file:///tmp/profile/',
    fiber: { state: 2, uid: 1, inject: {}, inertia: undefined, store: {}, await: async () => {} },
    get: (name) => {
      if (name === 'pluginPackages') return { packageOf: () => ({ version: '0.2.2-rc.1' }) };
      if (name === 'profileContext') return { name: 'desktop' };
      return undefined;
    },
  };
  const result = await reconcileSharedPromotions({
    ctx, presetDir: paths.presetDir, pluginRoot: paths.pluginRoot, archiveDir: paths.archiveDir,
    promotionRuntime: { ...unitPromotionRuntime(), capabilities: { entryResolver: true, treeAwait: true, liveRootEntries: true } },
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.published.map((row) => row.id), [rowId]);
  const index = await readSharedIndex({ dataRoot: paths.presetDir, pluginRoot: paths.pluginRoot });
  assert.deepEqual(index.records[0].approvedProfiles, ['acp', 'web']);
  assert.equal(index.records[0].stable.committedAt, '2026-01-02T00:00:00.000Z');
  // The recorded host is the verified promotion host, not the kernel's current
  // identity (the fixture host differs from the fake package service).
  assert.equal(index.records[0].host.dsh, HOST.dsh);
  assert.equal(index.records[0].host.cordis, HOST.cordis);
});

test('stable journal recovery keeps the approved scope and the verified publication identity', async (t) => {
  const { paths } = await fixture(t, 'share-targets-recovery');
  const experiment = { ...promotionExperiment('exp-share-recovery'), shareTargets: ['acp', 'web'] };
  const durable = await writeDurablePromotion({ experiment, paths, packageInspection: { code: { host: HOST_CODE } }, publicationHost: HOST });
  const journalFile = path.join(paths.promotionStateDir, 'journal.json');
  const journal = JSON.parse(await fs.readFile(journalFile, 'utf8'));
  // The crash window: the stable phase was written, the journal was not removed.
  journal.phase = 'stable-committed';
  journal.stableCommittedAt = '2026-04-01T00:00:00.000Z';
  journal.canary = {
    ...journal.canary,
    startupVerified: true,
    observations: [{ barrierId: 'startup:desktop', startupVerified: true }, { barrierId: 'health:desktop' }],
  };
  await fs.writeFile(journalFile, JSON.stringify(journal));
  const recovered = await recoverInterruptedPromotion(paths);
  assert.equal(recovered.status, 'committed-cleaned');

  // The replay sidecar must still carry the durable stable facts: dropping them
  // here (the pre-fix behaviour) left reconciliation with nothing to publish
  // after the journal was deleted.
  const sidecar = JSON.parse(await fs.readFile(path.join(paths.archiveDir, 'exp-share-recovery.evidence.json'), 'utf8'));
  assert.deepEqual(sidecar.shareTargets, ['acp', 'web']);
  assert.equal(sidecar.stableCommittedAt, '2026-04-01T00:00:00.000Z');
  assert.equal(sidecar.publication.sourceSha256, journal.publication.sourceSha256);
  assert.equal(sidecar.publication.host.dsh, HOST.dsh);
  assert.equal(sidecar.durable.publication.sourceSha256, journal.publication.sourceSha256);

  // And reconciliation republishes exactly that durable fact, with the identity
  // verified at promotion time (not the reconciler's current host).
  const newerHost = { ...HOST, dsh: '0.2.9-rc.9', cordis: '4.9.0', include: '1.9.0', node: 'v26.0.0' };
  const result = await reconcileSharedPromotions({ ctx: { get: (name) => name === 'profileContext' ? { name: 'desktop' } : name === 'pluginPackages' ? { packageOf: () => ({ version: '0.2.9-rc.9' }) } : undefined, fiber: { state: 2, uid: 1, inject: {}, inertia: undefined, store: {}, await: async () => {} } },
    presetDir: paths.presetDir, pluginRoot: paths.pluginRoot, archiveDir: paths.archiveDir,
    promotionRuntime: { ...unitPromotionRuntime(), capabilities: { entryResolver: true, treeAwait: true, liveRootEntries: true } } });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.published.map((row) => row.id), [durable.rowId]);
  const index = await readSharedIndex({ dataRoot: paths.presetDir, pluginRoot: paths.pluginRoot });
  assert.deepEqual(index.records[0].approvedProfiles, ['acp', 'web']);
  assert.equal(index.records[0].stable.committedAt, '2026-04-01T00:00:00.000Z');
  assert.equal(index.records[0].host.dsh, HOST.dsh);
});

test('a live publication without a verified identity stays Desktop-only', async (t) => {
  const root = await scratchRoot('share-targets-no-publication');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = promotionPaths(root);
  const pluginName = 'dsh-evolution-promoted-abcdefabcdef';
  const rowId = 'evolution-promoted-abcdefabcdef';
  const pluginDir = path.join(paths.pluginRoot, pluginName);
  await fs.mkdir(path.join(pluginDir, 'lib'), { recursive: true });
  const modulePath = path.join(pluginDir, 'lib', 'index.js');
  await fs.writeFile(modulePath, 'export const name = "shared";\nexport function apply() {}\n');
  await fs.writeFile(path.join(pluginDir, 'package.json'), `${JSON.stringify({ name: pluginName, type: 'module', main: 'lib/index.js' })}\n`);
  const durable = { pluginName, pluginPath: pluginDir, moduleUrl: pathToFileURL(modulePath).href, rowId };
  const record = {
    id: 'exp-share-no-publication', ownerId: 'owner', state: 'stable',
    stableCommittedAt: '2026-01-02T00:00:00.000Z', shareTargets: ['acp'], durable,
    canary: { promotionTimestamp: '2026-01-01T00:00:00.000Z', healthObservationWindow: 2, startupVerified: true, observations: [{ barrierId: 'a' }, { barrierId: 'b' }] },
    decision: { version: 1, kind: 'benefit' },
  };
  const ctx = {
    ...orchestratorContext(), baseUrl: 'file:///tmp/',
    fiber: { state: 2, uid: 1, inject: {}, inertia: undefined, store: {}, await: async () => {} },
    get: (name) => name === 'pluginPackages' ? { packageOf: () => ({ version: '0.2.2-rc.1' }) } : name === 'profileContext' ? { name: 'desktop' } : undefined,
  };
  const orchestrator = new EvolutionOrchestrator(ctx, {
    presetDir: paths.presetDir, pluginRoot: paths.pluginRoot, archiveDir: paths.archiveDir,
    eventBridgePath: paths.eventBridgePath, eventBridgeKey: paths.eventBridgeKey,
    promotionRuntime: { ...unitPromotionRuntime(), capabilities: { entryResolver: true, treeAwait: true, liveRootEntries: true } },
  });
  const shared = await orchestrator.publishCrossEntryPlugin(record, null);
  assert.equal(shared.status, 'failed');
  assert.equal((await readSharedIndex({ dataRoot: paths.presetDir, pluginRoot: paths.pluginRoot })).records.length, 0);
});
