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

// ---------------------------------------------------------------------------
// tools/result: official emit, contained observation, redacted diagnostics
// ---------------------------------------------------------------------------

const SECRET = 'hunter2-tools-result-secret';
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** The official result shape: already frozen before the emit is dispatched. */
function frozenToolResult(text = `tool output password=${SECRET}`) {
  return Object.freeze({ isError: true, code: 'TOOL_FAILED', content: Object.freeze([Object.freeze({ type: 'text', text })]) });
}

test('tools/result is an emit: the listener returns nothing the registry could use', async () => {
  const observed = [];
  const { core, listeners } = fixture({ mode: 'autonomous' });
  core.observeAutonomous = async (observation, options) => { observed.push({ observation, options }); };
  const exec = { agent: { id: 'a' }, name: 'bash', callId: 'c-emit' };
  // `dsh-tools` `notifyResult()` dispatches this with `events.dispatch('emit', …)`
  // and no `next` argument, so a listener's return value is never consumed. The
  // listener therefore returns `undefined`, exactly like the agent/error one.
  assert.equal(listeners.get('tools/result')(exec, frozenToolResult()), undefined);
  await tick();
  assert.equal(observed.length, 1);
  assert.equal(observed[0].observation.code, 'TOOL_FAILED');
  assert.equal(observed[0].observation.message, 'Official operation failed (TOOL_FAILED)');
  // The raw tool text stays on the host side of the boundary.
  assert.equal(JSON.stringify(observed[0].observation).includes(SECRET), false);
});

test('tools/result still ignores non-errors and the plugin\'s own tools', async () => {
  const observed = [];
  const { core, listeners } = fixture({ mode: 'autonomous' });
  core.observeAutonomous = async () => { observed.push(1); };
  const exec = { agent: { id: 'a' }, name: 'bash', callId: 'c-guard' };
  listeners.get('tools/result')(exec, Object.freeze({ isError: false, code: 'OK', content: Object.freeze([]) }));
  listeners.get('tools/result')({ ...exec, name: 'evolution_propose' }, frozenToolResult());
  await tick();
  assert.equal(observed.length, 0);
});

test('a throwing tools/result domain write is contained, redacted, and still short-circuits', async () => {
  const warnings = [];
  const domainStorage = {
    observe() { throw new Error(`domain observe failed: password=${SECRET}`); },
    query: () => null,
    flush: () => null,
  };
  const { core, listeners } = fixture({ mode: 'autonomous', domainStorage });
  core.ctx.logger.warn = (warning) => warnings.push(warning);
  const observed = [];
  core.observeAutonomous = async () => { observed.push(1); };
  const exec = { agent: { id: 'a' }, name: 'bash', callId: 'c-store' };
  const result = frozenToolResult();
  assert.equal(listeners.get('tools/result')(exec, result), undefined);
  await tick();
  await tick();
  // The plugin's own diagnostic is the redacted DTO, not the thrown text.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\[evolution\] tool result observer failed/);
  assert.match(warnings[0], /password=\[redacted\]/);
  assert.equal(warnings[0].includes(SECRET), false);
  assert.match(warnings[0], /sha256:[0-9a-f]{16}/, 'the digest keeps distinct failures distinct');
  // Order and short-circuit are unchanged: the domain write still runs first,
  // so a failing one stops before the autonomous observer.
  assert.equal(observed.length, 0);
  assert.equal(result.code, 'TOOL_FAILED', 'the original result is never replaced');
  assert.equal(Object.isFrozen(result), true);
});

test('a rejecting tools/result observer is contained and logged as a redacted DTO', async () => {
  const warnings = [];
  const { core, listeners } = fixture({ mode: 'autonomous' });
  core.ctx.logger.warn = (warning) => warnings.push(warning);
  core.observeAutonomous = async () => { throw new Error(`observer failed: api_key=${SECRET}`); };
  const exec = { agent: { id: 'a' }, name: 'bash', callId: 'c-observer' };
  assert.equal(listeners.get('tools/result')(exec, frozenToolResult()), undefined);
  await tick();
  await tick();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\[evolution\] tool result observer failed/);
  assert.match(warnings[0], /api_key=\[redacted\]/);
  assert.equal(warnings[0].includes(SECRET), false);
});

test('a throwing or rejecting logger cannot turn the observer diagnostic into a failure', async () => {
  // The diagnostic itself is a foreign call (`ctx.logger.warn`) on the failure
  // path: a logger that throws, or one that returns a rejected promise, must not
  // raise from the observer and must not leave an unhandled rejection — this
  // test fails through the runner's unhandled-rejection handling if it does.
  const loggers = [
    { name: 'throwing', warn() { throw new Error(`logger failed: token=${SECRET}`); } },
    { name: 'rejecting', warn() { return Promise.reject(new Error(`logger failed: token=${SECRET}`)); } },
    { name: 'unreachable getter', get warn() { throw new Error(`logger failed: token=${SECRET}`); } },
  ];
  for (const logger of loggers) {
    const { core, listeners } = fixture({ mode: 'autonomous' });
    core.ctx.logger = logger;
    core.observeAutonomous = async () => { throw new Error('observer failure'); };
    const exec = { agent: { id: 'a' }, name: 'bash', callId: 'c-logger' };
    assert.equal(listeners.get('tools/result')(exec, frozenToolResult()), undefined, logger.name);
    await tick();
    await tick();
    await tick();
  }
});
