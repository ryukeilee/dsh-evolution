import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { EvolutionMemory } from "../../lib/dockyard-domain/memory.js";
import { JsonStateStore } from "./support.js";
import { housekeepingBaseline, housekeepingBlock, reconstructPreHousekeepingIndex } from "./housekeeping-baseline.js";
import { readBaselineSource, reconstructPreArchiveIntegrity, reconstructPreDeferredArchiveIndex, reconstructPreMeasurementMarkerSaveCoalescing, reconstructPreSharedScan } from "./archive-index-baseline.js";

const NOW = "2026-10-12T00:00:00.000Z";
const FIRST = "2026-10-10T00:00:00.000Z";
const LAST = "2026-10-11T00:00:00.000Z";
const WORKING_MEMORY = fileURLToPath(new URL("../../lib/dockyard-domain/memory.js", import.meta.url));

// Run the complete pre-change module against the working tree's dependencies.
async function importMemorySource(source) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-housekeeping-module-"));
  try {
    const modulePath = join(directory, "memory.mjs");
    const dependencyBase = pathToFileURL(WORKING_MEMORY);
    await writeFile(modulePath, source.replace(/from (["'])(\.\.?\/[^"']+)\1/g,
      (_match, quote, specifier) => `from ${quote}${new URL(specifier, dependencyBase).href}${quote}`));
    const { EvolutionMemory: Memory } = await import(pathToFileURL(modulePath).href);
    assert.equal(typeof Memory, "function");
    return Memory;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const baseline = await housekeepingBaseline();
const BaselineMemory = await importMemorySource(baseline.source);

// structuredClone deliberately preserves undefined tombstones, unlike JSON.
class InMemoryStore {
  state = {};
  async load() { return structuredClone(this.state); }
  async save(state) { this.state = structuredClone(state); }
}

async function loaded(Memory, store, options = {}) {
  const memory = new Memory({
    stateStore: store, clock: () => new Date(NOW), maxEntries: 1000,
    hotEntries: 100, hotCycles: 100, archiveMaxBytes: 1024,
    mutationAuthority: { assertMutation() {}, isActive: () => true }, ...options,
  });
  await memory.load();
  return memory;
}

async function seeded(Memory, home, state, { file = false, archives = {} } = {}) {
  const store = file ? new JsonStateStore({ filePath: join(home, "state.json") }) : new InMemoryStore();
  await store.save({ evolution: structuredClone(state) });
  for (const [collection, entries] of Object.entries(archives)) {
    await writeFile(`${store.filePath}.${collection}-archive.jsonl`, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  }
  return { memory: await loaded(Memory, store), store };
}

function capture(memory) {
  const snapshot = memory.snapshot();
  return {
    snapshot,
    snapshotJSON: JSON.stringify(snapshot),
    fullJSON: JSON.stringify(memory.fullSnapshot()),
    tombstonesJSON: JSON.stringify(snapshot.tombstones),
  };
}

// Reuse the same absolute path sequentially so metadata needs no normalization.
async function pair(t, scenario) {
  const home = await mkdtemp(join(tmpdir(), "dsh-housekeeping-equivalence-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const before = await scenario(BaselineMemory, home);
  await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true });
  const after = await scenario(EvolutionMemory, home);
  return { before, after };
}

function equivalent(t, results) {
  assert.deepEqual(results.after, results.before, "before/after must preserve every snapshot field and serialized byte");
  t.diagnostic("before/after snapshots and tombstone JSON agree byte for byte");
  return results.after;
}

const row = (id, fingerprint, extra = {}) => ({ id, fingerprint, status: "candidate", recordedAt: FIRST, ...extra });
const ids = (rows) => rows.map((entry) => entry.id);

for (const collection of ["candidates", "proposals"]) {
  test(`${collection}: fitness, string timestamps and stable ties select winners without reordering survivors`, async (t) => {
    const entries = [
      row("score-low", "score", { fitnessScore: 1, lastSeen: NOW }),
      row("anchor-a", "anchor-a"),
      row("score-best", "score", { fitnessScore: "9", lastSeen: FIRST, marker: "winner" }),
      row("time-old", "time", { fitnessScore: 3, lastSeen: FIRST }),
      row("time-best", "time", { fitnessScore: 3, lastSeen: LAST }),
      row("anchor-b", "anchor-b"),
      row("recorded-old", "recorded", { fitness: 4 }),
      row("recorded-best", "recorded", { fitness: 4, recordedAt: LAST }),
      row("tie-first", "tie", { fitnessScore: 5, lastSeen: LAST }),
      row("tie-second", "tie", { fitnessScore: 5, lastSeen: LAST }),
      row("score-middle", "score", { fitnessScore: 2 }),
      // Neither carries an explicit fingerprint: exercise computed fingerprints.
      { id: "computed-low", status: "candidate", problem: "same problem", change: { x: 1 }, fitnessScore: 1 },
      { id: "computed-best", status: "candidate", problem: "same problem", change: { x: 1 }, fitnessScore: 2 },
    ];
    const result = equivalent(t, await pair(t, async (Memory, home) => {
      const { memory } = await seeded(Memory, home, { [collection]: entries });
      memory.housekeeping();
      const first = capture(memory);
      memory.housekeeping();
      return { first, second: capture(memory) };
    }));
    assert.deepEqual(ids(result.first.snapshot[collection]), [
      "anchor-a", "score-best", "time-best", "anchor-b", "recorded-best", "tie-first", "computed-best",
    ]);
    assert.deepEqual(result.first.snapshot[collection][1], entries[2], "the winning record itself survives unchanged");
    assert.deepEqual(result.second, result.first, "a second pass cannot add another duplicate tombstone");
    assert.deepEqual(result.first.snapshot.tombstones.slice(0, 5).map(({ reason, fingerprint, recordId }) => ({ reason, fingerprint, recordId })), [
      { reason: "duplicate", fingerprint: "score", recordId: "score-low" },
      { reason: "duplicate", fingerprint: "score", recordId: "score-middle" },
      { reason: "duplicate", fingerprint: "time", recordId: "time-old" },
      { reason: "duplicate", fingerprint: "recorded", recordId: "recorded-old" },
      { reason: "duplicate", fingerprint: "tie", recordId: "tie-second" },
    ]);
    assert.equal(result.first.snapshot.tombstones.length, 6);
  });
}

test("rule 1: recordId OR fingerprint hits suppress retirement; newly pushed ids are immediately reusable", async (t) => {
  const tombstones = [
    { recordId: "id-only", fingerprint: "different" },
    { recordId: "different", fingerprint: "fp-only" },
  ];
  const state = {
    tombstones,
    promotions: [
      row("id-only", "unmatched", { status: "obsolete" }),
      row("fingerprint-only", "fp-only", { status: "reverted" }),
      row("new-id", "new-fp", { status: "failed" }),
      row("new-id", "another-fp", { status: "obsolete" }),
    ],
    strategies: [row("negative-evidence", "negative", { status: "failed" }), row("old-strategy", "strategy", { status: "obsolete" })],
    experimentRecords: [row("old-experiment", "experiment", { status: "rejected" })],
  };
  const result = equivalent(t, await pair(t, async (Memory, home) => {
    const { memory } = await seeded(Memory, home, state);
    memory.housekeeping();
    const first = capture(memory);
    memory.housekeeping();
    return { first, second: capture(memory) };
  }));
  assert.deepEqual(result.first.snapshot.promotions, []);
  assert.deepEqual(ids(result.first.snapshot.strategies), ["negative-evidence"]);
  assert.deepEqual(result.first.snapshot.experimentRecords, []);
  assert.deepEqual(result.first.snapshot.tombstones.slice(0, 2), tombstones);
  assert.deepEqual(result.first.snapshot.tombstones.slice(2).map(({ reason, fingerprint, recordId }) => ({ reason, fingerprint, recordId })), [
    { reason: "failed", fingerprint: "new-fp", recordId: "new-id" },
    { reason: "obsolete", fingerprint: "strategy", recordId: "old-strategy" },
    { reason: "rejected", fingerprint: "experiment", recordId: "old-experiment" },
  ]);
  assert.deepEqual(result.second, result.first);
});

test("rule 4: an existing recordId suppresses duplicate tombstones without preserving the losing record", async (t) => {
  const tombstones = [{ recordId: "loser", fingerprint: "unrelated" }];
  const result = equivalent(t, await pair(t, async (Memory, home) => {
    const { memory } = await seeded(Memory, home, {
      tombstones, candidates: [row("loser", "same"), row("winner", "same", { fitnessScore: 2 })],
    });
    memory.housekeeping();
    const first = capture(memory);
    memory.housekeeping();
    return { first, second: capture(memory) };
  }));
  assert.deepEqual(ids(result.first.snapshot.candidates), ["winner"]);
  assert.deepEqual(result.first.snapshot.tombstones, tombstones);
  assert.deepEqual(result.second, result.first);
});

for (const collection of ["candidates", "proposals"]) {
  test(`${collection}: string and numeric members retain the baseline's primitive deduplication`, async (t) => {
    const result = equivalent(t, await pair(t, async (Memory, home) => {
      const { memory } = await seeded(Memory, home, { [collection]: ["text", 7, row("object", "distinct")] });
      memory.housekeeping();
      return capture(memory);
    }));
    assert.deepEqual(result.snapshot[collection], ["text", row("object", "distinct")]);
    assert.equal(result.snapshot.tombstones.length, 1);
    assert.equal(result.snapshot.tombstones[0].recordId, null);
    assert.equal(result.snapshot.tombstones[0].reason, "duplicate");
  });
}

for (const malformed of [null, undefined]) {
  const label = malformed === null ? "null" : "undefined";
  test(`${label} tombstone: rule 1 preserves linear short-circuit hits and aborts at the first unmatched record`, async (t) => {
    const state = {
      tombstones: [{ recordId: "hit", fingerprint: "hit-fp" }, malformed],
      promotions: [row("hit", "other", { status: "obsolete" }), row("miss", "miss", { status: "obsolete" })],
      candidates: [row("low", "same"), row("high", "same", { fitnessScore: 2 })],
    };
    const result = equivalent(t, await pair(t, async (Memory, home) => {
      const { memory } = await seeded(Memory, home, state);
      const initial = capture(memory);
      memory.housekeeping();
      const first = capture(memory);
      memory.housekeeping();
      return { initial, first, second: capture(memory) };
    }));
    assert.deepEqual(result.first, result.initial, "abort occurs before promotion filtering and candidate deduplication");
    assert.deepEqual(result.second, result.initial);
    assert.equal(result.first.snapshot.tombstones[1], malformed, "undefined must not be normalized to null");
  });

  test(`${label} tombstone: rule 4 preserves the losing-record removal performed before the linear scan aborts`, async (t) => {
    const candidates = [{ id: "loser", fingerprint: "same" }, { id: "winner", fingerprint: "same", fitnessScore: 2 }];
    const results = await pair(t, async (Memory, home) => {
      const { memory } = await seeded(Memory, home, {
        tombstones: [malformed], candidates,
      });
      memory.housekeeping();
      return capture(memory);
    });
    assert.deepEqual(ids(results.before.snapshot.candidates), ["winner"], "baseline splices the loser before the malformed tombstone throws");
    assert.deepEqual(results.before.snapshot.tombstones, [malformed]);
    t.diagnostic(`minimal input: tombstones=[${label}], candidates=${JSON.stringify(candidates)}; `
      + `before ids=${JSON.stringify(ids(results.before.snapshot.candidates))}, after ids=${JSON.stringify(ids(results.after.snapshot.candidates))}`);
    assert.deepEqual(results.after.snapshot.candidates, results.before.snapshot.candidates,
      "malformed tombstone fallback must preserve the baseline's partial removal before abort");
    equivalent(t, results);
  });
}

test("file store: a null tombstone aborts rule 5 before an archived terminal singleton can be ejected", async (t) => {
  const entry = row("terminal", "terminal", { status: "rejected" });
  const result = equivalent(t, await pair(t, async (Memory, home) => {
    const { memory } = await seeded(Memory, home, { tombstones: [null], candidates: [entry] }, {
      file: true, archives: { candidates: [entry] },
    });
    memory.history("candidates");
    assert.equal(memory.archiveKnown.get("candidates").has("id:terminal"), true);
    const initial = capture(memory);
    memory.housekeeping();
    return { initial, final: capture(memory) };
  }));
  assert.deepEqual(result.final, result.initial, "rule 5's map throws; rule 7 must never retire the singleton");
  assert.deepEqual(result.final.snapshot.tombstones, [null]);
});

for (const file of [false, true]) {
  test(`${file ? "file" : "in-memory"} store: rules 5/7 require both an archive boundary and archiveKnown`, async (t) => {
    const entries = {};
    const archives = {};
    const tombstones = [];
    for (const collection of ["candidates", "proposals"]) {
      entries[collection] = [
        row(`${collection}-missing`, `${collection}-missing`, { status: "rejected" }),
        row(`${collection}-id`, `${collection}-id`, { status: "rejected" }),
        row(`${collection}-fp`, `${collection}-fp`, { status: "reverted" }),
        row(`${collection}-eject`, `${collection}-eject`, { status: "failed" }),
        row(`${collection}-needs`, `${collection}-needs`, { status: "needs_evidence" }),
      ];
      archives[collection] = entries[collection].slice(1);
      tombstones.push(
        { recordId: `${collection}-missing`, fingerprint: "irrelevant-missing" },
        { recordId: `${collection}-id`, fingerprint: "irrelevant-id" },
        { recordId: "unrelated", ...(collection === "candidates"
          ? { candidateFingerprint: `${collection}-fp`, fingerprint: "fallback-unused" }
          : { fingerprint: `${collection}-fp` }) },
      );
    }
    const result = equivalent(t, await pair(t, async (Memory, home) => {
      const { memory } = await seeded(Memory, home, { ...entries, tombstones }, { file, archives: file ? archives : {} });
      assert.equal(memory.archiveFile === null, !file);
      for (const collection of ["candidates", "proposals"]) {
        if (file) memory.history(collection); // Populate archiveKnown through the actual archive reader.
        else memory.archiveKnown.set(collection, new Set(archives[collection].map((entry) => `id:${entry.id}`)));
        assert.equal(memory.archiveKnown.get(collection).has(`id:${collection}-missing`), false);
        assert.equal(memory.archiveKnown.get(collection).has(`id:${collection}-eject`), true);
      }
      memory.hotEntries = 2;
      memory.housekeeping();
      const first = capture(memory);
      memory.housekeeping();
      return { first, second: capture(memory) };
    }));
    for (const collection of ["candidates", "proposals"]) {
      assert.deepEqual(ids(result.first.snapshot[collection]), file
        ? [`${collection}-missing`, `${collection}-needs`] : ids(entries[collection]));
    }
    assert.deepEqual(result.second, result.first);
    assert.equal(result.first.snapshot.tombstones.length, tombstones.length + (file ? 2 : 0));
    assert.deepEqual(result.first.snapshot.tombstones.slice(tombstones.length).map(({ reason, recordId }) => ({ reason, recordId })), file
      ? [{ reason: "failed", recordId: "candidates-eject" }, { reason: "failed", recordId: "proposals-eject" }] : []);
  });
}

// Read actual bytes, including state, active JSONL, index and sealed .segments.
async function diskBytes(home, relative = "") {
  const files = {};
  for (const entry of await readdir(join(home, relative), { withFileTypes: true })) {
    const name = join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(files, await diskBytes(home, name));
    else files[name] = await readFile(join(home, name));
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

test("deterministic writes, repeated housekeeping and same-state.json restart preserve full JSON and every archive byte", async (t) => {
  const result = equivalent(t, await pair(t, async (Memory, home) => {
    const { memory, store } = await seeded(Memory, home, {
      candidates: [row("duplicate-low", "dedup"), row("duplicate-best", "dedup", { fitnessScore: 8 })],
      promotions: [row("obsolete-promotion", "old", { status: "obsolete" })],
    }, { file: true });
    memory.housekeeping();
    const first = capture(memory);
    memory.housekeeping();
    assert.deepEqual(capture(memory), first);
    // Persist the pass and exercise the public write paths with deterministic ids.
    await memory.recordCandidate({ id: "written-candidate", problem: "write candidate", change: { x: 2 }, forceRecord: true });
    await memory.recordProposal({ id: "written-proposal", problem: "write proposal", change: { x: 3 }, forceRecord: true });
    memory.hotEntries = 2;
    for (let i = 0; i < 6; i += 1) {
      await memory.recordJournal({ id: `journal-${i}`, status: "observed", problem: `journal problem ${i}`, details: "x".repeat(512), forceRecord: true });
      memory.housekeeping();
    }
    await memory.recordJournal({ id: "persist-final-pass", problem: "persist final pass", forceRecord: true });
    const beforeRestart = capture(memory);
    const bytesBefore = await diskBytes(home);
    assert.ok(Object.keys(bytesBefore).some((name) => name.includes(".segments/segment-")), "the sequence must create real sealed segments");
    assert.ok(beforeRestart.snapshot.tombstones.some((entry) => entry.recordId === "duplicate-low"));
    assert.ok(beforeRestart.snapshot.tombstones.some((entry) => entry.recordId === "obsolete-promotion"));
    const next = await loaded(Memory, new JsonStateStore({ filePath: store.filePath }), { hotEntries: 2 });
    const afterRestart = capture(next);
    assert.equal(afterRestart.fullJSON, beforeRestart.fullJSON, "fullSnapshot JSON must be byte-identical across reload");
    assert.equal(afterRestart.tombstonesJSON, beforeRestart.tombstonesJSON, "tombstones must be byte-identical across reload");
    const bytesAfter = await diskBytes(home);
    assert.deepEqual(bytesAfter, bytesBefore, "restart must leave state and archive files, including sealed segments, byte-identical");
    return { first, beforeRestart, afterRestart, bytesBefore, bytesAfter };
  }));
  assert.ok(result.beforeRestart.snapshot.tombstones.length >= 2);
  t.diagnostic("same absolute state.json reused; fullSnapshot JSON, tombstones, state/index/JSONL/.segments bytes compared without normalization");
});

test("the baseline block is anchored to the frozen pre-change artifact", async (t) => {
  const working = await readBaselineSource();
  assert.equal(baseline.pinPredatesIndex, true, "the anchor artifact must predate this change");
  assert.equal(baseline.anchor.artifact, "dsh-evolution-0.2.0-rc.7.tgz");
  assert.ok(baseline.anchor.blockBytes > 0);
  // The block equality against the artifact is asserted while loading the
  // baseline; this pins the whole file it came from, so neither reversing this
  // change nor the earlier shared-scan one can drift unnoticed.
  const reconstructed = reconstructPreHousekeepingIndex(reconstructPreSharedScan(
    reconstructPreMeasurementMarkerSaveCoalescing(reconstructPreArchiveIntegrity(reconstructPreDeferredArchiveIndex(working))),
  ));
  assert.equal(reconstructed, baseline.anchor.pinnedSource,
    "reversing this change and the earlier shared-scan refactor must reproduce the artifact byte for byte");
  const needle = "      let tombstoneIndexBuilt = false;";
  assert.equal(working.split(needle).length - 1, 1, "drift injection must change exactly one real source shape");
  assert.throws(() => reconstructPreHousekeepingIndex(working.replace(needle, `${needle} /* drift */`)),
    /housekeeping post-change shape must occur exactly once before reconstruction/);
  assert.notEqual(housekeepingBlock(working), housekeepingBlock(baseline.source), "the working tree must carry the indexed housekeeping");
  equivalent(t, await pair(t, async (Memory, home) => {
    const { memory } = await seeded(Memory, home, { proposals: [row("base-low", "base"), row("base-best", "base", { fitnessScore: 2 })] });
    memory.housekeeping();
    return capture(memory);
  }));
  t.diagnostic(`guarded reconstruction matches ${baseline.anchor.artifact} (housekeeping block ${baseline.anchor.blockBytes} bytes) and its complete file`);
});

/**
 * Deterministic randomized differential. Hand-picked shapes can miss the
 * combinations that only the implementation order decides, so this drives the
 * same generated states through both modules (in-memory and file stores, with
 * rule 5/7 archives) and requires byte-identical snapshots. The generator is a
 * fixed LCG: a failure is reproducible from the recorded seed and iteration.
 */
test("randomized differential: 300 generated states reach byte-identical snapshots", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-housekeeping-fuzz-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  let seed = 20261012;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (values) => values[Math.floor(next() * values.length) % values.length];
  const fingerprint = () => `f-${Math.floor(next() * 8)}`;
  const fields = (kind) => {
    const entry = {};
    if (next() < 0.85) entry.id = `id-${kind}-${Math.floor(next() * 10)}`;
    if (next() < 0.7) entry.fingerprint = fingerprint();
    if (next() < 0.5) entry.candidateFingerprint = fingerprint();
    if (next() < 0.4) entry.problemFingerprint = fingerprint();
    if (next() < 0.5) entry.fitnessScore = Math.floor(next() * 4);
    if (next() < 0.03) entry.fitnessScore = { toString: 0, valueOf: 0 };
    if (next() < 0.08) entry.fingerprint = null;
    if (next() < 0.5) entry.lastSeen = next() < 0.5 ? FIRST : LAST;
    if (next() < 0.3) entry.recordedAt = next() < 0.5 ? FIRST : LAST;
    entry.status = pick(["candidate", "OBSOLETE", "REVERTED", "PROMOTED", "FAILED", "NEEDS_EVIDENCE", "rejected", "superseded"]);
    entry.problem = `problem-${Math.floor(next() * 4)}`;
    if (next() < 0.03) entry.problem = { toString: 0, valueOf: 0 };
    entry.change = { component: `c-${Math.floor(next() * 3)}` };
    return entry;
  };
  const state = () => {
    const generated = { candidates: [], proposals: [], promotions: [], strategies: [], experimentRecords: [], tombstones: [] };
    for (const kind of ["candidates", "proposals"]) {
      const count = 2 + Math.floor(next() * 12);
      for (let i = 0; i < count; i += 1) {
        const roll = next();
        generated[kind].push(roll < 0.05 ? null : roll < 0.1 ? pick(["text", 7]) : fields(kind));
      }
    }
    for (const kind of ["promotions", "strategies", "experimentRecords"]) {
      const count = Math.floor(next() * 6);
      for (let i = 0; i < count; i += 1) generated[kind].push(fields(kind));
    }
    const tombstones = Math.floor(next() * 8);
    for (let i = 0; i < tombstones; i += 1) {
      if (next() < 0.12) { generated.tombstones.push(pick([null, undefined, "text", 7, 0, "", false])); continue; }
      generated.tombstones.push({ id: `tombstone-${i}`, recordId: next() < 0.7 ? `id-candidates-${Math.floor(next() * 10)}` : null,
        fingerprint: fingerprint(), candidateFingerprint: fingerprint(), state: "TOMBSTONE" });
    }
    return generated;
  };
  const run = async (Memory, generated, iteration) => {
    const file = iteration % 2 === 0;
    if (file) { await rm(home, { recursive: true, force: true }); await mkdir(home, { recursive: true }); }
    const archives = file ? Object.fromEntries(["candidates", "proposals"].map((kind) => [kind, generated[kind]])) : {};
    const { memory } = await seeded(Memory, home, generated, { file, archives });
    for (let pass = 0; pass < 3; pass += 1) memory.housekeeping();
    const frozen = capture(memory);
    return file ? { ...frozen, bytes: JSON.stringify(await diskBytes(home)) } : frozen;
  };
  let mismatches = 0;
  for (let iteration = 0; iteration < 300; iteration += 1) {
    const generated = state();
    const before = await run(BaselineMemory, structuredClone(generated), iteration);
    const after = await run(EvolutionMemory, structuredClone(generated), iteration);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      mismatches += 1;
      if (mismatches === 1) {
        t.diagnostic(`first mismatch at iteration ${iteration} (seed 20261012, ${iteration % 2 === 0 ? "file" : "in-memory"} store): `
          + `state=${JSON.stringify(structuredClone(generated)).slice(0, 600)}`);
      }
    }
  }
  await rm(home, { recursive: true, force: true });
  assert.equal(mismatches, 0, "every generated state must produce the same snapshot, tombstones and archive bytes as the baseline");
  t.diagnostic("300 generated states (half file-backed with rule 5/7 archives) agree on fullSnapshot JSON, tombstones and state/archive bytes");
});

// The cases below were found by adversarial review of the indexed
// implementation and are kept as regressions: each one produced a different
// snapshot before the corresponding fix.

const hostile = () => ({ toString: 0, valueOf: 0 });

test("a null fingerprint still falls through to the derived fingerprint", async (t) => {
  const entries = [{ id: "a", fingerprint: null, problem: "a" }, { id: "b", fingerprint: null, problem: "b" }];
  const result = equivalent(t, await pair(t, async (Memory, home) => {
    const { memory } = await seeded(Memory, home, { candidates: entries });
    memory.housekeeping();
    return capture(memory);
  }));
  // Non-vacuous: had null short-circuited the `?? fingerprint ?? derived`
  // chain, both records would share the null fingerprint and one would be lost.
  assert.deepEqual(ids(result.snapshot.candidates), ["a", "b"]);
  assert.deepEqual(result.snapshot.tombstones, []);
  t.diagnostic("null fingerprint: both records derived their own fingerprint and survived");
});

for (const falsy of [0, "", false]) {
  test(`falsy tombstone ${JSON.stringify(falsy)} keeps the original truthiness and abort semantics`, async (t) => {
    const state = {
      tombstones: [falsy],
      promotions: [{ status: "obsolete", fingerprint: "promotion-fp" }],
      candidates: [row("loser", "same"), row("winner", "same", { fitnessScore: 2 })],
    };
    const result = equivalent(t, await pair(t, async (Memory, home) => {
      const { memory } = await seeded(Memory, home, state);
      memory.housekeeping();
      return capture(memory);
    }));
    // `find` returned the matched element `falsy` and the caller tested its
    // truthiness, so the promotion is retired even though a match existed and
    // the duplicate loser is removed as usual.
    assert.deepEqual(result.snapshot.promotions, []);
    assert.deepEqual(ids(result.snapshot.candidates), ["winner"]);
    assert.equal(result.snapshot.tombstones.length, 3, "the falsy element is kept and both retirements are tombstoned");
    assert.equal(result.snapshot.tombstones[0], falsy);
  });
}

test("a throw while building a duplicate tombstone keeps the removals already done", async (t) => {
  const candidates = [{ id: "a", fingerprint: "x", problem: hostile() }, { id: "b", fingerprint: "x", fitnessScore: 1 }];
  const result = equivalent(t, await pair(t, async (Memory, home) => {
    const { memory } = await seeded(Memory, home, { candidates });
    memory.housekeeping();
    return capture(memory);
  }));
  // Non-vacuous: the original spliced the loser out before tombstoneFor threw.
  assert.deepEqual(ids(result.snapshot.candidates), ["b"]);
  assert.deepEqual(result.snapshot.tombstones, []);
  t.diagnostic("unconvertible problem field: the loser was already removed when the pass aborted");
});

test("an abort in a later group keeps the removals of every earlier group", async (t) => {
  const candidates = [
    row("first-loser", "first"), row("first-winner", "first", { fitnessScore: 2 }),
    { id: "second-loser", fingerprint: "second", fitnessScore: hostile() },
    { id: "second-winner", fingerprint: "second", fitnessScore: 1 },
  ];
  const result = equivalent(t, await pair(t, async (Memory, home) => {
    const { memory } = await seeded(Memory, home, { candidates });
    memory.housekeeping();
    return capture(memory);
  }));
  // The throw happens while scoring the second group, before its loser could be
  // removed, but after the first group was fully retired.
  assert.deepEqual(ids(result.snapshot.candidates), ["first-winner", "second-loser", "second-winner"]);
  assert.equal(result.snapshot.tombstones.length, 1, "the first group was tombstoned before the second group aborted");
  assert.equal(result.snapshot.tombstones[0].recordId, "first-loser");
});
