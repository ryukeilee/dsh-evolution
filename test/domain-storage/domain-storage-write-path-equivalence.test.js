// Equivalence evidence for the retained write-path variant in
// lib/domain-storage.js.
//
// The variant removes three pieces of provably redundant work from the default
// write path: a second walk of a document that was just parsed, a clone of the
// incoming aggregate that the JSON projection copies again, and the
// `snapshot()` deep clone that `inlineSerialization` makes unnecessary. None of
// them can accept or reject a document that the other path would not, so the
// evidence is differential: every check below runs the pre-change
// implementation and the working tree on the same input and requires the same
// observable result.
//
// A fourth candidate - dropping the `EvolutionObservationStore` that `hydrate()`
// loads and never reads - was withdrawn after an independent review found a real
// divergence, which is now a regression test here: its `load()` is not inert,
// because it reads `memory.hasColdHistory`, which coerces every `coldArchives`
// entry with `Number(count)`. Without the call, the first commit after a durable
// aggregate with a non-coercible entry succeeded where the pre-change
// implementation refuses it. See `docs/performance/domain-write-path.md`
// section 4.
//
// A later round kept that read while removing the projections the two `load()`
// calls in this file build and discard: `load({ snapshot: false })` performs the
// same load and skips only the returned clone. The reversed pieces below cover
// that option as well, and the cold-history read stays pinned both through the
// port (the withdrawn-candidate test) and directly on the store.
//
// Everything is anchored to `release/dsh-evolution-0.2.0-rc.8.tgz`, which is
// committed and predates the change. Both implementations are loaded as real
// modules, so the comparison covers the real `openDomainStorage` port over the
// official `DomainFacility` + `JsonStorageBackend` rather than a
// re-implementation of either.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { domainStorageBaseline, materializeDomainStorage, reconstructPreMerge } from './domain-storage-baseline.js';
import { evolutionDomainSpec, openDomainStorage } from '../../lib/domain-storage.js';
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

const WORKING = fs.readFileSync(new URL('../../lib/domain-storage.js', import.meta.url), 'utf8');
const QUERY_COLLECTIONS = ['cycles', 'observations', 'proposals', 'experiments', 'promotions', 'outcomes', 'lineage', 'knowledge'];
const FROZEN_NOW = Date.parse('2026-10-12T00:00:00.000Z');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-write-path-'));
  try { return await fn(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

/** The official fixture: real DomainFacility over the real JSON backend. */
function fixture(root) {
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

/**
 * Replace `crypto.randomUUID` with a per-run deterministic sequence. Record ids
 * embed it, so this makes the persisted bytes reproducible and removes any need
 * to mask - a mask would also hide a real difference in an id or in a reference
 * to one. The counter is reset per run, so a difference in mint order or count
 * fails the byte comparison instead of disappearing into a placeholder.
 */
function freezeUuid() {
  const original = crypto.randomUUID;
  let counter = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
  syncBuiltinESMExports();
  // `reset(base)` restarts the sequence at `base`; a differential test that restarts
  // it per write passes a distinct base per write, so identifiers stay both aligned
  // between the two implementations and distinct between writes.
  return { reset: (base = 0) => { counter = base; }, restore: () => { crypto.randomUUID = original; syncBuiltinESMExports(); } };
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
  // Both entries are runtime coordination state, not domain data: the lock is
  // this port's mutual exclusion and the token is the opaque commit counter it
  // advances. Neither is compared - but every domain file (the shared document,
  // the archives, the index) stays in the map and stays byte-compared.
  files.delete('domain-archive-lock');
  files.delete('domain-commit.token');
  return files;
}

/** Hashes of every file under `dockyard/`, keyed by path relative to it. */
function archiveTree(root) {
  const directory = path.join(root, 'dockyard');
  if (!fs.existsSync(directory)) return {};
  return Object.fromEntries(fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return [path.relative(directory, file), sha256(fs.readFileSync(file))];
    }));
}

/** Reset one fixture path so both implementations see exactly the same tree. */
function resetFixture(root, uuid) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  uuid.reset();
  return fixture(root);
}

test('the reconstruction is anchored to the pinned pre-change artifact', async () => {
  const baseline = await domainStorageBaseline();
  // The pre-change source is the released implementation, not a paraphrase of
  // it: the reversal must reproduce the artifact byte for byte.
  assert.equal(sha256(baseline.source), sha256(baseline.anchor.pinnedSource));
  assert.notEqual(sha256(baseline.source), sha256(WORKING));
  assert.match(baseline.source, /await domain\.global\.set\(schema\.parse\(\{ schema: 1, aggregate: current\.pending\.aggregate/);
  assert.match(baseline.source, /updater\(structuredClone\(aggregate\)\)/);
  assert.doesNotMatch(baseline.source, /inlineSerialization/);
  // The reversal must be exact: applying it twice would silently produce a
  // different file, and a drifted shape must fail loudly instead.
  assert.throws(() => reconstructPreMerge(baseline.source), /must occur exactly once/);
  // And the working tree must actually carry all three pieces.
  assert.doesNotMatch(WORKING, /await domain\.global\.set\(schema\.parse\(\{ schema: 1, aggregate: current\.pending\.aggregate/);
  assert.doesNotMatch(WORKING, /updater\(structuredClone\(aggregate\)\)/);
  assert.match(WORKING, /inlineSerialization: true/);
  assert.match(WORKING, /        const next = updater\(aggregate\);\n        assertStagedTransactionSave\(next, markerVerdicts\);\n        aggregate = next;/);
  assert.doesNotMatch(WORKING, /aggregateSchema\.parse\(updater\(aggregate\)\)/);
  // The withdrawn fourth piece must stay: the store is still constructed and
  // still loaded, and the added option removes only the projection that load
  // built and every reader discarded. The cold-history read it must keep is
  // pinned behaviourally below, in both the port-level test and directly on the
  // store.
  assert.match(WORKING, /observations = new EvolutionObservationStore\(\{ memory \}\);\n    await observations\.load\(\{ snapshot: false \}\);/);
  assert.doesNotMatch(WORKING, /observations = new EvolutionObservationStore\(\{ memory \}\);\n    await observations\.load\(\);/);
  // The whole-document schema keeps the strict shape and the `evolution.schema`
  // integer but no longer re-validates every value it just projected. The
  // pre-change artifact must still carry the recursive walk, and the working
  // tree must not; the acceptance decisions themselves are pinned
  // differentially in `aggregate-schema-equivalence.test.js`.
  assert.match(baseline.source, /z\.object\(\{ evolution: z\.object\(\{ schema: z\.number\(\)\.int\(\)\.min\(4\) \}\)\.catchall\(json\)\.optional\(\) \}\)\.strict\(\)/);
  assert.match(WORKING, /z\.object\(\{ evolution: z\.object\(\{ schema: z\.number\(\)\.int\(\)\.min\(4\) \}\)\.passthrough\(\)\.optional\(\) \}\)\.strict\(\)/);
  assert.doesNotMatch(WORKING, /catchall\(json\)/);
});

test('a durable aggregate whose cold archive entry cannot be coerced still fails loudly', async () => {
  // The `hydrate()` observation store is never read, but loading it is not
  // inert: `snapshot()` reads `memory.hasColdHistory`, which runs
  // `Number(entry.count)` over every `coldArchives` entry. A plain JSON entry
  // whose `toString` and `valueOf` are null passes the domain schema and makes
  // that coercion throw, so the released implementation refuses to open the
  // port. Removing the store silently accepted the next commit instead; this
  // pins the loud failure in both implementations.
  await withHome(async (home) => {
    const baseline = await domainStorageBaseline();
    const { openDomainStorage: openBaseline } = await materializeDomainStorage(baseline.source, home, 'baseline');
    const corrupt = JSON.parse(JSON.stringify({ coldArchives: { extra: { count: { toString: null, valueOf: null } } } }));
    const document = { schema: 1, aggregate: { evolution: { schema: 4, ...corrupt } }, applied: {}, pending: null };
    assert.equal(evolutionDomainSpec.global.schema.safeParse(document).success, true,
      'the corrupt document must be schema-valid, otherwise it does not prove anything');
    const unfreeze = freezeClock();
    const uuid = freezeUuid();
    try {
      const run = async (open, tag) => {
        const root = path.join(home, 'fixture');
        const f = resetFixture(root, uuid);
        const warm = await open(f.ctx, f.config);
        await warm.observe({ code: 'BENCH_ERROR', target: 'tool:warm' });
        await warm.close();
        // Corrupt the committed medium exactly as a crash or an in-process
        // official handle could leave it, then reopen the real port.
        const medium = path.join(root, 'official', 'evolution_domain.json');
        const stored = JSON.parse(fs.readFileSync(medium, 'utf8'));
        stored.global = document;
        fs.writeFileSync(medium, JSON.stringify(stored));
        await f.backend.close();
        const reopened = fixture(root);
        let outcome;
        try {
          const port = await open(reopened.ctx, reopened.config);
          await port.close();
          outcome = 'opened';
        } catch (error) { outcome = `${error.constructor.name}: ${error.message}`; }
        await reopened.backend.close();
        assert.notEqual(outcome, 'opened', `${tag}: opening on a non-coercible cold archive entry must fail`);
        return outcome;
      };
      const before = await run(openBaseline, 'baseline');
      const after = await run(openDomainStorage, 'after');
      assert.equal(after, before, 'both implementations must reject the same corrupt state identically');
    } finally { uuid.restore(); unfreeze(); }
  });
});

test('the real port commits byte-identical state before and after the change', async () => {
  await withHome(async (home) => {
    const baseline = await domainStorageBaseline();
    const { openDomainStorage: openBaseline } = await materializeDomainStorage(baseline.source, home, 'baseline');
    const writes = 70;
    const unfreeze = freezeClock();
    const uuid = freezeUuid();
    try {
      const run = async (open, tag) => {
        // Both implementations run in the same fixture path, so the archive
        // metadata they persist (absolute stage paths) is directly comparable.
        const root = path.join(home, 'fixture');
        const f = resetFixture(root, uuid);
        let port = await open(f.ctx, f.config);
        // One identifier sequence per write, on a distinct base. The two
        // implementations issue a different number of whole-document replace names,
        // and the official backend draws those from the same sequence - after the
        // record ids of the transaction. Restarting at a per-write base keeps every
        // generated identifier a function of what that write itself generated, while
        // identifiers stay distinct across writes.
        uuid.reset(1_000_000);
        await port.observe({ code: 'BENCH_ERROR', target: 'tool:warm' });
        for (let i = 0; i < writes; i += 1) { uuid.reset(i * 1000); await port.observe({ code: 'BENCH_ERROR', target: `tool:${i}` }); }
        const queries = Object.fromEntries(QUERY_COLLECTIONS.map((collection) => [collection, port.query(collection, 50)]));
        await port.close();
        // Restart from the committed medium: recovery must produce the same view.
        port = await open(f.ctx, f.config);
        const restarted = Object.fromEntries(QUERY_COLLECTIONS.map((collection) => [collection, port.query(collection, 50)]));
        await port.close();
        await f.backend.close();
        assert.deepEqual(restarted, queries, `${tag}: a restart must reproduce the pre-close projection`);
        const tree = Object.fromEntries([...readTree(root)].map(([name, bytes]) => [name, sha256(bytes)]));
        return { tree, queries: JSON.stringify(queries), restarted: JSON.stringify(restarted) };
      };
      const before = await run(openBaseline, 'baseline');
      const after = await run(openDomainStorage, 'after');
      assert.deepEqual(Object.keys(after.tree), Object.keys(before.tree));
      assert.deepEqual(after.tree, before.tree, 'the committed tree must be byte-identical');
      assert.equal(after.queries, before.queries, 'query projections must match');
      assert.equal(after.restarted, before.restarted, 'post-restart projections must match');
      assert.ok(Object.keys(after.tree).some((name) => name.includes('observations-archive')), 'the archive must be exercised');
      assert.ok(after.queries.includes('observations'), 'the query projection must not be empty');
    } finally { uuid.restore(); unfreeze(); }
  });
});

test('a rejected commit installs nothing in either implementation', async () => {
  // The full document check that runs before any staged file is installed is the
  // boundary the variant must not move. It is exercised the same way in both
  // implementations: a `domain/changed` listener corrupts the pending record
  // after it was written, and the next commit must fail before touching the
  // live archive.
  await withHome(async (home) => {
    const baseline = await domainStorageBaseline();
    const { openDomainStorage: openBaseline } = await materializeDomainStorage(baseline.source, home, 'baseline');
    const unfreeze = freezeClock();
    const uuid = freezeUuid();
    try {
      const run = async (open, tag) => {
        const root = path.join(home, 'fixture');
        const f = resetFixture(root, uuid);
        const port = await open(f.ctx, f.config);
        let injected = false, before = null;
        f.ctx.on('domain/changed', change => {
          if (injected || !change?.value?.pending?.files?.length) return;
          injected = true;
          before = archiveTree(f.root);
          change.value.pending.aggregate = { evolution: { schema: 3 } };
        });
        let failure = null;
        try {
          for (let index = 0; index < 60; index += 1) await port.observe({ code: 'REVIEW_ERROR', target: `tool:review-${index}` });
        } catch (error) { failure = error; }
        const outcome = {
          failure: failure?.name ?? null,
          injected,
          unchanged: JSON.stringify(archiveTree(f.root)) === JSON.stringify(before),
          pending: f.ctx.storageDomain.get('evolution_domain').global.get().pending !== null,
          tree: JSON.stringify(archiveTree(f.root)),
        };
        await port.close().catch(() => {});
        await f.backend.close();
        assert.equal(outcome.injected, true, `${tag}: the injection must reach a pending record with a file list`);
        assert.equal(outcome.failure, 'ZodError', `${tag}: the corrupted pending record must fail loudly`);
        assert.equal(outcome.unchanged, true, `${tag}: a rejected commit must not install staged files`);
        assert.equal(outcome.pending, true, `${tag}: the pending record must stay recoverable`);
        return outcome;
      };
      const before = await run(openBaseline, 'baseline');
      const after = await run(openDomainStorage, 'after');
      assert.deepEqual(after, before, 'both implementations must reject identically and leave the same tree');
    } finally { uuid.restore(); unfreeze(); }
  });
});

test('the committed value is never aliased to the live partition', async () => {
  // `inlineSerialization` is only honest while the bytes are captured by the
  // synchronous JSON projection inside `update`. If the port ever handed the
  // live partition to the medium instead, a later in-place mutation of the
  // memory (an append) would retroactively change an already committed document.
  await withHome(async (home) => {
    const baseline = await domainStorageBaseline();
    const { openDomainStorage: openBaseline } = await materializeDomainStorage(baseline.source, home, 'baseline');
    const unfreeze = freezeClock();
    const uuid = freezeUuid();
    try {
      const run = async (open, tag) => {
        const root = path.join(home, 'fixture');
        const f = resetFixture(root, uuid);
        const port = await open(f.ctx, f.config);
        const global = f.ctx.storageDomain.get('evolution_domain').global;
        const captured = [];
        for (let i = 0; i < 8; i += 1) {
          // One identifier sequence per write, on a distinct base; see the
          // byte-identical test above.
          uuid.reset(i * 1000);
          await port.observe({ code: 'BENCH_ERROR', target: `tool:${i}` });
          // Keep the reference the medium holds together with the bytes it had
          // at that moment: a later in-place append would show up in both.
          captured.push({ document: global.get(), json: JSON.stringify(global.get()) });
        }
        for (let i = 0; i < captured.length; i += 1) {
          assert.equal(JSON.stringify(captured[i].document), captured[i].json,
            `${tag}: document ${i + 1} was mutated after it was committed`);
        }
        const durable = JSON.parse(fs.readFileSync(path.join(root, 'official', 'evolution_domain.json'), 'utf8')).global;
        assert.equal(durable.aggregate.evolution.observations.length, 8, `${tag}: the durable medium must hold every write`);
        assert.equal(JSON.stringify(durable), captured.at(-1).json, `${tag}: the medium must hold exactly the committed document`);
        assert.equal(global.get().pending, null, `${tag}: a committed write must leave no pending record`);
        await port.close();
        await f.backend.close();
        return captured.map(({ json }) => sha256(json));
      };
      const before = await run(openBaseline, 'baseline');
      const after = await run(openDomainStorage, 'after');
      assert.deepEqual(after, before, 'both implementations must commit the same documents');
    } finally { uuid.restore(); unfreeze(); }
  });
});
