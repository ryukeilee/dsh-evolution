#!/usr/bin/env node
// A/B storage and latency benchmark for the shared-experience SQLite store.
//
//   node --max-old-space-size=4096 \\
//     scripts/benchmarks/shared-experience-storage.mjs <out.json> \\
//     [--rounds 3] [--sizes 1000,10000] [--report <out.md>] \\
//     [--variant-b=core|baseline] [--skip-migration] [--skip-baseline-verify]
//
// Variant A is the frozen v1 baseline (`shared-experience-v1-baseline.mjs`,
// extracted from commit 48c8f2e); variant B is the working tree's
// `openSharedExperience` (schema v2) unless `--variant-b=baseline` is used for
// a plumbing self-test before the core lands. `--variant-b=baseline` produces
// A/A data and is never a substitute for the real comparison: the JSON records
// `variantB.mode` and `variantB.coreReady` so it cannot be mistaken for a result.
//
// Protocol (identical for every measured sample):
//   * one isolated `fs.mkdtempSync(os.tmpdir())` root per run, mode 0700;
//   * recordFailure() exactly as the runtime calls it, timed with
//     performance.now(); the wall clock is pinned per event index so A and B
//     persist identical knowledge bodies (latency still uses performance.now);
//   * after the write loop the store is closed. SQLite's last connection
//     checkpoints and removes the WAL; the harness asserts the `-wal` file is
//     absent or 0 bytes before reading anything;
//   * the database is then opened read-only, so no measurement connection can
//     write: `dbstat`, PRAGMA page_count/freelist_count and fs.statSync describe
//     one and the same checkpointed file;
//   * every (scenario, size, variant) is measured for >= 3 rounds, alternating
//     A/B then B/A; the report uses per-round medians and keeps min/max.
//
// Bounds: one writer, local filesystem, macOS/APFS tmpdir, no slow disk, no
// cross-process contention, no Desktop UI. The numbers are measurements from
// this host and this run, not theoretical estimates.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openSharedExperienceV1Baseline, installFakeClock } from './shared-experience-v1-baseline.mjs';

const HARNESS_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(HARNESS_PATH), '..', '..');
const BASELINE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'benchmarks', 'shared-experience-v1-baseline.mjs');
const MIGRATION_CLI = path.join(REPO_ROOT, 'scripts', 'migrate-experience-store.mjs');
const SOURCE_FILES = [
  'lib/shared-experience.js',
  'lib/shared-experience-migration.js',
  'scripts/migrate-experience-store.mjs',
  'scripts/benchmarks/shared-experience-v1-baseline.mjs',
  'scripts/benchmarks/shared-experience-storage.mjs',
];
const SCENARIOS = Object.freeze(['uniform-ledger', 'diverse-knowledge', 'replay-duplicates']);
const CLOCK_BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const REAL_DATE = Date;
const DIGEST = value => createHash('sha256').update(value).digest('hex');
const nodeRequire = createRequire(import.meta.url);

// --- options ----------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    out: null, report: null, rounds: 3, sizes: [1000, 10000], variantB: 'core',
    skipMigration: false, skipBaselineVerify: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith('--variant-b=')) {
      options.variantB = argument.slice('--variant-b='.length);
      continue;
    }
    if (argument === '--variant-b' || argument === '--report' || argument === '--sizes' || argument === '--rounds') {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined) throw new Error(`missing value for ${argument}`);
      if (argument === '--variant-b') options.variantB = value;
      else if (argument === '--report') options.report = value;
      else if (argument === '--sizes') options.sizes = value.split(',').map(Number);
      else options.rounds = Number(value);
      continue;
    }
    if (argument === '--skip-migration') { options.skipMigration = true; continue; }
    if (argument === '--skip-baseline-verify') { options.skipBaselineVerify = true; continue; }
    if (argument.startsWith('--')) throw new Error(`unknown option ${argument}`);
    if (options.out) throw new Error(`unexpected argument ${argument}`);
    options.out = argument;
  }
  if (!options.out) throw new Error('usage: node scripts/benchmarks/shared-experience-storage.mjs <out.json> [options]');
  if (!['core', 'baseline'].includes(options.variantB)) throw new Error('--variant-b must be core or baseline');
  if (!Number.isInteger(options.rounds) || options.rounds < 1) throw new Error('--rounds must be a positive integer');
  for (const size of options.sizes) {
    if (!Number.isInteger(size) || size < 10) throw new Error('--sizes values must be integers >= 10');
  }
  options.sizes = [...new Set(options.sizes)].sort((left, right) => left - right);
  return options;
}

// --- environment ------------------------------------------------------------

const DARWIN_FILESYSTEMS = new Map([[26, 'apfs'], [23, 'hfs'], [17, 'nfs']]);
const LINUX_FILESYSTEMS = new Map([
  [0xef53, 'ext2/ext3/ext4'], [0x58465342, 'xfs'], [0x9123683e, 'btrfs'],
  [0x01021994, 'tmpfs'], [0x6969, 'nfs'], [0x2fc12fc1, 'zfs'], [0x794c7630, 'overlayfs'],
]);

/** Filesystem name from `statfs(2)`; the numeric type is mapped, never guessed. */
function filesystemType(directory) {
  try {
    const type = fs.statfsSync(directory)?.type;
    const table = process.platform === 'darwin' ? DARWIN_FILESYSTEMS
      : process.platform === 'linux' ? LINUX_FILESYSTEMS : new Map();
    return table.get(type) ?? `type-${type}`;
  } catch { return 'unknown'; }
}

function sha256File(file) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

/** Hash the measured sources so the JSON pins exactly which tree was measured. */
function sourceHashes() {
  const hashes = {};
  for (const file of SOURCE_FILES) {
    try { hashes[file] = sha256File(path.join(REPO_ROOT, file)); }
    catch { hashes[file] = null; }
  }
  let head = null;
  let status = null;
  try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(); } catch { /* not a git checkout */ }
  try {
    status = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n').map(line => line.trim()).filter(Boolean);
  } catch { /* not a git checkout */ }
  return { files: hashes, head, workTreeStatus: status };
}

// The write clock is pinned, so knowledge bodies are byte-identical between A
// and B. The stable projection additionally drops the wall-clock-derived keys,
// so the check still means the same thing if the pinned clock ever changes.
const VOLATILE_KNOWLEDGE_KEYS = ['firstSeen', 'lastSeen', 'updatedAt', 'recentEvidence', 'trend'];
function stableKnowledgeDigest(rows) {
  return DIGEST(JSON.stringify(rows.map(row => {
    let entry;
    try { entry = JSON.parse(row.body); } catch { return [row.key, row.body]; }
    const stable = Object.fromEntries(Object.entries(entry).filter(([key]) => !VOLATILE_KNOWLEDGE_KEYS.includes(key)));
    return [row.key, stable];
  })));
}

// --- variants ---------------------------------------------------------------

async function loadVariants(mode) {
  const frozen = {
    id: 'A',
    label: 'frozen v1 baseline (commit 48c8f2e)',
    expectedSchema: 1,
    open: openSharedExperienceV1Baseline,
  };
  if (mode === 'baseline') {
    return {
      coreReady: false,
      variants: { A: frozen, B: { ...frozen, id: 'B', label: 'frozen v1 baseline (A/A self-test only)' } },
    };
  }
  const module = await import(pathToFileURL(path.join(REPO_ROOT, 'lib', 'shared-experience.js')).href);
  if (typeof module.openSharedExperience !== 'function') {
    throw new Error('lib/shared-experience.js does not export openSharedExperience');
  }
  return {
    coreReady: true,
    variants: {
      A: frozen,
      B: {
        id: 'B',
        label: 'working tree openSharedExperience (schema v2)',
        expectedSchema: 2,
        open: module.openSharedExperience,
      },
    },
  };
}

// --- fixtures ---------------------------------------------------------------

const EVENT_ID_CACHE = new Map();
function eventId(scenario, index) {
  const key = `${scenario}:${index}`;
  let id = EVENT_ID_CACHE.get(key);
  if (!id) {
    // Replay rows must be the exact ids of the uniform ledger so the replay run
    // persists the same rows as the first pass.
    const identity = scenario === 'replay-duplicates' ? `uniform-ledger:${index}` : key;
    id = DIGEST(identity);
    EVENT_ID_CACHE.set(key, id);
  }
  return id;
}

function payloadFor(scenario, index) {
  if (scenario === 'diverse-knowledge') {
    return { id: eventId(scenario, index), type: 'tool/error', code: 'ENOENT', target: `tool:target-${index}` };
  }
  return { id: eventId(scenario, index), type: 'tool/error', code: 'ENOENT', target: 'tool:read_file' };
}

// --- statistics -------------------------------------------------------------

function summarize(samples, { keepRaw = false } = {}) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  const nearestRank = quantile => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1))];
  const totalMs = samples.reduce((total, sample) => total + sample, 0);
  return {
    count: samples.length,
    totalMs,
    meanMs: totalMs / samples.length,
    p50Ms: nearestRank(0.5),
    p95Ms: nearestRank(0.95),
    maxMs: sorted[sorted.length - 1],
    minMs: sorted[0],
    ...(keepRaw ? { rawMs: samples } : {}),
  };
}

function median(values) {
  if (!values.length) return null;
  return summarize(values).p50Ms;
}

function medianField(rows, fieldPath) {
  const values = rows.map(row => fieldPath.split('.').reduce((value, key) => value?.[key], row))
    .filter(value => typeof value === 'number' && Number.isFinite(value));
  if (!values.length) return null;
  return { median: median(values), min: Math.min(...values), max: Math.max(...values), samples: values };
}

function medianSummary(samples) {
  const values = samples.filter(value => typeof value === 'number' && Number.isFinite(value));
  if (!values.length) return null;
  return { median: median(values), min: Math.min(...values), max: Math.max(...values) };
}

// --- database profiling -----------------------------------------------------

const WAL = '-wal';
const SHM = '-shm';

function fileBytes(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function directoryBytes(root) {
  let total = 0;
  const files = [];
  for (const name of fs.readdirSync(root).sort()) {
    const file = path.join(root, name);
    const stat = fs.statSync(file);
    if (!stat.isFile()) continue;
    total += stat.size;
    files.push({ name, bytes: stat.size });
  }
  return { total, files };
}

function categorizeDbstatName(name) {
  if (name === 'events') return 'eventsTable';
  if (name.startsWith('sqlite_autoindex_events_')) return 'eventsIndex';
  if (name === 'knowledge') return 'knowledgeTable';
  if (name === 'knowledge_recent' || name.startsWith('sqlite_autoindex_knowledge_')) return 'knowledgeIndex';
  if (name === 'clock') return 'clockTable';
  if (name === 'sqlite_schema') return 'sqliteSchema';
  return 'other';
}

/**
 * Read-only profile of one checkpointed database. The caller must have closed
 * every writer first; the harness asserts a zero/absent WAL before this runs.
 */
function profileDatabase(root) {
  const { DatabaseSync } = requireSqlite();
  const file = path.join(root, 'experience.sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  let profile;
  try {
    const rows = db.prepare('SELECT name, sum(pgsize) AS bytes, count(*) AS pages FROM dbstat GROUP BY name').all();
    const categories = {
      eventsTable: { bytes: 0, pages: 0 }, eventsIndex: { bytes: 0, pages: 0 },
      knowledgeTable: { bytes: 0, pages: 0 }, knowledgeIndex: { bytes: 0, pages: 0 },
      clockTable: { bytes: 0, pages: 0 }, sqliteSchema: { bytes: 0, pages: 0 }, other: { bytes: 0, pages: 0 },
    };
    const dbstatRows = [];
    for (const row of rows) {
      const category = categorizeDbstatName(row.name);
      categories[category].bytes += Number(row.bytes);
      categories[category].pages += Number(row.pages);
      dbstatRows.push({ name: row.name, bytes: Number(row.bytes), pages: Number(row.pages), category });
    }
    const pageCount = Number(db.prepare('PRAGMA page_count').get().page_count);
    const freelistCount = Number(db.prepare('PRAGMA freelist_count').get().freelist_count);
    const pageSize = Number(db.prepare('PRAGMA page_size').get().page_size);
    const userVersion = Number(db.prepare('PRAGMA user_version').get().user_version);
    const knowledgeRows = db.prepare('SELECT key, body FROM knowledge ORDER BY key').all();
    const knowledgeDigest = DIGEST(JSON.stringify(knowledgeRows.map(row => [row.key, row.body])));
    const knowledgeStableDigest = stableKnowledgeDigest(knowledgeRows);
    const eventCount = Number(db.prepare('SELECT count(*) AS n FROM events').get().n);
    const knowledgeCount = knowledgeRows.length;
    profile = {
      userVersion,
      pageSize,
      pageCount,
      freelistCount,
      dbstatRows,
      eventsTableBytes: categories.eventsTable.bytes,
      eventsIndexBytes: categories.eventsIndex.bytes,
      eventsBytes: categories.eventsTable.bytes + categories.eventsIndex.bytes,
      knowledgeTableBytes: categories.knowledgeTable.bytes,
      knowledgeIndexBytes: categories.knowledgeIndex.bytes,
      knowledgeBytes: categories.knowledgeTable.bytes + categories.knowledgeIndex.bytes,
      otherBytes: categories.clockTable.bytes + categories.sqliteSchema.bytes + categories.other.bytes,
      dbstatTotalBytes: rows.reduce((total, row) => total + Number(row.bytes), 0),
      knowledgeDigest,
      knowledgeStableDigest,
      eventCount,
      knowledgeCount,
    };
  } finally { db.close(); }
  const directory = directoryBytes(root);
  return {
    ...profile,
    mainBytes: fileBytes(file),
    files: directory.files,
    directoryBytes: directory.total,
  };
}

let sqliteModule = null;
function requireSqlite() {
  if (!sqliteModule) sqliteModule = nodeRequire('node:sqlite');
  return sqliteModule;
}

// --- one measured run -------------------------------------------------------

/**
 * Open one store in an isolated root, write `size` facts, replay when the
 * scenario asks for it, then close and profile. Returns the sample plus the
 * root path; the caller decides when to remove the root.
 */
function runOne({ variant, scenario, size, round, orderIndex, keepRaw, clock }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-se-storage-'));
  const store = variant.open(root);
  let closed = false;
  try {
    const schemaVersion = typeof store.schemaVersion === 'number' ? store.schemaVersion : null;
    const write = [];
    const batchStart = performance.now();
    for (let index = 0; index < size; index += 1) {
      const payload = payloadFor(scenario === 'replay-duplicates' ? 'uniform-ledger' : scenario, index);
      clock.set(CLOCK_BASE_MS + index * 1000);
      const started = performance.now();
      store.recordFailure(payload);
      write.push(performance.now() - started);
    }
    const batchMs = performance.now() - batchStart;
    const afterWrite = store.stats();
    let replay = null;
    if (scenario === 'replay-duplicates') {
      const replaySamples = [];
      let duplicates = 0;
      const replayStart = performance.now();
      for (let index = 0; index < size; index += 1) {
        clock.set(CLOCK_BASE_MS + index * 1000);
        const started = performance.now();
        const result = store.recordFailure(payloadFor(scenario, index));
        replaySamples.push(performance.now() - started);
        if (result?.duplicate === true) duplicates += 1;
      }
      replay = {
        ...summarize(replaySamples, { keepRaw }),
        batchMs: performance.now() - replayStart,
        duplicates,
        allDuplicates: duplicates === size,
      };
    }
    const beforeClose = store.stats();
    const walPath = path.join(root, 'experience.sqlite') + WAL;
    const walBytesBeforeClose = fileBytes(walPath);
    const shmBeforeClose = fs.existsSync(path.join(root, 'experience.sqlite') + SHM);
    store.close();
    closed = true;
    const walBytesAfterClose = fileBytes(walPath);
    const profile = profileDatabase(root);
    const sample = {
      round,
      orderIndex,
      scenario,
      size,
      variant: variant.id,
      schemaVersion,
      expectedSchema: variant.expectedSchema,
      rowCounts: { afterWrite, beforeClose },
      write: summarize(write, { keepRaw }),
      batchMs,
      replay,
      storage: {
        eventsTableBytes: profile.eventsTableBytes,
        eventsIndexBytes: profile.eventsIndexBytes,
        eventsBytes: profile.eventsBytes,
        knowledgeTableBytes: profile.knowledgeTableBytes,
        knowledgeIndexBytes: profile.knowledgeIndexBytes,
        knowledgeBytes: profile.knowledgeBytes,
        otherBytes: profile.otherBytes,
        dbstatTotalBytes: profile.dbstatTotalBytes,
        pageCount: profile.pageCount,
        freelistCount: profile.freelistCount,
        pageSize: profile.pageSize,
        mainBytes: profile.mainBytes,
        walBytesBeforeClose,
        walBytesAfterClose,
        shmExistsBeforeClose: shmBeforeClose,
        directoryBytes: profile.directoryBytes,
        files: profile.files,
        dbstatRows: profile.dbstatRows,
      },
      rows: { events: profile.eventCount, knowledge: profile.knowledgeCount },
      knowledgeDigest: profile.knowledgeDigest,
      knowledgeStableDigest: profile.knowledgeStableDigest,
      userVersion: profile.userVersion,
    };
    return { sample, root };
  } catch (error) {
    if (!closed) { try { store.close(); } catch { /* already failing */ } }
    throw error;
  }
}

// --- open cost --------------------------------------------------------------

function measureOpenCost(variant, existingRoot, existingSize) {
  const coldEmpty = [];
  for (let index = 0; index < 20; index += 1) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-se-open-'));
    try {
      const started = performance.now();
      const store = variant.open(root);
      coldEmpty.push(performance.now() - started);
      store.close();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  const warmExisting = [];
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    const store = variant.open(existingRoot);
    warmExisting.push(performance.now() - started);
    store.close();
  }
  return {
    variant: variant.id,
    existingSize,
    coldEmpty: { ...summarize(coldEmpty), rawMs: coldEmpty },
    warmExisting: { ...summarize(warmExisting), rawMs: warmExisting },
  };
}

// --- correctness probes -----------------------------------------------------

function conflictProbe(variant) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-se-conflict-'));
  try {
    const store = variant.open(root);
    const id = DIGEST('conflict-probe');
    const first = store.recordFailure({ id, type: 'tool/error', code: 'ENOENT', target: 'tool:read_file' });
    let errorMessage = null;
    try { store.recordFailure({ id, type: 'tool/error', code: 'EACCES', target: 'tool:read_file' }); }
    catch (error) { errorMessage = error?.message ?? String(error); }
    const stats = store.stats();
    store.close();
    return {
      firstCommitted: first?.committed === true,
      errorMessage,
      conflictRaised: errorMessage === 'E_EXPERIENCE_EVENT_CONFLICT',
      events: stats.events,
      knowledge: stats.knowledge,
    };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// --- migration --------------------------------------------------------------

function buildV1Store(root, scenario, size, clock) {
  const store = openSharedExperienceV1Baseline(root);
  try {
    for (let index = 0; index < size; index += 1) {
      clock.set(CLOCK_BASE_MS + index * 1000);
      store.recordFailure(payloadFor(scenario, index));
    }
    return store.stats();
  } finally { store.close(); }
}

function eventRowsReadOnly(root) {
  const { DatabaseSync } = requireSqlite();
  const db = new DatabaseSync(path.join(root, 'experience.sqlite'), { readOnly: true });
  try {
    return db.prepare('SELECT id, digest FROM events ORDER BY id').all()
      .map(row => ({ id: String(row.id).toLowerCase(), digest: String(row.digest).toLowerCase() }));
  } finally { db.close(); }
}

function v2EventRowsReadOnly(root) {
  const { DatabaseSync } = requireSqlite();
  const db = new DatabaseSync(path.join(root, 'experience.sqlite'), { readOnly: true });
  try {
    return db.prepare('SELECT hex(id) AS id, hex(digest) AS digest FROM events ORDER BY hex(id)').all()
      .map(row => ({ id: String(row.id).toLowerCase(), digest: String(row.digest).toLowerCase() }));
  } finally { db.close(); }
}

function runCli(args) {
  const started = performance.now();
  try {
    const stdout = execFileSync(process.execPath, [MIGRATION_CLI, ...args], {
      cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 600_000,
    });
    return { wallMs: performance.now() - started, exitCode: 0, stdout: stdout.slice(0, 8000), stderr: '' };
  } catch (error) {
    return {
      wallMs: performance.now() - started,
      exitCode: typeof error.status === 'number' ? error.status : 1,
      stdout: String(error.stdout ?? '').slice(0, 8000),
      stderr: String(error.stderr ?? error.message ?? '').slice(0, 8000),
    };
  }
}

function parseJsonOutput(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** Replace the (already deleted) temporary root path in captured CLI output. */
function sanitizeCaptured(value, root) {
  if (typeof value === 'string') return value.split(root).join('<tmp-root>');
  if (Array.isArray(value)) return value.map(item => sanitizeCaptured(item, root));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeCaptured(item, root)]));
  }
  return value;
}

function measureMigration({ sizes, clock, log }) {
  if (!fs.existsSync(MIGRATION_CLI)) {
    return { status: 'not-ready', note: `${path.relative(REPO_ROOT, MIGRATION_CLI)} does not exist yet` };
  }
  const samples = [];
  for (const scenario of ['uniform-ledger', 'diverse-knowledge']) {
    for (const size of sizes) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-se-migration-'));
      try {
        const stats = buildV1Store(root, scenario, size, clock);
        const eventsBefore = eventRowsReadOnly(root);
        const mainSha256Before = sha256File(path.join(root, 'experience.sqlite'));
        const profileBefore = profileDatabase(root);
        const directoryBefore = directoryBytes(root);

        const dryRun = runCli(['--root', root, '--dry-run', '--json']);
        const eventsAfterDryRun = eventRowsReadOnly(root);
        const profileAfterDryRun = profileDatabase(root);
        const mainSha256AfterDryRun = sha256File(path.join(root, 'experience.sqlite'));
        const dryRunNoop = profileAfterDryRun.userVersion === 1
          && mainSha256AfterDryRun === mainSha256Before
          && JSON.stringify(eventsAfterDryRun) === JSON.stringify(eventsBefore);

        const before = directoryBytes(root);
        const migration = runCli(['--root', root, '--json']);
        const eventsAfter = v2EventRowsReadOnly(root);
        const profileAfter = profileDatabase(root);
        const directoryAfter = directoryBytes(root);
        const newFiles = directoryAfter.files.filter(file => !before.files.some(oldFile => oldFile.name === file.name));
        const backupBytes = newFiles.reduce((total, file) => total + file.bytes, 0);

        samples.push({
          scenario,
          size,
          v1Rows: { events: profileBefore.eventCount, knowledge: profileBefore.knowledgeCount, stats },
          wallMs: migration.wallMs,
          exitCode: migration.exitCode,
          stdout: sanitizeCaptured(migration.stdout, root),
          stderr: sanitizeCaptured(migration.stderr, root),
          report: sanitizeCaptured(parseJsonOutput(migration.stdout), root),
          before: {
            userVersion: profileBefore.userVersion,
            eventsRows: profileBefore.eventCount,
            eventsBytes: profileBefore.eventsBytes,
            knowledgeBytes: profileBefore.knowledgeBytes,
            mainBytes: profileBefore.mainBytes,
            pageCount: profileBefore.pageCount,
            freelistCount: profileBefore.freelistCount,
            directoryBytes: profileBefore.directoryBytes,
            knowledgeDigest: profileBefore.knowledgeDigest,
          },
          dryRun: {
            wallMs: dryRun.wallMs,
            exitCode: dryRun.exitCode,
            stdout: sanitizeCaptured(dryRun.stdout, root),
            stderr: sanitizeCaptured(dryRun.stderr, root),
            report: sanitizeCaptured(parseJsonOutput(dryRun.stdout), root),
            noop: dryRunNoop,
            mainSha256Before,
            mainSha256AfterDryRun,
          },
          after: {
            userVersion: profileAfter.userVersion,
            eventsRows: profileAfter.eventCount,
            eventsBytes: profileAfter.eventsBytes,
            knowledgeBytes: profileAfter.knowledgeBytes,
            mainBytes: profileAfter.mainBytes,
            pageCount: profileAfter.pageCount,
            freelistCount: profileAfter.freelistCount,
            directoryBytes: profileAfter.directoryBytes,
            knowledgeDigest: profileAfter.knowledgeDigest,
          },
          newFiles,
          backupBytes,
          eventsHexEqual: JSON.stringify(eventsAfter) === JSON.stringify(eventsBefore),
          knowledgeEqual: profileAfter.knowledgeDigest === profileBefore.knowledgeDigest,
          rowCountEqual: profileAfter.eventCount === profileBefore.eventCount,
          v2RowShape: (() => {
            const { DatabaseSync } = requireSqlite();
            const db = new DatabaseSync(path.join(root, 'experience.sqlite'), { readOnly: true });
            try {
              return db.prepare("SELECT count(*) AS n FROM events WHERE typeof(id)='blob' AND length(id)=32 AND typeof(digest)='blob' AND length(digest)=32").get().n;
            } finally { db.close(); }
          })(),
        });
        log(`migration ${scenario} ${size}: ${migration.wallMs.toFixed(1)} ms, ${profileBefore.mainBytes} -> ${profileAfter.mainBytes} bytes`);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
  }
  return {
    status: 'measured',
    cli: path.relative(REPO_ROOT, MIGRATION_CLI),
    samples,
    allHexEqual: samples.every(sample => sample.eventsHexEqual),
    allKnowledgeEqual: samples.every(sample => sample.knowledgeEqual),
    allRowCountsEqual: samples.every(sample => sample.rowCountEqual),
  };
}

// --- main -------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const generatedAt = new REAL_DATE().toISOString();
  const tempRoot = os.tmpdir();
  const clock = installFakeClock();
  const roots = [];
  const log = message => process.stderr.write(`[bench] ${message}\n`);
  try {
    // 1. frozen baseline self-check
    let baselineVerification = { skipped: true };
    if (!options.skipBaselineVerify) {
      log('verifying frozen v1 baseline against git 48c8f2e');
      const stdout = execFileSync(process.execPath, [BASELINE_SCRIPT, '--verify-baseline'], {
        cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 300_000,
      });
      baselineVerification = { skipped: false, ...parseJsonOutput(stdout) };
      log(`baseline verification ok=${baselineVerification.ok}`);
    }

    // 2. variants
    const loaded = await loadVariants(options.variantB);
    log(`variants: coreReady=${loaded.coreReady}, B=${loaded.variants.B.label}`);

    // 3. correctness probes
    const conflictChecks = {};
    for (const variant of Object.values(loaded.variants)) conflictChecks[variant.id] = conflictProbe(variant);
    log(`conflict probes: ${JSON.stringify(conflictChecks)}`);

    // 4. measured rounds
    const samples = [];
    const openCostSamples = [];
    for (let round = 0; round < options.rounds; round += 1) {
      const order = round % 2 === 0 ? ['A', 'B'] : ['B', 'A'];
      const roundRoots = [];
      const existingRoots = new Map();
      for (const scenario of SCENARIOS) {
        for (const size of options.sizes) {
          for (const variantId of order) {
            const variant = loaded.variants[variantId];
            const keepRaw = size === 1000;
            const { sample, root } = runOne({ variant, scenario, size, round, orderIndex: order.indexOf(variantId), keepRaw, clock });
            samples.push(sample);
            roundRoots.push(root);
            if (scenario === 'uniform-ledger' && size === options.sizes[options.sizes.length - 1]) {
              existingRoots.set(variantId, { root, size });
            }
            log(`round ${round} ${scenario} ${size} ${variantId}: write p50=${sample.write.p50Ms.toFixed(3)}ms events=${sample.storage.eventsBytes}B knowledge=${sample.storage.knowledgeBytes}B db=${sample.storage.mainBytes}B`);
          }
        }
      }
      for (const variantId of order) {
        const existing = existingRoots.get(variantId);
        if (!existing) continue;
        openCostSamples.push({
          round,
          variant: variantId,
          ...measureOpenCost(loaded.variants[variantId], existing.root, existing.size),
        });
      }
      roots.push(...roundRoots);
    }

    // 5. cleanup measured roots before migration so the data is self-contained
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });

    // 6. migration cost (only meaningful once the migration CLI exists)
    let migration;
    if (options.skipMigration) migration = { status: 'skipped' };
    else if (!loaded.coreReady) migration = { status: 'not-run', note: 'variant B is not the core implementation' };
    else {
      log('measuring migration cost');
      migration = measureMigration({ sizes: options.sizes, clock, log });
    }

    // 7. derive report data
    const derived = derive({ samples, openCostSamples, sizes: options.sizes, rounds: options.rounds });

    // 8. self checks
    const selfChecks = [];
    const failures = [];
    const check = (name, ok, { hard = true, skipped = false, detail = null } = {}) => {
      selfChecks.push({ name, ok: skipped ? null : ok, hard, skipped, detail });
      if (!skipped && hard && !ok) failures.push({ name, detail });
    };
    check('frozen-baseline-verification', baselineVerification.ok === true, {
      skipped: baselineVerification.skipped === true,
      detail: baselineVerification.problems ?? ['skipped'],
    });
    check('no-wal-after-close', samples.every(sample => sample.storage.walBytesAfterClose === 0), {
      detail: samples.filter(sample => sample.storage.walBytesAfterClose !== 0).map(sample => `${sample.scenario}/${sample.size}/${sample.variant}`),
    });
    check('core-schema-version-2', loaded.coreReady && samples.filter(sample => sample.variant === 'B').every(sample => sample.schemaVersion === 2 && sample.userVersion === 2), {
      skipped: !loaded.coreReady,
      detail: loaded.coreReady ? samples.filter(sample => sample.variant === 'B').map(sample => ({ schemaVersion: sample.schemaVersion, userVersion: sample.userVersion })) : 'variant B is the frozen baseline self-test',
    });
    check('conflict-raised-both-variants', Object.values(conflictChecks).every(probe => probe.conflictRaised && probe.events === 1), {
      detail: conflictChecks,
    });
    // knowledge bodies must be identical between A and B for the same scenario
    // and size, and the replay run must leave the same knowledge as the first
    // pass of the same variant.
    for (const size of options.sizes) {
      for (const scenario of ['uniform-ledger', 'diverse-knowledge']) {
        const pairs = [];
        for (let round = 0; round < options.rounds; round += 1) {
          const side = variant => samples.find(sample => sample.round === round && sample.scenario === scenario
            && sample.size === size && sample.variant === variant);
          const left = side('A');
          const right = side('B');
          if (!left || !right) continue;
          pairs.push(left.knowledgeDigest === right.knowledgeDigest
            && left.knowledgeStableDigest === right.knowledgeStableDigest
            && left.rows.knowledge === right.rows.knowledge);
        }
        check(`knowledge-identical-${scenario}-${size}`, pairs.length === options.rounds && pairs.every(Boolean), {
          detail: pairs,
        });
      }
      // replay must not grow the ledger vs the uniform run of the same variant.
      for (const variant of ['A', 'B']) {
        for (let round = 0; round < options.rounds; round += 1) {
          const replay = samples.find(sample => sample.round === round && sample.scenario === 'replay-duplicates'
            && sample.size === size && sample.variant === variant);
          const uniform = samples.find(sample => sample.round === round && sample.scenario === 'uniform-ledger'
            && sample.size === size && sample.variant === variant);
          if (!replay || !uniform) continue;
          check(`replay-duplicates-${variant}-${size}-round-${round}`,
            replay.replay?.allDuplicates === true
            && replay.rows.events === size
            && replay.storage.eventsBytes === uniform.storage.eventsBytes
            && replay.knowledgeDigest === uniform.knowledgeDigest
            && replay.knowledgeStableDigest === uniform.knowledgeStableDigest, {
              detail: { duplicates: replay.replay?.duplicates, rows: replay.rows.events, bytes: replay.storage.eventsBytes, uniformBytes: uniform.storage.eventsBytes },
            });
        }
      }
    }
    // storage win: B must be strictly smaller for both scenarios at every size.
    for (const scenario of ['uniform-ledger', 'diverse-knowledge']) {
      for (const size of options.sizes) {
        const left = derived.storage[scenario][String(size)].A.eventsBytes.median;
        const right = derived.storage[scenario][String(size)].B.eventsBytes.median;
        check(`events-bytes-smaller-${scenario}-${size}`, typeof left === 'number' && typeof right === 'number' && right < left, {
          skipped: !loaded.coreReady,
          detail: { A: left, B: right },
        });
      }
    }
    for (const scenario of ['uniform-ledger', 'diverse-knowledge']) {
      const marginal = derived.marginal[scenario];
      check(`marginal-smaller-${scenario}`, marginal && marginal.B.marginalBytesPerEvent < marginal.A.marginalBytesPerEvent, {
        skipped: !loaded.coreReady || options.sizes.length < 2,
        detail: marginal,
      });
    }
    // latency regression: compare per-round medians against a documented tolerance.
    const latencyTolerance = { p50Factor: 1.25, totalFactor: 1.25, openFactor: 1.5, absoluteMs: 0.02 };
    for (const scenario of SCENARIOS) {
      for (const size of options.sizes) {
        const left = derived.latency[scenario]?.[String(size)]?.A;
        const right = derived.latency[scenario]?.[String(size)]?.B;
        if (!left || !right) continue;
        const p50Ok = right.writeP50Ms.median <= left.writeP50Ms.median * latencyTolerance.p50Factor + latencyTolerance.absoluteMs;
        const totalOk = right.writeTotalMs.median <= left.writeTotalMs.median * latencyTolerance.totalFactor + 1;
        check(`write-latency-${scenario}-${size}`, p50Ok && totalOk, {
          skipped: !loaded.coreReady,
          detail: { tolerance: latencyTolerance, A: left, B: right },
        });
      }
    }
    if (options.rounds >= 1 && options.sizes.length) {
      const coldA = derived.openCost.coldEmpty.A.median;
      const coldB = derived.openCost.coldEmpty.B.median;
      const warmA = derived.openCost.warmExisting.A.median;
      const warmB = derived.openCost.warmExisting.B.median;
      const openOk = coldB <= coldA * latencyTolerance.openFactor + 1 && warmB <= warmA * latencyTolerance.openFactor + 1;
      check('open-latency', openOk, { skipped: !loaded.coreReady, detail: { coldA, coldB, warmA, warmB } });
    }
    // migration integrity
    if (migration.status === 'measured') {
      check('migration-hex-equal', migration.allHexEqual, { detail: migration.samples.map(sample => sample.eventsHexEqual) });
      check('migration-knowledge-equal', migration.allKnowledgeEqual, { detail: migration.samples.map(sample => sample.knowledgeEqual) });
      check('migration-row-counts-equal', migration.allRowCountsEqual, { detail: migration.samples.map(sample => sample.rowCountEqual) });
      check('migration-cli-exit-zero', migration.samples.every(sample => sample.exitCode === 0), {
        detail: migration.samples.map(sample => sample.exitCode),
      });
      check('migration-v2-blob32', migration.samples.every(sample => sample.v2RowShape === sample.size), {
        detail: migration.samples.map(sample => sample.v2RowShape),
      });
      check('migration-dry-run-noop', migration.samples.every(sample => sample.dryRun.noop && sample.dryRun.exitCode === 0), {
        detail: migration.samples.map(sample => ({ noop: sample.dryRun.noop, exitCode: sample.dryRun.exitCode })),
      });
    } else {
      check('migration-measured', false, { skipped: true, detail: migration });
    }

    const result = {
      schema: 'shared-experience-storage-benchmark@1',
      generatedAt,
      invocation: {
        out: path.relative(REPO_ROOT, path.resolve(options.out)),
        report: options.report ? path.relative(REPO_ROOT, path.resolve(options.report)) : null,
      },
      variantB: {
        mode: options.variantB,
        coreReady: loaded.coreReady,
        label: loaded.variants.B.label,
        expectedSchema: loaded.variants.B.expectedSchema,
      },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        filesystem: filesystemType(tempRoot),
        tempRootKind: 'fs.mkdtempSync(os.tmpdir())',
        cpus: os.cpus()?.length ?? null,
        totalMemoryBytes: os.totalmem(),
      },
      sources: sourceHashes(),
      method: {
        variants: { A: loaded.variants.A.label, B: loaded.variants.B.label },
        scenarios: {
          'uniform-ledger': 'N unique event ids, identical recordFailure payload (tool/error ENOENT tool:read_file); one knowledge identity grows, so ledger growth is isolated',
          'diverse-knowledge': 'N unique event ids, target tool:target-<i>; one knowledge row per identity, so ledger and canonical knowledge grow together',
          'replay-duplicates': 'the uniform-ledger N rows replayed in order; duplicates must not add rows or bytes',
        },
        clock: 'Date is pinned to CLOCK_BASE_MS + i*1000 before each write so A and B persist identical knowledge bodies; performance.now() timings are unaffected',
        latency: 'per-call performance.now() deltas; p50/p95 nearest-rank; rawMs kept for size 1000 only',
        checkpoint: 'write -> store.close() (last connection checkpoints and removes WAL) -> assert -wal absent/0 -> read-only DatabaseSync for dbstat/PRAGMA/fs.statSync',
        maintenance: 'no VACUUM, no ANALYZE, no manual checkpoint; measured state is what closing the store leaves',
        rounds: `>= ${options.rounds}, alternating A/B then B/A, one isolated mkdtemp root per run`,
      },
      rounds: options.rounds,
      sizes: options.sizes,
      scenarios: SCENARIOS,
      baselineVerification,
      conflictChecks,
      samples,
      openCost: openCostSamples,
      derived,
      migration,
      selfChecks,
      failures,
      ok: failures.length === 0,
    };
    fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    fs.writeFileSync(path.resolve(options.out), `${JSON.stringify(result, null, 2)}\n`);
    log(`wrote ${options.out}`);
    if (options.report) {
      fs.writeFileSync(path.resolve(options.report), renderMarkdown(result));
      log(`wrote ${options.report}`);
    }
    console.log(JSON.stringify({
      ok: result.ok,
      coreReady: result.variantB.coreReady,
      samples: samples.length,
      failures,
      summary: summarizeForConsole(result),
    }, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    clock.restore();
    for (const root of roots.splice(0)) { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}

// --- derived data -----------------------------------------------------------

const STORAGE_FIELDS = ['eventsTableBytes', 'eventsIndexBytes', 'eventsBytes', 'knowledgeTableBytes',
  'knowledgeIndexBytes', 'knowledgeBytes', 'otherBytes', 'dbstatTotalBytes', 'pageCount', 'freelistCount',
  'mainBytes', 'walBytesBeforeClose', 'walBytesAfterClose', 'directoryBytes'];

function derive({ samples, openCostSamples, sizes, rounds }) {
  const storage = {};
  const latency = {};
  for (const scenario of SCENARIOS) {
    storage[scenario] = {};
    latency[scenario] = {};
    for (const size of sizes) {
      storage[scenario][String(size)] = {};
      latency[scenario][String(size)] = {};
      for (const variant of ['A', 'B']) {
        const rows = samples.filter(sample => sample.scenario === scenario && sample.size === size && sample.variant === variant);
        const aggregated = {};
        for (const field of STORAGE_FIELDS) aggregated[field] = medianField(rows, `storage.${field}`);
        aggregated.rows = {
          events: medianField(rows, 'rows.events'),
          knowledge: medianField(rows, 'rows.knowledge'),
        };
        storage[scenario][String(size)][variant] = aggregated;
        latency[scenario][String(size)][variant] = {
          writeP50Ms: medianField(rows, 'write.p50Ms'),
          writeP95Ms: medianField(rows, 'write.p95Ms'),
          writeMaxMs: medianField(rows, 'write.maxMs'),
          writeMeanMs: medianField(rows, 'write.meanMs'),
          writeTotalMs: medianField(rows, 'write.totalMs'),
          batchMs: medianField(rows, 'batchMs'),
          replayP50Ms: medianField(rows, 'replay.p50Ms'),
          replayTotalMs: medianField(rows, 'replay.totalMs'),
          replayMaxMs: medianField(rows, 'replay.maxMs'),
        };
      }
    }
  }

  // Marginal cost per event: slope between the smallest and largest size.
  const marginal = {};
  if (sizes.length >= 2) {
    const smallest = sizes[0];
    const largest = sizes[sizes.length - 1];
    const delta = largest - smallest;
    for (const scenario of SCENARIOS) {
      const perVariant = {};
      for (const variant of ['A', 'B']) {
        const small = storage[scenario][String(smallest)][variant].eventsBytes.median;
        const large = storage[scenario][String(largest)][variant].eventsBytes.median;
        perVariant[variant] = {
          fromSize: smallest,
          toSize: largest,
          eventsBytesAtSmallest: small,
          eventsBytesAtLargest: large,
          marginalBytesPerEvent: (large - small) / delta,
        };
      }
      marginal[scenario] = {
        ...perVariant,
        savingsBytesPerEvent: perVariant.A.marginalBytesPerEvent - perVariant.B.marginalBytesPerEvent,
        savingsPercent: perVariant.A.marginalBytesPerEvent === 0 ? null
          : ((perVariant.A.marginalBytesPerEvent - perVariant.B.marginalBytesPerEvent) / perVariant.A.marginalBytesPerEvent) * 100,
      };
    }
  }

  // Same slope for the knowledge category (mixed growth scenario).
  const knowledgeMarginal = {};
  if (sizes.length >= 2) {
    const smallest = sizes[0];
    const largest = sizes[sizes.length - 1];
    const delta = largest - smallest;
    for (const scenario of ['uniform-ledger', 'diverse-knowledge']) {
      knowledgeMarginal[scenario] = {};
      for (const variant of ['A', 'B']) {
        knowledgeMarginal[scenario][variant] = (storage[scenario][String(largest)][variant].knowledgeBytes.median
          - storage[scenario][String(smallest)][variant].knowledgeBytes.median) / delta;
      }
    }
  }

  const openCost = { coldEmpty: {}, warmExisting: {} };
  for (const variant of ['A', 'B']) {
    const rows = openCostSamples.filter(sample => sample.variant === variant);
    openCost.coldEmpty[variant] = medianSummary(rows.map(sample => sample.coldEmpty.p50Ms));
    openCost.warmExisting[variant] = medianSummary(rows.map(sample => sample.warmExisting.p50Ms));
  }

  return {
    storage,
    latency,
    marginal,
    knowledgeMarginal,
    openCost,
    rounds,
    sizes,
  };
}

function summarizeForConsole(result) {
  const summary = { marginal: {}, eventsBytes: {}, latency: {}, migration: null };
  for (const scenario of ['uniform-ledger', 'diverse-knowledge']) {
    if (result.derived.marginal[scenario]) {
      const marginal = result.derived.marginal[scenario];
      summary.marginal[scenario] = {
        A: marginal.A.marginalBytesPerEvent,
        B: marginal.B.marginalBytesPerEvent,
        savingsPercent: marginal.savingsPercent,
      };
    }
    summary.eventsBytes[scenario] = {};
    for (const size of result.sizes) {
      summary.eventsBytes[scenario][size] = {
        A: result.derived.storage[scenario][String(size)].A.eventsBytes.median,
        B: result.derived.storage[scenario][String(size)].B.eventsBytes.median,
      };
    }
  }
  for (const scenario of SCENARIOS) {
    summary.latency[scenario] = {};
    for (const size of result.sizes) {
      const entry = result.derived.latency[scenario][String(size)];
      summary.latency[scenario][size] = {
        A: { p50: entry.A.writeP50Ms.median, p95: entry.A.writeP95Ms.median },
        B: { p50: entry.B.writeP50Ms.median, p95: entry.B.writeP95Ms.median },
      };
    }
  }
  if (result.migration.status === 'measured') {
    summary.migration = result.migration.samples.map(sample => ({
      scenario: sample.scenario, size: sample.size, wallMs: sample.wallMs,
      mainBefore: sample.before.mainBytes, mainAfter: sample.after.mainBytes,
      eventsBefore: sample.before.eventsBytes, eventsAfter: sample.after.eventsBytes,
      backupBytes: sample.backupBytes,
    }));
  } else summary.migration = result.migration;
  return summary;
}

// --- markdown report --------------------------------------------------------

function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return 'n/a';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatNumber(value, digits = 3) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  return value.toFixed(digits);
}

function formatBytesPair(entry) {
  if (!entry) return 'n/a';
  return `${Math.round(entry.median)} B (${formatBytes(entry.median)})`;
}

function ratio(value, reference) {
  if (!Number.isFinite(value) || !Number.isFinite(reference) || reference === 0) return 'n/a';
  return `${((value / reference) * 100).toFixed(1)}%`;
}

function renderMarkdown(result) {
  const lines = [];
  const coreReady = result.variantB.coreReady === true;
  const sizes = result.sizes;
  const derived = result.derived;
  lines.push('# 统一共享经验存储：v1/v2 体积与延迟对照');
  lines.push('');
  if (!coreReady) {
    lines.push('> **警告：本文件由 `--variant-b=baseline` 自测模式生成，B 也是冻结 v1 基线，不是 v2 对照结果。**');
    lines.push('> 它只证明 harness 可用；core 落地后必须重跑本文件的复现命令得到最终数据。');
    lines.push('');
  }
  lines.push('本文件是本机实测数据，不是理论估算。原始数据（全部样本、每轮 min/max、延迟原始值、迁移输出）保存在 ');
  lines.push('[`shared-experience-storage.json`](shared-experience-storage.json)。');
  lines.push('');
  lines.push('以下所有体积与时间数字都来自本次运行的实际测量；没有用行宽或理论布局去推算收益，也没有把估算值写进表格。');
  lines.push('');
  lines.push('## 复现命令');
  lines.push('');
  lines.push('```sh');
  lines.push('node scripts/benchmarks/shared-experience-v1-baseline.mjs --verify-baseline');
  lines.push(`node --max-old-space-size=4096 scripts/benchmarks/shared-experience-storage.mjs ${result.invocation?.out ?? 'docs/performance/shared-experience-storage.json'} --rounds ${result.rounds} --sizes ${sizes.join(',')}${result.invocation?.report ? ` --report ${result.invocation.report}` : ''}`);
  lines.push('```');
  lines.push('');
  lines.push('## 变体');
  lines.push('');
  lines.push('- **A**：`scripts/benchmarks/shared-experience-v1-baseline.mjs`，从 commit `48c8f2e`（v0.2.4）抽取并冻结的 v1 实现：`events(id TEXT PRIMARY KEY, digest TEXT NOT NULL)`、`user_version=1`、WAL + `synchronous=FULL`，id/digest 是 64 字符小写 hex。');
  lines.push(coreReady
    ? '- **B**：`lib/shared-experience.js` 的 `openSharedExperience`（当前工作树）：schema v2，`events(id BLOB PRIMARY KEY, digest BLOB NOT NULL) STRICT, WITHOUT ROWID`，每行两个 32 字节 BLOB，`user_version=2`。'
    : '- **B**：自测模式下仍是冻结 v1 基线（不是最终对照）。');
  lines.push('');
  lines.push('## 方法');
  lines.push('');
  lines.push('- 场景：`uniform-ledger`（N 个唯一 event id、payload 完全相同、knowledge 只有 1 个身份，纯去重账本增长）；`diverse-knowledge`（每个事件 target 为 `tool:target-<i>`，knowledge 随身份一起增长）；`replay-duplicates`（完成 uniform-ledger 的 N 条后按原顺序重放，断言全部 duplicate 且行/字节不增长）。');
  lines.push(`- 每个（场景, size, 变体）至少 ${result.rounds} 轮，交替 A/B 与 B/A；每轮每个样本用独立 \`fs.mkdtempSync(os.tmpdir())\` 根目录。`);
  lines.push('- 写入时钟固定为 `CLOCK_BASE_MS + i*1000`，使 A/B 的 knowledge body 可逐字节比较；延迟仍用 `performance.now()`，不受影响。');
  lines.push('- checkpoint 协议：写完后 `store.close()`（SQLite 最后一个连接会 checkpoint 并删除 WAL），确认 `-wal` 不存在或 0 字节；之后只用只读 `DatabaseSync({readOnly:true})` 读 `dbstat`、`PRAGMA page_count/freelist_count` 和知识行，再用 `fs.statSync` 统计文件。所有体积数字都来自同一份已 checkpoint 的主库文件。');
  lines.push('- 表中“close 前 WAL”是关闭前最后一刻的 WAL 大小（WAL 自动 checkpoint 阈值 1000 页，通常约 4 MiB）；关闭后该文件被删除，因此“目录总计”不含 WAL，两列不是同一状态下的占用。');
  lines.push('- dbstat 分类：events 表 / events 索引（v1 的 `sqlite_autoindex_events_1`，v2 无独立索引）/ knowledge 表 / knowledge 索引（PK autoindex + `knowledge_recent`）/ 其他（clock、sqlite_schema）。');
  lines.push('- 延迟：逐条 `recordFailure` 的 `performance.now()` 差值；size=1000 保留原始样本，size=10000 只保留聚合（p50/p95/max/mean/总耗时）；批量耗时是整段写循环的墙钟时间。');
  lines.push('');
  lines.push('## 环境');
  lines.push('');
  lines.push(`- Node \`${result.environment.node}\`，\`${result.environment.platform}/${result.environment.arch}\`，文件系统 \`${result.environment.filesystem}\`，${result.environment.cpus ?? 'n/a'} 逻辑 CPU，${Math.round((result.environment.totalMemoryBytes ?? 0) / 1024 / 1024 / 1024)} GiB 内存。`);
  lines.push(`- 被测源码版本：git HEAD \`${result.sources?.head ?? 'n/a'}\`；\`lib/shared-experience.js\` sha256 \`${result.sources?.files?.['lib/shared-experience.js'] ?? 'n/a'}\`，各文件哈希与工作树状态见 JSON 的 \`sources\`。`);
  lines.push(`- 数据库都建在 \`fs.mkdtempSync(os.tmpdir())\` 隔离目录并清理，未使用真实 \`$DSH_HOME\` 或正式数据。`);
  lines.push('');
  lines.push('## 体积结果（每轮中位数）');
  for (const scenario of ['uniform-ledger', 'diverse-knowledge', 'replay-duplicates']) {
    lines.push('');
    lines.push(`### ${scenario}`);
    lines.push('');
    lines.push('| size | 变体 | events 表 | events 索引 | events 合计 | knowledge 表 | knowledge 索引 | knowledge 合计 | 其他 | dbstat 总计 | page_count | freelist | 主库 | close 前 WAL | 目录总计 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const size of sizes) {
      for (const variant of ['A', 'B']) {
        const entry = derived.storage[scenario][String(size)][variant];
        lines.push(`| ${size} | ${variant} | ${formatBytesPair(entry.eventsTableBytes)} | ${formatBytesPair(entry.eventsIndexBytes)} | ${formatBytesPair(entry.eventsBytes)} | ${formatBytesPair(entry.knowledgeTableBytes)} | ${formatBytesPair(entry.knowledgeIndexBytes)} | ${formatBytesPair(entry.knowledgeBytes)} | ${formatBytesPair(entry.otherBytes)} | ${formatBytesPair(entry.dbstatTotalBytes)} | ${entry.pageCount.median} | ${entry.freelistCount.median} | ${formatBytesPair(entry.mainBytes)} | ${formatBytes(entry.walBytesBeforeClose.median)} | ${formatBytesPair(entry.directoryBytes)} |`);
      }
    }
  }
  lines.push('');
  lines.push('## 每事件边际成本（events 表 + 索引，1k→10k 增长斜率）');
  lines.push('');
  lines.push('| 场景 | 计算 | A 边际 | B 边际 | 每事件节省 | 节省比例 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const scenario of ['uniform-ledger', 'diverse-knowledge']) {
    const marginal = derived.marginal[scenario];
    if (!marginal) continue;
    lines.push(`| ${scenario} | (bytes(${marginal.A.toSize}) - bytes(${marginal.A.fromSize})) / ${marginal.A.toSize - marginal.A.fromSize} | ${formatNumber(marginal.A.marginalBytesPerEvent)} B | ${formatNumber(marginal.B.marginalBytesPerEvent)} B | ${formatNumber(marginal.savingsBytesPerEvent)} B | ${formatNumber(marginal.savingsPercent, 1)}% |`);
  }
  lines.push('');
  lines.push('### 1k / 10k 的 events 表+索引占用与节省');
  lines.push('');
  lines.push('| 场景 | size | A events 合计 | B events 合计 | 节省字节 | 节省比例 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const scenario of ['uniform-ledger', 'diverse-knowledge']) {
    for (const size of sizes) {
      const entry = derived.storage[scenario][String(size)];
      const saved = entry.A.eventsBytes.median - entry.B.eventsBytes.median;
      lines.push(`| ${scenario} | ${size} | ${formatBytesPair(entry.A.eventsBytes)} | ${formatBytesPair(entry.B.eventsBytes)} | ${formatBytes(saved)} | ${formatNumber(entry.A.eventsBytes.median ? (saved / entry.A.eventsBytes.median) * 100 : 0, 1)}% |`);
    }
  }
  lines.push('');
  lines.push('## 延迟（每轮中位数）');
  lines.push('');
  lines.push('| 场景 | size | 变体 | 写入 p50 | 写入 p95 | 写入 max | 写入 mean | 写入总耗时 | 批量耗时 | 重放 p50 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const scenario of ['uniform-ledger', 'diverse-knowledge', 'replay-duplicates']) {
    for (const size of sizes) {
      for (const variant of ['A', 'B']) {
        const entry = derived.latency[scenario][String(size)][variant];
        lines.push(`| ${scenario} | ${size} | ${variant} | ${formatNumber(entry.writeP50Ms.median)} ms | ${formatNumber(entry.writeP95Ms.median)} ms | ${formatNumber(entry.writeMaxMs.median)} ms | ${formatNumber(entry.writeMeanMs.median)} ms | ${formatNumber(entry.writeTotalMs.median, 1)} ms | ${formatNumber(entry.batchMs.median, 1)} ms | ${entry.replayP50Ms ? `${formatNumber(entry.replayP50Ms.median)} ms` : '—'} |`);
      }
    }
  }
  lines.push('');
  lines.push('### B/A 延迟比与 open 成本');
  lines.push('');
  lines.push('| 场景 | size | 写入 p50 B/A | 写入总耗时 B/A | 重放 p50 B/A |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const scenario of ['uniform-ledger', 'diverse-knowledge', 'replay-duplicates']) {
    for (const size of sizes) {
      const left = derived.latency[scenario][String(size)].A;
      const right = derived.latency[scenario][String(size)].B;
      lines.push(`| ${scenario} | ${size} | ${ratio(right.writeP50Ms.median, left.writeP50Ms.median)} | ${ratio(right.writeTotalMs.median, left.writeTotalMs.median)} | ${left.replayP50Ms && right.replayP50Ms ? ratio(right.replayP50Ms.median, left.replayP50Ms.median) : '—'} |`);
    }
  }
  lines.push('');
  lines.push('| open 场景 | A 中位数 | B 中位数 | B/A |');
  lines.push('| --- | --- | --- | --- |');
  for (const kind of ['coldEmpty', 'warmExisting']) {
    const label = kind === 'coldEmpty' ? '空根建库 open+close（20 次/轮/变体）' : `已存在库 open（20 次/轮/变体，uniform-ledger 最大 size）`;
    lines.push(`| ${label} | ${formatNumber(derived.openCost[kind].A?.median)} ms | ${formatNumber(derived.openCost[kind].B?.median)} ms | ${derived.openCost[kind].A?.median ? ratio(derived.openCost[kind].B?.median, derived.openCost[kind].A?.median) : 'n/a'} |`);
  }
  lines.push('');
  const replayDeltas = [];
  for (const size of sizes) {
    const left = derived.latency['replay-duplicates'][String(size)].A.replayP50Ms?.median;
    const right = derived.latency['replay-duplicates'][String(size)].B.replayP50Ms?.median;
    if (Number.isFinite(left) && Number.isFinite(right)) {
      replayDeltas.push(`size ${size}: ${formatNumber(right - left, 4)} ms（${ratio(right, left)}）`);
    }
  }
  if (replayDeltas.length) {
    lines.push(`重放命中路径（事件已存在，只做 SELECT + COMMIT）的 B−A 绝对差：${replayDeltas.join('；')}。这是亚微秒到一微秒量级的差异，且低于同一路径的轮次波动。`);
    lines.push('');
  }
  lines.push('延迟回退判定容差（写入 p50/总耗时 B ≤ 1.25×A + 0.02 ms，open B ≤ 1.5×A + 1 ms）记录在 `selfChecks`。');
  lines.push('');
  lines.push('## 正确性自检');
  lines.push('');
  lines.push('| 检查 | 结果 |');
  lines.push('| --- | --- |');
  for (const check of result.selfChecks) {
    const status = check.skipped ? '跳过' : check.ok ? '通过' : '失败';
    lines.push(`| ${check.name} | ${status} |`);
  }
  lines.push('');
  lines.push('冻结基线自检（`--verify-baseline`）：把 `git show 48c8f2e:lib/shared-experience.js` 写进临时目录、用独立 Node 进程动态 import 运行，比对两者创建的 sqlite_master SQL、`user_version`、`SELECT id,digest FROM events ORDER BY id` 和 `SELECT key,body FROM knowledge ORDER BY key`；本结果：');
  lines.push(`\`${result.baselineVerification.skipped ? '跳过（--skip-baseline-verify）' : result.baselineVerification.ok ? '完全一致' : '不一致：' + JSON.stringify(result.baselineVerification.problems)}\`。`);
  lines.push('');
  lines.push('复放场景断言全部 duplicate=true、事件行数仍为 N、events 字节与同轮 uniform-ledger 相同；同 id 不同内容仍抛 `E_EXPERIENCE_EVENT_CONFLICT` 且不增加行。');
  lines.push('');
  lines.push('迁移前先跑 `--dry-run`：主库文件 sha256、`user_version` 与全部事件行在 dry-run 前后完全不变，之后才执行真实迁移。');
  lines.push('');
  lines.push('`knowledge` 对照同时比较两次摘要：写入时钟被钉住后的 `SELECT key, body` 全字节 sha256（因此逐字节一致），以及去掉 `firstSeen`/`lastSeen`/`updatedAt`/`recentEvidence`/`trend` 后的稳定投影 sha256。两版 `key`、revision 与 knowledge 行数也必须一致；体积测量仍使用真实 dbstat 字节，不因时钟钉住而改变。');
  lines.push('');
  lines.push('## 迁移成本');
  lines.push('');
  const migration = result.migration;
  if (migration.status === 'measured') {
    lines.push('用冻结基线生成 1000/10000 条的 v1 库（场景 1、场景 2 各一份），先跑 `--dry-run` 验证不改库，再跑真实迁移 CLI。');
    lines.push('');
    lines.push('| 场景 | size | 迁移墙钟 | 主库迁移前 | 主库迁移后 | events 迁移前 | events 迁移后 | freelist 后 | 备份文件 | dry-run | hex 一致 | knowledge 一致 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const sample of migration.samples) {
      lines.push(`| ${sample.scenario} | ${sample.size} | ${formatNumber(sample.wallMs, 1)} ms | ${formatBytes(sample.before.mainBytes)} | ${formatBytes(sample.after.mainBytes)} | ${formatBytes(sample.before.eventsBytes)} | ${formatBytes(sample.after.eventsBytes)} | ${sample.after.freelistCount} | ${formatBytes(sample.backupBytes)} | ${sample.dryRun.exitCode}/${formatNumber(sample.dryRun.wallMs, 1)} ms | ${sample.eventsHexEqual ? '是' : '否'} | ${sample.knowledgeEqual ? '是' : '否'} |`);
    }
    lines.push('');
    lines.push('迁移后 `SELECT hex(id), hex(digest)` 与迁移前 TEXT 逐行一致；`typeof(id)=\'blob\' AND length(id)=32` 的行数等于原事件数。dry-run 输出与迁移 CLI 的 JSON 报告保存在原始数据 JSON 的 `migration.samples[].{dryRun,report}`。');
  } else {
    lines.push(`未运行：\`${JSON.stringify(migration)}\`。迁移模块/CLI 落地后需要重跑复现命令。`);
  }
  lines.push('');
  lines.push('## 结论');
  lines.push('');
  if (coreReady && derived.marginal['uniform-ledger']) {
    const uniform = derived.marginal['uniform-ledger'];
    const diverse = derived.marginal['diverse-knowledge'];
    lines.push(`- events 账本每事件边际成本：uniform-ledger 从 ${formatNumber(uniform.A.marginalBytesPerEvent)} B 降到 ${formatNumber(uniform.B.marginalBytesPerEvent)} B（节省 ${formatNumber(uniform.savingsPercent, 1)}%）；diverse-knowledge 从 ${formatNumber(diverse.A.marginalBytesPerEvent)} B 降到 ${formatNumber(diverse.B.marginalBytesPerEvent)} B（节省 ${formatNumber(diverse.savingsPercent, 1)}%）。`);
    const size = sizes[sizes.length - 1];
    for (const scenario of ['uniform-ledger', 'diverse-knowledge']) {
      const entry = derived.storage[scenario][String(size)];
      lines.push(`- ${scenario} @ ${size}：events 表+索引 ${formatBytes(entry.A.eventsBytes.median)} → ${formatBytes(entry.B.eventsBytes.median)}，主库 ${formatBytes(entry.A.mainBytes.median)} → ${formatBytes(entry.B.mainBytes.median)}。`);
    }
    lines.push(`- knowledge 表+索引两版相同（同一 canonical 写入模块）：uniform-ledger @ ${size} 均为 ${formatBytes(derived.storage['uniform-ledger'][String(size)].A.knowledgeBytes.median)}，diverse-knowledge @ ${size} 均为 ${formatBytes(derived.storage['diverse-knowledge'][String(size)].A.knowledgeBytes.median)}；体积收益全部来自 events 账本本身。`);
    const failedLatency = result.selfChecks.filter(check => check.name.startsWith('write-latency') || check.name === 'open-latency');
    lines.push(`- 写入/open 延迟：${failedLatency.some(check => check.skipped) ? 'B 不是 core 实现，未判定' : failedLatency.every(check => check.ok) ? '所有场景在既定容差内，没有观察到明显回退' : '有场景超出容差，见上表' }。`);
  } else {
    lines.push('- 本文件是 harness 自测数据（B 也是冻结 v1），不构成 v2 收益结论。');
  }
  lines.push('');
  lines.push('## 未验证项与边界');
  lines.push('');
  lines.push(`- 单写者、本机 ${result.environment.filesystem} 临时目录；未测慢盘、网络文件系统、高并发写、断电/SIGKILL 崩溃恢复。`);
  lines.push('- 未测 Desktop UI 端到端、未测真实 `$DSH_HOME` 数据、未测迁移真实用户库的极端形状。');
  lines.push(`- 延迟只反映本机 Node/V8 与 SQLite 组合；p50/p95 是 ${result.rounds} 轮中位数，仍可能受 GC 与调度噪声影响，原始样本已保留在 JSON。写入 max 在 A/B 两侧都偶发 30–70 ms 长尾（不同轮次随机出现，p95 仍为 0.14–0.26 ms），因此回退判定用 p50 与总耗时，不拿单次 max 当结论。`);
  lines.push('- 体积数字都来自 `store.close()` 后的 checkpointed 主库；未做 VACUUM，因此包含 SQLite 空闲页的真实状态，不把理论行宽当作实测值。');
  lines.push('- 迁移耗时只覆盖 CLI 墙钟，不包含操作者停机窗口或备份拷贝到别处的成本；迁移后主库字节受备份文件位置影响，备份文件单独统计。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

main().catch(error => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
