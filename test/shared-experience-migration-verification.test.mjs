/**
 * Independent, adversarial verification of the one-time
 * schema 1 -> schema 2 migration (`lib/shared-experience-migration.js` and
 * `scripts/migrate-experience-store.mjs`).
 *
 * Written from the acceptance criteria only, without reading the
 * implementation's own migration tests. A genuine schema-1 database is built
 * with `test/fixtures/shared-experience-v1.js` (the frozen v0.2.4 opener), then
 * enriched through the new schema-1 compatibility path with promotion, canary
 * and experiment-conclusion facts before the conversion.
 *
 * Covered: row-by-row identity equivalence, knowledge-row byte equivalence,
 * stats/recall/findConclusions/discover stability, backup completeness and
 * restore, WAL/freelist reclamation, idempotency, failure injection (malformed
 * rows, lock contention, backup conflicts/symlinks/directories, private-file
 * guards), SIGKILL crash windows, old-opener behavior after conversion, and the
 * CLI reports. All databases live under fresh `mkdtemp` roots; no DSH home or
 * real data is touched.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { openSharedExperience } from '../lib/shared-experience.js';
import { inspectSharedExperience, migrateSharedExperience } from '../lib/shared-experience-migration.js';
import { openSharedExperienceV1Baseline } from './fixtures/shared-experience-v1.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const MIGRATION_MODULE_URL = new URL('../lib/shared-experience-migration.js', import.meta.url).href;
const MIGRATION_CLI = fileURLToPath(new URL('../scripts/migrate-experience-store.mjs', import.meta.url));

const roots = [];
function scratch(prefix = 'dsh-se-migration-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
after(() => {
  for (const root of roots) {
    try { fs.chmodSync(root, 0o700); } catch { /* already gone */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const sha256 = value => createHash('sha256').update(value).digest('hex');
const dbFile = root => path.join(root, 'experience.sqlite');
const backupFile = root => `${dbFile(root)}.v1-backup`;

function raw(root, fn) {
  const db = new DatabaseSync(dbFile(root));
  try { return fn(db); } finally { db.close(); }
}

function rawFile(file, fn) {
  const db = new DatabaseSync(file);
  try { return fn(db); } finally { db.close(); }
}

function asIdentity(value) {
  return value instanceof Uint8Array ? Buffer.from(value).toString('hex') : String(value);
}

function readEvents(db) {
  return db.prepare('SELECT id AS id, digest AS digest, typeof(id) AS idType, typeof(digest) AS digestType, length(id) AS idBytes, length(digest) AS digestBytes FROM events ORDER BY id')
    .all()
    .map(row => ({
      ...row,
      id: asIdentity(row.id),
      digest: asIdentity(row.digest),
    }));
}

function readKnowledge(db) {
  return db.prepare('SELECT key, body, revision FROM knowledge ORDER BY key').all();
}

function fileHash(file) {
  return sha256(fs.readFileSync(file));
}

function fileSnapshot(root) {
  return fs.readdirSync(root).sort().map(name => {
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    return { name, bytes: stat.size, isFile: stat.isFile(), sha256: stat.isFile() ? fileHash(file) : null };
  });
}

function v1Snapshot(root) {
  return raw(root, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    return {
      version: 1,
      tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name),
      events: readEvents(db),
      knowledge: readKnowledge(db),
      stats: {
        events: db.prepare('SELECT count(*) AS n FROM events').get().n,
        knowledge: db.prepare('SELECT count(*) AS n FROM knowledge').get().n,
      },
    };
  });
}

/** Open the store through its public read surface and capture every reader. */
function readView(root) {
  const store = openSharedExperience(root);
  try {
    const view = {
      schemaVersion: store.schemaVersion,
      stats: store.stats(),
      recallTarget: store.recall({ target: 'plugin edge-cache' }),
      recallProblem: store.recall({ problem: 'cache warmup regression on the plugin' }),
      recallEmpty: store.recall({}),
      conclusions: store.findConclusions({ target: 'plugin edge-cache' }),
      conclusionsVersioned: store.findConclusions({
        target: 'plugin edge-cache',
        applicability: { dsh: '0.2.4', cordis: '4.0.1', evolution: '0.2.4' },
      }),
      discover: store.discover({ window: 500 }),
    };
    return view;
  } finally { store.close(); }
}

/** 0600 database file created by the frozen v0.2.4 implementation. */
function seedSimple(root, count = 300) {
  const targets = ['editor', 'terminal', 'component:cache'];
  const store = openSharedExperienceV1Baseline(root);
  try {
    for (let index = 0; index < count; index += 1) {
      store.recordFailure({
        id: index.toString(16).padStart(64, '0'),
        type: index % 5 === 0 ? 'agent/error' : 'tool/error',
        code: `E_SEED_${index % 3}`,
        target: targets[index % targets.length],
      });
    }
  } finally { store.close(); }
  return v1Snapshot(root);
}

/**
 * A schema-1 store with the fact families the migration must preserve: frozen
 * failure events, duplicate deliveries, a rejected conflict, promotion/canary
 * facts and experiment conclusions written through the schema-1 compatibility
 * path.
 */
function seedRichV1(root) {
  const failures = [];
  const targets = ['editor', 'terminal', 'component:cache', 'plugin:edge-cache'];
  const frozen = openSharedExperienceV1Baseline(root);
  try {
    for (let index = 0; index < 48; index += 1) {
      const failure = {
        id: sha256(`rich-failure-${index}`),
        type: index % 6 === 0 ? 'agent/error' : 'tool/error',
        code: `E_RICH_${index % 4}`,
        target: targets[index % targets.length],
      };
      failures.push(failure);
      assert.equal(frozen.recordFailure(failure).duplicate, false);
    }
    // A transport replay must not double count.
    assert.equal(frozen.recordFailure(failures[0]).duplicate, true);
    assert.equal(frozen.recordFailure(failures[0]).duplicate, true);
    // The same id with different content stays a conflict.
    assert.throws(() => frozen.recordFailure({ ...failures[0], code: 'E_RICH_CONFLICT' }), /E_EXPERIENCE_EVENT_CONFLICT/);
  } finally { frozen.close(); }

  const compat = openSharedExperience(root);
  try {
    assert.equal(compat.schemaVersion, 1, 'the enrichment path is the schema 1 compatibility opener');
    assert.equal(compat.recordFailure(failures[0]).duplicate, true, 'a frozen-path replay is still a duplicate');
    const promotions = [
      { eventId: 'evt-promotion-ok', eventType: 'promotion-succeeded', target: 'plugin:edge-cache', audit: { at: '2025-01-01T00:00:00.000Z' } },
      { eventId: 'evt-canary-ok', eventType: 'canary-passed', target: 'terminal', audit: { at: '2025-01-01T01:00:00.000Z' } },
      { eventId: 'evt-canary-bad', eventType: 'canary-failed', target: 'terminal', audit: { at: '2025-01-01T02:00:00.000Z' } },
      { eventId: 'evt-reverted', eventType: 'promotion-reverted', target: 'plugin:edge-cache', promotion: { adapter: 'official-include', rowId: 'row-42' }, audit: { at: '2025-01-01T03:00:00.000Z' } },
      { eventId: 'evt-failure-learned', eventType: 'failure-learned', target: 'component:cache', audit: { at: '2025-01-01T04:00:00.000Z' } },
    ];
    promotions.forEach((event, index) => {
      const result = compat.recordEvolution(event, 'desktop', { writer: 'host-a', sequence: index + 1 });
      assert.equal(result.committed, true, `promotion fact ${event.eventId} is committed`);
    });
    const conclusions = [
      {
        experimentId: 'exp-adopted', decision: 'adopted', strategyFingerprint: '1111222233334444',
        occurredAt: '2025-02-01T00:00:00.000Z', target: 'plugin edge-cache', strategy: 'warm cache',
        rootCause: 'cold cache', failureMode: 'cache-miss',
        applicability: { dsh: '0.2.4', cordis: '4.0.1', evolution: '0.2.4' }, metrics: { p95: 120.5, errorRate: 0.01 },
      },
      {
        experimentId: 'exp-regression', decision: 'regression', strategyFingerprint: '5555666677778888',
        occurredAt: '2025-02-02T00:00:00.000Z', target: 'plugin edge-cache', strategy: 'aggressive prefetch',
        rootCause: 'cache stampede', applicability: { dsh: '0.2.4', cordis: '4.0.1', evolution: '0.2.4' }, metrics: { p95: 340 },
      },
      {
        experimentId: 'exp-no-benefit', decision: 'no-benefit', strategyFingerprint: '9999aaaabbbbcccc',
        occurredAt: '2025-02-03T00:00:00.000Z', target: 'component cache', strategy: 'preload',
        applicability: { dsh: '0.2.4', cordis: '4.0.1', evolution: 'unknown' },
      },
      {
        experimentId: 'exp-insufficient', decision: 'insufficient-evidence', strategyFingerprint: 'ddddeeeeffff0000',
        occurredAt: '2025-02-04T00:00:00.000Z', target: 'terminal', strategy: 'retry',
      },
    ];
    for (const conclusion of conclusions) {
      const result = compat.recordConclusion(conclusion, 'desktop', { writer: 'host-a', sequence: 100 });
      assert.equal(result.committed, true, `conclusion ${conclusion.experimentId} is committed`);
    }
    // Duplicate conclusion delivery, then a distinct-content conflict on the same
    // identity tuple (strategy is not part of the event id).
    assert.equal(compat.recordConclusion(conclusions[0], 'desktop', { writer: 'host-a', sequence: 100 }).duplicate, true);
    assert.throws(
      () => compat.recordConclusion({ ...conclusions[0], strategy: 'different approach' }, 'desktop', { writer: 'host-a', sequence: 100 }),
      /E_EXPERIENCE_EVENT_CONFLICT/,
    );
  } finally { compat.close(); }

  return { failures, snapshot: v1Snapshot(root), view: readView(root) };
}

function assertV2MatchesV1(root, expected) {
  raw(root, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    assert.deepEqual(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name),
      ['clock', 'events', 'knowledge'],
    );
    const events = readEvents(db);
    assert.equal(events.length, expected.events.length);
    for (const row of events) {
      assert.equal(row.idType, 'blob');
      assert.equal(row.digestType, 'blob');
      assert.equal(Number(row.idBytes), 32);
      assert.equal(Number(row.digestBytes), 32);
    }
    assert.deepEqual(events.map(row => [row.id, row.digest]), expected.events.map(row => [row.id, row.digest]));
    assert.deepEqual(readKnowledge(db), expected.knowledge);
    assert.equal(db.prepare('SELECT count(*) AS n FROM knowledge').get().n, expected.stats.knowledge);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  });
}

function assertBackupMatchesV1(root, expected) {
  const file = backupFile(root);
  assert.equal(fs.existsSync(file), true, 'the default schema 1 backup exists');
  const stat = fs.lstatSync(file);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.mode & 0o777, 0o600, 'the backup keeps private file permissions');
  const snapshot = rawFile(file, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.deepEqual(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name),
      ['clock', 'events', 'knowledge'],
    );
    return {
      events: readEvents(db).map(row => [row.id, row.digest]),
      knowledge: readKnowledge(db),
      integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
    };
  });
  assert.equal(snapshot.integrity, 'ok');
  assert.deepEqual(snapshot.events, expected.events.map(row => [row.id, row.digest]));
  assert.deepEqual(snapshot.knowledge, expected.knowledge);
}

// ---------------------------------------------------------------------------
// equivalence of the converted ledger and canonical knowledge
// ---------------------------------------------------------------------------

test('migration: every event identity, knowledge row and reader is unchanged', () => {
  const root = scratch();
  const rich = seedRichV1(root);
  assert.equal(rich.snapshot.stats.events, 48 + 5 + 4);
  assert.ok(rich.snapshot.stats.knowledge > 0);
  const clockBefore = raw(root, db => db.prepare('SELECT value FROM clock').get().value);
  const maxRevisionBefore = Math.max(...rich.snapshot.knowledge.map(row => Number(row.revision)));

  const report = migrateSharedExperience(root);
  assert.equal(report.migrated, true);
  assert.equal(report.fromVersion, 1);
  assert.equal(report.toVersion, 2);
  assert.equal(report.events.before, rich.snapshot.events.length);
  assert.equal(report.events.after, rich.snapshot.events.length);
  assert.equal(report.events.digest.length, 64);
  assert.equal(report.knowledge.before, rich.snapshot.knowledge.length);
  assert.equal(report.knowledge.after, rich.snapshot.knowledge.length);
  assert.equal(report.knowledge.digest.length, 64);
  assert.equal(report.backup.verified, true);
  assert.equal(report.backup.path, backupFile(root));
  assert.equal(report.durationMs >= 0, true);

  // Reclamation: WAL truncated, free pages recovered, both the events btree and
  // the main database smaller than the TEXT layout after VACUUM.
  assert.equal(report.reclaimed.vacuumed, true);
  assert.equal(report.reclaimed.checkpointBusy, false);
  assert.equal(report.bytes.after.walBytes, 0);
  assert.equal(report.bytes.after.freelistCount, 0);
  if (report.bytes.before.eventsBytes !== null && report.bytes.after.eventsBytes !== null) {
    assert.ok(report.bytes.after.eventsBytes < report.bytes.before.eventsBytes, 'the v2 events btree is smaller than the TEXT table + index');
  }
  assert.ok(report.bytes.after.mainBytes < report.bytes.before.mainBytes, 'the migrated main database is smaller');
  if (report.bytes.before.knowledgeBytes !== null && report.bytes.after.knowledgeBytes !== null) {
    assert.ok(report.bytes.after.knowledgeBytes <= report.bytes.before.knowledgeBytes, 'knowledge storage does not grow');
  }

  assertV2MatchesV1(root, rich.snapshot);
  assertBackupMatchesV1(root, rich.snapshot);
  assert.equal(raw(root, db => db.prepare('SELECT value FROM clock').get().value), clockBefore, 'the knowledge revision clock is not reset by the conversion');
  // The converted table has the same 32-byte CHECK as a fresh store.
  raw(root, db => {
    assert.throws(() => db.prepare('INSERT INTO events VALUES (?,?)').run(Buffer.alloc(64, 0x61), Buffer.alloc(32, 0x62)));
    assert.throws(() => db.prepare('INSERT INTO events VALUES (?,?)').run(Buffer.alloc(32, 0x61), Buffer.alloc(63, 0x62)));
    assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, rich.snapshot.stats.events);
  });
  assert.deepEqual(fs.readdirSync(root).sort(), ['experience.sqlite', 'experience.sqlite.v1-backup'], 'no staging table or temp file is left behind');

  // Readers are byte-for-byte stable across the conversion.
  const after = readView(root);
  assert.equal(after.schemaVersion, 2);
  assert.deepEqual(after.stats, rich.view.stats);
  assert.deepEqual(after.recallTarget, rich.view.recallTarget);
  assert.deepEqual(after.recallProblem, rich.view.recallProblem);
  assert.deepEqual(after.recallEmpty, rich.view.recallEmpty);
  assert.deepEqual(after.conclusions, rich.view.conclusions);
  assert.deepEqual(after.conclusionsVersioned, rich.view.conclusionsVersioned);
  assert.deepEqual(after.discover, rich.view.discover);

  // Permanent dedupe and conflict semantics survive the layout change.
  const store = openSharedExperience(root);
  try {
    assert.equal(store.schemaVersion, 2);
    assert.equal(store.recordFailure(rich.failures[0]).duplicate, true, 'a pre-migration fact replays as a duplicate');
    const conclusionReplay = store.recordConclusion({
      experimentId: 'exp-adopted', decision: 'adopted', strategyFingerprint: '1111222233334444',
      occurredAt: '2025-02-01T00:00:00.000Z', target: 'plugin edge-cache', strategy: 'warm cache',
      rootCause: 'cold cache', failureMode: 'cache-miss',
      applicability: { dsh: '0.2.4', cordis: '4.0.1', evolution: '0.2.4' }, metrics: { p95: 120.5, errorRate: 0.01 },
    }, 'desktop', { writer: 'host-a', sequence: 100 });
    assert.equal(conclusionReplay.duplicate, true);
    assert.throws(() => store.recordFailure({ ...rich.failures[0], code: 'E_AFTER_MIGRATION_CONFLICT' }), /E_EXPERIENCE_EVENT_CONFLICT/);
    assert.deepEqual(store.stats(), rich.view.stats, 'duplicates and conflicts add no rows after conversion');
    // Revision ordering keeps growing after the conversion: a new fact that
    // merges into an existing canonical row gets a revision above every
    // pre-migration revision (the `clock` table is carried over, not reset).
    assert.equal(store.recordFailure({
      id: sha256('post-migration-new-fact'), type: 'tool/error', code: 'E_RICH_1', target: 'terminal',
    }).duplicate, false);
    const revisions = raw(root, db => readKnowledge(db).map(row => Number(row.revision)));
    assert.ok(Math.max(...revisions) > maxRevisionBefore, 'post-migration revisions continue above the old ones');
  } finally { store.close(); }
  const knowledgeAfterExtraFact = raw(root, db => readKnowledge(db));
  assert.equal(knowledgeAfterExtraFact.length, rich.snapshot.knowledge.length);
  raw(root, db => assert.deepEqual(readKnowledge(db), knowledgeAfterExtraFact));

  // The one-time backup is a complete, recoverable schema 1 snapshot.
  const restoreRoot = scratch();
  fs.copyFileSync(backupFile(root), dbFile(restoreRoot));
  fs.chmodSync(dbFile(restoreRoot), 0o600);
  const restored = openSharedExperience(restoreRoot);
  try {
    assert.equal(restored.schemaVersion, 1);
    assert.deepEqual(restored.stats(), rich.view.stats);
    restored.recordFailure({ id: sha256('recovered-after-backup'), type: 'tool/error', code: 'E_RESTORED', target: 'editor' });
  } finally { restored.close(); }
  const restoredReport = migrateSharedExperience(restoreRoot);
  assert.equal(restoredReport.migrated, true);
  assert.equal(restoredReport.events.before, rich.snapshot.events.length + 1);

  // The frozen v0.2.4 opener refuses the converted database.
  assert.throws(() => openSharedExperienceV1Baseline(root), /E_EXPERIENCE_SCHEMA/);
});

test('migration: a second run is a logical no-op and reclamation-free reruns are byte-stable', () => {
  const root = scratch();
  const seeded = seedSimple(root, 200);
  assert.equal(migrateSharedExperience(root).migrated, true);
  const file = dbFile(root);
  const firstHash = fileHash(file);
  const backupBefore = fileHash(backupFile(root));
  const backupStatBefore = fs.statSync(backupFile(root));

  // Second run reports the already-migrated store and never replaces the backup.
  const sizeAfterFirst = fs.statSync(file).size;
  const second = migrateSharedExperience(root);
  assert.equal(second.migrated, false);
  assert.equal(second.alreadyMigrated, true);
  assert.equal(second.schemaVersion, 2);
  assert.equal(second.events, seeded.stats.events);
  assert.equal(second.knowledge, seeded.stats.knowledge);
  assert.equal(fileHash(backupFile(root)), backupBefore, 'the existing backup is not rewritten');
  assert.equal(fs.statSync(backupFile(root)).mtimeMs, backupStatBefore.mtimeMs);
  assert.deepEqual(fs.readdirSync(root).sort(), ['experience.sqlite', 'experience.sqlite.v1-backup']);
  assertV2MatchesV1(root, seeded);

  // The default already-migrated path only reclaims pending WAL frames or free
  // pages. With WAL=0 and freelist=0 it must not rewrite the database at all.
  const secondHash = fileHash(file);
  assert.equal(second.reclaimed.vacuumed, false, 'no free pages means no needless VACUUM');
  assert.equal(secondHash, firstHash, 'a default second run leaves the main database byte-identical');
  assert.equal(fs.statSync(file).size, sizeAfterFirst);
  const stable = migrateSharedExperience(root, { vacuum: false, backup: false });
  assert.equal(stable.migrated, false);
  assert.equal(stable.alreadyMigrated, true);
  assert.equal(fileHash(file), secondHash, 'a reclamation-free rerun leaves the main database byte-identical');
  assertV2MatchesV1(root, seeded);
});

test('migration report: a freshly written backup is not reported as reused', () => {
  // The report distinguishes a copy written by this run (`reused: false`) from
  // an existing, verified backup that was adopted (`reused: true`). The first
  // conversion in a clean store writes a new backup, so it must report false;
  // the CLI prints "(reused)" from this field.
  const root = scratch();
  seedSimple(root, 40);
  const report = migrateSharedExperience(root);
  assert.equal(report.migrated, true);
  assert.equal(report.backup.verified, true);
  assert.equal(report.backup.reused, false, 'a backup written by this run is not a reused backup');

  // The human CLI derives "(reused)" from the same field; a first conversion
  // must not claim it reused a backup.
  const cliRoot = scratch();
  seedSimple(cliRoot, 30);
  const human = runCli(['--root', cliRoot]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /schema 1 backup:/);
  assert.doesNotMatch(human.stdout, /\(reused\)/);
});

test('migration: --no-backup, --no-vacuum and a custom backup path still convert correctly', () => {
  // No backup requested.
  const noBackupRoot = scratch();
  const noBackupSeed = seedSimple(noBackupRoot, 150);
  const noBackup = migrateSharedExperience(noBackupRoot, { backup: false });
  assert.equal(noBackup.migrated, true);
  assert.equal(noBackup.backup, null);
  assert.deepEqual(fs.readdirSync(noBackupRoot).sort(), ['experience.sqlite']);
  assertV2MatchesV1(noBackupRoot, noBackupSeed);

  // No VACUUM requested: the conversion commits but free pages are not rebuilt.
  const noVacuumRoot = scratch();
  const noVacuumSeed = seedSimple(noVacuumRoot, 150);
  const noVacuum = migrateSharedExperience(noVacuumRoot, { vacuum: false });
  assert.equal(noVacuum.migrated, true);
  assert.equal(noVacuum.reclaimed.vacuumed, false);
  assert.equal(noVacuum.bytes.after.walBytes, 0);
  if (noVacuum.bytes.before.eventsBytes !== null && noVacuum.bytes.after.eventsBytes !== null) {
    assert.ok(noVacuum.bytes.after.eventsBytes < noVacuum.bytes.before.eventsBytes, 'the converted ledger is still smaller');
  }
  assertV2MatchesV1(noVacuumRoot, noVacuumSeed);
  assertBackupMatchesV1(noVacuumRoot, noVacuumSeed);

  // Explicit backup path, outside the store directory.
  const customRoot = scratch();
  const customSeed = seedSimple(customRoot, 120);
  const customBackup = path.join(scratch(), 'custom-v1.sqlite');
  const custom = migrateSharedExperience(customRoot, { backup: customBackup });
  assert.equal(custom.migrated, true);
  assert.equal(custom.backup.path, customBackup);
  assert.equal(fs.existsSync(customBackup), true);
  assert.equal(fs.lstatSync(customBackup).mode & 0o777, 0o600);
  const customSnapshot = rawFile(customBackup, db => ({
    version: db.prepare('PRAGMA user_version').get().user_version,
    events: readEvents(db).map(row => [row.id, row.digest]),
    knowledge: readKnowledge(db),
  }));
  assert.equal(customSnapshot.version, 1);
  assert.deepEqual(customSnapshot.events, customSeed.events.map(row => [row.id, row.digest]));
  assert.deepEqual(customSnapshot.knowledge, customSeed.knowledge);
  assertV2MatchesV1(customRoot, customSeed);
});

// ---------------------------------------------------------------------------
// failure injection: the schema 1 database must stay untouched
// ---------------------------------------------------------------------------

test('migration failure: a malformed ledger row rolls back to an untouched schema 1', () => {
  const root = scratch();
  const seeded = seedSimple(root, 120);
  raw(root, db => db.exec("INSERT INTO events VALUES ('not-a-sha256-identity', 'also-not-hex')"));
  const injected = v1Snapshot(root);
  assert.equal(injected.stats.events, seeded.stats.events + 1);

  let failure;
  try { migrateSharedExperience(root); } catch (error) { failure = error; }
  assert.ok(failure, 'the migration refuses a malformed ledger');
  assert.equal(failure.code, 'E_EXPERIENCE_MIGRATION_DATA');
  assert.match(String(failure.message), /E_EXPERIENCE_MIGRATION_DATA/);
  assert.ok(failure.migrationPhase, 'the refusal names the failed phase');

  const after = v1Snapshot(root);
  assert.equal(after.version, 1);
  assert.deepEqual(after.tables, ['clock', 'events', 'knowledge'], 'no half-built events_next table survives');
  assert.deepEqual(after.events, injected.events, 'the malformed ledger is preserved exactly, not repaired or dropped');
  assert.deepEqual(after.knowledge, injected.knowledge);
  assert.equal(fs.existsSync(backupFile(root)), false, 'the malformed source is rejected before a backup is written');
  assert.deepEqual(fs.readdirSync(root).sort(), ['experience.sqlite']);

  // An operator can remove the offending row and rerun to completion.
  raw(root, db => db.exec("DELETE FROM events WHERE id='not-a-sha256-identity'"));
  const recovered = migrateSharedExperience(root);
  assert.equal(recovered.migrated, true);
  assertV2MatchesV1(root, seeded);

  // A row whose id is a valid identity but whose digest is not 64 lowercase hex
  // is rejected the same way (the digest is part of the permanent identity).
  const digestRoot = scratch();
  const digestSeed = seedSimple(digestRoot, 60);
  raw(digestRoot, db => db.exec(`INSERT INTO events VALUES ('${'d'.repeat(64)}', 'not-a-hex-digest')`));
  const injectedDigest = v1Snapshot(digestRoot);
  let digestFailure;
  try { migrateSharedExperience(digestRoot); } catch (error) { digestFailure = error; }
  assert.ok(digestFailure);
  assert.equal(digestFailure.code, 'E_EXPERIENCE_MIGRATION_DATA');
  const digestAfter = v1Snapshot(digestRoot);
  assert.equal(digestAfter.version, 1);
  assert.deepEqual(digestAfter.events, injectedDigest.events);
  assert.deepEqual(digestAfter.knowledge, digestSeed.knowledge);
  assert.deepEqual(digestAfter.tables, ['clock', 'events', 'knowledge']);
});

test('migration failure: backup conflicts, directories, symlinks and the live file are refused', () => {
  const fresh = () => {
    const root = scratch();
    const seeded = seedSimple(root, 60);
    return { root, seeded };
  };
  const expectIntact = (root, seeded, code = 'E_EXPERIENCE_MIGRATION_BACKUP') => {
    const snapshot = v1Snapshot(root);
    assert.equal(snapshot.version, 1);
    assert.deepEqual(snapshot.events, seeded.events);
    assert.deepEqual(snapshot.knowledge, seeded.knowledge);
    return snapshot;
  };

  // An existing backup that describes a different ledger is refused, not replaced.
  {
    const { root, seeded } = fresh();
    const otherRoot = scratch();
    seedSimple(otherRoot, 7);
    fs.copyFileSync(dbFile(otherRoot), backupFile(root));
    const backupHash = fileHash(backupFile(root));
    assert.throws(() => migrateSharedExperience(root), /E_EXPERIENCE_MIGRATION_BACKUP/);
    expectIntact(root, seeded);
    assert.equal(fileHash(backupFile(root)), backupHash, 'a mismatched backup is never overwritten');
  }

  // A matching schema 1 backup is verified and reused without a rewrite.
  {
    const { root, seeded } = fresh();
    fs.copyFileSync(dbFile(root), backupFile(root));
    fs.chmodSync(backupFile(root), 0o600);
    const backupHash = fileHash(backupFile(root));
    const report = migrateSharedExperience(root);
    assert.equal(report.migrated, true);
    assert.equal(report.backup.reused, true);
    assert.equal(report.backup.verified, true);
    assert.equal(fileHash(backupFile(root)), backupHash);
    assertV2MatchesV1(root, seeded);
  }

  // A directory at the backup path.
  {
    const { root, seeded } = fresh();
    fs.mkdirSync(backupFile(root));
    assert.throws(() => migrateSharedExperience(root), /E_EXPERIENCE_MIGRATION_BACKUP/);
    expectIntact(root, seeded);
    assert.equal(fs.lstatSync(backupFile(root)).isDirectory(), true);
  }

  // A symlink at the backup path.
  {
    const { root, seeded } = fresh();
    const target = path.join(scratch(), 'link-target.sqlite');
    fs.writeFileSync(target, '');
    fs.symlinkSync(target, backupFile(root));
    assert.throws(() => migrateSharedExperience(root), /E_EXPERIENCE_MIGRATION_BACKUP/);
    expectIntact(root, seeded);
    assert.equal(fs.lstatSync(backupFile(root)).isSymbolicLink(), true);
  }

  // The backup path may not be the live database itself.
  {
    const { root, seeded } = fresh();
    assert.throws(() => migrateSharedExperience(root, { backup: dbFile(root) }), /E_EXPERIENCE_MIGRATION_BACKUP/);
    expectIntact(root, seeded);
    assert.equal(fs.existsSync(`${dbFile(root)}.v1-backup`), false);
  }

  // A missing backup directory fails before the transaction; the source is intact.
  {
    const { root, seeded } = fresh();
    assert.throws(() => migrateSharedExperience(root, { backup: path.join(root, 'absent', 'backup.sqlite') }), /ENOENT/);
    expectIntact(root, seeded);
  }
});

test('migration failure: a live writer blocks the conversion and the source stays schema 1', () => {
  const root = scratch();
  const seeded = seedSimple(root, 120);
  const locker = new DatabaseSync(dbFile(root));
  try {
    locker.exec('PRAGMA busy_timeout=20; BEGIN EXCLUSIVE');
    let failure;
    try { migrateSharedExperience(root, { busyTimeoutMs: 50 }); } catch (error) { failure = error; }
    assert.ok(failure);
    assert.equal(failure.code, 'E_EXPERIENCE_MIGRATION_BUSY');
    assert.match(String(failure.message), /E_EXPERIENCE_MIGRATION_BUSY/);
    assert.ok(failure.migrationPhase);
    const snapshot = v1Snapshot(root);
    assert.deepEqual(snapshot.events, seeded.events);
    assert.deepEqual(snapshot.knowledge, seeded.knowledge);
    assert.equal(fs.existsSync(backupFile(root)), false);
  } finally {
    try { locker.exec('ROLLBACK'); } finally { locker.close(); }
  }
  const report = migrateSharedExperience(root);
  assert.equal(report.migrated, true);
  assertV2MatchesV1(root, seeded);
});

test('migration failure: non-private roots and files are refused', () => {
  const privateRoot = scratch();
  const seeded = seedSimple(privateRoot, 20);

  const foreignRoot = scratch();
  fs.copyFileSync(dbFile(privateRoot), dbFile(foreignRoot));
  fs.chmodSync(dbFile(foreignRoot), 0o600);
  fs.chmodSync(foreignRoot, 0o755);
  try {
    assert.throws(() => migrateSharedExperience(foreignRoot), /E_EXPERIENCE_PRIVATE_ROOT/);
  } finally { fs.chmodSync(foreignRoot, 0o700); }

  const privateFileRoot = scratch();
  fs.copyFileSync(dbFile(privateRoot), dbFile(privateFileRoot));
  fs.chmodSync(dbFile(privateFileRoot), 0o644);
  try {
    assert.throws(() => migrateSharedExperience(privateFileRoot), /E_EXPERIENCE_PRIVATE_FILE/);
  } finally { fs.chmodSync(dbFile(privateFileRoot), 0o600); }

  // The untouched source still converts once its permissions are restored.
  const report = migrateSharedExperience(privateRoot);
  assert.equal(report.migrated, true);
  assertV2MatchesV1(privateRoot, seeded);
});

// ---------------------------------------------------------------------------
// old openers across the conversion
// ---------------------------------------------------------------------------

test('migration: an already-open v1 connection cannot write TEXT into the converted ledger', () => {
  // The frozen v0.2.4 process opened the store before the conversion.
  const root = scratch();
  const seeded = seedSimple(root, 80);
  const oldOpener = openSharedExperienceV1Baseline(root);
  try {
    oldOpener.recordFailure({ id: sha256('old-opener-prewrite'), type: 'tool/error', code: 'E_OLD', target: 'editor' });
    assert.equal(oldOpener.stats().events, seeded.stats.events + 1);

    const report = migrateSharedExperience(root);
    assert.equal(report.migrated, true);
    const countAfterMigration = raw(root, db => db.prepare('SELECT count(*) AS n FROM events').get().n);
    assert.equal(countAfterMigration, seeded.stats.events + 1);

    // The old connection still holds the TEXT binding; STRICT must reject it and
    // no partial row may appear.
    assert.throws(() => oldOpener.recordFailure({ id: sha256('old-opener-postwrite'), type: 'tool/error', code: 'E_OLD', target: 'editor' }));
    const countAfterFailedWrite = raw(root, db => db.prepare('SELECT count(*) AS n FROM events').get().n);
    assert.equal(countAfterFailedWrite, countAfterMigration, 'the failed TEXT write inserted no row');
    raw(root, db => {
      const rows = readEvents(db);
      assert.ok(rows.every(row => row.idType === 'blob' && Number(row.idBytes) === 32), 'no TEXT identity was mixed into the v2 ledger');
      assert.equal(rows.find(row => row.id === sha256('old-opener-postwrite')), undefined);
    });
  } finally { oldOpener.close(); }

  // A v1 opener that starts after the conversion is refused outright.
  assert.throws(() => openSharedExperienceV1Baseline(root), /E_EXPERIENCE_SCHEMA/);

  // The fact the old process failed to write is still writable by a v2 process.
  const v2 = openSharedExperience(root);
  try {
    assert.equal(v2.schemaVersion, 2);
    assert.equal(v2.recordFailure({ id: sha256('old-opener-postwrite'), type: 'tool/error', code: 'E_OLD', target: 'editor' }).duplicate, false);
  } finally { v2.close(); }

  // The schema-1 compatibility connection of the *new* code behaves the same
  // way: it also cannot write TEXT after the conversion.
  const compatRoot = scratch();
  const compatSeed = seedSimple(compatRoot, 40);
  const compat = openSharedExperience(compatRoot);
  try {
    assert.equal(compat.schemaVersion, 1);
    assert.equal(migrateSharedExperience(compatRoot).migrated, true);
    const count = raw(compatRoot, db => db.prepare('SELECT count(*) AS n FROM events').get().n);
    assert.throws(() => compat.recordFailure({ id: sha256('compat-postwrite'), type: 'tool/error', code: 'E_COMPAT', target: 'editor' }));
    assert.equal(raw(compatRoot, db => db.prepare('SELECT count(*) AS n FROM events').get().n), count);
  } finally { compat.close(); }
  assertV2MatchesV1(compatRoot, compatSeed);
});

// ---------------------------------------------------------------------------
// crash recovery: SIGKILL during the conversion
// ---------------------------------------------------------------------------

function spawnToReadyThenKill(root) {
  return new Promise(resolve => {
    const childScript = `
import { migrateSharedExperience } from ${JSON.stringify(MIGRATION_MODULE_URL)};
process.stdout.write('READY\\n');
setTimeout(() => {
  try {
    const report = migrateSharedExperience(process.argv[1]);
    process.stdout.write(JSON.stringify({ ok: true, migrated: report.migrated }) + '\\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(error && error.message) }) + '\\n');
  }
}, 5);
`;
    const child = spawn(process.execPath, ['--max-old-space-size=4096', '--input-type=module', '-e', childScript, root], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    let exit = null;
    const exited = new Promise(done => child.on('exit', (code, signal) => { exit = { code, signal }; done(exit); }));

    (async () => {
      const deadline = Date.now() + 15000;
      // The backup/temp file appears only after the exclusive transaction has
      // started; killing there guarantees a mid-transaction crash window.
      while (!exit && Date.now() < deadline) {
        let names = [];
        try { names = fs.readdirSync(root); } catch { /* directory still there */ }
        if (names.some(name => name.startsWith('experience.sqlite.v1-backup'))) break;
        await new Promise(done => setTimeout(done, 1));
      }
      if (!exit) child.kill('SIGKILL');
      const final = await exited;
      resolve({ root, ...final, killed: final.signal === 'SIGKILL', stdout, stderr });
    })();
  });
}

test('migration crash: SIGKILL leaves complete v1 or complete v2 and the rerun finishes', async () => {
  const baseRoot = scratch();
  const baseline = (() => {
    const store = openSharedExperienceV1Baseline(baseRoot);
    try {
      for (let index = 0; index < 4000; index += 1) {
        store.recordFailure({ id: index.toString(16).padStart(64, '0'), type: index % 4 === 0 ? 'agent/error' : 'tool/error', code: `E_CRASH_${index % 4}`, target: ['editor', 'terminal', 'component:cache'][index % 3] });
      }
    } finally { store.close(); }
    return v1Snapshot(baseRoot);
  })();
  const baseFile = dbFile(baseRoot);

  let killedCount = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const root = scratch();
    fs.copyFileSync(baseFile, dbFile(root));
    fs.chmodSync(dbFile(root), 0o600);

    const result = await spawnToReadyThenKill(root);
    if (result.killed) killedCount += 1;

    // Recover whatever the killed process left: one complete committed state.
    const state = raw(root, db => ({
      version: db.prepare('PRAGMA user_version').get().user_version,
      tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name),
      events: readEvents(db),
      knowledge: readKnowledge(db),
    }));
    assert.deepEqual(state.tables, ['clock', 'events', 'knowledge'], 'a crash never leaves a half-built table behind');
    assert.ok(state.version === 1 || state.version === 2, `unexpected schema version ${state.version} after crash`);
    if (state.version === 1) {
      assert.deepEqual(state.events.map(row => [row.id, row.digest]), baseline.events.map(row => [row.id, row.digest]), 'a rolled-back crash keeps the complete v1 ledger');
      assert.deepEqual(state.knowledge, baseline.knowledge);
      const report = migrateSharedExperience(root);
      assert.equal(report.migrated, true, 'the interrupted conversion is completable');
    } else {
      assert.deepEqual(state.events.map(row => [row.id, row.digest]), baseline.events.map(row => [row.id, row.digest]), 'a committed crash keeps the complete v2 ledger');
      assert.deepEqual(state.knowledge, baseline.knowledge);
      const report = migrateSharedExperience(root);
      assert.equal(report.migrated, false);
      assert.equal(report.alreadyMigrated, true);
    }
    assertV2MatchesV1(root, baseline);
    assertBackupMatchesV1(root, baseline);
    assert.deepEqual(
      fs.readdirSync(root).sort(),
      ['experience.sqlite', 'experience.sqlite.v1-backup'],
      'the rerun reclaims the interrupted backup temp files',
    );
  }
  assert.ok(killedCount >= 1, 'at least one conversion really was killed mid-run');
});

// ---------------------------------------------------------------------------
// CLI reports and read-only dry run
// ---------------------------------------------------------------------------

function runCli(args) {
  return spawnSync(process.execPath, ['--max-old-space-size=4096', MIGRATION_CLI, ...args], { encoding: 'utf8' });
}

function jsonStdout(process_) {
  return JSON.parse(process_.stdout);
}

test('migration CLI: dry-run is read-only, conversion is reported and idempotent', () => {
  const root = scratch();
  const seeded = seedSimple(root, 90);
  const before = fileSnapshot(root);

  const dryRun = runCli(['--root', root, '--dry-run', '--json']);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const dryReport = jsonStdout(dryRun);
  assert.equal(dryReport.root, root);
  assert.equal(dryReport.pending, true);
  assert.equal(dryReport.migrated, false);
  assert.equal(dryReport.schemaVersion, 1);
  assert.equal(dryReport.events, seeded.stats.events);
  assert.equal(dryReport.knowledge, seeded.stats.knowledge);
  assert.deepEqual(fileSnapshot(root), before, 'the CLI dry run changed no byte and wrote no backup');

  const convert = runCli(['--root', root, '--json']);
  assert.equal(convert.status, 0, convert.stderr);
  const report = jsonStdout(convert);
  assert.equal(report.migrated, true);
  assert.equal(report.fromVersion, 1);
  assert.equal(report.toVersion, 2);
  assert.equal(report.backup.verified, true);
  assert.equal(report.events.before, seeded.stats.events);
  assertV2MatchesV1(root, seeded);

  const again = runCli(['--root', root, '--json']);
  assert.equal(again.status, 0, again.stderr);
  const againReport = jsonStdout(again);
  assert.equal(againReport.migrated, false);
  assert.equal(againReport.alreadyMigrated, true);

  const dryAfter = runCli(['--root', root, '--dry-run', '--json']);
  assert.equal(dryAfter.status, 0);
  assert.equal(jsonStdout(dryAfter).pending, false);
  assert.equal(jsonStdout(dryAfter).migrated, true);

  // Human-readable output still works.
  const human = runCli(['--root', root, '--dry-run']);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /dry run/);
  assert.match(human.stdout, /migration pending: false/);

  const help = runCli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  const badArg = runCli(['--root', root, '--bogus']);
  assert.equal(badArg.status, 1);
  assert.match(badArg.stderr, /unknown argument: --bogus/);
});

test('migration CLI: --no-backup, --no-vacuum and refusal exit codes', () => {
  const noBackupRoot = scratch();
  const noBackupSeed = seedSimple(noBackupRoot, 60);
  const noBackup = runCli(['--root', noBackupRoot, '--no-backup', '--json']);
  assert.equal(noBackup.status, 0, noBackup.stderr);
  assert.equal(jsonStdout(noBackup).migrated, true);
  assert.equal(jsonStdout(noBackup).backup, null);
  assert.equal(fs.existsSync(backupFile(noBackupRoot)), false);
  assertV2MatchesV1(noBackupRoot, noBackupSeed);

  const noVacuumRoot = scratch();
  seedSimple(noVacuumRoot, 60);
  const noVacuum = runCli(['--root', noVacuumRoot, '--no-vacuum', '--json']);
  assert.equal(noVacuum.status, 0, noVacuum.stderr);
  assert.equal(jsonStdout(noVacuum).migrated, true);
  assert.equal(jsonStdout(noVacuum).reclaimed.vacuumed, false);

  const customRoot = scratch();
  const customSeed = seedSimple(customRoot, 60);
  const customBackup = path.join(scratch(), 'cli-custom-backup.sqlite');
  const custom = runCli(['--root', customRoot, '--backup', customBackup, '--json']);
  assert.equal(custom.status, 0, custom.stderr);
  assert.equal(jsonStdout(custom).migrated, true);
  assert.equal(jsonStdout(custom).backup.path, customBackup);
  assert.equal(fs.existsSync(customBackup), true);
  assert.equal(rawFile(customBackup, db => db.prepare('PRAGMA user_version').get().user_version), 1);
  assertV2MatchesV1(customRoot, customSeed);

  // Unknown schema version: refusal exit code 1 with a coded JSON error.
  const unknownRoot = scratch();
  fs.writeFileSync(dbFile(unknownRoot), '');
  fs.chmodSync(dbFile(unknownRoot), 0o600);
  const unknownDb = new DatabaseSync(dbFile(unknownRoot));
  try {
    unknownDb.exec('CREATE TABLE clock (value INTEGER NOT NULL); CREATE TABLE events (id TEXT PRIMARY KEY, digest TEXT NOT NULL); CREATE TABLE knowledge (key TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL); PRAGMA user_version=3;');
  } finally { unknownDb.close(); }
  const unknown = runCli(['--root', unknownRoot, '--json']);
  assert.equal(unknown.status, 1);
  assert.match(jsonStdout(unknown).error, /E_EXPERIENCE_SCHEMA/);
  assert.equal(raw(unknownRoot, db => db.prepare('PRAGMA user_version').get().user_version), 3);

  // Malformed ledger: refusal exit code 1, source intact.
  const malformedRoot = scratch();
  const malformedSeed = seedSimple(malformedRoot, 40);
  raw(malformedRoot, db => db.exec("INSERT INTO events VALUES ('broken', 'broken')"));
  const malformedInjected = v1Snapshot(malformedRoot);
  const malformed = runCli(['--root', malformedRoot, '--json']);
  assert.equal(malformed.status, 1);
  assert.match(jsonStdout(malformed).error, /E_EXPERIENCE_MIGRATION_DATA/);
  assert.ok(jsonStdout(malformed).migrationPhase);
  const malformedAfter = v1Snapshot(malformedRoot);
  assert.equal(malformedAfter.version, 1);
  assert.deepEqual(malformedAfter.events, malformedInjected.events);
  assert.deepEqual(malformedAfter.knowledge, malformedSeed.knowledge);
  assert.equal(fs.existsSync(backupFile(malformedRoot)), false);

  // Busy store refusal exit code 1.
  const busyRoot = scratch();
  seedSimple(busyRoot, 40);
  const locker = new DatabaseSync(dbFile(busyRoot));
  try {
    locker.exec('PRAGMA busy_timeout=20; BEGIN EXCLUSIVE');
    const busy = runCli(['--root', busyRoot]);
    assert.equal(busy.status, 1);
    assert.match(busy.stderr, /E_EXPERIENCE_MIGRATION_BUSY/);
  } finally {
    try { locker.exec('ROLLBACK'); } finally { locker.close(); }
  }
});
