import { inspectRuntime, toLosslessJson } from '../../lib/orchestrator.js';

// Frozen implementation of the pre-optimization inspect boundary.
export function legacyInspect(core, agent) {
  return toLosslessJson({
    ...inspectRuntime(core.ctx, agent, core.runner),
    evolutionPolicy: {
      mode: core.mode, unattended: core.unattended, autonomous: core.autonomous,
      evolvableByDefault: true, trustRoot: 'Cordis',
      productionPromotion: 'explicit-user-confirmation',
    },
    evolutionMemory: core.memory.diagnostics(),
    evolutionObservations: structuredClone(core.observations.slice(-20)),
    evolutionCandidates: structuredClone([...core.candidates.values()]),
  });
}

export function context() {
  const schema = { type: 'object', properties: { value: { type: 'string' } } };
  const definitions = new Map();
  return {
    definitions, schema,
    registry: { values: () => [] },
    reflect: { props: {}, _getImpl: () => undefined },
    events: { _hooks: {} },
    tools: {
      schemas: () => [{ name: 'fixture', parameters: schema }],
      register: definition => definitions.set(definition.name, definition),
    },
    dynamicCordisRunner: { snapshot: () => [] },
    get: () => ({ list: () => [] }),
    systemPrompt: { section() {} },
  };
}

export const config = {
  startupDrift: false, memory: { diagnostics: () => ({ entries: 0 }) },
  eventBridge: { emit: () => ({}) },
};

export function populate(core, count = 100) {
  core.observations = Array.from({ length: 20 }, (_, i) => ({
    observationId: `obs-${i}`, input: { code: 'FIXTURE', metrics: { cpu: i, memory: 1000 }, tags: ['a', 'b'] },
  }));
  core.candidates = new Map(Array.from({ length: count }, (_, i) => [String(i), {
    candidateId: `candidate-${i}`, patternKey: `pattern-${i}`, risk: 'low',
    observationIds: ['obs-1', 'obs-2', 'obs-3'],
    strategy: { target: `component-${i}`, idPrefix: 'fix' }, createdAt: '2026-01-01',
  }]));
}
