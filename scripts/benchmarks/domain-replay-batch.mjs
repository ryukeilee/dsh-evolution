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
//   BENCH_MIX=mixed BENCH_BACKLOG=5,10,25 node scripts/benchmarks/domain-replay-batch.mjs
//
// BENCH_MIX (`measurement` by default) selects the record shapes a backlog slot
// carries: `measurement` appends one `measurement-completed` record per slot,
// `mixed` cycles the three shapes the orchestrator emits - a `measurement-completed`,
// an `experiment-rejected` + `failure-learned` pair for one experiment, and a
// `canary-passed` promotion - so a slot is 1, 2 or 1 record and the saves per
// flush follow the real event mix. Every scenario self-checks the applied and
// duplicate counts, so a different mix cannot silently measure a broken pass.
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
// The bridge does not emit one shape: a rejected experiment emits a pair, a
// promotion emits a whole chain. Saves per record differ with it (2 for a
// completed measurement, 3 for each record of a rejection pair, 5-6 for a
// promotion), so a backlog of k records costs very different JSON work per
// shape. `mixed` cycles the three shapes the orchestrator actually emits.
const mix = String(process.env.BENCH_MIX || 'measurement');
const key = 'b'.repeat(64);

const COUNTERS = ['fsyncSync', 'fdatasyncSync', 'writeSync', 'writeFileSync', 'renameSync', 'readSync', 'readFileSync'];
// JSON work is the other thing a flush pays for: every whole-document
// projection is a stringify plus a parse, and the parse is what builds (and
// usually discards) the deep copy. Counting both, with the characters they
// handled, says whether a flush re-parsed documents it never reads - a number
// that does not depend on the page cache or the CPU.
const JSON_COUNTERS = ['parseCalls', 'parseChars', 'stringifyCalls', 'stringifyChars'];
/** Count the durability-relevant syscalls and the JSON work the port issues. */
function instrument() {
  const counts = {};
  const originals = new Map();
  for (const name of COUNTERS) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    originals.set(name, original);
    fs[name] = function (...args) { counts[name] = (counts[name] || 0) + 1; return original.apply(this, args); };
  }
  // `JSON.parse`/`JSON.stringify` are called as properties of the global `JSON`
  // by every module involved, so replacing them here counts what this process
  // actually did during the measured flush, including the official backend.
  const jsonOriginals = { parse: JSON.parse, stringify: JSON.stringify };
  JSON.parse = function (text, ...rest) {
    counts.parseCalls = (counts.parseCalls || 0) + 1;
    counts.parseChars = (counts.parseChars || 0) + String(text).length;
    return jsonOriginals.parse.call(this, text, ...rest);
  };
  JSON.stringify = function (...args) {
    const text = jsonOriginals.stringify.apply(this, args);
    counts.stringifyCalls = (counts.stringifyCalls || 0) + 1;
    counts.stringifyChars = (counts.stringifyChars || 0) + (typeof text === 'string' ? text.length : 0);
    return text;
  };
  return {
    reset() { for (const name of Object.keys(counts)) delete counts[name]; },
    read() { return { ...counts }; },
    restore() {
      for (const [name, original] of originals) fs[name] = original;
      JSON.parse = jsonOriginals.parse;
      JSON.stringify = jsonOriginals.stringify;
    },
  };
}

function eventFor(sequence) {
  return { schema: 1, eventId: `evolution:measurement-completed:bench-experiment-${sequence}`, eventType: 'measurement-completed',
    experimentId: `bench-experiment-${sequence}`, proposalId: `bench-proposal-${sequence}`, target: 'plugin:bench',
    capability: 'plugin:bench', lineageId: 'plugin:bench', status: 'measured',
    measurement: { latency: 12, throughput: 100 }, evidence: { summary: 'Synthetic measured evolution event' },
    canary: {}, audit: { producer: 'dsh-evolution-orchestrator', at: '2026-10-07T00:00:00.000Z' } };
}

/** The records one backlog slot carries for the selected mix. */
function recordsFor(sequence, shapes) {
  if (mix === 'measurement') return [eventFor(sequence)];
  if (mix === 'mixed') {
    const shape = shapes % 3;
    if (shape === 0) return [eventFor(sequence)];
    if (shape === 1) {
      const experimentId = `bench-reject-${sequence}`;
      return [
        { schema: 1, eventId: `evolution:experiment-rejected:${experimentId}`, eventType: 'experiment-rejected',
          experimentId, proposalId: `bench-proposal-${sequence}`, target: 'plugin:bench', capability: 'plugin:bench',
          lineageId: 'plugin:bench', status: 'rejected', failureFingerprint: `fingerprint:${experimentId}`,
          failure: { code: 'EVOLUTION_OPERATION_FAILED' }, canary: {},
          audit: { producer: 'dsh-evolution-orchestrator', at: '2026-10-07T00:00:00.000Z' } },
        { schema: 1, eventId: `evolution:failure-learned:${experimentId}`, eventType: 'failure-learned',
          experimentId, proposalId: `bench-proposal-${sequence}`, target: 'plugin:bench', capability: 'plugin:bench',
          lineageId: 'plugin:bench', status: 'measured', failureFingerprint: `fingerprint:${experimentId}`,
          failure: { code: 'EVOLUTION_OPERATION_FAILED' }, canary: {},
          audit: { producer: 'dsh-evolution-orchestrator', at: '2026-10-07T00:00:00.000Z' } },
      ];
    }
    return [{ schema: 1, eventId: `evolution:canary-passed:bench-canary-${sequence}`, eventType: 'canary-passed',
      experimentId: `bench-canary-${sequence}`, proposalId: `bench-proposal-${sequence}`, target: 'plugin:bench',
      capability: 'plugin:bench', lineageId: 'plugin:bench', status: 'stable',
      promotion: { id: `bench-promotion-${sequence}`, promotionId: `bench-promotion-${sequence}` },
      measurement: { latency: 12 }, evidence: { fitnessScore: 1 }, canary: {},
      audit: { producer: 'dsh-evolution-orchestrator', at: '2026-10-07T00:00:00.000Z' } }];
  }
  throw new Error(`unknown BENCH_MIX ${mix}`);
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
    let applied = 0;
    const results = [];
    let sequence = events;
    let shapes = 0;
    for (let sample = 0; sample < samples; sample += 1) {
      let appended = 0;
      for (let index = 0; index < backlog; index += 1) {
        for (const event of recordsFor(sequence + 1, shapes)) {
          sequence += 1;
          const envelope = signEventBridgeEnvelope(event, { key, sequence });
          fs.appendFileSync(file, `${JSON.stringify(envelope)}\n`);
          appended += 1;
        }
        shapes += 1;
      }
      io.reset();
      const cpu = process.cpuUsage();
      const start = performance.now();
      const result = await port.flush();
      const elapsedMs = performance.now() - start;
      const used = process.cpuUsage(cpu);
      results.push({ elapsedMs, cpuMs: (used.user + used.system) / 1000, syscalls: io.read(), records: appended });
      // Every scenario is self-checking: the pass must apply exactly the records
      // it was given and report the whole committed history as duplicates.
      applied += appended;
      assert.deepEqual(result, { applied: appended, duplicates: events + applied - appended });
    }
    const median = (select) => {
      const values = results.map(select).sort((a, b) => a - b);
      return values[Math.floor(values.length / 2)];
    };
    const syscallMedian = (name) => median((row) => row.syscalls[name] || 0);
    return { history: events, backlog, mix, samples, records: results.at(-1)?.records ?? 0, bytes: fs.statSync(file).size,
      median: { elapsedMs: median((row) => row.elapsedMs), cpuMs: median((row) => row.cpuMs),
        ...Object.fromEntries(COUNTERS.map((name) => [name, syscallMedian(name)])),
        ...Object.fromEntries(JSON_COUNTERS.map((name) => [name, median((row) => row.syscalls[name] || 0)])) },
      results };
  } finally { await port.close(); await backend.close(); }
}

const io = instrument();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-replay-batch-'));
const report = { node: process.version, platform: `${process.platform}/${process.arch}`, history, backlogSizes, samples, mix, scenarios: [] };
try {
  for (const backlog of backlogSizes) report.scenarios.push(await scenario({ root: path.join(root, `backlog-${backlog}`), backlog }));
} finally {
  io.restore();
  fs.rmSync(root, { recursive: true, force: true });
}
report.source = crypto.createHash('sha256').update(fs.readFileSync(new URL('../../lib/domain-storage.js', import.meta.url))).digest('hex');
console.log(JSON.stringify(report, null, 2));
