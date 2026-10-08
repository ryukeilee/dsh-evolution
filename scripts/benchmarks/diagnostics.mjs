// Full diagnostic A/B over synthetic data; no real DSH home is read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import inspector from 'node:inspector/promises';
import { collectDiagnostics, resolveEvolutionPaths } from '../../lib/diagnostics.js';
import { collectDiagnostics as baseline } from '../../test/fixtures/diagnostics.mjs';

const records = Number(process.env.BENCH_RECORDS || 2000);
const payloadBytes = Number(process.env.BENCH_PAYLOAD_BYTES || 16384);
const samples = Number(process.env.BENCH_SAMPLES || 9);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-benchmark-'));
const paths = resolveEvolutionPaths({ dshHome: home });
const options = { dshHome: home, probe: { skipComposition: true } };
const median = (values) => [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)];
const normalize = (report) => { delete report.generatedAt; return report; };
if (!global.gc) throw new Error('run with --expose-gc');
const session = new inspector.Session();
session.connect();
async function allocation(run) {
  global.gc();
  await session.post('HeapProfiler.startSampling', {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
  });
  for (let i = 0; i < 5; i += 1) await run(options);
  const { profile } = await session.post('HeapProfiler.stopSampling');
  return profile.samples.reduce((sum, sample) => sum + sample.size, 0) / 5;
}
try {
  fs.mkdirSync(paths.dockyardDir, { recursive: true });
  fs.writeFileSync(paths.keyPath, 'a'.repeat(64), { mode: 0o600 });
  const rows = Array.from({ length: records }, (_, id) => ({ id, payload: 'x'.repeat(payloadBytes) }));
  fs.writeFileSync(path.join(paths.dockyardDir, 'state.json'), JSON.stringify({ evolution: { schema: 4, observations: rows } }));
  fs.writeFileSync(path.join(paths.dockyardDir, 'state.json.observations.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  assert.deepEqual(normalize(await collectDiagnostics(options)), normalize(await baseline(options)));
  const results = [];
  for (let round = 0; round < 3; round += 1) {
    const result = {};
    for (const [name, run] of round % 2 ? [['candidate', collectDiagnostics], ['baseline', baseline]] : [['baseline', baseline], ['candidate', collectDiagnostics]]) {
      for (let warm = 0; warm < 3; warm += 1) await run(options);
      const measured = [];
      for (let sample = 0; sample < samples; sample += 1) {
        global.gc?.();
        const heap = process.memoryUsage().heapUsed;
        const cpu = process.cpuUsage();
        const start = performance.now();
        await run(options);
        const elapsedMs = performance.now() - start;
        const used = process.cpuUsage(cpu);
        measured.push({ cpuMs: (used.user + used.system) / 1000, elapsedMs, heapDeltaBytes: process.memoryUsage().heapUsed - heap });
      }
      result[name] = { samples: measured, median: Object.fromEntries(Object.keys(measured[0]).map((key) => [key, median(measured.map((sample) => sample[key]))])) };
    }
    results.push(result);
  }
  // Allocation profiling is separate from CPU timing, and includes GC'd objects.
  const allocations = [];
  for (let round = 0; round < 3; round += 1) {
    const result = {};
    for (const [name, run] of round % 2 ? [['candidate', collectDiagnostics], ['baseline', baseline]] : [['baseline', baseline], ['candidate', collectDiagnostics]]) {
      result[name] = await allocation(run);
    }
    allocations.push(result);
  }
  console.log(JSON.stringify({ baselineCommit: '8e6bd29', node: process.version, platform: `${process.platform}/${process.arch}`, records, payloadBytes, samples, equality: true, allocation: 'V8 sampled bytes/call including collected objects, 32768-byte interval, 5 calls', allocations, results }, null, 2));
} finally { session.disconnect(); fs.rmSync(home, { recursive: true, force: true }); }
