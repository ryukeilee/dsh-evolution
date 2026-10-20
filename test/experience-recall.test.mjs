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
// unified ranking: source-order independence, exact-replay retention, dedupe
// ---------------------------------------------------------------------------

const EXACT_KEY = experienceKnowledgeKey({ target: TARGET });

/**
 * `sources` reports the caller's merge order by design. When an assertion is
 * about the ranked answer rather than about that input report, normalize it so
 * the serialization can be compared across source orders.
 */
function serializeRecall(result) {
  const sources = [...result.sources].sort((left, right) => (left.source < right.source ? -1 : left.source > right.source ? 1 : 0));
  return JSON.stringify({ ...result, sources });
}

function ordinaryCandidateRow(index) {
  return {
    knowledgeKey: `knowledge:ordinary-${index}`,
    dimensions: { scope: TARGET, semanticFact: `${TARGET} variant ${index}`, strategy: 'warm the cache before dependencies' },
    state: 'KNOWN', lastOutcome: 'success',
    effectStats: { successCount: 5, failureCount: 0, successRate: 1, fitnessMean: 1 },
    occurrenceCount: 5, lastSeen: '2026-01-01T00:00:00.000Z',
  };
}

function exactFailureRow(lastSeen) {
  return {
    knowledgeKey: EXACT_KEY,
    dimensions: { semanticFact: TARGET, scope: TARGET },
    state: 'LEARNING', lastOutcome: 'failure',
    effectStats: { successCount: 0, failureCount: 3, successRate: 0 },
    occurrenceCount: 3, lastSeen,
  };
}

function weakFailureEntry(index) {
  return {
    signature: `sig-weak-${index}`, count: 1, status: 'active',
    problem: `edge cache warmup latency variant ${index}`, prevention: 'inspect dependencies first',
    experiment: { patternKey: TARGET }, result: { category: 'runtime-trial', state: 'trial-failed' },
    lastSeenAt: '2025-01-01T00:00:00.000Z',
  };
}

test('recall: the ranked answer is independent of source order', () => {
  const knowledge = collectKnowledgeExperience([exactFailureRow('2026-01-01T00:00:00.000Z')], INPUT, {});
  const memory = collectFailureMemoryExperience([0, 1, 2].map(weakFailureEntry), INPUT, {});
  const forward = finalizeExperienceRecall(INPUT, [knowledge, memory], {});
  const reverse = finalizeExperienceRecall(INPUT, [memory, knowledge], {});
  assert.deepEqual(forward.failures, reverse.failures);
  assert.deepEqual(forward.counts, reverse.counts);
  assert.equal(serializeRecall(forward), serializeRecall(reverse));
  // Ordering every source in source-array order made the weak rows win whenever
  // their source was merged first; the strongly evidenced failure must rank
  // first either way.
  assert.equal(forward.failures[0].source, 'knowledge');
  assert.equal(forward.failures[0].key, EXACT_KEY);
  assert.equal(reverse.failures[0].key, EXACT_KEY);
});

test('recall: a record is scored and placed without regard to the other sources', () => {
  // The knowledge failure is older than the failure-memory row, but it carries
  // twice the evidence. The score is a pure function of the record, so the
  // same record keeps the same score and the same place no matter which other
  // sources are present or in what order they are merged; recency only breaks
  // ties between otherwise equal records.
  const staleRow = {
    knowledgeKey: 'knowledge:stale-source-newest',
    dimensions: { scope: TARGET, semanticFact: `${TARGET} stale variant`, failureMode: 'runtime-trial', rootCause: 'stale cause' },
    state: 'LEARNING', lastOutcome: 'failure',
    effectStats: { successCount: 0, failureCount: 3, successRate: 0, fitnessMean: 0.25 },
    occurrenceCount: 3, lastSeen: '2024-01-01T00:00:00.000Z',
  };
  const newerEntry = {
    signature: 'sig-newer', count: 1, status: 'active',
    problem: 'edge cache warmup latency newer variant', prevention: 'inspect dependencies first',
    experiment: { patternKey: TARGET },
    result: { category: 'runtime-trial', rootCauseHypothesis: 'newer cause' },
    lastSeenAt: '2026-01-01T00:00:00.000Z',
  };
  const alone = finalizeExperienceRecall(INPUT, [collectKnowledgeExperience([staleRow], INPUT, {})], {});
  const merged = finalizeExperienceRecall(INPUT, [
    collectKnowledgeExperience([staleRow], INPUT, {}),
    collectFailureMemoryExperience([newerEntry], INPUT, {}),
  ], {});
  const reordered = finalizeExperienceRecall(INPUT, [
    collectFailureMemoryExperience([newerEntry], INPUT, {}),
    collectKnowledgeExperience([staleRow], INPUT, {}),
  ], {});
  assert.equal(alone.failures.length, 1);
  const staleAlone = alone.failures[0];
  assert.equal(merged.counts.matched, 2);
  assert.equal(
    merged.failures.find((record) => record.key === staleAlone.key).score,
    staleAlone.score,
    'a newer source must not move the score of an unrelated record',
  );
  const order = (result) => result.failures.map((record) => record.key);
  assert.deepEqual(order(merged), order(reordered), 'source order must not select a different failure');
  assert.equal(order(merged)[0], staleAlone.key, 'the better-evidenced failure is selected first');
});

const F1_ORDINARY = 12;

function ordinaryFailureRow(index) {
  return {
    knowledgeKey: `knowledge:ordinary-${index}`,
    dimensions: { semanticFact: `edge cache warmup latency ordinary ${index}`, scope: TARGET, failureMode: 'runtime-trial', rootCause: `ordinary cause ${index}` },
    state: 'LEARNING', lastOutcome: 'failure',
    effectStats: { successCount: 0, failureCount: 1, successRate: 0 },
    occurrenceCount: 1, lastSeen: '2025-01-01T00:00:00.000Z',
  };
}

function twoOccurrenceFailureRow() {
  return {
    knowledgeKey: 'knowledge:b',
    dimensions: { semanticFact: 'edge cache warmup latency B', scope: TARGET, failureMode: 'runtime-trial', rootCause: 'cause B' },
    state: 'LEARNING', lastOutcome: 'failure',
    effectStats: { successCount: 0, failureCount: 2, successRate: 0 },
    occurrenceCount: 2, lastSeen: '2024-01-01T00:00:00.000Z',
  };
}

function newerFailureMemoryEntry() {
  return {
    signature: 'sig-newer-source', count: 1, status: 'active',
    problem: 'edge cache warmup latency newer variant', prevention: 'inspect dependencies first',
    experiment: { patternKey: TARGET },
    result: { category: 'runtime-trial', rootCauseHypothesis: 'newer cause' },
    lastSeenAt: '2026-01-01T00:00:00.000Z',
  };
}

test('recall: the unified score decides the per-source cut as well as the final order', () => {
  // B is older than the 12 ordinary rows of its own source, so a source-local
  // recency basis made it the worst record of the matched set and the
  // `maxRecords` cut dropped it before the merge ever saw it. One score for
  // both stages keeps it, and the final answer ranks it ahead of the
  // occurrences-1 rows that used to evict it.
  const ordinary = Array.from({ length: F1_ORDINARY }, (_, index) => ordinaryFailureRow(index));
  const collected = collectKnowledgeExperience([...ordinary, twoOccurrenceFailureRow()], INPUT, {});
  assert.equal(collected.records.length, EXPERIENCE_RECALL_LIMITS.maxRecords, 'the per-source cap still holds');
  assert.ok(
    collected.records.some((record) => record.key === 'knowledge:b'),
    'the per-source cut must not drop the record the unified score ranks higher',
  );
  const result = finalizeExperienceRecall(INPUT, [collected, collectFailureMemoryExperience([newerFailureMemoryEntry()], INPUT, {})], {});
  assert.equal(result.failures[0].key, 'knowledge:b', 'B leads the merged answer');
  const weakIndexes = result.failures
    .map((record, index) => (String(record.key ?? '').startsWith('knowledge:ordinary-') ? index : -1))
    .filter((index) => index >= 0);
  assert.ok(weakIndexes.length > 0, 'the occurrences-1 rows are still returned');
  assert.ok(weakIndexes.every((index) => index > 0), 'B ranks ahead of every occurrences-1 row');
});

test('recall: an identical-fact duplicate never consumes a maxRecords slot', () => {
  const duplicateRow = (index) => ({
    knowledgeKey: `knowledge:dup-${index}`,
    dimensions: { semanticFact: 'edge cache warmup latency duplicate', scope: TARGET, strategy: 'warm the cache before dependencies' },
    state: 'KNOWN', lastOutcome: 'success',
    effectStats: { successCount: 5, failureCount: 0, successRate: 1, fitnessMean: 1 },
    occurrenceCount: 5, lastSeen: '2026-01-01T00:00:00.000Z',
    sourceRefs: [`observations:dup-${index}`],
  });
  const distinctRow = {
    knowledgeKey: 'knowledge:distinct-low',
    dimensions: { semanticFact: 'edge cache warmup latency distinct', scope: TARGET, strategy: 'retry with backoff' },
    state: 'KNOWN', lastOutcome: 'success',
    effectStats: { successCount: 1, failureCount: 0, successRate: 1, fitnessMean: 0 },
    occurrenceCount: 1, lastSeen: '2026-01-01T00:00:00.000Z',
  };
  const collected = collectKnowledgeExperience(
    [...Array.from({ length: F1_ORDINARY }, (_, index) => duplicateRow(index)), distinctRow],
    INPUT,
    {},
  );
  assert.equal(collected.duplicates, F1_ORDINARY - 1, 'the collector reports what it collapsed in-source');
  assert.equal(collected.records.length, 2, '12 identical facts are one slot, not 12');
  assert.ok(
    collected.records.some((record) => record.key === 'knowledge:distinct-low'),
    'the lower-scoring distinct record survives the cap instead of being evicted by duplicates',
  );
  const result = finalizeExperienceRecall(INPUT, [collected], {});
  assert.deepEqual(result.counts, { matched: 2, returned: 2, duplicates: F1_ORDINARY - 1 });
  assert.equal(result.truncated, false);
  // The survivor is the first in comparator order and keeps the union of the
  // group's refs, survivor first and still inside maxEvidenceRefs.
  assert.equal(result.candidates[0].key, 'knowledge:dup-0');
  assert.deepEqual(result.candidates[0].evidenceRefs, ['observations:dup-0', 'observations:dup-1']);
  assert.ok(result.candidates[0].evidenceRefs.length <= EXPERIENCE_RECALL_LIMITS.maxEvidenceRefs);
});

test('recall: an ambiguous ordering key cannot make the order follow the merge order', () => {
  // Both records join to the same separator-delimited key without length
  // prefixes (`k\0a\0b\0c\0...`), so the comparator returned 0 for two
  // different records and the stable sort fell back to whichever source was
  // merged first. They are different facts (different problem text), so both
  // must survive and their relative order must be fixed.
  const base = {
    key: 'k', problem: 'c', scope: TARGET, strategy: '',
    failureMode: 'runtime-trial', rootCause: '', prevention: '',
    state: 'KNOWN', lastOutcome: 'success', successCount: 1, failureCount: 0, successRate: 1,
    fitnessMean: 0.5, regressionCount: 0, occurrences: 1,
    firstSeen: null, lastSeen: '2026-01-01T00:00:00.000Z', evidenceRefs: [],
  };
  const colliding = [{ ...base, source: 'a\u0000b' }, { ...base, source: 'a', problem: 'b\u0000c' }];
  const sources = colliding.map((record, index) => ({ source: `s${index + 1}`, records: [{ ...record }], considered: 1, scanned: 1 }));
  const forward = finalizeExperienceRecall(INPUT, sources, {});
  const reverse = finalizeExperienceRecall(INPUT, [...sources].reverse(), {});
  assert.equal(forward.resolved.length, 2, 'the two different descriptions are two facts');
  assert.equal(forward.counts.duplicates, 0);
  assert.equal(serializeRecall(forward), serializeRecall(reverse), 'the ranked answer cannot depend on source order');
  assert.deepEqual(forward.resolved.map((record) => record.source), reverse.resolved.map((record) => record.source));
});

test('recall: an explicit coverage difference breaks the ordering-key tie', () => {
  // Two third-party records are identical in every reported field except the
  // explicitly supplied `coverage`. Both score to the same rounded 0.7434 (the
  // 0.40 coverage term shifts them by 0.00004), so `compareCandidates` reaches
  // the ordering key with a real tie to break. Before that key encoded
  // `coverage`, the keys were equal and the comparator returned 0, so the
  // stable sort and the dedupe survivor fell back to source merge order:
  // finalizing [A, B] returned coverage 0.9001, finalizing [B, A] 0.9002.
  const base = {
    key: 'knowledge:coverage-tie', problem: 'edge cache warmup latency', scope: TARGET,
    strategy: 'warm the cache before dependencies', failureMode: 'runtime-trial',
    rootCause: 'warmup race', prevention: 'inspect dependencies first',
    state: 'KNOWN', lastOutcome: 'success', successCount: 1, failureCount: 0,
    successRate: 1, fitnessMean: null, regressionCount: 0, occurrences: 1,
    firstSeen: '2025-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z',
    evidenceRefs: [],
  };
  const entry = (name, coverage) => ({ source: name, considered: 1, scanned: 1, records: [{ ...base, source: 'coverage-tie', coverage }] });
  const forward = finalizeExperienceRecall(INPUT, [entry('a-source', 0.9001), entry('b-source', 0.9002)], {});
  const reverse = finalizeExperienceRecall(INPUT, [entry('b-source', 0.9002), entry('a-source', 0.9001)], {});
  assert.equal(forward.candidates.length, 1, 'the two identity-equal snapshots are one fact');
  assert.equal(forward.counts.duplicates, 1);
  assert.equal(serializeRecall(forward), serializeRecall(reverse), 'the ranked answer cannot depend on source order');
  // A non-zero comparator (equivalently a non-equal ordering key) is what makes
  // the survivor the same record in both directions: a 0 here would leave the
  // stable sort to pick whichever source was merged first.
  assert.equal(forward.candidates[0].coverage, 0.9001);
  assert.equal(reverse.candidates[0].coverage, 0.9001);
});

test('recall: collapsing snapshots keeps the earliest firstSeen', () => {
  // Two identity-equal snapshots of the same knowledge key (same description,
  // outcome and measurement set) differ only in their dates. The survivor is
  // the newest snapshot by `compareCandidates`, so without merging the dates it
  // reported `firstSeen` 2022 while the documented contract is the earliest
  // snapshot. Reproduces through the real collector and through two sources.
  const key = experienceKnowledgeKey({ target: TARGET });
  const snapshot = (firstSeen, lastSeen) => ({
    knowledgeKey: key,
    dimensions: { semanticFact: TARGET, scope: TARGET },
    state: 'LEARNING', lastOutcome: 'neutral',
    effectStats: { successCount: 0, failureCount: 0, successRate: null },
    occurrenceCount: 4, firstSeen, lastSeen,
  });
  const old = snapshot('2020-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
  const recent = snapshot('2022-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
  for (const rows of [[old, recent], [recent, old]]) {
    const collected = collectKnowledgeExperience(rows, INPUT, {});
    assert.equal(collected.records.length, 1, 'the collector collapses the two snapshots into one fact');
    assert.equal(collected.records[0].firstSeen, '2020-01-01T00:00:00.000Z', 'the collector keeps the earliest snapshot date');
    const result = finalizeExperienceRecall(INPUT, [collected], {});
    assert.equal(result.duplicate.firstSeen, '2020-01-01T00:00:00.000Z');
    assert.equal(result.duplicate.lastSeen, '2025-01-01T00:00:00.000Z', 'the newest snapshot still supplies lastSeen');
  }
  const fromSources = (order) => finalizeExperienceRecall(
    INPUT,
    order.map((record, index) => ({ source: `s${index}`, considered: 1, scanned: 1, records: [{ ...record, key }] })),
    {},
  );
  assert.equal(fromSources([old, recent]).duplicate.firstSeen, '2020-01-01T00:00:00.000Z');
  assert.equal(fromSources([recent, old]).duplicate.firstSeen, '2020-01-01T00:00:00.000Z');
});

test('recall: an extended-year firstSeen cannot win the earliest slot', () => {
  // `isoOrNull` returns `toISOString()`, so an extended-year snapshot is wider
  // than the usual 24 characters: "+010000-01-01T00:00:00.000Z" is 27. Selecting
  // the earliest `firstSeen` by plain string sort put the leading `+` (0x2B)
  // ahead of `2` (0x32), so the year-+010000 snapshot was reported as the
  // earliest of a 2020/2025 pair. Every value that reaches the two selections
  // has already passed `isoOrNull`, so both must order by parsed epoch.
  const key = experienceKnowledgeKey({ target: TARGET });
  const snapshot = (firstSeen, lastSeen, state) => ({
    knowledgeKey: key,
    dimensions: { semanticFact: TARGET, scope: TARGET },
    state,
    lastOutcome: 'neutral',
    effectStats: { successCount: 0, failureCount: 0, successRate: null },
    occurrenceCount: 4,
    firstSeen,
    lastSeen,
  });
  const present = snapshot('2020-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', 'LEARNING');
  const wide = snapshot('+010000-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', 'KNOWN');
  for (const rows of [[present, wide], [wide, present]]) {
    const collected = collectKnowledgeExperience(rows, INPUT, {});
    assert.equal(collected.records.length, 1, 'the collector collapses the two snapshots into one fact');
    assert.equal(collected.records[0].firstSeen, '2020-01-01T00:00:00.000Z', 'the collector keeps the 2020 snapshot, not the wider extended-year string');
    const result = finalizeExperienceRecall(INPUT, [collected], {});
    assert.equal(result.duplicate.firstSeen, '2020-01-01T00:00:00.000Z', 'the reported firstSeen is the earliest by epoch');
    assert.equal(result.duplicate.lastSeen, '2025-01-01T00:00:00.000Z', 'the newest snapshot still supplies lastSeen');
    assert.equal(result.duplicate.state, 'KNOWN', 'the newest snapshot still supplies state');
    assert.equal(result.duplicate.occurrences, 4, 'the shared occurrence count is unchanged');
  }
  const projected = (entry) => collectKnowledgeExperience([entry], INPUT, {}).records[0];
  const fromSources = (order) => finalizeExperienceRecall(
    INPUT,
    order.map((entry, index) => ({ source: `s${index}`, considered: 1, scanned: 1, records: [projected(entry)] })),
    {},
  );
  for (const order of [[present, wide], [wide, present]]) {
    const result = fromSources(order);
    assert.equal(result.counts.duplicates, 1, 'the two sources hold one collapsed fact');
    assert.equal(result.duplicate.firstSeen, '2020-01-01T00:00:00.000Z', 'the cross-source duplicate reports the earliest snapshot by epoch');
    assert.equal(result.duplicate.lastSeen, '2025-01-01T00:00:00.000Z');
    assert.equal(result.duplicate.state, 'KNOWN');
    assert.equal(result.duplicate.occurrences, 4);
  }
});

test('recall: finalize never writes to the records a source handed over', () => {
  const collected = collectKnowledgeExperience([twoOccurrenceFailureRow()], INPUT, {});
  const first = finalizeExperienceRecall(INPUT, [collected], {});
  const firstSnapshot = JSON.stringify(first);
  const collectedSnapshot = JSON.stringify(collected.records);
  for (const record of collected.records) Object.freeze(record);
  // A newer source changes the merged set; it must not rewrite a result that
  // was already returned, and it must not throw on the frozen records.
  const second = finalizeExperienceRecall(INPUT, [collected, collectFailureMemoryExperience([newerFailureMemoryEntry()], INPUT, {})], {});
  assert.equal(JSON.stringify(first), firstSnapshot, 'an already returned result must not change');
  assert.equal(JSON.stringify(collected.records), collectedSnapshot, 'the collector output must not be re-scored');
  assert.ok(second.failures.length >= 2);
  const frozen = [{ source: 'knowledge', records: collected.records.map((record) => ({ ...record })), considered: 1, scanned: 1 }];
  for (const record of frozen[0].records) Object.freeze(record);
  const frozenResult = finalizeExperienceRecall(INPUT, frozen, {});
  assert.equal(frozenResult.failures.length, 1);
  assert.equal(frozenResult.failures[0].score, first.failures[0].score, 'a frozen record keeps the score it carried');
  assert.equal('score' in frozen[0].records[0], true, 'finalize does not add fields to the record it was given');
});

test('recall: a record without coverage is scored from its own text match', () => {
  const row = {
    knowledgeKey: 'knowledge:coverage-probe',
    dimensions: { semanticFact: 'edge cache warmup latency', scope: TARGET, failureMode: 'runtime-trial', rootCause: 'warmup race' },
    state: 'LEARNING', lastOutcome: 'failure',
    effectStats: { successCount: 0, failureCount: 1, successRate: 0, fitnessMean: 0.5 },
    occurrenceCount: 1, lastSeen: '2025-01-01T00:00:00.000Z',
  };
  const projected = collectKnowledgeExperience([row], INPUT, {}).records[0];
  const { coverage, score, exact, ...raw } = projected;
  assert.equal('coverage' in raw, false, 'the raw record really carries no coverage');
  assert.equal(exact, false);
  // A custom domainStorage.recall() may return records with no coverage at
  // all; assuming zero relevance would score it as irrelevant.
  const bare = finalizeExperienceRecall(INPUT, [{ source: 'knowledge', records: [raw], considered: 1, scanned: 1 }], {});
  assert.equal(bare.failures[0].coverage, coverage, 'the coverage implied by the record text is not read as zero');
  assert.equal(bare.failures[0].score, score, 'the recomputed score matches the projection');
  // A record that carries coverage keeps it: 0.4 * 0.123 + 0.2 * 0.5 + 0.1 * (1 / 3).
  const carried = finalizeExperienceRecall(INPUT, [{ source: 'knowledge', records: [{ ...raw, coverage: 0.123 }], considered: 1, scanned: 1 }], {});
  assert.equal(carried.failures[0].coverage, 0.123);
  assert.equal(carried.failures[0].score, 0.1825);
});

test('recall: a richer record is never collapsed away by an identical description', () => {
  const base = {
    source: 'knowledge', scope: TARGET, strategy: '', failureMode: 'runtime-trial',
    rootCause: 'warmup race', prevention: '', state: 'LEARNING',
    successCount: 0, failureCount: 3, successRate: 0, fitnessMean: 0.5,
    firstSeen: null, lastSeen: '2026-01-01T00:00:00.000Z',
  };
  const poor = { ...base, key: 'a', problem: 'edge cache warmup latency', occurrences: 3, regressionCount: 0, lastOutcome: 'failure', evidenceRefs: [] };
  const rich = {
    ...base, key: 'z', problem: 'edge cache warmup latency', occurrences: 999, failureCount: 999,
    regressionCount: 7, lastOutcome: 'regression', evidenceRefs: ['observations:ref-1', 'journal:ref-2'],
  };
  const result = finalizeExperienceRecall(
    INPUT,
    [{ source: 'knowledge', records: [poor, rich].map((record) => ({ ...record })), considered: 2, scanned: 2 }],
    {},
  );
  assert.equal(result.counts.duplicates, 0, 'a different outcome or evidence magnitude is a different fact');
  assert.equal(result.counts.matched, 2);
  assert.equal(result.failures.length, 2, 'both observations are returned');
  const richer = result.failures.find((record) => record.key === 'z');
  assert.ok(richer, 'the richer record is not the one that gets dropped');
  assert.equal(richer.lastOutcome, 'regression');
  assert.equal(richer.regressionCount, 7);
  assert.equal(richer.evidenceRefs.length, 2, 'its provenance survives');
});

test('recall: collapsing a cross-source duplicate keeps the union of its provenance', () => {
  const base = {
    problem: 'edge cache warmup latency', scope: TARGET, strategy: '', failureMode: 'runtime-trial',
    rootCause: 'warmup race', prevention: '', state: 'LEARNING', lastOutcome: 'failure',
    successCount: 0, failureCount: 2, successRate: 0, fitnessMean: 0.5, regressionCount: 0,
    occurrences: 2, firstSeen: null, lastSeen: '2026-01-01T00:00:00.000Z',
  };
  const result = finalizeExperienceRecall(INPUT, [
    { source: 'a-source', considered: 1, scanned: 1, records: [{ ...base, source: 'a-source', key: 'shared-fact', evidenceRefs: ['observations:a'] }] },
    { source: 'b-source', considered: 1, scanned: 1, records: [{ ...base, source: 'b-source', key: 'shared-fact', evidenceRefs: ['journal:b'] }] },
  ], {});
  assert.equal(result.counts.duplicates, 1, 'the same fact from two sources is one duplicate');
  assert.equal(result.counts.matched, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].source, 'a-source', 'the first record in comparator order survives');
  assert.deepEqual(result.failures[0].evidenceRefs, ['observations:a', 'journal:b'], 'survivor first, then the other source');
});

test('recall: an exact replay survives the per-source cap', () => {
  const ordinary = Array.from({ length: 14 }, (_, index) => ordinaryCandidateRow(index));
  for (const [label, lastSeen] of [['recent', '2026-01-01T00:00:00.000Z'], ['old', '2020-01-01T00:00:00.000Z']]) {
    const collected = collectKnowledgeExperience([exactFailureRow(lastSeen), ...ordinary], INPUT, {});
    assert.equal(collected.records.length, EXPERIENCE_RECALL_LIMITS.maxRecords, label);
    assert.ok(collected.records.some((record) => record.exact), `${label}: 14 higher-scoring rows must not evict the exact replay`);
    assert.equal(collected.records[0].exact, true, `${label}: exact matches rank first`);
    const result = finalizeExperienceRecall(INPUT, [collected], {});
    assert.ok(result.duplicate, `${label}: the exact replay is still reported`);
    assert.equal(result.duplicate.key, EXACT_KEY);
  }
});

test('recall: an exact replay survives the scan window and the cap together', () => {
  const rows = [exactFailureRow('2020-01-01T00:00:00.000Z')];
  for (let index = 0; index < 39; index += 1) rows.push(ordinaryCandidateRow(index));
  const collected = collectKnowledgeExperience(rows, INPUT, { limits: { maxConsidered: 20 } });
  assert.equal(collected.considered, 20);
  assert.equal(collected.scanned, 40);
  assert.ok(collected.records.some((record) => record.exact), 'the windowed-out exact replay is still retained');
  assert.equal(collected.records.length, EXPERIENCE_RECALL_LIMITS.maxRecords, 'the per-source cap still holds');
  const result = finalizeExperienceRecall(INPUT, [collected], { limits: { maxConsidered: 20 } });
  assert.equal(result.duplicate.key, EXACT_KEY);
});

test('recall: an exact failed replay is not evicted from failures by higher-scoring rows', () => {
  const rows = [exactFailureRow('2020-01-01T00:00:00.000Z')];
  for (let index = 0; index < 14; index += 1) {
    rows.push({
      knowledgeKey: `knowledge:failed-${index}`,
      dimensions: { scope: TARGET, semanticFact: `${TARGET} failed variant ${index}`, failureMode: 'runtime-trial', rootCause: `cause ${index}` },
      state: 'LEARNING', lastOutcome: 'failure',
      effectStats: { successCount: 0, failureCount: 5, successRate: 0, fitnessMean: 1 },
      occurrenceCount: 5, lastSeen: '2026-01-01T00:00:00.000Z',
    });
  }
  const result = finalizeExperienceRecall(INPUT, [collectKnowledgeExperience(rows, INPUT, {})], {});
  assert.equal(result.failures.length, EXPERIENCE_RECALL_LIMITS.maxEntries);
  assert.equal(result.failures[0].exact, true, 'the exact replay keeps its bucket slot');
  assert.equal(result.failures[0].key, EXACT_KEY);
});

test('recall: identical facts recorded in two sources are reported once per bucket', () => {
  const knowledge = collectKnowledgeExperience([
    {
      knowledgeKey: EXACT_KEY,
      dimensions: { semanticFact: 'edge cache warmup latency', scope: TARGET, failureMode: 'runtime-trial', rootCause: 'cache warms up before dependencies' },
      state: 'LEARNING', lastOutcome: 'failure',
      effectStats: { successCount: 0, failureCount: 3, successRate: 0 }, occurrenceCount: 3,
      lastSeen: '2026-01-01T00:00:00.000Z',
      sourceRefs: ['observations:failed-a', 'observations:failed-b'],
    },
    {
      knowledgeKey: 'knowledge:resolved-twin',
      dimensions: { semanticFact: 'edge cache warmup latency', scope: TARGET, failureMode: 'runtime-trial' },
      state: 'KNOWN', lastOutcome: 'success',
      effectStats: { successCount: 1, failureCount: 0, successRate: 1 }, occurrenceCount: 3,
      lastSeen: '2026-01-01T00:00:00.000Z',
    },
  ], INPUT, {});
  const memory = collectFailureMemoryExperience([
    {
      signature: 'sig-duplicate-failed', count: 3, status: 'active',
      problem: 'edge cache warmup latency', experiment: { patternKey: TARGET },
      result: { category: 'runtime-trial', rootCauseHypothesis: 'cache warms up before dependencies' },
      lastSeenAt: '2026-01-01T00:00:00.000Z',
    },
    {
      signature: 'sig-duplicate-resolved', count: 3, status: 'resolved',
      problem: 'edge cache warmup latency', experiment: { patternKey: TARGET },
      result: { category: 'runtime-trial' }, lastSeenAt: '2026-01-01T00:00:00.000Z',
    },
  ], INPUT, {});
  const result = finalizeExperienceRecall(INPUT, [knowledge, memory], {});
  assert.equal(result.failures.length, 1, 'one logical failure, one entry');
  assert.equal(result.resolved.length, 1, 'one logical resolution, one entry');
  assert.equal(result.counts.duplicates, 2, 'the same content from two sources is merged, additively counted');
  assert.equal(result.counts.matched, 2);
  assert.equal(result.duplicate.key, EXACT_KEY, 'dedupe happens after the duplicate report');
  // The survivor carries the union of the group's refs, survivor first, still
  // capped by maxEvidenceRefs.
  assert.deepEqual(result.failures[0].evidenceRefs, ['observations:failed-a', 'observations:failed-b']);
  assert.ok(result.failures[0].evidenceRefs.length <= EXPERIENCE_RECALL_LIMITS.maxEvidenceRefs);
});

test('recall: identical text of different kinds is never merged', () => {
  const rows = [
    {
      knowledgeKey: 'knowledge:candidate-x',
      dimensions: { semanticFact: 'edge cache warmup latency', scope: TARGET, strategy: 'warm the cache before dependencies' },
      state: 'KNOWN', lastOutcome: 'success',
      effectStats: { successCount: 3, failureCount: 0, successRate: 1 }, occurrenceCount: 3,
      lastSeen: '2026-01-01T00:00:00.000Z',
    },
    {
      knowledgeKey: 'knowledge:failed-x',
      dimensions: { semanticFact: 'edge cache warmup latency', scope: TARGET, strategy: 'warm the cache before dependencies' },
      state: 'LEARNING', lastOutcome: 'failure',
      effectStats: { successCount: 0, failureCount: 3, successRate: 0 }, occurrenceCount: 3,
      lastSeen: '2026-01-01T00:00:00.000Z',
    },
  ];
  const result = finalizeExperienceRecall(INPUT, [collectKnowledgeExperience(rows, INPUT, {})], {});
  assert.equal(result.candidates.length, 1, 'a measured success stays a candidate');
  assert.equal(result.failures.length, 1, 'the failed attempt stays a failure');
  assert.equal(result.counts.duplicates, 0);
  assert.equal(result.counts.matched, 2);
});

test('recall: repeated and source-reordered calls serialize identically', () => {
  const knowledge = () => collectKnowledgeExperience([exactFailureRow('2026-01-01T00:00:00.000Z'), ...Array.from({ length: 6 }, (_, index) => ordinaryCandidateRow(index))], INPUT, {});
  const memory = () => collectFailureMemoryExperience([0, 1].map(weakFailureEntry), INPUT, {});
  const first = finalizeExperienceRecall(INPUT, [knowledge(), memory()], {});
  const second = finalizeExperienceRecall(INPUT, [knowledge(), memory()], {});
  assert.equal(JSON.stringify(first), JSON.stringify(second), 'identical calls are byte-identical');
  const reordered = finalizeExperienceRecall(INPUT, [memory(), knowledge()], {});
  assert.equal(serializeRecall(first), serializeRecall(reordered), 'source order does not change the answer');
});

test('recall: bounds hold across two sources and at the maxRecords boundary', () => {
  const candidates = Array.from({ length: EXPERIENCE_RECALL_LIMITS.maxRecords + 1 }, (_, index) => ordinaryCandidateRow(index));
  const knowledge = collectKnowledgeExperience(candidates, INPUT, {});
  const memory = collectFailureMemoryExperience(Array.from({ length: 20 }, (_, index) => weakFailureEntry(index)), INPUT, {});
  const result = finalizeExperienceRecall(INPUT, [knowledge, memory], {});
  assert.equal(knowledge.records.length, EXPERIENCE_RECALL_LIMITS.maxRecords, 'one source never exceeds maxRecords');
  assert.equal(memory.records.length, EXPERIENCE_RECALL_LIMITS.maxRecords);
  assert.ok(result.resolved.length <= EXPERIENCE_RECALL_LIMITS.maxEntries);
  assert.ok(result.failures.length <= EXPERIENCE_RECALL_LIMITS.maxEntries);
  assert.ok(result.candidates.length <= EXPERIENCE_RECALL_LIMITS.maxEntries);
  assert.equal(result.counts.matched, EXPERIENCE_RECALL_LIMITS.maxRecords * 2);
  assert.equal(result.counts.returned, EXPERIENCE_RECALL_LIMITS.maxEntries * 2);
  assert.equal(result.counts.duplicates, 0);
  assert.equal(result.truncated, true, 'maxRecords + 1 rows cannot all be returned');
  // Exactly maxEntries rows fit, so nothing is truncated.
  const exactFit = finalizeExperienceRecall(INPUT, [collectKnowledgeExperience(candidates.slice(0, EXPERIENCE_RECALL_LIMITS.maxEntries), INPUT, {})], {});
  assert.deepEqual(exactFit.counts, { matched: EXPERIENCE_RECALL_LIMITS.maxEntries, returned: EXPERIENCE_RECALL_LIMITS.maxEntries, duplicates: 0 });
  assert.equal(exactFit.truncated, false);
  // A missing source is reported, and empty inputs stay empty and consistent.
  const degraded = finalizeExperienceRecall(INPUT, [{ source: 'knowledge', error: 'unavailable' }, collectFailureMemoryExperience([], INPUT, {})], {});
  assert.deepEqual(degraded.unavailable, ['knowledge:unavailable']);
  assert.deepEqual(degraded.counts, { matched: 0, returned: 0, duplicates: 0 });
  assert.equal(degraded.truncated, false);
  assert.deepEqual([degraded.resolved, degraded.failures, degraded.candidates], [[], [], []]);
  assert.ok(JSON.stringify(result).length < 12_000, 'recall output must stay inside the declared context bound');
});

// ---------------------------------------------------------------------------
// five independent-review findings: total order, complete identity, occurrence
// counting, source-level truncation, and bounds on hand-supplied records
// ---------------------------------------------------------------------------

test('recall: two facts that differ only in outcome state never flip with source order', () => {
  // Both records share source, key, the six content fields, score and
  // lastSeen, and differ only in `lastOutcome` / `regressionCount`. The old
  // ordering key covered just key/source/content, so it tied and the stable
  // sort fell back to source order: with `maxEntries: 1` swapping the sources
  // flipped the returned failure between `failure` and `regression`.
  const base = {
    source: 'shared-source', key: 'shared-key', problem: 'edge cache warmup latency', scope: TARGET,
    strategy: '', failureMode: 'runtime-trial', rootCause: 'warmup race', prevention: '',
    state: 'LEARNING', successCount: 0, failureCount: 1, successRate: 0, fitnessMean: 0.5,
    occurrences: 1, firstSeen: null, lastSeen: '2026-01-01T00:00:00.000Z', evidenceRefs: [],
  };
  const failureFact = { ...base, lastOutcome: 'failure', regressionCount: 0 };
  const regressionFact = { ...base, lastOutcome: 'regression', regressionCount: 1 };
  const first = { source: 'order-a', considered: 1, scanned: 1, records: [{ ...failureFact }] };
  const second = { source: 'order-b', considered: 1, scanned: 1, records: [{ ...regressionFact }] };
  const forward = finalizeExperienceRecall(INPUT, [first, second], { limits: { maxEntries: 1 } });
  const reverse = finalizeExperienceRecall(INPUT, [second, first], { limits: { maxEntries: 1 } });
  assert.equal(forward.failures.length, 1);
  assert.equal(reverse.failures.length, 1);
  assert.deepEqual(forward.failures, reverse.failures, 'the selected failure cannot follow the merge order');
  assert.equal(serializeRecall(forward), serializeRecall(reverse));
});

test('recall: records with different recorded counts are different facts', () => {
  // Same description, outcome, occurrences and regressionCount; the recorded
  // failure counts differ (the occurrences come from `occurrenceCount`, so the
  // counts are not implied). The old identity ignored them and merged the two,
  // keeping only the `failureCount: 1` record.
  const base = {
    source: 'knowledge', problem: 'edge cache warmup latency', scope: TARGET, strategy: '',
    failureMode: 'runtime-trial', rootCause: 'warmup race', prevention: '', state: 'LEARNING',
    lastOutcome: 'failure', successCount: 0, successRate: 0, fitnessMean: 0.5, regressionCount: 0,
    occurrences: 4, firstSeen: null, lastSeen: '2026-01-01T00:00:00.000Z', evidenceRefs: [],
  };
  const shallow = { ...base, key: 'k-a', failureCount: 1 };
  const deep = { ...base, key: 'k-b', failureCount: 4 };
  const result = finalizeExperienceRecall(
    INPUT,
    [{ source: 'knowledge', considered: 2, scanned: 2, records: [{ ...shallow }, { ...deep }] }],
    {},
  );
  assert.equal(result.counts.duplicates, 0, 'a different recorded count is a different observation');
  assert.equal(result.counts.matched, 2);
  assert.equal(result.failures.length, 2, 'both observations are returned');
  assert.deepEqual(result.failures.map((record) => record.failureCount).sort((left, right) => left - right), [1, 4]);
});

test('recall: exact-replay occurrences are the highest snapshot, never the sum', () => {
  const e = {
    source: 'knowledge', key: experienceKnowledgeKey({ target: TARGET }), problem: 'edge cache warmup latency',
    scope: TARGET, strategy: '', failureMode: 'runtime-trial', rootCause: 'warmup race', prevention: '',
    state: 'LEARNING', lastOutcome: 'failure', successCount: 0, failureCount: 3, successRate: 0,
    fitnessMean: 0.5, regressionCount: 0, occurrences: 3, firstSeen: '2025-12-01T00:00:00.000Z',
    lastSeen: '2026-01-01T00:00:00.000Z', evidenceRefs: [],
  };
  const once = finalizeExperienceRecall(INPUT, [{ source: 'knowledge', considered: 1, scanned: 1, records: [{ ...e }] }], {});
  const twice = finalizeExperienceRecall(INPUT, [{ source: 'knowledge', considered: 1, scanned: 1, records: [{ ...e }, { ...e }] }], {});
  const snapshots = finalizeExperienceRecall(
    INPUT,
    [{ source: 'knowledge', considered: 2, scanned: 2, records: [{ ...e }, { ...e, occurrences: 4 }] }],
    {},
  );
  assert.equal(once.duplicate.occurrences, 3);
  assert.equal(twice.duplicate.occurrences, 3, 'two snapshots of the same key are not six occurrences');
  assert.equal(snapshots.duplicate.occurrences, 4, 'the highest recorded snapshot wins');
  assert.equal(once.duplicate.firstSeen, '2025-12-01T00:00:00.000Z');
});

test('recall: a source-level retention drop is reported as truncation', () => {
  const rows = Array.from({ length: 13 }, (_, index) => ordinaryFailureRow(index));
  const collected = collectKnowledgeExperience(rows, INPUT, { limits: { maxRecords: 1, maxEntries: 1 } });
  assert.equal(collected.records.length, 1);
  assert.equal(collected.dropped, 12, 'the collector reports what its own cap dropped');
  const result = finalizeExperienceRecall(INPUT, [collected], { limits: { maxRecords: 1, maxEntries: 1 } });
  assert.deepEqual(result.counts, { matched: 1, returned: 1, duplicates: 0 });
  assert.equal(result.sources[0].dropped, 12);
  assert.equal(result.truncated, true, 'thirteen matches with one retained cannot be untruncated');
  // Only the source cap truncates here; the returned bucket is not full.
  const wide = finalizeExperienceRecall(INPUT, [collectKnowledgeExperience(rows, INPUT, { limits: { maxRecords: 1 } })], { limits: { maxRecords: 1 } });
  assert.equal(wide.failures.length, 1);
  assert.equal(wide.sources[0].dropped, 12);
  assert.equal(wide.truncated, true);
});

test('recall: a source cannot hand over records outside the declared bounds', () => {
  const collected = collectKnowledgeExperience([{
    knowledgeKey: experienceKnowledgeKey({ target: TARGET }),
    dimensions: { semanticFact: 'edge cache warmup latency', scope: TARGET },
    state: 'KNOWN', lastOutcome: 'success',
    effectStats: { successCount: 1, failureCount: 0, successRate: 1 },
    occurrenceCount: 1, lastSeen: '2026-01-01T00:00:00.000Z',
    sourceRefs: ['observations:a', 'journal:b'],
  }], INPUT, {});
  const tightened = finalizeExperienceRecall(INPUT, [collected], { limits: { maxText: 4, maxEvidenceRefs: 1 } });
  assert.ok(tightened.resolved[0].problem.length <= 4);
  assert.ok(tightened.resolved[0].scope.length <= 4);
  assert.equal(tightened.resolved[0].evidenceRefs.length, 1);
  assert.ok(tightened.resolved[0].evidenceRefs.every((ref) => ref.length <= EXPERIENCE_RECALL_LIMITS.maxRefLength));
  // The collector output itself is not rewritten by the re-projection.
  assert.equal(collected.records[0].problem.length > 4, true);
  assert.equal(collected.records[0].evidenceRefs.length, 2);

  const big = {
    source: 'knowledge', key: 'knowledge:big', problem: 'p'.repeat(10_000), scope: TARGET,
    strategy: '', failureMode: 'runtime-trial', rootCause: 'warmup race', prevention: '',
    state: 'LEARNING', lastOutcome: 'failure', successCount: 0, failureCount: 1, successRate: 0,
    fitnessMean: 0.5, regressionCount: 0, occurrences: 1, firstSeen: null,
    lastSeen: '2026-01-01T00:00:00.000Z',
    evidenceRefs: Array.from({ length: 100 }, (_, index) => `observations:ref-${index}`),
    extraFieldKept: 'x'.repeat(30_000),
  };
  const snapshot = JSON.stringify(big);
  const result = finalizeExperienceRecall(INPUT, [{ source: 'knowledge', considered: 1, scanned: 1, records: [big] }], {});
  const record = result.failures[0];
  assert.equal('extraFieldKept' in record, false, 'an undeclared field is not passed through');
  assert.ok(record.problem.length <= EXPERIENCE_RECALL_LIMITS.maxText);
  assert.ok(record.evidenceRefs.length <= EXPERIENCE_RECALL_LIMITS.maxEvidenceRefs);
  assert.ok(JSON.stringify(result).length < 12_000, 'a hostile record cannot widen the answer');
  assert.equal(JSON.stringify(big), snapshot, 'the caller record is not modified');

  // A third-party source handing over more than `maxRecords` distinct records
  // is capped, and the drop is reported instead of silently out of bounds.
  const many = Array.from({ length: EXPERIENCE_RECALL_LIMITS.maxRecords + 5 }, (_, index) => ({
    source: 'knowledge', key: `knowledge:many-${index}`, problem: `edge cache warmup latency many ${index}`,
    scope: TARGET, strategy: '', failureMode: 'runtime-trial', rootCause: `cause ${index}`, prevention: '',
    state: 'LEARNING', lastOutcome: 'failure', successCount: 0, failureCount: 1, successRate: 0,
    fitnessMean: 0.5, regressionCount: 0, occurrences: 1, firstSeen: null,
    lastSeen: '2026-01-01T00:00:00.000Z', evidenceRefs: [],
  }));
  const third = { source: 'third-party', considered: many.length, scanned: many.length, records: many };
  const capped = finalizeExperienceRecall(INPUT, [third], {});
  assert.equal(third.records.length, EXPERIENCE_RECALL_LIMITS.maxRecords + 5, 'the input array is not truncated in place');
  assert.equal(capped.sources[0].dropped, 5);
  assert.equal(capped.truncated, true);
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

test('recall: a mutated answer cannot write back into the stored knowledge rows', async () => {
  // The recall read shares the store's live rows instead of copying them (see
  // `EvolutionMemory.historyView`), so the one property that keeps that safe is
  // asserted here: every record the port returns is the collector's own bounded
  // projection, never a stored row, and mutating it cannot change the store or
  // the next answer.
  const root = scratch('evo-recall-writeback-');
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'), eventBridgeKey: 'e'.repeat(64) };
  const bridge = new EvolutionEventBridge({ file: config.eventBridgePath, key: config.eventBridgeKey });
  const port = await openDomainStorage(ctx, config);
  try {
    bridge.emit('proposal-created', { id: 'exp-writeback', proposal: { target: TARGET } });
    bridge.emit('experiment-rejected', {
      id: 'exp-writeback', proposal: { target: TARGET }, state: 'trial-failed',
      failure: { error: 'warmup race', errorCategory: 'runtime-trial', failurePhase: 'trial', rootCauseHypothesis: 'cache warms up before dependencies' },
    });
    assert.equal((await port.replay()).applied, 2);

    const input = { why: 'edge cache warmup latency', target: TARGET, impactScope: ['runtime'] };
    const before = port.query('knowledge');
    const first = port.recall(input);
    assert.ok(first.records.length > 0, 'the fixture records reachable knowledge rows');
    const snapshot = structuredClone(first);

    for (const record of first.records) {
      record.problem = 'mutated';
      record.scope = 'mutated';
      record.evidenceRefs.length = 0;
      if (record.key) record.key = `mutated:${record.key}`;
    }
    first.records.length = 0;
    first.considered = -1;
    first.scanned = -1;

    assert.deepEqual(port.recall(input), snapshot, 'the next answer is the recorded one, not the mutated one');
    assert.deepEqual(port.query('knowledge'), before, 'the mutation never reached the stored rows');
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
