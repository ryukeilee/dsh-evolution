/**
 * Round 7 independent review: two blockers in the build/release boundary.
 *
 *   1. `scripts/release/release-lib.mjs#readManifest` still called `JSON.parse`
 *      on `package.json` itself, while every other release document (the build
 *      manifest, the candidate manifest, the committed pin) already went through
 *      `parseJsonText`. `release:pack`, `release:publish` and `pack:check` all
 *      take the package name, version and `files` allow-list from that one read,
 *      so a `package.json` that repeated `"version"` silently resolved to the
 *      last value and the earlier one was dropped without a trace. The read now
 *      goes through the duplicate-safe parser and reports one fixed label
 *      (`package.json repeats an object key …`) with no path, key, value or
 *      parser snippet.
 *   2. `PRERELEASE_TAGS` listed `nightly` among the generic node identifiers, so
 *      the shared `-<identifier>(.<identifier>){0,2}` alternative admitted
 *      `-nightly`, `-nightly20261023` and `-nightly20261023.rc1`. The nightly
 *      index publishes only `-nightly<YYYYMMDD><hex>`; that whole stamp is now
 *      the only nightlies the grammar can spell.
 *
 * Everything runs in a private `os.tmpdir()` directory. The first section builds
 * a *throwaway repository* — copies of the release modules under test plus a
 * fixture `package.json` — so the real entry points (`release:pack`,
 * `pack:check`, `release:publish`) run their real code path against a document
 * with a repeated key. Nothing here edits the repository's own `package.json`,
 * `release/`, `dist/` or any fixed byte.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createPrivateNpmEnv } from '../scripts/acceptance/npm-cache-env.mjs';
import {
  REPO_ROOT, builtWithProblems, readManifest, readReleaseManifest,
} from '../scripts/release/release-lib.mjs';

const pinned = readReleaseManifest();
const RELEASE_MODULES = path.join(REPO_ROOT, 'scripts', 'release');

// `realpath` on purpose: `publish-artifact.mjs` decides whether it is the entry
// point by comparing `pathToFileURL(process.argv[1])` with `import.meta.url`, and
// Node resolves a module to its real path. A fixture below a symlinked temp root
// (`/var` → `/private/var` on macOS) would make that comparison false, and the
// publisher would then exit 0 having done nothing — which is exactly what these
// tests must not mistake for a refusal.
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evo-build-boundary-round7-')));
const TEMP_ROOT_SPELLINGS = [os.tmpdir(), fs.realpathSync(os.tmpdir())];
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let fixtureCount = 0;
function freshDir() {
  const dir = path.join(scratch, `set-${fixtureCount += 1}`);
  fs.mkdirSync(dir);
  return dir;
}

/** Name, size, mode and content hash of everything in a directory. */
function snapshot(dir) {
  const state = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) state[name] = 'directory';
    else if (stat.isSymbolicLink()) state[name] = `symlink -> ${fs.readlinkSync(file)}`;
    else state[name] = `file ${stat.size} ${stat.mode.toString(8)}`;
  }
  return state;
}

// ---------------------------------------------------------------------------
// 1. a repeated key in package.json
// ---------------------------------------------------------------------------

const DUPLICATE_SENTINEL = 'sk-review-package-json';
const VALID_PACKAGE = { name: 'dsh-evolution-probe', version: '0.0.1-rc.0', files: [] };
const VALID_TEXT = `${JSON.stringify(VALID_PACKAGE, null, 2)}\n`;

/**
 * Three documents that are valid JSON, would parse to an exact `package.json`,
 * and each hide a repeated key at a different place: a top-level `version`, the
 * same key spelled with a `\uXXXX` escape so a text-only key comparison would
 * miss it, and a repeat one object deeper.
 *
 * `JSON.parse` resolves every one of them to the last value, so each fixture also
 * asserts that premise: the sentinel is in the text and not in the parsed value.
 */
const DUPLICATE_PACKAGES = new Map([
  ['a repeated top-level version key', [
    '{',
    `  "name": ${JSON.stringify(VALID_PACKAGE.name)},`,
    `  "version": ${JSON.stringify(DUPLICATE_SENTINEL)},`,
    `  "version": ${JSON.stringify(VALID_PACKAGE.version)},`,
    '  "files": []',
    '}',
    '',
  ].join('\n')],
  ['the same key spelled with a unicode escape', [
    '{',
    `  "name": ${JSON.stringify(VALID_PACKAGE.name)},`,
    `  "\\u0076ersion": ${JSON.stringify(DUPLICATE_SENTINEL)},`,
    `  "version": ${JSON.stringify(VALID_PACKAGE.version)},`,
    '  "files": []',
    '}',
    '',
  ].join('\n')],
  ['a repeated key one object deeper', [
    '{',
    `  "name": ${JSON.stringify(VALID_PACKAGE.name)},`,
    `  "version": ${JSON.stringify(VALID_PACKAGE.version)},`,
    `  "engines": { "node": ${JSON.stringify(DUPLICATE_SENTINEL)}, "node": ">=26.0.0" },`,
    '  "files": []',
    '}',
    '',
  ].join('\n')],
]);

/**
 * A throwaway repository root: copies of the release modules under test plus the
 * given `package.json`. The modules derive `REPO_ROOT` from their own location,
 * so the copy *is* the repository they read — the real code runs, only the
 * document differs.
 */
function fakeRepo(text) {
  const root = freshDir();
  const modules = path.join(root, 'scripts', 'release');
  fs.mkdirSync(modules, { recursive: true });
  for (const name of fs.readdirSync(RELEASE_MODULES)) {
    if (name.endsWith('.mjs')) fs.copyFileSync(path.join(RELEASE_MODULES, name), path.join(modules, name));
  }
  fs.writeFileSync(path.join(root, 'package.json'), text);
  return root;
}

const PACK_LABEL = 'release:pack failed: package.json repeats an object key, so which value applies is ambiguous';
const CHECK_LABEL = 'pack:check failed: package.json repeats an object key, so which value applies is ambiguous';
const PUBLISH_LABEL = 'release:publish failed: package.json repeats an object key, so which value applies is ambiguous';

/** Assert that a refusal is one fixed label and nothing else about the fixture. */
function assertFixedLabel(surface, label, fixtureRoot) {
  assert.equal(surface.split('\n').filter((line) => line.trim() !== '').includes(label), true, `expected the label "${label}"; got:\n${surface}`);
  assert.equal(surface.includes(DUPLICATE_SENTINEL), false, 'the dropped value must not be echoed');
  assert.equal(surface.includes(fixtureRoot), false, 'nor the fixture path');
  for (const root of TEMP_ROOT_SPELLINGS) {
    assert.equal(surface.includes(root), false, `nor the temporary root it lives under (${root})`);
  }
  assert.equal(surface.includes('package.json"'), false, 'nor a quoted document fragment');
  assert.equal(/^\s+at /m.test(surface), false, 'and no stack frame is printed');
}

test('the fixture premise: each repeated key parses to the last value and loses the sentinel', () => {
  for (const [name, text] of DUPLICATE_PACKAGES) {
    const parsed = JSON.parse(text);
    assert.equal(text.includes(DUPLICATE_SENTINEL), true, `${name}: the sentinel is in the document`);
    assert.equal(JSON.stringify(parsed).includes(DUPLICATE_SENTINEL), false, `${name}: but JSON.parse dropped it`);
    assert.equal(parsed.version, VALID_PACKAGE.version, `${name}: the last version is what a plain parse keeps`);
  }
});

test('release:pack refuses a package.json that repeats a key, and writes no output', () => {
  for (const [name, text] of DUPLICATE_PACKAGES) {
    const root = fakeRepo(text);
    const pack = path.join(root, 'scripts', 'release', 'pack.mjs');
    // A fresh --dist: the refusal happens before the directory would be created.
    const absent = path.join(freshDir(), 'out');
    const first = spawnSync(process.execPath, [pack, '--dist', absent], {
      cwd: root,
      encoding: 'utf8',
      env: createPrivateNpmEnv(scratch),
    });
    assert.equal(first.status, 1, `${name}: release:pack must fail`);
    assertFixedLabel(`${first.stdout}\n${first.stderr}`, PACK_LABEL, root);
    assert.equal(fs.existsSync(absent), false, `${name}: no output directory may be created`);

    // And an existing output directory is left exactly as it was, not replaced
    // with a build of the version `JSON.parse` would have kept.
    const existing = freshDir();
    fs.writeFileSync(path.join(existing, 'manifest.json'), 'caller data that is not a build manifest\n');
    fs.writeFileSync(path.join(existing, 'keep.txt'), 'unrelated file\n');
    const before = snapshot(existing);
    const second = spawnSync(process.execPath, [pack, '--dist', existing], {
      cwd: root,
      encoding: 'utf8',
      env: createPrivateNpmEnv(scratch),
    });
    assert.equal(second.status, 1, `${name}: a second run must fail the same way`);
    assertFixedLabel(`${second.stdout}\n${second.stderr}`, PACK_LABEL, root);
    assert.deepEqual(snapshot(existing), before, `${name}: the existing output must be byte-identical`);
    assert.deepEqual(fs.readdirSync(root).sort(), ['package.json', 'scripts'], `${name}: nothing may be added to the tree`);
  }
});

test('pack:check refuses the same package.json, with one label and no stack trace', () => {
  for (const [name, text] of DUPLICATE_PACKAGES) {
    const root = fakeRepo(text);
    const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'release', 'verify-package.mjs')], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 1, `${name}: pack:check must fail`);
    assertFixedLabel(`${run.stdout}\n${run.stderr}`, CHECK_LABEL, root);
    // It stops at the metadata read: no packaging check result may be reported,
    // so the run cannot be read as "the package checks ran and mostly passed".
    assert.equal(/^\s+ok /m.test(run.stdout), false, `${name}: no check may run before the metadata is trusted`);
    assert.equal(/all package checks passed/.test(run.stdout), false);
  }
});

test('release:publish refuses the same package.json and pins nothing', () => {
  for (const [name, text] of DUPLICATE_PACKAGES) {
    const root = fakeRepo(text);
    const candidate = freshDir();
    fs.writeFileSync(path.join(candidate, 'manifest.json'), '{"sha256":"caller data"}\n');
    fs.writeFileSync(path.join(candidate, 'keep.tgz'), 'not a build tarball\n');
    const before = snapshot(candidate);

    const run = spawnSync(
      process.execPath,
      [path.join(root, 'scripts', 'release', 'publish-artifact.mjs'), '--from', candidate],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(run.status, 1, `${name}: release:publish must fail`);
    assertFixedLabel(`${run.stdout}\n${run.stderr}`, PUBLISH_LABEL, root);
    // The read that failed is the first thing the publisher does, so it stops
    // before the candidate is inspected and before any install call.
    assert.equal(/^pinned /m.test(run.stdout), false, `${name}: nothing may be reported as pinned`);
    assert.deepEqual(snapshot(candidate), before, `${name}: the candidate is left as it was`);
    assert.equal(fs.existsSync(path.join(root, 'release')), false, `${name}: release/ must not be created`);
    assert.deepEqual(fs.readdirSync(root).sort(), ['package.json', 'scripts'], `${name}: nothing may be added to the tree`);
  }
});

test('a valid package.json is still accepted end to end by the same entry point', () => {
  // The contrast for the refusals above: the same fixture, one repeated key
  // removed, builds normally. Nothing else in the fixture changed.
  const root = fakeRepo(VALID_TEXT);
  fs.writeFileSync(path.join(root, 'README.md'), '# probe\n');
  fs.writeFileSync(path.join(root, 'LICENSE'), 'probe\n');
  const dist = path.join(freshDir(), 'out');
  const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'release', 'pack.mjs'), '--dist', dist], {
    cwd: root,
    encoding: 'utf8',
    env: createPrivateNpmEnv(scratch),
  });
  assert.equal(run.status, 0, `the valid fixture must build:\n${run.stdout}\n${run.stderr}`);
  assert.deepEqual(fs.readdirSync(dist).sort(), [
    'SHA256SUMS',
    `dsh-evolution-probe-${VALID_PACKAGE.version}.tgz`,
    'manifest.json',
  ]);
  const buildManifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
  assert.equal(buildManifest.version, VALID_PACKAGE.version);
  assert.equal(buildManifest.filename, `dsh-evolution-probe-${VALID_PACKAGE.version}.tgz`);

  // And this repository's own, genuine package.json — the document the real
  // entry points read — still reads as the same value a plain parse gives.
  const realText = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
  assert.deepEqual(readManifest(), JSON.parse(realText));
});

// ---------------------------------------------------------------------------
// 2. a nightly is one whole build stamp
// ---------------------------------------------------------------------------

/**
 * The shapes that must stay accepted. Measured against
 * nodejs.org/download/nightly/index.json (documented in `release-lib.mjs`): 369
 * of 370 entries carry a ten-character commit and one 2023 entry the full
 * 40-character object name, so both lengths are published shapes. The rest are
 * this repository's own pin, this machine's runtime, and the `rc` tags the same
 * node history publishes.
 */
const ACCEPTED_NODE = [
  'v27.0.0-nightly202610236d4646731e',
  'v20.7.0-nightly202309173557c436181c526f41bb6ce7751e63f36695aa1d',
  'v0.10.41-nightly20151203036580393d',
  'v26.12.0',
  'v22.0.0-rc.1',
  'v20.0.0-rc1',
  pinned.builtWith.node,
  process.version,
];

/**
 * Shapes a character-class or identifier-list grammar spells but no nightly
 * index publishes: the tag word alone, the tag word plus a date with no commit,
 * a stamp joined to another identifier, a stamp with something appended, and the
 * commit-length boundaries of the one measured shape.
 */
const REFUSED_NODE = [
  'v27.0.0-nightly',
  'v27.0.0-nightly20261023',
  'v27.0.0-nightly20261023.rc1',
  'v27.0.0-nightly.rc1',
  'v27.0.0-rc1.nightly20261023',
  'v27.0.0-nightly20261023-nightly202610236d4646731e',
  'v27.0.0-nightly202610236d4646731e.rc1',
  'v27.0.0-nightly202610236d4646731e.sklive',
  'v27.0.0-nightly202610236d4646731e-rc.1',
  'v27.0.0-nightly202610236d4646731',
  'v27.0.0-nightly202610236d4646731e0',
  'v27.0.0-nightly2026102a6d4646731e',
  'v27.0.0-nightly202610236D4646731E',
  'v27.0.0-nightly202610236.d4646731e',
  'v20.7.0-nightly202309173557c436181c526f41bb6ce7751e63f36695aa',
  'v20.7.0-nightly202309173557c436181c526f41bb6ce7751e63f36695aa1d0',
  'v26.12.0-nightly.secretkey',
  'v26.12.0-nightly20230101.sklive',
];

test('a nightly is only the whole build stamp, never a generic identifier', () => {
  for (const node of ACCEPTED_NODE) {
    assert.deepEqual(builtWithProblems({ ...pinned.builtWith, node }), [], `${node} must be a toolchain version`);
  }
  for (const node of REFUSED_NODE) {
    const problems = builtWithProblems({ ...pinned.builtWith, node });
    assert.ok(problems.length > 0, `${node} must be refused`);
    const report = problems.join('\n');
    assert.match(report, /builtWith\.node is not a Node version/);
    // The report names the field and the kind, never the candidate value.
    assert.equal(report.includes(node), false, `${node}: the value must not be echoed`);
    assert.equal(report.includes('nightly'), false, `${node}: not even the tag word`);
    assert.equal(/sklive|secrettok|tokenabc|secretkey/.test(report), false, `${node}: nor a credential-shaped part`);
    assert.equal(/a string/.test(report), true, `${node}: the kind is stated instead`);
  }

  // The nightly tag word is per field as well: npm never published a nightly, and
  // the field's own allow-list still refuses one.
  assert.ok(builtWithProblems({ ...pinned.builtWith, npm: '11.20.0-nightly20230101' }).length > 0);
  assert.ok(builtWithProblems({ ...pinned.builtWith, npm: '11.20.0-nightly202610236d4646731e' }).length > 0);
});

test('the nightly stamp stays inside the field bound it is measured against', () => {
  const newest = 'v27.0.0-nightly202610236d4646731e';
  const fullSha = 'v20.7.0-nightly202309173557c436181c526f41bb6ce7751e63f36695aa1d';
  assert.equal(newest.length, 33);
  assert.equal(fullSha.length, 63);
  // The longest stamp the grammar admits, and the longest identifier list for the
  // field: both are within the cap, so the cap never rejects an admitted shape.
  const longestStamp = `v999.999.999-nightly20261023${'a'.repeat(40)}`;
  assert.equal(longestStamp.length, 68);
  assert.deepEqual(builtWithProblems({ ...pinned.builtWith, node: longestStamp }), []);
  assert.deepEqual(builtWithProblems({ ...pinned.builtWith, node: 'v999.999.999-rc99999999.rc99999999.rc99999999' }), []);
});
