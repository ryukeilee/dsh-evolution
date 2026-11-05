// Knowledge hot-window benchmark. Evaluation only: it materialises frozen copies
// of two plugin sources, builds a synthetic but schema-real evolution history
// with the released normalisation functions, and drives the real official
// `DomainFacility` / `JsonStorageBackend` through the public domain port.
//
//   node --max-old-space-size=4096 scripts/benchmarks/knowledge-hot-window.mjs \
//     --sizes 0,200,1000,5000,20000 --rounds 3 --samples 5 \
//     --out docs/performance/knowledge-hot-window.json
//
// A is the frozen baseline commit below, A-control is a second extraction of the
// same commit, and B is the working tree's `lib/`. The three run in separate
// child processes from byte-identical fixtures, alternating order every round.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const BASELINE_COMMIT = '70cb2d3';
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback;
const has = name => args.includes(`--${name}`);
const median = values => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const round = value => Math.round(Number(value) * 1000) / 1000;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = value => sha256(stableJson(value));

/** Stable JSON text: object keys sorted, array order preserved. */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const SIZES = option('sizes', '0,200,1000,5000,20000').split(',').map(Number);
const ROUNDS = Number(option('rounds', '3'));
const SAMPLES = Number(option('samples', '5'));
const CONCURRENT = Number(option('concurrent', '32'));
const FROZEN_NOW = Date.parse('2026-11-05T00:00:00.000Z');
const QUERY_COLLECTIONS = ['cycles', 'observations', 'proposals', 'experiments', 'promotions', 'outcomes', 'lineage', 'knowledge'];
const OBSERVATIONS = ['observations', 'knowledge', 'candidates', 'proposals', 'experiments', 'experimentRecords', 'journal',
  'selections', 'promotions', 'outcomes', 'cycles', 'lineage', 'learnings', 'strategies', 'strategyMutations', 'tombstones', 'diagnoses', 'gaps'];

const codeOf = index => {
  let text = '';
  let value = index;
  do { text = String.fromCharCode(65 + (value % 26)) + text; value = Math.floor(value / 26); } while (value > 0);
  return `HISTORY_${text}`;
};

// ---------------------------------------------------------------------------
// main: materialise sources and fixtures, spawn one child per job
// ---------------------------------------------------------------------------
if (!has('child')) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-hot-window-'));
  const sources = {};
  const materialize = (name, commit) => {
    const directory = path.join(temp, name);
    fs.mkdirSync(directory, { recursive: true });
    const archive = spawnSync('git', ['archive', commit, 'lib'], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(archive.status, 0, `git archive ${commit}: ${archive.stderr}`);
    const tar = spawnSync('tar', ['-x', '-C', directory], { input: archive.stdout, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(tar.status, 0, `tar extract ${name}: ${tar.stderr}`);
    fs.renameSync(path.join(directory, 'lib'), path.join(directory, 'source'));
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(directory, 'node_modules'));
    fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}\n');
    return path.join(directory, 'source');
  };
  const working = () => {
    const directory = path.join(temp, 'B');
    fs.mkdirSync(directory, { recursive: true });
    fs.cpSync(path.join(REPO, 'lib'), path.join(directory, 'source'), { recursive: true });
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(directory, 'node_modules'));
    fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}\n');
    return path.join(directory, 'source');
  };
  sources.A = materialize('A', BASELINE_COMMIT);
  sources['A-control'] = materialize('A-control', BASELINE_COMMIT);
  sources.B = working();
  const sourceHashes = {};
  for (const [name, directory] of Object.entries(sources)) {
    const files = {};
    const walk = (current, prefix) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
        const absolute = path.join(current, entry.name);
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(absolute, relative);
        else files[relative] = sha256(fs.readFileSync(absolute));
      }
    };
    walk(directory, '');
    sourceHashes[name] = { digest: digest(files), files: Object.keys(files).length };
  }

  // One master fixture per size, built with the released functions. Every child
  // copies it, so both sides start from byte-identical durable state.
  const fixtures = {};
  for (const size of SIZES) {
    const directory = path.join(temp, `fixture-${size}`);
    fs.mkdirSync(path.join(directory, 'dockyard'), { recursive: true });
    const state = await buildInlineFixture(sources.A, size);
    fs.writeFileSync(path.join(directory, 'dockyard', 'state.json'), JSON.stringify({ evolution: state }));
    fixtures[size] = directory;
  }

  const rows = [];
  for (const size of SIZES) {
    for (let roundIndex = 0; roundIndex < ROUNDS; roundIndex += 1) {
      const order = roundIndex % 2 ? ['B', 'A-control', 'A'] : ['A', 'A-control', 'B'];
      for (const side of order) {
        process.stderr.write(`size ${size} round ${roundIndex + 1} ${side}\n`);
        const child = spawnSync(process.execPath, ['--max-old-space-size=4096', fileURLToPath(import.meta.url),
          '--child', '--side', side, '--size', String(size), '--round', String(roundIndex),
          '--fixture', fixtures[size], '--source', sources[side], '--samples', String(SAMPLES), '--concurrent', String(CONCURRENT)],
        { cwd: REPO, encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
        assert.equal(child.status, 0, `${side} ${size}: ${child.stderr || child.error?.message}`);
        rows.push({ side, size, round: roundIndex + 1, ...JSON.parse(child.stdout) });
      }
    }
  }

  const scenarios = ['firstWrite', 'newSubject', 'coldRepeat', 'hotRepeat', 'concurrent', 'restartOpen', 'recall', 'query'];
  const summarize = size => {
    const bySide = {};
    for (const side of ['A', 'A-control', 'B']) {
      const selected = rows.filter(row => row.side === side && row.size === size);
      bySide[side] = Object.fromEntries(scenarios.map(scenario => [scenario, median(selected.map(row => row.scenarios[scenario].wallMs))]));
      bySide[side].cpuMs = Object.fromEntries(scenarios.map(scenario => [scenario, median(selected.map(row => row.scenarios[scenario].cpuMs))]));
      bySide[side].bytes = Object.fromEntries(scenarios.map(scenario => [scenario, median(selected.map(row => row.scenarios[scenario].writeBytes))]));
      bySide[side].transactions = Object.fromEntries(scenarios.map(scenario => [scenario, median(selected.map(row => row.scenarios[scenario].transactions))]));
      bySide[side].fsync = Object.fromEntries(scenarios.map(scenario => [scenario, median(selected.map(row => row.scenarios[scenario].fsync ?? 0))]));
      bySide[side].readSyncBytes = Object.fromEntries(scenarios.map(scenario => [scenario, median(selected.map(row => row.scenarios[scenario].readSyncBytes ?? 0))]));
      bySide[side].documentBytes = median(selected.map(row => row.partition.documentBytes));
      bySide[side].knowledgeArchiveBytes = median(selected.map(row => row.partition.knowledgeArchiveBytes));
      bySide[side].hotKnowledge = median(selected.map(row => row.partition.hotKnowledge));
      bySide[side].coldKnowledge = median(selected.map(row => row.partition.coldKnowledge));
      bySide[side].maxRssMiB = median(selected.map(row => row.maxRssKiB / 1024));
      bySide[side].rssDeltaMiB = Object.fromEntries(scenarios.map(scenario => [scenario, median(selected.map(row => (row.scenarios[scenario].rssAfter - row.scenarios[scenario].rssBefore) / 1024 / 1024))]));
    }
    const change = {};
    for (const scenario of scenarios) {
      change[scenario] = {
        wallPct: round((bySide.B[scenario] - bySide.A[scenario]) / bySide.A[scenario] * 100),
        cpuPct: round((bySide.B.cpuMs[scenario] - bySide.A.cpuMs[scenario]) / bySide.A.cpuMs[scenario] * 100),
        aaPct: round((bySide['A-control'][scenario] - bySide.A[scenario]) / bySide.A[scenario] * 100),
      };
    }
    // Logical state must be identical for every side; the partition may not.
    // The hot/cold partition is the change under test, so its raw digest is
    // reported but never compared. Everything a caller or a restart can observe
    // is: the merged complete history, every query, recall, the autonomous read
    // and the same reads after a restart.
    const comparable = ({ partitionDigest, afterRestartPartitionDigest, ...rest }) => rest;
    for (const row of rows.filter(candidate => candidate.size === size)) {
      const reference = rows.find(candidate => candidate.size === row.size && candidate.round === row.round && candidate.side === 'A');
      if (!reference) continue;
      assert.deepEqual(comparable(row.logical), comparable(reference.logical), `${row.side} ${row.size} round ${row.round}: logical state differs from A`);
    }
    return { bySide, change };
  };

  const output = {
    environment: {
      node: process.version, platform: `${process.platform}/${process.arch}`, cpus: os.cpus().length,
      loadStart: os.loadavg(),
      loadEnd: null,
      baselineCommit: BASELINE_COMMIT,
      protocol: { rounds: ROUNDS, samples: SAMPLES, concurrent: CONCURRENT, sizes: SIZES,
        order: 'round 0/2 A, A-control, B; round 1 B, A-control, A; fresh child process and copied fixture per job',
        fixture: 'synthetic committed state: 1 observation + 1 canonical knowledge row per history entry, built by the released normalisation functions; frozen clock and UUID sequence',
        firstWrite: 'one new-subject observe on the seeded over-limit document (legacy partition migration), then restart',
        steady: 'new subject, cold subject repeat, hot subject repeat, 32 concurrent observes',
        read: 'experience recall and knowledge query after the steady writes' },
    },
    sources: sourceHashes,
    summary: Object.fromEntries(SIZES.map(size => [size, summarize(size)])),
    rows,
  };
  output.environment.loadEnd = os.loadavg();
  const out = option('out', null);
  if (out) fs.writeFileSync(out, JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify({ environment: output.environment, sources: output.sources, summary: output.summary }, null, 2));
  fs.rmSync(temp, { recursive: true, force: true });
  process.exit(0);
}

// ---------------------------------------------------------------------------
// child: one side, one size, one round
// ---------------------------------------------------------------------------
const side = option('side');
const size = Number(option('size'));
const fixture = option('fixture');
const source = option('source');
const root = fs.mkdtempSync(path.join(os.tmpdir(), `khw-${side}-${size}-`));

// Deterministic clock and record ids for the measured writes, identical per side.
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...values) { if (values.length === 0) super(FROZEN_NOW); else super(...values); }
  static now() { return FROZEN_NOW; }
}
Object.setPrototypeOf(FrozenDate, RealDate);
globalThis.Date = FrozenDate;
const originalUuid = crypto.randomUUID;
let uuidCounter = 100000;
crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`;
syncBuiltinESMExports();

const counters = { reset() { this.values = {}; } };
counters.reset();
const counting = () => counters.values !== undefined;
const bump = (name, amount = 1) => { if (counting()) counters.values[name] = (counters.values[name] ?? 0) + amount; };
const restore = [];
const wrap = (object, name, factory) => {
  const original = object[name];
  restore.push(() => { object[name] = original; });
  object[name] = factory(original);
};
for (const name of ['mkdirSync', 'readFileSync', 'writeFileSync', 'writeSync', 'appendFileSync', 'fsyncSync', 'linkSync', 'renameSync', 'rmSync', 'statSync', 'lstatSync', 'readdirSync', 'openSync', 'closeSync', 'copyFileSync']) {
  wrap(fs, name, original => function (...values) {
    bump(name);
    if (name === 'readSync') bump('readSyncBytes', original.apply(this, values));
    return original.apply(this, values);
  });
}
wrap(fs.promises, 'open', original => async function (...values) {
  bump('async.open');
  const handle = await original.apply(this, values);
  for (const method of ['writeFile', 'sync', 'datasync', 'readFile', 'close']) {
    const saved = handle[method];
    handle[method] = function (...inputs) {
      bump(`handle.${method}`);
      if (method === 'writeFile') bump('async.writeBytes', Buffer.byteLength(inputs[0]));
      if (method === 'readFile') bump('async.readBytes', inputs[0]?.length ?? 0);
      return saved.apply(this, inputs);
    };
  }
  return handle;
});
wrap(fs.promises, 'rename', original => async function (...values) { bump('async.rename'); return original.apply(this, values); });
wrap(fs.promises, 'rm', original => async function (...values) { bump('async.rm'); return original.apply(this, values); });
syncBuiltinESMExports();

const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');
const portModule = await import(pathToFileURL(path.join(source, 'domain-storage.js')).href);

const backend = new JsonStorageBackend(path.join(root, 'official'));
const context = { emit() {}, effect() {}, logger: { warn() {} }, on() { return () => {}; },
  storage: { backend: { get: () => backend } }, tools: { register() {} }, systemPrompt: { section() {} } };
context.storageDomain = new DomainFacility(context, { backend: 'json' });
const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'), eventBridgeKey: 'b'.repeat(64), startupDrift: false, domainSeed: true };
const domain = () => context.storageDomain.get('evolution_domain');
const set = portModule.openDomainStorage;
let port = null;

async function openPort() {
  const opened = await set(context, config);
  const originalSet = domain().global.set.bind(domain().global);
  domain().global.set = async value => { bump('domainSets'); return originalSet(value); };
  return opened;
}

const started = performance.now();
fs.rmSync(root, { recursive: true, force: true });
fs.cpSync(fixture, root, { recursive: true });
port = await openPort();
const openMs = performance.now() - started;

const scenarios = {};
async function measure(name, fn) {
  global.gc?.();
  const before = process.memoryUsage();
  counters.reset();
  const cpu = process.cpuUsage();
  const wallStart = performance.now();
  const value = await fn();
  const wallMs = performance.now() - wallStart;
  const used = process.cpuUsage(cpu);
  const after = process.memoryUsage();
  const io = { ...counters.values };
  scenarios[name] = {
    wallMs, cpuMs: (used.user + used.system) / 1000,
    writeBytes: io['async.writeBytes'] ?? 0,
    transactions: io.transactions ?? 0,
    domainSets: io.domainSets ?? 0,
    fsync: (io['handle.sync'] ?? 0) + (io.fsyncSync ?? 0),
    asyncRenames: io['async.rename'] ?? 0,
    readSyncBytes: io.readSyncBytes ?? 0,
    heapDeltaBytes: after.heapUsed - before.heapUsed,
    rssBefore: before.rss,
    rssAfter: after.rss,
    value,
  };
  return scenarios[name];
}

function trackStages() {
  const original = fs.mkdirSync;
  const seen = new Set();
  fs.mkdirSync = function (...values) {
    const name = String(values[0]);
    if (counting() && path.basename(name).startsWith('stage-') && !seen.has(name)) {
      seen.add(name);
      bump('transactions');
    }
    return original.apply(this, values);
  };
  restore.push(() => { fs.mkdirSync = original; });
  syncBuiltinESMExports();
}

trackStages();

const newSubject = suffix => ({ code: `SUBJECT_${suffix}`, type: 'agent/error', target: 'host' });
await measure('firstWrite', () => port.observe(newSubject('FIRST')));
await port.close();
const restartStarted = performance.now();
port = await openPort();
const restartOpenMs = performance.now() - restartStarted;

const steady = [];
for (let index = 0; index < SAMPLES; index += 1) {
  steady.push(await measure('newSubject', () => port.observe(newSubject(`STEADY_${index}`))));
}
const coldSample = [];
for (let index = 0; index < SAMPLES; index += 1) {
  coldSample.push(await measure('coldRepeat', () => port.observe({ code: codeOf(0), type: 'tool/error', target: 'host' })));
}
const hotSample = [];
for (let index = 0; index < SAMPLES; index += 1) {
  hotSample.push(await measure('hotRepeat', () => port.observe(newSubject(`STEADY_${SAMPLES - 1}`))));
}
await measure('concurrent', () => Promise.all(Array.from({ length: CONCURRENT }, (_, index) => port.observe(newSubject(`CONCURRENT_${index}`)))));
const recallSample = [];
for (let index = 0; index < SAMPLES; index += 1) {
  recallSample.push(await measure('recall', () => port.recall({ problem: 'Official operation failed', target: 'host' }, {})));
}
const querySample = [];
for (let index = 0; index < SAMPLES; index += 1) {
  querySample.push(await measure('query', () => port.query('knowledge', 50)));
}
for (const name of ['newSubject', 'coldRepeat', 'hotRepeat', 'recall', 'query']) {
  // Keep the last sample's per-scenario record and replace the loop value with
  // the median of the repeated samples.
  const samples = name === 'newSubject' ? steady : name === 'coldRepeat' ? coldSample : name === 'hotRepeat' ? hotSample : name === 'recall' ? recallSample : querySample;
  const keys = ['wallMs', 'cpuMs', 'writeBytes', 'transactions', 'domainSets', 'fsync', 'asyncRenames', 'readSyncBytes', 'heapDeltaBytes'];
  for (const key of keys) scenarios[name][key] = median(samples.map(sample => sample[key]));
  scenarios[name].rssBefore = median(samples.map(sample => sample.rssBefore));
  scenarios[name].rssAfter = median(samples.map(sample => sample.rssAfter));
  scenarios[name].value = samples.at(-1).value;
}
scenarios.restartOpen = { wallMs: restartOpenMs, cpuMs: 0, writeBytes: 0 };
scenarios.open = { wallMs: openMs };

const beforeRestart = await readLogicalState(root);
// Record ids are minted from the process-wide UUID stream, and a side that
// writes more stage/temp files consumes more of it. They are not part of the
// business state under comparison, so each observation id is projected onto its
// position in the complete history; every reference to one (knowledge sourceId,
// sourceRef.id, event ids) follows through the same map.
const idMap = new Map(beforeRestart.merged.observations.map((row, index) => [String(row.id), `observation:${index}`]));
const projected = value => canonicalizeUuids(projectIds(value, idMap));
const logical = {
  queries: Object.fromEntries(QUERY_COLLECTIONS.map(collection => {
    const result = port.query(collection, 50);
    return [collection, { count: result.count, entries: digest(projected(result.entries)) }];
  })),
  recall: recallSample.map(sample => digest(projected({ records: sample.value.records ?? sample.value, keys: sample.value.keys ?? null,
    scanned: sample.value.scanned ?? null, considered: sample.value.considered ?? null }))),
  autonomousObservations: digest(projected(port.autonomousObservations())),
  knowledgeKeys: digest(projected(recallKeys(port))),
};
await port.close();
const afterPort = await openPort();
const afterRestart = await readLogicalState(root);
const restartedQueries = Object.fromEntries(QUERY_COLLECTIONS.map(collection => {
  const result = afterPort.query(collection, 50);
  return [collection, { count: result.count, entries: digest(projected(result.entries)) }];
}));
const restartedRecall = digest(projected(afterPort.recall({ problem: 'Official operation failed', target: 'host' }, {})));
const restartedKeys = digest(projected(recallKeys(afterPort)));
await afterPort.close();
await backend.close();

const compact = value => Buffer.byteLength(JSON.stringify(value));
const composition = {
  document: compact({ aggregate: beforeRestart.evolution, applied: beforeRestart.applied }),
  aggregate: compact(beforeRestart.evolution),
  applied: compact(beforeRestart.applied),
  knowledge: compact(beforeRestart.hot.knowledge),
  observations: compact(beforeRestart.hot.observations),
  coldArchives: compact(beforeRestart.evolution.coldArchives ?? null),
  eventBridge: compact(beforeRestart.evolution.eventBridge ?? null),
  autonomous: compact(beforeRestart.evolution.autonomous ?? null),
};
const partition = partitionOf(beforeRestart);
if (process.env.KHW_DUMP) {
  fs.writeFileSync(`${process.env.KHW_DUMP}-${side}-${size}.json`, JSON.stringify({ knowledge: beforeRestart.merged.knowledge, observations: beforeRestart.merged.observations }, null, 2));
}
const output = {
  side, size,
  scenarios,
  partition: {
    hotKnowledge: beforeRestart.hot.knowledge.length,
    coldKnowledge: beforeRestart.archived.knowledge.length,
    hotObservations: beforeRestart.hot.observations.length,
    documentBytes: fs.statSync(path.join(root, 'official', 'evolution_domain.json')).size,
    knowledgeArchiveBytes: directoryBytes(path.join(root, 'dockyard')),
    composition,
  },
  logical: {
    before: logical,
    partitionDigest: digest({ hot: beforeRestart.hot, archived: beforeRestart.archived }),
    merged: Object.fromEntries(OBSERVATIONS.map(collection => [collection, digest(projected(beforeRestart.merged[collection]))])),
    afterRestartPartitionDigest: digest({ hot: afterRestart.hot, archived: afterRestart.archived }),
    restartQueries: restartedQueries,
    restartRecall: restartedRecall,
    restartKeys: restartedKeys,
  },
  maxRssKiB: process.resourceUsage().maxRSS,
};

globalThis.Date = RealDate;
crypto.randomUUID = originalUuid;
syncBuiltinESMExports();
for (const undo of restore.reverse()) undo();
syncBuiltinESMExports();
if (!process.env.KHW_KEEP) fs.rmSync(root, { recursive: true, force: true });
else console.error(`kept ${root}`);
console.log(JSON.stringify(output));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function recallKeys(activePort) {
  const record = activePort.recall({ problem: 'Official operation failed', target: 'host' }, {});
  return { records: (record.records ?? []).map(row => row.knowledgeKey ?? row.id ?? null), scanned: record.scanned ?? null, considered: record.considered ?? null };
}

function directoryBytes(directory) {
  let total = 0;
  for (const name of fs.readdirSync(directory).sort()) {
    const absolute = path.join(directory, name);
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) total += directoryBytes(absolute);
    else total += stat.size;
  }
  return total;
}

/** Durable hot state and every archive row on disk, without the plugin's merge. */
async function readLogicalState(directory) {
  const document = JSON.parse(fs.readFileSync(path.join(directory, 'official', 'evolution_domain.json'), 'utf8'));
  const evolution = document.global?.aggregate?.evolution ?? {};
  const hot = {};
  const archived = {};
  for (const collection of OBSERVATIONS) hot[collection] = Array.isArray(evolution[collection]) ? evolution[collection] : [];
  for (const collection of OBSERVATIONS) {
    const rows = [];
    const active = path.join(directory, 'dockyard', `state.json.${collection}-archive.jsonl`);
    const segments = `${active}.segments`;
    // The plugin's read order is every sealed segment first, in numeric order,
    // then the active file. Reading the active file first (as this helper used
    // to) made the merge see a fixture whose rows start in the middle of the
    // history.
    const sealed = fs.existsSync(segments)
      ? fs.readdirSync(segments).filter(name => /^segment-[0-9]+\.jsonl$/.test(name))
        .sort((left, right) => Number(left.match(/[0-9]+/)[0]) - Number(right.match(/[0-9]+/)[0]))
      : [];
    const files = [...sealed.map(name => path.join(segments, name)), ...(fs.existsSync(active) ? [active] : [])];
    for (const file of files) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        try { rows.push(JSON.parse(line)); } catch { rows.push({ unreadable: sha256(line) }); }
      }
    }
    archived[collection] = rows;
  }
  const merged = {};
  for (const collection of OBSERVATIONS) merged[collection] = mergeRows(archived[collection], hot[collection]);
  return { hot, archived, merged, evolution, applied: document.global?.applied ?? null };
}

/** `EvolutionMemory#mergeArchived` order and latest-wins semantics, read-only. */
function mergeRows(archived, hot) {
  const map = new Map();
  const anonymous = [];
  for (const row of [...archived, ...hot]) {
    if (row && typeof row === 'object' && row.id !== undefined && row.id !== null) map.set(String(row.id), row);
    else if (row && typeof row === 'object' && row.__evolutionTombstone !== 1) anonymous.push(row);
  }
  return [...map.values(), ...anonymous];
}

/**
 * Project the UUIDs a reference still names after the history no longer carries
 * that observation (a dropped source row). It is derived data: the id is minted
 * from the process-wide UUID stream, so two runs of the same workload differ
 * only by the stream offset. Tokens are numbered by first appearance in a
 * deterministic traversal, which is the same traversal for equal structures.
 */
function canonicalizeUuids(value, tokens = new Map()) {
  if (typeof value === 'string') return value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, uuid => {
    if (!tokens.has(uuid)) tokens.set(uuid, `uuid:${tokens.size}`);
    return tokens.get(uuid);
  });
  if (Array.isArray(value)) return value.map(item => canonicalizeUuids(item, tokens));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalizeUuids(value[key], tokens)]));
  }
  return value;
}

function projectIds(value, idMap) {
  if (typeof value === 'string') {
    let text = value;
    for (const [id, ordinal] of idMap) if (text.includes(id)) text = text.split(id).join(ordinal);
    return text;
  }
  if (Array.isArray(value)) return value.map(item => projectIds(item, idMap));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, projectIds(item, idMap)]));
  }
  return value;
}

function partitionOf(state) {
  return { hot: state.hot, archived: state.archived };
}

async function buildInlineFixture(baseline, count) {
  const { normalizeKnowledgeEvent, mergeKnowledgeEntry } = await import(pathToFileURL(path.join(baseline, 'dockyard-domain/knowledge.js')).href);
  const { projectObservation } = await import(pathToFileURL(path.join(baseline, 'domain-storage.js')).href);
  const now = new Date(FROZEN_NOW);
  const observations = [];
  const knowledge = [];
  for (let index = 0; index < count; index += 1) {
    const code = codeOf(index);
    const type = index % 2 ? 'agent/error' : 'tool/error';
    const observation = {
      ...projectObservation({ code, type, target: 'host' }),
      id: `obs-${index}`,
      domain: 'tool',
      patternKey: `official-tools:${type}:${code}`,
      observedAt: new Date(FROZEN_NOW + index).toISOString(),
      recordedAt: new Date(FROZEN_NOW + index).toISOString(),
      confidence: 0.7,
    };
    observations.push(observation);
    const event = normalizeKnowledgeEvent(observation, { sourceCollection: 'observations', now });
    if (event) knowledge.push(mergeKnowledgeEntry(null, event, { now }));
  }
  return { schema: 4, observations, knowledge, eventBridge: { schema: 1, applied: [] } };
}
