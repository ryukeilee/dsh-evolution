// Regression for workflow probe expectations whose differing leaves sit below
// stableJson()'s depth bound. Without a guard both serialize to "[max-depth]"
// and share one expectedDigest/scenarioDigest, so a wrong candidate result is
// judged correct and can drive a false benefit.
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeProbeScenario, probeScenarioDigest } from '../lib/orchestrator.js';

const VERSIONS = { dsh: '0.2.2-rc.5', cordis: '4.1.0', evolution: '0.2.19' };

function deep(leaf, levels = 70) {
  let value = leaf;
  for (let index = 0; index < levels; index += 1) value = { n: value };
  return value;
}

function scenario(expected) {
  return { kind: 'workflow', id: 'deep-expected', steps: [
    { name: 'read', role: 'target', arguments: { path: 'x' }, expected },
  ] };
}

test('two expectations differing only below the depth bound cannot collide', () => {
  const shallowA = deep('A', 10);
  const shallowB = deep('B', 10);
  const scenarioA = normalizeProbeScenario(scenario(shallowA));
  const scenarioB = normalizeProbeScenario(scenario(shallowB));
  assert.notEqual(scenarioA.steps[0].expectedDigest, scenarioB.steps[0].expectedDigest);
  assert.notEqual(probeScenarioDigest(scenarioA, VERSIONS), probeScenarioDigest(scenarioB, VERSIONS));
});

test('a folded expectation is rejected instead of sharing another digest', () => {
  assert.throws(() => normalizeProbeScenario(scenario(deep('A', 70))),
    (error) => error.code === 'E_EVOLUTION_PROBE_SCENARIO' && /lossless/.test(error.message));
  assert.throws(() => normalizeProbeScenario(scenario(deep('B', 70))),
    (error) => error.code === 'E_EVOLUTION_PROBE_SCENARIO');
});

test('non-finite and cyclic expectations are rejected', () => {
  assert.throws(() => normalizeProbeScenario(scenario({ n: Number.NaN })),
    (error) => error.code === 'E_EVOLUTION_PROBE_SCENARIO');
  const cyclic = { n: 1 };
  cyclic.self = cyclic;
  assert.throws(() => normalizeProbeScenario(scenario(cyclic)),
    (error) => error.code === 'E_EVOLUTION_PROBE_SCENARIO');
});

test('ordinary bounded expectations keep their historical digest', () => {
  const plain = normalizeProbeScenario(scenario({ characters: 3, lines: 1 }));
  assert.match(plain.steps[0].expectedDigest, /^sha256:[0-9a-f]{64}$/);
});
