/**
 * Cold-archive write and read integrity for `EvolutionMemory`.
 *
 * Every case here was first reproduced against the unfixed implementation:
 * an interrupted append leaves an incomplete final line in the active archive
 * file, and the next append concatenated a new record into that fragment, so
 * the reader could only drop the line while the caller had already removed the
 * record from the hot window (P1-1); a knowledge row that lives only in the
 * cold archive reported an update the archive refused (P2-5); unparseable
 * bytes anywhere in an archive disappeared without a trace (P3-2); a source
 * row whose archived copy could not be refreshed was dropped on eviction
 * (P3-4). No test here weakens an assertion of the released behaviour: the
 * parseable records of every fixture must still be returned exactly as before.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EvolutionMemory } from "../lib/dockyard-domain/memory.js";

const authority = { assertMutation() {} };
const COLD = { id: "cold-1", recordedAt: "2026-01-01T00:00:00.000Z" };
const TORN = '{"id":"torn-2","recordedAt":"2026-01-01T00:00:01.000Z","payl';

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), "memory-integrity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A file-backed state store that keeps the aggregate it was handed. */
function persistentStore(filePath, initial) {
  let aggregate = initial;
  const write = async () => writeFile(filePath, JSON.stringify(aggregate));
  return {
    filePath,
    load: async () => structuredClone(aggregate),
    update: async (updater) => { aggregate = updater(aggregate); await write(); },
    persist: async (next) => { aggregate = structuredClone(next); await write(); },
  };
}

/**
 * Observations whose `message` is a distinct word: the knowledge key of a
 * semantic event ignores digits (they normalize to `<n>`), so ids like `hot-1`
 * and `hot-2` with their own text as the message would fold into one knowledge
 * row and the second source record would be folded away as a duplicate.
 */
function observation(id, message) {
  return { id, type: "tool/error", componentId: "tool-1", message, recordedAt: "2026-01-01T00:00:00.000Z" };
}

const quarantineFiles = (names) => names.filter((name) => name.includes("quarantine-archive.jsonl"));

test("P1-1: a torn active-archive tail cannot swallow the record appended after it", async (t) => {
  const directory = await scratch(t);
  const filePath = join(directory, "state.json");
  const archive = `${filePath}.observations-archive.jsonl`;
  await writeFile(archive, JSON.stringify(COLD) + "\n" + TORN);
  const initial = {
    evolution: {
      schema: 4,
      observations: [observation("hot-1", "first"), observation("hot-2", "second"), observation("hot-3", "third")],
      coldArchives: { observations: { schema: 2, count: 1, file: archive, activeFile: archive, segments: [] } },
    },
  };
  const stateStore = persistentStore(filePath, initial);
  const memory = new EvolutionMemory({
    stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority, hotEntries: 2,
  });
  // The load-time eviction is what appends directly after the torn fragment.
  await memory.load();

  // (a) the evicted record did not disappear behind the fragment
  assert.ok(memory.history("observations").some((entry) => entry.id === "hot-1"),
    "the record appended after a torn tail must stay readable");
  assert.ok(memory.archiveIntegrity().observations?.some((fault) => fault.kind === "torn-tail"),
    "the torn tail must be reported, not swallowed");

  // (b) the fragment is preserved byte for byte, never truncated away
  const quarantined = quarantineFiles(await readdir(directory));
  assert.deepEqual(quarantined, ["state.json.observationsquarantine-archive.jsonl"],
    "the torn fragment must be quarantined in the collection's audit file");
  assert.equal(await readFile(join(directory, quarantined[0]), "utf8"), `${TORN}\n`,
    "the quarantine file must hold the fragment byte for byte");

  // the active file itself only holds complete lines now
  const lines = (await readFile(archive, "utf8")).split("\n").filter(Boolean);
  assert.deepEqual(lines.map((line) => JSON.parse(line).id), ["cold-1", "hot-1"]);

  // (c) the new record is readable after a restart, together with the rest
  await memory.recordObservation(observation("hot-4", "fourth"));
  const restarted = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority, hotEntries: 2 });
  await restarted.load();
  assert.deepEqual(restarted.history("observations").map((entry) => entry.id),
    ["cold-1", "hot-1", "hot-2", "hot-3", "hot-4"]);

  // A later torn tail appends to the same audit file instead of replacing it.
  const second = '{"id":"torn-3","recordedAt":"2026-01-01T00:00:02.000Z","pay';
  await writeFile(archive, (await readFile(archive, "utf8")) + second);
  await restarted.recordObservation(observation("hot-5", "fifth"));
  assert.equal(await readFile(join(directory, quarantined[0]), "utf8"), `${TORN}\n${second}\n`,
    "the quarantine file must be append-only");
});

test("P1-1: an archive write that fails keeps the hot copy and reports the failure", async (t) => {
  const directory = await scratch(t);
  const filePath = join(directory, "state.json");
  const archive = `${filePath}.observations-archive.jsonl`;
  const initial = {
    evolution: {
      schema: 4,
      observations: [observation("hot-1", "first"), observation("hot-2", "second"), observation("hot-3", "third")],
      coldArchives: { observations: { schema: 2, count: 0, file: archive, activeFile: archive, segments: [] } },
    },
  };
  const stateStore = persistentStore(filePath, initial);
  const memory = new EvolutionMemory({
    stateStore,
    transaction: { persist: stateStore.update },
    mutationAuthority: authority,
    hotEntries: 2,
    archiveWriteGuard: async (file) => { if (file === archive) throw new Error("EIO: simulated write failure"); },
  });
  await memory.load();

  // (d) the failed archival must not remove the record it could not persist
  assert.deepEqual(memory.snapshot().observations.map((entry) => entry.id), ["hot-1", "hot-2", "hot-3"]);
  assert.ok(memory.archiveIntegrity().observations?.some((fault) => fault.kind === "deferred-write"),
    "a failed archive write must be observable");
  assert.equal(await readFile(archive, "utf8").catch(() => ""), "", "the failed write must not leave bytes behind");

  const recovered = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority, hotEntries: 2 });
  await recovered.load();
  assert.deepEqual(recovered.history("observations").map((entry) => entry.id), ["hot-1", "hot-2", "hot-3"]);
});

test("P1-1: an unterminated but complete final record survives the repair the next append runs", async (t) => {
  const directory = await scratch(t);
  const filePath = join(directory, "state.json");
  const archive = `${filePath}.observations-archive.jsonl`;
  // A writer outside this instance that does not terminate its last line leaves a
  // complete record with no separator after it. The reader parses that line, so the
  // repair must supply the missing byte; moving the line into the quarantine file
  // would drop a readable record from `history()` while keeping its bytes.
  const external = { id: "external-1", recordedAt: "2026-01-01T00:00:02.000Z", message: "written by another process" };
  await writeFile(archive, `${JSON.stringify(COLD)}\n${JSON.stringify(external)}`);
  assert.equal((await readFile(archive, "utf8")).at(-1), "}", "the fixture's last line must be unterminated");

  const initial = {
    evolution: {
      schema: 4,
      observations: [observation("hot-1", "first"), observation("hot-2", "second"), observation("hot-3", "third")],
      coldArchives: { observations: { schema: 2, count: 2, file: archive, activeFile: archive, segments: [] } },
    },
  };
  const stateStore = persistentStore(filePath, initial);
  const memory = new EvolutionMemory({
    stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority, hotEntries: 2,
  });
  // The load-time eviction of `hot-1` is what appends directly after the unterminated
  // complete line, so this is the append the repair runs inside of.
  await memory.load();

  // (a) the core of the fix: a record that was already readable stays readable
  assert.ok(memory.history("observations").some((entry) => entry.id === external.id),
    "a complete unterminated record must not be quarantined as a fragment");
  assert.equal(memory.history("observations").find((entry) => entry.id === external.id).message, external.message,
    "the record must keep its payload, not just its id");

  // (b) the active file ends on a separator, so every line is a whole record
  const active = await readFile(archive, "utf8");
  assert.ok(active.endsWith("\n"), "the repair must terminate the final line");
  assert.deepEqual(active.split("\n").filter(Boolean).map((line) => JSON.parse(line).id),
    ["cold-1", "external-1", "hot-1"]);

  // (c) nothing was read as a fragment, so nothing was moved into quarantine
  assert.deepEqual(quarantineFiles(await readdir(directory)), [],
    "a complete record must not be copied into the quarantine file");
  assert.ok(!(memory.archiveIntegrity().observations ?? []).some((fault) => fault.kind === "torn-tail"),
    "supplying a missing separator is not a torn-tail fault");

  // (d) the byte added for the separator is not a record of its own
  const ids = memory.history("observations").map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "the separator must not duplicate a record");
  assert.deepEqual(ids.slice().sort(), ["cold-1", "external-1", "hot-1", "hot-2", "hot-3"].sort(),
    "the separator must not read as an empty record");

  // (e) the record appended after the repair is visible, and all of it restarts
  await memory.recordObservation(observation("hot-4", "fourth"));
  const restarted = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority, hotEntries: 2 });
  await restarted.load();
  assert.deepEqual(restarted.history("observations").map((entry) => entry.id).sort(),
    ["cold-1", "external-1", "hot-1", "hot-2", "hot-3", "hot-4"].sort());
});

test("P1-1: an unterminated fragment is still quarantined byte for byte", async (t) => {
  const directory = await scratch(t);
  const filePath = join(directory, "state.json");
  const archive = `${filePath}.observations-archive.jsonl`;
  // The control for the case above: the same fixture, except that the final line is
  // not a record. A fragment is still a fragment: its bytes belong in the quarantine
  // file and the active file keeps only complete lines.
  const fragment = '{"id":"torn-4","recordedAt":"2026-01-01T00:00:03.000Z","payl';
  await writeFile(archive, `${JSON.stringify(COLD)}\n${fragment}`);

  const initial = {
    evolution: {
      schema: 4,
      observations: [observation("hot-1", "first"), observation("hot-2", "second"), observation("hot-3", "third")],
      coldArchives: { observations: { schema: 2, count: 1, file: archive, activeFile: archive, segments: [] } },
    },
  };
  const stateStore = persistentStore(filePath, initial);
  const memory = new EvolutionMemory({
    stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority, hotEntries: 2,
  });
  await memory.load();

  const quarantined = quarantineFiles(await readdir(directory));
  assert.deepEqual(quarantined, ["state.json.observationsquarantine-archive.jsonl"],
    "the fragment must be quarantined in the collection's audit file");
  assert.equal(await readFile(join(directory, quarantined[0]), "utf8"), `${fragment}\n`,
    "the fragment must be preserved byte for byte");
  assert.deepEqual((await readFile(archive, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line).id),
    ["cold-1", "hot-1"], "the active file must keep only complete lines");
  assert.ok((memory.archiveIntegrity().observations ?? []).some((fault) => fault.kind === "torn-tail"),
    "a genuine fragment must still be reported as a torn tail");
  const ids = memory.history("observations").map((entry) => entry.id);
  assert.ok(ids.includes("hot-1"), "the record appended after the fragment must be readable");
  assert.ok(!ids.includes("torn-4"), "a fragment is not a record");
});

test("P2-5: a cold-only knowledge row cannot report an update the archive refused", async (t) => {
  const directory = await scratch(t);
  const filePath = join(directory, "state.json");
  const archive = `${filePath}.knowledge-archive.jsonl`;
  const stateStore = persistentStore(filePath, {});
  let failWrites = false;
  const memory = new EvolutionMemory({
    stateStore,
    transaction: { persist: stateStore.update },
    mutationAuthority: authority,
    maxEntries: 1,
    hotEntries: 2,
    archiveWriteGuard: async (file) => { if (failWrites && file === archive) throw new Error("EIO: simulated write failure"); },
  });
  await memory.load();
  const event = (eventId, pattern) => ({
    eventId, sourceCollection: "observations", type: "tool/error", componentId: "tool-1",
    patternKey: pattern, message: `${pattern} failed`, recordedAt: "2026-01-01T00:00:00.000Z",
  });
  await memory.recordKnowledgeEvent(event("e1", "alpha"));
  await memory.recordKnowledgeEvent(event("e2", "beta"));
  const archivedCount = () => readFile(archive, "utf8").then((raw) => raw.split("\n").filter(Boolean).map((line) => JSON.parse(line).count));
  assert.deepEqual(await archivedCount(), [1], "the first row must be in the cold archive");

  failWrites = true;
  await assert.rejects(memory.recordKnowledgeEvent(event("e3", "alpha")),
    /archive/, "an update the cold archive refused must fail the mutation");
  assert.deepEqual(await archivedCount(), [1], "the archive must keep the value it already had");
  assert.ok(memory.snapshot().knowledge.every((entry) => entry.count === 1),
    "no unpersisted knowledge update may be reported as durable");

  // the same update succeeds once the archive accepts writes, so nothing is lost
  failWrites = false;
  const updated = await memory.recordKnowledgeEvent(event("e3", "alpha"));
  assert.equal(updated.count, 2);
  assert.equal((await archivedCount()).at(-1), 2, "the retried update must land in the archive");
});

test("P2-5: a hot knowledge row the archive also owns must not lose its newer value", async (t) => {
  const directory = await scratch(t);
  const filePath = join(directory, "state.json");
  const archive = `${filePath}.knowledge-archive.jsonl`;
  const stateStore = persistentStore(filePath, {});
  const memory = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority, maxEntries: 1, hotEntries: 2 });
  await memory.load();
  const event = (eventId, pattern) => ({
    eventId, sourceCollection: "observations", type: "tool/error", componentId: "tool-1",
    patternKey: pattern, message: `${pattern} failed`, recordedAt: "2026-01-01T00:00:00.000Z",
  });
  await memory.recordKnowledgeEvent(event("e1", "alpha"));
  await memory.recordKnowledgeEvent(event("e2", "beta"));
  const archivedRow = JSON.parse((await readFile(archive, "utf8")).trim().split("\n")[0]);

  // The shape a restore or an interrupted durable write leaves: the same row is
  // hot with a newer value while the archive still owns the older one.
  const hotRow = { ...archivedRow, count: 5, occurrenceCount: 5 };
  await stateStore.persist({ evolution: { schema: 4, knowledge: [hotRow], coldArchives: { knowledge: { schema: 2, count: 1, file: archive, activeFile: archive, segments: [] } } } });
  const reopened = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority, maxEntries: 1, hotEntries: 2 });
  await reopened.load();
  assert.deepEqual(reopened.snapshot().knowledge.map((entry) => entry.count), [5]);

  const updated = await reopened.recordKnowledgeEvent(event("e3", "alpha"));
  assert.equal(updated.count, 6);
  // Evicting the row must publish the merged value, not drop it behind the key
  // the archive already owns.
  await reopened.recordKnowledgeEvent(event("e4", "gamma"));
  const archived = (await readFile(archive, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(archived.filter((entry) => entry.knowledgeKey === archivedRow.knowledgeKey).at(-1).count, 6);
  assert.equal(reopened.knowledgeSnapshot().find((entry) => entry.knowledgeKey === archivedRow.knowledgeKey).count, 6);

  const restarted = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority, maxEntries: 1, hotEntries: 2 });
  await restarted.load();
  assert.equal(restarted.knowledgeSnapshot().find((entry) => entry.knowledgeKey === archivedRow.knowledgeKey).count, 6);
});

test("P3-2: unparseable archive bytes are reported instead of dropped silently", async (t) => {
  const tornHome = await scratch(t);
  const tornPath = join(tornHome, "state.json");
  const tornArchive = `${tornPath}.observations-archive.jsonl`;
  await writeFile(tornArchive, JSON.stringify(COLD) + "\n" + TORN);
  const tornStore = persistentStore(tornPath, { evolution: { schema: 4, observations: [], coldArchives: {} } });
  const torn = new EvolutionMemory({ stateStore: tornStore, transaction: { persist: tornStore.update }, mutationAuthority: authority, hotEntries: 2 });
  await torn.load();
  assert.deepEqual(torn.history("observations").map((entry) => entry.id), ["cold-1"]);
  const tornFaults = torn.archiveIntegrity().observations ?? [];
  assert.deepEqual(tornFaults.map((fault) => fault.kind), ["torn-tail"]);
  const tornVerification = await torn.verifyConsistency();
  assert.ok(!tornVerification.reasons.includes("archive_bytes_unreadable"),
    "the active file's incomplete final line is the expected result of an interrupted append");

  const corruptHome = await scratch(t);
  const corruptPath = join(corruptHome, "state.json");
  const corruptArchive = `${corruptPath}.observations-archive.jsonl`;
  await writeFile(corruptArchive, [
    JSON.stringify(COLD),
    "{ corrupted mid-file line }",
    JSON.stringify({ id: "cold-3", recordedAt: "2026-01-01T00:00:02.000Z" }),
  ].join("\n") + "\n");
  const segmentDirectory = `${corruptArchive}.segments`;
  await mkdir(segmentDirectory, { recursive: true });
  await writeFile(join(segmentDirectory, "segment-000000000001.jsonl"), [
    JSON.stringify({ id: "sealed-1", recordedAt: "2026-01-01T00:00:00.000Z" }),
    "} corrupted sealed line {",
  ].join("\n") + "\n");
  const corruptStore = persistentStore(corruptPath, { evolution: { schema: 4, observations: [], coldArchives: {} } });
  const corrupt = new EvolutionMemory({ stateStore: corruptStore, transaction: { persist: corruptStore.update }, mutationAuthority: authority, hotEntries: 2 });
  await corrupt.load();
  assert.deepEqual(corrupt.history("observations").map((entry) => entry.id), ["sealed-1", "cold-1", "cold-3"],
    "parseable records keep their existing merge order");
  const kinds = (corrupt.archiveIntegrity().observations ?? []).map((fault) => fault.kind);
  assert.deepEqual(kinds.filter((kind) => kind === "invalid-line").length, 2,
    "both the active mid-file line and the sealed line must be reported");
  const verification = await corrupt.verifyConsistency();
  assert.ok(verification.reasons.includes("archive_bytes_unreadable"),
    `dropped bytes must surface as a degradation: ${JSON.stringify(verification.reasons)}`);
  assert.equal(verification.archive.degraded.length, 2);
});

test("P3-4: an archived row whose refresh failed is re-appended instead of dropped", async (t) => {
  const directory = await scratch(t);
  const filePath = join(directory, "state.json");
  const archive = `${filePath}.observations-archive.jsonl`;
  const stateStore = persistentStore(filePath, {});
  let failures = 0;
  const guard = async (file) => {
    if (failures > 0 && file === archive) { failures -= 1; throw new Error("EIO: simulated write failure"); }
  };
  const memory = new EvolutionMemory({
    stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority, hotEntries: 3, archiveWriteGuard: guard,
  });
  await memory.load();
  const seeded = [["o1", "one"], ["o2", "two"], ["o3", "three"], ["o4", "four"]];
  for (const [id, word] of seeded) await memory.recordObservation(observation(id, word));
  const archived = async () => (await readFile(archive, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));

  // The refresh of the archived row and the eviction that follows both fail.
  failures = 2;
  await memory.recordObservation(observation("o1", "replaced"));
  assert.ok(memory.snapshot().observations.some((entry) => entry.id === "o1" && entry.message === "replaced"),
    "the merged row must stay in the hot window while the archive refuses it");
  assert.equal(memory.archiveKnown.get("observations")?.has("id:o1"), false,
    "a key whose archived value is stale must not read as archived");
  assert.ok(memory.archiveIntegrity().observations?.some((fault) => fault.kind === "deferred-write"));

  // Once writes work again the next evictions must re-append the merged row.
  await memory.recordObservation(observation("o5", "five"));
  await memory.recordObservation(observation("o6", "six"));
  await memory.recordObservation(observation("o7", "seven"));
  assert.equal(memory.history("observations").find((entry) => entry.id === "o1").message, "replaced",
    "the archive must end up with the merged value");
  assert.deepEqual((await archived()).filter((entry) => entry.id === "o1").map((entry) => entry.message), ["one", "replaced"],
    "the repaired archive appends the merged row instead of overwriting bytes in place");
  assert.ok(!(memory.archiveIntegrity().observations ?? []).some((fault) => fault.kind === "deferred-write"),
    "a completed write resolves the deferred-write fault");

  const restarted = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority, hotEntries: 3 });
  await restarted.load();
  assert.equal(restarted.history("observations").find((entry) => entry.id === "o1").message, "replaced",
    "the merged value must survive a restart");
});

test("load can be asked to keep over-limit records hot instead of writing live archives", async (t) => {
  const directory = await scratch(t);
  const filePath = join(directory, "state.json");
  const archive = `${filePath}.observations-archive.jsonl`;
  const initial = {
    evolution: {
      schema: 4,
      observations: [observation("hot-1", "first"), observation("hot-2", "second"), observation("hot-3", "third")],
      coldArchives: { observations: { schema: 2, count: 0, file: archive, activeFile: archive, segments: [] } },
    },
  };
  const stateStore = persistentStore(filePath, initial);
  const deferred = new EvolutionMemory({
    stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority, hotEntries: 2, deferLoadArchiveWrites: true,
  });
  await deferred.load();
  assert.deepEqual(deferred.snapshot().observations.map((entry) => entry.id), ["hot-1", "hot-2", "hot-3"],
    "the deferred load keeps the over-limit records in the hot projection");
  assert.equal(await readFile(archive, "utf8").catch(() => null), null, "a deferred load writes no live archive");

  // The next mutation archives the deferred excess inside its own transaction.
  await deferred.recordObservation(observation("hot-4", "fourth"));
  assert.deepEqual((await readFile(archive, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line).id), ["hot-1", "hot-2"]);
  assert.deepEqual(deferred.snapshot().observations.map((entry) => entry.id), ["hot-3", "hot-4"]);
  assert.deepEqual(deferred.history("observations").map((entry) => entry.id), ["hot-1", "hot-2", "hot-3", "hot-4"]);

  // The default keeps the released behaviour: loading evicts and archives.
  const filePath2 = join(directory, "state2.json");
  const archive2 = `${filePath2}.observations-archive.jsonl`;
  const stateStore2 = persistentStore(filePath2, {
    evolution: {
      schema: 4,
      observations: [observation("hot-1", "first"), observation("hot-2", "second"), observation("hot-3", "third")],
      coldArchives: { observations: { schema: 2, count: 0, file: archive2, activeFile: archive2, segments: [] } },
    },
  });
  const eager = new EvolutionMemory({ stateStore: stateStore2, transaction: { persist: stateStore2.update }, mutationAuthority: authority, hotEntries: 2 });
  await eager.load();
  assert.deepEqual(eager.snapshot().observations.map((entry) => entry.id), ["hot-2", "hot-3"]);
  assert.deepEqual((await readFile(archive2, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line).id), ["hot-1"]);
});
