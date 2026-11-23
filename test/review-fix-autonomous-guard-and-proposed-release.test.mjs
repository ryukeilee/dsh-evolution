import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { EvolutionOrchestrator } from '../lib/orchestrator.js';
import { context } from './fixtures/runtime-inspect.mjs';

async function makeCore(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-review-fix-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ctx = context();
  ctx.logger = { warn() {} };
  const core = new EvolutionOrchestrator(ctx, {
    presetDir: root,
    startupDrift: false,
    eventBridgePath: path.join(root, 'events.jsonl'),
    eventBridgeKey: 'k'.repeat(32),
    driftStatePath: path.join(root, 'drift.json'),
    memoryPath: path.join(root, 'memory.json'),
    patternThreshold: 2,
    mode: 'autonomous',
    unattended: true,
  });
  return { root, core };
}

test('cleanupAutonomousTrial keeps a proposed record when target release fails', async (t) => {
  const { core } = await makeCore(t);
  const record = {
    id: 'exp-proposed-1',
    state: 'proposed',
    autonomous: { patternKey: 'p', strategyFingerprint: 'f' },
    targets: ['plugin:fix-x'],
    targetsAcquired: true,
    ownerId: 'owner',
  };
  core.experiments.set(record.id, record);

  core.releaseTargets = (r) => { r.targetsAcquired = true; };
  const result = await core.cleanupAutonomousTrial(record.id, { agent: { id: 'owner' }, signal: new AbortController().signal });
  assert.equal(result.status, 'not-recovered');
  assert.ok(core.experiments.has(record.id), 'proposed record discarded despite failed release');
  assert.equal(record.targetsAcquired, true);

  core.releaseTargets = (r) => { r.targetsAcquired = false; };
  const result2 = await core.cleanupAutonomousTrial(record.id, { agent: { id: 'owner' }, signal: new AbortController().signal });
  assert.equal(result2.status, 'discarded');
  assert.equal(core.experiments.has(record.id), false);
});

