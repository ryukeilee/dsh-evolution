#!/usr/bin/env node
/**
 * How the working tree relates to the release pin.
 *
 * `release/manifest.json` describes one published release: its bytes, its
 * content digest, its acceptance evidence and the commit it was built from.
 * That record never changes; `verify-artifact.mjs` proves the committed tarball
 * is exactly those bytes and that content, and `pack:check` proves the
 * acceptance evidence describes them too.
 *
 * The working tree, however, is only the pinned content while it *is* the tree
 * that was released. Development happens on top of the last release, so from
 * the first changed shipped file the tree no longer builds the pin — and it
 * must not be "fixed" by re-pinning, which would claim a release that never
 * happened. Two facts are what make that divergence reviewable instead of an
 * unattributable edit, and they are the only ones this module accepts:
 *
 *   - the pin still describes immutable history: the commit it records ships
 *     exactly the content it pins, so the pin's own claim never drifts even
 *     when the tree does;
 *   - the tree's shipped files are exactly the shipped files of HEAD, so the
 *     divergence is committed (and reviewable) rather than a local edit.
 *
 * A tree that satisfies both and still differs from the pin is `ahead`: a
 * development successor of the released commit. Anything else is `unverified`
 * and is a failure.
 *
 * This tolerance is for development entry points only. The release path does
 * not use it: `verify-package.mjs --release` still requires the tree to build
 * the pinned content exactly, and `verify-provenance.mjs` independently refuses
 * a tag whose tree content differs from the pin. RELEASE.md section 6 item 16
 * documents the states and the re-pin procedure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  REPO_ROOT, commitContentDigest, expectedEntries, isFullSha, readReleaseManifest,
  readTarEntries, releaseArtifactPath, treeContentDigest,
} from './release-lib.mjs';

/** The three states the tree/pin relation can be in. */
export const PIN_RELATION = Object.freeze({ PINNED: 'pinned', AHEAD: 'ahead', UNVERIFIED: 'unverified' });

/**
 * The pure decision table for the pin's own claim, independent of the tree.
 *
 *   sourceCommit      `release/manifest.json#sourceCommit`, or null
 *   sourceInHistory   whether that commit exists in this repository
 *   sourceDigest      canonical shipped-content digest of that commit, or null
 *   pinContentSha256  `release/manifest.json#contentSha256`
 *
 * Returns the problems, empty when the pin describes its own history. A pin
 * without a recorded source commit is a legacy pin: it cannot be attributed, so
 * it yields no problems here and the relation check refuses drift instead.
 */
export function evaluatePinAttribution({ sourceCommit, sourceInHistory, sourceDigest, pinContentSha256 }) {
  if (sourceCommit === null || sourceCommit === undefined) return [];
  if (!isFullSha(sourceCommit)) {
    return [`release/manifest.json source commit ${JSON.stringify(sourceCommit)} is not a full 40-hex object name`];
  }
  if (!sourceInHistory) return [`pinned source commit ${sourceCommit} is not in this repository's history`];
  if (sourceDigest !== pinContentSha256) {
    return [`pinned source commit ${sourceCommit} ships ${sourceDigest}, but the pin records ${pinContentSha256}`];
  }
  return [];
}

/**
 * The pure decision table for the tree/pin relation.
 *
 *   treeDigest        canonical shipped-content digest of this working tree
 *   pinContentSha256  `release/manifest.json#contentSha256`
 *   headDigest        canonical shipped-content digest of HEAD, or null
 *   sourceCommit      `release/manifest.json#sourceCommit`, or null
 *   attribution       problems from `evaluatePinAttribution()` for this pin
 */
export function evaluateTreeRelation({ treeDigest, pinContentSha256, headDigest, sourceCommit = null, attribution = [] }) {
  if (treeDigest === pinContentSha256) return { state: PIN_RELATION.PINNED, problems: [] };
  const problems = [...attribution];
  if (sourceCommit === null || sourceCommit === undefined) {
    // A legacy pin names no released commit, so nothing says which released
    // content this tree is a successor of. That is not a reason to accept the
    // drift: it is the reason the drift cannot be attributed.
    problems.push('release/manifest.json records no source commit, so this divergence cannot be attributed to released history');
  }
  if (headDigest === null || headDigest === undefined) {
    problems.push('HEAD\'s shipped content could not be read, so this divergence cannot be attributed to a commit');
  } else if (headDigest !== treeDigest) {
    problems.push(`this tree ships uncommitted changes: its content is ${treeDigest}, HEAD's is ${headDigest}`);
  }
  if (problems.length > 0) return { state: PIN_RELATION.UNVERIFIED, problems };
  return { state: PIN_RELATION.AHEAD, problems: [] };
}

/** Every shipped entry that differs between the tree and the pinned artifact. */
export function differingShippedEntries(pin = readReleaseManifest()) {
  const artifact = releaseArtifactPath(pin);
  if (!fs.existsSync(artifact)) return null;
  const pinned = new Map(readTarEntries(artifact).map((entry) => [entry.path, entry]));
  const declared = expectedEntries();
  const differing = [];
  for (const relative of declared) {
    const entry = pinned.get(relative);
    if (!entry) {
      differing.push({ path: relative, reason: 'not in the pinned artifact' });
    } else if (!entry.bytes.equals(fs.readFileSync(path.join(REPO_ROOT, relative)))) {
      differing.push({ path: relative, reason: 'differs from the pinned artifact' });
    }
  }
  for (const relative of pinned.keys()) {
    if (!declared.includes(relative)) differing.push({ path: relative, reason: 'in the pinned artifact but no longer shipped' });
  }
  return differing.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Observe the facts `evaluateTreeRelation()` decides on. The git reads are the
 * only ones that can fail on an unusual checkout, so they are confined to the
 * cases that need them: no diff with the pin means no attribution to prove.
 */
export function collectPinFacts({ cwd = REPO_ROOT, pin = readReleaseManifest() } = {}) {
  const treeDigest = treeContentDigest();
  const sourceCommit = typeof pin.sourceCommit === 'string' ? pin.sourceCommit : null;
  const digestOf = (ref) => {
    try {
      return commitContentDigest(ref, cwd);
    } catch {
      return null;
    }
  };
  let sourceInHistory = false;
  let sourceDigest = null;
  if (isFullSha(sourceCommit)) {
    sourceDigest = digestOf(sourceCommit);
    sourceInHistory = sourceDigest !== null;
  }
  const diverged = treeDigest !== pin.contentSha256;
  return {
    pin,
    treeDigest,
    sourceCommit,
    sourceInHistory,
    sourceDigest,
    headDigest: diverged ? digestOf('HEAD') : null,
    differing: diverged ? differingShippedEntries(pin) : [],
  };
}

/** Both verdicts for one tree, so the callers do not thread the facts around. */
export function collectPinRelation(options = {}) {
  const facts = collectPinFacts(options);
  const attribution = evaluatePinAttribution({ ...facts, pinContentSha256: facts.pin.contentSha256 });
  const relation = evaluateTreeRelation({ ...facts, pinContentSha256: facts.pin.contentSha256, attribution });
  return { ...facts, attribution, ...relation };
}

export function formatRelation(relation) {
  const lines = [];
  const artifact = path.basename(releaseArtifactPath(relation.pin));
  if (relation.state === PIN_RELATION.PINNED) {
    lines.push(`the tree is the pinned release (${artifact}, content ${relation.pin.contentSha256})`);
    return lines;
  }
  if (relation.state === PIN_RELATION.AHEAD) {
    lines.push(`development tree ahead of the pin (${artifact}, content ${relation.pin.contentSha256})`);
    if (relation.differing === null) {
      lines.push('the pinned artifact is missing, so the differing files cannot be listed');
    } else {
      for (const entry of relation.differing) lines.push(`${entry.path}: ${entry.reason}`);
    }
    lines.push('the pin is unchanged; the release gate still requires the tree to build it ("npm run pack:check -- --release")');
    return lines;
  }
  lines.push(`the tree is neither the pinned release nor a committed successor of it (content ${relation.treeDigest}, pin ${relation.pin.contentSha256})`);
  for (const problem of relation.problems) lines.push(problem);
  if (relation.differing) for (const entry of relation.differing) lines.push(`${entry.path}: ${entry.reason}`);
  return lines;
}

// `node scripts/release/pin-relation.mjs [--json]` prints the current state; it
// is a debugging aid for the same decision `pack:check` and the pin tests make.
const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  const relation = collectPinRelation();
  const report = {
    state: relation.state,
    treeContentSha256: relation.treeDigest,
    pinContentSha256: relation.pin.contentSha256,
    pinVersion: relation.pin.version,
    sourceCommit: relation.sourceCommit,
    attribution: relation.attribution,
    differing: relation.differing,
    problems: relation.problems,
  };
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else for (const line of formatRelation(relation)) console.log(line);
  process.exit(relation.state === PIN_RELATION.UNVERIFIED ? 1 : 0);
}
