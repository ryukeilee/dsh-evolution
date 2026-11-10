#!/usr/bin/env node
// Component-cost attribution for one cold replay tree. Never A/B evidence: the
// instrumentation adds timers and a GC observer, so it is used only to say
// where the wall time went, on an extracted copy of the source.
//
//   node --max-old-space-size=4096 scripts/benchmarks/marker-window-write-cost.mjs \
//     --ref 20e2cf0 --records 50000 --repetitions 3 --out docs/performance/....json
//   node --max-old-space-size=4096 scripts/benchmarks/marker-window-write-cost.mjs \
//     --working --records 50000 --repetitions 3 --out docs/performance/....json
//
// The child is archive-append-window.mjs's unchanged cold-replay workload, run
// against the extracted tree, on the real official DomainFacility /
// JsonStorageBackend fixture. The probes:
//
//   - `saveCheck.*`   time in `assertStagedTransactionSave()` (the per-save
//                     check, excluding the copy that precedes it);
//   - frozen shape:   time and references of the per-record window rebuild, and
//                     the time spent freezing that successor;
//   - deferred shape: time of each in-place marker append and the number of
//                     periodic reductions to the bounded window;
//   - `gc.*`          GC pause time/count measured only inside the absorption.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : args[index + 1];
};
const flag = (name) => args.includes(`--${name}`);
const ref = arg('ref', null);
const working = flag('working') || ref === null;
const records = Number(arg('records', '50000'));
const repetitions = Number(arg('repetitions', '3'));
const out = path.resolve(arg('out', path.join(os.tmpdir(), 'marker-window-write-cost.json')));

const replaceOnce = (source, from, to, label) => {
  assert.equal(source.split(from).length - 1, 1, `${label}: anchor must occur exactly once`);
  return source.replace(from, to);
};

const statFields = 'calls: 0, refs: 0, copyMs: 0, freezeMs: 0, appendMs: 0, reductions: 0, saveCheckMs: 0, saveCalls: 0';

function instrumentMemory(source, shape) {
  if (shape === 'frozen') {
    source = replaceOnce(source,
      `      const start = Math.max(0, applied.length - 4095);
      const next = new Array(applied.length - start + 1);
      for (let index = start; index < applied.length; index += 1) next[index - start] = applied[index];
      next[next.length - 1] = marker;
      Object.freeze(next);`,
      `      const __win = (globalThis.__windowCost ??= { ${statFields} });
      const __copyStart = performance.now();
      const start = Math.max(0, applied.length - 4095);
      const next = new Array(applied.length - start + 1);
      for (let index = start; index < applied.length; index += 1) next[index - start] = applied[index];
      next[next.length - 1] = marker;
      const __copyEnd = performance.now();
      Object.freeze(next);
      const __freezeEnd = performance.now();
      __win.calls += 1; __win.refs += applied.length - start;
      __win.copyMs += __copyEnd - __copyStart;
      __win.freezeMs += __freezeEnd - __copyEnd;`,
      'frozen window copy');
    return source;
  }
  source = replaceOnce(source,
    `    if (deferred) {
      // The private replay working copy grows its window in place.`,
    `    if (deferred) {
      const __win = (globalThis.__windowCost ??= { ${statFields} });
      const __appendStart = performance.now();
      // The private replay working copy grows its window in place.`,
    'deferred append start');
  source = replaceOnce(source,
    `      } else {
        changed(applied, applied, marker);
      }
    } else if (typeof changed === "function" && Object.isFrozen(applied)) {`,
    `      } else {
        changed(applied, applied, marker);
      }
      __win.appendMs += performance.now() - __appendStart;
      __win.calls += 1;
    } else if (typeof changed === "function" && Object.isFrozen(applied)) {`,
    'deferred append end');
  source = replaceOnce(source,
    `      if (applied.length > BRIDGE_MARKER_WINDOW * 2) {
        const next = applied.slice(-BRIDGE_MARKER_WINDOW);`,
    `      if (applied.length > BRIDGE_MARKER_WINDOW * 2) {
        __win.reductions += 1;
        const next = applied.slice(-BRIDGE_MARKER_WINDOW);`,
    'deferred reduction');
  return source;
}

function instrumentDomain(source) {
  return replaceOnce(source,
    `        assertStagedTransactionSave(next, markerVerdicts, windowChecks?.windows, windowChecks?.elements);`,
    `        const __check = (globalThis.__windowCost ??= { ${statFields} });
        const __checkStart = performance.now();
        assertStagedTransactionSave(next, markerVerdicts, windowChecks?.windows, windowChecks?.elements);
        __check.saveCheckMs += performance.now() - __checkStart;
        __check.saveCalls += 1;`,
    'staged save check');
}

function extractTree() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-window-cost-'));
  if (working) {
    fs.cpSync(path.join(REPO, 'lib'), path.join(directory, 'lib'), { recursive: true });
    for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(REPO, file), path.join(directory, file));
  } else {
    execFileSync('tar', ['-x', '-C', directory], {
      input: execFileSync('git', ['archive', ref, 'lib', 'package.json', 'package-lock.json'], { cwd: REPO, maxBuffer: 1 << 28 }),
    });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
  return directory;
}

const directory = extractTree();
const report = {
  method: {
    mode: working ? 'working-tree' : `git-archive:${ref}`,
    records, repetitions,
    node: process.version, platform: `${process.platform}/${process.arch}`,
    workload: 'archive-append-window.mjs --child (official DomainFacility/JsonStorageBackend, fresh temp root)',
    note: 'instrumented attribution; the timers and GC observer make these wall times unsuitable as A/B evidence',
  },
  sources: {},
  shape: null,
  runs: [],
};
try {
  const memoryFile = path.join(directory, 'lib/dockyard-domain/memory.js');
  const domainFile = path.join(directory, 'lib/domain-storage.js');
  const memorySource = fs.readFileSync(memoryFile, 'utf8');
  const domainSource = fs.readFileSync(domainFile, 'utf8');
  report.sources = Object.fromEntries([['lib/dockyard-domain/memory.js', memorySource], ['lib/domain-storage.js', domainSource]]
    .map(([file, source]) => [file, crypto.createHash('sha256').update(source).digest('hex')]));
  report.shape = memorySource.includes('applied.length - 4095') ? 'frozen' : 'deferred';
  fs.writeFileSync(memoryFile, instrumentMemory(memorySource, report.shape));
  fs.writeFileSync(domainFile, instrumentDomain(domainSource));

  const hook = path.join(directory, 'cost-hook.mjs');
  fs.writeFileSync(hook, `import { PerformanceObserver } from 'node:perf_hooks';
let observer = null;
export function install() {
  return {
    start() {
      globalThis.__windowCost = { ${statFields} };
      globalThis.__gcCost = { count: 0, ms: 0 };
      observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) { globalThis.__gcCost.count += 1; globalThis.__gcCost.ms += entry.duration; }
      });
      observer.observe({ entryTypes: ['gc'] });
    },
    stop() {
      observer?.disconnect();
      for (const entry of observer?.takeRecords() ?? []) { globalThis.__gcCost.count += 1; globalThis.__gcCost.ms += entry.duration; }
      return { window: { ...globalThis.__windowCost }, gc: { ...globalThis.__gcCost } };
    },
  };
}
`);
  for (let index = 0; index < repetitions; index += 1) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-window-cost-data-'));
    try {
      const result = JSON.parse(execFileSync(process.execPath, ['--expose-gc', '--max-old-space-size=4096',
        path.join(REPO, 'scripts/benchmarks/archive-append-window.mjs'), '--child'], {
        cwd: REPO,
        env: { ...process.env, BENCH_TREE: directory, BENCH_ROOT: root, BENCH_ENVELOPE: REPO,
          BENCH_RECORDS: String(records), BENCH_OBSERVES: '0', BENCH_FLUSHES: '0',
          BENCH_AUDIT_MODULE: pathToFileURL(hook).href },
        encoding: 'utf8', maxBuffer: 1 << 25,
      }));
      report.runs.push(result);
      const window = result.audit.window;
      console.log(`run ${index}: absorption=${result.absorption.wallMs.toFixed(1)}ms cpu=${result.absorption.cpuMs.toFixed(1)}ms ` +
        `saveCheck=${window.saveCheckMs.toFixed(1)}ms append=${window.appendMs.toFixed(1)}ms ` +
        `copy=${window.copyMs.toFixed(1)}ms freeze=${window.freezeMs.toFixed(1)}ms reductions=${window.reductions} ` +
        `gc=${result.audit.gc.ms.toFixed(1)}ms/${result.audit.gc.count}`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  const median = (values) => {
    const sorted = [...values].sort((left, right) => left - right);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const window = report.runs.map((run) => run.audit.window);
  report.summary = {
    absorptionWallMs: median(report.runs.map((run) => run.absorption.wallMs)),
    absorptionCpuMs: median(report.runs.map((run) => run.absorption.cpuMs)),
    saveCheckMs: median(window.map((entry) => entry.saveCheckMs)),
    copyMs: median(window.map((entry) => entry.copyMs)),
    freezeMs: median(window.map((entry) => entry.freezeMs)),
    appendMs: median(window.map((entry) => entry.appendMs)),
    reductions: median(window.map((entry) => entry.reductions)),
    gcMs: median(report.runs.map((run) => run.audit.gc.ms)),
    gcCount: median(report.runs.map((run) => run.audit.gc.count)),
    maxRssMiB: median(report.runs.map((run) => run.maxRss)) / 1048576,
  };
  const summary = report.summary;
  console.log(`${report.shape}: window copy+freeze=${(summary.copyMs + summary.freezeMs).toFixed(1)}ms, ` +
    `in-place append=${summary.appendMs.toFixed(1)}ms, reductions=${summary.reductions}, ` +
    `saveCheck=${summary.saveCheckMs.toFixed(1)}ms, gc=${summary.gcMs.toFixed(1)}ms/${summary.gcCount}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${out}`);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
