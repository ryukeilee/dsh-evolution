// Authentication workload through the real per-agent-step flush path.
// No user data: nested evidence models retained metric/recovery samples.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { openDomainStorage, evolutionDomainSpec } from '../../lib/domain-storage.js';
import { signEventBridgeEnvelope } from '../../lib/orchestrator.js';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';

const events = Number(process.env.BENCH_EVENTS || 10000);
const evidenceRows = Number(process.env.BENCH_EVIDENCE_ROWS || 0);
const samples = Number(process.env.BENCH_SAMPLES || 15);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-replay-bench-'));
const key = 'b'.repeat(64);
const file = path.join(root, 'events.jsonl');
const applied = {};
const lines = [];
for (let i = 0; i < events; i++) {
  const event = { schema: 1, eventId: `event-${i}`, eventType: 'measurement-completed',
    experimentId: `experiment-${i}`, proposalId: `proposal-${i}`, target: 'plugin:bench',
    status: 'measured', measurement: { latency: 12, throughput: 100 },
    evidence: { summary: 'Synthetic measured evolution event', ...(evidenceRows ? { samples: Array.from({ length: evidenceRows }, (_, j) => ({ component: `component-${j}`, before: { latency: 20, throughput: 80 }, after: { latency: 12, throughput: 100 }, recovery: { verified: true, stages: ['trial', 'dispose', 'baseline'] } })) } : {}) }, canary: {},
    audit: { producer: 'dsh-evolution-orchestrator', at: '2026-10-07T00:00:00.000Z' } };
  const envelope = signEventBridgeEnvelope(event, { key, sequence: i + 1 });
  applied[event.eventId] = envelope.mac;
  lines.push(JSON.stringify(envelope));
}
fs.writeFileSync(file, lines.join('\n') + '\n');
const backend = new JsonStorageBackend(path.join(root, 'official'));
const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
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
  for (let i = 0; i < samples; i++) {
    const cpu = process.cpuUsage();
    const start = performance.now();
    const result = await port.flush();
    const elapsedMs = performance.now() - start;
    const used = process.cpuUsage(cpu);
    assert.deepEqual(result, { applied: 0, duplicates: events });
    results.push({ elapsedMs, cpuMs: (used.user + used.system) / 1000 });
  }
  await port.close(); port = null;
  port = await openDomainStorage(ctx, config);
  assert.deepEqual(await port.flush(), { applied: 0, duplicates: events });
  const median = key => results.map(row => row[key]).sort((a, b) => a - b)[Math.floor(results.length / 2)];
  console.log(JSON.stringify({ node: process.version, platform: `${process.platform}/${process.arch}`,
    events, evidenceRows, samples, bytes: fs.statSync(file).size,
    median: { elapsedMs: median('elapsedMs'), cpuMs: median('cpuMs') }, results }, null, 2));
} finally {
  if (port) await port.close();
  await backend.close();
  fs.rmSync(root, { recursive: true, force: true });
}
