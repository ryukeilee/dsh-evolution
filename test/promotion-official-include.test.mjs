import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { assertPromotableHostSource, writeDurablePromotion, recoverInterruptedPromotion } from '../lib/orchestrator.js';

const host = 'return { name: "standalone", apply(ctx) { ctx.on("probe", () => {}); } };';
test('standalone synchronous Host only; harness helpers and async bodies fail closed', () => {
  assert.doesNotThrow(() => assertPromotableHostSource(host));
  for (const code of ['return { apply() { harness.handle("x", () => {}); } };', 'const h = harness; return { apply() {} };', 'await Promise.resolve(); return { apply() {} };']) {
    assert.throws(() => assertPromotableHostSource(code), /Promotion/);
  }
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'promotion-include-unit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = { presetId: 'test', presetDir: root, pluginRoot: path.join(root, 'promoted'), compositionPath: path.join(root, 'promoted.cordis.yml'), evolutionPath: path.join(root, 'EVOLUTION.md'), archiveDir: path.join(root, 'archive'), promotionStateDir: path.join(root, 'promotion'), promotionLockPath: path.join(root, 'promotion.lock') };
  await fs.writeFile(paths.compositionPath, '[]\n');
  // Unit-level I/O contract only, NOT an official integration substitute.
  paths.promotionRuntime = { parse: JSON.parse, stringify: rows => JSON.stringify(rows), refresh: async () => {}, verify: async () => ({ officialInclude: true, active: true }) };
  const experiment = { id: 'exp-unit-1', ownerId: 'unit', state: 'promoting', proposal: { owner: 'unit', why: 'unit', target: 'plugin:unit', impactScope: ['test'], successMetrics: ['unit'], createdAt: '2026-01-01' }, runtimeRecovered: true, observations: [{ sampleCount: 2 }], latestObservation: { sampleCount: 2 } };
  return { root, paths, experiment };
}

test('journaled composition uses absolute file URL and no profile mount; interrupted canary rollback restores disk', async t => {
  const { root, paths, experiment } = await fixture(t);
  const durable = await writeDurablePromotion({ experiment, paths, packageInspection: { code: { host } } });
  const rows = JSON.parse(await fs.readFile(paths.compositionPath, 'utf8'));
  assert.equal(rows[0].name, pathToFileURL(path.join(durable.pluginPath, 'lib/index.js')).href);
  assert.equal(durable.adapter, 'official-include');
  assert.equal(durable.linkPath, undefined);
  const journalFile = path.join(paths.promotionStateDir, 'journal.json');
  const journal = JSON.parse(await fs.readFile(journalFile, 'utf8'));
  assert.equal(journal.records.some(r => r.type === 'symlink'), false);
  assert.equal(journal.evidenceSnapshot.latestObservation.sampleCount, 2);
  journal.phase = 'committing';
  await fs.writeFile(journalFile, JSON.stringify(journal));
  assert.equal((await recoverInterruptedPromotion(paths)).status, 'rolled-back');
  assert.equal(await fs.readFile(paths.compositionPath, 'utf8'), '[]\n');
  await assert.rejects(fs.access(durable.pluginPath));
  assert.equal((await fs.readdir(root)).includes('node_modules'), false);
});

test('rollback CAS preserves concurrent composition edits and its recovery journal', async t => {
  const { paths, experiment } = await fixture(t);
  await writeDurablePromotion({ experiment, paths, packageInspection: { code: { host } } });
  const journalFile = path.join(paths.promotionStateDir, 'journal.json');
  const journal = JSON.parse(await fs.readFile(journalFile, 'utf8'));
  journal.phase = 'committing';
  await fs.writeFile(journalFile, JSON.stringify(journal));
  const edited = '[{"id":"external","name":"external-plugin"}]';
  await fs.writeFile(paths.compositionPath, edited);
  await assert.rejects(recoverInterruptedPromotion(paths), /rollback failed/);
  assert.equal(await fs.readFile(paths.compositionPath, 'utf8'), edited);
  assert.equal(JSON.parse(await fs.readFile(journalFile, 'utf8')).phase, 'rollback-failed');
});

test('client half and missing official adapter never write a promotion', async t => {
  const { paths, experiment } = await fixture(t);
  await assert.rejects(writeDurablePromotion({ experiment, paths, packageInspection: { code: { host, client: '' } } }), /Host-only/);
  paths.promotionRuntime = undefined;
  await assert.rejects(writeDurablePromotion({ experiment, paths, packageInspection: { code: { host } } }), /official Include/);
  assert.equal(await fs.readFile(paths.compositionPath, 'utf8'), '[]\n');
});
