// Regression for the two Desktop-host evidence fidelity findings:
//   B-1: canonical() folded undefined/null, sparse/dense arrays and -0, so a
//        missing tool result could satisfy an `expected: null` sample or canary
//        workload step and turn negative evidence into a stable promotion.
//   B-2: canary evidence shipped raw tool bodies into the promotion journal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { createDesktopTaskHost, sameValue, losslessCanonicalText } from '../lib/desktop-task-host.js';
import {
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  mintTaskId,
  taskChannelPaths,
} from '../lib/desktop-task-protocol.js';

const GATES = Object.freeze({
  benefit: true, measured: true, repeatable: true, regression: true,
  reversibility: true, cleanup: true, noOrphans: true, runtimeRecovery: true, eligible: true,
});

test('sameValue does not fold undefined, null, holes or non-finite numbers', () => {
  assert.equal(sameValue(undefined, null), false);
  assert.equal(sameValue(null, undefined), false);
  assert.equal(sameValue({ value: undefined }, { value: null }), false);
  assert.equal(sameValue({ value: undefined }, {}), false);
  assert.equal(sameValue([undefined], [null]), false);
  const sparse = [null];
  delete sparse[0];
  assert.equal(sameValue(sparse, [null]), false);
  assert.equal(sameValue(sparse, [undefined]), false);
  assert.equal(sameValue([null], [null]), true);
  assert.equal(sameValue(undefined, undefined), true);
  assert.equal(sameValue(NaN, null), false);
  assert.equal(sameValue(NaN, NaN), false);
  assert.equal(sameValue(Infinity, null), false);
  assert.equal(sameValue(-0, 0), false);
  assert.equal(sameValue(-0, -0), true);
  assert.equal(sameValue(0, 0), true);
});

test('sameValue accepts only dense arrays and plain objects, and returns false for cycles', () => {
  assert.equal(sameValue(new Date(0), {}), false);
  assert.equal(sameValue(new Map(), {}), false);
  assert.equal(sameValue(new Set(), []), false);
  class Candidate {}
  assert.equal(sameValue(new Candidate(), {}), false);
  assert.equal(sameValue(Object.create(null, { a: { value: 1, enumerable: true } }), { a: 1 }), true);
  const cyclic = { own: 1 };
  cyclic.self = cyclic;
  const other = { own: 1 };
  other.self = other;
  assert.equal(sameValue(cyclic, other), false);
  assert.equal(sameValue(cyclic, cyclic), false);
});

test('sameValue keeps ordinary JSON equality: key order irrelevant, array order relevant', () => {
  assert.equal(sameValue(
    { b: 2, a: [1, { y: 'z', x: true }] },
    { a: [1, { x: true, y: 'z' }], b: 2 },
  ), true);
  assert.equal(sameValue([1, 2], [2, 1]), false);
  assert.equal(sameValue({ a: [{ b: null }] }, { a: [{ b: null }] }), true);
  const protoKey = JSON.parse('{"__proto__":{"status":"ok"}}');
  assert.equal(sameValue(protoKey, {}), false);
  assert.equal(sameValue(protoKey, JSON.parse('{"__proto__":{"status":"bad"}}')), false);
  assert.equal(sameValue(protoKey, JSON.parse('{"__proto__":{"status":"ok"}}')), true);
});

test('losslessCanonicalText uses typed markers so nullish and placeholder values cannot collide', () => {
  const digest = (value) => crypto.createHash('sha256').update(losslessCanonicalText(value)).digest('hex');
  assert.notEqual(digest(undefined), digest('[undefined]'), 'undefined must not look like the string [undefined]');
  assert.notEqual(digest(null), digest('null'), 'null must not look like the string null');
  assert.notEqual(digest(null), digest(undefined));
  const hole = [null];
  delete hole[0];
  assert.notEqual(digest(hole), digest('[unavailable]'), 'an array hole must not look like the string [unavailable]');
  assert.notEqual(digest(hole), digest([null]));
  const cyclic = {};
  cyclic.self = cyclic;
  assert.notEqual(digest(cyclic), digest('[unavailable]'), 'unsupported values keep an unforgeable marker');
  assert.notEqual(digest(NaN), digest('NaN'), 'a non-finite number must not look like its string spelling');
  assert.notEqual(digest(-0), digest('-0'), 'negative zero must not look like the string -0');
});

test('losslessCanonicalText stays stable for ordinary JSON values and leaves sameValue independent', () => {
  assert.equal(
    losslessCanonicalText({ b: 2, a: [1, { y: 'z', x: true }] }),
    losslessCanonicalText({ a: [1, { x: true, y: 'z' }], b: 2 }),
  );
  assert.notEqual(losslessCanonicalText([1, 2]), losslessCanonicalText([2, 1]));
  assert.equal(losslessCanonicalText('[undefined]'), losslessCanonicalText('[undefined]'));
  // B-1: the typed digest encoding must not touch the independent lossless equality.
  assert.equal(sameValue(undefined, null), false);
  assert.equal(sameValue(null, null), true);
  assert.equal(sameValue({ body: 'x' }, { body: 'x' }), true);
});

function harness(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'host-lossless-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const tool = `lossless_${crypto.randomBytes(4).toString('hex')}`;
  const plan = {
    proposal: { why: 'Lossless evidence regression', target: `plugin:${tool}`, impactScope: ['test'], successMetrics: ['exact values'] },
    composition: { name: tool, purpose: 'lossless check', code: { host: 'return {};' } },
    verification: {
      targetTool: tool,
      observations: 2,
      samples: [{ label: 'expected-null', tool, arguments: { text: 'abc' }, expected: null }],
    },
    requestedTargetProfiles: ['acp'],
  };
  const calls = [];
  const record = (name, args) => calls.push({ name, args });
  let candidateVisible = false;
  const kernelTools = new Map();
  kernelTools.set('evolution_runtime_inspect', { execute: async () => ({ components: [], services: [], events: [] }) });
  kernelTools.set('evolution_propose', { execute: async () => ({ ok: true, experimentId: 'exp-lossless', phase: 'proposed' }) });
  kernelTools.set('evolution_probe', { execute: async (args) => {
    record('evolution_probe', args);
    return { scenarioId: 'paired', scenarioDigest: 'sha256:paired', comparison: { benefit: true, workload: { sufficient: true } } };
  } });
  kernelTools.set('evolution_trial', { execute: async () => { candidateVisible = true; return { ok: true, phase: 'trial' }; } });
  kernelTools.set('evolution_measure', { execute: async () => ({ ok: true, phase: 'measured', gates: GATES, decision: { kind: 'benefit', eligible: true } }) });
  kernelTools.set('evolution_promote', { execute: async (args) => {
    record('evolution_promote', args);
    if (args.confirmation !== true) return { ok: false, phase: 'awaiting-owner-confirmation', gates: GATES, decision: { kind: 'benefit', eligible: true } };
    return { ok: true, phase: 'canary-observing' };
  } });
  kernelTools.set('evolution_canary_observe', { execute: async (args) => {
    record('evolution_canary_observe', args);
    if (args.metricRegression === true) return { ok: false, phase: 'rolled-back', rollback: 'last-known-good' };
    return { stable: true };
  } });
  kernelTools.set('evolution_revert', { execute: async () => ({ ok: true, runtimeRecovered: true, phase: 'reverted' }) });
  kernelTools.set('official_read', { execute: async () => ({ ok: true }) });
  const candidate = options.candidate ?? (() => undefined);
  const ctx = {
    logger: { warn() {} },
    effect() {},
    agents: { create: async (opts) => ({ agent: { id: opts.sessionId }, dispose: async () => {} }) },
    tools: { get(name) {
      if (name === tool) return candidateVisible ? { execute: async (args) => candidate(args) } : null;
      return kernelTools.get(name) ?? null;
    } },
    // A workload needs the official preset mounted on the task owner.
    get(name) {
      return name === 'agentPresets' ? { resolve: async () => ({ id: 'official-default' }), mount: async () => {} } : null;
    },
  };
  const host = createDesktopTaskHost(ctx, {
    dshHome: home, scanIntervalMs: 10, approvalPollMs: 10,
    approvalTimeoutMs: options.approvalTimeoutMs ?? 600, toolTimeoutMs: 1000,
    settlePollMs: 1, settleSamples: 4, settleMaxPolls: 20,
  });
  t.after(async () => { await host.dispose(); });
  return { home, plan, tool, calls, ctx, host, channel: taskChannelPaths(home) };
}

async function submit(home, plan, taskId = mintTaskId()) {
  const dir = taskChannelPaths(home).inbox;
  await fsp.mkdir(dir, { recursive: true });
  const request = {
    schemaVersion: SCHEMA_VERSION, protocol: PROTOCOL_VERSION, taskId,
    createdAt: new Date().toISOString(), requester: { profile: 'acp', sessionId: 'session-test' },
    plan, cwd: os.tmpdir(),
  };
  await fsp.writeFile(path.join(dir, `${taskId}.json`), `${JSON.stringify(request)}\n`, { mode: 0o600 });
  return taskId;
}

async function approveWhenWaiting(home, taskId) {
  const state = await waitForState(home, taskId, (value) => value.phase === 'awaiting-owner-confirmation');
  const dir = taskChannelPaths(home).approvals;
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${taskId}.json`), `${JSON.stringify({
    schemaVersion: SCHEMA_VERSION, protocol: PROTOCOL_VERSION, taskId,
    experimentId: state.experimentId,
    sourceSha256: state.candidateSourceSha256,
    confirmation: true, confirmationText: 'Acceptance approval: promote the measured candidate.',
    targetProfiles: ['acp'], confirmedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
}

async function waitForState(home, taskId, predicate, timeoutMs = 8000) {
  const file = path.join(taskChannelPaths(home).state, `${taskId}.json`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (predicate(value)) return value;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (Date.now() >= deadline) {
      const latest = await fsp.readFile(file, 'utf8').catch(() => null);
      throw new Error(`state for ${taskId} did not reach the expected phase${latest ? `; latest: ${latest.slice(0, 1200)}` : ''}`);
    }
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}

test('a trial sample expecting null fails when the candidate tool returns undefined', async (t) => {
  const { home, plan, host, calls } = harness(t);
  const taskId = await submit(home, plan);
  await host.start();
  const state = await waitForState(home, taskId, (value) => value.phase === 'failed' || value.phase === 'awaiting-owner-confirmation');
  assert.equal(state.phase, 'failed', 'a missing tool value must not satisfy expected:null');
  assert.equal(state.error.code, 'E_DESKTOP_SAMPLE_MISMATCH');
  assert.equal(calls.filter((call) => call.name === 'evolution_canary_observe').length, 0);
  assert.equal(calls.filter((call) => call.name === 'evolution_promote' && call.args.confirmation === true).length, 0);
});

test('a canary workload whose resultPath is missing does not satisfy expected:null', async (t) => {
  const body = 'RAW_TOOL_BODY_MUST_NOT_REACH_EVIDENCE_2d91c4';
  const options = {
    candidate: (args) => args.text === 'workload'
      ? { ok: true }
      : { body, marker: 'trial' },
  };
  const { home, plan, tool, host, calls } = harness(t, options);
  plan.verification.samples[0].expected = { body, marker: 'trial' };
  plan.verification.workload = {
    kind: 'workflow', id: 'missing-field', repetitions: 1,
    steps: [{ name: 'official_read', candidateName: tool, role: 'target', arguments: { text: 'workload' }, resultPath: ['missing'], expected: null }],
  };
  const taskId = await submit(home, plan);
  await host.start();
  await approveWhenWaiting(home, taskId);
  const state = await waitForState(home, taskId, (value) => value.phase === 'failed' || value.phase === 'stable');
  assert.equal(state.phase, 'failed', 'undefined selected at resultPath must not satisfy expected:null');
  assert.equal(state.error.code, 'E_DESKTOP_CANARY_REGRESSION');
  assert.deepEqual(state.revert, { ok: true, status: 'last-known-good' });
  const regression = calls.filter((call) => call.name === 'evolution_canary_observe' && call.args.metricRegression === true);
  assert.equal(regression.length, 1, 'the kernel rollback must be requested exactly once');
  // B-2: even on the regression path the evidence is bounded metadata, never
  // the raw tool body returned by the sample.
  const evidence = regression[0].args.evidence;
  assert.ok(Array.isArray(evidence.actualToolOutput));
  assert.equal(evidence.actualToolOutput.length, 1);
  const [sample] = evidence.actualToolOutput;
  assert.equal(typeof sample.label, 'string');
  assert.ok(sample.label.length > 0);
  assert.match(sample.resultSha256, /^[0-9a-f]{64}$/);
  assert.equal(typeof sample.resultCharacters, 'number');
  assert.ok(sample.resultCharacters > 0);
  assert.equal(JSON.stringify(evidence).includes(body), false, 'the raw tool body must not be shipped to the kernel');
});

test('a canary sample regression carries the in-memory sentinel sample into bounded rollback evidence', async (t) => {
  const sentinel = 'S5_CANARY_SAMPLE_SENTINEL_4c8d77';
  let sampleCalls = 0;
  const options = {
    candidate: () => {
      sampleCalls += 1;
      // The trial sample must pass so the plan reaches canary; the replay then
      // regresses with a value whose body must never cross the host boundary.
      if (sampleCalls === 1) return null;
      return { body: sentinel, nested: { secret: sentinel } };
    },
  };
  const { home, plan, tool, host, calls } = harness(t, options);
  plan.verification.samples = [{ label: 'regressing-sample', tool, arguments: { text: 'abc' }, expected: null }];
  const taskId = await submit(home, plan);
  await host.start();
  await approveWhenWaiting(home, taskId);
  const state = await waitForState(home, taskId, (value) => value.phase === 'failed' || value.phase === 'stable');
  assert.equal(state.phase, 'failed');
  assert.equal(state.error.code, 'E_DESKTOP_CANARY_REGRESSION');
  assert.equal(JSON.stringify(state.error).includes(sentinel), false, 'the terminal state must not retain the tool body');
  const regression = calls.filter((call) => call.name === 'evolution_canary_observe' && call.args.metricRegression === true);
  assert.equal(regression.length, 1, 'the kernel rollback must be requested exactly once');
  const serialized = JSON.stringify(regression[0].args);
  assert.equal(serialized.includes(sentinel), false, 'the raw tool body must not reach the kernel evidence');
  assert.deepEqual(state.revert, { ok: true, status: 'last-known-good' });
  assert.equal(calls.filter((call) => call.name === 'evolution_revert').length, 0, 'the kernel owns the rollback');
  const evidence = regression[0].args.evidence;
  assert.equal(evidence.actualToolOutput.length, 1);
  const [sample] = evidence.actualToolOutput;
  assert.equal(sample.label, 'regressing-sample');
  const digest = crypto.createHash('sha256').update(losslessCanonicalText({ body: sentinel, nested: { secret: sentinel } })).digest('hex');
  assert.equal(sample.resultSha256, digest, 'the in-memory sample is carried into the rollback evidence');
  assert.equal(typeof sample.resultCharacters, 'number');
  assert.ok(sample.resultCharacters > 0);
});
