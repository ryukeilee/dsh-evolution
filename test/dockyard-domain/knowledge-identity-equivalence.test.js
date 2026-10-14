/**
 * Differential equivalence for the experience-recall identity projection.
 *
 * The working tree computes a record's canonical knowledge key without
 * materialising the outcome/metrics/recovery/reference fields, and scans a
 * source collection's complete history without copying it. Both are read-path
 * changes on the path `evolution_propose` triggers through
 * `domainStorage.recall()`, so they must leave every recorded value and every
 * retention decision byte-identical.
 *
 * The baseline is the pinned release artifact, extracted into a temporary
 * directory and imported as-is; nothing is re-implemented here. `lib/` is a
 * shipped path, so the pinned tree is exactly the pre-change implementation
 * until the next release re-pin. The shape assertion below makes a future
 * re-pin fail loudly here instead of silently turning this test into a
 * self-comparison.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { EvolutionMemory } from "../../lib/dockyard-domain/memory.js";
import { canonicalKnowledgeKey, knowledgeKeyOf, normalizeKnowledgeEvent } from "../../lib/dockyard-domain/knowledge.js";
import { JsonStateStore } from "./support.js";
import { readReleaseManifest, releaseArtifactPath } from "../../scripts/release/release-lib.mjs";

const NOW = "2026-10-12T00:00:00.000Z";

const pin = readReleaseManifest();
const baselineRoot = await mkdtemp(join(tmpdir(), "dsh-knowledge-baseline-"));
execFileSync("tar", ["-xzf", releaseArtifactPath(pin), "-C", baselineRoot, "package/lib"], { stdio: "ignore" });
const baselineKnowledge = await import(pathToFileURL(join(baselineRoot, "package/lib/dockyard-domain/knowledge.js")).href);
const baselineMemory = await import(pathToFileURL(join(baselineRoot, "package/lib/dockyard-domain/memory.js")).href);
test.after(() => rm(baselineRoot, { recursive: true, force: true }));

test("the pinned baseline predates this change", () => {
  assert.equal(
    typeof baselineKnowledge.knowledgeKeyOf,
    "undefined",
    "the pinned artifact already contains knowledgeKeyOf: re-anchor this differential test to a pre-change baseline",
  );
});

// ---------------------------------------------------------------------------
// The identity projection is value-identical
// ---------------------------------------------------------------------------

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
];

test("normalizeKnowledgeEvent stays value-identical to the pinned implementation", () => {
  for (const entry of CORPUS) {
    const before = baselineKnowledge.normalizeKnowledgeEvent(entry, { sourceCollection: "observations", now: new Date(NOW) });
    const after = normalizeKnowledgeEvent(entry, { sourceCollection: "observations", now: new Date(NOW) });
    assert.deepEqual(after, before, `normalizeKnowledgeEvent drifted for ${JSON.stringify(entry)?.slice(0, 80)}`);
  }
});

test("the key-only projection returns exactly the recomputed key", () => {
  for (const entry of CORPUS) {
    const recomputed = baselineKnowledge.normalizeKnowledgeEvent(entry, { sourceCollection: "observations", now: new Date(NOW) })?.knowledgeKey ?? null;
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
