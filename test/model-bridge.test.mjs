// The real-model transport is what makes "did the model choose the capability?"
// measurable, so its failure behavior has to be honest: a reply that is not a
// decision is a failed turn, never an empty stop. These tests drive the bridge
// over HTTP with a stub runner; no model is called.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDecisionPrompt, parseDecision, startModelBridge, usageTotals } from '../scripts/acceptance/model-bridge.mjs';

const REQUEST = {
  system: 'You are a coding agent.',
  tools: [{ name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: { file_path: { type: 'string', description: 'Path.' } }, required: ['file_path'] } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Read the config.' }] }],
};

async function post(bridge, body = REQUEST) {
  const response = await fetch(`${bridge.baseURL}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text };
}

test('parseDecision returns the first balanced object and never guesses', () => {
  assert.deepEqual(parseDecision('{"tool":"read","arguments":{"file_path":"a}b"}}'), {
    ok: true, value: { tool: 'read', arguments: { file_path: 'a}b' } },
  });
  assert.equal(parseDecision('The sentinel is end-of-config.').ok, false);
  assert.equal(parseDecision('sure: {"tool":"read"').ok, false);
  assert.equal(parseDecision('not json at all').reason, 'reply-has-no-object');
});

test('the prompt carries the live tools and the task but names no tool or argument', () => {
  const prompt = buildDecisionPrompt(REQUEST);
  assert.match(prompt, /- read: Read a file\./);
  assert.match(prompt, /Read the config\./);
  assert.match(prompt, /Reply with exactly one JSON object/);
});

test('an unparseable reply is a failed turn with an error status', async (t) => {
  const bridge = await startModelBridge({ runner: async () => ({ ok: true, text: 'I think you should read the file.', usage: { input: 5, output: 7 }, wallMs: 3 }) });
  t.after(() => bridge.close());
  const result = await post(bridge);
  assert.equal(result.status, 502);
  assert.match(result.text, /reply-has-no-object/);
  assert.equal(bridge.turns.length, 1);
  assert.equal(bridge.turns[0].ok, false);
  assert.equal(bridge.turns[0].reason, 'reply-has-no-object');
});

test('a decision with an unusable shape is a failed turn, not an empty stop', async (t) => {
  const bridge = await startModelBridge({ runner: async () => ({ ok: true, text: '{"tool":"read","arguments":"nope"}', usage: null, wallMs: 3 }) });
  t.after(() => bridge.close());
  const result = await post(bridge);
  assert.equal(result.status, 502);
  assert.match(result.text, /decision-shape-invalid/);
  assert.equal(bridge.turns[0].ok, false);
});

test('a model process failure is reported instead of an empty answer', async (t) => {
  const bridge = await startModelBridge({ runner: async () => ({ ok: false, reason: 'model-process-failed', wallMs: 9 }) });
  t.after(() => bridge.close());
  const result = await post(bridge);
  assert.equal(result.status, 502);
  assert.match(result.text, /model-process-failed/);
  assert.equal(bridge.turns[0].ok, false);
});

test('a real decision is streamed back with its measured usage', async (t) => {
  const runner = async () => ({ ok: true, text: '{"tool":"read","arguments":{"file_path":"workflow-generated.json"}}', usage: { input: 11, output: 4, cache: { read: 2 } }, wallMs: 7 });
  const bridge = await startModelBridge({ runner });
  t.after(() => bridge.close());
  const result = await post(bridge);
  assert.equal(result.status, 200);
  assert.match(result.text, /"tool_use"/);
  assert.match(result.text, /workflow-generated\.json/);
  assert.equal(bridge.turns[0].ok, true);
  assert.deepEqual(bridge.turns[0].decision, { tool: 'read', arguments: { file_path: 'workflow-generated.json' } });
  assert.equal(bridge.turns[0].tools.includes('read'), true, 'the turn records the live tool list it was offered');
  assert.deepEqual(usageTotals(bridge.turns), { inputTokens: 11, outputTokens: 4, cacheReadTokens: 2, turns: 1, unknownTurns: 0 });
});
