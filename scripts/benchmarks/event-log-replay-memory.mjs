#!/usr/bin/env node
/**
 * First-absorption replay memory benchmark.
 *
 * Measures what a cold `openDomainStorage()` (no replay checkpoint) costs in
 * memory as well as time, through the real `openDomainStorage()`, the official
 * `DomainFacility` and `JsonStorageBackend`, in a fresh child process per
 * sample. Three things are measured and kept apart on purpose:
 *
 *   - `maxRSS` from `process.resourceUsage()`: the whole child's high-water
 *     mark. A gauge, not a retained figure.
 *   - `heapUsed` sampled by a temporary instrumented copy of
 *     `lib/domain-storage.js` at the points the replay passes through (after
 *     the plan is built, every 1024 absorbed lines, after the commit). These are
 *     uncollected heap gauges: they show where the peak happens, not what stays
 *     alive.
 *   - `--plan-only`: the plan is built in a child that never opens the domain,
 *     then `global.gc()` runs twice and `heapUsed`/`arrayBuffers` are compared
 *     with the same measurement taken before the plan. That delta is what the
 *     plan actually retains.
 *
 * `--profile` additionally runs the largest-scale worker with `--heap-prof` and
 * aggregates the sampling profile's self size by call frame, so "main
 * allocation sources" is a measurement rather than a guess.
 *
 * Runner modes:
 *   node scripts/benchmarks/event-log-replay-memory.mjs --records 2000,12000,20000 \
 *     --rounds 3 --baseline-root /tmp/dsh-base-replay-memory --out <json> --ledger <jsonl>
 *
 * Fixtures are signed once with `signEventBridgeEnvelope()` and copied per
 * sample; both sides assert the same fixture SHA-256. The baseline tree runs its
 * own copy of this script (identical bytes, asserted), so each side measures its
 * own production code.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SCRIPT), '../..');
const HOOK = Symbol.for('dsh-evolution.event-log-replay-memory');
const KEY = 'c'.repeat(64);

function argsOf(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    const key = value.slice(2);
    result[key] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
  }
  return result;
}

function parseCounts(value) {
  const counts = String(value ?? '2000,12000,20000').split(',').map((part) => Number(part.trim()));
  assert.ok(counts.length > 0 && counts.every((count) => Number.isSafeInteger(count) && count > 0),
    '--records must be a comma-separated list of positive integers');
  return counts;
}

function eventFor(sequence) {
  const experimentId = `replay-memory-${sequence}`;
  return {
    schema: 1,
    eventId: `evolution:measurement-completed:${experimentId}`,
    eventType: 'measurement-completed',
    experimentId,
    proposalId: `proposal-${experimentId}`,
    target: 'plugin:replay-memory-bench',
    capability: 'plugin:replay-memory-bench',
    lineageId: 'plugin:replay-memory-bench',
    status: 'measured',
    measurement: { latency: 10 + sequence % 101, throughput: 20 + sequence % 53 },
    evidence: { testPassed: true },
    audit: { producer: 'dsh-evolution-orchestrator', at: '2026-10-27T00:00:00.000Z' },
  };
}

async function makeFixture(file, records) {
  const { signEventBridgeEnvelope } = await import(pathToFileURL(path.join(REPO, 'lib/orchestrator.js')));
  const descriptor = fs.openSync(file, 'w', 0o600);
  try {
    for (let sequence = 1; sequence <= records; sequence += 1) {
      const envelope = signEventBridgeEnvelope(eventFor(sequence), { key: KEY, sequence });
      fs.writeSync(descriptor, `${JSON.stringify(envelope)}\n`);
    }
  } finally { fs.closeSync(descriptor); }
}

const SAMPLE_SIGNATURE = 'globalThis[Symbol.for("dsh-evolution.event-log-replay-memory")].sample';
const PLAN_NEEDLE = '    if (!plan) return { applied: 0, duplicates: 0 };\n';
const PLAN_PROBE = `    if (!plan) return { applied: 0, duplicates: 0 };
    ${SAMPLE_SIGNATURE}('plan', { trusted: plan.trusted, bytes: plan.bytes, compact: typeof plan.lines === 'object' && typeof plan.lines.length === 'number' ? plan.lines.length : null });
`;
// The absorption entry point, not the loop header: both trees this harness runs
// against must have the same bytes here, and the loop header's neighbourhood is
// exactly what a candidate in this area changes.
const ABSORB_NEEDLE = '    const absorb = (line, { witnessed }) => {\n      const envelope = JSON.parse(line);\n';
const ABSORB_PROBE = `    let absorbedLine = 0;
    const absorb = (line, { witnessed }) => {
      absorbedLine += 1;
      if (absorbedLine % 1024 === 0) ${SAMPLE_SIGNATURE}('absorb', { line: absorbedLine });
      const envelope = JSON.parse(line);
`;
const PRECOMMIT_NEEDLE = '    await commit();\n    if (refusal) throw refusal;\n';
const PRECOMMIT_PROBE = `    ${SAMPLE_SIGNATURE}('pre-commit', { applied, duplicates });
    await commit();
    ${SAMPLE_SIGNATURE}('committed', { applied, duplicates });
    if (refusal) throw refusal;
`;

/** A temporary copy of `lib/domain-storage.js` with memory samples inserted at
 *  the replay's three points. The production source is never modified. */
async function instrumentedDomainStorage() {
  const modulePath = path.join(REPO, 'lib/domain-storage.js');
  const source = fs.readFileSync(modulePath, 'utf8');
  for (const needle of [PLAN_NEEDLE, ABSORB_NEEDLE, PRECOMMIT_NEEDLE]) {
    assert.equal(source.split(needle).length - 1, 1, `benchmark instrumentation expects one match for ${JSON.stringify(needle.slice(0, 40))}`);
  }
  const instrumented = source
    .replace(PLAN_NEEDLE, PLAN_PROBE)
    .replace(ABSORB_NEEDLE, ABSORB_PROBE)
    .replace(PRECOMMIT_NEEDLE, PRECOMMIT_PROBE);
  const instrumentedPath = path.join(path.dirname(modulePath), `.domain-storage-replay-memory-${process.pid}-${crypto.randomUUID()}.mjs`);
  fs.writeFileSync(instrumentedPath, instrumented, { mode: 0o600, flag: 'wx' });
  try { return await import(pathToFileURL(instrumentedPath)); }
  finally { fs.rmSync(instrumentedPath, { force: true }); }
}

function usage() {
  const memory = process.memoryUsage();
  return { rss: memory.rss, heapTotal: memory.heapTotal, heapUsed: memory.heapUsed,
    external: memory.external, arrayBuffers: memory.arrayBuffers, maxRSS: process.resourceUsage().maxRSS };
}

function collectedUsage() {
  assert.equal(typeof global.gc, 'function', 'this mode needs --expose-gc');
  global.gc(); global.gc();
  return usage();
}

/** Scope V8's sampling heap profiler to one region of the worker. */
async function startSampling(interval) {
  const inspector = await import('node:inspector');
  const session = new inspector.Session();
  session.connect();
  await new Promise((resolve, reject) => session.post('HeapProfiler.enable', (error) => (error ? reject(error) : resolve())));
  await new Promise((resolve, reject) => session.post('HeapProfiler.startSampling', { samplingInterval: interval },
    (error) => (error ? reject(error) : resolve())));
  return () => new Promise((resolve, reject) => session.post('HeapProfiler.stopSampling', (error, result) => {
    session.disconnect();
    if (error) reject(error); else resolve(result.profile);
  }));
}

/** Aggregate a V8 sampling heap profile's self sizes by call frame. */
function summarizeProfile(profile) {
  const totals = new Map();
  const walk = (node) => {
    const frame = node.callFrame ?? {};
    const name = frame.functionName || '(anonymous)';
    const url = frame.url ? path.basename(frame.url) : '(native)';
    const key = `${name} ${url}:${frame.lineNumber + 1}`;
    if (node.selfSize > 0) totals.set(key, (totals.get(key) ?? 0) + node.selfSize);
    for (const child of node.children ?? []) walk(child);
  };
  walk(profile.head);
  const total = [...totals.values()].reduce((sum, value) => sum + value, 0);
  return { totalSelfSize: total,
    sources: [...totals.entries()].sort((left, right) => right[1] - left[1]).slice(0, 30)
      .map(([site, selfSize]) => ({ site, selfSize, share: total ? selfSize / total : 0 })) };
}

/** Build the plan for a cold log and measure what it retains, with the domain
 *  never opened. Nothing else runs between the two collected measurements. */
async function planWorker(fixtureFile, records, { sampling = false } = {}) {
  const { planEventLogReplay } = await import(pathToFileURL(path.join(REPO, 'lib/event-log-checkpoint.js')));
  const before = collectedUsage();
  const stop = sampling ? await startSampling(32768) : null;
  const wallStart = performance.now();
  const plan = planEventLogReplay({ file: fixtureFile, key: KEY, writer: 'dsh-evolution-orchestrator',
    checkpoint: null, applied: {}, retention: null });
  const wallMs = performance.now() - wallStart;
  const profile = stop ? summarizeProfile(await stop()) : null;
  assert.ok(plan, 'the fixture log must exist');
  assert.equal(plan.trusted, false, 'a cold log has no trusted prefix');
  assert.equal(plan.completeRecords, records, 'every fixture record must be counted');
  assert.equal(plan.bytes, fs.statSync(fixtureFile).size, 'a cold plan covers the whole log');
  const after = collectedUsage();
  return {
    records,
    wallMs,
    planBytes: plan.bytes,
    planCompleteRecords: plan.completeRecords,
    planRemainderLength: plan.remainder.length,
    planLineContainer: Array.isArray(plan.lines) ? 'array' : typeof plan.lines,
    before,
    after,
    retained: { heapUsed: after.heapUsed - before.heapUsed, arrayBuffers: after.arrayBuffers - before.arrayBuffers,
      external: after.external - before.external, rss: after.rss - before.rss },
    maxRSS: process.resourceUsage().maxRSS,
    fixtureBytes: fs.statSync(fixtureFile).size,
    profile,
  };
}

async function worker(fixtureFile, records, { sampling = false } = {}) {
  const counters = { samples: [],
    sample(stage, detail = null) { counters.samples.push({ stage, detail, ...usage() }); } };
  globalThis[HOOK] = counters;
  const { openDomainStorage } = await instrumentedDomainStorage();
  const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
  const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-event-log-replay-memory-'));
  const eventBridgePath = path.join(root, 'execution-events.jsonl');
  fs.copyFileSync(fixtureFile, eventBridgePath);
  const checkpointPath = path.join(root, 'event-log.checkpoint.json');
  assert.equal(fs.existsSync(checkpointPath), false, 'the measured first startup must not have a replay checkpoint');
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = { emit() {}, on() { return () => {}; }, logger: { warn() {}, error() {} },
    storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const entry = collectedUsage();
  let port;
  try {
    const stop = sampling ? await startSampling(32768) : null;
    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();
    port = await openDomainStorage(ctx, { presetDir: root, eventBridgePath, eventBridgeKey: KEY });
    const wallMs = performance.now() - wallStart;
    const cpu = process.cpuUsage(cpuStart);
    const openMaxRSS = process.resourceUsage().maxRSS;
    // The pass's own samples end here. Everything below (reading the durable
    // document back, the forced collections, the steady-state `flush()`) is
    // verification and a second pass; letting it into the same set would report
    // the harness's own overhead as replay memory.
    const passSamples = counters.samples.splice(0, counters.samples.length);
    const profile = stop ? summarizeProfile(await stop()) : null;
    counters.endToEnd = { wallMs, cpuMs: (cpu.user + cpu.system) / 1000, maxRSS: openMaxRSS };
    const durablePath = path.join(root, 'official', 'evolution_domain.json');
    const durable = JSON.parse(fs.readFileSync(durablePath, 'utf8')).global;
    assert.equal(Object.keys(durable.applied).length, records, 'every signed event must be absorbed on open');
    assert.equal(durable.pending, null);
    assert.equal(fs.existsSync(checkpointPath), true, 'the first pass must publish a checkpoint');
    const afterOpen = collectedUsage();
    const flushStart = performance.now();
    const flushed = await port.flush();
    const flushMs = performance.now() - flushStart;
    assert.deepEqual(flushed, { applied: 0, duplicates: records }, 'the checkpoint must make the next pass all duplicates');
    const afterFlush = collectedUsage();
    const stages = passSamples.map((sample) => ({ ...sample }));
    const peakDuringReplay = stages.reduce((best, sample) => (sample.maxRSS > best.maxRSS ? sample : best), stages[0] ?? null);
    const sampleAt = (stage) => stages.filter((sample) => sample.stage === stage);
    const peakHeapUsedDuringReplay = stages.reduce((best, sample) => Math.max(best, sample.heapUsed), 0);
    const result = {
      records,
      wallMs,
      cpuMs: counters.endToEnd.cpuMs,
      maxRSS: openMaxRSS,
      maxRSSAfterFlush: null,
      fixtureBytes: fs.statSync(fixtureFile).size,
      fixtureSha256: crypto.createHash('sha256').update(fs.readFileSync(fixtureFile)).digest('hex'),
      checkpointPresentBeforeOpen: false,
      flushMs,
      flushResult: flushed,
      memory: { entry, afterOpen, afterFlush, afterClose: null },
      profile,
      replay: {
        planSamples: sampleAt('plan'),
        absorbSamples: sampleAt('absorb'),
        preCommitSamples: sampleAt('pre-commit'),
        committedSamples: sampleAt('committed'),
        peakMaxRSS: peakDuringReplay ? peakDuringReplay.maxRSS : null,
        peakMaxRSSAtStage: peakDuringReplay ? peakDuringReplay.stage : null,
        peakHeapUsedDuringReplay,
        sampleCount: stages.length,
      },
    };
    result.maxRSSAfterFlush = process.resourceUsage().maxRSS;
    await port.close();
    port = null;
    result.memory.afterClose = collectedUsage();
    result.maxRSSAfterClose = process.resourceUsage().maxRSS;
    return result;
  } finally {
    if (port) await port.close().catch(() => {});
    await backend.close();
    fs.rmSync(root, { recursive: true, force: true });
    delete globalThis[HOOK];
  }
}

function treeRevision(root) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function worktreeChanges(root) {
  const result = spawnSync('git', ['status', '--porcelain', '--', 'lib', 'test', 'scripts'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) return null;
  return [...new Set(result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    .map((line) => line.replace(/^[^ ]+ +/u, '')))].sort();
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

const SAMPLE_FIELDS = ['wallMs', 'cpuMs', 'maxRSS', 'fixtureBytes', 'flushMs'];

function summarize(rows, records) {
  const selected = rows.filter((row) => row.records === records && row.phase === 'ab');
  const variants = Object.fromEntries(['baseline', 'candidate'].map((variant) => {
    const samples = selected.filter((row) => row.variant === variant).map((row) => row.sample);
    const summary = Object.fromEntries(SAMPLE_FIELDS.map((key) => [key, median(samples.map((sample) => sample[key]))]));
    summary.replayPeakHeapUsed = median(samples.map((sample) => sample.replay.peakHeapUsedDuringReplay));
    summary.planHeapUsed = median(samples.map((sample) => (sample.replay.planSamples[0]?.heapUsed ?? 0)));
    summary.planMaxRSS = median(samples.map((sample) => (sample.replay.planSamples[0]?.maxRSS ?? 0)));
    summary.preCommitMaxRSS = median(samples.map((sample) => (sample.replay.preCommitSamples[0]?.maxRSS ?? 0)));
    summary.preCommitHeapUsed = median(samples.map((sample) => (sample.replay.preCommitSamples[0]?.heapUsed ?? 0)));
    summary.preCommitArrayBuffers = median(samples.map((sample) => (sample.replay.preCommitSamples[0]?.arrayBuffers ?? 0)));
    summary.committedMaxRSS = median(samples.map((sample) => (sample.replay.committedSamples[0]?.maxRSS ?? 0)));
    summary.maxRSSAfterFlush = median(samples.map((sample) => sample.maxRSSAfterFlush ?? 0));
    summary.afterOpenHeapUsed = median(samples.map((sample) => sample.memory.afterOpen.heapUsed));
    summary.afterOpenArrayBuffers = median(samples.map((sample) => sample.memory.afterOpen.arrayBuffers));
    summary.afterCloseHeapUsed = median(samples.map((sample) => sample.memory.afterClose.heapUsed));
    summary.afterCloseArrayBuffers = median(samples.map((sample) => sample.memory.afterClose.arrayBuffers));
    return [variant, summary];
  }));
  const paired = [];
  for (const round of [...new Set(selected.map((row) => row.round))]) {
    const baseline = selected.find((row) => row.round === round && row.variant === 'baseline')?.sample;
    const candidate = selected.find((row) => row.round === round && row.variant === 'candidate')?.sample;
    if (!baseline || !candidate) continue;
    paired.push({ round,
      wallDeltaMs: candidate.wallMs - baseline.wallMs,
      cpuDeltaMs: candidate.cpuMs - baseline.cpuMs,
      maxRssDelta: candidate.maxRSS - baseline.maxRSS,
      replayPeakHeapUsedDelta: candidate.replay.peakHeapUsedDuringReplay - baseline.replay.peakHeapUsedDuringReplay,
      planMaxRssDelta: (candidate.replay.planSamples[0]?.maxRSS ?? 0) - (baseline.replay.planSamples[0]?.maxRSS ?? 0),
      preCommitMaxRssDelta: (candidate.replay.preCommitSamples[0]?.maxRSS ?? 0) - (baseline.replay.preCommitSamples[0]?.maxRSS ?? 0),
      committedMaxRssDelta: (candidate.replay.committedSamples[0]?.maxRSS ?? 0) - (baseline.replay.committedSamples[0]?.maxRSS ?? 0) });
  }
  return { records, variants, paired };
}

function noise(rows, records) {
  const selected = rows.filter((row) => row.phase === 'aa' && row.records === records);
  const pairs = [];
  for (const round of [...new Set(selected.map((row) => row.round))]) {
    const first = selected.find((row) => row.round === round && row.variant === 'same-a')?.sample;
    const second = selected.find((row) => row.round === round && row.variant === 'same-b')?.sample;
    if (!first || !second) continue;
    pairs.push({ round,
      wallAbsDeltaMs: Math.abs(first.wallMs - second.wallMs),
      cpuAbsDeltaMs: Math.abs(first.cpuMs - second.cpuMs),
      maxRssAbsDelta: Math.abs(first.maxRSS - second.maxRSS),
      planMaxRssAbsDelta: Math.abs((first.replay.planSamples[0]?.maxRSS ?? 0) - (second.replay.planSamples[0]?.maxRSS ?? 0)),
      preCommitMaxRssAbsDelta: Math.abs((first.replay.preCommitSamples[0]?.maxRSS ?? 0) - (second.replay.preCommitSamples[0]?.maxRSS ?? 0)),
      replayPeakHeapUsedAbsDelta: Math.abs(first.replay.peakHeapUsedDuringReplay - second.replay.peakHeapUsedDuringReplay) });
  }
  const maxOf = (key) => (pairs.length ? Math.max(...pairs.map((pair) => pair[key])) : null);
  return { records, pairs, maxWallAbsDeltaMs: maxOf('wallAbsDeltaMs'), maxCpuAbsDeltaMs: maxOf('cpuAbsDeltaMs'),
    maxRssAbsDelta: maxOf('maxRssAbsDelta'), maxPlanMaxRssAbsDelta: maxOf('planMaxRssAbsDelta'),
    maxPreCommitMaxRssAbsDelta: maxOf('preCommitMaxRssAbsDelta'),
    maxReplayPeakHeapUsedAbsDelta: maxOf('replayPeakHeapUsedAbsDelta') };
}

function runChild({ script, cwd, argv, extraNodeArgs = [] }) {
  const result = spawnSync(process.execPath, [...extraNodeArgs, script, ...argv], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`worker failed (${cwd}): ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

async function runner(options) {
  const counts = parseCounts(options.records);
  const rounds = Number(options.rounds ?? 3);
  assert.ok(Number.isSafeInteger(rounds) && rounds >= 3, '--rounds must be at least 3');
  const baselineRoot = path.resolve(String(options['baseline-root'] ?? '/tmp/dsh-base-replay-memory'));
  const baselineScript = path.join(baselineRoot, 'scripts/benchmarks/event-log-replay-memory.mjs');
  assert.ok(fs.existsSync(baselineScript), `baseline harness missing at ${baselineScript}`);
  const scriptSha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(scriptSha(baselineScript), scriptSha(SCRIPT), 'both sides must run identical harness bytes');
  const output = path.resolve(String(options.out ?? path.join(REPO, 'docs/performance/event-log-replay-memory.json')));
  const ledgerPath = path.resolve(String(options.ledger ?? output.replace(/\.json$/u, '.jsonl')));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(ledgerPath, '');
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-replay-memory-fixtures-'));
  const rows = [];
  const planRows = [];
  try {
    for (const records of counts) {
      const fixture = path.join(fixtureDir, `records-${records}.jsonl`);
      await makeFixture(fixture, records);
      const digest = crypto.createHash('sha256').update(fs.readFileSync(fixture)).digest('hex');
      for (const variant of ['baseline', 'candidate']) {
        const cwd = variant === 'baseline' ? baselineRoot : REPO;
        const sample = runChild({ script: path.join(cwd, 'scripts/benchmarks/event-log-replay-memory.mjs'),
          cwd, argv: ['--plan-worker', fixture, String(records)], extraNodeArgs: ['--expose-gc'] });
        assert.equal(sample.fixtureBytes, fs.statSync(fixture).size);
        planRows.push({ variant, records, sample });
      }
      for (let round = 1; round <= rounds; round += 1) {
        const order = round % 2 === 1 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
        for (const variant of order) {
          const cwd = variant === 'baseline' ? baselineRoot : REPO;
          const sample = runChild({ script: path.join(cwd, 'scripts/benchmarks/event-log-replay-memory.mjs'),
            cwd, argv: ['--worker', fixture, String(records)], extraNodeArgs: ['--expose-gc'] });
          assert.equal(sample.fixtureSha256, digest, 'both sides must absorb identical fixture bytes');
          const row = { phase: 'ab', variant, round, records, sample };
          rows.push(row);
          fs.appendFileSync(ledgerPath, `${JSON.stringify(row)}\n`);
        }
      }
    }
    // Same-code control at every scale, run from the baseline tree: this is the
    // floor any A/B difference has to clear.
    for (const records of counts) {
      const noiseFixture = path.join(fixtureDir, `records-${records}.jsonl`);
      for (let round = 1; round <= rounds; round += 1) {
        const order = round % 2 === 1 ? ['same-a', 'same-b'] : ['same-b', 'same-a'];
        for (const variant of order) {
          const sample = runChild({ script: path.join(baselineRoot, 'scripts/benchmarks/event-log-replay-memory.mjs'),
            cwd: baselineRoot, argv: ['--worker', noiseFixture, String(records)], extraNodeArgs: ['--expose-gc'] });
          const row = { phase: 'aa', variant, round, records, sample };
          rows.push(row);
          fs.appendFileSync(ledgerPath, `${JSON.stringify(row)}\n`);
        }
      }
    }
    const profiles = { open: {}, plan: {} };
    if (options.profile) {
      const profileRecords = Number(options['profile-records'] ?? Math.min(...counts));
      const fixture = path.join(fixtureDir, `records-${profileRecords}.jsonl`);
      for (const variant of ['baseline', 'candidate']) {
        const cwd = variant === 'baseline' ? baselineRoot : REPO;
        const script = path.join(cwd, 'scripts/benchmarks/event-log-replay-memory.mjs');
        profiles.open[variant] = { records: profileRecords, samplingInterval: 32768, scope: 'openDomainStorage()',
          ...(runChild({ script, cwd, argv: ['--worker', fixture, String(profileRecords), '--sampling-profile'],
            extraNodeArgs: ['--expose-gc'] }).profile) };
        profiles.plan[variant] = { records: profileRecords, samplingInterval: 32768, scope: 'planEventLogReplay() only',
          ...(runChild({ script, cwd, argv: ['--plan-worker', fixture, String(profileRecords), '--sampling-profile'],
            extraNodeArgs: ['--expose-gc'] }).profile) };
      }
    }
    const planSummary = counts.map((records) => ({
      records,
      variants: Object.fromEntries(['baseline', 'candidate'].map((variant) => {
        const sample = planRows.find((row) => row.variant === variant && row.records === records)?.sample;
        return [variant, sample ? { wallMs: sample.wallMs, planBytes: sample.planBytes, retained: sample.retained,
          maxRSS: sample.maxRSS, lineContainer: sample.planLineContainer } : null];
      })),
    }));
    const summary = {
      schema: 1,
      method: {
        baselineCommit: treeRevision(baselineRoot),
        candidateCommit: treeRevision(REPO),
        candidateWorktreeChanges: worktreeChanges(REPO),
        harnessSha256: scriptSha(SCRIPT),
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        rounds,
        ordering: 'alternating; odd rounds baseline first, even rounds candidate first',
        aaNoiseControl: 'the released baseline tree runs twice per round at every record count; that difference is the noise floor',
        freshTemporaryHomePerSample: true,
        officialDomainFacilityAndJsonStorageBackend: true,
        checkpointPresentBeforeOpen: false,
        memoryMethod: {
          maxRSS: 'process.resourceUsage().maxRSS raw value; whole child high-water mark, includes imports and fixture setup',
          replaySamples: 'process.memoryUsage() taken by a temporary instrumented copy of domain-storage.js after the plan is built, every 1024 absorbed lines, and after the commit; uncollected heap gauges showing where the peak occurs',
          planRetention: '--plan-worker builds the plan in a child without opening the domain, then global.gc() twice and subtracts the same measurement taken before; that delta is retained, not a high-water mark',
          heapProfile: options.profile ? 'V8 HeapProfiler.start/stopSampling scoped to one region (32 KiB interval) aggregated by call-frame self size; by default the sampling profiler drops objects a GC already collected, so this is neither an allocation total nor a retention figure: it is the sample of objects still present at stop, attributed to the frame that allocated them' : null,
        },
      },
      planRetention: planSummary,
      points: counts.map((count) => ({ ...summarize(rows, count), aaNoise: noise(rows, count) })),
      heapProfiles: options.profile ? profiles : null,
      rawLedger: path.relative(REPO, ledgerPath),
      samples: rows,
    };
    fs.writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ output, ledgerPath,
      planRetention: summary.planRetention,
      points: summary.points.map(({ records, variants, paired, aaNoise }) => ({ records,
        variants: Object.fromEntries(Object.entries(variants).map(([key, value]) => [key, { wallMs: value.wallMs, cpuMs: value.cpuMs, maxRSS: value.maxRSS,
          planMaxRSS: value.planMaxRSS, preCommitMaxRSS: value.preCommitMaxRSS, committedMaxRSS: value.committedMaxRSS,
          maxRSSAfterFlush: value.maxRSSAfterFlush,
          replayPeakHeapUsed: value.replayPeakHeapUsed, afterOpenHeapUsed: value.afterOpenHeapUsed }])),
        paired, aaNoise })) }, null, 2)}\n`);
  } finally { fs.rmSync(fixtureDir, { recursive: true, force: true }); }
}

const options = argsOf(process.argv.slice(2));
function positionalAfter(flag) {
  const index = process.argv.indexOf(flag);
  return [path.resolve(process.argv[index + 1]), Number(process.argv[index + 2])];
}
if (options.worker) {
  const [fixture, records] = positionalAfter('--worker');
  process.stdout.write(`${JSON.stringify(await worker(fixture, records, { sampling: Boolean(options['sampling-profile']) }))}\n`);
} else if (options['plan-worker']) {
  const [fixture, records] = positionalAfter('--plan-worker');
  process.stdout.write(`${JSON.stringify(await planWorker(fixture, records, { sampling: Boolean(options['sampling-profile']) }))}\n`);
} else {
  await runner(options);
}
