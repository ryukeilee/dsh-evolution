/**
 * The observation DTO redacts in two places and used to leak in both.
 *
 * `redact()` returned an `Error`'s `message` verbatim, so an error object
 * anywhere in `evidence` carried its text past `redactText()`; and
 * `redactText()` only matched the credential spellings without spaces, so
 * `api key=...` survived while `api_key=...` did not.
 *
 * The keyed path now replaces the value of an identified sensitive key with a
 * marker instead of dropping the entry, so a record still shows which field held
 * a credential. A marker is not a measurement, so it never becomes a metric.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { EvolutionObservationStore } from "../lib/dockyard-domain/observation.js";

const NOW = () => new Date("2026-10-12T00:00:00.000Z");
const REDACTED = "<redacted>";

function store() {
  const memory = {
    async load() {},
    history() { return []; },
    async recordObservation(row) { return row; },
    async recordKnowledgeEvent() {},
    get hasColdHistory() { return false; },
  };
  return new EvolutionObservationStore({ memory, clock: NOW });
}

async function record(input) {
  return store().record({ type: "tool/error", ...input });
}

function errorWith(message) {
  const error = new Error(message);
  error.code = "E_TEST";
  return error;
}

test("an error object is redacted wherever it appears", async () => {
  const error = errorWith("host operation failed: api key=sk-secret-AAA");
  const row = await record({ error, evidence: { cause: error } });
  assert.equal(JSON.stringify(row).includes("sk-secret-AAA"), false, JSON.stringify(row));
  assert.equal(row.evidence.cause.name, "Error");
  assert.equal(row.evidence.cause.code, "E_TEST");
  assert.equal(row.evidence.cause.message, "host operation failed: api key=<redacted>");
});

test("the spaced and quoted credential spellings are redacted", async () => {
  for (const text of [
    "api key=sk-secret-AAA",
    "api_key=sk-secret-BBB",
    "api-key: sk-secret-CCC",
    "API KEY: sk-secret-DDD",
    '{"apiKey": "sk-secret-EEE"}',
    "access token=sk-secret-FFF",
    "client-secret: sk-secret-GGG",
    "password=sk-secret-HHH",
    "Authorization: Bearer sk-secret-III",
  ]) {
    const row = await record({ message: text });
    assert.equal(JSON.stringify(row).includes("sk-secret"), false, `not redacted: ${text} -> ${JSON.stringify(row.message)}`);
    assert.ok(row.message.includes(REDACTED), `no marker for ${text}: ${JSON.stringify(row.message)}`);
  }
});

test("an identified sensitive key keeps its place", async () => {
  const row = await record({ evidence: { payload: { password: "hunter2", note: "kept", nested: [{ token: "t-1", id: "row" }] } } });
  assert.deepEqual(row.evidence.payload, { password: REDACTED, note: "kept", nested: [{ token: REDACTED, id: "row" }] });
  assert.equal(JSON.stringify(row).includes("hunter2"), false);
  assert.equal(JSON.stringify(row).includes("t-1"), false);
});

test("a separated or camel-cased sensitive key is still identified", async () => {
  for (const key of ["api_key", "api-key", "apiKey", "API_KEY", "access_token", "refresh-token", "client_secret", "privateKey", "credentialRef"]) {
    const row = await record({ evidence: { payload: { [key]: "sk-secret-KKK", note: "kept" } } });
    assert.equal(row.evidence.payload[key], REDACTED, `${key} was not replaced`);
    assert.equal(JSON.stringify(row).includes("sk-secret-KKK"), false, `${key} leaked`);
  }
});

test("a redacted placeholder never becomes a measurement", async () => {
  const row = await record({ evidence: {}, metrics: { tokenUsage: 12, latency: 5 } });
  assert.equal(Object.hasOwn(row.metrics, "tokenUsage"), false);
  assert.equal(row.metrics.latency, 5);
});

test("benign text and ordinary evidence are unchanged", async () => {
  const row = await record({ message: "official operation failed", evidence: { reason: "timeout", attempts: 2 } });
  assert.equal(row.message, "official operation failed");
  assert.deepEqual(row.evidence, { reason: "timeout", attempts: 2 });
  // The pattern key never carries the raw text either.
  assert.equal(JSON.stringify(row.patternKey).includes("sk-secret"), false);
});

test("the pattern key is derived from the redacted message", async () => {
  const row = await record({ message: "host failed api key=sk-secret-AAA boom" });
  assert.equal(row.patternKey.includes("sk-secret"), false, JSON.stringify(row.patternKey));
  assert.ok(row.patternKey.includes(REDACTED), JSON.stringify(row.patternKey));
});
