// What one durable domain write actually pays in fsync wait, through the real
// port and the real official JSON backend.
//
// The two artifacts measured here are *derived* state: the event-log replay
// checkpoint (which only lets a later pass skip re-authenticating consumed
// history) and the stage manifest inside a transaction's staging directory
// (which is the readable copy of the file list the committed document already
// carries). Both are self-verifying and fall back to full work when they are
// missing, stale or torn, so making their bytes durable is optional - while the
// fsyncs themselves sit in the write path of every transaction and every pass
// that consumes new bridge events.
//
// Usage:
//   node scripts/benchmarks/domain-derived-fsync.mjs
//   node scripts/benchmarks/domain-derived-fsync.mjs --lib /tmp/baseline/lib
//   BENCH_EVENTS=200 BENCH_SAMPLES=9 BENCH_WARMUP=3 node scripts/benchmarks/domain-derived-fsync.mjs
//
// Two costs are reported per operation: wall and CPU time, and the syscalls
// that cost durability. A time difference alone can hide behind the page cache;
// the fsync counts are what say whether the write path actually waits less.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

// Deterministic clock and identifiers: both sides then execute the identical
// workload, so the durable bytes they leave behind can be compared directly
// instead of only their timings. `recordedAt` stamps, record ids and every
// temporary name come from these two, and the installed document and archive
// tree must match byte for byte.
const FROZEN_NOW = Date.parse('2026-10-12T00:00:00.000Z');
const FrozenDate = class extends Date {
  constructor(...value) { if (value.length === 0) super(FROZEN_NOW); else super(...value); }
  static now() { return FROZEN_NOW; }
};
globalThis.Date = FrozenDate;
let nextIdentifier = 0;
crypto.randomUUID = () => `00000000-0000-4000-8000-${String((nextIdentifier += 1)).padStart(12, '0')}`;
syncBuiltinESMExports();

const args = process.argv.slice(2);
let lib = new URL('../../lib/', import.meta.url).href;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--lib' && args[index + 1]) {
    const directory = path.resolve(args[index + 1]);
    lib = pathToFileURL(`${directory}${path.sep}`).href;
    index += 1;
    continue;
  }
  throw new Error(`Unknown argument: ${args[index]}`);
}
const { openDomainStorage, evolutionDomainSpec } = await import(`${lib}domain-storage.js`);
const { signEventBridgeEnvelope } = await import(`${lib}orchestrator.js`);
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

const history = Math.max(0, Number(process.env.BENCH_EVENTS || 200));
const samples = Math.max(1, Number(process.env.BENCH_SAMPLES || 9));
const warmup = Math.max(0, Number(process.env.BENCH_WARMUP || 3));
const backlogSizes = String(process.env.BENCH_BACKLOG || '0,1,2,5,10').split(',').map((value) => Math.max(0, Number(value) || 0));
const key = 'b'.repeat(64);

const COUNTERS = ['fsyncSync', 'fdatasyncSync', 'syncFileHandle', 'writeSync', 'writeFileSync', 'renameSync', 'readFileSync', 'linkSync', 'mkdirSync'];
/** Count the durability-relevant syscalls the port issues. */
async function instrument() {
  const counts = {};
  const originals = new Map();
  for (const name of COUNTERS) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    originals.set(name, original);
    fs[name] = function (...callArgs) { counts[name] = (counts[name] || 0) + 1; return original.apply(this, callArgs); };
  }
  // The official JSON backend syncs through a FileHandle, which does not go
  // through `fs.fsyncSync`; count it here so `syncFileHandle` is a real fsync.
  const probeFile = path.join(os.tmpdir(), `evolution-fsync-probe-${crypto.randomUUID()}`);
  const probeHandle = await fsp.open(probeFile, 'w');
  const handlePrototype = Object.getPrototypeOf(probeHandle);
  await probeHandle.close();
  fs.rmSync(probeFile, { force: true });
  const originalHandleSync = handlePrototype.sync;
  handlePrototype.sync = function (...callArgs) { counts.syncFileHandle = (counts.syncFileHandle || 0) + 1; return originalHandleSync.apply(this, callArgs); };
  return {
    reset() { for (const name of Object.keys(counts)) delete counts[name]; },
    read() { return { ...counts }; },
    restore() { for (const [name, original] of originals) fs[name] = original; handlePrototype.sync = originalHandleSync; },
  };
}

function eventFor(sequence) {
  return { schema: 1, eventId: `evolution:measurement-completed:bench-experiment-${sequence}`, eventType: 'measurement-completed',
    experimentId: `bench-experiment-${sequence}`, proposalId: `bench-proposal-${sequence}`, target: 'plugin:bench',
    capability: 'plugin:bench', lineageId: 'plugin:bench', status: 'measured',
    measurement: { latency: 12, throughput: 100 }, evidence: { summary: 'Synthetic measured evolution event' },
    canary: {}, audit: { producer: 'dsh-evolution-orchestrator', at: '2026-10-07T00:00:00.000Z' } };
}

const io = await instrument();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-derived-fsync-'));
const report = { node: process.version, platform: `${process.platform}/${process.arch}`, lib, history,
  samples, warmup, backlogSizes, scenarios: [] };
const median = (values) => { const sorted = [...values].sort((left, right) => left - right); return sorted[Math.floor(sorted.length / 2)]; };

/** One isolated root with committed authenticated history and a loaded port. */
async function openFixture(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'execution-events.jsonl');
  const lines = [];
  const applied = {};
  const events = Math.max(history, 1);
  for (let index = 0; index < events; index += 1) {
    const envelope = signEventBridgeEnvelope(eventFor(index), { key, sequence: index + 1 });
    applied[envelope.event.eventId] = envelope.mac;
    lines.push(JSON.stringify(envelope));
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const backend = new JsonStorageBackend(path.join(dir, 'official'));
  const ctx = { emit() {}, on() { return () => {}; }, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const domain = await ctx.storageDomain.open(evolutionDomainSpec);
  await domain.global.set({ schema: 1, aggregate: {}, applied, pending: null });
  await domain.close();
  const port = await openDomainStorage(ctx, { presetDir: dir, eventBridgePath: file, eventBridgeKey: key });
  return { dir, file, port, backend, applied, events };
}

async function measure(job) {
  io.reset();
  const cpu = process.cpuUsage();
  const start = performance.now();
  const value = await job();
  const elapsedMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  return { elapsedMs, cpuMs: (used.user + used.system) / 1000, syscalls: io.read(), value };
}

/**
 * Digest of everything the workload committed: the official document and every
 * file of the archive tree, so an equivalent run must reproduce it exactly.
 *
 * The only bytes normalized are this run's own root directory and, in the
 * checkpoint, the log file identity: the committed aggregate records the
 * staging path of the transaction that produced a cold archive segment (the
 * live path is rebuilt from the root on load, and the stage directory is this
 * run's private name), and device/inode pairs identify this root's files. Every
 * other byte has to match.
 */
function durableStateDigest(dir) {
  const hash = crypto.createHash('sha256');
  const normalize = (value) => {
    const text = value.toString('latin1');
    const root = dir.replaceAll('\\', '/');
    const portable = text.replaceAll(root, '<root>').replaceAll(root.replaceAll('/', '\\\\'), '<root>');
    return Buffer.from(portable, 'latin1');
  };
  hash.update('official\u0000').update(normalize(fs.readFileSync(path.join(dir, 'official', 'evolution_domain.json'))));
  const walk = (directory, relative = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const nested = relative ? `${relative}/${name}` : name;
      if (fs.lstatSync(absolute).isDirectory()) { hash.update(`dir\u0000${nested}\u0000`); walk(absolute, nested); continue; }
      hash.update(`file\u0000${nested}\u0000`).update(normalize(fs.readFileSync(absolute)));
    }
  };
  walk(path.join(dir, 'dockyard'));
  return hash.digest('hex');
}

const fixture = await openFixture(path.join(root, 'history'));
try {
  // Bring the document to its working shape (applied history, hot windows,
  // archive index) before any measurement, then keep the same fixture for the
  // steady and backlog passes.
  for (let index = 0; index < warmup; index += 1) await fixture.port.flush();
  let sequence = fixture.events;

  const observeRows = [];
  // A typical daily write: one observation appended through the public port.
  for (let index = 0; index < warmup; index += 1) {
    await fixture.port.observe({ type: 'agent/error', code: 'HOST_OPERATION_FAILED', target: 'plugin:bench' });
  }
  for (let index = 0; index < samples; index += 1) {
    observeRows.push(await measure(() => fixture.port.observe({ type: 'agent/error', code: 'HOST_OPERATION_FAILED', target: 'plugin:bench' })));
  }
  for (const backlog of backlogSizes) {
    const rows = [];
    for (let index = 0; index < samples; index += 1) {
      for (let extra = 0; extra < backlog; extra += 1) {
        sequence += 1;
        fs.appendFileSync(fixture.file, `${JSON.stringify(signEventBridgeEnvelope(eventFor(sequence), { key, sequence }))}\n`);
      }
      const row = await measure(() => fixture.port.flush());
      // Every scenario is self-checking: a pass applies exactly the records it
      // was given and reports the whole committed history as duplicates.
      assert.equal(row.value.applied, backlog, 'flush applied count');
      assert.ok(row.value.applied + row.value.duplicates >= sequence, 'every committed record is accounted for');
      rows.push(row);
    }
    report.scenarios.push({ operation: 'flush', backlog, samples,
      median: { elapsedMs: median(rows.map((row) => row.elapsedMs)), cpuMs: median(rows.map((row) => row.cpuMs)),
        ...Object.fromEntries(COUNTERS.map((name) => [name, median(rows.map((row) => row.syscalls[name] || 0))])) },
      rows });
  }
  report.scenarios.unshift({ operation: 'observe', backlog: null, samples,
    median: { elapsedMs: median(observeRows.map((row) => row.elapsedMs)), cpuMs: median(observeRows.map((row) => row.cpuMs)),
      ...Object.fromEntries(COUNTERS.map((name) => [name, median(observeRows.map((row) => row.syscalls[name] || 0))])) },
    rows: observeRows });
  report.device = { files: fs.readdirSync(path.join(root, 'history', 'official')).length,
    documentBytes: fs.statSync(path.join(root, 'history', 'official', 'evolution_domain.json')).size };
  // Equivalence evidence produced by the same run that produces the timings.
  report.durableStateDigest = durableStateDigest(path.join(root, 'history'));
  const checkpoint = JSON.parse(fs.readFileSync(path.join(root, 'history', 'event-log.checkpoint.json'), 'utf8'));
  // `file.dev`/`file.ino` identify this root's log inode and the MAC covers
  // them, so both are dropped; every other field is content-derived.
  report.checkpoint = { schema: checkpoint.schema, bytes: checkpoint.bytes, records: checkpoint.records,
    contentDigest: crypto.createHash('sha256').update(JSON.stringify({ ...checkpoint, file: null, mac: null })).digest('hex') };
} finally {
  await fixture.port.close();
  await fixture.backend.close();
  io.restore();
  fs.rmSync(root, { recursive: true, force: true });
}
report.sources = Object.fromEntries(['domain-storage.js', 'archive-stage.js', 'event-log-checkpoint.js'].map((name) => {
  const path = new URL(`${name}`, lib);
  return [name, crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex')];
}));
console.log(JSON.stringify(report, null, 2));
