#!/usr/bin/env node
// Fixed counters on the candidate's real cold-replay fixture; never use its time as A/B evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const arg = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const records = Number(arg('--records', '20000'));
const out = arg('--out', 'docs/performance/marker-window-incremental-mechanism.json');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-window-mechanism-'));
try {
  fs.cpSync(path.join(repo, 'lib'), path.join(temp, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'package.json'), '{"type":"module"}');
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(temp, 'node_modules'), 'dir');
  const file = path.join(temp, 'lib/domain-storage.js');
  let source = fs.readFileSync(file, 'utf8');
  const sources = Object.fromEntries(['lib/domain-storage.js', 'lib/dockyard-domain/memory.js'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex')]));
  for (const [needle, replacement] of [
    ['  if (windowCheck?.verified === true) return;', '  if (windowCheck?.verified === true) { globalThis.__windowStats.cachedWindows++; return; }'],
    ['  for (const marker of markers) {', '  globalThis.__windowStats.markerVisits += markers.length;\n  for (const marker of markers) {'],
    ['      const markerText = JSON.stringify(marker);', '      globalThis.__windowStats.markerSerializations++;\n      const markerText = JSON.stringify(marker);'],
  ]) {
    assert.equal(source.split(needle).length - 1, 1);
    source = source.replace(needle, replacement);
  }
  fs.writeFileSync(file, source);
  const hook = path.join(temp, 'hook.mjs');
  fs.writeFileSync(hook, 'export function install() { return { start() { globalThis.__windowStats = { markerVisits: 0, markerSerializations: 0, cachedWindows: 0 }; }, stop() { return { ...globalThis.__windowStats }; } }; }');
  const root = path.join(temp, 'data'); fs.mkdirSync(root);
  const result = JSON.parse(execFileSync(process.execPath, ['--expose-gc', '--max-old-space-size=4096', path.join(repo, 'scripts/benchmarks/archive-append-window.mjs'), '--child'], { cwd: repo, env: { ...process.env, BENCH_TREE: temp, BENCH_ROOT: root, BENCH_ENVELOPE: repo, BENCH_RECORDS: String(records), BENCH_OBSERVES: '0', BENCH_FLUSHES: '0', BENCH_AUDIT_MODULE: pathToFileURL(hook).href }, encoding: 'utf8' }));
  assert.equal(result.audit.markerVisits, records - 1);
  assert.equal(result.audit.markerSerializations, records - 1);
  fs.writeFileSync(out, JSON.stringify({ sources, records, node: process.version, platform: `${process.platform}/${process.arch}`, result }, null, 2) + '\n');
  console.log(JSON.stringify(result.audit));
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
