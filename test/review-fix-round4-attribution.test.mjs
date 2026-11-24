// Round-4 experience-attribution regressions. The official agent loop ends an
// aborted/error turn without `agent/turn-stopping`, reuses callIds across PTC
// execution objects, and emits cancelled tool results. All three used to
// corrupt the durable cost/failure signal used by planning.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';

import { apply as applyCollector } from '../lib/experience-collector.js';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'round4-attribution-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function collector(t) {
  const app = new Context();
  app.provide('tools', { register() {} });
  const fiber = app.plugin(applyCollector, { dshHome: temporary(t) });
  await fiber.await();
  t.after(() => fiber.dispose());
  return app;
}

const truncatedRead = {
  isError: false,
  value: { path: '/tmp/generated.json', offset: 1, lines: [{ number: 1, text: `${'x'.repeat(2000)}... (line truncated to 2000 chars)` }], totalLines: 1 },
};
const success = { isError: false, value: { exitCode: 0 } };

test('an aborted turn closes pending degradations before an unrelated later success', async (t) => {
  const app = await collector(t);
  const agent = { id: 'agent-after-abort' };
  app.emit('tools/result', { agent, name: 'read', callId: 'loss-1' }, truncatedRead);
  // The official loop emits agent/error on both abort and error, but no
  // turn-stopping. Without the flush on agent/error this loss stays pending.
  app.emit('agent/error', { agent, error: new Error('turn aborted') });
  app.emit('tools/result', { agent, name: 'bash', callId: 'unrelated-success' }, success);

  const store = app.get('evolutionExperience').store;
  const losses = store.discover().records.filter((row) => row.issueType === 'tool degradation');
  assert.equal(losses.length, 1);
  assert.deepEqual(losses.map((row) => [row.occurrences, row.recoveryTool, row.metrics.recoverycalls?.sum ?? 0]), [
    [1, '', 0],
  ], 'a later unrelated success must not be credited as recovery of an aborted turn');
});

test('the official cancellation turn boundary closes pending degradations', async (t) => {
  // The official agent loop emits neither agent/turn-stopping nor agent/error
  // when a turn is cancelled; the aborted tool result is its observable end.
  const app = await collector(t);
  const agent = { id: 'agent-official-cancel' };
  app.emit('tools/result', { agent, name: 'read', callId: 'loss-before-cancel' }, truncatedRead);
  app.emit('tools/result', { agent, name: 'bash', callId: 'cancelled-tool',
    signal: { aborted: true } }, { isError: true, error: { info: { code: 'ABORTED' } } });
  app.emit('tools/result', { agent, name: 'bash', callId: 'later-unrelated' }, success);
  const losses = app.get('evolutionExperience').store.discover().records.filter((row) => row.issueType === 'tool degradation');
  assert.equal(losses.length, 1);
  assert.deepEqual(losses.map((row) => [row.occurrences, row.recoveryTool, row.metrics.recoverycalls?.sum ?? 0]), [[1, '', 0]]);
});

test('a reused callId does not swallow separate real degradations', async (t) => {
  const app = await collector(t);
  const agent = { id: 'agent-ptc-reuse' };
  for (let n = 0; n < 3; n += 1) {
    // A fresh execution object with the same callId models three PTC envelopes.
    app.emit('tools/result', { agent, name: 'read', callId: 'SAME-ID' }, truncatedRead);
    app.emit('tools/result', { agent, name: 'bash', callId: `recovery-${n}` }, success);
  }
  const store = app.get('evolutionExperience').store;
  const losses = store.discover().records.filter((row) => row.issueType === 'tool degradation');
  assert.equal(store.stats().events, 3, 'three real degradations must all be committed');
  assert.deepEqual(losses.map((row) => row.occurrences), [3], 'all three observations aggregate into one canonical loss');
});

test('cancelled tool results do not become failure facts or phantom candidates', async (t) => {
  const app = await collector(t);
  const agent = { id: 'agent-cancelled' };
  for (let n = 0; n < 3; n += 1) {
    app.emit('tools/result', { agent, name: 'read', callId: `abort-${n}` }, {
      isError: true, error: { info: { code: 'ABORTED_BEFORE_DISPATCH' } },
    });
  }
  app.emit('agent/turn-stopping', { agent });
  const store = app.get('evolutionExperience').store;
  const records = store.discover().records;
  assert.equal(records.some((row) => row.issueType === 'problem' && row.failureCount > 0), false,
    `a cancelled run is not a failure fact, got ${JSON.stringify(records.map((row) => [row.issueType, row.failureCount]))}`);
  assert.equal(store.stats().events, 0);
});
