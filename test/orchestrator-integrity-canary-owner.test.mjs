// P2-1 / P3-15: the canary state machine must not be reopened from a durable
// snapshot alone. A promotion is owned by the identity recorded in the journal
// or the evidence sidecar; after a stable commit the promotion is terminal, and
// the caller's own id never becomes the owner.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { EvolutionOrchestrator, persistEvidenceSnapshot } from '../lib/orchestrator.js';
import { context } from './fixtures/runtime-inspect.mjs';
import { promotionPlan, derivedPluginName, derivedPluginPath } from './promotion-plan-fixture.mjs';

const EXPERIMENT_ID = 'exp-canary-owner';
const OWNER = 'original-owner';
const INTRUDER = 'other-agent';

async function scratch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-integrity-canary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function config(root) {
  return {
    presetDir: root,
    startupDrift: false,
    eventBridge: { emit: () => ({}) },
    eventBridgePath: path.join(root, 'events.jsonl'),
    eventBridgeKey: 'k'.repeat(32),
    driftStatePath: path.join(root, 'drift.json'),
    memoryPath: path.join(root, 'memory.json'),
    promotionRuntime: { parse: JSON.parse, stringify: JSON.stringify, refresh: async () => {}, verify: async () => ({}), health: async () => ({ componentHealth: 'active', dependenciesPresent: true }) },
  };
}

function session(root, agentId) {
  const ctx = context();
  ctx.dynamicCordisRunner = { snapshot: () => [] };
  const core = new EvolutionOrchestrator(ctx, config(root));
  const exec = { agent: { id: agentId }, signal: new AbortController().signal };
  const args = {
    experimentId: EXPERIMENT_ID,
    startupVerified: true,
    componentHealth: 'healthy',
    dependenciesPresent: true,
    metricRegression: false,
    barrier: { id: `barrier:${agentId}`, reached: true },
  };
  return { core, exec, args };
}

function ownerProposal() {
  return { owner: OWNER, why: 'canary owner', target: 'plugin:canary', impactScope: ['runtime'], successMetrics: ['health'], createdAt: '2026-01-01T00:00:00.000Z' };
}

function durableIdentity(root) {
  const pluginRoot = path.join(root, 'promoted');
  return {
    pluginName: derivedPluginName(EXPERIMENT_ID), pluginPath: derivedPluginPath({ pluginRoot }, EXPERIMENT_ID),
    rowId: 'evolution-promoted-owner', archivePath: path.join(root, 'archive', `${EXPERIMENT_ID}.md`),
    presetId: 'evolution', promotionTimestamp: '2026-01-01T00:00:00.000Z',
  };
}

function sidecar(root, overrides = {}) {
  return {
    version: 1,
    source: 'test-sidecar',
    capturedAt: '2026-01-02T00:00:00.000Z',
    observations: [{ fitnessScore: 0.9, solvesProblem: true }],
    latestObservation: { fitnessScore: 0.9, solvesProblem: true, regressionPassed: true },
    cleanupProof: { status: 'recovered' },
    recoveryProof: { status: 'recovered' },
    runtimeRecovered: true,
    durable: durableIdentity(root),
    canary: { promotionTimestamp: '2026-01-01T00:00:00.000Z', healthObservationWindow: 1, startupVerified: true, observations: [] },
    ownerId: OWNER,
    proposal: ownerProposal(),
    stableCommittedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

async function paths(root) {
  const ctx = context();
  ctx.dynamicCordisRunner = { snapshot: () => [] };
  const core = new EvolutionOrchestrator(ctx, config(root));
  return core.paths;
}

async function readJsonOrNull(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

test('a stable-committed promotion cannot be reopened as canary-observing by any agent', async (t) => {
  const root = await scratch(t);
  const p = await paths(root);
  await fs.mkdir(p.archiveDir, { recursive: true });
  const archiveFile = path.join(p.archiveDir, `${EXPERIMENT_ID}.md`);
  await fs.writeFile(archiveFile, `# Evolution experiment ${EXPERIMENT_ID}\n\n- state: stable\n`);
  const sidecarFile = await persistEvidenceSnapshot(p.archiveDir, EXPERIMENT_ID, sidecar(root));
  const sidecarBefore = await fs.readFile(sidecarFile, 'utf8');
  const archiveBefore = await fs.readFile(archiveFile, 'utf8');

  for (const agentId of [INTRUDER, OWNER, INTRUDER]) {
    const { core, exec, args } = session(root, agentId);
    await assert.rejects(
      core.observeCanary(args, exec),
      (error) => {
        assert.equal(error instanceof TypeError, false);
        assert.match(error.message, /owned by another Agent|refusing to resume canary observation|canary journal is missing|not known in this session/);
        return true;
      },
      `${agentId} must not be able to advance a terminal promotion`,
    );
    assert.equal(core.experiments.has(EXPERIMENT_ID), false, 'no record is materialized from the durable snapshot alone');
  }

  assert.equal(await fs.readFile(sidecarFile, 'utf8'), sidecarBefore, 'the sidecar owner and bytes are untouched');
  assert.equal(await fs.readFile(archiveFile, 'utf8'), archiveBefore, 'the stable archive is untouched');
  assert.equal(await exists(p.promotionStateDir), false, 'no journal is synthesized on disk');
});

test('cross-session canary keeps the durable owner and refuses another Agent', async (t) => {
  const root = await scratch(t);
  const p = await paths(root);
  await fs.mkdir(p.archiveDir, { recursive: true });
  const sidecarFile = await persistEvidenceSnapshot(p.archiveDir, EXPERIMENT_ID, sidecar(root, { stableCommittedAt: null }));
  const sidecarBefore = await fs.readFile(sidecarFile, 'utf8');
  await fs.mkdir(path.join(p.promotionStateDir, 'stage'), { recursive: true, mode: 0o700 });
  const journalFile = path.join(p.promotionStateDir, 'journal.json');
  const journal = {
    version: 1,
    phase: 'canary-observing',
    experimentId: EXPERIMENT_ID,
    ownerId: OWNER,
    proposal: ownerProposal(),
    targets: [],
    stateDir: p.promotionStateDir,
    stageDir: path.join(p.promotionStateDir, 'stage'),
    records: promotionPlan(p, EXPERIMENT_ID),
    durable: durableIdentity(root),
    canary: { promotionTimestamp: '2026-01-01T00:00:00.000Z', healthObservationWindow: 1, startupVerified: false, observations: [] },
  };
  await fs.writeFile(journalFile, JSON.stringify(journal, null, 2));
  const journalBefore = await fs.readFile(journalFile, 'utf8');

  const intruder = session(root, INTRUDER);
  await assert.rejects(intruder.core.observeCanary(intruder.args, intruder.exec), /owned by another Agent/);
  assert.equal(await fs.readFile(journalFile, 'utf8'), journalBefore, 'the live journal is untouched by the refusal');
  assert.equal((await readJsonOrNull(sidecarFile)).ownerId, OWNER, 'the durable owner is not rewritten');
  assert.equal(await fs.readFile(sidecarFile, 'utf8'), sidecarBefore);

  const owner = session(root, OWNER);
  const result = await owner.core.observeCanary(owner.args, owner.exec);
  assert.equal(result.ok, true);
  assert.equal(result.stable, true, 'the legitimate owner completes the canary window');
  assert.equal(await exists(p.promotionStateDir), false, 'a stable commit removes the journal only after completion');
  const committed = await readJsonOrNull(sidecarFile);
  assert.equal(committed.ownerId, OWNER, 'a stable commit keeps the original owner');
  const archive = await fs.readFile(path.join(p.archiveDir, `${EXPERIMENT_ID}.md`), 'utf8');
  assert.match(archive, /^- state: stable$/m);
  assert.equal(archive.includes(INTRUDER), false, 'the intrusive agent id never reaches the archive');

  const later = session(root, INTRUDER);
  await assert.rejects(later.core.observeCanary(later.args, later.exec), /owned by another Agent|refusing to resume canary observation/);
  assert.equal((await readJsonOrNull(sidecarFile)).ownerId, OWNER, 'the terminal promotion stays owned by the original owner');
});
