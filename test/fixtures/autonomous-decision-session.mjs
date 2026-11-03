// One autonomous-observer session on the real official domain store.
//
// The decision reservation this file exercises is durable, and its leak is only
// visible across a real process boundary: the Trial the reservation described is
// mounted in the process that took it, and the target claim it holds is proved
// gone through `process.kill(pid, 0)`. A second session started in the same
// process would see its predecessor's claim as live instead of exercising the
// real reclaim path, so `test/autonomous-decision-recovery.test.mjs` runs this
// file once per session against one data root.
//
// `seed: true` takes the reservation and observes nothing, which is the state a
// process leaves behind when it ends between "take the decision" and "the Trial
// ran". `rounds` then observes the same fault that many times.
import path from 'node:path';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';

import { openDomainStorage } from '../../lib/domain-storage.js';
import { apply } from '../../lib/registration.js';
import { context } from './runtime-inspect.mjs';

const settings = JSON.parse(process.argv[2] || '{}');
const root = settings.root;
if (typeof root !== 'string' || root.length === 0) throw new Error('autonomous-decision-session needs a data root');

const improved = {
  solvesProblem: true,
  sideEffects: [],
  orphanResources: [],
  performanceChange: 'decreased',
  errorChange: 'decreased',
  metrics: { errCount: 0 },
  beforeMetrics: { errCount: 1 },
  afterMetrics: { errCount: 0 },
  observationWindow: '1h',
  sampleCount: 2,
  benefitEvidence: 'error count fell from 1 to 0 over the window',
  repeatable: true,
  regressionPassed: true,
  reversible: true,
  cleanupEvidence: 'trial stopped and undefined; runtime fingerprint restored',
};

const variant = String(settings.variant ?? 'a');
const declaration = {
  risk: 'low',
  target: `plugin:fix-${variant}`,
  idPrefix: `fix${variant}`,
  composition: { name: `fix-${variant}`, purpose: 'narrow the failing path', code: { host: `return { variant: "${variant}" };` } },
  measure: async () => improved,
};

const backend = new JsonStorageBackend(path.join(root, 'official'));
const ctx = {
  ...context(),
  emit() {},
  effect() {},
  logger: { warn() {} },
  storage: { backend: { get: () => backend } },
  dynamicCordisRunner: {
    snapshot: () => [],
    define: () => ({ pluginId: `session-plugin-${process.pid}-${variant}`, packageId: `session-package-${process.pid}-${variant}` }),
    run: async () => ({ ok: true, status: 'active' }),
    stop: async () => ({ ok: true }),
    undefine: async () => ({ ok: true }),
  },
  systemPrompt: { section() {} },
};
ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });

const config = {
  presetDir: root,
  startupDrift: false,
  eventBridgePath: path.join(root, 'events.jsonl'),
  eventBridgeKey: 'b'.repeat(64),
  driftStatePath: path.join(root, 'drift.json'),
  memoryPath: path.join(root, 'memory.json'),
  patternThreshold: Number(settings.threshold ?? 2),
  mode: 'autonomous',
  unattended: true,
  autonomousStrategies: { AGENT_ERROR: declaration },
  ...(settings.cleanupRecoveryCooldownMs === undefined ? {} : { cleanupRecoveryCooldownMs: settings.cleanupRecoveryCooldownMs }),
};

const port = await openDomainStorage(ctx, config);
const core = apply(ctx, { ...config, domainStorage: port });
const exec = { agent: { id: 'decision-owner' }, signal: new AbortController().signal };
const input = { type: 'agent/error', code: 'AGENT_ERROR', message: settings.message ?? 'provider call failed' };
const identity = `${core.patternKey(input)}:${core.strategyFingerprint(declaration)}`;

// Read before any observation: this is the state the port opened on. The read is
// optional so this file can also drive the pre-fix port, where the inherited
// reservations are not observable at all.
const inherited = typeof port.autonomousDecisions === 'function' ? await port.autonomousDecisions() : [];
const seeded = settings.seed === true ? await port.reserveAutonomousDecision(identity) : null;

const phases = [];
for (let round = 0; round < Number(settings.rounds ?? 1); round += 1) {
  const result = await core.observeAutonomous(input, exec);
  phases.push({
    phase: result.phase,
    reason: result.reason ?? null,
    experimentId: result.experimentId ?? null,
    decisionRecovery: result.decisionRecovery ?? null,
    cleanup: result.cleanup?.status ?? null,
    gates: result.gates ? { eligible: result.gates.eligible } : null,
  });
}

await port.close();
await backend.close();

process.stdout.write(`${JSON.stringify({
  pid: process.pid,
  identity,
  inherited,
  seeded,
  phases,
  experiments: [...core.experiments.values()].map(record => ({ id: record.id, state: record.state })),
  suppressed: core.suppressedPatterns.size,
})}\n`);
