import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EvolutionMemory } from "../../lib/dockyard-domain/memory.js";
import { JsonStateStore } from "./support.js";

const COLLECTIONS = Object.freeze(["observations", "cycles", "proposals"]);
const archiveName = (collection) => collection === "cycles"
  ? "state.json.cycles-archive.jsonl"
  : `state.json.${collection}-archive.jsonl`;

function authority() { return { assertMutation() {}, isActive: () => true }; }

async function newMemory(home, options = {}) {
  const memory = new EvolutionMemory({
    stateStore: new JsonStateStore({ home }),
    hotEntries: 2,
    hotCycles: 2,
    archiveMaxBytes: 1024,
    ...options,
  });
  memory.setMutationAuthority(authority());
  await memory.load();
  return memory;
}

async function assertIndexMatches(home) {
  const root = join(home, ".dockyard-dsh");
  let index;
  try {
    index = JSON.parse(await readFile(join(root, "state.json.evolution-archive-index.json"), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    index = { segments: [] };
  }
  const actual = [];
  for (const collection of COLLECTIONS) {
    const archive = join(root, archiveName(collection));
    try {
      await stat(archive);
      actual.push({ collection, file: archiveName(collection), path: archive });
    } catch {}
    const directory = archive + ".segments";
    try {
      for (const name of await readdir(directory)) {
        if (/^segment-[0-9]+\.jsonl$/.test(name)) actual.push({ collection, file: name, path: join(directory, name) });
      }
    } catch {}
  }
  if (actual.length === 0 && index.segments.length === 0) return index;
  const actualKeys = new Set(actual.map((entry) => `${entry.collection}:${entry.file}`));
  const indexKeys = new Set(index.segments.map((entry) => `${entry.collection}:${entry.file}`));
  assert.deepEqual(indexKeys, actualKeys, "archive index must list exactly the existing archive files");
  for (const entry of index.segments) {
    const file = actual.find((candidate) => candidate.collection === entry.collection && candidate.file === entry.file);
    assert.ok(file, `indexed archive file must exist: ${entry.file}`);
    const raw = await readFile(file.path);
    const lines = raw.toString("utf8").split("\n").filter(Boolean);
    const records = lines.map((line) => JSON.parse(line));
    assert.equal(entry.byteSize, raw.length, `${entry.file}: byteSize`);
    assert.equal(entry.physicalCount, lines.length, `${entry.file}: physicalCount`);
    assert.equal(entry.logicalCount, new Set(records.map((record) => `id:${record.id ?? JSON.stringify(record)}`)).size, `${entry.file}: logicalCount`);
    if (entry.sealed) {
      assert.equal(entry.checksumState, "final", `${entry.file}: sealed checksum state`);
      assert.equal(entry.sha256, createHash("sha256").update(raw).digest("hex"), `${entry.file}: sealed sha256`);
    } else {
      assert.equal(entry.checksumState, "provisional", `${entry.file}: active checksum state`);
      assert.equal(entry.sha256, null, `${entry.file}: active sha256 must be provisional`);
    }
  }
  return index;
}

async function recordTriplet(memory, index) {
  const recordedAt = `2026-08-26T12:00:${String(index).padStart(2, "0")}.000Z`;
  await memory.recordObservation({ id: `observation-${index}`, type: "component/observation", recordedAt });
  await memory.recordCycle({ id: `cycle-${index}`, status: "observed", recordedAt });
  await memory.recordProposal({ id: `proposal-${index}`, problem: `problem-${index}`, status: "proposed", recordedAt });
}

test("live observation/cycle/proposal appends keep the archive index fresh", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-archive-index-live-"));
  try {
    const memory = await newMemory(home, { archiveMaxBytes: 256 });
    for (let index = 1; index <= 12; index += 1) {
      await recordTriplet(memory, index);
      await assertIndexMatches(home);
    }
    const index = await assertIndexMatches(home);
    assert.equal(index.segments.some((entry) => entry.sealed), true, "small rotation must produce sealed entries");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("compact followed by live appends keeps index metadata current", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-archive-index-compact-"));
  try {
    const memory = await newMemory(home, { archiveMaxBytes: 2048 });
    for (let index = 1; index <= 20; index += 1) await recordTriplet(memory, index);
    await memory.compact();
    await assertIndexMatches(home);
    await recordTriplet(memory, 21);
    await assertIndexMatches(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("restart reconciles an append that completed before its index write", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-archive-index-recovery-"));
  try {
    const memory = await newMemory(home, { archiveMaxBytes: 4096 });
    for (let index = 1; index <= 6; index += 1) await memory.recordObservation({ id: `observation-${index}`, type: "component/observation" });
    const root = join(home, ".dockyard-dsh");
    const indexPath = join(root, "state.json.evolution-archive-index.json");
    const previousIndex = await readFile(indexPath);
    const activePath = join(root, "state.json.observations-archive.jsonl");
    await appendFile(activePath, JSON.stringify({ id: "observation-crash-tail", type: "component/observation", recordedAt: "2026-08-26T12:01:00.000Z" }) + "\n");
    await writeFile(indexPath, previousIndex);
    const reloaded = await newMemory(home, { archiveMaxBytes: 4096 });
    assert.ok(reloaded);
    await assertIndexMatches(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("restart rebuilds a sealed entry after a rotation/index crash", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-archive-index-seal-recovery-"));
  try {
    const memory = await newMemory(home, { archiveMaxBytes: 256 });
    for (let index = 1; index <= 8; index += 1) await memory.recordCycle({ id: `cycle-${index}`, status: "observed", problem: `problem-${index}` });
    const root = join(home, ".dockyard-dsh");
    const indexPath = join(root, "state.json.evolution-archive-index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    index.segments = index.segments.filter((entry) => !entry.sealed);
    await writeFile(indexPath, JSON.stringify(index));
    const reloaded = await newMemory(home, { archiveMaxBytes: 256 });
    assert.ok(reloaded);
    const repaired = await assertIndexMatches(home);
    assert.equal(repaired.segments.some((entry) => entry.sealed), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("stale index referencing rotated-away segments and wrong checksums is reconciled on load", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-archive-index-stale-live-"));
  try {
    const memory = await newMemory(home, { archiveMaxBytes: 512 });
    for (let index = 1; index <= 40; index += 1) {
      await memory.recordObservation({ id: `observation-${index}`, type: "component/observation", recordedAt: `2026-08-27T00:00:${String(index).padStart(2, "0")}.000Z` });
      await memory.recordCycle({ id: `cycle-${index}`, status: "observed", recordedAt: `2026-08-27T00:00:${String(index).padStart(2, "0")}.000Z` });
      await memory.recordProposal({ id: `proposal-${index}`, problem: `problem-${index}`, status: "proposed", recordedAt: `2026-08-27T00:00:${String(index).padStart(2, "0")}.000Z` });
    }
    await memory.recordLineage({
      id: "generation:stale-test:f84c33d2-fa6a-4f04-98f3-5a3c3de40f5c",
      lineageId: "selfcheck:stale-test",
      generation: 1,
      generationId: "generation:stale-test:1",
      decision: "promote",
      version: "generation-1",
      recordedAt: "2026-08-27T00:00:41.000Z",
    });
    await memory.recordLineage({
      id: "bridge:lineage:stale-test:1",
      lineageId: "stale-test",
      generation: 2,
      generationId: "bridge:generation:stale-test:2",
      decision: "promote",
      version: "v2",
      recordedAt: "2026-08-27T00:00:42.000Z",
    });
    const root = join(home, ".dockyard-dsh");
    const indexPath = join(root, "state.json.evolution-archive-index.json");
    // Simulate the live condition: an old runtime rotated archives without
    // updating the index, leaving it referencing segments that no longer exist
    // and stale byteSize/sha256 for segments that do exist.
    const staleSegments = [];
    for (const collection of ["observations", "cycles"]) {
      const directory = join(root, `state.json.${collection}-archive.jsonl.segments`);
      const names = (await readdir(directory)).filter((name) => /^segment-[0-9]+\.jsonl$/.test(name)).sort();
      for (const name of names) {
        const raw = await readFile(join(directory, name), "utf8");
        staleSegments.push({
          segmentId: `segment:${collection}:${name.replace("segment-", "").replace(".jsonl", "")}`,
          collection, file: name, sealed: true, checksumState: "final",
          byteSize: Buffer.byteLength(raw) + 999, logicalCount: 1, physicalCount: 1,
          sha256: createHash("sha256").update(raw).digest("hex") + "deadbeef",
          hashAlgorithm: "sha256", createdAt: "2026-08-26T00:00:00.000Z", updatedAt: "2026-08-26T00:00:00.000Z",
        });
      }
      for (const phantom of ["segment-000000000099.jsonl", "segment-000000000100.jsonl"]) {
        staleSegments.push({ segmentId: `segment:${collection}:99`, collection, file: phantom, sealed: true, checksumState: "final", byteSize: 123, logicalCount: 1, physicalCount: 1, sha256: "deadbeef", hashAlgorithm: "sha256", createdAt: "2026-08-26T00:00:00.000Z", updatedAt: "2026-08-26T00:00:00.000Z" });
      }
    }
    await writeFile(indexPath, JSON.stringify({ schemaVersion: 1, updatedAt: "2026-08-27T04:10:23.407Z", segments: staleSegments }));
    // Reload: reconcile must prune phantoms, correct checksums, keep history.
    const reloaded = await newMemory(home, { archiveMaxBytes: 512 });
    assert.ok(reloaded);
    const index = await assertIndexMatches(home);
    // Lineage / generation continuity must survive the reconcile.
    const stored = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    const lineage = stored.evolution?.lineage ?? [];
    assert.equal(lineage.length, 2, "lineage entries preserved");
    assert.ok(lineage.some((entry) => String(entry.id ?? "").includes("generation-1")
      || String(entry.version ?? "").includes("generation-1")), "generation-1 anchor preserved");
    for (const entry of index.segments) {
      assert.ok(!entry.file.includes("99") && !entry.file.includes("100"), `phantom pruned: ${entry.file}`);
    }
    // Reload again: the reconciled index is stable (modulo the clock stamp).
    const before = JSON.parse(await readFile(indexPath, "utf8"));
    const strip = (document) => {
      delete document.updatedAt;
      for (const entry of document.segments) delete entry.updatedAt;
      return document;
    };
    const again = await newMemory(home, { archiveMaxBytes: 512 });
    assert.ok(again);
    const after = JSON.parse(await readFile(indexPath, "utf8"));
    assert.deepEqual(strip(after), strip(before), "repeated reconciliation is idempotent");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
