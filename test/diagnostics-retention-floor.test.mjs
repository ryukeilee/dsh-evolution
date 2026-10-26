import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectDiagnostics, resolveEvolutionPaths } from '../lib/diagnostics.js';
import { digestLogBytes, inspectEventLogFloor } from '../lib/event-log-checkpoint.js';

const key = 'a'.repeat(64);
const prior = Buffer.from(' \n\n');
const tail = Buffer.from('\n');
const retention = { schema: 1, markers: { pruned: 0, chain: '0'.repeat(64) }, log: {
  bytes: 2, records: 0, prior: { bytes: prior.length, digest: digestLogBytes(key, prior) },
  tail: { bytes: tail.length, digest: digestLogBytes(key, tail) },
} };

for (const pending of [false, true]) for (const [name, bytes, status, level] of [
  ['retained', tail, 'already-truncated', 'ok'],
  ['deferred', prior, 'deferred', 'degraded'],
  ['empty', Buffer.alloc(0), 'unknown', 'blocked'],
  ['changed', Buffer.from('x\n'), 'unknown', 'blocked'],
  ['missing', null, 'absent', 'blocked'],
]) test(`doctor ${pending ? 'pending ' : ''}floor ${name} preserves bytes`, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-floor-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = resolveEvolutionPaths({ dshHome: home });
  fs.mkdirSync(paths.dataRoot, { recursive: true });
  fs.writeFileSync(paths.keyPath, key, { mode: 0o600 });
  const aggregate = { evolution: { schema: 4, observations: [], proposals: [] } };
  const stage = 'stage-12345678-1234-1234-1234-123456789abc';
  if (pending) fs.mkdirSync(path.join(paths.domainStagingDir, stage), { recursive: true });
  fs.writeFileSync(paths.domainGlobalPath, JSON.stringify({ unit: { name: 'evolution_domain', version: 1 }, global: {
    schema: 1, aggregate, applied: {}, ...(pending
      ? { pending: { stage, aggregate, applied: {}, retention, files: [] } }
      : { pending: null, retention }),
  }, tables: {} }));
  if (bytes !== null) fs.writeFileSync(paths.eventBridgePath, bytes);
  const report = await collectDiagnostics({ dshHome: home, composition: false, probe: false });
  const check = report.checks.find((entry) => entry.id === 'state.retention-floor');
  assert.equal(check.evidence.status, status);
  assert.equal(check.level, level);
  assert.equal(check.recoverable, false);
  assert.equal(check.repair, undefined);
  if (bytes === null) assert.equal(fs.existsSync(paths.eventBridgePath), false);
  else assert.deepEqual(fs.readFileSync(paths.eventBridgePath), bytes);
});

test('shared classifier accepts a deferred prior with appended bytes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floor-classify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'log');
  const original = Buffer.from('old\nkept\n');
  const kept = Buffer.from('kept\n');
  const floor = { log: { prior: { bytes: original.length, digest: digestLogBytes(key, original) }, tail: { bytes: kept.length, digest: digestLogBytes(key, kept) } } };
  fs.writeFileSync(file, Buffer.concat([original, Buffer.from('new\n')]));
  assert.equal(inspectEventLogFloor({ file, key, floor }).status, 'deferred');
});

test('doctor reports seal temporaries without changing them', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-seal-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = resolveEvolutionPaths({ dshHome: home });
  const directory = path.join(paths.dockyardDir, 'state.json.observations-archive.jsonl.segments');
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, '.segment-12345678-1234-1234-1234-123456789abc.tmp');
  fs.writeFileSync(temporary, 'preserved');
  const report = await collectDiagnostics({ dshHome: home, composition: false, probe: false });
  const check = report.checks.find((entry) => entry.id === 'state.archives');
  assert.equal(check.level, 'degraded');
  assert.equal(check.evidence.dockyard.sealTemporaries.length, 1);
  assert.equal(check.repair, undefined);
  assert.equal(fs.readFileSync(temporary, 'utf8'), 'preserved');
});

test('shared classifier rejects contradictory prior and tail digests', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floor-digest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'log');
  fs.writeFileSync(file, prior);
  const bad = structuredClone(retention);
  bad.log.tail.digest = digestLogBytes(key, Buffer.from('x'));
  assert.equal(inspectEventLogFloor({ file, key, floor: bad }).status, 'unknown');
  assert.deepEqual(fs.readFileSync(file), prior);
});

// The floor is not keyed, so the shape the doctor can check is the document's own
// continuity: the pruned-marker chain is the only evidence that the markers a
// reclaim removed ever existed, and the cumulative counters may only grow. A
// document that violates one of those was not written by this version. It used to
// be reported as `already-truncated`/ok whenever the retained bytes still matched
// its digest, which is the one conclusion the doctor must not draw from a floor it
// cannot trust.
const chain = 'b'.repeat(64);
for (const [name, inconsistent] of Object.entries({
  'pruned markers with the empty chain': { ...retention, markers: { pruned: 5, chain: '0'.repeat(64) } },
  'a chain with no pruned markers': { ...retention, markers: { pruned: 0, chain } },
  'cumulative bytes below the last discard': { ...retention, log: { ...retention.log, bytes: 1 } },
  'one digest for the discarded file and the retained tail': {
    ...retention,
    log: { ...retention.log, tail: { bytes: retention.log.tail.bytes, digest: retention.log.prior.digest } },
  },
})) test(`doctor reports an inconsistent floor: ${name}`, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-floor-continuity-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = resolveEvolutionPaths({ dshHome: home });
  fs.mkdirSync(paths.dataRoot, { recursive: true });
  fs.writeFileSync(paths.keyPath, key, { mode: 0o600 });
  fs.writeFileSync(paths.domainGlobalPath, JSON.stringify({ unit: { name: 'evolution_domain', version: 1 }, global: {
    schema: 1, aggregate: { evolution: { schema: 4, observations: [], proposals: [] } }, applied: {}, pending: null, retention: inconsistent,
  }, tables: {} }));
  fs.writeFileSync(paths.eventBridgePath, tail);
  const report = await collectDiagnostics({ dshHome: home, composition: false, probe: false });
  const check = report.checks.find((entry) => entry.id === 'state.retention-floor');
  assert.equal(check.evidence.status, 'floor-inconsistent');
  assert.equal(check.level, 'blocked');
  assert.equal(check.recoverable, false);
  assert.equal(check.repair, undefined);
  assert.ok(check.evidence.floorProblems.length > 0);
  assert.equal(check.evidence.floorSource, 'committed');
  assert.deepEqual(fs.readFileSync(paths.eventBridgePath), tail, 'the doctor preserves the log it judged');
});

test('a pending floor with no committed floor is judged once, as pending', async (t) => {
  // The first-ever reclaim writes a pending record on a root that has no committed
  // floor yet. That document must be judged under its own scope only: reading it
  // into the committed slot reports every finding twice.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-floor-pending-only-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = resolveEvolutionPaths({ dshHome: home });
  fs.mkdirSync(paths.dataRoot, { recursive: true });
  fs.writeFileSync(paths.keyPath, key, { mode: 0o600 });
  const pending = { ...retention, markers: { pruned: 0, chain } };
  const stage = 'stage-12345678-1234-1234-1234-123456789abc';
  fs.mkdirSync(path.join(paths.domainStagingDir, stage), { recursive: true });
  fs.writeFileSync(paths.domainGlobalPath, JSON.stringify({ unit: { name: 'evolution_domain', version: 1 }, global: {
    schema: 1, aggregate: { evolution: { schema: 4, observations: [], proposals: [] } }, applied: {},
    pending: { stage, aggregate: { evolution: { schema: 4 } }, applied: {}, files: [], retention: pending },
  }, tables: {} }));
  fs.writeFileSync(paths.eventBridgePath, tail);
  const report = await collectDiagnostics({ dshHome: home, composition: false, probe: false });
  const check = report.checks.find((entry) => entry.id === 'state.retention-floor');
  assert.equal(check.evidence.status, 'floor-inconsistent');
  assert.equal(check.evidence.floorSource, 'pending');
  assert.deepEqual(check.evidence.floorProblems.map((problem) => problem.scope), ['pending']);
  assert.deepEqual(check.evidence.floorProblems.map((problem) => problem.code), ['marker-chain-without-pruned-markers']);
});

test('doctor judges the pending floor against the committed one it would replace', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-floor-pending-regression-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = resolveEvolutionPaths({ dshHome: home });
  fs.mkdirSync(paths.dataRoot, { recursive: true });
  fs.writeFileSync(paths.keyPath, key, { mode: 0o600 });
  // A completed reclaim pruned 12 markers; the pending record would install a
  // floor that claims only 4, so `installPending()` would un-prove eight of them.
  const committed = { ...retention, markers: { pruned: 12, chain }, log: { ...retention.log, bytes: 24, records: 4 } };
  const pending = { ...committed, markers: { pruned: 4, chain: 'c'.repeat(64) } };
  const stage = 'stage-12345678-1234-1234-1234-123456789abc';
  fs.mkdirSync(path.join(paths.domainStagingDir, stage), { recursive: true });
  fs.writeFileSync(paths.domainGlobalPath, JSON.stringify({ unit: { name: 'evolution_domain', version: 1 }, global: {
    schema: 1, aggregate: { evolution: { schema: 4, observations: [], proposals: [] } }, applied: {},
    pending: { stage, aggregate: { evolution: { schema: 4 } }, applied: {}, files: [], retention: pending },
    retention: committed,
  }, tables: {} }));
  fs.writeFileSync(paths.eventBridgePath, tail);
  const report = await collectDiagnostics({ dshHome: home, composition: false, probe: false });
  const check = report.checks.find((entry) => entry.id === 'state.retention-floor');
  assert.equal(check.evidence.status, 'floor-inconsistent');
  assert.equal(check.level, 'blocked');
  assert.equal(check.evidence.floorSource, 'pending');
  assert.deepEqual(check.evidence.floorProblems.map((problem) => problem.code), ['floor-regression-markers']);
  assert.equal(fs.existsSync(path.join(paths.domainStagingDir, stage)), true, 'the doctor never installs or removes a stage');
});

for (const [name, mutatePending, code] of [
  ['cumulative log bytes', (committed) => ({ ...committed, log: { ...committed.log, bytes: 3 } }), 'floor-regression-log-bytes'],
  ['the log claim itself', (committed) => ({ ...committed, log: null }), 'floor-regression-log-claim'],
]) test(`doctor reports a pending floor behind the committed one: ${name}`, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-floor-pending-log-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = resolveEvolutionPaths({ dshHome: home });
  fs.mkdirSync(paths.dataRoot, { recursive: true });
  fs.writeFileSync(paths.keyPath, key, { mode: 0o600 });
  // The committed floor stands on its own (`bytes` 24 covers its last discard of
  // 2); only the rebuild *behind* it is wrong, so exactly one rule may fire.
  const committed = { ...retention, markers: { pruned: 12, chain }, log: { ...retention.log, bytes: 24, records: 4 } };
  const pending = mutatePending(committed);
  const stage = 'stage-12345678-1234-1234-1234-123456789abc';
  fs.mkdirSync(path.join(paths.domainStagingDir, stage), { recursive: true });
  fs.writeFileSync(paths.domainGlobalPath, JSON.stringify({ unit: { name: 'evolution_domain', version: 1 }, global: {
    schema: 1, aggregate: { evolution: { schema: 4, observations: [], proposals: [] } }, applied: {},
    pending: { stage, aggregate: { evolution: { schema: 4 } }, applied: {}, files: [], retention: pending },
    retention: committed,
  }, tables: {} }));
  fs.writeFileSync(paths.eventBridgePath, tail);
  const report = await collectDiagnostics({ dshHome: home, composition: false, probe: false });
  const check = report.checks.find((entry) => entry.id === 'state.retention-floor');
  assert.equal(check.evidence.status, 'floor-inconsistent');
  assert.equal(check.level, 'blocked');
  assert.deepEqual(check.evidence.floorProblems, [{
    scope: 'pending', code,
    message: check.evidence.floorProblems[0].message,
  }]);
});

test('doctor reports the floor counters and any reclaim temporary without changing either', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-floor-counters-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = resolveEvolutionPaths({ dshHome: home });
  fs.mkdirSync(paths.dataRoot, { recursive: true });
  fs.writeFileSync(paths.keyPath, key, { mode: 0o600 });
  fs.writeFileSync(paths.domainGlobalPath, JSON.stringify({ unit: { name: 'evolution_domain', version: 1 }, global: {
    schema: 1, aggregate: { evolution: { schema: 4, observations: [], proposals: [] } }, applied: {}, pending: null, retention,
  }, tables: {} }));
  fs.writeFileSync(paths.eventBridgePath, tail);
  const temporary = `${paths.eventBridgePath}.0123456789abcdef.reclaim.tmp`;
  fs.writeFileSync(temporary, 'B');
  const report = await collectDiagnostics({ dshHome: home, composition: false, probe: false });
  const check = report.checks.find((entry) => entry.id === 'state.retention-floor');
  // A temporary is residue of a rewrite the next completion removes; listing it
  // must not turn a consistent floor into a failure.
  assert.equal(check.evidence.status, 'already-truncated');
  assert.equal(check.level, 'ok');
  assert.deepEqual(check.evidence.reclaimTemporaries, [path.basename(temporary)]);
  assert.equal(check.evidence.floorSource, 'committed');
  assert.deepEqual(check.evidence.floor.log, { bytes: 2, records: 0, prior: prior.length, tail: tail.length });
  assert.equal(check.repair, undefined);
  assert.equal(fs.readFileSync(temporary, 'utf8'), 'B');
  assert.deepEqual(fs.readFileSync(paths.eventBridgePath), tail);
});
