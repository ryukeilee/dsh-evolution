#!/usr/bin/env node
/**
 * Attribution for the staged save check and the archive key tables.
 *
 * The end-to-end numbers come from `event-log-replay-memory.mjs` (A/B plus a
 * same-code control). This script answers the "why" of that difference with
 * mechanism counters instead of an estimate: how often the staged store runs its
 * save check, how many bytes that check serializes, and how much of the archive
 * path is key-table bookkeeping.
 *
 * Each sample is a fresh child process over the real `openDomainStorage()`, the
 * official `DomainFacility` and `JsonStorageBackend`, with a cold fixture signed
 * by `signEventBridgeEnvelope()`. The counters are collected by a temporary
 * instrumented copy of the tree's own `lib/domain-storage.js` and
 * `lib/dockyard-domain/memory.js` (written next to the real modules so relative
 * imports resolve, and removed immediately after the import); the production
 * files are never modified.
 *
 *   node scripts/benchmarks/staged-save-attribution.mjs --records 20000 --samples 3 \
 *     --baseline-root /tmp/dsh-base-save-check --out docs/performance/staged-save-attribution.json
 *
 * Modes:
 *   --mode cold      (default) one cold absorption of `--records` events
 *   --mode growth    absorb, then append `--growth` more events and flush again,
 *                    which is the path that starts from a full loaded window
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SCRIPT), '../..');
const KEY = 'd'.repeat(64);
const HOOK = Symbol.for('dsh-evolution.staged-save-attribution');

function argsOf(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    result[value.slice(2)] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
  }
  return result;
}

function eventFor(sequence, prefix = 'attribution') {
  const experimentId = `${prefix}-${sequence}`;
  return {
    schema: 1,
    eventId: `evolution:measurement-completed:${experimentId}`,
    eventType: 'measurement-completed',
    experimentId,
    proposalId: `proposal-${experimentId}`,
    target: 'plugin:staged-save-attribution',
    capability: 'plugin:staged-save-attribution',
    lineageId: 'plugin:staged-save-attribution',
    status: 'measured',
    measurement: { latency: 10 + sequence % 101, throughput: 20 + sequence % 53 },
    evidence: { testPassed: true },
    audit: { producer: 'dsh-evolution-orchestrator', at: '2026-10-27T00:00:00.000Z' },
  };
}

async function appendEvents(file, from, count, prefix = 'attribution') {
  const { signEventBridgeEnvelope } = await import(pathToFileURL(path.join(REPO, 'lib/orchestrator.js')));
  const descriptor = fs.openSync(file, 'a', 0o600);
  try {
    for (let sequence = from; sequence < from + count; sequence += 1) {
      fs.writeSync(descriptor, `${JSON.stringify(signEventBridgeEnvelope(eventFor(sequence, prefix), { key: KEY, sequence }))}\n`);
    }
  } finally { fs.closeSync(descriptor); }
}

async function makeFixture(file, records) {
  fs.writeFileSync(file, '');
  await appendEvents(file, 1, records);
}

/**
 * A temporary copy of one source file with counter probes inserted. Every probe
 * is optional: the baseline tree has no `assertStagedTransactionSave`, so the
 * script reports which probes it could install on each side.
 */
function instrument(root, file, edits) {
  const modulePath = path.join(root, file);
  let source = fs.readFileSync(modulePath, 'utf8');
  const applied = [];
  for (const [name, needle, replacement] of edits) {
    if (source.split(needle).length - 1 !== 1) continue;
    source = source.replace(needle, replacement);
    applied.push(name);
  }
  const instrumentedPath = path.join(path.dirname(modulePath), `.attribution-${process.pid}-${crypto.randomUUID()}.mjs`);
  fs.writeFileSync(instrumentedPath, source, { mode: 0o600, flag: 'wx' });
  return { path: instrumentedPath, applied };
}

const COUNTERS = `globalThis[Symbol.for('dsh-evolution.staged-save-attribution')]`;
const wholeCheckNeedle = `export function assertTransactionSave(payload) {\n  const text = JSON.stringify(payload);\n`;
const wholeCheckProbe = `export function assertTransactionSave(payload) {
  const __stats = ${COUNTERS};
  const __started = process.hrtime.bigint();
  const text = JSON.stringify(payload);
  __stats.wholeCheckCalls += 1;
  __stats.wholeCheckBytes += text === undefined ? 0 : text.length;
  __stats.wholeCheckMs += Number(process.hrtime.bigint() - __started) / 1e6;
`;
// The window gate the staged check applies before it substitutes anything; a
// probe here counts the saves that reached the substitution at all.
const stagedNeedle = `  if (window.length === 0) return whole();\n  // Everything but the window, serialized exactly as the whole payload is.\n`;
const stagedProbe = `  if (window.length === 0) return whole();
  ${COUNTERS}.stagedCalls += 1;
  // Everything but the window, serialized exactly as the whole payload is.
`;
const shadowNeedle = `  const text = JSON.stringify({ ...payload, evolution: { ...state, eventBridge: { ...bridge, applied: EMPTY_WINDOW } } });\n`;
const shadowProbe = `  const __shadowStarted = process.hrtime.bigint();
  const text = JSON.stringify({ ...payload, evolution: { ...state, eventBridge: { ...bridge, applied: EMPTY_WINDOW } } });
  ${COUNTERS}.shadowCalls += 1;
  ${COUNTERS}.shadowBytes += text === undefined ? 0 : text.length;
  ${COUNTERS}.shadowMs += Number(process.hrtime.bigint() - __shadowStarted) / 1e6;
`;
const markerNeedle = `      verdict = markerText.includes(\`"\${PROTO_KEY}"\`);\n`;
const markerProbe = `      verdict = markerText.includes(\`"\${PROTO_KEY}"\`);
      ${COUNTERS}.markerCalls += 1;
`;
const archiveNeedle = `      const known = this.archiveKnown.get(collection) ?? new Set(existingByKey.keys());\n      const tombstones = this.archiveTombstones.get(collection) ?? new Set();\n`;
// The pre-change tree builds (and restores) full copies of both tables; the
// candidate reuses them in place. Either shape is counted by the same two
// counters, so the same report field describes both sides.
const archiveNeedleBefore = `      const known = new Set(this.archiveKnown.get(collection) ?? existingByKey.keys());\n      const tombstones = new Set(this.archiveTombstones.get(collection) ?? []);\n      const originalKnown = new Set(known);\n      const originalTombstones = new Set(tombstones);\n`;
const archiveProbeBefore = `      const __keyTablesStarted = process.hrtime.bigint();
      const known = new Set(this.archiveKnown.get(collection) ?? existingByKey.keys());
      const tombstones = new Set(this.archiveTombstones.get(collection) ?? []);
      const originalKnown = new Set(known);
      const originalTombstones = new Set(tombstones);
      ${COUNTERS}.keyTableCalls += 1;
      ${COUNTERS}.keyTableMs += Number(process.hrtime.bigint() - __keyTablesStarted) / 1e6;
`;
const archiveProbe = `      const __keyTablesStarted = process.hrtime.bigint();
      const known = this.archiveKnown.get(collection) ?? new Set(existingByKey.keys());
      const tombstones = this.archiveTombstones.get(collection) ?? new Set();
      ${COUNTERS}.keyTableCalls += 1;
      ${COUNTERS}.keyTableMs += Number(process.hrtime.bigint() - __keyTablesStarted) / 1e6;
`;

async function instrumentedRoot() {
  const counters = {
    wholeCheckCalls: 0, wholeCheckBytes: 0, wholeCheckMs: 0,
    stagedCalls: 0, shadowCalls: 0, shadowBytes: 0, shadowMs: 0, markerCalls: 0,
    keyTableCalls: 0, keyTableMs: 0,
  };
  globalThis[HOOK] = counters;
  const domain = instrument(REPO, 'lib/domain-storage.js', [
    ['wholeCheck', wholeCheckNeedle, wholeCheckProbe],
    ['stagedCheck', stagedNeedle, stagedProbe],
    ['shadow', shadowNeedle, shadowProbe],
    ['marker', markerNeedle, markerProbe],
  ]);
  const memory = instrument(REPO, 'lib/dockyard-domain/memory.js', [
    ['keyTables', archiveNeedle, archiveProbe],
    ['keyTablesBefore', archiveNeedleBefore, archiveProbeBefore],
  ]);
  // `domain-storage.js` imports the domain facade by path; point that import at
  // the instrumented memory module so both files are the instrumented pair.
  const indexSource = fs.readFileSync(path.join(REPO, 'lib/dockyard-domain/index.js'), 'utf8');
  assert.equal(indexSource.split('./memory.js').length - 1, 1, 'the domain facade must import memory.js once');
  const indexPath = path.join(REPO, 'lib/dockyard-domain', `.attribution-index-${process.pid}-${crypto.randomUUID()}.mjs`);
  fs.writeFileSync(indexPath, indexSource.replace('./memory.js', `./${path.basename(memory.path)}`), { mode: 0o600, flag: 'wx' });
  let source = fs.readFileSync(domain.path, 'utf8');
  const facade = `from './dockyard-domain/index.js'`;
  assert.equal(source.split(facade).length - 1, 1, 'domain-storage must import the domain facade once');
  fs.writeFileSync(domain.path, source.replace(facade, `from './dockyard-domain/${path.basename(indexPath)}'`));
  const cleanup = () => fs.rmSync(domain.path, { force: true });
  const cleanupAll = () => { cleanup(); fs.rmSync(memory.path, { force: true }); fs.rmSync(indexPath, { force: true }); };
  let module;
  try { module = await import(pathToFileURL(domain.path)); }
  finally { cleanup(); }
  return { openDomainStorage: module.openDomainStorage, counters, probes: [...domain.applied, ...memory.applied], cleanup: cleanupAll };
}

async function child(options) {
  const mode = String(options.mode ?? 'cold');
  const records = Number(options.records);
  const growth = Number(options.growth ?? 0);
  const fixture = path.resolve(String(options.fixture));
  const { openDomainStorage, counters, probes, cleanup } = await instrumentedRoot();
  const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
  const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-staged-save-'));
  const eventBridgePath = path.join(root, 'execution-events.jsonl');
  fs.copyFileSync(fixture, eventBridgePath);
  const open = async () => {
    const backend = new JsonStorageBackend(path.join(root, 'official'));
    const ctx = { emit() {}, on() { return () => {}; }, logger: { warn() {}, error() {} },
      storage: { backend: { get: () => backend } }, effect() {} };
    ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
    return { ctx, backend };
  };
  const memoryOf = () => ({
    rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed,
    external: process.memoryUsage().external, arrayBuffers: process.memoryUsage().arrayBuffers,
    maxRSS: process.resourceUsage().maxRSS,
  });
  try {
    const first = await open();
    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();
    let port = await openDomainStorage(first.ctx, { presetDir: root, eventBridgePath, eventBridgeKey: KEY });
    const cold = { wallMs: performance.now() - wallStart };
    const coldCpu = process.cpuUsage(cpuStart);
    cold.cpuMs = (coldCpu.user + coldCpu.system) / 1000;
    cold.maxRSS = process.resourceUsage().maxRSS;
    cold.memory = memoryOf();
    const afterCold = { ...counters };
    let growthResult = null;
    if (mode === 'growth') {
      assert.equal(fs.existsSync(path.join(root, 'event-log.checkpoint.json')), true,
        'the growth leg starts from a written checkpoint, which is what makes it a warm pass');
      assert.ok(growth > 0, '--growth must be a positive record count');
      await port.close();
      await first.backend.close();
      // The second pass starts with a full marker window loaded from the durable
      // document and absorbs only the appended records.
      await appendEvents(eventBridgePath, records + 1, growth);
      const second = await open();
      const growthCpuStart = process.cpuUsage();
      const growthWallStart = performance.now();
      port = await openDomainStorage(second.ctx, { presetDir: root, eventBridgePath, eventBridgeKey: KEY });
      growthResult = { wallMs: performance.now() - growthWallStart };
      const growthCpu = process.cpuUsage(growthCpuStart);
      growthResult.cpuMs = (growthCpu.user + growthCpu.system) / 1000;
      growthResult.maxRSS = process.resourceUsage().maxRSS;
      const flushed = await port.flush();
      growthResult.flush = flushed;
      growthResult.counters = Object.fromEntries(Object.keys(counters).map((key) => [key, counters[key] - afterCold[key]]));
      growthResult.windowMarkers = (() => {
        const durable = path.join(root, 'official', 'evolution_domain.json');
        const document = JSON.parse(fs.readFileSync(durable, 'utf8')).global;
        return document.aggregate.evolution.eventBridge.applied.length;
      })();
      await port.close();
      await second.backend.close();
    } else {
      await port.close();
      await first.backend.close();
    }
    return { mode, records, growth, probes, counters, cold, growthResult,
      fixtureBytes: fs.statSync(fixture).size };
  } finally {
    cleanup();
    fs.rmSync(root, { recursive: true, force: true });
    delete globalThis[HOOK];
  }
}

function runChild({ cwd, script, argv }) {
  const result = spawnSync(process.execPath, [script, ...argv], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`child failed (${cwd}): ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function runner(options) {
  const records = Number(options.records ?? 20000);
  const growth = Number(options.growth ?? 0);
  const mode = String(options.mode ?? 'cold');
  const samples = Number(options.samples ?? 3);
  assert.ok(Number.isSafeInteger(samples) && samples >= 2, '--samples must be at least 2');
  const baselineRoot = path.resolve(String(options['baseline-root'] ?? '/tmp/dsh-base-save-check'));
  assert.ok(fs.existsSync(path.join(baselineRoot, 'lib/domain-storage.js')), `baseline tree missing at ${baselineRoot}`);
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-staged-save-fixture-'));
  const fixture = path.join(fixtureDir, `${mode}-${records}${growth ? `+${growth}` : ''}.jsonl`);
  const rows = [];
  try {
    await makeFixture(fixture, records);
    const digest = sha256(fixture);
    for (let round = 1; round <= samples; round += 1) {
      // Alternate which side runs first so a warming machine cannot favour one
      // of them; each sample is its own process and its own temporary home.
      const order = round % 2 === 1 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
      for (const side of order) {
        const cwd = side === 'baseline' ? baselineRoot : REPO;
        const script = path.join(cwd, 'scripts/benchmarks/staged-save-attribution.mjs');
        assert.ok(fs.existsSync(script), `${side} must run its own copy of this harness (${script})`);
        assert.equal(sha256(script), sha256(SCRIPT), 'both sides must run identical harness bytes');
        const argv = ['--child', '--mode', mode, '--records', String(records), '--fixture', fixture];
        if (growth) argv.push('--growth', String(growth));
        const sample = runChild({ cwd: REPO, script, argv });
        assert.equal(sha256(fixture), digest);
        rows.push({ side, round, sample });
      }
    }
    const sources = {
      baseline: {
        commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: baselineRoot, encoding: 'utf8' }).stdout.trim(),
        domainStorage: sha256(path.join(baselineRoot, 'lib/domain-storage.js')),
        memory: sha256(path.join(baselineRoot, 'lib/dockyard-domain/memory.js')),
      },
      candidate: {
        commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim(),
        domainStorage: sha256(path.join(REPO, 'lib/domain-storage.js')),
        memory: sha256(path.join(REPO, 'lib/dockyard-domain/memory.js')),
      },
    };
    const summary = Object.fromEntries(['baseline', 'candidate'].map((side) => {
      const picked = rows.filter((row) => row.side === side).map((row) => row.sample);
      const coldOf = (key) => median(picked.map((sample) => sample.cold[key]));
      const counterOf = (key) => median(picked.map((sample) => sample.counters[key]));
      return [side, {
        wallMs: coldOf('wallMs'), cpuMs: coldOf('cpuMs'), maxRSS: coldOf('maxRSS'),
        heapUsed: median(picked.map((sample) => sample.cold.memory.heapUsed)),
        counters: Object.fromEntries(Object.keys(picked[0].counters).map((key) => [key, counterOf(key)])),
        probes: picked[0].probes,
        growth: mode === 'growth' ? {
          wallMs: median(picked.map((sample) => sample.growthResult.wallMs)),
          cpuMs: median(picked.map((sample) => sample.growthResult.cpuMs)),
          maxRSS: median(picked.map((sample) => sample.growthResult.maxRSS)),
          flush: picked[0].growthResult.flush,
          windowMarkers: picked[0].growthResult.windowMarkers,
          counters: Object.fromEntries(Object.keys(picked[0].growthResult.counters)
            .map((key) => [key, median(picked.map((sample) => sample.growthResult.counters[key]))])),
        } : null,
      }];
    }));
    const paired = rows.filter((row) => row.side === 'baseline').map((base) => {
      const cand = rows.find((row) => row.side === 'candidate' && row.round === base.round).sample;
      return {
        round: base.round,
        wallDeltaMs: cand.cold.wallMs - base.sample.cold.wallMs,
        cpuDeltaMs: cand.cold.cpuMs - base.sample.cold.cpuMs,
        maxRSSDelta: cand.cold.maxRSS - base.sample.cold.maxRSS,
        growthWallDeltaMs: mode === 'growth' ? cand.growthResult.wallMs - base.sample.growthResult.wallMs : null,
        growthCpuDeltaMs: mode === 'growth' ? cand.growthResult.cpuMs - base.sample.growthResult.cpuMs : null,
      };
    });
    const output = {
      schema: 1,
      method: {
        mode, records, growth, samples,
        node: process.version, platform: `${process.platform}/${process.arch}`,
        sources,
        fixtureSha256: digest,
        fixtureBytes: fs.statSync(fixture).size,
        freshHomePerSample: true,
        officialDomainFacilityAndJsonStorageBackend: true,
        coldPassHasNoCheckpoint: mode === 'cold',
        counters: 'a temporary instrumented copy of each tree’s own lib/domain-storage.js and lib/dockyard-domain/memory.js; wholeCheck* counts assertTransactionSave(), shadow* counts the staged check’s document-without-window serialization, marker* counts one-off marker judgments, keyTable* counts archive key-table setup per archive append',
      },
      summary,
      paired,
      samples: rows,
    };
    const out = path.resolve(String(options.out ?? path.join(REPO, 'docs/performance/staged-save-attribution.json')));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(output, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ out, method: output.method, summary, paired }, null, 2)}\n`);
  } finally { fs.rmSync(fixtureDir, { recursive: true, force: true }); }
}

const options = argsOf(process.argv.slice(2));
if (options.child) process.stdout.write(`${JSON.stringify(await child(options))}\n`);
else await runner(options);
