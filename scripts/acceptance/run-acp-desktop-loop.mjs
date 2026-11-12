#!/usr/bin/env node
/** Targeted isolated ACP -> Desktop -> Evolution -> stable -> fresh ACP proof.
 * Reuses the verified Desktop/profile-probe launch mechanism. The ACP's real
 * shell tool starts and joins Desktop, instead of reading a pre-produced result.
 * This does NOT implement authenticated task submission to an already-running
 * production Desktop. Model responses are deterministic loopback fixtures;
 * tools, runner, Desktop lifecycle and ACP transport are real.
 *
 * node scripts/acceptance/run-acp-desktop-loop.mjs <packed.tgz> <evidence.json>
 * Prints the prepared candidate location and waits for an experiment-bound
 * owner approval JSON beside the task; never manufactures that approval.
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
const [tarballArg, outArg, workArg] = process.argv.slice(2);
const retryDesktopLaunch = process.argv.includes('--retry-desktop-launch');
const consumeIndex = process.argv.indexOf('--consume-task');
const consumeTask = consumeIndex >= 0 ? path.resolve(process.argv[consumeIndex + 1]) : null;
if (!tarballArg || !outArg) throw new Error('Usage: run-acp-desktop-loop.mjs <packed.tgz> <evidence.json>');
const tarball = path.resolve(tarballArg), out = path.resolve(outArg);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const cli = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const work = workArg ? path.resolve(workArg) : await fs.mkdtemp(path.join(os.tmpdir(), 'acp-desktop-evolution-'));
if (!work.startsWith(`${os.tmpdir()}${path.sep}`)) throw new Error('Acceptance work must be under the temporary directory');
const home = path.join(work, 'home');
await fs.mkdir(home, { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_')));
delete env.ELECTRON_RUN_AS_NODE;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const evidence = { kind: 'dsh-evolution-acp-desktop-loop', ok: false, startedAt: new Date().toISOString(),
  modelTransport: 'deterministic loopback Anthropic responses; actual ACP Agent/tools', externalModelCalls: 0,
  scope: 'isolated fresh Desktop launch via test-only profile probe; no production Desktop task submission API', steps: [] };
const children = new Set();
function launch(command, args, options = {}) {
  const child = spawn(command, args, { cwd: home, env: { ...env, DSH_HOME: home }, ...options });
  children.add(child); child.once('exit', () => children.delete(child)); return child;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exit; clearTimeout(timer);
}
async function command(command, args) {
  const child = launch(command, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: repo });
  let text = ''; child.stdout.on('data', b => { text += b; }); child.stderr.on('data', b => { text += b; });
  const [code] = await once(child, 'exit'); assert(code === 0, `Setup failed: ${text.slice(-1000)}`); return text;
}
async function readJson(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }

let action, lastToolResult, fixtureError, promptError, promptFinished = false;
const server = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const bytes of req) raw += bytes;
    const input = JSON.parse(raw);
    const result = input.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).findLast(b => b.type === 'tool_result');
    if (result) lastToolResult = result;
    const tools = input.tools ?? [];
    const selected = action?.(tools); action = null;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('message_start', { message: { id: crypto.randomUUID(), type: 'message', role: 'assistant', model: 'deepseek-v4-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    if (selected) {
      evidence.steps.push({ name: 'real-acp-model-tool-request', tool: selected.name, at: new Date().toISOString() });
      console.log(`ACP requests real tool: ${selected.name}; argument keys: ${Object.keys(selected.args).join(',')}`);
      send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: crypto.randomUUID(), name: selected.name, input: {} } });
      send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(selected.args) } });
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } });
    } else {
      send('content_block_start', { index: 0, content_block: { type: 'text', text: 'Acceptance tool call completed.' } });
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
    }
    send('message_stop', {}); res.end();
  } catch (error) { fixtureError = String(error.message); console.error(`Fixture: ${fixtureError}`); res.writeHead(500); res.end(String(error.message)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const overlay = path.join(work, 'acp-transport.yml');
await fs.writeFile(overlay, `- id: llm-deepseek\n  config:\n    baseURL: http://127.0.0.1:${server.address().port}\n    apiKeyEnv: EVOLUTION_ACCEPTANCE_KEY\n`);
async function acp() {
  const child = launch(cli, ['--profile', 'acp', '--patch', overlay], { env: { ...env, DSH_HOME: home, EVOLUTION_ACCEPTANCE_KEY: 'local-fixture-only' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', b => { stderr = (stderr + b).slice(-3000); });
  const pending = new Map(); let sequence = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let row; try { row = JSON.parse(line); } catch { return; }
    if (row.method === 'session/request_permission') {
      const option = row.params.options.find(o => o.kind === 'allow_once');
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: row.id, result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } })}\n`);
    } else if (row.id !== undefined) pending.get(row.id)?.(row);
    else if (row.method === 'session/update' && row.params?.update?.sessionUpdate === 'tool_call') evidence.steps.push({ name: 'real-acp-tool-call', at: new Date().toISOString() });
  });
  const rpc = (method, params, timeout = 40000) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out; ${stderr.slice(-500)}`)); }, timeout);
    pending.set(id, row => { clearTimeout(timer); pending.delete(id); row.error ? reject(new Error(`${method}: ${JSON.stringify(row.error)}`)) : resolve(row.result); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const session = await rpc('session/new', { cwd: home, mcpServers: [] });
  return { child, rpc, sessionId: session.sessionId };
}
let prepared, activePrompt;
try {
  console.log(`Isolated work: ${work}`);
  // Official Desktop initialization is required before official plugin install.
  if (!await readJson(path.join(home, 'profiles', 'desktop', 'package.json'))) {
  const initLog = await fs.open(path.join(work, 'desktop-init.log'), 'w', 0o600);
  const init = launch(binary, [`--user-data-dir=${path.join(work, 'electron-init')}`], { stdio: ['ignore', initLog.fd, initLog.fd] });
  try {
    for (let n = 0; n < 240; n++) {
      if (await readJson(path.join(home, 'profiles', 'desktop', 'package.json'))) break;
      assert(init.exitCode === null, 'Desktop initialization exited early'); await sleep(250);
    }
    assert(await readJson(path.join(home, 'profiles', 'desktop', 'package.json')), 'Desktop initialization timed out');
  } finally { await stop(init); await initLog.close(); }
  }
  // Reused homes must execute the requested artifact, not a prior same-version build.
  await command(process.execPath, [path.join(repo, 'scripts/setup-experience.mjs'), '--tarball', tarball, '--home', home, '--cli', cli, '--apply']);
  const patches = Object.fromEntries(await Promise.all(['desktop', 'acp', 'web'].map(async profile => [profile, await fs.readFile(path.join(home, 'profiles', profile, 'cordis.patch.yml'), 'utf8')])));
  const resumedRequest = consumeTask ? await readJson(consumeTask) : null;
  const generatedId = consumeTask ? null : `acp_text_stats_${crypto.randomBytes(4).toString('hex')}`;
  const id = resumedRequest?.id ?? generatedId;
  // Only the fixed prefix + random hex name enters source. A resumed task is
  // consumed as data and never used to construct another candidate.
  const hostCode = consumeTask ? null : `const tool = harness.defineTool({ name: '${generatedId}', description: 'Read-only text character and line counts', parameters: { text: { type: 'string', required: true } }, output: { schema: { type: 'object', properties: { characters: { type: 'integer', required: true }, lines: { type: 'integer', required: true } }, additionalProperties: false }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] }, isConcurrencySafe: () => true, execute: async ({ text }) => ({ characters: text.length, lines: text.split('\\n').length }) }); return { name: '${generatedId}', inject: ['tools'], apply(ctx) { harness.registerTool(ctx, tool); } };`;
  const taskPath = consumeTask ?? path.join(work, `${id}.task.json`);
  console.log(`ACP task: ${taskPath}`);
  if (!consumeTask) await fs.writeFile(taskPath, JSON.stringify({ id, toolName: id, hostCode, cwd: home }, null, 2), { mode: 0o600 });
  evidence.sandboxRetry = retryDesktopLaunch ? 'individually approved isolated Desktop launch after observed Electron EPERM; test permission granted by task/full-stop, no global policy change' : null;
  if (!consumeTask) {
  const first = await acp();
  const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  const cmd = [process.execPath, path.join(repo, 'scripts/acceptance/run-desktop-task.mjs'), home, taskPath].map(shellQuote).join(' ');
  action = tools => {
    assert(!tools.some(t => t.name === 'evolution_trial' || t.name === 'evolution_promote'), 'ACP loaded the Evolution kernel');
    const shell = tools.find(t => /shell|bash|terminal|exec/.test(t.name));
    assert(shell, `ACP shell tool absent: ${tools.map(t => t.name).join(', ')}`);
    const properties = shell.input_schema.properties;
    const key = ['command', 'script', 'code', 'cmd'].find(k => k in properties);
    assert(key, `Unknown real shell schema: ${JSON.stringify(properties)}`);
    return { name: shell.name, args: { [key]: cmd, ...(retryDesktopLaunch ? { sandbox_permissions: 'danger-full-access', justification: '同一隔离 Desktop 启动命令已被当前沙箱拒绝；本次端到端验收需要单次启动本机 Electron，不更改全局沙箱策略。' } : {}), description: 'Run isolated Desktop Evolution and await owner approval', ...('timeoutMs' in properties ? { timeoutMs: 1900000 } : {}) } };
  };
  const prompt = activePrompt = first.rpc('session/prompt', { sessionId: first.sessionId, prompt: [{ type: 'text', text: 'Launch the isolated Desktop Evolution task using the shell command supplied for acceptance; await its real stable result. Do not run an Evolution kernel in ACP.' }] }, 33 * 60 * 1000).then(() => { promptFinished = true; }, error => { promptError = error; });
  // The shell starts Desktop; the outer driver only observes its pending approval.
  for (let n = 0; n < 720; n++) {
    if (promptError || fixtureError) throw promptError || new Error(fixtureError);
    if (promptFinished) throw new Error(`ACP returned before Desktop preparation: ${JSON.stringify(lastToolResult).slice(0, 1500)}`);
    prepared = await readJson(`${taskPath}.prepared.json`);
    const result = await readJson(`${taskPath}.result.json`);
    if (result?.ok === false) throw new Error(`Desktop failed: ${result.error}`);
    if (prepared) break;
    await sleep(250);
  }
  assert(prepared, 'ACP did not start and measure the Desktop task within 180 seconds');
  console.log(`OWNER_APPROVAL_REQUIRED ${JSON.stringify({ taskPath, preparedPath: `${taskPath}.prepared.json`, approvalPath: `${taskPath}.approval.json`, experimentId: prepared.experimentId, sourceSha256: prepared.sourceSha256, toolName: id })}`);
  await prompt;
  if (promptError) throw promptError;
  assert(lastToolResult && !lastToolResult.is_error, 'ACP Desktop launch tool failed');
  await stop(first.child);
  }
  const desktop = await readJson(`${taskPath}.result.json`);
  assert(desktop?.ok && desktop.phase === 'stable', 'Desktop did not complete stable');
  evidence.desktop = { ...desktop, measured: { phase: desktop.measured.phase, gates: desktop.measured.gates, decision: { kind: desktop.measured.decision?.kind, eligible: desktop.measured.decision?.eligible, reasons: desktop.measured.decision?.reasons } } };
  evidence.authorization = await readJson(`${taskPath}.approval.json`);
  if (consumeTask) evidence.resumedAt = 'fresh ACP consumption only; Desktop stable lifecycle not repeated';
  const dataRoot = path.join(home, 'storages', 'evolution');
  const recoveryBytes = await fs.readFile(path.join(dataRoot, 'archive', 'experiments', `${desktop.experimentId}.evidence.json`));
  const recovery = JSON.parse(recoveryBytes);
  evidence.desktopRecovery = { evidenceSha256: sha(recoveryBytes), runtimeRecovered: recovery.runtimeRecovered,
    gates: recovery.gateEvidence?.gates, cleanupProof: recovery.cleanupProof,
    recoveryProof: { status: recovery.recoveryProof?.status,
      beforeSha256: sha(JSON.stringify(recovery.recoveryProof?.beforeFingerprint ?? null)),
      afterSha256: sha(JSON.stringify(recovery.recoveryProof?.afterFingerprint ?? null)) } };
  assert(recovery.runtimeRecovered === true && recovery.recoveryProof?.status === 'recovered', 'Desktop recovery proof missing');
  assert(Object.values(recovery.gateEvidence?.gates ?? {}).length >= 8
    && Object.values(recovery.gateEvidence.gates).every(value => value === true), 'Desktop promotion gates did not all pass');
  const statePath = path.join(dataRoot, 'shared-plugins', 'consumers', 'acp.json');
  // Explicit fault injection of the exact legacy host-only report. Stable facts
  // remain Desktop-owned and untouched; no plugin failure record is cleared.
  const { hostDigest } = await import('../../lib/promoted-sharing.js');
  const previous = await readJson(statePath);
  await fs.writeFile(statePath, JSON.stringify({ ...previous, plugins: [{ id: desktop.record.id, status: 'failed', reason: 'include-unavailable', sourceSha256: desktop.record.sourceSha256, hostDigest: hostDigest(desktop.record.host), errorCode: 'INACTIVE_EFFECT' }] }));
  evidence.injectedConsumerFault = 'legacy include-unavailable report, same source and host; published index untouched';
  const beforeIndex = sha(await fs.readFile(path.join(dataRoot, 'shared-plugins', 'published.json')));
  const fresh = await acp(); lastToolResult = null;
  action = tools => {
    assert(!tools.some(t => t.name === 'evolution_trial' || t.name === 'evolution_promote'), 'Fresh ACP loaded the Evolution kernel');
    assert(tools.filter(t => t.name === id).length === 1, 'Fresh ACP did not automatically load exactly one promoted tool');
    return { name: id, args: { text: 'ACP\nDesktop' } };
  };
  await fresh.rpc('session/prompt', { sessionId: fresh.sessionId, prompt: [{ type: 'text', text: 'Call the Desktop-promoted text statistics tool on ACP newline Desktop.' }] });
  assert(lastToolResult && !lastToolResult.is_error, 'Actual ACP promoted tool call failed');
  const content = typeof lastToolResult.content === 'string' ? lastToolResult.content : lastToolResult.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const decoded = JSON.parse(content);
  assert(decoded.characters === 11 && decoded.lines === 2, `Unexpected ACP output: ${content}`);
  evidence.acpToolResult = { tool: id, input: 'ACP\nDesktop', content };
  evidence.consumer = await readJson(statePath);
  assert(evidence.consumer.plugins.find(p => p.id === desktop.record.id)?.status === 'active', 'Fresh ACP did not report active');
  assert(beforeIndex === sha(await fs.readFile(path.join(dataRoot, 'shared-plugins', 'published.json'))), 'ACP modified Desktop publication index');
  await stop(fresh.child);
  for (const profile of Object.keys(patches)) assert(patches[profile] === await fs.readFile(path.join(home, 'profiles', profile, 'cordis.patch.yml'), 'utf8'), `Profile ${profile} patch changed`);
  evidence.profilePatchesPreserved = true;
  evidence.ok = true;
} catch (error) {
  evidence.error = String(error.message).slice(0, 1500); process.exitCode = 1;
} finally {
  // Join the real shell tool so its Desktop child and temporary patch finish
  // cleanup before ending the owning ACP session.
  if (activePrompt) await Promise.race([activePrompt, sleep(8000)]);
  for (const child of children) await stop(child);
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  evidence.finishedAt = new Date().toISOString();
  evidence.tarballSha256 = sha(await fs.readFile(tarball));
  const redacted = JSON.stringify(evidence, null, 2).replaceAll(home, '$DSH_HOME').replaceAll(work, '<work>').replaceAll(repo.replace(/\/$/, ''), '<repo>');
  await fs.mkdir(path.dirname(out), { recursive: true }); await fs.writeFile(out, `${redacted}\n`);
  console.log(`Evidence: ${out}; ok=${evidence.ok}${evidence.error ? `; ${evidence.error}` : ''}`);
  // Keep this isolated home for evidence/debugging; never touch formal user data.
}
