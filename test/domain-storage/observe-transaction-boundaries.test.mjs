import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { openDomainStorage } from '../../lib/domain-storage.js';

const patternKey = `autonomous-v1:${'a'.repeat(64)}`;
const dto = id => ({ type: 'agent/error', code: 'AGENT_ERROR', observationId: id, patternKey });
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-observe-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return async () => {
    const backend = new JsonStorageBackend(path.join(root, 'official'));
    const ctx = { emit() {}, effect() {}, logger: { warn() {} }, storage: { backend: { get: () => backend } } };
    ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
    const port = await openDomainStorage(ctx, { presetDir: root, eventBridgePath: path.join(root, 'events.jsonl'), eventBridgeKey: 'b'.repeat(64) });
    t.after(() => backend.close());
    return { port, domain: ctx.storageDomain.get('evolution_domain'), ids: () => port.autonomousObservations().map(row => row.observationId) };
  };
}

test('concurrent valid observations survive a failing neighbour and restart', async t => {
  const open = await fixture(t);
  const s = await open();
  const bad = { get code() { throw new Error('INJECTED_OBSERVATION'); } };
  const results = await Promise.allSettled([s.port.observe(dto('first')), s.port.observe(bad), s.port.observe(dto('last'))]);
  assert.deepEqual(results.map(row => row.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.deepEqual(s.ids(), ['first', 'last']);
  await assert.rejects(s.port.close(), /INJECTED_OBSERVATION/);
  const next = await open();
  assert.deepEqual(next.ids(), ['first', 'last']);
  await next.port.close();
});

for (const afterCommit of [false, true]) test(`a ${afterCommit ? 'post' : 'pre'}-commit refusal does not reject later observations`, async t => {
  const open = await fixture(t);
  const s = await open();
  const set = s.domain.global.set.bind(s.domain.global);
  let fail = true;
  s.domain.global.set = async value => {
    if (!fail) return set(value);
    fail = false;
    if (afterCommit) await set(value);
    throw new Error('INJECTED_COMMIT');
  };
  const results = await Promise.allSettled(['first', 'second', 'last'].map(id => s.port.observe(dto(id))));
  assert.deepEqual(results.map(row => row.status), ['rejected', 'fulfilled', 'fulfilled']);
  const expected = afterCommit ? ['first', 'second', 'last'] : ['second', 'last'];
  assert.deepEqual(s.ids(), expected);
  await assert.rejects(s.port.close(), /INJECTED_COMMIT/);
  const next = await open();
  assert.deepEqual(next.ids(), expected);
  await next.port.close();
});

test('flush and reservation keep their observation prefix; close drains accepted writes and duplicate IDs', async t => {
  const open = await fixture(t);
  const s = await open();
  const set = s.domain.global.set.bind(s.domain.global);
  const publications = [];
  s.domain.global.set = async value => {
    publications.push({ ids: value.aggregate.evolution.observations.map(row => row.id),
      decisions: value.aggregate.evolution.autonomous?.observerDecisions ?? [] });
    return set(value);
  };
  const identity = `${'a'.repeat(64)}:${'b'.repeat(64)}`;
  const first = s.port.observe(dto('first'));
  const flush = s.port.flush().then(() => {
    assert.deepEqual(s.domain.global.get().aggregate.evolution.observations.map(row => row.id), ['first']);
  });
  const reserve = s.port.reserveAutonomousDecision(identity);
  const last = s.port.observe(dto('last'));
  const duplicate = s.port.observe(dto('last'));
  const close = s.port.close();
  await assert.rejects(s.port.observe(dto('too-late')), /E_DOMAIN_CLOSED/);
  await Promise.all([first, flush, reserve, last, duplicate, close]);
  const reservation = publications.find(row => row.decisions.includes(identity));
  assert.deepEqual(reservation.ids, ['first']);
  assert.deepEqual(publications[0].ids, ['first']);
  const next = await open();
  assert.deepEqual(next.ids(), ['first', 'last']);
  assert.deepEqual(await next.port.autonomousDecisions(), [identity]);
  await next.port.close();
});
