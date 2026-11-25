import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { Context, Service } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import {
  CONSUMER_SESSION_LEASE_KIND,
  CONSUMER_SESSION_LEASE_SCHEMA_VERSION,
  CONSUMER_SESSION_GC_LIMITS,
  collectConsumerSessionGarbage,
  consumerSessionFileNames,
  defaultIsProcessAlive,
  removeConsumerSessionLease,
  writeConsumerSessionLease,
} from '../lib/promoted-consumer-gc.js';
import { createConsumerSession } from '../lib/promoted-consumer.js';
import { sharingPaths } from '../lib/promoted-sharing.js';

const PROFILE = 'acp';

async function tempConsumers(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'consumer-gc-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const consumersDir = path.join(home, 'shared-plugins', 'consumers');
  await fs.mkdir(consumersDir, { recursive: true, mode: 0o700 });
  return { home, consumersDir };
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function writeComposition(consumersDir, sessionId, content = '[]\n') {
  const file = path.join(consumersDir, consumerSessionFileNames(PROFILE, sessionId).composition);
  await fs.writeFile(file, content, { mode: 0o600 });
  return file;
}

async function spawnDeadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  return child.pid;
}

function decisionsBySession(result) {
  return new Map(result.decisions.map((decision) => [decision.sessionId, decision]));
}

// --- A. Structured collection ------------------------------------------------

test('A: stale leases, a legacy composition and live files are separated by session', async (t) => {
  const { consumersDir } = await tempConsumers(t);
  const deadA = crypto.randomUUID();
  const deadB = crypto.randomUUID();
  const legacy = crypto.randomUUID();
  const recent = crypto.randomUUID();
  const live = crypto.randomUUID();

  for (const sessionId of [deadA, deadB]) {
    await writeConsumerSessionLease({
      consumersDir,
      profile: PROFILE,
      sessionId,
      pid: 900001 + sessionId.length,
      hostname: os.hostname(),
    });
    await writeComposition(consumersDir, sessionId);
  }
  const legacyFile = await writeComposition(consumersDir, legacy);
  const old = Date.now() - 48 * 60 * 60 * 1000;
  await fs.utimes(legacyFile, new Date(old), new Date(old));
  await writeComposition(consumersDir, recent);

  // This session owns a live pid but is NOT the id recorded in consumer state.
  await writeConsumerSessionLease({ consumersDir, profile: PROFILE, sessionId: live, pid: process.pid });
  await writeComposition(consumersDir, live);
  const stateFile = path.join(consumersDir, `${PROFILE}.json`);
  const stateBytes = `${JSON.stringify({ schemaVersion: 1, sessionId: recent, plugins: [] }, null, 2)}\n`;
  await fs.writeFile(stateFile, stateBytes, { mode: 0o600 });

  const otherProfileFile = `web.${crypto.randomUUID()}.cordis.yml`;
  for (const name of [`${PROFILE}.cordis.yml`, otherProfileFile, '.consumer-123.tmp']) {
    await fs.writeFile(path.join(consumersDir, name), '[]\n');
  }

  const result = await collectConsumerSessionGarbage({
    consumersDir,
    profile: PROFILE,
    isProcessAlive: (pid) => pid === process.pid,
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.scanned, 12);
  assert.equal(result.sessions, 5);
  assert.deepEqual(result.kept, { live: 1, recent: 1, unproven: 0, foreignHost: 0 });
  assert.equal(result.keptOtherProfile, 1);
  assert.equal(result.ignored, 3);
  assert.equal(result.removedCompositions, 3);
  assert.equal(result.removedLeases, 2);
  assert.equal(result.bytesReclaimed > 0, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.deferred, 0);
  assert.equal(result.truncated, false);

  const decisions = decisionsBySession(result);
  assert.equal(decisions.get(deadA).action, 'remove');
  assert.equal(decisions.get(deadA).reason, 'stale-lease');
  assert.equal(decisions.get(deadB).reason, 'stale-lease');
  assert.equal(decisions.get(legacy).reason, 'legacy-window');
  assert.equal(decisions.get(recent).reason, 'recent');
  assert.equal(decisions.get(live).reason, 'live-lease');

  for (const sessionId of [deadA, deadB, legacy]) {
    const names = consumerSessionFileNames(PROFILE, sessionId);
    assert.equal(await exists(path.join(consumersDir, names.composition)), false);
    assert.equal(await exists(path.join(consumersDir, names.lease)), false);
  }
  for (const sessionId of [recent, live]) {
    assert.equal(await exists(path.join(consumersDir, consumerSessionFileNames(PROFILE, sessionId).composition)), true);
  }
  assert.equal(await exists(path.join(consumersDir, `${PROFILE}.cordis.yml`)), true);
  assert.equal(await exists(path.join(consumersDir, otherProfileFile)), true);
  assert.equal(await exists(path.join(consumersDir, '.consumer-123.tmp')), true);
  assert.equal(await exists(stateFile), true);
  assert.equal(await fs.readFile(stateFile, 'utf8'), stateBytes, 'consumer state bytes must not change');
});

// --- B. Default liveness -----------------------------------------------------

test('B: defaultIsProcessAlive only treats ESRCH as death', async () => {
  const deadPid = await spawnDeadPid();
  assert.equal(defaultIsProcessAlive(deadPid), false);
  assert.equal(defaultIsProcessAlive(process.pid), true);
  for (const invalid of [0, -1, 1.5, Number.NaN, '123', null, undefined]) {
    assert.equal(defaultIsProcessAlive(invalid), true, `unprovable pid ${String(invalid)} must stay alive`);
  }
});

// --- C. Unprovable lease shapes ---------------------------------------------

test('C: malformed, mismatched, foreign and oversized leases are kept', async (t) => {
  const { consumersDir } = await tempConsumers(t);
  const hostname = os.hostname();
  const valid = (sessionId, overrides = {}) => ({
    schemaVersion: CONSUMER_SESSION_LEASE_SCHEMA_VERSION,
    kind: CONSUMER_SESSION_LEASE_KIND,
    profile: PROFILE,
    sessionId,
    pid: 900001,
    hostname,
    createdAt: '2026-11-26T10:00:00.000Z',
    processStartedAt: '2026-11-26T09:59:50.000Z',
    ...overrides,
  });

  const cases = [
    ['bad-json', (id) => '{not json', 'unproven-lease'],
    ['schema', (id) => valid(id, { schemaVersion: 2 }), 'unproven-lease'],
    ['kind', (id) => valid(id, { kind: 'something-else' }), 'unproven-lease'],
    ['profile', (id) => valid(id, { profile: 'web' }), 'unproven-lease'],
    ['session', (id) => valid(id, { sessionId: crypto.randomUUID() }), 'unproven-lease'],
    ['no-pid', (id) => { const doc = valid(id); delete doc.pid; return doc; }, 'unproven-lease'],
    ['bad-pid', (id) => valid(id, { pid: 0 }), 'unproven-lease'],
    ['foreign', (id) => valid(id, { hostname: 'another-host.invalid' }), 'foreign-host'],
    ['oversize', (id) => valid(id, { note: 'x'.repeat(5000) }), 'unproven-lease'],
  ];

  for (const [label, makeLease, _reason] of cases) {
    const sessionId = crypto.randomUUID();
    await writeComposition(consumersDir, sessionId);
    const file = path.join(consumersDir, consumerSessionFileNames(PROFILE, sessionId).lease);
    const value = makeLease(sessionId);
    await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  }

  const result = await collectConsumerSessionGarbage({
    consumersDir,
    profile: PROFILE,
    isProcessAlive: () => false,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.sessions, cases.length);
  assert.equal(result.removedCompositions, 0);
  assert.equal(result.removedLeases, 0);
  assert.equal(result.kept.live, 0);
  assert.equal(result.kept.recent, 0);
  assert.equal(result.kept.unproven, cases.length - 1);
  assert.equal(result.kept.foreignHost, 1);
  for (const [label, _make, reason] of cases) {
    assert.ok([...decisionsBySession(result).values()].some((decision) => decision.reason === reason), `${label} reason ${reason}`);
  }
  for (const name of await fs.readdir(consumersDir)) {
    assert.equal(await exists(path.join(consumersDir, name)), true, `${name} must survive`);
  }
});

// --- D. Lease without composition -------------------------------------------

test('D: a dead lease with no composition is removed on its own', async (t) => {
  const { consumersDir } = await tempConsumers(t);
  const sessionId = crypto.randomUUID();
  await writeConsumerSessionLease({ consumersDir, profile: PROFILE, sessionId, pid: 900001 });
  const file = path.join(consumersDir, consumerSessionFileNames(PROFILE, sessionId).lease);

  const result = await collectConsumerSessionGarbage({ consumersDir, profile: PROFILE, isProcessAlive: () => false });
  assert.equal(result.status, 'ok');
  assert.equal(result.removedLeases, 1);
  assert.equal(result.removedCompositions, 0);
  assert.equal(result.bytesReclaimed > 0, true);
  assert.deepEqual(decisionsBySession(result).get(sessionId), { sessionId, action: 'remove', reason: 'stale-lease' });
  assert.equal(await exists(file), false);
});

// --- E. Bounds ---------------------------------------------------------------

test('E: maxRemovals defers surplus files and maxEntries truncates the pass', async (t) => {
  const { consumersDir } = await tempConsumers(t);
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  for (const sessionId of ids) {
    await writeConsumerSessionLease({ consumersDir, profile: PROFILE, sessionId, pid: 900001 });
  }
  const removal = await collectConsumerSessionGarbage({
    consumersDir,
    profile: PROFILE,
    isProcessAlive: () => false,
    limits: { ...CONSUMER_SESSION_GC_LIMITS, maxRemovals: 1 },
  });
  assert.equal(removal.status, 'ok');
  assert.equal(removal.removedLeases, 1);
  assert.equal(removal.deferred >= 1, true);
  assert.equal(await exists(path.join(consumersDir, consumerSessionFileNames(PROFILE, ids[1]).lease)), true);

  const { consumersDir: secondDir } = await tempConsumers(t);
  const more = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  for (const sessionId of more) {
    await writeConsumerSessionLease({ consumersDir: secondDir, profile: PROFILE, sessionId, pid: 900001 });
  }
  const truncated = await collectConsumerSessionGarbage({
    consumersDir: secondDir,
    profile: PROFILE,
    isProcessAlive: () => false,
    limits: { ...CONSUMER_SESSION_GC_LIMITS, maxEntries: 2 },
  });
  assert.equal(truncated.status, 'ok');
  assert.equal(truncated.sessions, 3);
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.decisions.length, 2);
  assert.equal(truncated.removedLeases, 2);
});

// --- F. Removal failures -----------------------------------------------------

test('F: one EACCES is bounded, recorded, and does not stop other removals', async (t) => {
  const { consumersDir } = await tempConsumers(t);
  const blocked = crypto.randomUUID();
  const removable = crypto.randomUUID();
  for (const sessionId of [blocked, removable]) {
    await writeConsumerSessionLease({ consumersDir, profile: PROFILE, sessionId, pid: 900001 });
  }
  const blockedFile = path.join(consumersDir, consumerSessionFileNames(PROFILE, blocked).lease);

  const result = await collectConsumerSessionGarbage({
    consumersDir,
    profile: PROFILE,
    isProcessAlive: () => false,
    removeFile: async (file) => {
      if (file === blockedFile) {
        const error = new Error('secret-bearing message must not escape');
        error.code = 'EACCES';
        throw error;
      }
      await fs.rm(file, { force: true });
    },
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.removedLeases, 1);
  assert.deepEqual(result.failures, [{ name: path.basename(blockedFile), code: 'EACCES' }]);
  assert.equal(await exists(blockedFile), true);
  assert.equal(await exists(path.join(consumersDir, consumerSessionFileNames(PROFILE, removable).lease)), false);
});

// --- G. Absent / unavailable directory --------------------------------------

test('G: absent and unusable consumers directories are reported, never created', async (t) => {
  const { home } = await tempConsumers(t);
  const absentDir = path.join(home, 'never-created');
  const absent = await collectConsumerSessionGarbage({ consumersDir: absentDir, profile: PROFILE });
  assert.equal(absent.status, 'absent');
  assert.equal(await exists(absentDir), false);

  const file = path.join(home, 'not-a-directory');
  await fs.writeFile(file, 'x');
  const unavailable = await collectConsumerSessionGarbage({ consumersDir: file, profile: PROFILE });
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.failures.length, 0);
});

// --- H. Startup / mount unaffected ------------------------------------------

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
  constructor(ctx) {
    super(ctx, 'pluginPackages');
    this.versions = HOST_VERSIONS;
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
  await ctx.plugin(FakePluginPackages);
  return ctx;
}

async function createPublishedRecord(t, dataRoot) {
  const pluginRoot = path.join(dataRoot, 'promoted');
  const experimentId = `exp-${crypto.randomBytes(6).toString('hex')}`;
  const id = `evolution-promoted-${crypto.createHash('sha256').update(experimentId).digest('hex').slice(0, 12)}`;
  const pluginName = `dsh-${id}`;
  const dir = path.join(pluginRoot, pluginName);
  await fs.mkdir(path.join(dir, 'lib'), { recursive: true, mode: 0o700 });
  const toolName = `gc_tool_${crypto.randomBytes(3).toString('hex')}`;
  const source = [
    `export const name = ${JSON.stringify(pluginName)};`,
    'export const inject = ["tools"];',
    'export function apply(ctx) {',
    '  ctx.effect(() => {',
    `    const dispose = ctx.tools.register({ name: ${JSON.stringify(toolName)}, description: 'gc probe' });`,
    "    return () => { if (typeof dispose === 'function') dispose(); };",
    '  });',
    '}',
    '',
  ].join('\n');
  const modulePath = path.join(dir, 'lib', 'index.js');
  const manifestPath = path.join(dir, 'package.json');
  await fs.writeFile(modulePath, source);
  await fs.writeFile(manifestPath, `${JSON.stringify({ name: pluginName, version: '1.0.0', type: 'module', main: 'lib/index.js' }, null, 2)}\n`);
  const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  const paths = sharingPaths({ dataRoot });
  await fs.mkdir(paths.dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(paths.indexPath, `${JSON.stringify({
    schemaVersion: 1,
    kind: 'dsh-evolution-shared-plugins',
    updatedAt: new Date().toISOString(),
    publisher: { profile: 'desktop' },
    plugins: [{
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
    }],
  }, null, 2)}\n`, { mode: 0o600 });
  return { toolName };
}

async function seedSessionFiles(consumersDir, sessionId, pid) {
  await writeConsumerSessionLease({ consumersDir, profile: PROFILE, sessionId, pid, hostname: os.hostname() });
  return writeComposition(consumersDir, sessionId);
}

test('H: mount stays active while GC reclaims an orphan and contains a removal failure', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'consumer-gc-mount-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dataRoot = path.join(home, 'storages', 'evolution');
  const paths = sharingPaths({ dataRoot });

  const run = async ({ failRemoval }) => {
    await createPublishedRecord(t, dataRoot);
    const deadPid = await spawnDeadPid();
    const orphan = crypto.randomUUID();
    const other = crypto.randomUUID();
    const orphanFiles = await seedSessionFiles(paths.consumersDir, orphan, deadPid);
    const otherFiles = await seedSessionFiles(paths.consumersDir, other, process.pid);
    const otherLease = path.join(paths.consumersDir, consumerSessionFileNames(PROFILE, other).lease);

    const ctx = await boot();
    const warnings = [];
    ctx.logger = { warn: (...args) => { warnings.push(args); } };
    const removeFile = async (file) => {
      if (failRemoval && file === path.join(paths.consumersDir, consumerSessionFileNames(PROFILE, orphan).lease)) {
        const error = new Error('raw error must not reach the logger');
        error.code = 'EACCES';
        throw error;
      }
      await fs.rm(file, { force: true });
    };
    const created = createConsumerSession({
      ctx,
      config: { dataRoot },
      profile: PROFILE,
      gc: {
        isProcessAlive: (pid) => (pid === deadPid ? false : defaultIsProcessAlive(pid)),
        removeFile,
      },
    });
    await created.mount();
    const result = await created.collectStaleSessions();
    const snapshot = {
      status: created.session.rows[0]?.status,
      result,
      warnings,
      orphanSessionId: orphan,
      orphanFiles,
      otherFiles,
      otherLease,
      leaseWritten: created.session.leaseWritten,
      ownComposition: await exists(created.session.compositionPath),
      ownLease: await exists(created.session.leasePath),
    };
    await created.dispose();
    return snapshot;
  };

  const clean = await run({ failRemoval: false });
  assert.equal(clean.status, 'active');
  assert.equal(clean.result.status, 'ok');
  assert.equal(clean.result.removedCompositions, 1);
  assert.equal(clean.result.removedLeases, 1);
  assert.equal(await exists(clean.orphanFiles), false);
  assert.equal(await exists(path.join(paths.consumersDir, consumerSessionFileNames(PROFILE, clean.orphanSessionId).lease)), false);
  assert.equal(await exists(clean.otherFiles), true);
  assert.equal(await exists(clean.otherLease), true);
  assert.equal(clean.leaseWritten, true);
  assert.equal(clean.ownComposition, true);
  assert.equal(clean.ownLease, true);
  assert.deepEqual(clean.warnings, []);

  const failing = await run({ failRemoval: true });
  assert.equal(failing.status, 'active');
  assert.equal(failing.result.status, 'ok');
  assert.equal(failing.result.failures.length, 1);
  assert.equal(failing.warnings.length, 1);
  const warning = failing.warnings[0];
  assert.equal(warning[0], '[evolution] promoted consumer gc (%s, status %s, removed %s/%s, kept %s, failures %s, code %s)');
  assert.equal(warning[1], 'consumer-session-gc');
  assert.equal(warning[2], 'ok');
  assert.ok(warning.includes('EACCES'));
  const dump = JSON.stringify(warning);
  assert.equal(dump.includes('raw error must not reach the logger'), false);
  assert.equal(dump.includes('EACCES'), true);
});

// --- I. Dry run --------------------------------------------------------------

test('I: dryRun reports decisions without deleting anything', async (t) => {
  const { consumersDir } = await tempConsumers(t);
  const sessionId = crypto.randomUUID();
  await writeConsumerSessionLease({ consumersDir, profile: PROFILE, sessionId, pid: 900001 });
  const composition = await writeComposition(consumersDir, sessionId);
  const lease = path.join(consumersDir, consumerSessionFileNames(PROFILE, sessionId).lease);

  const result = await collectConsumerSessionGarbage({
    consumersDir,
    profile: PROFILE,
    isProcessAlive: () => false,
    dryRun: true,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.dryRun, true);
  assert.deepEqual(decisionsBySession(result).get(sessionId), { sessionId, action: 'remove', reason: 'stale-lease' });
  assert.equal(result.removedCompositions, 0);
  assert.equal(result.removedLeases, 0);
  assert.equal(result.bytesReclaimed, 0);
  assert.equal(await exists(composition), true);
  assert.equal(await exists(lease), true);
});

// --- File-name and lease helpers ---------------------------------------------

test('file naming is strict and lease removal tolerates ENOENT', async (t) => {
  assert.deepEqual(consumerSessionFileNames(PROFILE, '01234567-89ab-cdef-0123-456789abcdef'), {
    composition: 'acp.01234567-89ab-cdef-0123-456789abcdef.cordis.yml',
    lease: 'acp.01234567-89ab-cdef-0123-456789abcdef.lease.json',
  });
  for (const [profile, sessionId] of [['ACP', '01234567-89ab-cdef-0123-456789abcdef'], ['acp', 'bad'], ['', '01234567-89ab-cdef-0123-456789abcdef'], ['acp', '01234567-89AB-cdef-0123-456789abcdef']]) {
    assert.throws(() => consumerSessionFileNames(profile, sessionId));
  }
  const { consumersDir } = await tempConsumers(t);
  await assert.doesNotReject(() => removeConsumerSessionLease({ consumersDir, profile: PROFILE, sessionId: crypto.randomUUID() }));
  const sessionId = crypto.randomUUID();
  await writeConsumerSessionLease({ consumersDir, profile: PROFILE, sessionId, pid: process.pid });
  const stat = await fs.stat(path.join(consumersDir, consumerSessionFileNames(PROFILE, sessionId).lease));
  assert.equal(stat.mode & 0o777, 0o600);
  await removeConsumerSessionLease({ consumersDir, profile: PROFILE, sessionId });
  assert.equal(await exists(path.join(consumersDir, consumerSessionFileNames(PROFILE, sessionId).lease)), false);
});
