#!/usr/bin/env node
/** Real ACP stdio + official Agent/tool pipeline. The loopback Anthropic
 * transport supplies deterministic model responses; it does not emit or mock
 * agent/error or tools/result. No external model or user credential is used.
 * Requires an isolated, prepared home (setup-experience.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { openSharedExperience } from '../../lib/shared-experience.js';

const [cli, homeArgument, outArgument] = process.argv.slice(2);
if (!cli || !homeArgument || !outArgument) throw new Error('Usage: run-acp-experience.mjs <official-cli> <isolated-home> <evidence.json>');
const home = path.resolve(homeArgument);
if (home === path.resolve(process.env.HOME || '', '.dsh')) throw new Error('Refusing the formal DSH_HOME');
const out = path.resolve(outArgument);
const requests = [];
let tools = [];
let stage = -1;
let historyResult = null;
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const input = JSON.parse(body);
  tools = input.tools || [];
  requests.push({ bytes: Buffer.byteLength(body), toolSchemaBytes: Buffer.byteLength(JSON.stringify(tools)),
    historySchemas: tools.filter(tool => tool.name === 'evolution_history').length });
  if (stage === -1) {
    stage = 0;
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Isolated acceptance provider failure' } }));
    return;
  }
  if (stage === 3) {
    const result = input.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .find(block => block.type === 'tool_result' && block.tool_use_id === 'fixture-call-2');
    const content = typeof result?.content === 'string' ? result.content : result?.content?.filter(block => block.type === 'text').map(block => block.text).join('');
    if (content) {
      try {
        const value = JSON.parse(content);
        historyResult = { sources: value.sources, failures: value.failures?.length };
      } catch {}
    }
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', { message: { id: `fixture-${stage}`, type: 'message', role: 'assistant', model: 'deepseek-v4-flash',
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
  if (stage === 0 || stage === 2) {
    const tool = stage === 0 ? tools.find(tool => /read.*file|file.*read|^read$/.test(tool.name)) : tools.find(tool => tool.name === 'evolution_history');
    if (!tool) { res.destroy(new Error('Required real tool unavailable')); return; }
    const args = stage === 0 ? Object.fromEntries(Object.keys(tool.input_schema.properties || {}).filter(key => /path/.test(key)).map(key => [key, path.join(home, 'definitely-missing.txt')]))
      : { query: 'agent', target: 'agent' };
    send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `fixture-call-${stage}`, name: tool.name, input: {} } });
    send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } });
    send('content_block_stop', { index: 0 });
    send('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } });
  } else {
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Acceptance finished.' } });
    send('content_block_stop', { index: 0 });
    send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
  }
  stage++;
  send('message_stop', {}); res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const overlay = path.join(home, 'acp-experience-transport.yml');
fs.writeFileSync(overlay, `- id: llm-deepseek\n  config:\n    baseURL: http://127.0.0.1:${server.address().port}\n    apiKeyEnv: EVOLUTION_ACCEPTANCE_KEY\n`);
const child = spawn(cli, ['--profile', 'acp', '--patch', overlay], {
  cwd: home, env: { ...process.env, DSH_HOME: home, EVOLUTION_ACCEPTANCE_KEY: 'local-fixture-only' }, stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map();
const updates = [];
let stderr = '';
child.stderr.on('data', value => { stderr += value; });
readline.createInterface({ input: child.stdout }).on('line', line => {
  let row; try { row = JSON.parse(line); } catch { return; }
  if (row.id !== undefined && pending.has(row.id)) { const resolve = pending.get(row.id); pending.delete(row.id); resolve(row); }
  else if (row.method === 'session/update') {
    // Keep only event kinds and fixture-owned tool names, never session text.
    updates.push(row.params?.update?.sessionUpdate);
  }
});
let sequence = 0;
function rpc(method, params) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 30000);
    pending.set(id, row => { clearTimeout(timer); row.error ? reject(new Error(`${method}: ${JSON.stringify(row.error)}`)) : resolve(row.result); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
const start = performance.now();
let evidence;
try {
  await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const { sessionId } = await rpc('session/new', { cwd: home, mcpServers: [] });
  let failedPrompt = false;
  try { await rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Exercise a provider failure.' }] }); }
  catch { failedPrompt = true; }
  if (!failedPrompt) throw new Error('Expected real provider failure was not observed');
  const first = await rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Read the missing acceptance file.' }] });
  const second = await rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Recall shared agent experience.' }] });
  const store = openSharedExperience(path.join(home, 'storages', 'evolution-experience'));
  const stats = store.stats();
  const recall = store.recall({ problem: 'agent', target: 'agent' });
  store.close();
  if (requests.length !== 5 || requests.some(row => row.historySchemas !== 1)) throw new Error('Unexpected model rounds or duplicate/missing history schema');
  if (!historyResult?.sources?.some(source => source.source === 'shared-knowledge' && source.available) || !historyResult.failures) throw new Error('Shared recall through the actual ACP history tool not proven');
  if (stats.events < 2 || !updates.includes('tool_call')) throw new Error('Real tool pipeline collection not proven');
  evidence = { ok: true, transport: 'real ACP stdio; loopback deterministic Anthropic responses',
    simulatedEvents: false, externalModelCalls: 0, modelResponses: requests.length,
    collectionAdditionalModelCalls: 0, failedPrompt, first, second, stats, recallRecords: recall.records.length, historyResult,
    updates, requests, elapsedMs: performance.now() - start,
    tokenMeasurement: 'Fixture usage is synthetic; schema bytes are measured, billing tokens are not.' };
} catch (error) { evidence = { ok: false, error: error.message, requests, updates, stderr: stderr.slice(-3000) }; process.exitCode = 1; }
finally {
  child.stdin.end();
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(() => { child.kill('SIGTERM'); resolve(); }, 3000))]);
  server.close();
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
}
