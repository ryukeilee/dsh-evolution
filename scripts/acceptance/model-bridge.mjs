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
// Fixed reason codes are the only failure text that may leave the bridge. A raw
// provider/JSON exception can carry a request or reply body.
const PILOT_REASON_CODES = new Set([
  'model-process-failed',
  'reply-not-text',
  'reply-has-no-object',
  'reply-object-invalid',
  'reply-object-unterminated',
  'decision-shape-invalid',
  'pilot-used-own-tools',
]);

function pilotReasonCode(reason) {
  return typeof reason === 'string' && PILOT_REASON_CODES.has(reason) ? reason : 'pilot-transport-error';
}

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
function renderTranscript(messages, maxToolText = MAX_TOOL_TEXT) {
  const lines = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const blocks = Array.isArray(message?.content) ? message.content : [];
    for (const block of blocks) {
      if (block?.type === 'text') lines.push(`[${message.role}]\n${bounded(block.text, MAX_BLOCK_TEXT)}`);
      else if (block?.type === 'tool_use') lines.push(`[assistant calls ${block.name}]\n${bounded(JSON.stringify(block.input ?? {}), MAX_TOOL_TEXT)}`);
      else if (block?.type === 'tool_result') {
        lines.push(`[tool result${block.is_error === true ? ' (error)' : ''}]\n${bounded(block.content, maxToolText)}`);
      }
    }
  }
  return lines.join('\n\n');
}

export function buildDecisionPrompt(input, { maxToolText = MAX_TOOL_TEXT } = {}) {
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
    renderTranscript(input?.messages, maxToolText),
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
  // `build` is the agent a denied-tool project config can override; naming it
  // keeps the transport deterministic instead of following a host default that
  // might allow the pilot to inspect the fixtures with its own tools.
  const child = spawn('opencode', ['run', '--format', 'json', '--agent', 'build', '--model', model, prompt], {
    cwd: workdir, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdoutSample = '';
  let pending = Buffer.alloc(0);
  let text = '';
  let usage = null;
  let usageComplete = true;
  let ownToolCalls = 0;
  const handleLine = (line) => {
    if (!line.trim().startsWith('{')) return;
    let row;
    try { row = JSON.parse(line); } catch { return; }
    if (row?.type === 'text' && typeof row.part?.text === 'string') text += row.part.text;
    // One `opencode run` invocation can make several provider calls (one per
    // step). Each `step_finish` carries that call's bill, so the turn's cost is
    // their sum; keeping only the last step understated a turn by about half in
    // a measured two-step run. A step without numeric input/output makes the
    // whole turn unknown instead of counting it as a smaller bill.
    if (row?.type === 'step_finish') {
      const tokens = row.part?.tokens;
      // A step whose bill is entirely absent is still an unmeasured step: keep
      // the whole turn unknown instead of letting the other steps' subtotal
      // reach the token-regression gate.
      if (!tokens || typeof tokens !== 'object'
        || !Number.isFinite(tokens.input) || !Number.isFinite(tokens.output)
        || (tokens.cache?.read !== undefined && !Number.isFinite(tokens.cache.read))) {
        usageComplete = false;
      } else {
        usage ??= { input: 0, output: 0, cache: { read: 0 } };
        usage.input += tokens.input;
        usage.output += tokens.output;
        usage.cache.read += tokens.cache?.read ?? 0;
      }
    }
    // The pilot is a full coding agent. If it inspects the fixture with its own
    // tools, the answer did not come from the host transcript (and could know
    // values the host path never delivered). Report it instead of accepting it.
    if (row?.type === 'tool_use' || row?.type === 'tool') ownToolCalls += 1;
  };
  // Parse complete JSON lines as they arrive. A trailing byte cap would drop
  // early own-tool or step_finish events, turning a bypass into a retryable
  // process failure and understating the bill. Only the diagnostic sample is
  // bounded; the events are consumed once.
  child.stdout.on('data', (bytes) => {
    if (stdoutSample.length < 4_000) stdoutSample = (stdoutSample + bytes.toString('utf8')).slice(0, 4_000);
    pending = Buffer.concat([pending, bytes]);
    let index;
    while ((index = pending.indexOf(0x0a)) !== -1) {
      handleLine(pending.subarray(0, index).toString('utf8'));
      pending = pending.subarray(index + 1);
    }
  });
  child.stderr.on('data', (bytes) => { stderr = (stderr + bytes).slice(-20_000); });
  const timeout = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
  const [code, signal] = await new Promise((resolve) => {
    let settled = false;
    const settle = (value, name) => { if (!settled) { settled = true; resolve([value, name]); } };
    child.once('error', () => settle('spawn-error', null));
    // Wait for `close`, not `exit`: `exit` fires before stdio is drained, so a
    // detached grandchild still holding stdout could write a tool event after
    // the turn was classified.
    child.once('close', (value, name) => settle(value, name));
  });
  clearTimeout(timeout);
  if (pending.length > 0) handleLine(pending.toString('utf8'));
  const wallMs = Date.now() - startedAt;
  if (!usageComplete) usage = null;
  // A non-zero exit or a signal is a process failure even when partial text was
  // written: that text may be a truncated reply, and the caller's correctness
  // (and its single retry) must not treat it as a parseable decision. Own-tool
  // evidence survives the failure so a bypass cannot be retried as transport.
  if (code !== 0 || signal !== null) {
    return { ok: false, reason: 'model-process-failed', code, signal, ownToolCalls, wallMs, stderr: bounded(stderr, 1_000), stdout: bounded(stdoutSample, 1_000) };
  }
  return { ok: true, text, usage, wallMs, ownToolCalls };
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
export async function startModelBridge({
  model = DEFAULT_BRIDGE_MODEL,
  runner = runOpencodeTurn,
  cwd,
  onDecision,
  maxToolText = MAX_TOOL_TEXT,
  isolatePilotTools = false,
} = {}) {
  // Deny the pilot's own filesystem/shell tools for the `build` agent it is
  // started with. The acceptance tasks live in the same isolated home the host
  // can read; without this, a pilot turn could inspect a fixture itself, answer
  // with zero host tool calls, and make a paired session look cheaper than the
  // path the capability is meant to change. The host tools are still offered as
  // text in the prompt, so the measured decision is unchanged.
  if (isolatePilotTools) {
    if (typeof cwd !== 'string' || cwd === '') throw new Error('isolatePilotTools requires a bridge cwd');
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(cwd, 'opencode.json'), `${JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      agents: {
        build: {
          description: 'single-step decision transport for the DSH acceptance',
          permissions: [{ action: '*', resource: '*', effect: 'deny' }],
        },
      },
    }, null, 2)}\n`, { mode: 0o600 });
  }
  const turns = [];
  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    let raw = '';
    try {
      for await (const bytes of request) raw += bytes;
      const input = JSON.parse(raw);
      const prompt = buildDecisionPrompt(input, { maxToolText });
      const round = turns.length;
      // A malformed reply is a pilot transport failure, not a product result.
      // Retry the same host request once with a corrective instruction so a
      // one-off formatting/refusal turn does not invalidate a whole session.
      // Every attempt's usage is summed, so the cost of the retry is measured.
      const attempts = [];
      let decision = null;
      let failureReason = null;
      for (let attempt = 0; attempt < 2 && decision === null; attempt += 1) {
        const retryPrompt = attempt === 0 ? prompt
          : `${prompt}\n\n[transport retry] Your previous reply was not a usable decision. Reply with exactly one JSON object and nothing else; do not call tools.`;
        const reply = await runner(retryPrompt, { model, cwd });
        attempts.push(reply);
        if (!reply.ok) {
          // A process failure is a transport fact, not a formatting slip, and
          // an own-tool call means the answer may come from outside the host
          // transcript. Neither may be retried into a clean-looking decision;
          // own-tool evidence wins over the process-failure classification.
          failureReason = (reply.ownToolCalls ?? 0) > 0 ? 'pilot-used-own-tools' : reply.reason;
          break;
        }
        if ((reply.ownToolCalls ?? 0) > 0) {
          failureReason = 'pilot-used-own-tools';
          break;
        }
        const parsed = parseDecision(reply.text);
        const value = parsed.ok ? parsed.value : null;
        const isStop = value?.stop === true && typeof value.message === 'string' && value.message.trim() !== '';
        const isTool = typeof value?.tool === 'string' && value.tool.trim() !== ''
          && (value.arguments === undefined || (typeof value.arguments === 'object' && value.arguments !== null && !Array.isArray(value.arguments)));
        if (!isStop && !isTool) {
          // Turning this into `stop` would let an inference or protocol failure
          // look like "the model chose no tool", which is the exact measurement
          // the acceptance exists to make.
          failureReason = parsed.ok ? 'decision-shape-invalid' : parsed.reason;
          continue;
        }
        decision = isStop
          ? { kind: 'stop', message: bounded(value.message, 2_000) }
          : { kind: 'tool', tool: value.tool, arguments: value.arguments ?? {} };
        failureReason = null;
      }
      const usage = combinedUsage(attempts);
      const wallMs = attempts.reduce((total, reply) => total + (Number.isFinite(reply?.wallMs) ? reply.wallMs : 0), 0);
      const retries = attempts.length - 1;
      if (decision === null) {
        const reason = pilotReasonCode(failureReason);
        turns.push({ round, ok: false, reason, wallMs, usage, retries });
        response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: reason }));
        return;
      }
      const record = {
        round, ok: true, decision: decision.kind === 'tool' ? { tool: decision.tool, arguments: decision.arguments } : { stop: true },
        usage, wallMs, retries,
        promptCharacters: prompt.length, tools: (input.tools ?? []).map((tool) => tool?.name).filter(Boolean),
      };
      turns.push(record);
      onDecision?.(record);
      anthropicStream(response, decision, usage, crypto.randomUUID());
    } catch {
      // The exception text may contain the request or reply body. Only a fixed
      // transport code crosses the bridge boundary.
      turns.push({ round: turns.length, ok: false, reason: 'pilot-transport-error' });
      if (!response.headersSent) response.writeHead(500);
      response.end('pilot-transport-error');
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
/**
 * Sum the usage of every attempt made for one host request. A missing billing
 * field on any attempt makes the whole turn unknown (`null`), so a retry cannot
 * be counted as a zero-cost turn.
 */
function combinedUsage(attempts) {
  let total = null;
  for (const attempt of Array.isArray(attempts) ? attempts : []) {
    const usage = attempt?.usage;
    if (!usage || typeof usage.input !== 'number' || !Number.isFinite(usage.input)
      || typeof usage.output !== 'number' || !Number.isFinite(usage.output)
      || (usage.cache !== undefined && (typeof usage.cache?.read !== 'number' || !Number.isFinite(usage.cache.read)))) {
      return null;
    }
    total ??= { input: 0, output: 0, cache: { read: 0 } };
    total.input += usage.input;
    total.output += usage.output;
    total.cache.read += usage.cache?.read ?? 0;
  }
  return total;
}

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
