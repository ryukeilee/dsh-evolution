// R13: composition of one complete evolution loop (plugin side only).
//
// Drives the real orchestrator control flow (plan -> propose -> probe baseline
// -> trial -> probe candidate -> measure -> promote-without-confirmation ->
// revert) against the shared fake pipeline the lifecycle regressions use, so no
// host, model or network is involved. The numbers below are therefore plugin
// CPU/wall only: "host overhead" and "model inference" are explicitly out of
// scope and are never inferred from these samples.
//
// Every run uses a fresh mkdtemp root. `--history` seeds N prior experiment
// conclusions on other targets so the per-phase cost can be read as a growth
// curve rather than a single point.
//
// Usage:
//   node --max-old-space-size=4096 scripts/benchmarks/r13-loop-composition.mjs \
//     --history 0 --runs 7 --out docs/performance/r13-loop-composition.json

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { EvolutionOrchestrator } from '../../lib/orchestrator.js';
import { openSharedExperience } from '../../lib/shared-experience.js';
import { strategyFingerprint } from '../../lib/experience-plan.js';
import {
  execFor,
  orchestratorContext,
  promotionPaths,
  scratchRoot,
  unitPromotionRuntime,
} from '../../test/orchestrator-durability-fixtures.mjs';

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const HOST_VERSIONS = Object.freeze({ host: '1.30.0', cordis: '4.1.0', evolution: '0.3.0' });
const APPLICABILITY = Object.freeze({ dsh: '1.30.0', cordis: '4.1.0', evolution: '0.3.0' });
const TARGET = 'tool:edge-cache';
const STRATEGY = 'prewarm the cache before the first read';
const ROOT_CAUSE = 'the cache is populated lazily on the second read';

function parseArgs(argv) {
  const out = { history: 0, runs: 7, out: null, instrument: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--history') out.history = Number(argv[++index]);
    else if (arg === '--runs') out.runs = Number(argv[++index]);
    else if (arg === '--out') out.out = argv[++index];
    else if (arg === '--no-instrument') out.instrument = false;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(out.history) || out.history < 0) throw new Error('--history must be >= 0');
  if (!Number.isFinite(out.runs) || out.runs < 1) throw new Error('--runs must be >= 1');
  return out;
}

/** Count and time the lossless-copy boundaries the loop actually crosses. */
function instrumentCopies() {
  const stats = {
    structuredClone: { calls: 0, cpuMs: 0 },
    jsonStringify: { calls: 0, cpuMs: 0 },
    jsonParse: { calls: 0, cpuMs: 0 },
  };
  const originalClone = globalThis.structuredClone;
  const originalStringify = JSON.stringify;
  const originalParse = JSON.parse;
  const wrap = (bucket, fn) => function instrumented(...args) {
    const started = process.hrtime.bigint();
    try {
      return fn.apply(this, args);
    } finally {
      bucket.calls += 1;
      bucket.cpuMs += Number(process.hrtime.bigint() - started) / 1e6;
    }
  };
  globalThis.structuredClone = wrap(stats.structuredClone, originalClone);
  JSON.stringify = wrap(stats.jsonStringify, originalStringify);
  JSON.parse = wrap(stats.jsonParse, originalParse);
  return {
    stats,
    restore() {
      globalThis.structuredClone = originalClone;
      JSON.stringify = originalStringify;
      JSON.parse = originalParse;
    },
    reset() {
      for (const bucket of Object.values(stats)) { bucket.calls = 0; bucket.cpuMs = 0; }
    },
  };
}

/**
 * Time the shared-experience store calls one loop makes. This is what turns the
 * per-phase numbers into an attribution: `findConclusions` is an explicit-action
 * full scan, while `discover`/`recall` are bounded windows. The wrapper only
 * records calls and hrtime deltas; it does not change arguments or results.
 */
function instrumentStore(store) {
  const tracked = new Map();
  for (const name of ['findConclusions', 'discover', 'recall', 'recordConclusion', 'recordFailure', 'recordDegradation']) {
    const original = store[name];
    if (typeof original !== 'function') continue;
    const stat = { calls: 0, cpuMs: 0 };
    tracked.set(name, { stat, fn: function wrapped(...args) {
      const started = process.hrtime.bigint();
      try {
        return Reflect.apply(original, store, args);
      } finally {
        stat.calls += 1;
        stat.cpuMs += Number(process.hrtime.bigint() - started) / 1e6;
      }
    } });
  }
  // The store is frozen, and a Proxy may not substitute a non-configurable
  // property: build a plain facade instead. Untracked methods stay bound to the
  // real store; tracked ones are the timing wrappers.
  const client = {};
  for (const key of Object.keys(store)) {
    const value = store[key];
    client[key] = typeof value === 'function' && !tracked.has(key) ? value.bind(store) : value;
  }
  for (const [name, entry] of tracked) client[name] = entry.fn;
  return {
    client,
    snapshot() {
      return Object.fromEntries([...tracked].map(([name, entry]) => [name, { ...entry.stat }]));
    },
    reset() {
      for (const entry of tracked.values()) { entry.stat.calls = 0; entry.stat.cpuMs = 0; }
    },
  };
}

function fakeRunner() {
  let sequence = 0;
  return {
    define() { sequence += 1; return { pluginId: `plugin-${sequence}`, packageId: `package-${sequence}` }; },
    async run() { return { ok: true, status: 'running', pluginRunId: 'run-1' }; },
    async stop() { return { ok: true }; },
    async undefine() { return { ok: true }; },
    snapshot() { return []; },
  };
}

function probeScenario() {
  return {
    id: 'edge-cache-first-read',
    repetitions: 2,
    steps: [
      { name: 'probe-target', role: 'target', arguments: { key: 'first' } },
      { name: 'probe-control', role: 'control', arguments: { key: 'second' } },
    ],
  };
}

async function createHarness(history) {
  const root = await scratchRoot('r13-loop');
  const paths = promotionPaths(root);
  const store = openSharedExperience(path.join(root, 'shared-experience'));
  const warnings = [];
  const state = { targetFails: true, controlFails: false, controlValue: { ok: true } };
  const runStep = (call) => call.name === 'probe-target'
    ? state.targetFails
      ? { isError: true, error: { code: 'E_TARGET_FAILED' } }
      : { isError: false, value: { ok: true } }
    : state.controlFails
      ? { isError: true, error: { code: 'E_CONTROL_FAILED' } }
      : { isError: false, value: structuredClone(state.controlValue) };
  const execute = async ({ calls }) => {
    const call = calls[0];
    return { results: [{ callId: call.id, result: runStep(call) }] };
  };
  const storeStats = instrumentStore(store);
  const runner = fakeRunner();
  const ctx = orchestratorContext(warnings);
  const definitions = new Map([
    ['probe-target', { name: 'probe-target', isConcurrencySafe: () => true }],
    ['probe-control', { name: 'probe-control', isConcurrencySafe: () => true }],
  ]);
  ctx.tools = { schemas: () => [], register() {}, execute, get: (name) => definitions.get(name) };
  ctx.dynamicCordisRunner = runner;
  const orchestrator = new EvolutionOrchestrator(ctx, {
    ...paths,
    promotionRuntime: unitPromotionRuntime(),
    sharedExperience: storeStats.client,
    runtimeVersions: HOST_VERSIONS,
    eventBridge: { emit: () => ({ audit: { at: '2026-01-01T00:00:00.000Z' } }) },
  });
  // Prior history: unrelated targets, so the current target stays unknown to
  // the planner while every shared-experience read has to walk the grown table.
  for (let index = 0; index < history; index += 1) {
    const target = `tool:history-${index}`;
    store.recordConclusion({
      experimentId: `exp-history-${index}`,
      target,
      strategy: `strategy ${index}`,
      strategyFingerprint: strategyFingerprint(target, `strategy ${index}`),
      decision: index % 3 === 0 ? 'no-benefit' : 'adopted',
      applicability: APPLICABILITY,
      occurredAt: '2026-01-05T00:00:00.000Z',
      rootCause: 'seeded history',
    }, '/tmp/r13-history-origin.jsonl');
  }
  for (let index = 0; index < 3; index += 1) {
    store.recordFailure({ id: sha256(`failure:${TARGET}:${index}`), type: 'tool/error', code: 'E_TOOL_FAILED', target: TARGET });
  }
  const exec = execFor();
  return {
    root, store, storeStats, state, orchestrator, exec, warnings,
    async close() {
      try { store.close(); } catch { /* already closed */ }
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

function phaseTimer(map, name) {
  const started = process.cpuUsage();
  const wall = process.hrtime.bigint();
  return {
    end() {
      const cpu = process.cpuUsage(started);
      const entry = map[name] ?? { cpuMs: 0, wallMs: 0, calls: 0 };
      entry.cpuMs += (cpu.user + cpu.system) / 1000;
      entry.wallMs += Number(process.hrtime.bigint() - wall) / 1e6;
      entry.calls += 1;
      map[name] = entry;
    },
  };
}

async function runOnce(history, instrument = true) {
  const h = await createHarness(history);
  const phases = {};
  const copies = instrument ? instrumentCopies() : {
    stats: {
      structuredClone: { calls: 0, cpuMs: 0 },
      jsonStringify: { calls: 0, cpuMs: 0 },
      jsonParse: { calls: 0, cpuMs: 0 },
    },
    reset() {},
    restore() {},
  };
  const totalStart = process.cpuUsage();
  const totalWall = process.hrtime.bigint();
  try {
    copies.reset();

    let timer = phaseTimer(phases, 'plan');
    const plan = h.orchestrator.plan({ focus: 'edge-cache' }, h.exec);
    timer.end();
    if (!plan.ok || plan.candidates.length !== 1) throw new Error(`plan did not select the seeded failure: ${JSON.stringify(plan)}`);
    const planCopies = structuredCloneJSON(copies.stats);
    const planStore = h.storeStats.snapshot();
    copies.reset();
    h.storeStats.reset();

    timer = phaseTimer(phases, 'propose');
    const proposed = h.orchestrator.propose({
      target: TARGET,
      strategy: STRATEGY,
      rootCause: ROOT_CAUSE,
      why: 'the first cache read keeps failing across sessions',
      impactScope: ['test'],
      successMetrics: ['successRate'],
    }, h.exec);
    timer.end();
    if (!proposed.ok) throw new Error(`propose failed: ${JSON.stringify(proposed)}`);
    const experimentId = proposed.experimentId;
    const proposeCopies = structuredCloneJSON(copies.stats);
    const proposeStore = h.storeStats.snapshot();
    copies.reset();
    h.storeStats.reset();

    const scenario = probeScenario();
    timer = phaseTimer(phases, 'probe-baseline');
    const baseline = await h.orchestrator.probe({ experimentId, phase: 'baseline', scenario }, h.exec);
    timer.end();
    if (!baseline.ok) throw new Error(`baseline probe failed: ${JSON.stringify(baseline)}`);
    const baselineCopies = structuredCloneJSON(copies.stats);
    const baselineStore = h.storeStats.snapshot();
    copies.reset();
    h.storeStats.reset();

    timer = phaseTimer(phases, 'trial');
    const trial = await h.orchestrator.trial({
      experimentId,
      composition: { name: 'edge-cache-prewarm', purpose: 'probe the first read before and after the change', code: { host: 'return { name: "edge-cache-prewarm", apply() {} };' } },
    }, h.exec);
    timer.end();
    if (!trial.ok) throw new Error(`trial failed: ${JSON.stringify(trial)}`);
    const trialCopies = structuredCloneJSON(copies.stats);
    const trialStore = h.storeStats.snapshot();
    copies.reset();
    h.storeStats.reset();

    h.state.targetFails = false;
    timer = phaseTimer(phases, 'probe-candidate');
    const candidate = await h.orchestrator.probe({ experimentId, phase: 'candidate', scenario }, h.exec);
    timer.end();
    if (!candidate.ok) throw new Error(`candidate probe failed: ${JSON.stringify(candidate)}`);
    const candidateCopies = structuredCloneJSON(copies.stats);
    const candidateStore = h.storeStats.snapshot();
    copies.reset();
    h.storeStats.reset();

    timer = phaseTimer(phases, 'measure');
    const measurement = h.orchestrator.measure({
      experimentId,
      observation: {
        solvesProblem: true, sideEffects: [], orphanResources: [], reversible: true,
        cleanupEvidence: 'Cordis stop+undefine proved the Trial was disposed', regressionPassed: true,
      },
    }, h.exec);
    timer.end();
    if (measurement.phase !== 'measured') throw new Error(`measure failed: ${JSON.stringify(measurement)}`);
    const measureCopies = structuredCloneJSON(copies.stats);
    const measureStore = h.storeStats.snapshot();
    copies.reset();
    h.storeStats.reset();

    timer = phaseTimer(phases, 'promote-awaiting-owner');
    const pending = await h.orchestrator.promote({ experimentId }, h.exec);
    timer.end();
    if (pending.ok !== false || pending.phase !== 'awaiting-owner-confirmation') throw new Error(`promote should wait for the owner: ${JSON.stringify(pending)}`);
    const promoteCopies = structuredCloneJSON(copies.stats);
    const promoteStore = h.storeStats.snapshot();
    copies.reset();
    h.storeStats.reset();

    timer = phaseTimer(phases, 'revert');
    const reverted = await h.orchestrator.revert({ experimentId }, h.exec);
    timer.end();
    if (!reverted.ok) throw new Error(`revert failed: ${JSON.stringify(reverted)}`);
    const revertCopies = structuredCloneJSON(copies.stats);
    const revertStore = h.storeStats.snapshot();

    const totalCpu = process.cpuUsage(totalStart);
    return {
      history,
      phases,
      copies: {
        plan: planCopies, propose: proposeCopies, 'probe-baseline': baselineCopies, trial: trialCopies,
        'probe-candidate': candidateCopies, measure: measureCopies, 'promote-awaiting-owner': promoteCopies, revert: revertCopies,
      },
      store: {
        plan: planStore, propose: proposeStore, 'probe-baseline': baselineStore, trial: trialStore,
        'probe-candidate': candidateStore, measure: measureStore, 'promote-awaiting-owner': promoteStore, revert: revertStore,
      },
      totalCpuMs: (totalCpu.user + totalCpu.system) / 1000,
      totalWallMs: Number(process.hrtime.bigint() - totalWall) / 1e6,
      decision: measurement.decision?.kind ?? null,
      conclusion: reverted.decision?.kind ?? null,
      probeSamples: baseline.samples.length,
      archiveBytes: (await fs.stat(reverted.archive)).size,
    };
  } finally {
    copies.restore();
    await h.close();
  }
}

function structuredCloneJSON(stats) {
  return {
    structuredClone: { ...stats.structuredClone },
    jsonStringify: { ...stats.jsonStringify },
    jsonParse: { ...stats.jsonParse },
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function summarize(samples) {
  const phaseNames = new Set();
  for (const sample of samples) for (const name of Object.keys(sample.phases)) phaseNames.add(name);
  const phases = {};
  for (const name of phaseNames) {
    const cpu = samples.filter((sample) => sample.phases[name]).map((sample) => sample.phases[name].cpuMs);
    const wall = samples.filter((sample) => sample.phases[name]).map((sample) => sample.phases[name].wallMs);
    phases[name] = { cpuMs: median(cpu), wallMs: median(wall), runs: cpu.length };
  }
  const totalCpu = median(samples.map((sample) => sample.totalCpuMs));
  for (const entry of Object.values(phases)) entry.cpuShare = totalCpu > 0 ? entry.cpuMs / totalCpu : null;
  return {
    phases,
    totalCpuMs: totalCpu,
    totalWallMs: median(samples.map((sample) => sample.totalWallMs)),
    archiveBytes: median(samples.map((sample) => sample.archiveBytes)),
    copies: medianCopies(samples),
    store: medianStore(samples),
  };
}

function medianStore(samples) {
  const phases = Object.keys(samples[0].store);
  const out = {};
  for (const phase of phases) {
    out[phase] = {};
    const methods = new Set(samples.flatMap((sample) => Object.keys(sample.store[phase])));
    for (const method of methods) {
      out[phase][method] = {
        calls: median(samples.map((sample) => sample.store[phase][method]?.calls ?? 0)),
        cpuMs: median(samples.map((sample) => sample.store[phase][method]?.cpuMs ?? 0)),
      };
    }
  }
  return out;
}

function medianCopies(samples) {
  const phases = Object.keys(samples[0].copies);
  const out = {};
  for (const phase of phases) {
    out[phase] = {};
    for (const kind of ['structuredClone', 'jsonStringify', 'jsonParse']) {
      out[phase][kind] = {
        calls: median(samples.map((sample) => sample.copies[phase][kind].calls)),
        cpuMs: median(samples.map((sample) => sample.copies[phase][kind].cpuMs)),
      };
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = {
    method: {
      what: 'one complete plugin-side evolution loop: plan, propose, probe baseline, trial, probe candidate, measure, promote (stopped at owner confirmation), revert',
      notMeasured: 'host runtime, model inference, developer harness; no real DSH_HOME, no network, no formal experience store',
      metric: 'process.cpuUsage user+system per phase, wall clock, and instrumented structuredClone/JSON call counts',
      scale: 'each --history value seeds N prior conclusions on unrelated targets in a fresh mkdtemp store',
      env: { node: process.version, platform: process.platform, arch: process.arch },
      hostVersions: HOST_VERSIONS,
      applicability: APPLICABILITY,
    },
    history: args.history,
    runs: args.runs,
    instrumented: args.instrument,
    samples: [],
    summary: null,
  };
  for (let run = 0; run < args.runs; run += 1) {
    result.samples.push(await runOnce(args.history, args.instrument));
  }
  result.summary = summarize(result.samples);
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (args.out) await fs.writeFile(args.out, text);
  process.stdout.write(text);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
