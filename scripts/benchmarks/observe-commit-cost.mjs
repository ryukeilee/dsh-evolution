// What one high-frequency fault observation costs on its *durable* path, split
// fine enough to decide whether any of that work is a duplicate that can be
// removed without weakening the transaction.
//
// The path is `port.observe()` -> `enqueue()` -> `mutate()` ->
// `installPending()` -> `hydrate()` with the official `DomainFacility` plus
// `JsonStorageBackend` on an isolated temporary data root. `--attribute` patches
// a temporary copy of `lib/` with expression-level timers; each anchor must match
// exactly one site, so a moved site fails the run instead of silently reporting
// nothing. Timers measure the phases; the filesystem tracing below measures every
// sync/flush/read the phases ask for, so a phase's cost can be split into the
// syscall it waits on and the CPU it spends.
//
// `--counterexample` reproduces why the install-time content verification cannot
// be replaced by the change list the transaction already computed: a staged byte
// that changes between the change list and the install is installed by the
// candidate and refused by the tree, even though the change list and the install
// agree on path, size and identity.
//
//   node --max-old-space-size=4096 --expose-gc scripts/benchmarks/observe-commit-cost.mjs \
//     --attribute --histories 8000,20000,50000 --steps 10 --out <json>
//   node --max-old-space-size=4096 --expose-gc scripts/benchmarks/observe-commit-cost.mjs \
//     --counterexample --out <json>
// See docs/performance/observe-transaction-commit-cost-20261109.md.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { JsonStorageBackend } from "@deepseek-ai/dsh-storage-json";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const HERE = "scripts/benchmarks/observe-commit-cost.mjs";
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const OUT = option("out", null);
const KEY = "b".repeat(64);
const MODE = ["attribute", "counterexample"].find((name) => args.includes(`--${name}`)) ?? "attribute";
const HISTORIES = (option("histories", "8000,20000,50000")).split(",").map(Number).filter(Number.isSafeInteger);
const STEPS = Number(option("steps", 10));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "observe-commit-"));

const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const round = (value, digits = 3) => Number(value.toFixed(digits));

/** One materialized `lib/` tree, importable on its own. */
function materialize(name, transform = null) {
  const directory = path.join(temp, `arm-${name}`);
  fs.mkdirSync(directory);
  fs.cpSync(path.join(REPO, "lib"), path.join(directory, "lib"), { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(directory, "node_modules"));
  if (transform) transform(directory);
  return directory;
}

async function importArm(directory) {
  const storage = await import(pathToFileURL(path.join(directory, "lib/domain-storage.js")).href);
  const domain = await import(pathToFileURL(path.join(directory, "lib/dockyard-domain/index.js")).href);
  const registration = await import(pathToFileURL(path.join(directory, "lib/registration.js")).href);
  return { ...storage, ...domain, apply: registration.apply };
}

const PROLOGUE = "const __A = (key, ms, bytes = 0) => globalThis.__attrAdd?.(key, ms, bytes);\n";

function patchAnchors(file, anchors, name) {
  let text = fs.readFileSync(file, "utf8");
  for (const [anchor, replacement] of anchors) {
    const parts = text.split(anchor);
    assert.equal(parts.length, 2, `${name}: anchor must match exactly once: ${anchor.slice(0, 120)}`);
    text = parts.join(replacement);
  }
  fs.writeFileSync(file, text);
}

// ---------------------------------------------------------------------------
// Attribution anchors: every phase is one contiguous region of the commit path.
// `__A` accumulates (key, milliseconds, bytes) for the step that is running.
// ---------------------------------------------------------------------------

const DOMAIN_STORAGE_ANCHORS = [
  ["  async function installPending() {\n    const current = schema.parse(domain.global.get());",
    "  async function installPending() {\n    const __install = performance.now();\n    const __tp = performance.now();\n    const current = schema.parse(domain.global.get());\n    __A(\"installPending.parse\", performance.now() - __tp, 0);"],
  ["    if (files) installArchiveFiles(source, root, files);",
    "    if (files) { const __tf = performance.now(); installArchiveFiles(source, root, files); __A(\"installPending.installFiles\", performance.now() - __tf, 0); }"],
  ["    writeCommitToken(commitToken);\n    // The retention floor a reclaim committed travels with the pending record,",
    "    { const __tt = performance.now(); writeCommitToken(commitToken); __A(\"installPending.commitToken\", performance.now() - __tt, 0); }\n    // The retention floor a reclaim committed travels with the pending record,"],
  ["    await domain.global.set({ schema: 1, aggregate: current.pending.aggregate, applied: current.pending.applied,\n      ...(floor === null ? {} : { retention: floor }), pending: null });\n    removeStage(source);",
    "    { const __tf = performance.now(); await domain.global.set({ schema: 1, aggregate: current.pending.aggregate, applied: current.pending.applied,\n      ...(floor === null ? {} : { retention: floor }), pending: null }); __A(\"installPending.finalSet\", performance.now() - __tf, 0); }\n    { const __td = performance.now(); removeStage(source); __A(\"installPending.removeStage\", performance.now() - __td, 0); }\n    __A(\"installPending.total\", performance.now() - __install, 0);"],
  ["  async function createMemory(dir, initial, archiveWriteGuard = null, deferLoadArchiveWrites = false, archiveReadCache = memory?.archiveReadCache) {\n    let aggregate = structuredClone(initial);",
    "  async function createMemory(dir, initial, archiveWriteGuard = null, deferLoadArchiveWrites = false, archiveReadCache = memory?.archiveReadCache) {\n    const __create = performance.now();\n    let aggregate = structuredClone(initial);\n    __A(\"createMemory.clone\", performance.now() - __create, 0);"],
  ["    await instance.load({ snapshot: false });\n    return { instance };",
    "    const __load = performance.now();\n    await instance.load({ snapshot: false });\n    __A(\"createMemory.instanceLoad\", performance.now() - __load, 0);\n    __A(\"createMemory.total\", performance.now() - __create, 0);\n    return { instance };"],
  ["  async function hydrate(archiveReadCache = memory?.archiveReadCache) {\n    const index = path.join(root, 'state.json.evolution-archive-index.json');",
    "  async function hydrate(archiveReadCache = memory?.archiveReadCache) {\n    const __hydrate = performance.now();\n    const index = path.join(root, 'state.json.evolution-archive-index.json');"],
  ["    const current = await createMemory(root, domain.global.get().aggregate, null, true, archiveReadCache);\n    memory = current.instance;",
    "    let __cm = performance.now();\n    const current = await createMemory(root, domain.global.get().aggregate, null, true, archiveReadCache);\n    __A(\"hydrate.createMemory\", performance.now() - __cm, 0);\n    memory = current.instance;"],
  ["    await observations.load({ snapshot: false });",
    "    __cm = performance.now();\n    await observations.load({ snapshot: false });\n    __A(\"hydrate.observations.load\", performance.now() - __cm, 0);"],
  ["    if (fs.existsSync(index) && fs.statSync(index).ino !== before) { syncFile(index); syncFile(root); }\n  }",
    "    if (fs.existsSync(index) && fs.statSync(index).ino !== before) { const __ir = performance.now(); syncFile(index); syncFile(root); __A(\"hydrate.indexRepair\", performance.now() - __ir, 0); }\n    __A(\"hydrate.total\", performance.now() - __hydrate, 0);\n  }"],
  ["  async function mutate(work, applied, details = null) {\n    await installPending();",
    "  async function mutate(work, applied, details = null) {\n    const __mutate = performance.now();\n    let __phase = performance.now();\n    await installPending();\n    __A(\"mutate.installPending1\", performance.now() - __phase, 0);"],
  ["    const mirror = mirrorArchives(root, dir);",
    "    __phase = performance.now();\n    const mirror = mirrorArchives(root, dir);\n    __A(\"mutate.mirrorArchives\", performance.now() - __phase, mirror.files.size);"],
  ["    const current = await createMemory(dir, domain.global.get().aggregate, archiveWriteGuard);",
    "    __phase = performance.now();\n    const current = await createMemory(dir, domain.global.get().aggregate, archiveWriteGuard);\n    __A(\"mutate.createMemoryStage\", performance.now() - __phase, 0);"],
  ["    const result = await work(current.instance, store, { recovered });",
    "    __phase = performance.now();\n    const result = await work(current.instance, store, { recovered });\n    __A(\"mutate.work\", performance.now() - __phase, 0);"],
  ["    await current.instance.flushDeferredArchiveIndex();",
    "    __phase = performance.now();\n    await current.instance.flushDeferredArchiveIndex();\n    __A(\"mutate.flushDeferredIndex\", performance.now() - __phase, 0);"],
  ["    const aggregate = { evolution: current.instance.snapshot() };",
    "    __phase = performance.now();\n    const aggregate = { evolution: current.instance.snapshot() };\n    __A(\"mutate.snapshot\", performance.now() - __phase, 0);"],
  ["    assertLiveTreeUnchanged(root, mirror);",
    "    __phase = performance.now();\n    assertLiveTreeUnchanged(root, mirror);\n    __A(\"mutate.assertLiveTreeUnchanged\", performance.now() - __phase, 0);"],
  ["    const files = changedArchiveFiles(dir, mirror, root);",
    "    __phase = performance.now();\n    const files = changedArchiveFiles(dir, mirror, root);\n    __A(\"mutate.changedArchiveFiles\", performance.now() - __phase, files.length);"],
  ["    writeStageManifest(dir, files);",
    "    __phase = performance.now();\n    writeStageManifest(dir, files);\n    __A(\"mutate.writeStageManifest\", performance.now() - __phase, 0);"],
  ["    if (staged) syncStage({ directory: dir, stagingRoot: staging, files });",
    "    __phase = performance.now();\n    if (staged) syncStage({ directory: dir, stagingRoot: staging, files });\n    __A(\"mutate.syncStage\", performance.now() - __phase, staged ? files.length : 0);"],
  ["    if (!unchanged || !advanceCommitToken(commitToken, baseline.token)) throw new Error(E_COMMIT_OVERWRITTEN);\n    if (staged) {\n      await domain.global.set(schema.parse({ schema: 1, aggregate: latest.aggregate, applied: latest.applied,\n        pending: { stage, aggregate, applied: ledger, files, ...(retention === null ? {} : { retention }) } }));\n      await installPending();",
    "    if (!unchanged || !advanceCommitToken(commitToken, baseline.token)) throw new Error(E_COMMIT_OVERWRITTEN);\n    if (staged) {\n      __phase = performance.now();\n      const __pendingDoc = schema.parse({ schema: 1, aggregate: latest.aggregate, applied: latest.applied,\n        pending: { stage, aggregate, applied: ledger, files, ...(retention === null ? {} : { retention }) } });\n      __A(\"mutate.pendingSet.parse\", performance.now() - __phase, 0);\n      __phase = performance.now();\n      await domain.global.set(__pendingDoc);\n      __A(\"mutate.pendingSet\", performance.now() - __phase, 0);\n      __phase = performance.now();\n      await installPending();\n      __A(\"mutate.installPending2\", performance.now() - __phase, 0);"],
  ["    current.instance.publishArchiveScanSeeds(path.join(root, 'state.json'));\n    await hydrate(current.instance.archiveReadCache);\n    return result;",
    "    __phase = performance.now();\n    current.instance.publishArchiveScanSeeds(path.join(root, 'state.json'));\n    __A(\"mutate.publishScanSeeds\", performance.now() - __phase, 0);\n    __phase = performance.now();\n    await hydrate(current.instance.archiveReadCache);\n    __A(\"mutate.hydrate\", performance.now() - __phase, 0);\n    __A(\"mutate.total\", performance.now() - __mutate, 0);\n    return result;"],
];

const ARCHIVE_STAGE_ANCHORS = [
  ["  const share = (relative, absolute, stat) => {\n    const target = stageDirectory(relative);\n    let shared = true;\n    try { fs.linkSync(absolute, target); } catch { shared = false; }\n    if (!shared) fs.copyFileSync(absolute, target, fs.constants.COPYFILE_FICLONE);",
    "  const share = (relative, absolute, stat) => {\n    const target = stageDirectory(relative);\n    let shared = true;\n    const __link = performance.now();\n    try { fs.linkSync(absolute, target); } catch { shared = false; }\n    __A(\"mirror.link\", performance.now() - __link, 0);\n    if (!shared) { const __copy = performance.now(); fs.copyFileSync(absolute, target, fs.constants.COPYFILE_FICLONE); __A(\"mirror.copyFallback\", performance.now() - __copy, Number(stat.size)); }"],
  ["  const temporary = `${file}.${crypto.randomUUID()}.tmp`;\n  try {\n    fs.copyFileSync(file, temporary, fs.constants.COPYFILE_FICLONE);\n    fs.renameSync(temporary, file);",
    "  const temporary = `${file}.${crypto.randomUUID()}.tmp`;\n  try {\n    const __copy = performance.now();\n    fs.copyFileSync(file, temporary, fs.constants.COPYFILE_FICLONE);\n    __A(\"privatize.copy\", performance.now() - __copy, 0);\n    const __rename = performance.now();\n    fs.renameSync(temporary, file);\n    __A(\"privatize.rename\", performance.now() - __rename, 0);"],
  ["    changed.push({ file: relative, bytes: Number(stat.size),\n      sha256: crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex') });",
    "    const __read = performance.now();\n    const __content = fs.readFileSync(absolute);\n    __A(\"changedArchiveFiles.read\", performance.now() - __read, __content.length);\n    const __hash = performance.now();\n    const __digest = crypto.createHash('sha256').update(__content).digest('hex');\n    __A(\"changedArchiveFiles.hash\", performance.now() - __hash, __content.length);\n    changed.push({ file: relative, bytes: Number(stat.size), sha256: __digest });"],
  ["    if (removed === true) continue;\n    const absolute = path.join(directory, ...file.split('/'));\n    syncFile(absolute);\n    entries.push(path.dirname(absolute));\n  }\n  syncDirectories(entries, stagingRoot);",
    "    if (removed === true) continue;\n    const absolute = path.join(directory, ...file.split('/'));\n    const __file = performance.now();\n    syncFile(absolute);\n    __A(\"syncStage.file\", performance.now() - __file, 0);\n    entries.push(path.dirname(absolute));\n  }\n  const __dirs = performance.now();\n  syncDirectories(entries, stagingRoot);\n  __A(\"syncStage.directories\", performance.now() - __dirs, 0);"],
  ["    const content = fs.readFileSync(staged);\n    if (content.length !== bytes || crypto.createHash('sha256').update(content).digest('hex') !== sha256) {\n      throw new Error(`E_DOMAIN_PENDING_ARCHIVE_CORRUPT: ${file} does not match the committed stage`);\n    }",
    "    const __read = performance.now();\n    const content = fs.readFileSync(staged);\n    __A(\"installFiles.read\", performance.now() - __read, content.length);\n    const __hash = performance.now();\n    const __digest = crypto.createHash('sha256').update(content).digest('hex');\n    __A(\"installFiles.hash\", performance.now() - __hash, content.length);\n    if (content.length !== bytes || __digest !== sha256) {\n      throw new Error(`E_DOMAIN_PENDING_ARCHIVE_CORRUPT: ${file} does not match the committed stage`);\n    }"],
  ["  const directories = new Set();\n  for (const { file, parts, staged, content, mode, dev, ino } of verified) {",
    "  const directories = new Set();\n  const __publish = performance.now();\n  for (const { file, parts, staged, content, mode, dev, ino } of verified) {"],
  ["  syncDirectories([...directories], live);\n}",
    "  __A(\"installFiles.publish\", performance.now() - __publish, verified.length);\n  const __dirs = performance.now();\n  syncDirectories([...directories], live);\n  __A(\"installFiles.syncDirectories\", performance.now() - __dirs, directories.size);\n}"],
  ["  for (const directory of [...directories].sort((left, right) => right.length - left.length)) syncDirectory(directory);",
    "  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {\n    const __sync = performance.now();\n    syncDirectory(directory);\n    __A(\"io.syncDirectory\", performance.now() - __sync, 0);\n  }"],
];

const MEMORY_ANCHORS = [
  ["      const matches = event ? this.#sourceMatches(collection, event) : [];",
    "      const __scan = performance.now();\n      const matches = event ? this.#sourceMatches(collection, event) : [];\n      __A(\"memory.sourceMatches\", performance.now() - __scan, 0);"],
  ["    const state = this.#archiveRead(collection);\n    const hotById = new Map();",
    "    const __readCache = performance.now();\n    const state = this.#archiveRead(collection);\n    __A(\"memory.sourceMatches.read\", performance.now() - __readCache, 0);\n    const hotById = new Map();"],
  ["      reads = new Map(files.map((file) => {\n        try { return [file, { digest: this.#archiveFileDigest(file) }]; }\n        catch (error) { return [file, { error }]; }\n      }));",
    "      const __inherited = performance.now();\n      reads = new Map(files.map((file) => {\n        try { return [file, { digest: this.#archiveFileDigest(file) }]; }\n        catch (error) { return [file, { error }]; }\n      }));\n      __A(\"memory.inheritedReads\", performance.now() - __inherited, files.length);"],
  ["  async #archiveEntries(collection, entries, { replaceExisting = false } = {}) {\n    const run = async () => {",
    "  async #archiveEntries(collection, entries, { replaceExisting = false } = {}) {\n    const __entries = performance.now();\n    const run = async () => {"],
  ["    const queued = this.archiveWriting.then(run, run);\n    this.archiveWriting = queued.catch(() => {});\n    return queued;",
    "    const queued = this.archiveWriting.then(run, run);\n    this.archiveWriting = queued.catch(() => {});\n    return queued.then((value) => { __A(\"memory.archiveEntries\", performance.now() - __entries, 0); return value; },\n      (error) => { __A(\"memory.archiveEntries\", performance.now() - __entries, 0); throw error; });"],
  ["      try { proof = this.#archivePrefixDigest(file, Number(before.size), appendedBytes); }",
    "      try { const __prefix = performance.now(); proof = this.#archivePrefixDigest(file, Number(before.size), appendedBytes); __A(\"memory.prefixDigest\", performance.now() - __prefix, Number(before.size)); }"],
  ["    const positions = new Map(cached.positions);",
    "    const __copyCache = performance.now();\n    const positions = new Map(cached.positions);"],
  ["    const updated = new Map();\n    let offset = Number(before.size);",
    "    __A(\"memory.cacheCopy\", performance.now() - __copyCache, cached.keys.length);\n    const updated = new Map();\n    let offset = Number(before.size);"],
  ["    const after = this.#archiveAppendIdentity(file);",
    "    const __publishCache = performance.now();\n    const after = this.#archiveAppendIdentity(file);"],
  ["    return after;\n  }\n\n  /**\n   * The SHA-256 of one archive file's first",
    "    __A(\"memory.cachePublish\", performance.now() - __publishCache, cached.keys.length);\n    return after;\n  }\n\n  /**\n   * The SHA-256 of one archive file's first"],
  ["  snapshot() { return clone(this.#data); }",
    "  snapshot() { const __snapshot = performance.now(); const __value = clone(this.#data); __A(\"memory.snapshot\", performance.now() - __snapshot, 0); return __value; }"],
  ["    const before = inspectArchiveIntegrity({\n      stateFile: this.stateStore.filePath,\n      indexFile: this.archiveIndexFile,\n      scanContents: false,\n    });",
    "    const __inspect = performance.now();\n    const before = inspectArchiveIntegrity({\n      stateFile: this.stateStore.filePath,\n      indexFile: this.archiveIndexFile,\n      scanContents: false,\n    });\n    __A(\"load.inspectArchiveIntegrity\", performance.now() - __inspect, 0);"],
  ["    const loaded = await this.#loadArchiveIndex();",
    "    const __index = performance.now();\n    const loaded = await this.#loadArchiveIndex();\n    __A(\"load.loadArchiveIndex\", performance.now() - __index, 0);"],
  ["  #scanArchiveRead(collection, files, reads = null, options = {}) {",
    "  #scanArchiveRead(collection, files, reads = null, options = {}) {\n    const __rescan = performance.now();\n    try { return this.#scanArchiveReadInner(collection, files, reads, options); }\n    finally { __A(\"memory.scanArchiveRead\", performance.now() - __rescan, files.length); }\n  }\n  #scanArchiveReadInner(collection, files, reads = null, options = {}) {"],
];

function materializeAttributed() {
  return materialize("attributed", (directory) => {
    for (const [relative, anchors, name] of [
      ["lib/domain-storage.js", DOMAIN_STORAGE_ANCHORS, "domain-storage.js"],
      ["lib/archive-stage.js", ARCHIVE_STAGE_ANCHORS, "archive-stage.js"],
      ["lib/dockyard-domain/memory.js", MEMORY_ANCHORS, "memory.js"],
    ]) {
      const file = path.join(directory, relative);
      const text = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, PROLOGUE + text);
      patchAnchors(file, anchors, name);
    }
  });
}

// ---------------------------------------------------------------------------
// Filesystem tracing: every sync/flush/read the transaction asks for, with the
// wall time it cost. This is what separates CPU from the durable waits.
// ---------------------------------------------------------------------------

const io = { active: false, calls: {}, files: new Map(), documents: [] };
function installCounters() {
  const restores = [];
  const bump = (name, ms = 0, bytes = 0) => {
    if (!io.active) return;
    const row = io.calls[name] ?? { calls: 0, bytes: 0, ms: 0 };
    row.calls += 1; row.bytes += bytes; row.ms += ms;
    io.calls[name] = row;
  };
  const noteFile = (name, bytes) => {
    if (!io.active || typeof name !== "string") return;
    const row = io.files.get(name) ?? { reads: 0, bytes: 0 };
    row.reads += 1; row.bytes += bytes;
    io.files.set(name, row);
  };
  const fdPaths = new Map();
  // `readFileSync`/`writeFileSync` are implemented on top of the very
  // `openSync`/`readSync`/`writeSync`/`closeSync` bindings wrapped below, so their
  // internal calls must not be counted a second time - not as calls, not as
  // milliseconds and not as file bytes. Only the two high-level entries are
  // accumulated while nested, and the low-level ones are counted outside them.
  let nested = 0;
  for (const name of ["readFileSync", "writeFileSync", "writeSync", "fsyncSync", "linkSync", "renameSync",
    "rmSync", "statSync", "lstatSync", "readdirSync", "mkdirSync", "copyFileSync"]) {
    const original = fs[name];
    const highLevel = name === "readFileSync" || name === "writeFileSync";
    restores.push(() => { fs[name] = original; });
    fs[name] = function traced(...values) {
      const started = performance.now();
      if (highLevel) nested += 1;
      let result;
      try { result = original.apply(this, values); } finally { if (highLevel) nested -= 1; }
      const ms = performance.now() - started;
      const bytes = name === "readFileSync" ? (result?.length ?? 0)
        : name === "writeFileSync" && typeof values[1] === "string" ? Buffer.byteLength(values[1]) : 0;
      bump(name, ms, bytes);
      if (name === "readFileSync") noteFile(values[0], bytes);
      return result;
    };
  }
  {
    const original = fs.openSync;
    restores.push(() => { fs.openSync = original; });
    fs.openSync = function traced(target, ...rest) {
      const started = performance.now();
      const fd = original.call(this, target, ...rest);
      if (nested === 0) {
        bump("openSync", performance.now() - started, 0);
        if (typeof target === "string") fdPaths.set(fd, target);
      }
      return fd;
    };
  }
  {
    const original = fs.readSync;
    restores.push(() => { fs.readSync = original; });
    fs.readSync = function traced(fd, ...rest) {
      const started = performance.now();
      const read = original.call(this, fd, ...rest);
      if (nested === 0) {
        bump("readSync", performance.now() - started, read);
        noteFile(fdPaths.get(fd), read);
      }
      return read;
    };
  }
  {
    const original = fs.closeSync;
    restores.push(() => { fs.closeSync = original; });
    fs.closeSync = function traced(fd, ...rest) {
      if (nested === 0) fdPaths.delete(fd);
      return original.call(this, fd, ...rest);
    };
  }
  for (const name of ["open", "rename", "rm", "mkdir", "stat", "lstat", "writeFile", "readFile", "appendFile", "readdir"]) {
    const original = fs.promises[name];
    restores.push(() => { fs.promises[name] = original; });
    fs.promises[name] = async function traced(...values) {
      const started = performance.now();
      const result = await original.apply(this, values);
      const ms = performance.now() - started;
      const bytes = (name === "writeFile" || name === "appendFile") && typeof values[1] === "string" ? Buffer.byteLength(values[1])
        : name === "readFile" ? (typeof result === "string" ? Buffer.byteLength(result) : (result?.length ?? 0)) : 0;
      bump(`promises.${name}`, ms, bytes);
      if (name === "readFile") noteFile(values[0], bytes);
      if (name === "open") {
        const target = values[0];
        for (const method of ["writeFile", "sync", "close"]) {
          const saved = result[method];
          if (typeof saved !== "function") continue;
          result[method] = async function counted(...inner) {
            const starts = performance.now();
            const out = await saved.apply(this, inner);
            const innerBytes = method === "writeFile" && typeof inner[0] === "string" ? Buffer.byteLength(inner[0]) : 0;
            bump(`handle.${method}`, performance.now() - starts, innerBytes);
            if (method === "writeFile" && io.active) io.documents.push(innerBytes);
            return out;
          };
        }
      }
      return result;
    };
  }
  syncBuiltinESMExports();
  return () => {
    for (const restore of restores.reverse()) restore();
    syncBuiltinESMExports();
  };
}

// ---------------------------------------------------------------------------
// Fixture and session: a real row written by the released path, replicated to a
// synthetic history, rotated into the cold tier by one real load.
// ---------------------------------------------------------------------------

function openRoot(root) {
  fs.mkdirSync(root, { recursive: true });
  const backend = new JsonStorageBackend(path.join(root, "official"));
  const listeners = new Map();
  const ctx = { emit() {}, effect() {}, logger: { warn() {}, error() {} },
    on: (event, handler) => listeners.set(event, handler),
    storage: { backend: { get: () => backend } }, dynamicCordisRunner: {},
    tools: { register() {} }, systemPrompt: { section() {} } };
  ctx.storageDomain = new DomainFacility(ctx, { backend: "json" });
  return { backend, ctx, listeners };
}

const configFor = (root) => ({ presetDir: root, eventBridgePath: path.join(root, "events.jsonl"),
  eventBridgeKey: KEY, startupDrift: false, patternThreshold: 3,
  autonomousStrategies: { AGENT_ERROR: { risk: "medium", target: "plugin:fix" },
    TOOL_ERROR: { risk: "medium", target: "plugin:fix" } } });

const probeDto = (index) => ({ code: "HOST_OPERATION_FAILED", type: "tool/error", target: "host",
  observationId: `obs-run-${index}`, patternKey: `autonomous-v1:${(index + 1).toString(16).padStart(64, "0")}` });

async function openSession(root, arm) {
  const { backend, ctx } = openRoot(root);
  const config = configFor(root);
  const port = await arm.openDomainStorage(ctx, config);
  return { port, portRoot: root,
    observe: (index) => port.observe(probeDto(index)),
    close: async () => { try { await port.close(); } finally { await backend.close(); } } };
}

async function rowTemplate(arm) {
  const root = fs.mkdtempSync(path.join(temp, "template-"));
  const { backend, ctx } = openRoot(root);
  const port = await arm.openDomainStorage(ctx, configFor(root));
  await port.observe({ code: "HOST_OPERATION_FAILED", type: "tool/error", target: "host",
    observationId: "obs-template", patternKey: `autonomous-v1:${"a".repeat(64)}` });
  await port.close();
  await backend.close();
  const document = JSON.parse(fs.readFileSync(path.join(root, "official", "evolution_domain.json"), "utf8"));
  return document.global.aggregate.evolution.observations[0];
}

async function buildFixture(arm, history) {
  const root = fs.mkdtempSync(path.join(temp, `fixture-${history}-`));
  const template = await rowTemplate(arm);
  const rows = [];
  for (let index = 0; index < history; index += 1) {
    const suffix = index.toString(36).padStart(6, "0");
    const at = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
    rows.push({ ...template, id: `observation:seed-${suffix}`, recordedAt: at, observedAt: at,
      patternKey: `tool:tools/result:code-${suffix}`, message: `Official operation failed (code-${suffix})`,
      knowledgeKey: `knowledge:tool:tools/result:code-${suffix}:${"b".repeat(48)}` });
  }
  const { backend, ctx } = openRoot(root);
  const opened = await ctx.storageDomain.open(arm.evolutionDomainSpec);
  await opened.global.set({ schema: 1, aggregate: { evolution: { schema: 4, observations: rows, knowledge: [] } },
    applied: {}, pending: null });
  await opened.close();
  await backend.close();
  const normalized = await openSession(root, arm);
  await normalized.close();
  return root;
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

async function attribute() {
  const restoreCounters = installCounters();
  const totals = new Map();
  let stepStats = new Map();
  globalThis.__attrAdd = (key, ms, bytes = 0) => {
    for (const map of [stepStats, totals]) {
      const row = map.get(key) ?? { total: 0, count: 0, bytes: 0 };
      row.total += ms; row.count += 1; row.bytes += bytes;
      map.set(key, row);
    }
  };
  const arm = await importArm(materializeAttributed());
  const results = [];
  try {
    for (const history of HISTORIES) {
      const fixture = await buildFixture(arm, history);
      const root = fs.mkdtempSync(path.join(temp, `measure-${history}-`));
      fs.cpSync(fixture, root, { recursive: true });
      const session = await openSession(root, arm);
      io.active = false;
      for (let index = 0; index < 3; index += 1) await session.observe(900000 + index);
      totals.clear();
      const perStep = [];
      const fileTotals = new Map();
      const documents = [];
      io.active = true;
      const started = performance.now();
      const reads = [];
      try {
        for (let index = 0; index < STEPS; index += 1) {
          stepStats = new Map(); io.calls = {}; io.files = new Map(); io.documents = [];
          const stepStart = performance.now();
          // The observation chain commits first and only then reads the evidence
          // back; that read is the new live instance's first archive read, so it
          // is timed inside the same step.
          await session.observe(index);
          const read = performance.now();
          session.port.autonomousObservations();
          reads.push(performance.now() - read);
          documents.push(...io.documents);
          perStep.push({ wallMs: round(performance.now() - stepStart),
            phases: [...stepStats].map(([key, row]) => ({ key, ms: round(row.total), bytes: row.bytes, calls: row.count }))
              .sort((left, right) => right.ms - left.ms),
            calls: Object.fromEntries(Object.entries(io.calls)
              .map(([key, row]) => [key, { calls: row.calls, bytes: row.bytes, ms: round(row.ms) }])),
            files: [...io.files].map(([name, row]) => ({ file: path.relative(root, name), reads: row.reads, bytes: row.bytes })),
            documents: io.documents });
          for (const [name, row] of io.files) {
            const total = fileTotals.get(name) ?? { reads: 0, bytes: 0 };
            total.reads += row.reads; total.bytes += row.bytes;
            fileTotals.set(name, total);
          }
        }
      } finally { io.active = false; }
      const wall = (performance.now() - started) / STEPS;
      await session.close();
      const phases = [...totals].map(([key, row]) => ({ key, perStep: round(row.total / STEPS),
        bytesPerStep: round(row.bytes / STEPS), callsPerStep: round(row.count / STEPS) }))
        .sort((left, right) => right.perStep - left.perStep);
      // The phase sum must describe the transaction, not a subset of it.
      const mutateTotal = phases.find((entry) => entry.key === "mutate.total")?.perStep ?? 0;
      const covered = ["installPending1", "mirrorArchives", "createMemoryStage", "work", "flushDeferredIndex",
        "snapshot", "assertLiveTreeUnchanged", "changedArchiveFiles", "writeStageManifest", "syncStage",
        "pendingSet", "installPending2", "publishScanSeeds", "hydrate"]
        .reduce((sum, name) => sum + (phases.find((entry) => entry.key === `mutate.${name}`)?.perStep ?? 0), 0);
      assert.ok(mutateTotal > 0 && Math.abs(covered - mutateTotal) / mutateTotal < 0.05,
        `history ${history}: measured phases cover ${covered.toFixed(3)} of mutate.total ${mutateTotal.toFixed(3)}`);
      const rescans = phases.find((entry) => entry.key === "memory.scanArchiveRead");
      // The two whole-document writes alternate per step: pending first, closing
      // second. Report their means so the doc does not quote one sample.
      const documentMean = {
        pendingBytes: Math.round(mean(documents.filter((_, index) => index % 2 === 0))),
        closingBytes: Math.round(mean(documents.filter((_, index) => index % 2 === 1))) };
      results.push({ history, steps: STEPS, wallPerStep: round(wall), autonomousReadMs: round(median(reads)),
        mutateTotal, phaseCoverage: round(covered / mutateTotal, 4),
        archiveRescansPerStep: rescans?.perStep ?? 0, documentBytesMean: documentMean,
        documentBytesPerStep: documents,
        phases,
        callsPerStep: (() => {
          const merged = {};
          for (const step of perStep) for (const [key, row] of Object.entries(step.calls)) {
            const total = merged[key] ?? { calls: 0, bytes: 0, ms: 0 };
            total.calls += row.calls; total.bytes += row.bytes; total.ms += row.ms;
            merged[key] = total;
          }
          return Object.fromEntries(Object.entries(merged).map(([key, row]) =>
            [key, { callsPerStep: round(row.calls / STEPS, 2), bytesPerStep: round(row.bytes / STEPS),
              msPerStep: round(row.ms / STEPS) }]));
        })(),
        fileReadsPerStep: [...fileTotals].map(([name, row]) => ({ file: path.relative(root, name),
          readsPerStep: round(row.reads / STEPS, 2), bytesPerStep: round(row.bytes / STEPS) }))
          .sort((left, right) => right.bytesPerStep - left.bytesPerStep),
        perStep });
    }
  } finally { restoreCounters(); }
  return { mode: "attribute", node: process.version, platform: `${process.platform}/${process.arch}`,
    script: HERE, histories: HISTORIES, steps: STEPS, results };
}

// ---------------------------------------------------------------------------
// Counterexample: a staged file that changes between the change list and the
// install. The tree refuses it; a candidate that drops only the install-time
// read+digest verification installs it.
// ---------------------------------------------------------------------------

const TAMPER_ANCHOR = "    const files = changedArchiveFiles(dir, mirror, root);";
const TAMPER_REPLACEMENT = `    const files = changedArchiveFiles(dir, mirror, root);
    // Counterexample injection: one recorded staged file is rewritten after the
    // change list captured its digest, the way a same-process hook with write
    // access could. The rewrite keeps the byte length and restores mtime, and its
    // inode is the one the change list verified - only the content differs.
    for (const entry of files) {
      if (entry.removed === true || !entry.file.endsWith("-archive.jsonl")) continue;
      const staged = path.join(dir, ...entry.file.split('/'));
      const before = fs.statSync(staged, { bigint: true });
      const text = fs.readFileSync(staged, 'utf8');
      const tampered = text.replace('"status":"failed"', '"status":"failxx"');
      if (tampered === text) continue;
      fs.writeFileSync(staged, tampered);
      fs.utimesSync(staged, before.atime, before.mtime);
      const after = fs.statSync(staged, { bigint: true });
      fs.writeFileSync(path.join(dir, '..', 'tamper-note.json'), JSON.stringify({
        file: entry.file,
        bytesUnchanged: tampered.length === text.length,
        devSame: before.dev === after.dev, inoSame: before.ino === after.ino,
        sizeSame: before.size === after.size,
        mtimeNsSame: before.mtimeNs === after.mtimeNs,
        expectedDigest: entry.sha256,
        actualDigest: createHash('sha256').update(tampered).digest('hex') }, null, 2));
      break;
    }`;
// The candidate drops exactly the install-time read + digest verification; it
// keeps the change list, the atomic link+rename publish and the directory fsync.
const INSTALL_VERIFY = [
  "    const content = fs.readFileSync(staged);\n    if (content.length !== bytes || crypto.createHash('sha256').update(content).digest('hex') !== sha256) {\n      throw new Error(`E_DOMAIN_PENDING_ARCHIVE_CORRUPT: ${file} does not match the committed stage`);\n    }",
  "    // CANDIDATE: the change list already named this staged file; skip the\n    // read+digest verification and publish the staged inode.\n    const content = null;",
];

async function counterexample() {
  const candidate = materialize("candidate", (directory) => {
    patchAnchors(path.join(directory, "lib/archive-stage.js"),
      [[INSTALL_VERIFY[0], INSTALL_VERIFY[1]]], "candidate archive-stage.js");
  });
  const tampered = materialize("tampered", (directory) => {
    const file = path.join(directory, "lib/domain-storage.js");
    const text = fs.readFileSync(file, "utf8");
    assert.equal(text.split(TAMPER_ANCHOR).length, 2, "the tamper anchor must match exactly once");
    fs.writeFileSync(file, text.replace(TAMPER_ANCHOR, TAMPER_REPLACEMENT));
  });
  const tamperedCandidate = materialize("tampered-candidate", (directory) => {
    patchAnchors(path.join(directory, "lib/archive-stage.js"),
      [[INSTALL_VERIFY[0], INSTALL_VERIFY[1]]], "candidate archive-stage.js");
    const file = path.join(directory, "lib/domain-storage.js");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(TAMPER_ANCHOR, TAMPER_REPLACEMENT));
  });
  const TAMPER_MARK = '"status":"failxx"';
  const durableState = (root) => {
    const document = JSON.parse(fs.readFileSync(path.join(root, "official", "evolution_domain.json"), "utf8"));
    const archive = path.join(root, "dockyard", "state.json.observations-archive.jsonl");
    const staging = path.join(root, "domain-staging");
    const live = fs.existsSync(archive) ? fs.readFileSync(archive, "utf8") : null;
    return { aggregateObservations: document.global.aggregate?.evolution?.observations?.length ?? null,
      pendingInDurableDocument: document.global.pending !== null,
      tamperedContentInLiveArchive: live !== null && live.includes(TAMPER_MARK),
      liveArchiveBytes: live === null ? 0 : Buffer.byteLength(live),
      liveArchiveLastLine: live === null ? null : live.trimEnd().split("\n").at(-1)?.replace(/^(.{0,200}).*$/s, "$1") ?? null,
      stageDirectoriesRemaining: fs.existsSync(staging) ? fs.readdirSync(staging).length : 0 };
  };
  const attempt = async (root, arm) => {
    let session;
    try { session = await openSession(root, arm); }
    catch (error) { return `open-refused ${error.code ?? "threw"}: ${String(error.message).split(":")[0]}`; }
    let observed = "committed";
    try { await session.observe(0); }
    catch (error) { observed = `${error.code ?? "threw"}: ${String(error.message).split(":")[0]}`; }
    // Closing drains the queued chain; a refused transaction must not turn the
    // probe into an unhandled rejection. The durable state is the evidence.
    try { await session.close(); } catch { /* read below */ }
    return observed;
  };
  const probe = async (name, directory) => {
    const arm = await importArm(directory);
    // A history large enough that the fixture has rotated an active archive
    // file: a transaction with no archive change takes the single-write path and
    // has no staged file to verify.
    const fixture = await buildFixture(arm, 300);
    const root = fs.mkdtempSync(path.join(temp, `probe-${name}-`));
    fs.cpSync(fixture, root, { recursive: true });
    const outcome = await attempt(root, arm);
    const note = path.join(root, "domain-staging", "tamper-note.json");
    const tamper = fs.existsSync(note) ? JSON.parse(fs.readFileSync(note, "utf8")) : null;
    const after = durableState(root);
    // Opening the root is the recovery step: a committed pending record is
    // installed before the port serves anything.
    const recovery = await attempt(root, arm);
    return { arm: name, outcome, recovery, tamper,
      ...after, afterRecovery: durableState(root) };
  };
  return { mode: "counterexample", script: HERE,
    requirement: "install-time verification: the bytes that were verified are the bytes that were installed",
    tree: await probe("tree", materialize("tree")),
    treeWithTamper: await probe("tree-tampered", tampered),
    candidate: await probe("candidate", candidate),
    candidateWithTamper: await probe("candidate-tampered", tamperedCandidate) };
}

let output;
try {
  output = MODE === "counterexample" ? await counterexample() : await attribute();
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
if (OUT) fs.writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
