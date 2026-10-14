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
];

export function reconstructPreSharedScan(source) {
  for (const [after, before] of reversals) {
    assert.equal(source.split(after).length - 1, 1,
      "shared-scan post-change shape must occur exactly once before reconstruction");
    source = source.replace(after, before);
  }
  assert.doesNotMatch(source, /#scanArchiveRaw/, "the baseline must predate shared scans");
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
