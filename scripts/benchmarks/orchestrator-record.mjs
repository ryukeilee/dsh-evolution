// Failure-memory recording cost.
//
// `record()` trims the retained entries and returns the stored entry; the
// baseline also cloned the complete record set for a snapshot nobody read. This
// script measures the real public entry point on a warm 200-entry memory:
//
//   node --expose-gc scripts/benchmarks/orchestrator-record.mjs
//
// The A/B recipe (baseline checkout + this same script) is documented in
// `docs/performance/redundant-work.md`. Both sides assert the same retained
// contents, so a faster `record()` that drops or reorders entries fails here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { EvolutionMemory } from '../../lib/orchestrator.js';

if (!global.gc) throw new Error('run with --expose-gc');
const entries = Number(process.env.BENCH_ENTRIES || 200);
const samples = Number(process.env.BENCH_SAMPLES || 41);
const payload = 'x'.repeat(Number(process.env.BENCH_PAYLOAD_BYTES || 900));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-record-bench-'));
const file = path.join(root, 'evolution-memory.json');
const memory = new EvolutionMemory({ file, maxEntries: entries });
const entryFor = (i) => ({
  problem: `problem-${i}-${payload.slice(0, 200)}`,
  evidence: { note: payload },
  experiment: { id: `experiment-${i}`, target: payload.slice(0, 100) },
  result: { category: 'rejected', detail: payload.slice(0, 200) },
  prevention: `prevention-${i}`,
  at: `2026-10-07T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
});

function median(fn, iterations) {
  const times = [];
  for (let i = 0; i < iterations; i++) {
    global.gc();
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { medianMs: times[Math.floor(times.length / 2)], all: times };
}

try {
  for (let i = 0; i < entries; i++) memory.record(entryFor(i));
  assert.equal(memory.snapshot().entries.length, entries);
  const snapshot = median(() => memory.snapshot(), samples);
  const duplicate = median(() => memory.record({ ...entryFor(0), at: '2026-10-08T00:00:00.000Z' }), samples);
  assert.equal(memory.snapshot().entries.length, entries, 'recording keeps the memory bounded');
  const unique = median(() => memory.record({ problem: `unique-${Math.random()}`, at: '2026-10-08T00:00:01.000Z' }), samples);
  assert.equal(memory.snapshot().entries.length, entries);
  console.log(JSON.stringify({
    node: process.version, platform: `${process.platform}/${process.arch}`,
    entries, payloadBytes: payload.length, samples,
    snapshot, duplicateRecord: duplicate, uniqueRecord: unique,
  }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
