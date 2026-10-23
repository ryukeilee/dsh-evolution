import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evolutionDomainSpec, openDomainStorage } from '../../lib/domain-storage.js';
import { digestApplied } from '../../lib/event-log-checkpoint.js';
import { signEventBridgeEnvelope } from '../../lib/orchestrator.js';
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

/**
 * Pins the read shape of the committed-marker-map digest.
 *
 * `appliedDigest = sha256(JSON.stringify(applied))` binds the replay checkpoint to
 * the whole committed marker map, and it is what detects a map that was rolled
 * back behind the port's back. It is also about half of a steady-state `flush()`
 * at 20000 records, so it keeps attracting "re-use the value you just computed"
 * shortcuts. One such shortcut was implemented and measured in this round (a
 * content-comparison cache keyed on the map object, worth -33% of the steady
 * flush) and then withdrawn: comparing the live map against a snapshot is not the
 * same thing as serializing it, because
 *
 *   - a root-level `toJSON` (own and non-enumerable, or inherited) changes the
 *     serialized bytes without appearing in `Object.keys()`;
 *   - an array map serializes its length and holes, which `Object.keys()` does not
 *     report;
 *   - a table whose reads do not settle can be "equal to the snapshot" while the
 *     serialization that was actually hashed said something else, so the cache
 *     serves a digest for content the map no longer reports;
 *   - any extra read of a live table can throw where the single serialization
 *     would have succeeded, and a non-object argument starts throwing instead of
 *     being digested (`Object.keys(null)` in a snapshotting cache, the `WeakMap`
 *     key in an identity cache).
 *
 * The cases below are the counterexamples that withdrew it, written against the
 * single-serialization implementation that remains. Measured discrimination (two
 * implementations re-injected into a scratch copy of `lib/`): both caches fail 6 of
 * these 7 cases, in different sets - the content-comparison cache still passes the
 * port-level case, and the object-identity cache still answers the extra-read case
 * from what it remembered. The port-level case pins the outcome chain such a digest protects - a
 * marker table installed through the official handle must still reach per-record
 * verification and refuse the conflicting MAC - and it discriminates an
 * identity-keyed cache but not a content-comparing one, because how many reads the
 * official write path itself performs decides whether the latter can be made to
 * serve a stale value there.
 */
const KEY = 'b'.repeat(64);
const uncached = (applied) => crypto.createHash('sha256').update(JSON.stringify(applied)).digest('hex');

/** One getter per key, counting how often the digest reads it. */
function countedTable(values) {
  const reads = new Map(Object.keys(values).map((key) => [key, 0]));
  const table = {};
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(table, key, { enumerable: true, configurable: true,
      get: () => { reads.set(key, reads.get(key) + 1); return value; } });
  }
  return { table, reads, reset: () => { for (const key of reads.keys()) reads.set(key, 0); } };
}

test('the digest reads each own enumerable key exactly once per call', () => {
  const values = { 'evolution:measurement-completed:a': 'a'.repeat(64),
    'evolution:measurement-completed:b': 'b'.repeat(64) };
  const { table, reads, reset } = countedTable(values);
  const expected = uncached(values);
  for (let call = 1; call <= 3; call += 1) {
    reset();
    assert.equal(digestApplied(table), expected, `call ${call} must digest the bytes it read`);
    assert.deepEqual(Object.fromEntries(reads), {
      'evolution:measurement-completed:a': 1, 'evolution:measurement-completed:b': 1,
    }, `call ${call} must not read a value it did not serialize`);
  }
});

test('a one-shot read is never remembered: the digest follows every call', () => {
  // The exact shape that served a stale digest, and the reason a snapshot is not a
  // substitute for the serialization: the getter reports A on its first read and B
  // on every read after that. A cache that hashes first and snapshots second stores
  // the digest of A against a snapshot of B, so every later comparison "matches" and
  // the digest never describes the table again.
  let reads = 0;
  const table = {};
  Object.defineProperty(table, 'evolution:measurement-completed:flip', { enumerable: true, configurable: true,
    get: () => (reads++ === 0 ? 'a'.repeat(64) : 'b'.repeat(64)) });
  assert.equal(digestApplied(table), uncached({ 'evolution:measurement-completed:flip': 'a'.repeat(64) }),
    'the first call must digest the value it read');
  const second = digestApplied(table);
  assert.equal(second, uncached({ 'evolution:measurement-completed:flip': 'b'.repeat(64) }),
    'the second call must digest the value it reads, not the one remembered');
  const third = digestApplied(table);
  assert.equal(third, second, 'once the read settles, every call agrees');
  assert.equal(reads, 3, 'one read per call, no more');
});

test('a non-object argument is digested by JSON semantics instead of throwing', () => {
  // The base implementation serializes whatever it is handed, so `null` is the
  // digest of "null". A cache keyed on the argument (a `WeakMap`) makes every
  // non-object throw instead - a new failure mode for any caller, not a rejection
  // of anything the checkpoint covers.
  assert.equal(digestApplied(null), uncached(null));
  assert.equal(digestApplied('marker'), uncached('marker'));
  assert.equal(digestApplied(7), uncached(7));
});

test('a root-level toJSON changes the digest, where it is own or inherited', () => {
  // `Object.keys()` never reports it, so anything that compares keys and values
  // misses it while `JSON.stringify` runs it.
  let produced = 'first';
  const ownHidden = { 'evolution:measurement-completed:m': 'a'.repeat(64) };
  Object.defineProperty(ownHidden, 'toJSON', { enumerable: false, configurable: true, value: () => ({ produced }) });
  const before = digestApplied(ownHidden);
  assert.equal(before, uncached({ produced: 'first' }));
  produced = 'second';
  assert.equal(digestApplied(ownHidden), uncached({ produced: 'second' }));
  assert.notEqual(digestApplied(ownHidden), before);

  let inherited = 'first';
  const prototype = { toJSON() { return { inherited }; } };
  const table = Object.create(prototype);
  table['evolution:measurement-completed:m'] = 'a'.repeat(64);
  const fromPrototype = digestApplied(table);
  assert.equal(fromPrototype, uncached({ inherited: 'first' }));
  inherited = 'second';
  assert.equal(digestApplied(table), uncached({ inherited: 'second' }));
  assert.notEqual(digestApplied(table), fromPrototype);
});

test('an array-shaped map is digested with array semantics', () => {
  // `length` and holes are part of the serialization but not of `Object.keys()`.
  const table = ['a'];
  const before = digestApplied(table);
  assert.equal(before, uncached(['a']));
  table.length = 3;
  assert.equal(digestApplied(table), uncached(table));
  assert.notEqual(digestApplied(table), before);
  assert.equal(JSON.stringify(table), '["a",null,null]');
});

test('the digest performs no read beyond the serialization, so it cannot throw where that cannot', () => {
  let reads = 0;
  const table = {};
  Object.defineProperty(table, 'evolution:measurement-completed:x', { enumerable: true, configurable: true,
    get: () => { if (reads++ === 0) return 'a'.repeat(64); throw new Error('second read'); } });
  assert.equal(digestApplied(table), uncached({ 'evolution:measurement-completed:x': 'a'.repeat(64) }));
  assert.equal(reads, 1, 'a value may be read once, by the serialization');
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'applied-digest-read-shape-'));
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = { emit() {}, on() { return () => {}; }, logger: { warn() {}, error() {} },
    storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'), eventBridgeKey: KEY };
  return { root, ctx, config, backend };
}

test('a marker table whose reads do not settle still cannot hide a conflicting marker', async () => {
  // The port-level form of the withdrawn shortcut's worst case: the live map is
  // given a getter that reports the committed MAC once and a different one
  // afterwards. The first pass may still trust the checkpoint (the bytes it hashed
  // carried the committed MAC); the next pass reads the different MAC, so the
  // checkpoint must no longer be trusted and per-record verification must refuse
  // the conflict rather than report every record as already applied.
  const f = await fixture();
  const port = await openDomainStorage(f.ctx, f.config);
  let closed = false;
  try {
    const envelopes = [1, 2, 3].map((sequence) => {
      const envelope = signEventBridgeEnvelope({ schema: 1, eventId: `evolution:measurement-completed:live-${sequence}`,
        eventType: 'measurement-completed', experimentId: `live-${sequence}`, status: 'measured',
        measurement: { latency: 1 }, audit: { at: '2026-10-07T00:00:00.000Z' } }, { key: KEY, sequence });
      fs.appendFileSync(f.config.eventBridgePath, `${JSON.stringify(envelope)}\n`);
      return envelope;
    });
    assert.deepEqual(await port.flush(), { applied: 3, duplicates: 0 });
    assert.deepEqual(await port.flush(), { applied: 0, duplicates: 3 }, 'the checkpoint must first be trusted');
    const handle = f.ctx.storageDomain.get(evolutionDomainSpec.name).global;
    const applied = handle.get().applied;
    const middle = envelopes[1].event.eventId;
    assert.equal(applied[middle], envelopes[1].mac);
    // Same object and the same key position: the value is replaced by a getter
    // that reports the committed MAC once, so nothing but the reads can tell that
    // it changed.
    let reads = 0;
    Object.defineProperty(applied, middle, { enumerable: true, configurable: true,
      get: () => (reads++ === 0 ? envelopes[1].mac : 'c'.repeat(64)) });
    assert.deepEqual(await port.flush(), { applied: 0, duplicates: 3 },
      'the pass that hashes the committed MAC may still trust the checkpoint');
    await assert.rejects(port.flush(), /E_DOMAIN_EVENT_ID_CONFLICT/,
      'a table that reports another MAC afterwards must be refused through per-record verification');
    // The port records the refusal and re-reports it on close; that is the same
    // refusal, not a second failure.
    await assert.rejects(port.close(), /E_DOMAIN_EVENT_ID_CONFLICT/);
    closed = true;
  } finally {
    if (!closed) await port.close().catch(() => {});
    await f.backend.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
