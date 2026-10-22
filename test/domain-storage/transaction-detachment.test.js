// The transaction must stay detached from the shared document.
//
// `mutate()` builds its working store from `domain.global.get().aggregate`:
// `createMemory()` clones that value once, before anything else runs, and the
// store it hands to the memory is that clone. The clone is what separates the
// transaction from the document every other port and every `domain/changed`
// listener can write to - and it is also the step that refuses a live value the
// medium could never store, before any staging or work happens.
//
// The tests below pin that boundary from the outside: a committed aggregate
// carrying a value `structuredClone` cannot copy makes the next new-event
// transaction fail with nothing durable moved, and the event is still applied
// exactly once by the pass that follows the repair. They pass against the
// pre-change implementation as well; they exist because the redundant copy this
// round removes lives in the same three lines, and removing the wrong one would
// silently break this boundary instead of making the transaction cheaper.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evolutionDomainSpec, openDomainStorage } from '../../lib/domain-storage.js';
import { signEventBridgeEnvelope } from '../../lib/orchestrator.js';
import { eventLogCheckpointPath } from '../../lib/event-log-checkpoint.js';
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

const KEY = 'b'.repeat(64);
const EVENT = (sequence) => ({ schema: 1, eventId: `evolution:measurement-completed:detach-${sequence}`,
  eventType: 'measurement-completed', experimentId: `detach-${sequence}`, proposalId: `proposal:detach-${sequence}`,
  target: 'plugin:detach', capability: 'plugin:detach', lineageId: 'plugin:detach', status: 'measured',
  measurement: { latency: 1 }, audit: { at: '2026-10-07T00:00:00.000Z' } });

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-detach-'));
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const listeners = new Map();
  const ctx = {
    emit(name, ...args) { for (const listener of listeners.get(name) ?? []) listener(...args); },
    on(name, listener) {
      const registered = listeners.get(name) ?? [];
      registered.push(listener);
      listeners.set(name, registered);
      return () => { const index = registered.indexOf(listener); if (index >= 0) registered.splice(index, 1); };
    },
    logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {},
  };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'), eventBridgeKey: KEY };
  return { root, ctx, config, backend };
}

/** Every durable artifact, plus the staged directories a refused transaction may
 *  not leave behind. */
function durableState(f) {
  const documents = path.join(f.root, 'official');
  const files = {};
  for (const name of fs.readdirSync(documents).sort()) files[`official/${name}`] = fs.readFileSync(path.join(documents, name), 'utf8');
  const staging = path.join(f.root, 'domain-staging');
  const staged = fs.existsSync(staging) ? fs.readdirSync(staging).sort() : [];
  const archive = path.join(f.root, 'dockyard');
  const archived = fs.existsSync(archive) ? fs.readdirSync(archive).sort().map((name) => [name, fs.readFileSync(path.join(archive, name), 'utf8')]) : [];
  return { files, staged, archived, checkpoint: fs.existsSync(eventLogCheckpointPath(f.root)) ? fs.readFileSync(eventLogCheckpointPath(f.root), 'utf8') : null };
}

function append(f, sequence) {
  const envelope = signEventBridgeEnvelope(EVENT(sequence), { key: KEY, sequence });
  fs.appendFileSync(f.config.eventBridgePath, `${JSON.stringify(envelope)}\n`);
  return envelope;
}

test('a committed aggregate the medium could not store refuses the transaction before anything moves', async () => {
  const f = await fixture();
  try {
    const port = await openDomainStorage(f.ctx, f.config);
    // A live value `structuredClone` cannot copy, installed through the official
    // handle the way a same-process writer would.
    const domain = f.ctx.storageDomain.get(evolutionDomainSpec.name);
    const document = domain.global.get();
    const live = structuredClone(document);
    live.aggregate = { evolution: { schema: 5, observations: [{ id: 'poison', fn: () => 'x' }] } };
    await domain.global.set(live);
    append(f, 1);
    const before = durableState(f);
    await assert.rejects(port.flush(), (error) => /could not be cloned|DataClone/.test(String(error?.message ?? error)) || error?.name === 'DataCloneError', 'the clone refuses a live value the medium could never store');
    const after = durableState(f);
    assert.deepEqual(after.files, before.files, 'a refused transaction writes no durable document and no checkpoint');
    assert.deepEqual(after.archived, before.archived, 'a refused transaction installs no archive file');
    assert.equal(after.checkpoint, before.checkpoint, 'a refused transaction does not advance the replay checkpoint');
    // The stage the mirror created before the clone is orphaned, exactly as a
    // crash before the pending record leaves it: nothing durable names it, so
    // recovery never installs it.
    assert.equal(JSON.parse(after.files['official/evolution_domain.json']).global.pending, null, 'no durable record names the stage');
    // Repair the document, then the same record must be applied exactly once.
    await domain.global.set({ schema: 1, aggregate: {}, applied: document.applied, pending: null });
    const applied = await port.flush();
    assert.deepEqual(applied, { applied: 1, duplicates: 0 }, 'the refused record is applied exactly once afterwards');
    const second = await port.flush();
    assert.deepEqual(second, { applied: 0, duplicates: 1 }, 'and never a second time');
    // A failed transaction is remembered and rethrown when the port closes (the
    // failure the caller already saw), which is the documented close contract.
    await port.close().catch((error) => assert.equal(error.name, 'DataCloneError'));
  } finally { await f.backend.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('an in-place edit of the committed aggregate is what the next transaction starts from', async () => {
  const f = await fixture();
  try {
    const port = await openDomainStorage(f.ctx, f.config);
    const domain = f.ctx.storageDomain.get(evolutionDomainSpec.name);
    const document = domain.global.get();
    const row = { id: 'live-row', status: 'recorded', summary: 'written in place' };
    document.aggregate.evolution = { schema: 5, observations: [row] };
    append(f, 1);
    await port.flush();
    // The transaction cloned the live document, so the row it read is durable.
    const stored = JSON.parse(fs.readFileSync(path.join(f.root, 'official', 'evolution_domain.json'), 'utf8'));
    assert.equal(stored.global.aggregate.evolution.observations[0].id, 'live-row');
    // And the document the commit published is a fresh projection, not the live
    // object: editing the live aggregate again cannot retroactively change it.
    const published = domain.global.get();
    assert.notEqual(published.aggregate, document.aggregate, 'the published aggregate is a new object');
    document.aggregate.evolution.observations.push({ id: 'later-row' });
    assert.equal(published.aggregate.evolution.observations.length, 1);
    await port.close();
  } finally { await f.backend.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});
