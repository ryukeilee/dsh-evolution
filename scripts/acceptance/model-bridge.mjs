#!/usr/bin/env node
/**
 * Real model transport for the acceptance runners.
 *
 * The other runners answer the host's model requests with a deterministic
 * fixture: the tool *results* are real (the host executes them), but the choice
 * of tool and argument is scripted, so they cannot observe whether a model
 * would pick a promoted capability on its own.
 *
 * This bridge keeps everything real except the wire format: the host sends its
 * normal request (system prompt, transcript, tool schemas), and the bridge asks
 * a real model for the next assistant turn. It returns a standard Anthropic
 * event stream with either one `tool_use` block or a text block, so the host
 * cannot tell it apart from its own provider.
 *
 * The only thing that is not the host's own LLM client is the transport: the
 * request is rendered into a prompt for `opencode run` (the same provider and
 * model the production ACP profile uses) and the decision is parsed back. Every
 * turn records the measured usage `opencode` reports, so token counts are the
 * model's real bill for that decision.
 *
 * Deliberate limits:
 *   - the prompt never names a tool, a strategy or a preferred argument; it
 *     carries the live task text, transcript and tool schemas only, so a tool
 *     that gets chosen was chosen from its own description;
 *   - a decision the parser cannot read is reported as a failure, never
 *     guessed into a tool call;
 *   - no background work, no retries on model error (the caller decides).
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** The provider/model the production ACP profile boots with. */
export const DEFAULT_BRIDGE_MODEL = 'opencode-go/deepseek-v4.1-flash';

const MAX_BLOCK_TEXT = 20_000;
const MAX_TOOL_TEXT = 4_000;

function bounded(value, limit) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated ${text.length - limit} characters]` : text;
}

/** One tool schema, rendered for a model that has to choose among them. */
function renderTool(tool) {
  const schema = tool?.parameters ?? tool?.input_schema ?? {};
  const properties = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const fields = Object.entries(properties).slice(0, 24).map(([name, spec]) => {
    const type = typeof spec?.type === 'string' ? spec.type : 'value';
    const description = typeof spec?.description === 'string' ? ` — ${bounded(spec.description, 180)}` : '';
    const required = Array.isArray(schema?.required) && schema.required.includes(name) ? ' (required)' : '';
    return `    ${name}: ${type}${required}${description}`;
  });
  return [`- ${tool.name}: ${bounded(tool.description ?? '', 400)}`, ...(fields.length ? ['  parameters:', ...fields] : [])].join('\n');
}

/** The conversation the host sent, as a plain transcript. */
function renderTranscript(messages) {
  const lines = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const blocks = Array.isArray(message?.content) ? message.content : [];
    for (const block of blocks) {
      if (block?.type === 'text') lines.push(`[${message.role}]\n${bounded(block.text, MAX_BLOCK_TEXT)}`);
      else if (block?.type === 'tool_use') lines.push(`[assistant calls ${block.name}]\n${bounded(JSON.stringify(block.input ?? {}), MAX_TOOL_TEXT)}`);
      else if (block?.type === 'tool_result') {
        lines.push(`[tool result${block.is_error === true ? ' (error)' : ''}]\n${bounded(block.content, MAX_TOOL_TEXT)}`);
      }
    }
  }
  return lines.join('\n\n');
}

export function buildDecisionPrompt(input) {
  const tools = Array.isArray(input?.tools) ? input.tools : [];
  const system = typeof input?.system === 'string' ? input.system
    : Array.isArray(input?.system) ? input.system.map((block) => block?.text ?? '').join('\n') : '';
  return [
    'You are the assistant inside an ongoing coding session. Choose the single next action.',
    'Reply with exactly one JSON object and nothing else:',
    '  {"tool":"<tool name>","arguments":{...}}   to call one tool, or',
    '  {"stop":true,"message":"<final answer to the user>"}   to end your turn.',
    'Do not call tools, do not explain, do not use markdown.',
    '',
    '## Available tools',
    ...tools.map(renderTool),
    '',
    '## System instructions of the session',
    bounded(system, MAX_BLOCK_TEXT),
    '',
    '## Conversation so far',
    renderTranscript(input?.messages),
    '',
    '## Your reply',
  ].join('\n');
}

/** Extract the first balanced JSON object from a model reply. */
export function parseDecision(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'reply-not-text' };
  const start = text.indexOf('{');
  if (start === -1) return { ok: false, reason: 'reply-has-no-object' };
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return { ok: true, value: JSON.parse(text.slice(start, index + 1)) };
        } catch (error) {
          return { ok: false, reason: 'reply-object-invalid', detail: String(error?.message ?? error) };
        }
      }
    }
  }
  return { ok: false, reason: 'reply-object-unterminated' };
}

/**
 * Run one real model turn through the `opencode` CLI.
 *
 * Resolves to the assistant text plus the usage the CLI reported. The child is
 * killed on timeout; a timeout is a failed turn, not an empty answer.
 */
export async function runOpencodeTurn(prompt, { model, cwd, timeoutMs = 180_000, env = process.env } = {}) {
  const workdir = cwd ?? await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bridge-'));
  // A missing working directory makes `spawn` fail with ENOENT before the CLI
  // ever runs, which looks like a model failure. Create it instead.
  await fs.mkdir(workdir, { recursive: true });
  const startedAt = Date.now();
  const child = spawn('opencode', ['run', '--format', 'json', '--model', model, prompt], {
    cwd: workdir, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (bytes) => { stdout = (stdout + bytes).slice(-4_000_000); });
  child.stderr.on('data', (bytes) => { stderr = (stderr + bytes).slice(-20_000); });
  const timeout = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
  const code = await new Promise((resolve) => {
    child.once('error', () => resolve('spawn-error'));
    child.once('exit', (value) => resolve(value));
  });
  clearTimeout(timeout);
  const wallMs = Date.now() - startedAt;
  let text = '';
  let usage = null;
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.type === 'text' && typeof row.part?.text === 'string') text += row.part.text;
    if (row?.type === 'step_finish' && row.part?.tokens) usage = row.part.tokens;
  }
  if (code !== 0 && text === '') {
    return { ok: false, reason: 'model-process-failed', code, wallMs, stderr: bounded(stderr, 1_000), stdout: bounded(stdout, 1_000) };
  }
  return { ok: true, text, usage, wallMs };
}

function anthropicStream(response, decision, usage, messageId) {
  const send = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const inputTokens = Number(usage?.input ?? 0);
  const outputTokens = Number(usage?.output ?? 0);
  send('message_start', {
    message: {
      id: messageId, type: 'message', role: 'assistant', model: 'opencode-go/deepseek-v4.1-flash',
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });
  if (decision.kind === 'tool') {
    send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: crypto.randomUUID(), name: decision.tool, input: {} } });
    send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(decision.arguments) } });
    send('content_block_stop', { index: 0 });
    send('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: outputTokens } });
  } else {
    send('content_block_start', { index: 0, content_block: { type: 'text', text: decision.message } });
    send('content_block_stop', { index: 0 });
    send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens } });
  }
  send('message_stop', {});
  response.end();
}

/**
 * Start the bridge. `turns` collects one record per model request so the caller
 * can report real token counts, latency and the chosen tool per turn.
 */
export async function startModelBridge({ model = DEFAULT_BRIDGE_MODEL, runner = runOpencodeTurn, cwd, onDecision } = {}) {
  const turns = [];
  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    let raw = '';
    try {
      for await (const bytes of request) raw += bytes;
      const input = JSON.parse(raw);
      const prompt = buildDecisionPrompt(input);
      const reply = await runner(prompt, { model, cwd });
      const round = turns.length;
      if (!reply.ok) {
        // A failed real turn is a failed turn: report the error to the host
        // instead of inventing a decision.
        turns.push({ round, ok: false, reason: reply.reason, wallMs: reply.wallMs ?? null });
        response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: reply.reason }));
        return;
      }
      const parsed = parseDecision(reply.text);
      const value = parsed.ok ? parsed.value : null;
      const isStop = value?.stop === true && typeof value.message === 'string' && value.message.trim() !== '';
      const isTool = typeof value?.tool === 'string' && value.tool.trim() !== ''
        && (value.arguments === undefined || (typeof value.arguments === 'object' && value.arguments !== null && !Array.isArray(value.arguments)));
      if (!isStop && !isTool) {
        // A reply that is not a decision is a failed turn, not an empty one.
        // Turning it into `stop` would let an inference or protocol failure look
        // like "the model chose no tool", which is the exact measurement the
        // acceptance exists to make.
        const reason = parsed.ok ? 'decision-shape-invalid' : parsed.reason;
        turns.push({ round: turns.length, ok: false, reason, wallMs: reply.wallMs, replySample: bounded(reply.text, 400) });
        response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: reason }));
        return;
      }
      const decision = isStop
        ? { kind: 'stop', message: bounded(value.message, 2_000) }
        : { kind: 'tool', tool: value.tool, arguments: value.arguments ?? {} };
      const record = {
        round, ok: true, decision: decision.kind === 'tool' ? { tool: decision.tool, arguments: decision.arguments } : { stop: true },
        usage: reply.usage ?? null, wallMs: reply.wallMs,
        promptCharacters: prompt.length, tools: (input.tools ?? []).map((tool) => tool?.name).filter(Boolean),
      };
      turns.push(record);
      onDecision?.(record);
      anthropicStream(response, decision, reply.usage, crypto.randomUUID());
    } catch (error) {
      turns.push({ round: turns.length, ok: false, reason: String(error?.message ?? error) });
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error?.message ?? error));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // The host keeps its connection alive between requests. `server.close()`
  // alone would wait for those sockets forever, so track and destroy them.
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return {
    port: server.address().port,
    baseURL: `http://127.0.0.1:${server.address().port}`,
    turns,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) { try { socket.destroy(); } catch {} }
      server.close(() => resolve());
    }),
  };
}

/** Sum of the real usage the model reported across turns. */
export function usageTotals(turns) {
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, turns: 0, unknownTurns: 0 };
  for (const turn of turns ?? []) {
    if (!turn?.usage) { totals.unknownTurns += 1; continue; }
    totals.turns += 1;
    totals.inputTokens += Number(turn.usage.input ?? 0);
    totals.outputTokens += Number(turn.usage.output ?? 0);
    totals.cacheReadTokens += Number(turn.usage.cache?.read ?? 0);
  }
  return totals;
}

if (process.argv[1] && process.argv[1].endsWith('model-bridge.mjs')) {
  const request = process.argv[2];
  if (request !== '--self-test') throw new Error('usage: model-bridge.mjs --self-test');
  const sample = {
    system: 'You are a coding agent with filesystem tools.',
    tools: [{ name: 'read', description: 'Read a file from the workspace.', parameters: { type: 'object', properties: { file_path: { type: 'string', description: 'Path to read.' } }, required: ['file_path'] } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Read package.json so I can see the version.' }] }],
  };
  const reply = await runOpencodeTurn(buildDecisionPrompt(sample), { model: DEFAULT_BRIDGE_MODEL });
  console.log(JSON.stringify({ ok: reply.ok, usage: reply.usage, wallMs: reply.wallMs, decision: reply.ok ? parseDecision(reply.text) : reply.reason }, null, 2));
}
