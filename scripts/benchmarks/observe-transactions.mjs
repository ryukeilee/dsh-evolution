// Evaluation only: the batching prototype is generated in a temporary copy of
// pinned main, never imported by the plugin. See the accompanying report.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';

const repo = path.resolve(import.meta.dirname, '../..');
const source = '02a91adcf47c3d0f3911cc40b6795cd5a1fccc9c';
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-observe-transactions-'));
const histories = option('--histories', '0,100,1000').split(',').map(Number);
const bursts = option('--bursts', '1,8,32').split(',').map(Number);
const rounds = Number(option('--rounds', '4'));
const modes = ['A', 'A-control', 'B'];
const implementations = {};

function extract(name) {
  const directory = path.join(temp, name);
  fs.mkdirSync(directory);
  execFileSync('tar', ['-x', '-C', directory], { input: execFileSync('git', ['archive', source, 'lib'], { cwd: repo, maxBuffer: 32 * 1024 * 1024 }) });
  fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(directory, 'node_modules'));
  return directory;
}

// A bounded adjacent-observe group, sealed by every other queued operation or
// when its existing promise-chain job starts. No timer or background worker.
// Intentionally retained as a REJECTED candidate: a failed group rejects valid
// neighbours too. The counterexample below must continue to demonstrate this.
function prototype(directory) {
  const file = path.join(directory, 'lib/domain-storage.js');
  let text = fs.readFileSync(file, 'utf8');
  const replace = (from, to) => { assert.equal(text.split(from).length, 2); text = text.replace(from, to); };
  replace('  function enqueue(job) {', '  let observationBatch = null;\n  function enqueue(job) {\n    observationBatch = null;');
  replace('    observe: dto => enqueue(() => mutate((_memory, store) => store.record(projectObservation(dto)))),', `    observe: dto => {
      if (closing) return Promise.reject(new Error('E_DOMAIN_CLOSED'));
      if (!observationBatch) {
        const group = { inputs: [] };
        group.promise = enqueue(async () => {
          if (observationBatch === group) observationBatch = null;
          return mutate(async (_memory, store) => {
            const results = [];
            for (const input of group.inputs) results.push(await store.record(projectObservation(input)));
            return results;
          });
        });
        observationBatch = group;
      }
      const group = observationBatch;
      const index = group.inputs.push(dto) - 1;
      if (group.inputs.length === 32) observationBatch = null;
      return group.promise.then(results => results[index]);
    },`);
  fs.writeFileSync(file, text);
}

let measuring = false;
let counts = {};
let stageNames = new Set();
const originals = [];
function increment(name, amount = 1) { if (measuring) counts[name] = (counts[name] ?? 0) + amount; }
function wrap(object, name, fn) {
  const original = object[name]; originals.push(() => { object[name] = original; });
  object[name] = fn(original);
}
for (const name of ['mkdirSync', 'readFileSync', 'writeFileSync', 'writeSync', 'fsyncSync', 'linkSync', 'renameSync', 'rmSync', 'statSync', 'lstatSync', 'readdirSync']) {
  wrap(fs, name, original => function (...values) {
    increment(name);
    if (measuring && name === 'mkdirSync' && path.basename(String(values[0])).startsWith('stage-') && !stageNames.has(String(values[0]))) {
      stageNames.add(String(values[0]));
      increment('transactions');
    }
    return original.apply(this, values);
  });
}
wrap(fsp, 'open', original => async function (...values) {
  const handle = await original.apply(this, values);
  for (const method of ['writeFile', 'sync']) {
    const saved = handle[method];
    handle[method] = function (...inputs) {
      increment(`async.${method}`);
      if (method === 'writeFile') increment('async.writeBytes', Buffer.byteLength(inputs[0]));
      return saved.apply(this, inputs);
    };
  }
  return handle;
});
wrap(fsp, 'rename', original => async function (...values) { increment('async.rename'); return original.apply(this, values); });
syncBuiltinESMExports();

async function session(name, root) {
  fs.mkdirSync(root, { recursive: true });
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const listeners = new Map();
  const ctx = { emit() {}, effect() {}, logger: { warn() {} }, on: (key, value) => listeners.set(key, value),
    storage: { backend: { get: () => backend } }, dynamicCordisRunner: {}, tools: { register() {} }, systemPrompt: { section() {} } };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const config = { presetDir: root, eventBridgePath: path.join(root, 'events.jsonl'), eventBridgeKey: 'b'.repeat(64), startupDrift: false,
    patternThreshold: 3, autonomousStrategies: { AGENT_ERROR: { risk: 'medium', target: 'plugin:fix' }, TOOL_ERROR: { risk: 'medium', target: 'plugin:fix' } } };
  const port = await implementations[name].openDomainStorage(ctx, config);
  const domain = ctx.storageDomain.get('evolution_domain');
  const set = domain.global.set.bind(domain.global);
  domain.global.set = async value => { increment('domainSets'); return set(value); };
  const core = implementations[name].apply(ctx, { ...config, domainStorage: port });
  const outcomes = [];
  let firstCandidateMs = null;
  let started;
  const observe = core.observeAutonomous.bind(core);
  core.observeAutonomous = (...values) => {
    const promise = observe(...values);
    outcomes.push(promise.then(result => {
      if (firstCandidateMs === null && result.candidate) firstCandidateMs = performance.now() - started;
      return result;
    }));
    return promise;
  };
  return { port, domain, backend, async burst(size) {
    started = performance.now();
    for (let index = 0; index < size; index++) {
      if (index % 2 === 0) listeners.get('agent/error')({ agent: { id: 'bench' }, error: Object.assign(new Error('provider unavailable'), { code: 'AGENT_ERROR' }) });
      else listeners.get('tools/result')({ agent: { id: 'bench' }, name: 'bench' }, { isError: true, code: 'TOOL_ERROR', message: 'tool unavailable' });
    }
    const results = await Promise.all(outcomes);
    assert.equal(results.length, size);
    assert.equal(core.experiments.size, 0);
    assert.equal(port.autonomousObservations().length, size);
    if (size >= 8) {
      assert.deepEqual(results.slice(0, 4).map(row => row.phase), Array(4).fill(name === 'B' ? 'candidate-awaiting-confirmation' : 'pattern-observing'));
    }
    return { firstCandidateMs, phases: results.map(row => row.phase), occurrences: results.map(row => row.occurrences ?? row.candidate?.observationIds.length) };
  }, async close() { try { await port.close(); } finally { await backend.close(); } } };
}

async function sample(name, fixture, history, burst, round) {
  const root = path.join(temp, `sample-${name}-${history}-${burst}-${round}`);
  fs.cpSync(fixture, root, { recursive: true });
  const current = await session(name, root);
  global.gc?.();
  const before = process.memoryUsage();
  const cpu = process.cpuUsage();
  const started = performance.now();
  counts = {}; stageNames = new Set(); measuring = true;
  const result = await current.burst(burst);
  measuring = false;
  const elapsedMs = performance.now() - started;
  const used = process.cpuUsage(cpu);
  const after = process.memoryUsage();
  const io = { ...counts };
  await current.close();
  const reopened = await session(name, root);
  assert.equal(reopened.port.query('observations').count, history + burst);
  assert.equal(reopened.port.autonomousObservations().length, burst);
  await reopened.close();
  return { name, history, burst, round, elapsedMs, cpuMs: (used.user + used.system) / 1000,
    heapDeltaBytes: after.heapUsed - before.heapUsed, rssBefore: before.rss, rssAfter: after.rss, io, ...result };
}

async function counterexample(name, kind) {
  const root = path.join(temp, `failure-${name}-${kind}`);
  const current = await session(name, root);
  const dto = index => ({ code: 'AGENT_ERROR', type: 'agent/error', observationId: `obs-${index}`, patternKey: `autonomous-v1:${'a'.repeat(64)}` });
  const inputs = [dto(1), dto(2), dto(3)];
  if (kind === 'projection') Object.defineProperty(inputs[1], 'code', { get() { throw new Error('INJECTED_PROJECTION_FAILURE'); } });
  else {
    const set = current.domain.global.set.bind(current.domain.global);
    let fail = true;
    current.domain.global.set = async value => {
      if (fail) { fail = false; throw new Error('INJECTED_COMMIT_FAILURE'); }
      return set(value);
    };
  }
  const outcomes = await Promise.allSettled(inputs.map(input => current.port.observe(input)));
  const ids = current.port.autonomousObservations().map(row => row.observationId);
  let closeError;
  try { await current.close(); } catch (error) { closeError = error.message; }
  const restarted = await session(name, root);
  const restartedIds = restarted.port.autonomousObservations().map(row => row.observationId);
  await restarted.close();
  assert.deepEqual(restartedIds, ids);
  const expected = name === 'B' ? [] : kind === 'projection' ? ['obs-1', 'obs-3'] : ['obs-2', 'obs-3'];
  assert.deepEqual(ids, expected);
  return { name, kind, statuses: outcomes.map(row => row.status), ids, restartedIds, closeError };
}

try {
  for (const name of modes) {
    const directory = extract(name);
    if (name === 'B') prototype(directory);
    implementations[name] = { ...await import(pathToFileURL(path.join(directory, 'lib/domain-storage.js'))), ...await import(pathToFileURL(path.join(directory, 'lib/registration.js'))) };
  }
  const rows = [];
  for (const history of histories) {
    const fixture = path.join(temp, `fixture-${history}`);
    const current = await session('A', fixture);
    for (let index = 0; index < history; index++) {
      const suffix = index.toString(16).replace(/[0-9a-f]/g, digit => 'ABCDEFGHIJKLMNOP'[Number.parseInt(digit, 16)]);
      await current.port.observe({ code: `HISTORY_${suffix}`, type: index % 2 ? 'agent/error' : 'tool/error' });
    }
    await current.close();
    // Warm each module's code before measured samples; warm samples use their
    // own roots and are not included in the report.
    for (const name of modes) await sample(name, fixture, history, 8, 'warm');
    for (const burst of bursts) for (let round = 0; round < rounds; round++) {
      for (const name of round % 2 ? [...modes].reverse() : modes) rows.push(await sample(name, fixture, history, burst, round));
    }
  }
  const failures = [];
  for (const kind of ['projection', 'commit']) for (const name of ['A', 'B']) failures.push(await counterexample(name, kind));
  const report = { source, node: process.version, platform: `${process.platform}/${process.arch}`, rounds, histories, bursts,
    method: 'Alternating A/A-control/B and B/A-control/A; official storage; registered listeners; fresh copied synthetic root per sample; startup/seed/reopen excluded; lightweight I/O counters included in all arms; medium-risk threshold 3; no Trial',
    rows, failures };
  const output = option('--out', null);
  if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  measuring = false;
  for (const restore of originals.reverse()) restore();
  syncBuiltinESMExports();
  fs.rmSync(temp, { recursive: true, force: true });
}
