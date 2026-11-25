/**
 * R13 long-running / scale-growth benchmark for the cross-entry, diagnostics,
 * unified review, capability-usage and desktop task channel subsystem.
 *
 * Subcommands:
 *   build      --fixture <dir> --records <n> [--archive <n>] [--history-files <n> --history-lines <n>]
 *   run        --fixture <dir> --rounds <n> --samples <n> [--expect-records <n>] ...
 *   measure    --libroot <dir> --fixture <dir> --workloads <csv> --samples <n>
 *              --warmup <n> --label <name> --out <json>
 *   run        --baseline <dir> --candidate <dir> --fixture <dir>
 *              --workloads <csv> --rounds <r> --samples <n> --warmup <n> --out <json>
 *   concurrent --libroot <dir> --fixture <dir> --entries <n>
 *              --workloads <csv> --rounds <r> --out <json>
 *
 * Isolation contract (R12-4 lesson): `--fixture` is caller-supplied and is NEVER
 * deleted by this script. build only writes into a path that does not exist or is
 * an empty directory; any non-empty directory is refused and left untouched.
 * Every measurement is a fresh child process with an explicit 4096 MiB heap cap.
 *
 * The script measures the CURRENT tree on both sides (an A/A alternating run)
 * unless a patched `--candidate` tree is supplied. A/A establishes the machine
 * noise floor; candidate trees are used only to quantify the *upper bound* of
 * rejected optimizations, never to claim a safe saving.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const SCRIPT = import.meta.filename;
const HOST = Object.freeze({
  dsh: '0.2.2-rc.5', cordis: '4.1.0', include: '1.1.0', node: process.version,
  verifiedAt: '2026-01-02T00:00:00.000Z',
});
const UPDATED_AT = '2026-01-02T00:00:00.000Z';
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const parseArgs = () => {
  const out = { _: [] };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { out[argv[i].slice(2)] = argv[i + 1]; i += 1; }
    else out._.push(argv[i]);
  }
  return out;
};

async function loadLib(libroot) {
  const root = path.resolve(libroot);
  const sharing = await import(pathToFileURL(path.join(root, 'lib/promoted-sharing.js')).href);
  const review = await import(pathToFileURL(path.join(root, 'lib/self-evolution-review.js')).href);
  const diagnostics = await import(pathToFileURL(path.join(root, 'lib/diagnostics.js')).href);
  const usage = await import(pathToFileURL(path.join(root, 'lib/capability-usage.js')).href);
  return {
    readSharedIndex: sharing.readSharedIndex,
    reconcileSharedIndex: sharing.reconcileSharedIndex,
    readPromotedPlugin: sharing.readPromotedPlugin,
    readPublishedPluginReview: review.readPublishedPluginReview,
    collectDiagnostics: diagnostics.collectDiagnostics,
    readUsageProjection: usage.readUsageProjection,
    resolveEvolutionPaths: diagnostics.resolveEvolutionPaths,
  };
}

function sharedPathsFor(fixture) {
  const dataRoot = path.join(fixture, 'storages', 'evolution');
  return {
    dataRoot,
    pluginRoot: path.join(dataRoot, 'promoted'),
    archiveDir: path.join(dataRoot, 'promoted', 'archive'),
    sharedDir: path.join(dataRoot, 'shared-plugins'),
    indexPath: path.join(dataRoot, 'shared-plugins', 'published.json'),
  };
}

// ---------------------------------------------------------------------------
// fixture builder
// ---------------------------------------------------------------------------

function buildFixture(fixture, records, { archive = records, historyFiles = 0, historyLines = 0 } = {}) {
  const target = path.resolve(fixture);
  if (fs.existsSync(target)) {
    if (!fs.statSync(target).isDirectory()) throw new Error(`--fixture is not a directory: ${target}`);
    if (fs.readdirSync(target).length > 0) {
      throw new Error(`refusing to write into a non-empty --fixture directory (pass a new or empty path): ${target}`);
    }
  } else {
    fs.mkdirSync(target, { recursive: true });
  }
  const paths = sharedPathsFor(target);
  fs.mkdirSync(path.join(paths.sharedDir, 'consumers'), { recursive: true });
  fs.mkdirSync(paths.archiveDir, { recursive: true });
  fs.writeFileSync(path.join(paths.dataRoot, 'event-bridge.key'), 'b'.repeat(64), { mode: 0o600 });

  const indexRecords = [];
  for (let i = 0; i < records; i += 1) {
    const id = `evolution-promoted-${i.toString(16).padStart(12, '0')}`;
    const pluginName = `dsh-${id}`;
    const source = `export const name = "p${i}";\nexport const inject = ["tools"];\nexport function apply() {}\n`;
    const manifestBytes = `${JSON.stringify({ name: pluginName, version: '0.1.0', type: 'module', main: 'lib/index.js' })}\n`;
    const pluginDir = path.join(paths.pluginRoot, pluginName);
    fs.mkdirSync(path.join(pluginDir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'lib', 'index.js'), source);
    fs.writeFileSync(path.join(pluginDir, 'package.json'), manifestBytes);
    indexRecords.push({
      id, schemaVersion: 1, experimentId: `exp-r13-${i}`, pluginName,
      moduleUrl: pathToFileURL(path.join(pluginDir, 'lib', 'index.js')).href,
      entry: 'lib/index.js', sourceSha256: sha256(source), manifestSha256: sha256(manifestBytes),
      publisherProfile: 'desktop', approvedProfiles: ['acp', 'web'],
      stable: { committedAt: UPDATED_AT, promotionTimestamp: UPDATED_AT, decision: 'benefit', canary: { healthObservationWindow: 2, observations: 2, startupVerified: true } },
      requiredServices: ['tools'], serviceMembers: {}, requiredCapabilities: ['fiberLifecycle', 'fiberAwait', 'include', 'toolsRegistry'],
      hostOnly: true, host: HOST, revalidation: [], publishedAt: UPDATED_AT,
    });
  }
  const index = { schemaVersion: 1, kind: 'dsh-evolution-shared-plugins', updatedAt: UPDATED_AT, publisher: { profile: 'desktop' }, plugins: indexRecords };
  fs.writeFileSync(paths.indexPath, `${JSON.stringify(index, null, 2)}\n`);

  // Consumer states with one active row per record; this is the shape doctor
  // and review both project.
  for (const profile of ['acp', 'web']) {
    const state = {
      schemaVersion: 1, kind: 'dsh-evolution-promoted-consumer', profile,
      updatedAt: UPDATED_AT, observedIndexUpdatedAt: UPDATED_AT, host: HOST, compositionPath: null,
      plugins: indexRecords.map((record) => ({ id: record.id, status: 'active', reason: null, activatedAt: UPDATED_AT })),
    };
    fs.writeFileSync(path.join(paths.sharedDir, 'consumers', `${profile}.json`), `${JSON.stringify(state, null, 2)}\n`);
  }

  // Durable stable sidecars. The experimentIds are all present in the index, so
  // reconcile skips their contents and only pays readdir + sort + name filter.
  for (let i = 0; i < archive; i += 1) {
    const experimentId = `exp-r13-${i}`;
    const sidecar = {
      schemaVersion: 1, stableCommittedAt: UPDATED_AT, shareTargets: ['acp', 'web'],
      durable: { rowId: `row-${i}`, publication: { sourceSha256: indexRecords[i % Math.max(1, records)]?.sourceSha256 ?? sha256('x') } },
      canary: { healthObservationWindow: 2, observations: 2 }, decision: { kind: 'benefit' },
    };
    fs.writeFileSync(path.join(paths.archiveDir, `${experimentId}.evidence.json`), `${JSON.stringify(sidecar)}\n`);
  }

  // Optional cold-history JSONL files (the other O(history-bytes) doctor check).
  for (let f = 0; f < historyFiles; f += 1) {
    const lines = [];
    for (let l = 0; l < historyLines; l += 1) {
      lines.push(JSON.stringify({ seq: l, message: 'x'.repeat(256) }));
    }
    fs.writeFileSync(path.join(paths.dataRoot, `history-${f}.COLLECTION-archive.jsonl`), `${lines.join('\n')}\n`);
  }

  return {
    fixture: target,
    dataRoot: paths.dataRoot,
    pluginRoot: paths.pluginRoot,
    archiveDir: paths.archiveDir,
    records,
    archiveFiles: archive,
    indexBytes: fs.statSync(paths.indexPath).size,
    historyFiles,
    historyLines,
  };
}

// ---------------------------------------------------------------------------
// workload definitions (each returns a deterministic, fingerprintable result)
// ---------------------------------------------------------------------------

function makeWorkloads(lib, fixture) {
  const paths = sharedPathsFor(fixture);
  const doctorPaths = lib.resolveEvolutionPaths({ dshHome: fixture });
  const doctorOptions = { dshHome: fixture, home: true, probe: { skipComposition: true } };
  const reviewOptions = { paths: { dataRoot: paths.dataRoot, pluginRoot: paths.pluginRoot }, host: HOST };
  return {
    indexRead: async () => {
      const r = await lib.readSharedIndex(paths);
      return { status: r.status, count: r.records.length, invalid: r.invalid, digest: r.digest, updatedAt: r.updatedAt };
    },
    reconcileIdle: async () => {
      const r = await lib.reconcileSharedIndex({ paths, host: HOST, capabilities: null, maxRecords: 200 });
      return { status: r.status, published: r.published, unchanged: r.unchanged, skipped: r.skipped };
    },
    sourceVerify: async () => {
      const index = await lib.readSharedIndex(paths);
      const out = [];
      for (const record of index.records) {
        try {
          const plugin = await lib.readPromotedPlugin(paths, { pluginName: record.pluginName, moduleUrl: record.moduleUrl, entry: record.entry });
          out.push(`${record.id}:${plugin.sourceSha256 === record.sourceSha256}`);
        } catch { out.push(`${record.id}:error`); }
      }
      return { count: out.length, sample: out.slice(0, 3), allVerified: out.every((v) => v.endsWith('true')) };
    },
    review: async () => {
      const r = await lib.readPublishedPluginReview(reviewOptions);
      return { status: r.status, indexStatus: r.indexStatus, count: r.records?.length, truncated: r.truncated, summary: r.summary, orphanMounts: r.orphanMounts?.length };
    },
    doctor: async () => {
      const report = await lib.collectDiagnostics(doctorOptions);
      const check = report.checks.find((entry) => entry.id === 'promotion.sharing');
      return { level: check?.level, status: check?.evidence?.status, count: check?.evidence?.records?.length,
        orphanCount: check?.evidence?.orphanMounts?.length, activeCounts: check?.evidence?.consumers };
    },
    usageRead: async () => {
      const r = await lib.readUsageProjection({ dataRoot: paths.dataRoot });
      return { status: r.status, source: r.evidence?.status ?? null };
    },
  };
}

const fingerprint = (value) => sha256(JSON.stringify(value));

// ---------------------------------------------------------------------------
// measure (always a fresh child process)
// ---------------------------------------------------------------------------

async function measure(args) {
  const lib = await loadLib(args.libroot);
  const fixture = path.resolve(args.fixture);
  const workloads = makeWorkloads(lib, fixture);
  const names = args.workloads.split(',').map((v) => v.trim()).filter(Boolean);
  for (const name of names) if (!workloads[name]) throw new Error(`unknown workload: ${name}`);
  const samples = Number(args.samples);
  const warmup = Number(args.warmup ?? 2);
  const results = {};
  for (const name of names) {
    const run = workloads[name];
    let reference = null;
    for (let w = 0; w < warmup; w += 1) {
      const value = fingerprint(await run());
      if (reference === null) reference = value;
      assert.equal(value, reference, `${name}: warm-up result changed`);
    }
    const measured = [];
    let lastValue;
    for (let i = 0; i < samples; i += 1) {
      global.gc?.();
      const cpuStart = process.cpuUsage();
      const heapStart = process.memoryUsage().heapUsed;
      const start = performance.now();
      const value = await run();
      lastValue = value;
      const elapsedMs = performance.now() - start;
      const cpu = process.cpuUsage(cpuStart);
      const valueHash = fingerprint(value);
      // Warmup may be disabled for concurrent batches; the first measured
      // sample then establishes the reference the rest must match.
      if (reference === null) reference = valueHash;
      assert.equal(valueHash, reference, `${name}: measured result changed`);
      measured.push({
        cpuMs: (cpu.user + cpu.system) / 1000,
        wallMs: elapsedMs,
        heapDeltaBytes: process.memoryUsage().heapUsed - heapStart,
        result: valueHash,
      });
    }
    results[name] = {
      samples: measured,
      medianCpuMs: median(measured.map((s) => s.cpuMs)),
      medianWallMs: median(measured.map((s) => s.wallMs)),
      medianHeapDeltaBytes: median(measured.map((s) => s.heapDeltaBytes)),
      fingerprint: reference,
      // Every workload returns a small summary object (counts, status, level).
      // Keeping it lets `run` prove the fixture actually exercised the workload
      // instead of trusting a fingerprint of an empty set.
      value: lastValue,
    };
  }
  const payload = {
    label: args.label,
    libroot: path.resolve(args.libroot),
    fixture,
    node: process.version,
    peakRssKiB: process.resourceUsage().maxRSS,
    results,
  };
  fs.writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`);
}

function childMeasure(libroot, fixture, label, workloads, samples, warmup, out) {
  const result = spawnSync(process.execPath, ['--max-old-space-size=4096', '--expose-gc', SCRIPT,
    'measure', '--libroot', libroot, '--fixture', fixture, '--workloads', workloads,
    '--samples', String(samples), '--warmup', String(warmup), '--label', label, '--out', out],
  { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} child failed (${result.status}): ${result.stdout}\n${result.stderr}`);
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

// ---------------------------------------------------------------------------
// run: alternating A/B (or A/A) with one independent process per side per round
// ---------------------------------------------------------------------------

function summarizeSide(payload, names) {
  const out = { peakRssKiB: payload.peakRssKiB };
  for (const name of names) {
    out[name] = {
      medianCpuMs: payload.results[name].medianCpuMs,
      medianWallMs: payload.results[name].medianWallMs,
      medianHeapDeltaBytes: payload.results[name].medianHeapDeltaBytes,
      fingerprint: payload.results[name].fingerprint,
      samples: payload.results[name].samples,
    };
  }
  return out;
}

async function orchestrate(args) {
  const rounds = Number(args.rounds);
  const samples = Number(args.samples);
  const warmup = Number(args.warmup ?? 2);
  const names = args.workloads.split(',').map((v) => v.trim()).filter(Boolean);
  const expectedRecords = args['expect-records'] === undefined ? null : Number(args['expect-records']);
  if (expectedRecords !== null && (!Number.isInteger(expectedRecords) || expectedRecords < 1)) {
    throw new Error('--expect-records must be a positive integer');
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-cross-entry-runs-'));
  try {
    const runs = [];
    for (let round = 0; round < rounds; round += 1) {
      const order = round % 2 === 0
        ? [['A', args.baseline], ['B', args.candidate]]
        : [['B', args.candidate], ['A', args.baseline]];
      const perRound = {};
      for (const [label, libroot] of order) {
        const out = path.join(tmp, `r${round}-${label}.json`);
        perRound[label] = childMeasure(libroot, args.fixture, label, args.workloads, samples, warmup, out);
        assert.equal(perRound[label].label, label);
        if (expectedRecords !== null) {
          for (const name of ['indexRead', 'sourceVerify']) {
            const value = perRound[label].results[name]?.value;
            if (!value) continue;
            if (value.count !== expectedRecords) {
              throw new Error(`${name} saw ${value.count} records but the fixture was built with ${expectedRecords}`
                + ` (${label}, round ${round}); refusing to report a workload that did not run`);
            }
          }
        }
      }
      const fingerprintsEqual = names.every((name) =>
        perRound.A.results[name].fingerprint === perRound.B.results[name].fingerprint);
      runs.push({
        round,
        order: order.map(([label]) => label),
        A: summarizeSide(perRound.A, names),
        B: summarizeSide(perRound.B, names),
        fingerprintsEqual,
      });
    }
    const summary = {};
    for (const name of names) {
      const aCpu = runs.map((r) => r.A[name].medianCpuMs);
      const bCpu = runs.map((r) => r.B[name].medianCpuMs);
      const aWall = runs.map((r) => r.A[name].medianWallMs);
      const bWall = runs.map((r) => r.B[name].medianWallMs);
      const pairedCpu = runs.map((r) => r.B[name].medianCpuMs - r.A[name].medianCpuMs);
      const pairedWall = runs.map((r) => r.B[name].medianWallMs - r.A[name].medianWallMs);
      summary[name] = {
        aCpuMedianOfRounds: median(aCpu), bCpuMedianOfRounds: median(bCpu),
        aWallMedianOfRounds: median(aWall), bWallMedianOfRounds: median(bWall),
        cpuPairedDifferences: pairedCpu, wallPairedDifferences: pairedWall,
        cpuPairedMedian: median(pairedCpu), wallPairedMedian: median(pairedWall),
        cpuRelativeChangePct: (median(pairedCpu) / median(aCpu)) * 100,
        wallRelativeChangePct: (median(pairedWall) / median(aWall)) * 100,
        aPeakRssKiB: runs.map((r) => r.A.peakRssKiB), bPeakRssKiB: runs.map((r) => r.B.peakRssKiB),
      };
    }
    const payload = {
      method: 'alternating A/B, one independent child process per (round, side); CPU=user+system from process.cpuUsage; wall and heap/RSS auxiliary',
      records: expectedRecords, fixture: args.fixture,
      rounds, samples, warmup, workloads: names, node: process.version,
      platform: `${process.platform}/${process.arch}`,
      baselineLibroot: path.resolve(args.baseline), candidateLibroot: path.resolve(args.candidate),
      allFingerprintsEqual: runs.every((r) => r.fingerprintsEqual),
      runs, summary,
    };
    fs.writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`);
    if (!payload.allFingerprintsEqual) {
      const differed = runs.filter((r) => !r.fingerprintsEqual).map((r) => r.round);
      throw new Error(`A and B differ on the same fixture (rounds ${differed.join(', ')}); refusing to report an A/B`);
    }
    console.log(JSON.stringify({ fixture: args.fixture, rounds, samples,
      allFingerprintsEqual: payload.allFingerprintsEqual, summary }, null, 2));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// concurrent: three entry processes starting at the same time
// ---------------------------------------------------------------------------

function spawnConcurrentChild(libroot, fixture, workloads, out) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=4096', '--expose-gc', SCRIPT,
      'measure', '--libroot', libroot, '--fixture', fixture, '--workloads', workloads,
      '--samples', '1', '--warmup', '0', '--label', 'concurrent', '--out', out],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (status) => {
      if (status !== 0) return reject(new Error(`concurrent child failed (${status}): ${stdout}\n${stderr}`));
      resolve(JSON.parse(fs.readFileSync(out, 'utf8')));
    });
  });
}

async function concurrent(args) {
  const entries = Number(args.entries ?? 3);
  const rounds = Number(args.rounds ?? 3);
  const names = args.workloads.split(',').map((v) => v.trim()).filter(Boolean);
  const expectedRecords = args['expect-records'] === undefined ? null : Number(args['expect-records']);
  if (expectedRecords !== null && (!Number.isInteger(expectedRecords) || expectedRecords < 1)) {
    throw new Error('--expect-records must be a positive integer');
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-cross-entry-concurrent-'));
  try {
    const runs = [];
    for (let round = 0; round < rounds; round += 1) {
      const started = [];
      const processes = [];
      for (let e = 0; e < entries; e += 1) {
        const out = path.join(tmp, `r${round}-e${e}.json`);
        const t0 = performance.now();
        const p = spawnConcurrentChild(args.libroot, args.fixture, args.workloads, out);
        processes.push(p.then((payload) => ({ entry: e, wallMs: performance.now() - t0, payload })));
        started.push(e);
      }
      const batchStart = performance.now();
      const results = await Promise.all(processes);
      const batchWallMs = performance.now() - batchStart;
      runs.push({
        round,
        entries: started,
        batchWallMs,
        perEntry: results.map((r) => ({
          entry: r.entry, wallMs: r.wallMs, cpuMs: Object.fromEntries(names.map((n) => [n, r.payload.results[n].medianCpuMs])),
          peakRssKiB: r.payload.peakRssKiB,
        })),
        sumCpuMs: Object.fromEntries(names.map((n) => [n, results.reduce((acc, r) => acc + r.payload.results[n].medianCpuMs, 0)])),
      });
    }
    const payload = {
      method: 'N independent child processes started at once on the same read-only fixture; parent measures batch wall, children report CPU; no shared write lock in the read-only startup path',
      entries, rounds, workloads: names, fixture: args.fixture, node: process.version,
      platform: `${process.platform}/${process.arch}`, runs,
      batchWallMedianMs: median(runs.map((r) => r.batchWallMs)),
      sumCpuMedianMs: Object.fromEntries(names.map((n) => [n, median(runs.map((r) => r.sumCpuMs[n]))])),
    };
    fs.writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(JSON.stringify({ entries, rounds, batchWallMedianMs: payload.batchWallMedianMs,
      sumCpuMedianMs: payload.sumCpuMedianMs }, null, 2));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// rescan: the desktop task channel's 1500 ms safety rescan (pendingRequests)
// ---------------------------------------------------------------------------

async function protocolConstants() {
  const mod = await import(pathToFileURL(path.join(path.dirname(SCRIPT), '..', '..', 'lib/desktop-task-protocol.js')).href);
  return {
    schemaVersion: mod.SCHEMA_VERSION, protocol: mod.PROTOCOL_VERSION,
    taskIdPattern: mod.TASK_ID_PATTERN, createTaskState: mod.createTaskState,
    taskChannelPaths: mod.taskChannelPaths,
  };
}

function buildInbox(fixture, tasks, constants) {
  const target = path.resolve(fixture);
  if (fs.existsSync(target)) {
    if (!fs.statSync(target).isDirectory() || fs.readdirSync(target).length > 0) {
      throw new Error(`refusing to write into a non-empty --fixture directory: ${target}`);
    }
  } else fs.mkdirSync(target, { recursive: true });
  // The production layout: taskChannelPaths() puts the channel under
  // <dshHome>/storages/evolution/desktop-tasks, not directly under the home.
  const channel = constants.taskChannelPaths(target);
  const inbox = channel.inbox;
  const state = channel.state;
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  for (let i = 0; i < tasks; i += 1) {
    const id = `task-${String(i).padStart(8, '0')}`;
    fs.writeFileSync(path.join(inbox, `${id}.json`), `${JSON.stringify({ schemaVersion: constants.schemaVersion, protocol: constants.protocol, taskId: id, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() })}\n`);
    // The production state generator, so the fixture has the exact document
    // shape a real host writes (not a five-field stand-in).
    fs.writeFileSync(path.join(state, `${id}.json`), `${JSON.stringify(constants.createTaskState({ taskId: id }))}\n`);
  }
  return { inbox, state, tasks };
}

async function rescan(args) {
  const fixture = path.resolve(args.fixture);
  const constants = await protocolConstants();
  const inbox = constants.taskChannelPaths(fixture).inbox;
  const samples = Number(args.samples ?? 5);
  // The real production scanner, constructed through the real host factory. It
  // is the only way to time the exact read/parse/validation and failure
  // behaviour (a corrupt state file throws; a directory named *.json throws)
  // instead of a lookalike.
  const hostMod = await import(pathToFileURL(path.join(path.dirname(SCRIPT), '..', '..', 'lib/desktop-task-host.js')).href);
  const ctx = { logger: { info() {}, warn() {}, error() {}, debug() {} }, tools: { get() { return null; }, execute: async () => ({}) } };
  const host = hostMod.createDesktopTaskHost(ctx, { dshHome: fixture, scanIntervalMs: 3_600_000, approvalPollMs: 3_600_000 });
  const scan = async () => (await host.internals.pendingRequests()).length;
  await scan(); // warmup
  const rows = [];
  for (let i = 0; i < samples; i += 1) {
    global.gc?.();
    const cpuStart = process.cpuUsage();
    const start = performance.now();
    const value = await scan();
    const elapsedMs = performance.now() - start;
    const cpu = process.cpuUsage(cpuStart);
    rows.push({ cpuMs: (cpu.user + cpu.system) / 1000, wallMs: elapsedMs, pending: value });
  }
  try { await host.dispose(); } catch { /* already disposed */ }
  const out = {
    method: 'production createDesktopTaskHost(...).internals.pendingRequests() over a fixture whose states come from createTaskState(); default channel disabled, this is the explicit-enable idle cost',
    fixture, tasks: fs.readdirSync(inbox).length, node: process.version, rows,
    medianCpuMs: median(rows.map((r) => r.cpuMs)), medianWallMs: median(rows.map((r) => r.wallMs)),
    estimatedIdleCpuMsPerMinute: median(rows.map((r) => r.cpuMs)) * (60000 / 1500),
  };
  fs.writeFileSync(args.out, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ tasks: out.tasks, medianCpuMs: out.medianCpuMs,
    estimatedIdleCpuMsPerMinute: out.estimatedIdleCpuMsPerMinute }, null, 2));
}

// ---------------------------------------------------------------------------
// micro: isolate the O(bytes) sub-steps of a startup index read
// ---------------------------------------------------------------------------

async function micro(args) {
  const fixture = path.resolve(args.fixture);
  const paths = sharedPathsFor(fixture);
  const indexBytes = fs.readFileSync(paths.indexPath);
  const indexText = indexBytes.toString('utf8');
  const names = fs.readdirSync(paths.archiveDir);
  const SUFFIX = '.evidence.json';
  const ops = {
    readIndexBytes: () => { const b = fs.readFileSync(paths.indexPath); return b.length; },
    parseIndex: () => { const v = JSON.parse(indexText); return v.plugins.length; },
    indexSha256: () => sha256(indexBytes).length,
    // readdir is inside the timed op; the earlier version pre-read the names
    // outside the sample window and therefore did not measure what its label said.
    archiveSort: () => fs.readdirSync(paths.archiveDir).filter((n) => n.endsWith(SUFFIX)).sort().reverse().length,
  };
  const samples = Number(args.samples ?? 5);
  const out = { fixture, node: process.version, indexBytes: indexBytes.length, archiveNames: names.length, samples: {} };
  for (const [name, op] of Object.entries(ops)) {
    op(); // warmup
    const rows = [];
    for (let i = 0; i < samples; i += 1) {
      global.gc?.();
      const cpuStart = process.cpuUsage();
      const start = performance.now();
      const value = op();
      const elapsedMs = performance.now() - start;
      const cpu = process.cpuUsage(cpuStart);
      rows.push({ cpuMs: (cpu.user + cpu.system) / 1000, wallMs: elapsedMs, value });
    }
    out.samples[name] = {
      rows,
      medianCpuMs: median(rows.map((r) => r.cpuMs)),
      medianWallMs: median(rows.map((r) => r.wallMs)),
    };
  }
  fs.writeFileSync(args.out, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ fixture, indexBytes: out.indexBytes,
    mediansCpuMs: Object.fromEntries(Object.entries(out.samples).map(([k, v]) => [k, v.medianCpuMs])) }, null, 2));
}

const args = parseArgs();
const mode = args._[0];
if (mode === 'build') {
  const info = buildFixture(path.resolve(args.fixture), Number(args.records), {
    archive: args.archive === undefined ? Number(args.records) : Number(args.archive),
    historyFiles: Number(args['history-files'] ?? 0),
    historyLines: Number(args['history-lines'] ?? 0),
  });
  console.log(JSON.stringify(info));
} else if (mode === 'measure') {
  await measure(args);
} else if (mode === 'run') {
  await orchestrate(args);
} else if (mode === 'concurrent') {
  await concurrent(args);
} else if (mode === 'micro') {
  await micro(args);
} else if (mode === 'build-inbox') {
  const info = buildInbox(path.resolve(args.fixture), Number(args.tasks), await protocolConstants());
  console.log(JSON.stringify(info));
} else if (mode === 'rescan') {
  await rescan(args);
} else {
  throw new Error(`unknown mode: ${mode}`);
}
