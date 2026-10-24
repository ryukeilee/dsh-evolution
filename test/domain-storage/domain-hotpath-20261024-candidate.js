// The identity-skip candidate that the 2026-10-24 hot-path round implemented,
// measured and then rejected.
//
// It is kept as a *patch*, never as a second implementation: `installPending()`
// returns early when the official handle still answers with the exact document
// object this port last published and that document has no pending record, so
// the full `schema.parse()` of the live document is skipped on the common path.
// The regression in `domain-hotpath-20261024-entry-validation.test.js` derives
// this source and asserts that it publishes documents the working tree refuses;
// `scripts/benchmarks/domain-hotpath-20261024.mjs` derives it to measure what the
// skip would have been worth. Both derive from this one list, so the counterexample
// and its measurement cannot drift apart.
//
// Every replacement must occur exactly once in the working source. Drift there
// fails loudly instead of silently deriving a different program.
export const CANDIDATE_PATCHES = [
  ["  async function installPending() {\n",
   "  let published = null;\n" +
   "  async function publish(validated) { await domain.global.set(validated); published = validated; }\n" +
   "  async function installPending() {\n"],
  ["    const current = schema.parse(domain.global.get());\n",
   "    const live = domain.global.get();\n" +
   "    if (live === published && live.pending === null\n" +
   "      && typeof live.aggregate === 'object' && !Array.isArray(live.aggregate)\n" +
   "      && typeof live.applied === 'object' && !Array.isArray(live.applied)) return;\n" +
   "    const current = schema.parse(live);\n"],
  ["      await domain.global.set(schema.parse({ schema: 1, aggregate: latest.aggregate",
   "      await publish(schema.parse({ schema: 1, aggregate: latest.aggregate"],
  ["      await domain.global.set(schema.parse({ schema: 1, aggregate, applied: ledger",
   "      await publish(schema.parse({ schema: 1, aggregate, applied: ledger"],
  ["    await domain.global.set({ schema: 1, aggregate: current.pending.aggregate",
   "    await publish({ schema: 1, aggregate: current.pending.aggregate"],
  ["        await domain.global.set(schema.parse({ schema: 1, aggregate: { evolution:",
   "        await publish(schema.parse({ schema: 1, aggregate: { evolution:"],
];

export function deriveCandidate(source) {
  let derived = source;
  for (const [before, after] of CANDIDATE_PATCHES) {
    const occurrences = derived.split(before).length - 1;
    if (occurrences !== 1) {
      throw new Error(`the rejected candidate patch must match exactly once, found ${occurrences}: ${JSON.stringify(before.slice(0, 64))}`);
    }
    derived = derived.replace(before, after);
  }
  if (derived === source) throw new Error('the rejected candidate must differ from the working source');
  return derived;
}

/**
 * The shapes the counterexample edits into the live document, in place, through
 * the official handle. `washedOut` is what the rejected candidate does with each
 * one: it publishes the transaction anyway, because the illegal value is dropped
 * when the document is re-generated from the memory snapshot (or, for the marker
 * table, it refuses - but only after the stage mirror exists).
 *
 * `repair` puts the same object back into a schema-valid shape so a test can
 * prove the same workload commits once the document is valid again. `issue` is
 * the exact `schema.parse` issue the entry validation reports for the shape, so a
 * test can pin the refusal to the entry document check instead of accepting any
 * error (a different error would mean a different boundary refused, which is not
 * the same guarantee).
 */
export const COUNTEREXAMPLE_SHAPES = {
  "aggregate-schema-below-minimum": {
    edit: (document) => { document.aggregate.evolution.schema = 3; },
    repair: (document) => { document.aggregate.evolution.schema = 4; },
    issue: { code: "too_small", path: ["aggregate", "evolution", "schema"] },
    washedOut: true,
  },
  "top-level-schema-not-1": {
    edit: (document) => { document.schema = 2; },
    repair: (document) => { document.schema = 1; },
    issue: { code: "invalid_value", path: ["schema"] },
    washedOut: true,
  },
  "unknown-top-level-key": {
    edit: (document) => { document.extra = { note: "not part of the document" }; },
    repair: (document) => { delete document.extra; },
    issue: { code: "unrecognized_keys", path: [] },
    washedOut: true,
  },
  "non-string-marker-value": {
    edit: (document) => { document.applied["evolution:measurement-completed:bench"] = 42; },
    repair: (document) => { delete document.applied["evolution:measurement-completed:bench"]; },
    issue: { code: "invalid_type", path: ["applied", "evolution:measurement-completed:bench"] },
    washedOut: false,
  },
};
