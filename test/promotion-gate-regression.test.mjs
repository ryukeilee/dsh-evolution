import { test, assert, summary } from './helpers.mjs';

// Promotion gate regression: the 8 gate AND logic must stay fail-closed.
// These tests exercise promotionGates() purely (no durable writes, no
// plugin lifecycle) so they never touch production.

const mod = await import('file://' + new URL('../lib/orchestrator.js', import.meta.url).pathname);

const fullMeasurement = {
  solvesProblem: true,
  sideEffects: [],
  orphanResources: [],
  performanceChange: 'unchanged',
  errorChange: 'decreased',
  metrics: { errCount: 0, okCount: 1 },
  beforeMetrics: { errCount: 1, okCount: 0 },
  afterMetrics: { errCount: 0, okCount: 1 },
  observationWindow: '1h',
  sampleCount: 2,
  benefitEvidence: 'real benefit',
  repeatable: true,
  regressionPassed: true,
  reversible: true,
  cleanupEvidence: 'cleanup done',
};

await test('gate: negative (empty observations, unknown recovery) is REJECTED', () => {
  const experiment = {
    latestObservation: {
      solvesProblem: false,
      sideEffects: [],
      orphanResources: [],
      performanceChange: 'unchanged',
      errorChange: 'unchanged',
      metrics: {},
      repeatable: false,
      regressionPassed: false,
      reversible: false,
    },
    runtimeRecovered: false,
  };
  const gates = mod.promotionGates(experiment, { requireRuntimeRecovery: true });
  assert(gates.eligible === false, 'eligible must be false for empty evidence');
  assert(gates.realBenefit === false, 'realBenefit gate false');
  assert(gates.measuredEvidence === false, 'measuredEvidence gate false');
  assert(gates.repeatable === false, 'repeatable gate false');
  assert(gates.regressionTest === false, 'regression gate false');
  assert(gates.reversible === false, 'reversible gate false');
  assert(gates.cleanupEvidence === false, 'cleanupEvidence gate false');
  assert(gates.runtimeRecovered === false, 'runtimeRecovered gate false');
});

await test('gate: negative even with runtimeRecovered true but no measurement', () => {
  const experiment = {
    latestObservation: { solvesProblem: true, sideEffects: [], orphanResources: [], performanceChange: 'unchanged', errorChange: 'unchanged', metrics: {} },
    runtimeRecovered: true,
  };
  const gates = mod.promotionGates(experiment, { requireRuntimeRecovery: true });
  assert(gates.eligible === false, 'eligible false without measurement/benefit evidence');
});

await test('gate: negative when runtime recovery missing but evidence ok', () => {
  const experiment = {
    latestObservation: { ...fullMeasurement },
    runtimeRecovered: false,
  };
  const gates = mod.promotionGates(experiment, { requireRuntimeRecovery: true });
  assert(gates.eligible === false, 'runtimeRecovered gate fails closed');
  assert(gates.realBenefit === true, 'benefit gate passes');
  assert(gates.measuredEvidence === true, 'measured evidence passes');
});

await test('gate: positive (full evidence + recovery) is ELIGIBLE', () => {
  const experiment = {
    latestObservation: { ...fullMeasurement },
    runtimeRecovered: true,
  };
  const gates = mod.promotionGates(experiment, { requireRuntimeRecovery: true });
  assert(gates.eligible === true, 'eligible must be true for full evidence');
  for (const key of ['realBenefit', 'measuredEvidence', 'repeatable', 'regressionTest', 'reversible', 'cleanupEvidence', 'noOrphans', 'runtimeRecovered']) {
    assert(gates[key] === true, key + ' gate true');
  }
});

await test('gate: requireRuntimeRecovery=false allows evidence-only eligibility', () => {
  const experiment = {
    latestObservation: { ...fullMeasurement },
    runtimeRecovered: false,
  };
  const gates = mod.promotionGates(experiment, { requireRuntimeRecovery: false });
  assert(gates.eligible === true, 'evidence gates all pass without recovery requirement');
});

await test('gate: measuredEvidenceOf requires improving shared numeric metric', () => {
  assert(mod.measuredEvidenceOf(fullMeasurement) === true, 'improving metric passes');
  const noImprove = { ...fullMeasurement, afterMetrics: { errCount: 1 }, beforeMetrics: { errCount: 1 } };
  assert(mod.measuredEvidenceOf(noImprove) === false, 'no improvement fails');
  const missing = { ...fullMeasurement, beforeMetrics: undefined, afterMetrics: undefined };
  assert(mod.measuredEvidenceOf(missing) === false, 'missing metrics fail');
});

summary();