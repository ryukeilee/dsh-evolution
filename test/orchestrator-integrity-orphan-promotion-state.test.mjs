// P1-3: a promotion state directory without journal.json is an unknown live
// field, not "no transaction". Recovery must refuse it, and a later promotion
// must not delete it (AGENTS.md invariant 2: never guess, merge or delete
// persistent state that cannot be classified).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { recoverInterruptedPromotion, writeDurablePromotion } from '../lib/orchestrator.js';

const host = 'return { name: "standalone", apply(ctx) { ctx.on("probe", () => {}); } };';

async function scratch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-integrity-orphan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function fixture(t, name) {
  const root = await scratch(t);
  const paths = {
    presetId: 'test', presetDir: root,
    pluginRoot: path.join(root, 'promoted'),
    compositionPath: path.join(root, 'promoted.cordis.yml'),
    evolutionPath: path.join(root, 'EVOLUTION.md'),
    archiveDir: path.join(root, 'archive'),
    promotionStateDir: path.join(root, 'promotion'),
    promotionLockPath: path.join(root, 'promotion.lock'),
  };
  await fs.writeFile(paths.compositionPath, '[]\n');
  paths.promotionRuntime = {
    parse: JSON.parse,
    stringify: (rows) => JSON.stringify(rows),
    refresh: async () => {},
    verify: async () => ({ officialInclude: true, active: true }),
    health: async () => ({ componentHealth: 'active', dependenciesPresent: true }),
  };
  const experiment = {
    id: `exp-orphan-${name}`, ownerId: 'orphan-owner', state: 'promoting',
    proposal: { owner: 'orphan-owner', why: 'orphan', target: 'plugin:orphan', impactScope: ['test'], successMetrics: ['unit'], createdAt: '2026-01-01' },
    runtimeRecovered: true, observations: [{ sampleCount: 2 }], latestObservation: { sampleCount: 2 },
  };
  return { root, paths, experiment };
}

// Copy back exactly the on-disk shape an interrupted promotion leaves behind.
async function orphanState(paths) {
  const backups = path.join(paths.promotionStateDir, 'backups');
  const stage = path.join(paths.promotionStateDir, 'stage');
  await fs.mkdir(backups, { recursive: true, mode: 0o700 });
  await fs.mkdir(stage, { recursive: true });
  await fs.writeFile(path.join(backups, 'aaaaaaaaaaaaaaaa.bak'), 'original composition bytes\n');
  await fs.writeFile(path.join(stage, 'staged-plugin.js'), 'export const staged = true;\n');
  await fs.writeFile(path.join(paths.promotionStateDir, 'leftover.txt'), 'evidence that provenance is unknown\n');
}

async function snapshot(dir) {
  const entries = {};
  const walk = async (current) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else entries[path.relative(dir, full)] = await fs.readFile(full, 'utf8');
    }
  };
  await walk(dir);
  return entries;
}

const refusal = (error) => {
  assert.equal(error instanceof TypeError, false, 'a refusal must be a clean Error, not a crash');
  assert.match(error.message, /promotion state directory|state without a journal|unknown/i);
  return true;
};

test('recovery refuses a promotion state directory without journal.json and leaves its bytes alone', async (t) => {
  const { paths } = await fixture(t, 'recover');
  await orphanState(paths);
  const before = await snapshot(paths.promotionStateDir);

  await assert.rejects(recoverInterruptedPromotion(paths), refusal);
  assert.deepEqual(await snapshot(paths.promotionStateDir), before, 'the orphan field must stay byte-for-byte');
});

test('a promotion is refused instead of recursively deleting an orphan state directory', async (t) => {
  const { root, paths, experiment } = await fixture(t, 'promote');
  await orphanState(paths);
  const before = await snapshot(paths.promotionStateDir);

  await assert.rejects(
    writeDurablePromotion({ experiment, paths, packageInspection: { code: { host } } }),
    refusal,
  );
  assert.deepEqual(await snapshot(paths.promotionStateDir), before, 'the backups, stage and evidence survive');
  assert.equal(await fs.readFile(paths.compositionPath, 'utf8'), '[]\n', 'the composition is untouched');
  assert.equal(await fs.readdir(root).then((names) => names.includes('promoted')), false, 'no plugin directory was created');
  assert.equal((await fs.readdir(root)).includes('promotion.lock'), false, 'the promotion lock is released');
});

test('an absent state directory is still "no transaction", and a clean promotion still works', async (t) => {
  const { paths, experiment } = await fixture(t, 'clean');
  assert.deepEqual(await recoverInterruptedPromotion(paths), { recovered: false, status: 'none' });

  const durable = await writeDurablePromotion({ experiment, paths, packageInspection: { code: { host } } });
  assert.match(durable.pluginName, /^dsh-evolution-promoted-/);
  const journal = JSON.parse(await fs.readFile(path.join(paths.promotionStateDir, 'journal.json'), 'utf8'));
  assert.equal(journal.phase, 'canary-observing', 'the clean write completes through the committing phase');
  assert.equal(journal.experimentId, experiment.id);
});

test('an unreadable journal keeps the existing fail-closed behavior and its bytes', async (t) => {
  const { paths } = await fixture(t, 'unreadable');
  await fs.mkdir(paths.promotionStateDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(paths.promotionStateDir, 'journal.json'), '{"version":1,');
  const before = await snapshot(paths.promotionStateDir);

  await assert.rejects(recoverInterruptedPromotion(paths), (error) => {
    assert.equal(error instanceof TypeError, false);
    assert.match(error.message, /unreadable/);
    return true;
  });
  await assert.rejects(writeDurablePromotion({ experiment: { id: 'exp-x', ownerId: 'o', proposal: { owner: 'o', why: 'w', target: 't', impactScope: [], successMetrics: [] } }, paths, packageInspection: { code: { host } } }));
  assert.deepEqual(await snapshot(paths.promotionStateDir), before, 'the unreadable journal stays in place');
});
