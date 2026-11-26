#!/usr/bin/env node
/** Quantify the synchronous latency the experience collector adds to a turn.
 *
 * Three independent measurements, all reproducible from an isolated home:
 *
 * 1. In-process distribution (primary evidence). A real Cordis Context and the
 *    real `lib/experience-collector.js` apply() drive the official `tools/result`
 *    emit synchronously. Every sample is accepted only if the real store's
 *    `stats()` shows the expected count change (one event for failure,
 *    degradation and recovery; none for a clean success).
 * 2. Fsync/WAL attribution. An isolated database with the same SQL transaction
 *    shape is timed under `synchronous=FULL` vs `NORMAL`. This is attribution
 *    only: NORMAL weakens durability and is NOT a candidate change.
 * 3. Real ACP end-to-end A/B with a deterministic loopback provider. A fresh
 *    copy of the pristine home is used for every session. Each session emits
 *    one real failed `read` and ends the turn. The measured interval is from
 *    the client-observed `tool_call_update` completion to the next provider
 *    request arrival, both timestamped in this parent process with the same
 *    monotonic clock. It includes host tool finalization + the collector +
 *    next-request construction. Model generation and network time are absent:
 *    the loopback provider answers immediately on request arrival.
 *
 * No formal DSH_HOME is read or written. All scratch state lives in a temp
 * directory and is removed on every exit path.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const THRESHOLD_MS = 50;
const ARMS = ['enabled', 'disabled', 'enabled2'];
const ROTATIONS = [
  ['enabled', 'disabled', 'enabled2'],
  ['disabled', 'enabled2', 'enabled'],
  ['enabled2', 'enabled', 'disabled'],
];

function usage() {
  return 'Usage: node scripts/benchmarks/experience-commit-latency.mjs --home <home> [--runtime <dir>] [--rounds 9] [--samples 50] [--out <file.json>] [--smoke]';
}

function parseArgs(argv) {
  const options = { rounds: 9, samples: 50, smoke: false, out: null, runtime: null, home: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--smoke') { options.smoke = true; continue; }
    if (arg === '--help' || arg === '-h') { console.log(usage()); process.exit(0); }
    const key = { '--home': 'home', '--runtime': 'runtime', '--rounds': 'rounds', '--samples': 'samples', '--out': 'out' }[arg];
    if (!key) throw new Error(`Unknown argument: ${arg}. ${usage()}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    if (key === 'rounds' || key === 'samples') {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${arg} must be a positive integer`);
      options[key] = number;
    } else options[key] = path.resolve(value);
  }
  if (!options.home) throw new Error(`--home is required. ${usage()}`);
  if (!options.runtime) options.runtime = path.join(path.dirname(options.home), 'runtime');
  if (options.smoke) {
    options.rounds = Math.min(options.rounds, 2);
    options.samples = Math.min(options.samples, 8);
  } else if (options.rounds < 9) {
    throw new Error(`Authoritative measurement requires --rounds >= 9 (got ${options.rounds}); use --smoke for a short non-authoritative run`);
  }
  return options;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1))];
}

function summarize(values) {
  if (values.length === 0) return { n: 0, p50: null, p95: null, p99: null, max: null };
  return { n: values.length,
    p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99),
    max: Math.max(...values) };
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function ms3(value, digits = 3) { return typeof value === 'number' ? Number(value.toFixed(digits)) : value; }

function assertInside(root, candidate, label) {
  const realRoot = fs.realpathSync(root);
  const real = fs.realpathSync(candidate);
  if (!fs.statSync(real).isDirectory() || (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`))) {
    throw new Error(`${label} escaped the scratch root: ${candidate}`);
  }
  return real;
}

function createScratch() {
  const base = process.env.TMPDIR || process.env.TEMP || os.tmpdir();
  const root = fs.mkdtempSync(path.join(base, 'dsh-evolution-commit-latency-'));
  const real = assertInside(base, root, 'scratch root');
  return real;
}

function validateHome(home) {
  const formal = path.resolve(os.homedir(), '.dsh');
  let realFormal = formal;
  try { realFormal = fs.realpathSync(formal); } catch {}
  const realHome = fs.realpathSync(home);
  if (!fs.statSync(realHome).isDirectory()) throw new Error(`--home is not a directory: ${home}`);
  if (realHome === formal || realHome === realFormal) throw new Error('Refusing the formal DSH_HOME');
  return realHome;
}

const cleanup = { dirs: new Set(), children: new Set(), servers: new Set() };
function cleanupAll() {
  for (const child of cleanup.children) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch {}
    }
  }
  for (const server of cleanup.servers) { try { server.close(); } catch {} }
  for (const dir of cleanup.dirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  cleanup.children.clear(); cleanup.servers.clear(); cleanup.dirs.clear();
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { cleanupAll(); process.exit(130); });
}

function freshDir(scratch, label) {
  const target = path.join(scratch, `${label}-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  return assertInside(scratch, target, label);
}

async function loadModules() {
  try {
    const [cordis, collector, store] = await Promise.all([
      import('@deepseek-ai/cordis'),
      import('../../lib/experience-collector.js'),
      import('../../lib/shared-experience.js'),
    ]);
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const readVersion = (name) => {
      try { return JSON.parse(fs.readFileSync(require.resolve(`${name}/package.json`), 'utf8')).version; }
      catch { return 'unknown'; }
    };
    return { Context: cordis.Context, applyCollector: collector.apply, openSharedExperience: store.openSharedExperience,
      versions: { cordis: readVersion('@deepseek-ai/cordis'),
        dshEvolution: JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version } };
  } catch (error) {
    throw new Error(`Cannot load the real collector/Cordis modules (run npm ci --ignore-scripts first): ${error.message}`);
  }
}

async function mountCollector(Context, applyCollector, openSharedExperience, scratch, label) {
  const storeDir = freshDir(scratch, `${label}-store`);
  const ctx = new Context();
  ctx.provide('tools', { register() {} });
  const fiber = ctx.plugin(applyCollector, { dshHome: scratch, experienceRoot: storeDir });
  await fiber.await();
  const probe = openSharedExperience(storeDir);
  return { ctx, fiber, probe, storeDir, close: async () => {
    try { probe.close(); } finally { await fiber.dispose(); }
  } };
}

const failedRead = (index) => ({
  isError: true,
  error: { message: 'fixture failure', info: { code: 'CODE_RUN_FAILED' } },
  content: [],
  callId: undefined,
  index,
});
const failureExec = (index) => ({ agent: { id: 'latency-agent' }, name: 'read', callId: `failure-${index}` });
const successExec = (index) => ({ agent: { id: 'latency-agent' }, name: 'read', callId: `success-${index}` });
const truncatedRead = {
  isError: false,
  value: { path: '/tmp/latency-truncated.json', offset: 1,
    lines: [{ number: 1, text: `${'x'.repeat(2000)}... (line truncated to 2000 chars)` }], totalLines: 1 },
};
const cleanRead = { isError: false, value: { path: '/tmp/latency-complete.json', offset: 1,
  lines: [{ number: 1, text: 'x'.repeat(3135) }], totalLines: 1 } };

async function measureInProcess(Context, applyCollector, openSharedExperience, scratch, samples) {
  const result = {};

  // (a) Failure: every emit must commit exactly one new event synchronously.
  {
    const mounted = await mountCollector(Context, applyCollector, openSharedExperience, scratch, 'failure');
    try {
      const first = [];
      const steady = [];
      let rejected = 0;
      for (let index = 0; index < samples; index += 1) {
        const before = mounted.probe.stats().events;
        const t0 = performance.now();
        mounted.ctx.emit('tools/result', failureExec(index), failedRead(index));
        const elapsed = performance.now() - t0;
        const after = mounted.probe.stats().events;
        if (after !== before + 1) { rejected += 1; continue; }
        (index === 0 ? first : steady).push(elapsed);
      }
      result.failure = { description: 'tools/result isError=true; one BEGIN IMMEDIATE/COMMIT per emit',
        firstCommit: summarize(first), steady: summarize(steady), rejectedSamples: rejected };
    } finally { await mounted.close(); }
  }

  // (b) Clean success: the listener must not write at all.
  {
    const mounted = await mountCollector(Context, applyCollector, openSharedExperience, scratch, 'success');
    try {
      const durations = [];
      let rejected = 0;
      for (let index = 0; index < samples; index += 1) {
        const before = mounted.probe.stats().events;
        const t0 = performance.now();
        mounted.ctx.emit('tools/result', successExec(index), cleanRead);
        const elapsed = performance.now() - t0;
        const after = mounted.probe.stats().events;
        if (after !== before) { rejected += 1; continue; }
        durations.push(elapsed);
      }
      result.cleanSuccess = { description: 'clean read; in-memory counters only, zero writes',
        emit: summarize(durations), rejectedSamples: rejected };
    } finally { await mounted.close(); }
  }

  // (c) Degradation: the commit is deferred by the real collector to the
  // agent/turn-stopping flush, NOT to tools/result. Both intervals are reported.
  {
    const mounted = await mountCollector(Context, applyCollector, openSharedExperience, scratch, 'degradation');
    try {
      const agent = { id: 'degradation-agent' };
      const first = [];
      const steady = [];
      const toolsOnly = [];
      let rejected = 0;
      for (let index = 0; index < samples; index += 1) {
        const exec = { agent, name: 'read', callId: `degraded-${index}` };
        const before = mounted.probe.stats().events;
        const t0 = performance.now();
        mounted.ctx.emit('tools/result', exec, truncatedRead);
        const afterTools = performance.now() - t0;
        const between = mounted.probe.stats().events;
        mounted.ctx.emit('agent/turn-stopping', { agent });
        const elapsed = performance.now() - t0;
        const after = mounted.probe.stats().events;
        if (between !== before || after !== before + 1) { rejected += 1; continue; }
        toolsOnly.push(afterTools);
        (index === 0 ? first : steady).push(elapsed);
      }
      result.degradation = {
        description: 'read with TRUNCATED_LINE; real collector defers the COMMIT to agent/turn-stopping',
        firstCommit: summarize(first), steady: summarize(steady), toolsResultOnly: summarize(toolsOnly),
        rejectedSamples: rejected,
      };
    } finally { await mounted.close(); }
  }

  // Extra: the failure-recovery boundary writes on the 5th consecutive clean
  // success after a failure (RECOVERY_SUCCESS_THRESHOLD).
  {
    const mounted = await mountCollector(Context, applyCollector, openSharedExperience, scratch, 'recovery');
    try {
      let rejected = 0;
      let elapsed = null;
      for (let attempt = 0; attempt < 3 && elapsed === null; attempt += 1) {
        const agent = { id: `recovery-agent-${attempt}` };
        const before = mounted.probe.stats().events;
        mounted.ctx.emit('tools/result', { agent, name: 'read', callId: `recovery-fail-${attempt}` },
          { isError: true, error: { info: { code: 'CODE_RUN_FAILED' } } });
        if (mounted.probe.stats().events !== before + 1) { rejected += 1; continue; }
        // The collector requires a strictly later millisecond for the recovery fact.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3);
        for (let index = 0; index < 4; index += 1) {
          mounted.ctx.emit('tools/result', { agent, name: 'read', callId: `recovery-ok-${attempt}-${index}` }, cleanRead);
        }
        if (mounted.probe.stats().events !== before + 1) { rejected += 1; continue; }
        const t0 = performance.now();
        mounted.ctx.emit('tools/result', { agent, name: 'read', callId: `recovery-ok-${attempt}-4` }, cleanRead);
        elapsed = performance.now() - t0;
        if (mounted.probe.stats().events !== before + 2) { elapsed = null; rejected += 1; }
      }
      result.recoveryAfterFiveSuccesses = { description: '5th clean success in a failure episode commits tool/recovery',
        oneCommit: elapsed === null ? null : { ms: elapsed }, rejectedAttempts: rejected };
    } finally { await mounted.close(); }
  }
  return result;
}

/** Same transaction shape as shared-experience record(), on an isolated DB. */
async function measureFsyncAttribution(scratch) {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = freshDir(scratch, 'attribution');
  const file = path.join(dir, 'attribution.sqlite');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    db.exec(`CREATE TABLE events (id BLOB PRIMARY KEY, digest BLOB NOT NULL, CHECK (length(id) = 32 AND length(digest) = 32)) STRICT, WITHOUT ROWID;
      CREATE TABLE knowledge (key TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE INDEX knowledge_recent ON knowledge(revision);
      CREATE TABLE clock (value INTEGER NOT NULL); INSERT INTO clock VALUES (0);`);
    const byId = db.prepare('SELECT digest FROM events WHERE id=?');
    const insertEvent = db.prepare('INSERT INTO events VALUES (?,?)');
    const tick = db.prepare('UPDATE clock SET value=value+1');
    const upsert = db.prepare('INSERT INTO knowledge VALUES (?,?,(SELECT value FROM clock)) ON CONFLICT(key) DO UPDATE SET body=excluded.body, revision=excluded.revision');
    const modes = ['FULL', 'NORMAL'];
    const samples = { FULL: [], NORMAL: [] };
    const iterations = 30;
    for (let index = 0; index < iterations; index += 1) {
      const order = index % 2 === 0 ? modes : [...modes].reverse();
      for (const mode of order) {
        db.exec(`PRAGMA synchronous=${mode}`);
        const id = createHash('sha256').update(`${mode}-${index}`).digest();
        const digestValue = createHash('sha256').update(`body-${mode}-${index}`).digest();
        const t0 = performance.now();
        db.exec('BEGIN IMMEDIATE');
        try {
          byId.get(id);
          insertEvent.run(id, digestValue);
          tick.run();
          upsert.run(`key-${index}`, '{"scope":"tool read"}');
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        samples[mode].push(performance.now() - t0);
      }
    }
    return {
      note: 'Attribution only. Same SQL transaction shape on an isolated DB; NORMAL weakens durability and is NOT a candidate.',
      iterationsPerMode: iterations,
      full: summarize(samples.FULL), normal: summarize(samples.NORMAL),
      medianDeltaMs: ms3(median(samples.FULL) - median(samples.NORMAL)),
    };
  } finally { db.close(); }
}

function disableExperienceEntries(homeCopy) {
  const patch = path.join(homeCopy, 'profiles', 'acp', 'cordis.patch.yml');
  const lines = fs.readFileSync(patch, 'utf8').split('\n');
  let changed = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*-\s*id:\s*evolution-experience(?:-history)?\s*$/.test(lines[index])) continue;
    for (let cursor = index + 1; cursor < Math.min(lines.length, index + 4); cursor += 1) {
      if (/^\s*-\s*id:/.test(lines[cursor])) break;
      if (/^\s*disabled:/.test(lines[cursor])) {
        lines[cursor] = lines[cursor].replace(/disabled:\s*\S+/, 'disabled: true');
        changed += 1;
        break;
      }
    }
  }
  if (changed !== 2) throw new Error(`Expected to disable exactly 2 experience entries, changed ${changed}`);
  fs.writeFileSync(patch, `${lines.join('\n')}`);
  return changed;
}

function startProvider() {
  const state = { hits: 0, toolCompletedAt: null, toolFailedObserved: false, intervals: [], requests: [], error: null };
  const server = http.createServer(async (req, res) => {
    const arrivedAt = performance.now();
    let body = '';
    for await (const chunk of req) body += chunk;
    let input;
    try { input = JSON.parse(body); } catch (error) { state.error = `invalid provider request: ${error.message}`; res.destroy(); return; }
    const stage = state.hits++;
    state.requests.push({ stage, arrivedAt, toolSchemaCount: (input.tools || []).length });
    if (stage === 1) {
      if (state.toolCompletedAt !== null) state.intervals.push(arrivedAt - state.toolCompletedAt);
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('message_start', { message: { id: `latency-${stage}`, type: 'message', role: 'assistant', model: 'loopback-fixture',
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    if (stage === 0) {
      const tool = (input.tools || []).find(candidate => /read.*file|file.*read|^read$/.test(candidate.name));
      if (!tool) { state.error = 'real read tool unavailable'; res.destroy(); return; }
      const pathKey = Object.keys(tool.input_schema?.properties || {}).find(key => /path/i.test(key)) || 'path';
      const args = { [pathKey]: path.join(os.tmpdir(), `dsh-latency-missing-${randomUUID()}.txt`) };
      const id = 'latency-call-0';
      send('content_block_start', { index: 0, content_block: { type: 'tool_use', id, name: tool.name, input: {} } });
      send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } });
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } });
    } else {
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Benchmark turn finished.' } });
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
    }
    send('message_stop', {});
    res.end();
  });
  return { server, state };
}

async function readStats(home, openSharedExperience) {
  const store = openSharedExperience(path.join(home, 'storages', 'evolution-experience'));
  try { return store.stats(); } finally { store.close(); }
}

async function runAcpSession({ arm, home, cli, scratch, openSharedExperience }) {
  const homeCopy = path.join(freshDir(scratch, `acp-${arm}`), 'home');
  fs.cpSync(home, homeCopy, { recursive: true, verbatimSymlinks: true });
  assertInside(scratch, homeCopy, `ACP copy (${arm})`);
  if (arm === 'disabled') disableExperienceEntries(homeCopy);
  const { server, state } = startProvider();
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  cleanup.servers.add(server);
  const overlay = path.join(homeCopy, 'latency-transport.yml');
  fs.writeFileSync(overlay, `- id: llm-deepseek\n  config:\n    baseURL: http://127.0.0.1:${server.address().port}\n    apiKeyEnv: EVOLUTION_LATENCY_KEY\n`);
  const child = spawn(cli, ['--profile', 'acp', '--patch', overlay], {
    cwd: homeCopy,
    env: { ...process.env, DSH_HOME: homeCopy, DSH_PROFILE: 'acp', EVOLUTION_LATENCY_KEY: 'loopback-fixture-only' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  cleanup.children.add(child);
  let stderr = '';
  child.stderr.on('data', value => { stderr += value; });
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let row; try { row = JSON.parse(line); } catch { return; }
    if (row.id !== undefined && pending.has(row.id)) {
      const resolve = pending.get(row.id); pending.delete(row.id); resolve(row);
      return;
    }
    if (row.method !== 'session/update') return;
    const update = row.params?.update;
    if (update?.sessionUpdate !== 'tool_call_update') return;
    if (update.status === 'failed' || update.status === 'completed') {
      if (state.toolCompletedAt === null) state.toolCompletedAt = performance.now();
      if (update.status === 'failed') state.toolFailedObserved = true;
    }
  });
  let sequence = 0;
  const rpc = (method, params) => {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 45000);
      pending.set(id, row => { clearTimeout(timer); row.error ? reject(new Error(`${method}: ${JSON.stringify(row.error)}`)) : resolve(row.result); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };
  const before = await readStats(homeCopy, openSharedExperience);
  let promptResult;
  try {
    await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const { sessionId } = await rpc('session/new', { cwd: homeCopy, mcpServers: [] });
    promptResult = await rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Read a missing file.' }] });
  } finally {
    child.stdin.end();
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(() => { try { child.kill('SIGTERM'); } catch {} resolve(); }, 1500)),
    ]);
    if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch {} }
    cleanup.children.delete(child);
    server.close();
    cleanup.servers.delete(server);
  }
  const after = await readStats(homeCopy, openSharedExperience);
  const statsDelta = { events: after.events - before.events, knowledge: after.knowledge - before.knowledge };
  const reasons = [];
  if (state.error) reasons.push(state.error);
  if (state.requests.length !== 2) reasons.push(`expected 2 provider requests, got ${state.requests.length}`);
  if (!state.toolFailedObserved) reasons.push('no failed tool_call_update observed');
  if (state.intervals.length !== 1) reasons.push(`expected 1 timed interval, got ${state.intervals.length}`);
  if (promptResult?.stopReason !== 'end_turn') reasons.push(`unexpected stop reason: ${promptResult?.stopReason}`);
  if (arm === 'disabled') {
    if (statsDelta.events !== 0) reasons.push(`disabled arm committed ${statsDelta.events} events`);
  } else if (statsDelta.events < 1) {
    reasons.push('no real shared-experience commit observed');
  }
  const intervalMs = state.intervals[0];
  if (!Number.isFinite(intervalMs) || intervalMs < 0) reasons.push('invalid interval');
  if (reasons.length) reasons.push(`stderr: ${stderr.slice(-600)}`);
  return { arm, intervalMs: Number.isFinite(intervalMs) ? ms3(intervalMs) : null, statsDelta,
    providerRequests: state.requests.length, toolFailedObserved: state.toolFailedObserved,
    stopReason: promptResult?.stopReason ?? null, valid: reasons.length === 0, reasons };
}

async function runAcp({ home, cli, scratch, rounds, openSharedExperience }) {
  const armSamples = Object.fromEntries(ARMS.map(arm => [arm, []]));
  const rows = [];
  const warmup = [];
  for (const arm of ARMS) {
    const warm = await runAcpSession({ arm, home, cli, scratch, openSharedExperience });
    warmup.push({ arm, valid: warm.valid, intervalMs: warm.intervalMs, reasons: warm.reasons });
  }
  for (let round = 0; round < rounds; round += 1) {
    const order = ROTATIONS[round % ROTATIONS.length];
    const row = { round: round + 1, order: order.join('->'), samples: {} };
    for (const arm of order) {
      const sample = await runAcpSession({ arm, home, cli, scratch, openSharedExperience });
      row.samples[arm] = sample;
      if (sample.valid) armSamples[arm].push(sample.intervalMs);
    }
    const enabled = row.samples.enabled;
    const disabled = row.samples.disabled;
    const enabled2 = row.samples.enabled2;
    row.paired = {
      disabledMinusEnabled: enabled.valid && disabled.valid ? ms3(disabled.intervalMs - enabled.intervalMs) : null,
      enabled2MinusEnabled: enabled.valid && enabled2.valid ? ms3(enabled2.intervalMs - enabled.intervalMs) : null,
    };
    rows.push(row);
  }
  const validPairs = rows.filter(row => row.paired.disabledMinusEnabled !== null);
  const aaPairs = rows.filter(row => row.paired.enabled2MinusEnabled !== null);
  return {
    timing: 'parent-process performance.now(): tool_call_update (failed/completed) -> next provider HTTP request arrival. Includes host tool finalization + collector + next request construction; excludes model generation and network.',
    provider: 'loopback deterministic Anthropic-compatible SSE; no external model calls, no credentials',
    warmup,
    rounds,
    arms: Object.fromEntries(ARMS.map(arm => [arm, { medianMs: ms3(median(armSamples[arm])),
      validSamples: armSamples[arm].length, rejectedSamples: rounds - armSamples[arm].length,
      intervals: armSamples[arm] }])),
    pairedDiff: {
      disabledMinusEnabled: { medianMs: ms3(median(validPairs.map(row => row.paired.disabledMinusEnabled))),
        perRound: validPairs.map(row => row.paired.disabledMinusEnabled) },
      enabled2MinusEnabled: { medianMs: ms3(median(aaPairs.map(row => row.paired.enabled2MinusEnabled))),
        perRound: aaPairs.map(row => row.paired.enabled2MinusEnabled) },
    },
    rows,
    invalidSamples: rows.flatMap(row => ARMS.filter(arm => !row.samples[arm].valid)
      .map(arm => ({ round: row.round, arm, reasons: row.samples[arm].reasons }))),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const home = validateHome(options.home);
  const cli = path.join(options.runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!fs.existsSync(cli)) throw new Error(`Official DSH CLI not found: ${cli} (check --runtime)`);
  const scratch = createScratch();
  cleanup.dirs.add(scratch);
  let report;
  try {
    const { Context, applyCollector, openSharedExperience, versions } = await loadModules();
    const inProcess = await measureInProcess(Context, applyCollector, openSharedExperience, scratch, options.samples);
    const attribution = await measureFsyncAttribution(scratch);
    const acp = await runAcp({ home, cli, scratch, rounds: options.rounds, openSharedExperience });
    const failureP95 = inProcess.failure.steady.p95;
    let dshVersion = 'unknown';
    try { dshVersion = JSON.parse(fs.readFileSync(path.join(options.runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version; } catch {}
    report = {
      task: 'DSH-EVOLUTION-PERF-R15-01',
      authoritative: !options.smoke,
      label: options.smoke ? 'NON-AUTHORITATIVE SMOKE' : 'AUTHORITATIVE',
      thresholdMs: THRESHOLD_MS,
      verdict: failureP95 === null ? 'NO DATA'
        : failureP95 >= THRESHOLD_MS ? 'THRESHOLD MET (>=50ms per failing tool call)' : 'NO CHANGE (<50ms per failing tool call)',
      environment: { node: process.version, platform: process.platform, home, runtime: options.runtime,
        cli, versions, dshVersion, samplesRequested: options.samples, roundsRequested: options.rounds, smoke: options.smoke },
      measurementNotes: [
        'Reporter clock is performance.now() in one process for both ACP endpoints (session/update tool_call_update -> provider HTTP request arrival).',
        'The in-process first commit includes lazy SQL statement preparation; steady percentiles exclude it.',
        'The real collector defers degradation writes to agent/turn-stopping, so its tools/result emit has no COMMIT; both timings are reported.',
        'The fsync comparison is attribution only on an isolated database; NORMAL weakens durability and is not a proposed change.',
        'Every accepted sample is gated by a real store.stats() delta; rejected samples are counted and fail the run.',
      ],
      inProcess, attribution, acp,
    };
  } finally { cleanupAll(); }
  const summary = {
    label: report.label,
    verdict: report.verdict,
    failure: { firstCommitMs: report.inProcess.failure.firstCommit.p50,
      steadyP50: report.inProcess.failure.steady.p50, steadyP95: report.inProcess.failure.steady.p95,
      steadyP99: report.inProcess.failure.steady.p99, steadyMax: report.inProcess.failure.steady.max },
    cleanSuccessP50: report.inProcess.cleanSuccess.emit.p50,
    degradation: { firstCommitMs: report.inProcess.degradation.firstCommit.p50,
      steadyP50: report.inProcess.degradation.steady.p50, steadyP95: report.inProcess.degradation.steady.p95 },
    recoveryMs: report.inProcess.recoveryAfterFiveSuccesses.oneCommit?.ms ?? null,
    fsyncAttributionMedianDeltaMs: report.attribution.medianDeltaMs,
    acpMedians: Object.fromEntries(ARMS.map(arm => [arm, report.acp.arms[arm].medianMs])),
    acpPaired: { disabledMinusEnabled: report.acp.pairedDiff.disabledMinusEnabled.medianMs,
      enabled2MinusEnabled: report.acp.pairedDiff.enabled2MinusEnabled.medianMs },
    invalidAcpSamples: report.acp.invalidSamples.length,
  };
  console.log(`SUMMARY ${JSON.stringify(summary, null, 2)}`);
  console.log(`REPORT ${JSON.stringify(report, null, 2)}`);
  if (options.out) {
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (options.smoke) console.log('NON-AUTHORITATIVE SMOKE: not a substitute for the Lead\'s serial authoritative run.');
  if (report.acp.invalidSamples.length > 0) {
    console.error(`INVALID ACP SAMPLES: ${JSON.stringify(report.acp.invalidSamples, null, 2)}`);
    process.exitCode = 1;
  }
  for (const group of ['failure', 'cleanSuccess', 'degradation']) {
    if (report.inProcess[group].rejectedSamples > 0) {
      console.error(`REJECTED IN-PROCESS SAMPLES in ${group}: ${report.inProcess[group].rejectedSamples}`);
      process.exitCode = 1;
    }
  }
}

await main();
