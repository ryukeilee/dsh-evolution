// Trial, claim and durable-evidence boundaries closed in the quality round.
//
//   * a Trial whose `undefine()` did not prove the plugin is gone released its
//     target claim and dropped its record anyway, so another experiment could
//     claim a target the runtime might still hold;
//   * an environment failure of a Trial (`ENOSPC`, a cancelled run) was written
//     into the durable failure *learning*, which the experience recall presents as
//     "this approach already failed";
//   * a second Trial could start while another experiment was still mounted; the
//     global baseline then reports both cleanups as drift and both claims stay
//     claimed with neither experiment revertable;
//   * a proposal the autonomous observer created whose Trial never acquired a
//     target stayed in memory as an unreachable orphan;
//   * a refused event-bridge append (a torn tail) published its start offset
//     before the refusal, so the retry appended onto the torn record;
//   * the reclaim externalizer overwrote an unreadable evidence sidecar instead of
//     aborting, and a rollback could not complete when an earlier, interrupted
//     cleanup had already deleted the backups of restored targets.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  EvolutionOrchestrator,
  EvolutionEventBridge,
  externalizeEventBridgeEvidence,
  recoverInterruptedPromotion,
} from '../lib/orchestrator.js';
import {
  HOST_CODE,
  execFor,
  orchestratorContext,
  promotionPaths,
  unitPromotionRuntime,
} from './orchestrator-durability-fixtures.mjs';

const COMPOSITION = { name: 'quality', purpose: 'quality round', code: { host: HOST_CODE } };
const PROPOSAL = { why: 'quality round', target: 'plugin:quality', impactScope: ['runtime'], successMetrics: ['errors'] };

async function scratch(t, name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `evo-quality-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function harness(t, root, { runner: runnerOverride } = {}) {
  const warnings = [];
  const ctx = orchestratorContext(warnings);
  const live = new Set();
  let sequence = 0;
  const runner = {
    snapshot: () => [...live].map((pluginId) => ({ pluginId, packages: [] })),
    define: () => {
      sequence += 1;
      const pluginId = `quality-plugin-${sequence}`;
      live.add(pluginId);
      return { pluginId, packageId: `quality-package-${sequence}` };
    },
    run: async () => ({ ok: true, status: 'active' }),
    stop: async (_agent, pluginId) => { live.delete(pluginId); return { ok: true }; },
    undefine: async (_agent, pluginId) => { live.delete(pluginId); return { ok: true }; },
    inspectPackage: () => ({ code: { host: HOST_CODE } }),
    live,
  };
  ctx.dynamicCordisRunner = runnerOverride ? runnerOverride(runner) : runner;
  const paths = promotionPaths(root);
  paths.promotionRuntime = unitPromotionRuntime();
  const core = new EvolutionOrchestrator(ctx, { ...paths, startupDrift: false, patternThreshold: 2 });
  return { core, ctx, runner, paths, warnings, exec: execFor() };
}

async function claims(core) {
  return fs.readdir(core.paths.ownershipDir).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
}

function failedLearning(core) {
  return core.memory.data.entries.filter((entry) => entry.result?.state === 'failed');
}

test('a Trial whose undo did not prove cleanup keeps its record and its target claim', async (t) => {
  const root = await scratch(t, 'undo-unproven');
  const { core, exec } = harness(t, root, {
    runner: (base) => ({ ...base, run: async () => { throw new Error('trial activation failed'); }, undefine: async () => ({ ok: false }) }),
  });
  const created = core.propose(PROPOSAL, exec);
  const failure = await core.trial({ experimentId: created.experimentId, composition: COMPOSITION }, exec).catch((error) => error);
  assert.match(failure.message, /trial activation failed/, 'the caller still receives the Trial error');
  const record = core.experiments.get(created.experimentId);
  assert.ok(record, 'the record is kept because the runtime may still hold the plugin');
  assert.equal(record.state, 'trial-cleanup-failed');
  assert.equal(record.failure.rollbackResult.ok, false);
  assert.equal(record.targetsAcquired, true);
  assert.equal((await claims(core)).length, 1, 'the target claim is not released on an unproven cleanup');
});

test('a Trial whose undo proved cleanup releases the record and the target claim', async (t) => {
  const root = await scratch(t, 'undo-proven');
  const { core, exec } = harness(t, root, {
    runner: (base) => ({ ...base, run: async () => { throw new Error('trial activation failed'); } }),
  });
  const created = core.propose(PROPOSAL, exec);
  await core.trial({ experimentId: created.experimentId, composition: COMPOSITION }, exec).catch(() => {});
  assert.equal(core.experiments.has(created.experimentId), false);
  assert.deepEqual(await claims(core), []);
});

test('an environment failure of a Trial is archived but never becomes failure learning', async (t) => {
  const root = await scratch(t, 'transient');
  const full = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  const { core, exec } = harness(t, root, { runner: (base) => ({ ...base, run: async () => { throw full; } }) });
  const created = core.propose(PROPOSAL, exec);
  await core.trial({ experimentId: created.experimentId, composition: COMPOSITION }, exec).catch(() => {});
  assert.equal(failedLearning(core).length, 0, 'an environment failure is not a strategy verdict');
  assert.equal(core.memory.data.entries.length, 0);
  const archive = await fs.readFile(path.join(core.paths.archiveDir, `${created.experimentId}.md`), 'utf8');
  assert.match(archive, /ENOSPC/, 'the operation evidence is still archived');
  assert.match(archive, /not recorded \(environment failure/);
});

test('a second Trial is refused while another experiment occupies the runtime', async (t) => {
  const root = await scratch(t, 'busy');
  const { core, exec } = harness(t, root);
  const first = core.propose({ ...PROPOSAL, target: 'plugin:first', targets: { plugins: ['first'] } }, exec);
  const second = core.propose({ ...PROPOSAL, target: 'plugin:second', targets: { plugins: ['second'] } }, exec);
  await core.trial({ experimentId: first.experimentId, composition: COMPOSITION }, exec);

  const refused = await core.trial({ experimentId: second.experimentId, composition: COMPOSITION }, exec).catch((error) => error);
  assert.equal(refused.code, 'E_EVOLUTION_RUNTIME_BUSY');
  assert.match(refused.message, new RegExp(first.experimentId));
  assert.equal(core.experiments.get(second.experimentId).state, 'proposed', 'the refused proposal is untouched and still owned');
  assert.equal((await claims(core)).length, 1, 'only the live experiment holds a claim');

  // Closing the first experiment makes the second one runnable, and both are
  // then able to prove their own cleanup.
  const reverted = await core.revert({ experimentId: first.experimentId }, exec);
  assert.equal(reverted.ok, true);
  const trialed = await core.trial({ experimentId: second.experimentId, composition: COMPOSITION }, exec);
  assert.equal(trialed.ok, true);
  assert.equal((await core.revert({ experimentId: second.experimentId }, exec)).ok, true);
  assert.deepEqual(await claims(core), []);
});

test('an autonomous proposal that never acquired a target is discarded, not orphaned', async (t) => {
  const root = await scratch(t, 'orphan');
  const { core, exec } = harness(t, root);
  // Occupy the target the declaration asks for, so the autonomous Trial fails in
  // `acquireTargets()` before any mutation and the proposal has no owner action.
  const held = core.propose({ ...PROPOSAL, target: 'plugin:taken', targets: { plugins: ['taken'] } }, exec);
  await core.trial({ experimentId: held.experimentId, composition: COMPOSITION }, exec);
  core.strategies = {
    AGENT_ERROR: {
      risk: 'low',
      target: 'plugin:taken',
      targets: { plugins: ['taken'] },
      composition: COMPOSITION,
      measure: async () => ({ solvesProblem: true }),
    },
  };
  const input = { type: 'agent/error', code: 'AGENT_ERROR', message: 'provider call failed', target: 'agent' };
  assert.equal((await core.observeAutonomous(input, exec)).phase, 'pattern-observing');
  const result = await core.observeAutonomous(input, exec);
  assert.equal(result.phase, 'experiment-deferred');
  assert.equal(result.cleanup.status, 'discarded');
  assert.equal(core.experiments.size, 1, 'only the separately proposed experiment remains');
  assert.equal(core.experiments.has(held.experimentId), true);
});

test('a refused append leaves no resumable offset on a torn tail', async (t) => {
  const root = await scratch(t, 'torn');
  const file = path.join(root, 'events.jsonl');
  await fs.writeFile(file, '{"torn":');
  const bridge = new EvolutionEventBridge({ file, key: 'k'.repeat(32) });
  const record = { id: 'exp-torn', proposal: { why: 'torn' } };
  assert.throws(() => bridge.emit('proposal-created', record), /incomplete or unverified record/);
  // The retry must refuse for the same reason instead of resuming at an offset
  // this call never proved.
  assert.throws(() => bridge.emit('proposal-created', record), /incomplete or unverified record/);
  assert.equal(await fs.readFile(file, 'utf8'), '{"torn":', 'the torn tail is left exactly as it was');
});

test('the reclaim externalizer refuses to overwrite an unreadable evidence sidecar', async (t) => {
  const root = await scratch(t, 'externalize');
  const archiveDir = path.join(root, 'archive');
  await fs.mkdir(archiveDir, { recursive: true });
  const sidecar = path.join(archiveDir, 'exp-broken.evidence.json');
  await fs.writeFile(sidecar, '{"recoveryProof":');
  const paths = { archiveDir };
  const failure = await externalizeEventBridgeEvidence(paths, [{
    experimentId: 'exp-broken',
    evidence: { version: 1, observations: [{ at: '2026-01-01T00:00:00.000Z' }], runtimeRecovered: true },
  }]).catch((error) => error);
  assert.ok(failure instanceof Error, 'the reclaim has to abort, not replace the scene');
  assert.match(failure.message, /unreadable|not valid JSON/);
  assert.equal(await fs.readFile(sidecar, 'utf8'), '{"recoveryProof":', 'the unreadable bytes are preserved');
});

test('an interrupted rollback cleanup does not block the next recovery', async (t) => {
  const root = await scratch(t, 'recovery-window');
  const { core, paths, exec } = harness(t, root);
  await fs.writeFile(paths.compositionPath, '[]\n');
  const observation = {
    solvesProblem: true, sideEffects: [], orphanResources: [],
    metrics: { errors: 0 }, beforeMetrics: { errors: 1 }, afterMetrics: { errors: 0 },
    observationWindow: '1h', sampleCount: 2, benefitEvidence: 'errors fell',
    repeatable: true, regressionPassed: true, reversible: true, cleanupEvidence: 'trial stopped and undefined',
  };
  const created = core.propose(PROPOSAL, exec);
  await core.trial({ experimentId: created.experimentId, composition: COMPOSITION }, exec);
  core.measure({ experimentId: created.experimentId, observation }, exec);
  const promoted = await core.promote({ experimentId: created.experimentId, confirmation: true }, exec);
  assert.equal(promoted.ok, true);

  // Recreate the crash window: the rollback already restored every target, then
  // the process died while deleting the state directory, so one backup is gone
  // while the journal still describes the transaction.
  const journalPath = path.join(paths.promotionStateDir, 'journal.json');
  const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  // A rollback is what recovery performs for a commit-phase journal, so the crash
  // window below is the one `rollbackPromotionJournal()` itself creates.
  journal.phase = 'committing';
  await fs.writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  const restored = [];
  for (const record of journal.records) {
    if (record.type !== 'file' || record.existed !== true) continue;
    await fs.writeFile(record.target, await fs.readFile(path.join(paths.promotionStateDir, 'backups', record.backup), 'utf8'));
    restored.push(record);
  }
  assert.ok(restored.length >= 1, 'the transaction recorded a pre-existing target with a backup');
  // The cleanup deletes backups one by one; this is the state after it died.
  await fs.rm(path.join(paths.promotionStateDir, 'backups', restored[0].backup));

  const recovered = await recoverInterruptedPromotion(paths);
  assert.equal(recovered.status, 'rolled-back', 'the targets already hold their baseline, so the rollback completes');
  assert.equal(await fs.access(paths.promotionStateDir).then(() => true, () => false), false);
});
