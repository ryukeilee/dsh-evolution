// The checkpoint warning in `replay()` is a diagnostic about the pass, not part
// of its result.
//
// `writeEventLogCheckpoint()` failing only means the next pass re-verifies
// history: the records this pass authenticated are already committed, and the
// checkpoint is an optimisation over them. The warning that reports it is the
// one line in that `catch` that talks to a foreign object (`ctx.logger`), and a
// logger is not part of this contract: it can throw synchronously (the REAL
// Cordis `ctx.logger` does, when a real exporter throws), return a rejected
// promise (an unhandled rejection), or have its `warn` property throw on read.
// Any of those used to escape the `catch` and become the outcome of
// `port.flush()` - a false "flush failed" for a pass that committed everything -
// and, because `enqueue()` records the rejection as the port's failure, also the
// outcome of `port.close()`.
//
// Every case here runs against the real official storage packages
// (`@deepseek-ai/dsh-storage-domain` + `@deepseek-ai/dsh-storage-json`); one also
// exercises the real Cordis logger/exporter chain. The checkpoint failure is a
// real filesystem failure (a directory where the checkpoint file belongs).
//
// The pre-fix module is materialised beside the working tree one, so the two can
// be compared step for step on the same synthetic archive: normal completion,
// every logger fault, concurrent flushes, startup replay, the write retry after
// the path is repaired and a reopen. The comparison checks flush/close results,
// committed event IDs, checkpoint file presence and record count, normalised
// diagnostics and the failures that must still propagate. This is not a byte
// comparison of the checkpoint or the aggregate.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { signEventBridgeEnvelope } from '../../lib/orchestrator.js';
import { apply, EVOLUTION_TOOLS } from '../../lib/registration.js';
import { eventLogCheckpointPath, readEventLogCheckpoint } from '../../lib/event-log-checkpoint.js';
import { materializeDomainStorage } from './domain-storage-baseline.js';

const WORKING_SOURCE = fileURLToPath(new URL('../../lib/domain-storage.js', import.meta.url));
const KEY = 'b'.repeat(64);
const SECRET = 'hunter2-checkpoint-secret';
const DOMAIN = 'evolution_domain';

// The two shapes of the one `catch` under test. The post-fix shape is the
// working tree's; the pre-fix shape is what it replaced. Both directions are
// exact single-occurrence substitutions, so a drift in either shape fails here
// instead of silently comparing the same module twice.
const POST_FIX_BLOCK = [
  '        // Losing the checkpoint only means the next pass re-verifies history.',
  '        // The warning is a log line, and a log line is a boundary: it carries',
  '        // the safe DTO (redacted summary, category, digest), not the raw message.',
  '        // It goes through the one redacted-warning entry point so the warning',
  '        // cannot become the outcome of the pass: a logger that throws, or one',
  '        // that rejects, stays a diagnostic instead of a failed flush.',
  "        warnRedacted(ctx, 'event log checkpoint not written', error, 'event-log-checkpoint');",
].join('\n');
const PRE_FIX_BLOCK = [
  '        // Losing the checkpoint only means the next pass re-verifies history.',
  '        // The warning is a log line, and a log line is a boundary: it carries',
  '        // the safe DTO (redacted summary, category, digest), not the raw message.',
  "        const detail = safeErrorDto(error, 'event-log-checkpoint');",
  '        ctx.logger?.warn?.(`[evolution] event log checkpoint not written: ${detail.errorSummary} (${detail.errorCategory}, ${detail.errorDigest})`);',
].join('\n');
const IMPORT_WITHOUT_SAFE_DTO = "import { EVENT_BRIDGE_DEFAULT_WRITER, eventBridgeWriterTrusted, verifyEventBridgeEnvelope } from './orchestrator.js';";
const IMPORT_WITH_SAFE_DTO = "import { EVENT_BRIDGE_DEFAULT_WRITER, eventBridgeWriterTrusted, safeErrorDto, verifyEventBridgeEnvelope } from './orchestrator.js';";

/** The source as it was before this fix, derived from whatever the tree holds now. */
function derivePreFix(source) {
  if (source.split(POST_FIX_BLOCK).length - 1 === 1) {
    const derived = source.replace(POST_FIX_BLOCK, PRE_FIX_BLOCK);
    assert.equal(derived.split(IMPORT_WITHOUT_SAFE_DTO).length - 1, 1,
      'the fixed source must import the replay helpers once, so the pre-fix module can bind `safeErrorDto`');
    return derived.replace(IMPORT_WITHOUT_SAFE_DTO, IMPORT_WITH_SAFE_DTO);
  }
  assert.equal(source.split(PRE_FIX_BLOCK).length - 1, 1,
    'the checkpoint diagnostic must be the pre-fix shape or the post-fix shape this test knows');
  return source;
}

let implementationsPromise;
let implementationHome;
after(() => { if (implementationHome) fs.rmSync(implementationHome, { recursive: true, force: true }); });
function implementations() {
  return implementationsPromise ??= (async () => {
    const home = implementationHome = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-checkpoint-impls-'));
    const working = await readFile(WORKING_SOURCE, 'utf8');
    const preFixSource = derivePreFix(working);
    return {
      post: await materializeDomainStorage(working, home, 'post-fix'),
      pre: await materializeDomainStorage(preFixSource, home, 'pre-fix'),
      synthesized: preFixSource !== working,
    };
  })();
}

const eventFor = (id) => ({ schema: 1, eventId: `evolution:measurement-completed:${id}`, eventType: 'measurement-completed',
  experimentId: id, status: 'measured', measurement: { latency: 1 }, audit: { at: '2026-10-07T00:00:00.000Z' } });
const signed = (event, sequence, key = KEY) => signEventBridgeEnvelope(event, { key, sequence });

function warningsFor(kind, warnings) {
  switch (kind) {
    case 'recording': return { warn: (message) => { warnings.push(message); } };
    case 'sync-throw': return { warn: (message) => { warnings.push(message); throw new Error(`logger failed: token=${SECRET}`); } };
    case 'rejecting': return { warn: (message) => { warnings.push(message); return Promise.reject(new Error(`logger failed: token=${SECRET}`)); } };
    case 'thenable': return { warn: (message) => { warnings.push(message); return { then() { throw new Error(`logger failed: token=${SECRET}`); } }; } };
    case 'throwing-getter': return { get warn() { throw new Error(`logger failed: token=${SECRET}`); } };
    default: throw new Error(`unknown logger kind ${kind}`);
  }
}

function plainContext(backend, kind, warnings) {
  const listeners = new Map();
  const ctx = {
    emit(name, ...args) { for (const listener of listeners.get(name) ?? []) listener(...args); },
    on(name, listener) {
      const registered = listeners.get(name) ?? [];
      registered.push(listener);
      listeners.set(name, registered);
      return () => { const index = registered.indexOf(listener); if (index >= 0) registered.splice(index, 1); };
    },
    logger: warningsFor(kind, warnings),
    storage: { backend: { get: () => backend } },
    effect() {},
  };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  return { ctx, disposers: [] };
}

/**
 * The REAL Cordis logger with a REAL exporter. `logger.warn()` iterates the
 * registered exporters synchronously, so an exporter that throws makes the
 * plugin's `ctx.logger.warn(...)` throw exactly like a hand-written logger does
 * - and this is the shape the reported failure was reproduced with. The
 * recording exporter is registered first, so the message is captured before the
 * failing exporter unwinds the call.
 */
function cordisContext(backend, warnings) {
  const app = new Context();
  app.provide('storage', { backend: { get: () => backend } });
  app.provide('storageDomain', new DomainFacility(app, { backend: 'json' }));
  const disposers = [
    app.logger.exporter({ colors: 0, levels: { default: 4 }, export: (message) => { warnings.push(message.args[0]); } }),
    app.logger.exporter({ colors: 0, levels: { default: 4 }, export() { throw new Error(`exporter failed: token=${SECRET}`); } }),
  ];
  return { ctx: app, disposers };
}

const settle = (outcome) => outcome.status === 'fulfilled'
  ? { status: outcome.status, value: outcome.value }
  : { status: outcome.status, error: outcome.reason?.message ?? String(outcome.reason) };

const appliedMarkers = (ctx) => {
  try { return ctx.storageDomain.get(DOMAIN).global.get().applied; } catch { return null; }
};

/**
 * Use the actual registration wrappers and the actual domain flush. Stub only
 * the tool bodies that would otherwise start trials or mutate production; this
 * checks the result/finally/flush chain, not the runner's lifecycle contract.
 */
async function registeredCalls(ctx, config, port, mode, observed) {
  const tools = new Map();
  ctx.tools = { register: definition => tools.set(definition.name, definition) };
  ctx.systemPrompt = { section() {} };
  ctx.dynamicCordisRunner = {};
  const domainStorage = { ...port, flush: async () => {
    const [result] = await Promise.allSettled([port.flush()]);
    observed.flush.push(settle(result));
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  } };
  const core = apply(ctx, { ...config, domainStorage, startupDrift: false,
    memory: {}, eventBridge: {}, diagnose: () => ({ ok: true }) });
  const primary = new Error('PRIMARY: trial body failed');
  for (const method of ['inspect', 'propose', 'trial', 'measure', 'revert', 'promote', 'observeCanary']) {
    core[method] = () => {
      if (mode === 'primary-error') throw primary;
      return { ok: true };
    };
  }
  assert.deepEqual([...tools.keys()].sort(), [...EVOLUTION_TOOLS].sort());
  const names = mode === 'primary-error' ? ['evolution_trial'] : EVOLUTION_TOOLS;
  // `evolution_maintain` is the one destructive tool: its read-only mode is the
  // argument that makes a blanket "call every tool" sweep safe, and it is still a
  // real call through the tool boundary.
  const argumentsFor = name => (name === 'evolution_maintain' ? { dryRun: true } : { collection: 'cycles' });
  observed.tools = [];
  for (const name of names) {
    const [result] = await Promise.allSettled([
      tools.get(name).execute(argumentsFor(name), { agent: { id: 'synthetic-agent' } }),
    ]);
    if (mode === 'primary-error') assert.equal(result.reason, primary, 'keep the primary error object');
    observed.tools.push({ name, ...settle(result) });
  }
}

/**
 * Run one canvas: a real archive root, the real storage medium, a checkpoint
 * path that may be unwritable, and the chosen logger. Returns every observable
 * the comparison uses - never an assertion - so the pre-fix and post-fix runs
 * can be compared field by field.
 */
async function scenario(impl, options = {}) {
  const {
    loggerKind = 'recording', contextKind = 'plain', checkpointFault = false,
    preload = [], after = [], flushes = 1, repair = false, reopen = false,
    registered = null, commitFault = false,
  } = options;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-checkpoint-diag-'));
  const bridgePath = path.join(root, 'execution-events.jsonl');
  const checkpointFile = eventLogCheckpointPath(root);
  const config = { presetDir: root, eventBridgePath: bridgePath, eventBridgeKey: KEY };
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const warnings = [];
  const observe = { openError: null, flush: [], applied: null, checkpointExists: null,
    checkpointRecords: null, closeError: null, reopen: null, tools: null };
  let ctx, port, disposers = [];
  if (preload.length) fs.writeFileSync(bridgePath, preload.map((envelope) => `${JSON.stringify(envelope)}\n`).join(''));
  // A directory where the checkpoint file belongs: `writeEventLogCheckpoint()`
  // writes its temporary file beside it and then cannot rename over it, which is
  // the real failure the warning reports. `readEventLogCheckpoint()` reports the
  // same path as absent, exactly as it does for any unreadable checkpoint.
  if (checkpointFault) fs.mkdirSync(checkpointFile);
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason?.message ?? String(reason));
  process.on('unhandledRejection', onUnhandled);
  try {
    const built = contextKind === 'cordis'
      ? cordisContext(backend, warnings)
      : plainContext(backend, loggerKind, warnings);
    ctx = built.ctx;
    disposers = built.disposers;
    try { port = await impl.openDomainStorage(ctx, config); }
    catch (error) { observe.openError = error.message; }
    if (port) {
      if (after.length) fs.appendFileSync(bridgePath, after.map((envelope) => `${JSON.stringify(envelope)}\n`).join(''));
      if (commitFault) ctx.storageDomain.get(DOMAIN).global.set = async () => { throw new Error('INJECTED_DOMAIN_COMMIT'); };
      if (registered) await registeredCalls(ctx, config, port, registered, observe);
      else observe.flush.push(...(await Promise.allSettled(Array.from({ length: flushes }, () => port.flush()))).map(settle));
      if (repair) {
        fs.rmSync(checkpointFile, { recursive: true, force: true });
        observe.flush.push(...(await Promise.allSettled([port.flush()])).map(settle));
      }
      observe.applied = Object.keys(appliedMarkers(ctx) ?? {}).sort();
      // A file, not merely a path: the injected failure leaves a directory here.
      observe.checkpointExists = !!fs.statSync(checkpointFile, { throwIfNoEntry: false })?.isFile();
      observe.checkpointRecords = readEventLogCheckpoint(checkpointFile)?.records ?? null;
      try { await port.close(); } catch (error) { observe.closeError = error.message; }
      port = null;
    }
    if (reopen) {
      const second = contextKind === 'cordis' ? cordisContext(backend, warnings) : plainContext(backend, loggerKind, warnings);
      const reopened = await impl.openDomainStorage(second.ctx, config);
      const flushed = (await Promise.allSettled([reopened.flush()])).map(settle);
      observe.reopen = { flush: flushed,
        applied: Object.keys(appliedMarkers(second.ctx) ?? {}).sort(),
        checkpointRecords: readEventLogCheckpoint(checkpointFile)?.records ?? null,
        closeError: null };
      try { await reopened.close(); } catch (error) { observe.reopen.closeError = error.message; }
      for (const dispose of second.disposers) { try { dispose(); } catch {} }
    }
    // One turn of the loop: an unhandled rejection is reported after the
    // microtask queue drains, not synchronously.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    if (port) await port.close().catch(() => {});
    for (const dispose of disposers) { try { dispose(); } catch {} }
    process.removeListener('unhandledRejection', onUnhandled);
    await backend.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
  return { ...observe, root, warnings, unhandled };
}

/** Everything the containment boundary must not move. */
function outcomes(observed) {
  return {
    openError: observed.openError,
    flush: observed.flush,
    applied: observed.applied,
    checkpointExists: observed.checkpointExists,
    checkpointRecords: observed.checkpointRecords,
    closeError: observed.closeError,
    reopen: observed.reopen,
    tools: observed.tools,
  };
}

/**
 * The diagnostic with its archive-specific parts normalised away: the temp root
 * path and the digest computed over it. What remains is the format, the phase
 * classification and the redaction the two implementations must share.
 */
function diagnosticText(observed) {
  const [line] = observed.warnings;
  assert.equal(typeof line, 'string', 'the diagnostic must still be one line');
  return line.split(observed.root).join('<root>')
    .replace(/\.json\.[0-9a-f]{16}\.tmp/g, '.json.<temp>.tmp')
    .replace(/sha256:[0-9a-f]{16}/, 'sha256:<digest>');
}

test('a working logger sees the same pass, and the same redacted line, as before the fix', async () => {
  const { pre, post } = await implementations();
  // Healthy path: nothing to warn about, nothing changed.
  const quietBefore = await scenario(pre, { after: [signed(eventFor('exp-quiet'), 1)] });
  const quietAfter = await scenario(post, { after: [signed(eventFor('exp-quiet'), 1)] });
  assert.deepEqual(outcomes(quietAfter), outcomes(quietBefore), 'a working logger sees no change at all');
  assert.deepEqual(quietAfter.flush, [{ status: 'fulfilled', value: { applied: 1, duplicates: 0 } }]);
  assert.equal(quietAfter.checkpointExists, true);
  assert.equal(quietAfter.checkpointRecords, 1);
  assert.deepEqual(quietAfter.warnings, []);
  assert.deepEqual(quietAfter.unhandled, []);

  // Failing checkpoint path with a logger that works: the message keeps its
  // format, its explicit phase and its redaction - the same one line, the same
  // DTO, only reached through the shared entry point.
  const fault = { checkpointFault: true, after: [signed(eventFor('exp-quiet-fault'), 1)] };
  const before = await scenario(pre, fault);
  const after = await scenario(post, fault);
  assert.deepEqual(outcomes(after), outcomes(before), 'the reported fault is handled identically');
  assert.deepEqual(after.flush, [{ status: 'fulfilled', value: { applied: 1, duplicates: 0 } }]);
  assert.equal(after.checkpointExists, false);
  assert.deepEqual(after.unhandled, []);
  assert.equal(after.warnings.length, 1);
  // The same line, down to the DTO: only the archive's own path and the digest
  // over it differ, because the two runs use two temp roots.
  assert.equal(diagnosticText(after), diagnosticText(before));
  assert.match(after.warnings[0], /^\[evolution\] event log checkpoint not written: .+ \(runtime-trial, sha256:[0-9a-f]{16}\)$/);
  assert.equal(after.warnings[0].includes(SECRET), false);
});

test('a logger fault cannot turn "checkpoint not written" into a failed flush', async () => {
  const { pre, post, synthesized } = await implementations();
  assert.equal(synthesized, true, 'the pre-fix module must be derived from the fixed source, not the source itself');
  // How the pre-fix `catch` behaves for each logger shape: a throw (synchronous,
  // or from the property read) escapes the pass and poisons `close()`; a thenable
  // return value is never observed at all, because the discarded return value is
  // only ever handed to `Promise.resolve` by the shared entry point. The fourth
  // shape - a rejected return value - is the same discard, but its leak is an
  // unhandled rejection, which the test runner attributes to the file rather than
  // to this test, so it is only measured on the fixed implementation below.
  const cases = [
    { kind: 'sync-throw', preFlush: 'rejected', preClose: /logger failed/, preUnhandled: 0, publishes: 1 },
    { kind: 'throwing-getter', preFlush: 'rejected', preClose: /logger failed/, preUnhandled: 0, publishes: 0 },
    { kind: 'thenable', preFlush: 'fulfilled', preClose: null, preUnhandled: 0, publishes: 1 },
  ];
  const applications = [];
  for (const { kind, preFlush, preClose, preUnhandled, publishes } of cases) {
    const options = { loggerKind: kind, checkpointFault: true, after: [signed(eventFor(`exp-${kind}`), 1)] };
    const before = await scenario(pre, options);
    const after = await scenario(post, options);

    // Pre-fix: the diagnostic is not contained by the pass it belongs to.
    assert.equal(before.flush.length, 1, kind);
    assert.equal(before.flush[0].status, preFlush, `${kind}: the pre-fix catch does not contain the logger`);
    if (preFlush === 'rejected') assert.match(before.flush[0].error, /logger failed/, kind);
    if (preClose === null) assert.equal(before.closeError, null, kind);
    else assert.match(before.closeError ?? '', preClose, `${kind}: a leaked failure is remembered as the port's`);
    assert.equal(before.unhandled.length, preUnhandled, kind);
    assert.equal(before.warnings.length, publishes, kind);

    // Post-fix: the pass reports what it did, the record stays committed, the
    // checkpoint stays unwritten, and the close is clean.
    assert.equal(after.openError, null, kind);
    assert.equal(after.closeError, null, kind);
    assert.deepEqual(after.flush, [{ status: 'fulfilled', value: { applied: 1, duplicates: 0 } }], kind);
    assert.deepEqual(after.unhandled, [], `${kind}: a logger failure must not escape`);
    assert.equal(after.checkpointExists, false, kind);
    assert.equal(after.warnings.length, publishes, `${kind}: the same diagnostics are still emitted`);
    // The commit itself is identical in both, so containment changed no state.
    assert.deepEqual(after.applied, [signed(eventFor(`exp-${kind}`), 1).event.eventId], kind);
    applications.push(after.applied);
  }
  assert.equal(new Set(applications.map((applied) => JSON.stringify(applied))).size, cases.length,
    'each case committed its own record');
});

test('a rejected logger promise is contained too, and leaves no unhandled rejection', async () => {
  const { post } = await implementations();
  const record = signed(eventFor('exp-rejecting'), 1);
  const observed = await scenario(post, { loggerKind: 'rejecting', checkpointFault: true, after: [record] });
  assert.equal(observed.openError, null);
  assert.deepEqual(observed.flush, [{ status: 'fulfilled', value: { applied: 1, duplicates: 0 } }]);
  assert.equal(observed.closeError, null);
  assert.deepEqual(observed.unhandled, [], 'the rejected promise is handed to Promise.resolve().catch()');
  assert.deepEqual(observed.applied, [record.event.eventId]);
  assert.equal(observed.checkpointExists, false);
  assert.equal(observed.warnings.length, 1, 'the refusal is still reported');
});

test('the REAL Cordis exporter chain cannot fail the flush either', async () => {
  const { pre, post } = await implementations();
  const options = { contextKind: 'cordis', checkpointFault: true, after: [signed(eventFor('exp-exporter'), 1)] };
  const before = await scenario(pre, options);
  const after = await scenario(post, options);

  assert.equal(before.flush[0].status, 'rejected');
  assert.match(before.flush[0].error, /exporter failed/);
  assert.match(before.closeError ?? '', /exporter failed/);

  assert.deepEqual(after.flush, [{ status: 'fulfilled', value: { applied: 1, duplicates: 0 } }]);
  assert.equal(after.closeError, null);
  assert.deepEqual(after.unhandled, []);
  assert.equal(after.checkpointExists, false);
  // The real logger saw the real, redacted line before its exporter unwound.
  assert.equal(after.warnings.length, 1);
  assert.match(after.warnings[0], /^\[evolution\] event log checkpoint not written: /);
  assert.equal(after.warnings[0].includes(SECRET), false);
});

test('startup replay contains the same logger fault and still applies every record once', async () => {
  const { pre, post } = await implementations();
  const records = [signed(eventFor('exp-startup-0'), 1), signed(eventFor('exp-startup-1'), 2)];
  const options = { loggerKind: 'sync-throw', checkpointFault: true, preload: records };
  const before = await scenario(pre, options);
  const after = await scenario(post, options);

  const workingLoggerBefore = await scenario(pre, { ...options, loggerKind: 'recording' });
  assert.deepEqual(outcomes(after), outcomes(workingLoggerBefore));

  // The checkpoint is written at the end of the pass `open()` runs, so the
  // pre-fix leak turned a successful start into a failed one.
  assert.match(before.openError ?? '', /logger failed/);
  assert.equal(after.openError, null, 'startup replay must not fail because the warning could not be written');
  assert.deepEqual(after.applied, records.map((envelope) => envelope.event.eventId));
  assert.equal(after.checkpointRecords, null, 'the pass could not write the checkpoint, and says so');
  assert.deepEqual(after.unhandled, []);
  assert.equal(after.closeError, null);
  // Diagnostics are still emitted for the real fault, redacted.
  // The records were committed by the startup pass, so the explicit flush that
  // follows applies nothing and recognises both records as duplicates.
  assert.deepEqual(after.flush, [{ status: 'fulfilled', value: { applied: 0, duplicates: 2 } }]);
  // Both passes refused the checkpoint write and each reports it once, redacted.
  assert.equal(after.warnings.length, 2);
  for (const warning of after.warnings) assert.equal(warning.includes(SECRET), false);
});

test('a repaired checkpoint path is retried, and a reopened port dedups instead of re-applying', async () => {
  const { pre, post } = await implementations();
  const records = [signed(eventFor('exp-retry'), 1)];
  const options = { checkpointFault: true, repair: true, reopen: true, after: records };
  const before = await scenario(pre, options);
  const observed = await scenario(post, { ...options, loggerKind: 'sync-throw' });
  assert.deepEqual(outcomes(observed), outcomes(before), 'retry/reopen match the pre-fix path with a working logger');

  // First pass: committed, checkpoint not written, warning contained.
  // Second pass after the repair: nothing to apply, the duplicate is recognised
  // from the committed marker map, and the checkpoint is finally written.
  assert.deepEqual(observed.flush, [
    { status: 'fulfilled', value: { applied: 1, duplicates: 0 } },
    { status: 'fulfilled', value: { applied: 0, duplicates: 1 } },
  ]);
  assert.equal(observed.checkpointExists, true);
  assert.equal(observed.checkpointRecords, 1);
  assert.equal(observed.closeError, null);
  // A fresh port on the same archive sees the same one record and applies
  // nothing: Losing the checkpoint never costs a duplicate application.
  assert.deepEqual(observed.reopen?.flush, [{ status: 'fulfilled', value: { applied: 0, duplicates: 1 } }]);
  assert.deepEqual(observed.reopen?.applied, records.map((envelope) => envelope.event.eventId));
  assert.equal(observed.reopen?.closeError, null);
  assert.deepEqual(observed.unhandled, []);
});

test('concurrent flushes behind a failing checkpoint write all resolve in order', async () => {
  const { pre, post } = await implementations();
  const records = [signed(eventFor('exp-concurrent'), 1)];
  const options = { loggerKind: 'sync-throw', checkpointFault: true, flushes: 2, after: records };
  const before = await scenario(pre, options);
  const after = await scenario(post, options);
  const workingLoggerBefore = await scenario(pre, { ...options, loggerKind: 'recording' });
  assert.deepEqual(outcomes(after), outcomes(workingLoggerBefore));

  assert.deepEqual(before.flush.map((entry) => entry.status), ['rejected', 'rejected']);
  // The queue still serialises the two passes; only the diagnostic is contained.
  assert.deepEqual(after.flush, [
    { status: 'fulfilled', value: { applied: 1, duplicates: 0 } },
    { status: 'fulfilled', value: { applied: 0, duplicates: 1 } },
  ]);
  assert.deepEqual(after.applied, [records[0].event.eventId]);
  assert.deepEqual(after.unhandled, []);
  assert.equal(after.warnings.length, 2, 'each pass reports its own refused checkpoint write');
});

test('authentication, conflict and commit failures still propagate through the same catch', async () => {
  const { pre, post } = await implementations();
  const genuine = signed(eventFor('exp-real'), 1);
  const forged = (() => {
    const envelope = signed(eventFor('exp-forged'), 2);
    return { ...envelope, event: { ...envelope.event, status: 'forged' } };
  })();
  // Two authentic records for one event id: the second MAC disagrees with the
  // marker the first committed, which is the conflict the replay path rejects.
  const conflict = signed(eventFor('exp-real'), 3);
  const poison = signed({ ...eventFor('exp-poison'), eventType: 'unknown-type' }, 4);
  const failures = [
    ['E_DOMAIN_EVENT_AUTH', [forged]],
    ['E_DOMAIN_EVENT_ID_CONFLICT', [genuine, conflict]],
    ['Unknown Evolution execution event type', [poison]],
  ];
  for (const [expected, records] of failures) {
    for (const [name, impl] of [['pre-fix', pre], ['post-fix', post]]) {
      const observed = await scenario(impl, { loggerKind: 'sync-throw', after: records });
      assert.equal(observed.flush.length, 1, `${name}: ${expected}`);
      assert.equal(observed.flush[0].status, 'rejected', `${name}: ${expected} must still fail the pass`);
      assert.match(observed.flush[0].error, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${name}: ${expected}`);
      assert.equal(observed.flush[0].error.includes('logger failed'), false,
        `${name}: the containment must not replace the real failure`);
      assert.equal(observed.openError, null);
      // The recorded failure is the pass's own, so `close()` reports it too.
      assert.match(observed.closeError ?? '', new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${name}: ${expected}`);
      assert.equal(observed.checkpointRecords, null, `${name}: a refused pass never blesses the bytes`);
    }
  }
});


test('every registered evolution tool returns its result through the real checkpoint-failing flush', async () => {
  const { pre, post } = await implementations();
  const record = signed(eventFor('exp-registered'), 1);
  const options = { registered: 'success', checkpointFault: true, after: [record] };
  const before = await scenario(pre, options);
  const brokenBefore = await scenario(pre, { ...options, loggerKind: 'sync-throw' });
  assert.ok(brokenBefore.tools.every(result => result.status === 'rejected' && /logger failed/.test(result.error)));
  for (const loggerKind of ['sync-throw', 'rejecting']) {
    const observed = await scenario(post, { ...options, loggerKind });
    assert.deepEqual(outcomes(observed), outcomes(before), loggerKind);
    assert.deepEqual(observed.tools.map(result => result.name), EVOLUTION_TOOLS);
    assert.ok(observed.tools.every(result => result.status === 'fulfilled'));
    assert.deepEqual(observed.flush, EVOLUTION_TOOLS.map((_, index) => ({
      status: 'fulfilled', value: { applied: index === 0 ? 1 : 0, duplicates: index === 0 ? 0 : 1 },
    })));
    assert.deepEqual(observed.applied, [record.event.eventId]);
    assert.equal(observed.closeError, null);
    assert.equal(observed.warnings.length, EVOLUTION_TOOLS.length);
    assert.deepEqual(observed.unhandled, []);
  }
});

test('registered tool errors stay primary while genuine flush failures still reject successful calls', async () => {
  const { pre, post } = await implementations();
  const forged = signed(eventFor('exp-tool-forged'), 1);
  forged.event.status = 'forged';
  for (const impl of [pre, post]) {
    const failed = await scenario(impl, { registered: 'success', after: [forged] });
    assert.ok(failed.tools.every(result => result.status === 'rejected' && /E_DOMAIN_EVENT_AUTH/.test(result.error)));
    assert.match(failed.closeError, /E_DOMAIN_EVENT_AUTH/);
    const primary = await scenario(impl, { registered: 'primary-error', after: [forged], loggerKind: 'sync-throw' });
    assert.equal(primary.tools[0].error, 'PRIMARY: trial body failed');
    assert.match(primary.flush[0].error, /E_DOMAIN_EVENT_AUTH/);
    assert.match(primary.closeError, /E_DOMAIN_EVENT_AUTH/);
    assert.deepEqual(primary.unhandled, []);
  }
  const checkpoint = await scenario(post, { registered: 'primary-error', checkpointFault: true,
    loggerKind: 'rejecting', after: [signed(eventFor('exp-tool-primary'), 1)] });
  assert.equal(checkpoint.tools[0].error, 'PRIMARY: trial body failed');
  assert.deepEqual(checkpoint.flush, [{ status: 'fulfilled', value: { applied: 1, duplicates: 0 } }]);
  assert.equal(checkpoint.closeError, null);
  assert.deepEqual(checkpoint.unhandled, []);
});

test('a real domain commit rejection remains fatal before and after diagnostic containment', async () => {
  const { pre, post } = await implementations();
  const options = { commitFault: true, checkpointFault: true, loggerKind: 'sync-throw',
    after: [signed(eventFor('exp-commit-refused'), 1)] };
  const before = await scenario(pre, options);
  const observed = await scenario(post, options);
  assert.deepEqual(outcomes(observed), outcomes(before));
  assert.equal(observed.flush[0].status, 'rejected');
  assert.equal(observed.flush[0].error, 'INJECTED_DOMAIN_COMMIT');
  assert.equal(observed.closeError, 'INJECTED_DOMAIN_COMMIT');
  assert.deepEqual(observed.applied, []);
  assert.equal(observed.checkpointRecords, null);
  assert.deepEqual(observed.warnings, [], 'a failed commit never reaches the checkpoint diagnostic');
});
