import assert from 'node:assert/strict';
import test from 'node:test';
import { EvolutionLineage, EvolutionSupervisor } from '../../../lib/dockyard-domain/continuous/index.js';
import { authority, evidence, memory, syntheticHost } from './support.js';

// Synthetic domain ports only. These tests pin the supervisor's own contract:
// an EXPERIMENT may only run the candidate its decision authorized, and the
// decision record, the executed target, Lineage and the cycle report name that
// same candidate. No host execution, approval or isolation is verified here.

const weak = { problem: 'weak signal candidate', confidence: 0.3, priority: 'low', estimatedBenefit: 0.01 };
const strong = { problem: 'strong latency candidate', confidence: 0.95, priority: 'high', estimatedBenefit: 0.6, suggested_area: 'performance' };
const medium = { problem: 'medium quality candidate', confidence: 0.8, priority: 'medium', estimatedBenefit: 0.35, suggested_area: 'quality' };

const thresholds = { minSamples: 3, minConfidence: 0.7, minBenefit: 0.2 };

function services() {
  const m = memory();
  return { memory: m, lineage: new EvolutionLineage({ memory: m, mutationAuthority: authority }), mutationAuthority: authority, evidence, logger: { warn() {} } };
}

function capturingHost(calls, result = { status: 'promoted', version: 'v1', fitnessScore: 0.5 }) {
  return syntheticHost(async (input) => {
    calls.push(input);
    return { ...result, version: result.version };
  });
}

test('experiment executes the authorized candidate, not the first proposal', async () => {
  const calls = [];
  const s = services();
  const supervisor = new EvolutionSupervisor({ ...s, host: capturingHost(calls), ...thresholds });

  // The decision rule authorizes an EXPERIMENT because `strong` qualifies,
  // while `proposals[0]` (weak) never qualifies on its own.
  const decision = supervisor.decide({ proposals: [weak, strong], sampleCount: 5 });
  assert.equal(decision.action, 'experiment');
  assert.equal(decision.reason, 'high_benefit_candidate');
  assert.equal(decision.target.problem, strong.problem);
  assert.equal(decision.target.confidence, 0.95);
  assert.equal(decision.target.suggested_area, 'performance');
  assert.deepEqual(decision.proposals.map(p => p.problem), [weak.problem, strong.problem]);

  const report = await supervisor.runCycle({ proposals: [weak, strong], sampleCount: 5, generation: 1, lineageId: 'targets' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target.problem, strong.problem);
  assert.equal(calls[0].target.confidence, 0.95);
  // The whole proposal list is still forwarded; only the target changed.
  assert.deepEqual(calls[0].proposals.map(p => p.problem), [weak.problem, strong.problem]);
  assert.equal(calls[0].decision.action, 'experiment');
  // Decision record, executed target, Lineage and report agree.
  assert.deepEqual(report.decision.target, calls[0].target);
  assert.equal(report.decision.target.problem, strong.problem);
  assert.equal(report.lineage.target, 'performance');
  assert.deepEqual(report.lineage.mutation, { area: 'performance' });
  assert.equal(report.lineage.experimentId, null);
  assert.deepEqual(supervisor.decisions.at(-1).target, calls[0].target);
});

test('target selection among several authorized candidates is deterministic in caller order', async () => {
  const first = [];
  const a = new EvolutionSupervisor({ ...services(), host: capturingHost(first), ...thresholds });
  await a.runCycle({ proposals: [strong, medium], sampleCount: 5 });
  await a.runCycle({ proposals: [strong, medium], sampleCount: 5 });
  assert.deepEqual(first.map(call => call.target.problem), [strong.problem, strong.problem]);
  assert.deepEqual(a.decisions.map(d => d.target.problem), [strong.problem, strong.problem]);
  assert.equal(a.history[0].lineage.target, 'performance');

  const reversed = [];
  const b = new EvolutionSupervisor({ ...services(), host: capturingHost(reversed), ...thresholds });
  await b.runCycle({ proposals: [medium, strong], sampleCount: 5 });
  assert.equal(reversed[0].target.problem, medium.problem);
  assert.equal(b.history[0].lineage.target, 'quality');
});

test('single-candidate decisions keep their previous behavior', async () => {
  const qualified = [];
  const single = new EvolutionSupervisor({ ...services(), host: capturingHost(qualified), ...thresholds });
  const decision = single.decide({ proposals: [strong], sampleCount: 5 });
  assert.equal(decision.action, 'experiment');
  assert.equal(decision.target.problem, strong.problem);
  await single.runCycle({ proposals: [strong], sampleCount: 5 });
  assert.equal(qualified.length, 1);
  assert.equal(qualified[0].target.problem, strong.problem);

  const rejected = [];
  const onlyWeak = new EvolutionSupervisor({ ...services(), host: capturingHost(rejected), ...thresholds });
  const observe = onlyWeak.decide({ proposals: [weak], sampleCount: 5 });
  assert.equal(observe.action, 'observe');
  assert.equal(observe.reason, 'low_confidence');
  assert.equal(observe.target, null);
  const report = await onlyWeak.runCycle({ proposals: [weak], sampleCount: 5 });
  assert.equal(rejected.length, 0);
  assert.equal(report.status, 'observe');
  assert.equal(report.decision.target, null);
  // Non-EXPERIMENT lineage still describes the first proposal.
  assert.equal(report.lineage.target, weak.problem);
});

test('no authorized candidate never executes, even with a mixed proposal set', async () => {
  const calls = [];
  const s = services();
  const supervisor = new EvolutionSupervisor({ ...s, host: capturingHost(calls), ...thresholds });
  const lowBenefit = { problem: 'low benefit but confident', confidence: 0.9, priority: 'medium', estimatedBenefit: 0.01 };
  const decision = supervisor.decide({ proposals: [weak, lowBenefit], sampleCount: 5 });
  assert.equal(decision.action, 'observe');
  assert.equal(decision.reason, 'no_high_value_target');
  assert.equal(decision.target, null);
  const report = await supervisor.runCycle({ proposals: [weak, lowBenefit], sampleCount: 5 });
  assert.equal(calls.length, 0);
  assert.equal(report.status, 'observe');
});

test('regression analysis is unchanged and short-circuits an otherwise authorized candidate', async () => {
  const calls = [];
  const s = services();
  const supervisor = new EvolutionSupervisor({ ...s, host: capturingHost(calls), ...thresholds });
  const degrading = { ...medium, problem: 'degrading quality candidate', trend: 'degrading' };
  const decision = supervisor.decide({ proposals: [strong, degrading], sampleCount: 5 });
  assert.equal(decision.action, 'analyze');
  assert.equal(decision.reason, 'clear_regression_or_degradation');
  assert.equal(decision.target, null);
  const report = await supervisor.runCycle({ proposals: [strong, degrading], sampleCount: 5 });
  assert.equal(calls.length, 0);
  assert.equal(report.status, 'analyze');
  assert.equal(report.lineage.decision, 'analyze');
  assert.equal(report.lineage.target, 'performance');
});

test('an experiment decision without an authorized target fails loudly instead of executing one', async () => {
  const calls = [];
  // Only reachable through an overriding `decide`; the in-tree decision cannot
  // produce an EXPERIMENT without an authorized candidate.
  class UnauthorizedTargetSupervisor extends EvolutionSupervisor {
    decide(input = {}) {
      const decision = super.decide(input);
      return { ...decision, action: 'experiment', reason: 'high_benefit_candidate', target: decision.proposals[0] ?? null };
    }
  }
  const supervisor = new UnauthorizedTargetSupervisor({ ...services(), host: capturingHost(calls), ...thresholds });
  await assert.rejects(supervisor.runCycle({ proposals: [weak, strong], sampleCount: 5 }), /E_CONTINUOUS_DECISION_TARGET_MISMATCH/);
  assert.equal(calls.length, 0);
  assert.equal(supervisor.history[0].status, 'failed');
  assert.equal(supervisor.consecutiveFailures, 1);

  class MissingTargetSupervisor extends EvolutionSupervisor {
    decide(input = {}) {
      return { ...super.decide(input), action: 'experiment', target: null };
    }
  }
  const missing = new MissingTargetSupervisor({ ...services(), host: capturingHost(calls), ...thresholds });
  await assert.rejects(missing.runCycle({ proposals: [strong], sampleCount: 5 }), /E_CONTINUOUS_DECISION_TARGET_MISMATCH/);
  assert.equal(calls.length, 0);
});
