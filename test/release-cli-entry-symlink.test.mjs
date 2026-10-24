/**
 * Round 10: `pin-relation.mjs` and `verify-provenance.mjs` were the two
 * remaining release entry points that decided "am I the entry point?" by
 * comparing `pathToFileURL(process.argv[1]).href` with `import.meta.url` — the
 * defect `publish-artifact.mjs`, `pack.mjs` and `doctor.mjs` already fixed.
 *
 * Node resolves the entry module to its real path, so the right-hand side is
 * always the real spelling while the left-hand side keeps whatever the caller
 * typed. Two ordinary situations therefore made the comparison false:
 *
 *   * a symbolic link to the script (a `bin/`, an alternative name, a wrapper);
 *   * a temp root that is itself an alias — on macOS `os.tmpdir()` is
 *     `/var/folders/…`, which is `/private/var/folders/…`.
 *
 * The module then skipped its entry block and exited 0. For both of these that
 * is the most misleading outcome available:
 *
 *   * `pin-relation.mjs` is the diagnostic that prints whether the tree is the
 *     pinned release, a committed successor of it, or unverified. Silent exit 0
 *     reads exactly like "the tree is pinned";
 *   * `verify-provenance.mjs` is the tag -> commit -> pin gate the release
 *     workflow runs with `--tag "$RELEASE_TAG"`. Silent exit 0 reads exactly
 *     like "the tag, commit and pin agree".
 *
 * These tests start the real entry points end to end in a child process, once
 * by their real path and once through a symbolic link created in a throwaway
 * directory, and require identical status/output. `pin-relation` is read-only
 * (it reads `release/`, `package.json` and git), so it is exercised against this
 * repository; `verify-provenance --tag` with no value is refused inside
 * `parseArgs` before any file is read, so it is exercised against a throwaway
 * fixture repository. Nothing here writes to `release/`, `dist/` or the tree.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from '../scripts/release/release-lib.mjs';

const RELEASE_MODULES = path.join(REPO_ROOT, 'scripts', 'release');
const PIN_RELATION = path.join(RELEASE_MODULES, 'pin-relation.mjs');
const VERIFY_PROVENANCE = path.join(RELEASE_MODULES, 'verify-provenance.mjs');
const RELEASE_DIR = path.join(REPO_ROOT, 'release');

// Deliberately *not* realpath'd: the point of the alias cases is to enter the
// script through the spelling the caller would use.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-cli-entry-symlink-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let fixtureCount = 0;
function freshDir(label) {
  const dir = path.join(scratch, `${label}-${fixtureCount += 1}`);
  fs.mkdirSync(dir);
  return dir;
}

/** A symlink in its own throwaway directory, named to look like a wrapper. */
function aliasFor(script, label) {
  const dir = freshDir('bin');
  const link = path.join(dir, `${label}-link.mjs`);
  fs.symlinkSync(script, link, 'file');
  return link;
}

/** Whether this platform lets the test create a symbolic link at all. */
function symlinksWork() {
  const dir = freshDir('symlink-probe');
  const target = path.join(dir, 'target.txt');
  const link = path.join(dir, 'link.txt');
  fs.writeFileSync(target, 'probe\n');
  try {
    fs.symlinkSync(target, link, 'file');
    return fs.readFileSync(link, 'utf8') === 'probe\n';
  } catch {
    return false;
  }
}

/** Name, size, mode and content digest of everything below `dir`. */
function contentSnapshot(dir) {
  const state = {};
  const walk = (current, prefix) => {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name);
      const stat = fs.lstatSync(file);
      const label = `${prefix}${name}`;
      if (stat.isDirectory()) {
        state[label] = 'directory';
        walk(file, `${label}/`);
      } else if (stat.isSymbolicLink()) state[label] = `symlink -> ${fs.readlinkSync(file)}`;
      else {
        const digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        state[label] = `file ${stat.size} ${stat.mode.toString(8)} ${digest}`;
      }
    }
  };
  walk(dir, '');
  return state;
}

/** The directory names a path holds, or null when it does not exist. */
function listing(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : null;
}

function runCli(entry, argv, cwd) {
  return spawnSync(process.execPath, [entry, ...argv], { cwd, encoding: 'utf8' });
}

function result(run) {
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

test('the defect premise: an alias entry does not spell the same URL, but is the same file', (t) => {
  if (!symlinksWork()) {
    t.skip('this platform cannot create symbolic links, so the alias entry cannot be exercised');
    return;
  }
  for (const script of [PIN_RELATION, VERIFY_PROVENANCE]) {
    const real = fs.realpathSync(script);
    const link = aliasFor(real, path.basename(script, '.mjs'));
    // The comparison the scripts used to make: false for an alias.
    assert.notEqual(pathToFileURL(link).href, pathToFileURL(real).href, `${script}: the fixture must really be an alias`);
    // What they compare now: the same file either way.
    assert.equal(fs.realpathSync(link), real, `${script}: resolving the alias names the script`);
  }
});

test('pin-relation prints the same verdict through its real path and through a symlink', (t) => {
  if (!symlinksWork()) {
    t.skip('this platform cannot create symbolic links, so the alias entry cannot be exercised');
    return;
  }
  const real = fs.realpathSync(PIN_RELATION);
  const link = aliasFor(real, 'pin-relation');
  // The reading the diagnostic does is independent of the caller's cwd, so each
  // run happens outside the repository; only `release/` could be affected, and
  // it is read back below.
  const cwd = freshDir('cwd');
  const releaseBefore = contentSnapshot(RELEASE_DIR);
  const distBefore = listing(path.join(REPO_ROOT, 'dist'));

  for (const argv of [[], ['--json']]) {
    const label = argv.length > 0 ? argv.join(' ') : '(no arguments)';
    const direct = runCli(real, argv, cwd);
    const viaLink = runCli(link, argv, cwd);
    // argv spelling differs on purpose: `../bin/…-link.mjs` from the cwd.
    const relativeLink = path.relative(cwd, link);
    const viaRelativeLink = runCli(relativeLink, argv, cwd);

    assert.notEqual(direct.stdout.trim(), '', `${label} directly: the diagnostic must report a verdict instead of exiting silently`);
    assert.equal(direct.stderr, '', `${label} directly: a normal run writes nothing to stderr`);
    assert.equal(direct.stdout, viaLink.stdout, `${label} via symlink: the alias must print the same verdict, not nothing`);
    assert.deepEqual(result(viaLink), result(direct), `${label} via symlink: exit status and output must match the direct run`);
    assert.deepEqual(result(viaRelativeLink), result(direct), `${label} via a relative symlink spelling: same command, same result`);
    assert.ok(direct.status === 0 || direct.status === 1, `${label}: the diagnostic reports with 0 or 1, got ${direct.status}`);

    if (argv.length > 0) {
      const report = JSON.parse(direct.stdout);
      assert.ok(['pinned', 'ahead', 'unverified'].includes(report.state), `${label}: the JSON report carries the relation state`);
    } else {
      assert.match(direct.stdout, /^(the tree is|development tree ahead of the pin|the tree is neither)/m, `${label}: a relation verdict line is printed`);
    }
  }

  assert.deepEqual(contentSnapshot(RELEASE_DIR), releaseBefore, 'the diagnostic must not write to release/');
  assert.deepEqual(listing(path.join(REPO_ROOT, 'dist')), distBefore, 'the diagnostic must not create or change dist/');
});

test('verify-provenance refuses a valueless --tag the same way through its real path and a symlink', (t) => {
  if (!symlinksWork()) {
    t.skip('this platform cannot create symbolic links, so the alias entry cannot be exercised');
    return;
  }
  // `parseArgs` runs before any file or git read, so a rejected argument cannot
  // inspect (or create) `release/`, and the fixture needs no release at all.
  const root = freshDir('root');
  const modules = path.join(root, 'scripts', 'release');
  fs.mkdirSync(modules, { recursive: true });
  for (const name of fs.readdirSync(RELEASE_MODULES)) {
    if (name.endsWith('.mjs')) fs.copyFileSync(path.join(RELEASE_MODULES, name), path.join(modules, name));
  }
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: 'dsh-evolution-probe', version: '0.0.1-rc.0', files: [] }, null, 2)}\n`);

  const real = fs.realpathSync(path.join(modules, 'verify-provenance.mjs'));
  const link = aliasFor(real, 'verify-provenance');
  const before = contentSnapshot(root);

  const direct = runCli(real, ['--tag'], root);
  const viaLink = runCli(link, ['--tag'], root);
  const expectedError = 'verify-provenance failed: --tag requires a value\n';

  assert.equal(direct.status, 2, `directly: a valueless --tag must be refused, not accepted\nstdout:\n${direct.stdout}\nstderr:\n${direct.stderr}`);
  assert.equal(direct.stderr, expectedError, 'directly: one fixed label on stderr');
  assert.equal(direct.stdout, '', 'directly: nothing may be reported as verification work');
  assert.deepEqual(result(viaLink), result(direct), 'via symlink: the alias must refuse exactly like the direct run, not exit 0 silently');
  assert.equal(viaLink.status, 2, 'via symlink: the refusal status is the script\'s, not a silent success');
  assert.equal(/^\s+at /m.test(`${viaLink.stdout}${viaLink.stderr}`), false, 'via symlink: no stack frame is printed');

  assert.deepEqual(contentSnapshot(root), before, 'the refused run leaves the fixture byte-identical');
  assert.equal(fs.existsSync(path.join(root, 'release')), false, 'a refused run must not create release/');
});

test('importing either entry point still does not run the command', () => {
  for (const script of [PIN_RELATION, VERIFY_PROVENANCE]) {
    const real = fs.realpathSync(script);
    // `node -e` has no `process.argv[1]`, so this is the "imported, not executed"
    // case regardless of path spelling; it must stay a plain import.
    const run = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(real).href)});`],
      { cwd: scratch, encoding: 'utf8' },
    );
    assert.equal(run.status, 0, `${path.basename(script)}: importing must succeed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    assert.equal(run.stdout, '', `${path.basename(script)}: an import must report nothing`);
    assert.equal(run.stderr, '', `${path.basename(script)}: an import must report nothing`);
  }
});
