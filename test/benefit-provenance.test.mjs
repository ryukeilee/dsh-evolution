// Benefit provenance (2026-11-17).
//
// A probe whose only improvement is "the candidate tool was absent in baseline
// and succeeds in candidate" proves the tool exists; it does not prove a
// workflow improved. The comparison now labels that capability-self-test and a
// proposal that claims a workflow goal must satisfy the extra gate.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compareProbeRuns, mergeMeasurement, normalizeBenefitModel, promotionGates, probeSummary } from '../lib/orchestrator.js';

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

test('a measurement merge preserves probeDerived, so a budgeted workflow gain is not re-read as a regression', async () => {
  const {
    compareWorkflowProbeRuns, normalizeProbeScenario, mergeMeasurement,
    domainEvaluationEvidence, promotionGates: gatesOf,
  } = await import('../lib/orchestrator.js');
  const { EvolutionEvaluator } = await import('../lib/dockyard-domain/index.js');
  const scenario = normalizeProbeScenario({ kind: 'workflow', id: 'merge-keeps-probe-derived', repetitions: 5, steps: [
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
  const comparison = compareWorkflowProbeRuns(baseline, { samples: rows(true, 2), reference: baseline }, scenario);
  assert.equal(comparison.workload.durationAcceptable, true);
  const observed = { ...observation('workflow'), probeDerived: true,
    solvesProblem: comparison.benefit, regressionPassed: !comparison.regression,
    beforeMetrics: comparison.beforeMetrics, afterMetrics: comparison.afterMetrics,
    probe: { comparison }, taskBenefit: { benefit: true } };
  const record = { runtimeRecovered: true, proposal: { benefitModel: { kind: 'workflow' } } };
  assert.equal(gatesOf({ ...record, latestObservation: observed }).eligible, true);

  // hydateRecordFromSnapshot / canary / archive reload all merge a durable
  // observation with the in-session one. That merge must not erase the marker
  // that makes the budgeted comparison authoritative.
  const merged = mergeMeasurement(observed, { at: '2026-01-01T00:00:00.001Z' });
  assert.equal(merged.probeDerived, true, 'the authoritative comparison marker survives the merge');
  assert.equal(gatesOf({ ...record, latestObservation: merged }).eligible, true);
  assert.equal(new EvolutionEvaluator().evaluate(domainEvaluationEvidence({ ...record, latestObservation: merged })).decision === 'rollback', false);
});

// 2026-11-24 reliability round: durable snapshot merging must preserve every
// distinct string fact and must not let an older durable metric overwrite a
// known current measurement.
test('durable merge keeps distinct side effects and orphan resources', () => {
  const current = {
    sideEffects: ['A', 'B', 'C'],
    orphanResources: ['orphan-A', 'orphan-B'],
    metrics: { successRate: 0.9 },
  };
  const durable = {
    sideEffects: ['A', 'B', 'C'],
    orphanResources: ['orphan-A', 'orphan-B', 'orphan-C'],
    metrics: { successRate: 0.1 },
  };
  const merged = mergeMeasurement(structuredClone(current), durable);
  assert.deepEqual(merged.sideEffects, ['A', 'B', 'C']);
  assert.deepEqual(merged.orphanResources, ['orphan-A', 'orphan-B', 'orphan-C']);
  // Current wins on a shared metric key; the durable value is a floor only.
  assert.deepEqual(merged.metrics, { successRate: 0.9 });
  // A missing current metric field still falls back to the durable floor.
  const partial = mergeMeasurement({ metrics: {} }, { metrics: { successRate: 0.4, errCount: 2 } });
  assert.deepEqual(partial.metrics, { successRate: 0.4, errCount: 2 });
});


test('metric merge preserves an own __proto__ key without polluting the prototype', () => {
  const current = { metrics: Object.fromEntries([['__proto__', { status: 'payload' }], ['ok', 1]]) };
  const merged = mergeMeasurement(current, { metrics: { floor: 2 } });
  assert.equal(Object.getPrototypeOf(merged.metrics), Object.prototype);
  assert.equal(Object.hasOwn(merged.metrics, '__proto__'), true);
  assert.deepEqual(merged.metrics.__proto__, { status: 'payload' });
  assert.equal(merged.metrics.ok, 1);
  assert.equal(merged.metrics.floor, 2);
});

test('metric merge keeps an own empty-valued key instead of replacing it from the floor', () => {
  const current = { metrics: Object.fromEntries([['__proto__', {}], ['ok', 1]]) };
  const merged = mergeMeasurement(current, { metrics: { __proto__: { forged: true }, floor: 2 } });
  assert.equal(Object.getPrototypeOf(merged.metrics), Object.prototype);
  assert.equal(Object.hasOwn(merged.metrics, '__proto__'), true);
  assert.deepEqual(merged.metrics.__proto__, {});
  assert.equal(merged.metrics.floor, 2);
});

// 2026-11-24 open research round 3: a task-coupled artifact is the only
// measurement a context-policy candidate has. When the mechanism never ran, a
// cost difference between two unrelated runs cannot be attributed to the
// candidate; and a valid, fully executed no-benefit result must close the loop
// by publishing a durable no-benefit conclusion instead of disappearing as
// insufficient evidence.
function taskCoupledRecord({ benefit, regression, mechanismRan }) {
  return {
    latestObservation: {
      evidenceKind: 'task-coupled',
      taskBenefit: {
        benefit, regression, mechanismRan, improved: benefit,
        correctness: { baseline: true, candidate: true },
        runs: { baseline: 3, candidate: 3 },
      },
      solvesProblem: benefit,
      repeatable: true,
      regressionPassed: !regression,
    },
  };
}

test('an unadopted task-coupled candidate never publishes a regression conclusion', async () => {
  const { classifyExperimentDecision, conclusionKindFor } = await import('../lib/orchestrator.js');
  const record = taskCoupledRecord({ benefit: false, regression: true, mechanismRan: false });
  record.decision = classifyExperimentDecision(record);
  assert.equal(record.decision.kind, 'insufficient-evidence');
  assert.equal(conclusionKindFor(record), 'insufficient-evidence');
});

test('a valid task-coupled no-benefit measurement publishes a no-benefit conclusion', async () => {
  const { classifyExperimentDecision, conclusionKindFor } = await import('../lib/orchestrator.js');
  const record = taskCoupledRecord({ benefit: false, regression: false, mechanismRan: true });
  record.decision = classifyExperimentDecision(record);
  assert.equal(record.decision.kind, 'no-benefit');
  assert.equal(conclusionKindFor(record), 'no-benefit');
});

test('a task-coupled candidate that actually ran and regressed still publishes regression', async () => {
  const { classifyExperimentDecision, conclusionKindFor } = await import('../lib/orchestrator.js');
  const record = taskCoupledRecord({ benefit: false, regression: true, mechanismRan: true });
  record.decision = classifyExperimentDecision(record);
  assert.equal(record.decision.kind, 'regression');
  assert.equal(conclusionKindFor(record), 'regression');
});

test('a workload probe alongside task evidence cannot hide the task verdict', async () => {
  const { classifyExperimentDecision, conclusionKindFor } = await import('../lib/orchestrator.js');
  const combined = (taskBenefit) => ({
    latestObservation: {
      // A probe pair keeps this label; the validated task artifact is still
      // attached and decides whether the candidate mechanism ran and helped.
      evidenceKind: 'comparative-workload',
      probe: { comparison: { benefit: true, regression: false, before: { executions: 3 } } },
      taskBenefit: { ...taskBenefit, correctness: { baseline: true, candidate: true }, runs: { baseline: 3, candidate: 3 } },
      solvesProblem: false,
      repeatable: true,
      regressionPassed: taskBenefit.regression === false,
    },
  });
  const unadopted = combined({ benefit: false, regression: true, mechanismRan: false });
  unadopted.decision = classifyExperimentDecision(unadopted);
  assert.equal(unadopted.decision.kind, 'insufficient-evidence');
  assert.equal(conclusionKindFor(unadopted), 'insufficient-evidence');

  const noGain = combined({ benefit: false, regression: false, mechanismRan: true });
  noGain.decision = classifyExperimentDecision(noGain);
  assert.equal(noGain.decision.kind, 'no-benefit');
  assert.equal(conclusionKindFor(noGain), 'no-benefit');

  // An insufficient/invalid workload probe must not swallow a validated task
  // verdict: it says nothing about whether the candidate mechanism helped.
  const invalidProbe = combined({ benefit: false, regression: false, mechanismRan: true });
  invalidProbe.latestObservation.probe.comparison = {
    measurementInvalid: true, workload: { sufficient: false },
    reasons: ['probe did not measure both sides'], before: { executions: 3 },
  };
  invalidProbe.decision = classifyExperimentDecision(invalidProbe);
  assert.equal(invalidProbe.decision.kind, 'no-benefit');
  assert.equal(conclusionKindFor(invalidProbe), 'no-benefit');

  // The combined regressionPassed flag is not itself regression evidence: a
  // control that failed on both sides measures no regression, while a task
  // artifact that actually ran and exceeded its budget does.
  const controlFailedBothSides = combined({ benefit: false, regression: false, mechanismRan: true });
  controlFailedBothSides.latestObservation.probe.comparison = {
    measurementInvalid: true, workload: { sufficient: false },
    reasons: ['insufficient'], before: { executions: 3 },
  };
  controlFailedBothSides.latestObservation.regressionPassed = false;
  controlFailedBothSides.decision = classifyExperimentDecision(controlFailedBothSides);
  assert.equal(controlFailedBothSides.decision.kind, 'no-benefit');

  const taskRegression = combined({ benefit: false, regression: true, mechanismRan: true });
  taskRegression.latestObservation.probe.comparison = { transportFailed: true, measurementInvalid: true, workload: { sufficient: false }, before: { executions: 3 } };
  taskRegression.latestObservation.regressionPassed = false;
  taskRegression.decision = classifyExperimentDecision(taskRegression);
  assert.equal(taskRegression.decision.kind, 'regression');
  assert.equal(conclusionKindFor(taskRegression), 'regression');
});
