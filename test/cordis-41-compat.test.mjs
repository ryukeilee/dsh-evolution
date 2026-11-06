// Use the installed host by default. To exercise a separately installed 4.1
// host without changing this checkout's dependencies, set
// EVOLUTION_CORDIS_41_MODULE to its Cordis entry file (or file: URL).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { fiberIsActive, serviceImpl, serviceImplSource } from '../lib/cordis-compat.js';
import { inspectRuntime } from '../lib/orchestrator.js';

const require = createRequire(import.meta.url);
const externalModule = process.env.EVOLUTION_CORDIS_41_MODULE;
const installedVersion = require('@deepseek-ai/cordis/package.json').version;
const use41 = Boolean(externalModule) || /^4\.1\./.test(installedVersion);
// An explicitly requested module must import successfully; a bad path must
// fail the run rather than silently turning the real-host checks into skips.
const cordis41 = use41 ? await import(externalModule
  ? externalModule.startsWith('file:') ? externalModule : pathToFileURL(externalModule).href
  : '@deepseek-ai/cordis') : null;
const real41 = {
  skip: use41 ? false : `installed Cordis ${installedVersion}; set EVOLUTION_CORDIS_41_MODULE for a real 4.1 host`,
  timeout: 10000,
};
const agent = { id: 'cordis-41-synthetic' };
const runner = { snapshot: () => [] };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test('fiberIsActive preserves legacy store fibers and prefers the 4.1 committed field', () => {
  for (const field of ['store', 'committed']) {
    assert.equal(fiberIsActive({ uid: 0, [field]: {}, inertia: undefined }), true, `${field}: root`);
    assert.equal(fiberIsActive({ uid: 1, [field]: {}, inertia: undefined }), true, `${field}: active`);
    assert.equal(fiberIsActive({ uid: 1, [field]: undefined, inertia: undefined }), false, `${field}: pending/failed`);
    assert.equal(fiberIsActive({ uid: 1, [field]: {}, inertia: Promise.resolve() }), false, `${field}: transition`);
    assert.equal(fiberIsActive({ uid: null, [field]: {}, inertia: undefined }), false, `${field}: disposed`);
    assert.equal(fiberIsActive({ [field]: {}, inertia: undefined }), false, `${field}: missing identity`);
  }
  assert.equal(fiberIsActive(null), false);
  assert.equal(fiberIsActive(undefined), false);
  assert.equal(fiberIsActive({ uid: 1, store: {} }), true);
  assert.equal(fiberIsActive({ uid: 1, store: {}, committed: undefined }), false,
    'a 4.1 inactive fiber must not borrow an obsolete store snapshot');
  assert.equal(fiberIsActive(Object.assign(Object.create({ committed: undefined }), { uid: 1, store: {} })), false);
  assert.equal(fiberIsActive({ uid: 1, committed: {}, store: undefined }), true);
});

test('service inventory preserves legacy owners and reports ownerless bindings as unknown', () => {
  const legacy = { name: 'legacy-provider', uid: 7, state: 2, store: {} };
  const modern = { name: 'modern-provider', uid: 8, state: 2, committed: {} };
  const key = Symbol('synthetic-service');
  const ctx = {
    [Symbol.for('cordis.isolate')]: { demo: key },
    reflect: { props: { demo: { type: 'service' } }, store: { [key]: { fiber: legacy, ctx: { fiber: modern } } } },
  };
  const inventory = () => inspectRuntime(ctx, agent, runner);
  assert.deepEqual(inventory().services, [{
    name: 'demo', active: true, owner: { name: 'legacy-provider', uid: 7, state: 'active' },
  }]);
  ctx.reflect.store[key] = { ctx: { fiber: modern } };
  assert.deepEqual(inventory().services, [{
    name: 'demo', active: true, owner: { name: 'modern-provider', uid: 8, state: 'active' },
  }]);
  ctx.reflect.store[key] = { value: 'synthetic' };
  const unknown = inventory();
  assert.deepEqual(unknown.services, [{ name: 'demo', active: false, owner: 'unknown' }]);
  assert.ok(unknown.recoveryProof.unknown.includes('service-owner:demo'));
});

test('real Cordis 4.1 fiberIsActive matches ACTIVE through the complete lifecycle', real41, async (t) => {
  const ctx = new cordis41.Context();
  const loadingGate = deferred();
  const loadingEntered = deferred();
  const unloadingGate = deferred();
  const unloadingEntered = deferred();
  t.after(async () => {
    loadingGate.resolve();
    unloadingGate.resolve();
    await ctx.fiber.dispose();
  });
  assert.ok('committed' in ctx.fiber, 'the selected runtime must expose the real 4.1 lifecycle contract');
  assert.equal('store' in ctx.fiber, false);
  const transitions = [];
  const sample = (fiber) => transitions.push({ uid: fiber.uid, state: fiber.state, active: fiberIsActive(fiber) });
  ctx.on('internal/status', sample);
  sample(ctx.fiber);

  const pending = ctx.plugin({ name: 'pending-41', inject: ['never-provided-41'], apply() {} });
  assert.equal(pending.state, 0);
  sample(pending);

  const loading = ctx.plugin({
    name: 'gated-41',
    async apply() {
      loadingEntered.resolve();
      await loadingGate.promise;
      return async () => {
        unloadingEntered.resolve();
        await unloadingGate.promise;
      };
    },
  });
  await loadingEntered.promise;
  assert.equal(loading.state, 1);
  assert.ok(loading.committed);
  assert.equal(fiberIsActive(loading), false);
  loadingGate.resolve();
  await loading.await();
  assert.equal(loading.state, 2);
  assert.equal(fiberIsActive(loading), true);

  const failure = new Error('synthetic Cordis 4.1 startup failure');
  const failed = ctx.plugin({ name: 'failed-41', apply() { throw failure; } });
  await assert.rejects(failed.await(), (error) => error === failure);
  assert.equal(failed.state, 3);
  assert.equal(fiberIsActive(failed), false);

  const disposal = loading.dispose();
  await unloadingEntered.promise;
  assert.equal(loading.state, 5);
  assert.equal(fiberIsActive(loading), false);
  unloadingGate.resolve();
  await disposal;
  assert.equal(loading.state, 4);
  assert.equal(fiberIsActive(loading), false);
  await pending.dispose();
  await failed.dispose();

  // FiberState is an erased const enum. Pin its published ACTIVE value only
  // in this differential test, independently of the compatibility predicate.
  for (const entry of transitions) {
    assert.equal(entry.active, entry.state === 2, `uid=${entry.uid}, state=${entry.state}`);
  }
  assert.deepEqual([...new Set(transitions.map(({ state }) => state))].sort(), [0, 1, 2, 3, 4, 5]);
});

test('real Cordis 4.1 service owners resolve through impl.ctx.fiber across activation and disposal', real41, async (t) => {
  const ctx = new cordis41.Context();
  const entered = deferred();
  const gate = deferred();
  t.after(async () => {
    gate.resolve();
    await ctx.fiber.dispose();
  });
  const provider = ctx.plugin({
    name: 'owner-provider-41',
    async apply(c) {
      c.provide('demo41', { synthetic: true });
      entered.resolve();
      await gate.promise;
    },
  });
  await entered.promise;
  const impl = serviceImpl(ctx, 'demo41');
  assert.ok(impl);
  assert.equal(impl.fiber, undefined, '4.1 must exercise the new owner location');
  // Cordis may wrap context reads in tracing proxies; compare the registry
  // identity rather than the JavaScript wrapper identity.
  assert.equal(impl.ctx.fiber.uid, provider.uid);
  assert.equal(impl.ctx.fiber.name, provider.name);
  assert.equal(impl, ctx.reflect._getImpl('demo41', false));
  const service = () => inspectRuntime(ctx, agent, runner).services.find(({ name }) => name === 'demo41');
  assert.deepEqual(service(), {
    name: 'demo41', active: false, owner: { name: provider.name, uid: provider.uid, state: 'loading' },
  });

  gate.resolve();
  await provider.await();
  const before = inspectRuntime(ctx, agent, runner);
  assert.deepEqual(service(), {
    name: 'demo41', active: true, owner: { name: provider.name, uid: provider.uid, state: 'active' },
  });
  assert.equal(before.recoveryProof.unknown.includes('service-owner:demo41'), false);
  // The public implementation path must remain sufficient on the new host.
  const privateLookup = Object.getOwnPropertyDescriptor(ctx.reflect, '_getImpl');
  try {
    Object.defineProperty(ctx.reflect, '_getImpl', { value: undefined, configurable: true });
    assert.deepEqual(inspectRuntime(ctx, agent, runner).services, before.services);
    assert.equal(serviceImplSource(ctx), 'public: ctx.reflect.store + Context.isolate');
    assert.equal(serviceImpl(ctx.isolate('demo41'), 'demo41'), undefined);
  } finally {
    if (privateLookup) Object.defineProperty(ctx.reflect, '_getImpl', privateLookup);
    else delete ctx.reflect._getImpl;
  }

  await provider.dispose();
  assert.equal(serviceImpl(ctx, 'demo41'), undefined);
  assert.equal(service(), undefined);
});
