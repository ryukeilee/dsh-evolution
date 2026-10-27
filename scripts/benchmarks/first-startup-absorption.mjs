#!/usr/bin/env node
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
const HOOK = Symbol.for('dsh-evolution.first-startup-absorption-bench');
const KEY = 'b'.repeat(64);

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
  assert.ok(counts.length > 0 && counts.every((count) => Number.isSafeInteger(count) && count > 0), '--records must be a comma-separated list of positive integers');
  return counts;
}

function eventFor(sequence) {
  const experimentId = `absorption-${sequence}`;
  return {
    schema: 1,
    eventId: `evolution:measurement-completed:${experimentId}`,
    eventType: 'measurement-completed',
    experimentId,
    proposalId: `proposal-${experimentId}`,
    target: 'plugin:absorption-bench',
    capability: 'plugin:absorption-bench',
    lineageId: 'plugin:absorption-bench',
    status: 'measured',
    measurement: { latency: 10 + sequence % 101, throughput: 20 + sequence % 53 },
    evidence: { testPassed: true },
    audit: { producer: 'dsh-evolution-orchestrator', at: '2026-10-26T00:00:00.000Z' },
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

async function instrumentedDomainStorage() {
  const modulePath = path.join(REPO, 'lib/domain-storage.js');
  const source = fs.readFileSync(modulePath, 'utf8');
  const needle = 'export function assertTransactionSave(payload) {\n  const text = JSON.stringify(payload);';
  assert.equal(source.split(needle).length - 1, 1, 'benchmark instrumentation expects one assertTransactionSave body');
  const replacement = `export function assertTransactionSave(payload) {\n  globalThis[Symbol.for('dsh-evolution.first-startup-absorption-bench')].assertCalls += 1;\n  const text = JSON.stringify(payload);\n  globalThis[Symbol.for('dsh-evolution.first-startup-absorption-bench')].payloadBytes += Buffer.byteLength(text ?? '', 'utf8');`;
  const instrumentedPath = path.join(path.dirname(modulePath), `.domain-storage-absorption-${process.pid}-${crypto.randomUUID()}.mjs`);
  fs.writeFileSync(instrumentedPath, source.replace(needle, replacement), { mode: 0o600, flag: 'wx' });
  try { return await import(pathToFileURL(instrumentedPath)); }
  finally { fs.rmSync(instrumentedPath, { force: true }); }
}

async function worker(fixtureFile, expectedRecords) {
  const counters = { assertCalls: 0, payloadBytes: 0 };
  globalThis[HOOK] = counters;
  const { openDomainStorage } = await instrumentedDomainStorage();
  const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
  const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-first-startup-absorption-'));
  const eventBridgePath = path.join(root, 'execution-events.jsonl');
  fs.copyFileSync(fixtureFile, eventBridgePath);
  const checkpointPath = path.join(root, 'event-log.checkpoint.json');
  assert.equal(fs.existsSync(checkpointPath), false, 'the measured first startup must not have a replay checkpoint');
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = { emit() {}, on() { return () => {}; }, logger: { warn() {}, error() {} },
    storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  let port;
  try {
    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();
    port = await openDomainStorage(ctx, { presetDir: root, eventBridgePath, eventBridgeKey: KEY });
    const wallMs = performance.now() - wallStart;
    const cpu = process.cpuUsage(cpuStart);
    const cpuMs = (cpu.user + cpu.system) / 1000;
    const durablePath = path.join(root, 'official', 'evolution_domain.json');
    const durable = JSON.parse(fs.readFileSync(durablePath, 'utf8')).global;
    assert.equal(Object.keys(durable.applied).length, expectedRecords, 'every signed event must be absorbed on open');
    assert.equal(durable.pending, null);
    const sample = {
      wallMs,
      cpuMs,
      peakRssMaxRSS: process.resourceUsage().maxRSS,
      assertTransactionSaveCalls: counters.assertCalls,
      payloadBytesStringified: counters.payloadBytes,
      saveCallsPerRecord: counters.assertCalls / expectedRecords,
      records: expectedRecords,
      checkpointPresentBeforeOpen: false,
      fixtureBytes: fs.statSync(fixtureFile).size,
      fixtureSha256: crypto.createHash('sha256').update(fs.readFileSync(fixtureFile)).digest('hex'),
    };
    await port.close();
    port = null;
    return sample;
  } finally {
    if (port) await port.close().catch(() => {});
    await backend.close();
    fs.rmSync(root, { recursive: true, force: true });
    delete globalThis[HOOK];
  }
}

/**
 * The revision a measured tree is at, read from that tree rather than written
 * into this file: the baseline root is usually a worktree of the same HEAD, and a
 * hardcoded hash would quietly stop describing what was measured.
 */
function treeRevision(root) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Shipped files this candidate tree has not committed, as `git status` names them. */
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

function summarize(rows, records) {
  const selected = rows.filter((row) => row.records === records && row.phase === 'ab');
  const variants = Object.fromEntries(['baseline', 'candidate'].map((variant) => {
    const samples = selected.filter((row) => row.variant === variant).map((row) => row.sample);
    return [variant, Object.fromEntries(['wallMs', 'cpuMs', 'peakRssMaxRSS', 'assertTransactionSaveCalls', 'payloadBytesStringified', 'saveCallsPerRecord']
      .map((key) => [key, median(samples.map((sample) => sample[key]))]))];
  }));
  const pairs = [];
  for (const round of [...new Set(selected.map((row) => row.round))]) {
    const baseline = selected.find((row) => row.round === round && row.variant === 'baseline')?.sample;
    const candidate = selected.find((row) => row.round === round && row.variant === 'candidate')?.sample;
    if (baseline && candidate) pairs.push({ round, wallDeltaMs: candidate.wallMs - baseline.wallMs, cpuDeltaMs: candidate.cpuMs - baseline.cpuMs });
  }
  return { records, variants, pairedDeltas: pairs };
}

function noise(rows, records) {
  const selected = rows.filter((row) => row.phase === 'aa' && row.records === records);
  const differences = [];
  for (const round of [...new Set(selected.map((row) => row.round))]) {
    const first = selected.find((row) => row.round === round && row.variant === 'same-a')?.sample;
    const second = selected.find((row) => row.round === round && row.variant === 'same-b')?.sample;
    if (first && second) differences.push({ round,
      wallAbsDeltaMs: Math.abs(first.wallMs - second.wallMs),
      cpuAbsDeltaMs: Math.abs(first.cpuMs - second.cpuMs),
      rssAbsDeltaMaxRSS: Math.abs(first.peakRssMaxRSS - second.peakRssMaxRSS) });
  }
  return {
    records,
    pairs: differences,
    maxWallAbsDeltaMs: differences.length ? Math.max(...differences.map((pair) => pair.wallAbsDeltaMs)) : null,
    maxCpuAbsDeltaMs: differences.length ? Math.max(...differences.map((pair) => pair.cpuAbsDeltaMs)) : null,
    maxRssAbsDeltaMaxRSS: differences.length ? Math.max(...differences.map((pair) => pair.rssAbsDeltaMaxRSS)) : null,
  };
}

function runChild({ script, cwd, fixture, records }) {
  const result = spawnSync(process.execPath, [script, '--worker', fixture, String(records)], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' },
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`worker failed (${cwd}): ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

async function runner(options) {
  const counts = parseCounts(options.records);
  const rounds = Number(options.rounds ?? 3);
  const samples = Number(options.samples ?? 1);
  assert.ok(Number.isSafeInteger(rounds) && rounds >= 3, '--rounds must be at least 3');
  assert.ok(Number.isSafeInteger(samples) && samples >= 1, '--samples must be positive');
  const baselineRoot = path.resolve(String(options['baseline-root'] ?? '/tmp/dsh-base-perf'));
  const baselineScript = path.join(baselineRoot, 'scripts/benchmarks/first-startup-absorption.mjs');
  assert.ok(fs.existsSync(baselineScript), `baseline harness missing at ${baselineScript}`);
  const output = path.resolve(String(options.out ?? path.join(REPO, 'docs/performance/first-startup-absorption-save-coalescing.json')));
  const ledgerPath = path.resolve(String(options.ledger ?? output.replace(/\.json$/u, '.jsonl')));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, '');
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-first-startup-fixtures-'));
  const rows = [];
  try {
    for (const records of counts) {
      const fixture = path.join(fixtureDir, `records-${records}.jsonl`);
      await makeFixture(fixture, records);
      const digest = crypto.createHash('sha256').update(fs.readFileSync(fixture)).digest('hex');
      for (let round = 1; round <= rounds; round += 1) {
        const order = round % 2 === 1 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
        for (const variant of order) {
          for (let sampleIndex = 1; sampleIndex <= samples; sampleIndex += 1) {
            const script = variant === 'baseline' ? baselineScript : SCRIPT;
            const cwd = variant === 'baseline' ? baselineRoot : REPO;
            const sample = runChild({ script, cwd, fixture, records });
            assert.equal(sample.fixtureSha256, digest, 'both sides must absorb identical fixture bytes');
            const row = { phase: 'ab', variant, round, sampleIndex, records, sample };
            rows.push(row);
            fs.appendFileSync(ledgerPath, `${JSON.stringify(row)}\n`);
          }
        }
      }
    }
    const noiseRecords = Math.min(...counts);
    const noiseFixture = path.join(fixtureDir, `records-${noiseRecords}.jsonl`);
    for (let round = 1; round <= rounds; round += 1) {
      const order = round % 2 === 1 ? ['same-a', 'same-b'] : ['same-b', 'same-a'];
      for (const variant of order) {
        for (let sampleIndex = 1; sampleIndex <= samples; sampleIndex += 1) {
          const sample = runChild({ script: SCRIPT, cwd: REPO, fixture: noiseFixture, records: noiseRecords });
          const row = { phase: 'aa', variant, round, sampleIndex, records: noiseRecords, sample };
          rows.push(row);
          fs.appendFileSync(ledgerPath, `${JSON.stringify(row)}\n`);
        }
      }
    }
    const summary = {
      schema: 1,
      method: {
        baselineCommit: treeRevision(baselineRoot),
        candidateCommit: treeRevision(REPO),
        candidateWorktreeChanges: worktreeChanges(REPO),
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        rounds,
        samplesPerVariantPerRound: samples,
        ordering: 'alternating; odd rounds baseline first, even rounds candidate first',
        aaNoiseControl: 'same candidate code twice per round at the smallest record count',
        fixtureSha256ByRecords: Object.fromEntries(counts.map((count) => [count,
          crypto.createHash('sha256').update(fs.readFileSync(path.join(fixtureDir, `records-${count}.jsonl`))).digest('hex')])),
        fixtureWasCreatedOnceAndReused: true,
        freshTemporaryHomePerSample: true,
        officialDomainFacilityAndJsonStorageBackend: true,
        checkpointPresentBeforeOpen: false,
        rssField: 'process.resourceUsage().maxRSS raw value; whole-process high-water mark',
        assertTransactionSaveInstrumentation: 'The worker loads an adjacent temporary copy of domain-storage.js with counters inserted at the assertTransactionSave entry and immediately after JSON.stringify; the production source is not instrumented.',
      },
      points: counts.map((count) => ({ ...summarize(rows, count), aaNoise: count === noiseRecords ? noise(rows, count) : null })),
      rawLedger: path.relative(REPO, ledgerPath),
      samples: rows,
    };
    fs.writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ output, ledgerPath, points: summary.points.map(({ records, variants, aaNoise }) => ({ records, variants, aaNoise })) }, null, 2)}\n`);
  } finally { fs.rmSync(fixtureDir, { recursive: true, force: true }); }
}

const options = argsOf(process.argv.slice(2));
if (options.worker) {
  const sample = await worker(path.resolve(String(options.worker)), Number(process.argv[process.argv.indexOf('--worker') + 2]));
  process.stdout.write(`${JSON.stringify(sample)}\n`);
} else {
  await runner(options);
}
