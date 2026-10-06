import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvolutionMemory } from "../../lib/dockyard-domain/memory.js";
import { JsonStateStore } from "./support.js";

test("cold-only failure blockers and verified canonical survive semantic GC/restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "domain-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const opts = { stateStore: new JsonStateStore({ filePath: join(root, "state.json") }), hotEntries: 2, hotCycles: 2, maxEntries: 3, archiveMaxBytes: 1024, mutationAuthority: { assertMutation() {} } };
  const memory = new EvolutionMemory(opts);
  await memory.load();
  // compact preserves provenance; it does not create promotion evidence.
  // Seed an explicit synthetic historical provenance DTO to test persistence,
  // not to claim that an official orchestrator event has been received.
  await memory.restore({ ...memory.snapshot(), provenance: { id: "synthetic-provenance", source: "domain-test", experimentId: "verified-experiment" } });
  await memory.recordOutcome({ id: "important-failure", signature: "cannot-repeat", rootCause: "test-only failure", status: "failure" });
  for (let i = 0; i < 8; i++) await memory.recordOutcome({ id: `other-${i}`, signature: `other-${String.fromCharCode(97 + i)}`, rootCause: `synthetic-${String.fromCharCode(97 + i)}`, status: "failure" });
  assert.equal(memory.snapshot().outcomes.some((e) => e.id === "important-failure"), false);
  assert.equal(memory.findBlockingOutcomes("cannot-repeat").length, 1);
  await assert.rejects(memory.recordCanonical({ capability: "test", recordId: "unverified" }), /verified stability/);
  await memory.recordExperiment({ id: "verified-experiment", status: "validated" });
  await memory.recordStrategy({ id: "verified-winner", capabilityId: "test", status: "validated", strategyKey: "safe-retry", sourceExperimentId: "verified-experiment" });
  await memory.recordCanonical({ capability: "test", recordId: "verified-winner", sourceCollection: "strategies", experimentId: "verified-experiment", stabilityVerified: true, fitnessScore: 2 });
  await memory.compact();
  assert.ok(memory.findBlockingOutcomes("cannot-repeat").length >= 1);
  assert.equal(memory.canonicalSnapshot()[0].recordId, "verified-winner");
  assert.ok(memory.history("experiments").some((e) => e.id === "verified-experiment"));
  assert.ok(memory.snapshot().provenance);
  const next = new EvolutionMemory(opts);
  await next.load();
  assert.ok(next.findBlockingOutcomes("cannot-repeat").length >= 1);
  assert.equal(next.canonicalSnapshot()[0].recordId, "verified-winner");
  assert.ok(next.snapshot().provenance);
  await next.restore(memory.fullSnapshot());
  const count = next.history("outcomes").length;
  await next.restore(next.fullSnapshot());
  assert.equal(next.history("outcomes").length, count);
});
