// A canary rollback must keep the target visible to discovery.
//
// `recordEvolution` merges `canary-passed` and `canary-failed` into one canonical
// row, so a rolled-back promotion still carries `successCount >= 1` from its
// earlier stable commit. The planner used to treat *any* row with a success
// count as a resolution, which made a target that had just failed in canary
// disappear from `evolution_plan` as "already-resolved" until another raw
// failure happened. The newest outcome decides, not the lifetime counter.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openSharedExperience } from '../lib/shared-experience.js';
import { planEvolutionCandidates, strategyFingerprint } from '../lib/experience-plan.js';

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-resolution-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function replayRollback(root) {
  const store = openSharedExperience(root);
  let sequence = 0;
  const bridge = path.join(root, 'bridge.jsonl');
  const receipt = () => ({ sequence: (sequence += 1), writer: 'rollback-fixture-writer' });
  const id = (n) => n.toString(16).padStart(2, '0').repeat(32);
  for (let n = 1; n <= 4; n += 1) {
    store.recordFailure({ id: id(n), type: 'tool/error', code: 'TOOL_FAILED', target: 'tool:read',
      metrics: { attemptsSinceFailure: 5, successesSinceFailure: 1 } }, 'collector', receipt());
  }
  const stable = '2026-11-20T00:00:00.000Z';
  const event = (type, experimentId, at) => store.recordEvolution({
    eventType: type, eventId: `evolution:${type}:${experimentId}`, target: 'tool:read', audit: { at },
  }, bridge, receipt());
  event('promotion-succeeded', 'exp-1', stable);
  event('canary-passed', 'exp-1', stable);
  event('promotion-succeeded', 'exp-2', stable);
  store.recordConclusion({
    experimentId: 'exp-2', target: 'tool:read', strategy: 'add a streaming read tool',
    strategyFingerprint: strategyFingerprint('tool:read', 'add a streaming read tool'),
    rootCause: '', failureMode: 'regression', decision: 'regression',
    metrics: { successRateDelta: -0.2, errorsDelta: 2 },
    applicability: { dsh: '0.2.2-rc.5', cordis: '4.0.0', evolution: '0.2.18' },
    occurredAt: new Date().toISOString(),
  }, bridge, receipt());
  event('canary-failed', 'exp-2', new Date(Date.now() + 2).toISOString());
  const knowledge = store.discover({ window: 500 }).records;
  const versions = { dsh: '0.2.2-rc.5', cordis: '4.0.0', evolution: '0.2.18' };
  const plan = planEvolutionCandidates({ knowledge, failureMemory: [], versions });
  return { store, knowledge, plan };
}

test('a canary rollback keeps the target discoverable instead of "already-resolved"', (t) => {
  const { store, plan } = replayRollback(scratch(t));
  t.after(() => store.close());
  const keys = plan.candidates.map((candidate) => candidate.problemKey);
  assert.ok(keys.includes('tool read'), `expected the rolled-back target to stay a candidate, got ${JSON.stringify(plan.rejected)}`);
  assert.equal(plan.rejected.some((row) => row.reason === 'already-resolved'), false);
  assert.equal(plan.none?.reason, undefined);
  const conclusive = plan.candidates.find((candidate) => candidate.problemKey === 'tool read');
  assert.ok(conclusive.provenIneffective?.some((row) => row.decision === 'regression'),
    'the rollback conclusion must still be reported as prior ineffective evidence');
});

test('the loop cannot manufacture a candidate from its own failed experiments', (t) => {
  const root = scratch(t);
  const store = openSharedExperience(root);
  t.after(() => store.close());
  let sequence = 0;
  const bridge = path.join(root, 'bridge.jsonl');
  for (const experimentId of ['e1', 'e2', 'e3']) {
    store.recordEvolution({ eventType: 'failure-learned', eventId: `evolution:failure-learned:${experimentId}`,
      target: 'tool:read', failureMode: 'experiment-failed' }, bridge,
    { sequence: (sequence += 1), writer: 'rollback-fixture-writer' });
  }
  const plan = planEvolutionCandidates({ knowledge: store.discover({ window: 500 }).records, failureMemory: [] });
  assert.deepEqual(plan.candidates.map((candidate) => candidate.problemKey), [],
    'three failed experiments are not three observed failures of the target');
});

test('historical experiment-failed rows in an upgraded store are not problem evidence', () => {
  // Databases written by the old code still contain failure-learned rows. The
  // ledger is preserved, but these rows describe the loop's own experiments.
  const legacy = [{
    scope: 'tool read', problem: 'official operation failure experiment-failure',
    issueType: 'problem', failureMode: 'experiment-failure', occurrences: 3, failureCount: 3,
    lastSeen: new Date().toISOString(), key: 'knowledge:legacy-experiment-failed',
  }];
  const plan = planEvolutionCandidates({ knowledge: legacy, failureMemory: [] });
  assert.deepEqual(plan.candidates.map((candidate) => candidate.problemKey), []);
  // The same row with a real problem mode becomes a candidate: the empty result
  // above is caused by the lifecycle filter, not by a malformed fixture.
  const control = planEvolutionCandidates({
    knowledge: legacy.map((row) => ({ ...row, failureMode: 'real-tool-failure' })),
    failureMemory: [],
  });
  assert.deepEqual(control.candidates.map((candidate) => candidate.problemKey), ['tool read']);
});
