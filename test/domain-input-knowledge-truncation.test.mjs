/**
 * The identity projection bounds every dimension before it hashes it. That
 * bound used to be the only thing two long facts were compared by: everything
 * past the 240th code unit was replaced with `…`, so two facts that shared the
 * retained prefix shared one identity, and a cut inside a surrogate pair could
 * leave an unpaired high surrogate in the stored dimension.
 *
 * The retained prefix stays, and the complete normalized text is digested into
 * the same bounded value. The bound is a count of UTF-16 code units, so the
 * condition that keeps a dimension byte-identical is "at most 240 UTF-16
 * units", not "at most 240 code points": past the bound in units, a value whose
 * code point count is still at most 240 is kept whole (the old cut is undone,
 * which changes its identity too), and a longer one is cut to 240 code points
 * and digested. The pinned keys below are the keys the implementation produced
 * before the digest existed.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { knowledgeKeyOf, normalizeKnowledgeEvent } from "../lib/dockyard-domain/knowledge.js";

const NOW = "2026-10-12T00:00:00.000Z";
const OPTIONS = { sourceCollection: "observations", now: new Date(NOW) };

function dimensionsOf(input) {
  return normalizeKnowledgeEvent(input, OPTIONS).dimensions;
}

function keyOf(input) {
  return normalizeKnowledgeEvent(input, OPTIONS).knowledgeKey;
}

test("a long dimension keeps the facts apart after its retained prefix", () => {
  const prefix = "warmup regression on the edge cache ".repeat(10);
  const left = `${prefix}x`;
  const right = `${prefix}y`;
  assert.equal(left.slice(0, 240), right.slice(0, 240), "the two facts share every retained character");
  assert.notEqual(keyOf({ semanticFact: left }), keyOf({ semanticFact: right }));
  assert.notEqual(dimensionsOf({ semanticFact: left }).semanticFact, dimensionsOf({ semanticFact: right }).semanticFact);
  const cases = [
    ["rootCause", { rootCause: left }, { rootCause: right }],
    ["failureMode", { failureMode: left }, { failureMode: right }],
    ["strategy", { strategy: left }, { strategy: right }],
    ["scope", { scope: left, issueType: "network-error" }, { scope: right, issueType: "network-error" }],
  ];
  for (const [dimension, leftInput, rightInput] of cases) {
    assert.notEqual(keyOf(leftInput), keyOf(rightInput), `${dimension} must not collide on a shared prefix`);
  }
  // Same subject, same key: the digest must not make identity depend on anything
  // but the text it was computed from.
  assert.equal(keyOf({ semanticFact: left }), keyOf({ semanticFact: left }));
});

test("a long strategy object keeps the facts apart after its retained prefix", () => {
  const shared = { field: "value ".repeat(60) };
  assert.notEqual(
    keyOf({ strategy: { ...shared, tail: "left" }, capabilityId: "plugin:s" }),
    keyOf({ strategy: { ...shared, tail: "right" }, capabilityId: "plugin:s" }),
  );
});

test("truncation never splits a surrogate pair", () => {
  // U+20000 is a letter outside the BMP: NFKC and the character-class collapse
  // both keep it, so the 240-code-point bound can land inside it.
  const astral = "\u{20000}";
  for (const lead of [200, 237, 238, 239]) {
    const dimension = dimensionsOf({ semanticFact: "z".repeat(lead) + astral + "b" }).semanticFact;
    assert.ok(dimension.isWellFormed(), `a lone surrogate survived for a ${lead}-character lead: ${JSON.stringify(dimension)}`);
    if (lead < 222) assert.ok(dimension.includes(astral), `an astral character inside the retained prefix must survive intact for a ${lead}-character lead`);
  }
  const paired = "y".repeat(238) + astral + astral + "c";
  assert.ok(dimensionsOf({ semanticFact: paired }).semanticFact.isWellFormed());
});

test("a dimension that fits is not truncated and keeps its existing identity", () => {
  // The keys below are what the pre-digest implementation produced; every
  // dimension here normalizes to at most 240 code units.
  const pinned = [
    [{ problem: "same", componentId: "c" }, "knowledge:dc963ae5af3f8edf7ae6eb3f252e2c36"],
    [{ semanticFact: "warmup latency regression on edge cache" }, "knowledge:b98ead4fdfd788727df5cf275aa6a4a0"],
    [{ rootCause: "warmup race in edge cache", scope: "plugin:edge-cache" }, "knowledge:8ff292bde4935b7b1dd464acca966911"],
    [{ issueType: "timeout", severity: "error", message: "official operation failed", componentId: "plugin:a" }, "knowledge:f9648b554a120c8e5f277abecee2183e"],
    [{ semanticFact: "w".repeat(240) }, "knowledge:06bbd6003f4fcdee41470c30babd9e76"],
    [{ strategy: { retries: 3, target: "plugin:strategy" }, capabilityId: "plugin:strategy" }, "knowledge:dc7f53d0ff9642787c162c36b11e9c69"],
    [{ semanticFact: "中文问题描述：边缘缓存预热延迟" }, "knowledge:d03431cae15b82578a1f1aa876276e22"],
  ];
  for (const [input, expected] of pinned) {
    assert.equal(keyOf(input), expected, `the identity of ${JSON.stringify(input).slice(0, 60)} changed`);
  }
  assert.equal(knowledgeKeyOf({ semanticFact: "w".repeat(240) }), "knowledge:06bbd6003f4fcdee41470c30babd9e76");
  // Exactly at the bound: no marker, no digest, the whole normalized text.
  assert.equal(dimensionsOf({ semanticFact: "w".repeat(240) }).semanticFact, "w".repeat(240));
  assert.equal(dimensionsOf({ semanticFact: "w".repeat(241) }).semanticFact.length, 240);
  assert.ok(dimensionsOf({ semanticFact: "w".repeat(241) }).semanticFact.startsWith("w".repeat(200)));
});

test("a truncated dimension stays bounded however long the fact is", () => {
  const long = "w".repeat(50000);
  const dimension = dimensionsOf({ semanticFact: `${long}x` }).semanticFact;
  assert.equal([...dimension].length, 240);
  assert.ok(dimension.endsWith("x") === false);
  assert.equal(dimension, dimensionsOf({ semanticFact: `${long}x` }).semanticFact);
  assert.notEqual(dimension, dimensionsOf({ semanticFact: `${long}y` }).semanticFact);
});

/** One astral code point: a single code point, two UTF-16 code units. */
const ASTRAL = "\u{20000}";
/**
 * What the pin stored for 121 `U+20000`. The pin bounded by UTF-16 unit, so it
 * kept `slice(0, 239)` - 119 astral characters plus the high surrogate of the
 * 120th, an unpaired code unit - and appended its marker. This is the pin's own
 * formula, written out as a literal so the assertions below compare against it
 * instead of against the tree's own output.
 */
const PINNED_ASTRAL_CUT = `${ASTRAL.repeat(119)}\ud840…`;

test("a dimension past the bound in UTF-16 units but inside it in code points is kept whole", () => {
  const text = ASTRAL.repeat(121);
  assert.equal([...text].length, 121, "the value must sit inside the bound in code points");
  assert.equal(text.length, 242, "the value must be past the bound in UTF-16 units");
  // The pin cut this value, and the cut landed inside a code point.
  assert.equal(PINNED_ASTRAL_CUT, `${text.slice(0, 239)}…`, "the pin must have cut this value at its unit bound");
  assert.equal(PINNED_ASTRAL_CUT.slice(-2), "\ud840…", "the pin's cut must have split a surrogate pair");
  assert.equal(PINNED_ASTRAL_CUT.isWellFormed(), false, "the pin's value must carry an unpaired high surrogate");

  const dimension = dimensionsOf({ semanticFact: text }).semanticFact;
  assert.equal(dimension, text, "a value inside the code point bound must be kept whole");
  assert.ok(dimension.isWellFormed(), "the kept value must not carry the pin's unpaired high surrogate");
  assert.notEqual(dimension, PINNED_ASTRAL_CUT, "a value the pin cut must change its identity");
  // The two identities are pinned as literals: the pin's cut value hashed to the
  // second one, and the kept-whole value hashes to the first.
  assert.equal(keyOf({ semanticFact: text }), "knowledge:5a8476d9f16d30b67c3ef701de8063b3");
  assert.notEqual(keyOf({ semanticFact: text }), "knowledge:f1a54d598584a6fdd8d76a9f08d0eb93",
    "the pin's cut identity must no longer be produced");
});

test("two astral lengths the pin's unit cut collapsed are told apart", () => {
  const short = ASTRAL.repeat(121);
  const long = ASTRAL.repeat(122);
  // The pin bounded with `slice(0, 239) + "…"`, so both lengths produced exactly
  // this one value - and therefore one identity.
  const pinCut = (value) => `${value.slice(0, 239)}…`;
  assert.equal(pinCut(short), PINNED_ASTRAL_CUT);
  assert.equal(pinCut(long), PINNED_ASTRAL_CUT);
  assert.notEqual(dimensionsOf({ semanticFact: short }).semanticFact, dimensionsOf({ semanticFact: long }).semanticFact,
    "the two lengths must not share a dimension value");
  assert.notEqual(keyOf({ semanticFact: short }), keyOf({ semanticFact: long }),
    "the two lengths must not share an identity");
});

test("a dimension at exactly 240 UTF-16 units is byte-identical to the pin", () => {
  const text = "w".repeat(240);
  assert.equal(text.length, 240, "the value must sit exactly at the bound in UTF-16 units");
  assert.equal([...text].length, 240, "ASCII keeps units and code points equal here");
  assert.equal(dimensionsOf({ semanticFact: text }).semanticFact, text, "a value at the bound must be returned whole");
  // The identity the pin produced for this value, written out rather than
  // recomputed: at the bound, the unit cut never applied.
  assert.equal(keyOf({ semanticFact: text }), "knowledge:06bbd6003f4fcdee41470c30babd9e76",
    "a value at the bound must keep the pin's identity");
});
