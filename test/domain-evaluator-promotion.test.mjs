import test from 'node:test';
import assert from 'node:assert/strict';
import { domainEvaluationEvidence } from '../lib/orchestrator.js';
import { EvolutionEvaluator } from '../lib/dockyard-domain/evaluator.js';

function record(overrides = {}) {
  return {
    latestObservation: {
      solvesProblem: true,
      regressionPassed: true,
      metrics: { successRate: 0.95 },
      beforeMetrics: { successRate: 0.5 },
      afterMetrics: { successRate: 0.95 },
      benefitEvidence: 'measured on the real trial',
      ...overrides,
    },
    durable: { rowId: 'row-candidate' },
    previousDurable: { rowId: 'row-historical' },
  };
}

test('domain evaluation evidence maps the matured record into evaluator inputs without synthesizing evidence', () => {
  const evidence = domainEvaluationEvidence(record());
  assert.equal(evidence.goalResult, true);
  assert.equal(evidence.regressionResult, true);
  assert.deepEqual(evidence.beforeMetrics, { successRate: 0.5 });
  assert.deepEqual(evidence.afterMetrics, { successRate: 0.95 });
  assert.equal(evidence.currentVersion, 'row-candidate');
  assert.equal(evidence.historicalBestVersion, 'row-historical');
  const missing = domainEvaluationEvidence({ latestObservation: {} });
  assert.equal(missing.goalResult, null, 'absent benefit evidence must stay absent, never become true');
  assert.equal(missing.regressionResult, undefined);
});

test('the extracted evaluator recommends promote only with goal, test, regression and measured improvement', () => {
  const evaluator = new EvolutionEvaluator();
  const passing = evaluator.evaluate({ ...domainEvaluationEvidence(record()), testResult: true, regressionResult: true });
  assert.equal(passing.decision, 'promote');
  const untested = evaluator.evaluate({ ...domainEvaluationEvidence(record()), testResult: false });
  assert.equal(untested.decision, 'reject');
  assert.match(untested.reason, /test result/);
});

test('the extracted evaluator returns rollback when a recognized metric regresses (the promotion veto condition)', () => {
  const evaluator = new EvolutionEvaluator();
  const regressed = evaluator.evaluate({
    beforeMetrics: { successRate: 0.9, cost: 1 },
    afterMetrics: { successRate: 0.9, cost: 5 },
    goalResult: true,
    testResult: true,
    regressionResult: false,
  });
  assert.equal(regressed.decision, 'rollback');
  assert.ok(regressed.metrics.summary.regressed > 0);
});
