/**
 * Regression proof for the two supersession blockers on PR #101.
 *
 * Both tests boot the real Cordis 4.0.4 context, the real Include 1.0.9 child
 * and real promoted plugin modules. Plugins register real tools through
 * `ctx.tools`, so the live tool surface is produced by the official packages —
 * not by an in-memory adapter. The only injected condition is a stale
 * composition file, written at the adapter's public `refresh` seam to model an
 * external writer on a shared data root.
 *
 * Review-time code (0858881) failed both scenarios; the rebuild-based design
 * on this branch passes them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context, Service } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import { createConsumerSession } from '../lib/promoted-consumer.js';
import { mountIncludeTree } from '../lib/promotion-include.js';
import { sharingPaths } from '../lib/promoted-sharing.js';

const HOST = Object.freeze({ dsh: '0.2.2-rc.1', cordis: '4.0.4', include: '1.0.9', node: process.version });
const HOST_VERSIONS = Object.freeze({
  '@deepseek-ai/dsh': HOST.dsh,
  '@deepseek-ai/cordis': HOST.cordis,
  '@deepseek-ai/cordis-plugin-include': HOST.include,
});
const BASE_URL = pathToFileURL(`${os.tmpdir()}${path.sep}`).href;

class FakeTools extends Service {
  constructor(ctx) {
    super(ctx, 'tools');
    this.entries = new Map();
  }
  register(definition) {
    this.entries.set(definition.name, definition);
    return () => { this.entries.delete(definition.name); };
  }
  schemas() {
    return [...this.entries.values()];
  }
}

class FakePluginPackages extends Service {
  constructor(ctx, config = {}) {
    super(ctx, 'pluginPackages');
    this.versions = config.versions ?? {};
  }
  packageOf(name) {
    const version = this.versions[name];
    return typeof version === 'string' ? { version } : null;
  }
}

async function boot() {
  const ctx = new Context();
  await ctx.plugin(Loader, { baseUrl: BASE_URL });
  await ctx.plugin(FakeTools);
  await ctx.plugin(FakePluginPackages, { versions: HOST_VERSIONS });
  return ctx;
}

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'consumer-real-tree-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dataRoot = path.join(home, 'storages', 'evolution');
  const paths = sharingPaths({ dataRoot });
  const pluginRoot = path.join(dataRoot, 'promoted');
  await fs.mkdir(pluginRoot, { recursive: true, mode: 0o700 });
  const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

  const createRecord = async ({ toolName = `real_tree_${crypto.randomBytes(3).toString('hex')}`, source } = {}) => {
    const experimentId = `exp-${crypto.randomBytes(6).toString('hex')}`;
    const id = `evolution-promoted-${sha256(experimentId).slice(0, 12)}`;
    const pluginName = `dsh-${id}`;
    const dir = path.join(pluginRoot, pluginName);
    await fs.mkdir(path.join(dir, 'lib'), { recursive: true, mode: 0o700 });
    const moduleSource = source ?? [
      `export const name = ${JSON.stringify(pluginName)};`,
      "export const inject = ['tools'];",
      'export function apply(ctx) {',
      '  ctx.effect(() => {',
      `    const dispose = ctx.tools.register({ name: ${JSON.stringify(toolName)}, description: 'real tree probe' });`,
      "    return () => { if (typeof dispose === 'function') dispose(); };",
      '  });',
      '}',
      '',
    ].join('\n');
    const modulePath = path.join(dir, 'lib', 'index.js');
    const manifestPath = path.join(dir, 'package.json');
    await fs.writeFile(modulePath, moduleSource);
    await fs.writeFile(manifestPath, `${JSON.stringify({ name: pluginName, version: '1.0.0', type: 'module', main: 'lib/index.js' }, null, 2)}\n`);
    const record = {
      id,
      schemaVersion: 1,
      experimentId,
      pluginName,
      moduleUrl: pathToFileURL(modulePath).href,
      entry: 'lib/index.js',
      sourceSha256: sha256(await fs.readFile(modulePath)),
      manifestSha256: sha256(await fs.readFile(manifestPath)),
      publisherProfile: 'desktop',
      approvedProfiles: ['acp', 'web'],
      stable: {
        committedAt: '2026-01-01T00:00:00.000Z',
        promotionTimestamp: '2026-01-01T00:00:00.000Z',
        decision: 'benefit',
        canary: { healthObservationWindow: 2, observations: 2, startupVerified: true },
      },
      requiredServices: ['tools'],
      serviceMembers: {},
      requiredCapabilities: ['fiberLifecycle', 'fiberAwait', 'include', 'toolsRegistry'],
      hostOnly: true,
      host: { ...HOST },
      revalidation: [],
      publishedAt: '2026-01-01T00:00:00.000Z',
    };
    return { id, record, toolName };
  };

  const writeIndex = async (plugins) => {
    await fs.mkdir(paths.dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(paths.indexPath, `${JSON.stringify({
      schemaVersion: 1,
      kind: 'dsh-evolution-shared-plugins',
      updatedAt: new Date().toISOString(),
      publisher: { profile: 'desktop' },
      plugins,
    }, null, 2)}\n`, { mode: 0o600 });
  };

  return { dataRoot, paths, createRecord, writeIndex };
}

const supersedeMarker = (record) => ({
  recordId: record.id,
  sourceSha256: record.sourceSha256,
  approvalSha256: 'c'.repeat(64),
  evidenceSha256: 'd'.repeat(64),
  at: '2026-11-24T15:00:00.000Z',
});

async function mountSession(ctx, dataRoot, mountInclude) {
  const created = createConsumerSession({ ctx, config: { dataRoot }, profile: 'acp', mountInclude });
  await created.mount();
  return { ...created.session, mount: created.mount, dispose: created.dispose };
}

/**
 * Real Include adapter whose fallback refresh sees a composition left behind
 * by another writer. The first refresh is the consumer's own intended tree;
 * the second is the fallback refresh, where a stale data root can resurrect
 * an older chain version.
 */
async function mountWithStaleFallbackRefresh(ctx, config, staleRows, { persistent = false } = {}) {
  const adapter = await mountIncludeTree(ctx, config);
  const plainRefresh = adapter.refresh.bind(adapter);
  let calls = 0;
  adapter.refresh = async () => {
    calls += 1;
    if (calls === 2 || (persistent && calls > 2)) {
      await fs.writeFile(config.path, `${JSON.stringify(staleRows(), null, 2)}\n`);
    }
    await plainRefresh();
  };
  return adapter;
}

const liveToolNames = (ctx) => ctx.tools.schemas().map((definition) => definition.name).sort();

test('B1: a stale mixed tree cannot activate a predecessor beside a still-live replacement', async (t) => {
  const { dataRoot, createRecord, writeIndex } = await fixture(t);
  const predecessor = await createRecord({ toolName: 'b1_predecessor_tool' });
  // A1 registers a real tool on every attempt and its effect disposer throws,
  // so the official child's dispose resolves while A1's tool stays registered.
  const replacement = await createRecord({
    toolName: 'b1_replacement_tool',
    source: [
      `export const name = ${JSON.stringify('dsh-b1-replacement')};`,
      "export const inject = ['tools'];",
      'let attempts = 0;',
      'export function apply(ctx) {',
      '  attempts += 1;',
      "  ctx.tools.register({ name: 'b1_replacement_tool', description: 'B1 probe' });",
      "  ctx.effect(() => () => { throw new Error('A1 effect disposer exploded'); });",
      "  if (attempts === 1) throw new Error('A1 exploded once');",
      '}',
      '',
    ].join('\n'),
  });
  // A second, healthy record under a different row id supplies the stale copy
  // of the replacement. Its module registers the same tool through real Cordis.
  const staleCopy = await createRecord({ toolName: 'b1_replacement_tool' });
  const sibling = await createRecord({ toolName: 'b1_sibling_tool' });
  await writeIndex([
    { ...predecessor.record, supersededBy: { acp: supersedeMarker(replacement.record) } },
    replacement.record,
    sibling.record,
  ]);

  const ctx = await boot();
  const session = await mountSession(ctx, dataRoot, (mountCtx, config) => mountWithStaleFallbackRefresh(mountCtx, config, () => [
    { id: `shared-${predecessor.record.id}`, name: predecessor.record.moduleUrl },
    { id: `shared-${replacement.record.id}`, name: replacement.record.moduleUrl },
    { id: `shared-stale-${staleCopy.record.id}`, name: staleCopy.record.moduleUrl },
    { id: `shared-${sibling.record.id}`, name: sibling.record.moduleUrl },
  ]));
  const rows = new Map(session.rows.map((row) => [row.id, row]));

  assert.equal(rows.get(replacement.record.id).reason, 'plugin-apply-failed');
  // The old tree could not be proven released: its replacement effect disposer
  // threw, leaving that tool registered. No second tree may be mounted over it,
  // and the predecessor must never be reported active beside the replacement.
  assert.equal(rows.get(predecessor.record.id).status, 'failed');
  assert.equal(rows.get(predecessor.record.id).reason, 'include-unavailable');
  assert.equal(session.unreleasedOldTree, true);
  assert.equal(session.mounted.has(predecessor.record.id), false);
  assert.deepEqual(liveToolNames(ctx), [replacement.toolName],
    'only the unreleased replacement tool remains; no second chain version is mounted');
  await session.dispose();
});

test('B2: a failed fiber behind a non-disabled entry cannot demote a healthy predecessor', async (t) => {
  const { dataRoot, createRecord, writeIndex } = await fixture(t);
  const predecessor = await createRecord({ toolName: 'b2_predecessor_tool' });
  // A1 fails its apply but registers a real tool with a well-behaved disposer:
  // its Entry survives on the unsettled tree with an already-failed Fiber.
  const replacement = await createRecord({
    toolName: 'b2_replacement_tool',
    source: [
      `export const name = ${JSON.stringify('dsh-b2-replacement')};`,
      "export const inject = ['tools'];",
      'export function apply(ctx) {',
      '  ctx.effect(() => {',
      "    const dispose = ctx.tools.register({ name: 'b2_replacement_tool', description: 'B2 probe' });",
      "    return () => { if (typeof dispose === 'function') dispose(); };",
      '  });',
      "  throw new Error('A1 exploded');",
      '}',
      '',
    ].join('\n'),
  });
  const sibling = await createRecord({ toolName: 'b2_sibling_tool' });
  await writeIndex([
    { ...predecessor.record, supersededBy: { acp: supersedeMarker(replacement.record) } },
    replacement.record,
    sibling.record,
  ]);
  // The stale tree omits the sibling, so the refresh is not settled, and keeps
  // the replacement row whose Fiber already failed but whose Entry is live.
  const ctx = await boot();
  const session = await mountSession(ctx, dataRoot, (mountCtx, config) => mountWithStaleFallbackRefresh(mountCtx, config, () => [
    { id: `shared-${predecessor.record.id}`, name: predecessor.record.moduleUrl },
    { id: `shared-${replacement.record.id}`, name: replacement.record.moduleUrl },
  ], { persistent: true }));
  const rows = new Map(session.rows.map((row) => [row.id, row]));

  assert.equal(rows.get(replacement.record.id).status, 'failed');
  assert.equal(rows.get(replacement.record.id).reason, 'plugin-apply-failed');
  assert.equal(rows.get(predecessor.record.id).status, 'active',
    'entry existence is not proof of a live replacement; the healthy predecessor is restored');
  assert.equal(rows.get(sibling.record.id).status, 'active',
    'the healthy sibling is carried into the rebuilt tree');
  assert.ok(session.mounted.has(predecessor.record.id));
  assert.deepEqual(liveToolNames(ctx), [predecessor.toolName, sibling.toolName].sort(),
    'only the restored predecessor and healthy sibling remain online; the failed replacement fiber is gone');
  await session.dispose();
});

test('S1: a mixed composition read by a rebuilt child cannot expose two chain versions', async (t) => {
  const { dataRoot, createRecord, writeIndex } = await fixture(t);
  const predecessor = await createRecord({ toolName: 's1_predecessor_tool' });
  const replacement = await createRecord({
    toolName: 's1_replacement_tool',
    source: [
      `export const name = ${JSON.stringify('dsh-s1-replacement')};`,
      "export const inject = ['tools'];",
      'let attempts = 0;',
      'export function apply(ctx) {',
      '  attempts += 1;',
      '  ctx.effect(() => {',
      "    const dispose = ctx.tools.register({ name: 's1_replacement_tool', description: 'S1 probe' });",
      "    return () => { if (typeof dispose === 'function') dispose(); };",
      '  });',
      "  if (attempts === 1) throw new Error('replacement exploded once');",
      '}',
      '',
    ].join('\n'),
  });
  const staleCopy = await createRecord({ toolName: 's1_replacement_tool' });
  await writeIndex([
    { ...predecessor.record, supersededBy: { acp: supersedeMarker(replacement.record) } },
    replacement.record,
  ]);

  const ctx = await boot();
  let mounts = 0;
  const session = await mountSession(ctx, dataRoot, (mountCtx, config) => {
    mounts += 1;
    if (mounts === 2) {
      // The consumer wrote the intended composition, then an external writer
      // left a mixed list before the NEW child read the file. Per-row checks
      // alone only see the intended predecessor on this tree.
      return (async () => {
        await fs.writeFile(config.path, `${JSON.stringify([
          { id: `shared-${predecessor.record.id}`, name: predecessor.record.moduleUrl },
          { id: `shared-stale-${staleCopy.record.id}`, name: staleCopy.record.moduleUrl },
        ], null, 2)}\n`);
        return mountIncludeTree(mountCtx, config);
      })();
    }
    return mountIncludeTree(mountCtx, config);
  });
  const rows = new Map(session.rows.map((row) => [row.id, row]));

  assert.equal(mounts, 2);
  assert.equal(rows.get(predecessor.record.id).status, 'failed',
    'a rebuilt tree that read a mixed list is not a clean tree');
  assert.equal(session.mounted.has(predecessor.record.id), false);
  assert.equal(liveToolNames(ctx).includes(predecessor.toolName), false,
    'the predecessor must not be online beside a stale replacement copy');
  await session.dispose();
});

test('S2: an independent host tool registered after the baseline is not our leftover', async (t) => {
  const { dataRoot, createRecord, writeIndex } = await fixture(t);
  const predecessor = await createRecord({ toolName: 's2_predecessor_tool' });
  const replacement = await createRecord({
    toolName: 's2_replacement_tool',
    source: [
      `export const name = ${JSON.stringify('dsh-s2-replacement')};`,
      "export const inject = ['tools'];",
      'export function apply(ctx) {',
      '  ctx.effect(() => {',
      "    const dispose = ctx.tools.register({ name: 's2_replacement_tool', description: 'S2 probe' });",
      "    return () => { if (typeof dispose === 'function') dispose(); };",
      '  });',
      "  throw new Error('replacement exploded');",
      '}',
      '',
    ].join('\n'),
  });
  await writeIndex([
    { ...predecessor.record, supersededBy: { acp: supersedeMarker(replacement.record) } },
    replacement.record,
  ]);

  const ctx = await boot();
  let hostRegistered = false;
  const session = await mountSession(ctx, dataRoot, (mountCtx, config) => {
    if (!hostRegistered) {
      hostRegistered = true;
      // A separate host plugin registers after the consumer captured its
      // baseline. Its tool survives our Include disposal but is not ours.
      ctx.tools.register({ name: 's2_independent_host_tool', description: 'independent host plugin' });
    }
    return mountIncludeTree(mountCtx, config);
  });
  const rows = new Map(session.rows.map((row) => [row.id, row]));

  assert.equal(rows.get(replacement.record.id).reason, 'plugin-apply-failed');
  assert.equal(rows.get(predecessor.record.id).status, 'active',
    'an independent host tool must not block the predecessor restore');
  assert.ok(session.mounted.has(predecessor.record.id));
  assert.ok(liveToolNames(ctx).includes('s2_independent_host_tool'));
  assert.deepEqual(liveToolNames(ctx).filter((name) => name === 's2_replacement_tool'), []);
  await session.dispose();
});

test('S3: a host-level failure on a middle version walks back to the healthy predecessor', async (t) => {
  const { dataRoot, createRecord, writeIndex, paths } = await fixture(t);
  const a0 = await createRecord({ toolName: 's3_a0_tool' });
  const a1 = await createRecord({
    toolName: 's3_a1_tool',
    // A module that cannot even be imported leaves no Fiber behind.
    source: "throw new Error('module import failed');\n",
  });
  const a2 = await createRecord({
    toolName: 's3_a2_tool',
    source: [
      `export const name = ${JSON.stringify('dsh-s3-a2')};`,
      "export const inject = ['tools'];",
      'export function apply(ctx) {',
      '  ctx.effect(() => {',
      "    const dispose = ctx.tools.register({ name: 's3_a2_tool', description: 'S3 probe' });",
      "    return () => { if (typeof dispose === 'function') dispose(); };",
      '  });',
      "  throw new Error('tail exploded');",
      '}',
      '',
    ].join('\n'),
  });
  await writeIndex([
    { ...a0.record, supersededBy: { acp: supersedeMarker(a1.record) } },
    { ...a1.record, supersededBy: { acp: supersedeMarker(a2.record) } },
    a2.record,
  ]);

  const ctx = await boot();
  const session = await mountSession(ctx, dataRoot, (mountCtx, config) => mountIncludeTree(mountCtx, config));
  const rows = new Map(session.rows.map((row) => [row.id, row]));

  assert.equal(rows.get(a2.record.id).reason, 'plugin-apply-failed');
  assert.equal(rows.get(a0.record.id).status, 'active',
    'the chain must continue past a middle version with no Fiber');
  assert.ok(session.mounted.has(a0.record.id));
  assert.deepEqual(liveToolNames(ctx), [a0.toolName]);
  await session.dispose();
  const state = await fs.readFile(paths.statePath('acp'), 'utf8');
  assert.ok(state.length > 0);
});
