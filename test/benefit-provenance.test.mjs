// Benefit provenance (2026-11-17).
//
// A probe whose only improvement is "the candidate tool was absent in baseline
// and succeeds in candidate" proves the tool exists; it does not prove a
// workflow improved. The comparison now labels that capability-self-test and a
// proposal that claims a workflow goal must satisfy the extra gate.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compareProbeRuns, normalizeBenefitModel, promotionGates, probeSummary } from '../lib/orchestrator.js';

const ABSENT = 'E_EVOLUTION_PROBE_CAPABILITY_ABSENT';
function run(rows) {
  const samples = rows.map((row, index) => ({
    repetition: 0, index, step: row.step, role: row.role,
    isError: row.error !== undefined, code: row.error ?? null,
    valueDigest: row.error === undefined ? 'sha256:ok' : null,
  }));
  return { at: '2026-01-01T00:00:00.000Z', samples, summary: probeSummary({ samples }) };
}
const control = [{ step: 'c', role: 'control', error: undefined }];

test('an improved target that only existed after the trial is a capability self-test', () => {
  const baseline = run([...control, { step: 't', role: 'target', error: ABSENT }]);
  const candidate = run([...control, { step: 't', role: 'target', error: undefined }]);
  const comparison = compareProbeRuns(baseline, candidate);
  assert.equal(comparison.benefit, true);
  assert.equal(comparison.benefitKind, 'capability-self-test');
  assert.equal(comparison.workflowBenefit, false);
});

test('an improved target that really ran and failed in the baseline is a tool-level benefit', () => {
  const baseline = run([...control, { step: 't', role: 'target', error: 'TOOL_ERROR' }]);
  const candidate = run([...control, { step: 't', role: 'target', error: undefined }]);
  const comparison = compareProbeRuns(baseline, candidate);
  assert.equal(comparison.benefit, true);
  // The model's surrounding path is absent, so this cannot claim a workflow.
  assert.equal(comparison.benefitKind, 'tool-improvement');
  assert.equal(comparison.workflowBenefit, false);
});

function observation(probeKind, taskBenefit = null) {
  return {
    solvesProblem: true,
    beforeMetrics: { successRate: 0.5, errorCount: 1 },
    afterMetrics: { successRate: 1, errorCount: 0 },
    observationWindow: 'probe:scenario',
    sampleCount: 2,
    repeatable: true,
    regressionPassed: true,
    reversible: true,
    cleanupEvidence: 'disposed',
    orphanResources: [],
    probe: { comparison: { benefitKind: probeKind } },
    ...(taskBenefit === null ? {} : { taskBenefit }),
  };
}

test('the workflow gate is opt-in and rejects a capability self-test', () => {
  const base = { runtimeRecovered: true, latestObservation: observation('capability-self-test') };
  const legacy = promotionGates({ ...base });
  assert.equal(Object.hasOwn(legacy, 'workflowBenefit'), false, 'legacy experiments keep their gate shape');
  assert.equal(legacy.eligible, true);
  const workflow = promotionGates({ ...base, proposal: { benefitModel: { kind: 'workflow' } } });
  assert.equal(workflow.workflowBenefit, false);
  assert.equal(workflow.eligible, false);
  // A workflow claim now also needs a paired real-session artifact; the probe
  // comparison alone only proves the tool call it replaced.
  const proven = promotionGates({ ...base, latestObservation: observation('workflow', { benefit: true }), proposal: { benefitModel: { kind: 'workflow' } } });
  assert.equal(proven.workflowBenefit, true);
  assert.equal(proven.taskBenefit, true);
  assert.equal(proven.eligible, true);
});

test('a benefit model is a bounded two-value declaration', () => {
  assert.deepEqual(normalizeBenefitModel({ kind: 'workflow', metric: 'failureRate' }), { kind: 'workflow', metric: 'failureRate' });
  assert.deepEqual(normalizeBenefitModel({ kind: 'capability' }), { kind: 'capability' });
  assert.equal(normalizeBenefitModel({ kind: 'other' }), null);
  assert.equal(normalizeBenefitModel(null), null);
  assert.equal(normalizeBenefitModel({ kind: 'workflow', metric: 'x'.repeat(500) }).metric.length, 80);
});
test('a capability self-test without a probe is insufficient evidence, not a regression', async () => {
  const { classifyExperimentDecision } = await import('../lib/orchestrator.js');
  const decision = classifyExperimentDecision({
    proposal: { target: 'tool x' },
    latestObservation: {
      solvesProblem: false,
      regressionPassed: false,
      repeatable: false,
      reversible: true,
      cleanupEvidence: 'disposed',
      orphanResources: [],
      evidenceKind: 'capability-self-test',
      metrics: { capabilitySamples: 2 },
      sampleCount: 2,
      observationWindow: 'capability samples only',
    },
  }, { source: 'measure' });
  assert.notEqual(decision.kind, 'regression');
  assert.equal(decision.kind, 'insufficient-evidence');
});

test('a caller-supplied evidenceKind cannot satisfy the workflow gate', () => {
  const base = {
    runtimeRecovered: true,
    proposal: { benefitModel: { kind: 'workflow' } },
    latestObservation: {
      solvesProblem: true,
      beforeMetrics: { successRate: 0.5, errorCount: 1 },
      afterMetrics: { successRate: 1, errorCount: 0 },
      observationWindow: 'caller-window',
      sampleCount: 2,
      repeatable: true,
      regressionPassed: true,
      reversible: true,
      cleanupEvidence: 'disposed',
      orphanResources: [],
      evidenceKind: 'comparative-workload',
    },
  };
  const gates = promotionGates(base);
  assert.equal(gates.workflowBenefit, false);
  assert.equal(gates.eligible, false);
});

test('kernel-derived workflow quality gains use the measured cost budget; legacy metrics retain zero regression', async () => {
  const { compareWorkflowProbeRuns, normalizeProbeScenario, domainEvaluationEvidence } = await import('../lib/orchestrator.js');
  const { EvolutionEvaluator } = await import('../lib/dockyard-domain/index.js');
  const scenario = normalizeProbeScenario({ kind: 'workflow', id: 'quality-cost-budget', repetitions: 5, steps: [
    { name: 'read', candidateName: 'complete_read', role: 'target', arguments: {}, expected: 'complete' },
    { name: 'read', role: 'control', arguments: {}, expected: 'unchanged' },
  ] });
  const rows = (candidate, durationMs) => Array.from({ length: 5 }, (_, repetition) => scenario.steps.map((step, index) => ({
    repetition, index, step: candidate ? step.candidateName : step.name, role: step.role,
    expectedDigest: step.expectedDigest, isError: !candidate && index === 0,
    code: !candidate && index === 0 ? 'E_EVOLUTION_PROBE_INCORRECT' : null,
    valueDigest: !candidate && index === 0 ? null : step.expectedDigest,
    outputBytes: 100, durationMs: index === 0 ? durationMs : 0,
  }))).flat();
  const baseline = { samples: rows(false, 1) };
  for (const [durationMs, eligible] of [[2, true], [12, false]]) {
    const comparison = compareWorkflowProbeRuns(baseline, { samples: rows(true, durationMs), reference: baseline }, scenario);
    const observed = { ...observation('workflow'), probeDerived: true,
      solvesProblem: comparison.benefit, regressionPassed: !comparison.regression,
      beforeMetrics: comparison.beforeMetrics, afterMetrics: comparison.afterMetrics,
      probe: { comparison }, taskBenefit: { benefit: true } };
    const record = { runtimeRecovered: true, proposal: { benefitModel: { kind: 'workflow' } }, latestObservation: observed };
    assert.equal(comparison.workload.durationAcceptable, eligible);
    assert.equal(promotionGates(record).eligible, eligible);
    const evaluator = new EvolutionEvaluator();
    const advisory = domainEvaluationEvidence(record);
    assert.equal(evaluator.evaluate(advisory).decision === 'rollback', !eligible);
    assert.equal(observed.afterMetrics.durationMs, durationMs, 'raw elapsed time remains available');
    assert.equal(evaluator.evaluate(domainEvaluationEvidence({ ...record, latestObservation: { ...observed, probeDerived: false } })).decision, 'rollback');
    // The same raw numbers have no special allowance without a kernel probe.
    assert.equal(promotionGates({ ...record, latestObservation: { ...observed, probeDerived: false } }).eligible, false);
  }
});
