/**
 * A data-derived key named `__proto__`, `constructor` or `toString` must survive
 * ingestion, aggregation and persistence as an ordinary own data property.
 *
 * `JSON.parse('{"__proto__":…}')` really creates an own enumerable `__proto__`
 * key, so any payload a caller passes (or any row reloaded from JSON) can carry
 * one. Four places used to write such a key with `target[key] = value` on an
 * ordinary object, which reaches `Object.prototype`'s `__proto__` setter instead
 * of defining a property:
 *
 * - `redact()` in `observation.js` / `memory.js` silently dropped the key (and,
 *   for an object value, temporarily made the payload the output's prototype, so
 *   a later field read inherited from the payload - that is how a recovery proof
 *   reported a `status`/`rollbackPoint` the payload never owned);
 * - `metrics[inferredMetric]` lost a measurement recorded under that name;
 * - `sourceCounts[sourceCollection]` lost that source's whole count;
 * - `mergeMetricStats()` dropped the metric and read `Object.prototype` as if it
 *   were the previous accumulator.
 *
 * The fix defines those keys with `Object.fromEntries()` / `Object.defineProperty()`
 * in place. What this file pins:
 *
 * - the payload survives ingestion byte for byte, with a clean prototype and no
 *   pollution of `Object.prototype`;
 * - ingestion and the knowledge library agree on the identity of one payload;
 * - a recovery proof cannot claim a restore through the prototype chain, while
 *   an own flag still decides it;
 * - a metric name and a source name of that shape accumulate;
 * - and, differentially, `mergeMetricStats()` keeps producing byte-identical
 *   JSON for ordinary metric names (the frozen pre-fix copy below).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { EvolutionObservationStore } from "../../lib/dockyard-domain/observation.js";
import { EvolutionMemory } from "../../lib/dockyard-domain/memory.js";
import { knowledgeKeyOf, mergeKnowledgeEntry, normalizeKnowledgeEvent } from "../../lib/dockyard-domain/knowledge.js";
import { JsonStateStore } from "./support.js";

const NOW = "2026-10-12T00:00:00.000Z";
const clock = () => new Date(NOW);
const OPTIONS = { sourceCollection: "observations", now: new Date(NOW) };

/** A live memory instance and the observation store that records through it. */
async function harness(t) {
  const home = await mkdtemp(join(tmpdir(), "dsh-special-key-ingest-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const instance = new EvolutionMemory({ stateStore: new JsonStateStore({ home }), clock, mutationAuthority: { assertMutation() {} } });
  await instance.load();
  return { instance, store: new EvolutionObservationStore({ memory: instance, clock }) };
}

/** The three payloads of the defect, rebuilt per test so no test can mutate them. */
const payloadWithObject = () => JSON.parse('{"__proto__":{"x":1},"b":2}');
const payloadWithNull = () => JSON.parse('{"__proto__":null,"b":2}');
const payloadInArray = () => JSON.parse('[{"__proto__":{"k":1},"n":2}]');

/** `true` when `value` owns the key as an enumerable data property. */
function ownsEnumerable(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return Boolean(descriptor && descriptor.enumerable && "value" in descriptor);
}

// ---------------------------------------------------------------------------
// 1. Ingestion keeps the payload
// ---------------------------------------------------------------------------

test("an own __proto__ payload survives ingestion as an own enumerable data property", async (t) => {
  const { store } = await harness(t);
  const evidence = payloadWithObject();
  assert.ok(Object.hasOwn(evidence, "__proto__"), "the fixture must really own the key");
  assert.equal(JSON.stringify(evidence), '{"__proto__":{"x":1},"b":2}');
  const severity = await store.record({ type: "tool/error", problem: "ingest", componentId: "plugin:proto", evidence });
  assert.deepEqual(Object.keys(severity.evidence), ["__proto__", "b"]);
  assert.equal(ownsEnumerable(severity.evidence, "__proto__"), true, "the key must be an own enumerable data property");
  assert.deepEqual(severity.evidence.__proto__, { x: 1 });
  assert.equal(Object.getPrototypeOf(severity.evidence), Object.prototype, "the payload must not become the prototype");
  assert.equal(JSON.stringify(severity.evidence), JSON.stringify(evidence), "the payload must round-trip byte for byte");

  // An object element inside an array, through a different field.
  const semanticFact = payloadInArray();
  const arrayRow = await store.record({ type: "tool/error", problem: "array", componentId: "plugin:proto", semanticFact });
  assert.deepEqual(Object.keys(arrayRow.semanticFact[0]), ["__proto__", "n"]);
  assert.equal(ownsEnumerable(arrayRow.semanticFact[0], "__proto__"), true);
  assert.equal(Object.getPrototypeOf(arrayRow.semanticFact[0]), Object.prototype);
  assert.equal(JSON.stringify(arrayRow.semanticFact), JSON.stringify(semanticFact));

  // A `null` value: the key must not be confused with "no prototype change".
  const strategy = payloadWithNull();
  const nullRow = await store.record({ type: "tool/error", problem: "null", componentId: "plugin:proto", strategy });
  assert.deepEqual(Object.keys(nullRow.strategy), ["__proto__", "b"]);
  assert.equal(ownsEnumerable(nullRow.strategy, "__proto__"), true);
  assert.equal(nullRow.strategy.__proto__, null);
  assert.equal(Object.getPrototypeOf(nullRow.strategy), Object.prototype);
  assert.equal(JSON.stringify(nullRow.strategy), JSON.stringify(strategy));

  // Redaction still reaches inside the payload: the name is structural, not a
  // credential, so the value is walked like any other nested object. The store's
  // own boundary marks a sensitive value (`<redacted>`), and the memory's
  // `safeRecord()` then drops the key entirely - both are the existing policies,
  // and neither may be skipped because the parent name is `__proto__`.
  const secretEvidence = () => JSON.parse('{"__proto__":{"apiKey":"sk-secret-P1","nested":{"refreshToken":"sk-refresh-P2"}},"note":"kept"}');
  const markingMemory = {
    async load() {}, history() { return []; }, async recordObservation(row) { return row; }, async recordKnowledgeEvent() {},
    get hasColdHistory() { return false; },
  };
  const markingStore = new EvolutionObservationStore({ memory: markingMemory, clock });
  const marked = await markingStore.record({ type: "tool/error", problem: "secret", componentId: "plugin:proto", evidence: secretEvidence() });
  assert.equal(ownsEnumerable(marked.evidence, "__proto__"), true, "the structural key must not become a way past redaction");
  assert.equal(marked.evidence.__proto__.apiKey, "<redacted>");
  assert.equal(marked.evidence.__proto__.nested.refreshToken, "<redacted>");
  assert.equal(marked.evidence.note, "kept");
  assert.equal(JSON.stringify(marked).includes("sk-secret-P1"), false, "no plaintext apiKey survives the store boundary");
  assert.equal(JSON.stringify(marked).includes("sk-refresh-P2"), false, "no plaintext refreshToken survives the store boundary");
  const secretRow = await store.record({ type: "tool/error", problem: "secret", componentId: "plugin:proto", evidence: secretEvidence() });
  assert.equal(ownsEnumerable(secretRow.evidence, "__proto__"), true, "the durable row must keep the structural key");
  assert.equal(Object.hasOwn(secretRow.evidence.__proto__, "apiKey"), false, "the memory boundary drops the credential key");
  assert.equal(Object.hasOwn(secretRow.evidence.__proto__.nested, "refreshToken"), false);
  assert.equal(secretRow.evidence.note, "kept");
  assert.equal(JSON.stringify(secretRow).includes("sk-secret-P1"), false, "no plaintext apiKey survives the durable row");
  assert.equal(JSON.stringify(secretRow).includes("sk-refresh-P2"), false, "no plaintext refreshToken survives the durable row");

  // Nothing reached the shared prototype on the way.
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(({}).polluted, undefined);
});

// ---------------------------------------------------------------------------
// 2. One payload, one identity
// ---------------------------------------------------------------------------

test("the ingest path and the knowledge library agree on one payload's identity", async (t) => {
  const { instance } = await harness(t);
  // `patternKey` is passed explicitly so the row the ingest path stores carries
  // the same identity fields the library entry sees: without it `observationInput`
  // seeds a derived `patternKey` and the two inputs would differ in `failureMode`
  // for a reason that has nothing to do with this defect.
  const raw = () => ({ type: "tool/error", problem: "proto payload", componentId: "plugin:proto", patternKey: "proto:payload", strategy: payloadWithObject() });
  const row = await instance.recordObservation(raw());
  assert.equal(ownsEnumerable(row.strategy, "__proto__"), true, "the stored source row must keep its payload");

  const fromLibrary = normalizeKnowledgeEvent(raw(), OPTIONS);
  assert.ok(fromLibrary, "the payload must be knowledge-bearing");
  assert.equal(knowledgeKeyOf(row), fromLibrary.knowledgeKey, "ingestion and the library must agree on the identity");
  assert.equal(knowledgeKeyOf(raw()), fromLibrary.knowledgeKey);

  // And that identity is not the collapsed payload's: it is the defect's whole
  // point that the two used to be one.
  const collapsed = knowledgeKeyOf({ ...raw(), strategy: { b: 2 } });
  assert.notEqual(fromLibrary.knowledgeKey, collapsed, "the payload must be part of the identity");

  // The library entry, on its own instance so its accumulator is not mixed with
  // the ingest path's one, names the same subject.
  const { instance: library } = await harness(t);
  const recorded = await library.recordKnowledgeEvent(raw());
  assert.equal(recorded.id, fromLibrary.knowledgeKey, "recordKnowledgeEvent must name the same subject");

  // A replay of the same event still folds into the one accumulator.
  const replay = await instance.recordObservation({ ...raw(), eventId: "event-proto" });
  assert.equal(knowledgeKeyOf(replay), fromLibrary.knowledgeKey);
  await instance.recordObservation({ ...raw(), eventId: "event-proto" });
  const rows = instance.knowledgeSnapshot();
  assert.equal(rows.length, 1, "a replay must not create a second canonical row");
  assert.equal(rows[0].count, 2, "the replay must count exactly one more occurrence");
});

// ---------------------------------------------------------------------------
// 3. A recovery proof cannot inherit its fields
// ---------------------------------------------------------------------------

test("a recovery proof built from an own __proto__ payload does not inherit its fields", async (t) => {
  const { instance } = await harness(t);
  const proof = () => JSON.parse('{"__proto__":{"status":"restored","rollbackPoint":"RP-1"},"reason":"r"}');
  const row = await instance.recordObservation({ problem: "recovery proof", componentId: "plugin:proto", recovery: proof() });
  const canonical = instance.knowledgeSnapshot().find((entry) => entry.knowledgeKey === knowledgeKeyOf(row));
  assert.ok(canonical, "the write must produce a canonical row");
  // Before the fix `redact()` made the payload the output's prototype, so
  // `first()` read `status` and `rollbackPoint` through inheritance and the
  // record reported a restore the payload never owned a field for. These three
  // assertions therefore run before the row's own-key check: on the pre-fix tree
  // the row loses the key, and this is the consequence that check would
  // otherwise hide.
  assert.equal(canonical.recovery.status, null, "an inherited status must not be read");
  assert.equal(canonical.recovery.point, null, "an inherited rollbackPoint must not be read");
  assert.equal(canonical.recovery.restored, false, "an inherited proof must not claim a restore");
  assert.equal(canonical.recovery.reason, "r", "an own field beside the payload is still read");
  assert.ok(Object.hasOwn(row.recovery, "__proto__"), "the source row must keep the payload as data");

  // The flag is not merely always false: an own field still decides it.
  const restored = await instance.recordObservation({ problem: "recovery proof two", componentId: "plugin:proto", recovery: { restored: true } });
  const restoredRow = instance.knowledgeSnapshot().find((entry) => entry.knowledgeKey === knowledgeKeyOf(restored));
  assert.equal(restoredRow.recovery.restored, true, "an own restored:true must still prove the restore");
});

// ---------------------------------------------------------------------------
// 4. A metric name of that shape
// ---------------------------------------------------------------------------

test("a measurement recorded under __proto__, constructor or toString keeps its place", async (t) => {
  const { store } = await harness(t);
  for (const [name, value] of [["__proto__", 7], ["constructor", 3], ["toString", 5]]) {
    // A distinct component per name keeps the three rows in different knowledge
    // subjects, so each one is retained instead of being folded into the first.
    const row = await store.record({ type: "performance/observe", componentId: `plugin:metric-${name}`, metric: name, value, metrics: {} });
    assert.equal(row.metric, name, `the row must name the metric ${name}`);
    assert.equal(ownsEnumerable(row.metrics, name), true, `metrics must own ${name} as an enumerable data property`);
    assert.equal(Object.getOwnPropertyDescriptor(row.metrics, name).value, value, `${name} must keep its value`);
    assert.equal(Object.getPrototypeOf(row.metrics), Object.prototype, `${name} must not become the prototype`);
    assert.deepEqual(Object.keys(row.metrics), [name]);
    // `metricValues()` normalizes a metric name through the existing `identity()`
    // rule before it reaches the canonical row, so the three names arrive there
    // as `proto` (`normalizeText()` trims the surrounding underscores),
    // `constructor` and `tostring` - the same names every other spelling of them
    // already gets. That mapping is the existing rule and is not changed here.
    const metrics = normalizeKnowledgeEvent(row, OPTIONS)?.metrics;
    const expected = new Map([["__proto__", "proto"], ["constructor", "constructor"], ["toString", "tostring"]]).get(name);
    assert.equal(ownsEnumerable(metrics, expected), true, `the canonical metric name ${expected} must be kept`);
    assert.equal(metrics[expected], value);
  }
  assert.equal(Object.prototype.polluted, undefined);
});

// ---------------------------------------------------------------------------
// 5. A source collection name of that shape
// ---------------------------------------------------------------------------

test("a source collection named __proto__ accumulates instead of vanishing", async (t) => {
  const { instance } = await harness(t);
  const event = () => ({ problem: "source counts", componentId: "plugin:source", strategy: "s" });
  const first = await instance.recordKnowledgeEvent(event(), { sourceCollection: "__proto__" });
  const second = await instance.recordKnowledgeEvent(event(), { sourceCollection: "__proto__" });
  assert.equal(second.count, 2);
  assert.equal(second.lastSourceCollection, "__proto__");
  assert.equal(ownsEnumerable(second.sourceCounts, "__proto__"), true, "the source count must be an own data property");
  assert.equal(second.sourceCounts.__proto__, 2, "the two events must both be counted");
  assert.equal(Object.getPrototypeOf(second.sourceCounts), Object.prototype);

  // The other prototype names work as ordinary own keys too, beside it.
  const viaConstructor = await instance.recordKnowledgeEvent(event(), { sourceCollection: "constructor" });
  const viaToString = await instance.recordKnowledgeEvent(event(), { sourceCollection: "toString" });
  assert.equal(viaToString.sourceCounts.constructor, 1);
  assert.equal(viaToString.sourceCounts.toString, 1);
  assert.equal(viaToString.sourceCounts.__proto__, 2);
  assert.equal(viaToString.count, 4);
  assert.deepEqual(Object.keys(viaToString.sourceCounts), ["__proto__", "constructor", "toString"]);
  assert.equal(Object.getPrototypeOf(viaToString.sourceCounts), Object.prototype);
  assert.equal(viaToString.lastSourceCollection, "toString");

  // The count survives the durable form the store actually writes.
  const roundTripped = JSON.parse(JSON.stringify(viaToString));
  assert.equal(Object.hasOwn(roundTripped.sourceCounts, "__proto__"), true);
  assert.equal(roundTripped.sourceCounts.__proto__, 2);
  assert.equal(Object.getPrototypeOf(roundTripped.sourceCounts), Object.prototype);
  assert.equal(Object.prototype.polluted, undefined);
  // And so does the reloaded row the store hands back.
  const reloaded = instance.knowledgeSnapshot().find((entry) => entry.knowledgeKey === viaToString.knowledgeKey);
  assert.equal(Object.hasOwn(reloaded.sourceCounts, "__proto__"), true);
  assert.equal(reloaded.sourceCounts.__proto__, 2);
  assert.equal(first.count, 1);
});

// ---------------------------------------------------------------------------
// 6. Metric accumulation, and the ordinary metric names it must not change
// ---------------------------------------------------------------------------

const MAX_ACCUMULATOR = Number.MAX_SAFE_INTEGER;
const MAX_METRICS = 32;

/** `clampAccumulator()` as the pre-fix code had it. */
function clampAccumulator(value) {
  if (value === Infinity) return MAX_ACCUMULATOR;
  if (value === -Infinity) return -MAX_ACCUMULATOR;
  if (!Number.isFinite(value)) return 0;
  return Math.max(-MAX_ACCUMULATOR, Math.min(MAX_ACCUMULATOR, value));
}
function accumulatorSum(base, delta) { return clampAccumulator(clampAccumulator(base) + clampAccumulator(delta)); }
function accumulateCount(base, delta) { return Math.max(0, accumulatorSum(base, delta)); }
function numeric(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function metricAccumulator(stat, fallback = 0) {
  const source = stat && typeof stat === "object" ? stat : null;
  const last = clampAccumulator(source?.last ?? fallback);
  const count = accumulateCount(0, source?.count);
  const sum = accumulatorSum(0, source?.sum);
  return { count, sum, min: Math.min(clampAccumulator(source?.min ?? last), last), max: Math.max(clampAccumulator(source?.max ?? last), last), last, mean: sum / Math.max(1, count) };
}

/**
 * `mergeMetricStats()` exactly as it stood before this fix: same helpers, same
 * order, and the same `output[key] = …` assignment that loses an own `__proto__`
 * key. Frozen rather than imported so the differential below compares against
 * the old implementation and not against the working tree.
 */
function PRE_FIX_MERGE_METRIC_STATS(current, values, delta) {
  const output = { ...(current && typeof current === "object" ? current : {}) };
  for (const [key, value] of Object.entries(values ?? {})) {
    const n = numeric(value);
    if (n === null) continue;
    const previous = output[key] && typeof output[key] === "object" ? metricAccumulator(output[key], n) : { count: 0, sum: 0, min: n, max: n, last: n };
    output[key] = metricAccumulator({ count: accumulateCount(previous.count, delta), sum: accumulatorSum(previous.sum, n * delta), min: Math.min(previous.min, n), max: Math.max(previous.max, n), last: n }, n);
  }
  for (const [key, stat] of Object.entries(output)) if (stat && typeof stat === "object") output[key] = metricAccumulator(stat);
  return Object.fromEntries(Object.keys(output).slice(0, MAX_METRICS).map((key) => [key, output[key]]));
}

/** The working tree's merge, reached through `mergeKnowledgeEntry()`. */
function workingMetrics(previousMetrics, values, delta) {
  const base = normalizeKnowledgeEvent({ problem: "merge metrics", componentId: "plugin:merge" }, OPTIONS);
  assert.ok(base, "the base event must be knowledge-bearing");
  const first = mergeKnowledgeEntry(null, base, { now: new Date(NOW) });
  // A stored row's metrics, put back on a fresh accumulator to model a reload.
  const previous = previousMetrics === null ? null : { ...first, effectStats: { ...first.effectStats, metrics: previousMetrics } };
  const merged = mergeKnowledgeEntry(previous, { ...base, metrics: values, delta }, { now: new Date(NOW) });
  return merged.effectStats.metrics;
}

test("metric accumulation keeps a data-derived metric name and repairs a stored one", () => {
  // A metric map carrying its own `__proto__` and `constructor` keys, exactly as
  // a caller's payload or a reloaded row can.
  const values = JSON.parse('{"__proto__":5,"constructor":2,"latency":3}');
  assert.deepEqual(Object.keys(values), ["__proto__", "constructor", "latency"]);
  const merged = workingMetrics(null, values, 1);
  for (const [key, expected] of [["__proto__", 5], ["constructor", 2], ["latency", 3]]) {
    assert.equal(ownsEnumerable(merged, key), true, `effectStats.metrics must own ${key}`);
    assert.equal(merged[key].last, expected, `${key} must keep its value`);
    assert.equal(merged[key].count, 1);
    assert.equal(merged[key].sum, expected);
  }
  assert.equal(Object.getPrototypeOf(merged), Object.prototype, "the merged map must not take a payload as prototype");
  assert.equal(Object.prototype.polluted, undefined);

  // Accumulating onto it must not drop it either - nor may the repair pass that
  // rewrites every stored stat.
  const again = workingMetrics(structuredClone(merged), values, 2);
  assert.equal(Object.hasOwn(again, "__proto__"), true);
  assert.equal(again.__proto__.count, 3);
  assert.equal(again.__proto__.sum, 15);
  assert.equal(again.__proto__.last, 5);
  assert.equal(again.constructor.count, 3);

  // A stored accumulator that already owns the key is kept, not read from
  // `Object.prototype` as if it were the previous value.
  const stored = JSON.parse('{"__proto__":{"count":4,"sum":20,"min":5,"max":5,"last":5,"mean":5},"latency":{"count":1,"sum":3,"min":3,"max":3,"last":3,"mean":3}}');
  const repaired = workingMetrics(stored, { latency: 7 }, 1);
  assert.equal(ownsEnumerable(repaired, "__proto__"), true, "a stored own __proto__ accumulator must survive");
  assert.equal(repaired.__proto__.count, 4, "a metric this event does not measure keeps its count");
  assert.equal(repaired.__proto__.sum, 20);
  assert.equal(repaired.latency.count, 2);
  assert.equal(repaired.latency.last, 7);
  assert.equal(Object.getPrototypeOf(repaired), Object.prototype);
});

test("ordinary metric names merge byte-identically to the pre-fix implementation", () => {
  const round = (metrics, values, delta) => [metrics, values, delta];
  const rounds = [
    round(null, { latency: 3, p95: 12 }, 1),
    round({ latency: { count: 1, sum: 3, min: 3, max: 3, last: 3, mean: 3 } }, { latency: 7, p95: 12 }, 1),
    round(null, { latency: 3.5, p95: 12, "0": 4, "42": 6, "-1": 2 }, 3),
    round(null, { constructor: 2, toString: 8, valueOf: 9, hasOwnProperty: 1 }, 1),
    round(null, { latency: null, p95: "abc", rss: undefined, cpu: Number.NaN, disk: Infinity }, 1),
    round(null, { mixed: 5, other: "7" }, 2),
    round({ p95: { count: 2, sum: 10, min: 5, max: 5, last: 5, mean: 5 } }, { p95: 9 }, 4),
    round({ legacy: { count: Number.POSITIVE_INFINITY, sum: Number.POSITIVE_INFINITY, min: Number.NaN, max: Number.NaN, last: Number.NaN } }, { legacy: 2 }, 1),
  ];
  let compared = 0;
  for (const [previous, values, delta] of rounds) {
    const before = JSON.stringify(PRE_FIX_MERGE_METRIC_STATS(previous, values, delta));
    const after = JSON.stringify(workingMetrics(previous, values, delta));
    assert.equal(after, before, `the merge of ${JSON.stringify(values)} drifted from the pre-fix output`);
    compared += 1;
  }
  assert.equal(compared, rounds.length);
  // The corpus really covers the branches it names: a `delta` above one, a
  // non-numeric value dropped, and a legacy non-finite accumulator saturated.
  assert.equal(JSON.stringify(PRE_FIX_MERGE_METRIC_STATS(null, { latency: 3.5 }, 3).latency), '{"count":3,"sum":10.5,"min":3.5,"max":3.5,"last":3.5,"mean":3.5}');
  assert.deepEqual(Object.keys(PRE_FIX_MERGE_METRIC_STATS(null, { latency: null, p95: "abc" }, 1)), []);
  assert.equal(PRE_FIX_MERGE_METRIC_STATS({ big: { count: 1, sum: MAX_ACCUMULATOR, min: 1, max: 1, last: 1, mean: 1 } }, { big: MAX_ACCUMULATOR }, 1).big.sum, MAX_ACCUMULATOR);
  // The one deliberate difference is pinned in its own test below, so this
  // differential can never be read as covering the special key as well.
});

test("the one deliberate difference is an own __proto__ metric name", () => {
  const protoMetric = () => JSON.parse('{"__proto__":5}');
  assert.equal(Object.hasOwn(PRE_FIX_MERGE_METRIC_STATS(null, protoMetric(), 1), "__proto__"), false);
  assert.equal(Object.hasOwn(workingMetrics(null, protoMetric(), 1), "__proto__"), true);
});
