// Run with node --expose-gc scripts/benchmarks/runtime-signature.mjs
import assert from 'node:assert/strict';
import inspector from 'node:inspector/promises';
import { runtimeSignature, signatureEqual } from '../../lib/orchestrator.js';
import { legacyRuntimeSignature, legacySignatureEqual, signatureFixture } from '../../test/fixtures/runtime-signature.mjs';
if (!global.gc) throw new Error('run with --expose-gc');
const session = new inspector.Session(); session.connect();
let sink;
async function cpu(fn, iterations) {
  global.gc();
  const start = process.cpuUsage();
  for (let i = 0; i < iterations; i++) sink = await fn();
  const elapsed = process.cpuUsage(start);
  return (elapsed.user + elapsed.system) / iterations;
}
async function allocation(fn, iterations) {
  global.gc();
  await session.post('HeapProfiler.startSampling', {
    samplingInterval: 1024,
    includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
  });
  for (let i = 0; i < iterations; i++) sink = await fn();
  const { profile } = await session.post('HeapProfiler.stopSampling');
  return profile.samples.reduce((sum, sample) => sum + sample.size, 0) / iterations;
}
function median(values) { return values.sort((a, b) => a - b)[Math.floor(values.length / 2)]; }
const results = [];
try {
  for (const count of [20, 100, 1000]) {
    const runtime = signatureFixture(count);
    const restored = structuredClone(runtime);
    restored.components.reverse(); restored.services.reverse();
    for (const [path, before, after] of [
      ['runtimeSignature', () => legacyRuntimeSignature(runtime), () => runtimeSignature(runtime)],
      ['signatureEqual', () => legacySignatureEqual(runtime, restored), () => signatureEqual(runtime, restored)],
    ]) {
      assert.deepEqual(after(), before());
      const iterations = count === 1000 ? 100 : 400;
      for (let i = 0; i < 100; i++) { before(); after(); }
      const oldCpu = [], newCpu = [];
      for (let round = 0; round < 3; round++) {
        if (round % 2) { newCpu.push(await cpu(after, iterations)); oldCpu.push(await cpu(before, iterations)); }
        else { oldCpu.push(await cpu(before, iterations)); newCpu.push(await cpu(after, iterations)); }
      }
      const beforeBytes = await allocation(before, 100);
      const afterBytes = await allocation(after, 100);
      const beforeCpu = median(oldCpu), afterCpu = median(newCpu);
      results.push({ path, count, iterations, oldCpu, newCpu,
        beforeCpuUs: beforeCpu, afterCpuUs: afterCpu, cpuReduction: 1 - afterCpu / beforeCpu,
        beforeAllocatedBytes: beforeBytes, afterAllocatedBytes: afterBytes,
        allocationReduction: 1 - afterBytes / beforeBytes });
    }
  }
  console.log(JSON.stringify({ node: process.version, platform: `${process.platform}-${process.arch}`,
    cpu: 'median of 3 alternating process.cpuUsage runs, microseconds/call',
    allocation: 'V8 sampled bytes/call including collected objects, 1024-byte interval', results }, null, 2));
} finally { session.disconnect(); }
assert.ok(sink);
