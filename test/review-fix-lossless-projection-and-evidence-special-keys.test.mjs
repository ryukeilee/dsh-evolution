// Review fix: three projection boundaries assigned data-derived keys onto `{}`.
//
// `JSON.parse` really creates an own `__proto__` data property. `output[key] =
// value` then hits `Object.prototype`'s `__proto__` accessor instead of defining
// a property: the key is dropped silently, and if the value is an object it
// *becomes the prototype* of the output, so later field reads on that output see
// fields the payload never owned. Three boundaries in `lib/orchestrator.js` did
// this:
//
//   1. `toLosslessJson()` — every `evolution_*` tool result (`losslessResult`),
//      `EvolutionOrchestrator.inspect()` (through `snapshotJson`'s guarded
//      fallback) and `EvolutionEventBridge.project()` (payload written to disk +
//      covered by the envelope MAC).
//   2. `safeErrorEvidence()` — the only boundary for `recoveryProof` /
//      `cleanupProof` / `rollbackResult`. Beyond losing evidence, an inherited
//      `status: "recovered"` used to fake a recovery: `hydrateRecordFromSnapshot`
//      reads `snapshot.recoveryProof.status` and sets `runtimeRecovered = true`.
//   3. `mergeEvidenceSources()`'s `mergeLatest()` — per-key assignment while
//      merging a higher-priority `latestObservation` into a lower-priority copy.
//
// The tests below are behavioural: they read the exported surfaces (`inspect`,
// the registered tool, the event bridge, the evidence snapshot/hydrate/merge
// entry points) rather than the source text. The ordinary-input tests are
// differential against the frozen pre-fix implementations and against byte pins
// captured on the pre-fix tree, so a fix that changes a payload without an own
// `__proto__` fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EvolutionEventBridge,
  EvolutionOrchestrator,
  EVENT_BRIDGE_DEFAULT_WRITER,
  hydrateRecordFromSnapshot,
  mergeEvidenceSources,
  persistEvidenceSnapshot,
  readEvidenceSnapshot,
  renderExperimentArchive,
  signEventBridgeEnvelope,
  snapshotEvidenceFromRecord,
  toLosslessJson,
  verifyEventBridgeEnvelope,
} from '../lib/orchestrator.js';
import { apply } from '../lib/registration.js';
import { context, config, legacyInspect, populate } from './fixtures/runtime-inspect.mjs';

const agent = { id: 'fixture-agent' };
const SECRET = 'Z7r6Secret9';

/** `{"__proto__": …}` as `JSON.parse` really builds it: an own data property. */
const proto = (text) => JSON.parse(text);

// The pre-fix implementation, frozen verbatim (including the `ancestors`
// parameter). It is the differential baseline for ordinary input: only payloads
// that own a `__proto__` key may project differently after the fix.
const PRE_FIX_TO_LOSSLESS_JSON = (value, ancestors = new Set()) => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "undefined") return null;
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") return String(value);
  if (ancestors.has(value)) return "[Circular]";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => PRE_FIX_TO_LOSSLESS_JSON(item, ancestors));
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) return { name: value.name, message: String(value.message ?? "") };
    if (value instanceof Map) return [...value.entries()].map((entry) => PRE_FIX_TO_LOSSLESS_JSON(entry, ancestors));
    if (value instanceof Set) return [...value.values()].map((item) => PRE_FIX_TO_LOSSLESS_JSON(item, ancestors));
    const plain = Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
    const result = plain ? {} : { $class: value.constructor?.name || "anonymous" };
    for (const key of Object.keys(value)) {
      result[key] = PRE_FIX_TO_LOSSLESS_JSON(value[key], ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
};

// The pre-fix `mergeLatest` closure, frozen verbatim together with the
// `isMissing` it calls (`lib/orchestrator.js` at 2aa67d9). It is the differential
// baseline for the merge: only a payload that owns a `__proto__` key may merge
// differently after the fix, because `merged[key] = …` hit the prototype setter.
// Note that `isMissing(candidate[key])` is an inherited read for a key the
// candidate does not own (`toString` and friends), exactly as before.
const PRE_FIX_IS_MISSING = (value) => {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
};

const PRE_FIX_MERGE_LATEST = (acc, candidate) => {
  if (PRE_FIX_IS_MISSING(candidate)) return acc;
  if (PRE_FIX_IS_MISSING(acc)) return candidate;
  const merged = { ...candidate };
  for (const key of Object.keys(acc)) {
    if (PRE_FIX_IS_MISSING(acc[key])) {
      if (!PRE_FIX_IS_MISSING(candidate[key])) merged[key] = candidate[key];
    } else {
      merged[key] = acc[key];
    }
  }
  return merged;
};

// Byte pins captured by running these exact fixtures on the pre-fix tree
// (`lib/orchestrator.js` at 2aa67d9), so ordinary input stays byte for byte.
const PRE_FIX_RECOVERY_PROOF_JSON = '{"status":"recovered","source":"disposeTrial","verificationSource":"disposeTrial:stop+undefine+signature","capturedAt":"2026-10-01T00:00:00.000Z","beforeFingerprint":{"tools":["alpha","beta"],"counts":{"tools":2,"services":1},"signature":"sig-1"},"afterFingerprint":{"tools":["alpha"],"counts":{"tools":1,"services":1},"signature":"sig-0"},"noOrphans":true,"recoveryPending":false,"runtimeRecovered":true,"cleanupProof":{"status":"recovered","errors":[],"stopOk":true,"undefineOk":true,"at":"2026-10-01T00:00:00.000Z"}}';
const PRE_FIX_LEGACY_RECOVERY_PROOF_JSON = '{"status":"failed","reason":"provider timeout after 30s","errors":[{"code":"ETIMEDOUT","at":"2026-10-01T00:00:00.000Z"},"retry-exhausted"],"attempts":12,"nested":{"step":1,"ok":false,"notes":["a","b"]}}';
const PRE_FIX_MERGE_JSON = '{"version":1,"source":"journal+bridge","capturedAt":"2026-10-02T00:00:00.000Z","promotionTimestamp":"2026-10-01T00:00:00.000Z","observations":[{"id":"obs-high","at":"2026-10-01T00:00:00.000Z"},{"id":"obs-low","at":"2026-10-02T00:00:00.000Z"}],"latestObservation":{"at":"high","regressionPassed":true,"repeatable":false,"solvesProblem":true,"extra":"appended","orphanResources":[],"metrics":{"cpu":1}},"cleanupProof":{"status":"recovered","errors":[],"stopOk":true},"recoveryProof":{"status":"recovered","noOrphans":true},"runtimeRecovered":true,"gateEvidence":{"gates":["a"]},"durable":{"pluginName":"p"},"ownerId":"owner-1","proposal":{"why":"lower-priority proposal"}}';

// Ordinary proofs: no own `__proto__` key anywhere.
const ORDINARY_PROOF = () => ({
  status: 'recovered',
  source: 'disposeTrial',
  verificationSource: 'disposeTrial:stop+undefine+signature',
  capturedAt: '2026-10-01T00:00:00.000Z',
  beforeFingerprint: { tools: ['alpha', 'beta'], counts: { tools: 2, services: 1 }, signature: 'sig-1' },
  afterFingerprint: { tools: ['alpha'], counts: { tools: 1, services: 1 }, signature: 'sig-0' },
  noOrphans: true,
  recoveryPending: false,
  runtimeRecovered: true,
  cleanupProof: { status: 'recovered', errors: [], stopOk: true, undefineOk: true, at: '2026-10-01T00:00:00.000Z' },
});

const ORDINARY_LEGACY_PROOF = () => ({
  status: 'failed',
  reason: 'provider timeout after 30s',
  errors: [{ code: 'ETIMEDOUT', at: '2026-10-01T00:00:00.000Z' }, 'retry-exhausted'],
  attempts: 12,
  nested: { step: 1, ok: false, notes: ['a', 'b'] },
});

const MERGE_SOURCES = () => ([
  {
    version: 1,
    source: 'journal',
    capturedAt: '2026-10-01T00:00:00.000Z',
    promotionTimestamp: '2026-10-01T00:00:00.000Z',
    observations: [{ id: 'obs-high', at: '2026-10-01T00:00:00.000Z' }],
    latestObservation: { at: 'high', regressionPassed: true, metrics: { cpu: 1 } },
    cleanupProof: { status: 'recovered', errors: [], stopOk: true },
    recoveryProof: { status: 'recovered', noOrphans: true },
    runtimeRecovered: true,
    gateEvidence: { gates: ['a'] },
    durable: { pluginName: 'p' },
    ownerId: 'owner-1',
  },
  {
    version: 1,
    source: 'bridge',
    capturedAt: '2026-10-02T00:00:00.000Z',
    promotionTimestamp: null,
    observations: [{ id: 'obs-low', at: '2026-10-02T00:00:00.000Z' }],
    latestObservation: {
      at: '',
      regressionPassed: false,
      repeatable: false,
      solvesProblem: true,
      extra: 'appended',
      orphanResources: [],
      metrics: { cpu: 9 },
    },
    cleanupProof: { status: 'unknown' },
    recoveryProof: { status: 'not-run' },
    runtimeRecovered: false,
    gateEvidence: { gates: ['b'] },
    proposal: { why: 'lower-priority proposal' },
  },
]);

/** The projection a `cleanupProof` gets before it reaches the evidence sidecar. */
function cleanupProofOf(proof) {
  return snapshotEvidenceFromRecord({ cleanupProof: proof }).cleanupProof;
}

// ---------------------------------------------------------------------------
// A. `toLosslessJson`
// ---------------------------------------------------------------------------

test('A1 an own __proto__ key survives the projection as an own data property', () => {
  const source = proto(`{"__proto__":{"isAdmin":true,"secret":"${SECRET}"},"a":1,"nested":{"__proto__":{"x":1},"b":2}}`);
  const out = toLosslessJson(source);
  assert.deepEqual(Object.keys(out), ['__proto__', 'a', 'nested']);
  assert.equal(Object.hasOwn(out, '__proto__'), true, 'the key must exist as an own property');
  assert.equal(Object.getPrototypeOf(out), Object.prototype, 'the payload must not become the prototype');
  assert.equal(out.isAdmin, undefined, 'no field may be inherited from the payload');
  assert.equal(out.secret, undefined);
  assert.equal(out.a, 1);
  const serialized = JSON.stringify(out);
  assert.equal(serialized.includes('"__proto__"'), true, serialized);
  assert.equal(serialized.includes(SECRET), true, 'the payload is data, so it is serialized');
  assert.deepEqual(JSON.parse(serialized), source);
});

test('A2 nested objects and array elements keep their own __proto__ key', () => {
  const out = toLosslessJson(proto('{"nested":{"__proto__":{"x":1},"b":2},"list":[{"__proto__":{"y":2},"c":3},7]}'));
  assert.equal(Object.hasOwn(out.nested, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(out.nested), Object.prototype);
  assert.equal(out.nested.x, undefined);
  assert.equal(out.nested.b, 2);
  assert.equal(Object.hasOwn(out.list[0], '__proto__'), true);
  assert.equal(Object.getPrototypeOf(out.list[0]), Object.prototype);
  assert.equal(out.list[0].y, undefined);
  assert.equal(out.list[0].c, 3);
  assert.equal(JSON.stringify(out), '{"nested":{"__proto__":{"x":1},"b":2},"list":[{"__proto__":{"y":2},"c":3},7]}');
});

test('A3 other prototype-named keys stay ordinary own keys, byte for byte', () => {
  // `constructor` / `toString` / `hasOwnProperty` are data properties, not
  // accessors, so they were never broken; they must not be folded into the
  // `__proto__` fix.
  const source = proto('{"constructor":{"a":1},"toString":"text","hasOwnProperty":[1,2],"b":2}');
  const out = toLosslessJson(source);
  assert.deepEqual(Object.keys(out), ['constructor', 'toString', 'hasOwnProperty', 'b']);
  assert.equal(Object.hasOwn(out, 'constructor'), true);
  assert.deepEqual(out.constructor, { a: 1 });
  assert.equal(typeof out.toString, 'string');
  assert.equal(out.toString, 'text');
  assert.deepEqual(out.hasOwnProperty, [1, 2]);
  assert.equal(JSON.stringify(out), '{"constructor":{"a":1},"toString":"text","hasOwnProperty":[1,2],"b":2}');
  assert.deepEqual(out, source);
});

/** A corpus with no own `__proto__` key: the fix must not touch any of it. */
function ordinaryCorpus() {
  class Custom { constructor() { this.value = 1; this.nested = { deep: true }; } }
  class Tagged { constructor() { this.$class = 'own-tag'; this.value = 2; } }
  const shared = { nested: { value: 1 } };
  const cycle = { name: 'cycle' }; cycle.self = cycle;
  const sparse = new Array(3); sparse[1] = 'x';
  return [
    null, true, false, 'text', '', 0, 1, -1, 1.5, -0, Number.NaN,
    Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 12n, undefined, () => {}, Symbol('s'),
    new Date('2026-10-01T00:00:00.000Z'),
    new Error('boom'),
    new Map([['a', shared], ['b', 1]]),
    new Set([shared, 'x']),
    new Custom(), new Tagged(),
    sparse, [1, [2, [3]]],
    cycle, { a: shared, b: shared },
    Object.assign(Object.create(null), { value: undefined, other: 2 }),
    { nested: { deep: [1, { deeper: null }] } },
  ];
}

test('A4 ordinary input projects exactly as the pre-fix implementation did', () => {
  const corpus = ordinaryCorpus();
  for (let index = 0; index < corpus.length; index += 1) {
    const value = corpus[index];
    const label = `corpus[${index}] (${Array.isArray(value) ? 'array' : typeof value})`;
    const expected = PRE_FIX_TO_LOSSLESS_JSON(value);
    const actual = toLosslessJson(value);
    assert.deepStrictEqual(actual, expected, `projection changed for ${label}`);
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), `bytes changed for ${label}`);
  }
  // Key order is part of the contract, including `$class` staying first while an
  // instance's own `$class` overrides the value in place.
  const ordered = toLosslessJson({ b: 1, a: 2, c: { z: 1, y: 2 } });
  assert.deepEqual(Object.keys(ordered), ['b', 'a', 'c']);
  assert.deepEqual(Object.keys(ordered.c), ['z', 'y']);
  const tag = toLosslessJson(new (class Thing { constructor() { this.$class = 'own'; this.v = 1; } })());
  assert.deepEqual(Object.keys(tag), ['$class', 'v']);
  assert.equal(tag.$class, 'own');
  assert.equal(JSON.stringify(tag), '{"$class":"own","v":1}');
});

test('A5 Error projection is unchanged, including a non-string name', async () => {
  assert.deepEqual(toLosslessJson(new Error('boom')), { name: 'Error', message: 'boom' });
  // The `Error` branch returns `name` verbatim, so a cyclic non-JSON `name` is
  // still carried through unprojected; the registered tool's second projection is
  // what flattens it. That is the existing behaviour, asserted the way
  // `test/runtime-inspect.test.mjs` asserts it.
  const ctx = context();
  const core = apply(ctx, config);
  core.observations = [JSON.parse('{"__proto__":{"value":1}}')];
  const error = new Error('fixture');
  error.name = {};
  error.name.self = error.name;
  ctx.schema.error = error;
  assert.deepEqual(await ctx.definitions.get('evolution_runtime_inspect').execute({}, { agent }),
    toLosslessJson(legacyInspect(core, agent)));
});

test('A6 inspect and the registered tool keep the own __proto__ key', async () => {
  const ctx = context();
  const core = apply(ctx, config);
  populate(core);
  core.observations = [proto('{"__proto__":{"value":1}}')];
  core.candidates.set('k', proto('{"__proto__":{"value":2},"id":"c"}'));
  const expected = legacyInspect(core, agent);
  const snapshot = core.inspect(agent);
  assert.deepEqual(snapshot, expected);
  for (const [label, value, want] of [
    ['evolutionObservations[0]', snapshot.evolutionObservations[0], '{"__proto__":{"value":1}}'],
    // `populate()` already filled the candidate map, so the fixture candidate is
    // the last entry.
    ['evolutionCandidates.at(-1)', snapshot.evolutionCandidates.at(-1), '{"__proto__":{"value":2},"id":"c"}'],
  ]) {
    assert.equal(Object.hasOwn(value, '__proto__'), true, `${label} lost the key`);
    assert.equal(Object.getPrototypeOf(value), Object.prototype, `${label} had its prototype replaced`);
    assert.equal(value.value, undefined, `${label} inherited a payload field`);
    assert.equal(JSON.stringify(value), want, label);
  }
  const output = await ctx.definitions.get('evolution_runtime_inspect').execute({}, { agent });
  assert.deepEqual(output, expected);
  assert.equal(Object.hasOwn(output.evolutionObservations[0], '__proto__'), true);
  assert.equal(JSON.stringify(output.evolutionObservations[0]), '{"__proto__":{"value":1}}');
});

test('A7 the event bridge keeps the key and its envelope MAC still verifies', () => {
  const key = 'k'.repeat(40);
  const bridge = new EvolutionEventBridge({ key });
  const event = bridge.project('measurement-completed', { id: 'exp-1' }, {
    measurement: proto(`{"__proto__":{"p":1},"keep":"x"}`),
    evidence: proto('{"__proto__":{"payload":"yes"},"keep":"y"}'),
  });
  for (const [label, value, want] of [
    ['measurement', event.measurement, '{"__proto__":{"p":1},"keep":"x"}'],
    ['evidence', event.evidence, '{"__proto__":{"payload":"yes"},"keep":"y"}'],
  ]) {
    assert.equal(Object.hasOwn(value, '__proto__'), true, `${label} lost the key`);
    assert.equal(Object.getPrototypeOf(value), Object.prototype, `${label} had its prototype replaced`);
    assert.equal(value.p, undefined, `${label} inherited a payload field`);
    assert.equal(value.payload, undefined);
    assert.equal(JSON.stringify(value), want, label);
  }
  const envelope = signEventBridgeEnvelope(event, { key, writer: EVENT_BRIDGE_DEFAULT_WRITER, sequence: 1 });
  const decoded = JSON.parse(JSON.stringify(envelope));
  const verified = verifyEventBridgeEnvelope(decoded, key);
  assert.ok(verified, 'the signed envelope must survive a JSON round trip with the key present');
  assert.equal(Object.hasOwn(verified.event.measurement, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(verified.event.measurement), Object.prototype);
  assert.equal(verified.event.measurement.p, undefined);
  assert.equal(JSON.stringify(verified.event.measurement), '{"__proto__":{"p":1},"keep":"x"}');
});

test('A8 Map/Set entries and a null-prototype object keep their own __proto__ key', () => {
  const shared = proto('{"__proto__":{"x":1},"b":2}');
  // A `Map` projects to an entries array and a `Set` to a values array, so the
  // key has to survive one container deeper.
  const mapOut = toLosslessJson(new Map([['k', shared]]));
  assert.equal(Array.isArray(mapOut), true);
  assert.equal(mapOut.length, 1);
  assert.equal(mapOut[0][0], 'k');
  assert.equal(Object.hasOwn(mapOut[0][1], '__proto__'), true);
  assert.equal(Object.getPrototypeOf(mapOut[0][1]), Object.prototype);
  assert.equal(mapOut[0][1].x, undefined);
  assert.equal(mapOut[0][1].b, 2);
  assert.equal(JSON.stringify(mapOut), '[["k",{"__proto__":{"x":1},"b":2}]]');

  const setOut = toLosslessJson(new Set([shared, 'plain']));
  assert.equal(Array.isArray(setOut), true);
  assert.equal(Object.hasOwn(setOut[0], '__proto__'), true);
  assert.equal(Object.getPrototypeOf(setOut[0]), Object.prototype);
  assert.equal(setOut[0].x, undefined);
  assert.equal(setOut[1], 'plain');
  assert.equal(JSON.stringify(setOut), '[{"__proto__":{"x":1},"b":2},"plain"]');

  // `Object.create(null)` has no `__proto__` accessor, so the key is only own
  // when a caller defines it explicitly. The projection still has to keep it as
  // an own data property (the output is an ordinary object, as before) and must
  // not let the payload become the output's prototype.
  const bare = Object.create(null);
  Object.defineProperty(bare, '__proto__', { value: { y: 2 }, enumerable: true, configurable: true, writable: true });
  bare.keep = 3;
  const bareOut = toLosslessJson(bare);
  assert.equal(Object.getPrototypeOf(bareOut), Object.prototype);
  assert.deepEqual(Object.keys(bareOut), ['__proto__', 'keep']);
  assert.equal(Object.hasOwn(bareOut, '__proto__'), true);
  assert.equal(bareOut.y, undefined, 'no field may be inherited from the payload');
  assert.equal(bareOut.keep, 3);
  assert.equal(JSON.stringify(bareOut), '{"__proto__":{"y":2},"keep":3}');
});

// ---------------------------------------------------------------------------
// B. `safeErrorEvidence` / the proof path
// ---------------------------------------------------------------------------

test('B8 a proof that owns __proto__ keeps the key and inherits no status', () => {
  const proof = proto('{"__proto__":{"status":"recovered","gateEvidence":{"eligible":true}},"verificationSource":"probe"}');
  const snapshot = snapshotEvidenceFromRecord({ recoveryProof: proof });
  const projected = snapshot.recoveryProof;
  assert.deepEqual(Object.keys(projected), ['__proto__', 'verificationSource']);
  assert.equal(Object.hasOwn(projected, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(projected), Object.prototype);
  assert.equal(projected.status, undefined, 'status must not be inherited from the payload');
  assert.equal(projected.verificationSource, 'probe');
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes('"__proto__"'), true, serialized);

  // The same projection runs on the read-back path of the archive renderer.
  const archive = renderExperimentArchive({ id: 'exp-1', state: 'completed', reason: 'done', recoveryProof: proof, recovered: false });
  assert.equal(archive.includes(`"__proto__":{"status":"recovered","gateEvidence":{"eligible":true}}`), true);
  assert.equal(archive.includes('- recovered: false'), true);
});

test('B9 a status that lives only in own __proto__ cannot fake a recovery', () => {
  const snapshot = snapshotEvidenceFromRecord({ recoveryProof: proto('{"__proto__":{"status":"recovered"},"verificationSource":"probe"}') });
  const record = hydrateRecordFromSnapshot({ runtimeRecovered: false }, snapshot);
  assert.equal(record.runtimeRecovered, false, 'hydration must not read an inherited status');

  // The merge path reads `.status` too (`isUnknownStatus` / `preferPriority`):
  // a proof with no own status is not "known recovered", and a lower-priority
  // source must not upgrade it.
  const other = {
    source: 'bridge',
    capturedAt: '2026-10-02T00:00:00.000Z',
    latestObservation: { at: 'bridge' },
    recoveryProof: { status: 'unknown' },
    runtimeRecovered: false,
  };
  const merged = mergeEvidenceSources([snapshot, other]);
  assert.equal(Object.hasOwn(merged.recoveryProof, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(merged.recoveryProof), Object.prototype);
  assert.equal(merged.recoveryProof.status, undefined);
  assert.equal(hydrateRecordFromSnapshot({ runtimeRecovered: false }, merged).runtimeRecovered, false);
});

test('B10 nested objects and array-borne records keep their own __proto__ key', () => {
  const proof = proto('{"outer":{"__proto__":{"errors":["boom"]},"keep":1},"records":[{"__proto__":{"errors":["e"]},"id":"r1"}]}');
  const projected = snapshotEvidenceFromRecord({ recoveryProof: proof }).recoveryProof;
  assert.equal(Object.hasOwn(projected.outer, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(projected.outer), Object.prototype);
  assert.equal(projected.outer.errors, undefined, 'errors must not be inherited');
  assert.equal(projected.outer.keep, 1);
  assert.equal(Object.hasOwn(projected.records[0], '__proto__'), true);
  assert.equal(Object.getPrototypeOf(projected.records[0]), Object.prototype);
  assert.equal(projected.records[0].errors, undefined);
  assert.equal(projected.records[0].id, 'r1');
});

test('B11 redaction, the dropped-key list and the depth bound are unchanged', () => {
  // Key-aware whole-value redaction still fires on a credential key.
  assert.deepEqual(cleanupProofOf({ evidence: { access_token: SECRET } }), { evidence: { access_token: '[redacted]' } });
  // A credential-shaped string inside the own __proto__ payload is still redacted,
  // and the key it sits under is now preserved instead of dropped.
  const nested = cleanupProofOf(proto(`{"__proto__":{"note":"password=${SECRET}"},"status":"failed"}`));
  assert.equal(Object.hasOwn(nested, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(nested), Object.prototype);
  assert.equal(nested.__proto__.note, 'password=[redacted]');
  assert.equal(JSON.stringify(nested).includes(SECRET), false);
  // The dropped-key list is unchanged.
  assert.deepEqual(cleanupProofOf({
    status: 'failed', raw: 'r', fullOutput: 'f', stdout: 's', stderr: 'e',
    logs: ['l'], log: 'l2', transcript: 't', keep: 'k',
  }), { status: 'failed', keep: 'k' });
  // The cleanup/recovery receipt bound (`maxDepth: 4`, the `safeErrorEvidence`
  // default) is unchanged; it is reachable through the archive's failure block.
  const archive = renderExperimentArchive({
    id: 'exp-depth', state: 'failed', reason: 'boom',
    failure: { failurePhase: 'runtime', rollbackResult: { a: { b: { c: { d: { e: 'deep' } } } } } },
  });
  const failureBlock = archive.split('## Failure learning')[1].split('```json')[1].split('```')[0];
  const storedFailure = JSON.parse(failureBlock);
  assert.equal(storedFailure.failurePhase, 'runtime');
  assert.equal(storedFailure.rollbackResult.a.b.c, '[compacted]');
  // The proof bound (`maxDepth: 8`) is unchanged.
  const deep = snapshotEvidenceFromRecord({ recoveryProof: { a: { b: { c: { d: { e: { f: { g: { h: { i: 'deep' } } } } } } } } } }).recoveryProof;
  assert.equal(deep.a.b.c.d.e.f.g.h, '[compacted]');
});

test('B12 ordinary proofs project byte for byte as before', () => {
  assert.equal(JSON.stringify(snapshotEvidenceFromRecord({ recoveryProof: ORDINARY_PROOF() }).recoveryProof),
    PRE_FIX_RECOVERY_PROOF_JSON);
  assert.equal(JSON.stringify(snapshotEvidenceFromRecord({ recoveryProof: ORDINARY_LEGACY_PROOF() }).recoveryProof),
    PRE_FIX_LEGACY_RECOVERY_PROOF_JSON);
});

test('B13 unreadable containers still degrade to [compacted] instead of throwing', () => {
  const throwingGetter = {};
  Object.defineProperty(throwingGetter, 'status', { enumerable: true, get() { throw new TypeError('status exploded'); } });
  assert.equal(cleanupProofOf(throwingGetter), '[compacted]');

  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.doesNotThrow(() => cleanupProofOf(revoked.proxy));
  assert.equal(cleanupProofOf(revoked.proxy), '[compacted]');

  // An array Proxy whose own `slice` returns a non-array: the traversal fails
  // closed for that node and the sibling fields survive.
  const nonArraySlice = new Proxy([1, 2, 3], {
    get(target, key, receiver) {
      if (key === 'slice') return () => ({});
      return Reflect.get(target, key, receiver);
    },
  });
  const record = cleanupProofOf({ status: 'failed', errors: nonArraySlice, stopOk: true });
  assert.deepEqual(record, { status: 'failed', errors: '[compacted]', stopOk: true });

  // An ordinary array is untouched by the guards.
  assert.deepEqual(cleanupProofOf({ errors: ['timeout', { note: 'x' }] }), { errors: ['timeout', { note: 'x' }] });
});

test('B14 a sparse proof keeps its holes instead of gaining undefined entries', () => {
  const sparse = new Array(4);
  sparse[1] = 'first';
  sparse[3] = { code: 'E_FAIL', at: '2026-10-01T00:00:00.000Z' };
  const projected = cleanupProofOf({ status: 'failed', errors: sparse });
  assert.equal(Array.isArray(projected.errors), true);
  assert.equal(projected.errors.length, 4, 'the length must not change');
  assert.equal(0 in projected.errors, false, 'the leading hole must stay a hole');
  assert.equal(2 in projected.errors, false, 'the middle hole must stay a hole');
  assert.equal(projected.errors[1], 'first');
  assert.deepEqual(projected.errors[3], { code: 'E_FAIL', at: '2026-10-01T00:00:00.000Z' });
  assert.equal(JSON.stringify(projected.errors),
    '[null,"first",null,{"code":"E_FAIL","at":"2026-10-01T00:00:00.000Z"}]');

  // A present element that owns `__proto__` is projected like any other element.
  const element = cleanupProofOf({ errors: [proto('{"__proto__":{"errors":["boom"]},"keep":1}')] }).errors[0];
  assert.equal(Object.hasOwn(element, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(element), Object.prototype);
  assert.equal(element.errors, undefined);
  assert.equal(element.keep, 1);
});

// ---------------------------------------------------------------------------
// C. `mergeEvidenceSources`
// ---------------------------------------------------------------------------

test('C14 the higher-priority latestObservation keeps its own __proto__ key and wins', () => {
  const high = {
    source: 'journal',
    capturedAt: '2026-10-01T00:00:00.000Z',
    latestObservation: proto('{"__proto__":{"p":1},"keep":"x","shared":1,"note":""}'),
  };
  const low = {
    source: 'bridge',
    capturedAt: '2026-10-02T00:00:00.000Z',
    latestObservation: { __y: 2, shared: 2, keep: 'low', note: 'low-note' },
  };
  const merged = mergeEvidenceSources([high, low]).latestObservation;
  assert.equal(Object.hasOwn(merged, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  assert.equal(merged.p, undefined, 'no field may be inherited from the payload');
  assert.deepEqual(merged.__proto__, { p: 1 });
  // The higher-priority source still wins field by field …
  assert.equal(merged.keep, 'x');
  assert.equal(merged.shared, 1);
  // … a missing higher-priority value still falls back to the candidate …
  assert.equal(merged.note, 'low-note');
  // … and a candidate-only field is still kept.
  assert.equal(merged.__y, 2);
  assert.deepEqual(Object.keys(merged), ['__y', 'shared', 'keep', 'note', '__proto__']);
  assert.equal(JSON.stringify(merged), '{"__y":2,"shared":1,"keep":"x","note":"low-note","__proto__":{"p":1}}');
});

test('C15 ordinary merge input is byte identical to the pre-fix merge', () => {
  assert.equal(JSON.stringify(mergeEvidenceSources(MERGE_SOURCES())), PRE_FIX_MERGE_JSON);
  const merged = mergeEvidenceSources(MERGE_SOURCES());
  assert.equal(merged.runtimeRecovered, true);
  assert.equal(merged.recoveryProof.status, 'recovered');
  assert.equal(merged.cleanupProof.status, 'recovered');
  // The merge is priority-ordered, not commutative: the same two sources in the
  // other order produce the other order's winners. That is the existing contract
  // (`preferX` keeps the accumulated high-priority value), pinned here so the
  // `Map` rewrite is not mistaken for a reordering.
  assert.deepEqual(Object.keys(merged.latestObservation),
    ['at', 'regressionPassed', 'repeatable', 'solvesProblem', 'extra', 'orphanResources', 'metrics']);
  const reversed = mergeEvidenceSources(MERGE_SOURCES().reverse());
  assert.equal(reversed.latestObservation.regressionPassed, false);
  assert.deepEqual(reversed.latestObservation.metrics, { cpu: 9 });
});

test('C16 the evidence sidecar keeps own __proto__ keys across a write and a read', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-evidence-special-key-'));
  try {
    const snapshot = snapshotEvidenceFromRecord({
      recoveryProof: proto('{"__proto__":{"status":"recovered"},"verificationSource":"probe"}'),
      latestObservation: proto('{"__proto__":{"p":1},"keep":"x"}'),
    });
    await persistEvidenceSnapshot(dir, 'exp-x', snapshot);
    const loaded = await readEvidenceSnapshot(dir, 'exp-x');
    for (const [label, value] of [['recoveryProof', loaded.recoveryProof], ['latestObservation', loaded.latestObservation]]) {
      assert.equal(Object.hasOwn(value, '__proto__'), true, `${label} lost the key on disk`);
      assert.equal(Object.getPrototypeOf(value), Object.prototype, `${label} had its prototype replaced`);
      assert.equal(value.p, undefined, `${label} read an inherited field`);
      assert.equal(value.status, undefined);
    }
    assert.equal(JSON.stringify(loaded.latestObservation), '{"__proto__":{"p":1},"keep":"x"}');
    assert.equal(hydrateRecordFromSnapshot({ runtimeRecovered: false }, loaded).runtimeRecovered, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('C17 a candidate symbol key survives the merge with its value reference', () => {
  const marker = Symbol('observation-marker');
  const carrier = { nested: true };
  const high = {
    source: 'journal',
    capturedAt: '2026-10-01T00:00:00.000Z',
    latestObservation: { at: 'high', regressionPassed: true, shared: 1 },
  };
  // The candidate is the lower-priority source, so its symbol key is the one the
  // pre-fix `{ ...candidate }` copy carried.
  const low = {
    source: 'bridge',
    capturedAt: '2026-10-02T00:00:00.000Z',
    latestObservation: { at: '', shared: 2, extra: 'appended', [marker]: carrier },
  };
  const merged = mergeEvidenceSources([high, low]).latestObservation;
  assert.deepEqual(Object.getOwnPropertySymbols(merged), [marker], 'the symbol key must be an own key of the merge');
  assert.equal(merged[marker], carrier, 'the symbol value keeps its identity');
  assert.deepEqual(Object.getOwnPropertyDescriptor(merged, marker),
    { value: carrier, enumerable: true, configurable: true, writable: true });
  // Ordinary fields keep their priority and order: candidate-only keys first in
  // candidate order, an existing key replaced in place, an acc-only key appended.
  assert.equal(merged.at, 'high');
  assert.equal(merged.shared, 1);
  assert.equal(merged.extra, 'appended');
  assert.equal(merged.regressionPassed, true);
  assert.deepEqual(Object.keys(merged), ['at', 'shared', 'extra', 'regressionPassed']);
  for (const key of Object.keys(merged)) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(merged, key),
      { value: merged[key], enumerable: true, configurable: true, writable: true }, key);
  }
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  // A symbol is not serialized, so the JSON bytes must equal the same merge
  // without the symbol at all.
  const withoutSymbol = mergeEvidenceSources([high, {
    ...low,
    latestObservation: { at: '', shared: 2, extra: 'appended' },
  }]).latestObservation;
  assert.equal(JSON.stringify(merged), JSON.stringify(withoutSymbol));
  assert.equal(JSON.stringify(merged), '{"at":"high","shared":1,"extra":"appended","regressionPassed":true}');
  assert.equal(JSON.stringify(merged).includes('marker'), false);
});

test('C18 ordinary merge input matches the frozen pre-fix mergeLatest', () => {
  // The public entry runs `mergeLatest(acc, candidate)` per source pass; the
  // unchanged final gate drops an empty result to `null`.
  const viaPublic = (acc, candidate) => mergeEvidenceSources([
    { source: 'high', capturedAt: '2026-10-01T00:00:00.000Z', latestObservation: acc },
    { source: 'low', capturedAt: '2026-10-02T00:00:00.000Z', latestObservation: candidate },
  ]).latestObservation;
  const viaPreFix = (acc, candidate) => {
    const merged = PRE_FIX_MERGE_LATEST(acc, candidate);
    return merged && Object.keys(merged).length > 0 ? merged : null;
  };

  const marker = Symbol('corpus-marker');
  const otherMarker = Symbol('other-marker');
  const shared = { ref: true };
  const bare = (source) => Object.assign(Object.create(null), source);
  const sparse = new Array(3);
  sparse[1] = 'x';
  // No input here may own a `__proto__` key: that is the one payload the fix is
  // allowed to change, and it is asserted on its own by C14.
  const corpus = [
    ['both values missing', { a: undefined }, { a: null }],
    ['both values missing, sibling present', { a: undefined, b: 1 }, { b: 2 }],
    ['both values missing, unrelated sibling', { zz: undefined }, { b: 1 }],
    ['empty-ish field shapes', { a: 1, b: undefined, c: [], d: '' }, { a: 2, b: 3, c: { x: 1 }, d: 'low' }],
    ['falsy but present values', { a: 0, b: false }, { a: 1, b: true }],
    ['prototype-named keys', { toString: 'own-acc', constructor: 1 }, { hasOwnProperty: 2, toString: '' }],
    ['prototype value read for an own undefined key', { toString: undefined }, { b: 1 }],
    ['constructor-only acc key', { constructor: undefined }, { b: 1 }],
    ['hasOwnProperty-only acc key', { hasOwnProperty: undefined }, { b: 1 }],
    ['candidate-only keys', { a: 1 }, { b: 2, c: 3 }],
    ['acc-only keys', { a: 1, b: 2 }, { c: 3 }],
    ['empty acc object', {}, { a: 1 }],
    ['empty candidate object', { a: 1 }, {}],
    ['both empty objects', {}, {}],
    ['null-prototype acc and candidate', bare({ a: 1, b: undefined }), bare({ b: 2, c: 3 })],
    ['null-prototype candidate only', { a: 1 }, bare({ b: 2 })],
    ['array acc and candidate', ['a', 'b'], ['c']],
    ['sparse array acc', sparse, ['c']],
    ['empty array acc', [], ['c']],
    ['undefined candidate', { a: 1 }, undefined],
    ['null candidate', { a: 1 }, null],
    ['empty string candidate', { a: 1 }, ''],
    ['undefined acc', undefined, { a: 1 }],
    ['null acc', null, { a: 1 }],
    ['empty string acc', '', { a: 1 }],
    ['both undefined', undefined, undefined],
    ['candidate symbol key', { a: 1 }, { b: 2, [marker]: shared }],
    ['candidate symbol key only', {}, { [marker]: shared }],
    ['acc symbol key only', { [marker]: 1 }, { b: 2 }],
    ['same symbol on both sides', { [marker]: 1 }, { [marker]: 2, b: 3 }],
    ['two different symbols', { [otherMarker]: 'acc' }, { [marker]: shared, b: 3 }],
    ['nested object values keep their reference', { a: { deep: 1 } }, { b: shared, c: [1, 2] }],
    ['numeric string keys', { 2: 'two', 1: 'one' }, { 0: 'zero' }],
  ];

  for (const [label, acc, candidate] of corpus) {
    const expected = viaPreFix(acc, candidate);
    const actual = viaPublic(acc, candidate);
    assert.deepStrictEqual(actual, expected, `merged value changed for ${label}`);
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), `merged bytes changed for ${label}`);
    const actualKeys = actual === null ? [] : Object.keys(actual);
    const expectedKeys = expected === null ? [] : Object.keys(expected);
    assert.deepEqual(actualKeys, expectedKeys, `key set or order changed for ${label}`);
    const actualSymbols = actual === null ? [] : Object.getOwnPropertySymbols(actual);
    const expectedSymbols = expected === null ? [] : Object.getOwnPropertySymbols(expected);
    assert.deepEqual(actualSymbols, expectedSymbols, `symbol set changed for ${label}`);
    for (const symbol of expectedSymbols) {
      assert.equal(actual[symbol], expected[symbol], `symbol value reference changed for ${label}`);
    }
    if (actual === null) continue;
    for (const key of [...actualKeys, ...actualSymbols]) {
      assert.deepEqual(Object.getOwnPropertyDescriptor(actual, key),
        { value: actual[key], enumerable: true, configurable: true, writable: true },
        `descriptor changed for ${label} / ${String(key)}`);
    }
  }

  // The no-op the old conditional assignment had: a key that is missing on both
  // sides is not created at all (no own property read from the prototype chain).
  const bothMissing = viaPublic({ a: undefined }, { b: 1 });
  assert.deepEqual(Object.keys(bothMissing), ['b']);
  assert.equal(Object.hasOwn(bothMissing, 'a'), false);

  // A symbol carried by the accumulated (higher-priority) side was never merged
  // by the pre-fix copy either: the candidate's copy is the only source of
  // symbols. That is the pre-existing contract, pinned so it is not "fixed" by
  // accident.
  assert.deepEqual(Object.getOwnPropertySymbols(viaPublic({ [marker]: 1 }, { b: 2 })), []);
  assert.equal(viaPublic({ a: 1 }, { b: 2, [marker]: shared })[marker], shared);
});
