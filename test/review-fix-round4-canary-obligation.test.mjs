// A context-policy canary carries a durable functional-check obligation. A
// startup health replay can fill the numeric window but must never satisfy that
// obligation; only a matching functional observation may commit stable.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { EvolutionOrchestrator, persistEvidenceSnapshot } from '../lib/orchestrator.js';
import {
  scratchRoot, promotionPaths, unitPromotionRuntime, orchestratorContext, execFor, exists, HOST_CODE,
} from './orchestrator-durability-fixtures.mjs';
import { promotionPlan, derivedPluginName, derivedPluginPath } from './promotion-plan-fixture.mjs';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const EXPERIMENT = 'exp-round4-canary';
const OWNER = 'round4-canary-owner';
const TARGET = 'plugin:round4-canary';
const BINDING = sha256('round4-functional-check');

function canaryConfig(root) {
  return {
    presetDir: root,
    startupDrift: false,
    eventBridge: { emit: () => ({}) },
    eventBridgePath: path.join(root, 'events.jsonl'),
    eventBridgeKey: 'k'.repeat(32),
    driftStatePath: path.join(root, 'drift.json'),
    memoryPath: path.join(root, 'memory.json'),
    promotionRuntime: unitPromotionRuntime(),
  };
}

async function scene(t, { verification = null, observations = [], window = 2 } = {}) {
  const root = await scratchRoot('round4-canary-obligation');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const ctx = orchestratorContext();
  ctx.dynamicCordisRunner = { snapshot: () => [] };
  const core = new EvolutionOrchestrator(ctx, canaryConfig(root));
  const pluginPath = derivedPluginPath(core.paths, EXPERIMENT);
  const durable = {
    pluginName: derivedPluginName(EXPERIMENT), pluginPath,
    rowId: 'evolution-promoted-round4', archivePath: path.join(core.paths.archiveDir, `${EXPERIMENT}.md`),
    presetId: 'evolution', promotionTimestamp: '2026-01-01T00:00:00.000Z',
  };
  await fsp.mkdir(core.paths.promotionStateDir, { recursive: true });
  await fsp.mkdir(core.paths.archiveDir, { recursive: true });
  await persistEvidenceSnapshot(core.paths.archiveDir, EXPERIMENT, {
    version: 1, source: 'test-sidecar', capturedAt: '2026-01-02T00:00:00.000Z',
    observations: [{ solvesProblem: true }],
    latestObservation: { solvesProblem: true, regressionPassed: true },
    cleanupProof: { status: 'recovered' }, recoveryProof: { status: 'recovered' },
    runtimeRecovered: true, durable,
    canary: { promotionTimestamp: '2026-01-01T00:00:00.000Z', healthObservationWindow: 2, startupVerified: true, observations: [] },
    ownerId: OWNER, proposal: { owner: OWNER, why: 'canary', target: TARGET, impactScope: ['runtime'], successMetrics: ['m'], createdAt: '2026-01-01T00:00:00.000Z' },
  });
  await fsp.writeFile(path.join(core.paths.promotionStateDir, 'journal.json'), JSON.stringify({
    version: 1, phase: 'canary-observing', experimentId: EXPERIMENT, ownerId: OWNER,
    proposal: { owner: OWNER, why: 'canary', target: TARGET, impactScope: ['runtime'], successMetrics: ['m'], createdAt: '2026-01-01T00:00:00.000Z' },
    targets: [TARGET], stateDir: core.paths.promotionStateDir,
    stageDir: path.join(core.paths.promotionStateDir, 'stage'),
    records: promotionPlan(core.paths, EXPERIMENT), durable,
    canary: {
      promotionTimestamp: '2026-01-01T00:00:00.000Z', healthObservationWindow: window,
      startupVerified: true, observations,
      ...(verification ? { verification } : {}),
    },
  }, null, 2));
  return { root, core };
}

const functional = (id, binding = BINDING) => ({
  experimentId: EXPERIMENT, startupVerified: true, componentHealth: 'active',
  dependenciesPresent: true, metricRegression: false, verificationKind: 'functional',
  barrier: { id, reached: true },
  evidence: { functionalCheck: { tool: 'read', matched: true, bindingDigest: binding } },
});

test('startup health observations cannot satisfy a functional canary obligation', async (t) => {
  // Window 1 means the startup health observation fills the numeric window on
  // its own. Pre-fix that committed stable with no functional proof at all.
  const { core } = await scene(t, {
    verification: { kind: 'functional-check', tool: 'read', bindingDigest: BINDING, requiredObservations: 1 },
    window: 1,
    observations: [],
  });
  const first = await core.observeCanary({
    experimentId: EXPERIMENT, startupVerified: true, componentHealth: 'active',
    dependenciesPresent: true, metricRegression: false,
    barrier: { id: 'startup:owner', reached: true },
    evidence: { source: 'new-session-startup' },
  }, execFor(OWNER));
  assert.equal(first.stable, false, 'a health-only observation must not commit stable');
  assert.equal(first.remainingFunctional, 1, 'the unmet functional obligation is reported');
  assert.equal(first.canary.observations.at(-1).verificationKind, 'health');
  assert.equal(await exists(path.join(core.paths.promotionStateDir, 'journal.json')), true);

  const second = await core.observeCanary(functional('task-2'), execFor(OWNER));
  assert.equal(second.stable, true, 'a matching functional observation clears the obligation');
  assert.equal(await exists(path.join(core.paths.promotionStateDir, 'journal.json')), false);
});

test('a functional check that binds to a different plan is a canary regression', async (t) => {
  const { core } = await scene(t, {
    verification: { kind: 'functional-check', tool: 'read', bindingDigest: BINDING, requiredObservations: 1 },
    observations: [],
  });
  // The numeric window still needs two observations; send one healthy startup
  // observation first, then a bound-but-mismatched functional claim.
  await core.observeCanary({
    experimentId: EXPERIMENT, startupVerified: true, componentHealth: 'active',
    dependenciesPresent: true, metricRegression: false,
    barrier: { id: 'startup:owner', reached: true }, evidence: { source: 'new-session-startup' },
  }, execFor(OWNER));
  const result = await core.observeCanary(functional('task-forged', 'a'.repeat(64)), execFor(OWNER));
  assert.equal(result.stable, undefined);
  assert.match(result.phase, /rolled-back|revert/i, `a forged binding must roll back, got ${JSON.stringify(result)}`);
});

test('a context-policy promotion refuses to commit without a functional-check obligation', async (t) => {
  const root = await scratchRoot('round4-context-policy-gate');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const paths = { ...promotionPaths(root), startupDrift: false, promotionRuntime: unitPromotionRuntime() };
  await fsp.writeFile(paths.compositionPath, '[]\n');
  const ctx = orchestratorContext();
  ctx.dynamicCordisRunner = {
    snapshot: () => [],
    inspectPackage: () => ({ code: { host: HOST_CODE } }),
    stop: async () => ({ ok: true }),
    undefine: async () => ({ ok: true }),
  };
  const core = new EvolutionOrchestrator(ctx, paths);
  const exec = execFor('context-policy-owner');
  const proposal = core.propose({
    why: 'context policy', target: 'plugin:context', impactScope: ['runtime'],
    successMetrics: ['m'], improvement: 'context-policy', benefitModel: { kind: 'workflow' },
  }, exec);
  const record = core.experiments.get(proposal.experimentId);
  record.state = 'trial';
  record.pluginId = 'plugin-context';
  record.packageId = 'package-context';
  record.targets = ['plugin:context'];
  core.acquireTargets(record);
  core.measure({
    experimentId: record.id,
    observation: {
      solvesProblem: true, metrics: { latencyMs: 10 }, beforeMetrics: { latencyMs: 20 },
      afterMetrics: { latencyMs: 10 }, observationWindow: '5m', sampleCount: 5,
      repeatable: true, regressionPassed: true, reversible: true, cleanupEvidence: 'disposed trial',
      orphanResources: [],
    },
  }, exec);
  await assert.rejects(
    core.promote({ experimentId: record.id, confirmation: true }, exec),
    /context-policy promotion requires canaryVerification/,
    'no durable write may happen without the declared functional check',
  );
  assert.equal(record.state, 'measured', 'the refusal happens before the promotion state machine starts');
});

test('journals without an obligation keep the health-only canary behavior', async (t) => {
  const { core } = await scene(t, { observations: [] });
  await core.observeCanary({
    experimentId: EXPERIMENT, startupVerified: true, componentHealth: 'active',
    dependenciesPresent: true, metricRegression: false,
    barrier: { id: 'startup:owner', reached: true }, evidence: { source: 'new-session-startup' },
  }, execFor(OWNER));
  const result = await core.observeCanary({
    experimentId: EXPERIMENT, startupVerified: true, componentHealth: 'active',
    dependenciesPresent: true, metricRegression: false,
    barrier: { id: 'startup:owner-2', reached: true }, evidence: { source: 'new-session-startup' },
  }, execFor(OWNER));
  assert.equal(result.stable, true, 'legacy health-only journals are unchanged');
});
