#!/usr/bin/env node
// R13: long-running / scale-growth benchmark for shared-experience SQLite and
// the experience chain. Three parts:
//   curves  - single-side cost curves at 10k / 30k / 100k canonical rows and
//             500 / 2000 / 5000 revisions on one hot key (trend table).
//   ab      - alternating A/B (baseline source tree vs candidate worktree),
//             independent process per (round, side, workload, sample), CPU as
//             the main metric, wall / maxRSS / sqlite bytes as auxiliaries.
//   concurrency - real child processes as 2 / 4 simultaneous writers, both
//             sides, measuring throughput, retries and busy behaviour.
//
// Usage:
//   node scripts/benchmarks/r13-shared-experience-scale.mjs run --out <json>
//   node scripts/benchmarks/r13-shared-experience-scale.mjs worker  # internal
//
// All mutable fixtures use fs.mkdtempSync(os.tmpdir()). The script NEVER deletes
// a path supplied by the caller (--base-tree, --fixture); it only removes the
// private temporary roots it created itself. It never touches DSH_HOME.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(import.meta.dirname, '../..');
const BASE_COMMIT = 'a0380e5cf2761297ecd8ffe1c79e34865ac6baee';
const SCALES = [10000, 30000, 100000];
const HOT_SCALES = [500, 2000, 5000];
const ROUNDS = 3;
const SAMPLES = 2;

function parseArgs(argv) {
  const out = { mode: 'run', baseCommit: BASE_COMMIT, baseTree: null, rounds: ROUNDS, samples: SAMPLES, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === 'run' || a === 'worker' || a === 'build' || a === 'concurrency-worker') { out.mode = a; continue; }
    const name = a.startsWith('--') ? a.slice(2) : null;
    if (!name) throw new Error('unexpected arg ' + a);
    const value = argv[++i];
    if (value === undefined) throw new Error('missing value for ' + a);
    if (name === 'base-commit') out.baseCommit = value;
    else if (name === 'base-tree') out.baseTree = value;
    else if (name === 'rounds') out.rounds = Number(value);
    else if (name === 'samples') out.samples = Number(value);
    else if (name === 'out') out.out = value;
    else if (name === 'lib') out.lib = value;
    else if (name === 'workload') out.workload = value;
    else if (name === 'n') out.n = Number(value);
    else if (name === 'root') out.root = value;
    else if (name === 'fixture') out.fixture = value;
    else if (name === 'writes') out.writes = Number(value);
    else if (name === 'seed') out.seed = Number(value);
    else throw new Error('unknown option ' + a);
  }
  return out;
}

function freshTemp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
function cpuMs(since) { const c = process.cpuUsage(since); return (c.user + c.system) / 1000; }
function dbBytes(file) { try { return fs.statSync(file).size; } catch { return 0; } }

// --- worker (child process) -------------------------------------------------
const READ_WORKLOADS = new Set(['conclusions-nomatch', 'discover', 'recall', 'recall-none', 'recall-one', 'read-control']);
async function worker(opts) {
  const { openSharedExperience, experienceEventId } = await import(opts.lib + '/shared-experience.js');
  // Read workloads use a single caller-built fixture shared by both sides, so
  // wall-clock-derived fields and their effect on sort order are identical.
  const shared = Boolean(opts.fixture) && READ_WORKLOADS.has(opts.workload);
  const root = shared ? opts.fixture : freshTemp('r13-worker-');
  const store = openSharedExperience(root);
  const file = path.join(root, 'experience.sqlite');
  const warmUp = (n, prefix) => {
    for (let i = 0; i < n; i += 1) {
      store.recordFailure({ id: experienceEventId('warm', opts.seed, i), type: 'tool/error', code: 'ENOENT', target: prefix + i });
    }
  };
  const buildFixture = () => {
    if (opts.workload === 'conclusions-nomatch' || opts.workload === 'discover' || opts.workload === 'read-control') {
      warmUp(opts.n, 'tool:noise_');
    } else if (opts.workload === 'recall' || opts.workload === 'recall-none') {
      warmUp(Math.min(opts.n, 2500), 'tool:read_file_');
    } else if (opts.workload === 'recall-one') {
      // Exactly one candidate: one unique-token record, the rest noise. The
      // unique token makes subjectHit true only for that record (others have
      // overlap 1 < MIN_OVERLAP), so sortCandidates() gets one record and does
      // zero comparisons / zero orderingKey builds.
      warmUp(Math.min(opts.n, 2500) - 1, 'tool:noise_');
      store.recordFailure({ id: experienceEventId('unique', opts.seed), type: 'tool/error', code: 'ENOENT', target: 'tool:zzunique42' });
    }
    if (opts.workload === 'read-control') {
      store.recordConclusion({ experimentId: 'exp-' + opts.seed, decision: 'no-benefit', target: 'tool:hot',
        strategy: 's', strategyFingerprint: 'aaaaaaaaaaaaaaaa', occurredAt: new Date().toISOString(),
        applicability: { dsh: 'x', cordis: 'x', evolution: 'x' } }, 'origin');
    }
  };
  if (opts.mode === 'build') {
    buildFixture();
    store.close();
    process.stdout.write(JSON.stringify({ root }) + '\n');
    return;
  }
  if (!shared) buildFixture();
  let extra = null;
  const before = process.cpuUsage();
  const wallBefore = performance.now();
  if (opts.workload === 'writes') {
    const n = opts.n;
    for (let i = 0; i < n; i += 1) {
      store.recordFailure({ id: experienceEventId('w', opts.seed, i), type: 'tool/error', code: 'ENOENT', target: 'tool:target_' + i });
    }
    extra = { n };
  } else if (opts.workload === 'hot') {
    warmUp(300, 'tool:hot-seed-');
    const n = opts.n;
    for (let i = 0; i < n; i += 1) {
      store.recordFailure({ id: experienceEventId('h', opts.seed, i), type: 'tool/error', code: 'ENOENT', target: 'tool:hot', metrics: { attemptsSinceFailure: i } });
    }
    extra = { n };
  } else if (opts.workload === 'conclusions-nomatch') {
    // One production read on a target that has no conclusion: worst case, every
    // canonical body is visited by instr() through the revision index.
    extra = { read: store.findConclusions({ target: 'tool:never_existing_target_' + opts.seed, window: 500 }) };
  } else if (opts.workload === 'discover') {
    extra = { read: store.discover({ window: 500 }) };
  } else if (opts.workload === 'recall') {
    extra = { read: store.recall({ problem: 'read' }) };
  } else if (opts.workload === 'recall-none') {
    // No candidate matches: sortCandidates() receives zero records, so the lazy
    // key cache must build zero keys (same as baseline).
    extra = { read: store.recall({ problem: 'qqqzzz-not-present-anywhere' }) };
  } else if (opts.workload === 'recall-one') {
    // Exactly one candidate (unique subject token); zero sort comparisons.
    extra = { read: store.recall({ target: 'tool:zzunique42' }) };
  } else if (opts.workload === 'read-control') {
    // Unchanged path: a conclusion lookup that hits a row newer than the noise.
    extra = { read: store.findConclusions({ target: 'tool:hot', window: 500 }) };
  } else throw new Error('unknown workload ' + opts.workload);
  const cpu = cpuMs(before);
  const wall = performance.now() - wallBefore;
  const stats = store.stats();
  const maxRss = process.resourceUsage().maxRSS;
  const bytes = dbBytes(file);
  store.close();
  if (!shared) fs.rmSync(root, { recursive: true, force: true });
  const read = extra?.read;
  // Wall-clock-derived provenance fields differ between independently built
  // fixtures, so the cross-side fingerprint omits them. All other output fields
  // (including matches, records, counts and truncation) are compared byte for
  // byte; the raw samples keep the full unstripped values.
  const stripTimes = (value) => {
    if (Array.isArray(value)) return value.map(stripTimes);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value)
        .filter(([key]) => key !== 'firstSeen' && key !== 'lastSeen' && key !== 'updatedAt')
        .map(([key, item]) => [key, stripTimes(item)]));
    }
    return value;
  };
  const fingerprint = read
    ? createHash('sha256').update(JSON.stringify(stripTimes({
        scanned: read.scanned, considered: read.considered, scoped: read.scoped, truncated: read.truncated,
        count: read.count, matches: read.matches, records: read.records,
      }))).digest('hex')
    : null;
  process.stdout.write(JSON.stringify({
    workload: opts.workload, n: opts.n ?? null, seed: opts.seed, lib: path.basename(path.dirname(opts.lib)),
    cpuMs: +cpu.toFixed(4), wallMs: +wall.toFixed(4), maxRssKiB: maxRss,
    dbBytes: bytes, stats, fingerprint, ...(read ? { considered: read.considered, scanned: read.scanned } : {}),
  }) + '\n');
}

// --- runner helpers ---------------------------------------------------------
function spawnWorker(lib, env, args = [], mode = 'worker') {
  const r = spawnSync(process.execPath, ['--max-old-space-size=4096', SELF, mode,
    '--lib', lib, ...args], {
    encoding: 'utf8', env: { ...process.env, ...env }, timeout: 300000,
  });
  if (r.status !== 0) throw new Error('worker failed: ' + r.stderr + r.stdout);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
function buildFixture(lib, workload, n, seed, owned) {
  const built = spawnWorker(lib, {}, ['--workload', workload, '--n', String(n), '--seed', String(seed)], 'build');
  owned.push(built.root);
  return built.root;
}
function fileURLToPath() { return new URL(import.meta.url).pathname; }
const SELF = fileURLToPath();

function prepareBaseline(opts, ownedDirs) {
  if (opts.baseTree) {
    if (!fs.existsSync(opts.baseTree)) throw new Error('base tree does not exist: ' + opts.baseTree);
    return path.join(opts.baseTree, 'lib');
  }
  const dir = freshTemp('r13-baseline-');
  ownedDirs.push(dir);
  const r = spawnSync('git', ['archive', opts.baseCommit], { cwd: REPO, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error('git archive failed: ' + String(r.stderr));
  const tar = spawnSync('tar', ['-x', '-C', dir], { input: r.stdout, maxBuffer: 1 << 28 });
  if (tar.status !== 0) throw new Error('tar failed: ' + tar.stderr);
  try { fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules')); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  return path.join(dir, 'lib');
}

function measureCurve(lib, workload, n, seed, fixture) {
  const args = ['--workload', workload, '--n', String(n), '--seed', String(seed)];
  if (fixture) args.push('--fixture', fixture);
  return spawnWorker(lib, { R13_SEED: String(seed) }, args);
}

function runAB(baseLib, candLib, opts, owned) {
  const workloads = [
    { name: 'recall', n: 10000 },
    { name: 'recall-none', n: 10000 },
    { name: 'recall-one', n: 10000 },
    { name: 'hot', n: 1000 },
    { name: 'conclusions-nomatch', n: 10000 },
    { name: 'discover', n: 10000 },
  ];
  const samples = [];
  for (let round = 0; round < opts.rounds; round += 1) {
    // One fixture per read workload, built from one side and shared by both, so
    // time-derived fields cannot change ordering between the measured sides.
    const fixtures = {};
    for (const w of workloads) {
      if (READ_WORKLOADS.has(w.name)) fixtures[w.name] = buildFixture(candLib, w.name, w.n, round, owned);
    }
    const order = round % 2 === 0 ? [['A', baseLib], ['B', candLib]] : [['B', candLib], ['A', baseLib]];
    const pair = {};
    for (const [side, lib] of order) {
      const perWorkload = {};
      for (const w of workloads) {
        const values = [];
        let last = null;
        for (let s = 0; s < opts.samples; s += 1) {
          const value = measureCurve(lib, w.name, w.n, round * 1000 + s, fixtures[w.name]);
          values.push(value);
          last = value;
        }
        perWorkload[w.name] = {
          cpuMs: median(values.map((v) => v.cpuMs)), wallMs: median(values.map((v) => v.wallMs)),
          samples: values, fingerprint: last.fingerprint, dbBytes: last.dbBytes, stats: last.stats,
        };
      }
      pair[side] = perWorkload;
    }
    for (const w of workloads) {
      assertEqualFingerprint(pair.A[w.name].fingerprint, pair.B[w.name].fingerprint, `round ${round} ${w.name}`);
      assertDeepEqual(pair.A[w.name].stats, pair.B[w.name].stats, `round ${round} ${w.name} stats`);
    }
    samples.push({ round, order: order.map(([s]) => s).join(','), A: pair.A, B: pair.B });
  }
  const summary = {};
  for (const w of workloads) {
    const a = median(samples.map((s) => s.A[w.name].cpuMs));
    const b = median(samples.map((s) => s.B[w.name].cpuMs));
    summary[w.name] = { aCpuMs: a, bCpuMs: b, changePercent: +((b - a) / a * 100).toFixed(2),
      perPairDeltaMs: samples.map((s) => +(s.B[w.name].cpuMs - s.A[w.name].cpuMs).toFixed(4)) };
  }
  return { samples, summary };
}
function assertEqualFingerprint(a, b, label) { if (a !== b) throw new Error(`${label}: output fingerprints differ: ${a} != ${b}`); }
function assertDeepEqual(a, b, label) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label}: stats differ`); }

async function runConcurrency(baseLib, candLib, opts) {
  const results = {};
  for (const side of [['A', baseLib], ['B', candLib]]) {
    const [name, lib] = side;
    for (const writers of [2, 4]) {
      const root = freshTemp('r13-concurrency-');
      const perWriter = 250;
      const key = `${name}-${writers}`;
      const start = process.cpuUsage();
      const procs = [];
      for (let w = 0; w < writers; w += 1) {
        procs.push(new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['--max-old-space-size=4096', SELF, 'concurrency-worker',
            '--lib', lib, '--root', root, '--writes', String(perWriter), '--seed', String(w)],
            { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
          let stdout = ''; let stderr = '';
          child.stdout.on('data', (d) => { stdout += d; });
          child.stderr.on('data', (d) => { stderr += d; });
          const timer = setTimeout(() => child.kill('SIGKILL'), 300000);
          child.on('error', reject);
          child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) reject(new Error('concurrency worker failed (' + code + '): ' + stderr));
            else resolve(JSON.parse(stdout.trim().split('\n').pop()));
          });
        }));
      }
      const workers = await Promise.all(procs);
      const cpu = cpuMs(start);
      results[key] = {
        writers, perWriter, parentCpuMs: +cpu.toFixed(4),
        committed: workers.reduce((n, x) => n + x.committed, 0),
        busy: workers.reduce((n, x) => n + x.busy, 0), other: workers.reduce((n, x) => n + x.other, 0),
        workers,
      };
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  return results;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.mode === 'worker' || opts.mode === 'build') { await worker(opts); return; }
  if (opts.mode === 'concurrency-worker') {
    // Internal mode: dynamic import keeps the worker ESM.
    const mod = await import(pathToFileURL(path.join(opts.lib, 'shared-experience.js')).href);
    const { createHash } = await import('node:crypto');
    const root = opts.root;
    const store = mod.openSharedExperience(root);
    let committed = 0; let busy = 0; let other = 0;
    const started = process.cpuUsage();
    for (let i = 0; i < opts.writes; i += 1) {
      try {
        const r = i % 3 === 0
          ? store.recordDegradation({ id: mod.experienceEventId('deg', opts.seed, i), target: 'tool:read_file', kind: 'line-truncated' })
          : store.recordFailure({ id: mod.experienceEventId('c', opts.seed, i), type: 'tool/error', code: 'ENOENT', target: 'tool:write_' + (i % 5) });
        if (r?.committed) committed += 1;
      } catch (error) {
        if (error?.code === 'SQLITE_BUSY' || error?.errcode === 5 || String(error?.message).includes('BUSY')) busy += 1;
        else other += 1;
      }
    }
    const c = process.cpuUsage(started);
    store.close();
    process.stdout.write(JSON.stringify({ seed: opts.seed, writes: opts.writes, committed, busy, other, cpuMs: +((c.user + c.system) / 1000).toFixed(4) }) + '\n');
    void createHash;
    return;
  }

  const owned = [];
  try {
    const baseLib = prepareBaseline(opts, owned);
    const candLib = path.join(REPO, 'lib');
    const curves = {};
    for (const n of SCALES) {
      const row = {};
      for (const workload of ['conclusions-nomatch', 'discover', 'recall', 'writes', 'read-control']) {
        const fixture = READ_WORKLOADS.has(workload) ? buildFixture(candLib, workload, n, 0, owned) : undefined;
        row[workload] = measureCurve(candLib, workload, n, 0, fixture);
      }
      curves[String(n)] = row;
    }
    for (const n of HOT_SCALES) curves['hot-' + n] = { hot: measureCurve(candLib, 'hot', n, 0) };
    const ab = runAB(baseLib, candLib, opts, owned);
    const concurrency = await runConcurrency(baseLib, candLib, opts);
    const result = {
      method: 'R13 scale-growth benchmark. Main metric process.cpuUsage() (user+system). '
        + 'Independent child process per (round, side, workload, sample), alternating A,B / B,A; '
        + 'A = baseline ' + opts.baseCommit + ', B = candidate worktree. '
        + 'All fixtures are fresh mkdtemp roots; no DSH_HOME / real data touched. '
        + 'Curves are single-side (candidate) measurements at 3 scales; A/B compares the two changed paths '
        + 'and two unchanged controls. Fingerprints and stats are asserted equal per round. '
        + 'Concurrency uses real child processes sharing one store.',
      node: process.version, platform: process.platform + '-' + process.arch,
      baseCommit: opts.baseCommit, rounds: opts.rounds, samples: opts.samples,
      curves, ab, concurrency,
    };
    if (opts.out) {
      fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
      fs.writeFileSync(opts.out, JSON.stringify(result, null, 2) + '\n');
    }
    console.log(JSON.stringify({ curves: Object.fromEntries(Object.entries(curves).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([w, r]) => [w, r.cpuMs]))])), ab: ab.summary, concurrency }, null, 2));
  } finally {
    for (const dir of owned) fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
