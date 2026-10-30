import assert from "node:assert/strict";
import { reconstructPreObserveCache } from "./observe-cache-baseline.js";
import { readFile } from "node:fs/promises";
import { readReleaseManifest, readTarEntries, releaseArtifactPath } from "../../scripts/release/release-lib.mjs";
import { reconstructPreHousekeepingIndex } from "./housekeeping-baseline.js";

// Revert the shared-scan refactor plus every other change that landed after the
// rc.7 anchor, so the composed reconstruction still reaches the pinned source.
// Each pair is [post-change text, pre-change text]; exact, single-occurrence
// guards fail on any shape drift. The fragments are applied in order and each
// must match exactly once *at the point it is applied*: most regions are
// disjoint, but a few later fragments only take the shape they describe after an
// earlier reversal has restored it, so reordering them breaks the guards even
// though the composed result would be the same.
const reversals = [
  // A data-derived own `__proto__` key must not be lost on the way through
  // `redact()`: assigning that name on an ordinary object reaches the prototype
  // setter, so the pairs are collected and defined with `Object.fromEntries()`.
  // Reversing it restores the assignment this pin predates.
  ["  if (Array.isArray(value)) return value.map((entry) => redact(entry, \"\", seen)).filter((entry) => entry !== undefined);\n" +
   "  // The pairs are collected and defined with `Object.fromEntries()`: an own key\n" +
   "  // named `__proto__` (which `JSON.parse` really creates) must become an own\n" +
   "  // data property, while `output[entryKey] = normalized` would reach\n" +
   "  // `Object.prototype`'s `__proto__` setter, silently drop the key and make the\n" +
   "  // payload the output's prototype.\n" +
   "  const entries = [];\n" +
   "  for (const [entryKey, entry] of Object.entries(value)) {\n" +
   "    const normalized = redact(entry, entryKey, seen);\n" +
   "    if (normalized !== undefined) entries.push([entryKey, normalized]);\n" +
   "  }\n" +
   "  return Object.fromEntries(entries);",
   "  if (Array.isArray(value)) return value.map((entry) => redact(entry, \"\", seen)).filter((entry) => entry !== undefined);\n" +
   "  const output = {};\n" +
   "  for (const [entryKey, entry] of Object.entries(value)) {\n" +
   "    const normalized = redact(entry, entryKey, seen);\n" +
   "    if (normalized !== undefined) output[entryKey] = normalized;\n" +
   "  }\n" +
   "  return output;"],
  // This round stops rewriting the archive index when the only difference is the
  // clock-derived `updatedAt` stamp, and keeps a loaded entry in the shape it was
  // read in so a missing field is a repair like any other. Both are reversed here,
  // before the older reversals that rewrite the same regions.
  [   "          if (!sameIndexEntry(current, rebuilt)) changed = true;",
      "          if (JSON.stringify(current) !== JSON.stringify(rebuilt)) changed = true;"],
  [   "  /**\n" +
   "   * Read the persisted index. An entry is kept in the shape it was loaded with:\n" +
   "   * an older document may name only the file, and `#reconcileArchiveIndex()`\n" +
   "   * then sees the missing `collection` in the same comparison that reports any\n" +
   "   * other stale field, so the repair is decided by the entry itself rather than\n" +
   "   * by the clock.\n" +
   "   */\n",
   ""],
  [   "      if (file) entries.set(file, item);",
      "      if (file) entries.set(file, { ...item, collection });"],
  [   "        if (valid) {\n" +
   "          // The bytes are the ones this entry describes, so nothing is re-read\n" +
   "          // or re-hashed. The entry still has to carry the fields this\n" +
   "          // implementation writes for them: a document from an older version may\n" +
   "          // name only the file, and leaving that shape in place would never be\n" +
   "          // normalized now that an unchanged load no longer rewrites the index.\n" +
   "          const name = file.split(\"/\").at(-1);\n" +
   "          if (current.collection === collection && current.file === name) continue;\n" +
   "          this.archiveIndexEntries.set(file, { ...current, collection, file: name });\n" +
   "          changed = true;\n" +
   "          continue;\n" +
   "        }\n",
   "        if (valid) continue;\n"],
  [   "/**\n" +
   " * Whether a freshly scanned active-archive entry describes the same file state\n" +
   " * as the entry the loaded index already holds.\n" +
   " *\n" +
   " * `updatedAt` is a clock stamp, not content: `#reconcileActiveArchive()`\n" +
   " * re-derives it from `this.clock` on every load, so comparing it would report\n" +
   " * \"changed\" for bytes that did not change. Each such false change rewrites the\n" +
   " * whole index document on every load - a durable write on a read-only path, and\n" +
   " * it makes the staged index a changed file, which the domain transaction then\n" +
   " * fsyncs and installs, twice per write. Excluding the stamp leaves every\n" +
   " * content field (counts, byte size, digests, first/last record timestamps)\n" +
   " * deciding, and the fields are compared in sorted key order so an index written\n" +
   " * by another version with a different key order is not mistaken for a change\n" +
   " * either.\n" +
   " */\n" +
   "function sameIndexEntry(left, right) {\n" +
   "  if (!left || !right) return false;\n" +
   "  const comparable = entry => JSON.stringify(Object.keys(entry).filter(key => key !== \"updatedAt\").sort()\n" +
   "    .map(key => [key, entry[key]]));\n" +
   "  return comparable(left) === comparable(right);\n" +
   "}\n" +
   "\n",
   ""],
  // The torn-tail completeness round, which landed last. An unterminated final
  // line that already parses as a complete record keeps its bytes and gains only
  // the separator it lacks (`#activeTailIsComplete`); a genuine fragment still
  // moves to the quarantine file. Both regions sit inside spans that earlier
  // rounds changed, so these fragments are listed first and reversed first:
  // reverting them restores the shape every fragment below expects. The method
  // insert and the branch are disjoint from each other, so their mutual order is
  // free; what fixes their position is that they must precede the reversals that
  // own the surrounding text.
  ["  }\n" +
   "\n" +
   "  /**\n" +
   "   * Whether the active archive's unterminated final line is already a complete\n" +
   "   * record. An external writer that does not terminate its last line leaves one:\n" +
   "   * the reader parses it, so it must not be treated as a fragment and moved into\n" +
   "   * the quarantine file, which would drop it from `history()` while keeping its\n" +
   "   * bytes. Such a line only lacks the separator, and appending one byte supplies\n" +
   "   * it without rewriting or removing anything.\n" +
   "   */\n" +
   "  async #activeTailIsComplete(path) {\n" +
   "    let raw;\n" +
   "    try { raw = await readFile(path); } catch { return false; }\n" +
   "    const breakAt = raw.lastIndexOf(NEWLINE_BYTE);\n" +
   "    const fragment = breakAt === -1 ? raw : raw.subarray(breakAt + 1);\n" +
   "    if (!fragment.length) return false;\n" +
   "    try {\n" +
   "      const value = JSON.parse(fragment.toString(\"utf8\"));\n" +
   "      return Boolean(value) && typeof value === \"object\";\n" +
   "    } catch { return false; }\n",
   ""],
  ["          if (await this.#activeTailIsComplete(path)) {\n" +
   "            // The unterminated line is already a record, so it is kept and only\n" +
   "            // the separator it is missing is added; quarantining it would remove\n" +
   "            // a readable record from the history.\n" +
   "            await this.#beforeArchiveWrite(path);\n" +
   "            await appendFile(path, \"\\n\", { mode: 0o600 });\n" +
   "            activeBytes += 1;\n" +
   "          } else {\n" +
   "            const repaired = await this.#quarantineTornTail(collection, path);\n" +
   "            activeBytes = Buffer.byteLength(repaired.kept);\n" +
   "            this.#noteArchiveFault(collection, { file: path, line: null, kind: \"torn-tail\", quarantined: repaired.file, bytes: repaired.bytes });\n" +
   "            // The rewritten bytes are what the index entry and the active key set\n" +
   "            // describe from here on: the fragment's line and bytes are gone from\n" +
   "            // both.\n" +
   "            this.archiveIndexEntries.set(path, this.#indexEntryFromRaw(collection, path, repaired.kept, { sealed: false }));\n" +
   "            this.#activeKeysFromRaw(collection, repaired.kept);\n" +
   "          }\n",
   "          const repaired = await this.#quarantineTornTail(collection, path);\n" +
   "          activeBytes = Buffer.byteLength(repaired.kept);\n" +
   "          this.#noteArchiveFault(collection, { file: path, line: null, kind: \"torn-tail\", quarantined: repaired.file, bytes: repaired.bytes });\n" +
   "          // The rewritten bytes are what the index entry and the active key set\n" +
   "          // describe from here on: the fragment's line and bytes are gone from\n" +
   "          // both.\n" +
   "          this.archiveIndexEntries.set(path, this.#indexEntryFromRaw(collection, path, repaired.kept, { sealed: false }));\n" +
   "          this.#activeKeysFromRaw(collection, repaired.kept);\n"],
  // The append-identity round, which landed after the torn-tail round above. The
  // three regions below - the `#recordActiveArchiveWrite` signature, the chunked
  // append, and the single-line-over-target append - are disjoint from every other
  // fragment in this table and in the housekeeping table, so their own order is
  // free. `#extendArchiveReadCache` now carries an append forward only while the
  // identity taken *before* the append equals, field for field, the identity the
  // cache recorded for those bytes; the identity it records afterwards is read
  // from the file again, so a same-length rewrite by another writer is caught by
  // the mtime. The pre-append identity (`#archiveAppendIdentity`) is taken at both
  // append sites and threaded through `#recordActiveArchiveWrite`, so the method
  // signature and the two call sites move with it.
  ["  #recordActiveArchiveWrite(collection, records, before = null) {\n",
   "  #recordActiveArchiveWrite(collection, records) {\n"],
  ["          // The identity of the bytes the cached parse describes, taken before\n" +
   "          // the append that adds to them. See `#extendArchiveReadCache`.\n" +
   "          const before = this.#archiveAppendIdentity(path);\n" +
   "          await appendFile(path, payload, { mode: 0o600 });\n" +
   "          activeBytes += Buffer.byteLength(payload);\n" +
   "          this.#recordActiveArchiveWrite(collection, chunkRecords, before);\n",
   "          await appendFile(path, payload, { mode: 0o600 });\n" +
   "          activeBytes += Buffer.byteLength(payload);\n" +
   "          this.#recordActiveArchiveWrite(collection, chunkRecords);\n"],
  ["            // Same pre-append identity as the chunked path above: a single line\n" +
   "            // over the target is still an append to the file the cache parsed.\n" +
   "            const before = this.#archiveAppendIdentity(path);\n" +
   "            await appendFile(path, line + \"\\n\", { mode: 0o600 });\n" +
   "            activeBytes += lineBytes;\n" +
   "            this.#recordActiveArchiveWrite(collection, [{ entry: bounded.entry, line }], before);\n",
   "            await appendFile(path, line + \"\\n\", { mode: 0o600 });\n" +
   "            activeBytes += lineBytes;\n" +
   "            this.#recordActiveArchiveWrite(collection, [{ entry: bounded.entry, line }]);\n"],
  // The parse-cache round (`#readArchiveSync` rereads a file only when its identity
  // changed) and, before it, the cold-archive integrity round. Both landed after the
  // anchor, so their fragments are reversed before every region the anchor already
  // pins: the integrity fragments describe `#readArchiveSync` as that round left it,
  // which is the shape the parse-cache reversal restores.
  // The parse cache for the cold-archive read: the file identity a read is keyed by
  // (`#archiveReadParts`, `#archiveReadIdentity`), the known set derived from the scanned
  // positions (`#archiveKnownFrom`), the cache lookup, store and replay
  // (`#archiveReadCacheFor`, `#rememberArchiveRead`, `#replayArchiveRead`) and the append
  // carried into it (`#extendArchiveReadCache`), plus the read head that consults them.
  // One region: the helpers sit directly above the read they serve.
  ["  /**\n" +
   "   * The identity of every file `#readArchiveSync` reads for one collection, in\n" +
   "   * read order: device, inode, byte size and nanosecond mtime - the same\n" +
   "   * identity `archive-stage.js` and `archiveScanMemo` use to decide whether two\n" +
   "   * directory entries are the same bytes. Every way this plugin changes an\n" +
   "   * archive changes one of those fields: an append grows the size, sealing,\n" +
   "   * compaction and quarantine repair replace the inode, and a write from\n" +
   "   * outside this instance changes at least the mtime.\n" +
   "   *\n" +
   "   * Returns null when a listed file cannot be stat'ed or is not a regular file.\n" +
   "   * The caller then reads plainly, which is the path that reports an unreadable\n" +
   "   * archive as a fault.\n" +
   "   */\n" +
   "  #archiveReadParts(collection) {\n" +
   "    const files = this.#archiveFiles(collection);\n" +
   "    const parts = [];\n" +
   "    for (const file of files) {\n" +
   "      let info;\n" +
   "      try { info = statSync(file, { bigint: true }); } catch { return null; }\n" +
   "      if (!info.isFile()) return null;\n" +
   "      parts.push({ name: file.split(\"/\").at(-1), dev: String(info.dev), ino: String(info.ino), size: String(info.size), mtimeNs: String(info.mtimeNs) });\n" +
   "    }\n" +
   "    return { files, parts, identity: this.#archiveReadIdentity(parts) };\n" +
   "  }\n" +
   "\n" +
   "  #archiveReadIdentity(parts) {\n" +
   "    return parts.map((part) => `${part.name}\\u0000${part.dev}\\u0000${part.ino}\\u0000${part.size}\\u0000${part.mtimeNs}`).join(\"\\u0001\");\n" +
   "  }\n" +
   "\n" +
   "  /** `archiveKnown` for one scan: every key the files hold except the stale ones. */\n" +
   "  #archiveKnownFrom(collection, positions) {\n" +
   "    const known = new Set(positions.keys());\n" +
   "    const stale = this.archiveStale.get(collection);\n" +
   "    if (stale?.size) for (const key of stale) known.delete(key);\n" +
   "    return known;\n" +
   "  }\n" +
   "\n" +
   "  /**\n" +
   "   * The parse of one collection's cold archive files, keyed by\n" +
   "   * `#archiveReadIdentity`.\n" +
   "   *\n" +
   "   * Reading these files is how a caller learns what the archive holds, so the\n" +
   "   * answer is only reused for bytes this process has already parsed *and* whose\n" +
   "   * identity is unchanged. It is a cache of the file, never an index of it: a\n" +
   "   * miss runs the ordinary scan, an identity this method cannot build is a miss,\n" +
   "   * and the entry is dropped whenever an append cannot be carried forward\n" +
   "   * exactly. The records it holds are shared with the returned arrays, which is\n" +
   "   * what makes a hit cheap; every caller builds its own projection from them and\n" +
   "   * a caller asking for detached rows (`history`, `fullSnapshot`) still clones.\n" +
   "   *\n" +
   "   * Its memory is bounded by the cold tier itself: one parsed row per archived\n" +
   "   * record, which `compactionTriggerBytes` already bounds.\n" +
   "   */\n" +
   "  #archiveReadCacheFor(collection) {\n" +
   "    if (!this.archiveReadCache) this.archiveReadCache = new Map();\n" +
   "    return this.archiveReadCache.get(collection) ?? null;\n" +
   "  }\n" +
   "\n" +
   "  #rememberArchiveRead(collection, located, records, positions, tombstones, faults) {\n" +
   "    if (!this.archiveReadCache) this.archiveReadCache = new Map();\n" +
   "    this.archiveReadCache.set(collection, { identity: located.identity, parts: located.parts, records, positions, tombstones, faults });\n" +
   "  }\n" +
   "\n" +
   "  /**\n" +
   "   * Answer one read from the cached parse of exactly the bytes on disk. The\n" +
   "   * faults the scan observed are reported again, so a repeated read describes\n" +
   "   * them the same way a rescan does, and `archiveKnown` is rebuilt from the\n" +
   "   * cached positions rather than reused: callers mutate their copy.\n" +
   "   */\n" +
   "  #replayArchiveRead(collection, cached) {\n" +
   "    for (const fault of cached.faults) this.#noteArchiveFault(collection, fault);\n" +
   "    this.archiveKnown.set(collection, this.#archiveKnownFrom(collection, cached.positions));\n" +
   "    this.archiveTombstones.set(collection, new Set(cached.tombstones));\n" +
   "    return collection === \"tombstones\" ? [...cached.records] : cached.records.filter((entry) => !this.#isTombstone(entry, collection));\n" +
   "  }\n" +
   "\n" +
   "  /**\n" +
   "   * The identity of one archive file as it is at this moment, in exactly the\n" +
   "   * form `#archiveReadParts` records: name, device, inode, byte size and\n" +
   "   * nanosecond mtime. `null` when the file cannot be stat'ed or is not a regular\n" +
   "   * file, which every caller reads as \"no identity this process can prove\".\n" +
   "   */\n" +
   "  #archiveAppendIdentity(file) {\n" +
   "    let info;\n" +
   "    try { info = statSync(file, { bigint: true }); } catch { return null; }\n" +
   "    if (!info.isFile()) return null;\n" +
   "    return { name: file.split(\"/\").at(-1), dev: String(info.dev), ino: String(info.ino), size: String(info.size), mtimeNs: String(info.mtimeNs) };\n" +
   "  }\n" +
   "\n" +
   "  /**\n" +
   "   * Carry lines this instance just appended to the active archive file into that\n" +
   "   * collection's cached parse, instead of invalidating it.\n" +
   "   *\n" +
   "   * This is safe only under the facts this method checks. The active file has to\n" +
   "   * be the last file in the read order, so an append adds records behind every\n" +
   "   * record the scan already placed (first positions and latest-value-wins are\n" +
   "   * what a rescan would compute), and `before` - the identity of the file taken\n" +
   "   * *before* the appended bytes were written - has to equal, field for field,\n" +
   "   * the identity the cache recorded for those bytes. Only the pre-append\n" +
   "   * identity describes the bytes the cached parse holds; an identity read after\n" +
   "   * the append cannot vouch for them, because a same-length rewrite by another\n" +
   "   * writer leaves the size alone and moves only the mtime. Whenever it is not\n" +
   "   * exactly equal - including a mtime that moved - the entry is dropped and the\n" +
   "   * next read scans the file again. The same holds for a truncated or replaced\n" +
   "   * file, an unexpected inode, and a line that does not parse.\n" +
   "   */\n" +
   "  #extendArchiveReadCache(collection, file, appended, before) {\n" +
   "    const cached = this.#archiveReadCacheFor(collection);\n" +
   "    if (!cached) return;\n" +
   "    const last = cached.parts.at(-1);\n" +
   "    if (!last || last.name !== file.split(\"/\").at(-1)) { this.archiveReadCache.delete(collection); return; }\n" +
   "    if (!before || before.dev !== last.dev || before.ino !== last.ino || before.size !== last.size || before.mtimeNs !== last.mtimeNs) {\n" +
   "      this.archiveReadCache.delete(collection);\n" +
   "      return;\n" +
   "    }\n" +
   "    let appendedBytes = 0;\n" +
   "    for (const { line } of appended) appendedBytes += Buffer.byteLength(line) + 1;\n" +
   "    const { records, positions, tombstones } = cached;\n" +
   "    for (const { line } of appended) {\n" +
   "      let value;\n" +
   "      try { value = JSON.parse(line); } catch { this.archiveReadCache.delete(collection); return; }\n" +
   "      if (!value || typeof value !== \"object\") continue;\n" +
   "      const key = this.#archiveKey(value);\n" +
   "      const position = positions.get(key);\n" +
   "      if (position === undefined) { positions.set(key, records.length); records.push(value); }\n" +
   "      else records[position] = value;\n" +
   "      if (this.#isTombstone(value, collection)) tombstones.add(key);\n" +
   "      else tombstones.delete(key);\n" +
   "    }\n" +
   "    // The appended bytes are on disk now, so the cached parse holds exactly the\n" +
   "    // bytes the pre-append identity described plus these lines. The entry is\n" +
   "    // kept only while the file still holds exactly that: a file that grew by\n" +
   "    // anything else, or that is no longer the same entry, describes bytes this\n" +
   "    // parse does not cover. The identity recorded here is the identity of the\n" +
   "    // bytes the parse now holds, not a fact used to decide the carry-forward\n" +
   "    // above, which only the pre-append identity can decide.\n" +
   "    const after = this.#archiveAppendIdentity(file);\n" +
   "    if (!after || after.dev !== before.dev || after.ino !== before.ino || Number(after.size) !== Number(before.size) + appendedBytes) {\n" +
   "      this.archiveReadCache.delete(collection);\n" +
   "      return;\n" +
   "    }\n" +
   "    cached.parts = [...cached.parts.slice(0, -1), after];\n" +
   "    cached.identity = this.#archiveReadIdentity(cached.parts);\n" +
   "  }\n" +
   "\n" +
   "  #readArchiveSync(collection) {\n" +
   "    // One stat per archive file decides whether this read has to parse bytes\n" +
   "    // this process does not already hold. A knowledge-bearing append reads this\n" +
   "    // collection and the knowledge accumulator on every mutation, and the\n" +
   "    // records those reads return do not change between two appends, so without\n" +
   "    // this the cost of one mutation would grow with the whole cold history.\n" +
   "    const located = this.#archiveReadParts(collection);\n" +
   "    const files = located?.files ?? this.#archiveFiles(collection);\n",
   "  #readArchiveSync(collection) {\n" +
   "    const files = this.#archiveFiles(collection);\n"],
  // An empty file list drops the cached parse, and a read whose file identity is
  // unchanged is answered from the cache instead of parsing those bytes again.
  ["    if (!files.length) {\n" +
   "      this.archiveReadCache?.delete(collection);\n" +
   "      this.archiveKnown.set(collection, new Set());\n" +
   "      this.archiveTombstones.set(collection, new Set());\n" +
   "      return [];\n" +
   "    }\n" +
   "    const cached = this.#archiveReadCacheFor(collection);\n" +
   "    if (located && cached && cached.identity === located.identity) return this.#replayArchiveRead(collection, cached);\n",
   "    if (!files.length) {\n" +
   "      this.archiveKnown.set(collection, new Set());\n" +
   "      this.archiveTombstones.set(collection, new Set());\n" +
   "      return [];\n" +
   "    }\n"],
  // The faults the walk observes are collected as it goes, so a replay can report them
  // the same way a rescan does; the lines below report through that collector.
  ["    const records = [];\n" +
   "    const positions = new Map();\n" +
   "    const tombstones = new Set();\n" +
   "    const faults = [];\n" +
   "    const note = (fault) => { faults.push(fault); this.#noteArchiveFault(collection, fault); };\n" +
   "    const activeFile = this.#archivePath(collection);\n",
   "    const records = [];\n" +
   "    const positions = new Map();\n" +
   "    const tombstones = new Set();\n" +
   "    const activeFile = this.#archivePath(collection);\n"],
  // The unreadable-file fault goes through that collector.
  ["          note({ file, line: null, kind: \"unreadable\", code: error?.code ?? null });\n",
   "          this.#noteArchiveFault(collection, { file, line: null, kind: \"unreadable\", code: error?.code ?? null });\n"],
  // The invalid-line fault goes through that collector too.
  ["          note({ file, line: index + 1, kind, bytes: Buffer.byteLength(line) });\n",
   "          this.#noteArchiveFault(collection, { file, line: index + 1, kind, bytes: Buffer.byteLength(line) });\n"],
  // `archiveKnown` is rebuilt from the scanned positions instead of a local copy, and
  // only a read that could build a file identity is cached: without one there is nothing
  // to compare a later read against.
  ["    this.archiveKnown.set(collection, this.#archiveKnownFrom(collection, positions));\n" +
   "    this.archiveTombstones.set(collection, tombstones);\n" +
   "    // Only a read whose file identity could be built is cacheable: without it\n" +
   "    // there is nothing to compare a later read against.\n" +
   "    if (located) this.#rememberArchiveRead(collection, located, records, positions, tombstones, faults);\n",
   "    const stale = this.archiveStale.get(collection);\n" +
   "    const known = new Set(positions.keys());\n" +
   "    if (stale?.size) for (const key of stale) known.delete(key);\n" +
   "    this.archiveKnown.set(collection, known);\n" +
   "    this.archiveTombstones.set(collection, tombstones);\n"],
  // `#reconcileArchiveIndex()`: why the active file is parsed on every load, stated
  // where the recovery decision is made.
  ["          // An append lands before the index document that describes it, so a\n" +
   "          // crash can leave the file ahead of its entry. Parsing the active file\n" +
   "          // on every load is therefore the recovery, not a validation: a torn\n" +
   "          // tail is quarantined and reported, never dropped. Skipping it would\n" +
   "          // need the index to be authoritative about bytes written after it.\n" +
   "          // Active files are the bounded recovery surface after an append/index crash.\n",
   "          // Active files are the bounded recovery surface after an append/index crash.\n"],
  // `#reconcileArchiveIndex()`: why a sealed segment is accepted on its recorded size
  // alone without re-reading it.
  ["        // A sealed segment is written under a temporary name, renamed into place\n" +
   "        // and never appended to again, so this rebuild accepts its index entry\n" +
   "        // whenever the recorded byte size is still the file's size, without\n" +
   "        // reading or re-hashing the bytes. A change that keeps the size is\n" +
   "        // therefore invisible at load; `verifyConsistency()` is the operation\n" +
   "        // that re-reads and re-hashes every sealed segment and reports a digest\n" +
   "        // mismatch as `checksum`.\n",
   ""],
  // `#recordActiveArchiveWrite()`: the lines just appended are carried into the cached
  // parse instead of dropping it.
  ["    // The appended lines are on disk now, so the cached parse of these files can\n" +
   "    // carry them instead of being thrown away - but only under the identity the\n" +
   "    // file had before this append: see `#extendArchiveReadCache`.\n" +
   "    this.#extendArchiveReadCache(collection, file, records, before);\n",
   ""],
  // The cold-archive integrity round: the faults an archive read records and
  // `archiveIntegrity()` reports (`#noteArchiveFault`, `this.archiveFaults`), the stale
  // marks that keep a value whose write failed from being read as the record
  // (`this.archiveStale`, `#markArchiveStale`, `#resolveArchiveStale`), the torn-tail
  // quarantine (`#activeTailIsTorn`, `#quarantineTornTail`), the archival rollback that
  // restores the known and tombstone sets after a failed append, the knowledge append
  // that keeps a row hot instead of dropping it, and the `deferLoadArchiveWrites` load
  // hook that keeps a live load from appending to a live archive file.
  ["// Extracted domain algorithms; no legacy runtime imports. See domain-extraction-report.md.\n" +
   "import { createHash, randomUUID } from \"node:crypto\";\n" +
   "import { appendFile, copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from \"node:fs/promises\";\n" +
   "import { readFileSync, readdirSync, statSync } from \"node:fs\";\n" +
   "import { dirname, join } from \"node:path\";\n",
   "// Extracted domain algorithms; no legacy runtime imports. See domain-extraction-report.md.\n" +
   "import { createHash, randomUUID } from \"node:crypto\";\n" +
   "import { appendFile, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from \"node:fs/promises\";\n" +
   "import { readFileSync, readdirSync, statSync } from \"node:fs\";\n" +
   "import { dirname, join } from \"node:path\";\n"],
  ["const MEMORY_TOMBSTONE = \"__evolutionTombstone\";\n" +
   "const MEMORY_CONSOLIDATED = \"__evolutionConsolidated\";\n" +
   "// The JSONL record separator, as the byte an append must land after.\n" +
   "const NEWLINE_BYTE = 0x0a;\n" +
   "// At most this many cold-archive faults are remembered per collection.\n" +
   "const ARCHIVE_FAULT_LIMIT = 16;\n" +
   "// Faults a scan reported over bytes that could not become records. `torn-tail`\n" +
   "// is the active file's incomplete final line - an append that did not finish,\n" +
   "// which the next append quarantines and repairs - and stays out of this set\n" +
   "// because a restart after an interrupted append is expected to leave one.\n" +
   "const HARD_ARCHIVE_FAULTS = new Set([\"invalid-line\", \"unreadable\"]);\n" +
   "const DEFAULT_ARCHIVE_TARGET_BYTES = 8 * 1024 * 1024;\n" +
   "const DEFAULT_ARCHIVE_HARD_CEILING_BYTES = 16 * 1024 * 1024;\n",
   "const MEMORY_TOMBSTONE = \"__evolutionTombstone\";\n" +
   "const MEMORY_CONSOLIDATED = \"__evolutionConsolidated\";\n" +
   "const DEFAULT_ARCHIVE_TARGET_BYTES = 8 * 1024 * 1024;\n" +
   "const DEFAULT_ARCHIVE_HARD_CEILING_BYTES = 16 * 1024 * 1024;\n"],
  ["  #data;\n" +
   "\n" +
   "  constructor({ stateStore = null, key = \"evolution\", clock = () => new Date(), maxEntries = 1000, hotCycles = 50, hotEntries = 50, archiveMaxBytes = DEFAULT_ARCHIVE_TARGET_BYTES, absoluteMaxSegmentBytes = DEFAULT_ARCHIVE_HARD_CEILING_BYTES, compactionTriggerBytes = 48 * 1024 * 1024, compactionMinIntervalMs = 10 * 60_000, eventBridgePath = null, transaction = null, mutationAuthority = null, archiveWriteGuard = null, deferLoadArchiveWrites = false } = {}) {\n" +
   "    if (transaction !== null && typeof transaction.persist !== \"function\") throw new TypeError(\"transaction.persist must be a function\");\n" +
   "    if (archiveWriteGuard !== null && typeof archiveWriteGuard !== \"function\") throw new TypeError(\"archiveWriteGuard must be a function\");\n",
   "  #data;\n" +
   "\n" +
   "  constructor({ stateStore = null, key = \"evolution\", clock = () => new Date(), maxEntries = 1000, hotCycles = 50, hotEntries = 50, archiveMaxBytes = DEFAULT_ARCHIVE_TARGET_BYTES, absoluteMaxSegmentBytes = DEFAULT_ARCHIVE_HARD_CEILING_BYTES, compactionTriggerBytes = 48 * 1024 * 1024, compactionMinIntervalMs = 10 * 60_000, eventBridgePath = null, transaction = null, mutationAuthority = null, archiveWriteGuard = null } = {}) {\n" +
   "    if (transaction !== null && typeof transaction.persist !== \"function\") throw new TypeError(\"transaction.persist must be a function\");\n" +
   "    if (archiveWriteGuard !== null && typeof archiveWriteGuard !== \"function\") throw new TypeError(\"archiveWriteGuard must be a function\");\n"],
  ["    this.archiveTombstones = new Map();\n" +
   "    this.archiveWriting = Promise.resolve();\n" +
   "    // Keys whose archived copy is stale: an archive write for them failed while\n" +
   "    // the hot window kept the newer value, so the next eviction has to write\n" +
   "    // them even though the archive already owns their key. This describes the\n" +
   "    // hot window, not the file, so `#readArchiveSync` never touches it.\n" +
   "    this.archiveStale = new Map();\n" +
   "    // Faults this process observed on cold archive bytes and cold archive\n" +
   "    // writes, keyed by collection. See `archiveIntegrity()`.\n" +
   "    this.archiveFaults = new Map();\n" +
   "    // A live (unstaged) load must not append to live archive files: the caller\n" +
   "    // asks for that with this flag and the over-limit records stay in the hot\n" +
   "    // projection until the next staged mutation archives them in its own\n" +
   "    // transaction. Off by default, so an ordinary load keeps evicting.\n" +
   "    this.deferLoadArchiveWrites = deferLoadArchiveWrites === true;\n" +
   "    this.compacting = false;\n" +
   "    // Semantic-GC insurance trigger: periodic schedulers ask maintenance()\n",
   "    this.archiveTombstones = new Map();\n" +
   "    this.archiveWriting = Promise.resolve();\n" +
   "    this.compacting = false;\n" +
   "    // Semantic-GC insurance trigger: periodic schedulers ask maintenance()\n"],
  ["        const limit = this.#hotLimit(collection);\n" +
   "        if (this.archiveFile && this.#data[collection].length > limit) {\n" +
   "          // A deferred load leaves the excess in the hot projection instead of\n" +
   "          // appending to a live archive file outside any staged transaction.\n" +
   "          if (this.deferLoadArchiveWrites) continue;\n" +
   "          const evicted = this.#data[collection].slice(0, -limit);\n" +
   "          // The state file is still authoritative until the next successful\n",
   "        const limit = this.#hotLimit(collection);\n" +
   "        if (this.archiveFile && this.#data[collection].length > limit) {\n" +
   "          const evicted = this.#data[collection].slice(0, -limit);\n" +
   "          // The state file is still authoritative until the next successful\n"],
  ["  #isTombstone(entry, collection = null) { return collection !== \"tombstones\" && Boolean(entry && typeof entry === \"object\" && entry[MEMORY_TOMBSTONE] === 1); }\n" +
   "\n" +
   "  /**\n" +
   "   * Cold-archive faults this process observed, keyed by collection:\n" +
   "   * `torn-tail` is the incomplete final line of an active archive file, which\n" +
   "   * the next append quarantines and repairs; `invalid-line` and `unreadable`\n" +
   "   * are bytes a scan could not turn into records, so the logical history is\n" +
   "   * missing records the file still holds; `deferred-write` is an archive write\n" +
   "   * that failed while the caller kept the record in the hot window instead of\n" +
   "   * dropping it. A completed write to the same archive clears its\n" +
   "   * `deferred-write` fault. Empty when every observed read and write completed.\n" +
   "   */\n" +
   "  archiveIntegrity() {\n" +
   "    return Object.fromEntries([...this.archiveFaults].map(([collection, faults]) => [collection, faults.map((fault) => ({ ...fault }))]));\n" +
   "  }\n" +
   "\n" +
   "  #noteArchiveFault(collection, fault) {\n" +
   "    const faults = this.archiveFaults.get(collection) ?? [];\n" +
   "    const identity = (entry) => `${entry.kind}\\u0000${entry.file}\\u0000${entry.line ?? \"\"}`;\n" +
   "    const observed = { ...fault, at: timestamp(this.clock) };\n" +
   "    const index = faults.findIndex((entry) => identity(entry) === identity(observed));\n" +
   "    if (index < 0) faults.push(observed);\n" +
   "    else faults[index] = observed;\n" +
   "    if (faults.length > ARCHIVE_FAULT_LIMIT) faults.splice(0, faults.length - ARCHIVE_FAULT_LIMIT);\n" +
   "    this.archiveFaults.set(collection, faults);\n" +
   "  }\n" +
   "\n" +
   "  #clearArchiveWriteFaults(collection) {\n" +
   "    const faults = this.archiveFaults.get(collection);\n" +
   "    if (!faults?.some((fault) => fault.kind === \"deferred-write\")) return;\n" +
   "    const kept = faults.filter((fault) => fault.kind !== \"deferred-write\");\n" +
   "    if (kept.length) this.archiveFaults.set(collection, kept);\n" +
   "    else this.archiveFaults.delete(collection);\n" +
   "  }\n" +
   "\n" +
   "  /**\n" +
   "   * Remember that the archive's copy of one key is older than the hot row. The\n" +
   "   * key is not known to the archive until a completed append writes it again,\n" +
   "   * so evictions and housekeeping keep the row that carries the newer value.\n" +
   "   */\n" +
   "  #markArchiveStale(collection, key) {\n" +
   "    const keys = this.archiveStale.get(collection) ?? new Set();\n" +
   "    keys.add(key);\n" +
   "    this.archiveKnown.get(collection)?.delete(key);\n" +
   "    this.archiveStale.set(collection, keys);\n" +
   "  }\n" +
   "\n" +
   "  /** A key written by a completed append no longer has a stale archive copy. */\n" +
   "  #resolveArchiveStale(collection, entries) {\n" +
   "    const keys = this.archiveStale.get(collection);\n" +
   "    if (!keys?.size) return;\n" +
   "    for (const entry of entries) keys.delete(this.#archiveKey(entry));\n" +
   "    if (!keys.size) this.archiveStale.delete(collection);\n" +
   "  }\n" +
   "\n" +
   "  #readArchiveSync(collection) {\n" +
   "    const files = this.#archiveFiles(collection);\n",
   "  #isTombstone(entry, collection = null) { return collection !== \"tombstones\" && Boolean(entry && typeof entry === \"object\" && entry[MEMORY_TOMBSTONE] === 1); }\n" +
   "\n" +
   "  #readArchiveSync(collection) {\n" +
   "    const files = this.#archiveFiles(collection);\n"],
  ["    const positions = new Map();\n" +
   "    const tombstones = new Set();\n" +
   "    const activeFile = this.#archivePath(collection);\n" +
   "    for (const file of files) {\n" +
   "      let raw;\n" +
   "      try { raw = readFileSync(file, \"utf8\"); } catch (error) {\n" +
   "        // Every archive file other than this collection's active file is\n" +
   "        // expected to exist; a file that cannot be read is reported instead of\n" +
   "        // read as an empty archive.\n" +
   "        if (error?.code !== \"ENOENT\" || file !== activeFile) {\n" +
   "          this.#noteArchiveFault(collection, { file, line: null, kind: \"unreadable\", code: error?.code ?? null });\n" +
   "        }\n" +
   "        continue;\n" +
   "      }\n" +
   "      // A file that does not end with a newline ends inside a record. Only the\n" +
   "      // active file may legitimately end that way; anywhere else the bytes were\n" +
   "      // never readable as a record.\n" +
   "      const complete = raw.endsWith(\"\\n\");\n" +
   "      const lines = raw.split(\"\\n\");\n" +
   "      for (let index = 0; index < lines.length; index += 1) {\n" +
   "        const line = lines[index];\n" +
   "        if (!line.trim()) continue;\n" +
   "        try {\n",
   "    const positions = new Map();\n" +
   "    const tombstones = new Set();\n" +
   "    for (const file of files) {\n" +
   "      let raw;\n" +
   "      try { raw = readFileSync(file, \"utf8\"); } catch (error) {\n" +
   "        if (error?.code === \"ENOENT\") continue;\n" +
   "        continue;\n" +
   "      }\n" +
   "      for (const line of raw.split(\"\\n\")) {\n" +
   "        if (!line.trim()) continue;\n" +
   "        try {\n"],
  ["          if (this.#isTombstone(value, collection)) tombstones.add(key);\n" +
   "          else tombstones.delete(key);\n" +
   "        } catch {\n" +
   "          const last = index === lines.length - 1;\n" +
   "          const kind = last && !complete && file === activeFile ? \"torn-tail\" : \"invalid-line\";\n" +
   "          this.#noteArchiveFault(collection, { file, line: index + 1, kind, bytes: Buffer.byteLength(line) });\n" +
   "        }\n" +
   "      }\n" +
   "    }\n" +
   "    // A stale mark means the archive's value for that key is not the record:\n" +
   "    // an update could not be written, so the archive no longer owns the key.\n" +
   "    // Keeping it out of `archiveKnown` is what keeps every reader of that set -\n" +
   "    // eviction and housekeeping - from treating the old value as the record.\n" +
   "    const stale = this.archiveStale.get(collection);\n" +
   "    const known = new Set(positions.keys());\n" +
   "    if (stale?.size) for (const key of stale) known.delete(key);\n" +
   "    this.archiveKnown.set(collection, known);\n" +
   "    this.archiveTombstones.set(collection, tombstones);\n" +
   "    return collection === \"tombstones\" ? records : records.filter((entry) => !this.#isTombstone(entry, collection));\n",
   "          if (this.#isTombstone(value, collection)) tombstones.add(key);\n" +
   "          else tombstones.delete(key);\n" +
   "        } catch { /* a torn final line is ignored */ }\n" +
   "      }\n" +
   "    }\n" +
   "    this.archiveKnown.set(collection, new Set(positions.keys()));\n" +
   "    this.archiveTombstones.set(collection, tombstones);\n" +
   "    return collection === \"tombstones\" ? records : records.filter((entry) => !this.#isTombstone(entry, collection));\n"],
  ["  }\n" +
   "\n" +
   "  /**\n" +
   "   * True when an active archive file ends inside a record instead of at the\n" +
   "   * newline that terminates it. Appending there would concatenate the new\n" +
   "   * record into the fragment's line, which no reader can parse, so the caller\n" +
   "   * must repair the file first.\n" +
   "   */\n" +
   "  async #activeTailIsTorn(path) {\n" +
   "    let size = 0;\n" +
   "    try { size = (await stat(path)).size; } catch { return false; }\n" +
   "    if (size === 0) return false;\n" +
   "    const handle = await open(path, \"r\");\n" +
   "    try {\n" +
   "      const last = Buffer.alloc(1);\n" +
   "      const { bytesRead } = await handle.read(last, 0, 1, size - 1);\n" +
   "      return bytesRead === 1 && last[0] !== NEWLINE_BYTE;\n" +
   "    } finally { await handle.close(); }\n" +
   "  }\n" +
   "\n" +
   "  /**\n" +
   "   * The append-only audit file that keeps the incomplete final lines removed\n" +
   "   * from one collection's active archive, one fragment per line and every byte\n" +
   "   * as it was written. It is named like an archive file because that is what\n" +
   "   * makes the durability machinery keep it: a staged transaction installs it\n" +
   "   * with the rest of the tree, and compaction - which rebuilds only the active\n" +
   "   * file and the segment directory - never touches it. No collection claims it,\n" +
   "   * so nothing reads it as an archive; the doctor's archive scan lists it, and\n" +
   "   * the one unparsable line is exactly the fragment it preserves.\n" +
   "   */\n" +
   "  #archiveQuarantinePath(collection) {\n" +
   "    const path = this.#archivePath(collection);\n" +
   "    return path ? `${path.slice(0, -\"-archive.jsonl\".length)}quarantine-archive.jsonl` : null;\n" +
   "  }\n" +
   "\n" +
   "  /**\n" +
   "   * Preserve the incomplete final line of an active archive byte for byte in\n" +
   "   * that collection's quarantine file, then rewrite the active file with its\n" +
   "   * complete lines. The fragment is never parsed as a record and never deleted:\n" +
   "   * an operator can still read it from the quarantine file. The fragment is\n" +
   "   * appended before the active file is replaced, so a failure or a crash in\n" +
   "   * between cannot lose bytes no reader has seen.\n" +
   "   */\n" +
   "  async #quarantineTornTail(collection, path) {\n" +
   "    const raw = await readFile(path);\n" +
   "    const breakAt = raw.lastIndexOf(NEWLINE_BYTE);\n" +
   "    const fragment = breakAt === -1 ? raw : raw.subarray(breakAt + 1);\n" +
   "    const complete = breakAt === -1 ? Buffer.alloc(0) : raw.subarray(0, breakAt + 1);\n" +
   "    const quarantine = this.#archiveQuarantinePath(collection);\n" +
   "    // Both writes are in-place writes to a file the staged view may share with\n" +
   "    // the live tree, so both take the guard that hands this transaction its own\n" +
   "    // copy first.\n" +
   "    await this.#beforeArchiveWrite(path);\n" +
   "    await this.#beforeArchiveWrite(quarantine);\n" +
   "    // Append-only: the newline added after each fragment is the only byte this\n" +
   "    // file contributes, and an earlier fragment is never overwritten.\n" +
   "    await appendFile(quarantine, Buffer.concat([fragment, Buffer.from(\"\\n\")]), { mode: 0o600 });\n" +
   "    let rewritten = `${path}.${randomUUID()}.repair`;\n" +
   "    try {\n" +
   "      await writeFile(rewritten, complete, { mode: 0o600 });\n" +
   "      await rename(rewritten, path);\n" +
   "      rewritten = null;\n" +
   "    } finally {\n" +
   "      if (rewritten) await rm(rewritten, { force: true }).catch(() => {});\n" +
   "    }\n" +
   "    return { file: quarantine, bytes: fragment.length, kept: complete.toString(\"utf8\") };\n" +
   "  }\n" +
   "\n" +
   "  async #archiveEntries(collection, entries, { replaceExisting = false } = {}) {\n" +
   "    const run = async () => {\n",
   "  }\n" +
   "\n" +
   "  async #archiveEntries(collection, entries, { replaceExisting = false } = {}) {\n" +
   "    const run = async () => {\n"],
  ["      const originalKnown = new Set(known);\n" +
   "      const originalTombstones = new Set(tombstones);\n" +
   "      // A key the archive already owns is skipped: its archived value is the\n" +
   "      // record. A key marked stale is the exception - the archive holds an\n" +
   "      // older value and this append is the update that reaches it.\n" +
   "      const stale = this.archiveStale.get(collection) ?? null;\n" +
   "      const fresh = [];\n" +
   "      for (const entry of entries) {\n" +
   "        if (!entry || typeof entry !== \"object\") continue;\n" +
   "        const key = this.#archiveKey(entry);\n" +
   "        if (known.has(key) && !replaceExisting && !stale?.has(key)) continue;\n" +
   "        const previous = existingByKey.get(key);\n" +
   "        try { if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(entry)) continue; } catch {}\n",
   "      const originalKnown = new Set(known);\n" +
   "      const originalTombstones = new Set(tombstones);\n" +
   "      const fresh = [];\n" +
   "      for (const entry of entries) {\n" +
   "        if (!entry || typeof entry !== \"object\") continue;\n" +
   "        const key = this.#archiveKey(entry);\n" +
   "        if (known.has(key) && !replaceExisting) continue;\n" +
   "        const previous = existingByKey.get(key);\n" +
   "        try { if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(entry)) continue; } catch {}\n"],
  ["        let activeBytes = 0;\n" +
   "        try { activeBytes = (await stat(path)).size; } catch { activeBytes = 0; }\n" +
   "        // A torn active tail is repaired before anything is appended: the\n" +
   "        // fragment moves to a quarantine file and the active file keeps only\n" +
   "        // complete lines, so every new record starts on a line of its own.\n" +
   "        // Without this the new record and the fragment form one unparseable\n" +
   "        // line, the reader drops it, and the caller removes the record from its\n" +
   "        // hot window once this returns true - the record would then be gone\n" +
   "        // from the hot projection and the archive at the same time.\n" +
   "        if (activeBytes > 0 && await this.#activeTailIsTorn(path)) {\n" +
   "          const repaired = await this.#quarantineTornTail(collection, path);\n" +
   "          activeBytes = Buffer.byteLength(repaired.kept);\n" +
   "          this.#noteArchiveFault(collection, { file: path, line: null, kind: \"torn-tail\", quarantined: repaired.file, bytes: repaired.bytes });\n" +
   "          // The rewritten bytes are what the index entry and the active key set\n" +
   "          // describe from here on: the fragment's line and bytes are gone from\n" +
   "          // both.\n" +
   "          this.archiveIndexEntries.set(path, this.#indexEntryFromRaw(collection, path, repaired.kept, { sealed: false }));\n" +
   "          this.#activeKeysFromRaw(collection, repaired.kept);\n" +
   "        }\n" +
   "        let chunk = [];\n" +
   "        let chunkRecords = [];\n",
   "        let activeBytes = 0;\n" +
   "        try { activeBytes = (await stat(path)).size; } catch { activeBytes = 0; }\n" +
   "        let chunk = [];\n" +
   "        let chunkRecords = [];\n"],
  ["        await flush();\n" +
   "        this.#setArchiveMetadata(collection, known, tombstones);\n" +
   "        this.#resolveArchiveStale(collection, fresh);\n" +
   "        this.archiveIndexOperations += 1;\n" +
   "        this.#clearArchiveWriteFaults(collection);\n" +
   "        // Persist only the small index document. Active entry metadata is\n" +
   "        // updated incrementally above; sealed files receive their final hash\n",
   "        await flush();\n" +
   "        this.#setArchiveMetadata(collection, known, tombstones);\n" +
   "        this.archiveIndexOperations += 1;\n" +
   "        // Persist only the small index document. Active entry metadata is\n" +
   "        // updated incrementally above; sealed files receive their final hash\n"],
  ["        await this.#writeArchiveIndexIncremental();\n" +
   "        return true;\n" +
   "      } catch (error) {\n" +
   "        this.archiveKnown.set(collection, originalKnown);\n" +
   "        this.archiveTombstones.set(collection, originalTombstones);\n" +
   "        this.#noteArchiveFault(collection, { file: path, line: null, kind: \"deferred-write\", code: error?.code ?? null, reason: error?.message ?? String(error) });\n" +
   "        return false;\n" +
   "      }\n",
   "        await this.#writeArchiveIndexIncremental();\n" +
   "        return true;\n" +
   "      } catch {\n" +
   "        this.archiveKnown.set(collection, originalKnown);\n" +
   "        this.archiveTombstones.set(collection, originalTombstones);\n" +
   "        return false;\n" +
   "      }\n"],
  ["    const archive = await this.#archiveConsistencyReport();\n" +
   "    if (!archive.valid) reasons.push(\"archive_index_inconsistent\");\n" +
   "    const faults = this.archiveIntegrity();\n" +
   "    const degraded = Object.entries(faults)\n" +
   "      .flatMap(([collection, entries]) => entries.filter((fault) => HARD_ARCHIVE_FAULTS.has(fault.kind)).map((fault) => ({ collection, ...fault })));\n" +
   "    if (degraded.length) reasons.push(\"archive_bytes_unreadable\");\n" +
   "    return {\n" +
   "      valid: reasons.length === 0,\n",
   "    const archive = await this.#archiveConsistencyReport();\n" +
   "    if (!archive.valid) reasons.push(\"archive_index_inconsistent\");\n" +
   "    return {\n" +
   "      valid: reasons.length === 0,\n"],
  ["      tombstoneCount: complete.tombstones?.length ?? 0,\n" +
   "      duplicateIds,\n" +
   "      archive: { ...archive, degraded, faults },\n" +
   "    };\n" +
   "  }\n",
   "      tombstoneCount: complete.tombstones?.length ?? 0,\n" +
   "      duplicateIds,\n" +
   "      archive,\n" +
   "    };\n" +
   "  }\n"],
  ["    const knowledge = mergeKnowledgeEntry(previous, event, { now: this.clock() });\n" +
   "    const hotIndex = this.#data.knowledge.findIndex((entry) => entry?.knowledgeKey === event.knowledgeKey || entry?.id === event.knowledgeKey);\n" +
   "    if (hotIndex >= 0) {\n" +
   "      this.#data.knowledge[hotIndex] = knowledge;\n" +
   "      // The archive can also own this key with an older value - a restored hot\n" +
   "      // window, or a row an earlier eviction archived. The hot row now carries\n" +
   "      // the newer value, so the key must not read as archived until the archive\n" +
   "      // carries it too; the eviction that writes the row appends it there. No\n" +
   "      // write happens here: the write an eviction performs is the one the cold\n" +
   "      // bytes of a hot update have always been left to.\n" +
   "      if (this.archiveFile && this.archiveKnown.get(\"knowledge\")?.has(this.#archiveKey(knowledge))) {\n" +
   "        this.#markArchiveStale(\"knowledge\", this.#archiveKey(knowledge));\n" +
   "      }\n" +
   "    } else if (previous && this.archiveFile && this.archiveKnown.get(\"knowledge\")?.has(this.#archiveKey(previous))) {\n" +
   "      // The row exists only in the cold archive, so this append *is* the\n" +
   "      // update: a failure that was ignored would leave the archive at the\n" +
   "      // previous value while the caller received the merged row, losing the\n" +
   "      // update silently. Nothing has been mutated yet, so failing the whole\n" +
   "      // mutation leaves the caller a consistent state to retry from.\n" +
   "      if (!await this.#archiveEntries(\"knowledge\", [knowledge], { replaceExisting: true })) {\n" +
   "        const failure = new Error(\"Evolution knowledge archive update failed\");\n" +
   "        failure.code = \"E_ARCHIVE_WRITE_FAILED\";\n" +
   "        throw failure;\n" +
   "      }\n" +
   "    } else this.#data.knowledge.push(knowledge);\n" +
   "    if (this.archiveFile && this.#data.knowledge.length > this.#hotLimit(\"knowledge\")) {\n",
   "    const knowledge = mergeKnowledgeEntry(previous, event, { now: this.clock() });\n" +
   "    const hotIndex = this.#data.knowledge.findIndex((entry) => entry?.knowledgeKey === event.knowledgeKey || entry?.id === event.knowledgeKey);\n" +
   "    if (hotIndex >= 0) this.#data.knowledge[hotIndex] = knowledge;\n" +
   "    else if (previous && this.archiveFile && this.archiveKnown.get(\"knowledge\")?.has(this.#archiveKey(previous))) {\n" +
   "      await this.#archiveEntries(\"knowledge\", [knowledge], { replaceExisting: true });\n" +
   "    } else this.#data.knowledge.push(knowledge);\n" +
   "    if (this.archiveFile && this.#data.knowledge.length > this.#hotLimit(\"knowledge\")) {\n"],
  ["        if (!this.archiveKnown.has(collection)) this.#readArchiveSync(collection);\n" +
   "        const archivedHas = this.archiveKnown.get(collection)?.has(this.#archiveKey(next)) === true;\n" +
   "        if (archivedHas && !await this.#archiveEntries(collection, [merged], { replaceExisting: true })) {\n" +
   "          // The archive still holds the previous value, and an eviction skips\n" +
   "          // keys the archive already owns, so the merged row would be dropped\n" +
   "          // from the hot window without ever reaching the archive. Mark the key\n" +
   "          // stale instead: it stays hot, and the next eviction appends it. The\n" +
   "          // failure is also recorded as a `deferred-write` fault.\n" +
   "          this.#markArchiveStale(collection, this.#archiveKey(merged));\n" +
   "        }\n" +
   "      }\n" +
   "      if (this.archiveFile && collectionEntries.length > this.#hotLimit(collection)) {\n",
   "        if (!this.archiveKnown.has(collection)) this.#readArchiveSync(collection);\n" +
   "        const archivedHas = this.archiveKnown.get(collection)?.has(this.#archiveKey(next)) === true;\n" +
   "        if (archivedHas) await this.#archiveEntries(collection, [merged], { replaceExisting: true });\n" +
   "      }\n" +
   "      if (this.archiveFile && collectionEntries.length > this.#hotLimit(collection)) {\n"],
  // The experience-recall read path: one knowledge lookup per append, a source
  // scan that reads its history without copying it, and an identity comparison
  // that skips the event fields no comparison reads.
  ["import { canonicalKnowledgeKey, isDuplicateKnowledgeEvent, isKnowledgeCritical, knowledgeKeyOf, mergeKnowledgeEntry, normalizeKnowledgeEvent, sourceEventReference, sourceRetentionLimit } from \"./knowledge.js\";\n",
   "import { canonicalKnowledgeKey, isDuplicateKnowledgeEvent, isKnowledgeCritical, mergeKnowledgeEntry, normalizeKnowledgeEvent, sourceEventReference, sourceRetentionLimit } from \"./knowledge.js\";\n"],
  ["  async #upsertKnowledgeUnlocked(value = {}, { sourceCollection = \"event\", persist = false, previous: knownPrevious } = {}) {\n" +
   "    const event = normalizeKnowledgeEvent(value, { sourceCollection, now: timestamp(this.clock) });\n" +
   "    if (!event) return { accepted: false, duplicate: false, reason: \"not-knowledge-bearing\", event: null, knowledge: null };\n" +
   "    // `#append` already resolved this exact key against the same unchanged\n" +
   "    // history; re-resolving it here would read and parse the whole knowledge\n" +
   "    // archive a second time for one record.\n" +
   "    const previous = knownPrevious === undefined ? this.#knowledgeEntryFor(event) : knownPrevious;\n",
   "  async #upsertKnowledgeUnlocked(value = {}, { sourceCollection = \"event\", persist = false } = {}) {\n" +
   "    const event = normalizeKnowledgeEvent(value, { sourceCollection, now: timestamp(this.clock) });\n" +
   "    if (!event) return { accepted: false, duplicate: false, reason: \"not-knowledge-bearing\", event: null, knowledge: null };\n" +
   "    const previous = this.#knowledgeEntryFor(event);\n"],
  ["  #sourceMatches(collection, event) {\n" +
   "    if (!event?.knowledgeKey || !this.#collections().includes(collection) || collection === \"knowledge\") return [];\n" +
   "    // Only the canonical key decides a match, and the rows are read, never\n" +
   "    // returned as-is (the deferred returns below clone), so the complete\n" +
   "    // history is scanned without copying it and without materialising the\n" +
   "    // event fields no identity comparison reads.\n" +
   "    return this.#mergeArchived(collection, this.#data[collection], { copy: false }).filter((entry) => {\n" +
   "      if (entry?.knowledgeKey === event.knowledgeKey) return true;\n" +
   "      return knowledgeKeyOf(entry) === event.knowledgeKey;\n" +
   "    });\n" +
   "  }\n",
   "  #sourceMatches(collection, event) {\n" +
   "    if (!event?.knowledgeKey || !this.#collections().includes(collection) || collection === \"knowledge\") return [];\n" +
   "    return this.history(collection).filter((entry) => {\n" +
   "      if (entry?.knowledgeKey === event.knowledgeKey) return true;\n" +
   "      const normalized = normalizeKnowledgeEvent(entry, { sourceCollection: collection, now: timestamp(this.clock) });\n" +
   "      return normalized?.knowledgeKey === event.knowledgeKey;\n" +
   "    });\n" +
   "  }\n"],
  ["      const knowledgeResult = event ? await this.#upsertKnowledgeUnlocked(next, { sourceCollection: collection, previous: previousKnowledge }) : null;\n",
   "      const knowledgeResult = event ? await this.#upsertKnowledgeUnlocked(next, { sourceCollection: collection }) : null;\n"],
  // The active-archive scan memo: the process-local record of files this
  // process already scanned, and the reconcile that reads it. The loop-body
  // reversal below restores the shape the shared-scan reversal expects, so it
  // must stay ahead of it.
  ["  /**\n" +
   "   * The index entry of an active archive, reusing the process-local scan memo\n" +
   "   * when this process already scanned exactly these bytes. The scan itself\n" +
   "   * stays the recovery surface: it runs for every file whose identity this\n" +
   "   * process has not recorded (see `archiveScanMemo`).\n" +
   "   */\n" +
   "  async #reconcileActiveArchive(collection, file) {\n" +
   "    const info = await stat(file, { bigint: true });\n" +
   "    const memo = recallArchiveScan(collection, file, info);\n" +
   "    if (memo) {\n" +
   "      // Only the clock field differs from a fresh scan of these bytes, and the\n" +
   "      // copy keeps this instance's entry detached from the memo's.\n" +
   "      const entry = clone(memo.entry);\n" +
   "      entry.updatedAt = timestamp(this.clock);\n" +
   "      this.archiveActiveKeys.set(collection, new Set(memo.activeKeys));\n" +
   "      return entry;\n" +
   "    }\n" +
   "    let raw = \"\";\n" +
   "    try { raw = await readFile(file, \"utf8\"); } catch (error) { if (error?.code !== \"ENOENT\") throw error; }\n" +
   "    const scanned = this.#scanArchiveRaw(raw);\n" +
   "    const rebuilt = this.#indexEntryFromRaw(collection, file, raw, { sealed: false }, scanned);\n" +
   "    rememberArchiveScan(collection, file, info, rebuilt, this.#activeKeysFromRaw(collection, raw, scanned));\n" +
   "    return rebuilt;\n" +
   "  }\n" +
   "\n" +
   "  async #reconcileArchiveIndex() {\n",
   "  async #reconcileArchiveIndex() {\n"],
  ["          // Active files are the bounded recovery surface after an append/index crash.\n" +
   "          const rebuilt = await this.#reconcileActiveArchive(collection, file);\n",
   "          // Active files are the bounded recovery surface after an append/index crash.\n" +
   "          let raw = \"\";\n" +
   "          try { raw = await readFile(file, \"utf8\"); } catch (error) { if (error?.code !== \"ENOENT\") throw error; }\n" +
   "          const scanned = this.#scanArchiveRaw(raw);\n" +
   "          const rebuilt = this.#indexEntryFromRaw(collection, file, raw, { sealed: false }, scanned);\n" +
   "          this.#activeKeysFromRaw(collection, raw, scanned);\n"],
  ["/**\n" +
   " * Process-local memo for the recovery scan `#reconcileArchiveIndex()` performs on\n" +
   " * an active archive file.\n" +
   " *\n" +
   " * The scan has to run for every file whose bytes this process has not read yet:\n" +
   " * it rebuilds the persisted index after a crash, so it may not be skipped or\n" +
   " * trusted by size. What it does not have to do is run twice for the same\n" +
   " * unchanged bytes. A staged domain mutation loads the live tree through a\n" +
   " * hard-linked mirror and then loads the committed tree again, so one write\n" +
   " * reconciles the same active archives once per memory instance.\n" +
   " *\n" +
   " * An entry records the file identity observed while scanning - device, inode,\n" +
   " * byte size and mtime at nanosecond precision, the same identity\n" +
   " * `archive-stage.js` uses to decide whether two directory entries are the same\n" +
   " * file - plus its own copy of the active keys and the index entry. A file this\n" +
   " * process did not scan is never hit, and every way the plugin mutates an archive\n" +
   " * changes that identity: appends grow the size, and sealing, compaction and\n" +
   " * installation replace the inode. A rolled-back compaction renames the original\n" +
   " * inode back, whose recorded identity still describes its bytes. The map is\n" +
   " * bounded; eviction only costs a rescan.\n" +
   " */\n" +
   "const ARCHIVE_SCAN_MEMO_LIMIT = 32;\n" +
   "const archiveScanMemo = new Map();\n" +
   "\n" +
   "/**\n" +
   " * The key carries the collection and the file name as well as the file\n" +
   " * identity: the entry it answers with names its own collection and file\n" +
   " * (`segmentId`, `recordType`, `file`), and two active archives are only ever the\n" +
   " * same inode under a different name or collection if something outside this\n" +
   " * plugin hard-linked them. The staged mirror shares both, which is what makes\n" +
   " * the repeated load hit.\n" +
   " */\n" +
   "function archiveScanKey(collection, file, info) { return `${collection}\\u0000${file.split(\"/\").at(-1)}\\u0000${info.dev}\\u0000${info.ino}`; }\n" +
   "\n" +
   "function recallArchiveScan(collection, file, info) {\n" +
   "  const key = archiveScanKey(collection, file, info);\n" +
   "  const memo = archiveScanMemo.get(key);\n" +
   "  if (!memo || memo.size !== Number(info.size) || memo.mtimeNs !== String(info.mtimeNs)) return null;\n" +
   "  // Keep the most recently reused files last in the eviction order.\n" +
   "  archiveScanMemo.delete(key);\n" +
   "  archiveScanMemo.set(key, memo);\n" +
   "  return memo;\n" +
   "}\n" +
   "\n" +
   "function rememberArchiveScan(collection, file, info, entry, activeKeys) {\n" +
   "  const key = archiveScanKey(collection, file, info);\n" +
   "  archiveScanMemo.delete(key);\n" +
   "  // The memo owns deep copies of everything it records: the instance that\n" +
   "  // produced the scan keeps appending to its own key set and keeps its own\n" +
   "  // entry, and the entry can carry an object-valued timestamp from the archive\n" +
   "  // row, so a shallow copy would not isolate it. What the memo answers with is\n" +
   "  // exactly what a fresh scan of those bytes would have built.\n" +
   "  archiveScanMemo.set(key, {\n" +
   "    size: Number(info.size), mtimeNs: String(info.mtimeNs),\n" +
   "    entry: clone(entry), activeKeys: new Set(activeKeys),\n" +
   "  });\n" +
   "  while (archiveScanMemo.size > ARCHIVE_SCAN_MEMO_LIMIT) archiveScanMemo.delete(archiveScanMemo.keys().next().value);\n" +
   "}\n" +
   "\n" +
   "/** Durable, redacted memory for proposals, experiments, failures, and promotions. */",
   "/** Durable, redacted memory for proposals, experiments, failures, and promotions. */"],
  // The knowledge lookup on the record path: the merged view is scanned
  // without copying it, and only the matched row is detached.
  ["  #knowledgeEntryFor(event) {\n" +
   "    if (!event?.knowledgeKey) return null;\n" +
   "    // `history()` detaches every row of the merged view; this lookup reads one\n" +
   "    // row and its callers keep exactly that row, so the view is scanned without\n" +
   "    // copying it and only the matched row is detached.\n" +
   "    const entry = this.#mergeArchived(\"knowledge\", this.#data.knowledge, { copy: false })\n" +
   "      .find((candidate) => candidate?.knowledgeKey === event.knowledgeKey || candidate?.id === event.knowledgeKey);\n" +
   "    return entry === undefined || entry === null ? null : clone(entry);\n" +
   "  }\n",
   "  #knowledgeEntryFor(event) {\n" +
   "    if (!event?.knowledgeKey) return null;\n" +
   "    return this.history(\"knowledge\").find((entry) => entry?.knowledgeKey === event.knowledgeKey || entry?.id === event.knowledgeKey) ?? null;\n" +
   "  }\n"],
  ["      rootCause: event.failure?.rootCauseHypothesis ?? event.failure?.error ?? null,\n" +
   "      // Negative evidence must name the capability it applies to. Without it\n" +
   "      // the canonical failure row carries only a signature and a root cause, so\n" +
   "      // a later proposal for the same target could not recall that this exact\n" +
   "      // approach already failed.\n" +
   "      scope: event.target ?? event.capability ?? null,\n" +
   "      failure: safeRecord(event.failure ?? {}),\n",
   "      rootCause: event.failure?.rootCauseHypothesis ?? event.failure?.error ?? null,\n" +
   "      failure: safeRecord(event.failure ?? {}),\n"],
  ["    };\n  }\n\n  #scanArchiveRaw(raw) {\n    const lines = raw.split(\"\\n\").filter(Boolean);\n    const records = [];\n    for (const line of lines) {\n      try { records.push(JSON.parse(line)); } catch { /* a torn line is not logical knowledge */ }\n    }\n    return { lines, records };\n  }\n\n  #indexEntryFromRaw(collection, file, raw, { sealed = file !== this.#archivePath(collection), updatedAt = timestamp(this.clock) } = {}, scanned = this.#scanArchiveRaw(raw)) {\n    const { lines, records } = scanned;\n    const first = records[0];\n    const last = records.at(-1);\n    const fileName = file.split(\"/\").at(-1);\n",
   "    };\n  }\n\n  #indexEntryFromRaw(collection, file, raw, { sealed = file !== this.#archivePath(collection), updatedAt = timestamp(this.clock) } = {}) {\n    const lines = raw.split(\"\\n\").filter(Boolean);\n    const records = [];\n    for (const line of lines) {\n      try { records.push(JSON.parse(line)); } catch { /* a torn line is not logical knowledge */ }\n    }\n    const first = records[0];\n    const last = records.at(-1);\n    const fileName = file.split(\"/\").at(-1);\n"],
  ["    };\n  }\n\n  #activeKeysFromRaw(collection, raw, scanned = this.#scanArchiveRaw(raw)) {\n    const keys = new Set();\n    for (const entry of scanned.records) {\n      if (entry && typeof entry === \"object\") keys.add(this.#archiveKey(entry));\n    }\n    this.archiveActiveKeys.set(collection, keys);\n    return keys;\n",
   "    };\n  }\n\n  #activeKeysFromRaw(collection, raw) {\n    const keys = new Set();\n    for (const line of raw.split(\"\\n\")) {\n      if (!line.trim()) continue;\n      try {\n        const entry = JSON.parse(line);\n        if (entry && typeof entry === \"object\") keys.add(this.#archiveKey(entry));\n      } catch { /* a torn final line is ignored */ }\n    }\n    this.archiveActiveKeys.set(collection, keys);\n    return keys;\n"],
  ["          // Active files are the bounded recovery surface after an append/index crash.\n          let raw = \"\";\n          try { raw = await readFile(file, \"utf8\"); } catch (error) { if (error?.code !== \"ENOENT\") throw error; }\n          const scanned = this.#scanArchiveRaw(raw);\n          const rebuilt = this.#indexEntryFromRaw(collection, file, raw, { sealed: false }, scanned);\n          this.#activeKeysFromRaw(collection, raw, scanned);\n          if (JSON.stringify(current) !== JSON.stringify(rebuilt)) changed = true;\n          this.archiveIndexEntries.set(file, rebuilt);\n          continue;\n",
   "          // Active files are the bounded recovery surface after an append/index crash.\n          let raw = \"\";\n          try { raw = await readFile(file, \"utf8\"); } catch (error) { if (error?.code !== \"ENOENT\") throw error; }\n          const rebuilt = this.#indexEntryFromRaw(collection, file, raw, { sealed: false });\n          this.#activeKeysFromRaw(collection, raw);\n          if (JSON.stringify(current) !== JSON.stringify(rebuilt)) changed = true;\n          this.archiveIndexEntries.set(file, rebuilt);\n          continue;\n"],
  ["          let raw;\n          try { raw = await readFile(file, \"utf8\"); } catch { continue; }\n          const sealed = file !== this.#archivePath(collection);\n          const scanned = this.#scanArchiveRaw(raw);\n          entries.set(file, this.#indexEntryFromRaw(collection, file, raw, { sealed }, scanned));\n          if (!sealed) this.#activeKeysFromRaw(collection, raw, scanned);\n        }\n      }\n      this.archiveIndexEntries = entries;\n",
   "          let raw;\n          try { raw = await readFile(file, \"utf8\"); } catch { continue; }\n          const sealed = file !== this.#archivePath(collection);\n          entries.set(file, this.#indexEntryFromRaw(collection, file, raw, { sealed }));\n          if (!sealed) this.#activeKeysFromRaw(collection, raw);\n        }\n      }\n      this.archiveIndexEntries = entries;\n"],
  // The retention plan: one normalization per source row (the sweep that
  // re-visited every source row is folded into the accumulation pass), knowledge
  // rows reused instead of re-copied, and the classification loop in
  // `#retentionPlan()` reading the plan's own `retainedEntries` classification
  // instead of normalizing the same row again.
  [  "    });\n" +
  "  }\n" +
  "\n" +
  "  /**\n" +
  "   * Build the knowledge/retention plan for one snapshot of the histories.\n" +
  "   *\n" +
  "   * `histories` is already a plan-owned deep copy (`#mergeArchived` clones), so\n" +
  "   * the plan's knowledge output reuses those row objects instead of copying\n" +
  "   * them again: `records` is handed to the caller, which takes ownership, and\n" +
  "   * nothing reads `histories` after this returns. The accumulator merge is the\n" +
  "   * only step that produces new objects.\n" +
  "   *\n" +
  "   * Every source row is normalized exactly once, in the accumulation pass below,\n" +
  "   * and that pass also answers the only other question anything asks about a\n" +
  "   * source row: whether it is knowledge-bearing at all. A row whose normalized\n" +
  "   * event is falsy is recorded in `retainedEntries` here, and a knowledge-bearing\n" +
  "   * row is recorded there by the consolidation loop when it is kept, so\n" +
  "   * `retainedEntries` classifies every row of every source collection. The\n" +
  "   * classification loop in `#retentionPlan()` visits exactly those rows - it\n" +
  "   * skips `knowledge`, which is not a source collection - and asks exactly that\n" +
  "   * question, so it reads this set instead of normalizing the row a second time.\n" +
  "   * An earlier revision memoized each normalized event for it, which retained one\n" +
  "   * map entry per source row, plus a collection-keyed two-level key that had to\n" +
  "   * special-case non-object rows, to answer a question this pass had already\n" +
  "   * answered.\n" +
  "   *\n" +
  "   * The clock read is not folded away: every pass still evaluates\n" +
  "   * `timestamp(this.clock)` once per row, in the order the pre-optimization plan\n" +
  "   * did, so a clock that advances between reads derives the same knowledge record\n" +
  "   * timestamps as before. Only the folded sweep's own read disappears; what that\n" +
  "   * does to the write-time stamps written later in the same transaction is stated\n" +
  "   * and pinned in `docs/performance/retention-plan-cost.md`.\n" +
  "   */\n" +
  "  #knowledgeRetentionPlan(histories, references = new Set()) {\n" +
  "    const retainedEntries = new Map(this.#collections().map((collection) => [collection, new Set()]));\n" +
  "    const knowledgeByKey = new Map();\n" +
  "    const coveredRefs = new Set();\n" +
  "    for (const entry of histories.knowledge ?? []) {\n" +
  "      const key = entry?.knowledgeKey ?? canonicalKnowledgeKey(entry, { sourceCollection: \"knowledge\", now: timestamp(this.clock) });\n" +
  "      if (!key) continue;\n" +
  "      knowledgeByKey.set(key, entry);\n" +
  "      for (const ref of entry?.sourceRefs ?? []) coveredRefs.add(String(ref));\n" +
  "    }\n" +
  "    const sourceGroups = new Map();\n" +
  "    const sourceCollections = this.#collections().filter((collection) => collection !== \"knowledge\" && collection !== \"tombstones\");\n" +
  "    for (const collection of sourceCollections) {\n" +
  "      for (const entry of histories[collection] ?? []) {\n" +
  "        const event = normalizeKnowledgeEvent(entry, { sourceCollection: collection, now: timestamp(this.clock) });\n" +
  "        // A row with no knowledge identity at all is not grouped and stays\n" +
  "        // retained; the sweep that used to collect these rows second-hand is\n" +
  "        // folded into this pass, since it visited exactly the same rows.\n" +
  "        if (!event) { retainedEntries.get(collection)?.add(entry); continue; }\n" +
  "        const key = event.knowledgeKey;\n" +
  "        const sourceRef = sourceEventReference(collection, entry);\n" +
  "        const existing = knowledgeByKey.get(key);\n",
  "    });\n" +
  "  }\n" +
  "\n" +
  "  #knowledgeRetentionPlan(histories, references = new Set()) {\n" +
  "    const knowledgeByKey = new Map();\n" +
  "    const coveredRefs = new Set();\n" +
  "    for (const entry of histories.knowledge ?? []) {\n" +
  "      const key = entry?.knowledgeKey ?? canonicalKnowledgeKey(entry, { sourceCollection: \"knowledge\", now: timestamp(this.clock) });\n" +
  "      if (!key) continue;\n" +
  "      knowledgeByKey.set(key, clone(entry));\n" +
  "      for (const ref of entry?.sourceRefs ?? []) coveredRefs.add(String(ref));\n" +
  "    }\n" +
  "    const sourceGroups = new Map();\n" +
  "    const sourceCollections = this.#collections().filter((collection) => collection !== \"knowledge\" && collection !== \"tombstones\");\n" +
  "    for (const collection of sourceCollections) {\n" +
  "      for (const entry of histories[collection] ?? []) {\n" +
  "        const event = normalizeKnowledgeEvent(entry, { sourceCollection: collection, now: timestamp(this.clock) });\n" +
  "        if (!event) continue;\n" +
  "        const key = event.knowledgeKey;\n" +
  "        const sourceRef = sourceEventReference(collection, entry);\n" +
  "        const existing = knowledgeByKey.get(key);\n"],
  [  "        sourceGroups.get(key).push({ collection, entry, event });\n" +
  "      }\n" +
  "    }\n" +
  "    let consolidated = 0;\n" +
  "    for (const group of sourceGroups.values()) {\n" +
  "      const byCollection = new Map();\n",
  "        sourceGroups.get(key).push({ collection, entry, event });\n" +
  "      }\n" +
  "    }\n" +
  "    const retainedEntries = new Map(this.#collections().map((collection) => [collection, new Set()]));\n" +
  "    let consolidated = 0;\n" +
  "    for (const group of sourceGroups.values()) {\n" +
  "      const byCollection = new Map();\n"],
  [  "        }\n" +
  "      }\n" +
  "    }\n" +
  "    return { knowledge: [...knowledgeByKey.values()], retainedEntries, consolidated };\n" +
  "  }\n" +
  "\n" +
  "  #retentionPlan() {\n",
  "        }\n" +
  "      }\n" +
  "    }\n" +
  "    for (const collection of sourceCollections) {\n" +
  "      for (const entry of histories[collection] ?? []) {\n" +
  "        if (!normalizeKnowledgeEvent(entry, { sourceCollection: collection, now: timestamp(this.clock) })) retainedEntries.get(collection)?.add(entry);\n" +
  "      }\n" +
  "    }\n" +
  "    return { knowledge: [...knowledgeByKey.values()].map(clone), retainedEntries, consolidated };\n" +
  "  }\n" +
  "\n" +
  "  #retentionPlan() {\n"],
  [  "    const report = { before: {}, after: {}, retired: 0, consolidated: 0, aggregatedObservations: 0, tombstones: 0, retainedCanonical: canonicalByKey.size, knowledgeBefore: histories.knowledge?.length ?? 0, knowledgeAfter: knowledgePlan.knowledge.length, canonicalKnowledge: knowledgePlan.knowledge.length };\n" +
  "    for (const collection of collections) {\n" +
  "      if (collection === \"knowledge\") {\n" +
  "        // The plan's knowledge rows are already copies it owns (see\n" +
  "        // `#knowledgeRetentionPlan()`); the caller consumes this array and\n" +
  "        // nothing else holds it, so no second copy is made here.\n" +
  "        records[collection] = knowledgePlan.knowledge;\n" +
  "        report.before[collection] = histories[collection].length;\n" +
  "        report.after[collection] = records[collection].length;\n" +
  "        continue;\n",
  "    const report = { before: {}, after: {}, retired: 0, consolidated: 0, aggregatedObservations: 0, tombstones: 0, retainedCanonical: canonicalByKey.size, knowledgeBefore: histories.knowledge?.length ?? 0, knowledgeAfter: knowledgePlan.knowledge.length, canonicalKnowledge: knowledgePlan.knowledge.length };\n" +
  "    for (const collection of collections) {\n" +
  "      if (collection === \"knowledge\") {\n" +
  "        records[collection] = knowledgePlan.knowledge.map(clone);\n" +
  "        report.before[collection] = histories[collection].length;\n" +
  "        report.after[collection] = records[collection].length;\n" +
  "        continue;\n"],
  [  "      report.before[collection] = histories[collection].length;\n" +
  "      for (const entry of histories[collection]) {\n" +
  "        const recordId = entry?.id === undefined || entry?.id === null ? null : String(entry.id);\n" +
  "        // `retainedEntries` is `#knowledgeRetentionPlan()`'s own classification of\n" +
  "        // this row: it holds every row whose normalized event was falsy and every\n" +
  "        // knowledge-bearing row the consolidation loop kept, and this loop visits\n" +
  "        // exactly the source collections that pass walked. A row in neither set is\n" +
  "        // knowledge-bearing and was not kept, so it is retired or consolidated.\n" +
  "        //\n" +
  "        // The clock read below is deliberate and its value is unused. The\n" +
  "        // pre-change plan normalized this row in this loop and consumed one clock\n" +
  "        // value doing it; that normalization is gone, and this read keeps the\n" +
  "        // plan's clock-call sequence otherwise unchanged, so the only read that\n" +
  "        // disappears is the folded sweep's - one per source row, and no more.\n" +
  "        // Dropping this one as well would move the archive index written later in\n" +
  "        // this transaction, and the clock-derived stamps of a later plan sharing\n" +
  "        // this clock, by a second read per row (see the clock contract in\n" +
  "        // `docs/performance/retention-plan-cost.md`).\n" +
  "        timestamp(this.clock);\n" +
  "        if (!knowledgePlan.retainedEntries.get(collection)?.has(entry)) {\n" +
  "          const replacedBy = recordId ? retiredByCanonical.get(recordId) ?? null : null;\n" +
  "          const lineageLatest = entry?.lineageId && latestLineage.get(String(entry.lineageId))?.id === recordId;\n",
  "      report.before[collection] = histories[collection].length;\n" +
  "      for (const entry of histories[collection]) {\n" +
  "        const recordId = entry?.id === undefined || entry?.id === null ? null : String(entry.id);\n" +
  "        const normalizedKnowledge = normalizeKnowledgeEvent(entry, { sourceCollection: collection, now: timestamp(this.clock) });\n" +
  "        if (normalizedKnowledge && !knowledgePlan.retainedEntries.get(collection)?.has(entry)) {\n" +
  "          const replacedBy = recordId ? retiredByCanonical.get(recordId) ?? null : null;\n" +
  "          const lineageLatest = entry?.lineageId && latestLineage.get(String(entry.lineageId))?.id === recordId;\n"],
  // The plan result no longer carries the `histories` snapshot: the field was
  // dropped once no reader existed, and the reversal restores it so the
  // reconstruction still reaches the pinned pre-change source.
  ["    return { collections, records, canonical: [...canonicalByKey.values()], report };\n",
   "    return { collections, histories, records, canonical: [...canonicalByKey.values()], report };\n"],
  // `load()` gained the `snapshot: false` mode the domain port and the
  // observation store use to skip a projection they discard. The reversal drops
  // the option and the concurrency-sharing rewrite with it, so the
  // reconstruction still reaches the pinned pre-change source.
  ["  /**\n" +
   "   * Load the durable state and, unless the caller asks otherwise, return the\n" +
   "   * hot projection of it.\n" +
   "   *\n" +
   "   * The projection is the *returned* value, never a side effect of loading:\n" +
   "   * every reader in this package either consumes it or discards it, and both\n" +
   "   * call sites that discard it (the domain port's `createMemory()` and the\n" +
   "   * observation store's observation-window read) pay for a deep clone of every\n" +
   "   * collection only to drop it. `{ snapshot: false }` still performs the whole\n" +
   "   * load - state-store read, archive index reconciliation, eviction and\n" +
   "   * archival - and skips only the closing `snapshot()`, which clones state that\n" +
   "   * loading has already finished mutating and cannot mutate again.\n" +
   "   */\n" +
   "  async load({ snapshot = true } = {}) {\n" +
   "    if (this.loaded) return snapshot ? this.snapshot() : undefined;\n" +
   "    if (this.loading) {\n" +
   "      // A concurrent load shares the one loading run; the first caller's\n" +
   "      // projection is handed on, which is what `return this.loading` gave back.\n" +
   "      const shared = await this.loading;\n" +
   "      return snapshot ? (shared ?? this.snapshot()) : undefined;\n" +
   "    }\n" +
   "    this.loading = (async () => {\n",
   "  async load() {\n" +
   "    if (this.loaded) return this.snapshot();\n" +
   "    if (this.loading) return this.loading;\n" +
   "    this.loading = (async () => {\n"],
  ["      this.loaded = true;\n" +
   "      return snapshot ? this.snapshot() : undefined;\n" +
   "    })();\n" +
   "    try { return await this.loading; } finally { this.loading = null; }\n" +
   "  }\n",
   "      this.loaded = true;\n" +
   "      return this.snapshot();\n" +
   "    })();\n" +
   "    try { return await this.loading; } finally { this.loading = null; }\n" +
   "  }\n"],
  // Listing the archive files de-duplicated with a scanning `indexOf`, which is
  // quadratic in the number of segments; an order-preserving `Set` returns the
  // same array. Reversing it restores the scan this pin predates.
  ["    // Preserve the first occurrence and exact order with an identical result;\n" +
   "    // indexOf made listing many segments quadratic in the number of files.\n" +
   "    return [...new Set([...names.map((name) => join(directory, name)), path])];",
   "    return [...names.map((name) => join(directory, name)), path].filter((file, index, files) => index === files.indexOf(file));"],
  // A rollback replaces the archives it thought it had installed, but the index
  // document is written by the same rewrite. Restoring the bytes without
  // restoring the index leaves an index that describes archives which no longer
  // exist; the reversal drops the capture, the restore and the failure
  // attachment so the reconstruction still reaches the pinned pre-change
  // source.
  ["  async #restoreArchiveIndex(originalIndexBytes, originalIndexExisted) {\n" +
   "    if (this.archiveIndexFile) {\n" +
   "      if (originalIndexExisted) {\n" +
   "        const temporary = `${this.archiveIndexFile}.${randomUUID()}.rollback.tmp`;\n" +
   "        try {\n" +
   "          await writeFile(temporary, originalIndexBytes, { mode: 0o600 });\n" +
   "          await rename(temporary, this.archiveIndexFile);\n" +
   "        } catch (error) {\n" +
   "          await rm(temporary, { force: true }).catch(() => {});\n" +
   "          throw error;\n" +
   "        }\n" +
   "      } else {\n" +
   "        await rm(this.archiveIndexFile, { force: true });\n" +
   "      }\n" +
   "    }\n" +
   "    this.archiveIndexEntries.clear();\n" +
   "    this.archiveIndexReady = false;\n" +
   "    const indexLoaded = await this.#loadArchiveIndex();\n" +
   "    if (originalIndexExisted && !indexLoaded) {\n" +
   "      const error = new Error(\"E_ARCHIVE_INDEX_RESTORE_FAILED: the original archive index could not be reloaded after rollback\");\n" +
   "      error.code = \"E_ARCHIVE_INDEX_RESTORE_FAILED\";\n" +
   "      throw error;\n" +
   "    }\n" +
   "  }\n\n",
   ""],
  ["    let originalIndexBytes = null;\n    let originalIndexExisted = false;\n    if (this.archiveIndexFile) {\n      try {\n        originalIndexBytes = await readFile(this.archiveIndexFile);\n        originalIndexExisted = true;\n      } catch (error) {\n        if (error?.code !== \"ENOENT\") throw error;\n      }\n    }\n",
   ""],
  ["          }\n          await this.#restoreArchiveIndex(originalIndexBytes, originalIndexExisted);\n        },\n      };",
   "          }\n        },\n      };"],
  ["      try {\n        await this.#restoreArchiveIndex(originalIndexBytes, originalIndexExisted);\n      } catch (rollbackError) {\n        if (error && (typeof error === \"object\" || typeof error === \"function\")) {\n          try { error.rollbackError = rollbackError; } catch {}\n        }\n      }\n      throw error;\n    }\n  }\n",
   "      throw error;\n    }\n  }\n"],
  ["        this.#data = oldData;\n        try {\n          await archiveTransaction?.rollback?.();\n        } catch (rollbackError) {\n          if (error && (typeof error === \"object\" || typeof error === \"function\")) {\n            try { error.rollbackError = rollbackError; } catch {}\n          }\n        }\n        throw error;\n      }\n      const afterBytes = this.#archiveBytes();",
   "        this.#data = oldData;\n        await archiveTransaction?.rollback?.();\n        throw error;\n      }\n      const afterBytes = this.#archiveBytes();"],
  ["      return { committed: true, duplicate: false, finalizationId, winner: clone(winnerRecord), loserSummaries: clone(loserSummaries), canonical: clone(canonical) };\n    } catch (error) {\n      this.#data = oldData;\n      try {\n        await archiveTransaction?.rollback?.();\n      } catch (rollbackError) {\n        if (error && (typeof error === \"object\" || typeof error === \"function\")) {\n          try { error.rollbackError = rollbackError; } catch {}\n        }\n      }\n      throw error;\n    }\n  }",
   "      return { committed: true, duplicate: false, finalizationId, winner: clone(winnerRecord), loserSummaries: clone(loserSummaries), canonical: clone(canonical) };\n    } catch (error) {\n      this.#data = oldData;\n      await archiveTransaction?.rollback?.();\n      throw error;\n    }\n  }"],
];

export function reconstructPreSharedScan(source) {
  // The archive rewrite batching change is independent of the historical
  // shared-scan rounds below. Remove it first so the composed reconstruction
  // still reaches the same frozen source when the working tree includes it.
  const batchReversals = [
    ["        let pendingLines = [];\n", ""],
    ["            if (pendingLines.length) {\n" +
     "              await writeFile(temporary, pendingLines.join(\"\"), { mode: 0o600 });\n" +
     "              pendingLines = [];\n" +
     "            }\n", ""],
    ["          pendingLines.push(line + \"\\n\");\n", "          await appendFile(temporary, line + \"\\n\", { mode: 0o600 });\n"],
    ["            await writeFile(temporary, pendingLines.join(\"\"), { mode: 0o600 });\n" +
     "            pendingLines = [];\n", ""],
    ["        if (pendingLines.length) await writeFile(temporary, pendingLines.join(\"\"), { mode: 0o600 });\n", ""],
  ];
  for (const [after, before] of batchReversals) {
    assert.equal(source.split(after).length - 1, 1,
      "archive rewrite batch shape must occur exactly once before reconstruction");
    source = source.replace(after, before);
  }
  source = reconstructPreObserveCache(source);
  for (const [after, before] of reversals) {
    assert.equal(source.split(after).length - 1, 1,
      "shared-scan post-change shape must occur exactly once before reconstruction");
    source = source.replace(after, before);
  }
  assert.doesNotMatch(source, /#scanArchiveRaw/, "the baseline must predate shared scans");
  assert.doesNotMatch(source, /knowledgeEventOf/, "the baseline must predate the retention-plan normalization memo");
  return source;
}

/**
 * Reverse only the archive-persistence integrity change. Each post-change
 * fragment is an exact single-occurrence guard tied to the current working tree.
 */
export function reconstructPreArchiveIntegrity(source) {
  const reversals = [
    ["import { inspectArchiveIntegrity } from \"../archive-stage.js\";\n", ""],
    ["const HARD_ARCHIVE_FAULTS = new Set([\"invalid-line\", \"unusable-line\", \"unreadable\", \"missing-segment\"]);", "const HARD_ARCHIVE_FAULTS = new Set([\"invalid-line\", \"unreadable\"]);"],
    ["  get hasColdHistory() {\n    return Object.entries(this.#data.coldArchives ?? {}).some(([collection, entry]) => {\n      const count = Number(entry?.count);\n      if (count > 0) return true;\n      if (entry && Object.hasOwn(entry, \"count\")) return false;\n      const archive = this.#archivePath(collection);\n      if (!archive) return false;\n      return this.#archiveFiles(collection).some((file) => {\n        try { return statSync(file).size > 0; } catch { return false; }\n      });\n    });\n  }\n", "  get hasColdHistory() {\n    return Object.values(this.#data.coldArchives ?? {}).some((entry) => Number(entry?.count) > 0);\n  }\n"],
    ["  archiveIntegrity() {\n    const inspected = this.archiveIndexFile ? inspectArchiveIntegrity({\n      stateFile: this.stateStore.filePath,\n      indexFile: this.archiveIndexFile,\n      scanContents: false,\n    }) : null;\n    return this.#archiveFaultProjection(inspected);\n  }\n\n  #archiveFaultProjection(inspected) {\n    const faults = new Map([...this.archiveFaults].map(([collection, entries]) => [collection, entries.map((fault) => ({ ...fault }))]));\n    for (const finding of inspected?.findings ?? []) {\n      if (![\"archive-invalid-line\", \"archive-torn-tail\", \"archive-unusable-line\", \"archive-file-unreadable\", \"archive-segment-directory-unreadable\", \"archive-index-target-missing\", \"archive-loss-evidence\", \"archive-target-undetermined\", \"archive-quarantine-unreadable\"].includes(finding.code)) continue;\n      const kind = finding.code === \"archive-loss-evidence\" || finding.code === \"archive-index-target-missing\"\n        ? \"missing-segment\"\n        : finding.code === \"archive-target-undetermined\" ? \"missing-segment-undetermined\"\n          : finding.code.startsWith(\"archive-\") ? finding.code.slice(\"archive-\".length) : null;\n      if (!kind || !finding.collection) continue;\n      const entries = faults.get(finding.collection) ?? [];\n      const file = finding.path ?? finding.file ?? this.#archivePath(finding.collection);\n      const fileName = (value) => typeof value === \"string\" ? value.split(/[\\\\/]/).at(-1) : \"\";\n      const identity = `${kind}\\u0000${fileName(file)}\\u0000${finding.line ?? \"\"}`;\n      const existing = entries.findIndex((entry) => `${entry.kind}\\u0000${fileName(entry.file)}\\u0000${entry.line ?? \"\"}` === identity);\n      if (existing >= 0) {\n        if (kind === \"missing-segment\" || kind === \"missing-segment-undetermined\") {\n          entries[existing] = { ...entries[existing], status: finding.status, expected: finding.expected, evidence: finding.evidence };\n        }\n      } else {\n        entries.push({ ...finding, file, kind });\n        faults.set(finding.collection, entries);\n      }\n    }\n    return Object.fromEntries([...faults].map(([collection, entries]) => [collection, entries.map((fault) => ({ ...fault }))]));\n  }\n", "  archiveIntegrity() {\n    return Object.fromEntries([...this.archiveFaults].map(([collection, faults]) => [collection, faults.map((fault) => ({ ...fault }))]));\n  }\n"],
    ["  #noteArchiveFault(collection, fault) {\n    const faults = this.archiveFaults.get(collection) ?? [];\n    const identity = (entry) => `${entry.kind}\\u0000${entry.file}\\u0000${entry.line ?? \"\"}`;\n    const observed = { ...fault, at: timestamp(this.clock) };\n    const index = faults.findIndex((entry) => identity(entry) === identity(observed));\n    if (index < 0) faults.push(observed);\n    else faults[index] = observed;\n    // A missing sealed segment is durable loss evidence, not an operational\n    // sample. Keep it until the exact recorded bytes are proven restored; the\n    // generic cap applies only to ordinary read/write faults.\n    let ordinaryFaults = 0;\n    for (const entry of faults) if (entry.kind !== \"missing-segment\") ordinaryFaults += 1;\n    while (ordinaryFaults > ARCHIVE_FAULT_LIMIT) {\n      const oldestOrdinary = faults.findIndex((entry) => entry.kind !== \"missing-segment\");\n      if (oldestOrdinary < 0) break;\n      faults.splice(oldestOrdinary, 1);\n      ordinaryFaults -= 1;\n    }\n    this.archiveFaults.set(collection, faults);\n  }\n", "  #noteArchiveFault(collection, fault) {\n    const faults = this.archiveFaults.get(collection) ?? [];\n    const identity = (entry) => `${entry.kind}\\u0000${entry.file}\\u0000${entry.line ?? \"\"}`;\n    const observed = { ...fault, at: timestamp(this.clock) };\n    const index = faults.findIndex((entry) => identity(entry) === identity(observed));\n    if (index < 0) faults.push(observed);\n    else faults[index] = observed;\n    if (faults.length > ARCHIVE_FAULT_LIMIT) faults.splice(0, faults.length - ARCHIVE_FAULT_LIMIT);\n    this.archiveFaults.set(collection, faults);\n  }\n"],
    ["    const present = new Set(actual.map((entry) => `${entry.collection}\\u0000${entry.file}`));\n    for (const [file, entry] of this.archiveIndexEntries) {\n      let exists = false;\n      try { exists = statSync(file).isFile(); } catch {}\n      const collection = entry?.collection;\n      const name = entry?.file ?? file.split(\"/\").at(-1);\n      if (!exists && collection && !present.has(`${collection}\\u0000${name}`)) {\n        actual.push({ ...entry, collection, file: name });\n        present.add(`${collection}\\u0000${name}`);\n      }\n    }\n    const body = { schemaVersion: 1, updatedAt: timestamp(this.clock), segments: actual };\n    const integrityFaults = this.#durableArchiveIntegrityFaults();\n    if (integrityFaults.length) body.integrityFaults = integrityFaults;\n    const document = JSON.stringify(body);\n", "    const document = JSON.stringify({ schemaVersion: 1, updatedAt: timestamp(this.clock), segments: actual });\n"],
    ["  #durableArchiveIntegrityFaults() {\n    const projected = [];\n    const validStatuses = new Set([\"missing\", \"replacement-unproven\", \"incomplete-transition\"]);\n    for (const [collection, faults] of this.archiveFaults) {\n      for (const fault of faults) {\n        if (fault.kind !== \"missing-segment\") continue;\n        const file = typeof fault.file === \"string\" ? fault.file.split(/[\\\\/]/).at(-1) : \"\";\n        if (!/^segment-[0-9]+\\.jsonl$/.test(file)) continue;\n        const expected = fault.expected && typeof fault.expected === \"object\" ? fault.expected : {};\n        const byteSize = Number.isSafeInteger(expected.byteSize) && expected.byteSize >= 0 ? expected.byteSize : null;\n        const sha256 = typeof expected.sha256 === \"string\" && /^[0-9a-f]{64}$/.test(expected.sha256)\n          ? expected.sha256\n          : null;\n        projected.push({\n          collection,\n          file,\n          expected: { byteSize, sha256 },\n          kind: \"missing-segment\",\n          status: validStatuses.has(fault.status) ? fault.status : \"missing\",\n        });\n      }\n    }\n    const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;\n    return projected.sort((left, right) => compareText(left.collection, right.collection)\n      || compareText(left.file, right.file)\n      || compareText(left.kind, right.kind)\n      || compareText(left.status, right.status)\n      || compareText(JSON.stringify(left.expected), JSON.stringify(right.expected)));\n  }\n\n", ""],
    ["  #assertArchiveIndexClassifiable(integrity) {\n" +
     "    if (!integrity\n" +
     "      || (![\"invalid\", \"unreadable\"].includes(integrity.index.state)\n" +
     "        && !integrity.findings.some((finding) => [\"archive-integrity-evidence-unusable\", \"archive-integrity-evidence-invalid\"].includes(finding.code)))) return;\n" +
     "    const findings = integrity.findings.map((finding) => finding.code).join(\",\");\n" +
     "    const error = new Error(`E_ARCHIVE_INDEX_STATE_UNKNOWN: the archive index cannot be classified safely (${integrity.index.state}; ${findings})`);\n" +
     "    error.code = \"E_ARCHIVE_INDEX_STATE_UNKNOWN\";\n" +
     "    throw error;\n" +
     "  }\n\n", ""],
    ["  async #reconcileArchiveIndex() {\n    if (!this.archiveIndexFile) return;\n    const before = inspectArchiveIntegrity({\n      stateFile: this.stateStore.filePath,\n      indexFile: this.archiveIndexFile,\n      scanContents: false,\n    });\n    const inTransition = before.transitions.pendingInstall !== false\n      || before.transitions.compaction.length > 0\n      || before.transitions.kind === \"transition-state-unknown\";\n    this.#assertArchiveIndexClassifiable(before);\n    const loaded = await this.#loadArchiveIndex();\n    let changed = !loaded;\n    // Expectations proven by a durable fault: the bytes at that name are the\n    // pre-fault bytes, so the index entry may be rebuilt from them even though\n    // its recorded size differs. This is the only case where a size mismatch\n    // is repaired; see the sealed-segment loop below.\n    const restoredExpectations = new Map();\n    if (inTransition) {\n      for (const missing of before.missingIndexTargets) {\n        if (missing.indexEntry?.sealed === true) this.archiveIndexEntries.set(missing.path, missing.indexEntry);\n      }\n    } else {\n      for (const persisted of before.persistedFaults) {\n        const faults = this.archiveFaults.get(persisted.collection) ?? [];\n        if (!faults.some((fault) => fault.kind === \"missing-segment\" && fault.file === persisted.file)) {\n          this.#noteArchiveFault(persisted.collection, {\n            kind: \"missing-segment\", collection: persisted.collection, file: persisted.file,\n            expected: persisted.expected, indexEntry: persisted.indexEntry,\n            status: persisted.status, evidence: persisted.evidence,\n          });\n        }\n        if (persisted.status !== \"restored-bytes-proven\") continue;\n        const restoredFaults = this.archiveFaults.get(persisted.collection) ?? [];\n        const index = restoredFaults.findIndex((fault) => fault.kind === \"missing-segment\" && fault.file === persisted.file);\n        if (index >= 0) {\n          const [recovered] = restoredFaults.splice(index, 1);\n          if (restoredFaults.length) this.archiveFaults.set(persisted.collection, restoredFaults);\n          else this.archiveFaults.delete(persisted.collection);\n          if (recovered.indexEntry && typeof recovered.indexEntry === \"object\") {\n            const restoredPath = join(this.#archiveSegmentDirectory(recovered.collection), recovered.file);\n            this.archiveIndexEntries.set(restoredPath, recovered.indexEntry);\n          } else {\n            restoredExpectations.set(persisted.path, persisted.expected);\n          }\n          changed = true;\n        }\n      }\n      for (const missing of before.missingIndexTargets) {\n        if (missing.status !== \"missing\" || missing.indexEntry?.sealed !== true) continue;\n        const faults = this.archiveFaults.get(missing.collection) ?? [];\n        const existing = faults.find((fault) => fault.kind === \"missing-segment\" && fault.file === missing.file);\n        if (!existing) {\n          this.#noteArchiveFault(missing.collection, {\n            kind: \"missing-segment\",\n            collection: missing.collection,\n            file: missing.file,\n            expected: missing.expected,\n            indexEntry: missing.indexEntry,\n          });\n        }\n        const missingPath = missing.path;\n        if (this.archiveIndexEntries.delete(missingPath)) changed = true;\n        changed = true;\n      }\n    }\n    const actualFiles = new Set();\n    for (const collection of this.#collections()) {\n      const archivePath = this.#archivePath(collection);\n      for (const file of this.#archiveFiles(collection)) {\n        try { if (!(await stat(file)).isFile()) continue; } catch (error) { if (error?.code === \"ENOENT\") continue; throw error; }\n        actualFiles.add(file);\n        const sealed = file !== archivePath;\n        const current = this.archiveIndexEntries.get(file);\n        if (!sealed) {\n          // An append lands before the index document that describes it, so a\n          // crash can leave the file ahead of its entry. Parsing the active file\n          // on every load is therefore the recovery, not a validation: a torn\n          // tail is quarantined and reported, never dropped. Skipping it would\n          // need the index to be authoritative about bytes written after it.\n          // Active files are the bounded recovery surface after an append/index crash.\n          const rebuilt = await this.#reconcileActiveArchive(collection, file);\n          if (!sameIndexEntry(current, rebuilt)) changed = true;\n          this.archiveIndexEntries.set(file, rebuilt);\n          continue;\n        }\n        const proven = restoredExpectations.get(file);\n        if (proven) {\n          // The durable fault proved these are the pre-fault bytes, and the\n          // entry in place can still describe a later rotation that reused the\n          // name. Rebuild from the proven bytes so the expectation that returns\n          // is the recorded one; a re-read that no longer matches leaves the\n          // entry alone so the inspector keeps reporting the conflict.\n          const raw = await readFile(file, \"utf8\");\n          const rebuilt = this.#indexEntryFromRaw(collection, file, raw, { sealed: true });\n          if (rebuilt.sha256 === proven?.sha256 && rebuilt.byteSize === proven?.byteSize) {\n            this.archiveIndexEntries.set(file, rebuilt);\n            changed = true;\n          }\n          continue;\n        }\n        let size = 0;\n        try { size = (await stat(file)).size; } catch { continue; }\n        // A sealed segment is written under a temporary name, renamed into place\n        // and never appended to again, so this rebuild accepts its index entry\n        // whenever the recorded byte size is still the file's size, without\n        // reading or re-hashing the bytes. A change that keeps the size is\n        // therefore invisible at load; `verifyConsistency()` is the operation\n        // that re-reads and re-hashes every sealed segment and reports a digest\n        // mismatch as `checksum`.\n        const expectedByteSize = current?.byteSize;\n        const hasUsableExpected = current?.sealed === true\n          && current.checksumState === \"final\"\n          && typeof current.sha256 === \"string\"\n          && /^[0-9a-f]{64}$/.test(current.sha256)\n          && Number.isSafeInteger(current.byteSize)\n          && expectedByteSize >= 0;\n        if (hasUsableExpected && Number(expectedByteSize) === size) {\n          // The bytes are the ones this entry describes, so nothing is re-read\n          // or re-hashed. The entry still has to carry the fields this\n          // implementation writes for them: a document from an older version may\n          // name only the file, and leaving that shape in place would never be\n          // normalized now that an unchanged load no longer rewrites the index.\n          const name = file.split(\"/\").at(-1);\n          if (current.collection === collection && current.file === name) continue;\n          this.archiveIndexEntries.set(file, { ...current, collection, file: name });\n          changed = true;\n          continue;\n        }\n        if (hasUsableExpected) {\n          // A complete expected checksum is evidence, not a cache hint. A size\n          // mismatch must stay visible to the integrity inspector; rebuilding\n          // this entry from the changed bytes would erase that evidence.\n          continue;\n        }\n        // Only an unindexed or mismatched sealed file is read and re-hashed.\n        const raw = await readFile(file, \"utf8\");\n        this.archiveIndexEntries.set(file, this.#indexEntryFromRaw(collection, file, raw, { sealed: true }));\n        changed = true;\n      }\n    }\n    for (const file of this.archiveIndexEntries.keys()) {\n      if (!actualFiles.has(file)) {\n        const current = this.archiveIndexEntries.get(file);\n        const recordedFault = (this.archiveFaults.get(current?.collection) ?? [])\n          .some((fault) => fault.kind === \"missing-segment\" && fault.file === file.split(\"/\").at(-1));\n        if (!inTransition && current?.sealed === true && !recordedFault) {\n          this.archiveIndexEntries.delete(file);\n          changed = true;\n        }\n      }\n    }\n    // Do not materialize an empty index on every fresh state-store startup.\n    // The first archive append creates it; avoiding this write also keeps a\n    // background memory load from racing temporary-directory cleanup when no\n    // cold records exist yet.\n    if (changed && (loaded || actualFiles.size > 0 || this.archiveIndexEntries.size > 0)) {\n      await this.#writeArchiveIndexDocument();\n    }\n    this.archiveIndexReady = true;\n  }\n", "  async #reconcileArchiveIndex() {\n    if (!this.archiveIndexFile) return;\n    const loaded = await this.#loadArchiveIndex();\n    let changed = !loaded;\n    const actualFiles = new Set();\n    for (const collection of this.#collections()) {\n      const archivePath = this.#archivePath(collection);\n      for (const file of this.#archiveFiles(collection)) {\n        try { if (!(await stat(file)).isFile()) continue; } catch (error) { if (error?.code === \"ENOENT\") continue; throw error; }\n        actualFiles.add(file);\n        const sealed = file !== archivePath;\n        const current = this.archiveIndexEntries.get(file);\n        if (!sealed) {\n          // An append lands before the index document that describes it, so a\n          // crash can leave the file ahead of its entry. Parsing the active file\n          // on every load is therefore the recovery, not a validation: a torn\n          // tail is quarantined and reported, never dropped. Skipping it would\n          // need the index to be authoritative about bytes written after it.\n          // Active files are the bounded recovery surface after an append/index crash.\n          const rebuilt = await this.#reconcileActiveArchive(collection, file);\n          if (!sameIndexEntry(current, rebuilt)) changed = true;\n          this.archiveIndexEntries.set(file, rebuilt);\n          continue;\n        }\n        let size = 0;\n        try { size = (await stat(file)).size; } catch { continue; }\n        // A sealed segment is written under a temporary name, renamed into place\n        // and never appended to again, so this rebuild accepts its index entry\n        // whenever the recorded byte size is still the file's size, without\n        // reading or re-hashing the bytes. A change that keeps the size is\n        // therefore invisible at load; `verifyConsistency()` is the operation\n        // that re-reads and re-hashes every sealed segment and reports a digest\n        // mismatch as `checksum`.\n        const valid = current?.sealed === true\n          && current.checksumState === \"final\"\n          && typeof current.sha256 === \"string\"\n          && Number(current.byteSize) === size;\n        if (valid) {\n          // The bytes are the ones this entry describes, so nothing is re-read\n          // or re-hashed. The entry still has to carry the fields this\n          // implementation writes for them: a document from an older version may\n          // name only the file, and leaving that shape in place would never be\n          // normalized now that an unchanged load no longer rewrites the index.\n          const name = file.split(\"/\").at(-1);\n          if (current.collection === collection && current.file === name) continue;\n          this.archiveIndexEntries.set(file, { ...current, collection, file: name });\n          changed = true;\n          continue;\n        }\n        // Only an unindexed or mismatched sealed file is read and re-hashed.\n        const raw = await readFile(file, \"utf8\");\n        this.archiveIndexEntries.set(file, this.#indexEntryFromRaw(collection, file, raw, { sealed: true }));\n        changed = true;\n      }\n    }\n    for (const file of this.archiveIndexEntries.keys()) {\n      if (!actualFiles.has(file)) {\n        this.archiveIndexEntries.delete(file);\n        changed = true;\n      }\n    }\n    // Do not materialize an empty index on every fresh state-store startup.\n    // The first archive append creates it; avoiding this write also keeps a\n    // background memory load from racing temporary-directory cleanup when no\n    // cold records exist yet.\n    if (changed && (loaded || actualFiles.size > 0 || this.archiveIndexEntries.size > 0)) {\n      await this.#writeArchiveIndexDocument();\n    }\n    this.archiveIndexReady = true;\n  }\n"],
    ["  async #archiveConsistencyReport() {\n    if (!this.archiveFile) return { valid: true, status: \"not_configured\", files: 0, missing: [], mismatched: [] };\n    await this.archiveIndexWriting;\n    return inspectArchiveIntegrity({\n      stateFile: this.stateStore.filePath,\n      indexFile: this.archiveIndexFile,\n    });\n  }\n", "  async #archiveConsistencyReport() {\n    if (!this.archiveFile) return { valid: true, status: \"not_configured\", files: 0, missing: [], mismatched: [] };\n    this.archiveIndexReady = false;\n    await this.#reconcileArchiveIndex();\n    await this.archiveIndexWriting;\n    const missing = [];\n    const mismatched = [];\n    const actualFiles = new Set();\n    for (const collection of this.#collections()) {\n      for (const file of this.#archiveFiles(collection)) {\n        let isFile = false;\n        try { isFile = statSync(file).isFile(); } catch {}\n        if (!isFile) continue;\n        actualFiles.add(file);\n        const indexed = this.archiveIndexEntries.get(file);\n        if (!indexed) {\n          missing.push(file);\n          continue;\n        }\n        let raw;\n        try { raw = await readFile(file, \"utf8\"); } catch { mismatched.push({ file, reason: \"unreadable\" }); continue; }\n        const byteSize = Buffer.byteLength(raw);\n        if (Number(indexed.byteSize) !== byteSize) mismatched.push({ file, reason: \"byte_size\", expected: byteSize, actual: indexed.byteSize });\n        if (indexed.sealed === true) {\n          const sha256 = createHash(\"sha256\").update(raw).digest(\"hex\");\n          if (indexed.sha256 !== sha256) mismatched.push({ file, reason: \"checksum\", expected: sha256, actual: indexed.sha256 ?? null });\n        }\n      }\n    }\n    const stale = [...this.archiveIndexEntries.keys()].filter((file) => !actualFiles.has(file));\n    return {\n      valid: missing.length === 0 && mismatched.length === 0 && stale.length === 0,\n      status: \"verified\",\n      files: actualFiles.size,\n      missing,\n      mismatched,\n      stale,\n      indexFile: this.archiveIndexFile,\n    };\n  }\n"],
    ["    const faults = this.#archiveFaultProjection(archive);", "    const faults = this.archiveIntegrity();"],
    ["    const integrity = this.archiveIndexFile ? inspectArchiveIntegrity({\n      stateFile: this.stateStore.filePath,\n      indexFile: this.archiveIndexFile,\n    }) : null;\n    this.#assertArchiveIndexClassifiable(integrity);\n    const unsafe = integrity?.findings.filter((finding) => [\n      \"archive-invalid-line\", \"archive-torn-tail\", \"archive-unusable-line\", \"archive-file-unreadable\", \"archive-segment-directory-unreadable\",\n      \"archive-sealed-size-mismatch\", \"archive-sealed-digest-mismatch\", \"archive-index-target-missing\", \"archive-loss-evidence\",\n    ].includes(finding.code)) ?? [];\n    if (unsafe.length) {\n      const error = new Error(`E_ARCHIVE_REWRITE_UNSAFE: refusing to replace archives with unreadable evidence (${unsafe.map((finding) => `${finding.collection ?? \"?\"}/${finding.file ?? finding.path ?? \"?\"}:${finding.code}`).join(\", \")})`);\n      error.code = \"E_ARCHIVE_REWRITE_UNSAFE\";\n      throw error;\n    }\n    if ((integrity?.transitions.kind ?? null) !== null) {\n      const error = new Error(\"E_ARCHIVE_TRANSITION_INCOMPLETE: refusing to replace archives during a pending install or compaction transition\");\n      error.code = \"E_ARCHIVE_TRANSITION_INCOMPLETE\";\n      throw error;\n    }\n", ""],
  ];
  for (const [after, before] of reversals) {
    assert.equal(source.split(after).length - 1, 1,
      "archive-integrity post-change shape must occur exactly once before reconstruction");
    source = source.replace(after, before);
  }
  assert.doesNotMatch(source, /inspectArchiveIntegrity|#archiveFaultProjection|#durableArchiveIntegrityFaults|E_ARCHIVE_INDEX_STATE_UNKNOWN|E_ARCHIVE_REWRITE_UNSAFE|missing-segment/,
    "the reconstructed source must predate archive integrity persistence");
  return source;
}


/**
 * Reverse the measurement marker persist coalescing for older artifact pins.
 *
 * Each post-change fragment is an exact single-occurrence guard tied to the
 * current working tree. The constructor parameter and the assignment of the
 * opt-in flag are deliberately not reversed here: they sit inside the block
 * \`reconstructPreObserveCache()\` already rewrites for its own, older change, so
 * exactly one table owns the constructor line.
 */
/**
 * Reverse the measurement marker persist coalescing for older artifact pins.
 *
 * Each post-change fragment is an exact single-occurrence guard tied to the
 * current working tree. The constructor parameter and the assignment of the
 * opt-in flag are deliberately not reversed here: they sit inside the block
 * `reconstructPreObserveCache()` already rewrites for its own, older change, so
 * exactly one table owns the constructor line.
 */
export function reconstructPreMeasurementMarkerSaveCoalescing(source) {
  const reversals = [
    ["    // In the staged domain transaction, a measurement's first save has already\n    // checked the whole payload before this fixed-shape marker is added, and the\n    // outer mutation publishes the final memory snapshot after apply returns, so\n    // no reader ever sees the intermediate stateStore value. That is what makes\n    // the second persist redundant rather than load-bearing: the marker adds\n    // only fixed own keys, and the one event-derived value among them - the\n    // experiment id, already stored on the experiment record the first save\n    // wrote - so it can neither introduce a `\"__proto__\"` serialised literal nor\n    // deepen an existing branch of the document.\n    //\n    // The id test below is not what makes that argument hold. A measurement\n    // record built from a bridge event keeps its source row, so the first payload\n    // always carries the id; removing this test leaves every published byte and\n    // every rejection unchanged today. It is kept as defence for the day source\n    // retention decides otherwise, because then the marker would be the first\n    // place the id appears. Non-staged and non-transactional memories retain both\n    // saves either way.\n    const skipTransactionPersist = this.coalesceMeasurementMarkerPersist\n      && this.transaction !== null\n      && this.archiveWriteGuard !== null\n      && event.eventType === \"measurement-completed\"\n      && event.experimentId !== \"__proto__\";\n    await this.#save({ skipTransactionPersist });",
      "    await this.#save();",
    ],
    ["  async #save({ skipTransactionPersist = false } = {}) {", "  async #save() {"],
    ["      if (skipTransactionPersist) return;\n", ""],
  ];
  for (const [after, before] of reversals) {
    assert.equal(source.split(after).length - 1, 1,
      "measurement marker persist shape must occur exactly once before reconstruction");
    source = source.replace(after, before);
  }
  assert.doesNotMatch(source, /skipTransactionPersist/,
    "the pre-coalescing source must not retain the transaction persist option");
  return source;
}

// Reversal layer for the deferred archive index document.
//
// Applied before every older table, because it is the newest change to the
// working tree and the older fragments were written against the source as it
// stood before it. Each post-change fragment is an exact single-occurrence
// guard, so source drift fails here instead of silently reverting nothing.
export function reconstructPreDeferredArchiveIndex(source) {
  const reversals = [
    ["coalesceMeasurementMarkerPersist = false, deferArchiveIndexWrites = false } = {}) {",
      "coalesceMeasurementMarkerPersist = false } = {}) {"],
    ["    // Only domain-storage's staged replay working copy opts into marker coalescing.\n"
      + "    this.coalesceMeasurementMarkerPersist = coalesceMeasurementMarkerPersist === true;\n"
      + "    // Only the same working copy opts into deferring its archive index document.\n"
      + "    // See `flushDeferredArchiveIndex()` for why that is safe there and only there.\n"
      + "    this.deferArchiveIndexWrites = deferArchiveIndexWrites === true;\n",
      "    // Only domain-storage's staged replay working copy opts into marker coalescing.\n"
      + "    this.coalesceMeasurementMarkerPersist = coalesceMeasurementMarkerPersist === true;\n"],
    ["    this.archiveIndexWriting = Promise.resolve();\n"
      + "    // Set when a deferred append owes the index document a write.\n"
      + "    this.archiveIndexDue = false;\n"
      + "    this.archiveIndexReady = false;",
      "    this.archiveIndexWriting = Promise.resolve();\n"
      + "    this.archiveIndexReady = false;"],
    ["    if (!this.archiveIndexFile) return;\n"
      + "    // A deferred instance does not publish: it is domain-storage's staged replay\n"
      + "    // working copy, and the only readers of the index document it holds are the\n"
      + "    // load, compaction, retention-rewrite and consistency paths, none of which a\n"
      + "    // replay batch reaches. Every appending path therefore only records that the\n"
      + "    // document is owed, and `mutate()` collects that debt once before it turns\n"
      + "    // the stage into files. See `flushDeferredArchiveIndex()`.\n"
      + "    if (this.deferArchiveIndexWrites) { this.archiveIndexDue = true; return; }\n",
      "    if (!this.archiveIndexFile) return;\n"],
    ["  /**\n   * Write the archive index document the deferred appends owe, at most once.\n   *\n   * `deferArchiveIndexWrites` exists for one instance only: the staged replay\n   * working copy `domain-storage` builds inside a domain transaction. That copy\n   * never publishes - the transaction reads its archive tree by content after\n   * `work()` returns - so the intermediate index documents it used to rewrite\n   * after every archived record were read by nothing and then replaced. Each of\n   * them cost a directory listing per collection, a stat per archive file, a\n   * serialisation of the whole document, a temporary write and a rename, and a\n   * replay archives one record per event.\n   *\n   * Deferring changes nothing the transaction publishes: the write this method\n   * performs produces the same document the last per-record write produced,\n   * apart from `updatedAt`, which `#writeArchiveIndexDocument()` always stamps\n   * from the clock. The file it replaces is created through the same temporary\n   * plus rename, and `changedArchiveFiles()` still sees it because the flush runs\n   * before the transaction lists its changes.\n   *\n   * One behaviour does differ, deliberately: a failing index write used to be\n   * caught by `#archiveEntries()`, which kept that record in the hot window and\n   * recorded a `deferred-write` fault. The debt is now paid once, so its failure\n   * rejects the transaction instead, before anything is staged for publication.\n   * That is the stricter of the two outcomes - an index this process could not\n   * write is not published as if it had been - and the next replay pass retries\n   * it as a whole.\n   */\n  async flushDeferredArchiveIndex() {\n    if (!this.deferArchiveIndexWrites || !this.archiveIndexDue) return false;\n    this.archiveIndexDue = false;\n    const write = async () => this.#writeArchiveIndexDocument();\n    const queued = this.archiveIndexWriting.then(write, write);\n    this.archiveIndexWriting = queued.catch(() => {});\n    await queued;\n    return true;\n  }\n\n", ""],
  ];
  for (const [after, before] of reversals) {
    assert.equal(source.split(after).length - 1, 1,
      "deferred archive index shape must occur exactly once before reconstruction");
    source = source.replace(after, before);
  }
  assert.doesNotMatch(source, /deferArchiveIndexWrites|archiveIndexDue|flushDeferredArchiveIndex/,
    "the reconstructed source must not retain the deferred archive index document");
  return source;
}

export async function archiveIndexBaseline() {
  // The round that replaced the parsed-row read cache with an ordered key table
  // and a bounded row window rewrote this file structurally: the earlier guarded
  // reversals are written against the source they changed, and a rewrite is not
  // reversible by hunk. The differential is therefore anchored to the frozen
  // pre-rewrite source instead of the working tree, and every older reversal runs
  // against that frozen source exactly as it ran against the working tree before.
  const working = await readBaselineSource();
  const archived = readTarEntries(releaseArtifactPath(readReleaseManifest()))
    .find((entry) => entry.path === "lib/dockyard-domain/memory.js");
  assert.ok(archived, "the pinned artifact must ship the full memory implementation");
  return baselineFromSources(working, archived.bytes.toString("utf8"));
}

/**
 * The source the guarded reversals reconstruct from.
 *
 * `test/fixtures/memory-pre-archive-row-window.js` is `lib/dockyard-domain/memory.js`
 * as it stood immediately before the archive row-window rewrite, so the older
 * reversals keep matching a real implementation and the differential keeps
 * comparing the working tree against the behaviour that was shipped.
 */
export function readBaselineSource() {
  return readFile(new URL("../fixtures/memory-pre-archive-row-window.js", import.meta.url), "utf8");
}

// A shared-scan pin no longer contains historical source; guarded reversal
// remains authoritative then. Keep this branch directly testable without
// modifying a release artifact.
//
// Reversing this change alone is not enough once another change follows it in
// the working tree: the pin predates every change after it, so the byte
// identity check reverses them all, in the order the table lists them.
export function baselineFromSources(working, pinned) {
  const reconstructed = reconstructPreHousekeepingIndex(reconstructPreSharedScan(reconstructPreMeasurementMarkerSaveCoalescing(reconstructPreArchiveIntegrity(reconstructPreDeferredArchiveIndex(working)))));
  // Only a pin older than the shared scan can be the source this differential
  // reverses towards. `#scanArchiveRaw` alone cannot decide it any more: the
  // row-window rewrite that froze `working` removed that method, so a pin that
  // carries the rewrite has neither the shared scan nor the old source. A pin
  // with `#walkArchiveLines` is that later release, not the pre-change one.
  const pinPredatesScan = !pinned.includes("#scanArchiveRaw") && !pinned.includes("#walkArchiveLines");
  if (pinPredatesScan) {
    assert.equal(reconstructed, pinned,
      "the reconstruction must be byte-identical to the authoritative pre-change pin");
  }
  return { source: pinPredatesScan ? pinned : reconstructed, reconstructed, pinPredatesScan };
}
