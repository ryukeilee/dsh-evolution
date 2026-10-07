// Reproducible official-domain observation workload; all data is temporary.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { openDomainStorage } from '../../lib/domain-storage.js';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';

const segments = Number(process.env.BENCH_SEGMENTS || 256);
const samples = Number(process.env.BENCH_SAMPLES || 7);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-archive-bench-'));
const archiveRoot = path.join(root, 'dockyard');
const archive = 'state.json.cycles-archive.jsonl';
const directory = path.join(archiveRoot, archive + '.segments');
fs.mkdirSync(directory, { recursive: true });
const index = [];
for (let i = 0; i < segments; i++) {
  const file = `segment-${String(i + 1).padStart(12, '0')}.jsonl`;
  const raw = JSON.stringify({ id: `cycle-${i}`, status: 'observed', recordedAt: '2026-08-26T12:00:00.000Z', summary: 'x'.repeat(1024) }) + '\n';
  fs.writeFileSync(path.join(directory, file), raw, { mode: 0o600 });
  index.push({ collection: 'cycles', file, sealed: true, checksumState: 'final', byteSize: Buffer.byteLength(raw), sha256: createHash('sha256').update(raw).digest('hex') });
}
fs.writeFileSync(path.join(archiveRoot, 'state.json.evolution-archive-index.json'), JSON.stringify({ schemaVersion: 1, segments: index }));
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
  await port.observe({ code: 'BENCH_ERROR', target: 'tool:bench' }); // warm up
  const results = [];
  for (let i = 0; i < samples; i++) {
    enumerations = 0;
    const cpu = process.cpuUsage();
    const start = performance.now();
    await port.observe({ code: 'BENCH_ERROR', target: 'tool:bench' });
    const elapsedMs = performance.now() - start;
    const used = process.cpuUsage(cpu);
    results.push({ elapsedMs, cpuMs: (used.user + used.system) / 1000, directoryEnumerations: enumerations });
  }
  assert.equal(port.query('cycles').count, segments);
  assert.ok(port.query('observations').count > 0);
  await port.close(); port = null;
  port = await openDomainStorage(ctx, { presetDir: root, eventBridgePath: path.join(root, 'events.jsonl'), eventBridgeKey: 'b'.repeat(64) });
  assert.equal(port.query('cycles').count, segments);
  assert.ok(port.query('observations').count > 0);
  const median = key => results.map(row => row[key]).sort((a, b) => a - b)[Math.floor(results.length / 2)];
  console.log(JSON.stringify({ node: process.version, platform: `${process.platform}/${process.arch}`, segments, samples, median: { elapsedMs: median('elapsedMs'), cpuMs: median('cpuMs'), directoryEnumerations: median('directoryEnumerations') }, results }, null, 2));
} finally {
  fs.readdirSync = original;
  syncBuiltinESMExports();
  if (port) await port.close();
  await backend.close();
  fs.rmSync(root, { recursive: true, force: true });
}
