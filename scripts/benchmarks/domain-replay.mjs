// The real per-agent-step flush path, using signed, already committed history.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { openDomainStorage, evolutionDomainSpec } from '../../lib/domain-storage.js';
import { signEventBridgeEnvelope } from '../../lib/orchestrator.js';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';

const events = Number(process.env.BENCH_EVENTS || 10000);
const samples = Number(process.env.BENCH_SAMPLES || 15);
// Optional bounded tail: after the history is absorbed, each sample appends
// this many freshly signed events and measures one flush over
// "history + tail". The same script and parameters are used on both sides.
const newEvents = Math.max(0, Number(process.env.BENCH_NEW_EVENTS || 0));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-replay-bench-'));
const key = 'b'.repeat(64);
const file = path.join(root, 'events.jsonl');
const applied = {};
const lines = [];
for (let i = 0; i < events; i++) {
  const event = { schema: 1, eventId: `event-${i}`, eventType: 'measurement-completed',
    experimentId: `experiment-${i}`, proposalId: `proposal-${i}`, target: 'plugin:bench',
    status: 'measured', measurement: { latency: 12, throughput: 100 },
    evidence: { summary: 'Synthetic measured evolution event' }, canary: {},
    audit: { producer: 'dsh-evolution-orchestrator', at: '2026-10-07T00:00:00.000Z' } };
  const envelope = signEventBridgeEnvelope(event, { key, sequence: i + 1 });
  applied[event.eventId] = envelope.mac;
  lines.push(JSON.stringify(envelope));
}
fs.writeFileSync(file, lines.join('\n') + '\n');
const backend = new JsonStorageBackend(path.join(root, 'official'));
const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
const traceAuth = process.env.BENCH_TRACE_AUTH === '1';
let hmacCalls = 0, parseCalls = 0;
const originalHmac = crypto.createHmac, originalParse = JSON.parse;
if (traceAuth) {
  crypto.createHmac = function (...args) { hmacCalls++; return originalHmac.apply(this, args); };
  JSON.parse = function (...args) { parseCalls++; return originalParse.apply(this, args); };
  syncBuiltinESMExports();
}
let port;
try {
  // Seed only the durable dedup markers; fixture construction is not timed.
  const domain = await ctx.storageDomain.open(evolutionDomainSpec);
  await domain.global.set({ schema: 1, aggregate: {}, applied, pending: null });
  await domain.close();
  const config = { presetDir: root, eventBridgePath: file, eventBridgeKey: key };
  port = await openDomainStorage(ctx, config);
  for (let i = 0; i < 3; i++) assert.deepEqual(await port.flush(), { applied: 0, duplicates: events });
  const results = [];
  let sequence = events;
  for (let i = 0; i < samples; i++) {
    for (let index = 0; index < newEvents; index++) {
      sequence += 1;
      const event = { schema: 1, eventId: `evolution:measurement-completed:tail-experiment-${sequence}`,
        eventType: 'measurement-completed', experimentId: `tail-experiment-${sequence}`,
        proposalId: `tail-proposal-${sequence}`, target: 'plugin:bench',
        status: 'measured', measurement: { latency: 12, throughput: 100 }, evidence: { summary: 'Synthetic tail event' },
        canary: {}, audit: { producer: 'dsh-evolution-orchestrator', at: '2026-10-07T00:00:00.000Z' } };
      const envelope = signEventBridgeEnvelope(event, { key, sequence });
      fs.appendFileSync(file, `${JSON.stringify(envelope)}\n`);
    }
    hmacCalls = 0; parseCalls = 0;
    const cpu = process.cpuUsage();
    const start = performance.now();
    const result = await port.flush();
    const elapsedMs = performance.now() - start;
    const used = process.cpuUsage(cpu);
    assert.deepEqual(result, { applied: newEvents, duplicates: events + newEvents * i });
    results.push({ elapsedMs, cpuMs: (used.user + used.system) / 1000, ...(traceAuth ? { hmacCalls, parseCalls } : {}) });
  }
  await port.close(); port = null;
  port = await openDomainStorage(ctx, config);
  assert.deepEqual(await port.flush(), { applied: 0, duplicates: events + newEvents * samples });
  const median = key => results.map(row => row[key]).sort((a, b) => a - b)[Math.floor(results.length / 2)];
  console.log(JSON.stringify({ node: process.version, platform: `${process.platform}/${process.arch}`,
    events, newEvents, samples, bytes: fs.statSync(file).size,
    median: { elapsedMs: median('elapsedMs'), cpuMs: median('cpuMs') }, results }, null, 2));
} finally {
  crypto.createHmac = originalHmac; JSON.parse = originalParse; syncBuiltinESMExports();
  if (port) await port.close();
  await backend.close();
  fs.rmSync(root, { recursive: true, force: true });
}
