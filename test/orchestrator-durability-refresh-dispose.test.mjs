// P2-2: Include.refresh() must not report a settled tree while a removed
// entry's asynchronous disposal is still running. The loader's
// EntryGroup.remove() calls entry.fiber?.dispose() and deletes the store slot
// without awaiting, so EntryTree.await() can no longer observe that entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import { EvolutionOrchestrator, writeDurablePromotion } from '../lib/orchestrator.js';
import { mountPromotedInclude } from '../lib/promotion-include.js';
import {
  scratchRoot, promotionPaths, unitPromotionRuntime, promotionExperiment, HOST_CODE,
  orchestratorContext, execFor, writeJournal, readJournal, exists,
} from './orchestrator-durability-fixtures.mjs';

const DISPOSE_DELAY_MS = 400;

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

/** A promoted plugin whose disposal is slow and observable. */
async function slowDisposerPlugin(root, markerKey) {
  const pluginDir = path.join(root, 'promoted', 'dsh-evolution-promoted-aaaaaaaaaaaa');
  await fs.mkdir(path.join(pluginDir, 'lib'), { recursive: true });
  await fs.writeFile(path.join(pluginDir, 'package.json'), JSON.stringify({
    name: 'dsh-evolution-promoted-aaaaaaaaaaaa', version: '0.1.0', main: 'lib/index.js', type: 'module',
  }));
  await fs.writeFile(path.join(pluginDir, 'lib', 'index.js'), [
    'export const name = "durability-slow-disposer";',
    'export function apply(ctx) {',
    '  ctx.effect(() => async () => {',
    `    await new Promise(resolve => setTimeout(resolve, ${DISPOSE_DELAY_MS}));`,
    `    const marker = (globalThis[${JSON.stringify(markerKey)}] ??= { disposed: 0 });`,
    '    marker.disposed += 1;',
    '  });',
    '}',
    '',
  ].join('\n'));
  return { pluginDir, moduleUrl: pathToFileURL(path.join(pluginDir, 'lib', 'index.js')).href };
}

async function mountReal(compositionPath) {
  const ctx = new Context();
  await ctx.plugin(Loader, {}).await();
  const runtime = await mountPromotedInclude(ctx, { compositionPath });
  return { ctx, runtime };
}

test('P2-2 refresh() returns only after the removed entry finished its asynchronous disposal', async t => {
  const root = await scratchRoot('refresh-dispose');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const markerKey = `__evoDurabilityRefresh${process.pid}_${Date.now()}`;
  const { moduleUrl, pluginDir } = await slowDisposerPlugin(root, markerKey);
  const compositionPath = path.join(root, 'promoted.cordis.yml');
  const rowId = 'evolution-promoted-aaaaaaaaaaaa';
  await fs.mkdir(path.dirname(pluginDir), { recursive: true });
  await fs.writeFile(compositionPath, `- id: ${rowId}\n  name: ${JSON.stringify(moduleUrl)}\n`);

  const { runtime } = await mountReal(compositionPath);
  await runtime.verify(rowId, moduleUrl);

  // Remove the row out of band, exactly what a rollback rewrites.
  await fs.writeFile(compositionPath, '[]\n');
  const startedAt = Date.now();
  await runtime.refresh();
  const elapsed = Date.now() - startedAt;
  const disposedAtReturn = globalThis[markerKey]?.disposed ?? 0;

  assert.equal(disposedAtReturn, 1, 'the removed entry finished its disposer before refresh() returned');
  assert.ok(elapsed >= DISPOSE_DELAY_MS - 50, `refresh() waited for the disposer (${elapsed}ms)`);
  await assert.rejects(runtime.verify(rowId, moduleUrl), /not active/);
});

test('P2-2 a canary rollback deletes the journal only after the removed entry is disposed', async t => {
  const root = await scratchRoot('rollback-dispose');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = promotionPaths(root);
  const markerKey = `__evoDurabilityRollback${process.pid}_${Date.now()}`;
  const { moduleUrl, pluginDir } = await slowDisposerPlugin(root, markerKey);
  const rowId = 'evolution-promoted-aaaaaaaaaaaa';
  const row = `- id: ${rowId}\n  name: ${JSON.stringify(moduleUrl)}\n`;
  await fs.writeFile(paths.compositionPath, row);

  const { runtime } = await mountReal(paths.compositionPath);
  paths.promotionRuntime = runtime;
  await runtime.verify(rowId, moduleUrl);

  // The authoritative change plan a promotion would have written.
  await fs.mkdir(path.join(paths.promotionStateDir, 'backups'), { recursive: true });
  await fs.writeFile(path.join(paths.promotionStateDir, 'backups', 'composition.bak'), '[]\n');
  const journal = {
    version: 1,
    phase: 'canary-observing',
    experimentId: 'exp-rollback-dispose',
    ownerId: 'durability-owner',
    proposal: { owner: 'durability-owner', why: 'canary rollback', target: 'plugin:durability', impactScope: ['test'], successMetrics: ['durability'], createdAt: '2026-01-01T00:00:00.000Z' },
    stateDir: paths.promotionStateDir,
    stageDir: path.join(paths.promotionStateDir, 'stage'),
    records: [
      {
        type: 'file', target: paths.compositionPath, existed: true, backup: 'composition.bak',
        beforeDigest: sha256('[]\n'), expectedAfter: sha256(row),
      },
      { type: 'path', target: pluginDir, existed: false },
    ],
    canary: { promotionTimestamp: '2026-02-02T00:00:00.000Z', healthObservationWindow: 2, startupVerified: false, observations: [] },
    durable: { pluginName: 'dsh-evolution-promoted-aaaaaaaaaaaa', pluginPath: pluginDir, rowId, moduleUrl },
  };
  await writeJournal(paths, journal);

  const core = new EvolutionOrchestrator(orchestratorContext(), {
    ...paths,
    startupDrift: false,
    canaryWindow: 2,
    eventBridge: { emit: () => ({}) },
  });
  core.experiments.set(journal.experimentId, {
    id: journal.experimentId,
    ownerId: journal.ownerId,
    state: 'canary-observing',
    targets: [],
    proposal: journal.proposal,
    observations: [],
    latestObservation: {},
    durable: journal.durable,
    canary: journal.canary,
  });

  const startedAt = Date.now();
  const result = await core.observeCanary({
    experimentId: journal.experimentId,
    metricRegression: true,
    barrier: { id: 'window:regression', reached: true },
    startupVerified: true,
    componentHealth: 'active',
    dependenciesPresent: true,
  }, execFor());
  const elapsed = Date.now() - startedAt;

  assert.equal(result.phase, 'rolled-back');
  assert.equal(globalThis[markerKey]?.disposed, 1, 'the rollback finished the removal before reporting completion');
  assert.ok(elapsed >= DISPOSE_DELAY_MS - 50, `rollback waited for the disposer (${elapsed}ms)`);
  assert.equal(await exists(paths.promotionStateDir), false, 'the journal is only removed after the disposal settled');
  assert.equal(await fs.readFile(paths.compositionPath, 'utf8'), '[]\n');
  assert.equal(await exists(pluginDir), false);
});

test('P2-2 an unconfirmable disposal keeps the journal instead of declaring a completed rollback', async t => {
  const root = await scratchRoot('rollback-unconfirmed');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = promotionPaths(root);
  await fs.writeFile(paths.compositionPath, '[]\n');
  // The unit runtime refuses the refresh, which is the only fail-closed signal
  // the official Include can surface for a disposal it could not settle.
  paths.promotionRuntime = { ...unitPromotionRuntime(), refresh: async () => { throw new Error('synthetic disposal did not settle'); } };
  await fs.mkdir(path.join(paths.promotionStateDir, 'backups'), { recursive: true });
  await fs.writeFile(path.join(paths.promotionStateDir, 'backups', 'composition.bak'), '[]\n');
  const journal = {
    version: 1,
    phase: 'canary-observing',
    experimentId: 'exp-unconfirmed',
    ownerId: 'durability-owner',
    proposal: { owner: 'durability-owner', why: 'unconfirmed', target: 'plugin:durability', impactScope: ['test'], successMetrics: ['durability'], createdAt: '2026-01-01T00:00:00.000Z' },
    stateDir: paths.promotionStateDir,
    records: [{ type: 'file', target: paths.compositionPath, existed: true, backup: 'composition.bak', beforeDigest: sha256('[]\n'), expectedAfter: sha256('[{"id":"r","name":"u"}]') }],
    canary: { promotionTimestamp: null, healthObservationWindow: 2, startupVerified: false, observations: [] },
  };
  await writeJournal(paths, journal);

  const core = new EvolutionOrchestrator(orchestratorContext(), { ...paths, startupDrift: false, eventBridge: { emit: () => ({}) } });
  core.experiments.set(journal.experimentId, {
    id: journal.experimentId, ownerId: journal.ownerId, state: 'canary-observing', targets: [],
    proposal: journal.proposal, observations: [], latestObservation: {}, canary: journal.canary,
  });

  await assert.rejects(core.observeCanary({
    experimentId: journal.experimentId,
    metricRegression: true,
    barrier: { id: 'window:regression', reached: true },
  }, execFor()), /rollback failed/);

  const preserved = await readJournal(paths);
  assert.equal(preserved.phase, 'rollback-failed');
  assert.equal(await exists(paths.promotionStateDir), true);
});
