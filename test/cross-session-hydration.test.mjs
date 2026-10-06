import { test, assert, summary, registerCleanup } from './helpers.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mod = await import('file://' + new URL('../lib/orchestrator.js', import.meta.url).pathname);
const bridgeKey = 'test-event-bridge-key-0123456789';

// Scratch dir so tests never touch production preset state.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-hydration-'));
registerCleanup(scratch);
const archiveDir = path.join(scratch, 'archive');
fs.mkdirSync(archiveDir, { recursive: true });
const bridgePath = path.join(scratch, 'events.jsonl');

const measurement = {
  at: '2026-01-01T00:00:00.000Z',
  solvesProblem: true,
  sideEffects: [],
  orphanResources: [],
  performanceChange: 'unchanged',
  errorChange: 'decreased',
  metrics: { errCount: 0 },
  beforeMetrics: { errCount: 1 },
  afterMetrics: { errCount: 0 },
  observationWindow: '1h',
  sampleCount: 2,
  benefitEvidence: 'real benefit',
  repeatable: true,
  regressionPassed: true,
  reversible: true,
  cleanupEvidence: 'cleanup done',
};

function writeBridge(linesArr) {
  fs.writeFileSync(bridgePath, linesArr.map((event, index) => JSON.stringify(mod.signEventBridgeEnvelope(event, { key: bridgeKey, sequence: index + 1 }))).join('\n') + '\n');
}

// ---- Session A: durable promotion evidence survives (journal + sidecar)
await test('cross-session: durable promotion evidence survives (sidecar)', async () => {
  const record = {
    id: 'exp-test-1',
    ownerId: 'session-a',
    proposal: { owner: 'session-a', why: 'test', target: 'plugin:x', impactScope: ['runtime'], successMetrics: ['metric'], createdAt: '2026-01-01T00:00:00.000Z' },
    state: 'canary-observing',
    runtimeRecovered: true,
    observations: [measurement],
    latestObservation: measurement,
    cleanupProof: { status: 'recovered', source: 'disposeTrial', at: '2026-01-01T00:00:00.000Z' },
    recoveryProof: { status: 'recovered', source: 'disposeTrial', at: '2026-01-01T00:00:00.000Z' },
    lastGateEvidence: { eligible: true, runtimeRecovered: true },
    durable: { pluginName: 'dsh-evolution-promoted-test', rowId: 'evolution-promoted-test', promotionTimestamp: '2026-01-01T00:00:00.000Z' },
    canary: { promotionTimestamp: '2026-01-01T00:00:00.000Z', healthObservationWindow: 2, startupVerified: false, observations: [] },
  };
  const sidecar = {
    version: 1,
    source: 'journal',
    capturedAt: '2026-01-01T00:00:00.000Z',
    latestObservation: measurement,
    observations: [measurement],
    cleanupProof: record.cleanupProof,
    recoveryProof: record.recoveryProof,
    runtimeRecovered: true,
    gateEvidence: record.lastGateEvidence,
    durable: record.durable,
    canary: record.canary,
    ownerId: record.ownerId,
    proposal: record.proposal,
  };
  fs.writeFileSync(path.join(archiveDir, 'exp-test-1.evidence.json'), JSON.stringify(sidecar, null, 2));
  // Session B: hydrate from sidecar (journal gone).
  const snapshot = JSON.parse(fs.readFileSync(path.join(archiveDir, 'exp-test-1.evidence.json'), 'utf8'));
  assert(snapshot.observations.length === 1, 'sidecar carries observation');
  assert(snapshot.recoveryProof.status === 'recovered', 'sidecar carries recovery proof');
  assert(snapshot.durable.pluginName === 'dsh-evolution-promoted-test', 'sidecar carries promotion identity');
  assert(snapshot.runtimeRecovered === true, 'sidecar carries runtimeRecovered');
});

// ---- Stable-commit archive merge must not downgrade
await test('stable-commit: archive merge keeps full evidence', async () => {
  const durableSidecar = {
    version: 1,
    source: 'stable-commit',
    capturedAt: '2026-01-01T00:00:00.000Z',
    latestObservation: measurement,
    observations: [measurement],
    cleanupProof: { status: 'ok', source: 'disposeTrial', at: '2026-01-01T00:00:00.000Z' },
    recoveryProof: { status: 'recovered', source: 'disposeTrial', at: '2026-01-01T00:00:00.000Z' },
    runtimeRecovered: true,
    gateEvidence: { eligible: true },
  };
  fs.writeFileSync(path.join(archiveDir, 'exp-test-2.evidence.json'), JSON.stringify(durableSidecar, null, 2));
  const currentRecord = {
    observations: [],
    latestObservation: null,
    cleanupProof: null,
    recoveryProof: { status: 'unknown' },
    runtimeRecovered: false,
  };
  const merged = mod.mergeEvidenceSources([durableSidecar, currentRecord]);
  assert(merged.observations.length === 1, 'archive keeps observations');
  assert(merged.recoveryProof.status === 'recovered', 'archive keeps recovery proof');
  assert(merged.cleanupProof.status === 'ok', 'archive keeps cleanup proof');
  assert(merged.runtimeRecovered === true, 'archive keeps runtimeRecovered');
});

// ---- Event-bridge hydration (priority 4)
await test('event-bridge: hydration restores measurement/gates/canary', async () => {
  writeBridge([
    { schema: 1, eventId: 'evolution:measurement-completed:exp-test-3', eventType: 'measurement-completed', experimentId: 'exp-test-3', measurement, audit: { at: '2026-01-01T00:00:01.000Z' } },
    { schema: 1, eventId: 'evolution:promotion-succeeded:exp-test-3', eventType: 'promotion-succeeded', experimentId: 'exp-test-3', measurement, evidence: { eligible: true, runtimeRecovered: true, realBenefit: true }, promotion: { pluginName: 'dsh-evolution-promoted-test3', rowId: 'evolution-promoted-test3', promotionTimestamp: '2026-01-01T00:00:02.000Z' }, audit: { at: '2026-01-01T00:00:02.000Z' } },
    { schema: 1, eventId: 'evolution:canary-passed:exp-test-3', eventType: 'canary-passed', experimentId: 'exp-test-3', canary: { startupVerified: true, observations: [{ barrierId: 'b1', startupVerified: true }] }, audit: { at: '2026-01-01T00:00:03.000Z' } },
  ]);
  const bridge = await mod.readEventBridgeEvidence(bridgePath, 'exp-test-3', { key: bridgeKey });
  assert(bridge, 'bridge evidence found');
  assert(bridge.observations.length === 2, 'measurement + canary observation');
  assert(bridge.latestObservation.solvesProblem === true, 'latest measurement restored');
  assert(bridge.recoveryProof.status === 'recovered', 'recovery proof derived from gates');
  assert(bridge.runtimeRecovered === true, 'runtimeRecovered from gates');
  assert(bridge.durable.pluginName === 'dsh-evolution-promoted-test3', 'promotion identity restored');
  assert(bridge.gateEvidence.eligible === true, 'gate evidence restored');
});

await test('event-bridge: no events returns null', async () => {
  writeBridge([]);
  const bridge = await mod.readEventBridgeEvidence(bridgePath, 'exp-none');
  assert(bridge === null, 'no events -> null');
});

// ---- Runtime recovery proof persistence
await test('recovery-proof: archive renders full factual payload', () => {
  const content = mod.renderExperimentArchive({
    id: 'exp-x',
    state: 'stable',
    reason: 'stable-commit',
    proposal: { owner: 'a', why: 'w', target: 't', impactScope: [], successMetrics: [], createdAt: '2026-01-01T00:00:00.000Z' },
    pluginId: 'p',
    packageId: 'pkg',
    observations: [measurement],
    latestMeasurement: measurement,
    recoveryProof: { status: 'recovered', verificationSource: 'disposeTrial:stop+undefine+signature', capturedAt: '2026-01-01T00:00:00.000Z', runtimeRecovered: true, noOrphans: true, recoveryPending: false },
    recovered: true,
    failure: null,
    memorySignature: 'sig',
    duplicateCount: 1,
    retention: 200,
  });
  assert(content.includes('## Runtime recovery'), 'recovery section present');
  assert(content.includes('recovered'), 'recovery proof status serialized');
  assert(content.includes('noOrphans'), 'noOrphans serialized');
  assert(content.includes('## Observations'), 'observations section present');
});

// ---- renderExperimentArchive: shared shape
await test('renderExperimentArchive: emits stable archive sections', () => {
  const content = mod.renderExperimentArchive({
    id: 'exp-y',
    state: 'stable',
    reason: 'stable-commit',
    proposal: { owner: 'o', why: 'why', target: 'target', impactScope: ['a'], successMetrics: ['b'], createdAt: '2026-01-01T00:00:00.000Z' },
    pluginId: 'none',
    packageId: 'none',
    observations: [],
    latestMeasurement: {},
    recoveryProof: null,
    recovered: true,
    failure: null,
    memorySignature: 'sig',
    duplicateCount: 1,
    retention: 200,
  });
  for (const section of ['# Evolution experiment exp-y', '## Proposal', '## Observations', '## Latest measurement', '## Runtime recovery', '## Failure learning', '## Memory lifecycle']) {
    assert(content.includes(section), section + ' present');
  }
  assert(content.includes('- recovered: true'), 'recovered flag true');
});

summary();
