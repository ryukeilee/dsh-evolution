// Failure paths of the two entry points (`lib/registration.js` and
// `lib/index.js`).
//
// The invariant these tests pin: a cleanup step never replaces the error that
// actually failed. The durable flush after a tool call and the `undefine` after
// a runtime preparation are cleanup, so when the operation itself already
// failed the caller keeps that error — and the cleanup failure is written as a
// redacted diagnostic instead of disappearing. When the operation succeeded, the
// cleanup failure is still the one error reported (unchanged behaviour).
//
// The bundle-level cases run against the REAL installed Cordis, storage-domain
// and storage-json packages, because the cleanup they check (releasing the
// domain archive lock) is performed by Cordis disposing the effects the port
// registered, not by an `apply()`-local `try/catch`. Everything is synthetic and
// lives in os.tmpdir().
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { apply, EVOLUTION_TOOLS } from '../lib/registration.js';
import * as bundle from '../lib/index.js';

const SECRET = 'hunter2-entry-secret';

// ---------------------------------------------------------------------------
// lib/registration.js: the durable flush is cleanup, not the tool result
// ---------------------------------------------------------------------------

function registrationFixture(config = {}) {
  const tools = new Map();
  const warnings = [];
  const ctx = {
    dynamicCordisRunner: {},
    tools: { register: (definition) => { tools.set(definition.name, definition); } },
    systemPrompt: { section: () => {} },
    on: () => {},
    logger: { warn: (message) => warnings.push(message) },
  };
  const core = apply(ctx, { startupDrift: false, memory: {}, eventBridge: {}, ...config });
  return { core, tools, warnings };
}

const flushFails = () => ({
  flush: async () => { throw new Error(`E_DOMAIN_ARCHIVE_LOCK (flush failed: password=${SECRET})`); },
  query: () => null,
  observe: () => {},
});

test('a tool error keeps its own message when the durable flush also fails', async () => {
  const { core, tools, warnings } = registrationFixture({ domainStorage: flushFails() });
  core.trial = async () => { throw new Error('PRIMARY: trial failed for a specific reason'); };

  await assert.rejects(
    tools.get('evolution_trial').execute({ experimentId: 'exp-1' }, { agent: { id: 'a' } }),
    /PRIMARY: trial failed for a specific reason/,
    'the flush failure must not replace the reason the tool failed',
  );

  assert.equal(warnings.length, 1, 'the flush failure is still reported exactly once');
  assert.match(warnings[0], /\[evolution\] domain flush failed after a tool error/);
  assert.match(warnings[0], /cleanup-or-rollback/, 'the diagnostic says which stage failed');
  assert.match(warnings[0], /sha256:[0-9a-f]{16}/, 'the digest keeps distinct failures distinct');
  assert.equal(warnings[0].includes(SECRET), false, 'the diagnostic is the redacted DTO, not the raw text');
  assert.equal(warnings[0].includes('PRIMARY'), false, 'the diagnostic describes the flush, not the tool error');
});

test('a successful tool call still fails when the durable flush fails', async () => {
  // Pinned, unchanged behaviour: with no primary error the flush failure IS the
  // result of the call, and it is reported rather than logged.
  const { core, tools, warnings } = registrationFixture({ domainStorage: flushFails() });
  core.measure = () => ({ ok: true });
  await assert.rejects(
    tools.get('evolution_measure').execute({ experimentId: 'exp-1', observation: {} }, { agent: { id: 'a' } }),
    /E_DOMAIN_ARCHIVE_LOCK/,
  );
  assert.deepEqual(warnings, [], 'nothing is logged when the flush error is the reported error');
});

test('the flush diagnostic cannot itself become the failure', async () => {
  // The diagnostic is a foreign call (`ctx.logger.warn`) on the failure path: a
  // logger that throws, returns a rejected promise, or cannot be reached must
  // not replace the tool error. This test also fails through the runner's
  // unhandled-rejection handling if a rejected logger promise escapes.
  const loggers = [
    { name: 'throwing', warn() { throw new Error(`logger failed: token=${SECRET}`); } },
    { name: 'rejecting', warn() { return Promise.reject(new Error(`logger failed: token=${SECRET}`)); } },
    { name: 'unreachable getter', get warn() { throw new Error(`logger failed: token=${SECRET}`); } },
    { name: 'absent', warn: undefined },
  ];
  for (const logger of loggers) {
    const { core, tools } = registrationFixture({ domainStorage: flushFails() });
    core.ctx.logger = logger;
    core.trial = async () => { throw new Error('PRIMARY: trial failed'); };
    await assert.rejects(
      tools.get('evolution_trial').execute({ experimentId: 'exp-1' }, { agent: { id: 'a' } }),
      /PRIMARY: trial failed/,
      logger.name,
    );
    await new Promise((resolve) => setImmediate(resolve));
  }
});

// ---------------------------------------------------------------------------
// lib/index.js: prepareRuntime + initialization-failure cleanup
// ---------------------------------------------------------------------------

/**
 * Mount the real bundle on a real Cordis root context with the official storage
 * domain behind a temp root, and capture the registered tools, the runner calls
 * and the logger output.
 */
async function host(t, { composition = '[]\n' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-entry-'));
  const dataRoot = path.join(root, 'storages', 'evolution');
  fs.mkdirSync(dataRoot, { recursive: true });
  const compositionPath = path.join(dataRoot, 'promoted.cordis.yml');
  fs.writeFileSync(compositionPath, composition);
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const tools = new Map();
  const warnings = [];
  const calls = [];
  const runner = {
    calls,
    snapshot: () => [],
    define: () => { calls.push('define'); return { pluginId: 'evo-prepare', packageId: 'evo-prepare-package' }; },
    run: async () => { calls.push('run'); return { ok: true, status: 'active' }; },
    stop: async () => { calls.push('stop'); return { ok: true }; },
    undefine: async () => { calls.push('undefine'); return { ok: true }; },
  };
  const app = new Context();
  app.provide('tools', { register: (definition) => { tools.set(definition.name, definition); } });
  app.provide('systemPrompt', { section: () => {} });
  app.provide('loader', {});
  app.provide('storage', { backend: { get: () => backend } });
  const facility = new DomainFacility(app, { backend: 'json' });
  app.provide('storageDomain', facility);
  app.provide('dynamicCordisRunner', runner);
  app.logger.warn = (message) => warnings.push(message);

  const mounted = [];
  const mount = async () => {
    const fiber = app.plugin({ ...bundle }, { dshHome: root, dataRoot });
    mounted.push(fiber);
    await fiber.await();
    return fiber;
  };
  const lockPath = path.join(dataRoot, 'domain-archive.lock');
  const proposal = { why: 'entry failure path', target: 'plugin:entry', impactScope: ['test'], successMetrics: ['diagnostics'] };

  t.after(async () => {
    for (const fiber of mounted) await fiber.dispose().catch(() => {});
    await backend.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, dataRoot, compositionPath, lockPath, app, tools, warnings, runner, mount, proposal };
}

const propose = (fixture) => fixture.tools.get('evolution_propose')
  .execute(fixture.proposal, { agent: { id: 'entry-agent' } });

/** Settle without `assert.rejects`: a falsy rejection value is a legal outcome
 * here and has to be compared by identity, not by truthiness. */
const settle = (promise) => promise.then(
  (value) => ({ status: 'fulfilled', value }),
  (reason) => ({ status: 'rejected', reason }),
);

test('a failed preparation keeps its own error when undefine also fails', async (t) => {
  const fixture = await host(t);
  fixture.runner.run = async () => { fixture.runner.calls.push('run'); throw new Error('PRIMARY: preparation run failed'); };
  fixture.runner.undefine = async () => {
    fixture.runner.calls.push('undefine');
    throw new Error(`undefine failed: token=${SECRET}`);
  };
  await fixture.mount();

  await assert.rejects(propose(fixture), /PRIMARY: preparation run failed/,
    'the cleanup failure must not replace the preparation failure');
  assert.deepEqual(fixture.runner.calls, ['define', 'run', 'undefine'],
    'undefine still runs after a failed run');

  assert.equal(fixture.warnings.length, 1, 'the cleanup failure is still reported exactly once');
  assert.match(fixture.warnings[0], /\[evolution\] runtime preparation undefine failed/);
  assert.match(fixture.warnings[0], /cleanup-or-rollback/);
  assert.match(fixture.warnings[0], /sha256:[0-9a-f]{16}/);
  assert.equal(fixture.warnings[0].includes(SECRET), false, 'the diagnostic never carries the raw text');
});

test('a failed preparation whose undefine reports ok=false also keeps the primary error', async (t) => {
  const fixture = await host(t);
  fixture.runner.run = async () => { fixture.runner.calls.push('run'); return { ok: false, message: 'PRIMARY: host refused the preparation' }; };
  fixture.runner.undefine = async () => { fixture.runner.calls.push('undefine'); return { ok: false }; };
  await fixture.mount();

  await assert.rejects(propose(fixture), /PRIMARY: host refused the preparation/);
  assert.match(fixture.warnings[0] ?? '', /did not undefine/,
    'the undefine result is diagnosable from the redacted diagnostic');
});

test('a falsy undefine rejection is a cleanup failure, not a successful preparation', async (t) => {
  // `throw undefined` (and null / false / 0 / '') is a legal rejection. Testing
  // the thrown value's truthiness would read that failure as success: the
  // preparation would be cached, the plugin left defined, nothing reported, and
  // the next tool call would skip the whole sequence. Each value must reject
  // with the original value and leave the preparation retryable.
  for (const thrown of [undefined, null, false, 0, '']) {
    const fixture = await host(t);
    fixture.runner.undefine = async () => {
      fixture.runner.calls.push('undefine');
      throw thrown;
    };
    await fixture.mount();

    const first = await settle(propose(fixture));
    assert.equal(first.status, 'rejected', `thrown ${String(thrown)}: the call must not report success`);
    assert.equal(Object.is(first.reason, thrown), true,
      `thrown ${String(thrown)}: the original rejection value is preserved, not wrapped`);
    assert.deepEqual(fixture.warnings, [], 'the cleanup error is the reported error, so nothing is logged');

    // Not cached as success: the next call runs the whole sequence again and
    // fails the same way instead of silently proceeding.
    const second = await settle(propose(fixture));
    assert.equal(second.status, 'rejected');
    assert.equal(fixture.runner.calls.filter((call) => call === 'define').length, 2,
      `thrown ${String(thrown)}: a failed preparation is not remembered as done`);
  }
});

test('a falsy undefine rejection does not hide the primary preparation error', async (t) => {
  const fixture = await host(t);
  fixture.runner.run = async () => { fixture.runner.calls.push('run'); throw new Error('PRIMARY: preparation run failed'); };
  fixture.runner.undefine = async () => { fixture.runner.calls.push('undefine'); throw undefined; };
  await fixture.mount();

  await assert.rejects(propose(fixture), /PRIMARY: preparation run failed/);
  assert.equal(fixture.warnings.length, 1, 'a falsy cleanup failure is still reported once');
  assert.match(fixture.warnings[0], /\[evolution\] runtime preparation undefine failed/);
  assert.match(fixture.warnings[0], /cleanup-or-rollback/);
  assert.match(fixture.warnings[0], /sha256:[0-9a-f]{16}/);
});

test('a preparation that succeeded still fails the call when undefine fails', async (t) => {
  const fixture = await host(t);
  fixture.runner.undefine = async () => { fixture.runner.calls.push('undefine'); return { ok: false }; };
  await fixture.mount();

  await assert.rejects(propose(fixture), /Evolution runtime preparation did not undefine/,
    'with no primary error the cleanup failure is the reported error');
  assert.deepEqual(fixture.warnings, [], 'nothing is logged when the cleanup error is the reported error');
});

test('a failed preparation is retried by the next call instead of being cached as success', async (t) => {
  const fixture = await host(t);
  let attempts = 0;
  fixture.runner.run = async () => {
    fixture.runner.calls.push('run');
    attempts += 1;
    if (attempts === 1) throw new Error('PRIMARY: first preparation failed');
    return { ok: true, status: 'active' };
  };
  await fixture.mount();

  await assert.rejects(propose(fixture), /PRIMARY: first preparation failed/);
  const result = await propose(fixture);
  assert.equal(result.phase, 'proposed', 'the retried preparation lets the tool proceed');
  assert.equal(attempts, 2);
  assert.deepEqual(fixture.runner.calls,
    ['define', 'run', 'undefine', 'define', 'run', 'stop', 'undefine'],
    'the retry runs the whole public define/run/stop/undefine sequence again');
});

test('a failed bundle initialization releases the domain archive lock and the same process can retry', async (t) => {
  const fixture = await host(t, { composition: 'not: [valid: yaml: entry list\n' });

  await assert.rejects(fixture.mount(), (error) => {
    assert.equal(typeof error?.message, 'string');
    assert.ok(error.message.length > 0, 'the initialization failure is reported with its own reason');
    return true;
  });

  assert.equal(fs.existsSync(path.join(fixture.dataRoot, 'dockyard')), true,
    'the failure happened after the domain storage port was opened');
  assert.equal(fs.existsSync(fixture.lockPath), false,
    'the failed initialization released the archive lock it took');
  assert.equal(fixture.tools.size, 0, 'no tool surface was published by the failed mount');

  // The retry is the property that matters: the failed attempt left nothing
  // behind that the next mount in this process would trip over.
  fs.writeFileSync(fixture.compositionPath, '[]\n');
  await fixture.mount();
  assert.equal(fs.existsSync(fixture.lockPath), true,
    'the retry actually opened the domain storage (a leaked lock would have thrown E_DOMAIN_ARCHIVE_LOCK)');
  assert.deepEqual([...fixture.tools.keys()].sort(), [...EVOLUTION_TOOLS].sort(),
    'the retried mount publishes the full tool surface again');
});
