// Differential equivalence between the working tree and the pinned 0.2.1
// implementation, for the retention plan / compaction streaming change.
//
// The baseline side is the code shipped in `release/dsh-evolution-0.2.1.tgz`,
// extracted and imported at test time (see `retention-plan-streaming-support.mjs`);
// the candidate side is `lib/`. Both run over identical corpus bytes with a
// deterministic clock, and every observable the change could move is compared:
// the dry-run report, the disk bytes before and after it, three compaction
// reports, the full state projection, every file's sha256, the clock read count
// of each phase, and a fresh instance's read surfaces over the compacted tree.
//
// The full state projection is `JSON.stringify(fullSnapshot())` rather than a
// field-by-field assertion, so a field the plan starts or stops emitting fails
// here instead of being invisible.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EvolutionMemory } from "../../lib/dockyard-domain/memory.js";
import {
  AT,
  InjectableStore,
  advancingClock,
  archiveFileFor,
  cleanupPinnedMemory,
  createMemory,
  diskDigests,
  errorShape,
  importPinnedVariant,
  loadPinnedMemory,
  runInMemorySide,
  runStandardSide,
  seedCorpus,
  standardCorpus,
  stateDigest,
} from "./retention-plan-streaming-support.mjs";

const pinned = await loadPinnedMemory();
const homeRoot = await mkdtemp(join(tmpdir(), "dsh-retention-v021-diff-"));
after(async () => {
  await rm(homeRoot, { recursive: true, force: true });
  await cleanupPinnedMemory();
});

/** Compare the full report/state/byte/clock surface of one standard run. */
function assertEquivalentRun(before, after, label) {
  assert.deepEqual(after.dryRun, before.dryRun, `${label}: the dry-run report must be identical`);
  assert.deepEqual(after.first, before.first, `${label}: the first compaction report must be identical`);
  assert.deepEqual(after.second, before.second, `${label}: the second compaction report must be identical`);
  assert.deepEqual(after.third, before.third, `${label}: the third compaction report must be identical`);
  assert.equal(after.firstState, before.firstState, `${label}: the state after the first compaction must be identical`);
  assert.equal(after.secondState, before.secondState, `${label}: the state after the second compaction must be identical`);
  assert.equal(after.thirdState, before.thirdState, `${label}: the state after the third compaction must be identical`);
  assert.deepEqual(after.firstBytes, before.firstBytes, `${label}: every file after the first compaction must be byte-identical`);
  assert.deepEqual(after.secondBytes, before.secondBytes, `${label}: every file after the second compaction must be byte-identical`);
  assert.deepEqual(after.thirdBytes, before.thirdBytes, `${label}: every file after the third compaction must be byte-identical`);
  assert.deepEqual(after.bytesBeforeDryRun, before.bytesBeforeDryRun, `${label}: the corpus bytes must be identical`);
  assert.deepEqual(after.bytesAfterDryRun, before.bytesAfterDryRun, `${label}: the dry run must leave the same bytes`);
  assert.deepEqual(after.restartSurfaces, before.restartSurfaces, `${label}: a restarted instance must read back the same surfaces`);
  assert.deepEqual(after.restartBytes, before.restartBytes, `${label}: restarting must not rewrite the tree`);
  assert.deepEqual(after.clockReads, before.clockReads, `${label}: the clock read count of every phase must be identical`);
}

/** The corpus must actually reach the decisions the comparison relies on. */
function assertCorpusDecisions(run, label) {
  const report = run.first;
  assert.ok(report.retired > 0, `${label}: terminal rows must be retired`);
  assert.ok(report.consolidated > 0, `${label}: consolidatable rows must be consolidated`);
  assert.ok(report.aggregatedObservations > 0, `${label}: repeated observations must be aggregated`);
  assert.ok(report.tombstones > 0, `${label}: retirement must record tombstones`);
  assert.ok(report.knowledgeAfter > report.knowledgeBefore, `${label}: keyed source rows must grow the accumulator`);
  assert.ok(report.retainedCanonical >= 2, `${label}: the persisted canonical pointer and the derived winner must both be retained`);
  assert.ok(report.canonical >= 2, `${label}: the plan must emit the persisted and derived canonical entries`);
  assert.ok(report.afterBytes < report.beforeBytes, `${label}: compaction must shrink the cold tier`);
  assert.ok(Object.hasOwn(report.hotCollections, "knowledge"), `${label}: the compaction report must expose the hot window`);
  assert.ok(Object.keys(run.firstBytes).some((name) => name.includes(".segments/segment-")),
    `${label}: the corpus must seal at least one segment`);
  assert.deepEqual(run.dryRun.afterBytes, run.dryRun.beforeBytes, `${label}: a dry run must report no byte change`);
  assert.equal(run.dryRun.dryRun, true, `${label}: a dry-run report must say so`);
  assert.equal(report.dryRun, false, `${label}: a compaction report must say it wrote`);

  const tombstones = run.restartSurfaces.snapshot.tombstones;
  assert.ok(tombstones.some((tombstone) => tombstone.reason === "superseded" && tombstone.replacedBy),
    `${label}: canonical supersession must retire the replaced record`);
  assert.ok(tombstones.some((tombstone) => tombstone.reason === "duplicate"),
    `${label}: duplicate terminal candidates must be tombstoned`);
  assert.ok(tombstones.some((tombstone) => (tombstone.recordIds?.length ?? 0) >= 2 && Number(tombstone.count) >= 2),
    `${label}: two records sharing one tombstone identity must merge`);
  assert.ok(!tombstones.some((tombstone) => tombstone.recordId === "canonical-protected"),
    `${label}: a record named by the canonical table must not be tombstoned`);
  assert.ok(!tombstones.some((tombstone) => tombstone.recordId === "protected-ref"),
    `${label}: a referenced record must not be tombstoned`);
  assert.ok(!tombstones.some((tombstone) => tombstone.recordId === "lineage-latest"),
    `${label}: the latest generation of a lineage must not be tombstoned`);
  assert.ok(tombstones.some((tombstone) => tombstone.recordId === "terminal-opaque"),
    `${label}: an unreferenced terminal row must be tombstoned`);
  assert.ok(tombstones.some((tombstone) => tombstone.recordId === "lineage-old"),
    `${label}: a superseded older lineage generation must be tombstoned`);

  assert.ok(run.restartSurfaces.snapshot.diagnoses.some((row) => row.id === "canonical-protected"),
    `${label}: the canonically protected row must survive`);
  assert.ok(run.restartSurfaces.snapshot.gaps.some((row) => row.id === "protected-ref"),
    `${label}: the referenced row must survive`);
  assert.ok(run.restartSurfaces.snapshot.lineage.some((row) => row.id === "lineage-latest"),
    `${label}: the latest lineage generation must survive`);
  assert.ok(run.restartSurfaces.snapshot.knowledge.some((row) => (row.eventIds?.length ?? 0) >= 2),
    `${label}: a replayed event id must extend the accumulator's event window`);
  assert.ok(run.restartSurfaces.snapshot.knowledge.some((row) => (row.sourceRefs?.length ?? 0) >= 2),
    `${label}: a replayed source reference must extend the accumulator's reference window`);
  assert.ok(run.restartSurfaces.snapshot.cycles.some((row) => row.id === "cycle-99"),
    `${label}: the knowledge-bearing meaningful cycle must stay addressable`);
}

test("retention plan and compaction are byte-identical to the pinned 0.2.1 implementation", async (t) => {
  const home = join(homeRoot, "standard");
  await mkdir(home, { recursive: true });
  const before = await runStandardSide(pinned.EvolutionMemory, { home });
  assertCorpusDecisions(before, "baseline");
  // Compaction has to reach a fixed point rather than keep growing the
  // accumulator on every pass; the existing implementation needs a third pass.
  assert.equal(before.thirdState, before.secondState, "the third compaction must not change the state");
  assert.deepEqual(before.thirdBytes, before.secondBytes, "the third compaction must not change the bytes");
  assert.equal(before.third.knowledgeAfter, before.third.knowledgeBefore, "the accumulator must stop growing");

  const after = await runStandardSide(EvolutionMemory, { home });
  assertEquivalentRun(before, after, "standard corpus");
  t.diagnostic(`retired ${before.first.retired}, consolidated ${before.first.consolidated}, aggregated ${before.first.aggregatedObservations}, tombstones ${before.first.tombstones}, knowledge ${before.first.knowledgeBefore}->${before.first.knowledgeAfter}; ${Object.keys(before.firstBytes).length} files; clock reads ${JSON.stringify(before.clockReads)}`);
});

test("the same plan is byte-identical without an archive tier", async (t) => {
  // No file path means no archive: the plan runs over the in-memory partition
  // only, which is the other branch of every retention decision and of the
  // compaction write-back.
  const before = await runInMemorySide(pinned.EvolutionMemory);
  assert.ok(before.first.retired > 0, "the in-memory corpus must still retire");
  assert.ok(before.first.consolidated > 0, "the in-memory corpus must still consolidate");
  assert.ok(before.first.knowledgeAfter > before.first.knowledgeBefore, "the in-memory accumulator must still grow");
  assert.deepEqual(before.dryRun.afterBytes, before.dryRun.beforeBytes, "an in-memory dry run must report no byte change");

  const after = await runInMemorySide(EvolutionMemory);
  assert.deepEqual(after.dryRun, before.dryRun, "the in-memory dry-run report must be identical");
  assert.deepEqual(after.first, before.first, "the in-memory compaction report must be identical");
  assert.deepEqual(after.second, before.second, "the in-memory repeated report must be identical");
  assert.equal(after.firstState, before.firstState, "the in-memory state must be byte-identical");
  assert.equal(after.secondState, before.secondState, "the in-memory second compaction must leave the same state");
  assert.deepEqual(after.surfaces, before.surfaces, "the in-memory read surfaces must be identical");
  assert.deepEqual(after.clockReads, before.clockReads, "the in-memory clock read count must be identical");
  t.diagnostic(`in-memory: retired ${before.first.retired}, consolidated ${before.first.consolidated}, knowledge ${before.first.knowledgeBefore}->${before.first.knowledgeAfter}, clock reads ${JSON.stringify(before.clockReads)}`);
});

test("the plan's clock contract is unchanged under a per-call clock", async (t) => {
  // A clock that advances on every read turns a collapsed, reordered or extra
  // read into a different persisted timestamp: the derived knowledge stamps and
  // the archive index's wall-clock fields both move. Both sides must therefore
  // read the clock the same number of times in every phase, in the same order.
  const home = join(homeRoot, "advancing-clock");
  const before = await runStandardSide(pinned.EvolutionMemory, { home, clock: advancingClock() });
  assert.ok(before.clockReads.dryRun > 0, "the plan must read the clock");
  assert.ok(before.clockReads.first > 0, "the write phase must read the clock");
  const timeless = before.restartSurfaces.snapshot.knowledge
    .filter((row) => typeof row.firstSeen === "string" && row.firstSeen !== "2026-10-10T00:00:00.000Z")
    .map((row) => row.firstSeen);
  assert.equal(new Set(timeless).size >= 3, true,
    "each timeless row must be stamped by the clock read of its own row");

  const after = await runStandardSide(EvolutionMemory, { home, clock: advancingClock() });
  assertEquivalentRun(before, after, "advancing clock");
  t.diagnostic(`clock reads ${JSON.stringify(before.clockReads)}; timeless stamps ${JSON.stringify([...new Set(timeless)].slice(0, 5))}`);
});

// ---------------------------------------------------------------------------
// Corrupted durable input.
//
// The change touches the plan's reads and the compaction read-back. A damaged
// archive must still fail (or be planned around) exactly as before, and a failed
// compaction must leave the tree byte-identical.
// ---------------------------------------------------------------------------

const AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

async function restoreTreePermissions(home) {
  const stack = [home];
  while (stack.length) {
    const directory = stack.pop();
    // The directory may be the one that was made unreadable; restore it before
    // listing, and keep the recursion best-effort so cleanup never masks a failure.
    await chmod(directory, 0o700).catch(() => {});
    let entries = [];
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else await chmod(path, 0o600).catch(() => {});
    }
  }
}

const CORRUPTIONS = {
  "archive-invalid-line": {
    apply: async (store) => {
      const file = archiveFileFor(store, "observations");
      const lines = (await readFile(file, "utf8")).split("\n");
      lines.splice(2, 0, "{ not a json record");
      await writeFile(file, lines.join("\n"));
    },
  },
  "archive-torn-tail": {
    apply: async (store) => {
      const file = archiveFileFor(store, "observations");
      const text = await readFile(file, "utf8");
      const end = text.trimEnd().length;
      await writeFile(file, text.slice(0, end - 7));
    },
  },
  "archive-file-unreadable": {
    apply: async (store) => { await chmod(archiveFileFor(store, "observations"), 0o000); },
    deny: async (store) => { await chmod(archiveFileFor(store, "observations"), 0o000); },
  },
  "archive-index-unclassifiable": {
    apply: async (store) => {
      await writeFile(`${store.filePath}.evolution-archive-index.json`, "{\"schemaVersion\":1,\"segments\":[");
    },
  },
  "archive-segments-unreadable": {
    apply: async (store) => {
      const directory = `${archiveFileFor(store, "observations")}.segments`;
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "segment-000000000001.jsonl"), `${JSON.stringify({ id: "segment-row" })}\n`);
      await chmod(directory, 0o000);
    },
    deny: async (store) => { await chmod(`${archiveFileFor(store, "observations")}.segments`, 0o000); },
  },
};

/** Drive one implementation over one corrupted corpus and record the outcome. */
async function corruptionSide(MemoryClass, home, variant) {
  const store = await seedCorpus(home, standardCorpus());
  const corruption = CORRUPTIONS[variant];
  await corruption.apply(store);
  // The corrupted tree's bytes are only readable once the denial is lifted, so
  // record them there and re-apply the denial before the implementation runs.
  await restoreTreePermissions(home);
  const beforeLoadBytes = await diskDigests(home);
  if (corruption.deny) await corruption.deny(store);
  const memory = createMemory(MemoryClass, store);
  const result = { loadError: null, dryRun: null, dryRunError: null, compact: null, compactError: null };
  try { await memory.load(); } catch (error) { result.loadError = errorShape(error); }
  // Load legitimately reconciles and rewrites the archive index, so the bytes a
  // failed pass must not change are the bytes load left behind.
  result.beforeBytes = result.loadError ? beforeLoadBytes : await diskDigests(home);
  if (!result.loadError) {
    try { result.dryRun = await memory.compact({ dryRun: true }); } catch (error) { result.dryRunError = errorShape(error); }
    try { result.compact = await memory.compact(); } catch (error) { result.compactError = errorShape(error); }
  }
  result.snapshotDigest = result.loadError ? null : stateDigest(memory.fullSnapshot());
  await restoreTreePermissions(home);
  result.afterBytes = await diskDigests(home);
  return result;
}

test("corrupted durable input is handled identically and leaves the tree untouched", async (t) => {
  const expectations = {
    "archive-invalid-line": { load: null, dryRun: null, compact: "E_ARCHIVE_REWRITE_UNSAFE" },
    "archive-torn-tail": { load: null, dryRun: null, compact: "E_ARCHIVE_REWRITE_UNSAFE" },
    "archive-file-unreadable": { load: "EACCES" },
    "archive-index-unclassifiable": { load: "E_ARCHIVE_INDEX_STATE_UNKNOWN" },
    "archive-segments-unreadable": { load: "EACCES" },
  };
  for (const variant of Object.keys(CORRUPTIONS)) {
    await t.test(variant, async (subtest) => {
      if (AS_ROOT && variant.includes("unreadable")) {
        subtest.diagnostic("skipped: permission denials are not enforced for root");
        return;
      }
      const home = join(homeRoot, `corrupt-${variant}`);
      const before = await corruptionSide(pinned.EvolutionMemory, home, variant);
      const expected = expectations[variant];
      assert.equal(before.loadError?.code ?? null, expected.load ?? null,
        `${variant}: the baseline load outcome must be the documented one`);
      if (expected.load) {
        assert.equal(before.dryRun, null, `${variant}: an unloadable tree must not reach a dry run`);
        assert.equal(before.compact, null, `${variant}: an unloadable tree must not reach a compaction`);
      } else {
        assert.equal(before.dryRunError?.code ?? null, expected.dryRun ?? null,
          `${variant}: the baseline dry-run outcome must be the documented one`);
        assert.equal(before.compactError?.code ?? null, expected.compact ?? null,
          `${variant}: the baseline compaction outcome must be the documented one`);
      }
      assert.deepEqual(before.afterBytes, before.beforeBytes,
        `${variant}: the failed pass must leave every file as load left it`);

      const after = await corruptionSide(EvolutionMemory, home, variant);
      assert.deepEqual(after, before, `${variant}: the corrupted-input outcome must be identical`);
      subtest.diagnostic(`${variant}: load ${before.loadError?.code ?? "ok"}, dry run ${before.dryRunError?.code ?? "ok"}, compact ${before.compactError?.code ?? "ok"}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Write-failure rollback.
//
// Compaction installs staged archives before it saves state. A failure after that
// point must restore the pre-plan state and the pre-plan bytes, and a retry must
// then produce exactly what a clean run produces. Two failure points are
// injected: the state write after the archive rewrite, and an unwritable archive
// directory inside the rewrite (so the staged layout never publishes).
// ---------------------------------------------------------------------------

function injectedStateWriteFailure() {
  const error = new Error("E_INJECTED_STATE_WRITE: injected state write failure");
  error.code = "E_INJECTED_STATE_WRITE";
  return error;
}

async function stateWriteFailureSide(MemoryClass, home) {
  const store = await seedCorpus(home, standardCorpus(), { StoreClass: InjectableStore });
  const memory = createMemory(MemoryClass, store);
  await memory.load();
  // The plan's housekeeping is part of every plan, including the failed one, so
  // the state a rollback restores is the state the plan left behind - the same
  // state a dry run leaves. Capture the bytes before any plan and the state after
  // a dry run, then require the failed compaction to restore exactly that.
  const beforeBytes = await diskDigests(home);
  await memory.compact({ dryRun: true });
  const beforeState = stateDigest(memory.fullSnapshot());

  store.failNextUpdate = injectedStateWriteFailure();
  let error = null;
  try { await memory.compact(); } catch (caught) { error = errorShape(caught); }
  const failedBytes = await diskDigests(home);
  const failedState = stateDigest(memory.fullSnapshot());

  const recovery = await memory.compact();
  const recoveryState = stateDigest(memory.fullSnapshot());
  const recoveryBytes = await diskDigests(home);
  const second = await memory.compact();
  const secondState = stateDigest(memory.fullSnapshot());
  const secondBytes = await diskDigests(home);
  const third = await memory.compact();
  return {
    error, beforeState, failedState, recovery, second, third,
    recoveryState, secondState,
    beforeBytes, failedBytes, recoveryBytes,
    secondBytes,
    thirdState: stateDigest(memory.fullSnapshot()),
    thirdBytes: await diskDigests(home),
  };
}

async function archiveWriteFailureSide(MemoryClass, home) {
  const store = await seedCorpus(home, standardCorpus());
  const memory = createMemory(MemoryClass, store);
  await memory.load();
  const beforeBytes = await diskDigests(home);
  await memory.compact({ dryRun: true });
  const beforeState = stateDigest(memory.fullSnapshot());
  const directory = join(home, ".dockyard-dsh");
  await chmod(directory, 0o500);
  let error = null;
  try { await memory.compact(); } catch (caught) { error = errorShape(caught); }
  await chmod(directory, 0o700);
  const failedBytes = await diskDigests(home);
  const failedState = stateDigest(memory.fullSnapshot());

  const recovery = await memory.compact();
  const recoveryState = stateDigest(memory.fullSnapshot());
  const recoveryBytes = await diskDigests(home);
  return { error, beforeState, failedState, recovery, recoveryState, beforeBytes, failedBytes, recoveryBytes };
}

test("a failed compaction rolls back to the pre-plan state and bytes, and the retry converges", async (t) => {
  await t.test("state write fails after the archive rewrite", async (subtest) => {
    const home = join(homeRoot, "rollback-state-write");
    const before = await stateWriteFailureSide(pinned.EvolutionMemory, home);
    assert.equal(before.error?.code, "E_INJECTED_STATE_WRITE", "the injected state write failure must reach the caller");
    assert.deepEqual(before.failedBytes, before.beforeBytes, "the rollback must restore every staged archive and the index");
    assert.equal(before.failedState, before.beforeState, "the rollback must restore the in-memory state");
    assert.ok(before.recovery.retired > 0, "the retry must do the work the failed pass rolled back");

    const after = await stateWriteFailureSide(EvolutionMemory, home);
    assert.deepEqual(after, before, "the state-write failure outcome must be identical");
    assert.equal(before.thirdState, before.secondState, "the retry must reach the same fixed point");
    assert.deepEqual(before.thirdBytes, before.secondBytes, "the retry's fixed point must also hold on disk");
    subtest.diagnostic(`retired ${before.recovery.retired}, files ${Object.keys(before.recoveryBytes).length}`);
  });

  await t.test("archive directory is unwritable inside the rewrite", async (subtest) => {
    const home = join(homeRoot, "rollback-archive-write");
    const before = await archiveWriteFailureSide(pinned.EvolutionMemory, home);
    assert.equal(before.error?.code, "EACCES", "the unwritable archive directory must fail the rewrite");
    assert.deepEqual(before.failedBytes, before.beforeBytes, "a rewrite that never published must leave the bytes untouched");
    assert.equal(before.failedState, before.beforeState, "a rewrite that never published must leave the state untouched");
    assert.ok(before.recovery.retired > 0, "the retry after the permission is restored must compact");

    const after = await archiveWriteFailureSide(EvolutionMemory, home);
    assert.deepEqual(after, before, "the archive-write failure outcome must be identical");
    subtest.diagnostic(`retired ${before.recovery.retired}, rollback error ${before.error?.rollbackErrorCode ?? "none"}`);
  });
});

// ---------------------------------------------------------------------------
// Concurrency and lock boundaries.
//
// `compact()` serializes through the mutation queue and waits for outstanding
// archive appends before it plans. Re-entry while that wait is outstanding must
// be reported the same way, and a rejected wait must propagate instead of being
// swallowed.
// ---------------------------------------------------------------------------

async function reentrySide(MemoryClass, home) {
  const store = await seedCorpus(home, standardCorpus());
  const memory = createMemory(MemoryClass, store);
  await memory.load();
  const loadedBytes = await diskDigests(home);
  const loadedState = stateDigest(memory.fullSnapshot());

  const gate = Promise.withResolvers();
  memory.archiveWriting = gate.promise;
  const firstPromise = memory.compact();
  let spins = 0;
  while (!memory.compacting && spins < 5000) {
    await new Promise((resolve) => setImmediate(resolve));
    spins += 1;
  }
  const suspended = {
    reentered: memory.compacting === true,
    spins,
    bytes: await diskDigests(home),
    state: stateDigest(memory.fullSnapshot()),
  };
  const maintenance = await memory.maintenance({ force: true });
  const queuedDryRunPromise = memory.compact({ dryRun: true });
  gate.resolve();
  const [first, queuedDryRun] = await Promise.all([firstPromise, queuedDryRunPromise]);
  const firstState = stateDigest(memory.fullSnapshot());
  const firstBytes = await diskDigests(home);

  // A rejected append wait must reject the compaction and leave the tree alone.
  const secondHome = home;
  const rejection = new Error("E_INJECTED_ARCHIVE_WAIT: injected archive append wait rejection");
  rejection.code = "E_INJECTED_ARCHIVE_WAIT";
  const rejected = Promise.reject(rejection);
  rejected.catch(() => {});
  memory.archiveWriting = rejected;
  const stateBeforeRejected = stateDigest(memory.fullSnapshot());
  const bytesBeforeRejected = await diskDigests(secondHome);
  let waitError = null;
  try { await memory.compact(); } catch (caught) { waitError = errorShape(caught); }
  const bytesAfterRejected = await diskDigests(secondHome);
  const stateAfterRejected = stateDigest(memory.fullSnapshot());
  memory.archiveWriting = Promise.resolve();
  const recovery = await memory.compact();

  return {
    loadedBytes, loadedState, suspended, maintenance, first, queuedDryRun,
    firstState, firstBytes,
    waitError, stateBeforeRejected, stateAfterRejected, bytesBeforeRejected, bytesAfterRejected,
    recovery, recoveryState: stateDigest(memory.fullSnapshot()),
    recoveryBytes: await diskDigests(secondHome),
  };
}

test("compaction re-entry and archive-append waiting behave identically", async (t) => {
  const home = join(homeRoot, "reentry");
  const before = await reentrySide(pinned.EvolutionMemory, home);
  assert.equal(before.suspended.reentered, true, "the compaction must be suspended inside the append wait");
  assert.equal(before.maintenance.skipped, "already-compacting", "a forced maintenance during compaction must report the lock");
  assert.deepEqual(before.suspended.bytes, before.loadedBytes, "a suspended compaction must not have written anything yet");
  assert.equal(before.suspended.state, before.loadedState, "a suspended compaction must not have planned yet");
  assert.equal(before.queuedDryRun.dryRun, true, "the queued dry run must still be a dry run");
  assert.ok(before.queuedDryRun.beforeBytes > 0, "the queued dry run must observe the compacted tree");
  assert.ok(before.first.retired > 0, "the suspended compaction must do the work after the wait is released");
  assert.equal(before.waitError?.code, "E_INJECTED_ARCHIVE_WAIT", "the rejected append wait must reject the compaction");
  assert.equal(before.stateAfterRejected, before.stateBeforeRejected, "a rejected append wait must leave the state untouched");
  assert.deepEqual(before.bytesAfterRejected, before.bytesBeforeRejected, "a rejected append wait must leave the bytes untouched");
  assert.equal(before.recovery.dryRun, false, "a compaction after the rejected wait must run to completion");

  const after = await reentrySide(EvolutionMemory, home);
  assert.deepEqual(after, before, "the re-entry and append-wait outcomes must be identical");
  t.diagnostic(`suspended after ${before.suspended.spins} ticks; waiting dry run ${JSON.stringify({ beforeBytes: before.queuedDryRun.beforeBytes, afterBytes: before.queuedDryRun.afterBytes })}`);
});

// ---------------------------------------------------------------------------
// A persisted tombstone table can make the merge evaluation itself throw.
//
// The dry-run change replaced the plan's tombstone map with an id set, so it can
// skip building the written rows. The merge of two tombstones with the same id is
// not only output materialisation: it spreads the previous row's `recordIds`, and
// a persisted (JSON-valid) object there makes that spread throw a TypeError. A
// dry run that skips the merge reports a plan the write path cannot execute, and
// absorbs the failure the real compaction still raises. Both must throw the same
// error, and the failed dry run must not touch the tree.
// ---------------------------------------------------------------------------

/** The standard corpus plus a persisted tombstone whose `recordIds` is an object. */
function tombstoneMergeCorpus() {
  const rows = standardCorpus();
  rows.diagnoses = [
    ...rows.diagnoses,
    {
      id: "tombstone-merge-target",
      lifecycleState: "REJECTED",
      note: "terminal row with a controlled tombstone identity",
      fingerprint: "fp:s1-tombstone-merge",
      recordedAt: AT,
    },
  ];
  rows.tombstones = [{
    id: "tombstone:fp:s1-tombstone-merge",
    state: "TOMBSTONE",
    retention: "TOMBSTONE",
    fingerprint: "fp:s1-tombstone-merge",
    recordId: "older-tombstoned-record",
    // A JSON object is a legal durable value and is not iterable.
    recordIds: { not: "an array" },
    count: 1,
    firstSeen: AT,
    lastSeen: AT,
  }];
  return rows;
}

async function tombstoneMergeSide(MemoryClass, home) {
  const store = await seedCorpus(home, tombstoneMergeCorpus(), { StoreClass: InjectableStore });
  const memory = createMemory(MemoryClass, store);
  await memory.load();
  const beforeBytes = await diskDigests(home);
  let dryRunError = null;
  try { await memory.compact({ dryRun: true }); } catch (error) { dryRunError = errorShape(error); }
  const afterDryRunBytes = await diskDigests(home);
  let compactError = null;
  try { await memory.compact(); } catch (error) { compactError = errorShape(error); }
  const afterCompactBytes = await diskDigests(home);
  return { beforeBytes, afterDryRunBytes, afterCompactBytes, dryRunError, compactError };
}

test("a tombstone merge that throws is evaluated identically by a dry run and a write", async (t) => {
  const home = join(homeRoot, "tombstone-merge-evaluation");
  const before = await tombstoneMergeSide(pinned.EvolutionMemory, home);
  assert.ok(before.dryRunError, "the pinned implementation's dry run must raise the merge failure");
  assert.ok(before.compactError, "the pinned implementation's compaction must raise the merge failure");
  assert.deepEqual(before.afterDryRunBytes, before.beforeBytes,
    "the failed dry run must leave every file byte-identical");

  const after = await tombstoneMergeSide(EvolutionMemory, home);
  assert.ok(after.dryRunError, "the candidate's dry run must raise the same merge failure");
  assert.equal(after.dryRunError.name, before.dryRunError.name,
    "the dry run must raise the same class of error");
  assert.equal(after.dryRunError.message, before.dryRunError.message,
    "the dry run must raise the same error the write path would");
  assert.deepEqual(after.compactError, before.compactError,
    "the compaction outcome must be identical");
  assert.deepEqual(after.afterDryRunBytes, before.afterDryRunBytes,
    "the failed dry run must leave identical bytes on both sides");
  assert.deepEqual(after.beforeBytes, before.beforeBytes, "the persisted corpus bytes must be identical");
  assert.deepEqual(after.afterCompactBytes, before.afterCompactBytes,
    "the failed compaction must leave identical bytes on both sides");
  t.diagnostic(`tombstone merge: ${before.dryRunError.name}: ${before.dryRunError.message.slice(0, 120)}`);
});

// ---------------------------------------------------------------------------
// Negative control.
//
// A differential that compares nothing passes forever. This seeds one semantic
// difference into the pinned bytes (never into the working tree) and requires
// the same comparison helper the real test uses to reject it.
// ---------------------------------------------------------------------------

test("the differential detects a seeded behavioral difference in the baseline", async (t) => {
  const home = join(homeRoot, "negative-control");
  const mutationMarker = "retired: 0,";
  const MutatedMemory = await importPinnedVariant((source) => {
    assert.equal(source.split(mutationMarker).length - 1, 1,
      "the negative-control mutation must match the pinned source exactly once");
    return source.replace(mutationMarker, "retired: 2,");
  });
  const before = await runStandardSide(pinned.EvolutionMemory, { home });
  const mutated = await runStandardSide(MutatedMemory, { home });
  assert.throws(() => assertEquivalentRun(before, mutated, "seeded mutation"), /seeded mutation/,
    "the comparison helper must reject a report that differs");
  assert.notEqual(mutated.dryRun.retired, before.dryRun.retired,
    "the seeded difference must actually reach the compared report");
  t.diagnostic(`seeded mutation detected: dry-run retired ${before.dryRun.retired} vs ${mutated.dryRun.retired}`);
});
