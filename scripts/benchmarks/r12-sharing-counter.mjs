/**
 * Deterministic counter-evidence for R12's diagnoseSharing() rewrite.
 *
 * Copies a source tree's lib/ to a temporary directory, wraps the shared
 * consumerActivationRows() helper with a call counter, then runs one real
 * collectDiagnostics() over a synthetic fixture. The pre-fix implementation
 * materialises the same activation-row projection six times per consumer
 * profile; the post-fix implementation materialises it once. No timing is
 * involved, so the assertion is stable across machines.
 *
 *   node scripts/benchmarks/r12-sharing-counter.mjs \
 *     --libroot <tree> --fixture <dir> --expect <count> --out <json>
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = {};
for (const argv of process.argv.slice(2)) {
  if (argv.startsWith('--')) { args[argv.slice(2)] = process.argv[process.argv.indexOf(argv) + 1]; }
}
const src = path.resolve(args.libroot);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r12-counter-'));
try {
  fs.cpSync(path.join(src, 'lib'), path.join(tmp, 'lib'), { recursive: true });
  fs.symlinkSync(path.join(src, 'node_modules'), path.join(tmp, 'node_modules'));
  const file = path.join(tmp, 'lib', 'promoted-sharing.js');
  const original = fs.readFileSync(file, 'utf8');
  const needle = 'export function consumerActivationRows(state) {';
  assert.equal(original.includes(needle), true, 'instrumentation point not found');
  fs.writeFileSync(file, original.replace(needle,
    `${needle}\n  globalThis.__r12ActivationRowsCalls = (globalThis.__r12ActivationRowsCalls ?? 0) + 1;`));
  const diagnostics = await import(pathToFileURL(path.join(tmp, 'lib', 'diagnostics.js')).href);
  const fixture = path.resolve(args.fixture);
  await diagnostics.collectDiagnostics({ dshHome: fixture, home: true, probe: { skipComposition: true } });
  const calls = globalThis.__r12ActivationRowsCalls ?? 0;
  const payload = { libroot: src, fixture, consumerActivationRowsCalls: calls, expect: Number(args.expect) };
  assert.equal(calls, Number(args.expect), `expected ${args.expect} activation-row projections, got ${calls}`);
  if (args.out) fs.writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify(payload));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
