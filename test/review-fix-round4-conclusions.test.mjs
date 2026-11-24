// Round-4 closed-loop regressions: a neutral conclusion must not erase a
// measured negative verdict, failure memory must not plan against its internal
// telemetry hash, and a folded "tool missing" fact is a capability gap.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openSharedExperience } from '../lib/shared-experience.js';
import { planEvolutionCandidates, strategyFingerprint } from '../lib/experience-plan.js';
import { failureMemoryExperienceRecord } from '../lib/experience-recall.js';

const VERSIONS = { dsh: '0.2.2-rc.5', cordis: '4.0.0', evolution: '0.2.18' };
const TARGET = 'tool:read';
const STRATEGY = 'add a streaming read tool';
const FINGERPRINT = strategyFingerprint(TARGET, STRATEGY);

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'round4-conclusions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function conclusion(store, bridge, seq, { id, decision, at, failureMode = '' }) {
  return store.recordConclusion({
    experimentId: id, target: TARGET, strategy: STRATEGY,
    strategyFingerprint: FINGERPRINT, failureMode,
    decision, applicability: VERSIONS, occurredAt: at,
  }, bridge, { sequence: seq, writer: 'round4-writer' });
}

test('a neutral conclusion keeps a prior no-benefit verdict authoritative', (t) => {
  const root = scratch(t);
  const store = openSharedExperience(root);
  t.after(() => store.close());
  const bridge = path.join(root, 'bridge.jsonl');
  const negative = conclusion(store, bridge, 1, { id: 'e1', decision: 'no-benefit', at: '2026-11-01T00:00:00.000Z' });
  conclusion(store, bridge, 2, { id: 'e2', decision: 'insufficient-evidence', at: '2026-11-02T00:00:00.000Z' });
  conclusion(store, bridge, 3, { id: 'e3', decision: 'insufficient-evidence', at: '2026-11-03T00:00:00.000Z' });
  const found = store.findConclusions({ target: TARGET, strategyFingerprint: FINGERPRINT, applicability: VERSIONS });
  assert.equal(found.best.decision, 'no-benefit');
  assert.equal(found.best.knowledgeKey, negative.knowledgeKey, 'the canonical row is unchanged; only its verdict projection is restored');
  const discovered = store.discover({ window: 500 }).records.find((row) => row.key === negative.knowledgeKey);
  assert.equal(discovered.decision, 'no-benefit', 'planning sees the same restored verdict');
  const plan = planEvolutionCandidates({ knowledge: store.discover({ window: 500 }).records, failureMemory: [], versions: VERSIONS });
  assert.ok(plan.candidates.some((candidate) => candidate.provenIneffective?.some((row) => row.decision === 'no-benefit')),
    `the hard ineffectiveness gate must still see the verdict, got ${JSON.stringify(plan.rejected)}`);
});

test('a task-benefit regression without a probe regression marker also survives a neutral conclusion', (t) => {
  const root = scratch(t);
  const store = openSharedExperience(root);
  t.after(() => store.close());
  const bridge = path.join(root, 'bridge.jsonl');
  conclusion(store, bridge, 1, { id: 'e1', decision: 'regression', at: '2026-11-01T00:00:00.000Z' });
  conclusion(store, bridge, 2, { id: 'e2', decision: 'reverted-unconfirmed', at: '2026-11-02T00:00:00.000Z' });
  const found = store.findConclusions({ target: TARGET, strategyFingerprint: FINGERPRINT, applicability: VERSIONS });
  assert.equal(found.best.decision, 'regression');
});

test('an adopted success is still superseded by a later neutral conclusion', (t) => {
  // Control: the fix only restores evidence-backed negatives, not successes.
  const root = scratch(t);
  const store = openSharedExperience(root);
  t.after(() => store.close());
  const bridge = path.join(root, 'bridge.jsonl');
  conclusion(store, bridge, 1, { id: 'e1', decision: 'adopted', at: '2026-11-01T00:00:00.000Z' });
  conclusion(store, bridge, 2, { id: 'e2', decision: 'insufficient-evidence', at: '2026-11-02T00:00:00.000Z' });
  const found = store.findConclusions({ target: TARGET, strategyFingerprint: FINGERPRINT, applicability: VERSIONS });
  assert.equal(found.best.decision, 'insufficient-evidence');
});

test('a later adoption supersedes an older negative verdict before a neutral fact', (t) => {
  // The counters still carry the old no-benefit, but the owner adopted the
  // strategy afterwards. A neutral conclusion must not resurrect the old
  // negative and block proposals for a strategy now known to work.
  const root = scratch(t);
  const store = openSharedExperience(root);
  t.after(() => store.close());
  const bridge = path.join(root, 'bridge.jsonl');
  conclusion(store, bridge, 1, { id: 'e1', decision: 'no-benefit', at: '2026-11-01T00:00:00.000Z' });
  conclusion(store, bridge, 2, { id: 'e2', decision: 'adopted', at: '2026-11-02T00:00:00.000Z' });
  conclusion(store, bridge, 3, { id: 'e3', decision: 'insufficient-evidence', at: '2026-11-03T00:00:00.000Z' });
  const found = store.findConclusions({ target: TARGET, strategyFingerprint: FINGERPRINT, applicability: VERSIONS });
  assert.equal(found.best.decision, 'insufficient-evidence');
  const plan = planEvolutionCandidates({ knowledge: store.discover({ window: 500 }).records, failureMemory: [], versions: VERSIONS });
  assert.equal(plan.candidates.some((candidate) => candidate.provenIneffective?.some((row) => row.decision === 'no-benefit')), false);
});

test('failure memory is planned against the declared target, not its telemetry hash', () => {
  const hash = 'a'.repeat(64);
  const memory = [{
    signature: 'env-failure-sig', count: 6, status: 'active',
    problem: 'Official operation failed (E_TIMEOUT)',
    experiment: { patternKey: hash, target: TARGET, strategy: 'fp' },
    result: { category: 'runtime-trial' },
    lastSeenAt: '2026-11-20T00:00:00.000Z',
  }].map((entry) => failureMemoryExperienceRecord(entry));
  const plan = planEvolutionCandidates({ knowledge: [], failureMemory: memory, versions: VERSIONS });
  assert.equal(plan.candidates.some((candidate) => /^[a-f0-9]{64}$/.test(candidate.problemKey)), false,
    `patternKey hashes must not become pseudo-problems, got ${JSON.stringify(plan.candidates.map((c) => c.problemKey))}`);
  assert.ok(plan.candidates.some((candidate) => candidate.problemKey === 'tool read'),
    'the real declared target stays a candidate under its canonical identity');
});

test('raw and canonical spellings of one problem produce a single candidate', () => {
  const row = (scope, key) => ({
    scope, problem: 'official operation failure timeout', issueType: 'problem',
    failureMode: 'timeout', occurrences: 3, failureCount: 3,
    lastSeen: '2026-11-20T00:00:00.000Z', key,
  });
  const plan = planEvolutionCandidates({
    knowledge: [row('tool:read', 'knowledge:raw'), row('tool read', 'knowledge:canonical')],
    failureMemory: [], versions: VERSIONS,
  });
  assert.deepEqual(plan.candidates.map((candidate) => candidate.problemKey), ['tool read'],
    `one problem must not split into two candidates, got ${JSON.stringify(plan.candidates.map((c) => c.problemKey))}`);
  assert.equal(plan.candidates[0].occurrences, 6, 'evidence from both spellings is combined');
});

test('the stored "tool missing" form is a capability gap, not caller input', () => {
  const row = (mode) => ({
    scope: 'tool alpha', problem: `official operation failure ${mode}`, issueType: 'problem',
    failureMode: mode, occurrences: 4, failureCount: 4, lastSeen: '2026-11-20T00:00:00.000Z',
    key: `knowledge:${mode}`,
  });
  const gap = planEvolutionCandidates({ knowledge: [row('e tool missing')], failureMemory: [], versions: VERSIONS });
  assert.equal(gap.rejected.some((entry) => entry.reason === 'caller-input'), false);
  assert.ok(gap.candidates.some((candidate) => candidate.origin === 'capability-gap'),
    `E_TOOL_NOT_FOUND is a capability gap, got ${JSON.stringify(gap.rejected)}`);
  // An edit-context loss is still the caller's own problem.
  const caller = planEvolutionCandidates({ knowledge: [row('fs edit missing')], failureMemory: [], versions: VERSIONS });
  assert.ok(caller.rejected.some((entry) => entry.reason === 'caller-input'));
});
