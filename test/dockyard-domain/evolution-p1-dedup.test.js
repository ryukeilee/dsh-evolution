import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { EvolutionMemory, EvolutionObservationStore } from "../../lib/dockyard-domain/index.js";
import { JsonStateStore } from "./support.js";
async function createHarness(t) {
  const home = await mkdtemp(join(tmpdir(), "domain-dedup-"));
  t.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true, force: true })); });
  const stateStore = new JsonStateStore({ filePath: join(home, "state.json") });
  const memory = new EvolutionMemory({ stateStore, mutationAuthority: { assertMutation() {} } });
  return { home, stateStore, memory };
}

test("P1: healthy info-level component observations are deduped (no durable growth)", async (t) => {
  const { stateStore, memory } = await createHarness(t);
  const store = new EvolutionObservationStore({ memory });
  // Two identical healthy observations for the same component
  const first = await store.record({
    source: "component", type: "component/observation", componentId: "healthy-tool",
    severity: "info", metrics: { usageCount: 1 },
  });
  const second = await store.record({
    source: "component", type: "component/observation", componentId: "healthy-tool",
    severity: "info", metrics: { usageCount: 2 },
  });
  // Same signal: same id returned, only one durable entry
  assert.equal(first.id, second.id, "dedup should return the same observation id");
  const state = memory.fullSnapshot();
  const healthy = state.observations.filter((entry) => entry.componentId === "healthy-tool" && entry.severity === "info");
  assert.equal(healthy.length, 1, "only one durable info observation for the healthy component");

  const restarted = new EvolutionMemory({ stateStore, maxEntries: 100 });
  await restarted.load();
  assert.equal(restarted.snapshot().knowledge[0].count, 2, "standalone dedup callers still persist the canonical occurrence");
});

test("P1: error signals are NOT deduped (minOccurrences evidence preserved)", async (t) => {
  const { memory } = await createHarness(t);
  const store = new EvolutionObservationStore({ memory });
  // Three identical error observations must all be recorded
  for (let index = 0; index < 3; index += 1) {
    await store.record({
      source: "component", type: "component/failed", componentId: "failing-tool",
      severity: "error", message: "tool failure", patternKey: "tool-failure",
    });
  }
  const state = memory.fullSnapshot();
  const errors = state.observations.filter((entry) => entry.componentId === "failing-tool" && entry.severity === "error");
  assert.equal(errors.length, 3, "error observations must not be deduped");
});

test("P1: forceRecord bypasses dedup", async (t) => {
  const { memory } = await createHarness(t);
  const store = new EvolutionObservationStore({ memory });
  await store.record({
    source: "component", type: "component/observation", componentId: "forced-tool",
    severity: "info", metrics: { usageCount: 1 },
  });
  await store.record({
    source: "component", type: "component/observation", componentId: "forced-tool",
    severity: "info", metrics: { usageCount: 2 }, forceRecord: true,
  });
  const state = memory.fullSnapshot();
  const entries = state.observations.filter((entry) => entry.componentId === "forced-tool" && entry.severity === "info");
  assert.equal(entries.length, 2, "forceRecord should bypass dedup");
});
