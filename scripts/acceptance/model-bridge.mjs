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
// The pilot is a full coding agent started as `opencode run --agent build`. It
// must not be able to read the fixture (or the isolated home) with its own
// tools: every measurement decision has to come from the host transcript. The
// wildcard rule is not enough on its own: v2 resolves some actions (notably
// `skill`) outside it, so each capability action is denied explicitly as well.
const PILOT_ISOLATION_RULESET = Object.freeze([
  { action: '*', resource: '*', effect: 'deny' },
  ...['read', 'edit', 'glob', 'grep', 'list', 'bash', 'shell', 'task',
    'external_directory', 'todowrite', 'question', 'webfetch', 'websearch', 'lsp', 'skill']
    .map((action) => ({ action, resource: '*', effect: 'deny' })),
]);
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
  'pilot-transport-incomplete',
]);

function pilotReasonCode(reason) {
  return typeof reason === 'string' && PILOT_REASON_CODES.has(reason) ? reason : 'pilot-transport-error';
}

// `skill` only loads instruction text; it cannot read the fixture or the host
// transcript. opencode still offers it under a deny-all ruleset (the call is
// denied at execution), and the pilot sometimes asks for it. A capability tool
// is anything that can observe or change the measured workspace.
const INSTRUCTION_ONLY_PILOT_TOOLS = new Set(['skill']);

/** The own tools that would make a pilot turn unprovable. */
export function capabilityOwnToolNames(names) {
  return (Array.isArray(names) ? names : [])
    .filter((name) => typeof name === 'string' && name !== '' && !INSTRUCTION_ONLY_PILOT_TOOLS.has(name));
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
 * The pilot's own tool surface, denied twice:
 *
 *   - the project `opencode.json` is the documented layer, but an opencode run
 *     outside a repository does not reliably read it (observed: a file-read
 *     prompt got `read`/`shell` back in 10 of 10 turns);
 *   - `OPENCODE_CONFIG_CONTENT` is a process-local layer that opencode merges
 *     before project config, so the same ruleset reaches the agent even when
 *     the working directory is not recognized as a project.
 *
 * Both carry the identical ruleset so an upgrade that drops either mechanism
 * still fails closed instead of silently re-enabling the pilot's tools.
 */
export function pilotIsolationEnv(base = process.env) {
  return {
    ...base,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ agents: { build: { permissions: PILOT_ISOLATION_RULESET } } }),
  };
}

/**
 * Write the pilot isolation config into a private working directory. Both the
 * measurement bridge and the preflight use this one definition, so the probe
 * proves the same enforcement the sessions run under.
 */
export async function writePilotIsolationConfig(cwd) {
  if (typeof cwd !== 'string' || cwd === '') throw new Error('the pilot isolation config needs a private working directory');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(path.join(cwd, 'opencode.json'), `${JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    agents: {
      build: {
        description: 'single-step decision transport for the DSH acceptance',
        permissions: PILOT_ISOLATION_RULESET,
      },
    },
  }, null, 2)}\n`, { mode: 0o600 });
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
  // `--standalone` keeps each turn on a private server in this working
  // directory. The shared background service is a different process with its
  // own project/config cache: a turn routed there was observed to ignore the
  // agent-level deny ruleset and read the fixture with its own `read` tool.
  const child = spawn('opencode', ['--standalone', 'run', '--format', 'json', '--agent', 'build', '--model', model, prompt], {
    cwd: workdir, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdoutSample = '';
  let pending = Buffer.alloc(0);
  let text = '';
  let usage = null;
  let usageComplete = true;
  let ownToolCalls = 0;
  const ownToolNames = [];
  let deniedToolCalls = 0;
  const deniedToolNames = [];
  let transportIncomplete = false;
  const handleLine = (line) => {
    if (!line.trim().startsWith('{')) return;
    let row;
    // A line that opens like a JSON event but cannot be parsed is an incomplete
    // transport, not a line to skip: a truncated tool_use would otherwise be
    // dropped, reported as zero own-tool calls, and retried as transport. Known
    // events parsed before it still count.
    try { row = JSON.parse(line); } catch { transportIncomplete = true; return; }
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
    // A permission-denied attempt is not an execution: opencode still emits a
    // `tool_use` event for it (`state.status: "error"`, "Permission denied"),
    // but nothing was read or run. Only executed calls make a turn unprovable.
    // The tool *names* are kept for the operator; they carry no arguments or
    // file content, and arguments never leave here.
    if (row?.type === 'tool_use' || row?.type === 'tool') {
      const name = row?.part?.tool ?? row?.part?.name ?? row?.name;
      const state = row?.part?.state;
      const denied = state?.status === 'error' && typeof state.error === 'string' && /permission denied/i.test(state.error);
      if (denied) {
        deniedToolCalls += 1;
        if (typeof name === 'string' && name !== '' && deniedToolNames.length < 8 && !deniedToolNames.includes(name)) deniedToolNames.push(name);
      } else {
        ownToolCalls += 1;
        if (typeof name === 'string' && name !== '' && ownToolNames.length < 8 && !ownToolNames.includes(name)) ownToolNames.push(name);
      }
    }
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
  const closed = new Promise((resolve) => child.once('close', () => resolve(true)));
  const [code, signal] = await new Promise((resolve) => {
    let settled = false;
    const settle = (value, name) => { if (!settled) { settled = true; resolve([value, name]); } };
    child.once('error', () => settle('spawn-error', null));
    // Wait for the process to exit, then separately for stdio to drain. `close`
    // alone can wait forever when a detached descendant still holds the pipe.
    child.once('exit', (value, name) => settle(value, name));
  });
  const drainDeadline = Math.min(2_000, timeoutMs);
  const drained = code === 'spawn-error' ? true : await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(() => resolve(false), drainDeadline)),
  ]);
  clearTimeout(timeout);
  const wallMs = Date.now() - startedAt;
  if (!drained) {
    try { child.stdout.destroy(); } catch {}
    try { child.stderr.destroy(); } catch {}
    try { child.kill('SIGKILL'); } catch {}
    return {
      ok: false, reason: 'pilot-transport-incomplete', code, signal, ownToolCalls, ownToolNames, deniedToolCalls, deniedToolNames, wallMs,
      stderr: bounded(stderr, 1_000), stdout: bounded(stdoutSample, 1_000),
    };
  }
  if (pending.length > 0) handleLine(pending.toString('utf8'));
  if (!usageComplete) usage = null;
  // An unparseable event means the transport truncated evidence (for example a
  // tool_use), so it is not a retryable process failure: the own-tool count is
  // only a lower bound. Known own-tool evidence is still reported.
  if (transportIncomplete) {
    return { ok: false, reason: 'pilot-transport-incomplete', code, signal, ownToolCalls, ownToolNames, deniedToolCalls, deniedToolNames, wallMs, stderr: bounded(stderr, 1_000), stdout: bounded(stdoutSample, 1_000) };
  }
  // A non-zero exit or a signal is a process failure even when partial text was
  // written: that text may be a truncated reply, and the caller's correctness
  // (and its single retry) must not treat it as a parseable decision. Own-tool
  // evidence survives the failure so a bypass cannot be retried as transport.
  if (code !== 0 || signal !== null) {
    return { ok: false, reason: 'model-process-failed', code, signal, ownToolCalls, ownToolNames, deniedToolCalls, deniedToolNames, wallMs, stderr: bounded(stderr, 1_000), stdout: bounded(stdoutSample, 1_000) };
  }
  return { ok: true, text, usage, wallMs, ownToolCalls, ownToolNames, deniedToolCalls, deniedToolNames };
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
 *
 * `sessionId` tags every record with the session that owns this bridge. The
 * producer runs one bridge per paired session, so concurrent sessions can never
 * share a recording: attribution is by tag instead of by a shared list slice.
 */
export async function startModelBridge({
  model = DEFAULT_BRIDGE_MODEL,
  runner = runOpencodeTurn,
  cwd,
  onDecision,
  maxToolText = MAX_TOOL_TEXT,
  isolatePilotTools = false,
  sessionId = null,
} = {}) {
  // Deny the pilot's own filesystem/shell tools for the `build` agent it is
  // started with. The acceptance tasks live in the same isolated home the host
  // can read; without this, a pilot turn could inspect a fixture itself, answer
  // with zero host tool calls, and make a paired session look cheaper than the
  // path the capability is meant to change. The host tools are still offered as
  // text in the prompt, so the measured decision is unchanged.
  if (isolatePilotTools) {
    if (typeof cwd !== 'string' || cwd === '') throw new Error('isolatePilotTools requires a bridge cwd');
    await writePilotIsolationConfig(cwd);
  }
  const turns = [];
  const sockets = new Set();
  // The runner's own process environment carries the second isolation layer.
  const runnerEnv = isolatePilotTools ? pilotIsolationEnv(process.env) : null;
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
      let instructionOnlyRetry = false;
      for (let attempt = 0; attempt < 2 && decision === null; attempt += 1) {
        const retryPrompt = attempt === 0 ? prompt
          : instructionOnlyRetry
            ? `${prompt}\n\n[transport retry] Do not call any tool, including skill. Reply with exactly one JSON object and nothing else.`
            : `${prompt}\n\n[transport retry] Your previous reply was not a usable decision. Reply with exactly one JSON object and nothing else; do not call tools.`;
        const reply = await runner(retryPrompt, { model, cwd, ...(runnerEnv === null ? {} : { env: runnerEnv }) });
        attempts.push(reply);
        const ownToolCalls = Number.isInteger(reply?.ownToolCalls) ? reply.ownToolCalls : 0;
        const ownNames = Array.isArray(reply?.ownToolNames) ? reply.ownToolNames : [];
        if (!reply.ok) {
          // A process failure is a transport fact, not a formatting slip, and
          // an own-tool call means the answer may come from outside the host
          // transcript. Neither may be retried into a clean-looking decision;
          // own-tool evidence wins over the process-failure classification.
          failureReason = ownToolCalls > 0 ? 'pilot-used-own-tools' : reply.reason;
          break;
        }
        // A capability tool proves the answer may have come from the fixture;
        // it is never retried. An instruction-only `skill` call cannot observe
        // the measured state, so the turn is retried once in a fresh process
        // with an explicit no-tool instruction. An own-tool count with no name
        // is unclassified and stays fatal.
        const capability = capabilityOwnToolNames(ownNames);
        if (capability.length > 0 || (ownToolCalls > 0 && ownNames.length === 0)) {
          failureReason = 'pilot-used-own-tools';
          break;
        }
        if (ownToolCalls > 0) {
          if (attempt === 0) {
            instructionOnlyRetry = true;
            failureReason = 'pilot-used-own-tools';
            continue;
          }
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
        turns.push({ round, sessionId, ok: false, reason, wallMs, usage, retries, ownToolNames: attempts.flatMap((attempt) => Array.isArray(attempt?.ownToolNames) ? attempt.ownToolNames : []).slice(0, 8), deniedToolNames: attempts.flatMap((attempt) => Array.isArray(attempt?.deniedToolNames) ? attempt.deniedToolNames : []).slice(0, 8) });
        response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: reason }));
        return;
      }
      const record = {
        round, sessionId, ok: true, decision: decision.kind === 'tool' ? { tool: decision.tool, arguments: decision.arguments } : { stop: true },
        usage, wallMs, retries,
        promptCharacters: prompt.length, tools: (input.tools ?? []).map((tool) => tool?.name).filter(Boolean),
      };
      turns.push(record);
      onDecision?.(record);
      anthropicStream(response, decision, usage, crypto.randomUUID());
    } catch {
      // The exception text may contain the request or reply body. Only a fixed
      // transport code crosses the bridge boundary.
      turns.push({ round: turns.length, sessionId, ok: false, reason: 'pilot-transport-error' });
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

/**
 * The preflight prompt asks the pilot to use its own shell and read tools. When
 * the isolation config is enforced those tools are not offered, so the turn can
 * only answer in text with zero own-tool calls; when enforcement is missing the
 * pilot reads the probe file or runs the command and the evidence is immediate.
 */
export const PILOT_PREFLIGHT_PROMPT = [
  'You are a coding agent with your own filesystem and shell tools.',
  'Do this now with your own tools:',
  '1. Run the shell command `echo DSH_PILOT_ISOLATION_PROBE`.',
  '2. Read the file ./pilot-isolation-probe.txt.',
  '3. Reply with the two values you observed.',
  'If you have no shell and no read tool, reply exactly: DSH_PILOT_NO_TOOLS',
].join('\n');

/**
 * Prove that the pilot's own tools are actually denied before a paired run
 * spends six sessions. One minimal turn is enough: the measurement harness has
 * already observed that an unenforced pilot executes the probe instead of
 * answering. The result carries a fixed reason code, never raw model text.
 */
export async function runPilotIsolationPreflight({
  model = DEFAULT_BRIDGE_MODEL,
  cwd,
  runner = runOpencodeTurn,
  timeoutMs = 45_000,
} = {}) {
  if (typeof cwd !== 'string' || cwd === '') throw new Error('the pilot isolation preflight needs a private working directory');
  await writePilotIsolationConfig(cwd);
  await fs.writeFile(path.join(cwd, 'pilot-isolation-probe.txt'), 'pilot-isolation-probe-value\n', { mode: 0o600 });
  const startedAt = Date.now();
  let reply;
  // One retry only for a transport failure: a flaky pilot process must not
  // abort the whole run, while a bypass (evidence) is never retried away.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      reply = await runner(PILOT_PREFLIGHT_PROMPT, { model, cwd, timeoutMs, env: pilotIsolationEnv(process.env) });
    } catch {
      // A thrown runner is a failed preflight, not a measurement.
      reply = { ok: false, reason: 'model-process-failed' };
    }
    if (reply?.ok === true) break;
    const attemptNames = Array.isArray(reply?.ownToolNames) ? reply.ownToolNames : [];
    if (capabilityOwnToolNames(attemptNames).length > 0) break;
    if (reply?.reason === 'pilot-used-own-tools') break;
  }
  const wallMs = Date.now() - startedAt;
  const ownToolCalls = Number.isInteger(reply?.ownToolCalls) ? reply.ownToolCalls : 0;
  const ownToolNames = Array.isArray(reply?.ownToolNames) ? reply.ownToolNames : [];
  const capability = capabilityOwnToolNames(ownToolNames);
  // An instruction-only `skill` call cannot reach the fixtures; the sessions
  // handle it with a single tool-free retry. Anything else — or an own-tool
  // count without a name — means the deny ruleset is not in force.
  const bypass = capability.length > 0
    || (ownToolCalls > 0 && ownToolNames.length === 0)
    || (reply?.reason === 'pilot-used-own-tools' && ownToolNames.length === 0);
  if (bypass) {
    return {
      ok: false,
      code: 'E_ACP_PILOT_ISOLATION_BYPASS',
      reason: 'pilot-used-own-tools',
      wallMs,
      ownToolCalls,
      ...(ownToolNames.length > 0 ? { ownToolNames: ownToolNames.slice(0, 8) } : {}),
    };
  }
  if (reply?.ok !== true) {
    return { ok: false, code: 'E_ACP_PILOT_PREFLIGHT_FAILED', reason: pilotReasonCode(reply?.reason), wallMs };
  }
  return { ok: true, wallMs };
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
