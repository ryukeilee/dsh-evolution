// A stable commit writes its evidence sidecar before it publishes the adopted
// conclusion and the `canary-passed` promotion fact. A crash in that window
// leaves a durable stable plugin whose shared experience has no success fact,
// so `evolution_plan` keeps proposing a target that was already resolved.
//
// The recovery is a bounded startup reconciliation from the same durable
// sidecar: the conclusion is idempotent (its event id is derived from the
// experiment, decision and applicability), so repeating it is a no-op.
//
// Synthetic fixtures only (os.tmpdir()); no real DSH home is read or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  EvolutionOrchestrator,
  mergeEvidenceSources,
  snapshotEvidenceFromRecord,
  hydrateRecordFromSnapshot,
} from '../lib/orchestrator.js';
import { openSharedExperience } from '../lib/shared-experience.js';
import { strategyFingerprint } from '../lib/experience-plan.js';
import {
  scratchRoot,
  promotionPaths,
  orchestratorContext,
  unitPromotionRuntime,
} from './orchestrator-durability-fixtures.mjs';

const APPLICABILITY = Object.freeze({ dsh: '0.2.2-rc.5', cordis: '4.1.0', evolution: '0.2.20' });
const HOST_VERSIONS = Object.freeze({ host: APPLICABILITY.dsh, cordis: APPLICABILITY.cordis, evolution: APPLICABILITY.evolution });
const TARGET = 'tool:edge-cache';
const STRATEGY = 'prewarm the cache before the first read';

function stableSnapshot(experimentId, overrides = {}) {
  return {
    version: 1,
    capturedAt: '2026-11-24T00:00:00.000Z',
    stableCommittedAt: '2026-11-24T00:00:05.000Z',
    runtimeRecovered: true,
    proposal: {
      why: 'stable commit survived the crash',
      target: TARGET,
      strategy: STRATEGY,
      strategyFingerprint: strategyFingerprint(TARGET, STRATEGY),
      applicability: APPLICABILITY,
      owner: 'recovery-owner',
      createdAt: '2026-11-24T00:00:00.000Z',
    },
    composition: { name: 'edge-cache-prewarm', purpose: 'prewarm', hostSha256: 'a'.repeat(64) },
    durable: { pluginName: 'dsh-evolution-promoted-aaaaaaaaaaaa', rowId: 'evolution-promoted-aaaaaaaaaaaa', adapter: 'official-include' },
    canary: { healthObservationWindow: 2, startupVerified: true, observations: [{ barrierId: 'startup:owner' }] },
    latestObservation: {
      at: '2026-11-24T00:00:04.000Z',
      solvesProblem: true,
      beforeMetrics: { successRate: 0.5, errorCount: 2 },
      afterMetrics: { successRate: 1, errorCount: 0 },
      probe: { comparison: { benefit: true, regression: false, beforeMetrics: { successRate: 0.5, errorCount: 2 }, afterMetrics: { successRate: 1, errorCount: 0 } } },
    },
    observations: [],
    decision: { version: 1, kind: 'benefit', source: 'canary-passed', at: '2026-11-24T00:00:05.000Z' },
    ownerId: 'recovery-owner',
    ...overrides,
  };
}

async function recoveryFixture(t, name, snapshots, { versions = HOST_VERSIONS } = {}) {
  const root = await scratchRoot(name);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const paths = promotionPaths(root);
  paths.promotionRuntime = unitPromotionRuntime();
  await fsp.mkdir(paths.archiveDir, { recursive: true });
  await fsp.writeFile(paths.compositionPath, '[]\n');
  for (const [experimentId, snapshot] of Object.entries(snapshots)) {
    await fsp.writeFile(path.join(paths.archiveDir, `${experimentId}.evidence.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
  }
  const store = openSharedExperience(path.join(root, 'shared-experience'));
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  const orchestrator = new EvolutionOrchestrator(orchestratorContext(), {
    ...paths,
    sharedExperience: store,
    runtimeVersions: versions,
    eventBridge: { emit: () => ({ audit: { at: '2026-11-24T00:00:05.000Z' } }) },
  });
  return { root, paths, store, orchestrator };
}

test('a bounded startup reconciliation publishes the adopted conclusion a stable crash left behind', async (t) => {
  const experimentId = 'exp-stable-crash-1';
  const { store, orchestrator } = await recoveryFixture(t, 'stable-conclusion-recovery', {
    [experimentId]: stableSnapshot(experimentId),
  });
  const result = await orchestrator.reconcileStableConclusions({ maxRecords: 20 });
  assert.equal(result.scanned, 1);
  assert.equal(result.published, 1);
  assert.deepEqual(result.failed, []);

  const found = store.findConclusions({
    target: TARGET,
    strategyFingerprint: strategyFingerprint(TARGET, STRATEGY),
    applicability: APPLICABILITY,
  });
  assert.equal(found.best?.decision, 'adopted');
  assert.equal(found.best?.sameApplicability, true);
  assert.equal(found.best?.lastSeen, '2026-11-24T00:00:05.000Z');
  const row = store.discover({ window: 10 }).records.find((record) => record.issueType === 'experiment-conclusion');
  assert.ok(row, 'the conclusion is a canonical knowledge row');
  assert.equal(row.metrics.successratedelta.last, 0.5);
  assert.equal(row.metrics.errorsdelta.last, -2);
});

test('the reconciliation is idempotent across starts', async (t) => {
  const experimentId = 'exp-stable-crash-2';
  const { store, orchestrator } = await recoveryFixture(t, 'stable-conclusion-idempotent', {
    [experimentId]: stableSnapshot(experimentId),
  });
  await orchestrator.reconcileStableConclusions({ maxRecords: 20 });
  const before = store.stats();
  const second = await orchestrator.reconcileStableConclusions({ maxRecords: 20 });
  assert.equal(second.published, 0);
  assert.equal(second.duplicates, 1);
  assert.deepEqual(store.stats(), before, 'a repeated reconciliation writes nothing');
});

test('the recovered conclusion keeps the measured applicability after a host upgrade', async (t) => {
  const experimentId = 'exp-stable-upgraded';
  const upgraded = { host: '0.2.3-rc.1', cordis: '4.2.0', evolution: '0.2.20' };
  const { store, orchestrator } = await recoveryFixture(t, 'stable-conclusion-upgraded', {
    [experimentId]: stableSnapshot(experimentId),
  }, { versions: upgraded });
  await orchestrator.reconcileStableConclusions({ maxRecords: 20 });
  const old = store.findConclusions({
    target: TARGET,
    strategyFingerprint: strategyFingerprint(TARGET, STRATEGY),
    applicability: APPLICABILITY,
  });
  assert.equal(old.best?.decision, 'adopted');
  assert.equal(old.best?.sameApplicability, true);
  const live = store.findConclusions({
    target: TARGET,
    strategyFingerprint: strategyFingerprint(TARGET, STRATEGY),
    applicability: { dsh: upgraded.host, cordis: upgraded.cordis, evolution: upgraded.evolution },
  });
  assert.equal(live.matches.some((row) => row.sameApplicability === true), false,
    'the recovery must not claim the strategy was adopted under versions it never ran on');
});

test('a probe-only sidecar keeps the measured applicability too', async (t) => {
  const experimentId = 'exp-stable-probe-only';
  const snapshot = stableSnapshot(experimentId);
  delete snapshot.proposal.applicability;
  snapshot.latestObservation.probe.versions = APPLICABILITY;
  const { store, orchestrator } = await recoveryFixture(t, 'stable-conclusion-probe-only', { [experimentId]: snapshot });
  const result = await orchestrator.reconcileStableConclusions({ maxRecords: 20 });
  assert.equal(result.published, 1);
  const found = store.findConclusions({
    target: TARGET,
    strategyFingerprint: strategyFingerprint(TARGET, STRATEGY),
    applicability: APPLICABILITY,
  });
  assert.equal(found.best?.sameApplicability, true);
});

test('a record without a captured applicability is not relabelled with the live versions', async (t) => {
  const experimentId = 'exp-stable-legacy';
  const snapshot = stableSnapshot(experimentId);
  delete snapshot.proposal.applicability;
  const { store, orchestrator } = await recoveryFixture(t, 'stable-conclusion-legacy', { [experimentId]: snapshot });
  const result = await orchestrator.reconcileStableConclusions({ maxRecords: 20 });
  assert.equal(result.published, 0);
  assert.equal(result.skipped.some((row) => row.experimentId === experimentId && row.reason === 'no-applicability'), true);
  assert.equal(store.stats().knowledge, 0);
});

test('a non-benefit or non-stable sidecar is not adopted', async (t) => {
  const { store, orchestrator } = await recoveryFixture(t, 'stable-conclusion-not-stable', {
    'exp-not-stable': stableSnapshot('exp-not-stable', { stableCommittedAt: null }),
    'exp-not-benefit': stableSnapshot('exp-not-benefit', { decision: { version: 1, kind: 'insufficient-evidence' } }),
  });
  const result = await orchestrator.reconcileStableConclusions({ maxRecords: 20 });
  assert.equal(result.published, 0);
  assert.equal(store.stats().knowledge, 0);
});

test('the snapshot carries the composition name across restart so the fallback identity is stable', async (t) => {
  const record = {
    id: 'exp-stable-composition',
    composition: { name: 'edge-cache-prewarm', purpose: 'prewarm', hostSha256: 'a'.repeat(64) },
    proposal: { target: TARGET, applicability: APPLICABILITY },
    observations: [],
    latestObservation: null,
    decision: { version: 1, kind: 'benefit', source: 'canary-passed' },
    stableCommittedAt: '2026-11-24T00:00:05.000Z',
  };
  const snapshot = snapshotEvidenceFromRecord(record);
  assert.deepEqual(snapshot.composition, record.composition);
  const merged = mergeEvidenceSources([snapshot]);
  assert.deepEqual(merged.composition, record.composition);
  const hydrated = hydrateRecordFromSnapshot({ id: record.id }, merged);
  assert.deepEqual(hydrated.composition, record.composition);
  assert.equal(Object.hasOwn(snapshotEvidenceFromRecord({ id: 'legacy' }), 'composition'), false);
});
