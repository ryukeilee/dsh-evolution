// End-to-end A/B for the staged archive mirror, on the real port.
//
// Every domain write opens one transaction (see `docs/performance/archive-stage-io.md`):
// `installPending()` -> `mirrorArchives()` -> a staged memory load -> the work ->
// `changedArchiveFiles()` -> `syncStage()` -> commit -> install -> stage removal ->
// `hydrate()`. This script measures that whole sequence through
// `openDomainStorage()` on the official `DomainFacility` + `JsonStorageBackend`,
// against two source trees, and reports the per-transaction wall clock, CPU, file
// system calls and peak RSS for each.
//
// The baseline is not a paraphrase: it is `git archive <commit> lib package.json
// package-lock.json` extracted into a temporary tree, with this repository's
// installed dependencies linked in. Both sides run in separate Node processes, in
// alternating order, on their own freshly seeded synthetic data root.
//
//   node --max-old-space-size=4096 scripts/benchmarks/archive-mirror-lease.mjs \
//     --baseline-ref <git commit> --segments 0,64,1024,4096 --samples 7 --rounds 3 \
//     --out docs/performance/<name>.json
//
// `--validate` instead compares the two trees' durable output: after the same
// workload it hashes every committed file and asserts they are byte-identical.
// Every fixture is a temporary directory; nothing outside it is read or written.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}
const flag = name => process.argv.includes(`--${name}`);

const baselineRef = argument('baseline-ref');
const segments = String(argument('segments', '0,64,1024,4096')).split(',').map(value => Number(value.trim()));
const samples = Number(argument('samples', '7'));
const rounds = Number(argument('rounds', '3'));
const out = argument('out');
const validate = flag('validate');
const aa = flag('aa');
const activeBytes = Number(argument('active-bytes', '0'));
const warmTransactions = Number(argument('warm', '0'));

/** One measurement process: `--role child` runs the workload, the parent parses it. */
if (flag('child')) {
  const root = process.env.BENCH_ROOT;
  const childSegments = Number(process.env.BENCH_SEGMENTS);
  const childSamples = Number(process.env.BENCH_SAMPLES);
  // A byte comparison needs the two runs to agree on everything the clock
  // decides: the index document's `updatedAt`, record ids that embed an
  // identifier, and the staged names derived from it. Both sides run the same
  // deterministic sequence, so a difference that survives it is a real one.
  if (process.env.BENCH_FREEZE === '1') {
    const RealDate = Date;
    const frozen = RealDate.parse('2026-10-12T00:00:00.000Z');
    class FrozenDate extends RealDate {
      constructor(...value) { if (value.length === 0) super(frozen); else super(...value); }
      static now() { return frozen; }
    }
    Object.setPrototypeOf(FrozenDate, RealDate);
    globalThis.Date = FrozenDate;
    const cryptoModule = await import('node:crypto');
    const { syncBuiltinESMExports } = await import('node:module');
    let counter = 0;
    cryptoModule.default.randomUUID = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
    syncBuiltinESMExports();
  }
  const { openDomainStorage } = await import(process.env.BENCH_MODULE);
  const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
  const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

  // The fixture models a long-lived deployment: `cycles` already has
  // `childSegments` sealed segments and their index, and one `observe()` is an
  // ordinary write that touches none of them.
  const archiveRoot = path.join(root, 'dockyard');
  const archive = path.join(archiveRoot, 'state.json.cycles-archive.jsonl');
  const directory = `${archive}.segments`;
  fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const index = [];
  for (let i = 0; i < childSegments; i++) {
    const file = `segment-${String(i + 1).padStart(12, '0')}.jsonl`;
    const raw = JSON.stringify({ id: `cycle-${i}`, status: 'observed', recordedAt: '2026-08-26T12:00:00.000Z', summary: 'x'.repeat(1024) }) + '\n';
    fs.writeFileSync(path.join(directory, file), raw, { mode: 0o600 });
    index.push({ collection: 'cycles', file, sealed: true, checksumState: 'final',
      byteSize: Buffer.byteLength(raw), sha256: crypto.createHash('sha256').update(raw).digest('hex') });
  }
  fs.writeFileSync(path.join(archiveRoot, 'state.json.evolution-archive-index.json'),
    JSON.stringify({ schemaVersion: 1, segments: index }), { mode: 0o600 });
  // `--active-bytes` seeds an active observations archive that already exceeds the
  // rotation threshold, so the workload's first rotations happen while the sealed
  // history is large: the staged view has to materialize its borrowed directory
  // once and then own every entry it adds.
  const observations = path.join(archiveRoot, 'state.json.observations-archive.jsonl');
  if (Number(process.env.BENCH_ACTIVE_BYTES) > 0) {
    const row = JSON.stringify({ id: 'seed-000000', type: 'component/observation', severity: 'info',
      componentId: 'plugin:seed', recordedAt: '2026-08-26T12:00:00.000Z', payload: 'x'.repeat(200) }) + '\n';
    const count = Math.ceil(Number(process.env.BENCH_ACTIVE_BYTES) / row.length);
    const raw = row.repeat(count);
    fs.writeFileSync(observations, raw, { mode: 0o600 });
    index.push({ collection: 'observations', file: 'state.json.observations-archive.jsonl', sealed: false,
      checksumState: 'provisional', byteSize: Buffer.byteLength(raw), sha256: null });
    fs.writeFileSync(path.join(archiveRoot, 'state.json.evolution-archive-index.json'),
      JSON.stringify({ schemaVersion: 1, segments: index }), { mode: 0o600 });
  } else {
    fs.writeFileSync(archive, '', { mode: 0o600 });
  }

  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  let port;
  try {
    port = await openDomainStorage(ctx, { presetDir: root, eventBridgePath: path.join(root, 'events.jsonl'), eventBridgeKey: 'b'.repeat(64) });
    // A rotation workload needs distinct observations: the store deduplicates an
    // identical one, so the hot window would never overflow and never archive.
    const rotating = Number(process.env.BENCH_ACTIVE_BYTES) > 0;
    const target = index => rotating ? `tool:${index}` : 'tool:bench';
    await port.observe({ code: 'BENCH_ERROR', target: target('warm') }); // warm up
    const warm = [];
    for (let i = 0; i < Number(process.env.BENCH_WARM || 0); i++) {
      const start = performance.now();
      await port.observe({ code: 'BENCH_ERROR', target: target(i) });
      warm.push(performance.now() - start);
    }
    const results = [];
    const baselineRss = process.memoryUsage().rss;
    for (let i = 0; i < childSamples; i++) {
      const cpu = process.cpuUsage();
      const start = performance.now();
      await port.observe({ code: 'BENCH_ERROR', target: target(`sample-${i}`) });
      const elapsedMs = performance.now() - start;
      const used = process.cpuUsage(cpu);
      const memory = process.memoryUsage();
      // Peak RSS answers "how much did this workload need", and the heap V8
      // chooses depends on the allocation rate, so a much faster transaction can
      // end up with a larger *uncollected* heap for the same per-transaction
      // footprint. The number that compares footprints is the one taken after a
      // forced collection, outside the measured window.
      if (typeof global.gc === 'function') global.gc();
      results.push({ elapsedMs, cpuMs: (used.user + used.system) / 1000, rss: memory.rss,
        heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, external: memory.external,
        steadyRss: process.memoryUsage().rss });
    }
    if (process.env.BENCH_DUMP) {
      // Everything the transaction committed, plus the queries it answers with.
      const files = {};
      for (const name of fs.readdirSync(archiveRoot).sort()) {
        const file = path.join(archiveRoot, name);
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) { files[name] = `link:${fs.readlinkSync(file)}`; continue; }
        if (stat.isDirectory()) continue;
        files[name] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      }
      // The durable aggregate records the absolute path of the staged view that
      // wrote it, and the two sides run in different temporary roots. That path is
      // the fixture's, not the transaction's, so it is normalised before the
      // comparison (the same artifact `retention-archive-deletion` documents).
      const normalize = text => text.split(root).join('<root>');
      const document = crypto.createHash('sha256')
        .update(normalize(fs.readFileSync(path.join(root, 'official', 'evolution_domain.json'), 'utf8'))).digest('hex');
      const queries = {};
      for (const collection of ['cycles', 'observations', 'knowledge', 'proposals']) {
        queries[collection] = JSON.stringify(port.query(collection, 50));
      }
      const indexText = normalize(fs.readFileSync(path.join(archiveRoot, 'state.json.evolution-archive-index.json'), 'utf8'));
      fs.writeFileSync(process.env.BENCH_DUMP, JSON.stringify({ files, document, queries, archiveFiles: fs.readdirSync(directory).sort(), indexText, domainText: normalize(fs.readFileSync(path.join(root, 'official', 'evolution_domain.json'), 'utf8')) }));
    }
    await port.close();
    port = null;
    const observations = path.join(archiveRoot, 'state.json.observations-archive.jsonl.segments');
    const rotated = fs.existsSync(observations) ? fs.readdirSync(observations).filter(name => /^segment-[0-9]+\.jsonl$/.test(name)).length : 0;
    console.log(JSON.stringify({ segments: childSegments, samples: childSamples, results, baselineRss, warm, rotated,
      maxRss: process.resourceUsage().maxRSS * 1024, node: process.version, platform: `${process.platform}/${process.arch}` }));
  } finally {
    if (port) await port.close();
    await backend.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.exit(0);
}

/** Extract one tree from git into a temporary directory with the installed deps. */
function treeFrom(ref, label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `mirror-lease-${label}-`));
  const archive = execFileSync('git', ['archive', ref, 'lib', 'package.json', 'package-lock.json'], { cwd: REPO, maxBuffer: 1 << 28 });
  execFileSync('tar', ['-x', '-C', directory], { input: archive });
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
  return directory;
}

function runChild({ root, modulePath, segmentCount, sampleCount, dump = null }) {
  const started = performance.now();
  const stdout = execFileSync(process.execPath, ['--expose-gc', '--max-old-space-size=4096', fileURLToPath(import.meta.url), '--child'], {
    cwd: REPO,
    env: { ...process.env, BENCH_ROOT: root, BENCH_MODULE: modulePath, BENCH_SEGMENTS: String(segmentCount),
      BENCH_SAMPLES: String(sampleCount), BENCH_ACTIVE_BYTES: String(activeBytes), BENCH_WARM: String(warmTransactions),
      ...(dump ? { BENCH_DUMP: dump, BENCH_FREEZE: '1' } : {}) },
    maxBuffer: 1 << 28,
  });
  void started;
  return JSON.parse(stdout.toString());
}

const median = values => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};

if (!baselineRef && !aa) {
  console.error('usage: archive-mirror-lease.mjs --baseline-ref <commit> [--segments 0,64,...] [--samples N] [--rounds N] [--out file] [--validate]');
  process.exit(2);
}

const working = REPO;
// `--aa` is the control: both sides run the same tree, so whatever the A/B would
// report for it is the drift between two runs of identical code. A change smaller
// than that is not a change this method can see.
const baseline = aa ? null : treeFrom(baselineRef, 'baseline');
const baselineModule = aa ? path.join(working, 'lib', 'domain-storage.js') : path.join(baseline, 'lib', 'domain-storage.js');
const workingModule = path.join(working, 'lib', 'domain-storage.js');
const report = { baselineRef, aa, baseline: baseline ? path.basename(baseline) : 'same-tree(control)', working, segments, samples, rounds,
  node: process.version, platform: `${process.platform}/${process.arch}`, runs: [], equivalence: [] };

try {
  if (validate) {
    for (const segmentCount of segments) {
      const dumps = {};
      for (const [label, modulePath, tree] of [['baseline', baselineModule, baseline], ['working', workingModule, working]]) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), `mirror-lease-validate-${label}-`));
        // The dump lives outside the fixture root: the child removes that root
        // when it finishes, and the dump is what it leaves for this process.
        const dump = path.join(os.tmpdir(), `mirror-lease-dump-${process.pid}-${label}-${segmentCount}.json`);
        try {
          runChild({ root, modulePath, segmentCount, sampleCount: 2, dump });
          dumps[label] = JSON.parse(fs.readFileSync(dump, 'utf8'));
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
          fs.rmSync(dump, { force: true });
        }
      }
      // The committed archive tree, the committed document and every query
      // projection must be identical: this change may only stop paying for work,
      // not change what the transaction produces.
      if (process.env.BENCH_DEBUG_EQUIVALENCE === '1' && JSON.stringify(dumps.working.files) !== JSON.stringify(dumps.baseline.files)) {
        console.log('working files', JSON.stringify(dumps.working.files));
        console.log('baseline files', JSON.stringify(dumps.baseline.files));
        console.log('working index', dumps.working.indexText.slice(0, 200));
        console.log('baseline index', dumps.baseline.indexText.slice(0, 200));
      }
      assert.deepEqual(dumps.working.files, dumps.baseline.files, `${segmentCount}: the committed archive tree must be byte-identical`);
      assert.equal(dumps.working.document, dumps.baseline.document, `${segmentCount}: the committed document must be byte-identical`);
      assert.deepEqual(dumps.working.queries, dumps.baseline.queries, `${segmentCount}: query projections must match`);
      assert.deepEqual(dumps.working.archiveFiles, dumps.baseline.archiveFiles, `${segmentCount}: the sealed segment set must be unchanged`);
      report.equivalence.push({ segments: segmentCount, files: Object.keys(dumps.working.files).sort(),
        document: dumps.working.document, queries: crypto.createHash('sha256').update(JSON.stringify(dumps.working.queries)).digest('hex'),
        archiveFiles: dumps.working.archiveFiles.length });
      console.log(`validate ${segmentCount}: identical archive tree, document, queries and segment set`);
    }
  } else {
    for (let round = 0; round < rounds; round++) {
      for (const segmentCount of segments) {
        const order = round % 2 === 0 ? ['baseline', 'working'] : ['working', 'baseline'];
        for (const label of order) {
          const modulePath = label === 'baseline' ? baselineModule : workingModule;
          const root = fs.mkdtempSync(path.join(os.tmpdir(), `mirror-lease-${label}-`));
          try {
            const child = runChild({ root, modulePath, segmentCount, sampleCount: samples });
            report.runs.push({ round, label, segments: segmentCount, activeBytes, warm: warmTransactions, ...child });
            console.log(`${label.padStart(8)} segment=${String(segmentCount).padStart(5)} round=${round} ` +
              `median=${median(child.results.map(row => row.elapsedMs)).toFixed(3)}ms ` +
              `cpu=${median(child.results.map(row => row.cpuMs)).toFixed(3)}ms maxRss=${(child.maxRss / 1048576).toFixed(1)}MiB`);
          } finally { fs.rmSync(root, { recursive: true, force: true }); }
        }
      }
    }
    report.summary = segments.map(segmentCount => {
      const row = { segments: segmentCount };
      for (const label of ['baseline', 'working']) {
        const runs = report.runs.filter(entry => entry.label === label && entry.segments === segmentCount);
        row[label] = {
          wallMs: median(runs.map(entry => median(entry.results.map(sample => sample.elapsedMs)))),
          cpuMs: median(runs.map(entry => median(entry.results.map(sample => sample.cpuMs)))),
          maxRssMiB: median(runs.map(entry => entry.maxRss)) / 1048576,
          steadyRssMiB: median(runs.map(entry => median(entry.results.map(sample => sample.steadyRss)))) / 1048576,
          // The retained footprint is the collected heap plus everything the
          // runtime holds outside it. Peak RSS is reported too, but on a platform
          // that does not return collected pages it measures the highest heap V8
          // chose, which a faster loop raises without retaining anything.
          heapMiB: median(runs.map(entry => median(entry.results.map(sample => (sample.heapUsed + sample.external) / 1048576)))),
          perRound: runs.map(entry => Number(median(entry.results.map(sample => sample.elapsedMs)).toFixed(3))),
          warmMaxMs: runs.length ? Math.max(...runs.flatMap(entry => entry.warm ?? [])) : 0,
          warmMedianMs: runs.length ? median(runs.flatMap(entry => entry.warm ?? [0])) : 0,
        };
      }
      row.change = (row.working.wallMs - row.baseline.wallMs) / row.baseline.wallMs;
      row.cpuChange = (row.working.cpuMs - row.baseline.cpuMs) / row.baseline.cpuMs;
      return row;
    });
    for (const row of report.summary) {
      console.log(`segments=${String(row.segments).padStart(5)}  baseline=${row.baseline.wallMs.toFixed(3)}ms  ` +
        `working=${row.working.wallMs.toFixed(3)}ms  change=${(row.change * 100).toFixed(2)}%  ` +
        `cpu ${(row.cpuChange * 100).toFixed(2)}%  rss ${row.baseline.maxRssMiB.toFixed(1)}→${row.working.maxRssMiB.toFixed(1)}MiB ` +
        `heap ${row.baseline.heapMiB.toFixed(1)}→${row.working.heapMiB.toFixed(1)}MiB`);
    }
  }
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`wrote ${out}`);
  }
} finally {
  if (baseline) fs.rmSync(baseline, { recursive: true, force: true });
}
