// The observed probe result must satisfy the same lossless serialization rule
// as the declared expectation. Otherwise a literal "[undefined]" expectation
// is matched by a real `undefined` (stableJson folds both to one marker), and a
// wrong candidate result produces a false correctness proof.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EvolutionOrchestrator, normalizeProbeScenario } from '../lib/orchestrator.js';

function harness(t, { value, expected, resultPath } ) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-result-lossless-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const recorded = [];
  const ctx = {
    logger: { warn() {}, error() {} },
    storage: { backend: { get: () => ({}) } },
    effect() {},
    emit() {},
    tools: {
      schemas: () => [],
      register() {},
      get: () => ({ name: 'probe-target', isConcurrencySafe: () => true }),
      execute: async ({ calls }) => {
        recorded.push(calls[0]);
        return { results: [{ callId: calls[0].id, result: { isError: false, value } }] };
      },
    },
  };
  const orchestrator = new EvolutionOrchestrator(ctx, {
    presetDir: root,
    eventBridgePath: path.join(root, 'events.jsonl'),
    eventBridgeKey: 'k'.repeat(32),
    driftStatePath: path.join(root, 'drift.json'),
    memoryPath: path.join(root, 'memory.json'),
    startupDrift: false,
  });
  orchestrator.configuredVersions = { host: '0.2.2-rc.5', cordis: '4.1.0', evolution: '0.2.19' };
  const exec = { agent: { id: 'probe-owner' }, signal: new AbortController().signal };
  orchestrator.experiments.set('exp-probe-lossless', {
    id: 'exp-probe-lossless', ownerId: exec.agent.id, state: 'proposed',
    proposal: { target: 'tool:read', strategy: 'S', strategyFingerprint: 'a1b2c3d4e5f60718' },
  });
  const scenario = { kind: 'workflow', id: 'lossless', repetitions: 1, steps: [
    { name: 'probe-target', role: 'target', arguments: {}, expected, ...(resultPath ? { resultPath } : {}) },
  ] };
  return { orchestrator, exec, scenario, recorded };
}

test('a real undefined cannot satisfy a literal "[undefined]" expectation', async (t) => {
  const h = harness(t, { value: { marker: undefined }, expected: { marker: '[undefined]' } });
  const result = await h.orchestrator.probe({ experimentId: 'exp-probe-lossless', phase: 'baseline', scenario: h.scenario }, h.exec);
  assert.ok(result.samples.some((entry) => entry.isError === true && entry.code === 'PROBE_VALUE_NOT_LOSSLESS'),
    JSON.stringify(result.samples));
});

test('a custom iterator cannot reorder a result into matching the expectation', async (t) => {
  const value = ['north', 'south'];
  value[Symbol.iterator] = function* reverse() { yield 'south'; yield 'north'; };
  const h = harness(t, { value, expected: ['south', 'north'] });
  const result = await h.orchestrator.probe({ experimentId: 'exp-probe-lossless', phase: 'baseline', scenario: h.scenario }, h.exec);
  assert.ok(result.samples.some((entry) => entry.isError === true && entry.code === 'E_EVOLUTION_PROBE_INCORRECT'),
    JSON.stringify(result.samples));
});

test('an accessor that answers differently is rejected in one pass', async (t) => {
  let reads = 0;
  const value = {};
  Object.defineProperty(value, 'marker', {
    enumerable: true,
    get() { reads += 1; return reads === 1 ? '[undefined]' : undefined; },
  });
  const h = harness(t, { value, expected: { marker: '[undefined]' } });
  const result = await h.orchestrator.probe({ experimentId: 'exp-probe-lossless', phase: 'baseline', scenario: h.scenario }, h.exec);
  assert.ok(result.samples.some((entry) => entry.isError === true && entry.code === 'PROBE_VALUE_NOT_LOSSLESS'),
    JSON.stringify(result.samples));
});

test('a resultPath accessor is rejected without being read', async (t) => {
  let reads = 0;
  const nested = {};
  Object.defineProperty(nested, 'marker', { enumerable: true,
    get() { reads += 1; return reads === 1 ? '[undefined]' : 'wrong'; } });
  const h = harness(t, { value: { nested }, expected: { marker: '[undefined]' }, resultPath: ['nested'] });
  const result = await h.orchestrator.probe({ experimentId: 'exp-probe-lossless', phase: 'baseline', scenario: h.scenario }, h.exec);
  assert.equal(reads, 0, 'the path walker must read only own data descriptors');
  assert.ok(result.samples.some((entry) => entry.isError === true && entry.code === 'PROBE_VALUE_NOT_LOSSLESS' && entry.outputUnmeasurable === true),
    JSON.stringify(result.samples));
});

test('the length bound reads the validated snapshot, not a toJSON proxy', () => {
  const expected = { big: 'x'.repeat(17000) };
  Object.defineProperty(expected, 'toJSON', { value: () => 'short', enumerable: false });
  assert.throws(() => normalizeProbeScenario({ kind: 'workflow', id: 'long', steps: [
    { name: 'probe-target', role: 'target', arguments: {}, expected },
  ] }), (error) => error.code === 'E_EVOLUTION_PROBE_SCENARIO');
});

test('a throwing accessor is never read and keeps the precise classification', async (t) => {
  let reads = 0;
  const value = {};
  Object.defineProperty(value, 'marker', { enumerable: true,
    get() { reads += 1; throw new Error('getter must not be read again'); } });
  const h = harness(t, { value, expected: { marker: '[undefined]' } });
  const result = await h.orchestrator.probe({ experimentId: 'exp-probe-lossless', phase: 'baseline', scenario: h.scenario }, h.exec);
  assert.equal(reads, 0, 'the snapshot rejects accessors before reading them');
  assert.ok(result.samples.some((entry) => entry.isError === true && entry.code === 'PROBE_VALUE_NOT_LOSSLESS'),
    JSON.stringify(result.samples));
});

test('a non-plain object cannot satisfy an empty record expectation', async (t) => {
  const h = harness(t, { value: new Date(0), expected: {} });
  const result = await h.orchestrator.probe({ experimentId: 'exp-probe-lossless', phase: 'baseline', scenario: h.scenario }, h.exec);
  assert.ok(result.samples.some((entry) => entry.isError === true && entry.code === 'PROBE_VALUE_NOT_LOSSLESS'),
    JSON.stringify(result.samples));
});

test('a lossless value keeps its historical correctness check', async (t) => {
  const h = harness(t, { value: { marker: 'ok' }, expected: { marker: 'ok' } });
  const result = await h.orchestrator.probe({ experimentId: 'exp-probe-lossless', phase: 'baseline', scenario: h.scenario }, h.exec);
  assert.ok(result.samples.some((entry) => entry.isError === false), JSON.stringify(result.samples));
});
