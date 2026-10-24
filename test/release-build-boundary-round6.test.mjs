/**
 * Round 6 independent review: two blockers and one measured toolchain shape in
 * the build/release boundary. Everything here runs against a private
 * `os.tmpdir()` directory and a real `release:pack` output; nothing writes
 * `release/`, `dist/`, a fixed byte or a real credential.
 *
 *   1. A **repeated JSON key** defeated the closed build-manifest schema.
 *      `JSON.parse` keeps the last value for a key and silently drops the earlier
 *      one, so a `"builtWith"` object carrying `apiKey: "sk-…"` inserted *before*
 *      the genuine record parsed as an exact toolchain triple: every field check
 *      saw the second object, the packer rewrote the file, and the caller's first
 *      object was gone. No post-parse check can see this, so the build manifest,
 *      the candidate manifest and both committed-pin reads now check the *text*
 *      for a repeated key at any depth (`assertNoDuplicateJsonKeys`) and refuse
 *      the document without echoing a key name, a value or a parser message.
 *   2. A filesystem exception other than ENOENT was rethrown verbatim, so
 *      `--dist <tmp>/private-sentinel/output` printed Node's stack with an
 *      `ENOTDIR … lstat '/…/private-sentinel/output'` line — the caller's path.
 *      Filesystem exceptions are now reported as a fixed label plus the errno
 *      category, and no target is written.
 *   3. The measured Node nightly shape (`v27.0.0-nightly202610236d4646731e`, the
 *      newest entry of nodejs.org/download/nightly/index.json) was refused by the
 *      old 32-character field bound, which is a real toolchain a build can run on.
 *      It is admitted by one exact alternative (eight-digit date, ten-character
 *      commit) and the length cap is now the longest value the grammar can spell.
 *      Credential-shaped suffixes stay refused.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  DuplicateJsonKeyError,
  REPO_ROOT,
  assertNoDuplicateJsonKeys,
  builtWithProblems,
  parseJsonText,
  readManifest,
  readReleaseManifest,
} from '../scripts/release/release-lib.mjs';
import { inspectPinWriteTargets, inspectPinnedRelease } from '../scripts/release/publish-artifact.mjs';

const packageManifest = readManifest();
const pinned = readReleaseManifest();
const FILENAME = `${packageManifest.name}-${packageManifest.version}.tgz`;
const PACK = path.join(REPO_ROOT, 'scripts', 'release', 'pack.mjs');
const PUBLISH = path.join(REPO_ROOT, 'scripts', 'release', 'publish-artifact.mjs');
const BUILD_MANIFEST = 'manifest.json';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-build-boundary-round6-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let fixtureCount = 0;
function freshDir() {
  const dir = path.join(scratch, `set-${fixtureCount += 1}`);
  fs.mkdirSync(dir);
  return dir;
}

function sha256Of(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Name + content hash of everything in a directory, for "left as it was" checks. */
function snapshot(dir) {
  const state = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) state[name] = `symlink -> ${fs.readlinkSync(file)}`;
    else if (stat.isFile()) state[name] = `file ${stat.size} ${stat.mode.toString(8)} ${sha256Of(fs.readFileSync(file))}`;
    else state[name] = `mode ${stat.mode.toString(8)}`;
  }
  return state;
}

/** The committed release set, hashed so a test can prove it was not written to. */
function committedReleaseSnapshot() {
  return Object.fromEntries(['manifest.json', FILENAME, 'SHA256SUMS'].map((name) => {
    const file = path.join(REPO_ROOT, 'release', name);
    const stat = fs.lstatSync(file);
    return [name, stat.isFile() ? sha256Of(fs.readFileSync(file)) : `not-a-file:${stat.mode}`];
  }));
}

/**
 * One real `release:pack` output, built once and copied per test. It is the
 * genuine writer output — the duplicate-key counterexample has to be inserted
 * into a manifest that would otherwise be accepted, or the test proves nothing.
 */
let seedDir = null;
function seedBuild() {
  if (seedDir !== null) return seedDir;
  const dir = path.join(scratch, 'pack-seed');
  const run = spawnSync(process.execPath, [PACK, '--dist', dir], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, `building the seed output failed:\n${run.stdout}\n${run.stderr}`);
  seedDir = dir;
  return dir;
}

/** Copy the seed output into a fresh directory and return it. */
function copyOfSeed() {
  const dir = freshDir();
  fs.cpSync(seedBuild(), dir, { recursive: true });
  return dir;
}

/** Insert one extra property line immediately before the recorded `builtWith`. */
function withRepeatedBuiltWith(text, injected) {
  const marker = `\n  "builtWith":`;
  const at = text.indexOf(marker);
  assert.ok(at > 0, 'the writer must record builtWith as its own indented line');
  return `${text.slice(0, at + 1)}  "builtWith": ${injected},\n${text.slice(at + 1)}`;
}

// ---------------------------------------------------------------------------
// 1. a repeated JSON key is refused before anything is parsed
// ---------------------------------------------------------------------------

test('the duplicate-key reader tracks nesting, escapes, values and literals', () => {
  const accepted = [
    '{}',
    '[]',
    '{"a":1,"b":{"a":2}}',
    '[{"k":1},{"k":2}]',
    '{"a":[{"k":1},{"k":2}],"b":[[],{}]}',
    '{"a":"builtWith: builtWith","b":["a","a","{a}"]}',
    '{"a":1e5,"b":-0.5e-3,"c":[true,false,null],"d":{"e":"f"}}',
    '{"\\u0062uiltWith":"value"}',
    '{"a b":"a  b"}',
  ];
  for (const text of accepted) {
    assertNoDuplicateJsonKeys(text);
    assert.deepEqual(parseJsonText(text), JSON.parse(text), `${text} must parse to the same value`);
  }

  const repeated = [
    '{"a":1,"a":2}',
    '{"b":{"a":1,"a":2}}',
    '{"a":{"b":{"c":1,"c":2}}}',
    '[{"x":1,"x":2}]',
    '{"\\u0062uiltWith":1,"builtWith":2}',
    '{"a\\nb":1,"a\\u000ab":2}',
    '{"builtWith":{"node":"v26.12.0"},"builtWith":{"node":"sk-review-hidden"}}',
  ];
  for (const text of repeated) {
    assert.throws(() => assertNoDuplicateJsonKeys(text), DuplicateJsonKeyError, text);
    assert.throws(() => parseJsonText(text), (error) => {
      assert.equal(error instanceof DuplicateJsonKeyError, true);
      assert.equal(error.message.includes('sk-review-hidden'), false, 'the reader must not quote the document');
      assert.equal(error.message.includes('builtWith'), false, 'nor a key name');
      return true;
    }, text);
  }

  // Text this walk cannot follow is a syntax problem, not a stack overflow: a
  // document nested past the scan cap is refused instead of recursing forever.
  for (const text of ['{"a":1,}', '{"a" 1}', '{"a":1} {"b":2}', 'nope']) {
    assert.throws(() => assertNoDuplicateJsonKeys(text), SyntaxError, text);
  }
  assert.throws(() => assertNoDuplicateJsonKeys('['.repeat(5000) + ']'.repeat(5000)), SyntaxError);
});

const DUPLICATE_SENTINEL = 'sk-review-hidden';

test('release:pack refuses a build manifest that repeats builtWith, and leaves every byte alone', () => {
  const dir = copyOfSeed();
  const manifestFile = path.join(dir, BUILD_MANIFEST);
  const original = fs.readFileSync(manifestFile, 'utf8');
  const injected = `{"node": "v26.12.0", "npm": "11.20.0", "platform": "darwin-arm64", "apiKey": "${DUPLICATE_SENTINEL}"}`;
  const duplicated = withRepeatedBuiltWith(original, injected);
  fs.writeFileSync(manifestFile, duplicated);

  // The premise: `JSON.parse` keeps the last builtWith and silently drops the
  // object that carries the injected field, so a post-parse schema check sees an
  // exact toolchain triple. This is the bypass the text check closes.
  const parsed = JSON.parse(duplicated);
  assert.deepEqual(Object.keys(parsed.builtWith), ['node', 'npm', 'platform']);
  assert.equal('apiKey' in parsed.builtWith, false, 'JSON.parse drops the earlier object');
  assert.equal(duplicated.includes(DUPLICATE_SENTINEL), true, 'the injected value is in the file');
  assert.equal(JSON.stringify(parsed).includes(DUPLICATE_SENTINEL), false, 'but not in the parsed value');

  const before = snapshot(dir);
  const result = spawnSync(process.execPath, [PACK, '--dist', dir], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'a manifest with a repeated key must not be overwritten');
  const surface = `${result.stdout}\n${result.stderr}`;
  assert.match(surface, /refusing to overwrite manifest\.json: it repeats an object key/);
  assert.equal(surface.includes(DUPLICATE_SENTINEL), false, 'the injected value must not be echoed');
  assert.equal(surface.includes('apiKey'), false, 'nor its key name');
  assert.equal(/Unexpected|at Object|at Module/.test(surface), false, 'nor a parser snippet or a stack frame');
  assert.deepEqual(snapshot(dir), before, 'the output directory is byte-identical after the refusal');
  assert.equal(fs.readFileSync(manifestFile, 'utf8'), duplicated, 'the caller\'s duplicate-bearing manifest is preserved');

  // The same candidate through the publisher: the pin must not be written from an
  // ambiguous manifest either, and the candidate and `release/` stay as they were.
  const releaseBefore = committedReleaseSnapshot();
  const published = spawnSync(process.execPath, [PUBLISH, '--from', dir], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.notEqual(published.status, 0, 'the publisher must refuse the repeated key');
  const publishSurface = `${published.stdout}\n${published.stderr}`;
  assert.match(publishSurface, /the build manifest is not readable: it repeats an object key/);
  assert.match(publishSurface, /nothing was pinned/);
  assert.equal(publishSurface.includes(DUPLICATE_SENTINEL), false);
  assert.equal(publishSurface.includes('apiKey'), false);
  assert.deepEqual(snapshot(dir), before, 'a refused publish leaves the candidate as it was');
  assert.deepEqual(committedReleaseSnapshot(), releaseBefore, 'nothing may be pinned');
});

test('a nested repeated key inside builtWith is refused by both entry points', () => {
  const dir = copyOfSeed();
  const manifestFile = path.join(dir, BUILD_MANIFEST);
  const original = fs.readFileSync(manifestFile, 'utf8');
  // A repeat one level deeper: the same field twice inside the record itself, with
  // the injected value first, so it is the one `JSON.parse` throws away.
  const duplicated = original.replace(
    '"node": "',
    `"node": "${DUPLICATE_SENTINEL}", "node": "`,
  );
  assert.notEqual(duplicated, original);
  fs.writeFileSync(manifestFile, duplicated);
  assert.equal(duplicated.includes(DUPLICATE_SENTINEL), true, 'the injected value is in the file');
  assert.equal(JSON.stringify(JSON.parse(duplicated)).includes(DUPLICATE_SENTINEL), false, 'but not in the parsed value');
  const before = snapshot(dir);

  const result = spawnSync(process.execPath, [PACK, '--dist', dir], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /repeats an object key/);
  assert.equal(`${result.stdout}\n${result.stderr}`.includes(DUPLICATE_SENTINEL), false);
  assert.deepEqual(snapshot(dir), before);

  const published = spawnSync(process.execPath, [PUBLISH, '--from', dir], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.notEqual(published.status, 0);
  assert.match(`${published.stdout}\n${published.stderr}`, /repeats an object key/);
  assert.deepEqual(snapshot(dir), before);
});

test('a committed pin that repeats a key is refused on both pin reads', () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, 'manifest.json'), [
    '{',
    `  "name": ${JSON.stringify(packageManifest.name)},`,
    `  "name": ${JSON.stringify(packageManifest.name)},`,
    '}',
    '',
  ].join('\n'));
  const { problems } = inspectPinnedRelease({ releaseDir: dir, selfConsistentOnly: true });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /release\/manifest\.json is not a readable pin: it repeats an object key/);
  assert.equal(problems.join('\n').includes(packageManifest.name), false, 'the pin value must not be echoed');

  const writeTargets = inspectPinWriteTargets({ releaseDir: dir, filename: FILENAME });
  assert.equal(writeTargets.pinPresent, false, 'an ambiguous pin is not a pin that can be replaced');
  assert.match(writeTargets.problems.join('\n'), /cannot be replaced safely \(it repeats an object key\)/);
});

// ---------------------------------------------------------------------------
// 2. a filesystem exception reports the errno category, never the caller's path
// ---------------------------------------------------------------------------

const PATH_SENTINEL = 'private-sentinel';

test('a filesystem exception below --dist is reported by errno category, and nothing is written', () => {
  const dir = freshDir();
  const blocker = path.join(dir, PATH_SENTINEL);
  fs.writeFileSync(blocker, 'this is a regular file, so it cannot hold an output directory\n');
  const target = path.join(blocker, 'output');

  const run = spawnSync(process.execPath, [PACK, '--dist', target], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.notEqual(run.status, 0, 'lstat below a regular file cannot be treated as an absent output');
  const surface = `${run.stdout}\n${run.stderr}`;
  assert.match(surface, /release:pack failed: refusing to inspect an output entry: the filesystem reported ENOTDIR/);
  assert.equal(surface.includes(PATH_SENTINEL), false, 'the --dist path must not be echoed');
  assert.equal(surface.includes(dir), false, 'nor any absolute caller path');
  assert.equal(surface.includes(os.tmpdir()), false, 'nor the temporary root it lives under');
  assert.equal(/^\s+at /m.test(surface), false, 'no stack trace is printed');
  assert.equal(fs.readFileSync(blocker, 'utf8'), 'this is a regular file, so it cannot hold an output directory\n');
  assert.deepEqual(fs.readdirSync(dir), [PATH_SENTINEL], 'nothing was created anywhere');

  // The publisher's own filesystem boundary: the same shape on `--from`.
  const releaseBefore = committedReleaseSnapshot();
  const publishRun = spawnSync(process.execPath, [PUBLISH, '--from', path.join(blocker, 'build')], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.notEqual(publishRun.status, 0);
  const publishSurface = `${publishRun.stdout}\n${publishRun.stderr}`;
  assert.match(publishSurface, /the build directory cannot be inspected \(ENOTDIR\)/);
  assert.equal(publishSurface.includes(PATH_SENTINEL), false);
  assert.equal(publishSurface.includes(dir), false);
  assert.deepEqual(committedReleaseSnapshot(), releaseBefore);
});

// ---------------------------------------------------------------------------
// 3. the measured Node nightly shape is a toolchain, and stays bounded
// ---------------------------------------------------------------------------

/**
 * `nodejs.org/download/nightly/index.json`, read on 2026-10-23: 370 entries, all
 * of the form `v<major>.<minor>.<patch>-nightly<YYYYMMDD><commit>`. 369 carry a
 * ten-character commit; one 2023 entry carries the full 40-character object name.
 * Every one of the 370 is admitted by the rule below; the two values here are the
 * newest entry (the shape a build of this repository on an official nightly would
 * record in `builtWith.node`) and the measured 40-character outlier.
 */
const NODE_NIGHTLY = 'v27.0.0-nightly202610236d4646731e';
const NODE_NIGHTLY_FULL_SHA = 'v20.7.0-nightly202309173557c436181c526f41bb6ce7751e63f36695aa1d';

test('the measured Node nightly build stamp is a toolchain version', () => {
  assert.equal(NODE_NIGHTLY.length, 33, 'the value is longer than the old 32-character field bound');
  assert.equal(NODE_NIGHTLY_FULL_SHA.length, 63);
  assert.deepEqual(builtWithProblems({ ...pinned.builtWith, node: NODE_NIGHTLY }), []);
  assert.deepEqual(builtWithProblems({ ...pinned.builtWith, node: NODE_NIGHTLY_FULL_SHA }), []);
  // An older nightly from the same index: the date-and-commit shape has not changed.
  assert.deepEqual(builtWithProblems({ ...pinned.builtWith, node: 'v0.10.41-nightly20151203036580393d' }), []);

  // It is a Node version of the same `v<major>.<minor>.<patch>` shape the
  // `engines` range names (a nightly never satisfies a semver range, which is a
  // property of semver pre-releases, not of this check); the suffix boundaries
  // stay exact: eight digits, then ten or forty lowercase hex characters, with
  // nothing around them.
  const refused = [
    'v27.0.0-nightly', // the tag word with no build stamp
    'v27.0.0-nightly20261023', // the build date without the commit
    'v27.0.0-nightly20261023.rc1', // a build stamp joined to another identifier
    'v27.0.0-nightly202610236d4646731', // nine-character commit
    'v27.0.0-nightly202610236d4646731e0', // eleven-character commit
    'v27.0.0-nightly2026102a6d4646731e', // non-digit build date
    'v27.0.0-nightly202610236D4646731E', // uppercase commit
    'v27.0.0-nightly202610236d4646731e.sklive', // a stamp is not an identifier list
    'v27.0.0-nightly202610236d4646731e-rc.1',
    'v27.0.0-nightly202610236.d4646731e', // date and commit split by a dot
    'v20.7.0-nightly202309173557c436181c526f41bb6ce7751e63f36695aa', // 39-character commit
    'v20.7.0-nightly202309173557c436181c526f41bb6ce7751e63f36695aa1d0', // 41-character commit
  ];
  for (const node of refused) {
    const problems = builtWithProblems({ ...pinned.builtWith, node });
    assert.ok(problems.length > 0, `${node} must be refused`);
    assert.equal(problems.join('\n').includes(node), false, 'the refused value must not be echoed');
  }

  // Credential-shaped suffixes are still refused, including ones that borrow the
  // nightly tag word.
  for (const node of ['v26.12.0-sklive', 'v26.12.0-secrettok', 'v26.12.0-tokenabc', 'v26.12.0-nightly.secretkey', 'v26.12.0-nightly20230101.sklive']) {
    const problems = builtWithProblems({ ...pinned.builtWith, node });
    assert.ok(problems.length > 0, `${node} must stay refused`);
    assert.equal(/sklive|secrettok|tokenabc|secretkey/.test(problems.join('\n')), false, 'no credential-shaped part is echoed');
  }

  // The length cap is the longest value the grammar can spell, so it never rejects
  // a shape the pattern itself admits.
  const longestNightly = `v999.999.999-nightly20261023${'a'.repeat(40)}`;
  // The longest identifier list for the field. It is built from `rc`, not from
  // `nightly`: the tag word is only admissible as part of one whole build stamp,
  // so a list of nightly identifiers is not a shape the grammar can spell.
  const longestIdentifiers = 'v999.999.999-rc99999999.rc99999999.rc99999999';
  const longestNpm = '999.999.999-alpha99999999.alpha99999999.alpha99999999';
  assert.equal(longestNightly.length, 68);
  assert.equal(longestIdentifiers.length, 45);
  assert.equal(longestNpm.length, 53);
  for (const [field, value] of [['node', longestNightly], ['node', longestIdentifiers], ['npm', longestNpm]]) {
    assert.deepEqual(builtWithProblems({ ...pinned.builtWith, [field]: value }), [], `${field}: ${value.length} characters`);
  }
  assert.ok(
    builtWithProblems({ ...pinned.builtWith, node: 'v999.999.999-nightly20230101.nightly20230101.nightly20230101' }).length > 0,
    'a list of nightly identifiers is not a build stamp',
  );

  // The other direction: the cap still refuses an oversized field by count, and
  // says so without printing it.
  const oversized = builtWithProblems({ ...pinned.builtWith, node: `v26.12.0-${'a'.repeat(200)}` });
  assert.match(oversized.join('\n'), /longer than the 68-character limit/);
  assert.equal(oversized.join('\n').includes('aaaaaaaaaa'), false);
});
