// End-to-end A/B for one cold absorption of an event-log history, on the real port.
//
// A first start with no replay checkpoint absorbs every record the bridge log
// holds: `openDomainStorage()` authenticates each one, applies it through
// `EvolutionMemory.applyExecutionEvent()`, and every record that reaches a
// collection's hot limit is appended to that collection's cold archive inside the
// same transaction. Both halves of that per-record work are proportional to the
// history being absorbed, so this script measures the whole `openDomainStorage()`
// call and then the steady writes that follow it, against two source trees.
//
//   node --max-old-space-size=4096 scripts/benchmarks/archive-append-window.mjs \
//     --baseline-ref <git commit> --records 2000,12000,20000 --rounds 3 \
//     --out docs/performance/<name>.json
//
// The baseline is not a paraphrase: it is `git archive <commit> lib package.json
// package-lock.json` extracted into a temporary tree, with this repository's
// installed dependencies linked in. Both sides run in separate Node processes, in
// alternating order, on their own freshly seeded synthetic data root.
//
// `--aa` runs both sides on the working tree: whatever it reports for a size is
// the drift between two runs of identical code, which is this method's resolution.
// `--validate` instead compares the durable output of the two trees: the committed
// document, the whole archive tree and the replay checkpoint must be byte-identical
// after the same workload on a frozen clock.
//
// Every fixture is a temporary directory; nothing outside it is read or written.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const KEY = 'f'.repeat(64);

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}
const flag = name => process.argv.includes(`--${name}`);

const baselineRef = argument('baseline-ref');
const records = String(argument('records', '2000,12000,20000')).split(',').map(value => Number(value.trim()));
const rounds = Number(argument('rounds', '3'));
const observes = Number(argument('observes', '12'));
const flushes = Number(argument('flushes', '12'));
const out = argument('out');
const validate = flag('validate');
const aa = flag('aa');
const traceMode = flag('trace');

const median = values => {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function eventFixture(count) {
  return Array.from({ length: count }, (_, index) => {
    const sequence = index + 1;
    return {
      schema: 1,
      eventId: `evolution:measurement-completed:probe-experiment-${sequence}`,
      eventType: 'measurement-completed',
      experimentId: `probe-experiment-${sequence}`,
      proposalId: `probe-proposal-${sequence}`,
      target: 'plugin:probe',
      capability: 'plugin:probe',
      lineageId: 'plugin:probe',
      status: 'measured',
      measurement: { latency: 12, throughput: 100 },
      evidence: { summary: 'Synthetic measured evolution event' },
      canary: {},
      audit: { producer: 'dsh-evolution-orchestrator', at: '2026-10-07T00:00:00.000Z' },
    };
  });
}

/** Count the archive-path filesystem calls the absorption makes. */
function installTrace(root) {
  // The archive files are named `<state>.{collection}-archive.jsonl`, their sealed
  // segments live under `.segments/`, and the derived index is
  // `evolution-archive-index.json`; matching the names rather than the root keeps
  // the count independent of where the port puts the tree.
  const isArchive = target => typeof target === 'string' && target.includes(root)
    && (target.includes('-archive.jsonl') || target.includes('evolution-archive-index.json'));
  const counts = {};
  const restore = [];
  const bump = name => { counts[name] = (counts[name] ?? 0) + 1; };
  const wrap = (target, name, async) => {
    const original = target[name];
    if (typeof original !== 'function') return;
    target[name] = function (...callArguments) {
      // `mkdirSync` is called with the archive's directory, not with an archive
      // file name, and during the absorption its only caller is the archive
      // append (`#appendArchiveBytes()`), so it is counted unconditionally.
      if (name === 'mkdirSync' || isArchive(callArguments[0])) bump(name);
      return original.apply(this, callArguments);
    };
    restore.push(() => { target[name] = original; });
    void async;
  };
  for (const name of ['openSync', 'readSync', 'closeSync', 'mkdirSync', 'statSync', 'lstatSync', 'readdirSync', 'writeSync', 'appendFileSync', 'renameSync']) wrap(fs, name, false);
  for (const name of ['open', 'read', 'close', 'mkdir', 'stat', 'lstat', 'readdir', 'appendFile', 'writeFile', 'rename']) wrap(fs.promises, name, true);
  syncBuiltinESMExports();
  return {
    restore() {
      for (const undo of restore) undo();
      syncBuiltinESMExports();
      return counts;
    },
  };
}

/** One measurement process: `--child` runs the workload, the parent parses it. */
if (flag('child')) {
  const root = process.env.BENCH_ROOT;
  const recordCount = Number(process.env.BENCH_RECORDS);
  const observeSamples = Number(process.env.BENCH_OBSERVES);
  const flushSamples = Number(process.env.BENCH_FLUSHES);
  // A byte comparison needs the two runs to agree on everything the clock
  // decides: record timestamps, the index document's `updatedAt`, and the staged
  // names derived from a random identifier. Both sides run the same deterministic
  // sequence, so a difference that survives it is a real one.
  if (process.env.BENCH_FREEZE === '1') {
    const RealDate = Date;
    const frozen = RealDate.parse('2026-10-29T00:00:00.000Z');
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
  // Both sides are measured with the same signed envelopes, produced by the
  // working tree's own signer, so the fixture bytes are not a variable.
  const { signEventBridgeEnvelope } = await import(path.join(process.env.BENCH_ENVELOPE, 'lib', 'orchestrator.js'));
  const { openDomainStorage } = await import(path.join(process.env.BENCH_TREE, 'lib', 'domain-storage.js'));
  const resolveFromRepo = async name => {
    const { createRequire } = await import('node:module');
    const require = createRequire(`${REPO}/package.json`);
    const entry = require.resolve(name);
    return import(entry.startsWith('/') ? `file://${entry}` : entry);
  };
  const { DomainFacility } = await resolveFromRepo('@deepseek-ai/dsh-storage-domain');
  const { JsonStorageBackend } = await resolveFromRepo('@deepseek-ai/dsh-storage-json');

  const eventLog = path.join(root, 'execution-events.jsonl');
  const lines = eventFixture(recordCount).map((event, index) =>
    JSON.stringify(signEventBridgeEnvelope(event, { key: KEY, sequence: index + 1 })));
  fs.writeFileSync(eventLog, `${lines.join('\n')}\n`, { mode: 0o600 });
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  let port = null;
  try {
    // `--trace` counts the calls this round removes from the append path: one
    // `mkdir` per archived record became one per instance, and one of the three
    // `stat`s that asked the same file for its size went away. The torn-tail byte
    // read is unchanged (it cannot be skipped: see the write-up, §3.2). Counted
    // with a fixed counter per call, no stack and no payload inspection, and only
    // while the absorption runs.
    const trace = process.env.BENCH_TRACE === '1' ? installTrace(root) : null;
    // The absorption itself: no checkpoint exists yet, so this call authenticates
    // and applies every record, then closes the replay checkpoint.
    const cpu = process.cpuUsage();
    const started = performance.now();
    port = await openDomainStorage(ctx, { presetDir: root, eventBridgePath: eventLog, eventBridgeKey: KEY });
    const absorptionMs = performance.now() - started;
    const used = process.cpuUsage(cpu);
    const absorption = { wallMs: absorptionMs, cpuMs: (used.user + used.system) / 1000 };
    const traced = trace === null ? null : trace.restore();
    const steady = await port.flush();
    assert.deepEqual(steady, { applied: 0, duplicates: recordCount },
      'every absorbed record must be covered by the checkpoint the absorption wrote');

    // Steady writes: an ordinary observation is one transaction that archives the
    // row its hot window evicts. Distinct targets keep the store from
    // deduplicating them, so each sample really does archive a row.
    const observeRows = [];
    await port.observe({ type: 'agent/error', code: 'BENCH_WARM', message: 'warm', target: 'agent:warm' });
    for (let index = 0; index < observeSamples; index += 1) {
      const sampleCpu = process.cpuUsage();
      const sampleStart = performance.now();
      await port.observe({ type: 'agent/error', code: 'BENCH_ERROR', message: `sample ${index}`, target: `agent:${index}` });
      const usedBySample = process.cpuUsage(sampleCpu);
      observeRows.push({ wallMs: performance.now() - sampleStart, cpuMs: (usedBySample.user + usedBySample.system) / 1000 });
    }
    // Steady passes: no new records, so this is the per-step re-authentication.
    const flushRows = [];
    for (let index = 0; index < flushSamples; index += 1) {
      const sampleCpu = process.cpuUsage();
      const sampleStart = performance.now();
      await port.flush();
      const usedBySample = process.cpuUsage(sampleCpu);
      flushRows.push({ wallMs: performance.now() - sampleStart, cpuMs: (usedBySample.user + usedBySample.system) / 1000 });
    }

    if (process.env.BENCH_DUMP) {
      // Everything the absorption committed: the durable document, the whole
      // archive tree (active file, quarantine, sealed segments and the derived
      // index), the replay checkpoint and the query projections.
      const normalize = text => text.split(root).join('<root>');
      const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      const tree = {};
      const walk = (directory, prefix) => {
        for (const name of fs.readdirSync(directory).sort()) {
          const file = path.join(directory, name);
          const rel = prefix ? `${prefix}/${name}` : name;
          const stat = fs.lstatSync(file);
          if (stat.isSymbolicLink()) { tree[rel] = `link:${fs.readlinkSync(file)}`; continue; }
          if (stat.isDirectory()) { walk(file, rel); continue; }
          tree[rel] = digest(file);
        }
      };
      const archiveRoot = path.join(root, 'dockyard');
      if (fs.existsSync(archiveRoot)) walk(archiveRoot, '');
      const documentText = normalize(fs.readFileSync(path.join(root, 'official', 'evolution_domain.json'), 'utf8'));
      const checkpointFile = path.join(root, 'event-log.checkpoint.json');
      assert.ok(fs.existsSync(checkpointFile), 'the absorption must close a replay checkpoint');
      const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
      // The three fields below are per-run by construction, so they are compared
      // for their *presence and shape* rather than by value: dropping them from
      // the projection must not be the same thing as them being absent on both
      // sides, which is what a plain `deepEqual` of the remaining fields would
      // silently accept.
      assert.equal(typeof checkpoint.file?.dev, 'string', 'the checkpoint must name the log file device');
      assert.equal(typeof checkpoint.file?.ino, 'string', 'the checkpoint must name the log file inode');
      assert.match(String(checkpoint.mac), /^[0-9a-f]{64}$/, 'the checkpoint must be authenticated');
      fs.writeFileSync(process.env.BENCH_DUMP, JSON.stringify({
        archiveTree: Object.entries(tree).sort(([left], [right]) => (left < right ? -1 : 1)),
        document: crypto.createHash('sha256').update(documentText).digest('hex'),
        documentBytes: Buffer.byteLength(documentText),
        // `file.dev`/`file.ino`/`mac` bind the fixture's own log file identity and
        // are per-run by construction; every other field is content.
        checkpointContent: checkpoint === null ? null : {
          schema: checkpoint.schema, bytes: checkpoint.bytes, records: checkpoint.records, digest: checkpoint.digest,
          writer: checkpoint.writer, first: checkpoint.first, last: checkpoint.last, appliedDigest: checkpoint.appliedDigest,
        },
        checkpointFileIdentityPresent: typeof checkpoint.file?.dev === 'string' && typeof checkpoint.file?.ino === 'string',
        appliedMarkers: Object.keys((JSON.parse(documentText).global ?? JSON.parse(documentText)).applied ?? {}).length,
        stagedLeft: fs.existsSync(path.join(root, 'domain-staging')) ? fs.readdirSync(path.join(root, 'domain-staging')).length : 0,
        queries: Object.fromEntries(['observations', 'knowledge', 'proposals', 'experiments', 'cycles']
          .map(collection => [collection, crypto.createHash('sha256').update(JSON.stringify(port.query(collection, 50))).digest('hex')])),
      }));
    }
    const memory = process.memoryUsage();
    if (typeof global.gc === 'function') global.gc();
    const collected = process.memoryUsage();
    console.log(JSON.stringify({
      records: recordCount, absorption, observeRows, flushRows,
      // Peak RSS is the whole child's high-water mark, including the fixture and
      // the runtime; `retained` is the collected heap plus everything held
      // outside it. Neither is an attribution of the absorption phase alone.
      maxRss: process.resourceUsage().maxRSS * 1024,
      rss: memory.rss, retained: collected.heapUsed + collected.external,
      documentBytes: fs.statSync(path.join(root, 'official', 'evolution_domain.json')).size,
      trace: traced,
      logBytes: fs.statSync(eventLog).size,
      node: process.version, platform: `${process.platform}/${process.arch}`,
    }));
    await port.close();
    port = null;
  } finally {
    if (port) await port.close();
    await backend.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.exit(0);
}

/** Extract one tree from git into a temporary directory with the installed deps. */
function treeFrom(ref, label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `archive-append-window-${label}-`));
  const archive = execFileSync('git', ['archive', ref, 'lib', 'package.json', 'package-lock.json'], { cwd: REPO, maxBuffer: 1 << 28 });
  execFileSync('tar', ['-x', '-C', directory], { input: archive });
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
  return directory;
}

function runChild({ root, tree, recordCount, dump = null, traced = false }) {
  const stdout = execFileSync(process.execPath, ['--expose-gc', '--max-old-space-size=4096', fileURLToPath(import.meta.url), '--child'], {
    cwd: REPO,
    env: {
      ...process.env, BENCH_ROOT: root, BENCH_TREE: tree, BENCH_ENVELOPE: REPO,
      BENCH_RECORDS: String(recordCount), BENCH_OBSERVES: String(observes), BENCH_FLUSHES: String(flushes),
      BENCH_TRACE: traced ? '1' : '0',
      ...(dump ? { BENCH_DUMP: dump, BENCH_FREEZE: '1' } : {}),
    },
    maxBuffer: 1 << 28,
  });
  return JSON.parse(stdout.toString());
}

if (!baselineRef && !aa) {
  console.error('usage: archive-append-window.mjs --baseline-ref <commit> [--records 2000,12000,20000] [--rounds N] [--observes N] [--flushes N] [--out file] [--validate] [--aa]');
  process.exit(2);
}

const working = REPO;
// `--aa` is the control: both sides run the same tree, so whatever the A/B would
// report for a size is the drift between two runs of identical code. A change
// smaller than that is not a change this method can see.
/** The commit a ref resolves to, so a raw record names the tree it measured. */
function resolveRef(ref) {
  try { return execFileSync('git', ['rev-parse', `${ref}^{commit}`], { cwd: REPO, encoding: 'utf8' }).trim(); }
  catch { return null; }
}
const baseline = aa ? null : treeFrom(baselineRef, 'baseline');
const baselineTree = aa ? working : baseline;
const report = {
  baselineRef, aa,
  // `baselineRef` may be a name; the resolved commit is what a later reader can
  // actually check, and the candidate's own sources are pinned beside it.
  baselineSha: aa ? resolveRef('HEAD') : resolveRef(baselineRef),
  candidateSha: resolveRef('HEAD'),
  candidateSources: Object.fromEntries(['lib/dockyard-domain/memory.js', 'scripts/benchmarks/archive-append-window.mjs']
    .map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, file))).digest('hex')])),
  baseline: baseline ? path.basename(baseline) : 'same-tree(control)', working,
  records, rounds, observes, flushes,
  node: process.version, platform: `${process.platform}/${process.arch}`, runs: [], equivalence: [], summary: [],
};

try {
  if (validate) {
    for (const recordCount of records) {
      const dumps = {};
      for (const [label, tree] of [['baseline', baselineTree], ['working', working]]) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), `archive-append-window-validate-${label}-`));
        // The dump lives outside the fixture root: the child removes that root
        // when it finishes, and the dump is what it leaves for this process.
        const dump = path.join(os.tmpdir(), `archive-append-window-dump-${process.pid}-${label}-${recordCount}.json`);
        try {
          runChild({ root, tree, recordCount, dump });
          dumps[label] = JSON.parse(fs.readFileSync(dump, 'utf8'));
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
          fs.rmSync(dump, { force: true });
        }
      }
      assert.deepEqual(dumps.working.archiveTree, dumps.baseline.archiveTree,
        `${recordCount}: the committed archive tree must be byte-identical`);
      assert.equal(dumps.working.document, dumps.baseline.document,
        `${recordCount}: the committed document must be byte-identical`);
      assert.deepEqual(dumps.working.checkpointContent, dumps.baseline.checkpointContent,
        `${recordCount}: the replay checkpoint content must be identical`);
      assert.deepEqual(dumps.working.queries, dumps.baseline.queries, `${recordCount}: query projections must match`);
      assert.equal(dumps.working.appliedMarkers, recordCount, `${recordCount}: every record must have its marker`);
      assert.equal(dumps.working.stagedLeft, 0, `${recordCount}: no staged transaction may be left behind`);
      assert.equal(dumps.working.checkpointFileIdentityPresent, true, `${recordCount}: the checkpoint must carry the log file identity`);
      report.equivalence.push({
        records: recordCount, archiveFiles: dumps.working.archiveTree.length,
        checkpointFileIdentityPresent: dumps.working.checkpointFileIdentityPresent,
        document: dumps.working.document, documentBytes: dumps.working.documentBytes,
        appliedMarkers: dumps.working.appliedMarkers, stagedLeft: dumps.working.stagedLeft,
      });
      console.log(`validate ${recordCount}: identical archive tree (${dumps.working.archiveTree.length} files), document, checkpoint and queries`);
    }
  } else {
    for (let round = 0; round < rounds; round += 1) {
      for (const recordCount of records) {
        const order = round % 2 === 0 ? ['baseline', 'working'] : ['working', 'baseline'];
        for (const label of order) {
          const tree = label === 'baseline' ? baselineTree : working;
          const root = fs.mkdtempSync(path.join(os.tmpdir(), `archive-append-window-${label}-`));
          try {
            const child = runChild({ root, tree, recordCount, traced: traceMode });
            report.runs.push({ round, label, records: recordCount, ...child });
            console.log(`${label.padStart(8)} records=${String(recordCount).padStart(6)} round=${round} ` +
              `absorption=${child.absorption.wallMs.toFixed(1)}ms cpu=${child.absorption.cpuMs.toFixed(1)}ms ` +
              `observe=${median(child.observeRows.map(row => row.wallMs)).toFixed(2)}ms ` +
              `flush=${median(child.flushRows.map(row => row.wallMs)).toFixed(2)}ms maxRss=${(child.maxRss / 1048576).toFixed(1)}MiB`);
          } finally { fs.rmSync(root, { recursive: true, force: true }); }
        }
      }
    }
    report.summary = records.map(recordCount => {
      const row = { records: recordCount };
      for (const label of ['baseline', 'working']) {
        const runs = report.runs.filter(entry => entry.label === label && entry.records === recordCount);
        row[label] = {
          absorptionWallMs: median(runs.map(entry => entry.absorption.wallMs)),
          absorptionCpuMs: median(runs.map(entry => entry.absorption.cpuMs)),
          observeWallMs: median(runs.map(entry => median(entry.observeRows.map(sample => sample.wallMs)))),
          observeCpuMs: median(runs.map(entry => median(entry.observeRows.map(sample => sample.cpuMs)))),
          flushWallMs: median(runs.map(entry => median(entry.flushRows.map(sample => sample.wallMs)))),
          flushCpuMs: median(runs.map(entry => median(entry.flushRows.map(sample => sample.cpuMs)))),
          maxRssMiB: median(runs.map(entry => entry.maxRss)) / 1048576,
          retainedMiB: median(runs.map(entry => entry.retained)) / 1048576,
          documentBytes: runs[0].documentBytes,
          perRoundAbsorptionMs: runs.map(entry => Number(entry.absorption.wallMs.toFixed(1))),
          perRoundAbsorptionCpuMs: runs.map(entry => Number(entry.absorption.cpuMs.toFixed(1))),
          // Archive-path calls per absorbed record, from the traced round when
          // `--trace` was asked for.
          tracePerRecord: runs.every(entry => entry.trace !== null) ? Object.fromEntries(
            Object.keys(runs[0].trace ?? {}).length === 0 ? [] : [...new Set(runs.flatMap(entry => Object.keys(entry.trace)))]
              .map(name => [name, Number((median(runs.map(entry => entry.trace[name] ?? 0)) / recordCount).toFixed(3))])) : null,
        };
      }
      row.absorptionChange = (row.working.absorptionWallMs - row.baseline.absorptionWallMs) / row.baseline.absorptionWallMs;
      row.absorptionCpuChange = (row.working.absorptionCpuMs - row.baseline.absorptionCpuMs) / row.baseline.absorptionCpuMs;
      row.observeChange = (row.working.observeWallMs - row.baseline.observeWallMs) / row.baseline.observeWallMs;
      row.flushChange = (row.working.flushWallMs - row.baseline.flushWallMs) / row.baseline.flushWallMs;
      return row;
    });
    for (const row of report.summary) {
      console.log(`records=${String(row.records).padStart(6)}  absorption ${row.baseline.absorptionWallMs.toFixed(1)}→` +
        `${row.working.absorptionWallMs.toFixed(1)}ms (${(row.absorptionChange * 100).toFixed(2)}%)  ` +
        `cpu ${row.baseline.absorptionCpuMs.toFixed(1)}→${row.working.absorptionCpuMs.toFixed(1)}ms (${(row.absorptionCpuChange * 100).toFixed(2)}%)  ` +
        `observe ${row.baseline.observeWallMs.toFixed(2)}→${row.working.observeWallMs.toFixed(2)}ms (${(row.observeChange * 100).toFixed(2)}%)  ` +
        `flush ${row.baseline.flushWallMs.toFixed(2)}→${row.working.flushWallMs.toFixed(2)}ms (${(row.flushChange * 100).toFixed(2)}%)  ` +
        `maxRss ${row.baseline.maxRssMiB.toFixed(1)}→${row.working.maxRssMiB.toFixed(1)}MiB  ` +
        `retained ${row.baseline.retainedMiB.toFixed(1)}→${row.working.retainedMiB.toFixed(1)}MiB`);
    }
  }
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${out}`);
  }
} finally {
  if (baseline) fs.rmSync(baseline, { recursive: true, force: true });
}
