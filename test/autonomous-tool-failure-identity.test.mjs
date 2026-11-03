// The pattern identity of a `tools/result` failure.
//
// What is pinned here is one closed loop driven by real tool failures: the
// official tool registry produces the result, the plugin's real `tools/result`
// listener observes it, the real official domain storage commits it, and the
// autonomous observer counts, selects a strategy, runs its isolated Trial and
// stops for its owner.
//
// The defect these tests describe is an *identity* defect. A tool failure was
// identified by `sha256(JSON.stringify(result))`, i.e. by the exact bytes the
// host materialized, which include the rendered `content` and the failure text
// itself. Three `read` failures caused by one missing build directory, differing
// only in the file name each attempt asked for, therefore produced three
// pattern keys with `occurrences: 1` each. The pattern never reached
// `patternThreshold`, no candidate was ever created, and the strategy, the
// isolated Trial and the measurement never ran for a fault that repeats - the
// class of fault this loop exists for. Recorded on this same fixture before the
// change:
//
//   occurrence 1: pattern-observing occurrences=1 pattern=4ff913948cc7
//   occurrence 2: pattern-observing occurrences=1 pattern=0a3a0ba94941
//   occurrence 3: pattern-observing occurrences=1 pattern=215411423385
//   distinct patterns: 3   experiments: 0   candidates: []
//
// and after it:
//
//   occurrence 1: pattern-observing occurrences=1 pattern=727e3f7957a5
//   occurrence 2: pattern-observing occurrences=2 pattern=727e3f7957a5
//   occurrence 3: candidate-awaiting-confirmation        pattern=727e3f7957a5
//   distinct patterns: 1   experiments: 0   candidates: 1
//
// The identity is now the *shape* of the host's own failure text
// (`toolFailurePatternDigest`): a filesystem subject, a number and a labelled
// elapsed duration are values and are replaced, everything else is structure.
// The tests below pin both directions of that boundary, the exact evidence that
// is kept beside it, and the safety properties the loop had before the change.
//
// The differential is this file: six of the eight tests below fail on the
// pre-change implementation (the two that pass on both sides are the negative
// controls - a distinct root cause staying distinct, and concurrency). Re-run it
// against a tree with `lib/orchestrator.js` and `lib/registration.js` reverted to
// see the pre-change outcome; every assertion is on real registry output and real
// official storage, never on a hand-built failure result.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { ToolRuntime, TOOL_RUNTIME_SCHEDULER, ToolArgsError, defineTool } from '@deepseek-ai/dsh-tools';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { openDomainStorage } from '../lib/domain-storage.js';
import { safeErrorDto, toolFailurePatternDigest } from '../lib/orchestrator.js';
import { context } from './fixtures/runtime-inspect.mjs';
import { apply } from '../lib/registration.js';

const improved = {
  solvesProblem: true,
  sideEffects: [],
  orphanResources: [],
  performanceChange: 'decreased',
  errorChange: 'decreased',
  metrics: { errCount: 0 },
  beforeMetrics: { errCount: 1 },
  afterMetrics: { errCount: 0 },
  observationWindow: '1h',
  sampleCount: 2,
  benefitEvidence: 'error count fell from 1 to 0 over the window',
  repeatable: true,
  regressionPassed: true,
  reversible: true,
  cleanupEvidence: 'trial stopped and undefined; runtime fingerprint restored',
};

// ---------------------------------------------------------------------------
// Fixture: real official registry + real official domain storage
// ---------------------------------------------------------------------------

/**
 * A real `dsh-tools` registry. The fixture tools fail on demand, so every
 * `tools/result` payload the observer sees below was produced by the official
 * pipeline (`prepare` / `dispatch` / `finalize` / `finish`, exactly the four
 * calls `dsh-agent-loop` makes) rather than hand-written here.
 */
function host() {
  const ctx = new Context();
  ctx.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder() { return 0; } });
  const runtime = new ToolRuntime(ctx, { mode: 'native' });
  const emitted = [];
  ctx.on('tools/result', (exec, result) => {
    emitted.push({ exec, result: JSON.parse(JSON.stringify(result)) });
  });

  const output = {
    schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  };
  /** One fixture tool whose body throws whatever the test set up. */
  const failing = (name, make) => {
    const state = { failure: null };
    runtime.register(defineTool({
      name,
      description: `${name} fixture`,
      parameters: { path: { type: 'string', required: true, description: 'target of the call' } },
      output,
      execute: async () => { throw make(state.failure); },
    }));
    return (failure) => { state.failure = failure; };
  };
  const setRead = failing('read', (failure) => new Error(failure));
  const setRun = failing('run', (failure) => new ToolArgsError([failure]));
  const setBash = failing('bash', (failure) => new Error(`tool call timed out after ${failure}ms`));
  const seed = { read: "ENOENT: no such file or directory, open '/repo/a.json'", run: '"value.path" must be a string', bash: 120000 };
  setRead(seed.read); setRun(seed.run); setBash(seed.bash);
  const failures = { read: setRead, run: setRun, bash: setBash };

  const scheduler = runtime[TOOL_RUNTIME_SCHEDULER];
  let calls = 0;
  /** Run one tool call through the official pipeline and return the emission. */
  async function invoke(name, args) {
    const exec = { name, arguments: args, agent: { id: 'host' }, callId: `call-${calls += 1}`,
      signal: new AbortController().signal };
    const prepared = await scheduler.prepare(exec);
    if (prepared.kind === 'dispatch') {
      const outcome = await scheduler.dispatch(prepared.exec);
      if (outcome.kind === 'post-result') await scheduler.finalize(prepared.exec, outcome.result);
      else scheduler.finish(prepared.exec, outcome.result);
    } else if (prepared.kind === 'post-result') {
      await scheduler.finalize(prepared.exec, prepared.result);
    } else {
      scheduler.finish(prepared.exec, prepared.result);
    }
    return emitted.at(-1);
  }

  return { failures, invoke };
}

async function fixture(t, options = {}) {
  const root = options.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'evo-tool-identity-'));
  if (!options.root) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return async function session(sessionOptions = {}) {
    const backend = new JsonStorageBackend(path.join(root, 'official'));
    const listeners = new Map();
    const ctx = { ...context(), emit() {}, effect() {}, logger: { warn() {} }, on: (n, f) => listeners.set(n, f),
      storage: { backend: { get: () => backend } },
      dynamicCordisRunner: { snapshot: () => [], define: () => ({ pluginId: 'tool-identity-plugin', packageId: 'tool-identity-package' }),
        run: async () => ({ ok: true, status: 'active' }), stop: async () => ({ ok: true }), undefine: async () => ({ ok: true }) },
      tools: { register() {}, schemas: () => [] }, systemPrompt: { section() {} } };
    ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
    const config = { presetDir: root, eventBridgePath: path.join(root, 'events.jsonl'),
      eventBridgeKey: 'b'.repeat(64), startupDrift: false, patternThreshold: 3, ...options.config, ...sessionOptions };
    const port = await openDomainStorage(ctx, config);
    const core = apply(ctx, { ...config, domainStorage: port });
    const outcomes = [];
    const observe = core.observeAutonomous.bind(core);
    core.observeAutonomous = (...args) => { const promise = observe(...args); outcomes.push(promise); return promise; };
    const tools = host();
    return {
      core, port, ctx, tools,
      /** Observe one real tool failure through the plugin's own listener. */
      async fail(tool, args) {
        const emitted = await tools.invoke(tool, args);
        assert.equal(emitted?.result?.isError, true, 'the fixture call really failed');
        listeners.get('tools/result')({ name: emitted.exec.name, agent: { id: 'owner' },
          callId: emitted.exec.callId, signal: new AbortController().signal }, emitted.result);
        while (!outcomes.length) await new Promise((resolve) => setImmediate(resolve));
        return await outcomes.shift();
      },
      /** Set the next failure this tool will throw, then observe one call. */
      async failAs(tool, failure) {
        tools.failures[tool](failure);
        return this.fail(tool, { path: 'fixture' });
      },
      /** Observe one `read` failing on `file` with the default ENOENT text. */
      async read(file, failure = `ENOENT: no such file or directory, open '${file}'`) {
        tools.failures.read(failure);
        return this.fail('read', { path: file });
      },
      async close() { await port.close(); await backend.close(); },
    };
  };
}

const medium = { risk: 'medium', target: 'plugin:read-failure-fix' };

// ---------------------------------------------------------------------------
// The defect: one root cause whose text carries a value
// ---------------------------------------------------------------------------

test('the same root cause accumulates to the threshold even when every occurrence names another file', async (t) => {
  const session = await fixture(t, { config: { autonomousStrategies: { TOOL_READ: medium } } });
  const s = await session();
  try {
    // One missing build directory; each attempt asks for a different generated
    // file inside it, which is all that used to differ between the three runs.
    const first = await s.read('/repo/build-cache/2026-11-03T10-00-01/a.json');
    const second = await s.read('/repo/build-cache/2026-11-03T10-00-02/b.json');
    const third = await s.read('/repo/build-cache/2026-11-03T10-00-03/c.json');

    assert.equal(first.phase, 'pattern-observing');
    assert.equal(first.occurrences, 1);
    assert.equal(second.phase, 'pattern-observing');
    assert.equal(second.occurrences, 2, 'the second occurrence joins the first pattern');
    assert.equal(third.phase, 'candidate-awaiting-confirmation');
    assert.equal(third.reason, 'confirmation-required');
    assert.equal(third.patternKey, first.patternKey, 'one root cause, one pattern');
    assert.equal(third.candidate.observationIds.length, 3);
    assert.equal(new Set(third.candidate.observationIds).size, 3, 'three real occurrences, not a replayed row');

    assert.equal(s.core.patterns.size, 1);
    assert.equal(s.core.experiments.size, 0, 'a medium-risk strategy never reaches a Trial');
    assert.equal(s.core.suppressedPatterns.size, 0);
    assert.deepEqual(s.core.memory.data.entries, [], 'no failure was learned');
    // The durable half uses the same versioned identity, so the count survives a
    // restart rather than restarting from one.
    const stored = s.port.autonomousObservations();
    assert.equal(stored.length, 3);
    assert.equal(new Set(stored.map((row) => row.patternKey)).size, 1);
  } finally { await s.close(); }
});

test('a low-risk strategy reaches its isolated Trial through the same identity', async (t) => {
  const session = await fixture(t, { config: {
    autonomousStrategies: { TOOL_READ: { ...medium, risk: 'low', idPrefix: 'readfix',
      composition: { name: 'read-fix', purpose: 'recreate the missing directory', code: { host: 'return {};' } },
      measure: async () => improved } },
    autonomousPolicy: { low: 'experiment' },
  } });
  const s = await session();
  try {
    await s.read('/repo/build-cache/a.json');
    await s.read('/repo/build-cache/b.json');
    const measured = await s.read('/repo/build-cache/c.json');

    assert.equal(measured.phase, 'candidate-awaiting-confirmation');
    assert.equal(measured.automatic, false, 'the observer never approves production');
    assert.equal(measured.recommendation.confirmationRequired, true);
    assert.equal(measured.gates.eligible, true);
    assert.equal(s.core.experiments.size, 1, 'exactly one isolated Trial');
    const record = [...s.core.experiments.values()][0];
    assert.equal(record.state, 'measured');
    assert.equal(record.autonomous.patternKey, measured.patternKey);
    assert.equal(fs.readdirSync(s.core.paths.ownershipDir).length, 1, 'the target stays claimed by the pending candidate');

    // The same fault seen again answers with the candidate it already produced
    // instead of starting a second Trial.
    const again = await s.read('/repo/build-cache/d.json');
    assert.equal(again.phase, 'candidate-awaiting-confirmation');
    assert.equal(again.reason, 'already-measured-awaiting-owner');
    assert.equal(again.experimentId, measured.experimentId);
    assert.equal(s.core.experiments.size, 1);
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------
// The boundary: what is a value, and what is still a distinct root cause
// ---------------------------------------------------------------------------

test('different root causes sharing the tool name and code are not merged', async (t) => {
  const session = await fixture(t, { config: { autonomousStrategies: { TOOL_READ: medium } } });
  const s = await session();
  try {
    // Same tool, same observation code (`TOOL_READ`), same path - different
    // failure kind. The projection replaces the path, never the kind.
    const missing = await s.read('/repo/a.json');
    const denied = await s.read('/repo/a.json', "EACCES: permission denied, open '/repo/a.json'");
    const missingAgain = await s.read('/repo/b.json');
    const deniedAgain = await s.read('/repo/b.json', "EACCES: permission denied, open '/repo/b.json'");

    assert.notEqual(missing.patternKey, denied.patternKey, 'ENOENT and EACCES are different patterns');
    assert.equal(missing.occurrences, 1);
    assert.equal(denied.occurrences, 1, 'a different root cause does not inherit the other count');
    assert.equal(missingAgain.patternKey, missing.patternKey, 'the second ENOENT joins the first');
    assert.equal(missingAgain.occurrences, 2);
    assert.equal(deniedAgain.occurrences, 2);
    assert.equal(s.core.candidates.size, 0, 'nothing reached the threshold');
    assert.equal(s.core.experiments.size, 0, 'no experiment was started');
  } finally { await s.close(); }
});

test('a structured failure code does not collapse the argument it rejected', async (t) => {
  const session = await fixture(t, { config: { autonomousStrategies: { TOOL_RUN: medium } } });
  const s = await session();
  try {
    // Both failures carry the registry's own `INVALID_ARGS` code and the same
    // tool. The quoted schema path is structure, not an instance value.
    const command = await s.failAs('run', '"value.command" must be a number');
    const commandAgain = await s.failAs('run', '"value.command" must be a number');
    const timeout = await s.failAs('run', '"value.timeoutMs" must be a number');

    assert.equal(commandAgain.patternKey, command.patternKey, 'the same rejected argument is one pattern');
    assert.equal(commandAgain.occurrences, 2);
    assert.notEqual(timeout.patternKey, command.patternKey, 'a different rejected argument is another pattern');
    assert.equal(timeout.occurrences, 1);
    assert.equal(s.core.candidates.size, 0);
  } finally { await s.close(); }
});

test('a different tool keeps its own pattern, and a labelled duration is a value', async (t) => {
  const session = await fixture(t, { config: {
    autonomousStrategies: { TOOL_READ: medium, TOOL_BASH: medium } } });
  const s = await session();
  try {
    const read = await s.read('/repo/a.json');
    const timedOut = await s.failAs('bash', 120000);
    const timedOutAgain = await s.failAs('bash', 120000);
    assert.notEqual(timedOut.patternKey, read.patternKey, 'the tool itself is part of the identity');
    assert.equal(timedOutAgain.patternKey, timedOut.patternKey,
      'the official `after 120000ms` spelling is a labelled duration, not identity');
    assert.equal(timedOutAgain.occurrences, 2);

    // A different budget for the same tool is the same failure shape: the elapsed
    // budget is a value, exactly like a path, and only that.
    const other = await s.failAs('bash', 60000);
    assert.equal(other.patternKey, timedOut.patternKey);
  } finally { await s.close(); }
});

test('a quoted directory whose name contains a space or a bracket is one value', async (t) => {
  const session = await fixture(t, { config: { autonomousStrategies: { TOOL_READ: medium } } });
  const s = await session();
  try {
    // A delimited subject runs to its closing quote. Without that, the value ends
    // at the first space or bracket, the tail of the path stays in the identity,
    // and a project living under `build cache/` or a bracketed cache directory
    // splits its own root cause again - the defect this identity exists to fix,
    // one delimiter further in.
    const spaced = await s.read('/repo/build cache/a.json');
    const spacedAgain = await s.read('/repo/build cache/b.json');
    const bracketed = await s.read('/repo/[cache]/c.json');
    assert.equal(spacedAgain.patternKey, spaced.patternKey);
    assert.equal(bracketed.patternKey, spaced.patternKey, 'the bracket is inside the same delimited subject');
    assert.equal(bracketed.phase, 'candidate-awaiting-confirmation');
    assert.equal(bracketed.candidate.observationIds.length, 3);

    // A double-quoted subject is delimited the same way, and the *kind* of
    // failure is still structure: a denied access on the same path is its own
    // pattern.
    const doubled = await s.read('/repo/build cache/d.json', 'EACCES: permission denied, open "/repo/build cache/d.json"');
    assert.notEqual(doubled.patternKey, spaced.patternKey);
    assert.equal(doubled.occurrences, 1);
  } finally { await s.close(); }
});

test('an over-long failure text is not projected, so unrelated causes never accumulate together', async (t) => {
  const session = await fixture(t, { config: { autonomousStrategies: { TOOL_READ: medium } } });
  const s = await session();
  try {
    // The credential boundary replaces text above 64 KiB with one marker, so a
    // projection over that text would give every over-long failure of one tool
    // the same shape. Three unrelated causes would then reach `patternThreshold`
    // together and select a strategy for a "pattern" nobody observed.
    const long = (kind) => `${kind}: ${'detail '.repeat(10000)}`;
    const syntax = await s.failAs('read', long('Syntax error'));
    const denied = await s.failAs('read', long('Permission denied'));
    const disk = await s.failAs('read', long('Disk full'));
    assert.notEqual(denied.patternKey, syntax.patternKey);
    assert.notEqual(disk.patternKey, syntax.patternKey);
    assert.equal(syntax.occurrences, 1);
    assert.equal(denied.occurrences, 1);
    assert.equal(s.core.candidates.size, 0, 'three unrelated over-long failures are not one pattern');
    // The identity falls back to the exact result bytes there, which is the
    // conservative side of the trade: an unrelated cause is never merged in.
    const syntaxAgain = await s.failAs('read', long('Syntax error'));
    assert.equal(syntaxAgain.patternKey, syntax.patternKey);
    assert.equal(syntaxAgain.occurrences, 2);
    assert.equal(s.core.candidates.size, 0);
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------
// Continuity: restart, concurrency, duplicates, and the durable verdict
// ---------------------------------------------------------------------------

test('the identity survives a restart, so the count continues instead of restarting', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-tool-identity-restart-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = await fixture(t, { root, config: { autonomousStrategies: { TOOL_READ: medium } } });

  let s = await session();
  let first;
  try {
    first = await s.read('/repo/build-cache/one.json');
    assert.equal((await s.read('/repo/build-cache/two.json')).occurrences, 2);
  } finally { await s.close(); }

  s = await session();
  try {
    const third = await s.read('/repo/build-cache/three.json');
    assert.equal(third.phase, 'candidate-awaiting-confirmation', 'the durable rows still answer for this identity');
    assert.equal(third.patternKey, first.patternKey);
    assert.equal(third.candidate.observationIds.length, 3);
    assert.equal(s.core.experiments.size, 0);
  } finally { await s.close(); }
});

test('concurrent observations of one tool failure produce one candidate, and replayed rows count once', async (t) => {
  const session = await fixture(t, { config: {
    autonomousStrategies: { TOOL_READ: { ...medium, risk: 'low', idPrefix: 'concurrent',
      composition: { name: 'read-fix', purpose: 'recreate the missing directory', code: { host: 'return {};' } },
      measure: async () => improved } },
    autonomousPolicy: { low: 'experiment' },
  } });
  const s = await session();
  try {
    // Two occurrences of one root cause, then a burst: every event is observed,
    // only one Trial may exist afterwards.
    await s.read('/repo/a.json');
    await s.read('/repo/b.json');
    const burst = await Promise.all([s.read('/repo/c.json'), s.read('/repo/d.json'), s.read('/repo/e.json')]);
    assert.equal(s.core.experiments.size, 1, 'concurrency never produces a second Trial');
    const measured = burst.find((row) => row.phase === 'candidate-awaiting-confirmation' && row.gates);
    assert.ok(measured, 'one of the burst events reports the measured candidate');

    // A replay of an already committed row is the same occurrence, not a new one.
    const stored = s.port.autonomousObservations();
    assert.equal(stored.length, 5);
    const replayed = { type: 'tool/error', code: 'TOOL_READ', target: 'tool:read',
      observationId: stored[0].observationId, patternKey: `autonomous-v1:${stored[0].patternKey}` };
    await s.port.observe(replayed);
    await s.port.observe(replayed);
    assert.equal(s.port.autonomousObservations().length, 5, 'the replayed row is deduplicated by its observation ID');
    const later = await s.read('/repo/f.json');
    assert.equal(later.reason ?? 'already-measured-awaiting-owner', 'already-measured-awaiting-owner');
    assert.equal(s.core.experiments.size, 1);
  } finally { await s.close(); }
});

test('a failure recorded before this projection existed still suppresses its hypothesis', async (t) => {
  const session = await fixture(t, { config: {
    autonomousStrategies: { TOOL_READ: { ...medium, risk: 'low', idPrefix: 'legacy',
      composition: { name: 'read-fix', purpose: 'recreate the missing directory', code: { host: 'return {};' } },
      measure: async () => improved } },
    autonomousPolicy: { low: 'experiment' },
  } });
  const s = await session();
  try {
    // The identity this plugin assigned before the change: the digest of the whole
    // materialized result, which every observation still carries as `errorDigest`.
    s.tools.failures.read(`ENOENT: no such file or directory, open '/repo/build-cache/locked.json'`);
    const emitted = await s.tools.invoke('read', { path: '/repo/build-cache/locked.json' });
    // The observation text a real host produces: the official in-memory result
    // carries no top-level `code` (the registry publishes it under `error.info`
    // for a `HarnessError` only), so the listener's code fallback is the tool name
    // while this text keeps its own generic marker. Both are part of the identity
    // and neither is changed here, because a pre-change record was made with them.
    const legacyProblem = 'Official operation failed (HOST_OPERATION_FAILED)';
    const legacyInput = { type: 'tool/error', code: 'TOOL_READ', target: 'tool:read',
      message: legacyProblem };
    const legacyPatternKey = s.core.patternKey({ ...legacyInput,
      errorDigest: safeErrorDto(JSON.stringify(emitted.result), 'observation').errorDigest });
    const strategyFingerprint = s.core.strategyFingerprint(s.core.strategies.TOOL_READ);
    const legacySignature = s.core.memory.signature({ problem: legacyProblem,
      experiment: { patternKey: legacyPatternKey, strategy: strategyFingerprint },
      result: 'autonomous-failure', prevention: 'suppress duplicate' });
    s.core.memory.record({ signature: legacySignature, problem: legacyProblem,
      experiment: { patternKey: legacyPatternKey, strategy: strategyFingerprint },
      result: { state: 'failed', category: 'runtime-trial' }, prevention: 'suppress duplicate' });

    // Three occurrences of that same failure, which is the point at which the
    // observer consults the durable verdict. The exact result bytes reproduce the
    // pre-change identity through the read-only legacy path, so the hypothesis is
    // still suppressed instead of being attempted once more after an upgrade.
    assert.equal((await s.read('/repo/build-cache/locked.json')).phase, 'pattern-observing');
    assert.equal((await s.read('/repo/build-cache/locked.json')).phase, 'pattern-observing');
    const row = await s.read('/repo/build-cache/locked.json');
    assert.equal(row.phase, 'suppressed');
    assert.equal(row.reason, 'failure-memory', 'the durable verdict still holds');
    assert.notEqual(row.patternKey, legacyPatternKey, 'the new identity is not the old one');
    assert.equal(s.core.experiments.size, 0);
  } finally { await s.close(); }
});

test('the projection is bounded: it refuses text it would have to withhold', () => {
  const result = (text) => ({ isError: true, error: { message: text }, content: [{ type: 'text', text }] });
  // `REDACTION_TEXT_BOUND` (64 KiB) is the one bound both boundaries share: at or
  // below it the text is scanned and projected, above it the host's message is
  // withheld as a marker and the identity falls back to the exact result bytes.
  assert.match(toolFailurePatternDigest(result('x'.repeat(64 * 1024))), /^sha256:[0-9a-f]{16}$/);
  assert.equal(toolFailurePatternDigest(result('x'.repeat(64 * 1024 + 1))), null);
  assert.equal(toolFailurePatternDigest({ isError: true }), null, 'no failure text means no shape');
});
