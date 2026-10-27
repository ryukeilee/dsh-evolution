import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { EvolutionMemory } from "../../lib/dockyard-domain/memory.js";
import { JsonStateStore } from "./support.js";

const RECORDED_AT = "2026-10-10T00:00:00.000Z";

function errorOutcome() {
  return Object.assign(new Error("synthetic"), {
    id: "error-row",
    status: "failed",
    lifecycleState: "FAILED",
    signature: "sig",
    rootCause: "synthetic-root",
    recordedAt: RECORDED_AT,
  });
}

function memory(stateStore) {
  const instance = new EvolutionMemory({ stateStore, clock: () => new Date("2026-10-12T00:00:00.000Z") });
  instance.setMutationAuthority({ assertMutation() {}, isActive: () => true });
  return instance;
}

test("historyView is not interchangeable with history for Error DTOs", async () => {
  const row = errorOutcome();
  const instance = memory({
    async load() { return { evolution: { outcomes: [row] } }; },
    async update() {},
  });
  await instance.load();

  const detached = instance.history("outcomes")[0];
  const view = instance.historyView("outcomes")[0];
  assert.equal(detached.id, undefined, "structuredClone(Error) drops custom fields");
  assert.equal(view.id, "error-row", "historyView preserves the live Error fields");

  const report = await instance.compact({ dryRun: true });
  assert.equal(report.after.outcomes, 1, "the baseline clone shape keeps this row outside failed-outcome retention");
  assert.equal(report.retired, 0);
});

test("replacing a live archive cache row changes view shape while history remains detached", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-history-view-cache-shape-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const store = new JsonStateStore({ home });
  await mkdir(dirname(store.filePath), { recursive: true });
  await store.save({ evolution: { outcomes: [] } });
  await writeFile(`${store.filePath}.outcomes-archive.jsonl`, `${JSON.stringify({
    id: "error-row", status: "failed", lifecycleState: "FAILED", signature: "sig",
    rootCause: "synthetic-root", recordedAt: RECORDED_AT,
  })}\n`);

  const instance = memory(store);
  await instance.load();
  instance.history("outcomes");
  const cached = instance.archiveReadCache.get("outcomes");
  assert.ok(cached, "history() must have populated the archive table");
  // The retained row window is what a view hands out without copying, so
  // replacing it is how this test makes the cold row an Error instance.
  cached.window = [errorOutcome()];

  assert.equal(instance.historyView("outcomes")[0].id, "error-row");
  assert.equal(instance.history("outcomes")[0].id, undefined);
  const report = await instance.compact({ dryRun: true });
  assert.equal(report.after.outcomes, 1);
  assert.equal(report.retired, 0);
});
