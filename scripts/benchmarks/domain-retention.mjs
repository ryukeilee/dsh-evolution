// Semantic-GC retention planning cost at several canonical-table sizes.
//
// The retirement decision asks, for every terminal record, whether a canonical
// entry references it. The baseline rescanned the whole canonical table per
// record; this script drives the real `compact({ dryRun: true })` entry point so
// both sides can be measured with the same command from their own checkout:
//
//   node --expose-gc scripts/benchmarks/domain-retention.mjs
//
// A baseline checkout is produced with `git archive <commit> | tar -x -C <dir>`
// plus a `node_modules` symlink and a copy of this script, exactly like
// `domain-replay.md` documents. The benchmark asserts the retirement outcome on
// every size, so a faster plan that retires different records fails here.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { EvolutionMemory } from '../../lib/dockyard-domain/memory.js';

if (!global.gc) throw new Error('run with --expose-gc');
const records = Number(process.env.BENCH_RECORDS || 1000);
const canonicalSizes = (process.env.BENCH_CANONICAL || '0,1000,3000').split(',').map(Number);
const samples = Number(process.env.BENCH_SAMPLES || 7);
const at = '2026-10-07T00:00:00.000Z';

function memoryFor() {
  // A non-durable state port keeps the benchmark on the planning path; the
  // archive rewrite is measured by the archive benchmarks instead.
  const store = { filePath: '/dev/null', load: async () => null, update: async () => {} };
  return new EvolutionMemory({
    stateStore: store, maxEntries: 1_000_000, hotEntries: 1_000_000, hotCycles: 1_000_000,
    mutationAuthority: { assertMutation() {} },
  });
}

const outcomes = Array.from({ length: records }, (_, i) => ({
  id: `outcome-${i}`, signature: `sig-${i}`, rootCause: `synthetic-${i}`, status: 'failed',
  recordedAt: at, lastSeenAt: at,
}));

const results = [];
for (const canonicalSize of canonicalSizes) {
  const canonical = Array.from({ length: canonicalSize }, (_, i) => ({
    id: `canonical-${i}`, state: 'CANONICAL', lifecycleState: 'CANONICAL', capability: `capability-${i}`,
    recordId: `canonical-record-${i}`, fitnessScore: 1, updatedAt: at,
  }));
  const memory = memoryFor();
  await memory.load();
  await memory.restore({ ...memory.fullSnapshot(), outcomes, canonical }, { persist: false });
  const plan = await memory.compact({ dryRun: true });
  assert.equal(plan.retired, records, 'every terminal record without a canonical reference is retired');
  assert.equal(plan.retainedCanonical, canonicalSize);
  const times = [];
  for (let i = 0; i < samples; i++) {
    global.gc();
    const start = performance.now();
    const report = await memory.compact({ dryRun: true });
    times.push(performance.now() - start);
    assert.equal(report.retired, records);
  }
  times.sort((a, b) => a - b);
  results.push({ records, canonicalSize, samples, medianMs: times[Math.floor(times.length / 2)], all: times });
}
console.log(JSON.stringify({ node: process.version, platform: `${process.platform}/${process.arch}`, results }, null, 2));
