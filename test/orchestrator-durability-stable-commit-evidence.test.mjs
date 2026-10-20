// P3-16: a `stable-committed` journal is the last durable copy of the canary
// barriers. Recovery must persist them into the sidecar and archive before it
// removes the state directory, and keep the journal when that write fails.
// P3-18: two concurrent canary observations of one experiment must not drop a
// barrier; they are serialized through the same in-process operation claims the
// other lifecycle operations use.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EvolutionOrchestrator, recoverInterruptedPromotion, writeDurablePromotion } from '../lib/orchestrator.js';
import {
  scratchRoot, promotionPaths, unitPromotionRuntime, promotionExperiment, HOST_CODE,
  orchestratorContext, execFor, writeJournal, readJournal, exists,
} from './orchestrator-durability-fixtures.mjs';

async function promotedFixture(name, { canaryWindow = 3 } = {}) {
  const root = await scratchRoot(name);
  const paths = promotionPaths(root);
  await fsp.writeFile(paths.compositionPath, '[]\n');
  paths.promotionRuntime = unitPromotionRuntime();
  await writeDurablePromotion({
    experiment: promotionExperiment(`exp-${name}`),
    paths,
    packageInspection: { code: { host: HOST_CODE } },
    canaryWindow,
  });
  return { root, paths, experimentId: `exp-${name}` };
}

function barriers(ids) {
  return ids.map((id, index) => ({
    at: `2026-02-02T00:00:0${index}.000Z`,
    barrierId: id,
    startupVerified: true,
    componentHealth: 'active',
    dependenciesPresent: true,
    metricRegression: false,
    metrics: {},
    evidence: { barrier: id },
  }));
}

test('P3-16 stable-committed recovery persists the canary barriers before removing the journal', async t => {
  const { root, paths, experimentId } = await promotedFixture('stable-evidence');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  // An earlier canary window already reached the sidecar; the recovery must
  // merge the journal's barriers into it instead of replacing the evidence.
  const sidecarPath = path.join(paths.archiveDir, `${experimentId}.evidence.json`);
  const persisted = JSON.parse(await fsp.readFile(sidecarPath, 'utf8'));
  persisted.canary = { observations: barriers(['window:0']), startupVerified: false, healthObservationWindow: 3, promotionTimestamp: '2026-02-02T00:00:00.000Z' };
  await fsp.writeFile(sidecarPath, `${JSON.stringify(persisted, null, 2)}\n`);

  const journal = await readJournal(paths);
  journal.phase = 'stable-committed';
  journal.stableCommittedAt = '2026-02-02T00:00:09.000Z';
  journal.canary.observations = barriers(['startup:owner', 'window:1']);
  journal.canary.startupVerified = true;
  await writeJournal(paths, journal);

  const result = await recoverInterruptedPromotion(paths);
  assert.equal(result.status, 'committed-cleaned');
  assert.equal(await exists(paths.promotionStateDir), false, 'the journal was cleaned up after the evidence write');

  const sidecar = JSON.parse(await fsp.readFile(sidecarPath, 'utf8'));
  assert.deepEqual(sidecar.canary.observations.map(entry => entry.barrierId).sort(), ['startup:owner', 'window:0', 'window:1']);
  assert.equal(sidecar.canary.startupVerified, true);
  const archive = await fsp.readFile(path.join(paths.archiveDir, `${experimentId}.md`), 'utf8');
  assert.match(archive, /## Canary/, 'the archive keeps a canary section');
  assert.match(archive, /startup:owner/);
  assert.match(archive, /window:1/);
});

test('P3-16 a failed evidence write keeps the stable-committed journal', async t => {
  const { root, paths, experimentId } = await promotedFixture('stable-evidence-fail');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const journal = await readJournal(paths);
  journal.phase = 'stable-committed';
  journal.canary.observations = barriers(['window:1']);
  await writeJournal(paths, journal);

  const originalWriteFile = fsp.writeFile;
  fsp.writeFile = async function failingWriteFile(file, ...rest) {
    if (String(file).startsWith(paths.archiveDir) && String(file).endsWith('.tmp')) {
      throw new Error('synthetic evidence write failure');
    }
    return originalWriteFile.call(this, file, ...rest);
  };
  let error;
  try {
    await recoverInterruptedPromotion(paths);
  } catch (caught) {
    error = caught;
  } finally {
    fsp.writeFile = originalWriteFile;
  }

  assert.ok(error, 'recovery reported the failed evidence write');
  assert.match(error.message, /synthetic evidence write failure/);
  assert.equal(await exists(path.join(paths.promotionStateDir, 'journal.json')), true, 'the journal is preserved');
  assert.equal((await readJournal(paths)).phase, 'stable-committed');

  // The evidence is not lost: a later recovery persists it and only then cleans up.
  const retried = await recoverInterruptedPromotion(paths);
  assert.equal(retried.status, 'committed-cleaned');
  const sidecar = JSON.parse(await fsp.readFile(path.join(paths.archiveDir, `${experimentId}.evidence.json`), 'utf8'));
  assert.deepEqual(sidecar.canary.observations.map(entry => entry.barrierId), ['window:1']);
});

test('P3-16 a canary-observing journal keeps its pending barriers untouched', async t => {
  const { root, paths, experimentId } = await promotedFixture('stable-evidence-pending');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const journal = await readJournal(paths);
  journal.canary.observations = barriers(['window:1']);
  await writeJournal(paths, journal);
  const result = await recoverInterruptedPromotion(paths);
  assert.equal(result.status, 'canary-pending');
  assert.equal(await exists(path.join(paths.promotionStateDir, 'journal.json')), true);
  const sidecar = JSON.parse(await fsp.readFile(path.join(paths.archiveDir, `${experimentId}.evidence.json`), 'utf8'));
  assert.equal(sidecar.canary, null, 'pending canary evidence stays in the journal only');
});

async function canaryOrchestrator(name, { canaryWindow = 3 } = {}) {
  const { root, paths, experimentId } = await promotedFixture(name, { canaryWindow });
  const journal = await readJournal(paths);
  journal.canary.healthObservationWindow = canaryWindow;
  await writeJournal(paths, journal);
  const core = new EvolutionOrchestrator(orchestratorContext(), {
    ...paths, startupDrift: false, canaryWindow, eventBridge: { emit: () => ({}) },
  });
  core.experiments.set(experimentId, {
    id: experimentId,
    ownerId: journal.ownerId,
    state: 'canary-observing',
    targets: [],
    proposal: journal.proposal,
    observations: [],
    latestObservation: {},
    durable: journal.durable,
    canary: journal.canary,
  });
  const observe = (barrierId) => core.observeCanary({
    experimentId,
    barrier: { id: barrierId, reached: true },
    startupVerified: true,
    componentHealth: 'active',
    dependenciesPresent: true,
  }, execFor());
  return { root, paths, experimentId, core, journal, observe };
}

test('P3-18 concurrent canary observations cannot silently drop a barrier', async t => {
  const { root, paths, observe } = await canaryOrchestrator('canary-concurrent');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const results = await Promise.allSettled([observe('window:1'), observe('window:2')]);
  const fulfilled = results.filter(result => result.status === 'fulfilled');
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(fulfilled.length, 1, `exactly one observation wins: ${results.map(r => r.status === 'rejected' ? r.reason.message : 'ok').join(' | ')}`);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /busy with canary/, 'the losing observation is refused explicitly');

  const journal = await readJournal(paths);
  const stored = journal.canary.observations.map(entry => entry.barrierId);
  assert.equal(stored.length, 1, `the journal holds the winner's barrier: ${JSON.stringify(stored)}`);
  assert.equal(fulfilled[0].value.canary.observations.some(entry => entry.barrierId === stored[0]), true);
});

test('P3-18 sequential canary observations still accumulate every barrier', async t => {
  const { root, paths, observe } = await canaryOrchestrator('canary-sequential');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await observe('window:1');
  await observe('window:2');
  const journal = await readJournal(paths);
  assert.deepEqual(journal.canary.observations.map(entry => entry.barrierId).sort(), ['window:1', 'window:2']);
});
