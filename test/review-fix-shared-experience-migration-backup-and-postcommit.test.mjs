import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  EXPERIENCE_LEGACY_SCHEMA_VERSION,
  EXPERIENCE_SCHEMA_VERSION,
  experienceEventId,
  openSharedExperience,
} from '../lib/shared-experience.js';
import {
  migrateSharedExperience,
  verifyCommittedExperienceStore,
} from '../lib/shared-experience-migration.js';
import { openSharedExperienceV1Baseline } from './fixtures/shared-experience-v1.js';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-experience-review-fix-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const databaseFile = root => path.join(root, 'experience.sqlite');
const backupFile = root => `${databaseFile(root)}.v1-backup`;
const failure = n => ({ id: experienceEventId('review-fix', n), type: 'tool/error', code: 'ENOENT', target: 'tool:read_file' });
const sha256 = value => createHash('sha256').update(value).digest('hex');

function readOnly(file) {
  return new DatabaseSync(file, { readOnly: true });
}

function rawState(file) {
  const db = readOnly(file);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
    return {
      version: db.prepare('PRAGMA user_version').get().user_version,
      tables,
      events: tables.includes('events') ? db.prepare('SELECT count(*) AS n FROM events').get().n : null,
      integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
    };
  } finally { db.close(); }
}

/** A schema 1 store built directly with SQL, so a test can afford a large ledger. */
function buildLargeLegacyStore(root, count) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const file = databaseFile(root);
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(`CREATE TABLE events (id TEXT PRIMARY KEY, digest TEXT NOT NULL);
      CREATE TABLE knowledge (key TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE INDEX knowledge_recent ON knowledge(revision);
      CREATE TABLE clock (value INTEGER NOT NULL); INSERT INTO clock VALUES (0);
      PRAGMA user_version=${EXPERIENCE_LEGACY_SCHEMA_VERSION};`);
    db.exec('BEGIN IMMEDIATE');
    const insert = db.prepare('INSERT INTO events VALUES (?,?)');
    for (let n = 0; n < count; n += 1) insert.run(sha256(`legacy-id-${n}`), sha256(`legacy-digest-${n}`));
    db.exec('COMMIT');
  } finally { db.close(); }
  fs.chmodSync(file, 0o600);
}

test('a backup path that is a hard link to the live database is refused, not "reused"', t => {
  const root = temporary(t);
  const seed = openSharedExperienceV1Baseline(root);
  for (let n = 0; n < 4; n += 1) seed.recordFailure(failure(n));
  seed.close();
  const file = databaseFile(root);
  fs.linkSync(file, backupFile(root));
  const live = fs.statSync(file);
  const backup = fs.statSync(backupFile(root));
  assert.equal(backup.ino, live.ino, 'the fixture must be a real hard link');

  assert.throws(() => migrateSharedExperience(root), /E_EXPERIENCE_MIGRATION_BACKUP/);
  // Nothing was converted and the hard-linked "backup" is still a schema 1 row set.
  const state = rawState(file);
  assert.equal(state.version, EXPERIENCE_LEGACY_SCHEMA_VERSION);
  assert.equal(state.tables.includes('events_next'), false);
  assert.equal(rawState(backupFile(root)).version, EXPERIENCE_LEGACY_SCHEMA_VERSION);
  assert.equal(rawState(backupFile(root)).integrity, 'ok');
});

test('a custom backup path that is a hard link to the live database is refused too', t => {
  const root = temporary(t);
  const seed = openSharedExperienceV1Baseline(root);
  seed.recordFailure(failure(1));
  seed.close();
  const file = databaseFile(root);
  const custom = path.join(root, 'custom-backup.sqlite');
  fs.linkSync(file, custom);
  assert.throws(() => migrateSharedExperience(root, { backup: custom }), /E_EXPERIENCE_MIGRATION_BACKUP/);
  assert.equal(rawState(file).version, EXPERIENCE_LEGACY_SCHEMA_VERSION);
  assert.equal(rawState(custom).version, EXPERIENCE_LEGACY_SCHEMA_VERSION);
  assert.equal(fs.statSync(custom).ino, fs.statSync(file).ino);
});

test('post-commit verification tolerates facts appended by a new schema 2 host', t => {
  const root = temporary(t);
  const store = openSharedExperience(root);
  for (let n = 0; n < 3; n += 1) store.recordFailure(failure(n));
  const converted = store.stats();
  store.close();
  const file = databaseFile(root);

  // Exactly what another (new) host may commit after the conversion's COMMIT and
  // before its post-commit verification: a new event and its knowledge row.
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, EXPERIENCE_SCHEMA_VERSION);
  db.exec('BEGIN IMMEDIATE');
  db.prepare('INSERT INTO events VALUES (?,?)').run(Buffer.alloc(32, 0x11), Buffer.alloc(32, 0x22));
  db.exec('UPDATE clock SET value=value+1');
  db.prepare('INSERT INTO knowledge VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body, revision=excluded.revision')
    .run('knowledge:post-commit', '{"scope":"post-commit"}', 1);
  db.exec('COMMIT');

  const verified = verifyCommittedExperienceStore(db, { eventsCount: converted.events, knowledgeCount: converted.knowledge });
  assert.equal(verified.events, converted.events + 1);
  assert.equal(verified.knowledge, converted.knowledge + 1);
  assert.equal(verified.integrity, 'ok');

  // The same check still fails closed when converted rows are actually missing.
  assert.throws(() => verifyCommittedExperienceStore(db, { eventsCount: converted.events + 2, knowledgeCount: converted.knowledge + 1 }),
    /E_EXPERIENCE_MIGRATION_DATA/);
  assert.throws(() => verifyCommittedExperienceStore(db, { eventsCount: converted.events + 1, knowledgeCount: converted.knowledge + 2 }),
    /E_EXPERIENCE_MIGRATION_DATA/);
});

test('a schema 2 host may commit immediately after the conversion COMMIT without failing it', async t => {
  // The writer polls the version and inserts once the conversion has committed,
  // which lands inside the conversion's post-commit phase on every attempt where
  // the poll wins. Then the conversion must still report success and keep the
  // new fact, instead of reporting "the ledger is incomplete".
  const writerScript = path.join(os.tmpdir(), `experience-post-commit-writer-${process.pid}.mjs`);
  fs.writeFileSync(writerScript, `import { DatabaseSync } from 'node:sqlite';
const file = process.argv[2];
const db = new DatabaseSync(file);
process.stdout.write('ready\\n');
const deadline = Date.now() + 20000;
let wrote = null;
let lastError = null;
while (Date.now() < deadline) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version === 2) {
    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare('INSERT INTO events VALUES (?,?)').run(Buffer.alloc(32, 0x33), Buffer.alloc(32, 0x44));
      db.exec('UPDATE clock SET value=value+1');
      db.prepare('INSERT INTO knowledge VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body, revision=excluded.revision')
        .run('knowledge:interleaved', '{"scope":"interleaved"}', 1);
      db.exec('COMMIT');
      wrote = Date.now();
      break;
    } catch (error) { lastError = String(error.message); }
  }
  await new Promise(resolve => setTimeout(resolve, 2));
}
process.stdout.write(JSON.stringify({ wrote, lastError }) + '\\n');
db.close();
`);
  t.after(() => fs.rmSync(writerScript, { force: true }));

  let interleaved = false;
  let attempts = 0;
  for (; attempts < 4 && !interleaved; attempts += 1) {
    const root = path.join(temporary(t), `attempt-${attempts}`);
    buildLargeLegacyStore(root, 20000);
    const file = databaseFile(root);
    const child = spawn(process.execPath, [writerScript, file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    await new Promise(resolve => {
      const timer = setInterval(() => { if (stdout.includes('ready')) { clearInterval(timer); resolve(); } }, 2);
      child.once('exit', () => { clearInterval(timer); resolve(); });
    });
    let report = null;
    let error = null;
    try { report = migrateSharedExperience(root, { vacuum: false }); } catch (caught) { error = caught; }
    const migrationEnded = Date.now();
    const exitCode = await new Promise(resolve => child.once('exit', resolve));
    assert.equal(exitCode, 0, `the writer failed: ${stderr.slice(-800)}`);
    const result = JSON.parse(stdout.split('\n').filter(line => line.startsWith('{')).at(-1));
    const state = rawState(file);
    if (error) {
      // The only acceptable failure is the documented busy refusal; a reader
      // poll can race the checkpoint. Retry with a fresh fixture.
      assert.match(String(error.message), /E_EXPERIENCE_MIGRATION_BUSY/);
      assert.equal(state.version, EXPERIENCE_LEGACY_SCHEMA_VERSION);
      continue;
    }
    assert.equal(report.migrated, true);
    assert.equal(state.version, EXPERIENCE_SCHEMA_VERSION);
    assert.equal(state.integrity, 'ok');
    if (result.wrote !== null) {
      // The writer always commits once it observes schema 2, so the fact is
      // present even when it landed after the conversion returned; the earlier
      // branch only decides whether that happened inside the migration.
      assert.equal(state.events, 20001, 'the post-commit fact must be kept');
      if (result.wrote <= migrationEnded) interleaved = true;
    } else {
      assert.equal(state.events, 20000);
    }
  }
  t.diagnostic(`interleaving observed: ${interleaved} after ${attempts} attempt(s)`);
});
