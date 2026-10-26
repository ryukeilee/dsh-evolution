import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { EvolutionMemory } from "../../lib/dockyard-domain/memory.js";
import { JsonStateStore } from "./support.js";

const COLLECTIONS = ["observations", "proposals", "cycles"];
const SEGMENTED_COLLECTIONS = ["observations", "cycles"];
const NOW = "2026-10-20T00:00:00.000Z";
const require = createRequire(import.meta.url);
const fsp = require("node:fs/promises");

function rowsFor(collection, count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${collection}-${index}`,
    recordedAt: NOW,
    payload: "x".repeat(80),
  }));
}

async function openMemory(home, { counts = 12, store = null, seed = true, collections = COLLECTIONS } = {}) {
  const stateStore = store ?? new JsonStateStore({ home });
  const memory = new EvolutionMemory({
    stateStore,
    clock: () => new Date(NOW),
    maxEntries: 1000,
    hotEntries: 2,
    hotCycles: 2,
    archiveMaxBytes: 512,
    absoluteMaxSegmentBytes: 4096,
  });
  memory.setMutationAuthority({ assertMutation() {}, isActive: () => true });
  if (seed) {
    await mkdir(join(home, ".dockyard-dsh"), { recursive: true });
    await writeFile(stateStore.filePath, JSON.stringify({ evolution: Object.fromEntries(
      collections.map((collection) => [collection, rowsFor(collection, counts)]),
    ) }), { mode: 0o600 });
  }
  await memory.load();
  return { memory, stateStore };
}

async function fileDigests(root) {
  const output = {};
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else output[relative(root, path)] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
  }
  await visit(root);
  return Object.fromEntries(Object.entries(output).sort(([a], [b]) => a.localeCompare(b)));
}

async function archiveBytes(root) {
  const output = {};
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/-archive\.jsonl(?:$|\.segments\/)/.test(relative(root, path))) output[relative(root, path)] = await readFile(path);
    }
  }
  await visit(root);
  return Object.fromEntries(Object.entries(output).sort(([a], [b]) => a.localeCompare(b)));
}

async function withArchiveWriteProbe(run, { partialFailure = null } = {}) {
  const originalAppendFile = fsp.appendFile;
  const originalWriteFile = fsp.writeFile;
  const calls = { appendFile: 0, writeFile: 0 };
  let active = true;
  let injected = false;
  fsp.appendFile = async function (...args) {
    if (active && String(args[0]).includes(".compact-")) calls.appendFile += 1;
    return originalAppendFile.apply(this, args);
  };
  fsp.writeFile = async function (...args) {
    if (active && String(args[0]).includes(".compact-")) calls.writeFile += 1;
    if (!injected && partialFailure && String(args[0]).includes(".compact-") && Buffer.byteLength(args[1]) > 0) {
      injected = true;
      const partial = Buffer.from(args[1]).subarray(0, 37);
      await originalWriteFile.call(this, args[0], partial, ...args.slice(2));
      throw partialFailure;
    }
    return originalWriteFile.apply(this, args);
  };
  syncBuiltinESMExports();
  try {
    return await run(calls);
  } finally {
    active = false;
    fsp.appendFile = originalAppendFile;
    fsp.writeFile = originalWriteFile;
    syncBuiltinESMExports();
  }
}

async function archiveSegmentIds(home, collection) {
  const archive = collection === "cycles" ? "state.json.cycles-archive.jsonl" : `state.json.${collection}-archive.jsonl`;
  const directory = join(home, ".dockyard-dsh", `${archive}.segments`);
  const names = (await readdir(directory)).filter((name) => /^segment-[0-9]+\.jsonl$/.test(name)).sort();
  const ids = [];
  for (const name of names) {
    const path = join(directory, name);
    const raw = await readFile(path, "utf8");
    assert.ok(Buffer.byteLength(raw) <= 512, `${name} stays within archiveMaxBytes`);
    for (const line of raw.split("\n").filter(Boolean)) ids.push(JSON.parse(line).id);
  }
  const activePath = join(home, ".dockyard-dsh", archive);
  const active = await readFile(activePath, "utf8");
  assert.ok(Buffer.byteLength(active) <= 512, "the active archive tail stays within archiveMaxBytes");
  for (const line of active.split("\n").filter(Boolean)) ids.push(JSON.parse(line).id);
  return { ids, files: names.length };
}

test("compact batches ordered archive segments and reopens the same history", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-archive-rewrite-batch-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { memory } = await openMemory(home, { counts: 24, collections: SEGMENTED_COLLECTIONS });
  const expectedHistory = Object.fromEntries(SEGMENTED_COLLECTIONS.map((collection) => [
    collection,
    memory.history(collection).map((entry) => entry.id),
  ]));
  const expectedCold = Object.fromEntries(SEGMENTED_COLLECTIONS.map((collection) => {
    const hotIds = new Set(memory.snapshot()[collection].map((entry) => entry.id));
    return [collection, expectedHistory[collection].filter((id) => !hotIds.has(id))];
  }));
  const result = await withArchiveWriteProbe(async (calls) => {
    const report = await memory.compact();
    return { report, calls };
  });
  assert.equal(result.calls.appendFile, 0, "compaction writes each archive segment as a batch");
  assert.ok(result.calls.writeFile > 0, "the compaction must flush staged archive bytes");

  const reopened = await openMemory(home, { store: new JsonStateStore({ home }), seed: false, collections: SEGMENTED_COLLECTIONS });
  for (const collection of SEGMENTED_COLLECTIONS) {
    const archive = await archiveSegmentIds(home, collection);
    assert.deepEqual(archive.ids, expectedCold[collection], `${collection} archives exactly the pre-compaction cold records in source order`);
    assert.ok(archive.files > 1, `${collection} archive crosses multiple segment boundaries`);
    assert.deepEqual(reopened.memory.history(collection).map((entry) => entry.id), expectedHistory[collection], `${collection} history survives reopening without loss`);
  }
  assert.ok(result.report.after.observations > 2);
});

test("a partial temporary write propagates the same error and leaves only its uncommitted prefix", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-archive-rewrite-partial-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { memory, stateStore } = await openMemory(home, { counts: 24 });
  const before = await fileDigests(home);
  const injected = Object.assign(new Error("injected partial archive write"), { code: "EIO" });
  await withArchiveWriteProbe(async () => {
    await assert.rejects(memory.compact(), (error) => error === injected);
  }, { partialFailure: injected });

  const after = await fileDigests(home);
  const temporary = Object.keys(after).filter((path) => /\.compact-[0-9a-f-]+\.tmp$/.test(path));
  const durable = (tree) => Object.fromEntries(Object.entries(tree).filter(([path]) => !/\.compact-[0-9a-f-]+\.tmp$/.test(path)));
  assert.deepEqual(durable(after), before, "existing state and archive bytes remain unchanged");
  assert.equal(temporary.length, 1, "the in-progress temporary file remains uncommitted");
  assert.equal((await stat(join(home, temporary[0]))).size, 37, "the injected partial prefix is the only temporary content");

  const reopened = await openMemory(home, { store: new JsonStateStore({ home }), seed: false });
  for (const collection of COLLECTIONS) {
    assert.deepEqual(reopened.memory.history(collection).map((entry) => entry.id), rowsFor(collection, 24).map((entry) => entry.id));
  }
  assert.equal(stateStore.filePath, join(home, ".dockyard-dsh", "state.json"));
});

test("an index document failure restores archive bytes and the in-memory index before later writes", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-archive-rewrite-index-write-failure-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { memory, stateStore } = await openMemory(home, { counts: 24 });
  const indexPath = `${stateStore.filePath}.evolution-archive-index.json`;
  const archivesBefore = await archiveBytes(home);
  const originalIndexBytes = await readFile(indexPath);
  // A larger segment target makes this rewrite pack the cold rows into a
  // different segment layout than the one on disk. Without that difference the
  // failed rewrite's in-memory layout happens to equal the restored one, and a
  // projection that was never restored would still describe the right bytes.
  memory.archiveMaxBytes = 4096;
  const injected = Object.assign(new Error("injected archive index document failure"), { code: "EIO" });
  const originalWriteFile = fsp.writeFile;
  let indexWriteAttempted = false;
  fsp.writeFile = async function (...args) {
    const target = String(args[0]);
    if (!indexWriteAttempted && target.startsWith(`${indexPath}.`) && target.endsWith(".tmp") && !target.endsWith(".rollback.tmp")) {
      indexWriteAttempted = true;
      throw injected;
    }
    return originalWriteFile.apply(this, args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(memory.compact(), (error) => error === injected);
  } finally {
    fsp.writeFile = originalWriteFile;
    syncBuiltinESMExports();
  }

  assert.equal(indexWriteAttempted, true, "the injected failure reached the archive index document write");
  assert.deepEqual(await archiveBytes(home), archivesBefore, "the failed rewrite restores every archive byte");
  assert.deepEqual(await readFile(indexPath), originalIndexBytes, "the index document bytes are restored too");

  await memory.recordCycle({ id: "cycle-after-index-rollback", recordedAt: NOW, payload: "append after rollback" });
  const document = JSON.parse(await readFile(indexPath, "utf8"));
  const sealedEntries = document.segments.filter((entry) => entry.sealed === true);
  const indexed = new Set(sealedEntries.map((entry) => `${entry.collection}/${entry.file}`));
  for (const collection of SEGMENTED_COLLECTIONS) {
    const directory = `${stateStore.filePath}.${collection}-archive.jsonl.segments`;
    const names = await readdir(directory).catch(() => []);
    for (const name of names.filter((candidate) => /^segment-[0-9]+\.jsonl$/.test(candidate))) {
      assert.ok(indexed.has(`${collection}/${name}`),
        `${collection}/${name} keeps its restored index entry instead of the discarded staged layout`);
    }
  }
  assert.ok(sealedEntries.length > 0, "the later incremental write persisted sealed index entries");
  for (const entry of sealedEntries) {
    const archive = entry.collection === "cycles"
      ? `${stateStore.filePath}.cycles-archive.jsonl`
      : `${stateStore.filePath}.${entry.collection}-archive.jsonl`;
    const bytes = await readFile(join(`${archive}.segments`, entry.file));
    assert.equal(entry.byteSize, bytes.length, `${entry.collection}/${entry.file} records the restored byte size`);
    assert.equal(entry.sha256, createHash("sha256").update(bytes).digest("hex"),
      `${entry.collection}/${entry.file} records the restored bytes, not a failed staged rewrite`);
  }
});

test("state-save rollback restores archive bytes and removes transaction temporaries", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-archive-rewrite-rollback-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new JsonStateStore({ home });
  const { memory } = await openMemory(home, { counts: 24, store });
  const indexPath = `${store.filePath}.evolution-archive-index.json`;
  const indexDocument = JSON.parse(await readFile(indexPath, "utf8"));
  indexDocument.auditMarker = "pre-compaction-index-bytes";
  await writeFile(indexPath, JSON.stringify(indexDocument));
  const before = await fileDigests(home);
  const injected = Object.assign(new Error("injected state save failure"), { code: "EIO" });
  store.update = async () => { throw injected; };
  await assert.rejects(memory.compact(), (error) => error === injected);

  const after = await fileDigests(home);
  assert.deepEqual(after, before, "rollback restores the prior durable state, archive files, and index bytes");
  assert.equal(Object.keys(after).some((path) => path.includes(".compact-")), false, "rollback removes staged and backup files");

  const reopened = await openMemory(home, { store: new JsonStateStore({ home }), seed: false });
  for (const collection of COLLECTIONS) {
    assert.deepEqual(reopened.memory.history(collection).map((entry) => entry.id), rowsFor(collection, 24).map((entry) => entry.id));
  }
  const verification = await reopened.memory.verifyConsistency();
  assert.equal(verification.archive.valid, true, "the restored index describes the restored archive tree after restart");
  assert.ok(!verification.reasons.includes("archive_index_inconsistent"), "restart reports no archive conflict");
});

test("state-save rollback removes an index created by a transaction when none existed before", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-archive-rewrite-no-index-rollback-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new JsonStateStore({ home });
  const { memory } = await openMemory(home, { counts: 24, store });
  const indexPath = `${store.filePath}.evolution-archive-index.json`;
  await rm(indexPath);
  const before = await fileDigests(home);
  const injected = Object.assign(new Error("injected state save failure without an original index"), { code: "EIO" });
  store.update = async () => { throw injected; };
  await assert.rejects(memory.compact(), (error) => error === injected);

  const after = await fileDigests(home);
  assert.deepEqual(after, before, "rollback restores every original archive byte and removes its newly written index");
  assert.equal(await stat(indexPath).then(() => true, () => false), false, "an originally absent index stays absent");
});

test("an index-restore failure is attached without replacing the primary state-save error", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-archive-rewrite-double-failure-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new JsonStateStore({ home });
  const { memory } = await openMemory(home, { counts: 24, store });
  const indexPath = `${store.filePath}.evolution-archive-index.json`;
  const archivesBefore = await archiveBytes(home);
  const indexBefore = await readFile(indexPath);
  const primary = Object.assign(new Error("primary state save failed"), { code: "EIO" });
  const rollbackFailure = Object.assign(new Error("injected index restore write failure"), { code: "EACCES" });
  store.update = async () => { throw primary; };

  const originalWriteFile = fsp.writeFile;
  let restoreAttempted = false;
  fsp.writeFile = async function (...args) {
    if (String(args[0]).endsWith(".rollback.tmp")) {
      restoreAttempted = true;
      throw rollbackFailure;
    }
    return originalWriteFile.apply(this, args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(memory.compact(), (error) => error === primary
      && error.code === "EIO"
      && error.message === "primary state save failed"
      && error.rollbackError === rollbackFailure);
  } finally {
    fsp.writeFile = originalWriteFile;
    syncBuiltinESMExports();
  }

  assert.equal(restoreAttempted, true, "rollback reached the injected index restore failure");
  const after = await fileDigests(home);
  assert.deepEqual(Object.keys(after).filter((name) => name.endsWith(".rollback.tmp")), [],
    "the failed temporary index write is cleaned up before its error is attached");
  assert.deepEqual(await archiveBytes(home), archivesBefore, "the failed index restore still leaves archive bytes restored");
  assert.notDeepEqual(await readFile(indexPath), indexBefore, "the failed index restore leaves only the index document changed");
});
