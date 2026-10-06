#!/usr/bin/env node
/**
 * Build a local release build into ./dist:
 *
 *   dsh-evolution-<version>.tgz   the packed bundle
 *   manifest.json                 what this build contains and which bytes it has
 *   SHA256SUMS                    the checksum of that exact tarball
 *
 * The pack is verified before it is written: the tree is packed twice and the
 * two tarballs must be byte-identical *in this environment*, the archive can
 * contain only the entries declared by `package.json#files` (plus the
 * always-included manifest files), and the shipped text must not mention a
 * local home directory or carry credential-shaped material.
 *
 * This does not publish anything and does not touch the committed pin in
 * `release/`. A build made with a different npm version has the same
 * `contentSha256` but different compressed bytes, so publishing is an explicit
 * second step: `npm run release:publish`.
 *
 * Usage: node scripts/release/pack.mjs [--dist <dir>]
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  DIST_DIR, assertCleanContent, assertCleanEntries, assertReproducible,
  expectedEntries, formatBytes, packOnce, readManifest,
} from './release-lib.mjs';
import { execFileSync } from 'node:child_process';

function parseArgs(argv) {
  const options = { dist: DIST_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--dist') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error('--dist requires a value');
      options.dist = path.resolve(next);
      index += 1;
    } else if (argv[index] === '--help' || argv[index] === '-h') {
      console.log('node scripts/release/pack.mjs [--dist <dir>]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argv[index]}`);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const manifest = readManifest();
const expected = expectedEntries(manifest);

console.log(`dsh-evolution ${manifest.version}: packing twice into a temporary directory to prove reproducibility`);
const verified = assertReproducible();
const entryCount = assertCleanEntries(verified.entries, expected);
assertCleanContent(verified.entries);
console.log(`  byte-identical in this environment: ${verified.sha256}`);
console.log(`  content digest (environment-independent): ${verified.contentSha256}`);
console.log(`  ${entryCount} entries, all inside the declared "files" allow-list`);

fs.rmSync(options.dist, { recursive: true, force: true });
fs.mkdirSync(options.dist, { recursive: true });
const built = packOnce(options.dist);
if (built.sha256 !== verified.sha256 || built.contentSha256 !== verified.contentSha256) {
  throw new Error(`the artifact written to dist does not match the verified pack (${built.sha256} / ${built.contentSha256})`);
}
const target = built.file;

const builtWith = {
  node: process.version,
  npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
  platform: `${process.platform}-${process.arch}`,
};
const buildManifest = {
  name: manifest.name,
  version: manifest.version,
  filename: built.filename,
  sha256: built.sha256,
  contentSha256: built.contentSha256,
  entries: built.entries.length,
  modes: [...new Set(built.entryModes)].sort((a, b) => a - b).map((mode) => `0o${mode.toString(8)}`),
  builtWith,
};
fs.writeFileSync(path.join(options.dist, 'manifest.json'), `${JSON.stringify(buildManifest, null, 2)}\n`);
fs.writeFileSync(path.join(options.dist, 'SHA256SUMS'), `${built.sha256}  ${built.filename}\n`);

console.log('');
console.log(`artifacts in ${options.dist}`);
console.log(`  ${built.filename}  ${formatBytes(built.bytes)}  sha256 ${built.sha256}`);
console.log(`  manifest.json  (built with node ${builtWith.node}, npm ${builtWith.npm}, ${builtWith.platform})`);
console.log('  SHA256SUMS');
console.log('');
console.log('to pin this build as the published artifact, run: npm run release:publish');
