#!/usr/bin/env node
/**
 * End-to-end acceptance for task-coupled evidence and the context-policy form.
 *
 * It initializes an isolated DSH_HOME, installs the built tarball, generates
 * three long-line fixtures with random sentinels, runs the real-model paired
 * sessions through task-benefit.mjs, proves the target came from the production
 * evolution_plan over the baseline read degradations, then delegates the
 * context-policy plan. The real Trial must pass the deterministic functional
 * check, the produced artifact must satisfy the taskBenefit gate, no approval
 * must promote nothing, a bound owner confirmation must pass a functional
 * canary and publish, and a fresh real ACP consumer must transform the same
 * task. Missing, mis-bound, no-benefit and unadopted artifacts must all stop
 * before approval with no publication.
 *
 * node run-task-benefit-loop.mjs <packed.tgz> <evidence.json> [--work <dir>] [--runs 3] [--approve <text>]
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
import { produceTaskBenefit } from './task-benefit.mjs';
import { mintTaskId, taskChannelPaths } from '../../lib/desktop-task-protocol.js';

const argv = process.argv.slice(2);
const positional = [];
let workArg = null;
let approveText = null;
let runs = 3;
let model = DEFAULT_BRIDGE_MODEL;
let resumeArg = null;
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === '--work' && argv[index + 1]) workArg = path.resolve(argv[++index]);
  else if (arg === '--approve' && argv[index + 1]) approveText = argv[++index];
  else if (arg === '--runs' && argv[index + 1]) runs = Number(argv[++index]);
  else if (arg === '--model' && argv[index + 1]) model = argv[++index];
  else if (arg === '--resume' && argv[index + 1]) resumeArg = path.resolve(argv[++index]);
  else positional.push(arg);
}
const [tarballArg, outArg] = positional;
if (!tarballArg || !outArg) throw new Error('Usage: run-task-benefit-loop.mjs <packed.tgz> <evidence.json> [--work <dir>] [--runs 3] [--resume <prior-evidence.json>] [--approve <owner confirmation text>]');
if (!Number.isInteger(runs) || runs < 3 || runs > 5) throw new Error('--runs must be 3 through 5');
const tarball = path.resolve(tarballArg);
const out = path.resolve(outArg);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const cli = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const work = workArg ?? await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-loop-'));
const temporaryRoots = [...new Set([os.tmpdir(), '/tmp', '/private/tmp'].map((root) => path.resolve(root)))];
if (!temporaryRoots.some((root) => work === root || work.startsWith(root + path.sep))) throw new Error('Acceptance work must be under the temporary directory');
const home = path.join(work, 'home');
const electronInit = path.join(work, 'electron-init');
await fs.mkdir(home, { recursive: true });

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
    pending.set(id, (row) => { clearTimeout(timer); pending.delete(id); row.error ? reject(new Error(method + ': ' + JSON.stringify(row.error))) : resolve(row.result); });
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
    if (fixtureError) throw new Error('fixture failed: ' + fixtureError);
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

const CANDIDATE_HOST = await fs.readFile(path.join(repo, 'scripts/acceptance/fixtures/complete-read-line.host'), 'utf8');

let files = [];
let task = null;
let sentinels = [];
async function prepareFixtures({ resume = false } = {}) {
  files = [];
  for (const name of ['a', 'b', 'c']) {
    const file = name + '.json';
    let line;
    if (resume) {
      line = await fs.readFile(path.join(home, file), 'utf8');
    } else {
      const sentinel = 'sentinel-' + name + '-' + crypto.randomBytes(6).toString('hex');
      line = JSON.stringify({ name: 'generated-config-' + name, routes: Array.from({ length: 80 }, (_, index) => ({ path: '/feature/' + index, enabled: index % 2 === 0 })), sentinel });
      await fs.writeFile(path.join(home, file), line);
      evidence.fixtures.push({ name: file, characters: line.length, sentinelSha256: sha(sentinel) });
    }
    const parsed = JSON.parse(line);
    files.push({ name: file, line, sentinel: parsed.sentinel });
  }
  task = {
    id: 'read-three-long-lines',
    prompt: '请依次用 read 工具读取 a.json、b.json、c.json 的第一行，然后告诉我这三个文件各自的 sentinel 字段值。',
    expect: JSON.stringify(files.map((file) => file.sentinel)),
  };
  sentinels = files.map((file) => file.sentinel);
  assert(task.expect.length <= 500, 'the fixture sentinels exceed the task contract');
}

function planFor(options = {}) {
  const proposal = {
      why: 'The official read tool truncates the first line of these generated configs; a real session then spends a shell call to recover the value.',
      target: 'plugin:complete-read-line',
      impactScope: ['acp', 'desktop'],
      successMetrics: ['fewer turns and tool calls on the same three-file task', 'all three sentinels answered correctly'],
      improvement: 'context-policy',
      benefitModel: { kind: 'workflow' },
      rootCause: 'the read tool caps one line at 2000 characters, so the sentinel is outside the model-visible result and the model falls back to a shell call',
  };
  // A negative control must not be blocked by the no-benefit conclusion an
  // earlier negative published for the same strategy fingerprint; the strategy
  // is optional in the proposal contract, so the controls omit it.
  if (options.strategy !== null) proposal.strategy = options.strategy ?? 'complete the truncated read line through the official tools/post-execute waterfall';
  return {
    proposal,
    composition: { name: 'complete-read-line', purpose: 'Complete a truncated read line before the next model step', code: { host: CANDIDATE_HOST } },
    verification: {
      observations: 2,
      task: { id: task.id, prompt: task.prompt, expect: task.expect, runs },
      functionalCheck: {
        tool: 'read',
        arguments: { file_path: 'a.json', offset: 1, limit: 1 },
        resultPath: ['lines', '0', 'text'],
        expected: files[0].line,
      },
    },
    requestedTargetProfiles: ['acp'],
  };
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

  let taskId;
  let producer;
  if (resumeArg !== null) {
    const prior = await readJson(resumeArg);
    assert(prior?.producer?.artifact?.candidate, 'the resume evidence has no produced artifact');
    evidence.resume = { from: path.basename(resumeArg), producerArtifactFile: prior.producer.artifactFile ?? null };
    await prepareFixtures({ resume: true });
    evidence.fixtures = prior.fixtures ?? evidence.fixtures;
    taskId = prior.producer.artifact.taskId;
    producer = {
      ok: prior.producer.ok === true,
      artifact: prior.producer.artifact,
      artifactFile: prior.producer.artifactFile,
      report: { sessions: prior.producer.sessions },
    };
  } else {
    await prepareFixtures();
    taskId = mintTaskId();
    producer = await produceTaskBenefit({
      home,
      work: path.join(work, 'task-benefit'),
      taskId,
      task,
      candidateHost: CANDIDATE_HOST,
      improvement: 'context-policy',
      runs,
      model,
      binary,
      cli,
      log: (line) => console.log(line),
    });
  }
  evidence.producer = { ok: producer.ok, artifactFile: producer.artifactFile, artifact: producer.artifact, sessions: producer.report.sessions };
  evidence.steps.push({ name: 'paired-real-sessions-produced', at: new Date().toISOString() });
  assert(producer.ok === true, 'the producer did not complete every session: ' + JSON.stringify(producer.artifact, null, 2).slice(0, 1200));
  assert(producer.artifact.candidate.correct === runs, 'the candidate side did not answer every session correctly');
  assert(producer.artifact.baseline.correct === runs, 'the baseline side did not answer every session correctly');
  assert(producer.artifact.adoption.sessionsExercised >= 1, 'the context policy never transformed a read result');
  assert(producer.artifact.candidate.turns < producer.artifact.baseline.turns || producer.artifact.candidate.toolCalls < producer.artifact.baseline.toolCalls,
    'the paired run did not reduce turns or tool calls; this acceptance needs a positive target');

  const probeUrl = pathToFileURL(path.join(repo, 'scripts/acceptance/probes/task-benefit-plan-probe.mjs')).href;
  await fs.writeFile(desktopPatch, desktopOriginalPatch + '\n- insert:\n    - id: task-benefit-plan-probe\n      name: ' + JSON.stringify(probeUrl) + '\n');
  const receiptFile = path.join(work, 'plan-receipt.json');
  desktop = await startDesktop('desktop-live', electronInit, { TASK_BENEFIT_PLAN_RECEIPT: receiptFile });
  const firstReady = await waitFor(liveHost, { timeoutMs: 180_000, what: 'Desktop task host readiness' });
  evidence.host = { instanceId: firstReady.instanceId, pid: firstReady.pid, profile: firstReady.profile };
  planReceipt = await waitFor(() => readJson(receiptFile), { timeoutMs: 180_000, what: 'read-only plan receipt' });
  assert(planReceipt.ok === true, 'the discovery probe failed: ' + planReceipt.error);
  const selection = planReceipt.plan?.selected;
  assert(selection, 'the production planner selected no candidate from the real losses: ' + JSON.stringify(planReceipt.plan?.none ?? null).slice(0, 800));
  assert(selection.problemKey === 'tool read', 'the planner selected ' + JSON.stringify(selection.problemKey) + ', not the observed read loss');
  assert(selection.loss && selection.loss.kinds.includes('line-truncated'), 'the selected candidate does not carry the truncation loss: ' + JSON.stringify(selection.loss));
  assert(selection.loss.recoverable === true, 'the selected loss has no observed recovery cost');
  assert(selection.loss.recoveryCalls >= 1, 'the selected loss reports no recovery calls');
  assert(selection.attribution === 'classified', 'the selected loss is unattributed: ' + JSON.stringify(selection.attribution));
  assert(selection.benefitModel?.kind === 'workflow', 'the selected candidate does not require workflow evidence');
  evidence.discovery = {
    problemKey: selection.problemKey,
    loss: selection.loss,
    occurrences: selection.occurrences,
    score: selection.score,
    benefitModel: selection.benefitModel,
    source: 'production evolution_plan over the isolated shared experience store after the baseline sessions',
  };
  evidence.steps.push({ name: 'real-loss-discovery', at: new Date().toISOString() });

  const plan = planFor();
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

  const bridge = await startModelBridge({ model, cwd: path.join(work, 'bridge-cwd') });
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
  const consumerDecisions = consumerTurns.filter((turn) => (turn.tools?.length ?? 0) > 0).map((turn) => turn.decision?.tool ?? null).filter(Boolean);
  const consumerNameById = new Map();
  consumerCalls.forEach((call, index) => {
    const name = consumerDecisions[index] ?? call.title;
    if (typeof call.toolCallId === 'string' && typeof name === 'string') consumerNameById.set(call.toolCallId, name);
  });
  const consumerReadResults = consumerUpdates
    .filter((update) => update.sessionUpdate === 'tool_call_update' && consumerNameById.get(update.toolCallId) === 'read')
    .map(toolUpdateText);
  assert(consumerTurns.every((turn) => turn.ok === true), 'a fresh consumer model turn failed');
  assert(answerMatches(consumerText, sentinels), 'the fresh consumer did not answer all sentinels: ' + consumerText.slice(-400));
  assert(consumerReadResults.length >= 1, 'the fresh consumer never used the read tool');
  assert(sentinels.every((sentinel) => consumerReadResults.some((text) => text.includes(sentinel))), 'the promoted policy did not deliver the complete read line in the fresh consumer');
  assert(!consumerReadResults.some((text) => text.includes('line truncated')), 'a fresh consumer read result was still truncated');
  const consumerUsage = usageTotals(consumerTurns);
  evidence.freshConsumer = {
    taskId,
    modelTurns: consumerTurns.filter((turn) => (turn.tools?.length ?? 0) > 0).length,
    toolCalls: consumerTurns.filter((turn) => turn.decision?.tool).length,
    tokens: consumerUsage.inputTokens + consumerUsage.outputTokens + consumerUsage.cacheReadTokens,
    wallMs: consumerWall,
    correct: true,
    readResultsContainAllSentinels: true,
    transport: 'real model inference through model-bridge.mjs; the real promoted consumer mounted the policy',
  };
  await bridge.close();
  evidence.steps.push({ name: 'fresh-consumer-functional-reuse', at: new Date().toISOString() });

  const negativeVariants = [
    { label: 'missing', artifact: null, code: 'E_DESKTOP_TASK_EVIDENCE_MISSING' },
    { label: 'mismatch', artifact: (copy) => { copy.candidateHostSha256 = 'd'.repeat(64); }, code: 'E_DESKTOP_TASK_EVIDENCE_MISMATCH' },
    { label: 'no-benefit', artifact: (copy) => { copy.candidate.turns = copy.baseline.turns; copy.candidate.toolCalls = copy.baseline.toolCalls; }, code: 'E_DESKTOP_BENEFIT_UNPROVEN' },
    { label: 'unadopted', artifact: (copy) => { copy.adoption.sessionsExercised = 0; }, code: 'E_DESKTOP_BENEFIT_UNPROVEN' },
  ];
  for (const variant of negativeVariants) {
    const negativeTaskId = mintTaskId();
    if (variant.label !== 'missing') {
      const negativeArtifact = JSON.parse(JSON.stringify(producer.artifact));
      negativeArtifact.taskId = negativeTaskId;
      variant.artifact(negativeArtifact);
      await writeJson(path.join(channel.taskEvidence, negativeTaskId + '.json'), negativeArtifact);
    }
    let negative = null;
    await runFixturePrompt('acp-negative-' + variant.label, '验证一个负向证据候选；不要批准晋升。', (tools, result, round) => {
      if (round === 1) return { name: 'evolution_desktop', args: { action: 'delegate', plan: planFor({ strategy: null }), cwd: home, taskId: negativeTaskId } };
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
    evidence.negatives.push({ variant: variant.label, taskId: negativeTaskId, experimentId: negative.experimentId, phase: negative.phase, error: negative.error, gates: negative.gates, decision: negative.decision, revert: negativeState.revert });
  }
  evidence.steps.push({ name: 'negative-artifacts-rejected', at: new Date().toISOString() });

  await stopDesktop(desktop);
  desktop = null;
  const beforeRestartIndex = await readJson(publishedFile);
  desktop = await startDesktop('desktop-live', electronInit, { TASK_BENEFIT_PLAN_RECEIPT: receiptFile });
  const secondReady = await waitFor(async () => {
    const ready = await liveHost();
    return ready !== null && ready.instanceId !== firstReady.instanceId ? ready : null;
  }, { timeoutMs: 180_000, what: 'Desktop restart readiness' });
  const afterRestart = await readJson(stateFile(taskId));
  assert(afterRestart?.phase === 'stable', 'terminal state changed after restart: ' + afterRestart?.phase);
  assert(JSON.stringify(await readJson(publishedFile)) === JSON.stringify(beforeRestartIndex), 'publication changed after restart');
  evidence.restart = { previousInstanceId: firstReady.instanceId, nextInstanceId: secondReady.instanceId, terminalPreserved: true, publicationPreserved: true };
  evidence.steps.push({ name: 'restart-preserved', at: new Date().toISOString() });

  evidence.ok = true;
} catch (error) {
  evidence.error = String(error?.message ?? error).slice(0, 2000);
  if (!['OWNER_APPROVAL_REQUIRED'].includes(String(error?.message))) process.exitCode = 1;
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
  console.log('Evidence: ' + out + '; ok=' + evidence.ok + (evidence.error ? '; ' + evidence.error : ''));
}
