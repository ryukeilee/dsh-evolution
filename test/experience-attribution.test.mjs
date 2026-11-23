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

test('the planner labels a bare tool-failure counter and withholds the workflow model', () => {
  const planned = planEvolutionCandidates({ knowledge: [failure({ problem: 'official operation failure host operation failure' })], failureMemory: [] }, { minOccurrences: 2 });
  assert.equal(planned.candidates.length, 1);
  assert.equal(planned.candidates[0].attribution, 'unattributed');
  assert.equal(planned.candidates[0].benefitModel, undefined);
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
test('collector records the success/failure denominator with each failure', async (t) => {
  const { Context } = await import('@deepseek-ai/cordis');
  const { apply: applyCollector } = await import('../lib/experience-collector.js');
  const root = temporary(t);
  const app = new Context();
  app.provide('tools', { register() {} });
  const fiber = app.plugin(applyCollector, { dshHome: root });
  await fiber.await();
  try {
    const agent = { id: 'denominator-agent' };
    for (let index = 0; index < 3; index += 1) {
      app.emit('tools/result', { callId: 'ok-' + index, name: 'bash', agent }, { isError: false });
    }
    app.emit('tools/result', { callId: 'bad-1', name: 'bash', agent }, {
      isError: true,
      error: { message: 'no such file', info: { name: 'BashError', code: 'FS_NOT_FOUND' } },
    });
    const store = app.get('evolutionExperience').store;
    const [record] = store.recall({ problem: 'bash' }).records;
    assert.equal(record.metrics.attemptssincefailure.sum, 4, 'three successes plus the failure');
    assert.equal(record.metrics.successessincefailure.sum, 3);
    assert.match(record.problem, /fs missing/, 'the host code reaches the semantic fact');
  } finally {
    await fiber.dispose();
  }
});

test('the planner exposes a real denominator, classifies origin and names the benefit model', () => {
  const measured = planEvolutionCandidates({
    knowledge: [{
      key: 'knowledge:measured', scope: 'tool run code', problem: 'official operation failure code run failure',
      failureCount: 10, occurrences: 10, lastSeen: now(),
      metrics: { attemptssincefailure: { sum: 40, count: 10 }, successessincefailure: { sum: 30, count: 10 } },
    }],
    failureMemory: [],
  }, { minOccurrences: 2 });
  const candidate = measured.candidates[0];
  assert.equal(candidate.observedAttempts, 40);
  assert.equal(candidate.observedSuccesses, 30);
  assert.equal(candidate.observedFailureRate, 0.25);
  assert.equal(candidate.rateBasis, 'observed-window');
  assert.equal(candidate.origin, 'unknown');
  assert.deepEqual(candidate.benefitModel, { kind: 'workflow', metric: 'failureRate' });

  const caller = planEvolutionCandidates({
    knowledge: [{
      key: 'knowledge:caller', scope: 'tool apply patch', problem: 'official operation failure fs patch mismatch',
      failureCount: 5, occurrences: 5, lastSeen: now(),
    }],
    failureMemory: [],
  }, { minOccurrences: 2 });
  assert.equal(caller.candidates.length, 0);
  assert.equal(caller.rejected[0].reason, 'caller-input');
});
test('the observed rate uses the window denominator, not the all-time count', () => {
  const planned = planEvolutionCandidates({
    knowledge: [{
      key: 'knowledge:window', scope: 'tool run code', problem: 'official operation failure code run failure',
      failureCount: 97, occurrences: 97, lastSeen: now(),
      metrics: { attemptssincefailure: { sum: 40, count: 10 }, successessincefailure: { sum: 30, count: 10 } },
    }],
    failureMemory: [],
  }, { minOccurrences: 2 });
  assert.equal(planned.candidates[0].observedAttempts, 40);
  assert.equal(planned.candidates[0].observedFailureRate, 0.25);
});

test('normalized failure modes are classified on their stored spelling', () => {
  const planned = planEvolutionCandidates({
    knowledge: [{
      key: 'knowledge:edit', scope: 'tool edit', problem: 'official operation failure fs edit missing',
      failureCount: 4, occurrences: 4, lastSeen: now(),
    }],
    failureMemory: [],
  }, { minOccurrences: 2 });
  assert.equal(planned.candidates.length, 0);
  assert.equal(planned.rejected[0].reason, 'caller-input');
});

test('a host-origin target does not declare a workflow benefit model', () => {
  const planned = planEvolutionCandidates({
    knowledge: [{
      key: 'knowledge:host', scope: 'tool bash', problem: 'official operation failure composition guard denied',
      failureCount: 5, occurrences: 5, lastSeen: now(),
    }],
    failureMemory: [],
  }, { minOccurrences: 2 });
  assert.equal(planned.candidates[0].origin, 'host');
  assert.equal(planned.candidates[0].benefitModel, undefined);
});

test('one caller-input shape does not discard a target dominated by other causes', () => {
  // Production 2026-11-23: `tool run code` held 111 unattributed plus 54
  // `code run failure` occurrences and 2 `invalid args` ones. Joining every
  // mode and testing the union classified the whole target as caller input, so
  // the largest recorded loss disappeared from `candidates` *and* from the
  // bounded `rejected` list.
  const planned = planEvolutionCandidates({
    knowledge: [
      { key: 'knowledge:a', scope: 'tool run code', problem: 'official operation failure host operation failure', failureCount: 111, occurrences: 111, lastSeen: now() },
      { key: 'knowledge:b', scope: 'tool run code', problem: 'official operation failure code run failure', failureCount: 54, occurrences: 54, lastSeen: now() },
      { key: 'knowledge:c', scope: 'tool run code', problem: 'official operation failure invalid args', failureCount: 2, occurrences: 2, lastSeen: now() },
    ],
    failureMemory: [],
  }, { minOccurrences: 2 });
  const candidate = planned.candidates.find((entry) => entry.problemKey === 'tool run code');
  assert.ok(candidate, `the largest loss was discarded: ${JSON.stringify(planned.rejected)}`);
  assert.equal(candidate.occurrences, 167);
  assert.equal(candidate.origin, 'unknown');
  assert.deepEqual(candidate.originCounts, { unknown: 165, 'caller-input': 2 });
});

test('a target dominated by caller input stays rejected and names what it hid', () => {
  const planned = planEvolutionCandidates({
    knowledge: [
      { key: 'knowledge:a', scope: 'tool apply patch', problem: 'official operation failure fs patch mismatch', failureCount: 9, occurrences: 9, lastSeen: now() },
      { key: 'knowledge:b', scope: 'tool apply patch', problem: 'official operation failure host operation failure', failureCount: 4, occurrences: 4, lastSeen: now() },
    ],
    failureMemory: [],
  }, { minOccurrences: 2 });
  assert.equal(planned.candidates.length, 0);
  assert.equal(planned.rejected[0].reason, 'caller-input');
  assert.deepEqual(planned.rejected[0].origins, { 'caller-input': 9, unknown: 4 });
  assert.match(planned.rejected[0].detail, /9 of 13/);
  assert.match(planned.rejected[0].detail, /fs patch mismatch/);
  assert.equal(planned.none.reason, 'caller-input');
});

test('rejections are ordered by recorded loss so the cap cannot hide the biggest one', () => {
  const nowIso = now();
  const thin = Array.from({ length: 12 }, (_, index) => ({
    key: `knowledge:thin-${index}`,
    scope: `tool thin-${String(index).padStart(2, '0')}`,
    problem: 'official operation failure timeout',
    failureCount: 1,
    occurrences: 1,
    lastSeen: nowIso,
  }));
  const big = { key: 'knowledge:big', scope: 'tool zzz-big', problem: 'official operation failure fs patch mismatch', failureCount: 43, occurrences: 43, lastSeen: nowIso };
  const planned = planEvolutionCandidates({ knowledge: [...thin, big], failureMemory: [] }, { minOccurrences: 2 });
  assert.equal(planned.candidates.length, 0);
  assert.equal(planned.rejected[0].problemKey, 'tool zzz-big');
  assert.ok(planned.rejected.length <= 10);
});

test('a __proto__ metric key survives the projection as own data', async () => {
  const { knowledgeExperienceRecord } = await import('../lib/experience-recall.js');
  const metrics = Object.fromEntries([['__proto__', { sum: 1, count: 1, last: 1 }]]);
  const record = knowledgeExperienceRecord({
    knowledgeKey: 'knowledge:proto-metric',
    semanticFact: 'official operation failure code run failure',
    scope: 'tool run code',
    effectStats: { metrics },
  });
  assert.equal(Object.getPrototypeOf(record.metrics), Object.prototype);
  assert.equal(Object.hasOwn(record.metrics, '__proto__'), true);
  assert.equal(record.metrics['__proto__'].sum, 1);
});
