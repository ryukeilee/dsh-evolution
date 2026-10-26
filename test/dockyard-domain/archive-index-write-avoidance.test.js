// The archive index is derived data and is rewritten only when its content
// changes. `#reconcileActiveArchive()` stamps `updatedAt` from the clock on
// every load, so a comparison that included that stamp rewrote the whole index
// document on every load - a durable write on a read-only path, and a changed
// staged file that the domain transaction then fsyncs and installs.
//
// These cases pin both halves: unchanged bytes leave the document alone, and
// every real repair still rewrites it.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { appendFile, link, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { EvolutionMemory } from "../../lib/dockyard-domain/memory.js";
import { JsonStateStore } from "./support.js";

const ROWS = [
  { id: "obs-1", patternKey: "pattern-a", type: "agent/error", severity: "error", observedAt: "2026-10-10T00:00:00.000Z", message: "first" },
  { id: "obs-2", patternKey: "pattern-b", type: "agent/error", severity: "error", observedAt: "2026-10-10T00:00:01.000Z", message: "second" },
  { id: "obs-3", patternKey: "pattern-c", type: "agent/error", severity: "error", observedAt: "2026-10-10T00:00:02.000Z", message: "third" },
];

/** A clock that advances one millisecond per read: the production condition,
 *  made deterministic instead of depending on millisecond resolution. */
function advancingClock() {
  let millis = Date.parse("2026-10-12T00:00:00.000Z");
  return () => new Date(millis++);
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "dsh-archive-index-write-avoidance-"));
  const store = new JsonStateStore({ home });
  const archive = `${store.filePath}.observations-archive.jsonl`;
  await mkdir(dirname(archive), { recursive: true });
  await writeFile(archive, `${ROWS.map(row => JSON.stringify(row)).join("\n")}\n`);
  return { home, store, archive, index: `${store.filePath}.evolution-archive-index.json` };
}

async function load(store, clock) {
  const memory = new EvolutionMemory({ stateStore: store, clock, hotEntries: 1 });
  memory.setMutationAuthority({ assertMutation() {}, isActive: () => true });
  await memory.load({ snapshot: false });
  return memory;
}

async function entries(file) {
  const document = JSON.parse(await readFile(file, "utf8"));
  assert.equal(document.schemaVersion, 1);
  return document.segments;
}

/** Identity of the index document: a rewrite replaces the file atomically, so a
 *  changed inode is exactly "the document was written again" - as long as the
 *  recorded inode is still allocated. The identity is taken before a load that
 *  may repair the document, and the repair replaces it through a rename, so the
 *  number recorded here is freed before the replacement is created; the
 *  filesystem may then hand that same number to the replacement and the
 *  comparison reports "same document" for a document that was written again.
 *  (CI run 40048818467 hit exactly that on ext4, after the test below replaced
 *  the index itself and freed the number it had recorded.) A hard link keeps
 *  the recorded inode allocated for as long as the identity is held, so a
 *  replacement has to show a different number. */
async function indexIdentity(file) {
  const guard = `${file}.identity`;
  await rm(guard, { force: true });
  await link(file, guard);
  return { ino: (await stat(guard)).ino, bytes: await readFile(file, "utf8") };
}

test("loading unchanged archive bytes does not rewrite the index document", async () => {
  const { home, store, archive, index } = await fixture();
  const clock = advancingClock();
  try {
    await load(store, clock);
    const before = await indexIdentity(index);
    const [entry] = await entries(index);
    assert.equal(entry.logicalCount, ROWS.length);
    assert.equal(entry.physicalCount, ROWS.length);
    assert.equal(entry.byteSize, (await stat(archive)).size);

    // Every load reads the clock again, so `updatedAt` differs on each pass.
    // The bytes did not change, so the document must not be written again.
    for (let pass = 0; pass < 3; pass++) await load(store, clock);
    const after = await indexIdentity(index);
    assert.equal(after.ino, before.ino, "an unchanged load must not replace the index document");
    assert.equal(after.bytes, before.bytes, "an unchanged load must not change the index bytes");
    assert.deepEqual(await entries(index), [entry]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("an append to an active archive still rewrites and extends its index entry", async () => {
  const { home, store, archive, index } = await fixture();
  const clock = advancingClock();
  try {
    await load(store, clock);
    const before = await indexIdentity(index);
    const [entryBefore] = await entries(index);
    await appendFile(archive, `${JSON.stringify({ id: "obs-4", patternKey: "pattern-a", type: "agent/error", severity: "error", observedAt: "2026-10-10T00:00:03.000Z", message: "fourth" })}\n`);
    await load(store, clock);
    const after = await indexIdentity(index);
    assert.notEqual(after.ino, before.ino, "a changed active archive must be re-indexed");
    const [entryAfter] = await entries(index);
    assert.equal(entryAfter.logicalCount, entryBefore.logicalCount + 1);
    assert.equal(entryAfter.physicalCount, entryBefore.physicalCount + 1);
    assert.equal(entryAfter.byteSize, (await stat(archive)).size);
    assert.notEqual(entryAfter.updatedAt, entryBefore.updatedAt);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a changed sealed segment keeps its original expectation through repeated loads", async () => {
  const { home, store, archive, index } = await fixture();
  const clock = advancingClock();
  try {
    const segment = `${archive}.segments/segment-000000000001.jsonl`;
    await mkdir(dirname(segment), { recursive: true });
    await writeFile(segment, `${JSON.stringify({ id: "sealed-1", recordedAt: "2026-10-09T00:00:00.000Z" })}\n`);
    const firstMemory = await load(store, clock);
    const sealedBefore = (await entries(index)).find(entry => entry.sealed === true);
    assert.ok(sealedBefore, "the sealed segment must be indexed");
    assert.equal(sealedBefore.checksumState, "final");
    const indexBefore = await readFile(index);

    const changedBytes = Buffer.from(`${JSON.stringify({ id: "sealed-1", recordedAt: "2026-10-09T00:00:00.000Z" })}\n${JSON.stringify({ id: "sealed-2", recordedAt: "2026-10-09T00:00:01.000Z" })}\n`);
    await writeFile(segment, changedBytes);
    await firstMemory.load({ snapshot: false });
    const secondMemory = await load(store, clock);
    const thirdMemory = await load(store, clock);

    for (const memory of [secondMemory, thirdMemory]) {
      const sealedAfter = (await entries(index)).find(entry => entry.sealed === true);
      assert.equal(sealedAfter.byteSize, sealedBefore.byteSize, "the original expected size remains durable");
      assert.equal(sealedAfter.sha256, sealedBefore.sha256, "the original expected digest remains durable");
      assert.equal(sealedAfter.physicalCount, sealedBefore.physicalCount, "indexed counts do not follow untrusted bytes");
      const verification = await memory.verifyConsistency();
      assert.equal(verification.valid, false);
      assert.ok(verification.archive.mismatched.some((entry) => entry.reason === "byte_size"));
      assert.ok(verification.archive.mismatched.some((entry) => entry.reason === "checksum"));
      assert.deepEqual(await readFile(segment), changedBytes, "loading never rewrites the changed archive bytes");
    }
    assert.deepEqual(await readFile(index), indexBefore, "the index document retains the original expected digest and size");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("an unparseable lengthened sealed segment keeps its original expectation", async () => {
  const { home, store, archive, index } = await fixture();
  const clock = advancingClock();
  try {
    const segment = `${archive}.segments/segment-000000000001.jsonl`;
    await mkdir(dirname(segment), { recursive: true });
    await writeFile(segment, `${JSON.stringify({ id: "sealed-1", recordedAt: "2026-10-09T00:00:00.000Z" })}\n`);
    await load(store, clock);
    const sealedBefore = (await entries(index)).find(entry => entry.sealed === true);
    const changedBytes = Buffer.concat([await readFile(segment), Buffer.from('{"id":"unparseable","payload":\n')]);
    await writeFile(segment, changedBytes);

    await load(store, clock);
    const sealedAfter = (await entries(index)).find(entry => entry.sealed === true);
    assert.equal(sealedAfter.sha256, sealedBefore.sha256);
    assert.equal(sealedAfter.byteSize, sealedBefore.byteSize);
    assert.deepEqual(await readFile(segment), changedBytes);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("sealed files without a usable expectation retain the established hash-recovery path", async () => {
  const variants = ["missing-entry", "non-final-checksum", "invalid-digest", "unsafe-byte-size"];
  for (const variant of variants) {
    const { home, store, archive, index } = await fixture();
    const clock = advancingClock();
    try {
      const segment = `${archive}.segments/segment-000000000001.jsonl`;
      await mkdir(dirname(segment), { recursive: true });
      await writeFile(segment, `${JSON.stringify({ id: "sealed-1", recordedAt: "2026-10-09T00:00:00.000Z" })}\n`);
      await load(store, clock);
      const originalEntry = (await entries(index)).find(entry => entry.sealed === true);
      if (variant === "missing-entry") assert.ok(originalEntry, "the test began from a valid expectation before removing its entry");
      const changedBytes = Buffer.from(`${await readFile(segment, "utf8")}${JSON.stringify({ id: "sealed-2", recordedAt: "2026-10-09T00:00:01.000Z" })}\n`);
      await writeFile(segment, changedBytes);
      const document = JSON.parse(await readFile(index, "utf8"));
      const target = document.segments.find(entry => entry.sealed === true);
      if (variant === "missing-entry") document.segments = document.segments.filter(entry => entry !== target);
      if (variant === "non-final-checksum") target.checksumState = "provisional";
      if (variant === "invalid-digest") target.sha256 = `${target.sha256}deadbeef`;
      if (variant === "unsafe-byte-size") target.byteSize = Number.MAX_SAFE_INTEGER + 1;
      await writeFile(index, JSON.stringify(document));

      await load(store, clock);
      const recovered = (await entries(index)).find(entry => entry.sealed === true);
      assert.equal(recovered.sha256, createHash("sha256").update(changedBytes).digest("hex"), `${variant}: recovery hashes current bytes`);
      assert.equal(recovered.byteSize, changedBytes.length, `${variant}: recovery records current size`);
      assert.equal(recovered.physicalCount, 2, `${variant}: recovery indexes current line count`);
      assert.deepEqual(await readFile(segment), changedBytes);
    } finally { await rm(home, { recursive: true, force: true }); }
  }
});

test("a sealed entry that names only its file is normalized without re-reading the bytes", async () => {
  const { home, store, archive, index } = await fixture();
  const clock = advancingClock();
  try {
    const segment = `${archive}.segments/segment-000000000001.jsonl`;
    await mkdir(dirname(segment), { recursive: true });
    await writeFile(segment, `${JSON.stringify({ id: "sealed-1", recordedAt: "2026-10-09T00:00:00.000Z" })}\n`);
    await load(store, clock);
    const before = await indexIdentity(index);
    const sealedBefore = (await entries(index)).find(entry => entry.sealed === true);
    assert.ok(sealedBefore);

    // An older document may name only the file. The sealed entry is accepted by
    // size without re-reading the bytes, so its missing `collection` has to be
    // reported by the shape check instead of by a re-hash.
    const document = JSON.parse(await readFile(index, "utf8"));
    const stripped = document.segments.map(entry => {
      if (entry.sealed !== true) return entry;
      const { collection, ...rest } = entry;
      return rest;
    });
    await writeFile(`${index}.tmp`, JSON.stringify({ ...document, segments: stripped }));
    await rename(`${index}.tmp`, index);

    await load(store, clock);
    const after = await indexIdentity(index);
    assert.notEqual(after.ino, before.ino, "a sealed entry missing its collection must be normalized");
    const sealedAfter = (await entries(index)).find(entry => entry.sealed === true);
    assert.equal(sealedAfter.collection, "observations");
    assert.equal(sealedAfter.file, "segment-000000000001.jsonl");
    assert.equal(sealedAfter.sha256, sealedBefore.sha256, "normalizing the entry must not change its recorded digest");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("an index identity survives a replacement that frees the inode it recorded", async () => {
  const { home, store, index } = await fixture();
  const clock = advancingClock();
  try {
    await load(store, clock);
    const before = await indexIdentity(index);
    // The sealed-entry case above replaces the document twice: first in the
    // fixture, then in the repair. This test checks the prerequisite for a
    // reliable identity across those replacements: the first rename must not
    // free the recorded inode for reuse by the second.
    assert.equal((await stat(index)).ino, before.ino);
    assert.equal((await stat(index)).nlink, 2, "an identity must keep the inode it recorded allocated");
    await writeFile(`${index}.replacement`, JSON.stringify({ schemaVersion: 1, updatedAt: "replacement", segments: [] }));
    await rename(`${index}.replacement`, index);
    assert.notEqual((await stat(index)).ino, before.ino, "a replacement must be reported as a different document");

    const after = await indexIdentity(index);
    assert.notEqual(after.ino, before.ino);
    assert.equal(after.bytes, await readFile(index, "utf8"));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a corrupted index entry is still repaired on the next load", async () => {
  const { home, store, index } = await fixture();
  const clock = advancingClock();
  try {
    await load(store, clock);
    const document = JSON.parse(await readFile(index, "utf8"));
    document.segments[0] = { ...document.segments[0], logicalCount: 999, physicalCount: 999, byteSize: 999 };
    await writeFile(`${index}.tmp`, JSON.stringify(document));
    await rename(`${index}.tmp`, index);

    await load(store, clock);
    const [repaired] = await entries(index);
    assert.equal(repaired.logicalCount, ROWS.length);
    assert.equal(repaired.physicalCount, ROWS.length);
    assert.notEqual(repaired.byteSize, 999);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("an index written with a different key order is not treated as a change", async () => {
  const { home, store, index } = await fixture();
  const clock = advancingClock();
  try {
    await load(store, clock);
    const document = JSON.parse(await readFile(index, "utf8"));
    // Same content, different member order: the comparison must not depend on
    // the order the document happened to be written in.
    const reversed = document.segments.map(entry => Object.fromEntries(Object.entries(entry).reverse()));
    await writeFile(`${index}.tmp`, JSON.stringify({ ...document, segments: reversed }));
    await rename(`${index}.tmp`, index);
    const before = await indexIdentity(index);

    await load(store, clock);
    const after = await indexIdentity(index);
    assert.equal(after.ino, before.ino, "a reordered but equal entry must not trigger a rewrite");
    assert.equal(after.bytes, before.bytes);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a missing index is still written on the first load", async () => {
  const { home, store, index } = await fixture();
  const clock = advancingClock();
  try {
    await assert.rejects(stat(index), /ENOENT/);
    await load(store, clock);
    assert.deepEqual((await entries(index)).map(entry => entry.collection), ["observations"]);
  } finally { await rm(home, { recursive: true, force: true }); }
});
