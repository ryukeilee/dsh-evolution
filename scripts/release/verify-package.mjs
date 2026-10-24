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
 *
 * Question 5 has two states, and they are never confused:
 *
 *   - development (the default, and what CI runs on `main` and on pull
 *     requests): the pin must still describe immutable history and the tree
 *     must be the pinned release *or* a committed successor of it. This is the
 *     state a repository is in from the first changed shipped file until the
 *     next release is cut, and it is reported by name, with the differing
 *     files, instead of failing;
 *   - `--release` (what a tagged release runs): the tree must build the pinned
 *     content exactly, byte for byte, as before. A drifting tree fails here.
 *
 * The tolerance is not a way to ship: `verify-provenance.mjs` still refuses a
 * tag whose tree content differs from the pin, so the publishing path is
 * unchanged. See `pin-relation.mjs` and RELEASE.md section 6 item 16.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DuplicateJsonKeyError, REPO_ROOT, assertCleanContent, assertCleanEntries,
  assertReproducible, contentDigestOf, expectedEntries, formatBytes, parseJsonText, pinnedArtifactFile,
  pinnedArtifactStatus, readManifest, readReleaseManifest, readTarEntries, releaseRootFileStatus, treeContentDigest,
} from './release-lib.mjs';
import { PIN_RELATION, collectPinRelation, formatRelation } from './pin-relation.mjs';

const args = process.argv.slice(2);
for (const arg of args) {
  if (arg === '--help' || arg === '-h') {
    console.log('node scripts/release/verify-package.mjs [--release]');
    process.exit(0);
  }
  if (arg !== '--release') {
    // Fixed categories only: an unrecognised token is caller data, so it is not
    // echoed beside the usage this line already prints.
    console.error('unknown argument; usage: node scripts/release/verify-package.mjs [--release]');
    process.exit(2);
  }
}
/** `--release` demands the tagged tree; the default reports development state. */
const releaseMode = args.includes('--release');

const failures = [];
const notes = [];
const check = (name, fn) => {
  try { fn(); notes.push(`  ok    ${name}`); }
  catch (error) { failures.push(`  FAIL  ${name}\n        ${String(error.message).split('\n').join('\n        ')}`); }
};

/**
 * Package metadata, read the same duplicate-safe way `release:pack` and
 * `release:publish` read it. A refusal here happens before anything is packed or
 * written, so it is reported once, by its fixed label, without the stack trace
 * an uncaught throw would print beside it.
 */
let manifest;
try {
  manifest = readManifest();
} catch (error) {
  console.error(`pack:check failed: ${error instanceof Error ? error.message : 'an unknown error'}`);
  process.exit(1);
}

// The development verdict is decided once: it costs two git reads (the pinned
// source commit, and HEAD only when the tree diverges) and both checks below
// report from the same facts.
let relation = null;
let relationError = null;
if (!releaseMode) {
  try { relation = collectPinRelation(); } catch (error) { relationError = error; }
}

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

// `package-lock.json` is package metadata like `package.json`, and the "a fresh
// `npm ci` cannot fail on drift" check compares against what it holds there. A
// repeated key would decide which version and dependency set that comparison
// uses, so it is read duplicate-safe and refused by one fixed label: no path
// fragment, no key, no value, no parser message.
let lockText;
try {
  lockText = fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8');
} catch (error) {
  console.error(`pack:check failed: package-lock.json cannot be read (${error.code || 'unknown error'})`);
  process.exit(1);
}
let lock;
try {
  lock = parseJsonText(lockText);
} catch (error) {
  console.error(`pack:check failed: package-lock.json ${error instanceof DuplicateJsonKeyError
    ? 'repeats an object key, so which value applies is ambiguous'
    : 'is not readable: invalid JSON'}`);
  process.exit(1);
}
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

check('the committed acceptance evidence describes the pinned package content', () => {
  // The acceptance evidence records the content digest of the tarball it was
  // produced against, plus the byte hash of the pinned artifact. The pin is the
  // authority for both: evidence is written once, against the artifact that
  // shipped, and a later development tree must neither invalidate it nor
  // re-target it. A change to any shipped file still forces a new acceptance
  // run, because it changes the content the next pin will record.
  const releaseManifest = readReleaseManifest();
  const problems = [];
  for (const host of hostVersions) {
    const file = path.join(REPO_ROOT, 'docs', 'evidence', `dsh-${host}.json`);
    if (!fs.existsSync(file)) { problems.push(`missing docs/evidence/dsh-${host}.json`); continue; }
    let evidence;
    // Duplicate-safe, before any field is looked at. `JSON.parse` keeps the last
    // value for a repeated key, so a record that spelled `"ok": false` and then
    // `"\u006fk": true` parsed to `{ ok: true }` and counted as a passed
    // acceptance — a failed run recorded as a passed one. The refusal names the
    // file and one fixed category; the record's own text is never echoed.
    try {
      evidence = parseJsonText(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      problems.push(`docs/evidence/dsh-${host}.json ${error instanceof DuplicateJsonKeyError
        ? 'repeats an object key, so which value applies is ambiguous'
        : 'is not readable: invalid JSON'}`);
      continue;
    }
    if (evidence.ok !== true) problems.push(`${host}: the recorded acceptance did not pass`);
    if (evidence.hostVersion !== host) problems.push(`${host}: the evidence was recorded against host ${evidence.hostVersion}`);
    if (evidence.packageVersion !== manifest.version) problems.push(`${host}: the evidence was recorded for package ${evidence.packageVersion}, not ${manifest.version}`);
    if (evidence.contentSha256 !== releaseManifest.contentSha256) {
      problems.push(`${host}: the evidence covers content ${evidence.contentSha256}, but the pin records ${releaseManifest.contentSha256}; re-run the host acceptance and re-pin`);
    }
    if (evidence.tarballSha256 !== releaseManifest.sha256) {
      problems.push(`${host}: the evidence was recorded against ${evidence.tarballSha256}, but the pinned artifact is ${releaseManifest.sha256}`);
    }
  }
  if (problems.length > 0) throw new Error(problems.join('\n        '));
  notes.push(`        ${hostVersions.length} hosts, content ${releaseManifest.contentSha256}`);
});
if (releaseMode) {
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
} else {
  check('release/manifest.json describes the shipped content of its source commit', () => {
    // The pin's own claim, decided without looking at this tree: the commit it
    // records must ship exactly the content it pins. That is what lets a
    // development tree diverge from the pin without the pin itself becoming
    // unfalsifiable, and it is the first half of the drift verdict below.
    if (relationError) throw relationError;
    const releaseManifest = readReleaseManifest();
    if (releaseManifest.version !== manifest.version) {
      throw new Error(`release/manifest.json pins version ${releaseManifest.version}, package.json is ${manifest.version}`);
    }
    if (releaseManifest.filename !== `${manifest.name}-${manifest.version}.tgz`) {
      throw new Error(`release/manifest.json pins ${releaseManifest.filename}, this package is ${manifest.name}-${manifest.version}.tgz`);
    }
    if (relation.sourceCommit === null) {
      notes.push('        the pin records no source commit (legacy pin), so tree drift cannot be attributed to it');
      return;
    }
    notes.push(`        ${relation.sourceCommit} ships ${relation.sourceDigest}`);
    if (relation.attribution.length > 0) throw new Error(relation.attribution.join('\n        '));
  });
}
check('the committed release artifact is exactly the pinned build', () => {
  const releaseManifest = readReleaseManifest();
  // The pin names this file, so it is held to the pin's read contract: the name
  // must be the pin's own tarball inside a real `release/`, and the file itself
  // must be a regular committed file. `existsSync` followed links, so a symlinked
  // or foreign tarball with the pinned bytes counted as the released artifact.
  const status = pinnedArtifactStatus(releaseManifest);
  if (!status.ok) {
    throw new Error(status.missing
      ? `missing ${path.relative(REPO_ROOT, status.file)}; run "npm run release:publish"`
      : `the committed artifact ${status.message}; the pin must name a regular file in release/`);
  }
  const artifact = status.file;
  // One read, for the reason the release publisher states the same rule: the
  // byte hash, the content digest and the entry/mode checks have to describe the
  // same bytes. Opened three times, a replaced file is three files — each check
  // passes against a different one, and the comparisons that exist to catch the
  // replacement never see the disagreement.
  const artifactBytes = fs.readFileSync(artifact);
  const sha = crypto.createHash('sha256').update(artifactBytes).digest('hex');
  if (sha !== releaseManifest.sha256) {
    throw new Error(`the committed artifact hashes to ${sha}, but release/manifest.json pins ${releaseManifest.sha256}`);
  }
  const entries = readTarEntries(artifactBytes);
  const digest = contentDigestOf(entries);
  if (digest !== releaseManifest.contentSha256) {
    throw new Error(`the committed artifact contains ${digest}, but release/manifest.json pins ${releaseManifest.contentSha256}`);
  }
  if (entries.length !== releaseManifest.entries) {
    throw new Error(`the committed artifact has ${entries.length} entries, release/manifest.json pins ${releaseManifest.entries}`);
  }
  const modes = [...new Set(entries.map((entry) => `0o${entry.mode.toString(8)}`))].sort();
  if (JSON.stringify(modes) !== JSON.stringify(releaseManifest.modes)) {
    throw new Error(`the committed artifact has modes ${JSON.stringify(modes)}, release/manifest.json pins ${JSON.stringify(releaseManifest.modes)}`);
  }
  assertCleanEntries(entries.map((entry) => entry.path), expectedEntries(manifest));
  // The checksum file is the third file of the release set and is read at a
  // fixed name inside `release/`, so it is held to the same rule as the pin:
  // `lstat` first, a regular committed file only, never a link to somewhere else.
  const sumsStatus = releaseRootFileStatus('SHA256SUMS');
  if (!sumsStatus.ok) throw new Error(sumsStatus.message);
  const recorded = fs.readFileSync(sumsStatus.file, 'utf8').trim();
  if (recorded !== `${releaseManifest.sha256}  ${releaseManifest.filename}`) {
    throw new Error(`release/SHA256SUMS records:\n          ${recorded}\n        expected:\n          ${releaseManifest.sha256}  ${releaseManifest.filename}`);
  }
  notes.push(`        ${path.relative(REPO_ROOT, artifact)}  sha256 ${sha}`);
});
if (releaseMode) {
  check('the working tree still builds the pinned content', () => {
    // Cheap and exact: the same canonical digest computed from the declared files
    // on disk, so a drifted file is named by the diff rather than by a pack hash.
    const releaseManifest = readReleaseManifest();
    const treeDigest = treeContentDigest();
    if (treeDigest !== releaseManifest.contentSha256) {
      const declared = expectedEntries(manifest);
      const pinned = new Map(readTarEntries(pinnedArtifactFile(releaseManifest)).map((entry) => [entry.path, entry]));
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
} else {
  check('this tree is the pinned release, or a committed successor of it', () => {
    // Two states are legitimate, and they are named instead of collapsed:
    //   pinned   this tree is the release (nothing has shipped since the pin);
    //   ahead    this tree is a committed successor of the released commit, so
    //            the divergence is reviewable commit content, not a local edit.
    // A tree that is neither fails, and the files that differ are listed so the
    // state can never be read as "released".
    if (relationError) throw relationError;
    const lines = formatRelation(relation);
    for (const line of lines) notes.push(`        ${line}`);
    if (relation.state === PIN_RELATION.UNVERIFIED) throw new Error(relation.problems.join('\n        '));
  });
}
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
console.log(`pack:check ${manifest.name}@${manifest.version}${releaseMode ? ' (release tree)' : ' (development tree)'}`);
for (const note of notes) if (note.startsWith('  ok  ')) console.log(note);
if (failures.length > 0) {
  console.error('\nchecks failed:');
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log('\nall package checks passed');
if (relation && relation.state === PIN_RELATION.AHEAD) {
  // Loud on purpose: this is the one passing state in which the tree is not the
  // released package, so it must never be read as "the pin covers this tree".
  console.log('\nthis tree is a development successor of the pinned release; the pin, its artifact and its evidence are unchanged');
  console.log('the release gate still requires the tree to build the pin: npm run pack:check -- --release');
}
