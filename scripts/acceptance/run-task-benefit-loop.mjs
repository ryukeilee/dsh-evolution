#!/usr/bin/env node
/**
 * End-to-end acceptance for task-coupled evidence and the context-policy form.
 *
 * It initializes an isolated DSH_HOME, installs the built tarball, generates
 * three fixtures with random sentinels, runs the real-model paired sessions
 * through task-benefit.mjs, proves the target came from the production
 * evolution_plan over the baseline read degradations, then delegates the
 * context-policy plan. The real Trial must pass the deterministic functional
 * check, the produced artifact must satisfy the taskBenefit gate, no approval
 * must promote nothing, a bound owner confirmation must pass a functional
 * canary and publish, and a fresh real ACP consumer must transform the same
 * task. Missing, mis-bound, no-benefit and unadopted artifacts must all stop
 * before approval with no publication.
 *
 * Scenarios (`--scenario`):
 *   line  (default) a line longer than the per-line cap (`line-truncated`)
 *   capped           a file over the byte cap with a small tail (`output-capped`)
 *
 * node run-task-benefit-loop.mjs <packed.tgz> <evidence.json> [--work <dir>] [--runs 3] [--scenario line|capped] [--approve <text>]
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startModelBridge, usageTotals, DEFAULT_BRIDGE_MODEL } from './model-bridge.mjs';
import { failedToolCallIds, mergeAcpInputs, missingTerminalToolCalls, produceTaskBenefit, readPathMatches, safeErrorCode, successfulToolResult, terminalNotificationMissingId, terminalToolResults, toolCallDescriptor, toolNameCountsMatch } from './task-benefit.mjs';
import { mintTaskId, taskChannelPaths } from '../../lib/desktop-task-protocol.js';

const argv = process.argv.slice(2);
const positional = [];
let workArg = null;
let approveText = null;
let runs = 3;
let model = DEFAULT_BRIDGE_MODEL;
let ptc = false;
let scenarioName = 'line';
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === '--work' && argv[index + 1]) workArg = path.resolve(argv[++index]);
  else if (arg === '--approve' && argv[index + 1]) approveText = argv[++index];
  else if (arg === '--runs' && argv[index + 1]) runs = Number(argv[++index]);
  else if (arg === '--model' && argv[index + 1]) model = argv[++index];
  else if (arg === '--scenario' && argv[index + 1]) scenarioName = argv[++index];
  else if (arg === '--ptc') ptc = true;
  else positional.push(arg);
}
if (!['line', 'capped'].includes(scenarioName)) throw new Error('--scenario must be "line" or "capped"');
const [tarballArg, outArg] = positional;
if (!tarballArg || !outArg) throw new Error('Usage: run-task-benefit-loop.mjs <packed.tgz> <evidence.json> [--work <dir>] [--runs 3] [--scenario line|capped] [--approve <owner confirmation text>] [--ptc]');
if (!Number.isInteger(runs) || runs < 3 || runs > 5) throw new Error('--runs must be 3 through 5');
const tarball = path.resolve(tarballArg);
const out = path.resolve(outArg);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const cli = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';

/**
 * Two real `read` losses share the official tools/post-execute hook:
 *
 *   - `line`: a single line longer than the per-line cap (the 2026-11-24 form).
 *   - `capped`: a file larger than the byte cap whose remaining tail is small;
 *     the model must spend another turn on `offset` for content it is about to
 *     read anyway (observed 10 times across 578 production sessions).
 *
 * The capped scenario raises the pilot model's transcript bound: the production
 * read result is 50 KiB and the bridge's 4 KiB default would truncate the very
 * footer the model has to react to. The host still enforces its own cap; only
 * the test transport's rendering bound changes.
 */
const SCENARIO = scenarioName === 'capped'
  ? {
    name: 'capped',
    candidateHostFile: 'complete-capped-read.host',
    lossKind: 'output-capped',
    forbiddenReadText: 'Output capped',
    maxToolText: 72_000,
  }
  : {
    name: 'line',
    candidateHostFile: 'complete-read-line.host',
    lossKind: 'line-truncated',
    forbiddenReadText: 'line truncated',
    maxToolText: undefined,
  };
const CANDIDATE_HOST = await fs.readFile(path.join(repo, 'scripts/acceptance/fixtures', SCENARIO.candidateHostFile), 'utf8');
// Resolve every existing component before creating or launching anything: a
// temporary-looking path can be a symlink into the formal data root.
async function realpathOr(target) {
  const suffix = [];
  let current = path.resolve(target);
  for (;;) {
    try { return path.join(await fs.realpath(current), ...suffix.slice().reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}
const inside = (target, root) => target === root || target.startsWith(root + path.sep);
const formalHome = await realpathOr(path.join(os.homedir(), '.dsh'));
const temporaryRoots = await Promise.all([...new Set([os.tmpdir(), '/tmp', '/private/tmp'])].map((root) => realpathOr(root)));
const requestedRoot = await realpathOr(workArg ?? os.tmpdir());
if (inside(requestedRoot, formalHome)) throw new Error('refusing to run acceptance against the formal DSH_HOME');
if (!temporaryRoots.some((root) => inside(requestedRoot, root))) throw new Error('Acceptance work must be under the temporary directory');
// Only canonical, verified roots reach mkdir; the actual work directory and
// home are then created fresh, so a pre-existing home symlink cannot be used.
await fs.mkdir(requestedRoot, { recursive: true });
const work = await fs.mkdtemp(path.join(requestedRoot, 'task-benefit-loop-'));
const home = path.join(work, 'home');
if (await fs.lstat(home).catch(() => null) !== null) throw new Error('the fresh work directory unexpectedly already has a home path');
await fs.mkdir(home, { mode: 0o700 });
const homeReal = await fs.realpath(home);
if (homeReal !== path.join(await fs.realpath(work), 'home')) throw new Error('the acceptance home is not a real directory under the work root');
if (inside(homeReal, formalHome) || !temporaryRoots.some((root) => inside(homeReal, root))) throw new Error('the acceptance home is not isolated');
const electronInit = path.join(work, 'electron-init');

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_')));
delete env.ELECTRON_RUN_AS_NODE;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const readJson = async (file) => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const writeJson = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temporary, file);
};

const channel = taskChannelPaths(home);
const readyFile = channel.ready;
const stateFile = (taskId) => path.join(channel.state, taskId + '.json');
const publishedFile = path.join(home, 'storages', 'evolution', 'shared-plugins', 'published.json');
const consumerFile = path.join(home, 'storages', 'evolution', 'shared-plugins', 'consumers', 'acp.json');

const evidence = {
  kind: 'dsh-evolution-task-benefit-loop',
  ok: false,
  startedAt: new Date().toISOString(),
  scope: 'isolated DSH_HOME; official Desktop + ACP + Evolution kernel; real model inference; no formal home, no release publish',
  model,
  runs,
  scenario: SCENARIO.name,
  steps: [],
  fixtures: [],
  producer: null,
  discovery: null,
  candidate: null,
  approval: null,
  task: null,
  freshConsumer: null,
  negatives: [],
  restart: null,
};
const children = new Set();
function launch(commandName, args, options = {}) {
  const { env: extraEnv, ...rest } = options;
  const child = spawn(commandName, args, { cwd: home, env: { ...env, DSH_HOME: home, ...(extraEnv ?? {}) }, ...rest });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  await exit;
  clearTimeout(timer);
}
async function command(commandName, args, options = {}) {
  const child = launch(commandName, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: repo, ...options });
  let text = '';
  child.stdout.on('data', (bytes) => { text += bytes; });
  child.stderr.on('data', (bytes) => { text += bytes; });
  const [code] = await once(child, 'exit');
  assert(code === 0, 'Setup command failed (' + code + '): ' + text.slice(-1600));
  return text;
}
function platformPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}
async function waitFor(predicate, { timeoutMs, intervalMs = 250, what }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('Timed out waiting for ' + what);
    await sleep(intervalMs);
  }
}
async function startDesktop(label, userDataDir, extraEnv = {}) {
  const log = await fs.open(path.join(work, label + '.log'), 'w', 0o600);
  const child = launch(binary, ['--user-data-dir=' + userDataDir], { stdio: ['ignore', log.fd, log.fd], env: extraEnv });
  child.desktopLog = log;
  return child;
}
async function stopDesktop(child) {
  if (!child) return;
  await stop(child);
  if (child.desktopLog) { try { await child.desktopLog.close(); } catch {} }
}
async function liveHost() {
  const ready = await readJson(readyFile);
  if (ready === null || ready.schemaVersion !== 1 || ready.protocol !== 1) return null;
  return platformPidAlive(ready.pid) ? ready : null;
}

let nextAction = null;
let fixtureError = null;
const fixtureServer = http.createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const bytes of request) raw += bytes;
    const input = JSON.parse(raw);
    const result = input.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).findLast((block) => block.type === 'tool_result');
    const selected = nextAction?.(input.tools ?? [], result);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (type, data) => response.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n');
    send('message_start', { message: { id: crypto.randomUUID(), type: 'message', role: 'assistant', model: 'deepseek-v4-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    if (selected) {
      send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: crypto.randomUUID(), name: selected.name, input: {} } });
      send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(selected.args) } });
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } });
    } else {
      send('content_block_start', { index: 0, content_block: { type: 'text', text: 'Acceptance flow complete.' } });
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
    }
    send('message_stop', {});
    response.end();
  } catch (error) {
    fixtureError = String(error?.message ?? error);
    nextAction = () => null;
    if (!response.headersSent) response.writeHead(500);
    response.end(fixtureError);
  }
});
await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
const fixtureOverlay = path.join(work, 'fixture-transport.yml');
await fs.writeFile(fixtureOverlay, '- id: llm-deepseek\n  config:\n    baseURL: http://127.0.0.1:' + fixtureServer.address().port + '\n    apiKeyEnv: EVOLUTION_ACCEPTANCE_KEY\n', { mode: 0o600 });

async function createAcp(label, { patch, envExtra = {}, waitForPromoted = false, collect = null } = {}) {
  const log = await fs.open(path.join(work, label + '.stderr.log'), 'w', 0o600);
  const child = launch(cli, ['--profile', 'acp', '--patch', patch], {
    env: { EVOLUTION_ACCEPTANCE_KEY: 'local-fixture-only', ...envExtra },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (bytes) => { stderr = (stderr + bytes).slice(-6000); });
  child.stdin.on('error', () => { /* a dead child is reported by the exit handler */ });
  const pending = new Map();
  const updates = collect ?? [];
  let sequence = 0;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let row;
    try { row = JSON.parse(line); } catch { return; }
    if (row.method === 'session/request_permission') {
      const option = row.params.options.find((candidate) => candidate.kind === 'allow_once');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: row.id, result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } }) + '\n');
    } else if (row.id !== undefined) pending.get(row.id)?.(row);
    else if (row.method === 'session/update') updates.push(row.params?.update ?? {});
  });
  const rpc = (method, params, timeout = 60_000) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out; ' + stderr.slice(-800))); }, timeout);
    pending.set(id, (row) => {
      clearTimeout(timer);
      pending.delete(id);
      if (!row.error) { resolve(row.result); return; }
      const error = new Error(method + ': ' + JSON.stringify(row.error));
      if (typeof row.error?.data?.code === 'string') error.code = row.error.data.code;
      else if (typeof row.error?.code === 'string') error.code = row.error.code;
      reject(error);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  child.once('exit', (code, signal) => {
    const detail = 'ACP process exited (code ' + code + ', signal ' + signal + '); ' + stderr.slice(-800);
    for (const [, settle] of pending) settle({ error: { code: -32000, message: detail } });
    pending.clear();
  });
  await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const session = await rpc('session/new', { cwd: home, mcpServers: [] });
  if (waitForPromoted) {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const state = await readJson(consumerFile).catch(() => null);
      const active = !state?.disposedAt && (state?.plugins ?? []).some((plugin) => plugin.status === 'active');
      if (active) break;
      if (Date.now() > deadline) throw new Error('fresh ACP did not record an active promoted consumer');
      await sleep(100);
    }
    await sleep(300);
  }
  return { child, rpc, sessionId: session.sessionId, updates, close: async () => { await stop(child); await log.close(); } };
}

async function runFixturePrompt(label, text, machine) {
  const session = await createAcp(label, { patch: fixtureOverlay });
  let round = 0;
  nextAction = (tools, result) => { round += 1; return machine(tools, result, round); };
  try {
    await session.rpc('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text }] }, 30 * 60 * 1000);
  } catch (error) {
    if (fixtureError) {
      const wrapped = new Error('fixture failed: ' + fixtureError);
      wrapped.code = error?.code;
      throw wrapped;
    }
    throw error;
  } finally {
    await session.close();
  }
  if (fixtureError) throw new Error('fixture failed: ' + fixtureError);
}

function toolResultValue(result) {
  assert(result, 'expected a tool result');
  assert(result.is_error !== true, 'tool failed: ' + JSON.stringify(result).slice(0, 800));
  const content = typeof result.content === 'string' ? result.content : (result.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('');
  return JSON.parse(content);
}
function toolUpdateText(update) {
  const parts = [];
  for (const block of Array.isArray(update?.content) ? update.content : []) {
    if (typeof block?.text === 'string') parts.push(block.text);
    else if (typeof block?.content?.text === 'string') parts.push(block.content.text);
  }
  return parts.join('\n');
}
function answerMatches(text, tokens) {
  return tokens.every((token) => text.includes(token));
}


let files = [];
let task = null;
let sentinels = [];
async function prepareFixtures() {
  files = [];
  for (const name of ['a', 'b', 'c']) {
    const sentinel = 'sentinel-' + name + '-' + crypto.randomBytes(6).toString('hex');
    if (SCENARIO.name === 'capped') {
      // Just over the official 50 KiB read cap: the first window stops with the
      // "Output capped" footer, and the last line (with the sentinel) is in a
      // tail small enough for the candidate to append within its own budget.
      const file = name + '.txt';
      const lines = Array.from({ length: 699 }, (_, index) => 'route ' + String(index + 1).padStart(3, '0')
        + ' enabled=' + (index % 2 === 0) + ' target=/feature/' + index + ' note=generated-config-' + name
        + ' checksum=' + crypto.createHash('sha256').update(name + ':' + index).digest('hex').slice(0, 16));
      lines.push('sentinel: ' + sentinel);
      const text = lines.join('\n') + '\n';
      await fs.writeFile(path.join(home, file), text);
      evidence.fixtures.push({ name: file, characters: text.length, lines: lines.length, sentinelSha256: sha(sentinel) });
      files.push({ name: file, lines, lastLine: lines.at(-1), sentinel });
      continue;
    }
    const file = name + '.json';
    const line = JSON.stringify({ name: 'generated-config-' + name, routes: Array.from({ length: 80 }, (_, index) => ({ path: '/feature/' + index, enabled: index % 2 === 0 })), sentinel });
    await fs.writeFile(path.join(home, file), line);
    evidence.fixtures.push({ name: file, characters: line.length, sentinelSha256: sha(sentinel) });
    const parsed = JSON.parse(line);
    files.push({ name: file, line, sentinel: parsed.sentinel });
  }
  task = SCENARIO.name === 'capped'
    ? {
      id: 'read-three-capped-tails',
      prompt: '请用 read 工具从第一行开始读取 a.txt、b.txt、c.txt（每次读取都使用 limit=2000），然后分别告诉我这三个文件最后一行里 sentinel 的值。',
      expect: JSON.stringify(files.map((file) => file.sentinel)),
      reads: files.map((file) => ({ path: path.join(home, file.name), token: file.sentinel })),
    }
    : {
      id: 'read-three-long-lines',
      prompt: '请依次用 read 工具读取 a.json、b.json、c.json 的第一行，然后告诉我这三个文件各自的 sentinel 字段值。',
      expect: JSON.stringify(files.map((file) => file.sentinel)),
      reads: files.map((file) => ({ path: path.join(home, file.name), token: file.sentinel })),
    };
  sentinels = files.map((file) => file.sentinel);
  assert(task.expect.length <= 500, 'the fixture sentinels exceed the task contract');
}

function planFor(options = {}) {
  const selected = options.selection;
  assert(selected?.improvement === 'context-policy', 'the plan-driven proposal needs the planner context-policy form');
  const baseline = selected.baselinePath;
  const capped = SCENARIO.name === 'capped';
  const proposal = {
      why: selected.improvementReason + (capped
        ? ' The generated files are larger than the official read byte cap, so the sentinel sits in the continuation tail.'
        : ' The generated configs put the sentinel beyond the read truncation point.'),
      target: options.target ?? selected.problemKey,
      impactScope: ['acp', 'desktop'],
      successMetrics: ['fewer turns and tool calls on the same three-file task', 'all three sentinels answered correctly'],
      improvement: selected.improvement,
      benefitModel: { kind: 'workflow' },
      rootCause: 'observed ' + baseline.lossKinds.join('/') + ' recovered by ' + baseline.recoveryTools.join('/') + '; the sentinel is outside the first model-visible read result',
  };
  // A negative control must not be blocked by the no-benefit conclusion an
  // earlier negative published for the same strategy fingerprint; the strategy
  // is optional in the proposal contract, so the controls omit it.
  if (options.strategy !== null) proposal.strategy = options.strategy ?? (capped
    ? 'complete a small capped read tail through the official tools/post-execute waterfall'
    : 'complete the truncated read line through the official tools/post-execute waterfall');
  return {
    proposal,
    composition: capped
      ? { name: 'complete-capped-read', purpose: 'Append a small capped read tail before the next model step', code: { host: CANDIDATE_HOST } }
      : { name: 'complete-read-line', purpose: 'Complete a truncated read line before the next model step', code: { host: CANDIDATE_HOST } },
    verification: {
      observations: 2,
      task: { id: task.id, prompt: task.prompt, expect: task.expect, runs },
      functionalCheck: capped
        ? {
          tool: 'read',
          arguments: { file_path: 'a.txt', offset: 1, limit: 2000 },
          resultPath: ['lines', '699', 'text'],
          expected: files[0].lastLine,
        }
        : {
          tool: 'read',
          arguments: { file_path: 'a.json', offset: 1, limit: 1 },
          resultPath: ['lines', '0', 'text'],
          expected: files[0].line,
        },
    },
    requestedTargetProfiles: ['acp'],
  };
}

/**
 * Negative evidence controls. They run before the positive promotion so the
 * same candidate is not already globally mounted by a previous stable commit:
 * otherwise the pre-Trial baseline check would see the promoted policy and the
 * control would fail for the wrong reason.
 */
async function runNegativeControls({ artifact, planTarget, selection }) {
  const results = [];
  const variants = [
    { label: 'missing', artifact: null, code: 'E_DESKTOP_TASK_EVIDENCE_MISSING' },
    { label: 'mismatch', artifact: (copy) => { copy.candidateHostSha256 = 'd'.repeat(64); }, code: 'E_DESKTOP_TASK_EVIDENCE_MISMATCH' },
    { label: 'no-benefit', artifact: (copy) => { copy.candidate.turns = copy.baseline.turns; copy.candidate.toolCalls = copy.baseline.toolCalls; }, code: 'E_DESKTOP_BENEFIT_UNPROVEN' },
    { label: 'unadopted', artifact: (copy) => { copy.adoption.sessionsExercised = 0; }, code: 'E_DESKTOP_BENEFIT_UNPROVEN' },
  ];
  for (const variant of variants) {
    const negativeTaskId = mintTaskId();
    if (variant.label !== 'missing') {
      const negativeArtifact = JSON.parse(JSON.stringify(artifact));
      negativeArtifact.taskId = negativeTaskId;
      variant.artifact(negativeArtifact);
      await writeJson(path.join(channel.taskEvidence, negativeTaskId + '.json'), negativeArtifact);
    }
    let negative = null;
    await runFixturePrompt('acp-negative-' + variant.label, '验证一个负向证据候选；不要批准晋升。', (tools, result, round) => {
      if (round === 1) return { name: 'evolution_desktop', args: { action: 'delegate', plan: planFor({ target: planTarget, strategy: null, selection }), cwd: home, taskId: negativeTaskId } };
      const value = toolResultValue(result);
      if (['accepted', 'running'].includes(value.phase)) return { name: 'evolution_desktop', args: { action: 'status', taskId: negativeTaskId, waitMs: 60_000 } };
      assert(value.phase === 'failed', 'negative ' + variant.label + ' reached ' + value.phase);
      assert(value.error?.code === variant.code, 'negative ' + variant.label + ' stopped with ' + value.error?.code + ', expected ' + variant.code);
      if (variant.code === 'E_DESKTOP_BENEFIT_UNPROVEN') assert(value.gates?.taskBenefit === false, 'the no-benefit artifact did not fail taskBenefit');
      negative = value;
      return null;
    });
    const negativeState = await readJson(stateFile(negativeTaskId));
    assert(negativeState?.revert?.ok === true, 'negative ' + variant.label + ' did not prove trial cleanup');
    assert(!(await readJson(publishedFile))?.plugins?.some((row) => row.experimentId === negative.experimentId), 'negative ' + variant.label + ' was published');
    results.push({ variant: variant.label, taskId: negativeTaskId, experimentId: negative.experimentId, phase: negative.phase, error: negative.error, gates: negative.gates, decision: negative.decision, revert: negativeState.revert });
  }
  return results;
}

let desktop = null;
let desktopOriginalPatch = null;
let desktopPatch = null;
let planReceipt = null;
try {
  console.log('Isolated work: ' + work);
  if (!await readJson(path.join(home, 'profiles', 'desktop', 'package.json'))) {
    const init = await startDesktop('desktop-init', electronInit);
    try {
      await waitFor(async () => await readJson(path.join(home, 'profiles', 'desktop', 'package.json')), { timeoutMs: 180_000, what: 'official Desktop profile initialization' });
    } finally {
      await stopDesktop(init);
    }
  }
  const installLog = await command(process.execPath, [path.join(repo, 'scripts/setup-experience.mjs'), '--tarball', tarball, '--home', home, '--cli', cli, '--apply']);
  evidence.install = { ok: true, tail: installLog.trim().split('\n').slice(-4) };
  evidence.steps.push({ name: 'official-install', at: new Date().toISOString() });
  desktopPatch = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml');
  desktopOriginalPatch = await fs.readFile(desktopPatch, 'utf8');

  await prepareFixtures();
  const taskId = mintTaskId();
  const producer = await produceTaskBenefit({
    home,
    taskId,
    task,
    candidateHost: CANDIDATE_HOST,
    improvement: 'context-policy',
    runs,
    model,
    binary,
    cli,
    ...(SCENARIO.maxToolText ? { maxToolText: SCENARIO.maxToolText } : {}),
    log: (line) => console.log(line),
  });
  evidence.producer = { ok: producer.ok, artifactFile: producer.artifactFile, artifact: producer.artifact, sessions: producer.report.sessions, retries: producer.report.retries };
  evidence.steps.push({ name: 'paired-real-sessions-produced', at: new Date().toISOString() });
  assert(producer.ok === true, 'the producer did not complete every session: ' + JSON.stringify(producer.artifact, null, 2).slice(0, 1200));
  assert(producer.artifact.candidate.correct === runs, 'the candidate side did not answer every session correctly');
  assert(producer.artifact.baseline.correct === runs, 'the baseline side did not answer every session correctly');
  assert(producer.artifact.adoption.sessionsExercised >= 1, 'the context policy never transformed a read result');
  assert(producer.artifact.candidate.turns < producer.artifact.baseline.turns || producer.artifact.candidate.toolCalls < producer.artifact.baseline.toolCalls,
    'the paired run did not reduce turns or tool calls; this acceptance needs a positive target');

  const probeUrl = pathToFileURL(path.join(repo, 'scripts/acceptance/probes/task-benefit-plan-probe.mjs')).href;
  // A PTC acceptance mounts the same self-evolution preset the formal Desktop
  // profile uses, so the task host exercises the run_code transport instead of
  // the direct ctx.tools.execute path. The isolated profile otherwise stays the
  // standard preset and does not touch formal data.
  const presetFile = path.join(repo, 'scripts/acceptance/fixtures/self-evolution-preset.cordis.patch.yml');
  const presetPatch = ptc ? await fs.readFile(presetFile, 'utf8') : '';
  const presetSha256 = ptc ? crypto.createHash('sha256').update(presetPatch).digest('hex') : null;
  evidence.ptc = ptc ? { enabled: true, preset: { source: path.relative(repo, presetFile), sha256: presetSha256 } } : { enabled: false };
  const presetConfig = ptc
    ? '\n- id: agent-preset-registry\n  config:\n    default: standard\n    selectedDefault: self-evolution\n'
    : '';
  await fs.writeFile(desktopPatch, desktopOriginalPatch + presetPatch + presetConfig + '\n- insert:\n    - id: task-benefit-plan-probe\n      name: ' + JSON.stringify(probeUrl) + '\n');
  const receiptFile = path.join(work, 'plan-receipt.json');
  desktop = await startDesktop('desktop-live', electronInit, { TASK_BENEFIT_PLAN_RECEIPT: receiptFile });
  const firstReady = await waitFor(liveHost, { timeoutMs: 180_000, what: 'Desktop task host readiness' });
  evidence.host = { instanceId: firstReady.instanceId, pid: firstReady.pid, profile: firstReady.profile };
  planReceipt = await waitFor(() => readJson(receiptFile), { timeoutMs: 180_000, what: 'read-only plan receipt' });
  assert(planReceipt.ok === true, 'the discovery probe failed: ' + planReceipt.error);
  if (ptc) assert(planReceipt.transport === 'run_code', 'the PTC acceptance did not exercise the official run_code transport');
  const selection = planReceipt.plan?.selected;
  assert(selection, 'the production planner selected no candidate from the real losses: ' + JSON.stringify(planReceipt.plan?.none ?? null).slice(0, 800));
  assert(selection.problemKey === 'tool read', 'the planner selected ' + JSON.stringify(selection.problemKey) + ', not the observed read loss');
  assert(selection.loss && selection.loss.kinds.includes(SCENARIO.lossKind),
    'the selected candidate does not carry the observed ' + SCENARIO.lossKind + ' loss: ' + JSON.stringify(selection.loss));
  // The per-kind projection is what keeps a merged target's several losses
  // distinguishable; the selected loss must carry the same kind with its own
  // occurrence and recovery evidence.
  const lossKind = (selection.loss.breakdown ?? []).find((row) => row.kind === SCENARIO.lossKind);
  assert(lossKind && lossKind.occurrences >= runs,
    'the planner did not report the per-kind evidence for ' + SCENARIO.lossKind + ': ' + JSON.stringify(selection.loss.breakdown ?? null));
  assert(selection.loss.recoverable === true, 'the selected loss has no observed recovery cost');
  assert(selection.loss.recoveryCalls >= 1, 'the selected loss reports no recovery calls');
  assert(selection.attribution === 'classified', 'the selected loss is unattributed: ' + JSON.stringify(selection.attribution));
  assert(selection.benefitModel?.kind === 'workflow', 'the selected candidate does not require workflow evidence');
  // The proposal below is built from the planner's form and observed baseline;
  // no capability shape is hard-coded in the harness.
  assert(selection.improvement === 'context-policy', 'the planner did not recommend the auto-effective form: ' + JSON.stringify(selection.improvement));
  assert(selection.hook === 'tools/post-execute', 'the planner did not name the official hook');
  assert(selection.verificationKind === 'paired-real-session', 'the planner did not require paired real-session evidence');
  assert(selection.baselinePath?.kind === 'observed-recovery', 'the planner did not record the observed recovery baseline');
  // The collector also accepts grep and a successful same-path re-read; the
  // concrete recovery tool is an observed fact, not a harness requirement.
  assert(selection.baselinePath.recoveryTools.some((tool) => ['bash', 'grep', 'read'].includes(tool)),
    'the planner lost the observed recovery path: ' + JSON.stringify(selection.baselinePath.recoveryTools));
  evidence.discovery = {
    scenario: SCENARIO.name,
    problemKey: selection.problemKey,
    loss: selection.loss,
    lossKindsBreakdown: selection.loss.breakdown ?? null,
    occurrences: selection.occurrences,
    score: selection.score,
    benefitModel: selection.benefitModel,
    improvement: selection.improvement,
    hook: selection.hook,
    verificationKind: selection.verificationKind,
    improvementReason: selection.improvementReason,
    baselinePath: selection.baselinePath,
    source: 'production evolution_plan over the isolated shared experience store after the baseline sessions',
    transport: planReceipt.transport,
  };
  evidence.steps.push({ name: 'real-loss-discovery', at: new Date().toISOString() });

  const planTarget = selection.problemKey;
  evidence.negatives = await runNegativeControls({ artifact: producer.artifact, planTarget, selection });
  evidence.steps.push({ name: 'negative-artifacts-rejected', at: new Date().toISOString() });

  const plan = planFor({ target: planTarget, selection });
  let approvalObserved = null;
  let positiveFailure = null;
  await runFixturePrompt('acp-delegate', '请把这次上下文策略改进交给 Desktop 执行，先停在所有者确认前，不要自行批准。', (tools, result, round) => {
    if (round === 1) return { name: 'evolution_desktop', args: { action: 'delegate', plan, cwd: home, taskId } };
    const value = toolResultValue(result);
    if (['accepted', 'running'].includes(value.phase)) return { name: 'evolution_desktop', args: { action: 'status', taskId, waitMs: 60_000 } };
    if (value.phase === 'awaiting-owner-confirmation') {
      approvalObserved = value;
      return null;
    }
    if (value.phase === 'failed' && value.error?.code === 'E_DESKTOP_BENEFIT_UNPROVEN') {
      positiveFailure = value;
      return null;
    }
    assert(false, 'the positive task ended in ' + value.phase + ': ' + JSON.stringify(value.error ?? value.message ?? null).slice(0, 800));
  });
  if (positiveFailure) {
    evidence.task = { phase: positiveFailure.phase, error: positiveFailure.error, gates: positiveFailure.gates, decision: positiveFailure.decision };
    assert(false, 'the produced artifact did not satisfy the taskBenefit gate: ' + JSON.stringify(positiveFailure.gates ?? null));
  }
  assert(approvalObserved, 'the positive task never reached the owner gate');
  const gateState = await readJson(stateFile(taskId));
  assert(gateState?.phase === 'awaiting-owner-confirmation', 'unexpected state phase at the gate: ' + gateState?.phase);
  assert(gateState.functionalCheck?.trial?.matched === true, 'the Trial did not functionally verify the mounted policy');
  assert(gateState.gates?.taskBenefit === true, 'the taskBenefit gate did not pass: ' + JSON.stringify(gateState.gates));
  assert(gateState.gates?.workflowBenefit === true, 'the workflowBenefit gate did not pass');
  evidence.candidate = {
    taskId,
    experimentId: approvalObserved.experimentId,
    candidateSourceSha256: approvalObserved.candidateSourceSha256,
    gates: approvalObserved.gates,
    decision: approvalObserved.decision,
    trialFunctionalCheck: gateState.functionalCheck.trial,
  };
  evidence.steps.push({ name: 'desktop-awaiting-owner-confirmation', at: new Date().toISOString() });

  const indexBeforeApproval = await readJson(publishedFile);
  await sleep(5_000);
  const stillAwaiting = await readJson(stateFile(taskId));
  assert(stillAwaiting?.phase === 'awaiting-owner-confirmation', 'Desktop promoted without a bound approval: ' + stillAwaiting?.phase);
  assert(JSON.stringify(await readJson(publishedFile)) === JSON.stringify(indexBeforeApproval), 'publication changed without a bound approval');
  evidence.noAutoApproval = { taskId, waitedMs: 5_000, phase: stillAwaiting.phase };

  if (approveText === null) {
    evidence.ok = false;
    evidence.blocked = 'no --approve owner confirmation supplied; stopped at awaiting-owner-confirmation and did not promote';
    process.exitCode = 0;
    throw new Error('OWNER_APPROVAL_REQUIRED');
  }

  await runFixturePrompt('acp-confirm', '所有者已经在对话中明确批准。请写入绑定 experimentId 与 sourceSha256 的确认，并等待 stable。', (tools, result, round) => {
    if (round === 1) {
      return { name: 'evolution_desktop', args: {
        action: 'confirm', taskId,
        experimentId: approvalObserved.experimentId,
        sourceSha256: approvalObserved.candidateSourceSha256,
        confirmation: true,
        confirmationText: approveText,
        targetProfiles: ['acp'],
      } };
    }
    const value = toolResultValue(result);
    if (value.action === 'confirm') {
      assert(value.ok === true, 'confirm failed: ' + (value.message ?? value.code));
      return { name: 'evolution_desktop', args: { action: 'status', taskId, waitMs: 60_000 } };
    }
    if (value.phase === 'stable') return null;
    assert(!['failed', 'interrupted', 'cancelled'].includes(value.phase), 'the task reached ' + value.phase + ': ' + JSON.stringify(value.error ?? null).slice(0, 800));
    return { name: 'evolution_desktop', args: { action: 'status', taskId, waitMs: 60_000 } };
  });

  const finalState = await readJson(stateFile(taskId));
  assert(finalState?.phase === 'stable', 'the task did not reach stable: ' + finalState?.phase + ' ' + (finalState?.error?.message ?? ''));
  evidence.approval = finalState.approval ?? null;
  assert(finalState.functionalCheck?.canary?.length >= 2, 'canary did not replay the functional check');
  assert(finalState.functionalCheck.canary.every((check) => check.matched === true), 'a canary functional check failed');
  const durableFile = path.join(home, 'storages', 'evolution', 'archive', 'experiments', finalState.experimentId + '.evidence.json');
  const durable = await readJson(durableFile);
  assert(durable?.runtimeRecovered === true, 'the promotion did not prove runtime recovery');
  assert(durable?.latestObservation?.evidenceKind === 'task-coupled', 'the measurement is not task-coupled: ' + durable?.latestObservation?.evidenceKind);
  assert(durable?.latestObservation?.taskBenefit?.benefit === true, 'the durable observation did not record a task benefit');
  evidence.durableObservation = {
    runtimeRecovered: durable.runtimeRecovered,
    evidenceKind: durable.latestObservation.evidenceKind,
    observationWindow: durable.latestObservation.observationWindow,
    sampleCount: durable.latestObservation.sampleCount,
    benefitEvidence: durable.latestObservation.benefitEvidence,
    taskBenefit: durable.latestObservation.taskBenefit,
  };
  const published = await readJson(publishedFile);
  const record = published?.plugins?.find((row) => row.experimentId === finalState.experimentId);
  assert(record, 'the stable promotion was not published');
  assert(JSON.stringify(record.approvedProfiles) === JSON.stringify(['acp']), 'publication scope differs from the owner approval: ' + JSON.stringify(record.approvedProfiles));
  evidence.task = {
    taskId,
    experimentId: finalState.experimentId,
    phase: finalState.phase,
    gates: finalState.gates,
    decision: finalState.decision,
    functionalCheck: finalState.functionalCheck,
    artifact: { baseline: producer.artifact.baseline, candidate: producer.artifact.candidate, adoption: producer.artifact.adoption },
    publication: { id: record.id, approvedProfiles: record.approvedProfiles, sourceSha256: record.sourceSha256 },
  };
  evidence.steps.push({ name: 'stable-with-functional-canary', at: new Date().toISOString() });

  const bridge = await startModelBridge({
    model,
    cwd: path.join(work, 'bridge-cwd'),
    isolatePilotTools: true,
    ...(SCENARIO.maxToolText ? { maxToolText: SCENARIO.maxToolText } : {}),
  });
  try {
    const bridgeOverlay = path.join(work, 'bridge-transport.yml');
    await fs.writeFile(bridgeOverlay, '- id: llm-deepseek\n  config:\n    baseURL: ' + bridge.baseURL + '\n    apiKeyEnv: EVOLUTION_ACCEPTANCE_KEY\n', { mode: 0o600 });
    const consumerUpdates = [];
    const fresh = await createAcp('acp-fresh', { patch: bridgeOverlay, waitForPromoted: true, collect: consumerUpdates });
    const consumerStarted = Date.now();
    const consumerBefore = bridge.turns.length;
    try {
      await fresh.rpc('session/prompt', { sessionId: fresh.sessionId, prompt: [{ type: 'text', text: task.prompt }] }, 30 * 60 * 1000);
    } finally {
      await fresh.close();
    }
    const consumerTurns = bridge.turns.slice(consumerBefore);
    const consumerWall = Date.now() - consumerStarted;
    const consumerText = consumerUpdates.filter((update) => update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text').map((update) => update.content.text).join('');
    // Bind each completed result to the decision that produced it, so the proof
    // is a *read* result carrying the complete line, not a shell fallback that
    // happened to print the same value.
    const consumerCalls = consumerUpdates.filter((update) => update.sessionUpdate === 'tool_call');
    // Only decisions that chose a tool have a call; a trailing stop must not
    // shift a later call's arguments onto another id.
    const consumerDecisions = consumerTurns
      .filter((turn) => (turn.tools?.length ?? 0) > 0 && typeof turn.decision?.tool === 'string' && turn.decision.tool.trim() !== '');
    const consumerCallIds = consumerCalls.map((call) => call.toolCallId);
    let consumerAttributionComplete = consumerCalls.length === consumerDecisions.length
      && consumerCallIds.every((id) => typeof id === 'string')
      && new Set(consumerCallIds).size === consumerCallIds.length
      && missingTerminalToolCalls(consumerUpdates) === 0
      && !terminalNotificationMissingId(consumerUpdates);
    const consumerToolNames = consumerDecisions.map((turn) => turn.decision.tool);
    const consumerTerminal = terminalToolResults(consumerUpdates, home);
    if (consumerTerminal.conflicts.size > 0) consumerAttributionComplete = false;
    const consumerResultPathById = consumerTerminal.paths;
    const consumerMergedInputs = mergeAcpInputs(consumerCalls, consumerUpdates, home);
    if (consumerMergedInputs.conflict) consumerAttributionComplete = false;
    const consumerInputByCall = consumerMergedInputs.inputs;
    const consumerHasOffset = (call) => {
      const input = consumerInputByCall.get(call?.toolCallId) ?? call?.rawInput;
      return Number.isInteger(input?.offset) && input.offset > 0;
    };
    const consumerOrderedCalls = consumerCalls.map((call, index) => ({ call, index }))
      .sort((left, right) => Number(consumerHasOffset(right.call)) - Number(consumerHasOffset(left.call)));
    const consumerCallById = new Map();
    const consumerUsedDecisions = new Set();
    consumerOrderedCalls.forEach(({ call, index }) => {
      const effectiveCall = consumerInputByCall.has(call.toolCallId)
        ? { ...call, rawInput: consumerInputByCall.get(call.toolCallId) }
        : call;
      const descriptor = toolCallDescriptor(effectiveCall, index, consumerDecisions, consumerToolNames, home, consumerUsedDecisions,
        consumerResultPathById.get(call.toolCallId) ?? null);
      if (typeof call.toolCallId === 'string' && typeof descriptor.name === 'string') {
        consumerCallById.set(call.toolCallId, descriptor);
      } else {
        consumerAttributionComplete = false;
      }
    });
    const consumerCallNames = consumerCalls.map((call) => consumerCallById.get(call.toolCallId)?.name)
      .filter((name) => typeof name === 'string');
    const consumerCallIdSet = new Set(consumerCalls.map((call) => call.toolCallId).filter((id) => typeof id === 'string'));
    for (const update of consumerUpdates) {
      if (update?.sessionUpdate !== 'tool_call' && update?.sessionUpdate !== 'tool_call_update') continue;
      if (!(update.status === 'completed' || update.status === 'success'
        || update.status === 'failed' || update.status === 'error'
        || update.isError === true || update.is_error === true)) continue;
      if (typeof update.toolCallId === 'string' && !consumerCallIdSet.has(update.toolCallId)) {
        consumerAttributionComplete = false;
      }
    }
    for (const update of consumerUpdates) {
      if (update?.sessionUpdate !== 'tool_call_update') continue;
      if (typeof update.toolCallId !== 'string' || !consumerCallIdSet.has(update.toolCallId)) {
        consumerAttributionComplete = false;
      }
    }
    assert(consumerCalls.length === consumerDecisions.length
      && consumerCallNames.length === consumerCalls.length
      && toolNameCountsMatch(consumerToolNames, consumerCallNames),
    'the fresh consumer model decisions and ACP calls do not align by tool identity');
    const consumerResultById = new Map();
    const consumerFailed = failedToolCallIds(consumerUpdates);
    for (const update of consumerUpdates) {
      if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') continue;
      if (consumerTerminal.conflicts.has(update.toolCallId)) continue;
      if (consumerFailed.ids.has(update.toolCallId)) continue;
      if (!successfulToolResult(update)) continue;
      if (consumerResultById.has(update.toolCallId)) continue;
      const call = consumerCallById.get(update.toolCallId);
      if (call?.name !== 'read') continue;
      const text = consumerTerminal.texts.get(update.toolCallId);
      if (!text) { consumerAttributionComplete = false; continue; }
      const mergedPath = consumerTerminal.paths.get(update.toolCallId) ?? null;
      const renderedPath = mergedPath;
      const argumentPath = typeof call.arguments.file_path === 'string' && call.arguments.file_path.trim() !== ''
        ? call.arguments.file_path : null;
      if (!renderedPath && !argumentPath) { consumerAttributionComplete = false; continue; }
      // The result names the file the host actually read; a disagreement with
      // the request proves neither file's effect and is not evidence.
      if (renderedPath && argumentPath
        && !readPathMatches(argumentPath, renderedPath, home)
        && !readPathMatches(renderedPath, argumentPath, home)) {
        consumerAttributionComplete = false;
        continue;
      }
      const offset = Number.isInteger(call.arguments.offset) && call.arguments.offset > 0 ? call.arguments.offset : 1;
      consumerResultById.set(update.toolCallId, { text, path: renderedPath ?? argumentPath, offset });
    }
    for (const call of consumerCalls) {
      if (consumerCallById.get(call.toolCallId)?.name !== 'read') continue;
      if (consumerFailed.ids.has(call.toolCallId)) continue;
      if (!consumerResultById.has(call.toolCallId)) consumerAttributionComplete = false;
    }
    const consumerReadResults = [...consumerResultById.values()];
    const consumerReadRequests = [];
    for (const call of consumerCalls) {
      const meta = consumerCallById.get(call.toolCallId);
      if (meta?.name !== 'read') continue;
      const argumentPath = typeof meta.arguments.file_path === 'string' && meta.arguments.file_path.trim() !== ''
        ? meta.arguments.file_path : null;
      const offset = meta.inputKnown && Number.isInteger(meta.arguments.offset) && meta.arguments.offset > 0
        ? meta.arguments.offset : (meta.inputKnown ? 1 : null);
      if (!meta.inputKnown) consumerAttributionComplete = false;
      const path = consumerResultById.get(call.toolCallId)?.path ?? argumentPath ?? null;
      if (typeof path !== 'string' || path === '') consumerAttributionComplete = false;
      consumerReadRequests.push({ callId: call.toolCallId, path, offset });
    }
    assert(consumerAttributionComplete, 'the fresh consumer read attribution is incomplete');
    assert(consumerTurns.every((turn) => turn.ok === true), 'a fresh consumer model turn failed');
    const matchedSentinels = sentinels.filter((sentinel) => consumerText.includes(sentinel)).length;
    assert(matchedSentinels === sentinels.length, 'the fresh consumer answered ' + matchedSentinels + '/' + sentinels.length + ' expected values');
    assert(consumerReadResults.length >= 1, 'the fresh consumer never used the read tool');
    assert(sentinels.every((sentinel) => consumerReadResults.some((result) => result.text.includes(sentinel))), 'the promoted policy did not deliver the complete read result in the fresh consumer');
    assert(!consumerReadResults.some((result) => result.text.includes(SCENARIO.forbiddenReadText)),
      'a fresh consumer read result still carried "' + SCENARIO.forbiddenReadText + '"');
    // The first *request* of each file must start at line 1 and return that
    // file's own sentinel: a tail-first or failed first request followed by a
    // later start read is the cost the policy exists to remove, not proof that
    // it ran. The value is bound to its path, so one file's content cannot
    // stand in for another's.
    for (const file of files) {
      const expectedPath = path.join(home, file.name);
      const request = consumerReadRequests.find((candidate) => readPathMatches(candidate.path, expectedPath, home));
      assert(request && request.offset === 1, 'the fresh consumer did not take a start read of ' + file.name);
      const result = consumerResultById.get(request.callId);
      assert(result && result.text.includes(file.sentinel),
        'the promoted policy did not complete the first start read of ' + file.name);
    }
    const consumerUsage = usageTotals(consumerTurns);
    evidence.freshConsumer = {
      taskId,
      modelTurns: consumerTurns.filter((turn) => (turn.tools?.length ?? 0) > 0).length,
      toolCalls: consumerTurns.filter((turn) => turn.decision?.tool).length,
      tokens: consumerUsage.unknownTurns === 0
        ? consumerUsage.inputTokens + consumerUsage.outputTokens + consumerUsage.cacheReadTokens : null,
      usageUnknownTurns: consumerUsage.unknownTurns,
      wallMs: consumerWall,
      correct: true,
      readResultsContainAllSentinels: true,
      answerSha256: sha(consumerText),
      transport: 'real model inference through model-bridge.mjs; the real promoted consumer mounted the policy',
    };
  } finally {
    await bridge.close();
  }
  evidence.steps.push({ name: 'fresh-consumer-functional-reuse', at: new Date().toISOString() });

  await stopDesktop(desktop);
  desktop = null;
  const beforeRestartIndex = await readJson(publishedFile);
  const resolvedReceiptFile = path.join(work, 'plan-resolved.json');
  desktop = await startDesktop('desktop-live', electronInit, { TASK_BENEFIT_PLAN_RECEIPT: resolvedReceiptFile });
  const secondReady = await waitFor(async () => {
    const ready = await liveHost();
    return ready !== null && ready.instanceId !== firstReady.instanceId ? ready : null;
  }, { timeoutMs: 180_000, what: 'Desktop restart readiness' });
  const afterRestart = await readJson(stateFile(taskId));
  assert(afterRestart?.phase === 'stable', 'terminal state changed after restart: ' + afterRestart?.phase);
  assert(JSON.stringify(await readJson(publishedFile)) === JSON.stringify(beforeRestartIndex), 'publication changed after restart');
  // The adopted conclusion must name the same problem identity the plan
  // proposed, or the next planner run would still propose the fixed loss.
  const resolvedReceipt = await waitFor(() => readJson(resolvedReceiptFile), { timeoutMs: 180_000, what: 'resolved plan receipt' });
  assert(resolvedReceipt.ok === true, 'the resolved plan probe failed: ' + resolvedReceipt.error);
  const resolvedPlan = resolvedReceipt.plan ?? {};
  const rejectedRow = (resolvedPlan.rejected ?? []).find((row) => row.problemKey === selection.problemKey);
  const stillSelected = resolvedPlan.selected?.problemKey === selection.problemKey;
  const stillCandidate = (resolvedPlan.candidates ?? []).some((row) => row.problemKey === selection.problemKey);
  assert(rejectedRow?.reason === 'already-resolved', 'the planner did not reject ' + selection.problemKey + ' as already-resolved: ' + JSON.stringify(rejectedRow ?? null));
  assert(!stillSelected && !stillCandidate, 'the planner still proposes the resolved degradation ' + selection.problemKey);
  evidence.restart = {
    previousInstanceId: firstReady.instanceId,
    nextInstanceId: secondReady.instanceId,
    terminalPreserved: true,
    publicationPreserved: true,
    plannerResolved: {
      selected: resolvedPlan.selected?.problemKey ?? null,
      rejected: true,
      rejectedReason: rejectedRow.reason,
      candidateCount: (resolvedPlan.candidates ?? []).length,
      none: resolvedPlan.none?.reason ?? null,
    },
  };
  evidence.steps.push({ name: 'restart-preserved-and-planner-resolved', at: new Date().toISOString() });

  evidence.ok = true;
} catch (error) {
  const detail = String(error?.message ?? error);
  // Raw transport text can carry ACP stderr or model/tool content; keep it on
  // the operator console and persist only a controlled projection.
  console.error('[task-benefit-loop] ' + detail);
  const stage = /fixture failed/.test(detail) ? 'fixture'
    : /timed out/.test(detail) ? 'timeout'
      : /E_DESKTOP/.test(detail) ? 'desktop-task' : 'acceptance';
  evidence.error = { stage, category: 'acceptance-failure', code: safeErrorCode(error) };
  if (!['OWNER_APPROVAL_REQUIRED'].includes(detail)) process.exitCode = 1;
} finally {
  for (const child of children) await stopDesktop(child).catch(() => {});
  if (desktopPatch !== null && desktopOriginalPatch !== null) {
    try { await fs.writeFile(desktopPatch, desktopOriginalPatch); } catch {}
  }
  fixtureServer.closeAllConnections();
  await new Promise((resolve) => fixtureServer.close(resolve));
  evidence.finishedAt = new Date().toISOString();
  evidence.tarballSha256 = sha(await fs.readFile(tarball));
  const redacted = JSON.stringify(evidence, null, 2).replaceAll(home, '$DSH_HOME').replaceAll(work, '<work>').replaceAll(repo.replace(/\/$/, ''), '<repo>');
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, redacted + '\n');
  console.log('Evidence: ' + out + '; ok=' + evidence.ok + (evidence.error ? '; ' + JSON.stringify(evidence.error) : ''));
}
