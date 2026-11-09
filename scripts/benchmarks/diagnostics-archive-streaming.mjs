// Cold-history JSONL integrity cost in `evolution_doctor`'s `state.archives`
// check, measured through the real `collectDiagnostics()` path only.
//
// The check used to read every `dockyard/*.jsonl` file with
// `readFileSync(file, "utf8")` and then split the decoded text. This benchmark
// compares that implementation (side A, `--baseline-rev`) with the working
// tree's chunked scan (side B) over identical fixture bytes:
//
//   small            128 KiB observations + damaged knowledge/diagnostics files
//                    (blank lines, CRLF, broken JSON, invalid UTF-8, whitespace
//                    lines, an unterminated tail) - result equivalence, not cost
//   single-32m       32 MiB in one legacy rotation file
//   single-128m      128 MiB in one legacy rotation file
//   single-256m      256 MiB in one legacy rotation file
//   single-128m-archive / single-256m-archive
//                    the same sizes under a collection archive name, which
//                    `inspectArchiveIntegrity()` also reads in full; the JSONL
//                    summary was never the only whole-file reader there
//   multi-256m       4 x 64 MiB collection archive files
//   realistic-multi  7 x 8 MiB collection archive files, one per collection
//                    (the append-time target is 8 MiB and the hard ceiling
//                    16 MiB), so this is the layout a current installation
//                    produces; kept to show the boundary where the change
//                    cannot help because no file is large
//
// Every side runs in its own child process: a peak-RSS reading is a process
// high-water mark and cannot be measured for two implementations in one process.
// Each child reports wall time, CPU time, peak RSS (`process.resourceUsage()
// .maxRSS`), whole-file reads of the scenario's `*.jsonl` files (per-call count
// and bytes), and a hash of the whole report with `generatedAt` removed. The
// parent runs A/A (baseline against itself) to give the measurement noise floor
// and A/B with the sides swapping order each round.
//
// The allocation column is a V8 HeapProfiler sample: sampled bytes per
// `collectDiagnostics()` call, including objects later collected by GC. It is an
// allocation estimate, not a peak.
//
// The fixture is synthetic: a temporary `dshHome` under --fixture. No real
// DSH_HOME or user data is read. The scenario files are written once with
// `--build`; measurement children only read them.
//
//   node scripts/benchmarks/diagnostics-archive-streaming.mjs --build --fixture /tmp/x
//   node --expose-gc scripts/benchmarks/diagnostics-archive-streaming.mjs \
//     --fixture /tmp/x --baseline-rev origin/main \
//     --out docs/performance/diagnostics-archive-streaming.json
//
// Each timing/RSS child is a fresh process that runs `collectDiagnostics()`
// once, so peak RSS is the peak of one real diagnostic run rather than the
// high-water mark of repeated runs in one process. The allocation child keeps
// its warmup and calls `collectDiagnostics()` several times under the sampler.
//
// Options: [--fixture <dir>] [--baseline-rev <rev>] [--scenarios a,b] [--rounds N]
// [--allocation-calls N] [--allocation-interval BYTES] [--out <path>]
// [--no-allocation] [--keep-fixture] [--json]. `--build` only creates the
// fixture and prints it.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cpus, loadavg, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const fs = require('node:fs');

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const CANDIDATE_MODULE = join(REPO, 'lib', 'diagnostics.js');
const MiB = 1024 * 1024;
const ROW_PAYLOAD = 'x'.repeat(900);
const NOW = '2026-01-01T00:00:00.000Z';
const SCHEMA = 1;

/** Fixture scenarios. `files.bytes` targets are approximate for synthetic rows;
 *  the builder records what it actually wrote and measurement uses those bytes. */
const SCENARIOS = {
  small: {
    files: [
      { name: 'state.json.observations.jsonl', edges: 'mixed' },
      { name: 'state.json.knowledge-archive.jsonl', edges: 'crlf' },
      { name: 'state.json.diagnostics.jsonl', edges: 'invalid-utf8' },
    ],
  },
  'single-32m': { files: [{ name: 'state.json.observations.jsonl', bytes: 32 * MiB }] },
  'single-128m': { files: [{ name: 'state.json.observations.jsonl', bytes: 128 * MiB }] },
  'single-256m': { files: [{ name: 'state.json.observations.jsonl', bytes: 256 * MiB }] },
  'single-128m-archive': { files: [{ name: 'state.json.knowledge-archive.jsonl', bytes: 128 * MiB }] },
  'single-256m-archive': { files: [{ name: 'state.json.observations-archive.jsonl', bytes: 256 * MiB }] },
  'multi-256m': {
    files: [
      { name: 'state.json.observations-archive.jsonl', bytes: 64 * MiB },
      { name: 'state.json.knowledge-archive.jsonl', bytes: 64 * MiB },
      { name: 'state.json.experiments-archive.jsonl', bytes: 64 * MiB },
      { name: 'state.json.cycles-archive.jsonl', bytes: 64 * MiB },
    ],
  },
  'realistic-multi': {
    files: [
      { name: 'state.json.cycles-archive.jsonl', bytes: 8 * MiB },
      { name: 'state.json.observations-archive.jsonl', bytes: 8 * MiB },
      { name: 'state.json.knowledge-archive.jsonl', bytes: 8 * MiB },
      { name: 'state.json.diagnoses-archive.jsonl', bytes: 8 * MiB },
      { name: 'state.json.gaps-archive.jsonl', bytes: 8 * MiB },
      { name: 'state.json.candidates-archive.jsonl', bytes: 8 * MiB },
      { name: 'state.json.proposals-archive.jsonl', bytes: 8 * MiB },
    ],
  },
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const round = (value) => Number(value.toFixed(3));
const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
};
const percent = (from, to) => (from === 0 ? null : round(((to - from) / from) * 100));
const jsonlFiles = (directory) => {
  const names = fs.readdirSync(directory).filter((name) => name.endsWith('.jsonl')).sort();
  return names.map((name) => join(directory, name));
};

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

const homeFor = (fixtureRoot, scenario) => join(fixtureRoot, scenario, 'home');
const dockyardFor = (fixtureRoot, scenario) => join(homeFor(fixtureRoot, scenario), 'storages', 'evolution', 'dockyard');

function row(scenario, index) {
  return JSON.stringify({ id: `${scenario}-${index}`, kind: 'observation', recordedAt: NOW, payload: ROW_PAYLOAD });
}

function edgeContent(kind, scenario) {
  const lines = [];
  const valid = (index) => row(`${scenario}-${index}`, index);
  if (kind === 'mixed') {
    for (let index = 0; index < 24; index += 1) lines.push(Buffer.from(valid(index) + '\n'));
    lines.push(Buffer.from('\n'));
    lines.push(Buffer.from('   \n'));
    lines.push(Buffer.from('{broken json\n'));
    lines.push(Buffer.from('null\n'));
    lines.push(Buffer.from('[]\n'));
    lines.push(Buffer.from('{}\r\n'));
    lines.push(Buffer.from('\r\n'));
    for (let index = 24; index < 40; index += 1) lines.push(Buffer.from(valid(index) + '\n'));
    // Unterminated final line: line counting and `truncatedTail` both see it.
    lines.push(Buffer.from('{"unterminated":true'));
    return Buffer.concat(lines);
  }
  if (kind === 'crlf') {
    for (let index = 0; index < 20; index += 1) {
      lines.push(Buffer.from(valid(index) + '\r\n'));
      if (index === 7) lines.push(Buffer.from('\r\n'));
      if (index === 11) lines.push(Buffer.from('  \t \n'));
    }
    return Buffer.concat(lines);
  }
  if (kind === 'invalid-utf8') {
    lines.push(Buffer.from(valid(0) + '\n'));
    // Invalid UTF-8 outside and inside a JSON string; `readFileSync("utf8")`
    // replaces each maximal invalid subsequence, and the byte-level line scan
    // must produce the same text.
    lines.push(Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a]));
    lines.push(Buffer.from('{"id":"'));
    lines.push(Buffer.from([0xc3, 0x28, 0x80]));
    lines.push(Buffer.from('"}\n'));
    lines.push(Buffer.from(valid(1) + '\n'));
    lines.push(Buffer.from([0xe2, 0x82]));
    return Buffer.concat(lines);
  }
  throw new Error(`unknown edge fixture ${kind}`);
}

function buildFixture(fixtureRoot, scenarioNames) {
  const description = {};
  for (const scenario of scenarioNames) {
    const spec = SCENARIOS[scenario];
    if (!spec) throw new Error(`unknown scenario ${scenario}`);
    const dockyard = dockyardFor(fixtureRoot, scenario);
    fs.rmSync(join(fixtureRoot, scenario), { recursive: true, force: true });
    fs.mkdirSync(dockyard, { recursive: true });
    const home = homeFor(fixtureRoot, scenario);
    fs.writeFileSync(join(home, 'storages', 'evolution', 'event-bridge.key'), 'a'.repeat(64), { mode: 0o600 });
    fs.writeFileSync(join(dockyard, 'state.json'), JSON.stringify({ evolution: { schema: 4, observations: [] } }));
    const files = [];
    for (const file of spec.files) {
      const target = join(dockyard, file.name);
      const digest = createHash('sha256');
      let bytes = 0;
      const fd = fs.openSync(target, 'w');
      try {
        if (file.edges) {
          const content = edgeContent(file.edges, scenario);
          fs.writeSync(fd, content);
          digest.update(content);
          bytes = content.length;
        } else {
          // ~1 KiB rows, written in small batches so the builder never holds the
          // whole file as one string. The file ends with a newline, like a
          // complete append.
          let index = 0;
          let written = 0;
          while (written < file.bytes) {
            const batch = [];
            for (let part = 0; part < 256; part += 1) batch.push(row(`${scenario}-${index++}`));
            const chunk = Buffer.from(batch.join('\n') + '\n');
            fs.writeSync(fd, chunk);
            digest.update(chunk);
            written += chunk.length;
          }
          bytes = written;
        }
      } finally {
        fs.closeSync(fd);
      }
      files.push({ name: file.name, bytes, sha256: digest.digest('hex'), edge: file.edges ?? null });
    }
    description[scenario] = { home, files, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
  }
  return description;
}

function loadFixture(fixtureRoot) {
  const description = {};
  for (const scenario of Object.keys(SCENARIOS)) {
    const home = homeFor(fixtureRoot, scenario);
    if (!fs.existsSync(home)) continue;
    const dockyard = dockyardFor(fixtureRoot, scenario);
    const files = jsonlFiles(dockyard).map((file) => {
      const digest = createHash('sha256');
      const descriptor = fs.openSync(file, 'r');
      const chunk = Buffer.allocUnsafe(4 * MiB);
      let bytes = 0;
      try {
        while (true) {
          const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
          if (bytesRead === 0) break;
          digest.update(chunk.subarray(0, bytesRead));
          bytes += bytesRead;
        }
      } finally {
        fs.closeSync(descriptor);
      }
      return { name: file.slice(dockyard.length + 1), bytes, sha256: digest.digest('hex') };
    });
    description[scenario] = { home, files, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
  }
  return description;
}

// ---------------------------------------------------------------------------
// child: one side, one scenario
// ---------------------------------------------------------------------------

async function childMode(options) {
  if (options.controlFile) {
    // Control for the allocation estimator: `fs.readFileSync(file, "utf8")` on
    // Node 26 uses the native `readFileUtf8` fast path, whose string the V8
    // sampling HeapProfiler does not attribute, while the same bytes decoded in
    // pieces are attributed. The two numbers below are the same byte count.
    const inspector = await import('node:inspector/promises');
    const session = new inspector.Session();
    session.connect();
    try {
      const buffer = fs.readFileSync(options.controlFile);
      const measure = async (run, calls) => {
        global.gc?.();
        await session.post('HeapProfiler.startSampling', {
          samplingInterval: options.allocationInterval,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
        for (let index = 0; index < calls; index += 1) run();
        const { profile } = await session.post('HeapProfiler.stopSampling');
        return Math.round(profile.samples.reduce((sum, sample) => sum + sample.size, 0) / calls);
      };
      const whole = await measure(() => fs.readFileSync(options.controlFile, 'utf8'), 2);
      const pieces = await measure(() => {
        let length = 0;
        for (let offset = 0; offset < buffer.length; offset += 1024) length += buffer.toString('utf8', offset, Math.min(offset + 1024, buffer.length)).length;
        return length;
      }, 2);
      return {
        control: {
          file: options.controlFile,
          bytes: buffer.length,
          samplingInterval: options.allocationInterval,
          wholeFileReadSampledBytes: whole,
          chunkDecodedSampledBytes: pieces,
        },
      };
    } finally {
      session.disconnect();
    }
  }
  const dockyard = dockyardFor(options.fixture, options.scenario);
  const trackedFiles = new Set(jsonlFiles(dockyard));
  const plainReadFileSync = fs.readFileSync;
  const counters = { readFileSyncBytes: 0, readFileSyncCalls: 0 };
  // Account the whole-file reads of the scenario's JSONL files. The summary loop
  // is the only reader this change moves off `readFileSync`; the archive-integrity
  // scan (shared by both sides) still reads the collection archive files that way,
  // so the per-side call count separates the two readers exactly: baseline =
  // fixture files + integrity files, candidate = integrity files. The fixture's
  // own byte total is the number of bytes the summary loop scans on either side.
  fs.readFileSync = function accountedReadFileSync(file, ...args) {
    const key = String(file);
    const result = plainReadFileSync.call(this, file, ...args);
    if (trackedFiles.has(key)) { counters.readFileSyncBytes += fs.statSync(key).size; counters.readFileSyncCalls += 1; }
    return result;
  };

  const module = await import(pathToFileURL(options.side).href);
  const diagnosticsOptions = { dshHome: homeFor(options.fixture, options.scenario), probe: { skipComposition: true } };
  const hashReport = (report) => {
    const clone = JSON.parse(JSON.stringify(report));
    delete clone.generatedAt;
    return sha256(Buffer.from(JSON.stringify(clone)));
  };
  const run = async () => {
    const cpu = process.cpuUsage();
    const start = performance.now();
    const report = await module.collectDiagnostics(diagnosticsOptions);
    const wallMs = performance.now() - start;
    const used = process.cpuUsage(cpu);
    const archives = report.checks.find((check) => check.id === 'state.archives');
    return {
      wallMs: round(wallMs),
      cpuMs: round((used.user + used.system) / 1000),
      reportHash: hashReport(report),
      archivesLevel: archives.level,
      jsonl: archives.evidence?.dockyard?.jsonl ?? [],
      readFileSyncBytes: counters.readFileSyncBytes,
      readFileSyncCalls: counters.readFileSyncCalls,
    };
  };
  const resetCounters = () => Object.assign(counters, { readFileSyncBytes: 0, readFileSyncCalls: 0 });

  for (let index = 0; index < options.warmup; index += 1) { resetCounters(); await run(); }
  resetCounters();
  const measured = [];
  if (options.allocation) {
    const inspector = await import('node:inspector/promises');
    const session = new inspector.Session();
    session.connect();
    try {
      global.gc?.();
      await session.post('HeapProfiler.startSampling', {
        samplingInterval: options.allocationInterval,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      for (let index = 0; index < options.samples; index += 1) measured.push(await run());
      const { profile } = await session.post('HeapProfiler.stopSampling');
      const sampled = profile.samples.reduce((sum, sample) => sum + sample.size, 0) / options.samples;
      return {
        side: options.side,
        scenario: options.scenario,
        node: process.version,
        allocation: { interval: options.allocationInterval, calls: options.samples, sampledBytesPerCall: Math.round(sampled) },
        reportHashes: [...new Set(measured.map((sample) => sample.reportHash))],
      };
    } finally {
      session.disconnect();
    }
  }
  for (let index = 0; index < options.samples; index += 1) measured.push(await run());
  const maxRssKb = process.resourceUsage().maxRSS;
  global.gc?.();
  return {
    side: options.side,
    scenario: options.scenario,
    node: process.version,
    maxRssKb,
    heapUsedAfterGc: process.memoryUsage().heapUsed,
    samples: measured,
  };
}

// ---------------------------------------------------------------------------
// parent
// ---------------------------------------------------------------------------

function parseArgs(args) {
  const options = {
    fixture: join(tmpdir(), 'diagnostics-archive-streaming-fixture'),
    baselineRev: 'origin/main',
    scenarios: Object.keys(SCENARIOS),
    rounds: 5,
    samples: 1,
    warmup: 0,
    allocationCalls: 3,
    allocationInterval: 32768,
    out: null,
    json: false,
    build: false,
    allocation: true,
    keepFixture: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--json') { options.json = true; continue; }
    if (key === '--build') { options.build = true; continue; }
    if (key === '--no-allocation') { options.allocation = false; continue; }
    if (key === '--keep-fixture') { options.keepFixture = true; continue; }
    if (key === '--child') { options.child = true; continue; }
    if (key === '--allocation') { options.allocation = true; continue; }
    if (key === '--help') {
      console.log('Usage: node scripts/benchmarks/diagnostics-archive-streaming.mjs --build --fixture <dir>\n       node --expose-gc scripts/benchmarks/diagnostics-archive-streaming.mjs --fixture <dir> [--baseline-rev <rev>]\n         [--scenarios a,b] [--rounds N] [--allocation-calls N] [--allocation-interval BYTES]\n         [--out <path>] [--no-allocation] [--keep-fixture] [--json]');
      return null;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${key}`);
    index += 1;
    if (key === '--fixture') options.fixture = resolve(value);
    else if (key === '--baseline-rev') options.baselineRev = value;
    else if (key === '--scenarios') options.scenarios = value.split(',').map((name) => name.trim()).filter(Boolean);
    else if (key === '--rounds') options.rounds = Number(value);
    else if (key === '--samples') options.samples = Number(value);
    else if (key === '--warmup') options.warmup = Number(value);
    else if (key === '--allocation-calls') options.allocationCalls = Number(value);
    else if (key === '--allocation-interval') options.allocationInterval = Number(value);
    else if (key === '--out') options.out = resolve(value);
    else if (key === '--side') options.side = resolve(value);
    else if (key === '--scenario') options.scenario = value;
    else if (key === '--control-file') options.controlFile = resolve(value);
    else throw new Error(`unknown option ${key}`);
  }
  if (options.child) {
    if (options.controlFile) return options;
    if (!options.side || !options.scenario) throw new Error('--child requires --side and --scenario');
    return options;
  }
  for (const key of ['rounds', 'samples', 'allocationCalls']) {
    if (!Number.isSafeInteger(options[key]) || options[key] < 1) throw new Error(`invalid --${key}`);
  }
  if (!options.scenarios.length) throw new Error('no scenarios selected');
  for (const scenario of options.scenarios) if (!SCENARIOS[scenario]) throw new Error(`unknown scenario ${scenario}`);
  return options;
}

function runChildSide(options, side, scenario, extra = []) {
  const args = [
    '--expose-gc', '--max-old-space-size=4096', SELF, '--child',
    '--side', side, '--fixture', options.fixture, '--scenario', scenario,
    '--samples', String(options.samples), '--warmup', String(options.warmup),
    '--allocation-interval', String(options.allocationInterval),
    // Timing/RSS children never profile; only the explicit allocation children do.
    ...(extra.includes('--allocation') ? [] : ['--no-allocation']),
    ...extra,
  ];
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: REPO,
      env: { ...process.env, NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error(`child ${side} ${scenario} exited ${code}: ${stderr.slice(-4000)}`)); return; }
      try { accept(JSON.parse(stdout)); } catch { reject(new Error(`child ${side} ${scenario} produced no JSON: ${stdout.slice(-2000)} ${stderr.slice(-2000)}`)); }
    });
  });
}

/** Measure the allocation estimator's control on one fixture file. */
function runAllocationControl(options, file) {
  const args = [
    '--expose-gc', '--max-old-space-size=4096', SELF, '--child',
    '--control-file', file, '--allocation-interval', String(options.allocationInterval),
  ];
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: REPO,
      env: { ...process.env, NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error(`allocation control exited ${code}: ${stderr.slice(-4000)}`)); return; }
      try { accept(JSON.parse(stdout)); } catch { reject(new Error(`allocation control produced no JSON: ${stdout.slice(-2000)}`)); }
    });
  });
}

function summarizeRuns(runs) {
  const samples = runs.flatMap((run) => run.samples);
  const firstSamples = runs.map((run) => run.samples[0] ?? { readFileSyncBytes: 0, readFileSyncCalls: 0 });
  return {
    childRuns: runs.length,
    wallMsMedian: median(samples.map((sample) => sample.wallMs)),
    cpuMsMedian: median(samples.map((sample) => sample.cpuMs)),
    maxRssKbMedian: median(runs.map((run) => run.maxRssKb)),
    maxRssKbMin: Math.min(...runs.map((run) => run.maxRssKb)),
    heapUsedAfterGcMedian: median(runs.map((run) => run.heapUsedAfterGc)),
    readFileSyncBytesMedian: median(firstSamples.map((sample) => sample.readFileSyncBytes)),
    readFileSyncCallsMedian: median(firstSamples.map((sample) => sample.readFileSyncCalls)),
    reportHashes: [...new Set(samples.map((sample) => sample.reportHash))],
    archivesLevels: [...new Set(samples.map((sample) => sample.archivesLevel))],
    jsonl: runs[0]?.samples[0]?.jsonl ?? [],
    // Raw per-child readings: round, wall/CPU medians, peak RSS, bytes.
    children: runs.map((run) => ({
      round: run.round,
      maxRssKb: run.maxRssKb,
      wallMsMedian: median(run.samples.map((sample) => sample.wallMs)),
      cpuMsMedian: median(run.samples.map((sample) => sample.cpuMs)),
      readFileSyncBytes: run.samples[0]?.readFileSyncBytes ?? null,
      readFileSyncCalls: run.samples[0]?.readFileSyncCalls ?? null,
    })),
  };
}

function pairSummary(left, right) {
  const a = summarizeRuns(left);
  const b = summarizeRuns(right);
  return {
    a,
    b,
    delta: {
      wallMsPercent: percent(a.wallMsMedian, b.wallMsMedian),
      cpuMsPercent: percent(a.cpuMsMedian, b.cpuMsMedian),
      maxRssPercent: percent(a.maxRssKbMedian, b.maxRssKbMedian),
      readFileSyncBytesPercent: percent(a.readFileSyncBytesMedian, b.readFileSyncBytesMedian),
    },
  };
}

async function main(options) {
  if (options.build) {
    const description = buildFixture(options.fixture, options.scenarios);
    console.log(JSON.stringify({ fixture: options.fixture, scenarios: description }, null, 2));
    return;
  }
  if (!global.gc) throw new Error('run with --expose-gc (the allocation and child modes use it)');
  const fixture = loadFixture(options.fixture);
  const missing = options.scenarios.filter((scenario) => !fixture[scenario]);
  if (missing.length) throw new Error(`fixture is missing scenarios ${missing.join(', ')} (run --build first)`);

  const baselineRev = execFileSync('git', ['-C', REPO, 'rev-parse', options.baselineRev], { encoding: 'utf8' }).trim();
  const baselineSource = execFileSync('git', ['-C', REPO, 'show', `${baselineRev}:lib/diagnostics.js`], { encoding: 'utf8', maxBuffer: 16 * MiB });
  const candidateSource = fs.readFileSync(CANDIDATE_MODULE, 'utf8');
  const baselineHash = sha256(Buffer.from(candidateSource)) === sha256(Buffer.from(baselineSource));
  if (baselineHash) throw new Error(`working tree ${CANDIDATE_MODULE} equals rev ${baselineRev}; there is no change to measure`);
  const baselineModule = join(REPO, 'lib', `.diagnostics-baseline-${baselineRev.slice(0, 12)}.mjs`);
  fs.writeFileSync(baselineModule, baselineSource);
  const cleanups = [() => fs.rmSync(baselineModule, { force: true })];
  if (!options.keepFixture) cleanups.push(() => fs.rmSync(options.fixture, { recursive: true, force: true }));

  try {
    const pairings = { 'A/A': {}, 'A/B': {} };
    const allocation = { 'A/A': {}, 'A/B': {} };
    const allocationControl = {};
    for (const scenario of options.scenarios) {
      const baselineRuns = [];
      const baselineAgainRuns = [];
      const candidateRuns = [];
      let childIndex = 0;
      for (let roundIndex = 0; roundIndex < options.rounds; roundIndex += 1) {
        // Both pairings are fed from the same three children per round, and the
        // order rotates so a slow drift cannot favour one side.
        const order = roundIndex % 2 === 0 ? ['a', 'a2', 'b'] : ['b', 'a2', 'a'];
        for (const role of order) {
          const side = role === 'b' ? CANDIDATE_MODULE : baselineModule;
          const run = await runChildSide(options, side, scenario);
          run.round = roundIndex;
          run.orderIndex = childIndex;
          childIndex += 1;
          if (role === 'a') baselineRuns.push(run);
          else if (role === 'a2') baselineAgainRuns.push(run);
          else candidateRuns.push(run);
        }
      }
      pairings['A/A'][scenario] = pairSummary(baselineRuns, baselineAgainRuns);
      pairings['A/B'][scenario] = pairSummary(baselineRuns, candidateRuns);
      if (options.allocation) {
        const allocationExtra = ['--allocation', '--warmup', '1', '--samples', String(options.allocationCalls)];
        const baselineAllocation = await runChildSide(options, baselineModule, scenario, allocationExtra);
        const baselineAgainAllocation = await runChildSide(options, baselineModule, scenario, allocationExtra);
        const candidateAllocation = await runChildSide(options, CANDIDATE_MODULE, scenario, allocationExtra);
        allocation['A/A'][scenario] = { a: baselineAllocation.allocation, b: baselineAgainAllocation.allocation };
        allocation['A/B'][scenario] = { a: baselineAllocation.allocation, b: candidateAllocation.allocation };
        const controlFile = jsonlFiles(dockyardFor(options.fixture, scenario))[0];
        allocationControl[scenario] = (await runAllocationControl(options, controlFile)).control;
      }
      const hashes = new Set([
        ...pairings['A/A'][scenario].a.reportHashes,
        ...pairings['A/A'][scenario].b.reportHashes,
        ...pairings['A/B'][scenario].b.reportHashes,
      ]);
      if (hashes.size !== 1) throw new Error(`report drift in ${scenario}: ${[...hashes].join(', ')}`);
      // The summary loop and `inspectArchiveIntegrity()` both read these files:
      // the integrity read is shared code and reads the same bytes on both
      // sides. So A's readFileSync covers fixture + integrity, B's readFileSync
      // is integrity only, and the difference must be exactly the fixture bytes
      // and the fixture's file count (one whole-file read per file before, none
      // after).
      const fixtureBytes = fixture[scenario].bytes;
      const fixtureFiles = fixture[scenario].files.length;
      const baselineSide = pairings['A/B'][scenario].a;
      const candidateSide = pairings['A/B'][scenario].b;
      if (baselineSide.readFileSyncCallsMedian - candidateSide.readFileSyncCallsMedian !== fixtureFiles) {
        throw new Error(`whole-file read count differs by more than the fixture in ${scenario}: A ${baselineSide.readFileSyncCallsMedian}, B ${candidateSide.readFileSyncCallsMedian}, files ${fixtureFiles}`);
      }
      if (baselineSide.readFileSyncBytesMedian - candidateSide.readFileSyncBytesMedian !== fixtureBytes) {
        throw new Error(`baseline did not whole-file read every fixture byte in ${scenario}: A ${baselineSide.readFileSyncBytesMedian}, B ${candidateSide.readFileSyncBytesMedian}, fixture ${fixtureBytes}`);
      }
      pairings['A/B'][scenario].bytes = {
        fixture: fixtureBytes,
        fixtureFiles,
        baselineReadFileSync: baselineSide.readFileSyncBytesMedian,
        candidateReadFileSync: candidateSide.readFileSyncBytesMedian,
        baselineReadFileSyncCalls: baselineSide.readFileSyncCallsMedian,
        candidateReadFileSyncCalls: candidateSide.readFileSyncCallsMedian,
        integrityReadBytes: candidateSide.readFileSyncBytesMedian,
      };
      process.stderr.write(`measured ${scenario}\n`);
    }
    const output = {
      schema: SCHEMA,
      generatedAt: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        cpus: cpus().length,
        loadavg: loadavg().map(round),
        maxOldSpaceSizeMb: 4096,
        fixtureRoot: options.fixture,
      },
      sources: {
        baseline: { rev: baselineRev, path: 'lib/diagnostics.js', sha256: sha256(Buffer.from(baselineSource)) },
        candidate: { rev: 'working-tree', path: 'lib/diagnostics.js', sha256: sha256(Buffer.from(candidateSource)) },
        note: 'both sides import the same working-tree lib/ modules; only lib/diagnostics.js differs, and it is the only file this change edits',
      },
      fixture: Object.fromEntries(options.scenarios.map((scenario) => [scenario, fixture[scenario]])),
      method: {
        wallAndCpu: 'one collectDiagnostics() call in a fresh child process per sample; median over the rounds',
        peakRss: 'process.resourceUsage().maxRSS of a fresh child process that ran collectDiagnostics() once (includes process startup)',
        allocation: options.allocation ? `V8 HeapProfiler sampling, interval ${options.allocationInterval} bytes, includes GC-collected objects, per call` : 'disabled',
        bytes: 'whole-file readFileSync calls on the scenario *.jsonl files are counted per side; the fixture byte total is what the summary loop scans on either side',
        equality: 'sha256 of the whole report with generatedAt removed; identical across all sides and pairings',
        aa: 'A/A runs the same baseline module twice; its delta is the noise floor',
      },
      pairings,
      allocation,
      allocationControl,
    };
    if (options.out) {
      fs.mkdirSync(dirname(options.out), { recursive: true });
      fs.writeFileSync(options.out, JSON.stringify(output, null, 2) + '\n');
    }
    if (options.json) console.log(JSON.stringify(output, null, 2));
    else printTable(output, options);
  } finally {
    for (const cleanup of cleanups) cleanup();
  }
}

function printTable(output, options) {
  console.log(`node ${output.environment.node} ${output.environment.platform}, load ${output.environment.loadavg.join('/')}`);
  console.log(`baseline ${output.sources.baseline.rev.slice(0, 12)} ${output.sources.baseline.sha256.slice(0, 12)}  candidate ${output.sources.candidate.sha256.slice(0, 12)}`);
  const columns = ['scenario', 'files', 'MiB', 'pair', 'wall A', 'wall B', 'cpu A', 'cpu B', 'rss A', 'rss B', 'rss delta', 'alloc A', 'alloc B'];
  console.log(columns.join('\t'));
  for (const scenario of options.scenarios) {
    for (const pair of ['A/A', 'A/B']) {
      const summary = output.pairings[pair][scenario];
      const alloc = output.allocation[pair][scenario];
      console.log([
        scenario,
        summary.a.jsonl.length,
        round(output.fixture[scenario].bytes / MiB),
        pair,
        summary.a.wallMsMedian,
        summary.b.wallMsMedian,
        summary.a.cpuMsMedian,
        summary.b.cpuMsMedian,
        summary.a.maxRssKbMedian,
        summary.b.maxRssKbMedian,
        `${summary.delta.maxRssPercent}%`,
        alloc?.a.sampledBytesPerCall ?? 'n/a',
        alloc?.b.sampledBytesPerCall ?? 'n/a',
      ].join('\t'));
    }
  }
}

const options = parseArgs(process.argv.slice(2));
if (options) {
  if (options.child) {
    childMode(options).then((result) => { console.log(JSON.stringify(result)); }, (error) => { console.error(error?.stack || String(error)); process.exitCode = 1; });
  } else {
    main(options).catch((error) => { console.error(error?.stack || String(error)); process.exitCode = 1; });
  }
}
