// Regression for the canary verdict / conclusion metric mismatch. A canary
// regression is decided at the last production barrier (startup/component/
// dependency/functional check); the official host path supplies no numeric
// before/after to that observation. The earlier probe/task numbers must stay in
// the archive/observation/sidecar, but must not be projected into the bounded
// shared conclusion beside a `regression` verdict.
import assert from 'node:assert/strict';
import test from 'node:test';

import { EvolutionOrchestrator, classifyExperimentDecision } from '../lib/orchestrator.js';

function capture(record, kind = record.decision?.kind ?? 'regression', source = 'canary') {
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
  orchestrator.configuredVersions = { host: '0.2.2-rc.5', cordis: '4.1.0', evolution: '0.2.7' };
  orchestrator.publishConclusion(record, kind, source);
  return captured;
}

function probeRecord({ benefit = true, regression = false, rate = [0.4, 0.9], errors = [6, 1] } = {}) {
  return {
    id: 'exp-canary-metric',
    proposal: { target: 'tool:read', strategy: 'S', strategyFingerprint: 'a1b2c3d4e5f60718', rootCause: 'x' },
    probe: {
      comparison: {
        benefit, regression, controlStable: true, repeatable: true,
        beforeMetrics: { successRate: rate[0], errorCount: errors[0] },
        afterMetrics: { successRate: rate[1], errorCount: errors[1] },
      },
    },
    runtimeRecovered: true,
    latestObservation: { solvesProblem: benefit, repeatable: true, regressionPassed: !regression },
  };
}

function canaryRegression(record, reason = 'canary observed a startup, component, or dependency regression') {
  record.decision = {
    version: 1, kind: 'regression', source: 'canary', at: '2026-11-24T00:00:00.000Z',
    eligible: false, reasons: [reason],
  };
  return record;
}

test('a canary regression does not inherit positive probe deltas', () => {
  const record = canaryRegression(probeRecord());
  const captured = capture(record);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].decision, 'regression');
  assert.equal(captured[0].source, 'canary');
  assert.deepEqual(captured[0].metrics, {});
  // The full probe numbers remain on the durable record.
  assert.equal(record.probe.comparison.afterMetrics.successRate, 0.9);
});

test('a canary regression does not inherit positive task-only deltas', () => {
  const record = {
    id: 'exp-canary-metric',
    proposal: { target: 'tool:read', strategy: 'S', strategyFingerprint: 'a1b2c3d4e5f60718', rootCause: 'x' },
    runtimeRecovered: true,
    latestObservation: {
      issueType: 'task-coupled', solvesProblem: true, repeatable: true, regressionPassed: true,
      beforeMetrics: { turns: 10, toolCalls: 10, tokens: 5000, durationMs: 1000 },
      afterMetrics: { turns: 6, toolCalls: 6, tokens: 3000, durationMs: 600 },
      taskBenefit: { benefit: true, regression: false, mechanismRan: true },
    },
  };
  canaryRegression(record);
  const captured = capture(record);
  assert.equal(captured[0].decision, 'regression');
  assert.deepEqual(captured[0].metrics, {});
});

test('a canary regression does not project a probe regression into the conclusion either', () => {
  const record = canaryRegression(probeRecord({ benefit: false, regression: true, rate: [0.9, 0.4], errors: [1, 6] }));
  const captured = capture(record);
  assert.deepEqual(captured[0].metrics, {});
});

test('canary-passed adoption keeps the probe projection byte for byte', () => {
  const record = probeRecord();
  record.decision = {
    version: 1, kind: 'benefit', source: 'canary-passed', at: '2026-11-24T00:00:00.000Z',
    eligible: true, reasons: ['the measured candidate passed the canary window'],
  };
  const captured = capture(record, 'adopted', 'canary-passed');
  assert.equal(captured[0].decision, 'adopted');
  assert.deepEqual(captured[0].metrics, { successRateDelta: 0.5, errorsDelta: -5 });
});

test('measure-source verdicts keep their historical projections', () => {
  const benefit = probeRecord();
  benefit.decision = classifyExperimentDecision(benefit, { source: 'measure' });
  assert.deepEqual(capture(benefit, benefit.decision.kind, 'measure')[0].metrics,
    { successRateDelta: 0.5, errorsDelta: -5 });

  const regression = probeRecord({ benefit: false, regression: true, rate: [0.9, 0.4], errors: [1, 6] });
  regression.decision = classifyExperimentDecision(regression, { source: 'measure' });
  assert.equal(regression.decision.kind, 'regression');
  assert.deepEqual(capture(regression, 'regression', 'measure')[0].metrics,
    { successRateDelta: -0.5, errorsDelta: 5 });
});

test('a measure-source task-driven no-benefit still carries task deltas', () => {
  const record = {
    id: 'exp-canary-metric',
    proposal: { target: 'tool:read', strategy: 'S', strategyFingerprint: 'a1b2c3d4e5f60718', rootCause: 'x' },
    probe: probeRecord().probe,
    runtimeRecovered: true,
    latestObservation: {
      solvesProblem: true, repeatable: true, regressionPassed: true,
      beforeMetrics: { successRate: 0.4, errorCount: 6 },
      afterMetrics: { successRate: 0.9, errorCount: 1 },
      taskBenefit: {
        benefit: false, regression: false, mechanismRan: true,
        baseline: { failures: 0, turns: 10, toolCalls: 10, tokens: 5000, durationMs: 1000 },
        candidate: { failures: 0, turns: 12, toolCalls: 12, tokens: 6000, durationMs: 1200 },
      },
    },
  };
  record.decision = classifyExperimentDecision(record, { source: 'measure' });
  assert.equal(record.decision.kind, 'no-benefit');
  const captured = capture(record, 'no-benefit', 'measure');
  assert.deepEqual(captured[0].metrics, {
    failuresDelta: 0, turnsDelta: 2, toolCallsDelta: 2, tokensDelta: 1000, durationMsDelta: 200,
  });
});
