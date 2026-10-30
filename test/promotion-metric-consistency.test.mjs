import test from 'node:test';
import assert from 'node:assert/strict';
import { measuredEvidenceOf } from '../lib/orchestrator.js';
import { EvolutionEvaluator } from '../lib/dockyard-domain/evaluator.js';

const observation = (beforeMetrics, afterMetrics) => ({ beforeMetrics, afterMetrics, observationWindow: '1h', sampleCount: 2 });

test('measurement uses metric direction and refuses mixed regression or unknown metrics', () => {
  assert.equal(measuredEvidenceOf(observation({ successRate: 0.8 }, { successRate: 0.9 })), true);
  assert.equal(measuredEvidenceOf(observation({ successRate: 0.9 }, { successRate: 0.8 })), false);
  assert.equal(measuredEvidenceOf(observation({ latencyMs: 100, qualityScore: 0.9 }, { latencyMs: 80, qualityScore: 0.8 })), false);
  assert.equal(measuredEvidenceOf(observation({ mystery: 10 }, { mystery: 1 })), false);
  assert.equal(measuredEvidenceOf(observation({ latencyMs: Infinity }, { latencyMs: 1 })), false);
});

test('evaluator detects regressions smaller than display precision', () => {
  const result = new EvolutionEvaluator().evaluate({ beforeMetrics: { cost: 10, qualityScore: 1 }, afterMetrics: { cost: 9, qualityScore: 0.99999 }, goalResult: true, testResult: true, regressionResult: true });
  assert.equal(result.decision, 'rollback');
  assert.equal(result.metrics.qualityScore.regressed, true);
});

test('invalid evaluator values do not become numeric metrics', () => {
  const evaluator = new EvolutionEvaluator();
  for (const invalid of [true, false, '   ']) {
    const result = evaluator.evaluate({ beforeMetrics: { qualityScore: 0.5 }, afterMetrics: { qualityScore: invalid }, goalResult: true, testResult: true, regressionResult: true });
    assert.equal(result.decision, 'reject');
    assert.equal(result.metrics.qualityScore.after, null);
  }
});

test('projected metric values reject boolean and whitespace inputs', async () => {
  const { projectEvolutionMetric } = await import('../lib/dockyard-domain/metric-projection.js');
  const result = projectEvolutionMetric('task', { latencyMs: true, qualityScore: '   ' });
  assert.equal(result.latencyMs, null);
  assert.equal(result.qualityScore, null);
});

test('direct measurement supports benefit without an unrelated metrics field', async () => {
  const { promotionGates } = await import('../lib/orchestrator.js');
  const latestObservation = { ...observation({ latencyMs: 100 }, { latencyMs: 90 }), solvesProblem: true, repeatable: true, regressionPassed: true, reversible: true, cleanupEvidence: 'clean', orphanResources: [] };
  assert.equal(promotionGates({ latestObservation, runtimeRecovered: true }).eligible, true);
});

test('contradictory direct and nested measurements cannot pass', () => {
  const input = { ...observation({ latencyMs: 100 }, { latencyMs: 90 }), metrics: { before: { latencyMs: 100 }, after: { latencyMs: 120 } } };
  assert.equal(measuredEvidenceOf(input), false);
});

test('measurement handles direction, bounds, aliases, and incomplete evidence', () => {
  const checks = [
    [{ qualityScore: 0.5 }, { qualityScore: 0.6 }, true],
    [{ failureRate: 0.2 }, { failureRate: 0.1 }, true],
    [{ latencyMs: 100 }, { latencyMs: 101 }, false],
    [{ latencyMs: 100 }, { latencyMs: 100 }, false],
    [{ latency: 100 }, { latencyMs: 90 }, true],
    [{ latencyMs: 100, qualityScore: 0.5 }, { latencyMs: 90 }, false],
    [{ latencyMs: 100, latency: 200 }, { latencyMs: 90 }, false],
    [{ latencyMs: 100 }, { latencyMs: NaN }, false],
  ];
  for (const [before, after, expected] of checks) assert.equal(measuredEvidenceOf(observation(before, after)), expected);
  assert.equal(measuredEvidenceOf({ ...observation({ latencyMs: 100 }, { latencyMs: 90 }), observationWindow: 0 }), false);
  assert.equal(measuredEvidenceOf({ ...observation({ latencyMs: 100 }, { latencyMs: 90 }), sampleCount: 0 }), false);
});


test('nested metrics reach evaluator as a before/after pair', async () => {
  const { domainEvaluationEvidence } = await import('../lib/orchestrator.js');
  const evidence = domainEvaluationEvidence({ latestObservation: { solvesProblem: true, regressionPassed: true, metrics: { before: { latencyMs: 100, metrics: { qualityScore: 0.9 } }, after: { latencyMs: 90, metrics: { qualityScore: 0.1 } } } } });
  const result = new EvolutionEvaluator().evaluate(evidence);
  assert.equal(result.decision, 'rollback');
  assert.equal(result.metrics.qualityScore.regressed, true);
});
