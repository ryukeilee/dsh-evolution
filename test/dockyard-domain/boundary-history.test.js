import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { EvolutionMemory, EvolutionEvaluator, projectEvolutionMetric } from "../../lib/dockyard-domain/index.js";
import { JsonStateStore } from "./support.js";

const authority = { assertMutation() {} };
test("pure import cannot write, schedule or patch timers/EventEmitter", () => {
  const url = new URL("../../lib/dockyard-domain/index.js", import.meta.url).href;
  const probe = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import fsp from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { EventEmitter } from 'node:events';
    const denied = () => { throw Error('import side effect'); };
    for (const key of ['writeFile','appendFile','mkdir','rename','rm','copyFile']) fsp[key] = denied;
    for (const key of ['writeFileSync','appendFileSync','mkdirSync','renameSync','rmSync','copyFileSync']) fs[key] = denied;
    const originalOpen = fs.openSync;
    fs.openSync = (path, flags, ...args) => { if (flags !== 'r') denied(); return originalOpen(path, flags, ...args); };
    syncBuiltinESMExports();
    const timers = ['setTimeout','setInterval','setImmediate','clearTimeout','clearInterval','clearImmediate'];
    for (const key of timers) globalThis[key] = denied;
    const before = Object.getOwnPropertyDescriptors(EventEmitter.prototype);
    await import(${JSON.stringify(url)});
    for (const key of timers) assert.equal(globalThis[key], denied);
    assert.deepEqual(Object.getOwnPropertyDescriptors(EventEmitter.prototype), before);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});

test("authority is fail-closed and transaction is explicit", async () => {
  const memory = new EvolutionMemory();
  await assert.rejects(memory.recordObservation({}), { code: "E_MUTATION_AUTHORITY_REQUIRED" });
  let durable = {}, commits = 0;
  const stateStore = { load: async () => durable, update: async () => { throw Error("unexpected fallback"); } };
  const transaction = { persist: async (fn, options) => { durable = fn(durable); commits++; assert.equal(options.includeSnapshot, false); } };
  const owned = new EvolutionMemory({ stateStore, transaction, mutationAuthority: authority });
  await owned.recordObservation({ id: "one", type: "tool/error", message: "test" });
  assert.equal(commits, 1);
  assert.equal(durable.evolution.observations.length, 1);
});

test("metric projection/evaluation preserves independent gates and anti-gaming", () => {
  const projection = projectEvolutionMetric("task", { id: "task", success: true, tokens: 10 });
  assert.equal(projection.tokenUsage, 10);
  const evaluator = new EvolutionEvaluator();
  const input = { beforeSnapshot: { metrics: { cost: 10, qualityScore: 1 } }, afterSnapshot: { metrics: { cost: 5, qualityScore: 0.5 } }, goalResult: { success: true }, testResult: { passed: true }, regressionResult: { passed: true } };
  assert.equal(evaluator.evaluate(input).decision, "rollback");
  input.afterSnapshot.metrics.qualityScore = 1;
  assert.equal(evaluator.evaluate(input).decision, "promote");
  delete input.testResult;
  assert.equal(evaluator.evaluate(input).decision, "reject");
});

test("historical snapshot copied to a temp root retains cold history across reload/restore", async (t) => {
  // Synthetic source snapshot generated locally by the domain writer; no real
  // user history is read. Cold archives are produced by forcing a tiny hot
  // window, then only the approved aggregate/archive files are copied.
  const source = await mkdtemp(join(tmpdir(), "domain-history-source-"));
  const root = await mkdtemp(join(tmpdir(), "domain-history-copy-"));
  t.after(() => Promise.all([rm(source, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]));
  const writer = new EvolutionMemory({
    stateStore: new JsonStateStore({ filePath: join(source, "state.json") }),
    mutationAuthority: authority,
    hotCycles: 2,
    hotEntries: 2,
    archiveMaxBytes: 256,
  });
  await writer.load();
  for (let index = 1; index <= 12; index += 1) {
    await writer.recordCycle({ id: `cycle-${index}`, status: "observed", problem: `problem-${index}`, recordedAt: `2026-03-01T00:00:${String(index).padStart(2, "0")}.000Z` });
  }
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === "state.json" || /^state\.json\.(?:[a-zA-Z]+-archive\.jsonl(?:\.segments)?|evolution-archive-index\.json)$/.test(entry.name)) {
      await cp(join(source, entry.name), join(root, entry.name), { recursive: true });
    }
  }
  const raw = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
  assert.ok(raw.evolution && typeof raw.evolution.schema === "number", "copied aggregate keeps the domain schema");
  const opts = { stateStore: new JsonStateStore({ filePath: join(root, "state.json") }), mutationAuthority: authority, hotCycles: 2, hotEntries: 2 };
  const first = new EvolutionMemory(opts);
  await first.load();
  const collections = Object.keys(first.snapshot()).filter((key) => Array.isArray(first.snapshot()[key]) && key !== "canonical");
  const structure = (m) => Object.fromEntries(collections.map((key) => [key, m.history(key).length]));
  const before = structure(first);
  assert.ok(before.cycles > first.snapshot().cycles.length, "historical cycles must include cold files");
  await first.load();
  assert.deepEqual(structure(first), before);
  const restarted = new EvolutionMemory(opts);
  await restarted.load();
  assert.deepEqual(structure(restarted), before);
  await restarted.restore(first.fullSnapshot());
  assert.deepEqual(structure(restarted), before);
  const again = new EvolutionMemory(opts);
  await again.load();
  assert.deepEqual(structure(again), before);
  // Structural statistics only; no record IDs, user messages or historical content.
  t.diagnostic(JSON.stringify({ schema: again.snapshot().schema, counts: before, coldCollections: Object.keys(again.snapshot().coldArchives).length }));
});
