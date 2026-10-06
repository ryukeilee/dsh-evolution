#!/usr/bin/env node
/**
 * Verify a tarball against the committed pin in `release/manifest.json`.
 *
 * This is the check that has to hold for the *published* file: the exact bytes
 * (SHA256) and the environment-independent content digest. Run it on the
 * committed artifact, on the CI-built artifact, and on the file downloaded back
 * from the GitHub Release — the same command proves all three are the same
 * package.
 *
 * Usage: node scripts/release/verify-artifact.mjs [<tarball>] [--content-only] [--json]
 *
 * `--content-only` drops the byte-hash and filename checks. Use it on a build
 * made here rather than on the published file: npm's compression varies with
 * the npm version, so a locally rebuilt tarball legitimately has different
 * bytes and the same content.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, archiveEntries, archiveContentDigest, readReleaseManifest, releaseArtifactPath } from './release-lib.mjs';

const args = process.argv.slice(2);
let json = false;
let contentOnly = false;
let file = null;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--json') json = true;
  else if (args[index] === '--content-only') contentOnly = true;
  else if (args[index] === '--help' || args[index] === '-h') {
    console.log('node scripts/release/verify-artifact.mjs [<tarball>] [--content-only] [--json]');
    process.exit(0);
  } else if (args[index].startsWith('--')) throw new Error(`unknown argument: ${args[index]}`);
  else file = path.resolve(args[index]);
}

const manifest = readReleaseManifest();
const target = file || releaseArtifactPath(manifest);
const problems = [];

if (!fs.existsSync(target)) {
  console.error(`missing tarball: ${target}`);
  process.exit(2);
}
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
const contentSha256 = archiveContentDigest(target);
const entries = archiveEntries(target);
const modes = [...new Set(entries.map((entry) => `0o${entry.mode.toString(8)}`))].sort();

const expectedName = path.basename(target);
if (!contentOnly) {
  if (file && expectedName !== manifest.filename) {
    problems.push(`filename is ${expectedName}, expected ${manifest.filename}`);
  }
  if (sha256 !== manifest.sha256) problems.push(`sha256 is ${sha256}, expected ${manifest.sha256}`);
}
if (contentSha256 !== manifest.contentSha256) problems.push(`contentSha256 is ${contentSha256}, expected ${manifest.contentSha256}`);
if (entries.length !== manifest.entries) problems.push(`entries is ${entries.length}, expected ${manifest.entries}`);
if (JSON.stringify(modes) !== JSON.stringify(manifest.modes)) {
  problems.push(`modes are ${JSON.stringify(modes)}, expected ${JSON.stringify(manifest.modes)}`);
}

const report = {
  file: path.relative(REPO_ROOT, target),
  name: manifest.name,
  version: manifest.version,
  contentOnly,
  sha256,
  contentSha256,
  entries: entries.length,
  modes,
  ok: problems.length === 0,
  problems,
};

if (json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`verify-artifact ${report.file}${contentOnly ? ' (content only)' : ''}`);
  if (!contentOnly) {
    console.log(`  sha256 (published bytes)     ${sha256}${sha256 === manifest.sha256 ? '' : '   <-- MISMATCH'}`);
  }
  console.log(`  contentSha256                ${contentSha256}${contentSha256 === manifest.contentSha256 ? '' : '   <-- MISMATCH'}`);
  console.log(`  entries                      ${entries.length}`);
  console.log(`  modes                        ${modes.join(', ')}`);
  if (problems.length > 0) {
    console.error('\nmismatches:');
    for (const problem of problems) console.error(`  - ${problem}`);
  } else {
    console.log(`  matches release/manifest.json (${manifest.name}@${manifest.version})`);
  }
}
process.exit(problems.length === 0 ? 0 : 1);
