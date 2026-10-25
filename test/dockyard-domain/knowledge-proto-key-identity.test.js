/**
 * An own `__proto__` key is part of a fact's identity.
 *
 * `compactValue()` builds the value `stableStringify()` and `normalizeText()`
 * serialize, so it decides every `knowledgeKey` and every object digest. It used
 * to build its result with `output[key] = next` over `Object.keys(value).sort()`;
 * for an own key named `__proto__` - which `JSON.parse('{"__proto__":…}')`
 * really creates, so a caller's payload or a reloaded record can carry one - that
 * assignment reaches `Object.prototype`'s `__proto__` setter instead of defining
 * a property, and the key silently vanishes. Two facts that differ only in that
 * payload then serialize alike:
 *
 *   JSON.parse('{"__proto__":{"x":1},"b":2}') -> {"b":2}
 *   JSON.parse('{"b":2}')                     -> {"b":2}
 *
 * and therefore share one `knowledgeKey`, one dedupe decision, one accumulator
 * and one retention slot. The fix collects the pairs and defines them with
 * `Object.fromEntries()`; the sorted order, the volatile-key filter, the depth
 * and circular bounds and the `undefined` dropping all stay as they were.
 *
 * Two things are pinned here.
 *
 * Backwards compatibility: a payload with **no** own `__proto__` key must
 * serialize byte-identically to the pre-fix code, so every existing record keeps
 * its `knowledgeKey`. `PRE_FIX_COMPACT_VALUE` below is a frozen copy of the old
 * function, and the differentials compare the working tree's output against it
 * over a broad corpus instead of arguing the property.
 *
 * The deliberate identity change: a record whose payload *does* carry an own
 * `__proto__` key had the collapsed key. That identity necessarily changes, and
 * the previously merged record is deliberately **not** migrated, guessed or
 * rewritten - it keeps the bytes it has, and the next event with such a payload
 * gets its own new key. The last test pins that too.
 *
 * Where the collapsed identity used to be reachable, and what that means now:
 * the two paths that dropped the key before any identity was computed were the
 * `redact()` behind `safeRecord()` (`lib/dockyard-domain/memory.js` and
 * `lib/dockyard-domain/observation.js`) and the domain aggregate projection
 * (`stripOwnProtoKeys`, now `withoutOwnProtoKeys`, in `lib/domain-storage.js`). Both keep it now - `redact()`
 * defines its entries with `Object.fromEntries()`, and the projection validates a
 * key-free copy while returning the document as JSON - so the ordinary
 * `recordObservation()` ingest path and `recordKnowledgeEvent()` agree on one
 * payload's identity, and `test/dockyard-domain/special-key-ingest-integrity.test.js`
 * pins that agreement. What remains of the old behavior is data, not a defect: a
 * row an older build stored with the collapsed bytes keeps them (this module does
 * not migrate, guess or rewrite stored records), and a caller that names a body
 * explicitly is folded into that body. These are host/library entry points, not a
 * public export: the package export map does not expose `lib/dockyard-domain/*`,
 * so this is a defect in the internal identity layer rather than an exposed API
 * contract.
 *
 * Which test proves what: the tests that state the defect and the identities it
 * merged fail when the old serializer is put back. The three differentials
 * against `PRE_FIX_COMPACT_VALUE` pass on both sides by construction - they are
 * the backwards-compatibility proof, not the regression repro - so they are the
 * ones that would fail if this fix ever did change a payload that carries no own
 * `__proto__` key.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { EvolutionMemory } from "../../lib/dockyard-domain/memory.js";
import {
  isDuplicateKnowledgeEvent,
  knowledgeDigest,
  knowledgeKeyOf,
  mergeKnowledgeEntry,
  normalizeKnowledgeEvent,
  sourceRetentionLimit,
} from "../../lib/dockyard-domain/knowledge.js";
import { JsonStateStore } from "./support.js";

const NOW = "2026-10-12T00:00:00.000Z";
const OPTIONS = { sourceCollection: "observations", now: new Date(NOW) };

// ---------------------------------------------------------------------------
// The frozen pre-fix serializer
// ---------------------------------------------------------------------------

/**
 * The volatile-key filter the pre-fix `compactValue()` carried, copied with it.
 * Keeping the copy faithful is what makes the differential below meaningful; if
 * the working tree's filter drifts, the corpus entries that carry these names
 * fail there instead of comparing the tree with itself.
 */
const PRE_FIX_VOLATILE_KEYS = /^(?:id|uuid|eventid|timestamp|recordedat|observedat|startedat|endedat|createdat|updatedat|lastseen|firstseen|generation|generationid|runtimeversion|version|environment|metrics?|beforemetrics|aftermetrics|candidatemetrics|resourceMetrics|score|fitness|confidence|count|occurrencecount|successcount|failurecount|status|state|decision|sequence|duration|latency|cost|tokens?)$/i;

/**
 * `compactValue()` exactly as it stood before this fix: same bounds, same order,
 * same filter, and the same `output[key] = next` assignment that loses an own
 * `__proto__` key. Frozen rather than imported, so the comparisons below are
 * against the old implementation and not against the working tree.
 */
function PRE_FIX_COMPACT_VALUE(value, depth = 0, seen = new WeakSet()) {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "function" || depth > 4) return undefined;
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => PRE_FIX_COMPACT_VALUE(item, depth + 1, seen)).filter((item) => item !== undefined);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (PRE_FIX_VOLATILE_KEYS.test(key)) continue;
    const next = PRE_FIX_COMPACT_VALUE(value[key], depth + 1, seen);
    if (next !== undefined) output[key] = next;
  }
  return output;
}

function preFixSerialize(value) { return JSON.stringify(PRE_FIX_COMPACT_VALUE(value)) ?? "null"; }

/** A pre-fix object digest: `hash()` of an already-compacted value. */
function preFixDigest(value) { return createHash("sha256").update(preFixSerialize(value)).digest("hex").slice(0, 32); }

/**
 * The working tree's serializer, read through its public surface. An
 * object-valued `strategy` is `boundedIdentityText(stableStringify(value), 360)`,
 * so for a payload whose serialization is short it is exactly the text
 * `stableStringify()` produces - the same handle the identity-equivalence test
 * uses for the volatile filter.
 */
function workingSerialize(payload) {
  return normalizeKnowledgeEvent({ strategy: payload, capabilityId: "plugin:corpus" }, OPTIONS)?.dimensions?.strategy;
}

/**
 * The six-dimension projection `stableStringify()` produces for an identity
 * object: keys in sorted order, every value kept. Re-derived here instead of
 * imported, so the key below is an independent reconstruction.
 */
const DIMENSION_NAMES = ["failureMode", "issueType", "rootCause", "scope", "semanticFact", "strategy"];
function projectionHash(dimensions) {
  const entries = Object.keys(dimensions).sort().map((key) => [key, dimensions[key]]);
  return createHash("sha256").update(JSON.stringify(Object.fromEntries(entries))).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// The corpus: every shape the serializer decides
// ---------------------------------------------------------------------------

/** A payload that refers to itself, so `[Circular]` is part of its output. */
function circularPayload() {
  const payload = { b: 2, a: 1 };
  payload.self = payload;
  return payload;
}

/**
 * Payloads with no own `__proto__` key. Every one is short enough that
 * `dimension(…, { object: true })`'s 360-code-point bound never applies, which
 * the serialization test asserts instead of assuming.
 */
const CORPUS = [
  { b: 2 },
  { b: 2, a: 1, nested: { z: [1, 2, { deep: "value" }], y: null } },
  { holey: [1, , 3] },
  { undef: undefined, kept: 1 },
  { list: [undefined, 1, null, {}] },
  { when: new Date(NOW), kept: "date" },
  new Error("boom"),
  { numbers: [0, -0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, 2 ** 60] },
  { deep: { a: { b: { c: { d: { e: 1 }, kept: 2 } } } } },
  { id: "volatile", timestamp: 1, version: "9", metrics: { latency: 1 }, status: "ok", keep: "kept" },
  { nested: { id: "also-volatile", recordedAt: NOW, keep: 2 } },
  { astral: "\u{20000}".repeat(4), text: "中文问题", quotes: "’‘“”" },
  { big: 10n, kept: 1 },
  { fn: () => 1, kept: 1 },
  { "": "empty key", "  spaced  ": 1 },
  { protoText: "__proto__", protoLike: "{\"__proto__\":{}}" },
  { long: "w".repeat(120), kept: [1, 2, 3] },
  circularPayload(),
];

/** The three payloads of the defect, rebuilt per test so no test can mutate them. */
const payloadWithout = () => JSON.parse('{"b":2}');
const payloadWithObject = () => JSON.parse('{"__proto__":{"x":1},"b":2}');
const payloadWithNull = () => JSON.parse('{"__proto__":null,"b":2}');

// ---------------------------------------------------------------------------
// The fix, and the pre-fix behaviour it replaces
// ---------------------------------------------------------------------------

test("the pre-fix serializer collapses an own __proto__ payload", () => {
  const without = payloadWithout();
  const withObject = payloadWithObject();
  const withNull = payloadWithNull();
  // The fixtures are what they claim: `JSON.parse` really defines an own key.
  assert.ok(Object.hasOwn(withObject, "__proto__"), "JSON.parse must create an own __proto__ key");
  assert.ok(Object.hasOwn(withNull, "__proto__"), "JSON.parse must create an own __proto__ key");
  assert.deepEqual(Object.keys(withObject), ["__proto__", "b"]);
  // This is the defect, stated as an assertion: three different payloads, one
  // pre-fix serialization.
  assert.equal(preFixSerialize(withObject), '{"b":2}');
  assert.equal(preFixSerialize(withNull), '{"b":2}');
  assert.equal(preFixSerialize(without), '{"b":2}');
  // The fix keeps the key, in the same sorted position, as a data property.
  assert.equal(workingSerialize(withObject), '{"__proto__":{"x":1},"b":2}');
  assert.equal(workingSerialize(withNull), '{"__proto__":null,"b":2}');
  assert.equal(workingSerialize(without), '{"b":2}');
});

test("a payload without an own __proto__ key serializes byte-identically to the pre-fix baseline", () => {
  let compared = 0;
  for (const payload of CORPUS) {
    const baseline = preFixSerialize(payload);
    const working = workingSerialize(payload);
    assert.ok(baseline.length <= 360, `the corpus payload ${baseline} must stay inside the identity bound`);
    assert.equal(working, baseline, `the serialization of ${baseline} drifted from the pre-fix baseline`);
    compared += 1;
  }
  assert.ok(compared >= 18, `only ${compared} payloads were compared; the differential must not be vacuous`);
  // The corpus covers the branches it claims to: a dropped volatile key, a
  // dropped `undefined`, a dropped function, a hole, and a cycle.
  assert.equal(preFixSerialize(CORPUS[9]), '{"keep":"kept"}');
  assert.equal(preFixSerialize({ undef: undefined, kept: 1 }), '{"kept":1}');
  assert.equal(preFixSerialize({ fn: () => 1, kept: 1 }), '{"kept":1}');
  assert.equal(preFixSerialize({ holey: [1, , 3] }), '{"holey":[1,3]}');
  assert.equal(preFixSerialize(circularPayload()), '{"a":1,"b":2,"self":"[Circular]"}');
  assert.equal(preFixSerialize({ deep: { a: { b: { c: { d: { e: 1 }, kept: 2 } } } } }), '{"deep":{"a":{"b":{"c":{"kept":2}}}}}');
});

test("a record without an own __proto__ payload keeps the pre-fix knowledge key", () => {
  let compared = 0;
  for (const payload of CORPUS) {
    const record = { strategy: payload, capabilityId: "plugin:corpus" };
    const working = normalizeKnowledgeEvent(record, OPTIONS);
    assert.ok(working?.dimensions, `the corpus payload ${preFixSerialize(payload)} must be knowledge-bearing`);
    // The only part of the projection the serializer decides is substituted with
    // the pre-fix output; the other five dimensions are plain normalized text and
    // do not pass through `compactValue()`.
    const expected = "knowledge:" + projectionHash({ ...working.dimensions, strategy: preFixSerialize(payload) });
    assert.equal(working.knowledgeKey, expected, `the knowledge key of ${preFixSerialize(payload)} drifted from the pre-fix baseline`);
    assert.equal(knowledgeKeyOf(record), expected, `knowledgeKeyOf drifted for ${preFixSerialize(payload)}`);
    assert.deepEqual(Object.keys(working.dimensions).sort(), DIMENSION_NAMES);
    compared += 1;
  }
  assert.ok(compared >= 18, `only ${compared} keys were compared; the differential must not be vacuous`);
});

test("an object digest outside the identity dimensions keeps the pre-fix bytes", () => {
  let compared = 0;
  for (const payload of CORPUS) {
    const digest = normalizeKnowledgeEvent({ problem: "recovery probe", componentId: "plugin:recovery", recovery: payload }, OPTIONS)?.recovery?.digest;
    assert.equal(digest, preFixDigest(payload), `the recovery digest of ${preFixSerialize(payload)} drifted from the pre-fix baseline`);
    compared += 1;
  }
  assert.ok(compared >= 18, `only ${compared} digests were compared; the differential must not be vacuous`);
});

// ---------------------------------------------------------------------------
// The deliberate identity change
// ---------------------------------------------------------------------------

test("two payloads that differ only by an own __proto__ key get different knowledge keys", () => {
  const keyOf = (payload) => knowledgeKeyOf({ strategy: payload, capabilityId: "plugin:proto" });
  const without = keyOf(payloadWithout());
  const withObject = keyOf(payloadWithObject());
  const withNull = keyOf(payloadWithNull());
  for (const [name, key] of [["without", without], ["object", withObject], ["null", withNull]]) {
    assert.match(key, /^knowledge:[0-9a-f]{32}$/, `the ${name} payload must be knowledge-bearing`);
  }
  assert.notEqual(withObject, without, "an own __proto__ payload must not share the key of the payload without it");
  assert.notEqual(withNull, without, "an own __proto__ payload must not share the key of the payload without it");
  assert.notEqual(withObject, withNull, "the two payloads must not share one key");
  // The pre-fix code gave all three one key; that is the identity this fix
  // restores, and the reason the change below is deliberate rather than silent.
  assert.equal(
    "knowledge:" + projectionHash({ ...normalizeKnowledgeEvent({ strategy: payloadWithObject(), capabilityId: "plugin:proto" }, OPTIONS).dimensions, strategy: preFixSerialize(payloadWithObject()) }),
    "knowledge:" + projectionHash({ ...normalizeKnowledgeEvent({ strategy: payloadWithout(), capabilityId: "plugin:proto" }, OPTIONS).dimensions, strategy: preFixSerialize(payloadWithout()) }),
  );
});

test("the stored dimension and every digest keep the __proto__ payload apart", () => {
  const record = (payload, eventId) => ({ problem: "proto payload", componentId: "plugin:proto", strategy: payload, eventId });
  const without = normalizeKnowledgeEvent(record(payloadWithout(), "event-plain"), OPTIONS);
  const withObject = normalizeKnowledgeEvent(record(payloadWithObject(), "event-proto"), OPTIONS);
  const withNull = normalizeKnowledgeEvent(record(payloadWithNull(), "event-null"), OPTIONS);
  // The stored record distinguishes them: the dimension carries the payload.
  assert.equal(without.dimensions.strategy, '{"b":2}');
  assert.equal(withObject.dimensions.strategy, '{"__proto__":{"x":1},"b":2}');
  assert.equal(withNull.dimensions.strategy, '{"__proto__":null,"b":2}');
  // `knowledgeDigest` hashes the key, so the identity difference reaches it.
  const digests = [without, withObject, withNull].map((event) => knowledgeDigest(event));
  assert.equal(new Set(digests).size, 3, "the three payloads must have three knowledge digests");
  // `compactEvidence().digest` hashes the dimensions, so it must follow too.
  const evidence = [without, withObject, withNull].map((event) => mergeKnowledgeEntry(null, event, { now: new Date(NOW) }));
  const evidenceDigests = evidence.map((entry) => entry.recentEvidence.at(-1)?.digest);
  assert.ok(evidenceDigests.every((digest) => typeof digest === "string"));
  assert.equal(new Set(evidenceDigests).size, 3, "the three payloads must have three evidence digests");
  // `recoveryOf().digest` hashes the recovery payload itself.
  const recoveries = [payloadWithout(), payloadWithObject(), payloadWithNull()]
    .map((payload) => normalizeKnowledgeEvent({ problem: "proto payload", recovery: payload }, OPTIONS).recovery);
  assert.ok(recoveries.every((recovery) => typeof recovery?.digest === "string"));
  assert.equal(new Set(recoveries.map((recovery) => recovery.digest)).size, 3, "the three payloads must have three recovery digests");
  // The payload is the only difference, so nothing else may change.
  for (const field of ["issueType", "rootCause", "failureMode", "semanticFact", "scope", "status", "outcome"]) {
    assert.equal(withObject[field], without[field], `${field} must not depend on the payload`);
    assert.equal(withNull[field], without[field], `${field} must not depend on the payload`);
  }
});

test("a recovery proof cannot claim a restore through the prototype chain", () => {
  const recoveryOfInput = (raw) => normalizeKnowledgeEvent({ problem: "recovery proof", componentId: "plugin:proto", recovery: raw }, OPTIONS)?.recovery;
  // Deliberate consequence of the fix. Before it, the compacted form of a proof
  // that owns `__proto__` had the proof's value as its *prototype*, so
  // `compact.restored` (and `compact.registryRestored`) read `true` through
  // inheritance and the record reported a proven restore the payload never
  // stated in a field of its own. The digest of such a proof already changed
  // with the identity; this pins the flag that digest change also fixes.
  const inheritedRestored = recoveryOfInput(JSON.parse('{"__proto__":{"restored":true}}'));
  const inheritedRegistry = recoveryOfInput(JSON.parse('{"__proto__":{"registryRestored":true}}'));
  assert.equal(inheritedRestored.restored, false, "an inherited restored:true must not prove a restore");
  assert.equal(inheritedRegistry.restored, false, "an inherited registryRestored:true must not prove a restore");
  assert.equal(typeof inheritedRestored.digest, "string");
  assert.notEqual(inheritedRestored.digest, inheritedRegistry.digest, "the two proofs are still different records");
  // The flag is not merely always false now: an own field still decides it.
  assert.equal(recoveryOfInput({ restored: true }).restored, true);
  assert.equal(recoveryOfInput({ registryRestored: true }).restored, true);
  assert.equal(recoveryOfInput({ restored: false }).restored, false);
  // And keeping the key does not suppress an explicit own flag beside it.
  assert.equal(recoveryOfInput(JSON.parse('{"__proto__":{"restored":true},"restored":true}')).restored, true,
    "an explicit own restored:true beside an own __proto__ key must still prove the restore");
  // The digest still separates the inherited shape from the plain own field.
  assert.notEqual(inheritedRestored.digest, recoveryOfInput({ restored: true }).digest,
    "the inherited proof must not share the digest of an explicit own restored:true");
});

// ---------------------------------------------------------------------------
// The accumulator keeps them apart, and still folds a replay
// ---------------------------------------------------------------------------

test("the accumulator keeps the two payloads as two records and still folds a replay", () => {
  const event = (payload, eventId) => normalizeKnowledgeEvent({ problem: "proto payload", componentId: "plugin:proto", strategy: payload, eventId }, OPTIONS);
  const plain = event(payloadWithout(), "event-plain");
  const proto = event(payloadWithObject(), "event-proto");
  assert.notEqual(plain.knowledgeKey, proto.knowledgeKey);
  const plainRecord = mergeKnowledgeEntry(null, plain, { now: new Date(NOW) });
  const protoRecord = mergeKnowledgeEntry(null, proto, { now: new Date(NOW) });
  // Separate accumulators: neither absorbed the other's count or evidence.
  assert.equal(plainRecord.id, plain.knowledgeKey);
  assert.equal(protoRecord.id, proto.knowledgeKey);
  assert.equal(plainRecord.count, 1);
  assert.equal(protoRecord.count, 1);
  assert.equal(plainRecord.strategy, '{"b":2}');
  assert.equal(protoRecord.strategy, '{"__proto__":{"x":1},"b":2}');
  assert.equal(protoRecord.evidenceCount, 1);
  assert.equal(plainRecord.sourceCounts.observations, 1);
  // A replay of the same event is still recognised before it is merged.
  assert.equal(isDuplicateKnowledgeEvent(plainRecord, plain), true);
  assert.equal(isDuplicateKnowledgeEvent(protoRecord, proto), true);
  assert.equal(isDuplicateKnowledgeEvent(plainRecord, proto), false);
  const replayed = mergeKnowledgeEntry(plainRecord, plain, { now: new Date(NOW) });
  assert.equal(replayed.count, 2, "a replay must still accumulate onto the record it belongs to");
  assert.equal(replayed.strategy, plainRecord.strategy);
});

// ---------------------------------------------------------------------------
// Restart recovery, retention and finalization
// ---------------------------------------------------------------------------

function memory(stateStore) {
  const instance = new EvolutionMemory({ stateStore, clock: () => new Date(NOW), mutationAuthority: { assertMutation() {} } });
  return instance;
}

const LEGACY_ROW = JSON.parse('{"id":"legacy-proto","type":"tool/error","problem":"proto payload","componentId":"plugin:proto","severity":"error","strategy":{"__proto__":{"x":1},"b":2},"status":"success","success":true,"recordedAt":"2026-10-01T00:00:00.000Z"}');
const INCOMING_PLAIN = { id: "incoming-plain", type: "tool/error", problem: "proto payload", componentId: "plugin:proto", severity: "error", strategy: { b: 2 }, status: "success", success: true, recordedAt: NOW };

/** A store whose durable state already holds one source row with an own `__proto__` payload. */
async function seededStore(home) {
  const store = new JsonStateStore({ home });
  assert.ok(Object.hasOwn(LEGACY_ROW.strategy, "__proto__"));
  await mkdir(dirname(store.filePath), { recursive: true });
  await writeFile(store.filePath, JSON.stringify({ evolution: { schema: 4, observations: [LEGACY_ROW], knowledge: [] } }));
  return store;
}

test("a merged record round-trips through the store and a restart without loss", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-knowledge-proto-restart-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const event = (payload, eventId) => normalizeKnowledgeEvent({ problem: "proto payload", componentId: "plugin:proto", strategy: payload, eventId }, OPTIONS);
  const plainRecord = mergeKnowledgeEntry(null, event(payloadWithout(), "event-plain"), { now: new Date(NOW) });
  const protoRecord = mergeKnowledgeEntry(null, event(payloadWithObject(), "event-proto"), { now: new Date(NOW) });
  assert.notEqual(plainRecord.knowledgeKey, protoRecord.knowledgeKey, "the two records must be distinct before they are stored");

  const store = new JsonStateStore({ home });
  const first = memory(store);
  await first.load();
  await first.restore({ ...first.snapshot(), knowledge: [protoRecord, plainRecord] }, { persist: false });
  await first.compact();
  const text = await readFile(store.filePath, "utf8");
  assert.ok(text.includes("__proto__"), "the dimension that carries the payload must survive the durable write");

  // Restart: a new instance loads both rows, with both identities intact.
  const second = memory(store);
  await second.load();
  const rows = second.knowledgeSnapshot();
  assert.equal(rows.length, 2, "both records must survive the restart");
  const keys = rows.map((row) => row.knowledgeKey).sort();
  assert.deepEqual(keys, [protoRecord.knowledgeKey, plainRecord.knowledgeKey].sort());
  for (const row of rows) {
    // The stored `knowledgeKey` is authoritative: it is what a later append names
    // the row by, and the stored dimension is the exact text the payload was
    // recorded as. (`knowledgeKeyOf` recomputes from a record's *input* fields; a
    // stored row's dimension is already the serialized text, so that recomputation
    // is not a round trip of the stored key for any record.)
    const expected = row.knowledgeKey === protoRecord.knowledgeKey ? protoRecord : plainRecord;
    assert.equal(row.strategy, expected.strategy);
    assert.equal(row.count, 1);
  }
  // A second restart is idempotent, and nothing rewrote the stored rows.
  const third = memory(store);
  await third.load();
  assert.deepEqual(third.knowledgeSnapshot().map((row) => row.knowledgeKey).sort(), keys);
});

test("a persisted __proto__ source row is its own subject, not the collapsed one", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-knowledge-proto-source-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = await seededStore(home);
  const instance = memory(store);
  await instance.load();
  // The legacy row's own identity is the one that includes its payload.
  assert.notEqual(knowledgeKeyOf(LEGACY_ROW), knowledgeKeyOf({ ...LEGACY_ROW, strategy: { b: 2 } }),
    "the persisted row's payload must be part of its identity");
  const returned = await instance.recordObservation(INCOMING_PLAIN);
  assert.equal(returned.id, INCOMING_PLAIN.id, "the plain row must not be folded into the __proto__ row");
  // Two source rows: the limit of one representative per subject applies per
  // subject, so the two subjects each keep one. A collapsed key would leave one.
  assert.deepEqual(instance.history("observations").map((entry) => entry.id).sort(), ["incoming-plain", "legacy-proto"]);
  // Only the appended event creates a canonical row here, and it is the plain
  // subject's - not the `__proto__` row's.
  assert.deepEqual(instance.knowledgeSnapshot().map((entry) => entry.knowledgeKey), [knowledgeKeyOf(INCOMING_PLAIN)]);

  // The same payload through the same ingest path, now that `redact()` keeps an
  // own `__proto__` key: this observation *is* the legacy row's subject, so it
  // folds into the body the row bytes spell instead of forming a second subject
  // beside it. (`withoutOwnProtoKeys` no longer removes the key from the domain
  // projection either, so a reload of that row keeps the same identity.)
  const incomingProto = JSON.parse(JSON.stringify(LEGACY_ROW));
  incomingProto.id = "incoming-proto";
  incomingProto.recordedAt = NOW;
  assert.ok(Object.hasOwn(incomingProto.strategy, "__proto__"), "the incoming payload must own the key");
  const folded = await instance.recordObservation(incomingProto);
  // The returned value here is the retained representative itself, which carries
  // no stored `knowledgeKey` (it was seeded as a source row), so the subject is
  // read off it rather than from a field.
  assert.equal(knowledgeKeyOf(folded), knowledgeKeyOf(LEGACY_ROW), "the same payload must be the same subject");
  assert.equal(folded.id, LEGACY_ROW.id, "the existing representative is kept, not a second one");
  assert.deepEqual(instance.knowledgeSnapshot().map((entry) => entry.knowledgeKey).sort(),
    [knowledgeKeyOf(INCOMING_PLAIN), knowledgeKeyOf(LEGACY_ROW)].sort());
  assert.deepEqual(instance.history("observations").map((entry) => entry.id).sort(), ["incoming-plain", "legacy-proto"]);
});

test("retention and finalization keep one representative for each payload", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-knowledge-proto-retention-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = await seededStore(home);
  const instance = memory(store);
  await instance.load();
  // Both subjects are `observations`, whose `sourceRetentionLimit` is one per
  // subject: two subjects keep two rows, one collapsed subject keeps one.
  const plainEvent = normalizeKnowledgeEvent(INCOMING_PLAIN, OPTIONS);
  const protoEvent = normalizeKnowledgeEvent(LEGACY_ROW, OPTIONS);
  assert.equal(sourceRetentionLimit(plainEvent, { collection: "observations" }), 1);
  assert.equal(sourceRetentionLimit(protoEvent, { collection: "observations" }), 1);
  assert.notEqual(plainEvent.knowledgeKey, protoEvent.knowledgeKey, "the two subjects must not share a retention group");

  await instance.recordObservation(INCOMING_PLAIN);
  // `finalizeKnowledge()` runs the retention plan over every collection, which
  // regroups the sources by identity and rebuilds the canonical rows.
  const result = await instance.finalizeKnowledge({
    winner: { id: "winner-proto", capabilityId: "plugin:proto", problemFingerprint: "proto-payload" },
    before: { latency: 10 }, after: { latency: 5 }, outcome: "SUCCESS",
  });
  assert.equal(result.committed, true);
  assert.equal(result.duplicate, false);
  assert.deepEqual(instance.history("observations").map((entry) => entry.id).sort(), ["incoming-plain", "legacy-proto"]);
  const byKey = new Map(instance.knowledgeSnapshot().map((entry) => [entry.knowledgeKey, entry]));
  const plainRow = byKey.get(plainEvent.knowledgeKey);
  const protoRow = byKey.get(protoEvent.knowledgeKey);
  assert.ok(plainRow, "the plain subject must keep its canonical row");
  assert.ok(protoRow, "the __proto__ subject must keep its own canonical row");
  assert.equal(protoRow.strategy, '{"__proto__":{"x":1},"b":2}');
  assert.equal(protoRow.count, 1);
  assert.equal(plainRow.count, 1);
  // The store is still loadable, and the regrouped rows survive the restart.
  const restarted = memory(store);
  await restarted.load();
  const reloaded = new Set(restarted.knowledgeSnapshot().map((entry) => entry.knowledgeKey));
  assert.ok(reloaded.has(plainEvent.knowledgeKey));
  assert.ok(reloaded.has(protoEvent.knowledgeKey));
});

test("a previously collapsed record keeps its bytes and is not migrated or guessed", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-knowledge-proto-legacy-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  // The record a pre-fix merge produced for the `__proto__` payload: its key and
  // its dimension are the collapsed ones, and that is the bytes it is stored with.
  const collapsedKey = "knowledge:" + projectionHash({
    ...normalizeKnowledgeEvent({ strategy: payloadWithout(), capabilityId: "plugin:proto" }, OPTIONS).dimensions,
    strategy: preFixSerialize(payloadWithObject()),
  });
  const legacyRecord = {
    id: collapsedKey, knowledgeKey: collapsedKey, schema: 1, canonical: true, retention: "CANONICAL_KNOWLEDGE", state: "KNOWN",
    issueType: "problem", problemType: "problem", rootCause: null, strategy: preFixSerialize(payloadWithObject()),
    failureMode: null, semanticFact: null, scope: null, count: 1, occurrenceCount: 1,
    firstSeen: "2026-10-01T00:00:00.000Z", lastSeen: "2026-10-01T00:00:00.000Z", lastSourceCollection: "observations",
    lastOutcome: "neutral", updatedAt: "2026-10-01T00:00:00.000Z",
  };
  const store = new JsonStateStore({ home });
  await mkdir(dirname(store.filePath), { recursive: true });
  await writeFile(store.filePath, JSON.stringify({ evolution: { schema: 4, knowledge: [legacyRecord] } }));
  const instance = memory(store);
  await instance.load();
  const before = JSON.stringify(instance.knowledgeSnapshot());
  await instance.compact();
  const reloaded = memory(store);
  await reloaded.load();
  const rows = reloaded.knowledgeSnapshot();
  assert.equal(rows.length, 1, "the legacy record must not be duplicated or dropped");
  assert.equal(rows[0].knowledgeKey, collapsedKey, "the legacy record must keep the key it was merged under");
  assert.equal(rows[0].strategy, preFixSerialize(payloadWithObject()), "the legacy record must keep its collapsed dimension bytes");
  assert.equal(JSON.stringify(rows), before, "the legacy record must not be rewritten by a load, a compaction or a restart");
  // Nothing guessed a new identity for it: the next event with a `__proto__`
  // payload is a *different* subject under a new key, so it cannot be folded
  // into the legacy record.
  assert.notEqual(knowledgeKeyOf({ strategy: payloadWithObject(), capabilityId: "plugin:proto" }), collapsedKey);
});

test("a payload whose __proto__ value is null stays distinguishable", () => {
  // The fail-closed variant: `null` is not `undefined`, so the pre-fix code
  // assigned it (and lost it), and a fix that only kept object values would
  // still collapse the three payloads.
  const keyOf = (payload) => knowledgeKeyOf({ strategy: payload, capabilityId: "plugin:proto" });
  const without = payloadWithout();
  const withNull = payloadWithNull();
  const withObject = payloadWithObject();
  assert.equal(workingSerialize(withNull), '{"__proto__":null,"b":2}');
  assert.notEqual(keyOf(withNull), keyOf(without));
  assert.notEqual(keyOf(withNull), keyOf(withObject));
  assert.equal(keyOf(withNull), keyOf(payloadWithNull()), "the identity must be deterministic");
  assert.notEqual(
    normalizeKnowledgeEvent({ strategy: withNull, capabilityId: "plugin:proto", eventId: "e-null" }, OPTIONS).knowledgeKey,
    normalizeKnowledgeEvent({ strategy: without, capabilityId: "plugin:proto", eventId: "e-null" }, OPTIONS).knowledgeKey,
  );
  // A second creation path, since an object literal's `__proto__:` sets the
  // prototype instead of defining a key: a property defined that way is kept too.
  const defined = Object.defineProperty({ b: 2 }, "__proto__", { value: null, enumerable: true, writable: true, configurable: true });
  assert.ok(Object.hasOwn(defined, "__proto__"));
  assert.equal(preFixSerialize(defined), '{"b":2}');
  assert.equal(workingSerialize(defined), '{"__proto__":null,"b":2}');
});
