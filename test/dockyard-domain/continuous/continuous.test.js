import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStateStore } from '../support.js';
import { EvolutionEvaluator, AntiGamingEvaluator } from '../../../lib/dockyard-domain/evaluator.js';
import { EvolutionDiscovery, EvolutionLineage, EvolutionStrategyMemory, EvolutionStrategyResolver, EvolutionStrategyMutator, EvolutionSupervisor, EvolutionTrialSupervisor, ContinuousEvolutionHarness } from '../../../lib/dockyard-domain/continuous/index.js';
import { authority, evidence, memory, syntheticHost, proposal, generation } from './support.js';

// Migrated scenarios: continuous-evolution.test.mjs / long-running-evolution-proof.test.mjs.
// All execution ports below are synthetic. Only domain algorithms and contracts are verified.
function services(options = {}) {
  const m = memory(options);
  const lineage = new EvolutionLineage({ memory: m, mutationAuthority: authority });
  const strategyMemory = new EvolutionStrategyMemory({ memory: m, mutationAuthority: authority });
  const strategyResolver = new EvolutionStrategyResolver({ strategyMemory });
  return { memory: m, lineage, strategyMemory, strategyResolver, mutationAuthority: authority, evidence, logger: { warn() {} } };
}

test('discovery derives degradation and repeated failure, ignoring manual targets', () => {
  const discovery = new EvolutionDiscovery();
  const targets = discovery.discover({ target: 'manual latency optimization', objective: 'manual target', samples: generation(1).samples, failurePatterns: Array.from({ length: 3 }, () => ({ patternKey: 'tool/timeout', severity: 'error' })) });
  assert.ok(targets.some(t => t.suggested_area === 'performance'));
  assert.ok(targets.some(t => t.patternKey === 'tool/timeout'));
  assert.ok(targets.every(t => t.problem && t.evidence && t.source === 'runtime-derived' && t.target === null));
  assert.equal(discovery.snapshot().ignoredManualInput, true);
  assert.throws(() => new EvolutionDiscovery({ metrics: { snapshot() { throw new Error('metrics unavailable'); } } }).discover(), /metrics unavailable/);
});

test('lineage records parents and protects historical best', async () => {
  const { lineage } = services();
  for (const [i, fitness] of [.4, .65, .55].entries()) await lineage.record({ lineageId: 'line', generation: i + 1, version: `v${i + 1}`, fitnessScore: fitness, decision: i === 2 ? 'rollback' : 'promote' });
  const list = lineage.list();
  assert.deepEqual(list.map(v => v.generation), [1, 2, 3]);
  assert.equal(list[1].parentVersion, 'v1');
  assert.equal(lineage.best().version, 'v2');
  assert.equal(lineage.compare(list[2], list[1]).decision, 'keep_historical_best');
  const evaluation = new EvolutionEvaluator().compareWithHistoricalBest({ currentVersion: 'v3', historicalBestVersion: 'v2', currentMetrics: { successRate: .8, latencyMs: 140, qualityScore: .7 }, historicalBestMetrics: { successRate: .85, latencyMs: 100, qualityScore: .8 } });
  assert.equal(evaluation.decision, 'rollback');
  assert.throws(() => { lineage.records.push({}); }, /read-only/);
});

test('lineage shared cold memory deduplicates IDs across restart and restores full history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuous-domain-'));
  try {
    const stateStore = new JsonStateStore({ filePath: join(root, 'state.json') });
    const opts = { stateStore, hotEntries: 2, hotCycles: 2 };
    const a = services(opts);
    for (let i = 1; i <= 6; i++) await a.lineage.record({ id: `id-${i}`, lineageId: 'cold', generation: i, version: `v${i}`, fitnessScore: i === 1 ? .99 : .5, decision: 'promote' });
    const b = services(opts);
    await b.lineage.load();
    assert.equal(b.lineage.list({ includeArchived: true }).length, 6);
    assert.equal(b.lineage.historicalBest().version, 'v1');
    await b.lineage.record({ id: 'id-1', lineageId: 'cold', generation: 1, version: 'v1', fitnessScore: .99, decision: 'promote' });
    const c = services(opts); await c.lineage.load();
    assert.equal(c.lineage.fullSnapshot().count, 6);
    assert.equal(new Set(c.lineage.fullSnapshot().generations.map(v => v.id)).size, 6);
    await c.lineage.restore(c.lineage.fullSnapshot());
    const d = services(opts); await d.lineage.load();
    assert.equal(d.lineage.fullSnapshot().count, 6);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('standalone lineage uses explicit transaction; missing authority/storage and write errors reject', async () => {
  let state = {}; let commits = 0;
  const stateStore = { async load() { return structuredClone(state); }, async update() { throw new Error('forbidden direct update'); } };
  const transaction = { async persist(update, options) { assert.equal(options.metadata.partition, 'evolutionLineage'); state = update(state); commits++; } };
  const a = new EvolutionLineage({ stateStore, transaction, mutationAuthority: authority });
  await a.record({ id: 'same', generation: 1 });
  const b = new EvolutionLineage({ stateStore, transaction, mutationAuthority: authority });
  await b.record({ id: 'same', generation: 1 });
  assert.equal(b.snapshot().count, 1); assert.equal(commits, 2);
  await b.restore(b.snapshot()); assert.equal(commits, 3);
  await assert.rejects(new EvolutionLineage({ stateStore, transaction }).record({}), { code: 'E_MUTATION_AUTHORITY_REQUIRED' });
  await assert.rejects(new EvolutionLineage({ stateStore, mutationAuthority: authority }).record({}), { code: 'E_CONTINUOUS_PORT_REQUIRED' });
  await assert.rejects(new EvolutionLineage({ stateStore, transaction: { persist() { throw new Error('disk failure'); } }, mutationAuthority: authority }).record({}), /disk failure/);
});

test('strategy success/failure conditions, ranking, mutation tree and causal result survive restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuous-strategy-'));
  try {
    const options = { stateStore: new JsonStateStore({ filePath: join(root, 'state.json') }), hotEntries: 2 };
    const s = services(options);
    await s.strategyMemory.recordSuccess({ id: 'retry', strategy: 'retry-budget', context: { area: 'reliability', problem: 'retry growth' }, confidence: .9 });
    await s.strategyMemory.recordFailure({ id: 'unsafe', strategy: 'unsafe-retry', context: { area: 'reliability', problem: 'retry growth' }, failureConditions: { environment: 'unstable' }, confidence: .2 });
    const resolved = await s.strategyResolver.resolve({ problem: 'reliability retry growth', context: { area: 'reliability' } });
    assert.equal(resolved.strategy, 'retry-budget');
    assert.equal(s.strategyMemory.list().find(v => v.id === 'unsafe').successRate, 0);
    await s.strategyMemory.recordFailure({ id: 'blocked', strategy: 'unstable', context: { environment: 'unstable' }, failureConditions: { problem: '', context: { environment: 'unstable' }, target: '' } });
    const query = { problem: '', context: { environment: 'unstable' }, target: '' };
    assert.ok(!s.strategyMemory.rank(query, { minSuccessRate: 0 }).some(v => v.strategy.id === 'blocked'));
    const candidate = await s.strategyResolver.mutate({ problem: 'retry growth', context: { area: 'reliability' } }, resolved, { generation: 2, mutation: { type: 'parameter-exploration', dimension: 'retry', step: 2 } });
    assert.equal(candidate.parentStrategyId, 'retry'); assert.equal(candidate.status, 'candidate');
    await s.strategyResolver.mutator.recordResult(candidate, { result: 'failed', decision: 'rollback', experimentId: 'synthetic-exp', fitness: .3, metrics: { qualityScore: .3 } });
    const restarted = services(options); await restarted.memory.load();
    const node = restarted.strategyResolver.mutationTree()[0];
    assert.equal(node.decision, 'rollback'); assert.equal(node.experimentResult.experimentId, 'synthetic-exp');
    assert.equal(node.strategyInput.problem, 'retry growth'); assert.equal(node.candidateChange.step, 2);
    assert.equal(node.futureSelection.strategyId, 'retry');
    await assert.rejects(new EvolutionStrategyMemory().recordSuccess({}), { code: 'E_MUTATION_AUTHORITY_REQUIRED' });
    await assert.rejects(new EvolutionStrategyMutator().mutate({}), { code: 'E_MUTATION_AUTHORITY_REQUIRED' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('supervisor wait/observe/analyze/experiment decision algorithm preserved', () => {
  const s = new EvolutionSupervisor({ minSamples: 3, minConfidence: .7, minBenefit: .2 });
  assert.equal(s.decide({ sampleCount: 1 }).action, 'wait');
  assert.equal(s.decide({ sampleCount: 3, proposals: [{ problem: 'unknown', confidence: .3 }] }).action, 'observe');
  assert.equal(s.decide({ sampleCount: 3, proposals: [{ ...proposal, trend: 'degrading' }] }).action, 'analyze');
  assert.equal(s.decide({ sampleCount: 3, proposals: [proposal] }).action, 'experiment');
});

test('three synthetic domain generations produce lineage/learning/report, not official execution proof', async () => {
  const s = services();
  const supervisor = new EvolutionSupervisor({ ...s, host: syntheticHost(async ({ generation }) => ({ status: 'promoted', version: `v${generation}`, fitnessScore: .3 + generation * .2, strategy: { name: 'latency-budget', context: { area: 'performance' } } })) });
  const report = await supervisor.runGenerations({ count: 3, lineageId: 'latency', generations: [1, 2, 3].map(i => ({ ...generation(i), proposals: [proposal] })) });
  assert.equal(report.complete, true); assert.equal(report.count, 3);
  assert.deepEqual(report.lineage.map(v => v.generation), [1, 2, 3]);
  assert.equal(report.lineage[1].parentVersion, 'v1');
  assert.equal(report.summary.continuousImprovement, true); assert.equal(report.summary.memoryEffective, true);
  assert.equal(s.strategyMemory.list()[0].successRate, 1);
});

test('missing execution/evidence/persistence reject; failure is recorded and not learned as success', async () => {
  const input = { ...generation(1), proposals: [proposal], strategyOutcome: { id: 'failed', strategy: 'bad-tuning', success: true } };
  const s = services();
  const noHost = new EvolutionSupervisor(s);
  await assert.rejects(noHost.runCycle(input), { code: 'E_CONTINUOUS_PORT_REQUIRED' });
  assert.equal(s.strategyMemory.list()[0].successRate, 0);
  const noEvidence = new EvolutionSupervisor({ ...services(), evidence: null, host: syntheticHost() });
  await assert.rejects(noEvidence.runCycle(input), { code: 'E_CONTINUOUS_PORT_REQUIRED' });
  const noPersistence = new EvolutionSupervisor({ host: syntheticHost(), evidence, mutationAuthority: authority });
  await assert.rejects(noPersistence.runCycle(input), { code: 'E_CONTINUOUS_PORT_REQUIRED' });
  const deniedEvidence = new EvolutionSupervisor({ ...services(), host: syntheticHost(), evidence: { ...evidence, validateResult: () => false } });
  await assert.rejects(deniedEvidence.runCycle(input), /E_CONTINUOUS_EVIDENCE_REJECTED/);
  const failure = new EvolutionSupervisor({ ...services(), host: syntheticHost(async () => { throw new Error('synthetic host failed'); }), maxConsecutiveFailures: 1 });
  await assert.rejects(failure.runCycle(input), /synthetic host failed/);
  assert.equal(failure.history[0].status, 'failed'); assert.equal(failure.consecutiveFailures, 1);
  assert.equal((await failure.runCycle(input)).reason, 'circuit_open');
  await assert.rejects(failure.runGenerations({ count: Infinity }), /finite/);
});

test('anti-gaming domains reject isolated metric wins', () => {
  const result = new AntiGamingEvaluator().evaluateAntiGaming({ scenarios: [
    { beforeMetrics: { tokenUsage: 100, qualityScore: .9 }, afterMetrics: { tokenUsage: 50, qualityScore: .6 } },
    { beforeMetrics: { latencyMs: 100, failureRate: .05 }, afterMetrics: { latencyMs: 50, failureRate: .2 } },
    { beforeMetrics: { latencyMs: 100, cost: 10, qualityScore: .7 }, afterMetrics: { latencyMs: 70, cost: 8, qualityScore: .8 } },
  ].map(s => ({ ...s, goalResult: { success: true }, testResult: { passed: true }, regressionResult: { passed: true } })) });
  assert.deepEqual(result.scenarios.map(v => v.decision), ['rollback', 'rollback', 'promote']);
});

test('50 bounded synthetic trials retain resources/causality and do not claim runtime isolation', async () => {
  const s = services();
  const trial = new EvolutionTrialSupervisor({ ...s, maxCycles: 50, cycleTimeoutMs: 500, host: syntheticHost(async ({ generation, strategy }) => ({ status: 'promoted', version: `v${generation}`, fitnessScore: .4 + generation * .01, candidate: { id: `candidate-${generation}` }, strategy })) });
  const report = await trial.runCycles({ count: 50, generations: Array.from({ length: 50 }, (_, i) => generation(i + 1)) });
  assert.equal(report.complete, true); assert.equal(report.count, 50); assert.equal(report.generationCount, 50);
  assert.equal(report.evolution.continuousImprovement, true); assert.equal(report.stability.crashes, 0);
  assert.equal(report.stopCondition.reason, 'max_cycles');
  assert.ok(Object.values(report.resources.average).every(v => v > 0));
  assert.ok(report.cycles.every(c => c.timestamp && c.strategy && c.candidate && c.causality && c.failureIsolation.isolated === false));
  assert.equal(s.memory.stats().cycles, 50); assert.equal(s.memory.stats().strategyMutations, 50);
  assert.equal((await trial.runCycle()).status, 'stopped');
});

test('10 multi-generation domain trials retain parent versions and mutation tree', async () => {
  const s = services();
  const trial = new EvolutionTrialSupervisor({ ...s, maxCycles: 10, host: syntheticHost(async ({ generation, strategy }) => ({ status: 'promoted', version: `g${generation}`, fitnessScore: .5 + generation * .03, strategy })) });
  const report = await trial.runGenerations({ count: 10, generations: Array.from({ length: 10 }, (_, i) => generation(i + 1)) });
  assert.equal(report.count, 10);
  assert.deepEqual(s.lineage.list().slice(1).map(v => v.parentVersion), Array.from({ length: 9 }, (_, i) => `g${i + 1}`));
  assert.equal(trial.snapshot().strategyEvolutionTree.length, 10);
});

test('orphan evidence triggers rollback, restoration is fingerprint-verified', async () => {
  let orphan = false; let calls = 0;
  const host = syntheticHost(async () => { orphan = true; return { status: 'promoted' }; }, {
    inspectState: () => ({ components: orphan ? [{ id: 'orphan', status: 'orphan' }] : [], effects: [], invariants: { valid: true, violations: [] } }),
    rollback: async () => { calls++; orphan = false; },
  });
  const trial = new EvolutionTrialSupervisor({ ...services(), host });
  const report = await trial.runCycles({ count: 2, proposals: [proposal], ...generation(1) });
  assert.equal(report.count, 1); assert.equal(calls, 1);
  assert.equal(report.stopCondition.reason, 'orphan_component_detected');
  assert.equal(report.cycles[0].failureIsolation.orphanDetected, true);
  assert.equal(report.cycles[0].failureIsolation.orphanCount, 0);
  assert.equal(report.cycles[0].failureIsolation.registryRestored, true);
});

test('rollback assertion alone cannot certify registry restoration; rollback errors are retained', async () => {
  let polluted = false;
  const host = syntheticHost(async () => { polluted = true; return { status: 'rollback' }; }, {
    inspectState: () => ({ components: polluted ? [{ id: 'pollution', status: 'active' }] : [], effects: [], invariants: { valid: true, violations: [] } }),
  });
  const trial = new EvolutionTrialSupervisor({ ...services(), host });
  const report = await trial.runCycles({ count: 5, proposals: [proposal], ...generation(1) });
  assert.equal(report.count, 1); assert.equal(report.stopCondition.reason, 'rollback_not_restored');
  assert.equal(report.stability.failureIsolationPassed, false);
  const failing = new EvolutionTrialSupervisor({ ...services(), host: syntheticHost(async () => ({ status: 'rollback' }), { rollback: async () => { throw new Error('rollback disk failed'); } }) });
  const failure = await failing.runCycle({ ...generation(1), proposals: [proposal] });
  assert.equal(failure.rollback.status, 'rollback_failed'); assert.match(failure.rollback.error.message, /disk failed/);
  assert.equal(failing.stopReason, 'rollback_failed');
});

test('failure/regression/rollback budgets are finite, including zero regression budget', async () => {
  const host = syntheticHost(async () => ({ status: 'rollback' }));
  const trial = new EvolutionTrialSupervisor({ ...services(), host, maxCycles: 10, maxConsecutiveFailures: 10, maxRegressions: 10, maxRollbacks: 2 });
  const report = await trial.runCycles({ count: 10, ...generation(1), proposals: [proposal] });
  assert.equal(report.count, 3); assert.equal(trial.rollbackAttempts, 2);
  assert.equal(report.stopCondition.reason, 'rollback_budget_exhausted');
  const failureBudget = new EvolutionTrialSupervisor({ ...services(), host, maxConsecutiveFailures: 1 });
  await failureBudget.runCycles({ count: 5, ...generation(1), proposals: [proposal] });
  assert.equal(failureBudget.history.length, 1); assert.equal(failureBudget.stopReason, 'consecutive_failures');
  const zeroBudget = new EvolutionTrialSupervisor({ ...services(), host, maxRegressions: 0, maxConsecutiveFailures: 10 });
  await zeroBudget.runCycles({ count: 5, ...generation(1), proposals: [proposal] });
  assert.equal(zeroBudget.history.length, 1); assert.equal(zeroBudget.stopReason, 'regression_budget_exhausted');
  await assert.rejects(trial.runCycles({ count: Infinity }), /finite/);
});

test('cooperative deadline settles work before rollback and stops further trials', async () => {
  let settled = false; let rollbackCalls = 0;
  const host = syntheticHost(async ({ signal }) => {
    await new Promise(resolve => { signal.addEventListener('abort', resolve, { once: true }); });
    settled = true;
    throw new Error('work cancelled');
  }, { rollback: async () => { assert.equal(settled, true); rollbackCalls++; } });
  const trial = new EvolutionTrialSupervisor({ ...services(), host, cycleTimeoutMs: 5 });
  const report = await trial.runCycles({ count: 3, ...generation(1), proposals: [proposal] });
  assert.equal(report.count, 1); assert.equal(report.cycles[0].timeout, true);
  assert.equal(rollbackCalls, 1); assert.equal(report.stopCondition.reason, 'cycle_timeout');
});

test('trial fails closed without inspection/deadline/rollback/persistence; maintenance and disposal propagate errors', async () => {
  for (const key of ['inspectState', 'runWithDeadline', 'rollback']) {
    const trial = new EvolutionTrialSupervisor({ ...services(), host: syntheticHost(undefined, { [key]: null }) });
    await assert.rejects(trial.runCycle({ ...generation(1), proposals: [proposal] }), { code: 'E_CONTINUOUS_PORT_REQUIRED' });
    assert.equal(trial.history.length, 0);
  }
  const invalidInspection = new EvolutionTrialSupervisor({ ...services(), host: syntheticHost(undefined, { inspectState: () => ({}) }) });
  await assert.rejects(invalidInspection.runCycle(), /inspectState/);
  const trial = new EvolutionTrialSupervisor({ ...services(), host: syntheticHost() });
  await trial.pauseForMaintenance();
  assert.throws(() => trial.runCycle(), { code: 'E_EVOLUTION_MAINTENANCE_PAUSED' });
  await trial.resumeFromMaintenance({ resume: false });
  const supervisor = new EvolutionSupervisor({ mutationAuthority: authority, host: syntheticHost(undefined, { schedule: () => () => { throw new Error('dispose failed'); } }) });
  await supervisor.start(); assert.throws(() => supervisor.stop(), /disposal failed/);
  await assert.rejects(new EvolutionSupervisor({ mutationAuthority: authority }).start(), { code: 'E_CONTINUOUS_PORT_REQUIRED' });
  assert.throws(() => new EvolutionTrialSupervisor({ runtime: {} }), /explicit/);
});

test('supervisor execution and scheduler stay within a cumulative cycle budget', async () => {
  let executes = 0;
  const supervisor = new EvolutionSupervisor({ ...services(), maxCycles: 2, host: syntheticHost(async () => { executes++; return { status: 'promoted' }; }) });
  for (let i = 0; i < 4; i++) await supervisor.runCycle({ ...generation(1), proposals: [proposal] });
  assert.equal(executes, 2); assert.equal(supervisor.snapshot().completedCycles, 2);
  assert.equal((await supervisor.runCycle()).reason, 'max_cycles');
});

test('unavailable post-execution inspection triggers rollback, never fabricated healthy evidence', async () => {
  let inspections = 0; let rollbacks = 0;
  const host = syntheticHost(undefined, {
    inspectState() {
      if (++inspections > 1) throw new Error('host inspection unavailable');
      return { components: [], effects: [], invariants: { valid: true, violations: [] } };
    },
    rollback: async () => { rollbacks++; },
  });
  const trial = new EvolutionTrialSupervisor({ ...services(), host });
  const record = await trial.runCycle({ ...generation(1), proposals: [proposal] });
  assert.equal(rollbacks, 1);
  assert.equal(record.failureIsolation.registryRestored, false);
  assert.match(record.failureIsolation.inspectionError.message, /unavailable/);
  assert.equal(trial.stopReason, 'rollback_not_restored');
});

test('custom stop-condition errors are visible and stop execution', async () => {
  const trial = new EvolutionTrialSupervisor({ ...services(), host: syntheticHost(), stopCondition() { throw new Error('stop policy failed'); } });
  await assert.rejects(trial.runCycle({ ...generation(1), proposals: [proposal] }), /stop policy failed/);
  assert.equal(trial.stopReason, 'stop_condition_error');
  assert.equal(trial.history.length, 1);
});

test('facade construction performs no load and shares existing domain services', async () => {
  let loads = 0;
  const m = memory({ stateStore: { load() { loads++; return {}; }, update() {} } });
  const facade = new ContinuousEvolutionHarness({ memory: m, mutationAuthority: authority, host: syntheticHost(), evidence });
  await facade.ready; assert.equal(loads, 0);
  await facade.load(); assert.ok(loads > 0);
  assert.equal(facade.lineage.memory, m); assert.equal(facade.strategyMemory.memory, m);
  const snapshot = facade.snapshot(); await facade.restoreSnapshot(snapshot);
  assert.equal(facade.snapshot().lineage.count, 0);
});
