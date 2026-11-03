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
  await assert.rejects(s.error(), /synthetic commit refusal/);
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
