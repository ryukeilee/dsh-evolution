// The observed probe result must satisfy the same lossless serialization rule
// as the declared expectation. Otherwise a literal "[undefined]" expectation
// is matched by a real `undefined` (stableJson folds both to one marker), and a
// wrong candidate result produces a false correctness proof.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EvolutionOrchestrator } from '../lib/orchestrator.js';

function harness(t, { value, expected }) {
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
    { name: 'probe-target', role: 'target', arguments: {}, expected },
  ] };
  return { orchestrator, exec, scenario, recorded };
}

test('a real undefined cannot satisfy a literal "[undefined]" expectation', async (t) => {
  const h = harness(t, { value: { marker: undefined }, expected: { marker: '[undefined]' } });
  const result = await h.orchestrator.probe({ experimentId: 'exp-probe-lossless', phase: 'baseline', scenario: h.scenario }, h.exec);
  assert.ok(result.samples.some((entry) => entry.isError === true && entry.code === 'PROBE_VALUE_NOT_LOSSLESS'),
    JSON.stringify(result.samples));
});

test('a lossless value keeps its historical correctness check', async (t) => {
  const h = harness(t, { value: { marker: 'ok' }, expected: { marker: 'ok' } });
  const result = await h.orchestrator.probe({ experimentId: 'exp-probe-lossless', phase: 'baseline', scenario: h.scenario }, h.exec);
  assert.ok(result.samples.some((entry) => entry.isError === false), JSON.stringify(result.samples));
});
