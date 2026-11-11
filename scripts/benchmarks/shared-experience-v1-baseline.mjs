// Frozen benchmark baseline: the shared-experience store exactly as it shipped
// in the v0.2.4 release (commit 48c8f2e, sha256 pinned below).
//
// This module exists only so an A/B benchmark can keep measuring the old
// on-disk layout after `lib/shared-experience.js` starts creating schema v2.
// It deliberately does NOT import the evolving `lib/shared-experience.js`; the
// `openSharedExperience` implementation, the schema SQL, the `user_version=1`
// write and the `recordFailure` projection are copied verbatim from the pinned
// source. The only imported code is `lib/dockyard-domain/knowledge.js`, which
// the pinned module itself imported and which both sides of the A/B comparison
// share; the store layout itself is frozen.
//
// The `--verify-baseline` self-check rebuilds the pinned module from
// `git show 48c8f2e:lib/shared-experience.js` in a temporary directory, runs it
// in a separate Node process, and asserts that this frozen copy creates the
// same sqlite_master SQL, user_version, `SELECT id,digest FROM events ORDER BY
// id` rows and `SELECT key,body FROM knowledge ORDER BY key` rows for the same
// write sequence. That is what makes it safe to compare new code against it.
//
//   node scripts/benchmarks/shared-experience-v1-baseline.mjs --verify-baseline
//
// Bounds: this is a single-writer, local-filesystem baseline. It is not a
// correctness oracle for anything the pinned module did not do, and it is not
// a second implementation to keep in sync; it is a measurement artifact.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeKnowledgeEvent, mergeKnowledgeEntry } from '../../lib/dockyard-domain/knowledge.js';

const require = createRequire(import.meta.url);
const digest = value => createHash('sha256').update(value).digest('hex');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value) ? value : null;
const failureCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : 'HOST_OPERATION_FAILED';

export const FROZEN_BASELINE = Object.freeze({
  commit: '48c8f2e',
  path: 'lib/shared-experience.js',
  sha256: '1fd31c7a9612fb6b05f18da0e114a50e93d75004e39174fb9201fc3241ea7ba4',
});

/**
 * The pinned `openSharedExperience`. Copied from commit 48c8f2e; only
 * `recordEvolution` / `recordConclusion` / read paths were dropped, and
 * `schemaVersion: 1` was added so callers can identify the variant. The
 * schema SQL, WAL/FULL pragmas, table set and the write transaction are
 * byte-for-byte the pinned behavior.
 */
export function openSharedExperienceV1Baseline(root) {
  root = path.resolve(root);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = fs.lstatSync(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077)
    || (process.getuid && directory.uid !== process.getuid())) throw new Error('E_EXPERIENCE_PRIVATE_ROOT');
  const file = path.join(root, 'experience.sqlite');
  try { fs.closeSync(fs.openSync(file, 'wx', 0o600)); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)
    || (process.getuid && stat.uid !== process.getuid())) throw new Error('E_EXPERIENCE_PRIVATE_FILE');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  let closed = false;
  try {
    db.exec('PRAGMA busy_timeout=250');
    // Refuse a foreign database before changing its journal mode.
    db.exec('BEGIN');
    const initialVersion = db.prepare('PRAGMA user_version').get().user_version;
    const initialTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
    if (initialVersion !== 0 && initialVersion !== 1) throw new Error('E_EXPERIENCE_SCHEMA');
    if ((initialVersion === 0 && initialTables.length)
      || (initialVersion === 1 && initialTables.join(',') !== 'clock,events,knowledge')) throw new Error('E_EXPERIENCE_UNKNOWN_DATABASE');
    db.exec('COMMIT');
    // Two first openers can both try to enable WAL before the schema exists.
    // SQLite's journal-mode transition can return BUSY without invoking its
    // busy handler. Retry only this observed startup contention, within 1 s.
    const deadline = Date.now() + 1000;
    while (true) {
      try {
        if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') db.exec('PRAGMA journal_mode=WAL');
        break;
      } catch (error) {
        if (error.errcode !== 5 || Date.now() >= deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    db.exec('PRAGMA synchronous=FULL');
    if (initialVersion === 0) {
      // Only a first opener needs a schema write. Give startup a bounded 2 s
      // window; an already initialized reader must not queue behind writers.
      db.exec('PRAGMA busy_timeout=2000; BEGIN IMMEDIATE');
      try {
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version !== 0 && version !== 1) throw new Error('E_EXPERIENCE_SCHEMA');
      if (version === 0) {
        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length) throw new Error('E_EXPERIENCE_UNKNOWN_DATABASE');
        db.exec(`CREATE TABLE events (id TEXT PRIMARY KEY, digest TEXT NOT NULL);
          CREATE TABLE knowledge (key TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL);
          CREATE INDEX knowledge_recent ON knowledge(revision);
          CREATE TABLE clock (value INTEGER NOT NULL); INSERT INTO clock VALUES (0);
          PRAGMA user_version=1;`);
      }
      db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    // The collector writes synchronously from a host event listener, so this
    // wait is the whole latency bound: a busy writer blocks, and a wait that
    // expires drops the fact with a warning. 250 ms on a slow disk let four
    // concurrent hosts starve one writer past the timeout (the four-process test
    // failed on both CI Node lines), so normal transactions use the same 2 s
    // bound as the first schema write instead of dropping a fact the next short
    // wait would have committed.
    db.exec('PRAGMA busy_timeout=2000');
  } catch (error) { db.close(); throw error; }
  const assertOpen = () => { if (closed) throw new Error('E_EXPERIENCE_CLOSED'); };
  function record(id, input, sourceCollection, order) {
    assertOpen();
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('E_EXPERIENCE_EVENT_ID');
    // Only the projected semantic content participates in conflict detection;
    // a transport replay may arrive at a different wall-clock time.
    const contentDigest = digest(JSON.stringify(input));
    db.exec('BEGIN IMMEDIATE');
    try {
      const prior = db.prepare('SELECT digest FROM events WHERE id=?').get(id);
      if (prior) {
        if (prior.digest !== contentDigest) throw new Error('E_EXPERIENCE_EVENT_CONFLICT');
        db.exec('COMMIT');
        return { committed: true, duplicate: true };
      }
      const event = normalizeKnowledgeEvent({ ...input, eventId: id }, { sourceCollection });
      if (!event) throw new Error('E_EXPERIENCE_NO_KNOWLEDGE');
      const previous = db.prepare('SELECT body FROM knowledge WHERE key=?').get(event.knowledgeKey);
      const old = previous ? JSON.parse(previous.body) : null;
      const next = mergeKnowledgeEntry(old, event);
      const older = old && (order && old.sharedLatest?.source === order.source
        ? order.sequence < old.sharedLatest.sequence
        : event.occurredAt < old.lastSeen);
      if (older) {
        // The ledger still absorbs the missing historical fact and its counters,
        // but a late backfill must not replace the latest production outcome.
        for (const key of ['state', 'lastStatus', 'lastOutcome']) next[key] = old[key];
        next.trend = { ...next.trend, recent: old.trend?.recent ?? [], lastOutcome: old.lastOutcome,
          direction: old.state === 'REGRESSED' ? 'worsening' : next.failureCount > 0 ? 'mixed' : 'stable' };
        if (old.sharedLatest) next.sharedLatest = old.sharedLatest;
      } else if (order) next.sharedLatest = order;
      db.prepare('INSERT INTO events VALUES (?,?)').run(id, contentDigest);
      db.exec('UPDATE clock SET value=value+1');
      db.prepare('INSERT INTO knowledge VALUES (?,?,(SELECT value FROM clock)) ON CONFLICT(key) DO UPDATE SET body=excluded.body, revision=excluded.revision')
        .run(event.knowledgeKey, JSON.stringify(next));
      db.exec('COMMIT');
      return { committed: true, duplicate: false, knowledgeKey: event.knowledgeKey };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return Object.freeze({
    schemaVersion: 1,
    recordFailure({ id, type, code, target }) {
      const safeCode = failureCode(code);
      const safeTarget = identifier(target) || 'host';
      return record(id, { type: type === 'agent/error' ? 'agent/error' : 'tool/error',
        code: safeCode, componentId: safeTarget, severity: 'error', status: 'failed',
        message: `Official operation failed (${safeCode})` }, 'observations');
    },
    stats() {
      assertOpen();
      return { events: db.prepare('SELECT count(*) AS n FROM events').get().n,
        knowledge: db.prepare('SELECT count(*) AS n FROM knowledge').get().n };
    },
    close() { if (!closed) { db.close(); closed = true; } },
  });
}

// --- deterministic write clock ---------------------------------------------
// The pinned record path reads the wall clock (`new Date()` inside
// `normalizeKnowledgeEvent` / `mergeKnowledgeEntry`), so two runs an instant
// apart would persist different knowledge bodies. The benchmark sets a
// fake clock to a fixed value before every write of the same sequence, which
// makes the stored knowledge bytes comparable between A and B without changing
// the measured code path. `performance.now()` is untouched, so latencies are
// still real.
const VERIFICATION_BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

export function installFakeClock() {
  const RealDate = Date;
  let current = VERIFICATION_BASE_MS;
  class FakeDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [current])); }
    static now() { return current; }
  }
  globalThis.Date = FakeDate;
  return {
    set(milliseconds) { current = milliseconds; },
    now() { return current; },
    restore() { globalThis.Date = RealDate; },
  };
}

export const verificationBaseMs = VERIFICATION_BASE_MS;

/** Deterministic recordFailure payload for verify-baseline (index 0..79). */
export function verificationPayload(index) {
  return {
    id: digest(`shared-experience-v1-baseline-verify:${index}`),
    type: index % 3 === 0 ? 'agent/error' : 'tool/error',
    code: index % 7 === 0 ? 'EACCES' : 'ENOENT',
    target: index % 4 === 0 ? `tool:verify-${index}` : 'tool:read_file',
  };
}

/** Write 80 unique facts, replay 20 of them, then attempt one conflicting id. */
export function runVerificationWrites(store, clock) {
  const duplicateFlags = [];
  for (let index = 0; index < 80; index += 1) {
    clock.set(VERIFICATION_BASE_MS + index * 1000);
    duplicateFlags.push(store.recordFailure(verificationPayload(index)).duplicate);
  }
  for (let index = 0; index < 20; index += 1) {
    clock.set(VERIFICATION_BASE_MS + index * 1000);
    duplicateFlags.push(store.recordFailure(verificationPayload(index)).duplicate);
  }
  clock.set(VERIFICATION_BASE_MS + 1000);
  let conflictCode = null;
  try {
    const first = verificationPayload(0);
    store.recordFailure({ ...first, code: first.code === 'EACCES' ? 'ENOENT' : 'EACCES' });
  } catch (error) { conflictCode = error.message; }
  return { duplicateFlags, conflictCode };
}

/**
 * Read-only snapshot of a v1 database, as plain JSON-compatible objects. A
 * fresh read-only connection reports the persisted journal mode, user_version,
 * full sqlite_master rows, the ledger and the canonical knowledge bodies.
 */
export function snapshotV1Database(root) {
  const file = path.join(path.resolve(root), 'experience.sqlite');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const plain = row => Object.fromEntries(Object.entries(row));
    return {
      userVersion: db.prepare('PRAGMA user_version').get().user_version,
      journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode,
      master: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all().map(plain),
      events: db.prepare('SELECT id, digest FROM events ORDER BY id').all().map(plain),
      knowledge: db.prepare('SELECT key, body FROM knowledge ORDER BY key').all().map(plain),
      eventCount: db.prepare('SELECT count(*) AS n FROM events').get().n,
      knowledgeCount: db.prepare('SELECT count(*) AS n FROM knowledge').get().n,
    };
  } finally { db.close(); }
}

const BASELINE_MODULE_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(BASELINE_MODULE_PATH), '..', '..');

function compareSnapshots(legacy, frozen) {
  const problems = [];
  const same = (label, left, right) => {
    const leftText = JSON.stringify(left);
    const rightText = JSON.stringify(right);
    if (leftText !== rightText) problems.push(`${label} differs`);
  };
  same('user_version', legacy.userVersion, frozen.userVersion);
  same('journal_mode', legacy.journalMode, frozen.journalMode);
  same('sqlite_master', legacy.master, frozen.master);
  same('events rows', legacy.events, frozen.events);
  same('knowledge rows', legacy.knowledge, frozen.knowledge);
  same('event count', legacy.eventCount, frozen.eventCount);
  same('knowledge count', legacy.knowledgeCount, frozen.knowledgeCount);
  return problems;
}

/**
 * Rebuild the pinned module from git, run it in a separate Node process, and
 * compare its persisted database with this frozen copy for one fixed sequence.
 * Returns a report; throws only on infrastructure failures.
 */
export async function verifyFrozenBaseline({ keepTemporary = false } = {}) {
  const source = execFileSync('git', ['show', `${FROZEN_BASELINE.commit}:${FROZEN_BASELINE.path}`], {
    cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  if (sourceSha256 !== FROZEN_BASELINE.sha256) {
    throw new Error(`pinned source drifted: ${FROZEN_BASELINE.commit}:${FROZEN_BASELINE.path} is ${sourceSha256}`);
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-se-v1-baseline-verify-'));
  try {
    // The pinned source is ESM but the temporary directory has no package
    // scope, so mark the temporary scope as module and keep the extracted
    // source byte-for-byte unchanged.
    fs.writeFileSync(path.join(temporary, 'package.json'), '{"type":"module"}\n');
    fs.writeFileSync(path.join(temporary, 'legacy-shared-experience.js'), source);
    fs.symlinkSync(path.join(REPO_ROOT, 'lib', 'dockyard-domain'), path.join(temporary, 'dockyard-domain'), 'dir');
    fs.symlinkSync(path.join(REPO_ROOT, 'lib', 'experience-recall.js'), path.join(temporary, 'experience-recall.js'), 'file');
    fs.symlinkSync(path.join(REPO_ROOT, 'lib', 'experience-plan.js'), path.join(temporary, 'experience-plan.js'), 'file');
    const baselineUrl = pathToFileURL(BASELINE_MODULE_PATH).href;
    fs.writeFileSync(path.join(temporary, 'legacy-runner.mjs'), [
      `import { pathToFileURL } from 'node:url';`,
      `import { installFakeClock, runVerificationWrites, snapshotV1Database } from ${JSON.stringify(baselineUrl)};`,
      `import fs from 'node:fs';`,
      `const { openSharedExperience } = await import(pathToFileURL(process.argv[2]).href);`,
      `const root = process.argv[3];`,
      `const clock = installFakeClock();`,
      `const store = openSharedExperience(root);`,
      `const writes = runVerificationWrites(store, clock);`,
      `const stats = store.stats();`,
      `clock.restore();`,
      `store.close();`,
      `fs.writeFileSync(process.argv[4], JSON.stringify({ writes, stats, snapshot: snapshotV1Database(root) }));`,
      ``,
    ].join('\n'));
    const legacyRoot = path.join(temporary, 'legacy-root');
    fs.mkdirSync(legacyRoot, { recursive: true, mode: 0o700 });
    execFileSync(process.execPath, [
      path.join(temporary, 'legacy-runner.mjs'),
      path.join(temporary, 'legacy-shared-experience.js'),
      legacyRoot,
      path.join(temporary, 'legacy-dump.json'),
    ], { stdio: 'pipe', timeout: 120_000 });
    const legacy = JSON.parse(fs.readFileSync(path.join(temporary, 'legacy-dump.json'), 'utf8'));

    const frozenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-se-v1-frozen-'));
    let frozen;
    try {
      const clock = installFakeClock();
      const store = openSharedExperienceV1Baseline(frozenRoot);
      const writes = runVerificationWrites(store, clock);
      const stats = store.stats();
      clock.restore();
      store.close();
      frozen = { writes, stats, snapshot: snapshotV1Database(frozenRoot) };
    } finally { fs.rmSync(frozenRoot, { recursive: true, force: true }); }

    const problems = compareSnapshots(legacy.snapshot, frozen.snapshot);
    if (JSON.stringify(legacy.writes) !== JSON.stringify(frozen.writes)) problems.push('write results differ');
    if (JSON.stringify(legacy.stats) !== JSON.stringify(frozen.stats)) problems.push('stats differ');
    return {
      ok: problems.length === 0,
      problems,
      sourceSha256,
      sourceCommit: FROZEN_BASELINE.commit,
      eventCount: legacy.snapshot.eventCount,
      knowledgeCount: legacy.snapshot.knowledgeCount,
      userVersion: legacy.snapshot.userVersion,
      journalMode: legacy.snapshot.journalMode,
      schemaSql: legacy.snapshot.master.filter(row => row.type === 'table' && row.name === 'events').map(row => row.sql),
    };
  } finally {
    if (!keepTemporary) fs.rmSync(temporary, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(BASELINE_MODULE_PATH);
if (invokedDirectly) {
  if (!process.argv.includes('--verify-baseline')) {
    console.error('usage: node scripts/benchmarks/shared-experience-v1-baseline.mjs --verify-baseline');
    process.exitCode = 1;
  } else {
    verifyFrozenBaseline()
      .then(report => {
        console.log(JSON.stringify(report, null, 2));
        if (!report.ok) process.exitCode = 1;
      })
      .catch(error => {
        console.error(error?.stack ?? String(error));
        process.exitCode = 1;
      });
  }
}
