import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context, Service } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import * as consumerEntry from '../lib/promoted-consumer.js';
import {
  createConsumerSession,
  resolveConsumerProfile,
} from '../lib/promoted-consumer.js';
import { fiberIsActive } from '../lib/cordis-compat.js';
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

  const readComposition = async (profile) => JSON.parse(await fs.readFile(paths.compositionPath(profile), 'utf8'));

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
  assert.equal(state.state.compositionPath, paths.compositionPath('acp'));
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
