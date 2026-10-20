// P2-8: the promotion journal and its target files must be fsynced (file and
// parent directory) before the transaction claims to be on disk.
// P3-17: an external concurrent edit of EVOLUTION.md must be refused instead of
// silently overwritten by the commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EvolutionOrchestrator, writeDurablePromotion, recoverInterruptedPromotion } from '../lib/orchestrator.js';
import {
  scratchRoot, promotionPaths, unitPromotionRuntime, promotionExperiment, HOST_CODE,
  orchestratorContext, exists, readJournal,
} from './orchestrator-durability-fixtures.mjs';

test('P2-8 the durable promotion fsyncs every written file and its parent directory', async t => {
  const root = await scratchRoot('promotion-fsync');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const paths = promotionPaths(root);
  await fsp.writeFile(paths.compositionPath, '[]\n');
  paths.promotionRuntime = unitPromotionRuntime();

  const fsyncs = [];
  const sequence = [];
  const originalFsyncSync = fs.fsyncSync;
  fs.fsyncSync = function observedFsyncSync(descriptor) {
    let kind = 'other';
    try {
      const stat = fs.fstatSync(descriptor);
      kind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
    } catch {}
    fsyncs.push(kind);
    sequence.push(`fsync:${kind}`);
    return originalFsyncSync.call(this, descriptor);
  };
  const originalRename = fsp.rename;
  fsp.rename = async function observedRename(from, to) {
    if (to === paths.compositionPath) sequence.push('commit:composition');
    return originalRename.call(this, from, to);
  };
  let durable;
  try {
    durable = await writeDurablePromotion({ experiment: promotionExperiment('exp-fsync'), paths, packageInspection: { code: { host: HOST_CODE } } });
  } finally {
    fs.fsyncSync = originalFsyncSync;
    fsp.rename = originalRename;
  }

  assert.ok(durable.journalPath, 'the promotion completed');
  assert.ok(fsyncs.filter(kind => kind === 'file').length >= 2, `journal and target bytes were fsynced: ${JSON.stringify(fsyncs)}`);
  assert.ok(fsyncs.includes('directory'), `parent directory entries were fsynced: ${JSON.stringify(fsyncs)}`);
  assert.equal(fsyncs.includes('other'), false, 'every fsync targeted a file or a directory');
  // The journal is on disk before the commit replaces the composition, which is
  // what makes recovery able to find it after a crash.
  const commitAt = sequence.indexOf('commit:composition');
  assert.ok(commitAt > 0, 'the composition commit rename happened');
  const beforeCommit = sequence.slice(0, commitAt);
  assert.ok(beforeCommit.filter(entry => entry === 'fsync:file').length >= 2, `the journal bytes were fsynced before the commit: ${JSON.stringify(beforeCommit)}`);
  assert.ok(beforeCommit.includes('fsync:directory'), `the journal directory entry was fsynced before the commit: ${JSON.stringify(beforeCommit)}`);
});

test('P2-8 a non-journal write keeps its previous cost', async t => {
  const root = await scratchRoot('promotion-fsync-scope');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const paths = promotionPaths(root);
  await fsp.mkdir(paths.archiveDir, { recursive: true });
  const target = path.join(paths.archiveDir, 'exp-plain.md');
  const core = new EvolutionOrchestrator(orchestratorContext(), { ...paths, startupDrift: false, eventBridge: { emit: () => ({}) } });

  const fsyncs = [];
  const originalFsyncSync = fs.fsyncSync;
  fs.fsyncSync = function observedFsyncSync(descriptor) { fsyncs.push(descriptor); return originalFsyncSync.call(this, descriptor); };
  try {
    await core.archive({
      id: 'exp-plain',
      state: 'trial-failed',
      ownerId: 'durability-owner',
      proposal: { owner: 'durability-owner', why: 'plain archive', target: 'plugin:durability', impactScope: ['test'], successMetrics: ['durability'], createdAt: '2026-01-01T00:00:00.000Z' },
      observations: [],
      latestObservation: {},
      targets: [],
    }, 'trial-failed');
  } finally {
    fs.fsyncSync = originalFsyncSync;
  }
  assert.equal(await exists(target), true);
  assert.equal(fsyncs.length, 0, 'the per-experiment archive is not on the fsync path');
});

test('P3-17 an external EVOLUTION.md edit during the commit is refused, not overwritten', async t => {
  const root = await scratchRoot('promotion-cas');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const paths = promotionPaths(root);
  await fsp.writeFile(paths.compositionPath, '[]\n');
  await fsp.writeFile(paths.evolutionPath, '# Evolution\n\n## 实验指针\n- last experiment: none\n');
  paths.promotionRuntime = unitPromotionRuntime();

  const external = '# Evolution\n\n## External note\n- edited by another writer\n';
  const originalWriteFile = fsp.writeFile;
  let injected = false;
  fsp.writeFile = async function injectedWriteFile(file, ...rest) {
    // The plugin module is written after the before-digests were captured and
    // before the composition/EVOLUTION.md/archive commit, so this is the
    // documented concurrent-edit window.
    if (!injected && String(file).endsWith('.tmp') && String(file).startsWith(paths.pluginRoot)) {
      injected = true;
      await originalWriteFile.call(this, paths.evolutionPath, external, 'utf8');
    }
    return originalWriteFile.call(this, file, ...rest);
  };
  let error;
  try {
    await writeDurablePromotion({ experiment: promotionExperiment('exp-cas'), paths, packageInspection: { code: { host: HOST_CODE } } });
  } catch (caught) {
    error = caught;
  } finally {
    fsp.writeFile = originalWriteFile;
  }

  assert.ok(error, 'the promotion was refused');
  assert.equal(injected, true, 'the concurrent edit happened inside the commit window');
  assert.equal(await fsp.readFile(paths.evolutionPath, 'utf8'), external, 'the external edit is preserved');
  assert.equal(await fsp.readFile(paths.compositionPath, 'utf8'), '[]\n', 'the composition was not committed');
  const journal = await readJournal(paths);
  assert.equal(journal.phase, 'rollback-failed');
  assert.ok(journal.rollbackFailures.some(failure => failure.target === paths.evolutionPath), JSON.stringify(journal.rollbackFailures));
  assert.match(error.message, /rollback failed/);
});

test('P3-17 the normal commit still writes EVOLUTION.md when nothing was edited', async t => {
  const root = await scratchRoot('promotion-cas-clean');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const paths = promotionPaths(root);
  await fsp.writeFile(paths.compositionPath, '[]\n');
  await fsp.writeFile(paths.evolutionPath, '# Evolution\n\n## 实验指针\n- last experiment: none\n');
  paths.promotionRuntime = unitPromotionRuntime();
  const durable = await writeDurablePromotion({ experiment: promotionExperiment('exp-clean'), paths, packageInspection: { code: { host: HOST_CODE } } });
  const evolution = await fsp.readFile(paths.evolutionPath, 'utf8');
  assert.match(evolution, /exp-clean/);
  assert.match(evolution, /last experiment: exp-clean/);
  const rows = await fsp.readFile(paths.compositionPath, 'utf8');
  assert.match(rows, /evolution-promoted-/);
  // The journal survives as canary-observing, which is the normal commit result.
  assert.equal((await readJournal(paths)).phase, 'canary-observing');
  assert.equal((await recoverInterruptedPromotion(paths)).status, 'canary-pending');
});
