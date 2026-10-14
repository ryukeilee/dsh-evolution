// Equivalence and contract evidence for the projection-free load round.
//
// The round adds `{ snapshot: false }` to `EvolutionMemory.load()` and
// `EvolutionObservationStore.load()` and uses it at the four call sites that
// built a projection and then discarded it: the domain port's `createMemory()`,
// `hydrate()`'s observation store, and the store's own `record()`. The store's
// observation window also moves from "the memory's whole hot snapshot, take
// `.observations`" to the documented narrow read of that one collection.
//
// Nothing here removes a check: the load still runs, and the cold-history
// coercion the withdrawn candidate in `docs/performance/domain-write-path.md`
// depended on is performed explicitly. The evidence is differential. The
// reconstruction in `load-projection-baseline.js` rebuilds the whole pre-change
// tree, and every check below runs both trees on the same deterministic input
// and requires the same observable result - persisted bytes included, with no
// masking, so a difference in an id or a reference to one fails the comparison
// instead of hiding in it.
//
// The single-file anchor in `domain-storage-baseline.js` cannot serve here: it
// reverts `lib/domain-storage.js` while deliberately resolving its siblings to
// the working tree, so it would compare the candidate's `memory.js` and
// `observation.js` against themselves.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { EvolutionMemory, EvolutionObservationStore } from '../../lib/dockyard-domain/index.js';
import { openDomainStorage } from '../../lib/domain-storage.js';
import { loadProjectionBaseline, materializeProjectionBaselineTree } from './load-projection-baseline.js';
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');
const { JsonStateStore } = await import('../dockyard-domain/support.js');

const QUERY_COLLECTIONS = ['cycles', 'observations', 'proposals', 'experiments', 'promotions', 'outcomes', 'lineage', 'knowledge'];
const FROZEN_NOW = Date.parse('2026-10-12T00:00:00.000Z');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const digest = (value) => sha256(JSON.stringify(value));

async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-load-projection-'));
  try { return await fn(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

/** The official fixture: real DomainFacility over the real JSON backend. */
function fixture(root) {
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'), eventBridgeKey: 'b'.repeat(64) };
  return { root, ctx, config, backend };
}

/** Freeze the clock so two runs of one workload are byte-comparable. */
function freezeClock() {
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...value) { if (value.length === 0) super(FROZEN_NOW); else super(...value); }
    static now() { return FROZEN_NOW; }
  }
  Object.setPrototypeOf(FrozenDate, RealDate);
  globalThis.Date = FrozenDate;
  return () => { globalThis.Date = RealDate; };
}

/** Deterministic record ids, reset per run, so mint order and count are compared. */
function freezeUuid() {
  const original = crypto.randomUUID;
  let counter = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
  syncBuiltinESMExports();
  return { reset: () => { counter = 0; }, restore: () => { crypto.randomUUID = original; syncBuiltinESMExports(); } };
}

function readTree(root) {
  const files = new Map();
  const walk = (directory, relative) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const nested = relative ? `${relative}/${name}` : name;
      if (fs.statSync(absolute).isDirectory()) walk(absolute, nested);
      else files.set(nested, fs.readFileSync(absolute));
    }
  };
  walk(root, '');
  files.delete('domain-archive-lock');
  return files;
}

/** Reset one fixture path so both trees see exactly the same starting point. */
function resetFixture(root, uuid) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  uuid.reset();
  return fixture(root);
}

/** One port session: warm write, `writes` observations, projections, restart. */
async function portRun(open, root, uuid, writes) {
  const f = resetFixture(root, uuid);
  let port = await open(f.ctx, f.config);
  await port.observe({ code: 'BENCH_ERROR', target: 'tool:warm' });
  for (let i = 0; i < writes; i += 1) await port.observe({ code: 'BENCH_ERROR', target: `tool:${i}` });
  const queries = Object.fromEntries(QUERY_COLLECTIONS.map((collection) => [collection, port.query(collection, 50)]));
  await port.close();
  port = null;
  const reopened = await open(f.ctx, f.config);
  const restarted = Object.fromEntries(QUERY_COLLECTIONS.map((collection) => [collection, reopened.query(collection, 50)]));
  await reopened.close();
  await f.backend.close();
  const tree = readTree(root);
  const segments = [...tree.keys()].filter((name) => name.endsWith('.jsonl') && !name.endsWith('execution-events.jsonl'));
  return {
    queries: Object.fromEntries(Object.entries(queries).map(([collection, value]) => [collection, `${value.count}:${digest(value.entries)}`])),
    restarted: Object.fromEntries(Object.entries(restarted).map(([collection, value]) => [collection, `${value.count}:${digest(value.entries)}`])),
    tree: Object.fromEntries([...tree.keys()].sort().map((name) => [name, sha256(tree.get(name))])),
    segments: segments.length,
  };
}

/**
 * One dedup/eviction workload driven through the observation store itself. The
 * public port always projects `severity: 'error'` and `type: 'tool/error'`, which
 * is never dedupable, so the store's own entry path needs its own driver. Every
 * session builds a fresh memory over the same durable state, which is what makes
 * `load()` re-run and the hot window evict into the archive.
 */
async function storeRun(memoryClass, storeClass, root, uuid) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  uuid.reset();
  const filePath = path.join(root, 'state.json');
  const returned = [];
  const signal = (index) => ({
    id: `signal-${index}`, type: 'component/observation', componentId: 'plugin:module-a', severity: 'info',
    status: 'healthy', patternKey: 'request-timeout', observedAt: new Date(FROZEN_NOW).toISOString(),
    metrics: { memoryUsage: 100, cpuUsage: 10, avgLatencyMs: 5 },
  });
  const session = async (records) => {
    const memory = new memoryClass({ stateStore: new JsonStateStore({ filePath }), mutationAuthority: { assertMutation() {} },
      maxEntries: 4, hotEntries: 2, hotCycles: 2 });
    await memory.load({ snapshot: false });
    const store = new storeClass({ memory, maxEntries: 6, hotEntries: 2, warmEntries: 4 });
    await records(store);
    return { memory, store };
  };
  await session(async (store) => {
    returned.push(await store.record(signal(0)));                                          // first seen
    returned.push(await store.record(signal(1)));                                          // same signal, dedup refresh
    returned.push(await store.record({ ...signal(2), metrics: { memoryUsage: 400, cpuUsage: 40, avgLatencyMs: 20 } }));
    returned.push(await store.record(signal(3), { deferStablePersistence: true }));        // deferred canonical counter update
    returned.push(await store.record(signal(4), { deferStablePersistence: true }));
    returned.push(await store.record({ ...signal(5), forceRecord: true }));                // forced append
    for (let i = 6; i < 12; i += 1) {
      returned.push(await store.record({ ...signal(i), id: `distinct-${i}`, componentId: `plugin:module-${i}`, patternKey: `pattern-${i}` }));
    }
  });
  // A second session reloads the same durable state: the hot window is rebuilt
  // and the records that no longer fit are archived.
  const last = await session(async (store) => {
    returned.push(await store.record(signal(12)));
    returned.push(await store.record({ ...signal(13), id: 'distinct-13', componentId: 'plugin:module-b', patternKey: 'pattern-13' }));
    returned.push(await store.record(signal(14)));
  });
  return {
    ids: returned.map((entry) => entry.id),
    returned: digest(returned),
    store: digest(last.store.snapshot()),
    list: digest(last.store.list()),
    entries: digest(last.store.entries),
    memory: digest(last.memory.fullSnapshot()),
    snapshot: digest(last.memory.snapshot()),
    archive: sha256(fs.readFileSync(path.join(root, 'state.json.observations-archive.jsonl'))),
  };
}

test('the reversal returns all three files to a real pre-change source', async () => {
  const { working, reconstructed, hunks } = await loadProjectionBaseline();
  assert.equal(hunks, 7, 'the round changes four call sites, both load signatures and the narrow read');
  for (const [file, source] of reconstructed) {
    assert.notEqual(source, working.get(file), `${file} must change`);
    // The pre-change file carries no trace of the new option, and the call
    // sites are back to the plain load. Applying the reconstruction again
    // cannot be a no-op, which is what the single-occurrence guard enforces.
    assert.doesNotMatch(source, /snapshot: false/, `${file} must be reverted`);
  }
  assert.match(reconstructed.get('lib/domain-storage.js'), /await instance\.load\(\);/);
  assert.match(reconstructed.get('lib/domain-storage.js'), /await observations\.load\(\);/);
  assert.match(reconstructed.get('lib/dockyard-domain/observation.js'), /await this\.load\(\);/);
  assert.match(working.get('lib/domain-storage.js'), /await instance\.load\(\{ snapshot: false \}\);/);
  assert.match(working.get('lib/domain-storage.js'), /await observations\.load\(\{ snapshot: false \}\);/);
});

test('the whole pre-change tree and the working tree commit byte-identical state', async () => {
  await withHome(async (home) => {
    const baseline = await materializeProjectionBaselineTree(home);
    const writes = 80;
    const unfreeze = freezeClock();
    const uuid = freezeUuid();
    try {
      const root = path.join(home, 'fixture');
      const before = await portRun(baseline.openDomainStorage, root, uuid, writes);
      const after = await portRun(openDomainStorage, root, uuid, writes);
      assert.deepEqual(after.queries, before.queries, 'the live query projections must be identical');
      assert.deepEqual(after.restarted, before.restarted, 'the post-restart projections must be identical');
      assert.deepEqual(after.tree, before.tree, 'every persisted byte must be identical');
      // The workload must actually reach the cold tier: without eviction the
      // observation store's narrow read and the archive paths are not compared.
      assert.ok(before.segments >= 1, `the comparison must cover a real archive, saw ${before.segments} segment files`);
      assert.equal(after.segments, before.segments);
    } finally { uuid.restore(); unfreeze(); }
  });
});

test('the observation store records identical state from either tree', async () => {
  await withHome(async (home) => {
    const baseline = await materializeProjectionBaselineTree(home);
    const baselineDomain = await import(pathToFileURL(path.join(baseline.directory, 'lib/dockyard-domain/index.js')).href);
    const unfreeze = freezeClock();
    const uuid = freezeUuid();
    try {
      const before = await storeRun(baselineDomain.EvolutionMemory, baselineDomain.EvolutionObservationStore, path.join(home, 'store'), uuid);
      const after = await storeRun(EvolutionMemory, EvolutionObservationStore, path.join(home, 'store'), uuid);
      assert.deepEqual(after, before, 'the dedup, deferred-persistence and archive results must be identical');
      // A run that never deduped or never archived would compare less than the
      // test claims: the same signal must reuse one id, and the evicted rows
      // must have reached the archive file the digest above was read from.
      assert.equal(before.ids[0], before.ids[1], 'the workload must actually dedup a repeated signal');
      assert.equal(before.ids.length, 15, 'the workload must exercise every record branch');
      assert.match(before.archive, /^[0-9a-f]{64}$/, 'the workload must actually archive an evicted row');
    } finally { uuid.restore(); unfreeze(); }
  });
});

test('a document too deep to project is still refused before any load, in both trees', async () => {
  await withHome(async (home) => {
    const baseline = await materializeProjectionBaselineTree(home);
    // 8 000 levels: past this engine's structural-clone and recursive-walk
    // limits, while `JSON.parse` (iterative on every supported version) still
    // accepts it. The plugin's own document validation (`installPending()`'s
    // `schema.parse`, whose `toJsonProjection` and `z.json()` walk both recurse)
    // runs before any Memory exists, so the real port refuses this document in
    // both trees and the projection-free load is never reached. That is the
    // reachability limit of the one acceptance difference this round has: a
    // value too deep to project is no longer rejected by the memory load itself
    // when a host drives `EvolutionMemory` directly. See
    // `docs/performance/load-projection.md`.
    //
    // The deep value is written as text instead of with `JSON.stringify`: that
    // call recursed once per level on Node 22/24, so serializing 8 000 levels
    // overflowed the stack inside this fixture (instead of in the port) and the
    // document was never written. Later V8 versions stringify iteratively, which
    // is why the failure only appeared on the supported CI runtimes.
    const levels = 8000;
    const deepJson = '{"x":'.repeat(levels) + '0' + '}'.repeat(levels);
    const deepGlobal = `{"schema":1,"aggregate":{"evolution":{"schema":4,"extra":${deepJson}}},"applied":{},"pending":null}`;
    // A placeholder keeps the shallow document serialized normally; exactly the
    // bytes `JSON.stringify` would have produced replace it.
    const marker = '__deep_placeholder__';
    const uuid = freezeUuid();
    const run = async (open, name) => {
      const root = path.join(home, name);
      const f = resetFixture(root, uuid);
      const warm = await open(f.ctx, f.config);
      await warm.observe({ code: 'BENCH_ERROR', target: 'tool:warm' });
      await warm.close();
      const medium = path.join(root, 'official', 'evolution_domain.json');
      const stored = JSON.parse(fs.readFileSync(medium, 'utf8'));
      stored.global = marker;
      fs.writeFileSync(medium, JSON.stringify(stored).replace(JSON.stringify(marker), () => deepGlobal));
      await f.backend.close();
      const reopened = fixture(root);
      try {
        const port = await open(reopened.ctx, reopened.config);
        await port.close();
        return 'opened';
      } catch (error) { return error.constructor.name; }
      finally { await reopened.backend.close(); }
    };
    try {
      const before = await run(baseline.openDomainStorage, 'deep-baseline');
      const after = await run(openDomainStorage, 'deep-working');
      assert.deepEqual(after, before, 'both trees must refuse the same document the same way');
      assert.notEqual(before, 'opened', 'the document must be refused, not accepted');
    } finally { uuid.restore(); }
  });
});

test('a failed load still refuses the next record, in both trees', async () => {
  await withHome(async (home) => {
    const baseline = await materializeProjectionBaselineTree(home);
    const baselineDomain = await import(pathToFileURL(path.join(baseline.directory, 'lib/dockyard-domain/index.js')).href);
    const seed = (name) => {
      const filePath = path.join(home, name);
      fs.writeFileSync(filePath, JSON.stringify({ evolution: { schema: 4, coldArchives: { extra: { count: { toString: null, valueOf: null } } } } }));
      return { filePath, store: new JsonStateStore({ home, filePath }) };
    };
    // `loaded` is set before the projection that rejects the state, so the load
    // leaves a store that has to keep refusing. A projection-free load must not
    // turn the next `record()` into a silent success: that is the divergence an
    // independent review found in the first cut of this round, and the reason
    // the cold-history read is now performed on every path.
    const run = async (domain, name) => {
      const seeded = seed(name);
      const memory = new domain.EvolutionMemory({ stateStore: seeded.store, mutationAuthority: { assertMutation() {} } });
      const store = new domain.EvolutionObservationStore({ memory });
      const outcome = (promise) => promise.then(() => 'resolved', (error) => error.constructor.name);
      const first = await outcome(store.load());
      const second = await outcome(store.record({ id: 'new', type: 'tool/error', severity: 'error', code: 'TEST' }));
      return { first, second, persisted: fs.readFileSync(seeded.filePath, 'utf8').includes('"new"') };
    };
    const before = await run(baselineDomain, 'refuse-baseline.json');
    const after = await run({ EvolutionMemory, EvolutionObservationStore }, 'refuse-working.json');
    assert.deepEqual(after, before, 'a load failure must not become a silent success');
    assert.deepEqual(before, { first: 'TypeError', second: 'TypeError', persisted: false });
  });
});

test('load({ snapshot: false }) loads the state and skips only the projection', async () => {
  await withHome(async (home) => {
    const stateStore = () => new JsonStateStore({ home, filePath: path.join(home, 'probe-state.json') });
    const projected = new EvolutionMemory({ stateStore: stateStore(), mutationAuthority: { assertMutation() {} } });
    const bare = new EvolutionMemory({ stateStore: stateStore(), mutationAuthority: { assertMutation() {} } });
    const first = await projected.load();
    assert.equal(bare.loaded, false);
    assert.equal(await bare.load({ snapshot: false }), undefined, 'the skipped projection must not be built');
    assert.equal(bare.loaded, true, 'the load itself must still have happened');
    assert.deepEqual(bare.snapshot(), projected.snapshot(), 'the loaded state must agree with the projected load');
    // A later default load returns the projection the option skipped...
    assert.deepEqual(await bare.load(), first, 'load() must still return the projection');
    // ...and two concurrent loads of a not-yet-loaded instance still share the
    // first caller's value, which is what `return this.loading` used to do.
    const concurrent = new EvolutionMemory({ stateStore: stateStore(), mutationAuthority: { assertMutation() {} } });
    const [left, right] = await Promise.all([concurrent.load(), concurrent.load()]);
    assert.equal(left, right, 'concurrent loads must still share one projection');
    // A caller that asks for no projection shares none and builds none; a
    // default caller that arrives during that run still receives a projection
    // (its own, since the first caller produced none to share).
    const mixed = new EvolutionMemory({ stateStore: stateStore(), mutationAuthority: { assertMutation() {} } });
    const [skipped, projectedOne, projectedTwo] = await Promise.all([mixed.load({ snapshot: false }), mixed.load(), mixed.load()]);
    assert.equal(skipped, undefined, 'the skipping caller must not receive a projection');
    assert.deepEqual(projectedOne, await bare.snapshot(), 'a default caller during a skip run must still receive one');
    assert.deepEqual(projectedTwo, projectedOne);
    // The same instance can also be asked for the projection after skipping it.
    const fresh = new EvolutionMemory({ stateStore: stateStore(), mutationAuthority: { assertMutation() {} } });
    assert.equal(await fresh.load({ snapshot: false }), undefined);
    assert.deepEqual(await fresh.load(), await bare.snapshot());
  });
});

test('the observation store still fails loudly without its projection', async () => {
  await withHome(async (home) => {
    fs.mkdirSync(home, { recursive: true });
    // A durable aggregate whose cold archive entry passes the domain schema but
    // cannot be coerced by `Number(count)`. The store's load must keep rejecting
    // it with and without the projection: this is the read the withdrawn
    // candidate in `docs/performance/domain-write-path.md` section 4 removed.
    const corrupt = path.join(home, 'corrupt-state.json');
    fs.writeFileSync(corrupt, JSON.stringify({
      evolution: { schema: 4, coldArchives: { extra: { count: { toString: null, valueOf: null } } } },
    }));
    const memory = new EvolutionMemory({ stateStore: new JsonStateStore({ home, filePath: corrupt }), mutationAuthority: { assertMutation() {} } });
    const projected = new EvolutionObservationStore({ memory });
    await assert.rejects(projected.load(), TypeError, 'the projected load must reject the state');
    const bare = new EvolutionObservationStore({ memory });
    await assert.rejects(bare.load({ snapshot: false }), TypeError, 'the projection-free load must reject the same state');
    // Without a coercible entry the projection-free load returns nothing while
    // still populating the store's own window from the shared memory.
    const healthy = path.join(home, 'healthy-state.json');
    fs.writeFileSync(healthy, JSON.stringify({
      evolution: { schema: 4, observations: [{ id: 'obs-1' }, { id: 'obs-2' }], coldArchives: {} },
    }));
    const store = new EvolutionObservationStore({ memory: new EvolutionMemory({ stateStore: new JsonStateStore({ home, filePath: healthy }), mutationAuthority: { assertMutation() {} } }) });
    assert.equal(await store.load({ snapshot: false }), undefined);
    assert.deepEqual(store.entries.map((entry) => entry.id), ['obs-1', 'obs-2']);
    assert.equal(store.loaded, true);
    assert.deepEqual(await store.load(), store.snapshot(), 'the default load still returns the snapshot');
  });
});

test('the observation store hands a concurrent caller the first load value, skip or not', async () => {
  await withHome(async (home) => {
    fs.mkdirSync(home, { recursive: true });
    const healthy = path.join(home, 'concurrent-observations.json');
    fs.writeFileSync(healthy, JSON.stringify({
      evolution: { schema: 4, observations: [{ id: 'obs-1' }, { id: 'obs-2' }], coldArchives: {} },
    }));
    // A new store over its own memory each time, so every case starts unloaded.
    const store = () => new EvolutionObservationStore({
      memory: new EvolutionMemory({ stateStore: new JsonStateStore({ home, filePath: healthy }), mutationAuthority: { assertMutation() {} } }),
    });

    // A default caller starts the load. This store keeps the released
    // `return this.loading` semantics, so the value it produces is handed on
    // verbatim to a skipping caller that arrives during that run - the store
    // has no snapshot flag to filter it by, unlike `EvolutionMemory`.
    const projectedFirst = store();
    const [projected, skipped] = await Promise.all([projectedFirst.load(), projectedFirst.load({ snapshot: false })]);
    assert.notEqual(projected, undefined);
    assert.equal(skipped, projected, 'the concurrent caller is handed the first load value, skip or not');

    // A skipping caller starts the load: it builds none, and default callers
    // that arrive during that run still each receive a projection of the same
    // loaded state (`shared` is undefined, so they build their own).
    const skippedFirst = store();
    const [none, later, second] = await Promise.all([
      skippedFirst.load({ snapshot: false }), skippedFirst.load(), skippedFirst.load(),
    ]);
    assert.equal(none, undefined, 'the skipping caller must not receive a projection');
    assert.notEqual(later, undefined);
    assert.deepEqual(later, second, 'every concurrent default caller receives the same projection content');
    assert.notEqual(later, second, 'each concurrent default caller builds its own projection (the store shares the first value, not a projection for a skip run)');
    assert.deepEqual(later, await store().load(), 'the default caller must still receive a projection of the loaded state');
  });
});
