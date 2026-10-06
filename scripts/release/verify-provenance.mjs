#!/usr/bin/env node
/**
 * Verify that the checked-out commit, the release tag and the committed pin
 * describe the same release.
 *
 * `verify-artifact.mjs` proves *manifest -> artifact*: the committed tarball is
 * exactly the bytes and content the pin names. `verify-package.mjs` proves
 * *tree -> manifest*: the working tree still builds the pinned content. This
 * entry point closes the remaining edge: *tag -> commit -> manifest*.
 *
 * It exists because a release workflow only ever runs against a ref, and a ref
 * can be wrong in ways that artifact verification alone cannot see:
 *
 *   - the tag names a different version than `package.json` (typo, wrong tag);
 *   - the tag points at a different commit than the one that was checked out;
 *   - `release/manifest.json` pins a source commit that is not in this
 *     tag's history (a pin copied from somewhere else, or a rewritten tag);
 *   - the tagged tree no longer builds the pinned content.
 *
 * The release workflow runs this with `--require-source-commit`, so a new
 * release may not be published unless `release:publish` recorded the commit the
 * artifact was built from. Legacy pins cut before that field existed are still
 * auditable with a plain `--tag` run (see `--require-source-commit`).
 *
 * Usage:
 *   node scripts/release/verify-provenance.mjs --tag v0.2.0-rc.2
 *   node scripts/release/verify-provenance.mjs --tag v0.2.0-rc.2 --require-source-commit
 *   node scripts/release/verify-provenance.mjs --tag v0.2.0-rc.2 --json
 */
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, gitOutput, readManifest, readReleaseManifest, treeContentDigest } from './release-lib.mjs';

/** A full, lowercase git object name. Short names are ambiguous, so they fail. */
export function isFullSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/**
 * The pure decision table. Everything the CLI would observe is passed in, so
 * the rules are unit-tested without a repository:
 *
 *   tag                 the release tag being verified, or null
 *   head                `git rev-parse HEAD` of the checked-out commit
 *   tagCommit           the commit `tag` resolves to, or null
 *   sourceCommit        `release/manifest.json#sourceCommit`, or null
 *   requireSourceCommit whether a missing sourceCommit is a failure
 *   isAncestor          (ancestor, descendant) => boolean
 *   packageVersion      `package.json#version`
 *   pinVersion          `release/manifest.json#version`
 *   treeDigest          canonical digest of the working tree's shipped files
 *   pinContentSha256    `release/manifest.json#contentSha256`
 */
export function evaluateProvenance(input) {
  const {
    tag = null,
    head,
    tagCommit = null,
    sourceCommit = null,
    requireSourceCommit = false,
    isAncestor,
    packageVersion,
    pinVersion,
    treeDigest,
    pinContentSha256,
  } = input;
  const problems = [];
  const notes = [];

  if (pinVersion !== packageVersion) {
    problems.push(`release/manifest.json pins version ${pinVersion}, package.json is ${packageVersion}`);
  }

  if (tag) {
    const tagVersion = tag.replace(/^v/, '');
    if (tagVersion !== packageVersion) {
      problems.push(`tag ${tag} does not match package.json version ${packageVersion}`);
    }
    if (!tagCommit) {
      problems.push(`tag ${tag} does not resolve to a commit in this checkout`);
    } else if (tagCommit !== head) {
      problems.push(`checked out ${head}, but tag ${tag} points to ${tagCommit}`);
    } else {
      notes.push(`tag ${tag} -> commit ${head}`);
    }
  }

  if (sourceCommit === null || sourceCommit === undefined) {
    if (requireSourceCommit) {
      problems.push('release/manifest.json does not pin a source commit; cut the release with "npm run release:publish"');
    } else {
      notes.push('release/manifest.json has no source commit pin (legacy pin; tag/version/content still verified)');
    }
  } else if (!isFullSha(sourceCommit)) {
    problems.push(`release/manifest.json source commit ${JSON.stringify(sourceCommit)} is not a full 40-hex object name`);
  } else if (!isAncestor(sourceCommit, head)) {
    problems.push(`pinned source commit ${sourceCommit} is not in the history of the tagged commit ${head}`);
  } else {
    notes.push(`source commit ${sourceCommit} is in the tagged history`);
  }

  if (treeDigest !== pinContentSha256) {
    problems.push(`the tagged tree builds ${treeDigest}, but release/manifest.json pins ${pinContentSha256}`);
  } else {
    notes.push(`tagged tree content ${treeDigest} matches the pin`);
  }

  return { problems, notes };
}

const git = (args, cwd = REPO_ROOT) => gitOutput(args, cwd);

export function collectProvenance({ tag, cwd = REPO_ROOT, gitRun = git } = {}) {
  const manifest = readManifest();
  const pin = readReleaseManifest();
  const head = gitRun(['rev-parse', 'HEAD'], cwd);
  let tagCommit = null;
  if (tag) {
    try { tagCommit = gitRun(['rev-parse', `${tag}^{commit}`], cwd); } catch { tagCommit = null; }
  }
  const isAncestor = (ancestor, descendant) => {
    try {
      gitRun(['cat-file', '-e', `${ancestor}^{commit}`], cwd);
      gitRun(['merge-base', '--is-ancestor', ancestor, descendant], cwd);
      return true;
    } catch {
      return false;
    }
  };
  return {
    tag: tag ?? null,
    head,
    tagCommit,
    sourceCommit: pin.sourceCommit ?? null,
    isAncestor,
    packageVersion: manifest.version,
    pinVersion: pin.version,
    treeDigest: treeContentDigest(),
    pinContentSha256: pin.contentSha256,
  };
}

export function parseArgs(argv) {
  const options = { tag: null, requireSourceCommit: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--tag') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error('--tag requires a value');
      options.tag = next;
      index += 1;
    } else if (arg === '--require-source-commit') options.requireSourceCommit = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export function run(argv, io = { log: console.log, error: console.error }) {
  const options = parseArgs(argv);
  if (options.help) {
    io.log('node scripts/release/verify-provenance.mjs [--tag <tag>] [--require-source-commit] [--json]');
    return 0;
  }
  const collected = collectProvenance({ tag: options.tag });
  const { isAncestor: _isAncestor, ...observable } = collected;
  const { problems, notes } = evaluateProvenance({ ...collected, requireSourceCommit: options.requireSourceCommit });
  const report = { ...observable, requireSourceCommit: options.requireSourceCommit, ok: problems.length === 0, problems, notes };
  if (options.json) {
    io.log(JSON.stringify(report, null, 2));
  } else {
    io.log(`verify-provenance ${report.tag ? `tag ${report.tag}` : '(no tag)'}${options.requireSourceCommit ? ' (source commit required)' : ''}`);
    for (const note of notes) io.log(`  ok    ${note}`);
    if (problems.length > 0) {
      io.error('\nprovenance mismatches:');
      for (const problem of problems) io.error(`  - ${problem}`);
    } else {
      io.log(`  matches release/manifest.json (${report.packageVersion})`);
    }
  }
  return problems.length === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  try {
    process.exit(run(process.argv.slice(2)));
  } catch (error) {
    console.error(`verify-provenance failed: ${error.message}`);
    process.exit(2);
  }
}
