/**
 * R12 startup NO-CHANGE evidence: marginal cost of removing the static
 * lib/diagnostics.js import from lib/index.js.
 *
 * Builds a temporary copy of a source tree whose diagnose() closure imports
 * diagnostics.js lazily, then alternates cold import() of lib/index.js between
 * the shipped (static) tree and the experimental (lazy) tree in fresh child
 * processes. Nothing calls apply(); no real DSH_HOME is touched.
 *
 *   node scripts/benchmarks/r12-startup-lazy.mjs \
 *     --baseline <tree> --rounds 4 --out docs/performance/r12-startup-import.json
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i].startsWith('--')) { args[process.argv[i].slice(2)] = process.argv[i + 1]; i += 1; }
}
const baseline = path.resolve(args.baseline);
const rounds = Number(args.rounds || 4);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r12-startup-lazy-'));
try {
  const lazy = path.join(tmp, 'lazy-tree');
  fs.mkdirSync(lazy, { recursive: true });
  fs.cpSync(path.join(baseline, 'lib'), path.join(lazy, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(baseline, 'package.json'), path.join(lazy, 'package.json'));
  fs.symlinkSync(path.join(baseline, 'node_modules'), path.join(lazy, 'node_modules'));
  const entry = path.join(lazy, 'lib', 'index.js');
  let source = fs.readFileSync(entry, 'utf8');
  const staticImport = "import { runDiagnostics } from './diagnostics.js';\n";
  const callSite = 'resolved.diagnose = (options = {}) => runDiagnostics({';
  assert.equal(source.includes(staticImport), true, 'static diagnostics import not found');
  assert.equal(source.includes(callSite), true, 'diagnose closure not found');
  source = source.replace(staticImport, '').replace(callSite,
    "resolved.diagnose = async (options = {}) => (await import('./diagnostics.js')).runDiagnostics({");
  fs.writeFileSync(entry, source);
  const measure = (root, kind, round) => {
    const script = "const c=process.cpuUsage();const s=performance.now();await import('./lib/index.js');const u=process.cpuUsage(c);console.log(JSON.stringify({kind:process.argv[1],round:Number(process.argv[2]),cpuMs:(u.user+u.system)/1000,wallMs:performance.now()-s,rssKiB:process.resourceUsage().maxRSS}))";
    const result = spawnSync(process.execPath, ['--max-old-space-size=4096', '--input-type=module', '-e', script, kind, String(round)],
      { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (result.status !== 0) throw new Error(`${kind} child failed: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const samples = [];
  for (let round = 1; round <= rounds; round += 1) {
    const order = round % 2 === 1 ? ['static', 'lazy'] : ['lazy', 'static'];
    for (const kind of order) samples.push(measure(kind === 'static' ? baseline : lazy, kind, round));
  }
  const payload = {
    note: 'Cold import() of lib/index.js in fresh processes, alternating order. Lazy tree drops the static diagnostics.js import and imports it inside the async diagnose() closure. No apply(), no real DSH_HOME.',
    node: process.version, platform: `${process.platform}/${process.arch}`, entry: 'lib/index.js',
    baseline, rounds, samples,
    decision: 'NO CHANGE: the marginal end-to-end saving is a few milliseconds of CPU; the async tool contract and the first-use failure window are not worth it.',
  };
  fs.writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify({ rounds, sampleCount: samples.length, out: args.out }));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
