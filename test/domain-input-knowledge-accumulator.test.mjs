/**
 * The knowledge accumulator is bounded in two places that used to be silent.
 *
 * A count was added with plain `+`, so an extreme delta - or a legacy row that
 * already held one - reached `Infinity`, which JSON stores as `null`. Counts
 * and sums now saturate at `Number.MAX_SAFE_INTEGER`, which is still a number a
 * reader can use, and every normal accumulation is unchanged.
 *
 * The recent event-id window is a bounded replay guard, not the authoritative
 * ledger: `domain-storage` keeps an exact `applied` map that is consulted
 * before any mutation, and the memory bridge ledger keeps the last 4096 bridge
 * ids. The window now reports the ids it dropped, so a record never looks like
 * it covers history it no longer holds.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  isDuplicateKnowledgeEvent,
  knowledgeKeyOf,
  mergeKnowledgeEntry,
  normalizeKnowledgeEvent,
} from "../lib/dockyard-domain/knowledge.js";

const NOW = new Date("2026-10-12T00:00:00.000Z");
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function event(input) {
  return normalizeKnowledgeEvent(input, { sourceCollection: "observations", now: NOW });
}

function mergeInto(entry, input) {
  return mergeKnowledgeEntry(entry, event(input), { now: NOW });
}

function assertStoredNumbers(value, path = "record") {
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `${path} is not a finite number: ${value}`);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) assertStoredNumbers(entry, `${path}.${key}`);
}

test("an extreme count saturates instead of storing null", () => {
  const once = mergeInto(null, { semanticFact: "extreme", knowledgeCount: 1e308 });
  assert.equal(once.count, MAX_SAFE);
  assert.equal(once.occurrenceCount, MAX_SAFE);
  assert.equal(once.evidenceCount, MAX_SAFE);
  const twice = mergeInto(once, { semanticFact: "extreme", knowledgeCount: 1e308 });
  for (const key of ["count", "occurrenceCount", "evidenceCount"]) assert.equal(twice[key], MAX_SAFE);
  assertStoredNumbers(twice);
  const roundTrip = JSON.parse(JSON.stringify(twice));
  assert.equal(roundTrip.count, MAX_SAFE, "a saturated count must survive JSON, not become null");
  assertStoredNumbers(roundTrip, "roundTrip");
  // Deterministic: the same sequence produces the same record.
  assert.deepEqual(twice, mergeInto(once, { semanticFact: "extreme", knowledgeCount: 1e308 }));
});

test("an extreme metric or fitness keeps the accumulator finite", () => {
  const once = mergeInto(null, { semanticFact: "metric", metrics: { latency: 1e308 }, fitnessScore: 1e308, knowledgeCount: 1e308 });
  const twice = mergeInto(once, { semanticFact: "metric", metrics: { latency: 1e308 }, fitnessScore: 1e308, knowledgeCount: 1e308 });
  assertStoredNumbers(twice);
  assertStoredNumbers(JSON.parse(JSON.stringify(twice)), "roundTrip");
  assert.ok(Number.isFinite(twice.effectStats.metrics.latency.sum));
  assert.ok(Number.isFinite(twice.effectStats.metrics.latency.mean));
  assert.ok(Number.isFinite(twice.effectStats.fitnessSum));
});

test("a stored non-finite count is repaired on merge, never propagated", () => {
  const legacy = {
    knowledgeKey: knowledgeKeyOf({ semanticFact: "legacy" }),
    count: Infinity,
    occurrenceCount: Infinity,
    evidenceCount: Infinity,
    effectStats: { successCount: Infinity, failureCount: Infinity, neutralCount: 0, regressionCount: 0, fitnessCount: Infinity, fitnessSum: Infinity, metrics: { latency: { count: Infinity, sum: Infinity, min: 1, max: 1, last: 1, mean: 1 } } },
    sourceCounts: { observations: Infinity },
  };
  const merged = mergeKnowledgeEntry(legacy, event({ semanticFact: "legacy", success: true, metrics: { latency: 1 } }), { now: NOW });
  assertStoredNumbers(merged);
  assertStoredNumbers(JSON.parse(JSON.stringify(merged)), "roundTrip");
  assert.equal(merged.count, MAX_SAFE);
});

test("normal accumulation is unchanged", () => {
  let entry = null;
  for (let index = 0; index < 3; index += 1) entry = mergeInto(entry, { semanticFact: "normal" });
  assert.equal(entry.count, 3);
  assert.equal(entry.occurrenceCount, 3);
  assert.equal(entry.evidenceCount, 3);
  assert.equal(entry.effectStats.neutralCount, 3);
  assert.equal(entry.sourceCounts.observations, 3);
  assert.equal(mergeInto(null, { semanticFact: "delta", knowledgeCount: 7 }).count, 7);
  assert.equal(mergeInto(null, { semanticFact: "delta", occurrenceDelta: 4 }).count, 4);
  const measured = mergeInto(null, { semanticFact: "measured", success: true, metrics: { latency: 10 } });
  const second = mergeInto(measured, { semanticFact: "measured", success: true, metrics: { latency: 20 } });
  assert.equal(second.effectStats.successCount, 2);
  assert.equal(second.effectStats.metrics.latency.sum, 30);
  assert.equal(second.effectStats.metrics.latency.mean, 15);
  assert.equal(second.successRate, 1);
  assert.equal(second.confidence, 1);
});

test("a delta that is not a positive number reads as one event", () => {
  for (const value of [Infinity, -Infinity, Number.NaN, "abc", 0, -5, null, undefined]) {
    assert.equal(mergeInto(null, { semanticFact: "delta", knowledgeCount: value }).count, 1, `knowledgeCount: ${String(value)}`);
  }
  assert.equal(mergeInto(null, { semanticFact: "delta", knowledgeCount: 1.9 }).count, 1);
});

test("the event-id window is bounded and reports what it dropped", () => {
  let entry = null;
  for (let index = 0; index < 300; index += 1) entry = mergeInto(entry, { semanticFact: "window", eventId: `event-${index}` });
  assert.equal(entry.count, 300, "distinct events must all be counted");
  assert.equal(entry.eventIds.length, 256);
  assert.equal(entry.eventIds.at(-1), "event-299");
  assert.equal(entry.eventIds.at(0), "event-44");
  assert.equal(entry.eventIdsDropped, 44, "the record must say its window no longer covers its history");
  // A replay inside the window is still an exact duplicate: `mergeKnowledgeEntry()`
  // is a pure merge, so the caller consults the ledger first, which is what
  // `isDuplicateKnowledgeEvent()` answers.
  const replayed = event({ semanticFact: "window", eventId: "event-299" });
  assert.equal(isDuplicateKnowledgeEvent(entry, replayed), true);
  assert.equal(isDuplicateKnowledgeEvent(entry, event({ semanticFact: "window", eventId: "event-0" })), false);
  // The drop counter is cumulative and saturating, never a fraction.
  assert.equal(Number.isInteger(entry.eventIdsDropped), true);
  for (const key of ["count", "evidenceCount", "eventIdsDropped"]) assert.equal(Number.isSafeInteger(entry[key]), true);
});

test("a row that never rolls its window carries no drop field", () => {
  let entry = null;
  for (let index = 0; index < 5; index += 1) entry = mergeInto(entry, { semanticFact: "short", eventId: `short-${index}` });
  assert.deepEqual(entry.eventIds, ["short-0", "short-1", "short-2", "short-3", "short-4"]);
  assert.equal(Object.hasOwn(entry, "eventIdsDropped"), false);
  // An event without an id contributes nothing to the window.
  const anonymous = mergeInto(entry, { semanticFact: "short" });
  assert.deepEqual(anonymous.eventIds, entry.eventIds);
  assert.equal(Object.hasOwn(anonymous, "eventIdsDropped"), false);
});
