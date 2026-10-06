import { test, assert } from './helpers.mjs';

// Evidence persistence tests (goal: cross-session hydration must never
// downgrade evidence; event-bridge is a 4th-priority durable authority).

const mod = await import('file://' + new URL('../lib/orchestrator.js', import.meta.url).pathname);

await test('mergeEvidenceSources: monotonic downgrade protection', () => {
  const durable = {
    source: 'sidecar',
    observations: [{ id: 'A' }, { id: 'B' }],
    latestObservation: { id: 'A', metric: 10 },
    recoveryProof: { status: 'recovered', at: 't1' },
    cleanupProof: { status: 'ok', at: 't1' },
    runtimeRecovered: true,
  };
  const current = {
    source: 'current',
    observations: [],
    latestObservation: null,
    recoveryProof: { status: 'unknown' },
    cleanupProof: null,
    runtimeRecovered: false,
  };
  const merged = mod.mergeEvidenceSources([durable, current]);
  assert(merged.observations.length === 2, 'observations must survive downgrade');
  assert(merged.recoveryProof.status === 'recovered', 'recovery proof must survive downgrade');
  assert(merged.cleanupProof.status === 'ok', 'cleanup proof must survive downgrade');
  assert(merged.runtimeRecovered === true, 'runtimeRecovered must survive downgrade');
  assert(merged.latestObservation.metric === 10, 'latest measurement must survive downgrade');
});

await test('mergeEvidenceSources: priority order (archive > bridge) wins ties', () => {
  const archive = { source: 'archive-md', observations: [{ id: 'A', value: 1 }], recoveryProof: { status: 'recovered', at: 't1' }, runtimeRecovered: true };
  const bridge = { source: 'event-bridge', observations: [{ id: 'A', value: 2 }, { id: 'B', value: 3 }], recoveryProof: { status: 'recovered', at: 't2' }, runtimeRecovered: true };
  const merged = mod.mergeEvidenceSources([archive, bridge]);
  const a = merged.observations.find((o) => o.id === 'A');
  assert(a && a.value === 1, 'archive (higher priority) must win ties');
  assert(merged.observations.length === 2, 'bridge enriches missing observations');
  assert(merged.recoveryProof.at === 't1', 'higher-priority proof timestamp wins');
});

await test('mergeEvidenceSources: upgrade path (unknown -> recovered)', () => {
  const old = { source: 'archive-md', observations: [], recoveryProof: { status: 'unknown' }, runtimeRecovered: false };
  const fresh = { source: 'event-bridge', observations: [{ id: 'C' }], recoveryProof: { status: 'recovered' }, runtimeRecovered: true };
  const merged = mod.mergeEvidenceSources([old, fresh]);
  assert(merged.recoveryProof.status === 'recovered', 'recovery proof upgrades to recovered');
  assert(merged.runtimeRecovered === true, 'runtimeRecovered upgrades to true');
  assert(merged.observations.length === 1, 'bridge observation added');
});

await test('mergeEvidenceSources: no sources returns null', () => {
  assert(mod.mergeEvidenceSources([]) === null, 'empty sources -> null');
  assert(mod.mergeEvidenceSources([null, undefined]) === null, 'null sources -> null');
});

await test('mergeEvidenceSources: metadata identity passes through in priority order', () => {
  const journal = { source: 'journal', observations: [], durable: { pluginName: 'p-journal' }, canary: { startupVerified: true } };
  const bridge = { source: 'event-bridge', observations: [], durable: { pluginName: 'p-bridge' } };
  const merged = mod.mergeEvidenceSources([journal, bridge]);
  assert(merged.durable.pluginName === 'p-journal', 'journal durable identity wins');
  assert(merged.canary.startupVerified === true, 'canary carried');
});