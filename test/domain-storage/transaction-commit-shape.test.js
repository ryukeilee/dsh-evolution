// The durable shape of one domain transaction.
//
// A transaction's archive stage exists to sequence "the staged bytes are durable"
// before "the aggregate that describes them is durable": the pending record
// publishes that order, and a second write clears it once the staged files are
// installed. A transaction whose change list is empty has nothing to sequence -
// there are no staged bytes and no install - so it publishes the document it ends
// at in one write. These tests pin what that means:
//
//  - no archive change: exactly one publication, `pending` null before and after,
//    no staging directory left behind, and the record committed;
//  - archive change: still a pending record and then a close, with the staged file
//    installed by the close;
//  - a failure raised before the medium replaces the document publishes nothing at
//    all and leaves the event in the log, so the next pass applies it exactly once;
//  - a failure raised at the backend's directory fsync, after the unit was already
//    renamed into place, makes the medium and the port's own handle disagree (the
//    replacement is visible, the handle still holds the previous document); the
//    event is still applied exactly once after a restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { evolutionDomainSpec, openDomainStorage } from '../../lib/domain-storage.js';
import { signEventBridgeEnvelope } from '../../lib/orchestrator.js';
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

const KEY = 'b'.repeat(64);

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-commit-shape-'));
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

async function teardown(f) { await f.backend.close(); fs.rmSync(f.root, { recursive: true, force: true }); }

function eventFor(id, type = 'measurement-completed', extra = {}) {
  return { schema: 1, eventId: `evolution:${type}:${id}`, eventType: type, experimentId: id,
    proposalId: `proposal:${id}`, target: 'plugin:shape', capability: 'plugin:shape', lineageId: 'plugin:shape',
    status: 'measured', measurement: { latency: 1 }, ...extra, audit: { at: '2026-10-07T00:00:00.000Z' } };
}

function append(f, event, sequence) {
  const envelope = signEventBridgeEnvelope(event, { key: KEY, sequence });
  fs.appendFileSync(f.config.eventBridgePath, `${JSON.stringify(envelope)}\n`);
  return envelope;
}

/** Count the durable publications of the shared document, split by phase. */
function countPublications(f) {
  const counted = { commits: 0, closes: 0 };
  f.ctx.on('domain/changed', (change) => {
    if (change?.domain !== evolutionDomainSpec.name) return;
    if (change.value?.pending) counted.commits += 1;
    else counted.closes += 1;
  });
  return counted;
}

const documentOf = (f) => {
  const file = path.join(f.root, 'official', 'evolution_domain.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).global : null;
};
const stagedDirectories = (f) => {
  const staging = path.join(f.root, 'domain-staging');
  return fs.existsSync(staging) ? fs.readdirSync(staging).filter((name) => name.startsWith('stage-')) : [];
};
const archiveFiles = (f) => {
  const root = path.join(f.root, 'dockyard');
  return fs.existsSync(root) ? fs.readdirSync(root).filter((name) => name.includes('-archive')) : [];
};

test('a transaction that changed no archive file commits in one write', async () => {
  const f = await fixture();
  const port = await openDomainStorage(f.ctx, f.config);
  try {
    const envelope = append(f, eventFor('one-write'), 1);
    const counted = countPublications(f);
    assert.deepEqual(await port.flush(), { applied: 1, duplicates: 0 });
    // One publication, and it is the closing document: this transaction staged no
    // archive byte, so there is no "pending" half-state to sequence or clear.
    assert.deepEqual(counted, { commits: 0, closes: 1 });
    assert.deepEqual(archiveFiles(f), [], 'the fixture must not have created an archive');
    assert.deepEqual(stagedDirectories(f), [], 'a committed transaction leaves no staging directory');
    const durable = documentOf(f);
    assert.equal(durable.pending, null);
    assert.equal(durable.applied[envelope.event.eventId], envelope.mac, 'the marker is committed');
    assert.equal(JSON.stringify(durable.aggregate).includes('one-write'), true, 'the record is committed');
    // The pass that follows is a pure replay: nothing is applied twice.
    assert.deepEqual(await port.flush(), { applied: 0, duplicates: 1 });
  } finally { await port.close(); await teardown(f); }
});

test('a transaction that staged archive bytes still publishes a pending record and closes it', async () => {
  const f = await fixture();
  const port = await openDomainStorage(f.ctx, f.config);
  try {
    // Fifty committed measurements put the experiment hot window at its limit, so
    // the next one evicts a record into the active archive and has to sequence
    // those bytes before the aggregate that describes them.
    for (let index = 1; index <= 50; index += 1) append(f, eventFor(`fill-${index}`), index);
    assert.deepEqual(await port.flush(), { applied: 50, duplicates: 0 });
    const counted = countPublications(f);
    append(f, eventFor('staged-write'), 51);
    assert.deepEqual(await port.flush(), { applied: 1, duplicates: 50 });
    assert.deepEqual(counted, { commits: 1, closes: 1 });
    assert.deepEqual(stagedDirectories(f), [], 'the close removes the stage it installed');
    const installed = archiveFiles(f);
    assert.equal(installed.some((name) => name.includes('experiments-archive')), true,
      'the evicted experiment must be installed into the live archive tree');
    const durable = documentOf(f);
    assert.equal(durable.pending, null);
    assert.ok(JSON.stringify(durable.aggregate).includes('staged-write'), 'the record is in the committed aggregate');
  } finally { await port.close(); await teardown(f); }
});

test('a failure before the medium replaces the document publishes nothing, and the next pass applies the event once', async () => {
  const f = await fixture();
  const port = await openDomainStorage(f.ctx, f.config);
  const domain = f.ctx.storageDomain.get(evolutionDomainSpec.name);
  const set = domain.global.set;
  try {
    const envelope = append(f, eventFor('interrupted'), 1);
    const before = documentOf(f);
    let injected = false;
    domain.global.set = async (value) => {
      if (!injected && value.pending === null && Object.keys(value.applied).length) {
        injected = true;
        throw new Error('INJECTED_SINGLE_WRITE');
      }
      return set(value);
    };
    await assert.rejects(port.flush(), /INJECTED_SINGLE_WRITE/);
    assert.equal(injected, true, 'the injection must reach the commit write');
    // Nothing of the transaction is durable: no marker, no record, and no pending
    // record that an install could resurrect. (`before` is null when the medium
    // still holds no document, which is the case for a first write.)
    const interrupted = documentOf(f);
    assert.equal(interrupted?.pending ?? null, null);
    assert.equal(interrupted?.applied?.[envelope.event.eventId], undefined);
    assert.deepEqual(interrupted?.aggregate ?? null, before?.aggregate ?? null);
    assert.deepEqual(stagedDirectories(f).length, 1, 'the refused transaction keeps its stage on disk');

    // The record is still in the log and is applied exactly once afterwards.
    domain.global.set = set;
    assert.deepEqual(await port.flush(), { applied: 1, duplicates: 0 });
    assert.deepEqual(await port.flush(), { applied: 0, duplicates: 1 });
  } finally {
    domain.global.set = set;
    await port.close().catch(() => {});
  }

  // A restart sees exactly one copy of the record.
  const restarted = await openDomainStorage(f.ctx, f.config);
  try {
    assert.deepEqual(await restarted.flush(), { applied: 0, duplicates: 1 });
    assert.equal(JSON.stringify(documentOf(f).aggregate).split('interrupted').length - 1 >= 1, true);
  } finally { await restarted.close(); await teardown(f); }
});

test('a directory-fsync failure after the replace leaves the medium ahead of the handle, and the event is applied once', async () => {
  // The honest version of "the write failed after the bytes were already in place".
  // The official JSON backend replaces the unit with `rename` and then fsyncs the
  // parent directory; the parent fsync is what makes that replacement crash-durable,
  // and a failure there leaves the new document visible in the medium while the
  // backend rolls its in-memory state back - so the domain handle this port reads
  // still holds the previous document and no `domain/changed` event is emitted.
  // Injecting at that boundary is what makes the disagreement observable; a wrapper
  // that calls the real `set` and then throws only reproduces the outer error.
  const f = await fixture();
  const port = await openDomainStorage(f.ctx, f.config);
  const domain = f.ctx.storageDomain.get(evolutionDomainSpec.name);
  const official = path.join(f.root, 'official');
  const openPromise = fs.promises.open;
  const envelope = append(f, eventFor('replaced-then-fsync-failed'), 1);
  let injected = false;
  try {
    fs.promises.open = async (file, ...rest) => {
      const handle = await openPromise.call(fs.promises, file, ...rest);
      if (injected || String(file) !== official) return handle;
      injected = true;
      return { sync: async () => { throw new Error('INJECTED_DIRECTORY_FSYNC'); }, close: () => handle.close() };
    };
    syncBuiltinESMExports();
    await assert.rejects(port.flush(), /INJECTED_DIRECTORY_FSYNC/);
    assert.equal(injected, true, 'the injection must reach the directory fsync that follows the replace');
  } finally {
    fs.promises.open = openPromise;
    syncBuiltinESMExports();
  }
  // The medium already carries the replaced document; the handle the port reads does
  // not, and the transaction was never hydrated into this port's memory.
  const medium = JSON.parse(fs.readFileSync(path.join(official, 'evolution_domain.json'), 'utf8')).global;
  assert.equal(medium.pending, null, 'the replaced document carries no pending record');
  assert.equal(medium.applied[envelope.event.eventId], envelope.mac, 'the replaced document is visible in the medium');
  assert.equal(JSON.stringify(medium.aggregate).includes('replaced-then-fsync-failed'), true);
  assert.equal(Object.hasOwn(domain.global.get().applied, envelope.event.eventId), false,
    'the failed replace leaves the handle on the previous document');
  assert.equal(port.query('observations').count, 0, 'the failed transaction was never hydrated into this port');
  assert.equal(fs.existsSync(path.join(f.root, 'domain-archive.lock')), true, 'the open port still holds its lock');
  assert.equal(stagedDirectories(f).length, 1, 'the refused transaction keeps its stage on disk');
  await assert.rejects(port.close(), /INJECTED_DIRECTORY_FSYNC/);
  assert.equal(fs.existsSync(path.join(f.root, 'domain-archive.lock')), false, 'a failed port still releases its lock');

  // A restart installs nothing and applies the event once: the replacement survived
  // here (its directory entry is visible), so it is already committed. Had it been
  // lost - which is exactly what the missing directory fsync leaves undecided - the
  // previous document would be the durable one and the pass below would apply the
  // event instead. Either way it is applied exactly once, never zero and never twice.
  const restarted = await openDomainStorage(f.ctx, f.config);
  try {
    assert.deepEqual(await restarted.flush(), { applied: 0, duplicates: 1 });
    assert.equal(JSON.stringify(documentOf(f).aggregate).split('replaced-then-fsync-failed').length - 1 >= 1, true);
  } finally { await restarted.close(); await teardown(f); }
});
