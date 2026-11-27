import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context, Service, CordisError } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import * as consumerEntry from '../lib/promoted-consumer.js';
import {
  createConsumerSession,
  resolveConsumerProfile,
} from '../lib/promoted-consumer.js';
import { fiberIsActive } from '../lib/cordis-compat.js';
import { mountIncludeTree } from '../lib/promotion-include.js';
import { readPublishedPluginReview } from '../lib/self-evolution-review.js';
import { readConsumerState, sharingPaths } from '../lib/promoted-sharing.js';

const RECORD_PREFIX = 'evolution-promoted-';
const HOST = Object.freeze({ dsh: '0.2.2-rc.1', cordis: '4.0.4', include: '1.0.9', node: process.version });
const HOST_VERSIONS = Object.freeze({
  '@deepseek-ai/dsh': HOST.dsh,
  '@deepseek-ai/cordis': HOST.cordis,
  '@deepseek-ai/cordis-plugin-include': HOST.include,
});
const BASE_URL = pathToFileURL(`${os.tmpdir()}${path.sep}`).href;

/** Minimal tools registry: enough for the consumer capability probe and rows. */
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

/** Minimal `pluginPackages.packageOf`, i.e. where captureHostFacts reads versions. */
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

/** One isolated shared data root plus published-plugin fixtures. */
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'promoted-consumer-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dataRoot = path.join(home, 'storages', 'evolution');
  const paths = sharingPaths({ dataRoot });
  const pluginRoot = path.join(dataRoot, 'promoted');
  await fs.mkdir(pluginRoot, { recursive: true, mode: 0o700 });

  const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

  /**
   * Write one promoted plugin in place (the exact byte layout the Desktop
   * publisher produces) and return the publication record that references it.
   */
  const createRecord = async ({
    toolName = `consumer_tool_${crypto.randomBytes(3).toString('hex')}`,
    inject = ['tools'],
    source,
    approvedProfiles = ['acp', 'web'],
    publisherProfile = 'desktop',
    requiredServices = ['tools'],
    host = HOST,
    recordOverrides = {},
    experimentId = `exp-${crypto.randomBytes(6).toString('hex')}`,
  } = {}) => {
    // The record id is `evolution-promoted-<12 hex>`; the promoted directory
    // carries the same identity with the bundle's `dsh-` package prefix.
    const id = `${RECORD_PREFIX}${sha256(experimentId).slice(0, 12)}`;
    const pluginName = `dsh-${id}`;
    const dir = path.join(pluginRoot, pluginName);
    await fs.mkdir(path.join(dir, 'lib'), { recursive: true, mode: 0o700 });
    const moduleSource = source ?? [
      `export const name = ${JSON.stringify(pluginName)};`,
      `export const inject = ${JSON.stringify(inject)};`,
      'export function apply(ctx) {',
      '  ctx.effect(() => {',
      `    const dispose = ctx.tools.register({ name: ${JSON.stringify(toolName)}, description: 'consumer probe' });`,
      "    return () => { if (typeof dispose === 'function') dispose(); };",
      '  });',
      '}',
      '',
    ].join('\n');
    const modulePath = path.join(dir, 'lib', 'index.js');
    const manifestPath = path.join(dir, 'package.json');
    await fs.writeFile(modulePath, moduleSource);
    await fs.writeFile(manifestPath, `${JSON.stringify({ name: pluginName, version: '1.0.0', type: 'module', main: 'lib/index.js' }, null, 2)}\n`);
    const requiredCapabilities = ['fiberLifecycle', 'fiberAwait', 'include'];
    if (requiredServices.includes('tools')) requiredCapabilities.push('toolsRegistry');
    const record = {
      id,
      schemaVersion: 1,
      experimentId,
      pluginName,
      moduleUrl: pathToFileURL(modulePath).href,
      entry: 'lib/index.js',
      sourceSha256: sha256(await fs.readFile(modulePath)),
      manifestSha256: sha256(await fs.readFile(manifestPath)),
      publisherProfile,
      approvedProfiles: [...approvedProfiles],
      stable: {
        committedAt: '2026-01-01T00:00:00.000Z',
        promotionTimestamp: '2026-01-01T00:00:00.000Z',
        decision: 'benefit',
        canary: { healthObservationWindow: 2, observations: 2, startupVerified: true },
      },
      requiredServices: [...requiredServices],
      serviceMembers: {},
      requiredCapabilities,
      hostOnly: true,
      host: { ...host },
      revalidation: [],
      publishedAt: '2026-01-01T00:00:00.000Z',
      ...recordOverrides,
    };
    return { id, pluginName, record, dir, modulePath, manifestPath, toolName };
  };

  const writeIndex = async (plugins, { updatedAt = new Date().toISOString() } = {}) => {
    await fs.mkdir(paths.dir, { recursive: true, mode: 0o700 });
    const document = {
      schemaVersion: 1,
      kind: 'dsh-evolution-shared-plugins',
      updatedAt,
      publisher: { profile: 'desktop' },
      plugins,
    };
    await fs.writeFile(paths.indexPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    return document;
  };

  const writeDisable = async (entries) => {
    await fs.mkdir(paths.dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(paths.disablePath, `${JSON.stringify({
      schemaVersion: 1,
      kind: 'dsh-evolution-shared-plugin-disable',
      updatedAt: new Date().toISOString(),
      entries,
    }, null, 2)}\n`, { mode: 0o600 });
  };

  const writeComposition = async (profile, entries) => {
    await fs.mkdir(paths.consumersDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(paths.compositionPath(profile), `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  };

  const readComposition = async (profile) => {
    const { state } = await readConsumerState(paths, profile);
    return JSON.parse(await fs.readFile(state?.compositionPath ?? paths.compositionPath(profile), 'utf8'));
  };

  return { home, dataRoot, paths, pluginRoot, createRecord, writeIndex, writeDisable, writeComposition, readComposition };
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mount one session and expose both the lifecycle methods and the resulting
 * session facts (`rows`, `adapter`, `disposed`, `disposeResult`).
 */
async function mountSession(ctx, dataRoot, overrides = {}) {
  const created = createConsumerSession({ ctx, config: { dataRoot }, profile: 'acp', ...overrides });
  await created.mount();
  return { ...created.session, mount: created.mount, dispose: created.dispose };
}

/**
 * A fake Include adapter whose live entries come from the composition the
 * consumer wrote. Tests choose each row's fiber, so a host-level tree defect
 * (a row with no fiber) and a plugin's own apply failure can coexist in the
 * same fallback pass without executing real plugin code.
 */
function fakeIncludeAdapter(config, { fiberFor, omitEntries = new Set() }) {
  const entries = new Map();
  // A rebuilt subtree is mounted from the composition without a refresh, so
  // the fake tree must be live as soon as the adapter is created, just like
  // the official Include's Service.init().
  const load = () => {
    const rows = JSON.parse(fsSync.readFileSync(config.path, 'utf8'));
    entries.clear();
    for (const row of rows) {
      if (omitEntries.has(row.id)) continue;
      entries.set(row.id, { options: { name: row.name }, disabled: false, fiber: fiberFor(row.id) });
    }
  };
  load();
  return {
    capabilities: { entryResolver: true, treeAwait: true, liveRootEntries: true },
    async refresh() { load(); },
    resolveEntry(rowId) {
      return entries.get(rowId) ?? null;
    },
    async dispose() {
      // Model the official child's disposer: every row it owned is torn down,
      // its fibers leave ACTIVE, and the public resolver can no longer serve
      // them. Tests that need a failed cleanup override this method.
      for (const entry of entries.values()) {
        if (entry.fiber && typeof entry.fiber === 'object') entry.fiber.uid = null;
      }
      entries.clear();
    },
  };
}

/** A fiber that passes the consumer's live verification, or fails its apply. */
function fakeFiber({ failApply = false } = {}) {
  return {
    uid: 1,
    store: {},
    inject: { tools: {} },
    ctx: { get: () => ({}) },
    async await() {
      if (failApply) throw new Error('plugin exploded');
    },
  };
}

const supersedeMarker = (record) => ({
  recordId: record.id,
  sourceSha256: record.sourceSha256,
  approvalSha256: 'c'.repeat(64),
  evidenceSha256: 'd'.repeat(64),
  at: '2026-11-24T15:00:00.000Z',
});

test('eligible record mounts through the official Include and reports active', async (t) => {
  const { dataRoot, paths, createRecord, writeIndex, readComposition } = await fixture(t);
  const ctx = await boot();
  const { record, toolName } = await createRecord();
  const index = await writeIndex([record]);

  const session = await mountSession(ctx, dataRoot);

  assert.equal(session.rows.length, 1);
  const row = session.rows[0];
  assert.equal(row.id, record.id);
  assert.equal(row.status, 'active');
  assert.equal(row.reason, null);
  assert.equal(row.sourceSha256, record.sourceSha256);
  assert.match(row.hostDigest, /^[a-f0-9]{64}$/);
  assert.equal(typeof row.activatedAt, 'string');
  assert.equal(row.errorCode, null);

  // The plugin really ran: its registered tool is visible on the live context.
  assert.deepEqual(ctx.tools.schemas().map((definition) => definition.name), [toolName]);

  // Exactly one row, named by the verified module URL.
  assert.deepEqual(await readComposition('acp'), [{ id: `shared-${record.id}`, name: record.moduleUrl }]);

  const entry = session.adapter.resolveEntry(`shared-${record.id}`);
  assert.ok(entry);
  assert.equal(entry.options.name, record.moduleUrl);
  assert.equal(entry.disabled, false);
  assert.notEqual(entry.fiber.uid, null);
  assert.ok(Object.keys(entry.fiber.inject).includes('tools'));

  const state = await readConsumerState(paths, 'acp');
  assert.equal(state.status, 'ok');
  assert.equal(state.state.profile, 'acp');
  assert.equal(state.state.kind, 'dsh-evolution-promoted-consumer');
  assert.equal(state.state.observedIndexUpdatedAt, index.updatedAt);
  assert.equal(state.state.compositionPath, session.compositionPath);
  assert.equal(state.state.host.dsh, HOST.dsh);
  assert.deepEqual(state.state.plugins.map((plugin) => plugin.status), ['active']);

  // Disposal goes through the official Include Fiber and writes its proof.
  const disposal = await session.dispose();
  assert.deepEqual({ released: disposal.released, entries: disposal.entries }, { released: true, entries: 1 });
  // The documented Cordis release proof: a disposed Fiber's uid is null and the
  // documented lifecycle reader reports inactive; the observable registration
  // (the plugin's tool) is gone too.
  assert.equal(entry.fiber.uid, null);
  assert.equal(fiberIsActive(entry.fiber), false);
  assert.deepEqual(ctx.tools.schemas(), []);
  const disposed = await readConsumerState(paths, 'acp');
  assert.equal(typeof disposed.state.disposedAt, 'string');
  assert.deepEqual(disposed.state.disposal, { released: true, entries: 1 });
});

test('a packaged entry without the official package service still mounts a compatible record', async (t) => {
  const { dataRoot, createRecord, writeIndex } = await fixture(t);
  // A packaged ACP/Web entry can boot without a Node-resolvable pluginPackages
  // service. Without the shared host-identity fallback, captureHostFacts left
  // every host field null and hostCompatible reported a version mismatch for
  // every published record, so nothing was ever mounted.
  const ctx = new Context();
  await ctx.plugin(Loader, { baseUrl: BASE_URL });
  await ctx.plugin(FakeTools);
  const { record, toolName } = await createRecord();
  await writeIndex([record]);

  const session = await mountSession(ctx, dataRoot, { detectHost: () => HOST });
  assert.equal(session.host.dsh, HOST.dsh);
  assert.deepEqual(session.rows.map((row) => [row.status, row.reason]), [['active', null]]);
  assert.deepEqual(ctx.tools.schemas().map((definition) => definition.name), [toolName]);
  await session.dispose();
});

test('unapproved profile is skipped and nothing is mounted', async (t) => {
  const { dataRoot, createRecord, writeIndex, readComposition } = await fixture(t);
  const ctx = await boot();
  const { record } = await createRecord({ approvedProfiles: ['web'] });
  await writeIndex([record]);

  const session = await mountSession(ctx, dataRoot, { profile: 'acp' });

  assert.deepEqual(session.rows.map((row) => [row.status, row.reason]), [['skipped-unapproved', 'profile-not-approved']]);
  assert.deepEqual(ctx.tools.schemas(), []);
  assert.deepEqual(await readComposition('acp'), []);
  await session.dispose();
});

test('operator revocation disables the record without mounting it', async (t) => {
  const { dataRoot, createRecord, writeIndex, writeDisable } = await fixture(t);
  const ctx = await boot();
  const { record } = await createRecord();
  await writeIndex([record]);
  await writeDisable([{ pluginId: record.id, profile: 'acp', disabledAt: '2026-01-02T00:00:00.000Z', reason: 'operator' }]);

  const session = await mountSession(ctx, dataRoot);

  assert.deepEqual(session.rows.map((row) => [row.status, row.reason]), [['disabled', 'operator-disabled']]);
  assert.deepEqual(ctx.tools.schemas(), []);
  await session.dispose();
});

test('a tampered source and a malformed record are skipped while the other plugin stays active', async (t) => {
  const { dataRoot, createRecord, writeIndex } = await fixture(t);
  const ctx = await boot();
  const good = await createRecord();
  const tampered = await createRecord();
  // Change the published bytes after the record was created: re-hashing before
  // activation must refuse this row, and only this row.
  await fs.writeFile(tampered.modulePath, `${await fs.readFile(tampered.modulePath, 'utf8')}// tampered after publication\n`);
  const malformed = {
    id: 'evolution-promoted-000000000001',
    schemaVersion: 99,
    experimentId: 'exp-malformed',
    pluginName: 'dsh-evolution-promoted-000000000001',
    moduleUrl: 'file:///nowhere/lib/index.js',
    entry: 'lib/index.js',
  };
  await writeIndex([tampered.record, good.record, malformed]);

  const session = await mountSession(ctx, dataRoot);

  const byStatus = new Map(session.rows.map((row) => [row.id, row]));
  assert.equal(byStatus.get(tampered.record.id).status, 'skipped-invalid');
  assert.equal(byStatus.get(tampered.record.id).reason, 'source-digest-mismatch');
  assert.equal(byStatus.get(good.record.id).status, 'active');
  assert.equal(byStatus.get(malformed.id).status, 'skipped-invalid');
  assert.equal(byStatus.get(malformed.id).reason, 'record-schema-version');
  assert.deepEqual(ctx.tools.schemas().map((definition) => definition.name), [good.toolName]);
  await session.dispose();
});

test('missing required service is skipped-incompatible', async (t) => {
  const { dataRoot, createRecord, writeIndex } = await fixture(t);
  const ctx = await boot();
  const { record } = await createRecord({ requiredServices: ['dynamicCordisRunner'], inject: [] });
  await writeIndex([record]);

  const session = await mountSession(ctx, dataRoot);

  assert.deepEqual(session.rows.map((row) => [row.status, row.reason]), [['skipped-incompatible', 'missing-service']]);
  assert.deepEqual(ctx.tools.schemas(), []);
  await session.dispose();
});

test('host identity mismatch waits for revalidation instead of mounting', async (t) => {
  const { dataRoot, createRecord, writeIndex, readComposition } = await fixture(t);
  const ctx = await boot();
  const { record } = await createRecord({ host: { ...HOST, dsh: '0.0.0-not-this-host' } });
  await writeIndex([record]);

  const session = await mountSession(ctx, dataRoot);

  assert.deepEqual(session.rows.map((row) => [row.status, row.reason]), [['pending-revalidation', 'host-version-mismatch']]);
  assert.deepEqual(await readComposition('acp'), []);
  assert.deepEqual(ctx.tools.schemas(), []);
  await session.dispose();
});

test('a record published by this profile yields only to an enabled kernel', async (t) => {
  const { dataRoot, createRecord, writeIndex } = await fixture(t);
  const { record, toolName } = await createRecord({ publisherProfile: 'web' });
  await writeIndex([record]);

  // Kernel row enabled in this loader tree: the publisher owns the mount.
  const kernelContext = await boot();
  await kernelContext.get('loader').create({ id: 'evolution-orchestrator', name: record.moduleUrl });
  const withKernel = await mountSession(kernelContext, dataRoot, { profile: 'web' });
  assert.deepEqual(withKernel.rows.map((row) => [row.status, row.reason]), [['disabled', 'publisher-profile']]);
  await withKernel.dispose();

  // Kernel row disabled: nothing else would mount it, so the consumer does.
  const consumerContext = await boot();
  await consumerContext.get('loader').create({ id: 'evolution-orchestrator', name: record.moduleUrl, disabled: true });
  const withoutKernel = await mountSession(consumerContext, dataRoot, { profile: 'web' });
  assert.deepEqual(withoutKernel.rows.map((row) => [row.status, row.reason]), [['active', null]]);
  assert.deepEqual(consumerContext.tools.schemas().map((definition) => definition.name), [toolName]);
  await withoutKernel.dispose();
});

test('an unavailable official Include fails every row without throwing', async (t) => {
  const { dataRoot, paths, createRecord, writeIndex } = await fixture(t);
  const ctx = await boot();
  const { record } = await createRecord();
  await writeIndex([record]);

  const created = createConsumerSession({
    ctx,
    config: { dataRoot },
    profile: 'acp',
    mountInclude: async () => { throw new Error('official Include unavailable'); },
  });
  await assert.doesNotReject(() => created.mount());
  const session = created.session;

  assert.equal(session.rows.length, 1);
  assert.equal(session.rows[0].status, 'failed');
  assert.equal(session.rows[0].reason, 'include-unavailable');
  assert.equal(session.rows[0].errorName, 'Error');
  assert.match(session.rows[0].errorDigest, /^[a-f0-9]{64}$/);
  assert.equal(session.adapter, null);
  assert.deepEqual(ctx.tools.schemas(), []);
  const state = await readConsumerState(paths, 'acp');
  assert.equal(state.status, 'ok');
  assert.deepEqual(state.state.plugins.map((plugin) => [plugin.status, plugin.reason]), [['failed', 'include-unavailable']]);
  await created.dispose();
});

test('a failing plugin apply is reported without affecting the other plugin', async (t) => {
  const { dataRoot, createRecord, writeIndex } = await fixture(t);
  const ctx = await boot();
  const boom = await createRecord({
    inject: [],
    requiredServices: [],
    source: "export const name = 'boom';\nexport function apply() { throw new Error('plugin exploded'); }\n",
  });
  const good = await createRecord();
  await writeIndex([boom.record, good.record]);

  const session = await mountSession(ctx, dataRoot);

  const byId = new Map(session.rows.map((row) => [row.id, row]));
  assert.equal(byId.get(boom.record.id).status, 'failed');
  assert.equal(byId.get(boom.record.id).reason, 'plugin-apply-failed');
  assert.equal(byId.get(boom.record.id).errorCode, 'E_CONSUMER_PLUGIN_APPLY_FAILED');
  assert.match(byId.get(boom.record.id).errorDigest, /^[a-f0-9]{64}$/);
  assert.equal(byId.get(good.record.id).status, 'active');
  assert.deepEqual(ctx.tools.schemas().map((definition) => definition.name), [good.toolName]);
  await session.dispose();
});

test('an improved iteration replaces the old policy, and revoke restores it', async (t) => {
  const { dataRoot, createRecord, writeIndex, writeDisable, readComposition } = await fixture(t);
  const previous = await createRecord({ toolName: 'old_policy_tool' });
  const iteration = await createRecord({ toolName: 'new_policy_tool' });
  const marker = {
    recordId: iteration.record.id,
    sourceSha256: iteration.record.sourceSha256,
    approvalSha256: 'c'.repeat(64),
    evidenceSha256: 'd'.repeat(64),
    at: '2026-11-24T15:00:00.000Z',
  };
  await writeIndex([
    { ...previous.record, supersededBy: { acp: marker } },
    iteration.record,
  ]);

  const firstContext = await boot();
  const first = await mountSession(firstContext, dataRoot);
  const firstRows = new Map(first.rows.map((row) => [row.id, row]));
  assert.equal(firstRows.get(previous.record.id).status, 'disabled');
  assert.equal(firstRows.get(previous.record.id).reason, 'superseded-by');
  assert.equal(firstRows.get(iteration.record.id).status, 'active');
  assert.deepEqual(firstContext.tools.schemas().map((definition) => definition.name), ['new_policy_tool']);
  assert.deepEqual((await readComposition('acp')).map((row) => row.id), [`shared-${iteration.record.id}`]);
  await first.dispose();

  // Revocation clears the marker and disables the iteration in this profile.
  await writeIndex([previous.record, iteration.record]);
  await writeDisable([{ pluginId: iteration.record.id, profile: 'acp', disabledAt: '2026-11-24T16:00:00.000Z', reason: 'revoke-supersede' }]);
  const secondContext = await boot();
  const second = await mountSession(secondContext, dataRoot);
  const secondRows = new Map(second.rows.map((row) => [row.id, row]));
  assert.equal(secondRows.get(previous.record.id).status, 'active');
  assert.equal(secondRows.get(iteration.record.id).status, 'disabled');
  assert.deepEqual(secondContext.tools.schemas().map((definition) => definition.name), ['old_policy_tool']);
  await second.dispose();
});

test('a replacement that fails to apply restores the previous record in the same start', async (t) => {
  const { dataRoot, createRecord, writeIndex } = await fixture(t);
  const previous = await createRecord({ toolName: 'working_policy_tool' });
  const broken = await createRecord({
    toolName: 'broken_policy_tool',
    inject: [],
    requiredServices: [],
    source: "export const name = 'broken';\nexport function apply() { throw new Error('replacement exploded'); }\n",
  });
  await writeIndex([
    { ...previous.record, supersededBy: { acp: {
      recordId: broken.record.id,
      sourceSha256: broken.record.sourceSha256,
      approvalSha256: 'c'.repeat(64),
      evidenceSha256: 'd'.repeat(64),
      at: '2026-11-24T15:00:00.000Z',
    } } },
    broken.record,
  ]);

  const ctx = await boot();
  const session = await mountSession(ctx, dataRoot);
  const rows = new Map(session.rows.map((row) => [row.id, row]));
  assert.equal(rows.get(broken.record.id).status, 'failed');
  assert.equal(rows.get(broken.record.id).reason, 'plugin-apply-failed');
  assert.equal(rows.get(previous.record.id).status, 'active', 'the old stable plugin is restored without another restart');
  assert.deepEqual(ctx.tools.schemas().map((definition) => definition.name), ['working_policy_tool']);
  assert.ok(session.mounted.has(previous.record.id), 'the old plugin has a live, verified fiber');
  await session.dispose();
});

test('fallback walks back a chain until it finds a candidate that applies', async (t) => {
  const { dataRoot, createRecord, writeIndex } = await fixture(t);
  const working = await createRecord({ toolName: 'original_policy_tool' });
  const brokenB = await createRecord({
    toolName: 'middle_policy_tool', inject: [], requiredServices: [],
    source: "export const name = 'middle';\nexport function apply() { throw new Error('middle exploded'); }\n",
  });
  const brokenC = await createRecord({
    toolName: 'final_policy_tool', inject: [], requiredServices: [],
    source: "export const name = 'final';\nexport function apply() { throw new Error('final exploded'); }\n",
  });
  const marker = (id, source) => ({
    recordId: id, sourceSha256: source, approvalSha256: 'c'.repeat(64),
    evidenceSha256: 'd'.repeat(64), at: '2026-11-24T15:00:00.000Z',
  });
  await writeIndex([
    { ...working.record, supersededBy: { acp: marker(brokenB.record.id, brokenB.record.sourceSha256) } },
    { ...brokenB.record, supersededBy: { acp: marker(brokenC.record.id, brokenC.record.sourceSha256) } },
    brokenC.record,
  ]);

  const ctx = await boot();
  const session = await mountSession(ctx, dataRoot);
  const rows = new Map(session.rows.map((row) => [row.id, row]));
  assert.equal(rows.get(brokenC.record.id).status, 'failed');
  assert.equal(rows.get(brokenB.record.id).status, 'failed');
  assert.equal(rows.get(working.record.id).status, 'active', 'the oldest working policy is restored in this start');
  assert.deepEqual(ctx.tools.schemas().map((definition) => definition.name), ['original_policy_tool']);
  await session.dispose();
});

test('fallback keeps verifying later candidates after a host-level entry failure', async (t) => {
  const { dataRoot, createRecord, writeIndex } = await fixture(t);
  // A supersedes B and C supersedes D. Both replacements fail to apply, so B
  // and D become fallback candidates in the same pass. B's live entry has no
  // fiber (a host-level tree defect); D's fiber is healthy.
  const noFiber = await createRecord({ toolName: 'no_fiber_tool' });
  const working = await createRecord({ toolName: 'working_policy_tool' });
  const brokenReplacement = (toolName) => createRecord({
    toolName,
    inject: [],
    requiredServices: [],
    source: `export const name = '${toolName}';\nexport function apply() { throw new Error('${toolName} exploded'); }\n`,
  });
  const a = await brokenReplacement('broken_a_tool');
  const c = await brokenReplacement('broken_c_tool');
  await writeIndex([
    { ...noFiber.record, supersededBy: { acp: supersedeMarker(a.record) } },
    a.record,
    { ...working.record, supersededBy: { acp: supersedeMarker(c.record) } },
    c.record,
  ]);

  const mountInclude = async (_ctx, config) => fakeIncludeAdapter(config, {
    fiberFor: (rowId) => {
      if (rowId === `shared-${a.record.id}` || rowId === `shared-${c.record.id}`) return fakeFiber({ failApply: true });
      if (rowId === `shared-${noFiber.record.id}`) return null;
      return fakeFiber();
    },
  });
  const session = await mountSession(await boot(), dataRoot, { mountInclude });
  const rows = new Map(session.rows.map((row) => [row.id, row]));

  assert.equal(rows.get(a.record.id).reason, 'plugin-apply-failed');
  assert.equal(rows.get(c.record.id).reason, 'plugin-apply-failed');
  assert.equal(rows.get(noFiber.record.id).status, 'failed');
  assert.equal(rows.get(noFiber.record.id).reason, 'include-unavailable', 'a host-level entry failure is non-sticky');
  assert.equal(rows.get(working.record.id).status, 'active', 'the healthy candidate must not be left disabled by the broken one');
  assert.notEqual(rows.get(working.record.id).reason, 'superseded-by');
  assert.ok(session.mounted.has(working.record.id), 'the healthy candidate keeps a live, verified fiber');
  await session.dispose();
});

test('fallback verifies each candidate even when a sibling live entry is missing', async (t) => {
  const { dataRoot, createRecord, writeIndex } = await fixture(t);
  // Two replacement chains whose replacements both fail to apply. On the
  // fallback pass D has a healthy fiber while E has no live entry at all
  // (resolveEntry returns null). A missing sibling must not fail D as well.
  const healthy = await createRecord({ toolName: 'healthy_policy_tool' });
  const missing = await createRecord({ toolName: 'missing_policy_tool' });
  const brokenReplacement = (toolName) => createRecord({
    toolName,
    inject: [],
    requiredServices: [],
    source: `export const name = '${toolName}';\nexport function apply() { throw new Error('${toolName} exploded'); }\n`,
  });
  const a = await brokenReplacement('broken_a_tool');
  const c = await brokenReplacement('broken_c_tool');
  await writeIndex([
    { ...healthy.record, supersededBy: { acp: supersedeMarker(c.record) } },
    c.record,
    { ...missing.record, supersededBy: { acp: supersedeMarker(a.record) } },
    a.record,
  ]);

  const mountInclude = async (_ctx, config) => fakeIncludeAdapter(config, {
    fiberFor: (rowId) => {
      if (rowId === `shared-${a.record.id}` || rowId === `shared-${c.record.id}`) return fakeFiber({ failApply: true });
      return fakeFiber();
    },
    omitEntries: new Set([`shared-${missing.record.id}`]),
  });
  const session = await mountSession(await boot(), dataRoot, { mountInclude });
  const rows = new Map(session.rows.map((row) => [row.id, row]));

  assert.equal(rows.get(missing.record.id).status, 'failed');
  assert.equal(rows.get(missing.record.id).reason, 'include-unavailable');
  assert.equal(rows.get(healthy.record.id).status, 'active', 'a missing sibling entry must not fail a healthy candidate');
  assert.ok(session.mounted.has(healthy.record.id), 'the healthy candidate keeps a live, verified fiber');
  await session.dispose();
});

test('a non-candidate apply failure after fallback walks back its own predecessor too', async (t) => {
  const { dataRoot, createRecord, writeIndex } = await fixture(t);
  const a = await createRecord({ toolName: 'chain_a_tool' });
  const c = await createRecord({ toolName: 'chain_c_tool' });
  const brokenReplacement = (toolName) => createRecord({
    toolName,
    inject: [],
    requiredServices: [],
    source: `export const name = '${toolName}';\nexport function apply() { throw new Error('${toolName} exploded'); }\n`,
  });
  const b = await brokenReplacement('broken_b_tool');
  const d = await brokenReplacement('broken_d_tool');
  await writeIndex([
    { ...a.record, supersededBy: { acp: supersedeMarker(b.record) } },
    b.record,
    { ...c.record, supersededBy: { acp: supersedeMarker(d.record) } },
    d.record,
  ]);

  // B fails on the first pass, forcing a fallback rebuild. That rebuild also
  // installs D, which was already active; on the new tree D's own apply fails.
  let mountCount = 0;
  const mountInclude = async (_ctx, config) => {
    mountCount += 1;
    const fallback = mountCount >= 2;
    return fakeIncludeAdapter(config, {
      fiberFor: (rowId) => {
        if (rowId === `shared-${b.record.id}`) return fakeFiber({ failApply: true });
        if (fallback && rowId === `shared-${d.record.id}`) return fakeFiber({ failApply: true });
        return fakeFiber();
      },
    });
  };
  const session = await mountSession(await boot(), dataRoot, { mountInclude });
  const rows = new Map(session.rows.map((row) => [row.id, row]));

  assert.equal(rows.get(b.record.id).reason, 'plugin-apply-failed');
  assert.equal(rows.get(d.record.id).status, 'failed');
  assert.equal(rows.get(d.record.id).reason, 'plugin-apply-failed', 'a surviving row that fails to apply is still a plugin failure');
  assert.equal(rows.get(d.record.id).errorCode, 'E_CONSUMER_PLUGIN_APPLY_FAILED');
  assert.equal(session.mounted.has(d.record.id), false, 'the failed row is not held for disposal');
  assert.equal(rows.get(c.record.id).status, 'active', 'the second chain predecessor is restored in the same start');
  assert.ok(session.mounted.has(c.record.id));
  await session.dispose();
});

test('a restored entry that fails on a later pass is not reinstalled by the next pass', async (t) => {
  const { dataRoot, createRecord, writeIndex } = await fixture(t);
  // Two chains force the fallback to span several passes. On A0→A1→A2 the
  // terminal A2 fails on the first tree, A1 is restored on the second tree and
  // then fails on the third; unless that failed restore is forgotten, the
  // fourth pass reinstalls A1 alongside its predecessor A0. The second chain's
  // terminal fails on the second tree so the loop does not stop before then.
  const a0 = await createRecord({ toolName: 'chain_a0_tool' });
  const a1 = await createRecord({ toolName: 'chain_a1_tool' });
  const a2 = await createRecord({
    toolName: 'chain_a2_tool', inject: [], requiredServices: [],
    source: "export const name = 'a2';\nexport function apply() { throw new Error('a2 exploded'); }\n",
  });
  const c0 = await createRecord({ toolName: 'chain_c0_tool' });
  const c1 = await createRecord({ toolName: 'chain_c1_tool' });
  const c2 = await createRecord({
    toolName: 'chain_c2_tool', inject: [], requiredServices: [],
    source: "export const name = 'c2';\nexport function apply() { throw new Error('c2 exploded'); }\n",
  });
  await writeIndex([
    { ...a0.record, supersededBy: { acp: supersedeMarker(a1.record) } },
    { ...a1.record, supersededBy: { acp: supersedeMarker(a2.record) } },
    a2.record,
    { ...c0.record, supersededBy: { acp: supersedeMarker(c1.record) } },
    { ...c1.record, supersededBy: { acp: supersedeMarker(c2.record) } },
    c2.record,
  ]);

  let mountCount = 0;
  const mountInclude = async (_ctx, config) => {
    mountCount += 1;
    return fakeIncludeAdapter(config, {
      fiberFor: (rowId) => {
        if (mountCount === 1 && rowId === `shared-${a2.record.id}`) return fakeFiber({ failApply: true });
        if (mountCount === 2 && rowId === `shared-${c2.record.id}`) return fakeFiber({ failApply: true });
        if (mountCount === 3 && rowId === `shared-${a1.record.id}`) return fakeFiber({ failApply: true });
        return fakeFiber();
      },
    });
  };
  const session = await mountSession(await boot(), dataRoot, { mountInclude });
  const rows = new Map(session.rows.map((row) => [row.id, row]));

  assert.equal(rows.get(a2.record.id).reason, 'plugin-apply-failed');
  assert.equal(rows.get(c2.record.id).reason, 'plugin-apply-failed');
  assert.equal(rows.get(a1.record.id).status, 'failed',
    `a restored row that failed to apply must stay failed: a0=${rows.get(a0.record.id).status}, a1=${rows.get(a1.record.id).status}`);
  assert.equal(rows.get(a1.record.id).reason, 'plugin-apply-failed');
  assert.equal(session.mounted.has(a1.record.id), false, 'the failed restore is not held for disposal');
  assert.equal(rows.get(a0.record.id).status, 'active', 'the predecessor is restored in the same start');
  assert.ok(session.mounted.has(a0.record.id));
  assert.equal(rows.get(c1.record.id).status, 'active', 'the healthy second chain is unaffected');
  assert.ok(session.mounted.has(c1.record.id));
  await session.dispose();
});

test('a fallback rebuild keeps a previously active sibling in the intended composition', async (t) => {
  const { dataRoot, createRecord, writeIndex } = await fixture(t);
  // Two replacement chains fail to apply, forcing a fallback. S was already
  // active in the first pass; a rebuilt subtree installs the whole intended
  // composition, so S cannot be dropped from a stale live tree.
  const a = await createRecord({ toolName: 'fallback_a_tool' });
  const c = await createRecord({ toolName: 'fallback_c_tool' });
  const s = await createRecord({ toolName: 'healthy_sibling_tool' });
  const brokenReplacement = (toolName) => createRecord({
    toolName,
    inject: [],
    requiredServices: [],
    source: `export const name = '${toolName}';\nexport function apply() { throw new Error('${toolName} exploded'); }\n`,
  });
  const b = await brokenReplacement('broken_b_tool');
  const d = await brokenReplacement('broken_d_tool');
  await writeIndex([
    { ...a.record, supersededBy: { acp: supersedeMarker(b.record) } },
    b.record,
    { ...c.record, supersededBy: { acp: supersedeMarker(d.record) } },
    d.record,
    s.record,
  ]);

  let mountCount = 0;
  let refreshCalls = 0;
  const mountInclude = async (_ctx, config) => {
    mountCount += 1;
    const adapter = fakeIncludeAdapter(config, {
      fiberFor: (rowId) => (rowId === `shared-${b.record.id}` || rowId === `shared-${d.record.id}`
        ? fakeFiber({ failApply: true }) : fakeFiber()),
    });
    const plainRefresh = adapter.refresh;
    adapter.refresh = async () => { refreshCalls += 1; await plainRefresh(); };
    return adapter;
  };
  const session = await mountSession(await boot(), dataRoot, { mountInclude });
  const rows = new Map(session.rows.map((row) => [row.id, row]));

  assert.equal(mountCount, 2, 'the fallback rebuilds the Include subtree once');
  assert.equal(refreshCalls, 1, 'the fallback does not rely on another refresh');
  assert.equal(rows.get(b.record.id).reason, 'plugin-apply-failed');
  assert.equal(rows.get(d.record.id).reason, 'plugin-apply-failed');
  assert.equal(rows.get(a.record.id).status, 'active', 'the healthy fallback candidate still mounts');
  assert.equal(rows.get(c.record.id).status, 'active');
  assert.equal(rows.get(s.record.id).status, 'active', 'the sibling stays in the rebuilt composition');
  assert.ok(session.mounted.has(s.record.id));
  assert.ok(session.mounted.has(a.record.id));
  await session.dispose();
});

test('a fallback rebuild installs the restored candidate without refresh retries', async (t) => {
  const { dataRoot, createRecord, writeIndex } = await fixture(t);
  const previous = await createRecord({ toolName: 'working_policy_tool' });
  const broken = await createRecord({
    toolName: 'broken_policy_tool',
    inject: [],
    requiredServices: [],
    source: "export const name = 'broken';\nexport function apply() { throw new Error('replacement exploded'); }\n",
  });
  await writeIndex([
    { ...previous.record, supersededBy: { acp: supersedeMarker(broken.record) } },
    broken.record,
  ]);

  let mountCount = 0;
  let refreshCalls = 0;
  const mountInclude = async (_ctx, config) => {
    mountCount += 1;
    const adapter = fakeIncludeAdapter(config, {
      fiberFor: (rowId) => (rowId === `shared-${broken.record.id}` ? fakeFiber({ failApply: true }) : fakeFiber()),
    });
    const plainRefresh = adapter.refresh;
    adapter.refresh = async () => { refreshCalls += 1; await plainRefresh(); };
    return adapter;
  };

  const session = await mountSession(await boot(), dataRoot, { mountInclude });
  const rows = new Map(session.rows.map((row) => [row.id, row]));

  assert.equal(mountCount, 2, 'the fallback mounts a fresh subtree');
  assert.equal(refreshCalls, 1, 'only the initial tree is refreshed');
  assert.equal(rows.get(broken.record.id).reason, 'plugin-apply-failed');
  assert.equal(rows.get(previous.record.id).status, 'active', 'the restored candidate is active on the rebuilt tree');
  assert.ok(session.mounted.has(previous.record.id), 'the restored candidate keeps a live fiber');
  await session.dispose();
});

test('a fallback rebuild cannot leave the failed replacement online beside its predecessor', async (t) => {
  const { dataRoot, createRecord, writeIndex } = await fixture(t);
  // A1 supersedes A0 and fails to apply, so the fallback restores A0. The old
  // refresh-based fallback could keep A1 on a stale tree while marking A0
  // include-unavailable; a rebuilt subtree removes A1 entirely.
  const a0 = await createRecord({ toolName: 'stale_a0_tool' });
  const a1 = await createRecord({
    toolName: 'stale_a1_tool', inject: [], requiredServices: [],
    source: "export const name = 'a1';\nexport function apply() { throw new Error('a1 exploded'); }\n",
  });
  const s = await createRecord({ toolName: 'stale_unrelated_tool' });
  await writeIndex([
    { ...a0.record, supersededBy: { acp: supersedeMarker(a1.record) } },
    a1.record,
    s.record,
  ]);

  let mountCount = 0;
  const mountInclude = async (_ctx, config) => {
    mountCount += 1;
    return fakeIncludeAdapter(config, {
      fiberFor: (rowId) => (rowId === `shared-${a1.record.id}` ? fakeFiber({ failApply: true }) : fakeFiber()),
    });
  };
  const session = await mountSession(await boot(), dataRoot, { mountInclude });
  const rows = new Map(session.rows.map((row) => [row.id, row]));

  assert.equal(mountCount, 2);
  assert.equal(rows.get(a1.record.id).reason, 'plugin-apply-failed', 'the failed replacement keeps its receipt');
  assert.equal(rows.get(a0.record.id).status, 'active', 'the predecessor is active on the clean rebuilt tree');
  assert.ok(session.mounted.has(a0.record.id));
  assert.equal([a0.record.id, a1.record.id].filter((id) => rows.get(id).status === 'active').length, 1,
    'exactly one version of the chain is active');
  assert.equal(rows.get(s.record.id).status, 'active', 'an unrelated healthy candidate is unaffected');
  assert.ok(session.mounted.has(s.record.id));
  await session.dispose();
});

test('a fallback on a mixed live tree never leaves two chain versions mounted', async (t) => {
  const { dataRoot, createRecord, writeIndex } = await fixture(t);
  const predecessor = await createRecord({ toolName: 'mixed_predecessor_tool' });
  // The replacement registers its tool on every apply but throws on the first
  // one. A fallback that merely refreshes a stale mixed tree leaves a live,
  // healthy replacement fiber beside the restored predecessor.
  const replacement = await createRecord({
    toolName: 'mixed_replacement_tool',
    inject: ['tools'],
    requiredServices: ['tools'],
    source: [
      `export const name = ${JSON.stringify('dsh-mixed-replacement')};`,
      "export const inject = ['tools'];",
      'let attempts = 0;',
      'export function apply(ctx) {',
      '  attempts += 1;',
      "  const dispose = ctx.tools.register({ name: 'mixed_replacement_tool', description: 'mixed tree probe' });",
      "  ctx.effect(() => () => { if (typeof dispose === 'function') dispose(); });",
      "  if (attempts === 1) throw new Error('replacement exploded once');",
      '}',
      '',
    ].join('\n'),
  });
  // The stale tree serves a second, healthy copy of the replacement under a
  // different row id so the official loader really starts its fiber.
  const staleReplacement = await createRecord({ toolName: 'mixed_replacement_tool' });
  const unrelated = await createRecord({ toolName: 'mixed_healthy_sibling_tool' });
  await writeIndex([
    { ...predecessor.record, supersededBy: { acp: supersedeMarker(replacement.record) } },
    replacement.record,
    unrelated.record,
  ]);

  let refreshCalls = 0;
  const mountInclude = async (ctx, config) => {
    const adapter = await mountIncludeTree(ctx, config);
    const plainRefresh = adapter.refresh.bind(adapter);
    adapter.refresh = async () => {
      refreshCalls += 1;
      if (refreshCalls === 2) {
        // A stale resolver serves the old mixed tree after the consumer wrote
        // its fallback composition: both chain versions and the sibling are
        // live again after that refresh.
        await fs.writeFile(config.path, `${JSON.stringify([
          { id: `shared-${predecessor.record.id}`, name: predecessor.record.moduleUrl },
          { id: `shared-stale-${replacement.record.id}`, name: staleReplacement.record.moduleUrl },
          { id: `shared-${unrelated.record.id}`, name: unrelated.record.moduleUrl },
        ], null, 2)}\n`);
      }
      await plainRefresh();
    };
    return adapter;
  };

  const ctx = await boot();
  const session = await mountSession(ctx, dataRoot, { mountInclude });
  const rows = new Map(session.rows.map((row) => [row.id, row]));

  assert.equal(rows.get(replacement.record.id).status, 'failed');
  assert.equal(rows.get(replacement.record.id).reason, 'plugin-apply-failed');
  assert.equal(rows.get(predecessor.record.id).status, 'active', 'the restored predecessor is active');
  assert.equal(rows.get(unrelated.record.id).status, 'active');
  assert.ok(session.mounted.has(predecessor.record.id));
  assert.ok(session.mounted.has(unrelated.record.id));
  assert.deepEqual(
    ctx.tools.schemas().map((definition) => definition.name).sort(),
    [predecessor.toolName, unrelated.toolName].sort(),
    'only the restored predecessor and the unrelated plugin are mounted',
  );
  await session.dispose();
});

test('a fallback disposes the old tree before writing the intended composition', async (t) => {
  const { dataRoot, createRecord, writeIndex } = await fixture(t);
  const predecessor = await createRecord({ toolName: 'flush_a0_tool' });
  // Fails its first apply (forcing the fallback) but registers a tool on every
  // attempt: a stale tree surviving the rebuild would leave this second chain
  // version online beside the restored predecessor.
  const replacement = await createRecord({
    toolName: 'flush_a1_tool',
    inject: ['tools'],
    requiredServices: ['tools'],
    source: [
      `export const name = ${JSON.stringify('dsh-flush-replacement')};`,
      "export const inject = ['tools'];",
      'let attempts = 0;',
      'export function apply(ctx) {',
      '  attempts += 1;',
      "  const dispose = ctx.tools.register({ name: 'flush_a1_tool', description: 'flush probe' });",
      "  ctx.effect(() => () => { if (typeof dispose === 'function') dispose(); });",
      '  if (attempts === 1) throw new Error(\'replacement exploded once\');',
      '}',
      '',
    ].join('\n'),
  });
  const sibling = await createRecord({ toolName: 'flush_s_tool' });
  await writeIndex([
    { ...predecessor.record, supersededBy: { acp: supersedeMarker(replacement.record) } },
    replacement.record,
    sibling.record,
  ]);

  let mountCount = 0;
  const mountInclude = async (ctx, config) => {
    const adapter = await mountIncludeTree(ctx, config);
    mountCount += 1;
    if (mountCount === 1) {
      const plainDispose = adapter.dispose.bind(adapter);
      adapter.dispose = async () => {
        // The old child flushes the mixed composition it was mounted from
        // back to disk as its disposer runs. Writing `intended` before dispose
        // would let this overwrite it with the failed replacement again.
        await fs.writeFile(config.path, `${JSON.stringify([
          { id: `shared-${predecessor.record.id}`, name: predecessor.record.moduleUrl },
          { id: `shared-${replacement.record.id}`, name: replacement.record.moduleUrl },
          { id: `shared-${sibling.record.id}`, name: sibling.record.moduleUrl },
        ], null, 2)}\n`);
        await plainDispose();
      };
    }
    return adapter;
  };

  const ctx = await boot();
  const session = await mountSession(ctx, dataRoot, { mountInclude });
  const rows = new Map(session.rows.map((row) => [row.id, row]));

  assert.equal(mountCount, 2, 'the fallback rebuilds the subtree once');
  assert.equal(rows.get(replacement.record.id).reason, 'plugin-apply-failed');
  assert.equal(rows.get(predecessor.record.id).status, 'active');
  assert.equal(rows.get(sibling.record.id).status, 'active');
  assert.deepEqual(
    ctx.tools.schemas().map((row) => row.name).sort(),
    [predecessor.toolName, sibling.toolName].sort(),
    'the old tree was disposed before the intended composition was written, so the replacement cannot survive',
  );
  assert.equal(session.mounted.has(replacement.record.id), false);
  await session.dispose();
});

test('a disposed real Include child with an unsettled row fails closed without a second tree', async (t) => {
  const { dataRoot, paths, createRecord, writeIndex } = await fixture(t);
  const predecessor = await createRecord({ toolName: 'stalled_a0_tool' });
  // A1 fails its first apply (forcing the fallback) but registers a tool on
  // every attempt: a second subtree would register S's tool twice, which the
  // registration counter below observes (the tools registry keys by name).
  const replacement = await createRecord({
    toolName: 'stalled_a1_tool',
    inject: ['tools'],
    requiredServices: ['tools'],
    source: [
      `export const name = ${JSON.stringify('dsh-stalled-replacement')};`,
      "export const inject = ['tools'];",
      'let attempts = 0;',
      'export function apply(ctx) {',
      '  attempts += 1;',
      "  ctx.tools.register({ name: 'stalled_a1_tool', description: 'stalled probe' });",
      "  if (attempts === 1) throw new Error('replacement exploded once');",
      '}',
      '',
    ].join('\n'),
  });
  // S is a REAL Cordis/Include plugin whose effect disposer throws at
  // unregistration. Cordis records the cleanup exception in Fiber._unload()
  // and the official child's dispose still resolves, leaving S's tool
  // registered. The consumer's documented proof of "still online" is its
  // public resolver, so the test keeps serving that row at that seam after
  // the real dispose. Everything else is the official Include: the child,
  // its fibers, the effect exception and the second mount attempt.
  const sibling = await createRecord({
    toolName: 'stalled_s_tool',
    inject: ['tools'],
    requiredServices: ['tools'],
    source: [
      `export const name = ${JSON.stringify('dsh-stalled-s')};`,
      "export const inject = ['tools'];",
      'export function apply(ctx) {',
      "  ctx.tools.register({ name: 'stalled_s_tool', description: 'stuck S probe' });",
      '  ctx.effect(() => () => { throw new Error(\'S effect disposer exploded\'); });',
      '}',
      '',
    ].join('\n'),
  });
  await writeIndex([
    { ...predecessor.record, supersededBy: { acp: supersedeMarker(replacement.record) } },
    replacement.record,
    sibling.record,
  ]);

  const ctx = await boot();
  const registerCalls = [];
  const plainRegister = ctx.tools.register.bind(ctx.tools);
  ctx.tools.register = (definition) => {
    registerCalls.push(definition.name);
    return plainRegister(definition);
  };

  let mountCount = 0;
  let firstAdapter;
  const sRowId = `shared-${sibling.record.id}`;
  const mountInclude = async (mountCtx, config) => {
    const adapter = await mountIncludeTree(mountCtx, config);
    mountCount += 1;
    if (mountCount !== 1) return adapter;
    firstAdapter = adapter;
    let disposed = false;
    let oldSEntry;
    const plainResolve = adapter.resolveEntry.bind(adapter);
    adapter.resolveEntry = (rowId) => {
      if (rowId !== sRowId) return plainResolve(rowId);
      if (!disposed) {
        const entry = plainResolve(rowId);
        if (entry) oldSEntry = entry;
        return entry;
      }
      // Cordis logged S's disposer exception and returned normally, but the
      // row is still online. Keep that fact visible to the consumer's proof
      // instead of letting the resolver silently forget the failed cleanup.
      return oldSEntry ?? null;
    };
    const plainDispose = adapter.dispose.bind(adapter);
    adapter.dispose = async () => {
      await plainDispose();
      disposed = true;
    };
    return adapter;
  };

  const session = await mountSession(ctx, dataRoot, { mountInclude });
  const rows = new Map(session.rows.map((row) => [row.id, row]));

  assert.equal(mountCount, 1, 'no second Include subtree is mounted over the unsettled one');
  assert.equal(rows.get(replacement.record.id).reason, 'plugin-apply-failed');
  for (const record of [predecessor.record, sibling.record]) {
    assert.equal(rows.get(record.id).status, 'failed');
    assert.equal(rows.get(record.id).reason, 'include-unavailable', 'intended rows are not claimed active without a released tree');
  }
  assert.equal(session.adapter, firstAdapter, 'the unsettled old tree is kept for a disposal retry');
  assert.equal(session.mounted.size, 1, 'the still-online S fiber is kept');
  assert.ok(session.mounted.has(sibling.record.id));
  assert.equal(
    registerCalls.filter((name) => name === sibling.toolName).length,
    1,
    'S is registered only once: a swallowed disposal must not double-mount it',
  );
  await session.dispose();
  assert.equal(session.adapter, firstAdapter, 'the retried disposal still sees the old tree');
  const state = await readConsumerState(paths, 'acp');
  assert.equal(state.state.plugins.find((row) => row.id === predecessor.record.id).reason, 'include-unavailable');
});

test('a fallback does not report a healthy predecessor as include-unavailable when the failed replacement keeps its entry', async (t) => {
  const { dataRoot, createRecord, writeIndex } = await fixture(t);
  const predecessor = await createRecord({ toolName: 'healthy_predecessor_tool' });
  const replacement = await createRecord({
    toolName: 'failed_replacement_tool',
    inject: ['tools'],
    requiredServices: ['tools'],
    source: [
      `export const name = ${JSON.stringify('dsh-failed-replacement')};`,
      "export const inject = ['tools'];",
      'export function apply(ctx) {',
      "  ctx.effect(() => {",
      "    const dispose = ctx.tools.register({ name: 'failed_replacement_tool', description: 'failed replacement probe' });",
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

  let mountCount = 0;
  let refreshCalls = 0;
  let predecessorLookups = 0;
  const mountInclude = async (ctx, config) => {
    const adapter = await mountIncludeTree(ctx, config);
    mountCount += 1;
    if (mountCount !== 1) return adapter;
    const plainRefresh = adapter.refresh.bind(adapter);
    adapter.refresh = async () => {
      refreshCalls += 1;
      if (refreshCalls >= 2) {
        // Keep the failed replacement on the live tree with the predecessor:
        // an Entry can exist while holding an already-failed Fiber.
        await fs.writeFile(config.path, `${JSON.stringify([
          { id: `shared-${predecessor.record.id}`, name: predecessor.record.moduleUrl },
          { id: `shared-${replacement.record.id}`, name: replacement.record.moduleUrl },
        ], null, 2)}\n`);
      }
      await plainRefresh();
    };
    const plainResolve = adapter.resolveEntry.bind(adapter);
    adapter.resolveEntry = (rowId) => {
      if (rowId === `shared-${predecessor.record.id}`) {
        predecessorLookups += 1;
        if (predecessorLookups <= 3) return null;
      }
      const entry = plainResolve(rowId);
      // A failed Fiber can still sit behind an Entry that is not disabled.
      if (rowId === `shared-${replacement.record.id}` && entry) return { ...entry, disabled: false };
      return entry;
    };
    return adapter;
  };

  const ctx = await boot();
  const session = await mountSession(ctx, dataRoot, { mountInclude });
  const rows = new Map(session.rows.map((row) => [row.id, row]));

  assert.equal(rows.get(replacement.record.id).status, 'failed');
  assert.equal(rows.get(replacement.record.id).reason, 'plugin-apply-failed');
  assert.equal(rows.get(predecessor.record.id).status, 'active', 'the healthy predecessor is active on a clean rebuilt tree');
  assert.ok(session.mounted.has(predecessor.record.id));
  assert.deepEqual(
    ctx.tools.schemas().map((definition) => definition.name),
    [predecessor.toolName],
    'the healthy predecessor tool remains available',
  );
  await session.dispose();
});

test('a failed fallback rebuild reports include-unavailable and never claims active', async (t) => {
  const { dataRoot, createRecord, writeIndex } = await fixture(t);
  const previous = await createRecord({ toolName: 'rebuild_old_tool' });
  const broken = await createRecord({
    toolName: 'rebuild_broken_tool',
    inject: [],
    requiredServices: [],
    source: "export const name = 'rebuild-broken';\nexport function apply() { throw new Error('replacement exploded'); }\n",
  });
  await writeIndex([
    { ...previous.record, supersededBy: { acp: supersedeMarker(broken.record) } },
    broken.record,
  ]);

  let mountCount = 0;
  const mountInclude = async (_ctx, config) => {
    mountCount += 1;
    if (mountCount === 2) throw new Error('Include subtree rebuild failed');
    return fakeIncludeAdapter(config, {
      fiberFor: (rowId) => (rowId === `shared-${broken.record.id}` ? fakeFiber({ failApply: true }) : fakeFiber()),
    });
  };
  const session = await mountSession(await boot(), dataRoot, { mountInclude });
  const rows = new Map(session.rows.map((row) => [row.id, row]));

  assert.equal(mountCount, 2, 'the fallback attempted one rebuild');
  assert.equal(rows.get(broken.record.id).reason, 'plugin-apply-failed');
  assert.equal(rows.get(previous.record.id).status, 'failed', 'no row is claimed active without a live tree');
  assert.equal(rows.get(previous.record.id).reason, 'include-unavailable', 'a host rebuild failure is non-sticky');
  assert.equal(session.mounted.size, 0);
  await session.dispose();
});

test('a real Include disposal that refuses before Fiber reports the old row still online', async (t) => {
  const { dataRoot, paths, createRecord, writeIndex } = await fixture(t);
  const previous = await createRecord({ toolName: 'dispose_old_tool' });
  // A1 fails its first apply (forcing the fallback) but registers a tool on
  // every attempt, so a swallowed refusal must not reach a second subtree.
  const broken = await createRecord({
    toolName: 'dispose_broken_tool',
    inject: ['tools'],
    requiredServices: ['tools'],
    source: [
      `export const name = ${JSON.stringify('dsh-dispose-broken')};`,
      "export const inject = ['tools'];",
      'let attempts = 0;',
      'export function apply(ctx) {',
      '  attempts += 1;',
      "  ctx.tools.register({ name: 'dispose_broken_tool', description: 'dispose probe' });",
      "  if (attempts === 1) throw new Error('replacement exploded once');",
      '}',
      '',
    ].join('\n'),
  });
  // An unrelated healthy row gives the old tree one live, verified Fiber that
  // the refused disposal never touches: that Fiber is the "old row still
  // online" fact the disposal proof must record.
  const sibling = await createRecord({ toolName: 'dispose_sibling_tool' });
  await writeIndex([
    { ...previous.record, supersededBy: { acp: supersedeMarker(broken.record) } },
    broken.record,
    sibling.record,
  ]);

  let mountCount = 0;
  let firstAdapter;
  const mountInclude = async (mountCtx, config) => {
    const adapter = await mountIncludeTree(mountCtx, config);
    mountCount += 1;
    if (mountCount !== 1) return adapter;
    firstAdapter = adapter;
    // The ONLY injection is at the real adapter's public dispose seam: it
    // refuses before the official Fiber is touched. The Include child, its
    // row fibers and every other lifecycle call are the official packages.
    adapter.dispose = async () => { throw new Error('old Include subtree refused to dispose'); };
    return adapter;
  };
  const ctx = await boot();
  const session = await mountSession(ctx, dataRoot, { mountInclude });
  const rows = new Map(session.rows.map((row) => [row.id, row]));

  assert.equal(mountCount, 1, 'no second Include subtree is mounted after the refused disposal');
  assert.equal(rows.get(broken.record.id).status, 'failed');
  assert.equal(rows.get(broken.record.id).reason, 'plugin-apply-failed', 'the failed replacement keeps its sticky receipt');
  assert.equal(rows.get(previous.record.id).status, 'failed', 'no intended row is claimed active without a settled tree');
  assert.equal(rows.get(previous.record.id).reason, 'include-unavailable', 'the failed disposer is a non-sticky host fact');
  assert.equal(rows.get(sibling.record.id).status, 'failed');
  assert.equal(rows.get(sibling.record.id).reason, 'include-unavailable');
  // The old tree was never proven released: forgetting its adapter/fibers here
  // would make the host's own dispose() report released:true while the old
  // plugin is still online.
  assert.equal(session.adapter, firstAdapter, 'the unreleased old tree is kept for a disposal retry');
  assert.equal(session.mounted.size, 1, 'the old fiber is kept, not silently cleared');
  assert.ok(session.mounted.has(sibling.record.id), 'the still-online row keeps its fiber');
  assert.deepEqual(
    [previous.record.id, broken.record.id, sibling.record.id].filter((id) => rows.get(id).status === 'active'),
    [], 'no version of the chain is active');
  const liveFiber = session.mounted.get(sibling.record.id).fiber;
  assert.equal(fiberIsActive(liveFiber), true, 'the refusal never reached the real Fiber, so the old row is still online');

  const disposal = await session.dispose();
  assert.equal(disposal.released, false, 'the disposal retry reports the old row as not released');
  assert.equal(disposal.entries, 1);
  assert.equal(session.adapter, firstAdapter, 'the retried disposal still sees the old tree');
  assert.equal(fiberIsActive(liveFiber), true, 'the still-online row is reported, not silently released');
  const state = await readConsumerState(paths, 'acp');
  assert.equal(state.state.disposal.released, false);
  assert.deepEqual(state.state.disposal, { released: false, entries: 1 });
});

test('a first Include refresh failure does not keep the replacement sticky on the next start', async (t) => {
  const { dataRoot, paths, createRecord, writeIndex } = await fixture(t);
  const previous = await createRecord({ toolName: 'old_policy_tool' });
  const replacement = await createRecord({ toolName: 'new_policy_tool' });
  await writeIndex([
    { ...previous.record, supersededBy: { acp: supersedeMarker(replacement.record) } },
    replacement.record,
  ]);

  let refreshCalls = 0;
  const failingMount = async () => ({
    capabilities: { entryResolver: true, treeAwait: true, liveRootEntries: true },
    async refresh() {
      refreshCalls += 1;
      throw new Error('Include refresh unavailable');
    },
    resolveEntry: () => null,
    async dispose() {},
  });
  const first = await mountSession(await boot(), dataRoot, { mountInclude: failingMount });
  assert.equal(refreshCalls, 1);
  assert.equal(new Map(first.rows.map((row) => [row.id, row])).get(replacement.record.id).status, 'failed');
  await first.dispose();

  const second = await mountSession(await boot(), dataRoot, {
    mountInclude: (_ctx, config) => fakeIncludeAdapter(config, { fiberFor: () => fakeFiber() }),
  });
  const rows = new Map(second.rows.map((row) => [row.id, row]));
  assert.equal(rows.get(replacement.record.id).status, 'active', 'the replacement is retried after a host refresh failure');
  assert.equal(rows.get(previous.record.id).status, 'disabled');
  assert.equal(rows.get(previous.record.id).reason, 'superseded-by');
  assert.ok(second.mounted.has(replacement.record.id));
  const state = await readConsumerState(paths, 'acp');
  assert.equal(state.state.plugins.find((row) => row.id === replacement.record.id).status, 'active');
  await second.dispose();
});

test('a transient missing entry on the first verify is non-sticky and retried next start', async (t) => {
  const { dataRoot, createRecord, writeIndex } = await fixture(t);
  const { record } = await createRecord();
  await writeIndex([record]);

  // The first refresh succeeds, but the public resolver does not serve the row
  // yet: a transient live-tree defect, not a failure of the published plugin.
  const first = await mountSession(await boot(), dataRoot, {
    mountInclude: (_ctx, config) => fakeIncludeAdapter(config, {
      fiberFor: () => fakeFiber(),
      omitEntries: new Set([`shared-${record.id}`]),
    }),
  });
  const firstRow = new Map(first.rows.map((row) => [row.id, row])).get(record.id);
  assert.equal(firstRow.status, 'failed');
  assert.equal(firstRow.reason, 'include-unavailable', 'a resolver miss must not be recorded as a sticky plugin failure');
  assert.equal(firstRow.errorCode, 'E_CONSUMER_ENTRY_MISSING');
  await first.dispose();

  // The same source on a healthy tree is retried, not skipped by a sticky
  // plugin-apply-failed receipt from the previous start.
  const secondContext = await boot();
  const second = await mountSession(secondContext, dataRoot, {
    mountInclude: (_ctx, config) => fakeIncludeAdapter(config, { fiberFor: () => fakeFiber() }),
  });
  const secondRow = new Map(second.rows.map((row) => [row.id, row])).get(record.id);
  assert.equal(secondRow.status, 'active');
  assert.ok(second.mounted.has(record.id), 'the retried row has a live, verified fiber');
  await second.dispose();
});

test('a second start over the same data root mounts once and never duplicates', async (t) => {
  const { dataRoot, paths, createRecord, writeIndex, readComposition } = await fixture(t);
  const { record, toolName } = await createRecord();
  await writeIndex([record]);

  const firstContext = await boot();
  const first = await mountSession(firstContext, dataRoot);
  assert.deepEqual(firstContext.tools.schemas().map((definition) => definition.name), [toolName]);
  const firstState = await readConsumerState(paths, 'acp');
  assert.equal(firstState.state.plugins[0].status, 'active');
  await first.dispose();
  assert.deepEqual(firstContext.tools.schemas(), []);

  const secondContext = await boot();
  const second = await mountSession(secondContext, dataRoot);
  const secondState = await readConsumerState(paths, 'acp');
  assert.equal(secondState.state.plugins.filter((plugin) => plugin.status === 'active').length, 1);
  assert.equal(secondState.state.disposedAt, undefined);
  assert.ok(secondState.state.plugins[0].activatedAt >= firstState.state.plugins[0].activatedAt);
  assert.deepEqual(secondContext.tools.schemas().map((definition) => definition.name), [toolName]);
  const composition = await readComposition('acp');
  assert.equal(composition.length, 1);
  assert.equal(composition.filter((row) => row.id === `shared-${record.id}`).length, 1);
  await second.dispose();
});

test('a plugin already mounted by the profile loader is never mounted twice', async (t) => {
  const { dataRoot, createRecord, writeIndex, readComposition } = await fixture(t);
  const ctx = await boot();
  const { record, toolName } = await createRecord();
  // Simulate the Desktop promoted composition already owning this module URL.
  await ctx.get('loader').create({ id: 'desktop-promoted-row', name: record.moduleUrl });
  assert.deepEqual(ctx.tools.schemas().map((definition) => definition.name), [toolName]);
  await writeIndex([record]);

  const session = await mountSession(ctx, dataRoot);

  assert.deepEqual(session.rows.map((row) => [row.status, row.reason]), [['disabled', 'already-mounted']]);
  assert.deepEqual(ctx.tools.schemas().map((definition) => definition.name), [toolName]);
  assert.deepEqual(await readComposition('acp'), []);
  await session.dispose();
  // The loader-owned row is not ours: consumer disposal must not remove it.
  assert.deepEqual(ctx.tools.schemas().map((definition) => definition.name), [toolName]);
});

test('bundle apply mounts on acp and the fiber disposal writes the proof', async (t) => {
  const { dataRoot, paths, createRecord, writeIndex } = await fixture(t);
  const ctx = await boot();
  const { record, toolName } = await createRecord();
  await writeIndex([record]);

  const fiber = ctx.plugin(consumerEntry, { profile: 'acp', dataRoot });
  await fiber.await();
  assert.deepEqual(ctx.tools.schemas().map((definition) => definition.name), [toolName]);
  const state = await readConsumerState(paths, 'acp');
  assert.equal(state.state.plugins[0].status, 'active');

  await fiber.dispose();
  assert.deepEqual(ctx.tools.schemas(), []);
  const disposed = await readConsumerState(paths, 'acp');
  assert.equal(disposed.state.disposal.released, true);
  assert.equal(disposed.state.disposal.entries, 1);
});

test('bundle apply is inert on desktop and unknown profiles', async (t) => {
  const { dataRoot, paths, createRecord, writeIndex } = await fixture(t);
  const ctx = await boot();
  const { record } = await createRecord();
  await writeIndex([record]);

  const previous = process.env.DSH_PROFILE;
  try {
    delete process.env.DSH_PROFILE;
    for (const profile of ['desktop', 'enterprise']) {
      const fiber = ctx.plugin(consumerEntry, { profile, dataRoot });
      await fiber.await();
    }
    // No config profile and no environment profile stays inert as well.
    const anonymous = ctx.plugin(consumerEntry, { dataRoot });
    await anonymous.await();
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE;
    else process.env.DSH_PROFILE = previous;
  }

  assert.equal(await exists(paths.statePath('acp')), false);
  assert.equal(await exists(paths.compositionPath('acp')), false);
  assert.deepEqual(ctx.tools.schemas(), []);
});

test('bundle apply never rejects, even when the data root is unusable', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'promoted-consumer-blocked-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dataRoot = path.join(home, 'blocked-root');
  await fs.writeFile(dataRoot, 'not a directory');
  const ctx = await boot();

  const fiber = ctx.plugin(consumerEntry, { profile: 'acp', dataRoot });
  await assert.doesNotReject(() => fiber.await());
  assert.deepEqual(ctx.tools.schemas(), []);
});

test('an unrecordable startup emits one contained redacted warning and never throws', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'promoted-consumer-warn-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dataRoot = path.join(home, 'blocked-root');
  await fs.writeFile(dataRoot, 'not a directory');
  const warnings = [];
  const loggerContext = {
    get: () => null,
    effect: (setup) => setup(),
    logger: { warn: (...args) => { warnings.push(args); } },
  };
  await assert.doesNotReject(() => consumerEntry.apply(loggerContext, { profile: 'acp', dataRoot }));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], '[evolution] promoted consumer unavailable (%s, digest %s)');
  assert.equal(warnings[0][1], 'ENOTDIR');
  assert.match(warnings[0][2], /^[a-f0-9]{64}$/);

  // A host logger that throws or returns a rejected promise must not escape.
  const throwingContext = {
    get: () => null,
    effect: (setup) => setup(),
    logger: { warn: () => { throw new Error('logger exploded'); } },
  };
  await assert.doesNotReject(() => consumerEntry.apply(throwingContext, { profile: 'acp', dataRoot }));
  const rejectingContext = {
    get: () => null,
    effect: (setup) => setup(),
    logger: { warn: () => Promise.reject(new Error('logger rejected')) },
  };
  await assert.doesNotReject(() => consumerEntry.apply(rejectingContext, { profile: 'acp', dataRoot }));
  // Let the contained rejected-promise handler run; an unhandled rejection
  // would fail the process, so resolving here is the assertion.
  await new Promise((resolve) => setTimeout(resolve, 10));
});

test('profile resolution follows config, environment and profileContext precedence', () => {
  const previous = process.env.DSH_PROFILE;
  try {
    delete process.env.DSH_PROFILE;
    const profileContext = { get: (name) => (name === 'profileContext' ? { name: 'web' } : null) };
    assert.equal(resolveConsumerProfile(profileContext, {}), 'web');
    assert.equal(resolveConsumerProfile(profileContext, { profile: 'acp' }), 'acp');
    process.env.DSH_PROFILE = 'acp';
    // The booted profile wins over an inherited environment name.
    assert.equal(resolveConsumerProfile(profileContext, {}), 'web');
    assert.equal(resolveConsumerProfile(profileContext, { profile: 'acp' }), 'acp');
    assert.equal(resolveConsumerProfile({ get: () => null }, {}), 'acp');
    delete process.env.DSH_PROFILE;
    assert.equal(resolveConsumerProfile({ get: () => null }, {}), null);
    assert.equal(resolveConsumerProfile(undefined, {}), null);
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE;
    else process.env.DSH_PROFILE = previous;
  }
});


test('host Include failure does not poison next boot or erase genuine plugin failures', async t => {
  const { dataRoot, paths, createRecord, writeIndex } = await fixture(t);
  const good = await createRecord();
  const bad = await createRecord({ source: "export function apply() { throw new Error('persistent'); }", requiredServices: [] });
  await writeIndex([good.record, bad.record]);
  const first = await mountSession(await boot(), dataRoot);
  await first.dispose();
  const broken = await mountSession(await boot(), dataRoot, { mountInclude: async () => { throw new Error('host not ready'); } });
  assert.equal(broken.rows[0].reason, 'include-unavailable');
  assert.equal(broken.rows[1].reason, 'plugin-apply-failed');
  await broken.dispose();
  const next = await mountSession(await boot(), dataRoot);
  assert.deepEqual(next.rows.map(row => row.status), ['active', 'failed']);
  assert.equal((await readConsumerState(paths, 'acp')).state.plugins[1].errorCode, 'E_CONSUMER_PLUGIN_APPLY_FAILED');
  await next.dispose();
});

test('only proven-clean INACTIVE_EFFECT retries, with a fixed three-attempt budget', async t => {
  const { dataRoot, createRecord, writeIndex } = await fixture(t);
  await writeIndex([(await createRecord()).record]);
  const { mountIncludeTree } = await import('../lib/promotion-include.js');
  let calls = 0;
  const recovered = await mountSession(await boot(), dataRoot, { mountInclude: async (...args) => {
    if (++calls < 3) throw Object.assign(new Error('inactive'), { code: 'INACTIVE_EFFECT', consumerRetrySafe: true });
    return mountIncludeTree(...args);
  } });
  assert.equal(calls, 3);
  assert.equal(recovered.rows[0].status, 'active');
  await recovered.dispose();
  for (const safe of [false, true]) {
    calls = 0;
    const failed = await mountSession(await boot(), dataRoot, { mountInclude: async () => {
      calls++;
      throw Object.assign(new Error('inactive'), { code: 'INACTIVE_EFFECT', consumerRetrySafe: safe });
    } });
    assert.equal(calls, safe ? 3 : 1);
    assert.equal(failed.rows[0].reason, 'include-unavailable');
    await failed.dispose();
  }
});

test('overlapping hosts use separate compositions; late old mount and disposal cannot overwrite activation', async t => {
  const { dataRoot, paths, createRecord, writeIndex } = await fixture(t);
  await writeIndex([(await createRecord()).record]);
  const { mountIncludeTree } = await import('../lib/promotion-include.js');
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const old = createConsumerSession({ ctx: await boot(), config: { dataRoot }, profile: 'acp', mountInclude: async (...args) => {
    entered(); await gate; return mountIncludeTree(...args);
  } });
  const mounting = old.mount();
  await started;
  const current = await mountSession(await boot(), dataRoot);
  const snapshot = await fs.readFile(paths.statePath('acp'), 'utf8');
  release(); await mounting;
  assert.notEqual(old.session.compositionPath, current.compositionPath);
  await old.dispose();
  assert.equal(await fs.readFile(paths.statePath('acp'), 'utf8'), snapshot);
  await current.dispose();
});

test('stop during Include startup joins mount and cannot publish active after disposal', async t => {
  const { dataRoot, paths, createRecord, writeIndex } = await fixture(t);
  await writeIndex([(await createRecord()).record]);
  const { mountIncludeTree } = await import('../lib/promotion-include.js');
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const created = createConsumerSession({ ctx: await boot(), config: { dataRoot }, profile: 'acp', mountInclude: async (...args) => {
    entered(); await gate; return mountIncludeTree(...args);
  } });
  const mounting = created.mount(); await started;
  const stopping = created.dispose(); release();
  await Promise.all([mounting, stopping]);
  const state = (await readConsumerState(paths, 'acp')).state;
  assert.equal(state.disposal.released, true);
  assert.equal(state.plugins.some(row => row.status === 'active'), false);
  assert.equal(await exists(created.session.compositionPath), false);
});

test('official Include retry proof requires settled disposal of a failed child', async () => {
  const { mountIncludeTree } = await import('../lib/promotion-include.js');
  for (const cleanupFails of [false, true]) {
    const failure = Object.assign(new Error('startup race'), { code: 'INACTIVE_EFFECT' });
    const child = {
      uid: 1,
      await: async () => { throw failure; },
      dispose: async () => { if (cleanupFails) throw new Error('cleanup failed'); child.uid = null; },
    };
    await assert.rejects(mountIncludeTree({ plugin: () => child }, { path: '/unused/empty.yml' }), error => {
      assert.equal(error, failure);
      assert.equal(error.consumerRetrySafe === true, !cleanupFails);
      return true;
    });
  }
});


test('a real Cordis Fiber retains its startup error after cleanup and Include retries once', async t => {
  const { dataRoot, createRecord, writeIndex } = await fixture(t);
  const { record, toolName } = await createRecord();
  await writeIndex([record]);
  const ctx = await boot();
  const { mountIncludeTree } = await import('../lib/promotion-include.js');
  const children = [];
  let attempts = 0;
  const session = await mountSession(ctx, dataRoot, { mountInclude: (_ctx, config) => mountIncludeTree({
    plugin(OfficialInclude, options) {
      class StartupRaceInclude extends OfficialInclude {
        constructor(...args) {
          super(...args);
          if (++attempts === 1) throw new CordisError('INACTIVE_EFFECT');
        }
      }
      const child = ctx.plugin(StartupRaceInclude, options);
      children.push(child);
      return child;
    },
  }, config) });
  assert.equal(attempts, 2);
  assert.equal(children[0].uid, null);
  await assert.rejects(children[0].await(), { code: 'INACTIVE_EFFECT' });
  assert.equal(session.rows[0].status, 'active');
  assert.deepEqual(ctx.tools.schemas().map(row => row.name), [toolName]);
  await session.dispose();
  assert.equal(children[1].uid, null);
});

test('an old mount delayed in index read cannot reclaim a new host report', async t => {
  const { dataRoot, paths, createRecord, writeIndex } = await fixture(t);
  await writeIndex([(await createRecord()).record]);
  const originalRead = fs.readFile;
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let delayFirst = true;
  fs.readFile = async (file, ...args) => {
    if (file === paths.indexPath && delayFirst) {
      delayFirst = false; entered(); await gate;
    }
    return originalRead(file, ...args);
  };
  t.after(() => { fs.readFile = originalRead; });
  const old = createConsumerSession({ ctx: await boot(), config: { dataRoot }, profile: 'acp' });
  const mounting = old.mount(); await started;
  const current = await mountSession(await boot(), dataRoot);
  const snapshot = await originalRead(paths.statePath('acp'), 'utf8');
  release(); await mounting; await old.dispose();
  assert.equal(await originalRead(paths.statePath('acp'), 'utf8'), snapshot);
  await current.dispose();
});


test('stop before evaluation preserves an inherited genuine plugin failure', async t => {
  const { dataRoot, paths, createRecord, writeIndex } = await fixture(t);
  const bad = await createRecord({ source: "export function apply() { throw new Error('persistent'); }", requiredServices: [] });
  await writeIndex([bad.record]);
  const first = await mountSession(await boot(), dataRoot); await first.dispose();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const { mountIncludeTree } = await import('../lib/promotion-include.js');
  const created = createConsumerSession({ ctx: await boot(), config: { dataRoot }, profile: 'acp', mountInclude: async (...args) => {
    entered(); await gate; return mountIncludeTree(...args);
  } });
  const mounting = created.mount(); await started;
  const stopping = created.dispose(); release(); await Promise.all([mounting, stopping]);
  const state = (await readConsumerState(paths, 'acp')).state;
  assert.equal(state.plugins[0].status, 'failed');
  assert.equal(state.plugins[0].reason, 'plugin-apply-failed');
  assert.equal(state.plugins[0].errorCode, 'E_CONSUMER_PLUGIN_APPLY_FAILED');
});

/**
 * A short-lived ACP session that shuts down while its consumer entry is still
 * starting must not replace the activation report of a session that is already
 * live in the same profile. The running host has one state file per profile, so
 * an aborted start that publishes `include-unavailable` (or an empty row list)
 * would make the self-evolution review call a mounted plugin unavailable and
 * advise a restart that is not needed.
 */
async function mountedLiveReport(t, { approvedProfiles = ['acp'] } = {}) {
  const { dataRoot, paths, createRecord, writeIndex } = await fixture(t);
  const { record, toolName } = await createRecord({ approvedProfiles });
  await writeIndex([record]);
  const live = await mountSession(await boot(), dataRoot);
  assert.equal(live.rows[0].status, 'active');
  assert.deepEqual((await readConsumerState(paths, 'acp')).state.plugins.map((row) => row.status), ['active']);
  const baseline = (await readConsumerState(paths, 'acp')).state;
  return { dataRoot, paths, record, toolName, live, baseline };
}

async function assertInheritedReportPreserved({ dataRoot, paths, record, baseline }) {
  const state = (await readConsumerState(paths, 'acp')).state;
  assert.equal(state.sessionId, baseline.sessionId, 'the aborted session kept ownership of the last published report');
  assert.equal(state.observedIndexUpdatedAt, baseline.observedIndexUpdatedAt, 'the inherited index observation was replaced');
  assert.deepEqual(state.plugins, baseline.plugins, 'the aborted session replaced the live activation rows');
  assert.equal(typeof state.disposedAt, 'string', 'the aborted session disposal was not recorded');
  assert.deepEqual(state.disposal, { released: true, entries: 0 });
  // The audit reads the same file: the preserved active row must stay active
  // and must not produce the unnecessary restart-consumer action.
  const review = await readPublishedPluginReview({ paths: { dataRoot }, host: { profile: 'acp', ...HOST } });
  const recordReview = review.records.find((row) => row.id === record.id);
  assert.equal(recordReview.status, 'active');
  assert.equal(recordReview.action, null);
  assert.equal(review.nextActions.some((action) => action.action === 'restart-consumer' && action.recordId === record.id), false);
  return state;
}

test('a session whose own context is already inactive cannot overwrite the live activation report', async (t) => {
  const env = await mountedLiveReport(t);
  let attempts = 0;
  const inactiveCtx = { get: () => null, fiber: { uid: null } };
  const aborted = createConsumerSession({
    ctx: inactiveCtx,
    config: { dataRoot: env.dataRoot },
    profile: 'acp',
    mountInclude: async () => {
      attempts += 1;
      throw Object.assign(new Error('inactive'), { code: 'INACTIVE_EFFECT', consumerRetrySafe: true });
    },
  });
  await aborted.mount();
  // The claim keeps the inherited rows, but an already-inactive session cannot
  // reach the Include at all; it must not spend the retry budget or publish.
  assert.equal(attempts, 0);
  assert.deepEqual((await readConsumerState(env.paths, 'acp')).state.plugins.map((row) => row.status), ['active']);
  await aborted.dispose();
  await assertInheritedReportPreserved(env);
  await env.live.dispose();
});

test('a session that goes inactive during the Include mount is cancellation, not include-unavailable', async (t) => {
  const env = await mountedLiveReport(t);
  let attempts = 0;
  const dyingCtx = { get: () => null, fiber: { uid: 1 } };
  const aborted = createConsumerSession({
    ctx: dyingCtx,
    config: { dataRoot: env.dataRoot },
    profile: 'acp',
    mountInclude: async () => {
      attempts += 1;
      dyingCtx.fiber.uid = null;
      throw Object.assign(new Error('inactive'), { code: 'INACTIVE_EFFECT', consumerRetrySafe: true });
    },
  });
  await aborted.mount();
  assert.equal(attempts, 1, 'a dying session must not retry a mount that its own shutdown invalidated');
  await aborted.dispose();
  const state = await assertInheritedReportPreserved(env);
  assert.equal(state.plugins[0].reason, null);
  assert.equal(state.plugins[0].errorCode, null);
  await env.live.dispose();
});

test('disposal during Include startup preserves the inherited activation report', async (t) => {
  const env = await mountedLiveReport(t);
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const stopping = createConsumerSession({
    ctx: await boot(),
    config: { dataRoot: env.dataRoot },
    profile: 'acp',
    mountInclude: async () => {
      entered();
      await gate;
      return { dispose: async () => {} };
    },
  });
  const mounting = stopping.mount();
  await started;
  const disposal = stopping.dispose();
  release();
  await Promise.all([mounting, disposal]);
  assert.deepEqual(await disposal, { released: true, entries: 0 });
  await assertInheritedReportPreserved(env);
  await env.live.dispose();
});

/**
 * The publication liveness question has a second shape than "my own fiber is
 * disposed": a host shutdown brings the ancestor fibers to UNLOADING before it
 * reaches this band entry's disposer, so the entry is still LOADING (its own
 * `uid` is set) while nothing it observes about the Include or the services is
 * a fact about the profile anymore. Reporting those observations would replace
 * a live session's activation with `include-unavailable` and make the audit
 * advise a restart that is not needed.
 */
test('a host that is already tearing down cannot publish include-unavailable over the live report', async (t) => {
  const env = await mountedLiveReport(t);
  let attempts = 0;
  const dyingHost = {
    get: () => null,
    fiber: { uid: 1, state: 1, parent: { fiber: { uid: 4, state: 5 } } },
    root: { fiber: { uid: 0, state: 5 } },
  };
  const aborted = createConsumerSession({
    ctx: dyingHost,
    config: { dataRoot: env.dataRoot },
    profile: 'acp',
    mountInclude: async () => {
      attempts += 1;
      throw new Error('the Include went away with the host');
    },
  });
  await aborted.mount();
  assert.equal(attempts, 0, 'an unloading host cannot reach the Include at all');
  await aborted.dispose();
  await assertInheritedReportPreserved(env);
  await env.live.dispose();
});

/**
 * The same question on the success path: the mount settles, the shutdown lands
 * while the capability/service probes and the refresh run, so the computed rows
 * describe the teardown (`missing-service`, `include-unavailable`) instead of
 * the live profile. Nothing may be published from that session.
 */
test('a session that loses its context after a successful mount publishes nothing', async (t) => {
  const env = await mountedLiveReport(t);
  const ctx = { get: () => null, fiber: { uid: 1, state: 1 } };
  const aborted = createConsumerSession({
    ctx,
    config: { dataRoot: env.dataRoot },
    profile: 'acp',
    mountInclude: async () => ({
      capabilities: {},
      refresh: async () => {
        ctx.fiber.uid = null;
        throw new Error('the Include refreshed during shutdown');
      },
      dispose: async () => {},
    }),
  });
  await aborted.mount();
  await aborted.dispose();
  await assertInheritedReportPreserved(env);
  await env.live.dispose();
});
