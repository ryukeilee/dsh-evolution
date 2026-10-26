import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { configFor, emit, openFixture } from './retention-boundary-worker.mjs';
import { readEvidenceSnapshot, externalizeEventBridgeEvidence } from '../lib/orchestrator.js';
import { EvolutionMemory } from '../lib/dockyard-domain/memory.js';
import { JsonStateStore } from './dockyard-domain/support.js';

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-boundaries-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function child(t, root, mode, prefix = '') {
  const proc = fork(new URL('./retention-boundary-worker.mjs', import.meta.url), ['--worker', root, mode, prefix],
    { execArgv: ['--max-old-space-size=4096'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  proc.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); });
  const message = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`child timeout: ${mode}: ${stderr}`)); }, 20000);
    const onMessage = value => { cleanup(); value.error ? reject(new Error(value.error)) : resolve(value); };
    const onExit = code => { cleanup(); reject(new Error(`child exited ${code}: ${stderr}`)); };
    function cleanup() { clearTimeout(timer); proc.off('message', onMessage); proc.off('exit', onExit); }
    proc.once('message', onMessage); proc.once('exit', onExit);
  });
  return { proc, message };
}

test('two concurrent process writers survive reclaim and repeated no-op reclaim', { timeout: 30000 }, async t => {
  const root = scratch(t);
  const f = await openFixture(root);
  try {
    const writers = [child(t, root, 'write', 'left'), child(t, root, 'write', 'right')];
    await Promise.all(writers.map(w => w.message()));
    const done = writers.map(w => w.message());
    writers.forEach(w => w.proc.send('go'));
    await Promise.all(done);
    assert.deepEqual(await f.port.flush(), { applied: 32, duplicates: 0 });
    const first = await f.port.reclaim({ confirmation: true, archives: false, retainRecords: 3 });
    assert.equal(first.log.prunedMarkers, 29);
    const bytes = fs.readFileSync(configFor(root).eventBridgePath);
    const floor = structuredClone(f.global().retention);
    for (let round = 0; round < 3; round++) {
      const report = await f.port.reclaim({ confirmation: true, archives: false, retainRecords: 3 });
      assert.equal(report.log.status, 'nothing-absorbed');
      assert.deepEqual(fs.readFileSync(configFor(root).eventBridgePath), bytes);
      assert.deepEqual(f.global().retention, floor);
    }
    const rows = bytes.toString().trim().split('\n').map(JSON.parse);
    assert.equal(new Set(rows.map(r => r.event.eventId)).size, 3);
    assert.deepEqual(await f.port.flush(), { applied: 0, duplicates: 3 });
  } finally { await f.close(); }
});

test('process appenders between prune planning and floor commit keep all new records', { timeout: 30000 }, async t => {
  const root = scratch(t);
  const writers = [child(t, root, 'write', 'during-left'), child(t, root, 'write', 'during-right')];
  await Promise.all(writers.map(w => w.message()));
  let appended = false;
  const f = await openFixture(root, { externalizeEventEvidence: async entries => {
    assert.equal(appended, false);
    const done = writers.map(w => w.message());
    writers.forEach(w => w.proc.send('go'));
    await Promise.all(done);
    appended = true;
    return externalizeEventBridgeEvidence({ archiveDir: configFor(root).archiveDir }, entries);
  } });
  try {
    for (let i = 0; i < 8; i++) emit(root, `before-${i}`);
    assert.equal((await f.port.flush()).applied, 8);
    const report = await f.port.reclaim({ confirmation: true, archives: false, retainRecords: 2 });
    assert.equal(appended, true);
    assert.equal(report.log.prunedMarkers, 6);
    assert.equal(report.log.truncated, 'truncated');
    assert.deepEqual(await f.port.flush(), { applied: 32, duplicates: 2 });
    const rows = fs.readFileSync(configFor(root).eventBridgePath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 34);
    const ids = new Set(rows.map(row => row.event.experimentId));
    for (const prefix of ['during-left', 'during-right']) {
      for (let i = 0; i < 16; i++) assert.ok(ids.has(`${prefix}-${i}`));
    }
    assert.equal(Object.keys(f.global().applied).length, 34);
    assert.deepEqual(await f.port.flush(), { applied: 0, duplicates: 34 });
  } finally { await f.close(); }
});

test('live child append lock refuses a contender; SIGKILL and fresh process complete committed floor', { timeout: 30000 }, async t => {
  const root = scratch(t);
  let f = await openFixture(root);
  for (let i = 0; i < 12; i++) emit(root, `crash-${i}`);
  await f.port.flush();
  await f.close();
  const prior = fs.readFileSync(configFor(root).eventBridgePath);
  const crashing = child(t, root, 'crash');
  const committed = await crashing.message();
  assert.equal(committed.report.log.truncated, 'deferred');
  assert.equal(Object.keys(committed.global.applied).length, 2);
  assert.deepEqual(fs.readFileSync(configFor(root).eventBridgePath), prior);
  const blocked = child(t, root, 'probe-lock');
  await assert.rejects(blocked.message(), /lock.*busy|lock.*held|append.*lock/i);
  assert.deepEqual(fs.readFileSync(configFor(root).eventBridgePath), prior);
  const exited = once(crashing.proc, 'exit');
  crashing.proc.kill('SIGKILL');
  await exited;
  // Appending after the dead lock is recovered but before floor completion is legitimate.
  emit(root, 'after-crash');
  const recovered = await child(t, root, 'recover').message();
  assert.deepEqual(recovered.flush, { applied: 0, duplicates: 3 });
  assert.equal(Object.keys(recovered.global.applied).length, 3);
  assert.equal(recovered.global.pending, null);
  const rows = fs.readFileSync(configFor(root).eventBridgePath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 3);
  assert.ok(rows.some(row => row.event.experimentId === 'after-crash'));
  const again = await child(t, root, 'recover').message();
  assert.deepEqual(again.global.retention, recovered.global.retention);
  assert.deepEqual(again.flush, recovered.flush);
});

test('promotion and knowledge dense history keeps every sidecar and canonical knowledge after reclaim', { timeout: 30000 }, async t => {
  const root = scratch(t);
  const f = await openFixture(root);
  try {
    for (let i = 0; i < 24; i++) {
      emit(root, `dense-${i}`, 'experiment-rejected');
      emit(root, `dense-${i}`, 'promotion-succeeded');
    }
    assert.equal((await f.port.flush()).applied, 48);
    const before = await f.port.query('knowledge', 100);
    const knowledge = structuredClone(f.global().aggregate.evolution.knowledge);
    assert.ok(before.count >= 24, 'fixture must actually populate canonical knowledge');
    const report = await f.port.reclaim({ confirmation: true, archives: true, retainRecords: 1 });
    assert.equal(report.log.prunedMarkers, 47);
    for (let i = 0; i < 23; i++) {
      const sidecar = await readEvidenceSnapshot(configFor(root).archiveDir, `dense-${i}`);
      assert.equal(sidecar.runtimeRecovered, true);
      assert.equal(sidecar.durable.pluginName, `plugin-dense-${i}`);
    }
    assert.deepEqual(await f.port.query('knowledge', 100), before);
    assert.deepEqual(f.global().aggregate.evolution.knowledge, knowledge, 'full canonical payloads survive, not only query metadata');
  } finally { await f.close(); }
});

test('multi-MiB historical archive segment compacts with valid index and no resurrected source rows', { timeout: 30000 }, async t => {
  const root = scratch(t);
  const store = new JsonStateStore({ filePath: path.join(root, 'state.json') });
  const observations = Array.from({ length: 8 }, (_, i) => ({ id: `large-${i}`, type: 'component/observation',
    severity: 'info', componentId: 'large-fixture', recordedAt: '2026-10-27T00:00:00.000Z',
    payload: 'x'.repeat(512 * 1024), metrics: { usageCount: i + 1 } }));
  await store.save({ evolution: { observations: [] } });
  const segments = path.join(root, 'state.json.observations-archive.jsonl.segments');
  fs.mkdirSync(segments);
  fs.writeFileSync(path.join(segments, 'segment-000000000001.jsonl'), observations.map(row => JSON.stringify(row)).join('\n') + '\n');
  const make = () => {
    const memory = new EvolutionMemory({ stateStore: store, hotEntries: 1, archiveMaxBytes: 3 * 1024 * 1024,
      absoluteMaxSegmentBytes: 8 * 1024 * 1024 });
    memory.setMutationAuthority({ assertMutation() {}, isActive: () => true });
    return memory;
  };
  const memory = make();
  await memory.load();
  assert.ok(fs.readdirSync(segments).some(name => fs.statSync(path.join(segments, name)).size >= 3 * 1024 * 1024));
  await memory.compact();
  const reopened = make();
  await reopened.load();
  assert.equal((await reopened.verifyConsistency()).archive.valid, true);
  assert.equal(reopened.history('observations').some(row => /^large-\d+$/.test(row.id)), false);
});
