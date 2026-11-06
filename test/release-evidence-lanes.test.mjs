/**
 * The acceptance record has two lanes, and `pack:check` used to run them as one
 * check. It drove the loop from the working tree's `peerDependencies` but
 * compared every record to the pin, so adding a supported host to a development
 * tree was impossible without either re-pinning (claiming a release that never
 * happened) or writing the candidate's digest into the historical record. The
 * first is a false release claim and the second destroys the only proof of what
 * actually shipped.
 *
 * The split is `release/manifest.json#verifiedHosts`:
 *
 *   - a host the pin verified has a historical record, and that record must
 *     describe the pinned bytes and content forever;
 *   - a host the tree added has no historical record, so the only honest proof
 *     that this content was accepted on it is a record produced against this
 *     content. Older release evidence describes another build and is refused.
 *
 * These cases pin the decision table. They are pure: each one hands a pin, a
 * manifest, a tree digest and a scratch `docs/evidence/` root to the same
 * evaluators `verify-package.mjs` and `test/release-pin.test.mjs` call, so a
 * regression in either lane fails `npm test` without running `npm pack`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { evaluateAddedHostAcceptance, evaluatePinnedAcceptance } from '../scripts/release/release-lib.mjs';

const PINNED_HOST = '0.2.0-rc.2';
const ADDED_HOST = '0.9.9-rc.1';
const VERSION = '0.1.0';
const PIN_CONTENT = 'a'.repeat(64);
const PIN_BYTES = 'b'.repeat(64);
const TREE_CONTENT = 'c'.repeat(64);
const OTHER_BYTES = 'd'.repeat(64);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-evidence-lanes-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let caseCount = 0;
/** A scratch root holding the acceptance records a case supplies by host. */
function evidenceRoot(records) {
  const root = path.join(scratch, `case-${caseCount += 1}`);
  fs.mkdirSync(path.join(root, 'docs', 'evidence'), { recursive: true });
  for (const [host, record] of Object.entries(records)) {
    const text = typeof record === 'string' ? record : `${JSON.stringify(record, null, 2)}\n`;
    fs.writeFileSync(path.join(root, 'docs', 'evidence', `dsh-${host}.json`), text);
  }
  return root;
}

const pin = (overrides = {}) => ({
  name: 'dsh-evolution-probe',
  version: VERSION,
  contentSha256: PIN_CONTENT,
  sha256: PIN_BYTES,
  verifiedHosts: [PINNED_HOST],
  evidence: [`docs/evidence/dsh-${PINNED_HOST}.json`],
  ...overrides,
});

const manifest = (hosts) => ({
  name: 'dsh-evolution-probe',
  version: VERSION,
  peerDependencies: { '@deepseek-ai/dsh': hosts.join(' || ') },
});

const record = (overrides = {}) => ({
  ok: true,
  hostVersion: PINNED_HOST,
  packageVersion: VERSION,
  contentSha256: PIN_CONTENT,
  tarballSha256: PIN_BYTES,
  ...overrides,
});

test('the pin lane refuses a record that was re-targeted to this tree', () => {
  // The failure mode the old single check invited: make the new evidence pass by
  // overwriting the historical digest. That turns "these bytes were accepted"
  // into "some build was", and nothing can tell them apart afterwards.
  const root = evidenceRoot({ [PINNED_HOST]: record({ contentSha256: TREE_CONTENT }) });
  const { problems } = evaluatePinnedAcceptance(pin(), { root });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.equal(problems[0].includes(`the evidence covers content ${TREE_CONTENT}, but the pin records ${PIN_CONTENT}`), true);
});

test('the pin lane refuses a record whose bytes are not the pinned artifact', () => {
  const root = evidenceRoot({ [PINNED_HOST]: record({ tarballSha256: OTHER_BYTES }) });
  const { problems } = evaluatePinnedAcceptance(pin(), { root });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.equal(problems[0].includes(`the evidence was recorded against ${OTHER_BYTES}, but the pinned artifact is ${PIN_BYTES}`), true);
});

test('the pin lane verifies the pin hosts and ignores the ones this tree adds', () => {
  // The exact regression: the pin verified one host, the tree declares two, and
  // the added host has no record at all. The pin's lane is still complete, and it
  // must say so instead of requiring the pin to describe a host it never shipped.
  const root = evidenceRoot({ [PINNED_HOST]: record() });
  const { hosts, problems } = evaluatePinnedAcceptance(pin(), { root });
  assert.deepEqual(hosts, [PINNED_HOST]);
  assert.deepEqual(problems, []);
});

test('an added host cannot borrow the pin record', () => {
  // The other half of the old conflation: the added host was accepted against the
  // *pin's* content, so comparing it to the pin passed while saying nothing about
  // this tree. Its own record must describe this tree.
  const root = evidenceRoot({
    [PINNED_HOST]: record(),
    [ADDED_HOST]: record({ hostVersion: ADDED_HOST, tarballSha256: OTHER_BYTES }),
  });
  const { hosts, problems } = evaluateAddedHostAcceptance({
    pin: pin(), manifest: manifest([PINNED_HOST, ADDED_HOST]), treeDigest: TREE_CONTENT, root,
  });
  assert.deepEqual(hosts, [ADDED_HOST]);
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.equal(problems[0].includes(`the evidence covers content ${PIN_CONTENT}, but this tree builds ${TREE_CONTENT}`), true);
});

test('an added host accepted against this tree passes, and leaves the pin lane alone', () => {
  const root = evidenceRoot({
    [PINNED_HOST]: record(),
    [ADDED_HOST]: record({ hostVersion: ADDED_HOST, tarballSha256: OTHER_BYTES, contentSha256: TREE_CONTENT }),
  });
  const args = { pin: pin(), manifest: manifest([PINNED_HOST, ADDED_HOST]), treeDigest: TREE_CONTENT, root };
  assert.deepEqual(evaluatePinnedAcceptance(args.pin, { root }).problems, []);
  const { hosts, problems } = evaluateAddedHostAcceptance(args);
  assert.deepEqual(hosts, [ADDED_HOST]);
  assert.deepEqual(problems, []);
});

test('an added host without any record is refused, not skipped', () => {
  const root = evidenceRoot({ [PINNED_HOST]: record() });
  const { problems } = evaluateAddedHostAcceptance({
    pin: pin(), manifest: manifest([PINNED_HOST, ADDED_HOST]), treeDigest: TREE_CONTENT, root,
  });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.equal(problems[0], `missing docs/evidence/dsh-${ADDED_HOST}.json`);
});

test('a host version that cannot name a record is refused without deriving a path from it', () => {
  // The record path is derived from the host and the recorded path has to equal
  // it; a pin that names `../../elsewhere` is refused by the name grammar before
  // any path is joined, so nothing outside `docs/evidence/` can be read.
  const traversal = '../../escape';
  const travelling = pin({ verifiedHosts: [traversal], evidence: [`docs/evidence/dsh-${traversal}.json`] });
  const root = evidenceRoot({});
  const { problems } = evaluatePinnedAcceptance(travelling, { root });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.equal(problems[0].includes('is not a host version an acceptance record can be named after'), true);
});

test('the pin lane refuses a recorded path that is not the host it claims', () => {
  // A pin that names one file but records another host's digest would otherwise
  // let the reader open the file the pin names and call it coverage.
  const root = evidenceRoot({ [PINNED_HOST]: record() });
  const mismatched = pin({ evidence: [`docs/evidence/dsh-${ADDED_HOST}.json`] });
  const { problems } = evaluatePinnedAcceptance(mismatched, { root });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.equal(problems[0].includes(`names "docs/evidence/dsh-${ADDED_HOST}.json" instead of docs/evidence/dsh-${PINNED_HOST}.json`), true);
});
