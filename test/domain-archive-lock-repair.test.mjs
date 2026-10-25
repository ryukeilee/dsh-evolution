// The domain archive lock: one read-only classifier owned by the runtime module,
// and the `domain-stale-lock` repair that removes through the runtime's own
// acquire/release protocol instead of unlinking by path.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { collectDiagnostics, runDiagnostics, applyRepairs, resolveEvolutionPaths } from '../lib/diagnostics.js';
import { inspectArchiveLock, withArchiveLock } from '../lib/domain-storage.js';

const KEY = 'a'.repeat(64);
const scratchRoots = [];

function scratch(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `evo-lock-${name}-`));
  scratchRoots.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of scratchRoots) fs.rmSync(dir, { recursive: true, force: true });
});

const checkOf = (report, id) => report.checks.find((check) => check.id === id);
const levelOf = (report, id) => checkOf(report, id)?.level;
const lockRepair = (report) => report.repairs.find((repair) => repair.id === 'domain-stale-lock');

function baseOptions(home) {
  return { home: true, dshHome: home, probe: { skipComposition: true } };
}

function initializedHome(name) {
  const home = scratch(name);
  const paths = resolveEvolutionPaths({ dshHome: home });
  fs.mkdirSync(paths.dataRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.keyPath, KEY, { mode: 0o600 });
  return { home, paths };
}

function ageFile(file, ms) {
  const past = new Date(Date.now() - ms);
  fs.utimesSync(file, past, past);
}

function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

// ---------------------------------------------------------------------------
// the classifier is the runtime's own
// ---------------------------------------------------------------------------

test('inspectArchiveLock reports absence, liveness, the settle window and non-regular entries from the runtime rules', () => {
  const dir = scratch('classify');
  const lock = path.join(dir, 'domain-archive.lock');

  const absent = inspectArchiveLock(lock);
  assert.equal(absent.present, false);
  assert.equal(absent.kind, 'absent');
  assert.equal(absent.reclaimable, false);

  fs.writeFileSync(lock, String(process.pid));
  const live = inspectArchiveLock(lock);
  assert.equal(live.present, true);
  assert.equal(live.kind, 'file');
  assert.equal(live.pid, process.pid);
  assert.equal(live.ownerAlive, true);
  assert.equal(live.malformed, false);
  assert.equal(live.reclaimable, false, 'a live owner is never reclaimable');

  fs.writeFileSync(lock, String(deadPid()));
  const dead = inspectArchiveLock(lock);
  assert.equal(dead.ownerAlive, false);
  assert.equal(dead.reclaimable, true, 'a named owner that is gone is reclaimed immediately');

  fs.writeFileSync(lock, '');
  const fresh = inspectArchiveLock(lock);
  assert.equal(fresh.kind, 'file');
  assert.equal(fresh.malformed, true);
  assert.equal(fresh.settling, true);
  assert.equal(fresh.reclaimable, false, 'a byte-less entry inside the settle window is not reclaimed yet');

  ageFile(lock, 60000);
  const settled = inspectArchiveLock(lock);
  assert.equal(settled.settling, false);
  assert.equal(settled.reclaimable, true, 'a settled byte-less entry is reclaimed');

  fs.writeFileSync(lock, 'not a pid');
  ageFile(lock, 60000);
  const garbage = inspectArchiveLock(lock);
  assert.equal(garbage.malformed, true);
  assert.equal(garbage.reclaimable, true);

  const target = path.join(dir, 'pid-file');
  fs.writeFileSync(target, String(process.pid));
  fs.rmSync(lock);
  fs.symlinkSync(target, lock);
  const symlink = inspectArchiveLock(lock);
  assert.equal(symlink.kind, 'symlink');
  assert.equal(symlink.malformed, true);
  assert.equal(symlink.reclaimable, false, 'the runtime refuses a link instead of interpreting it');
  assert.equal(symlink.ownerAlive, false);

  fs.rmSync(lock);
  fs.mkdirSync(lock);
  const directory = inspectArchiveLock(lock);
  assert.equal(directory.kind, 'directory');
  assert.equal(directory.reclaimable, false);
  assert.equal(directory.malformed, true);
});

// ---------------------------------------------------------------------------
// the doctor reports the lock in both aggregate states
// ---------------------------------------------------------------------------

test('a stale lock is diagnosed and repaired even when no domain aggregate exists', async () => {
  const { home, paths } = initializedHome('absent-aggregate');
  fs.writeFileSync(paths.domainArchiveLockPath, '');
  ageFile(paths.domainArchiveLockPath, 60000);

  const report = await collectDiagnostics(baseOptions(home));
  const check = checkOf(report, 'state.domain');
  assert.equal(check.level, 'degraded');
  assert.equal(check.evidence.archiveLock.kind, 'file');
  assert.equal(check.evidence.archiveLock.reclaimable, true);
  assert.equal(check.evidence.staleLock, true);
  assert.equal(lockRepair(report)?.id, 'domain-stale-lock');
  assert.match(check.summary, /No domain aggregate yet, and its archive lock needs attention/);

  const repaired = await runDiagnostics({ ...baseOptions(home), repair: true });
  assert.deepEqual(repaired.repairsApplied.map((entry) => [entry.id, entry.status]), [['domain-stale-lock', 'applied']]);
  assert.match(repaired.repairsApplied[0].detail, /^the runtime acquire\/release protocol completed$/);
  assert.equal(fs.existsSync(paths.domainArchiveLockPath), false);

  const again = await runDiagnostics({ ...baseOptions(home), repair: true });
  assert.deepEqual(again.repairsApplied, [], 'a repeat run has nothing to do');
  assert.equal(levelOf(again, 'state.domain'), 'ok');
});

test('a lock naming a dead pid is reported and repaired', async () => {
  const { home, paths } = initializedHome('dead-pid');
  fs.writeFileSync(paths.domainArchiveLockPath, String(deadPid()));
  const report = await collectDiagnostics(baseOptions(home));
  assert.equal(checkOf(report, 'state.domain').evidence.archiveLock.ownerAlive, false);
  assert.equal(lockRepair(report)?.id, 'domain-stale-lock');

  const repaired = await runDiagnostics({ ...baseOptions(home), repair: true });
  assert.deepEqual(repaired.repairsApplied.map((entry) => entry.status), ['applied']);
  assert.equal(fs.existsSync(paths.domainArchiveLockPath), false);
});

test('a byte-less lock inside the settle window is degraded and never offered for repair', async () => {
  const { home, paths } = initializedHome('settling');
  fs.writeFileSync(paths.domainArchiveLockPath, '');
  const report = await collectDiagnostics(baseOptions(home));
  const check = checkOf(report, 'state.domain');
  assert.equal(check.level, 'degraded');
  assert.equal(check.evidence.archiveLock.settling, true);
  assert.equal(check.evidence.archiveLock.reclaimable, false);
  assert.equal(lockRepair(report), undefined);
  assert.match(check.summary, /waits for that window before reclaiming/);

  // The repair is never offered while the entry is inside the window, so a
  // repair run has nothing to apply and leaves the entry alone.
  const repaired = await runDiagnostics({ ...baseOptions(home), repair: true });
  assert.deepEqual(repaired.repairsApplied, []);
  assert.equal(fs.existsSync(paths.domainArchiveLockPath), true, 'the entry is left for a later run');
});

test('a non-regular lock entry is blocked and never repaired', async () => {
  const symlinked = initializedHome('symlink');
  const target = path.join(symlinked.paths.dataRoot, 'pid-target');
  fs.writeFileSync(target, String(process.pid));
  fs.symlinkSync(target, symlinked.paths.domainArchiveLockPath);
  const symlinkReport = await collectDiagnostics(baseOptions(symlinked.home));
  const symlinkCheck = checkOf(symlinkReport, 'state.domain');
  assert.equal(symlinkCheck.level, 'blocked');
  assert.equal(symlinkCheck.evidence.archiveLock.kind, 'symlink');
  assert.equal(lockRepair(symlinkReport), undefined, 'a link is never "stale, repairable"');
  assert.match(symlinkCheck.summary, /refuses to interpret/);
  const symlinkApplied = await applyRepairs([{ id: 'domain-stale-lock', safe: true }], { paths: symlinked.paths });
  assert.deepEqual(symlinkApplied.map((entry) => entry.status), ['skipped']);
  assert.equal(fs.lstatSync(symlinked.paths.domainArchiveLockPath).isSymbolicLink(), true, 'the link survives');

  const directory = initializedHome('directory');
  fs.mkdirSync(directory.paths.domainArchiveLockPath);
  const directoryReport = await collectDiagnostics(baseOptions(directory.home));
  const directoryCheck = checkOf(directoryReport, 'state.domain');
  assert.equal(directoryCheck.level, 'blocked');
  assert.equal(directoryCheck.evidence.archiveLock.kind, 'directory');
  assert.equal(lockRepair(directoryReport), undefined);
  const directoryApplied = await applyRepairs([{ id: 'domain-stale-lock', safe: true }], { paths: directory.paths });
  assert.deepEqual(directoryApplied.map((entry) => entry.status), ['skipped']);
  assert.equal(fs.lstatSync(directory.paths.domainArchiveLockPath).isDirectory(), true, 'the directory survives');
});

test('a live lock is diagnosed as a live owner and never repaired', async () => {
  const { home, paths } = initializedHome('live');
  fs.writeFileSync(paths.domainArchiveLockPath, String(process.pid));
  const report = await collectDiagnostics(baseOptions(home));
  const check = checkOf(report, 'state.domain');
  assert.equal(check.evidence.archiveLock.ownerAlive, true);
  assert.equal(lockRepair(report), undefined);
  assert.equal(levelOf(report, 'state.domain'), 'ok', 'a live writer holding the archive lock is normal');
  assert.equal(fs.readFileSync(paths.domainArchiveLockPath, 'utf8'), String(process.pid));
});

// ---------------------------------------------------------------------------
// the repair runs the runtime protocol; a live lock taken meanwhile survives
// ---------------------------------------------------------------------------

test('the repair does not remove a lock a second port acquired after the diagnosis', async () => {
  const { home, paths } = initializedHome('held');
  fs.writeFileSync(paths.domainArchiveLockPath, '');
  ageFile(paths.domainArchiveLockPath, 60000);
  const report = await collectDiagnostics(baseOptions(home));
  assert.equal(lockRepair(report)?.id, 'domain-stale-lock', 'the stale entry was offered for repair');

  let applied;
  await withArchiveLock(paths.domainArchiveLockPath, async () => {
    applied = await applyRepairs([{ id: 'domain-stale-lock', safe: true }], { paths });
    // The live lock this test holds is still there and still names this process.
    assert.equal(fs.readFileSync(paths.domainArchiveLockPath, 'utf8'), String(process.pid));
  });

  assert.deepEqual(applied.map((entry) => entry.status), ['skipped']);
  assert.match(applied[0].detail, /the archive lock maintenance did not complete \(E_DOMAIN_ARCHIVE_LOCK\)/);
  assert.match(applied[0].detail, /the protocol may have reclaimed an entry before failing/);
  assert.match(applied[0].detail, /cannot tell from this error what the lock path now holds/);
  assert.match(applied[0].detail, /re-run the doctor/);
  assert.doesNotMatch(applied[0].detail, /nothing was removed/);
  assert.doesNotMatch(applied[0].detail, /became acquirable/);
  assert.equal(fs.existsSync(paths.domainArchiveLockPath), false, 'the test\'s own withArchiveLock released its entry');
});
