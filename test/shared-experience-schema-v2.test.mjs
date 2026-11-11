import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  EXPERIENCE_LEGACY_SCHEMA_VERSION,
  EXPERIENCE_SCHEMA_VERSION,
  experienceEventId,
  openSharedExperience,
} from '../lib/shared-experience.js';
import { normalizeKnowledgeEvent, mergeKnowledgeEntry } from '../lib/dockyard-domain/knowledge.js';
import { openSharedExperienceV1Baseline } from './fixtures/shared-experience-v1.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-experience-v2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function readOnly(file) {
  return new DatabaseSync(file, { readOnly: true });
}

function failure(n, code = 'ENOENT', target = 'tool:read_file') {
  return { id: experienceEventId('schema-v2', n), type: 'tool/error', code, target };
}

/** The exact projected payload and content digest `recordFailure` commits. */
function projectedFailure({ code = 'ENOENT', target = 'tool:read_file' } = {}) {
  const safeCode = /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'HOST_OPERATION_FAILED';
  const safeTarget = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(target) ? target : 'host';
  return {
    type: 'tool/error', code: safeCode, componentId: safeTarget, severity: 'error',
    status: 'failed', message: `Official operation failed (${safeCode})`,
  };
}

const sortKeys = value => Array.isArray(value)
  ? value.map(sortKeys)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]))
    : value;

/** Drop the canonical fields that legitimately differ between separate runs. */
function stableKnowledgeBody(body) {
  const value = JSON.parse(body);
  for (const key of ['firstSeen', 'lastSeen', 'updatedAt', 'recentEvidence', 'trend']) delete value[key];
  return JSON.stringify(sortKeys(value));
}

function databaseDump(file, version) {
  const db = readOnly(file);
  try {
    const events = version === EXPERIENCE_SCHEMA_VERSION
      ? db.prepare('SELECT hex(id) AS id, hex(digest) AS digest FROM events ORDER BY id').all()
        .map(row => ({ id: row.id.toLowerCase(), digest: row.digest.toLowerCase() }))
      : db.prepare('SELECT id, digest FROM events ORDER BY id').all().map(row => ({ id: row.id, digest: row.digest }));
    // Two fresh stores record the same facts at different wall-clock times, so
    // the layout comparison projects out the timing-dependent fields the
    // canonical accumulator keeps (recent evidence is deduped by its timestamp);
    // every stable identity and counter must still be identical.
    const knowledge = db.prepare('SELECT key, body, revision FROM knowledge ORDER BY key').all()
      .map(row => ({ key: row.key, body: stableKnowledgeBody(row.body), revision: row.revision }));
    return { events, knowledge };
  } finally { db.close(); }
}

test('new stores create schema 2 with full 32-byte SHA-256 identities in BLOB columns', t => {
  const root = temporary(t);
  const store = openSharedExperience(root);
  assert.equal(store.schemaVersion, EXPERIENCE_SCHEMA_VERSION);
  const id = failure(1).id;
  assert.equal(store.recordFailure(failure(1)).committed, true);
  store.close();

  const db = readOnly(path.join(root, 'experience.sqlite'));
  t.after(() => db.close());
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, EXPERIENCE_SCHEMA_VERSION);
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='events'").get().sql;
  assert.match(sql, /STRICT/);
  assert.match(sql, /WITHOUT ROWID/);
  assert.match(sql, /id BLOB PRIMARY KEY/i);
  assert.match(sql, /digest BLOB NOT NULL/i);
  assert.match(sql, /CHECK\s*\(\s*length\(id\)\s*=\s*32\s+AND\s+length\(digest\)\s*=\s*32\s*\)/i);
  // The declared length invariant is enforced by SQLite itself.
  assert.throws(() => {
    const raw = new DatabaseSync(path.join(root, 'experience.sqlite'));
    try { raw.prepare('INSERT INTO events VALUES (?,?)').run(Buffer.alloc(64), Buffer.alloc(32)); }
    finally { raw.close(); }
  }, /CHECK constraint failed/);
  const row = db.prepare('SELECT typeof(id) AS idType, length(id) AS idLength, typeof(digest) AS digestType,'
    + ' length(digest) AS digestLength, hex(id) AS idHex, hex(digest) AS digestHex FROM events').get();
  assert.equal(row.idType, 'blob');
  assert.equal(row.idLength, 32);
  assert.equal(row.digestType, 'blob');
  assert.equal(row.digestLength, 32);
  assert.equal(row.idHex.toLowerCase(), id);
  assert.equal(row.digestHex.toLowerCase(), sha256(JSON.stringify(projectedFailure())));
  // The rowid table's unique TEXT index is gone: the WITHOUT ROWID primary key
  // is the table btree itself.
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND tbl_name='events'").get().n, 0);
});

test('schema 2 keeps permanent dedup, conflict rejection and canonical knowledge identical', t => {
  const root = temporary(t);
  let store = openSharedExperience(root);
  for (let n = 0; n < 300; n++) assert.equal(store.recordFailure(failure(n)).duplicate, false);
  store.close();
  store = openSharedExperience(root);
  t.after(() => store.close());
  // A transport replay of an event beyond the canonical window is still exact.
  assert.deepEqual(store.recordFailure(failure(7)), { committed: true, duplicate: true });
  assert.deepEqual(store.stats(), { events: 300, knowledge: 1 });
  const recorded = store.recall({ problem: 'read_file' }).records[0];
  assert.equal(recorded.occurrences, 300);
  assert.equal(recorded.failureCount, 300);
  assert.equal(recorded.state, 'LEARNING');
  assert.throws(() => store.recordFailure({ ...failure(7), code: 'EACCES' }), /E_EXPERIENCE_EVENT_CONFLICT/);
  assert.deepEqual(store.stats(), { events: 300, knowledge: 1 });
  // The canonical output is the existing domain algorithm, not a projection.
  const event = normalizeKnowledgeEvent({ ...projectedFailure(), eventId: failure(7).id }, { sourceCollection: 'observations' });
  const baseline = mergeKnowledgeEntry(null, event);
  assert.equal(recorded.key, baseline.knowledgeKey);
  assert.equal(recorded.failureCount, 300);
});

test('schema 2 pays less per event than the frozen schema 1 layout for the same ledger', t => {
  const v1Root = temporary(t);
  const v2Root = temporary(t);
  const v1 = openSharedExperienceV1Baseline(v1Root);
  for (let n = 0; n < 800; n++) v1.recordFailure(failure(n));
  v1.close();
  const v2 = openSharedExperience(v2Root);
  for (let n = 0; n < 800; n++) v2.recordFailure(failure(n));
  v2.close();
  const v1Dump = databaseDump(path.join(v1Root, 'experience.sqlite'), EXPERIENCE_LEGACY_SCHEMA_VERSION);
  const v2Dump = databaseDump(path.join(v2Root, 'experience.sqlite'), EXPERIENCE_SCHEMA_VERSION);
  assert.deepEqual(v2Dump, v1Dump, 'the same logical ledger is stored by both layouts');

  const bytes = (file, name) => {
    const db = readOnly(file);
    try { return db.prepare("SELECT sum(pgsize) AS bytes FROM dbstat WHERE name IN (?, 'sqlite_autoindex_events_1')").get(name).bytes ?? 0; }
    finally { db.close(); }
  };
  const v1Bytes = bytes(path.join(v1Root, 'experience.sqlite'), 'events');
  const v2Bytes = bytes(path.join(v2Root, 'experience.sqlite'), 'events');
  assert.ok(v2Bytes > 0 && v1Bytes > 0);
  assert.ok(v2Bytes < v1Bytes * 0.6, `schema 2 events bytes ${v2Bytes} should be well under schema 1 ${v1Bytes}`);
});

test('a schema 1 database stays readable and writable in TEXT form; opening never converts it', t => {
  const root = temporary(t);
  const baseline = openSharedExperienceV1Baseline(root);
  for (let n = 0; n < 40; n++) baseline.recordFailure(failure(n, n % 2 ? 'ENOENT' : 'EACCES'));
  baseline.recordFailure(failure(0, 'EACCES'));
  baseline.close();

  const store = openSharedExperience(root);
  assert.equal(store.schemaVersion, EXPERIENCE_LEGACY_SCHEMA_VERSION);
  t.after(() => store.close());
  assert.deepEqual(store.stats(), { events: 40, knowledge: 2 });
  assert.equal(store.recordFailure(failure(0, 'EACCES')).duplicate, true);
  assert.throws(() => store.recordFailure({ ...failure(0), code: 'EPERM' }), /E_EXPERIENCE_EVENT_CONFLICT/);
  store.recordFailure(failure(100));
  store.recordFailure(failure(101));
  assert.deepEqual(store.stats(), { events: 42, knowledge: 2 });

  const file = path.join(root, 'experience.sqlite');
  const db = readOnly(file);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, EXPERIENCE_LEGACY_SCHEMA_VERSION);
    const row = db.prepare("SELECT typeof(id) AS idType, length(id) AS idLength FROM events WHERE id = ?").get(failure(100).id);
    assert.deepEqual({ type: row.idType, length: row.idLength }, { type: 'text', length: 64 });
    assert.ok(db.prepare("SELECT sum(pgsize) AS bytes FROM dbstat WHERE name='sqlite_autoindex_events_1'").get().bytes > 0);
  } finally { db.close(); }
  assert.equal(fs.existsSync(`${file}.v1-backup`), false, 'a normal open must not create a migration backup');
});

test('schema 1 compatibility mode is byte-for-byte the frozen schema 1 write algorithm', t => {
  const baselineRoot = temporary(t);
  const legacyRoot = temporary(t);
  const operations = store => {
    for (let n = 0; n < 30; n++) store.recordFailure(failure(n, n % 3 ? 'ENOENT' : 'EACCES'));
    store.recordFailure(failure(3, 'EACCES'));
    store.recordFailure(failure(30, 'ENOENT', 'tool:write_file'));
    assert.throws(() => store.recordFailure({ ...failure(3), code: 'EPERM' }), /E_EXPERIENCE_EVENT_CONFLICT/);
  };
  const baseline = openSharedExperienceV1Baseline(baselineRoot);
  operations(baseline);
  baseline.close();

  const seed = openSharedExperienceV1Baseline(legacyRoot);
  seed.close();
  const legacy = openSharedExperience(legacyRoot);
  assert.equal(legacy.schemaVersion, EXPERIENCE_LEGACY_SCHEMA_VERSION);
  operations(legacy);
  legacy.close();

  assert.deepEqual(
    databaseDump(path.join(legacyRoot, 'experience.sqlite'), EXPERIENCE_LEGACY_SCHEMA_VERSION),
    databaseDump(path.join(baselineRoot, 'experience.sqlite'), EXPERIENCE_LEGACY_SCHEMA_VERSION),
    'the compatibility mode must not drift from the frozen original storage algorithm',
  );
});

test('version-tagged databases with the wrong events shape are refused instead of written', t => {
  const root = temporary(t);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, 'experience.sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE events (id TEXT PRIMARY KEY, digest TEXT NOT NULL);'
    + 'CREATE TABLE knowledge (key TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL);'
    + 'CREATE INDEX knowledge_recent ON knowledge(revision);'
    + 'CREATE TABLE clock (value INTEGER NOT NULL); INSERT INTO clock VALUES (0);'
    + `PRAGMA user_version=${EXPERIENCE_SCHEMA_VERSION};`);
  db.close();
  fs.chmodSync(file, 0o600);
  assert.throws(() => openSharedExperience(root), /E_EXPERIENCE_UNKNOWN_DATABASE/);

  const future = new DatabaseSync(file);
  future.exec(`PRAGMA user_version=${EXPERIENCE_SCHEMA_VERSION + 1}`);
  future.close();
  assert.throws(() => openSharedExperience(root), /E_EXPERIENCE_SCHEMA/);
});

test('a still-running schema 1 writer cannot add TEXT rows to a schema 2 ledger', t => {
  const root = temporary(t);
  const store = openSharedExperience(root);
  const existing = failure(1).id;
  store.recordFailure(failure(1));
  store.close();

  // This is the exact statement pair the pre-v2 runtime runs in its own
  // transaction. Its duplicate lookup cannot match a BLOB key, so the STRICT
  // table must reject the TEXT insert instead of creating a split identity.
  const db = new DatabaseSync(path.join(root, 'experience.sqlite'));
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT digest FROM events WHERE id=?').get(existing), undefined);
  assert.throws(
    () => db.prepare('INSERT INTO events VALUES (?,?)').run(experienceEventId('old-writer'), sha256(JSON.stringify(projectedFailure()))),
    /cannot store TEXT value in BLOB column/,
  );
  assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 1);
  // The frozen schema 1 opener refuses the unknown user_version at startup.
  assert.throws(() => openSharedExperienceV1Baseline(root), /E_EXPERIENCE_SCHEMA/);
  const reopened = openSharedExperience(root);
  assert.equal(reopened.recordFailure(failure(2)).committed, true);
  assert.deepEqual(reopened.stats(), { events: 2, knowledge: 1 });
  reopened.close();
});
