// Tool-surface boundaries closed in the quality round.
//
// Each case drives a registered tool or a listener through the real code path and
// asserts on what the caller (or the host's session record) receives:
//
//   * `evolution_maintain` used to return `{"$class":"Promise"}` and turn the
//     reclaim confirmation refusal into an unhandled rejection, because its
//     `execute` returned the async `reclaim()` without awaiting it;
//   * `tools/result` put the whole host execution context into the observation
//     input, so the session object reached the observation stream, `inspect` and
//     the durable failure memory;
//   * a thrown tool error reached the host (and therefore the session record and
//     every later request) with its original message, including text that did not
//     originate in this plugin;
//   * an `agent/error` payload whose property read throws could escape
//     synchronously out of an `emit` listener.
import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../lib/registration.js';

function mount(config = {}) {
  const tools = new Map();
  const listeners = new Map();
  const warnings = [];
  const ctx = {
    dynamicCordisRunner: {},
    tools: { register: (definition) => tools.set(definition.name, definition) },
    systemPrompt: { section: () => {} },
    on: (event, listener) => listeners.set(event, listener),
    logger: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
  };
  const core = apply(ctx, { startupDrift: false, memory: {}, eventBridge: {}, ...config });
  return { core, tools, listeners, warnings, ctx };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const exec = { agent: { id: 'owner' }, signal: new AbortController().signal };

function domainStorage(overrides = {}) {
  return {
    reclaim: async (options) => {
      if (options.dryRun !== true && options.confirmation !== true) {
        const error = new Error('E_DOMAIN_RECLAIM_CONFIRMATION: confirmation required');
        error.code = 'E_DOMAIN_RECLAIM_CONFIRMATION';
        throw error;
      }
      return { ok: true, dryRun: options.dryRun === true, archives: { records: 3 }, log: { bytes: 4096 } };
    },
    flush: async () => ({ applied: 0 }),
    query: () => ({ rows: [] }),
    observe: async () => {},
    ...overrides,
  };
}

async function unhandledRejections(run) {
  const seen = [];
  const listener = (reason) => seen.push(reason);
  process.on('unhandledRejection', listener);
  try { await run(); } finally {
    await tick();
    process.off('unhandledRejection', listener);
  }
  return seen;
}

test('evolution_maintain awaits the reclaim and reports its real result', async (t) => {
  const rejections = await unhandledRejections(async () => {
    const { tools } = mount({ domainStorage: domainStorage() });
    const maintain = tools.get('evolution_maintain');
    const dry = await maintain.execute({ dryRun: true }, exec);
    assert.deepEqual(dry, { ok: true, dryRun: true, archives: { records: 3 }, log: { bytes: 4096 } });
    const real = await maintain.execute({ confirmation: true }, exec);
    assert.equal(real.dryRun, false, 'the awaited result is the reclaim report, not a promise projection');
  });
  assert.equal(rejections.length, 0);
});

test('a refused reclaim is a tool error, never an unhandled rejection', async (t) => {
  let caught = null;
  const rejections = await unhandledRejections(async () => {
    const { tools } = mount({ domainStorage: domainStorage() });
    caught = await tools.get('evolution_maintain').execute({}, exec).catch((error) => error);
  });
  assert.ok(caught instanceof Error, 'the caller receives the refusal');
  assert.equal(caught.code, 'E_DOMAIN_RECLAIM_CONFIRMATION');
  assert.match(caught.message, /confirmation required/);
  assert.equal(rejections.length, 0, 'the refusal is handled exactly once, by the caller');
});

test('the tools/result observation carries no host execution context', async () => {
  const { core, listeners } = mount({ mode: 'autonomous' });
  const observed = [];
  core.observeAutonomous = async (input) => { observed.push(structuredClone(input)); };
  core.domainStorage = undefined;
  const agent = {
    id: 'agent-1',
    session: { title: 'PRIVATE user question', transcript: ['private transcript'] },
    options: { userText: 'private prompt' },
  };
  listeners.get('tools/result')({ agent, name: 'bash', callId: 'call-1' }, Object.freeze({ isError: true, code: 'TOOL_FAILED', content: Object.freeze([]) }));
  await tick();
  assert.equal(observed.length, 1);
  assert.deepEqual(Object.keys(observed[0]).sort(), ['code', 'errorDigest', 'message', 'target', 'type']);
  assert.equal(JSON.stringify(observed[0]).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(observed[0]).includes('private prompt'), false);
});

test('a thrown tool error reaches the host redacted, with its classification', async () => {
  const SECRET = 'synthetic-credential-value';
  const core = mount({ domainStorage: domainStorage({
    flush: async () => { throw new Error(`domain flush failed: password=${SECRET} token=${SECRET}`); },
  }) });
  const error = await core.tools.get('evolution_history').execute({}, exec).catch((thrown) => thrown);
  assert.ok(error instanceof Error);
  assert.equal(String(error.message).includes(SECRET), false, 'the credential never reaches the tool result');
  assert.match(error.message, /domain flush failed/);
  assert.match(error.errorDigest, /^sha256:[0-9a-f]{16}$/);
  assert.equal(error.errorCategory, 'cleanup-or-rollback', 'the flush failure is classified as the cleanup it is');
});

test('a throwing payload read cannot escape the agent/error listener', async () => {
  const { core, listeners } = mount({ mode: 'autonomous' });
  const observed = [];
  core.observeAutonomous = async () => { observed.push(1); };
  const payload = {
    agent: { id: 'agent-1' },
    get error() { throw new Error('payload read failed'); },
  };
  // An `emit` listener's return value is ignored; the point is that the call does
  // not throw into the host that is already reporting an agent error.
  assert.equal(listeners.get('agent/error')(payload), undefined);
  await tick();
  assert.equal(observed.length, 0);
});
