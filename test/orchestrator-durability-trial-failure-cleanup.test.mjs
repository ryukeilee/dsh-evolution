// P2-10: a failing trial must release its target ownership and drop the
// experiment record even when the failure archive cannot be written.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EvolutionOrchestrator } from '../lib/orchestrator.js';
import {
  scratchRoot, promotionPaths, orchestratorContext, execFor, exists,
} from './orchestrator-durability-fixtures.mjs';

async function brokenArchiveRoot(name) {
  const root = await scratchRoot(name);
  const paths = promotionPaths(root);
  // The archive directory is a regular file: every archive() write and read
  // below it fails with ENOTDIR, which is the documented unwritable path.
  await fs.mkdir(path.dirname(paths.archiveDir), { recursive: true });
  await fs.writeFile(paths.archiveDir, 'not a directory\n');
  return { root, paths };
}

function runner({ failing, probe }) {
  let installed = false;
  return {
    snapshot: () => (installed ? [{ pluginId: 'candidate', packages: [] }] : []),
    define: () => { installed = true; return { pluginId: 'candidate', packageId: 'package' }; },
    run: async () => {
      if (probe) await probe();
      return failing
        ? { ok: false, message: 'synthetic trial failure' }
        : { ok: true, status: 'active' };
    },
    stop: async () => ({ ok: true }),
    undefine: async () => { installed = false; return { ok: true }; },
  };
}

const composition = { name: 'durability-trial', purpose: 'failure cleanup', code: { host: 'return {};' } };

test('P2-10 a failed trial with an unwritable archive still releases the target lock and drops the record', async t => {
  const { root, paths } = await brokenArchiveRoot('trial-cleanup');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const warnings = [];
  const ctx = orchestratorContext(warnings);
  const cordisRunner = runner({ failing: true, probe: async () => {
    acquiredDuringRun = core.targetOwners.get(target) === experimentId
      && (await fs.readdir(ownershipDir).catch(() => [])).length === 1;
  } });
  ctx.dynamicCordisRunner = cordisRunner;
  const core = new EvolutionOrchestrator(ctx, { ...paths, startupDrift: false, eventBridge: { emit: () => ({}) } });
  const exec = execFor();

  const { experimentId } = core.propose({ why: 'cleanup', target: 'plugin:durability', impactScope: ['test'], successMetrics: ['durability'] }, exec);
  const record = core.experiments.get(experimentId);
  const target = record.targets[0];
  const ownershipDir = path.join(root, '.evolution-ownership');
  let acquiredDuringRun = false;

  await assert.rejects(
    core.trial({ experimentId, composition }, exec),
    /synthetic trial failure/,
  );

  assert.equal(acquiredDuringRun, true, 'the trial held the target lock while it ran');
  assert.equal(core.experiments.has(experimentId), false, 'the failed experiment record was dropped');
  assert.equal(core.targetOwners.get(target), undefined, 'the in-memory target lock was released');
  assert.deepEqual(await fs.readdir(ownershipDir).catch(() => []), [], 'the ownership file was removed');
  assert.equal(record.targetsAcquired, false);
  assert.ok(warnings.some(warning => /trial-failed archive failed/.test(warning)), `the archive failure is reported as a warning: ${JSON.stringify(warnings)}`);

  // The same target can be acquired again in this process.
  const again = core.propose({ why: 'retry', target: 'plugin:durability', impactScope: ['test'], successMetrics: ['durability'] }, exec);
  cordisRunner.run = async () => ({ ok: true, status: 'active' });
  const retried = await core.trial({ experimentId: again.experimentId, composition }, exec);
  assert.equal(retried.phase, 'trial');
  assert.equal(core.targetOwners.get(target), again.experimentId);
});

test('P2-10 a successful trial-failure archive still records the failure learning', async t => {  const root = await scratchRoot('trial-cleanup-ok');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = promotionPaths(root);
  const warnings = [];
  const ctx = orchestratorContext(warnings);
  ctx.dynamicCordisRunner = runner({ failing: true });
  const core = new EvolutionOrchestrator(ctx, { ...paths, startupDrift: false, eventBridge: { emit: () => ({}) } });
  const exec = execFor();
  const { experimentId } = core.propose({ why: 'cleanup', target: 'plugin:durability', impactScope: ['test'], successMetrics: ['durability'] }, exec);
  await assert.rejects(core.trial({ experimentId, composition }, exec), /synthetic trial failure/);
  assert.deepEqual(warnings, []);
  assert.equal(await exists(path.join(paths.archiveDir, `${experimentId}.md`)), true);
  assert.equal(core.experiments.has(experimentId), false);
  assert.equal(core.targetOwners.get('plugin:durability'), undefined);
});

test('P2-10 a revert with an unwritable archive still releases its operation claim and target lock', async t => {
  const { root, paths } = await brokenArchiveRoot('revert-cleanup');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const warnings = [];
  const ctx = orchestratorContext(warnings);
  const cordisRunner = runner({ failing: false });
  ctx.dynamicCordisRunner = cordisRunner;
  const core = new EvolutionOrchestrator(ctx, { ...paths, startupDrift: false, eventBridge: { emit: () => ({}) } });
  const exec = execFor();

  const { experimentId } = core.propose({ why: 'revert cleanup', target: 'plugin:durability', impactScope: ['test'], successMetrics: ['durability'] }, exec);
  const record = core.experiments.get(experimentId);
  const target = record.targets[0];
  await core.trial({ experimentId, composition }, exec);

  const result = await core.revert({ experimentId }, exec);
  assert.equal(result.ok, true, 'the runtime recovered');
  assert.equal(core.operationClaims.has(experimentId), false, 'the revert claim was released');
  assert.equal(core.targetOwners.get(target), undefined, 'the target lock was released');
  assert.deepEqual(await fs.readdir(path.join(root, '.evolution-ownership')).catch(() => []), []);
  assert.ok(warnings.some(warning => /revert archive failed/.test(warning)), `the archive failure is reported as a warning: ${JSON.stringify(warnings)}`);

  const again = core.propose({ why: 'after revert', target: 'plugin:durability', impactScope: ['test'], successMetrics: ['durability'] }, exec);
  const retried = await core.trial({ experimentId: again.experimentId, composition }, exec);
  assert.equal(retried.phase, 'trial');
});
