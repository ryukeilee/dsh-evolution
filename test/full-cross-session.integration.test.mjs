import { test, assert, summary, registerCleanup } from './helpers.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mod = await import('file://' + new URL('../lib/orchestrator.js', import.meta.url).pathname);
const bridgeKey = 'test-event-bridge-key-0123456789';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-full-'));
registerCleanup(scratch);
const archiveDir = path.join(scratch, 'archive');
fs.mkdirSync(archiveDir, { recursive: true });
const bridgePath = path.join(scratch, 'events.jsonl');

const measurement = {
  at: '2026-03-01T00:00:00.000Z',
  solvesProblem: true,
  sideEffects: [],
  orphanResources: [],
  performanceChange: 'unchanged',
  errorChange: 'decreased',
  metrics: { latency: 10, errors: 0 },
  beforeMetrics: { latency: 20, errors: 1 },
  afterMetrics: { latency: 10, errors: 0 },
  observationWindow: '1h',
  sampleCount: 2,
  benefitEvidence: 'latency halved',
  repeatable: true,
  regressionPassed: true,
  reversible: true,
  cleanupEvidence: 'dispose verified',
};

const recordA = {
  id: 'exp-full-1',
  ownerId: 'session-a',
  proposal: { owner: 'session-a', why: 'full path', target: 'plugin:y', impactScope: ['runtime'], successMetrics: ['m'], createdAt: '2026-03-01T00:00:00.000Z' },
  state: 'canary-observing',
  runtimeRecovered: true,
  observations: [measurement],
  latestObservation: measurement,
  cleanupProof: { status: 'ok', source: 'disposeTrial', at: '2026-03-01T00:00:00.000Z', stopOk: true, removedOk: true, signatureRecovered: true, errors: [] },
  recoveryProof: { status: 'recovered', source: 'disposeTrial', at: '2026-03-01T00:00:00.000Z', runtimeRecovered: true },
  lastGateEvidence: { eligible: true, runtimeRecovered: true, realBenefit: true },
  durable: { pluginName: 'dsh-evolution-promoted-full1', rowId: 'evolution-promoted-full1', promotionTimestamp: '2026-03-01T00:00:00.000Z', pluginPath: '/tmp/plugin', archivePath: path.join(archiveDir, 'exp-full-1.md') },
  canary: { promotionTimestamp: '2026-03-01T00:00:00.000Z', healthObservationWindow: 2, startupVerified: false, observations: [] },
};

await test('full cross-session: Session A durable write persists everything', async () => {
  const journalSnapshot = mod.snapshotEvidenceFromRecord(recordA);
  assert(journalSnapshot.observations.length === 1, 'journal snapshot carries observation');
  assert(journalSnapshot.durable.pluginName === 'dsh-evolution-promoted-full1', 'journal snapshot carries durable');
  assert(journalSnapshot.recoveryProof.status === 'recovered', 'journal snapshot carries recovery proof');
  const sidecarPath = await mod.persistEvidenceSnapshot(archiveDir, 'exp-full-1', journalSnapshot);
  assert(fs.existsSync(sidecarPath), 'sidecar persisted');
});

await test('full cross-session: Session B hydrate + canary + stable commit keeps evidence', async () => {
  const journalSnapshot = mod.snapshotEvidenceFromRecord(recordA);
  const sidecarPath = await mod.persistEvidenceSnapshot(archiveDir, 'exp-full-1', journalSnapshot);
  const canaryObs = [
    { at: '2026-03-02T00:00:00.000Z', barrierId: 'startup:b', startupVerified: true, componentHealth: 'active', dependenciesPresent: true, metricRegression: false, metrics: {} },
    { at: '2026-03-02T00:00:01.000Z', barrierId: 'barrier-2', startupVerified: true, componentHealth: 'active', dependenciesPresent: true, metricRegression: false, metrics: { runtimeHealthy: 1 } },
  ];
  fs.writeFileSync(bridgePath, JSON.stringify(mod.signEventBridgeEnvelope({
    eventId: 'evolution:canary-passed:exp-full-1',
    eventType: 'canary-passed',
    experimentId: 'exp-full-1',
    canary: { startupVerified: true, observations: canaryObs },
    audit: { at: '2026-03-02T00:00:02.000Z' },
  }, { key: bridgeKey, sequence: 1 })) + '\n');
  const sidecarSnapshot = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  const bridgeSnapshot = await mod.readEventBridgeEvidence(bridgePath, 'exp-full-1', { key: bridgeKey });
  const hydrated = mod.mergeEvidenceSources([sidecarSnapshot, bridgeSnapshot]);
  assert(hydrated.observations.length === 3, 'hydrated observations = measurement + 2 canary');
  assert(hydrated.latestObservation.metrics.latency === 10, 'latest measurement metrics hydrated');
  assert(hydrated.recoveryProof.status === 'recovered', 'recovery proof hydrated');
  assert(hydrated.runtimeRecovered === true, 'runtimeRecovered hydrated');
  assert(hydrated.durable.pluginName === 'dsh-evolution-promoted-full1', 'durable identity hydrated');
  assert(hydrated.gateEvidence.eligible === true, 'gate evidence hydrated');
  // stable commit final snapshot
  const finalSnapshot = {
    ...(hydrated || {}),
    version: 1,
    source: (hydrated?.source || 'stable-commit') + '+stable-commit',
    capturedAt: '2026-03-02T00:00:03.000Z',
    latestObservation: hydrated.latestObservation || sidecarSnapshot.latestObservation || null,
    observations: hydrated.observations?.length ? hydrated.observations : (sidecarSnapshot.observations || []),
    cleanupProof: hydrated.cleanupProof || sidecarSnapshot.cleanupProof || null,
    recoveryProof: hydrated.recoveryProof || sidecarSnapshot.recoveryProof || null,
    runtimeRecovered: true,
    stableCommittedAt: '2026-03-02T00:00:03.000Z',
    gateEvidence: hydrated.gateEvidence || sidecarSnapshot.gateEvidence || null,
    durable: hydrated.durable || sidecarSnapshot.durable || null,
    canary: hydrated.canary || sidecarSnapshot.canary || null,
    ownerId: hydrated.ownerId || sidecarSnapshot.ownerId || null,
    proposal: hydrated.proposal || sidecarSnapshot.proposal || null,
  };
  const finalSidecarPath = await mod.persistEvidenceSnapshot(archiveDir, 'exp-full-1', finalSnapshot);
  const content = mod.renderExperimentArchive({
    id: 'exp-full-1',
    state: 'stable',
    reason: 'stable-commit',
    proposal: recordA.proposal,
    pluginId: 'none',
    packageId: 'none',
    observations: finalSnapshot.observations,
    latestMeasurement: finalSnapshot.latestObservation || {},
    recoveryProof: finalSnapshot.recoveryProof,
    recovered: finalSnapshot.runtimeRecovered === true,
    failure: null,
    memorySignature: 'sig',
    duplicateCount: 1,
    retention: 200,
  });
  const archivePath = path.join(archiveDir, 'exp-full-1.md');
  fs.writeFileSync(archivePath, content);
  const finalArchive = fs.readFileSync(archivePath, 'utf8');
  assert(finalArchive.includes('metrics'), 'archive has metrics key');
  assert(finalArchive.includes('benefitEvidence'), 'archive has benefit evidence key');
  assert(finalArchive.includes('repeatable'), 'archive has repeatable key');
  assert(finalArchive.includes('regressionPassed'), 'archive has regression key');
  assert(finalArchive.includes('reversible'), 'archive has reversible key');
  assert(finalArchive.includes('cleanupEvidence'), 'archive has cleanup evidence key');
  assert(finalArchive.includes('sampleCount'), 'archive has sampleCount key');
  assert(finalArchive.includes('- recovered: true'), 'archive recovered true');
  assert(finalArchive.includes('barrierId'), 'archive has canary observations');
  const finalSidecar = JSON.parse(fs.readFileSync(finalSidecarPath, 'utf8'));
  assert(finalSidecar.observations.length === 3, 'final sidecar observations = 3');
  assert(finalSidecar.durable.pluginName === 'dsh-evolution-promoted-full1', 'final sidecar durable identity');
  assert(finalSidecar.recoveryProof.status === 'recovered', 'final sidecar recovery proof recovered');
});

summary();
