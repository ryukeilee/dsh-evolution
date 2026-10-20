/**
 * Differential equivalence for the canonical knowledge identity projection.
 *
 * The working tree computes a record's canonical knowledge key from the six
 * identity dimensions without materialising the outcome/metrics/recovery/
 * reference fields, and the append path scans a source collection's complete
 * history without copying it (`#sourceMatches`). Both sit on the record path
 * (`#upsertKnowledgeUnlocked` / `#knowledgeEntryFor`) and on
 * `canonicalKnowledgeKey()`'s fallback; the public `memory.history('knowledge')`
 * read that `domainStorage.recall()` uses is unchanged. They must leave every
 * recorded value and every retention decision byte-identical.
 *
 * The baseline is a committed pre-change artifact, extracted into a temporary
 * directory and imported as-is; nothing is re-implemented here. `lib/` is a
 * shipped path, and `release/dsh-evolution-0.2.0-rc.10.tgz` is the released
 * implementation this change landed on top of, so it is the frozen pre-change
 * source for it. The manifest pin moves on with every candidate, so the anchor
 * is named explicitly instead of following it. The shape assertion below makes
 * a lost or moved anchor fail loudly here instead of silently turning this
 * test into a self-comparison.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { EvolutionMemory } from "../../lib/dockyard-domain/memory.js";
import { canonicalKnowledgeKey, knowledgeKeyOf, normalizeKnowledgeEvent } from "../../lib/dockyard-domain/knowledge.js";
import { JsonStateStore } from "./support.js";
import { RELEASE_DIR } from "../../scripts/release/release-lib.mjs";

const NOW = "2026-10-12T00:00:00.000Z";

const PRE_CHANGE_ARTIFACT = "dsh-evolution-0.2.0-rc.10.tgz";
const baselineArtifact = join(RELEASE_DIR, PRE_CHANGE_ARTIFACT);
assert.ok(existsSync(baselineArtifact),
  `${PRE_CHANGE_ARTIFACT} is the authoritative pre-change source for the knowledge identity projection; restore it or move the anchor deliberately`);
const baselineRoot = await mkdtemp(join(tmpdir(), "dsh-knowledge-baseline-"));
execFileSync("tar", ["-xzf", baselineArtifact, "-C", baselineRoot, "package/lib"], { stdio: "ignore" });
const baselineKnowledge = await import(pathToFileURL(join(baselineRoot, "package/lib/dockyard-domain/knowledge.js")).href);
const baselineMemory = await import(pathToFileURL(join(baselineRoot, "package/lib/dockyard-domain/memory.js")).href);
test.after(() => rm(baselineRoot, { recursive: true, force: true }));

test("the baseline anchor predates this change", () => {
  assert.equal(PRE_CHANGE_ARTIFACT, "dsh-evolution-0.2.0-rc.10.tgz", "the anchor must be a deliberate, reviewed edit");
  assert.equal(
    typeof baselineKnowledge.knowledgeKeyOf,
    "undefined",
    `${PRE_CHANGE_ARTIFACT} already contains knowledgeKeyOf: re-anchor this differential test to a pre-change baseline`,
  );
});

// ---------------------------------------------------------------------------
// The identity projection is value-identical
// ---------------------------------------------------------------------------

/** One astral code point, which is two UTF-16 code units. */
const ASTRAL = "\u{20000}";

const CORPUS = [
  42, "text", null, undefined, [], {}, { problem: "real problem" },
  { type: "network-error", componentId: "plugin:edge-cache" },
  { knowledgeKey: "knowledge:" + "a".repeat(32), dimensions: { scope: "plugin:x" } },
  { knowledgeKey: "custom-key-not-prefixed", problem: "custom key subject" },
  { semanticKey: "knowledge:explicit", componentId: "plugin:explicit" },
  { issueType: "timeout", severity: "error", message: "official operation failed", componentId: "plugin:a" },
  { rootCause: "warmup race in edge cache", scope: "plugin:edge-cache" },
  { diagnosis: { rootCause: "nested cause" }, target: "plugin:nested" },
  { failure: { cause: "nested failure cause" } },
  { strategy: { retries: 3, target: "plugin:strategy" }, candidateGroup: "plugin:strategy" },
  { strategyKeyGenerated: true, manifest: { id: "manifest-id" }, capabilityId: "capability:a" },
  { semanticFact: "warmup latency regression", strategyKeyGenerated: false, solution: "raise ttl" },
  { problem: "中文问题描述：边缘缓存预热延迟", componentId: "plugin:中文" },
  { problem: "p".repeat(600), scope: "s".repeat(600) },
  // 121 astral characters: 242 UTF-16 code units but only 121 code points, so
  // the pin's unit bound cut this dimension while this tree keeps it whole.
  // See `ASTRAL_RECORD`.
  { problem: ASTRAL.repeat(121) },
  { problem: "same", scope: "same", type: "observation" },
  { problem: "same", scope: "same", type: "diagnosis" },
  { problem: "numbers 123 and 456", componentId: "plugin:numbers" },
  { problem: "id deadbeefdeadbeef and 12345678-1234-1234-1234-123456789012" },
  { recordedAt: new Date(NOW), rootCause: "dated cause", occurredAt: NOW, status: "failed", metrics: { latency: 12 } },
  { problem: "metrics transition", metrics: { latency: 12, throughput: 100 }, status: "measured", success: true, fitness: 0.8 },
  { problem: "recovered", recovery: { rollbackPoint: "record-1", reason: "restored", restored: true } },
  { problem: "contradicted", contradictsKnowledgeKey: "knowledge:" + "b".repeat(32) },
  { problem: "related", experimentId: "exp-1", proposalId: "proposal-1", promotionId: "promotion-1", generationId: "gen-1" },
  { problem: "reference", knowledgeKey: "knowledge:" + "c".repeat(32), dimensions: { stale: true }, eventId: "event-1", id: "row-1" },
  // The two identifier collapses now spell out their upper-case range instead
  // of carrying the `i` flag. These shapes pin the class and its `\b`
  // boundaries: an 8+ run, a dashed run, mixed case, digits, and the NFKC
  // forms that normalize into them before the collapse runs.
  { problem: "id DEADBEEFDEADBEEF and ABCDEF1234567890", componentId: "plugin:hex" },
  { problem: "dash abcdef12-3456-7890-abcd-1234567890ab tail", componentId: "plugin:dash" },
  { failureMode: "ABCDEF12-3456-7890", rootCause: "ABCDEF12-3456-7890" },
  { problem: "ＡＢＣＤＥＦ１２３４ : colon １２３４", componentId: "plugin:fullwidth" },
  { problem: "mixed DEADbeef12345678-ABCDEF12 shorter abcdef", componentId: "plugin:mixed" },
  { problem: "hex before a word DEADBEEF12x and after xDEADBEEF12", componentId: "plugin:boundary" },
  // Only the explicit key carries a signal, so these records are decided by the
  // fallback path: its full normalization, and the canonical-prefix test that
  // can never survive that normalization.
  { knowledgeKey: "knowledge:" + "d".repeat(32) },
  { knowledgeKey: "knowledge:DEAD-BEEF-1234" },
  { knowledgeKey: "not-prefixed" },
  { knowledgeKey: "!!!" },
  { knowledgeKey: "’" },
  { knowledgeKey: "  " },
  { canonicalKnowledgeKey: "knowledge:" + "e".repeat(32) },
  { semanticKey: "knowledge:Semantic-Key-0123456789" },
  // A dimension signal and a canonical-looking explicit key together: the key
  // must still come from the dimensions.
  { knowledgeKey: "knowledge:" + "f".repeat(32), problem: "dimension wins", componentId: "plugin:precedence" },
  { knowledgeKey: "knowledge:" + "1".repeat(32), type: "network-error", componentId: "plugin:precedence-2" },
  // The separator collapse that used to run in front of the class collapse is a
  // subset of it, and both replace a maximal run with one space, so a separator
  // run, the class run that contains it and the same shape written with a plain
  // space must all normalize alike.
  { problem: "a_/\\|:b", componentId: "plugin:sep" },
  { problem: "a!b@c", componentId: "plugin:sep" },
  { problem: "a b", componentId: "plugin:sep" },
  { problem: "a_/\\|:b !c", componentId: "plugin:sep" },
  { failureMode: "a\\|/_:b", rootCause: "a_/\\|:b" },
  // The phrase replacements sit below the class collapse and still match when
  // the space between their words arrives as a control character: the class
  // collapse converts that run before them.
  { problem: "time\u0000out", componentId: "plugin:control-phrase" },
  { problem: "network\u0000error", componentId: "plugin:control-phrase" },
  { problem: "not\u0000found", componentId: "plugin:control-phrase" },
  { problem: "out\u0000of\u0000memory", componentId: "plugin:control-phrase" },
  { problem: "rate\u0000limit", componentId: "plugin:control-phrase" },
  { failureMode: "time\u001fout", rootCause: "network\u0000error" },
  { failureMode: "not\u0000found" },
  { failureMode: "out\u0000of\u0000memory" },
  { failureMode: "rate\u0000limit" },
  // A run of whitespace or invisible spaces collapses to one space, and the trim
  // `boundedText()` performs is the only trim left on this path.
  { problem: "  double  spaced  ", componentId: "plugin:space" },
  { problem: '"lead", trailing ', componentId: "plugin:space" },
  { problem: "   leading", componentId: "plugin:space" },
  { problem: "trailing\t\t", componentId: "plugin:space" },
  { problem: "a\tb\nc", componentId: "plugin:space" },
  { problem: "a\u00a0b", componentId: "plugin:space" },
  { problem: "a\u3000b", componentId: "plugin:space" },
  { problem: "\u0000lead\t", componentId: "plugin:space" },
  { semanticFact: "\u0000\u001f  mixed\t\u00a0\u3000 run  ", componentId: "plugin:space" },
  { problem: "\u0000@\u0001 mixed_\t/ run", componentId: "plugin:control-run" },
  // The two quote folds stay chained ahead of the class collapse.
  { problem: "’‘“”", componentId: "plugin:quotes" },
  { problem: "a’b‘c“d”e", componentId: "plugin:quotes" },
  { failureMode: "’unclosed", rootCause: "“opened" },
  // The dashed identifier collapse is retained: a dashed hex run folds even
  // when its letters are lower case.
  { problem: "deadbeef-feedface", componentId: "plugin:dashed" },
  { problem: "12345678-1234-1234-1234-123456789012", componentId: "plugin:dashed" },
  { problem: "abcd-1234", componentId: "plugin:dashed" },
  // Each of the six dimensions carries a signal on its own here, so the hash
  // projection's key set and sorted order are exercised by every one of them.
  { issueType: "latency-regression", scope: "plugin:dimension-type" },
  { rootCause: "dimension root cause, only signal", componentId: "plugin:dimension-root" },
  { strategy: "raise the retry budget", scope: "plugin:dimension-strategy" },
  { failureMode: "dimension failure mode, only signal", componentId: "plugin:dimension-pattern" },
  { semanticFact: "dimension semantic fact, only signal", componentId: "plugin:dimension-fact" },
  { problem: "dimension scope signal", componentId: "plugin:dimension-scope" },
];

// ---------------------------------------------------------------------------
// The deliberate identity drift, and the bound that contains it
// ---------------------------------------------------------------------------

/**
 * The value bound the pin applied to one identity dimension, in the units the
 * pin applied it to: UTF-16 code units. A value can sit inside this bound as a
 * number of code points and still be past it as a number of units, which is why
 * "fits in 240 code points" is not the condition that keeps a value identical.
 */
const IDENTITY_BOUND = 240;
/** The digest a repaired dimension carries, in hex characters. */
const IDENTITY_DIGEST_CHARS = 16;
/**
 * The two bounds `knowledge.js` bounds an identity dimension with: `MAX_TEXT`
 * for a string dimension and the 360 it uses for the serialized object form of
 * `strategy`. Both are the bounds of this file's anchor, so neither is derived
 * from the working tree.
 */
const IDENTITY_BOUNDED_LENGTHS = [240, 360];
const IDENTITY_DIGEST = new RegExp(`…#[0-9a-f]{${IDENTITY_DIGEST_CHARS}}$`);

function pinnedEvent(input) { return baselineKnowledge.normalizeKnowledgeEvent(input, { sourceCollection: "observations", now: new Date(NOW) }); }
function workingEvent(input) { return normalizeKnowledgeEvent(input, { sourceCollection: "observations", now: new Date(NOW) }); }

/**
 * Whether a record is inside the identity drift this round repaired on purpose.
 *
 * The defect: the bounded form of a dimension cut it at its 240th UTF-16 code
 * unit and replaced the rest with `…`, so two facts that agreed in their first
 * 239 units shared one `knowledgeKey` - measured: `"z".repeat(300) + "x"` and
 * `"z".repeat(300) + "y"` reached one key - and a cut could split a surrogate
 * pair. The repair keeps the bounded prefix cut on a code point boundary and
 * appends a 16-character digest of the complete normalized text, so a dimension
 * the pin had to cut carries that digest in this tree and a dimension it did not
 * cut is returned byte-identically.
 *
 * The drift therefore starts at the pin's own bound - 240 UTF-16 code units, not
 * 240 code points - and it has exactly two shapes, both exempted here and both
 * pinned by literal below:
 *
 * - the pin cut the value and this tree cut it too, so the working value is the
 *   digest form inside one of the two identity bounds (`REDACTED_RECORD`);
 * - the pin cut the value and this tree keeps it whole, because its length is
 *   past the bound in units while its code point count is not - astral text such
 *   as 121 `U+20000`, the surrogate-pair half of the same repair
 *   (`ASTRAL_RECORD`).
 *
 * The exemption is exactly those two shapes and nothing else: the pinned value
 * must end with the cut marker (`…`), the working value must differ from it, and
 * the working value must then be the digest form at one of the two identity
 * bounds, or a value inside the bound as this tree counts it. A record that
 * merely *looks* cut - a short fact that ends with `…` - is not exempted, and
 * neither is any other difference: those fail the byte-equality assertions below
 * instead of widening this predicate.
 */
function dimensionIsIntentionallyRedacted(record) {
  const before = pinnedEvent(record);
  const after = workingEvent(record);
  if (!before?.dimensions || !after?.dimensions) return false;
  for (const name of new Set([...Object.keys(before.dimensions), ...Object.keys(after.dimensions)])) {
    const pinnedValue = before.dimensions[name];
    const workingValue = after.dimensions[name];
    if (typeof pinnedValue !== "string" || typeof workingValue !== "string") continue;
    if (pinnedValue === workingValue || !pinnedValue.endsWith("…")) continue;
    // Cut here as well: the value carries the digest of its complete text.
    if (IDENTITY_DIGEST.test(workingValue) && IDENTITY_BOUNDED_LENGTHS.includes([...workingValue].length)) return true;
    // Kept whole instead of cut: the pin's bound is a unit bound, so a value past
    // it in units can still fit inside it in code points.
    if ([...workingValue].length <= IDENTITY_BOUND) return true;
  }
  return false;
}

/**
 * The two corpus records inside that drift.
 *
 * `REDACTED_RECORD` is the digest shape: the retained 222 code points of each
 * long dimension, the digest of its complete normalized text, and the key the
 * six-dimension projection hashes to.
 *
 * `ASTRAL_RECORD` is the kept-whole shape: 121 `U+20000` are 121 code points but
 * 242 UTF-16 code units, so the pin's unit bound cut the dimension - inside the
 * 121st code point, leaving an unpaired high surrogate in `PINNED_ASTRAL_DIMENSION`
 * - while this tree keeps it whole, which is why the two keys differ.
 *
 * Both are written out here instead of recomputed, so a change to the digest, to
 * the retained prefix, to the kept-whole boundary or to the projection fails on a
 * literal instead of comparing the tree with itself.
 */
const REDACTED_RECORD = { problem: "p".repeat(600), scope: "s".repeat(600) };
const REDACTED_DIMENSIONS = {
  issueType: "problem",
  rootCause: "",
  strategy: "",
  failureMode: "",
  semanticFact: `${"p".repeat(222)}…#61ec9a9a3abbc531`,
  scope: `${"s".repeat(222)}…#1a30f3c9486b338d`,
};
const REDACTED_KEY = "knowledge:c6df9a460b39ebb6bbeb3a6c32aa5ffd";
/** The cut key the pin computes for that same record. */
const PINNED_REDACTED_KEY = "knowledge:a4140724cdaede476430ef1bf3eee498";

const ASTRAL_RECORD = { problem: ASTRAL.repeat(121) };
const ASTRAL_DIMENSIONS = {
  issueType: "problem",
  rootCause: "",
  strategy: "",
  failureMode: "",
  semanticFact: ASTRAL.repeat(121),
  scope: "",
};
const ASTRAL_KEY = "knowledge:0d3f950e4e395edeca11d94df07e5135";
/** What the pin stored for that dimension: 239 UTF-16 units, then the marker. */
const PINNED_ASTRAL_DIMENSION = `${ASTRAL.repeat(119)}\ud840…`;
/** The cut key the pin computes for that same record. */
const PINNED_ASTRAL_KEY = "knowledge:4cfc70bfe3b1b7992b73262d0419f46d";

/**
 * Every corpus record inside the deliberate drift, with the exact values this
 * tree produces for it and the exact key the pin produced. A record the
 * predicate exempts but this list does not hold fails in the drift test below, so
 * the exemption can never cover a shape that is not pinned here.
 */
const DRIFTED_RECORDS = [
  { record: REDACTED_RECORD, dimensions: REDACTED_DIMENSIONS, knowledgeKey: REDACTED_KEY, pinnedKey: PINNED_REDACTED_KEY },
  { record: ASTRAL_RECORD, dimensions: ASTRAL_DIMENSIONS, knowledgeKey: ASTRAL_KEY, pinnedKey: PINNED_ASTRAL_KEY },
];

function driftedRecordFor(entry) { return DRIFTED_RECORDS.find((drifted) => isDeepStrictEqual(entry, drifted.record)); }

/**
 * How many dimensions of the whole corpus take each of the two drift shapes. The
 * digest form is the two long dimensions of `REDACTED_RECORD`; the kept-whole
 * form is the single astral dimension of `ASTRAL_RECORD`, which carries no digest
 * because this tree never cut it. The counts stay separate on purpose: neither
 * shape may spread to a second dimension, and neither may stand in for the other.
 */
const DIGEST_DIMENSIONS = 2;
const KEPT_WHOLE_DIMENSIONS = 1;

test("normalizeKnowledgeEvent stays value-identical to the pinned implementation", () => {
  const redacted = [];
  for (const entry of CORPUS) {
    const before = pinnedEvent(entry);
    const after = workingEvent(entry);
    if (dimensionIsIntentionallyRedacted(entry)) {
      // The shapes this round changes on purpose: a dimension the pin had to cut
      // at its bound, and a dimension the pin cut but this tree keeps whole. Their
      // exact new values are pinned in `DRIFTED_RECORDS`, and every other record
      // still has to match the pin byte for byte below.
      const drifted = driftedRecordFor(entry);
      assert.ok(drifted, `a record inside the drift must be one of the ${DRIFTED_RECORDS.length} pinned ones: ${JSON.stringify(entry)?.slice(0, 80)}`);
      redacted.push(entry);
      assert.deepEqual(after.dimensions, drifted.dimensions, `the repaired dimensions of ${JSON.stringify(entry)?.slice(0, 60)} changed`);
      assert.equal(after.knowledgeKey, drifted.knowledgeKey, `the repaired key of ${JSON.stringify(entry)?.slice(0, 60)} changed`);
      assert.equal(before.knowledgeKey, drifted.pinnedKey, `the pin's key for ${JSON.stringify(entry)?.slice(0, 60)} changed`);
      continue;
    }
    assert.deepEqual(after, before, `normalizeKnowledgeEvent drifted for ${JSON.stringify(entry)?.slice(0, 80)}`);
  }
  assert.deepEqual(redacted, DRIFTED_RECORDS.map((drifted) => drifted.record),
    `exactly ${DRIFTED_RECORDS.length} corpus records are inside the deliberate drift; a wider drift must fail here`);
});

/**
 * The deliberate drift starts exactly past the bound and nowhere before it. The
 * bound is the pin's own: 240 UTF-16 code units. A dimension at or below it is
 * returned whole and keeps the pin's bytes; past it every value changes, either
 * to the digest form (the cut stands) or to the whole value (a cut that landed
 * inside a surrogate pair is undone). This is the property that makes the
 * exemption above safe, so it is pinned directly as well as over the whole
 * corpus.
 */
test("the deliberate identity drift starts exactly past the 240-UTF-16-unit bound", () => {
  // ASCII: one unit per code point, so this loop pins the unit bound and the code
  // point bound at once.
  for (const length of [1, 221, 222, 239, 240]) {
    const input = { semanticFact: "w".repeat(length) };
    assert.equal(workingEvent(input).dimensions.semanticFact, "w".repeat(length), `a ${length}-unit dimension must be returned whole`);
    assert.deepEqual(workingEvent(input), pinnedEvent(input), `a ${length}-unit dimension must stay byte-identical to the pin`);
    assert.equal(dimensionIsIntentionallyRedacted(input), false, `a ${length}-unit dimension is not inside the drift`);
  }
  for (const length of [241, 242, 500]) {
    const input = { semanticFact: "w".repeat(length) };
    const pinnedValue = pinnedEvent(input).dimensions.semanticFact;
    const workingValue = workingEvent(input).dimensions.semanticFact;
    assert.equal(pinnedValue, `${"w".repeat(239)}…`, `the pin must have cut the ${length}-unit dimension at its own bound`);
    assert.match(workingValue, /^w{222}…#[0-9a-f]{16}$/, `the repaired ${length}-unit dimension must be the bounded digest form`);
    assert.equal([...workingValue].length, IDENTITY_BOUND, `the repaired ${length}-unit dimension must stay inside the bound`);
    assert.equal(dimensionIsIntentionallyRedacted(input), true, `a ${length}-unit dimension is inside the drift`);
    assert.notEqual(workingEvent(input).knowledgeKey, pinnedEvent(input).knowledgeKey, `a ${length}-unit dimension must not keep the cut identity`);
  }
  // Astral: 120 characters are 240 units, the last value the pin returned whole.
  const atBound = ASTRAL.repeat(120);
  assert.equal(atBound.length, IDENTITY_BOUND, "the astral value at the bound must be exactly 240 UTF-16 units");
  assert.equal([...atBound].length, 120);
  assert.equal(workingEvent({ semanticFact: atBound }).dimensions.semanticFact, atBound, "a 240-unit astral dimension must be returned whole");
  assert.deepEqual(workingEvent({ semanticFact: atBound }), pinnedEvent({ semanticFact: atBound }), "a 240-unit astral dimension must stay byte-identical to the pin");
  assert.equal(dimensionIsIntentionallyRedacted({ semanticFact: atBound }), false, "a 240-unit astral dimension is not inside the drift");
  // 121 characters are 121 code points but 242 units, so the pin cut this value.
  const input = { semanticFact: ASTRAL.repeat(121) };
  const pinnedValue = pinnedEvent(input).dimensions.semanticFact;
  const workingValue = workingEvent(input).dimensions.semanticFact;
  assert.equal(pinnedValue, PINNED_ASTRAL_DIMENSION, "the pin's cut of the astral dimension changed");
  assert.equal(pinnedValue, `${ASTRAL.repeat(119)}\ud840…`, "the pin's cut must land inside the 121st code point");
  assert.equal(pinnedValue.isWellFormed(), false, "the pin's cut must have left an unpaired high surrogate behind");
  assert.equal(workingValue, ASTRAL.repeat(121), "the repaired astral dimension must be kept whole even though it is past the bound in units");
  assert.equal([...workingValue].length, 121, "the kept astral dimension must sit inside the bound in code points");
  assert.equal(workingValue.isWellFormed(), true, "the kept astral dimension must not carry a split surrogate pair");
  assert.equal(dimensionIsIntentionallyRedacted(input), true, "a value the pin cut and this tree keeps whole is inside the drift");
  assert.notEqual(workingEvent(input).knowledgeKey, pinnedEvent(input).knowledgeKey, "a kept astral dimension must not keep the cut identity");
});

/**
 * The convergence check over the whole corpus: a dimension outside the two drift
 * shapes is byte-identical to the pin, and each shape appears exactly as often as
 * `DRIFTED_RECORDS` says - the digest form twice (the two long dimensions of the
 * `REDACTED_RECORD`) and the kept-whole form once (the astral dimension of
 * `ASTRAL_RECORD`) - and nowhere else. A drift that reached a second shape,
 * spread to a second dimension, or touched a dimension the bound never applied to
 * fails here before any exemption could cover it; the exact values of the shapes
 * that are allowed are pinned by literal in the drift test above.
 */
test("every dimension outside the two drift shapes keeps the pin's bytes", () => {
  let compared = 0;
  let digests = 0;
  let keptWhole = 0;
  for (const entry of CORPUS) {
    const before = pinnedEvent(entry);
    const after = workingEvent(entry);
    if (!before?.dimensions || !after?.dimensions) continue;
    for (const name of new Set([...Object.keys(before.dimensions), ...Object.keys(after.dimensions)])) {
      const pinnedValue = before.dimensions[name];
      const workingValue = after.dimensions[name];
      if (typeof workingValue === "string" && workingValue !== pinnedValue && IDENTITY_DIGEST.test(workingValue)) {
        digests += 1;
        assert.equal([...workingValue].length, IDENTITY_BOUND, `the digest dimension ${name} must sit inside the bound`);
        assert.ok(pinnedValue.endsWith("…"), `the digest dimension ${name} must be one the pin cut`);
        continue;
      }
      if (typeof workingValue === "string" && workingValue !== pinnedValue && [...workingValue].length <= IDENTITY_BOUND) {
        keptWhole += 1;
        assert.ok(pinnedValue.endsWith("…"), `the kept-whole dimension ${name} must be one the pin cut`);
        assert.ok(pinnedValue.length === IDENTITY_BOUND, `the kept-whole dimension ${name} must be one the pin cut at its unit bound`);
        assert.ok(workingValue.isWellFormed(), `the kept-whole dimension ${name} must not carry the pin's split surrogate pair`);
        continue;
      }
      assert.equal(workingValue, pinnedValue,
        `the dimension ${name} of ${JSON.stringify(entry)?.slice(0, 60)} must stay byte-identical to the pin`);
      compared += 1;
    }
  }
  assert.equal(digests, DIGEST_DIMENSIONS,
    `exactly the ${DIGEST_DIMENSIONS} long dimensions of the digest-shaped record may carry the digest`);
  assert.equal(keptWhole, KEPT_WHOLE_DIMENSIONS,
    `exactly the ${KEPT_WHOLE_DIMENSIONS} dimension the pin cut and this tree keeps whole may differ without a digest`);
  assert.ok(compared >= 200, `only ${compared} dimensions were compared; the bound check must not be vacuous`);
});

/**
 * The six dimension names the canonical projection is built from. A record whose
 * identity is decided by its dimensions must expose exactly these, and no
 * dimension name may be dropped by the compaction the pre-change hash applied
 * to them.
 */
const DIMENSION_NAMES = ["failureMode", "issueType", "rootCause", "scope", "semanticFact", "strategy"];

/**
 * The projection `stableStringify()` produces for a six-dimension object: keys in
 * sorted order, every value kept. Re-derived here instead of imported, so the
 * hashes below are an independent reconstruction rather than a copy.
 */
function projectionHash(dimensions) {
  const projection = {};
  for (const key of Object.keys(dimensions).sort()) projection[key] = dimensions[key];
  return createHash("sha256").update(JSON.stringify(projection)).digest("hex").slice(0, 32);
}

/**
 * Whether the working tree's own compaction keeps a dimension name, read through
 * its public API rather than copied from `VOLATILE_KEYS`: an object-valued
 * `strategy` is a `stableStringify()` of the caller's object, so this is exactly
 * the filter the pre-change `hash(dimensions)` applied to the projection. A name
 * this filter drops would make `identitySerialization()` hash a projection the
 * pre-change code would not have hashed. `assert.ok(hashed >= 50)` below keeps
 * the probe's cost bounded to one call per name.
 */
function workingCompactionKeeps(name) {
  const probe = normalizeKnowledgeEvent({ strategy: { [name]: "probe" }, rootCause: "anchor" }, { sourceCollection: "observations", now: new Date(NOW) });
  return probe?.dimensions?.strategy === JSON.stringify({ [name]: "probe" });
}

/**
 * Two stored keys that normalize to two different non-empty texts. A record
 * whose identity ignores both of them is decided by its dimensions, so its key
 * is the hash of the projection; a record whose key follows the stored key is
 * decided by the explicit-key path and is skipped, because no hash of a
 * projection decides it.
 */
const PROBE_KEYS = ["probe key one", "probe key two"];

/**
 * The identity hash is the digest of the six-dimension projection in sorted key
 * order. Two different checks keep that true, and each catches a different
 * failure:
 *
 * - the *pinned* side below re-hashes the released implementation's own
 *   `dimensions`, so it pins the values the projection hashes; a dimension
 *   rename or a name that changes the released identity fails here, and the
 *   file's other differential tests fail with it;
 * - the *working* side is self-consistency: the working key must be the sorted
 *   projection of the working tree's own `dimensions`, that projection must
 *   expose exactly the six names, and the working tree's compaction must keep
 *   every one of them. Dropping a name from `identitySerialization()`, adding a
 *   seventh dimension to the projection without extending the literal, or
 *   teaching the working tree's volatile filter a dimension name fails here,
 *   before any pinned value is even consulted.
 */
test("the identity hash is the sorted six-dimension projection of the pin", () => {
  const signalled = new Set();
  let hashed = 0;
  for (const entry of CORPUS) {
    const label = JSON.stringify(entry)?.slice(0, 80);
    const before = baselineKnowledge.normalizeKnowledgeEvent(entry, { sourceCollection: "observations", now: new Date(NOW) });
    const pinnedKey = before?.knowledgeKey ?? null;
    const probeKeys = PROBE_KEYS.map((key) => baselineKnowledge.normalizeKnowledgeEvent({ ...entry, knowledgeKey: key }, { sourceCollection: "observations", now: new Date(NOW) })?.knowledgeKey ?? null);
    if (pinnedKey === null || probeKeys.some((key) => key !== pinnedKey)) continue;
    assert.ok(before?.dimensions, `a hashed record must expose its dimensions: ${label}`);
    const expected = "knowledge:" + projectionHash(before.dimensions);
    if (dimensionIsIntentionallyRedacted(entry)) {
      // The pin cut this record's long dimensions, so the pinned projection is the
      // projection of the cut values and no longer this tree's identity. The test
      // above pins the exact replacement, including the key asserted here; the
      // two self-consistency assertions below still run, so the working hash must
      // still be the sorted projection of the working tree's own dimensions.
      const drifted = driftedRecordFor(entry);
      assert.ok(drifted, `a record inside the drift must be one of the ${DRIFTED_RECORDS.length} pinned ones: ${label}`);
      assert.equal(knowledgeKeyOf(entry), drifted.knowledgeKey, `the repaired key drifted for ${label}`);
    } else {
      assert.equal(before.knowledgeKey, expected, `the pinned hash is not the sorted projection of its own dimensions for ${label}`);
      assert.equal(knowledgeKeyOf(entry), expected, `the working hash drifted from the pinned projection for ${label}`);
    }
    // Self-consistency, so a projection that grows past the literal cannot hide
    // behind the pinned expectation: the working key must hash the projection
    // the working tree itself produced.
    const working = normalizeKnowledgeEvent(entry, { sourceCollection: "observations", now: new Date(NOW) });
    assert.deepEqual(Object.keys(working?.dimensions ?? {}).sort(), DIMENSION_NAMES,
      `the working projection must expose exactly the six dimensions for ${label}`);
    assert.equal(knowledgeKeyOf(entry), "knowledge:" + projectionHash(working.dimensions),
      `the working hash must be the sorted projection of its own dimensions for ${label}`);
    for (const [name, value] of Object.entries(before.dimensions)) if (value) signalled.add(name);
    hashed += 1;
  }
  assert.ok(hashed >= 50, `only ${hashed} records exercised the hash branch; the projection property must not be vacuous`);
  assert.deepEqual([...signalled].sort(), DIMENSION_NAMES,
    "every dimension must carry a signal in at least one hashed record, so all six names are exercised");
  for (const name of DIMENSION_NAMES) {
    assert.ok(workingCompactionKeeps(name),
      `the working tree's own compaction must keep the dimension name ${name}: a name it drops would make the serialized projection disagree with the projection compactValue() defines`);
  }
});

test("the key-only projection returns exactly the recomputed key", () => {
  for (const entry of CORPUS) {
    const recomputed = pinnedEvent(entry)?.knowledgeKey ?? null;
    if (dimensionIsIntentionallyRedacted(entry)) {
      // The pin recomputes the cut identity for these records; the exact repaired
      // key and the repaired canonical key are pinned in the drift test above.
      const drifted = driftedRecordFor(entry);
      assert.ok(drifted, `a record inside the drift must be one of the ${DRIFTED_RECORDS.length} pinned ones: ${JSON.stringify(entry)?.slice(0, 80)}`);
      assert.equal(recomputed, drifted.pinnedKey, `the pin's recomputation of ${JSON.stringify(entry)?.slice(0, 60)} changed`);
      assert.equal(knowledgeKeyOf(entry), drifted.knowledgeKey, `knowledgeKeyOf drifted for ${JSON.stringify(entry)?.slice(0, 80)}`);
      assert.equal(canonicalKnowledgeKey(entry, { sourceCollection: "observations", now: new Date(NOW) }), drifted.knowledgeKey,
        `canonicalKnowledgeKey drifted for ${JSON.stringify(entry)?.slice(0, 80)}`);
      continue;
    }
    assert.equal(knowledgeKeyOf(entry), recomputed, `knowledgeKeyOf drifted for ${JSON.stringify(entry)?.slice(0, 80)}`);
    assert.equal(
      canonicalKnowledgeKey(entry, { sourceCollection: "observations", now: new Date(NOW) }),
      baselineKnowledge.canonicalKnowledgeKey(entry, { sourceCollection: "observations", now: new Date(NOW) }),
      `canonicalKnowledgeKey drifted for ${JSON.stringify(entry)?.slice(0, 80)}`,
    );
  }
});

/**
 * The identity reads the explicit key only when no dimension carries a signal.
 * This pins the rule itself rather than only its agreement with the pin, so a
 * later re-pin cannot silently turn it into a self-comparison: a stored key
 * that looks canonical must not override the dimensions, and a record whose
 * dimensions carry no signal and whose explicit key normalizes away is not
 * knowledge-bearing at all.
 */
test("a canonical-looking stored key never overrides the dimensions", () => {
  const dimensionsOnly = { problem: "dimension wins", componentId: "plugin:precedence" };
  const expected = normalizeKnowledgeEvent(dimensionsOnly, { sourceCollection: "observations", now: new Date(NOW) })?.knowledgeKey;
  assert.ok(expected?.startsWith("knowledge:"));
  for (const key of ["knowledge:" + "f".repeat(32), "knowledge:DEAD-BEEF-1234", "knowledge:"]) {
    assert.equal(knowledgeKeyOf({ ...dimensionsOnly, knowledgeKey: key }), expected,
      `a stored key must not change the identity of ${JSON.stringify(key)}`);
  }
  // No dimension signal: the explicit key decides, and only a non-empty
  // normalization of it makes the record knowledge-bearing.
  assert.equal(knowledgeKeyOf({ knowledgeKey: "not-prefixed" }),
    normalizeKnowledgeEvent({ knowledgeKey: "not-prefixed" }, { sourceCollection: "observations", now: new Date(NOW) })?.knowledgeKey);
  assert.equal(knowledgeKeyOf({ knowledgeKey: "!!!" }), null);
  assert.equal(knowledgeKeyOf({ knowledgeKey: "  " }), null);
});

// ---------------------------------------------------------------------------
// The append path is byte-identical, including the recomputed-key fallback
// ---------------------------------------------------------------------------

/**
 * A cold row that carries no stored key, so matching it depends on recomputing
 * the canonical key from its own fields — the path this change must preserve.
 */
const LEGACY = {
  id: "legacy-observation",
  type: "tool/error",
  code: "HOST_OPERATION_FAILED",
  message: "official operation failed",
  componentId: "plugin:edge-cache",
  severity: "error",
  status: "failed",
  problem: "edge cache warmup latency",
  target: "plugin:edge-cache",
  capabilityId: "plugin:edge-cache",
  metrics: { latency: 12 },
  recordedAt: "2026-10-01T00:00:00.000Z",
};

const INCOMING = {
  id: "incoming-observation",
  type: "tool/error",
  code: "HOST_OPERATION_FAILED",
  message: "official operation failed",
  componentId: "plugin:edge-cache",
  severity: "error",
  status: "failed",
  problem: "edge cache warmup latency",
  target: "plugin:edge-cache",
  capabilityId: "plugin:edge-cache",
  metrics: { latency: 12 },
  recordedAt: NOW,
};

/** A second subject, used where one append must not explain the other's outcome. */
const OTHER_INCOMING = {
  ...INCOMING,
  id: "incoming-other",
  problem: "edge cache eviction regression",
  componentId: "plugin:edge-other",
  target: "plugin:edge-other",
  capabilityId: "plugin:edge-other",
};

function memory(MemoryClass, store, options = {}) {
  const instance = new MemoryClass({
    stateStore: store, clock: () => new Date(NOW), hotEntries: 1, archiveMaxBytes: 1024 * 1024, ...options,
  });
  instance.setMutationAuthority({ assertMutation() {}, isActive: () => true });
  return instance;
}

async function scenario(MemoryClass, home) {
  const store = new JsonStateStore({ home });
  const archive = `${store.filePath}.observations-archive.jsonl`;
  await mkdir(dirname(archive), { recursive: true });
  // Two cold rows: one matched only by recomputing its key, one unrelated.
  await writeFile(archive, [JSON.stringify(LEGACY), JSON.stringify({ ...LEGACY, id: "unrelated", componentId: "plugin:other", target: "plugin:other" })].join("\n") + "\n");
  const instance = memory(MemoryClass, store);
  await instance.load();
  const first = await instance.recordObservation(INCOMING);
  // Mutating a returned record must never reach stored state.
  first.problem = "mutated after return";
  first.nested = { mutated: true };
  const second = await instance.recordObservation({ ...INCOMING, id: "incoming-observation-2", recordedAt: "2026-10-13T00:00:00.000Z" });
  second.status = "mutated";
  return {
    returned: [first, second],
    // Absolute archive paths are part of the durable projection; the two runs
    // use different temporary homes, so compare after substituting the root.
    state: (await readFile(store.filePath, "utf8")).split(home).join("<home>"),
    archive: await readFile(archive, "utf8"),
    snapshot: JSON.stringify(instance.snapshot()).split(home).join("<home>"),
  };
}

test("the append path stays byte-identical to the pinned implementation", async () => {
  const beforeHome = await mkdtemp(join(tmpdir(), "dsh-knowledge-before-"));
  const afterHome = await mkdtemp(join(tmpdir(), "dsh-knowledge-after-"));
  try {
    const before = await scenario(baselineMemory.EvolutionMemory, beforeHome);
    const after = await scenario(EvolutionMemory, afterHome);
    assert.equal(after.state, before.state, "the persisted durable state changed");
    assert.equal(after.archive, before.archive, "the cold archive bytes changed");
    assert.equal(after.snapshot, before.snapshot, "the in-memory projection changed");
    // The legacy row is matched by recomputing its key, and the incoming row is
    // a duplicate of it: retention keeps one source representative, exactly as
    // the pinned implementation does.
    assert.equal(after.returned[0].problem, "mutated after return");
    assert.equal(before.returned[0].problem, "mutated after return");
    assert.equal(after.archive.split("\n").filter(Boolean).length, before.archive.split("\n").filter(Boolean).length);
  } finally {
    await rm(beforeHome, { recursive: true, force: true });
    await rm(afterHome, { recursive: true, force: true });
  }
});

/**
 * The recomputed-key fallback decides a real retention outcome: a cold row
 * without a stored key still matches its own subject, and `observations` keeps
 * a single source representative per successful subject.
 */
const SUCCESS_INCOMING = {
  id: "success-observation",
  type: "tool/error",
  code: "HOST_OPERATION_FAILED",
  message: "official operation failed",
  componentId: "plugin:edge-cache",
  severity: "error",
  status: "failed",
  success: true,
  problem: "edge cache warmup latency",
  target: "plugin:edge-cache",
  capabilityId: "plugin:edge-cache",
  recordedAt: NOW,
};

async function fallbackScenario(MemoryClass, home) {
  const store = new JsonStateStore({ home });
  const archive = `${store.filePath}.observations-archive.jsonl`;
  await mkdir(dirname(archive), { recursive: true });
  await writeFile(archive, `${JSON.stringify(LEGACY)}\n`);
  const instance = memory(MemoryClass, store, { hotEntries: 8 });
  await instance.load();
  const matched = await instance.recordObservation(SUCCESS_INCOMING);
  const unrelated = await instance.recordObservation({ ...SUCCESS_INCOMING, id: "unrelated-observation", componentId: "plugin:other", target: "plugin:other", capabilityId: "plugin:other" });
  return {
    matchedReturned: matched.id,
    retained: (instance.snapshot().observations ?? []).map((entry) => entry.id),
    unrelatedReturned: unrelated.id,
  };
}

/**
 * The same cold fixture as `fallbackScenario`, but the row carries a stored
 * canonical-looking key belonging to a different subject. `#sourceMatches()`
 * compares that key first and then recomputes the row's own identity, so a
 * stale key must not lose the match and must not be treated as authoritative.
 */
const STALE_COLD = { ...LEGACY, id: "stale-key-observation", knowledgeKey: "knowledge:" + "9".repeat(32) };

async function staleKeyScenario(MemoryClass, home) {
  const store = new JsonStateStore({ home });
  const archive = `${store.filePath}.observations-archive.jsonl`;
  await mkdir(dirname(archive), { recursive: true });
  await writeFile(archive, `${JSON.stringify(STALE_COLD)}\n`);
  const instance = memory(MemoryClass, store, { hotEntries: 8 });
  await instance.load();
  const matched = await instance.recordObservation(SUCCESS_INCOMING);
  const unrelated = await instance.recordObservation({ ...SUCCESS_INCOMING, id: "unrelated-observation", componentId: "plugin:other", target: "plugin:other", capabilityId: "plugin:other" });
  return {
    matchedReturned: matched.id,
    retained: (instance.snapshot().observations ?? []).map((entry) => entry.id),
    unrelatedReturned: unrelated.id,
    archive: await readFile(archive, "utf8"),
    state: existsSync(store.filePath) ? (await readFile(store.filePath, "utf8")).split(home).join("<home>") : null,
  };
}

test("a cold row without a stored key still matches by its recomputed key", async () => {
  const beforeHome = await mkdtemp(join(tmpdir(), "dsh-knowledge-fallback-before-"));
  const afterHome = await mkdtemp(join(tmpdir(), "dsh-knowledge-fallback-after-"));
  try {
    const before = await fallbackScenario(baselineMemory.EvolutionMemory, beforeHome);
    const after = await fallbackScenario(EvolutionMemory, afterHome);
    assert.deepEqual(after, before, "the recomputed-key retention decision changed");
    // The matching source is folded into the cold row (the returned record is
    // the cold one, not the incoming id), while the unrelated subject is kept.
    assert.equal(after.matchedReturned, LEGACY.id);
    assert.deepEqual(after.retained, ["unrelated-observation"]);
  } finally {
    await rm(beforeHome, { recursive: true, force: true });
    await rm(afterHome, { recursive: true, force: true });
  }
});

test("a cold row with a stale stored key still matches by its recomputed key", async () => {
  const beforeHome = await mkdtemp(join(tmpdir(), "dsh-knowledge-stale-before-"));
  const afterHome = await mkdtemp(join(tmpdir(), "dsh-knowledge-stale-after-"));
  try {
    const before = await staleKeyScenario(baselineMemory.EvolutionMemory, beforeHome);
    const after = await staleKeyScenario(EvolutionMemory, afterHome);
    assert.deepEqual(after, before, "a stale stored key changed the match, the retention or the persisted bytes");
    // `#sourceMatches()` compares the stored key first, so the stale key does
    // not describe this row's subject at all; the recomputation is what finds
    // it, and retention folds the incoming source into that cold row.
    assert.equal(after.matchedReturned, STALE_COLD.id);
    assert.equal(after.unrelatedReturned, "unrelated-observation");
    assert.deepEqual(after.retained, ["unrelated-observation"]);
    assert.ok(after.archive.includes(STALE_COLD.knowledgeKey),
      "the cold row's own stored key must survive the fold; only the recomputation proves the match");
  } finally {
    await rm(beforeHome, { recursive: true, force: true });
    await rm(afterHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The knowledge lookup resolves the same row without copying the whole view
// ---------------------------------------------------------------------------

/**
 * A canonical knowledge row built by the pinned implementation, so the cold
 * fixture is the pre-change code's own output rather than this tree's.
 */
function coldKnowledgeRow(input, count) {
  const event = baselineKnowledge.normalizeKnowledgeEvent(input, { sourceCollection: "observations", now: new Date(NOW) });
  const row = baselineKnowledge.mergeKnowledgeEntry(null, event, { now: new Date(NOW) });
  return { ...row, count, occurrenceCount: count };
}

/**
 * Two appends against a knowledge archive that already holds their canonical
 * rows: one subject only in the archive, one whose id the hot pool overrides.
 * Resolving both is what the lookup under test does, and each accumulator's
 * `count` is what proves which row was found — a missed lookup would create a
 * fresh row with `count` 1 instead of accumulating onto the stored one.
 */
async function coldKnowledgeScenario(MemoryClass, home, { mutate = false } = {}) {
  const store = new JsonStateStore({ home });
  const archive = `${store.filePath}.knowledge-archive.jsonl`;
  await mkdir(dirname(archive), { recursive: true });
  const archivedOnly = coldKnowledgeRow({ ...INCOMING, id: "cold-observation", recordedAt: "2026-10-01T00:00:00.000Z" }, 1);
  const overridden = coldKnowledgeRow({ ...OTHER_INCOMING, id: "cold-other", recordedAt: "2026-10-01T00:00:00.000Z" }, 1);
  await writeFile(archive, [JSON.stringify(archivedOnly), JSON.stringify(overridden)].join("\n") + "\n");
  await mkdir(dirname(store.filePath), { recursive: true });
  await writeFile(store.filePath, JSON.stringify({ evolution: { schema: 4, knowledge: [coldKnowledgeRow(OTHER_INCOMING, 5)] } }));
  const instance = memory(MemoryClass, store);
  await instance.load();
  const hotBefore = instance.snapshot().knowledge.map((entry) => `${entry.id}:${entry.count}`).join("|");
  const first = await instance.recordObservation(INCOMING);
  const second = await instance.recordObservation(OTHER_INCOMING);
  if (mutate) {
    // A returned record is detached; mutating it must never reach stored state.
    first.problem = "mutated after return";
    first.metrics.latency = 10 ** 6;
    second.problem = "mutated after return";
  }
  const full = instance.fullSnapshot().knowledge;
  const countOf = (key) => full.find((entry) => entry?.knowledgeKey === key)?.count ?? null;
  return {
    hotBefore,
    returnedIds: [first.id, second.id],
    archivedOnlyCount: countOf(archivedOnly.knowledgeKey),
    overriddenCount: countOf(overridden.knowledgeKey),
    rowCount: full.length,
    rowIds: full.map((entry) => entry.id),
    state: (await readFile(store.filePath, "utf8")).split(home).join("<home>"),
    archive: (await readFile(archive, "utf8")).split(home).join("<home>"),
    full: JSON.stringify(full).split(home).join("<home>"),
  };
}

test("a cold knowledge row is resolved into the same detached accumulator as before", async () => {
  const beforeHome = await mkdtemp(join(tmpdir(), "dsh-knowledge-lookup-before-"));
  const afterHome = await mkdtemp(join(tmpdir(), "dsh-knowledge-lookup-after-"));
  const cleanHome = await mkdtemp(join(tmpdir(), "dsh-knowledge-lookup-clean-"));
  try {
    const before = await coldKnowledgeScenario(baselineMemory.EvolutionMemory, beforeHome, { mutate: true });
    const after = await coldKnowledgeScenario(EvolutionMemory, afterHome, { mutate: true });
    const clean = await coldKnowledgeScenario(EvolutionMemory, cleanHome);
    assert.equal(after.state, before.state, "the persisted durable state changed");
    assert.equal(after.archive, before.archive, "the cold archive bytes changed");
    assert.equal(after.full, before.full, "the durable projection changed");
    assert.equal(after.hotBefore, before.hotBefore);
    assert.deepEqual(after.returnedIds, before.returnedIds, "the append stopped returning the recorded source");
    assert.deepEqual(after.rowIds, before.rowIds, "the canonical row set changed");
    // The archive-only subject accumulated onto the cold row, and the id the hot
    // pool overrides still wins over its archived copy (5 + 1, not 1 + 1).
    assert.equal(after.archivedOnlyCount, 2);
    assert.equal(after.overriddenCount, 6);
    assert.equal(before.archivedOnlyCount, 2);
    assert.equal(before.overriddenCount, 6);
    assert.equal(after.rowCount, 2);
    // Mutating the returned records never reaches stored state.
    assert.equal(clean.state, after.state, "a returned record leaked into durable state");
    assert.equal(clean.archive, after.archive, "a returned record leaked into the cold archive");
    assert.equal(clean.full, after.full, "a returned record leaked into the projection");
  } finally {
    for (const home of [beforeHome, afterHome, cleanHome]) await rm(home, { recursive: true, force: true });
  }
});

test("the recall read path stays value-identical to the pinned implementation", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-knowledge-recall-"));
  try {
    const store = new JsonStateStore({ home });
    const instance = memory(EvolutionMemory, store);
    await instance.load();
    await instance.recordObservation(INCOMING);
    await instance.recordObservation({ ...INCOMING, id: "incoming-2", recordedAt: "2026-10-13T00:00:00.000Z", success: false, rootCause: "warmup race" });
    const rows = instance.history("knowledge");
    const before = baselineKnowledge.normalizeKnowledgeEvent(rows[0] ?? {}, { sourceCollection: "knowledge", now: new Date(NOW) });
    const after = normalizeKnowledgeEvent(rows[0] ?? {}, { sourceCollection: "knowledge", now: new Date(NOW) });
    assert.deepEqual(after, before);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
