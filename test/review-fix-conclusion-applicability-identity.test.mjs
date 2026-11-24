// Regression for the cross-session evidence-identity defect: a canary survives
// a process restart (and a host upgrade), but `publishConclusion` used to stamp
// every conclusion with the *live* process triple. A restored experiment must
// be recorded under the applicability it was actually proposed/probed under,
// and the neutral-verdict skip gate must query that same triple.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EvolutionOrchestrator } from '../lib/orchestrator.js';
import { openSharedExperience } from '../lib/shared-experience.js';

const OLD = Object.freeze({ dsh: '0.2.2-rc.4', cordis: '4.1.0', evolution: '0.2.6' });
const NEW = Object.freeze({ dsh: '0.2.2-rc.5', cordis: '4.1.0', evolution: '0.2.7' });
const MEASURED = Object.freeze({ dsh: '0.2.2-rc.3', cordis: '4.1.0', evolution: '0.2.5' });
const TARGET = 'tool:read';
const FINGERPRINT = 'a1b2c3d4e5f60718';

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conclusion-applicability-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = openSharedExperience(root);
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  // Delegate to a real SQLite store through a frozen-object-safe facade: every
  // lookup and write still runs the real implementation, but we can assert the
  // exact value both paths saw.
  const lookups = [];
  const writes = [];
  const facade = {
    findConclusions(input) { lookups.push(input); return store.findConclusions(input); },
    recordConclusion(input, origin) { writes.push(input); return store.recordConclusion(input, origin); },
  };
  const orchestrator = new EvolutionOrchestrator(
    { dynamicCordisRunner: {}, tools: {} },
    {
      sharedExperience: facade,
      eventBridgePath: path.join(root, 'events.jsonl'),
      runtimeVersions: { host: NEW.dsh, cordis: NEW.cordis, evolution: NEW.evolution },
    },
  );
  return { store, orchestrator, lookups, writes };
}

function record(over = {}) {
  return {
    id: over.id ?? 'exp-restored-canary',
    proposal: {
      target: TARGET,
      strategy: 'complete read line',
      strategyFingerprint: FINGERPRINT,
      rootCause: 'read truncated a line',
      ...(over.proposal ?? {}),
    },
    ...(over.probe !== undefined ? { probe: over.probe } : {}),
    ...(over.latestObservation !== undefined ? { latestObservation: over.latestObservation } : {}),
  };
}

test('a restored canary conclusion is written under the OLD triple, not the live one', (t) => {
  const h = harness(t);
  const result = h.orchestrator.publishConclusion(
    record({ proposal: { applicability: OLD } }), 'adopted', 'canary-passed');
  assert.ok(result);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.writes[0].applicability, OLD);
  const old = h.store.findConclusions({ target: TARGET, applicability: OLD });
  assert.equal(old.matches.length, 1);
  assert.equal(old.matches[0].sameApplicability, true);
  assert.equal(old.matches[0].decision, 'adopted');
  const live = h.store.findConclusions({ target: TARGET, applicability: NEW });
  assert.equal(live.matches[0].sameApplicability, false, 'the new host must not inherit the old verdict');
});

test('a no-benefit proven under OLD blocks a neutral verdict after the live versions change', (t) => {
  const h = harness(t);
  const seeded = h.store.recordConclusion({
    experimentId: 'exp-old-proof',
    target: TARGET,
    strategy: 'complete read line',
    strategyFingerprint: FINGERPRINT,
    rootCause: 'read truncated a line',
    decision: 'no-benefit',
    metrics: {},
    applicability: OLD,
    occurredAt: '2026-11-20T00:00:00.000Z',
  }, 'test-origin');
  assert.equal(seeded.committed, true);
  const before = h.store.stats().events;

  const result = h.orchestrator.publishConclusion(
    record({ id: 'exp-restored-neutral', proposal: { applicability: OLD } }),
    'insufficient-evidence', 'revert');
  assert.equal(result, null, 'the neutral verdict must be skipped');
  assert.equal(h.writes.length, 0, 'no neutral conclusion was written');
  assert.equal(h.store.stats().events, before);
  assert.equal(h.lookups.length, 1);
  assert.deepEqual(h.lookups[0].applicability, OLD, 'the skip gate queried the captured triple');

  const found = h.store.findConclusions({ target: TARGET, applicability: OLD });
  assert.equal(found.matches.length, 1);
  assert.equal(found.matches[0].decision, 'no-benefit');
  assert.equal(found.matches[0].count, 1);
  const live = h.store.findConclusions({ target: TARGET, applicability: NEW });
  assert.ok(live.matches.every((match) => match.sameApplicability === false));
});

test('the skip gate and the written conclusion use one applicability value', (t) => {
  const h = harness(t);
  h.orchestrator.publishConclusion(record({ proposal: { applicability: OLD } }), 'insufficient-evidence', 'revert');
  assert.equal(h.lookups.length, 1);
  assert.deepEqual(h.lookups[0].applicability, OLD);
  assert.deepEqual(h.writes[0].applicability, OLD);
});

test('same-process experiments keep stamping the live process triple', (t) => {
  const h = harness(t);
  h.orchestrator.publishConclusion(record(), 'adopted', 'decision');
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.writes[0].applicability, NEW);
  assert.equal(h.store.findConclusions({ target: TARGET, applicability: NEW }).matches[0].sameApplicability, true);
});

test('invalid captured fields fall back to the live triple', (t) => {
  const h = harness(t);
  const bad = record({
    proposal: { applicability: '0.2.2-rc.4' },
    probe: { versions: ['0.2.2-rc.4'] },
  });
  h.orchestrator.publishConclusion(bad, 'no-benefit', 'measure');
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.writes[0].applicability, NEW);
});

test('the durable observation probe takes precedence after a restart', (t) => {
  const h = harness(t);
  h.orchestrator.publishConclusion(
    record({ proposal: { applicability: OLD }, latestObservation: { probe: { versions: MEASURED } } }),
    'adopted', 'canary-passed');
  assert.deepEqual(h.writes[0].applicability, MEASURED);
  assert.equal(h.store.findConclusions({ target: TARGET, applicability: MEASURED }).matches[0].sameApplicability, true);
});

test('a probe measurement takes precedence over the proposal applicability', (t) => {
  const h = harness(t);
  h.orchestrator.publishConclusion(
    record({ proposal: { applicability: OLD }, probe: { versions: MEASURED } }),
    'adopted', 'canary-passed');
  assert.deepEqual(h.writes[0].applicability, MEASURED);
  assert.equal(h.store.findConclusions({ target: TARGET, applicability: MEASURED }).matches[0].sameApplicability, true);
});
