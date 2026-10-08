import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { context } from './fixtures/runtime-inspect.mjs';
import { currentIsolateKey, serviceImpl } from '../lib/cordis-compat.js';

// The immutable released implementation can run the same regression workload.
const { EvolutionOrchestrator, inspectRuntime, runtimeSignature, signatureEqual } = await import(
  process.env.EVOLUTION_TEST_BASELINE || '../lib/orchestrator.js'
);

function component(name) {
  return { name, fibers: [{ name, uid: name, state: 'active', getEffects: () => [] }] };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-trial-boundary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ctx = context();
  const components = [];
  ctx.registry.values = () => components;
  let installed = false;
  ctx.dynamicCordisRunner = {
    snapshot: () => installed ? [{ pluginId: 'candidate', packages: [] }] : [],
    define: () => { installed = true; return { pluginId: 'candidate', packageId: 'package' }; },
    run: async () => ({ ok: true, status: 'active' }),
    stop: async () => ({ ok: true }),
    undefine: async () => { installed = false; return { ok: true }; },
  };
  const core = new EvolutionOrchestrator(ctx, {
    presetDir: root, startupDrift: false, eventBridge: { emit: () => ({}) },
  });
  const exec = { agent: { id: 'boundary-owner' }, signal: new AbortController().signal };
  const proposal = core.propose({ why: 'recovery boundary', target: 'boundary', impactScope: ['test'], successMetrics: ['recovery'] }, exec);
  const record = core.experiments.get(proposal.experimentId);
  const trial = () => core.trial({ experimentId: record.id, composition: {
    name: 'boundary', purpose: 'test cleanup', code: { host: 'return {};' },
  } }, exec);
  return { core, ctx, components, proposal, record, exec, trial };
}

test('pre-trial host loading does not invalidate cleanup, and the proof uses the actual trial boundary', async t => {
  const { core, components, record, proposal, exec, trial } = await fixture(t);
  const proposedSignature = runtimeSignature(record.baseline);
  components.push(component('late-host'));
  const trialSignature = runtimeSignature(core.inspect(exec.agent));
  await trial();
  const result = await core.revert({ experimentId: record.id }, exec);
  assert.equal(result.runtimeRecovered, true);
  assert.deepEqual(proposal.baseline, proposedSignature, 'the proposal snapshot remains detached');
  assert.deepEqual(runtimeSignature(record.baseline), proposedSignature, 'retain the proposal context');
  assert.deepEqual(record.recoveryProof.beforeFingerprint, trialSignature);
  assert.deepEqual(record.recoveryProof.afterFingerprint, trialSignature);
  const archive = await fs.readFile(record.archivePath, 'utf8');
  const proof = JSON.parse(archive.split('\n').find(line => line.startsWith('- proof: ')).slice('- proof: '.length));
  assert.deepEqual(proof.beforeFingerprint, trialSignature);
});

test('drift during the trial still fails recovery and retains target ownership', async t => {
  const { core, components, record, exec, trial } = await fixture(t);
  await trial();
  components.push(component('unexpected-during-trial'));
  const result = await core.revert({ experimentId: record.id }, exec);
  assert.equal(result.runtimeRecovered, false);
  assert.equal(result.phase, 'revert-failed');
  assert.equal(core.targetOwners.get(record.targets[0]), record.id);
});

test('drift while run is pending cannot be absorbed by a second trial call or a later inspect', async t => {
  const { core, components, record, exec, trial } = await fixture(t);
  const boundary = runtimeSignature(core.inspect(exec.agent));
  let finishRun;
  core.runner.run = () => new Promise(resolve => { finishRun = resolve; });
  const pending = trial();
  components.push(component('concurrent-host'));
  await assert.rejects(trial(), /Trial requires proposed state/);
  core.inspect(exec.agent);
  finishRun({ ok: true, status: 'active' });
  await pending;
  assert.deepEqual(runtimeSignature(record.trialBaseline), boundary);
  const result = await core.revert({ experimentId: record.id }, exec);
  assert.equal(result.runtimeRecovered, false);
  assert.equal(result.phase, 'revert-failed');
  assert.deepEqual(record.recoveryProof.beforeFingerprint, boundary);
  assert.notDeepEqual(record.recoveryProof.afterFingerprint, boundary);
  assert.equal(core.targetOwners.get(record.targets[0]), record.id);
});

test('an unreadable private service inventory cannot prove recovery even when both reads fail', () => {
  const ctx = context();
  ctx.reflect.props = { failing: { type: 'service' } };
  ctx.reflect._getImpl = () => { throw new Error('lookup unavailable'); };
  const before = inspectRuntime(ctx, { id: 'owner' });
  const after = inspectRuntime(ctx, { id: 'owner' });
  assert.ok(before.recoveryProof.unknown.includes('service-registry'));
  assert.equal(signatureEqual(before, after), false);
});

test('an unreadable public service inventory fails closed while an unbound declaration stays empty', () => {
  const ctx = context();
  ctx.reflect.props = { failing: { type: 'service' } };
  ctx[currentIsolateKey()] = { failing: 'service-key' };
  ctx.reflect.store = {};
  const unbound = inspectRuntime(ctx, { id: 'owner' });
  assert.deepEqual(unbound.services, []);
  assert.equal(unbound.recoveryProof.unknown.includes('service-registry'), false);
  Object.defineProperty(ctx.reflect.store, 'service-key', { get() { throw new Error('public lookup unavailable'); } });
  const before = inspectRuntime(ctx, { id: 'owner' });
  const after = inspectRuntime(ctx, { id: 'owner' });
  assert.ok(before.recoveryProof.unknown.includes('service-registry'));
  assert.equal(signatureEqual(before, after), false);
});

test('ordinary private service lookup retains its tolerant behavior', () => {
  const ctx = context();
  ctx.reflect._getImpl = () => { throw new Error('lookup unavailable'); };
  assert.equal(serviceImpl(ctx, 'failing'), undefined);
  assert.throws(() => serviceImpl(ctx, 'failing', { throwOnError: true }), /lookup unavailable/);
});

test('failed cleanup receipts cannot pass recovery with an unchanged runtime', async t => {
  const { core, record, exec, trial } = await fixture(t);
  await trial();
  core.runner.stop = async () => ({ ok: false });
  const result = await core.revert({ experimentId: record.id }, exec);
  assert.equal(record.cleanupProof.signatureRecovered, true);
  assert.equal(result.runtimeRecovered, false);
});
