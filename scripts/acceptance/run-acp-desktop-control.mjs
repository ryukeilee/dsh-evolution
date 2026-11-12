#!/usr/bin/env node
/**
 * Isolated acceptance for the production ACP -> Desktop evolution channel.
 *
 * It exercises the installed entries exactly as an owner would:
 *   1. initialize an isolated DSH_HOME through the official Desktop app;
 *   2. install the built tarball through the official installer (which enables
 *      `desktop-task-host` on desktop and `desktop-task-client` on acp);
 *   3. start the real official Desktop app and wait for its host readiness file;
 *   4. run the real ACP host with deterministic loopback model responses that
 *      call `evolution_desktop` in a natural-language task;
 *   5. stop before promotion when the bound owner approval is missing, then
 *      (only with --approve) relay an experiment-bound approval and let the
 *      real Evolution kernel promote and canary the candidate;
 *   6. start a fresh ACP process and verify the promoted plugin is mounted and
 *      callable without touching Desktop;
 *   7. restart Desktop and verify the durable stable fact and task state survive.
 *
 * The model transport is a deterministic fixture; the ACP transport, the
 * official Desktop app, the Evolution kernel, its gates and persistence, the
 * task channel and the fresh-ACP consumer are real. It never touches the
 * formal `$DSH_HOME`, never reads production credentials and never publishes a
 * release.
 *
 * node scripts/acceptance/run-acp-desktop-control.mjs <packed.tgz> <evidence.json> [--work <dir>] [--approve <text>]
 * Without --approve the run stops at awaiting-owner-confirmation and reports the
 * bound identity instead of promoting.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const positional = [];
let workArg = null;
let approveText = null;
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === '--work' && argv[index + 1]) workArg = path.resolve(argv[++index]);
  else if (arg === '--approve' && argv[index + 1]) approveText = argv[++index];
  else positional.push(arg);
}
const [tarballArg, outArg] = positional;
if (!tarballArg || !outArg) throw new Error('Usage: run-acp-desktop-control.mjs <packed.tgz> <evidence.json> [--work <dir>] [--approve <owner confirmation text>]');
const tarball = path.resolve(tarballArg);
const out = path.resolve(outArg);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const cli = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const work = workArg ?? await fs.mkdtemp(path.join(os.tmpdir(), 'acp-desktop-control-'));
if (!work.startsWith(`${os.tmpdir()}${path.sep}`)) throw new Error('Acceptance work must be under the temporary directory');
const home = path.join(work, 'home');
const electronInit = path.join(work, 'electron-init');
const electronLive = path.join(work, 'electron-live');
await fs.mkdir(home, { recursive: true });

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_')));
delete env.ELECTRON_RUN_AS_NODE;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const readJson = async (file) => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const writeJson = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
};

const dataRoot = path.join(home, 'storages', 'evolution');
const channel = path.join(dataRoot, 'desktop-tasks');
const readyFile = path.join(channel, 'host.json');
const stateFile = (taskId) => path.join(channel, 'state', `${taskId}.json`);
const publishedFile = path.join(dataRoot, 'shared-plugins', 'published.json');
const consumerFile = path.join(dataRoot, 'shared-plugins', 'consumers', 'acp.json');

const evidence = {
  kind: 'dsh-evolution-acp-desktop-control',
  ok: false,
  startedAt: new Date().toISOString(),
  modelTransport: 'deterministic loopback Anthropic responses; actual ACP Agent/tools and actual Desktop app',
  scope: 'isolated DSH_HOME; production task channel + official Desktop kernel; no formal home, no release publish',
  steps: [],
  desktop: {},
  host: {},
  candidate: {},
  approval: null,
  publication: null,
  freshConsumer: null,
  restart: {},
};
const children = new Set();
function launch(command, args, options = {}) {
  const child = spawn(command, args, { cwd: home, env: { ...env, DSH_HOME: home }, ...options });
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
async function command(command, args, options = {}) {
  const child = launch(command, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: repo, ...options });
  let text = '';
  child.stdout.on('data', (bytes) => { text += bytes; });
  child.stderr.on('data', (bytes) => { text += bytes; });
  const [code] = await once(child, 'exit');
  assert(code === 0, `Setup command failed (${code}): ${text.slice(-1200)}`);
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
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}
async function startDesktop(label, userDataDir = electronInit) {
  const log = await fs.open(path.join(work, `${label}.log`), 'w', 0o600);
  const child = launch(binary, [`--user-data-dir=${userDataDir}`], { stdio: ['ignore', log.fd, log.fd] });
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

// ---------------------------------------------------------------------------
// deterministic model fixture
// ---------------------------------------------------------------------------
let nextAction = null;
let lastToolResult = null;
let fixtureError = null;
const server = http.createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const bytes of request) raw += bytes;
    const input = JSON.parse(raw);
    const result = input.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).findLast((block) => block.type === 'tool_result');
    if (result) lastToolResult = result;
    const selected = nextAction?.(input.tools ?? [], result);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('message_start', { message: { id: crypto.randomUUID(), type: 'message', role: 'assistant', model: 'deepseek-v4-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    if (selected) {
      evidence.steps.push({ name: 'real-acp-model-tool-request', tool: selected.name, at: new Date().toISOString() });
      console.log(`ACP model requests ${selected.name} (${Object.keys(selected.args).join(',')})`);
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
    console.error(`Fixture: ${fixtureError}`);
    response.writeHead(500);
    response.end(fixtureError);
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const overlay = path.join(work, 'acp-transport.yml');
await fs.writeFile(overlay, `- id: llm-deepseek\n  config:\n    baseURL: http://127.0.0.1:${server.address().port}\n    apiKeyEnv: EVOLUTION_ACCEPTANCE_KEY\n`);

async function createAcp(label) {
  const log = await fs.open(path.join(work, `${label}.stderr.log`), 'w', 0o600);
  const child = launch(cli, ['--profile', 'acp', '--patch', overlay], {
    env: { ...env, DSH_HOME: home, EVOLUTION_ACCEPTANCE_KEY: 'local-fixture-only' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (bytes) => { stderr = (stderr + bytes).slice(-4000); });
  const pending = new Map();
  let sequence = 0;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let row;
    try { row = JSON.parse(line); } catch { return; }
    if (row.method === 'session/request_permission') {
      const option = row.params.options.find((candidate) => candidate.kind === 'allow_once');
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: row.id, result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } })}\n`);
    } else if (row.id !== undefined) pending.get(row.id)?.(row);
    else if (row.method === 'session/update' && row.params?.update?.sessionUpdate === 'tool_call') evidence.steps.push({ name: 'real-acp-tool-call', at: new Date().toISOString() });
  });
  const rpc = (method, params, timeout = 60_000) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out; ${stderr.slice(-800)}`)); }, timeout);
    pending.set(id, (row) => { clearTimeout(timer); pending.delete(id); row.error ? reject(new Error(`${method}: ${JSON.stringify(row.error)}`)) : resolve(row.result); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const session = await rpc('session/new', { cwd: home, mcpServers: [] });
  return { child, rpc, sessionId: session.sessionId, close: async () => { await stop(child); await log.close(); } };
}

/**
 * Run one real ACP session. `machine(tools, toolResult, round)` decides the
 * next real tool call; returning null ends the assistant turn. It is a model
 * fixture, so the only thing it fakes is the model's choice of arguments.
 */
async function runPrompt(label, text, machine) {
  const session = await createAcp(label);
  acp = session;
  let round = 0;
  nextAction = (tools, result) => { round += 1; return machine(tools, result, round); };
  lastToolResult = null;
  try {
    await session.rpc('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text }] }, 20 * 60 * 1000);
  } catch (error) {
    if (fixtureError) throw new Error(`fixture failed: ${fixtureError}`);
    throw error;
  } finally {
    await session.close();
    if (acp === session) acp = null;
  }
  if (fixtureError) throw new Error(`fixture failed: ${fixtureError}`);
}

function toolResultValue(result) {
  assert(result, 'expected a tool result');
  assert(result.is_error !== true, `tool failed: ${JSON.stringify(result).slice(0, 800)}`);
  const content = typeof result.content === 'string' ? result.content : (result.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('');
  return JSON.parse(content);
}

const plan = (() => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const tool = `acp_stats_${suffix}`;
  const compositionName = `acp-stats-${suffix}`;
  const host = `const tool = harness.defineTool({ name: '${tool}', description: 'Read-only text character and line counts', parameters: { text: { type: 'string', required: true } }, output: { schema: { type: 'object', properties: { characters: { type: 'integer', required: true }, lines: { type: 'integer', required: true } }, additionalProperties: false }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] }, isConcurrencySafe: () => true, execute: async ({ text }) => ({ characters: text.length, lines: text.split('\\n').length }) }); return { name: '${compositionName}', inject: ['tools'], apply(ctx) { harness.registerTool(ctx, tool); } };`;
  return {
    suffix,
    tool,
    compositionName,
    host,
    sourceSha256: sha(host),
    plan: {
      proposal: {
        why: 'Acceptance: add a deterministic read-only text statistics tool to prove the ACP -> Desktop evolution channel end to end.',
        target: `plugin:${compositionName}`,
        impactScope: ['isolated-acceptance-only'],
        successMetrics: ['both deterministic sample calls return the expected character and line counts'],
      },
      composition: { name: compositionName, purpose: 'Read-only text statistics; no filesystem, network, or process access', code: { host } },
      verification: {
        targetTool: tool,
        observations: 2,
        samples: [
          { label: 'letters', tool, arguments: { text: 'abc' }, expected: { characters: 3, lines: 1 } },
          { label: 'lines', tool, arguments: { text: 'a\nb' }, expected: { characters: 3, lines: 2 } },
        ],
      },
      requestedTargetProfiles: ['acp'],
    },
  };
})();
evidence.candidate = { tool: plan.tool, compositionName: plan.compositionName, sourceSha256: plan.sourceSha256 };

let desktop = null;
let acp = null;
let approvalObserved = null;
try {
  console.log(`Isolated work: ${work}`);
  evidence.desktop.binary = binary;
  evidence.desktop.cli = cli;

  // 1. official Desktop initialization creates the profile the installer needs.
  if (!await readJson(path.join(home, 'profiles', 'desktop', 'package.json'))) {
    const init = await startDesktop('desktop-init');
    try {
      await waitFor(async () => await readJson(path.join(home, 'profiles', 'desktop', 'package.json')), { timeoutMs: 120_000, what: 'official Desktop profile initialization' });
    } finally {
      await stopDesktop(init);
    }
  }
  evidence.steps.push({ name: 'official-desktop-profile-initialized', at: new Date().toISOString() });

  // 2. official installer enables desktop-task-host (desktop) and -client (acp).
  const installLog = await command(process.execPath, [path.join(repo, 'scripts/setup-experience.mjs'), '--tarball', tarball, '--home', home, '--cli', cli, '--apply']);
  evidence.install = { ok: true, tail: installLog.trim().split('\n').slice(-4) };
  const profiles = ['desktop', 'acp', 'web'];
  const patchesBefore = Object.fromEntries(await Promise.all(profiles.map(async (profile) => [profile, await fs.readFile(path.join(home, 'profiles', profile, 'cordis.patch.yml'), 'utf8')])));
  for (const profile of profiles) {
    const patch = patchesBefore[profile];
    const hostDisabled = /- id: evolution-desktop-task-host\n  disabled: (true|false)/.exec(patch)?.[1];
    const clientDisabled = /- id: evolution-desktop-task-client\n  disabled: (true|false)/.exec(patch)?.[1];
    assert(hostDisabled !== undefined && clientDisabled !== undefined, `managed block missing on ${profile}`);
    assert(hostDisabled === String(profile !== 'desktop'), `host enabled incorrectly on ${profile}`);
    assert(clientDisabled === String(profile !== 'acp'), `client enabled incorrectly on ${profile}`);
  }
  evidence.install.roles = 'host enabled on desktop only; client enabled on acp only; web keeps neither';

  // 3. the real official Desktop app boots the configured profile.
  desktop = await startDesktop('desktop-live');
  const firstReady = await waitFor(liveHost, { timeoutMs: 180_000, what: 'Desktop task host readiness' });
  evidence.host.first = { instanceId: firstReady.instanceId, pid: firstReady.pid, protocol: firstReady.protocol, profile: firstReady.profile };
  assert(firstReady.profile === 'desktop', 'host readiness does not report the desktop profile');
  evidence.steps.push({ name: 'desktop-task-host-ready', at: new Date().toISOString() });

  // 4. Electron single-instance: a second launch must not create a second host.
  // The duplicate must use the *same* Electron user-data directory as the live
  // app, which is what the ACP client does in production. Electron's
  // single-instance lock then focuses the live instance instead of booting a
  // second Desktop host over the same DSH_HOME.
  const duplicate = await startDesktop('desktop-duplicate', electronLive);
  await sleep(4_000);
  const afterDuplicate = await liveHost();
  assert(afterDuplicate?.instanceId === firstReady.instanceId && afterDuplicate?.pid === firstReady.pid, 'a duplicate Desktop launch replaced the live host');
  evidence.host.singleInstance = { duplicateInstanceId: afterDuplicate.instanceId, secondLaunchPid: duplicate.pid };
  await stopDesktop(duplicate);
  evidence.steps.push({ name: 'desktop-single-instance-held', at: new Date().toISOString() });

  // 5. a real natural-language ACP session delegates the task and ends its turn
  //    at the owner gate. The model fixture only chooses the real tools; it
  //    never fabricates their results.
  const assertKernelFree = (tools) => {
    const names = tools.map((tool) => tool.name);
    assert(!names.includes('evolution_trial') && !names.includes('evolution_promote'), `ACP loaded the Evolution kernel: ${names.join(', ')}`);
    assert(names.includes('evolution_desktop'), `ACP is missing evolution_desktop: ${names.join(', ')}`);
  };
  await runPrompt('acp-delegate', '请自我进化：新增一个只读的文本字符数与行数统计工具。用 evolution_desktop 把它作为真实进化任务交给 Desktop；先停在所有者确认前，不要自行批准。', (tools, result, round) => {
    assertKernelFree(tools);
    if (round === 1) return { name: 'evolution_desktop', args: { action: 'delegate', plan: plan.plan, cwd: home } };
    const value = toolResultValue(result);
    if (round === 2) {
      assert(value.action === 'delegate', `unexpected delegate result action: ${value.action}`);
      assert(value.phase === 'awaiting-owner-confirmation', `delegate did not stop at the owner gate: ${value.phase} ${value.message ?? ''}`);
      assert(value.experimentId && value.candidateSourceSha256 === plan.sourceSha256, 'delegate identity does not match the candidate');
      approvalObserved = { taskId: value.taskId, experimentId: value.experimentId, sourceSha256: value.candidateSourceSha256, gates: value.gates, decision: value.decision };
      return { name: 'evolution_desktop', args: { action: 'status', taskId: value.taskId } };
    }
    assert(value.phase === 'awaiting-owner-confirmation', 'status left the owner gate without approval');
    return null;
  });
  assert(approvalObserved, 'ACP never reached the owner confirmation gate');
  evidence.candidate.experimentId = approvalObserved.experimentId;
  evidence.candidate.gates = approvalObserved.gates;
  evidence.candidate.decision = approvalObserved.decision;
  evidence.steps.push({ name: 'desktop-awaiting-owner-confirmation', at: new Date().toISOString() });

  // 6. no approval file means no promotion: wait and re-read the Desktop state.
  const startedAwaiting = await readJson(stateFile(approvalObserved.taskId));
  assert(startedAwaiting?.phase === 'awaiting-owner-confirmation', `unexpected state phase ${startedAwaiting?.phase}`);
  const indexBeforeApproval = await readJson(publishedFile);
  await sleep(5_000);
  const stillAwaiting = await readJson(stateFile(approvalObserved.taskId));
  assert(stillAwaiting?.phase === 'awaiting-owner-confirmation', `Desktop promoted without a bound approval: ${stillAwaiting?.phase}`);
  assert(JSON.stringify(await readJson(publishedFile)) === JSON.stringify(indexBeforeApproval), 'publication index changed without a bound approval');
  evidence.noAutoApproval = { taskId: approvalObserved.taskId, waitedMs: 5_000, phase: stillAwaiting.phase };
  evidence.steps.push({ name: 'desktop-did-not-auto-approve', at: new Date().toISOString() });

  if (approveText === null) {
    evidence.ok = false;
    evidence.blocked = 'no --approve owner confirmation supplied; stopped at awaiting-owner-confirmation and did not promote';
    process.exitCode = 0;
    throw new Error('OWNER_APPROVAL_REQUIRED');
  }

  // 7. a second real ACP process relays the bound owner approval and waits for
  //    the real kernel to stabilize.
  evidence.approval = { ...(evidence.approval ?? {}), text: approveText, at: new Date().toISOString() };
  await runPrompt('acp-confirm', '所有者已经在对话中明确批准了这次晋升。请用 evolution_desktop 的 confirm 动作写入绑定 experimentId 与 sourceSha256 的确认，然后等待 Desktop 的 stable 结果。', (tools, result, round) => {
    assertKernelFree(tools);
    if (round === 1) {
      return {
        name: 'evolution_desktop',
        args: {
          action: 'confirm',
          taskId: approvalObserved.taskId,
          experimentId: approvalObserved.experimentId,
          sourceSha256: approvalObserved.sourceSha256,
          confirmation: true,
          confirmationText: approveText,
          targetProfiles: ['acp'],
        },
      };
    }
    const value = toolResultValue(result);
    if (value.action === 'confirm') {
      assert(value.ok === true, `confirm failed: ${value.message ?? value.code}`);
      return { name: 'evolution_desktop', args: { action: 'status', taskId: approvalObserved.taskId, waitMs: 60_000 } };
    }
    if (value.phase === 'stable') {
      evidence.approval = { ...evidence.approval, targetProfiles: value.approval?.targetProfiles ?? ['acp'] };
      return null;
    }
    assert(!['failed', 'interrupted', 'cancelled'].includes(value.phase), `task reached ${value.phase}: ${value.error?.message ?? value.message ?? ''}`);
    assert(round < 8, `task never stabilized: last phase ${value.phase}`);
    return { name: 'evolution_desktop', args: { action: 'status', taskId: approvalObserved.taskId, waitMs: 60_000 } };
  });

  const finalState = await readJson(stateFile(approvalObserved.taskId));
  assert(finalState?.phase === 'stable', `task did not reach stable: ${finalState?.phase} ${finalState?.error?.message ?? ''}`);
  evidence.desktopTask = {
    taskId: finalState.taskId,
    phase: finalState.phase,
    experimentId: finalState.experimentId,
    candidateSourceSha256: finalState.candidateSourceSha256,
    kernelSourceSha256: finalState.kernelSourceSha256,
    gates: finalState.gates,
    decision: finalState.decision,
    approval: finalState.approval,
    result: finalState.result,
  };

  const evidencePath = path.join(dataRoot, 'archive', 'experiments', `${finalState.experimentId}.evidence.json`);
  const evidenceBytes = await fs.readFile(evidencePath);
  const durable = JSON.parse(evidenceBytes);
  evidence.desktopRecovery = {
    evidenceSha256: sha(evidenceBytes),
    runtimeRecovered: durable.runtimeRecovered,
    gates: durable.gateEvidence?.gates,
    recoveryProof: { status: durable.recoveryProof?.status, beforeSha256: sha(JSON.stringify(durable.recoveryProof?.beforeFingerprint ?? null)), afterSha256: sha(JSON.stringify(durable.recoveryProof?.afterFingerprint ?? null)) },
  };
  assert(durable.runtimeRecovered === true && durable.recoveryProof?.status === 'recovered', 'Desktop recovery proof missing');
  assert(Object.values(durable.gateEvidence?.gates ?? {}).length >= 8 && Object.values(durable.gateEvidence.gates).every((value) => value === true), 'Desktop promotion gates did not all pass');

  const index = await readJson(publishedFile);
  const record = index?.plugins?.find((row) => row.experimentId === finalState.experimentId);
  assert(record, 'stable promotion was not published to the shared index');
  assert(record.publisherProfile === 'desktop', 'publication was not owned by Desktop');
  assert(record.stable?.committedAt, 'publication record has no stable commit');
  assert(JSON.stringify(record.approvedProfiles) === JSON.stringify(['acp']), 'publication approval scope differs from the owner approval');
  evidence.publication = { id: record.id, publisherProfile: record.publisherProfile, sourceSha256: record.sourceSha256, approvedProfiles: record.approvedProfiles, committedAt: record.stable.committedAt };
  evidence.steps.push({ name: 'desktop-stable-and-published', at: new Date().toISOString() });

  // 8. a fresh ACP process must mount and call the promoted plugin by itself.
  const indexBytes = await fs.readFile(publishedFile);
  const fresh = await createAcp('acp-fresh');
  let freshRound = 0;
  nextAction = (tools, result) => {
    freshRound += 1;
    const names = tools.map((tool) => tool.name);
    assert(!names.includes('evolution_trial') && !names.includes('evolution_promote'), `fresh ACP loaded the Evolution kernel: ${names.join(', ')}`);
    if (freshRound === 1) {
      assert(names.includes(plan.tool), `fresh ACP did not automatically mount the promoted tool ${plan.tool}: ${names.join(', ')}`);
      return { name: plan.tool, args: { text: 'ACP\nDesktop' } };
    }
    const value = toolResultValue(result);
    assert(value.characters === 11 && value.lines === 2, `unexpected promoted tool output: ${JSON.stringify(value)}`);
    evidence.freshConsumer = { tool: plan.tool, input: 'ACP\nDesktop', output: value };
    return null;
  };
  await fresh.rpc('session/prompt', { sessionId: fresh.sessionId, prompt: [{ type: 'text', text: '调用 Desktop 已晋升的文本统计工具，输入 ACP 换行 Desktop。' }] }, 120_000);
  assert(evidence.freshConsumer, 'fresh ACP never called the promoted tool');
  assert((await fs.readFile(publishedFile)).equals(indexBytes), 'new ACP process modified the Desktop publication index');
  const consumer = await readJson(consumerFile);
  const consumerRow = consumer?.plugins?.find((row) => row.id === record.id);
  assert(consumerRow?.status === 'active', `fresh ACP consumer status is ${consumerRow?.status}`);
  evidence.consumer = { status: consumerRow.status, id: consumerRow.id, observedIndexUpdatedAt: consumer.observedIndexUpdatedAt };
  await fresh.close();
  evidence.steps.push({ name: 'fresh-acp-consumed-promoted-plugin', at: new Date().toISOString() });

  // 9. restart Desktop: stable facts and terminal task state survive; nothing is re-run.
  await stopDesktop(desktop);
  desktop = null;
  desktop = await startDesktop('desktop-live');
  const secondReady = await waitFor(async () => {
    const ready = await liveHost();
    return ready !== null && ready.instanceId !== firstReady.instanceId ? ready : null;
  }, { timeoutMs: 180_000, what: 'Desktop restart readiness' });
  evidence.restart = { previousInstanceId: firstReady.instanceId, nextInstanceId: secondReady.instanceId, nextPid: secondReady.pid };
  const afterRestartState = await readJson(stateFile(approvalObserved.taskId));
  assert(afterRestartState?.phase === 'stable', `terminal task changed after restart: ${afterRestartState?.phase}`);
  assert(JSON.stringify(await readJson(publishedFile)) === JSON.stringify(index), 'publication index changed after restart');
  evidence.restart.terminalTaskPreserved = true;
  evidence.restart.publicationPreserved = true;
  evidence.steps.push({ name: 'desktop-restart-preserved-durable-facts', at: new Date().toISOString() });

  // 10. profile configuration was only changed by the official installer.
  for (const profile of profiles) {
    const current = await fs.readFile(path.join(home, 'profiles', profile, 'cordis.patch.yml'), 'utf8');
    assert(current === patchesBefore[profile], `profile ${profile} patch changed during acceptance`);
  }
  evidence.profilePatchesPreserved = true;
  evidence.ok = true;
} catch (error) {
  evidence.error = String(error?.message ?? error).slice(0, 1500);
  if (String(error?.message) !== 'OWNER_APPROVAL_REQUIRED') process.exitCode = 1;
} finally {
  // Join any in-flight prompt so its tool call owns its own lifetime.
  if (acp) { try { await acp.close(); } catch {} }
  for (const child of children) await stopDesktop(child);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  evidence.finishedAt = new Date().toISOString();
  evidence.tarballSha256 = sha(await fs.readFile(tarball));
  const redacted = JSON.stringify(evidence, null, 2).replaceAll(home, '$DSH_HOME').replaceAll(work, '<work>').replaceAll(repo.replace(/\/$/, ''), '<repo>');
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${redacted}\n`);
  console.log(`Evidence: ${out}; ok=${evidence.ok}${evidence.error ? `; ${evidence.error}` : ''}`);
}
