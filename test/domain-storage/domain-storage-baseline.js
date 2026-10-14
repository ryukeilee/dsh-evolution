import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RELEASE_DIR, readTarEntries } from "../../scripts/release/release-lib.mjs";

const WORKING_SOURCE = fileURLToPath(new URL("../../lib/domain-storage.js", import.meta.url));

// The merged write-path variant under test landed after this artifact was
// pinned, so the artifact is the frozen pre-change source for it. The manifest
// pin moves on with every candidate, so the anchor is named explicitly instead
// of following it.
const PRE_CHANGE_ARTIFACT = "dsh-evolution-0.2.0-rc.8.tgz";
const SOURCE_PATH = "lib/domain-storage.js";

// [post-change text, pre-change text]. Reversing the change must reproduce the
// pinned artifact byte for byte; an exact single-occurrence guard fails on any
// shape drift instead of silently rebuilding something else.
//
// The three reversed pieces are the whole retained variant, and each one
// removes work that is provably redundant rather than any check that can still
// reject:
//
// 1. `installPending` closed a committed recovery by re-parsing the document it
//    had already parsed one step earlier. `pending.aggregate` and
//    `pending.applied` come straight out of that `schema.parse` result, and the
//    remaining fields are the literals `schema: 1` and `pending: null`, so the
//    closing document is provably accepted before the second walk starts. The
//    validation that must stay - the full document check that runs before any
//    staged file is installed - is untouched.
// 2. The state store's `update` cloned the incoming aggregate before handing it
//    to the updater, and then projected the result through
//    `aggregateSchema.parse`, which is itself a fresh deep value
//    (`JSON.parse(JSON.stringify(...))`). The clone could only be copied again.
//    Both updaters this store receives are pure spreads that never mutate their
//    argument.
// 3. The same store did not declare `inlineSerialization`, so `EvolutionMemory`
//    deep-cloned the live partition (`snapshot()`) before persisting it. The
//    bytes are captured synchronously by the JSON projection inside `update`,
//    so the shallow live view is equivalent and the clone is the third copy of
//    the same value in that call.
//
// A fourth candidate - dropping the `EvolutionObservationStore` that `hydrate()`
// loads and never reads - was measured with these three and then withdrawn: its
// `load()` is not inert, because `snapshot()` reads `memory.hasColdHistory`,
// which coerces every `coldArchives` entry with `Number(count)`. Dropping the
// call let the first commit after a durable aggregate with a non-coercible
// entry succeed where the released implementation refuses it. See
// `docs/performance/domain-write-path.md` section 4.
//
// The write-path variant is not the only change after the anchor: on-demand
// experience recall added a read-only `recall` method to the same port, and a
// read that never writes cannot change the persisted bytes this file's
// benchmark compares. It is still reversed below so the reconstruction keeps
// reproducing the pinned pre-change source byte for byte instead of silently
// dropping the anchor.
const reversals = [
  ["import { EvolutionMemory, EvolutionObservationStore, EvolutionEvaluator } from './dockyard-domain/index.js';\n" +
   "import { collectKnowledgeExperience } from './experience-recall.js';\n",
   "import { EvolutionMemory, EvolutionObservationStore, EvolutionEvaluator } from './dockyard-domain/index.js';\n"],
  ["    // Evaluator is deliberately advisory, never production authority.\n" +
   "    evaluate: evidence => evaluator.evaluate(evidence),\n" +
   "    // On-demand, bounded read of the canonical knowledge rows this store already\n" +
   "    // owns. It is model-free and only called by an explicit owner-triggered\n" +
   "    // action; a failure here is reported to the caller, never cached as\n" +
   "    // \"no history\".\n" +
   "    recall: (input = {}, options = {}) => {\n" +
   "      if (closing) throw new Error('E_DOMAIN_CLOSED');\n" +
   "      return collectKnowledgeExperience(memory.history('knowledge'), input, options);\n" +
   "    },\n" +
   "    close,\n",
   "    // Evaluator is deliberately advisory, never production authority.\n" +
   "    evaluate: evidence => evaluator.evaluate(evidence), close,\n"],
  ["    // The store is not read afterwards, but `load()` is not inert: its\n" +
   "    // `snapshot()` reads `memory.hasColdHistory`, which derives `Number(count)`\n" +
   "    // from every `coldArchives` entry and therefore rejects a durable\n" +
   "    // aggregate whose entry cannot be coerced. Removing this call silently\n" +
   "    // accepted the first commit after such a state was written; keeping it\n" +
   "    // preserves the loud failure the released implementation has.\n",
   ""],
  ["    // `current` is the output of `schema.parse` above, so `pending.aggregate`\n" +
   "    // and `pending.applied` are already validated projections of this exact\n" +
   "    // durable document; re-parsing them with the same schema can only\n" +
   "    // reproduce them. The two remaining fields are the literals below, which\n" +
   "    // are fixed valid values, so the closing document is provably accepted by\n" +
   "    // `schema` one step earlier and needs no second walk. The full validation\n" +
   "    // still happens before any staged file is installed, which is the boundary\n" +
   "    // that must not move.\n" +
   "    await domain.global.set({ schema: 1, aggregate: current.pending.aggregate, applied: current.pending.applied, pending: null });\n",
   "    await domain.global.set(schema.parse({ schema: 1, aggregate: current.pending.aggregate, applied: current.pending.applied, pending: null }));\n"],
  ["    // `inlineSerialization` is honest here: `update` captures the bytes with\n" +
   "    // the synchronous JSON projection inside `aggregateSchema.parse` before it\n" +
   "    // returns, so the caller's live shallow view cannot change what is\n" +
   "    // persisted. The projection already produces a fresh deep value, so the\n" +
   "    // extra clone of the incoming aggregate would only copy it twice; the\n" +
   "    // updaters handed to this store are pure (`{ ...state, [key]: payload }`)\n" +
   "    // and never mutate the argument they receive.\n" +
   "    const stateStore = { filePath: path.join(dir, 'state.json'), inlineSerialization: true, load: async () => structuredClone(aggregate),\n" +
   "      update: async updater => { aggregate = aggregateSchema.parse(updater(aggregate)); } };\n",
   "    const stateStore = { filePath: path.join(dir, 'state.json'), load: async () => structuredClone(aggregate),\n" +
   "      update: async updater => { aggregate = aggregateSchema.parse(updater(structuredClone(aggregate))); } };\n"],
];

/** Revert only the retained write-path variant; everything else stays as written. */
export function reconstructPreMerge(source) {
  for (const [after, before] of reversals) {
    assert.equal(source.split(after).length - 1, 1,
      "domain-storage merged-variant post-change shape must occur exactly once before reconstruction");
    source = source.replace(after, before);
  }
  return source;
}

/**
 * The pre-change implementation used by the equivalence test and the benchmark.
 *
 * `release/dsh-evolution-0.2.0-rc.8.tgz` is committed and predates this change,
 * so the reconstruction must reproduce its file byte for byte. That assertion is
 * deliberately unconditional: losing the anchor must be a conscious edit, not a
 * silent downgrade to a reconstruction that only checks its own shape.
 */
export async function domainStorageBaseline() {
  const working = await readFile(new URL("../../lib/domain-storage.js", import.meta.url), "utf8");
  const reconstructed = reconstructPreMerge(working);
  assert.notEqual(reconstructed, working, "the reconstruction must actually change the source");
  const artifact = join(RELEASE_DIR, PRE_CHANGE_ARTIFACT);
  assert.ok(fs.existsSync(artifact),
    `${PRE_CHANGE_ARTIFACT} is the authoritative pre-change source for the merged write-path variant; restore it or move the anchor deliberately`);
  const pinned = readTarEntries(artifact).find((entry) => entry.path === SOURCE_PATH);
  assert.ok(pinned, "the pinned artifact must ship the domain storage implementation");
  const pinnedSource = pinned.bytes.toString("utf8");
  assert.match(pinnedSource, /await domain\.global\.set\(schema\.parse\(\{ schema: 1, aggregate: current\.pending\.aggregate/,
    `${PRE_CHANGE_ARTIFACT} must predate the merged write-path variant`);
  assert.equal(reconstructed, pinnedSource,
    "the reconstruction must be byte-identical to the authoritative pre-change pin");
  return { source: reconstructed, reconstructed, anchor: { artifact: PRE_CHANGE_ARTIFACT, pinnedSource } };
}

/**
 * Materialise one `lib/domain-storage.js` source as an importable module so an
 * A/B run or a differential test can load the pre-change and post-change
 * implementations side by side. Relative specifiers resolve to the working
 * tree, so both implementations share the same sibling modules; bare specifiers
 * resolve through this process's module map. Only the file under test differs.
 */
export async function materializeDomainStorage(source, home, label) {
  const modulePath = join(home, `${label}.mjs`);
  const rewritten = source
    .replace(/from (["'])(\.\/[^"']+)\1/g,
      (_match, quote, specifier) => `from ${quote}${new URL(specifier, pathToFileURL(WORKING_SOURCE)).href}${quote}`)
    .replace(/from (["'])([^."'][^"']*)\1/g,
      (_match, quote, specifier) => `from ${quote}${import.meta.resolve(specifier)}${quote}`);
  await writeFile(modulePath, rewritten);
  const module = await import(pathToFileURL(modulePath).href);
  assert.equal(typeof module.openDomainStorage, "function", `${label} must export openDomainStorage`);
  assert.ok(module.evolutionDomainSpec, `${label} must export evolutionDomainSpec`);
  return module;
}
