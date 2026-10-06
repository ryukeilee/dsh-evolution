#!/usr/bin/env node
/**
 * Pin the current ./dist build as the published artifact under ./release.
 *
 * This is the only thing that writes `release/manifest.json`, and it is a
 * deliberate, reviewable step rather than a side effect of packing:
 *
 *   release/dsh-evolution-<version>.tgz   the exact bytes that get published
 *   release/manifest.json                 their checksum and content digest
 *   release/SHA256SUMS                    the checksum file attached to the release
 *
 * Why the bytes are committed at all: `npm pack` compresses through the bundled
 * zlib, so npm 10 and npm 11 produce different bytes for byte-identical
 * content. A release must still name one exact artifact, so the artifact is
 * stored and verified rather than rebuilt and hoped for.
 *
 * Refuses to pin a build whose content differs from the tree's declared files,
 * and refuses to change a pin silently: pass --force to replace one.
 *
 * Usage: node scripts/release/publish-artifact.mjs [--from <dir>] [--force]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DIST_DIR, RELEASE_DIR, assertCleanContent, assertCleanEntries, assertReproducible,
  expectedEntries, gitOutput, packageFileName, readManifest, releaseArtifactPath, readReleaseManifest,
} from './release-lib.mjs';

function parseArgs(argv) {
  const options = { from: DIST_DIR, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--from') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error('--from requires a value');
      options.from = path.resolve(next);
      index += 1;
    } else if (argv[index] === '--force') options.force = true;
    else if (argv[index] === '--help' || argv[index] === '-h') {
      console.log('node scripts/release/publish-artifact.mjs [--from <dir>] [--force]');
      process.exit(0);
    } else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const manifest = readManifest();
const filename = packageFileName(manifest);
const built = path.join(options.from, filename);
if (!fs.existsSync(built)) throw new Error(`no build at ${built}; run "npm run release:pack" first`);

// The build we are about to pin must still be what this tree declares.
const expected = expectedEntries(manifest);
const verified = assertReproducible();
assertCleanEntries(verified.entries, expected);
assertCleanContent(verified.entries);
const builtSha = crypto.createHash('sha256').update(fs.readFileSync(built)).digest('hex');
if (verified.contentSha256 !== JSON.parse(fs.readFileSync(path.join(options.from, 'manifest.json'), 'utf8')).contentSha256) {
  throw new Error('the build manifest does not describe this tree; re-run "npm run release:pack"');
}
if (builtSha !== JSON.parse(fs.readFileSync(path.join(options.from, 'manifest.json'), 'utf8')).sha256) {
  throw new Error('the built tarball does not match its own build manifest');
}

const existingPath = path.join(RELEASE_DIR, 'manifest.json');
if (fs.existsSync(existingPath) && !options.force) {
  const existing = readReleaseManifest();
  if (existing.sha256 !== builtSha) {
    throw new Error(`${path.relative(process.cwd(), existingPath)} already pins ${existing.sha256}; pass --force to replace it`);
  }
  console.log(`release/manifest.json already pins ${builtSha}; nothing to do`);
  process.exit(0);
}

const buildManifest = JSON.parse(fs.readFileSync(path.join(options.from, 'manifest.json'), 'utf8'));
const hosts = (manifest.peerDependencies['@deepseek-ai/dsh'] || '').split('||').map((value) => value.trim()).filter(Boolean);
// The commit this artifact was built from. It is recorded on purpose: the
// release workflow refuses to publish a new release whose pin does not name a
// commit in the tagged history, so a pin cannot be copied onto a tag it did
// not come from. The release commit that carries this file is a later commit,
// so `sourceCommit` is checked as an ancestor of the tag, not as an equality.
const sourceCommit = gitOutput(['rev-parse', 'HEAD']);
if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
  throw new Error(`git returned an unusable commit id: ${JSON.stringify(sourceCommit)}`);
}
const releaseManifest = {
  name: manifest.name,
  version: manifest.version,
  filename,
  sha256: builtSha,
  contentSha256: verified.contentSha256,
  entries: verified.entries.length,
  modes: buildManifest.modes,
  builtWith: buildManifest.builtWith,
  sourceCommit,
  // The acceptance evidence recorded against exactly these bytes.
  verifiedHosts: hosts,
  evidence: hosts.map((host) => `docs/evidence/dsh-${host}.json`),
};

fs.mkdirSync(RELEASE_DIR, { recursive: true });
fs.copyFileSync(built, releaseArtifactPath(releaseManifest));
fs.writeFileSync(existingPath, `${JSON.stringify(releaseManifest, null, 2)}\n`);
fs.writeFileSync(path.join(RELEASE_DIR, 'SHA256SUMS'), `${builtSha}  ${filename}\n`);

console.log(`pinned ${filename}`);
console.log(`  sha256 (published bytes)      ${builtSha}`);
console.log(`  contentSha256 (any platform)  ${verified.contentSha256}`);
console.log(`  entries                       ${verified.entries.length}`);
console.log(`  sourceCommit                  ${sourceCommit}`);
console.log('');
console.log('now re-run the host acceptance so ./docs/evidence matches these bytes, then');
console.log('run "npm run pack:check" and commit release/ together with the evidence.');
