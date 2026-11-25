// R13 differential equivalence for the shared-experience recall rewrite:
//   experience-recall.js `sortCandidates()` caches each record's `orderingKey()`
//   once per sort instead of once per comparison.
//
// A sibling `appendBounded()` serialization hoist was reverted: a stateful
// accessor in the appended value changes both the failure path (an empty window
// never serialized it in the baseline) and the dedupe comparison order, so the
// hoist was not byte-equivalent for arbitrary inputs. It is not shipped; the
// evidence and the repro are in docs/performance/r13-shared-experience.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(import.meta.dirname, '..');
const RECALL_SOURCE = fs.readFileSync(path.join(REPO, 'lib/experience-recall.js'), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-equivalence-'));
// `experience-recall.js` has three relative imports, so its variants need the
// same relative dependency layout next to them in the temp tree.
const tmpLib = path.join(tmp, 'lib');
fs.mkdirSync(path.join(tmpLib, 'dockyard-domain'), { recursive: true });
for (const name of ['experience-plan.js', 'error-boundary.js']) {
  fs.copyFileSync(path.join(REPO, 'lib', name), path.join(tmpLib, name));
}
fs.copyFileSync(path.join(REPO, 'lib/dockyard-domain/knowledge.js'), path.join(tmpLib, 'dockyard-domain/knowledge.js'));
let counter = 0;
function loadVariant(source, tag, inLib = false) {
  const file = inLib ? path.join(tmpLib, `${tag}-${counter++}.mjs`) : path.join(tmp, `${tag}-${counter++}.mjs`);
  fs.writeFileSync(file, source);
  return import(pathToFileURL(file).href);
}
function replaceOnce(source, from, to, label) {
  assert.equal(source.split(from).length - 1, 1, `${label}: anchor must appear exactly once`);
  return source.replace(from, to);
}

// --- B. sortCandidates ------------------------------------------------------
const SORT_CANDIDATE = `function sortCandidates(records) {
  // Fewer than two records cannot compare, so the baseline did zero work here.
  // Return before allocating anything, making the sparse path exactly the same
  // work as the baseline rather than merely the same result.
  if (records.length < 2) return records;
  const keys = new Map();
  const keyOf = (record) => {
    let key = keys.get(record);
    if (key === undefined) { key = orderingKey(record); keys.set(record, key); }
    return key;
  };
  return records.sort((left, right) => compareCandidates(left, right, keyOf));
}`;
const SORT_BASELINE = `function sortCandidates(records) {
  return records.sort((left, right) => compareCandidates(left, right));
}`;
const SORT_BROKEN = `function sortCandidates(records) {
  const keyOf = () => "stale";
  return records.sort((left, right) => compareCandidates(left, right, keyOf));
}`;
function instrumentRecall(source) {
  return replaceOnce(source, 'function orderingKey(record) {',
    'function orderingKey(record) { globalThis.__r13OrderingCalls = (globalThis.__r13OrderingCalls || 0) + 1;',
    'instrument orderingKey');
}
function recallRecords(n) {
  return Array.from({ length: n }, (_, i) => {
    const extended = i % 17 === 0 ? '+010000-01-01T00:00:00.000Z' : new Date(Date.UTC(2026, 0, 1, 0, 0, i % 60)).toISOString();
    return {
      source: 'knowledge',
      key: 'knowledge:' + String(n - i).padStart(4, '0'),
      problem: 'read failure',
      scope: 'tool read',
      strategy: i % 5 === 0 ? 'cache ' + (i % 3) : '',
      failureMode: 'line-truncated',
      rootCause: i % 7 === 0 ? 'pipe closed' : '',
      prevention: '',
      state: i % 2 ? 'LEARNING' : 'KNOWN',
      lastOutcome: 'failure',
      decision: 'failed',
      successCount: i % 11 === 0 ? 1 : 0,
      failureCount: i % 11 === 0 ? 0 : 1,
      successRate: i % 11 === 0 ? 1 : 0,
      fitnessMean: null,
      regressionCount: i % 13 === 0 ? 1 : 0,
      occurrences: 1 + (i % 3),
      firstSeen: '2026-01-01T00:00:00.000Z',
      lastSeen: extended,
      evidenceRefs: ['event:' + i, 'ref:' + (i % 5)],
    };
  });
}

test('B. sortCandidates rewrite is byte-equivalent and the differential has teeth', async () => {
  const baselineSource = replaceOnce(RECALL_SOURCE, SORT_CANDIDATE, SORT_BASELINE, 'reverse sortCandidates');
  assert.notEqual(baselineSource, RECALL_SOURCE);
  const [candidate, baseline] = await Promise.all([
    loadVariant(RECALL_SOURCE, 'recall-candidate', true),
    loadVariant(baselineSource, 'recall-baseline', true),
  ]);
  const input = { problem: 'read failure' };
  const sources = (mod) => [
    { source: 'knowledge', records: recallRecords(120), considered: 120, scanned: 120 },
    { source: 'failure-memory', records: recallRecords(60).map((r) => ({ ...r, source: 'failure-memory', strategy: '' })), considered: 60, scanned: 60 },
  ];
  assert.equal(
    JSON.stringify(candidate.finalizeExperienceRecall(input, sources(candidate), {})),
    JSON.stringify(baseline.finalizeExperienceRecall(input, sources(baseline), {})),
    'finalizeExperienceRecall output diverged',
  );
  assert.equal(
    JSON.stringify(candidate.collectKnowledgeExperience(recallRecords(150), input, {})),
    JSON.stringify(baseline.collectKnowledgeExperience(recallRecords(150), input, {})),
    'collectKnowledgeExperience output diverged',
  );

  // Call-count proof needs a tie-heavy corpus: the comparator only builds an
  // ordering key when exact/score/recency all tie, which is the shape a real
  // long-lived store produces (many failures with identical bounded scores).
  const tied = (n) => Array.from({ length: n }, (_, i) => ({
    ...recallRecords(1)[0],
    key: 'knowledge:' + String(n - i).padStart(4, '0'),
    problem: 'read failure', strategy: '', state: 'LEARNING', successCount: 0,
    failureCount: 1, successRate: 0, occurrences: 1, regressionCount: 0,
    lastSeen: '2026-01-01T00:00:00.000Z', evidenceRefs: ['event:' + i],
  }));
  const tiedSources = (mod) => [{ source: 'knowledge', records: tied(120), considered: 120, scanned: 120 }];
  globalThis.__r13OrderingCalls = 0;
  const countedCandidate = await loadVariant(instrumentRecall(RECALL_SOURCE), 'recall-count-c', true);
  const countedBaseline = await loadVariant(instrumentRecall(baselineSource), 'recall-count-b', true);
  countedCandidate.finalizeExperienceRecall(input, tiedSources(countedCandidate), {});
  const candidateCalls = globalThis.__r13OrderingCalls;
  globalThis.__r13OrderingCalls = 0;
  countedBaseline.finalizeExperienceRecall(input, tiedSources(countedBaseline), {});
  const baselineCalls = globalThis.__r13OrderingCalls;
  assert.ok(baselineCalls > candidateCalls, `expected fewer orderingKey builds: candidate=${candidateCalls}, baseline=${baselineCalls}`);

  // The lazy cache must not turn into unconditional recomputation: with zero or
  // one candidate no comparison reaches the tie-break, so both sides must do
  // zero orderingKey builds (strictly no worse than baseline).
  for (const count of [0, 1]) {
    const sparse = (mod) => [{ source: 'knowledge', records: tied(count), considered: count, scanned: count }];
    globalThis.__r13OrderingCalls = 0;
    countedCandidate.finalizeExperienceRecall(input, sparse(countedCandidate), {});
    const cCalls = globalThis.__r13OrderingCalls;
    globalThis.__r13OrderingCalls = 0;
    countedBaseline.finalizeExperienceRecall(input, sparse(countedBaseline), {});
    const bCalls = globalThis.__r13OrderingCalls;
    assert.equal(cCalls, 0, `${count} candidate(s): candidate must build zero ordering keys`);
    assert.equal(bCalls, 0, `${count} candidate(s): baseline must build zero ordering keys`);
  }

  const broken = await loadVariant(replaceOnce(RECALL_SOURCE, SORT_CANDIDATE, SORT_BROKEN, 'inject stale keys'), 'recall-broken', true);
  assert.notEqual(
    JSON.stringify(broken.finalizeExperienceRecall(input, sources(broken), {})),
    JSON.stringify(baseline.finalizeExperienceRecall(input, sources(baseline), {})),
    'stale precomputed keys must break the differential',
  );
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
