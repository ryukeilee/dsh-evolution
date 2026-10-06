#!/usr/bin/env node
/**
 * Validate the package before a release without producing artifacts.
 *
 * `npm run pack:check` (and CI) run this instead of a bare `npm pack
 * --dry-run`, because the questions that actually matter for a release are:
 *
 *   1. is the tarball byte-identical across two packs in the same tree?
 *   2. does the archive contain exactly what `package.json#files` declares?
 *   3. does the shipped text leak a local home directory or a credential?
 *   4. is `package-lock.json` consistent with the manifest, so a fresh
 *      `npm ci` in a clean checkout cannot fail on drift?
 *   5. does this tree still produce the *content* that `release/manifest.json`
 *      pins, and is the committed `release/` artifact exactly those bytes?
 *   6. do the README install/doctor/upgrade/rollback/uninstall instructions
 *      and the compatibility declaration agree with the shipped package?
 *
 * Checks 1 and 5 are split on purpose: byte identity is only promised inside
 * one environment, because npm's compression is npm-version-dependent, while
 * the content digest holds everywhere.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  REPO_ROOT, archiveContentDigest, archiveEntries, assertCleanContent, assertCleanEntries,
  assertReproducible, expectedEntries, formatBytes, readManifest, readReleaseManifest,
  readTarEntries, releaseArtifactPath, treeContentDigest,
} from './release-lib.mjs';

const failures = [];
const notes = [];
const check = (name, fn) => {
  try { fn(); notes.push(`  ok    ${name}`); }
  catch (error) { failures.push(`  FAIL  ${name}\n        ${String(error.message).split('\n').join('\n        ')}`); }
};

const manifest = readManifest();

// ---------------------------------------------------------------------------
// 1-3. packaging: reproducible, clean, portable
// ---------------------------------------------------------------------------

const legacyDevReleases = new Set(['0.2.0-dev.1', '0.2.0-dev.2', '0.2.0-dev.3', '0.2.0-dev.4', '0.2.0-dev.5', '0.2.0-dev.6']);
let packed = null;
check('the tarball is byte-identical across two packs', () => {
  packed = assertReproducible();
  notes.push(`        ${packed.filename}  ${formatBytes(packed.bytes)}  sha256 ${packed.sha256}`);
  notes.push(`        contentSha256 ${packed.contentSha256}`);
});
check('the archive contains exactly the declared files', () => {
  const entries = packed ? packed.entries : assertReproducible().entries;
  const count = assertCleanEntries(entries, expectedEntries(manifest));
  notes.push(`        ${count} entries`);
});
check('every shipped entry has a canonical mode', () => {
  // The artifact must not depend on the checkout's umask: a file that happens
  // to be 0600 on one machine and 0644 on another used to change the tarball
  // hash while git tracked no such difference.
  const verified = packed || assertReproducible();
  const modes = [...new Set(verified.entryModes)].sort((a, b) => a - b);
  const unexpected = modes.filter((mode) => mode !== 0o644 && mode !== 0o755);
  if (unexpected.length > 0) {
    throw new Error(`non-canonical archive modes: ${unexpected.map((mode) => `0o${mode.toString(8)}`).join(', ')}`);
  }
  notes.push(`        modes ${modes.map((mode) => `0o${mode.toString(8)}`).join(', ')}`);
});
check('the shipped text carries no home path or credential material', () => {
  assertCleanContent();
});

// ---------------------------------------------------------------------------
// 4. lockfile consistency (a fresh `npm ci` must not be able to fail on drift)
// ---------------------------------------------------------------------------

const lock = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'));
const lockedRoot = lock.packages?.[''];
check('package-lock.json matches package.json', () => {
  if (!lockedRoot) throw new Error('package-lock.json has no root package entry');
  if (lockedRoot.version !== manifest.version) {
    throw new Error(`version drift: package.json=${manifest.version} package-lock.json=${lockedRoot.version}`);
  }
  const normalize = (value) => JSON.stringify(Object.fromEntries(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b))));
  for (const field of ['peerDependencies', 'dependencies', 'devDependencies', 'optionalDependencies']) {
    if (normalize(manifest[field]) !== normalize(lockedRoot[field])) {
      throw new Error(`${field} drift:\n          package.json      = ${normalize(manifest[field])}\n          package-lock.json = ${normalize(lockedRoot[field])}`);
    }
  }
  notes.push(`        lockfileVersion ${lock.lockfileVersion}, version ${lockedRoot.version}`);
});

// ---------------------------------------------------------------------------
// 5. declarations agree with the documentation users actually follow
// ---------------------------------------------------------------------------

const hostVersions = (manifest.peerDependencies?.['@deepseek-ai/dsh'] || '').split('||').map((value) => value.trim()).filter(Boolean);
const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
const compatibility = fs.readFileSync(path.join(REPO_ROOT, 'COMPATIBILITY.md'), 'utf8');
const changelog = fs.readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');

check('the committed acceptance evidence matches this exact package content', () => {
  // The acceptance evidence records the content digest of the tarball it was
  // produced against, plus the byte hash of the pinned artifact. Comparing the
  // content digest means a change to any shipped file invalidates the evidence
  // and forces the host acceptance to be re-run, instead of a release shipping
  // a package the recorded run never saw — and it does so on any platform.
  const verified = packed || assertReproducible();
  const releaseManifest = readReleaseManifest();
  const problems = [];
  for (const host of hostVersions) {
    const file = path.join(REPO_ROOT, 'docs', 'evidence', `dsh-${host}.json`);
    if (!fs.existsSync(file)) { problems.push(`missing docs/evidence/dsh-${host}.json`); continue; }
    let evidence;
    try { evidence = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { problems.push(`docs/evidence/dsh-${host}.json is not valid JSON: ${error.message}`); continue; }
    if (evidence.ok !== true) problems.push(`${host}: the recorded acceptance did not pass`);
    if (evidence.hostVersion !== host) problems.push(`${host}: the evidence was recorded against host ${evidence.hostVersion}`);
    if (evidence.packageVersion !== manifest.version) problems.push(`${host}: the evidence was recorded for package ${evidence.packageVersion}, not ${manifest.version}`);
    if (evidence.contentSha256 !== verified.contentSha256) {
      problems.push(`${host}: the evidence covers content ${evidence.contentSha256}, but this tree builds ${verified.contentSha256}; re-run the host acceptance`);
    }
    if (evidence.tarballSha256 !== releaseManifest.sha256) {
      problems.push(`${host}: the evidence was recorded against ${evidence.tarballSha256}, but the pinned artifact is ${releaseManifest.sha256}`);
    }
  }
  if (problems.length > 0) throw new Error(problems.join('\n        '));
});
check('release/manifest.json pins this tree content', () => {
  const verified = packed || assertReproducible();
  const releaseManifest = readReleaseManifest();
  if (releaseManifest.version !== manifest.version) {
    throw new Error(`release/manifest.json pins version ${releaseManifest.version}, package.json is ${manifest.version}`);
  }
  if (releaseManifest.filename !== verified.filename) {
    throw new Error(`release/manifest.json pins ${releaseManifest.filename}, this tree builds ${verified.filename}`);
  }
  if (releaseManifest.contentSha256 !== verified.contentSha256) {
    throw new Error(`release/manifest.json pins content ${releaseManifest.contentSha256}, but this tree builds ${verified.contentSha256}; re-run "npm run release:publish" after the host acceptance`);
  }
  notes.push(`        pins ${releaseManifest.filename} content ${releaseManifest.contentSha256}`);
});
check('the committed release artifact is exactly the pinned build', () => {
  const releaseManifest = readReleaseManifest();
  const artifact = releaseArtifactPath(releaseManifest);
  if (!fs.existsSync(artifact)) {
    throw new Error(`missing ${path.relative(REPO_ROOT, artifact)}; run "npm run release:publish"`);
  }
  const sha = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
  if (sha !== releaseManifest.sha256) {
    throw new Error(`the committed artifact hashes to ${sha}, but release/manifest.json pins ${releaseManifest.sha256}`);
  }
  const digest = archiveContentDigest(artifact);
  if (digest !== releaseManifest.contentSha256) {
    throw new Error(`the committed artifact contains ${digest}, but release/manifest.json pins ${releaseManifest.contentSha256}`);
  }
  const entries = archiveEntries(artifact);
  if (entries.length !== releaseManifest.entries) {
    throw new Error(`the committed artifact has ${entries.length} entries, release/manifest.json pins ${releaseManifest.entries}`);
  }
  const modes = [...new Set(entries.map((entry) => `0o${entry.mode.toString(8)}`))].sort();
  if (JSON.stringify(modes) !== JSON.stringify(releaseManifest.modes)) {
    throw new Error(`the committed artifact has modes ${JSON.stringify(modes)}, release/manifest.json pins ${JSON.stringify(releaseManifest.modes)}`);
  }
  assertCleanEntries(entries.map((entry) => entry.path), expectedEntries(manifest));
  const sums = path.join(REPO_ROOT, 'release', 'SHA256SUMS');
  if (!fs.existsSync(sums)) throw new Error('release/SHA256SUMS is missing');
  const recorded = fs.readFileSync(sums, 'utf8').trim();
  if (recorded !== `${releaseManifest.sha256}  ${releaseManifest.filename}`) {
    throw new Error(`release/SHA256SUMS records:\n          ${recorded}\n        expected:\n          ${releaseManifest.sha256}  ${releaseManifest.filename}`);
  }
  notes.push(`        ${path.relative(REPO_ROOT, artifact)}  sha256 ${sha}`);
});
check('the working tree still builds the pinned content', () => {
  // Cheap and exact: the same canonical digest computed from the declared files
  // on disk, so a drifted file is named by the diff rather than by a pack hash.
  const releaseManifest = readReleaseManifest();
  const treeDigest = treeContentDigest();
  if (treeDigest !== releaseManifest.contentSha256) {
    const declared = expectedEntries(manifest);
    const pinned = new Map(readTarEntries(releaseArtifactPath(releaseManifest)).map((entry) => [entry.path, entry]));
    const drifted = [];
    for (const relative of declared) {
      const absolute = path.join(REPO_ROOT, relative);
      const current = fs.readFileSync(absolute);
      const committed = pinned.get(relative);
      if (!committed) drifted.push(`${relative}: not in the released artifact`);
      else if (!committed.bytes.equals(current)) drifted.push(`${relative}: content differs from the released artifact`);
    }
    for (const relative of pinned.keys()) {
      if (!declared.includes(relative)) drifted.push(`${relative}: in the released artifact but no longer declared`);
    }
    throw new Error(`the tree builds ${treeDigest}, but release/manifest.json pins ${releaseManifest.contentSha256}\n        re-run the host acceptance and "npm run release:publish" after reviewing the changes\n        ${drifted.slice(0, 20).join('\n        ')}`);
  }
  notes.push(`        tree content ${treeDigest} matches the pin`);
});
check('the version is a semver pre-release, never a plain release', () => {
  if (!/^\d+\.\d+\.\d+-/.test(manifest.version)) {
    throw new Error(`version ${manifest.version} is not a pre-release; a dev/RC artifact must carry a pre-release tag`);
  }
});
check('package.json declares no publish configuration', () => {
  for (const field of ['publishConfig', 'publishConfigRegistry']) {
    if (manifest[field]) throw new Error(`unexpected ${field}: ${JSON.stringify(manifest[field])}`);
  }
});
check('every supported host appears in README and COMPATIBILITY', () => {
  for (const version of hostVersions) {
    if (!readme.includes(version)) throw new Error(`README.md does not mention supported host ${version}`);
    if (!compatibility.includes(version)) throw new Error(`COMPATIBILITY.md does not mention supported host ${version}`);
  }
});
check('the README current version matches the manifest', () => {
  const current = `\`${manifest.version}\``;
  if (!readme.includes(current)) throw new Error(`README.md does not mention the current version ${current}`);
  for (const stale of legacyDevReleases) {
    if (stale !== manifest.version && readme.includes(stale)) {
      throw new Error(`README.md still documents the superseded version ${stale}`);
    }
  }
});
check('the CHANGELOG has an entry for the current version', () => {
  if (!changelog.includes(`## ${manifest.version}`)) throw new Error(`CHANGELOG.md has no "## ${manifest.version}" entry`);
});
check('the README documents install, doctor, upgrade, rollback and uninstall', () => {
  const required = [
    ['install', /plugin --profile \w+ add/],
    ['doctor', /dsh-evolution-doctor|doctor\.mjs/],
    ['upgrade', /升级/],
    ['rollback', /回滚/],
    ['uninstall', /remove dsh-evolution/],
  ];
  for (const [name, pattern] of required) {
    if (!pattern.test(readme)) throw new Error(`README.md has no ${name} instructions`);
  }
});
check('the doctor entry point declared in "bin" exists', () => {
  const bin = manifest.bin?.['dsh-evolution-doctor'];
  if (!bin) throw new Error('package.json declares no dsh-evolution-doctor bin');
  if (!fs.existsSync(path.join(REPO_ROOT, bin))) throw new Error(`bin target ${bin} does not exist`);
  if (!(manifest.files || []).some((entry) => bin.startsWith(entry))) {
    throw new Error(`bin target ${bin} is not covered by package.json#files`);
  }
});

// ---------------------------------------------------------------------------

for (const note of notes) if (!note.startsWith('  ok  ')) console.log(note.trimEnd());
console.log(`pack:check ${manifest.name}@${manifest.version}`);
for (const note of notes) if (note.startsWith('  ok  ')) console.log(note);
if (failures.length > 0) {
  console.error('\nchecks failed:');
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log('\nall package checks passed');
