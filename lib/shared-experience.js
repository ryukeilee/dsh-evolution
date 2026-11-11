import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { normalizeKnowledgeEvent, mergeKnowledgeEntry } from './dockyard-domain/knowledge.js';
import { collectKnowledgeExperience, buildExperienceQuery, knowledgeExperienceRecord, EXPERIENCE_RECALL_LIMITS } from './experience-recall.js';
// Pure, I/O-free planner helpers. `experience-plan.js` imports only
// `node:crypto`, so sharing its conclusion-strategy parser keeps one definition
// of the stored strategy shape without adding an import cycle.
import { parseConclusionStrategy } from './experience-plan.js';

const require = createRequire(import.meta.url);
const digest = value => createHash('sha256').update(value).digest('hex');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value) ? value : null;
const failureCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : 'HOST_OPERATION_FAILED';

// --- On-disk schema ---------------------------------------------------------
// Schema 2 keeps the identical permanent ledger (`events` is still the full
// SHA-256 identity of every distinct fact), but stores the two 64-character
// hex columns as the equivalent 32-byte BLOBs in a STRICT WITHOUT ROWID table.
// The primary key is the table btree itself, so a ledger row no longer pays for
// a rowid plus a separate 64-character unique index entry.
export const EXPERIENCE_SCHEMA_VERSION = 2;
export const EXPERIENCE_LEGACY_SCHEMA_VERSION = 1;
const EXPERIENCE_TABLE_NAMES = 'clock,events,knowledge';
const EXPERIENCE_HEX64 = /^[a-f0-9]{64}$/;

const foreignOwner = value => value && process.getuid ? value.uid !== process.getuid() : false;

/** Resolve the private store directory (created by the runtime) and file path. */
export function sharedExperienceLocation(root, { create = true } = {}) {
  root = path.resolve(root);
  if (create) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = fs.lstatSync(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077)
    || foreignOwner(directory)) throw new Error('E_EXPERIENCE_PRIVATE_ROOT');
  return { root, file: path.join(root, 'experience.sqlite') };
}

/** Refuse a store file that is not a private, unlinked regular file. */
export function assertPrivateExperienceFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)
    || foreignOwner(stat)) throw new Error('E_EXPERIENCE_PRIVATE_FILE');
}

function experienceTableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
}

// The declared SQL is the authoritative shape check: `table_info` alone cannot
// tell a WITHOUT ROWID table from a rowid table, and a version-tagged database
// whose events table is not the expected BLOB shape must not be written with
// BLOB binds (SQLite would accept the bind but the identity round trip would
// silently change). Do not rely on implicit type conversion here.
function assertExperienceV2Shape(db) {
  const columns = db.prepare('PRAGMA table_info(events)').all().map(row => ({
    name: row.name, type: String(row.type || '').toUpperCase(), notnull: row.notnull, pk: row.pk,
  }));
  const shapeOk = columns.length === 2
    // A WITHOUT ROWID primary key is implicitly NOT NULL, so `table_info`
    // reports the effective constraint rather than the declared one; only the
    // digest column's declared NOT NULL is part of this check.
    && columns[0].name === 'id' && columns[0].type === 'BLOB' && columns[0].pk === 1
    && columns[1].name === 'digest' && columns[1].type === 'BLOB' && columns[1].notnull === 1 && columns[1].pk === 0;
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='events'").get()?.sql || '';
  const lengthOk = /CHECK\s*\(\s*length\(id\)\s*=\s*32\s+AND\s+length\(digest\)\s*=\s*32\s*\)/i.test(sql);
  if (!shapeOk || !lengthOk || !/\bSTRICT\b/i.test(sql) || !/WITHOUT\s+ROWID/i.test(sql)) throw new Error('E_EXPERIENCE_UNKNOWN_DATABASE');
}

/** Read a database's version after validating its table shape; no writes. */
export function readSharedExperienceSchema(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (![EXPERIENCE_LEGACY_SCHEMA_VERSION, EXPERIENCE_SCHEMA_VERSION].includes(version)) throw new Error('E_EXPERIENCE_SCHEMA');
  if (experienceTableNames(db).join(',') !== EXPERIENCE_TABLE_NAMES) throw new Error('E_EXPERIENCE_UNKNOWN_DATABASE');
  if (version === EXPERIENCE_SCHEMA_VERSION) assertExperienceV2Shape(db);
  return version;
}

// --- Structured experiment conclusions (additive; schema v1 unchanged) ------
// A conclusion is an ordinary knowledge event in the existing `events` /
// `knowledge` tables: same ledger, same merge, same BEGIN IMMEDIATE transaction.
// No table, column, index or user_version change is involved, so an existing
// database keeps opening with the exact shape check above.
const CONCLUSION_DECISIONS = Object.freeze(['adopted', 'reverted-unconfirmed', 'no-benefit', 'regression', 'insufficient-evidence']);
const CONCLUSION_DECISION_SET = new Set(CONCLUSION_DECISIONS);
const CONCLUSION_EXPERIMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CONCLUSION_FINGERPRINT = /^[a-f0-9]{8,32}$/;
const CONCLUSION_CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const CONCLUSION_STRATEGY_BOUND = 160;
const CONCLUSION_ROOT_CAUSE_BOUND = 200;
const CONCLUSION_FAILURE_MODE_BOUND = 160;
const CONCLUSION_APPLICABILITY_BOUND = 64;
// A conclusion target is a problem identity, not a host identifier: experience
// discovery hands over the normalized `scope` (`tool:probe_healthcheck` becomes
// `tool probe healthcheck`), so spaces and the other normalized forms are
// legitimate here and must survive the round trip through findConclusions().
const CONCLUSION_TARGET_BOUND = 128;
const CONCLUSION_METRICS_LIMIT = 8;
// `knowledge.js` bounds an object-valued `strategy` dimension to this many
// characters before the identity hash (boundedIdentityText(..., 360)); a longer
// object would be cut with a digest suffix and would no longer be JSON, so the
// conclusion event keeps its own serialization inside the same bound.
const CONCLUSION_STRATEGY_JSON_BOUND = 360;
const CONCLUSION_SCAN_MAX = 2000;
const CONCLUSION_SCAN_DEFAULT = 500;
const CONCLUSION_DISCOVERY_TEXT = 400;

/** A bounded, control-character-free conclusion text; non-strings are ignored. */
function conclusionText(value, limit) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return '';
  const text = String(value).normalize('NFKC').replace(CONCLUSION_CONTROL, ' ').trim();
  return text.length <= limit ? text : text.slice(0, Math.max(0, limit - 1)) + '…';
}

/** One applicability version; `unknown` is the absence of a claim, not a value. */
function conclusionVersion(value) {
  const text = conclusionText(value, CONCLUSION_APPLICABILITY_BOUND);
  if (!text || text.toLowerCase() === 'unknown') return 'unknown';
  return text;
}

function conclusionKnownVersion(value) {
  return typeof value === 'string' && value !== '' && value.toLowerCase() !== 'unknown';
}

/**
 * The six-key strategy object a conclusion stores. Object-valued dimensions are
 * serialized with sorted keys and no digit normalization, so the versions and
 * the fingerprint survive the identity projection verbatim. The approach is
 * shortened only when the serialized object would cross the dimension bound
 * (pathological 64-character versions), which keeps the stored value parseable.
 */
function conclusionStrategyObject({ approach, fingerprint, dsh, cordis, evolution }) {
  const value = { approach, cordis, dsh, evolution, fingerprint, kind: 'cordis-plugin' };
  let serialized = JSON.stringify(value);
  let keep = approach.length;
  while (serialized.length > CONCLUSION_STRATEGY_JSON_BOUND && keep > 0) {
    keep = Math.max(0, keep - 8);
    value.approach = approach.slice(0, keep);
    serialized = JSON.stringify(value);
  }
  return value;
}

/** Finite numeric metrics only, at most `CONCLUSION_METRICS_LIMIT` own keys. */
function conclusionMetrics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = [];
  for (const key of Object.keys(value)) {
    if (entries.length >= CONCLUSION_METRICS_LIMIT) break;
    const name = conclusionText(key, 64).toLowerCase().replace(/\s+/g, '-');
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(name)) continue;
    const number = value[key];
    if (typeof number !== 'number' || !Number.isFinite(number)) continue;
    entries.push([name, number]);
  }
  return Object.fromEntries(entries);
}

/** Clamp a caller-supplied scan window; it can only narrow, never widen. */
function conclusionWindow(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return CONCLUSION_SCAN_DEFAULT;
  return Math.min(Math.floor(number), CONCLUSION_SCAN_MAX);
}

/**
 * The normalized `scope` dimension a write of `target` produces. The write path
 * normalizes the target (`plugin:edge-cache` becomes `plugin edge-cache`), so a
 * read cannot compare the stored scope with the caller's raw target string.
 */
function conclusionScopeOf(target) {
  return normalizeKnowledgeEvent({ problem: target, capabilityId: target }, { sourceCollection: 'learnings' })?.scope ?? null;
}

const CONCLUSION_DECISION_RANK = new Map([
  ['regression', 0], ['no-benefit', 1], ['reverted-unconfirmed', 2], ['adopted', 3], ['insufficient-evidence', 4],
]);

/**
 * Deterministic relevance order for conclusion matches: an exact-applicability
 * row first, then the strongest negative verdict, then the most recent, then
 * the canonical key so the output never depends on the read order.
 */
function compareConclusionMatches(left, right) {
  const same = Number(Boolean(right.sameApplicability)) - Number(Boolean(left.sameApplicability));
  if (same !== 0) return same;
  const rank = (CONCLUSION_DECISION_RANK.get(left.decision) ?? 9) - (CONCLUSION_DECISION_RANK.get(right.decision) ?? 9);
  if (rank !== 0) return rank;
  const recency = Date.parse(String(right.lastSeen ?? '')) - Date.parse(String(left.lastSeen ?? ''));
  if (Number.isFinite(recency) && recency !== 0) return recency;
  return left.knowledgeKey < right.knowledgeKey ? -1 : left.knowledgeKey > right.knowledgeKey ? 1 : 0;
}

/** New experience only. Never opens or migrates a legacy Evolution data root.
 * SQLite owns cross-process isolation and crash recovery; no JS snapshot is
 * authoritative. Event identity and canonical accumulation commit together.
 * Local filesystems and processes belonging to the same OS user are supported.
 *
 * A schema 1 database stays readable and writable in its original TEXT layout:
 * normal startup never migrates storage. Converting to schema 2 is an explicit
 * one-time offline operator command (`scripts/migrate-experience-store.mjs`),
 * so opening the store cannot silently rewrite a ledger shared by Desktop, ACP
 * and Web. A schema 1 opener never writes BLOB ids, and its TEXT inserts are
 * rejected by the STRICT schema 2 table if it races a completed conversion, so
 * the two layouts cannot be mixed inside one ledger.
 */
export function openSharedExperience(root) {
  const { file } = sharedExperienceLocation(root);
  try { fs.closeSync(fs.openSync(file, 'wx', 0o600)); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  assertPrivateExperienceFile(file);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  let closed = false;
  let schemaVersion;
  try {
    db.exec('PRAGMA busy_timeout=250');
    // Refuse a foreign database before changing its journal mode.
    db.exec('BEGIN');
    const initialVersion = db.prepare('PRAGMA user_version').get().user_version;
    const initialTables = experienceTableNames(db);
    if (![0, EXPERIENCE_LEGACY_SCHEMA_VERSION, EXPERIENCE_SCHEMA_VERSION].includes(initialVersion)) {
      throw new Error('E_EXPERIENCE_SCHEMA');
    }
    if (initialVersion === 0) {
      if (initialTables.length) throw new Error('E_EXPERIENCE_UNKNOWN_DATABASE');
    } else {
      if (initialTables.join(',') !== EXPERIENCE_TABLE_NAMES) throw new Error('E_EXPERIENCE_UNKNOWN_DATABASE');
      if (initialVersion === EXPERIENCE_SCHEMA_VERSION) assertExperienceV2Shape(db);
    }
    db.exec('COMMIT');
    schemaVersion = initialVersion;
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
      if (![0, EXPERIENCE_LEGACY_SCHEMA_VERSION, EXPERIENCE_SCHEMA_VERSION].includes(version)) throw new Error('E_EXPERIENCE_SCHEMA');
      if (version === 0) {
        if (experienceTableNames(db).length) throw new Error('E_EXPERIENCE_UNKNOWN_DATABASE');
        db.exec(`CREATE TABLE events (id BLOB PRIMARY KEY, digest BLOB NOT NULL, CHECK (length(id) = 32 AND length(digest) = 32)) STRICT, WITHOUT ROWID;
          CREATE TABLE knowledge (key TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL);
          CREATE INDEX knowledge_recent ON knowledge(revision);
          CREATE TABLE clock (value INTEGER NOT NULL); INSERT INTO clock VALUES (0);
          PRAGMA user_version=${EXPERIENCE_SCHEMA_VERSION};`);
        schemaVersion = EXPERIENCE_SCHEMA_VERSION;
      } else {
        // Another opener created the store between the read and this write
        // transaction. Adopt the schema it committed (an older plugin creates
        // schema 1) instead of overwriting it.
        if (experienceTableNames(db).join(',') !== EXPERIENCE_TABLE_NAMES) throw new Error('E_EXPERIENCE_UNKNOWN_DATABASE');
        if (version === EXPERIENCE_SCHEMA_VERSION) assertExperienceV2Shape(db);
        schemaVersion = version;
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
  // Schema 1 keeps the original TEXT representation byte for byte, so an older
  // plugin process still interoperates on the same database. Schema 2 binds the
  // same SHA-256 bytes as 32-byte BLOBs; no truncation, no implicit conversion.
  const legacyTextEvents = schemaVersion === EXPERIENCE_LEGACY_SCHEMA_VERSION;
  function record(id, input, sourceCollection, order) {
    assertOpen();
    if (typeof id !== 'string' || !EXPERIENCE_HEX64.test(id)) throw new Error('E_EXPERIENCE_EVENT_ID');
    // Only the projected semantic content participates in conflict detection;
    // a transport replay may arrive at a different wall-clock time.
    const contentDigest = digest(JSON.stringify(input));
    const idValue = legacyTextEvents ? id : Buffer.from(id, 'hex');
    const digestValue = legacyTextEvents ? contentDigest : Buffer.from(contentDigest, 'hex');
    db.exec('BEGIN IMMEDIATE');
    try {
      const prior = db.prepare('SELECT digest FROM events WHERE id=?').get(idValue);
      if (prior) {
        const same = legacyTextEvents ? prior.digest === contentDigest : Buffer.compare(prior.digest, digestValue) === 0;
        if (!same) throw new Error('E_EXPERIENCE_EVENT_CONFLICT');
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
      db.prepare('INSERT INTO events VALUES (?,?)').run(idValue, digestValue);
      db.exec('UPDATE clock SET value=value+1');
      db.prepare('INSERT INTO knowledge VALUES (?,?,(SELECT value FROM clock)) ON CONFLICT(key) DO UPDATE SET body=excluded.body, revision=excluded.revision')
        .run(event.knowledgeKey, JSON.stringify(next));
      db.exec('COMMIT');
      return { committed: true, duplicate: false, knowledgeKey: event.knowledgeKey };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return Object.freeze({
    schemaVersion,
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
    /**
     * Record one structured experiment conclusion as canonical knowledge.
     *
     * This calls the same private `record()` as every other fact, so it shares
     * the event ledger, the content digest, the BEGIN IMMEDIATE transaction and
     * the canonical merge; nothing about the on-disk schema changes. The fact is
     * built here from validated scalar values and never from the caller's
     * object, so hostile extra fields cannot reach storage.
     *
     * Identity: `issueType` is the literal `experiment-conclusion` (via `type`)
     * while promotion/canary facts are recorded under `problem`, so the two
     * fact families never share a `knowledgeKey` and cannot demote each other.
     * Within the conclusion family the six dimensions are the target scope, the
     * problem semantic fact, the strategy object and the root cause, so an
     * identical (problem, strategy, root cause, versions) conclusion merges with
     * the earlier one: a later `no-benefit`/`regression` verdict demotes a
     * previous `adopted` success (knowledge.js `mergeKnowledgeEntry` regression
     * rule), which is exactly the correction this fact is for.
     */
    recordConclusion(input = {}, origin, receipt) {
      assertOpen();
      const experimentId = typeof input?.experimentId === 'string' && CONCLUSION_EXPERIMENT_ID.test(input.experimentId)
        ? input.experimentId : null;
      if (!experimentId) throw new Error('E_EXPERIENCE_CONCLUSION_EXPERIMENT');
      const decision = CONCLUSION_DECISION_SET.has(input?.decision) ? input.decision : null;
      if (!decision) throw new Error('E_EXPERIENCE_CONCLUSION_DECISION');
      const fingerprint = typeof input?.strategyFingerprint === 'string' && CONCLUSION_FINGERPRINT.test(input.strategyFingerprint)
        ? input.strategyFingerprint : null;
      if (!fingerprint) throw new Error('E_EXPERIENCE_CONCLUSION_FINGERPRINT');
      const occurredAt = typeof input?.occurredAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(input.occurredAt)
        && Number.isFinite(Date.parse(input.occurredAt)) ? new Date(input.occurredAt).toISOString() : null;
      if (!occurredAt) throw new Error('E_EXPERIENCE_CONCLUSION_TIME');
      const target = typeof input?.target === 'string'
        ? (conclusionText(input.target, CONCLUSION_TARGET_BOUND) || 'host') : 'host';
      const approach = conclusionText(input?.strategy, CONCLUSION_STRATEGY_BOUND);
      if (!approach) throw new Error('E_EXPERIENCE_CONCLUSION_STRATEGY');
      const rootCause = conclusionText(input?.rootCause, CONCLUSION_ROOT_CAUSE_BOUND);
      const failureMode = conclusionText(input?.failureMode, CONCLUSION_FAILURE_MODE_BOUND);
      const applicability = input?.applicability && typeof input.applicability === 'object' ? input.applicability : {};
      const dsh = conclusionVersion(applicability.dsh);
      const cordis = conclusionVersion(applicability.cordis);
      const evolution = conclusionVersion(applicability.evolution);
      const strategy = conclusionStrategyObject({ approach, fingerprint, dsh, cordis, evolution });
      const metrics = conclusionMetrics(input?.metrics);
      const versionKey = `${dsh}|${cordis}|${evolution}`;
      const eventId = experienceEventId('conclusion', String(origin), experimentId, decision, versionKey);
      // A receipt is optional: when the caller has one, the same source/sequence
      // ordering the promotion facts use keeps a late backfill from replacing a
      // newer production verdict.
      const order = Number.isSafeInteger(receipt?.sequence) && receipt.sequence > 0 && typeof receipt.writer === 'string'
        ? { source: digest(JSON.stringify([origin, receipt.writer])), sequence: receipt.sequence } : undefined;
      // The outcome is explicit: `status: 'adopted'` alone is a neutral status
      // (knowledge.js `SUCCESS_STATES` has no `adopted`), and the two
      // unconfirmed/insufficient verdicts must not demote a recorded success.
      const outcome = decision === 'adopted' ? { success: true }
        : decision === 'no-benefit' ? { success: false }
          : decision === 'regression' ? { regression: true } : {};
      const event = {
        type: 'experiment-conclusion',
        // The scope stays the plain target: recall matches on this text, and
        // versions live in the strategy object where digits survive.
        capabilityId: target,
        semanticFact: target,
        scope: target,
        strategy,
        status: decision,
        recordedAt: occurredAt,
        ...(rootCause ? { rootCause } : {}),
        ...(failureMode ? { failureMode } : {}),
        ...(Object.keys(metrics).length ? { metrics } : {}),
        ...outcome,
      };
      const result = record(eventId, event, 'learnings', order);
      const knowledgeKey = result.knowledgeKey
        ?? normalizeKnowledgeEvent({ ...event, eventId }, { sourceCollection: 'learnings' })?.knowledgeKey ?? null;
      return { committed: result.committed, duplicate: result.duplicate, knowledgeKey };
    },
    /**
     * Read back the recorded conclusions for one target, bounded to the newest
     * `window` canonical rows (never more than `CONCLUSION_SCAN_MAX`).
     *
     * `sameApplicability` is true only when the caller supplies all three
     * versions and they equal the recorded ones; `unknown` is an absent claim
     * and never equals anything. `best` is the first match in the deterministic
     * relevance order (exact applicability, strongest negative verdict, newest,
     * canonical key), so "is this strategy already known to be ineffective
     * under these versions" is a single comparison.
     */
    findConclusions(input = {}) {
      assertOpen();
      const target = typeof input?.target === 'string' && input.target ? input.target : null;
      if (!target) throw new Error('E_EXPERIENCE_CONCLUSION_TARGET');
      let fingerprint = null;
      if (input.strategyFingerprint !== undefined && input.strategyFingerprint !== null) {
        if (typeof input.strategyFingerprint !== 'string' || !CONCLUSION_FINGERPRINT.test(input.strategyFingerprint)) {
          throw new Error('E_EXPERIENCE_CONCLUSION_FINGERPRINT');
        }
        fingerprint = input.strategyFingerprint;
      }
      // The read side applies the same target bound as the write side, so a
      // target the write truncated still resolves to the same scope here.
      const scope = conclusionScopeOf(conclusionText(target, CONCLUSION_TARGET_BOUND) || 'host');
      const applicability = input?.applicability && typeof input.applicability === 'object' ? {
        dsh: conclusionVersion(input.applicability.dsh),
        cordis: conclusionVersion(input.applicability.cordis),
        evolution: conclusionVersion(input.applicability.evolution),
      } : null;
      const callerKnown = Boolean(applicability
        && conclusionKnownVersion(applicability.dsh)
        && conclusionKnownVersion(applicability.cordis)
        && conclusionKnownVersion(applicability.evolution));
      const window = conclusionWindow(input?.window);
      db.exec('BEGIN');
      try {
        // A conclusion's identity is (target scope, strategy, root cause,
        // versions), and the canonical body always carries its `scope` field.
        // Filtering by that scope in SQLite is what keeps the bounded window
        // from being crowded out by unrelated knowledge: scanning the newest
        // `window` rows globally used to hide an already-proven-ineffective
        // target as soon as enough unrelated failures had been recorded, and
        // the proposal gate then treated the strategy as new. The full table is
        // still traversed by `instr` (no scope index exists), but only this
        // scope's rows are materialized and parsed.
        const scopeMarker = `"scope":${JSON.stringify(scope)}`;
        const scanned = db.prepare('SELECT count(*) AS n FROM knowledge').get().n;
        const scoped = db.prepare('SELECT count(*) AS n FROM knowledge WHERE instr(body, ?) > 0').get(scopeMarker).n;
        const rows = db.prepare('SELECT key,body FROM knowledge WHERE instr(body, ?) > 0 ORDER BY revision DESC LIMIT ?')
          .all(scopeMarker, window).reverse();
        const matches = [];
        for (const row of rows) {
          let entry;
          try { entry = JSON.parse(row.body); } catch { continue; }
          if (!entry || entry.scope !== scope) continue;
          const conclusion = parseConclusionStrategy(entry.strategy);
          if (!conclusion) continue;
          if (fingerprint && conclusion.fingerprint !== fingerprint) continue;
          const recorded = { dsh: conclusion.dsh, cordis: conclusion.cordis, evolution: conclusion.evolution };
          const sameApplicability = Boolean(callerKnown
            && recorded.dsh === applicability.dsh
            && recorded.cordis === applicability.cordis
            && recorded.evolution === applicability.evolution);
          matches.push({
            knowledgeKey: typeof entry.knowledgeKey === 'string' ? entry.knowledgeKey : row.key,
            decision: typeof entry.lastStatus === 'string' ? entry.lastStatus : '',
            outcome: typeof entry.lastOutcome === 'string' ? entry.lastOutcome : '',
            state: typeof entry.state === 'string' ? entry.state : '',
            regressionCount: Number.isFinite(Number(entry.regressionCount)) ? Number(entry.regressionCount) : 0,
            count: Number.isFinite(Number(entry.occurrenceCount ?? entry.count)) ? Number(entry.occurrenceCount ?? entry.count) : 0,
            applicability: recorded,
            sameApplicability,
            lastSeen: typeof entry.lastSeen === 'string' ? entry.lastSeen : null,
          });
        }
        matches.sort(compareConclusionMatches);
        db.exec('COMMIT');
        return {
          source: 'shared-knowledge',
          scanned,
          considered: rows.length,
          // Truncation now means "this target has more conclusions than the
          // window", not "the store grew": the caller is never told a scoped
          // answer is complete when it is not.
          truncated: scoped > rows.length,
          matches,
          best: matches[0] ?? null,
        };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    /**
     * Bounded discovery read: the newest canonical rows projected into bounded
     * experience records (the same projection recall uses), with the text bound
     * widened to 400 so a stored conclusion strategy stays parseable JSON.
     * Order is the store's revision order (oldest of the window first), and
     * `truncated` reports rows the window did not include instead of letting
     * them look absent.
     */
    discover(options = {}) {
      assertOpen();
      const window = conclusionWindow(options?.window);
      db.exec('BEGIN');
      try {
        const scanned = db.prepare('SELECT count(*) AS n FROM knowledge').get().n;
        const rows = db.prepare('SELECT key,body FROM knowledge ORDER BY revision DESC LIMIT ?').all(window).reverse();
        const records = [];
        for (const row of rows) {
          let entry;
          try { entry = JSON.parse(row.body); } catch { continue; }
          const record = knowledgeExperienceRecord(entry, { maxText: CONCLUSION_DISCOVERY_TEXT, maxEvidenceRefs: 3 });
          if (record) records.push(record);
        }
        db.exec('COMMIT');
        return { source: 'shared-knowledge', records, considered: rows.length, count: scanned, truncated: scanned > rows.length };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
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
