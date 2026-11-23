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
test('one caller-input mode does not discard a tool target with actionable failures', () => {
  const now = new Date().toISOString();
  const planned = planEvolutionCandidates({
    knowledge: [
      {
        key: 'knowledge:run-code-failures', scope: 'tool run code',
        problem: 'official operation failure code run failure',
        failureCount: 54, occurrences: 54, lastSeen: now,
        metrics: { attemptssincefailure: { sum: 1955, count: 54 }, successessincefailure: { sum: 1901, count: 54 } },
      },
      {
        key: 'knowledge:run-code-args', scope: 'tool run code',
        problem: 'official operation failure invalid args',
        failureCount: 2, occurrences: 2, lastSeen: now,
      },
    ],
    failureMemory: [],
  }, { minOccurrences: 3 });
  const candidate = planned.candidates.find((entry) => entry.problemKey === 'tool run code');
  assert.ok(candidate, `the mixed origin discarded the target: ${JSON.stringify(planned.rejected)}`);
  // The group is no longer labelled as caller input as a whole; the excluded
  // mode is reported beside it instead of silently changing the verdict.
  assert.equal(candidate.origin, 'unknown');
  assert.equal(candidate.mixedOrigin, true);
  assert.deepEqual(candidate.excludedModes, ['invalid args']);
  assert.doesNotMatch(candidate.whyCordisPlugin, /^$|caller/i);
  assert.deepEqual(candidate.benefitModel, { kind: 'workflow', metric: 'failureRate' });
});

test('an actionable mode beyond the first three still prevents a caller-input rejection', () => {
  const now = new Date().toISOString();
  const row = (key, problem, occurrences = 2) => ({
    key, scope: 'tool run code', problem, failureCount: occurrences, occurrences, lastSeen: now,
  });
  const planned = planEvolutionCandidates({
    knowledge: [
      row('knowledge:missing', 'official operation failure fs edit missing'),
      row('knowledge:mismatch', 'official operation failure fs patch mismatch'),
      row('knowledge:args', 'official operation failure invalid args'),
      row('knowledge:code', 'official operation failure code run failure', 6),
    ],
    failureMemory: [],
  }, { minOccurrences: 3 });
  const candidate = planned.candidates.find((entry) => entry.problemKey === 'tool run code');
  assert.ok(candidate, `the fourth mode was dropped before classification: ${JSON.stringify(planned.rejected)}`);
  assert.equal(candidate.origin, 'unknown');
  assert.equal(candidate.mixedOrigin, true);
  assert.equal(candidate.failureModes[0], 'code run failure', 'the actionable cause is listed first');
  assert.deepEqual(candidate.excludedModes, ['fs edit missing', 'fs patch mismatch', 'invalid args']);
});

test('the classification is not bounded by the display list', () => {
  const now = new Date().toISOString();
  const caller = Array.from({ length: 24 }, (_, index) => ({
    key: 'knowledge:caller-' + index,
    scope: 'tool run code',
    // Distinct mode strings, so a 24-mode identity cap cannot pass this test.
    problem: 'official operation failure invalid args case-' + index,
    failureCount: 1, occurrences: 1, lastSeen: now,
  }));
  const planned = planEvolutionCandidates({
    knowledge: [...caller, {
      key: 'knowledge:code-25', scope: 'tool run code',
      problem: 'official operation failure code run failure',
      failureCount: 5, occurrences: 5, lastSeen: now,
    }],
    failureMemory: [],
  }, { minOccurrences: 3 });
  const candidate = planned.candidates.find((entry) => entry.problemKey === 'tool run code');
  assert.ok(candidate, `the 25th mode was dropped: ${JSON.stringify(planned.rejected)}`);
  assert.equal(candidate.origin, 'unknown');
  assert.equal(candidate.failureModes[0], 'code run failure');
});

test('the mixed origin does not depend on record order', () => {
  const now = new Date().toISOString();
  const row = (key, problem) => ({ key, scope: 'tool bash', problem, failureCount: 3, occurrences: 3, lastSeen: now });
  const plan = (rows) => planEvolutionCandidates({ knowledge: rows, failureMemory: [] }, { minOccurrences: 3 });
  const forward = plan([
    row('knowledge:code', 'official operation failure code run failure'),
    row('knowledge:guard', 'official operation failure composition guard denied'),
  ]);
  const reverse = plan([
    row('knowledge:guard', 'official operation failure composition guard denied'),
    row('knowledge:code', 'official operation failure code run failure'),
  ]);
  assert.equal(forward.candidates[0].origin, 'host');
  assert.equal(reverse.candidates[0].origin, 'host');
  assert.equal(forward.candidates[0].benefitModel, undefined);
  assert.equal(reverse.candidates[0].benefitModel, undefined);
});

test('a group whose modes are all caller input still stays rejected', () => {
  const now = new Date().toISOString();
  const planned = planEvolutionCandidates({
    knowledge: [
      {
        key: 'knowledge:patch-a', scope: 'tool apply patch',
        problem: 'official operation failure fs patch mismatch',
        failureCount: 32, occurrences: 32, lastSeen: now,
      },
      {
        key: 'knowledge:patch-b', scope: 'tool apply patch',
        problem: 'official operation failure fs edit missing',
        failureCount: 2, occurrences: 2, lastSeen: now,
      },
    ],
    failureMemory: [],
  }, { minOccurrences: 3 });
  assert.equal(planned.candidates.length, 0);
  assert.equal(planned.rejected[0].reason, 'caller-input');
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
