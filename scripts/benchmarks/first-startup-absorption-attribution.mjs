#!/usr/bin/env node
// First-startup replay benchmark. Every sample starts a fresh child process and
// a fresh copy of the same temporary official-storage fixture. The child calls
// the repository's real openDomainStorage() with DomainFacility + JsonStorageBackend.
//
// Example:
//   node --max-old-space-size=4096 scripts/benchmarks/first-startup-absorption.mjs \
//     --a-root . --b-root /tmp/dsh-base-abs --records 2000,4000,8000 \
//     --rounds 3 --samples 1 --aa --out /tmp/absorption.json
//
// Fixtures, including the randomly generated test key, are restricted to os.tmpdir().
// A JSONL ledger is append+fsync per sample. Reusing an output file is allowed only
// when source hashes, Node, fixture identities, and protocol options all match.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { types as utilTypes } from 'node:util';

const SELF = fileURLToPath(import.meta.url);
const DEFAULT_OUT = path.join(os.tmpdir(), 'first-startup-absorption.json');
const MAX_OLD_SPACE = /(?:^|\s)--max-old-space-size(?:=|\s)\d+/;

function parseArgs(argv) {
  const options = { records: [2000, 4000, 8000, 12000], rounds: 3, samples: 1, aa: false, census: false };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === '--worker') { options.worker = true; continue; }
    if (raw === '--aa') { options.aa = true; continue; }
    if (raw === '--census') { options.census = true; continue; }
    if (!raw.startsWith('--')) throw new Error(`unexpected argument: ${raw}`);
    const [name, inline] = raw.slice(2).split('=', 2);
    const value = inline ?? argv[++index];
    if (value === undefined) throw new Error(`missing value for --${name}`);
    if (name === 'records') options.records = value.split(',').map(Number);
    else if (name === 'rounds') options.rounds = Number(value);
    else if (name === 'samples') options.samples = Number(value);
    else if (name === 'a-root') options.aRoot = path.resolve(value);
    else if (name === 'b-root') options.bRoot = path.resolve(value);
    else if (name === 'fixtures') options.fixtures = path.resolve(value);
    else if (name === 'out') options.out = path.resolve(value);
    else if (name === 'ledger') options.ledger = path.resolve(value);
    else if (name === 'fixture') options.fixture = path.resolve(value);
    else if (name === 'root') options.root = path.resolve(value);
    else if (name === 'side') options.side = value;
    else if (name === 'sample-id') options.sampleId = value;
    else throw new Error(`unknown option: --${name}`);
  }
  return options;
}

function assertHeapLimit() {
  const configured = `${process.execArgv.join(' ')} ${process.env.NODE_OPTIONS ?? ''}`;
  assert.match(configured, MAX_OLD_SPACE,
    'run with --max-old-space-size=4096 (directly or through NODE_OPTIONS)');
}

function walkFiles(directory, relative = '') {
  const current = path.join(directory, relative);
  return fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return walkFiles(directory, name);
      if (entry.isFile()) return [name];
      return [];
    });
}

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function sourceIdentity(root) {
  const hash = crypto.createHash('sha256');
  const included = ['package.json', 'package-lock.json', ...walkFiles(path.join(root, 'lib')).map((file) => `lib/${file}`)];
  for (const relative of [...new Set(included)].sort()) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) continue;
    hash.update(relative).update('\0').update(fs.readFileSync(file)).update('\0');
  }
  return { root, sha256: hash.digest('hex') };
}

function eventFor(bridge, index) {
  const id = `absorption-${String(index).padStart(8, '0')}`;
  const target = 'plugin:first-startup-absorption-bench';
  const observation = {
    at: '2026-10-26T00:00:00.000Z', solvesProblem: true, sideEffects: [], orphanResources: [],
    performanceChange: 'unchanged', errorChange: 'unchanged',
    metrics: { latency: (index % 997) + 1, throughput: 100, sampleCount: 5 },
    beforeMetrics: { latency: 12, throughput: 100 }, afterMetrics: { latency: (index % 997) + 1, throughput: 100 },
    observationWindow: 'startup-benchmark', sampleCount: 5, benefitEvidence: 'Synthetic signed first-startup benchmark event',
    repeatable: true, regressionPassed: true, reversible: true, cleanupEvidence: 'isolated synthetic fixture',
  };
  const record = {
    id, state: 'measured', proposalId: `proposal-${id}`, proposal: { id: `proposal-${id}`, target, capability: target,
      lineageId: target, predecessor: `parent-${index}`, supersedes: null },
    latestObservation: observation, observations: [observation], failure: null, durable: null, canary: null,
  };
  return bridge.project('measurement-completed', record, {
    experimentId: id, proposalId: `proposal-${id}`, target, capability: target, lineageId: target,
    status: 'measured', measurement: observation, at: '2026-10-26T00:00:00.000Z',
  });
}

function assertTemporaryPath(directory) {
  const resolved = path.resolve(directory);
  const temp = path.resolve(os.tmpdir());
  assert.ok(resolved === temp || resolved.startsWith(`${temp}${path.sep}`),
    `fixtures must be under os.tmpdir(): ${resolved}`);
  return resolved;
}

async function loadOfficialPackages(root) {
  const requireFromRoot = createRequire(path.join(root, 'package.json'));
  const domainPath = requireFromRoot.resolve('@deepseek-ai/dsh-storage-domain');
  const jsonPath = requireFromRoot.resolve('@deepseek-ai/dsh-storage-json');
  const [{ DomainFacility }, { JsonStorageBackend }, { openDomainStorage, evolutionDomainSpec }, { signEventBridgeEnvelope, EvolutionEventBridge }] = await Promise.all([
    import(pathToFileURL(domainPath)), import(pathToFileURL(jsonPath)),
    import(pathToFileURL(path.join(root, 'lib/domain-storage.js'))),
    import(pathToFileURL(path.join(root, 'lib/orchestrator.js'))),
  ]);
  return { DomainFacility, JsonStorageBackend, openDomainStorage, evolutionDomainSpec, signEventBridgeEnvelope, EvolutionEventBridge };
}

async function buildFixture({ root, fixtureDir, records }) {
  fixtureDir = assertTemporaryPath(fixtureDir);
  const metaFile = path.join(fixtureDir, '.fixture-meta.json');
  if (fs.existsSync(metaFile)) {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    assert.equal(meta.records, records, 'fixture record count does not match --records');
    assert.equal(meta.schema, 1);
    const logFile = path.join(fixtureDir, 'preset', 'execution-events.jsonl');
    assert.equal(sha256(fs.readFileSync(logFile)), meta.eventLogSha256, 'fixture log bytes changed since its identity was recorded');
    assert.equal(sha256(fs.readFileSync(path.join(fixtureDir, '.bench-event-key'), 'utf8').trim()), meta.keyFingerprint,
      'fixture key changed since its identity was recorded');
    for (const entry of meta.officialFiles) {
      assert.equal(sha256(fs.readFileSync(path.join(fixtureDir, 'official', entry.path))), entry.sha256,
        `official storage fixture changed: ${entry.path}`);
    }
    return meta;
  }
  fs.mkdirSync(fixtureDir, { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(fixtureDir, '.bench-event-key'), `${key}\n`, { mode: 0o600, flag: 'wx' });
  const presetDir = path.join(fixtureDir, 'preset');
  fs.mkdirSync(presetDir, { recursive: true, mode: 0o700 });
  const logFile = path.join(presetDir, 'execution-events.jsonl');
  const lines = [];
  const { signEventBridgeEnvelope, EvolutionEventBridge } = await loadOfficialPackages(root);
  const bridge = new EvolutionEventBridge({ file: null });
  for (let index = 0; index < records; index += 1) {
    const envelope = signEventBridgeEnvelope(eventFor(bridge, index), { key, sequence: index + 1 });
    lines.push(JSON.stringify(envelope));
  }
  fs.writeFileSync(logFile, `${lines.join('\n')}\n`, { mode: 0o600 });

  const { DomainFacility, JsonStorageBackend, evolutionDomainSpec } = await loadOfficialPackages(root);
  const officialRoot = path.join(fixtureDir, 'official');
  const backend = new JsonStorageBackend(officialRoot);
  const ctx = { emit() {}, on() { return () => {}; }, logger: { warn() {}, error() {} },
    storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const domain = await ctx.storageDomain.open(evolutionDomainSpec);
  await domain.global.set({ schema: 1, aggregate: {}, applied: {}, pending: null });
  await domain.close();
  await backend.close();

  const officialFiles = walkFiles(officialRoot).map((file) => ({ path: file, sha256: sha256(fs.readFileSync(path.join(officialRoot, file))) }));
  const meta = {
    schema: 1, records, createdAt: new Date().toISOString(),
    eventLogBytes: fs.statSync(logFile).size,
    eventLogSha256: sha256(fs.readFileSync(logFile)),
    keyFingerprint: sha256(key),
    officialFiles,
    identity: sha256(Buffer.from(JSON.stringify({ records, eventLog: sha256(fs.readFileSync(logFile)), officialFiles }))),
  };
  fs.writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return meta;
}

function makeCounters({ collectSites }) {
  const measureTimings = process.env.ABSORPTION_TRACE === '1';
  const rows = {
    stringifyCalls: 0, payloadStringifyCalls: 0, payloadStringifyUtf8Bytes: 0,
    stringifyWallNs: 0n, payloadStringifyWallNs: 0n,
    payloadStringifyCpuUserUs: 0, payloadStringifyCpuSystemUs: 0,
    parseCalls: 0, parseInputChars: 0, parseWallNs: 0n,
    eventParseCalls: 0, eventParseInputChars: 0, eventParseWallNs: 0n,
    eventParseCpuUserUs: 0, eventParseCpuSystemUs: 0,
    eventLogReadCalls: 0, eventLogReadBytes: 0, eventLogReadWallNs: 0n,
    eventLogSplitCalls: 0, eventLogSplitChars: 0, eventLogSplitWallNs: 0n,
    eventLogReadCpuUserUs: 0, eventLogReadCpuSystemUs: 0,
    eventLogSplitCpuUserUs: 0, eventLogSplitCpuSystemUs: 0,
  };
  const sites = new Map();
  const originals = { stringify: JSON.stringify, parse: JSON.parse, split: String.prototype.split,
    readFileSync: fs.readFileSync, openSync: fs.openSync, closeSync: fs.closeSync };
  const fdPaths = new Map();
  const logSuffix = `${path.sep}execution-events.jsonl`;
  const isPayload = (value) => {
    if (!value || typeof value !== 'object' || utilTypes.isProxy(value) || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== 'evolution') return false;
    const evolution = Object.getOwnPropertyDescriptor(value, 'evolution');
    if (!evolution || !Object.hasOwn(evolution, 'value') || !evolution.value
      || typeof evolution.value !== 'object' || utilTypes.isProxy(evolution.value)) return false;
    const schema = Object.getOwnPropertyDescriptor(evolution.value, 'schema');
    return Boolean(schema && Object.hasOwn(schema, 'value') && schema.value >= 4);
  };
  const siteName = () => {
    const stack = new Error().stack?.split('\n').slice(2, 9) ?? [];
    return stack.find((line) => !line.includes('first-startup-absorption.mjs'))?.trim() ?? 'unknown';
  };
  JSON.stringify = function (value, ...args) {
    const payload = isPayload(value);
    const start = measureTimings ? process.hrtime.bigint() : 0n;
    const cpuStart = measureTimings && payload ? process.cpuUsage() : null;
    const result = originals.stringify.call(this, value, ...args);
    const elapsed = measureTimings ? process.hrtime.bigint() - start : 0n;
    const cpu = cpuStart ? process.cpuUsage(cpuStart) : null;
    rows.stringifyCalls += 1;
    if (measureTimings) rows.stringifyWallNs += elapsed;
    const bytes = payload || collectSites
      ? (typeof result === 'string' ? Buffer.byteLength(result, 'utf8') : 0) : 0;
    if (payload) {
      rows.payloadStringifyCalls += 1;
      rows.payloadStringifyUtf8Bytes += bytes;
      if (measureTimings) {
        rows.payloadStringifyWallNs += elapsed;
        rows.payloadStringifyCpuUserUs += cpu.user;
        rows.payloadStringifyCpuSystemUs += cpu.system;
      }
    }
    if (collectSites) {
      const site = siteName();
      const entry = sites.get(site) ?? { calls: 0, bytes: 0, payloadCalls: 0, payloadBytes: 0 };
      entry.calls += 1; entry.bytes += bytes;
      if (payload) { entry.payloadCalls += 1; entry.payloadBytes += bytes; }
      sites.set(site, entry);
    }
    return result;
  };
  JSON.parse = function (value, ...args) {
    const start = measureTimings ? process.hrtime.bigint() : 0n;
    const isEvent = typeof value === 'string' && value.startsWith('{"schema":2,"writer":');
    const cpuStart = measureTimings && isEvent ? process.cpuUsage() : null;
    try { return originals.parse.call(this, value, ...args); }
    finally {
      const elapsed = measureTimings ? process.hrtime.bigint() - start : 0n;
      const cpu = cpuStart ? process.cpuUsage(cpuStart) : null;
      rows.parseCalls += 1;
      rows.parseInputChars += typeof value === 'string' ? value.length : 0;
      if (measureTimings) rows.parseWallNs += elapsed;
      if (isEvent) {
        rows.eventParseCalls += 1; rows.eventParseInputChars += value.length;
        if (measureTimings) {
          rows.eventParseWallNs += elapsed;
          rows.eventParseCpuUserUs += cpu.user;
          rows.eventParseCpuSystemUs += cpu.system;
        }
      }
    }
  };
  String.prototype.split = function (separator, limit) {
    const isLogText = separator === '\n' && typeof this === 'string' && this.startsWith('{"schema":2,"writer":');
    if (!isLogText) return originals.split.call(this, separator, limit);
    const start = process.hrtime.bigint();
    const cpuStart = measureTimings ? process.cpuUsage() : null;
    try { return originals.split.call(this, separator, limit); }
    finally {
      rows.eventLogSplitCalls += 1;
      rows.eventLogSplitChars += this.length;
      rows.eventLogSplitWallNs += process.hrtime.bigint() - start;
      if (cpuStart) {
        const cpu = process.cpuUsage(cpuStart);
        rows.eventLogSplitCpuUserUs += cpu.user;
        rows.eventLogSplitCpuSystemUs += cpu.system;
      }
    }
  };
  fs.openSync = function (file, ...args) {
    const fd = originals.openSync.call(this, file, ...args);
    if (typeof file === 'string') fdPaths.set(fd, path.resolve(file));
    return fd;
  };
  fs.closeSync = function (fd) {
    try { return originals.closeSync.call(this, fd); } finally { fdPaths.delete(fd); }
  };
  fs.readFileSync = function (file, ...args) {
    const target = typeof file === 'number' ? fdPaths.get(file) : typeof file === 'string' ? path.resolve(file) : null;
    const isLog = target?.endsWith(logSuffix) === true;
    if (!isLog) return originals.readFileSync.call(this, file, ...args);
    const start = process.hrtime.bigint();
    const cpuStart = measureTimings ? process.cpuUsage() : null;
    const result = originals.readFileSync.call(this, file, ...args);
    rows.eventLogReadCalls += 1;
    rows.eventLogReadBytes += Buffer.isBuffer(result) ? result.length : Buffer.byteLength(result, 'utf8');
    rows.eventLogReadWallNs += process.hrtime.bigint() - start;
    if (cpuStart) {
      const cpu = process.cpuUsage(cpuStart);
      rows.eventLogReadCpuUserUs += cpu.user;
      rows.eventLogReadCpuSystemUs += cpu.system;
    }
    return result;
  };
  return {
    read() {
      const { stringifyWallNs, payloadStringifyWallNs, parseWallNs, eventParseWallNs, eventLogReadWallNs, eventLogSplitWallNs, ...plain } = rows;
      return { ...plain, stringifyWallMs: Number(stringifyWallNs) / 1e6,
        payloadStringifyWallMs: Number(payloadStringifyWallNs) / 1e6,
        payloadStringifyCpuMs: (rows.payloadStringifyCpuUserUs + rows.payloadStringifyCpuSystemUs) / 1000,
        parseWallMs: Number(parseWallNs) / 1e6,
        eventParseWallMs: Number(eventParseWallNs) / 1e6,
        eventParseCpuMs: (rows.eventParseCpuUserUs + rows.eventParseCpuSystemUs) / 1000,
        eventLogReadWallMs: Number(eventLogReadWallNs) / 1e6,
        eventLogReadCpuMs: (rows.eventLogReadCpuUserUs + rows.eventLogReadCpuSystemUs) / 1000,
        eventLogSplitWallMs: Number(eventLogSplitWallNs) / 1e6,
        eventLogSplitCpuMs: (rows.eventLogSplitCpuUserUs + rows.eventLogSplitCpuSystemUs) / 1000,
        sites: Object.fromEntries([...sites].map(([name, entry]) => [name, { ...entry }])) };
    },
    restore() {
      JSON.stringify = originals.stringify; JSON.parse = originals.parse;
      String.prototype.split = originals.split;
      fs.readFileSync = originals.readFileSync; fs.openSync = originals.openSync; fs.closeSync = originals.closeSync;
    },
  };
}

async function runWorker(options) {
  assertHeapLimit();
  const root = options.root;
  const fixtureDir = options.fixture;
  const fixtureMeta = JSON.parse(fs.readFileSync(path.join(fixtureDir, '.fixture-meta.json'), 'utf8'));
  const key = fs.readFileSync(path.join(fixtureDir, '.bench-event-key'), 'utf8').trim();
  assert.equal(sha256(key), fixtureMeta.keyFingerprint);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-abs-sample-'));
  const sampleRoot = path.join(home, 'data');
  const presetDir = path.join(sampleRoot, 'preset');
  const logFile = path.join(presetDir, 'execution-events.jsonl');
  fs.cpSync(fixtureDir, sampleRoot, { recursive: true, force: false, errorOnExist: true });
  assert.equal(fs.existsSync(path.join(presetDir, 'event-log.checkpoint.json')), false,
    'cold fixture must not carry a replay checkpoint');
  const { DomainFacility, JsonStorageBackend, openDomainStorage, evolutionDomainSpec } = await loadOfficialPackages(root);
  const backend = new JsonStorageBackend(path.join(sampleRoot, 'official'));
  const ctx = { emit() {}, on() { return () => {}; }, logger: { warn() {}, error() {} },
    storage: { backend: { get: () => backend } }, effect() {} };
  const facility = new DomainFacility(ctx, { backend: 'json' });
  let liveDomain = null;
  const realOpen = facility.open.bind(facility);
  const trace = makePhaseTracer(process.env.ABSORPTION_TRACE === '1');
  if (trace) globalThis.__absTrace = trace;
  ctx.storageDomain = { open: async (...args) => {
    liveDomain = await realOpen(...args);
    if (!trace) return liveDomain;
    const original = liveDomain;
    const wrappedGlobal = new Proxy(original.global, {
      get(target, property, receiver) {
        if (property === 'set') return (...values) => trace.async('domain.global.set', () => target.set(...values));
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return new Proxy(original, {
      get(target, property, receiver) {
        if (property === 'global') return wrappedGlobal;
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  } };
  ctx.storageDomain.facility = facility;

  const counters = makeCounters({ collectSites: options.collectSites === true });
  const cpuBefore = process.cpuUsage();
  const start = process.hrtime.bigint();
  let port;
  try {
    port = await openDomainStorage(ctx, { presetDir, eventBridgePath: logFile, eventBridgeKey: key });
    const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
    const cpu = process.cpuUsage(cpuBefore);
    const countersDuringOpen = counters.read();
    assert.ok(liveDomain, 'production path must open the official DomainFacility');
    const appliedCount = Object.keys(liveDomain.global.get().applied).length;
    assert.equal(appliedCount, fixtureMeta.records, 'all fixture records must be durably marked');
    assert.deepEqual(await port.flush(), { applied: 0, duplicates: fixtureMeta.records },
      'post-open checkpoint pass must classify every record as already applied');
    const result = {
      sampleId: options.sampleId, side: options.side, node: process.version, platform: `${process.platform}/${process.arch}`, records: fixtureMeta.records,
      wallMs, cpuMs: (cpu.user + cpu.system) / 1000,
      maxRssKiB: process.resourceUsage().maxRSS,
      appliedCount, eventLogBytes: fixtureMeta.eventLogBytes, fixtureIdentity: fixtureMeta.identity,
      source: sourceIdentity(root), stringify: countersDuringOpen, phases: trace?.read() ?? null,
    };
    return result;
  } finally {
    counters.restore();
    try { await port?.close(); } finally { await backend.close(); fs.rmSync(home, { recursive: true, force: true }); }
  }
}

function loadLedger(ledgerPath, identity) {
  if (!fs.existsSync(ledgerPath) || fs.statSync(ledgerPath).size === 0) return null;
  const lines = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean);
  const header = JSON.parse(lines[0]);
  assert.equal(header.type, 'header');
  assert.equal(header.identityHash, identity, 'existing ledger belongs to different source/Node/fixture/options; refuse to mix samples');
  return { header, rows: lines.slice(1).map(JSON.parse) };
}

function appendDurable(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a', 0o600);
  try { fs.writeSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

function makePhaseTracer(enabled) {
  if (!enabled) return null;
  const phases = new Map();
  const wallNow = () => process.hrtime.bigint();
  const add = (name, wallNs, cpu) => {
    const entry = phases.get(name) ?? { calls: 0, wallNs: 0n, cpuUserUs: 0, cpuSystemUs: 0 };
    entry.calls += 1; entry.wallNs += wallNs; entry.cpuUserUs += cpu.user; entry.cpuSystemUs += cpu.system;
    phases.set(name, entry);
  };
  const sync = (name, callback) => {
    const wallStart = wallNow(), cpuStart = process.cpuUsage();
    try { return callback(); }
    finally { add(name, wallNow() - wallStart, process.cpuUsage(cpuStart)); }
  };
  const async = async (name, callback) => {
    const wallStart = wallNow(), cpuStart = process.cpuUsage();
    try { return await callback(); }
    finally { add(name, wallNow() - wallStart, process.cpuUsage(cpuStart)); }
  };
  return { sync, async, read: () => Object.fromEntries([...phases].map(([name, entry]) => [name, {
    calls: entry.calls, wallMs: Number(entry.wallNs) / 1e6,
    cpuMs: (entry.cpuUserUs + entry.cpuSystemUs) / 1000,
  }])) };
}

function summarizeSamples(samples) {
  const groups = new Map();
  for (const sample of samples) {
    const name = `${sample.control ? 'aa' : 'ab'}:${sample.records}`;
    const group = groups.get(name) ?? { control: sample.control, records: sample.records, a: [], b: [] };
    group[sample.side].push(sample);
    groups.set(name, group);
  }
  return [...groups.values()].map((group) => {
    const reduce = (rows) => rows.length ? {
      n: rows.length,
      wallMs: median(rows.map((row) => row.wallMs)), cpuMs: median(rows.map((row) => row.cpuMs)),
      maxRssKiB: median(rows.map((row) => row.maxRssKiB)),
      stringifyCalls: median(rows.map((row) => row.stringify.stringifyCalls)),
      payloadStringifyCalls: median(rows.map((row) => row.stringify.payloadStringifyCalls)),
      payloadStringifyUtf8Bytes: median(rows.map((row) => row.stringify.payloadStringifyUtf8Bytes)),
      payloadStringifyWallMs: median(rows.map((row) => row.stringify.payloadStringifyWallMs)),
    } : null;
    return { control: group.control, records: group.records, a: reduce(group.a), b: reduce(group.b) };
  });
}

async function runParent(options) {
  assertHeapLimit();
  assert.ok(options.aRoot, 'provide --a-root');
  options.bRoot ??= options.aRoot;
  assert.ok(Number.isSafeInteger(options.rounds) && options.rounds >= 1);
  assert.ok(Number.isSafeInteger(options.samples) && options.samples >= 1);
  assert.ok(options.records.length > 0 && options.records.every((count) => Number.isSafeInteger(count) && count > 0));
  const roots = { a: sourceIdentity(options.aRoot), b: sourceIdentity(options.bRoot) };
  const fixturesRoot = assertTemporaryPath(options.fixtures ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-abs-fixtures-')));
  fs.mkdirSync(fixturesRoot, { recursive: true, mode: 0o700 });
  const fixtureMeta = {};
  for (const records of options.records) {
    fixtureMeta[records] = await buildFixture({ root: options.aRoot, fixtureDir: path.join(fixturesRoot, `records-${records}`), records });
  }
  const out = options.out ?? DEFAULT_OUT;
  const ledger = options.ledger ?? `${out}.samples.jsonl`;
  const settings = { records: options.records, rounds: options.rounds, samples: options.samples, aa: options.aa, census: options.census };
  const benchmarkSha256 = sha256(fs.readFileSync(SELF));
  const identityPayload = { schema: 1, node: process.version, benchmarkSha256, roots,
    fixtureMeta: Object.fromEntries(Object.entries(fixtureMeta).map(([key, value]) => [key, value.identity])), settings };
  const identityHash = sha256(Buffer.from(JSON.stringify(identityPayload)));
  let existing = loadLedger(ledger, identityHash);
  const runId = existing?.header.runId ?? crypto.randomUUID();
  if (!existing) {
    appendDurable(ledger, { type: 'header', schema: 1, runId, createdAt: new Date().toISOString(),
      identityHash, node: process.version, benchmarkSha256, sourceRoots: roots,
      fixtureIdentity: identityPayload.fixtureMeta, settings, fixtureDirectory: fixturesRoot,
      peakRssNote: 'process.resourceUsage().maxRSS is a whole-process high-water mark, not a phase-local delta.' });
    existing = { rows: [] };
  }
  const completed = new Set(existing.rows.map((row) => row.sampleId));
  const rows = [...existing.rows];
  const work = [];
  const addPair = (records, round, sample, control = false) => {
    const order = round % 2 === 0 ? ['a', 'b'] : ['b', 'a'];
    const sides = control ? order.map((side) => ({ side, root: options.aRoot }))
      : order.map((side) => ({ side, root: side === 'a' ? options.aRoot : options.bRoot }));
    for (const [orderIndex, item] of sides.entries()) {
      const sampleId = `${control ? 'aa' : 'ab'}-${records}-r${round + 1}-s${sample + 1}-${item.side}`;
      if (!completed.has(sampleId)) work.push({ records, round, sample, control, sampleId, orderIndex: orderIndex + 1, ...item });
    }
  };
  for (const records of options.records) {
    for (let round = 0; round < options.rounds; round += 1) {
      for (let sample = 0; sample < options.samples; sample += 1) addPair(records, round, sample, false);
    }
  }
  if (options.aa) {
    for (const records of options.records) {
      for (let round = 0; round < options.rounds; round += 1) {
        for (let sample = 0; sample < options.samples; sample += 1) addPair(records, round, sample, true);
      }
    }
  }
  for (const item of work) {
    const fixture = path.join(fixturesRoot, `records-${item.records}`);
    const workerArgs = [SELF, '--worker', '--root', item.root, '--fixture', fixture,
      '--side', item.side, '--sample-id', item.sampleId];
    const child = spawnSync(process.execPath, ['--max-old-space-size=4096', ...workerArgs], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ABSORPTION_WORKER: '1',
        ABSORPTION_COLLECT_SITES: options.census ? '1' : '0', ABSORPTION_TRACE: process.env.ABSORPTION_TRACE ?? '0' },
    });
    if (child.status !== 0) throw new Error(`sample ${item.sampleId} failed (${child.status}): ${child.stderr || child.stdout}`);
    const row = JSON.parse(child.stdout.trim());
    row.round = item.round + 1; row.sample = item.sample + 1; row.control = item.control;
    row.orderIndex = item.orderIndex;
    assert.equal(row.source.sha256, roots[item.control ? 'a' : item.side].sha256);
    assert.equal(row.fixtureIdentity, fixtureMeta[item.records].identity);
    appendDurable(ledger, row);
    rows.push(row); completed.add(item.sampleId);
  }
  const summary = {
    schema: 1, runId, completedAt: new Date().toISOString(), node: process.version, benchmarkSha256,
    platform: `${process.platform}/${process.arch}`, sourceRoots: roots,
    fixtureIdentity: identityPayload.fixtureMeta, settings, fixtureDirectory: fixturesRoot,
    samples: rows, summaries: summarizeSamples(rows), ledger,
    peakRssNote: 'process.resourceUsage().maxRSS is a whole-process high-water mark, not a phase-local delta.',
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ out, ledger, fixtureDirectory: fixturesRoot, samples: rows.length, summary: summary.summaries }, null, 2)}\n`);
}

const options = parseArgs(process.argv.slice(2));
if (options.worker) {
  try {
    const result = await runWorker({ ...options, collectSites: process.env.ABSORPTION_COLLECT_SITES === '1' });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) { process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1; }
} else {
  await runParent(options);
}
