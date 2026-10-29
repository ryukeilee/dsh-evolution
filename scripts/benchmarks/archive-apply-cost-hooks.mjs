// Cold-only probes used by archive-apply-cost-audit.mjs. No payload is exported.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { performance, PerformanceObserver } from 'node:perf_hooks';
import inspector from 'node:inspector';

export function install() {
  const mode = process.env.BENCH_AUDIT_MODE;
  const rows = {};
  let enabled = false, phase = 'open', session, observer;
  let phaseStarted, phaseCpu, initialMemory, windowStart, windowEnd, profilerStart;
  const gc = [];
  const undo = [];
  const now = () => performance.now();
  const add = (name, ms, bytes = 0, count = 1) => {
    const row = rows[name] ??= { calls: 0, wallMs: 0, bytes: 0 };
    row.calls += count; row.wallMs += ms; row.bytes += bytes;
  };
  const audit = {
    begin(name) { return enabled ? { name, start: now() } : null; },
    end(token) { if (token) add(token.name, now() - token.start); },
    sync(name, work) {
      if (!enabled) return work();
      const cpu = mode === 'savecpu' ? process.threadCpuUsage() : null;
      const start = now();
      try { return work(); }
      finally {
        add(name, now() - start);
        if (cpu) {
          const used = process.threadCpuUsage(cpu);
          rows[name].threadCpuMs = (rows[name].threadCpuMs ?? 0) + (used.user + used.system) / 1000;
        }
      }
    },
    text(name, work) {
      if (!enabled) return work();
      const start = now(); const result = work();
      add(name, now() - start, result?.length ?? 0); return result;
    },
    endText(token, value) { if (token) add(token.name, now() - token.start, value?.length ?? 0); },
    count(name, count = 1) { if (enabled) add(name, 0, 0, count); },
    phase(next) {
      if (!enabled) return;
      const cpu = process.cpuUsage(phaseCpu);
      add(`phase.${phase}`, now() - phaseStarted);
      rows[`phase.${phase}`].startTime = phaseStarted;
      rows[`phase.${phase}`].endTime = now();
      rows[`phase.${phase}`].cpuMs = (cpu.user + cpu.system) / 1000;
      rows[`phase.${phase}`].memory = process.memoryUsage();
      phase = next; phaseStarted = now(); phaseCpu = process.cpuUsage();
    },
  };
  globalThis.__coldAudit = audit;
  const post = (method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (error, value) => error ? reject(error) : resolve(value)));
  const installIO = () => {
    const descriptors = new Set();
    const isArchive = target => typeof target === 'string' && target.startsWith(process.env.BENCH_ROOT)
      && (target.includes('-archive.jsonl') || target.includes('evolution-archive-index.json'));
    for (const name of ['openSync', 'readSync', 'closeSync', 'mkdirSync', 'statSync', 'lstatSync', 'readFileSync', 'readdirSync', 'writeFileSync', 'renameSync']) {
      const original = fs[name];
      fs[name] = function (...args) {
        if (!enabled) return original.apply(this, args);
        const tracked = isArchive(args[0]) || descriptors.has(args[0]);
        const started = now();
        try {
          const result = original.apply(this, args);
          if (name === 'openSync' && isArchive(args[0])) descriptors.add(result);
          return result;
        } finally {
          if (tracked) add(`io.${phase}.${name}`, now() - started);
          if (name === 'closeSync') descriptors.delete(args[0]);
        }
      };
      undo.push(() => { fs[name] = original; });
    }
    for (const name of ['appendFile', 'copyFile', 'mkdir', 'readFile', 'readdir', 'rename', 'rm', 'stat', 'writeFile']) {
      const original = fs.promises[name];
      fs.promises[name] = async function (...args) {
        if (!enabled || !isArchive(args[0])) return original.apply(this, args);
        const started = now(), currentPhase = phase;
        try { return await original.apply(this, args); }
        finally { add(`io.${currentPhase}.${name}`, now() - started, name === 'appendFile' ? Buffer.byteLength(args[1]) : 0); }
      };
      undo.push(() => { fs.promises[name] = original; });
    }
    const stringify = JSON.stringify;
    JSON.stringify = function (...args) {
      if (!enabled) return stringify.apply(this, args);
      const started = now(), result = stringify.apply(this, args);
      add(`json.${phase}.stringify`, now() - started, result?.length ?? 0);
      return result;
    };
    undo.push(() => { JSON.stringify = stringify; });
    const clone = globalThis.structuredClone;
    globalThis.structuredClone = function (...args) {
      if (!enabled) return clone.apply(this, args);
      const started = now();
      try { return clone.apply(this, args); }
      finally { add(`clone.${phase}`, now() - started); }
    };
    undo.push(() => { globalThis.structuredClone = clone; });
    syncBuiltinESMExports();
  };
  return {
    async start() {
      if (mode === 'cpu' || mode === 'allocation') {
        session = new inspector.Session(); session.connect();
        if (mode === 'cpu') { await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 500 }); profilerStart = now(); await post('Profiler.start'); }
        else await post('HeapProfiler.startSampling', { samplingInterval: 32768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
      }
      if (mode === 'detail') installIO();
      observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) gc.push({ startTime: entry.startTime, duration: entry.duration, kind: entry.detail.kind }); });
      observer.observe({ entryTypes: ['gc'] });
      initialMemory = process.memoryUsage();
      windowStart = phaseStarted = now(); phaseCpu = process.cpuUsage(); enabled = true;
    },
    async stop() {
      windowEnd = now(); audit.phase('finished'); enabled = false;
      const finalMemory = process.memoryUsage();
      const profile = mode === 'cpu' ? (await post('Profiler.stop')).profile
        : mode === 'allocation' ? (await post('HeapProfiler.stopSampling')).profile : null;
      if (profile) { fs.writeFileSync(process.env.BENCH_AUDIT_PROFILE, JSON.stringify(profile)); session.disconnect(); }
      await new Promise(resolve => setImmediate(resolve));
      observer.disconnect();
      const observedGc = gc.filter(entry => entry.startTime >= windowStart && entry.startTime <= windowEnd);
      for (const restore of undo.reverse()) restore(); syncBuiltinESMExports();
      return { mode, rows, windowStart, windowEnd, profilerStart, initialMemory, finalMemory, gc: observedGc, note: 'Nested rows are inclusive and must not be added. Allocation profiles sample bytes, not exact allocation counts.' };
    },
  };
}
