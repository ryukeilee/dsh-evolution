// Streaming-safe retention/compact A/B baseline with out-of-process RSS sampling.
//
// Why this exists: `retention-plan-cost.mjs` measures peaks with an in-process
// 2 ms timer, but `#retentionPlan()` is synchronous. docs/performance/
// retention-plan-cost.md section 4.3 records 0 interval callbacks in 72
// in-process probes and 36 out-of-process probes, so that "peak" is only
// max(RSS before, RSS after). This harness never uses an in-process timer as a
// peak:
//
//   * the template builder runs ONCE per scale using the baseline side's public
//     functions and writes the session's on-disk shape into a template directory
//     (state.json + one active archive per collection);
//   * every sample is a fresh child Node process: the parent copies the template
//     into a private root, the child imports the side's lib/, calls load(),
//     double-GCs, emits START on stdout and blocks on stdin. The child never
//     reads or parses the corpus JSON, so its start RSS is not inflated by the
//     fixture representation (the first protocol revision parsed a 6-52 MB JSON
//     fixture in the child and start RSS reached 155-553 MiB, hiding the planning
//     peak; see the protocol note in the generated report);
//   * the parent then spawns scripts/benchmarks/retention-rss-sampler.py, which
//     reads the child's RSS from outside its event loop (macOS
//     libproc.proc_pidinfo, Linux /proc/<pid>/statm) every ~2 ms;
//   * the parent writes `go` to both, the child runs exactly one
//     compact({dryRun:true}) or compact(), then emits END; the parent stops the
//     sampler and reads the sample result.
//
// The reported external peak is still a sampling lower bound; sample count and
// maximum gap are recorded with every sample. The template copy and the parent's
// pre-compact hash of the copied tree happen outside the measured window (after
// START, before go). `process.resourceUsage().maxRSS` is reported separately as
// a process-lifetime high-water mark and is never presented as the per-call peak.
//
// Sides: `--a` and `--b` accept `worktree` (this checkout's lib/), `git:<ref>`
// (or a bare git ref) extracted with `git archive <commit> lib`, or `dir:<path>`
// (a lib/ directory imported as-is). Default: `--a git:origin/main --b worktree`.
// `--runs aa,ab` (the default) runs BOTH an A/A pass (side A measured twice, to
// estimate noise) and an A/B pass, interleaved round by round so they share the
// same machine state.
//
// Template: one directory per scale, generated once by the baseline side's public
// knowledge functions (normalizeKnowledgeEvent + mergeKnowledgeEntry) and copied
// for every child. Its archive-tree sha256 and state sha256 are recorded. Corpus
// matches retention-plan-cost:
// 40% observations, 20% canonical knowledge accumulators, 20% cycles, 10%
// failed outcomes, 10% rejected promotions, with canonical pointers protecting
// a subset of outcomes.
//
// Schedule: for each (scale, phase), `--rounds` rounds alternate
// [A, B] / [B, A]; each side gets `--samples` fresh processes per round. AA and
// AB runs alternate their order across rounds. Defaults: --samples 3
// --rounds 2 (>= 3 samples/side/round, >= 2 rounds).
//
// Usage:
//   node scripts/benchmarks/retention-plan-streaming.mjs \
//     --a git:origin/main --b worktree --runs aa,ab \
//     --scales 10000,40000,80000 --samples 3 --rounds 2 \
//     --phases dryRun,write \
//     --out docs/performance/retention-plan-streaming-baseline.json \
//     --md docs/performance/retention-plan-streaming-baseline.md
//
// Exit code is non-zero when any cell's cross-sample equivalence check fails
// (report / full state / archive bytes / dry-run zero-write / idempotency) or a
// template-invariant assertion fails, unless --allow-mismatch is passed; the JSON
// is still written first so raw evidence is never lost.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, loadavg, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import v8 from 'node:v8';
import { readSync, writeSync } from 'node:fs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SAMPLER = fileURLToPath(new URL('./retention-rss-sampler.py', import.meta.url));
const SCRIPT = fileURLToPath(import.meta.url);
const NOW = '2026-10-12T00:00:00.000Z';
const ARGS = process.argv.slice(2);
const MIB = 1024 * 1024;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const project = (value) => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------
// Shared measurement helpers (used by both the parent and the child modes).
// ---------------------------------------------------------------------------

function parseChildArgs(args) {
  const options = { mode: null, idempotency: false };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--child' || key === '--build-template') { options.mode = key.slice(2); continue; }
    if (key === '--idempotency') { options.idempotency = true; continue; }
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${key} in child invocation`);
    options[key.slice(2)] = value;
  }
  return options;
}

function freezeClock() {
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return RealDate.parse(NOW); }
  }
  globalThis.Date = FrozenDate;
  return () => { globalThis.Date = RealDate; };
}

// Build the input ONCE with the baseline side's public functions, then give
// every side the exact same bytes. A variant's knowledge functions must not
// define its own fixture.
function corpus(scale, knowledge) {
  const counts = { observations: Math.floor(scale * 0.4), knowledge: Math.floor(scale * 0.2), cycles: Math.floor(scale * 0.2), outcomes: Math.floor(scale * 0.1) };
  counts.promotions = scale - Object.values(counts).reduce((sum, value) => sum + value, 0);
  const rows = {};
  rows.observations = Array.from({ length: counts.observations }, (_, index) => index % 2 === 0 ? {
    id: `info-${index}`, type: 'component/observation', severity: 'info', status: 'observed', recordedAt: NOW,
    metrics: { usageCount: index + 1 },
  } : {
    id: `diagnostic-${index}`, type: 'tool/error', severity: 'error', status: 'measured',
    componentId: `plugin:diagnostic-${Math.floor(index / 16)}`, rootCause: 'synthetic retry timeout',
    errorCode: 'BENCH_DIAGNOSTIC', message: 'synthetic diagnostic only', recordedAt: NOW,
  });
  rows.knowledge = Array.from({ length: counts.knowledge }, (_, index) => {
    const source = { id: `seed-${index}`, issueType: 'performance', rootCause: 'synthetic warmup delay',
      strategy: 'bounded retry', componentId: `plugin:seed-${index}`, status: 'success', recordedAt: NOW,
      metrics: { latency: index % 9 + 1 } };
    const event = knowledge.normalizeKnowledgeEvent(source, { sourceCollection: 'observations', now: new Date(NOW) });
    return { ...knowledge.mergeKnowledgeEntry(null, event, { now: new Date(NOW) }), dimensions: event.dimensions };
  });
  rows.cycles = Array.from({ length: counts.cycles }, (_, index) => ({ id: `cycle-${index}`, status: 'observed',
    startedAt: NOW, endedAt: NOW, recordedAt: NOW, observations: [{ id: `info-${index * 2}` }], stages: [{ stage: 'observe' }] }));
  for (const collection of ['outcomes', 'promotions']) rows[collection] = Array.from({ length: counts[collection] }, (_, index) => ({
    id: `${collection}-${index}`, status: collection === 'outcomes' ? 'failed' : 'rejected',
    lifecycleState: collection === 'outcomes' ? 'FAILED' : 'REJECTED',
    componentId: `plugin:${collection}-${Math.floor(index / 8)}`, rootCause: 'synthetic terminal failure', recordedAt: NOW,
  }));
  // Protect outcomes only: hot terminal promotions are separately tombstoned by
  // housekeeping even when a canonical pointer exists, outside retention's
  // protection rule. That corpus is not a one-pass compact fixed point in HEAD.
  const canonical = ['outcomes'].flatMap((collection) => rows[collection].filter((_, index) => index % 16 === 0).map((row, index) => ({
    id: `canonical-${row.id}`, state: 'CANONICAL', lifecycleState: 'CANONICAL', sourceCollection: collection,
    capability: `protected:${collection}-${index}`, recordId: row.id, fitnessScore: 1, updatedAt: NOW,
  })));
  return { counts, canonical, files: Object.fromEntries(Object.entries(rows).map(([name, values]) =>
    [name, values.map((row) => JSON.stringify(row)).join('\n') + '\n'])) };
}

// Write the on-disk shape a loaded session starts from: one state document plus
// one active archive file per collection. The template builder does this ONCE per
// scale; measured children only ever copy it, so they never parse the corpus JSON
// (that parse was raising start RSS above the planning peak in the first
// protocol revision - see the protocol note in the generated report).
async function writeTemplate(directory, fixture) {
  await mkdir(directory, { recursive: true });
  const stateFile = join(directory, 'state.json');
  await writeFile(stateFile, JSON.stringify({ evolution: { canonical: fixture.canonical } }));
  for (const [collection, bytes] of Object.entries(fixture.files)) await writeFile(`${stateFile}.${collection}-archive.jsonl`, bytes);
}

// A minimal real file-backed state port; all retention/archive logic remains
// inside the imported EvolutionMemory. No official host transaction is timed.
function stateStore(filePath) {
  return {
    filePath,
    async load() { return JSON.parse(await readFile(filePath, 'utf8')); },
    async update(change) {
      await writeFile(filePath + '.tmp', JSON.stringify(change(await this.load())));
      await rename(filePath + '.tmp', filePath);
    },
  };
}

async function archiveTree(root) {
  const files = [];
  async function walk(path, prefix = '') {
    for (const item of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + item.name;
      if (item.isDirectory()) await walk(join(path, item.name), name + '/');
      else if (item.isFile() && name !== 'state.json') {
        const bytes = await readFile(join(path, item.name));
        files.push({ file: name, bytes: bytes.length, sha256: sha256(bytes) });
      }
    }
  }
  await walk(root);
  return { files, fileCount: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), sha256: sha256(JSON.stringify(files)) };
}

function treeSha256(files) { return sha256(JSON.stringify(files)); }

async function walkLib(directory) {
  const files = [];
  async function walk(path, prefix = '') {
    for (const item of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + item.name;
      if (item.isDirectory()) await walk(join(path, item.name), name + '/');
      else if (item.isFile()) files.push({ file: name, sha256: sha256(await readFile(join(path, item.name))) });
      else throw new Error(`unsupported lib entry ${name}`);
    }
  }
  await walk(directory);
  return files;
}

// ---------------------------------------------------------------------------
// Child modes: template builder and one measured sample.
// ---------------------------------------------------------------------------

async function buildTemplateChild(options) {
  freezeClock();
  const knowledge = await import(pathToFileURL(join(options.lib, 'dockyard-domain/knowledge.js')).href);
  const fixture = corpus(Number(options.scale), knowledge);
  const directory = options.out;
  await rm(directory, { recursive: true, force: true });
  await writeTemplate(directory, fixture);
  const stateFile = join(directory, 'state.json');
  const stateBytes = await readFile(stateFile);
  const archive = await archiveTree(directory);
  writeSync(1, JSON.stringify({
    ok: true, scale: Number(options.scale), counts: fixture.counts, canonical: fixture.canonical.length,
    files: archive.files, fileCount: archive.fileCount, bytes: archive.bytes, sha256: archive.sha256,
    stateFile: { bytes: stateBytes.length, sha256: sha256(stateBytes) },
  }) + '\n');
}

async function measuredChild(options) {
  freezeClock();
  const { EvolutionMemory } = await import(pathToFileURL(join(options.lib, 'dockyard-domain/memory.js')).href);
  const root = options.root;
  const stateFile = join(root, 'state.json');
  const memory = new EvolutionMemory({ stateStore: stateStore(stateFile), clock: () => new Date(NOW),
    maxEntries: 1000, hotEntries: 50, hotCycles: 50, archiveMaxBytes: 256 * 1024,
    mutationAuthority: { assertMutation() {} } });
  await memory.load();
  // fullSnapshot() embeds the state file's absolute path in coldArchives. Each
  // sample gets its own root directory, so normalize that path before hashing:
  // the hash must compare state content, not where the fixture was copied to.
  const stateHash = (snapshot) => sha256(JSON.stringify(project(snapshot)).split(root).join('<STATE_ROOT>'));
  // Two GCs so a first-call collection cycle does not leave the start reading
  // dominated by the load's own transient allocations.
  global.gc(); global.gc();
  const before = process.memoryUsage();
  const maxRssBeforeBytes = process.resourceUsage().maxRSS * 1024;
  writeSync(1, JSON.stringify({ start: true, before, maxRssBeforeBytes, heapLimitBytes: v8.getHeapStatistics().heap_size_limit }) + '\n');
  readSync(0, Buffer.alloc(1), 0, 1, null);
  let report = null;
  let failure = null;
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  try {
    report = await memory.compact(options.phase === 'dryRun' ? { dryRun: true } : {});
  } catch (error) {
    failure = error;
  }
  const wallMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  const maxRssAfterBytes = process.resourceUsage().maxRSS * 1024;
  const endpoint = process.memoryUsage();
  writeSync(1, JSON.stringify({ end: true }) + '\n');
  if (failure) {
    writeSync(1, JSON.stringify({ ok: false, error: failure?.message ?? String(failure), stack: failure?.stack ?? null }) + '\n');
    await rm(root, { recursive: true, force: true });
    process.exitCode = 1;
    return;
  }
  global.gc(); global.gc();
  const afterGc = process.memoryUsage();
  const stateFileSha256After = sha256(await readFile(stateFile));
  const stateAfterSha256 = stateHash(memory.fullSnapshot());
  const archiveAfter = await archiveTree(root);
  const result = {
    ok: true, label: options.label, scale: Number(options.scale), phase: options.phase,
    execArgv: process.execArgv, node: process.version,
    before: { rss: before.rss, heapUsed: before.heapUsed, heapTotal: before.heapTotal, external: before.external, arrayBuffers: before.arrayBuffers },
    endpoint: { rss: endpoint.rss, heapUsed: endpoint.heapUsed, heapTotal: endpoint.heapTotal, external: endpoint.external, arrayBuffers: endpoint.arrayBuffers },
    afterGc: { rss: afterGc.rss, heapUsed: afterGc.heapUsed, heapTotal: afterGc.heapTotal, external: afterGc.external, arrayBuffers: afterGc.arrayBuffers },
    maxRssBeforeBytes, maxRssAfterBytes, heapLimitBytes: v8.getHeapStatistics().heap_size_limit,
    wallMs, cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000,
    stateFileSha256After, stateAfterSha256, archiveAfter,
    report: project(report), reportSha256: sha256(JSON.stringify(project(report))),
    secondReport: null, secondReportSha256: null, secondStateSha256: null, secondArchiveSha256: null, idempotent: null,
  };
  if (options.phase !== 'dryRun' && options.idempotency) {
    let secondFailure = null;
    try {
      result.secondReport = project(await memory.compact());
    } catch (error) {
      secondFailure = error;
    }
    if (secondFailure) {
      result.secondReport = { error: secondFailure?.message ?? String(secondFailure) };
    } else {
      result.secondReportSha256 = sha256(JSON.stringify(result.secondReport));
      result.secondStateFileSha256 = sha256(await readFile(stateFile));
      result.secondStateSha256 = stateHash(memory.fullSnapshot());
      result.secondArchiveSha256 = (await archiveTree(root)).sha256;
      result.idempotent = result.secondStateSha256 === stateAfterSha256
        && result.secondStateFileSha256 === stateFileSha256After
        && result.secondArchiveSha256 === archiveAfter.sha256;
    }
  }
  writeSync(1, JSON.stringify(result) + '\n');
  await rm(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Parent-side helpers.
// ---------------------------------------------------------------------------

class LineQueue {
  constructor(stream, name) {
    this.name = name;
    this.lines = [];
    this.waiters = [];
    this.closed = false;
    this.error = null;
    this.buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        this.#push(this.buffer.slice(0, index));
        this.buffer = this.buffer.slice(index + 1);
      }
    });
    stream.on('end', () => {
      this.closed = true;
      if (this.buffer.length) { this.#push(this.buffer); this.buffer = ''; }
      this.#failWaiters(new Error(`${this.name}: stream closed before the next line`));
    });
    stream.on('error', (error) => { this.error = error; this.closed = true; this.#failWaiters(error); });
  }

  #push(line) {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(line);
    else this.lines.push(line);
  }

  #failWaiters(error) {
    while (this.waiters.length) this.waiters.shift().reject(error);
  }

  next(timeoutMs, what) {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    if (this.error) return Promise.reject(this.error);
    if (this.closed) return Promise.reject(new Error(`${this.name}: stream closed before ${what}`));
    return new Promise((resolveLine, rejectLine) => {
      const waiter = { resolve: null, reject: null, timer: null };
      waiter.resolve = (line) => { clearTimeout(waiter.timer); resolveLine(line); };
      waiter.reject = (error) => { clearTimeout(waiter.timer); rejectLine(error); };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        rejectLine(new Error(`${this.name}: timeout after ${timeoutMs}ms waiting for ${what}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

function waitExit(child) {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) resolveExit({ code: child.exitCode, signal: child.signalCode });
    else child.on('close', (code, signal) => resolveExit({ code, signal }));
  });
}

function killQuietly(child) {
  try { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch { /* already gone */ }
}

function loadAverage() { return loadavg().map((value) => Number(value.toFixed(3))); }

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function unique(values) { return [...new Set(values)]; }

function percentDelta(from, to) {
  if (from === null || to === null || from === 0) return null;
  return ((to - from) / from) * 100;
}

async function resolveSide(spec, label, workRoot) {
  if (spec === 'worktree' || spec === 'repo') {
    const directory = join(REPO, 'lib');
    const files = await walkLib(directory);
    return { label, spec, kind: 'worktree', libDirectory: directory, resolvedCommit: null, files, treeSha256: treeSha256(files) };
  }
  if (spec.startsWith('dir:')) {
    const directory = resolve(REPO, spec.slice(4));
    const files = await walkLib(directory);
    return { label, spec, kind: 'directory', libDirectory: directory, resolvedCommit: null, files, treeSha256: treeSha256(files) };
  }
  const ref = spec.startsWith('git:') ? spec.slice(4) : spec;
  const commit = execFileSync('git', ['rev-parse', `${ref}^{commit}`], { cwd: REPO, encoding: 'utf8' }).trim();
  const directory = join(workRoot, 'sides', label);
  await mkdir(directory, { recursive: true });
  const tar = execFileSync('git', ['archive', commit, 'lib'], { cwd: REPO, maxBuffer: 128 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', directory], { input: tar });
  await writeFile(join(directory, 'package.json'), '{"type":"module"}\n');
  const libDirectory = join(directory, 'lib');
  const files = await walkLib(libDirectory);
  return { label, spec, kind: 'git', resolvedCommit: commit, libDirectory, files, treeSha256: treeSha256(files) };
}

const CHILD_TIMEOUT_DEFAULTS = { setupMs: 180_000, compactMs: 600_000, samplerReadyMs: 30_000, samplerResultMs: 30_000, resultMs: 120_000 };

async function buildTemplate(scale, side, temporary) {
  const directory = join(temporary, 'templates', `template-${scale}`);
  const child = spawn(process.execPath, [SCRIPT, '--build-template', '--lib', side.libDirectory, '--scale', String(scale), '--out', directory], {
    stdio: ['ignore', 'pipe', 'pipe'], env: childEnvironment(),
  });
  const lines = new LineQueue(child.stdout, `template-builder[${scale}]`);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    const line = await lines.next(CHILD_TIMEOUT_DEFAULTS.setupMs, `template ${scale}`);
    const parsed = JSON.parse(line);
    if (!parsed.ok) throw new Error(`template builder failed: ${parsed.error ?? line}`);
    const archive = await archiveTree(directory);
    const stateBytes = await readFile(join(directory, 'state.json'));
    assert.equal(archive.sha256, parsed.sha256, `scale=${scale}: template archive sha256 mismatch on disk`);
    assert.equal(archive.bytes, parsed.bytes, `scale=${scale}: template byte length mismatch on disk`);
    assert.equal(archive.fileCount, parsed.fileCount, `scale=${scale}: template file count mismatch on disk`);
    assert.equal(sha256(stateBytes), parsed.stateFile.sha256, `scale=${scale}: template state sha256 mismatch on disk`);
    const exit = await waitExit(child);
    assert.equal(exit.code, 0, `scale=${scale}: template builder exited ${exit.code} ${stderr}`.trim());
    return {
      scale, directory, files: archive.files, fileCount: archive.fileCount, bytes: archive.bytes, sha256: archive.sha256,
      stateFile: { bytes: stateBytes.length, sha256: sha256(stateBytes) },
      counts: parsed.counts, canonical: parsed.canonical,
    };
  } finally {
    killQuietly(child);
  }
}

function childEnvironment() {
  const environment = { ...process.env };
  // Keep the child's heap flags under this harness' control and out of an
  // inherited NODE_OPTIONS; the exact flags are recorded per sample.
  delete environment.NODE_OPTIONS;
  return environment;
}

async function runSample({ def, side, phase, scale, template, round, sampleIndex, order, position, idempotency, temporary, options, sampleCounter }) {
  const root = join(temporary, 'runs', `sample-${sampleCounter}-${def.kind}-${scale}-${phase}-r${round}-s${sampleIndex}-${position}`);
  // The template is copied by the parent; the copy is outside the measured
  // window and keeps the child from ever parsing the corpus JSON.
  await cp(template.directory, root, { recursive: true });
  const nodeFlags = ['--expose-gc', ...(options.pinnedHeap ? ['--max-semi-space-size=16', '--max-old-space-size=1024'] : [])];
  const childArgs = [...nodeFlags, SCRIPT, '--child', '--lib', side.libDirectory,
    '--phase', phase, '--root', root, '--label', side.label, '--scale', String(scale)];
  if (idempotency) childArgs.push('--idempotency');
  const startedAt = new Date().toISOString();
  const child = spawn(process.execPath, childArgs, { stdio: ['pipe', 'pipe', 'pipe'], env: childEnvironment() });
  child.stdin.on('error', () => { /* child may exit before the go byte is delivered */ });
  const lines = new LineQueue(child.stdout, `child[${side.label} ${scale} ${phase}]`);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  let sampler = null;
  let samplerLines = null;
  try {
    const startLine = JSON.parse(await lines.next(CHILD_TIMEOUT_DEFAULTS.setupMs, 'child START'));
    assert.equal(startLine.start, true, `child did not report START: ${JSON.stringify(startLine)}`);
    // Hash the on-disk pre-compact state while the child is blocked on stdin:
    // this is a parent-side read, it cannot raise the child's RSS, and it is
    // outside the go-to-END window.
    const stateBeforeSha256 = sha256(await readFile(join(root, 'state.json')));
    const archiveBefore = await archiveTree(root);
    sampler = spawn(options.python, [SAMPLER, '--pid', String(child.pid), '--interval-ms', String(options.intervalMs)], { stdio: ['pipe', 'pipe', 'pipe'] });
    sampler.stdin.on('error', () => { /* sampler may exit before go/stop are delivered */ });
    samplerLines = new LineQueue(sampler.stdout, `sampler[${side.label} ${scale} ${phase}]`);
    let samplerStderr = '';
    sampler.stderr.on('data', (chunk) => { samplerStderr += chunk; });
    const readyLine = JSON.parse(await samplerLines.next(CHILD_TIMEOUT_DEFAULTS.samplerReadyMs, 'sampler ready'));
    if (!readyLine.ready) throw new Error(`external RSS sampler failed to start: ${readyLine.error ?? 'unknown'} ${samplerStderr}`.trim());
    const loadAverageBefore = loadAverage();
    const goAt = performance.now();
    child.stdin.write('g');
    sampler.stdin.write('go\n');
    const endLine = JSON.parse(await lines.next(options.compactTimeoutMs ?? CHILD_TIMEOUT_DEFAULTS.compactMs, 'child END'));
    assert.equal(endLine.end, true, `child did not report END: ${JSON.stringify(endLine)}`);
    const goToEndMs = performance.now() - goAt;
    sampler.stdin.write('stop\n');
    const samplerResult = JSON.parse(await samplerLines.next(CHILD_TIMEOUT_DEFAULTS.samplerResultMs, 'sampler result'));
    const samplerExit = await waitExit(sampler);
    sampler = null;
    if (samplerExit.code !== 0) throw new Error(`external RSS sampler exited ${samplerExit.code}: ${samplerStderr}`);
    const resultLine = JSON.parse(await lines.next(CHILD_TIMEOUT_DEFAULTS.resultMs, 'child result'));
    const childExit = await waitExit(child);
    if (!resultLine.ok) throw new Error(`child failed during compact: ${resultLine.error} ${stderr}`.trim());
    assert.equal(childExit.code, 0, `child exited ${childExit.code}: ${stderr}`.trim());
    const endpoint = resultLine.endpoint ?? {};
    const before = resultLine.before ?? {};
    if (samplerResult.error) throw new Error(`external RSS sampling failed: ${samplerResult.error}`);
    const dryRunUnchanged = phase === 'dryRun'
      ? (resultLine.stateFileSha256After === stateBeforeSha256 && resultLine.archiveAfter.sha256 === archiveBefore.sha256)
      : null;
    const metrics = {
      wallMs: resultLine.wallMs,
      cpuUserMs: resultLine.cpuUserMs,
      cpuSystemMs: resultLine.cpuSystemMs,
      cpuTotalMs: resultLine.cpuUserMs + resultLine.cpuSystemMs,
      rssBaselineBytes: before.rss,
      heapUsedBaselineBytes: before.heapUsed,
      heapTotalBaselineBytes: before.heapTotal,
      rssEndpointBytes: endpoint.rss,
      heapUsedEndpointBytes: endpoint.heapUsed,
      heapTotalEndpointBytes: endpoint.heapTotal,
      rssAfterGcBytes: resultLine.afterGc.rss,
      heapUsedAfterGcBytes: resultLine.afterGc.heapUsed,
      heapAllocationDeltaBytes: endpoint.heapUsed - before.heapUsed,
      heapAfterGcDeltaBytes: resultLine.afterGc.heapUsed - before.heapUsed,
      maxRssBeforeBytes: resultLine.maxRssBeforeBytes,
      maxRssAfterBytes: resultLine.maxRssAfterBytes,
      maxRssDeltaBytes: resultLine.maxRssAfterBytes - resultLine.maxRssBeforeBytes,
      heapLimitBytes: resultLine.heapLimitBytes,
      externalPeakRssBytes: samplerResult.peakBytes,
      externalBaselineRssBytes: samplerResult.baselineBytes,
      externalRssDeltaBytes: samplerResult.deltaBytes,
      externalSampleCount: samplerResult.sampleCount,
      externalMaxGapMs: samplerResult.maxGapMs,
      externalFirstSampleMs: samplerResult.firstSampleMs,
      externalLastSampleMs: samplerResult.lastSampleMs,
      archiveBeforeBytes: archiveBefore.bytes,
      archiveAfterBytes: resultLine.archiveAfter.bytes,
      archiveDeltaBytes: resultLine.archiveAfter.bytes - archiveBefore.bytes,
      archiveBeforeFileCount: archiveBefore.fileCount,
      archiveAfterFileCount: resultLine.archiveAfter.fileCount,
    };
    return {
      run: def.kind, scale, phase, round, sample: sampleIndex, side: side.label, sideIndex: position, order,
      startedAt, loadAverage: loadAverageBefore, parentGoToEndMs: goToEndMs,
      nodeFlags, childPid: child.pid, templateSha256: template.sha256,
      sampler: { method: samplerResult.method, intervalMs: samplerResult.intervalMs, sampleCount: samplerResult.sampleCount,
        baselineBytes: samplerResult.baselineBytes, peakBytes: samplerResult.peakBytes, deltaBytes: samplerResult.deltaBytes,
        maxGapMs: samplerResult.maxGapMs, firstSampleMs: samplerResult.firstSampleMs, lastSampleMs: samplerResult.lastSampleMs },
      metrics,
      report: resultLine.report,
      reportSha256: resultLine.reportSha256,
      stateBeforeSha256,
      stateFileSha256Before: stateBeforeSha256,
      stateFileSha256After: resultLine.stateFileSha256After,
      stateAfterSha256: resultLine.stateAfterSha256,
      archiveBefore,
      archiveAfter: resultLine.archiveAfter,
      dryRunUnchanged,
      idempotent: resultLine.idempotent,
      secondReport: resultLine.secondReport,
      secondReportSha256: resultLine.secondReportSha256,
      secondStateSha256: resultLine.secondStateSha256,
      secondArchiveSha256: resultLine.secondArchiveSha256,
    };
  } catch (error) {
    killQuietly(sampler);
    killQuietly(child);
    const tail = stderr.trim().split('\n').slice(-8).join('\n');
    throw new Error(`${def.kind}/${scale}/${phase}/round=${round}/sample=${sampleIndex}/${side.label}: ${error.message}${tail ? `\nstderr:\n${tail}` : ''}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Cells, medians and comparisons.
// ---------------------------------------------------------------------------

const METRICS = [
  { key: 'wallMs', label: 'wall', unit: 'ms' },
  { key: 'cpuTotalMs', label: 'CPU user+system', unit: 'ms' },
  { key: 'cpuUserMs', label: 'CPU user', unit: 'ms' },
  { key: 'cpuSystemMs', label: 'CPU system', unit: 'ms' },
  { key: 'externalPeakRssBytes', label: '外部采样峰值 RSS', unit: 'mib' },
  { key: 'externalBaselineRssBytes', label: '外部采样开始 RSS', unit: 'mib' },
  { key: 'externalRssDeltaBytes', label: '外部采样峰值−开始', unit: 'mib' },
  { key: 'rssEndpointBytes', label: 'compact 结束时 RSS（进程内）', unit: 'mib' },
  { key: 'maxRssBeforeBytes', label: 'maxRSS 前（历史高水位）', unit: 'mib' },
  { key: 'maxRssAfterBytes', label: 'maxRSS 后（历史高水位）', unit: 'mib' },
  { key: 'maxRssDeltaBytes', label: 'maxRSS 增量（高水位下界）', unit: 'mib' },
  { key: 'heapUsedBaselineBytes', label: 'GC 后 heapUsed（开始）', unit: 'mib' },
  { key: 'heapUsedEndpointBytes', label: 'compact 结束时 heapUsed', unit: 'mib' },
  { key: 'heapUsedAfterGcBytes', label: 'compact 后 GC heapUsed', unit: 'mib' },
  { key: 'heapAllocationDeltaBytes', label: 'heapUsed 增量（结束−开始）', unit: 'mib' },
  { key: 'archiveBeforeBytes', label: 'archive 字节（前）', unit: 'mib' },
  { key: 'archiveAfterBytes', label: 'archive 字节（后）', unit: 'mib' },
  { key: 'archiveAfterFileCount', label: '归档树文件数（后）', unit: 'count' },
  { key: 'externalSampleCount', label: '外部采样样本数', unit: 'count' },
  { key: 'externalMaxGapMs', label: '外部采样最大间隔', unit: 'ms' },
];
const METRIC_KEYS = METRICS.map((metric) => metric.key);

function summarizeSide(rows) {
  const medians = {};
  for (const key of METRIC_KEYS) medians[key] = median(rows.map((row) => row.metrics[key]));
  return medians;
}

function summarizeRounds(rows, rounds) {
  const perRound = [];
  for (let round = 0; round < rounds; round += 1) {
    const roundRows = rows.filter((row) => row.round === round);
    perRound.push(Object.fromEntries([...new Set(rows.map((row) => row.side))].map((side) => [side, summarizeSide(roundRows.filter((row) => row.side === side))])));
  }
  return perRound;
}

function compareMedians(medians, fromLabel, toLabel) {
  const metrics = {};
  for (const key of METRIC_KEYS) {
    const from = medians[fromLabel]?.[key] ?? null;
    const to = medians[toLabel]?.[key] ?? null;
    metrics[key] = { from, to, absolute: from === null || to === null ? null : to - from, percent: percentDelta(from, to) };
  }
  return { from: fromLabel, to: toLabel, metrics };
}

function evaluateCell(cell) {
  const { rows, phase } = cell;
  const sideLabels = cell.sides;
  const medians = Object.fromEntries(sideLabels.map((label) => [label, summarizeSide(rows.filter((row) => row.side === label))]));
  const reports = unique(rows.map((row) => row.reportSha256));
  const states = unique(rows.map((row) => row.stateAfterSha256));
  const archiveBefore = unique(rows.map((row) => row.archiveBefore.sha256));
  const archives = unique(rows.map((row) => row.archiveAfter.sha256));
  const seconds = unique(rows.filter((row) => row.secondReportSha256).map((row) => row.secondReportSha256));
  const dryRunUnchanged = phase === 'dryRun' ? rows.every((row) => row.dryRunUnchanged === true) : null;
  const idempotentSamples = rows.filter((row) => row.idempotent !== null);
  const idempotent = phase === 'write' && idempotentSamples.length ? idempotentSamples.every((row) => row.idempotent === true) : null;
  const exercise = phase === 'write'
    ? { retired: rows[0].report.retired > 0, consolidated: rows[0].report.consolidated > 0, aggregatedObservations: rows[0].report.aggregatedObservations > 0 }
    : null;
  const violations = [];
  if (reports.length !== 1) violations.push(`report sha256 has ${reports.length} distinct values`);
  if (states.length !== 1) violations.push(`post-compact full state sha256 has ${states.length} distinct values`);
  if (archiveBefore.length !== 1) violations.push(`pre-compact archive sha256 has ${archiveBefore.length} distinct values`);
  if (archives.length !== 1) violations.push(`post-compact archive sha256 has ${archives.length} distinct values`);
  if (phase === 'dryRun' && dryRunUnchanged !== true) violations.push('dry run changed state or archive bytes');
  if (phase === 'write' && idempotentSamples.length === 0) violations.push('no idempotency sample was taken');
  if (idempotent === false) violations.push('second compact was not a fixed point');
  if (seconds.length > 1) violations.push(`second compact report sha256 has ${seconds.length} distinct values`);
  if (exercise && !Object.values(exercise).every(Boolean)) violations.push(`template does not exercise the write path: ${JSON.stringify(exercise)}`);
  return {
    sides: sideLabels,
    medians,
    perRoundMedians: summarizeRounds(rows, cell.rounds),
    comparison: compareMedians(medians, sideLabels[0], sideLabels[1]),
    equivalence: {
      reportSha256: reports, stateAfterSha256: states, archiveBeforeSha256: archiveBefore, archiveAfterSha256: archives,
      secondReportSha256: seconds, dryRunUnchanged, idempotent, exercise, ok: violations.length === 0, violations,
    },
  };
}

// ---------------------------------------------------------------------------
// Option parsing.
// ---------------------------------------------------------------------------

function parseOptions(args) {
  const options = {
    a: 'git:origin/main', b: 'worktree', labelA: null, labelB: null,
    runs: ['aa', 'ab'], scales: [10000, 40000, 80000], samples: 3, rounds: 2,
    phases: ['dryRun', 'write'], out: null, md: null, json: false,
    intervalMs: 2, compactTimeoutMs: null, pinnedHeap: false, idempotency: 'first',
    allowMismatch: false, note: null, python: process.env.PYTHON ?? 'python3',
  };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--json') { options.json = true; continue; }
    if (key === '--pinned-heap') { options.pinnedHeap = true; continue; }
    if (key === '--allow-mismatch') { options.allowMismatch = true; continue; }
    if (key === '--help') {
      console.log([
        'Usage: node scripts/benchmarks/retention-plan-streaming.mjs [options]',
        '  --a <spec> --b <spec>        sides: worktree | git:<ref> | dir:<lib-dir> (default git:origin/main vs worktree)',
        '  --label-a <name> --label-b <name>',
        '  --runs aa,ab                 aa = same ref both sides (noise); ab = A vs B (default aa,ab)',
        '  --scales 10000,40000,80000   total cold rows per template',
        '  --samples 3 --rounds 2       each side gets --samples fresh processes per round',
        '  --phases dryRun,write',
        '  --interval-ms 2              out-of-process RSS sampling interval',
        '  --idempotency first|all|none second-compact fixed-point check (write phase)',
        '  --pinned-heap                add --max-semi-space-size=16 --max-old-space-size=1024 to children',
        '  --compact-timeout-ms <n>     per-sample END timeout',
        '  --out <path> --md <path> --json --allow-mismatch',
        '  --note <text>                free-text note rendered at the top of the markdown report',
      ].join('\n'));
      return null;
    }
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${key}`);
    if (key === '--a') options.a = value;
    else if (key === '--b') options.b = value;
    else if (key === '--label-a') options.labelA = value;
    else if (key === '--label-b') options.labelB = value;
    else if (key === '--runs') options.runs = value.split(',').map((entry) => entry.trim()).filter(Boolean);
    else if (key === '--scales') options.scales = value.split(',').map(Number);
    else if (key === '--phases') options.phases = value.split(',').map((entry) => entry.trim()).filter(Boolean);
    else if (key === '--samples') options.samples = Number(value);
    else if (key === '--rounds') options.rounds = Number(value);
    else if (key === '--interval-ms') options.intervalMs = Number(value);
    else if (key === '--compact-timeout-ms') options.compactTimeoutMs = Number(value);
    else if (key === '--idempotency') options.idempotency = value;
    else if (key === '--note') options.note = value;
    else if (key === '--out') options.out = resolve(value);
    else if (key === '--md') options.md = resolve(value);
    else if (key === '--python') options.python = value;
    else throw new Error(`unknown option ${key}`);
  }
  if (!options.runs.length || options.runs.some((run) => !['aa', 'ab'].includes(run))) throw new Error('invalid --runs: expected aa and/or ab');
  if (!options.phases.length || options.phases.some((phase) => !['dryRun', 'write'].includes(phase))) throw new Error('invalid --phases: expected dryRun and/or write');
  if (!options.scales.length || options.scales.some((scale) => !Number.isSafeInteger(scale) || scale < 100)) throw new Error('invalid --scales: expected integers >= 100');
  if (!Number.isSafeInteger(options.samples) || options.samples < 1) throw new Error('invalid --samples');
  if (!Number.isSafeInteger(options.rounds) || options.rounds < 1) throw new Error('invalid --rounds');
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 0.2) throw new Error('invalid --interval-ms');
  if (!['first', 'all', 'none'].includes(options.idempotency)) throw new Error('invalid --idempotency');
  return options;
}

function defaultLabel(spec) {
  if (spec === 'worktree' || spec === 'repo') return 'worktree';
  if (spec.startsWith('dir:')) return `dir-${resolve(spec.slice(4)).split('/').filter(Boolean).pop() ?? 'lib'}`;
  const ref = spec.startsWith('git:') ? spec.slice(4) : spec;
  return ref.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'side';
}

// ---------------------------------------------------------------------------
// Markdown rendering.
// ---------------------------------------------------------------------------

function formatMetric(value, unit) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (unit === 'mib') return (value / MIB).toFixed(2);
  if (unit === 'ms') return value.toFixed(2);
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatSigned(value, unit) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const formatted = formatMetric(Math.abs(value), unit);
  if (value === 0) return `0.00${unit === 'ms' ? '' : ''}`;
  return `${value > 0 ? '+' : '−'}${formatted}`;
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}%`;
}

function renderMarkdown(output) {
  const lines = [];
  const push = (...entries) => lines.push(...entries);
  const allRows = output.runs.flatMap((run) => run.scales).flatMap((scale) => scale.cells).flatMap((cell) => cell.rows);
  const allTreesIdentical = output.runs.every((run) => run.treesIdentical);
  const loads = allRows.map((row) => row.loadAverage[0]).sort((a, b) => a - b);
  const sortedMedian = (values) => median(values);
  push('# retention/compact 进程外采样基线（A/A 与 A/B）', '');
  push(`生成时间：${output.generatedAt}；总耗时 ${(output.durationMs / 1000).toFixed(1)} s。`, '');
  push('本文件由 `scripts/benchmarks/retention-plan-streaming.mjs` 从同一份 JSON 自动生成；所有数值都是本轮实际测量，未引用历史数字。', '');
  push('## 0. 本轮用途', '');
  if (allTreesIdentical) {
    push('本轮所有 run 的两侧都解析为同一棵冻结的 lib 树（treeSha256 相同）：run=aa 的两侧是同一 ref 的两次独立解出，run=ab 同样只是第二次独立的 A/A 复制。因此**本文件只是基线与噪声，不含任何候选实现对比**；候选 A/B 将用同一脚本 `--b worktree`（或 `--b git:<ref>`）重跑并写到另一个文件（例如 `docs/performance/retention-plan-streaming-ab-<ref>.json`），不会覆盖本基线。第 9 节的 A/A 噪声就是判断候选差异是否超出噪声的下界。', '');
  } else if (!output.runs.some((run) => run.kind === 'aa')) {
    push('本轮只运行 A/B（`--runs` 不含 aa），两侧是不同代码树；本文件**没有本轮内的 A/A 噪声**。显著性判定采用同一协议、同一机器基线 `docs/performance/retention-plan-streaming-baseline.md` 第 9 节的 A/A 噪声作为参考下界（见第 10 节）。', '');
  } else {
    push('本轮包含不同代码树的两侧：A/A run 用于估计噪声，A/B run 用于候选对比。', '');
  }
  if (output.options.note) push('**本轮说明**：' + output.options.note, '');
  push('## 1. 环境', '');
  push('| 项 | 值 |', '| --- | --- |');
  for (const [key, value] of Object.entries(output.environment)) {
    if (key === 'loadAverageAtStart' || key === 'loadAverageAtEnd') push(`| ${key} | ${value.join(' / ')} |`);
    else if (key === 'python') push(`| python | ${value.command} ${value.version} |`);
    else push(`| ${key} | ${value} |`);
  }
  push('');
  push('## 2. 复现命令', '');
  const portable = [
    'node scripts/benchmarks/retention-plan-streaming.mjs',
    `--a ${output.options.a}`, `--b ${output.options.b}`,
    `--runs ${output.options.runs.join(',')}`,
    `--scales ${output.options.scales.join(',')}`,
    `--samples ${output.options.samples}`, `--rounds ${output.options.rounds}`,
    `--phases ${output.options.phases.join(',')}`,
    '--out docs/performance/retention-plan-streaming-baseline.json',
    '--md docs/performance/retention-plan-streaming-baseline.md',
  ].join(' ');
  push('从仓库根目录执行：', '', '```sh', portable, '```', '');
  push('本轮实际命令行（含本机绝对路径，仅作记录）：', '', '```', output.command, '```', '');
  push('原始逐样本行、每格中位数与等价性哈希都在 `docs/performance/retention-plan-streaming-baseline.json`；本 Markdown 只汇总。', '');
  push('## 3. 口径与边界', '');
  push(`- 测量范围：${output.scope}`);
  if (output.protocol) push(`- 协议：${output.protocol}`);
  push('- 每个样本是独立子进程：父进程把模板目录复制到私有 root → 子进程 load lib → `EvolutionMemory.load()`（只读小 state.json 与归档索引）→ 两次 GC → 发 START 并阻塞等待父进程 go → 只执行一次 compact → 发 END。模板复制、`load()` 与父进程在 START 之后、go 之前对副本做的 pre-compact 哈希都不在 go→END 窗口内。进程外 RSS 采样由 `scripts/benchmarks/retention-rss-sampler.py` 完成（macOS `libproc.proc_pidinfo`，Linux `/proc/<pid>/statm`，默认 2 ms），采样峰值仍是下界，样本数与最大间隔随每个样本记录。');
  push('- 起始 RSS 是 START 之后、go 之前由采样器读到的第一个值：它包含 `load()` 对 active archive 做的恢复扫描留下的常驻页（那是 load 的契约，不属于 compact）。因此本报告同时给“外部采样峰值”“峰值−开始”两列；判断峰值内存回归时以绝对峰值为准，峰值−开始用于看 compact 期间的新增足迹。');
  push('- `maxRSS` 是进程历史高水位：它可能被 `load()` 的归档扫描建立的更高水位遮蔽，因此只作为下界报告，绝不当作单次调用的峰值；主峰值口径是外部采样。');
  push('- 外部采样（`' + (output.environment.samplerMethod ?? 'unknown') + '`）读的是内核 resident 计数，它包含 V8 用 MADV_FREE_REUSABLE 标记过、尚未归还的页面；因此同一时刻它通常高于 `process.memoryUsage().rss`（后者不计这些页面）并接近 `resourceUsage().maxRSS`。所以本报告同时给绝对峰值与“峰值−阶段开始”的增量，不能把绝对峰值直接等同于单次调用新增的字节数。');
  push('- heapUsed 为 GC 后读数（`--expose-gc`）；`heapUsed 增量`是结束时读数减开始读数，不是总分配字节。');
  push('- 每个样本的 archive 前后字节、归档树文件数与 sha256 都记录在 JSON 原始行里；dryRun 要求状态与归档字节完全不变，write 阶段另做一次 compact 收敛检查（`--idempotency`）。');
  for (const limitation of output.limitations) push(`- ${limitation}`);
  push('');
  push('## 4. 侧与模板', '');
  push('| 侧 | spec | 类型 | commit | lib tree sha256 |', '| --- | --- | --- | --- | --- |');
  for (const side of output.sides) push(`| ${side.label} | \`${side.spec}\` | ${side.kind} | ${side.resolvedCommit ?? '—'} | \`${side.treeSha256}\` |`);
  push('');
  push('treesIdentical（A 与 B 的 lib 树哈希相同，此时 A/B 也是 A/A 复制）：' + output.runs.map((run) => `${run.kind}=${run.treesIdentical}`).join('，'));
  push('');
  push('模板 = `state.json`（canonical 指针 + 空 hot 集合）+ 每个 collection 一个 active archive 文件；由基线侧公开函数生成一次，每个样本由父进程复制。`state sha256` 是模板 state.json 的字节哈希，`archive sha256` 是归档树（文件名 + 每文件 sha256）的哈希。', '');
  push('| 规模（冷行） | 模板文件数 | 模板字节 | archive sha256 | state 字节 | state sha256 | observations | knowledge | cycles | outcomes | promotions | canonical |', '| ---: | ---: | ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const template of output.templates) push(`| ${template.scale} | ${template.fileCount} | ${template.bytes} | \`${template.sha256}\` | ${template.stateFile.bytes} | \`${template.stateFile.sha256}\` | ${template.counts.observations} | ${template.counts.knowledge} | ${template.counts.cycles} | ${template.counts.outcomes} | ${template.counts.promotions} | ${template.canonical} |`);
  push('');
  push('## 5. 调度与测量窗口 loadavg', '');
  push(`每个 (规模, 阶段) 内：${output.options.rounds} 轮，` + '偶数轮 `[A,B]`，奇数轮 `[B,A]`；每侧每轮 `' + output.options.samples + '` 个独立样本；AA 与 AB 两种 run 按轮交替先后。', '');
  push(`每样本测量窗口的 1m loadavg：最小 ${loads[0]?.toFixed(3) ?? '—'} / 中位 ${sortedMedian(loads)?.toFixed(3) ?? '—'} / 最大 ${loads.at(-1)?.toFixed(3) ?? '—'}。1m 均值会吸收本基准自身的子进程 spawn 与 2 ms 外部采样进程，因此它不是外部负载的独立证据；同一 (规模, 阶段) 的 A/A 与 A/B 两侧按轮交替，噪声估计覆盖了这一漂移。`, '');
  push('下表的 loadavg 是该 (规模, 阶段) 格开始/结束时的值（不是每轮值）；逐样本值在 JSON 的每一行里。', '');
  push('| run | 规模 | 阶段 | 轮 | order | 格起始 loadavg | 格结束 loadavg |', '| --- | ---: | --- | ---: | --- | --- | --- |');
  for (const run of output.runs) for (const scaleResult of run.scales) for (const cell of scaleResult.cells) {
    for (const entry of cell.schedule) push(`| ${run.kind} | ${scaleResult.scale} | ${cell.phase} | ${entry.round} | ${entry.order.join(' → ')} | ${cell.loadAverageBefore.join(' / ')} | ${cell.loadAverageAfter.join(' / ')} |`);
  }
  push('');
  push('## 6. 每格中位数', '');
  push('单位：时间 ms、内存 MiB（2^20 字节）、计数为个数。每格每侧 n = 轮数 × 每轮样本数。', '');
  const masked = allRows.filter((row) => row.metrics.maxRssDeltaBytes === 0);
  if (masked.length) {
    const maskedScales = unique(masked.map((row) => row.scale)).sort((a, b) => a - b).join('/');
    push(`maxRSS 增量遮蔽：${masked.length}/${allRows.length} 个样本的 maxRSS 增量恰为 0（出现规模：${maskedScales}）。这是 load() 的 active-archive 恢复扫描建立了更高历史高水位造成的，不是“没有内存成本”；这些格不能用 maxRSS 判峰值，请用外部采样列。`, '');
  }
  for (const run of output.runs) {
    push(`### run=${run.kind}（${run.sides.map((side) => side.label).join(' vs ')}）`, '');
    for (const scaleResult of run.scales) {
      push(`#### 规模 ${scaleResult.scale} 冷行`, '');
      for (const cell of scaleResult.cells) {
        push(`阶段：${cell.phase}；每侧样本 n = ${cell.rows.filter((row) => row.side === cell.sides[0]).length}。`, '');
        push(`| 指标 | ${cell.sides[0]} | ${cell.sides[1]} | Δ（${cell.sides[1]}−${cell.sides[0]}） | Δ% |`, '| --- | ---: | ---: | ---: | ---: |');
        for (const metric of METRICS) {
          const comparison = cell.comparison.metrics[metric.key];
          push(`| ${metric.label} | ${formatMetric(comparison.from, metric.unit)} | ${formatMetric(comparison.to, metric.unit)} | ${formatSigned(comparison.absolute, metric.unit)} | ${formatPercent(comparison.percent)} |`);
        }
        push('');
      }
    }
  }
  // Measurement-sensitivity self check: with the template protocol the start RSS
  // must be low enough that "external peak - start" is of the same order as the
  // planning heapUsed delta, and both must grow monotonically with scale.
  const referenceRun = output.runs.find((run) => run.kind === 'ab') ?? output.runs[0];
  if (referenceRun && output.options.phases.includes('dryRun')) {
    const rows = [];
    for (const scaleResult of referenceRun.scales) {
      const cell = scaleResult.cells.find((entry) => entry.phase === 'dryRun');
      if (!cell) continue;
      const label = cell.sides[0];
      const medians = cell.medians[label];
      rows.push({
        scale: scaleResult.scale,
        startRssBytes: medians.externalBaselineRssBytes,
        peakRssBytes: medians.externalPeakRssBytes,
        peakMinusStartBytes: medians.externalRssDeltaBytes,
        heapUsedDeltaBytes: medians.heapAllocationDeltaBytes,
        ratio: medians.heapAllocationDeltaBytes ? medians.externalRssDeltaBytes / medians.heapAllocationDeltaBytes : null,
        sampleCount: medians.externalSampleCount,
        maxGapMs: medians.externalMaxGapMs,
      });
    }
    rows.sort((left, right) => left.scale - right.scale);
    const increasing = (key) => rows.every((row, index) => index === 0 || row[key] > rows[index - 1][key]);
    const peakMonotonic = increasing('peakMinusStartBytes');
    const heapMonotonic = increasing('heapUsedDeltaBytes');
    const sameOrder = rows.every((row) => row.ratio !== null && row.ratio > 0.2 && row.ratio < 5);
    push('### 测量敏感性自检（dryRun，模板协议）', '');
    push('自检目标：证实外部采样确实观察到了规划阶段，而不是只观察 setup 高水位。`峰值−开始` 必须与 `heapUsed 增量` 同量级（比值在 0.2–5），且两者随规模单调上升。', '');
    push('| 规模 | 起始 RSS（MiB） | 外部峰值（MiB） | 峰值−开始（MiB） | heapUsed 增量（MiB） | 比值（峰值−开始）/heapUsed | 外部采样数 | 最大间隔（ms） |', '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const row of rows) {
      push(`| ${row.scale} | ${(row.startRssBytes / MIB).toFixed(2)} | ${(row.peakRssBytes / MIB).toFixed(2)} | ${(row.peakMinusStartBytes / MIB).toFixed(2)} | ${(row.heapUsedDeltaBytes / MIB).toFixed(2)} | ${row.ratio === null ? '—' : row.ratio.toFixed(2)} | ${row.sampleCount} | ${row.maxGapMs.toFixed(2)} |`);
    }
    push('');
    push(`- 峰值−开始单调上升（按规模）：${peakMonotonic ? 'PASS' : 'FAIL'}；heapUsed 增量单调上升：${heapMonotonic ? 'PASS' : 'FAIL'}；每格比值在 0.2–5：${sameOrder ? 'PASS' : 'FAIL'}。`);
    push('');
  }
  push('## 7. 报告摘要', '');
  push('每格报告在所有样本中完全一致时（见第 8 节等价性），取第一行代表：', '');
  push('| run | 规模 | 阶段 | retired | consolidated | aggregatedObservations | tombstones | canonical | knowledgeBefore→After | beforeBytes→afterBytes |', '| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |');
  for (const run of output.runs) for (const scaleResult of run.scales) for (const cell of scaleResult.cells) {
    const report = cell.rows[0].report;
    push(`| ${run.kind} | ${scaleResult.scale} | ${cell.phase} | ${report.retired} | ${report.consolidated} | ${report.aggregatedObservations} | ${report.tombstones} | ${report.canonical} | ${report.knowledgeBefore}→${report.knowledgeAfter} | ${report.beforeBytes ?? '—'}→${report.afterBytes ?? '—'} |`);
  }
  push('');
  push('## 8. 等价性与固定点断言', '');
  push('| run | 规模 | 阶段 | report sha | state sha | archive before sha | archive after sha | 二次 compact report sha | dryRun 零写入 | 二次 compact 收敛 | 结论 |', '| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |');
  for (const run of output.runs) for (const scaleResult of run.scales) for (const cell of scaleResult.cells) {
    const check = cell.equivalence;
    push(`| ${run.kind} | ${scaleResult.scale} | ${cell.phase} | ${check.reportSha256.length} | ${check.stateAfterSha256.length} | ${check.archiveBeforeSha256.length} | ${check.archiveAfterSha256.length} | ${check.secondReportSha256.length} | ${check.dryRunUnchanged ?? '—'} | ${check.idempotent ?? '—'} | ${check.ok ? 'PASS' : `FAIL: ${check.violations.join('; ')}`} |`);
  }
  push('');
  push('## 9. A/A 噪声', '');
  if (!output.aaNoise) push('本次未运行 A/A（`--runs` 不含 aa）。', '');
  else {
    push('A/A = 同一 ref 解出两次，两侧代码完全相同，差异即噪声。下表为每格中位数差值（绝对与相对）。', '');
    push('| 规模 | 阶段 | 指标 | 侧 1 | 侧 2 | Δ | Δ% |', '| ---: | --- | --- | ---: | ---: | ---: | ---: |');
    for (const entry of output.aaNoise.perCell) push(`| ${entry.scale} | ${entry.phase} | ${entry.label} | ${entry.fromFormatted} | ${entry.toFormatted} | ${entry.deltaFormatted} | ${formatPercent(entry.percent)} |`);
    push('');
    push('| 指标 | 跨格 |Δ%| 中位数 | 跨格 |Δ%| 最大值 |', '| --- | ---: | ---: |');
    for (const [key, summary] of Object.entries(output.aaNoise.summary)) {
      const metric = METRICS.find((entry) => entry.key === key);
      push(`| ${metric?.label ?? key} | ${summary.medianAbsPercent === null ? '—' : summary.medianAbsPercent.toFixed(2)}% | ${summary.maxAbsPercent === null ? '—' : summary.maxAbsPercent.toFixed(2)}% |`);
    }
    push('');
    const noisy = Object.entries(output.aaNoise.summary)
      .filter(([, summary]) => (summary.medianAbsPercent ?? 0) >= 5 || (summary.maxAbsPercent ?? 0) >= 10)
      .map(([key]) => METRICS.find((metric) => metric.key === key)?.label ?? key);
    const stable = Object.entries(output.aaNoise.summary)
      .filter(([, summary]) => (summary.medianAbsPercent ?? 0) < 2 && (summary.maxAbsPercent ?? 0) < 5)
      .map(([key]) => METRICS.find((metric) => metric.key === key)?.label ?? key);
    push(`- 稳定指标（跨格 |Δ%| 中位数 < 2% 且最大值 < 5%）：${stable.join('、') || '无'}。`);
    push(`- 高噪声指标（跨格 |Δ%| 中位数 ≥ 5% 或最大值 ≥ 10%）：${noisy.join('、') || '无'}。它们不是本基线的主判据：RSS 用绝对外部峰值（其 Δ% 很小）而不是“峰值−开始”（开始基线本身有 ±1–2% 抖动）；heap 用 compact 后 GC 的 heapUsed 与 archive 字节（后者在多轮 A/A 中逐字节相同）。`);
    push('');
  }
  push('## 10. 候选显著性判定', '');
  push('阈值（Lead 指定，依据同协议 A/A 基线噪声）：wall |Δ%| > 2%、CPU user+system |Δ%| > 2%、外部采样峰值 RSS |Δ%| > 2.2% 视为超出噪声。同时检查每轮中位数差值的符号是否一致：符号在轮间翻转的差异判为不稳定。', '');
  push('| run | 规模 | 阶段 | wall Δ% | CPU Δ% | 外部峰值 Δ% | 峰值−start Δ% | 轮间符号不一致 | 判定 |', '| --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- |');
  for (const run of output.runs.filter((entry) => entry.kind === 'ab')) {
    for (const scaleResult of run.scales) for (const cell of scaleResult.cells) {
      const [baselineLabel, candidateLabel] = cell.sides;
      const deltas = ['wallMs', 'cpuTotalMs', 'externalPeakRssBytes', 'externalRssDeltaBytes'].map((key) => cell.comparison.metrics[key].percent);
      const roundSigns = ['wallMs', 'cpuTotalMs', 'externalPeakRssBytes'].map((key) => {
        const values = cell.perRoundMedians.map((round) => round[candidateLabel]?.[key] - round[baselineLabel]?.[key]).filter((value) => Number.isFinite(value));
        return values.length > 1 && !(values.every((value) => value >= 0) || values.every((value) => value <= 0)) ? key : null;
      }).filter(Boolean);
      const unstable = roundSigns.map((key) => METRICS.find((metric) => metric.key === key)?.label ?? key);
      const exceeded = [
        { key: 'wallMs', label: 'wall', percent: deltas[0], threshold: 2 },
        { key: 'cpuTotalMs', label: 'CPU', percent: deltas[1], threshold: 2 },
        { key: 'externalPeakRssBytes', label: '外部峰值', percent: deltas[2], threshold: 2.2 },
      ].filter((entry) => Math.abs(entry.percent ?? 0) > entry.threshold);
      const stableExceeded = exceeded.filter((entry) => !roundSigns.includes(entry.key));
      const verdict = stableExceeded.length
        ? `显著（${stableExceeded.map((entry) => `${entry.label} ${formatPercent(entry.percent)}`).join('、')}）`
        : (exceeded.length ? `仅轮间不稳定（${exceeded.map((entry) => `${entry.label} ${formatPercent(entry.percent)}`).join('、')}）` : '未超出噪声阈值');
      push(`| ${run.kind} | ${scaleResult.scale} | ${cell.phase} | ${formatPercent(deltas[0])} | ${formatPercent(deltas[1])} | ${formatPercent(deltas[2])} | ${formatPercent(deltas[3])} | ${unstable.join('、') || '无'} | ${verdict} |`);
    }
  }
  push('');
  push('## 11. 未测量项与限制', '');
  for (const limitation of output.limitations) push(`- ${limitation}`);
  push('- 未测量项：' + (output.unmeasured.length ? output.unmeasured.join('；') : '无（本次运行覆盖的范围内）'));
  push('- 历史数据单位更正：本修复（scripts/benchmarks/retention-rss-sampler.py 的 `firstSampleMs`/`lastSampleMs` 输出改为毫秒）之前生成的 `retention-plan-streaming-baseline.json`、`retention-plan-streaming-ab-with-c3.*`、`retention-plan-streaming-c3-ab.*`、`retention-plan-streaming-c3c4-ab.*` 中，`externalFirstSampleMs`/`externalLastSampleMs` 实际单位是**秒**（sampler bug，已修复；外部峰值、`externalRssDeltaBytes`、`externalMaxGapMs` 不受影响，它们本来就是毫秒或字节）。');
  push('');
  return lines.join('\n') + '\n';
}

function summarizeAaNoise(aaRun) {
  if (!aaRun) return null;
  const perCell = [];
  const percentages = {};
  for (const scaleResult of aaRun.scales) for (const cell of scaleResult.cells) {
    const [fromLabel, toLabel] = cell.sides;
    for (const metric of METRICS) {
      const comparison = cell.comparison.metrics[metric.key];
      if (comparison.percent === null) continue;
      perCell.push({
        scale: scaleResult.scale, phase: cell.phase, metric: metric.key, label: metric.label,
        from: comparison.from, to: comparison.to, absolute: comparison.absolute, percent: comparison.percent,
        fromFormatted: formatMetric(comparison.from, metric.unit), toFormatted: formatMetric(comparison.to, metric.unit),
        deltaFormatted: formatSigned(comparison.absolute, metric.unit),
      });
      (percentages[metric.key] ??= []).push(comparison.percent);
    }
  }
  const summary = Object.fromEntries(Object.entries(percentages).map(([key, values]) => {
    const absolute = values.map((value) => Math.abs(value));
    return [key, { cells: values.length, medianAbsPercent: median(absolute), maxAbsPercent: Math.max(...absolute) }];
  }));
  return { perCell, summary };
}

// ---------------------------------------------------------------------------
// Parent orchestration.
// ---------------------------------------------------------------------------

async function runParent(options) {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-retention-streaming-'));
  const startedAt = new Date();
  const startedMonotonic = performance.now();
  const log = options.json ? (...entries) => console.error(...entries) : (...entries) => console.log(...entries);
  const loadAverageAtStart = loadAverage();
  try {
    const labelA = options.labelA ?? defaultLabel(options.a);
    let labelB = options.labelB ?? defaultLabel(options.b);
    if (labelB === labelA) labelB = `${labelB}#b`;
    const sideA = await resolveSide(options.a, labelA, temporary);
    const sideB = await resolveSide(options.b, labelB, temporary);
    log(`sides: A=${labelA} (${sideA.kind} ${sideA.resolvedCommit ?? sideA.libDirectory}) tree=${sideA.treeSha256.slice(0, 12)}`);
    log(`       B=${labelB} (${sideB.kind} ${sideB.resolvedCommit ?? sideB.libDirectory}) tree=${sideB.treeSha256.slice(0, 12)}`);
    const runDefs = [];
    if (options.runs.includes('aa')) runDefs.push({ kind: 'aa', sides: [{ ...sideA, label: `${labelA}#1` }, { ...sideA, label: `${labelA}#2` }], treesIdentical: true });
    if (options.runs.includes('ab')) runDefs.push({ kind: 'ab', sides: [{ ...sideA, label: labelA }, { ...sideB, label: labelB }], treesIdentical: sideA.treeSha256 === sideB.treeSha256 });
    const templates = [];
    const runs = runDefs.map((def) => ({ kind: def.kind, treesIdentical: def.treesIdentical, sides: def.sides.map((side) => ({ label: side.label, treeSha256: side.treeSha256, resolvedCommit: side.resolvedCommit, spec: side.spec })), scales: [] }));
    let sampleCounter = 0;
    const idempotencySeen = new Set();
    const failures = [];
    for (const scale of options.scales) {
      const template = await buildTemplate(scale, sideA, temporary);
      templates.push({
        scale, files: template.files, fileCount: template.fileCount, bytes: template.bytes, sha256: template.sha256,
        stateFile: template.stateFile, counts: template.counts, canonical: template.canonical,
      });
      log(`template ${scale}: files=${template.fileCount} bytes=${template.bytes} archiveSha256=${template.sha256.slice(0, 16)} stateSha256=${template.stateFile.sha256.slice(0, 16)} counts=${JSON.stringify(template.counts)}`);
      for (const runResult of runs) runResult.scales.push({ scale, cells: [] });
      for (const phase of options.phases) {
        const cellByRun = new Map();
        for (const runResult of runs) {
          const def = runDefs.find((entry) => entry.kind === runResult.kind);
          const cell = { phase, rounds: options.rounds, samplesPerSide: options.samples, sides: def.sides.map((side) => side.label), rows: [], schedule: [], loadAverageBefore: loadAverage(), loadAverageAfter: null };
          runResult.scales.find((entry) => entry.scale === scale).cells.push(cell);
          cellByRun.set(runResult.kind, cell);
        }
        for (let round = 0; round < options.rounds; round += 1) {
          const orderedRuns = round % 2 === 0 ? runs.map((runResult) => runResult.kind) : runs.map((runResult) => runResult.kind).reverse();
          for (const runKind of orderedRuns) {
            const def = runDefs.find((entry) => entry.kind === runKind);
            const cell = cellByRun.get(runKind);
            const order = round % 2 === 0 ? def.sides : [...def.sides].reverse();
            cell.schedule.push({ round, samples: options.samples, order: order.map((side) => side.label) });
            for (let sampleIndex = 0; sampleIndex < options.samples; sampleIndex += 1) {
              for (const [position, side] of order.entries()) {
                const idempotencyMode = phase === 'write' ? options.idempotency : 'none';
                const idempotencyKey = `${runKind}|${scale}|${phase}|${side.label}`;
                const idempotency = idempotencyMode === 'all' || (idempotencyMode === 'first' && !idempotencySeen.has(idempotencyKey));
                if (idempotency && idempotencyMode === 'first') idempotencySeen.add(idempotencyKey);
                sampleCounter += 1;
                const row = await runSample({
                  def, side, phase, scale, template, round, sampleIndex,
                  order: order.map((entry) => entry.label), position, idempotency,
                  temporary, options, sampleCounter,
                });
                cell.rows.push(row);
                log(`  ${runKind} ${scale} ${phase} r${round} s${sampleIndex} ${side.label}: wall=${row.metrics.wallMs.toFixed(1)}ms cpu=${row.metrics.cpuTotalMs.toFixed(1)}ms externalPeak=${(row.metrics.externalPeakRssBytes / MIB).toFixed(1)}MiB (${row.sampler.sampleCount} samples, gap ${row.sampler.maxGapMs.toFixed(2)}ms) maxRssDelta=${(row.metrics.maxRssDeltaBytes / MIB).toFixed(1)}MiB`);
              }
            }
          }
        }
        for (const cell of cellByRun.values()) {
          cell.loadAverageAfter = loadAverage();
          Object.assign(cell, evaluateCell(cell));
          if (!cell.equivalence.ok) failures.push(`run=${runKindLabel(cell, runs)} scale=${scale} phase=${phase}: ${cell.equivalence.violations.join('; ')}`);
        }
      }
    }
    const useIdempotency = options.idempotency !== 'none' && options.phases.includes('write');
    const output = {
      schema: 1,
      generatedAt: startedAt.toISOString(),
      durationMs: performance.now() - startedMonotonic,
      environment: {
        node: process.version,
        platform: process.platform,
        kernel: release(),
        arch: arch(),
        cpuModel: cpus()[0]?.model ?? null,
        logicalCpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
        python: { command: options.python, version: execFileSync(options.python, ['--version'], { encoding: 'utf8' }).trim() },
        parentExecArgv: process.execArgv,
        samplerMethod: runs.flatMap((run) => run.scales).flatMap((scale) => scale.cells).flatMap((cell) => cell.rows)[0]?.sampler.method ?? null,
        loadAverageAtStart,
        loadAverageAtEnd: loadAverage(),
      },
      command: [process.execPath, ...process.execArgv, SCRIPT, ...ARGS].join(' '),
      options: { ...options, out: options.out, md: options.md },
      sides: [
        { label: labelA, spec: options.a, kind: sideA.kind, resolvedCommit: sideA.resolvedCommit, libDirectory: sideA.libDirectory, treeSha256: sideA.treeSha256, files: sideA.files },
        { label: labelB, spec: options.b, kind: sideB.kind, resolvedCommit: sideB.resolvedCommit, libDirectory: sideB.libDirectory, treeSha256: sideB.treeSha256, files: sideB.files },
      ],
      templates,
      runs,
      aaNoise: summarizeAaNoise(runs.find((run) => run.kind === 'aa')),
      protocol: 'template-copy v2: the parent copies a pre-built on-disk session template into a private root per sample; the measured child only calls EvolutionMemory.load() on that small state file and then one compact(). The corpus JSON is never parsed inside a measured child, so the external start RSS is not inflated by the fixture representation. Template copy, load and the parent-side pre-compact hash are outside the go-to-END window. v1 (which parsed a 6-52 MB fixture JSON in the child) is superseded; its start RSS reached 155-553 MiB and hid the planning peak.',
      scope: 'public EvolutionMemory compact({dryRun}) planning and compact() including durable archive rewrite/readback/index/state save; the template copy, load(), parent-side pre-compact hashing, snapshots and the optional second compact are outside the measured window. No official host transaction, fsync, multi-process work or startup #reconcileArchiveIndex timing.',
      memoryMeasurement: {
        primary: 'out-of-process RSS sampling of the child pid by retention-rss-sampler.py; sampling lower bound, sample count and max gap recorded',
        startRss: 'external first sample, taken after template copy + load() + double GC while the child is blocked at START; it still includes resident pages left by load()\'s active-archive recovery scan (the archive scan is part of load, not of compact), so both the absolute peak and the peak-minus-start delta are reported',
        externalSemantics: 'the kernel resident counter includes pages V8 marked MADV_FREE_REUSABLE, so the external value is usually above process.memoryUsage().rss and close to resourceUsage().maxRSS; absolute peak and peak-minus-stage-start delta are both reported',
        maxRss: 'process.resourceUsage().maxRSS is a process-lifetime high-water mark; the delta is a lower bound and can be masked by load()\'s archive recovery scan',
        heapUsed: 'GC-enforced (--expose-gc) readings around compact; heapUsed delta is not total allocated bytes',
      },
      limitations: [
        'external RSS peak is a sampling lower bound; a peak shorter than the sampling interval can be missed',
        'maxRSS delta can be masked by the load-time archive scan high-water mark and is never used as the per-call peak',
        'synthetic fixed-time corpus (deterministic clock) generated once by the baseline side; not production user data',
        'no official host domain transaction, fsync, multi-process contention or startup archive-index reconciliation is timed',
        'OS page cache is not flushed; each sample copies the template fresh (copy is outside the measured window) and A/B/B/A round rotation balances ordering effects',
        'knowledge groups fit the bounded sourceRefs window; canonical protects outcomes, not terminal promotions',
        'the external sampler reads a lower bound of resident bytes and does not attribute them to V8 heap vs. native buffers',
      ],
      unmeasured: [
        'per-3ms RSS trace is not persisted (only peak/baseline/delta/count/max gap are recorded)',
        'native (malloc/mmap) vs. V8 heap attribution of the external RSS peak',
        'write-phase OS peak under a pinned heap (unless --pinned-heap is passed)',
      ],
      schedule: `per (scale, phase): ${options.rounds} rounds alternating [A,B] / [B,A]; ${options.samples} samples per side per round; AA and AB runs alternate run order across rounds; idempotency=${options.idempotency}`,
      idempotencyUsed: useIdempotency,
      failures,
    };
    const json = JSON.stringify(output, null, 2) + '\n';
    if (options.out) { await mkdir(dirname(options.out), { recursive: true }); await writeFile(options.out, json); }
    if (options.md) { await mkdir(dirname(options.md), { recursive: true }); await writeFile(options.md, renderMarkdown(output)); }
    if (options.json) process.stdout.write(json);
    else {
      for (const run of output.runs) for (const scaleResult of run.scales) for (const cell of scaleResult.cells) {
        const [fromLabel, toLabel] = cell.sides;
        const summary = (label) => {
          const values = cell.medians[label];
          return `wall=${values.wallMs.toFixed(2)}ms cpu=${values.cpuTotalMs.toFixed(2)}ms peakRss=${(values.externalPeakRssBytes / MIB).toFixed(2)}MiB heapDelta=${(values.heapAllocationDeltaBytes / MIB).toFixed(2)}MiB`;
        };
        log(`${run.kind} scale=${scaleResult.scale} ${cell.phase}: ${fromLabel}[${summary(fromLabel)}] ${toLabel}[${summary(toLabel)}] equivalence=${cell.equivalence.ok ? 'PASS' : 'FAIL'}`);
      }
      log(`output: ${options.out ?? '(stdout only)'}${options.md ? `; markdown: ${options.md}` : ''}`);
    }
    if (failures.length && !options.allowMismatch) throw new Error(`equivalence failures:\n${failures.join('\n')}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function runKindLabel(cell, runs) {
  const match = runs.find((run) => run.sides.some((side) => side.label === cell.sides[0]));
  return match?.kind ?? '?';
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

try {
  if (ARGS[0] === '--build-template') await buildTemplateChild(parseChildArgs(ARGS.slice(1)));
  else if (ARGS[0] === '--child') await measuredChild(parseChildArgs(ARGS.slice(1)));
  else if (ARGS[0] === '--render') {
    // Render the markdown report from an existing JSON without re-measuring:
    //   node scripts/benchmarks/retention-plan-streaming.mjs --render <json> --md <md>
    let jsonPath = null;
    let mdPath = null;
    for (let index = 1; index < ARGS.length; index += 1) {
      if (ARGS[index] === '--md') mdPath = resolve(ARGS[++index]);
      else jsonPath = resolve(ARGS[index]);
    }
    if (!jsonPath || !mdPath) throw new Error('--render requires <json> and --md <md>');
    const existing = JSON.parse(await readFile(jsonPath, 'utf8'));
    await mkdir(dirname(mdPath), { recursive: true });
    await writeFile(mdPath, renderMarkdown(existing));
    console.log(`rendered ${mdPath}`);
  }
  else {
    const options = parseOptions(ARGS);
    if (options) await runParent(options);
  }
} catch (error) {
  console.error(`retention-plan-streaming: ${error?.stack ?? error?.message ?? String(error)}`);
  process.exitCode = 1;
}
