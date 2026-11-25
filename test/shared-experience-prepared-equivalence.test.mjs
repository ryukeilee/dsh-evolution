import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceFile = path.join(repo, 'lib/shared-experience.js');
const source = fs.readFileSync(sourceFile, 'utf8');

/**
 * Reconstruct the pre-optimisation implementation from the shipped source by
 * putting the five `db.prepare(...)` calls back inside record(). The transform
 * asserts every expected fragment exists, so a future edit to the reused
 * statements cannot silently turn this into a self-comparison.
 */
function preChangeSource(text) {
  const declaration = /  \/\/ The write statements below have constant SQL\.[\s\S]*?  const statement = \(sql\) => \{[\s\S]*?  \};\n/;
  if (!declaration.test(text)) throw new Error('reused statement block not found; re-anchor this differential');
  let out = text.replace(declaration, '');
  const replacements = [
    ["statement('SELECT digest FROM events WHERE id=?').get(", "db.prepare('SELECT digest FROM events WHERE id=?').get("],
    ["statement('SELECT body FROM knowledge WHERE key=?').get(", "db.prepare('SELECT body FROM knowledge WHERE key=?').get("],
    ["statement('INSERT INTO events VALUES (?,?)').run(", "db.prepare('INSERT INTO events VALUES (?,?)').run("],
    ["statement('UPDATE clock SET value=value+1').run()", "db.exec('UPDATE clock SET value=value+1')"],
    ["statement('INSERT INTO knowledge VALUES (?,?,(SELECT value FROM clock)) ON CONFLICT(key) DO UPDATE SET body=excluded.body, revision=excluded.revision')", "db.prepare('INSERT INTO knowledge VALUES (?,?,(SELECT value FROM clock)) ON CONFLICT(key) DO UPDATE SET body=excluded.body, revision=excluded.revision')"],
  ];
  for (const [from, to] of replacements) {
    if (!out.includes(from)) throw new Error('reused-statement call not found: ' + from);
    out = out.split(from).join(to);
  }
  return out;
}
function localised(text) {
  return text.replace(/from '\.\/([^']+)'/g, (match, relative) => `from '${path.join(repo, 'lib', relative)}'`);
}
async function materialise(t, text) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'experience-prepared-equiv-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'shared-experience.js');
  fs.writeFileSync(file, localised(text));
  return (await import(pathToFileURL(file).href));
}

function stableBody(body) {
  const value = JSON.parse(body);
  for (const key of ['firstSeen', 'lastSeen', 'updatedAt', 'recentEvidence', 'trend']) delete value[key];
  return JSON.stringify(value);
}
function dump(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const events = db.prepare('SELECT hex(id) AS id, hex(digest) AS digest FROM events ORDER BY id').all();
    const knowledge = db.prepare('SELECT key, body, revision FROM knowledge ORDER BY key').all()
      .map(row => ({ key: row.key, revision: row.revision, body: stableBody(row.body) }));
    const clock = db.prepare('SELECT value FROM clock').get().value;
    return { events, knowledge, clock };
  } finally { db.close(); }
}
function stableRecords(records) {
  return records.map((record) => {
    const { firstSeen, lastSeen, ...rest } = record;
    return rest;
  }).sort((left, right) => String(left.key).localeCompare(String(right.key))
    || String(left.problem).localeCompare(String(right.problem)));
}
function fill(store, id) {
  store.recordFailure({ id: id('failure'), type: 'tool/error', code: 'ENOENT', target: 'tool:read_file',
    metrics: { attemptsSinceFailure: 7, successesSinceFailure: 2 } });
  // Replay the same fact: the duplicate branch also uses the hoisted handle.
  store.recordFailure({ id: id('failure'), type: 'tool/error', code: 'ENOENT', target: 'tool:read_file' });
  store.recordDegradation({ id: id('degradation'), target: 'tool:read_file', kind: 'line-truncated', recoveryTool: 'bash', recoveryCalls: 1 });
  store.recordToolRecovery({ id: id('recovery'), target: 'tool:read_file' });
  store.recordConclusion({
    experimentId: `${id('conclusion').slice(0, 16)}`, decision: 'no-benefit', strategyFingerprint: 'a1b2c3d4',
    strategy: 'complete read', rootCause: 'renderer truncates a long line', occurredAt: '2026-01-02T03:04:05.000Z',
    target: 'tool:read_file', applicability: { dsh: '0.2.21', cordis: '4.1.0', evolution: '0.2.21' },
  }, `origin:${id('origin')}`);
}

test('reused prepared statements keep the ledger, canonical rows and query projections identical', async (t) => {
  const before = await materialise(t, preChangeSource(source));
  const after = await materialise(t, source);
  const roots = [];
  t.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
  const outputs = [];
  for (const mod of [before, after]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'experience-prepared-run-'));
    roots.push(root);
    const store = mod.openSharedExperience(root);
    for (let i = 0; i < 12; i += 1) {
      const id = (kind) => mod.experienceEventId('equiv', kind, i);
      fill(store, id);
    }
    const file = path.join(root, 'experience.sqlite');
    // Same-id conflict must still be rejected with the same code on both sides.
    assert.throws(() => store.recordFailure({ id: mod.experienceEventId('equiv', 'failure', 0),
      type: 'tool/error', code: 'EACCES', target: 'tool:read_file' }), /E_EXPERIENCE_EVENT_CONFLICT/);
    const conclusions = store.findConclusions({ target: 'tool:read_file', strategyFingerprint: 'a1b2c3d4' });
    const discovered = store.discover({ window: 50 });
    const recalled = store.recall({ problem: 'read_file' });
    outputs.push({ dump: dump(file), stats: store.stats(),
      conclusions: { considered: conclusions.considered, scoped: conclusions.scoped, truncated: conclusions.truncated,
        matches: conclusions.matches.map(({ knowledgeKey, decision, applicability, sameApplicability }) =>
          ({ knowledgeKey, decision, applicability, sameApplicability })) },
      // The record projections are compared field for field (sorted by key so the
      // order cannot depend on when each side ran); only the two time fields are
      // excluded, because they come from the wall clock. A change that touches
      // only what `discover()`/`recall()` return is therefore caught here, not
      // only in the stored body.
      discovered: { count: discovered.records.length, truncated: discovered.truncated,
        records: stableRecords(discovered.records) },
      recalled: { considered: recalled.considered, scanned: recalled.scanned, truncated: recalled.truncated,
        records: stableRecords(recalled.records ?? []) },
    });
    store.close();
  }
  assert.deepEqual(outputs[0], outputs[1]);
});

test('the differential is sensitive to a wrong reused statement (counter-proof)', async (t) => {
  const broken = source.replace("revision=excluded.revision'", "revision=excluded.revision+1'");
  assert.notEqual(broken, source, 'injection failed');
  const before = await materialise(t, preChangeSource(source));
  const after = await materialise(t, broken);
  const roots = [];
  t.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
  const dumps = [];
  for (const mod of [before, after]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'experience-prepared-counter-'));
    roots.push(root);
    const store = mod.openSharedExperience(root);
    for (let i = 0; i < 3; i += 1) store.recordFailure({ id: mod.experienceEventId('counter', i),
      type: 'tool/error', code: 'ENOENT', target: 'tool:read_file' });
    dumps.push(dump(path.join(root, 'experience.sqlite')));
    store.close();
  }
  assert.notDeepEqual(dumps[0], dumps[1], 'a broken statement handle must be caught by the differential');
});

test('the prepared handles are per-store, not shared across opened databases', async (t) => {
  const mod = await materialise(t, source);
  const roots = Array.from({ length: 2 }, () => fs.mkdtempSync(path.join(os.tmpdir(), 'experience-prepared-two-')));
  t.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
  const stores = roots.map(root => mod.openSharedExperience(root));
  for (let i = 0; i < 4; i += 1) {
    const id = mod.experienceEventId('two', i);
    stores[0].recordFailure({ id, type: 'tool/error', code: 'ENOENT', target: 'tool:read_a' });
    stores[1].recordFailure({ id, type: 'tool/error', code: 'ENOENT', target: 'tool:read_b' });
  }
  const a = dump(path.join(roots[0], 'experience.sqlite'));
  const b = dump(path.join(roots[1], 'experience.sqlite'));
  assert.notDeepEqual(a.knowledge, b.knowledge);
  for (const store of stores) store.close();
});

// A database whose trigger references a missing table compiles fine until the
// statement that fires it is prepared. Preparing every write statement while
// opening made such a store unopenable (and skipped the open path's own close on
// that failure), although this process can still read it and the baseline only
// failed when the write needed that statement.
test('a statement that cannot be prepared fails its write, not the open', async (t) => {
  const before = await materialise(t, preChangeSource(source));
  const after = await materialise(t, source);
  const roots = [];
  t.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
  const outcomes = [];
  for (const mod of [before, after]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'experience-prepared-trigger-'));
    roots.push(root);
    const file = path.join(root, 'experience.sqlite');
    const seed = mod.openSharedExperience(root);
    seed.close();
    const db = new DatabaseSync(file);
    db.exec('CREATE TRIGGER r12_broken_clock AFTER UPDATE ON clock BEGIN INSERT INTO r12_missing (value) VALUES (1); END;');
    db.close();
    // Opening must succeed: the unreadable trigger body is not this process's
    // read path, and open() must not compile a statement it may never use.
    const store = mod.openSharedExperience(root);
    assert.deepEqual(store.stats(), { events: 0, knowledge: 0 });
    let writeError = null;
    try {
      store.recordFailure({ id: mod.experienceEventId('trigger', 1), type: 'tool/error', code: 'ENOENT', target: 'tool:read_file' });
    } catch (error) { writeError = String(error?.message ?? error); }
    // The failed transaction rolls back and leaves the store usable.
    outcomes.push({ writeError, stats: store.stats() });
    store.close();
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.match(outcomes[1].writeError, /r12_missing/);
  assert.deepEqual(outcomes[1].stats, { events: 0, knowledge: 0 });
});
