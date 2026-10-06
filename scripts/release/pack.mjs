#!/usr/bin/env node
/**
 * Build the release artifacts into ./dist:
 *
 *   dsh-evolution-<version>.tgz   the packed bundle
 *   SHA256SUMS                    the checksum of that exact tarball
 *
 * The pack is verified before it is published locally: the tree is packed
 * twice and the two tarballs must be byte-identical, the archive can contain
 * only the entries declared by `package.json#files` (plus the always-included
 * manifest files), and the shipped text must not mention a local home
 * directory or carry credential-shaped material.
 *
 * Usage: node scripts/release/pack.mjs [--dist <dir>]
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  DIST_DIR, REPO_ROOT, assertCleanContent, assertCleanEntries, assertReproducible,
  expectedEntries, formatBytes, packOnce, readManifest,
} from './release-lib.mjs';

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
console.log(`  reproducible tarball ${verified.sha256}`);
console.log(`  ${entryCount} entries, all inside the declared "files" allow-list`);

fs.rmSync(options.dist, { recursive: true, force: true });
fs.mkdirSync(options.dist, { recursive: true });
const built = packOnce(options.dist);
if (built.sha256 !== verified.sha256) {
  throw new Error(`the artifact written to dist does not match the verified pack: ${built.sha256} !== ${verified.sha256}`);
}
const target = built.file;

// The canonical checksum list is committed at the repository root (the tarball
// itself is not), so the reviewed commit names the exact artifact; a copy stays
// next to the artifact in dist/.
const line = `${built.sha256}  ${path.basename(target)}\n`;
fs.writeFileSync(path.join(options.dist, 'SHA256SUMS'), line);
fs.writeFileSync(path.join(REPO_ROOT, 'SHA256SUMS'), line);

console.log('');
console.log(`artifacts in ${options.dist}`);
console.log(`  ${path.basename(target)}  ${formatBytes(built.bytes)}  sha256 ${built.sha256}`);
console.log('  SHA256SUMS (+ the committed copy at the repository root)');
