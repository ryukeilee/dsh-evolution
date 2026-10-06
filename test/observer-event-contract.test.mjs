import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/registration.js';

function fixture(config = {}) {
  const listeners = new Map();
  const ctx = {
    dynamicCordisRunner: {},
    tools: { register: () => {} },
    systemPrompt: { section: () => {} },
    on: (event, listener) => listeners.set(event, listener),
    logger: { warn: () => {} },
  };
  const core = apply(ctx, { startupDrift: false, memory: {}, eventBridge: {}, ...config });
  return { core, listeners };
}

test('mode=autonomous subscribes to the official emit event without a next callback', async () => {
  const { core, listeners } = fixture({ mode: 'autonomous' });
  const observations = [];
  core.observeAutonomous = async (...args) => observations.push(args);
  const agent = { id: 'real-contract-shaped-agent' };
  assert.equal(listeners.get('agent/error')({ agent, error: new Error('failed') }), undefined);
  await Promise.resolve();
  assert.equal(observations.length, 1);
  assert.equal(observations[0][0].message, 'failed');
  assert.equal(observations[0][1].agent, agent);
});

test('async agent observer rejection is contained and recorded', async () => {
  const warnings = [];
  const { core, listeners } = fixture({ mode: 'autonomous' });
  core.ctx.logger.warn = warning => warnings.push(warning);
  core.observeAutonomous = async () => { throw new Error('observer failure'); };
  listeners.get('agent/error')({ agent: { id: 'a' }, error: 'original error' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /observer failure/);
});

test('advisory observation is opt-in, preserving passive default behavior', () => {
  assert.equal(fixture().listeners.has('agent/error'), false);
  assert.equal(fixture({ mode: 'advisory', observe: true }).listeners.has('agent/error'), true);
});
