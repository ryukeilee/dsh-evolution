// Regression coverage for the projection/snapshot paths that used to rebuild
// the same list (or the same normalized query) more than once per call. The
// assertions are behavioural: the values and shapes must not change, so a later
// refactor cannot trade correctness for the saved work.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvolutionMemory } from "../../lib/orchestrator.js";
import { EvolutionObservationStore } from "../../lib/dockyard-domain/observation.js";
import { EvolutionStrategyMemory } from "../../lib/dockyard-domain/continuous/strategy.js";
import { CapabilityRegistry } from "../../lib/dockyard-domain/governance/capability-registry.js";

function observationStore(entries) {
  const store = new EvolutionObservationStore({
    memory: { recordObservation: async () => null, recordKnowledgeEvent: async () => null, stateStore: null },
  });
  store.entries = entries;
  return store;
}

test("observation list normalizes a primitive query once without changing the filter result", () => {
  const store = observationStore([
    { id: "a", patternKey: "request-timeout", observedAt: "2026-10-07T00:00:00.000Z" },
    { id: "b", patternKey: "request-<n>-timeout", observedAt: "2026-10-07T00:00:01.000Z" },
    { id: "c", patternKey: "other", observedAt: "2026-10-07T00:00:02.000Z" },
  ]);
  assert.deepEqual(store.list({ patternKey: "request-12-timeout" }).map((entry) => entry.id), ["b"]);
  assert.deepEqual(store.list({ patternKey: "REQUEST-TIMEOUT" }).map((entry) => entry.id), ["a"]);
  assert.deepEqual(store.list({ patternKey: null }).map((entry) => entry.id), ["a", "b", "c"]);
  assert.deepEqual(store.list({ patternKey: "" }).map((entry) => entry.id), ["a", "b", "c"]);
  assert.deepEqual(store.list().map((entry) => entry.id), ["a", "b", "c"]);
  // A non-primitive query keeps the per-entry call, so a stateful `toString`
  // sees exactly the same number of invocations as before.
  let calls = 0;
  const query = { toString() { calls += 1; return "other"; } };
  assert.deepEqual(store.list({ patternKey: query }).map((entry) => entry.id), ["c"]);
  assert.equal(calls, 3);
  // The returned entries are detached copies.
  store.list()[0].id = "mutated";
  assert.equal(store.entries[0].id, "a");
});

test("strategy snapshot reports counts for the lists it returns", () => {
  const memory = new EvolutionStrategyMemory({ maxEntries: 10 });
  memory.list = () => [{ id: "s-1" }, { id: "s-2" }];
  memory.listMutations = () => [{ id: "m-1" }];
  const snapshot = memory.snapshot();
  assert.deepEqual(snapshot.strategies.map((entry) => entry.id), ["s-1", "s-2"]);
  assert.deepEqual(snapshot.mutations.map((entry) => entry.id), ["m-1"]);
  assert.equal(snapshot.count, 2);
  assert.equal(snapshot.mutationCount, 1);
  // An empty projection still reports zeroes rather than undefined.
  memory.list = () => [];
  memory.listMutations = () => [];
  assert.deepEqual(memory.snapshot(), { strategies: [], mutations: [], count: 0, mutationCount: 0 });
});

test("capability snapshot counts active lifecycle states in the capabilities it returns", () => {
  const registry = Object.create(CapabilityRegistry.prototype);
  registry.store = { data: { capabilities: [
    { id: "c-1", lifecycleState: "active" },
    { id: "c-2", lifecycleState: "promoted" },
    { id: "c-3", lifecycleState: "archived" },
  ] } };
  const snapshot = registry.snapshot();
  assert.deepEqual(snapshot.capabilities.map((entry) => entry.id), ["c-1", "c-2", "c-3"]);
  assert.equal(snapshot.activeCount, 2);
  registry.store = { data: { capabilities: [] } };
  assert.deepEqual(registry.snapshot(), { capabilities: [], activeCount: 0 });
});

test("failure memory retains on record and load without changing the public snapshots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "domain-retain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "evolution-memory.json");
  const memory = new EvolutionMemory({ file, maxEntries: 2 });
  memory.record({ problem: "one", at: "2026-10-07T00:00:01.000Z" });
  memory.record({ problem: "two", at: "2026-10-07T00:00:02.000Z" });
  const recorded = memory.record({ problem: "three", at: "2026-10-07T00:00:03.000Z" });
  assert.equal(recorded.duplicate, false);
  assert.equal(recorded.entry.problem, "three");
  // Recording still trims to `maxEntries`, oldest first.
  assert.deepEqual(memory.snapshot().entries.map((entry) => entry.problem), ["two", "three"]);
  // A repeated record is deduplicated, counted and moved to the newest slot.
  const repeated = memory.record({ problem: "two", at: "2026-10-07T00:00:04.000Z" });
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.entry.count, 2);
  assert.deepEqual(memory.snapshot().entries.map((entry) => entry.problem), ["three", "two"]);
  // The returned entry is detached from the retained state.
  repeated.entry.count = 99;
  assert.equal(memory.snapshot().entries.find((entry) => entry.problem === "two").count, 2);
  // `compact()` keeps returning the post-trim snapshot, and `load()` stays trimmed.
  assert.deepEqual(memory.compact().entries.map((entry) => entry.problem), ["three", "two"]);
  const reloaded = new EvolutionMemory({ file, maxEntries: 2 });
  assert.deepEqual(reloaded.load().entries.map((entry) => entry.problem), ["three", "two"]);
  assert.equal(JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(file, "utf8"))).entries.length, 2);
});
