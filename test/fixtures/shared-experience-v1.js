/**
 * Frozen schema-1 storage baseline for tests.
 *
 * This is the pre-v2 `lib/shared-experience.js` open/create/record logic copied
 * verbatim in behavior (schema 1: `events (id TEXT PRIMARY KEY, digest TEXT)`,
 * `PRAGMA user_version=1`, WAL + synchronous=FULL). It exists so tests can build
 * a genuine legacy database, compare the new schema-1 compatibility mode
 * against the original algorithm, and simulate a still-running old-version
 * plugin process that opens the same file.
 *
 * Do not update this file to follow the runtime: its value is being frozen.
 * Production code never imports it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { normalizeKnowledgeEvent, mergeKnowledgeEntry } from '../../lib/dockyard-domain/knowledge.js';

const require = createRequire(import.meta.url);
const digest = value => createHash('sha256').update(value).digest('hex');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value) ? value : null;
const failureCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : 'HOST_OPERATION_FAILED';

/** The exact schema statement pair the v0.2.4 runtime executed. */
export const V1_SCHEMA_SQL = `CREATE TABLE events (id TEXT PRIMARY KEY, digest TEXT NOT NULL);
          CREATE TABLE knowledge (key TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL);
          CREATE INDEX knowledge_recent ON knowledge(revision);
          CREATE TABLE clock (value INTEGER NOT NULL); INSERT INTO clock VALUES (0);
          PRAGMA user_version=1;`;

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
    db.exec('BEGIN');
    const initialVersion = db.prepare('PRAGMA user_version').get().user_version;
    const initialTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
    if (initialVersion !== 0 && initialVersion !== 1) throw new Error('E_EXPERIENCE_SCHEMA');
    if ((initialVersion === 0 && initialTables.length)
      || (initialVersion === 1 && initialTables.join(',') !== 'clock,events,knowledge')) throw new Error('E_EXPERIENCE_UNKNOWN_DATABASE');
    db.exec('COMMIT');
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
      db.exec('PRAGMA busy_timeout=2000; BEGIN IMMEDIATE');
      try {
        const version = db.prepare('PRAGMA user_version').get().user_version;
        if (version !== 0 && version !== 1) throw new Error('E_EXPERIENCE_SCHEMA');
        if (version === 0) {
          if (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length) throw new Error('E_EXPERIENCE_UNKNOWN_DATABASE');
          db.exec(V1_SCHEMA_SQL);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    db.exec('PRAGMA busy_timeout=2000');
  } catch (error) { db.close(); throw error; }
  const assertOpen = () => { if (closed) throw new Error('E_EXPERIENCE_CLOSED'); };
  function record(id, input, sourceCollection, order) {
    assertOpen();
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('E_EXPERIENCE_EVENT_ID');
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
