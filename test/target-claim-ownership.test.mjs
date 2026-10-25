// The on-disk target claim protocol: one classifier read by the runtime and by
// the doctor, the acquisition's behaviour proved equivalent to the pre-change
// inline logic, and the doctor's report-only treatment of every claim shape.
//
// Every fixture is synthetic and lives in os.tmpdir(). The claims themselves are
// created through the real `acquireTargets()` path wherever the point of the
// test is that the runtime and the doctor agree.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

import { EvolutionOrchestrator, parseTargetClaim, classifyTargetClaim } from '../lib/orchestrator.js';
import { collectDiagnostics, runDiagnostics, applyRepairs, resolveEvolutionPaths } from '../lib/diagnostics.js';
import { orchestratorContext } from './orchestrator-durability-fixtures.mjs';

const KEY = 'a'.repeat(64);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const scratchRoots = [];

function scratch(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `evo-claim-${name}-`));
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

/** A home with an initialized data root and a valid key; nothing else. */
function initializedHome(name) {
  const home = scratch(name);
  const paths = resolveEvolutionPaths({ dshHome: home });
  fs.mkdirSync(paths.dataRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.keyPath, KEY, { mode: 0o600 });
  return { home, paths };
}

/** The orchestrator exactly as the bundle builds it: `storageConfig()` spreads
 *  `resolveEvolutionPaths()` into the config, so `ownershipDir` is the doctor's. */
function runtimeFor(paths) {
  return new EvolutionOrchestrator(orchestratorContext(), {
    ...paths,
    eventBridgeKey: KEY,
    startupDrift: false,
    eventBridge: { emit: () => ({}) },
  });
}

const claimPath = (paths, target) => path.join(paths.ownershipDir, `${sha256(target)}.json`);

function writeClaim(paths, target, claim) {
  fs.mkdirSync(paths.ownershipDir, { recursive: true, mode: 0o700 });
  const file = claimPath(paths, target);
  fs.writeFileSync(file, typeof claim === 'string' ? claim : JSON.stringify(claim));
  return file;
}

function ageFile(file, ms) {
  const past = new Date(Date.now() - ms);
  fs.utimesSync(file, past, past);
}

/** A pid the OS has reaped: `spawnSync` returns only after the child exited. */
function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

// ---------------------------------------------------------------------------
// the classifier: one shape per case, no real stray process needed
// ---------------------------------------------------------------------------

test('classifyTargetClaim separates all five shapes, and only an unproven ESRCH reclaims', () => {
  const hostname = os.hostname();
  const base = { schema: 1, target: 'plugin:x', experimentId: 'exp-1', ownerId: 'owner', pid: 4242, hostname, acquiredAt: new Date().toISOString() };
  const encode = (overrides = {}) => JSON.stringify({ ...base, ...overrides });
  const alive = (pid) => pid === 4242;

  const classify = (text, options) => classifyTargetClaim(parseTargetClaim(text), options);
  assert.equal(classify(encode(), { hostname, alive }).state, 'live');
  assert.equal(classify(encode({ pid: 4343 }), { hostname, alive }).state, 'reclaimable');
  assert.equal(classify(encode({ hostname: 'another-host' }), { hostname, alive }).state, 'foreign-host');
  assert.equal(classify(encode({ pid: '4242' }), { hostname, alive }).state, 'incomplete');
  assert.equal(classify(encode({ hostname: undefined }), { hostname, alive }).state, 'incomplete');
  assert.equal(classify('', { hostname, alive }).state, 'unreadable');
  assert.equal(classify('{"schema":1', { hostname, alive }).state, 'unreadable');
  // Parses, but carries no claim fields: incomplete, never unreadable.
  assert.equal(classify('null', { hostname, alive }).state, 'incomplete');
  assert.equal(classify('[]', { hostname, alive }).state, 'incomplete');
  // Any integer pid is probed on this host, exactly as the pre-change check did;
  // a probe that cannot prove death (EPERM, EINVAL) never reclaims.
  assert.equal(classify(encode({ pid: 0 }), { hostname, alive: () => true }).state, 'live');
  assert.equal(classify(encode({ pid: -5 }), { hostname, alive: () => true }).state, 'live');
  // The claim itself is returned with the classification, so a report can name
  // the owner without a second parse.
  assert.equal(classify(encode({ hostname: 'another-host' }), { hostname, alive }).claim.experimentId, 'exp-1');

  // The classifier never probes a claim it cannot interpret or that is not on
  // this host; only a same-host integer pid reaches the probe.
  let probes = 0;
  const counted = () => { probes += 1; return true; };
  for (const text of ['', '{"schema":1', 'null', '[]', encode({ hostname: 'another-host' }), encode({ pid: '4242' }), encode({ hostname: undefined })]) {
    classifyTargetClaim(parseTargetClaim(text), { hostname, alive: counted });
  }
  assert.equal(probes, 0, 'only a same-host claim with an integer pid is probed');
  classifyTargetClaim(parseTargetClaim(encode()), { hostname, alive: counted });
  assert.equal(probes, 1);

  // The default probe is the real one: this process is alive, and a pid that was
  // reaped is not.
  assert.equal(classify(encode({ pid: process.pid }), { hostname }).state, 'live');
  assert.equal(classify(encode({ pid: deadPid() }), { hostname }).state, 'reclaimable');
});

// ---------------------------------------------------------------------------
// differential: the frozen pre-change logic and the real acquisition agree on
// every claim body, including the bodies the new classifier does not model
// ---------------------------------------------------------------------------

/**
 * The pre-change inline logic, frozen verbatim in behaviour: the acquisition's
 * outcomes were adopt, reclaim-and-retry, the unreadable error, the conflict
 * error, and - for a JSON body of `null` - a TypeError from reading
 * `experimentId` off the parsed value. `probe` is `process.kill(pid, 0)`-shaped.
 */
function frozenAcquireOutcome(text, { recordId, attempt = 0, hostname, probe }) {
  let existing;
  try { existing = JSON.parse(text); } catch { return 'unreadable'; }
  let adopted;
  try { adopted = existing.experimentId === recordId; } catch { return 'TypeError'; }
  if (adopted) return 'adopt';
  let stale = false;
  if (existing.hostname === hostname && Number.isInteger(existing.pid)) {
    try { probe(existing.pid); } catch (pidError) { stale = pidError?.code === 'ESRCH'; }
  }
  if (stale && attempt === 0) return 'reclaim';
  return `conflict:${existing.experimentId || 'unknown'}`;
}

/**
 * The claim-body table both the differential outcome check and the probe-order
 * check run through the real `acquireTargets()`.
 */
function claimBodyTable() {
  const hostname = os.hostname();
  const dead = deadPid();
  const body = (overrides = {}) => JSON.stringify({
    schema: 1, target: 'plugin:table', experimentId: 'exp-holder', ownerId: 'owner', pid: dead, hostname, acquiredAt: '2026-01-01T00:00:00.000Z', ...overrides,
  });
  return [
    ['complete claim, dead pid', body(), 'exp-new'],
    ['complete claim, live pid', body({ pid: process.pid }), 'exp-new'],
    ['empty file', '', 'exp-new'],
    ['truncated JSON', '{"schema":1,', 'exp-new'],
    ['JSON null', 'null', 'exp-new'],
    ['JSON array', '[]', 'exp-new'],
    ['JSON string', '"just-a-string"', 'exp-new'],
    ['JSON number', '42', 'exp-new'],
    ['missing hostname', body({ hostname: undefined }), 'exp-new'],
    ['foreign hostname', body({ hostname: 'other-host.example' }), 'exp-new'],
    ['missing pid', body({ pid: undefined }), 'exp-new'],
    ['pid 0', body({ pid: 0 }), 'exp-new'],
    ['negative pid', body({ pid: -1 }), 'exp-new'],
    ['float pid', body({ pid: 1.5 }), 'exp-new'],
    ['string pid', body({ pid: '1234' }), 'exp-new'],
    ['extra fields, dead pid', body({ extra: { nested: true }, note: 'x' }), 'exp-new'],
    ['adoption by experiment id', body({ experimentId: 'exp-adopt' }), 'exp-adopt'],
    ['adoption with unusable host and pid', body({ experimentId: 'exp-adopt', hostname: undefined, pid: 1.5 }), 'exp-adopt'],
  ];
}

/** Whether the runtime's rule can reach `process.kill` for this body: same host
 *  and an integer pid, in that order - exactly the classifier's precondition. */
function reachesLivenessProbe(text, hostname) {
  const parsed = parseTargetClaim(text);
  if (parsed.error) return false;
  const claim = parsed.parsed;
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) return false;
  return claim.hostname === hostname && Number.isInteger(claim.pid);
}

/** Whether the acquisition adopts by experiment id before it classifies. */
function isAdopted(text, recordId) {
  const parsed = parseTargetClaim(text);
  if (parsed.error) return false;
  const claim = parsed.parsed;
  return Boolean(claim && typeof claim === 'object' && !Array.isArray(claim) && claim.experimentId === recordId);
}

/** Run one claim body through the real acquisition, counting every liveness probe
 *  with a `process.kill` spy, and report whether the claim file kept its bytes. */
function runAcquisitionRow(text, recordId) {
  const { paths } = initializedHome('table');
  const target = 'plugin:table';
  const file = writeClaim(paths, target, text);
  const before = fs.readFileSync(file, 'utf8');
  const realKill = process.kill;
  let probes = 0;
  process.kill = function countedKill(pid, signal) { probes += 1; return realKill.call(process, pid, signal); };
  let outcome;
  try {
    try {
      runtimeFor(paths).acquireTargets({ id: recordId, ownerId: 'owner', targets: [target] });
      outcome = fs.readFileSync(file, 'utf8') === before ? 'adopt' : 'reclaim';
    } catch (error) {
      if (error instanceof TypeError) outcome = 'TypeError';
      else if (/^experiment ownership is unreadable for /.test(error.message)) outcome = 'unreadable';
      else {
        const conflict = /^unsafe parallel experiment conflicts on .+ \(owned by (.+)\)$/.exec(error.message);
        if (!conflict) throw error;
        outcome = `conflict:${conflict[1]}`;
      }
    }
  } finally { process.kill = realKill; }
  return { outcome, probes, bytesUnchanged: fs.readFileSync(file, 'utf8') === before };
}

test('the acquisition matches the frozen logic, probes only same-host integer pids, and rewrites only a reclaimed claim', () => {
  const hostname = os.hostname();
  for (const [label, text, recordId] of claimBodyTable()) {
    const frozen = frozenAcquireOutcome(text, { recordId, hostname, probe: (pid) => process.kill(pid, 0) });
    const { outcome, probes, bytesUnchanged } = runAcquisitionRow(text, recordId);
    assert.equal(outcome, frozen, `${label}: acquisition outcome must match the frozen logic`);
    const expectedProbes = isAdopted(text, recordId) ? 0 : reachesLivenessProbe(text, hostname) ? 1 : 0;
    assert.equal(probes, expectedProbes, `${label}: the acquisition must probe exactly ${expectedProbes} time(s)`);
    assert.equal(bytesUnchanged, frozen !== 'reclaim', `${label}: only the pre-change reclaim rewrites the claim file`);
  }
});

test('a reclaim is retried exactly once, never twice', () => {
  const { paths } = initializedHome('retry');
  const target = 'plugin:retry';
  const file = writeClaim(paths, target, { schema: 1, target, experimentId: 'exp-dead', ownerId: 'owner', pid: deadPid(), hostname: os.hostname(), acquiredAt: new Date().toISOString() });
  const realRmSync = fs.rmSync;
  // Simulate a removal that does not free the path: the next attempt must see
  // the same claim and refuse with the conflict error instead of retrying again.
  fs.rmSync = function patchedRmSync(targetPath, ...rest) {
    if (String(targetPath) === file) return undefined;
    return realRmSync.call(fs, targetPath, ...rest);
  };
  try {
    assert.throws(
      () => runtimeFor(paths).acquireTargets({ id: 'exp-new', ownerId: 'owner', targets: [target] }),
      /unsafe parallel experiment conflicts on plugin:retry \(owned by exp-dead\)/,
    );
  } finally { fs.rmSync = realRmSync; }
});

// ---------------------------------------------------------------------------
// the acquisition in isolation: errors and survivors
// ---------------------------------------------------------------------------

test('the acquisition refuses a live claim with the existing conflict error and leaves it byte-identical', () => {
  const { paths } = initializedHome('live');
  const target = 'plugin:live';
  const file = writeClaim(paths, target, { schema: 1, target, experimentId: 'exp-holder', ownerId: 'owner', pid: process.pid, hostname: os.hostname(), acquiredAt: new Date().toISOString() });
  const before = fs.readFileSync(file, 'utf8');
  const core = runtimeFor(paths);

  assert.throws(
    () => core.acquireTargets({ id: 'exp-new', ownerId: 'owner', targets: [target] }),
    /unsafe parallel experiment conflicts on plugin:live \(owned by exp-holder\)/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'a live claim is never touched');
  assert.equal(core.targetOwners.get(target), undefined);
});

test('a zero-byte claim is unreadable, blocks the acquisition, and survives it', () => {
  const { paths } = initializedHome('zero');
  const target = 'plugin:zero';
  const file = writeClaim(paths, target, '');
  const core = runtimeFor(paths);

  assert.throws(
    () => core.acquireTargets({ id: 'exp-new', ownerId: 'owner', targets: [target] }),
    /experiment ownership is unreadable for plugin:zero/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), '');
  assert.equal(core.targetOwners.get(target), undefined);
});

test('a foreign-host claim blocks the acquisition and survives it', () => {
  const { paths } = initializedHome('foreign');
  const target = 'plugin:foreign';
  const file = writeClaim(paths, target, { schema: 1, target, experimentId: 'exp-elsewhere', ownerId: 'owner', pid: 1, hostname: 'another-host.example', acquiredAt: new Date().toISOString() });
  const before = fs.readFileSync(file, 'utf8');

  assert.throws(
    () => runtimeFor(paths).acquireTargets({ id: 'exp-new', ownerId: 'owner', targets: [target] }),
    /unsafe parallel experiment conflicts on plugin:foreign \(owned by exp-elsewhere\)/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

// ---------------------------------------------------------------------------
// doctor and runtime read the same directory and the same classifier
// ---------------------------------------------------------------------------

test('the doctor reports a claim the runtime wrote, from resolveEvolutionPaths().ownershipDir', async () => {
  const { home, paths } = initializedHome('agree');
  runtimeFor(paths).acquireTargets({ id: 'exp-agree', ownerId: 'owner', targets: ['plugin:agree'] });
  const name = `${sha256('plugin:agree')}.json`;
  assert.ok(fs.existsSync(path.join(paths.ownershipDir, name)), 'the runtime wrote the claim at the doctor path');

  const report = await collectDiagnostics(baseOptions(home));
  const check = checkOf(report, 'state.ownership');
  assert.equal(check.evidence.ownershipDir, paths.ownershipDir);
  assert.deepEqual(check.evidence.claims.map((claim) => claim.name), [name]);
  assert.equal(check.level, 'degraded', 'a live in-flight trial claim is degraded, never blocked');
  assert.equal(check.evidence.states.live, 1);
  assert.equal(check.evidence.claims[0].claim.target, 'plugin:agree');
  assert.equal(check.evidence.claims[0].claim.experimentId, 'exp-agree');
  assert.equal(check.evidence.claims[0].claim.pid, process.pid);
  assert.equal(check.evidence.claims[0].claim.hostname, os.hostname());
  assert.match(check.summary, /in-flight Trial legitimately holds a claim while the app runs/);
  assert.match(check.summary, /pid reused by an unrelated process is indistinguishable/);
  assert.deepEqual(report.repairs, [], 'no repair is ever offered for a claim');
});

test('a claim whose owner is gone is degraded and is left for the next acquisition', async () => {
  const { home, paths } = initializedHome('stale-ok');
  const target = 'plugin:stale';
  const file = writeClaim(paths, target, { schema: 1, target, experimentId: 'exp-dead', ownerId: 'owner', pid: deadPid(), hostname: os.hostname(), acquiredAt: new Date().toISOString() });
  const before = fs.readFileSync(file, 'utf8');

  const report = await collectDiagnostics(baseOptions(home));
  const check = checkOf(report, 'state.ownership');
  assert.equal(check.level, 'degraded');
  assert.equal(check.evidence.states.reclaimable, 1);
  assert.match(check.summary, /the runtime's pre-existing rule reclaims a same-host claim whose integer pid it can prove gone with ESRCH/);
  assert.match(check.summary, /the next acquisition of that target on this host reclaims them/);
  assert.deepEqual(report.repairs, []);

  const repaired = await runDiagnostics({ ...baseOptions(home), repair: true });
  assert.deepEqual(repaired.repairsApplied, [], '--repair never touches a claim');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

// ---------------------------------------------------------------------------
// report-only: every blocking shape is named, none is repaired
// ---------------------------------------------------------------------------

test('a fresh byte-less claim is degraded (an acquisition may be in progress), never blocked and never repaired', async () => {
  const { home, paths } = initializedHome('zero-fresh');
  const target = 'plugin:zero-fresh';
  const file = writeClaim(paths, target, '');

  const report = await collectDiagnostics(baseOptions(home));
  const check = checkOf(report, 'state.ownership');
  assert.equal(check.level, 'degraded');
  assert.notEqual(report.status, 'blocked');
  assert.deepEqual(check.evidence.inProgressClaims, [path.basename(file)]);
  assert.deepEqual(check.evidence.blockingClaims, []);
  assert.match(check.summary, /an acquisition may be in progress, so re-run the doctor/);
  assert.deepEqual(report.repairs, []);
  assert.equal(fs.existsSync(file), true);
});

test('a settled zero-byte claim is blocked, named, and still never repaired', async () => {
  const { home, paths } = initializedHome('zero-block');
  const target = 'plugin:zero-block';
  const file = writeClaim(paths, target, '');
  ageFile(file, 60000);

  const report = await collectDiagnostics(baseOptions(home));
  const check = checkOf(report, 'state.ownership');
  assert.equal(check.level, 'blocked');
  assert.equal(report.status, 'blocked');
  assert.deepEqual(check.evidence.blockingClaims, [path.basename(file)]);
  assert.equal(check.evidence.claims[0].state, 'unreadable');
  assert.equal(check.evidence.claims[0].bytes, 0);
  assert.ok(check.evidence.claims[0].ageMs >= 60000, 'the mtime age is reported');
  assert.match(check.summary, new RegExp(path.basename(file)));
  assert.match(check.summary, /0 bytes/);
  assert.match(check.remediation, /establish that no process on any host runs an experiment/);
  assert.equal(check.recoverable, false);
  assert.deepEqual(report.repairs, [], 'the doctor offers no repair id for a claim');

  const repaired = await runDiagnostics({ ...baseOptions(home), repair: true });
  assert.deepEqual(repaired.repairsApplied, []);
  assert.equal(fs.existsSync(file), true, 'the claim file is left exactly where it was');
  const again = await runDiagnostics({ ...baseOptions(home), repair: true });
  assert.deepEqual(again.repairsApplied, [], 'a repeat run has nothing to do');
});

test('a truncated JSON claim is blocked, never repaired, and named for manual resolution', async () => {
  const { home, paths } = initializedHome('truncated');
  const target = 'plugin:truncated';
  const file = writeClaim(paths, target, '{"schema":1,"target":"plugin:truncated"');
  ageFile(file, 60000);
  const before = fs.readFileSync(file, 'utf8');

  const report = await collectDiagnostics(baseOptions(home));
  const check = checkOf(report, 'state.ownership');
  assert.equal(check.level, 'blocked');
  assert.equal(check.evidence.claims[0].state, 'unreadable');
  assert.equal(check.evidence.claims[0].bytes, before.length);
  assert.match(check.remediation, new RegExp(path.basename(file)));
  assert.match(check.remediation, /establish that no process on any host runs an experiment/);
  assert.deepEqual(report.repairs, []);

  const repaired = await runDiagnostics({ ...baseOptions(home), repair: true });
  assert.deepEqual(repaired.repairsApplied, []);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('a foreign-host claim is blocked, never repaired, and named for manual resolution', async () => {
  const { home, paths } = initializedHome('foreign-block');
  const target = 'plugin:foreign-block';
  const file = writeClaim(paths, target, { schema: 1, target, experimentId: 'exp-elsewhere', ownerId: 'owner', pid: 4242, hostname: 'another-host.example', acquiredAt: new Date().toISOString() });

  const report = await collectDiagnostics(baseOptions(home));
  const check = checkOf(report, 'state.ownership');
  assert.equal(check.level, 'blocked');
  assert.equal(check.evidence.claims[0].state, 'foreign-host');
  assert.equal(check.evidence.claims[0].claim.hostname, 'another-host.example');
  assert.match(check.summary, /foreign host another-host.example/);
  assert.match(check.remediation, new RegExp(path.basename(file)));
  assert.deepEqual(report.repairs, []);

  const repaired = await runDiagnostics({ ...baseOptions(home), repair: true });
  assert.deepEqual(repaired.repairsApplied, []);
  assert.equal(fs.existsSync(file), true);
});

test('an incomplete claim is blocked, never repaired, and names the missing field', async () => {
  const { home, paths } = initializedHome('incomplete');
  const target = 'plugin:incomplete';
  const file = writeClaim(paths, target, { schema: 1, target, experimentId: 'exp-partial', ownerId: 'owner', hostname: os.hostname() });

  const report = await collectDiagnostics(baseOptions(home));
  const check = checkOf(report, 'state.ownership');
  assert.equal(check.level, 'blocked');
  assert.equal(check.evidence.claims[0].state, 'incomplete');
  assert.match(check.summary, /incomplete: no usable integer pid/);
  assert.match(check.remediation, new RegExp(path.basename(file)));
  assert.deepEqual(report.repairs, []);
  assert.equal(fs.existsSync(file), true);
});

test('no repair implementation exists for any claim id', async () => {
  const { paths } = initializedHome('no-implementation');
  const file = writeClaim(paths, 'plugin:none', '');
  ageFile(file, 60000);
  for (const id of ['ownership-empty-claim', 'ownership-claim-repair']) {
    const applied = await applyRepairs([{ id, safe: true }], { paths });
    assert.deepEqual(applied.map((entry) => entry.status), ['skipped'], `${id} must not be implemented`);
    assert.match(applied[0].detail, /no implementation/);
  }
  assert.equal(fs.existsSync(file), true);
});

// ---------------------------------------------------------------------------
// the ownership path itself: a link is never followed to "prove" there are no
// claims behind it
// ---------------------------------------------------------------------------

test('a symlinked ownership directory is blocked, never enumerated and never reported empty', async () => {
  const { home, paths } = initializedHome('symlink-ownership');
  const real = scratch('symlink-ownership-target');
  const target = 'plugin:behind-link';
  const targetFile = path.join(real, `${sha256(target)}.json`);
  fs.writeFileSync(targetFile, JSON.stringify({ schema: 1, target, experimentId: 'exp-behind', ownerId: 'owner', pid: process.pid, hostname: os.hostname(), acquiredAt: new Date().toISOString() }));
  fs.symlinkSync(real, paths.ownershipDir, 'dir');

  const report = await collectDiagnostics(baseOptions(home));
  const check = checkOf(report, 'state.ownership');
  assert.equal(check.level, 'blocked');
  assert.equal(check.evidence.kind, 'symlink');
  assert.equal(check.evidence.linkTarget, real);
  assert.deepEqual(check.evidence.claims, [], 'the doctor does not follow the link to enumerate claims');
  assert.match(check.summary, /a symlink to /);
  assert.match(check.summary, /cannot prove which claim files it would see/);
  assert.match(check.remediation, /does not follow a link/);
  assert.deepEqual(report.repairs, []);

  const repaired = await runDiagnostics({ ...baseOptions(home), repair: true });
  assert.deepEqual(repaired.repairsApplied, []);
  assert.equal(fs.lstatSync(paths.ownershipDir).isSymbolicLink(), true, 'the link is left in place');
  assert.equal(JSON.parse(fs.readFileSync(targetFile, 'utf8')).experimentId, 'exp-behind', 'the claim behind the link is untouched');
});

test('a non-directory at the ownership path is blocked too, not treated as empty', async () => {
  const { home, paths } = initializedHome('file-ownership');
  fs.writeFileSync(paths.ownershipDir, 'not a directory\n');

  const report = await collectDiagnostics(baseOptions(home));
  const check = checkOf(report, 'state.ownership');
  assert.equal(check.level, 'blocked');
  assert.equal(check.evidence.kind, 'other');
  assert.deepEqual(check.evidence.claims, []);
  assert.match(check.summary, /a file entry/);
  assert.equal(fs.readFileSync(paths.ownershipDir, 'utf8'), 'not a directory\n');
});

// ---------------------------------------------------------------------------
// the ownership directory itself: unlistable is blocked, and a non-regular
// entry is never opened
// ---------------------------------------------------------------------------

test('a directory that cannot be listed is blocked, not reported empty, and nothing is touched', async () => {
  const { home, paths } = initializedHome('unlistable-ownership');
  const target = 'plugin:unlistable';
  const file = writeClaim(paths, target, { schema: 1, target, experimentId: 'exp-holder', ownerId: 'owner', pid: process.pid, hostname: os.hostname(), acquiredAt: new Date().toISOString() });
  const before = fs.readFileSync(file, 'utf8');
  const realReaddirSync = fs.readdirSync;
  let attempts = 0;
  fs.readdirSync = function failingList(pathname, ...rest) {
    if (String(pathname) === paths.ownershipDir) {
      attempts += 1;
      throw Object.assign(new Error('EACCES: permission denied, scandir'), { code: 'EACCES' });
    }
    return realReaddirSync.call(fs, pathname, ...rest);
  };
  let report;
  try { report = await collectDiagnostics(baseOptions(home)); }
  finally { fs.readdirSync = realReaddirSync; }

  assert.equal(attempts, 1, 'the ownership listing was attempted exactly once');
  const check = checkOf(report, 'state.ownership');
  assert.equal(check.level, 'blocked');
  assert.equal(check.evidence.kind, 'uninspectable');
  assert.equal(check.evidence.readError, 'EACCES');
  assert.deepEqual(check.evidence.claims, []);
  assert.match(check.summary, /unreadable \(EACCES\)/);
  assert.match(check.summary, /cannot prove which claim files it would see/);
  assert.equal(check.recoverable, false);
  assert.deepEqual(report.repairs, []);

  const repaired = await runDiagnostics({ ...baseOptions(home), repair: true });
  assert.deepEqual(repaired.repairsApplied, []);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the claim file is never read or changed');
});

test('a FIFO at a claim path is reported blocked without being opened', async (t) => {
  const { home, paths } = initializedHome('fifo-claim');
  const target = 'plugin:fifo';
  fs.mkdirSync(paths.ownershipDir, { recursive: true, mode: 0o700 });
  const file = claimPath(paths, target);
  try { execFileSync('mkfifo', [file]); } catch { t.skip('mkfifo is unavailable on this platform'); return; }

  const realReadFileSync = fs.readFileSync;
  let opened = 0;
  fs.readFileSync = function guardedRead(pathname, ...rest) {
    if (String(pathname) === file) {
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
  const check = checkOf(report, 'state.ownership');
  assert.equal(check.level, 'blocked');
  const claim = check.evidence.claims[0];
  assert.equal(claim.state, 'unreadable');
  assert.equal(claim.regularFile, false);
  assert.equal(claim.targetKind, 'fifo');
  assert.equal(check.evidence.inProgressClaims.length, 0, 'a non-regular entry never gets the in-progress grace');
  assert.match(check.summary, /not a regular file \(fifo\)/);
  assert.deepEqual(report.repairs, []);
  assert.equal(fs.statSync(file).isFIFO(), true, 'the FIFO is left exactly as it was');
});

// ---------------------------------------------------------------------------
// a symlinked claim entry: the runtime's readFileSync follows the link, so the
// doctor does too - and only when the final target is a regular file
// ---------------------------------------------------------------------------

test('a claim symlink to a regular file is classified like the runtime and left in place', async () => {
  const { home, paths } = initializedHome('claim-symlink-file');
  const target = 'plugin:symlinked';
  const real = scratch('claim-symlink-target');
  const realFile = path.join(real, 'real-claim.json');
  const claim = { schema: 1, target, experimentId: 'exp-symlinked', ownerId: 'owner', pid: process.pid, hostname: os.hostname(), acquiredAt: new Date().toISOString() };
  fs.writeFileSync(realFile, JSON.stringify(claim));
  fs.mkdirSync(paths.ownershipDir, { recursive: true, mode: 0o700 });
  const link = claimPath(paths, target);
  fs.symlinkSync(realFile, link);
  const beforeTarget = fs.readFileSync(realFile, 'utf8');

  const report = await collectDiagnostics(baseOptions(home));
  const check = checkOf(report, 'state.ownership');
  const entry = check.evidence.claims[0];
  assert.equal(entry.name, path.basename(link));
  assert.equal(entry.state, 'live', 'the target claim is classified, not refused because the entry is a link');
  assert.equal(entry.symlink, true);
  assert.equal(entry.regularFile, true, 'the resolved target is a regular file');
  assert.equal(entry.bytes, fs.statSync(realFile).size);
  assert.equal(entry.claim.target, target);
  assert.equal(entry.claim.experimentId, 'exp-symlinked');
  assert.equal(entry.claim.pid, process.pid);
  assert.equal(entry.claim.hostname, os.hostname());
  assert.equal(check.level, 'degraded', 'a live claim is degraded, never blocked');
  assert.equal(check.evidence.states.live, 1);
  assert.deepEqual(report.repairs, [], 'no repair is offered for a claim');

  // Neither the link nor its target is touched, by the report or by --repair.
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(link), realFile);
  const repaired = await runDiagnostics({ ...baseOptions(home), repair: true });
  assert.deepEqual(repaired.repairsApplied, []);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(link), realFile);
  assert.equal(fs.readFileSync(realFile, 'utf8'), beforeTarget);
});

test('a claim symlink to a directory is blocked and never read', async () => {
  const { home, paths } = initializedHome('claim-symlink-dir');
  const target = 'plugin:symlink-dir';
  const real = scratch('claim-symlink-dir-target');
  fs.mkdirSync(paths.ownershipDir, { recursive: true, mode: 0o700 });
  const link = claimPath(paths, target);
  fs.symlinkSync(real, link);

  const realReadFileSync = fs.readFileSync;
  let opened = 0;
  fs.readFileSync = function guardedRead(pathname, ...rest) {
    if (String(pathname) === link) {
      opened += 1;
      throw Object.assign(new Error('EISDIR: a directory claim link must not be opened'), { code: 'EISDIR' });
    }
    return realReadFileSync.call(fs, pathname, ...rest);
  };
  let report;
  try { report = await collectDiagnostics(baseOptions(home)); }
  finally { fs.readFileSync = realReadFileSync; }

  assert.equal(opened, 0, 'the doctor never opened the link');
  const check = checkOf(report, 'state.ownership');
  assert.equal(check.level, 'blocked');
  const entry = check.evidence.claims[0];
  assert.equal(entry.state, 'unreadable');
  assert.equal(entry.symlink, true);
  assert.equal(entry.regularFile, false);
  assert.equal(entry.targetKind, 'directory');
  assert.match(check.summary, /not a regular file \(directory\)/);
  assert.deepEqual(report.repairs, []);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(link), real);
  assert.equal(fs.statSync(real).isDirectory(), true, 'the link target is left exactly as it was');

  const repaired = await runDiagnostics({ ...baseOptions(home), repair: true });
  assert.deepEqual(repaired.repairsApplied, []);
  assert.equal(fs.readlinkSync(link), real);
});

test('a claim symlink to a FIFO is blocked and never read', async (t) => {
  const { home, paths } = initializedHome('claim-symlink-fifo');
  const target = 'plugin:symlink-fifo';
  const real = scratch('claim-symlink-fifo-target');
  const fifo = path.join(real, 'claim.fifo');
  try { execFileSync('mkfifo', [fifo]); } catch { t.skip('mkfifo is unavailable on this platform'); return; }
  fs.mkdirSync(paths.ownershipDir, { recursive: true, mode: 0o700 });
  const link = claimPath(paths, target);
  fs.symlinkSync(fifo, link);

  const realReadFileSync = fs.readFileSync;
  let opened = 0;
  fs.readFileSync = function guardedRead(pathname, ...rest) {
    if (String(pathname) === link || String(pathname) === fifo) {
      opened += 1;
      throw Object.assign(new Error('EAGAIN: a FIFO must not be opened'), { code: 'EAGAIN' });
    }
    return realReadFileSync.call(fs, pathname, ...rest);
  };
  let report;
  const startedAt = Date.now();
  try { report = await collectDiagnostics(baseOptions(home)); }
  finally { fs.readFileSync = realReadFileSync; }

  assert.equal(opened, 0, 'the doctor never opened the link or the FIFO');
  assert.ok(Date.now() - startedAt < 5000, 'the doctor returned promptly');
  const check = checkOf(report, 'state.ownership');
  assert.equal(check.level, 'blocked');
  const entry = check.evidence.claims[0];
  assert.equal(entry.state, 'unreadable');
  assert.equal(entry.symlink, true);
  assert.equal(entry.regularFile, false);
  assert.equal(entry.targetKind, 'fifo');
  assert.match(check.summary, /not a regular file \(fifo\)/);
  assert.equal(check.evidence.inProgressClaims.length, 0, 'a non-regular entry never gets the in-progress grace');
  assert.deepEqual(report.repairs, []);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(link), fifo);
  assert.equal(fs.statSync(fifo).isFIFO(), true, 'the FIFO is left exactly as it was');
});
