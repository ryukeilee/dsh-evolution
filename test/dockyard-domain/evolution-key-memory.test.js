import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { EvolutionMemory } from "../../lib/dockyard-domain/memory.js";
import { JsonStateStore } from "./support.js";

function authority() { return { assertMutation() {} }; }

function observation(overrides = {}) {
  return {
    type: "tool/error",
    componentId: "tool-a",
    patternKey: "request-timeout",
    message: "request timed out at 10 seconds",
    severity: "error",
    ...overrides,
  };
}

test("关键增量记忆合并等价观察并拆分新根因与策略", async () => {
  const memory = new EvolutionMemory({ mutationAuthority: authority(), maxEntries: 32 });
  for (let i = 0; i < 10; i++) {
    await memory.recordObservation(observation({ id: "observation-" + i, eventId: "observation-event-" + i, message: "request timed out at " + (10 + i) + " seconds" }));
  }
  const observations = memory.history("observations");
  const timeout = memory.knowledgeSnapshot().find((entry) => entry.failureMode === "request-timeout");
  assert.ok(timeout);
  assert.equal(timeout.count, 10);
  assert.ok(observations.length <= 3, "重复失败只保留有界代表样本");

  await memory.recordDiagnosis({ id: "diagnosis-1", type: "tool/error", componentId: "tool-a", failureMode: "request-timeout", rootCause: "socket pool exhausted" });
  await memory.recordDiagnosis({ id: "diagnosis-2", type: "tool/error", componentId: "tool-a", failureMode: "request-timeout", rootCause: "socket pool exhausted" });
  await memory.recordDiagnosis({ id: "diagnosis-3", type: "tool/error", componentId: "tool-a", failureMode: "request-timeout", rootCause: "remote service unavailable" });
  await memory.recordStrategy({ id: "strategy-1", strategyKey: "retry", problem: "request timeout", componentId: "tool-a", fitnessScore: 2 });
  await memory.recordStrategy({ id: "strategy-2", strategyKey: "fallback", problem: "request timeout", componentId: "tool-a", fitnessScore: 3 });
  await memory.recordStrategy({ id: "strategy-anonymous-a", problem: "request timeout", componentId: "tool-a", change: { kind: "retry", limit: 3 }, success: true });
  await memory.recordStrategy({ id: "strategy-anonymous-b", problem: "request timeout", componentId: "tool-a", change: { kind: "retry", limit: 3 }, success: true });

  const knowledge = memory.knowledgeSnapshot();
  assert.equal(knowledge.filter((entry) => entry.rootCause === "socket pool exhausted").length, 1);
  assert.equal(knowledge.filter((entry) => entry.rootCause === "remote service unavailable").length, 1);
  assert.ok(knowledge.filter((entry) => entry.strategy === "retry").length === 1);
  assert.ok(knowledge.filter((entry) => entry.strategy === "fallback").length === 1);
  assert.equal(knowledge.find((entry) => entry.strategy?.includes("retry") && entry.strategy?.includes("limit"))?.count, 2);
  assert.ok(knowledge.every((entry) => !Object.hasOwn(entry, "evidence")), "canonical 行只保留压缩维度");
});

test("关键增量记忆按 eventId 幂等并累计效果趋势", async () => {
  const memory = new EvolutionMemory({ mutationAuthority: authority(), maxEntries: 32 });
  const base = { type: "tool/run", componentId: "tool-b", patternKey: "retry", message: "retry operation" };
  await memory.recordObservation({ ...base, id: "row-1", eventId: "event-1", status: "success", severity: "info" });
  await memory.recordObservation({ ...base, id: "row-replay", eventId: "event-1", status: "success", severity: "info" });
  await memory.recordObservation({ ...base, id: "row-2", eventId: "event-2", status: "failure", severity: "error" });
  const knowledge = memory.knowledgeSnapshot();
  assert.equal(knowledge.length, 1);
  assert.equal(knowledge[0].count, 2);
  assert.deepEqual(knowledge[0].eventIds, ["event-1", "event-2"]);
  assert.equal(knowledge[0].effectStats.successCount, 1);
  assert.equal(knowledge[0].effectStats.failureCount, 1);
  assert.equal(knowledge[0].effectStats.successRate, 0.5);
  assert.equal(knowledge[0].regressionCount, 1);
  assert.equal(memory.history("observations").length, 2);
});

test("compact 将旧重复历史迁移为 knowledge 并保留活动与 lineage", async () => {
  const memory = new EvolutionMemory({ mutationAuthority: authority(), maxEntries: 64 });
  const snapshot = memory.snapshot();
  snapshot.observations = Array.from({ length: 10 }, (_, index) => observation({ id: "legacy-" + index, eventId: "legacy-event-" + index }));
  await memory.restore(snapshot, { persist: false });
  await memory.recordExperiment({ id: "active-experiment", status: "running", problem: "pending work", signature: "pending" });
  await memory.recordLineage({ id: "lineage-1", lineageId: "lineage-1", generation: 1, state: "active", parentId: null });
  const report = await memory.compact();
  const knowledge = memory.knowledgeSnapshot();
  assert.equal(knowledge.filter((entry) => entry.failureMode === "request-timeout")[0].count, 10);
  assert.ok(report.consolidated >= 7);
  assert.equal(memory.history("observations").length, 3);
  assert.equal(memory.history("experiments").some((entry) => entry.id === "active-experiment"), true);
  assert.equal(memory.history("lineage").some((entry) => entry.id === "lineage-1"), true);
});

test("knowledge 冷归档重启后保持计数与代表记录", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-key-memory-test-"));
  const statePath = join(home, "state.json");
  const archivePath = join(home, "cycles.jsonl");
  const options = { maxEntries: 3, hotEntries: 2, warmEntries: 3, archiveFile: archivePath };
  try {
    const first = new EvolutionMemory({ mutationAuthority: authority(), stateStore: new JsonStateStore({ filePath: statePath }), ...options });
    await first.load();
    for (let index = 0; index < 8; index++) {
      await first.recordObservation(observation({ id: "archive-" + index, eventId: "archive-event-" + index, componentId: "tool-" + index }));
    }
    const before = first.knowledgeSnapshot();
    assert.equal(before.length, 8);
    assert.equal(first.snapshot().knowledge.length, 3);
    assert.equal(first.snapshot().coldArchives.knowledge.count, 5);

    const restarted = new EvolutionMemory({ mutationAuthority: authority(), stateStore: new JsonStateStore({ filePath: statePath }), ...options });
    await restarted.load();
    const after = restarted.knowledgeSnapshot();
    assert.equal(after.length, 8);
    assert.deepEqual(after.map((entry) => entry.count), before.map((entry) => entry.count));
    assert.equal(restarted.history("observations").length, 8);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("并发语义写入串行聚合且保留有界样本", async () => {
  const memory = new EvolutionMemory({ mutationAuthority: authority(), maxEntries: 128 });
  await Promise.all(Array.from({ length: 100 }, (_, index) => memory.recordObservation(observation({
    id: "concurrent-" + index,
    eventId: "concurrent-event-" + index,
    componentId: "tool-concurrent",
    patternKey: "network-error",
    message: "connection reset after " + index + "ms",
  }))));
  const knowledge = memory.knowledgeSnapshot();
  assert.equal(knowledge.length, 1);
  assert.equal(knowledge[0].count, 100);
  assert.equal(knowledge[0].effectStats.failureCount, 100);
  assert.equal(memory.history("observations").length, 3);
});

test("recovery 保留关系、修正和可追溯状态", async () => {
  const memory = new EvolutionMemory({ mutationAuthority: authority(), maxEntries: 32 });
  await memory.recordStrategy({
    id: "strategy-exp-1",
    strategy: "bounded-retry",
    problem: "request timeout",
    sourceExperimentId: "experiment-recovery-1",
    sourceGenerationId: "generation-1",
    fitnessScore: 2,
  });
  let entry = memory.knowledgeSnapshot().find((item) => item.relationRefs?.includes("experiment:experiment-recovery-1"));
  assert.ok(entry);
  assert.ok(entry.relationRefs.includes("generation:generation-1"));
  const result = await memory.compensatePromotion({ experimentId: "experiment-recovery-1" });
  assert.equal(result.affectedKnowledge, 1);
  entry = memory.knowledgeSnapshot().find((item) => item.knowledgeKey === entry.knowledgeKey);
  assert.equal(memory.history("strategies").length, 0);
  assert.equal(entry.state, "REGRESSED");
  assert.equal(entry.recovery?.reason, "promotion-compensated");
  assert.ok(entry.recoveryRefs.length >= 1);
  assert.ok(entry.relationRefs.includes("experiment:experiment-recovery-1"));
});

test("带语义的 cycle compact 仍保留每轮身份", async () => {
  const memory = new EvolutionMemory({ mutationAuthority: authority(), maxEntries: 32 });
  for (let index = 1; index <= 8; index++) await memory.recordCycle({ id: "cycle-" + index, status: "observed", problem: "problem-" + index });
  const report = await memory.compact();
  assert.equal(memory.history("cycles").length, 8);
  assert.equal(memory.knowledgeSnapshot().reduce((sum, entry) => sum + entry.count, 0), 8);
  assert.equal(report.consolidated >= 8, true);
});
