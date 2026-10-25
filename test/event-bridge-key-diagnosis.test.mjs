// The event-bridge key verdict and its key-derived evidence.
//
// The doctor is report-only here: it classifies the key file, reports what it
// could actually establish about the artifacts the key signs, and never creates,
// replaces, moves or deletes the key. A repair is deliberately absent because
// `storageConfig()` initialises the key before the archive lock is ever taken and
// the event bridge keeps the key it read for its whole lifetime, so no on-disk
// scan can prove that no live process still holds the old key in memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { collectDiagnostics, runDiagnostics, applyRepairs, resolveEvolutionPaths } from '../lib/diagnostics.js';
import { signEventBridgeEnvelope, verifyEventBridgeEnvelope } from '../lib/orchestrator.js';
import { storageConfig } from '../lib/index.js';
import { eventLogCheckpointPath } from '../lib/event-log-checkpoint.js';

const KEY = 'a'.repeat(64);
const scratchRoots = [];

function scratch(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `evo-key-${name}-`));
  scratchRoots.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of scratchRoots) fs.rmSync(dir, { recursive: true, force: true });
});

const checkOf = (report, id) => report.checks.find((check) => check.id === id);
const levelOf = (report, id) => checkOf(report, id)?.level;

function baseOptions(home) {
  return { home: true, dshHome: home, probe: { skipComposition: true } };
}

/** A home whose data root exists and nothing else. */
function emptyHome(name) {
  const home = scratch(name);
  const paths = resolveEvolutionPaths({ dshHome: home });
  fs.mkdirSync(paths.dataRoot, { recursive: true, mode: 0o700 });
  return { home, paths };
}

function validHome(name) {
  const { home, paths } = emptyHome(name);
  fs.writeFileSync(paths.keyPath, KEY, { mode: 0o600 });
  return { home, paths };
}

function domainGlobal({ applied = {}, pending = null } = {}) {
  return { unit: { name: 'evolution_domain', version: 1 }, global: { schema: 1, aggregate: { evolution: { schema: 4, observations: [], proposals: [] } }, applied, pending }, tables: {} };
}

function writeDomain(paths, value) {
  fs.mkdirSync(path.dirname(paths.domainGlobalPath), { recursive: true });
  fs.writeFileSync(paths.domainGlobalPath, JSON.stringify(value));
}

const noKeyRepair = (report) => report.repairs.filter((repair) => /key/.test(repair.id));

test('an absent key with no key-derived artifact is degraded, and the next start creates it', async () => {
  const { home, paths } = emptyHome('absent-empty');
  const report = await collectDiagnostics(baseOptions(home));
  assert.equal(levelOf(report, 'data.key'), 'degraded');
  // data.root speaks only about the root; the key verdict belongs to data.key.
  assert.equal(levelOf(report, 'data.root'), 'ok');
  assert.equal(Object.hasOwn(checkOf(report, 'data.root').evidence, 'key'), false);
  assert.doesNotMatch(checkOf(report, 'data.root').remediation ?? '', /key/i);
  assert.notEqual(report.status, 'blocked', 'the runtime creates the key on the next start; this is not a block');
  assert.deepEqual(noKeyRepair(report), []);
  assert.equal(checkOf(report, 'data.key').evidence.state, 'absent');

  // The runtime really does create it, which is why the verdict is degraded.
  const resolved = storageConfig({ dshHome: home });
  assert.match(resolved.eventBridgeKey, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(paths.keyPath, 'utf8'), resolved.eventBridgeKey);
});

test('a home whose data root does not exist yet is never blocked on the key', async () => {
  // The first start of the plugin runs before any directory exists. The doctor
  // must not read that as unproven state: `ENOENT` proves there is no data root
  // to hold a checkpoint temporary, so the checkpoint is absent, not unknown.
  const home = scratch('never-started');
  const paths = resolveEvolutionPaths({ dshHome: home });
  const report = await collectDiagnostics(baseOptions(home));
  assert.deepEqual(report.checks.filter((check) => check.level === 'blocked').map((check) => check.id), [],
    'a never-started home carries no residue, so nothing may be reported blocked');
  const key = checkOf(report, 'data.key');
  assert.equal(key.level, 'degraded');
  assert.equal(key.evidence.state, 'absent');
  assert.deepEqual(key.evidence.unknownArtifacts, [], 'a missing data root is not an unprovable artifact');
  assert.deepEqual(key.evidence.macBearingArtifacts, []);
  assert.equal(key.evidence.keyDerivedArtifacts.artifacts['event-log.checkpoint.json'].state, 'absent');
  assert.deepEqual(key.evidence.keyDerivedArtifacts.artifacts['event-log.checkpoint.json'].temporaries, []);
  assert.equal(key.repair, undefined);
  assert.equal(fs.existsSync(paths.dataRoot), false, 'the doctor must not create the data root');
  assert.equal(fs.existsSync(paths.keyPath), false, 'the doctor must not create the key');
});

test('an absent key with a zero-byte log is not blocked: the log holds no envelope to verify', async () => {
  const { home, paths } = emptyHome('absent-emptylog');
  fs.writeFileSync(paths.eventBridgePath, '');
  const report = await collectDiagnostics(baseOptions(home));
  assert.equal(levelOf(report, 'state.event-bridge'), 'ok');
  assert.equal(levelOf(report, 'data.key'), 'degraded');
  assert.notEqual(report.status, 'blocked');
  assert.equal(checkOf(report, 'data.key').evidence.keyDerivedArtifacts.artifacts['execution-events.jsonl'].state, 'empty');
});

test('a fully validated aggregate with no applied markers proves the key artifact empty', async () => {
  const { home, paths } = emptyHome('absent-emptydomain');
  writeDomain(paths, domainGlobal());
  const report = await collectDiagnostics(baseOptions(home));
  assert.equal(levelOf(report, 'state.domain'), 'ok');
  assert.equal(levelOf(report, 'data.key'), 'degraded');
  assert.equal(checkOf(report, 'data.key').evidence.keyDerivedArtifacts.artifacts['evolution_domain.json'].state, 'empty');
  assert.equal(checkOf(report, 'data.key').evidence.keyDerivedArtifacts.artifacts['evolution_domain.json'].applied, 0);
});

test('an absent key with a non-empty log is blocked, and the doctor never creates the key', async () => {
  const { home, paths } = emptyHome('absent-log');
  fs.writeFileSync(paths.eventBridgePath, '{"schema":2,"writer":"dsh-evolution-orchestrator"}\n');
  const report = await collectDiagnostics(baseOptions(home));
  const check = checkOf(report, 'data.key');
  assert.equal(check.level, 'blocked');
  assert.match(check.summary, /missing while 1 key-derived MAC artifact/);
  assert.match(check.summary, /execution-events\.jsonl/);
  assert.match(check.remediation, /Restore the original event-bridge\.key/);
  assert.deepEqual(noKeyRepair(report), []);
  assert.equal(check.evidence.keyDerivedArtifacts.artifacts['execution-events.jsonl'].records, 1);

  const repaired = await runDiagnostics({ ...baseOptions(home), repair: true });
  assert.deepEqual(repaired.repairsApplied, []);
  assert.equal(fs.existsSync(paths.keyPath), false, 'the doctor never creates the key');
  assert.equal(repaired.status, 'blocked');
});

test('an absent key with a non-empty global.applied map is blocked', async () => {
  const { home, paths } = emptyHome('absent-applied');
  writeDomain(paths, domainGlobal({ applied: { 'evt-1': 'ab'.repeat(32) } }));
  const report = await collectDiagnostics(baseOptions(home));
  const check = checkOf(report, 'data.key');
  assert.equal(check.level, 'blocked');
  assert.match(check.summary, /missing while 1 key-derived MAC artifact/);
  assert.match(check.summary, /evolution_domain\.json/);
  assert.equal(check.evidence.keyDerivedArtifacts.artifacts['evolution_domain.json'].applied, 1);
  assert.deepEqual(noKeyRepair(report), []);
  const repaired = await runDiagnostics({ ...baseOptions(home), repair: true });
  assert.deepEqual(repaired.repairsApplied, []);
  assert.equal(fs.existsSync(paths.keyPath), false);
});

test('a pending applied map counts as key-derived evidence too', async () => {
  const { home, paths } = emptyHome('absent-pending');
  writeDomain(paths, domainGlobal({ pending: { stage: 'stage-11111111-2222-3333-4444-555555555555', aggregate: { evolution: { schema: 4 } }, applied: { 'evt-2': 'cd'.repeat(32) } } }));
  const report = await collectDiagnostics(baseOptions(home));
  assert.equal(levelOf(report, 'data.key'), 'blocked');
  assert.equal(checkOf(report, 'data.key').evidence.keyDerivedArtifacts.artifacts['evolution_domain.json'].pendingApplied, 1);
});

test('an empty key with no key-derived artifact is blocked, offers no repair, and is left byte-identical', async () => {
  const { home, paths } = emptyHome('empty-key');
  fs.writeFileSync(paths.keyPath, '', { mode: 0o600 });
  const report = await collectDiagnostics(baseOptions(home));
  const check = checkOf(report, 'data.key');
  assert.equal(check.level, 'blocked');
  assert.equal(check.evidence.state, 'empty');
  assert.equal(check.evidence.bytes, 0);
  assert.equal(check.recoverable, false);
  assert.match(check.summary, /empty file \(0 bytes\)/);
  assert.match(check.remediation, /move the empty or unusable file aside/);
  assert.match(check.remediation, /The doctor does not create, replace or delete the key itself/);
  assert.deepEqual(noKeyRepair(report), []);

  const repaired = await runDiagnostics({ ...baseOptions(home), repair: true });
  assert.deepEqual(repaired.repairsApplied, []);
  assert.equal(fs.readFileSync(paths.keyPath, 'utf8'), '');
  assert.equal(repaired.status, 'blocked');
});

test('an empty key next to a non-empty applied map stays untouched and says to restore the key', async () => {
  const { home, paths } = emptyHome('empty-key-applied');
  fs.writeFileSync(paths.keyPath, '', { mode: 0o600 });
  writeDomain(paths, domainGlobal({ applied: { 'evt-1': 'ab'.repeat(32) } }));
  const report = await collectDiagnostics(baseOptions(home));
  const check = checkOf(report, 'data.key');
  assert.equal(check.level, 'blocked');
  assert.match(check.summary, /replacement would invalidate every recorded MAC/);
  assert.match(check.remediation, /Restore the original event-bridge\.key from a backup/);
  assert.deepEqual(noKeyRepair(report), []);

  const repaired = await runDiagnostics({ ...baseOptions(home), repair: true });
  assert.deepEqual(repaired.repairsApplied, []);
  assert.equal(fs.readFileSync(paths.keyPath, 'utf8'), '', 'the key is byte-identical after the run');
});

test('a malformed non-empty key with no key-derived artifact offers no repair', async () => {
  const { home, paths } = emptyHome('malformed-key');
  fs.writeFileSync(paths.keyPath, 'not-a-key', { mode: 0o600 });
  const report = await collectDiagnostics(baseOptions(home));
  const check = checkOf(report, 'data.key');
  assert.equal(check.level, 'blocked');
  assert.equal(check.evidence.state, 'malformed');
  assert.equal(check.evidence.bytes, 9);
  assert.deepEqual(noKeyRepair(report), []);
  const repaired = await runDiagnostics({ ...baseOptions(home), repair: true });
  assert.deepEqual(repaired.repairsApplied, []);
  assert.equal(fs.readFileSync(paths.keyPath, 'utf8'), 'not-a-key');
});

test('a non-empty checkpoint counts as a key-derived MAC artifact', async () => {
  const { home, paths } = emptyHome('checkpoint');
  fs.writeFileSync(eventLogCheckpointPath(paths.dataRoot), '{"schema":2,"mac":"ab"}\n');
  const report = await collectDiagnostics(baseOptions(home));
  const check = checkOf(report, 'data.key');
  assert.equal(check.evidence.keyDerivedArtifacts.artifacts['event-log.checkpoint.json'].state, 'mac-bearing');
  assert.deepEqual(check.evidence.macBearingArtifacts, ['event-log.checkpoint.json']);
  assert.equal(check.level, 'blocked', 'a present checkpoint MAC makes a freshly created key unsafe');
  assert.match(check.summary, /missing while 1 key-derived MAC artifact/);
  assert.match(check.summary, /would invalidate every recorded MAC/);
});

test('a checkpoint temporary is unknown, never empty: it can hold the same MAC bytes', async () => {
  const { home, paths } = emptyHome('checkpoint-tmp');
  fs.writeFileSync(path.join(paths.dataRoot, 'event-log.checkpoint.json.0123456789abcdef.tmp'), '{"schema":2,"mac":"ab"}\n');
  const report = await collectDiagnostics(baseOptions(home));
  const check = checkOf(report, 'data.key');
  assert.deepEqual(check.evidence.keyDerivedArtifacts.artifacts['event-log.checkpoint.json'].temporaries, ['event-log.checkpoint.json.0123456789abcdef.tmp']);
  assert.equal(check.evidence.keyDerivedArtifacts.artifacts['event-log.checkpoint.json'].state, 'unknown');
  assert.deepEqual(check.evidence.unknownArtifacts, ['event-log.checkpoint.json']);
  assert.equal(check.level, 'blocked');
  assert.match(check.summary, /cannot establish whether key-derived MAC data exists/);
});

test('an aggregate that does not fully validate is unknown, never empty', async () => {
  const { home, paths } = emptyHome('domain-unvalidated');
  writeDomain(paths, { unit: { name: 'evolution_domain', version: 1 }, global: { schema: 2 }, tables: {} });
  const report = await collectDiagnostics(baseOptions(home));
  const check = checkOf(report, 'data.key');
  assert.equal(levelOf(report, 'state.domain'), 'blocked');
  assert.equal(check.evidence.keyDerivedArtifacts.artifacts['evolution_domain.json'].state, 'unknown');
  assert.deepEqual(check.evidence.unknownArtifacts, ['evolution_domain.json']);
  assert.equal(check.level, 'blocked');
  assert.match(check.summary, /cannot establish whether key-derived MAC data exists/);
});

test('a valid key is reported ok, says so, and offers no repair', async () => {
  const { home, paths } = validHome('valid-key');
  const report = await collectDiagnostics(baseOptions(home));
  const check = checkOf(report, 'data.key');
  assert.equal(check.level, 'ok');
  assert.match(check.summary, /valid \(64 lowercase hex characters\); no replacement is needed/);
  assert.equal(check.evidence.state, 'valid');
  assert.deepEqual(report.repairs, []);
  const repaired = await runDiagnostics({ ...baseOptions(home), repair: true });
  assert.deepEqual(repaired.repairsApplied, []);
  assert.equal(fs.readFileSync(paths.keyPath, 'utf8'), KEY);
});

test('no repair implementation exists for either key repair id', async () => {
  const { home, paths } = emptyHome('no-key-implementation');
  fs.writeFileSync(paths.keyPath, '', { mode: 0o600 });
  for (const id of ['event-bridge-key-recreate', 'event-bridge-key-repair']) {
    const applied = await applyRepairs([{ id, safe: true }], { paths });
    assert.deepEqual(applied.map((entry) => entry.status), ['skipped'], `${id} must not be implemented`);
    assert.match(applied[0].detail, /no implementation/);
  }
  assert.equal(fs.readFileSync(paths.keyPath, 'utf8'), '');
  assert.equal(levelOf(await collectDiagnostics(baseOptions(home)), 'data.key'), 'blocked');
});

// ---------------------------------------------------------------------------
// S3: the log is never verified with a key the runtime refuses
// ---------------------------------------------------------------------------

test('a present-but-unusable key is never used for verification, even when the log would verify with it', async () => {
  const { home, paths } = emptyHome('unusable-key-verifies');
  // Not 64 lowercase hex (uppercase), so storageConfig() refuses to start with
  // it, while it is long enough for verifyEventBridgeEnvelope() to use it.
  const key = 'A'.repeat(64);
  const envelope = signEventBridgeEnvelope({ eventId: 'evt-1', eventType: 'measurement-completed' }, { key, sequence: 1 });
  fs.writeFileSync(paths.eventBridgePath, `${JSON.stringify(envelope)}\n`);
  fs.writeFileSync(paths.keyPath, key, { mode: 0o600 });

  // Control: the bytes do verify against this key material, which is exactly why
  // testing the key by truthiness could have reported the bridge `ok`.
  assert.equal(Boolean(verifyEventBridgeEnvelope(JSON.parse(fs.readFileSync(paths.eventBridgePath, 'utf8')), key)), true);

  const report = await collectDiagnostics(baseOptions(home));
  assert.equal(levelOf(report, 'data.key'), 'blocked');
  const bridge = checkOf(report, 'state.event-bridge');
  assert.equal(bridge.level, 'blocked');
  assert.equal(bridge.evidence.keyValid, false);
  assert.equal(bridge.evidence.verificationAttempted, false);
  assert.equal(bridge.evidence.keyState, 'malformed');
  assert.match(bridge.summary, /no record can be verified/);
  assert.match(bridge.remediation, /data\.key/);
  assert.deepEqual(noKeyRepair(report), []);
});

// ---------------------------------------------------------------------------
// S2: a directory that can be read by path but not listed is unknown, never empty
// ---------------------------------------------------------------------------

test('a data root that cannot be listed makes the checkpoint provisional, never empty', async () => {
  const { home, paths } = emptyHome('checkpoint-unlistable');
  fs.writeFileSync(paths.keyPath, KEY, { mode: 0o600 });
  fs.writeFileSync(paths.eventBridgePath, '');
  const realReadFileSync = fs.readFileSync;
  const realReaddirSync = fs.readdirSync;
  let bridgeRead = false;
  let injected = 0;
  fs.readFileSync = function countedRead(target, ...rest) {
    if (String(target) === paths.eventBridgePath) bridgeRead = true;
    return realReadFileSync.call(fs, target, ...rest);
  };
  fs.readdirSync = function failingList(target, ...rest) {
    if (bridgeRead && String(target) === paths.dataRoot) {
      injected += 1;
      throw Object.assign(new Error('EACCES: permission denied, scandir'), { code: 'EACCES' });
    }
    return realReaddirSync.call(fs, target, ...rest);
  };
  let report;
  try { report = await collectDiagnostics(baseOptions(home)); }
  finally { fs.readFileSync = realReadFileSync; fs.readdirSync = realReaddirSync; }

  assert.equal(injected, 1, 'the checkpoint listing is the only data-root listing after the bridge read');
  const checkpoint = checkOf(report, 'data.key').evidence.keyDerivedArtifacts.artifacts['event-log.checkpoint.json'];
  assert.equal(checkpoint.state, 'unknown', 'an unlistable root cannot prove the checkpoint absent or empty');
  assert.equal(checkpoint.temporaries, null, 'a failed listing is not reported as "no temporary"');
  assert.equal(checkpoint.temporaryListingError, 'EACCES');
  assert.deepEqual(checkOf(report, 'data.key').evidence.unknownArtifacts, ['event-log.checkpoint.json']);
  // The key itself is valid; the artifact stays unproven in the evidence rather
  // than being silently counted as an empty one.
  assert.equal(levelOf(report, 'data.key'), 'ok');
});


// ---------------------------------------------------------------------------
// S2: the key is only opened when it resolves to a regular file
// ---------------------------------------------------------------------------

test('a FIFO at the key path is reported blocked without being opened', async (t) => {
  const { home, paths } = emptyHome('fifo-key');
  try { execFileSync('mkfifo', [paths.keyPath]); } catch { t.skip('mkfifo is unavailable on this platform'); return; }

  const realReadFileSync = fs.readFileSync;
  let opened = 0;
  fs.readFileSync = function guardedRead(pathname, ...rest) {
    if (String(pathname) === paths.keyPath) {
      opened += 1;
      throw Object.assign(new Error('EAGAIN: a FIFO must not be opened'), { code: 'EAGAIN' });
    }
    return realReadFileSync.call(fs, pathname, ...rest);
  };
  let report;
  const startedAt = Date.now();
  try { report = await collectDiagnostics(baseOptions(home)); }
  finally { fs.readFileSync = realReadFileSync; }

  assert.equal(opened, 0, 'the doctor never opened the FIFO');
  assert.ok(Date.now() - startedAt < 5000, 'the doctor returned promptly');
  const check = checkOf(report, 'data.key');
  assert.equal(check.level, 'blocked');
  assert.equal(check.evidence.state, 'malformed');
  assert.equal(check.evidence.regularFile, false);
  assert.equal(check.evidence.targetKind, 'fifo');
  assert.match(check.summary, /not a regular file \(fifo\)/);
  assert.deepEqual(noKeyRepair(report), []);
  assert.equal(fs.statSync(paths.keyPath).isFIFO(), true, 'the FIFO is left exactly as it was');
});

test('a directory or a dangling link at the key path is blocked, and a link to a regular file is still accepted', async () => {
  const directory = emptyHome('key-directory');
  fs.mkdirSync(directory.paths.keyPath);
  const directoryReport = await collectDiagnostics(baseOptions(directory.home));
  assert.equal(levelOf(directoryReport, 'data.key'), 'blocked');
  assert.equal(checkOf(directoryReport, 'data.key').evidence.targetKind, 'directory');
  assert.match(checkOf(directoryReport, 'data.key').summary, /not a regular file \(directory\)/);

  const dangling = emptyHome('key-dangling');
  fs.symlinkSync(path.join(dangling.paths.dataRoot, 'missing-key'), dangling.paths.keyPath);
  const danglingReport = await collectDiagnostics(baseOptions(dangling.home));
  assert.equal(levelOf(danglingReport, 'data.key'), 'blocked');
  assert.equal(checkOf(danglingReport, 'data.key').evidence.targetKind, 'dangling symlink');
  assert.equal(checkOf(danglingReport, 'data.key').evidence.present, true, 'the entry exists even though its target does not');

  // A symlink to a regular file is what the runtime reads, so it is accepted.
  const symlinked = emptyHome('key-symlink');
  const realKey = path.join(symlinked.paths.dataRoot, 'real-key');
  fs.writeFileSync(realKey, KEY, { mode: 0o600 });
  fs.symlinkSync(realKey, symlinked.paths.keyPath);
  const symlinkedReport = await collectDiagnostics(baseOptions(symlinked.home));
  assert.equal(levelOf(symlinkedReport, 'data.key'), 'ok');
  assert.equal(checkOf(symlinkedReport, 'data.key').evidence.state, 'valid');
  assert.equal(checkOf(symlinkedReport, 'data.key').evidence.symlink, true);
});
