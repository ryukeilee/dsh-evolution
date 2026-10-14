import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readReleaseManifest, readTarEntries, releaseArtifactPath } from "../../scripts/release/release-lib.mjs";
import { reconstructPreHousekeepingIndex } from "./housekeeping-baseline.js";

// Revert the shared-scan refactor plus every other change that landed after the
// rc.7 anchor, so the composed reconstruction still reaches the pinned source.
// Each pair is [post-change text, pre-change text]; exact, single-occurrence
// guards fail on any shape drift. The regions are disjoint, so the order does
// not matter.
const reversals = [
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
  "          const lineageLatest = entry?.lineageId && latestLineage.get(String(entry.lineageId))?.id === recordId;\n"]
];

export function reconstructPreSharedScan(source) {
  for (const [after, before] of reversals) {
    assert.equal(source.split(after).length - 1, 1,
      "shared-scan post-change shape must occur exactly once before reconstruction");
    source = source.replace(after, before);
  }
  assert.doesNotMatch(source, /#scanArchiveRaw/, "the baseline must predate shared scans");
  assert.doesNotMatch(source, /knowledgeEventOf/, "the baseline must predate the retention-plan normalization memo");
  return source;
}

export async function archiveIndexBaseline() {
  const working = await readFile(new URL("../../lib/dockyard-domain/memory.js", import.meta.url), "utf8");
  const archived = readTarEntries(releaseArtifactPath(readReleaseManifest()))
    .find((entry) => entry.path === "lib/dockyard-domain/memory.js");
  assert.ok(archived, "the pinned artifact must ship the full memory implementation");
  return baselineFromSources(working, archived.bytes.toString("utf8"));
}

// A shared-scan pin no longer contains historical source; guarded reversal
// remains authoritative then. Keep this branch directly testable without
// modifying a release artifact.
//
// Reversing this change alone is not enough once another change follows it in
// the working tree: the pin predates every change after it, so the byte
// identity check reverses them all (in any order — the regions are disjoint).
export function baselineFromSources(working, pinned) {
  const reconstructed = reconstructPreHousekeepingIndex(reconstructPreSharedScan(working));
  const pinPredatesScan = !pinned.includes("#scanArchiveRaw");
  if (pinPredatesScan) {
    assert.equal(reconstructed, pinned,
      "the reconstruction must be byte-identical to the authoritative pre-change pin");
  }
  return { source: pinPredatesScan ? pinned : reconstructed, reconstructed, pinPredatesScan };
}
