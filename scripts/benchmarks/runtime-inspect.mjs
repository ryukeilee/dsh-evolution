// Run with: node --expose-gc scripts/benchmarks/runtime-inspect.mjs
// CPU and allocation sampling are separate to avoid profiler timing bias.
import assert from 'node:assert/strict';
import inspector from 'node:inspector/promises';
import { EvolutionOrchestrator, toLosslessJson } from '../../lib/orchestrator.js';
import { apply } from '../../lib/registration.js';
import { context, config, legacyInspect, populate } from '../../test/fixtures/runtime-inspect.mjs';

if (!global.gc) throw new Error('run with --expose-gc');
const agent = { id: 'benchmark-agent' };
const core = new EvolutionOrchestrator(context(), config);
const registeredContext = context();
const registeredCore = apply(registeredContext, config);
const registeredInspect = registeredContext.definitions.get('evolution_runtime_inspect');
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
  for (const candidates of [0, 100, 1000]) {
    populate(core, candidates);
    populate(registeredCore, candidates);
    for (const [path, before, after] of [
      ['inspect', () => legacyInspect(core, agent), () => core.inspect(agent)],
      ['registered-inspect', async () => toLosslessJson(legacyInspect(registeredCore, agent)),
        () => registeredInspect.execute({}, { agent })],
    ]) {
      assert.deepEqual(await after(), await before());
      const iterations = candidates === 1000 ? 500 : 1500;
      for (let i = 0; i < 200; i++) { await before(); await after(); }
      const oldCpu = [], newCpu = [];
      for (let round = 0; round < 3; round++) {
        // Alternate order to reduce temperature and JIT bias.
        if (round % 2) { newCpu.push(await cpu(after, iterations)); oldCpu.push(await cpu(before, iterations)); }
        else { oldCpu.push(await cpu(before, iterations)); newCpu.push(await cpu(after, iterations)); }
      }
      const beforeBytes = await allocation(before, 300);
      const afterBytes = await allocation(after, 300);
      const beforeCpu = median(oldCpu), afterCpu = median(newCpu);
      results.push({ path, observations: 20, candidates, iterations,
        beforeCpuUs: beforeCpu, afterCpuUs: afterCpu, cpuReduction: 1 - afterCpu / beforeCpu,
        beforeAllocatedBytes: beforeBytes, afterAllocatedBytes: afterBytes,
        allocationReduction: 1 - afterBytes / beforeBytes });
    }
  }
  console.log(JSON.stringify({ node: process.version, platform: `${process.platform}-${process.arch}`,
    cpu: 'median of 3 process.cpuUsage runs, microseconds/call',
    allocation: 'V8 sampled bytes/call including collected objects, 1024-byte interval', results }, null, 2));
} finally { session.disconnect(); }
assert.ok(sink);
