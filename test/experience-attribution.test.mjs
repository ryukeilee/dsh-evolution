// Failure attribution: the collector must record the host's structured failure
// code, and the planner must refuse a bare tool-failure counter that names no
// cause. Before 2026-11-17 every failure was stored as HOST_OPERATION_FAILED
// (the collector read a nonexistent `result.code`), so "tool run code" was one
// unattributable bucket and any new deterministic tool could be promoted
// against it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openSharedExperience, experienceEventId } from '../lib/shared-experience.js';
import { toolFailureCode } from '../lib/experience-collector.js';
import { planEvolutionCandidates } from '../lib/experience-plan.js';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-attribution-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('toolFailureCode reads the official ToolFailure shape, not a top-level code', () => {
  assert.equal(toolFailureCode({ isError: true, error: { message: 'x', info: { name: 'GuardError', code: 'CODE_RUN_FAILED' } } }), 'CODE_RUN_FAILED');
  assert.equal(toolFailureCode({ isError: true, error: { code: 'FS_NOT_FOUND' } }), 'FS_NOT_FOUND');
  assert.equal(toolFailureCode({ isError: true, code: 'LEGACY' }), 'LEGACY');
  assert.equal(toolFailureCode({ isError: true }), undefined);
});

test('a specific host code reaches storage as a distinct fact without changing the event shape', (t) => {
  const root = temporary(t);
  const store = openSharedExperience(root);
  t.after(() => store.close());
  store.recordFailure({ id: experienceEventId('a', 1), type: 'tool/error', code: 'CODE_RUN_FAILED', target: 'tool:run_code' });
  store.recordFailure({ id: experienceEventId('a', 2), type: 'tool/error', code: 'FS_PATCH_MISMATCH', target: 'tool:apply_patch' });
  store.recordFailure({ id: experienceEventId('a', 3), type: 'tool/error', code: 'HOST_OPERATION_FAILED', target: 'tool:bash' });
  const records = store.recall({ problem: 'run_code' }).records;
  // The stored row keeps the frozen shape: no `failureMode`, but the code
  // survives in the semantic fact the planner reads.
  assert.equal(records[0].failureMode ?? '', '');
  assert.match(records[0].problem, /code run fail/);
  assert.equal(store.stats().knowledge, 3);
  const generic = store.recall({ problem: 'bash' }).records[0];
  assert.ok(!generic.failureMode, 'the generic placeholder must not claim a mode');
});

const now = () => new Date().toISOString();
const failure = (over) => ({ key: 'knowledge:' + Math.random().toString(16).slice(2), scope: 'tool run code', failureCount: 2, occurrences: 2, lastSeen: now(), ...over });

test('the planner rejects a bare tool-failure counter that names no cause', () => {
  const planned = planEvolutionCandidates({ knowledge: [failure({ problem: 'official operation failure host operation failure' })], failureMemory: [] }, { minOccurrences: 2 });
  assert.equal(planned.candidates.length, 0);
  assert.equal(planned.rejected[0].reason, 'unattributed');
  assert.equal(planned.none.reason, 'unattributed');
});

test('a code-derived failure mode or a conclusion root cause makes the target proposable', () => {
  const classified = planEvolutionCandidates({
    knowledge: [failure({ scope: 'tool run code', problem: 'official operation failure code run failure' })],
    failureMemory: [],
  }, { minOccurrences: 2 });
  assert.equal(classified.candidates.length, 1);
  assert.equal(classified.candidates[0].attribution, 'classified');
  assert.deepEqual(classified.candidates[0].failureModes, ['code run failure']);
  const concluded = planEvolutionCandidates({
    knowledge: [failure({ scope: 'tool apply patch', strategy: JSON.stringify({ kind: 'cordis-plugin', approach: 'a', fingerprint: 'abcdef0123456789', dsh: '1', cordis: '2', evolution: '3' }), rootCause: 'patch context drifted', decision: 'no-benefit' })],
    failureMemory: [],
  }, { minOccurrences: 2 });
  assert.equal(concluded.candidates.length, 1);
  assert.equal(concluded.candidates[0].attribution, 'classified');
});
