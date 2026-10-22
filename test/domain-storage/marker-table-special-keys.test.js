// The marker table is an ordinary object, and the port's merge/compare logic
// reads it with ordinary object semantics. That makes a handful of shapes
// load-bearing: a marker whose name comes from `Object.prototype`
// (`constructor`, `toString`, …), a marker whose value is `undefined`, an own
// `__proto__` key (which only `JSON.parse` or a define can create), a live table
// carrying an accessor, and the order the keys were written in.
//
// This round touches exactly that table: `mergeEventLedger()` walks the caller's
// copy with `Object.keys()` and one indexed read per key instead of
// `Object.entries()`, and the transaction stops cloning the aggregate a second
// time inside the working store. Everything else about the table is unchanged,
// so the evidence is differential: each scenario runs the released
// implementation (`release/dsh-evolution-0.2.0-rc.8.tgz`, the same pre-change
// pin the write-path equivalence test uses) and the working tree over the real
// `DomainFacility` + `JsonStorageBackend`, and requires the same outcome, the
// same durable document, the same checkpoint content and the same archive tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { domainStorageBaseline, materializeDomainStorage } from './domain-storage-baseline.js';
import { evolutionDomainSpec, openDomainStorage } from '../../lib/domain-storage.js';
import { signEventBridgeEnvelope } from '../../lib/orchestrator.js';
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

const KEY = 'b'.repeat(64);
const FROZEN_NOW = Date.parse('2026-10-12T00:00:00.000Z');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const MAC = (index) => crypto.createHash('sha256').update(`mac-${index}`).digest('hex');

async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-marker-table-'));
  try { return await fn(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

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
  const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'), eventBridgeKey: KEY };
  return { root, ctx, config, backend };
}

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

function freezeUuid() {
  const original = crypto.randomUUID;
  let counter = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
  syncBuiltinESMExports();
  return { reset: (base = 0) => { counter = base; }, restore: () => { crypto.randomUUID = original; syncBuiltinESMExports(); } };
}

/** Every durable byte except the two coordination files (lock, commit token). */
function durableTree(root) {
  const files = new Map();
  const walk = (directory, relative) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const nested = relative ? `${relative}/${name}` : name;
      if (fs.statSync(absolute).isDirectory()) walk(absolute, nested);
      else files.set(nested, sha256(fs.readFileSync(absolute)));
    }
  };
  for (const name of ['dockyard', 'official', 'domain-staging']) {
    const directory = path.join(root, name);
    if (fs.existsSync(directory)) walk(directory, name);
  }
  const checkpoint = path.join(root, 'event-log.checkpoint.json');
  if (fs.existsSync(checkpoint)) {
    const stored = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
    // The file identity is per-fixture by construction; its MAC binds it. Every
    // other field is content.
    files.set('checkpoint', sha256(JSON.stringify({ schema: stored.schema, bytes: stored.bytes, records: stored.records,
      digest: stored.digest, writer: stored.writer, first: stored.first, last: stored.last, appliedDigest: stored.appliedDigest })));
  }
  return Object.fromEntries(files);
}

function reset(root, uuid) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  uuid.reset();
}

const SIGNED = (sequence) => ({ schema: 1, eventId: `evolution:measurement-completed:special-${sequence}`,
  eventType: 'measurement-completed', experimentId: `special-${sequence}`, proposalId: `proposal:special-${sequence}`,
  target: 'plugin:special', capability: 'plugin:special', lineageId: 'plugin:special', status: 'measured',
  measurement: { latency: sequence }, evidence: { summary: 'marker table semantics' },
  audit: { producer: 'dsh-evolution-orchestrator', at: '2026-10-12T00:00:00.000Z' } });

/** Seed the committed document through the official handle, so the port's next
 *  transaction reads exactly the table a same-process writer could install. */
async function seed(f, applied) {
  const domain = f.ctx.storageDomain.get(evolutionDomainSpec.name);
  await domain.global.set({ schema: 1, aggregate: {}, applied, pending: null });
}

function append(f, sequence) {
  const envelope = signEventBridgeEnvelope(SIGNED(sequence), { key: KEY, sequence });
  fs.appendFileSync(f.config.eventBridgePath, `${JSON.stringify(envelope)}\n`);
  return envelope;
}

async function observe(open, home, tag, scenario) {
  const root = path.join(home, tag);
  const f = fixture(root);
  const port = await open(f.ctx, f.config);
  try {
    await scenario(f);
    // The measured action: the pass that consumes the log and commits.
    const result = await port.flush();
    return { result, tree: durableTree(root) };
  } catch (error) {
    return { threw: `${error?.name}: ${error?.message}`, tree: durableTree(root) };
  } finally {
    await port.close().catch(() => {});
    await f.backend.close();
  }
}

const SCENARIOS = {
  // Own markers whose names `Object.prototype` also answers. They are committed
  // as ordinary members of the table: the merge copies `recovered` (which owns
  // them), so the copy shadows the inherited value instead of reading it, and
  // the durable bytes have to keep them under those names.
  'prototype-named markers on the live table': async (f) => {
    await seed(f, { constructor: MAC(1), toString: MAC(2), hasOwnProperty: MAC(3), valueOf: MAC(4), regular: MAC(5) });
    append(f, 1);
    return null;
  },
  // A marker whose value is `undefined`, installed through the official handle the
  // way an in-process writer could. `applied` is a `record<string, string>`, so
  // the transaction-start validation refuses the document before any work - this
  // scenario pins that refusal (and that both implementations refuse the same
  // way); it does not reach the merge.
  'a marker value the schema rejects is refused at transaction start': async (f) => {
    const applied = { regular: MAC(5) };
    Object.defineProperty(applied, 'evolution:measurement-completed:special-1', { value: undefined, enumerable: true, writable: true, configurable: true });
    await seed(f, applied);
    append(f, 1);
    return null;
  },
  // An own `__proto__` marker, created the only way an object can own that name.
  'own __proto__ marker on the live table': async (f) => {
    const applied = JSON.parse(`{"__proto__":${JSON.stringify(MAC(1))},"regular":${JSON.stringify(MAC(5))}}`);
    assert.equal(Object.hasOwn(applied, '__proto__'), true);
    await seed(f, applied);
    append(f, 1);
    return null;
  },
  // An accessor on the live table, with a value that does not depend on how often
  // it is read: the transaction copies the table through its own spread, so the
  // committed marker is the accessor's value, not a re-read of anything.
  'live table carrying an accessor': async (f) => {
    const applied = { regular: MAC(5), second: MAC(6) };
    Object.defineProperty(applied, 'counted', { enumerable: true, configurable: true,
      get() { return MAC(100); } });
    await seed(f, applied);
    append(f, 1);
    return null;
  },
  // Insertion order that is not sorted: the published table keeps the recovered
  // order and appends the batch's markers in the log's order.
  'unsorted recovered order with a two-record batch': async (f) => {
    await seed(f, { zulu: MAC(26), alpha: MAC(1), mike: MAC(13) });
    append(f, 1);
    append(f, 2);
    return null;
  },
  // A record whose identity is a name `Object.prototype` already answers: the
  // marker lookup reads the inherited value, which is not this envelope's MAC, so
  // the pass refuses instead of publishing a marker under that name.
  'a record named after a prototype property is refused': async (f) => {
    await seed(f, { regular: MAC(5) });
    const envelope = signEventBridgeEnvelope({ ...SIGNED(1), eventId: 'toString' }, { key: KEY, sequence: 1 });
    fs.appendFileSync(f.config.eventBridgePath, `${JSON.stringify(envelope)}\n`);
    return null;
  },
};

test('the marker table keeps its object semantics against the released implementation', async () => {
  const baseline = await domainStorageBaseline();
  await withHome(async (home) => {
    const { openDomainStorage: openBaseline } = await materializeDomainStorage(baseline.source, home, 'baseline');
    const unfreezeClock = freezeClock();
    const uuid = freezeUuid();
    try {
      for (const [name, scenario] of Object.entries(SCENARIOS)) {
        reset(path.join(home, 'fixture-baseline'), uuid);
        const before = await observe(openBaseline, home, 'fixture-baseline', scenario);
        reset(path.join(home, 'fixture-after'), uuid);
        const after = await observe(openDomainStorage, home, 'fixture-after', scenario);
        assert.deepEqual(after, before, `${name}: the working tree must match the released implementation byte for byte`);
      }
    } finally {
      uuid.restore();
      unfreezeClock();
    }
  });
});

test('a live accessor whose value changes per read is still read by the copy, not by the merge', async () => {
  // The merge reads the recovered table (`{ ...recovered }`) and the caller's
  // frozen copy; it never reads the live table again. A live accessor that
  // answers differently on every read therefore makes the two disagree, and the
  // pass refuses with the conflict code instead of publishing a marker whose
  // value came from a different read. The released implementation
  // (`c85dfa7`) does the same; the rc.8 pin cannot be the differential here
  // because it predates the merge and simply commits, so this is asserted
  // directly.
  await withHome(async (home) => {
    const unfreezeClock = freezeClock();
    const uuid = freezeUuid();
    try {
      const root = path.join(home, 'fixture');
      reset(root, uuid);
      const f = fixture(root);
      const port = await openDomainStorage(f.ctx, f.config);
      try {
        const applied = { regular: MAC(5) };
        let reads = 0;
        Object.defineProperty(applied, 'counted', { enumerable: true, configurable: true,
          get() { reads += 1; return MAC(100 + reads); } });
        await seed(f, applied);
        const before = durableTree(root);
        append(f, 1);
        await assert.rejects(port.flush(), /E_DOMAIN_EVENT_ID_CONFLICT/, 'the pass must refuse rather than publish a re-read value');
        assert.deepEqual(durableTree(root), before, 'a refused pass commits no durable byte');
        const document = JSON.parse(fs.readFileSync(path.join(root, 'official', 'evolution_domain.json'), 'utf8')).global;
        assert.equal(document.pending, null, 'a refused pass publishes no pending record');
      } finally {
        await port.close().catch(() => {});
        await f.backend.close();
      }
    } finally {
      uuid.restore();
      unfreezeClock();
    }
  });
});

test('a recovered table that lost a prototype-named marker refuses the caller table', async () => {
  // This is the merge boundary itself: an interrupted commit left a pending
  // record whose marker table lacks `constructor`, while the live document the
  // caller's table is copied from owns it. Recovery installs the pending record
  // first (that is what recovery is for), and then the merge reads
  // `merged['constructor']` from `Object.prototype` instead of from an own
  // marker and refuses the batch instead of re-publishing the marker under that
  // name. The released rc.8 pin predates the merge and would simply commit, so
  // this is asserted directly rather than differentially.
  await withHome(async (home) => {
    const unfreezeClock = freezeClock();
    const uuid = freezeUuid();
    try {
      const root = path.join(home, 'fixture');
      reset(root, uuid);
      const f = fixture(root);
      const port = await openDomainStorage(f.ctx, f.config);
      try {
        const stage = 'stage-00000000-0000-4000-8000-000000000000';
        fs.mkdirSync(path.join(root, 'domain-staging', stage), { recursive: true, mode: 0o700 });
        const domain = f.ctx.storageDomain.get(evolutionDomainSpec.name);
        await domain.global.set({ schema: 1, aggregate: {},
          applied: { constructor: MAC(1), regular: MAC(5) },
          pending: { stage, aggregate: {}, applied: { regular: MAC(5) }, files: [] } });
        append(f, 1);
        await assert.rejects(port.flush(), /E_DOMAIN_EVENT_ID_CONFLICT/,
          'the batch must be refused instead of publishing a marker under the prototype name');
        const document = JSON.parse(fs.readFileSync(path.join(root, 'official', 'evolution_domain.json'), 'utf8')).global;
        assert.equal(document.pending, null, 'the recovered record was installed before the batch was refused');
        assert.deepEqual(Object.keys(document.applied).sort(), ['regular'], 'the pending table is what stayed durable');
        assert.equal(Object.hasOwn(document.applied, 'constructor'), false, 'and the batch published no marker under that name');
      } finally {
        await port.close().catch(() => {});
        await f.backend.close();
      }
    } finally {
      uuid.restore();
      unfreezeClock();
    }
  });
});

test('a record named after a prototype property is refused, not published', async () => {
  // The refusal itself is the boundary this shape pins: the pass does not
  // silently publish a marker under a name `Object.prototype` already answers,
  // and a refused pass commits nothing.
  await withHome(async (home) => {
    const unfreezeClock = freezeClock();
    const uuid = freezeUuid();
    try {
      reset(path.join(home, 'fixture'), uuid);
      const outcome = await observe(openDomainStorage, home, 'fixture', SCENARIOS['a record named after a prototype property is refused']);
      assert.match(outcome.threw ?? '', /E_DOMAIN_EVENT_ID_CONFLICT/, 'the pass must refuse the prototype-named record');
      const document = JSON.parse(fs.readFileSync(path.join(home, 'fixture', 'official', 'evolution_domain.json'), 'utf8')).global;
      assert.equal(document.pending, null, 'a refused pass publishes no pending record');
      assert.equal(Object.hasOwn(document.applied, 'toString'), false, 'and no marker under the prototype name');
    } finally {
      uuid.restore();
      unfreezeClock();
    }
  });
});
