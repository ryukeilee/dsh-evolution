/**
 * `satisfiesRange()` decides whether the resolved DSH host and its modules are
 * within the declared peer ranges. It is shared by the runtime and the doctor
 * CLI, so it has to follow semver precedence exactly: a wrong comparison turns
 * a supported host into "blocked" or an unsupported one into "ok".
 *
 * Ordering and the comparator-set prerelease rule are both checked here,
 * together with every range this package currently declares.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { satisfiesRange } from '../lib/diagnostics.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const peers = manifest.peerDependencies;
const pin = JSON.parse(fs.readFileSync(path.join(repoRoot, 'release', 'manifest.json'), 'utf8'));

test('a prerelease numeric identifier compares numerically, not as text', () => {
  assert.equal(satisfiesRange('1.0.0-rc.10', '>=1.0.0-rc.2'), true);
  assert.equal(satisfiesRange('2.0.0-alpha.10', '>=2.0.0-alpha.9'), true);
  assert.equal(satisfiesRange('1.0.0-rc.2', '>=1.0.0-rc.10'), false);
  assert.equal(satisfiesRange('1.0.0-rc.10', '1.0.0-rc.10'), true);
  assert.equal(satisfiesRange('1.0.0-rc.10', '1.0.0-rc.2'), false);
});

test('prerelease identifiers follow semver precedence in full', () => {
  // Numeric identifiers rank below alphanumeric ones.
  assert.equal(satisfiesRange('1.0.0-alpha', '>1.0.0-1'), true);
  assert.equal(satisfiesRange('1.0.0-1', '>1.0.0-alpha'), false);
  // Alphanumeric identifiers compare in ASCII order.
  assert.equal(satisfiesRange('1.0.0-alpha', '<1.0.0-beta'), true);
  assert.equal(satisfiesRange('1.0.0-beta', '<1.0.0-alpha'), false);
  assert.equal(satisfiesRange('1.0.0-alpha.1', '<1.0.0-alpha.beta'), true);
  // A larger identifier set is greater when every shared identifier is equal.
  assert.equal(satisfiesRange('1.0.0-alpha.1', '>1.0.0-alpha'), true);
  assert.equal(satisfiesRange('1.0.0-alpha', '>1.0.0-alpha.1'), false);
  // A prerelease ranks below the release with the same tuple; the set has to
  // admit the prerelease for that ordering to be observable here.
  assert.equal(satisfiesRange('1.0.0-rc.1', '>=1.0.0-rc.1 <1.0.0'), true);
  assert.equal(satisfiesRange('1.0.0-rc.1', '<1.0.0'), false);
  assert.equal(satisfiesRange('1.0.0', '>1.0.0-rc.1'), true);
  // A numeric identifier with a leading zero is not a valid version.
  assert.equal(satisfiesRange('1.0.0-01', '>=1.0.0-1'), false);
  assert.equal(satisfiesRange('1.02.3', '>=1.2.3'), false);
});

test('a prerelease only satisfies a comparator set that names its own tuple', () => {
  // The set has a prerelease comparator, but for another patch: semver excludes
  // the prerelease even though it is numerically inside the comparator.
  assert.equal(satisfiesRange('4.0.6-alpha.1', '>=4.0.5-alpha.1'), false);
  // The set names the very tuple, so the prerelease is eligible.
  assert.equal(satisfiesRange('4.0.5-alpha.2', '>=4.0.5-alpha.1 <5.0.0'), true);
  // The stable release of the same tuple still satisfies the range.
  assert.equal(satisfiesRange('4.0.5', '>=4.0.5-alpha.1 <5.0.0'), true);
  // A different comparator set may re-admit it.
  assert.equal(satisfiesRange('4.0.6-alpha.1', '>=4.0.5-alpha.1 || 4.0.6-alpha.1'), true);
  // No prerelease comparator at all: excluded, as before.
  assert.equal(satisfiesRange('4.1.0-rc.1', '^4.0.1'), false);
});

test('the declared DSH host range accepts exactly the verified hosts', () => {
  const range = peers['@deepseek-ai/dsh'];
  for (const version of pin.verifiedHosts) {
    assert.equal(satisfiesRange(version, range), true, `${version} is a verified host and must satisfy ${range}`);
  }
  for (const version of ['0.2.0-rc.3', '0.2.1-alpha.2', '0.2.1-rc.1', '0.2.1-rc.3', '0.1.9', '0.3.0', '1.0.0', '0.2.0']) {
    assert.equal(satisfiesRange(version, range), false, `${version} is not a verified host and must not satisfy ${range}`);
  }
  // Build metadata is ignored by semver precedence and by the range itself; the
  // exact-host verdict is a separate fact the doctor keeps in evidence.
  assert.equal(satisfiesRange(`${pin.verifiedHosts[0]}+unverified`, range), true);
});

test('the declared module ranges keep their current verdicts', () => {
  const include = peers['@deepseek-ai/cordis-plugin-include'];
  assert.equal(satisfiesRange('1.0.9', include), true);
  assert.equal(satisfiesRange('1.0.10', include), true);
  assert.equal(satisfiesRange('1.0.10-alpha.1', include), true);
  assert.equal(satisfiesRange('1.0.10-alpha.2', include), true);
  assert.equal(satisfiesRange('1.0.10-alpha.3', include), false);
  assert.equal(satisfiesRange('1.0.8', include), false);

  const cordis = peers['@deepseek-ai/cordis'];
  assert.equal(satisfiesRange('4.0.1', cordis), true);
  assert.equal(satisfiesRange('4.0.4', cordis), true);
  assert.equal(satisfiesRange('4.0.5', cordis), true);
  assert.equal(satisfiesRange('4.0.5-alpha.1', cordis), true);
  assert.equal(satisfiesRange('4.0.5-alpha.2', cordis), true);
  assert.equal(satisfiesRange('4.0.5-alpha.3', cordis), false);
  assert.equal(satisfiesRange('5.0.0', cordis), false);
  assert.equal(satisfiesRange('4.0.0', cordis), false);

  assert.equal(satisfiesRange('4.3.2', peers['js-yaml']), true);
  assert.equal(satisfiesRange('4.2.0', peers['js-yaml']), true);
  assert.equal(satisfiesRange('4.1.9', peers['js-yaml']), false);
  assert.equal(satisfiesRange('5.0.0', peers['js-yaml']), false);

  for (const name of ['@deepseek-ai/dsh-cordis-host-runner', '@deepseek-ai/dsh-tools']) {
    assert.equal(satisfiesRange('0.2.0-rc.2', peers[name]), true, name);
    assert.equal(satisfiesRange('0.2.1-rc.2', peers[name]), true, name);
    assert.equal(satisfiesRange('0.2.0-rc.3', peers[name]), false, name);
  }
});

test('the declared Node.js engine range is unchanged', () => {
  assert.equal(satisfiesRange('22.19.0', manifest.engines.node), true);
  assert.equal(satisfiesRange('24.0.0', manifest.engines.node), true);
  assert.equal(satisfiesRange('26.10.0', manifest.engines.node), true);
  assert.equal(satisfiesRange('22.18.9', manifest.engines.node), false);
  assert.equal(satisfiesRange('23.0.0', manifest.engines.node), false);
});

test('the plain range operators still behave as before', () => {
  assert.equal(satisfiesRange('4.0.4', '^4.0.1'), true);
  assert.equal(satisfiesRange('4.3.2', '^4.2.0'), true);
  assert.equal(satisfiesRange('5.0.0', '^4.0.1'), false);
  assert.equal(satisfiesRange('0.2.0-rc.2', '0.2.0-rc.2 || 0.2.1-alpha.1'), true);
  assert.equal(satisfiesRange('0.2.1-alpha.1', '0.2.0-rc.2 || 0.2.1-alpha.1'), true);
  assert.equal(satisfiesRange('0.3.0', '0.2.0-rc.2 || 0.2.1-alpha.1'), false);
  assert.equal(satisfiesRange('4.0.4', '^4.0.1 || 4.0.5-alpha.1'), true);
  assert.equal(satisfiesRange('1.0.10-alpha.1', '1.0.9 || 1.0.10-alpha.1'), true);
  assert.equal(satisfiesRange('1.2.3', '~1.2.3'), true);
  assert.equal(satisfiesRange('1.3.0', '~1.2.3'), false);
  assert.equal(satisfiesRange('1.2.3', '1.2.3'), true);
  assert.equal(satisfiesRange('v1.2.3', '1.2.3'), true);
  assert.equal(satisfiesRange('not-a-version', '^1.2.3'), false);
  assert.equal(satisfiesRange('1.2.3', 'not-a-range'), false);
});
