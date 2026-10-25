/**
 * A data-derived `__proto__` key has to survive the durable path a real install
 * uses: the source row the ingest path redacts, the cold archive it is evicted
 * into, and the reload that reads both back.
 *
 * `safeRecord()` runs on every append, and its `redact()` used to build its
 * result with `output[key] = value`, which reaches `Object.prototype`'s
 * `__proto__` setter, so the key never reached `state.json` or the archive at
 * all. The fix defines it with `Object.fromEntries()`; what this file pins is
 * that the payload is in the durable bytes, that the identity computed at write
 * time is still the identity computed from the reloaded row, and that a reload
 * plus a finalization does not inflate the accumulator.
 *
 * The state store is the same test-only `JsonStateStore` the sibling domain
 * tests use, so the file and archive this test inspects are the real ones the
 * memory port writes.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { EvolutionMemory } from "../../lib/dockyard-domain/memory.js";
import { knowledgeKeyOf } from "../../lib/dockyard-domain/knowledge.js";
import { JsonStateStore } from "./support.js";

const NOW = "2026-10-12T00:00:00.000Z";
const clock = () => new Date(NOW);

/** A memory instance whose observation hot window is two rows, so a third evicts. */
async function harness(t) {
  const home = await mkdtemp(join(tmpdir(), "dsh-special-key-durability-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new JsonStateStore({ home });
  const open = () => new EvolutionMemory({ stateStore: store, clock, maxEntries: 2, mutationAuthority: { assertMutation() {} } });
  return { home, store, open, archiveFile: `${store.filePath}.observations-archive.jsonl` };
}

const payloadWithObject = () => JSON.parse('{"__proto__":{"x":1},"b":2}');
const payloadWithNull = () => JSON.parse('{"__proto__":null,"b":2}');

/** One observation whose payload owns the key, plus two plain ones that evict it. */
function rows() {
  return {
    legacy: { id: "legacy-proto", type: "tool/error", problem: "proto payload", componentId: "plugin:proto", patternKey: "proto:payload", severity: "error", strategy: payloadWithObject(), semanticFact: payloadWithNull(), recordedAt: "2026-10-01T00:00:00.000Z" },
    later: [
      { id: "later-a", type: "tool/error", problem: "later a", componentId: "plugin:later", severity: "error", recordedAt: NOW },
      { id: "later-b", type: "tool/error", problem: "later b", componentId: "plugin:later", severity: "error", recordedAt: NOW },
    ],
  };
}

test("an own __proto__ payload reaches the cold archive and survives a reload", async (t) => {
  const { home, open, archiveFile } = await harness(t);
  const { legacy, later } = rows();
  const first = open();
  await first.load();
  const written = await first.recordObservation(legacy);
  const identity = knowledgeKeyOf(written);
  assert.match(identity, /^knowledge:[0-9a-f]{32}$/);
  assert.equal(Object.hasOwn(written.strategy, "__proto__"), true, "the returned source row must keep its payload");
  for (const row of later) await first.recordObservation(row);
  assert.equal(first.snapshot().observations.some((row) => row.id === "legacy-proto"), false, "the first row must have left the hot window");

  // The archive file holds the payload as text and as data.
  const text = await readFile(archiveFile, "utf8");
  const archived = text.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((row) => row.id === "legacy-proto");
  assert.ok(archived, "the evicted row must be in the cold archive");
  assert.ok(text.includes('"__proto__":{"x":1}'), "the payload must be in the archive bytes");
  assert.equal(Object.hasOwn(archived.strategy, "__proto__"), true);
  assert.deepEqual(archived.strategy.__proto__, { x: 1 });
  assert.equal(Object.hasOwn(archived.semanticFact, "__proto__"), true);
  assert.equal(archived.semanticFact.__proto__, null);

  // A fresh instance reads it back with the same payload and the same identity.
  const second = open();
  await second.load();
  const reloaded = second.history("observations").find((row) => row.id === "legacy-proto");
  assert.ok(reloaded, "the archived row must load back");
  assert.equal(Object.hasOwn(reloaded.strategy, "__proto__"), true, "the reloaded row must keep its payload");
  assert.deepEqual(reloaded.strategy.__proto__, { x: 1 });
  assert.equal(JSON.stringify(reloaded.strategy), JSON.stringify(payloadWithObject()));
  assert.equal(knowledgeKeyOf(reloaded), identity, "the identity must not depend on whether the row is hot or cold");

  // Finalization regroups the sources by identity; the archived subject keeps one
  // canonical row and its count does not grow just because it was reloaded.
  const result = await second.finalizeKnowledge({
    winner: { id: "winner-proto", capabilityId: "plugin:proto", problemFingerprint: "proto-payload" },
    before: { latency: 10 }, after: { latency: 5 }, outcome: "SUCCESS",
  });
  assert.equal(result.committed, true);
  const canonical = second.knowledgeSnapshot().filter((row) => row.knowledgeKey === identity);
  assert.equal(canonical.length, 1, "one subject, one canonical row");
  assert.equal(canonical[0].count, 1, "the count must not inflate across the reload");
  // The archived row is still readable, and nothing reached the shared prototype.
  assert.ok(second.history("observations").some((row) => row.id === "legacy-proto"));
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(({}).polluted, undefined);

  // The history and knowledge views are stable through their own JSON round trip,
  // except that a payload key is a data property on both sides.
  const observations = second.history("observations");
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(observations))), JSON.stringify(observations));
  const knowledge = second.knowledgeSnapshot();
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(knowledge))), JSON.stringify(knowledge));
  // Finalization archives the source row instead of rewriting it, so the payload
  // is still in the archive bytes after it ran.
  assert.ok((await readFile(archiveFile, "utf8")).includes('"__proto__":{"x":1}'), "finalization must not scrub the archived payload");
});
