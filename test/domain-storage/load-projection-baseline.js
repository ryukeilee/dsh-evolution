import assert from "node:assert/strict";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REPO_ROOT } from "../../scripts/release/release-lib.mjs";

// Revert the projection-free load round, so the whole pre-change tree can be
// imported next to the working tree. Each hunk is [post-change text, pre-change
// text] as an exact substring: the single-occurrence guard below fails on any
// shape drift, so a stale hunk cannot silently reconstruct something else.
//
// The tree form is what this change needs. Reverting `lib/domain-storage.js`
// alone is not enough: the two calls that changed are made by that file, but
// the load paths they call live in `memory.js` and `observation.js`, and the
// single-file anchor in `domain-storage-baseline.js` deliberately resolves its
// siblings to the working tree, so it cannot see either of them.
const LIB = fileURLToPath(new URL("../../lib", import.meta.url));
const FILES = ["lib/dockyard-domain/memory.js", "lib/dockyard-domain/observation.js", "lib/domain-storage.js"];
const HUNKS = [
{ file: "lib/dockyard-domain/memory.js",
    post: "    if (typeof this.archiveWriteGuard === \"function\") await this.archiveWriteGuard(file);\n  }\n\n  /**\n   * Load the durable state and, unless the caller asks otherwise, return the\n   * hot projection of it.\n   *\n   * The projection is the *returned* value, never a side effect of loading:\n   * every reader in this package either consumes it or discards it, and both\n   * call sites that discard it (the domain port's `createMemory()` and the\n   * observation store's observation-window read) pay for a deep clone of every\n   * collection only to drop it. `{ snapshot: false }` still performs the whole\n   * load - state-store read, archive index reconciliation, eviction and\n   * archival - and skips only the closing `snapshot()`, which clones state that\n   * loading has already finished mutating and cannot mutate again.\n   */\n  async load({ snapshot = true } = {}) {\n    if (this.loaded) return snapshot ? this.snapshot() : undefined;\n    if (this.loading) {\n      // A concurrent load shares the one loading run; the first caller's\n      // projection is handed on, which is what `return this.loading` gave back.\n      const shared = await this.loading;\n      return snapshot ? (shared ?? this.snapshot()) : undefined;\n    }\n    this.loading = (async () => {\n      if (typeof this.stateStore?.load === \"function\") {\n        const state = await this.stateStore.load({ resolveSnapshot: false });\n",
    pre: "    if (typeof this.archiveWriteGuard === \"function\") await this.archiveWriteGuard(file);\n  }\n\n  async load() {\n    if (this.loaded) return this.snapshot();\n    if (this.loading) return this.loading;\n    this.loading = (async () => {\n      if (typeof this.stateStore?.load === \"function\") {\n        const state = await this.stateStore.load({ resolveSnapshot: false });\n" },
  { file: "lib/dockyard-domain/memory.js",
    post: "        }\n      }\n      this.loaded = true;\n      return snapshot ? this.snapshot() : undefined;\n    })();\n    try { return await this.loading; } finally { this.loading = null; }\n  }\n",
    pre: "        }\n      }\n      this.loaded = true;\n      return this.snapshot();\n    })();\n    try { return await this.loading; } finally { this.loading = null; }\n  }\n" },
  { file: "lib/dockyard-domain/observation.js",
    post: "    this.loading = null;\n  }\n\n  /**\n   * Load this store's observation window from the shared memory port (or from\n   * an explicit state store) and, unless the caller asks otherwise, return the\n   * public snapshot of it.\n   *\n   * Loading is still not inert with `{ snapshot: false }`: the returned\n   * projection is also where `memory.hasColdHistory` is read, and that read\n   * coerces every `coldArchives` entry with `Number(count)`. A durable\n   * aggregate whose entry cannot be coerced must keep failing here, so the read\n   * is performed on every path (see `#projection`).\n   */\n  async load({ snapshot = true } = {}) {\n    if (this.loaded) return this.#projection(snapshot);\n    if (this.loading) {\n      // A concurrent load shares the one loading run; the first caller's\n      // projection is handed on, which is what `return this.loading` gave back.\n      const shared = await this.loading;\n      return shared ?? this.#projection(snapshot);\n    }\n    this.loading = (async () => {\n      if (this.memory?.load && typeof this.memory.history === \"function\") {\n        // The shared memory port owns these rows. Read its hot observation\n        // window directly: the port's own hot projection would deep-clone every\n        // other collection (`knowledge` up to `maxEntries`) for the single\n        // `.observations` array taken out of it, and this store does not read\n        // any of them.\n        await this.memory.load({ snapshot: false });\n        this.entries = this.memory.history(\"observations\", { includeArchived: false }).slice(-this.maxEntries).map(clone);\n      } else if (this.memory?.load) {\n        // A narrower port that declares only the documented minimum can still\n        // hand its hot projection over.\n        const state = await this.memory.load();\n        this.entries = (state.observations ?? []).slice(-this.maxEntries).map(clone);\n      } else if (this.stateStore?.load) {\n",
    pre: "    this.loading = null;\n  }\n\n  async load() {\n    if (this.loaded) return this.snapshot();\n    if (this.loading) return this.loading;\n    this.loading = (async () => {\n      if (this.memory?.load) {\n        const state = await this.memory.load();\n        this.entries = (state.observations ?? []).slice(-this.maxEntries).map(clone);\n      } else if (this.stateStore?.load) {\n" },
  { file: "lib/dockyard-domain/observation.js",
    post: "        this.entries = (state[this.key]?.observations ?? []).slice(-this.maxEntries).map(clone);\n      }\n      this.loaded = true;\n      return this.#projection(snapshot);\n    })();\n    try { return await this.loading; } finally { this.loading = null; }\n  }\n\n  /**\n   * The projection a load returns, and the cold-history read it owes.\n   *\n   * `{ snapshot: false }` skips the returned projection, never the read: the\n   * projection is the only place `memory.hasColdHistory` is consulted, and that\n   * getter coerces every `coldArchives` entry with `Number(count)`, which is\n   * how a durable aggregate with a non-coercible entry is rejected. Reading it\n   * only where the projection was built let an instance whose earlier load had\n   * already failed - `loaded` is set before the projection throws, in this and\n   * in the released implementation - take a later `record()` past a state the\n   * released implementation still refuses. That is the same silent acceptance\n   * the withdrawn candidate in `docs/performance/domain-write-path.md` section 4\n   * was rejected for, so the read happens on every path, including the two that\n   * return before loading anything.\n   */\n  #projection(snapshot) {\n    if (!snapshot) { void this.memory?.hasColdHistory; return undefined; }\n    return this.snapshot();\n  }\n\n  snapshot() {\n    const hot = this.entries.slice(-this.hotEntries).map(clone);\n    const warm = this.entries.slice(-this.warmEntries).map(clone);\n",
    pre: "        this.entries = (state[this.key]?.observations ?? []).slice(-this.maxEntries).map(clone);\n      }\n      this.loaded = true;\n      return this.snapshot();\n    })();\n    try { return await this.loading; } finally { this.loading = null; }\n  }\n\n  snapshot() {\n    const hot = this.entries.slice(-this.hotEntries).map(clone);\n    const warm = this.entries.slice(-this.warmEntries).map(clone);\n" },
  { file: "lib/dockyard-domain/observation.js",
    post: "  }\n\n  async record(input = {}, { deferStablePersistence = false } = {}) {\n    // The projection is not read here: only `this.entries` is.\n    await this.load({ snapshot: false });\n    const normalized = observationInput(input, this.clock);\n    // P1 perf: semantic dedup — a repeat of the same component signal within\n    // the hot window carries no new evidence (component/observation rows are\n",
    pre: "  }\n\n  async record(input = {}, { deferStablePersistence = false } = {}) {\n    await this.load();\n    const normalized = observationInput(input, this.clock);\n    // P1 perf: semantic dedup — a repeat of the same component signal within\n    // the hot window carries no new evidence (component/observation rows are\n" },
  // Both pieces of the save-projection round are reversed here as well, so this
  // baseline tree stays byte-identical to the tree it reconstructed before that
  // round: the exported check, and the working store with its original comment.
  { file: "lib/domain-storage.js",
    post: "const safeIdentifier = value => typeof value === 'string' && /^[a-zA-Z0-9_:./-]{1,160}$/.test(value) ? value : null;\n" +
      "/**\n" +
      " * The check a transaction's working store still performs on every save.\n" +
      " *\n" +
      " * It used to be the preprocess of `aggregateSchema.parse(payload)`, which built\n" +
      " * the whole projection and then dropped it (see `createMemory`). This runs the\n" +
      " * same three steps in the same order and discards what they produce, so a save\n" +
      " * throws exactly where it threw: `JSON.stringify`; the `JSON.parse` of its output,\n" +
      " * which throws only when the stringify returned `undefined`; and the recursive\n" +
      " * own-`__proto__` copy, which runs only when the serialized text carries that\n" +
      " * literal, and would overflow on a document nested deeply enough. The parse is the\n" +
      " * step skipped on the common path, and it is the one that builds the deep copy no\n" +
      " * reader wants; the substring search costs what that preprocess already paid for\n" +
      " * the same decision.\n" +
      " *\n" +
      " * What is no longer reproduced is the schema's *verdict* on the projection, which\n" +
      " * is fixed for the payload this updater produces (see `createMemory`). The check is\n" +
      " * kept as a named function because the throw is a boundary - a save whose payload\n" +
      " * JSON cannot represent aborts the transaction before anything is published - and\n" +
      " * because `transaction-save-validation.test.js` pins it differentially against\n" +
      " * `aggregateSchema`.\n" +
      " */\n" +
      "export function assertTransactionSave(payload) {\n" +
      "  const text = JSON.stringify(payload);\n" +
      "  // `JSON.parse(undefined)` is the error the previous call reached through the\n" +
      "  // same expression; every other unrepresentable value already threw above.\n" +
      "  if (text === undefined) JSON.parse(text);\n" +
      "  else if (text.includes(`\"${PROTO_KEY}\"`)) withoutOwnProtoKeys(JSON.parse(text));\n" +
      "}\n" +
      "export function projectObservation(input = {}) {",
    pre: "const safeIdentifier = value => typeof value === 'string' && /^[a-zA-Z0-9_:./-]{1,160}$/.test(value) ? value : null;\n" +
      "export function projectObservation(input = {}) {" },
  { file: "lib/domain-storage.js",
    post: "    // `inlineSerialization` is honest here: `update` captures the bytes of the\n" +
      "    // payload it is handed with the synchronous `JSON.stringify` below, before\n" +
      "    // it returns, so the caller's live shallow view cannot change what is\n" +
      "    // checked. It keeps no snapshot of those bytes, and no reader of this store\n" +
      "    // wants one (see below).\n" +
      "    //\n" +
      "    // What that check does not do any more is keep the projection it used to\n" +
      "    // build and store. Two things were true of `aggregateSchema.parse(payload)`\n" +
      "    // at this call site, and only the second one is observable:\n" +
      "    //\n" +
      "    // - The value it returned was never read. The only commit path is\n" +
      "    //   `mutate()`, which publishes the snapshot it takes after `work()`\n" +
      "    //   returns; the next updater keeps only `evolution`, which it replaces\n" +
      "    //   wholesale; and the store's own `load()` has exactly two callers -\n" +
      "    //   `reconcile()` and `verifyConsistency()` - neither of which any port path\n" +
      "    //   reaches (`createMemory` itself loads the instance before a record\n" +
      "    //   exists). So the projection was built and dropped once per save, and a\n" +
      "    //   transaction saves once per appended record plus once for the bridge\n" +
      "    //   marker (`measurement-completed` 2, a rejected/failure pair 3,\n" +
      "    //   `canary-passed` 5-6): a burst projected the whole document once per save\n" +
      "    //   - 2 to 6 times per record, growing with the records the burst has\n" +
      "    //   already appended - and kept none of those projections.\n" +
      "    //\n" +
      "    // - Its exception behaviour is reproduced step for step. The preprocess\n" +
      "    //   (`toJsonProjection`) has three steps that can throw - the stringify, the\n" +
      "    //   parse of its output, and the recursive own-`__proto__` copy - and\n" +
      "    //   `assertTransactionSave` runs the same three in the same order, so a save\n" +
      "    //   still throws exactly where it threw (including the `SyntaxError` of\n" +
      "    //   parsing an `undefined` stringify and the `RangeError` of a copy that\n" +
      "    //   overflows). Only the parse on the common path is skipped, and that is the\n" +
      "    //   step that builds the deep copy nothing reads.\n" +
      "    //\n" +
      "    //   What is not reproduced is the schema's verdict on that projection, and it\n" +
      "    //   is fixed for this payload: its only own top-level key is `evolution`\n" +
      "    //   (every state this store holds is either the initial committed aggregate or\n" +
      "    //   a payload of the same shape, and the durable schema admits nothing else),\n" +
      "    //   and the only field the schema inspects inside it is an integer\n" +
      "    //   `schema >= 4`, which the durable document this port loads guarantees\n" +
      "    //   (`memory.js`'s `schema: Math.max(4, Number(...) || ...)` keeps it at every\n" +
      "    //   load and reconcile; the looser values a direct `restore()` could inject\n" +
      "    //   are outside this store's reach, because no port path calls it). Both\n" +
      "    //   events the port feeds this store are JSON-projected before they reach it\n" +
      "    //   (`projectExecutionEvent`, `safeRecord`, `projectObservation`), so a payload\n" +
      "    //   the verdict could reject is not reachable from here either.\n" +
      "    //\n" +
      "    // Keeping the stringify therefore keeps the only observable effect of the\n" +
      "    // removed call - the throw - on the exact same value, and the durable\n" +
      "    // document is still validated in full by the publication's `schema.parse`.\n" +
      "    const stateStore = { filePath: path.join(dir, 'state.json'), inlineSerialization: true, load: async () => aggregate,\n" +
      "      // `load` hands out the aggregate this factory already cloned from\n" +
      "      // `initial` above; it used to clone it a second time. The only reader of\n" +
      "      // that value is the instance created below, through exactly one\n" +
      "      // `EvolutionMemory.load()` (`loaded` guards any later call), which spreads\n" +
      "      // it into its own state and keeps the collection arrays - it keeps neither\n" +
      "      // the store's object nor a copy of it. The store's own later reader is the\n" +
      "      // `update` spread base below, and that spread replaces the only field the\n" +
      "      // aggregate carries (`evolution`, the one key `aggregateSchema` admits)\n" +
      "      // with the payload before the result is kept, so no reader ever observes\n" +
      "      // the second copy. This is the same shallow-view stance\n" +
      "      // `inlineSerialization: true` already takes for the payload `update` is\n" +
      "      // handed: neither direction keeps a snapshot of values no reader wants.\n" +
      "      // The eager `structuredClone(initial)` above stays, because it is what\n" +
      "      // detaches this transaction from the committed document (and refuses a\n" +
      "      // live value the medium could not store).\n" +
      "      update: async updater => {\n" +
      "        const next = updater(aggregate);\n" +
      "        assertTransactionSave(next);\n" +
      "        aggregate = next;\n" +
      "      } };\n",
    pre: "    // `inlineSerialization` is honest here: `update` captures the bytes with\n" +
      "    // the synchronous JSON projection inside `aggregateSchema.parse` before it\n" +
      "    // returns, so the caller's live shallow view cannot change what is\n" +
      "    // persisted. The projection already produces a fresh deep value, so the\n" +
      "    // extra clone of the incoming aggregate would only copy it twice; the\n" +
      "    // updaters handed to this store are pure (`{ ...state, [key]: payload }`)\n" +
      "    // and never mutate the argument they receive.\n" +
      "    const stateStore = { filePath: path.join(dir, 'state.json'), inlineSerialization: true, load: async () => structuredClone(aggregate),\n" +
      "      update: async updater => { aggregate = aggregateSchema.parse(updater(aggregate)); } };\n" },
  { file: "lib/domain-storage.js",
    post: "    const stateStore = { filePath: path.join(dir, 'state.json'), inlineSerialization: true, load: async () => structuredClone(aggregate),\n      update: async updater => { aggregate = aggregateSchema.parse(updater(aggregate)); } };\n    const instance = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority, archiveWriteGuard, deferLoadArchiveWrites, archiveReadCache, coalesceMeasurementMarkerPersist: archiveWriteGuard !== null });\n    // The load's own work is required (state restore, archive index\n    // reconciliation, eviction and archival); the hot projection it would\n    // return is not: no caller of this factory reads it.\n    await instance.load({ snapshot: false });\n    return { instance };\n  }\n  async function hydrate(archiveReadCache = memory?.archiveReadCache) {\n",
    pre: "    const stateStore = { filePath: path.join(dir, 'state.json'), inlineSerialization: true, load: async () => structuredClone(aggregate),\n      update: async updater => { aggregate = aggregateSchema.parse(updater(aggregate)); } };\n    const instance = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority, archiveWriteGuard, deferLoadArchiveWrites, archiveReadCache });\n    await instance.load();\n    return { instance };\n  }\n  async function hydrate(archiveReadCache = memory?.archiveReadCache) {\n" },
  { file: "lib/domain-storage.js",
    post: "    const before = fs.existsSync(index) ? fs.statSync(index).ino : null;\n    // The live tree is loaded without writing to it: a load-time eviction would\n    // append to a live archive file outside any staged transaction, and a crash\n    // there leaves a fragment no later append can repair. Over-limit records stay\n    // in this instance's hot projection and the next mutation archives them\n    // inside its own transaction, which is where archive writes belong.\n    const current = await createMemory(root, domain.global.get().aggregate, null, true, archiveReadCache);\n    memory = current.instance;\n    // The store is not read afterwards, and neither is the projection its\n    // `load()` would return, so the load is asked for without it. What\n    // `hydrate()` does need from the load is its cold-history read:\n    // `memory.hasColdHistory` derives `Number(count)` from every\n    // `coldArchives` entry and therefore rejects a durable aggregate whose\n    // entry cannot be coerced. Removing this call silently accepted the first\n    // commit after such a state was written; keeping it preserves the loud\n    // failure the released implementation has, with or without the projection.\n    observations = new EvolutionObservationStore({ memory });\n    await observations.load({ snapshot: false });\n    // Loading may repair the derived index by atomic replacement. Keep that\n    // repaired file durable before a later stage shares its inode.\n    if (fs.existsSync(index) && fs.statSync(index).ino !== before) { syncFile(index); syncFile(root); }\n",
    pre: "    const before = fs.existsSync(index) ? fs.statSync(index).ino : null;\n    // The live tree is loaded without writing to it: a load-time eviction would\n    // append to a live archive file outside any staged transaction, and a crash\n    // there leaves a fragment no later append can repair. Over-limit records stay\n    // in this instance's hot projection and the next mutation archives them\n    // inside its own transaction, which is where archive writes belong.\n    const current = await createMemory(root, domain.global.get().aggregate, null, true, archiveReadCache);\n    memory = current.instance;\n    // The store is not read afterwards, but `load()` is not inert: its\n    // `snapshot()` reads `memory.hasColdHistory`, which derives `Number(count)`\n    // from every `coldArchives` entry and therefore rejects a durable\n    // aggregate whose entry cannot be coerced. Removing this call silently\n    // accepted the first commit after such a state was written; keeping it\n    // preserves the loud failure the released implementation has.\n    observations = new EvolutionObservationStore({ memory });\n    await observations.load();\n    // Loading may repair the derived index by atomic replacement. Keep that\n    // repaired file durable before a later stage shares its inode.\n    if (fs.existsSync(index) && fs.statSync(index).ino !== before) { syncFile(index); syncFile(root); }\n" }
];

/** The working sources and the same three files with every hunk reversed. */
export async function loadProjectionBaseline() {
  const working = new Map();
  for (const file of FILES) working.set(file, await readFile(join(REPO_ROOT, file), "utf8"));
  const reconstructed = new Map(working);
  for (const { file, post, pre } of HUNKS) {
    const source = reconstructed.get(file);
    assert.ok(source !== undefined, `${file} is not part of the projection-free load round`);
    assert.equal(source.split(post).length - 1, 1,
      `${file}: the post-change shape must occur exactly once before reconstruction`);
    reconstructed.set(file, source.replace(post, pre));
  }
  for (const [file, source] of reconstructed) {
    assert.notEqual(source, working.get(file), `${file}: the reconstruction must actually change the source`);
  }
  return { working, reconstructed, hunks: HUNKS.length };
}

/**
 * A full pre-change `lib/` tree, imported as a real module. `node_modules` is a
 * symlink to this repository's, so the tree and the working tree share one copy
 * of `zod` and of the official packages - the comparison is two implementations
 * over the same dependencies, which is what makes the persisted bytes
 * comparable at all.
 */
export async function materializeProjectionBaselineTree(home) {
  const { reconstructed } = await loadProjectionBaseline();
  const directory = join(home, "projection-baseline");
  await mkdir(directory, { recursive: true });
  await cp(LIB, join(directory, "lib"), { recursive: true });
  for (const [file, source] of reconstructed) await writeFile(join(directory, file), source);
  await symlink(join(REPO_ROOT, "node_modules"), join(directory, "node_modules"), "dir");
  const modulePath = join(directory, "lib", "domain-storage.js");
  const module = await import(pathToFileURL(modulePath).href);
  assert.equal(typeof module.openDomainStorage, "function", "the baseline tree must export openDomainStorage");
  return { directory, modulePath, openDomainStorage: module.openDomainStorage };
}
