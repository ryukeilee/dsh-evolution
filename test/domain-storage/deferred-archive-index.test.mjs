import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { evolutionDomainSpec, openDomainStorage } from '../../lib/domain-storage.js';
import { EvolutionMemory } from '../../lib/dockyard-domain/memory.js';
import { signEventBridgeEnvelope } from '../../lib/orchestrator.js';

const KEY = 'b'.repeat(64);
const FIXED_AT = '2026-10-26T00:00:00.000Z';
const RealDate = globalThis.Date;
class FixedDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [FIXED_AT])); }
  static now() { return new RealDate(FIXED_AT).getTime(); }
}
const authority = { assertMutation() {} };
const indexName = 'state.json.evolution-archive-index.json';
const indexOf = (root) => path.join(root, indexName);
const durablePath = (root) => path.join(root, 'official', 'evolution_domain.json');

function measurementEvent(experimentId) {
  return {
    schema: 1,
    eventId: `evolution:measurement-completed:${experimentId}`,
    eventType: 'measurement-completed',
    experimentId,
    proposalId: `proposal-${experimentId}`,
    target: 'plugin:deferred-index',
    capability: 'plugin:deferred-index',
    lineageId: 'plugin:deferred-index',
    status: 'measured',
    measurement: { latency: 10, throughput: 3 },
    evidence: { testPassed: true },
    audit: { producer: 'dsh-evolution-orchestrator', at: FIXED_AT },
  };
}

/** Enough records to cross the 50-record hot window and force real archive appends. */
const RECORDS = 60;
const events = () => Array.from({ length: RECORDS }, (_unused, index) => measurementEvent(`deferred-${index}`));

function inlineStore(root) {
  const filePath = path.join(root, 'state.json');
  let aggregate = { evolution: { schema: 5 } };
  return {
    filePath,
    inlineSerialization: true,
    async load() { return aggregate; },
    async update(updater) { aggregate = updater(aggregate); },
  };
}

/**
 * A staged-shaped memory: file-backed store, transaction, archive write guard and
 * the deferral `openDomainStorage()` grants its staged working copy.
 */
async function stagedMemory(root, { deferArchiveIndexWrites = true } = {}) {
  const stateStore = inlineStore(root);
  const memory = new EvolutionMemory({
    stateStore,
    transaction: { persist: stateStore.update },
    mutationAuthority: authority,
    archiveWriteGuard: async () => {},
    deferArchiveIndexWrites,
    clock: () => new FixedDate(FIXED_AT),
  });
  await memory.load({ snapshot: false });
  return memory;
}

async function withFixedTime(run) {
  globalThis.Date = FixedDate;
  try { return await run(); } finally { globalThis.Date = RealDate; }
}

function withRoot(prefix, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return (async () => { try { return await run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); } })();
}

const readIndex = (root) => {
  const file = indexOf(root);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
};

test('a deferred staged memory owes the index document once instead of once per append', () =>
  withFixedTime(() => withRoot('deferred-index-once-', async (root) => {
    const memory = await stagedMemory(root);
    const between = [];
    for (const event of events()) {
      await memory.applyExecutionEvent(event);
      between.push(readIndex(root));
    }
    // Nothing is written while the appends are being accumulated: the staged
    // copy never publishes, so no reader of the directory exists between them.
    assert.deepEqual([...new Set(between)], [null], 'a deferred append must not rewrite the index document');
    assert.equal(await memory.flushDeferredArchiveIndex(), true, 'the owed document must be written once');
    const written = readIndex(root);
    assert.ok(written, 'the flush must install the index document');
    assert.equal(await memory.flushDeferredArchiveIndex(), false, 'the debt is paid once, not once per call');
    assert.equal(readIndex(root), written, 'a second flush must be a no-op');

    const document = JSON.parse(written);
    const active = document.segments.find((entry) => entry.collection === 'experiments' && entry.sealed === false);
    assert.ok(active, 'the replay must have archived records');
    const file = path.join(root, 'state.json.experiments-archive.jsonl');
    const bytes = fs.readFileSync(file);
    assert.equal(active.byteSize, bytes.length, 'the owed document must describe the bytes the appends wrote');
    assert.equal(active.physicalCount, bytes.toString('utf8').trimEnd().split('\n').length);
    assert.ok(active.physicalCount > 0);
  })));

test('the owed document is the one per-append writes would have produced', () =>
  withFixedTime(() => withRoot('deferred-index-equal-', async (parent) => {
    // Same clock, same store shape, same events, same file names: the only
    // difference is whether each append paid its own index rewrite.
    const deferredRoot = path.join(parent, 'deferred');
    const eagerRoot = path.join(parent, 'eager');
    fs.mkdirSync(deferredRoot, { mode: 0o700 });
    fs.mkdirSync(eagerRoot, { mode: 0o700 });
    const deferred = await stagedMemory(deferredRoot);
    const eager = await stagedMemory(eagerRoot, { deferArchiveIndexWrites: false });
    for (const event of events()) {
      await deferred.applyExecutionEvent(event);
      await eager.applyExecutionEvent(event);
    }
    await deferred.flushDeferredArchiveIndex();
    // The eager memory writes at its last append, which is the same state. Under
    // one fixed clock the documents are the same bytes, so the published bytes
    // are compared directly rather than as parsed values.
    assert.equal(readIndex(deferredRoot), readIndex(eagerRoot),
      'the deferred document must be the bytes the last per-append write produced');
    assert.deepEqual(fs.readFileSync(path.join(deferredRoot, 'state.json.experiments-archive.jsonl')),
      fs.readFileSync(path.join(eagerRoot, 'state.json.experiments-archive.jsonl')),
      'deferring the index document must not change the archive bytes it describes');
  })));

test('only the staged working copy defers; a direct transaction keeps per-append writes', () =>
  withFixedTime(() => withRoot('deferred-index-default-', async (root) => {
    const memory = await stagedMemory(root, { deferArchiveIndexWrites: false });
    const seen = new Set();
    for (const event of events()) {
      await memory.applyExecutionEvent(event);
      seen.add(readIndex(root));
    }
    seen.delete(null);
    assert.ok(seen.size > 1, 'a non-deferred memory must rewrite the index document as it appends');
    assert.equal(await memory.flushDeferredArchiveIndex(), false, 'a non-deferred memory owes nothing');
  })));

test('a deferred index write that cannot be published rejects instead of being swallowed', () =>
  withFixedTime(() => withRoot('deferred-index-failure-', async (root) => {
    const memory = await stagedMemory(root);
    // An empty directory where the document belongs makes the flush's atomic
    // rename fail. `#archiveEntries()` used to catch that per append and keep the
    // record hot; the debt is paid once now, so it must surface.
    fs.mkdirSync(indexOf(root));
    for (const event of events()) await memory.applyExecutionEvent(event);
    await assert.rejects(memory.flushDeferredArchiveIndex(), (error) => ['EISDIR', 'ENOTDIR', 'ENOTEMPTY', 'EPERM'].includes(error?.code),
      'a deferred index write that cannot be published must reject');
    assert.equal(await memory.flushDeferredArchiveIndex(), false, 'a failed flush must not be retried implicitly');
  })));

test('a real replay publishes an index describing what it archived, and a second pass leaves it alone', () =>
  withFixedTime(() => withRoot('deferred-index-port-', async (root) => {
    const file = path.join(root, 'execution-events.jsonl');
    fs.writeFileSync(file, `${events().map((event, index) => JSON.stringify(signEventBridgeEnvelope(event, { key: KEY, sequence: index + 1 }))).join('\n')}\n`);
    const backend = new JsonStorageBackend(path.join(root, 'official'));
    const ctx = { emit() {}, on() { return () => {}; }, logger: { warn() {}, error() {} },
      storage: { backend: { get: () => backend } }, effect() {} };
    ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
    const config = { presetDir: root, eventBridgePath: file, eventBridgeKey: KEY };
    // The deferral is only reachable through the staged working copy, so the
    // port path is where it has to be observed: every instance that owes the
    // document during this replay is a deferred one, and each pays it once.
    const originalFlush = EvolutionMemory.prototype.flushDeferredArchiveIndex;
    const flushes = [];
    EvolutionMemory.prototype.flushDeferredArchiveIndex = async function (...args) {
      const deferred = this.deferArchiveIndexWrites === true;
      const result = await originalFlush.apply(this, args);
      flushes.push({ deferred, result });
      return result;
    };
    let port;
    try {
      port = await openDomainStorage(ctx, config);
      const durable = JSON.parse(fs.readFileSync(durablePath(root), 'utf8')).global;
      assert.equal(Object.keys(durable.applied).length, RECORDS);
      assert.equal(durable.pending, null);

      // The committed archive tree is the live root `hydrate()` maintains, not
      // the backend's own directory.
      const live = path.join(root, 'dockyard');
      const published = JSON.parse(fs.readFileSync(path.join(live, indexName), 'utf8'));
      const archived = path.join(live, 'state.json.experiments-archive.jsonl');
      assert.ok(fs.existsSync(archived), 'the replay must have archived records');
      const bytes = fs.readFileSync(archived);
      const active = published.segments.find((entry) => entry.collection === 'experiments' && entry.sealed === false);
      assert.ok(active, 'the published index must describe the archived collection');
      assert.equal(active.byteSize, bytes.length, 'the flush must land before the transaction lists its changes');
      assert.equal(active.physicalCount, bytes.toString('utf8').trimEnd().split('\n').length);
      const indexBytes = fs.readFileSync(path.join(live, indexName));
      assert.ok(flushes.length > 0, 'the replay must reach the staged flush');
      assert.ok(flushes.every((entry) => entry.deferred === true),
        'only the staged working copy may defer its index document');
      assert.deepEqual(flushes.map((entry) => entry.result).filter(Boolean), [true],
        'a replay of archived records owes the document exactly once');
      // The archive lock admits one port at a time, so the second pass starts
      // after this one has released it.
      await port.close();
      port = null;

      // A second pass is served by the checkpoint and the committed ledger: it
      // rewrites neither the document nor the index it describes.
      const second = await openDomainStorage(ctx, config);
      try {
        const again = JSON.parse(fs.readFileSync(durablePath(root), 'utf8')).global;
        assert.equal(Object.keys(again.applied).length, RECORDS);
        assert.deepEqual(fs.readFileSync(path.join(live, indexName)), indexBytes,
          'an absorbed prefix must not rewrite the archive index document');
      } finally { await second.close(); }
    } finally {
      EvolutionMemory.prototype.flushDeferredArchiveIndex = originalFlush;
      if (port) await port.close();
      await backend.close();
    }
  })));

test('the replay opens through the official spec with the deferral in place', async () => {
  // The staged working copy is only reachable through `openDomainStorage()`, so
  // the option has to arrive from there; a direct construction is covered above.
  await withRoot('deferred-index-spec-', async (root) => {
    const backend = new JsonStorageBackend(path.join(root, 'official'));
    const ctx = { emit() {}, on() { return () => {}; }, logger: { warn() {}, error() {} },
      storage: { backend: { get: () => backend } }, effect() {} };
    ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
    const domain = await ctx.storageDomain.open(evolutionDomainSpec);
    try { assert.equal(domain.global.get().pending, null); } finally { await domain.close(); await backend.close(); }
  });
});

test('a flush that cannot publish aborts the transaction before anything is staged', () =>
  withFixedTime(() => withRoot('deferred-index-port-abort-', async (root) => {
    const file = path.join(root, 'execution-events.jsonl');
    fs.writeFileSync(file, `${events().map((event, index) => JSON.stringify(signEventBridgeEnvelope(event, { key: KEY, sequence: index + 1 }))).join('\n')}\n`);
    const backend = new JsonStorageBackend(path.join(root, 'official'));
    const ctx = { emit() {}, on() { return () => {}; }, logger: { warn() {}, error() {} },
      storage: { backend: { get: () => backend } }, effect() {} };
    ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
    const config = { presetDir: root, eventBridgePath: file, eventBridgeKey: KEY };
    const live = path.join(root, 'dockyard');
    const liveIndex = path.join(live, indexName);
    const liveArchive = path.join(live, 'state.json.experiments-archive.jsonl');

    const originalFlush = EvolutionMemory.prototype.flushDeferredArchiveIndex;
    EvolutionMemory.prototype.flushDeferredArchiveIndex = async () => {
      const error = new Error('INJECTED_DEFERRED_INDEX_WRITE');
      error.code = 'INJECTED_DEFERRED_INDEX_WRITE';
      throw error;
    };
    let port;
    try {
      // The flush runs after `work()` and before the change listing, so a write
      // it cannot perform rejects the open instead of publishing a tree whose
      // archived bytes have no index. This is the one behaviour the deferral
      // changes on purpose; per-append writes used to be swallowed here.
      await assert.rejects(openDomainStorage(ctx, config), /INJECTED_DEFERRED_INDEX_WRITE/);
      assert.equal(fs.existsSync(liveIndex), false, 'an aborted transaction must not publish an index');
      assert.equal(fs.existsSync(liveArchive), false, 'an aborted transaction must not publish archive bytes');
      // Nothing was published at all: no document, so no pending record and no
      // marker either.
      assert.equal(fs.existsSync(durablePath(root)), false,
        'an aborted first transaction must publish no domain document');
      const staging = path.join(root, 'domain-staging');
      const stages = fs.existsSync(staging) ? fs.readdirSync(staging) : [];
      assert.ok(stages.every((name) => !fs.existsSync(path.join(staging, name, 'stage-manifest.json'))),
        'the aborted transaction must not write a stage manifest');

      // With the flush restored the same fixture opens, so nothing about the
      // fixture — only the injected write — was the refusal.
      EvolutionMemory.prototype.flushDeferredArchiveIndex = originalFlush;
      port = await openDomainStorage(ctx, config);
      const committed = JSON.parse(fs.readFileSync(durablePath(root), 'utf8')).global;
      assert.equal(Object.keys(committed.applied).length, RECORDS);
      assert.ok(fs.existsSync(liveIndex), 'the retried transaction must publish its index');
    } finally {
      EvolutionMemory.prototype.flushDeferredArchiveIndex = originalFlush;
      if (port) await port.close();
      await backend.close();
    }
  })));
