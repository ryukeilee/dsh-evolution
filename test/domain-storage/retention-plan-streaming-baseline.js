// Reverse the retention-plan-streaming round (C1+C2) before the older pinned
// baselines reconstruct their trees.
//
// That round changes how the retention plan reads its rows: `compact({dryRun})`
// stops materialising the plan output (C1), and `#retentionPlan()` reads
// `historyView()` rows instead of `history()` clones, cloning only the rows the
// plan does not own (C2). Sol Loop round 1 then folded the tombstone merge back
// into the dry-run path (S1): both forms evaluate the same merge, so a persisted
// row that makes it throw raises the same error in a dry run as in a write. That
// fix is part of the same round's diff and reversed here too.
//
// The differential baselines below rebuild older trees by reversing rounds
// newest-first, so this round has to be undone before the first of them or their
// anchors and pins no longer describe history.
//
// The hunks are the exact inverse of this round's `lib/dockyard-domain/memory.js`
// diff, applied last-change-first: each `post` is the shape the reduction left in
// the working tree and each `pre` restores the pre-change bytes. They are guarded
// by the single-occurrence assertion in `reverseRetentionPlanStreamingRound()`,
// and the older chain's own digest pins still prove the reconstruction reaches
// the pre-change source (see `PRE_CHANGE_TREE` in `load-projection-baseline.js`).
import assert from "node:assert/strict";
import { reverseKnowledgeHotWindowRound } from "./knowledge-hot-window-baseline.js";

const FILE = "lib/dockyard-domain/memory.js";

const HUNKS = [
  {
    post: "      // A dry run keeps only the report: the plan's output arrays and copies\n      // have no reader there, and skipping them is the whole point.\n      const plan = this.#retentionPlan({ materialize: !dryRun });\n",
    pre: "      const plan = this.#retentionPlan();\n",
  },
  {
    post: "    return { collections, records, canonical: records ? [...canonicalByKey.values()] : null, report };\n",
    pre: "    return { collections, records, canonical: [...canonicalByKey.values()], report };\n",
  },
  {
    post: "    if (records) records.tombstones = [...tombstones.values()];\n    report.tombstones = tombstones.size;\n",
    pre: "    records.tombstones = [...tombstoneMap.values()];\n    report.tombstones = records.tombstones.length;\n",
  },
  {
    post: "      if (records) { records[collection] = retained; report.after[collection] = retained.length; }\n      else report.after[collection] = retainedCount;\n",
    pre: "      records[collection] = retained;\n      report.after[collection] = retained.length;\n",
  },
  {
    post: "        if (retained) retained.push(materializeRow(planRows[collection], entry)); else retainedCount += 1;\n",
    pre: "        retained.push(clone(entry));\n",
  },
  {
    post: "        if (canRetire) {\n          retireRecord(collection, entry, { reason: replacedBy ? \"superseded\" : lifecycleState(entry).toLowerCase(), replacedBy });\n",
    pre: "        if (canRetire) {\n          addTombstone(tombstoneFor(collection, entry, { reason: replacedBy ? \"superseded\" : lifecycleState(entry).toLowerCase(), replacedBy }));\n",
  },
  {
    post: "          const compactedObservation = compactObservationRecord(entry);\n          if (retained) retained.push(compactedObservation); else retainedCount += 1;\n",
    pre: "          retained.push(compactObservationRecord(entry));\n",
  },
  {
    post: "          const compactedCycle = compactCycleRecord(entry);\n          if (retained) retained.push(compactedCycle); else retainedCount += 1;\n",
    pre: "          retained.push(compactCycleRecord(entry));\n",
  },
  {
    post: "            // The aggregate is built in both forms so its id generation and any\n            // rejection path stay in the dry run's sequence; a dry run only\n            // discards the row instead of keeping it.\n            const aggregate = compactObservationAggregate(group);\n            if (retained) retained.push(aggregate); else retainedCount += 1;\n",
    pre: "            retained.push(compactObservationAggregate(group));\n",
  },
  {
    post: "            retireRecord(collection, entry, { reason: replacedBy ? \"superseded\" : lifecycleState(entry).toLowerCase(), replacedBy });\n",
    pre: "            addTombstone(tombstoneFor(collection, entry, { reason: replacedBy ? \"superseded\" : lifecycleState(entry).toLowerCase(), replacedBy }));\n",
  },
  {
    post: "      const retained = records ? [] : null;\n      let retainedCount = 0;\n",
    pre: "      const retained = [];\n",
  },
  {
    post: "        report.after[collection] = knowledgePlan.knowledge.length;\n",
    pre: "        report.after[collection] = records[collection].length;\n",
  },
  {
    post: "        if (records) records[collection] = knowledgePlan.knowledge;\n",
    pre: "        records[collection] = knowledgePlan.knowledge;\n",
  },
  {
    post: "    const knowledgePlan = this.#knowledgeRetentionPlan(histories, references, materializeKnowledgeRow);\n    const records = materialize ? {} : null;\n",
    pre: "    const knowledgePlan = this.#knowledgeRetentionPlan(histories, references);\n    const records = {};\n",
  },
  {
    post: "        ...tombstone,\n        count: Number(previous.count ?? 0) + Number(tombstone.count ?? 1),\n        firstSeen: previous.firstSeen ?? tombstone.firstSeen ?? null,\n        lastSeen: tombstone.lastSeen ?? previous.lastSeen ?? null,\n",
    pre: "        ...entry,\n        count: Number(previous.count ?? 0) + Number(entry.count ?? 1),\n        firstSeen: previous.firstSeen ?? entry.firstSeen ?? null,\n        lastSeen: entry.lastSeen ?? previous.lastSeen ?? null,\n",
  },
  {
    post: "    // The plan's own tombstone table, built in both forms. A dry run reports the\n    // merged size and keeps the merged rows it never returns; a write path hands\n    // the values to `#data`. Both run the same seed and the same merge expression\n    // in the same order, so a malformed persisted `recordIds` aborts a dry run\n    // exactly where it aborts a real compaction - a report must not claim an\n    // execution the write path would refuse - and `tombstoneFor()`'s\n    // id-generating helpers keep their call sequence.\n    const tombstones = new Map();\n    const tombstonePlan = this.#historyPlanRows(\"tombstones\");\n    for (const entry of tombstonePlan.rows) {\n      if (!entry?.id) continue;\n      tombstones.set(String(entry.id), materialize ? materializeRow(tombstonePlan, entry) : entry);\n    }\n    const retireRecord = (collection, entry, { reason, replacedBy = null } = {}) => {\n      const tombstone = tombstoneFor(collection, entry, { reason, replacedBy });\n      const previous = tombstones.get(String(tombstone.id));\n      if (!previous) { tombstones.set(String(tombstone.id), tombstone); return; }\n      const ids = [...new Set([...(previous.recordIds ?? []), ...(tombstone.recordIds ?? [])])].slice(-16);\n      tombstones.set(String(tombstone.id), {\n",
    pre: "    const tombstoneMap = new Map();\n    for (const entry of this.history(\"tombstones\")) if (entry?.id) tombstoneMap.set(String(entry.id), clone(entry));\n    const addTombstone = (entry) => {\n      const previous = tombstoneMap.get(String(entry.id));\n      if (!previous) { tombstoneMap.set(String(entry.id), entry); return; }\n      const ids = [...new Set([...(previous.recordIds ?? []), ...(entry.recordIds ?? [])])].slice(-16);\n      tombstoneMap.set(String(entry.id), {\n",
  },
  {
    post: "    for (const collection of collections) {\n      for (const entry of histories[collection]) {\n        if (![\"strategies\", \"lineage\", \"promotions\"].includes(collection) || !stableCanonicalEvidence(entry)) continue;\n        const candidate = safeRecord({\n          id: \"canonical:\" + hashText(semanticCapability(collection, entry) + \"::\" + String(entry.lineageId ?? \"\") + \":\" + String(entry.id ?? \"\")),\n          state: \"CANONICAL\",\n          lifecycleState: \"CANONICAL\",\n          capability: semanticCapability(collection, entry),\n          lineageId: entry.lineageId ?? null,\n          sourceCollection: collection,\n          recordId: entry.id ?? null,\n          strategyId: entry.strategyId ?? (collection === \"strategies\" ? entry.id : null),\n          generationId: entry.generationId ?? null,\n          version: entry.version ?? null,\n          promotionId: entry.promotionId ?? entry.id ?? null,\n          experimentId: entry.experimentId ?? entry.sourceExperimentId ?? null,\n          fitnessScore: Number(entry.fitnessScore ?? entry.fitness ?? 0),\n          implementation: safeRecord(entry.manifest ?? entry.component ?? entry.strategy ?? {}),\n          evidence: safeRecord(entry.evidence ?? entry.stability ?? {}),\n          supersedes: null,\n          updatedAt: entry.recordedAt ?? entry.promotedAt ?? timestamp(this.clock),\n        });\n        const key = this.#canonicalKey(candidate);\n        const current = canonicalByKey.get(key);\n        if (!current || Number(candidate.fitnessScore) > Number(current.fitnessScore ?? 0)) {\n          candidate.supersedes = current?.recordId ?? null;\n          if (current?.recordId && current.recordId !== candidate.recordId) retiredByCanonical.set(String(current.recordId), candidate.id);\n          canonicalByKey.set(key, candidate);\n        }\n",
    pre: "    for (const { collection, entry } of allRecords) {\n      if (![\"strategies\", \"lineage\", \"promotions\"].includes(collection) || !stableCanonicalEvidence(entry)) continue;\n      const candidate = safeRecord({\n        id: \"canonical:\" + hashText(semanticCapability(collection, entry) + \"::\" + String(entry.lineageId ?? \"\") + \":\" + String(entry.id ?? \"\")),\n        state: \"CANONICAL\",\n        lifecycleState: \"CANONICAL\",\n        capability: semanticCapability(collection, entry),\n        lineageId: entry.lineageId ?? null,\n        sourceCollection: collection,\n        recordId: entry.id ?? null,\n        strategyId: entry.strategyId ?? (collection === \"strategies\" ? entry.id : null),\n        generationId: entry.generationId ?? null,\n        version: entry.version ?? null,\n        promotionId: entry.promotionId ?? entry.id ?? null,\n        experimentId: entry.experimentId ?? entry.sourceExperimentId ?? null,\n        fitnessScore: Number(entry.fitnessScore ?? entry.fitness ?? 0),\n        implementation: safeRecord(entry.manifest ?? entry.component ?? entry.strategy ?? {}),\n        evidence: safeRecord(entry.evidence ?? entry.stability ?? {}),\n        supersedes: null,\n        updatedAt: entry.recordedAt ?? entry.promotedAt ?? timestamp(this.clock),\n      });\n      const key = this.#canonicalKey(candidate);\n      const current = canonicalByKey.get(key);\n      if (!current || Number(candidate.fitnessScore) > Number(current.fitnessScore ?? 0)) {\n        candidate.supersedes = current?.recordId ?? null;\n        if (current?.recordId && current.recordId !== candidate.recordId) retiredByCanonical.set(String(current.recordId), candidate.id);\n        canonicalByKey.set(key, candidate);\n",
  },
  {
    post: "    for (const entry of this.#data.canonical) canonicalByKey.set(this.#canonicalKey(entry), materialize ? clone(entry) : entry);\n",
    pre: "    for (const entry of this.#data.canonical) canonicalByKey.set(this.#canonicalKey(entry), clone(entry));\n",
  },
  {
    post: "    for (const collection of collections) {\n      for (const entry of histories[collection]) {\n        // A plain observed cycle is a transport envelope for raw observations,\n        // not durable knowledge by itself. Ignore those payload references while\n        // planning retention so the observations can be aggregated/compacted.\n        // Preserve references from meaningful cycles (proposal/experiment/\n        // validation/promotion) because those remain addressable evidence.\n        const referenceSource = collection === \"knowledge\"\n          ? { ...entry, sourceRefs: undefined, eventIds: undefined, recentEvidence: undefined }\n          : collection === \"cycles\" && isConsolidatableCycle(entry)\n            ? { ...entry, observations: undefined, diagnoses: undefined, gaps: undefined }\n            : entry;\n        const ids = referencedIds([referenceSource]);\n        if (entry?.id !== undefined) ids.delete(String(entry.id));\n        for (const idValue of ids) references.add(String(idValue));\n        if (isActiveExperiment(entry)) for (const idValue of ids) unresolvedReferences.add(String(idValue));\n        if (collection === \"lineage\" && entry?.lineageId) {\n          const previous = latestLineage.get(String(entry.lineageId));\n          const generation = Number(entry.generation ?? 0);\n          if (!previous || generation >= Number(previous.entry.generation ?? 0)) latestLineage.set(String(entry.lineageId), { entry, id: String(entry.id ?? \"\") });\n        }\n",
    pre: "    for (const { collection, entry } of allRecords) {\n      // A plain observed cycle is a transport envelope for raw observations,\n      // not durable knowledge by itself. Ignore those payload references while\n      // planning retention so the observations can be aggregated/compacted.\n      // Preserve references from meaningful cycles (proposal/experiment/\n      // validation/promotion) because those remain addressable evidence.\n      const referenceSource = collection === \"knowledge\"\n        ? { ...entry, sourceRefs: undefined, eventIds: undefined, recentEvidence: undefined }\n        : collection === \"cycles\" && isConsolidatableCycle(entry)\n          ? { ...entry, observations: undefined, diagnoses: undefined, gaps: undefined }\n          : entry;\n      const ids = referencedIds([referenceSource]);\n      if (entry?.id !== undefined) ids.delete(String(entry.id));\n      for (const idValue of ids) references.add(String(idValue));\n      if (isActiveExperiment(entry)) for (const idValue of ids) unresolvedReferences.add(String(idValue));\n      if (collection === \"lineage\" && entry?.lineageId) {\n        const previous = latestLineage.get(String(entry.lineageId));\n        const generation = Number(entry.generation ?? 0);\n        if (!previous || generation >= Number(previous.entry.generation ?? 0)) latestLineage.set(String(entry.lineageId), { entry, id: String(entry.id ?? \"\") });\n",
  },
  {
    post: "    // `histories` is this plan's own row view: hot rows are copies (decisions\n    // keep `history()`'s clone shape), freshly parsed cold rows and archive-cache\n    // window rows are read as they are. A cache row is copied only where the\n    // plan would hand it out, so neither the store nor the cache ever shares a\n    // row with the output. See `#historyPlanRows()`.\n    const planRows = Object.fromEntries(collections.map((collection) => [collection, this.#historyPlanRows(collection)]));\n    const histories = Object.fromEntries(collections.map((collection) => [collection, planRows[collection].rows]));\n    // A cache-window row is JSON.parse output, so every decision may read it;\n    // copying it here is only about who owns the row the plan returns.\n    const materializeRow = (plan, row) => plan && row && typeof row === \"object\" && plan.windowRows.has(row) ? clone(row) : row;\n    const materializeKnowledgeRow = materialize ? (row) => materializeRow(planRows.knowledge, row) : null;\n",
    pre: "    const histories = Object.fromEntries(collections.map((collection) => [collection, this.history(collection)]));\n    const allRecords = collections.flatMap((collection) => histories[collection].map((entry) => ({ collection, entry })));\n",
  },
  {
    post: "  /**\n   * Build the retention plan for one snapshot of the histories.\n   *\n   * `materialize` is false only for `compact({ dryRun: true })`: that caller\n   * returns the report and discards the plan, so the output arrays and the\n   * copies inside them are not built. Every decision, every clock read and\n   * every input row is still evaluated in the same order, so the report is the\n   * one a materialised plan would have produced. Every other caller (the write\n   * path of `compact()` and `finalizeKnowledge()`) keeps the complete\n   * `records`, `canonical` and `tombstones` output.\n   */\n  #retentionPlan({ materialize = true } = {}) {\n",
    pre: "  #retentionPlan() {\n",
  },
  {
    post: "      // A cache-window seed is read as the JSON value it is, but once it is the\n      // plan's output the cache must not share it: `materializeRow` copies that\n      // one case. A dry run passes null and keeps the read-only view.\n      knowledgeByKey.set(key, materializeRow ? materializeRow(entry) : entry);\n",
    pre: "      knowledgeByKey.set(key, entry);\n",
  },
  {
    post: "  #knowledgeRetentionPlan(histories, references = new Set(), materializeRow = null) {\n",
    pre: "  #knowledgeRetentionPlan(histories, references = new Set()) {\n",
  },
  {
    post: "   * `histories` is the plan's own row view (see `#historyPlanRows()`): live hot\n   * rows are already copies, freshly parsed cold rows have no other owner, and a\n   * row the archive read cache retains is copied by `materializeRow` before it\n   * can reach the output. `records` is handed to the caller, which takes\n   * ownership, and nothing reads `histories` after this returns. The accumulator\n   * merge is the only step that produces new objects.\n",
    pre: "   * `histories` is already a plan-owned deep copy (`#mergeArchived` clones), so\n   * the plan's knowledge output reuses those row objects instead of copying\n   * them again: `records` is handed to the caller, which takes ownership, and\n   * nothing reads `histories` after this returns. The accumulator merge is the\n   * only step that produces new objects.\n",
  },
  {
    post: "  /**\n   * The plan's view of one collection's complete history, split by ownership.\n   *\n   * `rows` has the same order and the same rows as `historyView(collection)`,\n   * with one exception: a live hot row is replaced by `history()`'s deep copy of\n   * it. The plan's decisions read every row, and the pre-change plan read the\n   * cloned form; a hot row may be a non-JSON value (an Error DTO in an in-memory\n   * store loses its custom fields in `structuredClone`), so reading it live would\n   * change retirement decisions. That copy is plan-owned.\n   *\n   * `windowRows` holds the rows the archive read cache still owns: a cold row the\n   * cache retained in its window and `#readArchiveSync()` therefore served as\n   * itself instead of as a fresh parse. A row the archive produced is JSON.parse\n   * output - a plain object or array - so reading it and reading its copy decide\n   * the same thing; the plan copies it only when it is about to hand it out\n   * (`materializeRow`), which keeps the output detached from the cache. A row\n   * that does not even have that top-level shape cannot have come from the\n   * archive (a cache handed to this instance may carry one), so it is copied\n   * here, exactly as `history()` copied it for the pre-change plan. Every other\n   * object row was parsed by this call and has no other owner, so the plan may\n   * use and later transfer it as it is. The sets are plan-local and are dropped\n   * before the plan returns.\n   */\n  #historyPlanRows(collection) {\n    const rows = this.historyView(collection);\n    const hot = this.#data[collection];\n    const hotRows = hot?.length ? new Set(hot) : null;\n    const window = this.#archiveReadCacheFor(collection)?.window;\n    const windowRows = new Set();\n    const rawWindowRows = new Set();\n    if (window) for (const row of window) {\n      if (!row || typeof row !== \"object\") continue;\n      windowRows.add(row);\n      const prototype = Object.getPrototypeOf(row);\n      if (prototype === Object.prototype || prototype === Array.prototype) rawWindowRows.add(row);\n    }\n    for (let index = 0; index < rows.length; index += 1) {\n      const row = rows[index];\n      if (!row || typeof row !== \"object\") continue;\n      if ((hotRows && hotRows.has(row)) || (windowRows.has(row) && !rawWindowRows.has(row))) rows[index] = clone(row);\n    }\n    return { rows, windowRows };\n  }\n\n",
    pre: "",
  },
];

/**
 * Reverse the retention-plan-streaming round, then hand the result to the older
 * chain. Each anchor must occur exactly once, so a stale hunk cannot silently
 * reconstruct something else.
 */
export function reverseRetentionPlanStreamingRound(file, source) {
  if (file === FILE) {
    for (const { post, pre } of HUNKS) {
      assert.equal(source.split(post).length - 1, 1,
        `${file}: retention-plan-streaming reversal anchor must occur exactly once`);
      source = source.replace(post, pre);
    }
  }
  return reverseKnowledgeHotWindowRound(file, source);
}
