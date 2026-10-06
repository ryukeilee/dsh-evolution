import { test, assert, summary, registerCleanup } from './helpers.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mod = await import('file://' + new URL('../lib/orchestrator.js', import.meta.url).pathname);
const bridgeKey = 'test-event-bridge-key-0123456789';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-recovery-'));
registerCleanup(scratch);
const archiveDir = path.join(scratch, 'archive');
fs.mkdirSync(archiveDir, { recursive: true });
const bridgePath = path.join(scratch, 'events.jsonl');

// ---- Evidence upgrade regression: old archive unknown -> recovered
await test('upgrade: archive replay upgrades unknown recovery to recovered', async () => {
  // Old archive (pre-fix): empty observations + unknown recovery proof.
  const oldArchive = [
    '# Evolution experiment exp-upgrade-1',
    '',
    '- state: stable',
    '- terminal reason: stable-commit',
    '- owner: session-a',
    '- created: 2026-01-01T00:00:00.000Z',
    '- source package: none/none',
    '',
    '## Proposal',
    '- why: make something durable',
    '- target: plugin:x',
    '- impact: runtime',
    '- success metrics: metric',
    '',
    '## Observations',
    '```json',
    '[]',
    '```',
    '',
    '## Latest measurement',
    '```json',
    '{}',
    '```',
    '',
    '## Runtime recovery',
    '- recovered: true',
    '- proof: {"status":"unknown"}',
    '',
    '## Failure learning',
    '```json',
    '{"status":"none"}',
    '```',
    '',
    '## Memory lifecycle',
    '- signature: sig123',
    '- duplicate count: 1',
    '- retention: bounded to 200 compact records',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(archiveDir, 'exp-upgrade-1.md'), oldArchive);
  // Event bridge carries the real measurement + promotion with recovered gates.
  const measurement = {
    at: '2026-01-01T00:00:01.000Z',
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
    benefitEvidence: 'benefit',
    repeatable: true,
    regressionPassed: true,
    reversible: true,
    cleanupEvidence: 'cleanup',
  };
  fs.writeFileSync(bridgePath, JSON.stringify(mod.signEventBridgeEnvelope({
    eventId: 'evolution:promotion-succeeded:exp-upgrade-1',
    eventType: 'promotion-succeeded',
    experimentId: 'exp-upgrade-1',
    measurement,
    evidence: { eligible: true, runtimeRecovered: true },
    promotion: { pluginName: 'dsh-evolution-promoted-up1', rowId: 'evolution-promoted-up1', promotionTimestamp: '2026-01-01T00:00:02.000Z' },
    audit: { at: '2026-01-01T00:00:02.000Z' },
  }, { key: bridgeKey, sequence: 1 })) + '\n');
  // Replay through the formal path.
  const result = await mod.replayExperimentEvidence({ archiveDir, eventBridgePath: bridgePath, eventBridgeKey: bridgeKey }, 'exp-upgrade-1');
  assert(result.observations >= 1, 'replay restored observations');
  assert(result.recovered === true, 'replay restored recovered flag');
  const regenerated = fs.readFileSync(path.join(archiveDir, 'exp-upgrade-1.md'), 'utf8');
  assert(!regenerated.includes('"status":"unknown"'), 'archive no longer shows unknown recovery proof');
  assert(regenerated.includes('"status":"recovered"'), 'archive shows recovered proof');
  assert(regenerated.includes('"sampleCount": 2'), 'sampleCount preserved');
  assert(regenerated.includes('"benefitEvidence": "benefit"'), 'benefit evidence preserved');
  // Sidecar persisted for future sessions.
  const sidecar = JSON.parse(fs.readFileSync(path.join(archiveDir, 'exp-upgrade-1.evidence.json'), 'utf8'));
  assert(sidecar.observations.length === 1, 'sidecar observations persisted');
  assert(sidecar.recoveryProof.status === 'recovered', 'sidecar recovery proof persisted');
  assert(sidecar.runtimeRecovered === true, 'sidecar runtimeRecovered persisted');
  assert(sidecar.durable.pluginName === 'dsh-evolution-promoted-up1', 'sidecar promotion identity persisted');
});

// ---- Restart/recovery: sidecar survives, archive keeps all evidence
await test('restart: sidecar hydration after journal deletion keeps evidence', async () => {
  const measurement = {
    at: '2026-02-01T00:00:00.000Z',
    solvesProblem: true,
    sideEffects: [],
    orphanResources: [],
    performanceChange: 'unchanged',
    errorChange: 'decreased',
    metrics: { x: 0 },
    beforeMetrics: { x: 2 },
    afterMetrics: { x: 0 },
    observationWindow: '2h',
    sampleCount: 3,
    benefitEvidence: 'b',
    repeatable: true,
    regressionPassed: true,
    reversible: true,
    cleanupEvidence: 'c',
  };
  // Session A writes the sidecar (as writeDurablePromotion would).
  const sidecar = {
    version: 1,
    source: 'journal',
    capturedAt: '2026-02-01T00:00:00.000Z',
    latestObservation: measurement,
    observations: [measurement],
    cleanupProof: { status: 'ok', source: 'disposeTrial' },
    recoveryProof: { status: 'recovered', source: 'disposeTrial' },
    runtimeRecovered: true,
    gateEvidence: { eligible: true },
    durable: { pluginName: 'dsh-evolution-promoted-r2', rowId: 'evolution-promoted-r2', promotionTimestamp: '2026-02-01T00:00:00.000Z' },
    canary: { startupVerified: true, observations: [] },
    ownerId: 'session-a',
    proposal: { owner: 'session-a', why: 'w', target: 't', impactScope: [], successMetrics: [], createdAt: '2026-02-01T00:00:00.000Z' },
  };
  fs.writeFileSync(path.join(archiveDir, 'exp-restart-2.evidence.json'), JSON.stringify(sidecar, null, 2));
  // Session B: journal deleted; hydrate from sidecar + empty in-memory record.
  const merged = mod.mergeEvidenceSources([
    null,
    JSON.parse(fs.readFileSync(path.join(archiveDir, 'exp-restart-2.evidence.json'), 'utf8')),
    null,
  ]);
  assert(merged.observations.length === 1, 'observations hydrated');
  assert(merged.latestObservation.sampleCount === 3, 'latest measurement hydrated');
  assert(merged.recoveryProof.status === 'recovered', 'recovery proof hydrated');
  assert(merged.runtimeRecovered === true, 'runtimeRecovered hydrated');
  assert(merged.durable.pluginName === 'dsh-evolution-promoted-r2', 'promotion identity hydrated');
  assert(merged.canary.startupVerified === true, 'canary hydrated');
  assert(merged.ownerId === 'session-a', 'ownerId hydrated');
  assert(merged.gateEvidence.eligible === true, 'gate evidence hydrated');
});

summary();
