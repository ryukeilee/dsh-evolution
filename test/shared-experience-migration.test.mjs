import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import {
  EXPERIENCE_LEGACY_SCHEMA_VERSION,
  EXPERIENCE_SCHEMA_VERSION,
  experienceEventId,
  openSharedExperience,
} from '../lib/shared-experience.js';
import { inspectSharedExperience, migrateSharedExperience } from '../lib/shared-experience-migration.js';
import { openSharedExperienceV1Baseline } from './fixtures/shared-experience-v1.js';

const migrationModuleUrl = new URL('../lib/shared-experience-migration.js', import.meta.url).href;

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-experience-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const databaseFile = root => path.join(root, 'experience.sqlite');
const backupFile = root => `${databaseFile(root)}.v1-backup`;

function failure(n, code = 'ENOENT', target = 'tool:read_file') {
  return { id: experienceEventId('migration', n), type: 'tool/error', code, target };
}

function readOnly(file) {
  return new DatabaseSync(file, { readOnly: true });
}

function rawLedger(file) {
  const db = readOnly(file);
  try {
    return {
      version: db.prepare('PRAGMA user_version').get().user_version,
      events: db.prepare('SELECT id, digest FROM events ORDER BY id').all().map(row => ({ id: row.id, digest: row.digest })),
      knowledge: db.prepare('SELECT key, body, revision FROM knowledge ORDER BY key').all()
        .map(row => ({ key: row.key, body: row.body, revision: row.revision })),
      tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name),
    };
  } finally { db.close(); }
}

function hexLedger(file) {
  const db = readOnly(file);
  try {
    return db.prepare('SELECT hex(id) AS id, hex(digest) AS digest FROM events ORDER BY id').all()
      .map(row => ({ id: row.id.toLowerCase(), digest: row.digest.toLowerCase() }));
  } finally { db.close(); }
}

function inspectDatabase(file) {
  const db = readOnly(file);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
    return {
      integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
      version: db.prepare('PRAGMA user_version').get().user_version,
      tables,
      eventsSql: db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='events'").get()?.sql || '',
      events: tables.includes('events') ? db.prepare('SELECT count(*) AS n FROM events').get().n : null,
      knowledge: tables.includes('knowledge') ? db.prepare('SELECT count(*) AS n FROM knowledge').get().n : null,
    };
  } finally { db.close(); }
}

function legacySnapshot(root) {
  buildLegacyStore(root);
  return rawLedger(databaseFile(root));
}

/** A populated schema 1 store that exercises every existing write family. */
function buildLegacyStore(root) {
  const seed = openSharedExperienceV1Baseline(root);
  seed.close();
  const store = openSharedExperience(root);
  assert.equal(store.schemaVersion, EXPERIENCE_LEGACY_SCHEMA_VERSION);
  for (let n = 0; n < 420; n += 1) {
    const target = n % 4 === 0 ? 'tool:read_file' : `tool:op-${n % 40}`;
    store.recordFailure({ id: experienceEventId('legacy', n), type: 'tool/error', code: n % 7 ? 'ENOENT' : 'EACCES', target });
  }
  for (let n = 0; n < 60; n += 1) {
    store.recordFailure({ id: experienceEventId('legacy', n), type: 'tool/error', code: n % 7 ? 'ENOENT' : 'EACCES', target: n % 4 === 0 ? 'tool:read_file' : `tool:op-${n % 40}` });
  }
  store.recordEvolution({ eventType: 'promotion-succeeded', target: 'tool:stable', eventId: 'evolution:promotion-succeeded:exp-1' },
    '/bridge/execution-events.jsonl', { writer: 'dsh-evolution-orchestrator', sequence: 1 });
  store.recordEvolution({ eventType: 'canary-failed', target: 'tool:stable', eventId: 'evolution:canary-failed:exp-1' },
    '/bridge/execution-events.jsonl', { writer: 'dsh-evolution-orchestrator', sequence: 2 });
  store.recordConclusion({
    experimentId: 'exp-conclusion', decision: 'no-benefit', strategyFingerprint: 'deadbeef',
    strategy: 'increase retries', target: 'tool:edge-cache', occurredAt: '2026-11-10T00:00:00.000Z',
    rootCause: 'stale cache', applicability: { dsh: '0.2.4', cordis: '4.1.0', evolution: '0.2.4' },
  }, 'desktop');
  store.close();
}

function captureCapabilities(root) {
  const store = openSharedExperience(root);
  try {
    return {
      stats: store.stats(),
      recall: store.recall({ problem: 'read_file' }),
      conclusions: store.findConclusions({
        target: 'tool:edge-cache',
        applicability: { dsh: '0.2.4', cordis: '4.1.0', evolution: '0.2.4' },
        strategyFingerprint: 'deadbeef',
      }),
      evolution: store.recall({ target: 'tool:stable' }),
    };
  } finally { store.close(); }
}

test('conversion keeps every event identity and knowledge row; capabilities still answer', t => {
  const root = temporary(t);
  const before = legacySnapshot(root);
  const beforeCapabilities = captureCapabilities(root);
  const beforeBytes = fs.statSync(databaseFile(root)).size;
  assert.equal(before.version, EXPERIENCE_LEGACY_SCHEMA_VERSION);
  // 420 failure facts + 2 evolution facts + 1 conclusion; 60 replays add no rows.
  assert.equal(before.events.length, 423);

  const report = migrateSharedExperience(root);
  assert.equal(report.migrated, true);
  assert.equal(report.fromVersion, EXPERIENCE_LEGACY_SCHEMA_VERSION);
  assert.equal(report.toVersion, EXPERIENCE_SCHEMA_VERSION);
  assert.equal(report.events.before, before.events.length);
  assert.equal(report.events.after, before.events.length);
  assert.equal(report.knowledge.before, before.knowledge.length);
  assert.equal(report.knowledge.after, before.knowledge.length);
  assert.equal(report.reclaimed.vacuumed, true);
  assert.equal(report.bytes.after.freelistCount, 0);
  assert.equal(report.bytes.after.walBytes, 0, 'the report is measured after a unified checkpoint state');

  // The backup is a complete, private schema 1 snapshot of the converted ledger.
  assert.ok(report.backup?.verified);
  assert.equal(report.backup.path, backupFile(root));
  assert.equal(fs.statSync(backupFile(root)).mode & 0o077, 0, 'the backup is private');
  const backup = rawLedger(backupFile(root));
  assert.equal(backup.version, EXPERIENCE_LEGACY_SCHEMA_VERSION);
  assert.deepEqual(backup.events, before.events);
  assert.deepEqual(backup.knowledge, before.knowledge);
  assert.equal(fs.statSync(backupFile(root)).size, beforeBytes);

  const after = rawLedger(databaseFile(root));
  assert.equal(after.version, EXPERIENCE_SCHEMA_VERSION);
  assert.deepEqual(after.tables, ['clock', 'events', 'knowledge']);
  assert.deepEqual(hexLedger(databaseFile(root)), before.events);
  assert.deepEqual(after.knowledge, before.knowledge, 'knowledge rows are byte-identical after conversion');
  const wal = `${databaseFile(root)}-wal`;
  assert.ok(!fs.existsSync(wal) || fs.statSync(wal).size === 0, 'the WAL is checkpointed and truncated');
  const migratedBytes = fs.statSync(databaseFile(root)).size;
  assert.ok(migratedBytes < beforeBytes, `main database ${migratedBytes} should be smaller than ${beforeBytes}`);

  const store = openSharedExperience(root);
  t.after(() => store.close());
  assert.equal(store.schemaVersion, EXPERIENCE_SCHEMA_VERSION);
  assert.deepEqual(store.stats(), beforeCapabilities.stats);
  assert.deepEqual(store.recall({ problem: 'read_file' }), beforeCapabilities.recall);
  assert.deepEqual(store.recall({ target: 'tool:stable' }), beforeCapabilities.evolution);
  assert.deepEqual(store.findConclusions({
    target: 'tool:edge-cache',
    applicability: { dsh: '0.2.4', cordis: '4.1.0', evolution: '0.2.4' },
    strategyFingerprint: 'deadbeef',
  }), beforeCapabilities.conclusions);
  const replay = { id: experienceEventId('post-migration-replay'), type: 'tool/error', code: 'ENOENT', target: 'tool:read_file' };
  assert.equal(store.recordFailure(replay).duplicate, false);
  assert.equal(store.recordFailure(replay).duplicate, true);
  // Same id, different content is still a conflict after the layout change.
  assert.throws(() => store.recordFailure({ ...replay, code: 'EACCES' }), /E_EXPERIENCE_EVENT_CONFLICT/);
  assert.equal(store.stats().events, before.events.length + 1);
});

test('conversion is idempotent and a second run changes no bytes', t => {
  const root = temporary(t);
  buildLegacyStore(root);
  const first = migrateSharedExperience(root);
  assert.equal(first.migrated, true);
  const afterFirst = rawLedger(databaseFile(root));
  const bytesAfterFirst = [databaseFile(root), backupFile(root)].map(file => fs.statSync(file).size);
  const second = migrateSharedExperience(root);
  assert.equal(second.migrated, false);
  assert.equal(second.alreadyMigrated, true);
  assert.equal(second.schemaVersion, EXPERIENCE_SCHEMA_VERSION);
  assert.deepEqual(second.events, first.events.after);
  assert.deepEqual(rawLedger(databaseFile(root)), afterFirst);
  assert.deepEqual([databaseFile(root), backupFile(root)].map(file => fs.statSync(file).size), bytesAfterFirst);
  const third = migrateSharedExperience(root);
  assert.equal(third.alreadyMigrated, true);
  assert.deepEqual(rawLedger(databaseFile(root)), afterFirst);
});

test('a malformed legacy row aborts before any change and the store still recovers', t => {
  const root = temporary(t);
  buildLegacyStore(root);
  const db = new DatabaseSync(databaseFile(root));
  db.prepare('INSERT INTO events VALUES (?,?)').run('not-a-sha256', 'a'.repeat(64));
  db.close();
  const before = rawLedger(databaseFile(root));
  const beforeBytes = fs.statSync(databaseFile(root)).size;

  assert.throws(() => migrateSharedExperience(root), (error) => {
    assert.match(error.message, /E_EXPERIENCE_MIGRATION_DATA/);
    assert.equal(error.migrationPhase, 'lock');
    return true;
  });
  const afterFailure = rawLedger(databaseFile(root));
  assert.equal(afterFailure.version, EXPERIENCE_LEGACY_SCHEMA_VERSION);
  assert.match(dbSql(databaseFile(root)), /id TEXT PRIMARY KEY/i);
  assert.deepEqual(afterFailure.events, before.events);
  assert.deepEqual(afterFailure.knowledge, before.knowledge);
  assert.equal(fs.statSync(databaseFile(root)).size, beforeBytes);
  assert.equal(fs.existsSync(backupFile(root)), false, 'validation runs before the backup is written');
  assert.equal(fs.readdirSync(root).some(name => name.startsWith('events_next') || name.includes('.tmp-')), false);

  // Removing the unrepresentable row makes the same store convertible.
  const cleanup = new DatabaseSync(databaseFile(root));
  cleanup.prepare('DELETE FROM events WHERE id = ?').run('not-a-sha256');
  cleanup.close();
  const report = migrateSharedExperience(root);
  assert.equal(report.migrated, true);
  assert.equal(report.events.before, before.events.length - 1);
  assert.deepEqual(hexLedger(databaseFile(root)), before.events.filter(row => row.id !== 'not-a-sha256'));
  assert.deepEqual(rawLedger(databaseFile(root)).knowledge, before.knowledge);
});

function dbSql(file) {
  const db = readOnly(file);
  try { return db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='events'").get()?.sql || ''; }
  finally { db.close(); }
}

test('an existing backup that does not match the ledger is refused, not overwritten', t => {
  const root = temporary(t);
  buildLegacyStore(root);
  const staleRoot = path.join(os.tmpdir(), `evolution-experience-stale-${process.pid}-${Date.now()}`);
  fs.mkdirSync(staleRoot, { recursive: true, mode: 0o700 });
  try {
    const stale = openSharedExperienceV1Baseline(staleRoot);
    stale.recordFailure(failure(1));
    stale.close();
    fs.copyFileSync(databaseFile(staleRoot), backupFile(root));
    fs.chmodSync(backupFile(root), 0o600);
  } finally { fs.rmSync(staleRoot, { recursive: true, force: true }); }
  const backupBytes = fs.readFileSync(backupFile(root));
  const before = rawLedger(databaseFile(root));

  assert.throws(() => migrateSharedExperience(root), /E_EXPERIENCE_MIGRATION_BACKUP/);
  assert.equal(rawLedger(databaseFile(root)).version, EXPERIENCE_LEGACY_SCHEMA_VERSION);
  assert.deepEqual(rawLedger(databaseFile(root)).events, before.events);
  assert.deepEqual(fs.readFileSync(backupFile(root)), backupBytes, 'the refused backup file is left untouched');
});

test('conversion refuses a store another process is writing and leaves it untouched', t => {
  const root = temporary(t);
  buildLegacyStore(root);
  const before = rawLedger(databaseFile(root));
  const holder = new DatabaseSync(databaseFile(root));
  try {
    holder.exec('BEGIN IMMEDIATE');
    assert.throws(() => migrateSharedExperience(root, { busyTimeoutMs: 50 }), (error) => {
      assert.match(error.message, /E_EXPERIENCE_MIGRATION_BUSY/);
      return true;
    });
  } finally { holder.exec('ROLLBACK'); holder.close(); }
  const after = rawLedger(databaseFile(root));
  assert.equal(after.version, EXPERIENCE_LEGACY_SCHEMA_VERSION);
  assert.deepEqual(after.events, before.events);
  assert.equal(fs.existsSync(backupFile(root)), false);

  const report = migrateSharedExperience(root);
  assert.equal(report.migrated, true);
  assert.deepEqual(hexLedger(databaseFile(root)), before.events);
});

test('dry run reports the pending conversion and writes no files', t => {
  const root = temporary(t);
  buildLegacyStore(root);
  const entriesBefore = fs.readdirSync(root).sort();
  const fileBytes = fs.readFileSync(databaseFile(root));
  const view = inspectSharedExperience(root);
  assert.equal(view.schemaVersion, EXPERIENCE_LEGACY_SCHEMA_VERSION);
  assert.equal(view.pending, true);
  assert.equal(view.migrated, false);
  assert.ok(view.events > 0);
  const dry = migrateSharedExperience(root, { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.pending, true);
  assert.equal(dry.events, view.events);
  assert.deepEqual(fs.readdirSync(root).sort(), entriesBefore, 'inspection removes the sidecars its own read created');
  assert.deepEqual(fs.readFileSync(databaseFile(root)), fileBytes);
  assert.equal(fs.existsSync(backupFile(root)), false);
});

test('SIGKILL during conversion never leaves a partial ledger', async t => {
  const source = temporary(t);
  const seed = openSharedExperienceV1Baseline(source);
  for (let n = 0; n < 6000; n += 1) seed.recordFailure({
    id: experienceEventId('crash', n), type: 'tool/error', code: 'ENOENT', target: `tool:target-${n % 300}`,
  });
  seed.close();
  const expected = inspectDatabase(databaseFile(source));
  assert.equal(expected.version, EXPERIENCE_LEGACY_SCHEMA_VERSION);
  assert.equal(expected.events, 6000);

  const delays = [70, 100, 130, 170, 220, 280, 350];
  for (const delay of delays) {
    const attempt = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-experience-crash-'));
    try {
      fs.copyFileSync(databaseFile(source), databaseFile(attempt));
      fs.chmodSync(databaseFile(attempt), 0o600);
      const code = `import { migrateSharedExperience } from ${JSON.stringify(migrationModuleUrl)};
        try { const report = migrateSharedExperience(${JSON.stringify(attempt)});
          console.log(JSON.stringify({ ok: true, migrated: report.migrated, already: Boolean(report.alreadyMigrated) })); }
        catch (error) { console.log(JSON.stringify({ ok: false, error: String(error?.message || error) })); }`;
      const child = spawn(process.execPath, ['--max-old-space-size=4096', '--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', value => { stdout += value; });
      child.stderr.on('data', value => { stderr += value; });
      const exited = once(child, 'exit');
      await new Promise(resolve => setTimeout(resolve, delay));
      if (child.exitCode === null) child.kill('SIGKILL');
      const [code_] = await exited;
      assert.ok(code_ === 0 || code_ === null || code_ === 137 || code_ === 'SIGKILL', `unexpected child exit ${code_}: ${stderr}`);

      const interrupted = inspectDatabase(databaseFile(attempt));
      assert.equal(interrupted.integrity, 'ok', `database must stay readable after SIGKILL at ${delay} ms`);
      assert.ok(interrupted.version === EXPERIENCE_LEGACY_SCHEMA_VERSION || interrupted.version === EXPERIENCE_SCHEMA_VERSION,
        `unexpected schema version ${interrupted.version}`);
      assert.equal(interrupted.events, 6000, 'no event may be lost or duplicated by an interrupted conversion');
      assert.deepEqual(interrupted.tables, ['clock', 'events', 'knowledge'], 'no half-installed side table may survive');
      if (interrupted.version === EXPERIENCE_LEGACY_SCHEMA_VERSION) {
        assert.match(interrupted.eventsSql, /id TEXT PRIMARY KEY/i);
      } else {
        assert.match(interrupted.eventsSql, /WITHOUT ROWID/i);
      }

      const finished = migrateSharedExperience(attempt);
      assert.equal(finished.events.after ?? finished.events, 6000);
      const complete = inspectDatabase(databaseFile(attempt));
      assert.equal(complete.version, EXPERIENCE_SCHEMA_VERSION);
      assert.equal(complete.events, 6000);
      assert.deepEqual(complete.tables, ['clock', 'events', 'knowledge']);
      assert.equal(fs.readdirSync(attempt).some(name => name.includes('.tmp-')), false, 'stale backup temporaries are cleaned');
    } finally { fs.rmSync(attempt, { recursive: true, force: true }); }
  }
});

test('the schema 1 backup restores the exact pre-conversion ledger', t => {
  const root = temporary(t);
  const before = legacySnapshot(root);
  const report = migrateSharedExperience(root);
  assert.equal(report.migrated, true);
  assert.ok(report.backup?.path);

  // Stop everything, then replace the schema 2 database with the backup.
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(`${databaseFile(root)}${suffix}`, { force: true }); } catch { /* absent */ }
  }
  fs.copyFileSync(backupFile(root), databaseFile(root));
  fs.chmodSync(databaseFile(root), 0o600);

  const restored = inspectDatabase(databaseFile(root));
  assert.equal(restored.integrity, 'ok');
  assert.equal(restored.version, EXPERIENCE_LEGACY_SCHEMA_VERSION);
  assert.equal(restored.events, before.events.length);
  assert.deepEqual(rawLedger(databaseFile(root)).events, before.events);
  assert.deepEqual(rawLedger(databaseFile(root)).knowledge, before.knowledge);
  const legacy = openSharedExperienceV1Baseline(root);
  legacy.close();
  const reopened = openSharedExperience(root);
  assert.equal(reopened.schemaVersion, EXPERIENCE_LEGACY_SCHEMA_VERSION);
  assert.deepEqual(reopened.stats(), { events: before.events.length, knowledge: before.knowledge.length });
  reopened.close();
});
