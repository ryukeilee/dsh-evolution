import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSharedExperience } from '../lib/shared-experience.js';
import { parseConclusionStrategy, strategyFingerprint } from '../lib/experience-plan.js';

const TARGET = 'plugin:edge-cache';
const VERSIONS = Object.freeze({ dsh: '3.1.0', cordis: '0.2.5', evolution: '0.2.3' });
const FINGERPRINT = '0123456789abcdef';
const ORIGIN = 'test-origin';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-conclusion-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function open(t) {
  const store = openSharedExperience(temporary(t));
  t.after(() => { try { store.close(); } catch { /* already closed by the test */ } });
  return store;
}

let sequence = 0;
const at = (day) => `2026-11-${String(day).padStart(2, '0')}T00:00:00.000Z`;

function conclude(over = {}) {
  sequence += 1;
  return {
    experimentId: over.experimentId ?? `exp-${sequence}`,
    target: TARGET,
    strategy: 'prewarm cache',
    strategyFingerprint: FINGERPRINT,
    rootCause: 'cache warms before dependencies',
    failureMode: 'timeout',
    decision: 'adopted',
    metrics: { latencyMs: -40 },
    applicability: VERSIONS,
    occurredAt: at(1),
    ...over,
  };
}

test('adopted is a success; a same-identity no-benefit corrects it into REGRESSED', (t) => {
  const store = open(t);
  const adopted = store.recordConclusion(conclude({ experimentId: 'exp-a', decision: 'adopted', occurredAt: at(1) }), ORIGIN);
  assert.equal(adopted.committed, true);
  assert.equal(adopted.duplicate, false);
  assert.match(adopted.knowledgeKey, /^knowledge:[a-f0-9]{32}$/);
  let found = store.findConclusions({ target: TARGET, applicability: VERSIONS });
  assert.equal(found.matches.length, 1);
  assert.equal(found.matches[0].decision, 'adopted');
  assert.equal(found.matches[0].outcome, 'success');
  assert.equal(found.matches[0].state, 'KNOWN');
  assert.equal(found.matches[0].regressionCount, 0);
  assert.equal(found.matches[0].sameApplicability, true);
  assert.deepEqual(found.matches[0].applicability, VERSIONS);
  assert.deepEqual(found.best, found.matches[0]);

  const noBenefit = store.recordConclusion(conclude({ experimentId: 'exp-b', decision: 'no-benefit', occurredAt: at(2) }), ORIGIN);
  // The same (problem, strategy, root cause, versions) shares one knowledge
  // key, so the new verdict merges into the recorded success.
  assert.equal(noBenefit.knowledgeKey, adopted.knowledgeKey);
  found = store.findConclusions({ target: TARGET, applicability: VERSIONS });
  assert.equal(found.matches.length, 1);
  assert.equal(found.matches[0].decision, 'no-benefit');
  assert.equal(found.matches[0].outcome, 'failure');
  assert.equal(found.matches[0].state, 'REGRESSED');
  assert.equal(found.matches[0].regressionCount, 1);
  assert.equal(found.matches[0].count, 2);
});

test('a different version is a different fact and cannot demote the other version', (t) => {
  const store = open(t);
  const old = store.recordConclusion(conclude({ experimentId: 'exp-old', applicability: { ...VERSIONS, dsh: '3.1.0' } }), ORIGIN);
  const next = store.recordConclusion(conclude({ experimentId: 'exp-new', decision: 'no-benefit', applicability: { ...VERSIONS, dsh: '4.0.0' }, occurredAt: at(3) }), ORIGIN);
  assert.notEqual(old.knowledgeKey, next.knowledgeKey);
  const all = store.findConclusions({ target: TARGET });
  assert.equal(all.matches.length, 2);
  const current = store.findConclusions({ target: TARGET, applicability: { ...VERSIONS, dsh: '4.0.0' } });
  assert.equal(current.matches.filter((match) => match.sameApplicability).length, 1);
  const previous = all.matches.find((match) => match.knowledgeKey === old.knowledgeKey);
  assert.equal(previous.state, 'KNOWN');
  assert.equal(previous.regressionCount, 0);
});

test('insufficient-evidence is neutral and does not demote a recorded success', (t) => {
  const store = open(t);
  const adopted = store.recordConclusion(conclude({ experimentId: 'exp-a', decision: 'adopted' }), ORIGIN);
  const insufficient = store.recordConclusion(conclude({ experimentId: 'exp-i', decision: 'insufficient-evidence', occurredAt: at(2) }), ORIGIN);
  assert.equal(adopted.knowledgeKey, insufficient.knowledgeKey);
  const found = store.findConclusions({ target: TARGET, applicability: VERSIONS });
  assert.equal(found.matches[0].decision, 'insufficient-evidence');
  assert.equal(found.matches[0].outcome, 'neutral');
  assert.equal(found.matches[0].state, 'KNOWN');
  assert.equal(found.matches[0].regressionCount, 0);
});

test('a replayed id is a duplicate; the same id with different content conflicts', (t) => {
  const store = open(t);
  const first = store.recordConclusion(conclude({ experimentId: 'exp-replay', occurredAt: at(5) }), ORIGIN);
  const replay = store.recordConclusion(conclude({ experimentId: 'exp-replay', occurredAt: at(5) }), ORIGIN);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.committed, true);
  assert.equal(replay.knowledgeKey, first.knowledgeKey);
  assert.deepEqual(store.stats(), { events: 1, knowledge: 1 });
  // Identity is (origin, experiment, decision, versions); the wall clock is not
  // part of it, so a re-derivation with another timestamp must not rewrite it.
  assert.throws(() => store.recordConclusion(conclude({ experimentId: 'exp-replay', occurredAt: at(6) }), ORIGIN),
    /E_EXPERIENCE_EVENT_CONFLICT/);
});

test('findConclusions filters by fingerprint and never claims unknown versions', (t) => {
  const store = open(t);
  store.recordConclusion(conclude({ experimentId: 'exp-a', decision: 'no-benefit' }), ORIGIN);
  const byFingerprint = store.findConclusions({ target: TARGET, strategyFingerprint: FINGERPRINT });
  assert.equal(byFingerprint.matches.length, 1);
  assert.equal(store.findConclusions({ target: TARGET, strategyFingerprint: 'ffffffffffffffff' }).matches.length, 0);
  const unknown = store.findConclusions({
    target: TARGET,
    applicability: { dsh: '3.1.0', cordis: 'unknown', evolution: '0.2.3' },
  });
  assert.equal(unknown.matches[0].sameApplicability, false);
  assert.equal(store.findConclusions({ target: TARGET, window: 1 }).considered, 1);
  assert.equal(store.findConclusions({ target: TARGET, window: 0 }).considered, 1);
  // The read is read-only: the same answer is returned twice.
  assert.deepEqual(store.findConclusions({ target: TARGET }), store.findConclusions({ target: TARGET }));
});

test('discover is bounded and keeps a conclusion strategy parseable', (t) => {
  const store = open(t);
  store.recordConclusion(conclude({ experimentId: 'exp-a', decision: 'adopted' }), ORIGIN);
  store.recordConclusion(conclude({ experimentId: 'exp-b', target: 'tool:read_file', decision: 'no-benefit', occurredAt: at(2) }), ORIGIN);
  const all = store.discover();
  assert.equal(all.source, 'shared-knowledge');
  assert.equal(all.count, 2);
  assert.equal(all.considered, 2);
  assert.equal(all.truncated, false);
  for (const record of all.records) {
    const parsed = parseConclusionStrategy(record.strategy);
    assert.ok(parsed, 'a stored conclusion strategy must stay parseable JSON');
    assert.equal(parsed.fingerprint, FINGERPRINT);
    assert.equal(parsed.dsh, '3.1.0');
  }
  const windowed = store.discover({ window: 1 });
  assert.equal(windowed.considered, 1);
  assert.equal(windowed.truncated, true);
  assert.equal(windowed.records.length, 1);
});

test('hostile and oversized conclusion text is cleaned and bounded', (t) => {
  const store = open(t);
  const result = store.recordConclusion(conclude({
    experimentId: 'exp-hostile',
    strategy: `\u0000prewarm\u0001 cache ${'x'.repeat(4000)}`,
    rootCause: `cache warms\u0000 before ${'y'.repeat(4000)}`,
    failureMode: `time\u0000out ${'z'.repeat(4000)}`,
    applicability: { dsh: '3.1.0', cordis: 'c'.repeat(200), evolution: '0.2.3' },
    metrics: { latencyMs: 12, broken: Number.NaN, text: 'ignored', extra: 1, a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 },
    occurredAt: at(7),
  }), ORIGIN);
  assert.equal(result.committed, true);
  const [record] = store.discover().records;
  const strategies = parseConclusionStrategy(record.strategy);
  assert.ok(strategies);
  assert.ok(strategies.approach.length <= 160);
  assert.ok(!/[\u0000-\u001f]/.test(strategies.approach));
  assert.ok(record.rootCause.length <= 400);
  assert.ok(!/[\u0000-\u001f]/.test(record.rootCause));
  assert.ok(record.failureMode.length <= 400);
  assert.ok(!/[\u0000-\u001f]/.test(record.failureMode));
  const found = store.findConclusions({ target: TARGET, applicability: { dsh: '3.1.0', cordis: 'c'.repeat(200), evolution: '0.2.3' } });
  assert.equal(found.matches[0].applicability.cordis.length, 64);
  assert.equal(found.matches[0].sameApplicability, true);
});

test('invalid conclusion inputs fail with their own codes', (t) => {
  const store = open(t);
  assert.throws(() => store.recordConclusion(conclude({ experimentId: 'bad id!' }), ORIGIN), /E_EXPERIENCE_CONCLUSION_EXPERIMENT/);
  assert.throws(() => store.recordConclusion(conclude({ decision: 'accepted' }), ORIGIN), /E_EXPERIENCE_CONCLUSION_DECISION/);
  assert.throws(() => store.recordConclusion(conclude({ strategyFingerprint: 'not-hex' }), ORIGIN), /E_EXPERIENCE_CONCLUSION_FINGERPRINT/);
  assert.throws(() => store.recordConclusion(conclude({ occurredAt: 'yesterday' }), ORIGIN), /E_EXPERIENCE_CONCLUSION_TIME/);
  assert.throws(() => store.recordConclusion(conclude({ strategy: '   ' }), ORIGIN), /E_EXPERIENCE_CONCLUSION_STRATEGY/);
  assert.throws(() => store.findConclusions({ target: '' }), /E_EXPERIENCE_CONCLUSION_TARGET/);
  assert.throws(() => store.findConclusions({ target: TARGET, strategyFingerprint: 'zz' }), /E_EXPERIENCE_CONCLUSION_FINGERPRINT/);
});

test('conclusion reads and writes refuse a closed store', (t) => {
  const store = open(t);
  store.close();
  assert.throws(() => store.recordConclusion(conclude(), ORIGIN), /E_EXPERIENCE_CLOSED/);
  assert.throws(() => store.findConclusions({ target: TARGET }), /E_EXPERIENCE_CLOSED/);
  assert.throws(() => store.discover(), /E_EXPERIENCE_CLOSED/);
});

test('a strategy fingerprint computed by the planner identifies its conclusion', (t) => {
  const store = open(t);
  const fingerprint = strategyFingerprint(TARGET, 'prewarm cache');
  const result = store.recordConclusion(conclude({ experimentId: 'exp-fp', strategyFingerprint: fingerprint }), ORIGIN);
  assert.equal(result.committed, true);
  const found = store.findConclusions({ target: TARGET, strategyFingerprint: fingerprint });
  assert.equal(found.matches.length, 1);
  assert.equal(found.matches[0].decision, 'adopted');
});

test('a normalized problemKey with spaces is recorded and found by the same form', (t) => {
  const store = open(t);
  // `evolution_plan` returns the normalized scope, so publishConclusion writes
  // this exact string; it is a problem identity, not a host identifier.
  const target = 'tool probe healthcheck';
  const result = store.recordConclusion(conclude({ experimentId: 'exp-normalized', target, decision: 'no-benefit' }), ORIGIN);
  assert.equal(result.committed, true);
  const found = store.findConclusions({ target, applicability: VERSIONS, strategyFingerprint: FINGERPRINT });
  assert.equal(found.matches.length, 1);
  assert.equal(found.matches[0].decision, 'no-benefit');
  assert.equal(found.matches[0].outcome, 'failure');
  assert.equal(found.matches[0].sameApplicability, true);
  // No row was degraded to the host fallback.
  assert.equal(store.findConclusions({ target: 'host' }).matches.length, 0);
});

test('raw and normalized target forms address the same conclusion', (t) => {
  const store = open(t);
  const raw = store.recordConclusion(conclude({ experimentId: 'exp-raw', target: 'tool:probe_healthcheck', decision: 'adopted' }), ORIGIN);
  // Write with the raw form, read with the normalized form (plan output).
  assert.equal(store.findConclusions({ target: 'tool probe healthcheck' }).matches.length, 1);
  const normalized = store.recordConclusion(conclude({
    experimentId: 'exp-normalized', target: 'tool probe healthcheck', decision: 'no-benefit', occurredAt: at(3),
  }), ORIGIN);
  // Both write forms normalize to one scope, so they share one knowledge key
  // and the later verdict corrects the earlier success.
  assert.equal(normalized.knowledgeKey, raw.knowledgeKey);
  const found = store.findConclusions({ target: 'tool:probe_healthcheck' });
  assert.equal(found.matches.length, 1);
  assert.equal(found.matches[0].decision, 'no-benefit');
  assert.equal(found.matches[0].state, 'REGRESSED');
  assert.deepEqual(store.findConclusions({ target: 'tool probe healthcheck' }), found);
});

test('empty, control-only, non-string and oversized targets are bounded safely', (t) => {
  const store = open(t);
  store.recordConclusion(conclude({ experimentId: 'exp-empty', target: '', occurredAt: at(1) }), ORIGIN);
  store.recordConclusion(conclude({ experimentId: 'exp-control', target: '\u0000\u0001\u0002', occurredAt: at(2) }), ORIGIN);
  store.recordConclusion(conclude({ experimentId: 'exp-object', target: { name: 'not-a-string' }, occurredAt: at(3) }), ORIGIN);
  // All three fall back to the host identity and merge into one row.
  const host = store.findConclusions({ target: 'host' });
  assert.equal(host.matches.length, 1);
  assert.equal(host.matches[0].count, 3);
  assert.equal(host.matches[0].decision, 'adopted');
  assert.equal(store.findConclusions({ target: 'tool probe healthcheck' }).matches.length, 0);

  // An oversized target is truncated on write and on read with the same bound,
  // so the round trip still resolves to one scope.
  const longTarget = `tool ${'probe '.repeat(40)}healthcheck`;
  store.recordConclusion(conclude({ experimentId: 'exp-long', target: longTarget, applicability: VERSIONS }), ORIGIN);
  const long = store.findConclusions({ target: longTarget, applicability: VERSIONS });
  assert.equal(long.matches.length, 1);
  assert.equal(long.matches[0].sameApplicability, true);
});

test('an identifier-legal target keeps its previous behavior', (t) => {
  const store = open(t);
  const result = store.recordConclusion(conclude({ experimentId: 'exp-legal', target: TARGET, decision: 'adopted' }), ORIGIN);
  const found = store.findConclusions({ target: TARGET, applicability: VERSIONS });
  assert.equal(found.matches.length, 1);
  assert.equal(found.matches[0].knowledgeKey, result.knowledgeKey);
  assert.equal(found.matches[0].decision, 'adopted');
  assert.equal(found.matches[0].outcome, 'success');
  assert.equal(found.matches[0].state, 'KNOWN');
  // The normalized scope form addresses the same row, and the host fallback
  // stays unused.
  assert.equal(store.findConclusions({ target: 'plugin edge-cache' }).matches.length, 1);
  assert.equal(store.findConclusions({ target: 'host' }).matches.length, 0);
});

test('a conclusion is still found after unrelated knowledge exceeds the global scan window', (t) => {
  const store = open(t);
  store.recordConclusion(conclude({ experimentId: 'exp-window', decision: 'no-benefit' }), ORIGIN);
  // The window is the newest N canonical rows. Before the scoped read, 505
  // newer unrelated failures pushed this conclusion out of it, `findConclusions`
  // reported no match, and the proposal gate treated a proven-ineffective
  // strategy as new.
  for (let index = 0; index < 505; index += 1) {
    store.recordFailure({
      id: crypto.createHash('sha256').update(`unrelated:${index}`).digest('hex'),
      type: 'tool/error',
      code: 'E_UNRELATED',
      target: `tool:unrelated-${index}`,
    });
  }
  const found = store.findConclusions({ target: TARGET, applicability: VERSIONS, strategyFingerprint: FINGERPRINT });
  assert.equal(found.matches.length, 1);
  assert.equal(found.matches[0].decision, 'no-benefit');
  assert.equal(found.matches[0].sameApplicability, true);
  assert.equal(found.truncated, false, 'the window now covers every conclusion for this target');
});

test('the stored conclusion body keeps the canonical scope marker the windowed read uses', (t) => {
  const root = temporary(t);
  const store = openSharedExperience(root);
  store.recordConclusion(conclude({ experimentId: 'exp-scope-marker', decision: 'no-benefit' }), ORIGIN);
  store.close();
  // `findConclusions()` filters canonical rows with `instr(body, '"scope":<json>')`.
  // That scoped read is what keeps a proven-ineffective conclusion visible after
  // unrelated failures accumulate, so the marker itself is pinned here: a future
  // writer change that stops emitting it would silently turn the gate fail-open.
  const db = new DatabaseSync(path.join(root, 'experience.sqlite'));
  t.after(() => db.close());
  const row = db.prepare('SELECT body FROM knowledge').get();
  assert.ok(row?.body, 'one canonical row was written');
  assert.ok(row.body.includes('"scope":"plugin edge-cache"'), row.body);
});
