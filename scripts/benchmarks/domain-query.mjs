// Reproducible official-domain bounded query workload; all data is temporary.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { openDomainStorage } from '../../lib/domain-storage.js';
import { EvolutionMemory } from '../../lib/dockyard-domain/memory.js';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';

const segments = Number(process.env.BENCH_RECORDS || 2000);
const payloadBytes = Number(process.env.BENCH_PAYLOAD_BYTES || 16384);
const samples = Number(process.env.BENCH_SAMPLES || 15);
const limit = Number(process.env.BENCH_LIMIT || 10);
const legacyWindow = process.env.BENCH_LEGACY_WINDOW === '1';
// Reproduce the previous domain path: clone full window records, then project.
const originalWindow = EvolutionMemory.prototype.historyWindow;
if (legacyWindow) EvolutionMemory.prototype.historyWindow = function (collection, size) {
  return originalWindow.call(this, collection, size);
};
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
  const expectedSize = Math.min(50, Math.max(1, limit || 10), segments);
  for (let i = 0; i < 3; i++) port.query('cycles', limit); // warm up
  const results = [];
  for (let i = 0; i < samples; i++) {
    enumerations = 0;
    globalThis.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    const cpu = process.cpuUsage();
    const start = performance.now();
    const result = port.query('cycles', limit);
    const elapsedMs = performance.now() - start;
    const used = process.cpuUsage(cpu);
    const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
    assert.equal(result.count, segments);
    assert.deepEqual(result.entries.map(row => row.id), Array.from({ length: expectedSize }, (_, j) => `cycle-${segments - expectedSize + j}`));
    assert.ok(!JSON.stringify(result).includes('summary'));
    results.push({ elapsedMs, cpuMs: (used.user + used.system) / 1000, heapDeltaBytes, directoryEnumerations: enumerations });
  }
  // Outside timing: quantify bytes sent to deep clone, not a peak-heap estimate.
  let clonedJsonBytes = 0, cloneCalls = 0;
  const originalClone = globalThis.structuredClone;
  try {
    globalThis.structuredClone = value => {
      clonedJsonBytes += Buffer.byteLength(JSON.stringify(value));
      cloneCalls++;
      return originalClone(value);
    };
    port.query('cycles', limit);
  } finally { globalThis.structuredClone = originalClone; }
  assert.equal(port.query('cycles').count, segments);
  await port.close(); port = null;
  port = await openDomainStorage(ctx, { presetDir: root, eventBridgePath: path.join(root, 'events.jsonl'), eventBridgeKey: 'b'.repeat(64) });
  assert.equal(port.query('cycles').count, segments);
  const median = key => results.map(row => row[key]).sort((a, b) => a - b)[Math.floor(results.length / 2)];
  console.log(JSON.stringify({ node: process.version, platform: `${process.platform}/${process.arch}`, records: segments, payloadBytes, samples, limit, legacyWindow, explicitGc: Boolean(globalThis.gc), cloneCalls, clonedJsonBytes, median: { elapsedMs: median('elapsedMs'), cpuMs: median('cpuMs'), heapDeltaBytes: median('heapDeltaBytes'), directoryEnumerations: median('directoryEnumerations') }, results }, null, 2));
} finally {
  EvolutionMemory.prototype.historyWindow = originalWindow;
  fs.readdirSync = original;
  syncBuiltinESMExports();
  if (port) await port.close();
  await backend.close();
  fs.rmSync(root, { recursive: true, force: true });
}
