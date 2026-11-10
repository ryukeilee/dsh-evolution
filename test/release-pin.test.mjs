/**
 * The release pin is the contract between the reviewed commit and the artifact
 * users download. These tests are deliberately cheap: they read the committed
 * tarball and the working tree, without running `npm pack`, so a drifted file
 * is caught by `npm test` and not only by the packaging job.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  REPO_ROOT,
  archiveContentDigest,
  archiveEntries,
  commitArchiveEntries,
  declaredHostVersions,
  evaluateAddedHostAcceptance,
  evaluatePinnedAcceptance,
  expectedEntries,
  pinnedDeclaredHostVersions,
  readManifest,
  readReleaseManifest,
  readTarEntries,
  releaseArtifactPath,
  treeContentDigest,
} from '../scripts/release/release-lib.mjs';
import { evaluatePinAttribution, evaluateTreeRelation, collectPinRelation } from '../scripts/release/pin-relation.mjs';

const manifest = readManifest();
const pin = readReleaseManifest();

// Decided once for the file: the development verdict costs two git reads and
// every tree/pin assertion below reports from the same facts.
const relation = collectPinRelation();

// The pin has to name the same version this package builds, in the shape a
// release tag can carry. The assertion used to demand a pre-release tag, which
// only said "an RC was pinned"; a stable release pins a plain version, so the
// semver shape is what is checked now.
test('the pin names this package version and its artifact', () => {
  assert.equal(pin.name, manifest.name);
  assert.equal(pin.version, manifest.version);
  assert.equal(pin.filename, `${manifest.name}-${manifest.version}.tgz`);
  assert.match(
    pin.version,
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/,
    'the pinned version must be the MAJOR.MINOR.PATCH version a v-prefixed tag names',
  );
  assert.equal(pin.builtWith?.node?.startsWith('v'), true, 'the pin must record the toolchain that produced the bytes');
  assert.equal(typeof pin.builtWith?.npm, 'string');
  assert.equal(typeof pin.builtWith?.platform, 'string');
});

test('the committed artifact hashes to the pinned bytes', () => {
  const artifact = releaseArtifactPath(pin);
  assert.equal(fs.existsSync(artifact), true, `missing ${path.relative(REPO_ROOT, artifact)}`);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
  assert.equal(sha256, pin.sha256, 'the committed artifact is not the artifact the pin names');
});

test('the committed artifact is the pinned content, not just the pinned bytes', () => {
  const artifact = releaseArtifactPath(pin);
  assert.equal(archiveContentDigest(artifact), pin.contentSha256);
  const entries = archiveEntries(artifact);
  assert.equal(entries.length, pin.entries);
  const modes = [...new Set(entries.map((entry) => `0o${entry.mode.toString(8)}`))].sort();
  assert.deepEqual(modes, pin.modes);
});

test('the pin describes the shipped content of its own source commit', () => {
  // Independent of this tree, and true forever: the commit the pin records must
  // ship exactly the content the pin names. This is what makes it safe for a
  // development tree to diverge from the pin - the pin's own claim cannot drift
  // with it - and it is checked without consulting the working tree at all.
  assert.equal(relation.attribution.length, 0, relation.attribution.join('\n'));
  assert.equal(relation.sourceInHistory, true, 'the pinned source commit must exist in this repository');
  assert.equal(relation.sourceIsAncestor, true, 'and HEAD must descend from it');
});

test('the working tree is the pinned release, or a committed successor of it', () => {
  assert.equal(treeContentDigest(), relation.treeDigest);
  assert.notEqual(relation.state, 'unverified', relation.problems.join('\n'));
  if (relation.state === 'pinned') {
    assert.equal(relation.treeDigest, pin.contentSha256);
    assert.deepEqual(relation.differing, []);
    return;
  }
  // 'ahead': every file that differs is named, so this state cannot be read as
  // "the pin covers this tree". The diff must be committed content (that is
  // what `ahead` means) and it must not touch the package's declared surface.
  assert.equal(relation.state, 'ahead');
  assert.ok(relation.differing.length > 0, 'a tree ahead of the pin must name the files that differ');
  const declared = new Set(expectedEntries(manifest));
  for (const entry of relation.differing) {
    assert.equal(declared.has(entry.path), true, `${entry.path}: the shipped file set itself changed, which is not development drift`);
  }
});

test('the pin relation accepts only committed drift the pin can be attributed from', () => {
  // The decision table the two checks above rely on, exercised on the inputs
  // that the repository cannot be put into: a legacy pin, an unreachable source
  // commit, a pin that misdescribes its own commit, and an uncommitted edit.
  const pinnedContent = 'a'.repeat(64);
  const treeContent = 'b'.repeat(64);
  const source = { sourceCommit: 'c'.repeat(40), sourceInHistory: true, sourceDigest: pinnedContent, pinContentSha256: pinnedContent };

  assert.deepEqual(evaluatePinAttribution(source), []);
  assert.deepEqual(
    evaluateTreeRelation({ treeDigest: pinnedContent, pinContentSha256: pinnedContent, headDigest: null }),
    { state: 'pinned', problems: [] },
    'a tree that builds the pin needs no attribution',
  );
  assert.deepEqual(
    evaluateTreeRelation({
      treeDigest: treeContent, pinContentSha256: pinnedContent, headDigest: treeContent,
      sourceCommit: source.sourceCommit, sourceIsAncestor: true, attribution: [],
    }),
    { state: 'ahead', problems: [] },
    'a committed successor of the released commit is a development state, not a failure',
  );

  // "Successor" is an ancestry claim, not just "the pinned commit's content is
  // readable": a tree that does not descend from it is unrelated content.
  const unrelated = evaluateTreeRelation({
    treeDigest: treeContent, pinContentSha256: pinnedContent, headDigest: treeContent,
    sourceCommit: source.sourceCommit, sourceIsAncestor: false, attribution: [],
  });
  assert.equal(unrelated.state, 'unverified');
  assert.match(unrelated.problems.join('\n'), /is not an ancestor of HEAD/);
  assert.equal(/shallow/.test(unrelated.problems.join('\n')), false, 'a complete checkout must not be blamed on a shallow clone');
  const shallow = evaluateTreeRelation({
    treeDigest: treeContent, pinContentSha256: pinnedContent, headDigest: treeContent,
    sourceCommit: source.sourceCommit, sourceIsAncestor: false, historyIsShallow: true, attribution: [],
  });
  assert.match(shallow.problems.join('\n'), /shallow checkout: fetch the full history/);
  assert.match(
    evaluatePinAttribution({ ...source, sourceInHistory: false, historyIsShallow: true })[0],
    /shallow checkout: fetch the full history/,
    'a shallow clone must be told how to answer the question',
  );

  const uncommitted = evaluateTreeRelation({ treeDigest: treeContent, pinContentSha256: pinnedContent, headDigest: 'd'.repeat(64), sourceCommit: source.sourceCommit, sourceIsAncestor: true });
  assert.equal(uncommitted.state, 'unverified');
  assert.match(uncommitted.problems.join('\n'), /uncommitted changes/);

  assert.deepEqual(evaluatePinAttribution({ ...source, sourceCommit: null }), [], 'a legacy pin yields no attribution problem of its own');
  const legacy = evaluateTreeRelation({
    treeDigest: treeContent, pinContentSha256: pinnedContent, headDigest: treeContent, sourceCommit: null,
  });
  // A pin with no recorded commit cannot excuse drift: nothing says which
  // released content the tree is supposed to be a successor of.
  assert.equal(legacy.state, 'unverified');
  assert.match(legacy.problems.join('\n'), /records no source commit/);
  const missingSource = evaluatePinAttribution({ ...source, sourceInHistory: false });
  assert.equal(missingSource.length, 1);
  assert.match(missingSource[0], /is not in this repository's history/);
  assert.equal(
    evaluateTreeRelation({
      treeDigest: treeContent, pinContentSha256: pinnedContent, headDigest: treeContent,
      sourceCommit: source.sourceCommit, sourceIsAncestor: true, attribution: missingSource,
    }).state,
    'unverified',
  );
  const misdescribed = evaluatePinAttribution({ ...source, sourceDigest: 'e'.repeat(64) });
  assert.match(misdescribed[0], /but the pin records/);
  assert.match(evaluatePinAttribution({ ...source, sourceCommit: 'abc123' })[0], /not a full 40-hex object name/);
});

test('the shipping gate refuses a tree that does not build the pin', () => {
  // Positive control for the development tolerance: the exact tree `pack:check`
  // accepts as a committed successor must fail `--release`, so the tolerance
  // can never be what ships. Expensive (it packs twice), and only meaningful
  // while the tree is ahead of the pin.
  if (relation.state === 'pinned') return;
  let outcome;
  try {
    execFileSync(process.execPath, ['scripts/release/verify-package.mjs', '--release'], {
      cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    outcome = { code: 0, output: '' };
  } catch (error) {
    outcome = { code: error.status, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
  assert.notEqual(outcome.code, 0, 'release mode must reject a development tree');
  assert.match(outcome.output, /the working tree still builds the pinned content/);
  for (const entry of relation.differing) {
    assert.ok(outcome.output.includes(entry.path), `release mode must name ${entry.path}`);
  }
});

test('every shipped file matches the artifact, except the named development successors', () => {
  const archived = new Map(readTarEntries(releaseArtifactPath(pin)).map((entry) => [entry.path, entry]));
  const declared = expectedEntries(manifest);
  // The pin remains accountable to its own source, even when a committed
  // development successor adds a module. No release bytes are rebuilt here.
  const pinned = pin.sourceCommit ? commitArchiveEntries(pin.sourceCommit).map(entry => entry.path) : declared;
  assert.deepEqual([...archived.keys()].sort(), [...pinned].sort());
  const named = new Set((relation.differing ?? []).map((entry) => entry.path));
  for (const relative of declared) {
    const onDisk = fs.readFileSync(path.join(REPO_ROOT, relative));
    if (archived.get(relative)?.bytes.equals(onDisk)) continue;
    assert.equal(
      named.has(relative),
      true,
      `${relative} differs between the working tree and the released artifact but is not part of the committed successor diff`,
    );
  }
  // …and the listing is exact: every file it names really did change.
  for (const relative of named) {
    assert.equal(
      archived.get(relative)?.bytes.equals(fs.readFileSync(path.join(REPO_ROOT, relative))),
      false,
      `${relative} is reported as differing but matches the released artifact`,
    );
  }
});

test('release/SHA256SUMS records the pinned artifact', () => {
  const file = path.join(REPO_ROOT, 'release', 'SHA256SUMS');
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.readFileSync(file, 'utf8').trim(), `${pin.sha256}  ${pin.filename}`);
});

test('the pin verifies exactly the hosts its own artifact declares', () => {
  // The pin's claim is about the released bytes, so it is read from them: the
  // hosts in `verifiedHosts` have to be the hosts that artifact says it supports.
  // It is deliberately not compared with this tree's declaration — a development
  // successor may add a supported host, and the pin cannot describe a host it
  // never shipped. The next test owns that side of the split.
  const shippedHosts = pinnedDeclaredHostVersions(pin, readTarEntries(releaseArtifactPath(pin)));
  assert.deepEqual(pin.verifiedHosts, shippedHosts);
  assert.deepEqual(pin.evidence, shippedHosts.map((host) => `docs/evidence/dsh-${host}.json`));
  for (const host of shippedHosts) {
    const file = path.join(REPO_ROOT, 'docs', 'evidence', `dsh-${host}.json`);
    assert.equal(fs.existsSync(file), true, `missing acceptance evidence for ${host}`);
  }
  const { problems } = evaluatePinnedAcceptance(pin);
  assert.deepEqual(problems, [], 'the pin\'s own record must describe the pinned bytes and content');
  for (const host of shippedHosts) {
    const evidence = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'docs', 'evidence', `dsh-${host}.json`), 'utf8'));
    assert.equal(evidence.contentSha256, pin.contentSha256, `the acceptance for ${host} ran against different content`);
    assert.equal(evidence.tarballSha256, pin.sha256, `the acceptance for ${host} ran against different bytes`);
  }
});

test('every host this tree adds is accepted against this tree, not against the pin', () => {
  // The other lane: a host the pin never verified proves nothing about this tree
  // unless its record was produced against this tree's content. Without this the
  // only two ways to add a host would be re-pinning or re-targeting history.
  const treeDigest = treeContentDigest();
  const { hosts, problems } = evaluateAddedHostAcceptance({ pin, manifest, treeDigest });
  assert.deepEqual(problems, []);
  const declared = declaredHostVersions(manifest);
  assert.deepEqual([...new Set([...pin.verifiedHosts, ...hosts])].sort(), [...declared].sort(),
    'the two lanes together must cover exactly the hosts this tree declares');
  for (const host of hosts) {
    assert.equal(pin.verifiedHosts.includes(host), false, `${host} cannot be in both lanes`);
    const evidence = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'docs', 'evidence', `dsh-${host}.json`), 'utf8'));
    assert.equal(evidence.ok, true);
    assert.equal(evidence.hostVersion, host);
    assert.equal(evidence.contentSha256, treeDigest, `the acceptance for ${host} describes another build`);
  }
});
