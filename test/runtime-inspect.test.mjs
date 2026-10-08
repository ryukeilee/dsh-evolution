import test from 'node:test';
import assert from 'node:assert/strict';
import { EvolutionOrchestrator, runtimeSignature, toLosslessJson } from '../lib/orchestrator.js';
import { apply } from '../lib/registration.js';
import { context, config, legacyInspect, populate } from './fixtures/runtime-inspect.mjs';

const agent = { id: 'fixture-agent' };
function fixture() { return new EvolutionOrchestrator(context(), config); }

test('full inspect output matches the original boundary and stays detached', () => {
  const core = fixture();
  populate(core);
  assert.deepEqual(core.inspect(agent), legacyInspect(core, agent));
  const snapshot = core.inspect(agent);
  snapshot.tools[0].parameters.properties.value.type = 'number';
  snapshot.evolutionObservations[0].input.tags.push('changed');
  snapshot.evolutionCandidates[0].strategy.target = 'changed';
  assert.equal(core.ctx.schema.properties.value.type, 'string');
  assert.deepEqual(core.observations[0].input.tags, ['a', 'b']);
  assert.equal(core.candidates.get('0').strategy.target, 'component-0');
  assert.deepEqual(core.inspect(agent), legacyInspect(core, agent));
});

test('snapshot exceptional values preserve clone then projection semantics', () => {
  class Custom { constructor() { this.value = 1; } }
  const shared = { nested: { value: 1 } };
  const cycle = {}; cycle.self = cycle;
  const sparse = new Array(3); sparse[1] = undefined;
  const extra = [1]; extra.extra = { value: 2 };
  const values = [undefined, NaN, Infinity, -Infinity, -0, 12n, new Date(0),
    new Error('fixture'), new Map([['a', shared]]), new Set([shared]),
    new Custom(), /test/g, new Uint8Array([1, 2]), cycle, { a: shared, b: shared },
    sparse, extra, Object.assign(Object.create(null), { value: undefined }),
    JSON.parse('{"__proto__":{"value":1}}')];
  for (const value of values) {
    const core = fixture();
    core.observations = [value];
    core.candidates.set('value', value);
    assert.deepEqual(core.inspect(agent), legacyInspect(core, agent));
  }
  for (const value of [() => {}, Symbol('fixture'), new WeakMap(), new Date(NaN), new Proxy({}, {})]) {
    const core = fixture(); core.observations = [value];
    let expected;
    try { legacyInspect(core, agent); } catch (error) { expected = error; }
    assert.ok(expected);
    assert.throws(() => core.inspect(agent), { name: expected.name, message: expected.message });
  }
});

test('fallback reads accessors once and retains alias isolation', () => {
  const core = fixture();
  let reads = 0;
  const value = { get changing() { reads++; return reads; } };
  core.observations = [{ a: value, b: value }];
  const snapshot = core.inspect(agent);
  assert.equal(reads, 1);
  assert.deepEqual(snapshot.evolutionObservations, [{ a: { changing: 1 }, b: { changing: 1 } }]);
  assert.notEqual(snapshot.evolutionObservations[0].a, snapshot.evolutionObservations[0].b);
});

test('registered inspect projects once and proposal retains the complete detached baseline', async () => {
  const ctx = context(); const core = apply(ctx, config); populate(core);
  const expected = legacyInspect(core, agent);
  const inspect = core.inspect.bind(core);
  let returned;
  core.inspect = owner => (returned = inspect(owner));
  const output = await ctx.definitions.get('evolution_runtime_inspect').execute({}, { agent });
  assert.equal(output, returned);
  assert.deepEqual(output, expected);
  const proposal = await ctx.definitions.get('evolution_propose').execute({
    why: 'fixture', target: 'fixture', impactScope: ['fixture'], successMetrics: ['cpu'],
  }, { agent });
  const baseline = core.experiments.get(proposal.experimentId).baseline;
  assert.deepEqual(baseline, expected);
  assert.deepEqual(proposal.baseline, JSON.parse(JSON.stringify(runtimeSignature(expected))));
  core.observations[0].input.code = 'changed';
  output.evolutionCandidates[0].risk = 'high';
  assert.equal(baseline.evolutionObservations[0].input.code, 'FIXTURE');
  assert.equal(baseline.evolutionCandidates[0].risk, 'low');
});

test('registered inspect retains the legacy projection for unusual object prototypes', async () => {
  const ctx = context(); const core = apply(ctx, config);
  core.observations = [JSON.parse('{"__proto__":{"value":1}}')];
  const expected = toLosslessJson(legacyInspect(core, agent));
  const output = await ctx.definitions.get('evolution_runtime_inspect').execute({}, { agent });
  assert.deepEqual(output, expected);
  const error = new Error('fixture');
  error.name = {}; error.name.self = error.name;
  ctx.schema.error = error;
  assert.deepEqual(await ctx.definitions.get('evolution_runtime_inspect').execute({}, { agent }),
    toLosslessJson(legacyInspect(core, agent)));
});
