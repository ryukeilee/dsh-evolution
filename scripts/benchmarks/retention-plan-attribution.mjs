// Read-only attribution for the retention plan / compact() memory cost.
//
// Answers two questions about `EvolutionMemory.compact()` on a large history:
//
// 1. ownership: which rows `historyView()` returns are live `#data` rows, which
//    are the archive read cache's live window rows, and which are rows parsed
//    for this call and held by nothing. The method is object identity: the
//    same row object is returned by two consecutive `historyView()` calls only
//    when the store or the cache holds it; a freshly parsed row is a new object
//    every call. Cold parsing hooks (below) additionally count how many rows
//    each full-history read served from the cached window versus re-read from
//    the row's own line.
//
// 2. retention: how much live heap each stage of planning and of the real
//    (non-dryRun) compact holds, and how much of it a stage-owned object graph
//    keeps reachable. Each stage is a synchronous point inside the call where
//    a forced GC measures the live set; pins hold one stage's objects past the
//    call and a second GC measures what releasing only that stage frees.
//    Object counts, JSON.parse counts and structuredClone counts are recorded
//    at the same points, so every materialisation/copy site in the data flow is
//    attributable.
//
// The retention mode needs the stage points, so it runs a *diagnostic copy* of
// the lib tree: the tree is copied to a temp directory and the copy's
// `dockyard-domain/memory.js` gets hook calls inserted next to the exact
// source lines listed in PATCHES. Every anchor must match exactly once or the
// run is refused, so a source drift is reported instead of measured silently.
// The repository's own `lib/` is never written, and the measured call remains
// the public `memory.compact(...)`. Ownership mode only needs the identity
// method; it uses the same diagnostic copy so the window-hit counters and the
// forced-fallback probe are available, but it makes no measurement that
// depends on the hooks.
//
// node --expose-gc scripts/benchmarks/retention-plan-attribution.mjs \
//   [--mode ownership|retention|all] [--scales 10000,40000] [--ref <git-ref>] \
//   [--lib <dir>] [--pins none,histories,plan,histories+plan,oldData,records] \
//   [--hot-steps] [--json] [--out <path>]
//
// --ref is extracted with `git archive` into a temp directory (default
// `origin/main`); --lib measures a tree as it is on disk instead. Fixtures are
// synthetic and built from the measured tree's public knowledge functions, the
// same corpus shape as `retention-plan-cost.mjs`: 40% observations, 20%
// knowledge accumulators, 20% observed cycles, 10% terminal outcomes, 10%
// rejected promotions, with canonical pointers protecting some outcomes.
// Nothing here is a production planning function; the only instrumented code is
// the temp copy's hook calls.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, loadavg, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { getHeapSpaceStatistics } from 'node:v8';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const NOW = '2026-10-12T00:00:00.000Z';
const ARGS = process.argv.slice(2);
const MIB = 1024 * 1024;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const project = (value) => JSON.parse(JSON.stringify(value));
const parseSelf = !ARGS.includes('--child');

// ---------------------------------------------------------------------------
// Diagnostic copy: hook anchors into a temp copy of the lib tree.
// ---------------------------------------------------------------------------
// Each anchor is an exact source fragment; it is replaced by itself plus one or
// more `globalThis.__attr?.(...)` calls. `__attr` is undefined in every normal
// process, so a copy that is imported without a hook installed behaves exactly
// like the original bytes apart from these inert property reads. `__attr`
// returning nothing keeps no reference: a hook records counts/readings and then
// drops the payload, unless the run asked to pin it.
const PATCHES = [
  ['  #mergeArchived(collection, hot, { copy = true } = {}) {',
    '  #mergeArchived(collection, hot, { copy = true } = {}) {\n    globalThis.__attr?.("call", "mergeArchived");'],
  ['    const rows = [...merged.values(), ...anonymous];',
    '    const rows = [...merged.values(), ...anonymous];\n    globalThis.__attr?.("merge", { collection, archived, hot, rows, copy });'],
  ['  #archiveRowAt(collection, state, position, buffers = null, retried = false) {',
    '  #archiveRowAt(collection, state, position, buffers = null, retried = false) {\n    globalThis.__attr?.("call", "archiveRowAt");'],
  ['      const retained = state.window[offset];\n      if (retained !== undefined) return retained;',
    '      const retained = state.window[offset];\n      if (retained !== undefined) { globalThis.__attr?.("rowHit", collection); return retained; }\n      globalThis.__attr?.("rowMiss", collection);'],
  ['  #readArchiveSync(collection) {\n    const state = this.#archiveRead(collection);',
    '  #readArchiveSync(collection) {\n    globalThis.__attr?.("readArchiveSync", collection);\n    const state = this.#archiveRead(collection);'],
  ['      const { rows, ...entry } = this.#scanArchiveRead(collection, files, null, { collectRows: true });',
    '      const { rows, ...entry } = this.#scanArchiveRead(collection, files, null, { collectRows: true });\n      globalThis.__attr?.("fallback", { collection, rows, entry });'],
  ['  #archiveRowsFrom(collection, state) {\n    const rows = [];',
    '  #archiveRowsFrom(collection, state) {\n    if (globalThis.__attrForceFallback === collection) { globalThis.__attrForceFallback = null; throw new Error("attribution-forced-fallback"); }\n    const rows = [];'],
  ['      rows.push(this.#archiveRowAt(collection, state, position, buffers, true));\n    }\n    return rows;',
    '      rows.push(this.#archiveRowAt(collection, state, position, buffers, true));\n    }\n    globalThis.__attr?.("rowsFrom", { collection, rows, buffers });\n    return rows;'],
  ['    const histories = Object.fromEntries(collections.map((collection) => [collection, this.history(collection)]));',
    '    const histories = Object.fromEntries(collections.map((collection) => [collection, this.history(collection)]));\n    globalThis.__attr?.("histories", { histories, collections });'],
  ['    const allRecords = collections.flatMap((collection) => histories[collection].map((entry) => ({ collection, entry })));',
    '    const allRecords = collections.flatMap((collection) => histories[collection].map((entry) => ({ collection, entry })));\n    globalThis.__attr?.("allRecords", { allRecords, histories, collections });'],
  ['    const knowledgePlan = this.#knowledgeRetentionPlan(histories, references);',
    '    globalThis.__attr?.("preKnowledge", { histories, allRecords, canonicalByKey, tombstoneMap, observationGroups });\n    const knowledgePlan = this.#knowledgeRetentionPlan(histories, references);\n    globalThis.__attr?.("knowledgePlan", { knowledgePlan, histories });'],
  ['    return { knowledge: [...knowledgeByKey.values()], retainedEntries, consolidated };',
    '    globalThis.__attr?.("knowledgeInner", { knowledgeByKey, sourceGroups, retainedEntries, consolidated });\n    const __attrKnowledgeOut = [...knowledgeByKey.values()];\n    globalThis.__attr?.("knowledgeOutput", { knowledgeOut: __attrKnowledgeOut, knowledgeByKey, sourceGroups, retainedEntries, consolidated });\n    return { knowledge: __attrKnowledgeOut, retainedEntries, consolidated };'],
  ['    records.tombstones = [...tombstoneMap.values()];\n    report.tombstones = records.tombstones.length;',
    '    globalThis.__attr?.("preRecordsEnd", { records, canonicalByKey, tombstoneMap, histories, knowledgePlan, observationGroups, references, latestLineage });\n    records.tombstones = [...tombstoneMap.values()];\n    report.tombstones = records.tombstones.length;'],
  ['    return { collections, records, canonical: [...canonicalByKey.values()], report };',
    '    const __attrPlan = { collections, records, canonical: [...canonicalByKey.values()], report };\n    globalThis.__attr?.("plan", { plan: __attrPlan, histories });\n    return __attrPlan;'],
  ['      const plan = this.#retentionPlan();\n      const oldData = clone(this.#data);',
    '      const plan = this.#retentionPlan();\n      globalThis.__attr?.("planReturned", { plan });\n      const oldData = clone(this.#data);\n      globalThis.__attr?.("oldData", { oldData, plan });'],
  ['        const archived = this.#readArchiveSync(item.collection);',
    '        const archived = this.#readArchiveSync(item.collection);\n        globalThis.__attr?.("readback", { collection: item.collection, archived, cold });'],
  ['      this.archiveIndexReady = false;\n      await this.#writeArchiveIndex();',
    '      this.archiveIndexReady = false;\n      await this.#writeArchiveIndex();\n      globalThis.__attr?.("indexWritten", null);'],
];

// Stages that force a GC and record the live set. `merge:*` and `rowsFrom:*`
// are recorded for the two largest collections only (knowledge, observations)
// because each one is a transient inside a single collection's read; they are
// skipped when the run does not ask for them so the measured call does not pay
// a GC per collection.
const GC_STAGES = new Set(['histories', 'allRecords', 'preKnowledge', 'knowledgeInner', 'knowledgeOutput', 'preRecordsEnd', 'plan', 'planReturned', 'oldData', 'indexWritten']);
const GC_TRANSIENT_COLLECTIONS = new Set(['observations', 'knowledge']);
const PHASES = ['dryRun', 'write'];
const DEFAULT_PINS = ['none', 'histories', 'plan', 'histories+plan', 'oldData', 'records'];

function parseArgs(args) {
  const options = { mode: 'all', scales: [10000], ref: 'origin/main', lib: null, pins: DEFAULT_PINS, hotSteps: false, json: false, out: null, keep: false, child: false };
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (key === '--json') { options.json = true; continue; }
    if (key === '--hot-steps') { options.hotSteps = true; continue; }
    if (key === '--keep') { options.keep = true; continue; }
    if (key === '--child') { options.child = true; continue; }
    if (key === '--help') {
      console.log('Usage: node --expose-gc scripts/benchmarks/retention-plan-attribution.mjs [--mode ownership|retention|all] [--scales 10000,40000] [--ref <git-ref>] [--lib <dir>] [--pins none,histories,plan,histories+plan,oldData,records] [--hot-steps] [--json] [--out <path>] [--keep]\n'
        + '--ref is extracted with git archive (default origin/main). --pins selects the stage graphs held past compact() for the retention measurement. --hot-steps also measures a warm fixture whose state file holds hot rows at the hot limits, a canonical table and a 4096-entry bridge marker window (dryRun only).');
      return null;
    }
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${key}`);
    if (key === '--mode') options.mode = value;
    else if (key === '--scales') options.scales = value.split(',').map(Number);
    else if (key === '--ref') options.ref = value;
    else if (key === '--lib') options.lib = resolve(value);
    else if (key === '--pins') options.pins = value.split(',');
    else if (key === '--out') options.out = resolve(value);
    else throw new Error(`unknown option ${key}`);
  }
  if (!['ownership', 'retention', 'all'].includes(options.mode)) throw new Error(`invalid --mode ${options.mode}`);
  if (!options.scales.length || options.scales.some((n) => !Number.isSafeInteger(n) || n < 100)) throw new Error('invalid --scales: expected integers >= 100');
  for (const pin of options.pins) {
    if (!['none', 'histories', 'plan', 'histories+plan', 'knowledgePlan', 'oldData', 'records', 'merged', 'rowsFrom', 'readback'].includes(pin)) throw new Error(`unknown pin ${pin}`);
  }
  return options;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
// Corpus shape is identical to `retention-plan-cost.mjs` so the numbers in this
// script are comparable with the cost benchmark: repeated raw observations and
// repeated diagnostic subjects, canonical knowledge accumulators, observed
// cycles, terminal outcomes/rejected promotions, canonical pointers on a subset
// of outcomes.
function corpus(scale, knowledge) {
  const counts = { observations: Math.floor(scale * 0.4), knowledge: Math.floor(scale * 0.2), cycles: Math.floor(scale * 0.2), outcomes: Math.floor(scale * 0.1) };
  counts.promotions = scale - Object.values(counts).reduce((a, b) => a + b, 0);
  const rows = {};
  rows.observations = Array.from({ length: counts.observations }, (_, i) => i % 2 === 0 ? {
    id: `info-${i}`, type: 'component/observation', severity: 'info', status: 'observed', recordedAt: NOW, metrics: { usageCount: i + 1 },
  } : {
    id: `diagnostic-${i}`, type: 'tool/error', severity: 'error', status: 'measured', componentId: `plugin:diagnostic-${Math.floor(i / 16)}`, rootCause: 'synthetic retry timeout', errorCode: 'BENCH_DIAGNOSTIC', message: 'synthetic diagnostic only', recordedAt: NOW,
  });
  rows.knowledge = Array.from({ length: counts.knowledge }, (_, i) => {
    const source = { id: `seed-${i}`, issueType: 'performance', rootCause: 'synthetic warmup delay', strategy: 'bounded retry', componentId: `plugin:seed-${i}`, status: 'success', recordedAt: NOW, metrics: { latency: i % 9 + 1 } };
    const event = knowledge.normalizeKnowledgeEvent(source, { sourceCollection: 'observations', now: new Date(NOW) });
    return { ...knowledge.mergeKnowledgeEntry(null, event, { now: new Date(NOW) }), dimensions: event.dimensions };
  });
  rows.cycles = Array.from({ length: counts.cycles }, (_, i) => ({ id: `cycle-${i}`, status: 'observed', startedAt: NOW, endedAt: NOW, recordedAt: NOW, observations: [{ id: `info-${i * 2}` }], stages: [{ stage: 'observe' }] }));
  for (const collection of ['outcomes', 'promotions']) rows[collection] = Array.from({ length: counts[collection] }, (_, i) => ({
    id: `${collection}-${i}`, status: collection === 'outcomes' ? 'failed' : 'rejected', lifecycleState: collection === 'outcomes' ? 'FAILED' : 'REJECTED', componentId: `plugin:${collection}-${Math.floor(i / 8)}`, rootCause: 'synthetic terminal failure', recordedAt: NOW,
  }));
  const canonical = ['outcomes'].flatMap((collection) => rows[collection].filter((_, i) => i % 16 === 0).map((row, i) => ({
    id: `canonical-${row.id}`, state: 'CANONICAL', lifecycleState: 'CANONICAL', sourceCollection: collection, capability: `protected:${collection}-${i}`, recordId: row.id, fitnessScore: 1, updatedAt: NOW,
  })));
  return { counts, canonical, rows };
}

/** Hot rows a production-shaped state file can hold: the per-collection limit. */
const HOT_LIMITS = { observations: 50, diagnoses: 50, gaps: 50, candidates: 50, proposals: 50, experiments: 50, experimentRecords: 50, journal: 50, selections: 50, promotions: 50, outcomes: 50, cycles: 50, lineage: 50, learnings: 50, strategies: 50, strategyMutations: 50, knowledge: 200, tombstones: 50 };

/**
 * Write one fixture. `shape: "cold"` is the cost benchmark's shape: every
 * retained row lives in a cold archive and the state file carries only the
 * canonical table. `shape: "hot"` additionally puts rows for every collection
 * into the state file at the hot limits, together with a canonical table and a
 * full bridge marker window, which is the bounded state `#compactUnlocked()`
 * clones into `oldData` and `#save()` clones into the snapshot.
 */
async function buildFixture({ scale, shape, directory, knowledge, markerCount = 0 }) {
  const fixture = corpus(scale, knowledge);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const filePath = join(directory, 'state.json');
  const state = { canonical: fixture.canonical };
  const archive = {};
  for (const [collection, rows] of Object.entries(fixture.rows)) {
    const hotCount = shape === 'hot' ? Math.min(HOT_LIMITS[collection] ?? 50, rows.length) : 0;
    if (hotCount) state[collection] = rows.slice(0, hotCount);
    // Cold rows are the rest; hot rows are also archived so the plan sees one
    // merged history and the same total row count in both shapes.
    archive[collection] = rows;
  }
  if (shape === 'hot') {
    const markers = Array.from({ length: markerCount }, (_, i) => ({ id: `marker-${i}`, eventId: `event-${i}`, type: 'measurement', recordedAt: NOW }));
    state.eventBridge = { schema: 1, applied: markers };
    // A canonical table bigger than the fixture's protected outcomes: canonical
    // rows are the part of the hot state that can grow with knowledge, and they
    // are what `plan.canonical.map(clone)` and `oldData` copy.
    const extra = Array.from({ length: 1000 }, (_, i) => ({
      id: `canonical-extra-${i}`, state: 'CANONICAL', lifecycleState: 'CANONICAL', sourceCollection: 'lineage',
      capability: `capability-${i % 97}`, lineageId: `lineage-${i % 13}`, recordId: null, fitnessScore: i % 5, updatedAt: NOW,
      implementation: { component: `plugin:${i}`, version: i }, evidence: { stability: { runs: i % 7 } },
    }));
    state.canonical = [...fixture.canonical, ...extra];
  }
  await writeFile(filePath, JSON.stringify({ evolution: state }));
  const bytes = {};
  for (const [collection, rows] of Object.entries(archive)) {
    const text = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
    bytes[collection] = text.length;
    await writeFile(`${filePath}.${collection}-archive.jsonl`, text);
  }
  return {
    scale,
    shape,
    counts: fixture.counts,
    canonical: state.canonical.length,
    hotRows: Object.fromEntries(Object.entries(state).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length])),
    markers: markerCount,
    archiveBytes: bytes,
    archiveTotalBytes: Object.values(bytes).reduce((a, b) => a + b, 0),
  };
}

/** A file-backed state port. The first document it returns is kept, because
 * `load()` assigns those very arrays into `#data`: the probe can then tell a
 * live hot row (`#data`) from a returned copy by object identity. */
function createStore(filePath) {
  const identity = { document: null, loads: 0 };
  const realParse = JSON.parse;
  const store = {
    filePath,
    async load() {
      const document = realParse(await readFile(filePath, 'utf8'));
      identity.loads += 1;
      if (identity.document === null) identity.document = document.evolution;
      return document;
    },
    async update(change) {
      const next = change(await this.load());
      await writeFile(filePath + '.attribution.tmp', JSON.stringify(next));
      await rename(filePath + '.attribution.tmp', filePath);
    },
  };
  return { store, identity };
}

// ---------------------------------------------------------------------------
// Diagnostic lib tree
// ---------------------------------------------------------------------------
async function extractRef(ref, directory) {
  const commit = execFileSync('git', ['rev-parse', ref], { cwd: REPO, encoding: 'utf8' }).trim();
  const tar = execFileSync('git', ['archive', commit, 'lib'], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
  await mkdir(directory, { recursive: true });
  execFileSync('tar', ['-xf', '-', '-C', directory], { input: tar });
  return { commit, lib: join(directory, 'lib') };
}

async function treeSha256(directory) {
  const files = [];
  async function walk(path, prefix = '') {
    for (const item of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + item.name;
      if (item.isDirectory()) await walk(join(path, item.name), name + '/');
      else if (item.isFile()) files.push({ file: name, sha256: sha256(await readFile(join(path, item.name))) });
      else throw new Error(`unsupported entry ${name}`);
    }
  }
  await walk(directory);
  return sha256(JSON.stringify(files));
}

/** Copy `source/lib` to `target/lib` and insert the hook calls. The copy is the
 * only tree this script modifies; a missing or ambiguous anchor refuses the run
 * instead of measuring a different implementation. */
async function instrument(sourceLib, targetLib) {
  await rm(targetLib, { recursive: true, force: true });
  await mkdir(dirname(targetLib), { recursive: true });
  await cp(sourceLib, targetLib, { recursive: true });
  const file = join(targetLib, 'dockyard-domain/memory.js');
  let text = await readFile(file, 'utf8');
  const applied = [];
  for (const [anchor, replacement] of PATCHES) {
    const matches = text.split(anchor).length - 1;
    if (matches !== 1) throw new Error(`instrumentation anchor matched ${matches} times (expected 1): ${anchor.slice(0, 80)}`);
    text = text.replace(anchor, replacement);
    applied.push(anchor.trim().split('\n')[0].trim());
  }
  text = 'globalThis.__attrHookReady = true;\n' + text;
  await writeFile(file, text);
  return { file, applied, bytes: text.length };
}

// ---------------------------------------------------------------------------
// Child process: one measured compact() on one fixture copy
// ---------------------------------------------------------------------------
async function childMain() {
  const lib = process.env.ATTR_LIB;
  const fixture = process.env.ATTR_FIXTURE;
  const phase = process.env.ATTR_PHASE ?? 'dryRun';
  const pin = process.env.ATTR_PIN ?? 'none';
  const gcMerge = process.env.ATTR_GC_MERGE === '1';
  const gcRowsFrom = process.env.ATTR_GC_ROWSFROM === '1';
  const instrumented = await import(pathToFileURL(join(lib, 'dockyard-domain/memory.js')).href);
  if (!globalThis.__attrHookReady) throw new Error('the imported tree is not instrumented');
  const { EvolutionMemory } = instrumented;
  const realParse = JSON.parse;
  const realClone = globalThis.structuredClone;
  const counters = { parse: 0, clone: 0 };
  JSON.parse = function (...args) { counters.parse += 1; return realParse.apply(this, args); };
  globalThis.structuredClone = function (...args) { counters.clone += 1; return realClone.apply(this, args); };
  const { store } = createStore(join(fixture, 'state.json'));
  const memory = new EvolutionMemory({
    stateStore: store, clock: () => new Date(NOW), maxEntries: 1000, hotEntries: 50, hotCycles: 50,
    archiveMaxBytes: 256 * 1024, mutationAuthority: { assertMutation() {} },
  });
  await memory.load();
  const gc = () => { global.gc(); global.gc(); };
  const usage = () => {
    const usage = process.memoryUsage();
    return {
      heapUsed: usage.heapUsed, heapTotal: usage.heapTotal, rss: usage.rss, external: usage.external, arrayBuffers: usage.arrayBuffers,
      spaces: Object.fromEntries(getHeapSpaceStatistics().map((space) => [space.space_name, space.space_size])),
    };
  };
  gc();
  const start = usage();
  const baseCounts = { ...counters };
  const stages = [];
  const pins = [];
  const state = { merge: {}, readSync: {}, rowHit: {}, rowMiss: {}, history: {}, fallback: 0, forcedFallback: [] };
  const snapshotOf = (payload) => {
    const out = {};
    if (payload?.histories) out.histories = Object.fromEntries(Object.entries(payload.histories).map(([key, value]) => [key, Array.isArray(value) ? value.length : null]));
    if (payload?.collections) out.collections = payload.collections.length;
    if (payload?.allRecords) out.allRecords = payload.allRecords.length;
    if (payload?.canonicalByKey) out.canonicalByKey = payload.canonicalByKey.size;
    if (payload?.tombstoneMap) out.tombstoneMap = payload.tombstoneMap.size;
    if (payload?.observationGroups) out.observationGroups = { groups: payload.observationGroups.size, rows: [...payload.observationGroups.values()].reduce((sum, group) => sum + group.length, 0) };
    if (payload?.knowledgeByKey) out.knowledgeByKey = payload.knowledgeByKey.size;
    if (payload?.sourceGroups) out.sourceGroups = { groups: payload.sourceGroups.size, rows: [...payload.sourceGroups.values()].reduce((sum, group) => sum + group.length, 0) };
    if (payload?.retainedEntries) out.retainedEntries = Object.fromEntries([...payload.retainedEntries].map(([collection, set]) => [collection, set.size]));
    if (payload?.knowledgeOut) out.knowledgeOut = payload.knowledgeOut.length;
    if (payload?.knowledgePlan) out.knowledgePlan = { knowledge: payload.knowledgePlan.knowledge.length, consolidated: payload.knowledgePlan.consolidated };
    if (payload?.records) out.records = Object.fromEntries(Object.entries(payload.records).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length]));
    if (payload?.plan) out.plan = { records: Object.fromEntries(Object.entries(payload.plan.records).map(([key, value]) => [key, value.length])), canonical: payload.plan.canonical.length, report: payload.plan.report };
    if (payload?.oldData) out.oldData = Object.fromEntries(Object.entries(payload.oldData).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length]));
    return out;
  };
  const pinTargets = pin.split('+');
  globalThis.__attr = (name, payload) => {
    if (name === 'call') return;
    if (name === 'rowHit') { state.rowHit[payload] = (state.rowHit[payload] ?? 0) + 1; return; }
    if (name === 'rowMiss') { state.rowMiss[payload] = (state.rowMiss[payload] ?? 0) + 1; return; }
    if (name === 'readArchiveSync') { state.readSync[payload] = (state.readSync[payload] ?? 0) + 1; return; }
    if (name === 'merge') {
      const entry = state.merge[payload.collection] ?? { archived: 0, hot: 0, rows: 0, copy: payload.copy };
      entry.archived += payload.archived.length;
      entry.hot += payload.hot.length;
      entry.rows += payload.rows.length;
      state.merge[payload.collection] = entry;
      if (gcMerge && payload.copy && GC_TRANSIENT_COLLECTIONS.has(payload.collection)) {
        gc();
        stages.push({ name: `merge:${payload.collection}`, ...usage(), counts: { parse: counters.parse - baseCounts.parse, clone: counters.clone - baseCounts.clone }, snapshot: { archived: payload.archived.length, hot: payload.hot.length, rows: payload.rows.length } });
      }
      if (pinTargets.includes('merged')) pins.push(payload.rows);
      return;
    }
    if (name === 'rowsFrom') {
      if (gcRowsFrom && GC_TRANSIENT_COLLECTIONS.has(payload.collection)) {
        gc();
        stages.push({ name: `rowsFrom:${payload.collection}`, ...usage(), counts: { parse: counters.parse - baseCounts.parse, clone: counters.clone - baseCounts.clone }, snapshot: { rows: payload.rows.length, fileBuffers: payload.buffers.size } });
      }
      if (pinTargets.includes('rowsFrom')) pins.push(payload.rows);
      return;
    }
    if (name === 'fallback') {
      state.fallback += 1;
      gc();
      stages.push({ name: `fallback:${payload.collection}`, ...usage(), counts: { parse: counters.parse - baseCounts.parse, clone: counters.clone - baseCounts.clone }, snapshot: { rows: payload.rows?.length ?? null } });
      return;
    }
    if (name === 'readback') {
      gc();
      stages.push({ name: `readback:${payload.collection}`, ...usage(), counts: { parse: counters.parse - baseCounts.parse, clone: counters.clone - baseCounts.clone }, snapshot: { archived: payload.archived.length, cold: payload.cold.length } });
      if (pinTargets.includes('readback')) pins.push(payload.archived);
      return;
    }
    if (name === 'history') { state.history[payload] = (state.history[payload] ?? 0) + 1; return; }
    if (!GC_STAGES.has(name) && name !== 'knowledgePlan') return;
    gc();
    stages.push({ name, ...usage(), counts: { parse: counters.parse - baseCounts.parse, clone: counters.clone - baseCounts.clone }, snapshot: snapshotOf(payload) });
    if (pinTargets.includes('histories') && payload?.histories) pins.push(payload.histories);
    if (pinTargets.includes('plan')) {
      if (payload?.plan) pins.push(payload.plan);
      if (payload?.planReturned) pins.push(payload.planReturned.plan);
      if (payload?.plan?.plan) pins.push(payload.plan.plan);
    }
    if (pinTargets.includes('knowledgePlan') && payload?.knowledgePlan) pins.push(payload.knowledgePlan);
    if (pinTargets.includes('oldData') && payload?.oldData) pins.push(payload.oldData);
    if (pinTargets.includes('records') && payload?.plan) pins.push(payload.plan.records, payload.plan.canonical);
  };
  const startedAt = performance.now();
  let report;
  try {
    report = await memory.compact(phase === 'dryRun' ? { dryRun: true } : {});
  } finally {
    globalThis.__attr = null;
  }
  const wallMs = performance.now() - startedAt;
  gc();
  const end = usage();
  let retained = null;
  if (pins.length) {
    const withPins = usage();
    pins.length = 0;
    gc();
    const withoutPins = usage();
    retained = withPins.heapUsed - withoutPins.heapUsed;
  }
  const cache = {};
  for (const [collection, entry] of memory.archiveReadCache) {
    cache[collection] = {
      keys: entry.keys?.length ?? null,
      windowFrom: entry.windowFrom ?? null,
      windowLen: entry.window?.length ?? null,
      windowRows: entry.window ? entry.window.filter((row) => row !== undefined).length : null,
      tombstones: entry.tombstones?.size ?? null,
      hasRows: entry.rows !== undefined,
    };
  }
  process.stdout.write(JSON.stringify({
    phase, pin, wallMs, start, end, retained, report,
    stages,
    state,
    cache,
    counts: { parse: counters.parse - baseCounts.parse, clone: counters.clone - baseCounts.clone, loadParse: baseCounts.parse, loadClone: baseCounts.clone },
  }));
}

// ---------------------------------------------------------------------------
// Ownership: which rows a read hands out, and who owns them
// ---------------------------------------------------------------------------
const OWNERSHIP_COLLECTIONS = ['observations', 'knowledge', 'cycles', 'outcomes', 'promotions'];
const FALLBACK_COLLECTIONS = ['observations', 'knowledge'];

async function ownershipMode({ instrumentedLib, fixtureDir, fixture }) {
  const memoryModule = await import(pathToFileURL(join(instrumentedLib, 'dockyard-domain/memory.js')).href);
  const { EvolutionMemory } = memoryModule;
  const { store, identity } = createStore(join(fixtureDir, 'state.json'));
  const hookCounters = { rowHit: {}, rowMiss: {}, readSync: {}, fallback: 0, fallbackPayloads: [] };
  globalThis.__attr = (name, payload) => {
    if (name === 'rowHit') hookCounters.rowHit[payload] = (hookCounters.rowHit[payload] ?? 0) + 1;
    else if (name === 'rowMiss') hookCounters.rowMiss[payload] = (hookCounters.rowMiss[payload] ?? 0) + 1;
    else if (name === 'readArchiveSync') hookCounters.readSync[payload] = (hookCounters.readSync[payload] ?? 0) + 1;
    else if (name === 'fallback') { hookCounters.fallback += 1; hookCounters.fallbackPayloads.push({ collection: payload.collection, rows: payload.rows }); }
  };
  const memory = new EvolutionMemory({
    stateStore: store, clock: () => new Date(NOW), maxEntries: 1000, hotEntries: 50, hotCycles: 50,
    archiveMaxBytes: 256 * 1024, mutationAuthority: { assertMutation() {} },
  });
  try {
    await memory.load();
    const hotDocument = identity.document;
    const results = [];
    const failures = [];
    for (const collection of OWNERSHIP_COLLECTIONS) {
      const before = { rowHit: hookCounters.rowHit[collection] ?? 0, rowMiss: hookCounters.rowMiss[collection] ?? 0 };
      const view1 = memory.historyView(collection);
      const view2 = memory.historyView(collection);
      const after = { rowHit: hookCounters.rowHit[collection] ?? 0, rowMiss: hookCounters.rowMiss[collection] ?? 0 };
      const entry = memory.archiveReadCache.get(collection);
      const windowSet = new Set((entry?.window ?? []).filter((row) => row !== undefined));
      const hotSet = new Set(hotDocument?.[collection] ?? []);
      const counts = { total: view1.length, hot: 0, cachedWindow: 0, fresh: 0, stable: 0, changed: 0, overriddenByHot: 0, anonymous: 0 };
      const kinds = [];
      const freshIds = [];
      for (let index = 0; index < view1.length; index += 1) {
        const row = view1[index];
        const isHot = hotSet.has(row);
        const isWindow = windowSet.has(row);
        const kind = isHot ? 'hot' : isWindow ? 'cachedWindow' : 'fresh';
        kinds.push(kind);
        counts[kind] += 1;
        if (view1[index] === view2[index]) counts.stable += 1;
        else { counts.changed += 1; if (kind === 'fresh') freshIds.push(row?.id ?? null); }
        if (row && typeof row === 'object' && (row.id === undefined || row.id === null)) counts.anonymous += 1;
      }
      // A row whose id also appears in the loaded hot state must be the hot
      // object: `#mergeArchived()` maps archived first and overwrites on id.
      // Hot rows whose id is not archived are appended after the archived
      // prefix, exactly like anonymous archived rows.
      const archivedIds = new Set((entry?.keys ?? []).map((key) => key.startsWith('id:') ? key.slice(3) : null).filter(Boolean));
      let hotOnlyRows = 0;
      for (const hotRow of hotSet) {
        if (!hotRow || hotRow.id === undefined) continue;
        const index = view1.indexOf(hotRow);
        if (archivedIds.has(String(hotRow.id)) && index >= 0) counts.overriddenByHot += 1;
        else if (index >= 0) hotOnlyRows += 1;
        if (index < 0) failures.push(`${collection}: a live hot row is missing from historyView() (id ${String(hotRow.id).slice(0, 40)})`);
      }
      const archivedPrefix = Math.max(0, view1.length - counts.anonymous - hotOnlyRows);
      if (!kinds.slice(archivedPrefix).every((kind) => kind === 'hot' || kind === 'cachedWindow')) failures.push(`${collection}: rows appended after the archived prefix are neither hot rows nor anonymous archive rows`);
      if (hotOnlyRows !== hotSet.size - counts.overriddenByHot) failures.push(`${collection}: hot-only row count ${hotOnlyRows} does not match the loaded hot set`);
      // The window covers the trailing positions; every cached row the view
      // returned must have a position at or after `windowFrom`, and rows before
      // it must be fresh. Anonymous (no-id) archive rows are appended last and
      // are not part of the id-ordered prefix, so the position check stops at
      // the first row whose id is absent from the archive key table.
      const idRows = view1.slice(0, Math.max(0, view1.length - counts.anonymous));
      let windowRuleHolds = entry === undefined || idRows.every((row, index) => {
        if (index >= (entry?.keys.length ?? 0)) return true;
        if (!idRows[index] || typeof idRows[index] !== 'object' || idRows[index].id === undefined) return true;
        const expected = index >= (entry?.windowFrom ?? 0) ? 'cachedWindow' : 'fresh';
        return kinds[index] === 'hot' || kinds[index] === expected;
      });
      if (!windowRuleHolds) failures.push(`${collection}: cached-window rows are not the trailing positions`);
      if (counts.fresh !== counts.changed) failures.push(`${collection}: ${counts.fresh} fresh rows but ${counts.changed} rows changed identity across two calls`);
      if (counts.stable !== counts.hot + counts.cachedWindow) failures.push(`${collection}: ${counts.hot + counts.cachedWindow} store/cache rows but ${counts.stable} rows were stable across two calls`);
      if (entry?.rows !== undefined) failures.push(`${collection}: the cache entry kept the collector's full row array`);
      results.push({
        collection,
        ...counts,
        hotOnlyRows,
        keys: entry?.keys?.length ?? null,
        windowFrom: entry?.windowFrom ?? null,
        windowLen: entry?.window?.length ?? null,
        windowRows: windowSet.size,
        tombstones: entry?.tombstones?.size ?? null,
        cacheHasRows: entry?.rows !== undefined,
        rowHitsThisCollection: after.rowHit - before.rowHit,
        rowMissesThisCollection: after.rowMiss - before.rowMiss,
        freshSampleIds: freshIds.slice(0, 3),
        windowRuleHolds,
      });
    }
    // Fallback: `#archiveRowsFrom()` cannot reproduce a row from its own line,
    // so `#readArchiveSync()` returns the rows one `collectRows` scan parsed.
    // Probe it on a fresh instance, once with an empty cache and once on an
    // already-warm cache, and classify the returned rows the same way. Both a
    // collection larger than the row window (observations at >= 10k rows) and
    // one whose window can be byte-capped (knowledge) are probed, so the result
    // covers the cached-window subset and the freshly parsed subset.
    const fallbackResults = [];
    for (const collection of FALLBACK_COLLECTIONS) {
      for (const warmed of [false, true]) {
        const freshStore = createStore(join(fixtureDir, 'state.json'));
        const fresh = new EvolutionMemory({
          stateStore: freshStore.store, clock: () => new Date(NOW), maxEntries: 1000, hotEntries: 50, hotCycles: 50,
          archiveMaxBytes: 256 * 1024, mutationAuthority: { assertMutation() {} },
        });
        await fresh.load();
        if (warmed) fresh.historyView(collection);
        const fallbackBefore = hookCounters.fallback;
        globalThis.__attrForceFallback = collection;
        const fallbackPayloadCount = hookCounters.fallbackPayloads.length;
        const view1 = fresh.historyView(collection);
        const view2 = fresh.historyView(collection);
        const entry = fresh.archiveReadCache.get(collection);
        const windowRows = (entry?.window ?? []).filter((row) => row !== undefined);
        const windowSet = new Set(windowRows);
        const hotSet = new Set(freshStore.identity.document?.[collection] ?? []);
        // Direct identity evidence for the question the plan's ownership rule
        // hangs on: the rows one collectRows scan answers with are the very
        // objects the new cache window holds, and only for the window range.
        const collector = hookCounters.fallbackPayloads.slice(fallbackPayloadCount).find((payload) => payload.collection === collection);
        const collectorRows = collector?.rows ?? [];
        const rowSet = new Set(collectorRows);
        let positionalWindowShared = 0;
        let positionalFreshPlain = 0;
        let positionalMismatch = 0;
        if (entry && collectorRows.length) {
          const visible = [];
          for (let position = 0; position < entry.keys.length; position += 1) {
            if (collection !== 'tombstones' && entry.tombstones.has(entry.keys[position])) continue;
            visible.push(position);
          }
          for (let index = 0; index < visible.length; index += 1) {
            const offset = visible[index] - entry.windowFrom;
            if (offset >= 0 && offset < entry.window.length && entry.window[offset] !== undefined) {
              if (collectorRows[index] === entry.window[offset]) positionalWindowShared += 1;
              else positionalMismatch += 1;
            } else if (!windowSet.has(collectorRows[index])) positionalFreshPlain += 1;
            else positionalMismatch += 1;
          }
        }
        const windowRowsInCollector = windowRows.filter((row) => rowSet.has(row)).length;
        let cachedWindow = 0;
        let hot = 0;
        let freshRows = 0;
        let changed = 0;
        for (let index = 0; index < view1.length; index += 1) {
          if (hotSet.has(view1[index])) hot += 1;
          else if (windowSet.has(view1[index])) cachedWindow += 1;
          else freshRows += 1;
          if (view1[index] !== view2[index]) changed += 1;
        }
        const label = `fallback(${collection},warmed=${warmed})`;
        fallbackResults.push({
          collection,
          warmed,
          collectorRows: collectorRows.length,
          windowRowsInCollector,
          positionalWindowShared,
          positionalFreshPlain,
          positionalMismatch,
          collectorIsWindowArray: collectorRows !== entry?.window,
          forced: hookCounters.fallback > fallbackBefore,
          rows: view1.length,
          hot,
          cachedWindow,
          fresh: freshRows,
          changed,
          keys: entry?.keys?.length ?? null,
          windowFrom: entry?.windowFrom ?? null,
          windowRows: windowSet.size,
          cacheHasRows: entry?.rows !== undefined,
        });
        if (!fallbackResults.at(-1).forced) failures.push(`${label}: the forced fallback did not run`);
        if (entry?.rows !== undefined) failures.push(`${label}: the cache entry kept the collector's full row array`);
        if (changed !== freshRows) failures.push(`${label}: ${freshRows} rows are neither store- nor cache-owned but only ${changed} changed identity across two calls`);
        if (windowRowsInCollector !== windowRows.length) failures.push(`${label}: only ${windowRowsInCollector}/${windowRows.length} cache-window rows are the collector's own row objects`);
        if (positionalWindowShared + positionalFreshPlain !== view1.length) failures.push(`${label}: the collector's row identities do not follow the window range (${positionalWindowShared}+${positionalFreshPlain} of ${view1.length}, mismatches ${positionalMismatch})`);
      }
    }
    // Inherited cache: a successor instance built with the predecessor's
    // archiveReadCache shares the entry's window array and row objects (the
    // constructor spreads the entry but not the rows). The window rows are
    // therefore owned by the cache of *both* instances, never by one plan.
    const inheritedStoreA = createStore(join(fixtureDir, 'state.json'));
    const memoryA = new EvolutionMemory({
      stateStore: inheritedStoreA.store, clock: () => new Date(NOW), maxEntries: 1000, hotEntries: 50, hotCycles: 50,
      archiveMaxBytes: 256 * 1024, mutationAuthority: { assertMutation() {} },
    });
    await memoryA.load();
    memoryA.historyView('observations');
    const entryA = memoryA.archiveReadCache.get('observations');
    const inheritedStoreB = createStore(join(fixtureDir, 'state.json'));
    const memoryB = new EvolutionMemory({
      stateStore: inheritedStoreB.store, clock: () => new Date(NOW), maxEntries: 1000, hotEntries: 50, hotCycles: 50,
      archiveMaxBytes: 256 * 1024, mutationAuthority: { assertMutation() {} }, archiveReadCache: memoryA.archiveReadCache,
    });
    await memoryB.load();
    const viewB1 = memoryB.historyView('observations');
    const viewB2 = memoryB.historyView('observations');
    const entryB = memoryB.archiveReadCache.get('observations');
    const windowA = (entryA?.window ?? []).filter((row) => row !== undefined);
    const windowB = (entryB?.window ?? []).filter((row) => row !== undefined);
    const sharedWithPredecessor = windowB.filter((row) => windowA.includes(row)).length;
    const bStableWhenCached = viewB1.filter((row, index) => row !== undefined && windowB.includes(row) && viewB1[index] === viewB2[index]).length;
    const inherited = {
      successorEntryIsDistinctObject: entryA !== entryB,
      predecessorWindowRows: windowA.length,
      successorWindowRows: windowB.length,
      sharedWindowRowObjects: sharedWithPredecessor,
      successorCachedRowsStableAcrossCalls: bStableWhenCached,
      successorEntryInheritedFlag: entryB?.inherited ?? null,
      windowRowsAreStoreRows: viewB1.filter((row) => new Set(inheritedStoreB.identity.document?.observations ?? []).has(row)).length,
    };
    if (entryA === entryB) failures.push('inherited cache: the successor adopted the predecessor entry object instead of a copy');
    if (sharedWithPredecessor !== windowA.length || sharedWithPredecessor !== windowB.length) failures.push('inherited cache: the window row objects are not shared with the predecessor');
    if (bStableWhenCached !== windowB.length) failures.push('inherited cache: cached rows of the successor did not stay identical across two calls');

    return {
      collections: results,
      fallback: fallbackResults,
      inherited,
      // The collected fallback rows themselves are evidence only while the
      // probe runs; keep their count in the report instead of the row graphs.
      hookCounters: { ...hookCounters, fallbackPayloads: hookCounters.fallbackPayloads.length },
      failures,
      checks: {
        noCacheEntryHoldsCollectedRows: results.every((result) => result.cacheHasRows === false),
        freshRowsAreCallOwned: results.every((result) => result.fresh === result.changed),
        namespacedRowsAreStoreOrCacheOwned: results.every((result) => result.stable === result.hot + result.cachedWindow),
        cachedWindowIsTheTrailingRange: results.every((result) => result.windowRuleHolds),
        fallbackRowsSplitTheSameWay: fallbackResults.every((result) => result.fresh === result.changed),
        fallbackWindowRowsAreTheCollectorObjects: fallbackResults.every((result) => result.positionalMismatch === 0 && result.windowRowsInCollector === result.windowRows),
        fallbackCollectorIsNotTheCacheWindowArray: fallbackResults.every((result) => result.collectorIsWindowArray),
        inheritedWindowRowsAreSharedWithThePredecessor: sharedWithPredecessor === windowA.length && sharedWithPredecessor === windowB.length,
      },
    };
  } finally {
    globalThis.__attr = null;
    globalThis.__attrForceFallback = null;
  }
}

// ---------------------------------------------------------------------------
// Retention: stage live sets and pin-retained graphs
// ---------------------------------------------------------------------------
async function runChild({ instrumentedLib, fixtureDir, phase, pin, gcMerge, gcRowsFrom, keep }) {
  const args = [SELF, '--child'];
  const env = {
    ...process.env,
    ATTR_LIB: instrumentedLib,
    ATTR_FIXTURE: fixtureDir,
    ATTR_PHASE: phase,
    ATTR_PIN: pin,
    ATTR_GC_MERGE: gcMerge ? '1' : '0',
    ATTR_GC_ROWSFROM: gcRowsFrom ? '1' : '0',
  };
  const output = execFileSync(process.execPath, ['--expose-gc', ...args], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(output);
}

async function copyFixture(source, target) {
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });
}

function summariseStages(runs, stageNames) {
  const summary = {};
  for (const name of stageNames) {
    const samples = runs.map((run) => run.stages.find((stage) => stage.name === name)).filter(Boolean);
    if (!samples.length) continue;
    summary[name] = {
      count: samples.length,
      heapUsedMedian: median(samples.map((sample) => sample.heapUsed)),
      heapUsedMin: Math.min(...samples.map((sample) => sample.heapUsed)),
      heapUsedMax: Math.max(...samples.map((sample) => sample.heapUsed)),
      parseMedian: median(samples.map((sample) => sample.counts.parse)),
      cloneMedian: median(samples.map((sample) => sample.counts.clone)),
      snapshot: samples.at(-1)?.snapshot ?? null,
      spaces: samples.at(-1)?.spaces ?? null,
    };
  }
  return summary;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function retentionMode({ options, instrumentedLib, fixtureRoot, fixtures, output }) {
  const temp = fixtureRoot;
  const measurements = [];
  for (const scale of options.scales) {
    const fixture = fixtures.get(scale);
    const fixtureDir = join(temp, `fixture-${scale}`);
    for (const phase of PHASES) {
      const stageNames = ['histories', 'allRecords', 'preKnowledge', 'knowledgeInner', 'knowledgeOutput', 'preRecordsEnd', 'plan', 'planReturned', 'knowledgePlan', 'oldData', 'merge:observations', 'merge:knowledge', 'rowsFrom:observations', 'rowsFrom:knowledge', 'readback:observations', 'readback:knowledge', 'indexWritten'];
      const stageRuns = [];
      const pinRuns = [];
      const pinsToRun = options.pins.includes('none') ? options.pins : ['none', ...options.pins];
      for (const pin of pinsToRun) {
        const runDir = join(temp, `run-${scale}-${phase}-${pin.replaceAll('+', '_')}`);
        await copyFixture(fixtureDir, runDir);
        const run = await runChild({
          instrumentedLib, fixtureDir: runDir, phase, pin,
          // The `none` run is the stage-profile run: it pays one GC at each
          // transient so the per-collection read peaks are in its stage table.
          // Pin runs do not need them.
          gcMerge: pin === 'none' || (options.hotSteps && pin === 'merged'),
          gcRowsFrom: pin === 'none' || (options.hotSteps && pin === 'rowsFrom'),
        });
        if (pin === 'none') stageRuns.push(run); else pinRuns.push(run);
        measurements.push({ scale, phase, pin, run });
        if (!options.keep) await rm(runDir, { recursive: true, force: true });
      }
      const base = stageRuns[0];
      const stageSummary = summariseStages(stageRuns, stageNames);
      const pins = Object.fromEntries(pinRuns.filter((run) => run.pin !== 'none').map((run) => [run.pin, {
        retainedBytes: run.retained,
        endHeapUsedWithPins: run.end.heapUsed,
        counts: run.counts,
      }]));
      output.retention[scale].phases[phase] = {
        report: project(base.report),
        wallMs: base.wallMs,
        start: base.start,
        end: base.end,
        counts: base.counts,
        stages: stageSummary,
        stagesRaw: base.stages,
        stageOrder: base.stages.map((stage) => stage.name),
        pins,
        cache: base.cache,
        state: base.state,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const options = parseArgs(ARGS);
  if (!options) return;
  if (typeof global.gc !== 'function') throw new Error('run with --expose-gc');
  const cpu = cpus();
  const output = {
    schema: 1,
    command: [process.execPath, ...process.execArgv, SELF, ...ARGS],
    environment: { node: process.version, platform: process.platform, kernel: release(), arch: arch(), cpuModel: cpu[0]?.model, logicalCpuCount: cpu.length, totalMemoryBytes: totalmem(), loadAverageAtStart: loadavg() },
    scope: 'ownership of historyView() rows and live-heap/retained attribution of retentionPlan()/compact(); the measured call is the public compact()',
    ref: options.ref,
    refCommit: null,
    libTreeSha256: null,
    instrumentedTree: null,
    fixture: {},
    ownership: null,
    retention: {},
  };
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-retention-attribution-'));
  const fixtureRoot = join(temporary, 'fixtures');
  const frozen = join(temporary, 'frozen');
  let frozenLib = options.lib;
  try {
    if (!frozenLib) {
      const extracted = await extractRef(options.ref, frozen);
      frozenLib = extracted.lib;
      output.refCommit = extracted.commit;
    } else {
      output.refCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
    }
    output.libTreeSha256 = await treeSha256(frozenLib);
    const instrumentedLib = join(temporary, 'instrumented', 'lib');
    const patch = await instrument(frozenLib, instrumentedLib);
    output.instrumentedTree = { bytes: patch.bytes, anchors: patch.applied.length };
    const knowledge = await import(pathToFileURL(join(frozenLib, 'dockyard-domain/knowledge.js')).href);
    const fixtures = new Map();
    for (const scale of options.scales) {
      const fixtureDir = join(fixtureRoot, `fixture-${scale}`);
      fixtures.set(scale, { dir: fixtureDir, fixture: await buildFixture({ scale, shape: 'cold', directory: fixtureDir, knowledge }) });
      output.fixture[`cold-${scale}`] = fixtures.get(scale).fixture;
    }
    if (options.mode === 'ownership' || options.mode === 'all') {
      const scale = options.scales[0];
      // Ownership is probed on the warm shape: the state file holds live hot
      // rows for every collection, so all three owners (store, cache window,
      // this call) appear in one view and id collisions with the archive show
      // which object wins.
      const ownershipDir = join(fixtureRoot, `ownership-${scale}`);
      const ownershipFixture = await buildFixture({ scale, shape: 'hot', directory: ownershipDir, knowledge });
      output.fixture[`ownership-${scale}`] = ownershipFixture;
      output.ownership = await ownershipMode({ instrumentedLib, fixtureDir: ownershipDir, fixture: ownershipFixture });
    }
    if (options.mode === 'retention' || options.mode === 'all') {
      for (const scale of options.scales) output.retention[scale] = { fixture: fixtures.get(scale).fixture, phases: {} };
      if (options.hotSteps) {
        const scale = options.scales[0];
        const hotDir = join(fixtureRoot, `hot-${scale}`);
        const hot = await buildFixture({ scale, shape: 'hot', directory: hotDir, knowledge, markerCount: 4096 });
        output.fixture[`hot-${scale}`] = hot;
        const runDir = join(temporary, `run-hot-${scale}`);
        await copyFixture(hotDir, runDir);
        const run = await runChild({ instrumentedLib, fixtureDir: runDir, phase: 'dryRun', pin: 'oldData', gcMerge: false, gcRowsFrom: false });
        output.retention[scale].hotOldData = {
          fixture: hot,
          report: project(run.report),
          retainedBytes: run.retained,
          oldDataRows: run.stages.find((stage) => stage.name === 'oldData')?.snapshot?.oldData ?? null,
        };
        if (!options.keep) await rm(runDir, { recursive: true, force: true });
      }
      await retentionMode({ options, instrumentedLib, fixtureRoot, fixtures, output });
    }
    const json = JSON.stringify(output, null, 2) + '\n';
    if (options.out) {
      await mkdir(dirname(options.out), { recursive: true });
      await writeFile(options.out, json);
    }
    if (options.json) process.stdout.write(json);
    else printReport(output, options);
    const failures = output.ownership?.failures ?? [];
    if (failures.length) {
      for (const failure of failures) console.error(`ownership invariant failed: ${failure}`);
      process.exitCode = 1;
    }
  } finally {
    if (!options.keep) await rm(temporary, { recursive: true, force: true });
    else console.error(`kept ${temporary}`);
  }
}

function printReport(output, options) {
  console.log(`node ${output.environment.node} ${output.environment.platform}/${output.environment.arch} (${output.environment.cpuModel}, ${output.environment.logicalCpuCount} cpus)`);
  console.log(`lib tree ${output.refCommit ? `from ${options.ref} @ ${output.refCommit}` : 'from --lib'}: ${output.libTreeSha256}  instrumented anchors: ${output.instrumentedTree.anchors}`);
  for (const [key, fixture] of Object.entries(output.fixture)) {
    console.log(`fixture ${key}: ${fixture.scale} rows ${JSON.stringify(fixture.counts)} canonical=${fixture.canonical} hot=${JSON.stringify(fixture.hotRows)} archive=${(fixture.archiveTotalBytes / MIB).toFixed(2)} MiB`);
  }
  if (output.ownership) {
    console.log('\nownership of historyView() rows (object identity across two calls)');
    console.log('collection    rows    hot  window   fresh  stable  changed  overridden  windowFrom  keys   rowHits rowMisses');
    for (const result of output.ownership.collections) {
      console.log(`${result.collection.padEnd(13)} ${String(result.total).padStart(5)} ${String(result.hot).padStart(6)} ${String(result.cachedWindow).padStart(7)} ${String(result.fresh).padStart(7)} ${String(result.stable).padStart(7)} ${String(result.changed).padStart(8)} ${String(result.overriddenByHot).padStart(11)} ${String(result.windowFrom).padStart(11)} ${String(result.keys).padStart(5)} ${String(result.rowHitsThisCollection).padStart(8)} ${String(result.rowMissesThisCollection).padStart(9)}`);
    }
    console.log('fallback (forced #archiveRowsFrom failure, rows returned by one collectRows scan)');
    for (const result of output.ownership.fallback) {
      console.log(`warmed=${String(result.warmed).padEnd(5)} rows=${result.rows} cachedWindow=${result.cachedWindow} fresh=${result.fresh} changedOnSecondCall=${result.changed} windowFrom=${result.windowFrom} windowRows=${result.windowRows} cacheHasRows=${result.cacheHasRows}`);
    }
    console.log(`inherited cache: predecessorWindowRows=${output.ownership.inherited.predecessorWindowRows} successorWindowRows=${output.ownership.inherited.successorWindowRows} sharedRowObjects=${output.ownership.inherited.sharedWindowRowObjects} successorEntryObjectShared=${!output.ownership.inherited.successorEntryIsDistinctObject} inheritedFlag=${output.ownership.inherited.successorEntryInheritedFlag}`);
    console.log('checks', JSON.stringify(output.ownership.checks));
    if (output.ownership.failures.length) console.log(`FAILURES: ${output.ownership.failures.length}`);
  }
  for (const [scale, entry] of Object.entries(output.retention)) {
    console.log(`\nretention scale=${scale} fixture rows=${entry.fixture.scale} archive=${(entry.fixture.archiveTotalBytes / MIB).toFixed(2)} MiB`);
    for (const phase of PHASES) {
      const result = entry.phases[phase];
      if (!result) continue;
      console.log(` ${phase}: wall ${result.wallMs.toFixed(1)} ms, parse ${result.counts.parse}, structuredClone ${result.counts.clone}, endHeap ${(result.end.heapUsed / MIB).toFixed(2)} MiB`);
      let previous = { parse: 0, clone: 0 };
      for (const stage of result.stagesRaw ?? []) {
        const delta = stage.heapUsed - result.start.heapUsed;
        const parse = stage.counts.parse - previous.parse;
        const clone = stage.counts.clone - previous.clone;
        previous = stage.counts;
        console.log(`   ${stage.name.padEnd(24)} heap ${(stage.heapUsed / MIB).toFixed(2).padStart(7)} MiB (${delta >= 0 ? '+' : ''}${(delta / MIB).toFixed(2)}) +parse ${String(parse).padStart(6)} +clone ${String(clone).padStart(6)} ${stage.snapshot ? JSON.stringify(stage.snapshot).slice(0, 180) : ''}`);
      }
      for (const [pin, value] of Object.entries(result.pins)) {
        console.log(`   pin ${pin.padEnd(16)} retained ${value.retainedBytes === null ? 'n/a' : `${(value.retainedBytes / MIB).toFixed(2)} MiB`}`);
      }
    }
    if (entry.hotOldData) console.log(` warm fixture oldData rows=${JSON.stringify(entry.hotOldData.oldDataRows)} retained=${(entry.hotOldData.retainedBytes / MIB).toFixed(2)} MiB`);
  }
}

try {
  if (parseSelf) await main();
  else await childMain();
} catch (error) {
  console.error(`retention-plan-attribution: ${error?.stack ?? error}`);
  process.exitCode = 1;
}
