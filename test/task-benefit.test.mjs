// Task-coupled evidence (2026-11-18).
//
// The probe can only pair one tool call with identical arguments. A workflow
// claim is now additionally bound to paired real sessions: the same natural
// task and model, run once without the candidate and once with it. This file
// pins the artifact contract, the derived verdict, and the gate/plan rules that
// keep a capability self-test from standing in for it.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeImprovement,
  promotionGates,
  validateTaskBenefit,
} from '../lib/orchestrator.js';
import { validateTaskRequest } from '../lib/desktop-task-protocol.js';

const HOST_SHA = 'a'.repeat(64);
const PROMPT_SHA = 'b'.repeat(64);
const EXPECT_SHA = 'c'.repeat(64);

function artifact(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'paired-real-session',
    complete: true,
    taskId: 'task-abc',
    task: { id: 'read-long-line', promptSha256: PROMPT_SHA, expectSha256: EXPECT_SHA },
    candidateHostSha256: HOST_SHA,
    model: 'opencode-go/deepseek-v4.1-flash',
    host: { dsh: '0.2.2-rc.3', cordis: '4.1.0' },
    runs: { baseline: 5, candidate: 5 },
    baseline: { sessions: 5, correct: 5, failures: 1, turns: 20, toolCalls: 30, tokens: 100000, durationMs: 60000 },
    candidate: { sessions: 5, correct: 5, failures: 1, turns: 15, toolCalls: 20, tokens: 70000, durationMs: 50000 },
    adoption: { sessionsUsingCandidate: 0, sessionsExercised: 5 },
    ...overrides,
  };
}

const contextPolicy = { hostSha256: HOST_SHA, taskId: 'task-abc', improvement: 'context-policy', applicability: { dsh: '0.2.2-rc.3', cordis: '4.1.0' } };
const toolForm = { ...contextPolicy, improvement: 'tool' };

test('a paired real-session artifact proves a context policy that actually ran', () => {
  const result = validateTaskBenefit(artifact(), contextPolicy);
  assert.equal(result.ok, true, result.issues.join('; '));
  assert.equal(result.artifact.improvement, 'context-policy');
  assert.equal(result.artifact.benefit, true);
  assert.deepEqual(result.artifact.baseline, { sessions: 5, correct: 5, failures: 1, turns: 20, toolCalls: 30, tokens: 100000, durationMs: 60000 });
});

test('a tool-form candidate still needs the model to choose it', () => {
  const unused = validateTaskBenefit(artifact(), toolForm);
  assert.equal(unused.ok, true);
  assert.equal(unused.benefit, false);
  assert.match(unused.artifact.issues.join(' '), /never chose the candidate tool/);
  const used = validateTaskBenefit(artifact({ adoption: { sessionsUsingCandidate: 2, sessionsExercised: 0 } }), toolForm);
  assert.equal(used.ok, true);
  assert.equal(used.benefit, true);
});

test('a context policy that never transformed a step is not attributable', () => {
  const result = validateTaskBenefit(artifact({ adoption: { sessionsUsingCandidate: 0, sessionsExercised: 0 } }), contextPolicy);
  assert.equal(result.benefit, false);
  assert.match(result.artifact.issues.join(' '), /never transformed a step/);
});

test('binding, completeness and correctness are hard preconditions', () => {
  const cases = [
    [{ candidateHostSha256: 'd'.repeat(64) }, /does not match the Trial candidate source/],
    [{ taskId: 'task-other' }, /does not match this desktop task/],
    [{ complete: false }, /incomplete run is unknown/],
    [{ runs: { baseline: 3, candidate: 5 } }, /same integer count/],
    [{ baseline: { sessions: 5, correct: 4, failures: 1, turns: 20, toolCalls: 30, tokens: 100000, durationMs: 60000 } }, /every session on both sides/],
    [{ host: { dsh: '0.2.1', cordis: '4.1.0' } }, /does not match this host/],
    [{ host: { dsh: '0.2.2-rc.3', cordis: '4.0.0' } }, /does not match this host/],
    [{ adoption: { sessionsUsingCandidate: 9, sessionsExercised: 0 } }, /between 0 and the candidate session count/],
  ];
  for (const [overrides, pattern] of cases) {
    const result = validateTaskBenefit(artifact(overrides), contextPolicy);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(overrides)}`);
    assert.match(result.issues.join(' '), pattern);
    assert.equal(result.benefit, false);
  }
});

test('an unprovable host cannot bind real-session evidence', () => {
  const unknown = validateTaskBenefit(artifact(), { ...contextPolicy, applicability: { dsh: 'unknown', cordis: '4.1.0' } });
  assert.equal(unknown.ok, false);
  assert.match(unknown.issues.join(' '), /host applicability is unknown/);
});

test('a workflow probe cannot hide behind a capability benefit model', () => {
  const gates = promotionGates({
    runtimeRecovered: true,
    proposal: { benefitModel: { kind: 'capability' } },
    latestObservation: observation({ probe: { comparison: { benefitKind: 'workflow', workload: { durationAcceptable: true } } } }),
  });
  assert.equal(gates.workflowBenefit, true);
  assert.equal(gates.taskBenefit, false);
  assert.equal(gates.eligible, false);
});

test('task-coupled duration inside its budget is not vetoed by the advisory evaluator', async () => {
  const { domainEvaluationEvidence } = await import('../lib/orchestrator.js');
  const { EvolutionEvaluator } = await import('../lib/dockyard-domain/index.js');
  const observed = observation({
    evidenceKind: 'task-coupled',
    taskBenefit: { benefit: true, regression: false },
    beforeMetrics: { turns: 20, durationMs: 60000 },
    afterMetrics: { turns: 15, durationMs: 60001 },
  });
  const record = { runtimeRecovered: true, proposal: { benefitModel: { kind: 'workflow' } }, latestObservation: observed };
  assert.equal(promotionGates(record).eligible, true);
  const advisory = domainEvaluationEvidence(record);
  assert.equal(Object.hasOwn(advisory.beforeMetrics, 'durationMs'), false, 'the accepted budget owns duration');
  assert.notEqual(new EvolutionEvaluator().evaluate(advisory).decision, 'rollback');
  assert.equal(new EvolutionEvaluator().evaluate(domainEvaluationEvidence({ ...record, latestObservation: { ...observed, taskBenefit: { benefit: false, regression: true } } })).decision === 'rollback', true);
});

test('a canary/restart measurement merge keeps the task evidence', async () => {
  const { mergeMeasurement } = await import('../lib/orchestrator.js');
  const current = { at: 'now', solvesProblem: true, taskBenefit: { benefit: true }, evidenceKind: 'task-coupled' };
  const durable = { at: 'then', solvesProblem: false, reversible: true };
  const merged = mergeMeasurement(current, durable);
  assert.deepEqual(merged.taskBenefit, { benefit: true });
  assert.equal(merged.evidenceKind, 'task-coupled');
  // Legacy measurements keep exactly their old key set.
  const legacy = mergeMeasurement({ at: 'now', solvesProblem: true }, { at: 'then', reversible: true });
  assert.equal(Object.hasOwn(legacy, 'taskBenefit'), false);
  assert.equal(Object.hasOwn(legacy, 'evidenceKind'), false);
});

test('no improvement or a material regression cannot pass', () => {
  const flat = validateTaskBenefit(artifact({
    candidate: { sessions: 5, correct: 5, failures: 1, turns: 20, toolCalls: 30, tokens: 70000, durationMs: 50000 },
  }), contextPolicy);
  assert.equal(flat.benefit, false);
  assert.equal(flat.ok, true, 'a negative verdict is not a contract violation');
  assert.match(flat.artifact.issues.join(' '), /did not reduce turns or tool calls/);
  const slower = validateTaskBenefit(artifact({
    candidate: { sessions: 5, correct: 5, failures: 1, turns: 15, toolCalls: 20, tokens: 400000, durationMs: 50000 },
  }), contextPolicy);
  assert.equal(slower.benefit, false);
  assert.equal(slower.ok, true);
  assert.match(slower.artifact.issues.join(' '), /regressed failures, tokens or wall time/);
});

function observation(extra = {}) {
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
    // The default observation is a legacy capability self-test: it must keep
    // the original eight-gate shape, which is exactly what the last test checks.
    probe: { comparison: { benefitKind: 'capability-self-test' } },
    ...extra,
  };
}

test('the gate requires task evidence for every workflow claim', () => {
  const base = { runtimeRecovered: true, proposal: { benefitModel: { kind: 'workflow' } } };
  const workflowProbe = observation({ probe: { comparison: { benefitKind: 'workflow', workload: { durationAcceptable: true } } } });
  const missing = promotionGates({ ...base, latestObservation: workflowProbe });
  assert.equal(missing.workflowBenefit, true);
  assert.equal(missing.taskBenefit, false);
  assert.equal(missing.eligible, false);
  const proven = promotionGates({ ...base, latestObservation: { ...workflowProbe, taskBenefit: { benefit: true } } });
  assert.equal(proven.eligible, true);
  assert.equal(proven.taskBenefit, true);
});

test('a context policy cannot promote on capability samples', () => {
  const gates = promotionGates({
    runtimeRecovered: true,
    proposal: { improvement: 'context-policy', benefitModel: { kind: 'workflow' } },
    latestObservation: observation({ probe: undefined }),
  });
  assert.equal(gates.taskBenefit, false);
  assert.equal(gates.eligible, false);
});

test('legacy tool experiments keep their gate shape', () => {
  const gates = promotionGates({ runtimeRecovered: true, latestObservation: observation() });
  assert.equal(Object.hasOwn(gates, 'workflowBenefit'), false);
  assert.equal(Object.hasOwn(gates, 'taskBenefit'), false);
  assert.equal(gates.eligible, true);
});

test('the improvement form is a bounded two-value declaration', () => {
  assert.equal(normalizeImprovement(undefined), 'tool');
  assert.equal(normalizeImprovement('CONTEXT-POLICY'), 'context-policy');
  assert.throws(() => normalizeImprovement('component'), /improvement must be/);
});

function contextPlan(overrides = {}) {
  return {
    schemaVersion: 1,
    protocol: 1,
    taskId: 'task-abc',
    createdAt: new Date().toISOString(),
    requester: { profile: 'acp' },
    plan: {
      proposal: {
        why: 'the model recovers from a truncated read line with a shell fallback',
        target: 'read truncation recovery',
        impactScope: ['acp'],
        successMetrics: ['turns'],
        improvement: 'context-policy',
        benefitModel: { kind: 'workflow' },
      },
      composition: { name: 'complete-truncated-read', purpose: 'inject the full line before the next step', code: { host: 'return { name: "x", apply() {} };' } },
      verification: {
        observations: 5,
        task: { id: 'read-long-line', prompt: 'read the config and report the sentinel value', expect: 'sentinel-7', runs: 5 },
        // A context policy registers no tool, so its deterministic effect is
        // observed through an existing read-only tool. Without this the plan
        // would only be able to prove that the plugin was installed.
        functionalCheck: { tool: 'read', arguments: { file_path: 'config.json', offset: 1, limit: 1 }, resultPath: ['lines', '0', 'text'], expected: 'sentinel-7' },
      },
      requestedTargetProfiles: ['acp'],
      ...overrides,
    },
  };
}

test('the plan protocol accepts a task-coupled context policy', () => {
  const result = validateTaskRequest(contextPlan());
  assert.equal(result.ok, true, (result.issues ?? []).join('; '));
});

test('the plan protocol refuses the tool-form verification on a context policy', () => {
  const withSamples = validateTaskRequest(contextPlan({
    verification: { observations: 5, task: { id: 't', prompt: 'p', expect: 'e' }, samples: [{ label: 'a', tool: 'read', arguments: {}, expected: 1 }] },
  }));
  assert.equal(withSamples.ok, false);
  assert.match(withSamples.issues.join(' '), /must not declare capability samples/);
  const noTask = validateTaskRequest(contextPlan({ verification: { observations: 5 } }));
  assert.equal(noTask.ok, false);
  assert.match(noTask.issues.join(' '), /must declare plan.verification.task/);
  const capability = validateTaskRequest(contextPlan({ proposal: { ...contextPlan().plan.proposal, benefitModel: { kind: 'capability' } } }));
  assert.equal(capability.ok, false);
  assert.match(capability.issues.join(' '), /must declare benefitModel.kind = "workflow"/);
});

test('a context policy plan must declare a bounded functional check on a read-only tool', () => {
  const missing = validateTaskRequest(contextPlan({
    verification: { observations: 5, task: { id: 't', prompt: 'p', expect: 'e' } },
  }));
  assert.equal(missing.ok, false);
  assert.match(missing.issues.join(' '), /must declare verification.functionalCheck/);

  for (const tool of ['bash', 'write', 'evolution_promote', 'run_code']) {
    const result = validateTaskRequest(contextPlan({
      verification: {
        observations: 5,
        task: { id: 't', prompt: 'p', expect: 'e' },
        functionalCheck: { tool, arguments: {}, expected: 1 },
      },
    }));
    assert.equal(result.ok, false, `${tool} was accepted as a functional check`);
    assert.match(result.issues.join(' '), /functionalCheck\.tool must be one of/);
  }

  const onToolPlan = validateTaskRequest(contextPlan({
    proposal: { ...contextPlan().plan.proposal, improvement: 'tool' },
    verification: {
      observations: 2,
      targetTool: 'candidate_tool',
      samples: [{ label: 'a', tool: 'candidate_tool', arguments: {}, expected: 1 }],
      functionalCheck: { tool: 'read', arguments: {}, expected: 1 },
    },
  }));
  assert.equal(onToolPlan.ok, false);
  assert.match(onToolPlan.issues.join(' '), /only valid for a context-policy improvement/);
});

test('task-coupled token growth inside its budget is not vetoed by the advisory evaluator', async () => {
  const { domainEvaluationEvidence } = await import('../lib/orchestrator.js');
  const { EvolutionEvaluator } = await import('../lib/dockyard-domain/index.js');
  const observed = observation({
    evidenceKind: 'task-coupled',
    taskBenefit: { benefit: true, regression: false },
    beforeMetrics: { turns: 9, tokens: 10000 },
    afterMetrics: { turns: 6, tokens: 10500 },
  });
  const record = { runtimeRecovered: true, proposal: { benefitModel: { kind: 'workflow' } }, latestObservation: observed };
  assert.equal(promotionGates(record).eligible, true);
  const advisory = domainEvaluationEvidence(record);
  assert.equal(Object.hasOwn(advisory.beforeMetrics, 'tokens'), false, 'the accepted budget owns token growth');
  assert.equal(Object.hasOwn(advisory.afterMetrics, 'tokens'), false);
  assert.notEqual(new EvolutionEvaluator().evaluate(advisory).decision, 'rollback');
  // Raw values remain available for review.
  assert.equal(observed.afterMetrics.tokens, 10500);
});

test('credential-shaped evidence fields are redacted before storage', () => {
  const result = validateTaskBenefit(artifact({
    model: 'sk-abcdefgh12345678',
    task: { id: 'read-long-line', promptSha256: PROMPT_SHA, expectSha256: EXPECT_SHA },
  }), contextPolicy);
  assert.equal(result.ok, true, result.issues.join('; '));
  assert.equal(result.artifact.model, '[redacted]');
  const taskId = validateTaskBenefit(artifact({ taskId: 'sk-abcdefgh12345678' }), { ...contextPolicy, taskId: null });
  assert.equal(taskId.artifact.taskId, '[redacted]');
});

test('the plan protocol pins the task id rule and an explicit target candidate', () => {
  const spaced = validateTaskRequest(contextPlan({
    verification: { observations: 5, task: { id: 'simple task', prompt: 'p', expect: 'e' } },
  }));
  assert.equal(spaced.ok, false);
  assert.match(spaced.issues.join(' '), /task\.id must match/);
  const toolPlan = validateTaskRequest(contextPlan({
    proposal: { ...contextPlan().plan.proposal, improvement: 'tool', benefitModel: { kind: 'workflow' } },
    verification: {
      observations: 5, targetTool: 'candidate_tool',
      samples: [{ label: 'a', tool: 'candidate_tool', arguments: {}, expected: 1 }],
      workload: { kind: 'workflow', id: 'w', repetitions: 5, steps: [
        { name: 'read', role: 'target', arguments: {}, expected: 1 },
        { name: 'read', role: 'control', arguments: {}, expected: 1 },
      ] },
    },
  }));
  assert.equal(toolPlan.ok, false);
  assert.match(toolPlan.issues.join(' '), /target candidateName must match/);
});

test('a credential cut by the field length bound is still redacted', () => {
  // The credential starts at character 54, so the old 60-character cut left
  // only "sk-" plus four characters: below the rule's 8-character minimum, the
  // surviving prefix was no longer redacted.
  const long = 'x'.repeat(52) + '-sk-' + 'abcdefg' + 'x'.repeat(20);
  const result = validateTaskBenefit(artifact({ host: { dsh: long, cordis: '4.1.0' } }), {
    ...contextPolicy, applicability: { dsh: long, cordis: '4.1.0' },
  });
  assert.equal(result.ok, true, result.issues.join('; '));
  assert.equal(result.artifact.host.dsh.includes('sk-'), false);
  assert.ok(result.artifact.host.dsh.length <= 80);
});
