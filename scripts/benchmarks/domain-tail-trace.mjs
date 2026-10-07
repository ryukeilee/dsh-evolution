// Per-mutation I/O attribution for the event-bridge apply path.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { openDomainStorage, evolutionDomainSpec } from '../../lib/domain-storage.js';
import { signEventBridgeEnvelope } from '../../lib/orchestrator.js';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';

const events = Number(process.env.BENCH_EVENTS || 1000);
const newEvents = Number(process.env.BENCH_NEW_EVENTS || 100);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-tail-trace-'));
const key = 'b'.repeat(64);
const file = path.join(root, 'events.jsonl');
const applied = {};
const lines = [];
for (let i = 0; i < events; i++) {
  const event = { schema: 1, eventId: `event-${i}`, eventType: 'measurement-completed',
    experimentId: `experiment-${i}`, proposalId: `proposal-${i}`, target: 'plugin:bench', status: 'measured',
    measurement: { latency: 12, throughput: 100 }, evidence: { summary: 'history' }, canary: {},
    audit: { producer: 'dsh-evolution-orchestrator', at: '2026-10-07T00:00:00.000Z' } };
  const envelope = signEventBridgeEnvelope(event, { key, sequence: i + 1 });
  applied[event.eventId] = envelope.mac;
  lines.push(JSON.stringify(envelope));
}
let sequence = events;
const tail = [];
for (let i = 0; i < newEvents; i++) {
  sequence += 1;
  const event = { schema: 1, eventId: `evolution:measurement-completed:tail-${sequence}`,
    eventType: 'measurement-completed', experimentId: `tail-${sequence}`, proposalId: `tail-proposal-${sequence}`,
    target: 'plugin:bench', status: 'measured', measurement: { latency: 12, throughput: 100 },
    evidence: { summary: 'tail' }, canary: {}, audit: { producer: 'dsh-evolution-orchestrator', at: '2026-10-07T00:00:00.000Z' } };
  const envelope = signEventBridgeEnvelope(event, { key, sequence });
  tail.push(JSON.stringify(envelope));
}
fs.writeFileSync(file, lines.join('\n') + '\n');
const backend = new JsonStorageBackend(path.join(root, 'official'));
const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
const io = { cpSync: { calls: 0, elapsedMs: 0 }, fsyncSync: { calls: 0, elapsedMs: 0 }, linkSync: { calls: 0 }, lstatSync: { calls: 0 } };
const originals = new Map();
for (const name of ['cpSync', 'fsyncSync', 'linkSync', 'lstatSync']) {
  originals.set(name, fs[name]);
  fs[name] = function (...args) {
    const start = performance.now();
    try { return originals.get(name).apply(this, args); }
    finally { io[name].calls++; io[name].elapsedMs += performance.now() - start; }
  };
}
syncBuiltinESMExports();
let port;
try {
  const domain = await ctx.storageDomain.open(evolutionDomainSpec);
  await domain.global.set({ schema: 1, aggregate: {}, applied, pending: null });
  await domain.close();
  const config = { presetDir: root, eventBridgePath: file, eventBridgeKey: key };
  port = await openDomainStorage(ctx, config);
  // The port absorbs the seeded history while opening; only the tail is timed.
  fs.appendFileSync(file, `${tail.join('\n')}\n`);
  for (const name of originals.keys()) io[name] = { calls: 0, elapsedMs: 0 };
  const cpu = process.cpuUsage();
  const start = performance.now();
  const result = await port.flush();
  const elapsedMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  assert.deepEqual(result, { applied: newEvents, duplicates: events });
  console.log(JSON.stringify({ node: process.version, events, newEvents, elapsedMs, cpuMs: (used.user + used.system) / 1000,
    perMutationMs: elapsedMs / newEvents, io }, null, 2));
} finally {
  for (const [name, method] of originals) fs[name] = method;
  syncBuiltinESMExports();
  if (port) await port.close();
  await backend.close();
  fs.rmSync(root, { recursive: true, force: true });
}
