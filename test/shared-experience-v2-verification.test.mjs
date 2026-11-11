/**
 * Independent, adversarial verification of the shared-experience SQLite
 * schema v2 layout (`events (id BLOB PRIMARY KEY, digest BLOB NOT NULL)
 * STRICT, WITHOUT ROWID`, `PRAGMA user_version=2`).
 *
 * This file was written from the acceptance criteria only, without reading the
 * implementation's own tests. It checks the stored bytes, the declared table
 * shape, permanent deduplication/conflict semantics, that canonical knowledge
 * is exactly what `normalizeKnowledgeEvent()` + `mergeKnowledgeEntry()` produce,
 * that a schema-1 database keeps its original TEXT layout and is never migrated
 * by a normal open, that a frozen v1 implementation refuses a v2 database, and
 * that four concurrent schema-2 processes neither lose nor duplicate facts.
 *
 * Every database lives under a fresh `fs.mkdtempSync(os.tmpdir())` root and is
 * removed afterwards; no DSH home or real data directory is touched.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  openSharedExperience,
  experienceEventId,
  readSharedExperienceSchema,
} from '../lib/shared-experience.js';
import { inspectSharedExperience, migrateSharedExperience } from '../lib/shared-experience-migration.js';
import { normalizeKnowledgeEvent, mergeKnowledgeEntry } from '../lib/dockyard-domain/knowledge.js';
import { openSharedExperienceV1Baseline } from './fixtures/shared-experience-v1.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const roots = [];
function scratch(prefix = 'dsh-se-v2-') {
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
const hexOf = value => Buffer.from(value).toString('hex');

function raw(root, fn) {
  const db = new DatabaseSync(dbFile(root));
  try { return fn(db); } finally { db.close(); }
}

/** A private 0600 database file opened directly, so tests can forge shapes. */
function forgeDatabase(root, sql) {
  fs.writeFileSync(dbFile(root), '');
  fs.chmodSync(dbFile(root), 0o600);
  const db = new DatabaseSync(dbFile(root));
  try { db.exec(sql); } finally { db.close(); }
}

function eventsOf(db) {
  // A TEXT identity must be read as text: SQLite's hex() would encode the
  // characters themselves. A BLOB identity is rendered as lowercase hex.
  const asIdentity = value => value instanceof Uint8Array ? Buffer.from(value).toString('hex') : String(value);
  return db.prepare('SELECT id, digest, typeof(id) AS idType, typeof(digest) AS digestType, length(id) AS idBytes, length(digest) AS digestBytes FROM events ORDER BY id')
    .all()
    .map(row => ({ ...row, id: asIdentity(row.id), digest: asIdentity(row.digest) }));
}

function knowledgeOf(db) {
  return db.prepare('SELECT key, body, revision FROM knowledge ORDER BY key').all();
}

function fileSnapshot(root) {
  return fs.readdirSync(root).sort().map(name => {
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    return { name, bytes: stat.size, isFile: stat.isFile(), sha256: stat.isFile() ? sha256(fs.readFileSync(file)) : null };
  });
}

const V1_SCHEMA = `CREATE TABLE events (id TEXT PRIMARY KEY, digest TEXT NOT NULL);
  CREATE TABLE knowledge (key TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL);
  CREATE INDEX knowledge_recent ON knowledge(revision);
  CREATE TABLE clock (value INTEGER NOT NULL); INSERT INTO clock VALUES (0);
  PRAGMA user_version=1`;

// ---------------------------------------------------------------------------
// schema v2 layout and stored identity bytes
// ---------------------------------------------------------------------------

test('v2: a new store declares the STRICT WITHOUT ROWID BLOB ledger and user_version=2', () => {
  const root = scratch();
  const store = openSharedExperience(root);
  try {
    assert.equal(store.schemaVersion, 2);
    assert.deepEqual(store.stats(), { events: 0, knowledge: 0 });
  } finally { store.close(); }

  raw(root, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    assert.deepEqual(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name),
      ['clock', 'events', 'knowledge'],
    );
    const declaration = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='events'").get().sql;
    assert.match(declaration, /\bSTRICT\b/i);
    assert.match(declaration, /WITHOUT\s+ROWID/i);
    // The declared table itself bounds both identity columns to 32 bytes.
    assert.match(declaration, /CHECK\s*\(\s*length\(id\)\s*=\s*32\s+AND\s+length\(digest\)\s*=\s*32\s*\)/i);
    const shape = db.prepare('PRAGMA table_info(events)').all().map(row => ({
      name: row.name, type: String(row.type || '').toUpperCase(), notnull: row.notnull, pk: row.pk,
    }));
    assert.deepEqual(shape, [
      { name: 'id', type: 'BLOB', notnull: 1, pk: 1 },
      { name: 'digest', type: 'BLOB', notnull: 1, pk: 0 },
    ]);
    const table = db.prepare('SELECT wr, strict FROM pragma_table_list WHERE name=?').get('events');
    assert.equal(Number(table.wr), 1, 'the table really is WITHOUT ROWID');
    assert.equal(Number(table.strict), 1, 'the table really is STRICT');
    // A WITHOUT ROWID table has no implicit rowid column at all.
    assert.throws(() => db.prepare('SELECT rowid FROM events').all(), /no such column/i);
    // The primary key is the table btree itself: no separate events index object
    // in sqlite_master and no separate index in the dbstat page accounting
    // (dbstat is only asserted where this SQLite build exposes it).
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND tbl_name='events'").get().n, 0);
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM dbstat WHERE name LIKE 'sqlite_autoindex_events%'").get().n, 0);
    } catch (error) {
      // dbstat is a compile-time virtual table; only assert where it exists.
      if (!/no such table|dbstat/i.test(String(error?.message))) throw error;
    }
    // STRICT must reject the legacy TEXT binding instead of storing it.
    assert.throws(() => db.exec(`INSERT INTO events VALUES ('${'a'.repeat(64)}', '${'b'.repeat(64)}')`));
    // The length CHECK rejects non-32-byte BLOBs (64-byte ids, short digests)
    // even though STRICT alone only enforces the storage class.
    assert.throws(() => db.prepare('INSERT INTO events VALUES (?,?)').run(Buffer.alloc(64, 0x61), Buffer.alloc(32, 0x62)));
    assert.throws(() => db.prepare('INSERT INTO events VALUES (?,?)').run(Buffer.alloc(32, 0x61), Buffer.alloc(31, 0x62)));
    assert.throws(() => db.prepare('INSERT INTO events VALUES (?,?)').run(Buffer.alloc(64, 0x61), Buffer.alloc(64, 0x62)));
    assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 0, 'rejected identities write no row');
    // Exactly 32 bytes is the accepted representation.
    db.prepare('INSERT INTO events VALUES (?,?)').run(Buffer.alloc(32, 0x61), Buffer.alloc(32, 0x62));
    assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 1);
    db.exec('DELETE FROM events');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  });
});

test('v2: event ids and digests are the full 32-byte SHA-256 values as BLOBs', () => {
  const root = scratch();
  const store = openSharedExperience(root);
  const failureId = sha256('verification-failure-1');
  const failureInput = {
    type: 'tool/error', code: 'E_VERIFY', componentId: 'editor', severity: 'error',
    status: 'failed', message: 'Official operation failed (E_VERIFY)',
  };
  const promotion = {
    eventId: 'evt-promotion-1', eventType: 'promotion-succeeded', target: 'plugin:edge-cache',
    audit: { at: '2025-01-02T03:04:05.000Z' },
  };
  const conclusion = {
    experimentId: 'exp-verify-1', decision: 'regression', strategyFingerprint: 'abcdef1234567890',
    occurredAt: '2025-02-01T00:00:00.000Z', target: 'plugin edge-cache', strategy: 'cache warmup',
    rootCause: 'stale cache', applicability: { dsh: '0.2.4', cordis: '4.0.1', evolution: '0.2.4' },
    metrics: { p95: 120.5 },
  };
  try {
    assert.equal(store.recordFailure({ id: failureId, type: 'tool/error', code: 'E_VERIFY', target: 'editor' }).duplicate, false);
    assert.equal(store.recordEvolution(promotion, 'desktop', { writer: 'host-a', sequence: 7 }).committed, true);
    const written = store.recordConclusion(conclusion, 'desktop');
    assert.equal(written.duplicate, false);
  } finally { store.close(); }

  raw(root, db => {
    const rows = new Map(eventsOf(db).map(row => [row.id, row]));
    for (const row of rows.values()) {
      assert.equal(row.idType, 'blob');
      assert.equal(row.digestType, 'blob');
      assert.equal(Number(row.idBytes), 32);
      assert.equal(Number(row.digestBytes), 32);
      assert.match(row.id, /^[a-f0-9]{64}$/);
      assert.match(row.digest, /^[a-f0-9]{64}$/);
    }

    // recordFailure: id is caller-supplied, digest is sha256 of the projected content.
    assert.ok(rows.has(failureId));
    assert.equal(rows.get(failureId).digest, sha256(JSON.stringify(failureInput)));

    // recordEvolution: id is sha256(origin NUL eventId); digest covers the
    // projected promotion fact (audit time is preserved verbatim).
    const promotionId = sha256('desktop\0evt-promotion-1');
    assert.ok(rows.has(promotionId));
    const promotionInput = {
      problem: 'plugin:edge-cache', capabilityId: 'plugin:edge-cache', target: 'plugin:edge-cache',
      status: 'success', regression: false, recordedAt: '2025-01-02T03:04:05.000Z',
    };
    assert.equal(rows.get(promotionId).digest, sha256(JSON.stringify(promotionInput)));

    // recordConclusion: the documented identity tuple and the documented event
    // shape produce the id and the content digest.
    const versionKey = '0.2.4|4.0.1|0.2.4';
    const conclusionId = experienceEventId('conclusion', 'desktop', 'exp-verify-1', 'regression', versionKey);
    assert.equal(conclusionId, sha256(JSON.stringify(['conclusion', 'desktop', 'exp-verify-1', 'regression', versionKey])));
    assert.ok(rows.has(conclusionId));
    const conclusionEvent = {
      type: 'experiment-conclusion',
      capabilityId: 'plugin edge-cache',
      semanticFact: 'plugin edge-cache',
      scope: 'plugin edge-cache',
      strategy: {
        approach: 'cache warmup', cordis: '4.0.1', dsh: '0.2.4', evolution: '0.2.4',
        fingerprint: 'abcdef1234567890', kind: 'cordis-plugin',
      },
      status: 'regression',
      recordedAt: '2025-02-01T00:00:00.000Z',
      rootCause: 'stale cache',
      metrics: { p95: 120.5 },
      regression: true,
    };
    assert.equal(rows.get(conclusionId).digest, sha256(JSON.stringify(conclusionEvent)));
    assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 3);
  });
});

test('v2: dedupe is permanent across reopen and id/content conflict stays loud', () => {
  const root = scratch();
  const id = 'c'.repeat(64);
  const fact = { id, type: 'tool/error', code: 'E_DEDUPE', target: 'editor' };
  const store = openSharedExperience(root);
  try {
    const first = store.recordFailure(fact);
    assert.equal(first.duplicate, false);
    assert.deepEqual(store.stats(), { events: 1, knowledge: 1 });
    const replay = store.recordFailure(fact);
    assert.equal(replay.duplicate, true);
    assert.deepEqual(store.stats(), { events: 1, knowledge: 1 });
  } finally { store.close(); }

  const reopened = openSharedExperience(root);
  try {
    assert.equal(reopened.recordFailure(fact).duplicate, true, 'replay after reopen is still a duplicate');
    assert.deepEqual(reopened.stats(), { events: 1, knowledge: 1 });
    const before = raw(root, db => knowledgeOf(db));
    assert.throws(() => reopened.recordFailure({ ...fact, code: 'E_OTHER' }), /E_EXPERIENCE_EVENT_CONFLICT/);
    assert.deepEqual(reopened.stats(), { events: 1, knowledge: 1 }, 'a conflicted id writes no ledger row');
    assert.deepEqual(raw(root, db => knowledgeOf(db)), before, 'a conflicted id writes no knowledge row');
  } finally { reopened.close(); }

  // Sanity: the same id with a different code would have a different content digest.
  assert.notEqual(
    sha256(JSON.stringify({ type: 'tool/error', code: 'E_DEDUPE', componentId: 'editor', severity: 'error', status: 'failed', message: 'Official operation failed (E_DEDUPE)' })),
    sha256(JSON.stringify({ type: 'tool/error', code: 'E_OTHER', componentId: 'editor', severity: 'error', status: 'failed', message: 'Official operation failed (E_OTHER)' })),
  );
});

test('v2: knowledge rows are exactly the canonical normalize+merge result', () => {
  const root = scratch();
  const store = openSharedExperience(root);
  try {
    // One failure fact.
    const id1 = sha256('knowledge-failure-1');
    store.recordFailure({ id: id1, type: 'tool/error', code: 'E_KNOW', target: 'component:cache' });
    // A second, distinct failure fact with the same identity dimensions: it must
    // merge into the same canonical row.
    const id2 = sha256('knowledge-failure-2');
    store.recordFailure({ id: id2, type: 'tool/error', code: 'E_KNOW', target: 'component:cache' });
    // A structured conclusion with deterministic timestamps.
    const conclusion = {
      experimentId: 'exp-know-1', decision: 'no-benefit', strategyFingerprint: '0011223344556677',
      occurredAt: '2025-03-04T05:06:07.000Z', target: 'component cache', strategy: 'preload',
      applicability: { dsh: '0.2.4', cordis: '4.0.1', evolution: '0.2.4' },
    };
    store.recordConclusion(conclusion, 'desktop');
    // One promotion fact recorded out of order (sequenced receipt) later than a
    // rollback must demote the earlier success instead of leaving a stale KNOWN.
    store.recordEvolution(
      { eventId: 'evt-know-1', eventType: 'promotion-succeeded', target: 'plugin:edge-cache', audit: { at: '2025-01-01T00:00:00.000Z' } },
      'desktop', { writer: 'host-a', sequence: 11 },
    );
    store.recordEvolution(
      { eventId: 'evt-know-2', eventType: 'promotion-reverted', target: 'plugin:edge-cache', promotion: { adapter: 'official-include', rowId: 'row-1' }, audit: { at: '2025-01-01T01:00:00.000Z' } },
      'desktop', { writer: 'host-a', sequence: 12 },
    );
  } finally { store.close(); }

  raw(root, db => {
    const rows = knowledgeOf(db).map(row => ({ ...row, entry: JSON.parse(row.body) }));

    // Rebuild the two-failure accumulator through the canonical algorithm. The
    // store does not accept an injected clock, so the recorded firstSeen /
    // lastSeen are the only timestamps available; they are what `occurredAt`
    // would have produced.
    const failureInput = { type: 'tool/error', code: 'E_KNOW', componentId: 'component:cache' };
    const failureRow = rows.find(row => (row.entry.eventIds ?? []).includes(sha256('knowledge-failure-1')));
    assert.ok(failureRow, 'the failure knowledge row exists');
    assert.equal(failureRow.entry.occurrenceCount, 2);
    const first = normalizeKnowledgeEvent(
      { ...failureInput, severity: 'error', status: 'failed', message: 'Official operation failed (E_KNOW)', eventId: sha256('knowledge-failure-1') },
      { sourceCollection: 'observations', now: new Date(failureRow.entry.firstSeen) },
    );
    let expectedBody = mergeKnowledgeEntry(null, first);
    const second = normalizeKnowledgeEvent(
      { ...failureInput, severity: 'error', status: 'failed', message: 'Official operation failed (E_KNOW)', eventId: sha256('knowledge-failure-2') },
      { sourceCollection: 'observations', now: new Date(failureRow.entry.lastSeen) },
    );
    expectedBody = mergeKnowledgeEntry(expectedBody, second);
    assert.equal(failureRow.body, JSON.stringify(expectedBody));
    assert.deepEqual(failureRow.entry.eventIds, [sha256('knowledge-failure-1'), sha256('knowledge-failure-2')]);

    // The conclusion body: deterministic recordedAt means an exact replay.
    const conclusionRow = rows.find(row => row.entry.issueType === 'experiment-conclusion');
    assert.ok(conclusionRow, 'the conclusion knowledge row exists');
    const conclusionEvent = {
      type: 'experiment-conclusion',
      capabilityId: 'component cache',
      semanticFact: 'component cache',
      scope: 'component cache',
      strategy: { approach: 'preload', cordis: '4.0.1', dsh: '0.2.4', evolution: '0.2.4', fingerprint: '0011223344556677', kind: 'cordis-plugin' },
      status: 'no-benefit',
      recordedAt: '2025-03-04T05:06:07.000Z',
      success: false,
    };
    const conclusionEventId = experienceEventId('conclusion', 'desktop', 'exp-know-1', 'no-benefit', '0.2.4|4.0.1|0.2.4');
    const conclusionNormalized = normalizeKnowledgeEvent({ ...conclusionEvent, eventId: conclusionEventId }, { sourceCollection: 'learnings' });
    assert.equal(conclusionNormalized.knowledgeKey, conclusionRow.key);
    assert.equal(conclusionRow.body, JSON.stringify(mergeKnowledgeEntry(null, conclusionNormalized)));

    // The promotion family: success then rollback share one identity, and the
    // sequenced receipt keeps the newest fact authoritative.
    const promotionRow = rows.find(row => row.entry.issueType === 'problem');
    assert.ok(promotionRow, 'the promotion knowledge row exists');
    assert.equal(promotionRow.entry.occurrenceCount, 2);
    assert.equal(promotionRow.entry.lastStatus, 'failure');
    assert.equal(promotionRow.entry.state, 'REGRESSED');
    assert.equal(promotionRow.entry.regressionCount, 1);
    const orderSource = sha256(JSON.stringify(['desktop', 'host-a']));
    assert.deepEqual(promotionRow.entry.sharedLatest, { source: orderSource, sequence: 12 });
  });
});

// ---------------------------------------------------------------------------
// schema 1 compatibility mode (normal startup must never migrate)
// ---------------------------------------------------------------------------

test('compat: a schema 1 store keeps TEXT layout, never migrates and interoperates with the frozen v1 opener', () => {
  const root = scratch();
  const baseline = openSharedExperienceV1Baseline(root);
  try {
    for (let i = 0; i < 3; i += 1) {
      baseline.recordFailure({ id: sha256(`compat-${i}`), type: 'tool/error', code: 'E_COMPAT', target: 'editor' });
    }
    assert.deepEqual(baseline.stats(), { events: 3, knowledge: 1 });
  } finally { baseline.close(); }

  const store = openSharedExperience(root);
  try {
    assert.equal(store.schemaVersion, 1, 'an existing schema 1 database is opened in compatibility mode');
    const id = sha256('compat-lib');
    assert.equal(store.recordFailure({ id, type: 'tool/error', code: 'E_COMPAT', target: 'editor' }).duplicate, false);
    assert.deepEqual(store.stats(), { events: 4, knowledge: 1 });
    assert.equal(fs.existsSync(path.join(root, 'experience.sqlite.v1-backup')), false, 'a normal open writes no backup');
  } finally { store.close(); }

  raw(root, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1, 'a normal open never upgrades the version');
    assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name='events'").get().sql, /id TEXT PRIMARY KEY, digest TEXT NOT NULL/);
    const rows = eventsOf(db);
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.equal(row.idType, 'text');
      assert.equal(row.digestType, 'text');
    }
    const libRow = rows.find(row => row.id === sha256('compat-lib'));
    assert.ok(libRow);
    assert.equal(libRow.digest, sha256(JSON.stringify({
      type: 'tool/error', code: 'E_COMPAT', componentId: 'editor', severity: 'error',
      status: 'failed', message: 'Official operation failed (E_COMPAT)',
    })));
  });

  // The frozen v0.2.4 opener still reads (and writes) the same file afterwards.
  const baselineAgain = openSharedExperienceV1Baseline(root);
  try {
    assert.deepEqual(baselineAgain.stats(), { events: 4, knowledge: 1 });
    baselineAgain.recordFailure({ id: sha256('compat-baseline-again'), type: 'tool/error', code: 'E_COMPAT', target: 'editor' });
  } finally { baselineAgain.close(); }

  const reopened = openSharedExperience(root);
  try {
    assert.equal(reopened.schemaVersion, 1);
    assert.deepEqual(reopened.stats(), { events: 5, knowledge: 1 });
    assert.equal(fs.existsSync(path.join(root, 'experience.sqlite.v1-backup')), false);
  } finally { reopened.close(); }
});

test('compat: knowledge written through the new schema 1 path matches the frozen v1 algorithm', () => {
  const fact = { id: sha256('differential-0'), type: 'tool/error', code: 'E_DIFF', target: 'component:differential' };
  const normalizeVolatile = body => {
    const entry = JSON.parse(body);
    const fixed = '<recorded-at>';
    entry.firstSeen = fixed;
    entry.lastSeen = fixed;
    entry.updatedAt = fixed;
    for (const point of entry.trend?.recent ?? []) point.at = fixed;
    for (const evidence of entry.recentEvidence ?? []) evidence.at = fixed;
    return entry;
  };

  // Root A: the frozen v0.2.4 implementation records one fact.
  const frozenRoot = scratch();
  const frozen = openSharedExperienceV1Baseline(frozenRoot);
  try { frozen.recordFailure(fact); } finally { frozen.close(); }

  // Root B: schema 1 is created by the frozen opener, then the new code opens
  // it in compatibility mode and records the same fact (only its timestamps can
  // differ; the canonical accumulator must be identical).
  const compatRoot = scratch();
  const schemaOnly = openSharedExperienceV1Baseline(compatRoot);
  schemaOnly.close();
  const compat = openSharedExperience(compatRoot);
  try {
    assert.equal(compat.schemaVersion, 1);
    compat.recordFailure(fact);
  } finally { compat.close(); }

  const frozenRow = raw(frozenRoot, db => knowledgeOf(db));
  const compatRow = raw(compatRoot, db => knowledgeOf(db));
  assert.equal(frozenRow.length, 1);
  assert.equal(compatRow.length, 1);
  assert.equal(compatRow[0].key, frozenRow[0].key);
  assert.deepEqual(normalizeVolatile(compatRow[0].body), normalizeVolatile(frozenRow[0].body));
  assert.deepEqual(
    raw(compatRoot, db => eventsOf(db).map(row => [row.id, row.digest])),
    raw(frozenRoot, db => eventsOf(db).map(row => [row.id, row.digest])),
  );

  // A merged sequence is still the canonical algorithm applied to the stored
  // occurrence order, independent of the frozen path.
  const second = { ...fact, id: sha256('differential-1') };
  const merged = openSharedExperience(compatRoot);
  try { merged.recordFailure(second); } finally { merged.close(); }
  raw(compatRoot, db => {
    const row = knowledgeOf(db)[0];
    const entry = JSON.parse(row.body);
    assert.equal(entry.occurrenceCount, 2);
    const first = normalizeKnowledgeEvent(
      { type: 'tool/error', code: 'E_DIFF', componentId: 'component:differential', severity: 'error', status: 'failed', message: 'Official operation failed (E_DIFF)', eventId: fact.id },
      { sourceCollection: 'observations', now: new Date(entry.firstSeen) },
    );
    const firstBody = mergeKnowledgeEntry(null, first);
    const next = normalizeKnowledgeEvent(
      { type: 'tool/error', code: 'E_DIFF', componentId: 'component:differential', severity: 'error', status: 'failed', message: 'Official operation failed (E_DIFF)', eventId: second.id },
      { sourceCollection: 'observations', now: new Date(entry.lastSeen) },
    );
    assert.equal(row.body, JSON.stringify(mergeKnowledgeEntry(firstBody, next)));
  });
});

// ---------------------------------------------------------------------------
// version / shape rejection, private-file guards, read-only inspection
// ---------------------------------------------------------------------------

test('shape rejection: unknown versions and mismatched event tables are refused without writes', () => {
  const cases = [
    {
      name: 'user_version=2 with the legacy TEXT table',
      sql: `${V1_SCHEMA.replace('PRAGMA user_version=1', '')} PRAGMA user_version=2;`,
      pattern: /E_EXPERIENCE_UNKNOWN_DATABASE/,
    },
    {
      name: 'unknown user_version=3',
      sql: `${V1_SCHEMA.replace('PRAGMA user_version=1', '')} PRAGMA user_version=3;`,
      pattern: /E_EXPERIENCE_SCHEMA/,
    },
    {
      name: 'user_version=2 BLOB table that still has a rowid',
      sql: `CREATE TABLE events (id BLOB PRIMARY KEY, digest BLOB NOT NULL) STRICT;
        CREATE TABLE knowledge (key TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL);
        CREATE INDEX knowledge_recent ON knowledge(revision);
        CREATE TABLE clock (value INTEGER NOT NULL); INSERT INTO clock VALUES (0);
        PRAGMA user_version=2;`,
      pattern: /E_EXPERIENCE_UNKNOWN_DATABASE/,
    },
    {
      name: 'user_version=2 BLOB WITHOUT ROWID table without the 32-byte CHECK',
      sql: `CREATE TABLE events (id BLOB PRIMARY KEY, digest BLOB NOT NULL) STRICT, WITHOUT ROWID;
        CREATE TABLE knowledge (key TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL);
        CREATE INDEX knowledge_recent ON knowledge(revision);
        CREATE TABLE clock (value INTEGER NOT NULL); INSERT INTO clock VALUES (0);
        PRAGMA user_version=2;`,
      pattern: /E_EXPERIENCE_UNKNOWN_DATABASE/,
    },
    {
      name: 'user_version=2 table with TEXT columns declared STRICT WITHOUT ROWID',
      sql: `CREATE TABLE events (id TEXT PRIMARY KEY, digest TEXT NOT NULL) STRICT, WITHOUT ROWID;
        CREATE TABLE knowledge (key TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL);
        CREATE INDEX knowledge_recent ON knowledge(revision);
        CREATE TABLE clock (value INTEGER NOT NULL); INSERT INTO clock VALUES (0);
        PRAGMA user_version=2;`,
      pattern: /E_EXPERIENCE_UNKNOWN_DATABASE/,
    },
    {
      name: 'uninitialized file that already contains tables',
      sql: `${V1_SCHEMA.replace('PRAGMA user_version=1', '')} PRAGMA user_version=0;`,
      pattern: /E_EXPERIENCE_UNKNOWN_DATABASE/,
      readerPattern: /E_EXPERIENCE_SCHEMA/,
    },
    {
      name: 'schema 1 with an unexpected extra table',
      sql: `${V1_SCHEMA}; CREATE TABLE extra (value INTEGER);`,
      pattern: /E_EXPERIENCE_UNKNOWN_DATABASE/,
    },
    {
      name: 'schema 1 without the knowledge table',
      sql: `CREATE TABLE events (id TEXT PRIMARY KEY, digest TEXT NOT NULL);
        CREATE TABLE clock (value INTEGER NOT NULL); INSERT INTO clock VALUES (0);
        PRAGMA user_version=1;`,
      pattern: /E_EXPERIENCE_UNKNOWN_DATABASE/,
    },
  ];

  for (const item of cases) {
    const root = scratch();
    forgeDatabase(root, item.sql);
    const before = raw(root, db => ({ version: db.prepare('PRAGMA user_version').get().user_version, tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name) }));
    assert.throws(() => openSharedExperience(root), item.pattern, item.name);
    const after = raw(root, db => ({ version: db.prepare('PRAGMA user_version').get().user_version, tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name) }));
    assert.deepEqual(after, before, `${item.name}: the refused open changed nothing`);
    assert.throws(() => raw(root, db => readSharedExperienceSchema(db)), item.readerPattern ?? item.pattern, `${item.name}: the schema reader refuses too`);
  }
});

test('private store guards: foreign roots/files and a symlinked root are refused', () => {
  // A real store whose directory mode is no longer private.
  const root = scratch();
  const store = openSharedExperience(root);
  store.recordFailure({ id: 'e'.repeat(64), type: 'tool/error', code: 'E_PRIVATE', target: 'editor' });
  store.close();
  fs.chmodSync(root, 0o755);
  try {
    assert.throws(() => openSharedExperience(root), /E_EXPERIENCE_PRIVATE_ROOT/);
  } finally { fs.chmodSync(root, 0o700); }

  // A database file whose own mode is no longer private.
  fs.chmodSync(dbFile(root), 0o644);
  try {
    assert.throws(() => openSharedExperience(root), /E_EXPERIENCE_PRIVATE_FILE/);
  } finally { fs.chmodSync(dbFile(root), 0o600); }

  // A symlinked root is never accepted.
  const realRoot = scratch();
  const linkRoot = path.join(scratch(), 'linked');
  fs.symlinkSync(realRoot, linkRoot);
  assert.throws(() => openSharedExperience(linkRoot), /E_EXPERIENCE_PRIVATE_ROOT/);

  // A symlinked database file is never accepted.
  const linkFileRoot = scratch();
  fs.symlinkSync(dbFile(root), dbFile(linkFileRoot));
  assert.throws(() => openSharedExperience(linkFileRoot), /E_EXPERIENCE_PRIVATE_FILE/);
});

test('read-only inspection: inspect() changes no bytes and creates no backup on v1 or v2', () => {
  const v1Root = scratch();
  const v1 = openSharedExperienceV1Baseline(v1Root);
  try {
    for (let i = 0; i < 5; i += 1) v1.recordFailure({ id: sha256(`inspect-${i}`), type: 'tool/error', code: 'E_INSPECT', target: 'editor' });
  } finally { v1.close(); }

  const v2Root = scratch();
  const v2 = openSharedExperience(v2Root);
  try {
    for (let i = 0; i < 5; i += 1) v2.recordFailure({ id: sha256(`inspect-v2-${i}`), type: 'tool/error', code: 'E_INSPECT', target: 'editor' });
  } finally { v2.close(); }

  // A read-only SQLite open may create or reuse WAL/SHM sidecars; they are not
  // inspection state. The database/backup files themselves must stay identical.
  const mainFiles = root => fileSnapshot(root)
    .filter(entry => !entry.name.endsWith('-wal') && !entry.name.endsWith('-shm'));
  for (const [root, expectedVersion, pending] of [[v1Root, 1, true], [v2Root, 2, false]]) {
    const before = mainFiles(root);
    const first = inspectSharedExperience(root);
    const second = inspectSharedExperience(root);
    const after = mainFiles(root);
    assert.deepEqual(after, before, `schema ${expectedVersion} inspection left the database bytes identical`);
    assert.equal(first.schemaVersion, expectedVersion);
    assert.equal(first.pending, pending);
    assert.equal(first.migrated, expectedVersion === 2);
    assert.equal(first.events, 5);
    assert.equal(first.knowledge, 1);
    assert.equal(fs.existsSync(path.join(root, 'experience.sqlite.v1-backup')), false);
    // The report is stable between two read-only calls.
    assert.deepEqual(second, first);
  }
});

test('empty and uninitialized stores: inspect reports absence, the next open creates schema 2', () => {
  // A missing directory: inspect refuses, migrate reports "missing".
  const missing = path.join(scratch(), 'absent');
  assert.throws(() => inspectSharedExperience(missing), /ENOENT/);
  const missingReport = migrateSharedExperience(missing);
  assert.equal(missingReport.migrated, false);
  assert.equal(missingReport.missing, true);
  assert.equal(missingReport.pending, false);
  assert.equal(missingReport.root, path.resolve(missing));

  // An existing but empty directory: no database yet.
  const emptyRoot = scratch();
  assert.equal(inspectSharedExperience(emptyRoot).present, false);
  const created = openSharedExperience(emptyRoot);
  try {
    assert.equal(created.schemaVersion, 2);
    assert.deepEqual(created.stats(), { events: 0, knowledge: 0 });
  } finally { created.close(); }
  raw(emptyRoot, db => assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2));

  // A private zero-byte database file: inspect reports the uninitialized store,
  // migrate does not initialize it, and the next normal open creates schema 2.
  const zeroRoot = scratch();
  fs.writeFileSync(dbFile(zeroRoot), '');
  fs.chmodSync(dbFile(zeroRoot), 0o600);
  const zeroInfo = inspectSharedExperience(zeroRoot);
  assert.equal(zeroInfo.present, true);
  assert.equal(zeroInfo.empty, true);
  assert.equal(zeroInfo.schemaVersion, 0);
  assert.equal(zeroInfo.migrated, false);
  assert.equal(zeroInfo.pending, false);
  const zeroMigrate = migrateSharedExperience(zeroRoot);
  assert.equal(zeroMigrate.empty, true);
  assert.equal(zeroMigrate.migrated, false);
  assert.equal(fs.statSync(dbFile(zeroRoot)).size, 0, 'migrate does not initialize an empty database');
  const zeroOpened = openSharedExperience(zeroRoot);
  try { assert.equal(zeroOpened.schemaVersion, 2); } finally { zeroOpened.close(); }
});

test('a v2 database is refused by the frozen v1 implementation without modification', () => {
  const root = scratch();
  const store = openSharedExperience(root);
  try { store.recordFailure({ id: '9'.repeat(64), type: 'tool/error', code: 'E_FROZEN', target: 'editor' }); } finally { store.close(); }
  const before = fileSnapshot(root);
  assert.throws(() => openSharedExperienceV1Baseline(root), /E_EXPERIENCE_SCHEMA/);
  assert.deepEqual(fileSnapshot(root), before, 'the refused v1 open left the v2 database byte-identical');
  raw(root, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(eventsOf(db).length, 1);
  });
});

// ---------------------------------------------------------------------------
// cross-process concurrency on schema 2
// ---------------------------------------------------------------------------

function spawnNode(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--max-old-space-size=4096', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ code: null, signal: null, stdout, stderr: String(error?.message || error) }));
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('concurrency: four schema-2 processes append without losing or duplicating facts', async () => {
  const root = scratch();
  const store = openSharedExperience(root);
  store.close();

  const moduleUrl = new URL('../lib/shared-experience.js', import.meta.url).href;
  const childScript = `
import { openSharedExperience } from ${JSON.stringify(moduleUrl)};
const root = process.argv[1];
const prefix = process.argv[2];
const count = Number(process.argv[3]);
const store = openSharedExperience(root);
if (store.schemaVersion !== 2) { store.close(); throw new Error('unexpected schema ' + store.schemaVersion); }
let duplicates = 0;
for (let i = 0; i < count; i += 1) {
  const id = (prefix + i.toString(16).padStart(6, '0')).padEnd(64, '0');
  const result = store.recordFailure({ id, type: 'tool/error', code: 'E_SHARED_FACT', target: 'editor' });
  if (result.duplicate) duplicates += 1;
}
const shared = store.recordFailure({ id: 'f'.repeat(64), type: 'tool/error', code: 'E_CONTENDED', target: 'editor' });
store.close();
process.stdout.write(JSON.stringify({ duplicates, shared: shared.duplicate }));
`;
  const perProcess = 30;
  const runs = await Promise.all(['a', 'b', 'c', 'd'].map(prefix => spawnNode(['--input-type=module', '-e', childScript, root, prefix, String(perProcess)])));
  for (const run of runs) {
    assert.equal(run.code, 0, `child failed: ${run.stderr}`);
    const parsed = JSON.parse(run.stdout);
    assert.equal(parsed.duplicates, 0, 'each process writes its own distinct facts once');
  }
  const committed = runs.filter(run => JSON.parse(run.stdout).shared === false);
  const replayed = runs.filter(run => JSON.parse(run.stdout).shared === true);
  assert.equal(committed.length, 1, 'exactly one process commits the contended fact');
  assert.equal(replayed.length, 3, 'the other processes observe it as a duplicate');

  raw(root, db => {
    const events = eventsOf(db);
    assert.equal(events.length, perProcess * runs.length + 1);
    for (const row of events) {
      assert.equal(row.idType, 'blob');
      assert.equal(Number(row.idBytes), 32);
      assert.equal(Number(row.digestBytes), 32);
    }
    const rows = knowledgeOf(db).map(row => JSON.parse(row.body));
    assert.equal(rows.length, 2);
    const occurrences = rows.reduce((sum, entry) => sum + entry.occurrenceCount, 0);
    assert.equal(occurrences, perProcess * runs.length + 1);
    assert.deepEqual(rows.map(entry => entry.occurrenceCount).sort((a, b) => a - b), [1, perProcess * runs.length]);
  });
});
