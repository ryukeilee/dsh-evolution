// Bounded `isSensitiveKey` memo: alternating A/B benchmark.
//
// A = pre-memo implementation (produced by reverting the memo block in a temp
// copy of lib/), B = current working tree. Each round is a fresh child process
// with an identical signed fixture; order alternates A,B -> B,A -> ...
// process.cpuUsage is the primary signal; wall and maxRSS are reported too.
//
//   node --max-old-space-size=4096 scripts/benchmarks/sensitive-key-memo.mjs \
//     --records 20000 --rounds 4 --out docs/performance/sensitive-key-memo.json
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SCRIPT), '../..');
const WORKER = path.join(path.dirname(SCRIPT), 'sensitive-key-memo-worker.mjs');

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}
const opt = args(process.argv.slice(2));
const records = Number(opt.records || 20000);
const rounds = Number(opt.rounds || 4);
const outFile = opt.out ? path.resolve(opt.out) : null;
assert.ok(Number.isSafeInteger(records) && records > 0, '--records must be a positive integer');
assert.ok(Number.isSafeInteger(rounds) && rounds >= 3, '--rounds must be >= 3');

// The memo block in the working tree, bounded by stable anchors.
const memorySrc = fs.readFileSync(path.join(REPO, 'lib/dockyard-domain/memory.js'), 'utf8');
const START = 'const SENSITIVE_KEY_CACHE_MAX = 512;';
const END = '\nfunction redact(';
const s = memorySrc.indexOf(START);
const e = memorySrc.indexOf(END, s);
assert.ok(s >= 0 && e > s, 'memo block anchors must exist');
const memoBlock = memorySrc.slice(s, e);
const originalBlock = `function isSensitiveKey(key) {
  const normalized = String(key).toLowerCase();
  return SENSITIVE_KEY_PARTS.some((needle) => normalized.includes(needle));
}
`;
assert.ok(memoBlock.includes('sensitiveKeyCache'), 'working tree must contain the memo');
assert.ok(!originalBlock.includes('sensitiveKeyCache'), 'baseline block must not contain the memo');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'r12-skm-ab-'));
function buildLib(name, transform) {
  const dir = path.join(temp, name);
  fs.cpSync(path.join(REPO, 'lib'), dir, { recursive: true });
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'));
  if (transform) {
    const file = path.join(dir, 'dockyard-domain/memory.js');
    const src = fs.readFileSync(file, 'utf8');
    assert.equal(src.indexOf(START), s, `${name}: memo start offset differs from working tree`);
    assert.equal(src.indexOf(END, s), e, `${name}: memo end offset differs from working tree`);
    fs.writeFileSync(file, src.slice(0, s) + transform + src.slice(e));
  }
  return dir;
}
const aa = Boolean(opt.aa);
const libA = buildLib('baseline', originalBlock);
const libB = aa ? buildLib('candidate-aa', originalBlock) : buildLib('candidate', null);

function run(libRoot) {
  const result = spawnSync(process.execPath, [
    '--max-old-space-size=4096', '--expose-gc', WORKER,
  ], {
    env: { ...process.env, R12_LIB: libRoot, R12_RECORDS: String(records) },
    encoding: 'utf8',
    timeout: 300000,
  });
  if (result.status !== 0) {
    throw new Error(`worker failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim());
}

const measurements = [];
for (let round = 0; round < rounds; round += 1) {
  const order = round % 2 === 0 ? ['A', 'B'] : ['B', 'A'];
  const sides = { A: libA, B: libB };
  for (const side of order) {
    measurements.push({ round: round + 1, order: side, ...run(sides[side]) });
  }
  process.stderr.write(`round ${round + 1} done (${order.join(' then ')})\n`);
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
function summarize(side) {
  const rows = measurements.filter((m) => m.order === side);
  const pick = (getter) => rows.map(getter);
  return {
    open: { wallMs: median(pick((m) => m.open.wallMs)), cpuMs: median(pick((m) => m.open.cpuMs)) },
    flush: { wallMs: median(pick((m) => m.flush.wallMs)), cpuMs: median(pick((m) => m.flush.cpuMs)) },
    observe: { wallMs: median(pick((m) => m.observe.wallMs)), cpuMs: median(pick((m) => m.observe.cpuMs)) },
    retainedHeapBytes: median(pick((m) => m.retainedHeapBytes)),
    maxRSSKiB: median(pick((m) => m.maxRSSKiB)),
  };
}
const summary = { A: summarize('A'), B: summarize('B') };
const fixtureHashes = new Set(measurements.map((m) => m.fixtureHash));
assert.equal(fixtureHashes.size, 1, 'all rounds must use the identical fixture');
const relative = (a, b) => +(((b - a) / a) * 100).toFixed(2);
const report = {
  method: {
    records, rounds, primaryMetric: 'process.cpuUsage (user+system)',
    alternation: 'A,B -> B,A -> ...; fresh child process per side per round',
    heapLimit: '4096 MiB', fixtureHash: [...fixtureHashes][0],
    note: 'Other builders may run concurrently; CPU is paired and alternating, wall is secondary.',
  },
  summary,
  relativePercent: {
    openCpu: relative(summary.A.open.cpuMs, summary.B.open.cpuMs),
    observeCpu: relative(summary.A.observe.cpuMs, summary.B.observe.cpuMs),
    openWall: relative(summary.A.open.wallMs, summary.B.open.wallMs),
  },
  measurements,
};
const text = JSON.stringify(report, null, 2) + '\n';
if (outFile) fs.writeFileSync(outFile, text);
else process.stdout.write(text);
fs.rmSync(temp, { recursive: true, force: true });
process.stderr.write(`summary cpu open ${summary.A.open.cpuMs.toFixed(1)} -> ${summary.B.open.cpuMs.toFixed(1)} ms (${report.relativePercent.openCpu}%)\n`);
