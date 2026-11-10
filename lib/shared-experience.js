import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { normalizeKnowledgeEvent, mergeKnowledgeEntry } from './dockyard-domain/knowledge.js';
import { collectKnowledgeExperience, buildExperienceQuery, EXPERIENCE_RECALL_LIMITS } from './experience-recall.js';

const require = createRequire(import.meta.url);
const digest = value => createHash('sha256').update(value).digest('hex');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value) ? value : null;
const failureCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : 'HOST_OPERATION_FAILED';

/** New experience only. Never opens or migrates a legacy Evolution data root.
 * SQLite owns cross-process isolation and crash recovery; no JS snapshot is
 * authoritative. Event identity and canonical accumulation commit together.
 * Local filesystems and processes belonging to the same OS user are supported.
 */
export function openSharedExperience(root) {
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
    db.exec('PRAGMA busy_timeout=250');
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
    recordFailure({ id, type, code, target }) {
      const safeCode = failureCode(code);
      const safeTarget = identifier(target) || 'host';
      return record(id, { type: type === 'agent/error' ? 'agent/error' : 'tool/error',
        code: safeCode, componentId: safeTarget, severity: 'error', status: 'failed',
        message: `Official operation failed (${safeCode})` }, 'observations');
    },
    // Called by the core after its authenticated event has been committed,
    // never by an untrusted global-event listener. A completed tool/Trial is
    // deliberately not promoted to a successful solution here.
    recordEvolution(event, origin, receipt) {
      if (!['promotion-succeeded', 'promotion-reverted', 'canary-passed', 'canary-failed', 'failure-learned'].includes(event?.eventType)) return { ignored: true };
      const target = identifier(event.target);
      if (!target || typeof event.eventId !== 'string' || event.eventId.length > 512) return { ignored: true };
      if (event.eventType === 'promotion-reverted' && (event.promotion?.adapter !== 'official-include'
        || typeof event.promotion.rowId !== 'string' || !event.promotion.rowId)) return { ignored: true };
      const order = Number.isSafeInteger(receipt?.sequence) && receipt.sequence > 0 && typeof receipt.writer === 'string'
        ? { source: digest(JSON.stringify([origin, receipt.writer])), sequence: receipt.sequence } : undefined;
      if (!order) return { ignored: true, reason: 'unsequenced-fact' };
      const status = ['promotion-succeeded', 'canary-passed'].includes(event.eventType) ? 'success' : 'failed';
      return record(digest(`${origin}\0${event.eventId}`), {
        problem: target, capabilityId: target, target,
        status, regression: ['promotion-reverted', 'canary-failed'].includes(event.eventType),
        // Promotion/canary outcomes for a target share an identity, so a
        // rollback demotes its previous successful fact instead of leaving a
        // stale KNOWN row next to an unrelated failure row.
        failureMode: event.eventType === 'failure-learned' ? 'experiment-failed' : undefined,
        ...(typeof event.audit?.at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(event.audit.at)
          && Number.isFinite(Date.parse(event.audit.at)) ? { recordedAt: event.audit.at } : {}),
      }, 'promotions', order);
    },
    recall(input = {}, options = {}) {
      assertOpen();
      // One read transaction keeps the bounded window and exact-key lookup on
      // the same committed snapshot while another host is appending.
      db.exec('BEGIN');
      try {
        const query = buildExperienceQuery(input);
        const rows = db.prepare('SELECT key,body FROM knowledge ORDER BY revision DESC LIMIT ?')
          .all(EXPERIENCE_RECALL_LIMITS.maxConsidered).reverse();
        if (query.knowledgeKey && !rows.some(row => row.key === query.knowledgeKey)) {
          const exact = db.prepare('SELECT key,body FROM knowledge WHERE key=?').get(query.knowledgeKey);
          if (exact) rows.unshift(exact);
        }
        const result = collectKnowledgeExperience(rows.map(row => JSON.parse(row.body)), input, options);
        db.exec('COMMIT');
        return { ...result, source: 'shared-knowledge' };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    stats() {
      assertOpen();
      return { events: db.prepare('SELECT count(*) AS n FROM events').get().n,
        knowledge: db.prepare('SELECT count(*) AS n FROM knowledge').get().n };
    },
    close() { if (!closed) { db.close(); closed = true; } },
  });
}

export function experienceEventId(...parts) { return digest(JSON.stringify(parts)); }
