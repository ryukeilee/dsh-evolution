#!/usr/bin/env node
/**
 * Bounded consumer-session GC benchmark.
 *
 * Run with:
 *   node --max-old-space-size=4096 scripts/benchmarks/consumer-gc.mjs --synthetic 200 --runs 3
 *   node --max-old-space-size=4096 scripts/benchmarks/consumer-gc.mjs --clone <realConsumersDir> --runs 5
 *
 * The source directory is only ever read. The requested source is realpath'd
 * first, so a symlink passed to --clone cannot turn a work copy into a link to
 * the source. Every collection pass runs on a fresh `fs.cp` copy inside a
 * temporary root, validated with lstat/realpath before GC; nothing is written
 * under `~/.dsh`. Files copied from a real directory keep their mtimes, so the
 * 24h legacy window is measured against the original bytes. Symlink entries
 * inside the source stay links and are never followed by the inventory.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  CONSUMER_SESSION_GC_LIMITS,
  collectConsumerSessionGarbage,
  consumerSessionFileNames,
  defaultIsProcessAlive,
} from '../../lib/promoted-consumer-gc.js';

const DSH_HOME = path.resolve(os.homedir(), '.dsh');
const SESSION_RE = /^([a-z0-9-]+)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(cordis\.yml|lease\.json)$/;
const LIVE_SESSIONS = 20;
const RECENT_SESSIONS = 5;
const FOREIGN_SESSIONS = 5;
const UNPROVEN_SESSIONS = 5;
const temporaryRoots = new Set();

function cleanupTemporaryRoots() {
  for (const root of temporaryRoots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
  temporaryRoots.clear();
}
process.once('exit', cleanupTemporaryRoots);

function usage() {
  return [
    'Usage: node scripts/benchmarks/consumer-gc.mjs (--clone <dir> | --synthetic <N>) [--runs <k>] [--profile acp|web] [--dry-run] [--help]',
    '  --clone      Read-only source directory; all GC passes run on fresh temp copies',
    '  --synthetic  Generate N orphan sessions plus live/orphan-guard files in a temp fixture',
    '  --runs       Independent fresh-copy passes per scenario (default: 1)',
    '  --profile    Consumer profile used for GC (default: acp)',
    '  --dry-run    Decide without deleting; reports the keep scenario as primary',
    '  --help       Show this help',
  ].join('\n');
}

function parseArgs(argv) {
  let clone = null;
  let synthetic = null;
  let runs = 1;
  let profile = 'acp';
  let dryRun = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') { help = true; continue; }
    if (arg === '--dry-run') { dryRun = true; continue; }
    if (arg === '--clone' || arg === '--synthetic' || arg === '--runs' || arg === '--profile') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--clone') {
        if (clone !== null || synthetic !== null) throw new Error('--clone and --synthetic are mutually exclusive / single-use');
        clone = value;
      } else if (arg === '--synthetic') {
        if (clone !== null || synthetic !== null) throw new Error('--clone and --synthetic are mutually exclusive / single-use');
        if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`Invalid --synthetic value: ${value}`);
        synthetic = Number(value);
        if (!Number.isSafeInteger(synthetic)) throw new Error(`--synthetic out of safe integer range: ${value}`);
      } else if (arg === '--runs') {
        if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`Invalid --runs value: ${value}`);
        runs = Number(value);
        if (!Number.isSafeInteger(runs)) throw new Error(`--runs out of safe integer range: ${value}`);
      } else {
        if (!/^[a-z0-9-]+$/.test(value)) throw new Error(`Invalid --profile value: ${value}`);
        profile = value;
      }
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (help) return { help };
  if ((clone === null) === (synthetic === null)) throw new Error('Exactly one of --clone or --synthetic is required');
  return { help: false, clone, synthetic, runs, profile, dryRun };
}

/** Refuse any write target that resolves inside ~/.dsh (the source may be read). */
function assertWritableTarget(target) {
  const resolved = path.resolve(target);
  let dsh = DSH_HOME;
  try { dsh = fs.realpathSync(DSH_HOME); } catch {}
  const relative = path.relative(dsh, resolved);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error(`Refusing to write inside ${DSH_HOME}: ${resolved}`);
  }
  return resolved;
}

/** Fresh temp root per pass; every write target is checked against the guard. */
async function makeTempRoot(label) {
  const root = assertWritableTarget(await fsp.mkdtemp(path.join(os.tmpdir(), `consumer-gc-${label}-`)));
  temporaryRoots.add(root);
  return root;
}

async function copyInto(source, target) {
  assertWritableTarget(target);
  await fsp.cp(source, target, {
    recursive: true,
    preserveTimestamps: true,
    dereference: false,
    errorOnExist: true,
  });
}

/** Read-only inventory of a directory; never follows links or modifies anything. */
function inspectDirectory(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let files = 0;
  let symlinks = 0;
  let logicalBytes = 0;
  let sessionCompositions = 0;
  let sessionLeases = 0;
  for (const entry of entries) {
    // lstat, not stat: a link that merely looks like a session file must never
    // be counted as (or resolved to) a regular file.
    const stat = fs.lstatSync(path.join(dir, entry.name));
    if (stat.isSymbolicLink()) {
      symlinks += 1;
      continue;
    }
    if (!stat.isFile()) continue;
    files += 1;
    logicalBytes += stat.size;
    if (SESSION_RE.test(entry.name)) {
      if (entry.name.endsWith('.cordis.yml')) sessionCompositions += 1;
      else sessionLeases += 1;
    }
  }
  return {
    directoryEntries: entries.length,
    files,
    symlinks,
    sessionCompositions,
    sessionLeases,
    logicalBytes,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const result = sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(result * 1000) / 1000;
}

function summarizeDecisions(decisions) {
  const actions = { keep: 0, remove: 0 };
  const reasons = {};
  for (const decision of decisions) {
    actions[decision.action] = (actions[decision.action] ?? 0) + 1;
    reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1;
  }
  return { actions, reasons };
}

function compactCounts(result) {
  return {
    status: result.status,
    scanned: result.scanned,
    sessions: result.sessions,
    removedCompositions: result.removedCompositions,
    removedLeases: result.removedLeases,
    bytesReclaimed: result.bytesReclaimed,
    kept: result.kept,
    keptOtherProfile: result.keptOtherProfile,
    ignored: result.ignored,
    failures: result.failures,
    deferred: result.deferred,
    truncated: result.truncated,
  };
}

function deadPid() {
  const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  if (typeof child.pid !== 'number' || defaultIsProcessAlive(child.pid)) {
    throw new Error('Could not obtain a dead pid for the synthetic lease fixture');
  }
  return child.pid;
}

async function writeLease(dir, profile, sessionId, { pid = process.pid, hostname = os.hostname(), createdAt = new Date() } = {}) {
  const { lease } = consumerSessionFileNames(profile, sessionId);
  const document = {
    schemaVersion: 1,
    kind: 'dsh-evolution-consumer-session-lease',
    profile,
    sessionId,
    pid,
    hostname,
    createdAt: createdAt.toISOString(),
    processStartedAt: new Date(createdAt.getTime() - 10000).toISOString(),
  };
  await fsp.writeFile(path.join(dir, lease), `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
}

async function writeComposition(dir, profile, sessionId) {
  const { composition } = consumerSessionFileNames(profile, sessionId);
  await fsp.writeFile(path.join(dir, composition), `# synthetic ${profile} ${sessionId}\n`, { mode: 0o600 });
}

/** N orphans + a fixed set of live/protected files; used as a read-only fixture for each pass. */
async function buildSyntheticFixture(profile, orphans) {
  const root = await makeTempRoot('fixture');
  const dead = deadPid();
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  for (let index = 0; index < orphans; index += 1) {
    const sessionId = crypto.randomUUID();
    await writeComposition(root, profile, sessionId);
    if (index % 2 === 0) {
      await writeLease(root, profile, sessionId, { pid: dead });
    } else {
      const { composition } = consumerSessionFileNames(profile, sessionId);
      await fsp.utimes(path.join(root, composition), old, old);
    }
  }
  for (let index = 0; index < LIVE_SESSIONS; index += 1) {
    const sessionId = crypto.randomUUID();
    await writeComposition(root, profile, sessionId);
    await writeLease(root, profile, sessionId);
  }
  for (let index = 0; index < RECENT_SESSIONS; index += 1) {
    await writeComposition(root, profile, crypto.randomUUID());
  }
  for (let index = 0; index < FOREIGN_SESSIONS; index += 1) {
    const sessionId = crypto.randomUUID();
    await writeComposition(root, profile, sessionId);
    await writeLease(root, profile, sessionId, { hostname: 'foreign-host.invalid' });
  }
  for (let index = 0; index < UNPROVEN_SESSIONS; index += 1) {
    const sessionId = crypto.randomUUID();
    await writeComposition(root, profile, sessionId);
    const { lease } = consumerSessionFileNames(profile, sessionId);
    await fsp.writeFile(path.join(root, lease), '{ not json }\n', { mode: 0o600 });
  }
  const webId = crypto.randomUUID();
  await fsp.writeFile(path.join(root, `web.${webId}.cordis.yml`), '# other profile\n');
  await fsp.writeFile(path.join(root, `${profile}.json`), '{}\n');
  await fsp.writeFile(path.join(root, `${profile}.cordis.yml`), '# stable composition\n');
  await fsp.writeFile(path.join(root, `.consumer-benchmark.tmp`), 'partial\n');
  return root;
}

/** Readdir-only baseline: the collector's scan phase stats nothing outside the window. */
async function measureScan(dir) {
  const started = performance.now();
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).length;
  return { wallMs: performance.now() - started, entries: entries.length, files };
}

/**
 * Prove every pass operates on a real directory inside the temp root, never on
 * the source itself. A symlinked --clone source must never be followed.
 */
async function assertSafeWorkCopy(work, realTargetRoot, realSource) {
  const stat = await fsp.lstat(work);
  if (!stat.isDirectory()) {
    throw new Error(`Refusing GC: copy is not a real directory: ${work}`);
  }
  const realWork = await fsp.realpath(work);
  const relative = path.relative(realTargetRoot, realWork);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing GC: copy resolves outside the temporary root: ${realWork}`);
  }
  if (realWork === realSource) {
    throw new Error(`Refusing GC: copy resolves to the source directory: ${realWork}`);
  }
  return realWork;
}

async function runScenario({ source, realSource, realTargetRoot, runs, profile, dryRun, scenario }) {
  const samples = [];
  const collectorSamples = [];
  let representative = null;
  let representativeCounts = null;
  let representativeDecisionSummary = null;
  let before = null;
  let after = null;
  for (let pass = 0; pass < runs; pass += 1) {
    const work = path.join(realTargetRoot, `${scenario}-${pass}`);
    await copyInto(source, work);
    await assertSafeWorkCopy(work, realTargetRoot, realSource);
    before = inspectDirectory(work);
    let wallMs;
    let result;
    if (scenario === 'scan') {
      const scan = await measureScan(work);
      wallMs = scan.wallMs;
      result = {
        status: 'scan-only', scanned: scan.entries, sessions: null,
        removedCompositions: 0, removedLeases: 0, bytesReclaimed: 0,
        kept: { live: 0, recent: 0, unproven: 0, foreignHost: 0 },
        keptOtherProfile: 0, ignored: 0, failures: [], deferred: 0, truncated: false, decisions: [],
      };
    } else {
      const passDryRun = scenario === 'keep' ? true : dryRun;
      const started = performance.now();
      result = await collectConsumerSessionGarbage({ consumersDir: work, profile, dryRun: passDryRun });
      wallMs = performance.now() - started;
      collectorSamples.push(result.durationMs);
    }
    after = inspectDirectory(work);
    samples.push(wallMs);
    if (representative === null) representative = { pass, wallMs, durationMs: result.durationMs ?? null };
    if (scenario === 'delete' || scenario === 'keep') {
      const counts = compactCounts(result);
      const summary = summarizeDecisions(result.decisions);
      // Keep the pass whose wall time is the median for human-facing counts.
      if (representativeCounts === null || Math.abs(wallMs - median(samples)) < Math.abs(representative.wallMs - median(samples))) {
        representative = { pass, wallMs, durationMs: result.durationMs ?? null };
        representativeCounts = counts;
        representativeDecisionSummary = summary;
      }
    } else {
      representativeCounts = compactCounts(result);
      representativeDecisionSummary = summarizeDecisions(result.decisions);
    }
    await fsp.rm(work, { recursive: true, force: true });
  }
  return {
    scenario,
    runs,
    filesBefore: before.files,
    filesAfter: after.files,
    symlinksBefore: before.symlinks,
    symlinksAfter: after.symlinks,
    bytesBefore: before.logicalBytes,
    bytesAfter: after.logicalBytes,
    medianMs: median(samples),
    maxMs: Math.round(Math.max(...samples) * 1000) / 1000,
    samplesMs: samples.map(value => Math.round(value * 1000) / 1000),
    medianCollectorMs: collectorSamples.length > 0 ? median(collectorSamples) : null,
    representativePass: representative.pass,
    counts: representativeCounts,
    decisions: representativeDecisionSummary,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const targetRoot = await makeTempRoot('runs');
  const realTargetRoot = await fsp.realpath(targetRoot);
  let requestedSource = null;
  let source;
  let realSource;
  let sourceStats = null;
  let scenarios;
  if (args.clone !== null) {
    requestedSource = path.resolve(args.clone);
    if (!fs.existsSync(requestedSource)) throw new Error(`Clone source does not exist: ${requestedSource}`);
    // Copy from the resolved directory, never from a symlink to it: otherwise
    // fs.cp would create a link at the work path and GC could delete the source.
    realSource = await fsp.realpath(requestedSource);
    if (path.relative(realTargetRoot, realSource) === '') throw new Error('Clone source must not be a GC target');
    source = realSource;
    sourceStats = inspectDirectory(realSource); // read-only
    scenarios = [args.dryRun ? 'keep' : 'delete'];
  } else {
    source = await buildSyntheticFixture(args.profile, args.synthetic);
    realSource = await fsp.realpath(source);
    // A dry run never deletes anything, so there is no delete scenario to name.
    scenarios = args.dryRun ? ['scan', 'keep'] : ['scan', 'keep', 'delete'];
  }

  const results = {};
  for (const scenario of scenarios) {
    results[scenario] = await runScenario({
      source, realSource, realTargetRoot, runs: args.runs, profile: args.profile, dryRun: args.dryRun, scenario,
    });
  }

  const primary = results[args.dryRun ? 'keep' : 'delete'] ?? results.delete;
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    mode: args.clone !== null ? 'clone' : 'synthetic',
    profile: args.profile,
    source,
    requestedSource,
    sourceStats,
    dryRun: args.dryRun,
    runs: args.runs,
    limits: CONSUMER_SESSION_GC_LIMITS,
    filesBefore: primary.filesBefore,
    filesAfter: primary.filesAfter,
    bytesBefore: primary.bytesBefore,
    bytesAfter: primary.bytesAfter,
    medianMs: primary.medianMs,
    maxMs: primary.maxMs,
    counts: primary.counts,
    decisions: primary.decisions,
    scenarios: results,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`consumer-gc benchmark failed: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
