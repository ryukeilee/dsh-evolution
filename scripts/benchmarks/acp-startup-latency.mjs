#!/usr/bin/env node
/**
 * ACP session-start latency added by the dsh-evolution bundle.
 *
 * Three arms boot a REAL official DSH ACP process against a fresh copy of an
 * isolated home (copy time excluded):
 *   on   - bundle selected in profiles/acp/package.json
 *   off  - same copy with 'dsh-evolution' removed from dsh.profile.bundles
 *          (the package stays installed, so only the bundle's startup work goes)
 *   on2  - second, independent fresh copy with the bundle selected (A/A noise)
 *
 * The measured window is spawn -> initialize response and spawn -> session/new
 * completion (input acceptable). A loopback Anthropic provider is installed via
 * the official --patch overlay and is proven by an UNTIMED session/prompt after
 * both timers stop; no model/network request is allowed inside the timed window.
 *
 * Usage:
 *   node --max-old-space-size=4096 scripts/benchmarks/acp-startup-latency.mjs \
 *     --runtime <dir with @deepseek-ai/dsh installed> --home <isolated DSH_HOME> \
 *     [--rounds 9] [--records 0] [--out <file.json>] [--smoke]
 *
 * --smoke forces 2 rounds and is explicitly non-authoritative. The pristine
 * home is read-only: every measurement uses a copy under a fresh temp root.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(HERE, 'probes', 'acp-startup-latency-probe.mjs');
const ARMS = ['on', 'off', 'on2'];
const KEY_ENV = 'DSH_EVOLUTION_LATENCY_KEY';
const THRESHOLD_MS = 200;
// Do not path.resolve(HOME): a lexical ".." would name a different directory
// than the filesystem does when HOME passes through a symlink. Resolution is
// performed by resolvePathComponents() below (function declarations hoist).
const RESOLVED_USER_HOME = resolvePathComponents(os.homedir()).final;
const REAL_HOME = resolvePathComponents(`${RESOLVED_USER_HOME}${path.sep}.dsh`).final;
const REPO_ROOT = path.resolve(HERE, '..', '..');
const FIRST_BOOT_REMOVALS = [
  'sessions',
  'storages/session_projcache',
  'storages/evolution-experience',
  'logs',
  'storages/evolution/shared-plugins/consumers',
  'storages/evolution/shared-plugins/.publish.lock.sqlite',
];
// Reasons produced BEFORE evaluateSharedRecord() reads a record's source. A
// seeded record showing one of these did not exercise source validation.
const PRE_SOURCE_REASONS = new Set([
  'index-shape', 'index-not-json', 'disable-state-invalid', 'disable-state-unreadable',
  'publisher-profile', 'already-mounted', 'operator-disabled', 'profile-not-approved',
  'source-unusable', 'source-digest-mismatch', 'manifest-digest-mismatch',
  'evaluation-failed', 'not-evaluated',
]);

function parseArgs(argv) {
  const options = { rounds: 9, records: 0, out: null, smoke: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };
    // Keep the user spelling: path.resolve() folds ".." lexically and would
    // turn a path through a symlink into a different filesystem location.
    // Type checking only here; resolution happens in resolvePathComponents().
    if (arg === '--runtime') options.runtime = value();
    else if (arg === '--home') options.home = value();
    else if (arg === '--rounds') options.rounds = Number(value());
    else if (arg === '--records') options.records = Number(value());
    else if (arg === '--out') options.out = value();
    else if (arg === '--smoke') options.smoke = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}
if (options.help || !options.runtime || !options.home) {
  process.stdout.write('node scripts/benchmarks/acp-startup-latency.mjs --runtime <dir> --home <isolated-home> [--rounds 9] [--records 0] [--out file.json] [--smoke]\n');
  process.exit(options.help ? 0 : 2);
}
if (!Number.isSafeInteger(options.rounds) || options.rounds < 2) throw new Error('--rounds must be an integer >= 2');
if (!Number.isSafeInteger(options.records) || options.records < 0) throw new Error('--records must be a non-negative integer');
if (options.smoke) {
  if (options.rounds !== 2) process.stdout.write(`--smoke overrides --rounds ${options.rounds} with 2; this run is NON-AUTHORITATIVE.\n`);
  options.rounds = 2;
}

const isInside = (child, parent) => child === parent || child.startsWith(parent + path.sep);

/** Filesystem identity from lstat metadata only: never reads file contents. */
function pathIdentity(target) {
  try {
    const stat = fs.lstatSync(target);
    return `${stat.dev}:${stat.ino}`;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function ancestorIdentities(resolvedPath) {
  const identities = new Set();
  let cursor = resolvedPath;
  for (;;) {
    const identity = pathIdentity(cursor);
    if (identity) identities.add(identity);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return identities;
}

/**
 * Containment by filesystem identity, not path spelling: on a
 * case-insensitive filesystem `.dsh` and `.DSH` are the same directory, and a
 * symlink target may be reached by several spellings. The string check is only
 * a fast path for paths whose identities do not exist (yet).
 */
function isInsideByIdentity(child, parent) {
  if (isInside(child, parent)) return true;
  const parentIdentity = pathIdentity(parent);
  if (!parentIdentity) return false;
  return ancestorIdentities(child).has(parentIdentity);
}

/**
 * realpath semantics without requiring the final component to exist: keep a
 * resolved output stack and a pending component queue. A symlink prepends its
 * target components (an absolute target restarts at the root); `..` pops the
 * *resolved* stack, so `link/..` means the parent of the link's real target,
 * not the lexical parent of the link path. 40 hops and repeated link paths are
 * refused as loops.
 */
function resolvePathComponents(target, state = { hops: 0, visited: new Set() }) {
  const absolute = target.startsWith(path.sep) ? target : `${process.cwd()}${path.sep}${target}`;
  const root = path.parse(absolute).root;
  let pending = absolute.slice(root.length).split(path.sep).filter((part) => part !== '' && part !== '.');
  let current = root;
  let ancestors = [root];
  while (pending.length > 0) {
    const segment = pending.shift();
    if (segment === '..') {
      if (current !== root) {
        current = path.dirname(current);
        ancestors = ancestors.slice(0, -1);
      }
      continue;
    }
    const candidate = path.join(current, segment);
    let entry = null;
    try { entry = fs.lstatSync(candidate); } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    if (entry?.isSymbolicLink()) {
      const hops = state.hops + 1;
      if (hops > 40) throw new Error(`too many symlink hops while resolving ${absolute}`);
      if (state.visited.has(candidate)) throw new Error(`symlink loop while resolving ${absolute}: ${candidate}`);
      state.visited.add(candidate);
      const destination = fs.readlinkSync(candidate);
      if (!destination) throw new Error(`empty symlink target at ${candidate}`);
      const destinationParts = destination.split(path.sep).filter((part) => part !== '' && part !== '.');
      if (path.isAbsolute(destination)) {
        current = root;
        ancestors = [root];
      }
      pending = [...destinationParts, ...pending];
      continue;
    }
    current = candidate;
    ancestors.push(current);
  }
  return { final: current, ancestors };
}

// The formal home may itself be a symlink (or a dangling one). Resolve it with
// the same reader used for every other protected/claimed path, not a lexical
// path.resolve, so a consumer that passes the link target cannot slip through.
const RESOLVED_REAL_HOME = resolvePathComponents(REAL_HOME).final;

function assertNotProtected(candidates, roots, label, { bothWays = false } = {}) {
  for (const candidate of candidates) {
    for (const root of roots) {
      assert.ok(!isInsideByIdentity(candidate, root), `${label}: ${candidate} is inside a protected directory ${root} (filesystem identity or path)`);
      // Only the path itself, never its generic ancestors (/private, /var...),
      // is checked in the reverse direction.
      if (bothWays) {
        assert.ok(!isInsideByIdentity(root, candidate), `${label}: protected directory ${root} is inside ${candidate} (filesystem identity or path)`);
      }
    }
  }
}

/**
 * Device/inode identities of the protected roots and their ancestors. Only
 * lstat metadata is read: enumerating user files under the real home would
 * itself cross the "do not read production data" boundary. A hard link to a
 * protected file is already caught by nlink > 1; this second proof rejects an
 * existing --out that *is* a protected root (or one of its ancestors).
 */
function protectedRootIdentities(roots) {
  const identities = new Set();
  for (const root of roots) {
    for (const identity of ancestorIdentities(resolvePathComponents(root).final)) identities.add(identity);
  }
  return identities;
}

/**
 * Preflight a home tree before any file in it is read or copied: reject
 * symlinks that resolve outside the root (dangling links included) and any
 * regular file with nlink > 1, reporting the relative path. lstat/readdir
 * (withFileTypes) never follow a link, and symlinked directories are checked
 * but never recursed into.
 */
function assertNoEscapingLinks(root, label) {
  const realRoot = resolvePathComponents(root).final;
  let checked = 0;
  let files = 0;
  const escaping = [];
  const hardLinked = [];
  const walk = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        checked += 1;
        let resolved;
        try { resolved = fs.realpathSync.native(absolute); }
        catch (error) { throw new Error(`${label}: dangling or unresolvable symlink ${relative}: ${error.message}`); }
        if (!isInsideByIdentity(resolved, realRoot)) escaping.push(`${relative} -> ${resolved}`);
        continue;
      }
      if (entry.isDirectory()) { walk(absolute, relative); continue; }
      if (entry.isFile()) {
        files += 1;
        // A hard-linked file shares an inode with bytes outside this tree;
        // copying or reading it would leak protected content before any later
        // guard could see the path. Refuse it with its relative path.
        if (fs.lstatSync(absolute).nlink !== 1) hardLinked.push(relative);
      }
    }
  };
  walk(root, '');
  assert.equal(hardLinked.length, 0, `${label}: hard-linked files share an inode with other data: ${hardLinked.join(', ')}`);
  assert.equal(escaping.length, 0, `${label}: symlink escapes the home root: ${escaping.join(', ')}`);
  return { label, checked, files, hardLinked: hardLinked.length, escaping: escaping.length };
}

function assertOutPath(target, pristineHome) {
  if (!target) return null;
  const { final, ancestors } = resolvePathComponents(target);
  const protectedRoots = [RESOLVED_REAL_HOME, pristineHome];
  assertNotProtected([final], protectedRoots, '--out', { bothWays: true });
  assertNotProtected(ancestors, protectedRoots, '--out ancestor');
  const details = { resolved: final, existed: false, nlink: null, protectedIdentitiesChecked: 0, devInoMatched: false };
  let stat = null;
  try { stat = fs.lstatSync(final); }
  catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  if (stat) {
    details.existed = true;
    details.nlink = stat.nlink;
    // A hard link to a protected file is an in-place overwrite even though its
    // path is harmless. nlink > 1 is refused outright; dev/ino identity adds a
    // second proof for a protected file that was moved rather than linked.
    assert.ok(stat.isFile(), `refusing --out: ${final} exists but is not a regular file`);
    assert.equal(stat.nlink, 1, `refusing --out: ${final} has ${stat.nlink} hard links`);
    const protectedIds = protectedRootIdentities(protectedRoots);
    details.protectedIdentitiesChecked = protectedIds.size;
    details.devInoMatched = protectedIds.has(`${stat.dev}:${stat.ino}`);
    assert.ok(!details.devInoMatched, `refusing --out: ${final} has the device/inode of a protected root`);
  }
  return { path: final, details };
}

function assertIsolatedHome(target) {
  // Resolve before any write: a symlinked home or a lexically safe path under
  // TMPDIR can still point at the production home.
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('the given home is not a real directory');
  const resolved = resolvePathComponents(target).final;
  assert.ok(!isInsideByIdentity(resolved, RESOLVED_REAL_HOME) && !isInsideByIdentity(RESOLVED_REAL_HOME, resolved), `refusing the real DSH_HOME: ${resolved} relates to ${RESOLVED_REAL_HOME}`);
  const repo = resolvePathComponents(REPO_ROOT).final;
  if (isInsideByIdentity(resolved, repo)) throw new Error('refusing a home inside the repository worktree');
  return resolved;
}

function versionFromManifest(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).version;
}

function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function stats(values) {
  return {
    samples: values.length,
    median: Number(quantile(values, 0.5).toFixed(2)),
    p25: Number(quantile(values, 0.25).toFixed(2)),
    p75: Number(quantile(values, 0.75).toFixed(2)),
  };
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function atomicWrite(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  const handle = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temp, file);
}

async function run() {
  const startedAt = new Date().toISOString();
  const home = assertIsolatedHome(options.home);
  // Both checks run before any scratch write: a pristine home that already
  // contains an escaping link is not a usable input, and an --out inside the
  // real home (or the pristine home) would overwrite protected data.
  const pristineLinkCheck = assertNoEscapingLinks(home, 'pristine home');
  const outCheck = assertOutPath(options.out, home);
  const outResolved = outCheck?.path ?? null;
  // Guard the executable source before reading its package.json or spawning
  // it. Only lstat/readlink are used here; the CLI's bytes are never touched
  // until this passes.
  const runtime = resolvePathComponents(options.runtime).final;
  assertNotProtected([runtime], [RESOLVED_REAL_HOME, home], '--runtime', { bothWays: true });
  const runtimeFiles = [];
  function assertRuntimeFile(candidate, label) {
    const resolved = resolvePathComponents(candidate).final;
    assertNotProtected([resolved], [RESOLVED_REAL_HOME, home], label, { bothWays: true });
    assert.ok(isInsideByIdentity(resolved, runtime), `${label} ${resolved} escaped the resolved runtime ${runtime}`);
    const stat = fs.lstatSync(resolved);
    assert.ok(stat.isFile(), `${label} ${resolved} is not a regular file`);
    assert.equal(stat.nlink, 1, `${label} ${resolved} has ${stat.nlink} hard links`);
    runtimeFiles.push({ label, resolved, nlink: stat.nlink });
    return resolved;
  }
  function runtimePackageManifest(name) {
    const pnpm = path.join(runtime, 'node_modules', '.pnpm');
    const pnpmResolved = resolvePathComponents(pnpm).final;
    assertNotProtected([pnpmResolved], [RESOLVED_REAL_HOME, home], `runtime ${name} store`, { bothWays: true });
    assert.ok(isInsideByIdentity(pnpmResolved, runtime), `runtime store ${pnpmResolved} escaped ${runtime}`);
    let manifest = path.join(runtime, 'node_modules', '@deepseek-ai', name, 'package.json');
    if (fs.existsSync(pnpm)) {
      const match = fs.readdirSync(pnpm).find((entry) => entry.startsWith(`@deepseek-ai+${name}@`));
      if (match) manifest = path.join(pnpm, match, 'node_modules', '@deepseek-ai', name, 'package.json');
    }
    return assertRuntimeFile(manifest, `runtime ${name} manifest`);
  }
  const cli = assertRuntimeFile(path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '--runtime CLI');
  const runtimeCheck = {
    resolvedRuntime: runtime,
    resolvedCli: cli,
    runtimeProtected: false,
    cliProtected: false,
    cliInsideRuntime: true,
    guardedFiles: runtimeFiles,
  };
  const dshManifest = runtimePackageManifest('dsh');
  const hostVersion = versionFromManifest(dshManifest);
  const profileDir = path.join(home, 'profiles', 'acp');
  const bundleRoot = path.join(profileDir, 'node_modules', 'dsh-evolution');
  const bundleLib = path.join(bundleRoot, 'lib');
  const bundleVersion = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'package.json'), 'utf8')).version;
  const pristineManifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  assert.ok(pristineManifest.dsh?.profile?.bundles?.includes('dsh-evolution'), 'the given home does not select dsh-evolution in its acp profile');
  assert.ok(fs.existsSync(PROBE), 'attribution probe is missing');

  const sharing = await import(pathToFileURL(path.join(bundleLib, 'promoted-sharing.js')).href);
  const hostFacts = {
    dsh: hostVersion,
    cordis: versionFromManifest(runtimePackageManifest('cordis')),
    include: versionFromManifest(runtimePackageManifest('cordis-plugin-include')),
    node: process.version,
  };

  // TMPDIR itself may be a symlink into a protected directory. Resolve it (a
  // missing final component is legal) and refuse before creating anything.
  const tmpResolution = resolvePathComponents(os.tmpdir());
  // Only one direction: a legitimate TMPDIR commonly *contains* an isolated
  // home (both live under the same temp root), which is not an escape.
  assertNotProtected([tmpResolution.final, ...tmpResolution.ancestors], [RESOLVED_REAL_HOME, home], 'os.tmpdir()');
  // Create from the validated, resolved path only: path.join() on the raw
  // TMPDIR string would fold a literal ".." into the protected directory.
  const work = fs.mkdtempSync(path.join(tmpResolution.final, 'dsh-evolution-acp-latency-'));
  let realWork;
  try {
    realWork = resolvePathComponents(work).final;
    assert.ok(isInsideByIdentity(realWork, tmpResolution.final), `work directory ${realWork} escaped the resolved TMPDIR ${tmpResolution.final}`);
    assertNotProtected([realWork], [RESOLVED_REAL_HOME, home], 'scratch root', { bothWays: true });
  } catch (error) {
    fs.rmSync(work, { recursive: true, force: true });
    throw error;
  }
  const project = (value) => typeof value === 'string'
    ? value.split(realWork).join('$WORK').split(home).join('$HOME').split(runtime).join('$RUNTIME').split(REPO_ROOT).join('<repo>')
    : value;
  const scratchCheck = {
    tmpdir: project(os.tmpdir()),
    resolvedTmpdir: project(tmpResolution.final),
    resolvedWork: project(realWork),
    protectedRealHome: project(RESOLVED_REAL_HOME),
  };
  const assertScratchPath = (candidate, label) => {
    // Same component-wise resolver as --out: never rely on an existing
    // ancestor to discover a symlink in a path we are about to write.
    const { final } = resolvePathComponents(candidate);
    assert.ok(isInsideByIdentity(final, realWork), `${label} escaped the scratch root: ${final}`);
    return final;
  };
  const linkChecks = { pristine: pristineLinkCheck, copies: [] };

  // A fresh-process import needs a node_modules next to lib/, exactly as in
  // experience-entry-load.mjs. Assemble one from the packages the real host
  // resolved (pnpm store + profile top level) so the attribution measures the
  // same external graph the booted entries use, without touching the home.
  const entryRoot = path.join(realWork, 'entry-lib');
  assertScratchPath(entryRoot, 'entryRoot');
  const entryLib = path.join(entryRoot, 'lib');
  fs.cpSync(bundleLib, entryLib, { recursive: true });
  const entryModules = path.join(entryRoot, 'node_modules');
  fs.mkdirSync(entryModules, { recursive: true, mode: 0o700 });
  const linkPackage = (relative, target) => {
    const destination = path.join(entryModules, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (!fs.existsSync(destination)) fs.symlinkSync(target, destination, 'dir');
  };
  const addPackagesFrom = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const name of fs.readdirSync(directory)) {
      const source = path.join(directory, name);
      if (!fs.statSync(source).isDirectory()) continue;
      if (name.startsWith('@')) {
        for (const member of fs.readdirSync(source)) linkPackage(`${name}/${member}`, path.join(source, member));
      } else {
        linkPackage(name, source);
      }
    }
  };
  addPackagesFrom(path.join(profileDir, 'node_modules'));
  const pnpmStore = path.join(runtime, 'node_modules', '.pnpm');
  if (fs.existsSync(pnpmStore)) {
    for (const storeEntry of fs.readdirSync(pnpmStore)) addPackagesFrom(path.join(pnpmStore, storeEntry, 'node_modules'));
  }
  assert.ok(fs.existsSync(path.join(entryModules, '@deepseek-ai', 'cordis')), 'could not assemble @deepseek-ai/cordis for the module-load probe');

  // Every child (ACP host and attribution probe) gets a dedicated temp dir
  // inside the validated scratch root; no raw parent TMPDIR is ever inherited.
  const childTmp = assertScratchPath(path.join(realWork, 'child-tmp'), 'childTmp');
  fs.mkdirSync(childTmp, { recursive: true, mode: 0o700 });
  const childEnvCheck = {};
  const childEnvSnapshot = (env) => ({
    TMPDIR: project(env.TMPDIR),
    TEMP: project(env.TEMP),
    TMP: project(env.TMP),
    HOME: project(env.HOME),
  });
  function baseChildEnv() {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('DSH_')) continue;
      if (key === 'NODE_OPTIONS') continue;
      if (key === 'TMPDIR' || key === 'TEMP' || key === 'TMP' || key === 'HOME') continue;
      if (/^(DEEPSEEK|ANTHROPIC|OPENAI|OLLAMA|LLM|API|HTTP|HTTPS|ALL|NO)_/i.test(key)) continue;
      env[key] = value;
    }
    env.TMPDIR = childTmp;
    env.TEMP = childTmp;
    env.TMP = childTmp;
    env.HOME = childTmp;
    return env;
  }
  function buildEnv(homeCopy) {
    const env = baseChildEnv();
    env.HOME = homeCopy;
    env.DSH_HOME = homeCopy;
    env.DSH_PROFILE = 'acp';
    env[KEY_ENV] = 'local-fixture-only';
    if (!childEnvCheck.acp) {
      childEnvCheck.acp = childEnvSnapshot(env);
      process.stdout.write(`${JSON.stringify({ childEnvAtAcpSpawn: childEnvCheck.acp })}\n`);
    }
    return env;
  }
  function probeEnv() {
    const env = baseChildEnv();
    if (!childEnvCheck.probe) {
      childEnvCheck.probe = childEnvSnapshot(env);
      process.stdout.write(`${JSON.stringify({ childEnvAtProbeSpawn: childEnvCheck.probe })}\n`);
    }
    return env;
  }

  function assertBundleState(homeCopy, expectSelected) {
    const manifestPath = path.join(homeCopy, 'profiles', 'acp', 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const selected = (manifest.dsh?.profile?.bundles || []).includes('dsh-evolution');
    assert.equal(selected, expectSelected, `bundle selection did not match expectation in ${project(homeCopy)}`);
    assert.ok(fs.existsSync(path.join(homeCopy, 'profiles', 'acp', 'node_modules', 'dsh-evolution', 'package.json')), 'the installed bundle is missing');
    return manifest;
  }

  function disableBundle(homeCopy) {
    const manifestPath = path.join(homeCopy, 'profiles', 'acp', 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name) => name !== 'dsh-evolution');
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  /** Seed valid published records plus their real promoted plugin sources. */
  function seedRecords(root, count) {
    const dataRoot = path.join(root, 'storages', 'evolution');
    const pluginRoot = path.join(dataRoot, 'promoted');
    const plugins = [];
    for (let index = 0; index < count; index += 1) {
      const id = `evolution-promoted-${sha256(`acp-startup-latency:${index}`).slice(0, 12)}`;
      const pluginName = `dsh-${id}`;
      const dir = path.join(pluginRoot, pluginName);
      fs.mkdirSync(path.join(dir, 'lib'), { recursive: true, mode: 0o700 });
      const source = `export const name = ${JSON.stringify(pluginName)};\nexport const inject = [];\nexport async function apply() {}\n`;
      const manifest = { name: pluginName, version: '0.0.0', private: true, type: 'module', main: 'lib/index.js' };
      const sourceBytes = Buffer.from(source);
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
      fs.writeFileSync(path.join(dir, 'lib', 'index.js'), sourceBytes, { mode: 0o600 });
      fs.writeFileSync(path.join(dir, 'package.json'), manifestBytes, { mode: 0o600 });
      const record = {
        id,
        schemaVersion: sharing.SHARED_SCHEMA_VERSION,
        experimentId: `bench-exp-${index}-${id.slice(-6)}`,
        pluginName,
        moduleUrl: pathToFileURL(path.join(dir, 'lib', 'index.js')).href,
        entry: sharing.SHARED_ENTRY,
        sourceSha256: sha256(sourceBytes),
        manifestSha256: sha256(manifestBytes),
        publisherProfile: 'desktop',
        approvedProfiles: ['acp'],
        stable: {
          committedAt: startedAt,
          promotionTimestamp: startedAt,
          decision: 'benefit',
          canary: { healthObservationWindow: 1, observations: 1, startupVerified: true },
        },
        requiredServices: [],
        serviceMembers: {},
        requiredCapabilities: ['fiberLifecycle', 'fiberAwait', 'include'],
        hostOnly: true,
        publicationVerifiedAt: null,
        host: { ...hostFacts, verifiedAt: startedAt },
        revalidation: [],
        publishedAt: startedAt,
      };
      const verdict = sharing.validateSharedRecord(record, { dataRoot, pluginRoot });
      assert.ok(verdict.ok, `seeded record ${id} is invalid: ${verdict.reason}`);
      plugins.push(record);
    }
    atomicWrite(
      path.join(dataRoot, 'shared-plugins', 'published.json'),
      Buffer.from(`${JSON.stringify({
        schemaVersion: sharing.SHARED_SCHEMA_VERSION,
        kind: sharing.SHARED_KIND,
        updatedAt: startedAt,
        publisher: { profile: 'desktop' },
        plugins,
      }, null, 2)}\n`),
    );
    return { count, ids: plugins.map((record) => record.id) };
  }

  /** Prove seeded records were really evaluated against their source files. */
  function assertSourceValidation(homeCopy, seeded) {
    if (seeded.count === 0) return { checked: 0, statuses: [] };
    const stateFile = path.join(homeCopy, 'storages', 'evolution', 'shared-plugins', 'consumers', 'acp.json');
    assert.ok(fs.existsSync(stateFile), 'consumer state was not written');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const rows = new Map((state.plugins || []).filter((row) => row && row.id).map((row) => [row.id, row]));
    const statuses = [];
    for (const id of seeded.ids) {
      const row = rows.get(id);
      assert.ok(row, `seeded record ${id} is absent from consumer state`);
      assert.notEqual(row.reason, 'index-shape', `seeded record ${id} was rejected as index-shape`);
      assert.ok(!String(row.reason || '').startsWith('record-'), `seeded record ${id} failed index validation: ${row.reason}`);
      assert.ok(!PRE_SOURCE_REASONS.has(row.reason), `seeded record ${id} stopped before source validation: ${row.reason}`);
      statuses.push(`${row.status}:${row.reason ?? 'null'}`);
    }
    return { checked: seeded.count, statuses };
  }

  function prepare(label, arm, { firstBoot = false } = {}) {
    const homeCopy = path.join(realWork, 'homes', label);
    assertScratchPath(homeCopy, `homeCopy ${label}`);
    fs.cpSync(home, homeCopy, { recursive: true, verbatimSymlinks: true });
    const copyStat = fs.lstatSync(homeCopy);
    assert.ok(copyStat.isDirectory() && !copyStat.isSymbolicLink(), `homeCopy ${label} is not a real directory copy`);
    assert.ok(isInsideByIdentity(resolvePathComponents(homeCopy).final, realWork), `homeCopy ${label} does not resolve inside the scratch root`);
    linkChecks.copies.push(assertNoEscapingLinks(homeCopy, `home copy ${label}`));
    if (firstBoot) {
      for (const relative of FIRST_BOOT_REMOVALS) {
        fs.rmSync(path.join(homeCopy, ...relative.split('/')), { recursive: true, force: true });
      }
    }
    if (arm === 'off') disableBundle(homeCopy);
    assertBundleState(homeCopy, arm !== 'off');
    const seeded = seedRecords(homeCopy, options.records);
    return { homeCopy, seeded };
  }

  async function boot({ homeCopy, arm, label, seeded }) {
    const requests = [];
    const server = http.createServer(async (req, res) => {
      // Register at handler entry, before the body is drained. A request whose
      // headers arrive inside the timed window but whose body completes later
      // must still be counted as inside that window.
      const at = performance.now();
      const entry = { at, bytes: null, tools: null };
      requests.push(entry);
      let body = '';
      for await (const chunk of req) body += chunk;
      entry.bytes = Buffer.byteLength(body);
      try { entry.tools = (JSON.parse(body).tools || []).length; }
      catch { entry.tools = null; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('message_start', { message: { id: `bench-${label}`, type: 'message', role: 'assistant', model: 'loopback-fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } });
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
      send('message_stop', {});
      res.end();
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const overlay = path.join(realWork, 'overlays', `${label}.yml`);
    assertScratchPath(overlay, `overlay ${label}`);
    fs.mkdirSync(path.dirname(overlay), { recursive: true });
    fs.writeFileSync(overlay, `- id: llm-deepseek\n  config:\n    baseURL: http://127.0.0.1:${server.address().port}\n    apiKeyEnv: ${KEY_ENV}\n`, { mode: 0o600 });

    const started = performance.now();
    const child = spawn(cli, ['--profile', 'acp', '--patch', overlay], {
      cwd: homeCopy,
      env: buildEnv(homeCopy),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-8000); });
    const pending = new Map();
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let row;
      try { row = JSON.parse(line); } catch { return; }
      if (row.id !== undefined && pending.has(row.id)) {
        const resolve = pending.get(row.id);
        pending.delete(row.id);
        resolve(row);
      }
    });
    let sequence = 0;
    const rpc = (method, params, timeoutMs = 60000) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs} ms (stderr: ${stderr.slice(-1000)})`)); }, timeoutMs);
      pending.set(id, (row) => {
        clearTimeout(timer);
        if (row.error) reject(new Error(`${method}: ${JSON.stringify(row.error)}`));
        else resolve(row.result);
      });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });

    try {
      const initialize = await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
      assert.ok(initialize && typeof initialize === 'object', 'initialize returned no result object');
      const initializeMs = performance.now() - started;
      const created = await rpc('session/new', { cwd: homeCopy, mcpServers: [] });
      assert.ok(typeof created?.sessionId === 'string' && created.sessionId.length > 0, 'session/new returned no sessionId');
      const sessionNewMs = performance.now() - started;
      // Timestamp-based, not count-based: check the whole [spawn, session/new]
      // interval, including requests that arrived while session/new was in
      // flight. Both clocks are performance.now() from this process.
      const requestsInsideTimedWindow = requests.filter((request) => request.at - started <= sessionNewMs).length;
      assert.equal(requestsInsideTimedWindow, 0, `a model request landed inside the timed startup window: ${requestsInsideTimedWindow} of ${requests.length}, arrivals ${JSON.stringify(requests.map((request) => Number((request.at - started).toFixed(2))))} vs session/new ${Number(sessionNewMs.toFixed(2))} ms`);
      // Overlay proof is deliberately after both timers: the model call below
      // is the only one in a sample, so the reported delta has no network cost.
      const prompt = await rpc('session/prompt', { sessionId: created.sessionId, prompt: [{ type: 'text', text: 'Confirm loopback provider.' }] }, 30000);
      assert.ok(prompt && typeof prompt === 'object', 'session/prompt returned no result object');
      const requestsAfterTimer = requests.filter((request) => request.at - started > sessionNewMs).length;
      assert.ok(requestsAfterTimer >= 1, 'loopback provider got no request after the timer: the overlay did not take effect');
      const sourceValidation = arm === 'off' ? { checked: 0, statuses: [], note: 'bundle deselected' } : assertSourceValidation(homeCopy, seeded);
      return {
        arm, label,
        initializeMs: Number(initializeMs.toFixed(2)),
        sessionNewMs: Number(sessionNewMs.toFixed(2)),
        requestsInsideTimedWindow,
        requestsAfterTimer,
        overlayRequests: requests.length,
        overlayToolSchemas: requests[0]?.tools ?? null,
        sourceValidation,
        sessionIdPrefix: created.sessionId.slice(0, 8),
      };
    } catch (error) {
      error.message = `${arm}/${label}: ${error.message}`;
      throw error;
    } finally {
      child.stdin.end();
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(() => {
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 1500).unref();
          resolve();
        }, 3000)),
      ]);
      server.close();
    }
  }

  const samples = [];
  const method = {
    arms: 'on (bundle selected), off (bundle deselected in a fresh copy, package still installed), on2 (second fresh copy identical to on)',
    perRound: 'every arm gets a brand-new copy of the pristine home; copying time is excluded; arm order rotates on-off-on2 / off-on2-on / on2-on-off',
    timers: 'process.hrtime-equivalent performance.now() from just before spawn to the initialize response and to the session/new response; both are asserted successful',
    modelIsolation: 'loopback SSE provider via --patch, one end_turn text response with no tool_use. Provider arrival timestamps (recorded before body drain) are compared against the session/new completion instant: requestsInsideTimedWindow must be 0 over the whole [spawn, session/new] interval, and requestsAfterTimer must be >=1 after an UNTIMED prompt.',
    assertions: 'initialize/session/new/prompt success, timestamp-based request-window check, overlay request observed, bundle selected/deselected in each copy, seeded records reach source validation (not index-shape), every symlink in the pristine home and each copy resolves inside its own root, resolved formal home and resolved TMPDIR/scratch/--out outside protected directories, existing --out regular with nlink===1 and no protected dev/ino',
    quantiles: 'linear interpolation over per-round values; paired differences are computed per round before their median/p25/p75',
    exclusion: 'host cold start (~1.3-1.5 s), closed-loop self-evolution CPU, consumer-session GC and all attribution probes are separate and are never added to the ACP delta',
  };

  // Warm up each arm once. Warmups are fresh copies and are never sampled.
  const warmup = [];
  for (const arm of ARMS) {
    const label = `warm-${arm}`;
    const { homeCopy, seeded } = prepare(label, arm);
    warmup.push(await boot({ homeCopy, arm, label, seeded }));
  }

  for (let round = 0; round < options.rounds; round += 1) {
    const shift = round % ARMS.length;
    const order = [...ARMS.slice(shift), ...ARMS.slice(0, shift)];
    const sample = { round, order: order.join('->') };
    for (const arm of order) {
      const label = `r${round}-${arm}`;
      const { homeCopy, seeded } = prepare(label, arm);
      sample[arm] = await boot({ homeCopy, arm, label, seeded });
    }
    samples.push(sample);
    const windowOf = (arm) => ({ inside: sample[arm].requestsInsideTimedWindow, after: sample[arm].requestsAfterTimer });
    process.stdout.write(`${JSON.stringify({ sample: round, onInitializeMs: sample.on.initializeMs, offInitializeMs: sample.off.initializeMs, on2InitializeMs: sample.on2.initializeMs, onSessionNewMs: sample.on.sessionNewMs, offSessionNewMs: sample.off.sessionNewMs, on2SessionNewMs: sample.on2.sessionNewMs, aaNoiseMs: Number((sample.on.sessionNewMs - sample.on2.sessionNewMs).toFixed(2)), requestWindow: { on: windowOf('on'), off: windowOf('off'), on2: windowOf('on2') } })}\n`);
  }

  const paired = {};
  for (const metric of ['initializeMs', 'sessionNewMs']) {
    const pick = (arm) => samples.map((sample) => sample[arm][metric]);
    const diff = (left, right) => samples.map((sample) => sample[left][metric] - sample[right][metric]);
    paired[metric] = {
      on: stats(pick('on')),
      off: stats(pick('off')),
      on2: stats(pick('on2')),
      'on-off': stats(diff('on', 'off')),
      'on2-off': stats(diff('on2', 'off')),
      'on-on2': stats(diff('on', 'on2')),
    };
  }
  const primaryDelta = paired.sessionNewMs['on-off'].median;
  const decision = {
    thresholdMs: THRESHOLD_MS,
    metric: 'spawn -> session/new, steady-state paired on-off median',
    measuredMedianDeltaMs: primaryDelta,
    result: primaryDelta >= THRESHOLD_MS ? 'THRESHOLD_MET' : 'NO CHANGE',
    authoritative: !options.smoke,
  };

  // One-off "installed but never booted" cost, reported separately and never
  // folded into the steady-state decision. The synthetic removal list is
  // explicit so the evidence is reproducible rather than implied.
  const firstBootPairs = options.smoke ? 1 : 2;
  const firstBootSamples = [];
  for (let pair = 0; pair < firstBootPairs; pair += 1) {
    const order = pair % 2 === 0 ? ['on', 'off'] : ['off', 'on'];
    const row = { pair, order: order.join('->') };
    for (const arm of order) {
      const label = `first-${pair}-${arm}`;
      const { homeCopy, seeded } = prepare(label, arm, { firstBoot: true });
      row[arm] = await boot({ homeCopy, arm, label, seeded });
    }
    firstBootSamples.push(row);
  }
  const firstBoot = {
    authoritative: false,
    excludedFromSteadyDecision: true,
    syntheticRemovals: FIRST_BOOT_REMOVALS,
    samples: firstBootSamples,
    on: stats(firstBootSamples.map((row) => row.on.sessionNewMs)),
    off: stats(firstBootSamples.map((row) => row.off.sessionNewMs)),
    'on-off': stats(firstBootSamples.map((row) => row.on.sessionNewMs - row.off.sessionNewMs)),
  };

  // Attribution: separate micro-measurements. They explain where time can go;
  // they are NOT added to the ACP delta (that would double-count the same work).
  function runProbe(args) {
    const output = execFileSync(process.execPath, ['--max-old-space-size=4096', PROBE, ...args], {
      encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, env: probeEnv(),
    });
    return JSON.parse(output.trim().split('\n').at(-1));
  }
  const attributionRounds = options.smoke ? 2 : 5;
  const moduleRows = [];
  for (let round = 0; round < attributionRounds; round += 1) {
    const order = round % 2 === 0 ? ['web', 'acp'] : ['acp', 'web'];
    for (const setName of order) moduleRows.push({ round, set: setName, ...runProbe(['module-load', entryLib, setName]) });
  }
  const experienceRows = [];
  for (let round = 0; round < attributionRounds; round += 1) {
    const root = fs.mkdtempSync(path.join(realWork, 'experience-'));
    experienceRows.push({ round, ...runProbe(['shared-experience', entryLib, root]) });
  }
  const indexRoots = [0, 5, 50].map((count) => {
    const root = path.join(realWork, `index-seed-${count}`);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    return { count, root, seeded: seedRecords(root, count) };
  });
  const indexRows = [];
  for (let round = 0; round < attributionRounds; round += 1) {
    const order = round % 2 === 0 ? indexRoots : [...indexRoots].reverse();
    for (const { count, root, seeded } of order) {
      indexRows.push({ round, ...runProbe(['shared-index', entryLib, path.join(root, 'storages', 'evolution'), String(seeded.count)]), expectedRecords: count });
    }
  }
  const bySet = (setName) => {
    const rows = moduleRows.filter((row) => row.set === setName);
    return {
      medianMs: stats(rows.map((row) => row.ms)).median,
      medianCpuMs: stats(rows.map((row) => row.cpuMs)).median,
      modules: rows[0].modules,
      libBytes: rows[0].libBytes,
      entries: rows[0].entries,
    };
  };
  const attribution = {
    method: 'Separate fresh-process probes: entry module graph (node:module registerHooks, apply() asserted), openSharedExperience cold then hot on a fresh root, published.json readSharedIndex + evaluateSharedRecord on seeded roots with 0/5/50 records. Probes import a byte copy of the installed bundle lib with a temp node_modules assembled from the resolved host packages (host and profile stores); no pristine-home file is written. Measures only what each note says; nothing here is summed into the ACP arm delta.',
    moduleRoot: project(entryLib),
    moduleLoad: {
      web: bySet('web'),
      acp: bySet('acp'),
      reference: 'R13 (docs/performance/session-startup-and-experience-growth-20261117.md) reported acp 11.98 ms / 456,178 bytes / 25 modules; that number was NOT re-measured in this run.',
      samples: moduleRows.map((row) => project(row)),
    },
    sharedExperience: {
      cold: stats(experienceRows.map((row) => row.coldMs)),
      hot: stats(experienceRows.map((row) => row.hotMs)),
      note: experienceRows[0].note,
      samples: experienceRows.map((row) => project(row)),
    },
    sharedIndex: Object.fromEntries(indexRoots.map(({ count }) => {
      const rows = indexRows.filter((row) => row.expectedRecords === count);
      return [String(count), {
        readIndexMs: stats(rows.map((row) => row.readIndexMs)),
        evaluateTotalMs: stats(rows.map((row) => row.evaluateTotalMs)),
        eligible: rows[0].eligible,
        note: rows[0].note,
      }];
    })),
    sharedIndexSamples: indexRows.map((row) => project(row)),
  };

  const payload = {
    schemaVersion: 1,
    kind: 'dsh-evolution-acp-startup-latency',
    smoke: options.smoke,
    authoritative: !options.smoke,
    startedAt,
    finishedAt: new Date().toISOString(),
    host: { version: hostVersion, cli: project(cli) },
    bundle: { version: bundleVersion, lib: project(bundleLib) },
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    rounds: options.rounds,
    warmupPerArm: 1,
    records: options.records,
    symlinkCheck: {
      ...linkChecks,
      totalChecked: pristineLinkCheck.checked + linkChecks.copies.reduce((sum, row) => sum + row.checked, 0),
      totalEscaping: pristineLinkCheck.escaping + linkChecks.copies.reduce((sum, row) => sum + row.escaping, 0),
      homePreflight: {
        files: pristineLinkCheck.files,
        hardLinked: pristineLinkCheck.hardLinked,
        symlinksChecked: pristineLinkCheck.checked,
        escaping: pristineLinkCheck.escaping,
        rule: 'Every regular file in the pristine home must have nlink === 1 before any read/copy; every symlink must resolve inside the home root.',
      },
      rule: 'Every symlink in the pristine home and in each scratch copy is resolved with realpath.native (lstat/readdir withFileTypes, never following) and must stay inside its own root by filesystem identity; dangling links and out-of-root links fail the run. The formal DSH_HOME, TMPDIR, --out and scratch paths use realpath-style resolution: a resolved stack plus a pending component queue, symlink targets prepended, `..` popping the resolved stack, 40-hop and repeated-link loop guards, missing final component allowed. Containment is decided by lstat dev:ino identities of the resolved path and its ancestors (string prefix is only a fast path), on both sides where applicable. An existing --out must be a regular file with nlink === 1 and a dev/ino distinct from both protected roots and their ancestors (metadata only; no production file contents are read). --runtime and every runtime file read or executed (CLI and all manifests) are rejected if related to either protected root, must have nlink === 1 and must resolve inside the runtime; scratch is created from the resolved TMPDIR, never the raw string; every spawned child explicitly receives TMPDIR/TEMP/TMP inside the scratch (ACP child also receives HOME = its own home copy).',
      outPath: outCheck?.details ? { ...outCheck.details, resolved: project(outCheck.details.resolved) } : null,
      scratchCheck,
      childEnvCheck: { scratchTmpdir: project(childTmp), ...childEnvCheck },
      runtimeCheck: {
        ...runtimeCheck,
        resolvedRuntime: project(runtimeCheck.resolvedRuntime),
        resolvedCli: project(runtimeCheck.resolvedCli),
        guardedFiles: runtimeFiles.map((row) => ({ ...row, resolved: project(row.resolved) })),
        rejected: false,
      },
    },
    hostFacts,
    threshold: decision,
    method,
    summary: paired,
    decision,
    firstBoot,
    attribution,
    samples: samples.map((sample) => ({
      round: sample.round,
      order: sample.order,
      on: project(sample.on),
      off: project(sample.off),
      on2: project(sample.on2),
    })),
    warmup: warmup.map((row) => project(row)),
  };
  if (outResolved) {
    fs.mkdirSync(path.dirname(outResolved), { recursive: true });
    fs.writeFileSync(outResolved, `${JSON.stringify(payload, null, 2)}\n`);
  }
  const symlinkLinksChecked = payload.symlinkCheck.totalChecked;
  const symlinkEscapes = payload.symlinkCheck.totalEscaping;
  const allWindows = [...samples.flatMap((sample) => ['on', 'off', 'on2'].map((arm) => sample[arm]))];
  process.stdout.write(`${JSON.stringify({
    smoke: options.smoke,
    authoritative: !options.smoke,
    onMedianMs: paired.sessionNewMs.on.median,
    offMedianMs: paired.sessionNewMs.off.median,
    on2MedianMs: paired.sessionNewMs.on2.median,
    aaNoiseMedianMs: paired.sessionNewMs['on-on2'].median,
    onOffMedianMs: primaryDelta,
    on2OffMedianMs: paired.sessionNewMs['on2-off'].median,
    requestsInsideTimedWindow: Math.max(...allWindows.map((row) => row.requestsInsideTimedWindow)),
    requestsAfterTimer: Math.min(...allWindows.map((row) => row.requestsAfterTimer)),
    symlinkLinksChecked,
    symlinkEscapes,
    homePreflightFiles: payload.symlinkCheck.homePreflight.files,
    homePreflightHardLinked: payload.symlinkCheck.homePreflight.hardLinked,
    result: decision.result,
    host: hostVersion,
    bundle: bundleVersion,
  }, null, 2)}\n`);
  if (options.smoke) process.stdout.write('NON-AUTHORITATIVE SMOKE — 2 rounds only; do not use these numbers as a conclusion.\n');
  fs.rmSync(work, { recursive: true, force: true });
}

try {
  await run();
} catch (error) {
  process.stderr.write(`FAILED: ${error?.stack || error}\n`);
  process.exitCode = 1;
}
