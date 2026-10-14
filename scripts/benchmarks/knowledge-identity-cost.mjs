// Per-row cost of the canonical knowledge identity, plus the equivalence the
// working tree's two identifier collapses rest on.
//
// `#sourceMatches()` compares every row of a source collection's complete
// history against one canonical key, so it recomputes `knowledgeKeyOf()` for
// every cold row on every write. That recomputation is one text normalization
// per dimension plus a hash, and the two identifier collapses
// (`\b[0-9a-f]{8,}\b` and the dashed form) used to carry the `i` flag together
// with `u`, which is the most expensive way to express the same character class
// in this engine.
//
//   node scripts/benchmarks/knowledge-identity-cost.mjs [--rows N] [--knowledge-rows N]
//     [--rounds N] [--warmup N] [--samples N] [--lib <dir>]... [--skip-folds] [--json]
//
// Two anchors keep this honest. The pinned release artifact supplies the
// authoritative *values*: every measured row must return the key that the
// pinned `normalizeKnowledgeEvent()` computes for it, or the run fails. A
// `--lib` tree supplies the pre-change *cost*: it is another `lib/` directory
// (for this round, the previous commit's tree, extracted with
// `git show HEAD:lib/...`), read in place and never re-implemented here, so the
// timing delta is measured against real code rather than a reconstruction.
//
// The fold phase is exhaustive: it checks that `[0-9a-f]` with `i` and `u`
// accepts exactly the code points of `[0-9a-fA-F]` without `i`, over every
// Unicode code point and over a generated corpus for the two full patterns.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { knowledgeKeyOf, normalizeKnowledgeEvent } from "../../lib/dockyard-domain/knowledge.js";
import { readReleaseManifest, releaseArtifactPath, REPO_ROOT } from "../release/release-lib.mjs";

const FROZEN_NOW = Date.parse("2026-10-12T00:00:00.000Z");
const NOW = new Date(FROZEN_NOW).toISOString();

function parseArgs(argv) {
  const options = { rows: 10000, knowledgeRows: 10000, rounds: 3, warmup: 1, samples: 5, skipFolds: false, json: false, libs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--json") { options.json = true; continue; }
    if (key === "--skip-folds") { options.skipFolds = true; continue; }
    const value = argv[index + 1];
    index += 1;
    if (key === "--rows") options.rows = Number(value);
    else if (key === "--knowledge-rows") options.knowledgeRows = Number(value);
    else if (key === "--rounds") options.rounds = Number(value);
    else if (key === "--warmup") options.warmup = Number(value);
    else if (key === "--samples") options.samples = Number(value);
    else if (key === "--lib") options.libs.push(resolve(value));
    else throw new Error(`unknown option ${key}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const median = (values) => { const sorted = [...values].sort((left, right) => left - right); return sorted[Math.floor(sorted.length / 2)]; };

// --- the equivalence the collapses rest on ---------------------------------

const COLLAPSES = [
  { label: "[0-9a-f]", before: /^[0-9a-f]$/iu, after: /^[0-9a-fA-F]$/u, kind: "class" },
  { label: "[0-9a-f-]", before: /^[0-9a-f-]$/iu, after: /^[0-9a-fA-F-]$/u, kind: "class" },
  { label: "\\b[0-9a-f]{8,}\\b", before: /\b[0-9a-f]{8,}\b/giu, after: /\b[0-9a-fA-F]{8,}\b/gu, kind: "pattern" },
  { label: "\\b[0-9a-f]{4,}-[0-9a-f-]{4,}\\b", before: /\b[0-9a-f]{4,}-[0-9a-f-]{4,}\b/giu, after: /\b[0-9a-fA-F]{4,}-[0-9a-fA-F-]{4,}\b/gu, kind: "pattern" },
];

/**
 * A string that the two spellings of the 8+ collapse genuinely disagree on.
 *
 * `\b` is not the same assertion under `i` + `u`: that flag pair also treats a
 * code point that case-folds to an ASCII word character as a word character, so
 * U+017F LATIN SMALL LETTER LONG S is a word character there and is not one
 * without `i`. The two full patterns are therefore **not** equivalent on
 * arbitrary text. `normalizeText()` runs `.normalize("NFKC").toLowerCase()`
 * before them, and NFKC maps every code point that could make the difference to
 * ASCII, so the strings the collapses actually see cannot contain one - which is
 * what this phase verifies, instead of claiming a general equivalence.
 */
const PATTERN_BOUNDARY_EXAMPLE = "\u017fdeadbeef";

/** Every Unicode code point as a one-character string, plus a generated corpus. */
function* corpus() {
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
    yield String.fromCodePoint(codePoint);
  }
  const alphabet = ["a", "f", "F", "g", "z", "0", "9", "-", ":", " ", "\t", "é", "\uff21", "\u212a", "\u017f"];
  const strings = [""];
  let frontier = [""];
  for (let length = 1; length <= 4; length += 1) {
    const next = [];
    for (const prefix of frontier) for (const character of alphabet) next.push(prefix + character);
    strings.push(...next);
    frontier = next;
  }
  yield* strings;
  yield "id deadbeefdeadbeef and 12345678-1234-1234-1234-123456789012";
  yield "ABCDEF12-3456-7890 and abcdef12-3456-7890";
  yield "ＡＢＣＤＥＦ１２３４ : colon";
  yield PATTERN_BOUNDARY_EXAMPLE;
  yield "deadbeef\u017f";
  yield "\u212adeadbeef";
}

function verifyFolds() {
  const report = {
    codePoints: 0x110000 - 0x800, strings: 0, classDifferences: 0, patternDifferences: 0,
    boundaryDifferences: [], collapses: COLLAPSES.map((collapse) => collapse.label),
  };
  // 1. The two character classes accept exactly the same code points, checked
  //    for every code point there is.
  for (const collapse of COLLAPSES.filter((entry) => entry.kind === "class")) {
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
      const character = String.fromCodePoint(codePoint);
      if (collapse.before.test(character) !== collapse.after.test(character)) report.classDifferences += 1;
    }
  }
  // 2. The code points where `\b` itself differs: `i` + `u` also treats the
  //    characters that case-fold to an ASCII word character as word characters.
  //    A non-class code point can only change a match through the boundary
  //    assertion, so every code point is probed directly on both sides of a
  //    matching identifier for both patterns - not through a `\w` proxy, and
  //    not through a corpus that cannot match the patterns at all.
  const [eight, dashed] = COLLAPSES.filter((collapse) => collapse.kind === "pattern");
  const boundaryProbes = (character) => [
    character + "deadbeef", "deadbeef" + character,
    character + "abcdef12-3456", "abcdef12-3456" + character,
  ];
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
    const character = String.fromCodePoint(codePoint);
    const differs = boundaryProbes(character).some((text) =>
      text.replace(eight.before, "<id>") !== text.replace(eight.after, "<id>")
      || text.replace(dashed.before, "<id>") !== text.replace(dashed.after, "<id>"));
    if (differs) report.boundaryDifferences.push(`U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`);
    if (/\w/iu.test(character) !== /\w/.test(character) && !differs) report.wordCharOnlyDifferences = (report.wordCharOnlyDifferences ?? 0) + 1;
  }
  report.boundaryProbes = 0x110000 - 0x800;
  // 3. None of those code points can reach the collapses: `normalizeText()`
  //    normalizes to NFKC first, and no code point maps to one of them under
  //    NFKC (they have compatibility mappings out, and no canonical
  //    decomposition that a composition step could produce them from).
  report.nfkcSurvivors = [];
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
    const normalized = String.fromCodePoint(codePoint).normalize("NFKC");
    for (const character of report.boundaryDifferences.map((label) => String.fromCodePoint(Number.parseInt(label.slice(2), 16)))) {
      if (normalized.includes(character)) report.nfkcSurvivors.push(`U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`);
    }
  }
  // 4. The two full patterns agree on the strings the pipeline actually feeds
  //    them: NFKC-normalized, lower-cased text.
  for (const text of corpus()) {
    report.strings += 1;
    const pipelineInput = text.normalize("NFKC").toLowerCase();
    for (const collapse of COLLAPSES) {
      const same = collapse.kind === "class"
        ? collapse.before.test(text) === collapse.after.test(text)
        : pipelineInput.replace(collapse.before, "<id>") === pipelineInput.replace(collapse.after, "<id>");
      if (!same) {
        report.patternDifferences += 1;
        if (report.patternDifferences <= 5) console.error(`pipeline difference for ${collapse.label} on ${JSON.stringify(text)}`);
      }
    }
  }
  // 5. The general inequality is pinned, not hidden: this input must keep the
  //    two spellings apart, so a future engine that changes `\b` under `iu`
  //    fails loudly here instead of silently invalidating this argument.
  report.boundaryExampleDiffers = PATTERN_BOUNDARY_EXAMPLE.replace(eight.before, "<id>")
    !== PATTERN_BOUNDARY_EXAMPLE.replace(eight.after, "<id>");
  return report;
}

// --- the per-row measurement ------------------------------------------------

async function loadPinned() {
  const pin = readReleaseManifest();
  const directory = await mkdtemp(join(tmpdir(), "dsh-identity-pin-"));
  execFileSync("tar", ["-xzf", releaseArtifactPath(pin), "-C", directory, "package/lib"], { stdio: "ignore" });
  await symlink(join(REPO_ROOT, "node_modules"), join(directory, "package/node_modules"), "dir");
  const module = await import(pathToFileURL(join(directory, "package/lib/dockyard-domain/knowledge.js")).href);
  return { pin, directory, module };
}

/** A `--lib` tree measured as-is; nothing here re-implements it. */
async function loadLib(directory) {
  const module = await import(pathToFileURL(join(directory, "dockyard-domain/knowledge.js")).href);
  assert.equal(typeof module.knowledgeKeyOf, "function", `${directory} must export knowledgeKeyOf`);
  return { directory, keyOf: module.knowledgeKeyOf, event: module.normalizeKnowledgeEvent };
}

function observationRow(index) {
  const scope = `plugin:module-${index}`;
  return {
    id: `obs-${index}`,
    knowledgeKey: `knowledge:${String(index).padStart(32, "b")}`,
    type: "tool/error", code: "HOST_OPERATION_FAILED", message: `official operation failed (${index})`,
    componentId: scope, severity: "error", status: "failed",
    problem: `${scope} warmup latency regression observed after a retry policy change`,
    target: scope, capabilityId: scope, metrics: { latency: 12 },
    recordedAt: new Date(Date.parse(NOW) - index * 3_600_000).toISOString(),
  };
}

function knowledgeRow(index) {
  const scope = `plugin:knowledge-${index}`;
  const seen = new Date(Date.parse(NOW) - index * 3_600_000).toISOString();
  const effectStats = { successCount: (index % 7) + 1, failureCount: index % 3, neutralCount: 0, regressionCount: 0, fitnessCount: 2, fitnessSum: 1.4, fitnessMean: 0.7, bestFitness: 0.8, worstFitness: 0.6, successRate: 0.6, metrics: {} };
  return {
    id: `key-${index}`,
    knowledgeKey: `knowledge:${String(index).padStart(32, "a")}`,
    schema: 1, canonical: true, retention: "CANONICAL_KNOWLEDGE",
    state: index % 2 ? "KNOWN" : "LEARNING",
    issueType: "performance", problemType: "latency",
    rootCause: `candidate warmup race in ${scope} pipeline`,
    strategy: JSON.stringify({ target: scope, capability: scope, retries: (index % 4) + 1 }),
    failureMode: index % 3 === 0 ? "network-error" : "timeout",
    semanticFact: `${scope} warmup latency regression observed after a retry policy change`,
    scope,
    count: (index % 9) + 1, occurrenceCount: (index % 9) + 1,
    firstSeen: seen, lastSeen: seen,
    lastSourceCollection: "observations", lastStatus: "measured", lastOutcome: index % 5 === 0 ? "failure" : "success",
    sourceCounts: { observations: (index % 9) + 1 },
    sourceRefs: [`observations:obs-${index}-a`, `journal:j-${index}-b`],
    lineageRefs: [], relationRefs: [], eventIds: [`event-${index}`],
    evidenceCount: (index % 9) + 1,
    recentEvidence: [{ source: "observations", id: `obs-${index}`, at: seen, outcome: "success", status: "measured", digest: `d${index}` }],
    confidence: 0.6, effectStats, effects: effectStats,
    successCount: (index % 7) + 1, failureCount: index % 3, successRate: 0.6, fitnessMean: 0.7, regressionCount: 0,
    trend: { window: 8, recent: [{ at: seen, outcome: "success", confidence: 0.6, regression: false }], lastOutcome: "success", direction: "stable", failureRate: 0.3, successRate: 0.6, regressionCount: 0 },
    learned: true, updatedAt: seen,
  };
}

/** One pass of the exact per-row work `#sourceMatches()` performs. */
function measure(keyOf, rows) {
  const cpu = process.cpuUsage();
  const start = performance.now();
  let hits = 0;
  for (const row of rows) if (keyOf(row) !== null) hits += 1;
  return { wallMs: performance.now() - start, cpuMs: (process.cpuUsage(cpu).user + process.cpuUsage(cpu).system) / 1000, hits };
}

/** The value anchor: the pinned implementation decides every row's key. */
function assertPinnedValues(pinned, keyOf, rows) {
  for (const row of rows) {
    const expected = pinned.normalizeKnowledgeEvent(row, { sourceCollection: "observations", now: new Date(NOW) })?.knowledgeKey ?? null;
    assert.equal(keyOf(row), expected, `knowledgeKeyOf drifted for ${JSON.stringify(row)?.slice(0, 80)}`);
  }
}

async function main() {
  const report = {
    node: process.version, platform: `${process.platform}/${process.arch}`,
    rows: options.rows, knowledgeRows: options.knowledgeRows,
    rounds: options.rounds, warmup: options.warmup, samples: options.samples,
    scope: "one knowledgeKeyOf() per row = one #sourceMatches() pass over a cold archive",
    variants: options.libs,
  };
  const folds = options.skipFolds ? { skipped: true } : verifyFolds();
  report.folds = folds;
  assert.notEqual(folds.skipped ?? false, true, "--skip-folds is only for quick local iteration, never for evidence");
  assert.equal(folds.classDifferences, 0, "the two class spellings must accept identical code points");
  assert.equal(folds.patternDifferences, 0, "the two patterns must agree on the NFKC-normalized text the pipeline feeds them");
  assert.deepEqual(folds.boundaryDifferences, ["U+017F", "U+212A"], "the `\\b` word-character difference set must stay confined to the two code points NFKC removes");
  assert.deepEqual(folds.nfkcSurvivors, [], "no code point may reach the collapses while making `\\b` disagree");
  assert.equal(folds.boundaryExampleDiffers, true, "the general inequality of the two patterns must stay pinned");

  const pinned = await loadPinned();
  report.baseline = { version: pinned.pin.version, sha256: pinned.pin.sha256 };
  const sides = [{ label: "candidate", keyOf: knowledgeKeyOf, event: normalizeKnowledgeEvent }];
  for (const [index, directory] of options.libs.entries()) {
    const lib = await loadLib(directory);
    sides.push({ label: `variant${index + 1}`, ...lib });
  }
  const observations = Array.from({ length: options.rows }, (_, index) => observationRow(index));
  const knowledge = Array.from({ length: options.knowledgeRows }, (_, index) => knowledgeRow(index));
  const scenarios = [["observations", observations], ["knowledge", knowledge]];
  try {
    for (const side of sides) {
      assertPinnedValues(pinned.module, side.keyOf, observations);
      assertPinnedValues(pinned.module, side.keyOf, knowledge);
    }
    report.gate = "every measured side returns the pinned key for every row";
    const samples = new Map(sides.map((side) => [side.label, new Map(scenarios.map(([label]) => [label, []]))]));
    for (let round = 0; round < options.rounds; round += 1) {
      const order = sides.map((side) => side.label);
      const rotation = round % order.length;
      const schedule = [...order.slice(rotation), ...order.slice(0, rotation)];
      for (const label of schedule) {
        const side = sides.find((entry) => entry.label === label);
        for (let index = 0; index < options.warmup + options.samples; index += 1) {
          for (const [scenario, rows] of scenarios) {
            const sample = measure(side.keyOf, rows);
            if (index >= options.warmup) samples.get(label).get(scenario).push(sample);
          }
        }
      }
      report.roundsDetail = [...(report.roundsDetail ?? []), { order: schedule }];
    }
    report.results = sides.map((side) => {
      const entry = { label: side.label, directory: side.directory ?? null };
      for (const [scenario, rows] of scenarios) {
        const list = samples.get(side.label).get(scenario);
        entry[scenario] = {
          rows: rows.length,
          wallMs: median(list.map((sample) => sample.wallMs)),
          cpuMs: median(list.map((sample) => sample.cpuMs)),
          raw: list.map((sample) => Number(sample.wallMs.toFixed(3))),
        };
        assert.equal(list[0].hits, rows.length, "every row must be knowledge-bearing");
      }
      return entry;
    });
    const candidate = report.results[0];
    report.deltas = report.results.slice(1).map((variant) => ({
      label: variant.label,
      observationsWallPct: ((candidate.observations.wallMs - variant.observations.wallMs) / variant.observations.wallMs) * 100,
      knowledgeWallPct: ((candidate.knowledge.wallMs - variant.knowledge.wallMs) / variant.knowledge.wallMs) * 100,
      observationsCpuPct: ((candidate.observations.cpuMs - variant.observations.cpuMs) / variant.observations.cpuMs) * 100,
      knowledgeCpuPct: ((candidate.knowledge.cpuMs - variant.knowledge.cpuMs) / variant.knowledge.cpuMs) * 100,
    }));
  } finally { await rm(pinned.directory, { recursive: true, force: true }); }
  if (options.json) { console.log(JSON.stringify(report, null, 2)); return; }
  console.log(`node ${report.node} ${report.platform} | pinned values dsh-evolution-${report.baseline.version}`);
  console.log(`collapse spellings: ${folds.codePoints} code points + ${folds.strings} strings; class differences ${folds.classDifferences}, pipeline-pattern differences ${folds.patternDifferences}, \\b difference set ${folds.boundaryDifferences.join("+")}, NFKC survivors ${folds.nfkcSurvivors.length} (general-case example still differs: ${folds.boundaryExampleDiffers})`);
  for (const result of report.results) {
    console.log(`${result.label.padEnd(9)}${result.directory ?? ""} wall ${result.observations.wallMs.toFixed(3)} ms / ${result.knowledge.wallMs.toFixed(3)} ms  cpu ${result.observations.cpuMs.toFixed(3)} ms / ${result.knowledge.cpuMs.toFixed(3)} ms  (${result.observations.rows} observations + ${result.knowledge.rows} knowledge rows)`);
  }
  for (const delta of report.deltas) {
    console.log(`candidate vs ${delta.label}: observations wall ${delta.observationsWallPct.toFixed(2)}%, knowledge wall ${delta.knowledgeWallPct.toFixed(2)}%`);
  }
}

await main();
