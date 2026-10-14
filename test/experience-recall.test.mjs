/**
 * On-demand experience recall.
 *
 * The daily accumulation path is deliberately model-free and is covered by the
 * existing failure-memory / observation tests. These tests cover the read side:
 * that an explicit evolution trigger can retrieve bounded, relevant history,
 * classify it into resolved problems, failed approaches, and measured
 * candidates, detect an exact replay, and never grow the context without a
 * declared limit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EXPERIENCE_RECALL_LIMITS,
  buildExperienceQuery,
  collectFailureMemoryExperience,
  collectKnowledgeExperience,
  experienceKnowledgeKey,
  finalizeExperienceRecall,
} from '../lib/experience-recall.js';
import { EvolutionOrchestrator, EvolutionEventBridge } from '../lib/orchestrator.js';
import { openDomainStorage } from '../lib/domain-storage.js';

const TARGET = 'plugin:edge-cache';
const INPUT = { why: 'edge cache warmup latency', target: TARGET, impactScope: ['runtime'], successMetrics: ['p95 latency decreases'] };

function scratch(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// pure projection / matching / bounds
// ---------------------------------------------------------------------------

test('recall: a proposal-shaped query reproduces the recorded proposal key', () => {
  // The bridge records a proposal as `{ problem: target, capabilityId: target }`;
  // the query has to use the target as the subject to hit that identity.
  const withTarget = buildExperienceQuery({ why: 'unrelated prose', target: TARGET });
  assert.equal(withTarget.knowledgeKey, experienceKnowledgeKey({ problem: TARGET, target: TARGET }));
  assert.equal(buildExperienceQuery({ why: TARGET }).knowledgeKey, withTarget.knowledgeKey);
  assert.equal(buildExperienceQuery({}).knowledgeKey, null);
});

test('recall: resolved, failed, and candidate rows are classified and bounded', () => {
  const rows = [
    { dimensions: { semanticFact: TARGET, scope: TARGET }, state: 'KNOWN', lastOutcome: 'success', effectStats: { successCount: 3, failureCount: 0, successRate: 1, fitnessMean: 0.8 }, occurrenceCount: 3, lastSeen: '2026-01-01T00:00:00.000Z' },
    { dimensions: { failureMode: 'network-error', rootCause: 'warmup race in edge cache', scope: TARGET }, state: 'LEARNING', lastOutcome: 'failure', effectStats: { successCount: 0, failureCount: 2, successRate: 0 }, count: 2, lastSeen: '2026-01-02T00:00:00.000Z' },
    { dimensions: { strategy: JSON.stringify({ target: TARGET, capability: TARGET }), scope: TARGET }, state: 'KNOWN', lastOutcome: 'success', effectStats: { successCount: 2, failureCount: 0, successRate: 1, fitnessMean: 0.9 }, occurrenceCount: 2, lastSeen: '2026-01-03T00:00:00.000Z' },
    { dimensions: { semanticFact: 'unrelated subsystem', scope: 'plugin:unrelated' }, state: 'KNOWN', lastOutcome: 'success', effectStats: { successCount: 9, failureCount: 0, successRate: 1 }, occurrenceCount: 9, lastSeen: '2026-01-04T00:00:00.000Z' },
  ];
  const result = finalizeExperienceRecall(INPUT, [collectKnowledgeExperience(rows, INPUT, {})], {});
  assert.equal(result.resolved.length, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.resolved[0].state, 'KNOWN');
  assert.match(result.failures[0].rootCause, /warmup race/);
  assert.match(result.candidates[0].strategy, /edge-cache/);
  // Relevance gates the unrelated subsystem out even though it has the best score.
  const returned = [...result.resolved, ...result.failures, ...result.candidates];
  assert.equal(returned.some((record) => record.scope === 'plugin:unrelated'), false);
});

test('recall: an exact replay is reported as a duplicate with its recorded outcome', () => {
  const key = experienceKnowledgeKey({ target: TARGET });
  const rows = [
    { knowledgeKey: key, dimensions: { semanticFact: TARGET, scope: TARGET }, state: 'LEARNING', lastOutcome: 'neutral', effectStats: { successCount: 0, failureCount: 0, successRate: null }, occurrenceCount: 4, firstSeen: '2025-12-01T00:00:00.000Z', lastSeen: '2026-01-05T00:00:00.000Z' },
  ];
  const result = finalizeExperienceRecall(INPUT, [collectKnowledgeExperience(rows, INPUT, {})], {});
  assert.equal(result.duplicate.key, key);
  assert.equal(result.duplicate.occurrences, 4);
  assert.equal(result.duplicate.outcome, 'neutral');
  assert.equal(result.duplicate.firstSeen, '2025-12-01T00:00:00.000Z');
  assert.equal(result.duplicate.lastSeen, '2026-01-05T00:00:00.000Z');
  // A neutral replay is not mislabelled as a resolved or failed outcome.
  assert.equal(result.resolved.length, 0);
  assert.equal(result.failures.length, 0);
  assert.equal(result.advice.some((line) => line.startsWith('duplicate:')), true);
});

test('recall: output respects every declared limit', () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({
    dimensions: { scope: TARGET, semanticFact: `${TARGET} variant ${index}`, strategy: 'x'.repeat(600), failureMode: 'y'.repeat(600) },
    state: 'KNOWN',
    lastOutcome: 'success',
    effectStats: { successCount: index + 1, failureCount: 0, successRate: 1, fitnessMean: 0.9 },
    occurrenceCount: index + 1,
    lastSeen: '2026-01-01T00:00:00.000Z',
    sourceRefs: Array.from({ length: 10 }, (_, ref) => `experiments:ref-${index}-${ref}-${'z'.repeat(200)}`),
  }));
  const result = finalizeExperienceRecall(INPUT, [collectKnowledgeExperience(rows, INPUT, {})], {});
  assert.equal(result.truncated, true);
  assert.ok(result.candidates.length <= EXPERIENCE_RECALL_LIMITS.maxEntries);
  assert.ok(result.resolved.length <= EXPERIENCE_RECALL_LIMITS.maxEntries);
  for (const record of [...result.candidates, ...result.resolved, ...result.failures]) {
    for (const field of ['problem', 'scope', 'strategy', 'failureMode', 'rootCause', 'prevention']) {
      assert.ok(record[field].length <= EXPERIENCE_RECALL_LIMITS.maxText, `${field} exceeded maxText`);
    }
    assert.ok(record.evidenceRefs.length <= EXPERIENCE_RECALL_LIMITS.maxEvidenceRefs);
    for (const ref of record.evidenceRefs) assert.ok(ref.length <= EXPERIENCE_RECALL_LIMITS.maxRefLength);
  }
  // Worst case is bounded by declared limits rather than by history size.
  assert.ok(JSON.stringify(result).length < 12_000, 'recall output must stay inside the declared context bound');
  assert.deepEqual(result.limits, {
    maxEntries: EXPERIENCE_RECALL_LIMITS.maxEntries,
    maxRecords: EXPERIENCE_RECALL_LIMITS.maxRecords,
    maxText: EXPERIENCE_RECALL_LIMITS.maxText,
    maxEvidenceRefs: EXPERIENCE_RECALL_LIMITS.maxEvidenceRefs,
    maxConsidered: EXPERIENCE_RECALL_LIMITS.maxConsidered,
  });
});

test('recall: caller limits can only tighten, never widen, the declared bound', () => {
  const row = { dimensions: { semanticFact: TARGET, scope: TARGET }, state: 'KNOWN', lastOutcome: 'success', effectStats: { successCount: 1, failureCount: 0, successRate: 1 }, occurrenceCount: 1, lastSeen: '2026-01-01T00:00:00.000Z' };
  const wide = finalizeExperienceRecall(INPUT, [collectKnowledgeExperience([row], INPUT, { limits: { maxText: 100_000, maxEntries: 100 } })], { limits: { maxText: 100_000 } });
  assert.equal(wide.limits.maxText, EXPERIENCE_RECALL_LIMITS.maxText);
  assert.equal(wide.limits.maxEntries, EXPERIENCE_RECALL_LIMITS.maxEntries);
  const tight = finalizeExperienceRecall(INPUT, [collectKnowledgeExperience([row], INPUT, { limits: { maxText: 24 } })], { limits: { maxText: 24 } });
  assert.equal(tight.limits.maxText, 24);
  assert.ok(tight.resolved[0].scope.length <= 24);
});

test('recall: durable failure memory contributes failed approaches and prevention', () => {
  const entries = [{
    signature: 'sig-1', count: 3, status: 'active',
    problem: 'edge cache warmup latency', prevention: 'verify baseline before measuring',
    experiment: { patternKey: TARGET }, result: { category: 'runtime-trial', state: 'trial-failed' },
    lastSeenAt: '2026-01-06T00:00:00.000Z',
  }];
  const result = finalizeExperienceRecall(INPUT, [collectFailureMemoryExperience(entries, INPUT, {})], {});
  assert.equal(result.sources[0].source, 'failure-memory');
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].occurrences, 3);
  assert.match(result.failures[0].prevention, /verify baseline/);
  assert.equal(result.failures[0].failureMode, 'runtime-trial');
});

test('recall: a resolved failure-memory entry counts as a recorded resolution', () => {
  // The local memory also carries the experiment target; it must not be read as
  // a reusable strategy, or a resolved failure would be reported as a candidate.
  const entries = [{ signature: 'sig-2', count: 2, status: 'resolved', problem: 'edge cache warmup latency', experiment: { patternKey: TARGET, target: TARGET }, result: { category: 'runtime-trial' }, firstSeenAt: '2025-11-01T00:00:00.000Z' }];
  const result = finalizeExperienceRecall(INPUT, [collectFailureMemoryExperience(entries, INPUT, {})], {});
  assert.equal(result.resolved.length, 1);
  assert.equal(result.candidates.length, 0, 'failure memory never invents a strategy to reuse');
  assert.equal(result.resolved[0].state, 'RESOLVED');
  assert.equal(result.resolved[0].successRate, 1);
  assert.equal(result.resolved[0].firstSeen, '2025-11-01T00:00:00.000Z');
});

test('recall: an unavailable source is reported, never read as "no history"', () => {
  const result = finalizeExperienceRecall(INPUT, [{ source: 'knowledge', error: 'unavailable' }, collectFailureMemoryExperience([], INPUT, {})], {});
  assert.deepEqual(result.unavailable, ['knowledge:unavailable']);
  assert.equal(result.sources.find((entry) => entry.source === 'knowledge').available, false);
});

test('recall: an exact replay outside the scan window is still detected', () => {
  const key = experienceKnowledgeKey({ target: TARGET });
  const oldExact = { knowledgeKey: key, dimensions: { semanticFact: TARGET, scope: TARGET }, state: 'KNOWN', lastOutcome: 'success', effectStats: { successCount: 1, failureCount: 0, successRate: 1 }, occurrenceCount: 1, lastSeen: '2020-01-01T00:00:00.000Z' };
  const oldUnrelated = { dimensions: { semanticFact: 'plugin:unrelated subsystem', scope: 'plugin:unrelated' }, state: 'KNOWN', lastOutcome: 'success', effectStats: { successCount: 1, failureCount: 0, successRate: 1 }, occurrenceCount: 1, lastSeen: '2020-01-01T00:00:00.000Z' };
  const recent = Array.from({ length: 20 }, (_, index) => ({
    dimensions: { semanticFact: `${TARGET} recent ${index}`, scope: TARGET },
    state: 'KNOWN', lastOutcome: 'success', effectStats: { successCount: 1, failureCount: 0, successRate: 1 }, occurrenceCount: 1, lastSeen: '2026-01-01T00:00:00.000Z',
  }));
  const collected = collectKnowledgeExperience([oldExact, oldUnrelated, ...recent], INPUT, { limits: { maxConsidered: 5 } });
  assert.equal(collected.considered, 5, 'tokenization stays inside the scan window');
  assert.equal(collected.scanned, 22);
  const result = finalizeExperienceRecall(INPUT, [collected], { limits: { maxConsidered: 5 } });
  assert.equal(result.duplicate.key, key, 'the exact replay is found even though it is outside the window');
  const returned = [...result.resolved, ...result.failures, ...result.candidates];
  assert.equal(returned.some((record) => record.scope === 'plugin:unrelated'), false, 'a windowed-out non-key row is not scanned');
});

test('recall: malformed rows are ignored and cannot pollute the projection', () => {
  const rows = [
    null, 42, 'text', [],
    { dimensions: {} },
    { knowledgeKey: '__proto__', dimensions: { scope: TARGET }, state: 'KNOWN', lastOutcome: 'success', effectStats: { successCount: 1, failureCount: 0, successRate: 1 } },
    JSON.parse(`{"dimensions":{"scope":"${TARGET}"},"__proto__":{"polluted":true},"state":"KNOWN","lastOutcome":"success","effectStats":{"successCount":1,"failureCount":0,"successRate":1}}`),
  ];
  const result = finalizeExperienceRecall(INPUT, [collectKnowledgeExperience(rows, INPUT, {})], {});
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.ok(result.resolved.length <= EXPERIENCE_RECALL_LIMITS.maxEntries);
});

// ---------------------------------------------------------------------------
// orchestrator: on-demand only, attached to the explicit proposal
// ---------------------------------------------------------------------------

function orchestratorFixture(overrides = {}) {
  const presetDir = scratch('evo-recall-');
  const ctx = { registry: { values: () => [] }, logger: { warn() {} }, emit() {} };
  ctx.dynamicCordisRunner = { snapshot: () => [] };
  const core = new EvolutionOrchestrator(ctx, { presetDir, startupDrift: false, eventBridge: { emit: () => ({}) }, ...overrides });
  const exec = { agent: { id: 'recall-owner' }, signal: new AbortController().signal };
  return { core, ctx, presetDir, exec };
}

test('recall: propose attaches bounded experience without a domain store', () => {
  const { core, presetDir, exec } = orchestratorFixture();
  try {
    const proposal = core.propose({ why: 'edge cache warmup', target: TARGET, impactScope: ['runtime'], successMetrics: ['p95'] }, exec);
    assert.equal(proposal.ok, true);
    assert.equal(typeof proposal.experienceRecall, 'object');
    assert.deepEqual(proposal.experienceRecall.unavailable, ['knowledge:unavailable']);
    assert.equal(proposal.experienceRecall.limits.maxEntries, EXPERIENCE_RECALL_LIMITS.maxEntries);
    assert.deepEqual(proposal.experienceRecall.resolved, []);
  } finally {
    fs.rmSync(presetDir, { recursive: true, force: true });
  }
});

test('recall: propose merges domain knowledge with local failure memory', () => {
  const calls = [];
  const domainStorage = {
    recall: (input, options) => {
      calls.push({ input, options });
      return collectKnowledgeExperience([
        { dimensions: { semanticFact: TARGET, scope: TARGET }, state: 'KNOWN', lastOutcome: 'success', effectStats: { successCount: 2, failureCount: 0, successRate: 1 }, occurrenceCount: 2, lastSeen: '2026-01-01T00:00:00.000Z' },
      ], input, options);
    },
    query: () => null,
    flush: () => null,
  };
  const { core, presetDir, exec } = orchestratorFixture({ domainStorage });
  try {
    core.memory.record({ problem: 'edge cache warmup', experiment: { patternKey: TARGET }, result: { category: 'runtime-trial' }, prevention: 'inspect first' });
    const proposal = core.propose({ why: 'edge cache warmup', target: TARGET, impactScope: ['runtime'], successMetrics: ['p95'] }, exec);
    assert.equal(calls.length, 1, 'the domain store is read exactly once per explicit proposal');
    const recall = proposal.experienceRecall;
    assert.equal(recall.unavailable.length, 0);
    assert.ok(recall.resolved.length >= 1);
    assert.ok(recall.failures.length >= 1);
    assert.ok(recall.sources.some((entry) => entry.source === 'knowledge' && entry.available));
    assert.ok(recall.advice.length <= EXPERIENCE_RECALL_LIMITS.maxAdvice);
  } finally {
    fs.rmSync(presetDir, { recursive: true, force: true });
  }
});

test('recall: a failing domain store degrades to local memory instead of breaking propose', () => {
  const domainStorage = { recall: () => { throw new Error('E_DOMAIN_CLOSED'); }, query: () => null, flush: () => null };
  const { core, presetDir, exec } = orchestratorFixture({ domainStorage });
  try {
    const proposal = core.propose({ why: 'edge cache warmup', target: TARGET, impactScope: ['runtime'], successMetrics: ['p95'] }, exec);
    assert.equal(proposal.ok, true);
    assert.equal(proposal.experienceRecall.unavailable.includes('knowledge:E_DOMAIN_CLOSED'), true);
  } finally {
    fs.rmSync(presetDir, { recursive: true, force: true });
  }
});

test('recall: it is not consulted by inspect, measurement, or autonomous observation', async () => {
  let reads = 0;
  const domainStorage = { recall: () => { reads += 1; return { source: 'knowledge', records: [] }; }, query: () => null, flush: () => null, observe: () => null };
  const { core, presetDir, exec } = orchestratorFixture({ domainStorage, mode: 'advisory' });
  try {
    core.inspect(exec.agent);
    await core.observeAutonomous({ type: 'tool/error', code: 'TOOL_FAILED', target: 'tool:x', message: 'failed' }, exec);
    assert.equal(reads, 0, 'daily accumulation must not trigger experience retrieval');
    core.propose({ why: 'edge cache warmup', target: TARGET, impactScope: ['runtime'], successMetrics: ['p95'] }, exec);
    assert.equal(reads, 1, 'the explicit proposal is the trigger');
  } finally {
    fs.rmSync(presetDir, { recursive: true, force: true });
  }
});

test('recall: experienceRecall=false disables the read entirely', () => {
  const { core, presetDir, exec } = orchestratorFixture({ experienceRecall: false, domainStorage: { recall: () => { throw new Error('must not be called'); } } });
  try {
    const proposal = core.propose({ why: 'edge cache warmup', target: TARGET, impactScope: ['runtime'], successMetrics: ['p95'] }, exec);
    assert.equal(proposal.ok, true);
    assert.equal('experienceRecall' in proposal, false);
    assert.equal(core.recallExperience({ target: TARGET }), null);
  } finally {
    fs.rmSync(presetDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// real domain storage: the recorded history is what the recall reads back
// ---------------------------------------------------------------------------

const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

test('recall: real domain storage returns the recorded resolution, failure, and strategy', async () => {
  const root = scratch('evo-recall-domain-');
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'), eventBridgeKey: 'c'.repeat(64) };
  const bridge = new EvolutionEventBridge({ file: config.eventBridgePath, key: config.eventBridgeKey });
  const port = await openDomainStorage(ctx, config);
  try {
    // A proposal on the target, a failed trial for it, and a later stable promotion.
    bridge.emit('proposal-created', { id: 'exp-recall', proposal: { target: TARGET } });
    bridge.emit('experiment-rejected', {
      id: 'exp-recall', proposal: { target: TARGET }, state: 'trial-failed',
      failure: { error: 'warmup race', errorCategory: 'runtime-trial', failurePhase: 'trial', rootCauseHypothesis: 'cache warms up before dependencies', nextPreventionHint: 'inspect dependencies first' },
    });
    bridge.emit('canary-passed', { id: 'exp-recall', proposal: { target: TARGET }, state: 'stable', evidence: { fitnessScore: 0.9 } });
    assert.equal((await port.replay()).applied, 3);

    const input = { why: 'edge cache warmup latency', target: TARGET, impactScope: ['runtime'] };
    const recalled = finalizeExperienceRecall(input, [port.recall(input)], {});
    assert.deepEqual(recalled.unavailable, []);
    assert.ok(recalled.duplicate, 'the recorded proposal is detected as an exact replay');
    assert.ok(recalled.failures.length >= 1, 'the recorded failure is recallable by target');
    // The domain boundary redacts raw failure text, so the recallable negative
    // evidence is the target scope plus the signature-derived failure mode.
    assert.match(recalled.failures[0].scope, /edge-cache/);
    assert.match(recalled.failures[0].failureMode, /failure/);
    assert.ok(recalled.candidates.length >= 1, 'the recorded stable strategy is a reuse candidate');
    assert.match(recalled.candidates[0].strategy, /edge-cache/);

    // A bounded read is read-only: it must not change what a later query sees.
    const before = port.query('knowledge');
    const again = finalizeExperienceRecall(input, [port.recall(input)], {});
    assert.deepEqual(port.query('knowledge'), before);
    assert.equal(JSON.stringify(again), JSON.stringify(recalled));
  } finally {
    await port.close();
    await backend.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recall: an unauthenticated event log still refuses to answer from a partial view', async () => {
  const root = scratch('evo-recall-domain-bad-');
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'), eventBridgeKey: 'd'.repeat(64) };
  const bridge = new EvolutionEventBridge({ file: config.eventBridgePath, key: config.eventBridgeKey });
  const port = await openDomainStorage(ctx, config);
  try {
    bridge.emit('proposal-created', { id: 'exp-x', proposal: { target: TARGET } });
    const envelope = JSON.parse(fs.readFileSync(config.eventBridgePath, 'utf8').trim());
    fs.writeFileSync(config.eventBridgePath, JSON.stringify({ ...envelope, mac: '0'.repeat(64) }) + '\n');
    await assert.rejects(port.flush(), /E_DOMAIN_EVENT_AUTH/);
    await assert.rejects(port.close(), /E_DOMAIN_EVENT_AUTH/);
  } finally {
    await backend.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
