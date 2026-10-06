import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectRuntime } from '../lib/orchestrator.js';

function context(implementation) {
  return {
    registry: { values: () => [] },
    reflect: { props: { scoped: { type: 'service' } }, _getImpl: () => implementation },
    events: { _hooks: {} },
    tools: { schemas: () => [] },
    get: () => ({ list: () => [] }),
  };
}
const runner = { snapshot: () => [] };
test('unbound scope declaration is not reported as an unknown live owner', () => {
  const result = inspectRuntime(context(undefined), { id: 'test' }, runner);
  assert.deepEqual(result.services, []);
  assert.deepEqual(result.recoveryProof.unknown, []);
});
test('bound service without a fiber still fails closed', () => {
  const result = inspectRuntime(context({ value: {} }), { id: 'test' }, runner);
  assert.deepEqual(result.recoveryProof.unknown, ['service-owner:scoped']);
});
test('inspect the agent scope rather than the profile scope', () => {
  const scoped = context({ fiber: { name: 'scope-provider', uid: 42, state: 'active' } });
  const result = inspectRuntime(context(undefined), { id: 'test', ctx: scoped }, runner);
  assert.equal(result.services[0].owner.name, 'scope-provider');
});
