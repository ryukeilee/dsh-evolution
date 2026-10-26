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
