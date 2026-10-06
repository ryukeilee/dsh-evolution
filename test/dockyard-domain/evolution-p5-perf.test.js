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

test("P5: stable perf metrics are deduped within one cycle (no write storm)", async (t) => {
  const { memory } = await createHarness(t);
  // Use the real cycle path (observationStore.record) which carries the dedup
  const cycle = { observationStore: new EvolutionObservationStore({ memory }) };
  // Simulate the observationStore with identical perf metrics twice
  const store = cycle.observationStore;
  await store.record({
    source: "component", type: "component/observation", componentId: "evolution.observer.control",
    severity: "info", metrics: { memoryUsage: 1000, cpuUsage: 10 },
  });
  await store.record({
    source: "component", type: "component/observation", componentId: "evolution.observer.control",
    severity: "info", metrics: { memoryUsage: 1000, cpuUsage: 10 },
  });
  const state = memory.fullSnapshot();
  const dup = state.observations.filter((o) => o.componentId === "evolution.observer.control" && o.severity === "info");
  assert.equal(dup.length, 1, "identical perf metrics should dedup to one durable entry");
});

test("P5: null->value perf transition bypasses dedup (restart recovery path)", async (t) => {
  const { memory } = await createHarness(t);
  const cycle = { observationStore: new EvolutionObservationStore({ memory }) };
  const store = cycle.observationStore;
  // First observation has NO perf metrics (simulates a pre-P5 legacy row)
  await store.record({
    source: "component", type: "component/observation", componentId: "evolution.observer.control",
    severity: "info", metrics: { usageCount: 1 },
  });
  // Second observation has perf metrics — must bypass dedup and record new evidence
  const fresh = await store.record({
    source: "component", type: "component/observation", componentId: "evolution.observer.control",
    severity: "info", metrics: { usageCount: 1, memoryUsage: 123456, cpuUsage: 10 },
  });
  const state = memory.fullSnapshot();
  const entries = state.observations.filter((o) => o.componentId === "evolution.observer.control" && o.severity === "info");
  const hasPerf = entries.some((o) => o.metrics?.memoryUsage != null);
  assert.ok(hasPerf, "perf metrics must eventually appear even after a legacy null-metrics row");
  assert.ok(fresh.metrics?.memoryUsage === 123456 || entries.at(-1)?.metrics?.memoryUsage === 123456, "perf value recorded");
});
