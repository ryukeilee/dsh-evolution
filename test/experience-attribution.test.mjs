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
test('a caller-input failure cannot lift one actionable failure over the floor', () => {
  const now = new Date().toISOString();
  const planned = planEvolutionCandidates({
    knowledge: [
      {
        key: 'knowledge:args', scope: 'tool run code',
        problem: 'official operation failure invalid args',
        failureCount: 100, occurrences: 100, lastSeen: now,
        metrics: { attemptssincefailure: { sum: 100, count: 100 }, successessincefailure: { sum: 0, count: 100 } },
      },
      {
        key: 'knowledge:code', scope: 'tool run code',
        problem: 'official operation failure code run failure',
        failureCount: 1, occurrences: 1, lastSeen: now,
        metrics: { attemptssincefailure: { sum: 10, count: 1 }, successessincefailure: { sum: 6, count: 1 } },
      },
    ],
    failureMemory: [],
  }, { minOccurrences: 3 });
  assert.equal(planned.candidates.length, 0);
  const rejected = planned.rejected.find((entry) => entry.problemKey === 'tool run code');
  assert.equal(rejected?.reason, 'insufficient-evidence');
  assert.equal(rejected?.occurrences, 1, 'only the actionable failure counts toward the floor');
});

test('a mixed target reports actionable occurrences and frequency, not the caller total', () => {
  const now = new Date().toISOString();
  const planned = planEvolutionCandidates({
    knowledge: [
      {
        key: 'knowledge:args', scope: 'tool run code',
        problem: 'official operation failure invalid args',
        failureCount: 100, occurrences: 100, lastSeen: now,
        metrics: { attemptssincefailure: { sum: 100, count: 100 }, successessincefailure: { sum: 0, count: 100 } },
      },
      {
        key: 'knowledge:code', scope: 'tool run code',
        problem: 'official operation failure code run failure',
        failureCount: 4, occurrences: 4, lastSeen: now,
        metrics: { attemptssincefailure: { sum: 10, count: 4 }, successessincefailure: { sum: 6, count: 4 } },
      },
    ],
    failureMemory: [],
  }, { minOccurrences: 3 });
  const candidate = planned.candidates.find((entry) => entry.problemKey === 'tool run code');
  assert.ok(candidate, JSON.stringify(planned.rejected));
  assert.equal(candidate.occurrences, 4);
  assert.equal(candidate.observedAttempts, 10);
  assert.equal(candidate.observedFailureRate, 0.4);
  assert.deepEqual(candidate.excludedModes, ['invalid args']);
  assert.equal(candidate.mixedOrigin, true);
});

test('a newer caller-input failure does not reopen an actionable resolved target', () => {
  const now = Date.now();
  const iso = (days) => new Date(now - days * 86_400_000).toISOString();
  const planned = planEvolutionCandidates({
    knowledge: [
      {
        key: 'knowledge:code', scope: 'tool run code',
        problem: 'official operation failure code run failure',
        failureCount: 4, occurrences: 4, lastSeen: iso(10),
        metrics: { attemptssincefailure: { sum: 10, count: 4 }, successessincefailure: { sum: 6, count: 4 } },
      },
      {
        key: 'knowledge:fixed', scope: 'tool run code',
        problem: 'official operation failure code run failure',
        successCount: 3, occurrences: 3, lastSeen: iso(5),
      },
      {
        key: 'knowledge:args', scope: 'tool run code',
        problem: 'official operation failure invalid args',
        failureCount: 100, occurrences: 100, lastSeen: iso(0),
        metrics: { attemptssincefailure: { sum: 100, count: 100 }, successessincefailure: { sum: 0, count: 100 } },
      },
    ],
    failureMemory: [],
  }, { minOccurrences: 3 });
  assert.equal(planned.candidates.length, 0);
  assert.equal(planned.rejected.find((entry) => entry.problemKey === 'tool run code')?.reason, 'already-resolved');
});

test('caller-input recency, regressions and refs do not raise a mixed target score', () => {
  const iso = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
  const actionable = {
    key: 'knowledge:code', scope: 'tool run code',
    problem: 'official operation failure code run failure',
    failureCount: 4, occurrences: 4, lastSeen: iso(10),
    metrics: { attemptssincefailure: { sum: 10, count: 4 }, successessincefailure: { sum: 6, count: 4 } },
  };
  const plan = (extra) => planEvolutionCandidates({ knowledge: [actionable, ...extra], failureMemory: [] }, { minOccurrences: 3 });
  const clean = plan([]).candidates.find((entry) => entry.problemKey === 'tool run code');
  const noisy = plan([{
    key: 'knowledge:args', scope: 'tool run code',
    problem: 'official operation failure invalid args',
    failureCount: 100, occurrences: 100, lastSeen: iso(0), regressionCount: 5,
    evidenceRefs: ['knowledge:args'], evidence: 'noisy',
    metrics: { attemptssincefailure: { sum: 100, count: 100 }, successessincefailure: { sum: 0, count: 100 } },
  }]).candidates.find((entry) => entry.problemKey === 'tool run code');
  assert.ok(clean && noisy, 'both plans should keep the actionable target');
  assert.equal(noisy.lastSeen, actionable.lastSeen);
  assert.equal(noisy.regressionCount, 0);
  assert.deepEqual(noisy.failureModes, ['code run failure']);
  assert.match(noisy.excludedModes.join(' '), /invalid args/);
  assert.ok(Math.abs(noisy.score - clean.score) < 0.0002, `caller evidence changed the score: ${clean.score} vs ${noisy.score}`);
});

test('a rootCause-only failure stays actionable beside caller-input rows', () => {
  const now = new Date().toISOString();
  const planned = planEvolutionCandidates({
    knowledge: [
      {
        key: 'knowledge:root-only', scope: 'tool run code',
        problem: 'host operation failure', rootCause: 'timeout waiting for the sandbox',
        failureCount: 4, occurrences: 4, lastSeen: now,
        metrics: { attemptssincefailure: { sum: 10, count: 4 }, successessincefailure: { sum: 6, count: 4 } },
      },
      {
        key: 'knowledge:args', scope: 'tool run code',
        problem: 'official operation failure invalid args',
        failureCount: 100, occurrences: 100, lastSeen: now,
      },
    ],
    failureMemory: [],
  }, { minOccurrences: 3 });
  const candidate = planned.candidates.find((entry) => entry.problemKey === 'tool run code');
  assert.ok(candidate, `the root-cause failure was discarded: ${JSON.stringify(planned.rejected)}`);
  assert.equal(candidate.attribution, 'classified');
  assert.equal(candidate.occurrences, 4);
  assert.match(candidate.excludedModes.join(' '), /invalid args/);
  assert.doesNotMatch(candidate.failureModes.join(' '), /invalid args/);
});

test('a caller-input rootCause does not choose the actionable acceptance metric', () => {
  const now = new Date().toISOString();
  const planned = planEvolutionCandidates({
    knowledge: [
      {
        key: 'knowledge:code', scope: 'tool run code',
        problem: 'official operation failure code run failure',
        failureCount: 4, occurrences: 4, lastSeen: now,
        metrics: { attemptssincefailure: { sum: 10, count: 4 }, successessincefailure: { sum: 6, count: 4 } },
      },
      {
        key: 'knowledge:args', scope: 'tool run code',
        problem: 'official operation failure invalid args', rootCause: 'timeout and latency when arguments are wrong',
        failureCount: 100, occurrences: 100, lastSeen: now,
      },
    ],
    failureMemory: [],
  }, { minOccurrences: 3 });
  const candidate = planned.candidates.find((entry) => entry.problemKey === 'tool run code');
  assert.ok(candidate);
  assert.equal(candidate.acceptanceMetrics.some((metric) => metric.name === 'latencyMs'), false,
    'the caller rootCause must not switch the actionable metric to latency');
  assert.equal(candidate.acceptanceMetrics.some((metric) => metric.name === 'successRate'), true);
});

test('a duplicated knowledge key cannot inflate the actionable window', () => {
  const now = new Date().toISOString();
  const caller = {
    key: 'knowledge:args', scope: 'tool run code',
    problem: 'official operation failure invalid args',
    failureCount: 100, occurrences: 100, lastSeen: now,
    metrics: { attemptssincefailure: { sum: 100, count: 100 }, successessincefailure: { sum: 0, count: 100 } },
  };
  const planned = planEvolutionCandidates({
    knowledge: [
      caller,
      { ...caller },
      {
        key: 'knowledge:code', scope: 'tool run code',
        problem: 'official operation failure code run failure',
        failureCount: 4, occurrences: 4, lastSeen: now,
        metrics: { attemptssincefailure: { sum: 10, count: 4 }, successessincefailure: { sum: 6, count: 4 } },
      },
    ],
    failureMemory: [],
  }, { minOccurrences: 3 });
  const candidate = planned.candidates.find((entry) => entry.problemKey === 'tool run code');
  assert.ok(candidate, JSON.stringify(planned.rejected));
  assert.equal(candidate.occurrences, 4);
  assert.equal(candidate.observedAttempts, 10);
  assert.equal(candidate.observedFailureRate, 0.4);
});

test('generic untriaged counters cannot lift one actionable failure over the floor', () => {
  const now = new Date().toISOString();
  const planned = planEvolutionCandidates({
    knowledge: [
      {
        key: 'knowledge:code', scope: 'tool run code',
        problem: 'official operation failure code run failure',
        failureCount: 1, occurrences: 1, lastSeen: now,
        metrics: { attemptssincefailure: { sum: 10, count: 1 }, successessincefailure: { sum: 6, count: 1 } },
      },
      {
        key: 'knowledge:generic', scope: 'tool run code',
        problem: 'host operation failure',
        failureCount: 100, occurrences: 100, lastSeen: now,
        metrics: { attemptssincefailure: { sum: 100, count: 100 }, successessincefailure: { sum: 0, count: 100 } },
      },
    ],
    failureMemory: [],
  }, { minOccurrences: 3 });
  const rejected = planned.rejected.find((entry) => entry.problemKey === 'tool run code');
  assert.equal(rejected?.reason, 'insufficient-evidence');
  assert.equal(rejected?.occurrences, 1, 'the 100 generic counters are not actionable evidence');
});

test('a rootCause on one record does not attribute 100 generic counters', () => {
  const now = new Date().toISOString();
  const planned = planEvolutionCandidates({
    knowledge: [
      {
        key: 'knowledge:root', scope: 'tool run code',
        problem: 'host operation failure', rootCause: 'timeout waiting for the sandbox',
        failureCount: 1, occurrences: 1, lastSeen: now,
        metrics: { attemptssincefailure: { sum: 10, count: 1 }, successessincefailure: { sum: 6, count: 1 } },
      },
      {
        key: 'knowledge:generic', scope: 'tool run code',
        problem: 'host operation failure',
        failureCount: 100, occurrences: 100, lastSeen: now,
        metrics: { attemptssincefailure: { sum: 100, count: 100 }, successessincefailure: { sum: 0, count: 100 } },
      },
    ],
    failureMemory: [],
  }, { minOccurrences: 3 });
  const rejected = planned.rejected.find((entry) => entry.problemKey === 'tool run code');
  assert.equal(rejected?.reason, 'insufficient-evidence');
  assert.equal(rejected?.occurrences, 1, 'the rootCause applies only to its own record');
});

test('a smaller generic memory failure is not hidden by a larger classified one', () => {
  const now = Date.now();
  const iso = (days) => new Date(now - days * 86_400_000).toISOString();
  const planned = planEvolutionCandidates({
    knowledge: [{
      key: 'knowledge:fixed', scope: 'tool run code',
      problem: 'official operation failure code run failure',
      successCount: 3, occurrences: 3, lastSeen: iso(5),
    }],
    failureMemory: [
      {
        key: 'memory:code', scope: 'tool run code',
        problem: 'official operation failure code run failure',
        failureCount: 5, occurrences: 5, lastSeen: iso(10),
      },
      {
        key: 'memory:generic', scope: 'tool run code',
        problem: 'host operation failure',
        failureCount: 2, occurrences: 2, lastSeen: iso(0),
      },
    ],
  }, { minOccurrences: 3 });
  // The generic row is newer, but it is not actionable; the older actionable
  // failure is already resolved, so the target must stay resolved.
  assert.equal(planned.candidates.length, 0);
  assert.equal(planned.rejected.find((entry) => entry.problemKey === 'tool run code')?.reason, 'already-resolved');
});

test('unclassified failure conclusions stay historical, not actionable occurrences', () => {
  const now = new Date().toISOString();
  const versions = { dsh: '1', cordis: '2', evolution: '3' };
  const strategy = JSON.stringify({ kind: 'cordis-plugin', approach: 'retry the same strategy', fingerprint: 'abcdef0123456789', ...versions });
  const planned = planEvolutionCandidates({
    knowledge: [
      {
        key: 'knowledge:code', scope: 'tool run code',
        problem: 'official operation failure code run failure',
        failureCount: 4, occurrences: 4, lastSeen: now,
        metrics: { attemptssincefailure: { sum: 10, count: 4 }, successessincefailure: { sum: 6, count: 4 } },
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        key: 'knowledge:verdict-' + index, scope: 'tool run code',
        problem: 'host operation failure', strategy,
        decision: 'no-benefit', lastOutcome: 'failure',
        occurrences: 10, failureCount: 0, lastSeen: now,
      })),
    ],
    failureMemory: [],
    versions,
  }, { minOccurrences: 3 });
  const candidate = planned.candidates.find((entry) => entry.problemKey === 'tool run code');
  assert.ok(candidate, JSON.stringify(planned.rejected));
  assert.equal(candidate.occurrences, 4, 'the ten unclassified verdicts do not count as actionable occurrences');
  assert.equal(candidate.provenIneffective.length, 5, 'the bounded prior attempts remain available');
  assert.equal(candidate.requiresNewHypothesis, true);
});

test('a mixed candidate reports the actionable firstSeen, not an excluded failure', () => {
  const planned = planEvolutionCandidates({
    knowledge: [
      {
        key: 'knowledge:jan', scope: 'tool run code',
        problem: 'official operation failure invalid args',
        failureCount: 100, occurrences: 100, firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-02T00:00:00.000Z',
      },
      {
        key: 'knowledge:nov', scope: 'tool run code',
        problem: 'official operation failure code run failure',
        failureCount: 4, occurrences: 4, firstSeen: '2026-11-01T00:00:00.000Z', lastSeen: '2026-11-02T00:00:00.000Z',
        metrics: { attemptssincefailure: { sum: 10, count: 4 }, successessincefailure: { sum: 6, count: 4 } },
      },
    ],
    failureMemory: [],
  }, { minOccurrences: 3 });
  const candidate = planned.candidates.find((entry) => entry.problemKey === 'tool run code');
  assert.ok(candidate, JSON.stringify(planned.rejected));
  assert.equal(candidate.firstSeen, '2026-11-01T00:00:00.000Z');
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
