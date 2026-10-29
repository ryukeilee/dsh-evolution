import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REPO_ROOT } from "../../scripts/release/release-lib.mjs";
import { reverseMarkerWindowRound } from "./marker-window-baseline.js";
import { STAGED_SAVE_CHECK_TEXT } from "./staged-save-check-text.js";

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
  // The archive-append-window round is reversed first, so every hunk below it
  // still matches the tree it was written against: that round added the bridge
  // window index, the archive directory memo and the single identity `stat`, and
  // moved the torn-tail probe's size from its own `stat` to the caller's. Each
  // pair is `[post-change text, pre-change text]` as an exact substring.
  { file: "lib/dockyard-domain/memory.js",
    post: "/**\n * The id a bridge marker window entry is compared by, or `null` when that id is\n * not decided by the entry's own data.\n *\n * `#bridgeApplied()` compares `String(entry?.eventId ?? entry)`. For a plain\n * object with an own data property `eventId` holding a string that expression is\n * the property itself, so the whole window can be indexed once instead of\n * re-deriving the answer per lookup. (Enumerable or not, an own data property is\n * what the expression reads; only an accessor or an absent property changes it.) Everything else can run code or\n * answer from outside the entry, and each of those would make an index answer\n * something the expression has not been asked yet:\n *\n *   - a bare string is not its own id in that expression: `entry.eventId` reads\n *     `String.prototype.eventId`, so a `String.prototype.eventId` defined after\n *     the index was built would change the answer;\n *   - an accessor, an inherited or `undefined` `eventId`, an array, a nested\n *     value or a non-plain prototype either runs code or falls back to\n *     `String(entry)`.\n *\n * Those windows keep the untouched linear scan.\n */\nfunction bridgeWindowId(entry) {\n  if (entry === null || typeof entry !== \"object\" || Array.isArray(entry)) return null;\n  const prototype = Object.getPrototypeOf(entry);\n  if (prototype !== Object.prototype && prototype !== null) return null;\n  const descriptor = Object.getOwnPropertyDescriptor(entry, \"eventId\");\n  if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) return null;\n  return typeof descriptor.value === \"string\" ? descriptor.value : null;\n}\n\n/** Durable, redacted memory for proposals, experiments, failures, and promotions. */",
    pre: "/** Durable, redacted memory for proposals, experiments, failures, and promotions. */" },
  { file: "lib/dockyard-domain/memory.js",
    post: "  // Cache for `#bridgeApplied()`: the window array it describes and the marker\n  // ids in it (`null` when this window cannot be indexed). See `#bridgeApplied`.\n  #bridgeWindow;\n",
    pre: "" },
  { file: "lib/dockyard-domain/memory.js",
    post: "    // Directories this instance has already created. `mkdirSync(recursive)` on\n    // an existing directory is a syscall that answers a question this instance\n    // has already answered; it is re-asked after any write it was needed for\n    // fails. See `#archiveEntries`.\n    this.archiveDirectoriesReady = new Set();\n    // Faults this process observed on cold archive bytes and cold archive",
    pre: "    // Faults this process observed on cold archive bytes and cold archive" },
  { file: "lib/dockyard-domain/memory.js",
    post: "   *\n   * `size` is the byte count the caller already read from the file's identity.\n   */",
    pre: "   */" },
  { file: "lib/dockyard-domain/memory.js",
    post: "  #activeTailIsTorn(path, size) {\n    if (!(size > 0)) return false;\n    const handle = openSync(path, \"r\");",
    pre: "  #activeTailIsTorn(path) {\n    let size = 0;\n    try { size = statSync(path).size; } catch { return false; }\n    if (size === 0) return false;\n    const handle = openSync(path, \"r\");" },
  { file: "lib/dockyard-domain/memory.js",
    post: "  /**\n   * Append bytes to an archive file, creating its directory when this instance has\n   * not created it yet.\n   *\n   * `mkdirSync(recursive)` on a directory that already exists is still a syscall\n   * that answers a question this instance has already answered, and a cold\n   * absorption asks it once per archived record. The memo is only a skip: a\n   * directory that disappeared anyway (`ENOENT` from the append) is re-created and\n   * the append retried once, which is exactly what the unconditional `mkdir`\n   * before every append did.\n   */\n  async #appendArchiveBytes(directory, path, payload) {\n    if (!this.archiveDirectoriesReady.has(directory)) {\n      mkdirSync(directory, { recursive: true, mode: 0o700 });\n      this.archiveDirectoriesReady.add(directory);\n    }\n    try { await appendFile(path, payload, { mode: 0o600 }); }\n    catch (error) {\n      if (error?.code !== 'ENOENT' || !this.archiveDirectoriesReady.delete(directory)) throw error;\n      mkdirSync(directory, { recursive: true, mode: 0o700 });\n      this.archiveDirectoriesReady.add(directory);\n      await appendFile(path, payload, { mode: 0o600 });\n    }\n  }\n\n  async #archiveEntries(collection, entries, { replaceExisting = false } = {}) {",
    pre: "  async #archiveEntries(collection, entries, { replaceExisting = false } = {}) {" },
  { file: "lib/dockyard-domain/memory.js",
    post: "      const directory = dirname(path);\n      // The key table is what decides which entries the archive already owns and",
    pre: "      // The key table is what decides which entries the archive already owns and" },
  { file: "lib/dockyard-domain/memory.js",
    post: "        // One `stat` answers what two separate stats asked before: how large the\n        // active file is, and how large the byte the torn-tail probe reads is.\n        const identity = this.#archiveAppendIdentity(path);\n        // Chunk before writing. The old migration path serialized the whole",
    pre: "        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });\n        // Chunk before writing. The old migration path serialized the whole" },
  { file: "lib/dockyard-domain/memory.js",
    post: "        let activeBytes = identity === null ? 0 : Number(identity.size);\n        // A torn active tail is repaired before anything is appended: the",
    pre: "        let activeBytes = 0;\n        try { activeBytes = statSync(path).size; } catch { activeBytes = 0; }\n        // A torn active tail is repaired before anything is appended: the" },
  { file: "lib/dockyard-domain/memory.js",
    post: "        if (activeBytes > 0 && this.#activeTailIsTorn(path, activeBytes)) {\n          if (await this.#activeTailIsComplete(path)) {",
    pre: "        if (activeBytes > 0 && this.#activeTailIsTorn(path)) {\n          if (await this.#activeTailIsComplete(path)) {" },
  { file: "lib/dockyard-domain/memory.js",
    post: "            await this.#appendArchiveBytes(directory, path, \"\\n\");\n            activeBytes += 1;",
    pre: "            await appendFile(path, \"\\n\", { mode: 0o600 });\n            activeBytes += 1;" },
  { file: "lib/dockyard-domain/memory.js",
    post: "          await this.#appendArchiveBytes(directory, path, payload);\n          activeBytes += Buffer.byteLength(payload);",
    pre: "          await appendFile(path, payload, { mode: 0o600 });\n          activeBytes += Buffer.byteLength(payload);" },
  { file: "lib/dockyard-domain/memory.js",
    post: "            await this.#appendArchiveBytes(directory, path, line + \"\\n\");\n            activeBytes += lineBytes;",
    pre: "            await appendFile(path, line + \"\\n\", { mode: 0o600 });\n            activeBytes += lineBytes;" },
  { file: "lib/dockyard-domain/memory.js",
    post: "        // A retry re-creates the directory instead of trusting the answer this\n        // attempt took from it.\n        this.archiveDirectoriesReady.delete(directory);\n        this.archiveKnown.set(collection, known);",
    pre: "        this.archiveKnown.set(collection, known);" },
  { file: "lib/dockyard-domain/memory.js",
    post: "  /**\n   * Whether this memory has already applied `eventId`, answered from the bridge\n   * marker window (`eventBridge.applied`, the last 4096 records).\n   *\n   * The window is bounded but the answer is a set-membership question, and the\n   * window answers it the same way until it changes: `#markBridgeApplied()` is\n   * the only writer, it appends one marker and drops the window's head, and no\n   * other path writes into a marker. The ids of a window whose entries all carry\n   * their id as data (`bridgeWindowId`) are therefore derived once and kept\n   * current by that one writer, and a lookup costs one `Map` probe instead of a\n   * scan over 4096 entries per applied record - which is 82 million comparisons\n   * over a 20,000-record absorption. Any other window shape, and any window this\n   * instance did not build, keeps the untouched linear scan, so the answer and\n   * the reads it performs are exactly the released ones.\n   */\n  #bridgeApplied(eventId) {",
    pre: "  #bridgeApplied(eventId) {" },
  { file: "lib/dockyard-domain/memory.js",
    post: "    const applied = this.#data.eventBridge?.applied ?? [];\n    if (!Array.isArray(applied)) return applied.some((entry) => String(entry?.eventId ?? entry) === eventId);\n    const state = this.#bridgeWindowFor(applied);\n    if (state.ids === null) return applied.some((entry) => String(entry?.eventId ?? entry) === eventId);\n    return state.ids.has(eventId);\n  }\n\n  /** The cached index for exactly this window array, rebuilt when it is another one. */\n  #bridgeWindowFor(applied) {\n    const cached = this.#bridgeWindow;\n    if (cached !== undefined && cached.applied === applied) return cached;\n    let ids = new Map();\n    for (const entry of applied) {\n      const id = bridgeWindowId(entry);\n      if (id === null) { ids = null; break; }\n      ids.set(id, (ids.get(id) ?? 0) + 1);\n    }\n    const state = { applied, ids };\n    this.#bridgeWindow = state;\n    return state;\n  }\n\n  /**\n   * Carry the window's index across the one append-and-trim this instance does.\n   * The map is mutated in place: no reader keeps it past the lookup that reads\n   * it, and re-creating it would cost the scan this exists to avoid.\n   */\n  #bridgeWindowShifted(previous, pushed, trimmed) {\n    const dropped = pushed.length - trimmed.length;\n    const ids = previous.ids;\n    if (ids === null || previous.applied !== pushed) { this.#bridgeWindow = { applied: trimmed, ids: null }; return; }\n    for (let index = 0; index < dropped; index += 1) {\n      const id = bridgeWindowId(pushed[index]);\n      if (id === null) { this.#bridgeWindow = { applied: trimmed, ids: null }; return; }\n      const remaining = (ids.get(id) ?? 0) - 1;\n      if (remaining > 0) ids.set(id, remaining);\n      else ids.delete(id);\n    }\n    const added = bridgeWindowId(trimmed[trimmed.length - 1]);\n    if (added === null) { this.#bridgeWindow = { applied: trimmed, ids: null }; return; }\n    ids.set(added, (ids.get(added) ?? 0) + 1);\n    this.#bridgeWindow = { applied: trimmed, ids };\n  }",
    pre: "    return (this.#data.eventBridge?.applied ?? []).some((entry) => String(entry?.eventId ?? entry) === eventId);\n  }" },
  { file: "lib/dockyard-domain/memory.js",
    post: "    // The index this append has to update describes the window before it. A\n    // window this instance did not build is indexed first, once, rather than\n    // left unindexed for every later lookup.\n    const previous = this.#bridgeWindowFor(applied);\n    // A marker is written once and never edited afterwards: the window only",
    pre: "    // A marker is written once and never edited afterwards: the window only" },
  { file: "lib/dockyard-domain/memory.js",
    post: "    this.#bridgeWindowShifted(previous, applied, this.#data.eventBridge.applied);\n    // In the staged domain transaction, a measurement's first save has already",
    pre: "    // In the staged domain transaction, a measurement's first save has already" },
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
      STAGED_SAVE_CHECK_TEXT +
      "export function projectObservation(input = {}) {",
    pre: "const safeIdentifier = value => typeof value === 'string' && /^[a-zA-Z0-9_:./-]{1,160}$/.test(value) ? value : null;\n" +
      "export function projectObservation(input = {}) {" },
  { file: "lib/domain-storage.js",
    post: "    let aggregate = structuredClone(initial);\n" +
      "    // The bridge markers this transaction's saves reuse verdicts for; it lives\n" +
      "    // exactly as long as this working store (see `assertStagedTransactionSave`).\n" +
      "    const markerVerdicts = new WeakMap();\n" +
      "    // `inlineSerialization` is honest here: `update` captures the bytes of the\n" +
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
      "        assertStagedTransactionSave(next, markerVerdicts);\n" +
      "        aggregate = next;\n" +
      "      } };\n",
    pre: "    let aggregate = structuredClone(initial);\n" +
      "    // `inlineSerialization` is honest here: `update` captures the bytes with\n" +
      "    // the synchronous JSON projection inside `aggregateSchema.parse` before it\n" +
      "    // returns, so the caller's live shallow view cannot change what is\n" +
      "    // persisted. The projection already produces a fresh deep value, so the\n" +
      "    // extra clone of the incoming aggregate would only copy it twice; the\n" +
      "    // updaters handed to this store are pure (`{ ...state, [key]: payload }`)\n" +
      "    // and never mutate the argument they receive.\n" +
      "    const stateStore = { filePath: path.join(dir, 'state.json'), inlineSerialization: true, load: async () => structuredClone(aggregate),\n" +
      "      update: async updater => { aggregate = aggregateSchema.parse(updater(aggregate)); } };\n" },
  { file: "lib/domain-storage.js",
    post: "    const stateStore = { filePath: path.join(dir, 'state.json'), inlineSerialization: true, load: async () => structuredClone(aggregate),\n      update: async updater => { aggregate = aggregateSchema.parse(updater(aggregate)); } };\n    const instance = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority, archiveWriteGuard, deferLoadArchiveWrites, archiveReadCache, coalesceMeasurementMarkerPersist: archiveWriteGuard !== null, deferArchiveIndexWrites: archiveWriteGuard !== null });\n    // The load's own work is required (state restore, archive index\n    // reconciliation, eviction and archival); the hot projection it would\n    // return is not: no caller of this factory reads it.\n    await instance.load({ snapshot: false });\n    return { instance };\n  }\n  async function hydrate(archiveReadCache = memory?.archiveReadCache) {\n",
    pre: "    const stateStore = { filePath: path.join(dir, 'state.json'), inlineSerialization: true, load: async () => structuredClone(aggregate),\n      update: async updater => { aggregate = aggregateSchema.parse(updater(aggregate)); } };\n    const instance = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority, archiveWriteGuard, deferLoadArchiveWrites, archiveReadCache });\n    await instance.load();\n    return { instance };\n  }\n  async function hydrate(archiveReadCache = memory?.archiveReadCache) {\n" },
  { file: "lib/domain-storage.js",
    post: "    const before = fs.existsSync(index) ? fs.statSync(index).ino : null;\n    // The live tree is loaded without writing to it: a load-time eviction would\n    // append to a live archive file outside any staged transaction, and a crash\n    // there leaves a fragment no later append can repair. Over-limit records stay\n    // in this instance's hot projection and the next mutation archives them\n    // inside its own transaction, which is where archive writes belong.\n    const current = await createMemory(root, domain.global.get().aggregate, null, true, archiveReadCache);\n    memory = current.instance;\n    // The store is not read afterwards, and neither is the projection its\n    // `load()` would return, so the load is asked for without it. What\n    // `hydrate()` does need from the load is its cold-history read:\n    // `memory.hasColdHistory` derives `Number(count)` from every\n    // `coldArchives` entry and therefore rejects a durable aggregate whose\n    // entry cannot be coerced. Removing this call silently accepted the first\n    // commit after such a state was written; keeping it preserves the loud\n    // failure the released implementation has, with or without the projection.\n    observations = new EvolutionObservationStore({ memory });\n    await observations.load({ snapshot: false });\n    // Loading may repair the derived index by atomic replacement. Keep that\n    // repaired file durable before a later stage shares its inode.\n    if (fs.existsSync(index) && fs.statSync(index).ino !== before) { syncFile(index); syncFile(root); }\n",
    pre: "    const before = fs.existsSync(index) ? fs.statSync(index).ino : null;\n    // The live tree is loaded without writing to it: a load-time eviction would\n    // append to a live archive file outside any staged transaction, and a crash\n    // there leaves a fragment no later append can repair. Over-limit records stay\n    // in this instance's hot projection and the next mutation archives them\n    // inside its own transaction, which is where archive writes belong.\n    const current = await createMemory(root, domain.global.get().aggregate, null, true, archiveReadCache);\n    memory = current.instance;\n    // The store is not read afterwards, but `load()` is not inert: its\n    // `snapshot()` reads `memory.hasColdHistory`, which derives `Number(count)`\n    // from every `coldArchives` entry and therefore rejects a durable\n    // aggregate whose entry cannot be coerced. Removing this call silently\n    // accepted the first commit after such a state was written; keeping it\n    // preserves the loud failure the released implementation has.\n    observations = new EvolutionObservationStore({ memory });\n    await observations.load();\n    // Loading may repair the derived index by atomic replacement. Keep that\n    // repaired file durable before a later stage shares its inode.\n    if (fs.existsSync(index) && fs.statSync(index).ino !== before) { syncFile(index); syncFile(root); }\n" },
  // The staged-save and archive-key-table round is newer than this baseline, so
  // it is reversed here as well: the reconstructed tree is the tree that existed
  // before it, which is what makes the byte comparison below compare the two
  // implementations of those two changes instead of only the load round.
  { file: "lib/dockyard-domain/memory.js",
    post: "    // A marker is written once and never edited afterwards: the window only\n    // drops its head and appends a new marker. Freezing it states that as a\n    // property of the value instead of a convention, which is what lets the\n    // port's transaction store judge a marker once instead of re-serializing the\n    // whole window on every save (`assertStagedTransactionSave` in\n    // `domain-storage.js`). The window array itself stays mutable - `#bridgeApplied`\n    // scans it and this method appends to it - and so does the wrapper object.\n    applied.push(Object.freeze({\n      eventId: event.eventId,\n      eventType: event.eventType,\n      experimentId: event.experimentId,\n      appliedAt: timestamp(this.clock),\n    }));\n",
    pre: "    applied.push({\n      eventId: event.eventId,\n      eventType: event.eventType,\n      experimentId: event.experimentId,\n      appliedAt: timestamp(this.clock),\n    });\n" },
  { file: "lib/dockyard-domain/memory.js",
    post: "      this.#freezeBridgeMarkers();\n",
    pre: "" },
  { file: "lib/dockyard-domain/memory.js",
    post: "  /**\n   * Freeze the bridge marker window's entries, so the port's transaction store\n   * can tell an immutable marker from one it must judge again on every save\n   * (`assertStagedTransactionSave` in `domain-storage.js`). Nothing writes into\n   * an existing marker: `#markBridgeApplied()` appends a new one and drops the\n   * window's head, and `#bridgeApplied()` only reads them. The freeze here is\n   * shallow, and it is not by itself a promise about the values inside a marker:\n   * the store only reuses a marker whose own fields are all primitive, and keeps\n   * judging any other window in full on every save.\n   *\n   * Only `load()` calls this. A window installed by `restore()` or `reconcile()`\n   * keeps its markers as they are, which costs the store nothing but the\n   * re-serialization it did before (that window cannot be memoized) and cannot\n   * make it accept something the whole-document check would reject.\n   */\n  #freezeBridgeMarkers() {\n    const window = this.#data.eventBridge?.applied;\n    if (!Array.isArray(window)) return;\n    for (const marker of window) {\n      if (!marker || typeof marker !== \"object\" || Array.isArray(marker) || Object.isFrozen(marker)) continue;\n      Object.freeze(marker);\n    }\n  }\n\n",
    pre: "" },
  { file: "lib/dockyard-domain/memory.js",
    post: "      // The live tables are used in place: the contents they are left with are\n      // exactly what the previous version produced by handing out copies, so\n      // every reader (`#setArchiveMetadata`, `#append`'s archived-key check,\n      // `compact`) sees the same keys at the same points. A copy per attempt is\n      // quadratic in the archive: the table grows with every archived record\n      // (20,000 keys at 20,000 records), and it was copied up to four times per\n      // appended row only to be able to restore contents that `addedKnown` and\n      // `toggledTombstones` restore exactly, at the cost of this attempt's own\n      // entries.\n      const known = this.archiveKnown.get(collection) ?? new Set(existingByKey.keys());\n      const tombstones = this.archiveTombstones.get(collection) ?? new Set();\n      const addedKnown = [];\n      const toggledTombstones = [];\n      // A key the archive already owns is skipped: its archived value is the\n      // record. A key marked stale is the exception - the archive holds an\n      // older value and this append is the update that reaches it.\n      const stale = this.archiveStale.get(collection) ?? null;\n      const fresh = [];\n      for (const entry of entries) {\n        if (!entry || typeof entry !== \"object\") continue;\n        const key = this.#archiveKey(entry);\n        if (known.has(key) && !replaceExisting && !stale?.has(key)) continue;\n        const previous = previousOf(key);\n        try { if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(entry)) continue; } catch {}\n        if (!known.has(key)) { known.add(key); addedKnown.push(key); }\n        existingByKey.set(key, entry);\n        const retired = this.#isTombstone(entry, collection);\n        if (tombstones.has(key) !== retired) {\n          toggledTombstones.push([key, !retired]);\n          if (retired) tombstones.add(key);\n          else tombstones.delete(key);\n        }\n        fresh.push(entry);\n      }\n",
    pre: "      const known = new Set(this.archiveKnown.get(collection) ?? existingByKey.keys());\n      const tombstones = new Set(this.archiveTombstones.get(collection) ?? []);\n      const originalKnown = new Set(known);\n      const originalTombstones = new Set(tombstones);\n      // A key the archive already owns is skipped: its archived value is the\n      // record. A key marked stale is the exception - the archive holds an\n      // older value and this append is the update that reaches it.\n      const stale = this.archiveStale.get(collection) ?? null;\n      const fresh = [];\n      for (const entry of entries) {\n        if (!entry || typeof entry !== \"object\") continue;\n        const key = this.#archiveKey(entry);\n        if (known.has(key) && !replaceExisting && !stale?.has(key)) continue;\n        const previous = previousOf(key);\n        try { if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(entry)) continue; } catch {}\n        known.add(key);\n        existingByKey.set(key, entry);\n        if (this.#isTombstone(entry, collection)) tombstones.add(key);\n        else tombstones.delete(key);\n        fresh.push(entry);\n      }\n" },
  { file: "lib/dockyard-domain/memory.js",
    post: "      } catch (error) {\n        // Undo this attempt's own entries and re-publish the same tables. The\n        // contents are the ones the attempt started with (including a table\n        // another read installed while this one was awaiting, which the\n        // previous full-copy assignment overwrote in exactly the same way). The\n        // tombstone toggles are undone in reverse: two entries of the same key\n        // in one attempt toggle it twice, and only the last write is the one a\n        // forward undo must overwrite first.\n        for (const key of addedKnown) known.delete(key);\n        for (const [key, wasTombstone] of toggledTombstones.reverse()) {\n          if (wasTombstone) tombstones.add(key);\n          else tombstones.delete(key);\n        }\n        this.archiveKnown.set(collection, known);\n        this.archiveTombstones.set(collection, tombstones);\n        this.#noteArchiveFault(collection, { file: path, line: null, kind: \"deferred-write\", code: error?.code ?? null, reason: error?.message ?? String(error) });\n        return false;\n      }\n",
    pre: "      } catch (error) {\n        this.archiveKnown.set(collection, originalKnown);\n        this.archiveTombstones.set(collection, originalTombstones);\n        this.#noteArchiveFault(collection, { file: path, line: null, kind: \"deferred-write\", code: error?.code ?? null, reason: error?.message ?? String(error) });\n        return false;\n      }\n" },
];

/**
 * The SHA-256 of the tree this reconstruction is pinned to.
 *
 * The reversal table only proves that every hunk still finds its own post-change
 * shape; it does not prove that the shapes it leaves behind are the pre-change
 * source. A hunk that stops covering part of a later round reconstructs a
 * *third* tree that merely looks plausible, and both sides of the differential
 * then run the same new code - which is the one failure this anchor exists to
 * prevent. Pinning the digest makes that drift loud instead of silent. Updating
 * a number here means re-deriving every hunk of every round since, not editing
 * the expectation.
 */
const PRE_CHANGE_TREE = {
  "lib/dockyard-domain/memory.js": "2c1039ee225ef14817031e70fb9a9683ca1bc8ded0aef93ba0aa949c95859c6a",
  "lib/dockyard-domain/observation.js": "d505692dccd0c6afe13d73dad639e5b0b5320ef26e6fdae9453a5f5dcd638ee1",
  "lib/domain-storage.js": "886aad88060393910ed83f52e91e3efdc31dd3684cbaf093e8cb95d011a3af5c",
};

/** The working sources and the same three files with every hunk reversed. */
export async function loadProjectionBaseline() {
  const working = new Map();
  for (const file of FILES) working.set(file, await readFile(join(REPO_ROOT, file), "utf8"));
  const reconstructed = new Map([...working].map(([file, source]) => [file, reverseMarkerWindowRound(file, source)]));
  for (const { file, post, pre } of HUNKS) {
    const source = reconstructed.get(file);
    assert.ok(source !== undefined, `${file} is not part of the projection-free load round`);
    assert.equal(source.split(post).length - 1, 1,
      `${file}: the post-change shape must occur exactly once before reconstruction`);
    reconstructed.set(file, source.replace(post, pre));
  }
  for (const [file, source] of reconstructed) {
    assert.notEqual(source, working.get(file), `${file}: the reconstruction must actually change the source`);
    assert.equal(createHash("sha256").update(source).digest("hex"), PRE_CHANGE_TREE[file],
      `${file}: the reversed tree must be the pre-change source, not a partially reversed one`);
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
