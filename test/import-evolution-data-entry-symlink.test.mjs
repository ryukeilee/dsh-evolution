/**
 * Round 11: the data-migration CLI exited 0 without running anything when it was
 * entered through an alias path.
 *
 * `scripts/import-evolution-data.mjs` decided whether it was the entry point by
 * comparing `import.meta.url` with `pathToFileURL(path.resolve(process.argv[1])).href`.
 * Node resolves the entry module to its real path, so the left-hand side is
 * always the real spelling while the right-hand side keeps whatever the caller
 * used. An ordinary symbolic link to the script (a `bin/`, an alternative name,
 * a wrapper) therefore made the comparison false, and the module skipped both the
 * Usage check and the import — printing nothing and exiting 0. For a migration
 * command that is the most misleading outcome possible: the user reads "no
 * output, exit 0" as "the migration is done".
 *
 * These tests start the real repository script as a child process, both through
 * its real path and through a symbolic link created inside `os.tmpdir()`. Neither
 * run is given a preset snapshot, a destination or a Dockyard snapshot, so the
 * Usage check fires before any path is opened: no legacy user data, no output
 * tree and no import is involved. The symlink target is the repository script
 * itself; nothing here writes to the repository.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'import-evolution-data.mjs');
const USAGE = 'Usage: node import-evolution-data.mjs <preset-snapshot> <destination> [dockyard-snapshot]';

// Deliberately *not* realpath'd: the point is to enter the script through the
// alias spelling the caller would use.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-import-entry-symlink-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let fixtureCount = 0;
function freshDir(label) {
  const dir = path.join(scratch, `${label}-${fixtureCount += 1}`);
  fs.mkdirSync(dir);
  return dir;
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

/** An alias to the repository script, plus the directory it lives in. */
function aliasedScript() {
  const bin = freshDir('bin');
  const link = path.join(bin, 'import-evolution-data-link.mjs');
  fs.symlinkSync(fs.realpathSync(SCRIPT), link, 'file');
  return { bin, link, real: fs.realpathSync(SCRIPT) };
}

/** Run the CLI with no arguments at all, from an empty working directory. */
function runWithoutArguments(entry) {
  const cwd = freshDir('cwd');
  const run = spawnSync(process.execPath, [entry], { cwd, encoding: 'utf8' });
  return { ...run, cwd, leftBehind: fs.readdirSync(cwd) };
}

/**
 * The Usage refusal: a non-zero exit, the script's own message, and no claim of
 * work done. No stack frame is asserted on, because this refusal is an uncaught
 * top-level error and Node prints its trace — the message is what the user reads.
 */
function assertUsageRefusal(run, where) {
  assert.notEqual(run.status, 0, `${where}: the importer must exit non-zero, not succeed silently\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.ok(run.stderr.includes(USAGE), `${where}: the Usage line must be reported\nstderr:\n${run.stderr}`);
  assert.equal(run.stdout, '', `${where}: nothing may be reported as an import result`);
  assert.deepEqual(run.leftBehind, [], `${where}: a refused run writes nothing into its working directory`);
}

test('the defect premise: an alias entry does not spell the URL the module was loaded from', (t) => {
  if (!symlinksWork()) {
    t.skip('this platform cannot create symbolic links, so the alias entry cannot be exercised');
    return;
  }
  const { link, real } = aliasedScript();
  assert.notEqual(link, real, 'the fixture must really be an alias');
  // The comparison the script used to make: false for an alias, because Node
  // loads the module under its real path.
  assert.notEqual(pathToFileURL(link).href, pathToFileURL(real).href);
  // What it compares now: the same file either way.
  assert.equal(fs.realpathSync(link), real);
});

test('the old URL guard is what made an alias entry a silent no-op', (t) => {
  if (!symlinksWork()) {
    t.skip('this platform cannot create symbolic links, so the old guard cannot be exercised');
    return;
  }
  // The guard exactly as the importer used to spell it: when it is entered
  // through an alias it does not match, so nothing runs and the process exits 0
  // with no output. This is the pre-fix behavior, recorded rather than assumed.
  const probe = path.join(freshDir('old-guard'), 'import-evolution-data.mjs');
  fs.writeFileSync(probe, [
    "import path from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    'if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {',
    "  process.stdout.write('executed\\n');",
    '  process.exitCode = 3;',
    '}',
    '',
  ].join('\n'));
  const bin = freshDir('old-guard-bin');
  const link = path.join(bin, 'import-evolution-data-link.mjs');
  fs.symlinkSync(probe, link, 'file');

  const viaLink = spawnSync(process.execPath, [link], { cwd: freshDir('old-guard-cwd'), encoding: 'utf8' });
  assert.deepEqual(
    { status: viaLink.status, stdout: viaLink.stdout, stderr: viaLink.stderr },
    { status: 0, stdout: '', stderr: '' },
    'the old comparison is false for an alias, so the guard skipped the whole CLI',
  );

  const direct = spawnSync(process.execPath, [fs.realpathSync(probe)], { cwd: freshDir('old-guard-direct'), encoding: 'utf8' });
  assert.deepEqual(
    { status: direct.status, stdout: direct.stdout, stderr: direct.stderr },
    { status: 3, stdout: 'executed\n', stderr: '' },
    'the same guard does run the body when the entry spelling is the real path',
  );
});

test('the CLI entered through a symbolic link reports the Usage error instead of exiting 0', (t) => {
  if (!symlinksWork()) {
    t.skip('this platform cannot create symbolic links, so the alias entry cannot be exercised');
    return;
  }
  const { link } = aliasedScript();
  assertUsageRefusal(runWithoutArguments(link), 'no arguments via symlink');
});

test('the ordinary direct path keeps the same refusal, byte for byte', (t) => {
  if (!symlinksWork()) {
    t.skip('this platform cannot create symbolic links; the symlink case above is the regression under test');
    return;
  }
  const { link, real } = aliasedScript();
  const direct = runWithoutArguments(real);
  const viaLink = runWithoutArguments(link);
  assertUsageRefusal(direct, 'no arguments directly');
  // Parity: entering through the alias is the same command, not a silent no-op.
  // The stderr comparison also proves Node resolved the alias to the same module:
  // the printed module URL is identical.
  assert.deepEqual(
    { status: viaLink.status, stdout: viaLink.stdout, stderr: viaLink.stderr },
    { status: direct.status, stdout: direct.stdout, stderr: direct.stderr },
    'the alias entry must behave exactly like the direct one',
  );
});

test('importing the module still does not run the command', () => {
  const real = fs.realpathSync(SCRIPT);
  const cwd = freshDir('import-cwd');
  // `node -e` has no `process.argv[1]`, so this is the "imported, not executed"
  // case regardless of path spelling; it must stay a plain import.
  const run = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `const mod = await import(${JSON.stringify(pathToFileURL(real).href)}); console.log('imported', typeof mod.importEvolutionData);`],
    { cwd, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, `importing must succeed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.equal(run.stderr, '');
  assert.equal(run.stdout.trim(), 'imported function');
  assert.equal(run.stdout.includes(USAGE), false, 'an import must not report the CLI Usage error');
  assert.deepEqual(fs.readdirSync(cwd), [], 'an import writes nothing into its working directory');
});
