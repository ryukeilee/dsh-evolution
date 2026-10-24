/**
 * Round 9: `release:publish` exited 0 without running anything when it was
 * entered through an alias path.
 *
 * `publish-artifact.mjs` decided whether it was the entry point by comparing
 * `pathToFileURL(process.argv[1]).href` with `import.meta.url`. Node resolves
 * the entry module to its real path, so the right-hand side is always the real
 * spelling while the left-hand side keeps whatever the caller typed. Two
 * ordinary situations therefore made the comparison false:
 *
 *   * a symbolic link to the script (a `bin/`, an alternative name, a wrapper);
 *   * a temp root that is itself an alias — on macOS `os.tmpdir()` is
 *     `/var/folders/…`, which is `/private/var/folders/…`.
 *
 * The module then skipped `main()` entirely, so the publisher printed nothing
 * and exited 0. For a command whose whole job is to refuse an unusable build
 * that is the most misleading outcome possible: silent success.
 *
 * These tests run the real entry point end to end in a throwaway repository
 * under `os.tmpdir()` — copies of the release modules plus a fixture
 * `package.json` — and start it through a real symbolic link as a child
 * process. The argument used is one the script rejects before it reads the
 * tree, so nothing can be written; the assertions are the non-zero exit, the
 * script's own fixed label on stderr, and a byte-identical fixture afterwards.
 * Nothing here touches the repository's `release/`, `dist/` or `package.json`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from '../scripts/release/release-lib.mjs';

const RELEASE_MODULES = path.join(REPO_ROOT, 'scripts', 'release');
// Deliberately *not* realpath'd: the point is to enter the script through the
// alias spelling the caller would use.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-publish-entry-symlink-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const PROBE_PACKAGE = { name: 'dsh-evolution-probe', version: '0.0.1-rc.0', files: [] };

let fixtureCount = 0;
function freshDir(label) {
  const dir = path.join(scratch, `${label}-${fixtureCount += 1}`);
  fs.mkdirSync(dir);
  return dir;
}

/** A throwaway repository root: the release modules plus a valid package.json. */
function fakeRepo() {
  const root = freshDir('root');
  const modules = path.join(root, 'scripts', 'release');
  fs.mkdirSync(modules, { recursive: true });
  for (const name of fs.readdirSync(RELEASE_MODULES)) {
    if (name.endsWith('.mjs')) fs.copyFileSync(path.join(RELEASE_MODULES, name), path.join(modules, name));
  }
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(PROBE_PACKAGE, null, 2)}\n`);
  return root;
}

/** Name, kind, size, mode and symlink target of everything below `dir`. */
function snapshot(dir) {
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
      else state[label] = `file ${stat.size} ${stat.mode.toString(8)}`;
    }
  };
  walk(dir, '');
  return state;
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

/**
 * Inputs the publisher refuses before it reads a single file: `parseArgs` runs
 * first in `main()`, so a rejected argument cannot create `release/`, cannot
 * inspect a candidate directory and cannot write anything.
 */
const REFUSED_ARGS = [
  ['a --from with no value', ['--from'], 'release:publish failed: --from requires a value'],
  ['a --from followed by another option', ['--from', '--force'], 'release:publish failed: --from requires a value'],
  ['an unknown argument', ['--dist', 'nowhere'], 'release:publish failed: unknown argument; usage: node scripts/release/publish-artifact.mjs [--from <dir>] [--force]'],
];

/** Assert the run is a refusal at the script's own boundary, and nothing more. */
function assertRefused(run, label, where) {
  assert.equal(run.status, 1, `${where}: the publisher must exit non-zero, not succeed silently\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.equal(run.stderr, `${label}\n`, `${where}: one fixed label on stderr and nothing else`);
  assert.equal(run.stdout, '', `${where}: nothing may be reported as work done`);
  assert.equal(/^\s+at /m.test(`${run.stdout}${run.stderr}`), false, `${where}: no stack frame is printed`);
  assert.equal(/pinned /.test(run.stdout), false, `${where}: nothing may be reported as pinned`);
}

test('the defect premise: an alias entry does not spell the same URL, but is the same file', () => {
  const root = fakeRepo();
  const script = path.join(root, 'scripts', 'release', 'publish-artifact.mjs');
  const bin = freshDir('bin');
  const link = path.join(bin, 'publish-link.mjs');
  if (!symlinksWork()) {
    // Recorded rather than asserted: the remaining tests skip explicitly.
    assert.ok(true, 'symbolic links are unavailable on this platform');
    return;
  }
  fs.symlinkSync(script, link, 'file');
  // The comparison the script used to make: false for an alias.
  assert.notEqual(pathToFileURL(link).href, pathToFileURL(fs.realpathSync(script)).href);
  // What it compares now: the same file either way.
  assert.equal(fs.realpathSync(link), fs.realpathSync(script));
});

test('release:publish entered through a symbolic link refuses instead of exiting 0', (t) => {
  if (!symlinksWork()) {
    t.skip('this platform cannot create symbolic links, so the alias entry cannot be exercised');
    return;
  }
  const root = fakeRepo();
  const realScript = fs.realpathSync(path.join(root, 'scripts', 'release', 'publish-artifact.mjs'));
  const bin = freshDir('bin');
  const link = path.join(bin, 'publish-link.mjs');
  fs.symlinkSync(realScript, link, 'file');
  assert.notEqual(link, realScript, 'the fixture must really be an alias');

  for (const [name, argv, label] of REFUSED_ARGS) {
    const before = snapshot(root);
    const run = spawnSync(process.execPath, [link, ...argv], { cwd: root, encoding: 'utf8' });
    assertRefused(run, label, `${name} via symlink`);
    assert.deepEqual(snapshot(root), before, `${name}: the fixture repository is left byte-identical`);
    assert.equal(fs.existsSync(path.join(root, 'release')), false, `${name}: release/ must not be created`);
  }
});

test('the ordinary direct path keeps the same refusal', (t) => {
  if (!symlinksWork()) {
    t.skip('this platform cannot create symbolic links; the symlink case above is the regression under test');
    return;
  }
  const root = fakeRepo();
  const realScript = fs.realpathSync(path.join(root, 'scripts', 'release', 'publish-artifact.mjs'));
  const bin = freshDir('bin');
  const link = path.join(bin, 'publish-link.mjs');
  fs.symlinkSync(realScript, link, 'file');

  for (const [name, argv, label] of REFUSED_ARGS) {
    const before = snapshot(root);
    const direct = spawnSync(process.execPath, [realScript, ...argv], { cwd: root, encoding: 'utf8' });
    const viaLink = spawnSync(process.execPath, [link, ...argv], { cwd: root, encoding: 'utf8' });
    assertRefused(direct, label, `${name} directly`);
    // Parity: entering through the alias is the same command, not a silent no-op.
    assert.deepEqual(
      { status: viaLink.status, stdout: viaLink.stdout, stderr: viaLink.stderr },
      { status: direct.status, stdout: direct.stdout, stderr: direct.stderr },
      `${name}: the alias entry must behave exactly like the direct one`,
    );
    assert.deepEqual(snapshot(root), before, `${name}: the fixture repository is left byte-identical`);
  }
});

test('importing the module still does not run the command', () => {
  const root = fakeRepo();
  const realScript = fs.realpathSync(path.join(root, 'scripts', 'release', 'publish-artifact.mjs'));
  const before = snapshot(root);
  // `node -e` has no `process.argv[1]`, so this is the "imported, not executed"
  // case regardless of path spelling; it must stay a plain import.
  const run = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `const mod = await import(${JSON.stringify(pathToFileURL(realScript).href)}); console.log('imported', typeof mod.inspectPinnedRelease);`],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, `importing must succeed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.equal(run.stderr, '');
  assert.equal(run.stdout.trim(), 'imported function');
  assert.equal(/release:publish/.test(`${run.stdout}${run.stderr}`), false, 'an import must not report a command result');
  assert.deepEqual(snapshot(root), before, 'an import writes nothing');
  assert.equal(fs.existsSync(path.join(root, 'release')), false, 'an import must not create release/');
});
