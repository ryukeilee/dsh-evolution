import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { readReleaseManifest, readTarEntries, releaseArtifactPath } from "../../scripts/release/release-lib.mjs";

// Each pair is [post-change text, pre-change text]. Exact, single-occurrence
// guards fail on any shape drift instead of silently reconstructing something
// that is not the real pre-change implementation.
const reversals = [
  ["// Index keys for one tombstone, with `===` semantics: NaN never matches itself\n// under `===`, so it must never become a Set member either.\nfunction addTombstoneIndexKeys(index, tombstone) {\n  if (tombstone.recordId === tombstone.recordId) index.ids.add(tombstone.recordId);\n  if (tombstone.fingerprint === tombstone.fingerprint) index.fingerprints.add(tombstone.fingerprint);\n  const candidate = tombstone.candidateFingerprint ?? tombstone.fingerprint;\n  if (candidate) index.candidateFingerprints.add(candidate);\n}\n\n",
   ""],
  ["      // Rules 1, 4, 5 and 7 all ask the same two questions about the tombstone\n      // list: \"is this record id retired?\" and \"is this fingerprint retired?\".\n      // The list grows with the session, so index it once per pass instead of\n      // rescanning it per retired record. Nothing but retire() below grows the\n      // list during a pass, and that keeps the index current.\n      //\n      // The indexed form is exactly `t.recordId === id` / `t.fingerprint === fp`\n      // (a Set is SameValueZero, so NaN is kept out on both sides). A tombstone\n      // that is not an object made those scans throw mid-pass; that shape keeps\n      // the original expressions so the same abort is preserved rather than\n      // being silently read as \"no match\".\n      let tombstoneIndex = null;\n      let tombstoneIndexBuilt = false;\n      const tombstoneIndexOf = () => {\n        if (tombstoneIndexBuilt) return tombstoneIndex;\n        tombstoneIndexBuilt = true;\n        const index = { ids: new Set(), fingerprints: new Set(), candidateFingerprints: new Set() };\n        for (const tombstone of this.#data.tombstones) {\n          if (tombstone === null || tombstone === undefined) return null;\n          addTombstoneIndexKeys(index, tombstone);\n        }\n        tombstoneIndex = index;\n        return index;\n      };\n      const retire = (collection, entry, reason) => {\n        const tombstone = tombstoneFor(collection, entry, { reason });\n        this.#data.tombstones.push(tombstone);\n        if (tombstoneIndex) addTombstoneIndexKeys(tombstoneIndex, tombstone);\n      };\n      // `t.recordId === id` under whichever scan is active.\n      const isRetiredId = (id) => {\n        const index = tombstoneIndexOf();\n        return index === null ? this.#data.tombstones.some((t) => t.recordId === id) : id === id && index.ids.has(id);\n      };\n      // Rules 4 and 5 derive the same fingerprint from the same record; derive\n      // it once per pass for records that do not already carry one.\n      const fingerprints = new WeakMap();\n      const fingerprintOf = (entry) => {\n        const explicit = entry.candidateFingerprint ?? entry.fingerprint;\n        if (explicit !== undefined) return explicit;\n        if (entry === null || typeof entry !== \"object\") return candidateFingerprint(entry, entry.problemFingerprint ?? problemFingerprint(entry));\n        const cached = fingerprints.get(entry);\n        if (cached !== undefined) return cached;\n        const computed = candidateFingerprint(entry, entry.problemFingerprint ?? problemFingerprint(entry));\n        fingerprints.set(entry, computed);\n        return computed;\n      };\n",
   ""],
  ["            toRemove.push(entry);\n            const fingerprint = entry.fingerprint ?? entry.candidateFingerprint;\n            const index = tombstoneIndexOf();\n            const exists = index === null\n              ? this.#data.tombstones.find((t) => t.recordId === entry.id || t.fingerprint === fingerprint)\n              : (entry.id === entry.id && index.ids.has(entry.id)) || (fingerprint === fingerprint && index.fingerprints.has(fingerprint));\n            if (!exists) retire(coll, entry, lifecycleState(entry).toLowerCase() || \"obsolete\");\n",
   "            toRemove.push(entry);\n            const exists = this.#data.tombstones.find((t) => t.recordId === entry.id || t.fingerprint === (entry.fingerprint ?? entry.candidateFingerprint));\n            if (!exists) this.#data.tombstones.push(tombstoneFor(coll, entry, { reason: lifecycleState(entry).toLowerCase() || \"obsolete\" }));\n"],
  ["        const byFp = new Map();\n        for (const entry of arr) {\n          const fp = fingerprintOf(entry);\n          const group = byFp.get(fp);\n          if (group === undefined) byFp.set(fp, [entry]);\n          else group.push(entry);\n        }\n        const retired = new Set();\n        for (const group of byFp.values()) {\n          if (group.length < 2) continue;\n          let best = group[0];\n          let bestScore = Number(best.fitnessScore ?? best.fitness ?? 0);\n          let bestTime = String(best.lastSeen ?? best.recordedAt ?? \"\");\n          for (let i = 1; i < group.length; i += 1) {\n            const entry = group[i];\n            const score = Number(entry.fitnessScore ?? entry.fitness ?? 0);\n            const time = String(entry.lastSeen ?? entry.recordedAt ?? \"\");\n            if (score > bestScore || (score === bestScore && time > bestTime)) {\n              best = entry;\n              bestScore = score;\n              bestTime = time;\n            }\n          }\n          if (tombstoneIndexOf() === null) {\n            // A tombstone list whose scans can throw can abort this loop after\n            // some records were already spliced out; that partial state is part\n            // of the original behaviour, so that shape keeps the original loop.\n            for (const e of group) {\n              if (e === best) continue;\n              const idx = arr.indexOf(e);\n              if (idx >= 0) arr.splice(idx, 1);\n              if (!this.#data.tombstones.find((t) => t.recordId === e.id)) {\n                this.#data.tombstones.push(tombstoneFor(coll, e, { reason: \"duplicate\" }));\n              }\n            }\n            continue;\n          }\n          for (const entry of group) {\n            if (entry === best) continue;\n            // `arr.indexOf(e)` never located NaN, so it must not enter the set.\n            if (entry === entry) retired.add(entry);\n            if (!isRetiredId(entry.id)) retire(coll, entry, \"duplicate\");\n          }\n        }\n        if (retired.size > 0) {\n          // The same records in the same order: compact in place once instead of\n          // running an indexOf/splice scan per removed duplicate.\n          let write = 0;\n          for (let read = 0; read < arr.length; read += 1) {\n            const entry = arr[read];\n            if (retired.has(entry)) continue;\n            arr[write] = entry;\n            write += 1;\n          }\n          arr.length = write;\n        }\n      }\n",
   "        const byFp = new Map();\n        for (const entry of arr) {\n          const fp = entry.candidateFingerprint ?? entry.fingerprint ?? candidateFingerprint(entry, entry.problemFingerprint ?? problemFingerprint(entry));\n          if (!byFp.has(fp)) byFp.set(fp, []);\n          byFp.get(fp).push(entry);\n        }\n        for (const group of byFp.values()) {\n          if (group.length < 2) continue;\n          let best = group[0];\n          for (const e of group.slice(1)) {\n            const bestScore = Number(best.fitnessScore ?? best.fitness ?? 0);\n            const eScore = Number(e.fitnessScore ?? e.fitness ?? 0);\n            const bestTime = String(best.lastSeen ?? best.recordedAt ?? \"\");\n            const eTime = String(e.lastSeen ?? e.recordedAt ?? \"\");\n            if (eScore > bestScore || (eScore === bestScore && eTime > bestTime)) best = e;\n          }\n          for (const e of group) {\n            if (e === best) continue;\n            const idx = arr.indexOf(e);\n            if (idx >= 0) arr.splice(idx, 1);\n            if (!this.#data.tombstones.find((t) => t.recordId === e.id)) {\n              this.#data.tombstones.push(tombstoneFor(coll, e, { reason: \"duplicate\" }));\n            }\n          }\n        }\n      }\n"],
  ["      // 5) Terminated proposals never back to hot (tombstone guard)\n      // Without a cold archive, this in-memory data is also the complete\n      // durable projection; retain reconciled records for fullSnapshot().\n      for (const coll of [\"candidates\", \"proposals\"]) {\n        if (!this.archiveFile) continue;\n        const arr = this.#data[coll];\n        if (!Array.isArray(arr)) continue;\n        const index = tombstoneIndexOf();\n        const tombFp = index === null ? new Set(this.#data.tombstones.map((t) => t.candidateFingerprint ?? t.fingerprint).filter(Boolean)) : index.candidateFingerprints;\n        const tombIds = index === null ? new Set(this.#data.tombstones.map((t) => t.recordId).filter(Boolean)) : index.ids;\n        const filtered = arr.filter((entry) => {\n          // A terminal record still in hot has not crossed the archive\n          // boundary; retain it until that durable handoff exists.\n          if (!this.archiveKnown.get(coll)?.has(this.#archiveKey(entry))) return true;\n          const fp = fingerprintOf(entry);\n",
   "      // 5) Terminated proposals never back to hot (tombstone guard)\n      // Without a cold archive, this in-memory data is also the complete\n      // durable projection; retain reconciled records for fullSnapshot().\n      for (const coll of [\"candidates\", \"proposals\"]) {\n        if (!this.archiveFile) continue;\n        const arr = this.#data[coll];\n        if (!Array.isArray(arr)) continue;\n        const tombFp = new Set(this.#data.tombstones.map((t) => t.candidateFingerprint ?? t.fingerprint).filter(Boolean));\n        const tombIds = new Set(this.#data.tombstones.map((t) => t.recordId).filter(Boolean));\n        const filtered = arr.filter((entry) => {\n          // A terminal record still in hot has not crossed the archive\n          // boundary; retain it until that durable handoff exists.\n          if (!this.archiveKnown.get(coll)?.has(this.#archiveKey(entry))) return true;\n          const fp = entry.candidateFingerprint ?? entry.fingerprint ?? candidateFingerprint(entry, entry.problemFingerprint ?? problemFingerprint(entry));\n"],
  ["          this.#data[coll] = arr.filter((e) => !ejectSet.has(e));\n          for (const entry of toEject) {\n            if (!isRetiredId(entry.id)) retire(coll, entry, lifecycleState(entry).toLowerCase() || \"terminal\");\n          }\n",
   "          this.#data[coll] = arr.filter((e) => !ejectSet.has(e));\n          for (const e of toEject) {\n            if (!this.#data.tombstones.find((t) => t.recordId === e.id)) {\n              this.#data.tombstones.push(tombstoneFor(coll, e, { reason: lifecycleState(e).toLowerCase() || \"terminal\" }));\n            }\n          }\n"],
];

/**
 * Revert only the housekeeping indexing change. Everything else in `source`
 * (including a later re-pin's unrelated changes) is left exactly as written, so
 * the result is the full implementation this change replaced.
 */
export function reconstructPreHousekeepingIndex(source) {
  for (const [after, before] of reversals) {
    assert.equal(source.split(after).length - 1, 1,
      "housekeeping post-change shape must occur exactly once before reconstruction");
    source = source.replace(after, before);
  }
  assert.doesNotMatch(source, /tombstoneIndexOf|fingerprintOf\(|addTombstoneIndexKeys|isRetiredId/,
    "the baseline must predate the housekeeping index");
  return source;
}

/** The `#performHousekeeping` block of a memory.js source, verbatim. */
export function housekeepingBlock(source) {
  const start = source.indexOf("  #performHousekeeping() {");
  const end = source.indexOf("  // Public deterministic alias for cycle/compaction callers");
  assert.ok(start > 0 && end > start, "memory.js must contain the housekeeping block");
  return source.slice(start, end);
}

/**
 * The pre-change implementation used by the equivalence test and the benchmark.
 *
 * The committed pin is authoritative while it predates this change: the
 * reconstruction must then reproduce its housekeeping block byte for byte.
 * After a re-pin the pin carries the indexed housekeeping, so the block
 * comparison is not applicable and the guarded reconstruction (which asserts
 * every replaced shape) supplies the baseline instead of skipping coverage.
 */
export async function housekeepingBaseline() {
  const working = await readFile(new URL("../../lib/dockyard-domain/memory.js", import.meta.url), "utf8");
  const reconstructed = reconstructPreHousekeepingIndex(working);
  const pinned = readTarEntries(releaseArtifactPath(readReleaseManifest()))
    .find((entry) => entry.path === "lib/dockyard-domain/memory.js");
  assert.ok(pinned, "the pinned artifact must ship the full memory implementation");
  const pinnedSource = pinned.bytes.toString("utf8");
  const pinPredatesIndex = !pinnedSource.includes("tombstoneIndexOf");
  if (pinPredatesIndex) {
    assert.equal(housekeepingBlock(reconstructed), housekeepingBlock(pinnedSource),
      "the reconstruction must be byte-identical to the authoritative pre-change pin");
  }
  return { source: reconstructed, reconstructed, pinPredatesIndex };
}
