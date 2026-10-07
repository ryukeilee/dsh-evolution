// Reproducible official-domain bounded query workload; all data is temporary.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { openDomainStorage } from '../../lib/domain-storage.js';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';

const segments = Number(process.env.BENCH_RECORDS || 2000);
const payloadBytes = Number(process.env.BENCH_PAYLOAD_BYTES || 16384);
const samples = Number(process.env.BENCH_SAMPLES || 15);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-query-bench-'));
const archiveRoot = path.join(root, 'dockyard');
const archive = 'state.json.cycles-archive.jsonl';
fs.mkdirSync(archiveRoot, { recursive: true });
let archiveRaw = '';
for (let i = 0; i < segments; i++) {
  const raw = JSON.stringify({ id: `cycle-${i}`, status: 'observed', recordedAt: '2026-08-26T12:00:00.000Z', summary: 'x'.repeat(payloadBytes) }) + '\n';
  archiveRaw += raw;
}
fs.writeFileSync(path.join(archiveRoot, archive), archiveRaw, { mode: 0o600 });
archiveRaw = null;
const backend = new JsonStorageBackend(path.join(root, 'official'));
const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
let enumerations = 0;
const original = fs.readdirSync;
fs.readdirSync = function (...args) { enumerations++; return original.apply(this, args); };
syncBuiltinESMExports();
let port;
try {
  port = await openDomainStorage(ctx, { presetDir: root, eventBridgePath: path.join(root, 'events.jsonl'), eventBridgeKey: 'b'.repeat(64) });
  for (let i = 0; i < 3; i++) port.query('cycles', 10); // warm up
  const results = [];
  for (let i = 0; i < samples; i++) {
    enumerations = 0;
    const cpu = process.cpuUsage();
    const start = performance.now();
    const result = port.query('cycles', 10);
    const elapsedMs = performance.now() - start;
    const used = process.cpuUsage(cpu);
    assert.equal(result.count, segments);
    assert.deepEqual(result.entries.map(row => row.id), Array.from({ length: Math.min(10, segments) }, (_, j) => `cycle-${Math.max(0, segments - 10) + j}`));
    assert.ok(!JSON.stringify(result).includes('summary'));
    results.push({ elapsedMs, cpuMs: (used.user + used.system) / 1000, directoryEnumerations: enumerations });
  }
  assert.equal(port.query('cycles').count, segments);
  await port.close(); port = null;
  port = await openDomainStorage(ctx, { presetDir: root, eventBridgePath: path.join(root, 'events.jsonl'), eventBridgeKey: 'b'.repeat(64) });
  assert.equal(port.query('cycles').count, segments);
  const median = key => results.map(row => row[key]).sort((a, b) => a - b)[Math.floor(results.length / 2)];
  console.log(JSON.stringify({ node: process.version, platform: `${process.platform}/${process.arch}`, records: segments, payloadBytes, samples, median: { elapsedMs: median('elapsedMs'), cpuMs: median('cpuMs'), directoryEnumerations: median('directoryEnumerations') }, results }, null, 2));
} finally {
  fs.readdirSync = original;
  syncBuiltinESMExports();
  if (port) await port.close();
  await backend.close();
  fs.rmSync(root, { recursive: true, force: true });
}
