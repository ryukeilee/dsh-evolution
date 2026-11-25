// Worker for sensitive-key-memo.mjs. Runs one side's workload in a fresh
// process. All timing uses process.cpuUsage as the primary signal; wall and
// maxRSS are reported alongside. Never writes outside its temp data root.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const lib = process.env.R12_LIB;
const records = Number(process.env.R12_RECORDS || 20000);
const flushSamples = Number(process.env.R12_FLUSH || 9);
const observeSamples = Number(process.env.R12_OBSERVE || 9);
assert.ok(lib && fs.existsSync(lib), 'R12_LIB must point at a lib/ tree');

const { openDomainStorage } = await import(pathToFileURL(path.join(lib, 'domain-storage.js')).href);
const { signEventBridgeEnvelope } = await import(pathToFileURL(path.join(lib, 'orchestrator.js')).href);
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

const KEY = 'c'.repeat(64);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r12-skm-'));
const eventsFile = path.join(root, 'events.jsonl');
let fixtureHash;
{
  const crypto = await import('node:crypto');
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(eventsFile, 'w', 0o600);
  try {
    for (let seq = 1; seq <= records; seq += 1) {
      const event = {
        schema: 1,
        eventId: `evolution:measurement-completed:r12-${seq}`,
        eventType: 'measurement-completed',
        experimentId: `r12-${seq}`,
        proposalId: `proposal-r12-${seq}`,
        target: 'plugin:r12-skm',
        capability: 'plugin:r12-skm',
        lineageId: 'plugin:r12-skm',
        status: 'measured',
        measurement: { latency: 10 + seq % 101, throughput: 20 + seq % 53 },
        evidence: { testPassed: true },
        audit: { producer: 'dsh-evolution-orchestrator', at: '2026-10-27T00:00:00.000Z' },
      };
      const line = JSON.stringify(signEventBridgeEnvelope(event, { key: KEY, sequence: seq })) + '\n';
      hash.update(line);
      fs.writeSync(fd, line);
    }
  } finally { fs.closeSync(fd); }
  fixtureHash = hash.digest('hex');
}

const backend = new JsonStorageBackend(path.join(root, 'official'));
const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
let port;
try {
  const cpu0 = process.cpuUsage();
  const w0 = performance.now();
  port = await openDomainStorage(ctx, { presetDir: root, eventBridgePath: eventsFile, eventBridgeKey: KEY });
  const openCpu = process.cpuUsage(cpu0);
  const openMs = performance.now() - w0;
  const open = { wallMs: openMs, cpuMs: (openCpu.user + openCpu.system) / 1000 };
  global.gc?.(); global.gc?.();
  const retainedHeapBytes = process.memoryUsage().heapUsed;

  const flush = [];
  for (let i = 0; i < flushSamples + 2; i += 1) {
    const c0 = process.cpuUsage(); const w = performance.now();
    const r = await port.flush();
    const c = process.cpuUsage(c0);
    if (i >= 2) flush.push({ wallMs: performance.now() - w, cpuMs: (c.user + c.system) / 1000, r });
  }
  assert.ok(flush.every((s) => s.r && typeof s.r === 'object'), 'flush must return a result object');

  const observe = [];
  for (let i = 0; i < observeSamples + 2; i += 1) {
    const c0 = process.cpuUsage(); const w = performance.now();
    await port.observe({ schema: 1, eventType: 'agent/error', error: { message: `r12 observe ${i}`, name: 'Error', code: 'E_X' }, target: 'tool:read', recordedAt: new Date().toISOString() });
    const c = process.cpuUsage(c0);
    if (i >= 2) observe.push({ wallMs: performance.now() - w, cpuMs: (c.user + c.system) / 1000 });
  }

  const median = (arr, key) => arr.map((s) => s[key]).sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  console.log(JSON.stringify({
    records, fixtureHash,
    open,
    retainedHeapBytes,
    flush: { wallMs: median(flush, 'wallMs'), cpuMs: median(flush, 'cpuMs') },
    observe: { wallMs: median(observe, 'wallMs'), cpuMs: median(observe, 'cpuMs') },
    maxRSSKiB: process.resourceUsage().maxRSS,
    node: process.version,
  }));
} finally {
  if (port) await port.close();
  await backend.close();
  fs.rmSync(root, { recursive: true, force: true });
}
