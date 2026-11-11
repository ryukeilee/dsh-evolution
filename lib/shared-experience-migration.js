/**
 * One-time offline schema conversion for the unified shared experience store.
 *
 * Schema 1 (v0.2.4 and earlier) keeps the permanent event ledger as two
 * 64-character TEXT columns plus a rowid and a separate unique index. Schema 2
 * stores the same full SHA-256 identities as 32-byte BLOBs in a STRICT WITHOUT
 * ROWID table: same identity, same permanent dedup, same conflict rejection,
 * fewer bytes per event. This module is the *only* code that rewrites an
 * existing ledger; `openSharedExperience()` deliberately keeps schema 1
 * readable/writable and never converts on startup.
 *
 * Safety contract:
 * - The conversion is a single `BEGIN EXCLUSIVE` transaction. The old `events`
 *   table is copied and verified before it is dropped, so a failure rolls back
 *   to the untouched schema 1 database.
 * - Before the transaction the WAL is fully checkpointed and a private backup of
 *   the main database file is written with fsync + rename. A backup that does
 *   not match the current ledger is refused instead of replaced.
 * - Another committed writer between the checkpoint and the exclusive lock makes
 *   the WAL non-empty; the migration refuses with `E_EXPERIENCE_MIGRATION_BUSY`
 *   instead of dropping committed facts from the backup snapshot.
 * - `VACUUM` and checkpointing happen only after the committed conversion and
 *   only from this explicit command. The daily write path never vacuums.
 * - A schema 1 process that is already running cannot write into schema 2:
 *   its TEXT insert is rejected by the STRICT table, so no mixed ledger can be
 *   created. A schema 1 process that opens after conversion refuses the
 *   unknown `user_version` at startup. Neither path silently corrupts data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
  assertPrivateExperienceFile,
  EXPERIENCE_LEGACY_SCHEMA_VERSION,
  EXPERIENCE_SCHEMA_VERSION,
  readSharedExperienceSchema,
  sharedExperienceLocation,
} from './shared-experience.js';

const require = createRequire(import.meta.url);
const HEX64 = /^[a-f0-9]{64}$/;
const PAGE = 512;
const DEFAULT_BUSY_TIMEOUT_MS = 3000;
const DEFAULT_BACKUP_SUFFIX = '.v1-backup';

function migrationError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function fileBytes(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function directoryBytes(root) {
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    try { total += fs.statSync(path.join(root, entry.name)).size; } catch { /* raced deletion */ }
  }
  return total;
}

/** Per-object SQLite page usage. `dbstat` is part of SQLite's default build. */
function dbStat(db) {
  try {
    const rows = db.prepare('SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name').all();
    const objects = Object.fromEntries(rows.map(row => [row.name, Number(row.bytes)]));
    const total = rows.reduce((sum, row) => sum + Number(row.bytes), 0);
    return { objects, total };
  } catch { return null; }
}

function eventsBytes(stat) {
  if (!stat) return null;
  return (stat.objects.events ?? 0) + (stat.objects.sqlite_autoindex_events_1 ?? 0) + (stat.objects.events_next ?? 0);
}

function knowledgeBytes(stat) {
  if (!stat) return null;
  return (stat.objects.knowledge ?? 0) + (stat.objects.knowledge_recent ?? 0)
    + (stat.objects.sqlite_autoindex_knowledge_1 ?? 0);
}

function storageSnapshot(db, file, root) {
  const stat = dbStat(db);
  return {
    mainBytes: fileBytes(file),
    walBytes: fileBytes(`${file}-wal`),
    shmBytes: fileBytes(`${file}-shm`),
    directoryBytes: directoryBytes(root),
    pageCount: db.prepare('PRAGMA page_count').get()?.page_count ?? null,
    freelistCount: db.prepare('PRAGMA freelist_count').get()?.freelist_count ?? null,
    dbstat: stat,
    eventsBytes: eventsBytes(stat),
    knowledgeBytes: knowledgeBytes(stat),
  };
}

/** A streaming fingerprint of the canonical knowledge rows, ordered by key. */
function knowledgeFingerprint(db) {
  const hash = createHash('sha256');
  let last = '';
  let count = 0;
  for (;;) {
    const rows = db.prepare('SELECT key, body, revision FROM knowledge WHERE key > ? ORDER BY key LIMIT ?')
      .all(last, PAGE);
    for (const row of rows) {
      hash.update(String(row.key)); hash.update('\0');
      hash.update(String(row.body)); hash.update('\0');
      hash.update(String(row.revision)); hash.update('\n');
      count += 1;
      last = row.key;
    }
    if (rows.length < PAGE) break;
  }
  return { digest: hash.digest('hex'), count };
}

/** Schema 1 event rows in id order: the same order the BLOB keys sort in. */
function* iterateEventsV1(db) {
  let last = '';
  for (;;) {
    const rows = db.prepare('SELECT id, digest FROM events WHERE id > ? ORDER BY id LIMIT ?').all(last, PAGE);
    for (const row of rows) {
      if (typeof row.id !== 'string' || !HEX64.test(row.id)) {
        throw migrationError('E_EXPERIENCE_MIGRATION_DATA', 'events contains an id that is not a 64-character lowercase SHA-256 hex string');
      }
      if (typeof row.digest !== 'string' || !HEX64.test(row.digest)) {
        throw migrationError('E_EXPERIENCE_MIGRATION_DATA', 'events contains a digest that is not a 64-character lowercase SHA-256 hex string');
      }
      yield { id: row.id, digest: row.digest };
      last = row.id;
    }
    if (rows.length < PAGE) break;
  }
}

/** Schema 2 event rows as lowercase hex, in the same key order as schema 1. */
function* iterateEventsV2(db, table = 'events') {
  if (table !== 'events' && table !== 'events_next') throw new Error('internal table name');
  let last = Buffer.alloc(0);
  for (;;) {
    const rows = db.prepare(`SELECT id, digest, hex(id) AS idHex, hex(digest) AS digestHex FROM ${table} WHERE id > ? ORDER BY id LIMIT ?`)
      .all(last, PAGE);
    for (const row of rows) {
      const id = row.id instanceof Uint8Array ? row.id : null;
      const digest = row.digest instanceof Uint8Array ? row.digest : null;
      if (!id || !digest || id.length !== 32 || digest.length !== 32) {
        throw migrationError('E_EXPERIENCE_MIGRATION_DATA', 'schema 2 events row does not hold two 32-byte BLOBs');
      }
      yield { id: String(row.idHex).toLowerCase(), digest: String(row.digestHex).toLowerCase() };
      last = Buffer.from(id);
    }
    if (rows.length < PAGE) break;
  }
}

function addFingerprint(hash, id, digest) {
  hash.update(id); hash.update('\0'); hash.update(digest); hash.update('\n');
}

function eventFingerprint(rows) {
  const hash = createHash('sha256');
  let count = 0;
  for (const row of rows) { addFingerprint(hash, row.id, row.digest); count += 1; }
  return { digest: hash.digest('hex'), count };
}

function removeBackupSidecars(backupPath) {
  for (const suffix of ['-wal', '-shm']) {
    try { fs.rmSync(`${backupPath}${suffix}`, { force: true }); } catch { /* best effort */ }
  }
}

/**
 * A read-only connection that removes the WAL/SHM sidecars its own open creates
 * when they did not exist before. A dry run or an inspection must not leave new
 * files next to the live store. Only files absent immediately before our open
 * are ever removed: a live writer's WAL/SHM already exists, and an operator
 * inspects or converts while entry processes are stopped.
 */
function openReadOnlyClean(file) {
  const created = ['-wal', '-shm'].map(suffix => ({ file: `${file}${suffix}`, existed: fs.existsSync(`${file}${suffix}`) }));
  const db = new (require('node:sqlite').DatabaseSync)(file, { readOnly: true });
  return {
    db,
    close() {
      db.close();
      for (const entry of created) {
        if (entry.existed) continue;
        try { fs.rmSync(entry.file, { force: true }); } catch { /* best effort */ }
      }
    },
  };
}

function removeStaleBackupTemps(backupPath) {
  const directory = path.dirname(backupPath);
  const base = path.basename(backupPath);
  let entries;
  try { entries = fs.readdirSync(directory); } catch { return; }
  for (const entry of entries) {
    if (!entry.startsWith(`${base}.tmp-`)) continue;
    try { fs.rmSync(path.join(directory, entry), { force: true }); } catch { /* best effort */ }
  }
}

/** Copy the checkpointed main database file to a durable private backup. */
function copyFileDurable(source, target) {
  removeStaleBackupTemps(target);
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.copyFileSync(source, temp);
    fs.chmodSync(temp, 0o600);
    const handle = fs.openSync(temp, 'r+');
    try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    fs.renameSync(temp, target);
    try {
      const directory = fs.openSync(path.dirname(target), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch { /* directory fsync is best effort on platforms that allow it */ }
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

/** Verify that a backup file is a complete schema 1 snapshot of `expected`. */
function verifyBackup(backupPath, expected) {
  let stat;
  try { stat = fs.lstatSync(backupPath); } catch { throw migrationError('E_EXPERIENCE_MIGRATION_BACKUP', 'the backup file is missing'); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw migrationError('E_EXPERIENCE_MIGRATION_BACKUP', 'the backup path is not a regular file');
  const connection = openReadOnlyClean(backupPath);
  const db = connection.db;
  try {
    if (readSharedExperienceSchema(db) !== EXPERIENCE_LEGACY_SCHEMA_VERSION) {
      throw migrationError('E_EXPERIENCE_MIGRATION_BACKUP', 'the backup is not a schema 1 database');
    }
    const integrity = db.prepare('PRAGMA integrity_check').get()?.integrity_check;
    if (integrity !== 'ok') throw migrationError('E_EXPERIENCE_MIGRATION_BACKUP', `the backup does not pass integrity_check (${String(integrity).slice(0, 80)})`);
    const events = eventFingerprint(iterateEventsV1(db));
    const knowledge = knowledgeFingerprint(db);
    if (events.count !== expected.eventsCount || events.digest !== expected.eventsDigest) {
      throw migrationError('E_EXPERIENCE_MIGRATION_BACKUP', 'the existing backup does not match the current event ledger; move it away and rerun');
    }
    if (knowledge.count !== expected.knowledgeCount || knowledge.digest !== expected.knowledgeDigest) {
      throw migrationError('E_EXPERIENCE_MIGRATION_BACKUP', 'the existing backup does not match the current knowledge rows; move it away and rerun');
    }
    return { path: backupPath, bytes: stat.size, verified: true, reused: true };
  } finally {
    connection.close();
    removeBackupSidecars(backupPath);
  }
}

/** Reclaim freed pages / WAL bytes after the conversion; never part of writes. */
function reclaim(db, file, options) {
  const warnings = [];
  let checkpointBusy = false;
  const checkpoint = () => {
    try {
      const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if (Number(result?.busy) !== 0) checkpointBusy = true;
    } catch (error) { warnings.push(`wal checkpoint failed: ${String(error?.message || error).slice(0, 120)}`); }
  };
  checkpoint();
  let vacuumed = false;
  if (options.vacuum !== false) {
    try { db.exec('VACUUM'); vacuumed = true; }
    catch (error) { warnings.push(`VACUUM skipped: ${String(error?.message || error).slice(0, 120)}`); }
    checkpoint();
  }
  return { vacuumed, checkpointBusy, warnings };
}

function assertBackupPathUsable(backupPath, file) {
  if (backupPath === file) throw migrationError('E_EXPERIENCE_MIGRATION_BACKUP', 'the backup path must not be the live database file');
  const directory = path.dirname(backupPath);
  const stat = fs.statSync(directory);
  if (!stat.isDirectory()) throw migrationError('E_EXPERIENCE_MIGRATION_BACKUP', 'the backup directory is not a directory');
}

/**
 * Read-only view of a shared experience store: schema version, row counts,
 * bytes and whether the one-time conversion is pending.
 */
export function inspectSharedExperience(root) {
  const { root: resolvedRoot, file } = sharedExperienceLocation(root, { create: false });
  if (!fs.existsSync(file)) return { present: false, root: resolvedRoot, file, migrated: false, pending: false };
  assertPrivateExperienceFile(file);
  const connection = openReadOnlyClean(file);
  const db = connection.db;
  try {
    const stat = fs.statSync(file);
    if (stat.size === 0) {
      return { present: true, root: resolvedRoot, file, empty: true, schemaVersion: 0, migrated: false, pending: false,
        bytes: storageSnapshot(db, file, resolvedRoot) };
    }
    let schemaVersion;
    try { schemaVersion = readSharedExperienceSchema(db); }
    catch (error) {
      if (error.message !== 'E_EXPERIENCE_SCHEMA') throw error;
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length;
      if (tables !== 0) throw error;
      schemaVersion = 0;
    }
    const events = schemaVersion === 0 ? 0 : db.prepare('SELECT count(*) AS n FROM events').get().n;
    const knowledge = schemaVersion === 0 ? 0 : db.prepare('SELECT count(*) AS n FROM knowledge').get().n;
    return {
      present: true,
      root: resolvedRoot,
      file,
      schemaVersion,
      migrated: schemaVersion === EXPERIENCE_SCHEMA_VERSION,
      pending: schemaVersion === EXPERIENCE_LEGACY_SCHEMA_VERSION,
      events,
      knowledge,
      bytes: storageSnapshot(db, file, resolvedRoot),
    };
  } finally { connection.close(); }
}

/**
 * Convert one schema 1 database to schema 2. Returns a report; a no-op report is
 * returned when the store is already schema 2, empty or missing. Throws with a
 * coded error when the conversion is unsafe or fails; the database is left in
 * its previous committed state on every failure path.
 *
 * @param {string} root shared experience store directory
 * @param {{ backup?: boolean|string, vacuum?: boolean, busyTimeoutMs?: number, dryRun?: boolean }} [options]
 */
export function migrateSharedExperience(root, options = {}) {
  const started = Date.now();
  const migrationOptions = {
    backup: options.backup ?? true,
    vacuum: options.vacuum ?? true,
    busyTimeoutMs: Number.isFinite(options.busyTimeoutMs) ? Math.max(1, Math.floor(options.busyTimeoutMs)) : DEFAULT_BUSY_TIMEOUT_MS,
  };
  let location;
  try { location = sharedExperienceLocation(root, { create: false }); }
  catch (error) {
    if (error.code === 'ENOENT') {
      return { migrated: false, missing: true, root: path.resolve(root), pending: false, dryRun: options.dryRun === true,
        durationMs: Date.now() - started };
    }
    throw error;
  }
  const { root: resolvedRoot, file } = location;
  if (!fs.existsSync(file)) {
    return { migrated: false, missing: true, root: resolvedRoot, file, pending: false, dryRun: options.dryRun === true,
      durationMs: Date.now() - started };
  }
  if (options.dryRun) {
    const view = inspectSharedExperience(resolvedRoot);
    return { ...view, dryRun: true, durationMs: Date.now() - started };
  }
  assertPrivateExperienceFile(file);

  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  let phase = 'inspect';
  const warnings = [];
  try {
    db.exec(`PRAGMA busy_timeout=${migrationOptions.busyTimeoutMs}`);
    const version = db.prepare('PRAGMA user_version').get().user_version;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
    if (version === 0 && tables.length === 0) {
      return { migrated: false, empty: true, root: resolvedRoot, file, pending: false, durationMs: Date.now() - started };
    }
    const schemaVersion = readSharedExperienceSchema(db);
    if (schemaVersion === EXPERIENCE_SCHEMA_VERSION) {
      // A previous explicit conversion may have committed and then been
      // interrupted before reclamation; finish that (and only that) here.
      const events = db.prepare('SELECT count(*) AS n FROM events').get().n;
      const knowledge = db.prepare('SELECT count(*) AS n FROM knowledge').get().n;
      const before = storageSnapshot(db, file, resolvedRoot);
      // A rerun only finishes what a previous explicit conversion left: pending
      // WAL frames and free pages. With neither, the database file is untouched
      // (no needless full rewrite of a large ledger).
      const needsVacuum = Number(before.freelistCount ?? 0) > 0;
      const reclaimed = reclaim(db, file, { ...migrationOptions, vacuum: migrationOptions.vacuum && needsVacuum });
      const after = storageSnapshot(db, file, resolvedRoot);
      return {
        migrated: false, alreadyMigrated: true, root: resolvedRoot, file, schemaVersion,
        events, knowledge,
        bytes: { before, after },
        reclaimed: { ...reclaimed, freedPages: Number(before.freelistCount ?? 0) },
        durationMs: Date.now() - started,
      };
    }

    phase = 'checkpoint';
    // A complete checkpoint is required twice over: the backup is a plain copy
    // of the main file, and a conversion must see every committed fact. A
    // busy result means another process is using the store right now.
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (Number(checkpoint?.busy) !== 0) {
      throw migrationError('E_EXPERIENCE_MIGRATION_BUSY', 'another process is using the store; stop Desktop/ACP/Web and rerun');
    }
    if (fileBytes(`${file}-wal`) !== 0) {
      throw migrationError('E_EXPERIENCE_MIGRATION_BUSY', 'the WAL could not be fully checkpointed; stop Desktop/ACP/Web and rerun');
    }

    phase = 'lock';
    const before = storageSnapshot(db, file, resolvedRoot);
    db.exec('BEGIN EXCLUSIVE');
    let committed = false;
    let backup = null;
    let source;
    let knowledgeBefore;
    let expected;
    try {
      // The checkpoint happened outside this transaction; if another writer
      // committed in between, its frames are in the WAL and would be missing
      // from the backup. Refuse instead of converting a different snapshot.
      const lockedVersion = readSharedExperienceSchema(db);
      if (lockedVersion !== EXPERIENCE_LEGACY_SCHEMA_VERSION) {
        // Another explicit conversion won the race between the checkpoint and
        // our lock. It already did the work; report the completed state.
        const events = db.prepare('SELECT count(*) AS n FROM events').get().n;
        const knowledge = db.prepare('SELECT count(*) AS n FROM knowledge').get().n;
        db.exec('ROLLBACK');
        return { migrated: false, alreadyMigrated: true, root: resolvedRoot, file, schemaVersion: lockedVersion,
          events, knowledge, durationMs: Date.now() - started };
      }
      if (fileBytes(`${file}-wal`) !== 0) {
        throw migrationError('E_EXPERIENCE_MIGRATION_BUSY', 'another process committed during the migration; rerun');
      }
      source = eventFingerprint(iterateEventsV1(db));
      knowledgeBefore = knowledgeFingerprint(db);
      const eventsCount = db.prepare('SELECT count(*) AS n FROM events').get().n;
      if (eventsCount !== source.count) throw migrationError('E_EXPERIENCE_MIGRATION_DATA', 'the event ledger changed during the conversion');
      expected = { eventsCount, eventsDigest: source.digest, knowledgeCount: knowledgeBefore.count, knowledgeDigest: knowledgeBefore.digest };

      if (migrationOptions.backup !== false) {
        const backupPath = path.resolve(typeof migrationOptions.backup === 'string'
          ? migrationOptions.backup : `${file}${DEFAULT_BACKUP_SUFFIX}`);
        assertBackupPathUsable(backupPath, file);
        if (fs.existsSync(backupPath)) {
          backup = verifyBackup(backupPath, expected);
        } else {
          copyFileDurable(file, backupPath);
          // A fresh backup is verified with the same comparator before the old
          // table is touched, so a broken copy aborts the transaction. It is
          // not a reused backup even though the verifier is shared.
          backup = { ...verifyBackup(backupPath, expected), reused: false };
        }
      }

      db.exec('CREATE TABLE events_next (id BLOB PRIMARY KEY, digest BLOB NOT NULL, CHECK (length(id) = 32 AND length(digest) = 32)) STRICT, WITHOUT ROWID');
      const insert = db.prepare('INSERT INTO events_next VALUES (?,?)');
      const hash = createHash('sha256');
      let copied = 0;
      for (const row of iterateEventsV1(db)) {
        const id = Buffer.from(row.id, 'hex');
        const digestValue = Buffer.from(row.digest, 'hex');
        if (id.length !== 32 || digestValue.length !== 32 || id.toString('hex') !== row.id || digestValue.toString('hex') !== row.digest) {
          throw migrationError('E_EXPERIENCE_MIGRATION_DATA', 'an event identity does not round-trip as 32 bytes');
        }
        insert.run(id, digestValue);
        addFingerprint(hash, row.id, row.digest);
        copied += 1;
      }
      if (copied !== expected.eventsCount) throw migrationError('E_EXPERIENCE_MIGRATION_DATA', 'the copied event count does not match the ledger');
      const copiedDigest = hash.digest('hex');
      if (copiedDigest !== expected.eventsDigest) throw migrationError('E_EXPERIENCE_MIGRATION_DATA', 'the copied event identities do not match the ledger');

      phase = 'verify';
      const written = eventFingerprint(iterateEventsV2(db, 'events_next'));
      if (written.count !== expected.eventsCount || written.digest !== expected.eventsDigest) {
        throw migrationError('E_EXPERIENCE_MIGRATION_DATA', 'schema 2 event identities do not round-trip to the ledger identity');
      }
      const knowledgeAfter = knowledgeFingerprint(db);
      if (knowledgeAfter.count !== knowledgeBefore.count || knowledgeAfter.digest !== knowledgeBefore.digest) {
        throw migrationError('E_EXPERIENCE_MIGRATION_DATA', 'knowledge rows changed during the conversion');
      }

      phase = 'swap';
      db.exec('DROP TABLE events; ALTER TABLE events_next RENAME TO events;');
      db.exec(`PRAGMA user_version=${EXPERIENCE_SCHEMA_VERSION}`);
      const afterSwap = db.prepare('SELECT count(*) AS n FROM events').get().n;
      if (afterSwap !== expected.eventsCount) throw migrationError('E_EXPERIENCE_MIGRATION_DATA', 'the converted table row count does not match the ledger');
      db.exec('COMMIT');
      committed = true;
    } catch (error) {
      if (!committed) {
        try { db.exec('ROLLBACK'); } catch { /* the transaction may already be gone */ }
      }
      throw error;
    }

    phase = 'verify-committed';
    if (readSharedExperienceSchema(db) !== EXPERIENCE_SCHEMA_VERSION) {
      throw migrationError('E_EXPERIENCE_MIGRATION_DATA', 'the committed database is not a valid schema 2 store');
    }
    const committedEvents = eventFingerprint(iterateEventsV2(db));
    if (committedEvents.count !== expected.eventsCount || committedEvents.digest !== expected.eventsDigest) {
      throw migrationError('E_EXPERIENCE_MIGRATION_DATA', 'the committed schema 2 ledger is incomplete');
    }
    const committedKnowledge = knowledgeFingerprint(db);
    if (committedKnowledge.count !== expected.knowledgeCount || committedKnowledge.digest !== expected.knowledgeDigest) {
      throw migrationError('E_EXPERIENCE_MIGRATION_DATA', 'the committed knowledge rows changed');
    }
    const integrity = db.prepare('PRAGMA integrity_check').get()?.integrity_check;
    if (integrity !== 'ok') throw migrationError('E_EXPERIENCE_MIGRATION_DATA', `integrity_check failed after conversion (${String(integrity).slice(0, 80)})`);

    phase = 'reclaim';
    const reclaimed = reclaim(db, file, migrationOptions);
    warnings.push(...reclaimed.warnings);
    const after = storageSnapshot(db, file, resolvedRoot);
    return {
      migrated: true,
      root: resolvedRoot,
      file,
      fromVersion: EXPERIENCE_LEGACY_SCHEMA_VERSION,
      toVersion: EXPERIENCE_SCHEMA_VERSION,
      events: { before: expected.eventsCount, after: committedEvents.count, digest: expected.eventsDigest },
      knowledge: { before: expected.knowledgeCount, after: committedKnowledge.count, digest: expected.knowledgeDigest },
      backup,
      bytes: { before, after },
      reclaimed: { vacuumed: reclaimed.vacuumed, checkpointBusy: reclaimed.checkpointBusy,
        freedPages: Number(before.freelistCount ?? 0) },
      durationMs: Date.now() - started,
      warnings,
    };
  } catch (error) {
    if (!String(error?.code || '').startsWith('E_EXPERIENCE_')) {
      // SQLite reports lock contention as a plain BUSY error; name it so the
      // command can tell the operator to stop the entries and retry.
      if (error?.errcode === 5 || /database is locked/i.test(String(error?.message || ''))) {
        const busy = migrationError('E_EXPERIENCE_MIGRATION_BUSY', 'another process is using the store; stop Desktop/ACP/Web and rerun');
        busy.migrationPhase = phase;
        throw busy;
      }
    }
    error.migrationPhase = error.migrationPhase || phase;
    throw error;
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}
