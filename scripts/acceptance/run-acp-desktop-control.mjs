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
 *   6. run the unified read-only self-evolution audit from a real ACP
 *      natural-language request: the real tool surface returns the stable-plugin
 *      and experience classification, writes no task, launches no Desktop
 *      process and changes no publication bytes;
 *   7. start a fresh ACP process and verify the promoted plugin is mounted and
 *      callable without touching Desktop;
 *   8. restart Desktop and verify the durable stable fact and task state survive.
 *
 * The model transport is a deterministic fixture; the ACP transport, the
 * official Desktop app, the Evolution kernel, its gates and persistence, the
 * task channel and the fresh-ACP consumer are real. It never touches the
 * formal `$DSH_HOME`, never reads production credentials and never publishes a
 * release.
 *
 * node scripts/acceptance/run-acp-desktop-control.mjs <packed.tgz> <evidence.json> [--work <dir>] [--approve <text>] [--ptc]
 * Without --approve the run stops at awaiting-owner-confirmation and reports the
 * bound identity instead of promoting.
 *
 * --ptc mounts the same PTC self-evolution preset the formal Desktop profile
 * uses on the isolated Desktop profile. The workload steps then have to run
 * through the official run_code transport; the archived sample rows record
 * which route carried each call, so a silent fall back to the native path is a
 * failed acceptance rather than a passing one.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startModelBridge, usageTotals } from './model-bridge.mjs';

const argv = process.argv.slice(2);
const positional = [];
let workArg = null;
let approveText = null;
let ptc = false;
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === '--work' && argv[index + 1]) workArg = path.resolve(argv[++index]);
  else if (arg === '--approve' && argv[index + 1]) approveText = argv[++index];
  else if (arg === '--ptc') ptc = true;
  else positional.push(arg);
}
const [tarballArg, outArg] = positional;
if (!tarballArg || !outArg) throw new Error('Usage: run-acp-desktop-control.mjs <packed.tgz> <evidence.json> [--work <dir>] [--approve <owner confirmation text>] [--ptc]');
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
/** Sorted relative paths of every regular file under a directory (missing = empty). */
async function listFiles(root) {
  const out = [];
  const walk = async (dir, prefix) => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else if (entry.isFile()) out.push({ path: rel, sha256: sha(await fs.readFile(path.join(dir, entry.name))) });
    }
  };
  await walk(root, '');
  return out;
}
async function pathExists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}
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

/**
 * Assert both workload phases took the official route the mode requires. The
 * kernel records the per-phase transport counters in the comparison the task
 * state keeps, so a silent fall back to the native path is a failed acceptance
 * instead of something inferred from timings or a compacted archive row.
 */
function assertWorkloadTransport(comparison, expected) {
  const other = expected === 'run_code' ? 'direct' : 'run_code';
  for (const phase of ['before', 'after']) {
    const counts = comparison?.[phase]?.transports;
    assert(counts && typeof counts === 'object', `the workload comparison has no ${phase} transport counters`);
    assert(Number.isInteger(counts[expected]) && counts[expected] > 0, `the ${phase} workload did not run through ${expected}`);
    assert(counts[other] === 0, `the ${phase} workload used ${counts[other]} ${other} call(s)`);
  }
  return { before: comparison.before.transports, after: comparison.after.transports };
}

const evidence = {
  kind: 'dsh-evolution-acp-desktop-control',
  ok: false,
  startedAt: new Date().toISOString(),
  modelTransport: 'deterministic loopback Anthropic responses for plan authoring and mounting; the autonomous-reuse pair uses real model inference through scripts/acceptance/model-bridge.mjs; actual ACP Agent/tools and actual Desktop app',
  scope: 'isolated DSH_HOME; production task channel + official Desktop kernel; no formal home, no release publish',
  steps: [],
  desktop: {},
  host: {},
  candidate: {},
  ptc: { enabled: ptc },
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
    nextAction = () => null;
    console.error(`Fixture: ${fixtureError}`);
    response.writeHead(500);
    response.end(fixtureError);
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const overlay = path.join(work, 'acp-transport.yml');
await fs.writeFile(overlay, `- id: llm-deepseek\n  config:\n    baseURL: http://127.0.0.1:${server.address().port}\n    apiKeyEnv: EVOLUTION_ACCEPTANCE_KEY\n`);

async function createAcp(label, { waitForPromoted = false, patch = overlay, collect = null } = {}) {
  const log = await fs.open(path.join(work, `${label}.stderr.log`), 'w', 0o600);
  const child = launch(cli, ['--profile', 'acp', '--patch', patch], {
    env: { ...autoLaunchEnv, DSH_HOME: home, EVOLUTION_ACCEPTANCE_KEY: 'local-fixture-only' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (bytes) => { stderr = (stderr + bytes).slice(-4000); });
  child.stdin.on('error', () => { /* a dead child is reported by the exit handler */ });
  const pending = new Map();
  let sequence = 0;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let row;
    try { row = JSON.parse(line); } catch { return; }
    if (row.method === 'session/request_permission') {
      const option = row.params.options.find((candidate) => candidate.kind === 'allow_once');
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: row.id, result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } })}\n`);
    } else if (row.id !== undefined) pending.get(row.id)?.(row);
    else if (row.method === 'session/update') {
      if (collect) collect.push(row.params?.update ?? {});
      if (row.params?.update?.sessionUpdate === 'tool_call') evidence.steps.push({ name: 'real-acp-tool-call', at: new Date().toISOString() });
    }
  });
  const rpc = (method, params, timeout = 60_000) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out; ${stderr.slice(-800)}`)); }, timeout);
    pending.set(id, (row) => { clearTimeout(timer); pending.delete(id); row.error ? reject(new Error(`${method}: ${JSON.stringify(row.error)}`)) : resolve(row.result); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  // A child that dies mid-request must fail the request instead of leaving the
  // caller parked until its own timeout with no diagnosis.
  child.once('exit', (code, signal) => {
    const detail = `ACP process exited (code ${code}, signal ${signal}); ${stderr.slice(-800)}`;
    for (const [, settle] of pending) settle({ error: { code: -32000, message: detail } });
    pending.clear();
  });
  await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const session = await rpc('session/new', { cwd: home, mcpServers: [] });
  if (waitForPromoted) {
    // The consumer mounts the published plugin from its own startup effect, so
    // `session/new` can resolve before that effect has registered the tool.
    // Wait for the durable activation record instead of sampling the first
    // model request at an arbitrary point in that sequence.
    const statePath = path.join(home, 'storages', 'evolution', 'shared-plugins', 'consumers', 'acp.json');
    const deadline = Date.now() + 15_000;
    for (;;) {
      const state = await readJson(statePath).catch(() => null);
      const active = !state?.disposedAt && (state?.plugins ?? []).some((plugin) => plugin.status === 'active');
      if (active) break;
      if (Date.now() > deadline) throw new Error('fresh ACP did not record an active promoted consumer');
      await sleep(100);
    }
    // The state is written after the plugin apply; give the ACP transport one
    // scheduling turn to publish the refreshed tool surface to the session.
    await sleep(250);
  }
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

// A generated single-line configuration is a legitimate source-inspection task:
// the official read tool deliberately truncates long lines. We keep those defaults.
const shortLine = 'export const answer = 42;';
const longLine = JSON.stringify({ name: 'generated-config', routes: Array.from({ length: 80 }, (_, i) => ({ path: `/feature/${i}`, enabled: i % 2 === 0 })), sentinel: 'end-of-config' });
const mediumLine = 'export const settings = ' + JSON.stringify({ route: '/workspace', flags: Array(30).fill('enabled') }) + ';';
const mediumFile = path.join(home, 'workflow-medium.js');
await fs.writeFile(mediumFile, mediumLine);
const shortFile = path.join(home, 'workflow-short.js');
const longFile = path.join(home, 'workflow-generated.json');
await fs.writeFile(shortFile, shortLine);
await fs.writeFile(longFile, longLine);
function makePlan(variant = 'benefit', { cleanName = false } = {}) {
  const suffix = crypto.randomBytes(4).toString('hex');
  // The first paired run used the harness's default opaque, suffixed name and a
  // description that only said what the tool *is*. A real model that had just
  // been truncated by `read` still chose `bash`, so the benefit case now names
  // the trigger the capability exists for. Only the model-facing name and
  // description change; the code, inputs and workload stay identical. A second
  // plan in the same home must keep the suffix, because the first one is already
  // mounted as a stable plugin.
  const tool = cleanName ? 'read_complete_line' : `read_complete_line_${suffix}`;
  const compositionName = `complete-line-${suffix}`;
  const description = variant === 'benefit'
    ? 'Read complete lines from small UTF-8 source files (64 KiB maximum). Use this instead of read when read reports a truncated line and the full line text is needed.'
    : 'Read complete lines from small UTF-8 source files (64 KiB maximum)';
  const host = `return { name: '${compositionName}', inject: ['tools', 'fs'], apply(ctx) {
    const tool = harness.defineTool({ name: '${tool}', description: ${JSON.stringify(description)},
      parameters: { file_path: { type: 'string', required: true }, offset: { type: 'number' }, limit: { type: 'number' } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, offset: { type: 'integer', required: true }, lines: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { number: { type: 'integer', required: true }, text: { type: 'string', required: true } } } }, totalLines: { type: 'integer', required: true } } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      isConcurrencySafe: () => true,
      execute: async ({ file_path, offset = 1, limit = 1 }, exec) => {
        if (!Number.isInteger(offset) || offset < 1 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('invalid bounded line window');
        const target = await ctx.fs.resolve(file_path, { cwd: exec.agent?.session.header.cwd, signal: exec.signal });
        const info = await ctx.fs.stat(target, exec.signal);
        if (!info || info.type !== 'file' || !Number.isInteger(info.size) || info.size > 65536) throw new Error('requires a regular UTF-8 file of at most 64 KiB');
        const content = await ctx.fs.readText(target, exec.signal);
        if (content.length > 65536) throw new Error('file grew beyond read bound');
        const all = content.split('\\n');
        const lines = all.slice(offset - 1, offset - 1 + limit).map((text, i) => ({ number: offset + i, text: ${variant === 'regression' ? "text.length > 30 ? 'incorrect' : text" : 'text'} }));
        return { path: target.displayPath, offset, lines, totalLines: all.length };
      } }); harness.registerTool(ctx, tool);
  } };`;
  const targetFile = variant === 'regression' ? mediumFile : variant === 'no-benefit' ? shortFile : longFile;
  const expected = variant === 'regression' ? mediumLine : variant === 'no-benefit' ? shortLine : longLine;
  return { suffix, tool, compositionName, host, sourceSha256: sha(host), plan: {
    proposal: { why: 'A real official read truncated a generated configuration line; inspect the full selected line without a shell or host patch.',
      target: `plugin:${compositionName}`, impactScope: ['isolated-source-inspection'],
      successMetrics: ['exact complete line and unchanged short-file control', 'bounded dispatch latency and serialized result bytes'],
      benefitModel: { kind: 'workflow' }, strategy: `bounded full-line source inspection through the official filesystem service; hypothesis ${variant}` },
    composition: { name: compositionName, purpose: 'Complete bounded source-line inspection', code: { host } },
    verification: { targetTool: tool, observations: 2,
      samples: [{ label: 'short-file capability self-test', tool, arguments: { file_path: shortFile, offset: 1, limit: 1 }, expected: { path: shortFile, offset: 1, lines: [{ number: 1, text: shortLine }], totalLines: 1 } }],
      workload: { kind: 'workflow', id: `complete-source-line-${variant}`, repetitions: variant === 'insufficient' ? 1 : 5, steps: [
        { name: 'read', candidateName: tool, role: 'target', arguments: { file_path: targetFile, offset: 1, limit: 1 }, resultPath: ['lines', '0', 'text'], expected },
        { name: 'read', candidateName: tool, role: 'target', arguments: { file_path: mediumFile, offset: 1, limit: 1 }, resultPath: ['lines', '0', 'text'], expected: mediumLine },
        { name: 'read', role: 'control', arguments: { file_path: shortFile, offset: 1, limit: 1 }, resultPath: ['lines', '0', 'text'], expected: shortLine },
      ] },
    }, requestedTargetProfiles: ['acp', 'web'],
  } };
}
let plan = null;

// The client launches the official app binary from DSH_DESKTOP_APP_BINARY when
// it is set. The acceptance points it at a wrapper that keeps Electron's
// user-data directory inside the isolated work tree, so auto-launch does not
// read or write the operator's real Desktop application state.
const autoLaunchUserData = path.join(work, 'electron-autolaunch');
const autoLaunchWrapper = path.join(work, 'desktop-autolaunch.sh');
// The spawn log is the receipt that only the documented auto-launch path (and
// not the read-only audit) started the application through this wrapper.
const autoLaunchSpawnLog = path.join(work, 'desktop-autolaunch-spawns.log');
await fs.writeFile(autoLaunchWrapper, `#!/bin/sh\necho "\$\$" >> ${JSON.stringify(autoLaunchSpawnLog)}\nexec ${JSON.stringify(binary)} --user-data-dir=${JSON.stringify(autoLaunchUserData)} "$@"\n`, { mode: 0o700 });
const autoLaunchEnv = { ...env, DSH_DESKTOP_APP_BINARY: autoLaunchWrapper };

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

  // 2b. --ptc mounts the same preset the formal Desktop profile uses. Everything
  //     else stays the installer's output; the expected patch is recorded so the
  //     final "profiles changed only as declared" check can tell the two apart.
  const livePatches = { ...patchesBefore };
  if (ptc) {
    const presetFile = path.join(repo, 'scripts', 'acceptance', 'fixtures', 'self-evolution-preset.cordis.patch.yml');
    const presetPatch = await fs.readFile(presetFile, 'utf8');
    // The task host resolves the Desktop default preset; select self-evolution
    // exactly as the formal profile does instead of mounting it by hand.
    const presetConfig = '\n- id: agent-preset-registry\n  config:\n    default: standard\n    selectedDefault: self-evolution\n';
    livePatches.desktop = patchesBefore.desktop + presetPatch + presetConfig;
    await fs.writeFile(path.join(home, 'profiles', 'desktop', 'cordis.patch.yml'), livePatches.desktop);
    evidence.ptc = {
      enabled: true,
      preset: { source: path.relative(repo, presetFile), sha256: sha(presetPatch) },
      selectedDefault: 'self-evolution',
    };
    evidence.steps.push({ name: 'ptc-self-evolution-preset-mounted', at: new Date().toISOString() });
  }

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
  await runPrompt('acp-discovery', '用官方 read 读取生成配置的完整第一行，判断末尾 sentinel 是否可见。', (tools, result, round) => {
    if (round === 1) return { name: 'read', args: { file_path: longFile, offset: 1, limit: 1 } };
    assert(result?.is_error !== true, 'discovery read failed');
    const text = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
    assert(text.includes('line truncated') && !text.includes('end-of-config'), 'official read did not reproduce the real long-line limitation');
    evidence.discovery = { source: 'official read in a real ACP session', issue: 'complete first source line unavailable due to default line truncation',
      inputSha256: sha(longLine), expectedCharacters: longLine.length, observedResultSha256: sha(text), model: 'deterministic plan-authoring fixture, no live model inference' };
    plan = makePlan('benefit', { cleanName: true });
    evidence.candidate = { tool: plan.tool, compositionName: plan.compositionName, sourceSha256: plan.sourceSha256 };
    return null;
  });

  evidence.negativeWorkloads = [];
  for (const variant of ['no-benefit', 'regression', 'insufficient']) {
    const rejected = makePlan(variant);
    let outcome;
    await runPrompt(`acp-${variant}`, `验证 ${variant} 候选，不批准晋升。`, (tools, result, round) => {
      assertKernelFree(tools);
      if (round === 1) return { name: 'evolution_desktop', args: { action: 'delegate', plan: rejected.plan, cwd: home } };
      const value = toolResultValue(result);
      if (['accepted', 'running'].includes(value.phase)) return { name: 'evolution_desktop', args: { action: 'status', taskId: value.taskId, waitMs: 60000 } };
      assert(value.phase === 'failed' && value.error?.code === 'E_DESKTOP_BENEFIT_UNPROVEN', `negative ${variant} did not stop before approval: ${JSON.stringify(value)}`);
      const expected = variant === 'insufficient' ? 'insufficient-evidence' : variant;
      assert(value.decision?.kind === expected, `negative ${variant} decision was ${value.decision?.kind}`);
      outcome = value;
      return null;
    });
    const state = await readJson(stateFile(outcome.taskId));
    const transport = assertWorkloadTransport(state?.workload?.comparison, ptc ? 'run_code' : 'direct');
    assert(state.revert?.ok === true, 'negative workload did not prove runtime cleanup');
    assert(!(await readJson(publishedFile))?.plugins?.some((row) => row.experimentId === outcome.experimentId), 'negative candidate was published');
    evidence.negativeWorkloads.push({ variant, taskId: outcome.taskId, experimentId: outcome.experimentId, phase: outcome.phase,
      decision: outcome.decision, gates: outcome.gates, revert: state.revert, workload: state.workload,
      transport });
  }

  // A workflow claim now requires paired real-session evidence. This
  // deterministic runner does not produce that artifact, so the workload-only
  // plan must stop at the benefit gate instead of reaching owner confirmation;
  // the promotion/canary/publication stages below stay for a run that supplies
  // task evidence (see docs/design/task-coupled-evidence.md).
  let workloadRejected = null;
  await runPrompt('acp-delegate', '请自我进化：补齐生成配置完整长行读取能力。用 evolution_desktop 把它作为真实进化任务交给 Desktop；先停在所有者确认前，不要自行批准。', (tools, result, round) => {
    assertKernelFree(tools);
    if (round === 1) return { name: 'evolution_desktop', args: { action: 'delegate', plan: plan.plan, cwd: home } };
    const value = toolResultValue(result);
    if (round === 2) {
      assert(value.action === 'delegate', `unexpected delegate result action: ${value.action}`);
      if (value.phase === 'failed' && value.error?.code === 'E_DESKTOP_BENEFIT_UNPROVEN') {
        // This plan claims a workflow benefit but carries no paired real-session
        // evidence. The new gate must be the *only* reason it stopped, otherwise
        // the script would silently accept an unrelated failure as proof that
        // the gate works.
        const gates = value.gates ?? {};
        assert(gates.taskBenefit === false, 'a rejected workload-only plan did not report taskBenefit=false');
        for (const key of ['realBenefit', 'measuredEvidence', 'repeatable', 'regressionTest', 'reversible', 'cleanupEvidence', 'noOrphans', 'workflowBenefit']) {
          assert(gates[key] === true, `the workload-only plan failed an unrelated gate: ${key}=${gates[key]}`);
        }
        workloadRejected = value;
        return null;
      }
      assert(plan.plan.verification.task !== undefined,
        'a workload-only plan reached owner confirmation; the taskBenefit gate did not run');
      assert(value.phase === 'awaiting-owner-confirmation', `delegate did not stop at the owner gate: ${value.phase} ${value.message ?? ''}`);
      assert(value.experimentId && value.candidateSourceSha256 === plan.sourceSha256, 'delegate identity does not match the candidate');
      approvalObserved = { taskId: value.taskId, experimentId: value.experimentId, sourceSha256: value.candidateSourceSha256, gates: value.gates, decision: value.decision };
      return { name: 'evolution_desktop', args: { action: 'status', taskId: value.taskId } };
    }
    assert(value.phase === 'awaiting-owner-confirmation', 'status left the owner gate without approval');
    return null;
  });
  if (workloadRejected) {
    const state = await readJson(stateFile(workloadRejected.taskId));
    assert(state?.revert?.ok === true, 'a rejected workload-only plan did not prove runtime cleanup');
    assert(!(await readJson(publishedFile))?.plugins?.some((row) => row.experimentId === workloadRejected.experimentId),
      'a rejected workload-only candidate was published');
    // The workflow gate is the only missing evidence: the paired workload must
    // have run through the mode's official route and produced a complete,
    // sufficient comparison whose target improved over the baseline.
    const comparison = state?.workload?.comparison;
    const transport = assertWorkloadTransport(comparison, ptc ? 'run_code' : 'direct');
    assert(comparison?.benefit === true, `the workload-only plan reported no benefit: ${JSON.stringify(comparison?.reasons ?? null).slice(0, 400)}`);
    assert(comparison?.workload?.sufficient === true, 'the workload-only plan did not complete five consistent repetitions');
    assert(comparison?.before?.errors > 0 || comparison?.workload?.efficiency === true,
      'the workload benefit is neither a correctness improvement nor a repeated execution-cost improvement');
    evidence.workloadOnlyPromotion = {
      taskId: workloadRejected.taskId,
      experimentId: workloadRejected.experimentId,
      phase: workloadRejected.phase,
      error: workloadRejected.error,
      gates: workloadRejected.gates,
      decision: workloadRejected.decision,
      revert: state.revert,
      workload: state.workload,
      transport,
    };
    evidence.ok = false;
    evidence.blocked = 'a workload-only workflow claim is rejected: taskBenefit (paired real-session evidence) is required and this deterministic runner does not produce it';
    process.exitCode = 0;
    throw new Error('TASK_BENEFIT_REQUIRED');
  }
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
          targetProfiles: ['acp', 'web'],
        },
      };
    }
    const value = toolResultValue(result);
    if (value.action === 'confirm') {
      assert(value.ok === true, `confirm failed: ${value.message ?? value.code}`);
      return { name: 'evolution_desktop', args: { action: 'status', taskId: approvalObserved.taskId, waitMs: 60_000 } };
    }
    if (value.phase === 'stable') {
      evidence.approval = { ...evidence.approval, targetProfiles: value.approval?.targetProfiles ?? ['acp', 'web'] };
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
    workload: finalState.workload,
  };

  const evidencePath = path.join(dataRoot, 'archive', 'experiments', `${finalState.experimentId}.evidence.json`);
  const evidenceBytes = await fs.readFile(evidencePath);
  const durable = JSON.parse(evidenceBytes);
  evidence.desktopRecovery = {
    evidenceSha256: sha(evidenceBytes),
    runtimeRecovered: durable.runtimeRecovered,
    workflowObservation: durable.latestObservation?.probe ?? durable.observations?.at(-1)?.probe ?? null,
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
  assert(JSON.stringify(record.approvedProfiles) === JSON.stringify(['acp', 'web']), 'publication approval scope differs from the owner approval');
  evidence.publication = { id: record.id, publisherProfile: record.publisherProfile, sourceSha256: record.sourceSha256, approvedProfiles: record.approvedProfiles, committedAt: record.stable.committedAt };
  evidence.steps.push({ name: 'desktop-stable-and-published', at: new Date().toISOString() });

  const reuseProfile = async (profile) => {
    const receipt = path.join(work, `workflow-reuse-${profile}.json`);
    const probeUrl = pathToFileURL(path.join(repo, 'scripts/acceptance/probes/workflow-reuse-probe.mjs')).href;
    const addition = `\n- insert:\n    - id: workflow-reuse-${profile}\n      name: '${probeUrl}'\n`;
    const profilePatch = path.join(home, 'profiles', profile, 'cordis.patch.yml');
    const overlayFile = path.join(work, `workflow-reuse-${profile}.yml`);
    if (profile === 'desktop') await fs.writeFile(profilePatch, livePatches[profile] + addition);
    else await fs.writeFile(overlayFile, addition);
    const log = await fs.open(path.join(work, `workflow-reuse-${profile}.log`), 'w', 0o600);
    const child = launch(profile === 'desktop' ? binary : cli,
      profile === 'desktop' ? [`--user-data-dir=${electronLive}`] : ['--profile', 'web', '--patch', overlayFile, '--', '--no-open', '--host', '127.0.0.1', '--port', '0'],
      { stdio: ['ignore', log.fd, log.fd], env: { ...env, DSH_HOME: home, EVOLUTION_WORKFLOW_RECEIPT: receipt,
        EVOLUTION_WORKFLOW_TOOL: plan.tool, EVOLUTION_WORKFLOW_FILE: longFile, EVOLUTION_WORKFLOW_SHA: sha(longLine), EVOLUTION_WORKFLOW_PROFILE: profile } });
    try {
      const result = await waitFor(() => readJson(receipt), { timeoutMs: 120000, what: `${profile} workflow reuse` });
      assert(result.ok === true, `${profile} workflow reuse failed: ${result.error}`);
      evidence[`${profile}Reuse`] = result;
    } finally {
      await stop(child); await log.close();
      if (profile === 'desktop') await fs.writeFile(profilePatch, livePatches[profile]);
    }
  };

  // 8. a fresh ACP process must mount and call the promoted plugin by itself.
  const indexBytes = await fs.readFile(publishedFile);
  const fresh = await createAcp('acp-fresh', { waitForPromoted: true });
  let freshRound = 0;
  nextAction = (tools, result) => {
    freshRound += 1;
    const names = tools.map((tool) => tool.name);
    assert(!names.includes('evolution_trial') && !names.includes('evolution_promote'), `fresh ACP loaded the Evolution kernel: ${names.join(', ')}`);
    if (freshRound === 1) {
      assert(names.includes(plan.tool), `fresh ACP did not automatically mount the promoted tool ${plan.tool}: ${names.join(', ')}`);
      return { name: plan.tool, args: { file_path: longFile, offset: 1, limit: 1 } };
    }
    const value = toolResultValue(result);
    assert(value.lines?.[0]?.text === longLine, `unexpected promoted tool output: ${JSON.stringify(value)}`);
    evidence.freshConsumer = { tool: plan.tool, inputSha256: sha(longLine), outputSha256: sha(value.lines[0].text), complete: true };
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

  // 8b. Autonomous reuse, measured against a paired baseline.
  //
  // The steps above prove the tool is mounted and callable. They also hand the
  // model the exact tool and arguments, which is not evidence that a model
  // would choose it later. Here a real model answers real ACP requests through
  // the bridge (scripts/acceptance/model-bridge.mjs) with a natural task and
  // the live tool surface; the prompt never names the promoted tool. The
  // baseline session runs the same task and the same model with the capability
  // revoked for this profile, so the only difference is the capability.
  const bridge = await startModelBridge({ cwd: path.join(work, 'bridge-cwd') });
  const bridgeOverlay = path.join(work, 'acp-bridge-transport.yml');
  await fs.writeFile(bridgeOverlay, `- id: llm-deepseek\n  config:\n    baseURL: ${bridge.baseURL}\n    apiKeyEnv: EVOLUTION_ACCEPTANCE_KEY\n`);
  const naturalTask = '读取 workflow-generated.json 的第一行，告诉我该文件 sentinel 字段的值。';
  const runRealModelTask = async (label, { expectMounted }) => {
    const updates = [];
    const session = await createAcp(`acp-real-${label}`, {
      patch: bridgeOverlay,
      waitForPromoted: expectMounted,
      collect: updates,
    });
    const before = bridge.turns.length;
    const startedAt = Date.now();
    try {
      await session.rpc('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: naturalTask }] }, 30 * 60 * 1000);
    } finally {
      await session.close();
    }
    const wallMs = Date.now() - startedAt;
    const turns = bridge.turns.slice(before);
    const failedTurns = turns.filter((turn) => turn.ok !== true);
    assert(failedTurns.length === 0, `${label}: ${failedTurns.length} model turn(s) failed: ${JSON.stringify(failedTurns.slice(0, 2))}`);
    // Auxiliary requests (for example a session-title completion) carry no tool
    // list; they are reported separately so they cannot inflate the paired
    // decision metrics.
    const decisionTurns = turns.filter((turn) => (turn.tools?.length ?? 0) > 0);
    const assistantText = updates
      .filter((update) => update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text')
      .map((update) => update.content.text).join('');
    const toolNames = decisionTurns.flatMap((turn) => turn.decision?.tool ? [turn.decision.tool] : []);
    return {
      label,
      expectMounted,
      wallMs,
      modelTurns: decisionTurns.length,
      auxiliaryTurns: turns.length - decisionTurns.length,
      toolCalls: toolNames,
      usedPromotedTool: toolNames.includes(plan.tool),
      usage: usageTotals(decisionTurns),
      answeredSentinel: /end-of-config/.test(assistantText),
      answerSha256: sha(assistantText),
      answerCharacters: assistantText.length,
      transport: 'real model inference (opencode run, same provider/model as the ACP profile) executed by the real ACP host; token counts are the model bill for each decision turn',
    };
  };

  evidence.realModelReuse = { task: naturalTask, model: 'opencode-go/deepseek-v4.1-flash', candidate: null, baseline: null, comparison: null };
  evidence.realModelReuse.candidate = await runRealModelTask('candidate', { expectMounted: true });
  evidence.steps.push({ name: 'real-model-autonomous-reuse', at: new Date().toISOString() });

  // Paired baseline: revoke this record for the acp profile, then run the same
  // task with the same model in a fresh process. The revocation is reverted
  // afterwards so the isolated home keeps the state the promotion produced.
  await command(process.execPath, [path.join(repo, 'scripts/shared-plugins.mjs'), 'disable',
    '--plugin', record.id, '--profile', 'acp', '--home', home, '--reason', 'acceptance paired baseline']);
  evidence.realModelReuse.baseline = await runRealModelTask('baseline', { expectMounted: false });
  await command(process.execPath, [path.join(repo, 'scripts/shared-plugins.mjs'), 'enable',
    '--plugin', record.id, '--profile', 'acp', '--home', home]);
  evidence.steps.push({ name: 'real-model-paired-baseline', at: new Date().toISOString() });

  const candidateRun = evidence.realModelReuse.candidate;
  const baselineRun = evidence.realModelReuse.baseline;
  evidence.realModelReuse.comparison = {
    sameTask: true,
    sameModel: true,
    onlyCapabilityDiffers: !baselineRun.usedPromotedTool,
    candidateAnswered: candidateRun.answeredSentinel,
    baselineAnswered: baselineRun.answeredSentinel,
    candidateTurns: candidateRun.modelTurns,
    baselineTurns: baselineRun.modelTurns,
    candidateToolCalls: candidateRun.toolCalls.length,
    baselineToolCalls: baselineRun.toolCalls.length,
    candidateInputTokens: candidateRun.usage.inputTokens,
    baselineInputTokens: baselineRun.usage.inputTokens,
    candidateOutputTokens: candidateRun.usage.outputTokens,
    baselineOutputTokens: baselineRun.usage.outputTokens,
    candidateWallMs: candidateRun.wallMs,
    baselineWallMs: baselineRun.wallMs,
    unknown: [
      'DSH-native token accounting is not exposed by the host; token counts are the real model bill measured by the transport',
      'one paired run per condition is not a statistical confidence interval',
    ],
  };
  assert(candidateRun.modelTurns > 0 && baselineRun.modelTurns > 0, 'a real-model session produced no model turns');
  await bridge.close();

  await reuseProfile('web');

  // 9. the unified read-only self-evolution audit is reachable from a real ACP
  //    natural-language request. The deterministic model only chooses the tool;
  //    the classification is read from the real durable index by the real ACP
  //    client. The audit must write no task file, start no Desktop process,
  //    register no kernel tool and leave the publication bytes untouched.
  const indexBeforeAudit = await fs.readFile(publishedFile);
  const inboxBeforeAudit = await listFiles(path.join(channel, 'inbox'));
  const stateBeforeAudit = await listFiles(path.join(channel, 'state'));
  const hostBeforeAudit = await liveHost();
  assert(hostBeforeAudit?.instanceId === firstReady.instanceId, 'the Desktop host changed before the ACP audit');
  let auditValue = null;
  await runPrompt('acp-audit', '请先做一次统一的自我进化检查（只读）：审计已经发布的 stable 插件与经验证据，报告分类和下一步。不要提交新的进化任务，也不要启动 Desktop。', (tools, result, round) => {
    assertKernelFree(tools);
    if (round === 1) return { name: 'evolution_desktop', args: { action: 'audit' } };
    const value = toolResultValue(result);
    assert(value.ok === true, `the ACP audit failed: ${value.code ?? ''} ${value.message ?? ''}`);
    assert(value.action === 'audit', `unexpected ACP audit action: ${value.action}`);
    assert(value.readOnly === true, 'the ACP audit does not declare itself read-only');
    assert(value.taskId === undefined, 'the ACP audit created a task');
    assert(typeof record.host?.dsh === 'string' && record.host.dsh !== '', 'the published record has no verified host identity');
    assert(value.stable?.kind === 'dsh-evolution-self-evolution-review', `unexpected stable review kind: ${value.stable?.kind}`);
    assert(value.stable?.readOnly === true && value.selfEvolution?.readOnly === true, 'the ACP audit classification is not read-only');
    assert(Array.isArray(value.stable?.records), 'the ACP audit returned no stable-plugin records');
    assert(Number.isInteger(value.stable?.indexRecordCount) && value.stable.indexRecordCount >= 1, `the ACP audit found no published record: ${JSON.stringify({ count: value.stable?.indexRecordCount, truncated: value.stable?.truncated })}`);
    assert(typeof value.selfEvolution?.kind === 'string' && Array.isArray(value.selfEvolution?.nextActions), 'the ACP audit returned no ordered decision');
    const row = (value.stable.records ?? []).find((entry) => entry.id === record.id);
    assert(row, `the ACP audit did not classify the published record ${record.id}`);
    // The fresh ACP consumer above mounted this exact record on this host, so a
    // host-identity fallback failure must surface as pending-revalidation or
    // verify-host here, never as a silent closed-status pass. The audit must see
    // the same installed host the publisher verified on, with a complete
    // identity, and report the record active with no action.
    assert(row.status === 'active', `the ACP audit did not report the mounted record as active: ${row.status} ${JSON.stringify(row.reasons ?? [])}`);
    assert(row.action === null, `the active record still carries action ${JSON.stringify(row.action)}`);
    assert(value.host?.dsh === record.host?.dsh, `the ACP audit host ${JSON.stringify(value.host?.dsh)} is not the verified host ${JSON.stringify(record.host?.dsh)}`);
    assert(typeof value.host?.cordis === 'string' && value.host.cordis !== '' && typeof value.host?.include === 'string' && value.host.include !== '', `the ACP audit could not prove the host identity: ${JSON.stringify(value.host)}`);
    assert(value.selfEvolution?.incomplete !== true, 'the ACP audit reports an incomplete review');
    assert(value.selfEvolution?.kind !== 'verify-host' && value.selfEvolution?.primary !== 'verify-host', `the ACP audit reported an unprovable host identity: ${JSON.stringify({ kind: value.selfEvolution?.kind, primary: value.selfEvolution?.primary })}`);
    assert(!(value.selfEvolution.nextActions ?? []).some((entry) => entry.recordId === row.id), `the ACP audit advises an action for the active record: ${JSON.stringify(value.selfEvolution.nextActions)}`);
    auditValue = value;
    return null;
  });
  assert(auditValue, 'the ACP audit never returned a classification');
  assert((await fs.readFile(publishedFile)).equals(indexBeforeAudit), 'the ACP audit changed the publication index');
  assert(JSON.stringify(await listFiles(path.join(channel, 'inbox'))) === JSON.stringify(inboxBeforeAudit), 'the ACP audit wrote a task file');
  assert(JSON.stringify(await listFiles(path.join(channel, 'state'))) === JSON.stringify(stateBeforeAudit), 'the ACP audit wrote a task state');
  assert(!await pathExists(autoLaunchSpawnLog), 'the ACP audit launched the Desktop application');
  const hostAfterAudit = await liveHost();
  assert(hostAfterAudit?.instanceId === hostBeforeAudit.instanceId, 'the ACP audit replaced the Desktop host');
  const auditedRow = auditValue.stable.records.find((entry) => entry.id === record.id);
  evidence.audit = {
    action: auditValue.action,
    readOnly: auditValue.readOnly,
    host: auditValue.host,
    stableStatus: auditValue.stable.status ?? null,
    indexRecordCount: auditValue.stable.indexRecordCount ?? null,
    indexTruncated: auditValue.stable.truncated ?? null,
    stableRecord: auditedRow ?? null,
    selfEvolution: {
      kind: auditValue.selfEvolution.kind ?? null,
      primary: auditValue.selfEvolution.primary ?? null,
      hasBlockingStableIssue: auditValue.selfEvolution.hasBlockingStableIssue ?? null,
      incomplete: auditValue.selfEvolution.incomplete === true,
      nextActions: auditValue.selfEvolution.nextActions ?? [],
    },
    indexDigestBefore: sha(indexBeforeAudit),
    indexDigestAfter: sha(await fs.readFile(publishedFile)),
    taskFilesWritten: false,
    desktopLaunched: false,
  };
  evidence.steps.push({ name: 'acp-audit-read-only-classification', at: new Date().toISOString() });

  // 10. restart Desktop: stable facts and terminal task state survive; nothing is re-run.
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

  // New sessions execute the exact published workflow through the official pipeline.
  await stopDesktop(desktop);
  desktop = null;
  await reuseProfile('desktop');

  // 11. auto-launch: with no Desktop host running, a real ACP delegation starts
  //     the official app through the client and still stops at the owner gate.
  await stopDesktop(desktop);
  desktop = null;
  await waitFor(async () => (await liveHost()) === null, { timeoutMs: 60_000, what: 'script-owned Desktop shutdown' });
  const autoPlan = makePlan();
  let autoGate = null;
  await runPrompt('acp-autolaunch', '当前没有运行中的 Desktop。请用 evolution_desktop 启动官方 Desktop 并提交这个自我进化任务，停在所有者确认前，不要批准。', (tools, result, round) => {
    assertKernelFree(tools);
    if (round === 1) return { name: 'evolution_desktop', args: { action: 'delegate', plan: autoPlan.plan, cwd: home } };
    const value = toolResultValue(result);
    if (round === 2) {
      assert(value.phase === 'awaiting-owner-confirmation', `auto-launched Desktop did not reach the gate: ${value.phase} ${value.message ?? ''}`);
      assert(value.candidateSourceSha256 === autoPlan.sourceSha256, 'auto-launch candidate identity mismatch');
      autoGate = value;
      return { name: 'evolution_desktop', args: { action: 'status', taskId: value.taskId } };
    }
    assert(value.phase === 'awaiting-owner-confirmation', 'auto-launched status left the owner gate');
    return null;
  });
  assert(autoGate, 'auto-launch delegation never reached the owner gate');
  const autoReady = await liveHost();
  assert(autoReady !== null && autoReady.instanceId !== secondReady.instanceId, 'the client did not start a new Desktop host');
  // The negative control for the audit above: the documented auto-launch path
  // really does spawn the application through the same wrapper.
  assert(await pathExists(autoLaunchSpawnLog), 'the auto-launch did not use the isolated wrapper');
  evidence.autoLaunch = {
    hostInstanceId: autoReady.instanceId,
    hostPid: autoReady.pid,
    profile: autoReady.profile,
    phase: autoGate.phase,
    tool: autoPlan.tool,
    experimentId: autoGate.experimentId,
    candidateSourceSha256: autoGate.candidateSourceSha256,
  };
  evidence.steps.push({ name: 'acp-auto-launched-official-desktop', at: new Date().toISOString() });
  // Tear down only the application instance this acceptance launched.
  const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  for (const line of ps.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    if (!match[2].includes(`--user-data-dir=${autoLaunchUserData}`)) continue;
    try { process.kill(Number(match[1]), 'SIGTERM'); } catch {}
  }
  await waitFor(async () => (await liveHost()) === null, { timeoutMs: 60_000, what: 'auto-launched Desktop shutdown' });
  evidence.autoLaunch.stopped = true;
  evidence.steps.push({ name: 'acceptance-launched-desktop-stopped', at: new Date().toISOString() });

  // 12. profile configuration was only changed by the official installer.
  for (const profile of profiles) {
    const current = await fs.readFile(path.join(home, 'profiles', profile, 'cordis.patch.yml'), 'utf8');
    assert(current === livePatches[profile], `profile ${profile} patch changed during acceptance`);
  }
  evidence.profilePatchesPreserved = true;
  evidence.ok = true;
} catch (error) {
  evidence.error = String(error?.message ?? error).slice(0, 1500);
  if (!['OWNER_APPROVAL_REQUIRED', 'TASK_BENEFIT_REQUIRED'].includes(String(error?.message))) process.exitCode = 1;
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
