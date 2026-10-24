/**
 * The provenance rules decide whether a tag may be published. They are pure, so
 * they are exercised here with a fake repository instead of a checkout: the
 * release workflow calls the same `evaluateProvenance` with real git output.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, commitContentDigest, contentDigestOf } from '../scripts/release/release-lib.mjs';
import { evaluateProvenance, isFullSha, parseArgs } from '../scripts/release/verify-provenance.mjs';

const HEAD = 'a'.repeat(40);
const BASE = {
  tag: 'v0.2.0-rc.2',
  head: HEAD,
  tagCommit: HEAD,
  sourceCommit: HEAD,
  sourceDigest: 'c'.repeat(64),
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

test('an ancestor with different shipped content cannot be claimed as the source', () => {
  assert.match(check({ sourceDigest: 'd'.repeat(64) }).problems.join('\n'), /source commit content .* does not match/);
  assert.match(check({ sourceDigest: null }).problems.join('\n'), /source commit content .* does not match/);
});

test('the source digest reads committed files and detects later shipped changes', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-source-digest-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  fs.mkdirSync(path.join(cwd, 'lib'));
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'source-fixture', version: '1.0.0', files: ['lib'] }));
  fs.writeFileSync(path.join(cwd, 'README.md'), 'source fixture');
  fs.writeFileSync(path.join(cwd, 'LICENSE'), 'MIT');
  fs.writeFileSync(path.join(cwd, 'lib', 'index.js'), 'export const value = 1;');
  const commit = () => {
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  const source = commit();
  const digest = commitContentDigest(source, cwd);
  fs.writeFileSync(path.join(cwd, 'lib', 'index.js'), 'export const value = 2;');
  assert.equal(commitContentDigest(source, cwd), digest, 'uncommitted files cannot alter the claimed source');
  const changed = commit();
  assert.notEqual(commitContentDigest(changed, cwd), digest, 'a shipped change must invalidate the source claim');
  fs.writeFileSync(path.join(cwd, 'evidence.json'), '{"ok":true}');
  assert.equal(commitContentDigest(commit(), cwd), commitContentDigest(changed, cwd), 'unshipped evidence does not change the package');
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
  // A recognised option still carries its value through unchanged; only the
  // unrecognised token is dropped from the report.
  assert.equal(parseArgs(['--tag', 'sk-review-sentinel']).tag, 'sk-review-sentinel');
});

test('an unknown CLI argument is refused without being echoed', () => {
  // The reviewer's counterexample: the token reached stderr verbatim as
  // `unknown argument: sk-review-sentinel`. It is caller data on a line that
  // ends up in a terminal and a pasted issue, so only the category is reported.
  const sentinel = 'sk-review-sentinel';
  const run = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, 'scripts', 'release', 'verify-provenance.mjs'), sentinel],
    { encoding: 'utf8' },
  );
  const surface = `${run.stdout}\n${run.stderr}`;
  assert.equal(run.status, 2, 'an unparseable command line is a usage error');
  assert.equal(surface.includes(sentinel), false, 'the argument value must not be printed');
  assert.match(surface, /unknown argument/);
  assert.equal(/^\s+at /m.test(surface), false, 'and the refusal is one line, not a stack trace');
});

/**
 * A throwaway git repository holding the shipped files of a package, so the real
 * `commitContentDigest()` reads a real commit. `package.json` is written by the
 * caller: that text is the document under test.
 */
function digestRepo(packageText) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-source-manifest-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  fs.mkdirSync(path.join(cwd, 'lib'));
  fs.writeFileSync(path.join(cwd, 'package.json'), packageText);
  fs.writeFileSync(path.join(cwd, 'README.md'), 'source fixture');
  fs.writeFileSync(path.join(cwd, 'LICENSE'), 'MIT');
  fs.writeFileSync(path.join(cwd, 'lib', 'index.js'), 'export const value = 1;');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  return { cwd, commit: git('rev-parse', 'HEAD') };
}

test('the source digest refuses a commit whose package.json repeats the files key', (t) => {
  const FILE_SENTINEL = 'sk-review-files';
  // Valid JSON, and `JSON.parse` keeps the second `files` list — so the digest
  // used to cover a package nobody committed. The first key is spelled with an
  // escape, which a text comparison of key names would not catch either.
  const text = [
    '{',
    '  "name": "source-fixture",',
    '  "version": "1.0.0",',
    `  "files": [${JSON.stringify(FILE_SENTINEL)}],`,
    '  "\\u0066iles": ["lib"]',
    '}',
    '',
  ].join('\n');
  // Premise: the document is valid JSON and a plain parse resolves it silently.
  assert.equal(text.includes('"\\u0066iles"'), true);
  assert.deepEqual(JSON.parse(text).files, ['lib']);

  const { cwd, commit } = digestRepo(text);
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  assert.throws(() => commitContentDigest(commit, cwd), (error) => {
    assert.match(error.message, /the committed package\.json repeats an object key, so which value applies is ambiguous/);
    assert.equal(error.message.includes(FILE_SENTINEL), false, 'the dropped value must not be echoed');
    assert.equal(error.message.includes('\\u0066'), false, 'nor the ambiguous key');
    assert.equal(error.message.includes(cwd), false, 'nor the repository path');
    return true;
  });
});

test('the source digest of an unambiguous commit is the digest of exactly its shipped files', (t) => {
  const text = `${JSON.stringify({ name: 'source-fixture', version: '1.0.0', files: ['lib'] }, null, 2)}\n`;
  const { cwd, commit } = digestRepo(text);
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  // Computed independently, from the bytes on disk and the modes git records.
  const entries = ['LICENSE', 'README.md', 'lib/index.js', 'package.json'].map((relative) => ({
    path: relative,
    mode: 0o644,
    bytes: fs.readFileSync(path.join(cwd, relative)),
  }));
  const expected = contentDigestOf(entries);
  assert.equal(commitContentDigest(commit, cwd), expected);
  // Deterministic, and stable against a working tree that keeps changing.
  fs.writeFileSync(path.join(cwd, 'lib', 'index.js'), 'export const value = 2;');
  assert.equal(commitContentDigest(commit, cwd), expected);
});
