// Projection cost for the observation list and the strategy / capability snapshots.
//
// Each of these used to rebuild the same list (or re-normalize the same query)
// more than once per call. This script drives the real classes:
//
//   node --expose-gc scripts/benchmarks/domain-projections.mjs
//
// The A/B recipe (baseline checkout + this same script) is documented in
// `docs/performance/redundant-work.md`. Every projection is compared against the
// values it must return, so a cheaper call that changes the projection fails.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { EvolutionObservationStore } from '../../lib/dockyard-domain/observation.js';
import { EvolutionStrategyMemory } from '../../lib/dockyard-domain/continuous/strategy.js';
import { CapabilityRegistry } from '../../lib/dockyard-domain/governance/capability-registry.js';

if (!global.gc) throw new Error('run with --expose-gc');
const entries = Number(process.env.BENCH_ENTRIES || 1000);
const samples = Number(process.env.BENCH_SAMPLES || 31);
const payload = 'x'.repeat(Number(process.env.BENCH_PAYLOAD_BYTES || 240));
const at = '2026-10-07T00:00:00.000Z';

function median(fn, iterations) {
  const times = [];
  for (let i = 0; i < iterations; i++) {
    global.gc();
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { medianMs: times[Math.floor(times.length / 2)], all: times };
}

const query = `failure-${'x'.repeat(180)}`;
const observations = new EvolutionObservationStore({
  memory: { recordObservation: async () => null, recordKnowledgeEvent: async () => null, stateStore: null },
});
observations.entries = Array.from({ length: entries }, (_, i) => ({
  id: `observation-${i}`, patternKey: query, observedAt: at, message: payload,
}));
assert.equal(observations.list({ patternKey: query }).length, entries);

const strategies = new EvolutionStrategyMemory({
  memory: {
    snapshot: () => ({
      strategies: Array.from({ length: entries }, (_, i) => ({ id: `strategy-${i}`, payload })),
      strategyMutations: Array.from({ length: entries }, (_, i) => ({ id: `mutation-${i}`, payload })),
    }),
  },
  maxEntries: entries,
});
assert.equal(strategies.snapshot().count, entries);
assert.equal(strategies.snapshot().mutationCount, entries);

const registry = new CapabilityRegistry({
  store: { load: async () => null, data: { capabilities: Array.from({ length: entries }, (_, i) => ({
    id: `capability-${i}`, lifecycleState: i % 2 ? 'active' : 'removed', payload,
  })) } },
  mutationAuthority: { assertMutation() {} },
});
assert.equal(registry.snapshot().activeCount, Math.ceil(entries / 2));

console.log(JSON.stringify({
  node: process.version, platform: `${process.platform}/${process.arch}`,
  entries, payloadBytes: payload.length, samples,
  observationListFiltered: median(() => observations.list({ patternKey: query }), samples),
  observationList: median(() => observations.list(), samples),
  strategySnapshot: median(() => strategies.snapshot(), samples),
  strategyList: median(() => strategies.list(), samples),
  capabilitySnapshot: median(() => registry.snapshot(), samples),
  capabilityList: median(() => registry.list(), samples),
}, null, 2));
