// The event bridge is evidence, not the authority of a lifecycle transition.
//
// `propose`, `trial` and `measure` used to emit their success event through the
// throwing path, *after* the in-memory state had already changed:
//
//   * `propose` inserted the experiment first, so a failed append left the
//     record behind with no experiment id returned (the autonomous observer
//     reports "nothing was proposed" and leaves one orphan per retry);
//   * `trial` left a live Cordis Trial and its target claim behind while the
//     caller was told the Trial failed;
//   * `measure` froze the measurement, then threw; the autonomous observer
//     reverted the successful Trial and, for a non-transient bridge error such
//     as `EIO`, wrote the strategy into durable failure memory as if its
//     measurement had failed.
//
// These tests pin the boundary: an auxiliary event failure is reported on the
// record and in the log, and the transition the caller is entitled to keeps its
// result. The durable promotion success path already behaved this way.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { EvolutionOrchestrator } from '../lib/orchestrator.js';
import {
  HOST_CODE,
  execFor,
  orchestratorContext,
  promotionPaths,
} from './orchestrator-durability-fixtures.mjs';

const BRIDGE_ERROR = 'EIO: event bridge write failed';

/** A bridge that fails only for the event types this case is about. */
function bridge({ fails = () => true } = {}) {
  const emitted = [];
  return {
    emitted,
    emit(type, record) {
      emitted.push(type);
      if (fails(type)) throw new Error(BRIDGE_ERROR);
      return { type, experimentId: record?.id ?? null };
    },
  };
}

function runner() {
  const live = new Set();
  let sequence = 0;
  return {
    snapshot: () => [],
    define: () => {
      sequence += 1;
      const pluginId = `success-event-plugin-${sequence}`;
      live.add(pluginId);
      return { pluginId, packageId: `success-event-package-${sequence}` };
    },
    run: async () => ({ ok: true, status: 'active' }),
    stop: async (_agent, pluginId) => { live.delete(pluginId); return { ok: true }; },
    undefine: async (_agent, pluginId) => { live.delete(pluginId); return { ok: true }; },
    inspectPackage: () => ({ code: { host: HOST_CODE } }),
    live,
  };
}

async function scratch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-success-event-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function create(t, root, config = {}) {
  const warnings = [];
  const ctx = orchestratorContext(warnings);
  const cordis = runner();
  ctx.dynamicCordisRunner = cordis;
  const core = new EvolutionOrchestrator(ctx, {
    ...promotionPaths(root),
    startupDrift: false,
    patternThreshold: 2,
    ...config,
  });
  return { core, ctx, warnings, cordis, exec: execFor() };
}

const proposal = {
  why: 'success event boundary',
  target: 'plugin:success-event',
  impactScope: ['runtime'],
  successMetrics: ['error count'],
};

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
  benefitEvidence: 'error count fell from 1 to 0',
  repeatable: true,
  regressionPassed: true,
  reversible: true,
  cleanupEvidence: 'trial stopped and undefined; runtime fingerprint restored',
};

function autonomousStrategy() {
  return {
    risk: 'low',
    target: 'plugin:success-event',
    composition: { name: 'success-event', purpose: 'prove the bridge is auxiliary', code: { host: 'return {};' } },
    measure: async () => improved,
  };
}

function durableFailures(core) {
  return core.memory.data.entries.filter((entry) => entry.result?.state === 'failed');
}

async function targetClaims(core) {
  try { return await fs.readdir(core.paths.ownershipDir); } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

test('a proposal survives a failed bridge append and keeps its one record', async (t) => {
  const root = await scratch(t);
  const bridgeFailure = bridge();
  const { core, warnings, exec } = create(t, root, { eventBridge: bridgeFailure });

  const result = core.propose(proposal, exec);

  assert.equal(result.ok, true, 'the proposal is reported as created');
  assert.equal(core.experiments.size, 1, 'exactly one experiment exists, not one orphan per attempt');
  const record = core.experiments.get(result.experimentId);
  assert.equal(record.state, 'proposed');
  assert.match(record.eventBridgeWarning, /EIO/);
  assert.match(record.eventBridgeWarningCategory, /\w/);
  assert.match(record.eventBridgeWarningDigest, /^sha256:[0-9a-f]{16}$/);
  assert.equal(warnings.length, 1, 'the failed evidence write is reported once as a redacted warning');
  assert.deepEqual(bridgeFailure.emitted, ['proposal-created']);
});

test('a trial survives a failed bridge append and remains a claimable live trial', async (t) => {
  const root = await scratch(t);
  const bridgeFailure = bridge({ fails: (type) => type === 'trial-completed' });
  const { core, exec } = create(t, root, { eventBridge: bridgeFailure });

  const created = core.propose(proposal, exec);
  const trial = await core.trial({
    experimentId: created.experimentId,
    idPrefix: 'success',
    composition: { name: 'success-event', purpose: 'trial', code: { host: HOST_CODE } },
  }, exec);

  const record = core.experiments.get(created.experimentId);
  assert.equal(trial.ok, true);
  assert.equal(trial.phase, 'trial');
  assert.equal(record.state, 'trial');
  assert.equal(record.targetsAcquired, true, 'the target claim is held by the live trial');
  assert.match(record.eventBridgeWarning, /EIO/);
  assert.equal((await targetClaims(core)).length, 1, 'the live trial still owns its target');

  // The caller was told the trial is live, so the normal cleanup path must own
  // it: reverting releases the runtime and the target claim.
  const reverted = await core.revert({ experimentId: created.experimentId }, exec);
  assert.equal(reverted.ok, true);
  assert.equal(reverted.runtimeRecovered, true);
  assert.deepEqual(await targetClaims(core), [], 'revert releases the claim the trial reported');
});

test('a measurement survives a failed bridge append and keeps its evidence', async (t) => {
  const root = await scratch(t);
  const bridgeFailure = bridge({ fails: (type) => type === 'measurement-completed' });
  const { core, exec } = create(t, root, { eventBridge: bridgeFailure });

  const created = core.propose(proposal, exec);
  await core.trial({
    experimentId: created.experimentId,
    idPrefix: 'success',
    composition: { name: 'success-event', purpose: 'measure', code: { host: HOST_CODE } },
  }, exec);
  const measured = core.measure({ experimentId: created.experimentId, observation: improved }, exec);

  const record = core.experiments.get(created.experimentId);
  assert.equal(measured.ok, true);
  assert.equal(measured.phase, 'measured');
  assert.equal(measured.gates.eligible, true, 'the measurement evidence still decides the gates');
  assert.equal(record.state, 'measured');
  assert.equal(record.latestObservation.benefitEvidence, improved.benefitEvidence);
  assert.match(record.eventBridgeWarning, /EIO/);
  assert.equal(durableFailures(core).length, 0, 'a bridge failure is not a failed measurement');
});

test('the autonomous observer keeps a measured candidate when only the measurement event fails', async (t) => {
  const root = await scratch(t);
  // `proposal-created` and `trial-completed` still reach the bridge; only the
  // measurement event fails, which is the case that used to revert a successful
  // Trial and record a durable strategy failure (`EIO` is not transient).
  const bridgeFailure = bridge({ fails: (type) => type === 'measurement-completed' });
  const { core, exec, warnings } = create(t, root, {
    eventBridge: bridgeFailure,
    autonomousStrategies: { AGENT_ERROR: autonomousStrategy() },
  });
  const input = { type: 'agent/error', code: 'AGENT_ERROR', message: 'provider call failed', target: 'agent' };

  assert.equal((await core.observeAutonomous(input, exec)).phase, 'pattern-observing');
  const result = await core.observeAutonomous(input, exec);

  assert.equal(result.phase, 'candidate-awaiting-confirmation');
  assert.equal(result.automatic, false, 'the observer never approves production itself');
  assert.equal(result.gates.eligible, true);
  assert.equal(result.experimentId, [...core.experiments.keys()][0]);
  const record = core.experiments.get(result.experimentId);
  assert.equal(record.state, 'measured', 'the successful trial is not reverted by a logging failure');
  assert.match(record.eventBridgeWarning, /EIO/);
  assert.equal(durableFailures(core).length, 0, 'the strategy is not suppressed by evidence about the bridge');
  assert.equal((await targetClaims(core)).length, 1, 'the measured candidate still owns its target');
  assert.ok(warnings.some((line) => /measurement-completed emission failed/.test(line)));
});

test('every success event can fail without leaving an orphan proposal or a hidden live trial', async (t) => {
  const root = await scratch(t);
  const bridgeFailure = bridge();
  const { core, exec } = create(t, root, {
    eventBridge: bridgeFailure,
    autonomousStrategies: { AGENT_ERROR: autonomousStrategy() },
  });
  const input = { type: 'agent/error', code: 'AGENT_ERROR', message: 'provider call failed', target: 'agent' };

  assert.equal((await core.observeAutonomous(input, exec)).phase, 'pattern-observing');
  const result = await core.observeAutonomous(input, exec);

  assert.equal(result.phase, 'candidate-awaiting-confirmation');
  assert.equal(core.experiments.size, 1, 'one hypothesis owns one measured experiment, not a trail of orphans');
  const [record] = core.experiments.values();
  assert.equal(record.state, 'measured');
  assert.deepEqual(bridgeFailure.emitted, [
    'proposal-created',
    'trial-completed',
    'measurement-completed',
  ], 'all three auxiliary writes were attempted and contained');
  assert.equal(durableFailures(core).length, 0);
});

test('a throwing or rejecting logger cannot replace a completed transition', async (t) => {
  const root = await scratch(t);
  const failures = [
    { name: 'throws', warn() { throw new Error('logger failed'); } },
    { name: 'rejects', warn() { return Promise.reject(new Error('logger failed')); } },
    { name: 'unreadable', get warn() { throw new Error('logger failed'); } },
  ];
  for (const logger of failures) {
    const directory = path.join(root, logger.name);
    await fs.mkdir(directory, { recursive: true });
    const { core, ctx, exec } = create(t, directory, { eventBridge: bridge() });
    ctx.logger = logger;
    const result = core.propose(proposal, exec);
    assert.equal(result.ok, true, logger.name);
    assert.equal(core.experiments.size, 1, logger.name);
    assert.match(core.experiments.get(result.experimentId).eventBridgeWarning, /EIO/, logger.name);
    await new Promise((resolve) => setImmediate(resolve));
  }
});
