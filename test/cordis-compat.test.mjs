// Contract tests for the Cordis surfaces this bundle reads.
//
// These tests run against the REAL installed packages (`@deepseek-ai/cordis`,
// `@deepseek-ai/cordis-plugin-loader`, `@deepseek-ai/cordis-plugin-include`),
// not against mocks: the point of `lib/cordis-compat.js` is to replace private
// and undocumented surfaces with documented ones without changing behaviour, so
// the only meaningful check is equivalence against the shipping implementation.
//
// Everything here is synthetic and lives in os.tmpdir().
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Context, Service } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';

import {
  fiberIsActive, serviceImpl, serviceImplSource, probeSurfaces, recordedSurfaces,
  registerIsolateKey, currentIsolateKey, publicServiceImplPath,
  SURFACE_PRIVATE, SURFACE_PUBLIC, SURFACE_UNDOCUMENTED,
} from '../lib/cordis-compat.js';
import { inspectRuntime } from '../lib/orchestrator.js';
import { mountPromotedInclude } from '../lib/promotion-include.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(here);
const scratchRoots = [];
const scratch = async (name) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `evo-cordis-${name}-`));
  scratchRoots.push(dir);
  return dir;
};
test.after(async () => {
  for (const dir of scratchRoots) await fs.rm(dir, { recursive: true, force: true });
});

/** `FiberState` is a `const enum` erased from the published runtime, so the
 * numeric ACTIVE value can only be stated here, as the thing under test. If a
 * future cordis renumbers the enum, the equivalence assertions below fail
 * instead of the runtime silently accepting a wrong lifecycle state. */
const FIBER_STATE_ACTIVE = 2;
const syntheticAgent = { id: 'synthetic' };
const syntheticRunner = { snapshot: () => [] };

// ---------------------------------------------------------------------------
// service implementation resolution
// ---------------------------------------------------------------------------

test('the isolation-map symbol is the one the shipped cordis actually uses', async () => {
  // lib/cordis-compat.js must not import a host package (the doctor CLI runs
  // where host packages are not resolvable), so it depends on this one
  // documented property of the shipped cordis. Assert it against the real
  // package here instead of discovering a mismatch in the field.
  assert.equal(typeof currentIsolateKey(), 'symbol');
  assert.equal(Context.isolate, Symbol.for('cordis.isolate'));
  assert.equal(Context.isolate, currentIsolateKey());

  const ctx = new Context();
  class Demo extends Service { constructor(c) { super(c, 'demo'); } }
  await ctx.plugin(Demo).await();
  assert.equal(publicServiceImplPath(ctx), true);
  assert.equal(serviceImpl(ctx, 'demo')?.value instanceof Demo, true);

  // The host hands over the authoritative value at boot; adopting the real
  // static from the loaded package must not change any result.
  registerIsolateKey(Context.isolate);
  assert.equal(publicServiceImplPath(ctx), true);
  assert.equal(serviceImpl(ctx, 'demo')?.fiber, ctx.reflect._getImpl('demo', false)?.fiber);

  // A context whose isolation map is not reachable must not be reported as
  // "every service unbound"; it must fall back and say so.
  const detached = new Context();
  Object.defineProperty(detached, 'reflect', { value: { props: { demo: { type: 'service' } } }, configurable: true });
  assert.equal(publicServiceImplPath(detached), false);
  assert.equal(serviceImplSource(detached), 'unavailable');
  assert.equal(serviceImpl(detached, 'demo'), undefined);
});

test('serviceImpl is equivalent to the private reflect._getImpl(name, false)', async () => {
  const ctx = new Context();
  class Demo extends Service { constructor(c) { super(c, 'demo'); } }
  class Other extends Service { constructor(c) { super(c, 'other'); } }
  await ctx.plugin(Demo).await();
  const otherFiber = ctx.plugin(Other);
  await otherFiber.await();

  for (const name of ['demo', 'other', 'never-provided']) {
    assert.equal(serviceImpl(ctx, name), ctx.reflect._getImpl(name, false), `default scope: ${name}`);
  }

  // Isolation is the hard part of the lookup: the declaration is global but the
  // implementation is scope-local, so a child scope must not resolve to the
  // parent's implementation (or vice versa).
  const child = ctx.isolate('demo');
  assert.equal(serviceImpl(child, 'demo'), child.reflect._getImpl('demo', false));
  assert.equal(serviceImpl(child, 'demo'), undefined, 'an isolated scope must not see the parent implementation');
  assert.notEqual(serviceImpl(child, 'demo'), serviceImpl(ctx, 'demo'));

  // A disposed provider is gone from both paths.
  await otherFiber.dispose();
  assert.equal(serviceImpl(ctx, 'other'), undefined);
  assert.equal(ctx.reflect._getImpl('other', false), undefined);
});

test('the service inventory needs the public path only, never the private method', async () => {
  const ctx = new Context();
  class Demo extends Service { constructor(c) { super(c, 'demo'); } }
  await ctx.plugin(Demo).await();

  const withPrivate = inspectRuntime(ctx, syntheticAgent, syntheticRunner);
  // Hide the private method exactly as a host that dropped it would.
  Object.defineProperty(ctx.reflect, '_getImpl', { value: undefined, configurable: true });
  const publicOnly = inspectRuntime(ctx, syntheticAgent, syntheticRunner);

  assert.deepEqual(publicOnly.services, withPrivate.services);
  assert.equal(publicOnly.services.length, 1);
  assert.equal(publicOnly.services[0].name, 'demo');
  assert.equal(publicOnly.services[0].active, true);
  assert.equal(publicOnly.services[0].owner.name, 'Demo');
  assert.equal(publicOnly.services[0].owner.state, 'active');
  assert.equal(publicOnly.recoveryProof.unknown.includes('service-owner:demo'), false);
  assert.equal(serviceImplSource(ctx), 'public: ctx.reflect.store + Context.isolate');
});

test('an unbound service declaration is never reported as a live owner', async () => {
  const ctx = new Context();
  // Declare the property without providing it from a live fiber.
  Object.defineProperty(ctx.reflect, 'props', { value: { ghost: { type: 'service' } }, configurable: true });
  const result = inspectRuntime(ctx, syntheticAgent, syntheticRunner);
  assert.deepEqual(result.services, []);
  assert.deepEqual(result.recoveryProof.unknown.filter((entry) => entry.startsWith('service-owner:')), []);
});

// ---------------------------------------------------------------------------
// lifecycle state
// ---------------------------------------------------------------------------

test('fiberIsActive equals FiberState.ACTIVE across every lifecycle transition', async () => {
  const ctx = new Context();
  // `internal/status` is cordis' documented lifecycle signal; recording every
  // transition is exact, whereas racing a timer would sample by luck.
  const transitions = [];
  ctx.on('internal/status', (fiber) => {
    transitions.push({ uid: fiber?.uid, state: fiber?.state, active: fiberIsActive(fiber) });
  });

  class Provider extends Service { constructor(c) { super(c, 'provider'); } }
  // PENDING is the initial state and is only observable when a required
  // service never arrives; a plugin with no dependencies transitions to
  // LOADING synchronously inside ctx.plugin().
  const pending = ctx.plugin({ name: 'pending', inject: ['never-provided'], apply() {} });
  assert.equal(pending.state, 0);
  assert.equal(fiberIsActive(pending), false);

  const active = ctx.plugin(Provider);
  await active.await();

  // LOADING through ACTIVE: an async plugin body keeps the fiber mid-transition.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const loading = ctx.plugin({ name: 'loading', async apply() { await gate; } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(loading.state, 1, 'the gated plugin must be observed while LOADING');
  assert.equal(fiberIsActive(loading), false);
  release();
  await loading.await();

  // FAILED: the plugin body throws.
  const failed = ctx.plugin({ name: 'failed', apply() { throw new Error('synthetic failure'); } });
  await failed.await().catch(() => {});

  // UNLOADING then DISPOSED.
  const unloading = ctx.plugin({ name: 'unloading', apply() { return async () => { await new Promise((resolve) => setTimeout(resolve, 30)); }; } });
  await unloading.await();
  await unloading.dispose();

  const states = transitions.map((entry) => entry.state);
  for (const entry of transitions) {
    assert.equal(
      entry.active, entry.state === FIBER_STATE_ACTIVE,
      `fiber uid=${entry.uid}: fiberIsActive=${entry.active} but state=${entry.state}`,
    );
  }
  for (const state of [1, 2, 3, 4, 5]) {
    assert.ok(states.includes(state), `lifecycle state ${state} was never observed; saw ${states}`);
  }
  assert.equal(pending.state, 0);
  assert.equal(fiberIsActive(pending), false);
  assert.equal(transitions.some((entry) => entry.state === 0), false, 'PENDING is sampled directly, not delivered as a transition');

  // Direct field contract, so a shape that silently stops carrying `inertia`,
  // `store` or `uid` fails here rather than in the live host.
  assert.equal(fiberIsActive(undefined), false);
  assert.equal(fiberIsActive(null), false);
  assert.equal(fiberIsActive({ uid: 1, store: {}, inertia: undefined }), true);
  assert.equal(fiberIsActive({ uid: null, store: {}, inertia: undefined }), false);
  assert.equal(fiberIsActive({ uid: 1, store: undefined, inertia: undefined }), false);
  // A LOADING fiber already has a store snapshot; the in-flight transition must
  // still make it inactive.
  assert.equal(fiberIsActive({ uid: 1, store: {}, inertia: Promise.resolve() }), false);
});

test('no fiber state decision in lib/ is made from a numeric FiberState literal', async () => {
  const walk = async (dir) => {
    const files = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...await walk(full));
      else if (entry.name.endsWith('.js')) files.push(full);
    }
    return files;
  };
  const sources = await walk(path.join(repoRoot, 'lib'));
  assert.ok(sources.length > 5, 'the lint must cover the shipped lib/ tree');
  for (const file of sources) {
    const text = fsSync.readFileSync(file, 'utf8');
    const match = text.match(/\.?\bstate\s*[!=]==?\s*\d/);
    // Only the compatibility module may mention the numeric value, and only in
    // prose explaining why it is not trusted.
    if (match) {
      assert.equal(path.relative(repoRoot, file), 'lib/cordis-compat.js', `${path.relative(repoRoot, file)} compares a fiber state to a numeric literal; use fiberIsActive() from lib/cordis-compat.js`);
      assert.match(text.slice(Math.max(0, match.index - 200), match.index + 200), /Verified equal to|not trusted|Published|erased/);
    }
  }
});

// ---------------------------------------------------------------------------
// recorded surface classification
// ---------------------------------------------------------------------------

test('every recorded surface is classified and its class matches the shipped packages', async () => {
  const ctx = new Context();
  class Provider extends Service { constructor(c) { super(c, 'provider'); } }
  await ctx.plugin(Provider).await();
  const { probes, unavailable, advisoryUnavailable } = probeSurfaces(ctx, {
    promotionRuntime: { capabilities: { entryResolver: true, treeAwait: true, liveRootEntries: true } },
  });

  assert.equal(probes.length, recordedSurfaces().length);
  assert.ok(probes.length >= 8);
  const validClasses = new Set([SURFACE_PUBLIC, SURFACE_UNDOCUMENTED, SURFACE_PRIVATE]);
  for (const probe of probes) {
    assert.ok(validClasses.has(probe.kind), `${probe.api} has no recorded class`);
    assert.equal(typeof probe.owner, 'string', `${probe.api} must name the owning package`);
    assert.equal(typeof probe.reads, 'string', `${probe.api} must state what is read from it`);
    assert.equal(typeof probe.required, 'boolean');
    if (probe.kind === SURFACE_PRIVATE) {
      assert.match(probe.api, /\._[A-Za-z]+/, `${probe.api} is classified private and must name its underscore-prefixed member`);
      // A private surface is either replaced by a documented one, or the record
      // must state why no replacement exists. Keeping the second case explicit
      // is what stops a forced, less accurate rewrite later.
      if (typeof probe.replacement === 'string') {
        assert.ok(probe.replacement.length > 0);
      } else {
        assert.equal(probe.replacement, null, `${probe.api} must record a replacement or null`);
        assert.ok(typeof probe.noReplacementReason === 'string' && probe.noReplacementReason.length > 0,
          `${probe.api} is private with no replacement and must record the reason`);
      }
    }
    // A surface owned by cordis itself must answer on a freshly built context.
    // If it does not, it is not a documented member and the class is wrong.
    if (probe.kind === SURFACE_PUBLIC && probe.owner === '@deepseek-ai/cordis' && probe.api.startsWith('ctx.')) {
      assert.equal(probe.ok, true, `${probe.api} is classified public but is absent from a real context`);
    }
  }

  assert.deepEqual(probes.filter((probe) => probe.kind === SURFACE_PRIVATE).map((probe) => probe.api), [
    'ctx.reflect._getImpl() (service implementations)',
    'ctx.events._hooks (event listeners)',
  ]);
  // The only required surfaces a bare context cannot answer are the host
  // services a live session binds; nothing cordis-owned and nothing the
  // documented replacement covers is missing.
  assert.deepEqual(unavailable, [
    'ctx.tools.schemas() (visible tools)',
    'dynamicCordisRunner.snapshot()',
  ]);
  assert.deepEqual(advisoryUnavailable, ["ctx.get('cordisInspect').list() (providers)"]);

  const impl = probes.find((probe) => probe.api.includes('_getImpl'));
  assert.equal(impl.resolution, 'public: ctx.reflect.store + Context.isolate');
  assert.equal(impl.publicAlternativeOk, true);
});

test('a host that dropped a replaced private surface still reports it as satisfied', async () => {
  const ctx = new Context();
  Object.defineProperty(ctx.reflect, '_getImpl', { value: undefined, configurable: true });
  const extra = { promotionRuntime: { capabilities: { entryResolver: true, treeAwait: true, liveRootEntries: true } } };
  const { probes } = probeSurfaces(ctx, extra);
  const impl = probes.find((probe) => probe.api.includes('_getImpl'));
  assert.equal(impl.ok, true, 'the documented replacement must satisfy the surface on its own');
  assert.equal(impl.resolution, 'public: ctx.reflect.store + Context.isolate');
  assert.equal(impl.publicAlternativeOk, true);

  // A private surface without a public replacement must degrade when dropped.
  const stripped = new Context();
  Object.defineProperty(stripped, 'events', { value: {}, configurable: true });
  const strippedProbes = probeSurfaces(stripped, extra);
  assert.ok(strippedProbes.unavailable.some((api) => api.includes('events._hooks')));
  assert.equal(strippedProbes.privateSurfaces.includes('ctx.events._hooks (event listeners)'), true);
  assert.deepEqual(strippedProbes.publicReplacements, [
    { api: 'ctx.reflect._getImpl() (service implementations)', replacement: 'ctx.reflect.store + Context.isolate' },
    {
      api: 'official Include instance state (root.data, entry resolution, entry.fiber/options/disabled)',
      replacement: 'EntryTree.resolve(rowId) instead of EntryTree.store[rowId]',
    },
  ]);
});

test('the doctor CLI starts with no host package resolvable', async () => {
  // lib/cordis-compat.js must not import a host package: the doctor entry runs
  // in a plugin-only profile where `@deepseek-ai/cordis` and friends are not on
  // plain Node's resolution path. Copying the bundle files without any
  // node_modules reproduces that exactly, so a reintroduced host import fails
  // here instead of only in a real install.
  const root = await scratch('doctor-boundary');
  for (const relative of ['lib', 'scripts', 'package.json']) {
    await fs.cp(path.join(repoRoot, relative), path.join(root, relative), { recursive: true });
  }
  const home = path.join(root, 'empty-home');
  await fs.mkdir(home, { recursive: true });
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'doctor.mjs'), '--home', home, '--no-composition', '--json'], {
    cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, DSH_HOME: home },
  });
  assert.equal(result.stderr.includes('ERR_MODULE_NOT_FOUND'), false, `the doctor entry must not import host packages:\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(typeof report.status, 'string');
  assert.equal(report.checks.some((check) => check.id === 'runtime.internal-api'), true);
});

test('the promoted composition fixture is never written into the checkout', () => {
  for (const dir of scratchRoots) {
    assert.equal(path.resolve(dir).startsWith(path.resolve(repoRoot) + path.sep), false, `synthetic fixture leaked into the repository: ${dir}`);
  }
});

// ---------------------------------------------------------------------------
// the mounted promoted Include (real loader + real official Include)
// ---------------------------------------------------------------------------

async function promotedFixture(name, { hostCode = 'export const name = "promoted";\nexport function apply() {}\n' } = {}) {
  const root = await scratch(name);
  const compositionPath = path.join(root, 'promoted.cordis.yml');
  const pluginDir = path.join(root, 'promoted', 'dsh-evolution-promoted-aaaaaaaaaaaa');
  await fs.mkdir(path.join(pluginDir, 'lib'), { recursive: true });
  await fs.writeFile(path.join(pluginDir, 'package.json'), JSON.stringify({ name: 'dsh-evolution-promoted-aaaaaaaaaaaa', main: 'lib/index.js', type: 'module' }));
  await fs.writeFile(path.join(pluginDir, 'lib', 'index.js'), hostCode);
  const moduleUrl = pathToFileURL(path.join(pluginDir, 'lib', 'index.js')).href;
  const rowId = 'evolution-promoted-aaaaaaaaaaaa';
  await fs.writeFile(compositionPath, `- id: ${rowId}\n  name: ${JSON.stringify(moduleUrl)}\n`);
  return { root, compositionPath, moduleUrl, rowId };
}

async function mountedContext(compositionPath) {
  const ctx = new Context();
  await ctx.plugin(Loader, {}).await();
  return { ctx, runtime: await mountPromotedInclude(ctx, { compositionPath }) };
}

test('the promoted Include mount resolves and verifies through the documented loader members', async () => {
  const { compositionPath, moduleUrl, rowId } = await promotedFixture('include-mount');
  const { runtime } = await mountedContext(compositionPath);

  assert.deepEqual(runtime.capabilities, { entryResolver: true, treeAwait: true, liveRootEntries: true });
  assert.deepEqual(await runtime.verify(rowId, moduleUrl), { officialInclude: true, active: true });
  assert.deepEqual(await runtime.health(rowId, moduleUrl), { componentHealth: 'active', dependenciesPresent: true });

  // An out-of-band edit is picked up by refresh, and the row stays verifiable.
  const before = await fs.readFile(compositionPath, 'utf8');
  await fs.writeFile(compositionPath, `${before}- id: evolution-promoted-bbbbbbbbbbbb\n  name: ${JSON.stringify(moduleUrl)}\n`);
  await runtime.refresh();
  assert.deepEqual(await runtime.verify(rowId, moduleUrl), { officialInclude: true, active: true });

  // A row that is not in the composition must never verify.
  await assert.rejects(runtime.verify('evolution-promoted-deadbeefdead', moduleUrl), /not active/);
});

test('a torn composition fails closed instead of masquerading as a committed tree', async () => {
  const { compositionPath, moduleUrl, rowId } = await promotedFixture('include-torn');
  const { runtime } = await mountedContext(compositionPath);
  await runtime.verify(rowId, moduleUrl);

  await fs.writeFile(compositionPath, 'not: [a, valid, entry, list');
  // Include.refresh() deliberately swallows this; the documented pre-validate
  // step must surface it, otherwise a failed durable write would look committed.
  await assert.rejects(runtime.refresh());
});

test('a promoted module that fails to activate is reported inactive, with its cause', async () => {
  const { compositionPath, moduleUrl, rowId } = await promotedFixture('include-failing', {
    hostCode: 'export const name = "promoted-broken";\nexport function apply() { throw new Error("synthetic activation failure"); }\n',
  });
  const { runtime } = await mountedContext(compositionPath);
  await assert.rejects(runtime.verify(rowId, moduleUrl), /not active.*synthetic activation failure/s);
});

test('a disabled promoted row is rejected', async () => {
  const { compositionPath, moduleUrl, rowId } = await promotedFixture('include-disabled');
  await fs.writeFile(compositionPath, `- id: ${rowId}\n  name: ${JSON.stringify(moduleUrl)}\n  disabled: true\n`);
  const { runtime } = await mountedContext(compositionPath);
  await assert.rejects(runtime.verify(rowId, moduleUrl), /not active/);
});
