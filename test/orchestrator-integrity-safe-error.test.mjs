// P1-2: raw error text must not reach a durable record or the inspect output.
// The four shapes below are the ones the audit observed surviving the archive,
// the event bridge, the failure memory and evolution_runtime_inspect.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { EvolutionOrchestrator, safeErrorDto } from '../lib/orchestrator.js';
import { apply } from '../lib/registration.js';
import { context } from './fixtures/runtime-inspect.mjs';

const SECRETS = [
  'sk-live-SECRET-999999999999',
  'AKIAIOSFODNN7EXAMPLE',
  'password=hunter2',
  'postgres://admin:s3cr3tP4ss@db.internal/app',
];
const RAW_MESSAGE = `trial blew up: ${SECRETS.join(' | ')}`;

async function scratch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-integrity-error-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function isolated(ctx, root, overrides = {}) {
  return new EvolutionOrchestrator(ctx, {
    presetDir: root,
    startupDrift: false,
    eventBridgePath: path.join(root, 'events.jsonl'),
    eventBridgeKey: 'k'.repeat(32),
    driftStatePath: path.join(root, 'drift.json'),
    memoryPath: path.join(root, 'memory.json'),
    ...overrides,
  });
}

function runner() {
  return {
    snapshot: () => [],
    define: () => ({ pluginId: 'evolved-plugin', packageId: 'evolved-package' }),
    run: async () => ({ ok: true, status: 'active' }),
    stop: async () => ({ ok: true }),
    undefine: async () => ({ ok: true }),
  };
}

async function readText(file) {
  try { return await fs.readFile(file, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

async function markdownFiles(root) {
  const found = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.md')) found.push(full);
    }
  };
  await walk(root);
  return found;
}

function assertNoPlaintext(where, body) {
  for (const secret of SECRETS) {
    assert.equal(body.includes(secret), false, `${where} must not persist the raw credential shape ${secret}`);
  }
}

test('a failed trial keeps raw error text out of the archive, event bridge, memory and inspect', async (t) => {
  const root = await scratch(t);
  const ctx = context();
  ctx.dynamicCordisRunner = runner();
  const core = isolated(ctx, root);
  const exec = { agent: { id: 'integrity-owner' }, signal: new AbortController().signal };

  const proposal = core.propose({ why: 'integrity', target: 'integrity', impactScope: ['runtime'], successMetrics: ['m'] }, exec);
  const record = core.experiments.get(proposal.experimentId);
  core.runner.run = async () => { throw new Error(RAW_MESSAGE); };
  await assert.rejects(
    core.trial({ experimentId: record.id, composition: { name: 'n', purpose: 'p', code: { host: 'return {};' } } }, exec),
    (error) => error.message === RAW_MESSAGE,
    'the caller still receives the real error; only persistence is bounded',
  );

  const [archiveFile] = await markdownFiles(root);
  assert.ok(archiveFile, 'the failed trial is archived');
  const archive = await readText(archiveFile);
  assertNoPlaintext('the archive', archive);
  assert.match(archive, /"errorCategory": "runtime-trial"/, 'the archive keeps a usable failure classification');

  const bridge = await readText(path.join(root, 'events.jsonl'));
  assertNoPlaintext('the event bridge', bridge);
  const failureEvent = bridge.trim().split('\n')
    .map((line) => JSON.parse(line))
    .map((envelope) => envelope.event || envelope)
    .find((event) => event?.eventType === 'failure-learned');
  assert.ok(failureEvent, 'failure-learned is emitted');
  assert.equal(failureEvent.failure?.errorCategory, 'runtime-trial');
  assert.equal(typeof failureEvent.failure?.errorDigest, 'string', 'the durable failure keeps an irreversible identity');
  assert.equal(failureEvent.failure?.error, undefined, 'the durable failure no longer carries a raw error string');

  const memory = await readText(path.join(root, 'memory.json'));
  assertNoPlaintext('the failure memory', memory);

  const inspected = JSON.stringify(core.inspect(exec.agent));
  assertNoPlaintext('evolution_runtime_inspect', inspected);
  assert.equal(record.failure.errorCategory, 'runtime-trial');
  assert.equal(typeof record.failure.errorDigest, 'string');
});

test('an observed agent error reaches neither the failure memory nor inspect as raw text', async (t) => {
  const root = await scratch(t);
  const ctx = context();
  ctx.dynamicCordisRunner = runner();
  const core = isolated(ctx, root, {
    patternThreshold: 2,
    autonomousStrategies: { AGENT_ERROR: { risk: 'low', target: 'plugin:fix', composition: { name: 'f', purpose: 'p', code: { host: 'return {};' } } } },
  });
  const exec = { agent: { id: 'integrity-owner' }, signal: new AbortController().signal };
  const input = { type: 'agent/error', code: 'AGENT_ERROR', message: RAW_MESSAGE, target: 'agent' };

  assert.equal((await core.observeAutonomous(input, exec)).phase, 'pattern-observing');
  core.trial = async () => { throw new Error(RAW_MESSAGE); };
  assert.equal((await core.observeAutonomous(input, exec)).phase, 'rolled-back-no-improvement');

  assertNoPlaintext('the failure memory', await readText(path.join(root, 'memory.json')));
  assertNoPlaintext('evolution_runtime_inspect', JSON.stringify(core.inspect(exec.agent)));
  const observations = core.inspect(exec.agent).evolutionObservations;
  assert.ok(observations.length >= 1);
  const stored = JSON.stringify(observations);
  assert.match(stored, /AGENT_ERROR/, 'the observation keeps its error code');
  assert.match(stored, /errorCategory/, 'the observation keeps a failure category');
  assert.match(stored, /sha256:[0-9a-f]{16}/, 'the observation keeps an irreversible error digest');
  const entry = core.memory.data.entries.at(-1);
  assert.match(JSON.stringify(entry.result), /runtime-trial|autonomous/, 'failure memory still classifies the failure');
});

test('the doctor-registered agent/error observer hands over a safe input, not the raw message', async (t) => {
  const root = await scratch(t);
  const listeners = new Map();
  const ctx = {
    dynamicCordisRunner: runner(),
    tools: { register: () => {} },
    systemPrompt: { section: () => {} },
    on: (event, listener) => listeners.set(event, listener),
    logger: { warn: () => {} },
  };
  const core = apply(ctx, {
    startupDrift: false,
    observe: true,
    presetDir: root,
    eventBridge: { emit: () => ({}) },
    eventBridgePath: path.join(root, 'events.jsonl'),
    eventBridgeKey: 'k'.repeat(32),
    driftStatePath: path.join(root, 'drift.json'),
  });
  const received = [];
  core.observeAutonomous = async (input) => { received.push(input); };
  const error = new Error(RAW_MESSAGE);
  error.code = 'EACCES';
  listeners.get('agent/error')({ agent: { id: 'integrity-owner' }, error, signal: new AbortController().signal });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(received.length, 1, 'the observer runs');
  const handed = JSON.stringify(received[0]);
  assertNoPlaintext('the observeAutonomous input', handed);
  assert.match(handed, /EACCES/, 'the classification code survives the boundary');
  assert.match(handed, /sha256:[0-9a-f]{16}/, 'the digest survives the boundary');
});

test('rollback evidence of a failed trial does not persist the raw cleanup message', async (t) => {
  const root = await scratch(t);
  const ctx = context();
  ctx.dynamicCordisRunner = runner();
  const core = isolated(ctx, root);
  const exec = { agent: { id: 'integrity-owner' }, signal: new AbortController().signal };
  const proposal = core.propose({ why: 'integrity-cleanup', target: 'integrity', impactScope: ['runtime'], successMetrics: ['m'] }, exec);
  const record = core.experiments.get(proposal.experimentId);
  core.runner.run = async () => { throw new Error('trial activation failed'); };
  core.runner.undefine = async () => { throw new Error(`undefine refused: ${RAW_MESSAGE}`); };
  await assert.rejects(core.trial({ experimentId: record.id, composition: { name: 'n', purpose: 'p', code: { host: 'return {};' } } }, exec));

  assert.equal(record.failure.rollbackResult.ok, false);
  const [archiveFile] = await markdownFiles(root);
  const archive = await readText(archiveFile);
  assertNoPlaintext('the archive', archive);
  assertNoPlaintext('the event bridge', await readText(path.join(root, 'events.jsonl')));
  assert.match(JSON.stringify(record.failure.rollbackResult), /undefine refused/, 'the cleanup failure stays diagnosable');
});

test('safeErrorDto never echoes the raw message and stays stable per error', () => {
  const dto = safeErrorDto(new Error(RAW_MESSAGE), 'trial');
  assert.equal(dto.errorCategory, 'runtime-trial');
  assert.match(dto.errorDigest, /^sha256:[0-9a-f]{16}$/);
  assertNoPlaintext('the error DTO', JSON.stringify(dto));
  assert.equal(dto.errorSummary.length <= 240, true, 'the summary is bounded');
  assert.notEqual(safeErrorDto(new Error('other failure'), 'trial').errorDigest, dto.errorDigest);
  assert.equal(safeErrorDto(new Error(RAW_MESSAGE), 'trial').errorDigest, dto.errorDigest, 'the same error keeps one identity');
});
