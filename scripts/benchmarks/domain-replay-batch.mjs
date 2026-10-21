// The real per-flush replay cost of `lib/domain-storage.js`, split into the two
// shapes `registration.js` produces: a steady pass with no new records (every
// agent step and every Evolution tool) and a backlog pass where the bridge holds
// records a previous step, another writer or a restarted process left behind.
//
// The fixture is the real official `DomainFacility` + `JsonStorageBackend` over
// signed, committed synthetic history, so the measurement includes reading and
// authenticating the log, the marker/conflict checks, the durable transaction
// (stage, fsyncs, the whole-document writes) and the reload - not fixture
// construction, startup or new-event signing.
//
// Two costs are reported per flush:
//   - wall and CPU time, and
//   - the syscalls that cost durability: fsync, whole-document writes
//     (`writeSync`/`writeFileSync`/`renameSync`), and reads.
// A time difference alone can hide behind the page cache; the syscall counts are
// what say whether the flush actually writes less.
//
// Usage:
//   node scripts/benchmarks/domain-replay-batch.mjs
//   BENCH_EVENTS=2000 BENCH_BACKLOG=1,2,5,10 BENCH_SAMPLES=9 node scripts/benchmarks/domain-replay-batch.mjs
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { openDomainStorage, evolutionDomainSpec } from '../../lib/domain-storage.js';
import { signEventBridgeEnvelope } from '../../lib/orchestrator.js';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';

const history = Math.max(0, Number(process.env.BENCH_EVENTS || 200));
const backlogSizes = String(process.env.BENCH_BACKLOG || '0,1,2,5,10')
  .split(',').map((value) => Math.max(0, Number(value) || 0));
const samples = Math.max(1, Number(process.env.BENCH_SAMPLES || 9));
const key = 'b'.repeat(64);

const COUNTERS = ['fsyncSync', 'fdatasyncSync', 'writeSync', 'writeFileSync', 'renameSync', 'readSync', 'readFileSync'];
/** Count the durability-relevant syscalls the port issues. */
function instrument() {
  const counts = {};
  const originals = new Map();
  for (const name of COUNTERS) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    originals.set(name, original);
    fs[name] = function (...args) { counts[name] = (counts[name] || 0) + 1; return original.apply(this, args); };
  }
  return {
    reset() { for (const name of Object.keys(counts)) delete counts[name]; },
    read() { return { ...counts }; },
    restore() { for (const [name, original] of originals) fs[name] = original; },
  };
}

function eventFor(sequence) {
  return { schema: 1, eventId: `evolution:measurement-completed:bench-experiment-${sequence}`, eventType: 'measurement-completed',
    experimentId: `bench-experiment-${sequence}`, proposalId: `bench-proposal-${sequence}`, target: 'plugin:bench',
    capability: 'plugin:bench', lineageId: 'plugin:bench', status: 'measured',
    measurement: { latency: 12, throughput: 100 }, evidence: { summary: 'Synthetic measured evolution event' },
    canary: {}, audit: { producer: 'dsh-evolution-orchestrator', at: '2026-10-07T00:00:00.000Z' } };
}

async function scenario({ root, backlog }) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const events = Math.max(history, 1);
  const file = path.join(root, 'execution-events.jsonl');
  const applied = {};
  const lines = [];
  for (let i = 0; i < events; i += 1) {
    const envelope = signEventBridgeEnvelope(eventFor(i), { key, sequence: i + 1 });
    applied[envelope.event.eventId] = envelope.mac;
    lines.push(JSON.stringify(envelope));
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = { emit() {}, on() { return () => {}; }, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const domain = await ctx.storageDomain.open(evolutionDomainSpec);
  await domain.global.set({ schema: 1, aggregate: {}, applied, pending: null });
  await domain.close();
  const port = await openDomainStorage(ctx, { presetDir: root, eventBridgePath: file, eventBridgeKey: key });
  try {
    for (let i = 0; i < 3; i += 1) assert.deepEqual(await port.flush(), { applied: 0, duplicates: events });
    const results = [];
    let sequence = events;
    for (let sample = 0; sample < samples; sample += 1) {
      for (let index = 0; index < backlog; index += 1) {
        sequence += 1;
        const envelope = signEventBridgeEnvelope(eventFor(sequence), { key, sequence });
        fs.appendFileSync(file, `${JSON.stringify(envelope)}\n`);
      }
      io.reset();
      const cpu = process.cpuUsage();
      const start = performance.now();
      const result = await port.flush();
      const elapsedMs = performance.now() - start;
      const used = process.cpuUsage(cpu);
      results.push({ elapsedMs, cpuMs: (used.user + used.system) / 1000, syscalls: io.read() });
      // Every scenario is self-checking: the pass must apply exactly the records
      // it was given and report the whole committed history as duplicates.
      assert.deepEqual(result, { applied: backlog, duplicates: events + backlog * sample });
    }
    const median = (select) => {
      const values = results.map(select).sort((a, b) => a - b);
      return values[Math.floor(values.length / 2)];
    };
    const syscallMedian = (name) => median((row) => row.syscalls[name] || 0);
    return { history: events, backlog, samples, bytes: fs.statSync(file).size,
      median: { elapsedMs: median((row) => row.elapsedMs), cpuMs: median((row) => row.cpuMs),
        ...Object.fromEntries(COUNTERS.map((name) => [name, syscallMedian(name)])) },
      results };
  } finally { await port.close(); await backend.close(); }
}

const io = instrument();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-replay-batch-'));
const report = { node: process.version, platform: `${process.platform}/${process.arch}`, history, backlogSizes, samples, scenarios: [] };
try {
  for (const backlog of backlogSizes) report.scenarios.push(await scenario({ root: path.join(root, `backlog-${backlog}`), backlog }));
} finally {
  io.restore();
  fs.rmSync(root, { recursive: true, force: true });
}
report.source = crypto.createHash('sha256').update(fs.readFileSync(new URL('../../lib/domain-storage.js', import.meta.url))).digest('hex');
console.log(JSON.stringify(report, null, 2));
