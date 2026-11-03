import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { openDomainStorage } from '../lib/domain-storage.js';
import { context } from './fixtures/runtime-inspect.mjs';
import { apply } from '../lib/registration.js';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-durable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return async function session(options = {}) {
    const backend = new JsonStorageBackend(path.join(root, 'official'));
    const listeners = new Map();
    const ctx = { ...context(), emit() {}, effect() {}, logger: { warn() {} }, on: (n, f) => listeners.set(n, f),
      storage: { backend: { get: () => backend } }, dynamicCordisRunner: { snapshot: () => [], define: () => ({ pluginId: "durable-plugin", packageId: "durable-package" }),
        run: async () => ({ ok: true, status: "active" }), stop: async () => ({ ok: true }), undefine: async () => ({ ok: true }) },
      tools: { register() {}, schemas: () => [] }, systemPrompt: { section() {} } };
    ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
    const config = { presetDir: root, eventBridgePath: path.join(root, 'events.jsonl'), eventBridgeKey: 'b'.repeat(64),
      startupDrift: false, patternThreshold: 3, autonomousStrategies: { AGENT_ERROR: { risk: 'medium', target: 'plugin:fix' } }, ...options };
    const port = await openDomainStorage(ctx, config);
    const core = apply(ctx, { ...config, domainStorage: port });
    const outcomes = [];
    const observe = core.observeAutonomous.bind(core);
    core.observeAutonomous = (...args) => { const promise = observe(...args); outcomes.push(promise); return promise; };
    return { core, port, ctx, async error(message = 'provider unavailable') {
      const error = new Error(message); error.code = 'AGENT_ERROR';
      listeners.get('agent/error')({ error, agent: { id: 'owner' } });
      while (!outcomes.length) await new Promise(resolve => setImmediate(resolve));
      return await outcomes.shift();
    }, async close() { await port.close(); await backend.close(); } };
  };
}

test('official listener/storage: same fault crosses restart and different roots stay separate', async t => {
  const session = await fixture(t);
  let s = await session();
  assert.equal((await s.error()).occurrences, 1);
  assert.equal((await s.error()).occurrences, 2);
  await s.close();
  s = await session();
  try {
    assert.equal((await s.error('authorization denied')).occurrences, 1);
    const result = await s.error();
    assert.equal(result.phase, 'candidate-awaiting-confirmation');
    assert.equal(result.candidate.observationIds.length, 3);
    assert.equal(new Set(result.candidate.observationIds).size, 3);
    assert.equal(s.core.experiments.size, 0);
  } finally { await s.close(); }
});

const improved = { solvesProblem: true, sideEffects: [], orphanResources: [], performanceChange: 'decreased', errorChange: 'decreased',
  metrics: { errCount: 0 }, beforeMetrics: { errCount: 1 }, afterMetrics: { errCount: 0 }, observationWindow: '1h', sampleCount: 2,
  benefitEvidence: 'errors fell from 1 to 0', repeatable: true, regressionPassed: true, reversible: true, cleanupEvidence: 'runtime restored' };
const low = { risk: 'low', target: 'plugin:fix', idPrefix: 'durable',
  composition: { name: 'durable-fix', purpose: 'fix', code: { host: 'return {};' } }, observation: improved };
const options = { autonomousStrategies: { AGENT_ERROR: low } };

test('official storage: concurrent threshold events run once; restart holds prior decision without promotion authority', async t => {
  const session = await fixture(t);
  let s = await session(options);
  await s.error(); await s.error();
  const outcomes = await Promise.all([s.error(), s.error()]);
  assert.equal(s.core.experiments.size, 1);
  assert.ok(outcomes.some(row => row.phase === 'candidate-awaiting-confirmation'));
  assert.equal([...s.core.experiments.values()][0].state, 'measured');
  await s.close();
  s = await session(options);
  try {
    const result = await s.error();
    assert.equal(result.reason, 'prior-decision-requires-owner');
    assert.equal(result.automatic, false);
    assert.equal(result.gates, undefined);
    assert.equal(s.core.experiments.size, 0);
  } finally { await s.close(); }
});

test('legacy rows are ignored, committed observation IDs and replay do not inflate counts', async t => {
  const session = await fixture(t);
  let s = await session();
  await s.port.observe({ type: 'agent/error', code: 'AGENT_ERROR', target: 'agent' });
  const key = s.core.patternKey({ type: 'agent/error', code: 'AGENT_ERROR', target: 'agent', message: 'provider unavailable' });
  const dto = { type: 'agent/error', code: 'AGENT_ERROR', observationId: 'obs-replayed', patternKey: `autonomous-v1:${key}` };
  await s.port.observe(dto); await s.port.observe(dto);
  await s.port.flush(); await s.port.flush();
  assert.equal(s.port.autonomousObservations().length, 1);
  await s.close();
  s = await session();
  try { assert.equal((await s.error()).occurrences, 2); }
  finally { await s.close(); }
});

test('an observation commit failure refuses the decision and leaves no counted in-memory evidence', async t => {
  const session = await fixture(t);
  const s = await session(options);
  const domain = s.ctx.storageDomain.get('evolution_domain');
  const set = domain.global.set;
  domain.global.set = async () => { throw new Error('synthetic commit refusal'); };
  await assert.rejects(s.error('provider unavailable after 120 ms'), /synthetic commit refusal/);
  assert.equal(s.core.patterns.size, 0);
  assert.equal(s.core.experiments.size, 0);
  domain.global.set = set;
  await assert.rejects(s.close(), /synthetic commit refusal/);
  const next = await session();
  try { assert.equal((await next.error()).occurrences, 1); }
  finally { await next.close(); }
});

test('a reservation surviving interruption blocks a second Trial; changed strategy remains independent', async t => {
  const session = await fixture(t);
  let s = await session(options);
  await s.error(); await s.error();
  const key = [...s.core.patterns.keys()][0];
  const identity = `${key}:${s.core.strategyFingerprint(low)}`;
  assert.equal(await s.port.reserveAutonomousDecision(identity), true);
  assert.equal(await s.port.reserveAutonomousDecision(identity), false);
  await s.close();
  s = await session(options);
  try {
    assert.equal((await s.error()).reason, 'prior-decision-requires-owner');
    assert.equal(s.core.experiments.size, 0);
    assert.equal(await s.port.reserveAutonomousDecision(`${key}:${s.core.strategyFingerprint({ ...low, target: 'plugin:other' })}`), true);
  } finally { await s.close(); }
});

test('cold archived evidence survives reopening official storage', async t => {
  const session = await fixture(t);
  let s = await session();
  await s.error(); await s.error();
  for (let index = 0; index < 55; index++) await s.error(`distinct root ${index}`);
  await s.close();
  s = await session();
  try { assert.equal((await s.error()).candidate.observationIds.length, 3); }
  finally { await s.close(); }
});

test('proven explicit revert releases the persistent decision for a later session', async t => {
  const session = await fixture(t);
  let s = await session(options);
  await s.error(); await s.error();
  const candidate = await s.error();
  assert.equal((await s.core.revert({ experimentId: candidate.experimentId }, { agent: { id: 'owner' } })).ok, true);
  await s.close();
  s = await session(options);
  try { assert.equal((await s.error()).phase, 'candidate-awaiting-confirmation'); assert.equal(s.core.experiments.size, 1); }
  finally { await s.close(); }
});


test('a clean target conflict releases the decision so a later session can retry', async t => {
  const session = await fixture(t);
  let s = await session(options);
  const claim = path.join(s.core.paths.ownershipDir, `${crypto.createHash('sha256').update('plugin:fix').digest('hex')}.json`);
  fs.mkdirSync(path.dirname(claim), { recursive: true });
  fs.writeFileSync(claim, JSON.stringify({ schema: 1, target: 'plugin:fix', experimentId: 'exp-other',
    ownerId: 'other', pid: process.pid, hostname: os.hostname(), acquiredAt: new Date().toISOString() }));
  await s.error(); await s.error();
  const result = await s.error();
  assert.equal(result.reason, 'transient-failure');
  assert.equal(result.cleanup.status, 'discarded');
  await s.close();
  fs.rmSync(claim);
  s = await session(options);
  try {
    const retried = await s.error();
    assert.equal(retried.phase, 'candidate-awaiting-confirmation');
    assert.notEqual(retried.reason, 'prior-decision-requires-owner');
    assert.equal(s.core.experiments.size, 1);
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------
// Elapsed-time variants of one fault, counted through the durable window
// ---------------------------------------------------------------------------
//
// The registered listener records the redacted summary plus both digests: the
// raw one (exact failure evidence) and the pattern one computed after the
// labelled `after N ms` duration is normalized. The durable observation row is
// keyed by the pattern identity, so a fault whose duration changes between
// occurrences - including across a host restart - still accumulates to
// `patternThreshold`. Every assertion below therefore covers both halves of the
// loop at once: identity (duration is not part of it) and durability (the
// counted evidence survives the process).

const digestOf = (text) => `sha256:${crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)}`;

test('official listener/storage: elapsed variants of one fault accumulate across a restart', async (t) => {
  const session = await fixture(t);
  let s = await session();
  assert.equal((await s.error('provider call failed after 100 ms')).occurrences, 1);
  assert.equal((await s.error('provider call failed after 240 ms')).occurrences, 2);
  await s.close();
  s = await session();
  try {
    const result = await s.error('provider call failed after 380 ms');
    assert.equal(result.phase, 'candidate-awaiting-confirmation');
    assert.equal(result.candidate.observationIds.length, 3);
    assert.equal(new Set(result.candidate.observationIds).size, 3);
    assert.equal(s.core.experiments.size, 0, 'the medium-risk decision waits for its owner');
  } finally { await s.close(); }
});

test('official listener/storage: elapsed variants kept distinct from a different root cause', async (t) => {
  const session = await fixture(t);
  let s = await session();
  await s.error('provider call failed after 100 ms');
  assert.equal((await s.error('provider call failed after 200 ms')).occurrences, 2);
  // Same shape, different root cause: the raw digest still separates it, so the
  // normalization cannot merge two faults into one threshold.
  assert.equal((await s.error('authorization denied after 100 ms')).occurrences, 1);
  await s.close();
  s = await session();
  try {
    const other = await s.error('authorization denied after 900 ms');
    assert.equal(other.occurrences, 2, 'the other root cause accumulates on its own identity');
    assert.equal(s.port.autonomousObservations().length, 4, 'both root causes keep their own occurrences');
    assert.equal(new Set(s.port.autonomousObservations().map(row => row.patternKey)).size, 2, 'two root causes, two patterns');
    assert.equal(s.core.experiments.size, 0);
  } finally { await s.close(); }
});

const unimproved = { ...improved, solvesProblem: false, performanceChange: 'unchanged', errorChange: 'unchanged',
  metrics: {}, beforeMetrics: {}, afterMetrics: {}, benefitEvidence: 'no measurable improvement', repeatable: false };

test('official storage: a held low-risk decision is not re-trialed by a later elapsed variant', async (t) => {
  const session = await fixture(t);
  let s = await session(options);
  await s.error('provider unavailable after 100 ms');
  await s.error('provider unavailable after 200 ms');
  const candidate = await s.error('provider unavailable after 300 ms');
  assert.equal(candidate.phase, 'candidate-awaiting-confirmation');
  assert.equal(s.core.experiments.size, 1);
  assert.equal([...s.core.experiments.values()][0].state, 'measured');
  await s.close();
  s = await session(options);
  try {
    const result = await s.error('provider unavailable after 400 ms');
    assert.equal(result.reason, 'prior-decision-requires-owner');
    assert.equal(result.automatic, false);
    assert.equal(s.core.experiments.size, 0, 'the same hypothesis is not trialed twice');
  } finally { await s.close(); }
});

test('official storage: elapsed variants of a failed hypothesis stay suppressed after a restart', async (t) => {
  const session = await fixture(t);
  const strategies = { patternThreshold: 2, autonomousStrategies: { AGENT_ERROR: { ...low, measure: async () => unimproved } } };
  let s = await session(strategies);
  await s.error('provider unavailable after 100 ms');
  assert.equal((await s.error('provider unavailable after 200 ms')).phase, 'rolled-back-no-improvement');
  const recorded = () => s.core.memory.data.entries.filter(entry => entry.experiment?.strategy);
  assert.equal(recorded().length, 1);
  const before = JSON.stringify(recorded());
  await s.close();
  s = await session(strategies);
  try {
    const result = await s.error('provider unavailable after 300 ms');
    assert.equal(result.reason, 'failure-memory');
    assert.equal(result.phase, 'suppressed');
    assert.equal(s.core.experiments.size, 0, 'no second Trial for an answered hypothesis');
    assert.equal(JSON.stringify(recorded()), before, 'the recorded verdict is reused, not rewritten');
  } finally { await s.close(); }
});

test('official storage: concurrent elapsed variants reach the threshold once and run one Trial', async (t) => {
  const session = await fixture(t);
  const s = await session(options);
  await s.error('provider unavailable after 10 ms');
  await s.error('provider unavailable after 20 ms');
  const outcomes = await Promise.all([
    s.error('provider unavailable after 30 ms'),
    s.error('provider unavailable after 40 ms'),
  ]);
  assert.equal(s.core.experiments.size, 1, 'one identity means one Trial, not one per duration');
  assert.ok(outcomes.some(row => row.phase === 'candidate-awaiting-confirmation'));
  assert.equal([...s.core.experiments.values()][0].state, 'measured');
  assert.equal(s.core.patterns.size, 1);
  await s.close();
});

test('durable rows from the pre-normalization identity are ignored, not merged', async (t) => {
  const session = await fixture(t);
  const raw = 'provider call failed after 100 ms';
  let s = await session();
  // An upgraded install still holds rows written when the elapsed time was part
  // of the identity. Their key cannot be recomputed from the new one, so they are
  // neither counted nor guessed at: the upgrade restarts this pattern's count.
  const legacyKey = s.core.patternKey({ type: 'agent/error', code: 'AGENT_ERROR', target: 'agent', message: raw, errorDigest: digestOf(raw) });
  for (const id of ['obs-legacy-1', 'obs-legacy-2']) {
    await s.port.observe({ type: 'agent/error', code: 'AGENT_ERROR', target: 'agent', observationId: id, patternKey: `autonomous-v1:${legacyKey}` });
  }
  await s.port.flush();
  assert.equal(s.port.autonomousObservations().filter(row => row.patternKey === legacyKey).length, 2);
  await s.close();
  s = await session();
  try {
    const result = await s.error('provider call failed after 400 ms');
    assert.equal(result.phase, 'pattern-observing');
    assert.equal(result.occurrences, 1, 'the legacy rows are not counted for the new identity');
    assert.equal(s.core.experiments.size, 0);
  } finally { await s.close(); }
});

test('durable rows for a fault without an elapsed suffix keep their identity', async (t) => {
  const session = await fixture(t);
  // A number that is not a labelled duration (a status code here) stays part of
  // the identity exactly as before.
  const raw = 'provider unavailable code 500';
  let s = await session();
  // No labelled duration, so the pattern digest equals the raw digest and the
  // identity does not move: evidence an earlier version committed still counts
  // after the upgrade instead of restarting from one.
  const stableKey = s.core.patternKey({ type: 'agent/error', code: 'AGENT_ERROR', target: 'agent', message: raw, errorDigest: digestOf(raw) });
  for (const id of ['obs-stable-1', 'obs-stable-2']) {
    await s.port.observe({ type: 'agent/error', code: 'AGENT_ERROR', target: 'agent', observationId: id, patternKey: `autonomous-v1:${stableKey}` });
  }
  await s.port.flush();
  await s.close();
  s = await session();
  try {
    const result = await s.error(raw);
    assert.equal(result.phase, 'candidate-awaiting-confirmation', 'the pre-existing occurrences still count');
    assert.equal(result.candidate.observationIds.length, 3);
  } finally { await s.close(); }
});
