/**
 * R12 cross-entry sharing scan benchmark.
 *
 * Three subcommands:
 *   build   --fixture <dir> --records <n>
 *   measure --libroot <dir> --fixture <dir> --samples <n> --label <name> --out <json>
 *   run     --baseline <dir> --candidate <dir> --records <n> --rounds <r>
 *           --samples <n> --out <json>
 *
 * `build` creates a fully synthetic DSH home under <dir>: N promoted plugin
 * directories, a valid publication index with N records, and two consumer
 * states with N active rows each. Nothing reads a real DSH_HOME.
 *
 * `measure` is always a fresh process. It loads collectDiagnostics() and
 * readPublishedPluginReview() from --libroot (so baseline and candidate are
 * loaded from separate source trees), warms up twice, then times --samples
 * calls with wall clock, process.cpuUsage() and peak RSS. Only the calls are
 * inside the measured interval; fixture construction and module import are not.
 *
 * `run` alternates which side is measured first each round and spawns one
 * independent child process per side per round. The primary metric is CPU
 * (user + system); wall, RSS and heap delta are reported alongside.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

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
  const diagnostics = await import(pathToFileURL(path.join(root, 'lib/diagnostics.js')).href);
  const review = await import(pathToFileURL(path.join(root, 'lib/self-evolution-review.js')).href);
  return {
    collectDiagnostics: diagnostics.collectDiagnostics,
    readPublishedPluginReview: review.readPublishedPluginReview,
    resolveEvolutionPaths: diagnostics.resolveEvolutionPaths,
  };
}

function buildFixture(fixture, records) {
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.mkdirSync(fixture, { recursive: true });
  // Mirror resolveEvolutionPaths() exactly; it is host-free and identical in
  // both source trees, so the fixture can be built without importing either.
  const dataRoot = path.join(fixture, 'storages', 'evolution');
  const pluginRoot = path.join(dataRoot, 'promoted');
  fs.mkdirSync(path.join(dataRoot, 'shared-plugins', 'consumers'), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'event-bridge.key'), 'b'.repeat(64), { mode: 0o600 });
  const indexRecords = [];
  for (let i = 0; i < records; i += 1) {
    const id = `evolution-promoted-${i.toString(16).padStart(12, '0')}`;
    const pluginName = `dsh-${id}`;
    const source = `export const name = "p${i}";\nexport const inject = ["tools"];\nexport function apply() {}\n`;
    const manifestBytes = `${JSON.stringify({ name: pluginName, version: '0.1.0', type: 'module', main: 'lib/index.js' })}\n`;
    const pluginDir = path.join(pluginRoot, pluginName);
    fs.mkdirSync(path.join(pluginDir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'lib', 'index.js'), source);
    fs.writeFileSync(path.join(pluginDir, 'package.json'), manifestBytes);
    indexRecords.push({
      id, schemaVersion: 1, experimentId: `exp-r12-${i}`, pluginName,
      moduleUrl: pathToFileURL(path.join(pluginDir, 'lib', 'index.js')).href,
      entry: 'lib/index.js', sourceSha256: sha256(source), manifestSha256: sha256(manifestBytes),
      publisherProfile: 'desktop', approvedProfiles: ['acp', 'web'],
      stable: { committedAt: UPDATED_AT, promotionTimestamp: UPDATED_AT, decision: 'benefit', canary: { healthObservationWindow: 2, observations: 2, startupVerified: true } },
      requiredServices: ['tools'], serviceMembers: {}, requiredCapabilities: ['fiberLifecycle', 'fiberAwait', 'include', 'toolsRegistry'],
      hostOnly: true, host: HOST, revalidation: [], publishedAt: UPDATED_AT,
    });
  }
  const index = { schemaVersion: 1, kind: 'dsh-evolution-shared-plugins', updatedAt: UPDATED_AT, publisher: { profile: 'desktop' }, plugins: indexRecords };
  fs.writeFileSync(path.join(dataRoot, 'shared-plugins', 'published.json'), `${JSON.stringify(index, null, 2)}\n`);
  for (const profile of ['acp', 'web']) {
    const state = {
      schemaVersion: 1, kind: 'dsh-evolution-promoted-consumer', profile,
      updatedAt: UPDATED_AT, observedIndexUpdatedAt: UPDATED_AT, host: HOST, compositionPath: null,
      plugins: indexRecords.map((record) => ({ id: record.id, status: 'active', reason: null, activatedAt: UPDATED_AT })),
    };
    fs.writeFileSync(path.join(dataRoot, 'shared-plugins', 'consumers', `${profile}.json`), `${JSON.stringify(state, null, 2)}\n`);
  }
  return { dataRoot, pluginRoot, indexBytes: fs.statSync(path.join(dataRoot, 'shared-plugins', 'published.json')).size };
}

function fingerprint(value) {
  return sha256(JSON.stringify(value));
}

async function measure(args) {
  const { collectDiagnostics, readPublishedPluginReview, resolveEvolutionPaths } = await loadLib(args.libroot);
  const samples = Number(args.samples);
  const fixture = path.resolve(args.fixture);
  const paths = resolveEvolutionPaths({ dshHome: fixture });
  const doctorOptions = { dshHome: fixture, home: true, probe: { skipComposition: true } };
  const reviewOptions = { paths: { dataRoot: paths.dataRoot, pluginRoot: paths.pluginRoot }, host: HOST, usage: null, usageStatus: null };
  const doctorRun = async () => {
    const report = await collectDiagnostics(doctorOptions);
    const check = report.checks.find((entry) => entry.id === 'promotion.sharing');
    return { level: check?.level, status: check?.evidence?.status, recordCount: check?.evidence?.records?.length,
      orphanCount: check?.evidence?.orphanMounts?.length, activeCounts: check?.evidence?.consumers };
  };
  const reviewRun = async () => {
    const review = await readPublishedPluginReview(reviewOptions);
    return { status: review.status, indexStatus: review.indexStatus, summary: review.summary,
      records: review.records?.length, orphanMounts: review.orphanMounts?.length, truncated: review.truncated };
  };
  const results = {};
  for (const [name, run] of [['doctor', doctorRun], ['review', reviewRun]]) {
    let reference = null;
    for (let warm = 0; warm < 2; warm += 1) {
      const value = fingerprint(await run());
      if (reference === null) reference = value;
      assert.equal(value, reference, `${name}: warm-up result changed`);
    }
    const measured = [];
    for (let i = 0; i < samples; i += 1) {
      global.gc?.();
      const cpuStart = process.cpuUsage();
      const heapStart = process.memoryUsage().heapUsed;
      const start = performance.now();
      const value = await run();
      const elapsedMs = performance.now() - start;
      const cpu = process.cpuUsage(cpuStart);
      const valueHash = fingerprint(value);
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
      medianCpuMs: median(measured.map((sample) => sample.cpuMs)),
      medianWallMs: median(measured.map((sample) => sample.wallMs)),
      medianHeapDeltaBytes: median(measured.map((sample) => sample.heapDeltaBytes)),
      fingerprint: reference,
    };
  }
  const payload = {
    label: args.label, libroot: path.resolve(args.libroot), fixture, node: process.version,
    peakRssKiB: process.resourceUsage().maxRSS,
    results,
  };
  fs.writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`);
}

function child(libroot, fixture, label, samples, out) {
  const result = spawnSync(process.execPath, ['--max-old-space-size=4096', '--expose-gc', SCRIPT,
    'measure', '--libroot', libroot, '--fixture', fixture, '--samples', String(samples), '--label', label, '--out', out],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} child failed (${result.status}): ${result.stdout}\n${result.stderr}`);
}

async function orchestrate(args) {
  const rounds = Number(args.rounds);
  const samples = Number(args.samples);
  const records = Number(args.records);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r12-sharing-runs-'));
  const built = buildFixture(args.fixture, records);
  const runs = [];
  for (let round = 0; round < rounds; round += 1) {
    const order = round % 2 === 0 ? [['baseline', args.baseline], ['candidate', args.candidate]]
      : [['candidate', args.candidate], ['baseline', args.baseline]];
    const perRound = {};
    for (const [label, libroot] of order) {
      const out = path.join(tmp, `r${round}-${label}.json`);
      child(libroot, args.fixture, label, samples, out);
      const payload = JSON.parse(fs.readFileSync(out, 'utf8'));
      assert.equal(payload.label, label);
      perRound[label] = payload;
    }
    runs.push({
      round,
      order: order.map(([label]) => label),
      baseline: summarize(perRound.baseline),
      candidate: summarize(perRound.candidate),
      fingerprintsEqual: ['doctor', 'review'].every((name) =>
        perRound.baseline.results[name].fingerprint === perRound.candidate.results[name].fingerprint),
    });
  }
  const summary = {};
  for (const name of ['doctor', 'review']) {
    const baseCpu = runs.map((run) => run.baseline[name].medianCpuMs);
    const candCpu = runs.map((run) => run.candidate[name].medianCpuMs);
    const baseWall = runs.map((run) => run.baseline[name].medianWallMs);
    const candWall = runs.map((run) => run.candidate[name].medianWallMs);
    const pairedCpu = runs.map((run) => run.candidate[name].medianCpuMs - run.baseline[name].medianCpuMs);
    const pairedWall = runs.map((run) => run.candidate[name].medianWallMs - run.baseline[name].medianWallMs);
    summary[name] = {
      baselineCpuMedianOfRounds: median(baseCpu), candidateCpuMedianOfRounds: median(candCpu),
      baselineWallMedianOfRounds: median(baseWall), candidateWallMedianOfRounds: median(candWall),
      cpuPairedDifferences: pairedCpu, wallPairedDifferences: pairedWall,
      cpuPairedMedian: median(pairedCpu), wallPairedMedian: median(pairedWall),
      cpuRelativeChangePct: (median(pairedCpu) / median(baseCpu)) * 100,
      wallRelativeChangePct: (median(pairedWall) / median(baseWall)) * 100,
      baselinePeakRssKiB: runs.map((run) => run.baseline.peakRssKiB),
      candidatePeakRssKiB: runs.map((run) => run.candidate.peakRssKiB),
    };
  }
  const payload = {
    records, rounds, samples, node: process.version, platform: `${process.platform}/${process.arch}`,
    fixture: args.fixture, fixtureDetails: built,
    baselineSource: path.resolve(args.baseline), candidateSource: path.resolve(args.candidate),
    allFingerprintsEqual: runs.every((run) => run.fingerprintsEqual),
    runs, summary,
  };
  fs.writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify({ records, rounds, samples, allFingerprintsEqual: payload.allFingerprintsEqual, summary }, null, 2));
  fs.rmSync(tmp, { recursive: true, force: true });
}

function summarize(payload) {
  return {
    doctor: { medianCpuMs: payload.results.doctor.medianCpuMs, medianWallMs: payload.results.doctor.medianWallMs,
      medianHeapDeltaBytes: payload.results.doctor.medianHeapDeltaBytes, fingerprint: payload.results.doctor.fingerprint,
      samples: payload.results.doctor.samples },
    review: { medianCpuMs: payload.results.review.medianCpuMs, medianWallMs: payload.results.review.medianWallMs,
      medianHeapDeltaBytes: payload.results.review.medianHeapDeltaBytes, fingerprint: payload.results.review.fingerprint,
      samples: payload.results.review.samples },
    peakRssKiB: payload.peakRssKiB,
  };
}

const args = parseArgs();
const mode = args._[0];
if (mode === 'build') {
  const info = buildFixture(path.resolve(args.fixture), Number(args.records));
  console.log(JSON.stringify(info));
} else if (mode === 'measure') {
  await measure(args);
} else if (mode === 'run') {
  await orchestrate(args);
} else {
  throw new Error(`unknown mode: ${mode}`);
}
