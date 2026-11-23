// The real-model transport is what makes "did the model choose the capability?"
// measurable, so its failure behavior has to be honest: a reply that is not a
// decision is a failed turn, never an empty stop. These tests drive the bridge
// over HTTP with a stub runner; no model is called.
import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildDecisionPrompt, parseDecision, runOpencodeTurn, startModelBridge, usageTotals } from '../scripts/acceptance/model-bridge.mjs';

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

test('a malformed reply is retried once and the retry cost is counted', async (t) => {
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return calls === 1
      ? { ok: true, text: 'I cannot decide.', usage: { input: 9, output: 3, cache: { read: 1 } }, wallMs: 4 }
      : { ok: true, text: '{"tool":"read","arguments":{"file_path":"retry.json"}}', usage: { input: 7, output: 2, cache: { read: 5 } }, wallMs: 6 };
  };
  const bridge = await startModelBridge({ runner });
  t.after(() => bridge.close());
  const result = await post(bridge);
  assert.equal(result.status, 200);
  assert.equal(calls, 2);
  assert.equal(bridge.turns.length, 1);
  assert.equal(bridge.turns[0].ok, true);
  assert.equal(bridge.turns[0].retries, 1);
  assert.deepEqual(usageTotals(bridge.turns), { inputTokens: 16, outputTokens: 5, cacheReadTokens: 6, turns: 1, unknownTurns: 0 });
});

test('an own-tool turn is not retried into a clean decision', async (t) => {
  let calls = 0;
  const bridge = await startModelBridge({
    runner: async () => {
      calls += 1;
      return calls === 1
        ? { ok: true, text: '{"tool":"read","arguments":{}}', ownToolCalls: 1, usage: { input: 3, output: 1 }, wallMs: 2 }
        : { ok: true, text: '{"tool":"read","arguments":{}}', usage: { input: 3, output: 1 }, wallMs: 2 };
    },
  });
  t.after(() => bridge.close());
  const result = await post(bridge);
  assert.equal(result.status, 502);
  assert.match(result.text, /pilot-used-own-tools/);
  assert.equal(calls, 1);
  assert.equal(bridge.turns[0].retries, 0);
});

test('a non-zero exit after partial text is a process failure, not a parseable reply', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-fake-opencode-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'opencode'),
    '#!/bin/sh\nprintf \'%s\\n\' \'{"type":"text","part":{"text":"{\\"tool\\":\\"read\\"}"}}\'\nexit 1\n',
    { mode: 0o755 });
  const result = await runOpencodeTurn('prompt', {
    model: 'test/model',
    cwd: dir,
    env: { ...process.env, PATH: dir + path.delimiter + (process.env.PATH ?? '') },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'model-process-failed');
  assert.equal(result.code, 1);
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
