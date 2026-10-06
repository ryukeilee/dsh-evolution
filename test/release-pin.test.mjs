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
import { fileURLToPath } from 'node:url';
import {
  REPO_ROOT,
  archiveContentDigest,
  archiveEntries,
  expectedEntries,
  readManifest,
  readReleaseManifest,
  readTarEntries,
  releaseArtifactPath,
  treeContentDigest,
} from '../scripts/release/release-lib.mjs';

const manifest = readManifest();
const pin = readReleaseManifest();

test('the pin names this package version and a pre-release artifact', () => {
  assert.equal(pin.name, manifest.name);
  assert.equal(pin.version, manifest.version);
  assert.equal(pin.filename, `${manifest.name}-${manifest.version}.tgz`);
  assert.match(pin.version, /^\d+\.\d+\.\d+-/, 'a dev/RC artifact must carry a pre-release tag');
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

test('the working tree still builds exactly the pinned content', () => {
  assert.equal(
    treeContentDigest(),
    pin.contentSha256,
    'a shipped file changed: re-run the host acceptance and `npm run release:publish`',
  );
});

test('every shipped file in the tree matches the artifact byte for byte', () => {
  const archived = new Map(readTarEntries(releaseArtifactPath(pin)).map((entry) => [entry.path, entry]));
  const declared = expectedEntries(manifest);
  assert.deepEqual([...archived.keys()].sort(), [...declared].sort());
  for (const relative of declared) {
    const onDisk = fs.readFileSync(path.join(REPO_ROOT, relative));
    assert.equal(
      archived.get(relative).bytes.equals(onDisk),
      true,
      `${relative} differs between the working tree and the released artifact`,
    );
  }
});

test('release/SHA256SUMS records the pinned artifact', () => {
  const file = path.join(REPO_ROOT, 'release', 'SHA256SUMS');
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.readFileSync(file, 'utf8').trim(), `${pin.sha256}  ${pin.filename}`);
});

test('the pin lists an acceptance evidence file per supported host', () => {
  const hosts = (manifest.peerDependencies['@deepseek-ai/dsh'] || '').split('||').map((value) => value.trim()).filter(Boolean);
  assert.deepEqual(pin.verifiedHosts, hosts);
  assert.deepEqual(pin.evidence, hosts.map((host) => `docs/evidence/dsh-${host}.json`));
  for (const host of hosts) {
    const file = path.join(REPO_ROOT, 'docs', 'evidence', `dsh-${host}.json`);
    assert.equal(fs.existsSync(file), true, `missing acceptance evidence for ${host}`);
    const evidence = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(evidence.ok, true, `the recorded acceptance for ${host} did not pass`);
    assert.equal(evidence.hostVersion, host);
    assert.equal(evidence.packageVersion, manifest.version);
    assert.equal(evidence.contentSha256, pin.contentSha256, `the acceptance for ${host} ran against different content`);
    assert.equal(evidence.tarballSha256, pin.sha256, `the acceptance for ${host} ran against different bytes`);
  }
});
