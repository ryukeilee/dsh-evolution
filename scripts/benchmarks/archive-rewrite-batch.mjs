// Isolated A/B for EvolutionMemory.#rewriteArchives(). The baseline is loaded
// from BENCH_BASE_COMMIT; the candidate is the checkout's current memory.js.
// All fixtures and output live in fresh temporary homes.
//
//   node --expose-gc scripts/benchmarks/archive-rewrite-batch.mjs
//   BENCH_COLD_ROWS=384,3072,12288 BENCH_ROUNDS=5 node --expose-gc ...
//   BENCH_TRACE_VARIANT=baseline BENCH_ACTION=compact BENCH_COLD_ROWS=3072 ...
//
// The optional trace mode pauses after fixture loading for external diagnostics.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';

if (!global.gc && !process.env.BENCH_TRACE_VARIANT) throw new Error('run with --expose-gc');
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MEMORY_PATH = join(ROOT, 'lib/dockyard-domain/memory.js');
const BASE_COMMIT = process.env.BENCH_BASE_COMMIT ?? '956031d36c7eb558d1b6b2c504a7d0ffac753884';
const BASE_SOURCE = execFileSync('git', ['show', `${BASE_COMMIT}:lib/dockyard-domain/memory.js`], { cwd: ROOT, encoding: 'utf8' });
const SOURCE = await readFile(MEMORY_PATH, 'utf8');
const SCRIPT_SOURCE = await readFile(fileURLToPath(import.meta.url), 'utf8');
const ARCHIVE_MAX_BYTES = Number(process.env.BENCH_ARCHIVE_MAX_BYTES ?? 8 * 1024 * 1024);
const ABSOLUTE_MAX_SEGMENT_BYTES = Number(process.env.BENCH_ABSOLUTE_MAX_SEGMENT_BYTES ?? 16 * 1024 * 1024);
assert.ok(Number.isInteger(ARCHIVE_MAX_BYTES) && ARCHIVE_MAX_BYTES >= 256, 'BENCH_ARCHIVE_MAX_BYTES must be an integer of at least 256');
assert.ok(Number.isInteger(ABSOLUTE_MAX_SEGMENT_BYTES) && ABSOLUTE_MAX_SEGMENT_BYTES >= 256, 'BENCH_ABSOLUTE_MAX_SEGMENT_BYTES must be an integer of at least 256');

const require = createRequire(import.meta.url);
const fsp = require('node:fs/promises');
const originalAppendFile = fsp.appendFile;
const originalWriteFile = fsp.writeFile;
const io = { appendFile: { calls: 0, elapsedMs: 0, bytes: 0 }, writeFile: { calls: 0, elapsedMs: 0, bytes: 0 } };
let activeFault = null;
function resetIo() { for (const value of Object.values(io)) Object.assign(value, { calls: 0, elapsedMs: 0, bytes: 0 }); }
const asBufferLength = (data) => typeof data === 'string' ? Buffer.byteLength(data) : (data?.byteLength ?? 0);
fsp.appendFile = async function (...args) {
  const file = String(args[0]);
  const start = performance.now();
  try {
    if (activeFault && file.includes('.compact-') && asBufferLength(args[1]) > 0) {
      activeFault.calls++;
      if (activeFault.calls === activeFault.after) {
        if (activeFault.partialBytes) {
          const partial = Buffer.from(args[1]).subarray(0, activeFault.partialBytes);
          await originalAppendFile.call(this, args[0], partial, ...args.slice(2));
        }
        throw activeFault.error;
      }
    }
    return await originalAppendFile.apply(this, args);
  } finally {
    if (file.includes('.compact-')) { io.appendFile.calls++; io.appendFile.elapsedMs += performance.now() - start; io.appendFile.bytes += asBufferLength(args[1]); }
  }
};
fsp.writeFile = async function (...args) {
  const file = String(args[0]);
  const start = performance.now();
  try {
    if (activeFault && file.includes('.compact-') && asBufferLength(args[1]) > 0) {
      activeFault.calls++;
      if (activeFault.calls === activeFault.after) {
        if (activeFault.partialBytes) {
          const partial = Buffer.from(args[1]).subarray(0, activeFault.partialBytes);
          await originalWriteFile.call(this, args[0], partial, ...args.slice(2));
        }
        throw activeFault.error;
      }
    }
    return await originalWriteFile.apply(this, args);
  } finally {
    if (file.includes('.compact-')) { io.writeFile.calls++; io.writeFile.elapsedMs += performance.now() - start; io.writeFile.bytes += asBufferLength(args[1]); }
  }
};
syncBuiltinESMExports();

const tempModules = [];
async function loadMemoryClasses() {
  const { EvolutionMemory: BatchedMemory } = await import(pathToFileURL(MEMORY_PATH).href + `?archive-rewrite-candidate=${Date.now()}`);
  const directory = await mkdtemp(join(tmpdir(), 'dsh-archive-rewrite-module-'));
  tempModules.push(directory);
  const modulePath = join(directory, 'memory.mjs');
  const dependencyBase = pathToFileURL(MEMORY_PATH);
  const source = BASE_SOURCE.replace(/from (["'])(\.\.?\/[^"']+)\1/g,
    (_match, quote, specifier) => `from ${quote}${new URL(specifier, dependencyBase).href}${quote}`);
  await originalWriteFile(modulePath, source);
  const { EvolutionMemory: BaselineMemory } = await import(pathToFileURL(modulePath).href);
  return { baseline: BaselineMemory, batched: BatchedMemory };
}
const { baseline: BaselineMemory, batched: BatchedMemory } = await loadMemoryClasses();

const NOW = '2026-10-20T00:00:00.000Z';
const COLLECTIONS = ['observations', 'proposals', 'cycles'];
const rowsFor = (collection, count, payloadBytes) => Array.from({ length: count }, (_, index) => ({
  id: `${collection}-${index}`, recordedAt: NOW, payload: `${collection}:${index}:` + 'x'.repeat(payloadBytes),
}));
function fixtureRowsForColdCount(coldRows) {
  // The synthetic proposal rows trigger 15 deterministic housekeeping removals;
  // compensate so the post-retention cold archive count is exactly the target.
  const perCollection = (coldRows + 48) / 3;
  assert.equal(Number.isInteger(perCollection), true, `cold row target must align to three 16-row hot pools: ${coldRows}`);
  return { observations: perCollection, proposals: perCollection + 15, cycles: perCollection };
}
function fileStore(filePath) {
  let nextFailure = null;
  return {
    filePath,
    failNextUpdate(error) { nextFailure = error; },
    async load() { try { return JSON.parse(await readFile(filePath, 'utf8')); } catch (error) { if (error?.code === 'ENOENT') return {}; throw error; } },
    async update(change) {
      if (nextFailure) { const error = nextFailure; nextFailure = null; throw error; }
      const current = await this.load();
      await originalWriteFile(filePath, JSON.stringify(await change(current)), { mode: 0o600 });
    },
  };
}
function openMemory(MemoryClass, filePath, { archiveWriteGuard = null } = {}) {
  const store = fileStore(filePath);
  const memory = new MemoryClass({
    stateStore: store, clock: () => new Date(NOW), maxEntries: 10_000,
    hotEntries: 16, hotCycles: 16, archiveMaxBytes: ARCHIVE_MAX_BYTES,
    absoluteMaxSegmentBytes: ABSOLUTE_MAX_SEGMENT_BYTES, archiveWriteGuard,
  });
  memory.setMutationAuthority({ assertMutation() {}, isActive: () => true });
  return { memory, store };
}
async function seedRows(filePath, counts, payloadBytes) {
  const evolution = Object.fromEntries(COLLECTIONS.map((collection) => [collection, rowsFor(collection, counts[collection], payloadBytes)]));
  await originalWriteFile(filePath, JSON.stringify({ evolution }), { mode: 0o600 });
}
async function archivedRecordCount(root) {
  let total = 0;
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (relative(root, path).includes('archive') && path.endsWith('.jsonl')) {
        total += (await readFile(path, 'utf8')).split('\n').filter(Boolean).length;
      }
    }
  }
  await visit(root);
  return total;
}
async function treeDigest(root) {
  const output = {};
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else output[relative(root, path)] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
  }
  await visit(root);
  return Object.fromEntries(Object.entries(output).sort(([a], [b]) => a.localeCompare(b)));
}
async function segmentManifest(root) {
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.startsWith('segment-') && entry.name.endsWith('.jsonl')) {
        const bytes = await readFile(path);
        output.push({ path: relative(root, path), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
    }
  }
  await visit(root);
  return output.sort((a, b) => a.path.localeCompare(b.path));
}
function durableTree(tree) {
  return Object.fromEntries(Object.entries(tree).filter(([path]) => !/\.compact-[0-9a-f-]+\.tmp$/.test(path)));
}
function temporaryProjection(tree) {
  return Object.entries(tree).filter(([path]) => /\.compact-[0-9a-f-]+\.tmp$/.test(path))
    .map(([path, sha256]) => ({ path: path.replace(/\.compact-[0-9a-f-]+\.tmp$/, '.compact-TOKEN.tmp'), sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
const stable = (value) => JSON.stringify(value);
async function invoke(memory, action) {
  if (action === 'compact') return memory.compact();
  if (action === 'finalizeKnowledge') return memory.finalizeKnowledge({
    problemFingerprint: 'bench-problem', candidateGroup: 'bench-group',
    winner: { id: 'bench-winner', candidateFingerprint: 'bench-winner-fingerprint', problemFingerprint: 'bench-problem', candidateGroup: 'bench-group', capabilityId: 'bench-capability', status: 'validated' },
    candidates: [], validation: { validationRuns: 1 }, before: { latency: 3 }, after: { latency: 2 },
    lineage: { lineageId: 'bench-lineage', generation: 2 }, outcome: 'SUCCESS',
  });
  throw new Error(`unknown action: ${action}`);
}
async function execute(MemoryClass, { rowsByCollection, expectedColdRows, payloadBytes, action, injectFailure = false, injectPartialFailure = false, injectSaveFailure = false, waitForTraceSignal = false, home: suppliedHome = null }) {
  const home = suppliedHome ?? await mkdtemp(join(tmpdir(), 'dsh-archive-rewrite-'));
  await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true });
  const filePath = join(home, 'state.json');
  const injected = Object.assign(new Error('EIO: injected compact temporary-file write failure'), { code: 'EIO', marker: 'archive-rewrite-bench-fault' });
  try {
    await seedRows(filePath, rowsByCollection, payloadBytes);
    const { memory, store } = openMemory(MemoryClass, filePath);
    await memory.load();
    // Persist the hot projection just as a normal successful partition write
    // would, leaving an unambiguous split between state and cold archives.
    await store.update((state) => ({ ...state, evolution: memory.snapshot() }));
    const beforeTree = await treeDigest(home);
    resetIo();
    activeFault = injectFailure ? { calls: 0, after: 1, error: injected }
      : injectPartialFailure ? { calls: 0, after: 1, partialBytes: 37, error: injected } : null;
    if (injectSaveFailure) store.failNextUpdate(injected);
    if (waitForTraceSignal) {
      console.log(JSON.stringify({ traceReady: true, pid: process.pid, coldRows: expectedColdRows, rowsByCollection, payloadBytes, action }));
      await new Promise((resolve) => setTimeout(resolve, Number(process.env.BENCH_TRACE_DELAY_MS ?? 5000)));
    }
    const cpuStart = process.cpuUsage();
    const start = performance.now();
    let result;
    let thrown = null;
    try { result = await invoke(memory, action); } catch (error) { thrown = error; }
    const elapsedMs = performance.now() - start;
    const cpu = process.cpuUsage(cpuStart);
    const cpuMs = (cpu.user + cpu.system) / 1000;
    const measuredIo = structuredClone(io);
    activeFault = null;
    const afterTree = await treeDigest(home);
    const afterState = stable(memory.snapshot());
    const afterFullState = stable(memory.fullSnapshot());
    const afterSegments = await segmentManifest(home);
    let repeat = null;
    let restart = null;
    if (thrown === null) {
      assert.equal(await archivedRecordCount(home), expectedColdRows, `${action}: first archive write must contain exactly ${expectedColdRows} cold rows`);
      const repeatResult = await invoke(memory, action);
      repeat = { result: repeatResult, state: stable(memory.snapshot()), fullState: stable(memory.fullSnapshot()), tree: await treeDigest(home), segments: await segmentManifest(home), archivedRows: await archivedRecordCount(home) };
    }
    if (injectFailure || injectPartialFailure || injectSaveFailure) {
      assert.equal(thrown, injected, 'public method must propagate the original injected error object');
      if (injectSaveFailure) {
        const withoutDerivedIndex = (tree) => Object.fromEntries(Object.entries(tree).filter(([path]) => path !== 'state.json.evolution-archive-index.json'));
        assert.deepEqual(withoutDerivedIndex(afterTree), withoutDerivedIndex(beforeTree),
          'failed state persistence must roll back state and archive bytes; the derived index may be reconciled on restart');
      } else assert.deepEqual(durableTree(afterTree), beforeTree, 'failed archive write must preserve durable state and archive bytes');
      const temporaryFiles = Object.keys(afterTree).filter((path) => !Object.hasOwn(beforeTree, path));
      assert.ok(temporaryFiles.every((path) => path.includes('.compact-') && path.endsWith('.tmp')),
        `failure may leave only its temporary file, got: ${temporaryFiles.join(', ')}`);
      if (injectFailure) assert.equal(temporaryFiles.length, 1, 'pre-write failure must leave the existing empty temporary file');
      if (injectPartialFailure) assert.equal(temporaryFiles.length, 1, 'partial write may leave only its existing temporary file');
      if (injectSaveFailure) assert.equal(temporaryFiles.length, 0, 'rollback after installation must remove transaction files');
      const { memory: restarted } = openMemory(MemoryClass, filePath);
      await restarted.load();
      restart = { state: stable(restarted.snapshot()), fullState: stable(restarted.fullSnapshot()), tree: await treeDigest(home), segments: await segmentManifest(home) };
      for (const collection of COLLECTIONS) {
        const restartedIds = restarted.history(collection).map((entry) => entry?.id ?? null).sort();
        const expectedIds = rowsFor(collection, rowsByCollection[collection], payloadBytes).map((entry) => entry.id).sort();
        assert.deepEqual(restartedIds, expectedIds, `failed rewrite ${collection} records must survive restart`);
      }
    } else {
      assert.equal(thrown, null, `operation unexpectedly failed: ${thrown?.stack ?? thrown}`);
    }
    return {
      elapsedMs, cpuMs, result: thrown ? { error: { name: thrown.name, code: thrown.code, message: thrown.message } } : result,
      state: afterState, fullState: afterFullState, tree: afterTree, segments: afterSegments, repeat, restart,
      beforeTree, durableTree: durableTree(afterTree), temporaryProjection: temporaryProjection(afterTree),
      io: measuredIo, temporaryFiles: Object.keys(afterTree).filter((path) => !Object.hasOwn(beforeTree, path)),
    };
  } finally { activeFault = null; if (suppliedHome === null) await rm(home, { recursive: true, force: true }); }
}

function median(values) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; }
const traceVariant = process.env.BENCH_TRACE_VARIANT;
if (traceVariant) {
  const MemoryClass = traceVariant === 'baseline' ? BaselineMemory : traceVariant === 'batched' ? BatchedMemory : null;
  assert.ok(MemoryClass, 'BENCH_TRACE_VARIANT must be baseline or batched');
  const coldRows = Number(process.env.BENCH_COLD_ROWS ?? 384);
  const rowsByCollection = fixtureRowsForColdCount(coldRows);
  const action = process.env.BENCH_ACTION ?? 'compact';
  const result = await execute(MemoryClass, { rowsByCollection, expectedColdRows: coldRows, payloadBytes: Number(process.env.BENCH_PAYLOAD_BYTES ?? 256), action, waitForTraceSignal: true });
  console.log(JSON.stringify({ traceVariant, result }, null, 2));
} else {
  const rounds = Number(process.env.BENCH_ROUNDS ?? 5);
  const coldRowsList = (process.env.BENCH_COLD_ROWS ?? '384,3072,12288').split(',').map(Number);
  const payloadBytes = Number(process.env.BENCH_PAYLOAD_BYTES ?? 256);
  const faultColdRows = Number(process.env.BENCH_FAULT_COLD_ROWS ?? 384);
  const data = { node: process.version, platform: `${process.platform}/${process.arch}`, rounds, payloadBytes,
    archiveMaxBytes: ARCHIVE_MAX_BYTES, absoluteMaxSegmentBytes: ABSOLUTE_MAX_SEGMENT_BYTES,
    hotEntries: 16, hotCycles: 16, maxEntries: 10_000,
    coldRows: coldRowsList, actions: ['compact', 'finalizeKnowledge'], results: [] };
  for (const coldRows of coldRowsList) for (const action of data.actions) {
    const rowsByCollection = fixtureRowsForColdCount(coldRows);
    const sides = { baseline: [], batched: [] };
    for (let round = 0; round < rounds; round++) {
      if (global.gc) global.gc();
      const order = round % 2 === 0 ? ['baseline', 'batched'] : ['batched', 'baseline'];
      const sharedHome = await mkdtemp(join(tmpdir(), 'dsh-archive-rewrite-ab-'));
      try {
        for (const side of order) {
          const MemoryClass = side === 'baseline' ? BaselineMemory : BatchedMemory;
          const sample = await execute(MemoryClass, { rowsByCollection, expectedColdRows: coldRows, payloadBytes, action, home: sharedHome });
          sides[side].push(sample);
        }
      } finally { await rm(sharedHome, { recursive: true, force: true }); }
      assert.equal(sides.baseline.at(-1).state, sides.batched.at(-1).state, `${action}/${coldRows}: state equivalence`);
      assert.equal(sides.baseline.at(-1).fullState, sides.batched.at(-1).fullState, `${action}/${coldRows}: complete fullSnapshot equivalence`);
      assert.deepEqual(sides.baseline.at(-1).tree, sides.batched.at(-1).tree, `${action}/${coldRows}: byte-for-byte persistent tree equivalence`);
      assert.deepEqual(sides.baseline.at(-1).segments, sides.batched.at(-1).segments, `${action}/${coldRows}: archive segment boundary equivalence`);
      assert.deepEqual(sides.baseline.at(-1).result, sides.batched.at(-1).result, `${action}/${coldRows}: public return value equivalence`);
      assert.equal(sides.baseline.at(-1).repeat.state, sides.batched.at(-1).repeat.state, `${action}/${coldRows}: repeated state equivalence`);
      assert.equal(sides.baseline.at(-1).repeat.fullState, sides.batched.at(-1).repeat.fullState, `${action}/${coldRows}: repeated complete fullSnapshot equivalence`);
      assert.deepEqual(sides.baseline.at(-1).repeat.tree, sides.batched.at(-1).repeat.tree, `${action}/${coldRows}: repeated persistent tree equivalence`);
      assert.deepEqual(sides.baseline.at(-1).repeat.segments, sides.batched.at(-1).repeat.segments, `${action}/${coldRows}: repeated segment boundary equivalence`);
      assert.deepEqual(sides.baseline.at(-1).repeat.result, sides.batched.at(-1).repeat.result, `${action}/${coldRows}: repeated public return value equivalence`);
      assert.equal(sides.baseline.at(-1).repeat.archivedRows, sides.batched.at(-1).repeat.archivedRows, `${action}/${coldRows}: repeated archive record count equivalence`);
    }
    const summary = {};
    for (const side of ['baseline', 'batched']) {
      const samples = sides[side];
      summary[side] = {
        elapsedMs: median(samples.map((sample) => sample.elapsedMs)),
        rangeMs: [Math.min(...samples.map((sample) => sample.elapsedMs)), Math.max(...samples.map((sample) => sample.elapsedMs))],
        cpuMs: median(samples.map((sample) => sample.cpuMs)),
        cpuRangeMs: [Math.min(...samples.map((sample) => sample.cpuMs)), Math.max(...samples.map((sample) => sample.cpuMs))],
        writerCalls: Object.fromEntries(['appendFile', 'writeFile'].map((name) => [name, median(samples.map((sample) => sample.io[name].calls))])),
        writerElapsedMs: Object.fromEntries(['appendFile', 'writeFile'].map((name) => [name, median(samples.map((sample) => sample.io[name].elapsedMs))])),
        archiveWriteBytes: Object.fromEntries(['appendFile', 'writeFile'].map((name) => [name, median(samples.map((sample) => sample.io[name].bytes))])),
        appendFileShareOfEndpoint: median(samples.map((sample) => 100 * sample.io.appendFile.elapsedMs / sample.elapsedMs)),
        writerShareOfEndpoint: median(samples.map((sample) => 100 * (sample.io.appendFile.elapsedMs + sample.io.writeFile.elapsedMs) / sample.elapsedMs)),
      };
    }
    const pairs = sides.baseline.map((baseline, round) => {
      const batched = sides.batched[round];
      return {
        round: round + 1,
        order: round % 2 === 0 ? ['baseline', 'batched'] : ['batched', 'baseline'],
        baselineWallMs: baseline.elapsedMs,
        batchedWallMs: batched.elapsedMs,
        wallChangePct: 100 * (batched.elapsedMs / baseline.elapsedMs - 1),
        baselineCpuMs: baseline.cpuMs,
        batchedCpuMs: batched.cpuMs,
        cpuChangePct: 100 * (batched.cpuMs / baseline.cpuMs - 1),
      };
    });
    data.results.push({ rowsByCollection, coldRows, action, summary,
      pairs,
      samples: Object.fromEntries(Object.entries(sides).map(([side, values]) => [side, values.map(({ elapsedMs, cpuMs, io: counts, tree, state, fullState, result, repeat, segments }) => ({ elapsedMs, cpuMs, io: counts,
        stateSha256: createHash('sha256').update(state).digest('hex'), treeSha256: createHash('sha256').update(stable(tree)).digest('hex'),
        fullStateSha256: createHash('sha256').update(fullState).digest('hex'),
        resultSha256: createHash('sha256').update(stable(result)).digest('hex'), segments,
        repeatStateSha256: createHash('sha256').update(repeat.state).digest('hex'), repeatTreeSha256: createHash('sha256').update(stable(repeat.tree)).digest('hex'),
        repeatFullStateSha256: createHash('sha256').update(repeat.fullState).digest('hex'),
        repeatResultSha256: createHash('sha256').update(stable(repeat.result)).digest('hex'), repeatArchivedRows: repeat.archivedRows }))])) });
    console.log(JSON.stringify(data.results.at(-1)));
  }
  // A write failure is injected at the public write-guard boundary on both
  // implementations; it checks exception identity, restoration, cleanup and
  // restart without coupling the test to a particular batching call count.
  const faultRowsByCollection = fixtureRowsForColdCount(faultColdRows);
  for (const action of data.actions) for (const fault of ['temporary-write', 'partial-write', 'state-save']) {
    const failure = {};
    const sharedHome = await mkdtemp(join(tmpdir(), 'dsh-archive-rewrite-fault-ab-'));
    try {
      for (const [side, MemoryClass] of [['baseline', BaselineMemory], ['batched', BatchedMemory]]) {
        failure[side] = await execute(MemoryClass, { rowsByCollection: faultRowsByCollection, expectedColdRows: faultColdRows, payloadBytes, action,
          injectFailure: fault === 'temporary-write', injectPartialFailure: fault === 'partial-write',
          injectSaveFailure: fault === 'state-save', home: sharedHome });
      }
    } finally { await rm(sharedHome, { recursive: true, force: true }); }
    assert.equal(failure.baseline.result.error.code, failure.batched.result.error.code);
    assert.equal(failure.baseline.result.error.message, failure.batched.result.error.message);
    assert.equal(failure.baseline.state, failure.batched.state, `${action}/${fault}: failed in-memory state equivalence`);
    assert.equal(failure.baseline.fullState, failure.batched.fullState, `${action}/${fault}: failed complete fullSnapshot equivalence`);
    assert.deepEqual(failure.baseline.durableTree, failure.batched.durableTree, `${action}/${fault}: durable rollback bytes`);
    assert.deepEqual(failure.baseline.temporaryProjection, failure.batched.temporaryProjection, `${action}/${fault}: temporary file residue equivalence`);
    assert.deepEqual(failure.baseline.restart.state, failure.batched.restart.state, `${action}/${fault}: restart state equivalence`);
    assert.deepEqual(failure.baseline.restart.fullState, failure.batched.restart.fullState, `${action}/${fault}: restart complete fullSnapshot equivalence`);
    assert.deepEqual(durableTree(failure.baseline.restart.tree), durableTree(failure.batched.restart.tree), `${action}/${fault}: restart durable files`);
    assert.deepEqual(failure.baseline.restart.segments, failure.batched.restart.segments, `${action}/${fault}: restart segment boundaries`);
    if (fault === 'state-save') assert.equal(failure.batched.temporaryFiles.length, 0, `${action}: rollback must clean transaction artifacts`);
    data.results.push({ rowsByCollection: faultRowsByCollection, coldRows: faultColdRows, action, fault, failure: {
      baseline: failure.baseline.result.error, batched: failure.batched.result.error,
      inMemoryStateEqual: failure.baseline.state === failure.batched.state,
      fullStateEqual: failure.baseline.fullState === failure.batched.fullState,
      durableTreesEqual: stable(failure.baseline.durableTree) === stable(failure.batched.durableTree),
      temporaryProjectionEqual: stable(failure.baseline.temporaryProjection) === stable(failure.batched.temporaryProjection),
      restartStateEqual: failure.baseline.restart.state === failure.batched.restart.state,
      restartFullStateEqual: failure.baseline.restart.fullState === failure.batched.restart.fullState,
      durableTreeSha256: Object.fromEntries(['baseline', 'batched'].map((side) => [side, createHash('sha256').update(stable(failure[side].durableTree)).digest('hex')])),
      temporaryArtifacts: Object.fromEntries(['baseline', 'batched'].map((side) => [side, failure[side].temporaryProjection])),
      restartStateSha256: Object.fromEntries(['baseline', 'batched'].map((side) => [side, createHash('sha256').update(failure[side].restart.state).digest('hex')])),
      restartFullStateSha256: Object.fromEntries(['baseline', 'batched'].map((side) => [side, createHash('sha256').update(failure[side].restart.fullState).digest('hex')])),
      restartDurableTreeSha256: Object.fromEntries(['baseline', 'batched'].map((side) => [side, createHash('sha256').update(stable(durableTree(failure[side].restart.tree))).digest('hex')])),
      temporaryFilesLeft: { baseline: failure.baseline.temporaryFiles.length, batched: failure.batched.temporaryFiles.length },
    } });
  }
  const report = {
    baselineCommit: BASE_COMMIT,
    baselineSourceSha256: createHash('sha256').update(BASE_SOURCE).digest('hex'),
    candidateSourceSha256: createHash('sha256').update(SOURCE).digest('hex'),
    benchmarkScriptSha256: createHash('sha256').update(SCRIPT_SOURCE).digest('hex'),
    ...data,
  };
  if (process.env.BENCH_OUT) await originalWriteFile(join(ROOT, process.env.BENCH_OUT), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ summary: report }, null, 2));
}
for (const directory of tempModules) await rm(directory, { recursive: true, force: true });
