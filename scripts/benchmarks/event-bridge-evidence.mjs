// Synthetic authenticated logs only. CPU, allocation and fresh-process RSS
// measurements are separate so neither fixture construction nor profiling
// contaminates the replay CPU/RSS comparison.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import inspector from 'node:inspector/promises';
import { readEventBridgeEvidence as candidate, signEventBridgeEnvelope } from '../../lib/orchestrator.js';
import { readEventBridgeEvidence as baseline } from '../../test/fixtures/event-bridge-evidence.mjs';

const key = 'synthetic-benchmark-event-bridge-key';
const writers = Array.from({ length: 8 }, (_, i) => `writer-${i}`);
const options = { key, trustedWriters: writers };
const replay = (run, file) => run(file, 'target', options);
if (!global.gc) throw new Error('run with --expose-gc');
if (process.argv[2] === '--rss-worker') {
  const run = process.argv[3] === 'baseline' ? baseline : candidate;
  global.gc();
  const startRssKiB = process.resourceUsage().maxRSS;
  for (let i = 0; i < 3; i += 1) assert.equal((await replay(run, process.argv[4])).runtimeRecovered, true);
  console.log(JSON.stringify({ startRssKiB, maxRssKiB: process.resourceUsage().maxRSS }));
} else {
  const records = Number(process.env.BENCH_RECORDS || 50000);
  const payloadBytes = Number(process.env.BENCH_PAYLOAD_BYTES || 256);
  const samples = Number(process.env.BENCH_SAMPLES || 5);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-evidence-bench-'));
  const file = path.join(home, 'events.jsonl');
  const median = (values) => [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)];
  const session = new inspector.Session(); session.connect();
  async function allocation(run) {
    global.gc();
    await session.post('HeapProfiler.startSampling', { samplingInterval: 32768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    for (let i = 0; i < 3; i += 1) await replay(run, file);
    const { profile } = await session.post('HeapProfiler.stopSampling');
    return profile.samples.reduce((sum, sample) => sum + sample.size, 0) / 3;
  }
  try {
    // Batches keep fixture setup out of RSS workers and avoid a huge setup array.
    const fd = fs.openSync(file, 'w');
    try {
      for (let i = 1; i <= records; i += 1) {
        const event = { experimentId: i % 1024 === 0 ? 'target' : `other-${i % 64}`, eventId: `event-${i}`, eventType: 'measurement-completed', measurement: { value: i, payload: 'x'.repeat(payloadBytes) }, audit: { at: `at-${i}` } };
        fs.writeSync(fd, JSON.stringify(signEventBridgeEnvelope(event, { key, writer: writers[i % writers.length], sequence: i })) + '\n');
      }
      fs.writeSync(fd, JSON.stringify(signEventBridgeEnvelope({ experimentId: 'target', eventType: 'promotion-succeeded', evidence: { runtimeRecovered: true }, promotion: { pluginName: 'synthetic', promotionTimestamp: 'promotion-at' } }, { key, writer: writers[0], sequence: records + 1 })) + '\n');
    } finally { fs.closeSync(fd); }
    assert.deepEqual(await replay(candidate, file), await replay(baseline, file));
    const results = [];
    for (let round = 0; round < 3; round += 1) {
      const result = {};
      for (const [name, run] of round % 2 ? [['candidate', candidate], ['baseline', baseline]] : [['baseline', baseline], ['candidate', candidate]]) {
        for (let warm = 0; warm < 2; warm += 1) await replay(run, file);
        const measured = [];
        for (let sample = 0; sample < samples; sample += 1) {
          global.gc();
          const cpu = process.cpuUsage(); const start = performance.now();
          await replay(run, file);
          const elapsedMs = performance.now() - start; const used = process.cpuUsage(cpu);
          measured.push({ cpuMs: (used.user + used.system) / 1000, elapsedMs });
        }
        result[name] = { samples: measured, median: { cpuMs: median(measured.map(x => x.cpuMs)), elapsedMs: median(measured.map(x => x.elapsedMs)) } };
      }
      results.push(result);
    }
    const allocations = [], rss = [];
    for (let round = 0; round < 3; round += 1) {
      const allocated = {}, memory = {};
      for (const [name, run] of round % 2 ? [['candidate', candidate], ['baseline', baseline]] : [['baseline', baseline], ['candidate', candidate]]) {
        allocated[name] = await allocation(run);
        const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--rss-worker', name, file], { encoding: 'utf8' });
        assert.equal(child.status, 0, child.stderr);
        memory[name] = JSON.parse(child.stdout);
      }
      allocations.push(allocated); rss.push(memory);
    }
    console.log(JSON.stringify({ baselineCommit: '9af8ffd', node: process.version, platform: `${process.platform}/${process.arch}`, records, payloadBytes, fileBytes: fs.statSync(file).size, samples, equality: true, allocation: 'V8 sampled bytes/call including collected objects; 32768-byte interval, 3 calls', rssMeasurement: 'fresh process maxRSS KiB after 3 replays; includes runtime/imports, excludes fixture construction', results, allocations, rss }, null, 2));
  } finally { session.disconnect(); fs.rmSync(home, { recursive: true, force: true }); }
}
