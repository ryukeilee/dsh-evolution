// One autonomous-observer session in its own process.
//
// A restart is only faithful across processes: the target claim protocol proves
// an owner gone through `process.kill(pid, 0)`, so a second session started in
// the same process would see its predecessor's claim as live instead of
// exercising the real reclaim path. `test/autonomous-continuity.test.mjs` runs
// this file twice against one data root to test exactly that.
import path from 'node:path';

import { EvolutionOrchestrator } from '../../lib/orchestrator.js';
import { context } from './runtime-inspect.mjs';

const settings = JSON.parse(process.argv[2] || '{}');
const root = settings.root;
if (typeof root !== 'string' || root.length === 0) throw new Error('autonomous-session needs a data root');

// Two measurements: one that satisfies every evidence gate, and one that is
// honest about not improving anything.
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
const unimproved = {
  ...improved,
  solvesProblem: false,
  performanceChange: 'unchanged',
  errorChange: 'unchanged',
  metrics: {},
  beforeMetrics: {},
  afterMetrics: {},
  benefitEvidence: 'no measurable improvement was observed',
};

const kind = settings.kind === 'unimproved' ? 'unimproved' : settings.kind === 'throwing' ? 'throwing' : 'improved';
const variant = String(settings.variant ?? 'a');

function strategy() {
  if (kind === 'throwing') {
    // The trial itself fails: the code the observer was told to run throws.
    return {
      risk: 'low',
      target: `plugin:broken-${variant}`,
      idPrefix: `broken${variant}`,
      composition: { name: `broken-${variant}`, purpose: 'throw inside the trial', code: { host: 'throw new Error("trial activation failed");' } },
      measure: async () => improved,
    };
  }
  return {
    risk: 'low',
    target: `plugin:fix-${variant}`,
    idPrefix: `fix${variant}`,
    composition: { name: `fix-${variant}`, purpose: 'narrow the failing path', code: { host: `return { variant: "${variant}" };` } },
    measure: async () => (kind === 'unimproved' ? unimproved : improved),
  };
}

const ctx = context();
ctx.logger = { warn() {} };
ctx.dynamicCordisRunner = {
  snapshot: () => [],
  define: () => ({ pluginId: `session-plugin-${process.pid}-${variant}`, packageId: `session-package-${process.pid}-${variant}` }),
  run: async () => ({ ok: true, status: 'active' }),
  stop: async () => ({ ok: true }),
  undefine: async () => ({ ok: true }),
};

const core = new EvolutionOrchestrator(ctx, {
  presetDir: root,
  startupDrift: false,
  eventBridgePath: path.join(root, 'events.jsonl'),
  eventBridgeKey: 'k'.repeat(32),
  driftStatePath: path.join(root, 'drift.json'),
  memoryPath: path.join(root, 'memory.json'),
  patternThreshold: Number(settings.threshold ?? 2),
  mode: settings.mode === 'advisory' ? 'advisory' : 'autonomous',
  unattended: settings.unattended !== false,
  autonomousStrategies: { AGENT_ERROR: strategy() },
});

const exec = { agent: { id: 'continuity-owner' }, signal: new AbortController().signal };
const input = { type: 'agent/error', code: 'AGENT_ERROR', message: settings.message ?? 'provider call failed' };

const phases = [];
for (let round = 0; round < Number(settings.rounds ?? 3); round += 1) {
  const result = await core.observeAutonomous(input, exec);
  phases.push({
    phase: result.phase,
    reason: result.reason ?? null,
    experimentId: result.experimentId ?? null,
    cleanup: result.cleanup?.status ?? null,
    gates: result.gates ? { eligible: result.gates.eligible } : null,
  });
}

process.stdout.write(`${JSON.stringify({
  pid: process.pid,
  phases,
  experiments: [...core.experiments.values()].map((record) => ({ id: record.id, state: record.state })),
  memory: core.memory.data.entries.map((entry) => ({
    status: entry.status,
    strategy: entry.experiment?.strategy ? String(entry.experiment.strategy).slice(0, 12) : null,
    category: entry.result?.category ?? null,
    summary: entry.result?.errorSummary ?? null,
  })),
})}\n`);
