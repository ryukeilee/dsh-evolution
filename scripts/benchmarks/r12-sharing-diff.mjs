/**
 * Byte-exact correctness differential for R12's diagnoseSharing() rewrite.
 *
 * Loads the pre-fix and post-fix implementations from two separate source
 * trees in one process, runs both against the same synthetic fixture, and
 * compares the full promotion.sharing check (every field, including evidence)
 * and the full readPublishedPluginReview() output as JSON bytes.
 *
 *   node scripts/benchmarks/r12-sharing-diff.mjs \
 *     --baseline <tree> --candidate <tree> --fixture <dir> --out <json>
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i].startsWith('--')) { args[process.argv[i].slice(2)] = process.argv[i + 1]; i += 1; }
}
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const load = async (root, name) => import(pathToFileURL(path.join(path.resolve(root), 'lib', name)).href);
const [baseDiagnostics, candDiagnostics, baseReview, candReview] = await Promise.all([
  load(args.baseline, 'diagnostics.js'), load(args.candidate, 'diagnostics.js'),
  load(args.baseline, 'self-evolution-review.js'), load(args.candidate, 'self-evolution-review.js'),
]);
const fixture = path.resolve(args.fixture);
const host = { dsh: '0.2.2-rc.5', cordis: '4.1.0', include: '1.1.0', node: process.version, verifiedAt: '2026-01-02T00:00:00.000Z' };
const paths = candDiagnostics.resolveEvolutionPaths({ dshHome: fixture });
const doctorOptions = { dshHome: fixture, home: true, probe: { skipComposition: true } };
const reviewOptions = { paths: { dataRoot: paths.dataRoot, pluginRoot: paths.pluginRoot }, host, usage: null, usageStatus: null };
const doctor = async (module) => {
  const report = await module.collectDiagnostics(doctorOptions);
  return JSON.stringify(report.checks.find((check) => check.id === 'promotion.sharing'));
};
const review = async (module) => JSON.stringify(await module.readPublishedPluginReview(reviewOptions));
const result = {};
for (const [name, fn, a, b] of [
  ['promotion.sharing', doctor, baseDiagnostics, candDiagnostics],
  ['self-evolution-review', review, baseReview, candReview],
]) {
  const left = await fn(a);
  const right = await fn(b);
  result[name] = {
    byteEqual: left === right,
    baselineBytes: Buffer.byteLength(left), candidateBytes: Buffer.byteLength(right),
    baselineSha256: sha256(left), candidateSha256: sha256(right),
  };
  if (left !== right) {
    let i = 0;
    while (i < left.length && left[i] === right[i]) i += 1;
    result[name].firstDifferenceAt = i;
    result[name].baselineWindow = left.slice(Math.max(0, i - 120), i + 240);
    result[name].candidateWindow = right.slice(Math.max(0, i - 120), i + 240);
  }
}
const payload = { fixture, baseline: path.resolve(args.baseline), candidate: path.resolve(args.candidate), result };
if (args.out) fs.writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (!Object.values(result).every((value) => value.byteEqual)) process.exit(1);
