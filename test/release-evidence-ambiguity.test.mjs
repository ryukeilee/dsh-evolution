/**
 * Round 8 review, blocker 1: the acceptance record `pack:check` trusts.
 *
 * `scripts/release/verify-package.mjs` read `docs/evidence/dsh-<host>.json` with
 * `JSON.parse` and then asked only whether `evidence.ok === true`. A record that
 * spelled the key twice
 *
 *     {"ok": false, "\u006fk": true}
 *
 * is valid JSON, parses to `{ ok: true }`, and was therefore counted as a passed
 * host acceptance: a failed run recorded as a passing one, in the one check that
 * decides whether the pinned artifact was ever installed against a real host.
 * `JSON.parse` keeps the last value for a repeated key and drops the earlier one,
 * so nothing the parsed object can show distinguishes the two documents.
 *
 * The record is now read with the same duplicate-safe reader as every other
 * release document, before any field is looked at, and refused by one fixed
 * label. These tests run the real entry point — `verify-package.mjs` — inside a
 * throwaway repository whose `docs/evidence/` holds the counterexample, so the
 * reading code path is the shipped one. Nothing here touches the repository's own
 * `docs/evidence/`, `release/` or `dist/`: every fixture lives in `os.tmpdir()`
 * and every value is synthetic.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from '../scripts/release/release-lib.mjs';

const RELEASE_MODULES = path.join(REPO_ROOT, 'scripts', 'release');
const HOST = '0.2.0-rc.2';
const VERSION = '0.0.1-rc.0';
const PIN_CONTENT = 'c'.repeat(64);
const PIN_SHA = 'd'.repeat(64);

// `realpath` on purpose: a fixture below the symlinked temp root (`/var` →
// `/private/var` on macOS) is still a real repository root, but keeping the
// spelling canonical makes the "no temporary path is printed" assertions mean
// what they say.
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evo-evidence-ambiguity-')));
const TEMP_ROOT_SPELLINGS = [os.tmpdir(), fs.realpathSync(os.tmpdir())];
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let fixtureCount = 0;
function freshDir() {
  const dir = path.join(scratch, `set-${fixtureCount += 1}`);
  fs.mkdirSync(dir);
  return dir;
}

/** Name, size and content hash of everything in a directory (not recursive). */
function snapshot(dir) {
  const state = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) state[name] = 'directory';
    else if (stat.isSymbolicLink()) state[name] = `symlink -> ${fs.readlinkSync(file)}`;
    else state[name] = `file ${stat.size} ${stat.mtimeMs} ${fs.readFileSync(file, 'utf8').length}`;
  }
  return state;
}

const VALID_PACKAGE = {
  name: 'dsh-evolution-probe',
  version: VERSION,
  engines: { node: '>=26.0.0' },
  peerDependencies: { '@deepseek-ai/dsh': HOST },
  files: [],
};

/**
 * A throwaway repository root that the real `verify-package.mjs` can run in:
 * copies of the release modules (they derive `REPO_ROOT` from their own
 * location, so the copy *is* the repository they read), the metadata documents
 * they compare, a committed pin, and one acceptance record supplied by the test.
 */
function fixtureRepo(evidenceText) {
  const root = freshDir();
  const modules = path.join(root, 'scripts', 'release');
  fs.mkdirSync(modules, { recursive: true });
  for (const name of fs.readdirSync(RELEASE_MODULES)) {
    if (name.endsWith('.mjs')) fs.copyFileSync(path.join(RELEASE_MODULES, name), path.join(modules, name));
  }
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(VALID_PACKAGE, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'package-lock.json'), `${JSON.stringify({
    name: VALID_PACKAGE.name,
    version: VERSION,
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: VALID_PACKAGE.name, version: VERSION } },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'README.md'), `# ${VALID_PACKAGE.name}\n\nversion \`${VERSION}\` supports host ${HOST}\n`);
  fs.writeFileSync(path.join(root, 'COMPATIBILITY.md'), `# compatibility\n\nhost ${HOST}\n`);
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), `# changelog\n\n## ${VERSION}\n`);
  fs.writeFileSync(path.join(root, 'LICENSE'), 'MIT\n');
  fs.mkdirSync(path.join(root, 'release'), { recursive: true });
  fs.writeFileSync(path.join(root, 'release', 'manifest.json'), `${JSON.stringify({
    name: VALID_PACKAGE.name,
    version: VERSION,
    filename: `${VALID_PACKAGE.name}-${VERSION}.tgz`,
    sha256: PIN_SHA,
    contentSha256: PIN_CONTENT,
    entries: 3,
    modes: ['0o644'],
    builtWith: { node: 'v26.12.0', npm: '11.20.0', platform: 'darwin-arm64' },
    verifiedHosts: [HOST],
    evidence: [`docs/evidence/dsh-${HOST}.json`],
  }, null, 2)}\n`);
  const evidenceDir = path.join(root, 'docs', 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, `dsh-${HOST}.json`), evidenceText);
  return root;
}

function runCheck(root, args = []) {
  const run = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'release', 'verify-package.mjs'), ...args],
    { cwd: root, encoding: 'utf8' },
  );
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, surface: `${run.stdout}\n${run.stderr}` };
}

const EVIDENCE_SENTINEL = 'sk-review-evidence';
const AMBIGUOUS_LABEL = `docs/evidence/dsh-${HOST}.json repeats an object key, so which value applies is ambiguous`;

/**
 * The counterexample: a *failed* acceptance whose second, escaped `ok` key makes
 * a plain parse report success. The sentinel lives in a field no check reads, so
 * its only role is to prove the record's own text is never echoed.
 */
const AMBIGUOUS_EVIDENCE = [
  '{',
  '  "ok": false,',
  '  "\\u006fk": true,',
  `  "hostVersion": ${JSON.stringify(HOST)},`,
  `  "packageVersion": ${JSON.stringify(VERSION)},`,
  `  "contentSha256": ${JSON.stringify(PIN_CONTENT)},`,
  `  "tarballSha256": ${JSON.stringify(PIN_SHA)},`,
  `  "note": ${JSON.stringify(EVIDENCE_SENTINEL)}`,
  '}',
  '',
].join('\n');

const VALID_EVIDENCE = `${JSON.stringify({
  ok: true,
  hostVersion: HOST,
  packageVersion: VERSION,
  contentSha256: PIN_CONTENT,
  tarballSha256: PIN_SHA,
  steps: [],
}, null, 2)}\n`;

test('the fixture premise: the escaped duplicate parses as a passed acceptance', () => {
  const parsed = JSON.parse(AMBIGUOUS_EVIDENCE);
  assert.equal(AMBIGUOUS_EVIDENCE.includes('"\\u006fk"'), true, 'the escaped key is in the document');
  assert.equal(AMBIGUOUS_EVIDENCE.includes('"ok": false'), true, 'and so is the failed one');
  assert.equal(parsed.ok, true, 'JSON.parse keeps the last value: a failed record reads as passed');
  assert.equal(Object.keys(parsed).filter((key) => key === 'ok').length, 1);
});

test('pack:check refuses an ambiguous acceptance record, and writes no evidence', () => {
  const root = fixtureRepo(AMBIGUOUS_EVIDENCE);
  const evidenceDir = path.join(root, 'docs', 'evidence');
  const before = snapshot(evidenceDir);
  const run = runCheck(root);

  assert.equal(run.status, 1, `the ambiguous evidence must fail the check:\n${run.surface}`);
  // One fixed label, in the failure list, naming the file and the category.
  assert.equal(run.surface.includes(AMBIGUOUS_LABEL), true, `expected the fixed label; got:\n${run.surface}`);
  assert.equal(run.surface.includes('all package checks passed'), false);
  // Nothing from the record itself, and no path to the fixture.
  assert.equal(run.surface.includes(EVIDENCE_SENTINEL), false, 'the record text must not be echoed');
  assert.equal(run.surface.includes('\\u006fk'), false, 'nor the ambiguous key');
  assert.equal(run.surface.includes('"ok": false'), false, 'nor a quoted document fragment');
  assert.equal(run.surface.includes(root), false, 'nor the fixture path');
  for (const spelling of TEMP_ROOT_SPELLINGS) {
    assert.equal(run.surface.includes(spelling), false, `nor the temporary root (${spelling})`);
  }
  assert.equal(/^\s+at /m.test(run.surface), false, 'and no stack frame is printed');
  // The check is read-only: the record is neither rewritten nor supplemented.
  assert.deepEqual(snapshot(evidenceDir), before, 'docs/evidence must be byte-identical after the run');
  assert.deepEqual(fs.readdirSync(evidenceDir), [`dsh-${HOST}.json`], 'no file may be added to docs/evidence');
});

test('the same fixture with an unambiguous, matching record passes the evidence check', () => {
  // The contrast: one repeated key removed and the fields genuine, nothing else
  // changed. The refusal above is therefore about the repeated key, not about the
  // fixture being unable to satisfy the check at all.
  const root = fixtureRepo(VALID_EVIDENCE);
  const run = runCheck(root);
  assert.equal(run.surface.includes(AMBIGUOUS_LABEL), false, `a valid record must not be refused:\n${run.surface}`);
  assert.equal(/ok {4}the committed acceptance evidence describes the pinned package content/.test(run.stdout), true,
    `the evidence check itself must pass:\n${run.stdout}`);
  assert.equal(run.surface.includes(`content ${PIN_CONTENT}`), true, 'and report the content it matched');
  // The rest of the fixture is not a releasable package, so the run still fails;
  // that is expected and unrelated to the evidence read.
  assert.equal(run.status, 1);
});

test('a malformed record is refused by a fixed label, without the parser message', () => {
  const root = fixtureRepo(`{ "ok": true, "note": ${JSON.stringify(EVIDENCE_SENTINEL)} `);
  const run = runCheck(root);
  assert.equal(run.status, 1);
  assert.equal(run.surface.includes(`docs/evidence/dsh-${HOST}.json is not readable: invalid JSON`), true,
    `expected the fixed malformed label; got:\n${run.surface}`);
  assert.equal(run.surface.includes(EVIDENCE_SENTINEL), false, 'the parser message quotes the document; it must be replaced');
  assert.equal(run.surface.includes(root), false);
});

test('pack:check refuses an unknown argument without echoing it', () => {
  const root = fixtureRepo(VALID_EVIDENCE);
  const sentinel = 'sk-review-sentinel';
  const run = runCheck(root, [sentinel]);
  assert.equal(run.status, 2);
  assert.equal(run.surface.includes(sentinel), false, 'an unknown argument is caller data');
  assert.match(run.surface, /unknown argument/);
});
