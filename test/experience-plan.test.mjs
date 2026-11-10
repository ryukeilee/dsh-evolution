import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPERIENCE_PLAN_LIMITS,
  planEvolutionCandidates,
  parseConclusionStrategy,
  strategyFingerprint,
} from '../lib/experience-plan.js';

const DAY = 24 * 60 * 60 * 1000;
const BASE = Date.UTC(2026, 0, 1);
const iso = (ms) => new Date(ms).toISOString();
const VERSIONS = Object.freeze({ dsh: '3.1.0', cordis: '0.2.5', evolution: '0.2.3' });

/** One bounded experience record, i.e. exactly what `discover()` returns. */
function record(over = {}) {
  const value = {
    source: 'knowledge',
    key: 'knowledge:fixture',
    problem: '',
    scope: '',
    strategy: '',
    failureMode: '',
    rootCause: '',
    state: 'LEARNING',
    lastOutcome: 'failure',
    decision: '',
    successCount: 0,
    failureCount: 0,
    successRate: 0,
    fitnessMean: null,
    regressionCount: 0,
    occurrences: 1,
    firstSeen: iso(BASE),
    lastSeen: iso(BASE),
    evidenceRefs: [],
    prevention: '',
    ...over,
  };
  return value;
}

const conclusionStrategy = (over = {}) => JSON.stringify({
  approach: 'prewarm cache',
  cordis: '0.2.5',
  dsh: '3.1.0',
  evolution: '0.2.3',
  fingerprint: '0123456789abcdef',
  kind: 'cordis-plugin',
  ...over,
});

const conclusionRecord = (over = {}) => record({
  key: `knowledge:conclusion-${over.suffix ?? 'a'}`,
  scope: 'plugin:edge-cache',
  strategy: conclusionStrategy(over.strategy),
  state: 'REGRESSED',
  lastOutcome: 'failure',
  decision: 'no-benefit',
  failureCount: 1,
  regressionCount: 1,
  ...over,
});

test('plan: recurring failures become one bounded candidate with evidence', () => {
  const knowledge = [
    record({ key: 'knowledge:f1', scope: 'tool:read_file', failureCount: 2, occurrences: 2, failureMode: 'timeout', lastSeen: iso(BASE + 9 * DAY), evidenceRefs: ['observations:1'] }),
    record({ key: 'knowledge:f2', scope: 'tool:read_file', failureCount: 1, occurrences: 1, failureMode: 'timeout', lastSeen: iso(BASE + 11 * DAY), evidenceRefs: ['observations:2'] }),
    record({ key: 'knowledge:f3', scope: 'tool:read_file', failureCount: 1, occurrences: 1, failureMode: 'econnreset', lastSeen: iso(BASE + 12 * DAY), rootCause: 'socket reset' }),
  ];
  const plan = planEvolutionCandidates({ knowledge, failureMemory: [], versions: VERSIONS }, { now: BASE + 20 * DAY });
  assert.equal(plan.ok, true);
  assert.equal(plan.none, null);
  assert.equal(plan.candidates.length, 1);
  const candidate = plan.candidates[0];
  assert.deepEqual(plan.selected, candidate);
  assert.equal(candidate.problemKey, 'tool:read_file');
  assert.equal(candidate.problem, 'tool:read_file');
  assert.equal(candidate.occurrences, 4);
  assert.deepEqual(candidate.failureModes, ['timeout', 'econnreset']);
  assert.deepEqual(candidate.evidenceRefs, ['observations:1', 'observations:2']);
  assert.equal(candidate.firstSeen, iso(BASE));
  assert.equal(candidate.lastSeen, iso(BASE + 12 * DAY));
  assert.equal(candidate.risk, 'low');
  assert.equal(candidate.requiresNewHypothesis, false);
  assert.deepEqual(candidate.priorAttempts, []);
  assert.equal(candidate.applicabilityVerified, true);
  assert.deepEqual(candidate.applicability, VERSIONS);
  assert.match(candidate.whyCordisPlugin, /官方 Cordis 工具注册/);
  assert.match(candidate.expectedImprovement, /latencyMs/);
  assert.deepEqual(candidate.acceptanceMetrics.map((metric) => metric.name), ['latencyMs', 'probeControlStable']);
  assert.ok(candidate.rollbackConditions.length >= 1 && candidate.rollbackConditions.length <= 3);
  assert.ok(candidate.score > 0 && candidate.score <= 1);
  assert.equal(candidate.score, Math.round(candidate.score * 10_000) / 10_000);
});

test('plan: a resolution at least as new as the latest failure excludes the target', () => {
  const knowledge = [
    record({ key: 'knowledge:f1', scope: 'tool:read_file', failureCount: 3, occurrences: 3, failureMode: 'timeout', lastSeen: iso(BASE + 10 * DAY) }),
    record({ key: 'knowledge:r1', scope: 'tool:read_file', successCount: 1, occurrences: 1, lastOutcome: 'success', state: 'KNOWN', lastSeen: iso(BASE + 10 * DAY) }),
  ];
  const excluded = planEvolutionCandidates({ knowledge, versions: VERSIONS }, { now: BASE + 20 * DAY });
  assert.equal(excluded.candidates.length, 0);
  assert.equal(excluded.none.reason, 'already-resolved');
  assert.equal(excluded.rejected[0].reason, 'already-resolved');
  assert.equal(excluded.rejected[0].problemKey, 'tool:read_file');

  // An older resolution does not exclude; it is reported as known context.
  const older = planEvolutionCandidates({
    knowledge: [knowledge[0], { ...knowledge[1], lastSeen: iso(BASE + 5 * DAY) }],
    versions: VERSIONS,
  }, { now: BASE + 20 * DAY });
  assert.equal(older.candidates.length, 1);
  assert.deepEqual(older.candidates[0].knownResolution, { at: iso(BASE + 5 * DAY), outcome: 'success' });
});

test('plan: same-version ineffective conclusions require a new hypothesis', () => {
  const knowledge = [
    record({ key: 'knowledge:f1', scope: 'plugin:edge-cache', failureCount: 2, occurrences: 2, failureMode: 'timeout', lastSeen: iso(BASE + 4 * DAY) }),
    conclusionRecord({ suffix: 'nb', lastSeen: iso(BASE + 6 * DAY), decision: 'no-benefit' }),
    conclusionRecord({ suffix: 'rg', lastSeen: iso(BASE + 7 * DAY), decision: 'regression', state: 'REGRESSED', regressionCount: 1 }),
  ];
  const plan = planEvolutionCandidates({ knowledge, versions: VERSIONS }, { now: BASE + 10 * DAY });
  assert.equal(plan.candidates.length, 1);
  const candidate = plan.candidates[0];
  assert.equal(candidate.requiresNewHypothesis, true);
  assert.equal(candidate.applicabilityVerified, true);
  assert.deepEqual(candidate.provenIneffective.map((entry) => entry.decision), ['regression', 'no-benefit']);
  assert.deepEqual(candidate.priorAttempts.map((entry) => entry.sameApplicability), [true, true]);
  assert.equal(candidate.priorAttempts[0].strategy, 'prewarm cache');
  assert.equal(candidate.priorAttempts[0].fingerprint, '0123456789abcdef');
  assert.equal(candidate.risk, 'medium');
});

test('plan: cross-version attempts are recorded but never verified', () => {
  const knowledge = [
    record({ key: 'knowledge:f1', scope: 'plugin:edge-cache', failureCount: 2, occurrences: 2, failureMode: 'timeout', lastSeen: iso(BASE + 4 * DAY) }),
    conclusionRecord({ suffix: 'nb', lastSeen: iso(BASE + 6 * DAY), decision: 'no-benefit' }),
  ];
  const other = planEvolutionCandidates({ knowledge, versions: { dsh: '4.0.0', cordis: '0.2.5', evolution: '0.2.3' } }, { now: BASE + 10 * DAY });
  const candidate = other.candidates[0];
  assert.equal(candidate.requiresNewHypothesis, false);
  assert.deepEqual(candidate.provenIneffective, []);
  assert.equal(candidate.priorAttempts[0].sameApplicability, false);
  assert.deepEqual(candidate.priorAttempts[0].applicability, { dsh: '3.1.0', cordis: '0.2.5', evolution: '0.2.3' });

  const unknown = planEvolutionCandidates({ knowledge, versions: null }, { now: BASE + 10 * DAY });
  assert.equal(unknown.candidates[0].applicability, null);
  assert.equal(unknown.candidates[0].applicabilityVerified, false);
  assert.equal(unknown.candidates[0].requiresNewHypothesis, false);
});

test('plan: no candidates reports the specific reason', () => {
  assert.equal(planEvolutionCandidates({}, {}).none.reason, 'store-unavailable');
  assert.equal(planEvolutionCandidates({ knowledge: undefined }, {}).none.reason, 'store-unavailable');
  assert.equal(planEvolutionCandidates({ knowledge: [], failureMemory: [] }, {}).none.reason, 'no-failure-signal');
  const thin = planEvolutionCandidates({
    knowledge: [record({ key: 'knowledge:f1', scope: 'tool:read_file', failureCount: 1, occurrences: 1, failureMode: 'timeout' })],
  }, { now: BASE });
  assert.equal(thin.none.reason, 'insufficient-evidence');
  assert.equal(thin.rejected[0].reason, 'insufficient-evidence');
  // The floor is 2: a caller cannot lower it to 1.
  const floor = planEvolutionCandidates({
    knowledge: [record({ key: 'knowledge:f1', scope: 'tool:read_file', failureCount: 1, occurrences: 1 })],
  }, { minOccurrences: 1 });
  assert.equal(floor.none.reason, 'insufficient-evidence');
});

test('plan: ordering is deterministic and independent of source order', () => {
  const knowledge = [
    record({ key: 'knowledge:a1', scope: 'tool:alpha', failureCount: 2, occurrences: 2, failureMode: 'timeout', lastSeen: iso(BASE + 2 * DAY) }),
    record({ key: 'knowledge:a2', scope: 'tool:alpha', failureCount: 1, occurrences: 1, failureMode: 'timeout', lastSeen: iso(BASE + 3 * DAY) }),
    record({ key: 'knowledge:b1', scope: 'tool:beta', failureCount: 3, occurrences: 3, failureMode: 'timeout', lastSeen: iso(BASE + 1 * DAY) }),
  ];
  const forward = planEvolutionCandidates({ knowledge, versions: VERSIONS }, { now: BASE + 5 * DAY });
  const reverse = planEvolutionCandidates({ knowledge: [...knowledge].reverse(), versions: VERSIONS }, { now: BASE + 5 * DAY });
  assert.deepEqual(forward, reverse);
  assert.equal(forward.candidates.length, 2);
  assert.ok(forward.candidates[0].score >= forward.candidates[1].score);
});

test('plan: output is bounded by the declared limits', () => {
  const crowded = record({
    key: 'knowledge:crowded',
    scope: 'tool:crowded',
    failureCount: 3,
    occurrences: 3,
    failureMode: 'timeout',
    lastSeen: iso(BASE + 2 * DAY),
    evidenceRefs: ['a', 'b', 'c', 'd', 'e', 'f'],
  });
  const attempts = Array.from({ length: 8 }, (_, index) => conclusionRecord({
    suffix: `c${index}`,
    key: `knowledge:attempt-${index}`,
    scope: 'tool:crowded',
    lastSeen: iso(BASE + 3 * DAY + index * DAY),
  }));
  const many = Array.from({ length: 6 }, (_, index) => record({
    key: `knowledge:m${index}`,
    scope: `tool:multi-${index}`,
    failureCount: 3,
    occurrences: 3,
    failureMode: 'timeout',
  })).concat(Array.from({ length: 12 }, (_, index) => record({
    key: `knowledge:t${index}`,
    scope: `tool:thin-${index}`,
    failureCount: 1,
    occurrences: 1,
    failureMode: 'timeout',
  })));
  const plan = planEvolutionCandidates({ knowledge: [crowded, ...attempts, ...many], versions: VERSIONS }, { now: BASE + 20 * DAY });
  assert.equal(plan.candidates.length, EXPERIENCE_PLAN_LIMITS.maxCandidates);
  assert.ok(plan.rejected.length <= EXPERIENCE_PLAN_LIMITS.maxRejected);
  const first = plan.candidates.find((candidate) => candidate.problemKey === 'tool:crowded');
  assert.ok(first);
  assert.ok(first.evidenceRefs.length <= EXPERIENCE_PLAN_LIMITS.maxEvidenceRefs);
  assert.ok(first.priorAttempts.length <= EXPERIENCE_PLAN_LIMITS.maxAttempts);
  assert.ok(first.provenIneffective.length <= EXPERIENCE_PLAN_LIMITS.maxAttempts);
  for (const value of [first.whyCordisPlugin, first.expectedImprovement, first.problemKey]) {
    assert.ok(value.length <= EXPERIENCE_PLAN_LIMITS.maxText);
  }
  const tight = planEvolutionCandidates({ knowledge: [crowded, ...attempts, ...many], versions: VERSIONS },
    { now: BASE + 20 * DAY, maxCandidates: 1 });
  assert.equal(tight.candidates.length, 1);
  const wide = planEvolutionCandidates({ knowledge: many, versions: VERSIONS }, { now: BASE, maxCandidates: 100 });
  assert.equal(wide.candidates.length, EXPERIENCE_PLAN_LIMITS.maxCandidates);
});

test('plan: failure memory occurrences are not summed with knowledge occurrences', () => {
  const knowledge = [record({ key: 'knowledge:f1', scope: 'tool:read_file', failureCount: 2, occurrences: 2, failureMode: 'timeout' })];
  const failureMemory = [record({
    source: 'failure-memory', key: 'sig-1', scope: 'tool:read_file', failureCount: 5, occurrences: 5,
    failureMode: 'timeout', decision: 'failed',
  })];
  const plan = planEvolutionCandidates({ knowledge, failureMemory, versions: VERSIONS }, { now: BASE });
  assert.equal(plan.candidates[0].occurrences, 5);
});

test('planner helpers: strategy fingerprint and conclusion parsing', () => {
  const fingerprint = strategyFingerprint('plugin:edge-cache', 'Raise  TTL');
  assert.match(fingerprint, /^[a-f0-9]{16}$/);
  assert.equal(fingerprint, strategyFingerprint('plugin:edge-cache', 'raise ttl'));
  assert.equal(fingerprint, strategyFingerprint('plugin:edge-cache', '  RAISE TTL  '));
  assert.notEqual(fingerprint, strategyFingerprint('plugin:edge-cache', 'lower ttl'));
  assert.notEqual(fingerprint, strategyFingerprint('plugin:other', 'raise ttl'));

  assert.deepEqual(parseConclusionStrategy(conclusionStrategy()), {
    approach: 'prewarm cache', fingerprint: '0123456789abcdef', dsh: '3.1.0', cordis: '0.2.5', evolution: '0.2.3',
  });
  assert.equal(parseConclusionStrategy(''), null);
  assert.equal(parseConclusionStrategy('{}'), null);
  assert.equal(parseConclusionStrategy('not-json'), null);
  assert.equal(parseConclusionStrategy(conclusionStrategy({ kind: 'other' })), null);
  assert.equal(parseConclusionStrategy('x'.repeat(5000)), null);
  assert.equal(parseConclusionStrategy(null), null);
});

test('plan: long text and heavy groups stay inside the declared bounds', () => {
  const long = 'z'.repeat(2000);
  const knowledge = [
    record({ key: 'knowledge:long', scope: long, failureCount: 3, occurrences: 3, failureMode: 'timeout', lastSeen: iso(BASE) }),
    record({ key: 'knowledge:long2', scope: long, failureCount: 3, occurrences: 3, failureMode: 'timeout', lastSeen: iso(BASE) }),
  ];
  const plan = planEvolutionCandidates({ knowledge, versions: VERSIONS }, { now: BASE });
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].problemKey.length, EXPERIENCE_PLAN_LIMITS.maxText);
  assert.equal(plan.candidates[0].occurrences, 6);
});
