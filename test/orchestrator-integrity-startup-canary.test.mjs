// P2-11: the startup canary barrier must be awaited by every concurrent
// pre-step, and a failed verification must be retryable instead of being
// recorded as already checked.
import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../lib/registration.js';

function fixture() {
  const listeners = new Map();
  const ctx = {
    dynamicCordisRunner: {},
    tools: { register: () => {} },
    systemPrompt: { section: () => {} },
    on: (event, listener) => listeners.set(event, listener),
    logger: { warn: () => {} },
  };
  const core = apply(ctx, { startupDrift: false, memory: {}, eventBridge: {} });
  return { core, listeners, preStep: listeners.get('agent/pre-step') };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const agent = { id: 'startup-canary-agent' };
const wait = () => new Promise((resolve) => setImmediate(resolve));

test('a second concurrent pre-step waits for the startup canary instead of skipping it', async () => {
  const { core, preStep } = fixture();
  const calls = [];
  const gate = deferred();
  core.verifyStartupCanary = async (who) => { calls.push(who.id); return gate.promise; };

  const steps = [];
  const first = preStep({ agent }, () => steps.push('first'));
  const second = preStep({ agent }, () => steps.push('second'));
  await wait();
  assert.deepEqual(calls, [agent.id], 'the verification is shared, not duplicated');
  assert.deepEqual(steps, [], 'neither step continues while the canary is being verified');

  gate.resolve({ status: 'none' });
  await Promise.all([first, second]);
  assert.deepEqual(steps.sort(), ['first', 'second'], 'both steps continue only after the barrier settles');
  assert.deepEqual(calls, [agent.id], 'the settled check is not repeated');
});

test('a failed startup canary is retried by the next pre-step', async () => {
  const { core, preStep } = fixture();
  let attempts = 0;
  core.verifyStartupCanary = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('canary verification failed');
    return { status: 'verified' };
  };

  await assert.rejects(preStep({ agent }, () => {}), /canary verification failed/);
  assert.equal(attempts, 1);

  let continued = false;
  await preStep({ agent }, () => { continued = true; });
  assert.equal(attempts, 2, 'a failure does not mark the startup check as done');
  assert.equal(continued, true);
});
