// Regression for the cross-stage evidence-fidelity gap where a task-driven
// negative verdict published a conclusion carrying the probe's positive deltas.
// The durable lesson must report the numbers of the evidence that drove the
// verdict; probe numbers stay in the full observation/archive.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EvolutionOrchestrator,
  classifyExperimentDecision,
  deriveProbeObservation,
} from '../lib/orchestrator.js';

function captureConclusion(record) {
  const captured = [];
  const store = {
    findConclusions() { return { matches: [] }; },
    recordConclusion(input) {
      captured.push(input);
      return { committed: true, duplicate: false, knowledgeKey: 'k' };
    },
  };
  const orchestrator = new EvolutionOrchestrator(
    { dynamicCordisRunner: {}, tools: {} },
    { sharedExperience: store, eventBridge: { emit() {} } },
  );
  orchestrator.configuredVersions = {
    host: '0.2.2-rc.5', cordis: '4.1.0', evolution: '0.2.7',
  };
  const written = orchestrator.publishConclusion(
    record,
    record.decision.kind === 'benefit' ? 'benefit' : record.decision.kind,
    'promotion-gates',
  );
  return { captured, written };
}

function probeComparison({ benefit = true, regression = false, beforeRate = 0.4, afterRate = 0.9, beforeErrors = 6, afterErrors = 1 } = {}) {
  return {
    benefit, regression, controlStable: true, repeatable: true,
    beforeMetrics: { successRate: beforeRate, errorCount: beforeErrors },
    afterMetrics: { successRate: afterRate, errorCount: afterErrors },
    before: { successes: 4, errors: beforeErrors, executions: 10 },
    after: { successes: 9, errors: afterErrors, executions: 10 },
    reasons: [], workload: { sufficient: true },
  };
}

function probeOf(comparison, { id = 'workload' } = {}) {
  return {
    scenario: { id }, scenarioDigest: 'sha256:x',
    versions: { dsh: '0.2.2-rc.5', cordis: '4.1.0', evolution: '0.2.7' },
    baseline: { samples: [] }, candidate: { samples: [] }, comparison,
  };
}

function taskArtifact({ benefit = false, regression = false, mechanismRan = true, turns = 10, toolCalls = 10, candidateTurns = turns, candidateToolCalls = toolCalls } = {}) {
  return {
    benefit, regression, mechanismRan,
    runs: { baseline: 3, candidate: 3 },
    correctness: { baseline: true, candidate: true },
    baseline: { sessions: 3, correct: 3, failures: 0, turns, toolCalls, tokens: 5000, durationMs: 1000 },
    candidate: { sessions: 3, correct: 3, failures: 0, turns: candidateTurns, toolCalls: candidateToolCalls, tokens: 5000, durationMs: 1000 },
  };
}

function recordOf({ probe, taskBenefit, useDurableProbeOnly = false, taskTurns, taskCalls, candidateTurns, candidateToolCalls, taskRegression = false, taskBenefitValue = false }) {
  const comparison = probe?.comparison ?? null;
  const task = taskBenefit ?? (taskTurns !== undefined || taskCalls !== undefined || candidateTurns !== undefined || candidateToolCalls !== undefined || taskRegression || taskBenefitValue
    ? taskArtifact({
      benefit: taskBenefitValue, regression: taskRegression,
      turns: taskTurns ?? 10, toolCalls: taskCalls ?? 10,
      candidateTurns: candidateTurns ?? 10, candidateToolCalls: candidateToolCalls ?? 10,
    })
    : undefined);
  const durableProbe = probe ? deriveProbeObservation(probe) : undefined;
  const taskDeltas = task ? {
    beforeMetrics: { ...task.baseline }, afterMetrics: { ...task.candidate },
  } : {};
  const observation = {
    at: '2026-11-24T00:00:00.000Z',
    solvesProblem: comparison ? comparison.benefit && task?.benefit !== false : task?.benefit === true,
    repeatable: true,
    regressionPassed: !(comparison?.regression === true) && !(task?.regression === true),
    evidenceKind: comparison ? 'comparative-workload' : 'task-coupled',
    metrics: comparison
      ? { probeBenefit: 1, probeControlStable: 1 }
      : { taskBenefit: task?.benefit === true ? 1 : 0 },
    ...(comparison && !useDurableProbeOnly ? { ...taskDeltas } : {}),
    ...(!comparison ? taskDeltas : {}),
    ...(task === undefined ? {} : { taskBenefit: task }),
    ...(durableProbe ? { probe: durableProbe, probeDerived: true } : {}),
    observationWindow: comparison ? 'probe:workload' : 'task:scenario',
    sampleCount: 3,
  };
  const record = {
    id: 'exp-metric-source',
    proposal: {
      target: 'tool:read', strategy: 'S', strategyFingerprint: 'a1b2c3d4e5f60718',
      rootCause: 'x', benefitModel: { kind: comparison ? 'workload' : 'workflow' }, improvement: 'context-policy',
    },
    ...(useDurableProbeOnly ? {} : (probe ? { probe } : {})),
    latestObservation: observation,
  };
  record.decision = classifyExperimentDecision(record, { source: 'measure' });
  return record;
}

test('a task-driven no-benefit conclusion carries task deltas, not the probe positive deltas', () => {
  const probe = probeOf(probeComparison({ benefit: true }));
  const record = recordOf({ probe, taskTurns: 10, taskCalls: 10 });
  assert.equal(record.decision.kind, 'no-benefit');
  const { captured } = captureConclusion(record);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].decision, 'no-benefit');
  assert.deepEqual(captured[0].metrics, {
    failuresDelta: 0, turnsDelta: 0, toolCallsDelta: 0, tokensDelta: 0, durationMsDelta: 0,
  });
});

test('a task-driven regression conclusion carries task deltas showing the cost overrun', () => {
  const probe = probeOf(probeComparison({ benefit: true }));
  const record = recordOf({ probe, taskTurns: 10, taskCalls: 10, candidateTurns: 13, candidateToolCalls: 12, taskRegression: true });
  assert.equal(record.decision.kind, 'regression');
  const { captured } = captureConclusion(record);
  assert.equal(captured[0].decision, 'regression');
  assert.equal(captured[0].metrics.turnsDelta, 3);
  assert.equal(captured[0].metrics.toolCallsDelta, 2);
  assert.equal(captured[0].metrics.successRateDelta, undefined);
});

test('the same task-driven verdict after a restart (durable probe only) still uses task deltas', () => {
  const probe = probeOf(probeComparison({ benefit: true }));
  const record = recordOf({ probe, useDurableProbeOnly: true, taskTurns: 10, taskCalls: 10, candidateTurns: 11, candidateToolCalls: 10 });
  assert.equal(record.decision.kind, 'no-benefit');
  const { captured } = captureConclusion(record);
  assert.equal(captured[0].metrics.turnsDelta, 1);
  assert.equal(captured[0].metrics.successRateDelta, undefined);
});

test('probe-only conclusions keep their byte-for-byte historical metric shape', () => {
  const probe = probeOf(probeComparison({ benefit: true }));
  const record = recordOf({ probe });
  const { captured } = captureConclusion(record);
  assert.deepEqual(captured[0].metrics, { successRateDelta: 0.5, errorsDelta: -5 });
});

test('a probe-negative verdict with a positive task artifact still reports probe deltas', () => {
  const probe = probeOf(probeComparison({ benefit: false, beforeRate: 0.4, afterRate: 0.4, beforeErrors: 6, afterErrors: 6 }));
  const record = recordOf({ probe, taskBenefitValue: true, taskTurns: 8, taskCalls: 8 });
  assert.equal(record.decision.kind, 'no-benefit');
  const { captured } = captureConclusion(record);
  assert.deepEqual(captured[0].metrics, { successRateDelta: 0, errorsDelta: 0 });
});

test('task-only conclusions keep their byte-for-byte historical metric shape', () => {
  const record = recordOf({ taskTurns: 9, taskCalls: 8, candidateTurns: 9, candidateToolCalls: 8 });
  const { captured } = captureConclusion(record);
  assert.deepEqual(captured[0].metrics, {
    failuresDelta: 0, turnsDelta: 0, toolCallsDelta: 0, tokensDelta: 0, durationMsDelta: 0,
  });
});

test('publishing never mutates the dual evidence retained in the observation', () => {
  const probe = probeOf(probeComparison({ benefit: true }));
  const record = recordOf({ probe, taskTurns: 10, taskCalls: 10 });
  const before = JSON.stringify(record.latestObservation);
  captureConclusion(record);
  assert.equal(JSON.stringify(record.latestObservation), before);
  assert.equal(record.latestObservation.probeDerived, true);
  assert.equal(record.latestObservation.taskBenefit.mechanismRan, true);
});
