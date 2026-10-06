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
 *   5. do the README install/doctor/upgrade/rollback/uninstall instructions
 *      and the compatibility declaration agree with the shipped package?
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  REPO_ROOT, assertCleanContent, assertCleanEntries, assertReproducible,
  expectedEntries, formatBytes, readManifest,
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

check('the committed acceptance evidence matches this exact tarball', () => {
  // The acceptance evidence records the SHA256 of the tarball it was produced
  // against. Pinning that here means a change to any shipped file invalidates
  // the evidence and forces the host acceptance to be re-run, instead of a
  // release shipping a package the recorded run never saw.
  const sha = packed ? packed.sha256 : assertReproducible().sha256;
  const problems = [];
  for (const host of hostVersions) {
    const file = path.join(REPO_ROOT, 'docs', 'evidence', `dsh-${host}.json`);
    if (!fs.existsSync(file)) { problems.push(`missing docs/evidence/dsh-${host}.json`); continue; }
    let evidence;
    try { evidence = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { problems.push(`docs/evidence/dsh-${host}.json is not valid JSON: ${error.message}`); continue; }
    if (evidence.ok !== true) problems.push(`${host}: the recorded acceptance did not pass`);
    if (evidence.hostVersion !== host) problems.push(`${host}: the evidence was recorded against host ${evidence.hostVersion}`);
    if (evidence.packageVersion !== manifest.version) problems.push(`${host}: the evidence was recorded for package ${evidence.packageVersion}, not ${manifest.version}`);
    if (evidence.tarballSha256 !== sha) problems.push(`${host}: the evidence covers tarball ${evidence.tarballSha256}, but this tree packs to ${sha}; re-run the host acceptance`);
  }
  if (problems.length > 0) throw new Error(problems.join('\n        '));
});
check('the version is a semver pre-release, never a plain release', () => {
  if (!/^\d+\.\d+\.\d+-/.test(manifest.version)) {
    throw new Error(`version ${manifest.version} is not a pre-release; a dev/RC artifact must carry a pre-release tag`);
  }
});

check('the committed SHA256SUMS names exactly this tarball', () => {
  const verified = packed || assertReproducible();
  const file = path.join(REPO_ROOT, 'SHA256SUMS');
  if (!fs.existsSync(file)) throw new Error('SHA256SUMS is missing; run "npm run release:pack"');
  const expected = `${verified.sha256}  ${verified.filename}`;
  const recorded = fs.readFileSync(file, 'utf8').trim();
  if (recorded !== expected) {
    throw new Error(`SHA256SUMS records:\n          ${recorded}\n        this tree packs to:\n          ${expected}\n        run "npm run release:pack"`);
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
