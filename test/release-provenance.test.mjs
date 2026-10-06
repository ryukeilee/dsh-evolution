/**
 * The provenance rules decide whether a tag may be published. They are pure, so
 * they are exercised here with a fake repository instead of a checkout: the
 * release workflow calls the same `evaluateProvenance` with real git output.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateProvenance, isFullSha, parseArgs } from '../scripts/release/verify-provenance.mjs';

const HEAD = 'a'.repeat(40);
const BASE = {
  tag: 'v0.2.0-rc.2',
  head: HEAD,
  tagCommit: HEAD,
  sourceCommit: HEAD,
  requireSourceCommit: true,
  isAncestor: () => true,
  packageVersion: '0.2.0-rc.2',
  pinVersion: '0.2.0-rc.2',
  treeDigest: 'c'.repeat(64),
  pinContentSha256: 'c'.repeat(64),
};
const check = (overrides) => evaluateProvenance({ ...BASE, ...overrides });

test('isFullSha accepts only a full lowercase object name', () => {
  assert.equal(isFullSha(HEAD), true);
  assert.equal(isFullSha('a'.repeat(39)), false);
  assert.equal(isFullSha('A'.repeat(40)), false);
  assert.equal(isFullSha('abc123'), false);
  assert.equal(isFullSha(null), false);
});

test('a consistent tag, commit, manifest and tree has no problems', () => {
  const { problems, notes } = check({});
  assert.deepEqual(problems, []);
  assert.ok(notes.some((note) => note.includes('tag v0.2.0-rc.2 -> commit')));
  assert.ok(notes.some((note) => note.includes('source commit')));
});

test('a tag that names another version fails', () => {
  assert.match(check({ tag: 'v0.2.0-rc.1' }).problems.join('\n'), /does not match package\.json version/);
});

test('a tag that points at another commit fails', () => {
  assert.match(check({ tagCommit: 'b'.repeat(40) }).problems.join('\n'), /points to/);
});

test('a tag that does not resolve fails', () => {
  assert.match(check({ tagCommit: null }).problems.join('\n'), /does not resolve/);
});

test('a source commit outside the tagged history fails', () => {
  assert.match(check({ isAncestor: () => false }).problems.join('\n'), /not in the history/);
});

test('a malformed source commit fails', () => {
  assert.match(check({ sourceCommit: 'deadbeef' }).problems.join('\n'), /not a full 40-hex/);
});

test('a missing source commit fails when a new release requires one', () => {
  assert.match(check({ sourceCommit: null }).problems.join('\n'), /does not pin a source commit/);
});

test('a missing source commit is tolerated for a legacy pin', () => {
  const { problems, notes } = check({ sourceCommit: null, requireSourceCommit: false });
  assert.deepEqual(problems, []);
  assert.ok(notes.some((note) => note.includes('legacy pin')));
});

test('a pin that disagrees with package.json fails', () => {
  assert.match(check({ pinVersion: '0.2.0-rc.1' }).problems.join('\n'), /pins version 0\.2\.0-rc\.1/);
});

test('a tree that no longer builds the pinned content fails', () => {
  assert.match(check({ treeDigest: 'd'.repeat(64) }).problems.join('\n'), /the tagged tree builds/);
});

test('an untagged verification still checks the pin and the tree', () => {
  const { problems } = check({ tag: null, tagCommit: null });
  assert.deepEqual(problems, []);
});

test('the CLI arguments are parsed strictly', () => {
  assert.deepEqual(parseArgs(['--tag', 'v0.2.0-rc.2', '--require-source-commit']), {
    tag: 'v0.2.0-rc.2',
    requireSourceCommit: true,
    json: false,
  });
  assert.throws(() => parseArgs(['--tag']), /requires a value/);
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
});
